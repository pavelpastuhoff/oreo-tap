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
    if (patch.coins !== undefined) st.coins = Math.max(0, Math.round(patch.coins));
    if (patch.gems !== undefined) st.gems = Math.max(0, Math.round(patch.gems));
    if (patch.energy !== undefined) st.energy = Math.max(0, Math.round(patch.energy));
    if (patch.sticks !== undefined) st.sticks = Math.max(0, Math.round(patch.sticks));
    if (patch.choppedLogs !== undefined) st.choppedLogs = Math.max(0, Math.round(patch.choppedLogs));
    if (b && b.applyExternalState) {
      b.applyExternalState(st);
    } else {
      localStorage.setItem('oreo-tap-save-v2', JSON.stringify(st));
    }
    refreshHeaderWallet();
  }

  function toast(msg) {
    const b = getBridge();
    if (b && b.showToast) b.showToast(msg);
  }

  const fmt = n => Math.round(Number(n) || 0).toLocaleString('ru-RU');
  const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  // ---------- FIREBASE REST + ONVALUE + RUNTRANSACTION ----------
  async function fbGet(path) {
    try {
      const r = await fetch(`${getDbUrl()}/${path.replace(/^\/+/, '')}.json`, { cache: 'no-store' });
      return r.ok ? await r.json() : null;
    } catch (e) { return null; }
  }
  async function fbPut(path, data) {
    try {
      const r = await fetch(`${getDbUrl()}/${path.replace(/^\/+/, '')}.json`, {
        method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data)
      });
      return r.ok ? await r.json() : null;
    } catch (e) { return null; }
  }
  async function fbPatch(path, data) {
    try {
      const r = await fetch(`${getDbUrl()}/${path.replace(/^\/+/, '')}.json`, {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data)
      });
      return r.ok ? await r.json() : null;
    } catch (e) { return null; }
  }
  async function fbDelete(path) {
    try {
      await fetch(`${getDbUrl()}/${path.replace(/^\/+/, '')}.json`, { method: 'DELETE' });
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
  function onValue(path, callback, intervalMs = 2000) {
    const key = `${path}_${Math.random().toString(36).slice(2)}`;
    let active = true;
    let lastJson = '';
    const poll = async () => {
      if (!active) return;
      const data = await fbGet(path);
      if (!active) return;
      const j = JSON.stringify(data);
      if (j !== lastJson) {
        lastJson = j;
        try { callback(data); } catch (e) { console.error(e); }
      }
    };
    poll();
    const timer = setInterval(poll, intervalMs);
    _watchers.set(key, () => { active = false; clearInterval(timer); });
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

  function cardHtml(code, isBig = false, isWin = false) {
    if (!code || code === '??') return `<span class="bg-card back${isBig ? ' big' : ''}"></span>`;
    const r = code[0] === 'T' ? '10' : code[0];
    const s = code[1];
    const red = (s === 'h' || s === 'd') ? ' red' : '';
    return `<span class="bg-card${red}${isBig ? ' big' : ''}${isWin ? ' win' : ''}"><b>${r}</b><i>${SUIT_SYM[s] || s}</i></span>`;
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

  function ensureOverlay() {
    if (_overlay) return _overlay;
    const el = document.createElement('div');
    el.className = 'bg-overlay';
    el.id = 'birchOverlay';
    el.innerHTML = `
      <div class="bg-head">
        <button class="bg-back" id="bgBackBtn" hidden>←</button>
        <div class="bg-title" id="bgTitle">🪵 Берёзовая Зона ОРЕО67</div>
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
    el.querySelector('#bgBackBtn').onclick = () => {
      _subView = null;
      renderActiveView();
    };
    el.querySelectorAll('.bg-tab').forEach(btn => {
      btn.onclick = () => {
        _subView = null;
        _activeTab = btn.dataset.bgtab;
        renderActiveView();
      };
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
    refreshHeaderWallet();
    renderActiveView();
  }

  function closeZone() {
    clearViewWatchers();
    if (_turnInterval) { clearInterval(_turnInterval); _turnInterval = null; }
    if (_overlay) _overlay.classList.remove('show');
  }

  function renderActiveView() {
    clearViewWatchers();
    if (_turnInterval) { clearInterval(_turnInterval); _turnInterval = null; }
    refreshHeaderWallet();
    const tabsEl = document.getElementById('bgTabs');
    const backBtn = document.getElementById('bgBackBtn');
    const body = document.getElementById('bgBody');
    if (!body) return;

    tabsEl.querySelectorAll('.bg-tab').forEach(t => t.classList.toggle('active', t.dataset.bgtab === _activeTab));

    if (_subView) {
      tabsEl.hidden = true;
      backBtn.hidden = false;
      if (_subView.type === 'poker') renderPokerTableView(body, _subView.id, _subView.isTournament);
      else if (_subView.type === 'chess') renderChessMatchView(body, _subView.id);
      return;
    }

    tabsEl.hidden = false;
    backBtn.hidden = true;
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
        <button class="bg-btn ${ _admSubTab === 'players' ? '' : 'ghost' }" id="admTabPlayers">👥 Live-редактор</button>
        <button class="bg-btn ${ _admSubTab === 'skins' ? '' : 'ghost' }" id="admTabSkins">🎭 Управление скинами</button>
        <button class="bg-btn ${ _admSubTab === 'tour' ? '' : 'ghost' }" id="admTabTour">🃏 Пульт турниров и Банка</button>
      </div>
      <div id="admSubBody"></div>
    `;
    body.querySelector('#admTabPlayers').onclick = () => { _admSubTab = 'players'; renderAdminConsoleTab(body); };
    body.querySelector('#admTabSkins').onclick = () => { _admSubTab = 'skins'; renderAdminConsoleTab(body); };
    body.querySelector('#admTabTour').onclick = () => { _admSubTab = 'tour'; renderAdminConsoleTab(body); };

    const sub = body.querySelector('#admSubBody');
    if (_admSubTab === 'players') renderAdminPlayersSub(sub);
    else if (_admSubTab === 'skins') renderAdminSkinsSub(sub);
    else renderAdminTourSub(sub);
  }

  function renderAdminPlayersSub(sub) {
    sub.innerHTML = `
      <div class="bg-sec">
        <h3>🔍 Live-поиск и мгновенная выдача ресурсов</h3>
        <input class="bg-input" id="admSearchInp" placeholder="Поиск по имени, ID или @username..." value="${esc(_admSearchQuery)}">
        <div id="admPlayersList" style="margin-top:10px">Загрузка списка игроков из Firebase...</div>
      </div>
    `;
    const inp = sub.querySelector('#admSearchInp');
    let latestPlayers = {};
    inp.oninput = () => { _admSearchQuery = inp.value.trim(); drawPlayers(latestPlayers); };

    function drawPlayers(data) {
      latestPlayers = data || {};
      const box = sub.querySelector('#admPlayersList');
      if (!box) return;
      const arr = Object.entries(latestPlayers).map(([k, v]) => Object.assign({ id: k }, v || {}));
      arr.sort((a, b) => (Number(b.coins) || 0) - (Number(a.coins) || 0));
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

      box.innerHTML = filtered.slice(0, 30).map(p => {
        const uid = String(p.id);
        const isSel = _admSelectedUid === uid;
        return `
          <div class="bg-item ${isSel ? 'sel' : ''}" data-uid="${esc(uid)}" style="flex-direction:column;align-items:stretch">
            <div class="bg-row sp" style="cursor:pointer" data-pick="${esc(uid)}">
              <div>
                <b>👤 ${esc(p.name || uid)} ${p.username ? `<small>@${esc(p.username)}</small>` : ''}</b>
                <small>ID: ${esc(uid)} • 🪓 Чурки: ${fmt(p.choppedLogs || 0)}</small>
              </div>
              <span class="bg-chip gold">🪙 ${fmt(p.coins || 0)}</span>
            </div>
            <div class="bg-adm-grid">
              <div>🪙 ${fmt(p.coins || 0)}</div>
              <div>💎 ${fmt(p.gems || 0)}</div>
              <div>⚡ ${fmt(p.energy || 500)}</div>
              <div>🪵 ${fmt(p.sticks || 0)}</div>
            </div>
            ${isSel ? `
              <div class="bg-adm-res">
                ${['coins:🪙 Коины', 'gems:💎 Алмазики', 'energy:⚡ Энергия', 'sticks:🪵 Палочки'].map(pair => {
                  const [rk, rlabel] = pair.split(':');
                  return `
                    <div class="bg-row sp" style="margin-top:6px">
                      <small><b>${rlabel}</b></small>
                      <div class="bg-row">
                        <button class="bg-btn sm green" data-act="${esc(uid)}:${rk}:add:10000">+10k</button>
                        <button class="bg-btn sm green" data-act="${esc(uid)}:${rk}:add:100000">+100k</button>
                        <button class="bg-btn sm green" data-act="${esc(uid)}:${rk}:add:1000000">+1M</button>
                        <button class="bg-btn sm ghost" data-act="${esc(uid)}:${rk}:add:-10000">-10k</button>
                        <button class="bg-btn sm red" data-act="${esc(uid)}:${rk}:reset:0">Сброс</button>
                      </div>
                    </div>
                  `;
                }).join('')}
              </div>
            ` : ''}
          </div>
        `;
      }).join('');

      box.querySelectorAll('[data-pick]').forEach(el => {
        el.onclick = () => {
          const u = el.getAttribute('data-pick');
          _admSelectedUid = (_admSelectedUid === u) ? '' : u;
          drawPlayers(latestPlayers);
        };
      });

      box.querySelectorAll('[data-act]').forEach(btn => {
        btn.onclick = async (e) => {
          e.stopPropagation();
          const [uid, rk, mode, amtStr] = btn.getAttribute('data-act').split(':');
          await adminModifyPlayerResource(uid, rk, mode, Number(amtStr));
        };
      });
    }

    _viewUnsubs.push(onValue('players', drawPlayers, 2000));
  }

  async function adminModifyPlayerResource(uid, resKey, mode, deltaOrVal) {
    const now = Date.now();
    const p = (await fbGet(`players/${encodeURIComponent(uid)}`)) || { id: uid, coins: 0, gems: 5, energy: 500, sticks: 0 };
    const cur = Math.max(0, Number(p[resKey]) || 0);
    const nextVal = mode === 'reset' ? 0 : Math.max(0, cur + deltaOrVal);
    const delta = nextVal - cur;
    const patch = { [resKey]: nextVal, ts: now, adminUpdatedAt: now };
    if (resKey === 'coins') {
      patch.taps = nextVal;
      patch.count = nextVal;
      if (mode === 'reset') patch.adminResetId = (Number(p.adminResetId) || 0) + 1;
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

  // ==================== 3. ДУЭЛИ 1v1 НА КОИНЫ (ПОКЕР И ШАХМАТЫ) ====================
  let _duelTargetId = '';
  let _duelGame = 'chess';
  let _duelBet = 10000;

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
        return `
          <div class="bg-item">
            <div class="grow">
              <b>${gTitle} • ${esc(ch.challengerName)} ${ch.opponentName ? `vs ${esc(ch.opponentName)}` : '(Открытый стол)'}</b>
              <small>Ставка: <b>${fmt(ch.bet)} 🪙</b> (Банк: ${fmt((ch.bet || 0) * 2)} 🪙) • Статус: ${esc(ch.status)}</small>
            </div>
            <div class="bg-row">
              ${canAccept ? `<button class="bg-btn sm green" data-acc="${esc(ch.id)}">✅ Принять</button>` : ''}
              ${canAccept && String(ch.opponentId) === me.id ? `<button class="bg-btn sm red" data-dec="${esc(ch.id)}">❌</button>` : ''}
              ${isMine && ch.status === 'pending' ? `<button class="bg-btn sm red" data-can="${esc(ch.id)}">Отмена</button>` : ''}
              ${isParticipant && ch.status === 'active' ? `<button class="bg-btn sm" data-open="${esc(ch.id)}:${esc(ch.game)}">Войти</button>` : ''}
            </div>
          </div>
        `;
      }).join('');

      box.querySelectorAll('[data-acc]').forEach(b => { b.onclick = () => acceptEscrowDuelChallenge(b.getAttribute('data-acc')); });
      box.querySelectorAll('[data-dec]').forEach(b => { b.onclick = () => cancelOrDeclineEscrowDuel(b.getAttribute('data-dec'), false); });
      box.querySelectorAll('[data-can]').forEach(b => { b.onclick = () => cancelOrDeclineEscrowDuel(b.getAttribute('data-can'), true); });
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
              <b>👤 ${esc(p.name)} ${p.username ? `@${esc(p.username)}` : ''}</b>
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
    bet = Math.max(100, Math.round(Number(bet) || 10000));
    if (getCoins() < bet) {
      toast(`❌ Недостаточно коинов для ставки ${fmt(bet)} 🪙!`);
      return;
    }

    const newCoins = getCoins() - bet;
    updateLocalWallet({ coins: newCoins });
    await fbPatch(`players/${encodeURIComponent(me.id)}`, { coins: newCoins, taps: newCoins, count: newCoins, ts: Date.now() });

    let oppName = '';
    let oppUname = '';
    if (vsBot) {
      oppName = '🤖 Берёзовый Леший';
    } else if (targetId) {
      const opp = await fbGet(`players/${encodeURIComponent(targetId)}`);
      if (opp) { oppName = opp.name || ''; oppUname = opp.username || ''; }
    }

    const cid = `duel_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
    const now = Date.now();
    const chObj = {
      id: cid,
      challengerId: me.id,
      challengerName: me.name,
      challengerUsername: me.username,
      opponentId: vsBot ? 'birch_ai_bot' : (targetId || ''),
      opponentName: oppName,
      opponentUsername: oppUname,
      game,
      gameTitle: game === 'chess' ? '♟ Берёзовые Шахматы' : '🃏 Берёзовый Покер 1v1',
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
    _subView = { type: game === 'chess' ? 'chess' : 'poker', id: cid, isTournament: false };
    renderActiveView();
  }

  async function acceptEscrowDuelChallenge(cid) {
    const me = getMe();
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
      cur.pot = bet * 2;
      cur.status = 'active';
      cur.acceptedAt = Date.now();
      return cur;
    });
    if (!tx.committed) return toast('⚠️ Не удалось принять вызов');

    if (String(ch.challengerId) !== me.id) {
      const nextC = getCoins() - bet;
      updateLocalWallet({ coins: nextC });
      await fbPatch(`players/${encodeURIComponent(me.id)}`, { coins: nextC, taps: nextC, count: nextC, ts: Date.now() });
    }

    if (ch.game === 'chess') {
      await fbPatch(`duel_matches/${encodeURIComponent(cid)}`, {
        blackId: me.id, blackName: me.name, pot: bet * 2, status: 'active', lastMoveTs: Date.now()
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
    if (isDraw) {
      if (ch.challengerId) await adminModifyPlayerResource(ch.challengerId, 'coins', 'add', bet);
      if (ch.opponentId && ch.opponentId !== 'birch_ai_bot') await adminModifyPlayerResource(ch.opponentId, 'coins', 'add', bet);
      toast(`🤝 Ничья! Ставки по ${fmt(bet)} 🪙 возвращены обоим игрокам.`);
    } else if (winnerId && winnerId !== 'birch_ai_bot') {
      await adminModifyPlayerResource(winnerId, 'coins', 'add', pot);
      if (String(winnerId) === getMe().id) toast(`🏆 ПОБЕДА! Вы забрали банк дуэли +${fmt(pot)} 🪙!`);
    }
  }

  // ==================== 4. ДВИЖОК «БЕРЁЗОВЫЕ ШАХМАТЫ» (CHESS.JS + FIREBASE) ====================
  const PIECE_GLYPH = {
    wp: '♙', wn: '♘', wb: '♗', wr: '♖', wq: '♕', wk: '♔',
    bp: '♟', bn: '♞', bb: '♝', br: '♜', bq: '♛', bk: '♚'
  };

  async function initChessMatchInFirebase(cid, chObj, vsBot = false) {
    const match = {
      id: cid,
      whiteId: chObj.challengerId,
      whiteName: chObj.challengerName,
      blackId: vsBot ? 'birch_ai_bot' : (chObj.opponentId || ''),
      blackName: vsBot ? '🤖 Берёзовый Леший' : (chObj.opponentName || 'Ожидание соперника...'),
      vsBot: Boolean(vsBot),
      bet: chObj.bet,
      pot: chObj.bet * 2,
      fen: 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1',
      history: [],
      turn: 'w',
      wTime: CHESS_INIT_MS,
      bTime: CHESS_INIT_MS,
      lastMoveTs: Date.now(),
      lastFrom: '',
      lastTo: '',
      status: vsBot ? 'active' : 'waiting',
      winner: '',
      reason: ''
    };
    await fbPut(`duel_matches/${encodeURIComponent(cid)}`, match);
  }

  function fmtClock(ms) {
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

    body.innerHTML = `
      <div class="bg-chess-wrap">
        <div class="bg-clock" id="chessTopClock"><span id="chessTopName">Соперник</span><span class="t" id="chessTopTime">5:00</span></div>
        <div class="bg-board8" id="chessBoard"></div>
        <div class="bg-clock" id="chessBotClock"><span id="chessBotName">Вы</span><span class="t" id="chessBotTime">5:00</span></div>
        <div class="bg-row sp" style="margin-top:8px">
          <span class="bg-chip gold" id="chessStatusChip">Ожидание...</span>
          <button class="bg-btn sm red" id="chessResignBtn">🏳️ Сдаться</button>
        </div>
        <div class="bg-moves" id="chessMovesBox">Ходы партии: —</div>
        <div id="chessOutcomeBox"></div>
      </div>
    `;

    const boardEl = body.querySelector('#chessBoard');

    function getLiveClocks(m) {
      if (!m || m.status !== 'active') return { w: m ? m.wTime : CHESS_INIT_MS, b: m ? m.bTime : CHESS_INIT_MS };
      const elapsed = Math.max(0, Date.now() - (Number(m.lastMoveTs) || Date.now()));
      return {
        w: m.turn === 'w' ? Math.max(0, m.wTime - elapsed) : m.wTime,
        b: m.turn === 'b' ? Math.max(0, m.bTime - elapsed) : m.bTime
      };
    }

    function drawChess(m) {
      currentMatch = m;
      if (!m || !window.Chess) return;
      const chess = new window.Chess(m.fen);
      const amBlack = String(m.blackId) === me.id && String(m.whiteId) !== me.id;
      const myColor = amBlack ? 'b' : 'w';
      const clocks = getLiveClocks(m);

      const topIsBlack = !amBlack;
      body.querySelector('#chessTopName').textContent = `${topIsBlack ? '⬛ ' + (m.blackName || 'Ожидание...') : '⬜ ' + m.whiteName}`;
      body.querySelector('#chessBotName').textContent = `${topIsBlack ? '⬜ ' + m.whiteName : '⬛ ' + (m.blackName || 'Вы')} (Банк: ${fmt(m.pot || 0)} 🪙)`;
      body.querySelector('#chessTopTime').textContent = fmtClock(topIsBlack ? clocks.b : clocks.w);
      body.querySelector('#chessBotTime').textContent = fmtClock(topIsBlack ? clocks.w : clocks.b);
      body.querySelector('#chessTopClock').classList.toggle('active', m.status === 'active' && m.turn === (topIsBlack ? 'b' : 'w'));
      body.querySelector('#chessBotClock').classList.toggle('active', m.status === 'active' && m.turn === (topIsBlack ? 'w' : 'b'));

      const statusChip = body.querySelector('#chessStatusChip');
      if (m.status === 'waiting') statusChip.textContent = '⏳ Ожидание входа соперника...';
      else if (m.status === 'finished') statusChip.textContent = `🏁 Партия окончена (${m.reason || 'Финал'})`;
      else statusChip.textContent = (chess.in_check() ? '🔥 ШАХ! ' : '') + (m.turn === myColor ? '🟢 Ваш ход' : '⏳ Ход соперника');

      const legalMoves = selectedSq ? chess.moves({ square: selectedSq, verbose: true }) : [];
      const legalTargets = new Map(legalMoves.map(mv => [mv.to, mv]));

      const files = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'];
      const ranks = amBlack ? [1, 2, 3, 4, 5, 6, 7, 8] : [8, 7, 6, 5, 4, 3, 2, 1];
      const fOrder = amBlack ? [...files].reverse() : files;

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
          const isKingCheck = piece && piece.type === 'k' && piece.color === chess.turn() && chess.in_check();
          const cls = [
            'bg-sq',
            isLight ? 'l' : 'd',
            isSel ? 'sel' : '',
            isLast ? 'last' : '',
            isKingCheck ? 'chk' : '',
            mvInfo ? (piece ? 'cap' : 'mv') : ''
          ].filter(Boolean).join(' ');

          const glyph = piece ? PIECE_GLYPH[piece.color + piece.type] : '';
          const coord = fi === 0 ? `<span class="bg-coord">${r}</span>` : (r === (amBlack ? 8 : 1) ? `<span class="bg-coord" style="top:auto;bottom:1px;left:auto;right:2px">${f}</span>` : '');
          html += `<div class="${cls}" data-sq="${sq}">${coord}${glyph ? `<span class="pc ${piece.color}">${glyph}</span>` : ''}</div>`;
        }
      }
      boardEl.innerHTML = html;

      boardEl.querySelectorAll('[data-sq]').forEach(cell => {
        cell.onclick = () => onSquareClick(cell.getAttribute('data-sq'), chess, myColor);
      });

      const hist = Array.isArray(m.history) ? m.history : [];
      body.querySelector('#chessMovesBox').textContent = hist.length
        ? 'Ходы: ' + hist.map((san, i) => (i % 2 === 0 ? `${Math.floor(i / 2) + 1}. ${san}` : san)).join(' ')
        : 'Ходы партии: сделайте первый ход';

      const out = body.querySelector('#chessOutcomeBox');
      if (m.status === 'finished') {
        out.innerHTML = `<div class="bg-result"><h3>🏆 ${esc(m.reason || 'Партия завершена')}</h3><div>Банк дуэли: <b>${fmt(m.pot || 0)} 🪙</b></div></div>`;
      } else {
        out.innerHTML = '';
      }
    }

    async function onSquareClick(sq, chess, myColor) {
      if (!currentMatch || currentMatch.status !== 'active') return;
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
      }
    }

    async function commitChessMove(chess, moveObj) {
      const clocks = getLiveClocks(currentMatch);
      const hist = Array.isArray(currentMatch.history) ? [...currentMatch.history, moveObj.san] : [moveObj.san];
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
      await fbPatch(`duel_matches/${encodeURIComponent(matchId)}`, patch);
      if (status === 'finished') {
        await settleDuelPot(matchId, winner, isDraw);
      } else if (currentMatch.vsBot && chess.turn() === 'b') {
        setTimeout(() => makeBotChessMove(matchId), 650);
      }
    }

    async function makeBotChessMove(mid) {
      const m = await fbGet(`duel_matches/${encodeURIComponent(mid)}`);
      if (!m || m.status !== 'active' || m.turn !== 'b' || !window.Chess) return;
      const chess = new window.Chess(m.fen);
      const moves = chess.moves({ verbose: true });
      if (!moves.length) return;
      const captures = moves.filter(mv => mv.captured);
      const pick = captures.length ? captures[Math.floor(Math.random() * captures.length)] : moves[Math.floor(Math.random() * moves.length)];
      const moveObj = chess.move(pick);
      if (!moveObj) return;
      currentMatch = m;
      await commitChessMove(chess, moveObj);
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
      const clocks = getLiveClocks(currentMatch);
      const amBlack = String(currentMatch.blackId) === me.id && String(currentMatch.whiteId) !== me.id;
      const topIsBlack = !amBlack;
      const tEl = body.querySelector('#chessTopTime');
      const bEl = body.querySelector('#chessBotTime');
      if (tEl) tEl.textContent = fmtClock(topIsBlack ? clocks.b : clocks.w);
      if (bEl) bEl.textContent = fmtClock(topIsBlack ? clocks.w : clocks.b);
      if (clocks.w <= 0 || clocks.b <= 0) {
        const winId = clocks.w <= 0 ? currentMatch.blackId : currentMatch.whiteId;
        const winName = clocks.w <= 0 ? currentMatch.blackName : currentMatch.whiteName;
        await fbPatch(`duel_matches/${encodeURIComponent(matchId)}`, {
          status: 'finished', winner: winId, reason: `Флаг упал! Победил ${winName}`
        });
        await settleDuelPot(matchId, winId, false);
      }
    }, 500);

    _viewUnsubs.push(onValue(`duel_matches/${encodeURIComponent(matchId)}`, drawChess, 1200));
  }

  // ==================== 5. ТОВАРИЩЕСКИЕ СТОЛЫ И ПОЛНЫЙ ДВИЖОК ХОЛДЕМА ====================
  function renderFriendlyTablesTab(body) {
    document.getElementById('bgTitle').textContent = '🪵 Товарищеские столы Холдема 24/7';
    body.innerHTML = `
      <div class="bg-sec">
        <h3>🪵 Открытые деревянные столы (Вход на коины)</h3>
        <div class="bg-row" style="margin-bottom:10px">
          <button class="bg-btn green" id="newFriendly10k">➕ Создать стол (Бай-ин 10k 🪙)</button>
          <button class="bg-btn wood" id="newFriendly50k">➕ Создать стол (Бай-ин 50k 🪙)</button>
        </div>
        <div id="friendlyTablesBox">Загрузка столов...</div>
      </div>
    `;

    const createQuick = async (buyIn) => {
      if (getCoins() < buyIn) return toast(`❌ Нужно ${fmt(buyIn)} 🪙 для входа за стол!`);
      const tid = `cash_${Date.now()}`;
      const nextC = getCoins() - buyIn;
      updateLocalWallet({ coins: nextC });
      await fbPatch(`players/${encodeURIComponent(getMe().id)}`, { coins: nextC, taps: nextC, count: nextC, ts: Date.now() });
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
      const list = Object.values(data || {}).filter(t => t && t.id);
      if (!list.length) {
        box.innerHTML = `<div class="bg-muted">Столов пока нет — создайте стол выше!</div>`;
        return;
      }
      box.innerHTML = list.map(t => `
        <div class="bg-item">
          <div class="grow">
            <b>🃏 ${esc(t.title || t.id)}</b>
            <small>Игроков за столом: ${(t.seats || []).length}/6 • Банк: ${fmt(t.pot || 0)} 🪵 • Стадия: ${esc(t.stage || 'waiting')}</small>
          </div>
          <button class="bg-btn sm" data-join="${esc(t.id)}:${t.isTournament ? '1' : '0'}">Сесть за стол</button>
        </div>
      `).join('');

      box.querySelectorAll('[data-join]').forEach(b => {
        b.onclick = () => {
          const [tid, isT] = b.getAttribute('data-join').split(':');
          _subView = { type: 'poker', id: tid, isTournament: isT === '1' };
          renderActiveView();
        };
      });
    }, 2200));
  }

  async function createOrResetPokerTable(tid, title, isTournament, prizePool = 0) {
    const tbl = {
      id: tid,
      title: title || 'Берёзовый Холдем',
      isTournament: Boolean(isTournament),
      blindLevel: 1,
      stage: 'waiting',
      pot: 0,
      currentBet: 0,
      dealerIdx: 0,
      turnIdx: 0,
      turnDeadline: 0,
      board: [],
      deck: [],
      seats: [],
      logs: [`🪵 Стол «${title}» открыт!`]
    };
    await fbPut(`poker_tables/${encodeURIComponent(tid)}`, tbl);
    return tbl;
  }

  async function seatPlayerAtPokerTable(tid, title, isTournament, addSticks, blindLevel = 1) {
    const me = getMe();
    await runTransaction(`poker_tables/${encodeURIComponent(tid)}`, tbl => {
      if (!tbl) {
        tbl = {
          id: tid, title: title || 'Берёзовый Холдем', isTournament: Boolean(isTournament),
          blindLevel, stage: 'waiting', pot: 0, currentBet: 0, dealerIdx: 0, turnIdx: 0,
          turnDeadline: 0, board: [], deck: [], seats: [], logs: []
        };
      }
      tbl.seats = Array.isArray(tbl.seats) ? tbl.seats : [];
      const ex = tbl.seats.find(s => String(s.id) === me.id);
      if (ex) {
        ex.stack = (Number(ex.stack) || 0) + addSticks;
        ex.busted = false;
        ex.status = 'Точит топор 🪓';
      } else if (tbl.seats.length < 6) {
        tbl.seats.push({
          id: me.id,
          name: me.name,
          photo: me.photo,
          stack: addSticks,
          bet: 0,
          totalBet: 0,
          cards: [],
          folded: false,
          allIn: false,
          busted: false,
          acted: false,
          isBot: false,
          status: 'В засаде 🌿'
        });
      }
      return tbl;
    });
  }

  async function seatBotAtPokerTable(tid, startStack) {
    await runTransaction(`poker_tables/${encodeURIComponent(tid)}`, tbl => {
      if (!tbl) return tbl;
      tbl.seats = Array.isArray(tbl.seats) ? tbl.seats : [];
      if (!tbl.seats.some(s => s.id === 'birch_ai_bot')) {
        tbl.seats.push({
          id: 'birch_ai_bot',
          name: '🤖 Берёзовый Леший',
          photo: '',
          stack: startStack,
          bet: 0,
          totalBet: 0,
          cards: [],
          folded: false,
          allIn: false,
          busted: false,
          acted: false,
          isBot: true,
          status: 'Точит топор 🪓'
        });
      }
      return tbl;
    });
  }

  async function startTableNewHand(tid) {
    await runTransaction(`poker_tables/${encodeURIComponent(tid)}`, tbl => {
      if (!tbl || !Array.isArray(tbl.seats)) return tbl;
      const alive = tbl.seats.filter(s => (Number(s.stack) || 0) > 0 && !s.busted);
      if (alive.length < 2) {
        tbl.stage = 'waiting';
        return tbl;
      }
      const deck = makeDeck();
      const lvl = Number(tbl.blindLevel) || 1;
      const bl = BLIND_LEVELS[Math.min(BLIND_LEVELS.length - 1, lvl - 1)];

      tbl.dealerIdx = ((Number(tbl.dealerIdx) || 0) + 1) % tbl.seats.length;
      tbl.board = [];
      tbl.pot = 0;
      tbl.stage = 'preflop';
      tbl.winnerBanner = '';

      tbl.seats.forEach(s => {
        if ((Number(s.stack) || 0) <= 0) {
          s.busted = true; s.folded = true; s.cards = []; s.bet = 0; s.totalBet = 0;
          s.status = 'Расколот 🪵';
        } else {
          s.busted = false; s.folded = false; s.allIn = false; s.acted = false;
          s.bet = 0; s.totalBet = 0;
          s.cards = [deck.pop(), deck.pop()];
          s.status = Math.random() > 0.5 ? 'Точит топор 🪓' : 'В засаде 🌿';
        }
      });

      const activeIdx = tbl.seats.map((s, i) => (!s.busted ? i : -1)).filter(i => i >= 0);
      const sbPos = activeIdx[(activeIdx.indexOf(tbl.dealerIdx) + 1 + activeIdx.length) % activeIdx.length];
      const bbPos = activeIdx[(activeIdx.indexOf(sbPos) + 1) % activeIdx.length];
      const firstTurn = activeIdx[(activeIdx.indexOf(bbPos) + 1) % activeIdx.length];

      const postBlind = (seat, amount, label) => {
        const pay = Math.min(seat.stack, amount);
        seat.stack -= pay;
        seat.bet += pay;
        seat.totalBet += pay;
        tbl.pot += pay;
        if (seat.stack === 0) seat.allIn = true;
        seat.status = label;
      };
      postBlind(tbl.seats[sbPos], bl.sb, `МБ ${bl.sb}`);
      postBlind(tbl.seats[bbPos], bl.bb, `ББ ${bl.bb}`);

      tbl.currentBet = Math.max(tbl.seats[sbPos].bet, tbl.seats[bbPos].bet);
      tbl.turnIdx = firstTurn;
      tbl.turnDeadline = Date.now() + TURN_TIMEOUT_MS;
      tbl.deck = deck;
      tbl.logs = (tbl.logs || []).slice(-12).concat([`🃏 Новая раздача! Блайнды ${bl.sb}/${bl.bb} 🪵`]);
      return tbl;
    });
  }

  async function applyPokerPlayerAction(tid, actorId, action, raiseTo = 0) {
    let knockouts = [];
    let duelWinnerId = '';

    await runTransaction(`poker_tables/${encodeURIComponent(tid)}`, tbl => {
      if (!tbl || !['preflop', 'flop', 'turn', 'river'].includes(tbl.stage)) return tbl;
      const seat = tbl.seats[tbl.turnIdx];
      if (!seat || String(seat.id) !== String(actorId)) return tbl;

      const toCall = Math.max(0, (Number(tbl.currentBet) || 0) - (Number(seat.bet) || 0));
      if (action === 'fold') {
        seat.folded = true;
        seat.acted = true;
        seat.status = 'Пас в бересту 🍂';
        tbl.logs = (tbl.logs || []).slice(-12).concat([`🍂 ${seat.name}: Пас`]);
      } else if (action === 'check' || (action === 'call' && toCall === 0)) {
        seat.acted = true;
        seat.status = 'В засаде (Чек) 🌿';
        tbl.logs = (tbl.logs || []).slice(-12).concat([`🌿 ${seat.name}: Чек`]);
      } else if (action === 'call') {
        const pay = Math.min(seat.stack, toCall);
        seat.stack -= pay;
        seat.bet += pay;
        seat.totalBet += pay;
        tbl.pot += pay;
        seat.acted = true;
        if (seat.stack === 0) seat.allIn = true;
        seat.status = seat.allIn ? 'Ва-банк на чурках! 🔥' : `Колл ${pay} 🪵`;
        tbl.logs = (tbl.logs || []).slice(-12).concat([`🪵 ${seat.name}: Колл ${fmt(pay)}`]);
      } else if (action === 'raise') {
        const desiredTotalBet = Math.max((Number(tbl.currentBet) || 0) * 2, Number(raiseTo) || 0);
        const add = Math.min(seat.stack, Math.max(toCall, desiredTotalBet - seat.bet));
        seat.stack -= add;
        seat.bet += add;
        seat.totalBet += add;
        tbl.pot += add;
        seat.acted = true;
        if (seat.bet > tbl.currentBet) {
          tbl.currentBet = seat.bet;
          tbl.seats.forEach((s, idx) => { if (idx !== tbl.turnIdx && !s.folded && !s.busted && !s.allIn) s.acted = false; });
        }
        if (seat.stack === 0) seat.allIn = true;
        seat.status = seat.allIn ? 'Ва-банк на чурках! 🔥' : `Рейз до ${fmt(seat.bet)} 🪵`;
        tbl.logs = (tbl.logs || []).slice(-12).concat([`🪓 ${seat.name}: Рейз до ${fmt(seat.bet)}`]);
      }

      const contenders = tbl.seats.filter(s => !s.folded && !s.busted);
      if (contenders.length === 1) {
        const w = contenders[0];
        w.stack += tbl.pot;
        tbl.winnerBanner = `🏆 ${w.name} забирает банк ${fmt(tbl.pot)} 🪵 (соперники сбросили)!`;
        tbl.logs = (tbl.logs || []).slice(-12).concat([tbl.winnerBanner]);
        tbl.pot = 0;
        tbl.stage = 'showdown';
        tbl.turnDeadline = Date.now() + 4500;
        return tbl;
      }

      // Ищем следующего активного игрока
      const n = tbl.seats.length;
      let nextIdx = -1;
      for (let step = 1; step <= n; step++) {
        const candIdx = (tbl.turnIdx + step) % n;
        const c = tbl.seats[candIdx];
        if (!c.folded && !c.busted && !c.allIn && (!c.acted || c.bet < tbl.currentBet)) {
          nextIdx = candIdx;
          break;
        }
      }

      if (nextIdx !== -1) {
        tbl.turnIdx = nextIdx;
        tbl.turnDeadline = Date.now() + TURN_TIMEOUT_MS;
        return tbl;
      }

      // Раунд торговли завершён — переход на следующую улицу или Шоудаун
      const canActCount = contenders.filter(s => !s.allIn).length;
      const advanceStreet = () => {
        tbl.seats.forEach(s => { s.bet = 0; s.acted = false; });
        tbl.currentBet = 0;
        if (tbl.stage === 'preflop') {
          tbl.board.push(tbl.deck.pop(), tbl.deck.pop(), tbl.deck.pop());
          tbl.stage = 'flop';
        } else if (tbl.stage === 'flop') {
          tbl.board.push(tbl.deck.pop());
          tbl.stage = 'turn';
        } else if (tbl.stage === 'turn') {
          tbl.board.push(tbl.deck.pop());
          tbl.stage = 'river';
        } else {
          tbl.stage = 'showdown';
        }
      };

      if (canActCount <= 1) {
        while (tbl.stage !== 'showdown') advanceStreet();
      } else {
        advanceStreet();
      }

      if (tbl.stage !== 'showdown') {
        for (let step = 1; step <= n; step++) {
          const idx = (tbl.dealerIdx + step) % n;
          const c = tbl.seats[idx];
          if (!c.folded && !c.busted && !c.allIn) {
            tbl.turnIdx = idx;
            break;
          }
        }
        tbl.turnDeadline = Date.now() + TURN_TIMEOUT_MS;
        return tbl;
      }

      // ШОУДАУН + САЙД-ПОТЫ + БАУНТИ ЗА РАСКОЛ ЧУРКИ
      const evalMap = {};
      contenders.forEach(s => {
        const ev = evaluate7Cards([...(s.cards || []), ...(tbl.board || [])]);
        evalMap[s.id] = ev;
        s.handName = ev.name;
        s.status = ev.name;
      });

      const pots = computeSidePots(tbl.seats);
      let mainWinner = contenders[0];
      if (pots.length === 0 && tbl.pot > 0) {
        pots.push({ amount: tbl.pot, eligibleIds: contenders.map(c => c.id) });
      }
      for (const p of pots) {
        const elig = contenders.filter(c => p.eligibleIds.includes(c.id));
        if (!elig.length) continue;
        elig.sort((a, b) => evalMap[b.id].score - evalMap[a.id].score);
        const topScore = evalMap[elig[0].id].score;
        const winners = elig.filter(e => evalMap[e.id].score === topScore);
        const share = Math.floor(p.amount / winners.length);
        winners.forEach(w => { w.stack += share; });
        mainWinner = winners[0];
      }

      tbl.seats.forEach(s => {
        if (!s.busted && s.stack <= 0) {
          s.busted = true;
          s.status = 'Расколот 🪵';
          if (mainWinner && mainWinner.id !== s.id) {
            knockouts.push({ victimId: s.id, victimName: s.name, killerId: mainWinner.id, killerName: mainWinner.name });
          }
        }
      });

      const stillAlive = tbl.seats.filter(s => !s.busted && s.stack > 0);
      if (!tbl.isTournament && String(tid).startsWith('duel_') && stillAlive.length === 1) {
        duelWinnerId = stillAlive[0].id;
      }

      tbl.winnerBanner = `🏆 ${mainWinner.name} выиграл раздачу (${evalMap[mainWinner.id].name})!`;
      tbl.logs = (tbl.logs || []).slice(-12).concat([tbl.winnerBanner]);
      tbl.pot = 0;
      tbl.turnDeadline = Date.now() + 5000;
      return tbl;
    });

    // Обработка нокаут-баунти (+20 000 коинов и +1 в Наколотые чурки)
    for (const ko of knockouts) {
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
    }
  }

  // Позиции 6 мест вокруг овального берестяного стола
  const SEAT_COORDS = [
    { left: '50%', top: '91%' },
    { left: '12%', top: '72%' },
    { left: '12%', top: '26%' },
    { left: '50%', top: '9%'  },
    { left: '88%', top: '26%' },
    { left: '88%', top: '72%' }
  ];

  function renderPokerTableView(body, tableId, isTournament = false) {
    document.getElementById('bgTitle').textContent = isTournament ? '🃏 Турнирный стол Холдема' : '🃏 Берёзовый Покер Холдем';
    const me = getMe();
    let currentTbl = null;

    body.innerHTML = `
      <div class="bg-ptop" id="pokerTopBar"></div>
      <div class="bg-table-wrap">
        <div class="bg-table"></div>
        <div class="bg-center">
          <div class="bg-board" id="pokerBoard"></div>
          <div class="bg-pot" id="pokerPot">${stickSvg(true)} 0</div>
          <div class="bg-stage" id="pokerStageTxt">Ожидание</div>
        </div>
        <div id="pokerSeatsLayer"></div>
      </div>
      <div class="bg-actions" id="pokerControls"></div>
      <div class="bg-log" id="pokerLogs"></div>
    `;

    function drawTable(tbl) {
      currentTbl = tbl;
      if (!tbl) return;
      const seats = Array.isArray(tbl.seats) ? tbl.seats : [];
      const mySeatIdx = seats.findIndex(s => String(s.id) === me.id);
      const lvl = Number(tbl.blindLevel) || 1;
      const bl = BLIND_LEVELS[Math.min(BLIND_LEVELS.length - 1, lvl - 1)];

      body.querySelector('#pokerTopBar').innerHTML = `
        <span class="bg-chip gold">Блайнды: ${fmt(bl.sb)}/${fmt(bl.bb)} 🪵</span>
        <span class="bg-chip">Игроков: ${seats.filter(s => !s.busted).length}/${seats.length}</span>
        <button class="bg-btn sm green" id="pokerDealBtn">🃏 Раздать карты</button>
        ${!seats.some(s => s.isBot) && seats.length < 6 ? `<button class="bg-btn sm wood" id="pokerAddBotBtn">🤖 +Бот</button>` : ''}
      `;
      body.querySelector('#pokerDealBtn').onclick = () => startTableNewHand(tableId);
      const addBotBtn = body.querySelector('#pokerAddBotBtn');
      if (addBotBtn) addBotBtn.onclick = async () => { await seatBotAtPokerTable(tableId, 20000); await startTableNewHand(tableId); };

      const boardEl = body.querySelector('#pokerBoard');
      const boardCards = Array.isArray(tbl.board) ? tbl.board : [];
      boardEl.innerHTML = [0, 1, 2, 3, 4].map(i => boardCards[i] ? cardHtml(boardCards[i], true) : `<span class="bg-card back big" style="opacity:.22"></span>`).join('');
      body.querySelector('#pokerPot').innerHTML = `${stickSvg(true)} Банк: ${fmt(tbl.pot || 0)} 🪵`;
      body.querySelector('#pokerStageTxt').textContent = tbl.winnerBanner || `Улица: ${tbl.stage || 'ожидание'}`;

      const seatsLayer = body.querySelector('#pokerSeatsLayer');
      seatsLayer.innerHTML = seats.map((s, idx) => {
        const relIdx = mySeatIdx >= 0 ? (idx - mySeatIdx + 6) % 6 : idx % 6;
        const pos = SEAT_COORDS[relIdx];
        const isTurn = ['preflop', 'flop', 'turn', 'river'].includes(tbl.stage) && tbl.turnIdx === idx;
        const isMe = String(s.id) === me.id;
        const showCards = isMe || tbl.stage === 'showdown';
        const cards = Array.isArray(s.cards) && s.cards.length
          ? s.cards.map(c => cardHtml(showCards ? c : '??')).join('')
          : '';
        const remRatio = isTurn ? Math.max(0.05, Math.min(1, ((Number(tbl.turnDeadline) || 0) - Date.now()) / TURN_TIMEOUT_MS)) : 1;

        return `
          <div class="bg-seat ${isTurn ? 'turn' : ''} ${isMe ? 'me' : ''} ${s.folded ? 'folded' : ''} ${s.busted ? 'busted' : ''}"
               style="left:${pos.left};top:${pos.top}" data-seatidx="${idx}">
            <div class="bg-ava" style="--p:${remRatio.toFixed(2)}">
              ${s.photo ? `<img src="${esc(s.photo)}" alt="">` : `<span>${esc((s.name || 'И')[0])}</span>`}
            </div>
            <div class="bg-sname">${esc(s.name)}${tbl.dealerIdx === idx ? '<i class="bg-dealer">D</i>' : ''}</div>
            <div class="bg-sstack">${stickSvg(false)} ${fmt(s.stack || 0)}</div>
            <div class="bg-sstatus">${esc(s.status || '')}</div>
            <div class="bg-scards">${cards}</div>
            ${(Number(s.bet) || 0) > 0 ? `<div class="bg-sbet">${stickSvg(false)} ${fmt(s.bet)}</div>` : ''}
          </div>
        `;
      }).join('');

      const ctrl = body.querySelector('#pokerControls');
      const isMyTurn = mySeatIdx >= 0 && ['preflop', 'flop', 'turn', 'river'].includes(tbl.stage) && tbl.turnIdx === mySeatIdx;
      if (isMyTurn) {
        const mySeat = seats[mySeatIdx];
        const toCall = Math.max(0, (Number(tbl.currentBet) || 0) - (Number(mySeat.bet) || 0));
        const minRaise = Math.max((Number(tbl.currentBet) || 0) * 2, bl.bb * 2);
        const maxRaise = (Number(mySeat.stack) || 0) + (Number(mySeat.bet) || 0);
        ctrl.innerHTML = `
          <div class="bg-turnbar"><i id="pokerTurnFill" style="width:100%"></i></div>
          <div class="bg-row">
            <button class="bg-btn red" id="actFold">🍂 Пас</button>
            <button class="bg-btn ghost" id="actCall">${toCall === 0 ? '🌿 Чек' : `🪵 Колл ${fmt(Math.min(mySeat.stack, toCall))}`}</button>
            <button class="bg-btn green" id="actRaise">🪓 Рейз <span id="raiseValTxt">${fmt(Math.min(maxRaise, minRaise))}</span></button>
            <button class="bg-btn wood" id="actAllIn">🔥 Ва-банк (${fmt(mySeat.stack)})</button>
          </div>
          <input type="range" class="bg-range" id="raiseSlider" min="${Math.min(maxRaise, minRaise)}" max="${maxRaise}" value="${Math.min(maxRaise, minRaise)}">
        `;
        const slider = ctrl.querySelector('#raiseSlider');
        const rTxt = ctrl.querySelector('#raiseValTxt');
        slider.oninput = () => { rTxt.textContent = fmt(slider.value); };
        ctrl.querySelector('#actFold').onclick = () => applyPokerPlayerAction(tableId, me.id, 'fold');
        ctrl.querySelector('#actCall').onclick = () => applyPokerPlayerAction(tableId, me.id, toCall === 0 ? 'check' : 'call');
        ctrl.querySelector('#actRaise').onclick = () => applyPokerPlayerAction(tableId, me.id, 'raise', Number(slider.value));
        ctrl.querySelector('#actAllIn').onclick = () => applyPokerPlayerAction(tableId, me.id, 'raise', maxRaise);
      } else if (mySeatIdx === -1) {
        ctrl.innerHTML = `<div class="bg-row"><button class="bg-btn green" id="sitHereBtn">🪵 Сесть за этот стол (20 000 🪵)</button></div>`;
        ctrl.querySelector('#sitHereBtn').onclick = () => seatPlayerAtPokerTable(tableId, tbl.title, isTournament, 20000, lvl);
      } else {
        ctrl.innerHTML = `<div class="bg-muted" style="text-align:center">⏳ Ожидание хода соперника (авто-Чек/Фолд через 25 сек AFK)...</div>`;
      }

      const logsEl = body.querySelector('#pokerLogs');
      logsEl.innerHTML = (tbl.logs || []).map(l => `<div>${esc(l)}</div>`).join('');

      // Если сейчас ход бота — бот ходит автоматически
      const turnSeat = seats[tbl.turnIdx];
      if (turnSeat && turnSeat.isBot && ['preflop', 'flop', 'turn', 'river'].includes(tbl.stage)) {
        setTimeout(() => {
          if (!currentTbl || currentTbl.turnIdx !== tbl.turnIdx) return;
          const need = Math.max(0, (Number(currentTbl.currentBet) || 0) - (Number(turnSeat.bet) || 0));
          const act = need === 0 ? 'check' : (need <= turnSeat.stack * 0.5 || Math.random() > 0.25 ? 'call' : 'fold');
          applyPokerPlayerAction(tableId, turnSeat.id, act);
        }, 900);
      }
    }

    // Таймер тлеющей лучинки 25 сек + авто-Check/Fold при AFK
    _turnInterval = setInterval(() => {
      if (!currentTbl) return;
      if (currentTbl.stage === 'showdown' && Date.now() > (Number(currentTbl.turnDeadline) || 0)) {
        startTableNewHand(tableId);
        return;
      }
      if (!['preflop', 'flop', 'turn', 'river'].includes(currentTbl.stage)) return;
      const rem = (Number(currentTbl.turnDeadline) || 0) - Date.now();
      const ratio = Math.max(0, Math.min(1, rem / TURN_TIMEOUT_MS));
      const fill = body.querySelector('#pokerTurnFill');
      if (fill) fill.style.width = `${(ratio * 100).toFixed(1)}%`;
      const turnAva = body.querySelector('.bg-seat.turn .bg-ava');
      if (turnAva) turnAva.style.setProperty('--p', ratio.toFixed(2));

      if (rem <= 0) {
        const seat = (currentTbl.seats || [])[currentTbl.turnIdx];
        if (seat) {
          const toCall = Math.max(0, (Number(currentTbl.currentBet) || 0) - (Number(seat.bet) || 0));
          applyPokerPlayerAction(tableId, seat.id, toCall === 0 ? 'check' : 'fold');
        }
      }
    }, 400);

    _viewUnsubs.push(onValue(`poker_tables/${encodeURIComponent(tableId)}`, drawTable, 1200));
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

  const SHUSHIK_SVG = `
    <svg viewBox="0 0 200 200" xmlns="http://www.w3.org/2000/svg">
      <defs>
        <radialGradient id="velvetDark" cx="50%" cy="45%" r="65%">
          <stop offset="0%" stop-color="#221d24"/>
          <stop offset="60%" stop-color="#0f0c12"/>
          <stop offset="100%" stop-color="#050307"/>
        </radialGradient>
        <linearGradient id="platMask" x1="0%" y1="0%" x2="100%" y2="100%">
          <stop offset="0%" stop-color="#ffffff"/>
          <stop offset="35%" stop-color="#d7dde8"/>
          <stop offset="65%" stop-color="#7f8c9f"/>
          <stop offset="100%" stop-color="#eef2f7"/>
        </linearGradient>
        <radialGradient id="crimsonRose" cx="35%" cy="35%" r="65%">
          <stop offset="0%" stop-color="#ff5c7c"/>
          <stop offset="55%" stop-color="#d50032"/>
          <stop offset="100%" stop-color="#560014"/>
        </radialGradient>
        <filter id="redNeonGlow" x="-30%" y="-30%" width="160%" height="160%">
          <feDropShadow dx="0" dy="0" stdDeviation="4" flood-color="#ff003c" flood-opacity=".95"/>
        </filter>
      </defs>
      <!-- Матовая основа глубокого графитово-чёрного бархата -->
      <circle cx="100" cy="100" r="99" fill="url(#velvetDark)" stroke="#4a091c" stroke-width="2.5"/>
      <circle cx="100" cy="100" r="68" fill="none" stroke="#ff1744" stroke-width="1.2" opacity=".45"/>
      <!-- Густой венок объёмных алых роз с каплями росы по кругу -->
      ${Array.from({ length: 12 }, (_, i) => {
        const a = (i / 12) * Math.PI * 2;
        const rx = (100 + Math.cos(a) * 82).toFixed(1);
        const ry = (100 + Math.sin(a) * 82).toFixed(1);
        const dx = (Number(rx) + 5).toFixed(1);
        const dy = (Number(ry) - 5).toFixed(1);
        return `
          <g>
            <circle cx="${rx}" cy="${ry}" r="15.5" fill="url(#crimsonRose)" stroke="#3a000d" stroke-width="1.4"/>
            <path d="M${Number(rx)-7} ${ry} Q${rx} ${Number(ry)-9} ${Number(rx)+7} ${ry} Q${rx} ${Number(ry)+8} ${Number(rx)-5} ${Number(ry)+2}" fill="none" stroke="#ff9eb5" stroke-width="1.3" opacity=".8"/>
            <circle cx="${dx}" cy="${dy}" r="2.3" fill="#e0f7fa" opacity=".92"/>
          </g>`;
      }).join('')}
      <!-- Внутреннее неоновое алое свечение за маской -->
      <circle cx="100" cy="100" r="46" fill="rgba(255,0,60,.16)"/>
      <!-- Полированная серебряно-платиновая кошачья полумаска с заострёнными ушками -->
      <g filter="url(#redNeonGlow)">
        <path d="M58 98 L62 52 L85 73 Q100 68 115 73 L138 52 L142 98 C142 119,122 132,108 126 L100 119 L92 126 C78 132,58 119,58 98 Z"
              fill="url(#platMask)" stroke="#ffffff" stroke-width="1.8" stroke-linejoin="round"/>
        <!-- Внутренние грани ушек с рубиновым отблеском -->
        <polygon points="66,59 65,78 80,74" fill="#b0003a"/>
        <polygon points="134,59 135,78 120,74" fill="#b0003a"/>
        <!-- Раскосые прорези глаз с красным внутренним неоновым свечением -->
        <path d="M68 97 Q80 88 92 99 Q80 106 68 97 Z" fill="#ff003c" stroke="#2b000b" stroke-width="1.5"/>
        <path d="M132 97 Q120 88 108 99 Q120 106 132 97 Z" fill="#ff003c" stroke="#2b000b" stroke-width="1.5"/>
        <ellipse cx="80" cy="97" rx="5" ry="1.8" fill="#ffdde6"/>
        <ellipse cx="120" cy="97" rx="5" ry="1.8" fill="#ffdde6"/>
      </g>
      <text x="100" y="149" text-anchor="middle" font-family="Georgia, serif" font-weight="900" font-size="11.5" fill="#ffd1dc" letter-spacing="1.6">SHUSHIK</text>
    </svg>`;

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
      wafer1: '#0d0910',
      wafer2: '#1a0e17',
      cream1: '#d50032',
      cream2: '#e2e8f0',
      svgStop1: '#221d24',
      svgStop2: '#050307',
      stroke: '#ff1744',
      textFill: '#ffd1dc',
      glow: 'rgba(255,15,75,.75)',
      customSvg: SHUSHIK_SVG,
      desc: 'Самый дорогой и эксклюзивный скин: чёрный бархат в алых розах с росой и платиновая кошачья полумаска с неоновым свечением.'
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
  }

  // Оптимизированный спавнер DOM-частиц с авто-очисткой по animationend (без утечек памяти)
  function spawnParticles(skinId, x, y) {
    if (!SKINS[skinId]) return;
    const frag = document.createDocumentFragment();

    if (skinId === 'denis_lykasov') {
      const ring = document.createElement('div');
      ring.className = 'bg-tap-particle flash-ring';
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
        : ['❤️‍🔥', '🌹', '✨', '♥️', '🌹', '💖'];

    for (let i = 0; i < count; i++) {
      const el = document.createElement('div');
      const isCinemaTag = skinId === 'denis_lykasov' && (i % 2 === 0);
      el.className = 'bg-tap-particle' + (isCinemaTag ? ' cinema-tag' : '');
      el.textContent = symbols[i % symbols.length];

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
        el.style.filter = 'drop-shadow(0 0 6px rgba(255,20,75,.85))';
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
            return `
              <div class="bg-case-card ${c.vipClass}">
                <div class="bg-case-preview">${sk.customSvg}</div>
                <div style="flex:1;min-width:0">
                  <div class="bg-row sp">
                    <b style="font-size:14px">${esc(c.title)}</b>
                    <span class="bg-chip gold">×${sk.mult} к тапу</span>
                  </div>
                  <div style="font-size:10px;color:#ffd9a0;font-weight:800;margin:2px 0">${esc(c.subtitle)}</div>
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

  // ---------- АВТО-ИНИЦИАЛИЗАЦИЯ И ПЕРЕХВАТ DEEP-LINKS ----------
  function initBirchGames() {
    registerExclusiveSkinsIntoMainGame();
    applyExclusiveSkinTheme(getLocalState().equippedSkin || 'classic');

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
    syncAdminGrantsForMe
  };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', initBirchGames);
  else initBirchGames();
})();
