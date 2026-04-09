const { Telegraf, Markup } = require('telegraf');
const { JWT } = require('google-auth-library');
const { GoogleSpreadsheet } = require('google-spreadsheet');

const bot = new Telegraf(process.env.BOT_TOKEN);
const SHEET_ID = process.env.SHEET_ID;
const MANAGER_ID = process.env.MANAGER_CHAT_ID;

const creds = JSON.parse(process.env.GCP_SERVICE_ACCOUNT);
const serviceAccountAuth = new JWT({
  email: creds.client_email,
  key: creds.private_key,
  scopes: ['https://www.googleapis.com/auth/spreadsheets'],
});

const doc = new GoogleSpreadsheet(SHEET_ID, serviceAccountAuth);

// Foydalanuvchi qaysi bosqichdaligini eslab qolish uchun
const userSessions = {};
const categories = ['🏠 Ijara', '📢 Marketing', '💻 IT/Ofis', '☕️ Oshxona', '🎓 Oylik (Ustozlar)', '🛠 Ta’mirlash'];

bot.command(['start', 'new'], (ctx) => {
  const userId = ctx.from.id;
  userSessions[userId] = { step: 'CATEGORY' };
  
  ctx.reply('IELTS Zone Xarajatlar Botiga xush kelibsiz! 🎓\n\n1-bosqich: Yo‘nalishni tanlang:', 
    Markup.keyboard(categories, { columns: 2 }).oneTime().resize()
  );
});

bot.on('text', async (ctx) => {
  const userId = ctx.from.id;
  const text = ctx.message.text;

  if (!userSessions[userId]) return ctx.reply('Iltimos, yangi so‘rov yuborish uchun /start bosing.');

  const session = userSessions[userId];

  // 1. KATEGORIYA TANLASH
  if (session.step === 'CATEGORY') {
    if (categories.includes(text)) {
      session.category = text;
      session.step = 'AMOUNT';
      return ctx.reply(`${text} tanlandi.\n\n2-bosqich: Summani kiriting (faqat son):`, Markup.removeKeyboard());
    }
    return ctx.reply('Iltimos, quyidagi tugmalardan birini tanlang.');
  }

  // 2. SUMMANI KIRITISH
  if (session.step === 'AMOUNT') {
    const amount = text.replace(/[^0-9]/g, ''); 
    if (!amount || isNaN(amount)) {
      return ctx.reply('Xato summa! Iltimos, faqat son kiriting (masalan: 50000).');
    }
    session.amount = amount;
    session.step = 'DESCRIPTION';
    return ctx.reply(`Summa: ${amount} so'm.\n\n3-bosqich: Xarajat nima uchun? (Tafsilotini yozing)`);
  }
