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
const managerSessions = {};

const branches = ['📍 Integro', '📍 Chilonzor', '📍 Drujba'];
const categories = ['tugilgan kun uchun', 'printer rang', 'Printer tuzatish', 'remont-tuzatish', 'Hodimlar uchun dorilar', 'jihoz', 'Texnikalar', 'Transport', 'aromatizator', 'Internet', 'Telefon', 'of the month', 'Event', 'Reklama mahsulotlarini chiqarish', 'giftbox sovgalar', 'syomka xarajatlari', 'bozorlik xojalik', 'Suv va stakan', 'Konstovar', 'Plastik foizi', 'ofis xarajatlari', 'remont qurilish'];

// --- ANALYTICS REPORT ---
bot.command('report', async (ctx) => {
  if (ctx.from.id.toString() !== MANAGER_ID) return;
  try {
    await doc.loadInfo();
    const sheet = doc.sheetsByTitle['Pending_Expenses'];
    const rows = await sheet.getRows();
    const paid = rows.filter(r => r.get('Status') === 'PAID');
    
    let branchTotals = {};
    let total = 0;

    paid.forEach(r => {
      const b = r.get('Branch') || 'Unknown';
      const a = Number(r.get('Amount') || 0);
      branchTotals[b] = (branchTotals[b] || 0) + a;
      total += a;
    });

    let msg = `📊 *IELTS Zone Final Report*\n\n✅ Total Paid: *${total.toLocaleString()} UZS*\n\n`;
    for (const [name, amt] of Object.entries(branchTotals)) {
      msg += `${name}: ${amt.toLocaleString()} UZS\n`;
    }
    ctx.reply(msg, { parse_mode: 'Markdown' });
  } catch (e) { ctx.reply('Report Error.'); console.error(e); }
});

bot.command(['start', 'new'], (ctx) => {
  userSessions[ctx.from.id] = { step: 'BRANCH' };
  ctx.reply('IELTS Zone Finance Bot 🎓\nSelect Branch:', Markup.keyboard(branches).oneTime().resize());
});

bot.on(['text', 'photo'], async (ctx) => {
  const userId = ctx.from.id.toString();
  const text = ctx.message.text;

  // Manager Cheque Logic
  if (userId === MANAGER_ID && managerSessions[userId]) {
    if (ctx.message.photo) {
      const { rowNum, staffId } = managerSessions[userId];
      try {
        await doc.loadInfo();
        const sheet = doc.sheetsByTitle['Pending_Expenses'];
        const rows = await sheet.getRows();
        const row = rows.find(r => r.rowNumber == rowNum);
        row.set('Status', 'PAID');
        await row.save();
        await bot.telegram.sendPhoto(staffId, ctx.message.photo[0].file_id, { caption: `✅ Payment sent: ${row.get('Amount')} UZS` });
        ctx.reply('💰 Success! Cheque sent to staff.');
        delete managerSessions[userId];
      } catch (e) { ctx.reply('Error.'); }
      return;
    }
  }

  if (text === '❌ Cancel' || text === '/start') {
    userSessions[userId] = { step: 'BRANCH' };
    return ctx.reply('Select Branch:', Markup.keyboard(branches).resize());
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
      return ctx.reply('Enter Amount (UZS):', Markup.keyboard(['❌ Cancel']).resize());
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
    return ctx.reply('Reason:');
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
      await bot.telegram.sendMessage(MANAGER_ID, `🏛 *New Request*\n📍 ${session.branch}\n💵 ${session.amount} UZS\n💳 ${session.card}\n📝 ${text}`, {
        parse_mode: 'Markdown',
        ...Markup.inlineKeyboard([[Markup.button.callback('✅ Approve & Send Cheque', `app_${row.rowNumber}`)], [Markup.button.callback('❌ Reject', `rej_${row.rowNumber}`)]])
      });
      ctx.reply('✅ Sent!');
      delete userSessions[userId];
      return ctx.reply('Next?', Markup.keyboard(branches).resize());
    } catch (e) { ctx.reply('Error.'); }
  }
});

bot.action(/^(app|rej)_(.+)$/, async (ctx) => {
  const [action, rowNum] = [ctx.match[1], ctx.match[2]];
  if (action === 'app') {
    await doc.loadInfo();
    const sheet = doc.sheetsByTitle['Pending_Expenses'];
    const rows = await sheet.getRows();
    const row = rows.find(r => r.rowNumber == rowNum);
    managerSessions[MANAGER_ID] = { rowNum, staffId: row.get('_StaffChatId') };
    ctx.editMessageText(`💸 Send the Cheque photo for ${row.get('Amount')} UZS:`);
  } else {
    ctx.editMessageText('❌ Rejected.');
  }
});

bot.launch();
