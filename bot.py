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
ADMIN_ID = int(os.getenv("ADMIN_ID") or os.getenv("ADMIN_USER_ID") or str(admin_poker_bot.ADMIN_ID))


def _normalize_webapp_base(raw_url: str) -> str:
    u = (raw_url or "https://pavelpastuhoff.github.io/oreo-tap/").strip()
    parsed = urllib.parse.urlsplit(u)
    path = parsed.path or "/"
    if not path.endswith("/") and not path.endswith(".html"):
        path = f"{path}/"
    return urllib.parse.urlunsplit((parsed.scheme, parsed.netloc, path, "", ""))


WEBAPP_URL = _normalize_webapp_base(os.getenv("WEBAPP_URL") or "https://pavelpastuhoff.github.io/oreo-tap/")
APP_VERSION = (os.getenv("APP_VERSION") or "20261108").strip()


def build_webapp_url(**params) -> str:
    q = {k: v for k, v in params.items() if v is not None and v != ""}
    if APP_VERSION:
        q.setdefault("v", APP_VERSION)
    if not q:
        return WEBAPP_URL
    return f"{WEBAPP_URL}?{urllib.parse.urlencode(q)}"


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
MAX_AVATAR_BYTES = 2 * 1024 * 1024  # 2 MB
_WEBHOOK_SEMAPHORE = threading.BoundedSemaphore(32)
_AVATAR_CACHE_LOCK = threading.Lock()
_AVATAR_CACHE = {}  # {uid_str: (expires_ts, bytes_or_none, content_type)}
_TOKEN_RE = re.compile(r"[0-9]{8,12}:[A-Za-z0-9_-]{30,50}")

STAR_PACKS = {
    "magnat": {
        "title": "Пакет «Магнат ОРЕО»",
        "description": "+100 ОРЕО-Кристаллов 💎 и +250 000 печенько-коинов 🪙",
        "stars": 99,
        "payload": "pack_magnat_100gems_250k",
        "legacy_payloads": ("pack_magnat_100gems_25k",),
    },
    "vip_energy": {
        "title": "VIP Безлимитная Энергия ♾️",
        "description": "Энергия никогда не заканчивается — тапай ОРЕО без лимитов!",
        "stars": 75,
        "payload": "pack_vip_energy",
        "legacy_payloads": (),
    },
    "gold_case": {
        "title": "Золотой VIP-Кейс Магната 🏆",
        "description": "50% шанс на Легендарный Золотой ОРЕО и 20% на Дима Твикс Cosmic!",
        "stars": 49,
        "payload": "pack_gold_case",
        "legacy_payloads": (),
    },
}


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
            menu_button={"type": "web_app", "text": "🍪 Играть", "web_app": {"url": build_webapp_url()}},
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


def handle_pre_checkout_query(pcq):
    if not isinstance(pcq, dict) or not pcq.get("id"):
        return
    pcq_user = pcq.get("from") or {}
    if pcq_user.get("id"):
        admin_poker_bot.ensure_chat_id_registered(pcq_user.get("id"), user=pcq_user)
    raw_payload = str(pcq.get("invoice_payload") or "")
    payload_prefix = raw_payload.split(":", 1)[0]
    matched_pack = None
    for pack in STAR_PACKS.values():
        if payload_prefix == pack["payload"] or payload_prefix in pack.get("legacy_payloads", ()):
            matched_pack = pack
            break
    try:
        total_amount = int(pcq.get("total_amount") or 0)
    except (TypeError, ValueError):
        total_amount = -1
    is_valid = (
        pcq.get("currency") == "XTR"
        and matched_pack is not None
        and total_amount == matched_pack["stars"]
    )
    call(
        "answerPreCheckoutQuery",
        pre_checkout_query_id=pcq["id"],
        ok=is_valid,
        error_message=None if is_valid else "Некорректные параметры счёта. Попробуйте создать заказ заново.",
    )


def handle_message(msg):
    if not isinstance(msg, dict):
        return
    chat_id = (msg.get("chat") or {}).get("id")
    if not chat_id:
        return
    user = msg.get("from") or msg.get("from_user") or {}
    admin_poker_bot.register_bot_user(user if isinstance(user, dict) else {"id": getattr(user, "id", chat_id)}, chat_id=chat_id)
    if msg.get("successful_payment"):
        call(
            "sendMessage",
            chat_id=chat_id,
            text=(
                "🎉 <b>Оплата через Telegram Stars прошла успешно!</b>\n"
                "Твои 💎 ОРЕО-Кристаллы и бонусы уже зачислены в игру!"
            ),
            parse_mode="HTML",
        )
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

    app_url = build_webapp_url(ref=ref_param)
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
    app_url = build_webapp_url()

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
        if "pre_checkout_query" in u:
            handle_pre_checkout_query(u["pre_checkout_query"])
        elif "message" in u:
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


def _fetch_telegram_avatar(uid_str: str):
    now = time.time()
    with _AVATAR_CACHE_LOCK:
        cached = _AVATAR_CACHE.get(uid_str)
        if cached and cached[0] > now:
            return cached[1], cached[2]

    img_bytes = None
    content_type = "image/jpeg"
    try:
        photos_res = call("getUserProfilePhotos", user_id=int(uid_str), limit=1)
        photos = ((photos_res or {}).get("result") or {}).get("photos") or []
        if photos and photos[0]:
            chosen = photos[0][1] if len(photos[0]) > 1 else photos[0][0]
            file_id = chosen.get("file_id")
            if file_id:
                file_res = call("getFile", file_id=file_id)
                file_path = ((file_res or {}).get("result") or {}).get("file_path") or ""
                if file_path and ".." not in file_path and not file_path.startswith("/"):
                    safe_path = urllib.parse.quote(file_path, safe="/")
                    file_url = f"https://api.telegram.org/file/bot{TOKEN}/{safe_path}"
                    with urllib.request.urlopen(file_url, timeout=10) as resp:
                        data = resp.read(MAX_AVATAR_BYTES + 1)
                        if len(data) <= MAX_AVATAR_BYTES and data:
                            img_bytes = data
                            guessed = mimetypes.guess_type(file_path)[0]
                            if guessed and guessed.startswith("image/"):
                                content_type = guessed
    except Exception:
        img_bytes = None

    ttl = 3600.0 if img_bytes is not None else 600.0
    with _AVATAR_CACHE_LOCK:
        if len(_AVATAR_CACHE) >= 256:
            _AVATAR_CACHE.clear()
        _AVATAR_CACHE[uid_str] = (now + ttl, img_bytes, content_type)
    return img_bytes, content_type


def _resolve_cors_origin(request_origin: str) -> str:
    parsed_webapp = urllib.parse.urlsplit(WEBAPP_URL)
    default_origin = f"{parsed_webapp.scheme}://{parsed_webapp.netloc}" if parsed_webapp.netloc else "*"
    orig = (request_origin or "").strip()
    if not orig:
        return default_origin
    parsed = urllib.parse.urlsplit(orig)
    host = (parsed.hostname or "").lower()
    if (
        orig == default_origin
        or host.endswith(".github.io")
        or host in ("localhost", "127.0.0.1")
    ):
        return orig
    return default_origin


class _HealthCheckHandler(http.server.BaseHTTPRequestHandler):
    timeout = 10

    def _cors_headers(self) -> dict:
        allow_origin = _resolve_cors_origin(self.headers.get("Origin") or "")
        return {
            "Access-Control-Allow-Origin": allow_origin,
            "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
            "Access-Control-Allow-Headers": "Content-Type, X-Telegram-Init-Data",
            "Cross-Origin-Resource-Policy": "cross-origin",
            "Vary": "Origin",
        }

    def _respond(
        self,
        code: int,
        body: bytes,
        send_body: bool = True,
        content_type: str = "text/plain; charset=utf-8",
        extra_headers: dict = None,
    ):
        self.send_response(code)
        self.send_header("Content-Type", content_type)
        self.send_header("X-Content-Type-Options", "nosniff")
        if extra_headers:
            for k, v in extra_headers.items():
                self.send_header(k, v)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        if send_body:
            self.wfile.write(body)

    def _respond_ok(self, send_body=True):
        self._respond(200, b"OK", send_body=send_body)

    def _handle_bot_api(self, query_str: str, send_body: bool = True, body_data: dict = None):
        cors = self._cors_headers()
        qs = urllib.parse.parse_qs(query_str, keep_blank_values=True)
        payload = body_data if isinstance(body_data, dict) else {}

        def _param(name: str, default: str = "") -> str:
            if name in payload and payload[name] is not None and not isinstance(payload[name], (dict, list)):
                return str(payload[name]).strip()
            vals = qs.get(name)
            if vals:
                return str(vals[0]).strip()
            return default

        action = _param("action")

        api_uid = _param("user_id") or _param("chat_id")
        api_user_dict = None
        if not re.fullmatch(r"\d{5,15}", api_uid):
            init_data_raw = (self.headers.get("X-Telegram-Init-Data") or "").strip()
            if init_data_raw:
                try:
                    init_qs = urllib.parse.parse_qs(init_data_raw, keep_blank_values=True)
                    user_json_str = (init_qs.get("user") or [""])[0]
                    if user_json_str:
                        parsed_u = json.loads(user_json_str)
                        if isinstance(parsed_u, dict) and parsed_u.get("id"):
                            if not api_uid:
                                api_uid = str(parsed_u["id"]).strip()
                            api_user_dict = parsed_u
                except Exception:
                    pass
        if re.fullmatch(r"\d{5,15}", api_uid):
            admin_poker_bot.ensure_chat_id_registered(api_uid, user=api_user_dict)

        if action == "buy_track":
            uid = _param("user_id") or api_uid
            track_id = _param("track_id")
            price_raw = _param("price", "0")
            meta = payload.get("meta") if isinstance(payload.get("meta"), dict) else {}
            if not meta:
                meta = {
                    "title": _param("title"),
                    "artist": _param("artist"),
                    "genre": _param("genre"),
                    "audio_url": _param("audio_url"),
                    "cover": _param("cover"),
                }
            res_dict = admin_poker_bot.buy_music_track(uid, track_id, price_raw, meta=meta)
            status_code = 200 if res_dict.get("ok") else (400 if res_dict.get("error", "").startswith("invalid") else 402 if res_dict.get("error") == "insufficient_coins" else 422)
            # Возвращаем 200 для штатных игровых ответов (insufficient_coins), чтобы fetch на клиенте читал JSON без консольных ошибок, и 400 для битых запросов
            if res_dict.get("error") in ("insufficient_coins", "player_not_found"):
                status_code = 200
            out_bytes = json.dumps(res_dict, ensure_ascii=False).encode("utf-8")
            self._respond(status_code, out_bytes, send_body, "application/json; charset=utf-8", cors)
            return

        if action == "order_jukebox":
            uid = _param("user_id") or api_uid
            room_type = _param("room_type", "poker")
            room_id = _param("room_id")
            track_id = _param("track_id", "track")
            track_url = _param("track_url") or _param("current_track_url")
            track_title = _param("track_title") or _param("title")
            track_artist = _param("track_artist") or _param("artist")
            ordered_by = _param("ordered_by")
            res_dict = admin_poker_bot.order_table_jukebox(
                user_id=uid,
                room_type=room_type,
                room_id=room_id,
                track_id=track_id,
                track_url=track_url,
                track_title=track_title,
                track_artist=track_artist,
                ordered_by=ordered_by,
            )
            status_code = 200
            if not res_dict.get("ok") and str(res_dict.get("error", "")).startswith("invalid"):
                status_code = 400
            out_bytes = json.dumps(res_dict, ensure_ascii=False).encode("utf-8")
            self._respond(status_code, out_bytes, send_body, "application/json; charset=utf-8", cors)
            return

        if action == "owl_check":
            self._respond(200, b'{"ok":true}', send_body, "application/json; charset=utf-8", cors)
            return

        if not TOKEN:
            self._respond(503, b'{"ok":false}', send_body, "application/json; charset=utf-8", cors)
            return

        if action == "avatar":
            raw_uid = (qs.get("user_id") or [""])[0].strip()
            if not re.fullmatch(r"\d{5,15}", raw_uid):
                self._respond(400, b"", send_body, "text/plain; charset=utf-8", cors)
                return
            img_bytes, ctype = _fetch_telegram_avatar(raw_uid)
            if not img_bytes:
                self._respond(404, b"", send_body, "text/plain; charset=utf-8", cors)
                return
            hdrs = dict(cors)
            hdrs["Cache-Control"] = "public, max-age=3600"
            self._respond(200, img_bytes, send_body, ctype, hdrs)
            return

        if action == "invoice":
            pack_key = (qs.get("pack") or ["magnat"])[0].strip()
            pack = STAR_PACKS.get(pack_key) or STAR_PACKS["magnat"]
            raw_uid = (qs.get("user_id") or [""])[0].strip()
            clean_uid = raw_uid if re.fullmatch(r"\d{5,15}", raw_uid) else "anon"
            try:
                inv = call(
                    "createInvoiceLink",
                    title=pack["title"],
                    description=pack["description"],
                    payload=f"{pack['payload']}:{clean_uid}",
                    provider_token="",
                    currency="XTR",
                    prices=[{"label": pack["title"], "amount": pack["stars"]}],
                )
                payload_json = json.dumps(
                    {"ok": bool(inv and inv.get("ok")), "result": (inv or {}).get("result")},
                    ensure_ascii=False,
                ).encode("utf-8")
                self._respond(200, payload_json, send_body, "application/json; charset=utf-8", cors)
            except Exception as e:
                print("[API] Ошибка создания счёта Stars:", _redact_secrets(e))
                self._respond(502, b'{"ok":false,"result":null}', send_body, "application/json; charset=utf-8", cors)
            return

        self._respond(404, b'{"ok":false}', send_body, "application/json; charset=utf-8", cors)

    def do_OPTIONS(self):
        req_path = self.path.split("?", 1)[0]
        if req_path in ("/api/bot", "/.netlify/functions/bot"):
            self._respond(204, b"", False, "text/plain; charset=utf-8", self._cors_headers())
        else:
            self._respond(404, b"", False)

    def do_GET(self):
        parts = self.path.split("?", 1)
        req_path = parts[0]
        query_str = parts[1] if len(parts) > 1 else ""
        if req_path in ("/", "/health", "/healthz"):
            self._respond_ok(True)
        elif req_path in ("/api/bot", "/.netlify/functions/bot"):
            self._handle_bot_api(query_str, True)
        else:
            self._respond(404, b"Not Found", True)

    def do_HEAD(self):
        parts = self.path.split("?", 1)
        req_path = parts[0]
        query_str = parts[1] if len(parts) > 1 else ""
        if req_path in ("/", "/health", "/healthz"):
            self._respond_ok(False)
        elif req_path in ("/api/bot", "/.netlify/functions/bot"):
            self._handle_bot_api(query_str, False)
        else:
            self._respond(404, b"Not Found", False)

    def do_POST(self):
        parts = self.path.split("?", 1)
        req_path = parts[0]
        query_str = parts[1] if len(parts) > 1 else ""

        if req_path in ("/api/bot", "/.netlify/functions/bot"):
            cors = self._cors_headers()
            raw_len = self.headers.get("Content-Length")
            if raw_len is None:
                self._respond(411, b'{"ok":false,"error":"length_required"}', True, "application/json; charset=utf-8", cors)
                return
            try:
                length = int(raw_len)
            except ValueError:
                self._respond(400, b'{"ok":false,"error":"bad_length"}', True, "application/json; charset=utf-8", cors)
                return
            if length < 0 or length > 32768:
                self._respond(413 if length > 32768 else 400, b'{"ok":false,"error":"payload_invalid"}', True, "application/json; charset=utf-8", cors)
                return
            body_dict = {}
            if length > 0:
                raw_body = self.rfile.read(length)
                try:
                    parsed = json.loads(raw_body.decode("utf-8"))
                    if isinstance(parsed, dict):
                        body_dict = parsed
                except Exception:
                    self._respond(400, b'{"ok":false,"error":"invalid_json"}', True, "application/json; charset=utf-8", cors)
                    return
            self._handle_bot_api(query_str, True, body_data=body_dict)
            return

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
