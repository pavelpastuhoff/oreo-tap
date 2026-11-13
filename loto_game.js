/* loto_game.js — Русское Лото ОРЕО67 (Модуль 4)
 * Изолированный модуль. Не трогает покер, шахматы, арену и кликер.
 * Интегрируется через window.OreoLoto и добавляет вкладку «loto» в оверлей Берёзовой Рощи.
 */
(() => {
  'use strict';

  // ─── БАЗОВЫЕ УТИЛИТЫ (до всех функций модуля) ─────────────────────────────
  const fmt = (n) => Number(n || 0).toLocaleString('ru-RU');
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  // ─── КОНСТАНТЫ ────────────────────────────────────────────────────────────
  const LOTO_BASE_BET    = 50000;
  const LOTO_MAX_CARDS   = 3;
  const LOTO_FB_ROOT     = 'loto_rooms';
  const LOTO_MIN_PLAYERS = 2;

  // ─── ПРИБАУТКИ ────────────────────────────────────────────────────────────
  const SAYINGS = {
    1:'🎯 Кол!',2:'🦢 Лебедь',3:'🌿 Три берёзы',4:'🍀 Четыре листа',
    5:'🖐 Пять',6:'🎸 Шесть струн',7:'🪓 Топорик!',8:'🎱 Восемь',
    9:'9️⃣ Девятка',10:'🔟 Десятка',11:'🥁 Барабанные палочки!',
    12:'💫 Дюжина',13:'😈 Чёртова дюжина!',14:'💡 Четырнадцать',
    15:'🕐 Четверть часа',16:'📅 Шестнадцать',17:'💎 Семнадцать',
    18:'📐 Восемнадцать',19:'🌙 Девятнадцать',20:'📦 Двадцаточка',
    21:'🃏 Очко!',22:'🦢🦢 Гуси-лебеди!',23:'2️⃣3️⃣',24:'🕐 Сутки',
    25:'⌚ Четверть сотни',26:'💫',27:'🌲',28:'💡',29:'📅',
    30:'📏 Тридцать',31:'💫',32:'🎲',33:'🌊 Кудри!',34:'💡',
    35:'⭐',36:'🎯',37:'🌟',38:'💡',39:'💫',40:'🔑 Сорок',
    41:'💫',42:'🌍 Ответ на всё',43:'💡',44:'🪑 Стульчики!',
    45:'🍓 Баба ягодка опять!',46:'💫',47:'🦅 Когти орла!',
    48:'💡',49:'💫',50:'📊 Полста!',51:'💫',52:'🃏 Колода',
    53:'💫',54:'💡',55:'🧤 Перчатки!',56:'💫',57:'💡',58:'💫',
    59:'💡',60:'⌚ Час',61:'💫',62:'💡',63:'💫',64:'💻 64 бита',
    65:'💡',66:'🥾 Валенки!',67:'🍪 Сиксе-севен ОРЕО!',68:'💡',
    69:'🔄 Туда-сюда!',70:'💫',71:'💡',72:'💫',73:'💡',
    74:'💫',75:'💡',76:'💫',77:'🪓🪓 Топорики — Семён Семёныч!',
    78:'💡',79:'💫',80:'👵 Бабушка!',81:'💡',82:'💫',83:'💡',
    84:'💫',85:'💡',86:'💫',87:'💡',88:'🥨 Крендельки!',
    89:'🧓 Сосед дедушки!',90:'👴 Дедушка!'
  };

  // ─── BRIDGE ───────────────────────────────────────────────────────────────
  function getBridge()   { return window.OreoBridge || null; }
  function getDbUrl()    {
    const b = getBridge();
    return ((b && b.dbUrl) || 'https://oreo-tap-default-rtdb.europe-west1.firebasedatabase.app').replace(/\/+$/, '');
  }
  function getMe() {
    const b   = getBridge();
    const tgU = window.Telegram && window.Telegram.WebApp && window.Telegram.WebApp.initDataUnsafe && window.Telegram.WebApp.initDataUnsafe.user;
    return {
      id:       String((tgU && tgU.id) || (b && b.playerId) || localStorage.getItem('oreo_anon_id') || 'anon'),
      name:     String((tgU && tgU.first_name) || (b && b.playerName) || 'Игрок'),
      username: String((tgU && tgU.username) || ''),
      photo:    String((tgU && tgU.photo_url) || (b && b.playerPhoto) || '')
    };
  }
  function getCoins() {
    const b = getBridge();
    if (b && b.getState) return Math.max(0, Math.round(Number(b.getState().coins) || 0));
    try { return Math.max(0, Math.round(Number(JSON.parse(localStorage.getItem('oreo-tap-save-v2') || '{}').coins) || 0)); }
    catch { return 0; }
  }
  function spendCoins(amt) {
    const b = getBridge();
    if (b && b.applyExternalState) b.applyExternalState({ coins: Math.max(0, getCoins() - amt) });
  }
  function earnCoins(amt) {
    const b = getBridge();
    if (b && b.applyExternalState) b.applyExternalState({ coins: getCoins() + Math.max(0, Math.round(Number(amt) || 0)) });
  }
  function toast(msg)   { const b = getBridge(); if (b && b.showToast) b.showToast(msg); }
  function haptic(t) {
    t = t || 'light';
    try { window.Telegram && window.Telegram.WebApp && window.Telegram.WebApp.HapticFeedback && window.Telegram.WebApp.HapticFeedback.impactOccurred(t); } catch (e) {}
  }

  // ─── FIREBASE ──────────────────────────────────────────────────────────────
  async function fbGet(path) {
    try {
      const r = await fetch(getDbUrl() + '/' + path + '.json', { cache: 'no-store' });
      return r.ok ? r.json() : null;
    } catch (e) { return null; }
  }
  async function fbPut(path, data) {
    try {
      var r = await fetch(getDbUrl() + '/' + path + '.json', {
        method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data)
      });
      return r.ok;
    } catch (e) { return false; }
  }
  async function fbPatch(path, data) {
    try {
      await fetch(getDbUrl() + '/' + path + '.json', {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data)
      });
    } catch (e) {}
  }
  async function runTx(path, fn, retries) {
    retries = retries || 4;
    for (var i = 0; i < retries; i++) {
      try {
        var res = await fetch(getDbUrl() + '/' + path + '.json', { headers: { 'X-Firebase-ETag': 'true' }, cache: 'no-store' });
        var etag = res.headers.get('ETag');
        var cur  = res.ok ? await res.json() : null;
        var next = fn(cur ? JSON.parse(JSON.stringify(cur)) : null);
        if (next === undefined) return { committed: false };
        var ph = { 'Content-Type': 'application/json' };
        if (etag) ph['if-match'] = etag;
        var pr = await fetch(getDbUrl() + '/' + path + '.json', { method: 'PUT', headers: ph, body: JSON.stringify(next) });
        if (pr.status === 412) continue;
        if (pr.ok) return { committed: true, snapshot: await pr.json() };
      } catch (e) {}
    }
    // fallback: просто PUT
    var cur2 = await fbGet(path);
    var nxt2 = fn(cur2);
    if (nxt2 === undefined) return { committed: false };
    await fbPut(path, nxt2);
    return { committed: true, snapshot: nxt2 };
  }

  // ─── СОСТОЯНИЕ ────────────────────────────────────────────────────────────
  var _liveLotoState  = null;  // текущая комната (synced от Firebase)
  var _myRoomId       = null;  // roomId в котором я
  var _myCards        = [];    // мои карточки (1-3)
  var _lotoWatcher    = null;  // unsub таймер
  var _cooldown       = false; // антиспам при неправильном тапе
  var _lotoBodyEl     = null;  // DOM-корень рендера
  var _lotoRenderSig  = '';    // debounce
  var _prevKvartiraTs = 0;

  // ─── ГЕНЕРАТОР КАРТОЧКИ ЛОТО (3×9) ────────────────────────────────────────
  // Колонки: 1-9, 10-19, ..., 80-90
  function generateCard() {
    var decades = [
      [1,2,3,4,5,6,7,8,9],
      [10,11,12,13,14,15,16,17,18,19],
      [20,21,22,23,24,25,26,27,28,29],
      [30,31,32,33,34,35,36,37,38,39],
      [40,41,42,43,44,45,46,47,48,49],
      [50,51,52,53,54,55,56,57,58,59],
      [60,61,62,63,64,65,66,67,68,69],
      [70,71,72,73,74,75,76,77,78,79],
      [80,81,82,83,84,85,86,87,88,89,90]
    ];
    var rows = [];
    var usedNums = [];
    for (var r = 0; r < 3; r++) {
      var row = new Array(9).fill(null);
      // Выбираем 5 из 9 колонок
      var cols = [0,1,2,3,4,5,6,7,8].sort(function() { return Math.random() - 0.5; }).slice(0, 5).sort(function(a,b) { return a-b; });
      cols.forEach(function(c) {
        var pool  = decades[c].filter(function(n) { return usedNums.indexOf(n) === -1; });
        if (!pool.length) pool = decades[c];
        var pick = pool[Math.floor(Math.random() * pool.length)];
        row[c] = pick;
        usedNums.push(pick);
      });
      rows.push(row);
    }
    return rows; // [3][9]
  }

  // ─── МЕШ«ОК — Фишер-Йейтс ────────────────────────────────────────────────
  function shuffleBag() {
    var bag = [];
    for (var i = 1; i <= 90; i++) bag.push(i);
    for (var i = bag.length - 1; i > 0; i--) {
      var j = Math.floor(Math.random() * (i + 1));
      var t = bag[i]; bag[i] = bag[j]; bag[j] = t;
    }
    return bag;
  }

  // ─── ПРИБАУТКА ────────────────────────────────────────────────────────────
  function getSaying(n, prev) {
    var base = SAYINGS[n] || String(n);
    if (prev === 80) return '👵 А бабушке — ' + n + ' лет! ' + base;
    if (prev === 90) return '👴 А дедушке — ' + n + ' лет! ' + base;
    return base;
  }

  // ─── ПРОВЕРКА СТРОКИ ───────────────────────────────────────────────────────
  function checkRowStatus(row, markedSet) {
    var nums   = row.filter(Boolean);
    var closed = nums.length > 0 && nums.every(function(n) { return markedSet.has(n); });
    var almost = !closed && nums.length > 0 && (nums.filter(function(n) { return !markedSet.has(n); }).length === 1);
    return { closed: closed, almost: almost, total: nums.length };
  }


  // ─── FIREBASE: КОМНАТЫ ────────────────────────────────────────────────────
  async function getLotoRooms() { return (await fbGet(LOTO_FB_ROOT)) || {}; }

  async function createLotoRoom(cardCount) {
    var me = getMe(), cost = LOTO_BASE_BET * cardCount + LOTO_BASE_BET;
    if (getCoins() < cost) { toast('🪙 Нужно ' + fmt(cost) + ' монет'); return null; }
    spendCoins(cost);
    var myCards = [];
    for (var ci = 0; ci < cardCount; ci++) myCards.push(generateCard());
    _myCards = myCards;
    var roomId = 'loto_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6);
    var room = {
      id: roomId, status: 'waiting', createdAt: Date.now(),
      bag: shuffleBag(), drawn: [], pot: LOTO_BASE_BET * cardCount,
      top_claimed: false, mid_claimed: false, game_over: false, host: me.id, players: {}
    };
    room.players[me.id] = {
      id: me.id, name: me.name, username: me.username, photo: me.photo,
      cards: myCards, cardCount: cardCount, escrow: LOTO_BASE_BET,
      paid: LOTO_BASE_BET * cardCount, marked: [],
      top_closed: false, mid_closed: false, bot_closed: false, all_closed: false
    };
    var saved = await fbPut(LOTO_FB_ROOT + '/' + roomId, room);
    if (!saved) { earnCoins(cost); _myCards = []; toast('⚠️ Не удалось создать комнату, ставка возвращена'); return null; }
    _myRoomId = roomId; _liveLotoState = room; return roomId;
  }

  async function joinLotoRoom(roomId, cardCount) {
    var me = getMe(), cost = LOTO_BASE_BET * cardCount + LOTO_BASE_BET;
    if (getCoins() < cost) { toast('🪙 Нужно ' + fmt(cost) + ' монет'); return false; }
    spendCoins(cost);
    var myCards = [];
    for (var ci = 0; ci < cardCount; ci++) myCards.push(generateCard());
    _myCards = myCards;
    var entry = {
      id: me.id, name: me.name, username: me.username, photo: me.photo,
      cards: myCards, cardCount: cardCount, escrow: LOTO_BASE_BET,
      paid: LOTO_BASE_BET * cardCount, marked: [],
      top_closed: false, mid_closed: false, bot_closed: false, all_closed: false
    };
    var tx = await runTx(LOTO_FB_ROOT + '/' + roomId, function(r) {
      if (!r || r.status !== 'waiting') return undefined;
      if (r.players && r.players[me.id]) return undefined;
      if (Object.keys(r.players || {}).length >= 6) return undefined;
      r.pot = (r.pot || 0) + LOTO_BASE_BET * cardCount;
      r.players = r.players || {}; r.players[me.id] = entry; return r;
    });
    if (!tx.committed) { earnCoins(cost); toast('⚠️ Не удалось войти'); return false; }
    _myRoomId = roomId; return true;
  }

  async function startLotoGame(roomId) {
    var me = getMe();
    var tx = await runTx(LOTO_FB_ROOT + '/' + roomId, function(r) {
      if (!r || r.status !== 'waiting' || r.host !== me.id) return undefined;
      if (Object.keys(r.players || {}).length < LOTO_MIN_PLAYERS) return undefined;
      r.status = 'active'; r.startedAt = Date.now(); r.drawn = []; r.bag = shuffleBag(); return r;
    });
    if (!tx.committed) toast('⚠️ Нужно минимум ' + LOTO_MIN_PLAYERS + ' игрока');
  }

  async function drawNextBarrel(roomId) {
    var me = getMe();
    await runTx(LOTO_FB_ROOT + '/' + roomId, function(r) {
      if (!r || r.status !== 'active' || r.game_over || r.host !== me.id) return undefined;
      if (!r.bag || !r.bag.length) { r.status = 'finished'; return r; }
      var barrel = r.bag[r.bag.length - 1]; r.bag = r.bag.slice(0, -1);
      r.drawn = (r.drawn || []).concat([barrel]);
      r.last_barrel = barrel; r.last_saying = getSaying(barrel, r.prev_barrel != null ? r.prev_barrel : null);
      r.prev_barrel = barrel; return r;
    });
  }


  async function markCell(roomId, num) {
    if (_cooldown) return;
    var room = _liveLotoState;
    if (!room || room.status !== 'active') return;
    var drawn = new Set(room.drawn || []);
    if (!drawn.has(num)) {
      _cooldown = true; haptic('medium');
      var cell = _lotoBodyEl && _lotoBodyEl.querySelector('[data-loto-num="' + num + '"]');
      if (cell) { cell.classList.add('loto-wrong'); setTimeout(function() { if (cell) cell.classList.remove('loto-wrong'); _cooldown = false; }, 1000); }
      else { setTimeout(function() { _cooldown = false; }, 1000); }
      return;
    }
    var me = getMe(), player = room.players && room.players[me.id];
    if (!player || (player.marked || []).indexOf(num) !== -1) return;
    haptic('light');
    await runTx(LOTO_FB_ROOT + '/' + roomId, function(r) {
      if (!r) return undefined;
      var p = r.players && r.players[me.id];
      if (!p) return undefined;
      var ms = new Set(p.marked || []);
      if (ms.has(num)) return undefined;
      ms.add(num); p.marked = Array.from(ms);
      var cards = p.cards || [], top = p.top_closed, mid = p.mid_closed, bot = p.bot_closed;
      cards.forEach(function(card) {
        if (!top && checkRowStatus(card[0], ms).closed) top = true;
        if (!mid && checkRowStatus(card[1], ms).closed) mid = true;
        if (!bot && checkRowStatus(card[2], ms).closed) bot = true;
      });
      p.top_closed = top; p.mid_closed = mid; p.bot_closed = bot;
      p.all_closed = top && mid && bot;
      r.players[me.id] = p;
      checkAndAwardPrizes(r, me.id);
      return r;
    });
  }

  function checkAndAwardPrizes(room, claimerId) {
    var claimer = room.players && room.players[claimerId];
    if (!claimer) return;
    var players = Object.values(room.players || {});
    if (!room.top_claimed && claimer.top_closed) {
      room.top_claimed = true; room.top_winner_id = claimerId;
      var tp = players.reduce(function(s, p) { return s + (p.id !== claimerId ? (p.escrow || LOTO_BASE_BET) : 0); }, 0);
      claimer.top_prize = tp; claimer.coins_won = (claimer.coins_won || 0) + tp;
      players.forEach(function(p) { if (p.id !== claimerId) p.escrow = 0; });
      room.top_prize_msg = '🏆 Верх! ' + esc(claimer.name) + ' +' + fmt(tp) + ' 🪙';
    }
    if (!room.mid_claimed && claimer.mid_closed) {
      room.mid_claimed = true; room.mid_winner_id = claimerId;
      var half = Math.floor((room.pot || 0) / 2); room.pot = (room.pot || 0) - half;
      claimer.mid_prize = half; claimer.coins_won = (claimer.coins_won || 0) + half;
      room.mid_prize_msg = '🥇 Середина! ' + esc(claimer.name) + ' +' + fmt(half) + ' 🪙';
    }
    if (!room.game_over && (claimer.bot_closed || claimer.all_closed)) {
      room.game_over = true; room.final_winner = claimerId; room.status = 'finished';
      var pot = room.pot || 0; claimer.final_prize = pot; claimer.coins_won = (claimer.coins_won || 0) + pot;
      room.pot = 0;
      room.final_msg = '🎉 ' + esc(claimer.name) + ' закрыл ' + (claimer.all_closed ? 'всю карточку' : 'нижний ряд') + '! +' + fmt(pot) + ' 🪙';
    }
    // КВАРТИРА
    players.forEach(function(p) {
      var ms = new Set(p.marked || []);
      (p.cards || []).forEach(function(card) {
        [0,1,2].forEach(function(ri) {
          var key = 'kv_' + p.id + '_' + ri;
          if (checkRowStatus(card[ri], ms).almost && !room[key]) {
            room[key] = true;
            if (!room.kvartira_msgs) room.kvartira_msgs = [];
            room.kvartira_msgs.push({ text: '🔥 КВАРТИРА! ' + esc(p.name) + ' — 1 номер до победы! На кону: ' + fmt(room.pot) + ' 🪙', ts: Date.now() });
          }
        });
      });
    });
  }

  async function quitLotoRoom(roomId) {
    var me = getMe(), refund = 0;
    var tx = await runTx(LOTO_FB_ROOT + '/' + roomId, function(r) {
      if (!r || r.status !== 'waiting') return undefined;
      var p = r.players && r.players[me.id]; if (!p) return undefined;
      refund = (p.paid || 0) + (p.escrow || 0);
      r.pot = Math.max(0, (r.pot || 0) - (p.paid || 0)); delete r.players[me.id];
      if (Object.keys(r.players).length === 0) return null;
      if (r.host === me.id) r.host = Object.keys(r.players)[0]; return r;
    });
    if (refund > 0) earnCoins(refund);
    await leaveLotoRoom();
  }

  async function claimLotoWinnings(room) {
    var me = getMe(), p = room && room.players && room.players[me.id];
    if (!p) return;
    var won = (p.coins_won || 0) - (p.claimed_coins || 0);
    if (won <= 0) return;
    await runTx(LOTO_FB_ROOT + '/' + room.id, function(r) {
      if (!r) return undefined;
      var pl = r.players && r.players[me.id]; if (!pl) return undefined;
      pl.claimed_coins = pl.coins_won || 0; r.players[me.id] = pl; return r;
    });
    earnCoins(won); toast('🎉 +' + fmt(won) + ' 🪙 начислено!');
  }

  async function leaveLotoRoom() {
    if (_lotoWatcher) { _lotoWatcher(); _lotoWatcher = null; }
    _myRoomId = null; _myCards = []; _liveLotoState = null; _lotoRenderSig = '';
  }


  // ══════════════════════════════════════════════════════════════════════════
  //  РЕНДЕР — ЛОББИ
  // ══════════════════════════════════════════════════════════════════════════
  // Возврат в свою активную/ожидающую комнату (после краша или перезахода)
  async function restoreMyRoom(body) {
    var me = getMe(), rooms = await getLotoRooms(), now = Date.now(), found = null;
    Object.values(rooms || {}).forEach(function(r) {
      if (!r || !r.players || !r.players[me.id]) return;
      if (r.status === 'waiting' || (r.status === 'active' && now - (r.startedAt || r.createdAt || 0) < 6 * 3600000)) {
        if (!found || (r.createdAt || 0) > (found.createdAt || 0)) found = r;
      }
    });
    if (!found || _myRoomId || !body.isConnected) return false;
    _myRoomId = found.id; _liveLotoState = found;
    _myCards = found.players[me.id].cards || [];
    subscribeToRoom(found.id, body); renderLotoGame(body);
    return true;
  }

  function renderLotoTab(body) {
    _lotoBodyEl = body;
    var t = document.getElementById('bgTitle'); if (t) t.textContent = '🎱 Русское Лото ОРЕО67';
    if (_myRoomId && _liveLotoState) { renderLotoGame(body); return; }
    renderLotoLobby(body);
    restoreMyRoom(body).catch(function() {});
  }

  function renderLotoLobby(body) {
    var fmt2 = fmt;
    body.innerHTML = `
<style>
.loto-lobby{padding:12px;display:flex;flex-direction:column;gap:12px}
.loto-ebox{background:rgba(255,255,255,.06);border-radius:16px;padding:14px;border:1.5px solid rgba(255,255,255,.12)}
.loto-ebox h4{margin:0 0 8px;font-size:13px}
.loto-cpicks{display:flex;gap:8px;margin:8px 0}
.loto-cpick{flex:1;padding:10px 4px;border-radius:12px;border:2px solid rgba(255,255,255,.18);
  background:rgba(255,255,255,.07);cursor:pointer;text-align:center;font-weight:800;font-size:13px}
.loto-cpick.sel{border-color:#7ce8ff;background:rgba(124,232,255,.18)}
.loto-cost{font-size:11.5px;opacity:.7;text-align:center;margin:4px 0 8px}
.loto-btn-create{width:100%;padding:13px;border-radius:14px;border:none;
  background:linear-gradient(135deg,#2a9d8f,#1a6b60);color:#fff;font:800 15px inherit;cursor:pointer}
.loto-btn-create:active{transform:scale(.97)}
.loto-rooms{display:flex;flex-direction:column;gap:8px}
.loto-rcard{background:rgba(255,255,255,.06);border-radius:14px;padding:11px;
  border:1.5px solid rgba(255,255,255,.1);display:flex;align-items:center;gap:10px}
.loto-rcard .ri{flex:1;min-width:0}
.loto-rcard .rt{font-size:13px;font-weight:800}
.loto-rcard .rs{font-size:11px;opacity:.65;margin-top:2px}
.loto-btn-join{padding:8px 14px;border-radius:10px;border:none;
  background:linear-gradient(135deg,#e9c46a,#f4a261);color:#1a1a2e;font:800 13px inherit;cursor:pointer;flex-shrink:0}
.loto-empty{text-align:center;opacity:.5;font-size:12px;padding:16px 0}
</style>
<div class="loto-lobby">
  <div class="loto-ebox">
    <h4>🃏 Создать комнату</h4>
    <div style="font-size:12px;opacity:.7">Карточки:</div>
    <div class="loto-cpicks" id="lotoCPicks">
      <div class="loto-cpick sel" data-cnt="1">1<br><small>карт.</small></div>
      <div class="loto-cpick" data-cnt="2">2<br><small>карт.</small></div>
      <div class="loto-cpick" data-cnt="3">3<br><small>карт.</small></div>
    </div>
    <div class="loto-cost" id="lotoCost">Итого: ${fmt2(LOTO_BASE_BET*2)} 🪙</div>
    <button class="loto-btn-create" id="lotoCreateBtn">🎱 Создать</button>
  </div>
  <div class="loto-ebox">
    <h4>🌐 Открытые комнаты</h4>
    <div class="loto-rooms" id="lotoRoomsList"><div class="loto-empty">⏳ Загрузка...</div></div>
  </div>
</div>`;

    var selCnt = 1;
    body.querySelectorAll('.loto-cpick').forEach(function(el) {
      el.onclick = function() {
        body.querySelectorAll('.loto-cpick').forEach(function(e) { e.classList.remove('sel'); });
        el.classList.add('sel'); selCnt = Number(el.dataset.cnt);
        body.querySelector('#lotoCost').textContent = 'Итого: ' + fmt(LOTO_BASE_BET * selCnt + LOTO_BASE_BET) + ' 🪙';
      };
    });

    body.querySelector('#lotoCreateBtn').onclick = async function() {
      var btn = body.querySelector('#lotoCreateBtn');
      btn.disabled = true; btn.textContent = '⏳...';
      var roomId = await createLotoRoom(selCnt);
      if (roomId) { subscribeToRoom(roomId, body); renderLotoGame(body); }
      else { btn.disabled = false; btn.textContent = '🎱 Создать'; }
    };

    loadOpenRooms(body);
  }

  async function loadOpenRooms(body) {
    var listEl = body.querySelector('#lotoRoomsList');
    if (!listEl) return;
    var rooms = await getLotoRooms();
    var me    = getMe();
    var now   = Date.now();
    var open  = Object.values(rooms || {}).filter(function(r) {
      return r && r.status === 'waiting' && r.host !== me.id &&
             Object.keys(r.players || {}).length < 6 && now - (r.createdAt || 0) < 30 * 60000;
    });
    if (!open.length) { listEl.innerHTML = '<div class="loto-empty">🎱 Пока нет комнат — создай свою!</div>'; return; }
    listEl.innerHTML = open.map(function(r) {
      var pc = Object.keys(r.players || {}).length;
      return '<div class="loto-rcard">' +
        '<div class="ri"><div class="rt">🎱 ' + esc(r.host).slice(0,8) + '</div>' +
        '<div class="rs">👥 ' + pc + '/6 · 🪙 ' + fmt(r.pot) + '</div></div>' +
        '<button class="loto-btn-join" data-rid="' + esc(r.id) + '">Войти</button></div>';
    }).join('');
    listEl.querySelectorAll('.loto-btn-join').forEach(function(btn) {
      btn.onclick = async function() {
        btn.disabled = true; btn.textContent = '⏳';
        var ok = await joinLotoRoom(btn.dataset.rid, 1);
        if (ok) { subscribeToRoom(btn.dataset.rid, body); renderLotoGame(body); }
        else { btn.disabled = false; btn.textContent = 'Войти'; }
      };
    });
  }


  // ─── ПОДПИСКА НА КОМНАТУ ──────────────────────────────────────────────────
  function subscribeToRoom(roomId, body) {
    if (_lotoWatcher) { _lotoWatcher(); _lotoWatcher = null; }
    var lastJson = '';
    var timer = setInterval(async function() {
      var data = await fbGet(LOTO_FB_ROOT + '/' + roomId);
      var j = JSON.stringify(data);
      if (j === lastJson) return;
      lastJson = j; _liveLotoState = data;
      // Квартира
      if (data && data.kvartira_msgs && data.kvartira_msgs.length) {
        var msgs = data.kvartira_msgs, last = msgs[msgs.length - 1];
        if (last && Date.now() - (last.ts || 0) < 5000) { toast(last.text); haptic('heavy'); }
      }
      if (body && body.isConnected) {
        var sig = (data ? data.status : '') + ':' + ((data && data.drawn) ? data.drawn.length : 0) + ':' + (data ? data.game_over : '');
        if (_lotoRenderSig !== sig) { _lotoRenderSig = sig; renderLotoGame(body); }
      } else { clearInterval(timer); return; }
      if (data && data.status === 'finished') {
        if (window.OreoSquads) window.OreoSquads.reportLoto(roomId);
        await claimLotoWinnings(data); clearInterval(timer);
      }
    }, 1300);
    _lotoWatcher = function() { clearInterval(timer); };
  }


  // ══════════════════════════════════════════════════════════════════════════
  //  РЕНДЕР — ЭКРАН ИГРЫ
  // ══════════════════════════════════════════════════════════════════════════
  function renderLotoGame(body) {
    _lotoBodyEl = body;
    var room = _liveLotoState, me = getMe();
    if (!room) { renderLotoLobby(body); return; }
    var myPlayer  = room.players && room.players[me.id];
    var players   = Object.values(room.players || {});
    var drawn     = room.drawn || [];
    var drawnSet  = new Set(drawn);
    var last      = drawn.length ? drawn[drawn.length - 1] : null;
    var isHost    = room.host === me.id;
    var isActive  = room.status === 'active';
    var isWaiting = room.status === 'waiting';
    var isFinish  = room.status === 'finished';

    var playersHtml = players.map(function(p) {
      var isMe = p.id === me.id;
      var flags = (p.top_closed ? '🏆' : '') + (p.mid_closed ? '🥇' : '') + (p.bot_closed ? '✅' : '');
      return '<div class="lt-player' + (isMe ? ' me' : '') + '">' +
        '<div class="lt-pava ' + (window.OreoSquads ? window.OreoSquads.avatarClass(p.id) : '') + '">' + esc((p.name || '?')[0]) + '</div>' +
        '<div><div style="font-weight:800;font-size:11px">' + (window.OreoSquads ? window.OreoSquads.nameHtml(p.id, p.name) : esc(p.name)) + '</div>' +
        '<div style="font-size:10px;opacity:.6">' + flags + ' ' + ((p.marked || []).length) + '✓</div></div></div>';
    }).join('');

    var drawnHtml = drawn.slice(-18).map(function(n) {
      return '<div class="lt-dn' + (n === last ? ' last' : '') + '">' + n + '</div>';
    }).join('');

    var barrelHtml = isActive ? ('<div class="lt-barrel-box">' +
      '<div class="lt-bn">' + (last !== null ? last : '—') + '</div>' +
      '<div class="lt-bs">' + esc(room.last_saying || '') + '</div>' +
      '<div class="lt-drawn">' + drawnHtml + '</div></div>') : '';

    var hostCtrl = isActive && isHost ?
      '<button class="lt-btn primary" id="lotoDrawBtn" style="width:100%">🎱 Следующий бочонок (' + (90 - drawn.length) + ' ост.)</button>' :
      (isActive ? '<div style="text-align:center;opacity:.6;font-size:12px">⏳ Ведущий тянет бочонки...</div>' : '');

    var prizeHtml = '';
    if (room.top_prize_msg) prizeHtml += '<div class="lt-prize-msg">' + esc(room.top_prize_msg) + '</div>';
    if (room.mid_prize_msg) prizeHtml += '<div class="lt-prize-msg">' + esc(room.mid_prize_msg) + '</div>';

    var waitHtml = isWaiting ? ('<div class="lt-wait-box"><div style="font-size:22px">⏳</div>' +
      '<div style="font-weight:800;margin-top:4px">Ожидание · ' + players.length + '/' + 6 + ' игроков</div>' +
      (isHost && players.length >= LOTO_MIN_PLAYERS ?
        '<button class="lt-btn primary" id="lotoStartBtn" style="margin-top:10px;width:100%">🎱 Начать!</button>' :
        '<div style="font-size:11px;opacity:.6;margin-top:6px">Нужно ≥ ' + LOTO_MIN_PLAYERS + ' игрока</div>') +
      '</div>') : '';

    var finishHtml = isFinish ? ('<div class="lt-finish-box"><div style="font-size:28px">🎉</div>' +
      '<div style="font-weight:900;font-size:15px;margin-top:4px">' + esc(room.final_msg || 'Игра завершена!') + '</div>' +
      (room.mid_prize_msg ? '<div style="font-size:12px;opacity:.8;margin-top:4px">' + esc(room.mid_prize_msg) + '</div>' : '') +
      (room.top_prize_msg ? '<div style="font-size:12px;opacity:.8;margin-top:2px">' + esc(room.top_prize_msg) + '</div>' : '') +
      '</div>') : '';

    var actionsHtml = (!isFinish && isWaiting ? '<button class="lt-btn danger" id="lotoQuitBtn">🚪 Выйти</button>' : '') +
      (isFinish ? '<button class="lt-btn primary" id="lotoNewBtn" style="flex:1">🎱 Новая игра</button>' : '');

    body.innerHTML = getLotoCss() +
      '<div class="lt-wrap">' +
      '<div class="lt-topbar">' +
        '<span class="lt-chip gold">🪙 ' + fmt(room.pot) + '</span>' +
        '<span class="lt-chip">' + drawn.length + '/90 🎱</span>' +
        (room.top_claimed ? '<span class="lt-chip green">🏆 Верх ✓</span>' : '') +
        (room.mid_claimed ? '<span class="lt-chip green">🥇 Сер. ✓</span>' : '') +
      '</div>' +
      '<div class="lt-players">' + playersHtml + '</div>' +
      waitHtml + barrelHtml + hostCtrl + prizeHtml + finishHtml +
      (myPlayer ? renderMyCards(myPlayer, drawnSet, isActive) : '') +
      '<div class="lt-actions">' + actionsHtml + '</div>' +
      '</div>';

    // Привязка событий
    var startBtn = body.querySelector('#lotoStartBtn');
    if (startBtn) startBtn.onclick = function() { startLotoGame(_myRoomId); };
    var drawBtn = body.querySelector('#lotoDrawBtn');
    if (drawBtn) drawBtn.onclick = async function() {
      drawBtn.disabled = true;
      await drawNextBarrel(_myRoomId);
      setTimeout(function() { if (drawBtn) drawBtn.disabled = false; }, 1300);
    };
    var quitBtn = body.querySelector('#lotoQuitBtn');
    if (quitBtn) quitBtn.onclick = async function() { await quitLotoRoom(_myRoomId); renderLotoLobby(body); };
    var newBtn = body.querySelector('#lotoNewBtn');
    if (newBtn) newBtn.onclick = async function() { await leaveLotoRoom(); renderLotoLobby(body); };
    // Клики по клеткам
    body.querySelectorAll('[data-loto-num]').forEach(function(cell) {
      cell.onclick = function() {
        var num = Number(cell.dataset.lotoNum);
        if (num && _myRoomId) markCell(_myRoomId, num);
      };
    });
  }


  // ─── КАРТОЧКИ ИГРОКА ──────────────────────────────────────────────────────
  function renderMyCards(myPlayer, drawnSet, isActive) {
    var cards  = myPlayer.cards || _myCards || [];
    var marked = new Set(myPlayer.marked || []);
    var RLBL   = ['Верх', 'Сер.', 'Низ'];
    var RCLOSE = [myPlayer.top_closed, myPlayer.mid_closed, myPlayer.bot_closed];
    if (!cards.length) return '<div style="opacity:.5;text-align:center;font-size:12px;padding:10px 0">Нет карточек</div>';
    return '<div class="lt-cards-wrap">' + cards.map(function(card) {
      return '<div class="lt-card">' + [0,1,2].map(function(ri) {
        var row     = card[ri];
        var nums    = row.filter(Boolean);
        var mcnt    = nums.filter(function(n) { return marked.has(n); }).length;
        var isClosed = RCLOSE[ri];
        var isAlmost = isActive && !isClosed && (nums.length - mcnt) === 1;
        return '<div class="lt-row-lbl">' + RLBL[ri] + (isClosed ? ' ✅' : '') + '</div>' +
          '<div class="lt-row' + (isClosed ? ' closed' : isAlmost ? ' almost' : '') + '">' +
          row.map(function(cell) {
            if (cell === null) return '<div class="lt-cell empty"></div>';
            var isD = drawnSet.has(cell), isM = marked.has(cell);
            return '<div class="lt-cell' + (isD ? ' drawn' : '') + (isM ? ' marked' : '') + '" data-loto-num="' + cell + '">' + cell + '</div>';
          }).join('') + '</div>';
      }).join('') + '</div>';
    }).join('') + '</div>';
  }

  // ─── СТИЛИ ЛОТО ───────────────────────────────────────────────────────────
  function getLotoCss() {
    return `<style>
.lt-wrap{padding:10px;display:flex;flex-direction:column;gap:9px}
.lt-topbar{display:flex;gap:6px;flex-wrap:wrap}
.lt-chip{background:rgba(255,255,255,.1);border-radius:99px;padding:3px 9px;font-size:11.5px;font-weight:700;border:1px solid rgba(255,255,255,.18)}
.lt-chip.gold{background:rgba(230,180,30,.2);border-color:rgba(230,180,30,.5);color:#ffd76a}
.lt-chip.green{background:rgba(42,157,143,.2);border-color:rgba(42,157,143,.5);color:#7ce8ff}
.lt-players{display:flex;gap:5px;flex-wrap:wrap}
.lt-player{display:flex;align-items:center;gap:5px;background:rgba(255,255,255,.06);border-radius:9px;padding:4px 7px;font-size:11px}
.lt-player.me{border:1.5px solid rgba(124,232,255,.5)}
.lt-pava{width:20px;height:20px;border-radius:50%;background:linear-gradient(135deg,#ffe58a,#ff9a2e);display:flex;align-items:center;justify-content:center;font-size:11px;flex-shrink:0}
.lt-barrel-box{text-align:center;background:rgba(255,255,255,.04);border-radius:14px;padding:11px 8px;border:1.5px solid rgba(255,255,255,.1)}
.lt-bn{font-size:50px;font-weight:900;line-height:1;text-shadow:0 0 28px rgba(124,232,255,.6);color:#7ce8ff}
.lt-bs{font-size:12.5px;opacity:.8;margin-top:3px;min-height:16px}
.lt-drawn{display:flex;flex-wrap:wrap;gap:4px;margin-top:7px;justify-content:center}
.lt-dn{width:26px;height:26px;border-radius:50%;display:flex;align-items:center;justify-content:center;font-size:10.5px;font-weight:800;background:rgba(124,232,255,.12);border:1px solid rgba(124,232,255,.3);color:#7ce8ff}
.lt-dn.last{background:rgba(124,232,255,.5);box-shadow:0 0 10px rgba(124,232,255,.5)}
.lt-btn{padding:11px 14px;border-radius:12px;border:none;font:800 14px inherit;cursor:pointer;transition:transform .1s}
.lt-btn.primary{background:linear-gradient(135deg,#2a9d8f,#1a6b60);color:#fff}
.lt-btn.danger{background:rgba(200,40,40,.5);border:1px solid rgba(220,80,80,.4);color:#ff9999}
.lt-btn:active{transform:scale(.96)}
.lt-btn:disabled{opacity:.4;cursor:not-allowed}
.lt-actions{display:flex;gap:8px;flex-wrap:wrap}
.lt-prize-msg{background:rgba(255,230,100,.12);border:1.5px solid rgba(255,230,100,.35);border-radius:11px;padding:9px 11px;font-size:12.5px;font-weight:700;text-align:center}
.lt-wait-box{background:rgba(255,255,255,.05);border-radius:13px;padding:13px;text-align:center}
.lt-finish-box{background:rgba(42,157,143,.13);border:1.5px solid rgba(42,157,143,.4);border-radius:13px;padding:13px;text-align:center}
.lt-cards-wrap{display:flex;flex-direction:column;gap:9px}
.lt-card{background:rgba(10,15,40,.85);border-radius:13px;padding:7px;border:1.5px solid rgba(255,255,255,.1)}
.lt-row-lbl{font-size:9.5px;opacity:.5;text-align:center;margin:1px 0}
.lt-row{display:grid;grid-template-columns:repeat(9,1fr);gap:2px;margin:1px 0}
.lt-row.closed{opacity:.45}
.lt-row.almost .lt-cell.drawn:not(.marked){border-color:rgba(255,210,30,.8);animation:lt-pulse .9s infinite}
@keyframes lt-pulse{0%,100%{box-shadow:none}50%{box-shadow:0 0 7px 2px rgba(255,210,30,.5)}}
.lt-cell{aspect-ratio:1;border-radius:6px;display:flex;align-items:center;justify-content:center;font-size:10.5px;font-weight:800;cursor:pointer;user-select:none;border:1.5px solid transparent;transition:background .1s,transform .1s}
.lt-cell.empty{background:transparent;cursor:default}
.lt-cell.drawn{background:rgba(255,255,255,.1);border-color:rgba(124,232,255,.45)}
.lt-cell.marked{background:rgba(42,157,143,.4);border-color:#2a9d8f;color:#7ce8ff;text-decoration:line-through}
.lt-cell.loto-wrong{background:rgba(220,50,50,.5)!important;animation:lt-shake .3s}
@keyframes lt-shake{0%,100%{transform:translateX(0)}25%{transform:translateX(-3px)}75%{transform:translateX(3px)}}
.lt-cell:not(.empty):active{transform:scale(.9)}
</style>`;
  }


  // ══════════════════════════════════════════════════════════════════════════
  //  ИНТЕГРАЦИЯ В ОВЕРЛЕЙ birch_games.js
  // ══════════════════════════════════════════════════════════════════════════
  function integrateIntoOverlay() {
    var tryPatch = function() {
      var tabs = document.getElementById('bgTabs');
      if (!tabs) { setTimeout(tryPatch, 500); return; }
      if (tabs.querySelector('[data-bgtab="loto"]')) return;
      var lotoTab = document.createElement('button');
      lotoTab.className     = 'bg-tab';
      lotoTab.dataset.bgtab = 'loto';
      lotoTab.textContent   = '🎱 Лото';
      tabs.appendChild(lotoTab);
      patchActiveView();
    };
    tryPatch();
    setTimeout(tryPatch, 1000);
    setTimeout(tryPatch, 3000);
  }

  function patchActiveView() {
    // Перехватываем клик по вкладке Лото
    document.addEventListener('click', function(e) {
      var tab = e.target.closest('[data-bgtab="loto"]');
      if (!tab) return;
      // Выделяем вкладку
      var tabs = document.getElementById('bgTabs');
      if (tabs) tabs.querySelectorAll('.bg-tab').forEach(function(t) { t.classList.toggle('active', t === tab); });
      // Скрываем кнопку Назад, показываем вкладки
      var backBtn = document.getElementById('bgBackBtn');
      if (backBtn) backBtn.hidden = true;
      // Рендерим в bgBody
      setTimeout(function() {
        var body = document.getElementById('bgBody');
        if (body) renderLotoTab(body);
      }, 40);
    }, { passive: true });
  }

  function addLotoSideBtn() {
    if (document.getElementById('lotoSideBtn')) return;
    var sideLeft = document.querySelector('.side.left');
    if (!sideLeft) return;
    var btn = document.createElement('button');
    btn.className = 'round-btn'; btn.id = 'lotoSideBtn'; btn.title = 'Русское Лото';
    btn.innerHTML = '🎱<small style="font-size:9px;display:block">Лото</small>';
    btn.onclick = function() {
      if (window.BirchGames && window.BirchGames.openZone) {
        window.BirchGames.openZone('loto');
        // Дать время оверлею открыться, потом рендерим
        setTimeout(function() {
          var tabs = document.getElementById('bgTabs');
          if (tabs) {
            tabs.querySelectorAll('.bg-tab').forEach(function(t) { t.classList.toggle('active', t.dataset.bgtab === 'loto'); });
          }
          var body = document.getElementById('bgBody');
          if (body) renderLotoTab(body);
        }, 150);
      }
    };
    sideLeft.appendChild(btn);
  }

  // ══════════════════════════════════════════════════════════════════════════
  //  ЭКСПОРТ + ИНИЦИАЛИЗАЦИЯ
  // ══════════════════════════════════════════════════════════════════════════
  window.OreoLoto = {
    open:     function() {
      if (window.BirchGames && window.BirchGames.openZone) window.BirchGames.openZone('loto');
      setTimeout(function() { var b = document.getElementById('bgBody'); if (b) renderLotoTab(b); }, 150);
    },
    renderTab:  renderLotoTab,
    leave:      leaveLotoRoom,
    getState:   function() { return _liveLotoState; },
    isInGame:   function() { return !!(  _myRoomId && _liveLotoState); }
  };

  // Экспортируем _liveLotoState через геттер для birch_games.js
  Object.defineProperty(window, '__lotoState', { get: function() { return _liveLotoState; } });

  function init() {
    if (document.readyState !== 'loading') {
      addLotoSideBtn();
      integrateIntoOverlay();
    } else {
      document.addEventListener('DOMContentLoaded', function() {
        addLotoSideBtn();
        integrateIntoOverlay();
      });
    }
  }
  init();

})();

