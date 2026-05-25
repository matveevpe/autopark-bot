/**
 * MAX мессенджер — бот (max.ru)
 * Подключается к тому же Notion что и Telegram-бот
 * Добавляет /max-webhook к существующему Express-серверу
 */

const fetch   = require("node-fetch");
const crypto  = require("crypto");
const { Client } = require("@notionhq/client");

const MAX_TOKEN  = process.env.MAX_BOT_TOKEN;
const MAX_BASE   = "https://platform-api.max.ru";
const APP_URL    = process.env.APP_URL || "";
const ADMIN_IDS  = (process.env.ADMIN_IDS || "").split(",").map(s => s.trim()).filter(Boolean);

// Те же базы что и в Telegram-боте
const DB = {
  cars:      "a52b75e6a94b4e29a7675b0c485a51b7",
  drivers:   "3e4caec4095c45b49eabd35652a00ea0",
  staff:     "66174d5ed4c240788eae47f2ef533e23",
  stos:      "09353d23ecb64c4a96fea71594307afe",
  repairs:   "673701b3aff148b683bb57386786fa80",
  absences:  "8195f2ccc73e418cae12d3639211da86",
};

if (!MAX_TOKEN) {
  console.log("⚠️  MAX_BOT_TOKEN не задан — MAX-бот не запущен");
  module.exports = () => {};
  return;
}

// ─── NOTION ───────────────────────────────────────────────────────────────────

const notion = new Client({ auth: process.env.NOTION_TOKEN });

const gTxt  = (p,k) => { try { return p.properties[k].rich_text[0].plain_text; } catch { return ""; }};
const gTtl  = (p,k) => { try { return p.properties[k].title[0].plain_text; }    catch { return ""; }};
const gSel  = (p,k) => { try { return p.properties[k].select?.name || ""; }     catch { return ""; }};
const gPh   = (p,k) => { try { return (p.properties[k].phone_number||"").replace(/\D/g,""); } catch { return ""; }};
const norm  = s  => (s||"").replace(/\D/g,"").replace(/^8/,"7");
const rt    = v  => ({ rich_text: [{ text: { content: String(v||"").slice(0,2000) } }] });
const ttl   = v  => ({ title:     [{ text: { content: String(v||"").slice(0,2000) } }] });
const sel   = v  => v ? { select: { name: v } } : { select: null };
const num   = v  => ({ number: v != null ? parseFloat(v) : null });

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
async function notionUpd(id, props)  { return notion.pages.update({ page_id: id, properties: props }); }
async function notionCrt(db, props)  { return notion.pages.create({ parent: { database_id: db }, properties: props }); }

async function nextId(pfx, db) {
  const pages = await qry(db);
  const key   = pages[0] ? Object.keys(pages[0].properties).find(k => pages[0].properties[k].type === "title") : null;
  const nums  = pages.map(p => { const m = (key ? gTtl(p,key) : "").match(new RegExp(`^${pfx}-(\\d+)$`)); return m ? +m[1] : 0; }).filter(n=>n>0);
  return `${pfx}-${String(Math.max(0,...nums)+1).padStart(3,"0")}`;
}

// ─── MAX API ──────────────────────────────────────────────────────────────────

const MAX_HDR = { "Authorization": MAX_TOKEN, "Content-Type": "application/json" };

/** Отправить сообщение пользователю */
async function maxSend(userId, text, buttons = null) {
  const body = { text, format: "html" };
  if (buttons) {
    body.attachments = [{ type: "inline_keyboard", payload: { buttons } }];
  }
  const r = await fetch(`${MAX_BASE}/messages?user_id=${userId}`, {
    method: "POST", headers: MAX_HDR, body: JSON.stringify(body)
  });
  return r.json().catch(() => ({}));
}

/** Ответить на callback (убрать "часики" с кнопки) */
async function maxAnswer(callbackId, text = null) {
  const body = text ? { notification: text } : {};
  await fetch(`${MAX_BASE}/answers?callback_id=${callbackId}`, {
    method: "POST", headers: MAX_HDR, body: JSON.stringify(body)
  }).catch(() => {});
}

/** Отредактировать сообщение */
async function maxEdit(messageId, text, buttons = null) {
  const body = { text, format: "html" };
  if (buttons) body.attachments = [{ type: "inline_keyboard", payload: { buttons } }];
  await fetch(`${MAX_BASE}/messages?message_id=${messageId}`, {
    method: "PUT", headers: MAX_HDR, body: JSON.stringify(body)
  }).catch(() => {});
}

/** Зарегистрировать webhook */
async function registerWebhook() {
  if (!APP_URL) return;
  const url = `${APP_URL}/max-webhook`;
  const r = await fetch(`${MAX_BASE}/subscriptions`, {
    method: "POST", headers: MAX_HDR,
    body: JSON.stringify({ url, update_types: ["message_created","bot_started","message_callback"] })
  });
  const data = await r.json().catch(() => ({}));
  console.log(`✅ MAX webhook: ${url}`, data.success ? "OK" : data);
}

// ─── КНОПКИ ───────────────────────────────────────────────────────────────────
// В MAX нет постоянной клавиатуры — используем тип "message":
// кнопка с type:"message" отправляет свой текст как сообщение от пользователя

const kb = {
  // Одна кнопка в строку = 100% ширины на любом экране
  driver: [
    [{ type:"message", text:"🛠 Заявка на ремонт" }],
    [{ type:"message", text:"🏖 Отпуск / Больничный" }],
    [{ type:"message", text:"📊 Мой статус" }],
    [{ type:"message", text:"📋 Мои заявки" }],
  ],
  driverAdmin: [
    [{ type:"message", text:"🛠 Заявка на ремонт" }],
    [{ type:"message", text:"🏖 Отпуск / Больничный" }],
    [{ type:"message", text:"📊 Мой статус" }],
    [{ type:"message", text:"📋 Мои заявки" }],
    [{ type:"message", text:"👔 Режим менеджера" }],
    [{ type:"message", text:"🔧 Режим механика" }],
  ],
  manager: [
    [{ type:"message", text:"🔧 Активные ремонты" }],
    [{ type:"message", text:"📊 Статистика парка" }],
    [{ type:"message", text:"👥 Найти водителя" }],
    [{ type:"message", text:"🏪 Сервисные центры" }],
    [{ type:"message", text:"📣 Рассылка" }],
    [{ type:"message", text:"🔔 Проверить сроки" }],
    [{ type:"message", text:"🚗 Режим водителя" }],
    [{ type:"message", text:"🔧 Режим механика" }],
  ],
  mechanic: [
    [{ type:"message", text:"🔧 Мои ремонты" }],
    [{ type:"message", text:"📊 Мой статус" }],
    [{ type:"message", text:"👔 Режим менеджера" }],
    [{ type:"message", text:"🚗 Режим водителя" }],
  ],
  phone:  [[{ type:"request_contact", text:"📱 Поделиться номером телефона" }]],
  cancel: [[{ type:"message", text:"❌ Отмена" }]],
};

function menuFor(user) {
  if (!user) return kb.phone;
  if (user.role === "Механик")     return kb.mechanic;
  if (["Менеджер","Администратор"].includes(user.role) || user.isAdmin) return kb.manager;
  return (user.db === "staff" || user.isAdmin) ? kb.driverAdmin : kb.driver;
}

// ─── ИДЕНТИФИКАЦИЯ ────────────────────────────────────────────────────────────

const maxCache    = new Map(); // userId → user
const maxSessions = new Map(); // userId → {state, data}

async function getUser(userId) {
  if (maxCache.has(userId)) return maxCache.get(userId);

  const staffPages = await qry(DB.staff, { property: "Telegram ID", rich_text: { equals: String(userId) } });
  if (staffPages.length) return buildStaff(staffPages[0], userId);

  const drvPages = await qry(DB.drivers, { property: "Telegram ID", rich_text: { equals: String(userId) } });
  if (drvPages.length) return buildDriver(drvPages[0], userId);

  return null;
}

function buildDriver(page, userId) {
  const u = {
    userId, pageId: page.id,
    fio:    gTtl(page,"ФИО"),
    phone:  gPh(page,"Телефон"),
    car:    gTxt(page,"Гос. номер авто"),
    role:   "Водитель", db: "driver",
    isAdmin: ADMIN_IDS.includes(String(userId)),
  };
  maxCache.set(userId, u);
  return u;
}

function buildStaff(page, userId) {
  const u = {
    userId, pageId: page.id,
    fio:      gTtl(page,"ФИО"),
    phone:    gPh(page,"Телефон"),
    role:     gSel(page,"Роль"),
    baseRole: gSel(page,"Роль"),
    sto:      gTxt(page,"СТО"),
    db:       "staff",
    isAdmin:  ADMIN_IDS.includes(String(userId)) || gMulti(page,"Роль").includes("Администратор"),
  };
  maxCache.set(userId, u);
  return u;
}

async function findByPhone(phone) {
  const n = norm(phone);
  const staffAll = await qry(DB.staff);
  const staffPage = staffAll.find(p => norm(gPh(p,"Телефон")) === n);
  const drvAll  = await qry(DB.drivers);
  const drvPage = drvAll.find(p => norm(gPh(p,"Телефон")) === n);
  return { staffPage, drvPage };
}

async function linkTg(db, pageId, userId, username) {
  await notionUpd(pageId, {
    "Telegram ID":       rt(userId),
    "Telegram username": rt(username||""),
  });
}

/** Верификация телефона через HMAC-SHA256 */
function verifyContact(vcfInfo, hash) {
  try {
    const expected = crypto.createHmac("sha256", MAX_TOKEN)
      .update(vcfInfo)
      .digest("hex");
    return expected === hash;
  } catch { return false; }
}

/** Извлечь номер из VCF */
function phoneFromVcf(vcfInfo) {
  const m = vcfInfo.match(/TEL[^:]*:(\+?\d+)/);
  return m ? m[1] : null;
}

// ─── ОТПРАВИТЬ ПРИВЕТСТВИЕ ────────────────────────────────────────────────────

async function greet(userId, user) {
  const roleEmoji = { Менеджер:"👔", Механик:"🔧", Администратор:"⚙️", Водитель:"🚗" };
  const e = roleEmoji[user.role] || "👤";
  let text = `👋 Привет, <b>${user.fio}</b>!\n${e} Роль: <b>${user.role}</b>`;
  if (user.car) text += `\n🚗 Авто: <b>${user.car}</b>`;
  if (user.sto) text += `\n🏪 СТО: <b>${user.sto}</b>`;
  text += "\n\nВыберите действие:";
  await maxSend(userId, text, menuFor(user));
}

// ─── ОБРАБОТКА ВХОДЯЩИХ ОБНОВЛЕНИЙ ───────────────────────────────────────────

async function handleUpdate(update) {
  const type = update.update_type;

  // ── Старт бота ──────────────────────────────────────────────────────────────
  if (type === "bot_started") {
    const userId = update.user?.user_id;
    if (!userId) return;
    maxCache.delete(userId);
    const user = await getUser(userId);
    if (user) return greet(userId, user);
    maxSessions.set(userId, { state: "waiting_phone" });
    return maxSend(userId,
      "👋 Привет! Для входа в систему поделитесь номером телефона:",
      kb.phone);
  }

  // ── Входящее сообщение ───────────────────────────────────────────────────────
  if (type === "message_created") {
    const userId = update.message?.sender?.user_id;
    const text   = update.message?.body?.text || "";
    const att    = update.message?.body?.attachments || [];

    if (!userId) return;

    // Контакт (телефон)
    const contact = att.find(a => a.type === "contact");
    if (contact) return handleContact(userId, contact, update.message?.sender?.username);

    const session = maxSessions.get(userId);

    if (text === "❌ Отмена") {
      maxSessions.delete(userId);
      const user = await getUser(userId);
      const msg  = user ? "Действие отменено." : "Действие отменено.";
      return maxSend(userId, msg, user ? menuFor(user) : kb.phone);
    }

    if (!session) return handleMenu(userId, text);
    return handleFSM(userId, text, session);
  }

  // ── Callback (нажатие inline-кнопки) ────────────────────────────────────────
  if (type === "message_callback") {
    const userId     = update.callback?.user?.user_id;
    const callbackId = update.callback?.callback_id;
    const payload    = update.callback?.payload || "";
    const messageId  = update.message?.body?.mid;

    if (!userId || !callbackId) return;
    await maxAnswer(callbackId);
    return handleCallback(userId, payload, messageId);
  }
}

// ─── ОБРАБОТКА КОНТАКТА ───────────────────────────────────────────────────────

async function handleContact(userId, contact, username) {
  const session = maxSessions.get(userId);
  if (session?.state !== "waiting_phone") return;

  const vcfInfo = contact.payload?.vcf_info || "";
  const hash    = contact.payload?.hash || "";
  const phone   = phoneFromVcf(vcfInfo) || gPh({ properties: { t: { phone_number: contact.payload?.max_info?.phone || "" } } }, "t");

  if (!phone) return maxSend(userId, "❌ Не удалось получить номер телефона. Попробуйте ещё раз.", kb.phone);

  // Верифицируем подлинность контакта
  const verified = verifyContact(vcfInfo, hash);
  if (!verified) {
    console.warn(`MAX: контакт не прошёл верификацию для ${userId}`);
  }

  await maxSend(userId, "🔍 Ищу в базе...");

  const { staffPage, drvPage } = await findByPhone(phone);

  if (!staffPage && !drvPage) {
    maxSessions.delete(userId);
    return maxSend(userId,
      `❌ Номер <b>${phone}</b> не найден в системе.\nОбратитесь к администратору.`,
      kb.phone);
  }

  // Оба профиля — спрашиваем роль
  if (staffPage && drvPage) {
    const staffRoles = gMulti(staffPage, "Роль");
    const staffRole = staffRoles.join(" + ");
    maxSessions.set(userId, { state: "choose_role", data: {
      staffPageId: staffPage.id, drvPageId: drvPage.id, username
    }});
    return maxSend(userId, "Вы совмещаете несколько ролей. Выберите как войти:", [
      [{ type:"message", text:`👔 ${staffRole}` }],
      [{ type:"message", text:"🚗 Водитель" }],
    ]);
  }

  let user;
  if (staffPage) {
    await linkTg(DB.staff, staffPage.id, userId, username);
    user = buildStaff(staffPage, userId);
  } else {
    await linkTg(DB.drivers, drvPage.id, userId, username);
    user = buildDriver(drvPage, userId);
  }

  maxSessions.delete(userId);
  return greet(userId, user);
}

// ─── МЕНЮ ДЕЙСТВИЙ ────────────────────────────────────────────────────────────

const REPAIR_TYPE_MAP = {
  "🔧 Двигатель":"Двигатель", "⚙️ КПП / Трансмиссия":"Плановый",
  "🛞 Шиномонтаж":"Шиномонтаж", "💥 Кузов / Аварийный":"Аварийный",
  "🪟 Стекло":"Стекло", "🔋 Электрика":"Диагностика",
  "🩺 Диагностика":"Диагностика", "❓ Другое":"Плановый",
};
const PAY_DEFAULT = {
  "Двигатель":"Парк","Плановый":"Парк","Диагностика":"Парк",
  "Шиномонтаж":"Водитель","Стекло":"Водитель","Аварийный":"Водитель","Кузовной":"Водитель",
};

async function handleMenu(userId, text) {
  const user = await getUser(userId);

  if (!user) {
    maxSessions.set(userId, { state: "waiting_phone" });
    return maxSend(userId, "Поделитесь номером для входа:", kb.phone);
  }

  // Переключение режимов
  if (text === "🚗 Режим водителя") return switchMode(userId, user, "driver");
  if (text === "👔 Режим менеджера") return switchMode(userId, user, "manager");
  if (text === "🔧 Режим механика")  return switchMode(userId, user, "mechanic");

  // Водитель
  if (text === "🛠 Заявка на ремонт") return startRepair(userId, user);
  if (text === "📋 Мои заявки")       return showDriverRepairs(userId, user);
  if (text === "📊 Мой статус") {
    maxCache.delete(userId);
    const u = await getUser(userId);
    return maxSend(userId,
      `📊 <b>Профиль</b>\n👤 ${u.fio}\n📱 ${u.phone}\n🎭 ${u.role}\n🚗 ${u.car||"—"}`,
      menuFor(u));
  }

  // Менеджер
  if (text === "🔧 Активные ремонты") return showActiveRepairs(userId);
  if (text === "📊 Статистика парка") return showStats(userId);
  if (text === "👥 Найти водителя") {
    maxSessions.set(userId, { state: "find_driver" });
    return maxSend(userId, "Введите ФИО или телефон:", kb.cancel);
  }
  if (text === "🏪 Сервисные центры") return showStos(userId);
  if (text === "📣 Рассылка") {
    maxSessions.set(userId, { state: "broadcast" });
    return maxSend(userId, "Введите текст рассылки:", kb.cancel);
  }
  if (text === "🔔 Проверить сроки") return checkDeadlines([userId]);

  // Механик
  if (text === "🔧 Мои ремонты") return showMechanicRepairs(userId, user);
}

// ─── ПЕРЕКЛЮЧЕНИЕ РЕЖИМА ──────────────────────────────────────────────────────

async function switchMode(userId, currentUser, mode) {
  const phone = currentUser.phone;
  const n = norm(phone);
  const all = await qry(DB.staff);

  let targetPage, user;

  if (mode === "driver") {
    const drvAll = await qry(DB.drivers);
    targetPage = drvAll.find(p => norm(gPh(p,"Телефон")) === n);
    if (!targetPage) return maxSend(userId, "⚠️ Профиль водителя не найден.", menuFor(currentUser));
    user = buildDriver(targetPage, userId);
  } else {
    const roleMap = { manager: ["Администратор","Менеджер"], mechanic: ["Механик"] };
    const roles = roleMap[mode] || [];
    targetPage = all.find(p => norm(gPh(p,"Телефон")) === n && roles.includes(gSel(p,"Роль")));
    if (!targetPage) return maxSend(userId, `⚠️ Профиль не найден.`, menuFor(currentUser));
    user = buildStaff(targetPage, userId);
    user.isAdmin = currentUser.isAdmin;
  }

  return greet(userId, user);
}

// ─── РЕМОНТ ───────────────────────────────────────────────────────────────────

async function startRepair(userId, user) {
  if (!user.car) return maxSend(userId, "⚠️ К вашему аккаунту не привязано авто.", menuFor(user));

  maxSessions.set(userId, { state: "rep_type", data: { car: user.car } });
  return maxSend(userId,
    `🛠 <b>Заявка на ремонт</b>\n🚗 ${user.car}\n\nВыберите тип проблемы:`,
    [
      [{ type:"message", text:"🔧 Двигатель" }],
      [{ type:"message", text:"⚙️ КПП / Трансмиссия" }],
      [{ type:"message", text:"🛞 Шиномонтаж" }],
      [{ type:"message", text:"💥 Кузов / Аварийный" }],
      [{ type:"message", text:"🪟 Стекло" }],
      [{ type:"message", text:"🔋 Электрика" }],
      [{ type:"message", text:"🩺 Диагностика" }],
      [{ type:"message", text:"❓ Другое" }],
      [{ type:"message", text:"❌ Отмена" }],
    ]);
}

async function createRepair(userId, data) {
  const user     = await getUser(userId);
  const repairId = await nextId("REM", DB.repairs);
  const payer    = data.defaultPayer || "Парк";

  const page = await notionCrt(DB.repairs, {
    "ID заявки":              ttl(repairId),
    "Гос. номер авто":        rt(data.car||""),
    "ФИО водителя":           rt(user?.fio||""),
    "Telegram ID водителя":   rt(String(userId)),
    "Тип ремонта":            sel(data.repairType||"Диагностика"),
    "Описание поломки":       rt(data.desc||""),
    "Статус":                 sel("Заявка"),
    "Кто оплачивает":         sel(payer),
    "date:Дата подачи заявки:start": new Date().toISOString().slice(0,10),
  });

  const payIcon = payer === "Парк" ? "🏢 За счёт парка" : "👤 За счёт водителя";
  await maxSend(userId,
    `✅ <b>Заявка ${repairId} создана!</b>\n🚗 ${data.car}\n🔩 ${data.desc}\n${payIcon}\n\nОжидайте решения менеджера.`,
    menuFor(user));

  // Уведомляем менеджеров с кнопками
  const adminText =
    `🚨 <b>Новая заявка ${repairId}</b> [MAX]\n\n` +
    `🚗 <b>${data.car}</b>\n👤 ${user?.fio}\n` +
    `🔩 ${data.repairType}\n📝 ${data.desc}\n💰 ${payer}`;

  const adminBtns = [[
    { type:"callback", text:"✅ Согласовать", payload:`rep_approve:${page.id}` },
    { type:"callback", text:"❌ Отклонить",   payload:`rep_reject:${page.id}` },
  ]];

  for (const a of await getManagerIds()) {
    maxSend(a, adminText, adminBtns).catch(()=>{});
  }
}

// ─── ПРОСМОТР РЕМОНТОВ ────────────────────────────────────────────────────────

function repairCard(r) {
  const si = { "Заявка":"📋","Согласовано":"✅","В работе":"🔧","Готово":"🎉","Отменено":"❌","Оплачено":"💰" };
  const pi = { "Парк":"🏢","Водитель":"👤","Страховка":"🛡","50/50":"⚖️" };
  let t = `${si[r.status]||"?"} <b>${r.id}</b> — ${r.status}\n`;
  t += `🚗 ${r.car} | 👤 ${r.driver}\n🔩 ${r.type} | ${pi[r.payer]||""} ${r.payer||""}\n📝 ${r.desc}`;
  if (r.sto)  t += `\n🏪 ${r.sto}`;
  if (r.cost) t += `\n💰 ${r.cost}₽`;
  return t;
}

function parseRepair(page) {
  return {
    pageId:   page.id,
    id:       gTtl(page,"ID заявки"),
    car:      gTxt(page,"Гос. номер авто"),
    driver:   gTxt(page,"ФИО водителя"),
    driverTg: gTxt(page,"Telegram ID водителя"),
    type:     gSel(page,"Тип ремонта"),
    desc:     gTxt(page,"Описание поломки"),
    status:   gSel(page,"Статус"),
    payer:    gSel(page,"Кто оплачивает"),
    mechFio:  gTxt(page,"Механик ФИО"),
    mechTg:   gTxt(page,"Механик Telegram ID"),
    sto:      gTxt(page,"Исполнитель / СТО"),
    stoAddr:  gTxt(page,"Адрес СТО"),
    cost:     page.properties["Стоимость ремонта"]?.number ?? null,
  };
}

function repairAdminBtns(pageId, status) {
  const btns = [];
  if (status === "Заявка") btns.push([
    { type:"callback", text:"✅ Согласовать", payload:`rep_approve:${pageId}` },
    { type:"callback", text:"❌ Отклонить",   payload:`rep_reject:${pageId}` },
  ]);
  if (status === "Согласовано") btns.push([
    { type:"callback", text:"🔧 В работу", payload:`rep_work:${pageId}` },
  ]);
  if (status === "В работе") btns.push([
    { type:"callback", text:"✅ Готово",    payload:`rep_done:${pageId}` },
    { type:"callback", text:"💰 Стоимость", payload:`rep_cost:${pageId}` },
  ]);
  if (status === "Готово") btns.push([
    { type:"callback", text:"💰 Оплачено", payload:`rep_paid:${pageId}` },
  ]);
  return btns;
}

async function showDriverRepairs(userId, user) {
  const pages = await qry(DB.repairs, { property: "ФИО водителя", rich_text: { contains: user.fio } });
  const active = pages.filter(p => !["Оплачено","Отменено"].includes(gSel(p,"Статус")));
  if (!active.length) return maxSend(userId, "✅ Нет активных заявок.", menuFor(user));
  for (const p of active.slice(0,5)) {
    const r = parseRepair(p);
    await maxSend(userId, repairCard(r));
  }
}

async function showActiveRepairs(userId) {
  const pages = await qry(DB.repairs, { and: [
    { property:"Статус", select:{ does_not_equal:"Оплачено" } },
    { property:"Статус", select:{ does_not_equal:"Отменено" } },
  ]});
  if (!pages.length) return maxSend(userId, "✅ Нет активных ремонтов.", kb.manager);
  await maxSend(userId, `🔧 <b>Активных: ${pages.length}</b>`);
  for (const p of pages.slice(0,8)) {
    const r = parseRepair(p);
    await maxSend(userId, repairCard(r), repairAdminBtns(p.id, r.status));
  }
}

async function showMechanicRepairs(userId, user) {
  const pages = await qry(DB.repairs, { and: [
    { property:"Механик Telegram ID", rich_text:{ equals: String(userId) } },
    { property:"Статус", select:{ does_not_equal:"Оплачено" } },
    { property:"Статус", select:{ does_not_equal:"Отменено" } },
  ]});
  if (!pages.length) return maxSend(userId, "✅ Нет назначенных ремонтов.", kb.mechanic);
  for (const p of pages.slice(0,8)) {
    const r = parseRepair(p);
    const btns = r.status === "В работе" ? [[
      { type:"callback", text:"✅ Завершить", payload:`mech_done:${p.id}` },
    ]] : r.status === "Согласовано" ? [[
      { type:"callback", text:"▶️ Начать", payload:`mech_start:${p.id}` },
    ]] : [];
    await maxSend(userId, repairCard(r), btns.length ? btns : null);
  }
}

// ─── СТАТИСТИКА, СТО ─────────────────────────────────────────────────────────

async function showStats(userId) {
  const [cars, drivers, repairs] = await Promise.all([
    qry(DB.cars), qry(DB.drivers), qry(DB.repairs)
  ]);
  const cs = s => cars.filter(p => gSel(p,"Статус") === s).length;
  await maxSend(userId,
    `📊 <b>Парк</b>\n\n🚗 В аренде: ${cs("В аренде")} | Простой: ${cs("Простой")} | Ремонт: ${cs("Ремонт")}\n` +
    `👤 Водителей: ${drivers.filter(p=>gSel(p,"Статус")==="Работает").length}\n` +
    `🔧 Активных ремонтов: ${repairs.filter(p=>!["Оплачено","Отменено"].includes(gSel(p,"Статус"))).length}`,
    kb.manager);
}

async function showStos(userId) {
  const pages = await qry(DB.stos);
  let text = "🏪 <b>Сервисные центры:</b>\n\n";
  for (const p of pages) {
    if (!p.properties["Активен"]?.checkbox) continue;
    const name  = gTtl(p,"Название");
    const addr  = gTxt(p,"Адрес");
    const hours = gTxt(p,"Рабочие часы");
    text += `<b>${name}</b>\n📍 ${addr}\n⏰ ${hours}\n\n`;
  }
  await maxSend(userId, text, kb.manager);
}

// ─── CALLBACK ОБРАБОТЧИК ─────────────────────────────────────────────────────

async function handleCallback(userId, payload, messageId) {
  const [action, pageId] = payload.split(":");
  const page = await notion.pages.retrieve({ page_id: pageId }).catch(() => null);
  if (!page) return maxSend(userId, "⚠️ Запись не найдена.");
  const r = parseRepair(page);

  if (action === "rep_approve") {
    maxSessions.set(userId, { state: "rep_approve_sto", data: { pageId, repair: r } });
    return maxSend(userId,
      `✅ Согласуете <b>${r.id}</b>\n🚗 ${r.car}\n\nУкажите СТО и стоимость:\n<i>Например: АвтоМастер, 3500р</i>`,
      kb.cancel);
  }

  if (action === "rep_reject") {
    maxSessions.set(userId, { state: "rep_reject_reason", data: { pageId, repair: r } });
    return maxSend(userId, `❌ Причина отклонения <b>${r.id}</b>:`, kb.cancel);
  }

  if (action === "rep_work") {
    await notionUpd(pageId, { "Статус": sel("В работе") });
    r.status = "В работе";
    await maxEdit(messageId, repairCard(r), repairAdminBtns(pageId, r.status));
    notifyDriver(r, `🔧 Заявка <b>${r.id}</b> передана в работу.`);
  }

  if (action === "rep_done") {
    await notionUpd(pageId, { "Статус": sel("Готово") });
    r.status = "Готово";
    await maxEdit(messageId, repairCard(r), repairAdminBtns(pageId, r.status));
    notifyDriver(r, `🎉 Ваш автомобиль готов!\n🚗 ${r.car}${r.stoAddr ? `\n📍 ${r.stoAddr}` : ""}`);
  }

  if (action === "rep_paid") {
    await notionUpd(pageId, { "Статус": sel("Оплачено") });
    r.status = "Оплачено";
    await maxEdit(messageId, repairCard(r), []);
  }

  if (action === "rep_cost") {
    maxSessions.set(userId, { state: "rep_set_cost", data: { pageId, repair: r } });
    return maxSend(userId, `💰 Стоимость <b>${r.id}</b> (₽):`, kb.cancel);
  }

  if (action === "mech_start") {
    await notionUpd(pageId, { "Статус": sel("В работе") });
    r.status = "В работе";
    await maxEdit(messageId, repairCard(r), [[{ type:"callback", text:"✅ Завершить", payload:`mech_done:${pageId}` }]]);
    notifyDriver(r, `🔧 Ремонт <b>${r.id}</b> начат.`);
  }

  if (action === "mech_done") {
    await notionUpd(pageId, { "Статус": sel("Готово") });
    r.status = "Готово";
    await maxEdit(messageId, repairCard(r), []);
    notifyDriver(r, `🎉 Ваш автомобиль готов!\n🚗 ${r.car}${r.stoAddr ? `\n📍 ${r.stoAddr}` : ""}`);
    notifyManagersMax(`✅ Механик ${r.mechFio||""} завершил <b>${r.id}</b>\n🚗 ${r.car}`);
  }
}

// ─── FSM ─────────────────────────────────────────────────────────────────────

async function handleFSM(userId, text, session) {
  const { state, data } = session;
  const user = await getUser(userId);

  if (state === "choose_role") {
    const { staffPageId, drvPageId, username } = data;
    let u;
    if (text.includes("Водитель")) {
      const page = await notion.pages.retrieve({ page_id: drvPageId });
      await linkTg(DB.drivers, drvPageId, userId, username);
      u = buildDriver(page, userId);
    } else {
      const page = await notion.pages.retrieve({ page_id: staffPageId });
      await linkTg(DB.staff, staffPageId, userId, username);
      u = buildStaff(page, userId);
    }
    maxSessions.delete(userId);
    return greet(userId, u);
  }

  if (state === "rep_type") {
    const type = REPAIR_TYPE_MAP[text];
    if (!type) return;
    data.repairType = type;
    data.defaultPayer = PAY_DEFAULT[type] || "Парк";
    session.state = "rep_desc";
    maxSessions.set(userId, session);
    return maxSend(userId, "📝 Опишите неисправность:", kb.cancel);
  }

  if (state === "rep_desc") {
    data.desc = text;
    session.state = "rep_photo";
    maxSessions.set(userId, session);
    return maxSend(userId, "📷 Пришлите фото или нажмите «Пропустить»", [
      [{ type:"message", text:"⏭ Пропустить" }], [{ type:"message", text:"❌ Отмена" }]
    ]);
  }

  if (state === "rep_photo" && text === "⏭ Пропустить") {
    maxSessions.delete(userId);
    return createRepair(userId, data);
  }

  if (state === "rep_approve_sto") {
    const { pageId, repair: r } = data;
    const parts = text.split(",");
    const sto   = parts[0].trim();
    const costM = text.match(/(\d[\d\s]*)/);
    const cost  = costM ? parseFloat(costM[1].replace(/\s/g,"")) : null;
    await notionUpd(pageId, {
      "Статус": sel("Согласовано"),
      "Исполнитель / СТО": rt(sto),
      ...(cost ? { "Стоимость ремонта": num(cost) } : {}),
    });
    maxSessions.delete(userId);
    await maxSend(userId, `✅ ${r.id} согласован!\n🏪 ${sto}${cost?`, ${cost}₽`:""}`, kb.manager);
    notifyDriver(r, `✅ Заявка <b>${r.id}</b> согласована!\n🏪 ${sto}`);
    return;
  }

  if (state === "rep_reject_reason") {
    const { pageId, repair: r } = data;
    await notionUpd(pageId, { "Статус": sel("Отменено"), "Комментарий механика": rt(text) });
    maxSessions.delete(userId);
    await maxSend(userId, `❌ ${r.id} отклонён.`, kb.manager);
    notifyDriver(r, `❌ Заявка <b>${r.id}</b> отклонена.\nПричина: ${text}`);
    return;
  }

  if (state === "rep_set_cost") {
    const cost = parseFloat(text.replace(/[^\d.]/g,""));
    if (isNaN(cost)) return maxSend(userId, "⚠️ Введите число, например: 3500");
    const { pageId, repair: r } = data;
    await notionUpd(pageId, { "Стоимость ремонта": num(cost) });
    maxSessions.delete(userId);
    await maxSend(userId, `💰 Стоимость ${r.id}: ${cost}₽ сохранена.`, kb.manager);
    return;
  }

  if (state === "find_driver") {
    maxSessions.delete(userId);
    const all   = await qry(DB.drivers);
    const q     = text.toLowerCase();
    const found = all.filter(p => gTtl(p,"ФИО").toLowerCase().includes(q) || gPh(p,"Телефон").includes(q));
    if (!found.length) return maxSend(userId, "❌ Не найдено.", kb.manager);
    for (const p of found.slice(0,5)) {
      await maxSend(userId,
        `👤 <b>${gTtl(p,"ФИО")}</b>\n📱 ${gPh(p,"Телефон")}\n🚗 ${gTxt(p,"Гос. номер авто")||"—"}\n📋 ${gSel(p,"Статус")}`);
    }
    return maxSend(userId, "—", kb.manager);
  }

  if (state === "broadcast") {
    maxSessions.delete(userId);
    const all = await qry(DB.drivers, { property:"Статус", select:{ equals:"Работает" } });
    let sent = 0;
    for (const p of all) {
      const tid = gTxt(p,"Telegram ID");
      if (!tid) continue;
      try { await maxSend(tid, `📣 <b>Сообщение от администрации:</b>\n\n${text}`); sent++; }
      catch {}
      await new Promise(res => setTimeout(res, 100));
    }
    return maxSend(userId, `✅ Отправлено: ${sent}/${all.length}`, kb.manager);
  }
}

// ─── УВЕДОМЛЕНИЯ ─────────────────────────────────────────────────────────────

async function getManagerIds() {
  const ids = new Set(ADMIN_IDS);
  const mgrs = await qry(DB.staff, { and: [
    { property:"Роль",   select:{ does_not_equal:"Механик" } },
    { property:"Статус", select:{ equals:"Активен" } },
  ]});
  for (const p of mgrs) { const tid = gTxt(p,"Telegram ID"); if (tid) ids.add(tid); }
  return [...ids];
}

function notifyDriver(r, text) {
  if (!r.driverTg) return;
  maxSend(r.driverTg, text).catch(()=>{});
}

async function notifyManagersMax(text) {
  const ids = await getManagerIds();
  for (const id of ids) maxSend(id, text).catch(()=>{});
}

async function checkDeadlines(adminIds) {
  const today = new Date();
  const in30  = new Date(today.getTime()+30*86400000).toISOString().slice(0,10);
  const todS  = today.toISOString().slice(0,10);
  const alerts = [];
  try {
    const ins = await notion.databases.query({ database_id: DB.insurances||"44d9220f9f0c458587f8eb9db711a506", filter: { and: [
      { property:"Дата окончания действия", date:{ before: in30 } },
      { property:"Дата окончания действия", date:{ after:  todS } },
    ]}});
    for (const p of ins.results) {
      alerts.push(`⚠️ ${gSel(p,"Тип страховки")} ${gTxt(p,"Гос. номер авто")}`);
    }
  } catch {}
  if (alerts.length) {
    const msg = `🔔 <b>Истекающие страховки:</b>\n` + alerts.join("\n");
    for (const a of adminIds) maxSend(a, msg).catch(()=>{});
  }
}

// ─── ЭКСПОРТ: подключение к Express ──────────────────────────────────────────

module.exports = function setupMaxBot(app) {
  // Webhook endpoint
  app.post("/max-webhook", async (req, res) => {
    res.sendStatus(200); // Сразу отвечаем
    const update = req.body;
    if (!update) return;
    handleUpdate(update).catch(e => console.error("MAX update error:", e.message));
  });

  // Регистрируем webhook при старте
  if (APP_URL) {
    setTimeout(registerWebhook, 3000);
  }

  console.log("✅ MAX бот подключён (/max-webhook)");
};
