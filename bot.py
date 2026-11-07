"""Официальный Telegram-бот экосистемы «ОРЕО» (Mini App + Интерактивное меню + Реферальная сеть).

Запуск (PowerShell):
    python bot.py
Зависимостей нет — только стандартная библиотека Python 3.
При старте автоматически настраивает описание, команды и кнопку меню бота,
а также отправляет фирменный баннер assets/banner.jpg с HTML-оформлением.
"""
import hmac
import html
import http.server
import json
import mimetypes
import os
import re
import threading
import time
import urllib.parse
import urllib.request
import uuid

import admin_poker_bot

def _load_local_dotenv(dotenv_path=None):
    """Загружает переменные из локального файла .env (если он существует), не перезаписывая системное окружение."""
    path = dotenv_path or os.path.join(os.path.dirname(os.path.abspath(__file__)), ".env")
    if not os.path.isfile(path):
        return
    try:
        with open(path, "r", encoding="utf-8") as f:
            for raw_line in f:
                line = raw_line.strip()
                if not line or line.startswith("#") or "=" not in line:
                    continue
                if line.startswith("export "):
                    line = line[7:].strip()
                key, val = line.split("=", 1)
                key = key.strip()
                val = val.strip()
                if len(val) >= 2 and val[0] == val[-1] and val[0] in ("'", '"'):
                    val = val[1:-1]
                if key:
                    os.environ.setdefault(key, val)
    except OSError:
        pass


_load_local_dotenv()

_raw_bot_token = os.getenv("BOT_TOKEN")
TOKEN = _raw_bot_token.strip() if _raw_bot_token else None

_raw_webhook_secret = os.getenv("WEBHOOK_SECRET")
WEBHOOK_SECRET = _raw_webhook_secret.strip() if _raw_webhook_secret else None

BOT_USERNAME = os.getenv("BOT_USERNAME") or "oreo_67_bot"
WEBAPP_URL = os.getenv("WEBAPP_URL") or "https://oreo-67-bot.netlify.app"
WEBHOOK_URL = (
    os.getenv("WEBHOOK_URL")
    or os.getenv("RENDER_EXTERNAL_URL")
    or os.getenv("CLOUD_RUN_URL")
    or os.getenv("SERVICE_URL")
    or ""
).strip()
WEBHOOK_PATH = (os.getenv("WEBHOOK_PATH") or "/webhook").strip() or "/webhook"
if not WEBHOOK_PATH.startswith("/"):
    WEBHOOK_PATH = f"/{WEBHOOK_PATH}"

MAX_WEBHOOK_BODY_BYTES = 262_144  # 256 KB
_WEBHOOK_SEMAPHORE = threading.BoundedSemaphore(32)
_TOKEN_RE = re.compile(r"[0-9]{8,12}:[A-Za-z0-9_-]{30,50}")


def _redact_secrets(val) -> str:
    text = str(val or "")
    if TOKEN:
        text = text.replace(TOKEN, "[REDACTED_BOT_TOKEN]")
    if WEBHOOK_SECRET:
        text = text.replace(WEBHOOK_SECRET, "[REDACTED_WEBHOOK_SECRET]")
    return _TOKEN_RE.sub("[REDACTED_BOT_TOKEN]", text)


API = f"https://api.telegram.org/bot{TOKEN}/" if TOKEN else ""
BANNER_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), "assets", "banner.jpg")

# Кешируем file_id баннера после первой загрузки, чтобы бот отвечал мгновенно
_cached_banner_file_id = None


def call(method, **params):
    data = urllib.parse.urlencode(
        {k: json.dumps(v, ensure_ascii=False) if isinstance(v, (dict, list)) else v for k, v in params.items() if v is not None}
    ).encode("utf-8")
    req = urllib.request.Request(API + method, data=data)
    with urllib.request.urlopen(req, timeout=70) as r:
        return json.load(r)


def call_multipart(method, fields, file_field, file_path):
    boundary = f"----OreoBotBoundary{uuid.uuid4().hex}"
    body = bytearray()
    for k, v in fields.items():
        if v is None:
            continue
        val = json.dumps(v, ensure_ascii=False) if isinstance(v, (dict, list)) else str(v)
        body.extend(f"--{boundary}\r\n".encode("utf-8"))
        body.extend(f'Content-Disposition: form-data; name="{k}"\r\n\r\n'.encode("utf-8"))
        body.extend(f"{val}\r\n".encode("utf-8"))

    filename = os.path.basename(file_path)
    mime = mimetypes.guess_type(filename)[0] or "image/jpeg"
    with open(file_path, "rb") as f:
        file_bytes = f.read()

    body.extend(f"--{boundary}\r\n".encode("utf-8"))
    body.extend(f'Content-Disposition: form-data; name="{file_field}"; filename="{filename}"\r\n'.encode("utf-8"))
    body.extend(f"Content-Type: {mime}\r\n\r\n".encode("utf-8"))
    body.extend(file_bytes)
    body.extend(f"\r\n--{boundary}--\r\n".encode("utf-8"))

    req = urllib.request.Request(
        API + method,
        data=bytes(body),
        headers={"Content-Type": f"multipart/form-data; boundary={boundary}"},
    )
    with urllib.request.urlopen(req, timeout=70) as r:
        return json.load(r)


def send_card(chat_id, caption, reply_markup):
    """Отправляет красивую карточку с баннером (или текстовое сообщение, если баннер недоступен)."""
    global _cached_banner_file_id
    try:
        if _cached_banner_file_id:
            res = call(
                "sendPhoto",
                chat_id=chat_id,
                photo=_cached_banner_file_id,
                caption=caption,
                parse_mode="HTML",
                reply_markup=reply_markup,
            )
            return res
        if os.path.isfile(BANNER_PATH):
            res = call_multipart(
                "sendPhoto",
                fields={
                    "chat_id": chat_id,
                    "caption": caption,
                    "parse_mode": "HTML",
                    "reply_markup": reply_markup,
                },
                file_field="photo",
                file_path=BANNER_PATH,
            )
            photos = (res.get("result") or {}).get("photo") or []
            if photos:
                _cached_banner_file_id = photos[-1].get("file_id")
            return res
    except Exception as e:
        print("Не удалось отправить баннер, откат на текст:", _redact_secrets(e))

    return call(
        "sendMessage",
        chat_id=chat_id,
        text=caption,
        parse_mode="HTML",
        disable_web_page_preview=True,
        reply_markup=reply_markup,
    )


def edit_card(chat_id, message_id, has_photo, text, reply_markup):
    try:
        if has_photo:
            return call(
                "editMessageCaption",
                chat_id=chat_id,
                message_id=message_id,
                caption=text,
                parse_mode="HTML",
                reply_markup=reply_markup,
            )
        return call(
            "editMessageText",
            chat_id=chat_id,
            message_id=message_id,
            text=text,
            parse_mode="HTML",
            disable_web_page_preview=True,
            reply_markup=reply_markup,
        )
    except Exception:
        pass


def make_ref_link(user_id):
    return f"https://t.me/{BOT_USERNAME}?start=ref_{user_id}" if user_id else f"https://t.me/{BOT_USERNAME}"


def make_share_url(ref_link):
    share_text = "🍪 Залетай в ОРЕО! Забирай 2 бесплатных кейса, выбивай Золотой ОРЕО и тапай со мной! 🔥"
    return f"https://t.me/share/url?url={urllib.parse.quote(ref_link)}&text={urllib.parse.quote(share_text)}"


def main_keyboard(app_url, ref_link):
    return {
        "inline_keyboard": [
            [{"text": "🍪 ИГРАТЬ В ОРЕО", "web_app": {"url": app_url}}],
            [
                {"text": "🎁 Кейсы & Скины", "callback_data": "tab_cases"},
                {"text": "🏆 Лиги & Топ", "callback_data": "tab_top"},
            ],
            [
                {"text": "👥 Моя ссылка (+2500 🪙)", "callback_data": "tab_ref"},
                {"text": "🎬 TikTok 100K", "callback_data": "tab_tiktok"},
            ],
            [{"text": "✈️ Пригласить друга в 1 клик", "url": make_share_url(ref_link)}],
        ]
    }


def back_keyboard(app_url, ref_link):
    return {
        "inline_keyboard": [
            [{"text": "🍪 ОТКРЫТЬ ИГРУ", "web_app": {"url": app_url}}],
            [{"text": "✈️ Поделиться с другом", "url": make_share_url(ref_link)}],
            [{"text": "« Назад в меню", "callback_data": "tab_home"}],
        ]
    }


def build_home_text(first_name, is_ref=False):
    name = html.escape(first_name or "Тапер")
    ref_line = "\n🎁 <b>Бонус по приглашению активирован:</b> стартовые <b>+150 🪙</b> и <b>+25 💎</b> ждут в игре!\n" if is_ref else ""
    return (
        f"🍪 <b>Привет, {name}! Добро пожаловать в ОРЕО</b>\n"
        f"{ref_line}\n"
        "Тапай 3D-печеньку под бит <i>lil ptiric</i>, включай селфи-фильтры и собирай редкие скины!\n\n"
        "<blockquote>"
        "👑 <b>Золотой ОРЕО 999</b> — даёт <b>×3.0</b> к фарму\n"
        "🎁 <b>2 бесплатных кейса</b> — доступны каждый день\n"
        "🔥 <b>Ударный стрик</b> — держи серию дней, чтобы не сгореть\n"
        "👥 <b>Сеть ОРЕО</b> — <b>+2 500 🪙</b> за друга и <b>10%</b> с его тапов"
        "</blockquote>\n\n"
        "👇 <b>Жми кнопку ниже и врывайся в сезон!</b>"
    )


def build_cases_text():
    return (
        "🎁 <b>КЕЙСЫ, СКИНЫ & БИРЖА ОРЕО</b>\n\n"
        "Открывай кейсы с рулеткой и собирай коллекцию печенек с множителем дохода:\n\n"
        "• 🍪 <b>Классический ОРЕО</b> — <code>×1.0</code> <i>(Базовый)</i>\n"
        "• 🍓 <b>Клубничный ОРЕО</b> — <code>×1.25</code> <i>(Редкий)</i>\n"
        "• 🧪 <b>Мятный Кибер-ОРЕО</b> — <code>×1.4</code> <i>(Редкий)</i>\n"
        "• ⚡ <b>Неоновый 67 ОРЕО</b> — <code>×1.85</code> <i>(Эпический)</i>\n"
        "• 👑 <b>Золотой ОРЕО 999</b> — <code>×3.0</code> <i>(Легендарный)</i>\n"
        "• 🎸 <b>Дима Твикс Cosmic</b> — <code>×5.0</code> <i>(Мифический)</i>\n\n"
        "<blockquote>📈 <b>Встроенная биржа:</b> любой выбитый дубликат можно мгновенно продать за печенько-коины прямо в инвентаре!</blockquote>"
    )


def build_top_text():
    return (
        "🏆 <b>МИРОВОЙ РЕЙТИНГ И ЛИГИ ОРЕО</b>\n\n"
        "Соревнуйся с друзьями по капиталу печенько-коинов и поднимайся по лигам:\n\n"
        "🥉 <b>Бронзовая Крошка</b> — от <code>0 🪙</code>\n"
        "🥈 <b>Серебряный Крем</b> — от <code>2 500 🪙</code>\n"
        "🥇 <b>Золотой ОРЕО</b> — от <code>15 000 🪙</code>\n"
        "💎 <b>Алмазный Магнат</b> — от <code>75 000 🪙</code>\n"
        "👑 <b>Император ОРЕО 67</b> — от <code>250 000 🪙</code>\n\n"
        "<blockquote>🔥 <b>Правило стрика:</b> заходи и тапай каждый день! Пропуск дня без 🧊 Заморозки сжигает прогресс.</blockquote>"
    )


def build_ref_text(ref_link):
    return (
        "👥 <b>ПАРТНЁРСКАЯ СЕТЬ ОРЕО</b>\n\n"
        "Приглашай друзей в команду и получай пассивный доход с каждого их тапа:\n\n"
        "• 🎁 <b>+2 500 🪙</b> — мгновенно за каждого друга\n"
        "• 📈 <b>10% коинов</b> — со всех тапов друзей 1-й линии\n"
        "• 🚀 <b>3% коинов</b> — с друзей 2-й линии\n\n"
        "🔗 <b>Твоя персональная ссылка (нажми, чтобы скопировать):</b>\n"
        f"<code>{html.escape(ref_link)}</code>"
    )


def build_tiktok_text(ref_link):
    return (
        "🎬 <b>TIKTOK КОНКУРС НЕДЕЛИ & АМБАССАДОРЫ</b>\n\n"
        "Сними ролик в TikTok / Shorts / Reels и забери главный банк недели:\n\n"
        "1️⃣ Включи в игре <b>📷 Камеру-фон</b> с необычным фильтром (<i>Неон 67, Золотой ОРЕО, VHS</i>)\n"
        "2️⃣ Потапай печеньку под трек <b>lil ptiric</b> (скоро — официальный гимн от <b>Димы Твикса 🎸</b>)\n"
        "3️⃣ Оставь свою реферальную ссылку в описании или профиле:\n"
        f"<code>{html.escape(ref_link)}</code>\n\n"
        "<blockquote>🏆 <b>Призовой фонд недели:</b> до <b>100 000 🪙</b>, <b>500 💎</b> и эксклюзивный скин <b>Золотой ОРЕО 999</b>!</blockquote>"
    )


def setup_bot_profile():
    """Настраивает кнопки, команды и описание бота в Telegram."""
    try:
        call(
            "setChatMenuButton",
            menu_button={"type": "web_app", "text": "🍪 Играть", "web_app": {"url": WEBAPP_URL}},
        )
        call(
            "setMyCommands",
            commands=[
                {"command": "start", "description": "🍪 Запустить ОРЕО и открыть меню"},
                {"command": "duel", "description": "⚔️ Вызов 1v1 (Берёзовый Покер и Шахматы)"},
                {"command": "ref", "description": "👥 Моя реферальная ссылка (+2500 🪙)"},
                {"command": "cases", "description": "🎁 Кейсы и скины ОРЕО"},
                {"command": "top", "description": "🏆 Таблица лиг и рейтинг"},
                {"command": "tiktok", "description": "🎬 Конкурс TikTok на 100 000 🪙"},
                {"command": "admin", "description": "👑 Админ-пульт (для основателя)"},
            ],
        )
        call(
            "setMyShortDescription",
            short_description="🍪 Тапай ОРЕО, выбивай Золотой ОРЕО из бесплатных кейсов, держи стрик и врывайся в ТОП! 👑",
        )
        call(
            "setMyDescription",
            description=(
                "🍪 Добро пожаловать в экосистему ОРЕО!\n\n"
                "• 👑 Собирай 3D-скины печенек (Золотой ОРЕО ×3, Дима Твикс Cosmic ×5)\n"
                "• 🎁 Открывай бесплатные кейсы с рулеткой каждый день\n"
                "• 📷 Тапай с необычными селфи-фильтрами под бит lil ptiric\n"
                "• 🔥 Держи ежедневный стрик и соревнуйся в мировом рейтинге\n"
                "• 👥 Получай +2 500 🪙 за друга и 10% от его фарма!\n\n"
                "👇 Нажми «Запустить» (/start), чтобы забрать стартовый бонус!"
            ),
        )
    except Exception as e:
        print("Предупреждение при настройке профиля бота:", _redact_secrets(e))


def handle_message(msg):
    if not isinstance(msg, dict):
        return
    chat_id = (msg.get("chat") or {}).get("id")
    if not chat_id:
        return
    if admin_poker_bot.handle_admin_or_duel_message(msg, call, send_card, WEBAPP_URL):
        return
    user = msg.get("from") or {}
    user_id = user.get("id", "")
    first_name = user.get("first_name", "Тапер")
    text_in = (msg.get("text") or "").strip()

    ref_param = ""
    if text_in.startswith("/start"):
        parts = text_in.split(maxsplit=1)
        if len(parts) > 1:
            ref_param = parts[1].strip()

    app_url = f"{WEBAPP_URL}?ref={urllib.parse.quote(ref_param)}" if ref_param else WEBAPP_URL
    ref_link = make_ref_link(user_id)

    cmd = text_in.split()[0].lower().split("@")[0] if text_in else "/start"

    if cmd == "/ref":
        send_card(chat_id, build_ref_text(ref_link), back_keyboard(app_url, ref_link))
    elif cmd == "/cases":
        send_card(chat_id, build_cases_text(), back_keyboard(app_url, ref_link))
    elif cmd == "/top":
        send_card(chat_id, build_top_text(), back_keyboard(app_url, ref_link))
    elif cmd == "/tiktok":
        send_card(chat_id, build_tiktok_text(ref_link), back_keyboard(app_url, ref_link))
    else:
        kb = admin_poker_bot.decorate_main_keyboard(main_keyboard(app_url, ref_link), user_id, WEBAPP_URL)
        send_card(chat_id, build_home_text(first_name, is_ref=bool(ref_param)), kb)


def handle_callback(cb):
    if not isinstance(cb, dict) or not cb.get("id"):
        return
    if admin_poker_bot.handle_admin_or_duel_callback(cb, call, edit_card, WEBAPP_URL):
        try:
            call("answerCallbackQuery", callback_query_id=cb["id"])
        except Exception:
            pass
        return
    cb_id = cb["id"]
    data = cb.get("data") or "tab_home"
    msg = cb.get("message") or {}
    chat_id = (msg.get("chat") or {}).get("id")
    message_id = msg.get("message_id")
    has_photo = bool(msg.get("photo"))
    user = cb.get("from") or {}
    user_id = user.get("id", "")
    first_name = user.get("first_name", "Тапер")

    try:
        call("answerCallbackQuery", callback_query_id=cb_id)
    except Exception:
        pass

    if not chat_id or not message_id:
        return

    ref_link = make_ref_link(user_id)
    app_url = WEBAPP_URL

    if data == "tab_cases":
        edit_card(chat_id, message_id, has_photo, build_cases_text(), back_keyboard(app_url, ref_link))
    elif data == "tab_top":
        edit_card(chat_id, message_id, has_photo, build_top_text(), back_keyboard(app_url, ref_link))
    elif data == "tab_ref":
        edit_card(chat_id, message_id, has_photo, build_ref_text(ref_link), back_keyboard(app_url, ref_link))
    elif data == "tab_tiktok":
        edit_card(chat_id, message_id, has_photo, build_tiktok_text(ref_link), back_keyboard(app_url, ref_link))
    else:
        kb = admin_poker_bot.decorate_main_keyboard(main_keyboard(app_url, ref_link), user_id, WEBAPP_URL)
        edit_card(chat_id, message_id, has_photo, build_home_text(first_name), kb)


def process_update(u):
    if not isinstance(u, dict):
        return
    try:
        if "message" in u:
            handle_message(u["message"])
        elif "callback_query" in u:
            handle_callback(u["callback_query"])
    except Exception as e:
        print("Ошибка при обработке обновления Telegram:", _redact_secrets(e))


def resolve_webhook_url():
    """Формирует итоговый URL вебхука из переменных окружения Render / Cloud Run (WEBHOOK_URL / RENDER_EXTERNAL_URL / SERVICE_URL)."""
    raw = WEBHOOK_URL.strip()
    if not raw:
        return ""
    parsed = urllib.parse.urlsplit(raw)
    if not parsed.path or parsed.path == "/":
        path = WEBHOOK_PATH if WEBHOOK_PATH.startswith("/") else f"/{WEBHOOK_PATH}"
        return f"{raw.rstrip('/')}{path}"
    return raw


def _expected_webhook_path() -> str:
    resolved = resolve_webhook_url()
    if resolved:
        p = urllib.parse.urlsplit(resolved).path
        if p:
            return p
    return WEBHOOK_PATH


class _HealthCheckHandler(http.server.BaseHTTPRequestHandler):
    timeout = 10

    def _respond(self, code: int, body: bytes, send_body: bool = True):
        self.send_response(code)
        self.send_header("Content-Type", "text/plain; charset=utf-8")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        if send_body:
            self.wfile.write(body)

    def _respond_ok(self, send_body=True):
        self._respond(200, b"OK", send_body=send_body)

    def do_GET(self):
        req_path = self.path.split("?", 1)[0]
        if req_path in ("/", "/health", "/healthz"):
            self._respond_ok(True)
        else:
            self._respond(404, b"Not Found", True)

    def do_HEAD(self):
        req_path = self.path.split("?", 1)[0]
        if req_path in ("/", "/health", "/healthz"):
            self._respond_ok(False)
        else:
            self._respond(404, b"Not Found", False)

    def do_POST(self):
        req_path = self.path.split("?", 1)[0]
        if req_path != _expected_webhook_path():
            self.close_connection = True
            self._respond(404, b"Not Found", True)
            return

        # 1. Криптографическая проверка секрета Telegram Webhook до чтения тела запроса
        if not WEBHOOK_SECRET:
            self.close_connection = True
            self._respond(503, b"Webhook secret not configured", True)
            return
        got_secret = (self.headers.get("X-Telegram-Bot-Api-Secret-Token") or "").strip()
        if not got_secret or not hmac.compare_digest(got_secret.encode("utf-8"), WEBHOOK_SECRET.encode("utf-8")):
            self.close_connection = True
            self._respond(403, b"Forbidden", True)
            return

        # 2. Защита от OOM и некорректного Content-Length / Content-Type
        ctype = (self.headers.get("Content-Type") or "").lower()
        if "application/json" not in ctype:
            self.close_connection = True
            self._respond(415, b"Unsupported Media Type", True)
            return

        raw_len = self.headers.get("Content-Length")
        if raw_len is None:
            self.close_connection = True
            self._respond(411, b"Length Required", True)
            return
        try:
            length = int(raw_len)
        except ValueError:
            self.close_connection = True
            self._respond(400, b"Bad Request", True)
            return

        if length <= 0 or length > MAX_WEBHOOK_BODY_BYTES:
            self.close_connection = True
            self._respond(413 if length > MAX_WEBHOOK_BODY_BYTES else 400, b"Payload Invalid", True)
            return

        # 3. Ограничение параллельных воркеров от исчерпания потоков
        if not _WEBHOOK_SEMAPHORE.acquire(blocking=False):
            self._respond(429, b"Too Many Requests", True)
            return

        try:
            raw_body = self.rfile.read(length)
            try:
                update = json.loads(raw_body.decode("utf-8"))
            except (UnicodeDecodeError, json.JSONDecodeError):
                self._respond(400, b"Bad JSON", True)
                return
            process_update(update)
            self._respond_ok(True)
        except Exception as e:
            print("[Webhook] Ошибка обработки входящего POST-запроса:", _redact_secrets(e))
            try:
                self._respond(500, b"Internal Error", True)
            except Exception:
                pass
        finally:
            _WEBHOOK_SEMAPHORE.release()

    def log_message(self, format, *args):
        return


def start_healthcheck_server():
    port = int(os.getenv("PORT") or 8080)
    server = http.server.ThreadingHTTPServer(("0.0.0.0", port), _HealthCheckHandler)
    server.daemon_threads = True
    t = threading.Thread(target=server.serve_forever, name="CloudRunWebhookServer", daemon=True)
    t.start()
    print(f"[Server] HTTP/Webhook server listening on 0.0.0.0:{port} (path={_expected_webhook_path()})")
    return server


def _require_webhook_secret():
    if not WEBHOOK_SECRET or not re.fullmatch(r"[A-Za-z0-9_-]{1,256}", WEBHOOK_SECRET):
        raise RuntimeError(
            "WEBHOOK_SECRET не задан или содержит недопустимые символы! "
            "Задайте WEBHOOK_SECRET (символы A-Z, a-z, 0-9, _ и -) в переменных окружения Render или в локальном .env."
        )


def main():
    import sys
    if not TOKEN:
        raise RuntimeError(
            "BOT_TOKEN не найден! Задайте переменную окружения BOT_TOKEN (в Render / Cloud Run) или создайте локальный .env."
        )

    if "--netlify" in sys.argv:
        _require_webhook_secret()
        setup_bot_profile()
        webhook_url = f"{WEBAPP_URL}/.netlify/functions/bot"
        res = call(
            "setWebhook",
            url=webhook_url,
            secret_token=WEBHOOK_SECRET,
            allowed_updates=["message", "callback_query", "pre_checkout_query"],
        )
        print(f"🍪 Профиль настроен! Бот работает 24/7 через облако Netlify: {webhook_url}")
        print("Статус Webhook:", res.get("description", "OK"))
        return

    # Запускаем веб-сервер на 0.0.0.0:$PORT сразу при старте для прохождения проверок Render / Google Cloud Run
    start_healthcheck_server()
    setup_bot_profile()
    admin_poker_bot.start_duel_listener(call, WEBAPP_URL)

    webhook_url = resolve_webhook_url()
    if webhook_url and "--local" not in sys.argv:
        _require_webhook_secret()
        res = call(
            "setWebhook",
            url=webhook_url,
            secret_token=WEBHOOK_SECRET,
            allowed_updates=["message", "callback_query", "pre_checkout_query"],
        )
        print(f"🍪 Бот ОРЕО запущен в защищённом режиме Webhook: {webhook_url}")
        print("Статус Webhook:", res.get("description", "OK"))
        while True:
            time.sleep(3600)

    call("deleteWebhook")
    offset = 0
    print("🍪 Бот ОРЕО запущен в режиме Long Polling (HTTP healthcheck активен)! Ctrl+C — остановить.")
    while True:
        try:
            updates = call("getUpdates", offset=offset, timeout=60).get("result", [])
        except Exception as e:
            print("Ошибка сети:", _redact_secrets(e))
            time.sleep(3)
            continue
        for u in updates:
            if isinstance(u, dict) and isinstance(u.get("update_id"), int):
                offset = u["update_id"] + 1
                process_update(u)


if __name__ == "__main__":
    main()
