// Генерирует импортируемые воркфлоу n8n: node n8n/build.mjs
// Код Code-нод пишется здесь как обычные функции — так его проще читать и править.
import { writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';

const OUT = new URL('.', import.meta.url);

// ---------- общие хелперы, вставляются в каждую Code-ноду ----------
const HELPERS = String.raw`
const WD = ['вс', 'пн', 'вт', 'ср', 'чт', 'пт', 'сб'];
const WD_FULL = ['воскресенье', 'понедельник', 'вторник', 'среда', 'четверг', 'пятница', 'суббота'];
const MON = ['янв', 'фев', 'мар', 'апр', 'мая', 'июн', 'июл', 'авг', 'сен', 'окт', 'ноя', 'дек'];
const pad = n => String(n).padStart(2, '0');
// Europe/Minsk = UTC+3 круглый год (без перехода на летнее время)
const mk = d => new Date(new Date(d).getTime() + 3 * 3600e3);
const dayKey = d => { const m = mk(d); return m.getUTCFullYear() * 400 + m.getUTCMonth() * 32 + m.getUTCDate(); };
const hhmm = d => { const m = mk(d); return pad(m.getUTCHours()) + ':' + pad(m.getUTCMinutes()); };
function fmtDue(iso) {
  if (!iso) return null;
  const m = mk(iso);
  return WD[m.getUTCDay()] + ' ' + m.getUTCDate() + ' ' + MON[m.getUTCMonth()] + ', ' + hhmm(iso);
}
function relDue(iso) {
  if (!iso) return null;
  const diff = Math.round((dayKey(iso) - dayKey(Date.now())));
  if (diff === 0) return 'сегодня ' + hhmm(iso);
  if (diff === 1) return 'завтра ' + hhmm(iso);
  return fmtDue(iso);
}
function nowMinsk() {
  const m = mk(Date.now());
  return m.getUTCFullYear() + '-' + pad(m.getUTCMonth() + 1) + '-' + pad(m.getUTCDate()) + ' ' + hhmm(Date.now()) + ', ' + WD_FULL[m.getUTCDay()];
}
function fmtPhone(p) {
  const m = /^\+375(\d{2})(\d{3})(\d{2})(\d{2})$/.exec(p || '');
  return m ? '+375 ' + m[1] + ' ' + m[2] + '-' + m[3] + '-' + m[4] : (p || '');
}
function normPhone(s) {
  const t = String(s || '').replace(/[\s\-()]/g, '');
  let m = t.match(/\+?375\d{9}/);
  if (m) return '+' + m[0].replace(/^\+/, '');
  m = t.match(/(?:^|\D)80(\d{9})(?!\d)/);
  return m ? '+375' + m[1] : null;
}
const esc = s => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const lc = s => (s ? s[0].toLowerCase() + s.slice(1) : s);
const cut = (s, n) => (s && s.length > n ? s.slice(0, n - 1) + '…' : s);
const STATUS = { open: '⏳', postponed: '⏩', overdue: '⚠️', done: '✅', cancelled: '✖️' };
const tg = (method, payload) => ({ json: { method, payload } });
`;

const code = fn => {
  const src = fn.toString();
  return HELPERS + '\n' + src.slice(src.indexOf('{') + 1, src.lastIndexOf('}')).replace(/^\n/, '');
};

// SQL-вызов функции с JSON-аргументом в dollar-quoting (без проблем с кавычками и запятыми)
const sqlCall = (fn, jsExpr) => `=select mtc.${fn}($mtc${'$'}{{ JSON.stringify(${jsExpr}) }}$mtc$::jsonb) as r`;

// ---------- промпты ----------
const EXTRACT_PROMPT = `Ты анализируешь расшифровку телефонного разговора менеджера с клиентом.
Задача: найти все договорённости — конкретные обещания что-то сделать.
Правила:
- Обещание = кто-то из участников берёт на себя конкретное действие
  (отправить, перезвонить, оплатить, приехать, подготовить).
- Не считай обещанием общие фразы («будем на связи», «посмотрим»).
- who: "manager" или "client" — кто обещал.
- due_at: ISO 8601 с часовым поясом Europe/Minsk. Относительные сроки
  («завтра», «до пятницы», «через час») считай от текущей даты {{now}}.
  «До пятницы» без времени = пятница 18:00. «Завтра» без времени = 12:00.
  Если срок не назван — null.
- due_text: срок ровно как прозвучал.
- action_type: send_document | call_back | payment | meeting | other.
- quote: короткая дословная цитата из разговора, откуда взято обещание.
- summary: 2–3 предложения о сути разговора.
- client_summary_update: что нового важно запомнить о клиенте.
- Если договорённостей нет, верни пустой массив promises.
- Отвечай ТОЛЬКО JSON без пояснений и без \`\`\`.
Формат: {"summary": "...", "client_summary_update": "...", "promises": [{"who": "manager", "what": "...", "due_at": "2026-10-09T18:00:00+03:00", "due_text": "до пятницы", "action_type": "send_document", "quote": "..."}]}
Менеджер: {{manager_name}}. Клиент: {{client_name}}.
Текущая дата и время: {{now}} (Europe/Minsk).`;

// ---------- Code-ноды основного бота ----------

function route() {
  const u = $input.first().json;
  const o = { kind: 'other' };
  let from;
  if (u.callback_query) {
    const q = u.callback_query;
    from = q.from;
    Object.assign(o, {
      kind: 'callback', data: q.data || '', cq_id: q.id,
      chat_id: q.message?.chat?.id ?? q.from.id, message_id: q.message?.message_id,
      msg_text: q.message?.text || '', reply_markup: q.message?.reply_markup || null,
    });
  } else if (u.message) {
    const m = u.message;
    from = m.from;
    o.chat_id = m.chat.id;
    const doc = m.document;
    const docIsAudio = doc && (/^(audio|video)\//.test(doc.mime_type || '') ||
      /\.(m4a|mp3|ogg|oga|opus|wav|amr|aac|3gp|flac|webm|mp4|caf)$/i.test(doc.file_name || ''));
    const a = m.audio || m.voice || (docIsAudio ? doc : null);
    if (m.chat.type !== 'private') o.kind = 'other';
    else if (a) Object.assign(o, { kind: 'audio', file_id: a.file_id, file_size: a.file_size || 0, duration: a.duration || null, caption: m.caption || '' });
    else if (m.text) Object.assign(o, { kind: m.text.startsWith('/') ? 'command' : 'text', text: m.text });
  }
  if (!from) return [];
  Object.assign(o, {
    tg_id: from.id,
    name: [from.first_name, from.last_name].filter(Boolean).join(' '),
    username: from.username || '',
  });
  return [{ json: o }];
}

function ctx() {
  const r = $input.first().json.r;
  return [{ json: { ...$('Route').first().json, user: r.user, cfg: r.cfg } }];
}

function checkCaption() {
  const c = $('Ctx').first().json;
  const phone = normPhone(c.caption);
  if (c.file_size > 20 * 1024 * 1024) {
    return [{ json: { ok: false, ...tg('sendMessage', { chat_id: c.chat_id, text: 'Файл больше 20 МБ — Telegram не даёт боту его скачать. Обрежьте или сожмите запись и пришлите снова.' }).json } }];
  }
  if (!phone) {
    return [{ json: { ok: false, ...tg('sendMessage', { chat_id: c.chat_id, text: 'Не вижу номер клиента. Перешлите аудио ещё раз с подписью:\n+375291234567 Сергей' }).json } }];
  }
  const name = c.caption.replace(/[+\d][\d\s\-()]{8,}\d/, '').replace(/[,;·—–-]+/g, ' ').replace(/\s+/g, ' ').trim();
  return [{ json: { ok: true, phone, client_name: name } }];
}

function buildLlmRequest() {
  const c = $('Ctx').first().json;
  const call = $('Start call').first().json.r;
  const stt = $input.first().json;
  const lines = [];
  let cur = null, buf = '';
  for (const w of stt.words || []) {
    if (w.type === 'audio_event') continue;
    const sp = w.speaker_id ?? 'speaker_0';
    if (w.type === 'word' && sp !== cur) {
      if (buf.trim()) lines.push('Спикер ' + (Number(String(cur).replace(/\D/g, '')) + 1) + ': ' + buf.trim());
      cur = sp; buf = '';
    }
    buf += w.text;
  }
  if (buf.trim()) lines.push('Спикер ' + (Number(String(cur).replace(/\D/g, '')) + 1) + ': ' + buf.trim());
  const transcript = lines.length ? lines.join('\n') : (stt.text || '').trim();
  if (!transcript) {
    return [{ json: { ok: false, error: 'STT: ' + JSON.stringify(stt.error || stt).slice(0, 500) } }];
  }
  const now = nowMinsk();
  const system = PROMPT
    .replaceAll('{{now}}', now)
    .replaceAll('{{manager_name}}', c.user.name || 'менеджер')
    .replaceAll('{{client_name}}', call.client_name || 'клиент');
  const open = (call.open_promises || []).map(p => '- ' + (p.who === 'manager' ? 'менеджер' : 'клиент') + ': ' + p.what + (p.due_text ? ' (' + p.due_text + ')' : '')).join('\n');
  const user =
    'Что уже известно о клиенте: ' + (call.client_summary || 'ничего, первый звонок') + '\n' +
    (open ? 'Открытые обещания из прошлых звонков (не дублируй, если в разговоре они не изменились):\n' + open + '\n' : '') +
    '\nСпикеры в расшифровке пронумерованы автоматически — кто из них менеджер, определи по смыслу.\n\nРасшифровка:\n' + transcript;
  const body = {
    model: c.cfg.llm_model,
    temperature: Number(c.cfg.llm_temperature || 0.1),
    response_format: { type: 'json_object' },
    messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
  };
  const retryBody = { ...body, messages: [...body.messages, { role: 'user', content: 'Верни строго один JSON-объект по формату, без текста вокруг.' }] };
  return [{ json: { ok: true, transcript, body, retryBody } }];
}

function parseLlm() {
  const resp = $input.first().json;
  const call = $('Start call').first().json.r;
  const req = $('Build LLM request').first().json;
  const fail = (error, raw) => [{ json: { ok: false, error, raw: raw == null ? null : { content: String(raw).slice(0, 20000) } } }];
  if (resp.error) return fail('LLM HTTP: ' + JSON.stringify(resp.error).slice(0, 500));
  const content = resp.choices?.[0]?.message?.content;
  if (!content) return fail('LLM: пустой ответ', JSON.stringify(resp));
  const s = String(content).trim().replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();
  const a = s.indexOf('{'), b = s.lastIndexOf('}');
  let j;
  try { j = JSON.parse(s.slice(a, b + 1)); } catch (e) { return fail('JSON не парсится: ' + e.message, content); }
  if (typeof j.summary !== 'string' || !Array.isArray(j.promises)) return fail('Нет summary или promises', content);
  const TYPES = ['send_document', 'call_back', 'payment', 'meeting', 'other'];
  const promises = [];
  for (const p of j.promises) {
    if (!p || typeof p.what !== 'string' || !p.what.trim()) continue;
    let due = null;
    if (p.due_at) {
      let str = String(p.due_at).trim();
      if (!/([zZ]|[+-]\d\d:?\d\d)$/.test(str)) str += '+03:00';
      const d = new Date(str);
      if (!isNaN(d)) due = d.toISOString();
    }
    promises.push({
      who: p.who === 'client' ? 'client' : 'manager',
      what: p.what.trim(),
      due_at: due,
      due_text: p.due_text || null,
      action_type: TYPES.includes(p.action_type) ? p.action_type : 'other',
      quote: p.quote || null,
    });
  }
  return [{ json: { ok: true, save: {
    call_id: call.call_id, transcript: req.transcript, raw: j, summary: j.summary.trim(),
    client_summary_update: j.client_summary_update || '', promises,
  } } }];
}

function buildCard() {
  const c = $('Ctx').first().json;
  const call = $('Start call').first().json.r;
  const saved = $input.first().json.r.promises || [];
  const head = '📞 <b>' + esc(call.client_name || 'Клиент') + '</b> · ' + esc(fmtPhone(call.phone)) +
    (call.call_no > 1 ? ' · звонок №' + call.call_no : '');
  const sum = $input.first().json.r.summary;
  let text = head + '\n' + esc(sum) + '\n\n';
  const kb = [];
  if (!saved.length) text += 'Договорённостей не найдено.';
  else {
    text += '<b>Договорённости:</b>\n';
    saved.forEach((p, i) => {
      const n = i + 1;
      const when = p.due_at ? 'до ' + fmtDue(p.due_at) : (p.due_text ? p.due_text + ' (срок не распознан)' : 'срок не назван');
      text += n + '. ' + (p.who === 'manager' ? 'Вы' : 'Клиент') + ' → ' + esc(lc(p.what)) + ' · ' + esc(when) + '\n';
      if (p.quote) text += '   <i>«' + esc(cut(p.quote, 150)) + '»</i>\n';
      kb.push([
        { text: n + ' · Верно', callback_data: 'ok:' + p.id },
        { text: n + ' · Исправить срок', callback_data: 'fix:' + p.id },
        { text: n + ' · Удалить', callback_data: 'del:' + p.id },
      ]);
      if (p.who === 'manager' && p.action_type === 'send_document') {
        kb.push([{ text: n + ' · ✉️ Черновик письма', callback_data: 'draft:' + p.id }]);
      }
    });
  }
  return [tg('sendMessage', { chat_id: c.chat_id, text: cut(text, 4000), parse_mode: 'HTML', reply_markup: { inline_keyboard: kb } })];
}

function errorReply() {
  const c = $('Ctx').first().json;
  return [tg('sendMessage', { chat_id: c.chat_id, text: '❌ Не получилось разобрать звонок. Попробуйте прислать запись ещё раз.' })];
}

function callbackParse() {
  const c = $('Ctx').first().json;
  const [action, id] = String(c.data).split(':');
  return [{ json: { action: action || 'noop', promise_id: Number(id) || 0 } }];
}

function callbackReply() {
  const c = $('Ctx').first().json;
  const cp = $('Callback parse').first().json;
  const r = $input.first().json.r || {};
  const out = [];
  const answer = text => out.push(tg('answerCallbackQuery', { callback_query_id: c.cq_id, text }));
  if (cp.action === 'noop') { answer(''); return out; }
  if (!r.ok) { answer('Обещание не найдено'); return out; }
  const p = r.promise;
  const id = String(p.id);
  const rows = (c.reply_markup?.inline_keyboard || []);
  const isMine = (b, acts) => acts.some(a => b.callback_data === a + ':' + id);
  const replaceRow = (label, dropDraft) => {
    const kb = [];
    for (const row of rows) {
      if (row.some(b => isMine(b, ['ok', 'fix', 'del']))) {
        const n = String(row[0].text).split(' · ')[0];
        kb.push([{ text: n + ' · ' + label, callback_data: 'noop' }]);
      } else if (dropDraft && row.some(b => isMine(b, ['draft']))) {
        continue;
      } else kb.push(row);
    }
    out.push(tg('editMessageReplyMarkup', { chat_id: c.chat_id, message_id: c.message_id, reply_markup: { inline_keyboard: kb } }));
  };
  const finish = line => out.push(tg('editMessageText', { chat_id: c.chat_id, message_id: c.message_id, text: cut(c.msg_text, 3900) + '\n\n' + line }));
  switch (cp.action) {
    case 'ok': answer('Отмечено как верное'); replaceRow('✅ верно', false); break;
    case 'del': answer('Удалено'); replaceRow('🗑 удалено', true); break;
    case 'fix':
      answer('Напишите новый срок');
      out.push(tg('sendMessage', { chat_id: c.chat_id, text: '🕑 Новый срок для «' + p.what + '»?\nНапишите, например: «завтра в 15:00», «пт 12:00», «через 2 часа».\n/cancel — отмена.' }));
      break;
    case 'done': answer('Выполнено'); finish('✅ Выполнено'); break;
    case 'postpone': answer('Перенесено на завтра'); finish('⏩ Перенесено на ' + fmtDue(p.due_at)); break;
    case 'cancel': answer('Отменено'); finish('✖️ Отменено'); break;
    case 'draft': answer('Готовлю черновик письма…'); break;
  }
  return out;
}

function buildDraftRequest() {
  const c = $('Ctx').first().json;
  const p = $input.first().json.r.promise;
  const system = 'Ты помогаешь менеджеру по продажам. Напиши короткий вежливый черновик письма клиенту на русском языке, ' +
    'который выполняет обещание менеджера. Не выдумывай цены, сроки и факты, которых нет в разговоре — вместо них ставь [заполнить]. ' +
    'Первая строка — «Тема: …», дальше текст письма с подписью «' + (c.user.name || 'Менеджер') + '». Только текст письма, без пояснений.';
  const user = 'Клиент: ' + (p.client_name || 'клиент') + ' (' + p.phone + ')\nОбещание: ' + p.what +
    (p.due_text ? ' (' + p.due_text + ')' : '') + '\nЧто известно о клиенте: ' + (p.client_summary || '—') +
    '\n\nРасшифровка разговора:\n' + cut(p.transcript || p.call_summary || '', 12000);
  return [{ json: { body: {
    model: c.cfg.llm_model, temperature: 0.4,
    messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
  } } }];
}

function draftMessage() {
  const c = $('Ctx').first().json;
  const p = $('Promise action').first().json.r.promise;
  const text = $input.first().json.choices?.[0]?.message?.content?.trim();
  if (!text) return [tg('sendMessage', { chat_id: c.chat_id, text: 'Не получилось подготовить черновик, попробуйте ещё раз.' })];
  return [tg('sendMessage', {
    chat_id: c.chat_id, parse_mode: 'HTML',
    text: '✉️ <b>Черновик письма</b> — ' + esc(p.client_name || 'клиенту') + '\n\n<pre>' + esc(cut(text, 3500)) + '</pre>\n\nПисьмо не отправлено: скопируйте и отправьте сами.',
  })];
}

function commandParse() {
  const c = $('Ctx').first().json;
  const m = /^\/(\w+)(?:@\w+)?\s*([\s\S]*)$/.exec(c.text.trim()) || [];
  let cmd = (m[1] || '').toLowerCase();
  let arg = (m[2] || '').trim();
  if (!['start', 'help', 'client', 'open', 'supervisor', 'cancel'].includes(cmd)) cmd = 'start';
  if (cmd === 'help') cmd = 'start';
  if (cmd === 'client') arg = normPhone(arg) || '';
  return [{ json: { tg_id: c.tg_id, cmd, arg } }];
}

function commandReply() {
  const c = $('Ctx').first().json;
  const cp = $('Command parse').first().json;
  const r = $input.first().json.r;
  const send = (text, extra = {}) => tg('sendMessage', { chat_id: c.chat_id, text: cut(text, 4000), ...extra });
  const promiseLine = (p, i, withClient) =>
    (i + 1) + '. ' + (STATUS[p.status] || '') + ' ' + (p.who === 'manager' ? 'Вы' : 'Клиент') + ' → ' + lc(p.what) +
    (p.due_at ? ' · до ' + fmtDue(p.due_at) : (p.due_text ? ' · ' + p.due_text : '')) +
    (withClient ? ' · ' + (p.client_name || '') + ' ' + fmtPhone(p.phone) : '');

  if (cp.cmd === 'client') {
    if (!cp.arg) return [send('Формат: /client +375291234567')];
    if (!r.found) return [send('Клиента ' + fmtPhone(cp.arg) + ' пока нет. Пришлите запись звонка с этим номером в подписи.')];
    let t = '📇 ' + (r.client.name || 'Клиент') + ' · ' + fmtPhone(r.client.phone) + '\n';
    if (r.client.summary) t += '\n🧠 ' + r.client.summary + '\n';
    t += '\nЗвонки (' + r.calls.length + '):\n' + r.calls.map(x => '• ' + fmtDue(x.created_at) + ' — ' + (x.summary || (x.status === 'error' ? 'ошибка разбора' : 'в обработке'))).join('\n');
    t += '\n\nОбещания:\n' + (r.promises.length ? r.promises.map((p, i) => promiseLine(p, i, false)).join('\n') : 'нет');
    return [send(t)];
  }
  if (cp.cmd === 'open') {
    if (!r.promises.length) return [send('Открытых обещаний нет 🎉')];
    return [send('Открытые обещания (' + r.promises.length + '):\n' + r.promises.slice(0, 40).map((p, i) => promiseLine(p, i, true)).join('\n'))];
  }
  if (cp.cmd === 'supervisor') {
    if (!r.ok && r.error === 'empty') return [send('Формат: /supervisor @username или /supervisor 123456789 (Telegram ID).')];
    if (!r.ok) return [send('Не нашёл ' + r.arg + '. Пусть руководитель напишет этому боту /start, затем повторите команду. Или укажите числовой Telegram ID.')];
    return [
      send('Руководитель для эскалаций: ' + (r.supervisor_name || r.supervisor_tg) + '. Если обещание просрочено на час без отметки — он получит сообщение.'),
      tg('sendMessage', { chat_id: r.supervisor_tg, text: 'Вас назначили руководителем для ' + (r.manager_name || 'менеджера') + '. Сюда будут приходить просроченные обещания.' }),
    ];
  }
  if (cp.cmd === 'cancel') return [send('Ок, отменил.')];
  return [send(
    'Я слежу за договорённостями из звонков.\n\n' +
    '1. Запишите звонок и перешлите аудио сюда.\n' +
    '2. В подписи — номер и имя клиента: +375291234567 Сергей\n' +
    '3. Через минуту пришлю карточку с обещаниями, а в срок — напоминание.\n\n' +
    'Команды:\n/client +375… — карточка клиента\n/open — открытые обещания\n/supervisor @username — руководитель для эскалаций' +
    (r.has_supervisor ? '' : '\n\nРуководитель пока не назначен.'))];
}

function buildDueRequest() {
  const c = $('Ctx').first().json;
  const system = 'Преобразуй срок, который написал пользователь, в дату и время. Текущая дата и время: ' + nowMinsk() + ' (Europe/Minsk). ' +
    '«До пятницы» без времени = пятница 18:00. «Завтра» без времени = 12:00. ' +
    'Верни ТОЛЬКО JSON {"due_at": "YYYY-MM-DDTHH:MM:00+03:00"} или {"due_at": null}, если срок не понятен.';
  return [{ json: { body: {
    model: c.cfg.llm_model, temperature: 0, response_format: { type: 'json_object' },
    messages: [{ role: 'system', content: system }, { role: 'user', content: c.text }],
  } } }];
}

function parseDue() {
  const c = $('Ctx').first().json;
  const content = $input.first().json.choices?.[0]?.message?.content || '';
  let due = null;
  try {
    const j = JSON.parse(content.slice(content.indexOf('{'), content.lastIndexOf('}') + 1));
    if (j.due_at) { let s = String(j.due_at); if (!/([zZ]|[+-]\d\d:?\d\d)$/.test(s)) s += '+03:00'; const d = new Date(s); if (!isNaN(d)) due = d.toISOString(); }
  } catch (e) {}
  if (!due) return [{ json: { ok: false, ...tg('sendMessage', { chat_id: c.chat_id, text: 'Не понял срок. Напишите, например: «завтра в 15:00» или «10.10 12:00». /cancel — отмена.' }).json } }];
  return [{ json: { ok: true, tg_id: c.tg_id, promise_id: c.user.pending.promise_id, due_at: due } }];
}

function dueReply() {
  const c = $('Ctx').first().json;
  const r = $input.first().json.r;
  if (!r.ok) return [tg('sendMessage', { chat_id: c.chat_id, text: 'Обещание не найдено.' })];
  return [tg('sendMessage', { chat_id: c.chat_id, text: '🕑 Новый срок: ' + r.promise.what + ' · до ' + fmtDue(r.promise.due_at) })];
}

function textHint() {
  const c = $('Ctx').first().json;
  return [tg('sendMessage', { chat_id: c.chat_id, text: 'Пришлите запись звонка (аудио) с подписью: +375291234567 Сергей\n/start — инструкция.' })];
}

// ---------- Code-ноды планировщика ----------

function buildMessages() {
  const r = $input.first().json.r;
  const out = [];
  for (const p of r.reminders) {
    const who = (p.client_name || 'клиент') + ' (' + fmtPhone(p.phone) + ')';
    const mins = Math.round((new Date(p.due_at) - Date.now()) / 60000);
    const lead = mins >= 50 ? 'Через час срок' : mins > 0 ? 'Через ' + mins + ' мин срок' : 'Срок наступил';
    if (p.who === 'manager') {
      out.push(tg('sendMessage', {
        chat_id: p.manager_tg,
        text: '⏰ ' + lead + ': ' + lc(p.what) + ' · ' + who + ', до ' + relDue(p.due_at) + '.',
        reply_markup: { inline_keyboard: [
          [{ text: '✅ Выполнено', callback_data: 'done:' + p.id }, { text: '⏩ Перенести на завтра', callback_data: 'postpone:' + p.id }],
          [{ text: '✉️ Черновик письма', callback_data: 'draft:' + p.id }, { text: '✖️ Отменить', callback_data: 'cancel:' + p.id }],
        ] },
      }));
    } else {
      const icon = p.action_type === 'payment' ? '💳' : '📌';
      const name = p.client_name || 'Клиент';
      const msg = (p.client_name ? p.client_name + ', добрый' : 'Добрый') + ' день! Напоминаем о договорённости: ' + lc(p.what) + ' — до ' + relDue(p.due_at) + '. Спасибо!';
      out.push(tg('sendMessage', {
        chat_id: p.manager_tg, parse_mode: 'HTML',
        text: icon + ' ' + esc(name) + ' (' + esc(fmtPhone(p.phone)) + ') обещал: ' + esc(lc(p.what)) + ' — до ' + esc(relDue(p.due_at)) +
          '. Отправить ему напоминание?\n\nТекст (нажмите, чтобы скопировать):\n<code>' + esc(msg) + '</code>',
        reply_markup: { inline_keyboard: [
          [{ text: '✅ Клиент выполнил', callback_data: 'done:' + p.id }, { text: '⏩ На завтра', callback_data: 'postpone:' + p.id }],
          [{ text: '✖️ Отменить', callback_data: 'cancel:' + p.id }],
        ] },
      }));
    }
  }
  for (const p of r.escalations) {
    const hours = Math.max(1, Math.floor((Date.now() - new Date(p.due_at)) / 3600e3));
    const client = (p.client_name || 'клиент') + ' (' + fmtPhone(p.phone) + ')';
    const what = p.who === 'manager'
      ? (p.manager_name || 'Менеджер') + ' обещал: ' + lc(p.what) + ' · ' + client
      : 'Клиент ' + client + ' обещал: ' + lc(p.what) + ' · менеджер ' + (p.manager_name || '');
    const text = '⚠️ Просрочено на ' + hours + ' ч: ' + what + ', срок был ' + relDue(p.due_at) + '.';
    if (p.supervisor_tg) out.push(tg('sendMessage', { chat_id: p.supervisor_tg, text }));
    else out.push(tg('sendMessage', { chat_id: p.manager_tg, text: text + '\n\nРуководитель не назначен — /supervisor @username' }));
  }
  return out;
}

function buildVoice() {
  const r = $input.first().json.r;
  return r.reminders.filter(p => p.who === 'manager').map(p => {
    const m = mk(p.due_at);
    const today = dayKey(p.due_at) === dayKey(Date.now());
    const when = (today ? 'сегодня' : dayKey(p.due_at) - dayKey(Date.now()) === 1 ? 'завтра' : WD_FULL[m.getUTCDay()]) + ' в ' + m.getUTCHours() + ':' + pad(m.getUTCMinutes());
    return { json: {
      chat_id: p.manager_tg,
      voice_id: r.cfg.tts_voice_id,
      body: { text: 'Напоминаю: вы обещали клиенту ' + (p.client_name || '') + ' — ' + lc(p.what) + '. Срок — ' + when + '.', model_id: r.cfg.tts_model },
    } };
  });
}

// ---------- конструктор нод ----------

let nodes, connections;
const reset = () => { nodes = []; connections = {}; };
const node = (name, type, typeVersion, position, parameters, extra = {}) => {
  nodes.push({ parameters, id: randomUUID(), name, type, typeVersion, position, ...extra });
  return name;
};
const link = (from, to, output = 0) => {
  connections[from] ??= { main: [] };
  while (connections[from].main.length <= output) connections[from].main.push([]);
  connections[from].main[output].push({ node: to, type: 'main', index: 0 });
};
const chain = (...names) => names.slice(1).forEach((n, i) => link(names[i], n));

const PG = { postgres: { id: 'mtc-postgres', name: 'MTC Supabase Postgres' } };
const OR = { httpHeaderAuth: { id: 'mtc-openrouter', name: 'OpenRouter' } };
const EL = { httpHeaderAuth: { id: 'mtc-elevenlabs', name: 'ElevenLabs' } };
const TG = { telegramApi: { id: 'mtc-telegram', name: 'MTC Telegram Bot' } };

const codeNode = (name, pos, fn, extraCode = '') =>
  node(name, 'n8n-nodes-base.code', 2, pos, { jsCode: extraCode + code(fn) });
const pgNode = (name, pos, query) =>
  node(name, 'n8n-nodes-base.postgres', 2.5, pos, { operation: 'executeQuery', query, options: {} }, { credentials: PG });
const switchNode = (name, pos, n, expr) =>
  node(name, 'n8n-nodes-base.switch', 3.2, pos, { mode: 'expression', numberOutputs: n, output: expr, options: {} });
const llmNode = (name, pos, bodyExpr) =>
  node(name, 'n8n-nodes-base.httpRequest', 4.2, pos, {
    method: 'POST', url: 'https://openrouter.ai/api/v1/chat/completions',
    authentication: 'genericCredentialType', genericAuthType: 'httpHeaderAuth',
    sendHeaders: true, headerParameters: { parameters: [{ name: 'X-Title', value: 'MTC promise agent' }] },
    sendBody: true, specifyBody: 'json', jsonBody: `={{ JSON.stringify(${bodyExpr}) }}`,
    options: { timeout: 90000 },
  }, { credentials: OR, onError: 'continueRegularOutput', retryOnFail: true, maxTries: 2, waitBetweenTries: 1000 });
const tgApiNode = (name, pos, tokenExpr) =>
  node(name, 'n8n-nodes-base.httpRequest', 4.2, pos, {
    method: 'POST', url: `=https://api.telegram.org/bot{{ ${tokenExpr} }}/{{ $json.method }}`,
    sendBody: true, specifyBody: 'json', jsonBody: '={{ JSON.stringify($json.payload) }}', options: {},
  }, { onError: 'continueRegularOutput' });

// ---------- WF: бот (WF1 + WF3 + WF4) ----------
reset();
// Токен бота берётся из mtc.settings.bot_token (доступ к $env в нодах n8n закрыт по умолчанию).
const TOKEN = "$('Ctx').first().json.cfg.bot_token";
node('Telegram Trigger', 'n8n-nodes-base.telegramTrigger', 1.2, [0, 600],
  { updates: ['message', 'callback_query'], additionalFields: {} }, { credentials: TG, webhookId: randomUUID() });
codeNode('Route', [220, 600], route);
pgNode('Register', [440, 600], sqlCall('bot_register', '{ tg_id: $json.tg_id, name: $json.name, username: $json.username }'));
codeNode('Ctx', [660, 600], ctx);
switchNode('Switch kind', [880, 600], 5, "={{ ({ audio: 0, callback: 1, command: 2, text: 3 })[$json.kind] ?? 4 }}");
// выход 4 («прочее») никуда не ведёт
chain('Telegram Trigger', 'Route');
link('Route', 'Register');
chain('Register', 'Ctx', 'Switch kind');

tgApiNode('TG API', [3900, 900], TOKEN);

// --- WF1: разбор звонка
codeNode('Check caption', [1100, 200], checkCaption);
switchNode('Caption OK?', [1320, 200], 2, '={{ $json.ok ? 0 : 1 }}');
node('TG: Разбираю', 'n8n-nodes-base.httpRequest', 4.2, [1540, 100], {
  method: 'POST', url: `=https://api.telegram.org/bot{{ ${TOKEN} }}/sendMessage`,
  sendBody: true, specifyBody: 'json',
  jsonBody: "={{ JSON.stringify({ chat_id: $('Ctx').first().json.chat_id, text: 'Разбираю звонок…' }) }}", options: {},
}, { onError: 'continueRegularOutput' });
pgNode('Start call', [1760, 100], sqlCall('start_call',
  "{ user_id: $('Ctx').first().json.user.id, phone: $('Check caption').first().json.phone, client_name: $('Check caption').first().json.client_name, file_id: $('Ctx').first().json.file_id, duration: $('Ctx').first().json.duration }"));
node('TG: getFile', 'n8n-nodes-base.httpRequest', 4.2, [1980, 100], {
  method: 'GET', url: `=https://api.telegram.org/bot{{ ${TOKEN} }}/getFile`,
  sendQuery: true, queryParameters: { parameters: [{ name: 'file_id', value: "={{ $('Ctx').first().json.file_id }}" }] }, options: {},
});
node('Download audio', 'n8n-nodes-base.httpRequest', 4.2, [2200, 100], {
  method: 'GET', url: `=https://api.telegram.org/file/bot{{ ${TOKEN} }}/{{ $json.result.file_path }}`,
  options: { response: { response: { responseFormat: 'file', outputPropertyName: 'data' } } },
});
node('ElevenLabs STT', 'n8n-nodes-base.httpRequest', 4.2, [2420, 100], {
  method: 'POST', url: 'https://api.elevenlabs.io/v1/speech-to-text',
  authentication: 'genericCredentialType', genericAuthType: 'httpHeaderAuth',
  sendBody: true, contentType: 'multipart-form-data',
  bodyParameters: { parameters: [
    { parameterType: 'formBinaryData', name: 'file', inputDataFieldName: 'data' },
    { name: 'model_id', value: "={{ $('Ctx').first().json.cfg.stt_model }}" },
    { name: 'diarize', value: 'true' },
    { name: 'num_speakers', value: '2' },
    { name: 'tag_audio_events', value: 'false' },
  ] },
  options: { timeout: 120000 },
}, { credentials: EL, onError: 'continueRegularOutput' });
codeNode('Build LLM request', [2640, 100], buildLlmRequest, 'const PROMPT = ' + JSON.stringify(EXTRACT_PROMPT) + ';\n');
switchNode('STT OK?', [2860, 100], 2, '={{ $json.ok ? 0 : 1 }}');
llmNode('LLM 1', [3080, 0], '$json.body');
codeNode('Parse 1', [3300, 0], parseLlm);
switchNode('Parsed 1?', [3520, 0], 2, '={{ $json.ok ? 0 : 1 }}');
llmNode('LLM 2', [3300, 200], "$('Build LLM request').first().json.retryBody");
codeNode('Parse 2', [3520, 200], parseLlm);
switchNode('Parsed 2?', [3740, 200], 2, '={{ $json.ok ? 0 : 1 }}');
pgNode('Finish call', [3740, -100], sqlCall('finish_call', '$json.save'));
codeNode('Build card', [3960, -100], buildCard);
pgNode('Call error', [3960, 300], sqlCall('call_error', "{ call_id: $('Start call').first().json.r.call_id, error: $json.error, raw: $json.raw ?? null }"));
codeNode('Error reply', [4180, 300], errorReply);

link('Switch kind', 'Check caption', 0);
link('Check caption', 'Caption OK?');
link('Caption OK?', 'TG: Разбираю', 0);
link('Caption OK?', 'TG API', 1);
chain('TG: Разбираю', 'Start call', 'TG: getFile', 'Download audio', 'ElevenLabs STT', 'Build LLM request', 'STT OK?');
link('STT OK?', 'LLM 1', 0);
link('STT OK?', 'Call error', 1);
chain('LLM 1', 'Parse 1', 'Parsed 1?');
link('Parsed 1?', 'Finish call', 0);
link('Parsed 1?', 'LLM 2', 1);
chain('LLM 2', 'Parse 2', 'Parsed 2?');
link('Parsed 2?', 'Finish call', 0);
link('Parsed 2?', 'Call error', 1);
chain('Finish call', 'Build card', 'TG API');
chain('Call error', 'Error reply', 'TG API');

// --- WF3: кнопки
codeNode('Callback parse', [1100, 700], callbackParse);
pgNode('Promise action', [1320, 700], sqlCall('promise_action', "{ tg_id: $('Ctx').first().json.tg_id, action: $json.action, promise_id: $json.promise_id }"));
codeNode('Callback reply', [1540, 650], callbackReply);
switchNode('Is draft?', [1540, 800], 2, "={{ $json.r.ok && $json.r.action === 'draft' ? 0 : 1 }}");
codeNode('Build draft request', [1760, 800], buildDraftRequest);
llmNode('LLM draft', [1980, 800], '$json.body');
codeNode('Draft message', [2200, 800], draftMessage);
link('Switch kind', 'Callback parse', 1);
link('Callback parse', 'Promise action');
link('Promise action', 'Callback reply');
link('Promise action', 'Is draft?');
link('Callback reply', 'TG API');
link('Is draft?', 'Build draft request', 0);
chain('Build draft request', 'LLM draft', 'Draft message', 'TG API');

// --- WF4: команды и текст
codeNode('Command parse', [1100, 1000], commandParse);
pgNode('Command', [1320, 1000], sqlCall('bot_command', '$json'));
codeNode('Command reply', [1540, 1000], commandReply);
link('Switch kind', 'Command parse', 2);
chain('Command parse', 'Command', 'Command reply', 'TG API');

switchNode('Pending fix?', [1100, 1250], 2, "={{ $json.user.pending?.type === 'fix' ? 0 : 1 }}");
codeNode('Build due request', [1320, 1200], buildDueRequest);
llmNode('LLM due', [1540, 1200], '$json.body');
codeNode('Parse due', [1760, 1200], parseDue);
switchNode('Due OK?', [1980, 1200], 2, '={{ $json.ok ? 0 : 1 }}');
pgNode('Set due', [2200, 1150], sqlCall('set_due', '{ tg_id: $json.tg_id, promise_id: $json.promise_id, due_at: $json.due_at }'));
codeNode('Due reply', [2420, 1150], dueReply);
codeNode('Text hint', [1320, 1350], textHint);
link('Switch kind', 'Pending fix?', 3);
link('Pending fix?', 'Build due request', 0);
link('Pending fix?', 'Text hint', 1);
chain('Build due request', 'LLM due', 'Parse due', 'Due OK?');
link('Due OK?', 'Set due', 0);
link('Due OK?', 'TG API', 1);
chain('Set due', 'Due reply', 'TG API');
link('Text hint', 'TG API');

const bot = { id: 'mtcBotWorkflow01', name: 'MTC · Бот (звонки, кнопки, команды)', nodes, connections, settings: { executionOrder: 'v1' } };
writeFileSync(new URL('wf-bot.json', OUT), JSON.stringify(bot, null, 2));

// ---------- WF2: планировщик ----------
reset();
const TOKEN2 = "$('Tick').first().json.r.cfg.bot_token";
node('Every 5 min', 'n8n-nodes-base.scheduleTrigger', 1.2, [0, 300], { rule: { interval: [{ field: 'minutes', minutesInterval: 5 }] } });
pgNode('Tick', [220, 300], '=select mtc.scheduler_tick() as r');
codeNode('Build messages', [440, 200], buildMessages);
tgApiNode('TG API', [660, 200], TOKEN2);
codeNode('Build voice', [440, 400], buildVoice);
node('ElevenLabs TTS', 'n8n-nodes-base.httpRequest', 4.2, [660, 400], {
  method: 'POST', url: '=https://api.elevenlabs.io/v1/text-to-speech/{{ $json.voice_id }}?output_format=mp3_44100_64',
  authentication: 'genericCredentialType', genericAuthType: 'httpHeaderAuth',
  sendBody: true, specifyBody: 'json', jsonBody: '={{ JSON.stringify($json.body) }}',
  options: { response: { response: { responseFormat: 'file', outputPropertyName: 'data' } } },
}, { credentials: EL, onError: 'continueRegularOutput' });
node('TG: sendVoice', 'n8n-nodes-base.httpRequest', 4.2, [880, 400], {
  method: 'POST', url: `=https://api.telegram.org/bot{{ ${TOKEN2} }}/sendVoice`,
  sendBody: true, contentType: 'multipart-form-data',
  bodyParameters: { parameters: [
    { name: 'chat_id', value: "={{ $('Build voice').item.json.chat_id }}" },
    { parameterType: 'formBinaryData', name: 'voice', inputDataFieldName: 'data' },
  ] },
  options: {},
}, { onError: 'continueRegularOutput' });
chain('Every 5 min', 'Tick');
link('Tick', 'Build messages');
link('Tick', 'Build voice');
link('Build messages', 'TG API');
chain('Build voice', 'ElevenLabs TTS', 'TG: sendVoice');

const sched = { id: 'mtcSchedWorkflow1', name: 'MTC · Планировщик напоминаний', nodes, connections, settings: { executionOrder: 'v1' } };
writeFileSync(new URL('wf-scheduler.json', OUT), JSON.stringify(sched, null, 2));

console.log('ok: wf-bot.json, wf-scheduler.json');
