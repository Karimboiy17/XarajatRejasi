const { Telegraf, Markup } = require('telegraf');
const { JWT } = require('google-auth-library');
const { GoogleSpreadsheet } = require('google-spreadsheet');

// 1. Setup
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

// 2. Data Lists
const branches = ['📍 Integro', '📍 Chilonzor', '📍 Drujba'];
const categories = [
  'tugilgan kun uchun', 'printer rang', 'Printer tuzatish', 'remont-tuzatish', 
  'Hodimlar uchun dorilar', 'jihoz', 'Texnikalar', 'Transport', 'aromatizator', 
  'Internet', 'Telefon', 'of the month', 'Event', 'Reklama mahsulotlarini chiqarish', 
  'giftbox sovgalar', 'syomka xarajatlari', 'bozorlik xojalik', 'Suv va stakan', 
  'Konstovar', 'Plastik foizi', 'ofis xarajatlari', 'remont qurilish'
];

// 3. Start Command
bot.command(['start', 'new'], (ctx) => {
  userSessions[ctx.from.id] = { step: 'BRANCH' };
  ctx.reply('IELTS Zone Finance Bot 🎓\nSelect Branch:', Markup.keyboard(branches).oneTime().resize());
});

// 4. Main Conversation Logic
bot.on('text', async (ctx) => {
  const userId = ctx.from.id;
  const text = ctx.message.text;

  if (text === '❌ Cancel' || text === '/start') {
    userSessions[userId] = { step: 'BRANCH' };
    return ctx.reply('Reset. Select Branch:', Markup.keyboard(branches).resize());
  }

  const session = userSessions[userId];
  if (!session) return ctx.reply('Type /start to begin.');

  // STEP 1: BRANCH
  if (session.step === 'BRANCH') {
    if (branches.includes(text)) {
      session.branch = text;
      session.step = 'CATEGORY';
      return ctx.reply('Select Category:', Markup.keyboard([...categories, '❌ Cancel'], { columns: 2 }).resize());
    }
  }

  // STEP 2: CATEGORY
  if (session.step === 'CATEGORY') {
    if (categories.includes(text)) {
      session.category = text;
      session.step = 'AMOUNT';
      return ctx.reply(`Category: ${text}\n\nEnter Amount (UZS):`, Markup.keyboard(['❌ Cancel']).resize());
    }
  }

  // STEP 3: AMOUNT
  if (session.step === 'AMOUNT') {
    const amt = text.replace(/[^0-9]/g, '');
    if (!amt) return ctx.reply('Numbers only please.');
    session.amount = amt;
    session.step = 'CARD';
    return ctx.reply('Enter Card Number (where to send money):', Markup.keyboard(['❌ Cancel']).resize());
  }

  // STEP 4: CARD
  if (session.step === 'CARD') {
    session.card = text;
    session.step = 'DESCRIPTION';
    return ctx.reply('Enter Reason / Description:', Markup.keyboard(['❌ Cancel']).resize());
  }

  // STEP 5: FINAL SUBMIT
  if (session.step === 'DESCRIPTION') {
    session.description = text;
    ctx.reply('Saving... ⏳');
    
    try {
      await doc.loadInfo();
      const sheet = doc.sheetsByTitle['Pending_Expenses'];
      const row = await sheet.addRow({
        'Timestamp': new Date().toLocaleString(),
        'Branch': session.branch,
        'Staff Name': ctx.from.first_name,
        'Amount': session.amount,
        'Card Number': session.card,
        'Description': `[${session.category}] ${session.description}`,
        'Status': 'PENDING',
        '_StaffChatId': userId.toString()
      });

      await bot.telegram.sendMessage(MANAGER_ID, 
        `🏛 *New Request*\n📍 Branch: ${session.branch}\n👤 From: ${ctx.from.first_name}\n📂 Cat: ${session.category}\n💵 Amount: ${session.amount} UZS\n💳 Card: ${session.card}\n📝 Reason: ${session.description}`, 
        { 
          parse_mode: 'Markdown', 
          ...Markup.inlineKeyboard([
            [Markup.button.callback('✅ Approve', `app_${row.rowNumber}`)],
            [Markup.button.callback('❌ Reject', `rej_${row.rowNumber}`)]
          ]) 
        }
      );

      delete userSessions[userId];
      ctx.reply('✅ Sent to Manager!');
      return ctx.reply('Select Branch for next:', Markup.keyboard(branches).resize());
    } catch (e) {
      ctx.reply('Error saving. Check Sheet name.');
      console.error(e);
    }
  }
});

// 5. Manager Approval (Skipping Procurement)
bot.action(/^(app|rej)_(.+)$/, async (ctx) => {
  const [action, rowNum] = [ctx.match[1], ctx.match[2]];
  try {
    await doc.loadInfo();
    const sheet = doc.sheetsByTitle['Pending_Expenses'];
    const rows = await sheet.getRows();
    const targetRow = rows.find(r => r.rowNumber == rowNum);

    if (action === 'app') {
      targetRow.set('Status', 'APPROVED');
      await targetRow.save();
      ctx.editMessageText(`✅ Approved: ${targetRow.get('Amount')} UZS`);
      bot.telegram.sendMessage(targetRow.get('_StaffChatId'), `✅ Your request for ${targetRow.get('Amount')} was Approved.`);
    } else {
      targetRow.set('Status', 'REJECTED');
      await targetRow.save();
      ctx.editMessageText('❌ Rejected.');
      bot.telegram.sendMessage(targetRow.get('_StaffChatId'), `❌ Your request was Rejected.`);
    }
  } catch (e) { console.error(e); }
});

bot.launch();
