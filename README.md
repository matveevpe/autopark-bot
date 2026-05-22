# 🚗 Autopark Bot — Telegram Mini App

Telegram-бот с мини-приложением для добавления выходных и отпусков водителей прямо в Notion.

---

## 🚀 Деплой на Railway (бесплатно, 5 минут)

### Шаг 1 — Загрузи код на GitHub

1. Создай новый репозиторий на [github.com](https://github.com/new)
2. Загрузи файлы (можно через сайт — кнопка "uploading an existing file"):
   - `index.js`
   - `package.json`
   - `public/index.html`

### Шаг 2 — Задеплой на Railway

1. Зайди на [railway.app](https://railway.app) → войди через GitHub
2. **New Project** → **Deploy from GitHub repo** → выбери свой репозиторий
3. Railway сам найдёт Node.js и запустит `npm start`

### Шаг 3 — Получи URL

1. В Railway открой свой проект → вкладка **Settings**
2. Нажми **Generate Domain** — получишь URL вида `https://autopark-bot-xxx.railway.app`

### Шаг 4 — Задай переменные окружения

В Railway → **Variables** добавь:

| Переменная | Значение |
|---|---|
| `APP_URL` | `https://autopark-bot-xxx.railway.app` (твой URL из шага 3) |
| `BOT_TOKEN` | твой токен от BotFather |
| `NOTION_TOKEN` | твой Notion integration token |

После добавления переменных Railway автоматически перезапустит сервер.

### Шаг 5 — Настрой бота в BotFather

1. Напиши `/setmenubutton` в BotFather
2. Выбери своего бота
3. Выбери **Configure menu button**
4. Введи URL: `https://autopark-bot-xxx.railway.app`
5. Введи текст кнопки: `📅 Выходные`

Готово! Открой бота в Telegram и нажми `/start` или кнопку снизу.

---

## 📱 Как выглядит приложение

- Список водителей загружается из Notion автоматически
- Выбор месяца, типа (Выходной / Больничный / ТС в Ремонте)
- Удобная сетка для выбора дней
- После отправки — запись мгновенно появляется в Notion

---

## ⚙️ Переменные окружения

| Переменная | По умолчанию | Описание |
|---|---|---|
| `BOT_TOKEN` | вшит в код | Токен Telegram-бота |
| `NOTION_TOKEN` | вшит в код | Notion Integration Token |
| `DB_VACATIONS` | вшит в код | ID базы "Отпуска и выходные" |
| `DB_EMPLOYEES` | вшит в код | ID базы "Арендаторы" |
| `APP_URL` | — | HTTPS-адрес после деплоя |
| `PORT` | 3000 | Порт сервера |
