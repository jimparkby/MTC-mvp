-- Агент контроля договорённостей — схема БД (Supabase → SQL Editor → Run).
-- Всё живёт в отдельной схеме mtc, чтобы не смешиваться с Luvo даже в общем проекте.
-- Время хранится в UTC (timestamptz), показывается в Europe/Minsk.

create schema if not exists mtc;
set search_path = mtc;

-- ---------- Таблицы (по ТЗ + несколько служебных полей) ----------

create table if not exists users (
  id bigserial primary key,
  telegram_id bigint unique not null,
  name text,
  username text,                      -- @username, для /supervisor @username
  role text default 'manager',        -- manager | supervisor
  supervisor_telegram_id bigint,      -- кому эскалировать
  pending jsonb,                      -- ожидаемый ввод: {"type":"fix","promise_id":42}
  created_at timestamptz default now()
);

create table if not exists clients (
  id bigserial primary key,
  owner_id bigint references users(id),
  phone text not null,                -- формат +375XXXXXXXXX
  name text,
  summary text,                       -- краткая память о клиенте
  created_at timestamptz default now(),
  unique (owner_id, phone)
);

create table if not exists calls (
  id bigserial primary key,
  client_id bigint references clients(id),
  telegram_file_id text,
  duration_sec int,
  transcript text,
  summary text,
  raw_llm_json jsonb,                 -- ответ модели целиком, для отладки
  status text default 'processing',   -- processing | done | error
  error text,
  created_at timestamptz default now(),
  finished_at timestamptz
);

create table if not exists promises (
  id bigserial primary key,
  call_id bigint references calls(id),
  client_id bigint references clients(id),
  who text not null,                  -- manager | client
  what text not null,
  due_at timestamptz,                 -- null, если срок не назван
  due_text text,                      -- срок как сказано: «до пятницы»
  action_type text,                   -- send_document | call_back | payment | meeting | other
  quote text,                         -- цитата из разговора
  status text default 'open',         -- open | done | postponed | cancelled | overdue
  reminded_at timestamptz,
  escalated_at timestamptz,
  created_at timestamptz default now()
);

create table if not exists action_log (
  id bigserial primary key,
  promise_id bigint references promises(id),
  action text,                        -- reminded | voice_sent | done | postponed | escalated | draft_sent | confirmed | deleted | cancelled | due_fixed
  actor text,                         -- agent | telegram_id пользователя
  created_at timestamptz default now()
);

create index if not exists promises_status_due_idx on promises (status, due_at);
create index if not exists promises_client_idx on promises (client_id);
create index if not exists calls_client_idx on calls (client_id);

-- Настройки бота (не ключи внешних API — они в Credentials n8n).
-- bot_token нужен здесь, потому что sendVoice и скачивание файла идут через HTTP Request,
-- а Telegram-креденшл n8n не умеет подставлять токен в URL. RLS ниже закрывает таблицу от REST API.
create table if not exists settings (
  key text primary key,
  value text not null
);

insert into settings (key, value) values
  ('bot_token',        'ВСТАВЬТЕ_ТОКЕН_ИЗ_BOTFATHER'),
  ('llm_model',        'anthropic/claude-sonnet-5.5'),
  ('llm_temperature',  '0.1'),
  ('stt_model',        'scribe_v2'),
  ('tts_model',        'eleven_multilingual_v2'),
  ('tts_voice_id',     'JBFqnCBsd6RMkjVDRZzb')
on conflict (key) do nothing;

-- n8n ходит в базу как postgres (RLS обходит), а анонимный REST API не видит ничего.
alter table users      enable row level security;
alter table clients    enable row level security;
alter table calls      enable row level security;
alter table promises   enable row level security;
alter table action_log enable row level security;
alter table settings   enable row level security;

-- ---------- Функции, которые вызывает n8n ----------

-- Регистрация/обновление пользователя + настройки бота.
-- p: {tg_id, name, username}
create or replace function mtc.bot_register(p jsonb) returns jsonb
language plpgsql as $$
declare u mtc.users;
begin
  insert into mtc.users (telegram_id, name, username)
  values ((p->>'tg_id')::bigint, nullif(p->>'name', ''), nullif(p->>'username', ''))
  on conflict (telegram_id) do update
    set name = coalesce(excluded.name, mtc.users.name),
        username = coalesce(excluded.username, mtc.users.username)
  returning * into u;

  return jsonb_build_object(
    'user', to_jsonb(u),
    'cfg', (select jsonb_object_agg(key, value) from mtc.settings)
  );
end $$;

-- Начало разбора звонка: upsert клиента, запись calls (processing), контекст для LLM.
-- p: {user_id, phone, client_name, file_id, duration}
create or replace function mtc.start_call(p jsonb) returns jsonb
language plpgsql as $$
declare c mtc.clients; cid bigint;
begin
  insert into mtc.clients (owner_id, phone, name)
  values ((p->>'user_id')::bigint, p->>'phone', nullif(p->>'client_name', ''))
  on conflict (owner_id, phone) do update
    set name = coalesce(excluded.name, mtc.clients.name)
  returning * into c;

  insert into mtc.calls (client_id, telegram_file_id, duration_sec)
  values (c.id, p->>'file_id', nullif(p->>'duration', '')::int)
  returning id into cid;

  return jsonb_build_object(
    'call_id', cid,
    'client_id', c.id,
    'client_name', c.name,
    'phone', c.phone,
    'client_summary', c.summary,
    'call_no', (select count(*) from mtc.calls where client_id = c.id),
    'open_promises', (
      select coalesce(jsonb_agg(jsonb_build_object('who', who, 'what', what, 'due_text', due_text) order by id), '[]')
      from mtc.promises where client_id = c.id and status in ('open', 'postponed', 'overdue')
    )
  );
end $$;

-- Завершение разбора: обещания, звонок, память о клиенте.
-- p: {call_id, transcript, raw, summary, client_summary_update, promises:[{who,what,due_at,due_text,action_type,quote}]}
create or replace function mtc.finish_call(p jsonb) returns jsonb
language plpgsql as $$
declare cl bigint; res jsonb;
begin
  update mtc.calls
     set transcript = p->>'transcript',
         summary = p->>'summary',
         raw_llm_json = p->'raw',
         status = 'done',
         finished_at = now()
   where id = (p->>'call_id')::bigint
  returning client_id into cl;

  if coalesce(trim(p->>'client_summary_update'), '') <> '' then
    update mtc.clients
       set summary = right(concat_ws(E'\n', summary, trim(p->>'client_summary_update')), 3000)
     where id = cl;
  end if;

  with ins as (
    insert into mtc.promises (call_id, client_id, who, what, due_at, due_text, action_type, quote)
    select (p->>'call_id')::bigint, cl, x.who, x.what, x.due_at, x.due_text, x.action_type, x.quote
      from jsonb_to_recordset(coalesce(p->'promises', '[]')) as
           x(who text, what text, due_at timestamptz, due_text text, action_type text, quote text)
    returning id, who, what, due_at, due_text, action_type, quote
  )
  select coalesce(jsonb_agg(to_jsonb(ins) order by id), '[]') into res from ins;

  return jsonb_build_object('promises', res, 'summary', p->>'summary');
end $$;

-- p: {call_id, error, raw}
create or replace function mtc.call_error(p jsonb) returns jsonb
language plpgsql as $$
begin
  update mtc.calls set status = 'error', error = p->>'error', raw_llm_json = p->'raw', finished_at = now()
   where id = (p->>'call_id')::bigint;
  return jsonb_build_object('ok', true);
end $$;

-- Обещание с клиентом и менеджером, если пользователь имеет к нему доступ
-- (владелец клиента или его руководитель).
create or replace function mtc.promise_view(pid bigint, tg bigint) returns jsonb
language sql stable as $$
  select jsonb_build_object(
           'id', pr.id, 'who', pr.who, 'what', pr.what, 'due_at', pr.due_at, 'due_text', pr.due_text,
           'action_type', pr.action_type, 'quote', pr.quote, 'status', pr.status,
           'client_name', c.name, 'phone', c.phone, 'client_summary', c.summary,
           'manager_name', u.name, 'manager_tg', u.telegram_id,
           'transcript', ca.transcript, 'call_summary', ca.summary)
    from mtc.promises pr
    join mtc.clients c on c.id = pr.client_id
    join mtc.users u on u.id = c.owner_id
    left join mtc.calls ca on ca.id = pr.call_id
   where pr.id = pid and (u.telegram_id = tg or u.supervisor_telegram_id = tg)
$$;

-- Кнопки. p: {tg_id, action, promise_id}
-- action: ok | del | fix | done | postpone | cancel | draft
create or replace function mtc.promise_action(p jsonb) returns jsonb
language plpgsql as $$
declare
  tg bigint := (p->>'tg_id')::bigint;
  pid bigint := (p->>'promise_id')::bigint;
  act text := p->>'action';
  v jsonb;
  log_action text;
begin
  v := mtc.promise_view(pid, tg);
  if v is null then
    return jsonb_build_object('ok', false, 'error', 'not_found');
  end if;

  case act
    when 'ok' then log_action := 'confirmed';
    when 'del' then
      update mtc.promises set status = 'cancelled' where id = pid;
      log_action := 'deleted';
    when 'cancel' then
      update mtc.promises set status = 'cancelled' where id = pid;
      log_action := 'cancelled';
    when 'done' then
      update mtc.promises set status = 'done' where id = pid;
      log_action := 'done';
    when 'postpone' then
      update mtc.promises
         set due_at = coalesce(due_at, now()) + interval '1 day',
             status = 'postponed', reminded_at = null, escalated_at = null
       where id = pid;
      log_action := 'postponed';
    when 'fix' then
      update mtc.users set pending = jsonb_build_object('type', 'fix', 'promise_id', pid) where telegram_id = tg;
    when 'draft' then log_action := 'draft_sent';
    else
      return jsonb_build_object('ok', false, 'error', 'unknown_action');
  end case;

  if log_action is not null then
    insert into mtc.action_log (promise_id, action, actor) values (pid, log_action, tg::text);
  end if;

  return jsonb_build_object('ok', true, 'action', act, 'promise', mtc.promise_view(pid, tg));
end $$;

-- Новый срок после «Исправить срок». p: {tg_id, promise_id, due_at}
create or replace function mtc.set_due(p jsonb) returns jsonb
language plpgsql as $$
declare tg bigint := (p->>'tg_id')::bigint; pid bigint := (p->>'promise_id')::bigint;
begin
  update mtc.users set pending = null where telegram_id = tg;
  if mtc.promise_view(pid, tg) is null then
    return jsonb_build_object('ok', false, 'error', 'not_found');
  end if;
  update mtc.promises
     set due_at = (p->>'due_at')::timestamptz, status = 'open', reminded_at = null, escalated_at = null
   where id = pid;
  insert into mtc.action_log (promise_id, action, actor) values (pid, 'due_fixed', tg::text);
  return jsonb_build_object('ok', true, 'promise', mtc.promise_view(pid, tg));
end $$;

-- Текстовые команды. p: {tg_id, cmd, arg}
-- cmd: start | client | open | supervisor | cancel
create or replace function mtc.bot_command(p jsonb) returns jsonb
language plpgsql as $$
declare
  tg bigint := (p->>'tg_id')::bigint;
  cmd text := p->>'cmd';
  arg text := coalesce(trim(p->>'arg'), '');
  u mtc.users;
  c mtc.clients;
  s mtc.users;
begin
  select * into u from mtc.users where telegram_id = tg;

  if cmd = 'client' then
    select * into c from mtc.clients where owner_id = u.id and phone = arg;
    if c.id is null then
      return jsonb_build_object('cmd', cmd, 'found', false, 'phone', arg);
    end if;
    return jsonb_build_object(
      'cmd', cmd, 'found', true,
      'client', jsonb_build_object('name', c.name, 'phone', c.phone, 'summary', c.summary),
      'calls', (select coalesce(jsonb_agg(jsonb_build_object('created_at', created_at, 'summary', summary, 'status', status) order by created_at), '[]')
                  from mtc.calls where client_id = c.id),
      'promises', (select coalesce(jsonb_agg(jsonb_build_object('id', id, 'who', who, 'what', what, 'due_at', due_at, 'due_text', due_text, 'status', status) order by due_at nulls last, id), '[]')
                     from mtc.promises where client_id = c.id and status <> 'cancelled'));
  elsif cmd = 'open' then
    return jsonb_build_object('cmd', cmd, 'promises', (
      select coalesce(jsonb_agg(jsonb_build_object('id', pr.id, 'who', pr.who, 'what', pr.what, 'due_at', pr.due_at,
                                                   'due_text', pr.due_text, 'status', pr.status,
                                                   'client_name', c2.name, 'phone', c2.phone)
                                order by pr.due_at nulls last, pr.id), '[]')
        from mtc.promises pr join mtc.clients c2 on c2.id = pr.client_id
       where c2.owner_id = u.id and pr.status in ('open', 'postponed', 'overdue')));
  elsif cmd = 'supervisor' then
    if arg = '' then
      return jsonb_build_object('cmd', cmd, 'ok', false, 'error', 'empty');
    end if;
    if arg ~ '^\d+$' then
      select * into s from mtc.users where telegram_id = arg::bigint;
      if s.id is null then
        -- руководитель ещё не писал боту, но ID известен — сохраняем
        update mtc.users set supervisor_telegram_id = arg::bigint where id = u.id;
        return jsonb_build_object('cmd', cmd, 'ok', true, 'supervisor_tg', arg::bigint, 'supervisor_name', null, 'manager_name', u.name);
      end if;
    else
      select * into s from mtc.users where lower(username) = lower(ltrim(arg, '@')) limit 1;
      if s.id is null then
        return jsonb_build_object('cmd', cmd, 'ok', false, 'error', 'unknown_username', 'arg', arg);
      end if;
    end if;
    update mtc.users set supervisor_telegram_id = s.telegram_id where id = u.id;
    update mtc.users set role = 'supervisor' where id = s.id;
    return jsonb_build_object('cmd', cmd, 'ok', true, 'supervisor_tg', s.telegram_id, 'supervisor_name', s.name, 'manager_name', u.name);
  elsif cmd = 'cancel' then
    update mtc.users set pending = null where id = u.id;
    return jsonb_build_object('cmd', cmd);
  else
    return jsonb_build_object('cmd', 'start', 'has_supervisor', u.supervisor_telegram_id is not null);
  end if;
end $$;

-- Планировщик: напоминания (срок через ≤ 1 час) и эскалации (просрочено ≥ 1 час).
-- Помечает строки сразу, чтобы параллельный запуск не прислал дубль.
create or replace function mtc.scheduler_tick() returns jsonb
language plpgsql as $$
declare rem jsonb; esc jsonb;
begin
  with sel as (
    select id from mtc.promises
     where status in ('open', 'postponed') and due_at is not null
       and due_at <= now() + interval '1 hour' and reminded_at is null
     for update skip locked
  ), upd as (
    update mtc.promises pr set reminded_at = now() from sel where pr.id = sel.id
    returning pr.*
  ), lg as (
    insert into mtc.action_log (promise_id, action, actor)
    select id, 'reminded', 'agent' from upd
    union all
    select id, 'voice_sent', 'agent' from upd where who = 'manager'
  )
  select coalesce(jsonb_agg(jsonb_build_object(
           'id', upd.id, 'who', upd.who, 'what', upd.what, 'due_at', upd.due_at, 'due_text', upd.due_text,
           'action_type', upd.action_type, 'client_name', c.name, 'phone', c.phone,
           'manager_tg', u.telegram_id, 'manager_name', u.name)), '[]')
    into rem
    from upd join mtc.clients c on c.id = upd.client_id join mtc.users u on u.id = c.owner_id;

  with sel as (
    select id from mtc.promises
     where status in ('open', 'postponed') and due_at is not null
       and due_at <= now() - interval '1 hour' and escalated_at is null
     for update skip locked
  ), upd as (
    update mtc.promises pr set status = 'overdue', escalated_at = now() from sel where pr.id = sel.id
    returning pr.*
  ), lg as (
    insert into mtc.action_log (promise_id, action, actor) select id, 'escalated', 'agent' from upd
  )
  select coalesce(jsonb_agg(jsonb_build_object(
           'id', upd.id, 'who', upd.who, 'what', upd.what, 'due_at', upd.due_at,
           'client_name', c.name, 'phone', c.phone,
           'manager_tg', u.telegram_id, 'manager_name', u.name,
           'supervisor_tg', u.supervisor_telegram_id)), '[]')
    into esc
    from upd join mtc.clients c on c.id = upd.client_id join mtc.users u on u.id = c.owner_id;

  return jsonb_build_object(
    'reminders', rem,
    'escalations', esc,
    'cfg', (select jsonb_object_agg(key, value) from mtc.settings)
  );
end $$;
