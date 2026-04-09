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

  if (!userSessions[userId]) return;

  const session = userSessions[userId];

  if (session.step === 'CATEGORY') {
    if (categories.includes(text)) {
      session.category = text;
      session.step = 'AMOUNT';
      return ctx.reply(`${text} tanlandi.\n\n2-bosqich: Summani kiriting (faqat son):`, Markup.removeKeyboard());
    }
    return ctx.reply('Iltimos, tugmalardan birini tanlang.');
  }

  if (session.step === 'AMOUNT') {
    const amount = text.replace(/[^0-9]/g, ''); 
    if (!amount) return ctx.reply('Faqat son kiriting (masalan: 50000).');
    session.amount = amount;
    session.step = 'DESCRIPTION';
    return ctx.reply(`Summa: ${amount} so'm.\n\n3-bosqich: Xarajat nima uchun? (Tafsilotni yozing)`);
  }

  if (session.step === 'DESCRIPTION') {
    session.description = text;
    const { category, amount, description } = session;
    ctx.reply('Yuborilmoqda... ⏳');
    
    try {
      await doc.loadInfo();
      const sheet = doc.sheetsByTitle['Pending_Expenses']; 
      const row = await sheet.addRow({
        'Timestamp': new Date().toLocaleString(),
        'Staff Name': ctx.from.first_name || 'Xodim',
        'Amount': amount,
        'Description': `[${category}] ${description}`,
        'Status': 'KUTILMOQDA',
        '_StaffChatId': userId.toString()
      });

      await bot.telegram.sendMessage(MANAGER_ID, 
        `💰 *Yangi xarajat*\n\n👤 *Xodim:* ${ctx.from.first_name}\n📂 *Kategoriya:* ${category}\n💵 *Summa:* ${amount} so'm\n📝 *Sabab:* ${description}`, 
        {
          parse_mode: 'Markdown',
          ...Markup.inlineKeyboard([
            [Markup.button.callback('✅ Tasdiqlash', `app_${row.rowNumber}`)],
            [Markup.button.callback('❌
