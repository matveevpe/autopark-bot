const express = require('express');
const fetch = require('node-fetch');
const TelegramBot = require('node-telegram-bot-api');
const path = require('path');

const BOT_TOKEN    = process.env.BOT_TOKEN;
const NOTION_TOKEN = process.env.NOTION_TOKEN;
const DB_VACATIONS = process.env.DB_VACATIONS || '8195f2ccc73e418cae12d3639211da86';
const DB_EMPLOYEES = process.env.DB_EMPLOYEES || '3e4caec4095c45b49eabd35652a00ea0';
const APP_URL      = process.env.APP_URL || '';
const PORT         = process.env.PORT || 3000;

if (!BOT_TOKEN || !NOTION_TOKEN) {
  console.error('❌ Задай BOT_TOKEN и NOTION_TOKEN в переменных окружения!');
  process.exit(1);
}

const app = express();
app.use(express.json());
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});
app.use(express.static(path.join(__dirname, 'public')));

const NOTION_HEADERS = {
  'Authorization': `Bearer ${NOTION_TOKEN}`,
  'Notion-Version': '2022-06-28',
  'Content-Type': 'application/json',
};


// GET /api/employees
app.get('/api/employees', async (req, res) => {
  try {
    const r = await fetch(`https://api.notion.com/v1/databases/${DB_EMPLOYEES}/query`, {
      method: 'POST',
      headers: NOTION_HEADERS,
      body: JSON.stringify({
        sorts: [{ property: 'ФИО', direction: 'ascending' }],
        page_size: 100,
      }),
    });
    const data = await r.json();
    console.log('Notion employees status:', r.status, data.object, data.message || '');
    if (!data.results) return res.status(500).json({ error: 'Notion error', details: data });

    const employees = data.results
      .map(p => p.properties['ФИО']?.title?.[0]?.plain_text)
      .filter(Boolean)
      .sort((a, b) => a.localeCompare(b, 'ru'));

    res.json({ employees });
  } catch (err) {
    console.error('employees error:', err);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/vacation
app.post('/api/vacation', async (req, res) => {
  const { employee, month, type, days } = req.body;
  if (!employee || !month || !type || !days)
    return res.status(400).json({ error: 'Не все поля заполнены' });

  try {
    const r = await fetch('https://api.notion.com/v1/pages', {
      method: 'POST',
      headers: NOTION_HEADERS,
      body: JSON.stringify({
        parent: { database_id: DB_VACATIONS },
        properties: {
          'Сотрудник': { title: [{ text: { content: employee } }] },
          'Месяц':     { select: { name: month } },
          'Тип':       { select: { name: type } },
          'Дни':       { rich_text: [{ text: { content: days } }] },
        },
      }),
    });
    const data = await r.json();
    console.log('Notion vacation status:', r.status, data.object, data.message || '');
    if (data.id) res.json({ success: true, id: data.id });
    else res.status(400).json({ error: data.message || 'Ошибка Notion' });
  } catch (err) {
    console.error('vacation error:', err);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/sync-drivers — браузер шлёт массив водителей, сервер пишет в Notion
app.post('/api/sync-drivers', async (req, res) => {
  const { drivers } = req.body;
  if (!Array.isArray(drivers)) return res.status(400).json({ error: 'drivers must be array' });

  const norm = p => p ? String(p).replace(/\D/g,'').replace(/^8/,'7') : '';

  let existing = [], cursor;
  do {
    const body = { page_size: 100 };
    if (cursor) body.start_cursor = cursor;
    const r = await fetch(`https://api.notion.com/v1/databases/${DB_EMPLOYEES}/query`, {
      method: 'POST', headers: NOTION_HEADERS, body: JSON.stringify(body),
    });
    const d = await r.json();
    if (!d.results) return res.status(500).json({ error: 'Notion query failed', details: d });
    existing = existing.concat(d.results);
    cursor = d.has_more ? d.next_cursor : null;
  } while (cursor);

  const existPhones = new Set(existing.map(p => norm(p.properties['Телефон']?.phone_number)).filter(Boolean));
  const existNames  = new Set(existing.map(p => p.properties['ФИО']?.title?.[0]?.plain_text?.trim()).filter(Boolean));

  let added = 0, skipped = 0, errors = 0;
  for (const u of drivers) {
    const fio = [u.last_name, u.first_name, u.middle_name].filter(Boolean).join(' ');
    const phone = norm(u.phone);
    if ((phone && existPhones.has(phone)) || (!phone && existNames.has(fio))) { skipped++; continue; }
    const props = { 'ФИО': { title: [{ text: { content: fio } }] } };
    if (u.phone) props['Телефон'] = { phone_number: String(u.phone) };
    const r = await fetch('https://api.notion.com/v1/pages', {
      method: 'POST', headers: NOTION_HEADERS,
      body: JSON.stringify({ parent: { database_id: DB_EMPLOYEES }, properties: props }),
    });
    const d = await r.json();
    if (d.id) { added++; console.log(`✅ added: ${fio}`); }
    else { errors++; console.error(`❌ ${fio}:`, d.message); }
    await new Promise(r => setTimeout(r, 320));
  }
  res.json({ success: true, added, skipped, errors, total: drivers.length });
});

// ─── Telegram Bot
const bot = new TelegramBot(BOT_TOKEN, { polling: true });

const getKeyboard = () => APP_URL ? {
  reply_markup: {
    inline_keyboard: [[{
      text: '📅 Добавить выходной / отпуск',
      web_app: { url: APP_URL },
    }]],
  },
} : {};

bot.onText(/\/start/, (msg) => {
  const name = msg.from?.first_name || 'друг';
  if (!APP_URL) return bot.sendMessage(msg.chat.id, '⚙️ APP_URL не задан.');
  bot.sendMessage(msg.chat.id,
    `👋 Привет, ${name}!\n\n🚗 *Автопарк — управление выходными*\n\nНажми кнопку чтобы добавить выходные, отпуск или больничный для водителя.`,
    { parse_mode: 'Markdown', ...getKeyboard() }
  );
});

bot.on('message', (msg) => {
  if (msg.text?.startsWith('/')) return;
  if (!APP_URL) return;
  bot.sendMessage(msg.chat.id, '👇 Используй кнопку ниже:', getKeyboard());
});

async function setMenuButton() {
  if (!APP_URL) return;
  try {
    await bot.setChatMenuButton({
      menu_button: { type: 'web_app', text: '📅 Выходные', web_app: { url: APP_URL } },
    });
    console.log('✅ Menu button set:', APP_URL);
  } catch (e) {
    console.error('Menu button error:', e.message);
  }
}

app.listen(PORT, () => {
  console.log(`🚀 Server on port ${PORT}`);
  setMenuButton();
});
