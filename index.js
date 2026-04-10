const { Telegraf, Markup } = require('telegraf');
const { JWT } = require('google-auth-library');
const { GoogleSpreadsheet } = require('google-spreadsheet');

const bot = new Telegraf(process.env.BOT_TOKEN);
const SHEET_ID = process.env.SHEET_ID;
const MANAGER_ID = process.env.MANAGER_CHAT_ID;

const creds = JSON.parse(process.env.GCP_SERVICE_ACCOUNT);
const auth = new JWT({
  email: creds.client_email,
  key: creds.private_key,
  scopes: ['https://www.googleapis.com/auth/spreadsheets'],
});

const doc = new GoogleSpreadsheet(SHEET_ID, auth);
const userSessions = {};

// --- THE CLEANED CATEGORY LIST ---
const categories = [
  'Bonus natijalar uchun', 'tugilgan kun uchun', 'printer rang', 
  'Printer tuzatish', 'remont-tuzatish', 'Hodimlar uchun dorilar', 
  'jihoz', 'Texnikalar', 'Transport', 'aromatizator', 'Internet', 
  'Telefon', 'of the month', 'Event', 'Reklama mahsulotlarini chiqarish', 
  'giftbox sovgalar', 'syomka xarajatlari', 'bozorlik xojalik', 
  'Suv va stakan', 'Konstovar', 'Plastik foizi', 'ofis xarajatlari', 
  'refound', 'remont qurilish'
];

const showMainMenu = (ctx, text = 'Please select a category:') => {
  return ctx.reply(text, 
    Markup.keyboard([...categories, '❌ Cancel'], { columns: 2 }).resize()
  );
};

bot.command(['start', 'new'], (ctx) => {
  userSessions[ctx.from.id] = { step: 'CATEGORY' };
  showMainMenu(ctx, 'IELTS Zone Finance System 🎓');
});

bot.on('text', async (ctx) => {
  const userId = ctx.from.id;
  const text = ctx.message.text;

  if (text.startsWith('/')) return;
  if (text === '❌ Cancel') {
    userSessions[userId] = { step: 'CATEGORY' };
    return showMainMenu(ctx, 'Cancelled. Select a category:');
  }

  if (!userSessions[userId]) userSessions[userId] = { step: 'CATEGORY' };
  const session = userSessions[userId];

  // STEP 1: CATEGORY
  if (session.step === 'CATEGORY') {
    if (categories.includes(text)) {
      session.category = text;
      session.step = 'AMOUNT';
      return ctx.reply(`Selected: ${text}\n\nEnter Amount (UZS):`, Markup.keyboard(['❌ Cancel']).resize());
    }
    return showMainMenu(ctx);
  }

  // STEP 2: AMOUNT
  if (session.step === 'AMOUNT') {
    const amt = text.replace(/[^0-9]/g, '');
    if (!amt) return ctx.reply('Please enter numbers only.');
    session.amount = amt;
    session.step = 'DESCRIPTION';
    return ctx.reply('Description / Reason:');
  }

  // STEP 3: DESCRIPTION & SUBMIT
  if (session.step === 'DESCRIPTION') {
    try {
      await doc.loadInfo();
      const sheet = doc.sheetsByTitle['Pending_Expenses'];
      const row = await sheet.addRow({
        'Timestamp': new Date().toLocaleString(),
        'Staff Name': ctx.from.first_name || 'Staff',
        'Amount': session.amount,
        'Description': `[${session.category}] ${text}`,
        'Status': 'PENDING',
        '_StaffChatId': userId.toString()
      });

      await bot.telegram.sendMessage(MANAGER_ID, 
        `💰 *New Request*\n👤 From: ${ctx.from.first_name}\n📂 Category: ${session.category}\n💵 Amount: ${session.amount} UZS\n📝 Reason: ${text}`, 
        { parse_mode: 'Markdown', ...Markup.inlineKeyboard([[Markup.button.callback('✅ Approve', `app_${row.rowNumber}`)], [Markup.button.callback('❌ Reject', `rej_${row.rowNumber}`)]]) }
      );

      userSessions[userId] = { step: 'CATEGORY' };
      ctx.reply('✅ Sent to Manager!');
      return showMainMenu(ctx);
    } catch (e) {
      console.error(e);
      ctx.reply('Error saving to sheet.');
    }
  }
});

// Manager Actions
bot.action(/^(app|rej)_(.+)$/, async (ctx) => {
  const [action, rowNum] = [ctx.match[1], ctx.match[2]];
  try {
    await doc.loadInfo();
    const sheet = doc.sheetsByTitle['Pending_Expenses'];
    const rows = await sheet.getRows();
    const targetRow = rows.find(r => r.rowNumber == rowNum);
    const amount = targetRow.get('Amount') || '0';

    if (action === 'app') {
      targetRow.set('Status', 'APPROVED');
      await targetRow.save();
      await ctx.editMessageText(`✅ Approved: ${amount} UZS`).catch(() => {});
      bot.telegram.sendMessage(targetRow.get('_StaffChatId'), `✅ Your request for ${amount} UZS was APPROVED.`).catch(() => {});
    } else {
      targetRow.set('Status', 'REJECTED');
      await targetRow.save();
      await ctx.editMessageText(`❌ Rejected: ${amount} UZS`).catch(() => {});
      bot.telegram.sendMessage(targetRow.get('_StaffChatId'), `❌ Your request for ${amount} UZS was REJECTED.`).catch(() => {});
    }
  } catch (e) { console.error(e); }
});

bot.launch();
