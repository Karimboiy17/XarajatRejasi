const { Telegraf, Markup } = require('telegraf');
const { JWT } = require('google-auth-library');
const { GoogleSpreadsheet } = require('google-spreadsheet');

const bot = new Telegraf(process.env.BOT_TOKEN);
const SHEET_ID = process.env.SHEET_ID;
const MANAGER_ID = process.env.MANAGER_CHAT_ID;
const PROC_ID = process.env.PROCUREMENT_CHAT_ID; // New Variable

const creds = JSON.parse(process.env.GCP_SERVICE_ACCOUNT);
const auth = new JWT({
  email: creds.client_email,
  key: creds.private_key,
  scopes: ['https://www.googleapis.com/auth/spreadsheets'],
});

const doc = new GoogleSpreadsheet(SHEET_ID, auth);
const userSessions = {};

const branches = ['📍 Integro', '📍 Chilonzor', '📍 Drujba'];
const categories = ['tugilgan kun uchun', 'printer rang', 'Printer tuzatish', 'remont-tuzatish', 'Hodimlar uchun dorilar', 'jihoz', 'Texnikalar', 'Transport', 'aromatizator', 'Internet', 'Telefon', 'of the month', 'Event', 'Reklama mahsulotlarini chiqarish', 'giftbox sovgalar', 'syomka xarajatlari', 'bozorlik xojalik', 'Suv va stakan', 'Konstovar', 'Plastik foizi', 'ofis xarajatlari', 'remont qurilish'];

bot.command(['start', 'new'], (ctx) => {
  userSessions[ctx.from.id] = { step: 'BRANCH' };
  ctx.reply('Select Branch:', Markup.keyboard([...branches, '❌ Cancel']).resize());
});

bot.on(['text', 'photo'], async (ctx) => {
  const userId = ctx.from.id;
  const text = ctx.message.text;
  if (text === '❌ Cancel' || text === '/start') {
    userSessions[userId] = { step: 'BRANCH' };
    return ctx.reply('Reset.', Markup.keyboard([...branches]).resize());
  }

  const session = userSessions[userId] || (userSessions[userId] = { step: 'BRANCH' });

  // 1. SELECT BRANCH
  if (session.step === 'BRANCH') {
    if (branches.includes(text)) {
      session.branch = text;
      session.step = 'CATEGORY';
      return ctx.reply(`Branch: ${text}\nSelect Category:`, Markup.keyboard([...categories, '❌ Cancel'], { columns: 2 }).resize());
    }
  }

  // 2. SELECT CATEGORY
  if (session.step === 'CATEGORY') {
    if (categories.includes(text)) {
      session.category = text;
      session.step = 'AMOUNT';
      return ctx.reply('Enter Amount (UZS):', Markup.keyboard(['❌ Cancel']).resize());
    }
  }

  // 3. AMOUNT
  if (session.step === 'AMOUNT') {
    session.amount = text.replace(/[^0-9]/g, '');
    session.step = 'CARD';
    return ctx.reply('Please send your Card Number (where to send money):');
  }

  // 4. CARD NUMBER
  if (session.step === 'CARD') {
    session.card = text;
    session.step = 'DESCRIPTION';
    return ctx.reply('Description / Reason:');
  }

  // 5. DESCRIPTION & SUBMIT TO MANAGER
  if (session.step === 'DESCRIPTION') {
    session.description = text;
    try {
      await doc.loadInfo();
      const sheet = doc.sheetsByTitle['Pending_Expenses'];
      const row = await sheet.addRow({
        'Timestamp': new Date().toLocaleString(),
        'Branch': session.branch,
        'Staff Name': ctx.from.first_name,
        'Amount': session.amount,
        'Card Number': session.card,
        'Description': `[${session.category}] ${text}`,
        'Status': 'WAITING MANAGER'
      });

      await bot.telegram.sendMessage(MANAGER_ID, 
        `🏛 *New Branch Request*\n📍 Branch: ${session.branch}\n👤 From: ${ctx.from.first_name}\n📂 Cat: ${session.category}\n💵 Amount: ${session.amount} UZS\n💳 Card: ${session.card}\n📝 Reason: ${text}`, 
        { parse_mode: 'Markdown', ...Markup.inlineKeyboard([[Markup.button.callback('✅ Approve for Procurement', `app_${row.rowNumber}`)], [Markup.button.callback('❌ Reject', `rej_${row.rowNumber}`)]]) }
      );

      ctx.reply('✅ Sent for Approval!');
      delete userSessions[userId];
    } catch (e) { ctx.reply('Sheet Error.'); }
  }
});

// --- ACTIONS FOR MANAGER AND PROCUREMENT ---
bot.action(/^(app|rej|done)_(.+)$/, async (ctx) => {
  const [action, rowNum] = [ctx.match[1], ctx.match[2]];
  await doc.loadInfo();
  const sheet = doc.sheetsByTitle['Pending_Expenses'];
  const rows = await sheet.getRows();
  const targetRow = rows.find(r => r.rowNumber == rowNum);

  // MANAGER APPROVAL -> SENDS TO PROCUREMENT
  if (action === 'app') {
    targetRow.set('Status', 'APPROVED BY MANAGER');
    await targetRow.save();
    
    await bot.telegram.sendMessage(PROC_ID, 
      `💸 *PAYMENT REQUIRED*\n📍 Branch: ${targetRow.get('Branch')}\n💵 Amount: ${targetRow.get('Amount')} UZS\n💳 Card: ${targetRow.get('Card Number')}\n👤 To: ${targetRow.get('Staff Name')}\n📝 Info: ${targetRow.get('Description')}`,
      { parse_mode: 'Markdown', ...Markup.inlineKeyboard([[Markup.button.callback('📤 I Sent the Money (Cheque)', `done_${rowNum}`)]]) }
    );
    
    ctx.editMessageText(`✅ Approved and sent to Procurement.`);
  }

  // PROCUREMENT COMPLETED
  if (action === 'done') {
    targetRow.set('Status', 'PAID / COMPLETED');
    await targetRow.save();
    ctx.editMessageText(`💰 Money Sent & Confirmed.`);
    bot.telegram.sendMessage(MANAGER_ID, `💳 Procurement just paid for [${targetRow.get('Branch')}] ${targetRow.get('Amount')} UZS.`);
  }

  if (action === 'rej') {
    targetRow.set('Status', 'REJECTED');
    await targetRow.save();
    ctx.editMessageText('❌ Request Rejected.');
  }
});

bot.launch();
