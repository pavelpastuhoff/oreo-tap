# Деплой Telegram-бота «ОРЕО» на Google Cloud Run

> **Важно:** Никогда не сохраняйте `BOT_TOKEN` и другие секреты в коде или в `Dockerfile`. Передавайте их только через переменные окружения (`--set-env-vars`) или Secret Manager в Google Cloud.

## 1. Авторизация и выбор проекта Google Cloud

```bash
gcloud auth login
gcloud config set project ВАШ_PROJECT_ID
```

## 2. Первичный деплой контейнера в Cloud Run

Выполните команду в корне проекта:

```bash
gcloud run deploy oreo-bot \
  --source . \
  --region europe-west4 \
  --allow-unauthenticated \
  --set-env-vars BOT_TOKEN="твой_токен"
```

Для PowerShell (в одну строку):

```powershell
gcloud run deploy oreo-bot --source . --region europe-west4 --allow-unauthenticated --set-env-vars BOT_TOKEN="твой_токен"
```

После завершения деплоя Google Cloud Run выведет `Service URL` вида:
`https://oreo-bot-xxxxxxxxxx-ez.a.run.app`

## 3. Привязка Webhook URL (режим Webhook)

Чтобы бот автоматически зарегистрировал Telegram Webhook на адрес вашего сервиса Cloud Run, передайте полученный `Service URL` в переменную окружения `WEBHOOK_URL`:

```powershell
gcloud run services update oreo-bot --region europe-west4 --update-env-vars WEBHOOK_URL="https://oreo-bot-xxxxxxxxxx-ez.a.run.app/webhook"
```

Либо укажите все переменные сразу при деплое:

```powershell
gcloud run deploy oreo-bot --source . --region europe-west4 --allow-unauthenticated --set-env-vars BOT_TOKEN="твой_токен",WEBHOOK_URL="https://oreo-bot-xxxxxxxxxx-ez.a.run.app/webhook",WEBAPP_URL="https://pavelpastuhoff.github.io/oreo-tap/"
```

## Поддерживаемые переменные окружения

| Переменная | Обязательна | Описание |
| :--- | :---: | :--- |
| `BOT_TOKEN` | Да | Токен Telegram-бота от `@BotFather` (строго через env) |
| `WEBHOOK_SECRET` | Да (для Webhook) | Криптографический секрет для проверки заголовка `X-Telegram-Bot-Api-Secret-Token` |
| `PORT` | Нет (задаётся Render / Cloud Run) | Порт веб-сервера (по умолчанию `8080`, слушает `0.0.0.0`) |
| `WEBHOOK_URL` | Нет (на Render берётся `RENDER_EXTERNAL_URL`) | Публичный HTTPS-адрес сервиса для автоматической установки `setWebhook` |
| `WEBAPP_URL` | Нет | URL Telegram Mini App на статическом хостинге (по умолчанию `https://pavelpastuhoff.github.io/oreo-tap/`) |
| `BOT_USERNAME` | Нет | Имя бота без `@` (по умолчанию `oreo_67_bot`) |
| `FIREBASE_DB_URL` | Нет | URL базы данных Firebase Realtime Database |
