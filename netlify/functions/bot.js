/**
 * Серверная функция Netlify для Telegram-бота «ОРЕО» (работает 24/7 бесплатно на Netlify).
 *
 * Возможности:
 * 1. Принимает Webhook от Telegram (/start, /ref, /cases, /top, /tiktok и inline-кнопки).
 * 2. Отправляет фирменный баннер assets/banner.jpg и интерактивное меню.
 * 3. Создаёт реальные счета на оплату в Telegram Stars (XTR) по запросу из игры:
 *    GET /.netlify/functions/bot?action=invoice&pack=magnat&user_id=12345
 * 4. Автоматически подтверждает платежи Telegram Stars (pre_checkout_query).
 * 5. Включает Webhook в 1 клик при открытии в браузере:
 *    GET /.netlify/functions/bot?setup=1
 */

const crypto = require("crypto");

const rawBotToken = process.env.BOT_TOKEN;
const TOKEN = rawBotToken ? rawBotToken.trim() : "";
const rawWebhookSecret = process.env.WEBHOOK_SECRET;
const WEBHOOK_SECRET = rawWebhookSecret ? rawWebhookSecret.trim() : "";
const rawAdminSecret = process.env.ADMIN_SECRET;
const ADMIN_SECRET = (rawAdminSecret && rawAdminSecret.trim()) || WEBHOOK_SECRET;

const BOT_USERNAME = process.env.BOT_USERNAME || "oreo_67_bot";
const WEBAPP_URL = process.env.WEBAPP_URL || "https://oreo-67-bot.netlify.app";
const FIREBASE_DB = (process.env.FIREBASE_DB_URL || "https://oreo-tap-default-rtdb.europe-west1.firebasedatabase.app").replace(/\/+$/, "");
const ADMIN_USER_ID = Number(process.env.ADMIN_USER_ID || 594228143);
const INTERNAL_CRON_TOKEN = crypto.randomBytes(24).toString("hex");
const MAX_BODY_CHARS = 262144;
const API = TOKEN ? `https://api.telegram.org/bot${TOKEN}/` : "";
const BANNER_URL = `${WEBAPP_URL}/assets/banner.jpg`;

function timingSafeMatch(a, b) {
  if (typeof a !== "string" || typeof b !== "string" || !a || !b) return false;
  const bufA = Buffer.from(a, "utf8");
  const bufB = Buffer.from(b, "utf8");
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

function getHeader(headersObj, lowerName) {
  if (!headersObj || typeof headersObj !== "object") return "";
  for (const [k, v] of Object.entries(headersObj)) {
    if (String(k).toLowerCase() === lowerName) return String(v || "").trim();
  }
  return "";
}

function isAuthorizedAdminRequest(event) {
  if (!ADMIN_SECRET) return false;
  const hdr = getHeader(event.headers, "x-admin-secret");
  return timingSafeMatch(hdr, ADMIN_SECRET);
}

function buildOwlReminder(name, streak, coins) {
  const safeName = esc(name || "Тапер");
  const st = streak || 1;
  const templates = [
    `🦉🍪 <b>Эй, ${safeName}! Печенька ОРЕО сама себя не натапает...</b>\n\n` +
      `Ты уже давно не заходил, а соперники в рейтинге обходят тебя прямо сейчас!\n` +
      `<blockquote>🔥 Твой огонёк: <b>${st} дн. подряд</b>\n💀 Напоминаю: пропустишь день — <b>ВЕСЬ ПРОГРЕСС И КОИНЫ СГОРЯТ ДО НУЛЯ</b>. Я не шучу. 🙂🔪</blockquote>\n` +
      `👇 Быстро зайди на 1 минуту и сделай пару тапов!`,

    `🔥💀 <b>${safeName}, твой огонёк (${st} дн.) начинает тухнуть!</b>\n\n` +
      `Знаешь, что случается с теми, кто забывает потапать ОРЕО? Их баланс превращается в пепел, а место в ТОПе занимают другие.\n` +
      `<blockquote>🎁 Кстати, твой бесплатный кейс сам себя не откроет!</blockquote>\n` +
      `👇 Не зли печеньку — заходи и тапай!`,

    `👀🍪 <b>Тук-тук, ${safeName}. Я вижу, что ты сидишь в Телеграме, но не тапаешь ОРЕО.</b>\n\n` +
      `Очень смелое решение, учитывая, что без ежедневного захода твои <b>${Number(coins || 0).toLocaleString("ru-RU")} 🪙</b> и стрик <b>${st} дн.</b> сгорят без следа.\n\n` +
      `👇 Нажми на кнопку ниже, пока я добрый! 🦉⚡`,

    `🚨🍪 <b>Потеря пульса тапера, ${safeName}!</b>\n\n` +
      `Твоя ферма ОРЕО уснула, энергия переполнена (<code>500/500 ⚡</code>), а кто-то другой прямо сейчас выбивает <b>Золотой ОРЕО</b>!\n\n` +
      `👇 Залетай в игру, слей энергию и удержи свой огонёк 🔥!`
  ];
  return templates[Math.floor(Math.random() * templates.length)];
}

async function runOwlReminders(force = false) {
  let sent = 0;
  try {
    const res = await fetch(`${FIREBASE_DB}/players.json`);
    if (!res.ok) return { ok: false, sent: 0 };
    const players = await res.json();
    if (!players || typeof players !== "object") return { ok: true, sent: 0 };

    const now = Date.now();
    const INACTIVE_MS = 3 * 3600 * 1000; // 3 часа без тапов
    const COOLDOWN_MS = 6 * 3600 * 1000; // не чаще раза в 6 часов

    for (const p of Object.values(players)) {
      if (!p || !p.id) continue;
      const uid = String(p.id);
      // Настоящие Telegram user_id — это числа > 1000000
      if (!/^\d{7,}$/.test(uid)) continue;

      const lastTap = Number(p.ts) || 0;
      const lastOwl = Number(p.lastOwlTs) || 0;
      const isInactive = now - lastTap >= INACTIVE_MS;
      const canRemind = now - lastOwl >= COOLDOWN_MS;

      if (force || (isInactive && canRemind)) {
        const text = buildOwlReminder(p.name, p.streak, p.coins);
        const kb = {
          inline_keyboard: [
            [{ text: "🔥 СПАСТИ ОГОНЁК И ТАПАТЬ!", web_app: { url: WEBAPP_URL } }]
          ]
        };
        const r = await sendCard(uid, text, kb);
        if (r && r.ok) {
          sent++;
          await fetch(`${FIREBASE_DB}/players/${encodeURIComponent(uid)}.json`, {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ lastOwlTs: now })
          }).catch(() => {});
        }
      }
    }
  } catch (e) {}
  return { ok: true, sent };
}

const STAR_PACKS = {
  magnat: {
    title: "Пакет «Магнат ОРЕО»",
    description: "+100 ОРЕО-Кристаллов 💎 и +25 000 печенько-коинов 🪙",
    stars: 99,
    payload: "pack_magnat_100gems_25k"
  },
  vip_energy: {
    title: "VIP Безлимитная Энергия ♾️",
    description: "Энергия никогда не заканчивается — тапай ОРЕО без лимитов!",
    stars: 75,
    payload: "pack_vip_energy"
  },
  gold_case: {
    title: "Золотой VIP-Кейс Магната 🏆",
    description: "50% шанс на Легендарный Золотой ОРЕО и 20% на Дима Твикс Cosmic!",
    stars: 49,
    payload: "pack_gold_case"
  }
};

async function tgCall(method, body) {
  const res = await fetch(API + method, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });
  return res.json();
}

function esc(s) {
  return String(s || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function makeRefLink(userId) {
  return userId ? `https://t.me/${BOT_USERNAME}?start=ref_${userId}` : `https://t.me/${BOT_USERNAME}`;
}

function makeShareUrl(refLink) {
  const text = "🍪 Залетай в ОРЕО! Забирай 2 бесплатных кейса, выбивай Золотой ОРЕО и тапай со мной! 🔥";
  return `https://t.me/share/url?url=${encodeURIComponent(refLink)}&text=${encodeURIComponent(text)}`;
}

function mainKeyboard(appUrl, refLink) {
  return {
    inline_keyboard: [
      [{ text: "🍪 ИГРАТЬ В ОРЕО", web_app: { url: appUrl } }],
      [
        { text: "🎁 Кейсы & Скины", callback_data: "tab_cases" },
        { text: "🏆 Лиги & Топ", callback_data: "tab_top" }
      ],
      [
        { text: "👥 Моя ссылка (+2500 🪙)", callback_data: "tab_ref" },
        { text: "🎬 TikTok 100K", callback_data: "tab_tiktok" }
      ],
      [{ text: "✈️ Пригласить друга в 1 клик", url: makeShareUrl(refLink) }]
    ]
  };
}

function backKeyboard(appUrl, refLink) {
  return {
    inline_keyboard: [
      [{ text: "🍪 ОТКРЫТЬ ИГРУ", web_app: { url: appUrl } }],
      [{ text: "✈️ Поделиться с другом", url: makeShareUrl(refLink) }],
      [{ text: "« Назад в меню", callback_data: "tab_home" }]
    ]
  };
}

function buildHomeText(firstName, isRef) {
  const name = esc(firstName || "Тапер");
  const refLine = isRef
    ? "\n🎁 <b>Бонус по приглашению активирован:</b> стартовые <b>+150 🪙</b> и <b>+25 💎</b> ждут в игре!\n"
    : "";
  return (
    `🍪 <b>Привет, ${name}! Добро пожаловать в ОРЕО</b>\n${refLine}\n` +
    `Тапай 3D-печеньку под бит <i>lil ptiric</i>, включай селфи-фильтры и собирай редкие скины!\n\n` +
    `<blockquote>` +
    `👑 <b>Золотой ОРЕО 999</b> — даёт <b>×3.0</b> к фарму\n` +
    `🎁 <b>2 бесплатных кейса</b> — доступны каждый день\n` +
    `🔥 <b>Ударный стрик</b> — держи серию дней, чтобы не сгореть\n` +
    `👥 <b>Сеть ОРЕО</b> — <b>+2 500 🪙</b> за друга и <b>10%</b> с его тапов` +
    `</blockquote>\n\n` +
    `👇 <b>Жми кнопку ниже и врывайся в сезон!</b>`
  );
}

function buildCasesText() {
  return (
    `🎁 <b>КЕЙСЫ, СКИНЫ & БИРЖА ОРЕО</b>\n\n` +
    `Открывай кейсы с рулеткой и собирай коллекцию печенек с множителем дохода:\n\n` +
    `• 🍪 <b>Классический ОРЕО</b> — <code>×1.0</code> <i>(Базовый)</i>\n` +
    `• 🍓 <b>Клубничный ОРЕО</b> — <code>×1.25</code> <i>(Редкий)</i>\n` +
    `• 🧪 <b>Мятный Кибер-ОРЕО</b> — <code>×1.4</code> <i>(Редкий)</i>\n` +
    `• ⚡ <b>Неоновый 67 ОРЕО</b> — <code>×1.85</code> <i>(Эпический)</i>\n` +
    `• 👑 <b>Золотой ОРЕО 999</b> — <code>×3.0</code> <i>(Легендарный)</i>\n` +
    `• 🎸 <b>Дима Твикс Cosmic</b> — <code>×5.0</code> <i>(Мифический)</i>\n\n` +
    `<blockquote>📈 <b>Встроенная биржа:</b> любой выбитый дубликат можно мгновенно продать за печенько-коины прямо в инвентаре!</blockquote>`
  );
}

function buildTopText() {
  return (
    `🏆 <b>МИРОВОЙ РЕЙТИНГ И ЛИГИ ОРЕО</b>\n\n` +
    `Соревнуйся с друзьями по капиталу печенько-коинов и поднимайся по лигам:\n\n` +
    `🥉 <b>Бронзовая Крошка</b> — от <code>0 🪙</code>\n` +
    `🥈 <b>Серебряный Крем</b> — от <code>2 500 🪙</code>\n` +
    `🥇 <b>Золотой ОРЕО</b> — от <code>15 000 🪙</code>\n` +
    `💎 <b>Алмазный Магнат</b> — от <code>75 000 🪙</code>\n` +
    `👑 <b>Император ОРЕО 67</b> — от <code>250 000 🪙</code>\n\n` +
    `<blockquote>🔥 <b>Правило стрика:</b> заходи и тапай каждый день! Пропуск дня без 🧊 Заморозки сжигает прогресс.</blockquote>`
  );
}

function buildRefText(refLink) {
  return (
    `👥 <b>ПАРТНЁРСКАЯ СЕТЬ ОРЕО</b>\n\n` +
    `Приглашай друзей в команду и получай пассивный доход с каждого их тапа:\n\n` +
    `• 🎁 <b>+2 500 🪙</b> — мгновенно за каждого друга\n` +
    `• 📈 <b>10% коинов</b> — со всех тапов друзей 1-й линии\n` +
    `• 🚀 <b>3% коинов</b> — с друзей 2-й линии\n\n` +
    `🔗 <b>Твоя персональная ссылка (нажми, чтобы скопировать):</b>\n` +
    `<code>${esc(refLink)}</code>`
  );
}

function buildTiktokText(refLink) {
  return (
    `🎬 <b>TIKTOK КОНКУРС НЕДЕЛИ & АМБАССАДОРЫ</b>\n\n` +
    `Сними ролик в TikTok / Shorts / Reels и забери главный банк недели:\n\n` +
    `1️⃣ Включи в игре <b>📷 Камеру-фон</b> с необычным фильтром (<i>Неон 67, Золотой ОРЕО, VHS</i>)\n` +
    `2️⃣ Потапай печеньку под трек <b>lil ptiric</b> (скоро — официальный гимн от <b>Димы Твикса 🎸</b>)\n` +
    `3️⃣ Оставь свою реферальную ссылку в описании или профиле:\n` +
    `<code>${esc(refLink)}</code>\n\n` +
    `<blockquote>🏆 <b>Призовой фонд недели:</b> до <b>100 000 🪙</b>, <b>500 💎</b> и эксклюзивный скин <b>Золотой ОРЕО 999</b>!</blockquote>`
  );
}

async function sendCard(chatId, caption, replyMarkup) {
  const res = await tgCall("sendPhoto", {
    chat_id: chatId,
    photo: BANNER_URL,
    caption,
    parse_mode: "HTML",
    reply_markup: replyMarkup
  });
  if (!res || !res.ok) {
    return tgCall("sendMessage", {
      chat_id: chatId,
      text: caption,
      parse_mode: "HTML",
      disable_web_page_preview: true,
      reply_markup: replyMarkup
    });
  }
  return res;
}

exports.handler = async (event) => {
  const headers = {
    "Access-Control-Allow-Origin": WEBAPP_URL,
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, X-Telegram-Init-Data",
    "X-Content-Type-Options": "nosniff"
  };

  if (event.httpMethod === "OPTIONS") {
    return { statusCode: 200, headers, body: "" };
  }

  if (!TOKEN) {
    return { statusCode: 503, headers, body: "Bot token is not configured" };
  }

  const qs = event.queryStringParameters || {};

  // 1. Защищённая настройка Webhook (требуется заголовок X-Admin-Secret и заданный WEBHOOK_SECRET)
  if (qs.setup === "1") {
    if (!WEBHOOK_SECRET) {
      return { statusCode: 503, headers, body: "WEBHOOK_SECRET is not configured" };
    }
    if (!isAuthorizedAdminRequest(event)) {
      return { statusCode: 403, headers, body: "Forbidden" };
    }
    const webhookUrl = `${WEBAPP_URL}/.netlify/functions/bot`;
    const wh = await tgCall("setWebhook", {
      url: webhookUrl,
      secret_token: WEBHOOK_SECRET,
      allowed_updates: ["message", "callback_query", "pre_checkout_query"]
    });
    return {
      statusCode: 200,
      headers: { ...headers, "Content-Type": "application/json; charset=utf-8" },
      body: JSON.stringify({ ok: Boolean(wh && wh.ok), webhookUrl })
    };
  }

  // 2. Генерация ссылки на оплату Telegram Stars (XTR) для магазина в игре
  if (qs.action === "invoice") {
    const packKey = Object.prototype.hasOwnProperty.call(STAR_PACKS, qs.pack) ? qs.pack : "magnat";
    const pack = STAR_PACKS[packKey];
    const cleanUid = /^\d{5,15}$/.test(String(qs.user_id || "")) ? String(qs.user_id) : "anon";
    const inv = await tgCall("createInvoiceLink", {
      title: pack.title,
      description: pack.description,
      payload: `${pack.payload}:${cleanUid}`,
      provider_token: "", // Для Telegram Stars (XTR) всегда пустая строка
      currency: "XTR",
      prices: [{ label: pack.title, amount: pack.stars }]
    });
    return {
      statusCode: 200,
      headers: { ...headers, "Content-Type": "application/json; charset=utf-8" },
      body: JSON.stringify({ ok: Boolean(inv && inv.ok), result: inv && inv.result ? inv.result : null })
    };
  }

  // 2b. Получение аватарки пользователя из Telegram по его user_id: /.netlify/functions/bot?action=avatar&user_id=12345
  if (qs.action === "avatar" && qs.user_id) {
    const rawUid = String(qs.user_id).trim();
    if (!/^\d{5,15}$/.test(rawUid)) {
      return { statusCode: 400, headers, body: "" };
    }
    try {
      const photosRes = await tgCall("getUserProfilePhotos", {
        user_id: Number(rawUid),
        limit: 1
      });
      const photos = photosRes && photosRes.result && photosRes.result.photos;
      if (photos && photos.length > 0 && photos[0].length > 0) {
        const chosen = photos[0][1] || photos[0][0];
        const fileRes = await tgCall("getFile", { file_id: chosen.file_id });
        const filePath = fileRes && fileRes.result && fileRes.result.file_path;
        if (filePath && !filePath.includes("..")) {
          const imgResp = await fetch(`https://api.telegram.org/file/bot${TOKEN}/${filePath}`);
          if (imgResp.ok) {
            const arrayBuf = await imgResp.arrayBuffer();
            return {
              statusCode: 200,
              headers: {
                ...headers,
                "Content-Type": "image/jpeg",
                "Cache-Control": "public, max-age=86400"
              },
              body: Buffer.from(arrayBuf).toString("base64"),
              isBase64Encoded: true
            };
          }
        }
      }
    } catch (e) {}
    return { statusCode: 404, headers, body: "" };
  }

  // 2c. Пассивно-агрессивные напоминания в стиле Совы Duolingo
  if (qs.action === "owl_check" || qs.action === "owl_force") {
    const isInternalCron = event._internalCronToken === INTERNAL_CRON_TOKEN;
    if (qs.action === "owl_force" && !isAuthorizedAdminRequest(event)) {
      return { statusCode: 403, headers, body: "Forbidden" };
    }
    if (qs.action === "owl_check" && !isInternalCron && !isAuthorizedAdminRequest(event)) {
      // Внешние клиенты не могут форсировать рассылку; выполняется строго с учётом 6ч кулдауна
      const out = await runOwlReminders(false);
      return {
        statusCode: 200,
        headers: { ...headers, "Content-Type": "application/json; charset=utf-8" },
        body: JSON.stringify({ ok: out.ok })
      };
    }
    const out = await runOwlReminders(qs.action === "owl_force");
    return {
      statusCode: 200,
      headers: { ...headers, "Content-Type": "application/json; charset=utf-8" },
      body: JSON.stringify(out)
    };
  }

  // 2d. Мгновенное уведомление пригласившего о новом реферале (с валидацией ID и защитой от спама)
  if (qs.action === "ref_notify" && qs.inviter_id) {
    try {
      const inviterId = String(qs.inviter_id).trim();
      if (!/^\d{5,15}$/.test(inviterId)) {
        return { statusCode: 400, headers, body: JSON.stringify({ ok: false }) };
      }
      // Проверяем существование игрока в БД и анти-спам кулдаун (не чаще 1 уведомления в 60 сек)
      const pRes = await fetch(`${FIREBASE_DB}/players/${encodeURIComponent(inviterId)}.json`);
      const pData = pRes.ok ? await pRes.json() : null;
      const now = Date.now();
      if (!pData || typeof pData !== "object" || (now - Number(pData.lastRefNotifyTs || 0) < 60000)) {
        return {
          statusCode: 200,
          headers: { ...headers, "Content-Type": "application/json; charset=utf-8" },
          body: JSON.stringify({ ok: false })
        };
      }
      await fetch(`${FIREBASE_DB}/players/${encodeURIComponent(inviterId)}.json`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ lastRefNotifyTs: now })
      }).catch(() => {});

      const friendName = esc(String(qs.friend_name || "Твой друг").slice(0, 40));
      const text =
        `🎉🍪 <b>У тебя новый друг в ОРЕО!</b>\n\n` +
        `Игрок <b>${friendName}</b> присоединился по твоей реферальной ссылке!\n\n` +
        `<blockquote>` +
        `💰 <b>Тебе начислено:</b> <b>+25 000 🪙</b> и <b>+15 💎</b>\n` +
        `📈 <b>Пассивный доход:</b> ты получаешь <b>10%</b> со всех его тапов!` +
        `</blockquote>\n\n` +
        `👇 Заходи в игру и проверь свой баланс! 🔥`;
      const kb = {
        inline_keyboard: [
          [{ text: "🍪 ОТКРЫТЬ ИГРУ", web_app: { url: WEBAPP_URL } }]
        ]
      };
      await tgCall("sendMessage", {
        chat_id: inviterId,
        text,
        parse_mode: "HTML",
        reply_markup: kb
      });
      return {
        statusCode: 200,
        headers: { ...headers, "Content-Type": "application/json; charset=utf-8" },
        body: JSON.stringify({ ok: true })
      };
    } catch (e) {
      return {
        statusCode: 200,
        headers: { ...headers, "Content-Type": "application/json; charset=utf-8" },
        body: JSON.stringify({ ok: false })
      };
    }
  }

  // 3. Обработка входящего Webhook от Telegram
  if (event.httpMethod !== "POST") {
    return { statusCode: 200, headers, body: "Oreo Bot Webhook Active" };
  }

  const gotSecret = getHeader(event.headers, "x-telegram-bot-api-secret-token");
  if (!WEBHOOK_SECRET || !timingSafeMatch(gotSecret, WEBHOOK_SECRET)) {
    return { statusCode: 403, headers, body: "Forbidden" };
  }

  if (!event.body || event.body.length > MAX_BODY_CHARS) {
    return { statusCode: event.body ? 413 : 400, headers, body: "Invalid payload" };
  }

  let update = {};
  try {
    update = JSON.parse(event.body);
  } catch (e) {
    return { statusCode: 400, headers, body: "bad json" };
  }

  // Валидация предзаказа Telegram Stars (проверка валюты XTR и тарифа пакета)
  if (update.pre_checkout_query) {
    const pcq = update.pre_checkout_query;
    const rawPayload = String(pcq.invoice_payload || "");
    const payloadPrefix = rawPayload.split(":")[0];
    const matchedPack = Object.values(STAR_PACKS).find((p) => p.payload === payloadPrefix);
    const isValidOrder =
      pcq.currency === "XTR" &&
      Boolean(matchedPack) &&
      Number(pcq.total_amount) === matchedPack.stars;

    await tgCall("answerPreCheckoutQuery", {
      pre_checkout_query_id: pcq.id,
      ok: isValidOrder,
      ...(isValidOrder ? {} : { error_message: "Некорректные параметры счёта. Попробуйте создать заказ заново." })
    });
    return { statusCode: 200, headers, body: "ok" };
  }

  if (update.message) {
    const msg = update.message;
    const chatId = msg.chat && msg.chat.id;
    if (!chatId) return { statusCode: 200, headers, body: "ok" };
    const user = msg.from || {};
    const userId = user.id || "";
    const firstName = user.first_name || "Тапер";
    const textIn = (msg.text || "").trim();

    if (msg.successful_payment) {
      await tgCall("sendMessage", {
        chat_id: chatId,
        text: "🎉 <b>Оплата через Telegram Stars прошла успешно!</b>\nТвои 💎 ОРЕО-Кристаллы и бонусы уже зачислены в игру!",
        parse_mode: "HTML"
      });
      return { statusCode: 200, headers, body: "ok" };
    }

    let refParam = "";
    if (textIn.startsWith("/start")) {
      const parts = textIn.split(/\s+/);
      if (parts.length > 1) refParam = parts[1].trim();
    }

    const appUrl = refParam ? `${WEBAPP_URL}?ref=${encodeURIComponent(refParam)}` : WEBAPP_URL;
    const refLink = makeRefLink(userId);
    const cmd = textIn ? textIn.split(/\s+/)[0].toLowerCase().split("@")[0] : "/start";

    if (cmd === "/ref") {
      await sendCard(chatId, buildRefText(refLink), backKeyboard(appUrl, refLink));
    } else if (cmd === "/cases") {
      await sendCard(chatId, buildCasesText(), backKeyboard(appUrl, refLink));
    } else if (cmd === "/top") {
      await sendCard(chatId, buildTopText(), backKeyboard(appUrl, refLink));
    } else if (cmd === "/tiktok") {
      await sendCard(chatId, buildTiktokText(refLink), backKeyboard(appUrl, refLink));
    } else if (cmd === "/owl") {
      if (Number(userId) !== ADMIN_USER_ID) {
        await tgCall("sendMessage", {
          chat_id: chatId,
          text: "⛔ <b>Доступ закрыт!</b> Команда рассылки доступна только основателю.",
          parse_mode: "HTML"
        });
      } else {
        const out = await runOwlReminders(true);
        await tgCall("sendMessage", {
          chat_id: chatId,
          text: `🦉 <b>Сова ОРЕО вылетела!</b> Отправлено напоминаний игрокам: <b>${out.sent}</b>`,
          parse_mode: "HTML"
        });
      }
    } else {
      await sendCard(chatId, buildHomeText(firstName, Boolean(refParam)), mainKeyboard(appUrl, refLink));
    }
  } else if (update.callback_query) {
    const cb = update.callback_query;
    const data = cb.data || "tab_home";
    const msg = cb.message || {};
    const chatId = msg.chat && msg.chat.id;
    const messageId = msg.message_id;
    const hasPhoto = Boolean(msg.photo);
    const user = cb.from || {};
    const userId = user.id || "";
    const firstName = user.first_name || "Тапер";

    await tgCall("answerCallbackQuery", { callback_query_id: cb.id });

    if (chatId && messageId) {
      const refLink = makeRefLink(userId);
      const appUrl = WEBAPP_URL;
      let text = buildHomeText(firstName, false);
      let kb = mainKeyboard(appUrl, refLink);

      if (data === "tab_cases") {
        text = buildCasesText();
        kb = backKeyboard(appUrl, refLink);
      } else if (data === "tab_top") {
        text = buildTopText();
        kb = backKeyboard(appUrl, refLink);
      } else if (data === "tab_ref") {
        text = buildRefText(refLink);
        kb = backKeyboard(appUrl, refLink);
      } else if (data === "tab_tiktok") {
        text = buildTiktokText(refLink);
        kb = backKeyboard(appUrl, refLink);
      }

      if (hasPhoto) {
        await tgCall("editMessageCaption", {
          chat_id: chatId,
          message_id: messageId,
          caption: text,
          parse_mode: "HTML",
          reply_markup: kb
        });
      } else {
        await tgCall("editMessageText", {
          chat_id: chatId,
          message_id: messageId,
          text: text,
          parse_mode: "HTML",
          disable_web_page_preview: true,
          reply_markup: kb
        });
      }
    }
  }

  return { statusCode: 200, headers, body: "ok" };
};

exports.INTERNAL_CRON_TOKEN = INTERNAL_CRON_TOKEN;
