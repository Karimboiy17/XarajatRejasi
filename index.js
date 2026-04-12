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
const userSessions = {}; // Stores temporary user data. STRICTLY DELETED after use.

// --- STATIC LISTS ---
const branches = ['📍 Integro', '📍 Drujba', '📍 Amir Temur', '📍 Central', '📍 Marketing'];
const categories = ['tugilgan kun uchun', 'printer rang', 'Printer tuzatish', 'remont-tuzatish', 'Hodimlar uchun dorilar', 'jihoz', 'Texnikalar', 'Transport', 'aromatizator', 'Internet', 'Telefon', 'of the month', 'Event', 'Reklama mahsulotlarini chiqarish', 'giftbox sovgalar', 'syomka xarajatlari', 'bozorlik xojalik', 'Suv va stakan', 'Konstovar', 'Plastik foizi', 'ofis xarajatlari', 'remont qurilish'];
const marketingCategories = ['syomka xarajatlari', 'Reklama mahsulotlarini chiqarish', 'giftbox sovgalar', 'Event', 'Transport'];
const priorities = ["🔴 O'ta muhim (Bugun)", "🟡 O'rtacha (Ertaga)", "🔵 Normal (Shu hafta)", "🟢 Shoshilinch emas (Shu oy)"];

// --- TIME UTILS ---
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

// --- MASTER AUDIT ENGINE ---
async function getMasterAudit(branch, category, amountStr) {
  try {
    await doc.loadInfo();
    const budgetRows = await doc.sheetsByTitle['Budgets'].getRows();
    const expenseRows = await doc.sheetsByTitle['Pending_Expenses'].getRows();
    const requested = parseInt(amountStr);
    const now = getTashkentDate();
    const lastMonthDate = new Date(now.getFullYear(), now.getMonth() - 1, 1);

    const bLimitRow = budgetRows.find(r => r.get('Branch') === branch && (!r.get('Category') || r.get('Category').trim() === ''));
    const cLimitRow = budgetRows.find(r => r.get('Branch') === branch && r.get('Category') === category);
    
    const branchLimit = bLimitRow ? parseInt(bLimitRow.get('Monthly Limit').replace(/[^0-9]/g, '')) : Infinity;
    const catLimit = cLimitRow ? parseInt(cLimitRow.get('Monthly Limit').replace(/[^0-9]/g, '')) : Infinity;

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

    let report = `\n\n📊 *Audit:*`;
    if (catLimit !== Infinity && requested > (catLimit * 0.5)) report += `\n🚨 *Yirik xarajat (Limitning 50%+ qismi)!*`;
    
    const bRemaining = branchLimit - branchSpent - requested;
    report += `\n📍 Filial qoldig'i: ${branchLimit === Infinity ? 'Cheksiz' : bRemaining.toLocaleString() + ' UZS'}`;
    
    if (catLimit !== Infinity) {
      const cRemaining = catLimit - catSpent - requested;
      report += `\n📂 ${category}: ${cRemaining < 0 ? '❌ LIMITDAN OSHDI' : cRemaining.toLocaleString() + ' UZS qoldi'}`;
    }
    if (lastMonthCatSpent > 0) report += `\n📜 O'tgan oy sarfi: ${lastMonthCatSpent.toLocaleString()} UZS`;
    
    return report;
  } catch (e) { return '\n\n⚠️ Audit vaqtida xatolik yuz berdi.'; }
}

// ==========================================
// 1. MANAGER PANEL (UPGRADED ANALYTICS)
// ==========================================
bot.command('admin', (ctx) => {
  if (ctx.from.id.toString() !== MANAGER_ID) return;
  ctx.reply('👨‍💼 Procurement Panel:', Markup.keyboard([['📊 Hisobot', '⏳ Kutilayotgan'], ['💸 Cashflow']]).resize());
});

bot.hears('📊 Hisobot', async (ctx) => {
  if (ctx.from.id.toString() !== MANAGER_ID) return;
  try {
    await doc.loadInfo();
    const rows = await doc.sheetsByTitle['Pending_Expenses'].getRows();
    const paid = rows.filter(r => r.get('Status') === 'PAID');
    let staffData = {}, grandTotal = 0;

    paid.forEach(r => {
      const staff = r.get('Staff Name') || 'Noma\'lum xodim';
      const amt = parseInt(r.get('Amount')?.toString().replace(/[^0-9]/g, '') || '0');
      let category = 'Boshqa';
      const match = (r.get('Description') || '').match(/\[(.*?)\]/);
      if (match) category = match[1];

      if (!staffData[staff]) staffData[staff] = { total: 0, categories: {} };
      staffData[staff].total += amt;
      staffData[staff].categories[category] = (staffData[staff].categories[category] || 0) + amt;
      grandTotal += amt;
    });

    let msg = `📊 *Batafsil Hisobot (PAID)*\n━━━━━━━━━━━━━━━\n💰 *Jami sarflangan: ${grandTotal.toLocaleString()} UZS*\n\n`;
    for (const [staff, data] of Object.entries(staffData)) {
      msg += `👤 *${staff}* (${data.total.toLocaleString()} UZS):\n`;
      for (const [cat, amt] of Object.entries(data.categories)) { msg += `   └ 📂 ${cat}: ${amt.toLocaleString()} UZS\n`; }
      msg += `\n`;
    }
    ctx.reply(msg, { parse_mode: 'Markdown' });
  } catch (e) { ctx.reply('❌ Xatolik yuz berdi.'); }
});

bot.hears('⏳ Kutilayotgan', async (ctx) => {
  if (ctx.from.id.toString() !== MANAGER_ID) return;
  try {
    await doc.loadInfo();
    const rows = await doc.sheetsByTitle['Pending_Expenses'].getRows();
    const waiting = rows.filter(r => ['SCHEDULED', 'PENDING'].includes(r.get('Status')));
    if (waiting.length === 0) return ctx.reply("✅ Hozirda kutilayotgan so'rovlar yo'q.");
    
    let msg = `⏳ *Kutilayotgan To'lovlar*\n━━━━━━━━━━━━━━━\n`;
    let total = 0;
    waiting.forEach(r => {
      const amt = parseInt(r.get('Amount')?.toString().replace(/[^0-9]/g, '') || '0');
      total += amt;
      const statusText = r.get('Status') === 'SCHEDULED' ? `🗓 To'lov kuni: *${r.get('Scheduled Date')}*` : `🟡 *Tasdiq kutilmoqda*`;
      msg += `👤 *${r.get('Staff Name')}* (📍 ${r.get('Branch')})\n💵 Summa: ${amt.toLocaleString()} UZS\n💳 To'lov: *${r.get('Payment Type')}* (${r.get('Payment Detail')})\n${statusText}\n📝 ${r.get('Description')}\n\n`;
    });
    msg += `━━━━━━━━━━━━━━━\n💰 *Jami Kutilayotgan: ${total.toLocaleString()} UZS*`;
    ctx.reply(msg, { parse_mode: 'Markdown' });
  } catch (e) { ctx.reply('❌ Xatolik yuz berdi.'); }
});

bot.hears('💸 Cashflow', async (ctx) => {
  if (ctx.from.id.toString() !== MANAGER_ID) return;
  try {
    await doc.loadInfo();
    const rows = await doc.sheetsByTitle['Pending_Expenses'].getRows();
    
    const scheduled = rows.filter(r => r.get('Status') === 'SCHEDULED');
    let dates = {}, totalOut = 0;
    scheduled.forEach(r => {
      const d = r.get('Scheduled Date') || 'Noma\'lum';
      const amt = parseInt(r.get('Amount')?.toString().replace(/[^0-9]/g, '') || '0');
      dates[d] = (dates[d] || 0) + amt;
      totalOut += amt;
    });

    const rejected = rows.filter(r => r.get('Status') === 'REJECTED');
    let totalRejected = 0;
    rejected.forEach(r => { totalRejected += parseInt(r.get('Amount')?.toString().replace(/[^0-9]/g, '') || '0'); });

    let msg = `💸 *CASHFLOW & ANALITIKA*\n━━━━━━━━━━━━━━━\n📈 *Chiqib ketishi kutilayotgan:*\n`;
    const sorted = Object.keys(dates).sort();
    if (sorted.length > 0) { sorted.forEach(d => { msg += `🗓 *${d}* ➔ ${dates[d].toLocaleString()} UZS\n`; }); } 
    else { msg += `Rejalashtirilgan to'lovlar yo'q.\n`; }
    
    msg += `\n💰 *Jami chiqadigan: ${totalOut.toLocaleString()} UZS*\n━━━━━━━━━━━━━━━\n🚫 *Rad etilgan (Saqlab qolingan) mablag':*\n📉 *Jami: ${totalRejected.toLocaleString()} UZS*`;
    ctx.reply(msg, { parse_mode: 'Markdown' });
  } catch (e) { ctx.reply('❌ Xatolik yuz berdi.'); }
});

// ==========================================
// 2. REVERSED CHEQUE FLOW (Manager Side)
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
      ctx.reply('✅ Chek xodimga yuborildi va tasdiqlash kutilmoqda.');
    } catch (e) { ctx.reply('❌ Xatolik yuz berdi.'); }
  }
});

// ==========================================
// 3. STAFF WORKFLOW (WITH VOICE/VIDEO SUPPORT)
// ==========================================
bot.command(['start', 'new'], (ctx) => {
  delete userSessions[ctx.from.id.toString()]; // Wipe any stuck session
  userSessions[ctx.from.id.toString()] = { step: 'BRANCH' };
  ctx.reply('Filialni tanlang:', Markup.keyboard(branches, { columns: 2 }).resize());
});

bot.hears('❌ Bekor qilish', (ctx) => {
  delete userSessions[ctx.from.id.toString()];
  ctx.reply('❌ So\'rov bekor qilindi. Boshlash uchun filialni tanlang:', Markup.keyboard(branches, { columns: 2 }).resize());
});

// Using 'message' to catch Text, Voice, and Video
bot.on('message', async (ctx) => {
  const uid = ctx.from.id.toString();
  const text = ctx.message.text || '';
  
  // Ignore manager commands
  if (['📊 Hisobot', '⏳ Kutilayotgan', '💸 Cashflow'].includes(text)) return;
  
  const s = userSessions[uid];
  if (!s || text.startsWith('/')) return;

  if (s.step === 'BRANCH' && text && branches.includes(text)) {
    s.branch = text; s.step = 'CATEGORY';
    const menu = (text === '📍 Marketing') ? marketingCategories : categories;
    return ctx.reply('Kategoriyani tanlang:', Markup.keyboard([...menu, '❌ Bekor qilish'], { columns: 2 }).resize());
  }
  
  if (s.step === 'CATEGORY' && text && (categories.includes(text) || marketingCategories.includes(text))) { 
    s.category = text; s.step = 'AMOUNT'; 
    return ctx.reply('Summani kiriting (Faqat raqam):', Markup.keyboard(['❌ Bekor qilish']).resize()); 
  }
  
  if (s.step === 'AMOUNT' && text) { 
    s.amount = text.replace(/[^0-9]/g, ''); 
    if (!s.amount) return ctx.reply('Iltimos, faqat raqam kiriting:');
    s.step = 'DESCRIPTION'; 
    return ctx.reply('Xarajat sababini yozing (Yoki Ovozli xabar / Video yuboring):'); 
  }
  
  // VOICE, VIDEO, OR TEXT SUPPORT
  if (s.step === 'DESCRIPTION') { 
    if (ctx.message.voice) {
      s.description = '🎙 [Ovozli xabar]';
      s.mediaId = ctx.message.message_id;
    } else if (ctx.message.video || ctx.message.video_note) {
      s.description = '📹 [Video xabar]';
      s.mediaId = ctx.message.message_id;
    } else if (text) {
      s.description = text;
    } else {
      return ctx.reply('Iltimos, matn, ovozli xabar yoki video yuboring.');
    }
    s.step = 'PRIORITY'; 
    return ctx.reply('Muhimligi:', Markup.keyboard([...priorities, '❌ Bekor qilish'], {columns: 1}).resize()); 
  }
  
  if (s.step === 'PRIORITY' && text && priorities.includes(text)) { 
    s.priority = text; s.step = 'PAY_TYPE'; 
    return ctx.reply('To\'lov turi:', Markup.keyboard(['Karta', 'Naqd', 'MCHJ hisobi', '❌ Bekor qilish'], {columns: 2}).resize()); 
  }
  
  if (s.step === 'PAY_TYPE' && text && ['Karta', 'Naqd', 'MCHJ hisobi'].includes(text)) {
    s.payType = text; 
    if (text === 'Naqd') { s.payDetail = 'N/A'; return showConfirmation(ctx, s); }
    s.step = 'PAY_DETAIL'; 
    return ctx.reply(text === 'Karta' ? 'Karta raqamini kiriting:' : 'Firma nomini kiriting:');
  }
  
  if (s.step === 'PAY_DETAIL' && text) { 
    s.payDetail = text; 
    return showConfirmation(ctx, s); 
  }
});

function showConfirmation(ctx, s) {
  const msg = `📍 Filial: ${s.branch}\n💰 Summa: ${Number(s.amount).toLocaleString()} UZS\n📂 Kategoriya: ${s.category}\n📝 Sabab: ${s.description}\n⏰ Muhimlik: ${s.priority}\n💳 To'lov: ${s.payType} (${s.payDetail})`;
  ctx.reply(`⚠️ *Ma'lumotlarni tekshiring:*\n\n${msg}`, { 
    parse_mode: 'Markdown', 
    ...Markup.inlineKeyboard([[Markup.button.callback('✅ Yuborish', 'submit')], [Markup.button.callback('❌ Bekor qilish', 'cancel_req')]]) 
  });
}

// ==========================================
// 4. BULLETPROOF BUTTON LOGIC
// ==========================================
bot.action('cancel_req', (ctx) => {
  delete userSessions[ctx.from.id.toString()];
  ctx.answerCbQuery('Bekor qilindi');
  ctx.editMessageText('❌ So\'rov bekor qilindi.');
  ctx.reply('Filialni tanlang:', Markup.keyboard(branches, { columns: 2 }).resize());
});

bot.action('submit', async (ctx) => {
  const uid = ctx.from.id.toString();
  const s = userSessions[uid];
  
  if (!s) {
    return ctx.answerCbQuery('❌ Sessiya eskirdi. Boshidan boshlang.', { show_alert: true });
  }

  try {
    ctx.answerCbQuery('Yuborilmoqda...');
    await doc.loadInfo();
    const row = await doc.sheetsByTitle['Pending_Expenses'].addRow({
      'Timestamp': new Date().toLocaleString(), 'Branch': s.branch, 'Staff Name': ctx.from.first_name, 
      'Amount': s.amount, 'Payment Type': s.payType, 'Payment Detail': s.payDetail, 
      'Description': `[${s.category}] ${s.description}`, 'Status': 'PENDING', 
      '_StaffChatId': uid, 'Priority': s.priority
    });

    const audit = await getMasterAudit(s.branch, s.category, s.amount);
    
    // 1. Send Text Summary to Manager
    await bot.telegram.sendMessage(MANAGER_ID, `🏢 *YANGI SO'ROV*\n👤 ${ctx.from.first_name}\n📍 ${s.branch}\n💵 ${Number(s.amount).toLocaleString()} UZS\n💳 ${s.payType} (${s.payDetail})\n💬 ${s.description}${audit}`, {
      parse_mode: 'Markdown',
      ...Markup.inlineKeyboard([[Markup.button.callback('✅ Tasdiqlash', `decide_${row.rowNumber}`)], [Markup.button.callback('❌ Rad etish', `rej_${row.rowNumber}`)]])
    });

    // 2. FORWARD VOICE/VIDEO IF EXISTS
    if (s.mediaId) {
      await bot.telegram.forwardMessage(MANAGER_ID, uid, s.mediaId);
    }

    delete userSessions[uid]; // PREVENTS STUCK BUG
    ctx.editMessageText('✅ So\'rov menejerga yuborildi!');
    ctx.reply('Yangi so\'rov uchun filialni tanlang:', Markup.keyboard(branches, { columns: 2 }).resize());
  } catch (e) {
    console.error(e);
    ctx.answerCbQuery('❌ Xatolik yuz berdi. Qaytadan urinib ko\'ring.', { show_alert: true });
  }
});

bot.action(/^decide_(\d+)$/, async (ctx) => {
  const rowNum = ctx.match[1];
  try {
    ctx.answerCbQuery();
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

bot.action(/^(paynow|schedD|rej)_(\d+)(?:_(\d+))?$/, async (ctx) => {
  const action = ctx.match[1], rowNum = ctx.match[2], param = ctx.match[3];
  try {
    ctx.answerCbQuery('Jarayonda...');
    await doc.loadInfo();
    const rows = await doc.sheetsByTitle['Pending_Expenses'].getRows();
    const row = rows.find(r => r.rowNumber == rowNum);
    if (!row) return ctx.answerCbQuery('❌ Qator topilmadi.', { show_alert: true });

    const staffId = row.get('_StaffChatId');

    if (action === 'rej') {
      row.set('Status', 'REJECTED'); await row.save();
      bot.telegram.sendMessage(staffId, `❌ So'rovingiz rad etildi.`);
      return ctx.editMessageText(`❌ Rad etildi. (ID: ${rowNum})`);
    }

    const targetDate = action === 'paynow' ? getTodayStr() : getScheduledDateStr('D', parseInt(param));
    row.set('Status', 'SCHEDULED'); row.set('Scheduled Date', targetDate); await row.save();

    bot.telegram.sendMessage(staffId, action === 'paynow' ? "✅ Hozir to'lanadi." : `⏳ Tasdiqlandi. Sana: ${targetDate}`);
    ctx.editMessageText(`🗓 ${targetDate} sanasiga rejalashtirildi.\nTo'lov qilingach chekni shu xabarga Reply qilib yuboring.\nID: ${rowNum}`);
  } catch (e) { ctx.answerCbQuery('❌ Xatolik yuz berdi.', { show_alert: true }); }
});

bot.action(/^confirm_(\d+)$/, async (ctx) => {
  const rowNum = ctx.match[1];
  try {
    ctx.answerCbQuery('Tasdiqlanmoqda...');
    await doc.loadInfo();
    const rows = await doc.sheetsByTitle['Pending_Expenses'].getRows();
    const row = rows.find(r => r.rowNumber == rowNum);
    if (!row) return ctx.answerCbQuery('Xatolik.');

    row.set('Status', 'PAID'); await row.save();
    ctx.editMessageCaption('✅ *PUL QABUL QILINDI.*', { parse_mode: 'Markdown' });
    bot.telegram.sendMessage(MANAGER_ID, `✅ Xodim to'lovni qabul qildi. ID: ${rowNum} yopildi.`);
  } catch (e) { ctx.answerCbQuery('❌ Xatolik yuz berdi.'); }
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
