const { Telegraf, Markup } = require('telegraf');
const { JWT } = require('google-auth-library');
const { GoogleSpreadsheet } = require('google-spreadsheet');

// ================= CONFIG =================
const bot = new Telegraf(process.env.BOT_TOKEN);
const SHEET_ID = process.env.SHEET_ID;

// ===== ROLES (EDIT THIS) =====
const MANAGERS = [Number(process.env.MANAGER_CHAT_ID)];
const CEOS = [Number(process.env.CEO_CHAT_ID)];

// ================= GOOGLE =================
const creds = JSON.parse(process.env.GCP_SERVICE_ACCOUNT);

const auth = new JWT({
  email: creds.client_email,
  key: creds.private_key,
  scopes: ['https://www.googleapis.com/auth/spreadsheets'],
});

const doc = new GoogleSpreadsheet(SHEET_ID, auth);

// ================= SESSION =================
const sessions = {};

function getSession(userId) {
  if (!sessions[userId]) {
    sessions[userId] = { step: null };
  }
  return sessions[userId];
}

function clearSession(userId) {
  delete sessions[userId];
}

// ================= ROLES =================
function getRole(userId) {
  if (MANAGERS.includes(userId)) return 'MANAGER';
  if (CEOS.includes(userId)) return 'CEO';
  return 'STAFF';
}

// ================= DATA =================
const branches = ['📍 Integro', '📍 Drujba', '📍 Amir Temur', '📍 Central', '📍 Marketing'];

const standardCategories = [
  'tugilgan kun uchun','printer rang','Printer tuzatish','remont-tuzatish',
  'Hodimlar uchun dorilar','jihoz','Texnikalar','Transport','aromatizator',
  'Internet','Telefon','of the month','Event','bozorlik xojalik',
  'Suv va stakan','Konstovar','Plastik foizi','ofis xarajatlari','remont qurilish'
];

const marketingCategories = [
  'syomka xarajatlari','Reklama mahsulotlarini chiqarish'
];

const priorities = [
  "🔴 O'ta muhim (Bugun)",
  "🟡 O'rtacha (Ertaga)",
  "🔵 Normal (Shu hafta)",
  "🟢 Shoshilinch emas (Shu oy)"
];

const payTypes = ['Karta', 'Naqd', 'MCHJ hisobi'];

// ================= HELPERS =================
const escape = (text) =>
  String(text).replace(/([_*[\]()~`>#+-=|{}.!])/g, '\\$1');

const getCategories = (branch) =>
  branch === '📍 Marketing' ? marketingCategories : standardCategories;

const isValidAmount = (text) => {
  const clean = text.replace(/[^0-9]/g, '');
  return clean && Number(clean) > 0 ? clean : null;
};

// ================= START =================
bot.start((ctx) => {
  const role = getRole(ctx.from.id);

  if (role === 'STAFF') {
    return startRequest(ctx);
  }

  if (role === 'MANAGER') {
    return ctx.reply('👨‍💼 Manager panel', Markup.keyboard([
      ['📊 Reports', '📋 Pending Requests']
    ]).resize());
  }

  if (role === 'CEO') {
    return ctx.reply('👑 CEO Dashboard (Read Only)', Markup.keyboard([
      ['📊 Global Report']
    ]).resize());
  }
});

// ================= REQUEST START =================
function startRequest(ctx) {
  const session = getSession(ctx.from.id);
  session.step = 'BRANCH';

  return ctx.reply(
    '📍 Filialni tanlang:',
    Markup.keyboard(branches, { columns: 2 }).resize()
  );
}

// ================= TEXT HANDLER =================
bot.on('text', async (ctx) => {
  const userId = ctx.from.id;
  const role = getRole(userId);
  const text = ctx.message.text;

  const session = getSession(userId);

  // ===== CANCEL =====
  if (text === '❌ Bekor qilish') {
    clearSession(userId);
    return ctx.reply('❌ Bekor qilindi');
  }

  // ===== STAFF FLOW =====
  if (role === 'STAFF') {
    return handleStaffFlow(ctx, session, text);
  }

  // ===== MANAGER =====
  if (role === 'MANAGER') {
    if (text === '📊 Reports') {
      return ctx.reply('📊 Reports coming soon...');
    }

    if (text === '📋 Pending Requests') {
      return ctx.reply('📋 Pending list coming soon...');
    }
  }

  // ===== CEO =====
  if (role === 'CEO') {
    if (text === '📊 Global Report') {
      return ctx.reply('📊 Global report coming soon...');
    }
  }
});

// ================= STAFF FLOW =================
async function handleStaffFlow(ctx, session, text) {

  switch (session.step) {

    case 'BRANCH':
      if (!branches.includes(text)) return;
      session.branch = text;
      session.step = 'CATEGORY';

      return ctx.reply(
        '📂 Kategoriyani tanlang:',
        Markup.keyboard([...getCategories(text), '❌ Bekor qilish'], { columns: 2 }).resize()
      );

    case 'CATEGORY':
      if (!getCategories(session.branch).includes(text)) {
        return ctx.reply('❗ Tugmadan tanlang');
      }

      session.category = text;
      session.step = 'AMOUNT';

      return ctx.reply('💰 Summani kiriting:');

    case 'AMOUNT':
      const amount = isValidAmount(text);
      if (!amount) return ctx.reply('❗ Noto‘g‘ri summa');

      session.amount = amount;
      session.step = 'DESCRIPTION';

      return ctx.reply('📝 Tavsif kiriting:');

    case 'DESCRIPTION':
      session.description = text;
      session.step = 'PRIORITY';

      return ctx.reply(
        '⏰ Muhimlik:',
        Markup.keyboard(priorities).resize()
      );

    case 'PRIORITY':
      if (!priorities.includes(text)) return ctx.reply('❗ Tugmadan tanlang');

      session.priority = text;
      session.step = 'PAY_TYPE';

      return ctx.reply(
        '💳 To‘lov turi:',
        Markup.keyboard([...payTypes, '❌ Bekor qilish']).resize()
      );

    case 'PAY_TYPE':
      if (!payTypes.includes(text)) return ctx.reply('❗ Tugmadan tanlang');

      session.payType = text;

      if (text === 'Naqd') {
        session.payDetail = 'N/A';
        return showSummary(ctx, session);
      }

      session.step = 'PAY_DETAIL';
      return ctx.reply('💳 Karta yoki firma nomi:');

    case 'PAY_DETAIL':
      session.payDetail = text;
      return showSummary(ctx, session);
  }
}

// ================= SUMMARY =================
function showSummary(ctx, s) {
  const msg = `
📍 ${escape(s.branch)}
📂 ${escape(s.category)}
💰 ${Number(s.amount).toLocaleString()} UZS
📝 ${escape(s.description)}
⏰ ${escape(s.priority)}
💳 ${escape(s.payType)} (${escape(s.payDetail)})
`;

  return ctx.reply(`⚠️ Tasdiqlaysizmi?\n${msg}`, {
    parse_mode: 'Markdown',
    ...Markup.inlineKeyboard([
      [Markup.button.callback('✅ Yuborish', 'submit')],
      [Markup.button.callback('❌ Bekor qilish', 'cancel')]
    ])
  });
}

// ================= ACTIONS =================
bot.action('submit', (ctx) => {
  ctx.reply('🚧 Next step: Budget + Submit logic');
});

bot.action('cancel', (ctx) => {
  clearSession(ctx.from.id);
  ctx.editMessageText('❌ Bekor qilindi');
});

// ================= START BOT =================
bot.launch();
