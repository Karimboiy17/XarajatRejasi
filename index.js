const { Telegraf, Markup } = require('telegraf');
const { JWT } = require('google-auth-library');
const { GoogleSpreadsheet } = require('google-spreadsheet');
const cron = require('node-cron');

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
const marketingCategories = ['syomka xarajatlari', 'Reklama mahsulotlarini chiqarish', 'giftbox sovgalar', 'Event', 'Transport'];
const priorities = ["🔴 O'ta muhim (Bugun)", "🟡 O'rtacha (Ertaga)", "🔵 Normal (Shu hafta)", "🟢 Shoshilinch emas (Shu oy)"];

// --- DATE HELPERS ---
function getTashkentDate(date = new Date()) {
  return new Date(date.getTime() + (5 * 60 * 60 * 1000));
}

function getTodayStr() {
  return getTashkentDate().toISOString().split('T')[0];
}

function getScheduledDateStr(type, param) {
  const now = getTashkentDate();
  if (type === 'D') { 
    const currentDay = now.getUTCDay(); 
    let distance = param - currentDay;
    if (distance <= 0) distance += 7; 
    now.setUTCDate(now.getUTCDate() + distance);
  } else if (type === 'F') now.setUTCDate(now.getUTCDate() + param);
  else if (type === 'M') now.setUTCMonth(now.getUTCMonth() + 1);
  return now.toISOString().split('T')[0];
}

// --- MASTER BUDGET AUDIT ENGINE ---
async function getMasterAudit(branch, category, amountStr) {
  try {
    await doc.loadInfo();
    const budgetRows = await doc.sheetsByTitle['Budgets'].getRows();
    const expenseRows = await doc.sheetsByTitle['Pending_Expenses'].getRows();
    const requested = parseInt(amountStr);
    const now = getTashkentDate();
    const lastMonthDate = new Date(now.getFullYear(), now.getMonth() - 1, 1);

    // Find limits
    const bLimitRow = budgetRows.find(r => r.get('Branch') === branch && (!r.get('Category') || r.get('Category').trim() === ''));
    const cLimitRow = budgetRows.find(r => r.get('Branch') === branch && r.get('Category') === category);
    
    const branchLimit = bLimitRow ? parseInt(bLimitRow.get('Monthly Limit').replace(/[^0-9]/g, '')) : Infinity;
    const catLimit = cLimitRow ? parseInt(cLimitRow.get('Monthly Limit').replace(/[^0-9]/g, '')) : Infinity;

    let branchSpent = 0;
    let catSpent = 0;
    let lastMonthCatSpent = 0;

    expenseRows.forEach(r => {
      const status = r.get('Status');
      const amt = parseInt(r.get('Amount') ? r.get('Amount').toString().replace(/[^0-9]/g, '') : '0') || 0;
      const rowDate = new Date(r.get('Timestamp'));
      
      if (r.get('Branch') === branch && ['PAID', 'SCHEDULED', 'CHEQUE_SENT'].includes(status)) {
        // Current Month
        if (rowDate.getMonth() === now.getMonth() && rowDate.getFullYear() === now.getFullYear()) {
          branchSpent += amt;
          if (r.get('Description').includes(`[${category}]`)) catSpent += amt;
        }
        // Last Month
        if (rowDate.getMonth() === lastMonthDate.getMonth() && rowDate.getFullYear() === lastMonthDate.getFullYear()) {
          if (r.get('Description').includes(`[${category}]`)) lastMonthCatSpent += amt;
        }
      }
    });

    let report = `\n\n📊 *Byudjet Analizi:*`;
    
    // Percent Trigger
    if (catLimit !== Infinity && requested > (catLimit * 0.5)) {
      report += `\n🚨 *Yirik xarajat:* Bu so'rov kategoriya byudjetining 50% idan ko'p!`;
    }

    // Branch Audit
    const bRemaining = branchLimit - branchSpent - requested;
    report += `\n📍 Filial Qoldig'i: ${branchLimit === Infinity ? 'Cheksiz' : bRemaining.toLocaleString('en-US') + ' UZS'}`;

    // Category Audit
    if (catLimit !== Infinity) {
      const cRemaining = catLimit - catSpent - requested;
      report += `\n📂 ${category}: ${cRemaining < 0 ? '⚠️ OSHIB KETDI' : cRemaining.toLocaleString('en-US') + ' UZS qoldi'}`;
    }

    // History
    if (lastMonthCatSpent > 0) {
      report += `\n📜 O'tgan oygi sarf (${category}): ${lastMonthCatSpent.toLocaleString('en-US')} UZS`;
    }

    return report;
  } catch (e) { console.error(e); return ''; }
}

// ==========================================
// 1. MANAGER CONTROL PANEL
// ==========================================
bot.command('admin', (ctx) => {
  if (ctx.from.id.toString() !== MANAGER_ID) return;
  ctx.reply('👨‍💼 Procurement Manager Paneli:', Markup.keyboard([
    ['📊 Hisobot (Report)', '⏳ Kutilayotgan (Waiting)'],
    ['💸 Cashflow']
  ]).resize());
});

// ... [Reporting Logic hears() stay same as your working version] ...
bot.hears('📊 Hisobot (Report)', async (ctx) => {
    if (ctx.from.id.toString() !== MANAGER_ID) return;
    try {
      await doc.loadInfo();
      const rows = await doc.sheetsByTitle['Pending_Expenses'].getRows();
      const paid = rows.filter(r => r.get('Status') === 'PAID');
      let branchTotals = {};
      let grandTotal = 0;
      paid.forEach(r => {
        const b = r.get('Branch') || 'Noma\'lum';
        const val = parseInt(r.get('Amount') ? r.get('Amount').toString().replace(/[^0-9]/g, '') : '0') || 0;
        branchTotals[b] = (branchTotals[b] || 0) + val;
        grandTotal += val;
      });
      let msg = `📊 *Muvaffaqiyatli To'lovlar (PAID)*\n━━━━━━━━━━━━━━━\n💰 *Jami: ${grandTotal.toLocaleString('en-US')} UZS*\n\n🏢 *Filiallar bo'yicha:*\n`;
      branches.forEach(b => { msg += `• ${b}: ${(branchTotals[b] || 0).toLocaleString('en-US')} UZS\n`; });
      ctx.reply(msg, { parse_mode: 'Markdown' });
    } catch (e) { ctx.reply('❌ Xatolik.'); }
  });

  bot.hears('⏳ Kutilayotgan (Waiting)', async (ctx) => {
    if (ctx.from.id.toString() !== MANAGER_ID) return;
    try {
      await doc.loadInfo();
      const rows = await doc.sheetsByTitle['Pending_Expenses'].getRows();
      const waiting = rows.filter(r => r.get('Status') === 'SCHEDULED');
      if (waiting.length === 0) return ctx.reply("✅ Hozirda kutilayotgan to'lovlar yo'q.");
      let msg = `⏳ *Kutilayotgan To'lovlar ro'yxati*\n━━━━━━━━━━━━━━━\n`;
      let totalWait = 0;
      waiting.forEach(r => {
        const amt = parseInt(r.get('Amount') || 0);
        totalWait += amt;
        const priority = r.get('Priority') ? r.get('Priority').split('(')[0].trim() : "Normal";
        msg += `🗓 Sana: ${r.get('Scheduled Date')}\n📍 ${r.get('Branch')} - ${amt.toLocaleString('en-US')} UZS\n💳 To'lov: ${r.get('Payment Type')} (${r.get('Payment Detail')})\n📝 ${r.get('Description')} [${priority}]\n\n`;
      });
      msg += `━━━━━━━━━━━━━━━\n💰 *Jami Kutilayotgan:* ${totalWait.toLocaleString('en-US')} UZS`;
      ctx.reply(msg, { parse_mode: 'Markdown' });
    } catch (e) { ctx.reply('❌ Xatolik.'); }
  });

  bot.hears('💸 Cashflow', async (ctx) => {
    if (ctx.from.id.toString() !== MANAGER_ID) return;
    try {
      await doc.loadInfo();
      const rows = await doc.sheetsByTitle['Pending_Expenses'].getRows();
      const scheduled = rows.filter(r => r.get('Status') === 'SCHEDULED');
      let dates = {};
      let total = 0;
      scheduled.forEach(r => {
        const d = r.get('Scheduled Date');
        const amt = parseInt(r.get('Amount') || 0);
        dates[d] = (dates[d] || 0) + amt;
        total += amt;
      });
      const sortedDates = Object.keys(dates).sort();
      let msg = `💸 *CASHFLOW FORECAST*\n━━━━━━━━━━━━━━━\n`;
      sortedDates.forEach(d => { msg += `🗓 *${d}* ➔ ${dates[d].toLocaleString('en-US')} UZS\n`; });
      msg += `━━━━━━━━━━━━━━━\n💰 Jami: ${total.toLocaleString('en-US')} UZS`;
      ctx.reply(msg, { parse_mode: 'Markdown' });
    } catch (e) { ctx.reply('❌ Xatolik.'); }
  });

// ==========================================
// 2. DAILY REMINDERS (CRON JOB)
// ==========================================
cron.schedule('0 9 * * *', async () => {
  try {
    await doc.loadInfo();
    const rows = await doc.sheetsByTitle['Pending_Expenses'].getRows();
    const todayStr = getTodayStr();
    const dueToday = rows.filter(r => r.get('Status') === 'SCHEDULED' && r.get('Scheduled Date') === todayStr);

    for (let row of dueToday) {
      await bot.telegram.sendMessage(MANAGER_ID, `⏰ *ESLATMA: Bugun to'lov qilinishi kerak!*\n\n📍 ${row.get('Branch')}\n💵 ${Number(row.get('Amount')).toLocaleString('en-US')} UZS\n📝 ${row.get('Description')}\n\n*Chek rasmini REPLY qilib yuboring.*\nID: ${row.rowNumber}`, { parse_mode: 'Markdown' });
    }
  } catch (e) { console.error(e); }
}, { scheduled: true, timezone: "Asia/Tashkent" });

// ==========================================
// 3. THE REVERSED CHEQUE FLOW
// ==========================================
bot.on('photo', async (ctx) => {
  if (ctx.from.id.toString() !== MANAGER_ID) return;
  const reply = ctx.message.reply_to_message;
  if (reply && reply.text && reply.text.includes('ID:')) {
    const rowNum = reply.text.split('ID:')[1].trim();
    try {
      await doc.loadInfo();
      const rows = await doc.sheetsByTitle['Pending_Expenses'].getRows();
      const row = rows.find(r => r.rowNumber == rowNum);
      row.set('Status', 'CHEQUE_SENT'); await row.save();
      
      const staffId = row.get('_StaffChatId');
      await bot.telegram.sendPhoto(staffId, ctx.message.photo[0].file_id, {
        caption: `💰 *TO'LOV QILINDI!*\nSumma: ${Number(row.get('Amount')).toLocaleString('en-US')} UZS\n\nIltimos, pulni olganingizni tasdiqlang:`,
        ...Markup.inlineKeyboard([[Markup.button.callback('✅ Qabul qildim', `staffconfirm_${rowNum}`)]])
      });
      ctx.reply('✅ Chek xodimga yuborildi.');
    } catch (e) { console.error(e); }
  }
});

// ==========================================
// 4. NEW REQUEST WORKFLOW (Staff Side)
// ==========================================
bot.command(['start', 'new'], (ctx) => {
  userSessions[ctx.from.id] = { step: 'BRANCH' };
  ctx.reply('Filialni tanlang:', Markup.keyboard(branches, { columns: 2 }).resize());
});

bot.on('text', async (ctx) => {
  const uid = ctx.from.id.toString();
  const text = ctx.message.text;
  if (text.includes('Hisobot') || text.includes('Kutilayotgan') || text.includes('Cashflow')) return;
  const session = userSessions[uid];
  if (!session) return;

  if (session.step === 'BRANCH' && branches.includes(text)) {
    session.branch = text;
    session.step = 'CATEGORY';
    // SMART FILTER: Only 5 buttons for Marketing
    const menu = (text === '📍 Marketing') ? marketingCategories : categories;
    return ctx.reply('Kategoriyani tanlang:', Markup.keyboard([...menu, '❌ Bekor qilish (Cancel)'], { columns: 2 }).resize());
  }
  if (session.step === 'CATEGORY' && (categories.includes(text) || text === '❌ Bekor qilish (Cancel)')) {
    if (text.includes('Bekor')) { delete userSessions[uid]; return ctx.reply('Bekor qilindi.', Markup.keyboard(branches, { columns: 2 }).resize()); }
    session.category = text; session.step = 'AMOUNT'; return ctx.reply('Summani kiriting:');
  }
  if (session.step === 'AMOUNT') { session.amount = text.replace(/[^0-9]/g, ''); session.step = 'DESCRIPTION'; return ctx.reply('Xarajat sababi:'); }
  if (session.step === 'DESCRIPTION') { session.description = text; session.step = 'PRIORITY'; return ctx.reply('Muhimligi:', Markup.keyboard(priorities).resize()); }
  if (session.step === 'PRIORITY') { session.priority = text; session.step = 'PAY_TYPE'; return ctx.reply('To\'lov turi:', Markup.keyboard(['Karta', 'Naqd', 'MCHJ hisobi']).resize()); }
  if (session.step === 'PAY_TYPE') { 
    session.payType = text; 
    if (text === 'Naqd') { session.payDetail = 'N/A'; return askConfirmation(ctx, session); }
    session.step = 'PAY_DETAIL'; return ctx.reply('Karta raqami yoki Firma nomi:');
  }
  if (session.step === 'PAY_DETAIL') { session.payDetail = text; return askConfirmation(ctx, session); }
});

function askConfirmation(ctx, session) {
  const msg = `📍 ${session.branch}\n💰 ${Number(session.amount).toLocaleString('en-US')} UZS\n📝 ${session.description}\n⏰ ${session.priority}\n💳 ${session.payType}`;
  ctx.reply(`⚠️ *Tekshiring:*\n\n${msg}`, { parse_mode: 'Markdown', ...Markup.inlineKeyboard([[Markup.button.callback('✅ Yuborish', 'submit_final')], [Markup.button.callback('❌ Bekor qilish', 'cancel_final')]]) });
}

// ==========================================
// 5. CALLBACK HANDLERS
// ==========================================
bot.action('submit_final', async (ctx) => {
  const uid = ctx.from.id.toString();
  const s = userSessions[uid];
  if (!s) return;
  try {
    await doc.loadInfo();
    const row = await doc.sheetsByTitle['Pending_Expenses'].addRow({
      'Timestamp': new Date().toLocaleString(), 'Branch': s.branch, 'Staff Name': ctx.from.first_name, 'Amount': s.amount,
      'Payment Type': s.payType, 'Payment Detail': s.payDetail, 'Description': `[${s.category}] ${s.description}`,
      'Status': 'PENDING', '_StaffChatId': uid, 'Priority': s.priority
    });

    const audit = await getMasterAudit(s.branch, s.category, s.amount);
    await bot.telegram.sendMessage(MANAGER_ID, `🏢 *Yangi So'rov*\n📍 ${s.branch}\n👤 ${ctx.from.first_name}\n💵 ${Number(s.amount).toLocaleString('en-US')} UZS\n💬 ${s.description}${audit}`, {
      parse_mode: 'Markdown',
      ...Markup.inlineKeyboard([[Markup.button.callback('✅ Tasdiqlash', `decide_${row.rowNumber}`)], [Markup.button.callback('❌ Rad etish', `rej_${row.rowNumber}`)]])
    });
    ctx.editMessageText('✅ Yuborildi.');
    delete userSessions[uid];
  } catch (e) { console.error(e); }
});

bot.action(/^staffconfirm_(\d+)$/, async (ctx) => {
  await doc.loadInfo();
  const row = (await doc.sheetsByTitle['Pending_Expenses'].getRows()).find(r => r.rowNumber == ctx.match[1]);
  row.set('Status', 'PAID'); await row.save();
  ctx.editMessageCaption('✅ *PUL QABUL QILINDI.*', { parse_mode: 'Markdown' });
  bot.telegram.sendMessage(MANAGER_ID, `✅ ID: ${ctx.match[1]} yopildi (PAID).`);
});

bot.action(/^(decide|paynow|schedD|rej)_(\d+)(?:_(\d+))?$/, async (ctx) => {
  const [action, rowNum, param] = [ctx.match[1], ctx.match[2], ctx.match[3]];
  await doc.loadInfo();
  const rows = await doc.sheetsByTitle['Pending_Expenses'].getRows();
  const row = rows.find(r => r.rowNumber == rowNum);
  const staffId = row.get('_StaffChatId');

  if (action === 'decide') {
    return ctx.editMessageText(`💸 Qachon to'laysiz?`, Markup.inlineKeyboard([
      [Markup.button.callback('✅ Hozir', `paynow_${rowNum}`)],
      [Markup.button.callback('🗓 Dushanba', `schedD_${rowNum}_1`), Markup.button.callback('🗓 Seshanba', `schedD_${rowNum}_2`)],
      [Markup.button.callback('❌ Rad etish', `rej_${rowNum}`)]
    ]));
  }
  
  const date = action === 'paynow' ? getTodayStr() : getScheduledDateStr('D', parseInt(param));
  row.set('Status', action === 'rej' ? 'REJECTED' : 'SCHEDULED');
  if (action !== 'rej') row.set('Scheduled Date', date);
  await row.save();
  
  bot.telegram.sendMessage(staffId, action === 'rej' ? '❌ Rad etildi.' : `⏳ Tasdiqlandi. Sana: ${date}`);
  ctx.editMessageText(action === 'rej' ? '❌ Rad etildi.' : `🗓 ${date} sanasiga rejalashtirildi.`);
});

bot.launch();
