const { Telegraf, Markup } = require('telegraf');
const { JWT } = require('google-auth-library');
const { GoogleSpreadsheet } = require('google-spreadsheet');
const cron = require('node-cron');

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

const branches = ['📍 Integro', '📍 Drujba', '📍 Amir Temur', '📍 Central', '📍 Marketing'];
const categories = ['tugilgan kun uchun', 'printer rang', 'Printer tuzatish', 'remont-tuzatish', 'Hodimlar uchun dorilar', 'jihoz', 'Texnikalar', 'Transport', 'aromatizator', 'Internet', 'Telefon', 'of the month', 'Event', 'Reklama mahsulotlarini chiqarish', 'giftbox sovgalar', 'syomka xarajatlari', 'bozorlik xojalik', 'Suv va stakan', 'Konstovar', 'Plastik foizi', 'ofis xarajatlari', 'remont qurilish'];
const priorities = ["🔴 O'ta muhim (Bugun)", "🟡 O'rtacha (Ertaga)", "🔵 Normal (Shu hafta)", "🟢 Shoshilinch emas (Shu oy)"];

// --- DATE ENGINE ---
function getScheduledDateStr(type, param) {
  const now = new Date();
  const tashkentTime = new Date(now.getTime() + (5 * 60 * 60 * 1000));
  if (type === 'D') { 
    const currentDay = tashkentTime.getUTCDay(); 
    let distance = param - currentDay;
    if (distance <= 0) distance += 7; 
    tashkentTime.setUTCDate(tashkentTime.getUTCDate() + distance);
  } else if (type === 'F') tashkentTime.setUTCDate(tashkentTime.getUTCDate() + param);
  else if (type === 'M') tashkentTime.setUTCMonth(tashkentTime.getUTCMonth() + 1);
  return tashkentTime.toISOString().split('T')[0];
}

function getTodayStr() {
  return new Date(new Date().getTime() + (5 * 60 * 60 * 1000)).toISOString().split('T')[0];
}

// --- BUDGET ENGINE ---
async function getBudgetWarning(branch, amountStr) {
  try {
    const budgetSheet = doc.sheetsByTitle['Budgets'];
    if (!budgetSheet) return ''; 
    const budgetRows = await budgetSheet.getRows();
    const branchBudgetRow = budgetRows.find(r => r.get('Branch') === branch);
    if (!branchBudgetRow) return '';
    
    const limit = parseInt(branchBudgetRow.get('Monthly Limit').replace(/[^0-9]/g, '')) || 0;
    const expenseSheet = doc.sheetsByTitle['Pending_Expenses'];
    const expenseRows = await expenseSheet.getRows();
    
    const currentMonth = new Date().getMonth();
    const currentYear = new Date().getFullYear();
    let spent = 0;
    
    expenseRows.forEach(r => {
      const status = r.get('Status');
      if (r.get('Branch') === branch && (status === 'PAID' || status === 'SCHEDULED' || status === 'CHEQUE_SENT')) {
        const rowDate = new Date(r.get('Timestamp'));
        if (rowDate.getMonth() === currentMonth && rowDate.getFullYear() === currentYear) {
          spent += parseInt(r.get('Amount') ? r.get('Amount').toString().replace(/[^0-9]/g, '') : '0') || 0;
        }
      }
    });
    
    const requested = parseInt(amountStr);
    if (spent + requested > limit) {
       return `\n\n⚠️ *BUDJETDAN OSHISH XAVFI!*\n📉 Oylik Budjet: ${limit.toLocaleString('en-US')} UZS\n💸 Ishlatildi/Rejada: ${spent.toLocaleString('en-US')} UZS\n📊 So'rov qabul qilinsa: ${(spent + requested).toLocaleString('en-US')} UZS`;
    } else {
       return `\n\n✅ *Budjet holati (Zaxira bor):*\n📉 Limit: ${limit.toLocaleString('en-US')}\n💸 Ishlatildi: ${spent.toLocaleString('en-US')}\n📦 Qoldiq: ${(limit - spent - requested).toLocaleString('en-US')}`;
    }
  } catch(e) { return ''; }
}


// ==========================================
// 1. MANAGER CONTROL PANEL (Persistent Buttons)
// ==========================================
bot.command('admin', (ctx) => {
  if (ctx.from.id.toString() !== MANAGER_ID) return;
  ctx.reply('👨‍💼 Procurement Manager Paneli:', Markup.keyboard([
    ['📊 Hisobot (Report)', '⏳ Kutilayotgan (Waiting)'],
    ['💸 Cashflow']
  ]).resize());
});

bot.hears('📊 Hisobot (Report)', async (ctx) => {
  if (ctx.from.id.toString() !== MANAGER_ID) return;
  try {
    await doc.loadInfo();
    const sheet = doc.sheetsByTitle['Pending_Expenses'];
    const rows = await sheet.getRows();
    const paid = rows.filter(r => r.get('Status') === 'PAID');
    
    let branchTotals = {};
    let typeTotals = { 'Karta': 0, 'Naqd': 0, 'MCHJ': 0 };
    let grandTotal = 0;

    paid.forEach(r => {
      const b = r.get('Branch') || 'Noma\'lum';
      const t = r.get('Payment Type') || '';
      const val = parseInt(r.get('Amount') ? r.get('Amount').toString().replace(/[^0-9]/g, '') : '0') || 0;
      branchTotals[b] = (branchTotals[b] || 0) + val;
      if (t.includes('Karta')) typeTotals['Karta'] += val;
      else if (t.includes('Naqd')) typeTotals['Naqd'] += val;
      else if (t.includes('MCHJ')) typeTotals['MCHJ'] += val;
      grandTotal += val;
    });

    let msg = `📊 *Muvaffaqiyatli To'lovlar (PAID)*\n━━━━━━━━━━━━━━━\n💰 *Jami: ${grandTotal.toLocaleString('en-US')} UZS*\n\n🏢 *Filiallar bo'yicha:*\n`;
    branches.forEach(b => { msg += `• ${b}: ${(branchTotals[b] || 0).toLocaleString('en-US')} UZS\n`; });
    msg += `\n💳 *To'lov turlari:*\n• Karta: ${typeTotals['Karta'].toLocaleString('en-US')}\n• Naqd: ${typeTotals['Naqd'].toLocaleString('en-US')}\n• MCHJ: ${typeTotals['MCHJ'].toLocaleString('en-US')}\n━━━━━━━━━━━━━━━`;
    ctx.reply(msg, { parse_mode: 'Markdown' });
  } catch (e) { ctx.reply('❌ Xatolik.'); }
});

bot.hears('⏳ Kutilayotgan (Waiting)', async (ctx) => {
  if (ctx.from.id.toString() !== MANAGER_ID) return;
  try {
    await doc.loadInfo();
    const sheet = doc.sheetsByTitle['Pending_Expenses'];
    const rows = await sheet.getRows();
    const waiting = rows.filter(r => r.get('Status') === 'SCHEDULED');
    
    if (waiting.length === 0) return ctx.reply("✅ Hozirda kutilayotgan to'lovlar yo'q.");
    
    let msg = `⏳ *Kutilayotgan To'lovlar ro'yxati*\n━━━━━━━━━━━━━━━\n`;
    let totalWait = 0;
    
    waiting.forEach(r => {
      const amt = parseInt(r.get('Amount') || 0);
      totalWait += amt;
      const priority = r.get('Priority') || "Kiritilmagan";
      const payType = r.get('Payment Type') || "Noma'lum";
      const payDetail = r.get('Payment Detail') || "N/A";
      
      msg += `🗓 Sana: ${r.get('Scheduled Date')}\n`;
      msg += `📍 ${r.get('Branch')} - ${amt.toLocaleString('en-US')} UZS\n`;
      msg += `💳 To'lov: ${payType} (${payDetail})\n`;
      msg += `📝 ${r.get('Description')} (${priority})\n\n`;
    });
    
    msg += `━━━━━━━━━━━━━━━\n💰 *Jami Kutilayotgan:* ${totalWait.toLocaleString('en-US')} UZS`;
    ctx.reply(msg, { parse_mode: 'Markdown' });
  } catch (e) { ctx.reply('❌ Xatolik.'); }
});

bot.hears('💸 Cashflow', async (ctx) => {
  if (ctx.from.id.toString() !== MANAGER_ID) return;
  try {
    await doc.loadInfo();
    const sheet = doc.sheetsByTitle['Pending_Expenses'];
    const rows = await sheet.getRows();
    const scheduled = rows.filter(r => r.get('Status') === 'SCHEDULED');
    
    if (scheduled.length === 0) return ctx.reply("✅ Kelajakdagi to'lovlar yo'q (Keshflou toza).");
    
    let dates = {};
    let total = 0;
    scheduled.forEach(r => {
      const d = r.get('Scheduled Date');
      const amt = parseInt(r.get('Amount') || 0);
      dates[d] = (dates[d] || 0) + amt;
      total += amt;
    });

    const sortedDates = Object.keys(dates).sort();
    
    let msg = `💸 *KESHFLOU FORECAST (Pul oqimi)*\n━━━━━━━━━━━━━━━\n`;
    sortedDates.forEach(d => {
      msg += `🗓 *${d}* ➔ ${dates[d].toLocaleString('en-US')} UZS\n`;
    });
    msg += `━━━━━━━━━━━━━━━\n💰 *Jami Rejalashtirilgan:* ${total.toLocaleString('en-US')} UZS`;
    ctx.reply(msg, { parse_mode: 'Markdown' });
  } catch (e) { ctx.reply('❌ Xatolik.'); }
});


// ==========================================
// 2. DAILY REMINDERS (CRON JOB)
// ==========================================
cron.schedule('0 9 * * *', async () => {
  try {
    await doc.loadInfo();
    const sheet = doc.sheetsByTitle['Pending_Expenses'];
    const rows = await sheet.getRows();
    const todayStr = getTodayStr();

    const dueToday = rows.filter(r => r.get('Status') === 'SCHEDULED' && r.get('Scheduled Date') === todayStr);

    for (let row of dueToday) {
      const formattedAmount = Number(row.get('Amount')).toLocaleString('en-US');
      const payType = row.get('Payment Type') || "Noma'lum";
      const payDetail = row.get('Payment Detail') || "N/A";
      
      await bot.telegram.sendMessage(MANAGER_ID, `⏰ *ESLATMA: Bugun to'lov qilinishi kerak!*\n\n📍 ${row.get('Branch')}\n💵 ${formattedAmount} UZS\n💳 To'lov: ${payType} (${payDetail})\n📝 ${row.get('Description')}\n\n*To'lovni amalga oshirgach, chek rasmini ushbu xabarga REPLY qilib yuboring.*\nID: ${row.rowNumber}`, { parse_mode: 'Markdown' });
    }
  } catch (e) { console.error("Cron Error:", e); }
}, { scheduled: true, timezone: "Asia/Tashkent" });


// ==========================================
// 3. THE REVERSED CHEQUE FLOW 
// (Manager Uploads -> Staff Confirms)
// ==========================================
bot.on('photo', async (ctx) => {
  if (ctx.from.id.toString() !== MANAGER_ID) return;

  const reply = ctx.message.reply_to_message;
  if (reply && reply.text && reply.text.includes('ID:')) {
    const rowNum = reply.text.split('ID:')[1].trim();
    try {
      await doc.loadInfo();
      const sheet = doc.sheetsByTitle['Pending_Expenses'];
      const rows = await sheet.getRows();
      const row = rows.find(r => r.rowNumber == rowNum);
      
      row.set('Status', 'CHEQUE_SENT'); 
      await row.save();
      
      ctx.reply('✅ Chek xodimga tasdiqlash uchun yuborildi!');
      
      const staffId = row.get('_StaffChatId');
      const formattedAmount = Number(row.get('Amount')).toLocaleString('en-US');

      await bot.telegram.sendPhoto(staffId, ctx.message.photo[0].file_id, {
        caption: `💰 *TO'LOV QILINDI!*\nProcurement Manager sizning so'rovingizni to'ladi.\n\n💵 Summa: ${formattedAmount} UZS\n📝 Sabab: ${row.get('Description')}\n\nIltimos, pulni qabul qilganingizni tasdiqlang:`,
        parse_mode: 'Markdown',
        ...Markup.inlineKeyboard([
          [Markup.button.callback('✅ Pulni qabul qildim (Tasdiqlash)', `staffconfirm_${rowNum}`)]
        ])
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

  if (text.includes('Hisobot') || text.includes('Kutilayotgan') || text.includes('Cashflow')) return;

  if (text === '❌ Bekor qilish (Cancel)' || text === '/start') {
    userSessions[userId] = { step: 'BRANCH' };
    return ctx.reply('Bekor qilindi. Filialni tanlang:', Markup.keyboard(branches, { columns: 2 }).resize());
  }

  const session = userSessions[userId];
  if (!session) return;

  if (session.step === 'BRANCH') {
    if (branches.includes(text)) {
      session.branch = text;
      session.step = 'CATEGORY';
      return ctx.reply('Kategoriyani tanlang:', Markup.keyboard([...categories, '❌ Bekor qilish (Cancel)'], { columns: 2 }).resize());
    }
  }
  if (session.step === 'CATEGORY') {
    if (categories.includes(text)) {
      session.category = text;
      session.step = 'AMOUNT';
      return ctx.reply('Summani kiriting (Masalan: 100 000 yoki 100,000):', Markup.keyboard(['❌ Bekor qilish (Cancel)']).resize());
    }
  }
  if (session.step === 'AMOUNT') {
    session.amount = text.replace(/[^0-9]/g, '');
    session.step = 'DESCRIPTION';
    return ctx.reply('Xarajat sababi va tafsilotlari (Description):');
  }
  if (session.step === 'DESCRIPTION') {
    session.description = text;
    session.step = 'PRIORITY';
    return ctx.reply('Xarajat muhimligi qanday? (Qachon to\'lanishi kerak?)', Markup.keyboard([...priorities, '❌ Bekor qilish (Cancel)'], { columns: 1 }).resize());
  }
  if (session.step === 'PRIORITY') {
    if (priorities.includes(text)) {
      session.priority = text;
      session.step = 'PAY_TYPE';
      return ctx.reply('To\'lov turi qanday bo\'ladi?', Markup.keyboard(['Karta', 'Naqd', 'MCHJ hisobi', '❌ Bekor qilish (Cancel)']).resize());
    }
  }
  if (session.step === 'PAY_TYPE') {
    session.payType = text;
    if (text === 'Naqd') {
        session.payDetail = 'N/A';
        session.step = 'CONFIRM';
        return askConfirmation(ctx, session);
    }
    session.step = 'PAY_DETAIL';
    return ctx.reply(text === 'Karta' ? 'Karta raqamini kiriting:' : 'Firma nomini kiriting:');
  }
  if (session.step === 'PAY_DETAIL') {
    session.payDetail = text;
    session.step = 'CONFIRM';
    return askConfirmation(ctx, session);
  }
});

function askConfirmation(ctx, session) {
  const formattedAmount = Number(session.amount).toLocaleString('en-US');
  let msg = `⚠️ *Menejerga yuborishdan oldin tekshiring:*\n\n`;
  msg += `📍 Filial: ${session.branch}\n`;
  msg += `📂 Kategoriya: ${session.category}\n`;
  msg += `💰 Summa: ${formattedAmount} UZS\n`;
  msg += `📝 Sabab: ${session.description}\n`;
  msg += `⏰ Muhimligi: ${session.priority}\n`;
  msg += `💳 To'lov: ${session.payType} (${session.payDetail})`;
  
  ctx.reply(msg, {
    parse_mode: 'Markdown',
    ...Markup.inlineKeyboard([
      [Markup.button.callback('✅ Yuborish (Submit)', 'submit_final')],
      [Markup.button.callback('❌ Boshidan boshlash', 'cancel_final')]
    ])
  });
}


// ==========================================
// 5. INLINE BUTTON HANDLERS 
// (Submission, Approval, Confirmation)
// ==========================================
bot.action(/^(submit_final|cancel_final)$/, async (ctx) => {
  const action = ctx.match[1];
  const userId = ctx.from.id.toString();
  const session = userSessions[userId];
  
  if (action === 'cancel_final') {
    userSessions[userId] = { step: 'BRANCH' };
    await ctx.editMessageText('❌ So\'rov bekor qilindi.');
    return ctx.reply('Filialni tanlang:', Markup.keyboard(branches, { columns: 2 }).resize());
  }
  
  if (action === 'submit_final' && session) {
    try {
      await doc.loadInfo();
      const sheet = doc.sheetsByTitle['Pending_Expenses'];
      const formattedAmount = Number(session.amount).toLocaleString('en-US');
      
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
        'Scheduled Date': '',
        'Priority': session.priority
      });

      const budgetWarning = await getBudgetWarning(session.branch, session.amount);

      await bot.telegram.sendMessage(MANAGER_ID, 
        `🏢 *Yangi So'rov*\n📍 Filial: ${session.branch}\n👤 Kimdan: ${ctx.from.first_name}\n💵 Summa: ${formattedAmount} UZS\n💳 To'lov: ${session.payType} (${session.payDetail})\n💬 Sabab: ${session.description}\n⏰ Muhimligi: ${session.priority} ${budgetWarning}`, 
        {
          parse_mode: 'Markdown',
          ...Markup.inlineKeyboard([
            [Markup.button.callback('✅ Tasdiqlash (Qaror)', `decide_${row.rowNumber}`)], 
            [Markup.button.callback('❌ Rad etish', `rej_${row.rowNumber}`)]
          ])
        }
      );

      userSessions[userId] = { step: 'BRANCH' };
      await ctx.editMessageText(`✅ So'rov muvaffaqiyatli yuborildi!\nID: ${row.rowNumber}`);
      ctx.reply('Yangi so\'rov yaratish uchun filialni tanlang:', Markup.keyboard(branches, { columns: 2 }).resize());
    } catch (e) { 
      ctx.reply('❌ Xatolik yuz berdi. Google Sheet ustunlarini tekshiring.'); 
      console.error(e); 
    }
  }
});

// STAFF CONFIRMATION BUTTON
bot.action(/^staffconfirm_(\d+)$/, async (ctx) => {
  const rowNum = ctx.match[1];
  try {
    await doc.loadInfo();
    const sheet = doc.sheetsByTitle['Pending_Expenses'];
    const rows = await sheet.getRows();
    const row = rows.find(r => r.rowNumber == rowNum);
    
    row.set('Status', 'PAID');
    await row.save();
    
    await ctx.editMessageCaption('✅ *PUL QABUL QILINDI VA YOPILDI.*', { parse_mode: 'Markdown' });
    
    await bot.telegram.sendMessage(MANAGER_ID, `✅ Xodim ${row.get('Amount')} UZS miqdoridagi pulni olganini tasdiqladi.\n(ID: ${rowNum} - Status: PAID)`);
  } catch(e) { console.error(e); }
});

// MANAGER SCHEDULING BUTTONS
bot.action(/^(decide|paynow|schedD|schedF|schedM|rej)_(\d+)(?:_(\d+))?$/, async (ctx) => {
  const action = ctx.match[1];
  const rowNum = ctx.match[2];
  const schedParam = ctx.match[3]; 

  try {
    await doc.loadInfo();
    const sheet = doc.sheetsByTitle['Pending_Expenses'];
    const rows = await sheet.getRows();
    const row = rows.find(r => r.rowNumber == rowNum);
    if (!row) return ctx.reply("❌ Xatolik: Qator topilmadi.");

    const staffId = row.get('_StaffChatId');
    const formattedAmount = Number(row.get('Amount')).toLocaleString('en-US');

    if (action === 'decide') {
      await ctx.editMessageText(`💸 So'rov ko'rib chiqilmoqda. Qachon to'laysiz?`, {
        ...Markup.inlineKeyboard([
          [Markup.button.callback('✅ Hozir To\'lash (Chek yuborish)', `paynow_${rowNum}`)],
          [Markup.button.callback('🗓 Dushanba', `schedD_${rowNum}_1`), Markup.button.callback('🗓 Seshanba', `schedD_${rowNum}_2`)],
          [Markup.button.callback('🗓 Chorshanba', `schedD_${rowNum}_3`), Markup.button.callback('🗓 Payshanba', `schedD_${rowNum}_4`)],
          [Markup.button.callback('🗓 Juma', `schedD_${rowNum}_5`)],
          [Markup.button.callback('⏳ 15 kun', `schedF_${rowNum}_15`), Markup.button.callback('📅 1 oy', `schedM_${rowNum}`)]
        ])
      });
    } 
    
    else if (action === 'paynow') {
      row.set('Status', 'SCHEDULED');
      row.set('Scheduled Date', getTodayStr());
      await row.save();
      await bot.telegram.sendMessage(staffId, `✅ To'lov tasdiqlandi! Procurement Manager pulni o'tkazmoqda.`);
      await ctx.editMessageText(`💸 *Hozir to'lash tanlandi.*\nTo'lovni amalga oshirgach, **ushbu xabarga CHEK RASMINI REPLY qilib yuboring**.\nID: ${rowNum}`, { parse_mode: 'Markdown' });
    } 
    
    else if (action.startsWith('sched')) {
      let targetDate = '';
      if (action === 'schedD') targetDate = getScheduledDateStr('D', parseInt(schedParam));
      else if (action === 'schedF') targetDate = getScheduledDateStr('F', parseInt(schedParam));
      else if (action === 'schedM') targetDate = getScheduledDateStr('M', 0);
      
      row.set('Status', 'SCHEDULED');
      row.set('Scheduled Date', targetDate);
      await row.save();

      await bot.telegram.sendMessage(staffId, `⏳ *To'lov Rejalashtirildi!*\nSizning ${formattedAmount} UZS so'rovingiz tasdiqlandi.\nTo'lov sanasi: *${targetDate}*`, { parse_mode: 'Markdown' });
      await ctx.editMessageText(`🗓 To'lov ${targetDate} sanasiga rejalashtirildi. Xodim ogohlantirildi.`);
    } 
    
    else if (action === 'rej') {
      row.set('Status', 'REJECTED');
      await row.save();
      await bot.telegram.sendMessage(staffId, `❌ Sizning ${formattedAmount} UZS so'rovingiz rad etildi.`);
      await ctx.editMessageText('❌ So\'rov rad etildi va yopildi.');
    }
  } catch (e) {
    console.error(e);
    ctx.reply("❌ Amalni bajarishda xatolik yuz berdi.");
  }
});

bot.launch();
process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
