const { Telegraf, Markup } = require('telegraf');
const { JWT } = require('google-auth-library');
const { GoogleSpreadsheet } = require('google-spreadsheet');
const cron = require('node-cron'); // NEW: For daily reminders

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

// --- HELPER: GET FORMATTED DATE ---
function getTargetDate(daysToAdd) {
  const date = new Date();
  date.setDate(date.getDate() + daysToAdd);
  // Format as YYYY-MM-DD for easy searching
  return date.toISOString().split('T')[0]; 
}

// ==========================================
// 1. DAILY REMINDER SYSTEM (Runs at 9:00 AM)
// ==========================================
cron.schedule('0 9 * * *', async () => {
  try {
    await doc.loadInfo();
    const sheet = doc.sheetsByTitle['Pending_Expenses'];
    const rows = await sheet.getRows();
    const todayStr = getTargetDate(0);

    const dueToday = rows.filter(r => r.get('Status') === 'SCHEDULED' && r.get('Scheduled Date') === todayStr);

    for (let row of dueToday) {
      const formattedAmount = Number(row.get('Amount')).toLocaleString('en-US');
      const staffId = row.get('_StaffChatId');
      const rowNum = row.rowNumber;

      // Notify Procurement Manager
      await bot.telegram.sendMessage(MANAGER_ID, `⏰ *ESLATMA: Bugun to'lov qilinishi kerak!*\n\n📍 ${row.get('Branch')}\n💵 ${formattedAmount} UZS\n📝 ${row.get('Description')}\n👤 Xodim: ${row.get('Staff Name')}`, { parse_mode: 'Markdown' });

      // Notify Staff to send Cheque
      await bot.telegram.sendMessage(staffId, `⏰ *ESLATMA: To'lov kuni keldi!*\nSizning ${formattedAmount} UZS so'rovingiz bugun to'lanishi rejalashtirilgan.\n\nUshbu xabarga **CHEK RASMINI REPLY QILIB** yuboring.\n\nID: ${rowNum}`, { parse_mode: 'Markdown' });
      
      // We leave status as SCHEDULED until they actually send the photo (then it becomes PAID)
    }
  } catch (e) { console.error("Cron Error:", e); }
}, {
  scheduled: true,
  timezone: "Asia/Tashkent"
});


// ==========================================
// 2. MANAGER COMMANDS (/report & /waiting)
// ==========================================
bot.command('waiting', async (ctx) => {
  if (ctx.from.id.toString() !== MANAGER_ID) return;
  try {
    await doc.loadInfo();
    const sheet = doc.sheetsByTitle['Pending_Expenses'];
    const rows = await sheet.getRows();
    
    const waiting = rows.filter(r => r.get('Status') === 'SCHEDULED');
    
    if (waiting.length === 0) return ctx.reply("✅ Hozirda kutilayotgan (Scheduled) to'lovlar yo'q.");

    let msg = `⏳ *Kutilayotgan To'lovlar (Waiting Expenses)*\n━━━━━━━━━━━━━━━\n`;
    let totalWait = 0;

    waiting.forEach(r => {
      const amt = parseInt(r.get('Amount') || 0);
      totalWait += amt;
      msg += `🗓 Sana: ${r.get('Scheduled Date')}\n📍 ${r.get('Branch')} - ${amt.toLocaleString('en-US')} UZS\n📝 ${r.get('Description')}\n\n`;
    });

    msg += `━━━━━━━━━━━━━━━\n💰 *Jami Kutilayotgan:* ${totalWait.toLocaleString('en-US')} UZS`;
    ctx.reply(msg, { parse_mode: 'Markdown' });
  } catch (e) { ctx.reply('❌ Error fetching waiting list.'); }
});

bot.command('report', async (ctx) => {
  // ... [YOUR EXACT EXISTING REPORT CODE REMAINS HERE] ...
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

    let msg = `📊 *IELTS Zone Executive Report*\n━━━━━━━━━━━━━━━\n💰 *Total Paid:* ${grandTotal.toLocaleString('en-US')} UZS\n\n🏢 *By Branch:*\n`;
    branches.forEach(b => { msg += `• ${b}: ${(branchTotals[b] || 0).toLocaleString('en-US')} UZS\n`; });
    msg += `\n💳 *By Payment Type:*\n• Karta: ${typeTotals['Karta'].toLocaleString('en-US')} UZS\n• Naqd: ${typeTotals['Naqd'].toLocaleString('en-US')} UZS\n• MCHJ: ${typeTotals['MCHJ'].toLocaleString('en-US')} UZS\n━━━━━━━━━━━━━━━`;
    ctx.reply(msg, { parse_mode: 'Markdown' });
  } catch (e) { console.error(e); ctx.reply('❌ Report crashed.'); }
});


// ==========================================
// 3. PHOTO / CHEQUE HANDLER
// ==========================================
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
        row.set('Status', 'PAID'); // Changes from PENDING or SCHEDULED to PAID
        await row.save();
        ctx.reply('✅ Cheque received! Status updated to PAID.');
      }
      
      const formattedAmount = Number(row.get('Amount')).toLocaleString('en-US');
      await bot.telegram.sendPhoto(MANAGER_ID, ctx.message.photo[0].file_id, {
        caption: `📸 New Cheque (ID: ${rowNum})\n📍 Branch: ${row.get('Branch')}\n💵 Amount: ${formattedAmount} UZS\n📝 Desc: ${row.get('Description')}`
      });
    } catch (e) { console.error(e); }
  }
});


// ==========================================
// 4. NEW REQUEST WORKFLOW (Staff Side)
// ==========================================
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
      return ctx.reply('Summani kiriting (Masalan: 100000):', Markup.keyboard(['❌ Cancel']).resize());
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
      '_StaffChatId': userId,
      'Scheduled Date': '' // Empty by default
    });

    const formattedAmount = Number(session.amount).toLocaleString('en-US');

    await bot.telegram.sendMessage(MANAGER_ID, 
      `🏢 *Yangi So'rov*\n📍 Filial: ${session.branch}\n👤 Kimdan: ${ctx.from.first_name}\n💵 Summa: ${formattedAmount} UZS\n💳 To'lov: ${session.payType}\n📝 Detal: ${session.payDetail}\n💬 Sabab: ${session.description}`, 
      {
        parse_mode: 'Markdown',
        ...Markup.inlineKeyboard([
          [Markup.button.callback('✅ Tasdiqlash (Qaror qabul qilish)', `decide_${row.rowNumber}`)], 
          [Markup.button.callback('❌ Rad etish', `rej_${row.rowNumber}`)]
        ])
      }
    );

    delete userSessions[userId];
    ctx.reply('✅ Procurement Managerga tasdiqlash uchun yuborildi!\n\nYangi so\'rov yaratish uchun filialni tanlang:', Markup.keyboard(branches, { columns: 2 }).resize());
  } catch (e) { 
    ctx.reply('❌ Xatolik yuz berdi.'); 
    console.error(e); 
  }
}

// ==========================================
// 5. MANAGER APPROVAL & SCHEDULING LOGIC
// ==========================================
bot.action(/^(decide|paynow|sched|rej)_(.+)(?:_(.+))?$/, async (ctx) => {
  const action = ctx.match[1];
  const rowNum = ctx.match[2];
  const schedDays = ctx.match[3]; // Used for scheduling dates

  try {
    await doc.loadInfo();
    const sheet = doc.sheetsByTitle['Pending_Expenses'];
    const rows = await sheet.getRows();
    const row = rows.find(r => r.rowNumber == rowNum);
    const staffId = row.get('_StaffChatId');
    const formattedAmount = Number(row.get('Amount')).toLocaleString('en-US');

    // STEP 1: Manager clicked "Approve" -> Ask When
    if (action === 'decide') {
      await ctx.editMessageText(`💸 So'rov ko'rib chiqilmoqda. Qachon to'laysiz?`, {
        ...Markup.inlineKeyboard([
          [Markup.button.callback('✅ Hozir (Rasmni so\'rash)', `paynow_${rowNum}`)],
          [
            Markup.button.callback('🗓 Ertaga', `sched_${rowNum}_1`),
            Markup.button.callback('🗓 3 kun', `sched_${rowNum}_3`),
            Markup.button.callback('🗓 1 hafta', `sched_${rowNum}_7`)
          ]
        ])
      });
    } 
    
    // STEP 2A: Pay Now
    else if (action === 'paynow') {
      await bot.telegram.sendMessage(staffId, `✅ To'lov tasdiqlandi!\nSumma: ${formattedAmount} UZS.\n\nUshbu xabarga **CHEK RASMINI REPLY QILIB** yuboring.\n\nID: ${rowNum}`, { parse_mode: 'Markdown' });
      await ctx.editMessageText(`💸 Hozir to'lash tasdiqlandi. Filial rahbaridan chek kutilmoqda...`);
    } 
    
    // STEP 2B: Pay Later (Scheduled)
    else if (action === 'sched') {
      const targetDate = getTargetDate(parseInt(schedDays));
      
      row.set('Status', 'SCHEDULED');
      row.set('Scheduled Date', targetDate);
      await row.save();

      // Notify Staff that it's approved but delayed
      await bot.telegram.sendMessage(staffId, `⏳ *To'lov Rejalashtirildi!*\nSizning ${formattedAmount} UZS so'rovingiz Procurement Manager tomonidan tasdiqlandi.\nTo'lov sanasi: *${targetDate}*\n\nO'sha kuni sizga chek yuborish uchun eslatma keladi.`, { parse_mode: 'Markdown' });
      
      // Update Manager's screen
      await ctx.editMessageText(`🗓 To'lov ${targetDate} sanasiga rejalashtirildi. Eslatma o'rnatildi.`);
    } 
    
    // STEP 3: Reject
    else if (action === 'rej') {
      row.set('Status', 'REJECTED');
      await row.save();
      await bot.telegram.sendMessage(staffId, `❌ Sizning ${formattedAmount} UZS so'rovingiz Procurement Manager tomonidan rad etildi.`);
      await ctx.editMessageText('❌ So\'rov rad etildi va yopildi.');
    }
  } catch (e) {
    console.error("Action error:", e);
    ctx.reply("❌ Amalni bajarishda xatolik yuz berdi.");
  }
});

bot.launch();

process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
