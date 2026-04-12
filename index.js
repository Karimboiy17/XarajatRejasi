const { Telegraf, Markup } = require('telegraf');
const { JWT } = require('google-auth-library');
const { GoogleSpreadsheet } = require('google-spreadsheet');

// ================= CONFIG =================
const bot = new Telegraf(process.env.BOT_TOKEN);
const SHEET_ID = process.env.SHEET_ID;
const MANAGER_ID = Number(process.env.MANAGER_CHAT_ID);

// ================= GOOGLE AUTH =================
const creds = JSON.parse(process.env.GCP_SERVICE_ACCOUNT);

const auth = new JWT({
  email: creds.client_email,
  key: creds.private_key,
  scopes: ['https://www.googleapis.com/auth/spreadsheets'],
});

const doc = new GoogleSpreadsheet(SHEET_ID, auth);

// ================= MEMORY =================
const sessions = {};

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
bot.start(startFlow);
bot.command('new', startFlow);

function startFlow(ctx) {
  sessions[ctx.from.id] = { step: 'BRANCH' };
  return ctx.reply(
    '📍 Filialni tanlang:',
    Markup.keyboard(branches, { columns: 2 }).resize()
  );
}

// ================= MAIN FLOW =================
bot.on('text', async (ctx) => {
  const userId = ctx.from.id;
  const text = ctx.message.text;

  if (text === '❌ Bekor qilish') {
    delete sessions[userId];
    return startFlow(ctx);
  }

  const session = sessions[userId];
  if (!session) return;

  switch (session.step) {

    case 'BRANCH':
      if (!branches.includes(text)) return;
      session.branch = text;
      session.step = 'CATEGORY';
      return ctx.reply(
        'Kategoriyani tanlang:',
        Markup.keyboard([...getCategories(text), '❌ Bekor qilish'], { columns: 2 }).resize()
      );

    case 'CATEGORY':
      if (!getCategories(session.branch).includes(text)) {
        return ctx.reply('❗ Tugmadan tanlang');
      }
      session.category = text;
      session.step = 'AMOUNT';
      return ctx.reply('💰 Summani kiriting:', Markup.keyboard(['❌ Bekor qilish']).resize());

    case 'AMOUNT':
      const amount = isValidAmount(text);
      if (!amount) {
        return ctx.reply('❗ Noto‘g‘ri summa. Faqat raqam kiriting.');
      }
      session.amount = amount;
      session.step = 'DESCRIPTION';
      return ctx.reply('📝 Tavsif kiriting:');

    case 'DESCRIPTION':
      session.description = text;
      session.step = 'PRIORITY';
      return ctx.reply(
        '⏰ Muhimlik:',
        Markup.keyboard(priorities, { columns: 1 }).resize()
      );

    case 'PRIORITY':
      if (!priorities.includes(text)) {
        return ctx.reply('❗ Tugmadan tanlang');
      }
      session.priority = text;
      session.step = 'PAY_TYPE';
      return ctx.reply(
        '💳 To‘lov turi:',
        Markup.keyboard([...payTypes, '❌ Bekor qilish']).resize()
      );

    case 'PAY_TYPE':
      if (!payTypes.includes(text)) {
        return ctx.reply('❗ Tugmadan tanlang');
      }
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
});

// ================= SUMMARY =================
async function showSummary(ctx, s) {
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

// ================= SUBMIT =================
bot.action('submit', async (ctx) => {
  const userId = ctx.from.id;
  const s = sessions[userId];
  if (!s) return;

  try {
    await doc.loadInfo();
    const sheet = doc.sheetsByTitle['Pending_Expenses'];

    const row = await sheet.addRow({
      Timestamp: new Date().toISOString(),
      Branch: s.branch,
      Amount: s.amount,
      'Payment Type': s.payType,
      'Payment Detail': s.payDetail,
      Description: `[${s.category}] ${s.description}`,
      Status: 'PENDING',
      Priority: s.priority,
      _StaffChatId: userId.toString()
    });

    await bot.telegram.sendMessage(
      MANAGER_ID,
      `🏢 Yangi so'rov\n📍 ${s.branch}\n💰 ${Number(s.amount).toLocaleString()} UZS\n📝 ${s.description}`,
      {
        ...Markup.inlineKeyboard([
          [Markup.button.callback('✅ Tasdiqlash', `decide_${row.rowNumber}`)],
          [Markup.button.callback('❌ Rad etish', `reject_${row.rowNumber}`)]
        ])
      }
    );

    delete sessions[userId];

    await ctx.editMessageText('✅ Yuborildi!');
    return startFlow(ctx);

  } catch (err) {
    console.error(err);
    ctx.reply('❌ Xatolik yuz berdi');
  }
});

// ================= CANCEL =================
bot.action('cancel', (ctx) => {
  delete sessions[ctx.from.id];
  ctx.editMessageText('❌ Bekor qilindi');
});

// ================= LAUNCH =================
bot.launch();
