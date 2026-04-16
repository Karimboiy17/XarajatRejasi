const { Telegraf, Markup } = require('telegraf');
const { JWT } = require('google-auth-library');
const { GoogleSpreadsheet } = require('google-spreadsheet');
const cron = require('node-cron');

// ==========================================
// 1. ENVIRONMENT & AUTHENTICATION
// ==========================================
const bot = new Telegraf(process.env.BOT_TOKEN);
const SHEET_ID = process.env.SHEET_ID;

// UPDATED: Parse multiple managers from a comma-separated string
const MANAGER_IDS = process.env.MANAGER_CHAT_IDS ? process.env.MANAGER_CHAT_IDS.split(',').map(id => id.trim()) : [];
const CEO_ID = process.env.CEO_CHAT_ID || "NO_CEO"; 
const MAINTENANCE_GROUP_ID = process.env.MAINTENANCE_GROUP_ID || null;

const creds = JSON.parse(process.env.GCP_SERVICE_ACCOUNT);
const auth = new JWT({
  email: creds.client_email,
  key: creds.private_key,
  scopes: ['https://www.googleapis.com/auth/spreadsheets'],
});
const doc = new GoogleSpreadsheet(SHEET_ID, auth);

// Memory state for user conversations (Fixes loop bugs)
const userSessions = {};

// ==========================================
// 2. CONSTANTS & DICTIONARIES
// ==========================================
const branches = ['📍 Integro', '📍 Drujba', '📍 Amir Temur', '📍 Central', '📍 Marketing'];
const categories = ['tugilgan kun uchun', 'printer rang', 'Printer tuzatish', 'remont-tuzatish', 'Hodimlar uchun dorilar', 'jihoz', 'Texnikalar', 'Transport', 'aromatizator', 'Internet', 'Telefon', 'of the month', 'Event', 'Reklama mahsulotlarini chiqarish', 'giftbox sovgalar', 'syomka xarajatlari', 'bozorlik xojalik', 'Suv va stakan', 'Konstovar', 'Plastik foizi', 'ofis xarajatlari', 'remont qurilish'];
const priorities = ["🔴 O'ta muhim (Bugun)", "🟡 O'rtacha (Ertaga)", "🔵 Normal (Shu hafta)", "🟢 Shoshilinch emas (Shu oy)"];

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
  const tashkentTime = new Date(new Date().getTime() + (5 * 60 * 60 * 1000));
  if (type === 'D') { 
    const currentDay = tashkentTime.getUTCDay(); 
    let distance = param - currentDay;
    if (distance <= 0) distance += 7; 
    tashkentTime.setUTCDate(tashkentTime.getUTCDate() + distance);
  } else if (type === 'F') {
    tashkentTime.setUTCDate(tashkentTime.getUTCDate() + param);
  } else if (type === 'M') {
    tashkentTime.setUTCMonth(tashkentTime.getUTCMonth() + 1); 
  }
  return tashkentTime.toISOString().split('T')[0];
}

function cleanPriority(priorityStr) {
  if (!priorityStr) return "Normal";
  return priorityStr.split('(')[0].trim(); 
}

// ==========================================
// 4. ADVANCED BUDGET ENGINE (Cumulative)
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
    
    if (!budgetSheet || !expenseSheet) return '\n\n⚠️ *Tizim Xatosi: Jadvallar topilmadi.*';

    const budgetRows = await budgetSheet.getRows();
    const requested = parseSafeInt(amountStr);

    // 1. Audit Branch Total 
    const branchBudgetRow = budgetRows.find(r => r.get('Branch') === branch && (!r.get('Category') || r.get('Category').trim() === ''));
    const branchSpent = await getMonthlySpent(expenseSheet, branch);
    let branchMsg = "ℹ️ Umumiy filial limiti belgilanmagan.";
    
    if (branchBudgetRow) {
      const bLimit = parseSafeInt(branchBudgetRow.get('Monthly Limit'));
      if (branchSpent + requested > bLimit) {
        branchMsg = `🔴 *UMUMIY FILIAL LIMITI O'TDI!* (${branchSpent.toLocaleString()} / ${bLimit.toLocaleString()})`;
      } else {
        branchMsg = `✅ Filial Zaxirasi: ${(bLimit - (branchSpent + requested)).toLocaleString()} UZS`;
      }
    }

    // 2. Audit Specific Category
    const catBudgetRow = budgetRows.find(r => r.get('Branch') === branch && r.get('Category') === category);
    const catSpent = await getMonthlySpent(expenseSheet, branch, category);
    let catMsg = `ℹ️ ${category} limiti belgilanmagan.`;
    
    if (catBudgetRow) {
      const cLimit = parseSafeInt(catBudgetRow.get('Monthly Limit'));
      if (catSpent + requested > cLimit) {
        catMsg = `🔴 *${category.toUpperCase()} LIMITI O'TDI!* (${catSpent.toLocaleString()} / ${cLimit.toLocaleString()})`;
      } else {
        catMsg = `✅ ${category} Zaxirasi: ${(cLimit - (catSpent + requested)).toLocaleString()} UZS`;
      }
    }

    return `\n\n📊 *Budjet Nazorati (${branch}):*\n${branchMsg}\n${catMsg}`;
  } catch (e) { 
    return '\n\n⚠️ *Budjetni hisoblashda xatolik yuz berdi.*'; 
  }
}

// ==========================================
// 5. REPORTING & DASHBOARDS
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
    branches.forEach(b => { 
        msg += `• ${b}: ${(branchTotals[b] || 0).toLocaleString('en-US')} UZS\n`; 
    });
    
    return msg;
}

bot.command('admin', (ctx) => {
  const uid = ctx.from.id.toString();
  // UPDATED: Check array
  if (MANAGER_IDS.includes(uid)) {
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
  // UPDATED: Check array
  if (!MANAGER_IDS.includes(uid) && uid !== CEO_ID) return;
  
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
    sortedDates.forEach(d => { 
        msg += `🗓 *${d}* ➔ ${dates[d].toLocaleString('en-US')} UZS\n`; 
    });
    
    msg += `━━━━━━━━━━━━━━━\n💰 *Kutilayotgan Jami:* ${total.toLocaleString('en-US')} UZS`;
    ctx.reply(msg, { parse_mode: 'Markdown' });
  } catch (e) { 
    ctx.reply('❌ Xatolik.'); 
  }
});

bot.hears(['📊 Hisobot (Report)', '📈 Umumiy Hisobot'], async (ctx) => {
  const uid = ctx.from.id.toString();
  // UPDATED: Check array
  if (!MANAGER_IDS.includes(uid) && uid !== CEO_ID) return;
  
  try { 
      const reportMsg = await generateGlobalReport();
      ctx.reply(reportMsg, { parse_mode: 'Markdown' }); 
  } catch (e) { 
      ctx.reply('❌ Xatolik.'); 
  }
});

bot.hears('⏳ Kutilayotgan (Waiting)', async (ctx) => {
  // UPDATED: Check array
  if (!MANAGER_IDS.includes(ctx.from.id.toString())) return;
  
  try {
    await doc.loadInfo();
    const rows = await doc.sheetsByTitle['Pending_Expenses'].getRows();
    const waiting = rows.filter(r => r.get('Status') === 'SCHEDULED');
    
    if (waiting.length === 0) return ctx.reply("✅ Kutilayotgan to'lovlar yo'q.");
    
    let msg = `⏳ *Kutilayotgan To'lovlar ro'yxati*\n━━━━━━━━━━━━━━━\n`;
    let totalWait = 0;
    let buttons = [];
    
    waiting.forEach(r => {
      const amt = parseSafeInt(r.get('Amount')); 
      totalWait += amt;
      const isCard = r.get('Payment Type') === 'Karta';
      const payDet = r.get('Payment Detail');
      const fmtDet = isCard ? `\`${payDet}\`` : payDet;
      
      msg += `🗓 Sana: ${r.get('Scheduled Date')}\n📍 ${r.get('Branch')} - ${amt.toLocaleString('en-US')} UZS\n💳 ${r.get('Payment Type')} (${fmtDet})\n📝 ${r.get('Description')} [${cleanPriority(r.get('Priority'))}]\n\n`;
      
      buttons.push([Markup.button.callback(`💳 To'lash (ID: ${r.rowNumber})`, `paynow_${r.rowNumber}`)]);
    });
    
    msg += `━━━━━━━━━━━━━━━\n💰 Jami: ${totalWait.toLocaleString('en-US')} UZS`;
    ctx.reply(msg, { parse_mode: 'Markdown', ...Markup.inlineKeyboard(buttons) });
  } catch (e) { 
    ctx.reply('❌ Xatolik.'); 
  }
});

// ==========================================
// 6. DAILY ALARMS & CHEQUE FLOW
// ==========================================
cron.schedule('0 9 * * *', async () => {
  try {
    await doc.loadInfo();
    const rows = await doc.sheetsByTitle['Pending_Expenses'].getRows();
    const todayStr = getTodayStr();
    const dueToday = rows.filter(r => r.get('Status') === 'SCHEDULED' && r.get('Scheduled Date') === todayStr);

    for (let row of dueToday) {
      // UPDATED: Loop through all managers
      for (let managerId of MANAGER_IDS) {
        await bot.telegram.sendMessage(managerId, `⏰ *ESLATMA: Bugun to'lov qilinishi kerak!*\n\n📍 ${row.get('Branch')}\n💵 ${parseSafeInt(row.get('Amount')).toLocaleString('en-US')} UZS\n💳 To'lov: ${row.get('Payment Type')} (${row.get('Payment Detail')})\n📝 ${row.get('Description')}\n\n*To'lovni amalga oshirgach, ushbu xabarga CHEK RASMINI REPLY qilib yuboring.*\nID: ${row.rowNumber}`, { parse_mode: 'Markdown' }).catch(() => {});
      }
    }
  } catch (e) { 
    console.error("Cron Error:", e); 
  }
}, { scheduled: true, timezone: "Asia/Tashkent" });

bot.on('photo', async (ctx) => {
  // UPDATED: Check array
  if (!MANAGER_IDS.includes(ctx.from.id.toString())) return; 
  
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
      
      await bot.telegram.sendPhoto(row.get('_StaffChatId'), ctx.message.photo[0].file_id, {
        caption: `💰 *TO'LOV QILINDI!*\nProcurement Manager pulni o'tkazdi.\n\n💵 Summa: ${parseSafeInt(row.get('Amount')).toLocaleString('en-US')} UZS\n\nIltimos, pulni olganingizni tasdiqlang:`,
        parse_mode: 'Markdown',
        ...Markup.inlineKeyboard([[Markup.button.callback('✅ Qabul qildim', `staffconfirm_${rowNum}`)]])
      });

      // Forward cheque to maintenance group
      const groupMsgId = row.get('GroupMsgId');
      if (MAINTENANCE_GROUP_ID && groupMsgId) {
          await bot.telegram.sendPhoto(MAINTENANCE_GROUP_ID, ctx.message.photo[0].file_id, {
              reply_to_message_id: parseInt(groupMsgId),
              caption: `✅ Procurement menejer chekni yubordi. Xodim tasdig'i kutilmoqda...`
          }).catch(()=>{});
      }

    } catch (e) { 
      ctx.reply("❌ Xatolik yuz berdi."); 
    }
  }
});

// ==========================================
// 7. WIZARD: TEXT & VOICE HANDLER
// ==========================================
bot.command(['start', 'new'], (ctx) => {
  const userId = ctx.from.id;
  delete userSessions[userId]; 
  userSessions[userId] = { step: 'BRANCH' };
  ctx.reply('IELTS Zone Finance Bot 🎓\nFilialni tanlang:', Markup.keyboard(branches, { columns: 2 }).oneTime().resize());
});

bot.on('message', async (ctx) => {
  const userId = ctx.from.id;
  const text = ctx.message.text || '';
  const voice = ctx.message.voice;

  if (text.includes('Hisobot') || text.includes('Kutilayotgan') || text.includes('Cashflow') || text.includes('Umumiy')) return;

  if (text === '❌ Bekor qilish' || text === '/start') {
    delete userSessions[userId];
    return ctx.reply('Bekor qilindi. Boshlash uchun filialni tanlang:', Markup.keyboard(branches, { columns: 2 }).resize());
  }

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
      return ctx.reply('Summani kiriting (Faqat raqam):', Markup.keyboard(['❌ Bekor qilish']).resize()); 
    }
  }
  if (session.step === 'AMOUNT') {
    session.amount = parseSafeInt(text);
    if(session.amount === 0) return ctx.reply('Iltimos, yaroqli son kiriting:');
    session.step = 'DESCRIPTION';
    return ctx.reply('Xarajat sababi (Matn yozing yoki Ovozli xabar yuboring 🎤):');
  }
  if (session.step === 'DESCRIPTION') {
    if (voice) {
      session.description = "🎤 Ovozli izoh";
      session.voiceFileId = voice.file_id;
    } else if (text) {
      session.description = text;
      session.voiceFileId = null;
    } else {
      return ctx.reply("Iltimos, matn yoki ovozli xabar yuboring.");
    }
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
  let msg = `⚠️ *Menejerga yuborishdan oldin tekshiring:*\n\n📍 Filial: ${session.branch}\n📂 Kategoriya: ${session.category}\n💰 Summa: ${session.amount.toLocaleString('en-US')} UZS\n📝 Sabab: ${session.description}\n⏰ Muhimligi: ${session.priority}\n💳 To'lov: ${session.payType} (${session.payDetail})`;
  
  ctx.reply(msg, { 
      parse_mode: 'Markdown', 
      ...Markup.inlineKeyboard([
          [Markup.button.callback('✅ Yuborish', 'submit_final')], 
          [Markup.button.callback('❌ Bekor qilish', 'cancel_final')]
      ]) 
  });
}

// ==========================================
// 8. FINAL SUBMISSION & HARD GATES
// ==========================================
bot.action(/^(submit_final|cancel_final)$/, async (ctx) => {
  const action = ctx.match[1];
  const userId = ctx.from.id;
  const session = userSessions[userId];
  
  if (action === 'cancel_final') {
    delete userSessions[userId]; 
    await ctx.editMessageText('❌ So\'rov bekor qilindi.');
    return ctx.reply('Yangi so\'rov uchun filialni tanlang:', Markup.keyboard(branches, { columns: 2 }).resize());
  }
  
  if (action === 'submit_final' && session) {
    try {
      await doc.loadInfo();
      const budgetSheet = doc.sheetsByTitle['Budgets'];
      const expenseSheet = doc.sheetsByTitle['Pending_Expenses'];
      const budgetRows = await budgetSheet.getRows();
      const requested = session.amount;

      // --- HARD GATE 1: CATEGORY LIMIT ---
      const catSpent = await getMonthlySpent(expenseSheet, session.branch, session.category);
      const cLimitRow = budgetRows.find(r => r.get('Branch') === session.branch && r.get('Category') === session.category);
      const cLimitValue = cLimitRow ? parseSafeInt(cLimitRow.get('Monthly Limit')) : Infinity;

      if ((catSpent + requested) > cLimitValue) {
        await ctx.editMessageText(`❌ *RAD ETILDI!*\n\nBu summa joriy oy uchun **${session.branch}** filialidagi **${session.category}** limiti miqdoridan oshib ketdi.\n\nLimit: ${cLimitValue.toLocaleString()} UZS\nIshlatildi: ${(catSpent + requested).toLocaleString()} UZS\nIltimos, rahbariyat bilan bog'laning.`);
        return delete userSessions[userId];
      }

      // --- HARD GATE 2: BRANCH LIMIT ---
      const branchSpent = await getMonthlySpent(expenseSheet, session.branch);
      const bLimitRow = budgetRows.find(r => r.get('Branch') === session.branch && (!r.get('Category') || r.get('Category').trim() === ''));
      const bLimitValue = bLimitRow ? parseSafeInt(bLimitRow.get('Monthly Limit')) : Infinity;

      if ((branchSpent + requested) > bLimitValue) {
        await ctx.editMessageText(`❌ *RAD ETILDI!*\n\nBu summa joriy oy uchun umumiy **${session.branch}** filial limitidan oshib ketdi.\n\nLimit: ${bLimitValue.toLocaleString()} UZS\nIshlatildi: ${(branchSpent + requested).toLocaleString()} UZS\nIltimos, rahbariyat bilan bog'laning.`);
        return delete userSessions[userId];
      }

      // --- PASSED: Save to Sheets ---
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
        'GroupMsgId': '' // NEW: Placeholder to ensure column gets recognized
      });

      // --- NOTIFY MANAGERS ---
      const budgetAudit = await getDoubleBudgetWarning(session.branch, session.category, session.amount);
      let buttons = [];
      
      if (budgetAudit.includes('🔴')) {
          buttons.push([Markup.button.callback('❌ Rad etish (Limit xatosi)', `rej_${row.rowNumber}`)]);
      } else {
          buttons.push([Markup.button.callback('✅ Tasdiqlash', `decide_${row.rowNumber}`)]);
          buttons.push([Markup.button.callback('❌ Rad etish', `rej_${row.rowNumber}`)]);
      }

      const managerMsg = `🏢 *Yangi So'rov*\n📍 Filial: ${session.branch}\n👤 Kimdan: ${ctx.from.first_name}\n💵 Summa: ${session.amount.toLocaleString('en-US')} UZS\n💳 To'lov: ${session.payType} (${session.payDetail})\n💬 Sabab: ${session.description}\n⏰ Muhimligi: ${session.priority} ${budgetAudit}`;

      // UPDATED: Loop through all managers to send the notification and voice file
      for (let managerId of MANAGER_IDS) {
          await bot.telegram.sendMessage(managerId, managerMsg, { parse_mode: 'Markdown', ...Markup.inlineKeyboard(buttons) }).catch(() => {});
          
          if (session.voiceFileId) {
              await bot.telegram.sendVoice(managerId, session.voiceFileId, { caption: `🎤 Yuqoridagi so'rovning ovozli izohi (ID: ${row.rowNumber})` }).catch(() => {});
          }
      }

      // --- NOTIFY MAINTENANCE GROUP ---
      if (MAINTENANCE_GROUP_ID) {
        const groupMsg = `🛠 **Yangi So'rov Yaratildi**\n\n📍 Filial: ${session.branch}\n📂 Kategoriya: ${session.category}\n💰 Summa: ${session.amount.toLocaleString('en-US')} UZS\n👤 So'radi: ${ctx.from.first_name}\n📝 Sabab: ${session.description}\n⏰ Muhimligi: ${session.priority}\n\n⏳ *Holati: Menejer tasdig'i kutilmoqda...*`;
        
        const groupPost = await bot.telegram.sendMessage(MAINTENANCE_GROUP_ID, groupMsg, { parse_mode: 'Markdown' }).catch(err => console.error("Group Alert Error:", err.message));
        
        if (groupPost) {
          try {
            row.set('GroupMsgId', groupPost.message_id.toString());
            await row.save();
          } catch(err) {
             console.error("GroupMsgId column missing in Sheets");
          }
        }

        // Forward Voice Note to Group if it exists
        if (session.voiceFileId && groupPost) {
          await bot.telegram.sendVoice(MAINTENANCE_GROUP_ID, session.voiceFileId, { 
            reply_to_message_id: groupPost.message_id 
          }).catch(err => console.error("Group Voice Error:", err.message));
        }
      }

      delete userSessions[userId]; 
      await ctx.editMessageText(`✅ Muvaffaqiyatli yuborildi!\nID: ${row.rowNumber}`);
      ctx.reply('Yangi so\'rov uchun filialni tanlang:', Markup.keyboard(branches, { columns: 2 }).resize());
    } catch (e) { 
        delete userSessions[userId]; 
        ctx.editMessageText('❌ Xatolik yuz berdi.'); 
        console.error(e); 
    }
  } else {
    delete userSessions[userId]; 
    ctx.editMessageText('❌ Sessiya tugadi. /start bosing.');
  }
});

// ==========================================
// 9. STAFF CHEQUE CONFIRMATION
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
    
    await ctx.editMessageCaption('✅ *PUL QABUL QILINDI VA YOPILDI.*', { parse_mode: 'Markdown' });
    
    // UPDATED: Notify all managers
    for (let managerId of MANAGER_IDS) {
        await bot.telegram.sendMessage(managerId, `✅ Xodim ${parseSafeInt(row.get('Amount')).toLocaleString('en-US')} UZS miqdoridagi pulni olganini tasdiqladi.\n(ID: ${rowNum} - Status: PAID)`).catch(() => {});
    }

    // Guruhga xabar berish (MAINTENANCE_GROUP_ID)
    const groupMsgId = row.get('GroupMsgId');
    if (MAINTENANCE_GROUP_ID && groupMsgId) {
        await bot.telegram.sendMessage(MAINTENANCE_GROUP_ID, `✅ Xodim to'lovni qabul qildi. Tasdiqlandi va yopildi.`, {
            reply_to_message_id: parseInt(groupMsgId)
        }).catch(()=>{});
    }

  } catch(e) { 
      console.error(e);
      ctx.answerCbQuery("Xatolik yuz berdi."); 
  }
});

// ==========================================
// 10. MANAGER APPROVAL ACTIONS
// ==========================================
bot.action(/^(decide|paynow|schedD|schedF|schedM|rej)_(\d+)(?:_(\d+))?$/, async (ctx) => {
  // UPDATED: Check array
  if (!MANAGER_IDS.includes(ctx.from.id.toString())) return ctx.answerCbQuery("Sizda huquq yo'q."); 
  
  const [action, rowNum, param] = [ctx.match[1], ctx.match[2], ctx.match[3]];
  
  try {
    await doc.loadInfo();
    const rows = await doc.sheetsByTitle['Pending_Expenses'].getRows();
    const row = rows.find(r => r.rowNumber == rowNum);
    
    if (!row) return ctx.editMessageText("❌ Xatolik: Qator topilmadi.");

    // UPDATED: Collision protection
    if (['decide', 'rej'].includes(action) && row.get('Status') !== 'PENDING') {
        return ctx.editMessageText("⚠️ Boshqa menejer tomonidan ko'rib chiqilgan (Already processed).");
    }
    
    const staffId = row.get('_StaffChatId');
    
    // FETCH AND FORMAT PAYMENT DETAILS FOR PERSISTENCY
    const payType = row.get('Payment Type');
    const payDetail = row.get('Payment Detail');
    const formattedDetail = payType === 'Karta' ? `\`${payDetail}\`` : payDetail;
    const formattedAmount = parseSafeInt(row.get('Amount')).toLocaleString('en-US');

    if (action === 'decide') {
      return ctx.editMessageText(`💸 Qachon to'laysiz?\n\n💳 To'lov: ${payType} (${formattedDetail})\n💰 Summa: ${formattedAmount} UZS`, Markup.inlineKeyboard([
        [Markup.button.callback('✅ Hozir To\'lash', `paynow_${rowNum}`)],
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
      
      await updateGroupMessageStatus(row, true);

      await bot.telegram.sendMessage(staffId, `✅ To'lov tasdiqlandi! Pul o'tkazilmoqda.`);
      return ctx.editMessageText(`💸 Hozir to'lash tanlandi.\n\n💳 To'lov: ${payType} (${formattedDetail})\n💰 Summa: ${formattedAmount} UZS\n\n**Ushbu xabarga CHEK RASMINI REPLY qiling**.\nID: ${rowNum}`, { parse_mode: 'Markdown' });
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

      await bot.telegram.sendMessage(staffId, `⏳ Tasdiqlandi. To'lov sanasi: *${d}*`, { parse_mode: 'Markdown' });
      return ctx.editMessageText(`🗓 ${d} sanasiga rejalashtirildi. Xodim ogohlantirildi.\n\n💳 To'lov: ${payType} (${formattedDetail})\n💰 Summa: ${formattedAmount} UZS`, { parse_mode: 'Markdown' });
    } 
    
    if (action === 'rej') {
      row.set('Status', 'REJECTED'); 
      await row.save();
      
      await updateGroupMessageStatus(row, false);

      await bot.telegram.sendMessage(staffId, `❌ So'rov rad etildi.`);
      return ctx.editMessageText('❌ Rad etildi va yopildi.');
    }
  } catch (e) { 
      console.error(e);
      ctx.editMessageText("❌ Amalni bajarishda xatolik."); 
  }
});

// Yordamchi funksiya: Guruhdagi xabarni tahrirlash (Menejer tasdiqladi / Rad etdi)
async function updateGroupMessageStatus(row, isApproved) {
  const groupMsgId = row.get('GroupMsgId');
  if (MAINTENANCE_GROUP_ID && groupMsgId) {
    const amt = parseSafeInt(row.get('Amount')).toLocaleString('en-US');
    const statusText = isApproved ? "✅ *Holati: Menejer tasdiqladi*" : "❌ *Holati: Menejer tomonidan rad etildi*";
    
    const newMsg = `🛠 **Yangi So'rov Yaratildi**\n\n📍 Filial: ${row.get('Branch')}\n💰 Summa: ${amt} UZS\n👤 So'radi: ${row.get('Staff Name')}\n📝 Sabab: ${row.get('Description')}\n⏰ Muhimligi: ${row.get('Priority')}\n\n${statusText}`;
    
    await bot.telegram.editMessageText(MAINTENANCE_GROUP_ID, parseInt(groupMsgId), null, newMsg, { parse_mode: 'Markdown' }).catch(()=>{});
  }
}

// ==========================================
// BOOTSTRAP
// ==========================================
bot.launch().then(() => console.log('IELTS Zone Finance Bot is running...'));
process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
