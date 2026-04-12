const { Telegraf, Markup } = require('telegraf');
const { JWT } = require('google-auth-library');
const { GoogleSpreadsheet } = require('google-spreadsheet');
const cron = require('node-cron');

// ==========================================
// ENVIRONMENT & AUTHENTICATION
// ==========================================
const bot = new Telegraf(process.env.BOT_TOKEN);
const SHEET_ID = process.env.SHEET_ID;
const MANAGER_ID = process.env.MANAGER_CHAT_ID;
const CEO_ID = process.env.CEO_CHAT_ID || "NO_CEO"; 

const creds = JSON.parse(process.env.GCP_SERVICE_ACCOUNT);
const auth = new JWT({
  email: creds.client_email,
  key: creds.private_key,
  scopes: ['https://www.googleapis.com/auth/spreadsheets'],
});
const doc = new GoogleSpreadsheet(SHEET_ID, auth);

// Memory state for user conversations (Wizards)
const userSessions = {};

// ==========================================
// CONSTANTS & DICTIONARIES
// ==========================================
const branches = ['📍 Integro', '📍 Drujba', '📍 Amir Temur', '📍 Central', '📍 Marketing'];
const categories = ['tugilgan kun uchun', 'printer rang', 'Printer tuzatish', 'remont-tuzatish', 'Hodimlar uchun dorilar', 'jihoz', 'Texnikalar', 'Transport', 'aromatizator', 'Internet', 'Telefon', 'of the month', 'Event', 'Reklama mahsulotlarini chiqarish', 'giftbox sovgalar', 'syomka xarajatlari', 'bozorlik xojalik', 'Suv va stakan', 'Konstovar', 'Plastik foizi', 'ofis xarajatlari', 'remont qurilish'];
const priorities = ["🔴 O'ta muhim (Bugun)", "🟡 O'rtacha (Ertaga)", "🔵 Normal (Shu hafta)", "🟢 Shoshilinch emas (Shu oy)"];

// ==========================================
// UTILITY FUNCTIONS (Bug Fixes & Logic)
// ==========================================
function getTodayStr() {
  // Forces Tashkent timezone (UTC+5) to prevent midnight server errors
  return new Date(new Date().getTime() + (5 * 60 * 60 * 1000)).toISOString().split('T')[0];
}

function getScheduledDateStr(type, param) {
  const tashkentTime = new Date(new Date().getTime() + (5 * 60 * 60 * 1000));
  if (type === 'D') { 
    const currentDay = tashkentTime.getUTCDay(); 
    let distance = param - currentDay;
    if (distance <= 0) distance += 7; // Pushes to next week if day already passed
    tashkentTime.setUTCDate(tashkentTime.getUTCDate() + distance);
  } else if (type === 'F') {
    tashkentTime.setUTCDate(tashkentTime.getUTCDate() + param); // Plus X days
  } else if (type === 'M') {
    tashkentTime.setUTCMonth(tashkentTime.getUTCMonth() + 1); // Plus 1 month
  }
  return tashkentTime.toISOString().split('T')[0];
}

// FIX: Removes the text inside brackets for clean manager reports (e.g. removes "(Ertaga)")
function cleanPriority(priorityStr) {
  if (!priorityStr) return "Normal";
  return priorityStr.split('(')[0].trim(); 
}

// FIX: Safe number parsing for amounts like "100k", "100 000", "100.000"
function parseSafeInt(str) {
  if (!str) return 0;
  return parseInt(str.toString().replace(/[^0-9]/g, '')) || 0;
}

// ==========================================
// ADVANCED BUDGET ENGINE (Double Audit)
// ==========================================
async function getDoubleBudgetWarning(branch, category, amountStr) {
  try {
    await doc.loadInfo();
    const budgetSheet = doc.sheetsByTitle['Budgets'];
    const expenseSheet = doc.sheetsByTitle['Pending_Expenses'];
    if (!budgetSheet || !expenseSheet) return '\n\n⚠️ *Tizim Xatosi: Jadvallar topilmadi.*';

    const budgetRows = await budgetSheet.getRows();
    const expenseRows = await expenseSheet.getRows();
    const requested = parseSafeInt(amountStr);
    const now = new Date(new Date().getTime() + (5 * 60 * 60 * 1000)); // Tashkent time

    // Helper: Calculates spent money for current month based on branch/category
    const calculateSpent = (b, cat = null) => {
      let spent = 0;
      expenseRows.forEach(r => {
        const rowDateStr = r.get('Timestamp');
        if (!rowDateStr) return; // Skip empty rows
        
        const rowDate = new Date(rowDateStr);
        const status = r.get('Status');
        const matchesBranch = r.get('Branch') === b;
        const matchesCategory = cat ? (r.get('Description') || '').includes(`[${cat}]`) : true;
        const isThisMonth = rowDate.getMonth() === now.getMonth() && rowDate.getFullYear() === now.getFullYear();

        // Only count actual liabilities
        if (matchesBranch && matchesCategory && isThisMonth && (status === 'PAID' || status === 'SCHEDULED' || status === 'CHEQUE_SENT')) {
          spent += parseSafeInt(r.get('Amount'));
        }
      });
      return spent;
    };

    // 1. Audit Branch Total (Looks for row where Branch matches but Category is empty)
    const branchBudgetRow = budgetRows.find(r => r.get('Branch') === branch && (!r.get('Category') || r.get('Category').trim() === ''));
    const branchSpent = calculateSpent(branch);
    let branchMsg = "ℹ️ Filial limiti belgilanmagan.";
    if (branchBudgetRow) {
      const bLimit = parseSafeInt(branchBudgetRow.get('Monthly Limit'));
      branchMsg = (branchSpent + requested > bLimit) 
        ? `🔴 *Filial Limiti o'tdi!* (${branchSpent.toLocaleString()} / ${bLimit.toLocaleString()})` 
        : `✅ Filial Zaxirasi: ${(bLimit - (branchSpent + requested)).toLocaleString()} UZS`;
    }

    // 2. Audit Specific Category
    const catBudgetRow = budgetRows.find(r => r.get('Branch') === branch && r.get('Category') === category);
    const catSpent = calculateSpent(branch, category);
    let catMsg = "ℹ️ Kategoriya limiti belgilanmagan.";
    if (catBudgetRow) {
      const cLimit = parseSafeInt(catBudgetRow.get('Monthly Limit'));
      catMsg = (catSpent + requested > cLimit) 
        ? `🔴 *KATEGORIYA LIMITI O'TDI!* (${catSpent.toLocaleString()} / ${cLimit.toLocaleString()})` 
        : `✅ Kategoriya Zaxirasi: ${(cLimit - (catSpent + requested)).toLocaleString()} UZS`;
    }

    return `\n\n📊 *Budjet Nazorati (Shu oy):*\n${branchMsg}\n${catMsg}`;
  } catch (e) { 
    console.error("Budget Error:", e);
    return '\n\n⚠️ *Budjetni hisoblashda xatolik yuz berdi.*'; 
  }
}

// ==========================================
// SHARED REPORTING (For CEO & Manager)
// ==========================================
async function generateGlobalReport() {
    await doc.loadInfo();
    const rows = await doc.sheetsByTitle['Pending_Expenses'].getRows();
    const paid = rows.filter(r => r.get('Status') === 'PAID');
    let branchTotals = {};
    let grandTotal = 0;

    paid.forEach(r => {
      const b = r.get('Branch') || 'Noma\'lum';
      const val = parseSafeInt(r.get('Amount'));
      branchTotals[b] = (branchTotals[b] || 0) + val;
      grandTotal += val;
    });

    let msg = `📊 *GLOBAL MOLIYA HISOBOTI*\n━━━━━━━━━━━━━━━\n💰 *Jami To'langan: ${grandTotal.toLocaleString('en-US')} UZS*\n\n🏢 *Filiallar bo'yicha:*\n`;
    branches.forEach(b => { msg += `• ${b}: ${(branchTotals[b] || 0).toLocaleString('en-US')} UZS\n`; });
    return msg;
}

// ==========================================
// 1. ADMIN & CEO DASHBOARDS
// ==========================================
bot.command('admin', (ctx) => {
  const uid = ctx.from.id.toString();
  if (uid === MANAGER_ID) {
    return ctx.reply('👨‍💼 Procurement Manager Paneli:', Markup.keyboard([
        ['📊 Hisobot (Report)', '⏳ Kutilayotgan (Waiting)'],
        ['💸 Cashflow']
    ]).resize());
  } else if (uid === CEO_ID) {
    return ctx.reply('👑 CEO Monitoring Paneli:', Markup.keyboard([
        ['📈 Umumiy Hisobot', '💸 Cashflow Forecast']
    ]).resize());
  }
});

// SHARED COMMANDS
bot.hears(['💸 Cashflow', '💸 Cashflow Forecast'], async (ctx) => {
  const uid = ctx.from.id.toString();
  if (uid !== MANAGER_ID && uid !== CEO_ID) return;
  try {
    await doc.loadInfo();
    const rows = await doc.sheetsByTitle['Pending_Expenses'].getRows();
    const scheduled = rows.filter(r => r.get('Status') === 'SCHEDULED');
    if (scheduled.length === 0) return ctx.reply("✅ Kelajakdagi to'lovlar yo'q (Keshflou toza).");
    
    let dates = {};
    let total = 0;
    scheduled.forEach(r => {
      const d = r.get('Scheduled Date');
      const amt = parseSafeInt(r.get('Amount'));
      dates[d] = (dates[d] || 0) + amt;
      total += amt;
    });

    const sortedDates = Object.keys(dates).sort();
    let msg = `💸 *CASHFLOW FORECAST (Pul oqimi)*\n━━━━━━━━━━━━━━━\n`;
    sortedDates.forEach(d => { msg += `🗓 *${d}* ➔ ${dates[d].toLocaleString('en-US')} UZS\n`; });
    msg += `━━━━━━━━━━━━━━━\n💰 *Kutilayotgan Jami:* ${total.toLocaleString('en-US')} UZS`;
    ctx.reply(msg, { parse_mode: 'Markdown' });
  } catch (e) { ctx.reply('❌ Xatolik.'); }
});

bot.hears(['📊 Hisobot (Report)', '📈 Umumiy Hisobot'], async (ctx) => {
  const uid = ctx.from.id.toString();
  if (uid !== MANAGER_ID && uid !== CEO_ID) return;
  try {
    const msg = await generateGlobalReport();
    ctx.reply(msg, { parse_mode: 'Markdown' });
  } catch (e) { ctx.reply('❌ Xatolik.'); }
});

// MANAGER ONLY COMMAND
bot.hears('⏳ Kutilayotgan (Waiting)', async (ctx) => {
  if (ctx.from.id.toString() !== MANAGER_ID) return;
  try {
    await doc.loadInfo();
    const rows = await doc.sheetsByTitle['Pending_Expenses'].getRows();
    const waiting = rows.filter(r => r.get('Status') === 'SCHEDULED');
    if (waiting.length === 0) return ctx.reply("✅ Kutilayotgan to'lovlar yo'q.");
    
    let msg = `⏳ *Kutilayotgan To'lovlar ro'yxati*\n━━━━━━━━━━━━━━━\n`;
    let totalWait = 0;
    waiting.forEach(r => {
      const amt = parseSafeInt(r.get('Amount'));
      totalWait += amt;
      const cleanPrio = cleanPriority(r.get('Priority'));
      msg += `🗓 Sana: ${r.get('Scheduled Date')}\n📍 ${r.get('Branch')} - ${amt.toLocaleString('en-US')} UZS\n💳 ${r.get('Payment Type')} (${r.get('Payment Detail')})\n📝 ${r.get('Description')} [${cleanPrio}]\n\n`;
    });
    msg += `━━━━━━━━━━━━━━━\n💰 Jami: ${totalWait.toLocaleString('en-US')} UZS`;
    ctx.reply(msg, { parse_mode: 'Markdown' });
  } catch (e) { ctx.reply('❌ Xatolik.'); }
});

// ==========================================
// 2. CRON REMINDERS (Daily 9:00 AM)
// ==========================================
cron.schedule('0 9 * * *', async () => {
  try {
    await doc.loadInfo();
    const rows = await doc.sheetsByTitle['Pending_Expenses'].getRows();
    const todayStr = getTodayStr();
    const dueToday = rows.filter(r => r.get('Status') === 'SCHEDULED' && r.get('Scheduled Date') === todayStr);

    for (let row of dueToday) {
      const formattedAmount = parseSafeInt(row.get('Amount')).toLocaleString('en-US');
      await bot.telegram.sendMessage(MANAGER_ID, `⏰ *ESLATMA: Bugun to'lov qilinishi kerak!*\n\n📍 ${row.get('Branch')}\n💵 ${formattedAmount} UZS\n💳 To'lov: ${row.get('Payment Type')} (${row.get('Payment Detail')})\n📝 ${row.get('Description')}\n\n*To'lovni amalga oshirgach, ushbu xabarga CHEK RASMINI REPLY qilib yuboring.*\nID: ${row.rowNumber}`, { parse_mode: 'Markdown' });
    }
  } catch (e) { console.error("Cron Error:", e); }
}, { scheduled: true, timezone: "Asia/Tashkent" });

// ==========================================
// 3. REVERSED CHEQUE FLOW
// ==========================================
bot.on('photo', async (ctx) => {
  if (ctx.from.id.toString() !== MANAGER_ID) return; // Only Manager can upload cheques
  const reply = ctx.message.reply_to_message;
  if (reply && reply.text && reply.text.includes('ID:')) {
    const rowNum = reply.text.split('ID:')[1].trim();
    try {
      await doc.loadInfo();
      const rows = await doc.sheetsByTitle['Pending_Expenses'].getRows();
      const row = rows.find(r => r.rowNumber == rowNum);
      if(!row) return ctx.reply('❌ ID topilmadi.');

      row.set('Status', 'CHEQUE_SENT'); 
      await row.save();
      ctx.reply('✅ Chek xodimga tasdiqlash uchun yuborildi!');
      
      const staffId = row.get('_StaffChatId');
      const formattedAmount = parseSafeInt(row.get('Amount')).toLocaleString('en-US');

      await bot.telegram.sendPhoto(staffId, ctx.message.photo[0].file_id, {
        caption: `💰 *TO'LOV QILINDI!*\nProcurement Manager pulni o'tkazdi.\n\n💵 Summa: ${formattedAmount} UZS\n\nIltimos, pulni olganingizni tasdiqlang:`,
        parse_mode: 'Markdown',
        ...Markup.inlineKeyboard([[Markup.button.callback('✅ Qabul qildim', `staffconfirm_${rowNum}`)]])
      });
    } catch (e) { console.error(e); ctx.reply("❌ Xatolik yuz berdi."); }
  }
});

// ==========================================
// 4. STAFF REQUEST WIZARD
// ==========================================
bot.command(['start', 'new'], (ctx) => {
  const userId = ctx.from.id;
  // FIX: Forcefully reset session to prevent loops
  delete userSessions[userId];
  userSessions[userId] = { step: 'BRANCH' };
  ctx.reply('IELTS Zone Finance Bot 🎓\nFilialni tanlang:', Markup.keyboard(branches, { columns: 2 }).oneTime().resize());
});

bot.on('text', async (ctx) => {
  const userId = ctx.from.id;
  const text = ctx.message.text;

  // Ignore admin buttons
  if (text.includes('Hisobot') || text.includes('Kutilayotgan') || text.includes('Cashflow')) return;

  // FIX: Cancel explicitly destroys session to stop loop
  if (text === '❌ Bekor qilish' || text === '/start') {
    delete userSessions[userId];
    return ctx.reply('Bekor qilindi. Boshlash uchun filialni tanlang:', Markup.keyboard(branches, { columns: 2 }).resize());
  }

  // Session Bootstrapper (In case bot resets but user taps an old keyboard button)
  if (!userSessions[userId] && branches.includes(text)) {
    userSessions[userId] = { step: 'BRANCH' };
  }

  const session = userSessions[userId];
  if (!session) return;

  if (session.step === 'BRANCH') {
    if (branches.includes(text)) { 
      session.branch = text; 
      session.step = 'CATEGORY'; 
      return ctx.reply('Kategoriyani tanlang:', Markup.keyboard([...categories, '❌ Bekor qilish'], { columns: 2 }).resize()); 
    }
  }
  if (session.step === 'CATEGORY') {
    if (categories.includes(text)) { 
      session.category = text; 
      session.step = 'AMOUNT'; 
      return ctx.reply('Summani kiriting:', Markup.keyboard(['❌ Bekor qilish']).resize()); 
    }
  }
  if (session.step === 'AMOUNT') {
    session.amount = parseSafeInt(text);
    if(session.amount === 0) return ctx.reply('Iltimos, yaroqli son kiriting:');
    session.step = 'DESCRIPTION';
    return ctx.reply('Xarajat sababi (Description):');
  }
  if (session.step === 'DESCRIPTION') {
    session.description = text;
    session.step = 'PRIORITY';
    return ctx.reply('Muhimligi:', Markup.keyboard([...priorities, '❌ Bekor qilish'], { columns: 1 }).resize());
  }
  if (session.step === 'PRIORITY') {
    if (priorities.includes(text)) { 
      session.priority = text; 
      session.step = 'PAY_TYPE'; 
      return ctx.reply('To\'lov turi:', Markup.keyboard(['Karta', 'Naqd', 'MCHJ hisobi', '❌ Bekor qilish']).resize()); 
    }
  }
  if (session.step === 'PAY_TYPE') {
    session.payType = text;
    if (text === 'Naqd') { 
      session.payDetail = 'N/A'; 
      return askConfirmation(ctx, session); 
    }
    session.step = 'PAY_DETAIL';
    return ctx.reply(text === 'Karta' ? 'Karta raqamini kiriting:' : 'Firma nomini kiriting:');
  }
  if (session.step === 'PAY_DETAIL') {
    session.payDetail = text;
    return askConfirmation(ctx, session);
  }
});

function askConfirmation(ctx, session) {
  const formattedAmount = session.amount.toLocaleString('en-US');
  let msg = `⚠️ *Menejerga yuborishdan oldin tekshiring:*\n\n📍 Filial: ${session.branch}\n📂 Kategoriya: ${session.category}\n💰 Summa: ${formattedAmount} UZS\n📝 Sabab: ${session.description}\n⏰ Muhimligi: ${session.priority}\n💳 To'lov: ${session.payType} (${session.payDetail})`;
  
  // Explicit inline keyboard for final decision
  ctx.reply(msg, { 
    parse_mode: 'Markdown', 
    ...Markup.inlineKeyboard([
      [Markup.button.callback('✅ Yuborish', 'submit_final')], 
      [Markup.button.callback('❌ Bekor qilish', 'cancel_final')]
    ]) 
  });
}

// ==========================================
// 5. INLINE ACTION HANDLERS (Callbacks)
// ==========================================
bot.action(/^(submit_final|cancel_final)$/, async (ctx) => {
  const action = ctx.match[1];
  const userId = ctx.from.id;
  const session = userSessions[userId];
  
  if (action === 'cancel_final') {
    delete userSessions[userId]; // FIX: Clear session
    await ctx.editMessageText('❌ So\'rov bekor qilindi.');
    return ctx.reply('Yangi so\'rov uchun filialni tanlang:', Markup.keyboard(branches, { columns: 2 }).resize());
  }
  
  if (action === 'submit_final' && session) {
    try {
      await doc.loadInfo();
      const sheet = doc.sheetsByTitle['Pending_Expenses'];
      
      const row = await sheet.addRow({
        'Timestamp': new Date().toLocaleString('en-US', { timeZone: 'Asia/Tashkent' }),
        'Branch': session.branch,
        'Staff Name': ctx.from.first_name,
        'Amount': session.amount,
        'Payment Type': session.payType,
        'Payment Detail': session.payDetail,
        'Description': `[${session.category}] ${session.description}`,
        'Status': 'PENDING',
        '_StaffChatId': userId.toString(),
        'Priority': session.priority
      });

      // Execute Double Budget Audit
      const budgetWarning = await getDoubleBudgetWarning(session.branch, session.category, session.amount);
      
      // Notify Manager
      await bot.telegram.sendMessage(MANAGER_ID, 
        `🏢 *Yangi So'rov*\n📍 Filial: ${session.branch}\n👤 Kimdan: ${ctx.from.first_name}\n💵 Summa: ${session.amount.toLocaleString('en-US')} UZS\n💳 To'lov: ${session.payType} (${session.payDetail})\n💬 Sabab: ${session.description}\n⏰ Muhimligi: ${session.priority} ${budgetWarning}`, 
        {
          parse_mode: 'Markdown',
          ...Markup.inlineKeyboard([
            [Markup.button.callback('✅ Tasdiqlash (Reja)', `decide_${row.rowNumber}`)], 
            [Markup.button.callback('❌ Rad etish', `rej_${row.rowNumber}`)]
          ])
        }
      );

      delete userSessions[userId]; // FIX: Clear session to prevent loop
      await ctx.editMessageText(`✅ Muvaffaqiyatli yuborildi!\nID: ${row.rowNumber}`);
      ctx.reply('Yangi so\'rov uchun filialni tanlang:', Markup.keyboard(branches, { columns: 2 }).resize());
    } catch (e) { 
      delete userSessions[userId]; // Safety cleanup
      ctx.editMessageText('❌ Xatolik yuz berdi. Iltimos qaytadan urining.'); 
      console.error(e); 
    }
  } else {
    // Session expired or duplicate click
    delete userSessions[userId];
    ctx.editMessageText('❌ Sessiya tugadi. /start bosing.');
  }
});

// STAFF CONFIRMATION BUTTON
bot.action(/^staffconfirm_(\d+)$/, async (ctx) => {
  const rowNum = ctx.match[1];
  try {
    await doc.loadInfo();
    const rows = await doc.sheetsByTitle['Pending_Expenses'].getRows();
    const row = rows.find(r => r.rowNumber == rowNum);
    if (!row) return ctx.answerCbQuery("ID topilmadi.");
    
    row.set('Status', 'PAID'); 
    await row.save();
    
    await ctx.editMessageCaption('✅ *PUL QABUL QILINDI VA YOPILDI.*', { parse_mode: 'Markdown' });
    await bot.telegram.sendMessage(MANAGER_ID, `✅ Xodim ${parseSafeInt(row.get('Amount')).toLocaleString()} UZS miqdoridagi pulni olganini tasdiqladi.\n(ID: ${rowNum} - Status: PAID)`);
  } catch(e) { console.error(e); ctx.answerCbQuery("Xatolik yuz berdi."); }
});

// MANAGER DECISION BUTTONS
bot.action(/^(decide|paynow|schedD|schedF|schedM|rej)_(\d+)(?:_(\d+))?$/, async (ctx) => {
  if (ctx.from.id.toString() !== MANAGER_ID) return ctx.answerCbQuery("Sizda huquq yo'q."); // Security lock
  
  const [action, rowNum, param] = [ctx.match[1], ctx.match[2], ctx.match[3]];
  try {
    await doc.loadInfo();
    const rows = await doc.sheetsByTitle['Pending_Expenses'].getRows();
    const row = rows.find(r => r.rowNumber == rowNum);
    if (!row) return ctx.editMessageText("❌ Xatolik: Qator topilmadi.");

    const staffId = row.get('_StaffChatId');

    if (action === 'decide') {
      return ctx.editMessageText(`💸 Qachon to'laysiz?`, Markup.inlineKeyboard([
        [Markup.button.callback('✅ Hozir To\'lash (Chek yuborish)', `paynow_${rowNum}`)],
        [Markup.button.callback('🗓 Dushanba', `schedD_${rowNum}_1`), Markup.button.callback('🗓 Seshanba', `schedD_${rowNum}_2`)],
        [Markup.button.callback('🗓 Chorshanba', `schedD_${rowNum}_3`), Markup.button.callback('🗓 Payshanba', `schedD_${rowNum}_4`)],
        [Markup.button.callback('🗓 Juma', `schedD_${rowNum}_5`)],
        [Markup.button.callback('⏳ 15 kun', `schedF_${rowNum}_15`), Markup.button.callback('📅 1 oy', `schedM_${rowNum}`)]
      ]));
    } 
    
    if (action === 'paynow') {
      row.set('Status', 'SCHEDULED'); 
      row.set('Scheduled Date', getTodayStr()); 
      await row.save();
      await bot.telegram.sendMessage(staffId, `✅ To'lov tasdiqlandi! Pul o'tkazilmoqda.`);
      return ctx.editMessageText(`💸 Hozir to'lash tanlandi.\nTo'lovdan so'ng **ushbu xabarga CHEK RASMINI REPLY qilib yuboring**.\nID: ${rowNum}`, { parse_mode: 'Markdown' });
    } 
    
    if (action.startsWith('sched')) {
      let targetDate = '';
      if (action === 'schedD') targetDate = getScheduledDateStr('D', parseInt(param));
      else if (action === 'schedF') targetDate = getScheduledDateStr('F', parseInt(param));
      else if (action === 'schedM') targetDate = getScheduledDateStr('M', 0);
      
      row.set('Status', 'SCHEDULED'); 
      row.set('Scheduled Date', targetDate); 
      await row.save();
      await bot.telegram.sendMessage(staffId, `⏳ Tasdiqlandi. To'lov sanasi: *${targetDate}*`, { parse_mode: 'Markdown' });
      return ctx.editMessageText(`🗓 ${targetDate} sanasiga rejalashtirildi. Xodim ogohlantirildi.`);
    } 
    
    if (action === 'rej') {
      row.set('Status', 'REJECTED'); 
      await row.save();
      await bot.telegram.sendMessage(staffId, `❌ So'rov rad etildi.`);
      return ctx.editMessageText('❌ Rad etildi va yopildi.');
    }
  } catch (e) { console.error(e); ctx.editMessageText("❌ Amalni bajarishda xatolik."); }
});

// ==========================================
// BOOT
// ==========================================
bot.launch().then(() => console.log('Bot is running...'));
process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
