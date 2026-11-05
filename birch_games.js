/* birch_games.js — Берёзовый Холдем, P2P-Дуэли (Покер & Шахматы) и Live Админ-консоль ОРЕО67 */
(() => {
  'use strict';

  const MY_ADMIN_ID = '594228143';
  const DEFAULT_DB_URL = 'https://oreo-tap-default-rtdb.europe-west1.firebasedatabase.app';
  const PAVEL_BANK_DEFAULT = 433763254656000000;
  const TURN_TIMEOUT_MS = 25000;
  const CHESS_INIT_MS = 5 * 60 * 1000;

  const BLIND_LEVELS = [
    { level: 1, sb: 100, bb: 200 },
    { level: 2, sb: 200, bb: 400 },
    { level: 3, sb: 400, bb: 800 },
    { level: 4, sb: 800, bb: 1600 },
    { level: 5, sb: 1500, bb: 3000 },
    { level: 6, sb: 3000, bb: 6000 },
    { level: 7, sb: 5000, bb: 10000 },
    { level: 8, sb: 10000, bb: 20000 }
  ];

  const TOUR_PACKS = {
    entry:        { label: '🎟 Вход (100k 🪙 → 20k 🪵 +10k бонус)', cost: 100000, sticks: 20000, earlyBonus: 10000 },
    rebuy:        { label: '🔄 Ребай (150k 🪙 → 40k 🪵)',           cost: 150000, sticks: 40000, earlyBonus: 0 },
    double_rebuy: { label: '⚡ Двойной ребай (250k 🪙 → 80k 🪵)',   cost: 250000, sticks: 80000, earlyBonus: 0 },
    addon:        { label: '➕ Аддон (200k 🪙 → 100k 🪵)',          cost: 200000, sticks: 100000, earlyBonus: 0 },
    double_addon: { label: '🔥 Двойной аддон (350k 🪙 → 200k 🪵)',  cost: 350000, sticks: 200000, earlyBonus: 0 }
  };

  // ---------- ДОСТУП К ИГРОКУ И БАЗЕ ----------
  function getBridge() { return window.OreoBridge || null; }
  function getDbUrl() {
    const b = getBridge();
    return ((b && b.dbUrl) || DEFAULT_DB_URL).replace(/\/+$/, '');
  }
  function getMe() {
    const b = getBridge();
    const tgU = window.Telegram && window.Telegram.WebApp && window.Telegram.WebApp.initDataUnsafe && window.Telegram.WebApp.initDataUnsafe.user;
    const id = String((tgU && tgU.id) || (b && b.playerId) || localStorage.getItem('oreo_anon_id') || 'anon_local');
    const name = String((tgU && tgU.first_name) || (b && b.playerName) || 'Тапер');
    const username = String((tgU && tgU.username) || '');
    const photo = String((tgU && tgU.photo_url) || (b && b.playerPhoto) || '');
    return { id, name, username, photo };
  }
  function isAdminUser() {
    const me = getMe();
    const host = String(location.hostname || '');
    const isLocal = host === 'localhost' || host === '127.0.0.1' || location.protocol === 'file:' || location.search.includes('admin=1');
    return me.id === MY_ADMIN_ID || isLocal;
  }

  function getLocalState() {
    const b = getBridge();
    if (b && b.getState) return b.getState();
    try { return JSON.parse(localStorage.getItem('oreo-tap-save-v2') || '{}'); } catch (e) { return {}; }
  }
  function getCoins() { return Math.max(0, Math.round(Number(getLocalState().coins) || 0)); }
  function getGems() { return Math.max(0, Math.round(Number(getLocalState().gems) || 0)); }
  function getSticks() { return Math.max(0, Math.round(Number(getLocalState().sticks) || 0)); }
  function getChoppedLogs() { return Math.max(0, Math.round(Number(getLocalState().choppedLogs) || 0)); }

  function updateLocalWallet(patch) {
    const b = getBridge();
    const st = getLocalState();
    if (patch.coins !== undefined) st.coins = Math.max(0, Math.round(Number(patch.coins) || 0));
    if (patch.gems !== undefined) st.gems = Math.max(0, Math.round(Number(patch.gems) || 0));
    if (patch.energy !== undefined) st.energy = Math.max(0, Math.round(Number(patch.energy) || 0));
    if (patch.sticks !== undefined) st.sticks = Math.max(0, Math.round(Number(patch.sticks) || 0));
    if (patch.choppedLogs !== undefined) st.choppedLogs = Math.max(0, Math.round(Number(patch.choppedLogs) || 0));
    if (patch.equippedSkin !== undefined) st.equippedSkin = String(patch.equippedSkin || 'classic');
    if (!st.wallet || typeof st.wallet !== 'object') st.wallet = {};
    st.wallet.coins = Math.max(0, Math.round(Number(st.coins) || 0));
    st.wallet.gems = Math.max(0, Math.round(Number(st.gems) || 0));
    st.wallet.energy = Math.max(0, Math.round(Number(st.energy) || 500));
    st.wallet.sticks = Math.max(0, Math.round(Number(st.sticks) || 0));
    st.wallet.choppedLogs = Math.max(0, Math.round(Number(st.choppedLogs) || 0));
    st.wallet.equippedSkin = st.equippedSkin || 'classic';
    try { localStorage.setItem('oreo-tap-save-v2', JSON.stringify(st)); } catch (e) {}
    if (b && b.applyExternalState) {
      b.applyExternalState(st);
    }
    refreshHeaderWallet();
  }

  async function syncMyWalletToFirebase(extraPatch = {}) {
    const me = getMe();
    if (!me || !me.id) return;
    const st = getLocalState();
    const now = Date.now();
    const coins = Math.max(0, Math.round(Number(st.coins) || 0));
    const gems = Math.max(0, Math.round(Number(st.gems) || 0));
    const energy = Math.max(0, Math.round(Number(st.energy !== undefined ? st.energy : 500) || 0));
    const sticks = Math.max(0, Math.round(Number(st.sticks) || 0));
    const choppedLogs = Math.max(0, Math.round(Number(st.choppedLogs) || 0));
    const equippedSkin = String(st.equippedSkin || 'classic');
    const payload = Object.assign({
      id: me.id,
      name: me.name,
      username: me.username || '',
      photo: me.photo || '',
      coins,
      taps: coins,
      count: coins,
      gems,
      energy,
      sticks,
      choppedLogs,
      skin: equippedSkin,
      equippedSkin,
      lastSeen: now,
      ts: now,
      wallet: {
        coins,
        gems,
        energy,
        sticks,
        choppedLogs,
        equippedSkin,
        lastSeen: now
      }
    }, extraPatch || {});
    await fbPatch(`players/${encodeURIComponent(me.id)}`, payload);
  }

  function toast(msg) {
    const b = getBridge();
    if (b && b.showToast) b.showToast(msg);
  }

  const fmt = n => Math.round(Number(n) || 0).toLocaleString('ru-RU');
  const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  // ---------- FIREBASE REST + КЭШ ПАМЯТИ (0ms TAB SWITCH) + ONVALUE + RUNTRANSACTION ----------
  const _memCache = new Map();

  function _shortFbPath(clean) {
    return String(clean || '').slice(0, 56);
  }

  async function fbGet(path, signal) {
    const clean = path.replace(/^\/+/, '');
    const abortSig = (signal && typeof signal === 'object' && 'aborted' in signal) ? signal : undefined;
    try {
      const r = await fetch(`${getDbUrl()}/${clean}.json`, { cache: 'no-store', signal: abortSig });
      if (!r.ok) {
        if (!clean.startsWith('crash_reports')) pushTelemetryAction(`fb_get_err:${_shortFbPath(clean)}:${r.status}`);
        return null;
      }
      const val = await r.json();
      _memCache.set(clean, val);
      return val;
    } catch (e) {
      if (!(e && e.name === 'AbortError') && !clean.startsWith('crash_reports')) {
        pushTelemetryAction(`fb_get_neterr:${_shortFbPath(clean)}`);
      }
      return null;
    }
  }
  async function fbPut(path, data) {
    const clean = path.replace(/^\/+/, '');
    _memCache.set(clean, data);
    try {
      const r = await fetch(`${getDbUrl()}/${clean}.json`, {
        method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data)
      });
      if (!clean.startsWith('crash_reports')) {
        pushTelemetryAction(`fb_put:${_shortFbPath(clean)}:${r.ok ? 'ok' : r.status}`);
      }
      return r.ok ? await r.json() : null;
    } catch (e) {
      if (!clean.startsWith('crash_reports')) pushTelemetryAction(`fb_put_err:${_shortFbPath(clean)}`);
      return null;
    }
  }
  async function fbPatch(path, data) {
    const clean = path.replace(/^\/+/, '');
    const prev = _memCache.get(clean);
    if (prev && typeof prev === 'object' && data && typeof data === 'object') {
      _memCache.set(clean, Object.assign({}, prev, data));
    }
    try {
      const r = await fetch(`${getDbUrl()}/${clean}.json`, {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data)
      });
      if (!clean.startsWith('crash_reports')) {
        pushTelemetryAction(`fb_patch:${_shortFbPath(clean)}:${r.ok ? 'ok' : r.status}`);
      }
      return r.ok ? await r.json() : null;
    } catch (e) {
      if (!clean.startsWith('crash_reports')) pushTelemetryAction(`fb_patch_err:${_shortFbPath(clean)}`);
      return null;
    }
  }
  async function fbDelete(path) {
    const clean = path.replace(/^\/+/, '');
    _memCache.delete(clean);
    try {
      await fetch(`${getDbUrl()}/${clean}.json`, { method: 'DELETE' });
      pushTelemetryAction(`fb_del:${_shortFbPath(clean)}`);
    } catch (e) {}
  }

  async function runTransaction(path, updaterFn, maxRetries = 4) {
    const cleanPath = path.replace(/^\/+/, '');
    for (let attempt = 0; attempt < maxRetries; attempt++) {
      try {
        const res = await fetch(`${getDbUrl()}/${cleanPath}.json`, {
          headers: { 'X-Firebase-ETag': 'true' }, cache: 'no-store'
        });
        const etag = res.headers.get('ETag');
        const current = res.ok ? await res.json() : null;
        const nextVal = updaterFn(current ? JSON.parse(JSON.stringify(current)) : null);
        if (nextVal === undefined) return { committed: false, snapshot: current };

        const putHeaders = { 'Content-Type': 'application/json' };
        if (etag) putHeaders['if-match'] = etag;
        const putRes = await fetch(`${getDbUrl()}/${cleanPath}.json`, {
          method: 'PUT', headers: putHeaders, body: JSON.stringify(nextVal)
        });
        if (putRes.status === 412) continue;
        if (putRes.ok) {
          const saved = await putRes.json();
          _memCache.set(cleanPath, saved);
          pushTelemetryAction(`fb_tx:${_shortFbPath(cleanPath)}:ok`);
          return { committed: true, snapshot: saved };
        }
      } catch (e) {}
    }
    const cur = await fbGet(cleanPath);
    const nextVal = updaterFn(cur);
    if (nextVal === undefined) return { committed: false, snapshot: cur };
    const saved = await fbPut(cleanPath, nextVal);
    return { committed: true, snapshot: saved };
  }

  const _watchers = new Map();
  function onValue(path, callback, intervalMs = 1500) {
    const clean = path.replace(/^\/+/, '');
    const key = `${clean}_${Math.random().toString(36).slice(2)}`;
    let active = true;
    let inFlight = false;
    let lastJson = '';
    let ctrl = null;

    // Мгновенный рендер из кэша без ожидания сети (убирает фризы при переключении вкладок)
    if (_memCache.has(clean)) {
      const cached = _memCache.get(clean);
      lastJson = JSON.stringify(cached);
      queueMicrotask(() => { if (active) { try { callback(cached); } catch (e) {} } });
    }

    const poll = async () => {
      if (!active || inFlight || document.hidden) return;
      inFlight = true;
      ctrl = new AbortController();
      try {
        const data = await fbGet(clean, ctrl.signal);
        if (!active) return;
        const j = JSON.stringify(data);
        if (j !== lastJson) {
          const hadPrev = lastJson !== '';
          lastJson = j;
          if (hadPrev && (clean.startsWith('poker_tables/') || clean.startsWith('duel_matches/'))) {
            pushTelemetryAction(`fb_sync:${_shortFbPath(clean)}`);
          }
          callback(data);
        }
      } catch (e) {} finally {
        inFlight = false;
      }
    };
    poll();
    const timer = setInterval(poll, intervalMs);
    _watchers.set(key, () => {
      active = false;
      clearInterval(timer);
      if (ctrl) { try { ctrl.abort(); } catch (e) {} }
    });
    return () => {
      const fn = _watchers.get(key);
      if (fn) { fn(); _watchers.delete(key); }
    };
  }
  function clearViewWatchers() {
    _viewUnsubs.forEach(u => { try { u(); } catch (e) {} });
    _viewUnsubs = [];
  }

  // ---------- СИНХРОНИЗАЦИЯ ВЫДАЧИ РЕСУРСОВ АДМИНОМ ----------
  async function syncAdminGrantsForMe() {
    const me = getMe();
    if (!me.id) return;
    const grants = await fbGet(`admin_grants/${encodeURIComponent(me.id)}`);
    if (!grants || typeof grants !== 'object') return;
    let changed = false;
    for (const [gid, g] of Object.entries(grants)) {
      if (!g || g.claimed) continue;
      const res = g.resource || 'coins';
      const mode = g.mode || 'add';
      const delta = Number(g.delta) || 0;
      const st = getLocalState();
      if (res === 'coins') {
        const nextC = mode === 'reset' ? 0 : (mode === 'set' ? Number(g.newValue) : Math.max(0, getCoins() + delta));
        updateLocalWallet({ coins: nextC });
      } else if (res === 'gems') {
        const nextG = mode === 'reset' ? 0 : (mode === 'set' ? Number(g.newValue) : Math.max(0, getGems() + delta));
        updateLocalWallet({ gems: nextG });
      } else if (res === 'energy') {
        const nextE = mode === 'reset' ? 0 : (mode === 'set' ? Number(g.newValue) : Math.max(0, (Number(st.energy) || 500) + delta));
        updateLocalWallet({ energy: nextE });
      } else if (res === 'sticks') {
        const nextS = mode === 'reset' ? 0 : (mode === 'set' ? Number(g.newValue) : Math.max(0, getSticks() + delta));
        updateLocalWallet({ sticks: nextS });
      } else if (res === 'skin' && g.skinId) {
        unlockSkinLocally(g.skinId, true);
      }
      await fbPatch(`admin_grants/${encodeURIComponent(me.id)}/${gid}`, { claimed: true });
      changed = true;
    }
    if (changed) toast('🎁 Получено начисление ресурсов от Админа!');
  }

  // ---------- SVG БЕРЁЗОВЫХ ПАЛОЧЕК ----------
  function stickSvg(bundle = false) {
    const one = `<svg class="bg-stick" viewBox="0 0 60 16" xmlns="http://www.w3.org/2000/svg">
      <rect x="2" y="2" width="56" height="12" rx="6" fill="#f5efe2" stroke="#5b3e24" stroke-width="2"/>
      <ellipse cx="55" cy="8" rx="3" ry="5" fill="#d9b37c" stroke="#5b3e24" stroke-width="1.5"/>
      <path d="M12 4v5M24 9v4M36 3v6M45 8v5" stroke="#22170e" stroke-width="2.2" stroke-linecap="round"/>
    </svg>`;
    return bundle ? `<span class="bg-bundle">${one}${one}${one}</span>` : one;
  }

  // ---------- ОЦЕНКА 10 КОМБИНАЦИЙ ТЕХАССКОГО ХОЛДЕМА ----------
  const RANKS = '23456789TJQKA';
  const SUITS = ['s', 'h', 'd', 'c'];
  const SUIT_SYM = { s: '♠', h: '♥', d: '♦', c: '♣' };
  const HAND_NAMES = [
    'Старшая карта', 'Пара', 'Две пары', 'Сет (Тройка)', 'Стрит',
    'Флеш', 'Фулл-хаус', 'Каре', 'Стрит-флеш', 'Роял-флеш'
  ];

  function makeDeck() {
    const d = [];
    for (const r of RANKS) for (const s of SUITS) d.push(r + s);
    for (let i = d.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [d[i], d[j]] = [d[j], d[i]];
    }
    return d;
  }

  function cardHtml(code, isBig = false, isWin = false, extraCls = '', extraAttr = '') {
    const clsTail = `${isBig ? ' big' : ''}${isWin ? ' win' : ''}${extraCls ? ' ' + extraCls : ''}`;
    const attrStr = extraAttr ? ` ${extraAttr}` : '';
    if (!code || code === '??') return `<span class="bg-card back bg-card-back${clsTail}"${attrStr}></span>`;
    const r = code[0] === 'T' ? '10' : code[0];
    const s = code[1];
    const red = (s === 'h' || s === 'd') ? ' red' : '';
    return `<span class="bg-card${red}${clsTail}"${attrStr}><b>${r}</b><i>${SUIT_SYM[s] || s}</i></span>`;
  }

  function eval5Cards(cards5) {
    const vals = cards5.map(c => RANKS.indexOf(c[0]) + 2).sort((a, b) => b - a);
    const suits = cards5.map(c => c[1]);
    const isFlush = suits.every(s => s === suits[0]);
    const uniq = [...new Set(vals)];
    let isStraight = false, straightHigh = vals[0];
    if (uniq.length === 5) {
      if (vals[0] - vals[4] === 4) { isStraight = true; straightHigh = vals[0]; }
      else if (vals[0] === 14 && vals[1] === 5 && vals[4] === 2) { isStraight = true; straightHigh = 5; }
    }
    const counts = {};
    vals.forEach(v => { counts[v] = (counts[v] || 0) + 1; });
    const groups = Object.entries(counts).map(([v, c]) => ({ v: Number(v), c })).sort((a, b) => b.c - a.c || b.v - a.v);

    let cat = 0;
    let tie = groups.map(g => g.v);
    if (isStraight && isFlush) {
      cat = straightHigh === 14 ? 9 : 8;
      tie = [straightHigh];
    } else if (groups[0].c === 4) {
      cat = 7;
    } else if (groups[0].c === 3 && groups[1].c === 2) {
      cat = 6;
    } else if (isFlush) {
      cat = 5; tie = vals;
    } else if (isStraight) {
      cat = 4; tie = [straightHigh];
    } else if (groups[0].c === 3) {
      cat = 3;
    } else if (groups[0].c === 2 && groups[1].c === 2) {
      cat = 2;
    } else if (groups[0].c === 2) {
      cat = 1;
    } else {
      cat = 0; tie = vals;
    }
    let score = cat * 1e10;
    for (let i = 0; i < tie.length; i++) score += tie[i] * Math.pow(15, 4 - i);
    return { cat, name: HAND_NAMES[cat], score, best5: cards5 };
  }

  function evaluate7Cards(cards) {
    if (!cards || cards.length < 5) return { cat: 0, name: 'Старшая карта', score: 0, best5: cards || [] };
    let best = null;
    const n = cards.length;
    for (let a = 0; a < n - 4; a++)
      for (let b = a + 1; b < n - 3; b++)
        for (let c = b + 1; c < n - 2; c++)
          for (let d = c + 1; d < n - 1; d++)
            for (let e = d + 1; e < n; e++) {
              const res = eval5Cards([cards[a], cards[b], cards[c], cards[d], cards[e]]);
              if (!best || res.score > best.score) best = res;
            }
    return best;
  }

  function computeSidePots(seats) {
    const contribs = seats.map(s => ({
      id: s.id,
      bet: Math.max(0, Number(s.totalBet) || 0),
      eligible: !s.folded && !s.busted
    })).filter(c => c.bet > 0);
    const levels = [...new Set(contribs.map(c => c.bet))].sort((a, b) => a - b);
    const pots = [];
    let prev = 0;
    for (const lvl of levels) {
      const slice = lvl - prev;
      if (slice <= 0) continue;
      const contributors = contribs.filter(c => c.bet >= lvl);
      const amount = slice * contributors.length;
      const eligibleIds = contributors.filter(c => c.eligible).map(c => c.id);
      pots.push({ amount, eligibleIds });
      prev = lvl;
    }
    return pots;
  }

  // ---------- UI КОНТЕЙНЕР И НАВИГАЦИЯ ----------
  let _overlay = null;
  let _activeTab = 'tournament';
  let _subView = null; // null | { type: 'poker'|'chess', id: string }
  let _viewUnsubs = [];
  let _turnInterval = null;
  let _livePokerState = null;
  let _liveChessState = null;

  function ensureGlobalPatchStyles() {
    if (document.getElementById('bgGlobalPatchCss')) return;
    const st = document.createElement('style');
    st.id = 'bgGlobalPatchCss';
    st.textContent = `
      /* Пункт 8: Увеличение карт, банка, стеков и кнопок действий Покера на 25-30% для экранов смартфонов */
      .bg-pot {
        font-size: 15.5px !important;
        padding: 5px 15px !important;
        font-weight: 900 !important;
      }
      .bg-stage {
        font-size: 12.5px !important;
        padding: 3px 12px !important;
      }
      .bg-board {
        grid-template-columns: repeat(5, 49px) !important;
        gap: 6px !important;
        min-height: 68px !important;
      }
      .bg-card {
        width: 40px !important;
        height: 56px !important;
        border-radius: 7.5px !important;
      }
      .bg-card b {
        font-size: 15.5px !important;
        letter-spacing: -0.4px !important;
      }
      .bg-card i {
        font-size: 16px !important;
        margin-top: 1px !important;
      }
      .bg-seat.me .bg-card {
        width: 43px !important;
        height: 60px !important;
      }
      .bg-seat.me .bg-card b {
        font-size: 16.5px !important;
      }
      .bg-seat.me .bg-card i {
        font-size: 17px !important;
      }
      .bg-card.big {
        width: 49px !important;
        height: 67px !important;
        border-radius: 8.5px !important;
      }
      .bg-card.big b {
        font-size: 18px !important;
      }
      .bg-card.big i {
        font-size: 19px !important;
      }
      .bg-scards {
        min-height: 56px !important;
        gap: 4px !important;
      }
      .bg-seat {
        width: 132px !important;
      }
      .bg-sname {
        font-size: 12px !important;
      }
      .bg-sstack {
        font-size: 12.5px !important;
        font-weight: 900 !important;
      }
      .bg-sstatus {
        font-size: 10.5px !important;
      }
      .bg-sbet {
        font-size: 11.5px !important;
        padding: 2px 10px !important;
      }
      .bg-act-grid {
        gap: 8px !important;
      }
      .bg-act-grid .bg-btn {
        padding: 13px 7px !important;
        font-size: 14px !important;
        font-weight: 900 !important;
        border-radius: 12px !important;
      }

      /* Встроенный мини-чат в Покере и Шахматах + всплывающее облачко */
      .bg-chat-drawer {
        margin-top: 8px;
        padding: 10px;
        border-radius: 14px;
        background: rgba(16, 23, 18, 0.94);
        border: 1.5px solid rgba(212, 175, 105, 0.38);
        box-shadow: 0 8px 24px rgba(0,0,0,0.55);
      }
      .bg-chat-feed {
        max-height: 110px;
        overflow-y: auto;
        font-size: 12px;
        display: flex;
        flex-direction: column;
        gap: 4px;
        margin-bottom: 8px;
        padding: 6px 8px;
        border-radius: 10px;
        background: rgba(8, 12, 9, 0.65);
      }
      .bg-chat-msg {
        line-height: 1.3;
        word-break: break-word;
      }
      .bg-chat-msg b {
        color: #ffd740;
      }
      .bg-chat-quick {
        display: flex;
        flex-wrap: wrap;
        gap: 5px;
        margin-bottom: 7px;
      }
      .bg-chat-qbtn {
        padding: 5px 8px;
        border-radius: 99px;
        border: 1px solid rgba(212, 175, 105, 0.35);
        background: rgba(34, 46, 36, 0.85);
        color: #f3e2b3;
        font-size: 11.5px;
        font-weight: 800;
        cursor: pointer;
      }
      .bg-chat-qbtn:active {
        transform: scale(0.95);
      }
      .bg-chat-bubble-toast {
        position: fixed;
        left: 50%;
        top: 68px;
        transform: translateX(-50%);
        z-index: 99999;
        background: linear-gradient(135deg, rgba(25, 38, 28, 0.97), rgba(16, 24, 18, 0.97));
        border: 1.5px solid #4cd964;
        color: #fff;
        padding: 8px 14px;
        border-radius: 99px;
        font-size: 13px;
        font-weight: 800;
        box-shadow: 0 8px 26px rgba(0,0,0,0.65);
        pointer-events: none;
        max-width: 90vw;
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
      }
      .bg-chat-badge {
        display: inline-block;
        min-width: 16px;
        height: 16px;
        padding: 0 4px;
        border-radius: 99px;
        background: #ff3b30;
        color: #fff;
        font-size: 10px;
        font-weight: 900;
        line-height: 16px;
        text-align: center;
        margin-left: 4px;
      }
    `;
    document.head.appendChild(st);
  }

  async function leaveCurrentGameIfAny() {
    if (!_subView) return;
    const prev = { ..._subView };
    _subView = null;
    if (prev.type === 'poker' && prev.id) {
      await leavePokerTable(prev.id, Boolean(prev.isTournament));
    } else if (prev.type === 'chess' && prev.id) {
      await leaveChessMatchIfNeeded(prev.id);
    }
  }

  async function bgBackBtn() {
    pushTelemetryAction('bg_back_btn');
    await leaveCurrentGameIfAny();
    renderActiveView();
  }

  async function switchTab(nextTab) {
    pushTelemetryAction(`switch_tab:${nextTab}`);
    await leaveCurrentGameIfAny();
    _activeTab = nextTab || 'tournament';
    renderActiveView();
  }

  function ensureOverlay() {
    ensureGlobalPatchStyles();
    if (_overlay) return _overlay;
    const el = document.createElement('div');
    el.className = 'bg-overlay';
    el.id = 'birchOverlay';
    const leafSpecs = [
      { left: '6%',  dur: '15s', delay: '-2s',  dx: '34px',  sc: '0.85', op: '0.20' },
      { left: '16%', dur: '18s', delay: '-9s',  dx: '-28px', sc: '1.05', op: '0.16' },
      { left: '28%', dur: '13s', delay: '-5s',  dx: '40px',  sc: '0.76', op: '0.22' },
      { left: '41%', dur: '17s', delay: '-12s', dx: '-36px', sc: '0.92', op: '0.15' },
      { left: '54%', dur: '14s', delay: '-3s',  dx: '30px',  sc: '1.10', op: '0.19' },
      { left: '67%', dur: '19s', delay: '-14s', dx: '-32px', sc: '0.80', op: '0.17' },
      { left: '79%', dur: '16s', delay: '-7s',  dx: '26px',  sc: '0.96', op: '0.21' },
      { left: '90%', dur: '13.5s', delay: '-11s', dx: '-38px', sc: '0.84', op: '0.18' }
    ];
    const leavesHtml = leafSpecs.map(l =>
      `<span class="bg-birch-leaf" style="left:${l.left};--ldur:${l.dur};--ldelay:${l.delay};--ldx:${l.dx};--lsc:${l.sc};--lop:${l.op}"></span>`
    ).join('');

    el.innerHTML = `
      <div class="bg-forest-ambience" aria-hidden="true">
        <div class="bg-bark-edge left"></div>
        <div class="bg-bark-edge right"></div>
        ${leavesHtml}
      </div>
      <div class="bg-head">
        <button class="bg-back" id="bgBackBtn" hidden>←</button>
        <div class="bg-title" id="bgTitle">🌿 Берёзовая Роща ОРЕО67</div>
        <div class="bg-wallet" id="bgWallet">🪙 0 | 🪵 0</div>
        <button class="bg-close" id="bgCloseBtn">✕</button>
      </div>
      <div class="bg-tabs" id="bgTabs">
        <button class="bg-tab active" data-bgtab="tournament">🃏 Турнир Холдем</button>
        <button class="bg-tab" data-bgtab="duels">⚔️ Вызвать игрока (Дуэли)</button>
        <button class="bg-tab" data-bgtab="skincases">🎁 Кейсы скинов</button>
        <button class="bg-tab" data-bgtab="friendly">🪵 Столы 24/7</button>
        <button class="bg-tab" data-bgtab="admin" id="bgAdminTabBtn" hidden>👑 Админ-консоль</button>
      </div>
      <div class="bg-body" id="bgBody"></div>
      <div class="bg-ko" id="bgKoAnim">
        <div class="bg-log3d"><div class="half l"></div><div class="half r"></div><div class="bg-axe">🪓</div></div>
        <div class="bg-ko-text" id="bgKoText">🪓 ЧУРКА РАСКОЛОТА! +20 000 🪙 Баунти!</div>
      </div>
    `;
    document.body.appendChild(el);
    _overlay = el;

    el.querySelector('#bgCloseBtn').onclick = () => closeZone();
    el.querySelector('#bgBackBtn').onclick = () => bgBackBtn();
    el.querySelectorAll('.bg-tab').forEach(btn => {
      btn.onclick = () => switchTab(btn.dataset.bgtab);
    });
    return el;
  }

  function playKnockoutAnimation(victimName, killerName) {
    ensureOverlay();
    const ko = document.getElementById('bgKoAnim');
    const txt = document.getElementById('bgKoText');
    if (!ko || !txt) return;
    txt.innerHTML = `🪓 <b>${esc(killerName)}</b> расколол чурку <b>${esc(victimName)}</b>!<br>+20 000 🪙 Баунти и +1 в «Наколотые чурки»!`;
    ko.classList.add('show');
    setTimeout(() => ko.classList.remove('show'), 2600);
  }

  function refreshHeaderWallet() {
    const w = document.getElementById('bgWallet');
    if (w) w.innerHTML = `🪙 ${fmt(getCoins())} &nbsp;|&nbsp; ${stickSvg(false)} ${fmt(getSticks())}`;
    const admTab = document.getElementById('bgAdminTabBtn');
    const admBtn = document.getElementById('birchAdminBtn');
    const isAdm = isAdminUser();
    if (admTab) admTab.hidden = !isAdm;
    if (admBtn) admBtn.hidden = !isAdm;
  }

  function openZone(tab = 'tournament', sub = null) {
    ensureOverlay();
    _activeTab = tab;
    _subView = sub;
    _overlay.classList.add('show');
    try { if (window.OreoPerf && window.OreoPerf.setOverlay) window.OreoPerf.setOverlay('birch', true); } catch (e) {}
    pushTelemetryAction(`open_zone:${sub ? `${sub.type}:${sub.id}` : tab}`);
    refreshHeaderWallet();
    renderActiveView();
  }

  async function closeZone() {
    await leaveCurrentGameIfAny();
    clearViewWatchers();
    if (_turnInterval) { clearInterval(_turnInterval); _turnInterval = null; }
    if (_overlay) _overlay.classList.remove('show');
    try { if (window.OreoPerf && window.OreoPerf.setOverlay) window.OreoPerf.setOverlay('birch', false); } catch (e) {}
    pushTelemetryAction('close_zone');
  }

  function renderActiveView() {
    clearViewWatchers();
    if (_turnInterval) { clearInterval(_turnInterval); _turnInterval = null; }
    if (!_subView) {
      _livePokerState = null;
      _liveChessState = null;
    }
    refreshHeaderWallet();
    const tabsEl = document.getElementById('bgTabs');
    const backBtn = document.getElementById('bgBackBtn');
    const body = document.getElementById('bgBody');
    if (!body) return;

    body.classList.remove('bg-pane-anim');
    void body.offsetWidth;
    body.classList.add('bg-pane-anim');

    tabsEl.querySelectorAll('.bg-tab').forEach(t => t.classList.toggle('active', t.dataset.bgtab === _activeTab));

    if (_subView) {
      tabsEl.hidden = true;
      backBtn.hidden = false;
      pushTelemetryAction(`view:${_subView.type}:${_subView.id}`);
      if (_subView.type === 'poker') renderPokerTableView(body, _subView.id, _subView.isTournament);
      else if (_subView.type === 'chess') renderChessMatchView(body, _subView.id);
      return;
    }

    tabsEl.hidden = false;
    backBtn.hidden = true;
    pushTelemetryAction(`tab:${_activeTab}`);
    if (_activeTab === 'tournament') renderTournamentTab(body);
    else if (_activeTab === 'duels') renderDuelsTab(body);
    else if (_activeTab === 'skincases') renderSkinCasesTab(body);
    else if (_activeTab === 'friendly') renderFriendlyTablesTab(body);
    else if (_activeTab === 'admin' && isAdminUser()) renderAdminConsoleTab(body);
    else renderTournamentTab(body);
  }

  // ==================== 1. ВЕБ-АДМИНКА (MY_USER_ID = 594228143) ====================
  let _admSubTab = 'players';
  let _admSearchQuery = '';
  let _admSelectedUid = '';

  function renderAdminConsoleTab(body) {
    document.getElementById('bgTitle').textContent = '👑 Live Админ-консоль ОРЕО67';
    body.innerHTML = `
      <div class="bg-row" style="margin-bottom:10px">
        <button class="bg-btn ${ _admSubTab === 'players' ? 'green' : 'ghost' }" id="admTabPlayers">👥 Live-редактор</button>
        <button class="bg-btn ${ _admSubTab === 'skins' ? '' : 'ghost' }" id="admTabSkins">🎭 Скины</button>
        <button class="bg-btn ${ _admSubTab === 'tour' ? '' : 'ghost' }" id="admTabTour">🃏 Турниры и Банк</button>
        <button class="bg-btn ${ _admSubTab === 'crashes' ? 'red' : 'ghost' }" id="admTabCrashes">🧯 Краш-логи</button>
      </div>
      <div id="admSubBody"></div>
    `;
    body.querySelector('#admTabPlayers').onclick = () => { _admSubTab = 'players'; pushTelemetryAction('adm_sub:players'); renderAdminConsoleTab(body); };
    body.querySelector('#admTabSkins').onclick = () => { _admSubTab = 'skins'; pushTelemetryAction('adm_sub:skins'); renderAdminConsoleTab(body); };
    body.querySelector('#admTabTour').onclick = () => { _admSubTab = 'tour'; pushTelemetryAction('adm_sub:tour'); renderAdminConsoleTab(body); };
    body.querySelector('#admTabCrashes').onclick = () => { _admSubTab = 'crashes'; pushTelemetryAction('adm_sub:crashes'); renderAdminConsoleTab(body); };

    const sub = body.querySelector('#admSubBody');
    if (_admSubTab === 'players') renderAdminPlayersSub(sub);
    else if (_admSubTab === 'skins') renderAdminSkinsSub(sub);
    else if (_admSubTab === 'crashes') renderAdminCrashesSub(sub);
    else renderAdminTourSub(sub);
  }

  const INACTIVE_THRESHOLD_MS = 7 * 86400000;
  let _admInactiveRaffleLogHtml = '';
  const _admUncheckedInactive = new Set();

  function extractPlayerNormalized(uid, raw) {
    const p = (raw && typeof raw === 'object') ? raw : {};
    const w = (p.wallet && typeof p.wallet === 'object') ? p.wallet : {};
    const pickNum = (k, fallback) => {
      if (p[k] !== undefined && p[k] !== null && p[k] !== '') return Math.max(0, Math.round(Number(p[k]) || 0));
      if (w[k] !== undefined && w[k] !== null && w[k] !== '') return Math.max(0, Math.round(Number(w[k]) || 0));
      return fallback;
    };
    const coins = pickNum('coins', pickNum('taps', pickNum('count', 0)));
    const gems = pickNum('gems', 5);
    const energy = pickNum('energy', 500);
    const sticks = pickNum('sticks', 0);
    const choppedLogs = pickNum('choppedLogs', 0);
    const equippedSkin = String(p.equippedSkin || p.skin || w.equippedSkin || w.skin || 'classic');
    const lastSeen = Number(p.lastSeen || p.ts || p.updatedAt || w.lastSeen || w.ts || 0);
    return Object.assign({}, p, {
      id: String(uid || p.id || ''),
      name: String(p.name || uid || 'Тапер'),
      username: String(p.username || ''),
      coins,
      gems,
      energy,
      sticks,
      choppedLogs,
      equippedSkin,
      lastSeen
    });
  }

  function formatLastSeenBadge(lastSeenTs) {
    const ts = Number(lastSeenTs) || 0;
    if (!ts) return '⏳ нет данных (>7д)';
    const diff = Math.max(0, Date.now() - ts);
    const mins = Math.floor(diff / 60000);
    if (mins < 5) return '🟢 онлайн';
    if (mins < 60) return `🕒 ${mins} мин. назад`;
    const hours = Math.floor(mins / 60);
    if (hours < 24) return `🕒 ${hours} ч. назад`;
    const days = Math.floor(hours / 24);
    return `${days >= 7 ? '🔴' : '🕒'} ${days} дн. назад`;
  }

  function renderAdminPlayersSub(sub) {
    sub.innerHTML = `
      <div class="bg-sec" id="admInactiveFundSec">
        <h3>🎰 Фонд активности (Неактивные &gt; 7 дней)</h3>
        <div id="admInactiveFundBox">Анализ активности игроков...</div>
        <div id="admInactiveRaffleLog">${_admInactiveRaffleLogHtml}</div>
      </div>
      <div class="bg-sec">
        <h3>🔍 Live-поиск и мгновенная выдача ресурсов</h3>
        <input class="bg-input" id="admSearchInp" placeholder="Поиск по имени, ID или @username..." value="${esc(_admSearchQuery)}">
        <div id="admPlayersList" style="margin-top:10px">Загрузка списка игроков из Firebase...</div>
      </div>
    `;
    const inp = sub.querySelector('#admSearchInp');
    let latestPlayers = {};
    inp.oninput = () => { _admSearchQuery = inp.value.trim(); drawPlayers(latestPlayers, true); };

    function drawPlayers(data, forceRender = false) {
      latestPlayers = data || {};
      const activeEl = document.activeElement;
      if (!forceRender && activeEl && sub.contains(activeEl) && activeEl.id !== 'admSearchInp' && ['INPUT', 'SELECT', 'TEXTAREA'].includes(activeEl.tagName)) {
        return;
      }

      const box = sub.querySelector('#admPlayersList');
      const fundBox = sub.querySelector('#admInactiveFundBox');
      if (!box) return;
      const now = Date.now();
      const arr = Object.entries(latestPlayers).map(([k, v]) => extractPlayerNormalized(k, v));
      arr.sort((a, b) => (Number(b.coins) || 0) - (Number(a.coins) || 0));

      // --- Блок «Фонд активности (Неактивные > 7 дней)» ---
      if (fundBox) {
        const inactiveCandidates = arr.filter(p =>
          p.id &&
          String(p.id) !== MY_ADMIN_ID &&
          !p.excludedFromLeaderboard &&
          p.coins > 0 &&
          (!p.lastSeen || (now - p.lastSeen > INACTIVE_THRESHOLD_MS))
        );
        const activeThisWeek = arr.filter(p =>
          p.id &&
          String(p.id) !== MY_ADMIN_ID &&
          !p.excludedFromLeaderboard &&
          p.lastSeen > 0 &&
          (now - p.lastSeen <= INACTIVE_THRESHOLD_MS)
        );
        const selectedInactive = inactiveCandidates.filter(p => !_admUncheckedInactive.has(String(p.id)));
        const totalInactiveBank = selectedInactive.reduce((s, p) => s + p.coins, 0);

        fundBox.innerHTML = `
          <div class="bg-muted" style="margin-bottom:8px">
            Неактивных (&gt; 7 дней с балансом &gt; 0): <b>${inactiveCandidates.length}</b> •
            Выбрано к розыгрышу: <b style="color:#ffd740">${fmt(totalInactiveBank)} 🪙</b> •
            Активных таперов недели: <b style="color:#4cd964">${activeThisWeek.length}</b>
          </div>
          ${inactiveCandidates.length ? `
            <div style="max-height:150px;overflow-y:auto;display:flex;flex-direction:column;gap:5px;margin-bottom:8px">
              ${inactiveCandidates.map(p => {
                const checked = !_admUncheckedInactive.has(String(p.id));
                const daysOff = p.lastSeen ? Math.floor((now - p.lastSeen) / 86400000) : 7;
                return `
                  <label class="bg-item" style="padding:6px 10px;cursor:pointer;display:flex;align-items:center;gap:8px">
                    <input type="checkbox" data-inact-chk="${esc(p.id)}" ${checked ? 'checked' : ''}>
                    <div class="grow">
                      <b>${esc(p.name)} ${p.username ? `<small>@${esc(p.username)}</small>` : ''}</b>
                      <small>ID: ${esc(p.id)} • Оффлайн: ${daysOff}+ дн.</small>
                    </div>
                    <span class="bg-chip gold">🪙 ${fmt(p.coins)}</span>
                  </label>
                `;
              }).join('')}
            </div>
            <div class="bg-row" style="gap:8px">
              <button class="bg-btn sm wood" id="admWarnInactiveBtn">🔔 Напомнить (${selectedInactive.length})</button>
              <button class="bg-btn sm green" id="admRaffleInactiveBtn">🎰 Разыграть банк неактивных (${fmt(totalInactiveBank)} 🪙)</button>
            </div>
          ` : `<div class="bg-muted">✨ Сейчас нет неактивных игроков (&gt; 7 дней оффлайн) с ненулевым балансом.</div>`}
        `;

        fundBox.querySelectorAll('[data-inact-chk]').forEach(chk => {
          chk.onchange = () => {
            const id = chk.getAttribute('data-inact-chk');
            if (chk.checked) _admUncheckedInactive.delete(id);
            else _admUncheckedInactive.add(id);
            drawPlayers(latestPlayers, true);
          };
        });

        const warnBtn = fundBox.querySelector('#admWarnInactiveBtn');
        if (warnBtn) {
          warnBtn.onclick = async () => {
            if (!selectedInactive.length) return toast('⚠️ Выберите хотя бы одного неактивного игрока');
            const ts = Date.now();
            const warnPayload = {};
            selectedInactive.forEach(p => {
              warnPayload[p.id] = {
                userId: p.id,
                name: p.name,
                username: p.username || '',
                coins: p.coins,
                warnedAt: ts,
                message: `🔔 Привет, ${p.name}! Ты не заходил в ОРЕО67 более 7 дней. Зайди и тапни, иначе твой банк (${fmt(p.coins)} 🪙) будет разыгран среди активных игроков недели!`
              };
            });
            await fbPatch('inactive_warnings', warnPayload);
            pushTelemetryAction(`adm_warn_inactive:${selectedInactive.length}`);
            toast(`🔔 Отправлено напоминание ${selectedInactive.length} неактивным игрокам!`);
          };
        }

        const raffleBtn = fundBox.querySelector('#admRaffleInactiveBtn');
        if (raffleBtn) {
          raffleBtn.onclick = async () => {
            if (!selectedInactive.length || totalInactiveBank <= 0) {
              return toast('⚠️ Нет выбранного банка неактивных для розыгрыша');
            }
            const recipients = activeThisWeek.length
              ? activeThisWeek
              : arr.filter(p => p.id && String(p.id) !== MY_ADMIN_ID && !p.excludedFromLeaderboard && !selectedInactive.some(si => si.id === p.id));
            if (!recipients.length) {
              return toast('⚠️ Нет активных игроков для получения банка');
            }
            raffleBtn.disabled = true;
            raffleBtn.textContent = '⏳ Розыгрыш банка...';
            try {
              const logEntries = [];
              const ts = Date.now();
              for (const donor of selectedInactive) {
                const confiscated = donor.coins;
                if (confiscated <= 0) continue;
                // Обнуляем коины у неактивного игрока
                await adminModifyPlayerResource(donor.id, 'coins', 'reset', 0);
                // Выбираем случайного активного тапера недели (или распределяем по весу активности)
                const luckyWinner = recipients[Math.floor(Math.random() * recipients.length)];
                await adminModifyPlayerResource(luckyWinner.id, 'coins', 'add', confiscated);
                logEntries.push({
                  fromId: donor.id,
                  fromName: donor.name,
                  toId: luckyWinner.id,
                  toName: luckyWinner.name,
                  amount: confiscated,
                  ts
                });
              }
              await fbPut(`inactive_raffle_logs/${ts}`, {
                ts,
                totalBank: totalInactiveBank,
                entries: logEntries
              });
              _admInactiveRaffleLogHtml = `
                <div class="bg-result" style="margin-top:8px;text-align:left">
                  <h4>🎉 Итоги розыгрыша банка неактивных (${fmt(totalInactiveBank)} 🪙):</h4>
                  ${logEntries.map(e => `<div style="font-size:12px;margin-top:3px">• Банк <b>${esc(e.fromName)}</b> (${fmt(e.amount)} 🪙) → получил активный тапер <b>${esc(e.toName)}</b> (ID ${esc(e.toId)})!</div>`).join('')}
                </div>
              `;
              const logEl = sub.querySelector('#admInactiveRaffleLog');
              if (logEl) logEl.innerHTML = _admInactiveRaffleLogHtml;
              pushTelemetryAction(`adm_raffle_inactive:${logEntries.length}:${totalInactiveBank}`);
              toast(`🎰 Разыграно ${fmt(totalInactiveBank)} 🪙 среди активных таперов!`);
            } finally {
              raffleBtn.disabled = false;
            }
          };
        }
      }

      const q = _admSearchQuery.toLowerCase().replace(/^@/, '');
      const filtered = q ? arr.filter(p =>
        String(p.name || '').toLowerCase().includes(q) ||
        String(p.id || '').toLowerCase().includes(q) ||
        String(p.username || '').toLowerCase().includes(q)
      ) : arr;

      if (!filtered.length) {
        box.innerHTML = `<div class="bg-muted">Игроки не найдены</div>`;
        return;
      }

      const skinOptions = ['classic', 'gold', 'berry', 'mint', 'cyber', 'lava', 'diamond', 'twix', 'shushik', 'airochai', 'denis_lykasov'];

      box.innerHTML = filtered.slice(0, 30).map(p => {
        const uid = String(p.id);
        const isSel = _admSelectedUid === uid;
        return `
          <div class="bg-item ${isSel ? 'sel' : ''}" data-uid="${esc(uid)}" style="flex-direction:column;align-items:stretch">
            <div class="bg-row sp" style="cursor:pointer" data-pick="${esc(uid)}">
              <div>
                <b>👤 ${esc(p.name || uid)} ${p.username ? `<small>@${esc(p.username)}</small>` : ''}${shushikInlineBadgesHtml(uid, p.equippedSkin)}</b>
                <small>ID: ${esc(uid)} • Скин: <b>${esc(p.equippedSkin)}</b> • ${formatLastSeenBadge(p.lastSeen)}</small>
              </div>
              <span class="bg-chip gold">🪙 ${fmt(p.coins)}</span>
            </div>
            <div class="bg-adm-grid">
              <div>🪙 ${fmt(p.coins)}</div>
              <div>💎 ${fmt(p.gems)}</div>
              <div>⚡ ${fmt(p.energy)}</div>
              <div>🪵 ${fmt(p.sticks)}</div>
            </div>
            ${isSel ? `
              <div class="bg-adm-res">
                ${['coins:🪙 Коины', 'gems:💎 Кристаллы', 'energy:⚡ Энергия', 'sticks:🪵 Палочки'].map(pair => {
                  const [rk, rlabel] = pair.split(':');
                  const curVal = p[rk] || 0;
                  return `
                    <div class="bg-row sp" style="margin-top:6px;flex-wrap:wrap;gap:4px">
                      <small><b>${rlabel}: ${fmt(curVal)}</b></small>
                      <div class="bg-row" style="gap:4px">
                        <button class="bg-btn sm green" data-act="${esc(uid)}:${rk}:add:10000">+10k</button>
                        <button class="bg-btn sm green" data-act="${esc(uid)}:${rk}:add:100000">+100k</button>
                        <button class="bg-btn sm green" data-act="${esc(uid)}:${rk}:add:1000000">+1M</button>
                        <button class="bg-btn sm ghost" data-act="${esc(uid)}:${rk}:add:-10000">-10k</button>
                        <button class="bg-btn sm red" data-act="${esc(uid)}:${rk}:reset:0">Сброс</button>
                      </div>
                    </div>
                  `;
                }).join('')}
                <div style="margin-top:10px;padding-top:8px;border-top:1px dashed rgba(212,175,105,0.28);display:grid;grid-template-columns:repeat(2,1fr);gap:6px">
                  <label style="font-size:11px">🪙 Коины:<input type="number" class="bg-input" data-edit-field="coins" value="${p.coins}"></label>
                  <label style="font-size:11px">💎 Кристаллы:<input type="number" class="bg-input" data-edit-field="gems" value="${p.gems}"></label>
                  <label style="font-size:11px">⚡ Энергия:<input type="number" class="bg-input" data-edit-field="energy" value="${p.energy}"></label>
                  <label style="font-size:11px">🪵 Палочки:<input type="number" class="bg-input" data-edit-field="sticks" value="${p.sticks}"></label>
                  <label style="font-size:11px;grid-column:span 2">🎭 Скин (equippedSkin):
                    <select class="bg-input" data-edit-field="equippedSkin">
                      ${skinOptions.map(sk => `<option value="${sk}" ${p.equippedSkin === sk ? 'selected' : ''}>${sk}</option>`).join('')}
                    </select>
                  </label>
                  <button class="bg-btn green" data-save-direct="${esc(uid)}" style="grid-column:span 2">💾 Сохранить значения игрока</button>
                </div>
              </div>
            ` : ''}
          </div>
        `;
      }).join('');

      box.querySelectorAll('[data-pick]').forEach(el => {
        el.onclick = () => {
          const u = el.getAttribute('data-pick');
          _admSelectedUid = (_admSelectedUid === u) ? '' : u;
          drawPlayers(latestPlayers, true);
        };
      });

      box.querySelectorAll('[data-act]').forEach(btn => {
        btn.onclick = async (e) => {
          e.stopPropagation();
          const [uid, rk, mode, amtStr] = btn.getAttribute('data-act').split(':');
          await adminModifyPlayerResource(uid, rk, mode, Number(amtStr));
        };
      });

      box.querySelectorAll('[data-save-direct]').forEach(btn => {
        btn.onclick = async (e) => {
          e.stopPropagation();
          const uid = btn.getAttribute('data-save-direct');
          const cardEl = btn.closest('[data-uid]');
          if (!cardEl) return;
          const getVal = (f) => {
            const el = cardEl.querySelector(`[data-edit-field="${f}"]`);
            return el ? el.value : '';
          };
          const nextCoins = Math.max(0, Math.round(Number(getVal('coins')) || 0));
          const nextGems = Math.max(0, Math.round(Number(getVal('gems')) || 0));
          const nextEnergy = Math.max(0, Math.round(Number(getVal('energy')) || 0));
          const nextSticks = Math.max(0, Math.round(Number(getVal('sticks')) || 0));
          const nextSkin = String(getVal('equippedSkin') || 'classic');
          await adminSaveFullPlayerProfile(uid, {
            coins: nextCoins,
            gems: nextGems,
            energy: nextEnergy,
            sticks: nextSticks,
            equippedSkin: nextSkin
          });
        };
      });
    }

    _viewUnsubs.push(onValue('players', drawPlayers, 2000));
  }

  async function adminSaveFullPlayerProfile(uid, fields) {
    const now = Date.now();
    const raw = await fbGet(`players/${encodeURIComponent(uid)}`);
    const cur = extractPlayerNormalized(uid, raw);
    const coins = fields.coins !== undefined ? Math.max(0, Math.round(Number(fields.coins) || 0)) : cur.coins;
    const gems = fields.gems !== undefined ? Math.max(0, Math.round(Number(fields.gems) || 0)) : cur.gems;
    const energy = fields.energy !== undefined ? Math.max(0, Math.round(Number(fields.energy) || 0)) : cur.energy;
    const sticks = fields.sticks !== undefined ? Math.max(0, Math.round(Number(fields.sticks) || 0)) : cur.sticks;
    const equippedSkin = fields.equippedSkin || cur.equippedSkin || 'classic';
    const wallet = Object.assign({}, (raw && raw.wallet) || {}, {
      coins, gems, energy, sticks, equippedSkin, lastSeen: cur.lastSeen || now
    });
    const patch = {
      coins,
      taps: coins,
      count: coins,
      gems,
      energy,
      sticks,
      skin: equippedSkin,
      equippedSkin,
      wallet,
      adminUpdatedAt: now
    };
    await fbPatch(`players/${encodeURIComponent(uid)}`, patch);
    for (const rk of ['coins', 'gems', 'energy', 'sticks']) {
      if (fields[rk] !== undefined && fields[rk] !== cur[rk]) {
        await fbPut(`admin_grants/${encodeURIComponent(uid)}/${now}_${rk}`, {
          resource: rk, mode: 'set', delta: fields[rk] - cur[rk], newValue: fields[rk], ts: now, claimed: false
        });
      }
    }
    if (fields.equippedSkin && fields.equippedSkin !== cur.equippedSkin) {
      await fbPatch(`players/${encodeURIComponent(uid)}/unlocked_skins`, { [equippedSkin]: true });
      await fbPut(`admin_grants/${encodeURIComponent(uid)}/${now}_skin`, {
        resource: 'skin', skinId: equippedSkin, mode: 'unlock', delta: 1, newValue: 1, ts: now, claimed: false
      });
    }
    if (String(uid) === getMe().id) {
      updateLocalWallet({ coins, gems, energy, sticks, equippedSkin });
    }
    pushTelemetryAction(`adm_save_profile:${uid}`);
    toast(`💾 Профиль игрока ${uid} сохранён!`);
  }

  async function adminModifyPlayerResource(uid, resKey, mode, deltaOrVal) {
    const now = Date.now();
    const raw = (await fbGet(`players/${encodeURIComponent(uid)}`)) || { id: uid, coins: 0, gems: 5, energy: 500, sticks: 0 };
    const norm = extractPlayerNormalized(uid, raw);
    const cur = Math.max(0, Number(norm[resKey]) || 0);
    const nextVal = mode === 'reset' ? 0 : (mode === 'set' ? Math.max(0, Math.round(Number(deltaOrVal) || 0)) : Math.max(0, Math.round(cur + deltaOrVal)));
    const delta = nextVal - cur;
    const prevWallet = (raw && typeof raw.wallet === 'object') ? raw.wallet : {};
    const nextWallet = Object.assign({}, prevWallet, {
      coins: resKey === 'coins' ? nextVal : norm.coins,
      gems: resKey === 'gems' ? nextVal : norm.gems,
      energy: resKey === 'energy' ? nextVal : norm.energy,
      sticks: resKey === 'sticks' ? nextVal : norm.sticks,
      equippedSkin: norm.equippedSkin
    });
    const patch = {
      [resKey]: nextVal,
      coins: nextWallet.coins,
      gems: nextWallet.gems,
      energy: nextWallet.energy,
      sticks: nextWallet.sticks,
      skin: norm.equippedSkin,
      equippedSkin: norm.equippedSkin,
      wallet: nextWallet,
      ts: now,
      adminUpdatedAt: now
    };
    if (resKey === 'coins') {
      patch.taps = nextVal;
      patch.count = nextVal;
      if (mode === 'reset') patch.adminResetId = (Number(raw.adminResetId) || 0) + 1;
    }
    await fbPatch(`players/${encodeURIComponent(uid)}`, patch);
    await fbPut(`admin_grants/${encodeURIComponent(uid)}/${now}`, {
      resource: resKey, mode, delta, newValue: nextVal, ts: now, claimed: false
    });
    if (String(uid) === getMe().id) updateLocalWallet({ [resKey]: nextVal });
    toast(`✅ ${uid}: ${resKey} → ${fmt(nextVal)}`);
  }

  function renderAdminTourSub(sub) {
    sub.innerHTML = `
      <div class="bg-sec">
        <h3>🏦 Общий Банк Турниров (Спонсорский пул)</h3>
        <div class="bg-bank" id="admBankVal">🪙 Загрузка...</div>
        <div class="bg-row" style="margin-top:8px">
          <button class="bg-btn sm green" id="admBankAdd10M">+10M 🪙</button>
          <button class="bg-btn sm green" id="admBankAdd1B">+1B 🪙</button>
          <button class="bg-btn sm ghost" id="admBankRestore">🔄 Дефолт Павла</button>
        </div>
      </div>
      <div class="bg-sec">
        <h3>🃏 Создать официальный турнир «Берёзовый Холдем»</h3>
        <div style="display:grid;gap:8px">
          <input class="bg-input" id="admTourTitle" value="Берёзовый Кубок ОРЕО67" placeholder="Название турнира">
          <input class="bg-input" id="admTourSponsor" type="number" value="10000000" placeholder="Спонсорский вклад из Общего банка (🪙)">
          <button class="bg-btn" id="admCreateTourBtn">🚀 Создать официальный турнир</button>
        </div>
      </div>
      <div class="bg-sec" id="admActiveTourCtrl">
        <h3>🎛 Управление текущим турниром</h3>
        <div id="admTourBox">Загрузка...</div>
      </div>
    `;

    let bankCoins = PAVEL_BANK_DEFAULT;
    _viewUnsubs.push(onValue('common_bank', data => {
      bankCoins = (data && data.coins !== undefined) ? Number(data.coins) : PAVEL_BANK_DEFAULT;
      const el = sub.querySelector('#admBankVal');
      if (el) el.textContent = `🪙 ${fmt(bankCoins)}`;
    }, 2500));

    sub.querySelector('#admBankAdd10M').onclick = () => fbPatch('common_bank', { coins: bankCoins + 10000000, updatedAt: Date.now() });
    sub.querySelector('#admBankAdd1B').onclick = () => fbPatch('common_bank', { coins: bankCoins + 1000000000, updatedAt: Date.now() });
    sub.querySelector('#admBankRestore').onclick = () => fbPut('common_bank', { coins: PAVEL_BANK_DEFAULT, sponsor: 'Pavel', updatedAt: Date.now() });

    sub.querySelector('#admCreateTourBtn').onclick = async () => {
      const title = sub.querySelector('#admTourTitle').value.trim() || 'Берёзовый Кубок ОРЕО67';
      const sponsorPool = Math.max(0, Math.min(bankCoins, Number(sub.querySelector('#admTourSponsor').value) || 0));
      const tid = `tour_${Date.now()}`;
      await fbPatch('common_bank', { coins: Math.max(0, bankCoins - sponsorPool), updatedAt: Date.now() });
      const tourObj = {
        id: tid,
        title,
        status: 'registering',
        blindLevel: 1,
        sponsorPool,
        buyInsPool: 0,
        total_prize_pool: sponsorPool,
        bountyPool: 0,
        createdAt: Date.now(),
        participants: {}
      };
      await fbPut(`poker_tournaments/${tid}`, tourObj);
      await fbPut('active_tournament', tourObj);
      await createOrResetPokerTable(tid, title, true, sponsorPool);
      toast('🚀 Официальный турнир создан!');
    };

    _viewUnsubs.push(onValue('active_tournament', tour => {
      const box = sub.querySelector('#admTourBox');
      if (!box) return;
      if (!tour || !tour.id) {
        box.innerHTML = `<div class="bg-muted">Нет активного турнира</div>`;
        return;
      }
      const parts = Object.values(tour.participants || {});
      box.innerHTML = `
        <div class="bg-row sp">
          <b>${esc(tour.title)} <span class="bg-chip gold">${esc(tour.status)}</span></b>
          <span>Блайнды: Ур. ${tour.blindLevel || 1}</span>
        </div>
        <div style="margin:6px 0;font-size:13px">
          💰 Призовой пул (total_prize_pool): <b style="color:#ffd740">${fmt(tour.total_prize_pool || tour.prizePool || 0)} 🪙</b>
          (Спонсор: ${fmt(tour.sponsorPool || tour.prizePool || 0)} 🪙 + 80% взносов: ${fmt(tour.buyInsPool || 0)} 🪙)
        </div>
        <div class="bg-row" style="margin:8px 0">
          <button class="bg-btn sm green" id="admBtnStart">▶️ Старт</button>
          <button class="bg-btn sm wood" id="admBtnAddon">⏸ Перерыв на Аддон</button>
          <button class="bg-btn sm ghost" id="admBtnLvlUp">⬆️ Уровень блайндов +1</button>
          <button class="bg-btn sm" id="admBtnFinish">🏆 Завершить и раздать призы</button>
          <button class="bg-btn sm red" id="admBtnCancel">🛑 Отмена (возврат коинов)</button>
        </div>
        <h4>Участники (${parts.length}):</h4>
        ${parts.map(p => `
          <div class="bg-item">
            <div class="grow">
              <b>${esc(p.name)}</b>
              <small>Вложено: ${fmt(p.spentCoins || 0)} 🪙 • Стек: ${fmt(p.sticks || 0)} 🪵 • Чурки: ${p.bounties || 0}</small>
            </div>
            <button class="bg-btn sm red" data-kick="${esc(p.id)}">Кик</button>
          </div>
        `).join('') || '<div class="bg-muted">Пока никто не вошёл</div>'}
      `;

      box.querySelector('#admBtnStart').onclick = async () => {
        await updateTourBoth(tour.id, { status: 'running' });
        await startTableNewHand(tour.id);
        toast('▶️ Турнир запущен!');
      };
      box.querySelector('#admBtnAddon').onclick = async () => {
        await updateTourBoth(tour.id, { status: 'addon_break' });
        toast('⏸ Объявлен перерыв на Аддон и Двойной Аддон!');
      };
      box.querySelector('#admBtnLvlUp').onclick = async () => {
        const nextLvl = Math.min(BLIND_LEVELS.length, (Number(tour.blindLevel) || 1) + 1);
        await updateTourBoth(tour.id, { blindLevel: nextLvl });
        await fbPatch(`poker_tables/${tour.id}`, { blindLevel: nextLvl });
        toast(`⬆️ Уровень блайндов повышен до ${nextLvl}!`);
      };
      box.querySelector('#admBtnCancel').onclick = async () => {
        await cancelTournamentAndRefund(tour);
      };
      box.querySelector('#admBtnFinish').onclick = async () => {
        await finalizeTournamentPrizes(tour);
      };
      box.querySelectorAll('[data-kick]').forEach(kb => {
        kb.onclick = async () => {
          const kuid = kb.getAttribute('data-kick');
          await kickPlayerFromTournament(tour, kuid);
        };
      });
    }, 2000));
  }

  async function updateTourBoth(tid, patch) {
    await fbPatch(`poker_tournaments/${tid}`, patch);
    await fbPatch('active_tournament', patch);
  }

  async function kickPlayerFromTournament(tour, uid) {
    await fbDelete(`poker_tournaments/${tour.id}/participants/${encodeURIComponent(uid)}`);
    await fbDelete(`active_tournament/participants/${encodeURIComponent(uid)}`);
    await runTransaction(`poker_tables/${tour.id}`, tbl => {
      if (!tbl || !Array.isArray(tbl.seats)) return tbl;
      tbl.seats = tbl.seats.filter(s => String(s.id) !== String(uid));
      return tbl;
    });
    toast(`👢 Игрок ${uid} исключён со стола`);
  }

  async function cancelTournamentAndRefund(tour) {
    const parts = Object.values(tour.participants || {});
    for (const p of parts) {
      const refund = Math.max(0, Number(p.spentCoins) || 0);
      if (refund > 0 && p.id) {
        await adminModifyPlayerResource(p.id, 'coins', 'add', refund);
      }
    }
    const sponsor = Math.max(0, Number(tour.sponsorPool || tour.prizePool) || 0);
    if (sponsor > 0) {
      const cb = await fbGet('common_bank');
      const curBank = (cb && cb.coins) ? Number(cb.coins) : PAVEL_BANK_DEFAULT;
      await fbPatch('common_bank', { coins: curBank + sponsor, updatedAt: Date.now() });
    }
    await updateTourBoth(tour.id, { status: 'cancelled', total_prize_pool: 0 });
    toast('🛑 Турнир отменён, все взносы возвращены игрокам!');
  }

  async function finalizeTournamentPrizes(tour) {
    const tbl = await fbGet(`poker_tables/${tour.id}`);
    const parts = Object.values(tour.participants || {});
    if (tbl && Array.isArray(tbl.seats)) {
      tbl.seats.forEach(s => {
        const found = parts.find(p => String(p.id) === String(s.id));
        if (found) found.sticks = s.stack;
      });
    }
    parts.sort((a, b) => (Number(b.sticks) || 0) - (Number(a.sticks) || 0));
    const totalPool = Math.max(0, Number(tour.total_prize_pool || tour.prizePool) || 0);
    const n = parts.length;
    if (n === 0) return toast('⚠️ Нет участников для награждения');

    const payouts = n <= 5
      ? [{ pct: 0.65, gems: 50 }, { pct: 0.35, gems: 30 }]
      : [{ pct: 0.50, gems: 50 }, { pct: 0.30, gems: 30 }, { pct: 0.20, gems: 15 }];

    const winnersSummary = [];
    for (let i = 0; i < Math.min(payouts.length, parts.length); i++) {
      const pl = parts[i];
      const coinPrize = Math.round(totalPool * payouts[i].pct);
      const gemPrize = payouts[i].gems;
      await adminModifyPlayerResource(pl.id, 'coins', 'add', coinPrize);
      await adminModifyPlayerResource(pl.id, 'gems', 'add', gemPrize);
      winnersSummary.push({ place: i + 1, id: pl.id, name: pl.name, coins: coinPrize, gems: gemPrize });
    }
    await updateTourBoth(tour.id, { status: 'finished', winners: winnersSummary, finishedAt: Date.now() });
    toast('🏆 Призовой фонд и алмазики автоматически выплачены победителям!');
  }

  // ==================== 2. ОФИЦИАЛЬНЫЕ ТУРНИРЫ «БЕРЁЗОВЫЙ ХОЛДЕМ» ====================
  function renderTournamentTab(body) {
    document.getElementById('bgTitle').textContent = '🃏 Официальный Турнир «Берёзовый Холдем»';
    body.innerHTML = `<div id="bgTourMain">Загрузка данных турнира из Firebase...</div>`;

    _viewUnsubs.push(onValue('active_tournament', tour => {
      const box = body.querySelector('#bgTourMain');
      if (!box) return;
      if (!tour || !tour.id) {
        box.innerHTML = `
          <div class="bg-sec">
            <h3>🃏 Официальный турнир скоро начнётся</h3>
            <p class="bg-muted">Официальные турниры с фондом из Общего банка запускаются Основателем (ID 594228143). А пока вы можете 24/7 играть за товарищескими столами или бросить вызов 1v1!</p>
            <div class="bg-row">
              <button class="bg-btn" id="goFriendlyBtn">🪵 Товарищеские столы</button>
              <button class="bg-btn ghost" id="goDuelsBtn">⚔️ Вызвать игрока 1v1</button>
            </div>
          </div>
        `;
        box.querySelector('#goFriendlyBtn').onclick = () => { _activeTab = 'friendly'; renderActiveView(); };
        box.querySelector('#goDuelsBtn').onclick = () => { _activeTab = 'duels'; renderActiveView(); };
        return;
      }

      const me = getMe();
      const parts = tour.participants || {};
      const myPart = parts[me.id];
      const pList = Object.values(parts).sort((a, b) => (Number(b.sticks) || 0) - (Number(a.sticks) || 0));
      const lvl = Number(tour.blindLevel) || 1;
      const bl = BLIND_LEVELS[Math.min(BLIND_LEVELS.length - 1, lvl - 1)];
      const totalPool = Number(tour.total_prize_pool || tour.prizePool) || 0;
      const payoutDesc = pList.length >= 6
        ? '🥇 50% + 50💎 &nbsp;|&nbsp; 🥈 30% + 30💎 &nbsp;|&nbsp; 🥉 20% + 15💎'
        : '🥇 65% + 50💎 &nbsp;|&nbsp; 🥈 35% + 30💎';

      box.innerHTML = `
        <div class="bg-sec">
          <div class="bg-row sp">
            <h3>🏆 ${esc(tour.title)}</h3>
            <span class="bg-chip gold">Статус: ${esc(tour.status || 'open')}</span>
          </div>
          <div class="bg-bank">💰 Призовой фонд: ${fmt(totalPool)} 🪙</div>
          <small class="bg-muted">Спонсорский пул + 80% всех покупок палочек • 20% взносов идут в Баунти (+20 000 🪙 за каждую расколотую чурку!)</small>
          <div class="bg-row sp" style="margin-top:8px">
            <span class="bg-chip">Блайнды Ур.${lvl}: ${fmt(bl.sb)}/${fmt(bl.bb)} 🪵</span>
            <span class="bg-chip green">Участников: ${pList.length}</span>
          </div>
          <div style="margin-top:6px;font-size:12px;color:#ffd9a0">Выплаты финала: ${payoutDesc}</div>
          ${Array.isArray(tour.winners) && tour.winners.length ? `
            <div class="bg-result">
              <h3>🎉 Итоги финального стола</h3>
              ${tour.winners.map(w => `<div>#${w.place} <b>${esc(w.name)}</b> — +${fmt(w.coins)} 🪙 и +${w.gems} 💎</div>`).join('')}
            </div>
          ` : ''}
        </div>

        <div class="bg-sec">
          <h3>🪵 Покупка Берёзовых палочек за Коины</h3>
          <p class="bg-muted">Ваш баланс: <b>${fmt(getCoins())} 🪙</b> • Ваш стек в турнире: <b>${fmt(myPart ? myPart.sticks : 0)} 🪵</b> • 🪓 Наколотые чурки: <b>${fmt(getChoppedLogs())}</b></p>
          <div style="display:grid;gap:7px;margin-top:8px">
            ${Object.entries(TOUR_PACKS).map(([pk, info]) => {
              const earlyOk = pk === 'entry' && lvl < 2;
              return `<button class="bg-btn wood" data-pack="${pk}" style="text-align:left;display:flex;justify-content:space-between;align-items:center">
                <span>${info.label} ${earlyOk ? '<b style="color:#6dffb0">(+10k АКТИВЕН!)</b>' : ''}</span>
                <span>${stickSvg(true)}</span>
              </button>`;
            }).join('')}
          </div>
          <div class="bg-row" style="margin-top:12px">
            <button class="bg-btn green" id="enterTourTableBtn" style="width:100%;padding:12px">🔥 ЗАНЯТЬ МЕСТО ЗА БЕРЁЗОВЫМ СТОЛОМ!</button>
          </div>
        </div>

        <div class="bg-sec">
          <h3>🪓 Рейтинг «Наколотые чурки» и стеки турнира</h3>
          ${pList.map((p, idx) => `
            <div class="bg-item">
              <div class="bg-ava-s">${idx + 1}</div>
              <div class="grow">
                <b>${esc(p.name)}</b>
                <small>🪓 Наколото чурок: ${p.bounties || 0} • Взнос: ${fmt(p.spentCoins || 0)} 🪙</small>
              </div>
              <span class="bg-chip gold">${stickSvg(false)} ${fmt(p.sticks || 0)}</span>
            </div>
          `).join('') || '<div class="bg-muted">Станьте первым участником за столом!</div>'}
        </div>
      `;

      box.querySelectorAll('[data-pack]').forEach(btn => {
        btn.onclick = () => buyTournamentSticks(tour, btn.getAttribute('data-pack'));
      });
      box.querySelector('#enterTourTableBtn').onclick = async () => {
        if (!myPart || (Number(myPart.sticks) || 0) <= 0) {
          const ok = await buyTournamentSticks(tour, 'entry');
          if (!ok) return;
        }
        _subView = { type: 'poker', id: tour.id, isTournament: true };
        renderActiveView();
      };
    }, 2000));
  }

  async function buyTournamentSticks(tour, packKey) {
    const pack = TOUR_PACKS[packKey];
    if (!pack) return false;
    if (tour.status === 'finished' || tour.status === 'cancelled') {
      toast('⚠️ Турнир уже завершён');
      return false;
    }
    const me = getMe();
    const myCoins = getCoins();
    if (myCoins < pack.cost) {
      toast(`❌ Нужно ${fmt(pack.cost)} 🪙! У вас: ${fmt(myCoins)} 🪙`);
      return false;
    }

    const lvl = Number(tour.blindLevel) || 1;
    const bonus = (packKey === 'entry' && lvl < 2) ? pack.earlyBonus : 0;
    const gainedSticks = pack.sticks + bonus;
    const poolCut80 = Math.round(pack.cost * 0.80);
    const bountyCut20 = Math.round(pack.cost * 0.20);

    // Списываем коины и начисляем палочки
    const newCoins = myCoins - pack.cost;
    const newSticks = getSticks() + gainedSticks;
    updateLocalWallet({ coins: newCoins, sticks: newSticks });
    await fbPatch(`players/${encodeURIComponent(me.id)}`, {
      coins: newCoins, taps: newCoins, count: newCoins, sticks: newSticks, ts: Date.now()
    });

    const curPart = (tour.participants && tour.participants[me.id]) || {
      id: me.id, name: me.name, photo: me.photo, sticks: 0, spentCoins: 0, bounties: 0
    };
    const updatedPart = {
      id: me.id,
      name: me.name,
      photo: me.photo,
      sticks: (Number(curPart.sticks) || 0) + gainedSticks,
      spentCoins: (Number(curPart.spentCoins) || 0) + pack.cost,
      bounties: Number(curPart.bounties) || 0
    };

    const nextBuyInsPool = (Number(tour.buyInsPool) || 0) + poolCut80;
    const sponsorPool = Number(tour.sponsorPool !== undefined ? tour.sponsorPool : tour.prizePool) || 0;
    const nextTotalPrizePool = sponsorPool + nextBuyInsPool;
    const nextBountyPool = (Number(tour.bountyPool) || 0) + bountyCut20;

    const patch = {
      sponsorPool,
      buyInsPool: nextBuyInsPool,
      total_prize_pool: nextTotalPrizePool,
      prizePool: nextTotalPrizePool,
      bountyPool: nextBountyPool
    };
    await updateTourBoth(tour.id, patch);
    await fbPut(`poker_tournaments/${tour.id}/participants/${encodeURIComponent(me.id)}`, updatedPart);
    await fbPut(`active_tournament/participants/${encodeURIComponent(me.id)}`, updatedPart);

    await seatPlayerAtPokerTable(tour.id, tour.title, true, gainedSticks, lvl);
    toast(`🪵 +${fmt(gainedSticks)} Берёзовых палочек! (80% в призовой пул, 20% в Баунти)`);
    return true;
  }

  // ==================== 3. ДУЭЛИ 1v1 НА КОИНЫ (ПОКЕР И ШАХМАТЫ), ИНВАЙТЫ И МИНИ-ЧАТ ====================
  let _duelTargetId = '';
  let _duelGame = 'chess';
  let _duelBet = 10000;
  let _chessTimeMode = '5m'; // '5m' | '10m' | 'none'

  const QUICK_CHAT_PHRASES = [
    '👋 Привет!',
    '😎 Хороший ход',
    '⏳ Ходи давай!',
    '🔥 Ва-банк!',
    '😂 Ха-ха',
    '🤝 GG!'
  ];

  function showFloatingChatBubble(senderName, text) {
    const old = document.getElementById('bgChatFloatingBubble');
    if (old) old.remove();
    const b = document.createElement('div');
    b.id = 'bgChatFloatingBubble';
    b.className = 'bg-chat-bubble-toast';
    b.innerHTML = `💬 <b>${esc(senderName)}:</b> ${esc(text)}`;
    document.body.appendChild(b);
    b.animate([
      { opacity: 0, transform: 'translate(-50%, -10px) scale(0.9)' },
      { opacity: 1, transform: 'translate(-50%, 0) scale(1)', offset: 0.15 },
      { opacity: 1, transform: 'translate(-50%, 0) scale(1)', offset: 0.82 },
      { opacity: 0, transform: 'translate(-50%, -12px) scale(0.95)' }
    ], { duration: 3100, easing: 'ease-out' }).onfinish = () => b.remove();
  }

  function createMiniChatController(hostEl, toggleBtnSelector, drawerSelector, fbObjectPath) {
    const me = getMe();
    let chatOpen = false;
    let unreadCount = 0;
    let lastMsgTs = 0;
    let initialized = false;
    let currentMessages = [];

    const renderDrawer = () => {
      const toggleBtn = hostEl.querySelector(toggleBtnSelector);
      const drawer = hostEl.querySelector(drawerSelector);
      if (toggleBtn) {
        toggleBtn.innerHTML = `💬 Чат${unreadCount > 0 && !chatOpen ? `<span class="bg-chat-badge">${unreadCount}</span>` : ''}`;
      }
      if (!drawer) return;
      drawer.hidden = !chatOpen;
      if (!chatOpen) return;

      if (!drawer.getAttribute('data-chat-built')) {
        drawer.setAttribute('data-chat-built', '1');
        drawer.innerHTML = `
          <div class="bg-chat-drawer">
            <div class="bg-chat-feed" data-chat-feed="1"></div>
            <div class="bg-chat-quick">
              ${QUICK_CHAT_PHRASES.map(ph => `<button type="button" class="bg-chat-qbtn" data-qphrase="${esc(ph)}">${esc(ph)}</button>`).join('')}
            </div>
            <div class="bg-row" style="gap:6px">
              <input type="text" class="bg-input" data-chat-inp="1" maxlength="80" placeholder="Сообщение сопернику (до 80 симв.)..." style="flex:1">
              <button type="button" class="bg-btn sm green" data-chat-send="1">➤</button>
            </div>
          </div>
        `;
        drawer.querySelectorAll('[data-qphrase]').forEach(qb => {
          qb.onclick = () => sendChatMessage(qb.getAttribute('data-qphrase'));
        });
        const inp = drawer.querySelector('[data-chat-inp]');
        const sBtn = drawer.querySelector('[data-chat-send]');
        const submitInp = () => {
          if (!inp) return;
          const val = inp.value.trim().slice(0, 80);
          if (!val) return;
          inp.value = '';
          sendChatMessage(val);
        };
        if (sBtn) sBtn.onclick = submitInp;
        if (inp) {
          inp.addEventListener('keydown', (ev) => {
            if (ev.key === 'Enter') { ev.preventDefault(); submitInp(); }
          });
        }
      }

      const feed = drawer.querySelector('[data-chat-feed]');
      if (feed) {
        if (!currentMessages.length) {
          feed.innerHTML = `<div class="bg-muted" style="font-size:11px">Сообщений пока нет — нажмите быструю фразу ниже!</div>`;
        } else {
          feed.innerHTML = currentMessages.map(m => {
            const tStr = m.ts ? new Date(Number(m.ts)).toTimeString().slice(0, 5) : '';
            return `<div class="bg-chat-msg"><small class="bg-muted">[${esc(tStr)}]</small> <b>${esc(m.name || 'Игрок')}:</b> ${esc(m.text || '')}</div>`;
          }).join('');
          feed.scrollTop = feed.scrollHeight;
        }
      }
    };

    const sendChatMessage = async (rawText) => {
      const text = String(rawText || '').trim().slice(0, 80);
      if (!text) return;
      const now = Date.now();
      const entry = {
        id: `msg_${now}_${Math.random().toString(36).slice(2, 6)}`,
        uid: me.id,
        name: me.name,
        text,
        ts: now
      };
      pushTelemetryAction(`chat_send:${text.slice(0, 24)}`);
      const nextChat = [...currentMessages, entry].slice(-15);
      currentMessages = nextChat;
      lastMsgTs = now;
      renderDrawer();
      await fbPatch(fbObjectPath, { chat: nextChat });
    };

    const bindToggle = () => {
      const toggleBtn = hostEl.querySelector(toggleBtnSelector);
      if (toggleBtn && !toggleBtn._chatBound) {
        toggleBtn._chatBound = true;
        toggleBtn.onclick = () => {
          chatOpen = !chatOpen;
          if (chatOpen) unreadCount = 0;
          renderDrawer();
        };
      }
    };

    const onSyncChat = (rawChat) => {
      bindToggle();
      const arr = toArr(rawChat).filter(m => m && m.text).slice(-15);
      const newest = arr.length ? arr[arr.length - 1] : null;
      const newestTs = newest ? Number(newest.ts) || 0 : 0;
      if (!initialized) {
        initialized = true;
        lastMsgTs = newestTs;
      } else if (newest && newestTs > lastMsgTs) {
        lastMsgTs = newestTs;
        if (String(newest.uid) !== String(me.id)) {
          if (!chatOpen) unreadCount += 1;
          showFloatingChatBubble(newest.name || 'Соперник', newest.text);
        }
      }
      currentMessages = arr;
      renderDrawer();
    };

    return { onSyncChat, bindToggle, renderDrawer };
  }

  function shareDuelInviteToTelegram(duelId, game = 'poker', bet = 10000) {
    const cleanId = String(duelId || '').trim();
    if (!cleanId) return;
    const gameLabel = game === 'chess' ? '♟ Берёзовые Шахматы' : '🃏 Берёзовый Покер 1v1';
    const inviteUrl = `https://t.me/oreo_67_bot/play?startapp=${encodeURIComponent(cleanId)}`;
    const shareText = `⚔️ Вызываю тебя на дуэль 1v1 в ${gameLabel} в ОРЕО67! Ставка: ${fmt(bet)} 🪙 (Банк: ${fmt((Number(bet) || 0) * 2)} 🪙). Жми и принимай вызов!`;
    const tgShareLink = `https://t.me/share/url?url=${encodeURIComponent(inviteUrl)}&text=${encodeURIComponent(shareText)}`;
    pushTelemetryAction(`duel_invite_tg:${cleanId}`);

    try {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(`${shareText} ${inviteUrl}`).catch(() => {});
      }
    } catch (e) {}

    const tgWebApp = window.Telegram && window.Telegram.WebApp;
    if (tgWebApp && typeof tgWebApp.openTelegramLink === 'function') {
      try {
        tgWebApp.openTelegramLink(tgShareLink);
        toast('📲 Ссылка на дуэль скопирована и открыта отправка в Telegram!');
        return;
      } catch (e) {}
    }
    window.open(tgShareLink, '_blank');
    toast('📲 Ссылка-приглашение скопирована! Отправьте её другу в Telegram.');
  }

  function renderDuelsTab(body) {
    document.getElementById('bgTitle').textContent = '⚔️ Вызвать игрока 1v1 (Покер / Шахматы)';
    const me = getMe();
    body.innerHTML = `
      <div class="bg-sec">
        <h3>⚔️ Создать вызов или открытый стол 1v1</h3>
        <div class="bg-row" style="margin-bottom:8px">
          <button class="bg-btn ${ _duelGame === 'poker' ? '' : 'ghost' }" id="duelPickPoker">🃏 Берёзовый Покер 1v1</button>
          <button class="bg-btn ${ _duelGame === 'chess' ? '' : 'ghost' }" id="duelPickChess">♟ Берёзовые Шахматы</button>
        </div>
        ${_duelGame === 'chess' ? `
          <div class="bg-row" style="margin-bottom:8px">
            <button class="bg-btn sm ${_chessTimeMode === '5m' ? 'green' : 'ghost'}" data-chess-time="5m">⏱ 5 мин</button>
            <button class="bg-btn sm ${_chessTimeMode === '10m' ? 'green' : 'ghost'}" data-chess-time="10m">⏱ 10 мин</button>
            <button class="bg-btn sm ${_chessTimeMode === 'none' ? 'green' : 'ghost'}" data-chess-time="none">♾️ Без таймера</button>
          </div>
        ` : ''}
        <div class="bg-row" style="margin-bottom:8px">
          ${[10000, 50000, 100000, 500000].map(b => `
            <button class="bg-btn sm ${ _duelBet === b ? '' : 'ghost' }" data-bet="${b}">${fmt(b)} 🪙</button>
          `).join('')}
        </div>
        <input class="bg-input" id="duelCustomBet" type="number" value="${_duelBet}" placeholder="Своя ставка в коинах">
        <div style="margin-top:8px" class="bg-muted">
          Соперник: <b id="duelTargetLabel">${_duelTargetId ? esc(_duelTargetId) : '🌐 Открытый стол в лобби (любой игрок)'}</b>
        </div>
        <div class="bg-row" style="margin-top:10px">
          <button class="bg-btn green" id="duelCreateBtn" style="flex:1">🔥 Бросить вызов (Эскроу ${fmt(_duelBet)} 🪙)</button>
          <button class="bg-btn wood" id="duelBotTestBtn">🤖 Бой с Берёзовым Ботом</button>
        </div>
      </div>

      <div class="bg-sec">
        <h3>🔥 Активные вызовы и партии 1v1</h3>
        <div id="duelActiveList">Загрузка вызовов...</div>
      </div>

      <div class="bg-sec">
        <h3>👥 Выберите конкретного соперника (для пуш-вызова в Telegram)</h3>
        <div id="duelPlayersList">Загрузка игроков...</div>
      </div>
    `;

    body.querySelector('#duelPickPoker').onclick = () => { _duelGame = 'poker'; renderDuelsTab(body); };
    body.querySelector('#duelPickChess').onclick = () => { _duelGame = 'chess'; renderDuelsTab(body); };
    body.querySelectorAll('[data-chess-time]').forEach(tb => {
      tb.onclick = () => { _chessTimeMode = tb.getAttribute('data-chess-time') || '5m'; renderDuelsTab(body); };
    });
    body.querySelectorAll('[data-bet]').forEach(b => {
      b.onclick = () => { _duelBet = Number(b.getAttribute('data-bet')); renderDuelsTab(body); };
    });
    const betInp = body.querySelector('#duelCustomBet');
    betInp.oninput = () => { _duelBet = Math.max(100, Number(betInp.value) || 10000); };

    body.querySelector('#duelCreateBtn').onclick = () => createEscrowDuelChallenge(_duelTargetId, _duelGame, _duelBet, false);
    body.querySelector('#duelBotTestBtn').onclick = () => createEscrowDuelChallenge('birch_ai_bot', _duelGame, _duelBet, true);

    _viewUnsubs.push(onValue('duel_challenges', data => {
      const box = body.querySelector('#duelActiveList');
      if (!box) return;
      const list = Object.values(data || {}).filter(c => c && (c.status === 'pending' || c.status === 'active'));
      list.sort((a, b) => (Number(b.createdAt) || 0) - (Number(a.createdAt) || 0));
      if (!list.length) {
        box.innerHTML = `<div class="bg-muted">Нет открытых вызовов. Создайте первый стол выше!</div>`;
        return;
      }
      box.innerHTML = list.slice(0, 15).map(ch => {
        const isMine = String(ch.challengerId) === me.id;
        const canAccept = !isMine && (!ch.opponentId || String(ch.opponentId) === me.id) && ch.status === 'pending';
        const isParticipant = isMine || String(ch.opponentId) === me.id;
        const gTitle = ch.game === 'chess' ? '♟ Шахматы' : '🃏 Покер 1v1';
        const chBadges = shushikInlineBadgesHtml(ch.challengerId, ch.challengerSkin);
        const oppBadges = ch.opponentId ? shushikInlineBadgesHtml(ch.opponentId, ch.opponentSkin) : '';
        return `
          <div class="bg-item">
            <div class="grow">
              <b>${gTitle} • ${esc(ch.challengerName)}${chBadges} ${ch.opponentName ? `vs ${esc(ch.opponentName)}${oppBadges}` : '(Открытый стол)'}</b>
              <small>Ставка: <b>${fmt(ch.bet)} 🪙</b> (Банк: ${fmt((ch.bet || 0) * 2)} 🪙) • Статус: ${esc(ch.status)}</small>
            </div>
            <div class="bg-row">
              ${canAccept ? `<button class="bg-btn sm green" data-acc="${esc(ch.id)}">✅ Принять</button>` : ''}
              ${canAccept && String(ch.opponentId) === me.id ? `<button class="bg-btn sm red" data-dec="${esc(ch.id)}">❌</button>` : ''}
              ${isMine && ch.status === 'pending' ? `<button class="bg-btn sm wood" data-inv="${esc(ch.id)}:${esc(ch.game)}:${Number(ch.bet) || 10000}">📲 Инвайт</button>` : ''}
              ${isMine && ch.status === 'pending' ? `<button class="bg-btn sm red" data-can="${esc(ch.id)}">Отмена</button>` : ''}
              ${isParticipant && (ch.status === 'active' || ch.status === 'pending') ? `<button class="bg-btn sm" data-open="${esc(ch.id)}:${esc(ch.game)}">Войти</button>` : ''}
            </div>
          </div>
        `;
      }).join('');

      box.querySelectorAll('[data-acc]').forEach(b => { b.onclick = () => acceptEscrowDuelChallenge(b.getAttribute('data-acc')); });
      box.querySelectorAll('[data-dec]').forEach(b => { b.onclick = () => cancelOrDeclineEscrowDuel(b.getAttribute('data-dec'), false); });
      box.querySelectorAll('[data-can]').forEach(b => { b.onclick = () => cancelOrDeclineEscrowDuel(b.getAttribute('data-can'), true); });
      box.querySelectorAll('[data-inv]').forEach(b => {
        b.onclick = () => {
          const [cid, gm, bt] = b.getAttribute('data-inv').split(':');
          shareDuelInviteToTelegram(cid, gm, Number(bt) || 10000);
        };
      });
      box.querySelectorAll('[data-open]').forEach(b => {
        b.onclick = () => {
          const [cid, g] = b.getAttribute('data-open').split(':');
          _subView = { type: g === 'chess' ? 'chess' : 'poker', id: cid, isTournament: false };
          renderActiveView();
        };
      });
    }, 1800));

    _viewUnsubs.push(onValue('players', data => {
      const box = body.querySelector('#duelPlayersList');
      if (!box) return;
      const arr = Object.values(data || {}).filter(p => p && p.id && String(p.id) !== me.id);
      arr.sort((a, b) => (Number(b.coins) || 0) - (Number(a.coins) || 0));
      box.innerHTML = `
        <div class="bg-item ${!_duelTargetId ? 'sel' : ''}" data-opp="">
          <div class="grow"><b>🌐 Открытый вызов в лобби</b><small>Принять сможет любой игрок</small></div>
        </div>
        ${arr.slice(0, 20).map(p => `
          <div class="bg-item ${String(_duelTargetId) === String(p.id) ? 'sel' : ''}" data-opp="${esc(p.id)}" data-oppname="${esc(p.name)}">
            <div class="grow">
              <b>👤 ${esc(p.name)} ${p.username ? `@${esc(p.username)}` : ''}${shushikInlineBadgesHtml(p.id, p.skin || p.equippedSkin)}</b>
              <small>Капитал: ${fmt(p.coins || 0)} 🪙</small>
            </div>
            <span class="bg-chip">Выбрать</span>
          </div>
        `).join('')}
      `;
      box.querySelectorAll('[data-opp]').forEach(el => {
        el.onclick = () => {
          _duelTargetId = el.getAttribute('data-opp') || '';
          renderDuelsTab(body);
        };
      });
    }, 3500));
  }

  // Эскроу создание и принятие вызова через runTransaction
  async function createEscrowDuelChallenge(targetId, game, bet, vsBot = false) {
    const me = getMe();
    const mySkin = getLocalState().equippedSkin || 'classic';
    bet = Math.max(100, Math.round(Number(bet) || 10000));
    if (getCoins() < bet) {
      toast(`❌ Недостаточно коинов для ставки ${fmt(bet)} 🪙!`);
      return;
    }

    const newCoins = getCoins() - bet;
    updateLocalWallet({ coins: newCoins });
    await syncMyWalletToFirebase({ coins: newCoins, skin: mySkin, equippedSkin: mySkin });

    let oppName = '';
    let oppUname = '';
    let oppSkin = '';
    if (vsBot) {
      oppName = '🤖 Берёзовый Леший';
    } else if (targetId) {
      const opp = await fbGet(`players/${encodeURIComponent(targetId)}`);
      if (opp) { oppName = opp.name || ''; oppUname = opp.username || ''; oppSkin = opp.skin || opp.equippedSkin || ''; }
    }

    const cid = `duel_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
    const now = Date.now();
    const chObj = {
      id: cid,
      challengerId: me.id,
      challengerName: me.name,
      challengerUsername: me.username,
      challengerSkin: mySkin,
      opponentId: vsBot ? 'birch_ai_bot' : (targetId || ''),
      opponentName: oppName,
      opponentUsername: oppUname,
      opponentSkin: oppSkin,
      game,
      gameTitle: game === 'chess' ? '♟ Берёзовые Шахматы' : '🃏 Берёзовый Покер 1v1',
      timeMode: _chessTimeMode || '5m',
      bet,
      pot: vsBot ? bet * 2 : bet,
      escrowFrozen: true,
      status: vsBot ? 'active' : 'pending',
      notified: vsBot ? true : !targetId, // если выбран конкретный соперник, bot.py отправит пуш в ЛС!
      createdAt: now
    };

    await runTransaction(`duel_challenges/${cid}`, () => chObj);

    if (game === 'chess') {
      await initChessMatchInFirebase(cid, chObj, vsBot);
    } else {
      await createOrResetPokerTable(cid, `Дуэль 1v1 (${fmt(bet * 2)} 🪙)`, false, bet * 2);
      await seatPlayerAtPokerTable(cid, 'Дуэль 1v1', false, bet, 1);
      if (vsBot) {
        await seatBotAtPokerTable(cid, bet);
        await startTableNewHand(cid);
      }
    }

    toast(targetId && !vsBot ? '⚔️ Вызов отправлен в Telegram сопернику! Ставка в Эскроу.' : '⚔️ Стол дуэли создан!');
    pushTelemetryAction(`duel_create:${game}(bet=${bet},bot=${vsBot ? 1 : 0})`);
    _subView = { type: game === 'chess' ? 'chess' : 'poker', id: cid, isTournament: false };
    renderActiveView();
  }

  async function acceptEscrowDuelChallenge(cid) {
    const me = getMe();
    const mySkin = getLocalState().equippedSkin || 'classic';
    const ch = await fbGet(`duel_challenges/${encodeURIComponent(cid)}`);
    if (!ch || ch.status !== 'pending') return toast('⚠️ Вызов уже недоступен');
    const bet = Math.max(0, Number(ch.bet) || 0);
    if (String(ch.challengerId) !== me.id) {
      if (getCoins() < bet) return toast(`❌ Для принятия вызова нужно ${fmt(bet)} 🪙!`);
    }

    const tx = await runTransaction(`duel_challenges/${encodeURIComponent(cid)}`, cur => {
      if (!cur || cur.status !== 'pending') return;
      cur.opponentId = me.id;
      cur.opponentName = me.name;
      cur.opponentUsername = me.username;
      cur.opponentSkin = mySkin;
      cur.pot = bet * 2;
      cur.status = 'active';
      cur.acceptedAt = Date.now();
      return cur;
    });
    if (!tx.committed) return toast('⚠️ Не удалось принять вызов');
    pushTelemetryAction(`duel_accept:${cid}(${ch.game})`);

    if (String(ch.challengerId) !== me.id) {
      const nextC = getCoins() - bet;
      updateLocalWallet({ coins: nextC });
      await syncMyWalletToFirebase({ coins: nextC, skin: mySkin, equippedSkin: mySkin });
    }

    if (ch.game === 'chess') {
      await fbPatch(`duel_matches/${encodeURIComponent(cid)}`, {
        blackId: me.id, blackName: me.name, blackSkin: mySkin, pot: bet * 2, status: 'active', lastMoveTs: Date.now()
      });
      _subView = { type: 'chess', id: cid, isTournament: false };
    } else {
      await seatPlayerAtPokerTable(cid, 'Дуэль 1v1', false, bet, 1);
      await startTableNewHand(cid);
      _subView = { type: 'poker', id: cid, isTournament: false };
    }
    renderActiveView();
  }

  async function cancelOrDeclineEscrowDuel(cid, isCancel) {
    const tx = await runTransaction(`duel_challenges/${encodeURIComponent(cid)}`, cur => {
      if (!cur || cur.status !== 'pending') return;
      cur.status = isCancel ? 'cancelled' : 'declined';
      cur.escrowFrozen = false;
      cur.resolvedAt = Date.now();
      return cur;
    });
    if (!tx.committed || !tx.snapshot) return;
    const ch = tx.snapshot;
    const bet = Math.max(0, Number(ch.bet) || 0);
    if (bet > 0 && ch.challengerId) {
      await adminModifyPlayerResource(ch.challengerId, 'coins', 'add', bet);
    }
    if (ch.game === 'poker') {
      await fbDelete(`poker_tables/${encodeURIComponent(cid)}`);
    } else if (ch.game === 'chess') {
      await fbDelete(`duel_matches/${encodeURIComponent(cid)}`);
    }
    toast(isCancel ? '✅ Вызов отменён, ставка возвращена' : '❌ Вызов отклонён, ставка возвращена игроку');
  }

  async function settleDuelPot(cid, winnerId, isDraw = false) {
    const tx = await runTransaction(`duel_challenges/${encodeURIComponent(cid)}`, cur => {
      if (!cur || cur.settled) return;
      cur.settled = true;
      cur.status = 'finished';
      cur.winnerId = isDraw ? 'draw' : String(winnerId || '');
      cur.finishedAt = Date.now();
      return cur;
    });
    if (!tx.committed || !tx.snapshot) return;
    const ch = tx.snapshot;
    const bet = Math.max(0, Number(ch.bet) || 0);
    const pot = Math.max(bet * 2, Number(ch.pot) || 0);
    const bonusSticks = Math.max(500, Math.round(pot * 0.05));
    if (isDraw) {
      if (ch.challengerId) await adminModifyPlayerResource(ch.challengerId, 'coins', 'add', bet);
      if (ch.opponentId && ch.opponentId !== 'birch_ai_bot') await adminModifyPlayerResource(ch.opponentId, 'coins', 'add', bet);
      toast(`🤝 Ничья! Ставки по ${fmt(bet)} 🪙 возвращены обоим игрокам.`);
    } else if (winnerId && winnerId !== 'birch_ai_bot') {
      await adminModifyPlayerResource(winnerId, 'coins', 'add', pot);
      await adminModifyPlayerResource(winnerId, 'sticks', 'add', bonusSticks);
      if (String(winnerId) === getMe().id) {
        await syncMyWalletToFirebase();
        toast(`🏆 ПОБЕДА! Вы забрали банк дуэли +${fmt(pot)} 🪙 и +${fmt(bonusSticks)} 🪵!`);
      }
    }
  }

  // ==================== 4. ДВИЖОК «БЕРЁЗОВЫЕ ШАХМАТЫ» (CHESS.JS + STAUNTON SVG + FIREBASE) ====================
  function chessPieceSvg(color, type) {
    const isW = color === 'w';
    const fill = isW ? '#fbf6ea' : '#1c1714';
    const stroke = isW ? '#1f130a' : '#0a0705';
    const detail = isW ? '#2c1b10' : '#e6d2b0';
    let body = '';
    if (type === 'p') {
      body = `
        <circle cx="22.5" cy="13.5" r="5.5" fill="${fill}" stroke="${stroke}" stroke-width="2"/>
        <path d="M16.5 21.5c1.5-2.2 10.5-2.2 12 0 1 1.6-.6 3.2-1.8 4 1.6 3.5 3.8 6.8 4.8 9.5H13.5c1-2.7 3.2-6 4.8-9.5-1.2-.8-2.8-2.4-1.8-4z" fill="${fill}" stroke="${stroke}" stroke-width="2" stroke-linejoin="round"/>
        <rect x="11.5" y="35" width="22" height="4.2" rx="1.8" fill="${fill}" stroke="${stroke}" stroke-width="2"/>
        <line x1="15" y1="35" x2="30" y2="35" stroke="${detail}" stroke-width="1.3"/>`;
    } else if (type === 'r') {
      body = `
        <path d="M12.5 10.5h4v3.5h4v-3.5h4v3.5h4v-3.5h4V17l-2.5 2.5v13l2.5 2.5H12.5l2.5-2.5v-13L12.5 17z" fill="${fill}" stroke="${stroke}" stroke-width="2" stroke-linejoin="round"/>
        <rect x="11" y="35" width="23" height="4.2" rx="1.6" fill="${fill}" stroke="${stroke}" stroke-width="2"/>
        <line x1="15" y1="19.5" x2="30" y2="19.5" stroke="${detail}" stroke-width="1.4"/>
        <line x1="15" y1="32.5" x2="30" y2="32.5" stroke="${detail}" stroke-width="1.4"/>`;
    } else if (type === 'n') {
      body = `
        <path d="M15 35c.5-7 4.2-10.2 6.5-12.2-2.2.4-4.8 1.5-6.8 1.2-1.6-.2-2.5-1.6-1.7-3.2 1.2-2.4 4.5-6.6 7.5-8.5.4-1.8 1.6-3.3 3.2-3.8.5 1.4.8 2.5.6 3.5 4.8 1.2 8.2 5.8 8.2 12.8 0 4.2-1.2 7.4-2.5 10.2H15z" fill="${fill}" stroke="${stroke}" stroke-width="2" stroke-linejoin="round"/>
        <circle cx="20.2" cy="16.8" r="1.4" fill="${detail}"/>
        <path d="M25.5 17.5c2 2.2 2.8 5.8 2.2 10.5" fill="none" stroke="${detail}" stroke-width="1.4" stroke-linecap="round"/>
        <rect x="11.5" y="35" width="22" height="4.2" rx="1.6" fill="${fill}" stroke="${stroke}" stroke-width="2"/>`;
    } else if (type === 'b') {
      body = `
        <circle cx="22.5" cy="9.2" r="2.6" fill="${fill}" stroke="${stroke}" stroke-width="1.8"/>
        <path d="M22.5 12c-5.5 3.6-7.8 9.2-6.2 14.5 1 3.2 2.2 5.5 2.2 8.5h8c0-3 1.2-5.3 2.2-8.5 1.6-5.3-.7-10.9-6.2-14.5z" fill="${fill}" stroke="${stroke}" stroke-width="2" stroke-linejoin="round"/>
        <path d="M19.5 18.5h6M22.5 15.5v6" stroke="${detail}" stroke-width="1.6" stroke-linecap="round"/>
        <path d="M13 35c3-2 16-2 19 0" fill="${fill}" stroke="${stroke}" stroke-width="2"/>
        <rect x="11.5" y="35" width="22" height="4.2" rx="1.6" fill="${fill}" stroke="${stroke}" stroke-width="2"/>`;
    } else if (type === 'q') {
      body = `
        <circle cx="10" cy="14" r="2.1" fill="${fill}" stroke="${stroke}" stroke-width="1.7"/>
        <circle cx="16" cy="10.8" r="2.1" fill="${fill}" stroke="${stroke}" stroke-width="1.7"/>
        <circle cx="22.5" cy="9.5" r="2.2" fill="${fill}" stroke="${stroke}" stroke-width="1.7"/>
        <circle cx="29" cy="10.8" r="2.1" fill="${fill}" stroke="${stroke}" stroke-width="1.7"/>
        <circle cx="35" cy="14" r="2.1" fill="${fill}" stroke="${stroke}" stroke-width="1.7"/>
        <path d="M11 16l4.2 11.5L17 13l5.5 13.5L28 13l1.8 14.5L34 16l-2.6 15.5H13.6z" fill="${fill}" stroke="${stroke}" stroke-width="2" stroke-linejoin="round"/>
        <path d="M13.5 31.5h18l1.2 3.5H12.3z" fill="${fill}" stroke="${stroke}" stroke-width="1.9" stroke-linejoin="round"/>
        <line x1="14.5" y1="31.5" x2="30.5" y2="31.5" stroke="${detail}" stroke-width="1.4"/>
        <rect x="11" y="35" width="23" height="4.2" rx="1.6" fill="${fill}" stroke="${stroke}" stroke-width="2"/>`;
    } else {
      body = `
        <path d="M22.5 6.5v6M19.5 9.2h6" stroke="${stroke}" stroke-width="2.3" stroke-linecap="round"/>
        <path d="M22.5 13c-3.8-3.8-10.5-2.6-10.5 3.6 0 4.5 2.5 9.2 3.2 14.9h14.6c.7-5.7 3.2-10.4 3.2-14.9 0-6.2-6.7-7.4-10.5-3.6z" fill="${fill}" stroke="${stroke}" stroke-width="2" stroke-linejoin="round"/>
        <path d="M22.5 14v16.5" stroke="${detail}" stroke-width="1.4"/>
        <path d="M15.2 31.5h14.6" stroke="${detail}" stroke-width="1.5"/>
        <rect x="11" y="35" width="23" height="4.2" rx="1.6" fill="${fill}" stroke="${stroke}" stroke-width="2"/>`;
    }
    return `<svg class="bg-piece-svg" viewBox="0 0 45 45" xmlns="http://www.w3.org/2000/svg">${body}</svg>`;
  }

  async function initChessMatchInFirebase(cid, chObj, vsBot = false) {
    const tMode = chObj.timeMode || _chessTimeMode || '5m';
    const initMs = tMode === '10m' ? 10 * 60 * 1000 : (tMode === 'none' ? 0 : CHESS_INIT_MS);
    const match = {
      id: cid,
      whiteId: chObj.challengerId,
      whiteName: chObj.challengerName,
      whiteSkin: chObj.challengerSkin || '',
      blackId: vsBot ? 'birch_ai_bot' : (chObj.opponentId || ''),
      blackName: vsBot ? '🤖 Берёзовый Леший' : (chObj.opponentName || 'Ожидание соперника...'),
      blackSkin: vsBot ? '' : (chObj.opponentSkin || ''),
      vsBot: Boolean(vsBot),
      bet: chObj.bet,
      pot: chObj.bet * 2,
      fen: 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1',
      history: [],
      chat: [],
      turn: 'w',
      timeMode: tMode,
      noTimer: tMode === 'none',
      wTime: initMs,
      bTime: initMs,
      lastMoveTs: Date.now(),
      lastFrom: '',
      lastTo: '',
      status: vsBot ? 'active' : 'waiting',
      winner: '',
      reason: ''
    };
    await fbPut(`duel_matches/${encodeURIComponent(cid)}`, match);
  }

  async function leaveChessMatchIfNeeded(matchId) {
    if (!matchId) return;
    const me = getMe();
    const m = await fbGet(`duel_matches/${encodeURIComponent(matchId)}`);
    if (!m) return;
    if (m.status === 'waiting' && String(m.whiteId) === String(me.id)) {
      await cancelOrDeclineEscrowDuel(matchId, true);
    }
  }

  function fmtClock(ms, noTimer = false) {
    if (noTimer) return '♾️ Без таймера';
    const s = Math.max(0, Math.ceil((Number(ms) || 0) / 1000));
    const m = Math.floor(s / 60);
    const sec = s % 60;
    return `${m}:${String(sec).padStart(2, '0')}`;
  }

  function renderChessMatchView(body, matchId) {
    document.getElementById('bgTitle').textContent = '♟ Берёзовые Шахматы 1v1';
    const me = getMe();
    let selectedSq = '';
    let currentMatch = null;
    let lastBoardKey = '';
    let botThinking = false;

    body.innerHTML = `
      <div class="bg-chess-wrap">
        <div class="bg-chess-banner" id="chessTurnBanner">
          <span id="chessStatusTxt"><i class="bg-turn-dot"></i>Загрузка партии...</span>
          <span class="bg-chip gold" id="chessPotChip">Банк: 0 🪙</span>
        </div>
        <div class="bg-row sp" style="margin-bottom:6px;gap:5px;flex-wrap:wrap">
          <div class="bg-row" style="gap:4px">
            <button type="button" class="bg-btn sm ghost" data-ch-mode="5m">⏱ 5 мин</button>
            <button type="button" class="bg-btn sm ghost" data-ch-mode="10m">⏱ 10 мин</button>
            <button type="button" class="bg-btn sm ghost" data-ch-mode="none">♾️ Без таймера</button>
          </div>
          <button type="button" class="bg-btn sm wood" id="chessChatToggleBtn">💬 Чат</button>
        </div>
        <div id="chessChatDrawerWrap" hidden></div>
        <div class="bg-clock" id="chessTopClock">
          <div class="bg-clock-meta">
            <div class="bg-piece-badge b" id="chessTopBadge">♚</div>
            <div style="min-width:0">
              <div class="bg-clock-name" id="chessTopName">Соперник</div>
              <div class="bg-clock-sub" id="chessTopSub">Чёрные</div>
            </div>
          </div>
          <span class="t" id="chessTopTime">5:00</span>
        </div>
        <div class="bg-board-frame">
          <div class="bg-board8" id="chessBoard"></div>
        </div>
        <div class="bg-clock" id="chessBotClock">
          <div class="bg-clock-meta">
            <div class="bg-piece-badge w" id="chessBotBadge">♔</div>
            <div style="min-width:0">
              <div class="bg-clock-name" id="chessBotName">Вы</div>
              <div class="bg-clock-sub" id="chessBotSub">Белые</div>
            </div>
          </div>
          <span class="t" id="chessBotTime">5:00</span>
        </div>
        <div class="bg-chess-foot">
          <div class="bg-moves" id="chessMovesBox">Ходы партии: сделайте первый ход</div>
          <button class="bg-btn sm red" id="chessResignBtn">🏳️ Сдаться</button>
        </div>
        <div id="chessOutcomeBox"></div>
      </div>
    `;

    const boardEl = body.querySelector('#chessBoard');
    const chatCtrl = createMiniChatController(
      body,
      '#chessChatToggleBtn',
      '#chessChatDrawerWrap',
      `duel_matches/${encodeURIComponent(matchId)}`
    );

    body.querySelectorAll('[data-ch-mode]').forEach(btn => {
      btn.onclick = async () => {
        const nextMode = btn.getAttribute('data-ch-mode') || '5m';
        _chessTimeMode = nextMode;
        const noTimer = nextMode === 'none';
        const nextMs = nextMode === '10m' ? 10 * 60 * 1000 : (noTimer ? 0 : CHESS_INIT_MS);
        pushTelemetryAction(`chess_time_mode:${nextMode}`);
        if (currentMatch && currentMatch.status !== 'finished') {
          await fbPatch(`duel_matches/${encodeURIComponent(matchId)}`, {
            timeMode: nextMode,
            noTimer,
            wTime: nextMs,
            bTime: nextMs,
            lastMoveTs: Date.now()
          });
          toast(noTimer ? '♾️ Включён режим «Без таймера»!' : `⏱ Таймер установлен: ${nextMode === '10m' ? '10 минут' : '5 минут'}`);
        }
      };
    });

    function isNoTimerMatch(m) {
      return Boolean(m && (m.noTimer || m.timeMode === 'none'));
    }

    function getLiveClocks(m) {
      if (!m) return { w: CHESS_INIT_MS, b: CHESS_INIT_MS };
      if (isNoTimerMatch(m)) return { w: 0, b: 0 };
      if (m.status !== 'active') return { w: m.wTime, b: m.bTime };
      const elapsed = Math.max(0, Date.now() - (Number(m.lastMoveTs) || Date.now()));
      return {
        w: m.turn === 'w' ? Math.max(0, m.wTime - elapsed) : m.wTime,
        b: m.turn === 'b' ? Math.max(0, m.bTime - elapsed) : m.bTime
      };
    }

    function updateClocksDom(m) {
      if (!m) return;
      const noTimer = isNoTimerMatch(m);
      const curMode = noTimer ? 'none' : (m.timeMode || '5m');
      body.querySelectorAll('[data-ch-mode]').forEach(btn => {
        const bMode = btn.getAttribute('data-ch-mode');
        btn.classList.toggle('green', bMode === curMode);
        btn.classList.toggle('ghost', bMode !== curMode);
      });

      const amBlack = String(m.blackId) === me.id && String(m.whiteId) !== me.id;
      const topIsBlack = !amBlack;
      const clocks = getLiveClocks(m);
      const topMs = topIsBlack ? clocks.b : clocks.w;
      const botMs = topIsBlack ? clocks.w : clocks.b;

      const tEl = body.querySelector('#chessTopTime');
      const bEl = body.querySelector('#chessBotTime');
      const topClock = body.querySelector('#chessTopClock');
      const botClock = body.querySelector('#chessBotClock');
      if (tEl) tEl.textContent = fmtClock(topMs, noTimer);
      if (bEl) bEl.textContent = fmtClock(botMs, noTimer);
      if (topClock) {
        topClock.classList.toggle('active', m.status === 'active' && m.turn === (topIsBlack ? 'b' : 'w'));
        topClock.classList.toggle('low', !noTimer && m.status === 'active' && topMs <= 30000);
      }
      if (botClock) {
        botClock.classList.toggle('active', m.status === 'active' && m.turn === (topIsBlack ? 'w' : 'b'));
        botClock.classList.toggle('low', !noTimer && m.status === 'active' && botMs <= 30000);
      }
    }

    let lastLoggedChessStatus = '';

    function drawChess(m) {
      currentMatch = m;
      _liveChessState = m ? Object.assign({ matchId }, m) : null;
      if (!m || !window.Chess) return;
      chatCtrl.onSyncChat(m.chat);
      if (m.status && m.status !== lastLoggedChessStatus) {
        pushTelemetryAction(`chess_stage:${lastLoggedChessStatus || 'init'}->${m.status}`);
        lastLoggedChessStatus = m.status;
      }
      const chess = new window.Chess(m.fen);
      const amBlack = String(m.blackId) === me.id && String(m.whiteId) !== me.id;
      const myColor = amBlack ? 'b' : 'w';
      const topIsBlack = !amBlack;

      const topBadge = body.querySelector('#chessTopBadge');
      const botBadge = body.querySelector('#chessBotBadge');
      topBadge.className = `bg-piece-badge ${topIsBlack ? 'b' : 'w'}`;
      topBadge.textContent = topIsBlack ? '♚' : '♔';
      botBadge.className = `bg-piece-badge ${topIsBlack ? 'w' : 'b'}`;
      botBadge.textContent = topIsBlack ? '♔' : '♚';

      const topId = topIsBlack ? m.blackId : m.whiteId;
      const topSkin = topIsBlack ? m.blackSkin : m.whiteSkin;
      const botId = topIsBlack ? m.whiteId : m.blackId;
      const botSkin = topIsBlack ? m.whiteSkin : m.blackSkin;
      const topIsShushik = isPlayerShushikSkin(topId, topSkin);
      const botIsShushik = isPlayerShushikSkin(botId, botSkin);

      const topClockEl = body.querySelector('#chessTopClock');
      const botClockEl = body.querySelector('#chessBotClock');
      if (topClockEl) topClockEl.classList.toggle('shushik-vip', topIsShushik);
      if (botClockEl) botClockEl.classList.toggle('shushik-vip', botIsShushik);

      const topRawName = topIsBlack ? (m.blackName || 'Ожидание...') : (m.whiteName || 'Соперник');
      const botRawName = topIsBlack ? (m.whiteName || 'Вы') : (m.blackName || 'Вы');
      body.querySelector('#chessTopName').innerHTML = `${esc(topRawName)}${shushikInlineBadgesHtml(topId, topSkin)}`;
      body.querySelector('#chessTopSub').textContent = topIsBlack ? 'Чёрные фигуры' : 'Белые фигуры';
      body.querySelector('#chessBotName').innerHTML = `${esc(botRawName)}${shushikInlineBadgesHtml(botId, botSkin)}`;
      body.querySelector('#chessBotSub').innerHTML = `${topIsBlack ? 'Белые фигуры' : 'Чёрные фигуры'} • Ставка ${botIsShushik ? `<img class="bg-shushik-chip-ico" src="assets/skins/shushik_token_chip.png" alt=""> ` : ''}${fmt(m.bet || 0)} 🪙`;
      body.querySelector('#chessPotChip').innerHTML = `${(topIsShushik || botIsShushik) ? `<img class="bg-shushik-chip-ico" src="assets/skins/shushik_token_chip.png" alt=""> ` : ''}Банк: ${fmt(m.pot || 0)} 🪙`;

      updateClocksDom(m);

      const banner = body.querySelector('#chessTurnBanner');
      const statusTxt = body.querySelector('#chessStatusTxt');
      const inCheck = chess.in_check();
      banner.classList.remove('my-turn', 'opp-turn', 'in-check');
      if (m.status === 'waiting') {
        statusTxt.innerHTML = `<i class="bg-turn-dot"></i>ОЖИДАНИЕ СОПЕРНИКА...`;
        banner.classList.add('opp-turn');
      } else if (m.status === 'finished') {
        statusTxt.innerHTML = `🏁 ${esc(m.reason || 'ПАРТИЯ ОКОНЧЕНА')}`;
      } else if (inCheck) {
        banner.classList.add('in-check');
        statusTxt.innerHTML = `<i class="bg-turn-dot"></i>🔥 ШАХ! ${m.turn === myColor ? 'ВАШ ХОД' : 'ХОД СОПЕРНИКА'}`;
      } else if (m.turn === myColor) {
        banner.classList.add('my-turn');
        statusTxt.innerHTML = `<i class="bg-turn-dot"></i>ВАШ ХОД`;
      } else {
        banner.classList.add('opp-turn');
        statusTxt.innerHTML = `<i class="bg-turn-dot"></i>ХОД СОПЕРНИКА`;
      }

      const resignBtn = body.querySelector('#chessResignBtn');
      if (resignBtn) resignBtn.disabled = m.status !== 'active';

      const boardKey = `${m.fen}|${selectedSq}|${m.lastFrom || ''}|${m.lastTo || ''}|${amBlack ? '1' : '0'}`;
      if (boardKey !== lastBoardKey) {
        lastBoardKey = boardKey;
        const legalMoves = selectedSq ? chess.moves({ square: selectedSq, verbose: true }) : [];
        const legalTargets = new Map(legalMoves.map(mv => [mv.to, mv]));

        const files = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'];
        const ranks = amBlack ? [1, 2, 3, 4, 5, 6, 7, 8] : [8, 7, 6, 5, 4, 3, 2, 1];
        const fOrder = amBlack ? [...files].reverse() : files;
        const bottomRank = amBlack ? 8 : 1;

        let html = '';
        for (const r of ranks) {
          for (let fi = 0; fi < 8; fi++) {
            const f = fOrder[fi];
            const sq = f + r;
            const isLight = (files.indexOf(f) + r) % 2 !== 0;
            const piece = chess.get(sq);
            const isSel = selectedSq === sq;
            const isLast = m.lastFrom === sq || m.lastTo === sq;
            const mvInfo = legalTargets.get(sq);
            const isKingCheck = piece && piece.type === 'k' && piece.color === chess.turn() && inCheck;
            const cls = [
              'bg-sq',
              isLight ? 'l' : 'd',
              isSel ? 'sel' : '',
              isLast ? 'last' : '',
              isKingCheck ? 'chk' : '',
              mvInfo ? (piece ? 'cap' : 'mv') : ''
            ].filter(Boolean).join(' ');

            const rankCoord = fi === 0 ? `<span class="bg-coord">${r}</span>` : '';
            const fileCoord = r === bottomRank ? `<span class="bg-coord file">${f}</span>` : '';
            const svg = piece ? chessPieceSvg(piece.color, piece.type) : '';
            html += `<div class="${cls}" data-sq="${sq}">${rankCoord}${fileCoord}${svg}</div>`;
          }
        }
        boardEl.innerHTML = html;
      }

      const hist = Array.isArray(m.history) ? m.history : (m.history && typeof m.history === 'object' ? Object.values(m.history) : []);
      body.querySelector('#chessMovesBox').textContent = hist.length
        ? 'Ходы: ' + hist.map((san, i) => (i % 2 === 0 ? `${Math.floor(i / 2) + 1}. ${san}` : san)).join(' ')
        : 'Ходы партии: сделайте первый ход';

      const out = body.querySelector('#chessOutcomeBox');
      if (m.status === 'finished') {
        out.innerHTML = `<div class="bg-result"><h3>🏆 ${esc(m.reason || 'Партия завершена')}</h3><div>Банк дуэли: <b>${fmt(m.pot || 0)} 🪙</b></div></div>`;
      } else if (m.status === 'waiting') {
        out.innerHTML = `
          <div class="bg-sec" style="margin-top:8px;text-align:center">
            <div class="bg-muted" style="margin-bottom:8px">⏳ Ожидание подключения соперника к дуэли...</div>
            <button type="button" class="bg-btn green" id="chessInviteTgBtn" style="width:100%">📲 Пригласить друга в Telegram</button>
          </div>
        `;
        const invBtn = out.querySelector('#chessInviteTgBtn');
        if (invBtn) invBtn.onclick = () => shareDuelInviteToTelegram(matchId, 'chess', m.bet || 10000);
      } else {
        out.innerHTML = '';
      }

      if (m.vsBot && m.status === 'active' && m.turn === 'b' && !botThinking) {
        setTimeout(() => makeBotChessMove(matchId), 680);
      }
    }

    boardEl.onclick = async (e) => {
      const cell = e.target.closest('[data-sq]');
      if (!cell || !currentMatch || currentMatch.status !== 'active' || !window.Chess) return;
      const sq = cell.getAttribute('data-sq');
      const amBlack = String(currentMatch.blackId) === me.id && String(currentMatch.whiteId) !== me.id;
      const myColor = amBlack ? 'b' : 'w';
      const chess = new window.Chess(currentMatch.fen);
      if (chess.turn() !== myColor) return;

      const clickedPiece = chess.get(sq);
      if (selectedSq) {
        if (selectedSq === sq) { selectedSq = ''; drawChess(currentMatch); return; }
        const moveObj = chess.move({ from: selectedSq, to: sq, promotion: 'q' });
        if (moveObj) {
          selectedSq = '';
          await commitChessMove(chess, moveObj);
          return;
        }
      }
      if (clickedPiece && clickedPiece.color === myColor) {
        selectedSq = sq;
        drawChess(currentMatch);
      } else if (selectedSq) {
        selectedSq = '';
        drawChess(currentMatch);
      }
    };

    async function commitChessMove(chess, moveObj) {
      const clocks = getLiveClocks(currentMatch);
      const prevHist = Array.isArray(currentMatch.history)
        ? currentMatch.history
        : (currentMatch.history && typeof currentMatch.history === 'object' ? Object.values(currentMatch.history) : []);
      const hist = [...prevHist, moveObj.san];
      let status = 'active';
      let winner = '';
      let reason = '';
      let isDraw = false;

      if (chess.in_checkmate()) {
        status = 'finished';
        winner = moveObj.color === 'w' ? currentMatch.whiteId : currentMatch.blackId;
        reason = `Мат! Победил ${moveObj.color === 'w' ? currentMatch.whiteName : currentMatch.blackName}`;
      } else if (chess.in_stalemate() || chess.in_draw() || chess.in_threefold_repetition() || chess.insufficient_material()) {
        status = 'finished';
        isDraw = true;
        reason = 'Ничья (Пат / Правило шахмат)';
      }

      const patch = {
        fen: chess.fen(),
        history: hist,
        turn: chess.turn(),
        wTime: clocks.w,
        bTime: clocks.b,
        lastMoveTs: Date.now(),
        lastFrom: moveObj.from,
        lastTo: moveObj.to,
        status,
        winner,
        reason
      };
      pushTelemetryAction(`chess_move:${moveObj.color}:${moveObj.san}`);
      currentMatch = { ...currentMatch, ...patch };
      drawChess(currentMatch);
      await fbPatch(`duel_matches/${encodeURIComponent(matchId)}`, patch);
      if (status === 'finished') {
        await settleDuelPot(matchId, winner, isDraw);
      }
    }

    async function makeBotChessMove(mid) {
      if (botThinking) return;
      botThinking = true;
      try {
        const m = await fbGet(`duel_matches/${encodeURIComponent(mid)}`, true);
        if (!m || m.status !== 'active' || m.turn !== 'b' || !window.Chess) return;
        const chess = new window.Chess(m.fen);
        const moves = chess.moves({ verbose: true });
        if (!moves.length) return;

        const VAL = { p: 100, n: 320, b: 330, r: 500, q: 900, k: 20000 };
        const CENTER = new Set(['d4', 'e4', 'd5', 'e5']);
        const INNER = new Set(['c3', 'd3', 'e3', 'f3', 'c4', 'f4', 'c5', 'f5', 'c6', 'd6', 'e6', 'f6']);

        let bestMove = moves[0];
        let bestScore = -1e9;
        for (const mv of moves) {
          let sc = Math.random() * 16;
          if (mv.captured) sc += (VAL[mv.captured] || 100) - (VAL[mv.piece] || 100) * 0.12;
          if (mv.promotion) sc += 820;
          if (CENTER.has(mv.to)) sc += 26;
          else if (INNER.has(mv.to)) sc += 12;
          if ((mv.piece === 'n' || mv.piece === 'b') && (mv.from[1] === '8')) sc += 16;

          chess.move(mv);
          if (chess.in_checkmate()) sc += 100000;
          else if (chess.in_check()) sc += 42;
          else if (chess.in_stalemate() || chess.in_draw()) sc -= 250;
          // Штраф за подставку дорогой фигуры под бой без защиты
          const oppMoves = chess.moves({ verbose: true });
          if (oppMoves.some(om => om.to === mv.to)) {
            sc -= (VAL[mv.piece] || 100) * 0.78;
          }
          chess.undo();

          if (sc > bestScore) { bestScore = sc; bestMove = mv; }
        }

        const moveObj = chess.move(bestMove);
        if (!moveObj) return;
        currentMatch = m;
        await commitChessMove(chess, moveObj);
      } finally {
        botThinking = false;
      }
    }

    body.querySelector('#chessResignBtn').onclick = async () => {
      if (!currentMatch || currentMatch.status !== 'active') return;
      const amWhite = String(currentMatch.whiteId) === me.id;
      const winId = amWhite ? currentMatch.blackId : currentMatch.whiteId;
      const winName = amWhite ? currentMatch.blackName : currentMatch.whiteName;
      await fbPatch(`duel_matches/${encodeURIComponent(matchId)}`, {
        status: 'finished', winner: winId, reason: `Сдача! Победил ${winName}`
      });
      await settleDuelPot(matchId, winId, false);
    };

    _turnInterval = setInterval(async () => {
      if (!currentMatch || currentMatch.status !== 'active') return;
      updateClocksDom(currentMatch);
      if (!isNoTimerMatch(currentMatch)) {
        const clocks = getLiveClocks(currentMatch);
        if (clocks.w <= 0 || clocks.b <= 0) {
          const winId = clocks.w <= 0 ? currentMatch.blackId : currentMatch.whiteId;
          const winName = clocks.w <= 0 ? currentMatch.blackName : currentMatch.whiteName;
          currentMatch.status = 'finished';
          await fbPatch(`duel_matches/${encodeURIComponent(matchId)}`, {
            status: 'finished', winner: winId, reason: `Флаг упал! Победил ${winName}`
          });
          await settleDuelPot(matchId, winId, false);
          return;
        }
      }
      if (currentMatch.vsBot && currentMatch.turn === 'b' && !botThinking && Date.now() - (Number(currentMatch.lastMoveTs) || 0) > 1500) {
        makeBotChessMove(matchId);
      }
    }, 350);

    _viewUnsubs.push(onValue(`duel_matches/${encodeURIComponent(matchId)}`, drawChess, 1100));
  }

  // ==================== 5. ТОВАРИЩЕСКИЕ СТОЛЫ И ПОЛНЫЙ ДВИЖОК ХОЛДЕМА ====================
  const STUCK_WATCHDOG_MS = 5000;
  const STAGE_LABELS = {
    waiting: 'ОЖИДАНИЕ ИГРОКОВ',
    preflop: 'ПРЕФЛОП',
    flop: 'ФЛОП',
    turn: 'ТЁРН',
    river: 'РИВЕР',
    showdown: 'ШОУДАУН',
    finished: 'МАТЧ ЗАВЕРШЁН'
  };

  function toArr(v) {
    if (Array.isArray(v)) return v;
    if (v && typeof v === 'object') return Object.values(v);
    return [];
  }

  function normalizePokerTable(tbl) {
    if (!tbl || typeof tbl !== 'object') return null;
    tbl.seats = toArr(tbl.seats).filter(Boolean).map(s => ({
      ...s,
      stack: Math.max(0, Math.round(Number(s.stack) || 0)),
      initialBuyIn: Math.max(0, Math.round(Number(s.initialBuyIn) || Number(s.stack) || 0)),
      bet: Math.max(0, Math.round(Number(s.bet) || 0)),
      totalBet: Math.max(0, Math.round(Number(s.totalBet) || 0)),
      cards: toArr(s.cards).filter(Boolean),
      folded: Boolean(s.folded),
      allIn: Boolean(s.allIn),
      busted: Boolean(s.busted),
      acted: Boolean(s.acted),
      isBot: Boolean(s.isBot),
      missedTurns: Math.max(0, Math.floor(Number(s.missedTurns) || 0)),
      lastActiveTs: Number(s.lastActiveTs) || Date.now()
    }));
    tbl.board = toArr(tbl.board).filter(Boolean);
    tbl.deck = toArr(tbl.deck).filter(Boolean);
    tbl.logs = toArr(tbl.logs).filter(Boolean);
    tbl.chat = toArr(tbl.chat).filter(Boolean).slice(-15);
    tbl.pot = Math.max(0, Math.round(Number(tbl.pot) || 0));
    tbl.currentBet = Math.max(0, Math.round(Number(tbl.currentBet) || 0));
    tbl.dealerIdx = Math.max(0, Math.floor(Number(tbl.dealerIdx) || 0));
    tbl.turnIdx = Math.max(0, Math.floor(Number(tbl.turnIdx) || 0));
    tbl.turnDeadline = Number(tbl.turnDeadline) || 0;
    tbl.handId = Math.max(0, Math.floor(Number(tbl.handId) || 0));
    tbl.lastDealTs = Number(tbl.lastDealTs) || 0;
    tbl.creatorId = tbl.creatorId ? String(tbl.creatorId) : '';
    tbl.updatedAt = Number(tbl.updatedAt) || Date.now();
    return tbl;
  }

  function drawCardSafe(tbl) {
    const used = new Set(tbl.board);
    for (const s of tbl.seats) {
      for (const c of (s.cards || [])) if (c && c !== '??') used.add(c);
    }
    tbl.deck = (tbl.deck || []).filter(c => c && !used.has(c));
    if (tbl.deck.length === 0) {
      tbl.deck = makeDeck().filter(c => !used.has(c));
    }
    return tbl.deck.pop() || 'As';
  }

  function resolveShowdownInPlace(tbl, tid, knockoutsOut, payoutsOut) {
    while (tbl.board.length < 5) tbl.board.push(drawCardSafe(tbl));
    const contenders = tbl.seats.filter(s => !s.folded && !s.busted);
    let duelWinnerId = '';

    if (contenders.length === 0) {
      tbl.pot = 0;
      tbl.stage = 'showdown';
      tbl.turnDeadline = Date.now() + 3500;
      tbl.updatedAt = Date.now();
      return '';
    }

    if (contenders.length === 1) {
      const w = contenders[0];
      const wonAmt = tbl.pot;
      w.stack += wonAmt;
      if (payoutsOut && wonAmt > 0 && !w.isBot) {
        payoutsOut.push({ userId: w.id, wonPot: wonAmt, newStack: w.stack });
      }
      tbl.winnerBanner = `🏆 ${w.name} забирает ${fmt(wonAmt)} 🪵!`;
      tbl.logs = tbl.logs.slice(-11).concat([tbl.winnerBanner]);
      tbl.pot = 0;
      tbl.stage = 'showdown';
      tbl.turnDeadline = Date.now() + 3500;
      tbl.updatedAt = Date.now();
      return '';
    }

    const evalMap = {};
    contenders.forEach(s => {
      const ev = evaluate7Cards([...(s.cards || []), ...tbl.board]);
      evalMap[s.id] = ev;
      s.handName = ev.name;
      s.status = ev.name;
    });

    const pots = computeSidePots(tbl.seats);
    let mainWinner = contenders[0];
    const distributedTotal = pots.reduce((acc, p) => acc + p.amount, 0);
    if (pots.length === 0 && tbl.pot > 0) {
      pots.push({ amount: tbl.pot, eligibleIds: contenders.map(c => c.id) });
    } else if (tbl.pot > distributedTotal && pots.length > 0) {
      pots[0].amount += (tbl.pot - distributedTotal);
    }

    for (const p of pots) {
      let elig = contenders.filter(c => p.eligibleIds.includes(c.id));
      if (!elig.length) elig = [...contenders];
      elig.sort((a, b) => evalMap[b.id].score - evalMap[a.id].score);
      const topScore = evalMap[elig[0].id].score;
      const winners = elig.filter(e => evalMap[e.id].score === topScore);
      const share = Math.floor(p.amount / winners.length);
      const odd = p.amount - share * winners.length;
      winners.forEach((w, idx) => {
        const gain = share + (idx === 0 ? odd : 0);
        w.stack += gain;
        if (payoutsOut && gain > 0 && !w.isBot) {
          payoutsOut.push({ userId: w.id, wonPot: gain, newStack: w.stack });
        }
      });
      mainWinner = winners[0];
    }

    tbl.seats.forEach(s => {
      if (!s.busted && s.stack <= 0) {
        s.busted = true;
        s.status = 'Расколот 🪵';
        if (mainWinner && mainWinner.id !== s.id && knockoutsOut) {
          knockoutsOut.push({ victimId: s.id, victimName: s.name, killerId: mainWinner.id, killerName: mainWinner.name });
        }
      }
    });

    const stillAlive = tbl.seats.filter(s => !s.busted && s.stack > 0);
    if (!tbl.isTournament && String(tid).startsWith('duel_') && stillAlive.length === 1) {
      duelWinnerId = stillAlive[0].id;
    }

    tbl.winnerBanner = `🏆 ${mainWinner.name}: ${evalMap[mainWinner.id].name}`;
    tbl.logs = tbl.logs.slice(-11).concat([tbl.winnerBanner]);
    tbl.pot = 0;
    tbl.stage = duelWinnerId ? 'finished' : 'showdown';
    tbl.turnDeadline = Date.now() + 3800;
    tbl.updatedAt = Date.now();
    return duelWinnerId;
  }

  function advancePokerStreetsInPlace(tbl, tid, knockoutsOut, payoutsOut) {
    const contenders = tbl.seats.filter(s => !s.folded && !s.busted);
    if (contenders.length <= 1) {
      return resolveShowdownInPlace(tbl, tid, knockoutsOut, payoutsOut);
    }

    const canActCount = contenders.filter(s => !s.allIn && s.stack > 0).length;
    const stepOneStreet = () => {
      tbl.seats.forEach(s => { s.bet = 0; s.acted = false; });
      tbl.currentBet = 0;
      if (tbl.stage === 'preflop') {
        while (tbl.board.length < 3) tbl.board.push(drawCardSafe(tbl));
        tbl.stage = 'flop';
      } else if (tbl.stage === 'flop') {
        while (tbl.board.length < 4) tbl.board.push(drawCardSafe(tbl));
        tbl.stage = 'turn';
      } else if (tbl.stage === 'turn') {
        while (tbl.board.length < 5) tbl.board.push(drawCardSafe(tbl));
        tbl.stage = 'river';
      } else {
        while (tbl.board.length < 5) tbl.board.push(drawCardSafe(tbl));
        tbl.stage = 'showdown';
      }
    };

    if (canActCount <= 1) {
      while (tbl.stage !== 'showdown') stepOneStreet();
    } else {
      stepOneStreet();
    }

    if (tbl.stage !== 'showdown') {
      // На постфлопе (flop, turn, river) первым ходит первый активный игрок после дилера
      const n = tbl.seats.length;
      let postTurn = -1;
      for (let step = 1; step <= n; step++) {
        const idx = (tbl.dealerIdx + step) % n;
        const c = tbl.seats[idx];
        if (c && !c.folded && !c.busted && !c.allIn && c.stack > 0) {
          postTurn = idx;
          break;
        }
      }
      if (postTurn === -1) {
        while (tbl.stage !== 'showdown') stepOneStreet();
      } else {
        tbl.turnIdx = postTurn;
        tbl.turnDeadline = Date.now() + TURN_TIMEOUT_MS;
        tbl.updatedAt = Date.now();
        return '';
      }
    }

    return resolveShowdownInPlace(tbl, tid, knockoutsOut, payoutsOut);
  }

  async function refundOrCashoutSeatStack(userId, stackAmt, isDuelTable, isTournamentTable) {
    const amt = Math.max(0, Math.round(Number(stackAmt) || 0));
    if (!userId || userId === 'birch_ai_bot' || amt <= 0) return;
    if (isDuelTable) return; // Дуэли рассчитываются через settleDuelPot
    const me = getMe();
    if (isTournamentTable) {
      // В турнире сохраняем палочки (sticks) в профиль игрока
      if (String(userId) === String(me.id)) {
        updateLocalWallet({ sticks: amt });
        await syncMyWalletToFirebase({ sticks: amt });
      } else {
        await adminModifyPlayerResource(userId, 'sticks', 'set', amt);
      }
    } else {
      // За кэш-столом 24/7 возвращаем стек в коины + синхронизируем палочки
      if (String(userId) === String(me.id)) {
        const nextCoins = getCoins() + amt;
        const nextSticks = Math.max(getSticks(), amt);
        updateLocalWallet({ coins: nextCoins, sticks: nextSticks });
        await syncMyWalletToFirebase({ coins: nextCoins, sticks: nextSticks });
      } else {
        await adminModifyPlayerResource(userId, 'coins', 'add', amt);
      }
    }
  }

  async function processPokerPostEffects(tid, knockouts, duelWinnerId, payouts = [], kickedSeats = [], shouldDeleteTable = false) {
    const isDuel = String(tid).startsWith('duel_');
    const isTour = String(tid).startsWith('tour_');
    const me = getMe();

    // Сохраняем выигранные палочки в профиль/кошелёк сразу после раздачи (Блок 3 п. 5)
    for (const po of (payouts || [])) {
      if (!po || !po.userId || po.userId === 'birch_ai_bot') continue;
      if (String(po.userId) === String(me.id)) {
        const bonusSticks = Math.max(0, Math.round((Number(po.wonPot) || 0) * 0.1));
        const nextSticks = Math.max(getSticks(), Number(po.newStack) || 0) + bonusSticks;
        updateLocalWallet({ sticks: nextSticks });
        syncMyWalletToFirebase({ sticks: nextSticks }).catch(() => {});
      }
    }

    // Возврат стека исключённым по AFK игрокам
    for (const ks of (kickedSeats || [])) {
      if (!ks || ks.isBot) continue;
      await refundOrCashoutSeatStack(ks.id, ks.stack, isDuel, isTour);
      if (String(ks.id) === String(me.id)) {
        toast('⏱ Вы пропустили 2 хода подряд и были исключены из-за стола (стек возвращён).');
      } else {
        toast(`🥾 Игрок ${ks.name || ks.id} исключён за AFK (2 пропуска хода).`);
      }
    }

    for (const ko of (knockouts || [])) {
      playKnockoutAnimation(ko.victimName, ko.killerName);
      if (ko.killerId && ko.killerId !== 'birch_ai_bot') {
        await adminModifyPlayerResource(ko.killerId, 'coins', 'add', 20000);
        const kp = await fbGet(`players/${encodeURIComponent(ko.killerId)}`);
        const nextLogs = ((kp && Number(kp.choppedLogs)) || 0) + 1;
        await fbPatch(`players/${encodeURIComponent(ko.killerId)}`, { choppedLogs: nextLogs });
        if (String(ko.killerId) === getMe().id) {
          updateLocalWallet({ choppedLogs: nextLogs });
          toast('🪓 БАУНТИ НОКАУТ! +20 000 🪙 и +1 в «Наколотые чурки»!');
        }
      }
    }

    if (duelWinnerId) {
      await settleDuelPot(tid, duelWinnerId, false);
      // После завершения 1v1 дуэли удаляем стол через 4 секунды, чтобы он не висел мёртвым грузом
      setTimeout(() => { fbDelete(`poker_tables/${encodeURIComponent(tid)}`).catch(() => {}); }, 4000);
    } else if (shouldDeleteTable) {
      await fbDelete(`poker_tables/${encodeURIComponent(tid)}`).catch(() => {});
    }
  }

  // Выход игрока из-за покерного стола с сохранением палочек/коинов и авто-очисткой пустого стола (Блок 2 п. 4 и Блок 3 п. 5)
  async function leavePokerTable(tid, isTournament = false) {
    if (!tid) return;
    const me = getMe();
    const isDuel = String(tid).startsWith('duel_');
    let myCashedStack = 0;
    let shouldDeleteTable = false;
    let duelForfeitWinnerId = '';
    let cancelWaitingDuel = false;

    await runTransaction(`poker_tables/${encodeURIComponent(tid)}`, tbl => {
      if (!tbl) return tbl;
      normalizePokerTable(tbl);
      const idx = tbl.seats.findIndex(s => String(s.id) === String(me.id));
      if (idx === -1) {
        const humans = tbl.seats.filter(s => !s.isBot);
        if (humans.length === 0) shouldDeleteTable = true;
        return tbl;
      }

      const mySeat = tbl.seats[idx];
      myCashedStack = Math.max(0, Number(mySeat.stack) || 0);
      tbl.seats.splice(idx, 1);
      tbl.logs = tbl.logs.slice(-11).concat([`🚪 ${mySeat.name || 'Игрок'} покинул стол.`]);

      const remainingHumans = tbl.seats.filter(s => !s.isBot);
      const remainingAlive = tbl.seats.filter(s => !s.busted && s.stack > 0);

      if (isDuel) {
        if (remainingAlive.length >= 1 && tbl.stage !== 'waiting' && tbl.stage !== 'finished') {
          duelForfeitWinnerId = remainingAlive[0].id;
          tbl.stage = 'finished';
          tbl.winnerBanner = `🏆 Победа ${remainingAlive[0].name} (соперник вышел)`;
        } else if (remainingHumans.length === 0) {
          cancelWaitingDuel = true;
          shouldDeleteTable = true;
        }
      } else if (remainingHumans.length === 0) {
        shouldDeleteTable = true;
      } else if (remainingAlive.length < 2 && ['preflop', 'flop', 'turn', 'river'].includes(tbl.stage)) {
        // Если остался 1 человек в раздаче — отдаём ему банк
        if (remainingAlive.length === 1) {
          remainingAlive[0].stack += tbl.pot;
          tbl.pot = 0;
        }
        tbl.stage = 'waiting';
      }

      if (tbl.turnIdx >= tbl.seats.length) tbl.turnIdx = 0;
      tbl.updatedAt = Date.now();
      return tbl;
    });

    if (cancelWaitingDuel) {
      await cancelOpenDuelChallenge(tid);
    } else if (duelForfeitWinnerId) {
      await settleDuelPot(tid, duelForfeitWinnerId, false);
      await fbDelete(`poker_tables/${encodeURIComponent(tid)}`).catch(() => {});
    } else if (!isDuel && myCashedStack > 0) {
      await refundOrCashoutSeatStack(me.id, myCashedStack, false, isTournament);
      toast(`🪵 Стек ${fmt(myCashedStack)} сохранён в ваш кошелёк!`);
    }

    if (shouldDeleteTable) {
      await fbDelete(`poker_tables/${encodeURIComponent(tid)}`).catch(() => {});
    }
  }

  function decideBotPokerAction(tbl, botSeat) {
    const stack = Math.max(0, Number(botSeat.stack) || 0);
    const myBet = Math.max(0, Number(botSeat.bet) || 0);
    const curBet = Math.max(0, Number(tbl.currentBet) || 0);
    const toCall = Math.max(0, curBet - myBet);
    const pot = Math.max(200, Number(tbl.pot) || 200);
    const lvl = Number(tbl.blindLevel) || 1;
    const bb = BLIND_LEVELS[Math.min(BLIND_LEVELS.length - 1, lvl - 1)].bb;
    const hole = toArr(botSeat.cards).filter(c => c && c !== '??');
    const board = toArr(tbl.board).filter(Boolean);

    let strength = 42;
    if (hole.length >= 2 && board.length === 0) {
      const r1 = RANKS.indexOf(hole[0][0]) + 2;
      const r2 = RANKS.indexOf(hole[1][0]) + 2;
      const hi = Math.max(r1, r2);
      const lo = Math.min(r1, r2);
      const suited = hole[0][1] === hole[1][1];
      const gap = hi - lo;
      if (hi === lo) {
        strength = 54 + hi * 3.2;
      } else {
        strength = hi * 2.55 + lo * 1.35 + (suited ? 7 : 0) - Math.min(12, Math.max(0, gap - 1) * 2.4);
      }
    } else if (hole.length + board.length >= 5) {
      const fullEv = evaluate7Cards([...hole, ...board]);
      const catBase = [24, 54, 75, 84, 90, 94, 97, 99, 100, 100][fullEv.cat] || 24;
      strength = catBase;
      if (fullEv.cat === 1 && board.length >= 3) {
        const boardVals = board.map(c => RANKS.indexOf(c[0]) + 2);
        const holeVals = hole.map(c => RANKS.indexOf(c[0]) + 2);
        const pairedWithHole = holeVals.some(hv => boardVals.includes(hv)) || (holeVals[0] === holeVals[1]);
        const maxBoard = Math.max(...boardVals);
        if (!pairedWithHole) strength = 32;
        else if (Math.max(...holeVals) >= maxBoard) strength = 64;
      }
      if (board.length < 5) {
        const all = [...hole, ...board];
        const suitCounts = {};
        all.forEach(c => { suitCounts[c[1]] = (suitCounts[c[1]] || 0) + 1; });
        if (Object.values(suitCounts).some(cnt => cnt === 4)) strength += 13;
        const uniqV = [...new Set(all.map(c => RANKS.indexOf(c[0]) + 2))].sort((a, b) => a - b);
        for (let i = 0; i <= uniqV.length - 4; i++) {
          if (uniqV[i + 3] - uniqV[i] <= 4) { strength += 9; break; }
        }
      }
    }

    const jitter = (Math.random() - 0.5) * 10;
    const eff = strength + jitter;
    const costRatio = toCall / (pot + toCall + 1);
    const maxTotal = stack + myBet;
    const minRaiseTo = Math.min(maxTotal, Math.max(curBet * 2, bb * 2));

    if (eff >= 73) {
      if (stack > toCall + bb && curBet < pot * 1.6 && Math.random() < 0.68) {
        const target = Math.min(maxTotal, Math.max(minRaiseTo, curBet + Math.round(pot * 0.65)));
        return { action: 'raise', raiseTo: target };
      }
      return { action: toCall === 0 ? 'check' : 'call', raiseTo: 0 };
    }

    if (eff >= 48) {
      if (toCall === 0) {
        if (stack > bb * 2 && Math.random() < 0.34) {
          const target = Math.min(maxTotal, Math.max(minRaiseTo, Math.round(pot * 0.5)));
          return { action: 'raise', raiseTo: target };
        }
        return { action: 'check', raiseTo: 0 };
      }
      if (costRatio <= 0.46 || toCall <= bb * 3 || eff >= 60) {
        return { action: 'call', raiseTo: 0 };
      }
      return { action: 'fold', raiseTo: 0 };
    }

    if (eff >= 33) {
      if (toCall === 0) {
        if (stack > bb * 3 && Math.random() < 0.1) {
          return { action: 'raise', raiseTo: minRaiseTo };
        }
        return { action: 'check', raiseTo: 0 };
      }
      if (toCall <= bb * 2 || costRatio <= 0.23) {
        return { action: 'call', raiseTo: 0 };
      }
      return { action: 'fold', raiseTo: 0 };
    }

    if (toCall === 0) {
      if (board.length >= 3 && stack > bb * 4 && Math.random() < 0.08) {
        return { action: 'raise', raiseTo: minRaiseTo };
      }
      return { action: 'check', raiseTo: 0 };
    }
    return { action: 'fold', raiseTo: 0 };
  }

  function renderFriendlyTablesTab(body) {
    document.getElementById('bgTitle').textContent = '🪵 Товарищеские столы Холдема 24/7';
    body.innerHTML = `
      <div class="bg-sec">
        <h3>🪵 Открытые деревянные столы (Вход на коины)</h3>
        <div class="bg-row" style="margin-bottom:10px">
          <button class="bg-btn green" id="newFriendly10k">➕ Создать стол (10k 🪙)</button>
          <button class="bg-btn wood" id="newFriendly50k">➕ Создать стол (50k 🪙)</button>
        </div>
        <div id="friendlyTablesBox">Загрузка столов...</div>
      </div>
    `;

    const createQuick = async (buyIn) => {
      if (getCoins() < buyIn) return toast(`❌ Нужно ${fmt(buyIn)} 🪙 для входа за стол!`);
      const tid = `cash_${Date.now()}`;
      const nextC = getCoins() - buyIn;
      updateLocalWallet({ coins: nextC, sticks: Math.max(getSticks(), buyIn) });
      await syncMyWalletToFirebase({ coins: nextC });
      await createOrResetPokerTable(tid, `Берёзовый стол (${fmt(buyIn)} 🪙)`, false, 0);
      await seatPlayerAtPokerTable(tid, `Берёзовый стол`, false, buyIn, 1);
      await seatBotAtPokerTable(tid, buyIn);
      await startTableNewHand(tid);
      _subView = { type: 'poker', id: tid, isTournament: false };
      renderActiveView();
    };

    body.querySelector('#newFriendly10k').onclick = () => createQuick(10000);
    body.querySelector('#newFriendly50k').onclick = () => createQuick(50000);

    _viewUnsubs.push(onValue('poker_tables', data => {
      const box = body.querySelector('#friendlyTablesBox');
      if (!box) return;
      const now = Date.now();
      const me = getMe();
      const isAdm = isAdminUser();
      const rawList = Object.values(data || {}).filter(t => t && t.id);
      const validList = [];

      for (const t of rawList) {
        const seats = toArr(t.seats).filter(Boolean);
        const humanSeats = seats.filter(s => !s.isBot);
        const idleMs = now - (Number(t.updatedAt) || 0);
        // Авто-очистка пустых столов (0 живых игроков) или неактивных > 3 минут (180 000 мс)
        if (humanSeats.length === 0 || idleMs >= 180000 || t.stage === 'finished') {
          fbDelete(`poker_tables/${encodeURIComponent(t.id)}`).catch(() => {});
          continue;
        }
        validList.push(t);
      }

      if (!validList.length) {
        box.innerHTML = `<div class="bg-muted">Активных столов пока нет — создайте стол выше!</div>`;
        return;
      }

      box.innerHTML = validList.map(t => {
        const seats = toArr(t.seats).filter(Boolean);
        const stg = STAGE_LABELS[t.stage] || t.stage || 'ОЖИДАНИЕ';
        const canDelete = isAdm || (t.creatorId && String(t.creatorId) === String(me.id)) || seats.some(s => String(s.id) === String(me.id));
        return `
          <div class="bg-item">
            <div class="grow">
              <b>🃏 ${esc(t.title || t.id)}</b>
              <small>Игроков: ${seats.length}/6 • Банк: ${fmt(t.pot || 0)} 🪵 • ${esc(stg)}</small>
            </div>
            <div class="bg-row" style="gap:6px">
              <button class="bg-btn sm" data-join="${esc(t.id)}:${t.isTournament ? '1' : '0'}">Открыть</button>
              ${canDelete ? `<button class="bg-btn sm red" data-del-table="${esc(t.id)}" title="Удалить стол">🗑</button>` : ''}
            </div>
          </div>
        `;
      }).join('');

      box.querySelectorAll('[data-join]').forEach(b => {
        b.onclick = () => {
          const [tid, isT] = b.getAttribute('data-join').split(':');
          _subView = { type: 'poker', id: tid, isTournament: isT === '1' };
          renderActiveView();
        };
      });

      box.querySelectorAll('[data-del-table]').forEach(b => {
        b.onclick = async () => {
          const tid = b.getAttribute('data-del-table');
          if (!tid) return;
          const tblObj = (data && data[tid]) || null;
          if (tblObj) {
            const seats = toArr(tblObj.seats).filter(s => s && !s.isBot && Number(s.stack) > 0);
            for (const s of seats) {
              await refundOrCashoutSeatStack(s.id, s.stack, String(tid).startsWith('duel_'), Boolean(tblObj.isTournament));
            }
          }
          await fbDelete(`poker_tables/${encodeURIComponent(tid)}`);
          toast('🗑 Стол удалён, стеки возвращены игрокам.');
        };
      });
    }, 2200));
  }

  async function createOrResetPokerTable(tid, title, isTournament, prizePool = 0) {
    const me = getMe();
    const tbl = {
      id: tid,
      title: title || 'Берёзовый Холдем',
      creatorId: String(me.id || ''),
      isTournament: Boolean(isTournament),
      prizePool: Number(prizePool) || 0,
      blindLevel: 1,
      handId: 0,
      lastDealTs: 0,
      stage: 'waiting',
      pot: 0,
      currentBet: 0,
      dealerIdx: 0,
      turnIdx: 0,
      turnDeadline: 0,
      updatedAt: Date.now(),
      board: [],
      deck: [],
      seats: [],
      chat: [],
      logs: [`🪵 Стол «${title || 'Берёзовый Холдем'}» открыт!`]
    };
    await fbPut(`poker_tables/${encodeURIComponent(tid)}`, tbl);
    return tbl;
  }

  async function seatPlayerAtPokerTable(tid, title, isTournament, addSticks, blindLevel = 1) {
    const me = getMe();
    const mySkin = getLocalState().equippedSkin || 'classic';
    const now = Date.now();
    await runTransaction(`poker_tables/${encodeURIComponent(tid)}`, tbl => {
      if (!tbl) {
        tbl = {
          id: tid, title: title || 'Берёзовый Холдем', creatorId: String(me.id || ''), isTournament: Boolean(isTournament),
          blindLevel, handId: 0, lastDealTs: 0, stage: 'waiting', pot: 0, currentBet: 0, dealerIdx: 0, turnIdx: 0,
          turnDeadline: 0, updatedAt: now, board: [], deck: [], seats: [], chat: [], logs: []
        };
      }
      normalizePokerTable(tbl);
      const ex = tbl.seats.find(s => String(s.id) === me.id);
      if (ex) {
        ex.stack = (Number(ex.stack) || 0) + addSticks;
        ex.skin = mySkin;
        ex.busted = false;
        ex.missedTurns = 0;
        ex.lastActiveTs = now;
        ex.status = 'Готов 🪓';
      } else if (tbl.seats.length < 6) {
        tbl.seats.push({
          id: me.id,
          name: me.name,
          photo: me.photo,
          skin: mySkin,
          stack: addSticks,
          initialBuyIn: addSticks,
          bet: 0,
          totalBet: 0,
          cards: [],
          folded: false,
          allIn: false,
          busted: false,
          acted: false,
          isBot: false,
          missedTurns: 0,
          lastActiveTs: now,
          status: 'За столом 🌿'
        });
      }
      tbl.updatedAt = now;
      return tbl;
    });
  }

  async function seatBotAtPokerTable(tid, startStack) {
    await runTransaction(`poker_tables/${encodeURIComponent(tid)}`, tbl => {
      if (!tbl) return tbl;
      normalizePokerTable(tbl);
      const exBot = tbl.seats.find(s => s.id === 'birch_ai_bot');
      if (exBot) {
        if (exBot.stack <= 0) {
          exBot.stack = startStack;
          exBot.busted = false;
          exBot.status = 'Готов 🪓';
        }
      } else if (tbl.seats.length < 6) {
        tbl.seats.push({
          id: 'birch_ai_bot',
          name: '🤖 Леший AI',
          photo: '',
          stack: startStack,
          initialBuyIn: startStack,
          bet: 0,
          totalBet: 0,
          cards: [],
          folded: false,
          allIn: false,
          busted: false,
          acted: false,
          isBot: true,
          missedTurns: 0,
          lastActiveTs: Date.now(),
          status: 'Готов 🪓'
        });
      }
      tbl.updatedAt = Date.now();
      return tbl;
    });
  }

  // Клиентский замок против параллельных вызовов startTableNewHand за одну секунду
  const _dealLockByTable = {};

  async function startTableNewHand(tid, expectedStage = '') {
    const nowTs = Date.now();
    if (_dealLockByTable[tid] && nowTs - _dealLockByTable[tid] < 2200) {
      return;
    }
    _dealLockByTable[tid] = nowTs;

    pushTelemetryAction(`poker_deal:${tid}`);
    let knockouts = [];
    let payouts = [];
    let duelWinnerId = '';

    await runTransaction(`poker_tables/${encodeURIComponent(tid)}`, tbl => {
      if (!tbl) return tbl;
      normalizePokerTable(tbl);
      if (!tbl.seats.length || tbl.stage === 'finished') return tbl;

      // СТРОГАЯ АТОМАРНАЯ БЛОКИРОВКА (Блок 2 п. 3/1):
      // Если раздача уже идёт (preflop/flop/turn/river) или стадия уже изменилась другим клиентом — отменяем транзакцию (return;)
      if (['preflop', 'flop', 'turn', 'river'].includes(tbl.stage)) return;
      if (expectedStage && tbl.stage !== expectedStage) return;
      if (tbl.lastDealTs && Date.now() - Number(tbl.lastDealTs) < 2200) return;

      // На открытых кэш-столах 24/7 бот докупается при 0 стеке, чтобы игра не застревала
      const isCash = !tbl.isTournament && !String(tid).startsWith('duel_');
      if (isCash) {
        const bot = tbl.seats.find(s => s.isBot && s.stack <= 0);
        if (bot) {
          bot.stack = 20000;
          bot.busted = false;
        }
      }

      const alive = tbl.seats.filter(s => s.stack > 0);
      if (alive.length < 2) {
        tbl.stage = String(tid).startsWith('duel_') && alive.length === 1 ? 'finished' : 'waiting';
        tbl.updatedAt = Date.now();
        return tbl;
      }

      const deck = makeDeck();
      const lvl = Number(tbl.blindLevel) || 1;
      const bl = BLIND_LEVELS[Math.min(BLIND_LEVELS.length - 1, lvl - 1)];

      tbl.seats.forEach(s => {
        if (s.stack <= 0) {
          s.busted = true; s.folded = true; s.allIn = false; s.acted = true;
          s.cards = []; s.bet = 0; s.totalBet = 0;
          s.status = 'Расколот 🪵';
        } else {
          s.busted = false; s.folded = false; s.allIn = false; s.acted = false;
          s.bet = 0; s.totalBet = 0;
          s.cards = [deck.pop(), deck.pop()];
          s.status = 'В игре';
        }
      });

      const activeIdx = tbl.seats.map((s, i) => (!s.busted ? i : -1)).filter(i => i >= 0);
      const nextDealer = activeIdx.find(i => i > tbl.dealerIdx);
      tbl.dealerIdx = nextDealer !== undefined ? nextDealer : activeIdx[0];
      const dPos = activeIdx.indexOf(tbl.dealerIdx);

      // ПРАВИЛА БЛАЙНДОВ HEADS-UP (1 на 1) и 3+ игроков:
      // В 1 на 1 Дилер (dealerIdx) ставит Малый Блайнд (МБ = 100) и ходит ПЕРВЫМ на префлопе (turnIdx = dealerIdx),
      // а второй игрок ставит Большой Блайнд (ББ = 200) и на префлопе обязательно имеет право на опцию (Чек / Рейз) — acted = false!
      let sbPos, bbPos, firstTurnCand;
      if (activeIdx.length === 2) {
        sbPos = tbl.dealerIdx;
        bbPos = activeIdx[(dPos + 1) % 2];
        firstTurnCand = sbPos;
      } else {
        sbPos = activeIdx[(dPos + 1) % activeIdx.length];
        bbPos = activeIdx[(dPos + 2) % activeIdx.length];
        firstTurnCand = activeIdx[(dPos + 3) % activeIdx.length];
      }

      tbl.handId = (Number(tbl.handId) || 0) + 1;
      tbl.lastDealTs = Date.now();
      tbl.board = [];
      tbl.pot = 0;
      tbl.stage = 'preflop';
      tbl.winnerBanner = '';
      tbl.deck = deck;

      const postBlind = (seat, amount, label) => {
        const pay = Math.min(seat.stack, amount);
        seat.stack -= pay;
        seat.bet += pay;
        seat.totalBet += pay;
        tbl.pot += pay;
        seat.acted = false; // Обязательно false, чтобы у ББ сохранялась опция Чека/Рейза на префлопе
        if (seat.stack === 0) seat.allIn = true;
        seat.status = label;
      };
      postBlind(tbl.seats[sbPos], bl.sb, `МБ ${fmt(bl.sb)}`);
      postBlind(tbl.seats[bbPos], bl.bb, `ББ ${fmt(bl.bb)}`);

      tbl.currentBet = Math.max(tbl.seats[sbPos].bet, tbl.seats[bbPos].bet);
      tbl.logs = tbl.logs.slice(-11).concat([`🃏 Раздача #${tbl.handId} • Блайнды ${fmt(bl.sb)}/${fmt(bl.bb)} 🪵`]);

      const canAct = tbl.seats.filter(s => !s.folded && !s.busted && !s.allIn && s.stack > 0);
      const needDecision = canAct.some(s => s.bet < tbl.currentBet || !s.acted) || canAct.length >= 2;
      if (!needDecision || canAct.length === 0) {
        duelWinnerId = advancePokerStreetsInPlace(tbl, tid, knockouts, payouts);
        return tbl;
      }

      if (activeIdx.length === 2) {
        const sbSeat = tbl.seats[sbPos];
        const bbSeat = tbl.seats[bbPos];
        if (sbSeat && !sbSeat.folded && !sbSeat.busted && !sbSeat.allIn && sbSeat.stack > 0) {
          tbl.turnIdx = sbPos;
        } else if (bbSeat && !bbSeat.folded && !bbSeat.busted && !bbSeat.allIn && bbSeat.stack > 0) {
          tbl.turnIdx = bbPos;
        } else {
          duelWinnerId = advancePokerStreetsInPlace(tbl, tid, knockouts, payouts);
          return tbl;
        }
      } else {
        const n = tbl.seats.length;
        let chosenTurn = firstTurnCand;
        for (let step = 0; step < n; step++) {
          const idx = (firstTurnCand + step) % n;
          const c = tbl.seats[idx];
          if (c && !c.folded && !c.busted && !c.allIn && c.stack > 0) {
            chosenTurn = idx;
            break;
          }
        }
        tbl.turnIdx = chosenTurn;
      }

      tbl.turnDeadline = Date.now() + TURN_TIMEOUT_MS;
      tbl.updatedAt = Date.now();
      return tbl;
    });

    await processPokerPostEffects(tid, knockouts, duelWinnerId, payouts);
  }

  async function applyPokerPlayerAction(tid, actorId, action, raiseTo = 0, isAutoTimeout = false) {
    // Быстрая защита на клиенте: если уже Showdown / ожидание / раздача завершена — игнорируем клики (Блок 2 п. 4/2)
    if (!isAutoTimeout && _livePokerState && String(_livePokerState.tableId) === String(tid)) {
      if (_livePokerState.stage === 'showdown' || _livePokerState.stage === 'waiting' || _livePokerState.stage === 'finished' || _livePokerState.winnerBanner) {
        return;
      }
    }

    pushTelemetryAction(`poker_act:${actorId}:${action}${raiseTo ? ':' + raiseTo : ''}${isAutoTimeout ? ':timeout' : ''}`);
    let knockouts = [];
    let payouts = [];
    let kickedSeats = [];
    let duelWinnerId = '';
    let shouldDeleteTable = false;

    await runTransaction(`poker_tables/${encodeURIComponent(tid)}`, tbl => {
      if (!tbl) return tbl;
      normalizePokerTable(tbl);
      if (tbl.stage === 'showdown' || tbl.stage === 'waiting' || tbl.stage === 'finished' || tbl.winnerBanner) return;
      if (!['preflop', 'flop', 'turn', 'river'].includes(tbl.stage)) return;

      const seat = tbl.seats[tbl.turnIdx];
      if (!seat || String(seat.id) !== String(actorId)) return;

      const now = Date.now();
      if (isAutoTimeout && !seat.isBot) {
        seat.missedTurns = (Number(seat.missedTurns) || 0) + 1;
      } else {
        seat.missedTurns = 0;
        seat.lastActiveTs = now;
      }

      const toCall = Math.max(0, tbl.currentBet - seat.bet);
      if (action === 'fold' && toCall > 0) {
        seat.folded = true;
        seat.acted = true;
        seat.status = isAutoTimeout ? 'Авто-пас ⏱' : 'Пас 🍂';
        tbl.logs = tbl.logs.slice(-11).concat([`🍂 ${seat.name}: ${isAutoTimeout ? 'Авто-пас (таймаут)' : 'Пас'}`]);
      } else if (action === 'check' || (action === 'fold' && toCall === 0) || (action === 'call' && toCall === 0)) {
        seat.acted = true;
        seat.status = isAutoTimeout ? 'Авто-чек ⏱' : 'Чек 🌿';
        tbl.logs = tbl.logs.slice(-11).concat([`🌿 ${seat.name}: ${isAutoTimeout ? 'Авто-чек (таймаут)' : 'Чек'}`]);
      } else if (action === 'call') {
        const pay = Math.min(seat.stack, toCall);
        seat.stack -= pay;
        seat.bet += pay;
        seat.totalBet += pay;
        tbl.pot += pay;
        seat.acted = true;
        if (seat.stack === 0) seat.allIn = true;
        seat.status = seat.allIn ? 'Ва-банк 🔥' : `Колл ${fmt(pay)}`;
        tbl.logs = tbl.logs.slice(-11).concat([`🪵 ${seat.name}: Колл ${fmt(pay)}`]);
      } else if (action === 'raise') {
        const lvl = Number(tbl.blindLevel) || 1;
        const bb = BLIND_LEVELS[Math.min(BLIND_LEVELS.length - 1, lvl - 1)].bb;
        const desiredTotalBet = Math.max(tbl.currentBet + bb, tbl.currentBet * 2, Number(raiseTo) || 0);
        const add = Math.min(seat.stack, Math.max(toCall, desiredTotalBet - seat.bet));
        seat.stack -= add;
        seat.bet += add;
        seat.totalBet += add;
        tbl.pot += add;
        seat.acted = true;
        if (seat.bet > tbl.currentBet) {
          tbl.currentBet = seat.bet;
          tbl.seats.forEach((s, idx) => {
            if (idx !== tbl.turnIdx && !s.folded && !s.busted && !s.allIn && s.stack > 0) s.acted = false;
          });
        }
        if (seat.stack === 0) seat.allIn = true;
        seat.status = seat.allIn ? 'Ва-банк 🔥' : `Рейз ${fmt(seat.bet)}`;
        tbl.logs = tbl.logs.slice(-11).concat([`🪓 ${seat.name}: Рейз до ${fmt(seat.bet)}`]);
      }

      // АВТО-КИК ЗА AFK (2 пропуска хода подряд или > 45 сек бездействия при таймауте) — Блок 2 п. 5/3
      if (isAutoTimeout && !seat.isBot && (seat.missedTurns >= 2 || (now - (Number(seat.lastActiveTs) || now) > 45000))) {
        seat.folded = true;
        seat.acted = true;
        kickedSeats.push({ id: seat.id, name: seat.name, stack: seat.stack, isBot: false });
        tbl.logs = tbl.logs.slice(-11).concat([`🥾 ${seat.name} исключён из-за стола (AFK: 2 пропуска хода)`]);
        tbl.seats.splice(tbl.turnIdx, 1);

        const isDuel = String(tid).startsWith('duel_');
        const remAlive = tbl.seats.filter(s => !s.busted && s.stack > 0);
        const remHumans = tbl.seats.filter(s => !s.isBot);

        if (isDuel && remAlive.length >= 1) {
          duelWinnerId = remAlive[0].id;
          remAlive[0].stack += tbl.pot;
          tbl.pot = 0;
          tbl.stage = 'finished';
          tbl.winnerBanner = `🏆 Победа ${remAlive[0].name} (соперник AFK)`;
          tbl.updatedAt = now;
          return tbl;
        }
        if (remHumans.length === 0) {
          shouldDeleteTable = true;
        }
        if (tbl.turnIdx >= tbl.seats.length) tbl.turnIdx = 0;
      }

      const contenders = tbl.seats.filter(s => !s.folded && !s.busted);
      if (contenders.length <= 1) {
        duelWinnerId = resolveShowdownInPlace(tbl, tid, knockouts, payouts);
        return tbl;
      }

      const n = tbl.seats.length;
      let nextIdx = -1;
      for (let step = 1; step <= n; step++) {
        const candIdx = (tbl.turnIdx + step) % n;
        const c = tbl.seats[candIdx];
        if (c && !c.folded && !c.busted && !c.allIn && c.stack > 0 && (!c.acted || c.bet < tbl.currentBet)) {
          nextIdx = candIdx;
          break;
        }
      }

      if (nextIdx !== -1) {
        tbl.turnIdx = nextIdx;
        tbl.turnDeadline = Date.now() + TURN_TIMEOUT_MS;
        tbl.updatedAt = Date.now();
        return tbl;
      }

      duelWinnerId = advancePokerStreetsInPlace(tbl, tid, knockouts, payouts);
      return tbl;
    });

    await processPokerPostEffects(tid, knockouts, duelWinnerId, payouts, kickedSeats, shouldDeleteTable);
  }

  // Алиас pokerAction для совместимости
  const pokerAction = applyPokerPlayerAction;

  // Проверка: имеет ли право текущий клиент запускать авто-раздачу (ТОЛЬКО первый активный живой игрок за столом)
  function isLeadingPokerClient(tbl, myId) {
    if (!tbl || !Array.isArray(tbl.seats)) return false;
    const firstHuman = tbl.seats.find(s => s && !s.isBot && !s.busted && s.stack > 0);
    if (firstHuman) return String(firstHuman.id) === String(myId);
    const anyHuman = tbl.seats.find(s => s && !s.isBot);
    return anyHuman ? String(anyHuman.id) === String(myId) : false;
  }

  // Надёжный 5-секундный Watchdog: автоматически устраняет любые зависания WAITING / Ривера / All-In
  async function recoverStuckPokerTable(tid) {
    let knockouts = [];
    let payouts = [];
    let duelWinnerId = '';
    let shouldDealFromStage = '';
    const me = getMe();

    await runTransaction(`poker_tables/${encodeURIComponent(tid)}`, tbl => {
      if (!tbl) return tbl;
      normalizePokerTable(tbl);
      const now = Date.now();
      const idleMs = now - (Number(tbl.updatedAt) || 0);

      if (tbl.stage === 'waiting') {
        const alive = tbl.seats.filter(s => s.stack > 0 && !s.busted);
        if (alive.length >= 2 && idleMs >= STUCK_WATCHDOG_MS && isLeadingPokerClient(tbl, me.id)) {
          shouldDealFromStage = 'waiting';
        }
        return tbl;
      }

      if (tbl.stage === 'showdown') {
        if ((now > (tbl.turnDeadline || 0) || idleMs >= STUCK_WATCHDOG_MS) && isLeadingPokerClient(tbl, me.id)) {
          shouldDealFromStage = 'showdown';
        }
        return tbl;
      }

      if (!['preflop', 'flop', 'turn', 'river'].includes(tbl.stage)) return tbl;

      // Починка недостающих карт борда при сбое сети
      const reqBoard = tbl.stage === 'flop' ? 3 : (tbl.stage === 'turn' ? 4 : (tbl.stage === 'river' ? 5 : 0));
      while (tbl.board.length < reqBoard) tbl.board.push(drawCardSafe(tbl));

      const contenders = tbl.seats.filter(s => !s.folded && !s.busted);
      if (contenders.length <= 1) {
        duelWinnerId = resolveShowdownInPlace(tbl, tid, knockouts, payouts);
        return tbl;
      }

      const cur = tbl.seats[tbl.turnIdx];
      const curInvalid = !cur || cur.folded || cur.busted || cur.allIn || cur.stack <= 0;
      const pendingActors = tbl.seats.filter(s => !s.folded && !s.busted && !s.allIn && s.stack > 0 && (!s.acted || s.bet < tbl.currentBet));

      if (pendingActors.length === 0) {
        duelWinnerId = advancePokerStreetsInPlace(tbl, tid, knockouts, payouts);
        return tbl;
      }

      if (curInvalid) {
        const n = tbl.seats.length;
        for (let step = 1; step <= n; step++) {
          const idx = (tbl.turnIdx + step) % n;
          const c = tbl.seats[idx];
          if (c && !c.folded && !c.busted && !c.allIn && c.stack > 0 && (!c.acted || c.bet < tbl.currentBet)) {
            tbl.turnIdx = idx;
            tbl.turnDeadline = now + TURN_TIMEOUT_MS;
            tbl.updatedAt = now;
            return tbl;
          }
        }
        duelWinnerId = advancePokerStreetsInPlace(tbl, tid, knockouts, payouts);
        return tbl;
      }

      return tbl;
    });

    await processPokerPostEffects(tid, knockouts, duelWinnerId, payouts);
    if (shouldDealFromStage) {
      await startTableNewHand(tid, shouldDealFromStage);
    }
  }

  // Позиции 6 мест вокруг спила пня без перекрытий текста и борда
  const SEAT_COORDS = [
    { left: '50%', top: '88%' },
    { left: '14%', top: '69%' },
    { left: '14%', top: '28%' },
    { left: '50%', top: '10.5%' },
    { left: '86%', top: '28%' },
    { left: '86%', top: '69%' }
  ];

  function renderPokerTableView(body, tableId, isTournament = false) {
    document.getElementById('bgTitle').textContent = isTournament ? '🃏 Турнирный стол Холдема' : '🃏 Берёзовый Покер Холдем';
    const me = getMe();
    let currentTbl = null;
    let lastCtrlKey = '';
    let lastTopBarKey = '';
    let lastBoardDomSig = '';
    let currentHandSig = '';
    let lastLoggedStage = '';
    const dealtHoleKeys = new Set();
    const dealtBoardKeys = new Set();
    let dealPulseTimer = null;
    let woodSliceMode = localStorage.getItem('birch_stump_wood') === '1';
    let botLock = { key: '', ts: 0 };
    let watchdogBusy = false;

    body.innerHTML = `
      <div class="bg-poker-shell">
        <div class="bg-ptop" id="pokerTopBar"></div>
        <div id="pokerChatDrawerWrap"></div>
        <div class="bg-table-wrap${woodSliceMode ? ' wood-slice' : ''}" id="pokerTableWrap">
          <div class="bg-table${woodSliceMode ? ' wood-slice' : ''}" id="pokerTableSurface"></div>
          <div class="bg-center">
            <div class="bg-stump-slot" id="pokerStumpSlot" title="Щель раздачи пенька"></div>
            <div class="bg-pot" id="pokerPot">${stickSvg(true)} Банк: 0 🪵</div>
            <div class="bg-board" id="pokerBoard"></div>
            <div class="bg-stage" id="pokerStageTxt">ОЖИДАНИЕ</div>
          </div>
          <div id="pokerSeatsLayer"></div>
        </div>
        <div class="bg-actions" id="pokerControls"></div>
        <div class="bg-log" id="pokerLogs"></div>
      </div>
    `;

    const chatCtrl = createMiniChatController(
      body,
      '#pokerChatToggleBtn',
      '#pokerChatDrawerWrap',
      `poker_tables/${encodeURIComponent(tableId)}`
    );

    function scheduleBotMoveIfNeeded(tbl) {
      if (!tbl || !['preflop', 'flop', 'turn', 'river'].includes(tbl.stage)) return;
      const seats = tbl.seats || [];
      const turnSeat = seats[tbl.turnIdx];
      if (!turnSeat || !turnSeat.isBot || turnSeat.folded || turnSeat.busted || turnSeat.allIn) return;

      const stateKey = `${tbl.handId || 0}:${tbl.stage}:${tbl.turnIdx}:${tbl.currentBet}:${(tbl.board || []).length}:${tbl.pot}`;
      const now = Date.now();
      if (botLock.key === stateKey && now - botLock.ts < 2400) return;

      botLock = { key: stateKey, ts: now };
      const delay = 1000 + Math.floor(Math.random() * 380); // 1.0 - 1.38 сек (быстрый живой темп)
      setTimeout(async () => {
        if (!currentTbl || !['preflop', 'flop', 'turn', 'river'].includes(currentTbl.stage)) return;
        const liveSeat = (currentTbl.seats || [])[currentTbl.turnIdx];
        if (!liveSeat || !liveSeat.isBot) return;
        const decision = decideBotPokerAction(currentTbl, liveSeat);
        await applyPokerPlayerAction(tableId, liveSeat.id, decision.action, decision.raiseTo);
      }, delay);
    }

    // 60 FPS GPU-анимация вылета новых карт строго из щели пенька (.bg-stump-slot)
    function animatePendingCardsFromStump() {
      const pendingEls = body.querySelectorAll('.bg-card[data-deal-pending="1"]');
      if (!pendingEls.length) return;
      const slotEl = body.querySelector('#pokerStumpSlot');
      const slotRect = slotEl ? slotEl.getBoundingClientRect() : null;
      const slotCx = slotRect && slotRect.width > 0 ? (slotRect.left + slotRect.width / 2) : (window.innerWidth / 2);
      const slotCy = slotRect && slotRect.height > 0 ? (slotRect.top + slotRect.height / 2) : (window.innerHeight * 0.34);

      // Единый батч чтения геометрии до записи стилей (0 принудительных reflow во время анимации)
      const measurements = Array.from(pendingEls).map(el => {
        const r = el.getBoundingClientRect();
        return {
          el,
          dx: Math.round(slotCx - (r.left + r.width / 2)),
          dy: Math.round(slotCy - (r.top + r.height / 2))
        };
      });

      measurements.forEach((item, idx) => {
        const { el, dx, dy } = item;
        el.removeAttribute('data-deal-pending');
        el.style.setProperty('--deal-dx', `${dx}px`);
        el.style.setProperty('--deal-dy', `${dy}px`);
        el.style.setProperty('--deal-delay', `${idx * 105}ms`);
        el.classList.add('bg-dealing');
        el.addEventListener('animationend', () => {
          el.classList.remove('bg-dealing');
          el.style.removeProperty('--deal-dx');
          el.style.removeProperty('--deal-dy');
          el.style.removeProperty('--deal-delay');
        }, { once: true });
      });

      if (slotEl) {
        slotEl.classList.add('dealing');
        if (dealPulseTimer) clearTimeout(dealPulseTimer);
        dealPulseTimer = setTimeout(() => { slotEl.classList.remove('dealing'); }, measurements.length * 105 + 500);
      }
    }

    function drawTable(rawTbl) {
      if (!rawTbl) return;
      const tbl = normalizePokerTable({ ...rawTbl });
      currentTbl = tbl;
      _livePokerState = Object.assign({ tableId, isTournament }, tbl);

      chatCtrl.onSyncChat(tbl.chat);

      if (tbl.stage && tbl.stage !== lastLoggedStage) {
        pushTelemetryAction(`poker_stage:${lastLoggedStage || 'init'}->${tbl.stage}`);
        lastLoggedStage = tbl.stage;
      }

      const seats = tbl.seats;
      const mySeatIdx = seats.findIndex(s => String(s.id) === me.id);
      const lvl = Number(tbl.blindLevel) || 1;
      const bl = BLIND_LEVELS[Math.min(BLIND_LEVELS.length - 1, lvl - 1)];
      const isShowdownOrWaiting = tbl.stage === 'showdown' || tbl.stage === 'waiting' || tbl.stage === 'finished' || Boolean(tbl.winnerBanner);
      const isActiveHand = ['preflop', 'flop', 'turn', 'river'].includes(tbl.stage) && !isShowdownOrWaiting;
      const isDuel = String(tableId).startsWith('duel_');

      // Определяем сигнатуру текущей раздачи, чтобы анимировать вылет карт ровно при их появлении
      const hasAnyCards = seats.some(s => s.cards && s.cards.length > 0);
      if (tbl.stage === 'waiting' || !hasAnyCards) {
        currentHandSig = '';
        dealtHoleKeys.clear();
        dealtBoardKeys.clear();
      } else {
        const nextSig = `${tbl.handId || 0}:` + seats.map(s => `${s.id}:${(s.cards || []).join('')}`).join('|');
        if (nextSig !== currentHandSig) {
          currentHandSig = nextSig;
          dealtHoleKeys.clear();
          dealtBoardKeys.clear();
        }
      }

      const topBarKey = `${lvl}:${seats.filter(s => !s.busted).length}:${seats.length}:${isActiveHand ? 1 : 0}:${tbl.stage}:${seats.some(s => s.isBot) ? 1 : 0}:${woodSliceMode ? 1 : 0}`;
      if (topBarKey !== lastTopBarKey) {
        lastTopBarKey = topBarKey;
        body.querySelector('#pokerTopBar').innerHTML = `
          <span class="bg-chip gold">Блайнды ${fmt(bl.sb)}/${fmt(bl.bb)} 🪵</span>
          <span class="bg-chip">За столом: ${seats.filter(s => !s.busted).length}/${seats.length}</span>
          <div class="bg-row" style="gap:5px">
            <button class="bg-btn sm ghost" id="pokerChatToggleBtn">💬 Чат <span class="bg-chat-badge" hidden>0</span></button>
            <button class="bg-btn sm ghost" id="pokerSurfaceBtn" title="Сменить текстуру стола">${woodSliceMode ? '🌿 Сукно' : '🪵 Спил'}</button>
            ${!isActiveHand && tbl.stage !== 'finished' && seats.filter(s => !s.busted && s.stack > 0).length >= 2 ? `<button class="bg-btn sm green" id="pokerDealBtn">🃏 Раздать</button>` : ''}
            ${!isDuel && !isTournament && !seats.some(s => s.isBot) && seats.length < 6 ? `<button class="bg-btn sm wood" id="pokerAddBotBtn">🤖 +Бот</button>` : ''}
          </div>
        `;
        chatCtrl.bindToggle();
        const surfBtn = body.querySelector('#pokerSurfaceBtn');
        if (surfBtn) {
          surfBtn.onclick = () => {
            woodSliceMode = !woodSliceMode;
            try { localStorage.setItem('birch_stump_wood', woodSliceMode ? '1' : '0'); } catch (e) {}
            const tSurf = body.querySelector('#pokerTableSurface');
            const tWrap = body.querySelector('#pokerTableWrap');
            if (tSurf) tSurf.classList.toggle('wood-slice', woodSliceMode);
            if (tWrap) tWrap.classList.toggle('wood-slice', woodSliceMode);
            lastTopBarKey = '';
            drawTable(currentTbl);
          };
        }
        const dealBtn = body.querySelector('#pokerDealBtn');
        if (dealBtn) dealBtn.onclick = () => startTableNewHand(tableId, tbl.stage);
        const addBotBtn = body.querySelector('#pokerAddBotBtn');
        if (addBotBtn) addBotBtn.onclick = async () => { await seatBotAtPokerTable(tableId, 20000); await startTableNewHand(tableId, 'waiting'); };
      }

      body.querySelector('#pokerPot').innerHTML = `${stickSvg(true)} Банк: ${fmt(tbl.pot)} 🪵`;
      body.querySelector('#pokerStageTxt').textContent = tbl.winnerBanner || (STAGE_LABELS[tbl.stage] || String(tbl.stage || 'ОЖИДАНИЕ').toUpperCase());

      // Обновляем места игроков без пересоздания DOM-узлов карт, чтобы анимация раздачи шла 60 FPS без прерываний
      const seatsLayer = body.querySelector('#pokerSeatsLayer');
      while (seatsLayer.children.length > seats.length) {
        seatsLayer.removeChild(seatsLayer.lastElementChild);
      }

      seats.forEach((s, idx) => {
        let coordIdx;
        if (seats.length === 2) {
          const isHeroSlot = mySeatIdx >= 0 ? idx === mySeatIdx : idx === 0;
          coordIdx = isHeroSlot ? 0 : 3;
        } else {
          coordIdx = mySeatIdx >= 0 ? (idx - mySeatIdx + 6) % 6 : idx % 6;
        }
        const pos = SEAT_COORDS[coordIdx];
        const isTurn = isActiveHand && tbl.turnIdx === idx;
        const isMe = String(s.id) === me.id;
        const showCards = isMe || tbl.stage === 'showdown' || tbl.stage === 'finished';
        const remRatio = isTurn ? Math.max(0.05, Math.min(1, ((tbl.turnDeadline || 0) - Date.now()) / TURN_TIMEOUT_MS)) : 1;

        let seatEl = seatsLayer.children[idx];
        if (!seatEl) {
          seatEl = document.createElement('div');
          seatEl.innerHTML = `
            <div class="bg-scards"></div>
            <div class="bg-seat-box">
              <div class="bg-ava"></div>
              <div class="bg-sinfo">
                <div class="bg-sname"></div>
                <div class="bg-sstack"></div>
                <div class="bg-sstatus"></div>
              </div>
              <i class="bg-dealer" hidden>D</i>
            </div>
            <div class="bg-sbet-wrap" style="text-align:center"></div>
          `;
          seatsLayer.appendChild(seatEl);
        }

        const isShushikSeat = isPlayerShushikSkin(s.id, s.skin);
        seatEl.className = `bg-seat${isTurn ? ' turn' : ''}${isMe ? ' me' : ''}${isShushikSeat ? ' shushik-vip' : ''}${s.folded ? ' folded' : ''}${s.busted ? ' busted' : ''}`;
        seatEl.style.left = pos.left;
        seatEl.style.top = pos.top;
        seatEl.setAttribute('data-seatidx', String(idx));

        const cardsDomSig = `${currentHandSig}|${showCards ? 'open:' + s.cards.join(',') : 'back:' + s.cards.length}`;
        if (seatEl.getAttribute('data-cards-sig') !== cardsDomSig) {
          seatEl.setAttribute('data-cards-sig', cardsDomSig);
          const scardsEl = seatEl.querySelector('.bg-scards');
          scardsEl.innerHTML = s.cards.length
            ? s.cards.map((c, ci) => {
                const hKey = `${currentHandSig}:h:${s.id}:${ci}`;
                if (currentHandSig && !dealtHoleKeys.has(hKey)) {
                  dealtHoleKeys.add(hKey);
                  return cardHtml(showCards ? c : '??', false, false, '', 'data-deal-pending="1"');
                }
                if (showCards && !isMe) {
                  return cardHtml(c, false, false, 'bg-reveal');
                }
                return cardHtml(showCards ? c : '??');
              }).join('')
            : '';
        }

        const avaEl = seatEl.querySelector('.bg-ava');
        avaEl.style.setProperty('--p', remRatio.toFixed(2));
        const avaSig = `${s.photo ? 'img:' + s.photo : 'txt:' + (s.name || 'И')[0]}|sh:${isShushikSeat ? 1 : 0}`;
        if (avaEl.getAttribute('data-avasig') !== avaSig) {
          avaEl.setAttribute('data-avasig', avaSig);
          const starBadgeHtml = isShushikSeat
            ? `<img class="bg-ava-shushik-star" src="assets/skins/shushik_badge_star.png" alt="★">`
            : '';
          avaEl.innerHTML = (s.photo ? `<img src="${esc(s.photo)}" alt="">` : `<span>${esc((s.name || 'И')[0])}</span>`) + starBadgeHtml;
        }

        seatEl.querySelector('.bg-sname').textContent = s.name || '';
        const chipHtml = isShushikSeat
          ? `<img class="bg-shushik-chip-ico" src="assets/skins/shushik_token_chip.png" alt="●">`
          : stickSvg(false);
        seatEl.querySelector('.bg-sstack').innerHTML = `${chipHtml} ${fmt(s.stack)}`;
        seatEl.querySelector('.bg-sstatus').textContent = s.status || '';
        const dEl = seatEl.querySelector('.bg-dealer');
        if (dEl) dEl.hidden = tbl.dealerIdx !== idx;

        const betWrap = seatEl.querySelector('.bg-sbet-wrap');
        betWrap.innerHTML = s.bet > 0 ? `<div class="bg-sbet${isShushikSeat ? ' shushik-bet' : ''}">${chipHtml} ${fmt(s.bet)}</div>` : '';
      });

      // Обновляем общие карты борда (флоп, тёрн, ривер) только при изменении борда
      const boardEl = body.querySelector('#pokerBoard');
      const boardCards = tbl.board;
      const boardDomSig = `${currentHandSig}|${boardCards.join(',')}`;
      if (boardDomSig !== lastBoardDomSig) {
        lastBoardDomSig = boardDomSig;
        boardEl.innerHTML = [0, 1, 2, 3, 4].map(i => {
          const code = boardCards[i];
          if (!code) return `<span class="bg-card slot big"></span>`;
          const bKey = `${currentHandSig}:b:${i}:${code}`;
          const isNewBoardCard = Boolean(currentHandSig && !dealtBoardKeys.has(bKey));
          if (isNewBoardCard) dealtBoardKeys.add(bKey);
          return cardHtml(code, true, false, '', isNewBoardCard ? 'data-deal-pending="1"' : '');
        }).join('');
      }

      // Запускаем плавный вылет всех новых карт (карманных и общих) из щели пенька
      animatePendingCardsFromStump();

      // МГНОВЕННАЯ БЛОКИРОВКА КНОПОК ДЕЙСТВИЙ ПРИ SHOWDOWN / WAITING / WINNERBANNER (Блок 2 п. 4/2)
      const ctrl = body.querySelector('#pokerControls');
      const isMyTurn = !isShowdownOrWaiting && mySeatIdx >= 0 && isActiveHand && tbl.turnIdx === mySeatIdx;
      const mySeat = mySeatIdx >= 0 ? seats[mySeatIdx] : null;
      const ctrlKey = `${isMyTurn ? 1 : 0}:${isShowdownOrWaiting ? 1 : 0}:${mySeatIdx}:${tbl.stage}:${tbl.winnerBanner || ''}:${tbl.turnIdx}:${tbl.currentBet}:${mySeat ? mySeat.stack : 0}:${mySeat ? mySeat.bet : 0}:${seats.length}`;

      if (ctrlKey !== lastCtrlKey) {
        lastCtrlKey = ctrlKey;
        if (isMyTurn && mySeat) {
          const toCall = Math.max(0, tbl.currentBet - mySeat.bet);
          const maxRaise = mySeat.stack + mySeat.bet;
          const minRaise = Math.min(maxRaise, Math.max(tbl.currentBet * 2, tbl.currentBet + bl.bb, bl.bb * 2));
          const canRaise = mySeat.stack > toCall;
          ctrl.innerHTML = `
            <div class="bg-turnbar"><i id="pokerTurnFill" style="transform:scaleX(1)"></i></div>
            <div class="bg-act-grid">
              <button class="bg-btn red" id="actFold">🍂 Пас</button>
              <button class="bg-btn ghost" id="actCall">${toCall === 0 ? '🌿 Чек' : `🪵 Колл ${fmt(Math.min(mySeat.stack, toCall))}`}</button>
              <button class="bg-btn green" id="actRaise" ${canRaise ? '' : 'disabled'}>🪓 Рейз <span id="raiseValTxt">${fmt(minRaise)}</span></button>
              <button class="bg-btn wood" id="actAllIn">🔥 Ва-банк</button>
            </div>
            ${canRaise ? `<input type="range" class="bg-range" id="raiseSlider" min="${minRaise}" max="${maxRaise}" step="${Math.max(50, Math.floor(bl.sb / 2))}" value="${minRaise}">` : ''}
          `;
          const slider = ctrl.querySelector('#raiseSlider');
          const rTxt = ctrl.querySelector('#raiseValTxt');
          if (slider && rTxt) {
            slider.oninput = () => { rTxt.textContent = fmt(slider.value); };
          }
          const disableAllActBtns = () => {
            ctrl.querySelectorAll('button').forEach(b => { b.disabled = true; });
          };
          ctrl.querySelector('#actFold').onclick = () => { disableAllActBtns(); applyPokerPlayerAction(tableId, me.id, 'fold'); };
          ctrl.querySelector('#actCall').onclick = () => { disableAllActBtns(); applyPokerPlayerAction(tableId, me.id, toCall === 0 ? 'check' : 'call'); };
          const raiseBtn = ctrl.querySelector('#actRaise');
          if (raiseBtn && canRaise) {
            raiseBtn.onclick = () => { disableAllActBtns(); applyPokerPlayerAction(tableId, me.id, 'raise', slider ? Number(slider.value) : minRaise); };
          }
          ctrl.querySelector('#actAllIn').onclick = () => { disableAllActBtns(); applyPokerPlayerAction(tableId, me.id, 'raise', maxRaise); };
        } else if (mySeatIdx === -1 && tbl.stage !== 'finished') {
          ctrl.innerHTML = `<div class="bg-row"><button class="bg-btn green" id="sitHereBtn" style="width:100%">🪵 Сесть за стол (20 000 🪵)</button></div>`;
          ctrl.querySelector('#sitHereBtn').onclick = async () => {
            await seatPlayerAtPokerTable(tableId, tbl.title, isTournament, 20000, lvl);
            await startTableNewHand(tableId, tbl.stage);
          };
        } else if (tbl.stage === 'finished') {
          ctrl.innerHTML = `<div class="bg-result"><h3>🏆 ${esc(tbl.winnerBanner || 'Матч завершён!')}</h3></div>`;
        } else if (tbl.stage === 'showdown' || tbl.winnerBanner) {
          ctrl.innerHTML = `<div class="bg-muted" style="text-align:center;font-weight:700;color:var(--bg-gold)">${esc(tbl.winnerBanner || 'Подведение итогов раздачи...')}</div>`;
        } else if (tbl.stage === 'waiting') {
          const inviteBet = tbl.prizePool ? Math.round(tbl.prizePool / 2) : (mySeat ? mySeat.stack : 10000);
          ctrl.innerHTML = `
            <div style="display:flex;flex-direction:column;gap:8px;align-items:center">
              <div class="bg-muted" style="text-align:center">⏳ Ожидание второго игрока за столом...</div>
              <button class="bg-btn green" id="pokerInviteTgBtn" style="width:100%">📲 Пригласить друга в Telegram</button>
            </div>
          `;
          const invBtn = ctrl.querySelector('#pokerInviteTgBtn');
          if (invBtn) {
            invBtn.onclick = () => shareDuelInviteToTelegram(tableId, 'poker', inviteBet);
          }
        } else {
          const actor = seats[tbl.turnIdx];
          ctrl.innerHTML = `<div class="bg-muted" style="text-align:center">⏳ Ходит <b>${esc(actor ? actor.name : 'соперник')}</b>...</div>`;
        }
      }

      const logsEl = body.querySelector('#pokerLogs');
      logsEl.innerHTML = tbl.logs.slice(-8).map(l => `<div>${esc(l)}</div>`).join('');
      logsEl.scrollTop = logsEl.scrollHeight;

      scheduleBotMoveIfNeeded(tbl);
    }

    // Плавный GPU-таймер + 5-сек Watchdog против зависаний раздачи / бота
    _turnInterval = setInterval(async () => {
      if (!currentTbl) return;
      const now = Date.now();
      const idleMs = now - (Number(currentTbl.updatedAt) || 0);

      // Переход showdown -> preflop запускает ТОЛЬКО один ведущий клиент (первый активный игрок в seats[0])
      if (currentTbl.stage === 'showdown' && now > (currentTbl.turnDeadline || 0)) {
        if (isLeadingPokerClient(currentTbl, me.id) && !watchdogBusy) {
          watchdogBusy = true;
          try { await startTableNewHand(tableId, 'showdown'); } finally { watchdogBusy = false; }
        }
        return;
      }

      if (currentTbl.stage === 'waiting' && idleMs >= STUCK_WATCHDOG_MS) {
        const alive = (currentTbl.seats || []).filter(s => s.stack > 0 && !s.busted);
        if (alive.length >= 2 && isLeadingPokerClient(currentTbl, me.id) && !watchdogBusy) {
          watchdogBusy = true;
          try { await startTableNewHand(tableId, 'waiting'); } finally { watchdogBusy = false; }
        }
        return;
      }

      if (!['preflop', 'flop', 'turn', 'river'].includes(currentTbl.stage)) return;

      const rem = (currentTbl.turnDeadline || 0) - now;
      const ratio = Math.max(0, Math.min(1, rem / TURN_TIMEOUT_MS));
      const fill = body.querySelector('#pokerTurnFill');
      if (fill) fill.style.transform = `scaleX(${ratio.toFixed(3)})`;
      const turnAva = body.querySelector('.bg-seat.turn .bg-ava');
      if (turnAva) turnAva.style.setProperty('--p', ratio.toFixed(2));

      const seat = (currentTbl.seats || [])[currentTbl.turnIdx];
      if (seat && seat.isBot && !seat.folded && !seat.busted && !seat.allIn) {
        scheduleBotMoveIfNeeded(currentTbl);
        if (idleMs >= STUCK_WATCHDOG_MS && isLeadingPokerClient(currentTbl, me.id) && !watchdogBusy) {
          watchdogBusy = true;
          try {
            const dec = decideBotPokerAction(currentTbl, seat);
            await applyPokerPlayerAction(tableId, seat.id, dec.action, dec.raiseTo);
          } finally {
            watchdogBusy = false;
          }
          return;
        }
      }

      const seatInvalid = !seat || seat.folded || seat.busted || seat.allIn || seat.stack <= 0;
      if ((seatInvalid && idleMs >= STUCK_WATCHDOG_MS) && isLeadingPokerClient(currentTbl, me.id) && !watchdogBusy) {
        watchdogBusy = true;
        try { await recoverStuckPokerTable(tableId); } finally { watchdogBusy = false; }
        return;
      }

      // При истечении таймера хода (rem <= 0) делаем авто-фолд / авто-чек и увеличиваем missedTurns (при >= 2 авто-кик)
      const canTriggerTimeout = String(seat && seat.id) === String(me.id) || (isLeadingPokerClient(currentTbl, me.id) && rem <= -1200);
      if (rem <= 0 && seat && canTriggerTimeout && !watchdogBusy) {
        watchdogBusy = true;
        try {
          const toCall = Math.max(0, (currentTbl.currentBet || 0) - (seat.bet || 0));
          await applyPokerPlayerAction(tableId, seat.id, toCall === 0 ? 'check' : 'fold', 0, true);
        } finally {
          watchdogBusy = false;
        }
      }
    }, 350);

    _viewUnsubs.push(onValue(`poker_tables/${encodeURIComponent(tableId)}`, drawTable, 1000));
  }

  // ==================== 6. СИСТЕМА КЕЙСОВ, 3 УНИКАЛЬНЫХ СКИНА И АДМИН-СКИНЫ ====================
  const VIKA_UID = '1582574743';

  const AIROCHAI_SVG = `
    <svg viewBox="0 0 200 200" xmlns="http://www.w3.org/2000/svg">
      <defs>
        <radialGradient id="puerCake" cx="38%" cy="32%" r="72%">
          <stop offset="0%" stop-color="#5a351e"/>
          <stop offset="55%" stop-color="#2e180d"/>
          <stop offset="100%" stop-color="#140904"/>
        </radialGradient>
        <radialGradient id="neifeiPaper" cx="50%" cy="45%" r="55%">
          <stop offset="0%" stop-color="#fbf3df"/>
          <stop offset="100%" stop-color="#dfc89b"/>
        </radialGradient>
      </defs>
      <circle cx="100" cy="100" r="99" fill="url(#puerCake)" stroke="#7c4d2b" stroke-width="2"/>
      <!-- Текстура прессованного листа Шу Пуэра, патина и трещины -->
      <circle cx="100" cy="100" r="89" fill="none" stroke="#8d5b34" stroke-dasharray="9 6 3 5" stroke-width="2" opacity=".55"/>
      <circle cx="100" cy="100" r="76" fill="none" stroke="#120703" stroke-dasharray="14 8" stroke-width="2.4" opacity=".75"/>
      <path d="M18 82 L46 90 L60 85 M154 38 L136 62 L142 74 M148 156 L128 134 M42 154 L66 132 L61 121" fill="none" stroke="#0d0502" stroke-width="2.2" stroke-linecap="round"/>
      <path d="M20 83 L46 91 M155 39 L137 63 M43 155 L67 133" fill="none" stroke="#9e6b3b" stroke-width=".9" opacity=".55"/>
      <text x="100" y="29" text-anchor="middle" fill="#d7a86e" font-size="16" font-weight="900" opacity=".82">茶</text>
      <text x="100" y="183" text-anchor="middle" fill="#d7a86e" font-size="16" font-weight="900" opacity=".82">茶</text>
      <text x="24" y="106" text-anchor="middle" fill="#d7a86e" font-size="15" font-weight="900" opacity=".75">茶</text>
      <text x="176" y="106" text-anchor="middle" fill="#d7a86e" font-size="15" font-weight="900" opacity=".75">茶</text>
      <!-- Центральный светлый круг Нэйфэй -->
      <circle cx="100" cy="100" r="54" fill="url(#neifeiPaper)" stroke="#241208" stroke-width="3"/>
      <circle cx="100" cy="100" r="49" fill="none" stroke="#b71c1c" stroke-width="1.3" stroke-dasharray="4 2"/>
      <!-- Красное облако в чёрном контуре -->
      <path d="M77 95 C72 95,69 90,72 86 C73 80,81 78,86 81 C90 74,103 74,108 81 C114 78,122 81,123 87 C128 89,127 96,121 97 L78 97 Z"
            fill="#d51b1b" stroke="#111111" stroke-width="3" stroke-linejoin="round"/>
      <path d="M84 90 C89 86,98 86,104 90" fill="none" stroke="#ffe082" stroke-width="1.6" stroke-linecap="round"/>
      <text x="100" y="114" text-anchor="middle" font-family="Arial Black, sans-serif" font-weight="900" font-size="12.5" fill="#180c06" letter-spacing=".6">АЙРОЧАЙ</text>
      <text x="100" y="126" text-anchor="middle" font-family="Arial, sans-serif" font-weight="800" font-size="7.3" fill="#b71c1c" letter-spacing="1.1">HONG KONG TEA</text>
      <text x="100" y="141" text-anchor="middle" font-size="13" font-weight="900" fill="#2b1409">茶 • 普洱</text>
    </svg>`;

  const DENIS_SVG = `
    <svg viewBox="0 0 200 200" xmlns="http://www.w3.org/2000/svg">
      <defs>
        <radialGradient id="cinemaBase" cx="50%" cy="50%" r="65%">
          <stop offset="0%" stop-color="#232738"/>
          <stop offset="70%" stop-color="#11131d"/>
          <stop offset="100%" stop-color="#07080d"/>
        </radialGradient>
        <linearGradient id="clapStripes" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%" stop-color="#f5f5f5"/><stop offset="12%" stop-color="#f5f5f5"/>
          <stop offset="12.1%" stop-color="#141418"/><stop offset="25%" stop-color="#141418"/>
          <stop offset="25.1%" stop-color="#f5f5f5"/><stop offset="37%" stop-color="#f5f5f5"/>
          <stop offset="37.1%" stop-color="#141418"/><stop offset="50%" stop-color="#141418"/>
          <stop offset="50.1%" stop-color="#f5f5f5"/><stop offset="62%" stop-color="#f5f5f5"/>
          <stop offset="62.1%" stop-color="#141418"/><stop offset="75%" stop-color="#141418"/>
          <stop offset="75.1%" stop-color="#f5f5f5"/><stop offset="87%" stop-color="#f5f5f5"/>
          <stop offset="87.1%" stop-color="#141418"/><stop offset="100%" stop-color="#141418"/>
        </linearGradient>
        <clipPath id="topClapClip"><circle cx="100" cy="100" r="86"/></clipPath>
      </defs>
      <circle cx="100" cy="100" r="99" fill="url(#cinemaBase)" stroke="#3f4663" stroke-width="2.5"/>
      <!-- Перфорация киноплёнки по ободу -->
      <circle cx="100" cy="100" r="92" fill="none" stroke="#e2e8f0" stroke-width="7" stroke-dasharray="5 7" opacity=".78"/>
      <!-- Верхняя планка кинохлопушки с Ч/Б полосами -->
      <g clip-path="url(#topClapClip)">
        <rect x="12" y="12" width="176" height="36" fill="url(#clapStripes)"/>
        <line x1="12" y1="48" x2="188" y2="48" stroke="#ff1744" stroke-width="2.5"/>
      </g>
      <!-- Центральный портрет Дениса в тёмных очках + корона -->
      <circle cx="100" cy="102" r="46" fill="#181b2a" stroke="#ff1744" stroke-width="2.8"/>
      <path d="M84 56 L91 65 L100 53 L109 65 L116 56 L114 70 L86 70 Z" fill="#ffd740" stroke="#422c00" stroke-width="1.3"/>
      <path d="M80 86 C80 71,120 71,120 86 L118 93 L82 93 Z" fill="#2c1d14"/>
      <ellipse cx="100" cy="99" rx="19" ry="21" fill="#f1c29b"/>
      <path d="M72 141 C75 123,125 123,128 141" fill="#11131c" stroke="#7c4dff" stroke-width="1.8"/>
      <!-- Тёмные очки -->
      <rect x="81" y="90" width="16" height="10" rx="3" fill="#090a0f" stroke="#e0e7ff" stroke-width="1.3"/>
      <rect x="103" y="90" width="16" height="10" rx="3" fill="#090a0f" stroke="#e0e7ff" stroke-width="1.3"/>
      <line x1="97" y1="94" x2="103" y2="94" stroke="#e0e7ff" stroke-width="1.5"/>
      <line x1="84" y1="93" x2="92" y2="93" stroke="#7c4dff" stroke-width="1.4"/>
      <line x1="106" y1="93" x2="114" y2="93" stroke="#7c4dff" stroke-width="1.4"/>
      <path d="M94 110 Q100 114 106 110" fill="none" stroke="#6d3b24" stroke-width="2" stroke-linecap="round"/>
      <!-- Неоновая красная надпись -->
      <rect x="26" y="144" width="148" height="22" rx="6" fill="#0c0d16" stroke="#ff1744" stroke-width="1.8"/>
      <text x="100" y="159" text-anchor="middle" font-family="Arial Black, Impact, sans-serif" font-weight="900" font-size="11.2" fill="#ff2e55" letter-spacing=".5">ДЕНИС ЛЫКАСОВ</text>
      <text x="100" y="177" text-anchor="middle" font-family="monospace" font-weight="900" font-size="7.5" fill="#a29bfe">SCENE 67 • TAKE 1 • 4K</text>
    </svg>`;

  // Предзагрузка 5 текстур 3D-скина «Шушик» через new Image() для мгновенного отображения без мигания
  const SHUSHIK_TEXTURE_URLS = [
    'assets/skins/shushik_tap_cookie.png',
    'assets/skins/shushik_tap_cookie_sidewall.png',
    'assets/skins/shushik_tap_cookie_interlayer.png',
    'assets/skins/shushik_badge_star.png',
    'assets/skins/shushik_token_chip.png'
  ];
  const _shushikPreloadPool = SHUSHIK_TEXTURE_URLS.map(src => {
    const img = new Image();
    img.decoding = 'async';
    img.src = src;
    return img;
  });

  function isPlayerShushikSkin(uid, explicitSkin = '') {
    if (explicitSkin === 'shushik') return true;
    const idStr = String(uid || '');
    if (!idStr || idStr === 'birch_ai_bot') return false;
    if (idStr === getMe().id && (getLocalState().equippedSkin || '') === 'shushik') return true;
    const cachedPlayers = _memCache.get('players');
    const p = cachedPlayers && cachedPlayers.data && cachedPlayers.data[idStr];
    if (p && (p.skin === 'shushik' || p.equippedSkin === 'shushik')) return true;
    return false;
  }

  function shushikInlineBadgesHtml(uid, explicitSkin = '') {
    if (!isPlayerShushikSkin(uid, explicitSkin)) return '';
    return `<span class="bg-shushik-inline-badges" title="Эксклюзивный скин Шушик"><img class="bg-shushik-star-ico" src="assets/skins/shushik_badge_star.png" alt="★"><img class="bg-shushik-chip-ico" src="assets/skins/shushik_token_chip.png" alt="●"></span>`;
  }

  const SHUSHIK_SVG = `
    <div class="bg-shushik-case-preview">
      <img class="bg-shushik-case-cookie" src="assets/skins/shushik_tap_cookie.png" alt="Шушик">
      <img class="bg-shushik-case-star" src="assets/skins/shushik_badge_star.png" alt="★">
      <img class="bg-shushik-case-chip" src="assets/skins/shushik_token_chip.png" alt="●">
    </div>`;

  const SKINS = {
    airochai: {
      id: 'airochai',
      name: 'Айрочай (Шу Пуэр 茶)',
      icon: '🍵',
      rarity: 'Премиум',
      rarityCls: 'rarity-epic',
      mult: 4.5,
      marketPrice: 650000,
      wafer1: '#2e180d',
      wafer2: '#472816',
      cream1: '#d8be94',
      cream2: '#c41c1c',
      svgStop1: '#5a351e',
      svgStop2: '#140904',
      stroke: '#d32f2f',
      textFill: '#ffe082',
      glow: 'rgba(220,45,30,.55)',
      customSvg: AIROCHAI_SVG,
      desc: 'Прессованный блин Шу Пуэра с патиной, иероглифами 茶, красными фонариками и бамбуковой шкалой энергии.'
    },
    denis_lykasov: {
      id: 'denis_lykasov',
      name: 'Денис Лыкасов (Cinema)',
      icon: '🎬',
      rarity: 'Легендарный',
      rarityCls: 'rarity-legend',
      mult: 5.5,
      marketPrice: 1800000,
      wafer1: '#121420',
      wafer2: '#1f2336',
      cream1: '#7c3aed',
      cream2: '#ff1744',
      svgStop1: '#232738',
      svgStop2: '#07080d',
      stroke: '#ff1744',
      textFill: '#ff2e55',
      glow: 'rgba(124,58,237,.62)',
      customSvg: DENIS_SVG,
      desc: 'Кинохлопушка 35mm, портрет в тёмных очках с короной и таймлайн Adobe Premiere Pro RENDERING.'
    },
    shushik: {
      id: 'shushik',
      name: 'Шушик (Viii VIP Exclusive)',
      icon: '🌹',
      rarity: 'Мифический VIP',
      rarityCls: 'rarity-mythic',
      mult: 7.0,
      marketPrice: 7777777,
      wafer1: '#1c0c09',
      wafer2: '#2b120e',
      cream1: '#8B1A28',
      cream2: '#ED1C24',
      svgStop1: '#2b120e',
      svgStop2: '#120608',
      stroke: '#ED1C24',
      textFill: '#F0EAD6',
      glow: 'rgba(139, 26, 40, 0.55)',
      previewImg: 'assets/skins/shushik_tap_cookie.png',
      sidewallImg: 'assets/skins/shushik_tap_cookie_sidewall.png',
      interlayerImg: 'assets/skins/shushik_tap_cookie_interlayer.png',
      badgeImg: 'assets/skins/shushik_badge_star.png',
      chipImg: 'assets/skins/shushik_token_chip.png',
      customSvg: SHUSHIK_SVG,
      desc: 'Эксклюзивное объёмное 3D-печенье с барельефом кошачьей маски и розами, ребристым шоколадным ободом, рубиновой прослойкой, металлической звездой и личным жетоном игрока.'
    }
  };

  const SKIN_CASES = [
    {
      id: 'case_airochai',
      skinId: 'airochai',
      title: '🍵 Базовый Премиум-кейс «Айрочай»',
      subtitle: 'HONG KONG TEA • ШУ ПУЭР 茶',
      costCoins: 250000,
      costGems: 45,
      vipClass: ''
    },
    {
      id: 'case_denis',
      skinId: 'denis_lykasov',
      title: '🎬 Кино-кейс «Денис Лыкасов»',
      subtitle: 'PREMIERE PRO • DIRECTOR’S CUT',
      costCoins: 950000,
      costGems: 120,
      vipClass: ''
    },
    {
      id: 'case_shushik',
      skinId: 'shushik',
      title: '🌹 Легендарный VIP-кейс «Шушик»',
      subtitle: 'САМЫЙ ДОРОГОЙ И ЭКСКЛЮЗИВНЫЙ (Viii EDITION)',
      costCoins: 5000000,
      costGems: 350,
      vipClass: 'vip-shushik'
    }
  ];

  function registerExclusiveSkinsIntoMainGame() {
    const b = getBridge();
    if (b && b.SKINS) {
      Object.assign(b.SKINS, SKINS);
    }
    window.SKINS = Object.assign(window.SKINS || {}, SKINS);
  }

  function isExclusiveSkin(skinId) {
    return Boolean(SKINS[skinId]);
  }

  function getUnlockedSkinsMap() {
    const st = getLocalState();
    const map = Object.assign({}, st.unlocked_skins || {});
    Object.keys(SKINS).forEach(k => {
      if (st.inventory && st.inventory[k] > 0) map[k] = true;
    });
    return map;
  }

  function unlockSkinLocally(skinId, autoEquip = false) {
    if (!SKINS[skinId]) return;
    registerExclusiveSkinsIntoMainGame();
    const b = getBridge();
    const st = getLocalState();
    st.inventory = st.inventory || { classic: 1 };
    st.inventory[skinId] = Math.max(1, Number(st.inventory[skinId]) || 0);
    st.unlocked_skins = Object.assign({}, st.unlocked_skins || {}, { [skinId]: true });
    if (autoEquip) st.equippedSkin = skinId;
    if (b && b.applyExternalState) {
      b.applyExternalState(st);
      if (b.applySkinVisuals) b.applySkinVisuals();
    } else {
      localStorage.setItem('oreo-tap-save-v2', JSON.stringify(st));
    }
    applyExclusiveSkinTheme(st.equippedSkin);
  }

  async function syncUnlockedSkinsFromFirebase() {
    const me = getMe();
    if (!me.id) return;
    const [pUnlocked, uSkins] = await Promise.all([
      fbGet(`players/${encodeURIComponent(me.id)}/unlocked_skins`),
      fbGet(`user_skins/${encodeURIComponent(me.id)}`)
    ]);
    const combined = Object.assign({}, pUnlocked || {}, uSkins || {});
    let newlyAdded = false;
    const curMap = getUnlockedSkinsMap();
    for (const skId of Object.keys(SKINS)) {
      if (combined[skId] && !curMap[skId]) {
        unlockSkinLocally(skId, false);
        newlyAdded = true;
      }
    }
    if (newlyAdded) toast('✨ Эксклюзивный скин синхронизирован из облака!');
  }

  // Открытие кейса скинов с записью прав в players/{userId}/unlocked_skins и user_skins/{userId}
  async function openSkinCase(caseId, payWithGems = false) {
    const c = SKIN_CASES.find(x => x.id === caseId);
    if (!c) return false;
    const me = getMe();
    const sk = SKINS[c.skinId];
    const unlocked = getUnlockedSkinsMap();
    if (unlocked[c.skinId]) {
      equipExclusiveSkin(c.skinId);
      toast(`✨ Скин «${sk.name}» уже в коллекции и надет!`);
      return true;
    }

    if (payWithGems) {
      if (getGems() < c.costGems) {
        toast(`💎 Нужно ${fmt(c.costGems)} Алмазиков! У вас: ${fmt(getGems())}`);
        return false;
      }
      const nextG = getGems() - c.costGems;
      updateLocalWallet({ gems: nextG });
      await fbPatch(`players/${encodeURIComponent(me.id)}`, { gems: nextG, ts: Date.now() });
    } else {
      if (getCoins() < c.costCoins) {
        toast(`🪙 Нужно ${fmt(c.costCoins)} Коинов! У вас: ${fmt(getCoins())}`);
        return false;
      }
      const nextC = getCoins() - c.costCoins;
      updateLocalWallet({ coins: nextC });
      await fbPatch(`players/${encodeURIComponent(me.id)}`, { coins: nextC, taps: nextC, count: nextC, ts: Date.now() });
    }

    unlockSkinLocally(c.skinId, true);
    const now = Date.now();
    await fbPatch(`players/${encodeURIComponent(me.id)}/unlocked_skins`, { [c.skinId]: true });
    await fbPatch(`user_skins/${encodeURIComponent(me.id)}`, { [c.skinId]: true, updatedAt: now });
    toast(`🎉 Вы открыли и надели эксклюзивный скин «${sk.name}» (×${sk.mult})!`);
    if (_activeTab === 'skincases' && !_subView) {
      const body = document.getElementById('bgBody');
      if (body) renderSkinCasesTab(body);
    }
    return true;
  }

  function equipExclusiveSkin(skinId) {
    registerExclusiveSkinsIntoMainGame();
    const b = getBridge();
    const st = getLocalState();
    st.equippedSkin = skinId;
    if (b && b.applyExternalState) {
      b.applyExternalState(st);
      if (b.applySkinVisuals) b.applySkinVisuals();
    }
    applyExclusiveSkinTheme(skinId);
    const me = getMe();
    if (me && me.id) {
      fbPatch(`players/${encodeURIComponent(me.id)}`, { skin: skinId, ts: Date.now() }).catch(() => {});
    }
  }

  // Оптимизированный спавнер DOM-частиц с авто-очисткой по animationend (без утечек памяти)
  function spawnParticles(skinId, x, y) {
    if (!SKINS[skinId]) return;
    const frag = document.createDocumentFragment();

    if (skinId === 'denis_lykasov' || skinId === 'shushik') {
      const ring = document.createElement('div');
      ring.className = 'bg-tap-particle ' + (skinId === 'shushik' ? 'shushik-ring' : 'flash-ring');
      ring.style.setProperty('--x0', `${x}px`);
      ring.style.setProperty('--y0', `${y}px`);
      ring.addEventListener('animationend', () => ring.remove(), { once: true });
      frag.appendChild(ring);
    }

    const count = skinId === 'shushik' ? 10 : 8;
    const symbols = skinId === 'airochai'
      ? ['🍃', '🍂', '✨', '茶', '🍃', '✨']
      : skinId === 'denis_lykasov'
        ? ['[ ]', '|ll|', '🎞️', '⌜ ⌝', 'ılılı', '🎬']
        : ['🌹', '✦', '♥️', '🌹', '✧', '❤️‍🔥'];

    for (let i = 0; i < count; i++) {
      const el = document.createElement('div');
      const isCinemaTag = skinId === 'denis_lykasov' && (i % 2 === 0);
      el.className = 'bg-tap-particle' + (isCinemaTag ? ' cinema-tag' : '');
      if (skinId === 'shushik' && i === 0) {
        el.innerHTML = `<img src="assets/skins/shushik_badge_star.png" alt="" style="width:18px;height:18px;display:block">`;
      } else if (skinId === 'shushik' && i === 5) {
        el.innerHTML = `<img src="assets/skins/shushik_token_chip.png" alt="" style="width:17px;height:17px;display:block">`;
      } else {
        el.textContent = symbols[i % symbols.length];
      }

      // Для Шушика — красивый раскрывающийся веер вверх и в стороны
      const angle = skinId === 'shushik'
        ? (-Math.PI * 0.88 + (i / Math.max(1, count - 1)) * Math.PI * 0.76) + (Math.random() - 0.5) * 0.18
        : Math.random() * Math.PI * 2;
      const dist = 62 + Math.random() * 78;
      const dx = Math.round(Math.cos(angle) * dist);
      const dy = Math.round(Math.sin(angle) * dist - (skinId === 'shushik' ? 24 : 8));
      const rot = Math.round((Math.random() - 0.5) * 260);
      const dur = Math.round(620 + Math.random() * 280);

      el.style.fontSize = isCinemaTag ? '12px' : `${16 + Math.round(Math.random() * 8)}px`;
      el.style.setProperty('--x0', `${x - 8}px`);
      el.style.setProperty('--y0', `${y - 8}px`);
      el.style.setProperty('--dx', `${dx}px`);
      el.style.setProperty('--dy', `${dy}px`);
      el.style.setProperty('--rot', `${rot}deg`);
      el.style.setProperty('--dur', `${dur}ms`);
      el.style.setProperty('--sc', (0.9 + Math.random() * 0.45).toFixed(2));
      if (skinId === 'airochai' && el.textContent === '✨') {
        el.style.color = '#ffd54f';
        el.style.textShadow = '0 0 8px #ffb300';
      } else if (skinId === 'shushik') {
        const shPalette = ['#ED1C24', '#F0EAD6', '#8B1A28'];
        el.style.color = shPalette[i % shPalette.length];
        el.style.textShadow = '0 0 8px #ED1C24, 0 2px 6px #8B1A28';
        el.style.filter = 'drop-shadow(0 2px 6px rgba(139, 26, 40, 0.85))';
      }

      el.addEventListener('animationend', () => el.remove(), { once: true });
      frag.appendChild(el);
    }
    document.body.appendChild(frag);
  }

  // Мгновенная смена фона и класса шкалы энергии (#energy-bar / #energyHudBox)
  function ensureSkinBackdrop() {
    let bd = document.getElementById('birchSkinBackdrop');
    if (!bd) {
      bd = document.createElement('div');
      bd.id = 'birchSkinBackdrop';
      bd.className = 'theme-none';
      document.body.insertBefore(bd, document.body.firstChild);
    }
    return bd;
  }

  function applyExclusiveSkinTheme(skinId) {
    const bd = ensureSkinBackdrop();
    const eBar = document.getElementById('energy-bar') || document.querySelector('.energy-bar');
    const eBox = document.getElementById('energyHudBox');
    const themeClasses = ['skin-airochai', 'skin-denis_lykasov', 'skin-shushik'];

    if (eBar) themeClasses.forEach(c => eBar.classList.remove(c));
    if (eBox) themeClasses.forEach(c => eBox.classList.remove(c));

    if (!SKINS[skinId]) {
      bd.className = 'theme-none';
      bd.innerHTML = '';
      return;
    }

    if (eBar) eBar.classList.add(`skin-${skinId}`);
    if (eBox) eBox.classList.add(`skin-${skinId}`);
    bd.className = `theme-${skinId}`;

    if (skinId === 'airochai') {
      bd.innerHTML = `
        <div class="bg-lantern" style="left:7%;animation-delay:0s"></div>
        <div class="bg-lantern" style="left:24%;top:18px;transform:scale(.82);animation-delay:-1.2s"></div>
        <div class="bg-lantern" style="right:24%;top:18px;transform:scale(.82);animation-delay:-2.1s"></div>
        <div class="bg-lantern" style="right:7%;animation-delay:-.7s"></div>
      `;
    } else if (skinId === 'denis_lykasov') {
      bd.innerHTML = `
        <div class="bg-lens-bokeh" style="width:130px;height:130px;left:8%;top:18%"></div>
        <div class="bg-lens-bokeh" style="width:160px;height:160px;right:6%;top:24%;animation-delay:-2.4s"></div>
        <div class="bg-track-mark" style="left:12%;top:22%">+ TRK_01 [1920x1080]</div>
        <div class="bg-track-mark" style="right:10%;top:26%;animation-delay:-1.1s">+ CAM_A [ISO 800]</div>
        <div class="bg-track-mark" style="left:16%;bottom:24%;animation-delay:-1.9s">⌜ FOCUS LOCK ⌝</div>
        <div class="bg-track-mark" style="right:14%;bottom:22%;animation-delay:-.6s">|ll| AUDIO -3dB</div>
      `;
    } else if (skinId === 'shushik') {
      bd.innerHTML = `
        <div class="bg-candle-glow" style="width:120px;height:120px;left:6%;bottom:16%"></div>
        <div class="bg-candle-glow" style="width:150px;height:150px;right:6%;bottom:18%;animation-delay:-1.1s"></div>
        <div class="bg-candle-glow" style="width:110px;height:110px;left:42%;top:12%;animation-delay:-.6s"></div>
        <div class="bg-ambient-rose" style="left:11%;top:22%">🌹</div>
        <div class="bg-ambient-rose" style="right:12%;top:25%;animation-delay:-1.8s">🍷</div>
        <div class="bg-ambient-rose" style="left:15%;bottom:26%;animation-delay:-2.5s">🕯️</div>
        <div class="bg-ambient-rose" style="right:15%;bottom:28%;animation-delay:-.9s">🌹</div>
      `;
    }
  }

  function renderSkinCasesTab(body) {
    document.getElementById('bgTitle').textContent = '🎁 Эксклюзивные Кейсы Скинов';
    const unlocked = getUnlockedSkinsMap();
    const curEquipped = getLocalState().equippedSkin || 'classic';

    body.innerHTML = `
      <div class="bg-sec">
        <h3>✨ Лимитированная коллекция скинов ОРЕО67</h3>
        <p class="bg-muted">Каждый скин полностью меняет 3D-диск, эффекты разлёта частиц при тапе, живой фон арены и дизайн шкалы энергии!</p>
        <div class="bg-case-grid">
          ${SKIN_CASES.map(c => {
            const sk = SKINS[c.skinId];
            const isOwned = Boolean(unlocked[c.skinId]);
            const isEquipped = curEquipped === c.skinId;
            const isShushikCase = c.skinId === 'shushik';
            return `
              <div class="bg-case-card ${c.vipClass}">
                <div class="bg-case-preview">${sk.customSvg}</div>
                <div style="flex:1;min-width:0">
                  <div class="bg-row sp">
                    <b style="font-size:14px">${esc(c.title)}</b>
                    <span class="bg-chip gold">×${sk.mult} к тапу</span>
                  </div>
                  <div style="font-size:10px;color:#ffd9a0;font-weight:800;margin:2px 0">${esc(c.subtitle)}</div>
                  ${isShushikCase ? `
                    <div class="bg-row" style="gap:6px;margin:4px 0">
                      <span class="bg-chip" style="border-color:#ED1C24;color:#F0EAD6;background:rgba(139,26,40,.42)"><img class="bg-shushik-star-ico" src="assets/skins/shushik_badge_star.png" alt=""> Бейдж звезды</span>
                      <span class="bg-chip" style="border-color:#ED1C24;color:#F0EAD6;background:rgba(139,26,40,.42)"><img class="bg-shushik-chip-ico" src="assets/skins/shushik_token_chip.png" alt=""> Фишка за столами</span>
                    </div>
                  ` : ''}
                  <div class="bg-muted" style="margin-bottom:8px">${esc(sk.desc)}</div>
                  <div class="bg-row">
                    ${isOwned
                      ? `<button class="bg-btn sm ${isEquipped ? 'ghost' : 'green'}" data-eqskin="${c.skinId}">
                           ${isEquipped ? '✅ Скин активен' : '✨ Надеть скин'}
                         </button>`
                      : `
                         <button class="bg-btn sm" data-opencase="${c.id}:coins">🪙 Открыть за ${fmt(c.costCoins)}</button>
                         <button class="bg-btn sm wood" data-opencase="${c.id}:gems">💎 За ${fmt(c.costGems)}</button>
                        `
                    }
                  </div>
                </div>
              </div>
            `;
          }).join('')}
        </div>
      </div>
    `;

    body.querySelectorAll('[data-opencase]').forEach(btn => {
      btn.onclick = () => {
        const [cid, mode] = btn.getAttribute('data-opencase').split(':');
        openSkinCase(cid, mode === 'gems');
      };
    });
    body.querySelectorAll('[data-eqskin]').forEach(btn => {
      btn.onclick = () => {
        const sid = btn.getAttribute('data-eqskin');
        equipExclusiveSkin(sid);
        renderSkinCasesTab(body);
        toast(`✨ Активирован скин «${SKINS[sid].name}»!`);
      };
    });
  }

  // Вкладка «🎭 Управление скинами» в Веб-Админке (для MY_ADMIN_ID = 594228143)
  let _admSkinQuery = '';
  function renderAdminSkinsSub(sub) {
    sub.innerHTML = `
      <div class="bg-sec">
        <h3>⚡ Выдача в 1 клик (Павел и Viii)</h3>
        <div class="bg-row">
          <button class="bg-btn red" id="admGiveMeShushik">🌹 Выдать «Шушик» СЕБЕ (Павел)</button>
          <button class="bg-btn" id="admGiveVikaShushik">🌹 Выдать «Шушик» ВИКЕ (Viii)</button>
        </div>
      </div>
      <div class="bg-sec">
        <h3>🎭 Управление скинами всех игроков (players)</h3>
        <input class="bg-input" id="admSkinSearchInp" placeholder="Поиск по нику, @username или ID..." value="${esc(_admSkinQuery)}">
        <div id="admSkinsPlayersBox" style="margin-top:10px">Загрузка базы игроков...</div>
      </div>
    `;

    sub.querySelector('#admGiveMeShushik').onclick = () => adminGrantSkinToUser(MY_ADMIN_ID, 'shushik');
    sub.querySelector('#admGiveVikaShushik').onclick = () => adminGrantSkinToUser(VIKA_UID, 'shushik');

    let latest = {};
    const inp = sub.querySelector('#admSkinSearchInp');
    inp.oninput = () => { _admSkinQuery = inp.value.trim(); drawList(latest); };

    function drawList(data) {
      latest = data || {};
      const box = sub.querySelector('#admSkinsPlayersBox');
      if (!box) return;
      const arr = Object.entries(latest).map(([k, v]) => Object.assign({ id: k }, v || {}));
      arr.sort((a, b) => (Number(b.coins) || 0) - (Number(a.coins) || 0));
      const q = _admSkinQuery.toLowerCase().replace(/^@/, '');
      const list = q ? arr.filter(p =>
        String(p.name || '').toLowerCase().includes(q) ||
        String(p.id || '').toLowerCase().includes(q) ||
        String(p.username || '').toLowerCase().includes(q)
      ) : arr;

      box.innerHTML = list.slice(0, 25).map(p => {
        const uid = String(p.id);
        const ul = p.unlocked_skins || {};
        return `
          <div class="bg-item" style="flex-direction:column;align-items:stretch">
            <div class="bg-row sp">
              <b>👤 ${esc(p.name || uid)} ${p.username ? `<small>@${esc(p.username)}</small>` : ''} <small>(${esc(uid)})</small></b>
              <span class="bg-chip gold">🪙 ${fmt(p.coins || 0)}</span>
            </div>
            <div class="bg-row" style="margin-top:6px">
              <button class="bg-btn sm ${ul.shushik ? 'green' : 'red'}" data-gskin="${esc(uid)}:shushik">${ul.shushik ? '✅' : '🎁'} 🌹 Шушик</button>
              <button class="bg-btn sm ${ul.airochai ? 'green' : 'wood'}" data-gskin="${esc(uid)}:airochai">${ul.airochai ? '✅' : '🎁'} 🍵 Айрочай</button>
              <button class="bg-btn sm ${ul.denis_lykasov ? 'green' : 'ghost'}" data-gskin="${esc(uid)}:denis_lykasov">${ul.denis_lykasov ? '✅' : '🎁'} 🎬 Денис Лыкасов</button>
            </div>
          </div>
        `;
      }).join('') || '<div class="bg-muted">Игроки не найдены</div>';

      box.querySelectorAll('[data-gskin]').forEach(btn => {
        btn.onclick = () => {
          const [uid, sid] = btn.getAttribute('data-gskin').split(':');
          adminGrantSkinToUser(uid, sid);
        };
      });
    }

    _viewUnsubs.push(onValue('players', drawList, 2200));
  }

  async function adminGrantSkinToUser(uid, skinId) {
    const sk = SKINS[skinId];
    if (!sk) return;
    const now = Date.now();
    await fbPatch(`players/${encodeURIComponent(uid)}/unlocked_skins`, { [skinId]: true });
    await fbPatch(`user_skins/${encodeURIComponent(uid)}`, { [skinId]: true, updatedAt: now });
    await fbPut(`admin_grants/${encodeURIComponent(uid)}/${now}`, {
      resource: 'skin', skinId, mode: 'unlock', delta: 1, newValue: 1, ts: now, claimed: false
    });
    await fbPut(`skin_notifications/${now}_${encodeURIComponent(uid)}`, {
      userId: String(uid), skinId, sent: false, createdAt: now
    });
    if (String(uid) === getMe().id) unlockSkinLocally(skinId, true);
    toast(`🎭 Скин «${sk.name}» выдан игроку ${uid} + отправлен пуш в Telegram!`);
  }

  // ==================== 7. ПОСТОЯННЫЙ БАГ-РЕПОРТ, ЧЁРНЫЙ ЯЩИК (25 ДЕЙСТВИЙ) И TELEMETRY ====================
  const MAX_RECENT_ACTIONS = 25;
  const actionBreadcrumbLog = [];
  const _recentActions = actionBreadcrumbLog;
  const _capturedErrors = [];
  let _telemetryInitialized = false;
  let _crashBannerEl = null;
  let _bugFabEl = null;
  let _bugPopoverEl = null;
  let _selectedBugTag = '';
  let _pendingCrash = null;
  let _lastCapturedSig = '';
  let _lastCapturedTs = 0;
  let _lastBreadcrumbTs = 0;

  function formatLocalYmd(ts) {
    const d = new Date(Number(ts) || Date.now());
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${y}-${m}-${day}`;
  }

  function getCurrentActiveScreen() {
    const overlayOpen = Boolean(_overlay && _overlay.classList.contains('show'));
    if (overlayOpen) {
      if (_subView && _subView.type) {
        return `${_subView.type}:${_subView.id || 'session'}`;
      }
      return _activeTab || 'tournament';
    }
    const mainActive = document.querySelector('.nav-btn.active, .nav-item.active, .tab-btn.active, [data-screen].active');
    if (mainActive) {
      const label = (mainActive.getAttribute('data-tab') || mainActive.getAttribute('data-screen') || mainActive.textContent || '').trim().slice(0, 32);
      if (label) return `main:${label}`;
    }
    return 'main_clicker';
  }

  function pushTelemetryAction(actionLabel) {
    if (!actionLabel) return;
    const now = Date.now();
    const timeStr = new Date(now).toISOString().slice(11, 23);
    actionBreadcrumbLog.push({ ts: now, time: timeStr, action: String(actionLabel).slice(0, 140) });
    if (actionBreadcrumbLog.length > MAX_RECENT_ACTIONS) {
      actionBreadcrumbLog.shift();
    }
  }
  window.__oreoBlackBox = pushTelemetryAction;

  function recordCapturedErrorItem(message, stack, source) {
    const now = Date.now();
    const entry = {
      ts: now,
      time: new Date(now).toISOString().slice(11, 23),
      source: String(source || '').slice(0, 100),
      message: String(message || 'Error').slice(0, 400),
      stack: String(stack || message || '').slice(0, 2000)
    };
    _capturedErrors.push(entry);
    if (_capturedErrors.length > 20) _capturedErrors.shift();
    pushTelemetryAction(`err:${entry.message.slice(0, 85)}`);
    if (_bugFabEl) _bugFabEl.classList.add('has-error');
  }

  function collectGameStateSnapshot() {
    const me = getMe();
    const overlayOpen = Boolean(_overlay && _overlay.classList.contains('show'));
    const snap = {
      playerId: String(me.id || 'anon'),
      overlayOpen,
      activeScreen: getCurrentActiveScreen(),
      activeTab: _activeTab || 'tournament',
      subView: _subView ? { type: _subView.type, id: _subView.id, isTournament: Boolean(_subView.isTournament) } : null,
      wallet: {
        coins: getCoins(),
        gems: getGems(),
        sticks: getSticks(),
        choppedLogs: getChoppedLogs(),
        equippedSkin: getLocalState().equippedSkin || 'classic'
      }
    };

    const p = _livePokerState || ((_subView && _subView.type === 'poker' && _memCache.get(`poker_tables/${encodeURIComponent(_subView.id)}`)) || null);
    if (p && typeof p === 'object') {
      snap.poker = {
        tableId: p.tableId || p.id || (_subView && _subView.id) || '',
        stage: p.stage || 'unknown',
        blindLevel: p.blindLevel || 1,
        pot: Number(p.pot) || 0,
        currentBet: Number(p.currentBet) || 0,
        dealerIdx: Number(p.dealerIdx) || 0,
        turnIdx: Number(p.turnIdx) || 0,
        turnDeadlineRemMs: p.turnDeadline ? Math.round(Number(p.turnDeadline) - Date.now()) : 0,
        idleMs: p.updatedAt ? Math.round(Date.now() - Number(p.updatedAt)) : 0,
        board: toArr(p.board),
        winnerBanner: p.winnerBanner || '',
        seats: toArr(p.seats).map(s => ({
          id: s.id,
          name: s.name,
          isBot: Boolean(s.isBot),
          stack: s.stack,
          bet: s.bet,
          totalBet: s.totalBet,
          folded: Boolean(s.folded),
          allIn: Boolean(s.allIn),
          busted: Boolean(s.busted),
          acted: Boolean(s.acted),
          status: s.status || '',
          cardsCount: toArr(s.cards).length
        }))
      };
    }

    const c = _liveChessState || ((_subView && _subView.type === 'chess' && _memCache.get(`duel_matches/${encodeURIComponent(_subView.id)}`)) || null);
    if (c && typeof c === 'object') {
      snap.chess = {
        matchId: c.matchId || c.id || (_subView && _subView.id) || '',
        status: c.status || 'unknown',
        turn: c.turn || 'w',
        vsBot: Boolean(c.vsBot),
        pot: Number(c.pot) || 0,
        fen: c.fen || '',
        movesCount: toArr(c.history).length,
        lastFrom: c.lastFrom || '',
        lastTo: c.lastTo || '',
        wTime: c.wTime,
        bTime: c.bTime,
        idleMs: c.lastMoveTs ? Math.round(Date.now() - Number(c.lastMoveTs)) : 0,
        winner: c.winner || '',
        reason: c.reason || ''
      };
    }

    return snap;
  }

  function ensureBugReportWidget() {
    if (_bugFabEl && _bugPopoverEl) return;
    if (!document.body) return;

    const fab = document.createElement('button');
    fab.type = 'button';
    fab.className = 'bg-bug-fab';
    fab.id = 'bgBugFab';
    fab.title = 'Сообщить об ошибке или зависании';
    fab.innerHTML = `<span class="bg-bug-dot"></span><span>🐞 Баг</span>`;
    if (_capturedErrors.length > 0) fab.classList.add('has-error');

    const pop = document.createElement('div');
    pop.className = 'bg-bug-popover';
    pop.id = 'bgBugPopover';
    pop.innerHTML = `
      <div class="bg-bug-head">
        <b>🐞 Сообщить об ошибке</b>
        <button type="button" class="bg-bug-x" id="bgBugCloseBtn" aria-label="Закрыть">✕</button>
      </div>
      <div class="bg-bug-tags" id="bgBugTags">
        <button type="button" class="bg-bug-tag" data-bugtag="Зависла раздача">🃏 Зависла раздача</button>
        <button type="button" class="bg-bug-tag" data-bugtag="Тормозит бот">🤖 Тормозит бот</button>
        <button type="button" class="bg-bug-tag" data-bugtag="Съехал дизайн">🎨 Съехал дизайн</button>
      </div>
      <textarea class="bg-bug-note" id="bgBugNote" maxlength="320" placeholder="Короткий комментарий (по желанию)..."></textarea>
      <div class="bg-bug-meta" id="bgBugMeta">
        <span>Лог: 0/25 действий</span>
        <span>Снимок готов</span>
      </div>
      <button type="button" class="bg-bug-send" id="bgBugSendBtn">🚀 Отправить отчёт</button>
    `;

    document.body.appendChild(pop);
    document.body.appendChild(fab);
    _bugFabEl = fab;
    _bugPopoverEl = pop;

    const refreshBugMeta = () => {
      const meta = pop.querySelector('#bgBugMeta');
      if (!meta) return;
      const scr = getCurrentActiveScreen();
      meta.innerHTML = `<span>Лог: <b>${actionBreadcrumbLog.length}</b>/25 • Ошибок: <b>${_capturedErrors.length}</b></span><span>${esc(scr.slice(0, 22))}</span>`;
    };

    const closeBugPopover = () => {
      pop.classList.remove('show');
      fab.classList.remove('active');
    };

    fab.onclick = (e) => {
      e.stopPropagation();
      const willOpen = !pop.classList.contains('show');
      if (willOpen) {
        refreshBugMeta();
        pop.classList.add('show');
        fab.classList.add('active');
      } else {
        closeBugPopover();
      }
    };

    pop.querySelector('#bgBugCloseBtn').onclick = () => closeBugPopover();

    pop.querySelectorAll('[data-bugtag]').forEach(tBtn => {
      tBtn.onclick = () => {
        const tg = tBtn.getAttribute('data-bugtag') || '';
        _selectedBugTag = (_selectedBugTag === tg) ? '' : tg;
        pop.querySelectorAll('[data-bugtag]').forEach(b => {
          b.classList.toggle('active', b.getAttribute('data-bugtag') === _selectedBugTag);
        });
      };
    });

    document.addEventListener('click', (ev) => {
      if (!pop.classList.contains('show')) return;
      const target = ev.target;
      if (target && (pop.contains(target) || fab.contains(target))) return;
      closeBugPopover();
    }, { passive: true });

    pop.querySelector('#bgBugSendBtn').onclick = async () => {
      const sendBtn = pop.querySelector('#bgBugSendBtn');
      const noteEl = pop.querySelector('#bgBugNote');
      const comment = (noteEl && noteEl.value ? noteEl.value.trim() : '').slice(0, 320);
      const tag = _selectedBugTag || 'Без тега';
      const now = Date.now();
      const activeScreen = getCurrentActiveScreen();
      const gameState = collectGameStateSnapshot();
      const lastErr = _capturedErrors.length ? _capturedErrors[_capturedErrors.length - 1] : null;

      const summaryParts = [`[Баг-репорт: ${tag}]`];
      if (comment) summaryParts.push(comment);
      else if (lastErr) summaryParts.push(lastErr.message);
      else summaryParts.push(`Экран: ${activeScreen}`);

      const diagStackLines = [];
      if (comment) diagStackLines.push(`User Comment: ${comment}`);
      diagStackLines.push(`Tag: ${tag} | Screen: ${activeScreen}`);
      diagStackLines.push(`GameState Snapshot: ${JSON.stringify(gameState)}`);
      if (_capturedErrors.length) {
        diagStackLines.push(`Captured Errors (${_capturedErrors.length}):`);
        _capturedErrors.slice(-5).forEach((ce, idx) => {
          diagStackLines.push(`  #${idx + 1} [${ce.time}] (${ce.source}) ${ce.message}`);
          if (ce.stack && ce.stack !== ce.message) diagStackLines.push(`    ${ce.stack.split('\n').slice(0, 4).join(' | ')}`);
        });
      }

      sendBtn.disabled = true;
      sendBtn.textContent = '⏳ Упаковка и отправка...';
      try {
        await submitCrashReportToFirebase({
          reportType: 'manual_bug_report',
          tag,
          comment,
          activeTab: activeScreen,
          message: summaryParts.join(' '),
          stack: diagStackLines.join('\n'),
          source: 'bug_fab_widget',
          timestamp: now,
          gameState,
          actionBreadcrumbLog: [...actionBreadcrumbLog],
          recentActions: [...actionBreadcrumbLog],
          capturedErrors: [..._capturedErrors]
        });
        sendBtn.textContent = '✅ Отчёт отправлен!';
        fab.classList.remove('has-error');
        if (noteEl) noteEl.value = '';
        _selectedBugTag = '';
        pop.querySelectorAll('[data-bugtag]').forEach(b => b.classList.remove('active'));
        toast('✅ Отчёт и чёрный ящик (25 действий) отправлены админу!');
        setTimeout(() => {
          closeBugPopover();
          sendBtn.disabled = false;
          sendBtn.textContent = '🚀 Отправить отчёт';
        }, 750);
      } catch (err) {
        sendBtn.disabled = false;
        sendBtn.textContent = '🚀 Отправить отчёт';
        toast('⚠️ Ошибка сети при отправке репорта');
      }
    };
  }

  function ensureCrashBanner() {
    if (_crashBannerEl) return _crashBannerEl;
    if (!document.body) return null;
    const bar = document.createElement('div');
    bar.className = 'bg-crash-banner';
    bar.id = 'bgCrashBanner';
    bar.innerHTML = `
      <div class="bg-crash-meta">
        <b>⚠️ Обнаружен сбой в приложении</b>
        <small id="bgCrashShortMsg">Нажмите кнопку справа, чтобы отправить лог</small>
      </div>
      <button type="button" class="bg-crash-btn" id="bgCrashSendBtn">⚠️ Возникла ошибка</button>
      <button type="button" class="bg-crash-close" id="bgCrashCloseBtn" aria-label="Закрыть">✕</button>
    `;
    document.body.appendChild(bar);

    bar.querySelector('#bgCrashCloseBtn').onclick = () => {
      bar.classList.remove('show');
    };

    bar.querySelector('#bgCrashSendBtn').onclick = async () => {
      if (!_pendingCrash) {
        bar.classList.remove('show');
        return;
      }
      const sendBtn = bar.querySelector('#bgCrashSendBtn');
      sendBtn.disabled = true;
      sendBtn.textContent = '⏳ Отправка...';
      try {
        await submitCrashReportToFirebase(_pendingCrash);
        sendBtn.textContent = '✅ Лог отправлен';
        if (_bugFabEl) _bugFabEl.classList.remove('has-error');
        toast('✅ Отчёт об ошибке отправлен в систему телеметрии!');
        setTimeout(() => {
          bar.classList.remove('show');
          sendBtn.disabled = false;
          sendBtn.textContent = '⚠️ Возникла ошибка';
        }, 900);
      } catch (err) {
        sendBtn.disabled = false;
        sendBtn.textContent = '⚠️ Возникла ошибка';
        toast('⚠️ Не удалось отправить лог, проверьте сеть');
      }
    };

    _crashBannerEl = bar;
    return bar;
  }

  async function submitCrashReportToFirebase(crashData) {
    const me = getMe();
    const ts = Number(crashData.timestamp) || Date.now();
    const dateStr = formatLocalYmd(ts);
    const safeUid = String(me.id || 'anon').replace(/[.#$/[\]\s]/g, '_');
    const nodeKey = `${safeUid}_${ts}`;
    const breadcrumbs = Array.isArray(crashData.actionBreadcrumbLog)
      ? crashData.actionBreadcrumbLog
      : (Array.isArray(crashData.recentActions) ? crashData.recentActions : [...actionBreadcrumbLog]);
    const gameState = crashData.gameState || collectGameStateSnapshot();

    const payload = {
      id: nodeKey,
      reportType: String(crashData.reportType || 'auto_crash'),
      tag: String(crashData.tag || 'Авто-краш'),
      comment: String(crashData.comment || ''),
      userId: String(me.id || 'anon'),
      userName: String(me.name || 'Тапер'),
      username: String(me.username || ''),
      activeTab: String(crashData.activeTab || getCurrentActiveScreen()),
      message: String(crashData.message || 'Unknown Error').slice(0, 1000),
      stack: String(crashData.stack || 'No stack trace available').slice(0, 6500),
      source: String(crashData.source || ''),
      timestamp: ts,
      isoTime: new Date(ts).toISOString(),
      date: dateStr,
      gameState,
      actionBreadcrumbLog: breadcrumbs,
      recentActions: breadcrumbs,
      capturedErrors: Array.isArray(crashData.capturedErrors) ? crashData.capturedErrors : [..._capturedErrors],
      userAgent: String(navigator.userAgent || '').slice(0, 260)
    };
    await fbPut(`crash_reports/${encodeURIComponent(dateStr)}/${encodeURIComponent(nodeKey)}`, payload);
    return payload;
  }

  // Универсальная распаковка crash_reports/{date}/{userId}_{timestamp} + плоских старых записей
  function extractAllCrashReports(raw) {
    const out = [];
    if (!raw || typeof raw !== 'object') return out;
    for (const [k, v] of Object.entries(raw)) {
      if (!v || typeof v !== 'object') continue;
      const isDirectEntry = ('timestamp' in v) || ('userId' in v) || ('message' in v);
      if (isDirectEntry) {
        out.push({ id: k, ...v });
      } else {
        for (const [subKey, subVal] of Object.entries(v)) {
          if (subVal && typeof subVal === 'object') {
            out.push({ id: subKey, date: subVal.date || k, ...subVal });
          }
        }
      }
    }
    return out;
  }

  function handleCapturedError(message, stack, source) {
    const msgStr = String(message || '').trim();
    if (!msgStr) return;
    // Игнорируем штатную отмену устаревших fetch-запросов AbortController и шум ResizeObserver
    if (msgStr.includes('AbortError') || msgStr.includes('The user aborted a request') || msgStr.includes('ResizeObserver loop')) {
      return;
    }

    const now = Date.now();
    const sig = `${msgStr.slice(0, 120)}|${String(source || '').slice(0, 80)}`;
    if (sig === _lastCapturedSig && now - _lastCapturedTs < 2500) {
      return;
    }
    _lastCapturedSig = sig;
    _lastCapturedTs = now;

    recordCapturedErrorItem(msgStr, stack, source);

    _pendingCrash = {
      reportType: 'auto_crash',
      tag: 'Авто-краш',
      activeTab: getCurrentActiveScreen(),
      message: msgStr,
      stack: String(stack || msgStr),
      source: String(source || ''),
      timestamp: now,
      gameState: collectGameStateSnapshot(),
      actionBreadcrumbLog: [...actionBreadcrumbLog],
      recentActions: [...actionBreadcrumbLog],
      capturedErrors: [..._capturedErrors]
    };

    const showBanner = () => {
      const bar = ensureCrashBanner();
      if (!bar) return;
      const shortEl = bar.querySelector('#bgCrashShortMsg');
      const sendBtn = bar.querySelector('#bgCrashSendBtn');
      if (shortEl) shortEl.textContent = `${_pendingCrash.activeTab} • ${msgStr.slice(0, 90)}`;
      if (sendBtn) {
        sendBtn.disabled = false;
        sendBtn.textContent = '⚠️ Возникла ошибка';
      }
      bar.classList.add('show');
    };

    if (document.body) showBanner();
    else document.addEventListener('DOMContentLoaded', showBanner, { once: true });
  }

  function initTelemetrySystem() {
    if (_telemetryInitialized) return;
    _telemetryInitialized = true;

    window.addEventListener('error', (event) => {
      if (!event) return;
      const errObj = event.error;
      const msg = (errObj && errObj.message) || event.message || 'Runtime Script Error';
      const stack = (errObj && errObj.stack) || `${msg}\n    at ${event.filename || 'unknown'}:${event.lineno || 0}:${event.colno || 0}`;
      const src = `${event.filename || 'window.error'}:${event.lineno || 0}:${event.colno || 0}`;
      handleCapturedError(msg, stack, src);
    });

    const prevOnError = window.onerror;
    window.onerror = function (message, source, lineno, colno, error) {
      const msg = (error && error.message) || String(message || 'window.onerror');
      const stack = (error && error.stack) || `${msg}\n    at ${source || 'script'}:${lineno || 0}:${colno || 0}`;
      handleCapturedError(msg, stack, `${source || 'onerror'}:${lineno || 0}:${colno || 0}`);
      if (typeof prevOnError === 'function') {
        try { return prevOnError.apply(this, arguments); } catch (e) {}
      }
      return false;
    };

    window.addEventListener('unhandledrejection', (event) => {
      const reason = event ? event.reason : null;
      if (reason && (reason.name === 'AbortError' || String(reason.message || '').includes('AbortError'))) return;
      let msg = 'Unhandled Promise Rejection';
      let stack = '';
      if (reason instanceof Error) {
        msg = reason.message || msg;
        stack = reason.stack || msg;
      } else if (reason && typeof reason === 'object') {
        try { msg = reason.message || JSON.stringify(reason); } catch (e) { msg = String(reason); }
        stack = reason.stack || msg;
      } else if (reason !== undefined && reason !== null) {
        msg = String(reason);
        stack = msg;
      }
      handleCapturedError(msg, stack, 'unhandledrejection');
    });

    // Перехват console.error в чёрный ящик без рекурсии и без всплывающего баннера
    if (window.console && typeof window.console.error === 'function' && !window.console.error.__birchWrapped) {
      const origConsoleError = window.console.error.bind(window.console);
      let inConsoleCapture = false;
      const wrappedError = function (...args) {
        if (!inConsoleCapture) {
          inConsoleCapture = true;
          try {
            const msg = args.map(a => {
              if (a instanceof Error) return a.message || String(a);
              if (typeof a === 'object' && a !== null) {
                try { return JSON.stringify(a); } catch (e) { return String(a); }
              }
              return String(a);
            }).join(' ').trim();
            if (msg && !msg.includes('AbortError')) {
              const errArg = args.find(a => a instanceof Error);
              recordCapturedErrorItem(msg, (errArg && errArg.stack) || msg, 'console.error');
            }
          } catch (e) {} finally {
            inConsoleCapture = false;
          }
        }
        return origConsoleError(...args);
      };
      wrappedError.__birchWrapped = true;
      window.console.error = wrappedError;
    }

    // Невесомый пассивный сборщик действий (кольцевой буфер 25 шагов): игнорирует тапы по печеньке и сам виджет бага
    document.addEventListener('click', (e) => {
      const now = Date.now();
      if (now - _lastBreadcrumbTs < 140) return;
      const t = e.target;
      if (!t || typeof t.closest !== 'function') return;
      if (t.closest('#bgBugFab, #bgBugPopover')) return;
      const interactive = t.closest('#birchOverlay button, #birchOverlay [data-sq], #birchZoneBtn, #birchAdminBtn, .nav-btn, .nav-item, .tab-btn, .round-btn, .pill-btn');
      if (!interactive) return;
      _lastBreadcrumbTs = now;
      const sq = interactive.getAttribute('data-sq');
      if (sq) {
        pushTelemetryAction(`chess_sq:${sq}`);
        return;
      }
      const idPart = interactive.id ? `#${interactive.id}` : '';
      const txtPart = (interactive.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 36);
      pushTelemetryAction(`click${idPart}${txtPart ? `(${txtPart})` : ''}`);
    }, { passive: true, capture: true });
  }

  function getCrashItemYmd(item) {
    if (!item || typeof item !== 'object') return '';
    if (item.date && /^\d{4}-\d{2}-\d{2}$/.test(String(item.date))) return String(item.date);
    if (item.timestamp) return formatLocalYmd(item.timestamp);
    return '';
  }

  function doesCrashMatchDate(item, ymdFilter, fromYmd = '', toYmd = '') {
    if (!item || typeof item !== 'object') return false;
    const itemYmd = getCrashItemYmd(item);
    if (fromYmd || toYmd) {
      if (!itemYmd) return true;
      if (fromYmd && itemYmd < fromYmd) return false;
      if (toYmd && itemYmd > toYmd) return false;
      return true;
    }
    if (!ymdFilter || ymdFilter === 'all') return true;
    if (item.date === ymdFilter || itemYmd === ymdFilter) return true;
    if (item.timestamp) {
      const utcYmd = new Date(Number(item.timestamp)).toISOString().slice(0, 10);
      if (utcYmd === ymdFilter) return true;
    }
    return false;
  }

  function buildStructuredCrashReportTxt(items, dateLabel) {
    const sorted = [...items].sort((a, b) => (Number(a.timestamp) || 0) - (Number(b.timestamp) || 0));
    const uniqueUsers = new Map();
    const tabStats = {};
    const groupsMap = new Map();

    for (const r of sorted) {
      const uid = String(r.userId || 'unknown');
      const uname = r.userName ? `${r.userName}${r.username ? ' @' + r.username : ''}` : uid;
      uniqueUsers.set(uid, uname);

      const tab = String(r.activeTab || 'unknown');
      tabStats[tab] = (tabStats[tab] || 0) + 1;

      const msg = String(r.message || 'Unknown Error').trim();
      const firstStackLine = String(r.stack || '').split('\n').slice(0, 2).join(' | ').trim();
      const sigKey = `${msg} || ${tab}`;
      if (!groupsMap.has(sigKey)) {
        groupsMap.set(sigKey, {
          message: msg,
          activeTab: tab,
          sampleStack: String(r.stack || firstStackLine || '—'),
          count: 0,
          users: new Map(),
          firstTs: Number(r.timestamp) || 0,
          lastTs: Number(r.timestamp) || 0
        });
      }
      const g = groupsMap.get(sigKey);
      g.count += 1;
      g.users.set(uid, uname);
      const ts = Number(r.timestamp) || 0;
      if (ts && (!g.firstTs || ts < g.firstTs)) g.firstTs = ts;
      if (ts && ts > g.lastTs) g.lastTs = ts;
    }

    const groups = [...groupsMap.values()].sort((a, b) => b.count - a.count);
    const lines = [];
    lines.push('================================================================================');
    lines.push(`OREO67 — CRASH TELEMETRY & BUG DIAGNOSTIC REPORT (${dateLabel})`);
    lines.push(`Generated At : ${new Date().toISOString()}`);
    lines.push('Format       : Human-Readable & AI-Agent Structured Log v2.0 (25-Action BlackBox)');
    lines.push('================================================================================');
    lines.push('');
    lines.push('[SECTION 1: EXECUTIVE SUMMARY]');
    lines.push(`- Filter Period          : ${dateLabel}`);
    lines.push(`- Total Reports / Events : ${sorted.length}`);
    lines.push(`- Unique Issue Groups    : ${groups.length}`);
    lines.push(`- Affected Users Count   : ${uniqueUsers.size}`);
    if (uniqueUsers.size > 0) {
      const uList = [...uniqueUsers.entries()].map(([id, nm]) => `${id} (${nm})`).join(', ');
      lines.push(`- Affected Users List    : ${uList}`);
    }
    const tabSummary = Object.entries(tabStats).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k}: ${v}`).join(' | ');
    lines.push(`- Breakdown by Screen    : ${tabSummary || 'none'}`);
    lines.push('');

    lines.push('[SECTION 2: AGGREGATED ERROR & BUG SIGNATURES (RANKED BY FREQUENCY)]');
    if (!groups.length) {
      lines.push('No crashes or bug reports recorded for the selected period.');
    } else {
      groups.forEach((g, idx) => {
        const usersStr = [...g.users.entries()].map(([id, nm]) => `${id} (${nm})`).join(', ');
        lines.push('--------------------------------------------------------------------------------');
        lines.push(`GROUP #${idx + 1} | Occurrences: ${g.count}x | Affected Users (${g.users.size}): ${usersStr}`);
        lines.push(`Screen / Mini-Game : ${g.activeTab}`);
        lines.push(`First Seen         : ${g.firstTs ? new Date(g.firstTs).toISOString() : '—'}`);
        lines.push(`Last Seen          : ${g.lastTs ? new Date(g.lastTs).toISOString() : '—'}`);
        lines.push(`Message / Summary  : ${g.message}`);
        lines.push('Primary Diagnostic / Stack:');
        String(g.sampleStack || '—').split('\n').slice(0, 8).forEach(sl => lines.push(`  ${sl}`));
      });
    }
    lines.push('');

    lines.push('[SECTION 3: CHRONOLOGICAL EVENTS, GAME STATE SNAPSHOTS & 25-STEP BLACKBOX]');
    sorted.forEach((r, idx) => {
      lines.push('--------------------------------------------------------------------------------');
      lines.push(`EVENT #${idx + 1} | Key: ${r.id || 'n/a'} | Type: ${r.reportType || 'auto_crash'}`);
      lines.push(`Timestamp   : ${r.isoTime || (r.timestamp ? new Date(Number(r.timestamp)).toISOString() : 'n/a')} (${r.timestamp || 0})`);
      lines.push(`Player      : ID=${r.userId || 'anon'} | Name=${r.userName || '—'}${r.username ? ' (@' + r.username + ')' : ''}`);
      lines.push(`ActiveTab   : ${r.activeTab || 'unknown'}`);
      if (r.tag) lines.push(`Bug Tag     : ${r.tag}`);
      if (r.comment) lines.push(`User Comment: ${r.comment}`);
      if (r.source) lines.push(`Source      : ${r.source}`);
      if (r.userAgent) lines.push(`UserAgent   : ${r.userAgent}`);
      lines.push(`Message     : ${r.message || '—'}`);
      if (r.gameState) {
        try { lines.push(`GameState   : ${JSON.stringify(r.gameState)}`); } catch (e) {}
      }
      lines.push('Stack / Details:');
      String(r.stack || '—').split('\n').forEach(sl => lines.push(`  ${sl}`));

      const capErrs = toArr(r.capturedErrors);
      if (capErrs.length) {
        lines.push(`Captured Session Errors (${capErrs.length}):`);
        capErrs.forEach((ce, ci) => {
          lines.push(`  ${ci + 1}. [${ce.time || ce.ts || ''}] (${ce.source || 'err'}) ${ce.message || ''}`);
        });
      }

      const acts = toArr(r.actionBreadcrumbLog || r.recentActions);
      lines.push(`Action Breadcrumb Log (${acts.length}):`);
      if (!acts.length) {
        lines.push('  (no recorded actions prior to report)');
      } else {
        acts.forEach((a, ai) => {
          lines.push(`  ${ai + 1}. [${a.time || a.ts || ''}] ${a.action || JSON.stringify(a)}`);
        });
      }
    });
    lines.push('================================================================================');
    return lines.join('\n');
  }

  function downloadTextFile(filename, textContent) {
    const blob = new Blob([textContent], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.style.display = 'none';
    document.body.appendChild(a);
    a.click();
    setTimeout(() => {
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    }, 1500);
  }

  let _admCrashDate = formatLocalYmd(Date.now());
  let _admCrashDateFrom = '';
  let _admCrashDateTo = '';
  let _admCrashAllDates = true;

  // Одноразовая авто-очистка старых отработанных логов за 03.11–06.11 при старте патча (Блок 6 п. 16)
  async function cleanupLegacyCrashLogsOnce() {
    const MIGRATION_KEY = 'oreo_crash_logs_cleared_v20261106_patch';
    try {
      if (localStorage.getItem(MIGRATION_KEY) === '1') return;
      localStorage.setItem(MIGRATION_KEY, '1');
    } catch (e) {}
    try {
      const meta = await fbGet('telemetry_meta/cleared_v20261106_patch');
      if (meta && meta.cleared) return;
      // Удаляем отработанные отчёты 03.11 - 06.11, чтобы статистика собиралась с чистого листа
      await Promise.all([
        fbDelete('crash_reports/2026-11-03'),
        fbDelete('crash_reports/2026-11-04'),
        fbDelete('crash_reports/2026-11-05'),
        fbDelete('crash_reports/2026-11-06'),
        fbPut('telemetry_meta/cleared_v20261106_patch', { cleared: true, clearedAt: Date.now() })
      ]);
      _memCache.delete('crash_reports');
    } catch (e) {}
  }

  function computePeriodLabelFromReports(items, fallbackLabel = 'ALL') {
    if (!items || !items.length) return fallbackLabel;
    const dates = items.map(getCrashItemYmd).filter(Boolean).sort();
    if (!dates.length) return fallbackLabel;
    const first = dates[0];
    const last = dates[dates.length - 1];
    return first === last ? first : `${first}_to_${last}`;
  }

  function renderAdminCrashesSub(sub) {
    sub.innerHTML = `
      <div class="bg-sec">
        <h3>🧯 Телеметрия, баг-репорты и сводная выгрузка (.txt)</h3>
        <div class="bg-row" style="margin-bottom:8px;gap:6px">
          <button class="bg-btn green" id="admCrashDownloadAllUnifiedBtn" style="flex:1">📥 Скачать ВСЕ активные логи (Единый отчет за период)</button>
          <button class="bg-btn red" id="admCrashClearAllBtn">🗑 Обнулить текущие краш-логи</button>
        </div>
        <div class="bg-item" style="flex-direction:column;align-items:stretch;gap:6px;margin-bottom:8px">
          <div class="bg-row sp">
            <small>📅 Фильтр по периоду («От даты» — «До даты») в один сводный файл:</small>
            <button class="bg-btn sm ${_admCrashAllDates && !_admCrashDateFrom && !_admCrashDateTo ? 'green' : 'ghost'}" id="admCrashToggleAll">
              ${_admCrashAllDates && !_admCrashDateFrom && !_admCrashDateTo ? '✅ Показаны: ВСЕ дни' : 'Показать ВСЕ дни'}
            </button>
          </div>
          <div class="bg-row" style="gap:6px;flex-wrap:wrap">
            <label style="font-size:11px;color:#ffd9a0">От: <input type="date" class="bg-input" id="admCrashDateFromInp" value="${esc(_admCrashDateFrom)}" style="max-width:142px;padding:4px 6px"></label>
            <label style="font-size:11px;color:#ffd9a0">До: <input type="date" class="bg-input" id="admCrashDateToInp" value="${esc(_admCrashDateTo)}" style="max-width:142px;padding:4px 6px"></label>
            <button class="bg-btn sm wood" id="admCrashApplyRangeBtn">🔍 Применить диапазон</button>
            <button class="bg-btn sm green" id="admCrashDownloadFilteredBtn">📥 Скачать выборку (.txt)</button>
            <button class="bg-btn sm ghost" id="admCrashCopyBtn">📋 Копировать</button>
            <button class="bg-btn sm ghost" id="admCrashTestBtn">🧪 Тест</button>
          </div>
        </div>
        <div id="admCrashStats" class="bg-muted" style="margin-bottom:8px">Загрузка узла crash_reports из Firebase...</div>
        <div id="admCrashList"></div>
      </div>
    `;

    let allReportsInDb = [];
    let latestReports = [];

    const fromInp = sub.querySelector('#admCrashDateFromInp');
    const toInp = sub.querySelector('#admCrashDateToInp');

    sub.querySelector('#admCrashApplyRangeBtn').onclick = () => {
      _admCrashDateFrom = (fromInp && fromInp.value) || '';
      _admCrashDateTo = (toInp && toInp.value) || '';
      _admCrashAllDates = !(_admCrashDateFrom || _admCrashDateTo);
      renderAdminCrashesSub(sub);
    };

    sub.querySelector('#admCrashToggleAll').onclick = () => {
      _admCrashDateFrom = '';
      _admCrashDateTo = '';
      _admCrashAllDates = true;
      renderAdminCrashesSub(sub);
    };

    sub.querySelector('#admCrashTestBtn').onclick = () => {
      handleCapturedError(
        'Test Crash Telemetry: проверка плашки сбора ошибок',
        'Error: Test Crash Telemetry\n    at renderAdminCrashesSub (birch_games.js)',
        'admin_manual_test'
      );
    };

    // Главная кнопка: Скачать ВСЕ активные логи за весь период одним общим файлом
    sub.querySelector('#admCrashDownloadAllUnifiedBtn').onclick = () => {
      const sourceArr = allReportsInDb.length ? allReportsInDb : latestReports;
      const periodLabel = computePeriodLabelFromReports(sourceArr, formatLocalYmd(Date.now()));
      const txt = buildStructuredCrashReportTxt(sourceArr, `ALL ACTIVE LOGS: ${periodLabel}`);
      downloadTextFile(`crashes_unified_${periodLabel}.txt`, txt);
      toast(`📥 Единый отчёт crashes_unified_${periodLabel}.txt скачан (${sourceArr.length} событий)!`);
    };

    sub.querySelector('#admCrashDownloadFilteredBtn').onclick = () => {
      const rangeLabel = (_admCrashDateFrom || _admCrashDateTo)
        ? `${_admCrashDateFrom || 'start'}_to_${_admCrashDateTo || 'now'}`
        : computePeriodLabelFromReports(latestReports, _admCrashAllDates ? 'all' : _admCrashDate);
      const txt = buildStructuredCrashReportTxt(latestReports, rangeLabel);
      downloadTextFile(`crashes_${rangeLabel}.txt`, txt);
      toast(`📥 Файл crashes_${rangeLabel}.txt сформирован (${latestReports.length} записей)`);
    };

    sub.querySelector('#admCrashCopyBtn').onclick = async () => {
      const rangeLabel = (_admCrashDateFrom || _admCrashDateTo)
        ? `${_admCrashDateFrom || 'start'}_to_${_admCrashDateTo || 'now'}`
        : computePeriodLabelFromReports(latestReports, 'all');
      const txt = buildStructuredCrashReportTxt(latestReports, rangeLabel);
      try {
        await navigator.clipboard.writeText(txt);
        toast('📋 Единый структурированный отчёт скопирован в буфер обмена!');
      } catch (e) {
        toast('⚠️ Буфер обмена недоступен — используйте скачивание .txt');
      }
    };

    // Кнопка полного обнуления текущих краш-логов в Firebase и локальном кэше
    sub.querySelector('#admCrashClearAllBtn').onclick = async () => {
      const btn = sub.querySelector('#admCrashClearAllBtn');
      if (btn) {
        btn.disabled = true;
        btn.textContent = '⏳ Очистка...';
      }
      try {
        await fbDelete('crash_reports');
        _memCache.delete('crash_reports');
        _capturedErrors.length = 0;
        if (_bugFabEl) _bugFabEl.classList.remove('has-error');
        allReportsInDb = [];
        latestReports = [];
        drawCrashes({});
        toast('🧹 Все краш-логи в Firebase и локальном кэше полностью обнулены!');
      } catch (err) {
        toast('⚠️ Ошибка при очистке краш-логов');
      } finally {
        if (btn) {
          btn.disabled = false;
          btn.textContent = '🗑 Обнулить текущие краш-логи';
        }
      }
    };

    function drawCrashes(raw) {
      const statsEl = sub.querySelector('#admCrashStats');
      const listEl = sub.querySelector('#admCrashList');
      if (!statsEl || !listEl) return;

      allReportsInDb = extractAllCrashReports(raw);
      allReportsInDb.sort((a, b) => (Number(b.timestamp) || 0) - (Number(a.timestamp) || 0));

      if (_admCrashDateFrom || _admCrashDateTo) {
        latestReports = allReportsInDb.filter(r => doesCrashMatchDate(r, 'range', _admCrashDateFrom, _admCrashDateTo));
      } else {
        const filterKey = _admCrashAllDates ? 'all' : _admCrashDate;
        latestReports = allReportsInDb.filter(r => doesCrashMatchDate(r, filterKey));
      }

      const periodStr = computePeriodLabelFromReports(allReportsInDb, 'нет данных').replace('_to_', ' — ');
      const usersSet = new Set(latestReports.map(r => String(r.userId || 'anon')));
      statsEl.innerHTML = `В выборке: <b style="color:var(--bg-gold)">${latestReports.length}</b> (всего в БД: <b>${allReportsInDb.length}</b> • период БД: <b>${esc(periodStr)}</b>) • Затронуто игроков: <b>${usersSet.size}</b>`;

      if (!latestReports.length) {
        listEl.innerHTML = `<div class="bg-muted">✨ Активных ошибок и баг-репортов нет (база чиста).</div>`;
        return;
      }

      // Группируем по тексту ошибки/тегу + экрану для наглядности частоты
      const grouped = new Map();
      for (const r of latestReports) {
        const k = `${r.activeTab || '?'}::${r.message || '?'}`;
        if (!grouped.has(k)) grouped.set(k, { sample: r, count: 0, users: new Set() });
        const g = grouped.get(k);
        g.count += 1;
        g.users.add(String(r.userId || 'anon'));
      }

      listEl.innerHTML = [...grouped.values()].sort((a, b) => b.count - a.count).slice(0, 25).map(g => {
        const r = g.sample;
        const timeStr = r.isoTime ? r.isoTime.replace('T', ' ').slice(0, 19) : '';
        return `
          <div class="bg-card-row" style="margin-bottom:8px">
            <div class="bg-row sp">
              <span class="bg-chip gold">Повторов: ${g.count}× • Игроков: ${g.users.size}</span>
              <span class="bg-chip">${esc(r.activeTab || 'unknown')}</span>
            </div>
            ${r.tag ? `<div style="margin-top:5px"><span class="bg-chip green">🏷 ${esc(r.tag)}</span></div>` : ''}
            <div style="font-weight:800;font-size:12.5px;margin-top:6px;color:#ff99ac">${esc(r.message || 'Ошибка')}</div>
            <div class="bg-muted" style="font-size:11px;margin-top:2px">Последний: ID ${esc(r.userId)} (${esc(r.userName || '—')}) • ${esc(timeStr)}</div>
            <div class="bg-crash-pre">${esc(String(r.stack || '').slice(0, 600))}</div>
          </div>
        `;
      }).join('');
    }

    _viewUnsubs.push(onValue('crash_reports', drawCrashes, 2500));
  }

  // Запускаем перехватчик ошибок сразу при загрузке скрипта
  initTelemetrySystem();

  // ---------- АВТО-ИНИЦИАЛИЗАЦИЯ И ПЕРЕХВАТ DEEP-LINKS ----------
  function initBirchGames() {
    initTelemetrySystem();
    ensureBugReportWidget();
    registerExclusiveSkinsIntoMainGame();
    applyExclusiveSkinTheme(getLocalState().equippedSkin || 'classic');
    cleanupLegacyCrashLogsOnce();

    const zoneBtn = document.getElementById('birchZoneBtn');
    const admBtn = document.getElementById('birchAdminBtn');
    if (zoneBtn) zoneBtn.onclick = () => openZone('tournament');
    if (admBtn) {
      admBtn.hidden = !isAdminUser();
      admBtn.onclick = () => openZone('admin');
    }

    syncAdminGrantsForMe();
    syncUnlockedSkinsFromFirebase();
    setInterval(syncAdminGrantsForMe, 4500);

    const params = new URLSearchParams(location.search);
    const duelId = params.get('duel');
    const gameParam = params.get('game');
    const modeParam = params.get('mode');
    const tourParam = params.get('tournament') || params.get('table');
    const equipSkinParam = params.get('equip_skin');

    if (equipSkinParam && SKINS[equipSkinParam]) {
      unlockSkinLocally(equipSkinParam, true);
    }

    if (duelId) {
      openZone('duels');
      setTimeout(() => acceptEscrowDuelChallenge(duelId), 600);
    } else if (modeParam === 'poker_tournament' || tourParam) {
      openZone('tournament');
    } else if (gameParam === 'chess' || gameParam === 'poker') {
      openZone('duels');
    }
  }

  window.BirchGames = {
    SKINS,
    SKIN_CASES,
    openZone,
    closeZone,
    openSkinCase,
    spawnParticles,
    isExclusiveSkin,
    onSkinChanged: applyExclusiveSkinTheme,
    syncAdminGrantsForMe,
    reportCrash: handleCapturedError,
    getBreadcrumbs: () => [...actionBreadcrumbLog],
    exportCrashesTxt: async (ymd = 'all') => {
      const raw = await fbGet('crash_reports');
      const arr = extractAllCrashReports(raw);
      const filtered = ymd === 'all' ? arr : arr.filter(r => doesCrashMatchDate(r, ymd));
      const periodLabel = ymd === 'all' ? computePeriodLabelFromReports(filtered, 'all') : ymd;
      const txt = buildStructuredCrashReportTxt(filtered, periodLabel);
      downloadTextFile(`crashes_${periodLabel}.txt`, txt);
      return txt;
    }
  };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', initBirchGames);
  else initBirchGames();
})();
