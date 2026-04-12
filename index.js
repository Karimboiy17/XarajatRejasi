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

// --- LISTS ---
const branches = ['📍 Integro', '📍 Drujba', '📍 Amir Temur', '📍 Central', '📍 Marketing'];
const categories = ['tugilgan kun uchun', 'printer rang', 'Printer tuzatish', 'remont-tuzatish', 'Hodimlar uchun dorilar', 'jihoz', 'Texnikalar', 'Transport', 'aromatizator', 'Internet', 'Telefon', 'of the month', 'Event', 'Reklama mahsulotlarini chiqarish', 'giftbox sovgalar', 'syomka xarajatlari', 'bozorlik xojalik', 'Suv va stakan', 'Konstovar', 'Plastik foizi', 'ofis xarajatlari', 'remont qurilish'];
const marketingCategories = ['syomka xarajatlari', 'Reklama mahsulotlarini chiqarish', 'giftbox sovgalar', 'Event', 'Transport'];
const priorities = ["🔴 O'ta muhim (Bugun)", "🟡 O'rtacha (Ertaga)", "🔵 Normal (Shu hafta)", "🟢 Shoshilinch emas (Shu oy)"];

// --- UTILS (Time & Date) ---
function getTashkentDate() { return new Date(new Date().getTime() + (5 * 60 * 60 * 1000)); }
function getTodayStr() { return getTashkentDate().toISOString().split('T')[0]; }

function getScheduledDateStr(type, param) {
  const now = getTashkentDate();
  if (type === 'D') {
    const currentDay = now.getUTCDay();
    let distance = param - currentDay;
    if (distance <= 0) distance += 7;
    now.setUTCDate(now.getUTCDate() + distance);
  } else if (type === 'F') {
    now.setUTCDate(now.getUTCDate() + param);
  }
  return now.toISOString().split('T')[0];
}

// --- CORE ENGINE: DOUBLE AUDIT ---
async function getMasterAudit(branch, category, amountStr) {
  try {
    await doc.loadInfo();
    const budgetRows = await doc.sheetsByTitle['Budgets'].getRows();
    const expenseRows = await doc.sheetsByTitle['Pending_Expenses'].getRows();
    const requested = parseInt(amountStr);
    const now = getTashkentDate();
    const lastMonthDate = new Date(now.getFullYear(), now.getMonth() - 1, 1);

    // 1. Find Limits
    const bLimitRow = budgetRows.find(r => r.get('Branch') === branch && (!r.get('Category') || r.get('Category').trim() === ''));
    const cLimitRow = budgetRows.find(r => r.get('Branch') === branch && r.get('Category') === category);
    
    const branchLimit = bLimitRow ? parseInt(bLimitRow.get('Monthly Limit').replace(/[^0-9]/g, '')) : Infinity;
    const catLimit = cLimitRow ? parseInt(cLimitRow.get('Monthly Limit').replace(/[^0-9]/g, '')) : Infinity;

    // 2. Calculate Burned Money
    let branchSpent = 0, catSpent = 0, lastMonthCatSpent = 0;

    expenseRows.forEach(r => {
      const status = r.get('Status');
      const amt = parseInt(r.get('Amount')?.toString().replace(/[^0-9]/g, '') || '0');
      const rowDate = new Date(r.get('Timestamp'));
      
      if (r.get('Branch') === branch && ['PAID', 'SCHEDULED', 'CHEQUE_SENT'].includes(status)) {
        if (rowDate.getMonth() === now.getMonth() && rowDate.getFullYear() === now.getFullYear()) {
          branchSpent += amt;
          if (r.get('Description').includes(`[${category}]`)) catSpent += amt;
        }
        if (rowDate.getMonth() === lastMonthDate.getMonth() && rowDate.getFullYear() === lastMonthDate.getFullYear()) {
          if (r.get('Description').includes(`[${category}]`)) lastMonthCatSpent += amt;
        }
      }
    });

    // 3. Build Report
    let report = `\n\n📊 *Audit:*`;
    if (catLimit !== Infinity && requested > (catLimit * 0.5)) report += `\n🚨 *Yirik xarajat (Limitning 50%+ qismi)!*`;
    
    const bRemaining = branchLimit - branchSpent - requested;
    report += `\n📍 Filial qoldig'i: ${branchLimit === Infinity ? 'Cheksiz' : bRemaining.toLocaleString() + ' UZS'}`;
    
    if (catLimit !== Infinity) {
      const cRemaining = catLimit - catSpent - requested;
      report += `\n📂 Kategoriya (${category}): ${cRemaining < 0 ? '❌ LIMITDAN OSHDI' : cRemaining.toLocaleString() + ' UZS qoldi'}`;
    }
    
    if (lastMonthCatSpent > 0) report += `\n📜 O'tgan oy sarfi: ${lastMonthCatSpent.toLocaleString()} UZS`;
    
    return report;
  } catch (e) { console.error("Audit Error:", e); return ''; }
}

// ==========================================
// 1. MANAGER PANEL & REPORTS
// ==========================================
bot.command('admin', (ctx) => {
  if (ctx.from.id.toString() !== MANAGER_ID) return;
  ctx.reply('👨‍💼 Procurement Panel:', Markup.keyboard([
    ['📊 Hisobot', '⏳ Kutilayotgan'],
    ['💸 Cashflow']
  ]).resize());
});

bot.hears('⏳ Kutilayotgan', async (ctx) => {
  if (ctx.from.id.toString() !== MANAGER_ID) return;
  try {
    await doc.loadInfo();
    const rows = await doc.sheetsByTitle['Pending_Expenses'].getRows();
    const waiting = rows.filter(r => r.get('Status') === 'SCHEDULED');
    if (waiting.length === 0) return ctx.reply("✅ Kutilayotgan to'lovlar yo'q.");
    
    let msg = `⏳ *Kutilayotgan To'lovlar*\n━━━━━━━━━━━━━━━\n`;
    let total = 0;
    waiting.forEach(r => {
      const amt = parseInt(r.get('Amount')) || 0;
      total += amt;
      msg += `🗓 ${r.get('Scheduled Date')} | 📍 ${r.get('Branch')}\n💵 ${amt.toLocaleString()} UZS\n💳 ${r.get('Payment Type')} (${r.get('Payment Detail')})\n📝 ${r.get('Description')}\n\n`;
    });
    msg += `💰 *Jami: ${total.toLocaleString()} UZS*`;
    ctx.reply(msg, { parse_mode: 'Markdown' });
  } catch (e) { ctx.reply('❌ Xatolik yuz berdi.'); }
});

bot.hears('💸 Cashflow', async (ctx) => {
  if (ctx.from.id.toString() !== MANAGER_ID) return;
  try {
    await doc.loadInfo();
    const rows = await doc.sheetsByTitle['Pending_Expenses'].getRows();
    const scheduled = rows.filter(r => r.get('Status') === 'SCHEDULED');
    let dates = {}, total = 0;
    scheduled.forEach(r => {
      const d = r.get('Scheduled Date');
      const amt = parseInt(r.get('Amount') || 0);
      dates[d] = (dates[d] || 0) + amt;
      total += amt;
    });
    const sorted = Object.keys(dates).sort();
    let msg = `💸 *Cashflow Forecast*\n━━━━━━━━━━━━━━━\n`;
    sorted.forEach(d => { msg += `🗓 *${d}* ➔ ${dates[d].toLocaleString()} UZS\n`; });
    msg += `━━━━━━━━━━━━━━━\n💰 Jami: ${total.toLocaleString()} UZS`;
    ctx.reply(msg, { parse_mode: 'Markdown' });
  } catch (e) { ctx.reply('❌ Xatolik yuz berdi.'); }
});

bot.hears('📊 Hisobot', async (ctx) => {
  if (ctx.from.id.toString() !== MANAGER_ID) return;
  try {
    await doc.loadInfo();
    const rows = await doc.sheetsByTitle['Pending_Expenses'].getRows();
    const paid = rows.filter(r => r.get('Status') === 'PAID');
    let branchTotals = {}, grandTotal = 0;
    paid.forEach(r => {
      const b = r.get('Branch') || 'Boshqa';
      const val = parseInt(r.get('Amount')?.toString().replace(/[^0-9]/g, '') || '0');
      branchTotals[b] = (branchTotals[b] || 0) + val;
      grandTotal += val;
    });
    let msg = `📊 *Tasdiqlangan Xarajatlar (PAID)*\n━━━━━━━━━━━━━━━\n💰 *Jami: ${grandTotal.toLocaleString()} UZS*\n\n`;
    branches.forEach(b => { msg += `• ${b}: ${(branchTotals[b] || 0).toLocaleString()} UZS\n`; });
    ctx.reply(msg, { parse_mode: 'Markdown' });
  } catch (e) { ctx.reply('❌ Xatolik yuz berdi.'); }
});

// ==========================================
// 2. MANAGER REVERSED CHEQUE FLOW
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
      if (!row) return ctx.reply('❌ Qator topilmadi.');
      
      row.set('Status', 'CHEQUE_SENT'); 
      await row.save();
      
      await bot.telegram.sendPhoto(row.get('_StaffChatId'), ctx.message.photo[0].file_id, {
        caption: `💰 *TO'LOV QILINDI!*\nSumma: ${Number(row.get('Amount')).toLocaleString()} UZS\n\nIltimos, pulni olganingizni tasdiqlang:`,
        parse_mode: 'Markdown',
        ...Markup.inlineKeyboard([[Markup.button.callback('✅ Qabul qildim', `confirm_${rowNum}`)]])
      });
      ctx.reply('✅ Chek xodimga yuborildi.');
    } catch (e) { console.error("Photo Error:", e); ctx.reply('❌ Xatolik yuz berdi.'); }
  }
});

// ==========================================
// 3. STAFF REQUEST WORKFLOW
// ==========================================
bot.command(['start', 'new'], (ctx) => {
  userSessions[ctx.from.id] = { step: 'BRANCH' };
  ctx.reply('Filialni tanlang:', Markup.keyboard(branches, { columns: 2 }).resize());
});

bot.hears('❌ Bekor qilish', (ctx) => {
  delete userSessions[ctx.from.id];
  ctx.reply('❌ Bekor qilindi. Yangi so\'rov uchun filialni tanlang:', Markup.keyboard(branches, { columns: 2 }).resize());
});

bot.on('text', async (ctx) => {
  const uid = ctx.from.id.toString();
  const text = ctx.message.text;
  
  // Ignore manager commands
  if (['📊 Hisobot', '⏳ Kutilayotgan', '💸 Cashflow'].includes(text)) return;
  
  const s = userSessions[uid];
  if (!s || text.startsWith('/')) return;

  if (s.step === 'BRANCH' && branches.includes(text)) {
    s.branch = text; 
    s.step = 'CATEGORY';
    const menu = (text === '📍 Marketing') ? marketingCategories : categories;
    return ctx.reply('Kategoriyani tanlang:', Markup.keyboard([...menu, '❌ Bekor qilish'], { columns: 2 }).resize());
  }
  
  if (s.step === 'CATEGORY' && (categories.includes(text) || marketingCategories.includes(text))) { 
    s.category = text; 
    s.step = 'AMOUNT'; 
    return ctx.reply('Summani kiriting (Faqat raqam):', Markup.keyboard(['❌ Bekor qilish']).resize()); 
  }
  
  if (s.step === 'AMOUNT') { 
    s.amount = text.replace(/[^0-9]/g, ''); 
    if (!s.amount) return ctx.reply('Iltimos, faqat raqam kiriting:');
    s.step = 'DESCRIPTION'; 
    return ctx.reply('Xarajat sababini yozing:'); 
  }
  
  if (s.step === 'DESCRIPTION') { 
    s.description = text; 
    s.step = 'PRIORITY'; 
    return ctx.reply('Muhimligi:', Markup.keyboard([...priorities, '❌ Bekor qilish'], {columns: 1}).resize()); 
  }
  
  if (s.step === 'PRIORITY' && priorities.includes(text)) { 
    s.priority = text; 
    s.step = 'PAY_TYPE'; 
    return ctx.reply('To\'lov turi:', Markup.keyboard(['Karta', 'Naqd', 'MCHJ hisobi', '❌ Bekor qilish'], {columns: 2}).resize()); 
  }
  
  if (s.step === 'PAY_TYPE' && ['Karta', 'Naqd', 'MCHJ hisobi'].includes(text)) {
    s.payType = text; 
    if (text === 'Naqd') { 
      s.payDetail = 'N/A'; 
      return showConfirmation(ctx, s); 
    }
    s.step = 'PAY_DETAIL'; 
    return ctx.reply(text === 'Karta' ? 'Karta raqamini kiriting:' : 'Firma nomini kiriting:');
  }
  
  if (s.step === 'PAY_DETAIL') { 
    s.payDetail = text; 
    return showConfirmation(ctx, s); 
  }
});

function showConfirmation(ctx, s) {
  const msg = `📍 Filial: ${s.branch}\n💰 Summa: ${Number(s.amount).toLocaleString()} UZS\n📂 Kategoriya: ${s.category}\n📝 Sabab: ${s.description}\n⏰ Muhimlik: ${s.priority}\n💳 To'lov: ${s.payType} (${s.payDetail})`;
  ctx.reply(`⚠️ *Ma'lumotlarni tekshiring:*\n\n${msg}`, { 
    parse_mode: 'Markdown', 
    ...Markup.inlineKeyboard([
      [Markup.button.callback('✅ Yuborish', 'submit')], 
      [Markup.button.callback('❌ Bekor qilish', 'cancel_req')]
    ]) 
  });
}

// ==========================================
// 4. BUTTON CLICK (CALLBACK) HANDLERS
// ==========================================

// Staff cancels at the final step
bot.action('cancel_req', (ctx) => {
  delete userSessions[ctx.from.id];
  ctx.editMessageText('❌ So\'rov bekor qilindi.');
  ctx.reply('Filialni tanlang:', Markup.keyboard(branches, { columns: 2 }).resize());
});

// Staff submits
bot.action('submit', async (ctx) => {
  const uid = ctx.from.id.toString();
  const s = userSessions[uid];
  
  if (!s) {
    return ctx.answerCbQuery('❌ Xatolik: Sessiya eskirdi, boshidan boshlang.', { show_alert: true });
  }

  try {
    await doc.loadInfo();
    const row = await doc.sheetsByTitle['Pending_Expenses'].addRow({
      'Timestamp': new Date().toLocaleString(),
      'Branch': s.branch,
      'Staff Name': ctx.from.first_name,
      'Amount': s.amount,
      'Payment Type': s.payType,
      'Payment Detail': s.payDetail,
      'Description': `[${s.category}] ${s.description}`,
      'Status': 'PENDING',
      '_StaffChatId': uid,
      'Priority': s.priority
    });

    const audit = await getMasterAudit(s.branch, s.category, s.amount);
    
    await bot.telegram.sendMessage(MANAGER_ID, `🏢 *YANGI SO'ROV*\n👤 ${ctx.from.first_name}\n📍 ${s.branch}\n💵 ${Number(s.amount).toLocaleString()} UZS\n💳 ${s.payType} (${s.payDetail})\n💬 ${s.description}${audit}`, {
      parse_mode: 'Markdown',
      ...Markup.inlineKeyboard([
        [Markup.button.callback('✅ Tasdiqlash', `decide_${row.rowNumber}`)], 
        [Markup.button.callback('❌ Rad etish', `rej_${row.rowNumber}`)]
      ])
    });

    delete userSessions[uid]; // PREVENTS STUCK BUG
    ctx.editMessageText('✅ So\'rov menejerga yuborildi!');
    ctx.reply('Filialni tanlang:', Markup.keyboard(branches, { columns: 2 }).resize());
  } catch (e) {
    console.error(e);
    ctx.answerCbQuery('❌ Xatolik yuz berdi. Qaytadan urinib ko\'ring.');
  }
});

// Manager Action: Decide Time
bot.action(/^decide_(\d+)$/, async (ctx) => {
  const rowNum = ctx.match[1];
  try {
    await ctx.editMessageReplyMarkup({
      inline_keyboard: [
        [Markup.button.callback('✅ Hozir To\'lash', `paynow_${rowNum}`)],
        [Markup.button.callback('🗓 Dushanba', `schedD_${rowNum}_1`), Markup.button.callback('🗓 Seshanba', `schedD_${rowNum}_2`)],
        [Markup.button.callback('🗓 Chorshanba', `schedD_${rowNum}_3`), Markup.button.callback('🗓 Payshanba', `schedD_${rowNum}_4`)],
        [Markup.button.callback('🗓 Juma', `schedD_${rowNum}_5`)],
        [Markup.button.callback('❌ Rad etish', `rej_${rowNum}`)]
      ]
    });
  } catch (e) { ctx.answerCbQuery('Xatolik.'); }
});

// Manager Action: Execute Schedule or Reject
bot.action(/^(paynow|schedD|rej)_(\d+)(?:_(\d+))?$/, async (ctx) => {
  const action = ctx.match[1];
  const rowNum = ctx.match[2];
  const param = ctx.match[3];
  
  try {
    await doc.loadInfo();
    const rows = await doc.sheetsByTitle['Pending_Expenses'].getRows();
    const row = rows.find(r => r.rowNumber == rowNum);
    if (!row) return ctx.answerCbQuery('❌ Qator topilmadi.');

    const staffId = row.get('_StaffChatId');

    if (action === 'rej') {
      row.set('Status', 'REJECTED');
      await row.save();
      bot.telegram.sendMessage(staffId, `❌ So'rovingiz rad etildi.`);
      return ctx.editMessageText(`❌ Rad etildi. (ID: ${rowNum})`);
    }

    const targetDate = action === 'paynow' ? getTodayStr() : getScheduledDateStr('D', parseInt(param));
    
    row.set('Status', 'SCHEDULED');
    row.set('Scheduled Date', targetDate);
    await row.save();

    const statusMsg = action === 'paynow' ? "✅ Hozir to'lanadi." : `⏳ Tasdiqlandi. Sana: ${targetDate}`;
    bot.telegram.sendMessage(staffId, statusMsg);
    
    ctx.editMessageText(`🗓 ${targetDate} sanasiga rejalashtirildi. To'lov qilingach chekni shu xabarga Reply qilib yuboring. ID: ${rowNum}`);
  } catch (e) {
    console.error(e);
    ctx.answerCbQuery('❌ Xatolik yuz berdi.');
  }
});

// Staff Action: Confirm Receipt
bot.action(/^confirm_(\d+)$/, async (ctx) => {
  const rowNum = ctx.match[1];
  try {
    await doc.loadInfo();
    const rows = await doc.sheetsByTitle['Pending_Expenses'].getRows();
    const row = rows.find(r => r.rowNumber == rowNum);
    if (!row) return ctx.answerCbQuery('Xatolik.');

    row.set('Status', 'PAID'); 
    await row.save();
    
    // Edit the message to remove the button (PREVENTS STUCK BUG)
    ctx.editMessageCaption('✅ *PUL QABUL QILINDI.*', { parse_mode: 'Markdown' });
    bot.telegram.sendMessage(MANAGER_ID, `✅ Xodim to'lovni qabul qildi. ID: ${rowNum} yopildi.`);
  } catch (e) {
    ctx.answerCbQuery('❌ Xatolik yuz berdi.');
  }
});

// ==========================================
// 5. CRON JOB (9 AM ALARM)
// ==========================================
cron.schedule('0 9 * * *', async () => {
  try {
    await doc.loadInfo();
    const rows = await doc.sheetsByTitle['Pending_Expenses'].getRows();
    const todayStr = getTodayStr();
    const dueToday = rows.filter(r => r.get('Status') === 'SCHEDULED' && r.get('Scheduled Date') === todayStr);

    for (let row of dueToday) {
      await bot.telegram.sendMessage(MANAGER_ID, `⏰ *ESLATMA: Bugun to'lov qilinishi kerak!*\n\n📍 ${row.get('Branch')}\n💵 ${Number(row.get('Amount')).toLocaleString()} UZS\n📝 ${row.get('Description')}\n\n*Chek rasmini shu xabarga REPLY qilib yuboring.*\nID: ${row.rowNumber}`, { parse_mode: 'Markdown' });
    }
  } catch (e) { console.error(e); }
}, { scheduled: true, timezone: "Asia/Tashkent" });

bot.launch();
