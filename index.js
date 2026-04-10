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
const managerSessions = {}; // To track when you are sending a cheque

const branches = ['📍 Integro', '📍 Chilonzor', '📍 Drujba'];
const categories = ['tugilgan kun uchun', 'printer rang', 'Printer tuzatish', 'remont-tuzatish', 'Hodimlar uchun dorilar', 'jihoz', 'Texnikalar', 'Transport', 'aromatizator', 'Internet', 'Telefon', 'of the month', 'Event', 'Reklama mahsulotlarini chiqarish', 'giftbox sovgalar', 'syomka xarajatlari', 'bozorlik xojalik', 'Suv va stakan', 'Konstovar', 'Plastik foizi', 'ofis xarajatlari', 'remont qurilish'];

bot.command(['start', 'new'], (ctx) => {
  userSessions[ctx.from.id] = { step: 'BRANCH' };
  ctx.reply('IELTS Zone Finance Bot 🎓\nSelect Branch:', Markup.keyboard(branches).oneTime().resize());
});

// --- MAIN MESSAGE LOGIC ---
bot.on(['text', 'photo'], async (ctx) => {
  const userId = ctx.from.id.toString();
  const text = ctx.message.text;

  // 1. Logic for Manager sending a Cheque
  if (userId === MANAGER_ID && managerSessions[userId]) {
    if (ctx.message.photo) {
      const rowNum = managerSessions[userId].rowNum;
      const staffId = managerSessions[userId].staffId;

      try {
        await doc.loadInfo();
        const sheet = doc.sheetsByTitle['Pending_Expenses'];
        const rows = await sheet.getRows();
        const targetRow = rows.find(r => r.rowNumber == rowNum);

        targetRow.set('Status', 'PAID');
        await targetRow.save();

        // Send Cheque to Staff
        await bot.telegram.sendPhoto(staffId, ctx.message.photo[0].file_id, {
          caption: `✅ Your payment has been sent! Total: ${targetRow.get('Amount')} UZS`
        });

        ctx.reply(`💰 Payment confirmed and cheque sent to staff.`);
        delete managerSessions[userId];
      } catch (e) { ctx.reply('Error updating sheet.'); }
      return;
    }
  }

  // 2. Logic for Staff making requests
  if (text === '❌ Cancel') {
    userSessions[userId] = { step: 'BRANCH' };
    return ctx.reply('Reset.', Markup.keyboard(branches).resize());
  }

  const session = userSessions[userId];
  if (!session) return;

  if (session.step === 'BRANCH') {
    if (branches.includes(text)) {
      session.branch = text;
      session.step = 'CATEGORY';
      return ctx.reply('Select Category:', Markup.keyboard([...categories, '❌ Cancel'], { columns: 2 }).resize());
    }
  }

  if (session.step === 'CATEGORY') {
    if (categories.includes(text)) {
      session.category = text;
      session.step = 'AMOUNT';
      return ctx.reply(`Amount for ${text}:`, Markup.keyboard(['❌ Cancel']).resize());
    }
  }

  if (session.step === 'AMOUNT') {
    session.amount = text.replace(/[^0-9]/g, '');
    session.step = 'CARD';
    return ctx.reply('Enter Card Number:');
  }

  if (session.step === 'CARD') {
    session.card = text;
    session.step = 'DESCRIPTION';
    return ctx.reply('Enter Reason:');
  }

  if (session.step === 'DESCRIPTION') {
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
        'Status': 'PENDING',
        '_StaffChatId': userId
      });

      await bot.telegram.sendMessage(MANAGER_ID, 
        `🏛 *New Request*\n📍 Branch: ${session.branch}\n💵 Amount: ${session.amount} UZS\n💳 Card: ${session.card}\n📝 Reason: ${text}`, 
        { parse_mode: 'Markdown', ...Markup.inlineKeyboard([[Markup.button.callback('✅ Approve & Send Cheque', `app_${row.rowNumber}`)], [Markup.button.callback('❌ Reject', `rej_${row.rowNumber}`)]]) }
      );

      ctx.reply('✅ Sent for approval.');
      delete userSessions[userId];
    } catch (e) { ctx.reply('Error.'); }
  }
});

// --- APPROVE BUTTON ---
bot.action(/^(app|rej)_(.+)$/, async (ctx) => {
  const [action, rowNum] = [ctx.match[1], ctx.match[2]];
  await doc.loadInfo();
  const sheet = doc.sheetsByTitle['Pending_Expenses'];
  const rows = await sheet.getRows();
  const targetRow = rows.find(r => r.rowNumber == rowNum);

  if (action === 'app') {
    managerSessions[MANAGER_ID] = { 
        rowNum: rowNum, 
        staffId: targetRow.get('_StaffChatId') 
    };
    ctx.editMessageText(`💸 You approved ${targetRow.get('Amount')} UZS.\n\nNow, please **send the payment cheque (Photo)** here:`);
  } else {
    targetRow.set('Status', 'REJECTED');
    await targetRow.save();
    ctx.editMessageText('❌ Rejected.');
  }
});

bot.launch();
