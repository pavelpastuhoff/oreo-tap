"""Модуль эксклюзивного Админ-пульта и P2P-системы вызовов 1v1 (Берёзовый Покер & Берёзовые Шахматы).

Интегрируется с bot.py и Firebase Realtime Database.
"""
import asyncio
from datetime import datetime, timezone
import html
import json
import math
import os
import re
import sys
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid

ADMIN_ID = int(os.getenv("ADMIN_ID") or os.getenv("ADMIN_USER_ID") or "594228143")
MY_USER_ID = ADMIN_ID
FIREBASE_DB_URL = (
    os.getenv("FIREBASE_DB_URL")
    or "https://oreo-tap-default-rtdb.europe-west1.firebasedatabase.app"
).rstrip("/")
PAVEL_BANK_DEFAULT = 433763254656000000
MAX_SAFE_AMOUNT = 1_000_000_000_000_000
PLAYERS_PAGE_SIZE = 6

# Состояния диалогов в памяти: {user_id_int: {"mode": str, ...}}
_user_states = {}
_duel_listener_started = False
_duel_sync_lock = threading.Lock()
_last_duel_sync_ts = 0.0
_TOKEN_RE = re.compile(r"[0-9]{8,12}:[A-Za-z0-9_-]{30,50}")


def _redact_err(val) -> str:
    text = str(val or "")
    raw_tok = os.getenv("BOT_TOKEN")
    tok = raw_tok.strip() if raw_tok else ""
    if tok:
        text = text.replace(tok, "[REDACTED_BOT_TOKEN]")
    return _TOKEN_RE.sub("[REDACTED_BOT_TOKEN]", text)


def _fb_key(val) -> str:
    s = str(val or "").strip()
    if not s or s in (".", "..") or any(ch in s for ch in ("/", "\\", "$", "#", "[", "]", "\x00")):
        raise ValueError("Invalid Firebase key")
    return urllib.parse.quote(s, safe="")


def _parse_safe_int(raw, min_val=None, max_val=MAX_SAFE_AMOUNT) -> int:
    cleaned = str(raw or "").strip().replace(" ", "").replace("_", "").replace(",", "")
    fval = float(cleaned)
    if not math.isfinite(fval):
        raise ValueError("Non-finite number")
    ival = int(round(fval))
    if min_val is not None and ival < min_val:
        ival = min_val
    if max_val is not None and ival > max_val:
        ival = max_val
    return ival

RESOURCE_META = {
    "coins": {"label": "🪙 Коины", "field": "coins", "unit": "🪙"},
    "gems": {"label": "💎 Алмазики", "field": "gems", "unit": "💎"},
    "energy": {"label": "⚡ Энергия", "field": "energy", "unit": "⚡"},
    "sticks": {"label": "🪵 Палочки", "field": "sticks", "unit": "🪵"},
}

GAME_META = {
    "poker": {"title": "🃏 Берёзовый Покер 1v1", "short": "Покер"},
    "chess": {"title": "♟ Берёзовые Шахматы", "short": "Шахматы"},
}

VIKA_USER_ID = "1582574743"

EXCLUSIVE_SKINS = {
    "shushik": {
        "id": "shushik",
        "title": "🌹 Шушик",
        "rarity": "Легендарный VIP-эксклюзив",
        "dm_text": (
            "🌹✨ <b>ЭКСКЛЮЗИВНЫЙ ПОДАРОК ВЫСШЕГО УРОВНЯ!</b>\n\n"
            "Вам открыт самый редкий и роскошный скин в ОРЕО67 — <b>«🌹 Шушик»</b>!\n"
            "• 🖤 Чёрный бархат в обрамлении алых роз с каплями росы\n"
            "• 🐱 Серебряно-платиновая маска с кошачьими ушками и неоновым свечением\n"
            "• ❤️‍🔥 Веер алых сердец, роз и вечерняя атмосфера при каждом касании!\n\n"
            "👇 Заходите в игру, чтобы примерить легенду прямо сейчас!"
        ),
    },
    "airochai": {
        "id": "airochai",
        "title": "🍵 Айрочай",
        "rarity": "Премиум Чайная Коллекция",
        "dm_text": (
            "🍵🏮 <b>НОВЫЙ ПРЕМИУМ-СКИН РАЗБЛОКИРОВАН!</b>\n\n"
            "На ваш аккаунт выдан фирменный скин <b>«🍵 Айрочай (HONG KONG TEA 茶)»</b>!\n"
            "• Выдержанный чайный блин Шу Пуэра, красные фонарики и бамбуковая шкала энергии!\n\n"
            "👇 Откройте игру и активируйте новый стиль!"
        ),
    },
    "denis_lykasov": {
        "id": "denis_lykasov",
        "title": "🎬 Денис Лыкасов",
        "rarity": "Кино-эксклюзив Director's Cut",
        "dm_text": (
            "🎬👑 <b>КАМЕРА! МОТОР! СКИН РАЗБЛОКИРОВАН!</b>\n\n"
            "Вам выдан эксклюзивный кино-скин <b>«🎬 Денис Лыкасов»</b>!\n"
            "• Кинохлопушка 35mm, неоновый титр с короной и таймлайн Premiere Pro RENDERING!\n\n"
            "👇 Врывайтесь в кадр прямо сейчас!"
        ),
    },
}


def is_admin(user_id) -> bool:
    try:
        return int(user_id) == MY_USER_ID
    except (ValueError, TypeError):
        return False


def fmt_num(val) -> str:
    try:
        f = float(val)
        if not math.isfinite(f):
            return "0"
        n = int(round(f))
        return f"{n:,}".replace(",", " ")
    except (ValueError, TypeError, OverflowError):
        return "0"


def fb_request(path: str, method: str = "GET", data=None):
    url = f"{FIREBASE_DB_URL}/{path.lstrip('/')}.json"
    body = None
    headers = {"Content-Type": "application/json"}
    if data is not None:
        body = json.dumps(data, ensure_ascii=False).encode("utf-8")
    req = urllib.request.Request(url, data=body, headers=headers, method=method)
    try:
        with urllib.request.urlopen(req, timeout=15) as resp:
            raw = resp.read().decode("utf-8")
            return json.loads(raw) if raw else None
    except Exception as e:
        print(f"[Firebase {method} {path}] Ошибка:", _redact_err(e))
        return None


def fb_get(path: str):
    return fb_request(path, "GET")


def fb_put(path: str, data):
    return fb_request(path, "PUT", data)


def fb_patch(path: str, data):
    return fb_request(path, "PATCH", data)


def get_all_players() -> list:
    raw = fb_get("players") or {}
    players = []
    if isinstance(raw, dict):
        for uid, pdata in raw.items():
            if not isinstance(pdata, dict):
                continue
            pid = str(pdata.get("id") or uid)
            players.append(
                {
                    "id": pid,
                    "name": str(pdata.get("name") or f"Игрок {pid}"),
                    "username": str(pdata.get("username") or ""),
                    "coins": int(float(pdata.get("coins") or 0)),
                    "gems": int(float(pdata.get("gems") or 0)),
                    "energy": int(float(pdata.get("energy") or 500)),
                    "sticks": int(float(pdata.get("sticks") or 0)),
                    "ts": int(float(pdata.get("ts") or 0)),
                }
            )
    players.sort(key=lambda x: (x["coins"], x["ts"]), reverse=True)
    return players


def get_player(uid: str) -> dict:
    uid = str(uid)
    try:
        safe_uid = _fb_key(uid)
        data = fb_get(f"players/{safe_uid}")
    except ValueError:
        data = None
    if not isinstance(data, dict):
        data = {"id": uid, "name": f"Игрок {uid}", "coins": 0, "gems": 5, "energy": 500, "sticks": 0}
    return {
        "id": str(data.get("id") or uid),
        "name": str(data.get("name") or f"Игрок {uid}"),
        "username": str(data.get("username") or ""),
        "coins": int(float(data.get("coins") or 0)),
        "gems": int(float(data.get("gems") or 0)),
        "energy": int(float(data.get("energy") or 500)),
        "sticks": int(float(data.get("sticks") or 0)),
        "adminResetId": int(float(data.get("adminResetId") or 0)),
    }


class BotWasBlocked(Exception):
    """Исключение при блокировке бота пользователем (403 Forbidden) или удалении аккаунта."""


USERS_REGISTRY_FILE = os.path.join(os.path.dirname(os.path.abspath(__file__)), "users_registry.json")
_REGISTRY_LOCK = threading.Lock()
_API_SEEN_CHAT_IDS = set()


def _load_local_registry() -> dict:
    """Читает локальный реестр chat_id пользователей (резервное хранилище рядом с Firebase)."""
    if not os.path.isfile(USERS_REGISTRY_FILE):
        return {}
    try:
        with open(USERS_REGISTRY_FILE, "r", encoding="utf-8") as f:
            data = json.load(f)
            return data if isinstance(data, dict) else {}
    except Exception:
        return {}


def _save_local_registry(registry: dict):
    try:
        with open(USERS_REGISTRY_FILE, "w", encoding="utf-8") as f:
            json.dump(registry, f, ensure_ascii=False, indent=2)
    except Exception:
        pass


def _record_local_chat_id(chat_id: int, active: bool = True, user: dict = None):
    key = str(chat_id)
    now_ms = int(time.time() * 1000)
    with _REGISTRY_LOCK:
        reg = _load_local_registry()
        entry = reg.get(key) if isinstance(reg.get(key), dict) else {}
        entry["chat_id"] = int(chat_id)
        entry["active"] = bool(active)
        entry["updatedAt"] = now_ms
        if user and isinstance(user, dict):
            if user.get("first_name"):
                entry["name"] = str(user["first_name"])[:64]
            if user.get("username") is not None:
                entry["username"] = str(user.get("username") or "")[:64]
        reg[key] = entry
        _save_local_registry(reg)


def register_bot_user(user: dict, chat_id=None):
    """Сохраняет chat_id и профиль пользователя в базу Firebase (players/{uid}) и локальный реестр."""
    raw_uid = (user or {}).get("id") or chat_id
    if not raw_uid:
        return
    uid = str(raw_uid).strip()
    try:
        safe_uid = _fb_key(uid)
    except ValueError:
        return

    resolved_chat = chat_id if chat_id is not None else raw_uid
    try:
        cid_int = int(resolved_chat)
    except (ValueError, TypeError):
        cid_int = int(uid) if uid.lstrip("-").isdigit() else None

    if cid_int is not None and cid_int > 0:
        _record_local_chat_id(cid_int, active=True, user=user)
        _API_SEEN_CHAT_IDS.add(cid_int)

    first_name = str((user or {}).get("first_name") or "Тапер")[:64]
    username = str((user or {}).get("username") or "")[:64]
    now_ms = int(time.time() * 1000)
    existing = fb_get(f"players/{safe_uid}")
    patch = {
        "id": uid,
        "name": first_name,
        "username": username,
        "lastBotSeen": now_ms,
        "botActive": True,
        "botBlocked": False,
    }
    if cid_int is not None and cid_int > 0:
        patch["chat_id"] = cid_int
    if not isinstance(existing, dict):
        patch.update({"coins": 0, "gems": 5, "energy": 500, "sticks": 0, "ts": now_ms})
    fb_patch(f"players/{safe_uid}", patch)


def ensure_chat_id_registered(chat_id, user: dict = None):
    """Легковесная регистрация chat_id при первом взаимодействии с WebApp/API."""
    try:
        cid_int = int(str(chat_id).strip())
    except (ValueError, TypeError):
        return
    if cid_int <= 0 or cid_int in _API_SEEN_CHAT_IDS:
        return
    _API_SEEN_CHAT_IDS.add(cid_int)
    _record_local_chat_id(cid_int, active=True, user=user)

    def _bg_sync():
        try:
            safe_uid = _fb_key(str(cid_int))
            now_ms = int(time.time() * 1000)
            existing = fb_get(f"players/{safe_uid}")
            patch = {
                "id": str(cid_int),
                "chat_id": cid_int,
                "lastBotSeen": now_ms,
            }
            if not isinstance(existing, dict):
                patch.update({
                    "name": str((user or {}).get("first_name") or f"Игрок {cid_int}")[:64],
                    "username": str((user or {}).get("username") or "")[:64],
                    "coins": 0,
                    "gems": 5,
                    "energy": 500,
                    "sticks": 0,
                    "ts": now_ms,
                    "botActive": True,
                    "botBlocked": False,
                })
            elif existing.get("botActive") is None:
                patch["botActive"] = True
                patch["botBlocked"] = False
            fb_patch(f"players/{safe_uid}", patch)
        except Exception:
            pass

    threading.Thread(target=_bg_sync, name=f"RegChatId_{cid_int}", daemon=True).start()


def mark_user_inactive(chat_id):
    """Помечает пользователя как неактивного (заблокировал бота или удалил аккаунт)."""
    try:
        cid_int = int(chat_id)
    except (ValueError, TypeError):
        return
    _record_local_chat_id(cid_int, active=False)
    try:
        safe_uid = _fb_key(str(cid_int))
        fb_patch(
            f"players/{safe_uid}",
            {
                "botActive": False,
                "botBlocked": True,
                "botBlockedAt": int(time.time() * 1000),
            },
        )
    except Exception:
        pass


def get_broadcast_chat_ids() -> list:
    """Возвращает список всех активных chat_id из базы Firebase и локального реестра."""
    chat_ids = []
    seen = set()
    blocked_ids = set()

    with _REGISTRY_LOCK:
        local_reg = _load_local_registry()

    for raw_k, info in local_reg.items():
        if isinstance(info, dict) and info.get("active") is False:
            try:
                blocked_ids.add(int(info.get("chat_id") or raw_k))
            except (ValueError, TypeError):
                pass

    raw_players = fb_get("players") or {}
    if isinstance(raw_players, dict):
        for uid, pdata in raw_players.items():
            if not isinstance(pdata, dict):
                continue
            raw_cid = pdata.get("chat_id") or pdata.get("chatId") or pdata.get("id") or uid
            try:
                cid = int(str(raw_cid).strip())
            except (ValueError, TypeError):
                continue
            if cid <= 0:
                continue
            if pdata.get("botBlocked") is True or pdata.get("botActive") is False:
                blocked_ids.add(cid)
                continue
            if cid not in seen and cid not in blocked_ids:
                seen.add(cid)
                chat_ids.append(cid)

    for raw_k, info in local_reg.items():
        if not isinstance(info, dict) or info.get("active") is False:
            continue
        try:
            cid = int(info.get("chat_id") or raw_k)
        except (ValueError, TypeError):
            continue
        if cid > 0 and cid not in seen and cid not in blocked_ids:
            seen.add(cid)
            chat_ids.append(cid)

    return chat_ids


def _detect_broadcast_parse_mode(text: str) -> str:
    """Определяет режим форматирования (HTML или Markdown) для рассылки."""
    if re.search(r"</?(?:b|strong|i|em|u|ins|s|strike|del|a|code|pre|blockquote|tg-spoiler)\b", text, re.IGNORECASE):
        return "HTML"
    if re.search(r"(\*\*[^*]+\*\*|\*[^*\n]+\*|`[^`\n]+`|\[[^\]]+\]\([^)]+\))", text):
        return "Markdown"
    return "HTML"


def build_broadcast_keyboard(webapp_url: str) -> dict:
    """Формирует Inline-кнопку призыва к действию (Call to Action) со ссылкой на WebApp."""
    return {
        "inline_keyboard": [
            [{"text": "🚀 Залететь в игру", "web_app": {"url": webapp_url}}],
        ]
    }


def _send_broadcast_to_user(chat_id: int, text: str, parse_mode: str, reply_markup: dict, call_fn):
    """Отправляет сообщение одному пользователю с обработкой ошибок форматирования и блокировок."""
    try:
        res = call_fn(
            "sendMessage",
            chat_id=int(chat_id),
            text=text,
            parse_mode=parse_mode,
            disable_web_page_preview=True,
            reply_markup=reply_markup,
        )
        if isinstance(res, dict) and res.get("ok") is False:
            raise BotWasBlocked(str(res.get("description") or "Telegram API error"))
        return res
    except urllib.error.HTTPError as http_err:
        err_body = ""
        try:
            err_body = http_err.read().decode("utf-8", errors="ignore")
        except Exception:
            pass
        lower_body = err_body.lower()
        # Если ошибка парсинга HTML/Markdown сущностей — отправляем чистым текстом, не помечая юзера заблокированным
        if http_err.code == 400 and "can't parse entities" in lower_body:
            res = call_fn(
                "sendMessage",
                chat_id=int(chat_id),
                text=text,
                disable_web_page_preview=True,
                reply_markup=reply_markup,
            )
            if isinstance(res, dict) and res.get("ok") is False:
                raise BotWasBlocked(str(res.get("description") or "Telegram API error"))
            return res
        if http_err.code in (403, 400, 404) or any(
            marker in lower_body
            for marker in ("blocked", "deactivated", "chat not found", "user not found", "peer_id_invalid", "forbidden")
        ):
            raise BotWasBlocked(err_body or str(http_err)) from http_err
        raise


async def async_broadcast_messages(text: str, call_fn, webapp_url: str, admin_chat_id: int = None) -> tuple:
    """Асинхронный цикл рассылки с защитой от FloodWait (asyncio.sleep(0.05)) и обработкой BotWasBlocked."""
    chat_ids = get_broadcast_chat_ids()
    reply_markup = build_broadcast_keyboard(webapp_url)
    parse_mode = _detect_broadcast_parse_mode(text)

    sent_count = 0
    blocked_count = 0

    for cid in chat_ids:
        try:
            _send_broadcast_to_user(cid, text, parse_mode, reply_markup, call_fn)
            sent_count += 1
        except (BotWasBlocked, urllib.error.HTTPError, Exception) as err:
            print(f"[Broadcast {cid}] Ошибка доставки (пользователь помечен неактивным):", _redact_err(err))
            mark_user_inactive(cid)
            blocked_count += 1
        await asyncio.sleep(0.05)

    report_text = f"✅ Рассылка завершена! Доставлено: {sent_count}, Заблокировали бота: {blocked_count}."
    target_admin_chat = int(admin_chat_id) if admin_chat_id else ADMIN_ID
    try:
        call_fn(
            "sendMessage",
            chat_id=target_admin_chat,
            text=report_text,
            parse_mode="HTML",
        )
    except Exception as e:
        print("[Broadcast Report] Не удалось отправить отчёт админу:", _redact_err(e))

    return sent_count, blocked_count


def run_broadcast(text: str, call_fn, webapp_url: str, admin_chat_id: int = None) -> tuple:
    """Запускает асинхронную рассылку из синхронного обработчика."""
    coro = async_broadcast_messages(text, call_fn, webapp_url, admin_chat_id=admin_chat_id)
    try:
        loop = asyncio.get_running_loop()
    except RuntimeError:
        loop = None

    if loop and loop.is_running():
        result_box = []
        err_box = []

        def _runner():
            try:
                result_box.append(asyncio.run(coro))
            except Exception as exc:
                err_box.append(exc)

        t = threading.Thread(target=_runner, name="OreoBroadcastRunner", daemon=True)
        t.start()
        t.join()
        if err_box:
            raise err_box[0]
        return result_box[0] if result_box else (0, 0)

    return asyncio.run(coro)


def get_common_bank() -> int:
    data = fb_get("common_bank")
    if isinstance(data, dict) and data.get("coins") is not None:
        return int(float(data.get("coins") or 0))
    fb_put("common_bank", {"coins": PAVEL_BANK_DEFAULT, "sponsor": "Pavel", "updatedAt": int(time.time() * 1000)})
    return PAVEL_BANK_DEFAULT


def set_common_bank(new_amount: int) -> int:
    val = max(0, int(new_amount))
    fb_patch("common_bank", {"coins": val, "sponsor": "Pavel", "updatedAt": int(time.time() * 1000)})
    return val


def apply_resource_change(target_uid: str, res_key: str, mode: str, amount: int = 0) -> tuple:
    meta = RESOURCE_META.get(res_key, RESOURCE_META["coins"])
    field = meta["field"]
    p = get_player(target_uid)
    old_val = int(p.get(field, 0))
    now_ms = int(time.time() * 1000)

    if mode == "reset":
        new_val = 0
        delta = -old_val
    elif mode == "set":
        new_val = max(0, int(amount))
        delta = new_val - old_val
    else:
        delta = int(amount)
        new_val = max(0, old_val + delta)

    patch_data = {
        field: new_val,
        "ts": now_ms,
        "adminUpdatedAt": now_ms,
    }
    if field == "coins":
        patch_data["taps"] = new_val
        patch_data["count"] = new_val
        if mode == "reset":
            patch_data["adminResetId"] = int(p.get("adminResetId", 0)) + 1

    safe_uid = _fb_key(target_uid)
    fb_patch(f"players/{safe_uid}", patch_data)
    fb_put(
        f"admin_grants/{safe_uid}/{now_ms}",
        {
            "resource": res_key,
            "mode": mode,
            "delta": delta,
            "newValue": new_val,
            "ts": now_ms,
            "claimed": False,
        },
    )
    return old_val, new_val, delta


def decorate_main_keyboard(kb: dict, user_id, webapp_url: str) -> dict:
    rows = list((kb or {}).get("inline_keyboard", []))
    rows.append([{"text": "⚔️ Вызов 1v1 (Покер / Шахматы)", "callback_data": "duel_menu"}])
    if is_admin(user_id):
        rows.append([{"text": "👑 Админ-пульт", "callback_data": "adm_home"}])
    return {"inline_keyboard": rows}


def admin_home_text() -> str:
    bank = get_common_bank()
    players_cnt = len(get_all_players())
    return (
        "👑 <b>ЭКСКЛЮЗИВНЫЙ АДМИН-ПУЛЬТ ОРЕО</b>\n\n"
        f"👤 <b>Владелец:</b> <code>{MY_USER_ID}</code>\n"
        f"👥 <b>Игроков в базе Firebase:</b> <b>{players_cnt}</b>\n"
        f"🏦 <b>Общий банк турнира:</b> <b>{fmt_num(bank)} 🪙</b>\n\n"
        "Выберите действие ниже:"
    )


def admin_home_kb(webapp_url: str) -> dict:
    return {
        "inline_keyboard": [
            [{"text": "🎁 Выдать ресурсы игрокам", "callback_data": "adm_players:0"}],
            [{"text": "🎭 Управление скинами (Шушик / Айрочай / Денис)", "callback_data": "adm_skins_home"}],
            [{"text": "🃏 Создать турнир по покеру", "callback_data": "adm_tour_new"}],
            [{"text": "🏦 Управление Общим банком", "callback_data": "adm_bank"}],
            [{"text": "⚔️ Все активные дуэли 1v1", "callback_data": "adm_duels"}],
            [{"text": "🧯 Выгрузить краш-логи (.txt)", "callback_data": "adm_crashes"}],
            [{"text": "« В главное меню бота", "callback_data": "tab_home"}],
        ]
    }


def _resolve_bot_token() -> str:
    raw_token = os.getenv("BOT_TOKEN")
    if not raw_token or not raw_token.strip():
        raise RuntimeError("BOT_TOKEN не задан в переменных окружения!")
    return raw_token.strip()


def send_text_document(chat_id: int, filename: str, content_text: str, caption: str = "", reply_markup=None):
    """Отправляет сформированный .txt файл в Telegram через multipart/form-data."""
    token = _resolve_bot_token()
    api_url = f"https://api.telegram.org/bot{token}/sendDocument"
    boundary = f"----OreoCrashBoundary{uuid.uuid4().hex}"
    body = bytearray()

    fields = {"chat_id": str(chat_id), "parse_mode": "HTML"}
    if caption:
        fields["caption"] = caption
    if reply_markup is not None:
        fields["reply_markup"] = json.dumps(reply_markup, ensure_ascii=False)

    for k, v in fields.items():
        body.extend(f"--{boundary}\r\n".encode("utf-8"))
        body.extend(f'Content-Disposition: form-data; name="{k}"\r\n\r\n'.encode("utf-8"))
        body.extend(f"{v}\r\n".encode("utf-8"))

    file_bytes = content_text.encode("utf-8")
    body.extend(f"--{boundary}\r\n".encode("utf-8"))
    body.extend(f'Content-Disposition: form-data; name="document"; filename="{filename}"\r\n'.encode("utf-8"))
    body.extend(b"Content-Type: text/plain; charset=utf-8\r\n\r\n")
    body.extend(file_bytes)
    body.extend(f"\r\n--{boundary}--\r\n".encode("utf-8"))

    req = urllib.request.Request(
        api_url,
        data=bytes(body),
        headers={"Content-Type": f"multipart/form-data; boundary={boundary}"},
    )
    try:
        with urllib.request.urlopen(req, timeout=45) as resp:
            return json.load(resp)
    except Exception as e:
        print("[SendDocument] Ошибка отправки файла:", _redact_err(e))
        return None


def _crash_matches_date(item: dict, date_filter: str) -> bool:
    if not isinstance(item, dict):
        return False
    if not date_filter or date_filter == "all":
        return True
    if str(item.get("date") or "") == date_filter:
        return True
    ts = item.get("timestamp")
    if ts:
        try:
            sec = float(ts) / 1000.0
            local_ymd = datetime.fromtimestamp(sec).strftime("%Y-%m-%d")
            utc_ymd = datetime.fromtimestamp(sec, tz=timezone.utc).strftime("%Y-%m-%d")
            if local_ymd == date_filter or utc_ymd == date_filter:
                return True
        except (ValueError, TypeError, OSError):
            pass
    return False


def _extract_all_crash_reports(raw: dict) -> list:
    """Распаковывает как вложенные узлы crash_reports/{date}/{userId}_{ts}, так и плоские записи."""
    items = []
    if not isinstance(raw, dict):
        return items
    for k, v in raw.items():
        if not isinstance(v, dict):
            continue
        if "timestamp" in v or "userId" in v or "message" in v:
            entry = dict(v)
            entry.setdefault("id", str(k))
            items.append(entry)
        else:
            for sub_k, sub_v in v.items():
                if isinstance(sub_v, dict):
                    entry = dict(sub_v)
                    entry.setdefault("id", f"{k}/{sub_k}")
                    entry.setdefault("date", str(k))
                    items.append(entry)
    return items


def build_crash_report_txt(date_filter: str = "") -> tuple:
    """Формирует структурированный текстовый отчёт crashes_YYYY-MM-DD.txt для человека и ИИ-агента."""
    target_date = (date_filter or "").strip() or datetime.now().strftime("%Y-%m-%d")
    raw = fb_get("crash_reports") or {}
    all_items = _extract_all_crash_reports(raw)

    filtered = [r for r in all_items if _crash_matches_date(r, target_date)]
    filtered.sort(key=lambda r: int(r.get("timestamp") or 0))

    unique_users = {}
    tab_counts = {}
    groups = {}

    for r in filtered:
        uid = str(r.get("userId") or "unknown")
        uname = str(r.get("userName") or "—")
        handle = f" @{r['username']}" if r.get("username") else ""
        unique_users[uid] = f"{uname}{handle}".strip()

        tab = str(r.get("activeTab") or "unknown")
        tab_counts[tab] = tab_counts.get(tab, 0) + 1

        msg = str(r.get("message") or "Unknown Error").strip()
        sig = f"{msg} || {tab}"
        ts = int(r.get("timestamp") or 0)
        if sig not in groups:
            groups[sig] = {
                "message": msg,
                "activeTab": tab,
                "stack": str(r.get("stack") or "—"),
                "count": 0,
                "users": {},
                "first_ts": ts,
                "last_ts": ts,
            }
        g = groups[sig]
        g["count"] += 1
        g["users"][uid] = unique_users[uid]
        if ts and (not g["first_ts"] or ts < g["first_ts"]):
            g["first_ts"] = ts
        if ts and ts > g["last_ts"]:
            g["last_ts"] = ts

    ranked_groups = sorted(groups.values(), key=lambda x: x["count"], reverse=True)
    now_iso = datetime.now(tz=timezone.utc).isoformat()

    def fmt_ts(ms_val):
        if not ms_val:
            return "—"
        try:
            return datetime.fromtimestamp(float(ms_val) / 1000.0, tz=timezone.utc).isoformat()
        except Exception:
            return str(ms_val)

    lines = [
        "================================================================================",
        f"OREO67 — CRASH TELEMETRY & DIAGNOSTIC REPORT ({target_date})",
        f"Generated At : {now_iso}",
        "Format       : Human-Readable & AI-Agent Structured Log v1.0",
        "================================================================================",
        "",
        "[SECTION 1: EXECUTIVE SUMMARY]",
        f"- Filter Period          : {target_date}",
        f"- Total Crash Events     : {len(filtered)} (Total in DB: {len(all_items)})",
        f"- Unique Error Groups    : {len(ranked_groups)}",
        f"- Affected Users Count   : {len(unique_users)}",
    ]
    if unique_users:
        u_summary = ", ".join(f"{u_id} ({u_nm})" for u_id, u_nm in unique_users.items())
        lines.append(f"- Affected Users List    : {u_summary}")
    tabs_str = " | ".join(f"{k}: {v}" for k, v in sorted(tab_counts.items(), key=lambda kv: kv[1], reverse=True))
    lines.append(f"- Breakdown by Screen    : {tabs_str or 'none'}")
    lines.append("")

    lines.append("[SECTION 2: AGGREGATED ERROR SIGNATURES (RANKED BY FREQUENCY)]")
    if not ranked_groups:
        lines.append("No crash events recorded for this period.")
    else:
        for idx, g in enumerate(ranked_groups, 1):
            u_str = ", ".join(f"{u_id} ({u_nm})" for u_id, u_nm in g["users"].items())
            lines.append("--------------------------------------------------------------------------------")
            lines.append(f"GROUP #{idx} | Occurrences: {g['count']}x | Affected Users ({len(g['users'])}): {u_str}")
            lines.append(f"Screen / Mini-Game : {g['activeTab']}")
            lines.append(f"First Seen (UTC)   : {fmt_ts(g['first_ts'])}")
            lines.append(f"Last Seen (UTC)    : {fmt_ts(g['last_ts'])}")
            lines.append(f"Error Message      : {g['message']}")
            lines.append("Primary Stack Trace:")
            for sl in g["stack"].splitlines()[:10]:
                lines.append(f"  {sl}")
    lines.append("")

    lines.append("[SECTION 3: CHRONOLOGICAL CRASH EVENTS & USER BREADCRUMBS]")
    for idx, r in enumerate(filtered, 1):
        lines.append("--------------------------------------------------------------------------------")
        lines.append(f"EVENT #{idx} | Key: {r.get('id', 'n/a')}")
        lines.append(f"Timestamp   : {r.get('isoTime') or fmt_ts(r.get('timestamp'))} ({r.get('timestamp', 0)})")
        handle = f" (@{r['username']})" if r.get("username") else ""
        lines.append(f"Player      : ID={r.get('userId', 'anon')} | Name={r.get('userName', '—')}{handle}")
        lines.append(f"ActiveTab   : {r.get('activeTab', 'unknown')}")
        if r.get("tag"):
            lines.append(f"Report Tag  : {r.get('tag')}")
        if r.get("comment"):
            lines.append(f"User Comment: {r.get('comment')}")
        if r.get("source"):
            lines.append(f"Source      : {r.get('source')}")
        if r.get("userAgent"):
            lines.append(f"UserAgent   : {r.get('userAgent')}")
        lines.append(f"Message     : {r.get('message', '—')}")
        if r.get("gameState"):
            try:
                lines.append(f"Game State  : {json.dumps(r.get('gameState'), ensure_ascii=False)}")
            except Exception:
                lines.append(f"Game State  : {r.get('gameState')}")
        cap_errs = r.get("capturedErrors") or []
        if isinstance(cap_errs, dict):
            cap_errs = list(cap_errs.values())
        if cap_errs:
            lines.append(f"Captured Errors ({len(cap_errs)}):")
            for e_i, ce in enumerate(cap_errs, 1):
                if isinstance(ce, dict):
                    lines.append(f"  {e_i}. [{ce.get('time', '')}] ({ce.get('type', 'err')}) {ce.get('message', '')}")
                else:
                    lines.append(f"  {e_i}. {ce}")
        lines.append("Stack Trace :")
        for sl in str(r.get("stack") or "—").splitlines():
            lines.append(f"  {sl}")

        acts = r.get("actionBreadcrumbLog") or r.get("recentActions") or []
        if isinstance(acts, dict):
            acts = list(acts.values())
        lines.append(f"Action Breadcrumb Log ({len(acts)}):")
        if not acts:
            lines.append("  (no recorded actions prior to error)")
        else:
            for a_i, act in enumerate(acts, 1):
                if isinstance(act, dict):
                    lines.append(f"  {a_i}. [{act.get('time') or act.get('ts', '')}] {act.get('action', '')}")
                else:
                    lines.append(f"  {a_i}. {act}")

    lines.append("================================================================================")
    filename = f"crashes_{target_date}.txt"
    return filename, "\n".join(lines), len(filtered), len(unique_users), len(all_items)


def grant_exclusive_skin(target_uid: str, skin_id: str, call_fn, webapp_url: str) -> tuple:
    meta = EXCLUSIVE_SKINS.get(skin_id)
    if not meta:
        return False, "Неизвестный скин"
    uid = str(target_uid)
    try:
        safe_uid = _fb_key(uid)
    except ValueError:
        return False, "Некорректный ID игрока"
    now_ms = int(time.time() * 1000)

    # Сохраняем в players/{userId}/unlocked_skins и в единую ветку user_skins/{userId}
    fb_patch(f"players/{safe_uid}/unlocked_skins", {skin_id: True})
    fb_patch(f"user_skins/{safe_uid}", {skin_id: True, "updatedAt": now_ms})
    fb_put(
        f"admin_grants/{safe_uid}/{now_ms}",
        {
            "resource": "skin",
            "skinId": skin_id,
            "mode": "unlock",
            "delta": 1,
            "newValue": 1,
            "ts": now_ms,
            "claimed": False,
        },
    )

    delivered = False
    if uid.isdigit():
        kb = {
            "inline_keyboard": [
                [{"text": "✨ Примерить скин в ОРЕО67!", "web_app": {"url": f"{webapp_url}?equip_skin={urllib.parse.quote(skin_id, safe='')}"}}],
            ]
        }
        try:
            call_fn("sendMessage", chat_id=int(uid), text=meta["dm_text"], parse_mode="HTML", reply_markup=kb)
            delivered = True
        except Exception as e:
            print(f"[Skin Notify {uid}] Ошибка ЛС:", _redact_err(e))
    return True, delivered


def build_skins_admin_home() -> tuple:
    text = (
        "🎭 <b>УПРАВЛЕНИЕ ЭКСКЛЮЗИВНЫМИ СКИНАМИ</b>\n\n"
        "Доступные коллекционные скины:\n"
        "• <b>🌹 Шушик</b> — <i>Легендарный VIP (бархат, розы, платиновая кошачья маска)</i>\n"
        "• <b>🍵 Айрочай</b> — <i>Чайный блин Шу Пуэра HONG KONG TEA 茶</i>\n"
        "• <b>🎬 Денис Лыкасов</b> — <i>Кинохлопушка + Premiere Pro таймлайн</i>\n\n"
        "⚡ Выдайте <b>«🌹 Шушик»</b> в 1 клик себе или Вике (<code>Viii</code>), либо выберите любого игрока из базы <code>players</code>:"
    )
    kb = {
        "inline_keyboard": [
            [{"text": "🌹 Выдать «Шушик» СЕБЕ (Павел)", "callback_data": f"adm_skin_give:{MY_USER_ID}:shushik"}],
            [{"text": "🌹 Выдать «Шушик» ВИКЕ (Viii)", "callback_data": f"adm_skin_give:{VIKA_USER_ID}:shushik"}],
            [{"text": "👥 Выбрать любого игрока из базы", "callback_data": "adm_skin_page:0"}],
            [{"text": "🔍 Поиск игрока по нику / ID", "callback_data": "adm_skin_search"}],
            [{"text": "« Назад в Админ-пульт", "callback_data": "adm_home"}],
        ]
    }
    return text, kb


def build_player_skin_menu(target_uid: str) -> tuple:
    p = get_player(target_uid)
    try:
        unlocked = fb_get(f"players/{_fb_key(target_uid)}/unlocked_skins") or {}
    except ValueError:
        unlocked = {}
    if not isinstance(unlocked, dict):
        unlocked = {}
    owned_labels = [EXCLUSIVE_SKINS[k]["title"] for k in EXCLUSIVE_SKINS if unlocked.get(k)]
    owned_str = ", ".join(owned_labels) if owned_labels else "нет эксклюзивных скинов"
    uname = f" (@{html.escape(p['username'])})" if p.get("username") else ""

    text = (
        f"🎭 <b>ВЫДАЧА СКИНОВ ИГРОКУ</b>\n\n"
        f"👤 <b>Игрок:</b> {html.escape(p['name'])}{uname}\n"
        f"🆔 <b>ID:</b> <code>{html.escape(p['id'])}</code>\n"
        f"✨ <b>Открытые эксклюзивы:</b> {html.escape(owned_str)}\n\n"
        "Нажмите на скин для мгновенной выдачи в <code>unlocked_skins</code> + уведомления в ЛС:"
    )
    rows = []
    for sk_id, meta in EXCLUSIVE_SKINS.items():
        mark = "✅ " if unlocked.get(sk_id) else "🎁 Выдать "
        rows.append([{"text": f"{mark}{meta['title']} ({meta['rarity']})", "callback_data": f"adm_skin_give:{target_uid}:{sk_id}"}])
    rows.append([{"text": "« К карточке ресурсов игрока", "callback_data": f"adm_sel:{target_uid}"}])
    rows.append([{"text": "« К разделу скинов", "callback_data": "adm_skins_home"}])
    return text, {"inline_keyboard": rows}


def build_players_page(page: int, prefix: str, query: str = "", exclude_uid: str = "") -> tuple:
    all_p = get_all_players()
    if exclude_uid:
        all_p = [p for p in all_p if str(p["id"]) != str(exclude_uid)]
    if query:
        q = query.lower().lstrip("@")
        all_p = [
            p
            for p in all_p
            if q in p["name"].lower() or q in p["id"].lower() or q in p.get("username", "").lower()
        ]

    total = len(all_p)
    max_page = max(0, (total - 1) // PLAYERS_PAGE_SIZE)
    page = max(0, min(page, max_page))
    slice_p = all_p[page * PLAYERS_PAGE_SIZE : (page + 1) * PLAYERS_PAGE_SIZE]

    rows = []
    for p in slice_p:
        uname = f" (@{p['username']})" if p.get("username") else ""
        label = f"👤 {p['name']}{uname} • {fmt_num(p['coins'])} 🪙"
        rows.append([{"text": label[:60], "callback_data": f"{prefix}_sel:{p['id']}"}])

    nav = []
    if page > 0:
        nav.append({"text": "⬅️ Назад", "callback_data": f"{prefix}_page:{page - 1}"})
    nav.append({"text": f"📄 {page + 1}/{max_page + 1}", "callback_data": "noop"})
    if page < max_page:
        nav.append({"text": "Вперёд ➡️", "callback_data": f"{prefix}_page:{page + 1}"})
    if total > 0:
        rows.append(nav)

    rows.append([{"text": "🔍 Поиск игрока (ID / Имя / @username)", "callback_data": f"{prefix}_search"}])
    if prefix == "adm":
        rows.append([{"text": "« Назад в Админ-пульт", "callback_data": "adm_home"}])
    elif prefix == "adm_skin":
        rows.append([{"text": "« К разделу скинов", "callback_data": "adm_skins_home"}])
    else:
        rows.append([{"text": "« В главное меню", "callback_data": "tab_home"}])

    if prefix == "adm":
        title = "🎁 <b>ВЫДАЧА РЕСУРСОВ — ВЫБОР ИГРОКА</b>\n"
    elif prefix == "adm_skin":
        title = "🎭 <b>ВЫДАЧА СКИНОВ — ВЫБОР ИГРОКА</b>\n"
    else:
        title = "⚔️ <b>ВЫЗОВ НА ДУЭЛЬ 1v1 — ВЫБЕРИТЕ СОПЕРНИКА</b>\n"
    q_line = f"🔎 Фильтр: <code>{html.escape(query)}</code>\n" if query else ""
    text = (
        f"{title}{q_line}"
        f"Всего найдено игроков: <b>{total}</b>\n\n"
        "Нажмите на игрока из списка или воспользуйтесь поиском:"
    )
    return text, {"inline_keyboard": rows}


def build_player_resource_menu(target_uid: str) -> tuple:
    p = get_player(target_uid)
    uname = f" (@{html.escape(p['username'])})" if p.get("username") else ""
    text = (
        f"👤 <b>Игрок:</b> {html.escape(p['name'])}{uname}\n"
        f"🆔 <b>ID:</b> <code>{html.escape(p['id'])}</code>\n\n"
        f"🪙 <b>Коины:</b> <code>{fmt_num(p['coins'])}</code>\n"
        f"💎 <b>Алмазики:</b> <code>{fmt_num(p['gems'])}</code>\n"
        f"⚡ <b>Энергия:</b> <code>{fmt_num(p['energy'])}</code>\n"
        f"🪵 <b>Палочки:</b> <code>{fmt_num(p['sticks'])}</code>\n\n"
        "👇 Выберите ресурс для управления:"
    )
    kb = {
        "inline_keyboard": [
            [
                {"text": "🪙 Коины", "callback_data": f"adm_res:{target_uid}:coins"},
                {"text": "💎 Алмазики", "callback_data": f"adm_res:{target_uid}:gems"},
            ],
            [
                {"text": "⚡ Энергия", "callback_data": f"adm_res:{target_uid}:energy"},
                {"text": "🪵 Палочки", "callback_data": f"adm_res:{target_uid}:sticks"},
            ],
            [{"text": "🎭 Выдать эксклюзивный скин", "callback_data": f"adm_skin_sel:{target_uid}"}],
            [{"text": "« К списку игроков", "callback_data": "adm_players:0"}],
            [{"text": "👑 Админ-пульт", "callback_data": "adm_home"}],
        ]
    }
    return text, kb


def build_resource_presets_menu(target_uid: str, res_key: str) -> tuple:
    p = get_player(target_uid)
    meta = RESOURCE_META.get(res_key, RESOURCE_META["coins"])
    cur_val = p.get(meta["field"], 0)
    text = (
        f"🎁 <b>Управление ресурсом: {meta['label']}</b>\n\n"
        f"👤 <b>Игрок:</b> {html.escape(p['name'])} (<code>{html.escape(p['id'])}</code>)\n"
        f"📊 <b>Текущий баланс:</b> <code>{fmt_num(cur_val)} {meta['unit']}</code>\n\n"
        "Выберите пресет начисления или введите точную сумму вручную:"
    )
    kb = {
        "inline_keyboard": [
            [
                {"text": f"+10k {meta['unit']}", "callback_data": f"adm_act:{target_uid}:{res_key}:add:10000"},
                {"text": f"+100k {meta['unit']}", "callback_data": f"adm_act:{target_uid}:{res_key}:add:100000"},
                {"text": f"+1M {meta['unit']}", "callback_data": f"adm_act:{target_uid}:{res_key}:add:1000000"},
            ],
            [
                {"text": "✏️ Ручной ввод", "callback_data": f"adm_manual:{target_uid}:{res_key}"},
                {"text": "🗑 Сбросить в 0", "callback_data": f"adm_act:{target_uid}:{res_key}:reset:0"},
            ],
            [{"text": "« Назад к игроку", "callback_data": f"adm_sel:{target_uid}"}],
        ]
    }
    return text, kb


def build_bank_menu() -> tuple:
    bank = get_common_bank()
    text = (
        "🏦 <b>УПРАВЛЕНИЕ ОБЩИМ БАНКОМ ТУРНИРА</b>\n\n"
        f"💰 <b>Текущий баланс банка:</b>\n<code>{fmt_num(bank)} 🪙</code>\n\n"
        "Из Общего банка выделяются спонсорские призовые фонды для турниров по Берёзовому Покеру."
    )
    kb = {
        "inline_keyboard": [
            [
                {"text": "+10M 🪙", "callback_data": "adm_bank_act:add:10000000"},
                {"text": "+1B 🪙", "callback_data": "adm_bank_act:add:1000000000"},
            ],
            [
                {"text": "✏️ Задать сумму банка", "callback_data": "adm_bank_manual"},
                {"text": "🔄 Восстановить дефолт Павла", "callback_data": "adm_bank_act:default:0"},
            ],
            [{"text": "🃏 Создать турнир по покеру", "callback_data": "adm_tour_new"}],
            [{"text": "« Назад в Админ-пульт", "callback_data": "adm_home"}],
        ]
    }
    return text, kb


def build_tournament_draft_menu(draft: dict) -> tuple:
    bank = get_common_bank()
    title = draft.get("title") or "Берёзовый Кубок ОРЕО"
    start_time = draft.get("start_time") or "Сегодня в 20:00 МСК"
    sponsor_pool = int(draft.get("prize_pool") or 10000000)
    text = (
        "🃏 <b>СОЗДАНИЕ ТУРНИРА ПО БЕРЁЗОВОМУ ПОКЕРУ</b>\n\n"
        f"🏦 <b>Доступно в Общем банке:</b> <code>{fmt_num(bank)} 🪙</code>\n"
        "──────────────────────\n"
        f"🏆 <b>Название:</b> {html.escape(title)}\n"
        f"⏰ <b>Время старта:</b> {html.escape(start_time)}\n"
        f"💰 <b>Спонсорский фонд из банка:</b> <code>{fmt_num(sponsor_pool)} 🪙</code>\n\n"
        "При нажатии <b>«🚀 Запустить + Рассылка»</b> сумма спишется из Общего банка в фонд турнира, "
        "а все игроки из Firebase получат приглашение с кнопкой входа за стол!"
    )
    kb = {
        "inline_keyboard": [
            [{"text": "✏️ Изменить название", "callback_data": "adm_tour_set:title"}],
            [
                {"text": "⏰ Через 15 мин", "callback_data": "adm_tour_time:Через 15 минут"},
                {"text": "⏰ Сегодня 20:00", "callback_data": "adm_tour_time:Сегодня в 20:00 МСК"},
                {"text": "✏️ Своё время", "callback_data": "adm_tour_set:time"},
            ],
            [
                {"text": "💰 1M 🪙", "callback_data": "adm_tour_pool:1000000"},
                {"text": "💰 10M 🪙", "callback_data": "adm_tour_pool:10000000"},
                {"text": "💰 100M 🪙", "callback_data": "adm_tour_pool:100000000"},
            ],
            [
                {"text": "💰 1B 🪙", "callback_data": "adm_tour_pool:1000000000"},
                {"text": "✏️ Своя сумма фонда", "callback_data": "adm_tour_set:pool"},
            ],
            [{"text": "🚀 Запустить турнир + Broadcast всем!", "callback_data": "adm_tour_launch"}],
            [{"text": "« Назад в Админ-пульт", "callback_data": "adm_home"}],
        ]
    }
    return text, kb


def launch_poker_tournament(draft: dict, call_fn, webapp_url: str) -> tuple:
    bank = get_common_bank()
    prize_pool = max(0, int(draft.get("prize_pool") or 10000000))
    if prize_pool > bank:
        prize_pool = bank

    new_bank = set_common_bank(bank - prize_pool)
    tid = f"tour_{int(time.time())}"
    title = draft.get("title") or "Берёзовый Кубок ОРЕО"
    start_time = draft.get("start_time") or "Сегодня в 20:00 МСК"
    now_ms = int(time.time() * 1000)

    tour_obj = {
        "id": tid,
        "title": title,
        "startTime": start_time,
        "prizePool": prize_pool,
        "sponsor": "Общий Банк (Pavel)",
        "status": "open",
        "createdAt": now_ms,
        "participants": {},
    }
    fb_put(f"poker_tournaments/{tid}", tour_obj)
    fb_put("active_tournament", tour_obj)

    players = get_all_players()
    table_url = f"{webapp_url}?mode=poker_tournament&tournament={urllib.parse.quote(tid)}"
    broadcast_text = (
        "🃏🔥 <b>ТУРНИР ПО БЕРЁЗОВОМУ ПОКЕРУ ОТКРЫТ!</b>\n\n"
        f"🏆 <b>Турнир:</b> {html.escape(title)}\n"
        f"⏰ <b>Старт:</b> {html.escape(start_time)}\n"
        f"💰 <b>Спонсорский призовой фонд:</b> <b>{fmt_num(prize_pool)} 🪙</b>\n\n"
        "Занимай место за деревянным столом прямо сейчас и забери главный куш!"
    )
    broadcast_kb = {
        "inline_keyboard": [
            [{"text": "🔥 Занять место за столом!", "web_app": {"url": table_url}}],
        ]
    }

    sent_count = 0
    for p in players:
        uid = str(p.get("id") or "")
        if not uid.isdigit():
            continue
        try:
            call_fn(
                "sendMessage",
                chat_id=int(uid),
                text=broadcast_text,
                parse_mode="HTML",
                reply_markup=broadcast_kb,
            )
            sent_count += 1
        except Exception:
            pass

    return tour_obj, sent_count, new_bank


# ==================== СИСТЕМА ВЫЗОВОВ 1v1 (ПОКЕР И ШАХМАТЫ) ====================

def build_duel_setup_menu(challenger_id: str, opponent_id: str, game: str, bet: int) -> tuple:
    challenger = get_player(challenger_id)
    opponent = get_player(opponent_id)
    gmeta = GAME_META.get(game, GAME_META["poker"])
    opp_uname = f" (@{html.escape(opponent['username'])})" if opponent.get("username") else ""

    text = (
        "⚔️ <b>ВЫЗОВ ИГРОКА НА ДУЭЛЬ 1v1</b>\n\n"
        f"👤 <b>Соперник:</b> {html.escape(opponent['name'])}{opp_uname}\n"
        f"🎮 <b>Дисциплина:</b> <b>{gmeta['title']}</b>\n"
        f"💰 <b>Ставка на кон:</b> <code>{fmt_num(bet)} 🪙</code> (Банк дуэли: <code>{fmt_num(bet * 2)} 🪙</code>)\n"
        f"👛 <b>Ваш баланс:</b> <code>{fmt_num(challenger['coins'])} 🪙</code>\n\n"
        "<i>При отправке вызова ваша ставка временно замораживается. Если соперник отклонит вызов — коины мгновенно вернутся вам!</i>"
    )
    kb = {
        "inline_keyboard": [
            [
                {
                    "text": ("✅ " if game == "poker" else "") + "🃏 Берёзовый Покер 1v1",
                    "callback_data": f"duel_cfg:{opponent_id}:poker:{bet}",
                },
                {
                    "text": ("✅ " if game == "chess" else "") + "♟ Берёзовые Шахматы",
                    "callback_data": f"duel_cfg:{opponent_id}:chess:{bet}",
                },
            ],
            [
                {"text": "1 000 🪙", "callback_data": f"duel_cfg:{opponent_id}:{game}:1000"},
                {"text": "10 000 🪙", "callback_data": f"duel_cfg:{opponent_id}:{game}:10000"},
                {"text": "50 000 🪙", "callback_data": f"duel_cfg:{opponent_id}:{game}:50000"},
            ],
            [
                {"text": "100 000 🪙", "callback_data": f"duel_cfg:{opponent_id}:{game}:100000"},
                {"text": "1 000 000 🪙", "callback_data": f"duel_cfg:{opponent_id}:{game}:1000000"},
                {"text": "✏️ Своя ставка", "callback_data": f"duel_bet_manual:{opponent_id}:{game}"},
            ],
            [{"text": "🔥 БРОСИТЬ ВЫЗОВ!", "callback_data": f"duel_send:{opponent_id}:{game}:{bet}"}],
            [{"text": "« Выбрать другого соперника", "callback_data": "duel_page:0"}],
        ]
    }
    return text, kb


def send_duel_notification_to_opponent(challenge_id: str, ch: dict, call_fn, webapp_url: str) -> bool:
    opponent_id = str(ch.get("opponentId") or ch.get("targetId") or "")
    if not opponent_id.isdigit():
        return False

    challenger_name = str(ch.get("challengerName") or "Игрок")
    challenger_uname = str(ch.get("challengerUsername") or "").lstrip("@")
    display_challenger = f"@{challenger_uname}" if challenger_uname else html.escape(challenger_name)

    game_key = str(ch.get("game") or "poker").lower()
    if "chess" in game_key or "шахмат" in game_key:
        game_key = "chess"
    else:
        game_key = "poker"
    gmeta = GAME_META[game_key]
    bet = int(float(ch.get("bet") or 0))

    duel_url = (
        f"{webapp_url}?duel={urllib.parse.quote(challenge_id)}"
        f"&game={urllib.parse.quote(game_key)}&bet={bet}"
    )
    msg_text = (
        f"⚔️ Игрок {display_challenger} вызывает вас на дуэль в "
        f"<b>{gmeta['title']}</b> на ставку <b>{fmt_num(bet)} коинов</b>!\n\n"
        f"🏆 <b>Общий банк на кону:</b> <code>{fmt_num(bet * 2)} 🪙</code>\n"
        "Жмите кнопку ниже, чтобы принять бой в игре или отклонить вызов:"
    )
    kb = {
        "inline_keyboard": [
            [{"text": "✅ Принять вызов в игре", "web_app": {"url": duel_url}}],
            [{"text": "❌ Отклонить", "callback_data": f"duel_decline:{challenge_id}"}],
        ]
    }
    try:
        safe_cid = _fb_key(challenge_id)
        call_fn(
            "sendMessage",
            chat_id=int(opponent_id),
            text=msg_text,
            parse_mode="HTML",
            reply_markup=kb,
        )
        fb_patch(
            f"duel_challenges/{safe_cid}",
            {"notified": True, "notifiedAt": int(time.time() * 1000)},
        )
        return True
    except Exception as e:
        print(f"[Duel Notify {challenge_id}] Ошибка отправки в ЛС:", _redact_err(e))
        return False


def create_duel_challenge(
    challenger_user: dict,
    opponent_id: str,
    game: str,
    bet: int,
    call_fn,
    webapp_url: str,
) -> tuple:
    challenger_id = str(challenger_user.get("id") or "")
    try:
        safe_challenger_id = _fb_key(challenger_id)
        _fb_key(opponent_id)
    except ValueError:
        return False, "⚠️ Некорректный идентификатор игрока.", None
    challenger = get_player(challenger_id)
    opponent = get_player(opponent_id)
    bet = max(100, min(MAX_SAFE_AMOUNT, int(bet)))

    if challenger["coins"] < bet:
        return False, f"❌ Недостаточно коинов! Ваш баланс: <b>{fmt_num(challenger['coins'])} 🪙</b>, нужно: <b>{fmt_num(bet)} 🪙</b>.", None

    # Замораживаем ставку Игрока А
    new_coins = challenger["coins"] - bet
    now_ms = int(time.time() * 1000)
    fb_patch(
        f"players/{safe_challenger_id}",
        {"coins": new_coins, "taps": new_coins, "count": new_coins, "ts": now_ms},
    )

    challenge_id = f"duel_{now_ms}_{uuid.uuid4().hex[:6]}"
    ch_data = {
        "id": challenge_id,
        "challengerId": challenger_id,
        "challengerName": challenger_user.get("first_name") or challenger["name"],
        "challengerUsername": challenger_user.get("username") or challenger.get("username") or "",
        "opponentId": str(opponent_id),
        "opponentName": opponent["name"],
        "opponentUsername": opponent.get("username") or "",
        "game": game,
        "gameTitle": GAME_META.get(game, GAME_META["poker"])["title"],
        "bet": bet,
        "escrowFrozen": True,
        "status": "pending",
        "notified": False,
        "createdAt": now_ms,
    }
    fb_put(f"duel_challenges/{challenge_id}", ch_data)
    send_duel_notification_to_opponent(challenge_id, ch_data, call_fn, webapp_url)
    return True, "", ch_data


def decline_or_cancel_duel(challenge_id: str, actor_id: str, call_fn, is_cancel: bool = False) -> tuple:
    try:
        safe_cid = _fb_key(challenge_id)
    except ValueError:
        return False, "⚠️ Некорректный идентификатор вызова."
    ch = fb_get(f"duel_challenges/{safe_cid}")
    if not isinstance(ch, dict):
        return False, "⚠️ Вызов не найден или уже завершён."

    status = str(ch.get("status") or "")
    if status != "pending":
        return False, f"⚠️ Этот вызов уже имеет статус: <b>{html.escape(status)}</b>."

    challenger_id = str(ch.get("challengerId") or "")
    opponent_id = str(ch.get("opponentId") or ch.get("targetId") or "")
    if is_cancel and str(actor_id) != challenger_id and not is_admin(actor_id):
        return False, "⚠️ Только создатель вызова может его отменить."
    if not is_cancel and str(actor_id) != opponent_id and not is_admin(actor_id):
        return False, "⚠️ Этот вызов адресован другому игроку."

    bet = int(float(ch.get("bet") or 0))
    now_ms = int(time.time() * 1000)
    new_status = "cancelled" if is_cancel else "declined"

    # Возвращаем замороженную ставку Игроку А
    if ch.get("escrowFrozen", True) and bet > 0 and challenger_id:
        safe_ch_uid = _fb_key(challenger_id)
        challenger = get_player(challenger_id)
        restored = challenger["coins"] + bet
        fb_patch(
            f"players/{safe_ch_uid}",
            {"coins": restored, "taps": restored, "count": restored, "ts": now_ms},
        )
        fb_put(
            f"admin_grants/{safe_ch_uid}/{now_ms}",
            {
                "resource": "coins",
                "mode": "add",
                "delta": bet,
                "newValue": restored,
                "reason": "duel_refund",
                "ts": now_ms,
                "claimed": False,
            },
        )

    fb_patch(
        f"duel_challenges/{safe_cid}",
        {
            "status": new_status,
            "escrowFrozen": False,
            "resolvedAt": now_ms,
        },
    )

    if not is_cancel and challenger_id.isdigit():
        opp_name = html.escape(str(ch.get("opponentName") or "Соперник"))
        try:
            call_fn(
                "sendMessage",
                chat_id=int(challenger_id),
                text=(
                    f"❌ <b>{opp_name} отклонил ваш вызов на дуэль!</b>\n"
                    f"💰 Замороженная ставка <b>{fmt_num(bet)} 🪙</b> полностью возвращена на ваш баланс."
                ),
                parse_mode="HTML",
            )
        except Exception:
            pass

    return True, (
        f"✅ Вызов отменён. Ставка <b>{fmt_num(bet)} 🪙</b> возвращена на ваш баланс."
        if is_cancel
        else f"❌ Вы отклонили вызов. Замороженная ставка <b>{fmt_num(bet)} 🪙</b> возвращена игроку."
    )


def process_duel_challenges_once(call_fn, webapp_url: str, min_interval_sec: float = 0.0):
    """Проверяет ветки duel_challenges и skin_notifications в Firebase с защитой от гонок и флуда."""
    global _last_duel_sync_ts
    if not _duel_sync_lock.acquire(blocking=False):
        return
    try:
        now_s = time.monotonic()
        if min_interval_sec > 0 and (now_s - _last_duel_sync_ts) < min_interval_sec:
            return
        _last_duel_sync_ts = now_s

        raw = fb_get("duel_challenges")
        if isinstance(raw, dict):
            for cid, ch in raw.items():
                if not isinstance(ch, dict):
                    continue
                if str(ch.get("status") or "pending") == "pending" and not ch.get("notified"):
                    send_duel_notification_to_opponent(str(cid), ch, call_fn, webapp_url)

        sraw = fb_get("skin_notifications")
        if isinstance(sraw, dict):
            for nid, item in sraw.items():
                if not isinstance(item, dict) or item.get("sent"):
                    continue
                uid = str(item.get("userId") or "")
                sk_id = str(item.get("skinId") or "")
                meta = EXCLUSIVE_SKINS.get(sk_id)
                try:
                    safe_nid = _fb_key(nid)
                except ValueError:
                    continue
                if uid.isdigit() and meta:
                    try:
                        call_fn(
                            "sendMessage",
                            chat_id=int(uid),
                            text=meta["dm_text"],
                            parse_mode="HTML",
                            reply_markup={
                                "inline_keyboard": [
                                    [{"text": "✨ Примерить скин в ОРЕО67!", "web_app": {"url": f"{webapp_url}?equip_skin={urllib.parse.quote(sk_id, safe='')}"}}]
                                ]
                            },
                        )
                    except Exception:
                        pass
                fb_patch(f"skin_notifications/{safe_nid}", {"sent": True, "sentAt": int(time.time() * 1000)})
    finally:
        _duel_sync_lock.release()


def start_duel_listener(call_fn, webapp_url: str, interval_sec: float = 4.0):
    """Запускает фоновый поток-слушатель ветки duel_challenges/{challengeId}."""
    global _duel_listener_started
    if _duel_listener_started:
        return
    _duel_listener_started = True

    def _worker():
        while True:
            try:
                process_duel_challenges_once(call_fn, webapp_url)
            except Exception as e:
                print("[DuelListener] Ошибка цикла:", _redact_err(e))
            time.sleep(interval_sec)

    t = threading.Thread(target=_worker, name="OreoDuelChallengeListener", daemon=True)
    t.start()


# ==================== ОБРАБОТЧИКИ СООБЩЕНИЙ И CALLBACK ДЛЯ BOT.PY ====================

def handle_admin_or_duel_message(msg: dict, call_fn, send_card_fn, webapp_url: str) -> bool:
    """Возвращает True, если сообщение обработано модулем админки или дуэлей."""
    if not isinstance(msg, dict):
        return False
    chat_id = (msg.get("chat") or {}).get("id")
    if not chat_id:
        return False
    user = msg.get("from") or msg.get("from_user") or {}
    user_id = user.get("id", "") if isinstance(user, dict) else getattr(user, "id", "")
    text_in = (msg.get("text") or msg.get("caption") or "").strip()

    register_bot_user(user if isinstance(user, dict) else {"id": user_id}, chat_id=chat_id)
    if not _duel_listener_started:
        process_duel_challenges_once(call_fn, webapp_url, min_interval_sec=4.0)

    cmd = text_in.split()[0].lower().split("@")[0] if text_in else ""

    if cmd == "/broadcast":
        _user_states.pop(user_id, None)
        # Security-чек: команда выполняется ТОЛЬКО если ID отправителя совпадает с ADMIN_ID.
        # Если вызывает другой юзер — бот полностью игнорирует команду.
        if not is_admin(user_id):
            return True
        broadcast_text = re.sub(r"^/broadcast(?:@\S+)?\s*", "", text_in, count=1, flags=re.IGNORECASE).strip()
        if not broadcast_text:
            call_fn(
                "sendMessage",
                chat_id=chat_id,
                text=(
                    "📢 <b>Массовая рассылка (/broadcast)</b>\n\n"
                    "Введите текст сообщения после команды:\n"
                    "<code>/broadcast Привет, таперы! Новое обновление уже в игре 🔥</code>\n\n"
                    "<i>Поддерживается HTML и Markdown форматирование. Кнопка «🚀 Залететь в игру» добавляется автоматически.</i>"
                ),
                parse_mode="HTML",
            )
            return True
        run_broadcast(broadcast_text, call_fn, webapp_url, admin_chat_id=chat_id)
        return True

    if cmd == "/admin" or text_in == "👑 Админ-пульт":
        _user_states.pop(user_id, None)
        if not is_admin(user_id):
            call_fn(
                "sendMessage",
                chat_id=chat_id,
                text="⛔ <b>Доступ закрыт!</b> Эксклюзивный Админ-пульт доступен только основателю.",
                parse_mode="HTML",
            )
            return True
        send_card_fn(chat_id, admin_home_text(), admin_home_kb(webapp_url))
        return True

    if cmd == "/get_crashes":
        _user_states.pop(user_id, None)
        if not is_admin(user_id):
            call_fn(
                "sendMessage",
                chat_id=chat_id,
                text="⛔ <b>Доступ закрыт!</b> Выгрузка телеметрии доступна только основателю.",
                parse_mode="HTML",
            )
            return True
        parts = text_in.split(maxsplit=1)
        arg_date = parts[1].strip()[:32] if len(parts) > 1 else datetime.now().strftime("%Y-%m-%d")
        filename, report_txt, cnt, users_cnt, total_db = build_crash_report_txt(arg_date)
        caption = (
            f"🧯 <b>ОТЧЁТ TELEMETRY & CRASH LOGS</b>\n"
            f"📅 <b>Период:</b> <code>{html.escape(arg_date)}</code>\n"
            f"⚠️ <b>Ошибок за период:</b> <b>{cnt}</b> (всего в БД: {total_db})\n"
            f"👥 <b>Затронуто игроков:</b> <b>{users_cnt}</b>"
        )
        # Отправляем служебный дамп строго в личный чат основателя (защита от утечки в групповых чатах)
        send_text_document(MY_USER_ID, filename, report_txt, caption=caption)
        return True

    if cmd == "/duel" or text_in in ("⚔️ Вызов 1v1", "⚔️ Дуэль"):
        _user_states.pop(user_id, None)
        text, kb = build_players_page(0, "duel", exclude_uid=str(user_id))
        send_card_fn(chat_id, text, kb)
        return True

    # Проверка активного состояния ввода (поиск, ручной ввод ресурсов, турнира или ставки)
    st = _user_states.get(user_id)
    if not st or not text_in or text_in.startswith("/"):
        return False

    mode = st.get("mode")

    if mode == "adm_search" and is_admin(user_id):
        _user_states.pop(user_id, None)
        text, kb = build_players_page(0, "adm", query=text_in)
        call_fn("sendMessage", chat_id=chat_id, text=text, parse_mode="HTML", reply_markup=kb)
        return True

    if mode == "adm_skin_search" and is_admin(user_id):
        _user_states.pop(user_id, None)
        text, kb = build_players_page(0, "adm_skin", query=text_in)
        call_fn("sendMessage", chat_id=chat_id, text=text, parse_mode="HTML", reply_markup=kb)
        return True

    if mode == "duel_search":
        _user_states.pop(user_id, None)
        text, kb = build_players_page(0, "duel", query=text_in, exclude_uid=str(user_id))
        call_fn("sendMessage", chat_id=chat_id, text=text, parse_mode="HTML", reply_markup=kb)
        return True

    if mode == "adm_manual_res" and is_admin(user_id):
        target_uid = st["target_uid"]
        res_key = st["res_key"]
        raw_num = text_in.replace(" ", "").replace("_", "").replace(",", "")
        act_mode = "add" if raw_num.startswith(("+", "-")) else "set"
        try:
            amount = _parse_safe_int(raw_num, min_val=-MAX_SAFE_AMOUNT, max_val=MAX_SAFE_AMOUNT)
        except (ValueError, OverflowError):
            call_fn("sendMessage", chat_id=chat_id, text="⚠️ Введите конечное целое число (например: <code>+50000</code> или <code>250000</code>).", parse_mode="HTML")
            return True

        _user_states.pop(user_id, None)
        old_val, new_val, delta = apply_resource_change(target_uid, res_key, act_mode, amount)
        meta = RESOURCE_META[res_key]
        notify_player_resource(target_uid, res_key, delta, new_val, call_fn)
        text, kb = build_player_resource_menu(target_uid)
        call_fn(
            "sendMessage",
            chat_id=chat_id,
            text=f"✅ <b>Баланс обновлён!</b> ({meta['label']}: <code>{fmt_num(old_val)}</code> → <code>{fmt_num(new_val)}</code>)\n\n" + text,
            parse_mode="HTML",
            reply_markup=kb,
        )
        return True

    if mode == "adm_bank_manual" and is_admin(user_id):
        try:
            val = _parse_safe_int(text_in, min_val=0, max_val=PAVEL_BANK_DEFAULT * 10)
        except (ValueError, OverflowError):
            call_fn("sendMessage", chat_id=chat_id, text="⚠️ Введите корректное число для Общего банка.", parse_mode="HTML")
            return True
        _user_states.pop(user_id, None)
        set_common_bank(val)
        text, kb = build_bank_menu()
        call_fn("sendMessage", chat_id=chat_id, text="✅ <b>Общий банк обновлён!</b>\n\n" + text, parse_mode="HTML", reply_markup=kb)
        return True

    if mode in ("adm_tour_title", "adm_tour_time", "adm_tour_pool") and is_admin(user_id):
        draft = st.get("draft") or {}
        if mode == "adm_tour_title":
            draft["title"] = text_in[:80]
        elif mode == "adm_tour_time":
            draft["start_time"] = text_in[:60]
        elif mode == "adm_tour_pool":
            try:
                draft["prize_pool"] = _parse_safe_int(text_in, min_val=0, max_val=PAVEL_BANK_DEFAULT * 10)
            except (ValueError, OverflowError):
                call_fn("sendMessage", chat_id=chat_id, text="⚠️ Введите сумму призового фонда числом.", parse_mode="HTML")
                return True
        _user_states[user_id] = {"mode": "adm_tour_draft", "draft": draft}
        text, kb = build_tournament_draft_menu(draft)
        call_fn("sendMessage", chat_id=chat_id, text=text, parse_mode="HTML", reply_markup=kb)
        return True

    if mode == "duel_bet_manual":
        opp_id = st["opponent_id"]
        game = st["game"]
        try:
            bet = _parse_safe_int(text_in, min_val=100, max_val=MAX_SAFE_AMOUNT)
        except (ValueError, OverflowError):
            call_fn("sendMessage", chat_id=chat_id, text="⚠️ Введите ставку числом (минимум 100 коинов).", parse_mode="HTML")
            return True
        _user_states.pop(user_id, None)
        text, kb = build_duel_setup_menu(str(user_id), opp_id, game, bet)
        call_fn("sendMessage", chat_id=chat_id, text=text, parse_mode="HTML", reply_markup=kb)
        return True

    return False


def notify_player_resource(target_uid: str, res_key: str, delta: int, new_val: int, call_fn):
    if not str(target_uid).isdigit():
        return
    meta = RESOURCE_META.get(res_key, RESOURCE_META["coins"])
    sign = f"+{fmt_num(delta)}" if delta >= 0 else fmt_num(delta)
    msg = (
        "🎁 <b>Уведомление от Администрации ОРЕО!</b>\n\n"
        f"Ваш баланс ресурса <b>{meta['label']}</b> изменён: <b>{sign} {meta['unit']}</b>\n"
        f"📊 <b>Текущий баланс:</b> <code>{fmt_num(new_val)} {meta['unit']}</code>"
    )
    try:
        call_fn("sendMessage", chat_id=int(target_uid), text=msg, parse_mode="HTML")
    except Exception:
        pass


def handle_admin_or_duel_callback(cb: dict, call_fn, edit_card_fn, webapp_url: str) -> bool:
    """Возвращает True, если callback_query обработан модулем админки или дуэлей."""
    if not isinstance(cb, dict):
        return False
    data = cb.get("data") or ""
    msg = cb.get("message") or {}
    chat_id = (msg.get("chat") or {}).get("id")
    message_id = msg.get("message_id")
    has_photo = bool(msg.get("photo"))
    user = cb.get("from") or {}
    user_id = user.get("id", "")

    register_bot_user(user, chat_id=chat_id)
    if not _duel_listener_started:
        process_duel_challenges_once(call_fn, webapp_url, min_interval_sec=4.0)

    if data == "noop":
        return True

    # --------- АДМИН-ПУЛЬТ ---------
    if data.startswith("adm_"):
        if not is_admin(user_id):
            try:
                call_fn("answerCallbackQuery", callback_query_id=cb["id"], text="⛔ Доступ только для основателя!", show_alert=True)
            except Exception:
                pass
            return True

        if data == "adm_home":
            _user_states.pop(user_id, None)
            edit_card_fn(chat_id, message_id, has_photo, admin_home_text(), admin_home_kb(webapp_url))
            return True

        if data == "adm_skins_home":
            _user_states.pop(user_id, None)
            text, kb = build_skins_admin_home()
            edit_card_fn(chat_id, message_id, has_photo, text, kb)
            return True

        if data.startswith("adm_skin_page:"):
            page = int(data.split(":")[1] or 0)
            text, kb = build_players_page(page, "adm_skin")
            edit_card_fn(chat_id, message_id, has_photo, text, kb)
            return True

        if data == "adm_skin_search":
            _user_states[user_id] = {"mode": "adm_skin_search"}
            edit_card_fn(
                chat_id,
                message_id,
                has_photo,
                "🔍 <b>ПОИСК ИГРОКА ДЛЯ ВЫДАЧИ СКИНА</b>\n\nОтправьте в чат <b>ник</b>, <b>@username</b> или <b>ID</b> игрока:",
                {"inline_keyboard": [[{"text": "« Отмена", "callback_data": "adm_skins_home"}]]},
            )
            return True

        if data.startswith("adm_skin_sel:"):
            target_uid = data.split(":", 1)[1]
            text, kb = build_player_skin_menu(target_uid)
            edit_card_fn(chat_id, message_id, has_photo, text, kb)
            return True

        if data.startswith("adm_skin_give:"):
            _, target_uid, skin_id = data.split(":", 2)
            ok, delivered = grant_exclusive_skin(target_uid, skin_id, call_fn, webapp_url)
            meta = EXCLUSIVE_SKINS.get(skin_id, {"title": skin_id})
            dm_note = "📩 Красивое уведомление доставлено в ЛС!" if delivered else "💾 Записано в Firebase (игрок увидит при входе)!"
            text, kb = build_player_skin_menu(target_uid)
            banner = f"✅ <b>Скин {meta['title']} выдан игроку <code>{html.escape(target_uid)}</code>!</b>\n{dm_note}\n\n"
            edit_card_fn(chat_id, message_id, has_photo, banner + text, kb)
            return True

        if data.startswith("adm_players:") or data.startswith("adm_page:"):
            page = int(data.split(":")[1] or 0)
            text, kb = build_players_page(page, "adm")
            edit_card_fn(chat_id, message_id, has_photo, text, kb)
            return True

        if data == "adm_search":
            _user_states[user_id] = {"mode": "adm_search"}
            edit_card_fn(
                chat_id,
                message_id,
                has_photo,
                "🔍 <b>ПОИСК ИГРОКА</b>\n\nОтправьте в чат <b>ID</b>, <b>имя</b> или <b>@username</b> игрока:",
                {"inline_keyboard": [[{"text": "« Отмена", "callback_data": "adm_players:0"}]]},
            )
            return True

        if data.startswith("adm_sel:"):
            target_uid = data.split(":", 1)[1]
            text, kb = build_player_resource_menu(target_uid)
            edit_card_fn(chat_id, message_id, has_photo, text, kb)
            return True

        if data.startswith("adm_res:"):
            _, target_uid, res_key = data.split(":", 2)
            text, kb = build_resource_presets_menu(target_uid, res_key)
            edit_card_fn(chat_id, message_id, has_photo, text, kb)
            return True

        if data.startswith("adm_act:"):
            _, target_uid, res_key, act_mode, amt_str = data.split(":", 4)
            old_val, new_val, delta = apply_resource_change(target_uid, res_key, act_mode, int(amt_str))
            notify_player_resource(target_uid, res_key, delta, new_val, call_fn)
            meta = RESOURCE_META[res_key]
            text, kb = build_resource_presets_menu(target_uid, res_key)
            banner = f"✅ <b>Успешно!</b> {meta['label']}: <code>{fmt_num(old_val)}</code> → <code>{fmt_num(new_val)}</code>\n📩 Уведомление отправлено игроку в ЛС.\n\n"
            edit_card_fn(chat_id, message_id, has_photo, banner + text, kb)
            return True

        if data.startswith("adm_manual:"):
            _, target_uid, res_key = data.split(":", 2)
            meta = RESOURCE_META[res_key]
            _user_states[user_id] = {"mode": "adm_manual_res", "target_uid": target_uid, "res_key": res_key}
            edit_card_fn(
                chat_id,
                message_id,
                has_photo,
                f"✏️ <b>РУЧНОЙ ВВОД: {meta['label']}</b>\n\n"
                "Отправьте в чат число:\n"
                "• <code>+50000</code> — чтобы прибавить к текущему балансу\n"
                "• <code>250000</code> — чтобы установить точное значение",
                {"inline_keyboard": [[{"text": "« Назад", "callback_data": f"adm_res:{target_uid}:{res_key}"}]]},
            )
            return True

        if data == "adm_bank":
            text, kb = build_bank_menu()
            edit_card_fn(chat_id, message_id, has_photo, text, kb)
            return True

        if data.startswith("adm_bank_act:"):
            _, act_mode, val_str = data.split(":", 2)
            cur = get_common_bank()
            if act_mode == "default":
                set_common_bank(PAVEL_BANK_DEFAULT)
            else:
                set_common_bank(cur + int(val_str))
            text, kb = build_bank_menu()
            edit_card_fn(chat_id, message_id, has_photo, "✅ <b>Банк обновлён!</b>\n\n" + text, kb)
            return True

        if data == "adm_bank_manual":
            _user_states[user_id] = {"mode": "adm_bank_manual"}
            edit_card_fn(
                chat_id,
                message_id,
                has_photo,
                "✏️ <b>ВВЕДИТЕ НОВУЮ СУММУ ОБЩЕГО БАНКА</b>\n\nОтправьте целое число коинов в чат:",
                {"inline_keyboard": [[{"text": "« Отмена", "callback_data": "adm_bank"}]]},
            )
            return True

        if data == "adm_tour_new":
            st = _user_states.get(user_id) or {}
            draft = st.get("draft") or {
                "title": "Берёзовый Кубок ОРЕО",
                "start_time": "Сегодня в 20:00 МСК",
                "prize_pool": 10000000,
            }
            _user_states[user_id] = {"mode": "adm_tour_draft", "draft": draft}
            text, kb = build_tournament_draft_menu(draft)
            edit_card_fn(chat_id, message_id, has_photo, text, kb)
            return True

        if data.startswith("adm_tour_time:"):
            t_val = data.split(":", 1)[1]
            draft = (_user_states.get(user_id) or {}).get("draft") or {}
            draft["start_time"] = t_val
            _user_states[user_id] = {"mode": "adm_tour_draft", "draft": draft}
            text, kb = build_tournament_draft_menu(draft)
            edit_card_fn(chat_id, message_id, has_photo, text, kb)
            return True

        if data.startswith("adm_tour_pool:"):
            p_val = int(data.split(":", 1)[1])
            draft = (_user_states.get(user_id) or {}).get("draft") or {}
            draft["prize_pool"] = p_val
            _user_states[user_id] = {"mode": "adm_tour_draft", "draft": draft}
            text, kb = build_tournament_draft_menu(draft)
            edit_card_fn(chat_id, message_id, has_photo, text, kb)
            return True

        if data.startswith("adm_tour_set:"):
            field = data.split(":", 1)[1]
            draft = (_user_states.get(user_id) or {}).get("draft") or {}
            mode_map = {"title": "adm_tour_title", "time": "adm_tour_time", "pool": "adm_tour_pool"}
            prompt_map = {
                "title": "✏️ Отправьте в чат <b>название турнира</b>:",
                "time": "⏰ Отправьте в чат <b>время начала турнира</b> (например: <code>Сегодня в 21:30 МСК</code>):",
                "pool": "💰 Отправьте в чат <b>сумму спонсорского фонда</b> из Общего банка:",
            }
            _user_states[user_id] = {"mode": mode_map[field], "draft": draft}
            edit_card_fn(
                chat_id,
                message_id,
                has_photo,
                prompt_map[field],
                {"inline_keyboard": [[{"text": "« Назад к турниру", "callback_data": "adm_tour_new"}]]},
            )
            return True

        if data == "adm_tour_launch":
            draft = (_user_states.get(user_id) or {}).get("draft") or {}
            tour_obj, sent_cnt, rem_bank = launch_poker_tournament(draft, call_fn, webapp_url)
            _user_states.pop(user_id, None)
            table_url = f"{webapp_url}?mode=poker_tournament&tournament={urllib.parse.quote(tour_obj['id'])}"
            summary = (
                "🚀 <b>ТУРНИР СОЗДАН И РАЗОСЛАН ВСЕМ ИГРОКАМ!</b>\n\n"
                f"🏆 <b>Название:</b> {html.escape(tour_obj['title'])}\n"
                f"⏰ <b>Время:</b> {html.escape(tour_obj['startTime'])}\n"
                f"💰 <b>Выделено из банка:</b> <code>{fmt_num(tour_obj['prizePool'])} 🪙</code>\n"
                f"🏦 <b>Остаток Общего банка:</b> <code>{fmt_num(rem_bank)} 🪙</code>\n"
                f"📨 <b>Доставлено приглашений в ЛС:</b> <b>{sent_cnt}</b>"
            )
            kb = {
                "inline_keyboard": [
                    [{"text": "🔥 Занять место за столом!", "web_app": {"url": table_url}}],
                    [{"text": "👑 Назад в Админ-пульт", "callback_data": "adm_home"}],
                ]
            }
            edit_card_fn(chat_id, message_id, has_photo, summary, kb)
            return True

        if data == "adm_duels":
            raw = fb_get("duel_challenges") or {}
            pending = [
                v for v in (raw.values() if isinstance(raw, dict) else [])
                if isinstance(v, dict) and v.get("status") == "pending"
            ]
            lines = [f"⚔️ <b>АКТИВНЫЕ ВЫЗОВЫ 1v1 ({len(pending)})</b>\n"]
            for ch in pending[:10]:
                lines.append(
                    f"• {html.escape(str(ch.get('challengerName')))} vs {html.escape(str(ch.get('opponentName')))} "
                    f"— <b>{fmt_num(ch.get('bet', 0))} 🪙</b> ({html.escape(str(ch.get('gameTitle', ch.get('game'))))})"
                )
            if not pending:
                lines.append("Сейчас нет ожидающих вызовов.")
            edit_card_fn(
                chat_id,
                message_id,
                has_photo,
                "\n".join(lines),
                {"inline_keyboard": [[{"text": "« Назад в Админ-пульт", "callback_data": "adm_home"}]]},
            )
            return True

        if data == "adm_crashes":
            today_str = datetime.now().strftime("%Y-%m-%d")
            _, _, today_cnt, today_users, total_db = build_crash_report_txt(today_str)
            info_text = (
                "🧯 <b>СИСТЕМА TELEMETRY & КРАШ-ЛОГОВ</b>\n\n"
                f"📅 <b>Текущая дата:</b> <code>{today_str}</code>\n"
                f"⚠️ <b>Сбоев за сегодня:</b> <b>{today_cnt}</b> (затронуто игроков: <b>{today_users}</b>)\n"
                f"🗄 <b>Всего записей в crash_reports:</b> <b>{total_db}</b>\n\n"
                "Также доступна быстрая команда:\n"
                "• <code>/get_crashes</code> — выгрузка за сегодня\n"
                "• <code>/get_crashes YYYY-MM-DD</code> — за выбранную дату\n"
                "• <code>/get_crashes all</code> — полный архив"
            )
            kb = {
                "inline_keyboard": [
                    [{"text": f"📥 Скачать crashes_{today_str}.txt ({today_cnt})", "callback_data": f"adm_crashes_dl:{today_str}"}],
                    [{"text": f"📦 Скачать ВСЕ логи crashes_all.txt ({total_db})", "callback_data": "adm_crashes_dl:all"}],
                    [{"text": "« Назад в Админ-пульт", "callback_data": "adm_home"}],
                ]
            }
            edit_card_fn(chat_id, message_id, has_photo, info_text, kb)
            return True

        if data.startswith("adm_crashes_dl:"):
            target_d = (data.split(":", 1)[1] or datetime.now().strftime("%Y-%m-%d"))[:32]
            filename, report_txt, cnt, users_cnt, total_db = build_crash_report_txt(target_d)
            caption = (
                f"🧯 <b>Файл телеметрии:</b> <code>{html.escape(filename)}</code>\n"
                f"⚠️ <b>Событий:</b> <b>{cnt}</b> • 👥 <b>Игроков:</b> <b>{users_cnt}</b> (в БД: {total_db})"
            )
            send_text_document(MY_USER_ID, filename, report_txt, caption=caption)
            return True

    # --------- СИСТЕМА ВЫЗОВОВ 1v1 (ДЛЯ ВСЕХ ИГРОКОВ) ---------
    if data == "duel_menu" or data.startswith("duel_page:"):
        _user_states.pop(user_id, None)
        try:
            page = int(data.split(":", 1)[1]) if ":" in data else 0
        except (ValueError, IndexError):
            page = 0
        text, kb = build_players_page(page, "duel", exclude_uid=str(user_id))
        edit_card_fn(chat_id, message_id, has_photo, text, kb)
        return True

    if data == "duel_search":
        _user_states[user_id] = {"mode": "duel_search"}
        edit_card_fn(
            chat_id,
            message_id,
            has_photo,
            "🔍 <b>ПОИСК СОПЕРНИКА ДЛЯ ДУЭЛИ</b>\n\nОтправьте в чат <b>имя</b>, <b>@username</b> или <b>ID</b> игрока:",
            {"inline_keyboard": [[{"text": "« Назад к списку", "callback_data": "duel_page:0"}]]},
        )
        return True

    if data.startswith("duel_sel:"):
        opp_id = data.split(":", 1)[1]
        text, kb = build_duel_setup_menu(str(user_id), opp_id, "poker", 10000)
        edit_card_fn(chat_id, message_id, has_photo, text, kb)
        return True

    if data.startswith("duel_cfg:"):
        parts = data.split(":", 3)
        if len(parts) != 4:
            return True
        _, opp_id, game, bet_str = parts
        try:
            bet_val = _parse_safe_int(bet_str, min_val=100, max_val=MAX_SAFE_AMOUNT)
        except (ValueError, OverflowError):
            bet_val = 10000
        text, kb = build_duel_setup_menu(str(user_id), opp_id, game, bet_val)
        edit_card_fn(chat_id, message_id, has_photo, text, kb)
        return True

    if data.startswith("duel_bet_manual:"):
        parts = data.split(":", 2)
        if len(parts) != 3:
            return True
        _, opp_id, game = parts
        _user_states[user_id] = {"mode": "duel_bet_manual", "opponent_id": opp_id, "game": game}
        edit_card_fn(
            chat_id,
            message_id,
            has_photo,
            "✏️ <b>ВВЕДИТЕ СТАВКУ НА ДУЭЛЬ</b>\n\nОтправьте в чат сумму ставки в коинах (минимум <code>100</code>):",
            {"inline_keyboard": [[{"text": "« Назад", "callback_data": f"duel_cfg:{opp_id}:{game}:10000"}]]},
        )
        return True

    if data.startswith("duel_send:"):
        parts = data.split(":", 3)
        if len(parts) != 4:
            return True
        _, opp_id, game, bet_str = parts
        try:
            bet_val = _parse_safe_int(bet_str, min_val=100, max_val=MAX_SAFE_AMOUNT)
        except (ValueError, OverflowError):
            bet_val = 10000
        ok, err_msg, ch_data = create_duel_challenge(user, opp_id, game, bet_val, call_fn, webapp_url)
        if not ok:
            text, kb = build_duel_setup_menu(str(user_id), opp_id, game, bet_val)
            edit_card_fn(chat_id, message_id, has_photo, f"{err_msg}\n\n{text}", kb)
            return True

        cid = ch_data["id"]
        duel_url = f"{webapp_url}?duel={urllib.parse.quote(cid)}&game={urllib.parse.quote(game)}&bet={ch_data['bet']}"
        sent_text = (
            "⚔️ <b>ВЫЗОВ ОТПРАВЛЕН!</b>\n\n"
            f"👤 <b>Соперник:</b> {html.escape(ch_data['opponentName'])}\n"
            f"🎮 <b>Игра:</b> <b>{html.escape(ch_data['gameTitle'])}</b>\n"
            f"💰 <b>Замороженная ставка:</b> <code>{fmt_num(ch_data['bet'])} 🪙</code>\n\n"
            "Сопернику отправлено мгновенное уведомление в ЛС Telegram. Вы можете сразу зайти за стол или отменить вызов до его принятия:"
        )
        sent_kb = {
            "inline_keyboard": [
                [{"text": "🎮 Войти в комнату дуэли", "web_app": {"url": duel_url}}],
                [{"text": "🚫 Отменить вызов и вернуть ставку", "callback_data": f"duel_cancel:{cid}"}],
                [{"text": "« В главное меню", "callback_data": "tab_home"}],
            ]
        }
        edit_card_fn(chat_id, message_id, has_photo, sent_text, sent_kb)
        return True

    if data.startswith("duel_decline:"):
        cid = data.split(":", 1)[1]
        ok, status_text = decline_or_cancel_duel(cid, str(user_id), call_fn, is_cancel=False)
        edit_card_fn(
            chat_id,
            message_id,
            has_photo,
            status_text,
            {"inline_keyboard": [[{"text": "⚔️ Бросить встречный вызов", "callback_data": "duel_menu"}]]},
        )
        return True

    if data.startswith("duel_cancel:"):
        cid = data.split(":", 1)[1]
        ok, status_text = decline_or_cancel_duel(cid, str(user_id), call_fn, is_cancel=True)
        edit_card_fn(
            chat_id,
            message_id,
            has_photo,
            status_text,
            {"inline_keyboard": [[{"text": "⚔️ Выбрать другого соперника", "callback_data": "duel_menu"}]]},
        )
        return True

    return False


# ==================== МУЗЫКАЛЬНАЯ СИСТЕМА И JUKEBOX (RENDER BACKEND API) ====================

_MUSIC_TX_LOCK = threading.Lock()
_SAFE_TRACK_ID_RE = re.compile(r"^[A-Za-z0-9_.:-]{1,96}$")
TRACK_MIN_PRICE = 50_000
TRACK_MAX_PRICE = 300_000
JUKEBOX_BASE_PRICE = 10_000
JUKEBOX_DURATION_MS = 180_000  # 3 минуты
JUKEBOX_MAX_PRICE = 10_240_000

ROOM_TYPE_PATHS = {
    "poker": "poker_tables",
    "chess": "duel_matches",
    "loto": "loto_rooms",
}


def _normalize_owned_tracks(raw_owned) -> list:
    out = ["tap_lofi"]
    seen = {"tap_lofi"}
    items = []
    if isinstance(raw_owned, list):
        items = raw_owned
    elif isinstance(raw_owned, dict):
        items = list(raw_owned.values())
    for item in items:
        s = str(item or "").strip()
        if s and _SAFE_TRACK_ID_RE.fullmatch(s) and s not in seen:
            seen.add(s)
            out.append(s)
    return out


def _sanitize_audio_url(raw_url: str) -> str:
    u = str(raw_url or "").strip()
    if not u or len(u) > 512 or any(ch in u for ch in ("\r", "\n", "\x00", '"', "'", "<", ">")):
        return ""
    if u.startswith("https://") or u.startswith("assets/music/") or u.startswith("/assets/music/"):
        return u.lstrip("/") if u.startswith("/assets/music/") else u
    return ""


def _sanitize_cover_url(raw_url: str) -> str:
    u = str(raw_url or "").strip()
    if not u or len(u) > 2048 or any(ch in u for ch in ("\r", "\n", "\x00", "<", ">")):
        return ""
    if u.startswith("https://") or u.startswith("assets/") or u.startswith("data:image/"):
        return u
    return ""


def fb_run_transaction(path: str, updater_fn, max_retries: int = 4) -> tuple:
    """Атомарная транзакция Firebase REST API через X-Firebase-ETag и If-Match."""
    clean_path = path.lstrip("/")
    url = f"{FIREBASE_DB_URL}/{clean_path}.json"

    for _ in range(max_retries):
        req_get = urllib.request.Request(
            url,
            headers={"X-Firebase-ETag": "true", "Accept": "application/json"},
            method="GET",
        )
        try:
            with urllib.request.urlopen(req_get, timeout=12) as resp:
                etag = resp.headers.get("ETag")
                raw = resp.read().decode("utf-8")
                current = json.loads(raw) if raw else None
        except Exception as e:
            print(f"[Firebase TX GET {clean_path}] Ошибка:", _redact_err(e))
            return False, None

        working_copy = json.loads(json.dumps(current)) if current is not None else None
        next_val = updater_fn(working_copy)
        if next_val is None:
            return False, current

        put_headers = {"Content-Type": "application/json"}
        if etag:
            put_headers["If-Match"] = etag
        body = json.dumps(next_val, ensure_ascii=False).encode("utf-8")
        req_put = urllib.request.Request(url, data=body, headers=put_headers, method="PUT")
        try:
            with urllib.request.urlopen(req_put, timeout=12) as put_resp:
                saved_raw = put_resp.read().decode("utf-8")
                saved = json.loads(saved_raw) if saved_raw else next_val
                return True, saved
        except urllib.error.HTTPError as he:
            if he.code == 412:
                continue
            print(f"[Firebase TX PUT {clean_path}] HTTP {he.code}:", _redact_err(he))
            return False, current
        except Exception as e:
            print(f"[Firebase TX PUT {clean_path}] Ошибка:", _redact_err(e))
            return False, current

    return False, None


def buy_music_track(user_id: str, track_id: str, price_raw, meta: dict = None) -> dict:
    """Покупка трека за игровые коины с защитой от повторного списания."""
    uid = str(user_id or "").strip()
    tid = str(track_id or "").strip()
    if not uid or len(uid) > 64:
        return {"ok": False, "error": "invalid_user_id", "message": "Некорректный ID игрока"}
    try:
        safe_uid = _fb_key(uid)
    except ValueError:
        return {"ok": False, "error": "invalid_user_id", "message": "Некорректный ID игрока"}

    if not _SAFE_TRACK_ID_RE.fullmatch(tid):
        return {"ok": False, "error": "invalid_track_id", "message": "Некорректный ID трека"}

    try:
        price = _parse_safe_int(price_raw, min_val=0, max_val=MAX_SAFE_AMOUNT)
    except (ValueError, OverflowError):
        return {"ok": False, "error": "invalid_price", "message": "Некорректная цена трека"}

    if tid == "tap_lofi":
        price = 0
    elif price < TRACK_MIN_PRICE or price > TRACK_MAX_PRICE:
        return {
            "ok": False,
            "error": "invalid_price_range",
            "message": f"Цена трека должна быть от {fmt_num(TRACK_MIN_PRICE)} до {fmt_num(TRACK_MAX_PRICE)} коинов",
        }

    meta = meta if isinstance(meta, dict) else {}
    clean_meta = {
        "id": tid,
        "title": str(meta.get("title") or tid)[:80],
        "artist": str(meta.get("artist") or "Royalty-Free Artist")[:80],
        "genre": str(meta.get("genre") or "lofi")[:32],
        "audio_url": _sanitize_audio_url(meta.get("audio_url") or meta.get("url") or ""),
        "cover": _sanitize_cover_url(meta.get("cover") or ""),
        "price": price,
        "boughtAt": int(time.time() * 1000),
    }

    tx_state = {"status": "error", "coins": 0, "owned": ["tap_lofi"], "meta_map": {}}

    with _MUSIC_TX_LOCK:
        def _mutate_player(pdata):
            if not isinstance(pdata, dict):
                tx_state["status"] = "player_not_found"
                return None

            wallet = pdata.get("wallet") if isinstance(pdata.get("wallet"), dict) else {}
            cur_coins = int(round(float(pdata.get("coins") if pdata.get("coins") is not None else wallet.get("coins") or 0)))
            cur_coins = max(0, cur_coins)
            owned_list = _normalize_owned_tracks(pdata.get("ownedTracks"))
            owned_meta = pdata.get("ownedTrackMeta") if isinstance(pdata.get("ownedTrackMeta"), dict) else {}

            if tid in owned_list:
                tx_state["status"] = "already_owned"
                tx_state["coins"] = cur_coins
                tx_state["owned"] = owned_list
                tx_state["meta_map"] = owned_meta
                return None

            if cur_coins < price:
                tx_state["status"] = "insufficient_coins"
                tx_state["coins"] = cur_coins
                tx_state["owned"] = owned_list
                tx_state["meta_map"] = owned_meta
                return None

            now_ms = int(time.time() * 1000)
            new_coins = cur_coins - price
            owned_list.append(tid)
            owned_meta = dict(owned_meta)
            owned_meta[tid] = clean_meta

            pdata["coins"] = new_coins
            pdata["taps"] = new_coins
            pdata["count"] = new_coins
            pdata["ownedTracks"] = owned_list
            pdata["ownedTrackMeta"] = owned_meta
            pdata["ts"] = now_ms
            if isinstance(pdata.get("wallet"), dict):
                pdata["wallet"]["coins"] = new_coins

            tx_state["status"] = "purchased"
            tx_state["coins"] = new_coins
            tx_state["owned"] = owned_list
            tx_state["meta_map"] = owned_meta
            return pdata

        committed, _ = fb_run_transaction(f"players/{safe_uid}", _mutate_player)

    st = tx_state["status"]
    if st == "already_owned":
        return {
            "ok": True,
            "already_owned": True,
            "coins": tx_state["coins"],
            "track_id": tid,
            "ownedTracks": tx_state["owned"],
            "ownedTrackMeta": tx_state["meta_map"],
        }
    if st == "purchased" and committed:
        return {
            "ok": True,
            "already_owned": False,
            "coins": tx_state["coins"],
            "price": price,
            "track_id": tid,
            "ownedTracks": tx_state["owned"],
            "ownedTrackMeta": tx_state["meta_map"],
        }
    if st == "insufficient_coins":
        return {
            "ok": False,
            "error": "insufficient_coins",
            "message": f"Недостаточно коинов (нужно {fmt_num(price)} 🪙)",
            "coins": tx_state["coins"],
            "required": price,
        }
    if st == "player_not_found":
        return {
            "ok": False,
            "error": "player_not_found",
            "message": "Профиль игрока ещё не синхронизирован с облаком",
        }
    return {"ok": False, "error": "tx_failed", "message": "Не удалось завершить транзакцию, попробуйте снова"}


def order_table_jukebox(
    user_id: str,
    room_type: str,
    room_id: str,
    track_id: str,
    track_url: str,
    track_title: str = "",
    track_artist: str = "",
    ordered_by: str = "",
) -> dict:
    """Заказ трека на мультиплеерный стол (Покер, Шахматы, Лото) на 3 минуты с перебиванием x2."""
    uid = str(user_id or "").strip()
    rtype = str(room_type or "poker").strip().lower()
    rid = str(room_id or "").strip()
    tid = str(track_id or "custom").strip()
    clean_url = _sanitize_audio_url(track_url)

    if not uid or len(uid) > 64:
        return {"ok": False, "error": "invalid_user_id", "message": "Некорректный ID игрока"}
    if rtype not in ROOM_TYPE_PATHS:
        return {"ok": False, "error": "invalid_room_type", "message": "Неподдерживаемый тип комнаты"}
    if not rid or len(rid) > 96:
        return {"ok": False, "error": "invalid_room_id", "message": "Не указан ID стола"}
    if not clean_url:
        return {"ok": False, "error": "invalid_track_url", "message": "Некорректная ссылка на аудиопоток"}
    if not _SAFE_TRACK_ID_RE.fullmatch(tid):
        tid = "track"

    try:
        safe_uid = _fb_key(uid)
        safe_rid = _fb_key(rid)
    except ValueError:
        return {"ok": False, "error": "invalid_key", "message": "Недопустимые символы в идентификаторе"}

    room_path = f"{ROOM_TYPE_PATHS[rtype]}/{safe_rid}"

    with _MUSIC_TX_LOCK:
        room_data = fb_get(room_path)
        if not isinstance(room_data, dict):
            if rtype == "loto":
                room_data = {"id": rid}
            else:
                return {"ok": False, "error": "room_not_found", "message": "Игровой стол не найден или уже закрыт"}

        now_ms = int(time.time() * 1000)
        cur_jb = room_data.get("jukebox") if isinstance(room_data.get("jukebox"), dict) else {}
        cur_expires = int(round(float(cur_jb.get("expires_at") or room_data.get("expires_at") or 0)))
        cur_active_url = str(cur_jb.get("current_track_url") or room_data.get("current_track_url") or "").strip()

        if cur_active_url and cur_expires > now_ms:
            prev_price = int(round(float(cur_jb.get("order_price") or JUKEBOX_BASE_PRICE)))
            required_cost = min(JUKEBOX_MAX_PRICE, max(JUKEBOX_BASE_PRICE * 2, prev_price * 2))
            is_override = True
        else:
            required_cost = JUKEBOX_BASE_PRICE
            is_override = False

        tx_state = {"status": "error", "coins": 0, "display_name": ""}

        def _deduct_jukebox(pdata):
            if not isinstance(pdata, dict):
                tx_state["status"] = "player_not_found"
                return None

            wallet = pdata.get("wallet") if isinstance(pdata.get("wallet"), dict) else {}
            cur_coins = int(round(float(pdata.get("coins") if pdata.get("coins") is not None else wallet.get("coins") or 0)))
            cur_coins = max(0, cur_coins)

            uname = str(pdata.get("username") or "").strip().lstrip("@")
            pname = str(pdata.get("name") or f"Игрок {uid}").strip()
            tx_state["display_name"] = f"@{uname}" if uname else pname

            if cur_coins < required_cost:
                tx_state["status"] = "insufficient_coins"
                tx_state["coins"] = cur_coins
                return None

            new_coins = cur_coins - required_cost
            ts_now = int(time.time() * 1000)
            pdata["coins"] = new_coins
            pdata["taps"] = new_coins
            pdata["count"] = new_coins
            pdata["ts"] = ts_now
            if isinstance(pdata.get("wallet"), dict):
                pdata["wallet"]["coins"] = new_coins

            tx_state["status"] = "deducted"
            tx_state["coins"] = new_coins
            return pdata

        committed, _ = fb_run_transaction(f"players/{safe_uid}", _deduct_jukebox)
        if tx_state["status"] == "insufficient_coins":
            return {
                "ok": False,
                "error": "insufficient_coins",
                "message": f"Недостаточно коинов (нужно {fmt_num(required_cost)} 🪙)",
                "coins": tx_state["coins"],
                "required": required_cost,
            }
        if tx_state["status"] == "player_not_found":
            return {
                "ok": False,
                "error": "player_not_found",
                "message": "Профиль игрока не найден в базе",
            }
        if not committed or tx_state["status"] != "deducted":
            return {"ok": False, "error": "tx_failed", "message": "Не удалось списать коины, попробуйте ещё раз"}

        clean_caller = str(ordered_by or "").strip()[:64] or tx_state["display_name"] or f"Игрок {uid}"
        clean_title = str(track_title or "Трек")[:80]
        clean_artist = str(track_artist or "")[:80]
        order_now = int(time.time() * 1000)
        expires_at = order_now + JUKEBOX_DURATION_MS

        jukebox_obj = {
            "order_id": f"jb_{order_now}_{uuid.uuid4().hex[:6]}",
            "track_id": tid,
            "current_track_url": clean_url,
            "track_title": clean_title,
            "track_artist": clean_artist,
            "ordered_by": clean_caller,
            "ordered_by_uid": uid,
            "order_price": required_cost,
            "next_override_price": min(JUKEBOX_MAX_PRICE, required_cost * 2),
            "is_override": is_override,
            "ordered_at": order_now,
            "expires_at": expires_at,
        }

        patched = fb_patch(
            room_path,
            {
                "current_track_url": clean_url,
                "ordered_by": clean_caller,
                "expires_at": expires_at,
                "jukebox": jukebox_obj,
            },
        )
        if patched is None:
            # Компенсационный возврат коинов при сбое записи комнаты
            def _refund_jukebox(pdata):
                if not isinstance(pdata, dict):
                    return None
                c = max(0, int(round(float(pdata.get("coins") or 0)))) + required_cost
                pdata["coins"] = c
                pdata["taps"] = c
                pdata["count"] = c
                if isinstance(pdata.get("wallet"), dict):
                    pdata["wallet"]["coins"] = c
                tx_state["coins"] = c
                return pdata

            fb_run_transaction(f"players/{safe_uid}", _refund_jukebox)
            return {"ok": False, "error": "room_write_failed", "message": "Ошибка обновления стола, коины возвращены"}

        return {
            "ok": True,
            "coins": tx_state["coins"],
            "cost": required_cost,
            "is_override": is_override,
            "current_track_url": clean_url,
            "ordered_by": clean_caller,
            "expires_at": expires_at,
            "jukebox": jukebox_obj,
        }
