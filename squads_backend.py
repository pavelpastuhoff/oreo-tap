# -*- coding: utf-8 -*-
"""Бэкенд системы сквадов (кланов) ОРЕО.

Подключается из bot.py: squads_backend.init(...), handle_api(...), handle_callback(...),
handle_start(...), start_sweeper(). Хранилище — Firebase RTDB (через admin_poker_bot.fb_*).

Узлы Firebase:
  config/squads/SQUAD_AUTO_APPROVE  — флаг автоодобрения (bool, по умолчанию False)
  squads/{sid}                      — полный документ сквада
  squad_public/{sid}                — публичная карточка активного сквада (теги/цвета/рейтинг)
  squad_building/{sid}              — публичная карточка сквада на стадии сбора (pending_funding)
  squad_of/{uid}                    — uid -> sid
  squad_codes/{code}                — инвайт-код -> sid
  squad_names|squad_tags/{hash}     — резерв уникальности
  squad_refunds/{sid}               — маркер незавершённых возвратов
  squad_inbox/{uid}                 — асинхронные изменения баланса (клиент применяет и очищает)
  squad_mmr_done/{key}              — идемпотентность начисления MMR
"""
import hashlib
import hmac
import html
import json
import re
import secrets
import threading
import time
import urllib.parse

import admin_poker_bot as apb

# ─── КОНФИГ ───────────────────────────────────────────────────────────────────
SQUAD_AUTO_APPROVE_DEFAULT = False   # переопределяется env SQUAD_AUTO_APPROVE и Firebase config/squads
FOUNDER_STAKE = 50_000
FOUNDERS_NEEDED = 3
START_BANK = FOUNDER_STAKE * FOUNDERS_NEEDED
FUNDING_TTL_MS = 72 * 3600 * 1000
BASE_SEATS = 15
MAX_SEATS = 30
LEVY_MIN, LEVY_MAX = 1_000, 100_000
LEVY_COOLDOWN_MS = 24 * 3600 * 1000
ACTIVE_WINDOW_MS = 7 * 24 * 3600 * 1000
FEE_MIN, FEE_MAX = 1_000, 1_000_000
DEFAULT_JOIN_FEE = 25_000
TAP_REPORT_MIN_INTERVAL = 30
TAP_REPORT_MAX = 50_000_000

COLORS = {"base": 0, "rare": 250_000, "neon": 500_000, "gold": 1_000_000}
THEMES = {"cyber": 150_000, "poker": 250_000, "syndicate": 300_000, "vault": 400_000}
SEAT_UPGRADES = {20: (15, 200_000), 30: (20, 500_000)}   # новый размер -> (требуемый текущий, цена)

MMR_DUEL_WIN, MMR_DUEL_LOSS = 25, -10
MMR_LOTO_WIN, MMR_LOTO_LOSS = 15, -5

_LOCK = threading.RLock()
_call = None
_admin_id = 0
_bot_username = "oreo_67_bot"
_build_url = None
_token = ""
_default_auto = SQUAD_AUTO_APPROVE_DEFAULT
_cfg_cache = {"ts": 0.0, "auto": SQUAD_AUTO_APPROVE_DEFAULT}
_tap_last = {}
_ping_last = {}


def init(call_fn, admin_id, bot_username, build_url_fn, token, auto_approve_default=False):
    global _call, _admin_id, _bot_username, _build_url, _token, _default_auto
    _call, _admin_id, _bot_username, _build_url, _token = call_fn, int(admin_id), bot_username, build_url_fn, token or ""
    _default_auto = bool(auto_approve_default)
    _cfg_cache["auto"] = _default_auto
    try:
        if apb.fb_get("config/squads") is None:
            apb.fb_put("config/squads", {"SQUAD_AUTO_APPROVE": _default_auto})
    except Exception as e:
        print("[Squads] init config error:", apb._redact_err(e))


def auto_approve() -> bool:
    now = time.time()
    if now - _cfg_cache["ts"] > 20:
        v = apb.fb_get("config/squads/SQUAD_AUTO_APPROVE")
        _cfg_cache["auto"] = v if isinstance(v, bool) else _default_auto
        _cfg_cache["ts"] = now
    return bool(_cfg_cache["auto"])


# ─── УТИЛИТЫ ──────────────────────────────────────────────────────────────────
def _now() -> int:
    return int(time.time() * 1000)


def _esc(s) -> str:
    return html.escape(str(s if s is not None else ""), quote=False)


def _fmt(n) -> str:
    return f"{int(n):,}".replace(",", " ")


def _key(s) -> str:
    return apb._fb_key(str(s))


def _hash(s: str) -> str:
    return hashlib.md5(s.encode("utf-8")).hexdigest()[:20]


def _week_key() -> str:
    t = time.gmtime()
    return f"{t.tm_year}-{time.strftime('%W', t)}"


def _fb_delete(path):
    return apb.fb_request(path, "DELETE")


def _notify(uid, text, button_text=None, button_params=None, silent=False, markup=None):
    if not _call:
        return
    try:
        params = dict(chat_id=int(uid), text=text, parse_mode="HTML", disable_notification=bool(silent))
        if markup:
            params["reply_markup"] = markup
        elif button_text:
            params["reply_markup"] = {"inline_keyboard": [[{"text": button_text, "web_app": {"url": _build_url(**(button_params or {"squad": "open"}))}}]]}
        _call("sendMessage", **params)
    except Exception as e:
        print("[Squads] notify error:", apb._redact_err(e))


def verify_init_data(raw: str):
    """Проверка подписи Telegram initData. Возвращает dict пользователя или None."""
    if not raw or not _token:
        return None
    try:
        d = dict(urllib.parse.parse_qsl(raw, keep_blank_values=True))
        got = d.pop("hash", "")
        check = "\n".join(f"{k}={v}" for k, v in sorted(d.items()))
        secret = hmac.new(b"WebAppData", _token.encode("utf-8"), hashlib.sha256).digest()
        calc = hmac.new(secret, check.encode("utf-8"), hashlib.sha256).hexdigest()
        if not got or not hmac.compare_digest(calc, got):
            return None
        if time.time() - int(d.get("auth_date", "0") or 0) > 7 * 86400:
            return None
        u = json.loads(d.get("user") or "{}")
        return u if isinstance(u, dict) and u.get("id") else None
    except Exception:
        return None


# ─── КОШЕЛЁК (Firebase players/{uid}) ─────────────────────────────────────────
def _coins_of(p) -> int:
    w = p.get("wallet") if isinstance(p.get("wallet"), dict) else {}
    v = p.get("coins") if p.get("coins") is not None else w.get("coins")
    try:
        return max(0, int(round(float(v or 0))))
    except Exception:
        return 0


def _set_coins(p, new):
    p["coins"] = p["taps"] = p["count"] = new
    p["ts"] = _now()
    if isinstance(p.get("wallet"), dict):
        p["wallet"]["coins"] = new


def _inbox_add(uid, delta, reason):
    if delta:
        apb.fb_put(f"squad_inbox/{_key(uid)}/{secrets.token_hex(4)}", {"delta": int(delta), "reason": reason, "ts": _now()})


def debit(uid, amount, partial=False, reason=None):
    """Списание с баланса. Возвращает (ok, taken). reason -> запись в inbox (для асинхронных операций)."""
    amount = int(amount)
    st = {"taken": 0, "ok": False}

    def mut(p):
        st["taken"], st["ok"] = 0, False
        if not isinstance(p, dict):
            st["ok"] = partial
            return None
        cur = _coins_of(p)
        take = min(cur, amount) if partial else amount
        if take <= 0 or (not partial and cur < amount):
            st["ok"] = partial and take <= 0
            return None
        _set_coins(p, cur - take)
        st["taken"], st["ok"] = take, True
        return p

    committed, _ = apb.fb_run_transaction(f"players/{_key(uid)}", mut)
    if st["taken"] > 0 and not committed:
        return False, 0
    if st["taken"] > 0 and reason:
        _inbox_add(uid, -st["taken"], reason)
    return st["ok"], st["taken"]


def credit(uid, amount, reason=None):
    amount = int(amount)
    if amount <= 0:
        return True

    def mut(p):
        if not isinstance(p, dict):
            p = {"id": str(uid), "coins": 0}
        _set_coins(p, _coins_of(p) + amount)
        return p

    committed, _ = apb.fb_run_transaction(f"players/{_key(uid)}", mut)
    if committed and reason:
        _inbox_add(uid, amount, reason)
    return bool(committed)


# ─── ДОКУМЕНТ СКВАДА ──────────────────────────────────────────────────────────
def _get(sid):
    sq = apb.fb_get(f"squads/{_key(sid)}")
    return sq if isinstance(sq, dict) else None


def _tx(sid, fn):
    """fn(sq)->новый sq или None. Возвращает (committed, snapshot)."""
    return apb.fb_run_transaction(f"squads/{_key(sid)}", lambda cur: fn(cur) if isinstance(cur, dict) else None)


def _active_ids(sq, now=None):
    now = now or _now()
    return [u for u, m in (sq.get("members") or {}).items() if now - int(m.get("last_seen") or m.get("joined") or 0) <= ACTIVE_WINDOW_MS]


def tap_multiplier(active_count: int) -> float:
    if active_count >= 30:
        return 1.35
    if active_count >= 20:
        return 1.25
    if active_count >= 10:
        return 1.15
    if active_count >= 3:
        return 1.05
    return 1.0


def _weekly(sq) -> int:
    w = sq.get("weekly") or {}
    return int(w.get("amount") or 0) if w.get("wk") == _week_key() else 0


def _score(sq) -> int:
    return int(sq.get("bank") or 0) + _weekly(sq) + int(sq.get("mmr") or 0)


def _pub(sq) -> dict:
    return {
        "id": sq["id"], "name": sq["name"], "tag": sq["tag"], "emoji": sq.get("emoji") or "🛡",
        "motto": sq.get("motto") or "", "color": sq.get("color") or "base", "theme": sq.get("theme") or "",
        "n": len(sq.get("members") or {}), "max": int(sq.get("max_members") or BASE_SEATS),
        "bank": int(sq.get("bank") or 0), "mmr": int(sq.get("mmr") or 0), "score": _score(sq),
        "mode": sq.get("join_mode") or "free", "fee": int(sq.get("join_fee") or 0),
        "status": sq.get("status"),
    }


def _publish(sq):
    sid = _key(sq["id"])
    st = sq.get("status")
    if st == "active":
        apb.fb_put(f"squad_public/{sid}", _pub(sq))
        _fb_delete(f"squad_building/{sid}")
    elif st == "pending_funding":
        b = _pub(sq)
        b["filled"] = len(sq.get("contributions") or {})
        b["expires_at"] = int(sq.get("expires_at") or 0)
        b["leader_name"] = (sq["members"].get(sq["leader"]) or {}).get("name", "")
        apb.fb_put(f"squad_building/{sid}", b)
    else:
        _fb_delete(f"squad_public/{sid}")
        _fb_delete(f"squad_building/{sid}")


def _release_names(sq):
    _fb_delete(f"squad_names/{_hash(sq['name'].lower())}")
    _fb_delete(f"squad_tags/{_hash(sq['tag'])}")


def _view(sq, uid=None, full=False) -> dict:
    now = _now()
    members = sq.get("members") or {}
    act = set(_active_ids(sq, now))
    out = {
        "id": sq["id"], "name": sq["name"], "tag": sq["tag"], "emoji": sq.get("emoji") or "🛡",
        "motto": sq.get("motto") or "", "status": sq.get("status"), "leader": sq.get("leader"),
        "color": sq.get("color") or "base", "theme": sq.get("theme") or "",
        "max_members": int(sq.get("max_members") or BASE_SEATS), "bank": int(sq.get("bank") or 0),
        "mmr": int(sq.get("mmr") or 0), "weekly": _weekly(sq), "score": _score(sq),
        "join_mode": sq.get("join_mode") or "free", "join_fee": int(sq.get("join_fee") or 0),
        "expires_at": int(sq.get("expires_at") or 0),
        "filled": len(sq.get("contributions") or {}),
        "active_count": len(act), "multiplier": tap_multiplier(len(act)) if sq.get("status") == "active" else 1.0,
        "members": sorted([
            {"id": u, "name": m.get("name") or u, "username": m.get("username") or "",
             "role": "leader" if u == sq.get("leader") else "member",
             "debt": int(m.get("debt") or 0), "active": u in act, "joined": int(m.get("joined") or 0)}
            for u, m in members.items()
        ], key=lambda x: (x["role"] != "leader", x["joined"])),
    }
    if full:
        out["owned_colors"] = list((sq.get("owned_colors") or {}).keys()) or ["base"]
        out["owned_themes"] = list((sq.get("owned_themes") or {}).keys())
        out["levy"] = sq.get("levy") or {}
        out["levy_next_at"] = int((sq.get("levy") or {}).get("ts") or 0) + LEVY_COOLDOWN_MS
        if uid == sq.get("leader"):
            out["requests"] = [{"id": u, "name": r.get("name") or u} for u, r in (sq.get("requests") or {}).items()]
        if sq.get("status") == "pending_funding" and sq.get("invite_code"):
            out["invite_link"] = f"https://t.me/{_bot_username}?start=sq_{sq['invite_code']}"
    return out


def _user_name(user) -> str:
    n = str(user.get("first_name") or user.get("username") or "Игрок")
    return n[:32]


def _member(user, now=None) -> dict:
    now = now or _now()
    return {"name": _user_name(user), "username": str(user.get("username") or "")[:32], "joined": now, "last_seen": now, "debt": 0}


def _sid_of(uid):
    v = apb.fb_get(f"squad_of/{_key(uid)}")
    return str(v) if v else None


def _fail(error, **kw):
    d = {"ok": False, "error": error}
    d.update(kw)
    return d


# ─── ОТМЕНА / ВОЗВРАТЫ ────────────────────────────────────────────────────────
def _process_refunds(sid):
    sq = _get(sid)
    if not sq:
        _fb_delete(f"squad_refunds/{_key(sid)}")
        return
    for uid, amount in list((sq.get("refunds") or {}).items()):
        claimed = {"v": False}

        def claim(cur, uid=uid):
            if cur.get("refunds") and uid in cur["refunds"]:
                del cur["refunds"][uid]
                claimed["v"] = True
                return cur
            return None

        _tx(sid, claim)
        if not claimed["v"]:
            continue
        if credit(uid, amount, reason="squad_refund"):
            _notify(uid, f"💰 Возврат взноса по скваду <b>{_esc(sq['tag'])}</b>: +{_fmt(amount)} 🍪")
        else:
            def restore(cur, uid=uid, amount=amount):
                cur.setdefault("refunds", {})[uid] = amount
                return cur
            _tx(sid, restore)
    sq = _get(sid)
    if sq is not None and not sq.get("refunds"):
        _fb_delete(f"squad_refunds/{_key(sid)}")


def _cancel(sid, new_status, reason_text):
    """Отмена заявки/стройки с возвратом всем вкладчикам."""
    with _LOCK:
        done = {"ok": False}

        def fn(sq):
            if sq.get("status") not in ("pending_admin", "pending_funding"):
                return None
            sq["refunds"] = dict(sq.get("contributions") or {})
            sq["contributions"] = {}
            sq["status"] = new_status
            sq["closed_at"] = _now()
            done["ok"] = True
            return sq

        committed, snap = _tx(sid, fn)
        if not (committed and done["ok"]):
            return False
        _publish(snap)
        _release_names(snap)
        if snap.get("invite_code"):
            _fb_delete(f"squad_codes/{snap['invite_code']}")
        for uid in (snap.get("members") or {}).keys():
            _fb_delete(f"squad_of/{_key(uid)}")
            _notify(uid, f"🛡 Сквад <b>{_esc(snap['tag'])}</b> не запущен: {_esc(reason_text)}. Взнос возвращается.")
        apb.fb_put(f"squad_refunds/{_key(sid)}", True)
        _process_refunds(sid)
        return True


# ─── ОДОБРЕНИЕ АДМИНОМ ────────────────────────────────────────────────────────
def _admin_card(sq):
    ld = (sq.get("members") or {}).get(sq["leader"]) or {}
    text = (
        "🛡 <b>Заявка на создание сквада</b>\n\n"
        f"{_esc(sq.get('emoji') or '🛡')} <b>[{_esc(sq['tag'])}] {_esc(sq['name'])}</b>\n"
        f"💬 «{_esc(sq.get('motto') or '—')}»\n"
        f"👤 Инициатор: {_esc(ld.get('name'))} (<code>{_esc(sq['leader'])}</code>)\n"
        f"🔒 В эскроу: {_fmt(FOUNDER_STAKE)} 🍪\n"
        f"🆔 <code>{_esc(sq['id'])}</code>"
    )
    kb = {"inline_keyboard": [[
        {"text": "✅ Одобрить сбор", "callback_data": f"sq_ok:{sq['id']}"},
        {"text": "❌ Отклонить", "callback_data": f"sq_no:{sq['id']}"},
    ]]}
    try:
        _call("sendMessage", chat_id=_admin_id, text=text, parse_mode="HTML", reply_markup=kb)
    except Exception as e:
        print("[Squads] admin card error:", apb._redact_err(e))


def approve(sid) -> bool:
    with _LOCK:
        ok = {"v": False}

        def fn(sq):
            if sq.get("status") != "pending_admin":
                return None
            now = _now()
            sq["status"] = "pending_funding"
            sq["approved_at"] = now
            sq["expires_at"] = now + FUNDING_TTL_MS
            sq["invite_code"] = secrets.token_hex(5)
            ok["v"] = True
            return sq

        committed, snap = _tx(sid, fn)
        if not (committed and ok["v"]):
            return False
        apb.fb_put(f"squad_codes/{snap['invite_code']}", snap["id"])
        _publish(snap)
        link = f"https://t.me/{_bot_username}?start=sq_{snap['invite_code']}"
        _notify(
            snap["leader"],
            f"✅ Заявка на сквад <b>[{_esc(snap['tag'])}] {_esc(snap['name'])}</b> одобрена!\n\n"
            f"Нужно 3 игрока (ты + 2 сооснователя), каждый вносит {_fmt(FOUNDER_STAKE)} 🍪. На сбор — 72 часа.\n"
            f"🔗 Ссылка для сооснователей:\n{link}",
            button_text="🛡 Открыть сквад",
        )
        return True


def reject(sid) -> bool:
    return _cancel(sid, "rejected", "заявка отклонена администратором")


def handle_callback(cb) -> bool:
    data = str(cb.get("data") or "")
    if not (data.startswith("sq_ok:") or data.startswith("sq_no:")):
        return False
    cb_id = cb.get("id")
    frm = (cb.get("from") or {}).get("id")

    def answer(text):
        try:
            _call("answerCallbackQuery", callback_query_id=cb_id, text=text, show_alert=False)
        except Exception:
            pass

    if int(frm or 0) != _admin_id:
        answer("⛔ Нет прав")
        return True
    sid = data.split(":", 1)[1]
    ok = approve(sid) if data.startswith("sq_ok:") else reject(sid)
    verdict = ("✅ Одобрено" if data.startswith("sq_ok:") else "❌ Отклонено") if ok else "⚠️ Уже обработано"
    answer(verdict)
    msg = cb.get("message") or {}
    try:
        _call("editMessageText", chat_id=(msg.get("chat") or {}).get("id"), message_id=msg.get("message_id"),
              text=f"{_esc(msg.get('text') or 'Заявка на сквад')}\n\n<b>{verdict}</b>", parse_mode="HTML")
    except Exception:
        pass
    return True


def handle_start(msg, param) -> bool:
    """/start sq_<code> — приглашение в сквад."""
    if not str(param or "").startswith("sq_"):
        return False
    code = re.sub(r"[^0-9a-f]", "", str(param)[3:])[:16]
    chat_id = (msg.get("chat") or {}).get("id")
    sid = apb.fb_get(f"squad_codes/{code}") if code else None
    sq = _get(sid) if sid else None
    if not sq or sq.get("status") != "pending_funding":
        _notify(chat_id, "🛡 Приглашение недействительно или сбор уже завершён.")
        return True
    _notify(
        chat_id,
        f"🛡 Тебя зовут в сквад <b>[{_esc(sq['tag'])}] {_esc(sq['name'])}</b>!\n"
        f"Сооснователи: {len(sq.get('contributions') or {})}/{FOUNDERS_NEEDED}. Взнос: {_fmt(FOUNDER_STAKE)} 🍪.",
        button_text="🛡 Вступить в сквад", button_params={"squad": code},
    )
    return True


# ─── ЭНДПОИНТЫ ────────────────────────────────────────────────────────────────
def a_me(uid, user, p):
    out = {"ok": True, "squad": None, "auto_approve": auto_approve(), "inbox": 0}
    # inbox: атомарно забираем асинхронные изменения баланса
    box = {"sum": 0}

    def drain(cur):
        if not isinstance(cur, dict):
            return None
        box["sum"] = sum(int(v.get("delta") or 0) for v in cur.values() if isinstance(v, dict))
        return {}

    apb.fb_run_transaction(f"squad_inbox/{_key(uid)}", drain)
    out["inbox"] = box["sum"]
    sid = _sid_of(uid)
    if not sid:
        return out
    sq = _get(sid)
    if not sq or uid not in (sq.get("members") or {}) or sq.get("status") not in ("pending_admin", "pending_funding", "active"):
        _fb_delete(f"squad_of/{_key(uid)}")
        return out
    if sq.get("status") == "active":
        now = _now()
        m = sq["members"][uid]
        if now - int(m.get("last_seen") or 0) > 10 * 60 * 1000 or m.get("name") != _user_name(user):
            def touch(cur):
                mm = (cur.get("members") or {}).get(uid)
                if not mm:
                    return None
                mm["last_seen"] = now
                mm["name"] = _user_name(user)
                return cur
            _tx(sid, touch)
            sq = _get(sid) or sq
    out["squad"] = _view(sq, uid, full=True)
    return out


def a_building(uid, user, p):
    raw = apb.fb_get("squad_building") or {}
    now = _now()
    items = [v for v in raw.values() if isinstance(v, dict) and int(v.get("expires_at") or 0) > now]
    items.sort(key=lambda x: -int(x.get("filled") or 0))
    return {"ok": True, "items": items[:50]}


def a_top(uid, user, p):
    raw = apb.fb_get("squad_public") or {}
    items = [v for v in raw.values() if isinstance(v, dict)]
    items.sort(key=lambda x: -int(x.get("score") or 0))
    return {"ok": True, "items": items[:50]}


def a_view(uid, user, p):
    sid = str(p.get("sid") or "")
    sq = _get(sid) if sid else None
    if not sq or sq.get("status") not in ("active", "pending_funding"):
        return _fail("not_found")
    return {"ok": True, "squad": _view(sq, uid, full=False)}


def a_by_code(uid, user, p):
    code = re.sub(r"[^0-9a-f]", "", str(p.get("code") or ""))[:16]
    sid = apb.fb_get(f"squad_codes/{code}") if code else None
    sq = _get(sid) if sid else None
    if not sq or sq.get("status") != "pending_funding":
        return _fail("invalid_code")
    return {"ok": True, "squad": _view(sq, uid, full=False)}


_NAME_RE = re.compile(r"[0-9A-Za-zА-Яа-яЁё _.\-]{3,20}")
_TAG_RE = re.compile(r"[A-Za-z0-9]{2,5}")


def a_create(uid, user, p):
    name = re.sub(r"\s+", " ", str(p.get("name") or "")).strip()
    tag = str(p.get("tag") or "").strip().upper()
    motto = re.sub(r"[<>\x00-\x1f]", "", str(p.get("motto") or "")).strip()[:40]
    emoji = str(p.get("emoji") or "🛡").strip()[:8] or "🛡"
    if not _NAME_RE.fullmatch(name):
        return _fail("bad_name", message="Название: 3–20 символов (буквы, цифры, пробел, - _ .)")
    if not _TAG_RE.fullmatch(tag):
        return _fail("bad_tag", message="Тег: 2–5 латинских букв/цифр")
    with _LOCK:
        if _sid_of(uid):
            return _fail("already_in_squad", message="Ты уже состоишь в скваде или подал заявку")
        sid = "s" + secrets.token_hex(4)
        nk, tk = f"squad_names/{_hash(name.lower())}", f"squad_tags/{_hash(tag)}"

        def reserve(path):
            r = {"ok": False}

            def fn(cur):
                if cur:
                    return None
                r["ok"] = True
                return sid
            apb.fb_run_transaction(path, fn)
            return r["ok"]

        if not reserve(nk):
            return _fail("name_taken", message="Такое название уже занято")
        if not reserve(tk):
            _fb_delete(nk)
            return _fail("tag_taken", message="Такой тег уже занят")
        ok, taken = debit(uid, FOUNDER_STAKE)
        if not ok:
            _fb_delete(nk)
            _fb_delete(tk)
            return _fail("insufficient_coins", message=f"Нужно {_fmt(FOUNDER_STAKE)} 🍪 для эскроу")
        now = _now()
        sq = {
            "id": sid, "name": name, "tag": tag, "emoji": emoji, "motto": motto, "status": "pending_admin",
            "leader": uid, "created_at": now, "members": {uid: _member(user, now)},
            "contributions": {uid: FOUNDER_STAKE}, "bank": 0, "mmr": 0, "max_members": BASE_SEATS,
            "join_mode": "free", "join_fee": DEFAULT_JOIN_FEE, "color": "base", "theme": "",
            "owned_colors": {"base": True}, "weekly": {"wk": _week_key(), "amount": 0},
        }
        if apb.fb_put(f"squads/{sid}", sq) is None:
            credit(uid, FOUNDER_STAKE)
            _fb_delete(nk)
            _fb_delete(tk)
            return _fail("storage_error", message="Не удалось сохранить заявку, эскроу возвращён")
        apb.fb_put(f"squad_of/{_key(uid)}", sid)
    if auto_approve():
        approve(sid)
        status = "pending_funding"
    else:
        _admin_card(sq)
        _notify(uid, f"🛡 Заявка на сквад <b>[{_esc(tag)}] {_esc(name)}</b> отправлена администратору. "
                     f"{_fmt(FOUNDER_STAKE)} 🍪 заморожено в эскроу.")
        status = "pending_admin"
    return {"ok": True, "status": status, "sid": sid, "delta": -FOUNDER_STAKE}


def a_cancel(uid, user, p):
    sid = _sid_of(uid)
    sq = _get(sid) if sid else None
    if not sq or sq.get("leader") != uid or sq.get("status") != "pending_admin":
        return _fail("not_allowed")
    return {"ok": _cancel(sid, "cancelled", "заявка отменена инициатором")}


def _join_building(uid, user, sq):
    sid = sq["id"]
    ok, _ = debit(uid, FOUNDER_STAKE)
    if not ok:
        return _fail("insufficient_coins", message=f"Нужно {_fmt(FOUNDER_STAKE)} 🍪")
    res = {"err": None, "activated": False}

    def fn(cur):
        if cur.get("status") != "pending_funding" or int(cur.get("expires_at") or 0) < _now():
            res["err"] = "closed"
            return None
        if uid in (cur.get("members") or {}) or len(cur.get("contributions") or {}) >= FOUNDERS_NEEDED:
            res["err"] = "full"
            return None
        cur["members"][uid] = _member(user)
        cur.setdefault("contributions", {})[uid] = FOUNDER_STAKE
        if len(cur["contributions"]) >= FOUNDERS_NEEDED:
            cur["status"] = "active"
            cur["activated_at"] = _now()
            cur["bank"] = START_BANK
            cur["contributions"] = {}
            res["activated"] = True
        return cur

    committed, snap = _tx(sid, fn)
    if not committed:
        credit(uid, FOUNDER_STAKE)
        return _fail(res["err"] or "tx_failed", message="Не удалось вступить, взнос возвращён")
    apb.fb_put(f"squad_of/{_key(uid)}", sid)
    _publish(snap)
    if res["activated"]:
        if snap.get("invite_code"):
            _fb_delete(f"squad_codes/{snap['invite_code']}")
        for m in snap["members"]:
            _notify(m, f"🎉 Сквад <b>[{_esc(snap['tag'])}] {_esc(snap['name'])}</b> активирован! "
                       f"В казну зачислено {_fmt(START_BANK)} 🍪.", button_text="🛡 Открыть сквад")
    else:
        n = len(snap.get("contributions") or {})
        _notify(snap["leader"], f"🛡 {_esc(_user_name(user))} вступил в сбор сквада {_esc(snap['tag'])}: {n}/{FOUNDERS_NEEDED}")
    return {"ok": True, "delta": -FOUNDER_STAKE, "activated": res["activated"]}


def _join_active(uid, user, sq):
    sid = sq["id"]
    mode = sq.get("join_mode") or "free"
    if len(sq.get("members") or {}) >= int(sq.get("max_members") or BASE_SEATS):
        return _fail("full", message="В скваде нет мест")
    if mode == "request":
        res = {"v": False}

        def fn(cur):
            if cur.get("status") != "active" or uid in (cur.get("members") or {}):
                return None
            cur.setdefault("requests", {})[uid] = {"name": _user_name(user), "ts": _now()}
            res["v"] = True
            return cur
        _tx(sid, fn)
        if res["v"]:
            _notify(sq["leader"], f"🛡 Заявка в сквад {_esc(sq['tag'])}: {_esc(_user_name(user))}", button_text="🛡 Открыть сквад")
        return {"ok": res["v"], "pending": True}
    fee = int(sq.get("join_fee") or 0) if mode == "paid" else 0
    if fee:
        ok, _ = debit(uid, fee)
        if not ok:
            return _fail("insufficient_coins", message=f"Нужно {_fmt(fee)} 🍪")
    res = {"v": False}

    def fn2(cur):
        if cur.get("status") != "active" or uid in (cur.get("members") or {}):
            return None
        if len(cur["members"]) >= int(cur.get("max_members") or BASE_SEATS):
            return None
        cur["members"][uid] = _member(user)
        cur["bank"] = int(cur.get("bank") or 0) + fee
        res["v"] = True
        return cur

    committed, snap = _tx(sid, fn2)
    if not (committed and res["v"]):
        if fee:
            credit(uid, fee)
        return _fail("tx_failed", message="Не удалось вступить")
    apb.fb_put(f"squad_of/{_key(uid)}", sid)
    _publish(snap)
    return {"ok": True, "delta": -fee}


def a_join(uid, user, p):
    with _LOCK:
        if _sid_of(uid):
            return _fail("already_in_squad", message="Сначала выйди из текущего сквада")
        sid = str(p.get("sid") or "")
        code = re.sub(r"[^0-9a-f]", "", str(p.get("code") or ""))[:16]
        if code and not sid:
            sid = str(apb.fb_get(f"squad_codes/{code}") or "")
        sq = _get(sid) if sid else None
        if not sq:
            return _fail("not_found", message="Сквад не найден")
        if sq.get("status") == "pending_funding":
            return _join_building(uid, user, sq)
        if sq.get("status") == "active":
            return _join_active(uid, user, sq)
        return _fail("closed", message="Набор закрыт")


def a_leave(uid, user, p):
    with _LOCK:
        sid = _sid_of(uid)
        sq = _get(sid) if sid else None
        if not sq or uid not in (sq.get("members") or {}):
            _fb_delete(f"squad_of/{_key(uid)}")
            return {"ok": True}
        if sq["status"] == "pending_funding":
            return {"ok": _cancel(sid, "cancelled_left", "один из участников вышел до старта")}
        if sq["status"] == "pending_admin":
            return _fail("use_cancel")
        if sq["status"] != "active":
            return _fail("not_allowed")
        if sq["leader"] == uid:
            if len(sq["members"]) > 1:
                return _fail("leader_cannot_leave", message="Лидер не может выйти, пока в скваде есть участники. Исключи их или распусти сквад в одиночку.")
            committed, snap = _tx(sid, lambda cur: {**cur, "status": "disbanded"})
            if committed:
                _publish(snap)
                _release_names(snap)
                _fb_delete(f"squad_of/{_key(uid)}")
            return {"ok": bool(committed)}
        def fn(cur):
            if uid not in cur.get("members", {}):
                return None
            del cur["members"][uid]
            (cur.get("requests") or {}).pop(uid, None)
            return cur
        committed, snap = _tx(sid, fn)
        if committed:
            _fb_delete(f"squad_of/{_key(uid)}")
            _publish(snap)
        return {"ok": bool(committed)}


def _leader_squad(uid):
    sid = _sid_of(uid)
    sq = _get(sid) if sid else None
    if not sq or sq.get("status") != "active" or sq.get("leader") != uid:
        return None
    return sq


def a_kick(uid, user, p):
    target = str(p.get("uid") or "")
    with _LOCK:
        sq = _leader_squad(uid)
        if not sq or target == uid or target not in sq["members"]:
            return _fail("not_allowed")
        def fn(cur):
            cur["members"].pop(target, None)
            return cur
        committed, snap = _tx(sq["id"], fn)
        if committed:
            _fb_delete(f"squad_of/{_key(target)}")
            _publish(snap)
            _notify(target, f"🛡 Тебя исключили из сквада <b>{_esc(snap['tag'])}</b>.")
        return {"ok": bool(committed)}


def a_resolve_request(uid, user, p):
    target, accept = str(p.get("uid") or ""), bool(p.get("accept"))
    with _LOCK:
        sq = _leader_squad(uid)
        if not sq or target not in (sq.get("requests") or {}):
            return _fail("not_found")
        if accept and _sid_of(target):
            accept = False
        res = {"v": False}
        info = sq["requests"][target]

        def fn(cur):
            req = (cur.get("requests") or {}).pop(target, None)
            if not req:
                return None
            if accept:
                if len(cur["members"]) >= int(cur.get("max_members") or BASE_SEATS):
                    return None
                cur["members"][target] = _member({"first_name": req.get("name")})
            res["v"] = True
            return cur
        committed, snap = _tx(sq["id"], fn)
        if not (committed and res["v"]):
            return _fail("tx_failed", message="Нет мест или заявка устарела")
        if accept:
            apb.fb_put(f"squad_of/{_key(target)}", sq["id"])
            _publish(snap)
            _notify(target, f"✅ Тебя приняли в сквад <b>[{_esc(snap['tag'])}] {_esc(snap['name'])}</b>!", button_text="🛡 Открыть сквад")
        else:
            _notify(target, f"❌ Заявка в сквад {_esc(snap['tag'])} отклонена.")
        return {"ok": True}


def a_set_mode(uid, user, p):
    mode = str(p.get("mode") or "")
    if mode not in ("free", "request", "paid"):
        return _fail("bad_mode")
    try:
        fee = int(p.get("fee") or DEFAULT_JOIN_FEE)
    except Exception:
        fee = DEFAULT_JOIN_FEE
    fee = max(FEE_MIN, min(FEE_MAX, fee))
    with _LOCK:
        sq = _leader_squad(uid)
        if not sq:
            return _fail("not_allowed")
        def fn(cur):
            cur["join_mode"] = mode
            cur["join_fee"] = fee
            return cur
        committed, snap = _tx(sq["id"], fn)
        if committed:
            _publish(snap)
        return {"ok": bool(committed)}


def a_levy(uid, user, p):
    try:
        amount = int(p.get("amount"))
    except Exception:
        return _fail("bad_amount")
    goal = re.sub(r"[<>\x00-\x1f]", "", str(p.get("goal") or "")).strip()[:40] or "казну"
    if amount < LEVY_MIN or amount > LEVY_MAX:
        return _fail("bad_amount", message=f"Сбор от {_fmt(LEVY_MIN)} до {_fmt(LEVY_MAX)} 🍪")
    with _LOCK:
        sq = _leader_squad(uid)
        if not sq:
            return _fail("not_allowed")
        now = _now()
        res = {"err": None}

        def claim(cur):
            last = int((cur.get("levy") or {}).get("ts") or 0)
            if now - last < LEVY_COOLDOWN_MS:
                res["err"] = last + LEVY_COOLDOWN_MS
                return None
            cur["levy"] = {"ts": now, "amount": amount, "goal": goal, "by": uid}
            return cur
        committed, snap = _tx(sq["id"], claim)
        if not committed:
            return _fail("cooldown", retry_at=res["err"], message="Сбор можно объявлять не чаще раза в 24 часа")
        total, results = 0, {}
        for mid in list(snap["members"].keys()):
            ok, taken = debit(mid, amount, partial=True, reason="squad_levy")
            taken = taken if ok else 0
            results[mid] = taken
            total += taken

        def apply(cur):
            cur["bank"] = int(cur.get("bank") or 0) + total
            for mid, taken in results.items():
                mm = cur["members"].get(mid)
                if mm:
                    mm["debt"] = int(mm.get("debt") or 0) + (amount - taken)
            return cur
        committed2, snap2 = _tx(sq["id"], apply)
        if committed2:
            _publish(snap2)
        debtors = 0
        for mid, taken in results.items():
            short = amount - taken
            if short <= 0:
                _notify(mid, f"🍪 Сбор в казну <b>{_esc(snap['tag'])}</b>: списано {_fmt(taken)} 🍪 ({_esc(goal)})", silent=True)
            else:
                debtors += 1
                _notify(
                    mid,
                    f"🛡 Лидер сквада <b>{_esc(snap['tag'])}</b> объявил сбор по {_fmt(amount)} 🍪 на «{_esc(goal)}»! "
                    f"Тебе не хватает {_fmt(short)} 🍪. Залетай в игру и закрой взнос!",
                    button_text="🎮 Закрыть взнос", button_params={"squad": "open"},
                )
        return {"ok": True, "collected": total, "debtors": debtors}


def a_pay_debt(uid, user, p):
    with _LOCK:
        sid = _sid_of(uid)
        sq = _get(sid) if sid else None
        if not sq or sq.get("status") != "active":
            return _fail("not_allowed")
        debt = int((sq["members"].get(uid) or {}).get("debt") or 0)
        if debt <= 0:
            return _fail("no_debt", message="Долга нет")
        ok, taken = debit(uid, debt, partial=True)
        if not ok or taken <= 0:
            return _fail("insufficient_coins", message="Нет монет для взноса")

        def fn(cur):
            mm = cur["members"].get(uid)
            if not mm:
                return None
            mm["debt"] = max(0, int(mm.get("debt") or 0) - taken)
            cur["bank"] = int(cur.get("bank") or 0) + taken
            return cur
        committed, snap = _tx(sid, fn)
        if not committed:
            credit(uid, taken)
            return _fail("tx_failed")
        _publish(snap)
        return {"ok": True, "delta": -taken, "debt_left": int(snap["members"][uid].get("debt") or 0)}


def a_shop(uid, user, p):
    kind, item = str(p.get("kind") or ""), str(p.get("id") or "")
    with _LOCK:
        sq = _leader_squad(uid)
        if not sq:
            return _fail("not_allowed")
        res = {"err": None}

        def fn(cur):
            bank = int(cur.get("bank") or 0)
            if kind == "color":
                if item not in COLORS:
                    res["err"] = "bad_item"; return None
                if item in (cur.get("owned_colors") or {}):
                    res["err"] = "owned"; return None
                price = COLORS[item]
            elif kind == "theme":
                if item not in THEMES:
                    res["err"] = "bad_item"; return None
                if item in (cur.get("owned_themes") or {}):
                    res["err"] = "owned"; return None
                price = THEMES[item]
            elif kind == "seats":
                size = int(item) if item.isdigit() else 0
                if size not in SEAT_UPGRADES:
                    res["err"] = "bad_item"; return None
                need, price = SEAT_UPGRADES[size]
                if int(cur.get("max_members") or BASE_SEATS) != need:
                    res["err"] = "bad_order"; return None
            else:
                res["err"] = "bad_item"; return None
            if bank < price:
                res["err"] = "bank_low"; return None
            cur["bank"] = bank - price
            if kind == "color":
                cur.setdefault("owned_colors", {"base": True})[item] = True
                cur["color"] = item
            elif kind == "theme":
                cur.setdefault("owned_themes", {})[item] = True
                cur["theme"] = item
            else:
                cur["max_members"] = size
            return cur
        committed, snap = _tx(sq["id"], fn)
        if not committed:
            msg = {"bank_low": "В казне не хватает монет", "owned": "Уже куплено", "bad_order": "Сначала купи предыдущее расширение"}.get(res["err"], "Покупка недоступна")
            return _fail(res["err"] or "tx_failed", message=msg)
        _publish(snap)
        return {"ok": True}


def a_equip(uid, user, p):
    kind, item = str(p.get("kind") or ""), str(p.get("id") or "")
    with _LOCK:
        sq = _leader_squad(uid)
        if not sq:
            return _fail("not_allowed")
        def fn(cur):
            if kind == "color" and item in (cur.get("owned_colors") or {"base": True}):
                cur["color"] = item
            elif kind == "theme" and (item == "" or item in (cur.get("owned_themes") or {})):
                cur["theme"] = item
            else:
                return None
            return cur
        committed, snap = _tx(sq["id"], fn)
        if committed:
            _publish(snap)
        return {"ok": bool(committed)}


def a_tap(uid, user, p):
    """Клиент периодически сообщает объём монет, добытых тапами (для недельного рейтинга)."""
    try:
        amount = int(p.get("amount") or 0)
    except Exception:
        return _fail("bad_amount")
    now = time.time()
    if amount <= 0 or now - _tap_last.get(uid, 0) < TAP_REPORT_MIN_INTERVAL:
        return {"ok": True, "skipped": True}
    _tap_last[uid] = now
    amount = min(amount, TAP_REPORT_MAX)
    sid = _sid_of(uid)
    if not sid:
        return {"ok": True}
    wk = _week_key()

    def fn(cur):
        if cur.get("status") != "active" or uid not in (cur.get("members") or {}):
            return None
        w = cur.get("weekly") or {}
        base = int(w.get("amount") or 0) if w.get("wk") == wk else 0
        cur["weekly"] = {"wk": wk, "amount": base + amount}
        return cur
    committed, snap = _tx(sid, fn)
    if committed:
        _publish(snap)
    return {"ok": True}


def _apply_mmr(uid, delta):
    sid = _sid_of(uid)
    if not sid or not delta:
        return

    def fn(cur):
        if cur.get("status") != "active" or uid not in (cur.get("members") or {}):
            return None
        cur["mmr"] = max(0, int(cur.get("mmr") or 0) + delta)
        return cur
    committed, snap = _tx(sid, fn)
    if committed:
        _publish(snap)


def _once(key) -> bool:
    r = {"ok": False}

    def fn(cur):
        if cur:
            return None
        r["ok"] = True
        return _now()
    apb.fb_run_transaction(f"squad_mmr_done/{_hash(key)}", fn)
    return r["ok"]


def a_duel_result(uid, user, p):
    cid = str(p.get("cid") or "")
    ch = apb.fb_get(f"duel_challenges/{_key(cid)}") if cid else None
    if not isinstance(ch, dict) or not ch.get("settled"):
        return _fail("not_settled")
    a, b = str(ch.get("challengerId") or ""), str(ch.get("opponentId") or "")
    win = str(ch.get("winnerId") or "")
    if uid not in (a, b):
        return _fail("not_participant")
    if win in ("", "draw") or win not in (a, b):
        return {"ok": True, "applied": False}
    if not _once("duel_" + cid):
        return {"ok": True, "applied": False}
    loser = b if win == a else a
    with _LOCK:
        _apply_mmr(win, MMR_DUEL_WIN)
        if loser.isdigit():
            _apply_mmr(loser, MMR_DUEL_LOSS)
    return {"ok": True, "applied": True}


def a_loto_result(uid, user, p):
    rid = str(p.get("room_id") or "")
    room = apb.fb_get(f"loto_rooms/{_key(rid)}") if rid else None
    if not isinstance(room, dict) or room.get("status") != "finished" or not room.get("final_winner"):
        return _fail("not_finished")
    players = list((room.get("players") or {}).keys())
    if uid not in players:
        return _fail("not_participant")
    if not _once("loto_" + rid):
        return {"ok": True, "applied": False}
    winner = str(room["final_winner"])
    with _LOCK:
        for pid in players:
            _apply_mmr(pid, MMR_LOTO_WIN if pid == winner else MMR_LOTO_LOSS)
    return {"ok": True, "applied": True}


ACTIONS = {
    "squad_me": a_me, "squad_building": a_building, "squad_top": a_top, "squad_view": a_view,
    "squad_by_code": a_by_code, "squad_create": a_create, "squad_cancel": a_cancel, "squad_join": a_join,
    "squad_leave": a_leave, "squad_kick": a_kick, "squad_resolve_request": a_resolve_request,
    "squad_set_mode": a_set_mode, "squad_levy": a_levy, "squad_pay_debt": a_pay_debt,
    "squad_shop": a_shop, "squad_equip": a_equip, "squad_tap": a_tap,
    "squad_duel_result": a_duel_result, "squad_loto_result": a_loto_result,
}


def handle_api(action, payload, init_data_raw):
    """Возвращает (http_code, dict)."""
    fn = ACTIONS.get(action)
    if not fn:
        return 404, {"ok": False, "error": "unknown_action"}
    user = verify_init_data(init_data_raw)
    if not user:
        return 401, {"ok": False, "error": "unauthorized", "message": "Открой игру из Telegram"}
    uid = str(user["id"])
    try:
        return 200, fn(uid, user, payload if isinstance(payload, dict) else {})
    except Exception as e:
        print(f"[Squads] {action} error:", apb._redact_err(e))
        return 200, {"ok": False, "error": "server_error", "message": "Ошибка сервера, попробуй позже"}


# ─── ФОНОВЫЙ СТОРОЖ (таймаут 72 ч + добивание возвратов) ──────────────────────
def sweep_once():
    now = _now()
    for sid, b in list((apb.fb_get("squad_building") or {}).items()):
        if isinstance(b, dict) and int(b.get("expires_at") or 0) < now:
            _cancel(sid, "expired", "за 72 часа не собралось 3 участника")
    for sid in list((apb.fb_get("squad_refunds") or {}).keys()):
        with _LOCK:
            _process_refunds(sid)


def start_sweeper(interval=60):
    def loop():
        while True:
            try:
                sweep_once()
            except Exception as e:
                print("[Squads] sweeper error:", apb._redact_err(e))
            time.sleep(interval)
    t = threading.Thread(target=loop, name="SquadSweeper", daemon=True)
    t.start()
    return t
