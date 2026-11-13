/* squads.js — Сквады (кланы) ОРЕО. Изолированный модуль: UI + кэш бейджей.
 * Бэкенд: bot.py (squads_backend.py) через POST {BACKEND}/api/bot?action=squad_*
 * Публичные данные для подсветки: Firebase squad_of / squad_public.
 * API: window.OreoSquads { open, getBadge, nameHtml, decorateEl, tapMult, noteTap, reportDuel, reportLoto, refreshBadges }
 */
(() => {
  'use strict';

  const DEFAULT_BACKEND = 'https://oreo-tap.onrender.com/api/bot';
  const DEFAULT_DB = 'https://oreo-tap-default-rtdb.europe-west1.firebasedatabase.app';
  const STAKE = 50000;
  const COLORS = [
    { id: 'base', name: 'Белый/серый', price: 0, sw: 'background:#cfd3dc' },
    { id: 'rare', name: 'Редкий синий', price: 250000, sw: 'background:#4da3ff' },
    { id: 'neon', name: 'Кислотный неон ✨', price: 500000, sw: 'background:#39ff14;box-shadow:0 0 10px #39ff14' },
    { id: 'gold', name: 'Золотой градиент ✨', price: 1000000, sw: 'background:linear-gradient(90deg,#ffd76a,#fff6c2,#e9a400)' }
  ];
  const THEMES = [
    { id: 'cyber', name: '🌆 Киберпанк', price: 150000 },
    { id: 'poker', name: '♠️ Покерный клуб', price: 250000 },
    { id: 'syndicate', name: '🕶 Синдикат', price: 300000 },
    { id: 'vault', name: '🏦 Золотое хранилище', price: 400000 }
  ];
  const SEATS = [{ id: '20', name: '👥 15 → 20 мест', price: 200000 }, { id: '30', name: '👥 20 → 30 мест', price: 500000 }];

  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const fmt = (n) => Number(n || 0).toLocaleString('ru-RU');
  const bridge = () => window.OreoBridge || null;
  const tg = () => (window.Telegram && window.Telegram.WebApp) || null;
  const backend = () => window.OREO_BACKEND_API_URL || DEFAULT_BACKEND;
  const dbUrl = () => ((bridge() && bridge().dbUrl) || DEFAULT_DB).replace(/\/+$/, '');
  const myId = () => {
    const u = tg() && tg().initDataUnsafe && tg().initDataUnsafe.user;
    const b = bridge();
    return String((u && u.id) || (b && b.playerId) || '');
  };
  const toast = (m) => { const b = bridge(); if (b && b.showToast) b.showToast(m); };
  const coins = () => { const b = bridge(); return b && b.getState ? Math.max(0, Math.round(Number(b.getState().coins) || 0)) : 0; };
  function applyDelta(d) {
    d = Math.round(Number(d) || 0);
    const b = bridge();
    if (!d || !b || !b.applyExternalState) return;
    b.applyExternalState({ coins: Math.max(0, coins() + d) });
  }

  // ─── API ────────────────────────────────────────────────────────────────────
  async function api(action, payload) {
    try {
      const headers = { 'Content-Type': 'application/json' };
      const init = tg() && tg().initData;
      if (init) headers['X-Telegram-Init-Data'] = init;
      const r = await fetch(backend() + '?action=' + encodeURIComponent(action), {
        method: 'POST', headers, body: JSON.stringify(Object.assign({ action }, payload || {}))
      });
      const d = await r.json();
      if (d && d.delta) applyDelta(d.delta);
      return d || { ok: false };
    } catch (e) {
      return { ok: false, error: 'network', message: 'Нет связи с сервером' };
    }
  }
  const fbGet = async (p) => { try { const r = await fetch(dbUrl() + '/' + p + '.json', { cache: 'no-store' }); return r.ok ? r.json() : null; } catch (e) { return null; } };

  // ─── БЕЙДЖИ / ПОДСВЕТКА ───────────────────────────────────────────────────────
  let _of = {}, _pub = {}, _badgeTs = 0;
  async function refreshBadges(force) {
    if (!force && Date.now() - _badgeTs < 60000) return;
    _badgeTs = Date.now();
    const [o, p] = await Promise.all([fbGet('squad_of'), fbGet('squad_public')]);
    _of = o || {}; _pub = p || {};
  }
  function getBadge(uid) {
    const sid = _of[String(uid)];
    const sq = sid && _pub[sid];
    return sq ? { tag: sq.tag, color: sq.color || 'base', id: sid, emoji: sq.emoji } : null;
  }
  function nameHtml(uid, name) {
    const b = uid ? getBadge(uid) : null;
    if (!b) return esc(name);
    return '<span class="sq-nm sqc-' + esc(b.color) + '"><b class="sq-tg">[' + esc(b.tag) + ']</b>' + esc(name) + '</span>';
  }
  function decorateEl(el, uid, name) { if (el) el.innerHTML = nameHtml(uid, name); }
  function avatarClass(uid) { const b = getBadge(uid); return b && b.color !== 'base' ? 'sqa-' + b.color : ''; }

  // ─── МНОЖИТЕЛЬ ТАПА + ОБЪЁМ ───────────────────────────────────────────────────
  let _me = null, _tapAcc = 0;
  const tapMult = () => (_me && _me.squad && _me.squad.status === 'active' && _me.squad.multiplier) || 1;
  function noteTap(g) { _tapAcc += Math.max(0, Number(g) || 0); }
  async function loadMe() {
    const d = await api('squad_me');
    if (d && d.ok) {
      _me = d;
      if (d.inbox) { applyDelta(d.inbox); toast((d.inbox > 0 ? '🛡 +' : '🛡 ') + fmt(d.inbox) + ' 🪙 (сквад)'); }
    }
    return d;
  }
  setInterval(async () => {
    if (_tapAcc > 0 && _me && _me.squad && _me.squad.status === 'active') {
      const a = Math.round(_tapAcc); _tapAcc = 0;
      api('squad_tap', { amount: a });
    }
  }, 60000);
  setInterval(() => { if (document.visibilityState !== 'hidden') { loadMe(); refreshBadges(true); } }, 5 * 60000);

  // ─── РЕЗУЛЬТАТЫ ИГР (MMR) — сервер сам проверяет по записям Firebase ───────────
  const _reported = new Set();
  function reportDuel(cid) { if (!cid || _reported.has('d' + cid)) return; _reported.add('d' + cid); api('squad_duel_result', { cid: String(cid) }).then(() => refreshBadges(true)); }
  function reportLoto(rid) { if (!rid || _reported.has('l' + rid)) return; _reported.add('l' + rid); api('squad_loto_result', { room_id: String(rid) }).then(() => refreshBadges(true)); }

  // ─── UI ───────────────────────────────────────────────────────────────────────
  let ov = null, bodyEl = null, tab = 'my';
  function ensureOv() {
    if (ov) return;
    ov = document.createElement('div');
    ov.className = 'sq-ov';
    ov.innerHTML = '<div class="sq-head"><h3>🛡 Сквады</h3><button class="sq-x" id="sqClose">✕</button></div>' +
      '<div class="sq-tabs"><button class="sq-tab" data-t="my">🛡 Мой</button><button class="sq-tab" data-t="build">🏗 Стройка</button><button class="sq-tab" data-t="top">🏆 Топ</button></div>' +
      '<div class="sq-body" id="sqBody"></div>';
    document.body.appendChild(ov);
    bodyEl = ov.querySelector('#sqBody');
    ov.querySelector('#sqClose').onclick = close;
    ov.querySelectorAll('.sq-tab').forEach((b) => { b.onclick = () => go(b.dataset.t); });
  }
  function open(t) { ensureOv(); ov.classList.add('open'); const b = bridge(); if (b && b.setOverlayActive) try { b.setOverlayActive('squads', true); } catch (e) {} go(t || 'my'); }
  function close() { if (ov) ov.classList.remove('open'); const b = bridge(); if (b && b.setOverlayActive) try { b.setOverlayActive('squads', false); } catch (e) {} }
  function go(t) {
    tab = t;
    ov.querySelectorAll('.sq-tab').forEach((b) => b.classList.toggle('on', b.dataset.t === t));
    bodyEl.innerHTML = '<div class="sq-muted" style="text-align:center;padding:30px">⏳ Загрузка...</div>';
    ({ my: renderMy, build: renderBuild, top: renderTop }[t] || renderMy)();
  }
  const guard = (btn, fn) => async () => { if (btn.disabled) return; btn.disabled = true; try { await fn(); } finally { btn.disabled = false; } };
  const msg = (d, okText) => toast(d && d.ok ? okText : ('⚠️ ' + ((d && d.message) || (d && d.error) || 'Ошибка')));
  const left = (ts) => { const ms = Math.max(0, ts - Date.now()); return Math.floor(ms / 3600000) + 'ч ' + Math.floor(ms % 3600000 / 60000) + 'м'; };

  function bannerHtml(s) {
    const th = s.theme ? ' sqt-' + s.theme : '';
    return '<div class="sq-banner' + th + '"><div class="sq-crest">' + esc(s.emoji) + '</div><div class="sq-grow">' +
      '<div class="sq-title"><span class="sq-tag sqc-' + esc(s.color) + '">[' + esc(s.tag) + ']</span> ' + esc(s.name) + '</div>' +
      '<div class="sq-muted">«' + esc(s.motto || '—') + '»</div></div></div>';
  }
  const statsHtml = (s) =>
    '<span class="sq-chip gold">💰 ' + fmt(s.bank) + '</span><span class="sq-chip">⭐ ' + fmt(s.score) + '</span>' +
    '<span class="sq-chip">🏅 MMR ' + fmt(s.mmr) + '</span><span class="sq-chip">👥 ' + s.members.length + '/' + s.max_members + '</span>' +
    '<span class="sq-chip ok">⚡ x' + s.multiplier.toFixed(2) + ' (' + s.active_count + ' акт.)</span>';

  async function renderMy() {
    const d = await loadMe();
    if (tab !== 'my') return;
    if (!d || !d.ok) { bodyEl.innerHTML = '<div class="sq-card">⚠️ ' + esc((d && d.message) || 'Не удалось загрузить. Открой игру из Telegram.') + '</div>'; return; }
    const s = d.squad;
    if (!s) return renderNoSquad(d);
    if (s.status === 'pending_admin') {
      bodyEl.innerHTML = bannerHtml(s) + '<div class="sq-card"><h4>⏳ Ожидает одобрения администратора</h4><div class="sq-muted">🔒 ' + fmt(STAKE) +
        ' 🪙 заморожено в эскроу. При отклонении вернутся сразу.</div><br><button class="sq-btn red" id="sqCancel">Отменить заявку</button></div>';
      const b = bodyEl.querySelector('#sqCancel');
      b.onclick = guard(b, async () => { if (!confirm('Отменить заявку и вернуть эскроу?')) return; const r = await api('squad_cancel'); msg(r, '↩️ Заявка отменена'); await loadMe(); refreshBadges(true); go('my'); });
      return;
    }
    if (s.status === 'pending_funding') return renderFunding(s);
    renderActive(s, d);
  }

  function renderNoSquad(d) {
    bodyEl.innerHTML =
      '<div class="sq-card"><h4>🛡 Создай свой сквад</h4><div class="sq-muted">3 основателя × ' + fmt(STAKE) + ' 🪙 → казна 150 000 🪙. ' +
      'Бонус к тапу до x1.35, клановый рейтинг, своя цветовая тема.</div><br><button class="sq-btn gold" id="sqNew">➕ Создать сквад</button></div>' +
      '<div class="sq-card"><h4>🏗 Или вступи в существующий</h4><div class="sq-muted">Смотри вкладки «Стройка» и «Топ».</div></div>';
    bodyEl.querySelector('#sqNew').onclick = () => renderForm(d);
  }

  function renderForm() {
    bodyEl.innerHTML = '<div class="sq-card"><h4>➕ Новый сквад</h4>' +
      '<label class="sq-muted">Название (3–20)</label><input class="sq-in" id="sqfName" maxlength="20">' +
      '<label class="sq-muted">Клан-тег (2–5 лат. букв/цифр)</label><input class="sq-in" id="sqfTag" maxlength="5" style="text-transform:uppercase">' +
      '<label class="sq-muted">Девиз (до 40)</label><input class="sq-in" id="sqfMotto" maxlength="40">' +
      '<label class="sq-muted">Эмодзи-герб</label><input class="sq-in" id="sqfEmoji" maxlength="4" value="🛡">' +
      '<div class="sq-muted">🔒 ' + fmt(STAKE) + ' 🪙 уйдёт в эскроу до решения администратора.</div><br>' +
      '<div class="sq-row"><button class="sq-btn" id="sqfOk">Отправить заявку</button><button class="sq-btn sm red" id="sqfBack">Назад</button></div></div>';
    bodyEl.querySelector('#sqfBack').onclick = () => go('my');
    const ok = bodyEl.querySelector('#sqfOk');
    ok.onclick = guard(ok, async () => {
      const v = (id) => bodyEl.querySelector('#' + id).value;
      if (coins() < STAKE) { toast('🪙 Нужно ' + fmt(STAKE)); return; }
      const r = await api('squad_create', { name: v('sqfName'), tag: v('sqfTag'), motto: v('sqfMotto'), emoji: v('sqfEmoji') });
      msg(r, r.status === 'pending_funding' ? '✅ Заявка одобрена автоматически!' : '📨 Заявка отправлена админу');
      if (r.ok) go('my');
    });
  }

  function renderFunding(s) {
    const pct = Math.round(s.filled / 3 * 100);
    bodyEl.innerHTML = bannerHtml(s) + '<div class="sq-card"><h4>🏗 Стройка: ' + s.filled + '/3 основателей</h4>' +
      '<div class="sq-bar"><i style="width:' + pct + '%"></i></div>' +
      '<div class="sq-muted" style="margin-top:6px">⏳ Осталось ' + left(s.expires_at) + '. Если не соберётся 3 игрока или кто-то выйдет — все взносы вернутся.</div>' +
      '<div class="sq-muted" style="margin-top:6px">' + s.members.map((m) => '👤 ' + esc(m.name)).join(' · ') + '</div></div>' +
      (s.invite_link ? '<div class="sq-card"><h4>🔗 Ссылка для сооснователей</h4><div class="sq-muted" style="word-break:break-all">' + esc(s.invite_link) + '</div><br>' +
        '<div class="sq-row"><button class="sq-btn" id="sqShare">✈️ Отправить</button><button class="sq-btn sm" id="sqCopy">📋</button></div></div>' : '') +
      '<button class="sq-btn red" id="sqLeave">🚪 Выйти (отменит сбор)</button>';
    const share = bodyEl.querySelector('#sqShare');
    if (share) share.onclick = () => {
      const u = 'https://t.me/share/url?url=' + encodeURIComponent(s.invite_link) + '&text=' + encodeURIComponent('Вступай в сквад ' + s.tag + ' в ОРЕО!');
      if (tg() && tg().openTelegramLink) tg().openTelegramLink(u); else window.open(u, '_blank');
    };
    const cp = bodyEl.querySelector('#sqCopy');
    if (cp) cp.onclick = () => { try { navigator.clipboard.writeText(s.invite_link); toast('📋 Скопировано'); } catch (e) { toast(s.invite_link); } };
    const lv = bodyEl.querySelector('#sqLeave');
    lv.onclick = guard(lv, async () => { if (!confirm('Выйти? Сбор будет отменён, взносы вернутся всем.')) return; const r = await api('squad_leave'); msg(r, '↩️ Сбор отменён'); await loadMe(); refreshBadges(true); go('my'); });
  }

  function renderActive(s, d) {
    const me = myId(), isLeader = s.leader === me;
    const mine = s.members.find((m) => m.id === me) || {};
    let h = bannerHtml(s) + '<div class="sq-card">' + statsHtml(s) +
      '<div class="sq-muted">Вход: ' + ({ free: '🔓 свободный', request: '📝 по заявке', paid: '💳 платный ' + fmt(s.join_fee) + ' 🪙' }[s.join_mode]) + '</div></div>';
    if (mine.debt > 0) {
      h += '<div class="sq-card" style="border-color:#e05a5a"><h4>⚠️ Твой долг: ' + fmt(mine.debt) + ' 🪙</h4><button class="sq-btn gold" id="sqPay">💸 Довнести остаток</button></div>';
    }
    h += '<div class="sq-card"><h4>👥 Участники</h4>' + s.members.map((m) =>
      '<div class="sq-mem"><div class="sq-ava">' + esc((m.name || '?')[0]) + '</div><div class="sq-grow"><b>' + (m.role === 'leader' ? '👑 ' : '') + esc(m.name) + '</b>' +
      (m.active ? '' : ' <span class="sq-muted">· неактивен</span>') + '</div>' +
      (m.debt > 0 ? '<span class="sq-chip bad">⚠ Долг: ' + fmt(m.debt) + ' 🪙</span>' : '<span class="sq-chip ok">✅ Сдал</span>') +
      (isLeader && m.id !== me ? '<button class="sq-btn sm red" data-kick="' + esc(m.id) + '">✕</button>' : '') + '</div>').join('') + '</div>';
    if (isLeader) h += leaderPanel(s);
    h += '<button class="sq-btn red" id="sqLeave">🚪 ' + (isLeader && s.members.length === 1 ? 'Распустить сквад' : 'Покинуть сквад') + '</button>';
    bodyEl.innerHTML = h;

    const on = (sel, fn) => bodyEl.querySelectorAll(sel).forEach((el) => { el.onclick = guard(el, () => fn(el)); });
    const done = async (r, ok) => { msg(r, ok); await loadMe(); refreshBadges(true); go('my'); };
    on('#sqPay', async () => done(await api('squad_pay_debt'), '💸 Взнос внесён'));
    on('#sqLeave', async () => { if (!confirm('Покинуть сквад?')) return; done(await api('squad_leave'), '🚪 Ты вышел'); });
    on('[data-kick]', async (el) => { if (!confirm('Исключить участника?')) return; done(await api('squad_kick', { uid: el.dataset.kick }), '✕ Исключён'); });
    on('[data-req]', async (el) => done(await api('squad_resolve_request', { uid: el.dataset.req, accept: el.dataset.ok === '1' }), '✔️ Готово'));
    on('#sqMode', async () => {
      const mode = bodyEl.querySelector('#sqModeSel').value, fee = Number(bodyEl.querySelector('#sqFee').value) || 25000;
      done(await api('squad_set_mode', { mode, fee }), '✔️ Режим входа сохранён');
    });
    on('#sqLevy', async () => {
      const amount = Number(bodyEl.querySelector('#sqLevyAmt').value), goal = bodyEl.querySelector('#sqLevyGoal').value;
      if (!confirm('Объявить сбор по ' + fmt(amount) + ' 🪙 с каждого участника?')) return;
      const r = await api('squad_levy', { amount, goal });
      if (r.ok) toast('📣 Сбор: +' + fmt(r.collected) + ' 🪙, должников: ' + r.debtors); else msg(r, '');
      await loadMe(); go('my');
    });
    on('[data-buy]', async (el) => {
      const [kind, id, price] = el.dataset.buy.split(':');
      if (!confirm('Купить за ' + fmt(price) + ' 🪙 из казны?')) return;
      done(await api('squad_shop', { kind, id }), '🛍 Куплено!');
    });
    on('[data-eq]', async (el) => { const [kind, id] = el.dataset.eq.split(':'); done(await api('squad_equip', { kind, id }), '🎨 Применено'); });
  }

  function leaderPanel(s) {
    const oc = new Set(s.owned_colors || ['base']), ot = new Set(s.owned_themes || []);
    const lv = s.levy_next_at > Date.now() ? '<div class="sq-muted">Следующий сбор через ' + left(s.levy_next_at) + '</div>' : '';
    const item = (kind, it, owned, cur, swStyle) =>
      '<div class="sq-item' + (owned ? ' own' : '') + '">' + (swStyle ? '<div class="sw" style="' + swStyle + '"></div>' : '') + esc(it.name) +
      '<div class="sq-muted">' + (it.price ? fmt(it.price) + ' 🪙' : 'бесплатно') + '</div>' +
      (owned ? (cur ? '<div class="sq-chip ok">активно</div>' : '<button class="sq-btn sm" data-eq="' + kind + ':' + it.id + '">Выбрать</button>')
        : '<button class="sq-btn sm gold" data-buy="' + kind + ':' + it.id + ':' + it.price + '">Купить</button>') + '</div>';
    let seatsH = SEATS.map((it) => {
      const need = it.id === '20' ? 15 : 20, owned = s.max_members >= Number(it.id);
      return '<div class="sq-item' + (owned ? ' own' : '') + '">' + esc(it.name) + '<div class="sq-muted">' + fmt(it.price) + ' 🪙</div>' +
        (owned ? '<div class="sq-chip ok">есть</div>' : (s.max_members === need ? '<button class="sq-btn sm gold" data-buy="seats:' + it.id + ':' + it.price + '">Купить</button>' : '<div class="sq-muted">сначала 20</div>')) + '</div>';
    }).join('');
    return '<div class="sq-card"><h4>👑 Панель лидера</h4>' +
      (s.requests && s.requests.length ? '<div class="sq-muted">Заявки:</div>' + s.requests.map((r) =>
        '<div class="sq-row" style="margin:4px 0"><div class="sq-grow">👤 ' + esc(r.name) + '</div><button class="sq-btn sm" data-req="' + esc(r.id) + '" data-ok="1">✔</button><button class="sq-btn sm red" data-req="' + esc(r.id) + '" data-ok="0">✕</button></div>').join('') + '<br>' : '') +
      '<div class="sq-muted">Режим входа</div><div class="sq-row"><select class="sq-in sq-grow" id="sqModeSel"><option value="free"' + (s.join_mode === 'free' ? ' selected' : '') + '>🔓 Свободный</option><option value="request"' + (s.join_mode === 'request' ? ' selected' : '') + '>📝 По заявке</option><option value="paid"' + (s.join_mode === 'paid' ? ' selected' : '') + '>💳 Платный</option></select>' +
      '<input class="sq-in" id="sqFee" type="number" value="' + (s.join_fee || 25000) + '" style="width:100px"><button class="sq-btn sm" id="sqMode">OK</button></div>' +
      '<div class="sq-muted" style="margin-top:6px">📣 Объявить сбор (1 000 – 100 000 с человека, раз в 24ч)</div>' +
      '<div class="sq-row"><input class="sq-in" id="sqLevyAmt" type="number" min="1000" max="100000" placeholder="Сумма" style="width:110px"><input class="sq-in sq-grow" id="sqLevyGoal" maxlength="40" placeholder="Цель"><button class="sq-btn sm gold" id="sqLevy">Объявить</button></div>' + lv + '</div>' +
      '<div class="sq-card"><h4>🎨 Цвет клана</h4><div class="sq-shop">' + COLORS.map((c) => item('color', c, oc.has(c.id), s.color === c.id, c.sw)).join('') + '</div></div>' +
      '<div class="sq-card"><h4>🖼 Тема карточки</h4><div class="sq-shop">' +
      '<div class="sq-item own">Стандарт<div class="sq-muted">бесплатно</div>' + (!s.theme ? '<div class="sq-chip ok">активно</div>' : '<button class="sq-btn sm" data-eq="theme:">Выбрать</button>') + '</div>' +
      THEMES.map((t) => item('theme', t, ot.has(t.id), s.theme === t.id, '')).join('') + '</div></div>' +
      '<div class="sq-card"><h4>🏠 Расширение штата</h4><div class="sq-shop">' + seatsH + '</div></div>';
  }

  async function renderBuild() {
    const d = await api('squad_building');
    if (tab !== 'build') return;
    if (!d.ok) { bodyEl.innerHTML = '<div class="sq-card">⚠️ ' + esc(d.message || 'Ошибка загрузки') + '</div>'; return; }
    if (!d.items.length) { bodyEl.innerHTML = '<div class="sq-card sq-muted" style="text-align:center">🏗 Сейчас никто не собирает сквад</div>'; return; }
    bodyEl.innerHTML = d.items.map((s) =>
      '<div class="sq-card"><div class="sq-row"><div class="sq-crest" style="font-size:28px">' + esc(s.emoji) + '</div><div class="sq-grow"><b><span class="sqc-' + esc(s.color) + '">[' + esc(s.tag) + ']</span> ' + esc(s.name) + '</b>' +
      '<div class="sq-muted">👑 ' + esc(s.leader_name) + ' · ⏳ ' + left(s.expires_at) + '</div></div><span class="sq-chip gold">' + s.filled + '/3</span></div>' +
      '<div class="sq-bar" style="margin:8px 0"><i style="width:' + Math.round(s.filled / 3 * 100) + '%"></i></div>' +
      '<button class="sq-btn gold" data-join="' + esc(s.id) + '">Вступить · ' + fmt(STAKE) + ' 🪙</button></div>').join('');
    bodyEl.querySelectorAll('[data-join]').forEach((b) => { b.onclick = guard(b, async () => { await joinFlow({ sid: b.dataset.join }); go('build'); }); });
  }

  async function joinFlow(payload) {
    if (!confirm('Внести ' + fmt(STAKE) + ' 🪙 как сооснователь? Монеты заморозятся до старта сквада.')) return;
    const r = await api('squad_join', payload);
    msg(r, r.activated ? '🎉 Сквад активирован!' : '✅ Взнос внесён');
    await loadMe(); refreshBadges(true);
  }

  async function renderTop() {
    const d = await api('squad_top');
    await refreshBadges(true);
    if (tab !== 'top') return;
    if (!d.ok || !d.items.length) { bodyEl.innerHTML = '<div class="sq-card sq-muted" style="text-align:center">🏆 Активных сквадов пока нет</div>'; return; }
    const medals = ['🥇', '🥈', '🥉'];
    bodyEl.innerHTML = d.items.map((s, i) =>
      '<div class="sq-top" data-sid="' + esc(s.id) + '"><div class="sq-place">' + (medals[i] || (i + 1)) + '</div><div class="sq-crest" style="font-size:24px">' + esc(s.emoji) + '</div>' +
      '<div class="sq-grow"><b><span class="sq-tag sqc-' + esc(s.color) + '">' + esc(s.tag) + '</span> ' + esc(s.name) + '</b><div class="sq-muted">👥 ' + s.n + '/30</div></div>' +
      '<span class="sq-chip gold">⭐ ' + fmt(s.score) + '</span></div>').join('');
    bodyEl.querySelectorAll('[data-sid]').forEach((el) => { el.onclick = () => showCard(el.dataset.sid); });
  }

  async function showCard(sid) {
    const d = await api('squad_view', { sid });
    if (!d.ok) { toast('⚠️ Сквад не найден'); return; }
    const s = d.squad;
    bodyEl.innerHTML = '<button class="sq-btn sm" id="sqBack">← Назад</button>' + bannerHtml(s) + '<div class="sq-card">' + statsHtml(s) + '</div>' +
      '<div class="sq-card"><h4>👥 Состав</h4>' + s.members.map((m) => '<div class="sq-mem"><div class="sq-ava">' + esc((m.name || '?')[0]) + '</div><div class="sq-grow">' + (m.role === 'leader' ? '👑 ' : '') + esc(m.name) + '</div></div>').join('') + '</div>' +
      (s.status === 'active' && s.members.length < s.max_members && s.join_mode !== 'request' ?
        '<button class="sq-btn gold" id="sqJoin">' + (s.join_mode === 'paid' ? 'Вступить · ' + fmt(s.join_fee) + ' 🪙' : 'Вступить') + '</button>' : '') +
      (s.status === 'active' && s.join_mode === 'request' ? '<button class="sq-btn" id="sqJoin">📝 Подать заявку</button>' : '');
    bodyEl.querySelector('#sqBack').onclick = () => go('top');
    const j = bodyEl.querySelector('#sqJoin');
    if (j) j.onclick = guard(j, async () => {
      const r = await api('squad_join', { sid });
      msg(r, r.pending ? '📝 Заявка отправлена лидеру' : '🛡 Ты в скваде!');
      await loadMe(); refreshBadges(true); if (r.ok) go('my');
    });
  }

  // ─── ИНИЦИАЛИЗАЦИЯ ────────────────────────────────────────────────────────────
  function addSideBtn() {
    if (document.getElementById('squadSideBtn')) return;
    const side = document.querySelector('.side.left');
    if (!side) return;
    const b = document.createElement('button');
    b.className = 'round-btn'; b.id = 'squadSideBtn'; b.title = 'Сквады';
    b.innerHTML = '🛡<small style="font-size:9px;display:block">Сквад</small>';
    b.onclick = () => open('my');
    side.appendChild(b);
  }

  async function handleDeepLink() {
    let p = '';
    try { p = new URLSearchParams(location.search).get('squad') || ''; } catch (e) {}
    if (!p) return;
    if (p === 'open') { open('my'); return; }
    ensureOv(); open('build');
    const d = await api('squad_by_code', { code: p });
    if (d.ok && d.squad) {
      if (confirm('Вступить в сквад [' + d.squad.tag + '] ' + d.squad.name + '? Взнос ' + fmt(STAKE) + ' 🪙.')) {
        await joinFlow({ code: p }); go('my');
      }
    } else toast('⚠️ Приглашение недействительно');
  }

  function init() {
    addSideBtn();
    setTimeout(addSideBtn, 1500);
    refreshBadges(true);
    setTimeout(loadMe, 1200);
    setTimeout(handleDeepLink, 1800);
  }

  window.OreoSquads = { open, close, getBadge, nameHtml, decorateEl, avatarClass, tapMult, noteTap, reportDuel, reportLoto, refreshBadges };
  if (document.readyState !== 'loading') init(); else document.addEventListener('DOMContentLoaded', init);
})();
