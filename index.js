/**
 * Автопарк CRM — Telegram-бот v2
 * Полный цикл ремонта через inline-кнопки без Notion
 */

const TelegramBot = require("node-telegram-bot-api");
const express     = require("express");
const { Client }  = require("@notionhq/client");
const cron        = require("node-cron");
const fetch       = require("node-fetch");

// ─── КОНФИГ ───────────────────────────────────────────────────────────────────

const BOT_TOKEN    = process.env.BOT_TOKEN;
const NOTION_TOKEN = process.env.NOTION_TOKEN;
const APP_URL      = process.env.APP_URL || "";
const PORT         = process.env.PORT || 8080;
const ADMIN_IDS    = (process.env.ADMIN_IDS || "").split(",").map(s => s.trim()).filter(Boolean);

const DB = {
  cars:          "a52b75e6a94b4e29a7675b0c485a51b7",
  drivers:       "3e4caec4095c45b49eabd35652a00ea0",
  absences:      "8195f2ccc73e418cae12d3639211da86",
  repairs:       "673701b3aff148b683bb57386786fa80",
  maintenance:   "f449297c646a47928bfc69dada31f071",
  insurances:    "44d9220f9f0c458587f8eb9db711a506",
  inspections:   "cb4026fb6d424cbe894f1ce91f75e772",
  notifications: "695a2be424e74c0a96d7a72749fbc21d",
};

const NOTION_URL = "https://www.notion.so";

if (!BOT_TOKEN || !NOTION_TOKEN) {
  console.error("❌ Задай BOT_TOKEN и NOTION_TOKEN в переменных окружения!");
  process.exit(1);
}

// ─── ИНИЦИАЛИЗАЦИЯ ────────────────────────────────────────────────────────────

const notion = new Client({ auth: NOTION_TOKEN });
const app    = express();
app.use(express.json());
app.use(express.static("public"));

const bot = APP_URL
  ? new TelegramBot(BOT_TOKEN)
  : new TelegramBot(BOT_TOKEN, { polling: true });

const userCache = new Map();   // tgId → user
const sessions  = new Map();   // tgId → { state, data }

// ─── NOTION ХЕЛПЕРЫ ───────────────────────────────────────────────────────────

const getText  = (p, k) => { try { return p.properties[k].rich_text[0].plain_text; } catch { return ""; } };
const getTitle = (p, k) => { try { return p.properties[k].title[0].plain_text; }    catch { return ""; } };
const getSel   = (p, k) => { try { return p.properties[k].select?.name || ""; }     catch { return ""; } };
const getPhone = (p, k) => { try { return (p.properties[k].phone_number||"").replace(/\D/g,""); } catch { return ""; } };
const getDate  = (p, k) => { try { return p.properties[k].date?.start || ""; }      catch { return ""; } };
const getNum   = (p, k) => { try { return p.properties[k].number ?? null; }         catch { return null; } };

const norm = s => (s||"").replace(/\D/g,"").replace(/^8/,"7");

async function notionQuery(dbId, filter) {
  const pages = []; let cursor;
  while (true) {
    const r = await notion.databases.query({ database_id: dbId, filter, start_cursor: cursor, page_size: 100 });
    pages.push(...r.results);
    if (!r.has_more) break;
    cursor = r.next_cursor;
  }
  return pages;
}

async function notionUpdate(pageId, props) {
  return notion.pages.update({ page_id: pageId, properties: props });
}

async function notionCreate(dbId, props) {
  return notion.pages.create({ parent: { database_id: dbId }, properties: props });
}

function rt(v)  { return { rich_text: [{ text: { content: String(v||"").slice(0,2000) } }] }; }
function ttl(v) { return { title:     [{ text: { content: String(v||"").slice(0,2000) } }] }; }
function sel(v) { return v ? { select: { name: v } } : { select: null }; }
function num(v) { return { number: v != null ? parseFloat(v) : null }; }

async function nextId(prefix, dbId) {
  const pages = await notionQuery(dbId);
  const titleProp = pages[0] ? Object.keys(pages[0].properties).find(k => pages[0].properties[k].type === "title") : null;
  const nums = pages.map(p => {
    const t = titleProp ? getTitle(p, titleProp) : "";
    const m = t.match(new RegExp(`^${prefix}-(\\d+)$`));
    return m ? parseInt(m[1]) : 0;
  }).filter(n => n > 0);
  return `${prefix}-${String(Math.max(0, ...nums) + 1).padStart(3, "0")}`;
}

// ─── ИДЕНТИФИКАЦИЯ ────────────────────────────────────────────────────────────

async function getUser(tgId) {
  if (userCache.has(tgId)) return userCache.get(tgId);
  const pages = await notionQuery(DB.drivers, { property: "Telegram ID", rich_text: { equals: String(tgId) } });
  if (!pages.length) return null;
  return cacheUser(pages[0], tgId);
}

async function findByPhone(phone) {
  const all = await notionQuery(DB.drivers);
  return all.find(p => norm(getPhone(p, "Телефон")) === norm(phone)) || null;
}

function cacheUser(page, tgId) {
  const u = {
    pageId: page.id,
    fio:    getTitle(page, "ФИО"),
    phone:  getPhone(page, "Телефон"),
    car:    getText(page, "Гос. номер авто"),
    status: getSel(page, "Статус"),
    isAdmin: ADMIN_IDS.includes(String(tgId)),
    tgId,
  };
  userCache.set(tgId, u);
  return u;
}

async function linkTg(pageId, tgId, username) {
  await notionUpdate(pageId, {
    "Telegram ID":       rt(tgId),
    "Telegram username": rt(username || ""),
  });
}

// ─── КЛАВИАТУРЫ ───────────────────────────────────────────────────────────────

const driverKb = {
  reply_markup: { keyboard: [
    [{ text: "🛠 Заявка на ремонт" }, { text: "🏖 Отпуск / Больничный" }],
    [{ text: "📊 Мой статус" },       { text: "📋 Мои заявки" }],
  ], resize_keyboard: true }
};

const adminKb = {
  reply_markup: { keyboard: [
    [{ text: "🔧 Активные ремонты" }, { text: "📊 Статистика парка" }],
    [{ text: "👥 Найти водителя" },    { text: "📣 Рассылка" }],
    [{ text: "📋 Все заявки" },        { text: "🔔 Проверить сроки" }],
  ], resize_keyboard: true }
};

const sharePhoneKb = {
  reply_markup: { keyboard: [[{ text: "📱 Поделиться номером телефона", request_contact: true }]],
    resize_keyboard: true, one_time_keyboard: true }
};

const cancelKb = {
  reply_markup: { keyboard: [[{ text: "❌ Отмена" }]], resize_keyboard: true, one_time_keyboard: true }
};

function menuFor(user) { return user?.isAdmin ? adminKb : driverKb; }

// ─── INLINE КНОПКИ РЕМОНТА ────────────────────────────────────────────────────

// Статусы и их переходы
const REPAIR_FLOW = {
  "Заявка":     { label: "📋 Заявка",     next: null },
  "Согласовано":{ label: "✅ Согласовано", next: "В работе" },
  "В работе":   { label: "🔧 В работе",    next: "Готово" },
  "Готово":     { label: "🎉 Готово",      next: "Оплачено" },
  "Оплачено":   { label: "💰 Оплачено",    next: null },
  "Отменено":   { label: "❌ Отменено",    next: null },
};

/** Inline-клавиатура для карточки ремонта (для сообщения администратору) */
function repairAdminKb(pageId, status) {
  const buttons = [];

  if (status === "Заявка") {
    buttons.push([
      { text: "✅ Согласовать", callback_data: `rep_approve:${pageId}` },
      { text: "❌ Отклонить",   callback_data: `rep_reject:${pageId}` },
    ]);
  }
  if (status === "Согласовано") {
    buttons.push([
      { text: "🔧 Передать в работу", callback_data: `rep_work:${pageId}` },
    ]);
  }
  if (status === "В работе") {
    buttons.push([
      { text: "✅ Отметить готовым",  callback_data: `rep_done:${pageId}` },
      { text: "💰 Указать стоимость", callback_data: `rep_cost:${pageId}` },
    ]);
  }
  if (status === "Готово") {
    buttons.push([
      { text: "💰 Оплачено",          callback_data: `rep_paid:${pageId}` },
    ]);
  }
  if (!["Оплачено","Отменено","Готово"].includes(status)) {
    buttons.push([
      { text: "💬 Комментарий",       callback_data: `rep_comment:${pageId}` },
    ]);
  }

  return { inline_keyboard: buttons };
}

/** Текст карточки ремонта */
function repairText(r, verbose = true) {
  const status   = r.status || getSel(r.page, "Статус");
  const id       = r.id;
  const car      = r.car;
  const driver   = r.driver;
  const type     = r.type;
  const desc     = r.desc;
  const sto      = r.sto;
  const cost     = r.cost;
  const comment  = r.comment;

  let text = `🔧 <b>Ремонт ${id}</b>  ${REPAIR_FLOW[status]?.label || status}\n\n`;
  text += `🚗 Авто: <b>${car}</b>\n`;
  text += `👤 Водитель: ${driver}\n`;
  text += `🔩 Тип: ${type}\n`;
  if (verbose) text += `📝 ${desc}\n`;
  if (sto)     text += `🏠 СТО: <b>${sto}</b>\n`;
  if (cost)    text += `💰 Стоимость: <b>${cost} ₽</b>\n`;
  if (comment) text += `💬 Комментарий: ${comment}\n`;
  return text;
}

/** Прочитать данные ремонта из Notion-страницы */
function parseRepair(page) {
  return {
    pageId:  page.id,
    id:      getTitle(page, "ID заявки"),
    car:     getText(page, "Гос. номер авто"),
    driver:  getText(page, "ФИО водителя"),
    driverTg:getText(page, "Telegram ID водителя"),
    type:    getSel(page, "Тип ремонта"),
    desc:    getText(page, "Описание поломки"),
    status:  getSel(page, "Статус"),
    sto:     getText(page, "Исполнитель / СТО"),
    cost:    getNum(page, "Стоимость ремонта"),
    comment: getText(page, "Комментарий механика"),
  };
}

// ─── /start ───────────────────────────────────────────────────────────────────

bot.onText(/\/start/, async (msg) => {
  const tgId = msg.from.id;
  userCache.delete(tgId);
  const user = await getUser(tgId);

  if (user) {
    const greeting = user.isAdmin
      ? `👋 Привет, <b>${user.fio}</b>!\n\n<b>Режим администратора</b>`
      : `👋 Привет, <b>${user.fio}</b>!\n🚗 Ваше авто: <b>${user.car || "не привязано"}</b>`;

    await bot.sendMessage(tgId, greeting, { parse_mode: "HTML", ...menuFor(user) });
    return;
  }

  sessions.set(tgId, { state: "waiting_phone" });
  await bot.sendMessage(tgId,
    `👋 Привет! Поделитесь номером телефона для входа в систему:`,
    { parse_mode: "HTML", ...sharePhoneKb });
});

// ─── РЕГИСТРАЦИЯ ──────────────────────────────────────────────────────────────

bot.on("contact", async (msg) => {
  const tgId = msg.from.id;
  if (sessions.get(tgId)?.state !== "waiting_phone") return;

  const phone = norm(msg.contact.phone_number);
  await bot.sendMessage(tgId, "🔍 Ищу в базе...");

  const page = await findByPhone(phone);
  if (!page) {
    sessions.delete(tgId);
    return bot.sendMessage(tgId, `❌ Номер ${phone} не найден. Обратитесь к администратору.`,
      { reply_markup: { remove_keyboard: true } });
  }

  await linkTg(page.id, tgId, msg.from.username);
  const user = cacheUser(page, tgId);
  sessions.delete(tgId);

  const greeting = user.isAdmin
    ? `✅ Добро пожаловать, <b>${user.fio}</b>!\n\n<b>Режим администратора активен.</b>`
    : `✅ Добро пожаловать, <b>${user.fio}</b>!\n🚗 Ваше авто: <b>${user.car || "не привязано"}</b>`;

  await bot.sendMessage(tgId, greeting, { parse_mode: "HTML", ...menuFor(user) });

  for (const a of ADMIN_IDS) {
    bot.sendMessage(a, `👤 Зарегистрировался: <b>${user.fio}</b> (${phone})`, { parse_mode: "HTML" }).catch(() => {});
  }
});

// ─── ЗАЯВКА НА РЕМОНТ ─────────────────────────────────────────────────────────

const REPAIR_TYPES = [
  "🔧 Двигатель",    "⚙️ КПП / Трансмиссия",
  "🛞 Шиномонтаж",   "💥 Кузов / Аварийный",
  "🪟 Стекло",        "🔋 Электрика",
  "🩺 Диагностика",  "❓ Другое",
];

const TYPE_MAP = {
  "🔧 Двигатель":"Двигатель", "⚙️ КПП / Трансмиссия":"Плановый",
  "🛞 Шиномонтаж":"Шиномонтаж", "💥 Кузов / Аварийный":"Аварийный",
  "🪟 Стекло":"Стекло", "🔋 Электрика":"Диагностика",
  "🩺 Диагностика":"Диагностика", "❓ Другое":"Плановый",
};

bot.onText(/^🛠 Заявка на ремонт$/, async (msg) => {
  const tgId = msg.from.id;
  const user = await getUser(tgId);
  if (!user) return askPhone(tgId);
  if (!user.car) return bot.sendMessage(tgId, "⚠️ К вашему аккаунту не привязано авто.\nОбратитесь к администратору.", { ...driverKb });

  sessions.set(tgId, { state: "rep_type", data: { car: user.car } });
  await bot.sendMessage(tgId, `🛠 <b>Заявка на ремонт</b>\nАвто: <b>${user.car}</b>\n\nВыберите тип проблемы:`, {
    parse_mode: "HTML",
    reply_markup: { keyboard: [
      REPAIR_TYPES.slice(0,2), REPAIR_TYPES.slice(2,4),
      REPAIR_TYPES.slice(4,6), REPAIR_TYPES.slice(6,8),
      [{ text: "❌ Отмена" }],
    ], resize_keyboard: true }
  });
});

// ─── МОИ ЗАЯВКИ (водитель) ────────────────────────────────────────────────────

bot.onText(/^📋 Мои заявки$/, async (msg) => {
  const tgId = msg.from.id;
  const user = await getUser(tgId);
  if (!user) return askPhone(tgId);

  const pages = await notionQuery(DB.repairs, {
    property: "ФИО водителя",
    rich_text: { contains: user.fio }
  });

  const active = pages.filter(p => !["Оплачено","Отменено"].includes(getSel(p,"Статус")));
  if (!active.length) return bot.sendMessage(tgId, "✅ У вас нет активных заявок.", driverKb);

  await bot.sendMessage(tgId, `📋 <b>Ваши активные заявки:</b>`, { parse_mode: "HTML" });
  for (const p of active.slice(0,5)) {
    const r = parseRepair(p);
    await bot.sendMessage(tgId, repairText(r), { parse_mode: "HTML" });
  }
});

// ─── АКТИВНЫЕ РЕМОНТЫ (админ) ─────────────────────────────────────────────────

bot.onText(/^🔧 Активные ремонты$/, async (msg) => {
  const tgId = msg.from.id;
  if (!ADMIN_IDS.includes(String(tgId))) return;

  const pages = await notionQuery(DB.repairs, {
    and: [
      { property: "Статус", select: { does_not_equal: "Оплачено" } },
      { property: "Статус", select: { does_not_equal: "Отменено" } },
    ]
  });

  if (!pages.length) return bot.sendMessage(tgId, "✅ Нет активных ремонтов.", adminKb);

  await bot.sendMessage(tgId, `🔧 <b>Активных ремонтов: ${pages.length}</b>`, { parse_mode: "HTML" });

  for (const p of pages.slice(0,10)) {
    const r = parseRepair(p);
    await bot.sendMessage(tgId, repairText(r), {
      parse_mode: "HTML",
      reply_markup: repairAdminKb(p.id, r.status),
    });
  }
});

// ─── СТАТИСТИКА (админ) ───────────────────────────────────────────────────────

bot.onText(/^📊 Статистика парка$/, async (msg) => {
  const tgId = msg.from.id;
  if (!ADMIN_IDS.includes(String(tgId))) return;

  await bot.sendMessage(tgId, "⏳ Считаю...");

  const [cars, drivers, repairs] = await Promise.all([
    notionQuery(DB.cars),
    notionQuery(DB.drivers),
    notionQuery(DB.repairs),
  ]);

  const byStatus = s => cars.filter(p => getSel(p,"Статус") === s).length;
  const repActive = repairs.filter(p => !["Оплачено","Отменено"].includes(getSel(p,"Статус"))).length;
  const working = drivers.filter(p => getSel(p,"Статус") === "Работает").length;
  const vacation = drivers.filter(p => getSel(p,"Статус") === "В отпуске").length;

  const text =
    `📊 <b>Парк сегодня</b>\n\n` +
    `🚗 <b>Автомобили:</b>\n` +
    `  В аренде: ${byStatus("В аренде")}\n` +
    `  Простой: ${byStatus("Простой")}\n` +
    `  Ремонт: ${byStatus("Ремонт")}\n` +
    `  На ТО: ${byStatus("На ТО")}\n\n` +
    `👤 <b>Водители:</b>\n` +
    `  Работают: ${working}\n` +
    `  В отпуске: ${vacation}\n\n` +
    `🔧 <b>Ремонты активных:</b> ${repActive}`;

  await bot.sendMessage(tgId, text, { parse_mode: "HTML", ...adminKb });
});

// ─── ПРОВЕРИТЬ СРОКИ (админ) ──────────────────────────────────────────────────

bot.onText(/^🔔 Проверить сроки$/, async (msg) => {
  const tgId = msg.from.id;
  if (!ADMIN_IDS.includes(String(tgId))) return;
  await bot.sendMessage(tgId, "⏳ Проверяю...");
  await checkDeadlines([tgId]);
  await bot.sendMessage(tgId, "✅ Проверка завершена.", adminKb);
});

// ─── НАЙТИ ВОДИТЕЛЯ (админ) ───────────────────────────────────────────────────

bot.onText(/^👥 Найти водителя$/, async (msg) => {
  const tgId = msg.from.id;
  if (!ADMIN_IDS.includes(String(tgId))) return;
  sessions.set(tgId, { state: "find_driver" });
  await bot.sendMessage(tgId, "Введите ФИО или номер телефона водителя:", cancelKb);
});

// ─── РАССЫЛКА (админ) ─────────────────────────────────────────────────────────

bot.onText(/^📣 Рассылка$/, async (msg) => {
  const tgId = msg.from.id;
  if (!ADMIN_IDS.includes(String(tgId))) return;
  sessions.set(tgId, { state: "broadcast" });
  await bot.sendMessage(tgId,
    "📣 <b>Рассылка всем водителям</b> со статусом «Работает»\n\nВведите текст сообщения:",
    { parse_mode: "HTML", ...cancelKb });
});

// ─── МОЙ СТАТУС ───────────────────────────────────────────────────────────────

bot.onText(/^📊 Мой статус$/, async (msg) => {
  const tgId = msg.from.id;
  userCache.delete(tgId);
  const user = await getUser(tgId);
  if (!user) return askPhone(tgId);

  await bot.sendMessage(tgId,
    `📊 <b>Ваш профиль</b>\n\n` +
    `👤 ${user.fio}\n📱 ${user.phone}\n🚗 ${user.car || "авто не привязано"}\n📋 Статус: ${user.status}`,
    { parse_mode: "HTML", ...menuFor(user) });
});

// ─── CALLBACK (INLINE КНОПКИ) ─────────────────────────────────────────────────

bot.on("callback_query", async (q) => {
  const tgId = q.from.id;
  const [action, pageId] = q.data.split(":");

  // Отвечаем Telegram чтобы убрать "часики"
  await bot.answerCallbackQuery(q.id);

  if (!ADMIN_IDS.includes(String(tgId))) {
    return bot.answerCallbackQuery(q.id, { text: "Нет доступа", show_alert: true });
  }

  const page = await notion.pages.retrieve({ page_id: pageId });
  const r    = parseRepair(page);

  switch (action) {

    // ── Согласовать ─────────────────────────────────────────────────────────
    case "rep_approve": {
      sessions.set(tgId, { state: "rep_approve_sto", data: { pageId, repair: r } });
      await bot.sendMessage(tgId,
        `✅ Согласуете <b>${r.id}</b>\n🚗 ${r.car}\n\nУкажите СТО и примерную стоимость:\n<i>Например: АвтоМастер, 3500р</i>`,
        { parse_mode: "HTML", ...cancelKb });
      break;
    }

    // ── Отклонить ───────────────────────────────────────────────────────────
    case "rep_reject": {
      sessions.set(tgId, { state: "rep_reject_reason", data: { pageId, repair: r } });
      await bot.sendMessage(tgId,
        `❌ Отклоняете <b>${r.id}</b>\n\nУкажите причину отклонения:`,
        { parse_mode: "HTML", ...cancelKb });
      break;
    }

    // ── В работу ────────────────────────────────────────────────────────────
    case "rep_work": {
      await notionUpdate(pageId, {
        "Статус": sel("В работе"),
        "Дата начала ремонта": { date: { start: new Date().toISOString() } },
      });
      r.status = "В работе";
      await editRepairMsg(q, r);
      await notifyDriver(r, `🔧 Заявка <b>${r.id}</b> передана в работу.\nАвто: ${r.car}\nСТО: ${r.sto}`);
      break;
    }

    // ── Готово ──────────────────────────────────────────────────────────────
    case "rep_done": {
      await notionUpdate(pageId, {
        "Статус": sel("Готово"),
        "Дата окончания ремонта": { date: { start: new Date().toISOString() } },
      });
      r.status = "Готово";
      await editRepairMsg(q, r);
      await notifyDriver(r,
        `✅ <b>Ваш автомобиль готов!</b>\n🚗 ${r.car}\n${r.sto ? `Забирайте у: <b>${r.sto}</b>` : ""}`);
      break;
    }

    // ── Оплачено ────────────────────────────────────────────────────────────
    case "rep_paid": {
      await notionUpdate(pageId, { "Статус": sel("Оплачено") });
      r.status = "Оплачено";
      await editRepairMsg(q, r);
      break;
    }

    // ── Указать стоимость ───────────────────────────────────────────────────
    case "rep_cost": {
      sessions.set(tgId, { state: "rep_set_cost", data: { pageId, repair: r } });
      await bot.sendMessage(tgId,
        `💰 Стоимость ремонта <b>${r.id}</b>:\nВведите сумму в рублях:`,
        { parse_mode: "HTML", ...cancelKb });
      break;
    }

    // ── Комментарий ─────────────────────────────────────────────────────────
    case "rep_comment": {
      sessions.set(tgId, { state: "rep_add_comment", data: { pageId, repair: r } });
      await bot.sendMessage(tgId,
        `💬 Комментарий к <b>${r.id}</b>:\nВведите текст:`,
        { parse_mode: "HTML", ...cancelKb });
      break;
    }
  }
});

/** Обновить inline-сообщение карточки ремонта */
async function editRepairMsg(q, r) {
  try {
    await bot.editMessageText(repairText(r), {
      chat_id:      q.message.chat.id,
      message_id:   q.message.message_id,
      parse_mode:   "HTML",
      reply_markup: repairAdminKb(r.pageId, r.status),
    });
  } catch (e) { /* сообщение могло удалиться */ }
}

/** Отправить уведомление водителю */
async function notifyDriver(r, text) {
  if (!r.driverTg) return;
  bot.sendMessage(r.driverTg, text, { parse_mode: "HTML" }).catch(() => {});
}

// ─── FSM ОБРАБОТЧИК ТЕКСТОВЫХ СООБЩЕНИЙ ──────────────────────────────────────

bot.on("message", async (msg) => {
  const tgId = msg.from.id;
  const text = msg.text || "";
  const session = sessions.get(tgId);

  // Отмена
  if (text === "❌ Отмена") {
    sessions.delete(tgId);
    const user = await getUser(tgId);
    return bot.sendMessage(tgId, "Действие отменено.", user ? menuFor(user) : { reply_markup: { remove_keyboard: true } });
  }

  if (!session) return;

  // ── Выбор типа ремонта ──────────────────────────────────────────────────
  if (session.state === "rep_type") {
    const type = TYPE_MAP[text];
    if (!type) return;
    session.data.repairType = type;
    session.data.repairLabel = text;
    session.state = "rep_desc";
    sessions.set(tgId, session);
    return bot.sendMessage(tgId,
      `📝 Опишите неисправность:\n<i>Например: «стук в двигателе при холодном запуске»</i>`,
      { parse_mode: "HTML", ...cancelKb });
  }

  // ── Описание ────────────────────────────────────────────────────────────
  if (session.state === "rep_desc") {
    session.data.desc = text;
    session.state = "rep_photo";
    sessions.set(tgId, session);
    return bot.sendMessage(tgId,
      `📷 Пришлите фото неисправности\nИли нажмите «Пропустить»`,
      { reply_markup: { keyboard: [[{ text: "⏭ Пропустить" }],[{ text: "❌ Отмена" }]], resize_keyboard: true } });
  }

  // ── Фото пропущено ──────────────────────────────────────────────────────
  if (session.state === "rep_photo" && text === "⏭ Пропустить") {
    await createRepair(tgId, session.data, null);
    sessions.delete(tgId);
    return;
  }

  // ── Согласование: ввод СТО ──────────────────────────────────────────────
  if (session.state === "rep_approve_sto") {
    const { pageId, repair: r } = session.data;

    // Парсим "АвтоМастер, 3500р"
    const costMatch = text.match(/(\d[\d\s]*)/);
    const cost = costMatch ? parseFloat(costMatch[1].replace(/\s/g,"")) : null;
    const sto  = text.replace(/,.*$/, "").trim();

    await notionUpdate(pageId, {
      "Статус":                sel("Согласовано"),
      "Исполнитель / СТО":     rt(sto),
      ...(cost ? { "Стоимость ремонта": num(cost) } : {}),
    });

    r.status = "Согласовано";
    r.sto    = sto;
    r.cost   = cost;
    sessions.delete(tgId);

    await bot.sendMessage(tgId, `✅ Заявка ${r.id} согласована!\nСТО: ${sto}${cost ? `, стоимость: ${cost}₽` : ""}`, adminKb);
    await notifyDriver(r,
      `✅ Заявка <b>${r.id}</b> согласована!\n🚗 ${r.car}\n🏠 СТО: <b>${sto}</b>${cost ? `\n💰 Стоимость: ~${cost}₽` : ""}\n\nМы сообщим когда машина будет готова.`);
    return;
  }

  // ── Причина отклонения ──────────────────────────────────────────────────
  if (session.state === "rep_reject_reason") {
    const { pageId, repair: r } = session.data;
    await notionUpdate(pageId, {
      "Статус": sel("Отменено"),
      "Комментарий механика": rt(text),
    });
    r.status = "Отменено";
    sessions.delete(tgId);
    await bot.sendMessage(tgId, `❌ Заявка ${r.id} отклонена.`, adminKb);
    await notifyDriver(r, `❌ Заявка <b>${r.id}</b> отклонена.\nПричина: ${text}`);
    return;
  }

  // ── Указать стоимость ───────────────────────────────────────────────────
  if (session.state === "rep_set_cost") {
    const { pageId, repair: r } = session.data;
    const cost = parseFloat(text.replace(/[^\d.]/g,""));
    if (isNaN(cost)) return bot.sendMessage(tgId, "⚠️ Введите число, например: 3500");
    await notionUpdate(pageId, { "Стоимость ремонта": num(cost) });
    sessions.delete(tgId);
    await bot.sendMessage(tgId, `💰 Стоимость ${r.id} обновлена: ${cost}₽`, adminKb);
    await notifyDriver(r, `💰 Стоимость ремонта вашего авто <b>${r.car}</b>: <b>${cost}₽</b>`);
    return;
  }

  // ── Комментарий механика ────────────────────────────────────────────────
  if (session.state === "rep_add_comment") {
    const { pageId, repair: r } = session.data;
    await notionUpdate(pageId, { "Комментарий механика": rt(text) });
    sessions.delete(tgId);
    await bot.sendMessage(tgId, `💬 Комментарий к ${r.id} сохранён.`, adminKb);
    return;
  }

  // ── Найти водителя ──────────────────────────────────────────────────────
  if (session.state === "find_driver") {
    sessions.delete(tgId);
    const all = await notionQuery(DB.drivers);
    const query = text.toLowerCase();
    const found = all.filter(p => {
      const fio   = getTitle(p,"ФИО").toLowerCase();
      const phone = getPhone(p,"Телефон");
      return fio.includes(query) || phone.includes(query);
    });

    if (!found.length) return bot.sendMessage(tgId, "❌ Не найдено.", adminKb);

    for (const p of found.slice(0,5)) {
      const fio  = getTitle(p,"ФИО");
      const ph   = getPhone(p,"Телефон");
      const car  = getText(p,"Гос. номер авто");
      const stat = getSel(p,"Статус");
      await bot.sendMessage(tgId,
        `👤 <b>${fio}</b>\n📱 ${ph}\n🚗 ${car || "—"}\n📋 ${stat}`,
        { parse_mode: "HTML" });
    }
    await bot.sendMessage(tgId, "—", adminKb);
    return;
  }

  // ── Рассылка ────────────────────────────────────────────────────────────
  if (session.state === "broadcast") {
    sessions.delete(tgId);
    const all = await notionQuery(DB.drivers, { property: "Статус", select: { equals: "Работает" } });
    const broadcastText = `📣 <b>Сообщение от администрации:</b>\n\n${text}`;
    let sent = 0;
    for (const p of all) {
      const tid = getText(p,"Telegram ID");
      if (!tid) continue;
      try {
        await bot.sendMessage(tid, broadcastText, { parse_mode: "HTML" });
        sent++;
      } catch {}
      await new Promise(r => setTimeout(r, 100));
    }
    return bot.sendMessage(tgId, `✅ Рассылка завершена. Отправлено: ${sent} из ${all.length}`, adminKb);
  }
});

// ─── ФОТО РЕМОНТА ─────────────────────────────────────────────────────────────

bot.on("photo", async (msg) => {
  const tgId = msg.from.id;
  const session = sessions.get(tgId);
  if (!session || session.state !== "rep_photo") return;
  await createRepair(tgId, session.data, msg.photo.at(-1).file_id);
  sessions.delete(tgId);
});

// ─── СОЗДАТЬ РЕМОНТ В NOTION ──────────────────────────────────────────────────

async function createRepair(tgId, data, photoFileId) {
  const user     = await getUser(tgId);
  const repairId = await nextId("REM", DB.repairs);

  const page = await notionCreate(DB.repairs, {
    "ID заявки":              ttl(repairId),
    "Гос. номер авто":        rt(data.car || ""),
    "ФИО водителя":           rt(user?.fio || ""),
    "Telegram ID водителя":   rt(String(tgId)),
    "Дата подачи заявки":     { date: { start: new Date().toISOString() } },
    "Тип ремонта":            sel(data.repairType || "Диагностика"),
    "Описание поломки":       rt(data.desc || ""),
    "Статус":                 sel("Заявка"),
  });

  const r = parseRepair(page);
  r.id    = repairId;
  r.car   = data.car;
  r.driver= user?.fio || "";
  r.driverTg = String(tgId);
  r.type  = data.repairType;
  r.desc  = data.desc;

  // Уведомление водителю
  const user2 = await getUser(tgId);
  await bot.sendMessage(tgId,
    `✅ <b>Заявка ${repairId} создана!</b>\n\n🚗 ${data.car}\n🔩 ${data.desc}\n\nАдминистратор рассмотрит заявку.`,
    { parse_mode: "HTML", ...menuFor(user2) });

  // Уведомление всем админам с кнопками
  const adminText =
    `🚨 <b>Новая заявка!</b>\n\n` +
    `📋 <b>${repairId}</b>\n👤 ${user?.fio}\n🚗 ${data.car}\n` +
    `🔩 ${data.repairType}\n📝 ${data.desc}`;

  for (const a of ADMIN_IDS) {
    bot.sendMessage(a, adminText, {
      parse_mode: "HTML",
      reply_markup: repairAdminKb(page.id, "Заявка"),
    }).catch(() => {});
  }
}

// ─── ЕЖЕДНЕВНЫЕ УВЕДОМЛЕНИЯ ───────────────────────────────────────────────────

cron.schedule("0 6 * * *", () => checkDeadlines(ADMIN_IDS));

async function checkDeadlines(adminIds) {
  const today  = new Date();
  const in30   = new Date(today.getTime() + 30 * 86400000).toISOString().slice(0,10);
  const todayS = today.toISOString().slice(0,10);
  const alerts = [];

  // Страховки
  try {
    const ins = await notion.databases.query({ database_id: DB.insurances, filter: {
      and: [
        { property: "Дата окончания действия", date: { before: in30 } },
        { property: "Дата окончания действия", date: { after: todayS } },
      ]
    }});
    for (const p of ins.results) {
      const car  = getText(p,"Гос. номер авто");
      const type = getSel(p,"Тип страховки");
      const end  = getDate(p,"Дата окончания действия");
      const days = Math.ceil((new Date(end) - today) / 86400000);
      alerts.push(`⚠️ <b>${type}</b> ${car} — истекает через <b>${days} дн.</b> (${end})`);
    }
  } catch {}

  // Техосмотры
  try {
    const ins = await notion.databases.query({ database_id: DB.inspections, filter: {
      and: [
        { property: "Действует до", date: { before: in30 } },
        { property: "Действует до", date: { after: todayS } },
      ]
    }});
    for (const p of ins.results) {
      const car  = getText(p,"Гос. номер авто");
      const end  = getDate(p,"Действует до");
      const days = Math.ceil((new Date(end) - today) / 86400000);
      alerts.push(`🚗 <b>Техосмотр</b> ${car} — истекает через <b>${days} дн.</b> (${end})`);
    }
  } catch {}

  if (!alerts.length) return;
  const msg = `🔔 <b>Уведомления на сегодня:</b>\n\n` + alerts.join("\n");
  for (const a of adminIds) {
    bot.sendMessage(a, msg, { parse_mode: "HTML" }).catch(() => {});
  }
}

// ─── МИНИ-ПРИЛОЖЕНИЕ ─────────────────────────────────────────────────────────

if (APP_URL) {
  app.get("/", (req, res) => res.sendFile(__dirname + "/public/index.html"));
}

// ─── WEBHOOK ─────────────────────────────────────────────────────────────────

if (APP_URL) {
  const wPath = `/webhook/${BOT_TOKEN}`;
  app.post(wPath, (req, res) => { bot.processUpdate(req.body); res.sendStatus(200); });
  bot.setWebHook(`${APP_URL}${wPath}`)
    .then(() => console.log(`✅ Webhook: ${APP_URL}${wPath}`))
    .catch(e  => console.error("Webhook error:", e.message));

  fetch(`https://api.telegram.org/bot${BOT_TOKEN}/setChatMenuButton`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ menu_button: { type: "web_app", text: "📅 Выходные", web_app: { url: APP_URL } } })
  }).then(r => r.json()).then(r => console.log("✅ Menu button:", r.ok)).catch(() => {});
}

// ─── ВСПОМОГАТЕЛЬНЫЕ ─────────────────────────────────────────────────────────

async function askPhone(tgId) {
  sessions.set(tgId, { state: "waiting_phone" });
  bot.sendMessage(tgId, "❗ Поделитесь номером телефона для входа:", sharePhoneKb);
}

// ─── ЗАПУСК ───────────────────────────────────────────────────────────────────

app.listen(PORT, () => console.log(`🚀 Server on port ${PORT}`));
