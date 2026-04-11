const { Telegraf, Markup } = require('telegraf');
const { JWT } = require('google-auth-library');
const { GoogleSpreadsheet } = require('google-spreadsheet');

const bot = new Telegraf(process.env.BOT_TOKEN);
const SHEET_ID = process.env.SHEET_ID;
const MANAGER_ID = process.env.MANAGER_CHAT_ID;

// Google Sheets Authentication
const creds = JSON.parse(process.env.GCP_SERVICE_ACCOUNT);
const auth = new JWT({
  email: creds.client_email,
  key: creds.private_key,
  scopes: ['https://www.googleapis.com/auth/spreadsheets'],
});

const doc = new GoogleSpreadsheet(SHEET_ID, auth);
const userSessions = {};

// --- SYSTEM CONSTANTS ---
const branches = ['📍 Integro', '📍 Drujba', '📍 Amir Temur', '📍 Central', '📍 Marketing'];
const categories = ['tugilgan kun uchun', 'printer rang', 'Printer tuzatish', 'remont-tuzatish', 'Hodimlar uchun dorilar', 'jihoz', 'Texnikalar', 'Transport', 'aromatizator', 'Internet', 'Telefon', 'of the month', 'Event', 'Reklama mahsulotlarini chiqarish', 'giftbox sovgalar', 'syomka xarajatlari', 'bozorlik xojalik', 'Suv va stakan', 'Konstovar', 'Plastik foizi', 'ofis xarajatlari', 'remont qurilish'];

// --- EXECUTIVE REPORT ---
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

    let msg = `📊 *IELTS Zone Executive Report*\n━━━━━━━━━━━━━━━\n`;
    msg += `💰 *Total Paid:* ${grandTotal.toLocaleString('en-US')} UZS\n\n`;
    
    msg += `🏢 *By Branch:*\n`;
    branches.forEach(b => {
      const amt = branchTotals[b] || 0;
      msg += `• ${b}: ${amt.toLocaleString('en-US')} UZS\n`;
    });

    msg += `\n💳 *By Payment Type:*\n`;
    msg += `• Karta: ${typeTotals['Karta'].toLocaleString('en-US')} UZS\n`;
    msg += `• Naqd: ${typeTotals['Naqd'].toLocaleString('en-US')} UZS\n`;
    msg += `• MCHJ: ${typeTotals['MCHJ'].toLocaleString('en-US')} UZS\n`;
    msg += `━━━━━━━━━━━━━━━`;

    ctx.reply(msg, { parse_mode: 'Markdown' });
  } catch (e) {
    console.error(e);
    ctx.reply('❌ Report crashed. Check Google Sheet connection.');
  }
});

// --- CHEQUE REPLY HANDLER (MULTI-PHOTO SUPPORT) ---
bot.on('photo', async (ctx) => {
  const reply = ctx.message.reply_to_message;
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
      
      // Format amount for manager's photo caption
      const formattedAmount = Number(row.get('Amount')).toLocaleString('en-US');

      await bot.telegram.sendPhoto(MANAGER_ID, ctx.message.photo[0].file_id, {
        caption: `📸 New Cheque (ID: ${rowNum})\n📍 Branch: ${row.get('Branch')}\n💵 Amount: ${formattedAmount} UZS\n📝 Desc: ${row.get('Description')}`
      });
    } catch (e) { 
      console.error(e); 
    }
  }
});

// --- NEW REQUEST WORKFLOW ---
bot.command(['start', 'new'], (ctx) => {
  userSessions[ctx.from.id] = { step: 'BRANCH' };
  ctx.reply('IELTS Zone Finance Bot 🎓\nFilialni tanlang:', Markup.keyboard(branches, { columns: 2 }).oneTime().resize());
});

bot.on('text', async (ctx) => {
  const userId = ctx.from.id.toString();
  const text = ctx.message.text;

  if (text === '❌ Cancel') {
    userSessions[userId] = { step: 'BRANCH' };
    return ctx.reply('Bekor qilindi. Filialni tanlang:', Markup.keyboard(branches, { columns: 2 }).resize());
  }

  const session = userSessions[userId];
  if (!session) return;

  if (session.step === 'BRANCH') {
    if (branches.includes(text)) {
      session.branch = text;
      session.step = 'CATEGORY';
      return ctx.reply('Kategoriyani tanlang:', Markup.keyboard([...categories, '❌ Cancel'], { columns: 2 }).resize());
    }
  }
  
  if (session.step === 'CATEGORY') {
    if (categories.includes(text)) {
      session.category = text;
      session.step = 'AMOUNT';
      return ctx.reply('Summani kiriting (Masalan: 100000 yoku 100,000):', Markup.keyboard(['❌ Cancel']).resize());
    }
  }
  
  if (session.step === 'AMOUNT') {
    session.amount = text.replace(/[^0-9]/g, '');
    session.step = 'DESCRIPTION';
    return ctx.reply('Xarajat sababi va tafsilotlari (Description):');
  }
  
  if (session.step === 'DESCRIPTION') {
    session.description = text;
    session.step = 'PAY_TYPE';
    return ctx.reply('To\'lov turi qanday bo\'ladi?', Markup.keyboard(['Karta', 'Naqd', 'MCHJ hisobi', '❌ Cancel']).resize());
  }
  
  if (session.step === 'PAY_TYPE') {
    session.payType = text;
    if (text === 'Naqd') {
        session.payDetail = 'N/A';
        return submitToManager(ctx, session);
    }
    session.step = 'PAY_DETAIL';
    return ctx.reply(text === 'Karta' ? 'Karta raqamini kiriting:' : 'Firma nomini kiriting:');
  }
  
  if (session.step === 'PAY_DETAIL') {
    session.payDetail = text;
    return submitToManager(ctx, session);
  }
});

// --- SUBMIT TO MANAGER LOGIC ---
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

    const formattedAmount = Number(session.amount).toLocaleString('en-US');

    await bot.telegram.sendMessage(MANAGER_ID, 
      `🏢 *Yangi So'rov*\n📍 Filial: ${session.branch}\n👤 Kimdan: ${ctx.from.first_name}\n💵 Summa: ${formattedAmount} UZS\n💳 To'lov: ${session.payType}\n📝 Detal: ${session.payDetail}\n💬 Sabab: ${session.description}`, 
      {
        parse_mode: 'Markdown',
        ...Markup.inlineKeyboard([
          [Markup.button.callback('✅ Tasdiqlash', `app_${row.rowNumber}`)], 
          [Markup.button.callback('❌ Rad etish', `rej_${row.rowNumber}`)]
        ])
      }
    );

    delete userSessions[userId];
    // THIS LINE FIXES THE KEYBOARD BUG
    ctx.reply('✅ Tasdiqlash uchun yuborildi!\n\nYangi so\'rov yaratish uchun filialni tanlang:', Markup.keyboard(branches, { columns: 2 }).resize());
  } catch (e) { 
    ctx.reply('❌ Xatolik yuz berdi. Iltimos qayta urining.'); 
    console.error(e); 
  }
}

// --- MANAGER INLINE BUTTON HANDLER ---
bot.action(/^(app|rej)_(.+)$/, async (ctx) => {
  const [action, rowNum] = [ctx.match[1], ctx.match[2]];
  
  if (action === 'app') {
    await doc.loadInfo();
    const sheet = doc.sheetsByTitle['Pending_Expenses'];
    const rows = await sheet.getRows();
    const row = rows.find(r => r.rowNumber == rowNum);
    const staffId = row.get('_StaffChatId');
    
    const formattedAmount = Number(row.get('Amount')).toLocaleString('en-US');
    
    // Sends the instruction back to the person who requested it
    await bot.telegram.sendMessage(staffId, `✅ To'lov tasdiqlandi!\nSumma: ${formattedAmount} UZS.\n\nUshbu xabarga **CHEK RASMINI REPLY QILIB** yuboring.\n\nID: ${rowNum}`, { parse_mode: 'Markdown' });
    
    // Updates your manager view with the correct title
    ctx.editMessageText(`💸 Tasdiqlandi. Procurement Managerdan chek kutilmoqda...`);
  } else {
    ctx.editMessageText('❌ So\'rov rad etildi.');
  }
});

bot.launch();

process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
