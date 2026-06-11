const { Telegraf, Markup } = require('telegraf');
const { JWT } = require('google-auth-library');
const { GoogleSpreadsheet } = require('google-spreadsheet');
const cron = require('node-cron');

// ==========================================
// 1. ENVIRONMENT & AUTHENTICATION
// ==========================================
const bot = new Telegraf(process.env.BOT_TOKEN);
const SHEET_ID = process.env.SHEET_ID;

const MANAGER_IDS = process.env.MANAGER_CHAT_IDS ? process.env.MANAGER_CHAT_IDS.split(',').map(id => id.trim()) : [];
const ALLOWED_STAFF_IDS = process.env.ALLOWED_STAFF_IDS ? process.env.ALLOWED_STAFF_IDS.split(',').map(id => id.trim()) : [];
const CEO_ID = process.env.CEO_CHAT_ID || "NO_CEO"; 
const HEAD_CEO_ID = process.env.HEAD_CEO || "NO_HEAD_CEO";
const MAINTENANCE_GROUP_ID = process.env.MAINTENANCE_GROUP_ID || null;

const creds = JSON.parse(process.env.GCP_SERVICE_ACCOUNT);
const auth = new JWT({
  email: creds.client_email,
  key: creds.private_key,
  scopes: ['https://www.googleapis.com/auth/spreadsheets'],
});
const doc = new GoogleSpreadsheet(SHEET_ID, auth);

const userSessions = {};

// Cache for Users sheet (refreshed periodically)
let cachedStaffIds = new Set(ALLOWED_STAFF_IDS);
let staffCacheTime = 0;
const STAFF_CACHE_TTL = 5 * 60 * 1000; // 5 min

async function refreshStaffCache() {
  try {
    await doc.loadInfo();
    const sheet = doc.sheetsByTitle['Users'];
    if (!sheet) return;
    const rows = await sheet.getRows();
    cachedStaffIds = new Set(ALLOWED_STAFF_IDS);
    for (const r of rows) {
      const tid = r.get('Telegram ID');
      if (tid) cachedStaffIds.add(tid.toString());
    }
    staffCacheTime = Date.now();
  } catch(e) { /* keep old cache */ }
}

// ==========================================
// SECURITY MIDDLEWARE
// ==========================================
bot.use(async (ctx, next) => {
  if (!ctx.from) return next();
  const uid = ctx.from.id.toString();
  
  // Refresh cache if stale
  if (Date.now() - staffCacheTime > STAFF_CACHE_TTL) {
    await refreshStaffCache().catch(() => {});
  }
  
  const isAllowed = cachedStaffIds.has(uid) || MANAGER_IDS.includes(uid) || uid === CEO_ID || uid === HEAD_CEO_ID;
  if (!isAllowed) {
    if (ctx.chat && ctx.chat.type === 'private') {
      try { await ctx.reply("Kechirasiz, sizda ushbu botdan foydalanish huquqi yo'q.\nIltimos, ruxsat olish uchun rahbariyatga murojaat qiling."); } catch (e) {}
    }
    return;
  }
  return next();
});

// ==========================================
// 2. CONSTANTS
// ==========================================
const branches = ['📍 Integro', '📍 Drujba', '📍 Amir Temur', '📍 Central', '📍 Marketing'];
const categories = ['tugilgan kun uchun', 'printer rang', 'Printer tuzatish', 'remont-tuzatish', 'Hodimlar uchun dorilar', 'jihoz', 'Texnikalar', 'Transport', 'aromatizator', 'Internet', 'Telefon', 'of the month', 'Event', 'Reklama mahsulotlarini chiqarish', 'giftbox sovgalar', 'syomka xarajatlari', 'bozorlik xojalik', 'Suv va stakan', 'Konstovar', 'Plastik foizi', 'ofis xarajatlari', 'remont qurilish'];
const priorities = ["O'ta muhim (Bugun)", "O'rtacha (Ertaga)", "Normal (Shu hafta)", "Shoshilinch emas (Shu oy)"];

// ==========================================
// 3. UTILITY FUNCTIONS
// ==========================================
function parseSafeInt(str) {
  if (!str) return 0;
  return parseInt(str.toString().replace(/[^0-9]/g, '')) || 0;
}

function getTodayStr() {
  return new Date(new Date().getTime() + (5 * 60 * 60 * 1000)).toISOString().split('T')[0];
}

function getScheduledDateStr(type, param) {
  const t = new Date(new Date().getTime() + (5 * 60 * 60 * 1000));
  if (type === 'D') {
    let dist = param - t.getUTCDay();
    if (dist <= 0) dist += 7;
    t.setUTCDate(t.getUTCDate() + dist);
  } else if (type === 'F') {
    t.setUTCDate(t.getUTCDate() + param);
  } else if (type === 'M') {
    t.setUTCMonth(t.getUTCMonth() + 1);
  }
  return t.toISOString().split('T')[0];
}

function cleanPriority(str) {
  if (!str) return "Normal";
  return str.split('(')[0].trim();
}

// ==========================================
// 4. BUDGET ENGINE
// ==========================================
async function getMonthlySpent(expenseSheet, branch, category = null) {
  const expenseRows = await expenseSheet.getRows();
  const now = new Date(new Date().getTime() + (5 * 60 * 60 * 1000));
  let spent = 0;
  expenseRows.forEach(r => {
    const rowDateStr = r.get('Timestamp');
    if (!rowDateStr) return;
    const rowDate = new Date(rowDateStr);
    const status = r.get('Status');
    const matchesBranch = r.get('Branch') === branch;
    const matchesCategory = category ? (r.get('Description') || '').includes(`[${category}]`) : true;
    const isThisMonth = rowDate.getMonth() === now.getMonth() && rowDate.getFullYear() === now.getFullYear();
    if (matchesBranch && matchesCategory && isThisMonth && (status === 'PAID' || status === 'SCHEDULED' || status === 'CHEQUE_SENT')) {
      spent += parseSafeInt(r.get('Amount'));
    }
  });
  return spent;
}

async function getDoubleBudgetWarning(branch, category, amountStr) {
  try {
    await doc.loadInfo();
    const budgetSheet = doc.sheetsByTitle['Budgets'];
    const expenseSheet = doc.sheetsByTitle['Pending_Expenses'];
    if (!budgetSheet || !expenseSheet) return '\n\nTizim Xatosi: Jadvallar topilmadi.';
    const budgetRows = await budgetSheet.getRows();
    const requested = parseSafeInt(amountStr);
    const branchBudgetRow = budgetRows.find(r => r.get('Branch') === branch && (!r.get('Category') || r.get('Category').trim() === ''));
    const branchSpent = await getMonthlySpent(expenseSheet, branch);
    let branchMsg = "Umumiy filial limiti belgilanmagan.";
    if (branchBudgetRow) {
      const bLimit = parseSafeInt(branchBudgetRow.get('Monthly Limit'));
      if (branchSpent + requested > bLimit) {
        branchMsg = `UMUMIY FILIAL LIMITI O'TDI! (${branchSpent.toLocaleString()} / ${bLimit.toLocaleString()})`;
      } else {
        branchMsg = `Filial Zaxirasi: ${(bLimit - (branchSpent + requested)).toLocaleString()} UZS`;
      }
    }
    const catBudgetRow = budgetRows.find(r => r.get('Branch') === branch && r.get('Category') === category);
    const catSpent = await getMonthlySpent(expenseSheet, branch, category);
    let catMsg = `${category} limiti belgilanmagan.`;
    if (catBudgetRow) {
      const cLimit = parseSafeInt(catBudgetRow.get('Monthly Limit'));
      if (catSpent + requested > cLimit) {
        catMsg = `${category.toUpperCase()} LIMITI O'TDI! (${catSpent.toLocaleString()} / ${cLimit.toLocaleString()})`;
      } else {
        catMsg = `${category} Zaxirasi: ${(cLimit - (catSpent + requested)).toLocaleString()} UZS`;
      }
    }
    return `\n\nBudjet Nazorati (${branch}):\n${branchMsg}\n${catMsg}`;
  } catch (e) {
    return '\n\nBudjetni hisoblashda xatolik yuz berdi.';
  }
}

// ==========================================
// 5. REPORTING
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
  let msg = `Jami To'langan: ${grandTotal.toLocaleString('en-US')} UZS\n\nFiliallar bo'yicha:\n`;
  branches.forEach(b => { msg += `${b}: ${(branchTotals[b] || 0).toLocaleString('en-US')} UZS\n`; });
  return msg;
}

// ==========================================
// 6. ADMIN COMMANDS
// ==========================================
bot.command('admin', (ctx) => {
  const uid = ctx.from.id.toString();
  if (uid === HEAD_CEO_ID) {
    return ctx.reply('👔 Bosh Direktor (HEAD CEO) Paneli:\nQuyidagi boshqaruv tugmalaridan birini tanlang:', Markup.keyboard([
      ['📈 Moliya Hisoboti', '🕵️ Procurement Nazorati'],
      ['💸 Pul Oqimi (Cashflow)', '📊 Budjet Holati']
    ]).resize());
  } else if (MANAGER_IDS.includes(uid)) {
    return ctx.reply('Procurement Manager Paneli:', Markup.keyboard([
      ['Hisobot (Report)', 'Kutilayotgan (Waiting)'],
      ['Cashflow'],
      ['Limitlar', 'Kategoriyalar'],
      ['Foydalanuvchilar']
    ]).resize());
  } else if (uid === CEO_ID) {
    return ctx.reply('CEO Monitoring Paneli:', Markup.keyboard([
      ['📊 Procurement Nazorati', '📋 Kutilayotgan Xarajatlar'],
      ['Umumiy Hisobot', 'Cashflow Forecast']
    ]).resize());
  }
});

bot.hears('📊 Procurement Nazorati', async (ctx) => {
  const uid = ctx.from.id.toString();
  if (uid !== CEO_ID && uid !== HEAD_CEO_ID) return;
  await sendProcurementReport(ctx, uid);
});

bot.hears('📋 Kutilayotgan Xarajatlar', async (ctx) => {
  const uid = ctx.from.id.toString();
  if (uid !== CEO_ID && uid !== HEAD_CEO_ID) return;
  try {
    await doc.loadInfo();
    const rows = await doc.sheetsByTitle['Pending_Expenses'].getRows();
    const waiting = rows.filter(r => r.get('Status') === 'SCHEDULED' || r.get('Status') === 'PENDING');
    if (waiting.length === 0) return ctx.reply("Kutilayotgan yoki tasdiqlanmagan so'rovlar yo'q.");

    let pendingList = waiting.filter(r => r.get('Status') === 'PENDING');
    let scheduledList = waiting.filter(r => r.get('Status') === 'SCHEDULED');

    let pendingTotal = 0, scheduledTotal = 0;
    pendingList.forEach(r => { pendingTotal += parseSafeInt(r.get('Amount')); });
    scheduledList.forEach(r => { scheduledTotal += parseSafeInt(r.get('Amount')); });

    let msg = `📋 *KUTILAYOTGAN XARAJATLAR*\\n━━━━━━━━━━━━━━━\\n`;
    msg += `Jami: *${(pendingTotal + scheduledTotal).toLocaleString('en-US')}* UZS | ${waiting.length} ta\\n\\n`;

    if (pendingList.length > 0) {
      msg += `🟡 *Tasdiqlanishi kutilmoqda:* ${pendingList.length} ta (${pendingTotal.toLocaleString('en-US')} UZS)\\n`;
      pendingList.slice(0, 5).forEach(r => {
        const ts = r.get('Timestamp') || '';
        msg += `  • ${r.get('Branch')} | ${parseSafeInt(r.get('Amount')).toLocaleString('en-US')} | ${r.get('Staff Name')} | ${ts.substring(0,10)}\\n`;
      });
      if (pendingList.length > 5) msg += `  ... va yana ${pendingList.length - 5} ta\\n`;
    }

    if (scheduledList.length > 0) {
      msg += `\\n🗓 *Tasdiqlangan, to'lov kutilmoqda:* ${scheduledList.length} ta (${scheduledTotal.toLocaleString('en-US')} UZS)\\n`;
      scheduledList.slice(0, 5).forEach(r => {
        const sd = r.get('Scheduled Date') || 'Nomalum';
        msg += `  • ${r.get('Branch')} | ${parseSafeInt(r.get('Amount')).toLocaleString('en-US')} | ${sd} | ${r.get('Staff Name')}\\n`;
      });
      if (scheduledList.length > 5) msg += `  ... va yana ${scheduledList.length - 5} ta\\n`;
    }

    await ctx.reply(msg, { parse_mode: 'Markdown' });
  } catch(e) {
    console.error(e);
    ctx.reply('Xatolik yuz berdi.');
  }
});

bot.hears(['Cashflow', 'Cashflow Forecast', '💸 Pul Oqimi (Cashflow)'], async (ctx) => {
  const uid = ctx.from.id.toString();
  if (!MANAGER_IDS.includes(uid) && uid !== CEO_ID && uid !== HEAD_CEO_ID) return;
  try {
    await doc.loadInfo();
    const rows = await doc.sheetsByTitle['Pending_Expenses'].getRows();
    const scheduled = rows.filter(r => r.get('Status') === 'SCHEDULED');
    if (scheduled.length === 0) return ctx.reply("Kelajakdagi to'lovlar yo'q.");
    let dates = {}, total = 0;
    scheduled.forEach(r => {
      const d = r.get('Scheduled Date');
      const amt = parseSafeInt(r.get('Amount'));
      dates[d] = (dates[d] || 0) + amt;
      total += amt;
    });
    let msg = `CASHFLOW FORECAST\n\n`;
    Object.keys(dates).sort().forEach(d => { msg += `${d}: ${dates[d].toLocaleString('en-US')} UZS\n`; });
    msg += `\nJami: ${total.toLocaleString('en-US')} UZS`;
    ctx.reply(msg);
  } catch (e) { ctx.reply('Xatolik.'); }
});

bot.hears(['Hisobot (Report)', 'Umumiy Hisobot', '📈 Moliya Hisoboti'], async (ctx) => {
  const uid = ctx.from.id.toString();
  if (!MANAGER_IDS.includes(uid) && uid !== CEO_ID && uid !== HEAD_CEO_ID) return;
  try {
    const months = await getAvailableMonths();
    const now = new Date();
    const currentMonth = now.getFullYear() + '-' + String(now.getMonth()+1).padStart(2,'0');
    const rows = [];
    for (let i = 0; i < Math.min(months.length, 6); i += 2) {
      rows.push(months.slice(i,i+2).map(m => Markup.button.callback(m===currentMonth?'Joriy oy ('+getMonthName(m)+')':getMonthName(m), 'report_'+m)));
    }
    rows.push([Markup.button.callback('Hammasi (barcha vaqt)', 'report_all')]);
    ctx.reply('Qaysi davr uchun hisobot?', Markup.inlineKeyboard(rows));
  } catch (e) { ctx.reply('Xatolik.'); }
});

bot.hears('Kutilayotgan (Waiting)', async (ctx) => {
  if (!MANAGER_IDS.includes(ctx.from.id.toString())) return;
  try {
    await doc.loadInfo();
    const rows = await doc.sheetsByTitle['Pending_Expenses'].getRows();
    const waiting = rows.filter(r => r.get('Status') === 'SCHEDULED' || r.get('Status') === 'PENDING');
    if (waiting.length === 0) return ctx.reply("Kutilayotgan yoki tasdiqlanmagan so'rovlar yo'q.");
    let total = 0;
    waiting.forEach(r => { total += parseSafeInt(r.get('Amount')); });
    await ctx.reply(`TASDIQLANMAGAN VA KUTILAYOTGANLAR\nJami: ${total.toLocaleString('en-US')} UZS | ${waiting.length} ta sorov`);

    for (const r of waiting) {
      const amt = parseSafeInt(r.get('Amount'));
      const status = r.get('Status');
      const isPending = status === 'PENDING';
      const isCard = r.get('Payment Type') === 'Karta';
      const payDet = r.get('Payment Detail');
      const schedDate = r.get('Scheduled Date') ? ` | ${r.get('Scheduled Date')}` : '';
      const statusLabel = isPending ? '🟡 KUTILMOQDA' : `🗓 TASDIQLANGAN${schedDate}`;
      const msg =
        `${statusLabel}\n📍 ${r.get('Branch')} | 👤 ${r.get('Staff Name')}\n💰 ${amt.toLocaleString('en-US')} UZS | 💳 ${r.get('Payment Type')} (${payDet})\n📝 ${r.get('Description')}\n🆔 ID: ${r.rowNumber}`;

      let btns = [];
      if (isPending) {
        btns = [
          [Markup.button.callback('✅ Tasdiqlash', `decide_${r.rowNumber}`)],
          [Markup.button.callback('❌ Rad etish', `rej_${r.rowNumber}`)]
        ];
      } else {
        btns = [
          [Markup.button.callback('💳 Tolash (Chek reply qiling)', `paynow_${r.rowNumber}`)],
          [Markup.button.callback('❌ Rad etish', `rej_${r.rowNumber}`)]
        ];
      }
      await ctx.reply(msg, Markup.inlineKeyboard(btns));
    }
  } catch (e) {
    console.error(e);
    ctx.reply('Xatolik yuz berdi.');
  }
});

// ==========================================
// HEAD CEO FUNKSIYALARI
// ==========================================
bot.hears('🕵️ Procurement Nazorati', async (ctx) => {
  if (ctx.from.id.toString() !== HEAD_CEO_ID) return;
  try {
      await doc.loadInfo();
      const rows = await doc.sheetsByTitle['Pending_Expenses'].getRows();
      const todayStr = getTodayStr();
      
      let pending = 0; 
      let overdue = 0; 
      let upcoming = 0; 
      
      rows.forEach(r => {
          const status = r.get('Status');
          if (status === 'PENDING') pending++;
          if (status === 'SCHEDULED') {
              const sDate = r.get('Scheduled Date');
              if (sDate && sDate <= todayStr) overdue++;
              else upcoming++;
          }
      });
      
      let msg = `🕵️ *PROCUREMENT (Xaridlar) BO'LIMI NAZORATI*\n━━━━━━━━━━━━━━━\n\n`;
      
      // 1. To'lovdagi kechikishlar
      if (overdue > 0) {
          msg += `🔴 *TO'LOVDAGI KECHIKISHLAR:* ${overdue} ta!\n_(Menejer to'lov kunini belgilagan, lekin vaqti kelsa ham pulni o'tkazmagan)._\n\n`;
      } else {
          msg += `✅ To'lovlarda kechikish yo'q.\n\n`;
      }
      
      // 2. Ko'rib chiqilmagan so'rovlar
      if (pending > 0) {
          msg += `🟠 *TASDIQLANMAGAN SO'ROVLAR:* ${pending} ta!\n_(Xodimlar pul so'ragan, lekin menejer hali botga kirib ko'rib chiqmagan. Bu ish jarayoni cho'zilayotganini bildiradi)._\n\n`;
      } else {
          msg += `✅ Ko'rib chiqilmagan (osilib qolgan) so'rovlar yo'q.\n\n`;
      }
      
      msg += `━━━━━━━━━━━━━━━\n🔵 *Kelgusida to'lanadigan:* ${upcoming} ta so'rov rejalashtirilgan.`;
      
      ctx.reply(msg, { parse_mode: 'Markdown' });
  } catch(e) {
      ctx.reply('Xatolik yuz berdi.');
  }
});

bot.hears('📊 Budjet Holati', async (ctx) => {
  if (ctx.from.id.toString() !== HEAD_CEO_ID) return;
  try {
      await doc.loadInfo();
      const budgetSheet = doc.sheetsByTitle['Budgets'];
      const expenseSheet = doc.sheetsByTitle['Pending_Expenses'];
      if(!budgetSheet || !expenseSheet) return ctx.reply("Jadvallar topilmadi.");
      
      const budgetRows = await budgetSheet.getRows();
      
      let msg = `📊 *FILIALLAR BUDJETI HOLATI (Shu oy)*\n━━━━━━━━━━━━━━━\n`;
      let dataFound = false;

      for (const branch of branches) {
          const bLimitRow = budgetRows.find(r => r.get('Branch') === branch && (!r.get('Category') || r.get('Category').trim() === ''));
          if (bLimitRow) {
              dataFound = true;
              const limit = parseSafeInt(bLimitRow.get('Monthly Limit'));
              const spent = await getMonthlySpent(expenseSheet, branch);
              const percent = limit > 0 ? Math.round((spent / limit) * 100) : 0;
              
              let icon = percent >= 100 ? '🔴' : (percent >= 80 ? '🟡' : '🟢');
              msg += `${icon} *${branch.replace('📍 ', '')}*: ${spent.toLocaleString()} / ${limit.toLocaleString()} UZS (${percent}%)\n`;
          }
      }
      
      if(!dataFound) msg += "⚠️ Hozircha umumiy filial limitlari o'rnatilmagan.";
      ctx.reply(msg, { parse_mode: 'Markdown' });
  } catch(e) {
      ctx.reply('Xatolik yuz berdi.');
  }
});

// ==========================================
// ADMIN NAZORAT BUYRUQLARI
// ==========================================
bot.hears('Limitlar', async (ctx) => {
  if (!MANAGER_IDS.includes(ctx.from.id.toString()) && ctx.from.id.toString() !== CEO_ID) return;
  userSessions[ctx.from.id] = { step: 'LIMIT_BRANCH' };
  ctx.reply('Qaysi filial uchun limit?', Markup.keyboard([...branches, 'Bekor qilish'], { columns: 2 }).resize());
});

bot.hears('Kategoriyalar', async (ctx) => {
  if (!MANAGER_IDS.includes(ctx.from.id.toString()) && ctx.from.id.toString() !== CEO_ID) return;
  const cats = await getActiveCategories();
  ctx.reply(`Joriy kategoriyalar (${cats.length} ta):\n\n${cats.map((c,i)=>`${i+1}. ${c}`).join('\n')}`,
    Markup.keyboard([['Yangi kategoriya', "Kategoriyani ochirish"], ['Bekor qilish']]).resize());
});

bot.hears('Foydalanuvchilar', async (ctx) => {
  if (!MANAGER_IDS.includes(ctx.from.id.toString()) && ctx.from.id.toString() !== CEO_ID) return;
  ctx.reply('Foydalanuvchi boshqaruvi:', Markup.keyboard([['Foydalanuvchi qoshish', 'Foydalanuvchilar royxati'], ['Bekor qilish']]).resize());
});

// ==========================================
// 7. DAILY ALARM & CHEQUE FLOW
// ==========================================
cron.schedule('0 9 * * *', async () => {
  try {
    await doc.loadInfo();
    const rows = await doc.sheetsByTitle['Pending_Expenses'].getRows();
    const todayStr = getTodayStr();
    const dueToday = rows.filter(r => r.get('Status') === 'SCHEDULED' && r.get('Scheduled Date') === todayStr);
    for (let row of dueToday) {
      for (let managerId of MANAGER_IDS) {
        await bot.telegram.sendMessage(managerId,
          `ESLATMA: Bugun to'lov qilinishi kerak!\n\n${row.get('Branch')}\n${parseSafeInt(row.get('Amount')).toLocaleString('en-US')} UZS\nTo'lov: ${row.get('Payment Type')} (${row.get('Payment Detail')})\n${row.get('Description')}\n\nTo'lovni amalga oshirgach, ushbu xabarga CHEK RASMINI REPLY qilib yuboring.\nID: ${row.rowNumber}`
        ).catch(() => {});
      }
    }
  } catch (e) { console.error("Cron Error:", e); }
}, { scheduled: true, timezone: "Asia/Tashkent" });

bot.on('photo', async (ctx) => {
  if (!MANAGER_IDS.includes(ctx.from.id.toString())) return;
  const reply = ctx.message.reply_to_message;
  if (reply && reply.text && reply.text.includes('ID:')) {
    const rowNum = reply.text.split('ID:')[1].trim();
    try {
      await doc.loadInfo();
      const rows = await doc.sheetsByTitle['Pending_Expenses'].getRows();
      const row = rows.find(r => r.rowNumber == rowNum);
      if (!row) return ctx.reply('ID topilmadi.');
      row.set('Status', 'CHEQUE_SENT');
      await row.save();
      ctx.reply('Chek xodimga tasdiqlash uchun yuborildi!');
      await bot.telegram.sendPhoto(row.get('_StaffChatId'), ctx.message.photo[0].file_id, {
        caption: `TO'LOV QILINDI!\nProcurement Manager pulni o'tkazdi.\n\nSumma: ${parseSafeInt(row.get('Amount')).toLocaleString('en-US')} UZS\n\nIltimos, pulni olganingizni tasdiqlang:`,
        ...Markup.inlineKeyboard([[Markup.button.callback('Qabul qildim', `staffconfirm_${rowNum}`)]])
      });
      const groupMsgId = row.get('GroupMsgId');
      if (MAINTENANCE_GROUP_ID && groupMsgId) {
        await bot.telegram.sendPhoto(MAINTENANCE_GROUP_ID, ctx.message.photo[0].file_id, {
          reply_to_message_id: parseInt(groupMsgId),
          caption: `Procurement menejer chekni yubordi. Xodim tasdigi kutilmoqda...`
        }).catch(() => {});
      }
    } catch (e) { ctx.reply("Xatolik yuz berdi."); }
  }
});

// ==========================================
// 8. WIZARD
// ==========================================
bot.command(['start', 'new'], async (ctx) => {
  const userId = ctx.from.id;
  const uid = userId.toString();
  delete userSessions[userId];
  
  if (uid === HEAD_CEO_ID) {
    return ctx.reply('👔 Bosh Direktor (HEAD CEO) Paneli:\nQuyidagi boshqaruv tugmalaridan birini tanlang:', Markup.keyboard([
      ['📈 Moliya Hisoboti', '🕵️ Procurement Nazorati'],
      ['💸 Pul Oqimi (Cashflow)', '📊 Budjet Holati']
    ]).resize());
  } else if (MANAGER_IDS.includes(uid)) {
    return ctx.reply('IELTS Zone Finance Bot\nAdmin paneli:', Markup.keyboard([
      ['Hisobot (Report)', 'Kutilayotgan (Waiting)'],
      ['Cashflow'],
      ['Limitlar', 'Kategoriyalar'],
      ['Foydalanuvchilar']
    ]).resize());
  } else if (uid === CEO_ID) {
    return ctx.reply('IELTS Zone Finance Bot\\nCEO paneli:', Markup.keyboard([
      ['📊 Procurement Nazorati', '📋 Kutilayotgan Xarajatlar'],
        ['Umumiy Hisobot', 'Cashflow Forecast']
    ]).resize());
  }
  
  const userBranches = await getUserBranches(userId);
  userSessions[userId] = { step: 'BRANCH' };
  ctx.reply('IELTS Zone Finance Bot\nFilialni tanlang:', Markup.keyboard([...userBranches, 'Bekor qilish'], { columns: 2 }).oneTime().resize());
});

bot.on('message', async (ctx) => {
  const userId = ctx.from.id;
  const text = ctx.message.text || '';
  const voice = ctx.message.voice;

  const uid2 = ctx.from.id.toString();
  const isAdminUser = MANAGER_IDS.includes(uid2) || uid2 === CEO_ID || uid2 === HEAD_CEO_ID;
  const adminTexts = ['Hisobot (Report)', 'Kutilayotgan (Waiting)', 'Cashflow', 'Cashflow Forecast', 'Umumiy Hisobot', 'Limitlar', 'Kategoriyalar', 'Foydalanuvchilar', '📈 Moliya Hisoboti', '🕵️ Procurement Nazorati', '💸 Pul Oqimi (Cashflow)', '📊 Budjet Holati', '📊 Procurement Nazorati'];
  if (adminTexts.includes(text)) return;

  if (text === 'Bekor qilish' || text === '/start') {
    delete userSessions[userId];
    if (uid2 === HEAD_CEO_ID) {
      return ctx.reply('Bekor qilindi.', Markup.keyboard([
        ['📈 Moliya Hisoboti', '🕵️ Procurement Nazorati'],
        ['💸 Pul Oqimi (Cashflow)', '📊 Budjet Holati']
      ]).resize());
    } else if (MANAGER_IDS.includes(uid2)) {
      return ctx.reply('Bekor qilindi.', Markup.keyboard([
        ['Hisobot (Report)', 'Kutilayotgan (Waiting)'],
        ['Cashflow'],
        ['Limitlar', 'Kategoriyalar'],
        ['Foydalanuvchilar']
      ]).resize());
    } else if (uid2 === CEO_ID) {
      return ctx.reply('Bekor qilindi.', Markup.keyboard([
        ['📊 Procurement Nazorati', '📋 Kutilayotgan Xarajatlar'],
          ['Umumiy Hisobot', 'Cashflow Forecast']
      ]).resize());
    }
    const userBranches = await getUserBranches(userId);
    return ctx.reply('Bekor qilindi.', Markup.keyboard([...userBranches, 'Bekor qilish'], { columns: 2 }).resize());
  }

  // Admin sessiya handlerlari
  const session = userSessions[userId];

  // LIMIT sessiyasi
  if (session && session.step === 'LIMIT_BRANCH') {
    const branch = text.replace('📍 ', '');
    if (['Integro','Drujba','Amir Temur','Central','Marketing'].includes(branch)) {
      session.limitBranch = text; session.step = 'LIMIT_CATEGORY';
      const cats = await getActiveCategories();
      return ctx.reply(text + ' uchun qaysi limit?\n"Umumiy filial" = umumiy chegara',
        Markup.keyboard([...cats, 'Umumiy filial', 'Bekor qilish'], { columns: 2 }).resize());
    }
  }
  if (session && session.step === 'LIMIT_CATEGORY') {
    session.limitCategory = text === 'Umumiy filial' ? null : text;
    session.step = 'LIMIT_AMOUNT';
    return ctx.reply(session.limitBranch + ' - ' + (session.limitCategory || 'Umumiy') + ' uchun oylik limit (raqam):');
  }
  if (session && session.step === 'LIMIT_AMOUNT') {
    const amount = parseSafeInt(text);
    if (!amount) return ctx.reply('Yaroqli raqam kiriting:');
    const ok = await setBudgetLimit(session.limitBranch, session.limitCategory, amount);
    delete userSessions[userId];
    return ctx.reply(ok ? `Saqlandi!\n${session.limitBranch} - ${session.limitCategory||'Umumiy'}: ${amount.toLocaleString()} UZS` : 'Xatolik.',
      Markup.keyboard([['Hisobot (Report)','Kutilayotgan (Waiting)'],['Cashflow'],['Limitlar','Kategoriyalar'],['Foydalanuvchilar']]).resize());
  }

  // KATEGORIYA sessiyasi
  if (session && session.step === 'ADD_CATEGORY') {
    const ok = await addCategory(text); delete userSessions[userId];
    return ctx.reply(ok ? `"${text}" qoshildi!` : 'Bu kategoriya allaqachon mavjud.');
  }
  if (session && session.step === 'DELETE_CATEGORY') {
    const ok = await deleteCategory(text); delete userSessions[userId];
    return ctx.reply(ok ? `"${text}" ochirildi!` : 'Topilmadi.');
  }
  if (text === 'Yangi kategoriya') {
    if (!isAdminUser || uid2 === HEAD_CEO_ID) return;
    userSessions[userId] = { step: 'ADD_CATEGORY' };
    return ctx.reply('Yangi kategoriya nomini kiriting:', Markup.keyboard(['Bekor qilish']).resize());
  }
  if (text === "Kategoriyani ochirish") {
    if (!isAdminUser || uid2 === HEAD_CEO_ID) return;
    const cats = await getActiveCategories();
    userSessions[userId] = { step: 'DELETE_CATEGORY' };
    return ctx.reply("Ochirmoqchi bolgan kategoriyani tanlang:", Markup.keyboard([...cats, 'Bekor qilish'], { columns: 2 }).resize());
  }

  // FOYDALANUVCHI sessiyasi
  if (text === 'Foydalanuvchi qoshish') {
    if (!isAdminUser || uid2 === HEAD_CEO_ID) return;
    userSessions[userId] = { step: 'USER_ADD_ID' };
    return ctx.reply('Xodimning Telegram ID sini kiriting:', Markup.keyboard(['Bekor qilish']).resize());
  }
  if (text === 'Foydalanuvchilar royxati') {
    if (!isAdminUser || uid2 === HEAD_CEO_ID) return;
    try {
      await doc.loadInfo();
      const sheet = doc.sheetsByTitle['Users'];
      const rows = await sheet.getRows();
      if (!rows.length) return ctx.reply("Hali foydalanuvchi qoshilmagan.");
      for (const r of rows) {
        const tid = r.get('Telegram ID');
        const cats = r.get('Categories') || '';
        const msg = r.get('Name') + '\nID: ' + tid + '\nRol: ' + r.get('Role') + '\nFiliallar: ' + r.get('Branches') + '\nKategoriyalar: ' + (cats.length>60?cats.substring(0,60)+'...':cats);
        await ctx.reply(msg, Markup.inlineKeyboard([
          [Markup.button.callback('Filiallarni ozgartirish', 'edit_branch_'+tid)],
          [Markup.button.callback('Kategoriyalarni ozgartirish', 'edit_cat_'+tid)],
          [Markup.button.callback("Xodimni ochirish", 'del_user_'+tid)]
        ]));
      }
    } catch(e) { ctx.reply('Xatolik.'); }
    return;
  }
  if (session && session.step === 'USER_ADD_ID') { session.newUserId = text; session.step = 'USER_ADD_NAME'; return ctx.reply('Xodim ismini kiriting:'); }
  if (session && session.step === 'USER_ADD_NAME') { session.newUserName = text; session.step = 'USER_ADD_ROLE'; return ctx.reply('Rolini tanlang:', Markup.keyboard(['Staff','Manager','Bekor qilish']).resize()); }
  if (session && session.step === 'USER_ADD_ROLE') {
    if (!['Staff','Manager'].includes(text)) return ctx.reply('Staff yoki Manager tanlang:');
    session.newUserRole = text; session.step = 'USER_ADD_BRANCHES'; session.selectedBranches = [];
    return ctx.reply('Filiallarni tanlang:', buildBranchButtons([]));
  }

  // XARAJAT WIZARD
  if (!session) {
    if (uid2 === HEAD_CEO_ID) return; // Head CEO kiritolmaydi
    const userBranches = await getUserBranches(userId);
    if (userBranches.includes(text)) userSessions[userId] = { step: 'BRANCH', branch: text };
    return;
  }

  if (session.step === 'BRANCH') {
    const userBranches = await getUserBranches(userId);
    if (userBranches.includes(text)) {
      session.branch = text; session.step = 'CATEGORY';
      const userCats = await getUserCategories(userId);
      return ctx.reply('Kategoriyani tanlang:', Markup.keyboard([...userCats, 'Bekor qilish'], { columns: 2 }).resize());
    }
  }
  if (session.step === 'CATEGORY') {
    session.category = text; session.step = 'AMOUNT';
    return ctx.reply('Summani kiriting (Faqat raqam):', Markup.keyboard(['Bekor qilish']).resize());
  }
  if (session.step === 'AMOUNT') {
    session.amount = parseSafeInt(text);
    if (session.amount === 0) return ctx.reply('Iltimos, yaroqli son kiriting:');
    session.step = 'DESCRIPTION';
    return ctx.reply('Xarajat sababi (Matn yozing yoki Ovozli xabar yuboring):');
  }
  if (session.step === 'DESCRIPTION') {
    if (voice) {
      session.description = "Ovozli izoh";
      session.voiceFileId = voice.file_id;
    } else if (text) {
      session.description = text;
      session.voiceFileId = null;
    } else {
      return ctx.reply("Iltimos, matn yoki ovozli xabar yuboring.");
    }
    session.step = 'PRIORITY';
    return ctx.reply('Muhimligi:', Markup.keyboard([...priorities, 'Bekor qilish'], { columns: 1 }).resize());
  }
  if (session.step === 'PRIORITY') {
    if (priorities.includes(text)) {
      session.priority = text;
      session.step = 'PAY_TYPE';
      return ctx.reply("To'lov turi:", Markup.keyboard(['Karta', 'Naqd', 'MCHJ hisobi', 'Bekor qilish']).resize());
    }
  }
  if (session.step === 'PAY_TYPE') {
    session.payType = text;
    if (text === 'Naqd') {
      session.payDetail = 'N/A';
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
  const msg = `Menejerga yuborishdan oldin tekshiring:\n\nFilial: ${session.branch}\nKategoriya: ${session.category}\nSumma: ${session.amount.toLocaleString('en-US')} UZS\nSabab: ${session.description}\nMuhimligi: ${session.priority}\nTolov: ${session.payType} (${session.payDetail})`;
  ctx.reply(msg, Markup.inlineKeyboard([
    [Markup.button.callback('Yuborish', 'submit_final')],
    [Markup.button.callback('Bekor qilish', 'cancel_final')]
  ]));
}

// ==========================================
// 9. SUBMISSION
// ==========================================
bot.action(/^(submit_final|cancel_final)$/, async (ctx) => {
  const action = ctx.match[1];
  const userId = ctx.from.id;
  const session = userSessions[userId];

  if (action === 'cancel_final') {
    delete userSessions[userId];
    await ctx.editMessageText('Sorov bekor qilindi.');
    return ctx.reply('Yangi sorov uchun filialni tanlang:', Markup.keyboard(branches, { columns: 2 }).resize());
  }

  if (action === 'submit_final' && session) {
    try {
      await doc.loadInfo();
      const budgetSheet = doc.sheetsByTitle['Budgets'];
      const expenseSheet = doc.sheetsByTitle['Pending_Expenses'];
      const budgetRows = await budgetSheet.getRows();
      const requested = session.amount;

      const catSpent = await getMonthlySpent(expenseSheet, session.branch, session.category);
      const cLimitRow = budgetRows.find(r => r.get('Branch') === session.branch && r.get('Category') === session.category);
      const cLimitValue = cLimitRow ? parseSafeInt(cLimitRow.get('Monthly Limit')) : Infinity;
      if ((catSpent + requested) > cLimitValue) {
        await ctx.editMessageText(`RAD ETILDI!\n\n${session.branch} filialidagi ${session.category} limiti oshdi.\nLimit: ${cLimitValue.toLocaleString()} UZS\nIshlatildi: ${(catSpent + requested).toLocaleString()} UZS`);
        return delete userSessions[userId];
      }

      const branchSpent = await getMonthlySpent(expenseSheet, session.branch);
      const bLimitRow = budgetRows.find(r => r.get('Branch') === session.branch && (!r.get('Category') || r.get('Category').trim() === ''));
      const bLimitValue = bLimitRow ? parseSafeInt(bLimitRow.get('Monthly Limit')) : Infinity;
      if ((branchSpent + requested) > bLimitValue) {
        await ctx.editMessageText(`RAD ETILDI!\n\n${session.branch} filial limiti oshdi.\nLimit: ${bLimitValue.toLocaleString()} UZS\nIshlatildi: ${(branchSpent + requested).toLocaleString()} UZS`);
        return delete userSessions[userId];
      }

      const row = await expenseSheet.addRow({
        'Timestamp': new Date().toLocaleString('en-US', { timeZone: 'Asia/Tashkent' }),
        'Branch': session.branch,
        'Staff Name': ctx.from.first_name,
        'Amount': session.amount,
        'Payment Type': session.payType,
        'Payment Detail': session.payDetail,
        'Description': `[${session.category}] ${session.description}`,
        'Status': 'PENDING',
        '_StaffChatId': userId.toString(),
        'Priority': session.priority,
        'GroupMsgId': ''
      });

      const budgetAudit = await getDoubleBudgetWarning(session.branch, session.category, session.amount);
      let buttons = [];
      if (budgetAudit.includes("O'TDI")) {
        buttons.push([Markup.button.callback('Rad etish (Limit xatosi)', `rej_${row.rowNumber}`)]);
      } else {
        buttons.push([Markup.button.callback('Tasdiqlash', `decide_${row.rowNumber}`)]);
        buttons.push([Markup.button.callback('Rad etish', `rej_${row.rowNumber}`)]);
      }

      const managerMsg = `Yangi Sorov\nFilial: ${session.branch}\nKimdan: ${ctx.from.first_name}\nSumma: ${session.amount.toLocaleString('en-US')} UZS\nTolov: ${session.payType} (${session.payDetail})\nSabab: ${session.description}\nMuhimligi: ${session.priority}${budgetAudit}`;

      for (let managerId of MANAGER_IDS) {
        await bot.telegram.sendMessage(managerId, managerMsg, Markup.inlineKeyboard(buttons)).catch(() => {});
        if (session.voiceFileId) {
          await bot.telegram.sendVoice(managerId, session.voiceFileId, { caption: `Ovozli izoh (ID: ${row.rowNumber})` }).catch(() => {});
        }
      }

      if (MAINTENANCE_GROUP_ID) {
        const groupMsg = `Yangi Sorov Yaratildi\n\nFilial: ${session.branch}\nKategoriya: ${session.category}\nSumma: ${session.amount.toLocaleString('en-US')} UZS\nSodirdi: ${ctx.from.first_name}\nSabab: ${session.description}\nMuhimligi: ${session.priority}\n\nHolati: Menejer tasdigi kutilmoqda...`;
        const groupPost = await bot.telegram.sendMessage(MAINTENANCE_GROUP_ID, groupMsg).catch(err => { console.error("Group Alert Error:", err.message); return null; });
        if (groupPost) {
          try { row.set('GroupMsgId', groupPost.message_id.toString()); await row.save(); } catch(err) {}
          if (session.voiceFileId) {
            await bot.telegram.sendVoice(MAINTENANCE_GROUP_ID, session.voiceFileId, { reply_to_message_id: groupPost.message_id }).catch(() => {});
          }
        }
      }

      delete userSessions[userId];
      await ctx.editMessageText(`Muvaffaqiyatli yuborildi!\nID: ${row.rowNumber}`);
      ctx.reply('Yangi sorov uchun filialni tanlang:', Markup.keyboard(branches, { columns: 2 }).resize());
    } catch (e) {
      delete userSessions[userId];
      ctx.editMessageText('Xatolik yuz berdi.');
      console.error(e);
    }
  } else {
    delete userSessions[userId];
    ctx.editMessageText('Sessiya tugadi. /start bosing.');
  }
});

// ==========================================
// 10. STAFF CONFIRM
// ==========================================
bot.action(/^staffconfirm_(\d+)$/, async (ctx) => {
  const rowNum = ctx.match[1];
  try {
    await doc.loadInfo();
    const rows = await doc.sheetsByTitle['Pending_Expenses'].getRows();
    const row = rows.find(r => r.rowNumber == rowNum);
    if (!row) return ctx.answerCbQuery("ID topilmadi.");
    row.set('Status', 'PAID');
    await row.save();
    await ctx.editMessageCaption('PUL QABUL QILINDI VA YOPILDI.');
    
    for (let managerId of MANAGER_IDS) {
      await bot.telegram.sendMessage(managerId, `Xodim ${parseSafeInt(row.get('Amount')).toLocaleString('en-US')} UZS miqdoridagi pulni olganini tasdiqladi. (ID: ${rowNum})`).catch(() => {});
    }
    const groupMsgId = row.get('GroupMsgId');
    if (MAINTENANCE_GROUP_ID && groupMsgId) {
      await bot.telegram.sendMessage(MAINTENANCE_GROUP_ID, `Xodim to'lovni qabul qildi. Tasdiqlandi.`, { reply_to_message_id: parseInt(groupMsgId) }).catch(() => {});
    }
  } catch(e) { console.error(e); ctx.answerCbQuery("Xatolik."); }
});

// ==========================================
// 11. MANAGER ACTIONS
// ==========================================
bot.action(/^(decide|paynow|schedD|schedF|schedM|rej)_(\d+)(?:_(\d+))?$/, async (ctx) => {
  if (!MANAGER_IDS.includes(ctx.from.id.toString())) return ctx.answerCbQuery("Sizda huquq yo'q.");
  const [action, rowNum, param] = [ctx.match[1], ctx.match[2], ctx.match[3]];
  try {
    await doc.loadInfo();
    const rows = await doc.sheetsByTitle['Pending_Expenses'].getRows();
    const row = rows.find(r => r.rowNumber == rowNum);
    if (!row) return ctx.editMessageText("Xatolik: Qator topilmadi.");
    if (['decide', 'rej'].includes(action) && row.get('Status') !== 'PENDING') {
      return ctx.editMessageText("Boshqa menejer tomonidan ko'rib chiqilgan.");
    }
    const staffId = row.get('_StaffChatId');
    const payType = row.get('Payment Type');
    const payDetail = row.get('Payment Detail');
    const formattedAmount = parseSafeInt(row.get('Amount')).toLocaleString('en-US');

    if (action === 'decide') {
      return ctx.editMessageText(
        `Qachon tolaysiz?\nTolov: ${payType} (${payDetail})\nSumma: ${formattedAmount} UZS`,
        Markup.inlineKeyboard([
          [Markup.button.callback('Hozir Tolash', `paynow_${rowNum}`)],
          [Markup.button.callback('Dushanba', `schedD_${rowNum}_1`), Markup.button.callback('Seshanba', `schedD_${rowNum}_2`)],
          [Markup.button.callback('Chorshanba', `schedD_${rowNum}_3`), Markup.button.callback('Payshanba', `schedD_${rowNum}_4`)],
          [Markup.button.callback('Juma', `schedD_${rowNum}_5`)],
          [Markup.button.callback('15 kun', `schedF_${rowNum}_15`), Markup.button.callback('1 oy', `schedM_${rowNum}`)]
        ])
      );
    }

    if (action === 'paynow') {
      if (!['PENDING', 'SCHEDULED'].includes(row.get('Status'))) return ctx.answerCbQuery('Bu sorov allaqachon qayta ishlangan!');
      row.set('Status', 'SCHEDULED');
      row.set('Scheduled Date', getTodayStr());
      await row.save();
      await updateGroupMessageStatus(row, true);
      await bot.telegram.sendMessage(staffId, `To'lov tasdiqlandi! Pul o'tkazilmoqda.`);
      return ctx.editMessageText(
        `Hozir tolash tanlandi.\nTolov: ${payType} (${payDetail})\nSumma: ${formattedAmount} UZS\n\nUshbu xabarga CHEK RASMINI REPLY qiling.\nID: ${rowNum}`
      );
    }

    if (action.startsWith('sched')) {
      let d = '';
      if (action === 'schedD') d = getScheduledDateStr('D', parseInt(param));
      if (action === 'schedF') d = getScheduledDateStr('F', parseInt(param));
      if (action === 'schedM') d = getScheduledDateStr('M', 0);
      row.set('Status', 'SCHEDULED');
      row.set('Scheduled Date', d);
      await row.save();
      await updateGroupMessageStatus(row, true);
      await bot.telegram.sendMessage(staffId, `Tasdiqlandi. Tolov sanasi: ${d}`);
      return ctx.editMessageText(`${d} sanasiga rejalashtirildi.\nTolov: ${payType} (${payDetail})\nSumma: ${formattedAmount} UZS`);
    }

    if (action === 'rej') {
      row.set('Status', 'REJECTED');
      await row.save();
      await updateGroupMessageStatus(row, false);
      await bot.telegram.sendMessage(staffId, `Sorov rad etildi.`);
      return ctx.editMessageText('Rad etildi va yopildi.');
    }
  } catch (e) {
    console.error(e);
    ctx.editMessageText("Amalni bajarishda xatolik.");
  }
});

async function updateGroupMessageStatus(row, isApproved) {
  const groupMsgId = row.get('GroupMsgId');
  if (MAINTENANCE_GROUP_ID && groupMsgId) {
    const amt = parseSafeInt(row.get('Amount')).toLocaleString('en-US');
    const statusText = isApproved ? "Holati: Menejer tasdiqladi" : "Holati: Menejer tomonidan rad etildi";
    const newMsg = `Sorov\n\nFilial: ${row.get('Branch')}\nSumma: ${amt} UZS\nSodirdi: ${row.get('Staff Name')}\nSabab: ${row.get('Description')}\n\n${statusText}`;
    await bot.telegram.editMessageText(MAINTENANCE_GROUP_ID, parseInt(groupMsgId), null, newMsg).catch(() => {});
  }
}

// ==========================================
// USERS JADVALI
// ==========================================
async function getUserData(telegramId) {
  try {
    await doc.loadInfo();
    const sheet = doc.sheetsByTitle['Users'];
    if (!sheet) return null;
    const rows = await sheet.getRows();
    return rows.find(r => r.get('Telegram ID') === telegramId.toString()) || null;
  } catch (e) { return null; }
}

async function getUserBranches(telegramId) {
  const uid = telegramId.toString();
  if (MANAGER_IDS.includes(uid) || uid === CEO_ID || uid === HEAD_CEO_ID) return branches;
  const user = await getUserData(uid);
  if (!user) return branches;
  const br = user.get('Branches') || '';
  if (!br.trim() || br.toLowerCase() === 'hammasi') return branches;
  return br.split(',').map(b => {
    const clean = b.trim();
    return branches.find(be => be.includes(clean)) || ('📍 ' + clean);
  }).filter(Boolean);
}

async function getUserCategories(telegramId) {
  const uid = telegramId.toString();
  if (MANAGER_IDS.includes(uid) || uid === CEO_ID || uid === HEAD_CEO_ID) return await getActiveCategories();
  const user = await getUserData(uid);
  if (!user) return categories;
  const cats = user.get('Categories') || '';
  if (!cats.trim() || cats.toLowerCase() === 'hammasi') return await getActiveCategories();
  return cats.split(',').map(c => c.trim()).filter(Boolean);
}

async function saveUserData(telegramId, name, role, branchStr, catStr) {
  await doc.loadInfo();
  const sheet = doc.sheetsByTitle['Users'];
  if (!sheet) return false;
  const rows = await sheet.getRows();
  const existing = rows.find(r => r.get('Telegram ID') === telegramId.toString());
  if (existing) {
    existing.set('Name', name); existing.set('Role', role);
    existing.set('Branches', branchStr); existing.set('Categories', catStr);
    await existing.save();
  } else {
    await sheet.addRow({ 'Telegram ID': telegramId.toString(), 'Name': name, 'Role': role, 'Branches': branchStr, 'Categories': catStr });
  }
  // Bust cache — new/changed user should be immediately recognized
  cachedStaffIds.add(telegramId.toString());
  return true;
}

// ==========================================
// KATEGORIYALAR
// ==========================================
async function getActiveCategories() {
  try {
    await doc.loadInfo();
    const sheet = doc.sheetsByTitle['Categories'];
    if (!sheet) return categories;
    const rows = await sheet.getRows();
    const active = rows.filter(r => r.get('Active') !== 'FALSE' && r.get('Name')).map(r => r.get('Name'));
    return active.length > 0 ? active : categories;
  } catch (e) { return categories; }
}

async function addCategory(name) {
  try {
    await doc.loadInfo();
    let catSheet = doc.sheetsByTitle['Categories'];
    if (!catSheet) catSheet = await doc.addSheet({ title: 'Categories', headerValues: ['Name', 'Active', 'Created'] });
    const catRows = await catSheet.getRows();
    if (catRows.find(r => r.get('Name') === name)) return false;
    await catSheet.addRow({ 'Name': name, 'Active': 'TRUE', 'Created': new Date().toLocaleString('uz-UZ', { timeZone: 'Asia/Tashkent' }) });
    const budgetSheet = doc.sheetsByTitle['Budgets'];
    if (budgetSheet) {
      const budgetRows = await budgetSheet.getRows();
      for (const branch of branches) {
        if (!budgetRows.find(r => r.get('Branch') === branch && r.get('Category') === name))
          await budgetSheet.addRow({ 'Branch': branch, 'Category': name, 'Monthly Limit': '0' });
      }
    }
    return true;
  } catch (e) { return false; }
}

async function deleteCategory(name) {
  try {
    await doc.loadInfo();
    const catSheet = doc.sheetsByTitle['Categories'];
    if (!catSheet) return false;
    const catRows = await catSheet.getRows();
    const catRow = catRows.find(r => r.get('Name') === name);
    if (!catRow) return false;
    catRow.set('Active', 'FALSE'); await catRow.save();
    return true;
  } catch (e) { return false; }
}

async function setBudgetLimit(branch, category, limit) {
  await doc.loadInfo();
  const sheet = doc.sheetsByTitle['Budgets'];
  if (!sheet) return false;
  const rows = await sheet.getRows();
  let row = category
    ? rows.find(r => r.get('Branch') === branch && r.get('Category') === category)
    : rows.find(r => r.get('Branch') === branch && (!r.get('Category') || r.get('Category').trim() === ''));
  if (row) { row.set('Monthly Limit', limit.toString()); await row.save(); }
  else await sheet.addRow({ 'Branch': branch, 'Category': category || '', 'Monthly Limit': limit.toString() });
  return true;
}

// ==========================================
// HISOBOT OY TANLASH
// ==========================================
async function getAvailableMonths() {
  await doc.loadInfo();
  const rows = await doc.sheetsByTitle['Pending_Expenses'].getRows();
  const monthSet = new Set();
  rows.forEach(r => {
    const d = new Date(r.get('Timestamp'));
    if (!isNaN(d)) monthSet.add(d.getFullYear() + '-' + String(d.getMonth()+1).padStart(2,'0'));
  });
  return Array.from(monthSet).sort().reverse();
}

function getMonthName(monthStr) {
  const months = ['Yanvar','Fevral','Mart','Aprel','May','Iyun','Iyul','Avgust','Sentabr','Oktabr','Noyabr','Dekabr'];
  const [year, month] = monthStr.split('-');
  return months[parseInt(month)-1] + ' ' + year;
}

async function generateReportByMonth(monthFilter) {
  await doc.loadInfo();
  const rows = await doc.sheetsByTitle['Pending_Expenses'].getRows();
  const filtered = rows.filter(r => {
    const d = new Date(r.get('Timestamp'));
    if (isNaN(d)) return false;
    if (monthFilter === 'all') return true;
    return (d.getFullYear() + '-' + String(d.getMonth()+1).padStart(2,'0')) === monthFilter;
  });
  const paid = filtered.filter(r => r.get('Status') === 'PAID' || r.get('Status') === 'CHEQUE_SENT');
  const pending = filtered.filter(r => r.get('Status') === 'PENDING');
  const scheduled = filtered.filter(r => r.get('Status') === 'SCHEDULED');
  const rejected = filtered.filter(r => r.get('Status') === 'REJECTED');
  let branchTotals = {}, catTotals = {}, grandTotal = 0;
  paid.forEach(r => {
    const b = r.get('Branch') || 'Nomalum';
    const val = parseSafeInt(r.get('Amount'));
    branchTotals[b] = (branchTotals[b] || 0) + val; grandTotal += val;
    const m = (r.get('Description') || '').match(/\[([^\]]+)\]/);
    const cat = m ? m[1] : 'Boshqa';
    catTotals[cat] = (catTotals[cat] || 0) + val;
  });
  const label = monthFilter === 'all' ? 'Barcha vaqt' : getMonthName(monthFilter);
  let msg = `MOLIYA HISOBOTI - ${label}\n==========================\n`;
  msg += `Tolangan: ${grandTotal.toLocaleString('en-US')} UZS\n`;
  msg += `Kutilayotgan: ${pending.length} ta (${pending.reduce((s,r)=>s+parseSafeInt(r.get('Amount')),0).toLocaleString('en-US')} UZS)\n`;
  msg += `Rejalashtirilgan: ${scheduled.length} ta\nRad etilgan: ${rejected.length} ta\n\nFiliallar boyicha:\n`;
  branches.forEach(b => { if (branchTotals[b]) msg += `${b}: ${branchTotals[b].toLocaleString('en-US')} UZS\n`; });
  const topCats = Object.entries(catTotals).sort((a,b)=>b[1]-a[1]).slice(0,5);
  if (topCats.length) { msg += '\nTop kategoriyalar:\n'; topCats.forEach(([c,a])=>{ msg += `${c}: ${a.toLocaleString('en-US')} UZS\n`; }); }
  return msg;
}

// ==========================================
// CEO PROCUREMENT HISOBOTI
// ==========================================
async function sendProcurementReport(ctx, uid) {
  try {
    await doc.loadInfo();
    const rows = await doc.sheetsByTitle['Pending_Expenses'].getRows();
    const todayStr = getTodayStr();
    const now = new Date(new Date().getTime() + (5 * 60 * 60 * 1000));

    // 1. QANCHA QAYERGA XARAJAT QILINGAN (shu oy)
    let branchSpent = {};
    let totalPaid = 0;
    let categorySpent = {};

    rows.forEach(r => {
      const status = r.get('Status');
      if (status === 'PAID' || status === 'CHEQUE_SENT') {
        const dateStr = r.get('Timestamp');
        if (!dateStr) return;
        const rowDate = new Date(dateStr);
        if (rowDate.getMonth() === now.getMonth() && rowDate.getFullYear() === now.getFullYear()) {
          const b = r.get('Branch') || 'Nomalum';
          const amt = parseSafeInt(r.get('Amount'));
          branchSpent[b] = (branchSpent[b] || 0) + amt;
          totalPaid += amt;
          const m = (r.get('Description') || '').match(/\[([^\]]+)\]/);
          const cat = m ? m[1] : 'Boshqa';
          categorySpent[cat] = (categorySpent[cat] || 0) + amt;
        }
      }
    });

    // 2. KECHIKKAN TO'LOVLAR (scheduled date < today, status != PAID)
    let latePayments = [];
    rows.forEach(r => {
      const status = r.get('Status');
      if (status === 'SCHEDULED') {
        const sDate = r.get('Scheduled Date');
        if (sDate && sDate < todayStr) {
          latePayments.push(r);
        }
      }
    });

    // 3. KECH TASDIQLANGANLAR (PENDING > 3 kun)
    let stuckPending = [];
    const threeDaysAgo = new Date(now.getTime() - (3 * 24 * 60 * 60 * 1000));
    rows.forEach(r => {
      if (r.get('Status') === 'PENDING') {
        const ts = r.get('Timestamp');
        if (ts) {
          const submitted = new Date(ts);
          if (submitted < threeDaysAgo) {
            stuckPending.push(r);
          }
        }
      }
    });

    // Reportni chiqarish
    let msg = `📊 *PROCUREMENT NAZORATI HISOBOTI*\n━━━━━━━━━━━━━━━\n\n`;

    // Qancha qayerga
    msg += `💰 *SHU OY XARAJATLARI:* ${totalPaid.toLocaleString('en-US')} UZS\n\n`;
    if (Object.keys(branchSpent).length) {
      msg += `📍 *Filiallar bo'yicha:*\n`;
      const sortedBranches = Object.entries(branchSpent).sort((a,b) => b[1] - a[1]);
      sortedBranches.forEach(([b, amt]) => {
        msg += `  ${b}: ${amt.toLocaleString('en-US')} UZS\n`;
      });
    }
    if (Object.keys(categorySpent).length) {
      msg += `\n🗂 *Top kategoriyalar:*\n`;
      const topCats = Object.entries(categorySpent).sort((a,b) => b[1] - a[1]).slice(0, 5);
      topCats.forEach(([c, amt]) => {
        msg += `  ${c}: ${amt.toLocaleString('en-US')} UZS\n`;
      });
    }

    // Kechikkan to'lovlar
    msg += `\n━━━━━━━━━━━━━━━\n`;
    if (latePayments.length > 0) {
      let lateTotal = 0;
      latePayments.forEach(r => { lateTotal += parseSafeInt(r.get('Amount')); });
      msg += `🔴 *KECHIKKAN TO'LOVLAR:* ${latePayments.length} ta (${lateTotal.toLocaleString('en-US')} UZS)\n`;
      msg += `_(Menejer to'lov sanasini belgilagan lekin pul o'tkazilmagan)_\n\n`;
      const showLate = latePayments.slice(0, 5);
      showLate.forEach(r => {
        msg += `  ❌ ${r.get('Branch')} | ${parseSafeInt(r.get('Amount')).toLocaleString('en-US')} UZS | ${r.get('Scheduled Date')}\n`;
      });
      if (latePayments.length > 5) msg += `  ... va yana ${latePayments.length - 5} ta\n`;
    } else {
      msg += `✅ To'lovlarda kechikish yo'q.\n`;
    }

    // Kech tasdiqlanganlar
    msg += `\n━━━━━━━━━━━━━━━\n`;
    if (stuckPending.length > 0) {
      let stuckTotal = 0;
      stuckPending.forEach(r => { stuckTotal += parseSafeInt(r.get('Amount')); });
      msg += `🟠 *TASDIQLANMAY QOLGAN SO'ROVLAR:* ${stuckPending.length} ta (${stuckTotal.toLocaleString('en-US')} UZS)\n`;
      msg += `_(3 kundan ortiq vaqt davomida ko'rib chiqilmagan)_\n\n`;
      const showStuck = stuckPending.slice(0, 5);
      showStuck.forEach(r => {
        const ts = r.get('Timestamp') || '';
        msg += `  ⚠️ ${r.get('Branch')} | ${parseSafeInt(r.get('Amount')).toLocaleString('en-US')} UZS | ${ts.substring(0,10)}\n`;
      });
      if (stuckPending.length > 5) msg += `  ... va yana ${stuckPending.length - 5} ta\n`;
    } else {
      msg += `✅ Tasdiqlanishi kutilayotgan eski so'rovlar yo'q.\n`;
    }

    await ctx.reply(msg, { parse_mode: 'Markdown' });

  } catch(e) {
    console.error('sendProcurementReport:', e);
    ctx.reply('Xatolik yuz berdi.');
  }
}

// ==========================================
// INLINE SELEKTORLAR
// ==========================================
function buildBranchButtons(selected) {
  const ALL = ['Integro','Drujba','Amir Temur','Central','Marketing'];
  const rows = [];
  for (let i = 0; i < ALL.length; i += 2)
    rows.push(ALL.slice(i,i+2).map(b => Markup.button.callback((selected.includes(b)?'OK ':'-- ')+b, 'selbranch_'+b)));
  rows.push([Markup.button.callback('Hammasi','selbranch_all'), Markup.button.callback('Tayyor','selbranch_done')]);
  return Markup.inlineKeyboard(rows);
}

async function buildCategoryButtons(selected) {
  const cats = await getActiveCategories();
  const rows = [];
  for (let i = 0; i < cats.length; i += 2)
    rows.push(cats.slice(i,i+2).map(c => Markup.button.callback((selected.includes(c)?'OK ':'-- ')+c.substring(0,18), 'selcat_'+cats.indexOf(c))));
  rows.push([Markup.button.callback('Hammasi','selcat_all'), Markup.button.callback('Tayyor','selcat_done')]);
  return Markup.inlineKeyboard(rows);
}

bot.action(/^selbranch_(.+)$/, async (ctx) => {
  const uid = ctx.from.id;
  const session = userSessions[uid];
  if (!session || !['USER_ADD_BRANCHES','EDIT_BRANCH'].includes(session.step)) return ctx.answerCbQuery();
  const val = ctx.match[1];
  if (!session.selectedBranches) session.selectedBranches = [];
  if (val === 'all') { session.selectedBranches = ['Integro','Drujba','Amir Temur','Central','Marketing']; session.allBranchesSelected = true; }
  else if (val === 'done') {
    if (!session.selectedBranches.length) return ctx.answerCbQuery('Kamida 1 ta tanlang!');
    const brStr = session.allBranchesSelected ? 'hammasi' : session.selectedBranches.join(', ');
    if (session.step === 'EDIT_BRANCH') {
      const user = await getUserData(session.editUserId);
      if (user) { user.set('Branches', brStr); await user.save(); }
      await ctx.editMessageText('Filiallar yangilandi: ' + brStr);
      delete userSessions[uid]; return ctx.answerCbQuery('Saqlandi!');
    }
    session.newUserBranches = brStr; session.step = 'USER_ADD_CATEGORIES';
    session.selectedCategories = []; session.allCatsSelected = false;
    await ctx.editMessageText('Filiallar: ' + brStr + '\n\nKategoriyalarni tanlang:', await buildCategoryButtons([]));
    return ctx.answerCbQuery();
  } else {
    const idx = session.selectedBranches.indexOf(val);
    if (idx > -1) session.selectedBranches.splice(idx,1); else session.selectedBranches.push(val);
    session.allBranchesSelected = false;
  }
  await ctx.editMessageText('Filiallarni tanlang:\nTanlangan: '+(session.selectedBranches.length?session.selectedBranches.join(', '):'hech biri'), buildBranchButtons(session.selectedBranches)).catch(()=>{});
  ctx.answerCbQuery();
});

bot.action(/^selcat_(.+)$/, async (ctx) => {
  const uid = ctx.from.id;
  const session = userSessions[uid];
  if (!session || !['USER_ADD_CATEGORIES','EDIT_CAT'].includes(session.step)) return ctx.answerCbQuery();
  const val = ctx.match[1];
  const allCats = await getActiveCategories();
  if (!session.selectedCategories) session.selectedCategories = [];
  if (val === 'all') { session.selectedCategories = [...allCats]; session.allCatsSelected = true; }
  else if (val === 'done') {
    if (!session.selectedCategories.length) return ctx.answerCbQuery('Kamida 1 ta tanlang!');
    const catStr = session.allCatsSelected ? 'hammasi' : session.selectedCategories.join(', ');
    if (session.step === 'EDIT_CAT') {
      const user = await getUserData(session.editUserId);
      if (user) { user.set('Categories', catStr); await user.save(); }
      await ctx.editMessageText('Kategoriyalar yangilandi: ' + catStr.substring(0,80));
      delete userSessions[uid]; return ctx.answerCbQuery('Saqlandi!');
    }
    const ok = await saveUserData(session.newUserId, session.newUserName, session.newUserRole, session.newUserBranches, catStr);
    await ctx.editMessageText(ok ? `Saqlandi!\nID: ${session.newUserId}\nIsm: ${session.newUserName}\nFiliallar: ${session.newUserBranches}` : 'Xatolik.');
    delete userSessions[uid];
    return ctx.reply('Admin paneli:', Markup.keyboard([['Hisobot (Report)','Kutilayotgan (Waiting)'],['Cashflow'],['Limitlar','Kategoriyalar'],['Foydalanuvchilar']]).resize());
  } else {
    const fullCat = allCats[parseInt(val)];
    if (fullCat) { const ci = session.selectedCategories.indexOf(fullCat); if(ci>-1) session.selectedCategories.splice(ci,1); else session.selectedCategories.push(fullCat); }
    session.allCatsSelected = false;
  }
  await ctx.editMessageText('Kategoriyalarni tanlang:\nTanlangan: '+(session.selectedCategories.length?session.selectedCategories.length+' ta':'hech biri'), await buildCategoryButtons(session.selectedCategories)).catch(()=>{});
  ctx.answerCbQuery();
});

bot.action(/^report_(.+)$/, async (ctx) => {
  if (!MANAGER_IDS.includes(ctx.from.id.toString()) && ctx.from.id.toString() !== CEO_ID && ctx.from.id.toString() !== HEAD_CEO_ID) return ctx.answerCbQuery();
  try {
    await ctx.editMessageText('Hisobot tayyorlanmoqda...');
    const msg = await generateReportByMonth(ctx.match[1]);
    await ctx.editMessageText(msg);
  } catch(e) { ctx.editMessageText('Xatolik.'); }
  ctx.answerCbQuery();
});

bot.action(/^edit_branch_(.+)$/, async (ctx) => {
  if (!MANAGER_IDS.includes(ctx.from.id.toString()) && ctx.from.id.toString() !== CEO_ID) return ctx.answerCbQuery();
  const tid = ctx.match[1]; const uid = ctx.from.id;
  const user = await getUserData(tid);
  const br = user ? user.get('Branches') || '' : '';
  const sel = br === 'hammasi' ? ['Integro','Drujba','Amir Temur','Central','Marketing'] : br.split(',').map(b=>b.trim()).filter(Boolean);
  userSessions[uid] = { step: 'EDIT_BRANCH', editUserId: tid, selectedBranches: sel, allBranchesSelected: br === 'hammasi' };
  await ctx.editMessageReplyMarkup(null).catch(()=>{});
  await ctx.reply('Filiallarni tanlang (hozirgi: '+(sel.length?sel.join(', '):'hech biri')+'):', buildBranchButtons(sel));
  ctx.answerCbQuery();
});

bot.action(/^edit_cat_(.+)$/, async (ctx) => {
  if (!MANAGER_IDS.includes(ctx.from.id.toString()) && ctx.from.id.toString() !== CEO_ID) return ctx.answerCbQuery();
  const tid = ctx.match[1]; const uid = ctx.from.id;
  const allCats = await getActiveCategories();
  const user = await getUserData(tid);
  const cats = user ? user.get('Categories') || '' : '';
  const sel = cats === 'hammasi' ? [...allCats] : cats.split(',').map(c=>c.trim()).filter(Boolean);
  userSessions[uid] = { step: 'EDIT_CAT', editUserId: tid, selectedCategories: sel, allCatsSelected: cats === 'hammasi' };
  await ctx.editMessageReplyMarkup(null).catch(()=>{});
  await ctx.reply('Kategoriyalarni tanlang ('+sel.length+' ta tanlangan):', await buildCategoryButtons(sel));
  ctx.answerCbQuery();
});

bot.action(/^del_user_(.+)$/, async (ctx) => {
  if (!MANAGER_IDS.includes(ctx.from.id.toString()) && ctx.from.id.toString() !== CEO_ID) return ctx.answerCbQuery();
  try {
    await doc.loadInfo();
    const sheet = doc.sheetsByTitle['Users'];
    const rows = await sheet.getRows();
    const row = rows.find(r => r.get('Telegram ID') === ctx.match[1]);
    if (!row) return ctx.answerCbQuery('Topilmadi.');
    const name = row.get('Name'); await row.delete();
    cachedStaffIds.delete(ctx.match[1]); // Bust cache
    await ctx.editMessageText(name + " o'chirildi.");
  } catch(e) { ctx.answerCbQuery('Xatolik.'); }
  ctx.answerCbQuery();
});

// ==========================================
// XATOLIK LOGI
// ==========================================
const fs = require('fs');
const logError = (msg, err) => {
  const line = `[${new Date().toISOString()}] ${msg}: ${err?.message || err}\n`;
  try { fs.appendFileSync('error.log', line); } catch {}
  console.error(line);
};

// ==========================================
// BOOTSTRAP
// ==========================================
bot.launch({ dropPendingUpdates: false }).then(() => console.log('IELTS Zone Finance Bot ishga tushdi!'));
process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));

// Global xatolik ushlagich
process.on('unhandledRejection', (reason, promise) => {
  logError('unhandledRejection', reason);
});
process.on('uncaughtException', (err) => {
  logError('uncaughtException', err);
});
