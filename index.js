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

const branches = ['📍 Integro', '📍 Drujba', '📍 Amir Temur', '📍 Central', '📍 Marketing'];

// Removed 'naqd' from here
const categories = ['tugilgan kun uchun', 'printer rang', 'Printer tuzatish', 'remont-tuzatish', 'Hodimlar uchun dorilar', 'jihoz', 'Texnikalar', 'Transport', 'aromatizator', 'Internet', 'Telefon', 'of the month', 'Event', 'Reklama mahsulotlarini chiqarish', 'giftbox sovgalar', 'syomka xarajatlari', 'bozorlik xojalik', 'Suv va stakan', 'Konstovar', 'Plastik foizi', 'ofis xarajatlari', 'remont qurilish'];

bot.command('report', async (ctx) => {
  if (ctx.from.id.toString() !== MANAGER_ID) return;
  try {
    await doc.loadInfo();
    const sheet = doc.sheetsByTitle['Pending_Expenses'];
    const rows = await sheet.getRows();
    const paid = rows.filter(r => r.get('Status') && r.get('Status').toString().toUpperCase() === 'PAID');
    
    let branchTotals = {};
    let typeTotals = { 'Karta': 0, 'Naqd': 0, 'MCHJ': 0 };
    let grandTotal = 0;

    paid.forEach(r => {
      const b = r.get('Branch') || '📍 Unknown';
      const t = r.get('Payment Type') || '';
      const rawAmt = r.get('Amount') ? r.get('Amount').toString().replace(/[^0-9]/g, '') : '0';
      const val = parseInt(rawAmt) || 0;
      branchTotals[b] = (branchTotals[b] || 0) + val;
      if (t.includes('Karta')) typeTotals['Karta'] += val;
      else if (t.includes('Naqd')) typeTotals['Naqd'] += val;
      else if (t.includes('MCHJ')) typeTotals['MCHJ'] += val;
      grandTotal += val;
    });

    let msg = `📊 *IELTS Zone Final Report*\n━━━━━━━━━━━━━━━\n`;
    msg += `💰 *Jami To'langan:* ${grandTotal.toLocaleString()} UZS\n\n`;
    msg += `🏢 *Filiallar:* \n`;
    branches.forEach(b => msg += `• ${b}: ${(branchTotals[b] || 0).toLocaleString()} UZS\n`);
    msg += `\n💳 *To'lov turi:* \n• Karta: ${typeTotals['Karta'].toLocaleString()}\n• Naqd: ${typeTotals['Naqd'].toLocaleString()}\n• MCHJ: ${typeTotals['MCHJ'].toLocaleString()}\n━━━━━━━━━━━━━━━`;
    ctx.reply(msg, { parse_mode: 'Markdown' });
  } catch (e) { ctx.reply('❌ Report error.'); }
});

bot.command(['start', 'new'], (ctx) => {
  userSessions[ctx.from.id] = { step: 'BRANCH' };
  ctx.reply('Filialni tanlang:', Markup.keyboard(branches, { columns: 2 }).oneTime().resize());
});

bot.on(['text', 'photo'], async (ctx) => {
  const userId = ctx.from.id.toString();
  const text = ctx.message.text;

  if (userId === MANAGER_ID && managerSessions[userId] && ctx.message.photo) {
    const { rowNum, staffId } = managerSessions[userId];
    try {
      await doc.loadInfo();
      const sheet = doc.sheetsByTitle['Pending_Expenses'];
      const rows = await sheet.getRows();
      const row = rows.find(r => r.rowNumber == rowNum);
      row.set('Status', 'PAID');
      await row.save();
      await bot.telegram.sendPhoto(staffId, ctx.message.photo[0].file_id, { caption: `✅ To'lov tasdiqlandi: ${row.get('Amount')} UZS` });
      ctx.reply('💰 Status: PAID.');
      delete managerSessions[userId];
    } catch (e) { ctx.reply('Xatolik!'); }
    return;
  }

  if (text === '❌ Cancel' || text === '/start') {
    userSessions[userId] = { step: 'BRANCH' };
    return ctx.reply('Tanlang:', Markup.keyboard(branches, { columns: 2 }).resize());
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
    if (text === 'Karta') {
      session.payType = 'Karta';
      session.step = 'PAY_DETAIL';
      return ctx.reply('Karta raqami:');
    } else if (text === 'MCHJ hisobi') {
      session.payType = 'MCHJ';
      session.step = 'PAY_DETAIL';
      return ctx.reply('Firma nomi:');
    } else if (text === 'Naqd') {
      session.payType = 'Naqd';
      session.payDetail = 'N/A';
      return submitToManager(ctx, session);
    }
  }
  if (session.step === 'PAY_DETAIL') {
    session.payDetail = text;
    return submitToManager(ctx, session);
  }
});

async function submitToManager(ctx, session) {
  const userId = ctx.from.id.toString();
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
      '_StaffChatId': userId
    });
    await bot.telegram.sendMessage(MANAGER_ID, `🏢 *So'rov*\n📍 ${session.branch}\n💵 ${session.amount}\n💳 ${session.payType}\n📝 ${session.payDetail}\n💬 ${session.description}`, {
      parse_mode: 'Markdown',
      ...Markup.inlineKeyboard([[Markup.button.callback('✅ Tasdiqlash', `app_${row.rowNumber}`)], [Markup.button.callback('❌ Rad etish', `rej_${row.rowNumber}`)]])
    });
    ctx.reply('✅ Yuborildi!');
    delete userSessions[userId];
  } catch (e) { ctx.reply('Xato!'); }
}

bot.action(/^(app|rej)_(.+)$/, async (ctx) => {
  const [action, rowNum] = [ctx.match[1], ctx.match[2]];
  if (action === 'app') {
    await doc.loadInfo();
    const sheet = doc.sheetsByTitle['Pending_Expenses'];
    const rows = await sheet.getRows();
    const row = rows.find(r => r.rowNumber == rowNum);
    managerSessions[MANAGER_ID] = { rowNum, staffId: row.get('_StaffChatId') };
    ctx.editMessageText(`📸 Chek rasmini yuboring (${row.get('Amount')} UZS):`);
  } else { ctx.editMessageText('❌ Rad etildi.'); }
});

bot.launch();
