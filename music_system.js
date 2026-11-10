/**
 * music_system.js — Музыкальная система ОРЕО (Этап 2)
 * - Зональные эмбиенты (/assets/music/tap_lofi.mp3, poker_synth.mp3, loto_retro.mp3) с плавным кроссфейдом
 * - Быстрый Mute / Unmute с сохранением в localStorage
 * - Личный Бумбокс 📻 + Jamendo API + 10 проверенных Royalty-Free CC0 треков + Превью 15 сек + Shuffle
 * - Музыкальный Автомат (Jukebox) за столами Покера, Шахмат и Русского Лото через Render /api/bot
 */
(() => {
  'use strict';

  const DEFAULT_BACKEND_URL = 'https://oreo-tap.onrender.com/api/bot';
  const DEFAULT_DB_URL = 'https://oreo-tap-default-rtdb.europe-west1.firebasedatabase.app';
  const JAMENDO_API_URL = 'https://api.jamendo.com/v3.0/tracks/';
  const DEFAULT_JAMENDO_CLIENT_ID = window.OREO_JAMENDO_CLIENT_ID || localStorage.getItem('oreo_jamendo_client_id') || 'b6747d04';

  const LS_MUTE_KEY = 'oreo_music_muted';
  const LS_PREFS_KEY = 'oreo_music_prefs_v1';
  const TARGET_VOLUME = 0.68;
  const CROSSFADE_MS = 480;
  const PREVIEW_SECONDS = 15;
  const JUKEBOX_BASE_COST = 10000;

  // Генератор стильных неоновых SVG-обложек (мгновенная загрузка без внешних картинок-заглушек)
  function makeSvgCover(bg1, bg2, accent, emoji, subLabel) {
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="140" height="140" viewBox="0 0 140 140">
      <defs>
        <linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%" stop-color="${bg1}"/>
          <stop offset="100%" stop-color="${bg2}"/>
        </linearGradient>
      </defs>
      <rect width="140" height="140" rx="22" fill="url(#g)"/>
      <circle cx="70" cy="64" r="40" fill="rgba(0,0,0,0.32)" stroke="${accent}" stroke-width="2.5"/>
      <circle cx="70" cy="64" r="14" fill="rgba(255,255,255,0.12)" stroke="${accent}" stroke-width="1.5"/>
      <text x="70" y="73" text-anchor="middle" font-size="28">${emoji}</text>
      <text x="70" y="124" text-anchor="middle" font-family="Segoe UI, Arial, sans-serif" font-weight="800" font-size="12" fill="#ffffff" letter-spacing="1">${subLabel}</text>
    </svg>`;
    return 'data:image/svg+xml;utf8,' + encodeURIComponent(svg);
  }

  // Базовые локальные зональные эмбиенты (хостятся статически в /assets/music/ на GitHub Pages)
  const ZONE_TRACKS = {
    tap: {
      id: 'tap_lofi',
      title: 'Oreo Lo-Fi Chill (Базовый)',
      artist: 'Kainbeats · CC0',
      genre: 'lofi',
      audio_url: 'assets/music/tap_lofi.mp3',
      cover: makeSvgCover('#283593', '#0d1333', '#80d8ff', '🍪', 'TAP LO-FI'),
      price: 0,
      freeDefault: true
    },
    poker: {
      id: 'poker_synth',
      title: 'Neon Birch Synthwave',
      artist: 'Alec Penn Radio · CC0',
      genre: 'synthwave',
      audio_url: 'assets/music/poker_synth.mp3',
      cover: makeSvgCover('#4a148c', '#12082b', '#ff4081', '🃏', 'SYNTH TABLE'),
      price: 0,
      zoneAmbient: true
    },
    loto: {
      id: 'loto_retro',
      title: 'Retro Loto Swing',
      artist: 'Vintage Orchestra · CC0',
      genre: 'retro',
      audio_url: 'assets/music/loto_retro.mp3',
      cover: makeSvgCover('#b71c1c', '#2b1108', '#ffd740', '🎱', 'RETRO LOTO'),
      price: 0,
      zoneAmbient: true
    }
  };

  // 10 предзагруженных проверенных Royalty-Free (CC0 1.0) треков с прямыми аудио-ссылками
  const FALLBACK_CATALOG = [
    {
      id: 'cc0_wip_chill',
      title: 'Warm Cream Chillhop',
      artist: 'Joel Putman',
      genre: 'lofi',
      audio_url: 'https://archive.org/download/Wip1201/Wip.mp3',
      cover: makeSvgCover('#1e3c72', '#2a5298', '#80d8ff', '☕', 'LO-FI BEAT'),
      price: 50000
    },
    {
      id: 'cc0_price_hiphop',
      title: 'Golden Crumb Boom-Bap',
      artist: 'Joel Putman',
      genre: 'hiphop',
      audio_url: 'https://archive.org/download/Price44/Price.mp3',
      cover: makeSvgCover('#3e2723', '#1b0f0a', '#ffb300', '🎤', 'HIP-HOP'),
      price: 65000
    },
    {
      id: 'cc0_pogohm_retro',
      title: 'Retro Arcade Versus',
      artist: 'Arnaud Barbe',
      genre: 'retro',
      audio_url: 'https://archive.org/download/gt473Pogohm-ForTheLulz/2.VersusB.mp3',
      cover: makeSvgCover('#880e4f', '#1a0926', '#ff80ab', '🕹️', 'RETRO 80S'),
      price: 75000
    },
    {
      id: 'cc0_kain_lofi',
      title: 'Midnight Cookie Session',
      artist: 'Kainbeats',
      genre: 'lofi',
      audio_url: 'https://archive.org/download/man9ww/man9ww.mp3',
      cover: makeSvgCover('#004d40', '#071b1e', '#64ffda', '🌙', 'CHILLHOP'),
      price: 90000
    },
    {
      id: 'cc0_wired_elec',
      title: 'Expanding Horizons',
      artist: 'WIRED Lab',
      genre: 'electronic',
      audio_url: 'https://archive.org/download/infected-urine-wired-11-communication/Infected%20Urine%20-%20WIRED%20-%2002%20Expanding%20Horizons.mp3',
      cover: makeSvgCover('#01579b', '#06152d', '#40c4ff', '⚡', 'ELECTRONIC'),
      price: 110000
    },
    {
      id: 'cc0_node1_synth',
      title: 'Neon Birch Grid 01',
      artist: 'Alec Penn Radio',
      genre: 'synthwave',
      audio_url: 'https://archive.org/download/alecpennradio-synthwave/Node%20001.mp3',
      cover: makeSvgCover('#311b92', '#0e0726', '#ea80fc', '🌆', 'SYNTHWAVE'),
      price: 125000
    },
    {
      id: 'cc0_calico_elec',
      title: 'Calico Neon Pulse',
      artist: 'Sugar Wounds',
      genre: 'electronic',
      audio_url: 'https://archive.org/download/sugar-wounds-calico-dreams/Sugar%20Wounds%20-%20Calico%20Dreams%20-%2002%20Calico%20Dreams.mp3',
      cover: makeSvgCover('#006064', '#081824', '#18ffff', '💎', 'ELECTRO'),
      price: 140000
    },
    {
      id: 'cc0_vintage_swing',
      title: '1942 Royal Club Swing',
      artist: 'Vintage Swing Orchestra',
      genre: 'retro',
      audio_url: 'https://archive.org/download/JV-19831-1942-QmaBHL1DgaxmRqWsQroWhcvsTuJx3AobKMzQug5b6kzLyq.mp3/DV522041.mp3',
      cover: makeSvgCover('#bf360c', '#240b04', '#ffd54f', '🎷', 'JAZZ RETRO'),
      price: 150000
    },
    {
      id: 'cc0_node2_synth',
      title: 'Cyber Hold\'em Drive',
      artist: 'Alec Penn Radio',
      genre: 'synthwave',
      audio_url: 'https://archive.org/download/alecpennradio-synthwave/Node%20002.mp3',
      cover: makeSvgCover('#4a148c', '#1a0033', '#ffd740', '👑', 'VIP SYNTH'),
      price: 300000,
      exclusive: true
    },
    {
      id: 'cc0_power_core',
      title: 'Laser Pot Overdrive',
      artist: 'Power Glove',
      genre: 'synthwave',
      audio_url: 'https://archive.org/download/blood-dragon-soundtrack/A3%20HELO-73.mp3',
      cover: makeSvgCover('#b71c1c', '#1c0519', '#ffd740', '🔥', 'VIP CYBER'),
      price: 300000,
      exclusive: true
    },
    // БАГ-ФИХ: добавлен трек «лил птирик» с корректным encodeURIComponent путём к файлу
    {
      id: 'lil_ptiric',
      title: 'lil ptiric',
      artist: 'lil ptiric',
      genre: 'hiphop',
      audio_url: 'assets/music/' + encodeURIComponent('lil ptiric.m4a'),
      cover: makeSvgCover('#1a0033', '#0a001a', '#ff80ab', '🐦', 'LIL PTIRIC'),
      price: 0,
      freeDefault: true
    }
  ];

  const GENRE_LABELS = {
    all: 'Все жанры',
    lofi: 'Lo-Fi',
    synthwave: 'Synthwave',
    electronic: 'Electronic',
    hiphop: 'Hip-Hop',
    retro: 'Retro'
  };

  // --- Состояние плеера ---
  let _muted = localStorage.getItem(LS_MUTE_KEY) === '1';
  let _prefs = { selectedTrackId: 'tap_lofi', shuffle: false, localOwned: ['tap_lofi'], localMeta: {} };
  try {
    const rawPrefs = JSON.parse(localStorage.getItem(LS_PREFS_KEY) || '{}');
    if (rawPrefs && typeof rawPrefs === 'object') {
      _prefs = Object.assign(_prefs, rawPrefs);
      if (!Array.isArray(_prefs.localOwned)) _prefs.localOwned = ['tap_lofi'];
      if (!_prefs.localOwned.includes('tap_lofi')) _prefs.localOwned.unshift('tap_lofi');
      if (!_prefs.localMeta || typeof _prefs.localMeta !== 'object') _prefs.localMeta = {};
    }
  } catch (_) {}

  let _currentZone = 'tap'; // 'tap' | 'poker' | 'chess' | 'arena' | 'loto'
  let _userInteracted = false;
  let _isSleepingOrHidden = false;

  // Двухканальный кроссфейдер
  const _decks = [new Audio(), new Audio()];
  _decks.forEach(a => {
    a.preload = 'auto';
    a.volume = 0;
  });
  let _activeDeckIdx = 0;
  let _activeSrcKey = '';
  let _fadeInterval = null;

  // Превью 15 сек
  const _previewAudio = new Audio();
  _previewAudio.preload = 'none';
  let _previewTrackId = '';
  let _previewSecLeft = 0;
  let _previewTimer = null;

  // Каталог и Jamendo кэш
  let _jamendoTracks = [];
  let _jamendoLoadedGenres = new Set();
  let _jamendoLoading = false;

  // UI состояние модалки
  let _modalMode = 'boombox'; // 'boombox' | 'jukebox'
  let _activeTab = 'catalog'; // 'catalog' | 'collection'
  let _selectedGenre = 'all';
  let _busyTrackId = '';
  let _modalEl = null;

  // Состояние активного мультиплеерного стола (Jukebox)
  let _activeRoom = null; // { roomType, roomId, roomState, barEl }
  let _currentJukeboxUrl = '';
  let _currentJukeboxExpires = 0;
  let _currentJukeboxTitle = '';
  let _currentJukeboxBy = '';
  const _seenJukeboxOrders = new Set();

  // --- Вспомогательные геттеры моста index.html ---
  function getBridge() {
    return window.OreoBridge || null;
  }

  function getBackendUrl() {
    return window.OREO_BACKEND_API_URL || DEFAULT_BACKEND_URL;
  }

  function getDbUrl() {
    const b = getBridge();
    return String((b && b.dbUrl) || window.db || DEFAULT_DB_URL).replace(/\/+$/, '');
  }

  function getTelegramUser() {
    return window.Telegram && window.Telegram.WebApp && window.Telegram.WebApp.initDataUnsafe && window.Telegram.WebApp.initDataUnsafe.user
      ? window.Telegram.WebApp.initDataUnsafe.user
      : null;
  }

  function getInitDataRaw() {
    return (window.Telegram && window.Telegram.WebApp && window.Telegram.WebApp.initData) || '';
  }

  function getUserId() {
    const tgU = getTelegramUser();
    if (tgU && tgU.id) return String(tgU.id);
    const b = getBridge();
    if (b && b.playerId) return String(b.playerId);
    return localStorage.getItem('oreo_anon_id') || '';
  }

  function getCallerHandle() {
    const tgU = getTelegramUser();
    if (tgU && tgU.username) return '@' + String(tgU.username).replace(/^@+/, '');
    const b = getBridge();
    const nm = (tgU && tgU.first_name) || (b && b.playerName) || 'Игрок';
    return String(nm).startsWith('@') ? String(nm) : '@' + String(nm).replace(/\s+/g, '_');
  }

  function getCoins() {
    const b = getBridge();
    const st = b && b.getState ? b.getState() : null;
    return Math.max(0, Math.round(Number(st && st.coins) || 0));
  }

  function fmt(n) {
    return Math.floor(Number(n) || 0).toLocaleString('ru-RU');
  }

  function esc(str) {
    return String(str == null ? '' : str).replace(/[&<>"']/g, c => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    }[c]));
  }

  function toast(msg) {
    const b = getBridge();
    if (b && typeof b.showToast === 'function') {
      b.showToast(msg);
    }
  }

  function savePrefs() {
    try {
      localStorage.setItem(LS_PREFS_KEY, JSON.stringify(_prefs));
    } catch (_) {}
  }

  // --- Реестр треков и коллекция игрока ---
  function getAllKnownTracksMap() {
    const map = new Map();
    map.set(ZONE_TRACKS.tap.id, ZONE_TRACKS.tap);
    FALLBACK_CATALOG.forEach(t => map.set(t.id, t));
    _jamendoTracks.forEach(t => map.set(t.id, t));

    const b = getBridge();
    const st = b && b.getState ? b.getState() : null;
    const cloudMeta = (st && st.ownedTrackMeta && typeof st.ownedTrackMeta === 'object') ? st.ownedTrackMeta : {};
    const mergedMeta = Object.assign({}, _prefs.localMeta || {}, cloudMeta);
    for (const [tid, m] of Object.entries(mergedMeta)) {
      if (!map.has(tid) && m && m.audio_url) {
        map.set(tid, {
          id: tid,
          title: m.title || tid,
          artist: m.artist || 'Jamendo Artist',
          genre: m.genre || 'lofi',
          audio_url: m.audio_url,
          cover: m.cover || makeSvgCover('#283593', '#0d1333', '#40c4ff', '🎵', 'TRACK'),
          price: Number(m.price) || 75000
        });
      }
    }
    return map;
  }

  function getOwnedTrackIds() {
    // БАГ-ФИХ: tap_lofi и lil_ptiric — бесплатные треки, всегда доступны всем игрокам
    const set = new Set(['tap_lofi', 'lil_ptiric']);
    (_prefs.localOwned || []).forEach(id => { if (id) set.add(String(id)); });
    const b = getBridge();
    const st = b && b.getState ? b.getState() : null;
    if (st && st.ownedTracks) {
      const arr = Array.isArray(st.ownedTracks) ? st.ownedTracks : Object.values(st.ownedTracks);
      arr.forEach(id => { if (id) set.add(String(id)); });
    }
    return Array.from(set);
  }

  function isTrackOwned(trackId) {
    return getOwnedTrackIds().includes(String(trackId));
  }

  function getOwnedTracksList() {
    const map = getAllKnownTracksMap();
    const ids = getOwnedTrackIds();
    const list = [];
    ids.forEach(id => {
      const tr = map.get(id);
      if (tr && tr.audio_url) list.push(tr);
    });
    if (!list.length) list.push(ZONE_TRACKS.tap);
    return list;
  }

  // --- Разрешение целевого трека для текущей зоны ---
  function resolveDesiredTrack() {
    const now = Date.now();
    // 1. Если игрок за столом и активен заказ Jukebox (3 минуты не истекли)
    if (_activeRoom && _currentJukeboxUrl && _currentJukeboxExpires > now) {
      return {
        id: 'jukebox_live',
        title: _currentJukeboxTitle || 'Заказ на столе',
        artist: _currentJukeboxBy || 'Jukebox',
        audio_url: _currentJukeboxUrl,
        loop: true
      };
    }

    // 2. Зональные темы игровых столов и оверлеев
    if (_currentZone === 'loto') {
      return { ...ZONE_TRACKS.loto, loop: true };
    }
    if (_currentZone === 'poker' || _currentZone === 'chess' || _currentZone === 'arena') {
      return { ...ZONE_TRACKS.poker, loop: true };
    }

    // 3. Главный экран тапалки: выбранный трек из коллекции или Shuffle
    const owned = getOwnedTracksList();
    if (_prefs.shuffle && owned.length > 1) {
      let cur = owned.find(t => t.id === _prefs.selectedTrackId);
      if (!cur) {
        cur = owned[Math.floor(Math.random() * owned.length)];
        _prefs.selectedTrackId = cur.id;
      }
      return { ...cur, loop: false, isShuffle: true };
    }

    const chosen = owned.find(t => t.id === _prefs.selectedTrackId) || ZONE_TRACKS.tap;
    return { ...chosen, loop: true };
  }

  function pickNextShuffleTrack() {
    const owned = getOwnedTracksList();
    if (owned.length <= 1) return owned[0] || ZONE_TRACKS.tap;
    const pool = owned.filter(t => t.id !== _prefs.selectedTrackId);
    const next = pool[Math.floor(Math.random() * pool.length)] || owned[0];
    _prefs.selectedTrackId = next.id;
    savePrefs();
    return next;
  }

  // --- Плавный кроссфейд между двумя аудио-деками ---
  function normalizeUrlKey(url) {
    return String(url || '').trim();
  }

  function applyPlaybackForCurrentState() {
    updateSideButtonsUi();
    updateNowPlayingBar();

    if (_muted || _isSleepingOrHidden) {
      fadeOutAllDecks();
      return;
    }

    // Если идёт 15-сек превью, фоновые деки приглушены
    if (_previewTrackId) {
      return;
    }

    const target = resolveDesiredTrack();
    if (!target || !target.audio_url) return;

    crossfadeTo(target.audio_url, Boolean(target.loop), () => {
      if (_currentZone === 'tap' && _prefs.shuffle && !_muted && !_previewTrackId) {
        const nextTr = pickNextShuffleTrack();
        applyPlaybackForCurrentState();
        updateModalListOnly();
      }
    });
  }

  function fadeOutAllDecks() {
    if (_fadeInterval) {
      clearInterval(_fadeInterval);
      _fadeInterval = null;
    }
    _decks.forEach(d => {
      try {
        d.volume = 0;
        d.pause();
      } catch (_) {}
    });
  }

  function crossfadeTo(srcUrl, shouldLoop, onEndedCallback) {
    const key = normalizeUrlKey(srcUrl);
    if (!key) return;

    const curDeck = _decks[_activeDeckIdx];
    if (_activeSrcKey === key && !curDeck.paused) {
      curDeck.loop = shouldLoop;
      curDeck.onended = shouldLoop ? null : (onEndedCallback || null);
      if (curDeck.volume < TARGET_VOLUME && !_previewTrackId && !_muted) {
        curDeck.volume = TARGET_VOLUME;
      }
      return;
    }

    if (!_userInteracted) {
      // Сохраняем цель: запустится мгновенно при первом касании экрана
      _activeSrcKey = '';
      return;
    }

    const nextIdx = 1 - _activeDeckIdx;
    const outDeck = _decks[_activeDeckIdx];
    const inDeck = _decks[nextIdx];

    _activeDeckIdx = nextIdx;
    _activeSrcKey = key;

    if (_fadeInterval) {
      clearInterval(_fadeInterval);
      _fadeInterval = null;
    }

    try {
      inDeck.pause();
      inDeck.src = srcUrl;
      inDeck.loop = shouldLoop;
      inDeck.currentTime = 0;
      inDeck.volume = 0.02;
      inDeck.onended = shouldLoop ? null : (onEndedCallback || null);
      const playPromise = inDeck.play();
      if (playPromise && typeof playPromise.catch === 'function') {
        playPromise.catch(() => {
          // Если браузер ещё ждёт жест пользователя, сбросим ключ для автостарта на клике
          _activeSrcKey = '';
        });
      }
    } catch (_) {
      _activeSrcKey = '';
      return;
    }

    const steps = 16;
    const stepMs = Math.max(20, Math.round(CROSSFADE_MS / steps));
    const startOutVol = outDeck ? outDeck.volume : 0;
    let step = 0;

    _fadeInterval = setInterval(() => {
      step++;
      const t = Math.min(1, step / steps);
      if (_muted || _isSleepingOrHidden || _previewTrackId) {
        inDeck.volume = 0;
        if (outDeck) {
          outDeck.volume = 0;
          try { outDeck.pause(); } catch (_) {}
        }
        clearInterval(_fadeInterval);
        _fadeInterval = null;
        return;
      }
      inDeck.volume = Math.min(TARGET_VOLUME, +(TARGET_VOLUME * t).toFixed(3));
      if (outDeck && !outDeck.paused) {
        outDeck.volume = Math.max(0, +(startOutVol * (1 - t)).toFixed(3));
      }
      if (step >= steps) {
        if (outDeck) {
          outDeck.volume = 0;
          try { outDeck.pause(); } catch (_) {}
        }
        clearInterval(_fadeInterval);
        _fadeInterval = null;
      }
    }, stepMs);
  }

  // --- Превью трека (15 секунд) ---
  function stopPreview(resumeBg = true) {
    if (_previewTimer) {
      clearInterval(_previewTimer);
      _previewTimer = null;
    }
    _previewTrackId = '';
    _previewSecLeft = 0;
    try {
      _previewAudio.pause();
      _previewAudio.removeAttribute('src');
    } catch (_) {}

    if (resumeBg && !_muted && !_isSleepingOrHidden) {
      _activeSrcKey = '';
      applyPlaybackForCurrentState();
    }
    updateModalListOnly();
  }

  function togglePreview(track) {
    _userInteracted = true;
    if (!track || !track.audio_url) return;
    if (_previewTrackId === track.id) {
      stopPreview(true);
      return;
    }

    stopPreview(false);
    fadeOutAllDecks();

    _previewTrackId = track.id;
    _previewSecLeft = PREVIEW_SECONDS;
    updateModalListOnly();

    try {
      _previewAudio.src = track.audio_url;
      _previewAudio.currentTime = 0;
      _previewAudio.volume = 0.82;
      _previewAudio.play().catch(() => {
        toast('⚠️ Не удалось загрузить превью этого трека');
        stopPreview(true);
      });
    } catch (_) {
      stopPreview(true);
      return;
    }

    _previewAudio.onended = () => stopPreview(true);
    _previewTimer = setInterval(() => {
      _previewSecLeft--;
      if (_previewSecLeft <= 0) {
        stopPreview(true);
      } else {
        const btn = _modalEl && _modalEl.querySelector(`[data-om-preview="${CSS.escape(track.id)}"]`);
        if (btn) btn.textContent = `⏹ Стоп (${_previewSecLeft}с)`;
      }
    }, 1000);
  }

  // --- Mute / Unmute ---
  function setMuted(nextMuted, withToast = true) {
    _userInteracted = true;
    _muted = Boolean(nextMuted);
    try {
      localStorage.setItem(LS_MUTE_KEY, _muted ? '1' : '0');
    } catch (_) {}

    if (_muted) {
      stopPreview(false);
      fadeOutAllDecks();
      if (withToast) toast('🔇 Музыка выключена (Mute)');
    } else {
      _activeSrcKey = '';
      applyPlaybackForCurrentState();
      if (withToast) {
        const cur = resolveDesiredTrack();
        toast(`🔊 Звук включён: ${cur.title}`);
      }
    }
    updateSideButtonsUi();
    updateModalHeaderUi();
    updateNowPlayingBar();
  }

  function toggleMute() {
    setMuted(!_muted, true);
  }

  // --- Интеграция с Jamendo API + Fallback ---
  function computeJamendoTrackPrice(item, idx) {
    const rawId = Number(item && item.id) || (idx + 1);
    if (idx === 0 && rawId % 5 === 0) return 300000;
    const tiers = [50000, 65000, 80000, 95000, 120000, 150000];
    return tiers[rawId % tiers.length];
  }

  function detectJamendoGenre(item, requestedGenre) {
    if (requestedGenre && requestedGenre !== 'all') return requestedGenre;
    const genres = (item && item.musicinfo && item.musicinfo.tags && item.musicinfo.tags.genres) || [];
    const joined = genres.join(' ').toLowerCase();
    if (joined.includes('synth') || joined.includes('retrowave')) return 'synthwave';
    if (joined.includes('hiphop') || joined.includes('rap')) return 'hiphop';
    if (joined.includes('jazz') || joined.includes('retro') || joined.includes('swing')) return 'retro';
    if (joined.includes('electronic') || joined.includes('house') || joined.includes('techno')) return 'electronic';
    return 'lofi';
  }

  async function fetchJamendoCatalog(genre = 'all') {
    const cacheKey = genre || 'all';
    if (_jamendoLoadedGenres.has(cacheKey) || _jamendoLoading) return;

    _jamendoLoading = true;
    updateModalListOnly();

    const tags = genre === 'all' ? 'lofi+synthwave+electronic+hiphop+retro' : genre;
    const url = `${JAMENDO_API_URL}?client_id=${encodeURIComponent(DEFAULT_JAMENDO_CLIENT_ID)}&format=json&limit=14&include=musicinfo&audioformat=mp32&order=popularity_month&fuzzytags=${encodeURIComponent(tags)}`;

    const ctrl = typeof AbortController !== 'undefined' ? new AbortController() : null;
    const timer = ctrl ? setTimeout(() => ctrl.abort(), 3600) : null;

    try {
      const resp = await fetch(url, { signal: ctrl ? ctrl.signal : undefined });
      if (resp.ok) {
        const data = await resp.json();
        const results = Array.isArray(data && data.results) ? data.results : [];
        const existingIds = new Set(_jamendoTracks.map(t => t.id));

        results.forEach((item, idx) => {
          const audioUrl = String((item && item.audio) || '').trim();
          if (!audioUrl.startsWith('https://')) return;
          const tid = `jam_${item.id}`;
          if (existingIds.has(tid)) return;
          existingIds.add(tid);
          const price = computeJamendoTrackPrice(item, idx);
          const g = detectJamendoGenre(item, genre);
          _jamendoTracks.push({
            id: tid,
            title: String(item.name || 'Jamendo Track').slice(0, 70),
            artist: String(item.artist_name || 'Jamendo Artist').slice(0, 60),
            genre: g,
            audio_url: audioUrl,
            cover: String(item.album_image || item.image || '').startsWith('https://')
              ? (item.album_image || item.image)
              : makeSvgCover('#311b92', '#0d1333', '#40c4ff', '🎧', g.toUpperCase()),
            price,
            exclusive: price >= 300000,
            fromJamendo: true
          });
        });
        _jamendoLoadedGenres.add(cacheKey);
      }
    } catch (_) {
      // Fallback-список уже в памяти и отображается мгновенно без задержек
    } finally {
      if (timer) clearTimeout(timer);
      _jamendoLoading = false;
      updateModalListOnly();
    }
  }

  function getCatalogTracksForGenre(genre) {
    // Объединяем живые результаты Jamendo + проверенный Royalty-Free каталог
    const combined = [..._jamendoTracks, ...FALLBACK_CATALOG];
    if (!genre || genre === 'all') return combined;
    return combined.filter(t => t.genre === genre);
  }

  // --- Синхронизация локального баланса перед вызовом Render API ---
  async function flushPlayerCoinsToCloudIfNeeded() {
    const uid = getUserId();
    const b = getBridge();
    const st = b && b.getState ? b.getState() : null;
    if (!uid || !st) return;
    const coins = Math.max(0, Math.round(Number(st.coins) || 0));
    try {
      await fetch(`${getDbUrl()}/players/${encodeURIComponent(uid)}.json`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          id: uid,
          name: (b && b.playerName) || 'Тапер ОРЕО',
          coins,
          taps: coins,
          count: coins,
          ts: Date.now()
        })
      });
    } catch (_) {}
  }

  async function callBackendMusicApi(action, payload) {
    const headers = { 'Content-Type': 'application/json' };
    const initData = getInitDataRaw();
    if (initData) headers['X-Telegram-Init-Data'] = initData;

    const resp = await fetch(`${getBackendUrl()}?action=${encodeURIComponent(action)}`, {
      method: 'POST',
      headers,
      body: JSON.stringify(Object.assign({ action }, payload))
    });
    const data = await resp.json();
    return data;
  }

  // --- Покупка трека (ЗАДАЧА 2 & ЗАДАЧА 4) ---
  async function handleBuyTrack(track) {
    _userInteracted = true;
    if (!track || _busyTrackId) return;
    if (isTrackOwned(track.id)) {
      selectTrackForTap(track.id, false);
      return;
    }

    const myCoins = getCoins();
    if (myCoins < track.price) {
      toast(`🪙 Недостаточно коинов: нужно ${fmt(track.price)} 🪙`);
      return;
    }

    const uid = getUserId();
    if (!uid) {
      toast('⚠️ Не удалось определить ID профиля');
      return;
    }

    _busyTrackId = track.id;
    updateModalListOnly();

    try {
      await flushPlayerCoinsToCloudIfNeeded();
      const res = await callBackendMusicApi('buy_track', {
        user_id: uid,
        track_id: track.id,
        price: track.price,
        meta: {
          title: track.title,
          artist: track.artist,
          genre: track.genre,
          audio_url: track.audio_url,
          cover: track.cover
        }
      });

      if (!res || !res.ok) {
        toast((res && res.message) || '⚠️ Сервер Render просыпается, попробуйте через пару секунд');
        return;
      }

      const ownedTracks = Array.isArray(res.ownedTracks) ? res.ownedTracks : [...getOwnedTrackIds(), track.id];
      const ownedMeta = Object.assign({}, _prefs.localMeta || {}, res.ownedTrackMeta || {}, {
        [track.id]: {
          title: track.title,
          artist: track.artist,
          genre: track.genre,
          audio_url: track.audio_url,
          cover: track.cover,
          price: track.price
        }
      });

      _prefs.localOwned = ownedTracks;
      _prefs.localMeta = ownedMeta;
      _prefs.selectedTrackId = track.id;
      savePrefs();

      const b = getBridge();
      if (b && typeof b.applyExternalState === 'function') {
        b.applyExternalState({
          coins: Number(res.coins),
          count: Number(res.coins),
          ownedTracks,
          ownedTrackMeta: ownedMeta
        });
      }

      if (res.already_owned) {
        toast(`✅ Трек «${track.title}» уже в вашей коллекции!`);
      } else {
        toast(`🎉 Куплен трек «${track.title}»! Включён в плеере`);
      }

      stopPreview(false);
      _activeSrcKey = '';
      // БАГ-ФИХ: после покупки сразу включаем трек — выключаем Mute если был, и запускаем воспроизведение
      if (_muted) {
        setMuted(false, false);
      } else {
        applyPlaybackForCurrentState();
      }
    } catch (_) {
      toast('⏳ Сервер Render запускается (~15 сек). Попробуйте нажать ещё раз!');
    } finally {
      _busyTrackId = '';
      updateModalHeaderUi();
      updateModalListOnly();
    }
  }

  function selectTrackForTap(trackId, enableShuffle = false) {
    _userInteracted = true;
    _prefs.selectedTrackId = trackId;
    _prefs.shuffle = Boolean(enableShuffle);
    savePrefs();
    stopPreview(false);
    if (_muted) {
      setMuted(false, false);
    } else {
      _activeSrcKey = '';
      applyPlaybackForCurrentState();
    }
    const map = getAllKnownTracksMap();
    const tr = map.get(trackId);
    if (tr) toast(`📻 Играет: ${tr.title}`);
    updateModalListOnly();
    updateNowPlayingBar();
  }

  function toggleShuffleMode() {
    _userInteracted = true;
    const owned = getOwnedTracksList();
    if (owned.length < 2 && !_prefs.shuffle) {
      toast('💿 Купите хотя бы 1 дополнительный трек для режима Shuffle!');
      return;
    }
    _prefs.shuffle = !_prefs.shuffle;
    if (_prefs.shuffle) {
      const next = pickNextShuffleTrack();
      toast(`🔀 Режим Shuffle включён! Сейчас: ${next.title}`);
    } else {
      toast('🔁 Режим повтора выбранного трека');
    }
    savePrefs();
    stopPreview(false);
    _activeSrcKey = '';
    applyPlaybackForCurrentState();
    renderModalContent();
  }

  // --- Заказ музыки на стол (Jukebox — ЗАДАЧА 3 & ЗАДАЧА 4) ---
  function getRoomJukeboxCost(roomState) {
    const st = roomState || (_activeRoom && _activeRoom.roomState) || {};
    const jb = (st && st.jukebox && typeof st.jukebox === 'object') ? st.jukebox : {};
    const exp = Number(jb.expires_at || st.expires_at || 0);
    const url = String(jb.current_track_url || st.current_track_url || '').trim();
    if (url && exp > Date.now()) {
      const prevPrice = Number(jb.order_price) || JUKEBOX_BASE_COST;
      return Math.max(JUKEBOX_BASE_COST * 2, prevPrice * 2);
    }
    return JUKEBOX_BASE_COST;
  }

  async function handleOrderJukebox(track) {
    _userInteracted = true;
    if (!track || !_activeRoom || !_activeRoom.roomId || _busyTrackId) return;

    const cost = getRoomJukeboxCost(_activeRoom.roomState);
    const myCoins = getCoins();
    if (myCoins < cost) {
      toast(`🪙 Недостаточно коинов: для заказа на стол нужно ${fmt(cost)} 🪙`);
      return;
    }

    const uid = getUserId();
    if (!uid) {
      toast('⚠️ Не удалось определить ID игрока');
      return;
    }

    // Разрешаем абсолютный URL для локальных файлов, если трек из /assets/music/
    let resolvedUrl = track.audio_url;
    if (resolvedUrl.startsWith('assets/music/')) {
      resolvedUrl = resolvedUrl; // валидно на GitHub Pages для всех клиентов
    }

    _busyTrackId = track.id;
    updateModalListOnly();

    try {
      await flushPlayerCoinsToCloudIfNeeded();
      const res = await callBackendMusicApi('order_jukebox', {
        user_id: uid,
        room_type: _activeRoom.roomType,
        room_id: _activeRoom.roomId,
        track_id: track.id,
        track_url: resolvedUrl,
        track_title: track.title,
        track_artist: track.artist,
        ordered_by: getCallerHandle()
      });

      if (!res || !res.ok) {
        toast((res && res.message) || '⚠️ Не удалось заказать трек на стол, попробуйте ещё раз');
        return;
      }

      const b = getBridge();
      if (b && typeof b.applyExternalState === 'function') {
        b.applyExternalState({
          coins: Number(res.coins),
          count: Number(res.coins)
        });
      }

      stopPreview(false);
      // Мгновенно синхронизируем у себя, остальные игроки получат через onValue Firebase
      if (_activeRoom) {
        const nextRoomState = Object.assign({}, _activeRoom.roomState || {}, {
          current_track_url: res.current_track_url,
          ordered_by: res.ordered_by,
          expires_at: res.expires_at,
          jukebox: res.jukebox
        });
        syncRoomJukebox(_activeRoom.roomType, _activeRoom.roomId, nextRoomState, _activeRoom.barEl);
      }
      closeModal();
    } catch (_) {
      toast('⏳ Сервер Render просыпается (~15 сек). Повторите заказ через пару секунд!');
    } finally {
      _busyTrackId = '';
      updateModalHeaderUi();
      updateModalListOnly();
    }
  }

  function formatCallerAt(rawCaller) {
    const clean = String(rawCaller || 'Игрок').trim();
    if (!clean) return '@player';
    return clean.startsWith('@') ? clean : `@${clean}`;
  }

  function formatMmSs(msLeft) {
    const totalSec = Math.max(0, Math.ceil(msLeft / 1000));
    const m = Math.floor(totalSec / 60);
    const s = totalSec % 60;
    return `${m}:${String(s).padStart(2, '0')}`;
  }

  function syncRoomJukebox(roomType, roomId, roomState, barEl) {
    const prevZone = _currentZone;
    if (roomType === 'poker' || roomType === 'chess' || roomType === 'loto') {
      _currentZone = roomType;
    }

    _activeRoom = {
      roomType,
      roomId: String(roomId || ''),
      roomState: roomState || {},
      barEl: barEl || (_activeRoom && _activeRoom.barEl) || null
    };

    const jb = (roomState && roomState.jukebox && typeof roomState.jukebox === 'object') ? roomState.jukebox : {};
    const url = String(jb.current_track_url || (roomState && roomState.current_track_url) || '').trim();
    const exp = Number(jb.expires_at || (roomState && roomState.expires_at) || 0);
    const by = formatCallerAt(jb.ordered_by || (roomState && roomState.ordered_by) || '');
    const title = String(jb.track_title || 'Музыка стола').trim();
    const orderKey = String(jb.order_id || `${roomId}_${url}_${exp}`);
    const now = Date.now();

    if (url && exp > now) {
      const changed = (_currentJukeboxUrl !== url) || (_currentJukeboxExpires !== exp);
      _currentJukeboxUrl = url;
      _currentJukeboxExpires = exp;
      _currentJukeboxTitle = title;
      _currentJukeboxBy = by;

      if (!_seenJukeboxOrders.has(orderKey)) {
        _seenJukeboxOrders.add(orderKey);
        toast(`🔊 ${by} поставил трек: ${title}!`);
      }

      if (changed || prevZone !== _currentZone) {
        applyPlaybackForCurrentState();
      }
    } else if (_currentJukeboxUrl) {
      _currentJukeboxUrl = '';
      _currentJukeboxExpires = 0;
      _currentJukeboxTitle = '';
      _currentJukeboxBy = '';
      _activeSrcKey = '';
      applyPlaybackForCurrentState();
    } else if (prevZone !== _currentZone) {
      applyPlaybackForCurrentState();
    }

    renderRoomJukeboxBar();
  }

  function renderRoomJukeboxBar() {
    if (!_activeRoom || !_activeRoom.barEl) return;
    const bar = _activeRoom.barEl;
    const rem = _currentJukeboxExpires - Date.now();
    if (!_currentJukeboxUrl || rem <= 0) {
      bar.hidden = true;
      bar.innerHTML = '';
      return;
    }
    bar.hidden = false;
    bar.className = 'om-table-jb-bar';
    bar.innerHTML = `
      <span class="om-table-jb-txt">🔊 <b>${esc(_currentJukeboxTitle)}</b> · заказал ${esc(_currentJukeboxBy)}</span>
      <span class="om-table-jb-timer">⏱ ${formatMmSs(rem)}</span>
    `;
  }

  function leaveRoom() {
    const hadJukebox = Boolean(_currentJukeboxUrl);
    _activeRoom = null;
    _currentJukeboxUrl = '';
    _currentJukeboxExpires = 0;
    _currentJukeboxTitle = '';
    _currentJukeboxBy = '';
    if (hadJukebox) {
      _activeSrcKey = '';
      applyPlaybackForCurrentState();
    }
  }

  // Ежесекундный тикер истечения 3-минутного заказа Jukebox
  setInterval(() => {
    if (_activeRoom && _currentJukeboxExpires > 0) {
      if (Date.now() >= _currentJukeboxExpires) {
        _currentJukeboxUrl = '';
        _currentJukeboxExpires = 0;
        _currentJukeboxTitle = '';
        _currentJukeboxBy = '';
        renderRoomJukeboxBar();
        _activeSrcKey = '';
        applyPlaybackForCurrentState();
      } else {
        renderRoomJukeboxBar();
      }
    }
  }, 1000);

  // --- UI боковых кнопок на главном экране ---
  function updateSideButtonsUi() {
    const muteBtn = document.getElementById('musicToggleBtn');
    const muteTxt = document.getElementById('musicStatusTxt');
    if (muteBtn) {
      muteBtn.classList.toggle('active', !_muted);
      const firstNode = muteBtn.firstChild;
      if (firstNode && firstNode.nodeType === Node.TEXT_NODE) {
        firstNode.nodeValue = _muted ? '🔇' : '🔊';
      }
    }
    if (muteTxt) {
      muteTxt.textContent = _muted ? 'MUTE' : 'ВКЛ';
    }

    const boomBtn = document.getElementById('boomboxOpenBtn');
    const boomTxt = document.getElementById('boomboxStatusTxt');
    if (boomBtn) {
      const customActive = !_muted && (_prefs.shuffle || _prefs.selectedTrackId !== 'tap_lofi');
      boomBtn.classList.toggle('playing', customActive);
    }
    if (boomTxt) {
      boomTxt.textContent = _prefs.shuffle ? 'SHUFFLE' : 'РАДИО';
    }
  }

  // --- Модальное окно Бумбокса / Jukebox ---
  function ensureModalDom() {
    if (_modalEl) return _modalEl;
    const el = document.createElement('div');
    el.className = 'om-backdrop';
    el.id = 'oreoMusicBackdrop';
    el.innerHTML = `
      <div class="om-sheet" role="dialog" aria-modal="true">
        <div class="om-head">
          <div class="om-head-title">
            <div class="om-head-icon" id="omHeadIcon">📻</div>
            <div style="min-width:0">
              <h3 id="omHeadTitle">Личный Бумбокс</h3>
              <div class="om-head-sub" id="omHeadSub">Jamendo Радио & Коллекция ОРЕО</div>
            </div>
          </div>
          <div class="om-head-actions">
            <span class="om-wallet-pill" id="omWalletPill">🪙 0</span>
            <button type="button" class="om-icon-btn" id="omMuteModalBtn" title="Mute / Unmute">🔊</button>
            <button type="button" class="om-icon-btn" id="omCloseModalBtn" title="Закрыть">✕</button>
          </div>
        </div>
        <div class="om-nowbar" id="omNowBar"></div>
        <div id="omJukeboxHeroWrap"></div>
        <div class="om-tabs" id="omTabsWrap"></div>
        <div class="om-subbar" id="omSubBar"></div>
        <div class="om-body" id="omTrackList"></div>
      </div>
    `;
    document.body.appendChild(el);

    el.addEventListener('click', e => {
      if (e.target === el) closeModal();
    });
    el.querySelector('#omCloseModalBtn').onclick = () => closeModal();
    el.querySelector('#omMuteModalBtn').onclick = () => toggleMute();

    _modalEl = el;
    return el;
  }

  function openBoomboxModal(initialTab = 'catalog') {
    _userInteracted = true;
    ensureModalDom();
    _modalMode = 'boombox';
    _activeTab = initialTab;
    _modalEl.classList.add('om-open');
    applyPlaybackForCurrentState();
    renderModalContent();
    fetchJamendoCatalog(_selectedGenre);
  }

  function openJukeboxModal(opts = {}) {
    _userInteracted = true;
    if (opts.roomType && opts.roomId) {
      _activeRoom = {
        roomType: opts.roomType,
        roomId: String(opts.roomId),
        roomState: opts.roomState || (_activeRoom && _activeRoom.roomState) || {},
        barEl: opts.barEl || (_activeRoom && _activeRoom.barEl) || null
      };
    }
    ensureModalDom();
    _modalMode = 'jukebox';
    _activeTab = getOwnedTracksList().length > 1 ? 'collection' : 'catalog';
    _modalEl.classList.add('om-open');
    renderModalContent();
    fetchJamendoCatalog(_selectedGenre);
  }

  function closeModal() {
    stopPreview(true);
    if (_modalEl) _modalEl.classList.remove('om-open');
  }

  function updateModalHeaderUi() {
    if (!_modalEl || !_modalEl.classList.contains('om-open')) return;
    const iconEl = _modalEl.querySelector('#omHeadIcon');
    const titleEl = _modalEl.querySelector('#omHeadTitle');
    const subEl = _modalEl.querySelector('#omHeadSub');
    const walletEl = _modalEl.querySelector('#omWalletPill');
    const muteBtn = _modalEl.querySelector('#omMuteModalBtn');

    if (iconEl) iconEl.textContent = _modalMode === 'jukebox' ? '🎰' : '📻';
    if (titleEl) titleEl.textContent = _modalMode === 'jukebox' ? 'Музыкальный Автомат стола' : 'Личный Бумбокс ОРЕО';
    if (subEl) {
      subEl.textContent = _modalMode === 'jukebox'
        ? 'Включи свой трек для всех игроков за столом на 3 минуты!'
        : 'Каталог Jamendo API · Покупка за коины · Shuffle';
    }
    if (walletEl) walletEl.textContent = `🪙 ${fmt(getCoins())}`;
    if (muteBtn) {
      muteBtn.textContent = _muted ? '🔇' : '🔊';
      muteBtn.classList.toggle('muted', _muted);
    }
  }

  function updateNowPlayingBar() {
    if (!_modalEl) return;
    const bar = _modalEl.querySelector('#omNowBar');
    if (!bar) return;
    const cur = resolveDesiredTrack();
    const isPlayingNow = !_muted && !_isSleepingOrHidden;
    const modeBadge = _currentZone === 'tap' && _prefs.shuffle ? ' · 🔀 Shuffle' : '';
    bar.innerHTML = `
      <div class="om-now-left">
        <span class="om-eq ${isPlayingNow ? 'active' : ''}"><i></i><i></i><i></i></span>
        <div class="om-now-txt">
          ${_muted ? '🔇 Звук выключен · ' : 'Сейчас: '}<b>${esc(cur.title)}</b> — ${esc(cur.artist || 'CC0')}${modeBadge}
        </div>
      </div>
    `;
  }

  function renderModalContent() {
    if (!_modalEl) return;
    updateModalHeaderUi();
    updateNowPlayingBar();

    const heroWrap = _modalEl.querySelector('#omJukeboxHeroWrap');
    if (_modalMode === 'jukebox' && _activeRoom) {
      const cost = getRoomJukeboxCost(_activeRoom.roomState);
      const isOverride = cost > JUKEBOX_BASE_COST;
      const rem = _currentJukeboxExpires - Date.now();
      heroWrap.innerHTML = `
        <div class="om-jb-hero">
          ${isOverride && rem > 0
            ? `🔥 Сейчас на столе играет <b>${esc(_currentJukeboxTitle)}</b> (от ${esc(_currentJukeboxBy)}, ещё ${formatMmSs(rem)}).<br>Перебить заказ и включить свой трек для всех: <b>${fmt(cost)} 🪙 (×2)</b>!`
            : `🔊 Закажи любой трек из своей коллекции или каталога на этот стол на <b>3 минуты</b>! Стоимость заказа: <b>${fmt(cost)} 🪙</b>.`
          }
        </div>
      `;
    } else {
      heroWrap.innerHTML = '';
    }

    const ownedCount = getOwnedTracksList().length;
    const tabsWrap = _modalEl.querySelector('#omTabsWrap');
    tabsWrap.innerHTML = `
      <button type="button" class="om-tab ${_activeTab === 'catalog' ? 'active' : ''}" data-om-tab="catalog">🌐 Каталог Jamendo</button>
      <button type="button" class="om-tab ${_activeTab === 'collection' ? 'active' : ''}" data-om-tab="collection">💿 Моя коллекция (${ownedCount})</button>
    `;
    tabsWrap.querySelectorAll('[data-om-tab]').forEach(btn => {
      btn.onclick = () => {
        _activeTab = btn.getAttribute('data-om-tab');
        renderModalContent();
      };
    });

    const subBar = _modalEl.querySelector('#omSubBar');
    if (_activeTab === 'catalog') {
      subBar.innerHTML = Object.entries(GENRE_LABELS).map(([gKey, gTitle]) => `
        <button type="button" class="om-chip ${_selectedGenre === gKey ? 'active' : ''}" data-om-genre="${gKey}">${esc(gTitle)}</button>
      `).join('');
      subBar.querySelectorAll('[data-om-genre]').forEach(btn => {
        btn.onclick = () => {
          _selectedGenre = btn.getAttribute('data-om-genre') || 'all';
          renderModalContent();
          fetchJamendoCatalog(_selectedGenre);
        };
      });
    } else {
      subBar.innerHTML = `
        <button type="button" class="om-chip ${_prefs.shuffle ? 'shuffle-on' : ''}" id="omShuffleToggleBtn">
          🔀 Shuffle: ${_prefs.shuffle ? 'ВКЛ (случайно по кругу)' : 'ВЫКЛ'}
        </button>
        <button type="button" class="om-chip ${!_prefs.shuffle && _prefs.selectedTrackId === 'tap_lofi' ? 'active' : ''}" id="omDefaultTapBtn">
          🍪 Базовый Lo-Fi
        </button>
      `;
      const shBtn = subBar.querySelector('#omShuffleToggleBtn');
      if (shBtn) shBtn.onclick = () => toggleShuffleMode();
      const defBtn = subBar.querySelector('#omDefaultTapBtn');
      if (defBtn) defBtn.onclick = () => selectTrackForTap('tap_lofi', false);
    }

    updateModalListOnly();
  }

  function updateModalListOnly() {
    if (!_modalEl || !_modalEl.classList.contains('om-open')) return;
    const listEl = _modalEl.querySelector('#omTrackList');
    if (!listEl) return;

    const tracks = _activeTab === 'collection'
      ? getOwnedTracksList()
      : getCatalogTracksForGenre(_selectedGenre);

    const jbCost = _modalMode === 'jukebox' ? getRoomJukeboxCost(_activeRoom && _activeRoom.roomState) : JUKEBOX_BASE_COST;
    const isJbOverride = jbCost > JUKEBOX_BASE_COST;

    if (!tracks.length) {
      listEl.innerHTML = `<div style="text-align:center;padding:24px;color:rgba(255,255,255,.65)">Треки загружаются...</div>`;
      return;
    }

    listEl.innerHTML = tracks.map(tr => {
      const owned = isTrackOwned(tr.id);
      const isSelected = !_prefs.shuffle && _prefs.selectedTrackId === tr.id && _currentZone === 'tap';
      const isPreviewing = _previewTrackId === tr.id;
      const isBusy = _busyTrackId === tr.id;
      const genreTitle = GENRE_LABELS[tr.genre] || tr.genre || 'Music';

      let primaryBtnHtml = '';
      if (_modalMode === 'jukebox') {
        primaryBtnHtml = `
          <button type="button" class="om-btn jukebox" data-om-jb="${esc(tr.id)}" ${isBusy ? 'disabled' : ''}>
            ${isBusy ? '⏳ Заказ...' : (isJbOverride ? `🔥 Перебить ${fmt(jbCost)} 🪙` : `🔊 На стол ${fmt(jbCost)} 🪙`)}
          </button>
        `;
      } else if (owned) {
        primaryBtnHtml = `
          <button type="button" class="om-btn play ${isSelected ? 'active' : ''}" data-om-play="${esc(tr.id)}">
            ${isSelected ? '🔁 На повторе' : '▶️ Включить'}
          </button>
        `;
      } else {
        primaryBtnHtml = `
          <button type="button" class="om-btn buy" data-om-buy="${esc(tr.id)}" ${isBusy ? 'disabled' : ''}>
            ${isBusy ? '⏳ Покупка...' : `🍪 Купить за ${fmt(tr.price)}`}
          </button>
        `;
      }

      return `
        <div class="om-card ${isSelected ? 'om-playing' : ''} ${tr.exclusive ? 'om-exclusive' : ''}">
          <img class="om-cover" src="${esc(tr.cover)}" alt="" loading="lazy">
          <div class="om-meta">
            <div class="om-title-row">
              <div class="om-title">${esc(tr.title)}</div>
            </div>
            <div class="om-artist">${esc(tr.artist)}</div>
            <div class="om-badges">
              <span class="om-genre-tag">${esc(genreTitle)}</span>
              ${tr.exclusive ? '<span class="om-excl-tag">👑 ЭКСКЛЮЗИВ</span>' : ''}
              ${owned ? '<span class="om-owned-tag">✓ В коллекции</span>' : ''}
            </div>
          </div>
          <div class="om-actions">
            <button type="button" class="om-btn preview ${isPreviewing ? 'active' : ''}" data-om-preview="${esc(tr.id)}">
              ${isPreviewing ? `⏹ Стоп (${_previewSecLeft}с)` : '▶️ Превью (15 сек)'}
            </button>
            ${primaryBtnHtml}
          </div>
        </div>
      `;
    }).join('');

    const byId = new Map(tracks.map(t => [t.id, t]));
    listEl.querySelectorAll('[data-om-preview]').forEach(btn => {
      btn.onclick = () => togglePreview(byId.get(btn.getAttribute('data-om-preview')));
    });
    listEl.querySelectorAll('[data-om-buy]').forEach(btn => {
      btn.onclick = () => handleBuyTrack(byId.get(btn.getAttribute('data-om-buy')));
    });
    listEl.querySelectorAll('[data-om-play]').forEach(btn => {
      btn.onclick = () => selectTrackForTap(btn.getAttribute('data-om-play'), false);
    });
    listEl.querySelectorAll('[data-om-jb]').forEach(btn => {
      btn.onclick = () => handleOrderJukebox(byId.get(btn.getAttribute('data-om-jb')));
    });
  }

  // --- Переключение зон и привязка к жизненному циклу Mini App ---
  function setZone(zoneName) {
    const clean = String(zoneName || 'tap').toLowerCase();
    if (_currentZone === clean) return;
    _currentZone = clean;
    applyPlaybackForCurrentState();
  }

  function notifyOverlayChange(overlayKey, isOpen) {
    if (isOpen) {
      if (overlayKey === 'loto') setZone('loto');
      else if (overlayKey === 'arena') setZone('arena');
      else if (overlayKey === 'birch') {
        setZone(_activeRoom ? _activeRoom.roomType : 'poker');
      }
    } else {
      const bEl = document.getElementById('birchOverlay');
      const aEl = document.getElementById('arenaBetsBackdrop');
      const birchStillOpen = Boolean(bEl && bEl.classList.contains('show'));
      const arenaStillOpen = Boolean(aEl && aEl.classList.contains('ab-open'));
      if (birchStillOpen) {
        setZone(_activeRoom ? _activeRoom.roomType : 'poker');
      } else if (arenaStillOpen) {
        setZone('arena');
      } else {
        leaveRoom();
        setZone('tap');
      }
    }
  }

  function notifyUserTap() {
    const wasFirst = !_userInteracted;
    _userInteracted = true;
    _isSleepingOrHidden = false;
    if (!_muted && (wasFirst || !_activeSrcKey || _decks[_activeDeckIdx].paused)) {
      applyPlaybackForCurrentState();
    }
  }

  function setSleepState(sleeping) {
    _isSleepingOrHidden = Boolean(sleeping);
    applyPlaybackForCurrentState();
  }

  function initDomBindings() {
    const muteBtn = document.getElementById('musicToggleBtn');
    if (muteBtn) {
      muteBtn.onclick = e => {
        e.preventDefault();
        toggleMute();
      };
    }

    const boomBtn = document.getElementById('boomboxOpenBtn');
    if (boomBtn) {
      boomBtn.onclick = e => {
        e.preventDefault();
        openBoomboxModal('catalog');
      };
    }

    updateSideButtonsUi();

    // Разблокировка WebView Audio при первом касании в любом месте
    const unlockOnce = () => {
      if (!_userInteracted) {
        _userInteracted = true;
        if (!_muted && !_isSleepingOrHidden) {
          applyPlaybackForCurrentState();
        }
      }
    };
    window.addEventListener('pointerdown', unlockOnce, { passive: true });
    window.addEventListener('keydown', unlockOnce, { passive: true });

    document.addEventListener('visibilitychange', () => {
      _isSleepingOrHidden = document.hidden;
      applyPlaybackForCurrentState();
    });
  }

  window.OreoMusic = {
    openBoombox: openBoomboxModal,
    openJukeboxModal,
    closeModal,
    toggleMute,
    setMuted,
    isMuted: () => _muted,
    isPlaying: () => !_muted && !_isSleepingOrHidden && Boolean(!_decks[_activeDeckIdx].paused || _previewTrackId),
    setZone,
    notifyOverlayChange,
    notifyUserTap,
    setSleepState,
    syncRoomJukebox,
    leaveRoom,
    getOwnedTrackIds
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initDomBindings);
  } else {
    initDomBindings();
  }
})();
