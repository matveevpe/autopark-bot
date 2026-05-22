/**
 * Синхронизация водителей taxiCRM → Notion
 * 
 * Настройка: скопируй .env.example в .env и заполни значения
 * Запуск:    node sync.js
 */

const https = require('https');
const crypto = require('crypto');

// ─── Конфиг (из переменных окружения или .env) ─────────────────────────────
require('./load-env'); // простой загрузчик .env
const TAXICRM_KEY    = process.env.TAXICRM_KEY;
const TAXICRM_DOMAIN = process.env.TAXICRM_DOMAIN;
const NOTION_TOKEN   = process.env.NOTION_TOKEN;
const DB_EMPLOYEES   = process.env.DB_EMPLOYEES || '3e4caec4095c45b49eabd35652a00ea0';

if (!TAXICRM_KEY || !TAXICRM_DOMAIN || !NOTION_TOKEN) {
  console.error('❌ Создай файл .env (см. .env.example) и заполни переменные');
  process.exit(1);
}

// ─── HTTP helper ──────────────────────────────────────────────────────────────
function request(url, options, body) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const req = https.request({
      hostname: u.hostname,
      path: u.pathname + u.search,
      method: options.method || 'POST',
      headers: options.headers,
    }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(data) }); }
        catch { resolve({ status: res.statusCode, body: data }); }
      });
    });
    req.on('error', reject);
    if (body) req.write(typeof body === 'string' ? body : JSON.stringify(body));
    req.end();
  });
}

// ─── taxiCRM API ──────────────────────────────────────────────────────────────
function taxiRequest(endpoint, params = {}) {
  const body = { timestamp: Math.floor(Date.now() / 1000), ...params };
  const bodyStr = JSON.stringify(body);
  const signature = crypto.createHash('sha1')
    .update(bodyStr + TAXICRM_KEY, 'utf8')
    .digest('hex');
  return request(
    `https://${TAXICRM_DOMAIN}.taxicrm.ru/api/public/v1${endpoint}`,
    { method: 'POST', headers: { 'Authorization': signature, 'Content-Type': 'application/json' } },
    bodyStr
  );
}

// ─── Notion API ───────────────────────────────────────────────────────────────
function notionRequest(endpoint, body) {
  return request(
    `https://api.notion.com/v1${endpoint}`,
    { method: 'POST', headers: { 'Authorization': `Bearer ${NOTION_TOKEN}`, 'Notion-Version': '2022-06-28', 'Content-Type': 'application/json' } },
    body
  );
}

async function getNotionEmployees() {
  let all = [], cursor;
  do {
    const body = { page_size: 100 };
    if (cursor) body.start_cursor = cursor;
    const res = await notionRequest(`/databases/${DB_EMPLOYEES}/query`, body);
    if (res.status !== 200) throw new Error('Notion error: ' + JSON.stringify(res.body));
    all = all.concat(res.body.results);
    cursor = res.body.has_more ? res.body.next_cursor : undefined;
  } while (cursor);
  return all;
}

function addToNotion(user) {
  const fio = [user.last_name, user.first_name, user.middle_name].filter(Boolean).join(' ');
  const props = { 'ФИО': { title: [{ text: { content: fio } }] } };
  if (user.phone) props['Телефон'] = { phone_number: user.phone };
  return notionRequest('/pages', { parent: { database_id: DB_EMPLOYEES }, properties: props });
}

// ─── Основная логика ──────────────────────────────────────────────────────────
const norm = p => p ? p.replace(/\D/g, '').replace(/^8/, '7') : '';

async function main() {
  console.log('🔄 Синхронизация taxiCRM → Notion\n');

  console.log('📡 Загружаем пользователей из taxiCRM...');
  const taxiRes = await taxiRequest('/user/list', { filters: { status: 1 } });
  if (taxiRes.status !== 200 || !taxiRes.body.success) {
    console.error('❌ Ошибка taxiCRM:', taxiRes.status, JSON.stringify(taxiRes.body));
    process.exit(1);
  }
  const users = taxiRes.body.users_list || [];
  console.log(`✅ Получено ${users.length} пользователей\n`);

  console.log('📋 Загружаем базу Арендаторы из Notion...');
  const pages = await getNotionEmployees();
  const existPhones = new Set(pages.map(p => norm(p.properties['Телефон']?.phone_number)).filter(Boolean));
  const existNames  = new Set(pages.map(p => p.properties['ФИО']?.title?.[0]?.plain_text?.trim()).filter(Boolean));
  console.log(`✅ Уже в Notion: ${pages.length} записей\n`);

  let added = 0, skipped = 0, errors = 0;
  for (const user of users) {
    const fio = [user.last_name, user.first_name, user.middle_name].filter(Boolean).join(' ');
    const phone = norm(user.phone);
    if ((phone && existPhones.has(phone)) || (!phone && existNames.has(fio))) {
      console.log(`⏭  Уже есть: ${fio}`);
      skipped++; continue;
    }
    process.stdout.write(`➕ ${fio} (${user.phone || '—'})... `);
    const res = await addToNotion(user);
    if (res.status === 200) { console.log('✅'); added++; }
    else { console.log('❌', JSON.stringify(res.body).slice(0, 80)); errors++; }
    await new Promise(r => setTimeout(r, 300));
  }

  console.log(`\n${'━'.repeat(40)}\n✅ Готово  |  +${added} добавлено  |  ⏭ ${skipped} пропущено  |  ❌ ${errors} ошибок\n${'━'.repeat(40)}`);
}

main().catch(e => { console.error('❌', e.message); process.exit(1); });
