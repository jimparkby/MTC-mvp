# MVP: агент контроля договорённостей

```
sql/schema.sql          таблицы (схема mtc) + функции, которые вызывает n8n
n8n/build.mjs           генератор воркфлоу (правки кода — здесь, затем: node n8n/build.mjs)
n8n/wf-bot.json         WF1 + WF3 + WF4: один Telegram Trigger → Switch по типу апдейта
n8n/wf-scheduler.json   WF2: каждые 5 минут — напоминания, голосовые, эскалации
tests/results.csv       таблица прогона тестового набора (звонок, ожидалось, найдено, ошибка)
```

## Текущее окружение (с 6 окт: automatization.luvo.by недоступен)

- n8n на Railway: https://n8n-production-a2e42.up.railway.app (проект `pleasing-contentment`, образ `n8nio/n8n:2.42.3`, volume `/home/node/.n8n`).
  Токен бота берётся из `mtc.settings.bot_token`.
- Запасной вариант — n8n локально: `C:\Users\User\n8n-local`, запуск — `powershell -File C:\Users\User\n8n-local\start.ps1`
  (поднимает cloudflared-туннель и n8n с `WEBHOOK_URL`; адрес туннеля новый при каждом запуске —
  после перезапуска выключить/включить воркфлоу бота, чтобы перерегистрировать вебхук).
- Supabase: проект `mtc-mvp` (ref `sddnrieghizrgphkyenk`), схема `mtc` уже применена.
  Session pooler: `aws-0-eu-west-2.pooler.supabase.com:5432`, user `postgres.sddnrieghizrgphkyenk`.
- Воркфлоу и Credentials-заготовки импортированы; секреты вписываются в Credentials вручную.

## Запуск

1. **Бот**: @BotFather → /newbot → токен.
2. **Supabase**: новый проект → SQL Editor → выполнить `sql/schema.sql`. Затем:
   `update mtc.settings set value = '<токен>' where key = 'bot_token';`
3. **Credentials в n8n** (имена важны — по ним ноды найдут креденшлы):
   - `MTC Telegram Bot` — Telegram API, токен бота.
   - `MTC Supabase Postgres` — Postgres. Supabase → Connect → Session pooler: host `aws-…pooler.supabase.com`, port 5432, user `postgres.<ref>`, DB `postgres`, SSL on.
   - `OpenRouter` — Header Auth: `Authorization` = `Bearer sk-or-…`.
   - `ElevenLabs` — Header Auth: `xi-api-key` = ключ.
4. Импортировать `wf-bot.json` и `wf-scheduler.json`, в нодах с красным значком выбрать креденшлы, активировать оба.
5. Написать боту `/start`, переслать аудио с подписью `+375291234567 Сергей`.

## Почему так

- Логика БД — в SQL-функциях (`mtc.start_call`, `mtc.finish_call`, `mtc.scheduler_tick`…): n8n только передаёт JSON, апсерты и пометки «напомнено» атомарны.
- Telegram-вызовы — через HTTP Request: нужны динамические inline-кнопки и `sendVoice`, которых нет в стандартной Telegram-ноде. Поэтому токен лежит ещё и в `mtc.settings` (RLS включён, REST API его не видит).
- Модель, температура, STT/TTS-модели и голос меняются в `mtc.settings` без правки воркфлоу.
- Невалидный JSON от LLM → один повтор (`LLM 2`), затем `calls.status = 'error'` и сообщение менеджеру.
- Postpone ставит статус `postponed`, сбрасывает `reminded_at`; планировщик берёт `open` и `postponed`.
