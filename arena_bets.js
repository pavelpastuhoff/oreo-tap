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
  // Черновик админ-формы: живёт в state и не теряется при перерисовках/поллинге
  const state = {
    adminDraft: { title: '', out1: '', out2: '', deadline: '', icon: '' }
  };
  let lastListSig = '';
  let adminFormBuilt = false;
  let sheetBuiltKey = '';

  // BlackBox: все действия пользователя в Тотализаторе попадают в Action Breadcrumb Log
  function bb(label) {
    try {
      if (typeof window.__oreoBlackBox === 'function') window.__oreoBlackBox('arena:' + label);
    } catch (_) {}
  }

  function isOverlayOpen() {
    const b = document.getElementById('arenaBetsBackdrop');
    return Boolean(b && b.classList.contains('ab-open'));
  }

  function isTypingInOverlay() {
    const a = document.activeElement;
    const b = document.getElementById('arenaBetsBackdrop');
    if (!a || !b || !b.contains(a)) return false;
    const tag = (a.tagName || '').toUpperCase();
    return tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA';
  }

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
        } else if (data === null && localStorage.getItem('oreo_arena_bets_seeded') === '1') {
          // Ветка пуста после удаления админом — стартовые события НЕ воскрешаем
          eventsData = {};
          saveLocalEvents(eventsData);
          updateMainCapsuleBadge();
          renderEventsList();
          return;
        } else if (data === null) {
          // Инициализируем стартовые события, если ветка в базе ещё пуста
          try { localStorage.setItem('oreo_arena_bets_seeded', '1'); } catch (_) {}
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
            <button class="ab-icon-btn ab-clear-archive" id="abClearArchiveBtn" title="Очистить архив" style="display:none;width:auto;padding:0 8px;font-size:11px">🧹 Очистить архив</button>
            <button class="ab-icon-btn ab-admin-add" id="abAdminToggleBtn" title="Создать событие" style="display:none">➕</button>
            <button class="ab-icon-btn" id="abCloseOverlayBtn" title="Закрыть">✕</button>
          </div>
        </div>
        <div class="ab-sheet-body" id="abSheetBody">
          <div class="ab-admin-create-box" id="arenaAdminFormWrap"></div>
          <div id="arenaEventsList" style="display:flex;flex-direction:column;gap:14px"></div>
        </div>
        <div id="arenaQuickBetSheet" class="ab-quick-sheet" style="display:none"></div>
      </div>
    `;
    document.body.appendChild(backdrop);

    backdrop.addEventListener('click', (e) => {
      if (e.target === backdrop) closeOverlay();
    });

    document.getElementById('abCloseOverlayBtn').onclick = closeOverlay;

    const adminBtn = document.getElementById('abAdminToggleBtn');
    const clearBtn = document.getElementById('abClearArchiveBtn');
    if (isAdminUser()) {
      adminBtn.style.display = 'inline-flex';
      clearBtn.style.display = 'inline-flex';
      clearBtn.onclick = () => adminClearArchive();
      adminBtn.onclick = () => {
        adminFormOpen = !adminFormOpen;
        bb(adminFormOpen ? 'admin_form_open' : 'admin_form_close');
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
    const box = document.getElementById('arenaAdminFormWrap');
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
    // Форма строится ОДИН раз и больше никогда не перезаписывается (черновик сохраняется в state.adminDraft)
    if (adminFormBuilt && box.firstChild) return;
    adminFormBuilt = true;

    const draft = state.adminDraft;
    const icons = ['🎮', '⚽', '🥊', '🏀', '🏆', '🔥', '🍪'];
    const defaultDeadline = new Date(Date.now() + 24 * 3600 * 1000 - new Date().getTimezoneOffset() * 60000)
      .toISOString()
      .slice(0, 16);
    if (!draft.deadline) draft.deadline = defaultDeadline;
    if (draft.icon) selectedCategoryIcon = draft.icon;

    box.innerHTML = `
      <div class="ab-form-head">
        <span>👑 Новое событие</span>
        <button class="ab-icon-btn" id="abCloseFormBtn" style="width:26px;height:26px;font-size:12px">✕</button>
      </div>
      <div class="ab-cat-picker" id="abCatPicker">
        ${icons.map(ic => `<button type="button" class="ab-cat-chip ${ic === selectedCategoryIcon ? 'active' : ''}" data-ic="${ic}">${ic}</button>`).join('')}
        <input type="text" class="ab-input" id="abCustomIconInp" value="${escapeHtml(selectedCategoryIcon)}" maxlength="4" style="width:52px;text-align:center;padding:4px" title="Своя иконка">
      </div>
      <input type="text" class="ab-input" id="abTitleInp" placeholder="Заголовок события (в 1 строку)" maxlength="70" value="${escapeHtml(draft.title)}">
      <div class="ab-input-row">
        <input type="text" class="ab-input" id="abOut1Inp" placeholder="Исход 1 (Вариант А)" maxlength="28" value="${escapeHtml(draft.out1)}">
        <input type="text" class="ab-input" id="abOut2Inp" placeholder="Исход 2 (Вариант Б)" maxlength="28" value="${escapeHtml(draft.out2)}">
      </div>
      <input type="datetime-local" class="ab-input" id="abDeadlineInp" value="${escapeHtml(draft.deadline)}">
      <button type="button" class="ab-submit-btn" id="abCreateEventSubmit">⚡ ОПУБЛИКОВАТЬ ПАРИ</button>
    `;

    // Сохраняем черновик по каждому событию input
    box.addEventListener('input', () => {
      const g = (id) => { const el = box.querySelector(id); return el ? el.value : ''; };
      draft.title = g('#abTitleInp');
      draft.out1 = g('#abOut1Inp');
      draft.out2 = g('#abOut2Inp');
      draft.deadline = g('#abDeadlineInp');
      const ic = g('#abCustomIconInp').trim();
      if (ic) { selectedCategoryIcon = ic; draft.icon = ic; }
    });

    box.querySelector('#abCloseFormBtn').onclick = () => {
      adminFormOpen = false;
      box.classList.remove('ab-show');
    };

    const customIcInp = box.querySelector('#abCustomIconInp');
    box.querySelectorAll('.ab-cat-chip').forEach(btn => {
      btn.onclick = () => {
        selectedCategoryIcon = btn.dataset.ic;
        draft.icon = selectedCategoryIcon;
        customIcInp.value = selectedCategoryIcon;
        box.querySelectorAll('.ab-cat-chip').forEach(b => b.classList.toggle('active', b.dataset.ic === selectedCategoryIcon));
      };
    });

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

      // Успешная публикация: сбрасываем черновик и перестраиваем форму при следующем открытии
      state.adminDraft = { title: '', out1: '', out2: '', deadline: '', icon: '' };
      adminFormOpen = false;
      adminFormBuilt = false;
      box.innerHTML = '';
      box.classList.remove('ab-show');
      bb(`admin_create:${id}`);
      await saveEventToCloud(newEv);
      renderEventsList(true);
      haptic('heavy');
      notify('✅ Событие создано!');
    };
  }

  // --- Админ: удаление события (с возвратом ставок 1 к 1, если событие активно) ---
  async function refundBetsToPlayers(ev) {
    const stats = computeEventStats(ev);
    const refunds = {};
    for (const u of Object.values(stats.byUserSide1)) refunds[u.uid] = (refunds[u.uid] || 0) + u.amount;
    for (const u of Object.values(stats.byUserSide2)) refunds[u.uid] = (refunds[u.uid] || 0) + u.amount;
    const dbUrl = getDbBaseUrl();
    for (const [uid, amt] of Object.entries(refunds)) {
      if (amt <= 0) continue;
      if (String(uid) === String(getUserId())) {
        setCoins(getCoins() + amt);
      } else {
        try {
          const r = await fetch(`${dbUrl}/players/${encodeURIComponent(uid)}.json`);
          const pData = r.ok ? await r.json() : null;
          if (pData && typeof pData === 'object') {
            const updatedCoins = Math.round((Number(pData.coins) || 0) + amt);
            await fetch(`${dbUrl}/players/${encodeURIComponent(uid)}.json`, {
              method: 'PATCH',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ coins: updatedCoins })
            });
          }
        } catch (_) {}
      }
    }
  }

  async function deleteEventFromCloud(eventId) {
    delete eventsData[eventId];
    saveLocalEvents(eventsData);
    try {
      await fetch(`${getDbBaseUrl()}/arena_bets/events/${encodeURIComponent(eventId)}.json`, { method: 'DELETE' });
    } catch (_) {}
  }

  async function adminDeleteEvent(eventId) {
    if (!isAdminUser()) return;
    const ev = eventsData[eventId];
    if (!ev) return;
    bb(`admin_delete:${eventId}`);
    const active = ev.status !== 'resolved' && ev.status !== 'refunded';
    const hasBets = ev.bets && Object.keys(ev.bets).length > 0;
    if (active && hasBets) await refundBetsToPlayers(ev);
    if (activeDrawer.eventId === eventId) {
      activeDrawer = { eventId: null, side: null, amount: 50000 };
    }
    await deleteEventFromCloud(eventId);
    updateMainCapsuleBadge();
    renderEventsList(true);
    haptic('medium');
    notify(active && hasBets ? '🗑 Событие удалено, ставки возвращены 1 к 1' : '🗑 Событие удалено');
  }

  async function adminClearArchive() {
    if (!isAdminUser()) return;
    const done = Object.values(eventsData).filter(ev => ev && (ev.status === 'resolved' || ev.status === 'refunded'));
    bb(`admin_clear_archive:${done.length}`);
    if (done.length === 0) return notify('📭 Архив уже пуст');
    for (const ev of done) await deleteEventFromCloud(ev.id);
    renderEventsList(true);
    haptic('medium');
    notify(`🧹 Архив очищен: удалено ${done.length}`);
  }

  // --- Логика размещения ставки ---
  async function placeBet(eventId, side, rawAmount) {
    const ev = eventsData[eventId];
    if (!ev) return;

    const timerState = formatDeadlineTimer(ev.deadline, ev.status);
    if (timerState.closed || ev.status !== 'open' || Date.now() >= normalizeTs(ev.deadline)) {
      notify('🔒 Ставки на это событие уже закрыты!');
      renderEventsList(true);
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
    renderEventsList(true);
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
    renderEventsList(true);
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
    renderEventsList(true);
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
    renderEventsList(true);
    haptic('medium');
    notify('🔄 Событие отменено, все ставки возвращены 1 к 1');
  }

  // --- Постоянная шторка купона (вне списка карточек, НЕ перезаписывается при поллинге) ---
  function qsStats() {
    const ev = eventsData[activeDrawer.eventId];
    if (!ev) return null;
    const stats = computeEventStats(ev);
    const side = activeDrawer.side === 2 ? 2 : 1;
    return { ev, stats, side, odds: side === 1 ? stats.odds1 : stats.odds2, name: side === 1 ? ev.outcome1 : ev.outcome2 };
  }

  function qsRefreshNumbers() {
    const sheet = document.getElementById('arenaQuickBetSheet');
    const q = qsStats();
    if (!sheet || !q) return;
    const choice = sheet.querySelector('.ab-drawer-choice');
    const win = sheet.querySelector('.ab-pot-win');
    const nextChoice = `Исход: ${q.name} (x${q.odds.toFixed(2)})`;
    if (choice && choice.textContent !== nextChoice) choice.textContent = nextChoice;
    const nextWin = `Выплата: ~${fmtCompact(Math.floor((Number(activeDrawer.amount) || 0) * q.odds))} 🪙`;
    if (win && win.textContent !== nextWin) win.textContent = nextWin;
  }

  function renderQuickBetSheet() {
    const sheet = document.getElementById('arenaQuickBetSheet');
    if (!sheet) return;
    const q = activeDrawer.eventId ? qsStats() : null;
    const closed = q ? formatDeadlineTimer(q.ev.deadline, q.ev.status).closed : true;
    if (!q || closed) {
      if (sheetBuiltKey !== '') {
        sheet.style.display = 'none';
        sheet.innerHTML = '';
        sheetBuiltKey = '';
      }
      if (q && closed) activeDrawer = { eventId: null, side: null, amount: 50000 };
      return;
    }

    const key = `${activeDrawer.eventId}|${q.side}`;
    if (key === sheetBuiltKey) {
      qsRefreshNumbers(); // только textContent, поле ввода не трогаем
      return;
    }
    sheetBuiltKey = key;
    sheet.style.display = 'block';
    sheet.innerHTML = `
      <div class="ab-bet-drawer ${q.side === 2 ? 'ab-drawer-side-2' : ''}">
        <div class="ab-drawer-top">
          <span class="ab-drawer-choice"></span>
          <span class="ab-pot-win"></span>
          <button type="button" class="ab-icon-btn" id="abQsClose" style="width:26px;height:26px;font-size:12px">✕</button>
        </div>
        <div class="ab-amount-box">
          <span>🪙</span>
          <input type="number" class="ab-amount-input" id="abQsAmount" value="${Math.max(0, Math.floor(activeDrawer.amount || 0))}" min="1" step="1000">
        </div>
        <div class="ab-quick-btns">
          <button type="button" class="ab-q-btn" data-q="+50K">+50K</button>
          <button type="button" class="ab-q-btn" data-q="+250K">+250K</button>
          <button type="button" class="ab-q-btn" data-q="50%">50%</button>
          <button type="button" class="ab-q-btn" data-q="ALL">ВСЕ</button>
        </div>
        <button type="button" class="ab-charge-btn" id="abQsCharge">⚡ ЗАРЯДИТЬ</button>
      </div>
    `;
    qsRefreshNumbers();

    const inp = sheet.querySelector('#abQsAmount');
    const syncAmountUi = (val) => {
      activeDrawer.amount = Math.max(0, Math.floor(Number(val) || 0));
      if (inp && Number(inp.value) !== activeDrawer.amount) inp.value = activeDrawer.amount;
      qsRefreshNumbers();
    };
    inp.oninput = () => syncAmountUi(inp.value);

    sheet.querySelector('#abQsClose').onclick = () => {
      bb('quickbet_close');
      activeDrawer = { eventId: null, side: null, amount: 50000 };
      renderEventsList(true);
    };

    sheet.querySelectorAll('.ab-q-btn').forEach(qBtn => {
      qBtn.onclick = () => {
        const mode = qBtn.dataset.q;
        const bal = getCoins();
        let nextAmt = Math.max(0, Math.floor(Number(activeDrawer.amount) || 0));
        if (mode === '+50K') nextAmt += 50000;
        else if (mode === '+250K') nextAmt += 250000;
        else if (mode === '50%') nextAmt = Math.floor(bal * 0.5);
        else if (mode === 'ALL') nextAmt = bal;
        if (bal > 0 && nextAmt > bal) nextAmt = bal;
        bb(`quickbet_amount:${mode}`);
        syncAmountUi(nextAmt);
        haptic('light');
      };
    });

    sheet.querySelector('#abQsCharge').onclick = () => {
      bb(`bet:${activeDrawer.eventId}:s${activeDrawer.side}:${activeDrawer.amount}`);
      placeBet(activeDrawer.eventId, activeDrawer.side, activeDrawer.amount);
    };
  }

  // --- Рендер списка карточек событий ---
  function renderEventsList(force) {
    const container = document.getElementById('arenaEventsList');
    if (!container) return;

    updateWalletHeader();
    renderAdminCreateForm();

    // Не перерисовываем список, если данные не изменились или пользователь вводит текст
    const sig = JSON.stringify([eventsData, activeDrawer.eventId, activeDrawer.side, isAdminUser()]);
    if (!force) {
      if (sig === lastListSig && container.childElementCount > 0) return;
      if (isTypingInOverlay()) return;
    }
    lastListSig = sig;
    renderQuickBetSheet();

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
      const finished = ev.status === 'resolved' || ev.status === 'refunded';

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

      card.innerHTML = `
        <div class="ab-card-header">
          <div class="ab-cat-icon">${escapeHtml(ev.icon || '🎮')}</div>
          <div class="ab-event-title" title="${escapeHtml(ev.title)}">${escapeHtml(ev.title)}</div>
          <div class="ab-header-meta">
            <span class="ab-timer-badge ${timer.done ? 'ab-done' : timer.closed ? 'ab-closed' : ''}" data-timer-for="${ev.id}" data-arena-timer="${ev.id}">${timer.text}</span>
            <span class="ab-pool-badge">🏦 ${fmtCompact(stats.realTotal)}</span>
          </div>
        </div>

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

        <div class="ab-top-bets">
          <div class="ab-top-col ab-col-1">
            ${stats.top1.length > 0 ? stats.top1.map(topRowHtml).join('') : '<div class="ab-top-empty">Ставок пока нет</div>'}
          </div>
          <div class="ab-top-col ab-col-2">
            ${stats.top2.length > 0 ? stats.top2.map(topRowHtml).join('') : '<div class="ab-top-empty">Ставок пока нет</div>'}
          </div>
        </div>

        ${admin ? `
          <div class="ab-admin-bar">
            ${!finished ? `
              <button type="button" class="ab-adm-btn ab-stop" data-adm="stop">🛑 СТОП</button>
              <button type="button" class="ab-adm-btn ab-win1" data-adm="win1">🏆 П1</button>
              <button type="button" class="ab-adm-btn ab-win2" data-adm="win2">🏆 П2</button>
              <button type="button" class="ab-adm-btn ab-refund" data-adm="refund">🔄 Возврат</button>
            ` : ''}
            <button type="button" class="ab-adm-btn ab-delete" data-adm="delete">🗑 Удалить</button>
          </div>
        ` : ''}
      `;

      // Клик по исходу: открывает/закрывает ПОСТОЯННУЮ шторку купона
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
          bb(`select:${ev.id}:s${side}`);
          haptic('light');
          renderEventsList(true);
        };
      });

      // Пульт Админа
      if (admin) {
        card.querySelectorAll('.ab-adm-btn').forEach(admBtn => {
          admBtn.onclick = () => {
            const act = admBtn.dataset.adm;
            bb(`admin_${act}:${ev.id}`);
            if (act === 'stop') adminStopEvent(ev.id);
            else if (act === 'win1') adminResolveEvent(ev.id, 1);
            else if (act === 'win2') adminResolveEvent(ev.id, 2);
            else if (act === 'refund') adminRefundEvent(ev.id);
            else if (act === 'delete') adminDeleteEvent(ev.id);
          };
        });
      }

      container.appendChild(card);
    });
  }

  // --- Живой тикер дедлайнов каждую секунду: ТОЛЬКО textContent, без innerHTML-рендера ---
  function tickDeadlines() {
    for (const ev of Object.values(eventsData)) {
      if (!ev || !ev.id) continue;
      const badge = document.querySelector(`[data-arena-timer="${ev.id}"]`);
      if (!badge) continue;
      const timer = formatDeadlineTimer(ev.deadline, ev.status);
      if (badge.textContent.trim() !== timer.text) badge.textContent = timer.text;

      const wasClosed = badge.classList.contains('ab-closed') || badge.classList.contains('ab-done');
      if (timer.closed && !wasClosed) {
        // Точечное закрытие карточки на месте
        badge.classList.add(timer.done ? 'ab-done' : 'ab-closed');
        const card = badge.closest('.ab-card');
        if (card) {
          card.classList.add('ab-card-closed');
          card.querySelectorAll('.ab-outcome-tile').forEach(t => {
            t.disabled = true;
            t.classList.remove('ab-selected');
          });
        }
        if (activeDrawer.eventId === ev.id) {
          activeDrawer = { eventId: null, side: null, amount: 50000 };
          renderQuickBetSheet();
        }
      }
    }
    updateMainCapsuleBadge();
  }

  function escapeHtml(str) {
    return String(str || '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  // --- Открытие / закрытие оверлея ---
  function setPerfOverlay(open) {
    try { if (window.OreoPerf && window.OreoPerf.setOverlay) window.OreoPerf.setOverlay('arena', open); } catch (_) {}
  }

  function openOverlay() {
    ensureOverlayDom();
    const backdrop = document.getElementById('arenaBetsBackdrop');
    if (!backdrop) return;
    bb('open_overlay');
    setPerfOverlay(true);
    updateWalletHeader();
    renderEventsList(true);
    backdrop.classList.add('ab-open');
    haptic('light');
    fetchCloudEvents();
  }

  function closeOverlay() {
    const backdrop = document.getElementById('arenaBetsBackdrop');
    if (backdrop) backdrop.classList.remove('ab-open');
    bb('close_overlay');
    setPerfOverlay(false);
  }

  // --- Инициализация модуля ---
  function init() {
    ensureOverlayDom();
    eventsData = loadLocalEvents() || createDefaultSeedEvents();
    saveLocalEvents(eventsData);
    updateMainCapsuleBadge();
    fetchCloudEvents();
    setInterval(tickDeadlines, 1000);
    setInterval(() => { if (isOverlayOpen()) fetchCloudEvents(); else if (!document.hidden) fetchCloudEvents(); }, 12000);
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
