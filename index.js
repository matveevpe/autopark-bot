/**
 * Автопарк CRM — Telegram-бот
 * 
 * Шаг 1: Идентификация водителя по номеру телефона
 * Шаг 2: Заявка на ремонт
 * Шаг 3: Уведомления (ежедневные)
 */

const TelegramBot  = require("node-telegram-bot-api");
const express      = require("express");
const { Client }   = require("@notionhq/client");
const cron         = require("node-cron");

// ─── КОНФИГУРАЦИЯ ─────────────────────────────────────────────────────────────

const BOT_TOKEN    = process.env.BOT_TOKEN;
const NOTION_TOKEN = process.env.NOTION_TOKEN;
const APP_URL      = process.env.APP_URL || "";
const PORT         = process.env.PORT || 8080;

// ID баз в Notion
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

// Telegram ID администраторов (добавь свои)
const ADMIN_IDS = (process.env.ADMIN_IDS || "").split(",").map(s => s.trim()).filter(Boolean);

// Проверки
if (!BOT_TOKEN || !NOTION_TOKEN) {
  console.error("❌ Задай BOT_TOKEN и NOTION_TOKEN в переменных окружения!");
  process.exit(1);
}

// ─── ИНИЦИАЛИЗАЦИЯ ────────────────────────────────────────────────────────────

const notion = new Client({ auth: NOTION_TOKEN });
const app    = express();
app.use(express.json());
app.use(express.static("public"));

// Бот — webhook в продакшене, polling при разработке
const bot = APP_URL
  ? new TelegramBot(BOT_TOKEN)
  : new TelegramBot(BOT_TOKEN, { polling: true });

// Кэш: tgId → { pageId, fio, phone, car, carPageId, isAdmin }
const userCache = new Map();

// FSM состояния: tgId → { state, data }
const sessions  = new Map();

// Счётчики для REM-XXX и ABS-XXX
let repairCounter = 0;
let absenceCounter = 0;

// ─── NOTION: ХЕЛПЕРЫ ──────────────────────────────────────────────────────────

/** Получить текст rich_text поля */
function getText(page, prop) {
  try { return page.properties[prop].rich_text[0].plain_text; } catch { return ""; }
}

/** Получить заголовок (title) */
function getTitle(page, prop = "ФИО") {
  try { return page.properties[prop].title[0].plain_text; } catch { return ""; }
}

/** Получить select */
function getSelect(page, prop) {
  try { return page.properties[prop].select?.name || ""; } catch { return ""; }
}

/** Получить phone_number */
function getPhone(page, prop = "Телефон") {
  try { return (page.properties[prop].phone_number || "").replace(/\D/g, ""); } catch { return ""; }
}

/** Нормализовать телефон: 79991234567 */
function normalizePhone(s) {
  return (s || "").replace(/\D/g, "").replace(/^8/, "7");
}

/** Запросить базу с фильтром */
async function notionQuery(dbId, filter) {
  const pages = [];
  let cursor;
  while (true) {
    const resp = await notion.databases.query({
      database_id: dbId,
      filter,
      start_cursor: cursor,
      page_size: 100,
    });
    pages.push(...resp.results);
    if (!resp.has_more) break;
    cursor = resp.next_cursor;
  }
  return pages;
}

/** Получить следующий ID (REM-001, ABS-001) */
async function nextId(prefix, dbId) {
  const pages = await notionQuery(dbId);
  const nums  = pages
    .map(p => {
      const t = getTitle(p, Object.keys(p.properties).find(k => p.properties[k].type === "title"));
      const m = t.match(new RegExp(`^${prefix}-(\\d+)$`));
      return m ? parseInt(m[1]) : 0;
    })
    .filter(n => n > 0);
  const max = nums.length ? Math.max(...nums) : 0;
  return `${prefix}-${String(max + 1).padStart(3, "0")}`;
}

// ─── ИДЕНТИФИКАЦИЯ ВОДИТЕЛЯ ───────────────────────────────────────────────────

/**
 * Найти водителя в Notion по Telegram ID.
 * Возвращает объект пользователя или null.
 */
async function findDriverByTelegramId(tgId) {
  if (userCache.has(tgId)) return userCache.get(tgId);

  const pages = await notionQuery(DB.drivers, {
    property: "Telegram ID",
    rich_text: { equals: String(tgId) },
  });

  if (!pages.length) return null;

  return buildUserObj(pages[0], tgId);
}

/**
 * Найти водителя по телефону (при первой регистрации).
 */
async function findDriverByPhone(phone) {
  const normalized = normalizePhone(phone);
  const pages = await notionQuery(DB.drivers);

  for (const page of pages) {
    const ph = normalizePhone(getPhone(page));
    if (ph && ph === normalized) return page;
  }
  return null;
}

/**
 * Сохранить Telegram ID и username в карточку водителя.
 */
async function linkTelegramToDriver(pageId, tgId, username) {
  await notion.pages.update({
    page_id: pageId,
    properties: {
      "Telegram ID":       { rich_text: [{ text: { content: String(tgId) } }] },
      "Telegram username": { rich_text: [{ text: { content: username || "" } }] },
    },
  });
}

/**
 * Построить объект пользователя из страницы Notion.
 */
function buildUserObj(page, tgId) {
  const fio     = getTitle(page, "ФИО");
  const phone   = getPhone(page);
  const car     = getText(page, "Гос. номер авто");
  const status  = getSelect(page, "Статус");
  const isAdmin = ADMIN_IDS.includes(String(tgId));

  const user = { pageId: page.id, fio, phone, car, status, isAdmin, tgId };
  userCache.set(tgId, user);
  return user;
}

// ─── КЛАВИАТУРЫ ───────────────────────────────────────────────────────────────

/** Главное меню водителя */
function driverMenu(user) {
  const car = user.car ? `🚗 ${user.car}` : "авто не привязано";
  return {
    parse_mode: "HTML",
    reply_markup: {
      keyboard: [
        [{ text: "🛠 Заявка на ремонт" }, { text: "🏖 Отпуск / Больничный" }],
        [{ text: "📊 Мой статус" },       { text: "📅 Выходные" }],
      ],
      resize_keyboard: true,
    },
  };
}

/** Главное меню администратора */
function adminMenu() {
  return {
    reply_markup: {
      keyboard: [
        [{ text: "🚗 Парк сегодня" },    { text: "🔧 Активные ремонты" }],
        [{ text: "⚠️ Истекают сроки" },  { text: "👤 Найти водителя" }],
        [{ text: "📣 Рассылка" },         { text: "🛠 Все заявки" }],
      ],
      resize_keyboard: true,
    },
  };
}

/** Кнопка «Поделиться телефоном» */
const sharePhoneKeyboard = {
  reply_markup: {
    keyboard: [[{
      text: "📱 Поделиться номером телефона",
      request_contact: true,
    }]],
    resize_keyboard: true,
    one_time_keyboard: true,
  },
};

/** Кнопка отмены */
const cancelKeyboard = {
  reply_markup: {
    keyboard: [[{ text: "❌ Отмена" }]],
    resize_keyboard: true,
    one_time_keyboard: true,
  },
};

// ─── /start ───────────────────────────────────────────────────────────────────

bot.onText(/\/start/, async (msg) => {
  const tgId = msg.from.id;
  const name  = msg.from.first_name || "водитель";

  try {
    const user = await findDriverByTelegramId(tgId);

    if (user) {
      const car = user.car ? `\nВаше авто: <b>${user.car}</b>` : "";
      await bot.sendMessage(tgId,
        `👋 Привет, <b>${user.fio}</b>!${car}\n\nВыберите действие:`,
        { parse_mode: "HTML", ...driverMenu(user) }
      );
      return;
    }

    // Не зарегистрирован — просим телефон
    sessions.set(tgId, { state: "waiting_phone" });
    await bot.sendMessage(tgId,
      `👋 Привет, <b>${name}</b>!\n\n` +
      `Чтобы начать работу, нужно привязать ваш аккаунт к базе водителей.\n\n` +
      `Нажмите кнопку ниже и поделитесь номером телефона:`,
      { parse_mode: "HTML", ...sharePhoneKeyboard }
    );
  } catch (err) {
    console.error("Ошибка /start:", err);
    await bot.sendMessage(tgId, "⚠️ Произошла ошибка. Попробуйте позже.");
  }
});

// ─── РЕГИСТРАЦИЯ: ПОЛУЧЕНИЕ КОНТАКТА ─────────────────────────────────────────

bot.on("contact", async (msg) => {
  const tgId    = msg.from.id;
  const contact = msg.contact;
  const session = sessions.get(tgId);

  if (!session || session.state !== "waiting_phone") return;

  const phone = normalizePhone(contact.phone_number);

  await bot.sendMessage(tgId, "🔍 Ищу вас в базе...");

  try {
    const page = await findDriverByPhone(phone);

    if (!page) {
      await bot.sendMessage(tgId,
        `❌ Номер <code>${phone}</code> не найден в базе водителей.\n\n` +
        `Обратитесь к администратору — он добавит вас в систему.`,
        {
          parse_mode: "HTML",
          reply_markup: { remove_keyboard: true },
        }
      );
      sessions.delete(tgId);
      return;
    }

    // Привязываем Telegram ID
    await linkTelegramToDriver(page.id, tgId, msg.from.username);
    const user = buildUserObj(page, tgId);
    sessions.delete(tgId);

    const car = user.car ? `\nВаше авто: <b>${user.car}</b>` : "";
    await bot.sendMessage(tgId,
      `✅ <b>Готово!</b> Вы зарегистрированы как <b>${user.fio}</b>.${car}\n\n` +
      `Теперь вы можете подавать заявки через бота:`,
      { parse_mode: "HTML", ...driverMenu(user) }
    );

    // Уведомляем админов
    for (const adminId of ADMIN_IDS) {
      bot.sendMessage(adminId,
        `👤 Новый водитель привязал Telegram:\n<b>${user.fio}</b>\n📱 ${phone}`,
        { parse_mode: "HTML" }
      ).catch(() => {});
    }

  } catch (err) {
    console.error("Ошибка contact:", err);
    await bot.sendMessage(tgId, "⚠️ Ошибка при поиске. Попробуйте позже.");
  }
});

// ─── ЗАЯВКА НА РЕМОНТ ─────────────────────────────────────────────────────────

const REPAIR_TYPES = [
  "🔧 Двигатель",     "⚙️ КПП / Трансмиссия",
  "🛞 Шиномонтаж",    "💥 Кузов / Аварийный",
  "🪟 Стекло",         "🔋 Электрика",
  "🩺 Диагностика",   "❓ Другое",
];

bot.onText(/^🛠 Заявка на ремонт$/, async (msg) => {
  const tgId = msg.from.id;
  const user = await findDriverByTelegramId(tgId);

  if (!user) { await askToRegister(tgId); return; }
  if (!user.car) {
    await bot.sendMessage(tgId, "⚠️ К вашему аккаунту не привязано авто. Обратитесь к администратору.");
    return;
  }

  sessions.set(tgId, { state: "repair_type", data: { car: user.car } });

  await bot.sendMessage(tgId,
    `🛠 <b>Заявка на ремонт</b>\nАвто: <b>${user.car}</b>\n\nВыберите тип проблемы:`,
    {
      parse_mode: "HTML",
      reply_markup: {
        keyboard: [
          REPAIR_TYPES.slice(0, 2),
          REPAIR_TYPES.slice(2, 4),
          REPAIR_TYPES.slice(4, 6),
          REPAIR_TYPES.slice(6, 8),
          [{ text: "❌ Отмена" }],
        ],
        resize_keyboard: true,
      },
    }
  );
});

// ─── МОЙ СТАТУС ───────────────────────────────────────────────────────────────

bot.onText(/^📊 Мой статус$/, async (msg) => {
  const tgId = msg.from.id;
  const user = await findDriverByTelegramId(tgId);
  if (!user) { await askToRegister(tgId); return; }

  userCache.delete(tgId); // Сбрасываем кэш для свежих данных
  const freshUser = await findDriverByTelegramId(tgId);

  const car = freshUser?.car || "не привязано";
  await bot.sendMessage(tgId,
    `📊 <b>Ваш статус</b>\n\n` +
    `👤 ФИО: <b>${freshUser?.fio || user.fio}</b>\n` +
    `📱 Телефон: <code>${user.phone}</code>\n` +
    `🚗 Авто: <b>${car}</b>\n` +
    `📋 Статус: <b>${freshUser?.status || user.status}</b>`,
    { parse_mode: "HTML", ...driverMenu(user) }
  );
});

// ─── ОБРАБОТКА FSM ────────────────────────────────────────────────────────────

bot.on("message", async (msg) => {
  const tgId    = msg.from.id;
  const text    = msg.text || "";
  const session = sessions.get(tgId);

  // Отмена из любого состояния
  if (text === "❌ Отмена") {
    sessions.delete(tgId);
    const user = await findDriverByTelegramId(tgId);
    const reply = user
      ? { text: "Действие отменено.", ...driverMenu(user) }
      : { text: "Действие отменено.", reply_markup: { remove_keyboard: true } };
    await bot.sendMessage(tgId, reply.text, reply);
    return;
  }

  if (!session) return;

  // ── Ремонт: выбор типа ───────────────────────────────────────────────────
  if (session.state === "repair_type") {
    const typeMap = {
      "🔧 Двигатель":          "Двигатель",
      "⚙️ КПП / Трансмиссия":  "Плановый",
      "🛞 Шиномонтаж":         "Шиномонтаж",
      "💥 Кузов / Аварийный":  "Аварийный",
      "🪟 Стекло":              "Стекло",
      "🔋 Электрика":          "Диагностика",
      "🩺 Диагностика":        "Диагностика",
      "❓ Другое":             "Плановый",
    };
    const type = typeMap[text];
    if (!type) return;

    session.data.repairType = type;
    session.state = "repair_description";
    sessions.set(tgId, session);

    await bot.sendMessage(tgId,
      `📝 Опишите неисправность подробнее:\n\n<i>Например: «стук в двигателе при холодном запуске» или «пробито переднее левое колесо»</i>`,
      { parse_mode: "HTML", ...cancelKeyboard }
    );
    return;
  }

  // ── Ремонт: описание ─────────────────────────────────────────────────────
  if (session.state === "repair_description") {
    session.data.description = text;
    session.state = "repair_photo";
    sessions.set(tgId, session);

    await bot.sendMessage(tgId,
      `📷 Пришлите фото неисправности\n\n<i>Или нажмите «Пропустить»</i>`,
      {
        parse_mode: "HTML",
        reply_markup: {
          keyboard: [[{ text: "⏭ Пропустить" }], [{ text: "❌ Отмена" }]],
          resize_keyboard: true,
        },
      }
    );
    return;
  }

  // ── Ремонт: фото (или пропуск) ───────────────────────────────────────────
  if (session.state === "repair_photo") {
    if (text !== "⏭ Пропустить") return; // Фото обрабатывается ниже
    await createRepair(tgId, session.data, null);
    sessions.delete(tgId);
    return;
  }
});

// ─── РЕМОНТ: ПРИЁМ ФОТО ───────────────────────────────────────────────────────

bot.on("photo", async (msg) => {
  const tgId    = msg.from.id;
  const session = sessions.get(tgId);
  if (!session || session.state !== "repair_photo") return;

  const fileId = msg.photo[msg.photo.length - 1].file_id;
  await createRepair(tgId, session.data, fileId);
  sessions.delete(tgId);
});

/**
 * Создать запись о ремонте в Notion + уведомить админов.
 */
async function createRepair(tgId, data, photoFileId) {
  const user    = await findDriverByTelegramId(tgId);
  const repairId = await nextId("REM", DB.repairs);

  const now = new Date().toISOString();

  await notion.pages.create({
    parent: { database_id: DB.repairs },
    properties: {
      "ID заявки":         { title:     [{ text: { content: repairId } }] },
      "Гос. номер авто":   { rich_text: [{ text: { content: data.car || "" } }] },
      "ФИО водителя":      { rich_text: [{ text: { content: user?.fio || "" } }] },
      "Telegram ID водителя": { rich_text: [{ text: { content: String(tgId) } }] },
      "Дата подачи заявки":{ date: { start: now } },
      "Тип ремонта":       { select: { name: data.repairType || "Диагностика" } },
      "Описание поломки":  { rich_text: [{ text: { content: data.description || "" } }] },
      "Статус":            { select: { name: "Заявка" } },
    },
  });

  // Уведомляем водителя
  await bot.sendMessage(tgId,
    `✅ <b>Заявка ${repairId} создана!</b>\n\n` +
    `🚗 Авто: <b>${data.car}</b>\n` +
    `🔧 Тип: ${data.repairType}\n` +
    `📝 Описание: ${data.description}\n\n` +
    `Администратор рассмотрит заявку и свяжется с вами.`,
    { parse_mode: "HTML", ...driverMenu(user) }
  );

  // Уведомляем всех админов
  const adminText =
    `🚨 <b>Новая заявка на ремонт!</b>\n\n` +
    `📋 ID: <b>${repairId}</b>\n` +
    `👤 Водитель: ${user?.fio || tgId}\n` +
    `🚗 Авто: <b>${data.car}</b>\n` +
    `🔧 Тип: ${data.repairType}\n` +
    `📝 ${data.description}\n\n` +
    `<a href="https://www.notion.so/${DB.repairs.replace(/-/g, "")}">Открыть в Notion →</a>`;

  for (const adminId of ADMIN_IDS) {
    bot.sendMessage(adminId, adminText, { parse_mode: "HTML" }).catch(() => {});
  }
}

// ─── ОТПУСК / БОЛЬНИЧНЫЙ ─────────────────────────────────────────────────────

bot.onText(/^🏖 Отпуск \/ Больничный$/, async (msg) => {
  const tgId = msg.from.id;
  const user = await findDriverByTelegramId(tgId);
  if (!user) { await askToRegister(tgId); return; }

  sessions.set(tgId, { state: "absence_type", data: {} });

  await bot.sendMessage(tgId,
    `🏖 <b>Отпуск / Больничный</b>\n\nВыберите тип:`,
    {
      parse_mode: "HTML",
      reply_markup: {
        keyboard: [
          [{ text: "🏖 Отпуск оплачиваемый" }, { text: "📋 Отпуск неоплачиваемый" }],
          [{ text: "🤒 Больничный" },           { text: "📅 Отгул" }],
          [{ text: "❌ Отмена" }],
        ],
        resize_keyboard: true,
      },
    }
  );
});

// ─── МИНИ-ПРИЛОЖЕНИЕ (совместимость со старым ботом) ─────────────────────────

if (APP_URL) {
  app.get("/", (req, res) => res.sendFile(__dirname + "/public/index.html"));
}

// ─── WEBHOOK ─────────────────────────────────────────────────────────────────

if (APP_URL) {
  const webhookPath = `/webhook/${BOT_TOKEN}`;
  app.post(webhookPath, (req, res) => {
    bot.processUpdate(req.body);
    res.sendStatus(200);
  });

  bot.setWebHook(`${APP_URL}${webhookPath}`)
    .then(() => console.log(`✅ Webhook: ${APP_URL}${webhookPath}`))
    .catch(err => console.error("Ошибка webhook:", err));
}

// ─── КНОПКА МЕНЮ ─────────────────────────────────────────────────────────────

if (APP_URL) {
  // setChatMenuButton не поддерживается в node-telegram-bot-api@0.66
  // Вызываем Telegram API напрямую через node-fetch
  const fetch = require("node-fetch");
  fetch(`https://api.telegram.org/bot${BOT_TOKEN}/setChatMenuButton`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      menu_button: { type: "web_app", text: "📅 Выходные", web_app: { url: APP_URL } }
    })
  })
  .then(r => r.json())
  .then(r => console.log("✅ Menu button set:", r.ok))
  .catch(e => console.error("Menu button error:", e.message));
}

// ─── ЕЖЕДНЕВНЫЕ УВЕДОМЛЕНИЯ (09:00 МСК) ──────────────────────────────────────

// Каждый день в 09:00 МСК = 06:00 UTC
cron.schedule("0 6 * * *", async () => {
  console.log("🔔 Проверяю дедлайны...");
  await checkDeadlines();
});

async function checkDeadlines() {
  const today    = new Date();
  const in30days = new Date(today.getTime() + 30 * 24 * 60 * 60 * 1000);
  const in30str  = in30days.toISOString().split("T")[0];
  const todayStr = today.toISOString().split("T")[0];

  // Истекающие страховки
  try {
    const ins = await notion.databases.query({
      database_id: DB.insurances,
      filter: {
        and: [
          { property: "Дата окончания действия", date: { before: in30str } },
          { property: "Дата окончания действия", date: { after: todayStr } },
        ],
      },
    });
    for (const p of ins.results) {
      const car    = getText(p, "Гос. номер авто") || "неизвестно";
      const type   = getSelect(p, "Тип страховки");
      const endDate = p.properties["Дата окончания действия"]?.date?.start || "";
      const daysLeft = Math.ceil((new Date(endDate) - today) / 86400000);
      for (const adminId of ADMIN_IDS) {
        bot.sendMessage(adminId,
          `⚠️ <b>${type} истекает через ${daysLeft} дн.!</b>\n🚗 ${car}\n📅 До: ${endDate}`,
          { parse_mode: "HTML" }
        ).catch(() => {});
      }
    }
  } catch (e) { console.error("Ошибка checkDeadlines insurance:", e.message); }

  // Истекающие техосмотры
  try {
    const ins = await notion.databases.query({
      database_id: DB.inspections,
      filter: {
        and: [
          { property: "Действует до", date: { before: in30str } },
          { property: "Действует до", date: { after: todayStr } },
        ],
      },
    });
    for (const p of ins.results) {
      const car      = getText(p, "Гос. номер авто") || "неизвестно";
      const endDate  = p.properties["Действует до"]?.date?.start || "";
      const daysLeft = Math.ceil((new Date(endDate) - today) / 86400000);
      for (const adminId of ADMIN_IDS) {
        bot.sendMessage(adminId,
          `🚗 <b>Техосмотр истекает через ${daysLeft} дн.!</b>\n${car}\n📅 До: ${endDate}`,
          { parse_mode: "HTML" }
        ).catch(() => {});
      }
    }
  } catch (e) { console.error("Ошибка checkDeadlines inspections:", e.message); }
}

// ─── ВСПОМОГАТЕЛЬНЫЕ ──────────────────────────────────────────────────────────

async function askToRegister(tgId) {
  sessions.set(tgId, { state: "waiting_phone" });
  await bot.sendMessage(tgId,
    "❗ Вы не зарегистрированы в системе.\n\nПоделитесь номером телефона для привязки:",
    sharePhoneKeyboard
  );
}

// ─── ЗАПУСК ───────────────────────────────────────────────────────────────────

app.listen(PORT, () => console.log(`🚀 Server on port ${PORT}`));
