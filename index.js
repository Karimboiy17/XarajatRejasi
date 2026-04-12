const { Telegraf, Markup } = require('telegraf');
const { JWT } = require('google-auth-library');
const { GoogleSpreadsheet } = require('google-spreadsheet');
const cron = require('node-cron');

const bot = new Telegraf(process.env.BOT_TOKEN);
const SHEET_ID = process.env.SHEET_ID;
const MANAGER_ID = process.env.MANAGER_CHAT_ID;
const CEO_ID = process.env.CEO_CHAT_ID;

// --- GOOGLE SHEETS AUTH ---
const creds = JSON.parse(process.env.GCP_SERVICE_ACCOUNT);
const auth = new JWT({
  email: creds.client_email,
  key: creds.private_key,
  scopes: ['https://www.googleapis.com/auth/spreadsheets'],
});

const doc = new GoogleSpreadsheet(SHEET_ID, auth);
const userSessions = {};

// --- CONFIG ---
const branches = ['📍 Integro', '📍 Drujba', '📍 Amir Temur', '📍 Central', '📍 Marketing'];
const categories = ['tugilgan kun uchun', 'printer rang', 'Printer tuzatish', 'remont-tuzatish', 'Hodimlar uchun dorilar', 'jihoz', 'Texnikalar', 'Transport', 'aromatizator', 'Internet', 'Telefon', 'of the month', 'Event', 'Reklama mahsulotlarini chiqarish', 'giftbox sovgalar', 'syomka xarajatlari', 'bozorlik xojalik', 'Suv va stakan', 'Konstovar', 'Plastik foizi', 'ofis xarajatlari', 'remont qurilish'];
const priorities = ["🔴 O'ta muhim (Bugun)", "🟡 O'rtacha (Ertaga)", "🔵 Normal (Shu hafta)", "🟢 Shoshilinch emas (Shu oy)"];

// --- DATE UTILS ---
function getTodayStr() {
  return new Date(new Date().getTime() + (5 * 60 * 60 * 1000)).toISOString().split('T')[0];
}

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

// --- GLOBAL REPORTING LOGIC ---
async function generateGlobalReport() {
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

    let msg = `📊 *GLOBAL MOLIYA HISOBOTI*\n━━━━━━━━━━━━━━━\n💰 *Jami To'langan: ${grandTotal.toLocaleString('en-US')} UZS*\n\n🏢 *Filiallar bo'yicha:*\n`;
    branches.forEach(b => { msg += `• ${b}: ${(branchTotals[b] || 0).toLocaleString('en-US')} UZS\n`; });
    return msg;
}

// --- DOUBLE AUDIT BUDGET LOGIC (CRASH FIX APPLIED) ---
async function getBudgetWarning(branch, category, amountStr) {
  try {
    await doc.loadInfo();
    const budgetSheet = doc.sheetsByTitle['Budgets'];
    const expenseSheet = doc.sheetsByTitle['Pending_Expenses'];
    if (!budgetSheet || !expenseSheet) return '';

    const budgetRows = await budgetSheet.getRows();
    const expenseRows = await expenseSheet.getRows();
    const now = new Date();
    const currentMonth = now.getMonth();
    const currentYear = now.getFullYear();

    // Safely check cells to prevent crashes on empty limits
    const branchLimitRow = budgetRows.find(r => {
        const cat = r.get('Category') ? r.get('Category').toString().trim() : '';
        return r.get('Branch') === branch && cat === '';
    });
    const categoryLimitRow = budgetRows.find(r => {
        const cat = r.get('Category') ? r.get('Category').toString().trim() : '';
        return r.get('Branch') === branch && cat === category;
    });

    const branchLimitStr = branchLimitRow ? branchLimitRow.get('Monthly Limit') : null;
    const branchLimit = branchLimitStr ? parseInt(branchLimitStr.toString().replace(/[^0-9]/g, '')) : Infinity;

    const categoryLimitStr = categoryLimitRow ? categoryLimitRow.get('Monthly Limit') : null;
    const categoryLimit = categoryLimitStr ? parseInt(categoryLimitStr.toString().replace(/[^0-9]/g, '')) : Infinity;

    let branchSpent = 0;
    let categorySpent = 0;

    expenseRows.forEach(r => {
      const status = r.get('Status');
      if (r.get('Branch') === branch && (status === 'PAID' || status === 'SCHEDULED' || status === 'CHEQUE_SENT')) {
        const rowDate = new Date(r.get('Timestamp'));
        if (rowDate.getMonth() === currentMonth && rowDate.getFullYear() === currentYear) {
          const amt = parseInt(r.get('Amount') ? r.get('Amount').toString().replace(/[^0-9]/g, '') : '0') || 0;
          branchSpent += amt;
          const desc = r.get('Description') || '';
          if (desc.includes(`[${category}]`)) {
            categorySpent += amt;
          }
        }
      }
    });

    const requested = parseInt(amountStr);
    let warningMsg = '\n━━━━━━━━━━━━━━━';
    
    if (branchLimit !== Infinity && !isNaN(branchLimit)) {
        const branchTotal = branchSpent + requested;
        warningMsg += (branchTotal > branchLimit) ? `\n🚨 *FILIAL BUDJETI OSHDI!* (${branchTotal.toLocaleString()} / ${branchLimit.toLocaleString()})` : `\n✅ *Filial qoldig'i:* ${(branchLimit - branchTotal).toLocaleString()} UZS`;
    }

    if (categoryLimit !== Infinity && !isNaN(categoryLimit)) {
        const catTotal = categorySpent + requested;
        warningMsg += (catTotal > categoryLimit) ? `\n⚠️ *KATEGORIYA LIMITDAN OSHDI!* (${category})` : `\n✅ *Kategoriya qoldig'i:* ${(categoryLimit - catTotal).toLocaleString()} UZS`;
    }

    return warningMsg === '\n━━━━━━━━━━━━━━━' ? '' : warningMsg;
  } catch (e) { console.error("Budget Error:", e); return ''; }
}

// ==========================================
// 1. ADMIN & CEO PANELS
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
      const amt = parseInt(r.get('Amount') || 0);
      dates[d] = (dates[d] || 0) + amt;
      total += amt;
    });

    const sortedDates = Object.keys(dates).sort();
    let msg = `💸 *CASHFLOW FORECAST (Pul oqimi)*\n━━━━━━━━━━━━━━━\n`;
    sortedDates.forEach(d => { msg += `🗓 *${d}* ➔ ${dates[d].toLocaleString('en-US')} UZS\n`; });
    msg += `━━━━━━━━━━━━━━━\n💰 *Kutilayotgan Jami:* ${total.toLocaleString('en-US')} UZS`;
    ctx.reply(msg, { parse_mode: 'Markdown' });
  } catch (e) { ctx.reply('❌ Xatolik yuz berdi.'); }
});

bot.hears(['📊 Hisobot (Report)', '📈 Umumiy Hisobot'], async (ctx) => {
  const uid = ctx.from.id.toString();
  if (uid !== MANAGER_ID && uid !== CEO_ID) return;
  try {
    const msg = await generateGlobalReport();
    ctx.reply(msg, { parse_mode: 'Markdown' });
  } catch (e) { ctx.reply('❌ Xatolik yuz berdi.'); }
});

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
      const amt = parseInt(r.get('Amount') || 0);
      totalWait += amt;
      const priority = r.get('Priority') ? r.get('Priority').split('(')[0].trim() : "Normal";
      const payType = r.get('Payment Type') || "Noma'lum";
      const payDetail = r.get('Payment Detail') || "N/A";
      msg += `🗓 Sana: ${r.get('Scheduled Date')}\n📍 ${r.get('Branch')} - ${amt.toLocaleString('en-US')} UZS\n💳 To'lov: ${payType} (${payDetail})\n📝 ${r.get('Description')} [${priority}]\n\n`;
    });
    msg += `━━━━━━━━━━━━━━━\n💰 *Jami Kutilayotgan:* ${totalWait.toLocaleString('en-US')} UZS`;
    ctx.reply(msg, { parse_mode: 'Markdown' });
  } catch (e) { ctx.reply('❌ Xatolik yuz berdi.'); }
});

cron.schedule('0 9 * * *', async () => {
  try {
    await doc.loadInfo();
    const rows = await doc.sheetsByTitle['Pending_Expenses'].getRows();
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

bot.on('photo', async (ctx) => {
  if (ctx.from.id.toString() !== MANAGER_ID) return;
  const reply = ctx.message.reply_to_message;
  if (reply && reply.text && reply.text.includes('ID:')) {
    const rowNum = reply.text.split('ID:')[1].trim();
    try {
      await doc.loadInfo();
      const rows = await doc.sheetsByTitle['Pending_Expenses'].getRows();
      const row = rows.find(r => r.rowNumber == rowNum);
      
      row.set('Status', 'CHEQUE_SENT'); 
      await row.save();
      ctx.reply('✅ Chek xodimga tasdiqlash uchun yuborildi!');
      
      const staffId = row.get('_StaffChatId');
      const formattedAmount = Number(row.get('Amount')).toLocaleString('en-US');

      await bot.telegram.sendPhoto(staffId, ctx.message.photo[0].file_id, {
        caption: `💰 *TO'LOV QILINDI!*\nProcurement Manager sizning so'rovingizni to'ladi.\n\n💵 Summa: ${formattedAmount} UZS\n\nIltimos, pulni olganingizni tasdiqlang:`,
        parse_mode: 'Markdown',
        ...Markup.inlineKeyboard([[Markup.button.callback('✅ Qabul qildim', `staffconfirm_${rowNum}`)]])
      });
    } catch (e) { console.error(e); }
  }
});

// ==========================================
// 4. NEW REQUEST WORKFLOW (VOICE ENABLED)
// ==========================================
bot.command(['start', 'new'], (ctx) => {
  userSessions[ctx.from.id] = { step: 'BRANCH' };
  ctx.reply('IELTS Zone Finance Bot 🎓\nFilialni tanlang:', Markup.keyboard(branches, { columns: 2 }).oneTime().resize());
});

// Listen to both text and voice
bot.on(['text', 'voice'], async (ctx) => {
  const userId = ctx.from.id.toString();
  const text = ctx.message.text || '';
  const voice = ctx.message.voice;
  
  if (text.includes('Hisobot') || text.includes('Kutilayotgan') || text.includes('Cashflow')) return;
  
  if (text === '❌ Bekor qilish' || text === '/start') {
    delete userSessions[userId];
    return ctx.reply('Bekor qilindi. Boshlash uchun /start bosing yoki filialni tanlang:', Markup.keyboard(branches, { columns: 2 }).resize());
  }

  let session = userSessions[userId];
  if (!session) {
      if (branches.includes(text)) {
          userSessions[userId] = { step: 'CATEGORY', branch: text };
          return ctx.reply('Kategoriyani tanlang:', Markup.keyboard([...categories, '❌ Bekor qilish'], { columns: 2 }).resize());
      }
      return;
  }

  // If a voice is sent anywhere EXCEPT description, reject it
  if (voice && session.step !== 'DESCRIPTION') {
      return ctx.reply("❌ Iltimos, ushbu bosqichda faqat tugmalardan foydalaning yoki matn kiriting.");
  }

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
        return ctx.reply('Summani kiriting (Masalan: 100 000):', Markup.keyboard(['❌ Bekor qilish']).resize()); 
    }
  }
  if (session.step === 'AMOUNT') {
    session.amount = text.replace(/[^0-9]/g, '');
    session.step = 'DESCRIPTION';
    return ctx.reply('Xarajat sababi (Matn yoki Ovozli xabar yuborishingiz mumkin):');
  }
  if (session.step === 'DESCRIPTION') {
    if (voice) {
        session.description = "🎤 [Ovozli xabar]";
        session.voiceFileId = voice.file_id;
    } else {
        session.description = text;
    }
    session.step = 'PRIORITY';
    return ctx.reply('Muhimligi qanday?', Markup.keyboard([...priorities, '❌ Bekor qilish'], { columns: 1 }).resize());
  }
  if (session.step === 'PRIORITY') {
    if (priorities.includes(text)) { 
        session.priority = text; 
        session.step = 'PAY_TYPE'; 
        return ctx.reply('To\'lov turi qanday bo\'ladi?', Markup.keyboard(['Karta', 'Naqd', 'MCHJ hisobi', '❌ Bekor qilish']).resize()); 
    }
  }
  if (session.step === 'PAY_TYPE') {
    session.payType = text;
    if (text === 'Naqd') { 
        session.payDetail = 'N/A'; 
        session.step = 'CONFIRM';
        return showSummary(ctx, session); 
    }
    session.step = 'PAY_DETAIL';
    return ctx.reply(text === 'Karta' ? 'Karta raqamini kiriting:' : 'Firma nomini kiriting:');
  }
  if (session.step === 'PAY_DETAIL') {
    session.payDetail = text;
    return showSummary(ctx, session);
  }
});

async function showSummary(ctx, session) {
  const formattedAmount = Number(session.amount).toLocaleString('en-US');
  let msg = `⚠️ *Menejerga yuborishdan oldin tekshiring:*\n\n📍 Filial: ${session.branch}\n📂 Kategoriya: ${session.category}\n💰 Summa: ${formattedAmount} UZS\n📝 Sabab: ${session.description}\n⏰ Muhimligi: ${session.priority}\n💳 To'lov: ${session.payType} (${session.payDetail})`;
  
  ctx.reply(msg, {
    parse_mode: 'Markdown',
    ...Markup.inlineKeyboard([[Markup.button.callback('✅ Yuborish (Submit)', 'submit')], [Markup.button.callback('❌ Boshidan boshlash', 'cancel')]])
  });
}

// ==========================================
// 5. CALLBACK HANDLERS
// ==========================================
bot.action('cancel', async (ctx) => {
    delete userSessions[ctx.from.id];
    await ctx.editMessageText('❌ So\'rov bekor qilindi.');
    ctx.reply('Filialni tanlang:', Markup.keyboard(branches, { columns: 2 }).resize());
});

bot.action('submit', async (ctx) => {
  const session = userSessions[ctx.from.id];
  if (!session) {
      return ctx.answerCbQuery("Eski so'rov. Iltimos qaytadan boshlang.");
  }
  
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
      '_StaffChatId': ctx.from.id.toString(),
      'Scheduled Date': '',
      'Priority': session.priority
    });
    
    const budgetAudit = await getBudgetWarning(session.branch, session.category, session.amount);
    
    const managerMsg = await bot.telegram.sendMessage(MANAGER_ID, `🏢 *Yangi so'rov*\n📍 Filial: ${session.branch}\n👤 Kimdan: ${ctx.from.first_name}\n📂 Kategoriya: ${session.category}\n💵 Summa: ${Number(session.amount).toLocaleString('en-US')} UZS\n💳 To'lov: ${session.payType} (${session.payDetail})\n💬 Sabab: ${session.description}\n⏰ Muhimligi: ${session.priority}${budgetAudit}`, {
      parse_mode: 'Markdown',
      ...Markup.inlineKeyboard([
          [Markup.button.callback('✅ Tasdiqlash (Qaror)', `decide_${row.rowNumber}`)], 
          [Markup.button.callback('❌ Rad etish', `rej_${row.rowNumber}`)]
      ])
    });

    // If there is a voice message, forward it to the manager
    if (session.voiceFileId) {
        await bot.telegram.sendVoice(MANAGER_ID, session.voiceFileId, {
            caption: `🎤 Yuqoridagi so'rovning ovozli izohi (ID: ${row.rowNumber})`
        });
    }
    
    ctx.editMessageText('✅ So\'rov muvaffaqiyatli yuborildi!');
    delete userSessions[ctx.from.id]; 
    ctx.reply('Yangi so\'rov yaratish uchun filialni tanlang:', Markup.keyboard(branches, { columns: 2 }).resize());
  } catch (e) { 
      console.error(e); 
      ctx.reply("❌ Google Sheets bilan xatolik yuz berdi.");
  }
});

bot.action(/^staffconfirm_(\d+)$/, async (ctx) => {
  const rowNum = ctx.match[1];
  try {
    await doc.loadInfo();
    const rows = await doc.sheetsByTitle['Pending_Expenses'].getRows();
    const row = rows.find(r => r.rowNumber == rowNum);
    
    row.set('Status', 'PAID'); 
    await row.save();
    
    ctx.editMessageCaption('✅ *PUL QABUL QILINDI VA YOPILDI.*', { parse_mode: 'Markdown' });
    await bot.telegram.sendMessage(MANAGER_ID, `✅ Xodim ${Number(row.get('Amount')).toLocaleString('en-US')} UZS miqdoridagi pulni olganini tasdiqladi.\n(ID: ${rowNum} - Status: PAID)`);
  } catch(e) { console.error(e); }
});

bot.action(/^(decide|paynow|schedD|schedF|schedM|rej)_(\d+)(?:_(\d+))?$/, async (ctx) => {
  const [action, rowNum, param] = [ctx.match[1], ctx.match[2], ctx.match[3]];
  
  try {
    await doc.loadInfo();
    const rows = await doc.sheetsByTitle['Pending_Expenses'].getRows();
    const row = rows.find(r => r.rowNumber == rowNum);
    if (!row) return ctx.reply("❌ Xatolik: Qator topilmadi.");

    const staffId = row.get('_StaffChatId');
    const formattedAmount = Number(row.get('Amount')).toLocaleString('en-US');

    if (action === 'decide') {
      return ctx.editMessageText(`💸 So'rov ko'rib chiqilmoqda. Qachon to'laysiz?`, {
        ...Markup.inlineKeyboard([
          [Markup.button.callback('✅ Hozir To\'lash (Chek yuborish)', `paynow_${rowNum}`)],
          [Markup.button.callback('🗓 Dushanba', `schedD_${rowNum}_1`), Markup.button.callback('🗓 Seshanba', `schedD_${rowNum}_2`)],
          [Markup.button.callback('🗓 Chorshanba', `schedD_${rowNum}_3`), Markup.button.callback('🗓 Payshanba', `schedD_${rowNum}_4`)],
          [Markup.button.callback('🗓 Juma', `schedD_${rowNum}_5`)],
          [Markup.button.callback('⏳ 15 kun', `schedF_${rowNum}_15`), Markup.button.callback('📅 1 oy', `schedM_${rowNum}`)]
        ])
      });
    }
    
    if (action === 'paynow') {
      row.set('Status', 'SCHEDULED'); 
      row.set('Scheduled Date', getTodayStr()); 
      await row.save();
      await bot.telegram.sendMessage(staffId, `✅ Tasdiqlandi! Procurement Manager pulni o'tkazmoqda.`);
      return ctx.editMessageText(`💸 *Hozir to'lash tanlandi.*\nTo'lovni amalga oshirgach, **ushbu xabarga CHEK RASMINI REPLY qilib yuboring**.\nID: ${rowNum}`, { parse_mode: 'Markdown' });
    }
    
    if (action.startsWith('sched')) {
      let targetDate = '';
      if (action === 'schedD') targetDate = getScheduledDateStr('D', parseInt(param));
      else if (action === 'schedF') targetDate = getScheduledDateStr('F', parseInt(param));
      else if (action === 'schedM') targetDate = getScheduledDateStr('M', 0);
      
      row.set('Status', 'SCHEDULED'); 
      row.set('Scheduled Date', targetDate); 
      await row.save();
      
      await bot.telegram.sendMessage(staffId, `⏳ *To'lov Rejalashtirildi!*\nSizning ${formattedAmount} UZS so'rovingiz tasdiqlandi.\nTo'lov sanasi: *${targetDate}*`, { parse_mode: 'Markdown' });
      return ctx.editMessageText(`🗓 To'lov ${targetDate} sanasiga rejalashtirildi. Xodim ogohlantirildi.`);
    }
    
    if (action === 'rej') {
      row.set('Status', 'REJECTED'); 
      await row.save();
      await bot.telegram.sendMessage(staffId, `❌ Sizning ${formattedAmount} UZS so'rovingiz rad etildi.`);
      return ctx.editMessageText('❌ So\'rov rad etildi va yopildi.');
    }
  } catch (e) { 
      console.error(e); 
      ctx.reply("❌ Amalni bajarishda xatolik yuz berdi.");
  }
});

bot.launch();
process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
