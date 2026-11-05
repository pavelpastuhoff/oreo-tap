/**
 * ARENA BETS — Автономный модуль ставок (Пари-мутуэль) для Telegram WebApp
 * Использует глобальный мост window.OreoBridge / глобальную БД из index.html без повторной инициализации Firebase.
 */
(() => {
  'use strict';

  const ADMIN_ID = 594228143;
  const VIRTUAL_CUSHION = 50000; // Виртуальная подушка +50 000 к каждому исходу только для расчёта кэфа
  const LOCAL_EVENTS_KEY = 'oreo_arena_bets_events_v1';
  const LOCAL_CLAIMED_KEY = 'oreo_arena_bets_claimed_v1';

  // --- Доступ к глобальной БД и состоянию игрока из index.html ---
  function getBridge() {
    return window.OreoBridge || null;
  }

  function getDbBaseUrl() {
    const br = getBridge();
    const raw = (br && br.dbUrl) || window.db || window.database || '';
    if (typeof raw === 'string' && raw.startsWith('http')) {
      return raw.replace(/\/+$/, '');
    }
    return 'https://oreo-tap-default-rtdb.europe-west1.firebasedatabase.app';
  }

  function getUserId() {
    const tgUser = window.Telegram && window.Telegram.WebApp && window.Telegram.WebApp.initDataUnsafe && window.Telegram.WebApp.initDataUnsafe.user;
    if (tgUser && tgUser.id) return Number(tgUser.id);
    const br = getBridge();
    if (br && br.playerId) return Number(br.playerId) || String(br.playerId);
    const anon = localStorage.getItem('oreo_anon_id');
    return anon ? (Number(anon) || anon) : 0;
  }

  function isAdminUser() {
    const uid = getUserId();
    return Number(uid) === ADMIN_ID;
  }

  function getPlayerName() {
    const tgUser = window.Telegram && window.Telegram.WebApp && window.Telegram.WebApp.initDataUnsafe && window.Telegram.WebApp.initDataUnsafe.user;
    if (tgUser && tgUser.first_name) return String(tgUser.first_name);
    const br = getBridge();
    return (br && br.playerName) ? String(br.playerName) : 'Игрок';
  }

  function getPlayerSkinIcon() {
    const br = getBridge();
    if (!br || !br.getState) return '🍪';
    const st = br.getState();
    const skinId = (st && st.equippedSkin) || 'classic';
    if (skinId === 'shushik') return '⭐';
    const sk = br.SKINS && br.SKINS[skinId];
    return (sk && sk.icon) ? sk.icon : '🍪';
  }

  function getCoins() {
    const br = getBridge();
    if (!br || !br.getState) return 0;
    return Math.max(0, Math.floor(Number(br.getState().coins) || 0));
  }

  function setCoins(newCoins) {
    const br = getBridge();
    const clean = Math.max(0, Math.round(Number(newCoins) || 0));
    if (br && br.applyExternalState) {
      br.applyExternalState({ coins: clean });
    }
    updateWalletHeader();
  }

  function notify(msg) {
    const br = getBridge();
    if (br && br.showToast) br.showToast(msg);
  }

  function haptic(type = 'light') {
    try {
      const tg = window.Telegram && window.Telegram.WebApp;
      if (tg && tg.HapticFeedback) tg.HapticFeedback.impactOccurred(type);
    } catch (_) {}
  }

  // --- Форматирование чисел и времени ---
  function fmtCompact(n) {
    const v = Math.max(0, Math.floor(Number(n) || 0));
    if (v >= 1e9) return (v / 1e9).toFixed(v % 1e9 === 0 ? 0 : 2).replace(/\.0+$/, '') + 'B';
    if (v >= 1e6) return (v / 1e6).toFixed(v % 1e6 === 0 ? 0 : 2).replace(/\.0+$/, '') + 'M';
    if (v >= 1e3) return (v / 1e3).toFixed(v >= 1e5 || v % 1e3 === 0 ? 0 : 1).replace(/\.0$/, '') + 'K';
    return String(v);
  }

  function fmtFull(n) {
    return Math.max(0, Math.floor(Number(n) || 0)).toLocaleString('ru-RU');
  }

  function normalizeTs(ts) {
    const num = Number(ts) || 0;
    return num < 1e12 ? num * 1000 : num;
  }

  function formatDeadlineTimer(deadlineTs, status) {
    if (status === 'resolved') return { text: '🏆 Завершено', closed: true, done: true };
    if (status === 'refunded') return { text: '🔄 Возврат', closed: true, done: false };
    if (status === 'stopped') return { text: '🔒 Ставки закрыты', closed: true, done: false };

    const endMs = normalizeTs(deadlineTs);
    const diff = endMs - Date.now();
    if (diff <= 0) {
      return { text: '🔒 Ставки закрыты', closed: true, done: false };
    }

    const totalSec = Math.floor(diff / 1000);
    const days = Math.floor(totalSec / 86400);
    const hours = Math.floor((totalSec % 86400) / 3600);
    const mins = Math.floor((totalSec % 3600) / 60);
    const secs = totalSec % 60;

    if (days > 0) {
      return { text: `⏳ ${days}д ${hours}ч ${mins}м`, closed: false, done: false };
    }
    if (hours > 0) {
      return { text: `⏳ ${hours}ч ${mins}м ${secs}с`, closed: false, done: false };
    }
    return { text: `⏳ ${mins}м ${secs}с`, closed: false, done: false };
  }

  // --- Математика Пари-мутуэль с виртуальной подушкой 50 000 ---
  function computeEventStats(ev) {
    const betsMap = (ev && ev.bets && typeof ev.bets === 'object') ? ev.bets : {};
    const betsList = Object.values(betsMap).filter(b => b && Number(b.amount) > 0);

    let pool1 = 0;
    let pool2 = 0;
    const byUserSide1 = {};
    const byUserSide2 = {};

    for (const b of betsList) {
      const amt = Math.floor(Number(b.amount) || 0);
      if (amt <= 0) continue;
      const side = Number(b.side) === 2 ? 2 : 1;
      const uid = String(b.uid || 'anon');
      if (side === 1) {
        pool1 += amt;
        if (!byUserSide1[uid]) {
          byUserSide1[uid] = { uid, name: b.name || 'Игрок', icon: b.icon || '🍪', amount: 0 };
        }
        byUserSide1[uid].amount += amt;
        if (b.icon) byUserSide1[uid].icon = b.icon;
        if (b.name) byUserSide1[uid].name = b.name;
      } else {
        pool2 += amt;
        if (!byUserSide2[uid]) {
          byUserSide2[uid] = { uid, name: b.name || 'Игрок', icon: b.icon || '🍪', amount: 0 };
        }
        byUserSide2[uid].amount += amt;
        if (b.icon) byUserSide2[uid].icon = b.icon;
        if (b.name) byUserSide2[uid].name = b.name;
      }
    }

    const realTotal = pool1 + pool2;

    // Виртуальная подушка +50 000 к каждому исходу ТОЛЬКО для динамического кэфа
    const vPool1 = pool1 + VIRTUAL_CUSHION;
    const vPool2 = pool2 + VIRTUAL_CUSHION;
    const vTotal = vPool1 + vPool2;

    const odds1 = vTotal / vPool1;
    const odds2 = vTotal / vPool2;

    const pct1 = realTotal > 0 ? Math.round((pool1 / realTotal) * 100) : 50;
    const pct2 = realTotal > 0 ? (100 - pct1) : 50;

    const top1 = Object.values(byUserSide1).sort((a, b) => b.amount - a.amount).slice(0, 3);
    const top2 = Object.values(byUserSide2).sort((a, b) => b.amount - a.amount).slice(0, 3);

    const myUid = String(getUserId());
    const myBet1 = byUserSide1[myUid] ? byUserSide1[myUid].amount : 0;
    const myBet2 = byUserSide2[myUid] ? byUserSide2[myUid].amount : 0;

    return {
      pool1,
      pool2,
      realTotal,
      odds1,
      odds2,
      pct1,
      pct2,
      top1,
      top2,
      byUserSide1,
      byUserSide2,
      myBet1,
      myBet2
    };
  }

  // --- Состояние модуля ---
  let eventsData = {};
  let activeDrawer = { eventId: null, side: null, amount: 50000 };
  let adminFormOpen = false;
  let selectedCategoryIcon = '🎮';

  function loadClaimedMap() {
    try {
      return JSON.parse(localStorage.getItem(LOCAL_CLAIMED_KEY) || '{}') || {};
    } catch (_) {
      return {};
    }
  }

  function markClaimed(eventId, uid) {
    const map = loadClaimedMap();
    map[`${eventId}_${uid}`] = true;
    localStorage.setItem(LOCAL_CLAIMED_KEY, JSON.stringify(map));
  }

  function isClaimedLocal(eventId, uid) {
    const map = loadClaimedMap();
    return Boolean(map[`${eventId}_${uid}`]);
  }

  function loadLocalEvents() {
    try {
      const raw = localStorage.getItem(LOCAL_EVENTS_KEY);
      if (raw) {
        const parsed = JSON.parse(raw);
        if (parsed && typeof parsed === 'object' && Object.keys(parsed).length > 0) {
          return parsed;
        }
      }
    } catch (_) {}
    return null;
  }

  function saveLocalEvents(data) {
    try {
      localStorage.setItem(LOCAL_EVENTS_KEY, JSON.stringify(data || {}));
    } catch (_) {}
  }

  function createDefaultSeedEvents() {
    const now = Date.now();
    return {
      ev_seed_cyber: {
        id: 'ev_seed_cyber',
        icon: '🎮',
        title: 'Гранд-Финал CS2: Team Spirit vs NAVI',
        outcome1: 'Spirit',
        outcome2: 'NAVI',
        deadline: now + (1 * 86400 + 14 * 3600 + 25 * 60) * 1000,
        status: 'open',
        createdAt: now - 3600 * 1000,
        bets: {}
      },
      ev_seed_boxing: {
        id: 'ev_seed_boxing',
        icon: '🥊',
        title: 'Бой вечера: Нокаут до 5 раунда',
        outcome1: 'Да (КО)',
        outcome2: 'Решением',
        deadline: now + (8 * 3600 + 40 * 60) * 1000,
        status: 'open',
        createdAt: now - 1800 * 1000,
        bets: {}
      }
    };
  }

  // --- Облачная синхронизация через существующий Firebase URL ---
  async function fetchCloudEvents() {
    const dbUrl = getDbBaseUrl();
    try {
      const res = await fetch(`${dbUrl}/arena_bets/events.json`);
      if (res.ok) {
        const data = await res.json();
        if (data && typeof data === 'object' && Object.keys(data).length > 0) {
          eventsData = data;
          saveLocalEvents(eventsData);
          checkAndProcessMyPayouts();
          updateMainCapsuleBadge();
          renderEventsList();
          return;
        } else if (data === null) {
          // Инициализируем стартовые события, если ветка в базе ещё пуста
          const seed = loadLocalEvents() || createDefaultSeedEvents();
          eventsData = seed;
          saveLocalEvents(eventsData);
          await fetch(`${dbUrl}/arena_bets/events.json`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(seed)
          }).catch(() => {});
          updateMainCapsuleBadge();
          renderEventsList();
          return;
        }
      }
    } catch (_) {}

    if (!eventsData || Object.keys(eventsData).length === 0) {
      eventsData = loadLocalEvents() || createDefaultSeedEvents();
      saveLocalEvents(eventsData);
      updateMainCapsuleBadge();
      renderEventsList();
    }
  }

  async function saveEventToCloud(eventObj) {
    if (!eventObj || !eventObj.id) return;
    eventsData[eventObj.id] = eventObj;
    saveLocalEvents(eventsData);
    updateMainCapsuleBadge();
    const dbUrl = getDbBaseUrl();
    try {
      await fetch(`${dbUrl}/arena_bets/events/${encodeURIComponent(eventObj.id)}.json`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(eventObj)
      });
    } catch (_) {}
  }

  // --- Автоматическое получение выплат победителем / при возврате ---
  async function checkAndProcessMyPayouts() {
    const myUid = String(getUserId());
    if (!myUid || myUid === '0') return;
    const dbUrl = getDbBaseUrl();

    for (const ev of Object.values(eventsData)) {
      if (!ev || !ev.id) continue;
      if (ev.status !== 'resolved' && ev.status !== 'refunded') continue;
      const payouts = ev.payouts || {};
      const myPayout = Math.floor(Number(payouts[myUid]) || 0);
      if (myPayout <= 0) continue;

      const alreadyClaimedCloud = ev.claimedBy && ev.claimedBy[myUid];
      if (alreadyClaimedCloud || isClaimedLocal(ev.id, myUid)) {
        markClaimed(ev.id, myUid);
        continue;
      }

      // Начисляем выигрыш или возврат игроку
      markClaimed(ev.id, myUid);
      if (!ev.claimedBy) ev.claimedBy = {};
      ev.claimedBy[myUid] = true;
      saveLocalEvents(eventsData);

      const newBalance = getCoins() + myPayout;
      setCoins(newBalance);

      if (ev.status === 'Refunded' || ev.status === 'refunded') {
        notify(`🔄 Возврат ставки «${ev.title}»: +${fmtFull(myPayout)} 🪙`);
      } else {
        notify(`🏆 Победа в пари «${ev.title}»! Выплата: +${fmtFull(myPayout)} 🪙`);
      }

      try {
        await fetch(`${dbUrl}/arena_bets/events/${encodeURIComponent(ev.id)}/claimedBy/${encodeURIComponent(myUid)}.json`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(true)
        });
      } catch (_) {}
    }
  }

  // --- Построение DOM оверлея ---
  function ensureOverlayDom() {
    if (document.getElementById('arenaBetsBackdrop')) return;

    const backdrop = document.createElement('div');
    backdrop.id = 'arenaBetsBackdrop';
    backdrop.innerHTML = `
      <div class="arena-bets-sheet" id="arenaBetsSheet">
        <div class="ab-sheet-grabber"></div>
        <div class="ab-sheet-header">
          <div class="ab-sheet-title">
            <span>🔥 ПАРИ</span>
            <span class="ab-tag">ARENA BETS</span>
          </div>
          <div class="ab-header-Controls">
            <div class="ab-wallet-pill">🪙 <span id="abWalletCoins">0</span></div>
            <button class="ab-icon-btn ab-admin-add" id="abAdminToggleBtn" title="Создать событие" style="display:none">➕</button>
            <button class="ab-icon-btn" id="abCloseOverlayBtn" title="Закрыть">✕</button>
          </div>
        </div>
        <div class="ab-sheet-body" id="abSheetBody">
          <div class="ab-admin-create-box" id="abAdminCreateBox"></div>
          <div id="abEventsContainer" style="display:flex;flex-direction:column;gap:14px"></div>
        </div>
      </div>
    `;
    document.body.appendChild(backdrop);

    backdrop.addEventListener('click', (e) => {
      if (e.target === backdrop) closeOverlay();
    });

    document.getElementById('abCloseOverlayBtn').onclick = closeOverlay;

    const adminBtn = document.getElementById('abAdminToggleBtn');
    if (isAdminUser()) {
      adminBtn.style.display = 'inline-flex';
      adminBtn.onclick = () => {
        adminFormOpen = !adminFormOpen;
        renderAdminCreateForm();
      };
    }

    const mainBtn = document.getElementById('arenaBetsOpenBtn');
    if (mainBtn) {
      mainBtn.onclick = openOverlay;
    }
  }

  function updateWalletHeader() {
    const el = document.getElementById('abWalletCoins');
    if (el) el.textContent = fmtFull(getCoins());
  }

  function updateMainCapsuleBadge() {
    const badge = document.getElementById('arenaBetsLiveCount');
    if (!badge) return;
    const now = Date.now();
    const activeCount = Object.values(eventsData).filter(
      ev => ev && ev.status === 'open' && normalizeTs(ev.deadline) > now
    ).length;
    badge.textContent = activeCount;
    badge.style.display = activeCount > 0 ? 'inline-block' : 'none';
  }

  // --- Рендер формы создания события (ТОЛЬКО для ID 594228143) ---
  function renderAdminCreateForm() {
    const box = document.getElementById('abAdminCreateBox');
    const adminBtn = document.getElementById('abAdminToggleBtn');
    if (!box) return;

    if (!isAdminUser()) {
      box.classList.remove('ab-show');
      box.innerHTML = '';
      if (adminBtn) adminBtn.style.display = 'none';
      return;
    }

    if (adminBtn) adminBtn.style.display = 'inline-flex';

    if (!adminFormOpen) {
      box.classList.remove('ab-show');
      return;
    }

    box.classList.add('ab-show');
    const icons = ['🎮', '⚽', '🥊', '🏀', '🏆', '🔥', '🍪'];
    const defaultDeadline = new Date(Date.now() + 24 * 3600 * 1000 - new Date().getTimezoneOffset() * 60000)
      .toISOString()
      .slice(0, 16);

    box.innerHTML = `
      <div class="ab-form-head">
        <span>👑 Новое событие</span>
        <button class="ab-icon-btn" id="abCloseFormBtn" style="width:26px;height:26px;font-size:12px">✕</button>
      </div>
      <div class="ab-cat-picker" id="abCatPicker">
        ${icons.map(ic => `<button type="button" class="ab-cat-chip ${ic === selectedCategoryIcon ? 'active' : ''}" data-ic="${ic}">${ic}</button>`).join('')}
        <input type="text" class="ab-input" id="abCustomIconInp" value="${selectedCategoryIcon}" maxlength="4" style="width:52px;text-align:center;padding:4px" title="Своя иконка">
      </div>
      <input type="text" class="ab-input" id="abTitleInp" placeholder="Заголовок события (в 1 строку)" maxlength="70">
      <div class="ab-input-row">
        <input type="text" class="ab-input" id="abOut1Inp" placeholder="Исход 1 (Вариант А)" maxlength="28">
        <input type="text" class="ab-input" id="abOut2Inp" placeholder="Исход 2 (Вариант Б)" maxlength="28">
      </div>
      <input type="datetime-local" class="ab-input" id="abDeadlineInp" value="${defaultDeadline}">
      <button type="button" class="ab-submit-btn" id="abCreateEventSubmit">⚡ ОПУБЛИКОВАТЬ ПАРИ</button>
    `;

    box.querySelector('#abCloseFormBtn').onclick = () => {
      adminFormOpen = false;
      box.classList.remove('ab-show');
    };

    const customIcInp = box.querySelector('#abCustomIconInp');
    box.querySelectorAll('.ab-cat-chip').forEach(btn => {
      btn.onclick = () => {
        selectedCategoryIcon = btn.dataset.ic;
        customIcInp.value = selectedCategoryIcon;
        box.querySelectorAll('.ab-cat-chip').forEach(b => b.classList.toggle('active', b.dataset.ic === selectedCategoryIcon));
      };
    });

    customIcInp.oninput = () => {
      const val = customIcInp.value.trim();
      if (val) selectedCategoryIcon = val;
    };

    box.querySelector('#abCreateEventSubmit').onclick = async () => {
      if (!isAdminUser()) return;
      const icon = (customIcInp.value.trim() || selectedCategoryIcon || '🎮').slice(0, 4);
      const title = box.querySelector('#abTitleInp').value.trim();
      const outcome1 = box.querySelector('#abOut1Inp').value.trim();
      const outcome2 = box.querySelector('#abOut2Inp').value.trim();
      const deadlineStr = box.querySelector('#abDeadlineInp').value;
      const deadlineTs = deadlineStr ? new Date(deadlineStr).getTime() : 0;

      if (!title) return notify('⚠️ Введите заголовок события');
      if (!outcome1 || !outcome2) return notify('⚠️ Укажите оба исхода');
      if (!deadlineTs || deadlineTs <= Date.now()) return notify('⚠️ Выберите будущую дату и время дедлайна');

      const id = 'ev_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6);
      const newEv = {
        id,
        icon,
        title,
        outcome1,
        outcome2,
        deadline: deadlineTs,
        status: 'open',
        createdAt: Date.now(),
        bets: {}
      };

      adminFormOpen = false;
      box.classList.remove('ab-show');
      await saveEventToCloud(newEv);
      renderEventsList();
      haptic('heavy');
      notify('✅ Событие создано!');
    };
  }

  // --- Логика размещения ставки ---
  async function placeBet(eventId, side, rawAmount) {
    const ev = eventsData[eventId];
    if (!ev) return;

    const timerState = formatDeadlineTimer(ev.deadline, ev.status);
    if (timerState.closed || ev.status !== 'open' || Date.now() >= normalizeTs(ev.deadline)) {
      notify('🔒 Ставки на это событие уже закрыты!');
      renderEventsList();
      return;
    }

    const amount = Math.floor(Number(rawAmount) || 0);
    if (amount <= 0) {
      notify('⚠️ Укажите сумму ставки');
      return;
    }

    const balance = getCoins();
    if (amount > balance) {
      notify(`🪙 Недостаточно средств! Баланс: ${fmtFull(balance)} 🪙`);
      return;
    }

    // Списываем коины с баланса игрока
    setCoins(balance - amount);

    const uid = String(getUserId());
    const betId = `bet_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
    const betEntry = {
      id: betId,
      uid,
      name: getPlayerName(),
      icon: getPlayerSkinIcon(),
      side: Number(side) === 2 ? 2 : 1,
      amount,
      ts: Date.now()
    };

    if (!ev.bets || typeof ev.bets !== 'object') ev.bets = {};
    ev.bets[betId] = betEntry;

    activeDrawer = { eventId: null, side: null, amount: 50000 };
    saveLocalEvents(eventsData);
    renderEventsList();
    haptic('heavy');
    notify(`⚡ Ставка ${fmtCompact(amount)} 🪙 на «${side === 1 ? ev.outcome1 : ev.outcome2}» принята!`);

    const dbUrl = getDbBaseUrl();
    try {
      await fetch(`${dbUrl}/arena_bets/events/${encodeURIComponent(eventId)}/bets/${encodeURIComponent(betId)}.json`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(betEntry)
      });
    } catch (_) {}
  }

  // --- Админ-действия над событием (ТОЛЬКО ID 594228143) ---
  async function adminStopEvent(eventId) {
    if (!isAdminUser()) return;
    const ev = eventsData[eventId];
    if (!ev) return;
    ev.status = 'stopped';
    if (activeDrawer.eventId === eventId) {
      activeDrawer = { eventId: null, side: null, amount: 50000 };
    }
    await saveEventToCloud(ev);
    renderEventsList();
    haptic('medium');
    notify('🛑 Приём ставок остановлен');
  }

  async function adminResolveEvent(eventId, winningSide) {
    if (!isAdminUser()) return;
    const ev = eventsData[eventId];
    if (!ev || ev.status === 'resolved' || ev.status === 'refunded') return;

    const stats = computeEventStats(ev);
    const winnersMap = winningSide === 1 ? stats.byUserSide1 : stats.byUserSide2;
    const winnerPool = winningSide === 1 ? stats.pool1 : stats.pool2;
    const loserPool = winningSide === 1 ? stats.pool2 : stats.pool1;

    const payouts = {};
    const winnerEntries = Object.values(winnersMap);

    if (winnerEntries.length > 0 && winnerPool > 0) {
      let distributedLoserPool = 0;
      // 100% пула проигравших распределяется победителям пропорционально их доле в пуле победителей (+ возврат их ставки)
      winnerEntries.sort((a, b) => b.amount - a.amount);
      for (const w of winnerEntries) {
        const shareOfLosers = Math.floor((w.amount / winnerPool) * loserPool);
        distributedLoserPool += shareOfLosers;
        payouts[w.uid] = w.amount + shareOfLosers;
      }
      // Остаток от целочисленного округления (1-2 коина) отдаём крупнейшему победителю, чтобы 100% пула ушло игрокам
      const remainder = loserPool - distributedLoserPool;
      if (remainder > 0) {
        const topWinnerUid = winnerEntries[0].uid;
        payouts[topWinnerUid] = (payouts[topWinnerUid] || 0) + remainder;
      }
    }

    ev.status = 'resolved';
    ev.winner = winningSide;
    ev.resolvedAt = Date.now();
    ev.payouts = payouts;
    ev.claimedBy = ev.claimedBy || {};

    if (activeDrawer.eventId === eventId) {
      activeDrawer = { eventId: null, side: null, amount: 50000 };
    }

    // Синхронизируем балансы победителей в облачной таблице игроков
    const dbUrl = getDbBaseUrl();
    for (const [uid, payAmt] of Object.entries(payouts)) {
      if (payAmt <= 0) continue;
      if (String(uid) === String(getUserId())) {
        markClaimed(ev.id, uid);
        ev.claimedBy[uid] = true;
        setCoins(getCoins() + payAmt);
      } else {
        fetch(`${dbUrl}/players/${encodeURIComponent(uid)}.json`)
          .then(r => (r.ok ? r.json() : null))
          .then(pData => {
            if (pData && typeof pData === 'object') {
              const updatedCoins = Math.round((Number(pData.coins) || 0) + payAmt);
              return fetch(`${dbUrl}/players/${encodeURIComponent(uid)}.json`, {
                method: 'PATCH',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ coins: updatedCoins })
              });
            }
          })
          .catch(() => {});
      }
    }

    await saveEventToCloud(ev);
    renderEventsList();
    haptic('heavy');
    const winLabel = winningSide === 1 ? ev.outcome1 : ev.outcome2;
    notify(`🏆 Победа «${winLabel}»! Пул (${fmtCompact(stats.realTotal)} 🪙) распределён победителям.`);
  }

  async function adminRefundEvent(eventId) {
    if (!isAdminUser()) return;
    const ev = eventsData[eventId];
    if (!ev || ev.status === 'resolved' || ev.status === 'refunded') return;

    const stats = computeEventStats(ev);
    const payouts = {};

    for (const u of Object.values(stats.byUserSide1)) {
      payouts[u.uid] = (payouts[u.uid] || 0) + u.amount;
    }
    for (const u of Object.values(stats.byUserSide2)) {
      payouts[u.uid] = (payouts[u.uid] || 0) + u.amount;
    }

    ev.status = 'refunded';
    ev.resolvedAt = Date.now();
    ev.payouts = payouts;
    ev.claimedBy = ev.claimedBy || {};

    if (activeDrawer.eventId === eventId) {
      activeDrawer = { eventId: null, side: null, amount: 50000 };
    }

    const dbUrl = getDbBaseUrl();
    for (const [uid, refundAmt] of Object.entries(payouts)) {
      if (refundAmt <= 0) continue;
      if (String(uid) === String(getUserId())) {
        markClaimed(ev.id, uid);
        ev.claimedBy[uid] = true;
        setCoins(getCoins() + refundAmt);
      } else {
        fetch(`${dbUrl}/players/${encodeURIComponent(uid)}.json`)
          .then(r => (r.ok ? r.json() : null))
          .then(pData => {
            if (pData && typeof pData === 'object') {
              const updatedCoins = Math.round((Number(pData.coins) || 0) + refundAmt);
              return fetch(`${dbUrl}/players/${encodeURIComponent(uid)}.json`, {
                method: 'PATCH',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ coins: updatedCoins })
              });
            }
          })
          .catch(() => {});
      }
    }

    await saveEventToCloud(ev);
    renderEventsList();
    haptic('medium');
    notify('🔄 Событие отменено, все ставки возвращены 1 к 1');
  }

  // --- Рендер списка карточек событий ---
  function renderEventsList() {
    const container = document.getElementById('abEventsContainer');
    if (!container) return;

    updateWalletHeader();
    renderAdminCreateForm();

    const list = Object.values(eventsData)
      .filter(ev => ev && ev.id && ev.title)
      .sort((a, b) => {
        const aOpen = a.status === 'open' && normalizeTs(a.deadline) > Date.now() ? 1 : 0;
        const bOpen = b.status === 'open' && normalizeTs(b.deadline) > Date.now() ? 1 : 0;
        if (aOpen !== bOpen) return bOpen - aOpen;
        return (Number(b.createdAt) || 0) - (Number(a.createdAt) || 0);
      });

    if (list.length === 0) {
      container.innerHTML = `
        <div class="ab-empty">
          <div class="ab-empty-ic">🎯</div>
          <b>Активных пари пока нет</b>
          <span>Скоро здесь появятся новые события!</span>
        </div>
      `;
      return;
    }

    const admin = isAdminUser();
    container.innerHTML = '';

    list.forEach(ev => {
      const stats = computeEventStats(ev);
      const timer = formatDeadlineTimer(ev.deadline, ev.status);
      const isBettingClosed = timer.closed;
      const isSelected1 = !isBettingClosed && activeDrawer.eventId === ev.id && activeDrawer.side === 1;
      const isSelected2 = !isBettingClosed && activeDrawer.eventId === ev.id && activeDrawer.side === 2;

      const card = document.createElement('div');
      card.className = 'ab-card' +
        (ev.status === 'resolved' ? ' ab-card-resolved' : isBettingClosed ? ' ab-card-closed' : '');
      card.dataset.eventId = ev.id;

      const topRowHtml = (item) => `
        <div class="ab-top-row">
          <span class="ab-top-user">${escapeHtml(item.icon || '🍪')} ${escapeHtml(item.name)}</span>
          <span class="ab-top-sum">— ${fmtCompact(item.amount)}</span>
        </div>
      `;

      const selectedOdds = activeDrawer.side === 1 ? stats.odds1 : stats.odds2;
      const selectedName = activeDrawer.side === 1 ? ev.outcome1 : ev.outcome2;
      const potentialWin = Math.floor((Number(activeDrawer.amount) || 0) * selectedOdds);

      card.innerHTML = `
        <!-- 1. Шапка: Иконка, Название в 1 строку, Таймер дедлайна, Общий пул -->
        <div class="ab-card-header">
          <div class="ab-cat-icon">${escapeHtml(ev.icon || '🎮')}</div>
          <div class="ab-event-title" title="${escapeHtml(ev.title)}">${escapeHtml(ev.title)}</div>
          <div class="ab-header-meta">
            <span class="ab-timer-badge ${timer.done ? 'ab-done' : timer.closed ? 'ab-closed' : ''}" data-timer-for="${ev.id}">
              ${timer.text}
            </span>
            <span class="ab-pool-badge">🏦 ${fmtCompact(stats.realTotal)}</span>
          </div>
        </div>

        <!-- 2. Исходы: Две крупные плитки-кнопки -->
        <div class="ab-outcomes-grid">
          <button type="button"
            class="ab-outcome-tile ab-side-1 ${isSelected1 ? 'ab-selected' : ''} ${ev.status === 'resolved' && ev.winner === 1 ? 'ab-winner' : ''}"
            data-side="1"
            ${isBettingClosed ? 'disabled' : ''}>
            <div class="ab-outcome-top">
              <span class="ab-outcome-name">${ev.status === 'resolved' && ev.winner === 1 ? '🏆 ' : ''}${escapeHtml(ev.outcome1)}</span>
              <span class="ab-outcome-pct">${stats.pct1}%</span>
            </div>
            <div class="ab-outcome-odds">x${stats.odds1.toFixed(2)}</div>
            <div class="ab-outcome-sub">
              <span>🪙 ${fmtCompact(stats.pool1)}</span>
              ${stats.myBet1 > 0 ? `<span class="ab-my-bet-tag">Ты: ${fmtCompact(stats.myBet1)}</span>` : ''}
            </div>
            <div class="ab-outcome-bar"><i style="width:${stats.pct1}%"></i></div>
          </button>

          <button type="button"
            class="ab-outcome-tile ab-side-2 ${isSelected2 ? 'ab-selected' : ''} ${ev.status === 'resolved' && ev.winner === 2 ? 'ab-winner' : ''}"
            data-side="2"
            ${isBettingClosed ? 'disabled' : ''}>
            <div class="ab-outcome-top">
              <span class="ab-outcome-name">${ev.status === 'resolved' && ev.winner === 2 ? '🏆 ' : ''}${escapeHtml(ev.outcome2)}</span>
              <span class="ab-outcome-pct">${stats.pct2}%</span>
            </div>
            <div class="ab-outcome-odds">x${stats.odds2.toFixed(2)}</div>
            <div class="ab-outcome-sub">
              <span>🪙 ${fmtCompact(stats.pool2)}</span>
              ${stats.myBet2 > 0 ? `<span class="ab-my-bet-tag">Ты: ${fmtCompact(stats.myBet2)}</span>` : ''}
            </div>
            <div class="ab-outcome-bar"><i style="width:${stats.pct2}%"></i></div>
          </button>
        </div>

        <!-- 3. Выезжающая шторка ставки -->
        ${(isSelected1 || isSelected2) ? `
          <div class="ab-bet-drawer ${isSelected2 ? 'ab-drawer-side-2' : ''}">
            <div class="ab-drawer-top">
              <span class="ab-drawer-choice">Исход: <b>${escapeHtml(selectedName)}</b> (x${selectedOdds.toFixed(2)})</span>
              <span class="ab-pot-win">Выплата: ~${fmtCompact(potentialWin)} 🪙</span>
            </div>
            <div class="ab-amount-box">
              <span>🪙</span>
              <input type="number" class="ab-amount-input" id="abBetAmountInp_${ev.id}" value="${Math.max(0, Math.floor(activeDrawer.amount || 0))}" min="1" step="1000">
            </div>
            <div class="ab-quick-btns">
              <button type="button" class="ab-q-btn" data-q="+50K">+50K</button>
              <button type="button" class="ab-q-btn" data-q="+250K">+250K</button>
              <button type="button" class="ab-q-btn" data-q="50%">50%</button>
              <button type="button" class="ab-q-btn" data-q="ALL">ВСЕ</button>
            </div>
            <button type="button" class="ab-charge-btn" id="abChargeBtn_${ev.id}">⚡ ЗАРЯДИТЬ</button>
          </div>
        ` : ''}

        <!-- 4. Топ-3 крупнейших ставок на каждую сторону -->
        <div class="ab-top-bets">
          <div class="ab-top-col ab-col-1">
            ${stats.top1.length > 0 ? stats.top1.map(topRowHtml).join('') : '<div class="ab-top-empty">Ставок пока нет</div>'}
          </div>
          <div class="ab-top-col ab-col-2">
            ${stats.top2.length > 0 ? stats.top2.map(topRowHtml).join('') : '<div class="ab-top-empty">Ставок пока нет</div>'}
          </div>
        </div>

        <!-- 5. Пульт Админа (ТОЛЬКО для ID 594228143 на активной карточке) -->
        ${(admin && ev.status !== 'resolved' && ev.status !== 'refunded') ? `
          <div class="ab-admin-bar">
            <button type="button" class="ab-adm-btn ab-stop" data-adm="stop">🛑 СТОП</button>
            <button type="button" class="ab-adm-btn ab-win1" data-adm="win1">🏆 П1</button>
            <button type="button" class="ab-adm-btn ab-win2" data-adm="win2">🏆 П2</button>
            <button type="button" class="ab-adm-btn ab-refund" data-adm="refund">🔄 Возврат</button>
          </div>
        ` : ''}
      `;

      // Обработчики кликов по исходам
      card.querySelectorAll('.ab-outcome-tile').forEach(tile => {
        tile.onclick = () => {
          if (isBettingClosed) return;
          const side = Number(tile.dataset.side);
          if (activeDrawer.eventId === ev.id && activeDrawer.side === side) {
            activeDrawer = { eventId: null, side: null, amount: 50000 };
          } else {
            const defaultAmt = Math.min(getCoins() || 50000, 50000);
            activeDrawer = { eventId: ev.id, side, amount: defaultAmt > 0 ? defaultAmt : 50000 };
          }
          haptic('light');
          renderEventsList();
        };
      });

      // Обработчики внутри открытой шторки ставки
      if (isSelected1 || isSelected2) {
        const inp = card.querySelector(`#abBetAmountInp_${ev.id}`);
        const potWinEl = card.querySelector('.ab-pot-win');

        const syncAmountUi = (val) => {
          activeDrawer.amount = Math.max(0, Math.floor(Number(val) || 0));
          if (inp && Number(inp.value) !== activeDrawer.amount) {
            inp.value = activeDrawer.amount;
          }
          if (potWinEl) {
            potWinEl.textContent = `Выплата: ~${fmtCompact(Math.floor(activeDrawer.amount * selectedOdds))} 🪙`;
          }
        };

        if (inp) {
          inp.oninput = () => syncAmountUi(inp.value);
        }

        card.querySelectorAll('.ab-q-btn').forEach(qBtn => {
          qBtn.onclick = () => {
            const mode = qBtn.dataset.q;
            const bal = getCoins();
            let nextAmt = Math.max(0, Math.floor(Number(activeDrawer.amount) || 0));
            if (mode === '+50K') nextAmt += 50000;
            else if (mode === '+250K') nextAmt += 250000;
            else if (mode === '50%') nextAmt = Math.floor(bal * 0.5);
            else if (mode === 'ALL') nextAmt = bal;
            if (bal > 0 && nextAmt > bal) nextAmt = bal;
            syncAmountUi(nextAmt);
            haptic('light');
          };
        });

        const chargeBtn = card.querySelector(`#abChargeBtn_${ev.id}`);
        if (chargeBtn) {
          chargeBtn.onclick = () => placeBet(ev.id, activeDrawer.side, activeDrawer.amount);
        }
      }

      // Обработчики пульта Админа
      if (admin) {
        card.querySelectorAll('.ab-adm-btn').forEach(admBtn => {
          admBtn.onclick = () => {
            const act = admBtn.dataset.adm;
            if (act === 'stop') adminStopEvent(ev.id);
            else if (act === 'win1') adminResolveEvent(ev.id, 1);
            else if (act === 'win2') adminResolveEvent(ev.id, 2);
            else if (act === 'refund') adminRefundEvent(ev.id);
          };
        });
      }

      container.appendChild(card);
    });
  }

  // --- Живой тикер дедлайнов каждую секунду ---
  function tickDeadlines() {
    let needFullRerender = false;
    for (const ev of Object.values(eventsData)) {
      if (!ev || !ev.id) continue;
      const badge = document.querySelector(`[data-timer-for="${ev.id}"]`);
      const timer = formatDeadlineTimer(ev.deadline, ev.status);
      if (badge) {
        if (badge.textContent.trim() !== timer.text) {
          badge.textContent = timer.text;
        }
        const wasClosed = badge.classList.contains('ab-closed') || badge.classList.contains('ab-done');
        if (timer.closed && !wasClosed) {
          needFullRerender = true;
          if (activeDrawer.eventId === ev.id) {
            activeDrawer = { eventId: null, side: null, amount: 50000 };
          }
        }
      }
    }
    updateMainCapsuleBadge();
    if (needFullRerender) {
      renderEventsList();
    }
  }

  function escapeHtml(str) {
    return String(str || '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  // --- Открытие / закрытие оверлея ---
  function openOverlay() {
    ensureOverlayDom();
    const backdrop = document.getElementById('arenaBetsBackdrop');
    if (!backdrop) return;
    updateWalletHeader();
    renderEventsList();
    backdrop.classList.add('ab-open');
    haptic('light');
    fetchCloudEvents();
  }

  function closeOverlay() {
    const backdrop = document.getElementById('arenaBetsBackdrop');
    if (backdrop) backdrop.classList.remove('ab-open');
  }

  // --- Инициализация модуля ---
  function init() {
    ensureOverlayDom();
    eventsData = loadLocalEvents() || createDefaultSeedEvents();
    saveLocalEvents(eventsData);
    updateMainCapsuleBadge();
    fetchCloudEvents();
    setInterval(tickDeadlines, 1000);
    setInterval(fetchCloudEvents, 12000);
  }

  window.ArenaBets = {
    open: openOverlay,
    close: closeOverlay,
    refresh: fetchCloudEvents
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
