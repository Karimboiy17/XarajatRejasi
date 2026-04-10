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

const branches = ['📍 Integro', '📍 Drujba', '📍 Amir Temur', '📍 Central', '📍 Marketing'];
const categories = ['tugilgan kun uchun', 'printer rang', 'Printer tuzatish', 'remont-tuzatish', 'Hodimlar uchun dorilar', 'jihoz', 'Texnikalar', 'Transport', 'aromatizator', 'Internet', 'Telefon', 'of the month', 'Event', 'Reklama mahsulotlarini chiqarish', 'giftbox sovgalar', 'syomka xarajatlari', 'bozorlik xojalik', 'Suv va stakan', 'Konstovar', 'Plastik foizi', 'ofis xarajatlari', 'remont qurilish'];

// --- REPORT COMMAND ---
bot.command('report', async (ctx) => {
  if (ctx.from.id.toString() !== MANAGER_ID) return;
  try {
    await doc.loadInfo();
    const sheet = doc.sheetsByTitle['Pending_Expenses'];
    const rows = await sheet.getRows();
    const paid = rows.filter(r => r.get('Status') && r.get('Status').toString().toUpperCase() === 'PAID');
    let total = 0;
    paid.forEach(r => {
      const raw = r.get('Amount') ? r.get('Amount').toString().replace(/[^0-9]/g, '') : '0';
      total += parseInt(raw) || 0;
    });
    ctx.reply(`📊 *IELTS Zone Report*\nTotal Paid: *${total.toLocaleString()} UZS*`, { parse_mode: 'Markdown' });
  } catch (e) { ctx.reply('❌ Error'); }
});

bot.command(['start', 'new'], (ctx) => {
  userSessions[ctx.from.id] = { step: 'BRANCH' };
  ctx.reply('Filialni tanlang:', Markup.keyboard(branches, { columns: 2 }).oneTime().resize());
});

// --- HANDLE CHEQUE REPLIES ---
bot.on('photo', async (ctx) => {
  const reply = ctx.message.reply_to_message;
  // Check if staff is replying to an approval message
  if (reply && reply.text && reply.text.includes('ID:')) {
    const rowNum = reply.text.split('ID:')[1].trim();
    try {
      await doc.loadInfo();
      const sheet = doc.sheetsByTitle['Pending_Expenses'];
      const rows = await sheet.getRows();
      const row = rows.find(r => r.rowNumber == rowNum);
      
      if (row.get('Status') !== 'PAID') {
        row.set('Status', 'PAID');
        await row.save();
        ctx.reply('✅ Cheque received! Status updated to PAID.');
      }
      
      // Forward the photo to the Manager
      await bot.telegram.sendPhoto(MANAGER_ID, ctx.message.photo[0].file_id, {
        caption: `📸 Cheque for Request #${rowNum}\nBranch: ${row.get('Branch')}\nAmount: ${row.get('Amount')}`
      });
    } catch (e) { console.error(e); }
  }
});

bot.on('text', async (ctx) => {
  const userId = ctx.from.id.toString();
  const text = ctx.message.text;

  if (text === '❌ Cancel') {
    userSessions[userId] = { step: 'BRANCH' };
    return ctx.reply('Cancelled.', Markup.keyboard(branches, { columns: 2 }).resize());
  }

  const session = userSessions[userId];
  if (!session) return;

  if (session.step === 'BRANCH') {
    if (branches.includes(text)) {
      session.branch = text;
      session.step = 'CATEGORY';
      return ctx.reply('Kategoriya:', Markup.keyboard([...categories, '❌ Cancel'], { columns: 2 }).resize());
    }
  }
  if (session.step === 'CATEGORY') {
    if (categories.includes(text)) {
      session.category = text;
      session.step = 'AMOUNT';
      return ctx.reply('Summa:', Markup.keyboard(['❌ Cancel']).resize());
    }
  }
  if (session.step === 'AMOUNT') {
    session.amount = text.replace(/[^0-9]/g, '');
    session.step = 'DESCRIPTION';
    return ctx.reply('Tavsif (Description):');
  }
  if (session.step === 'DESCRIPTION') {
    session.description = text;
    session.step = 'PAY_TYPE';
    return ctx.reply('To\'lov turi:', Markup.keyboard(['Karta', 'Naqd', 'MCHJ hisobi', '❌ Cancel']).resize());
  }
  if (session.step === 'PAY_TYPE') {
    session.payType = text;
    if (text === 'Naqd') {
        session.payDetail = 'N/A';
        return submitToManager(ctx, session);
    }
    session.step = 'PAY_DETAIL';
    return ctx.reply(text === 'Karta' ? 'Karta raqami:' : 'Firma nomi:');
  }
  if (session.step === 'PAY_DETAIL') {
    session.payDetail = text;
    return submitToManager(ctx, session);
  }
});

async function submitToManager(ctx, session) {
  try {
    await doc.loadInfo();
    const sheet = doc.sheetsByTitle['Pending_Expenses'];
    const row = await sheet.addRow({
      'Timestamp': new Date().toLocaleString(),
      'Branch': session.branch,
      'Staff Name': ctx.from.first_name,
      'Amount': session.amount,
      'Payment Type': session.payType,
      'Payment Detail': session.payDetail,
      'Description': `[${session.category}] ${session.description}`,
      'Status': 'PENDING',
      '_StaffChatId': ctx.from.id.toString()
    });

    await bot.telegram.sendMessage(MANAGER_ID, `🏢 *Request*\n📍 ${session.branch}\n💵 ${session.amount}\n💳 ${session.payType}\n📝 ${session.payDetail}\n💬 ${session.description}`, {
      parse_mode: 'Markdown',
      ...Markup.inlineKeyboard([[Markup.button.callback('✅ Approve', `app_${row.rowNumber}`)], [Markup.button.callback('❌ Reject', `rej_${row.rowNumber}`)]])
    });
    delete userSessions[ctx.from.id];
    ctx.reply('✅ Sent for approval!');
  } catch (e) { ctx.reply('Error!'); }
}

bot.action(/^(app|rej)_(.+)$/, async (ctx) => {
  const [action, rowNum] = [ctx.match[1], ctx.match[2]];
  if (action === 'app') {
    await doc.loadInfo();
    const sheet = doc.sheetsByTitle['Pending_Expenses'];
    const rows = await sheet.getRows();
    const row = rows.find(r => r.rowNumber == rowNum);
    const staffId = row.get('_StaffChatId');
    
    // Important: The text must contain "ID:" for the reply logic to work
    await bot.telegram.sendMessage(staffId, `✅ Approved! Summa: ${row.get('Amount')} UZS.\n\nReply to THIS message with your cheque photo(s).\n\nID: ${rowNum}`);
    ctx.editMessageText('💸 Approved. Waiting for staff to reply with cheque.');
  } else {
    ctx.editMessageText('❌ Rejected.');
  }
});

bot.launch();
