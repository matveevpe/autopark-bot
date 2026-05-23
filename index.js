/**
 * Автопарк CRM — Telegram-бот v3
 * Роли: Водитель / Менеджер / Механик / Администратор
 * Полный цикл ремонта с разводкой уведомлений и логикой оплаты
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
// Супер-администраторы — получают все уведомления
const ADMIN_IDS    = (process.env.ADMIN_IDS || "").split(",").map(s => s.trim()).filter(Boolean);

const DB = {
  cars:         "a52b75e6a94b4e29a7675b0c485a51b7",
  drivers:      "3e4caec4095c45b49eabd35652a00ea0",
  staff:        "66174d5ed4c240788eae47f2ef533e23", // 👔 Сотрудники
  stos:         "09353d23ecb64c4a96fea71594307afe", // 🏪 Сервисные центры
  repairs:      "673701b3aff148b683bb57386786fa80",
  absences:     "8195f2ccc73e418cae12d3639211da86",
  insurances:   "44d9220f9f0c458587f8eb9db711a506",
  inspections:  "cb4026fb6d424cbe894f1ce91f75e772",
};

// Типы ремонта → кто платит по умолчанию
const PAY_DEFAULT = {
  "Двигатель":       "Парк",
  "Плановый":        "Парк",
  "Диагностика":     "Парк",
  "Шиномонтаж":      "Водитель",
  "Стекло":          "Водитель",
  "Аварийный":       "Водитель",
  "Кузовной":        "Водитель",
};

if (!BOT_TOKEN || !NOTION_TOKEN) {
  console.error("❌ Задай BOT_TOKEN и NOTION_TOKEN!"); process.exit(1);
}

// ─── ИНИЦИАЛИЗАЦИЯ ────────────────────────────────────────────────────────────

const notion = new Client({ auth: NOTION_TOKEN });
const app    = express();
app.use(express.json());
app.use(express.static("public"));

const bot      = APP_URL ? new TelegramBot(BOT_TOKEN) : new TelegramBot(BOT_TOKEN, { polling: true });
const cache    = new Map();   // tgId → user object
const sessions = new Map();   // tgId → { state, data }

// ─── NOTION ХЕЛПЕРЫ ───────────────────────────────────────────────────────────

const gTxt  = (p,k) => { try { return p.properties[k].rich_text[0].plain_text; }     catch { return ""; }};
const gTtl  = (p,k) => { try { return p.properties[k].title[0].plain_text; }         catch { return ""; }};
const gSel  = (p,k) => { try { return p.properties[k].select?.name  || ""; }         catch { return ""; }};
const gPh   = (p,k) => { try { return (p.properties[k].phone_number||"").replace(/\D/g,""); } catch { return ""; }};
const gNum  = (p,k) => { try { return p.properties[k].number ?? null; }              catch { return null; }};
const gDate = (p,k) => { try { return p.properties[k].date?.start   || ""; }         catch { return ""; }};
const gChk  = (p,k) => { try { return p.properties[k].checkbox      || false; }      catch { return false; }};
const norm  = s  => (s||"").replace(/\D/g,"").replace(/^8/,"7");

const rt  = v => ({ rich_text: [{ text: { content: String(v||"").slice(0,2000) } }] });
const ttl = v => ({ title:     [{ text: { content: String(v||"").slice(0,2000) } }] });
const sel = v => v ? { select: { name: v } } : { select: null };
const num = v => ({ number: v != null ? parseFloat(v) : null });

async function qry(dbId, filter) {
  const pages = []; let c;
  while (true) {
    const r = await notion.databases.query({ database_id: dbId, filter, start_cursor: c, page_size: 100 });
    pages.push(...r.results);
    if (!r.has_more) break;
    c = r.next_cursor;
  }
  return pages;
}

async function upd(id, props)   { return notion.pages.update({ page_id: id, properties: props }); }
async function crt(db, props)   { return notion.pages.create({ parent: { database_id: db }, properties: props }); }
async function get(id)          { return notion.pages.retrieve({ page_id: id }); }

async function nextId(pfx, db) {
  const pages = await qry(db);
  const key   = pages[0] ? Object.keys(pages[0].properties).find(k => pages[0].properties[k].type === "title") : null;
  const nums  = pages.map(p => { const m = (key ? gTtl(p,key) : "").match(new RegExp(`^${pfx}-(\\d+)$`)); return m ? +m[1] : 0; }).filter(n=>n>0);
  return `${pfx}-${String(Math.max(0,...nums)+1).padStart(3,"0")}`;
}

// ─── ИДЕНТИФИКАЦИЯ ────────────────────────────────────────────────────────────

// Объект пользователя содержит: tgId, role, fio, phone, pageId, car (водитель), sto (механик)
async function getUser(tgId) {
  if (cache.has(tgId)) return cache.get(tgId);
  return await lookupByTgId(tgId);
}

async function lookupByTgId(tgId) {
  // Ищем сначала в Сотрудниках
  const staffPages = await qry(DB.staff, { property: "Telegram ID", rich_text: { equals: String(tgId) } });
  if (staffPages.length) return buildStaffUser(staffPages[0], tgId);

  // Потом в Водителях
  const drvPages = await qry(DB.drivers, { property: "Telegram ID", rich_text: { equals: String(tgId) } });
  if (drvPages.length) return buildDriverUser(drvPages[0], tgId);

  return null;
}

async function findByPhone(phone) {
  const n = norm(phone);
  // Проверяем оба справочника
  const staffAll = await qry(DB.staff);
  const staffPage = staffAll.find(p => norm(gPh(p,"Телефон")) === n);
  const drvAll  = await qry(DB.drivers);
  const drvPage = drvAll.find(p => norm(gPh(p,"Телефон")) === n);
  return { staffPage, drvPage };
}

function buildStaffUser(page, tgId) {
  const u = {
    tgId,
    pageId: page.id,
    fio:    gTtl(page,"ФИО"),
    phone:  gPh(page,"Телефон"),
    role:   gSel(page,"Роль"),  // Менеджер / Механик / Администратор
    sto:    gTxt(page,"СТО"),
    isAdmin: ADMIN_IDS.includes(String(tgId)) || gSel(page,"Роль") === "Администратор",
    db:     "staff",
  };
  cache.set(tgId, u);
  return u;
}

function buildDriverUser(page, tgId) {
  const u = {
    tgId,
    pageId: page.id,
    fio:    gTtl(page,"ФИО"),
    phone:  gPh(page,"Телефон"),
    car:    gTxt(page,"Гос. номер авто"),
    status: gSel(page,"Статус"),
    role:   "Водитель",
    isAdmin: ADMIN_IDS.includes(String(tgId)),
    db:     "driver",
  };
  cache.set(tgId, u);
  return u;
}

async function linkTg(db, pageId, tgId, username) {
  await upd(pageId, { "Telegram ID": rt(tgId), "Telegram username": rt(username||"") });
}

// ─── КЛАВИАТУРЫ ───────────────────────────────────────────────────────────────

const kbDriver = { reply_markup: { keyboard: [
  [{ text: "🛠 Заявка на ремонт" }, { text: "🏖 Отпуск / Больничный" }],
  [{ text: "📊 Мой статус" },       { text: "📋 Мои заявки" }],
], resize_keyboard: true }};

const kbManager = { reply_markup: { keyboard: [
  [{ text: "🔧 Активные ремонты" }, { text: "📊 Статистика парка" }],
  [{ text: "👥 Найти водителя" },    { text: "📣 Рассылка" }],
  [{ text: "🏪 Сервисные центры" }, { text: "🔔 Проверить сроки" }],
], resize_keyboard: true }};

const kbMechanic = { reply_markup: { keyboard: [
  [{ text: "🔧 Мои ремонты" },      { text: "📋 История ремонтов" }],
  [{ text: "📊 Мой статус" }],
], resize_keyboard: true }};

const kbPhone = { reply_markup: { keyboard: [[{ text: "📱 Поделиться номером", request_contact: true }]], resize_keyboard: true, one_time_keyboard: true }};
const kbCancel = { reply_markup: { keyboard: [[{ text: "❌ Отмена" }]], resize_keyboard: true, one_time_keyboard: true }};

function menuFor(user) {
  if (!user) return kbPhone;
  if (user.role === "Механик")     return kbMechanic;
  if (user.role === "Менеджер" || user.role === "Администратор" || user.isAdmin) return kbManager;
  return kbDriver;
}

// ─── /start ───────────────────────────────────────────────────────────────────

bot.onText(/\/start/, async (msg) => {
  const tgId = msg.from.id;
  cache.delete(tgId);
  const user = await getUser(tgId);

  if (user) {
    await greet(tgId, user);
    return;
  }

  sessions.set(tgId, { state: "waiting_phone" });
  await bot.sendMessage(tgId, "👋 Привет! Поделитесь номером для входа в систему:", kbPhone);
});

async function greet(tgId, user) {
  const roleEmoji = { Менеджер: "👔", Механик: "🔧", Администратор: "⚙️", Водитель: "🚗" };
  const e = roleEmoji[user.role] || "👤";

  let text = `👋 Привет, <b>${user.fio}</b>!\n${e} Роль: <b>${user.role}</b>`;
  if (user.car) text += `\n🚗 Авто: <b>${user.car}</b>`;
  if (user.sto) text += `\n🏪 СТО: <b>${user.sto}</b>`;

  await bot.sendMessage(tgId, text, { parse_mode: "HTML", ...menuFor(user) });
}

// ─── РЕГИСТРАЦИЯ ──────────────────────────────────────────────────────────────

bot.on("contact", async (msg) => {
  const tgId = msg.from.id;
  if (sessions.get(tgId)?.state !== "waiting_phone") return;

  const phone = norm(msg.contact.phone_number);
  await bot.sendMessage(tgId, "🔍 Ищу в базе...");

  const { staffPage, drvPage } = await findByPhone(phone);

  if (!staffPage && !drvPage) {
    sessions.delete(tgId);
    return bot.sendMessage(tgId, `❌ Номер не найден в системе. Обратитесь к администратору.`,
      { reply_markup: { remove_keyboard: true } });
  }

  // Если есть и в Сотрудниках и в Водителях — спрашиваем роль
  if (staffPage && drvPage) {
    sessions.set(tgId, { state: "choose_role", data: { phone, staffPageId: staffPage.id, drvPageId: drvPage.id, username: msg.from.username } });
    const staffRole = gSel(staffPage, "Роль");
    return bot.sendMessage(tgId, "Вы совмещаете несколько ролей. Выберите как войти:",
      { reply_markup: { keyboard: [
        [{ text: `👔 ${staffRole}` }],
        [{ text: "🚗 Водитель" }],
      ], resize_keyboard: true, one_time_keyboard: true } });
  }

  // Только один вариант
  let user;
  if (staffPage) {
    await linkTg(DB.staff, staffPage.id, tgId, msg.from.username);
    user = buildStaffUser(staffPage, tgId);
  } else {
    await linkTg(DB.drivers, drvPage.id, tgId, msg.from.username);
    user = buildDriverUser(drvPage, tgId);
  }

  sessions.delete(tgId);
  await greet(tgId, user);

  for (const a of ADMIN_IDS)
    bot.sendMessage(a, `👤 Вошёл: <b>${user.fio}</b> (${user.role})`, { parse_mode: "HTML" }).catch(()=>{});
});

// ─── ВЫБОР РОЛИ ───────────────────────────────────────────────────────────────

bot.on("message", async (msg) => {
  const tgId    = msg.from.id;
  const text    = msg.text || "";
  const session = sessions.get(tgId);

  if (text === "❌ Отмена") {
    sessions.delete(tgId);
    const u = await getUser(tgId);
    return bot.sendMessage(tgId, "Действие отменено.", u ? menuFor(u) : { reply_markup: { remove_keyboard: true } });
  }

  if (!session) return handleMenu(msg);

  // Выбор роли при совмещении
  if (session.state === "choose_role") {
    const { staffPageId, drvPageId, username } = session.data;
    let user;

    if (text.includes("Водитель")) {
      const page = await get(drvPageId);
      await linkTg(DB.drivers, drvPageId, tgId, username);
      user = buildDriverUser(page, tgId);
    } else {
      const page = await get(staffPageId);
      await linkTg(DB.staff, staffPageId, tgId, username);
      user = buildStaffUser(page, tgId);
    }

    sessions.delete(tgId);
    return greet(tgId, user);
  }

  await handleFSM(msg, session);
});

// ─── МЕНЮ ДЕЙСТВИЙ ────────────────────────────────────────────────────────────

async function handleMenu(msg) {
  const tgId = msg.from.id;
  const text = msg.text || "";
  const user = await getUser(tgId);

  if (!user) {
    sessions.set(tgId, { state: "waiting_phone" });
    return bot.sendMessage(tgId, "Поделитесь номером для входа:", kbPhone);
  }

  // ── Водитель ────────────────────────────────────────────────────────────────
  if (text === "🛠 Заявка на ремонт") return startRepair(tgId, user);
  if (text === "📋 Мои заявки")       return showDriverRepairs(tgId, user);
  if (text === "📊 Мой статус")       return showStatus(tgId, user);

  // ── Менеджер / Администратор ─────────────────────────────────────────────────
  if (text === "🔧 Активные ремонты") return showActiveRepairs(tgId);
  if (text === "📊 Статистика парка") return showStats(tgId);
  if (text === "👥 Найти водителя")   return startFindDriver(tgId);
  if (text === "📣 Рассылка")         return startBroadcast(tgId, user);
  if (text === "🏪 Сервисные центры") return showStos(tgId);
  if (text === "🔔 Проверить сроки")  return checkDeadlines([tgId]);

  // ── Механик ──────────────────────────────────────────────────────────────────
  if (text === "🔧 Мои ремонты")      return showMechanicRepairs(tgId, user);
  if (text === "📋 История ремонтов") return showMechanicHistory(tgId, user);
}

// ─── СТАТУС ПОЛЬЗОВАТЕЛЯ ──────────────────────────────────────────────────────

async function showStatus(tgId, user) {
  cache.delete(tgId);
  const u = await getUser(tgId);
  const lines = [
    `📊 <b>Профиль</b>`,
    `👤 ${u.fio}`,
    `📱 ${u.phone}`,
    `🎭 Роль: <b>${u.role}</b>`,
  ];
  if (u.car) lines.push(`🚗 Авто: <b>${u.car}</b>`);
  if (u.sto) lines.push(`🏪 СТО: ${u.sto}`);
  await bot.sendMessage(tgId, lines.join("\n"), { parse_mode: "HTML", ...menuFor(u) });
}

// ─── СЕРВИСНЫЕ ЦЕНТРЫ ─────────────────────────────────────────────────────────

async function showStos(tgId) {
  const pages = await qry(DB.stos);
  if (!pages.length) return bot.sendMessage(tgId, "Список СТО пуст. Добавьте через Notion.", kbManager);

  let text = "🏪 <b>Сервисные центры:</b>\n\n";
  for (const p of pages) {
    const name   = gTtl(p,"Название");
    const addr   = gTxt(p,"Адрес");
    const phone  = gPh(p,"Телефон");
    const spec   = gSel(p,"Специализация");
    const hours  = gTxt(p,"Рабочие часы");
    const active = gChk(p,"Активен");
    if (!active) continue;
    text += `<b>${name}</b> (${spec})\n📍 ${addr}\n📞 ${phone || "—"}\n⏰ ${hours || "—"}\n\n`;
  }
  await bot.sendMessage(tgId, text, { parse_mode: "HTML", ...kbManager });
}

// ─── ЗАЯВКА НА РЕМОНТ (Водитель) ─────────────────────────────────────────────

const REPAIR_TYPES = [
  ["🔧 Двигатель",   "⚙️ КПП / Трансмиссия"],
  ["🛞 Шиномонтаж",  "💥 Кузов / Аварийный"],
  ["🪟 Стекло",       "🔋 Электрика"],
  ["🩺 Диагностика", "❓ Другое"],
  ["❌ Отмена"],
];

const TYPE_MAP = {
  "🔧 Двигатель":"Двигатель", "⚙️ КПП / Трансмиссия":"Плановый",
  "🛞 Шиномонтаж":"Шиномонтаж", "💥 Кузов / Аварийный":"Аварийный",
  "🪟 Стекло":"Стекло", "🔋 Электрика":"Диагностика",
  "🩺 Диагностика":"Диагностика", "❓ Другое":"Плановый",
};

async function startRepair(tgId, user) {
  if (!user.car) return bot.sendMessage(tgId, "⚠️ К вашему аккаунту не привязано авто.\nОбратитесь к администратору.", kbDriver);
  sessions.set(tgId, { state: "rep_type", data: { car: user.car } });
  await bot.sendMessage(tgId, `🛠 <b>Заявка на ремонт</b>\n🚗 ${user.car}\n\nВыберите тип проблемы:`,
    { parse_mode: "HTML", reply_markup: { keyboard: REPAIR_TYPES, resize_keyboard: true } });
}

async function showDriverRepairs(tgId, user) {
  const pages = await qry(DB.repairs, { property: "ФИО водителя", rich_text: { contains: user.fio } });
  const active = pages.filter(p => !["Оплачено","Отменено"].includes(gSel(p,"Статус")));
  if (!active.length) return bot.sendMessage(tgId, "✅ Нет активных заявок.", kbDriver);

  for (const p of active.slice(0,5)) {
    const r = parseRepair(p);
    await bot.sendMessage(tgId, repairCard(r), { parse_mode: "HTML" });
  }
}

// ─── АКТИВНЫЕ РЕМОНТЫ (Менеджер) ─────────────────────────────────────────────

async function showActiveRepairs(tgId) {
  const pages = await qry(DB.repairs, { and: [
    { property: "Статус", select: { does_not_equal: "Оплачено" } },
    { property: "Статус", select: { does_not_equal: "Отменено" } },
  ]});

  if (!pages.length) return bot.sendMessage(tgId, "✅ Нет активных ремонтов.", kbManager);
  await bot.sendMessage(tgId, `🔧 <b>Активных: ${pages.length}</b>`, { parse_mode: "HTML" });

  for (const p of pages.slice(0,10)) {
    const r = parseRepair(p);
    await bot.sendMessage(tgId, repairCard(r), {
      parse_mode: "HTML",
      reply_markup: managerRepairKb(p.id, r),
    });
  }
}

// ─── МОИ РЕМОНТЫ (Механик) ────────────────────────────────────────────────────

async function showMechanicRepairs(tgId, user) {
  const pages = await qry(DB.repairs, { and: [
    { property: "Механик Telegram ID", rich_text: { equals: String(tgId) } },
    { property: "Статус", select: { does_not_equal: "Оплачено" } },
    { property: "Статус", select: { does_not_equal: "Отменено" } },
  ]});

  if (!pages.length) return bot.sendMessage(tgId, "✅ Нет назначенных ремонтов.", kbMechanic);

  for (const p of pages.slice(0,10)) {
    const r = parseRepair(p);
    await bot.sendMessage(tgId, repairCard(r), {
      parse_mode: "HTML",
      reply_markup: mechanicRepairKb(p.id, r),
    });
  }
}

async function showMechanicHistory(tgId, user) {
  const pages = await qry(DB.repairs, { and: [
    { property: "Механик Telegram ID", rich_text: { equals: String(tgId) } },
    { property: "Статус", select: { equals: "Готово" } },
  ]});

  if (!pages.length) return bot.sendMessage(tgId, "История ремонтов пуста.", kbMechanic);
  await bot.sendMessage(tgId, `✅ Завершённых ремонтов: ${pages.length}`, kbMechanic);
}

// ─── СТАТИСТИКА (Менеджер) ────────────────────────────────────────────────────

async function showStats(tgId) {
  await bot.sendMessage(tgId, "⏳ Считаю...");
  const [cars, drivers, repairs] = await Promise.all([
    qry(DB.cars), qry(DB.drivers), qry(DB.repairs)
  ]);
  const cs = s => cars.filter(p => gSel(p,"Статус") === s).length;
  const repA = repairs.filter(p => !["Оплачено","Отменено"].includes(gSel(p,"Статус"))).length;
  const repW = repairs.filter(p => gSel(p,"Кто оплачивает") === "Водитель" && gSel(p,"Статус") === "Заявка").length;

  await bot.sendMessage(tgId,
    `📊 <b>Парк</b>\n\n` +
    `🚗 В аренде: ${cs("В аренде")} | Простой: ${cs("Простой")} | Ремонт: ${cs("Ремонт")}\n\n` +
    `👤 Водителей: ${drivers.filter(p=>gSel(p,"Статус")==="Работает").length}\n\n` +
    `🔧 Активных ремонтов: ${repA}\n` +
    `💰 За счёт водителей (новые): ${repW}`,
    { parse_mode: "HTML", ...kbManager });
}

// ─── INLINE КНОПКИ ────────────────────────────────────────────────────────────

// Кнопки менеджера для заявки
function managerRepairKb(pageId, r) {
  const btn = (text, action) => ({ text, callback_data: `${action}:${pageId}` });
  const rows = [];

  if (r.status === "Заявка") {
    rows.push([btn("✅ Согласовать", "m_approve"), btn("❌ Отклонить", "m_reject")]);
    rows.push([btn(`💰 Платит: ${r.payer || "?"}`, "m_toggle_payer")]);
  }
  if (r.status === "Согласовано") {
    rows.push([btn("🔧 Назначить механика", "m_assign_mech")]);
  }
  if (r.status === "В работе") {
    rows.push([btn("✅ Готово", "m_done"), btn("💰 Стоимость", "m_set_cost")]);
  }
  if (r.status === "Готово") {
    rows.push([btn("💰 Оплачено", "m_paid")]);
  }
  if (!["Оплачено","Отменено"].includes(r.status)) {
    rows.push([btn("💬 Комментарий", "m_comment")]);
  }

  return { inline_keyboard: rows };
}

// Кнопки механика
function mechanicRepairKb(pageId, r) {
  const btn = (text, action) => ({ text, callback_data: `${action}:${pageId}` });
  const rows = [];

  if (r.status === "Согласовано") {
    rows.push([btn("▶️ Начать ремонт", "mech_start")]);
  }
  if (r.status === "В работе") {
    rows.push([btn("✅ Завершить", "mech_done")]);
    if (r.payer === "Водитель") {
      rows.push([btn("💰 Выставить счёт водителю", "mech_send_bill")]);
    }
    rows.push([btn("📸 Прикрепить фото", "mech_photo")]);
    rows.push([btn("💬 Комментарий", "mech_comment")]);
  }

  return { inline_keyboard: rows };
}

// Разобрать ремонт из страницы Notion
function parseRepair(page) {
  return {
    pageId:      page.id,
    id:          gTtl(page,"ID заявки"),
    car:         gTxt(page,"Гос. номер авто"),
    driver:      gTxt(page,"ФИО водителя"),
    driverTg:    gTxt(page,"Telegram ID водителя"),
    type:        gSel(page,"Тип ремонта"),
    desc:        gTxt(page,"Описание поломки"),
    status:      gSel(page,"Статус"),
    payer:       gSel(page,"Кто оплачивает"),
    mechFio:     gTxt(page,"Механик ФИО"),
    mechTg:      gTxt(page,"Механик Telegram ID"),
    sto:         gTxt(page,"Исполнитель / СТО"),
    stoAddr:     gTxt(page,"Адрес СТО"),
    cost:        gNum(page,"Стоимость ремонта"),
    mechCost:    gNum(page,"Стоимость услуг механика"),
    comment:     gTxt(page,"Комментарий механика"),
    driverAgree: gSel(page,"Согласие водителя"),
  };
}

// Карточка ремонта в тексте
function repairCard(r) {
  const statusIcon = { "Заявка":"📋","Согласовано":"✅","В работе":"🔧","Готово":"🎉","Отменено":"❌","Оплачено":"💰" };
  const payIcon    = { "Парк":"🏢","Водитель":"👤","Страховка":"🛡","50/50":"⚖️" };

  let t = `${statusIcon[r.status]||"?"} <b>${r.id}</b> — ${r.status}\n\n`;
  t += `🚗 <b>${r.car}</b> | 👤 ${r.driver}\n`;
  t += `🔩 ${r.type} | ${payIcon[r.payer]||"?"} Платит: <b>${r.payer||"—"}</b>\n`;
  t += `📝 ${r.desc}\n`;
  if (r.mechFio)  t += `🔧 Механик: ${r.mechFio}\n`;
  if (r.sto)      t += `🏪 СТО: ${r.sto}\n`;
  if (r.stoAddr)  t += `📍 ${r.stoAddr}\n`;
  if (r.cost)     t += `💰 Стоимость: <b>${r.cost}₽</b>\n`;
  if (r.mechCost) t += `🔧 Услуги механика: <b>${r.mechCost}₽</b>\n`;
  if (r.comment)  t += `💬 ${r.comment}\n`;
  return t;
}

// ─── CALLBACK QUERY ───────────────────────────────────────────────────────────

bot.on("callback_query", async (q) => {
  const tgId = q.from.id;
  await bot.answerCallbackQuery(q.id);

  const [action, pageId] = q.data.split(":");
  const page = await get(pageId);
  const r    = parseRepair(page);

  // ── Менеджер ────────────────────────────────────────────────────────────────

  // Переключить кто платит
  if (action === "m_toggle_payer") {
    const cycle = ["Парк","Водитель","Страховка","50/50"];
    const next  = cycle[(cycle.indexOf(r.payer)+1) % cycle.length];
    await upd(pageId, { "Кто оплачивает": sel(next) });
    r.payer = next;
    return editMsg(q, repairCard(r), managerRepairKb(pageId, r));
  }

  // Согласовать → выбрать СТО
  if (action === "m_approve") {
    const stos = (await qry(DB.stos)).filter(p => gChk(p,"Активен"));
    if (!stos.length) {
      sessions.set(tgId, { state: "m_approve_sto_text", data: { pageId, repair: r } });
      return bot.sendMessage(tgId, "Введите название и адрес СТО:", kbCancel);
    }
    sessions.set(tgId, { state: "m_approve_sto_select", data: { pageId, repair: r } });
    const buttons = stos.map(p => [{ text: `🏪 ${gTtl(p,"Название")}`, callback_data: `sto_sel:${pageId}:${p.id}` }]);
    buttons.push([{ text: "✏️ Ввести вручную", callback_data: `sto_manual:${pageId}` }]);
    return bot.sendMessage(tgId, `Выберите СТО для <b>${r.id}</b>:`,
      { parse_mode: "HTML", reply_markup: { inline_keyboard: buttons } });
  }

  // Выбор СТО из списка
  if (action === "sto_sel") {
    const [,repPageId, stoPageId] = q.data.split(":");
    const repPage  = await get(repPageId);
    const repR     = parseRepair(repPage);
    const stoPage  = await get(stoPageId);
    const stoName  = gTtl(stoPage,"Название");
    const stoAddr  = gTxt(stoPage,"Адрес");
    // Теперь выбираем механика
    sessions.set(tgId, { state: "m_assign_mech_after_sto", data: { pageId: repPageId, repair: repR, sto: stoName, stoAddr } });
    return chooseMechanic(tgId, repR);
  }

  // СТО вручную
  if (action === "sto_manual") {
    const repPage = await get(pageId);
    sessions.set(tgId, { state: "m_approve_sto_text", data: { pageId, repair: parseRepair(repPage) } });
    return bot.sendMessage(tgId, "Введите название СТО и адрес:\n<i>Например: АвтоМастер, ул. Ленина 15</i>",
      { parse_mode: "HTML", ...kbCancel });
  }

  // Назначить механика (кнопка)
  if (action === "m_assign_mech") {
    sessions.set(tgId, { state: "m_assign_mech_after_sto", data: { pageId, repair: r, sto: r.sto, stoAddr: r.stoAddr } });
    return chooseMechanic(tgId, r);
  }

  // Выбор механика из списка
  if (action === "mech_sel") {
    const parts = q.data.split(":");
    const mechPageId = parts[2];
    const repPageId  = parts[1];
    const repPage    = await get(repPageId);
    const repR       = parseRepair(repPage);
    const sesData    = sessions.get(tgId)?.data || {};

    const mechPage = await get(mechPageId);
    const mechFio  = gTtl(mechPage,"ФИО");
    const mechTgId = gTxt(mechPage,"Telegram ID");
    const mechSto  = gTxt(mechPage,"СТО");

    const sto     = sesData.sto || mechSto || repR.sto || "";
    const stoAddr = sesData.stoAddr || repR.stoAddr || "";

    await upd(repPageId, {
      "Статус":              sel("Согласовано"),
      "Механик ФИО":         rt(mechFio),
      "Механик Telegram ID": rt(mechTgId),
      "Исполнитель / СТО":   rt(sto),
      "Адрес СТО":           rt(stoAddr),
    });

    sessions.delete(tgId);
    repR.status  = "Согласовано";
    repR.mechFio = mechFio;
    repR.sto     = sto;
    repR.stoAddr = stoAddr;

    await bot.sendMessage(tgId, `✅ ${repR.id} согласован\n👷 Механик: ${mechFio}\n🏪 СТО: ${sto}`, kbManager);

    // Уведомляем механика
    if (mechTgId) {
      const payNote = repR.payer === "Водитель" ? "\n💰 <b>Оплата за счёт водителя</b> — выставьте счёт после ремонта" : "\n🏢 Оплата за счёт парка";
      bot.sendMessage(mechTgId,
        `🔧 <b>Вам назначен ремонт ${repR.id}!</b>\n\n🚗 ${repR.car}\n📍 ${sto}${stoAddr ? ` — ${stoAddr}` : ""}\n🔩 ${repR.type}\n📝 ${repR.desc}${payNote}`,
        { parse_mode: "HTML", reply_markup: mechanicRepairKb(repPageId, repR) }).catch(()=>{});
    }

    // Уведомляем водителя
    notifyDriver(repR, `✅ Заявка <b>${repR.id}</b> согласована!\n🏪 СТО: ${sto}\n${stoAddr ? `📍 ${stoAddr}` : ""}\n🔧 Механик: ${mechFio}`);
    return;
  }

  // Отклонить
  if (action === "m_reject") {
    sessions.set(tgId, { state: "m_reject_reason", data: { pageId, repair: r } });
    return bot.sendMessage(tgId, `Причина отклонения <b>${r.id}</b>:`, { parse_mode: "HTML", ...kbCancel });
  }

  // Готово (менеджер)
  if (action === "m_done") {
    await upd(pageId, { "Статус": sel("Готово"), "date:Дата окончания ремонта:start": new Date().toISOString(), "date:Дата окончания ремонта:is_datetime": 1 });
    r.status = "Готово";
    await editMsg(q, repairCard(r), managerRepairKb(pageId, r));
    notifyDriver(r, `🎉 Ваш автомобиль готов!\n🚗 ${r.car}${r.stoAddr ? `\n📍 Забирайте: ${r.stoAddr}` : ""}`);
    return;
  }

  // Оплачено
  if (action === "m_paid") {
    await upd(pageId, { "Статус": sel("Оплачено") });
    r.status = "Оплачено";
    return editMsg(q, repairCard(r), { inline_keyboard: [] });
  }

  // Указать стоимость
  if (action === "m_set_cost") {
    sessions.set(tgId, { state: "m_set_cost", data: { pageId, repair: r } });
    return bot.sendMessage(tgId, `💰 Стоимость ремонта <b>${r.id}</b> (₽):`, { parse_mode: "HTML", ...kbCancel });
  }

  // Комментарий менеджера
  if (action === "m_comment") {
    sessions.set(tgId, { state: "m_comment", data: { pageId, repair: r } });
    return bot.sendMessage(tgId, `💬 Комментарий к <b>${r.id}</b>:`, { parse_mode: "HTML", ...kbCancel });
  }

  // ── Механик ─────────────────────────────────────────────────────────────────

  // Начать ремонт
  if (action === "mech_start") {
    await upd(pageId, { "Статус": sel("В работе"), "date:Дата начала ремонта:start": new Date().toISOString(), "date:Дата начала ремонта:is_datetime": 1 });
    r.status = "В работе";
    await editMsg(q, repairCard(r), mechanicRepairKb(pageId, r));
    notifyManagers(`🔧 Механик ${r.mechFio} начал ремонт <b>${r.id}</b>\n🚗 ${r.car}`);
    notifyDriver(r, `🔧 Ремонт <b>${r.id}</b> начат.\nМеханик: ${r.mechFio}`);
    return;
  }

  // Завершить ремонт (механик)
  if (action === "mech_done") {
    await upd(pageId, { "Статус": sel("Готово"), "date:Дата окончания ремонта:start": new Date().toISOString(), "date:Дата окончания ремонта:is_datetime": 1 });
    r.status = "Готово";
    await editMsg(q, repairCard(r), { inline_keyboard: [] });

    // Если платит парк — просто уведомляем
    if (r.payer !== "Водитель") {
      notifyManagers(`✅ Механик ${r.mechFio} завершил <b>${r.id}</b>\n🚗 ${r.car}`);
      notifyDriver(r, `🎉 Ваш автомобиль готов!\n🚗 ${r.car}\n📍 ${r.stoAddr || r.sto || ""}`);
    }
    // Если платит водитель — ждём счёта от механика
    else {
      await bot.sendMessage(tgId, `✅ Ремонт завершён!\n💰 Выставьте счёт водителю через кнопку «💰 Выставить счёт».`);
      notifyManagers(`✅ Механик ${r.mechFio} завершил <b>${r.id}</b>\n🚗 ${r.car}\n💰 Ожидает счёта водителю`);
    }
    return;
  }

  // Выставить счёт водителю
  if (action === "mech_send_bill") {
    sessions.set(tgId, { state: "mech_bill", data: { pageId, repair: r } });
    return bot.sendMessage(tgId,
      `💰 Введите стоимость ваших услуг для <b>${r.id}</b> (₽):\n\n<i>Эта сумма будет отправлена водителю для подтверждения.</i>`,
      { parse_mode: "HTML", ...kbCancel });
  }

  // Комментарий механика
  if (action === "mech_comment") {
    sessions.set(tgId, { state: "mech_comment", data: { pageId, repair: r } });
    return bot.sendMessage(tgId, `💬 Комментарий к <b>${r.id}</b>:`, { parse_mode: "HTML", ...kbCancel });
  }

  // ── Водитель: согласие с оплатой ────────────────────────────────────────────

  if (action === "drv_agree_cost") {
    await upd(pageId, { "Согласие водителя": sel("Согласен") });
    await bot.sendMessage(tgId, `✅ Стоимость ремонта подтверждена. Спасибо!`, kbDriver);
    notifyManagers(`💰 Водитель <b>${r.driver}</b> согласился с оплатой ${r.mechCost}₽\nЗаявка: <b>${r.id}</b>`);
    return;
  }

  if (action === "drv_dispute_cost") {
    await upd(pageId, { "Согласие водителя": sel("Оспаривает") });
    await bot.sendMessage(tgId, `⚠️ Мы зафиксировали ваш спор. Менеджер свяжется с вами.`, kbDriver);
    notifyManagers(`⚠️ Водитель <b>${r.driver}</b> оспаривает стоимость ремонта!\nЗаявка: <b>${r.id}</b> | Сумма: ${r.mechCost}₽`);
    return;
  }
});

// ─── ВЫБОР МЕХАНИКА ───────────────────────────────────────────────────────────

async function chooseMechanic(tgId, repair) {
  const mechs = await qry(DB.staff, { and: [
    { property: "Роль",   select: { equals: "Механик" } },
    { property: "Статус", select: { equals: "Активен" } },
  ]});

  if (!mechs.length) {
    sessions.set(tgId, { ...sessions.get(tgId), state: "m_assign_mech_text" });
    return bot.sendMessage(tgId, "Нет доступных механиков в базе.\nВведите ФИО механика вручную:", kbCancel);
  }

  const buttons = mechs.map(p => [{
    text: `🔧 ${gTtl(p,"ФИО")} (${gTxt(p,"СТО")||"—"})`,
    callback_data: `mech_sel:${repair.pageId}:${p.id}`
  }]);
  buttons.push([{ text: "✏️ Ввести вручную", callback_data: `mech_sel_manual:${repair.pageId}` }]);

  await bot.sendMessage(tgId, `Назначьте механика для <b>${repair.id}</b>:`,
    { parse_mode: "HTML", reply_markup: { inline_keyboard: buttons } });
}

// ─── FSM ──────────────────────────────────────────────────────────────────────

async function handleFSM(msg, session) {
  const tgId = msg.from.id;
  const text = msg.text || "";
  const { state, data } = session;
  const user = await getUser(tgId);

  // Тип ремонта
  if (state === "rep_type") {
    const type = TYPE_MAP[text];
    if (!type) return;
    data.repairType  = type;
    data.defaultPayer = PAY_DEFAULT[type] || "Парк";
    session.state = "rep_desc";
    sessions.set(tgId, session);
    return bot.sendMessage(tgId, `📝 Опишите неисправность:`, kbCancel);
  }

  // Описание
  if (state === "rep_desc") {
    data.desc = text;
    session.state = "rep_photo";
    sessions.set(tgId, session);
    return bot.sendMessage(tgId, `📷 Пришлите фото или нажмите «Пропустить»`,
      { reply_markup: { keyboard: [[{ text: "⏭ Пропустить" }],[{ text: "❌ Отмена" }]], resize_keyboard: true } });
  }

  // Фото пропущено
  if (state === "rep_photo" && text === "⏭ Пропустить") {
    sessions.delete(tgId);
    return createRepair(tgId, data, null);
  }

  // СТО вручную (после согласования)
  if (state === "m_approve_sto_text") {
    const parts   = text.split(",");
    const stoName = parts[0].trim();
    const stoAddr = parts.slice(1).join(",").trim();
    data.sto     = stoName;
    data.stoAddr = stoAddr;
    session.state = "m_assign_mech_after_sto";
    sessions.set(tgId, session);
    return chooseMechanic(tgId, data.repair);
  }

  // Отклонение: причина
  if (state === "m_reject_reason") {
    const { pageId, repair: r } = data;
    await upd(pageId, { "Статус": sel("Отменено"), "Комментарий механика": rt(text) });
    sessions.delete(tgId);
    await bot.sendMessage(tgId, `❌ ${r.id} отклонён.`, kbManager);
    notifyDriver(r, `❌ Заявка <b>${r.id}</b> отклонена.\nПричина: ${text}`);
    return;
  }

  // Стоимость (менеджер)
  if (state === "m_set_cost") {
    const cost = parseFloat(text.replace(/[^\d.]/g,""));
    if (isNaN(cost)) return bot.sendMessage(tgId, "⚠️ Введите число, например: 3500");
    const { pageId, repair: r } = data;
    await upd(pageId, { "Стоимость ремонта": num(cost) });
    sessions.delete(tgId);
    await bot.sendMessage(tgId, `💰 Стоимость ${r.id} — ${cost}₽ сохранена.`, kbManager);
    if (r.payer === "Водитель")
      notifyDriver(r, `💰 Стоимость ремонта <b>${r.id}</b>: <b>${cost}₽</b>`);
    return;
  }

  // Комментарий (менеджер)
  if (state === "m_comment") {
    const { pageId, repair: r } = data;
    await upd(pageId, { "Комментарий механика": rt(text) });
    sessions.delete(tgId);
    await bot.sendMessage(tgId, `💬 Комментарий сохранён.`, kbManager);
    return;
  }

  // Комментарий (механик)
  if (state === "mech_comment") {
    const { pageId, repair: r } = data;
    await upd(pageId, { "Комментарий механика": rt(text) });
    sessions.delete(tgId);
    await bot.sendMessage(tgId, `💬 Комментарий сохранён.`, kbMechanic);
    return;
  }

  // Счёт водителю (механик)
  if (state === "mech_bill") {
    const cost = parseFloat(text.replace(/[^\d.]/g,""));
    if (isNaN(cost)) return bot.sendMessage(tgId, "⚠️ Введите сумму, например: 1500");
    const { pageId, repair: r } = data;
    await upd(pageId, { "Стоимость услуг механика": num(cost), "Согласие водителя": sel("Ожидает") });
    sessions.delete(tgId);
    await bot.sendMessage(tgId, `✅ Счёт ${cost}₽ выставлен водителю.`, kbMechanic);

    // Отправляем водителю запрос на подтверждение
    if (r.driverTg) {
      bot.sendMessage(r.driverTg,
        `💰 <b>Ремонт вашего авто ${r.car}</b>\n\nМеханик: ${r.mechFio}\nСтоимость услуг: <b>${cost}₽</b>\n\nПодтвердите оплату:`,
        { parse_mode: "HTML", reply_markup: { inline_keyboard: [[
          { text: "✅ Согласен", callback_data: `drv_agree_cost:${pageId}` },
          { text: "❌ Оспорить", callback_data: `drv_dispute_cost:${pageId}` },
        ]]}}).catch(()=>{});
    }
    return;
  }

  // Поиск водителя
  if (state === "find_driver") {
    sessions.delete(tgId);
    const all = await qry(DB.drivers);
    const q2  = text.toLowerCase();
    const found = all.filter(p => gTtl(p,"ФИО").toLowerCase().includes(q2) || gPh(p,"Телефон").includes(q2));
    if (!found.length) return bot.sendMessage(tgId, "❌ Не найдено.", kbManager);
    for (const p of found.slice(0,5)) {
      await bot.sendMessage(tgId,
        `👤 <b>${gTtl(p,"ФИО")}</b>\n📱 ${gPh(p,"Телефон")}\n🚗 ${gTxt(p,"Гос. номер авто")||"—"}\n📋 ${gSel(p,"Статус")}`,
        { parse_mode: "HTML" });
    }
    return bot.sendMessage(tgId, "—", kbManager);
  }

  // Рассылка
  if (state === "broadcast") {
    sessions.delete(tgId);
    const all = await qry(DB.drivers, { property: "Статус", select: { equals: "Работает" } });
    let sent = 0;
    for (const p of all) {
      const tid = gTxt(p,"Telegram ID");
      if (!tid) continue;
      try { await bot.sendMessage(tid, `📣 <b>Сообщение от администрации:</b>\n\n${text}`, { parse_mode: "HTML" }); sent++; }
      catch {}
      await new Promise(r => setTimeout(r, 100));
    }
    return bot.sendMessage(tgId, `✅ Отправлено: ${sent}/${all.length}`, kbManager);
  }
}

// ─── ФОТО ─────────────────────────────────────────────────────────────────────

bot.on("photo", async (msg) => {
  const tgId = msg.from.id;
  const sess = sessions.get(tgId);
  if (!sess) return;
  if (sess.state === "rep_photo") {
    sessions.delete(tgId);
    await createRepair(tgId, sess.data, msg.photo.at(-1).file_id);
  }
});

// ─── СОЗДАТЬ РЕМОНТ ───────────────────────────────────────────────────────────

async function createRepair(tgId, data, _photo) {
  const user     = await getUser(tgId);
  const repairId = await nextId("REM", DB.repairs);
  const payer    = data.defaultPayer || "Парк";

  const page = await crt(DB.repairs, {
    "ID заявки":              ttl(repairId),
    "Гос. номер авто":        rt(data.car||""),
    "ФИО водителя":           rt(user?.fio||""),
    "Telegram ID водителя":   rt(String(tgId)),
    "Тип ремонта":            sel(data.repairType||"Диагностика"),
    "Описание поломки":       rt(data.desc||""),
    "Статус":                 sel("Заявка"),
    "Кто оплачивает":         sel(payer),
    "date:Дата подачи заявки:start":       new Date().toISOString().slice(0,10),
    "date:Дата подачи заявки:is_datetime": 0,
  });

  const r      = parseRepair(page);
  r.id         = repairId;
  r.car        = data.car;
  r.driver     = user?.fio||"";
  r.driverTg   = String(tgId);
  r.type       = data.repairType;
  r.desc       = data.desc;
  r.payer      = payer;

  const payIcon = payer === "Парк" ? "🏢 За счёт парка" : "👤 За счёт водителя";
  await bot.sendMessage(tgId,
    `✅ <b>Заявка ${repairId} создана!</b>\n🚗 ${data.car}\n🔩 ${data.desc}\n${payIcon}\n\nОжидайте решения менеджера.`,
    { parse_mode: "HTML", ...kbDriver });

  // Уведомляем менеджеров с кнопками
  const adminText =
    `🚨 <b>Новая заявка ${repairId}</b>\n\n` +
    `🚗 <b>${data.car}</b>\n👤 ${user?.fio}\n` +
    `🔩 ${data.repairType}\n📝 ${data.desc}\n` +
    `💰 Платит: <b>${payer}</b>`;

  for (const a of await getManagerIds()) {
    bot.sendMessage(a, adminText, {
      parse_mode: "HTML",
      reply_markup: managerRepairKb(page.id, r),
    }).catch(()=>{});
  }
}

// ─── ВСПОМОГАТЕЛЬНЫЕ ─────────────────────────────────────────────────────────

// Получить Telegram ID всех менеджеров и администраторов
async function getManagerIds() {
  const ids = new Set(ADMIN_IDS);
  const mgrs = await qry(DB.staff, { and: [
    { property: "Роль",   select: { does_not_equal: "Механик" } },
    { property: "Статус", select: { equals: "Активен" } },
  ]});
  for (const p of mgrs) { const tid = gTxt(p,"Telegram ID"); if (tid) ids.add(tid); }
  return [...ids];
}

function notifyDriver(r, text) {
  if (!r.driverTg) return;
  bot.sendMessage(r.driverTg, text, { parse_mode: "HTML" }).catch(()=>{});
}

async function notifyManagers(text) {
  const ids = await getManagerIds();
  for (const id of ids) bot.sendMessage(id, text, { parse_mode: "HTML" }).catch(()=>{});
}

async function startFindDriver(tgId) {
  sessions.set(tgId, { state: "find_driver" });
  await bot.sendMessage(tgId, "Введите ФИО или телефон:", kbCancel);
}

async function startBroadcast(tgId) {
  sessions.set(tgId, { state: "broadcast" });
  await bot.sendMessage(tgId, "📣 Введите текст рассылки:", kbCancel);
}

function editMsg(q, text, kb) {
  return bot.editMessageText(text, {
    chat_id: q.message.chat.id, message_id: q.message.message_id,
    parse_mode: "HTML", reply_markup: kb,
  }).catch(()=>{});
}

// ─── ЕЖЕДНЕВНЫЕ УВЕДОМЛЕНИЯ ───────────────────────────────────────────────────

cron.schedule("0 6 * * *", async () => {
  const ids = await getManagerIds();
  checkDeadlines(ids);
});

async function checkDeadlines(adminIds) {
  const today = new Date();
  const in30  = new Date(today.getTime()+30*86400000).toISOString().slice(0,10);
  const todS  = today.toISOString().slice(0,10);
  const alerts = [];

  try {
    const ins = await notion.databases.query({ database_id: DB.insurances, filter: { and: [
      { property: "Дата окончания действия", date: { before: in30 } },
      { property: "Дата окончания действия", date: { after: todS } },
    ]}});
    for (const p of ins.results) {
      const days = Math.ceil((new Date(gDate(p,"Дата окончания действия")) - today)/86400000);
      alerts.push(`⚠️ ${gSel(p,"Тип страховки")} ${gTxt(p,"Гос. номер авто")} — ${days} дн.`);
    }
  } catch {}

  try {
    const ins = await notion.databases.query({ database_id: DB.inspections, filter: { and: [
      { property: "Действует до", date: { before: in30 } },
      { property: "Действует до", date: { after: todS } },
    ]}});
    for (const p of ins.results) {
      const days = Math.ceil((new Date(gDate(p,"Действует до")) - today)/86400000);
      alerts.push(`🚗 Техосмотр ${gTxt(p,"Гос. номер авто")} — ${days} дн.`);
    }
  } catch {}

  if (!alerts.length) return;
  const msg = `🔔 <b>Истекающие сроки:</b>\n\n` + alerts.join("\n");
  for (const a of adminIds) bot.sendMessage(a, msg, { parse_mode: "HTML" }).catch(()=>{});
}

// ─── WEBHOOK ─────────────────────────────────────────────────────────────────

if (APP_URL) {
  const wPath = `/webhook/${BOT_TOKEN}`;
  app.post(wPath, (req, res) => { bot.processUpdate(req.body); res.sendStatus(200); });
  bot.setWebHook(`${APP_URL}${wPath}`).then(() => console.log(`✅ Webhook set`)).catch(e => console.error(e));
  app.get("/", (req, res) => res.sendFile(__dirname + "/public/index.html"));

  fetch(`https://api.telegram.org/bot${BOT_TOKEN}/setChatMenuButton`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ menu_button: { type: "web_app", text: "📅 Выходные", web_app: { url: APP_URL } } })
  }).then(r=>r.json()).then(r=>console.log("✅ Menu:", r.ok)).catch(()=>{});
}

app.listen(PORT, () => console.log(`🚀 Port ${PORT}`));
