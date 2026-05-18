const { Telegraf, Markup } = require('telegraf');
const { JWT } = require('google-auth-library');
const { GoogleSpreadsheet } = require('google-spreadsheet');
const cron = require('node-cron');

// ==========================================
// 1. MUHIT & AUTENTIFIKATSIYA
// ==========================================
const bot = new Telegraf(process.env.BOT_TOKEN);
const SHEET_ID = process.env.SHEET_ID;

const MANAGER_IDS = process.env.MANAGER_CHAT_IDS
  ? process.env.MANAGER_CHAT_IDS.split(',').map(id => id.trim()) : [];
const ALLOWED_STAFF_IDS = process.env.ALLOWED_STAFF_IDS
  ? process.env.ALLOWED_STAFF_IDS.split(',').map(id => id.trim()) : [];
const CEO_ID = process.env.CEO_CHAT_ID || 'NO_CEO';
const MAINTENANCE_GROUP_ID = process.env.MAINTENANCE_GROUP_ID || null;

const creds = JSON.parse(process.env.GCP_SERVICE_ACCOUNT);
const auth = new JWT({
  email: creds.client_email,
  key: creds.private_key,
  scopes: ['https://www.googleapis.com/auth/spreadsheets'],
});
const doc = new GoogleSpreadsheet(SHEET_ID, auth);

// Sessiyalar (type: 'user' for expense flow, 'admin' for admin actions)
const userSessions = {};

// ==========================================
// 2. XAVFSIZLIK MIDDLEWARE
// ==========================================
bot.use(async (ctx, next) => {
  if (!ctx.from) return next();
  const uid = ctx.from.id.toString();
  const isAllowed = ALLOWED_STAFF_IDS.includes(uid) || MANAGER_IDS.includes(uid) || uid === CEO_ID;
  if (!isAllowed) {
    if (ctx.chat && ctx.chat.type === 'private') {
      await ctx.reply("Kechirasiz, sizda ushbu botdan foydalanish huquqi yo'q.\nIltimos, ruxsat olish uchun rahbariyatga murojaat qiling.").catch(() => {});
    }
    return;
  }
  return next();
});

// ==========================================
// 3. KONSTANTALAR
// ==========================================
const ALL_BRANCHES = ['Integro', 'Drujba', 'Amir Temur', 'Central', 'Marketing'];
const BRANCH_WITH_EMOJI = ALL_BRANCHES.map(b => `📍 ${b}`);

const DEFAULT_CATEGORIES = [
  'tugilgan kun uchun', 'printer rang', 'Printer tuzatish', 'remont-tuzatish',
  'Hodimlar uchun dorilar', 'jihoz', 'Texnikalar', 'Transport', 'aromatizator',
  'Internet', 'Telefon', 'of the month', 'Event', 'Reklama mahsulotlarini chiqarish',
  'giftbox sovgalar', 'syomka xarajatlari', 'bozorlik xojalik', 'Suv va stakan',
  'Konstovar', 'Plastik foizi', 'ofis xarajatlari', 'remont qurilish'
];

const PRIORITIES = [
  "Ota muhim (Bugun)", "Ortacha (Ertaga)",
  "Normal (Shu hafta)", "Shoshilinch emas (Shu oy)"
];

// ==========================================
// 4. YORDAMCHI FUNKSIYALAR
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

function isAdmin(uid) {
  return MANAGER_IDS.includes(uid.toString()) || uid.toString() === CEO_ID;
}

// ==========================================
// 5. JADVAL YARATISH (MISSING SHEET HANDLING)
// ==========================================
async function ensureSheet(sheetName, headerValues) {
  await doc.loadInfo();
  let sheet = doc.sheetsByTitle[sheetName];
  if (!sheet) {
    sheet = await doc.addSheet({ title: sheetName, headerValues });
  }
  return sheet;
}

// ==========================================
// 6. USERS JADVALI — FOYDALANUVCHI MA'LUMOTLARI
// ==========================================
async function getUserData(telegramId) {
  try {
    const sheet = await ensureSheet('Users', ['Telegram ID', 'Name', 'Role', 'Branches', 'Categories']);
    const rows = await sheet.getRows();
    return rows.find(r => r.get('Telegram ID') === telegramId.toString()) || null;
  } catch (e) {
    console.error('getUserData error:', e);
    return null;
  }
}

async function getUserBranches(telegramId) {
  const uid = telegramId.toString();
  if (isAdmin(uid)) return ALL_BRANCHES; // return without emoji for internal logic

  const user = await getUserData(uid);
  if (!user) return ALL_BRANCHES; // fallback

  const branchesStr = user.get('Branches') || '';
  if (!branchesStr.trim() || branchesStr.toLowerCase() === 'hammasi' || branchesStr === '*') return ALL_BRANCHES;

  return branchesStr.split(',').map(b => b.trim()).filter(Boolean);
}

async function getUserCategories(telegramId) {
  if (isAdmin(telegramId)) return await getActiveCategories();

  const user = await getUserData(telegramId);
  if (!user) return DEFAULT_CATEGORIES;

  const catStr = user.get('Categories') || '';
  if (catStr.toLowerCase() === 'hammasi' || catStr === '*') return await getActiveCategories();

  return catStr.split(',').map(c => c.trim()).filter(Boolean);
}

async function saveUserData(telegramId, name, role, branches, categories) {
  try {
    const sheet = await ensureSheet('Users', ['Telegram ID', 'Name', 'Role', 'Branches', 'Categories']);
    const rows = await sheet.getRows();
    const existing = rows.find(r => r.get('Telegram ID') === telegramId.toString());

    const branchStr = branches === 'hammasi' ? 'hammasi' : branches;
    const catStr = categories === 'hammasi' ? 'hammasi' : categories;

    if (existing) {
      existing.set('Name', name);
      existing.set('Role', role);
      existing.set('Branches', branchStr);
      existing.set('Categories', catStr);
      await existing.save();
    } else {
      await sheet.addRow({
        'Telegram ID': telegramId.toString(),
        'Name': name,
        'Role': role,
        'Branches': branchStr,
        'Categories': catStr
      });
    }
    return true;
  } catch (e) {
    console.error('saveUserData error:', e);
    return false;
  }
}

// ==========================================
// 7. KATEGORIYALAR BOSHQARUVI
// ==========================================
async function getActiveCategories() {
  try {
    const sheet = await ensureSheet('Categories', ['Name', 'Active', 'Created']);
    const rows = await sheet.getRows();
    return rows
      .filter(r => r.get('Active') !== 'FALSE' && r.get('Name'))
      .map(r => r.get('Name'));
  } catch (e) {
    console.error('getActiveCategories error:', e);
    return DEFAULT_CATEGORIES;
  }
}

async function addCategory(name) {
  try {
    const catSheet = await ensureSheet('Categories', ['Name', 'Active', 'Created']);
    const catRows = await catSheet.getRows();
    const exists = catRows.find(r => r.get('Name') === name);
    if (exists) return false;

    await catSheet.addRow({
      'Name': name,
      'Active': 'TRUE',
      'Created': new Date().toLocaleString('uz-UZ', { timeZone: 'Asia/Tashkent' })
    });

    // Budgets jadvaliga har filial uchun limit=0 qo'shish
    const budgetSheet = await ensureSheet('Budgets', ['Branch', 'Category', 'Monthly Limit']);
    const budgetRows = await budgetSheet.getRows();
    for (const branch of ALL_BRANCHES) {
      const branchWithEmoji = '📍 ' + branch;
      const alreadyExists = budgetRows.find(r =>
        r.get('Branch') === branchWithEmoji && r.get('Category') === name
      );
      if (!alreadyExists) {
        await budgetSheet.addRow({
          'Branch': branchWithEmoji,
          'Category': name,
          'Monthly Limit': '0'
        });
      }
    }
    return true;
  } catch (e) {
    console.error('addCategory error:', e);
    return false;
  }
}

async function deleteCategory(name) {
  try {
    const catSheet = await ensureSheet('Categories', ['Name', 'Active', 'Created']);
    const catRows = await catSheet.getRows();
    const catRow = catRows.find(r => r.get('Name') === name);
    if (!catRow) return false;
    catRow.set('Active', 'FALSE');
    await catRow.save();

    const budgetSheet = doc.sheetsByTitle['Budgets'];
    if (budgetSheet) {
      const budgetRows = await budgetSheet.getRows();
      for (const r of budgetRows) {
        if (r.get('Category') === name && parseSafeInt(r.get('Monthly Limit')) === 0) {
          await r.delete();
        }
      }
    }
    return true;
  } catch (e) {
    console.error('deleteCategory error:', e);
    return false;
  }
}

// ==========================================
// 8. BUDJET TIZIMI
// ==========================================
async function getMonthlySpent(expenseSheet, branch, category = null) {
  const rows = await expenseSheet.getRows();
  const now = new Date(new Date().getTime() + (5 * 60 * 60 * 1000));
  let spent = 0;

  rows.forEach(r => {
    const dateStr = r.get('Timestamp');
    if (!dateStr) return;
    const rowDate = new Date(dateStr);
    const status = r.get('Status');
    const matchBranch = r.get('Branch') === branch;
    const matchCat = category ? (r.get('Description') || '').includes(`[${category}]`) : true;
    const thisMonth = rowDate.getMonth() === now.getMonth() && rowDate.getFullYear() === now.getFullYear();
    if (matchBranch && matchCat && thisMonth && ['PAID', 'SCHEDULED', 'CHEQUE_SENT'].includes(status)) {
      spent += parseSafeInt(r.get('Amount'));
    }
  });
  return spent;
}

async function getBudgetLimit(branch, category = null) {
  await doc.loadInfo();
  const sheet = doc.sheetsByTitle['Budgets'];
  if (!sheet) return Infinity;
  const rows = await sheet.getRows();

  if (category) {
    const row = rows.find(r => r.get('Branch') === branch && r.get('Category') === category);
    return row ? parseSafeInt(row.get('Monthly Limit')) : Infinity;
  } else {
    const row = rows.find(r => r.get('Branch') === branch && (!r.get('Category') || r.get('Category').trim() === ''));
    return row ? parseSafeInt(row.get('Monthly Limit')) : Infinity;
  }
}

async function setBudgetLimit(branch, category, limit) {
  await doc.loadInfo();
  const sheet = await ensureSheet('Budgets', ['Branch', 'Category', 'Monthly Limit']);
  const rows = await sheet.getRows();

  let row;
  if (category) {
    row = rows.find(r => r.get('Branch') === branch && r.get('Category') === category);
  } else {
    row = rows.find(r => r.get('Branch') === branch && (!r.get('Category') || r.get('Category').trim() === ''));
  }

  if (row) {
    row.set('Monthly Limit', limit.toString());
    await row.save();
  } else {
    await sheet.addRow({
      'Branch': branch,
      'Category': category || '',
      'Monthly Limit': limit.toString()
    });
  }
  return true;
}

async function checkBudget(branch, category, amount) {
  await doc.loadInfo();
  const expSheet = doc.sheetsByTitle['Pending_Expenses'];

  // 1. Kategoriya limiti
  const catSpent = await getMonthlySpent(expSheet, branch, category);
  const catLimit = await getBudgetLimit(branch, category);
  if (catLimit !== Infinity && (catSpent + amount) > catLimit) {
    return {
      blocked: true,
      reason: `*${category.toUpperCase()}* kategoriyasi limiti oshdi!\nLimit: ${catLimit.toLocaleString()} UZS\nIshlatilgan: ${catSpent.toLocaleString()} UZS\nSo'ralgan: ${amount.toLocaleString()} UZS`
    };
  }

  // 2. Filial umumiy limiti
  const branchSpent = await getMonthlySpent(expSheet, branch);
  const branchLimit = await getBudgetLimit(branch);
  if (branchLimit !== Infinity && (branchSpent + amount) > branchLimit) {
    return {
      blocked: true,
      reason: `*${branch}* filiali umumiy limiti oshdi!\nLimit: ${branchLimit.toLocaleString()} UZS\nIshlatilgan: ${branchSpent.toLocaleString()} UZS\nSo'ralgan: ${amount.toLocaleString()} UZS`
    };
  }

  let warnings = [];
  if (catLimit !== Infinity) {
    const catPct = ((catSpent + amount) / catLimit) * 100;
    if (catPct >= 80) warnings.push(`Kategoriya limiti: ${catPct.toFixed(0)}% ishlatildi`);
  }
  if (branchLimit !== Infinity) {
    const brPct = ((branchSpent + amount) / branchLimit) * 100;
    if (brPct >= 80) warnings.push(`Filial limiti: ${brPct.toFixed(0)}% ishlatildi`);
  }

  return { blocked: false, warnings };
}

// ==========================================
// 9. HISOBOT
// ==========================================
async function getAvailableMonths() {
  await doc.loadInfo();
  const sheet = doc.sheetsByTitle['Pending_Expenses'];
  if (!sheet) return [];
  const rows = await sheet.getRows(); // FIXED: added await
  const monthSet = new Set();
  rows.forEach(r => {
    const d = new Date(r.get('Timestamp'));
    if (!isNaN(d)) {
      monthSet.add(d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0'));
    }
  });
  return Array.from(monthSet).sort().reverse();
}

function getMonthName(monthStr) {
  const months = ['Yanvar','Fevral','Mart','Aprel','May','Iyun','Iyul','Avgust','Sentabr','Oktabr','Noyabr','Dekabr'];
  const [year, month] = monthStr.split('-');
  return months[parseInt(month) - 1] + ' ' + year;
}

async function buildMonthButtons() {
  const months = await getAvailableMonths();
  const now = new Date(new Date().getTime() + (5 * 60 * 60 * 1000));
  const currentMonth = now.getFullYear() + '-' + String(now.getMonth() + 1).padStart(2, '0');

  const rows = [];
  for (let i = 0; i < Math.min(months.length, 6); i += 2) {
    const pair = months.slice(i, i + 2).map(m => {
      const label = m === currentMonth ? 'Joriy oy (' + getMonthName(m) + ')' : getMonthName(m);
      return Markup.button.callback(label, 'report_' + m);
    });
    rows.push(pair);
  }
  rows.push([Markup.button.callback('Hammasi (barcha vaqt)', 'report_all')]);
  return Markup.inlineKeyboard(rows);
}

async function generateGlobalReport(monthFilter) {
  await doc.loadInfo();
  const sheet = doc.sheetsByTitle['Pending_Expenses'];
  if (!sheet) return "Ma'lumot topilmadi.";
  const rows = await sheet.getRows();

  const filtered = rows.filter(r => {
    const d = new Date(r.get('Timestamp'));
    if (isNaN(d)) return false;
    if (monthFilter === 'all') return true;
    const rowMonth = d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0');
    return rowMonth === monthFilter;
  });

  const paid = filtered.filter(r => r.get('Status') === 'PAID' || r.get('Status') === 'CHEQUE_SENT');
  const scheduled = filtered.filter(r => r.get('Status') === 'SCHEDULED');
  const pending = filtered.filter(r => r.get('Status') === 'PENDING');
  const rejected = filtered.filter(r => r.get('Status') === 'REJECTED');

  let branchTotals = {};
  let catTotals = {};
  let grandTotal = 0;

  paid.forEach(r => {
    const b = r.get('Branch') || 'Noma\'lum';
    const val = parseSafeInt(r.get('Amount'));
    branchTotals[b] = (branchTotals[b] || 0) + val;
    grandTotal += val;

    const desc = r.get('Description') || '';
    const m = desc.match(/\[([^\]]+)\]/);
    const cat = m ? m[1] : 'Boshqa';
    catTotals[cat] = (catTotals[cat] || 0) + val;
  });

  const periodLabel = monthFilter === 'all' ? 'Barcha vaqt' : getMonthName(monthFilter);

  let msg = 'MOLIYA HISOBOTI - ' + periodLabel + '\n';
  msg += '=========================\n';
  msg += 'Tolangan: ' + grandTotal.toLocaleString('en-US') + ' UZS\n';
  msg += 'Kutilayotgan: ' + pending.length + ' ta (' + pending.reduce((s,r) => s + parseSafeInt(r.get('Amount')), 0).toLocaleString('en-US') + ' UZS)\n';
  msg += 'Rejalashtirilgan: ' + scheduled.length + ' ta (' + scheduled.reduce((s,r) => s + parseSafeInt(r.get('Amount')), 0).toLocaleString('en-US') + ' UZS)\n';
  msg += 'Rad etilgan: ' + rejected.length + ' ta\n';
  msg += '\nFiliallar boyicha:\n';

  BRANCH_WITH_EMOJI.forEach(b => {
    const amt = branchTotals[b] || 0;
    if (amt > 0) msg += b + ': ' + amt.toLocaleString('en-US') + ' UZS\n';
  });

  const topCats = Object.entries(catTotals).sort((a,b) => b[1]-a[1]).slice(0, 5);
  if (topCats.length > 0) {
    msg += '\nTop kategoriyalar:\n';
    topCats.forEach(([cat, amt]) => {
      msg += cat + ': ' + amt.toLocaleString('en-US') + ' UZS\n';
    });
  }

  return msg;
}

// ==========================================
// 10. INLINE TUGMACHA SELEKTORLAR
// ==========================================
function buildBranchButtons(selected) {
  const rows = [];
  for (let i = 0; i < ALL_BRANCHES.length; i += 2) {
    const pair = ALL_BRANCHES.slice(i, i + 2).map(b =>
      Markup.button.callback((selected.includes(b) ? '✅ ' : '➖ ') + b, 'selbranch_' + b)
    );
    rows.push(pair);
  }
  rows.push([
    Markup.button.callback('Hammasi', 'selbranch_all'),
    Markup.button.callback('Tayyor', 'selbranch_done')
  ]);
  return Markup.inlineKeyboard(rows);
}

async function buildCategoryButtons(selected) {
  const cats = await getActiveCategories();
  const rows = [];
  for (let i = 0; i < cats.length; i += 2) {
    const pair = cats.slice(i, i + 2).map(c =>
      Markup.button.callback((selected.includes(c) ? '✅ ' : '➖ ') + c.substring(0, 20), 'selcat_' + cats.indexOf(c))
    );
    rows.push(pair);
  }
  rows.push([
    Markup.button.callback('Hammasi', 'selcat_all'),
    Markup.button.callback('Tayyor', 'selcat_done')
  ]);
  return Markup.inlineKeyboard(rows);
}

// ==========================================
// 11. XULOSA VA STATUS YANGILASH (MOVED UP)
// ==========================================
async function showSummary(ctx, session) {
  const budgetCheck = await checkBudget(session.branch, session.category, session.amount);

  let msg = `Menejerga yuborishdan oldin tekshiring:\n\n`;
  msg += `Filial: ${session.branch}\n`;
  msg += `Kategoriya: ${session.category}\n`;
  msg += `Summa: ${session.amount.toLocaleString('en-US')} UZS\n`;
  msg += `Sabab: ${session.description}\n`;
  msg += `Muhimligi: ${session.priority}\n`;
  msg += `Tolov: ${session.payType} (${session.payDetail})`;

  if (budgetCheck.warnings && budgetCheck.warnings.length > 0) {
    msg += `\n\n⚠️ OGOHLANTIRISH:\n${budgetCheck.warnings.join('\n')}`;
  }

  await ctx.reply(msg, Markup.inlineKeyboard([
    [Markup.button.callback('✅ Yuborish', 'submit_final')],
    [Markup.button.callback('❌ Bekor qilish', 'cancel_final')]
  ]));
}

async function updateGroupStatus(row, isApproved) {
  const groupMsgId = row.get('GroupMsgId');
  if (MAINTENANCE_GROUP_ID && groupMsgId) {
    const amt = parseSafeInt(row.get('Amount')).toLocaleString('en-US');
    const status = isApproved ? '✅ Menejer tasdiqladi' : '❌ Menejer tomonidan rad etildi';
    const msg =
      `Sorov\n\nFilial: ${row.get('Branch')}\nSumma: ${amt} UZS\n` +
      `Sodirdi: ${row.get('Staff Name')}\nSabab: ${row.get('Description')}\n\nHolati: ${status}`;
    await bot.telegram.editMessageText(MAINTENANCE_GROUP_ID, parseInt(groupMsgId), null, msg).catch(() => {});
  }
}

// ==========================================
// 12. ACTION HANDLERS (BRANCH/CATEGORY SELECTORS)
// ==========================================
bot.action(/^selbranch_(.+)$/, async (ctx) => {
  const uid = ctx.from.id;
  const session = userSessions[uid];
  if (!session || !['USER_ADD_BRANCHES', 'EDIT_BRANCH'].includes(session.step)) return ctx.answerCbQuery();
  const val = ctx.match[1];
  if (!session.selectedBranches) session.selectedBranches = [];

  if (val === 'all') {
    session.selectedBranches = [...ALL_BRANCHES];
    session.allBranchesSelected = true;
  } else if (val === 'done') {
    if (session.selectedBranches.length === 0) return ctx.answerCbQuery('Kamida 1 ta filial tanlang!');
    const branchStr = session.allBranchesSelected ? 'hammasi' : session.selectedBranches.join(', ');

    if (session.step === 'EDIT_BRANCH') {
      try {
        const user = await getUserData(session.editUserId);
        if (user) {
          user.set('Branches', branchStr);
          await user.save();
          await ctx.editMessageText('✅ Filiallar yangilandi: ' + branchStr);
        }
      } catch(e) { await ctx.editMessageText('Xatolik.'); }
      delete userSessions[uid];
      return ctx.answerCbQuery('Saqlandi!');
    }

    session.newUserBranches = branchStr;
    session.step = 'USER_ADD_CATEGORIES';
    session.selectedCategories = [];
    await ctx.editMessageText('Filiallar saqlandi: ' + branchStr + '\n\nEndi kategoriyalarni tanlang:',
      await buildCategoryButtons([]));
    return ctx.answerCbQuery();
  } else {
    const idx = session.selectedBranches.indexOf(val);
    if (idx > -1) session.selectedBranches.splice(idx, 1);
    else session.selectedBranches.push(val);
    session.allBranchesSelected = false;
  }

  const sel = session.selectedBranches;
  await ctx.editMessageText(
    'Filiallarni tanlang:\n\nTanlangan: ' + (sel.length > 0 ? sel.join(', ') : 'hech biri'),
    buildBranchButtons(sel)
  ).catch(() => {});
  ctx.answerCbQuery();
});

bot.action(/^selcat_(.+)$/, async (ctx) => {
  const uid = ctx.from.id;
  const session = userSessions[uid];
  if (!session || !['USER_ADD_CATEGORIES', 'EDIT_CAT'].includes(session.step)) return ctx.answerCbQuery();
  const val = ctx.match[1];
  const allCats = await getActiveCategories();
  if (!session.selectedCategories) session.selectedCategories = [];

  if (val === 'all') {
    session.selectedCategories = [...allCats];
    session.allCatsSelected = true;
  } else if (val === 'done') {
    if (session.selectedCategories.length === 0) return ctx.answerCbQuery('Kamida 1 ta kategoriya tanlang!');
    const catStr = session.allCatsSelected ? 'hammasi' : session.selectedCategories.join(', ');

    if (session.step === 'EDIT_CAT') {
      try {
        const user = await getUserData(session.editUserId);
        if (user) {
          user.set('Categories', catStr);
          await user.save();
          await ctx.editMessageText('✅ Kategoriyalar yangilandi: ' + (catStr.length > 80 ? catStr.substring(0,80)+'...' : catStr));
        }
      } catch(e) { await ctx.editMessageText('Xatolik.'); }
      delete userSessions[uid];
      return ctx.answerCbQuery('Saqlandi!');
    }

    const ok = await saveUserData(session.newUserId, session.newUserName, session.newUserRole, session.newUserBranches, catStr);
    await ctx.editMessageText(ok
      ? `✅ Foydalanuvchi saqlandi!\nID: ${session.newUserId}\nIsm: ${session.newUserName}\nFiliallar: ${session.newUserBranches}\nKategoriyalar: ${catStr}`
      : '❌ Xatolik yuz berdi.');
    delete userSessions[uid];
    return ctx.reply('Admin paneli:', Markup.keyboard([
      ['Hisobot', 'Kutilayotgan'],
      ['Cashflow', 'Limitlar'],
      ['Kategoriyalar', 'Foydalanuvchilar']
    ]).resize());
  } else {
    const idx = parseInt(val);
    const fullCat = allCats[idx];
    if (fullCat) {
      const ci = session.selectedCategories.indexOf(fullCat);
      if (ci > -1) session.selectedCategories.splice(ci, 1);
      else session.selectedCategories.push(fullCat);
    }
    session.allCatsSelected = false;
  }

  const sel = session.selectedCategories || [];
  await ctx.editMessageText(
    'Kategoriyalarni tanlang:\n\nTanlangan: ' + (sel.length > 0 ? sel.length + ' ta' : 'hech biri'),
    await buildCategoryButtons(sel)
  ).catch(() => {});
  ctx.answerCbQuery();
});

// ==========================================
// 13. BOT BUYRUQLARI
// ==========================================
bot.command(['start', 'new'], async (ctx) => {
  const userId = ctx.from.id;
  const uid = userId.toString();
  delete userSessions[userId];

  if (isAdmin(uid)) {
    return ctx.reply('🏦 IELTS Zone Finance Bot\nAdmin paneli:', Markup.keyboard([
      ['Hisobot', 'Kutilayotgan'],
      ['Cashflow', 'Limitlar'],
      ['Kategoriyalar', 'Foydalanuvchilar']
    ]).resize());
  }

  const branches = await getUserBranches(userId);
  if (branches.length === 0) {
    return ctx.reply("❌ Sizga hali hech qaysi filial biriktirilmagan.\nIltimos, rahbariyatga murojaat qiling.");
  }

  // Convert branches to emoji version for display
  const displayBranches = branches.map(b => `📍 ${b}`);
  userSessions[userId] = { type: 'expense', step: 'BRANCH' };
  ctx.reply('🏢 Filialni tanlang:', Markup.keyboard([...displayBranches, 'Bekor qilish'], { columns: 2 }).oneTime().resize());
});

bot.command('admin', async (ctx) => {
  const uid = ctx.from.id.toString();
  if (!isAdmin(uid)) return ctx.reply("❌ Sizda admin huquqi yo'q.");
  return ctx.reply('Admin paneli:', Markup.keyboard([
    ['Hisobot', 'Kutilayotgan'],
    ['Cashflow', 'Limitlar'],
    ['Kategoriyalar', 'Foydalanuvchilar']
  ]).resize());
});

// ==========================================
// 14. LIMIT BOSHQARUVI
// ==========================================
bot.hears('Limitlar', async (ctx) => {
  if (!isAdmin(ctx.from.id)) return;
  userSessions[ctx.from.id] = { type: 'admin', step: 'LIMIT_BRANCH' };
  ctx.reply('📌 Qaysi filial uchun limit belgilamoqchisiz?',
    Markup.keyboard([...BRANCH_WITH_EMOJI, 'Bekor qilish'], { columns: 2 }).resize());
});

// ==========================================
// 15. KATEGORIYA BOSHQARUVI
// ==========================================
bot.hears('Kategoriyalar', async (ctx) => {
  if (!isAdmin(ctx.from.id)) return;
  const cats = await getActiveCategories();
  ctx.reply(`📂 Joriy kategoriyalar (${cats.length} ta):\n\n${cats.map((c, i) => `${i + 1}. ${c}`).join('\n')}`,
    Markup.keyboard([
      ['➕ Yangi kategoriya', '❌ Kategoriyani o\'chirish'],
      ['⬅️ Bekor qilish']
    ]).resize());
});

// ==========================================
// 16. FOYDALANUVCHILAR BOSHQARUVI
// ==========================================
bot.hears('Foydalanuvchilar', async (ctx) => {
  if (!isAdmin(ctx.from.id)) return;
  userSessions[ctx.from.id] = { type: 'admin', step: 'USER_MGMT' };
  ctx.reply('👥 Foydalanuvchi boshqaruvi:',
    Markup.keyboard([
      ['➕ Foydalanuvchi qoshish', '📋 Foydalanuvchilar royxati'],
      ['⬅️ Bekor qilish']
    ]).resize());
});

// ==========================================
// 17. HISOBOT VA CASHFLOW
// ==========================================
bot.hears('Hisobot', async (ctx) => {
  if (!isAdmin(ctx.from.id)) return;
  const keyboard = await buildMonthButtons();
  ctx.reply('📊 Qaysi davr uchun hisobot?', keyboard);
});

bot.action(/^report_(.+)$/, async (ctx) => {
  if (!isAdmin(ctx.from.id)) return ctx.answerCbQuery();
  const monthFilter = ctx.match[1];
  try {
    await ctx.editMessageText('⏳ Hisobot tayyorlanmoqda...');
    const msg = await generateGlobalReport(monthFilter);
    await ctx.editMessageText(msg);
    ctx.answerCbQuery();
  } catch (e) {
    ctx.editMessageText('❌ Xatolik yuz berdi.');
  }
});

bot.hears('Cashflow', async (ctx) => {
  if (!isAdmin(ctx.from.id)) return;
  try {
    await doc.loadInfo();
    const rows = await doc.sheetsByTitle['Pending_Expenses'].getRows();
    const scheduled = rows.filter(r => r.get('Status') === 'SCHEDULED');
    if (!scheduled.length) return ctx.reply("📭 Rejalashtirilgan tolovlar yo'q.");

    let dates = {}, total = 0;
    scheduled.forEach(r => {
      const d = r.get('Scheduled Date');
      const amt = parseSafeInt(r.get('Amount'));
      dates[d] = (dates[d] || 0) + amt;
      total += amt;
    });

    let msg = `📅 CASHFLOW FORECAST\n\n`;
    Object.keys(dates).sort().forEach(d => {
      msg += `${d}: ${dates[d].toLocaleString('en-US')} UZS\n`;
    });
    msg += `\nJami: ${total.toLocaleString('en-US')} UZS`;
    ctx.reply(msg);
  } catch (e) {
    ctx.reply('❌ Xatolik.');
  }
});

bot.hears('Kutilayotgan', async (ctx) => {
  if (!isAdmin(ctx.from.id)) return;
  try {
    await doc.loadInfo();
    const rows = await doc.sheetsByTitle['Pending_Expenses'].getRows();
    const waiting = rows.filter(r => ['SCHEDULED', 'PENDING'].includes(r.get('Status')));
    if (!waiting.length) return ctx.reply("📭 Kutilayotgan tolovlar yo'q.");

    let total = 0;
    waiting.forEach(r => { total += parseSafeInt(r.get('Amount')); });
    await ctx.reply(`⏳ KUTILAYOTGANLAR - ${waiting.length} ta so'rov\nJami: ${total.toLocaleString('en-US')} UZS`);

    for (const r of waiting) {
      const amt = parseSafeInt(r.get('Amount'));
      const isPending = r.get('Status') === 'PENDING';
      const schedDate = r.get('Scheduled Date') ? ' | ' + r.get('Scheduled Date') : '';
      const statusLabel = isPending ? '⏳ KUTILMOQDA' : ('✅ TASDIQLANGAN' + schedDate);
      const payType = r.get('Payment Type') || '';
      const payDetail = r.get('Payment Detail') || '';

      const msg =
        `[${statusLabel}]\n` +
        `${r.get('Branch') || ''} | ${r.get('Staff Name') || ''}\n` +
        `${amt.toLocaleString('en-US')} UZS | ${payType} (${payDetail})\n` +
        `${r.get('Description') || ''}\n` +
        `🆔 ID: ${r.rowNumber}`;

      let btns = [];
      if (isPending) {
        btns = [
          [Markup.button.callback('✅ Tasdiqlash', 'decide_' + r.rowNumber)],
          [Markup.button.callback('❌ Rad etish', 'rej_' + r.rowNumber)]
        ];
      } else {
        btns = [
          [Markup.button.callback('💸 Tolash (Chek reply qiling)', 'paynow_' + r.rowNumber)],
          [Markup.button.callback('❌ Rad etish', 'rej_' + r.rowNumber)]
        ];
      }
      await ctx.reply(msg, Markup.inlineKeyboard(btns));
    }
  } catch (e) {
    console.error(e);
    ctx.reply('❌ Xatolik.');
  }
});

// ==========================================
// 18. ASOSIY XABAR HANDLERI (FIXED BRANCH COMPARE)
// ==========================================
bot.on('message', async (ctx) => {
  const userId = ctx.from.id;
  const uid = userId.toString();
  const text = ctx.message.text || '';
  const voice = ctx.message.voice;

  const adminTexts = ['Hisobot', 'Kutilayotgan', 'Cashflow', 'Limitlar', 'Kategoriyalar', 'Foydalanuvchilar'];
  if (adminTexts.includes(text)) return;

  if (text === 'Bekor qilish' || text === '/start') {
    delete userSessions[userId];
    if (isAdmin(userId)) {
      return ctx.reply('Bekor qilindi.', Markup.keyboard([
        ['Hisobot', 'Kutilayotgan'],
        ['Cashflow', 'Limitlar'],
        ['Kategoriyalar', 'Foydalanuvchilar']
      ]).resize());
    }
    const branches = await getUserBranches(userId);
    const displayBranches = branches.map(b => `📍 ${b}`);
    return ctx.reply('Bekor qilindi.', Markup.keyboard([...displayBranches, 'Bekor qilish'], { columns: 2 }).resize());
  }

  const session = userSessions[userId];
  if (!session) {
    // Check if the message is a branch selection (with or without emoji)
    const branches = await getUserBranches(userId);
    const displayBranches = branches.map(b => `📍 ${b}`);
    let selectedBranch = null;
    if (displayBranches.includes(text)) {
      selectedBranch = text.replace('📍 ', '');
    } else if (branches.includes(text)) {
      selectedBranch = text;
    }
    if (selectedBranch) {
      userSessions[userId] = { type: 'expense', step: 'BRANCH', branch: selectedBranch };
      // Move to next step immediately
      session.step = 'CATEGORY';
      const cats = await getUserCategories(userId);
      return ctx.reply('📂 Kategoriyani tanlang:',
        Markup.keyboard([...cats, 'Bekor qilish'], { columns: 2 }).resize());
    }
    return;
  }

  // ========== ADMIN LIMIT FLOW ==========
  if (session.type === 'admin' && session.step === 'LIMIT_BRANCH') {
    const branch = text.replace('📍 ', '');
    if (ALL_BRANCHES.includes(branch)) {
      session.limitBranch = `📍 ${branch}`;
      session.step = 'LIMIT_CATEGORY';
      const cats = await getActiveCategories();
      return ctx.reply(
        `${text} uchun qaysi limit?\n\n"Umumiy filial" = barcha kategoriyalar uchun umumiy chegara`,
        Markup.keyboard([...cats, 'Umumiy filial', 'Bekor qilish'], { columns: 2 }).resize()
      );
    }
  }

  if (session.type === 'admin' && session.step === 'LIMIT_CATEGORY') {
    if (text === 'Umumiy filial') {
      session.limitCategory = null;
    } else {
      session.limitCategory = text;
    }
    session.step = 'LIMIT_AMOUNT';
    const brName = session.limitBranch;
    const catName = session.limitCategory || 'Umumiy';
    return ctx.reply(`💰 ${brName} - ${catName} uchun oylik limit summasi (faqat raqam):`);
  }

  if (session.type === 'admin' && session.step === 'LIMIT_AMOUNT') {
    const amount = parseSafeInt(text);
    if (amount === 0) return ctx.reply('Iltimos, yaroqli raqam kiriting:');
    const ok = await setBudgetLimit(session.limitBranch, session.limitCategory, amount);
    delete userSessions[userId];
    if (ok) {
      return ctx.reply(
        `✅ Limit saqlandi!\n${session.limitBranch} - ${session.limitCategory || 'Umumiy'}: ${amount.toLocaleString()} UZS`,
        Markup.keyboard([
          ['Hisobot', 'Kutilayotgan'],
          ['Cashflow', 'Limitlar'],
          ['Kategoriyalar', 'Foydalanuvchilar']
        ]).resize()
      );
    } else {
      return ctx.reply('❌ Xatolik yuz berdi. Qaytadan urining.');
    }
  }

  // ========== CATEGORY MANAGEMENT ==========
  if (session.type === 'admin' && session.step === 'ADD_CATEGORY') {
    const ok = await addCategory(text);
    delete userSessions[userId];
    if (ok) {
      return ctx.reply(`✅ "${text}" kategoriyasi qoshildi!`,
        Markup.keyboard([['Kategoriyalar', 'Bekor qilish']]).resize());
    } else {
      return ctx.reply(`⚠️ Bu kategoriya allaqachon mavjud.`);
    }
  }

  if (session.type === 'admin' && session.step === 'DELETE_CATEGORY') {
    const ok = await deleteCategory(text);
    delete userSessions[userId];
    if (ok) {
      return ctx.reply(`✅ "${text}" kategoriyasi o'chirildi!`);
    } else {
      return ctx.reply(`⚠️ Kategoriya topilmadi.`);
    }
  }

  if (text === '➕ Yangi kategoriya') {
    if (!isAdmin(userId)) return;
    userSessions[userId] = { type: 'admin', step: 'ADD_CATEGORY' };
    return ctx.reply('Yangi kategoriya nomini kiriting:', Markup.keyboard(['Bekor qilish']).resize());
  }

  if (text === "❌ Kategoriyani o'chirish") {
    if (!isAdmin(userId)) return;
    const cats = await getActiveCategories();
    userSessions[userId] = { type: 'admin', step: 'DELETE_CATEGORY' };
    return ctx.reply("O'chirmoqchi bo'lgan kategoriyani tanlang:",
      Markup.keyboard([...cats, 'Bekor qilish'], { columns: 2 }).resize());
  }

  // ========== USER MANAGEMENT ==========
  if (text === '➕ Foydalanuvchi qoshish') {
    if (!isAdmin(userId)) return;
    userSessions[userId] = { type: 'admin', step: 'USER_ADD_ID' };
    return ctx.reply('🆔 Xodimning Telegram ID sini kiriting:', Markup.keyboard(['Bekor qilish']).resize());
  }

  if (text === "📋 Foydalanuvchilar royxati") {
    if (!isAdmin(userId)) return;
    try {
      const sheet = await ensureSheet('Users', ['Telegram ID', 'Name', 'Role', 'Branches', 'Categories']);
      const rows = await sheet.getRows();
      if (!rows.length) return ctx.reply("📭 Hali foydalanuvchi qo'shilmagan.");
      for (const r of rows) {
        const tid = r.get('Telegram ID');
        const name = r.get('Name');
        const role = r.get('Role');
        const branches = r.get('Branches');
        const cats = r.get('Categories');
        const msg = `${name}\n🆔 ${tid}\n👔 Rol: ${role}\n🏢 Filiallar: ${branches}\n📂 Kategoriyalar: ${cats.length > 60 ? cats.substring(0,60)+'...' : cats}`;
        await ctx.reply(msg, Markup.inlineKeyboard([
          [Markup.button.callback('✏️ Filiallarni ozgartirish', 'edit_branch_' + tid)],
          [Markup.button.callback('✏️ Kategoriyalarni ozgartirish', 'edit_cat_' + tid)],
          [Markup.button.callback('🗑 Xodimni ochirish', 'del_user_' + tid)]
        ]));
      }
    } catch (e) {
      return ctx.reply('❌ Xatolik.');
    }
  }

  if (session.type === 'admin' && session.step === 'USER_ADD_ID') {
    session.newUserId = text;
    session.step = 'USER_ADD_NAME';
    return ctx.reply('👤 Xodim ismini kiriting:');
  }

  if (session.type === 'admin' && session.step === 'USER_ADD_NAME') {
    session.newUserName = text;
    session.step = 'USER_ADD_ROLE';
    return ctx.reply('👔 Rolini tanlang:', Markup.keyboard(['Staff', 'Manager', 'Bekor qilish']).resize());
  }

  if (session.type === 'admin' && session.step === 'USER_ADD_ROLE') {
    if (!['Staff', 'Manager'].includes(text)) return ctx.reply("Staff yoki Manager tanlang:");
    session.newUserRole = text;
    session.step = 'USER_ADD_BRANCHES';
    session.selectedBranches = [];
    return ctx.reply(
      '🏢 Filiallarni tanlang (bir nechtasini belgilash mumkin):\n\nTanlangan: hech biri',
      buildBranchButtons([])
    );
  }

  // ========== EXPENSE REQUEST FLOW ==========
  if (session.type === 'expense' && session.step === 'BRANCH') {
    // branch already set when first selected
    session.step = 'CATEGORY';
    const cats = await getUserCategories(userId);
    return ctx.reply('📂 Kategoriyani tanlang:',
      Markup.keyboard([...cats, 'Bekor qilish'], { columns: 2 }).resize());
  }

  if (session.type === 'expense' && session.step === 'CATEGORY') {
    session.category = text;
    session.step = 'AMOUNT';
    return ctx.reply('💰 Summani kiriting (Faqat raqam):', Markup.keyboard(['Bekor qilish']).resize());
  }

  if (session.type === 'expense' && session.step === 'AMOUNT') {
    session.amount = parseSafeInt(text);
    if (session.amount === 0) return ctx.reply('Iltimos, yaroqli son kiriting:');
    session.step = 'DESCRIPTION';
    return ctx.reply('📝 Xarajat sababi:');
  }

  if (session.type === 'expense' && session.step === 'DESCRIPTION') {
    if (voice) {
      session.description = 'Ovozli izoh';
      session.voiceFileId = voice.file_id;
    } else if (text) {
      session.description = text;
      session.voiceFileId = null;
    } else {
      return ctx.reply("Iltimos, matn yoki ovozli xabar yuboring.");
    }
    session.step = 'PRIORITY';
    return ctx.reply('⚡ Muhimligi:', Markup.keyboard([...PRIORITIES, 'Bekor qilish'], { columns: 1 }).resize());
  }

  if (session.type === 'expense' && session.step === 'PRIORITY') {
    if (PRIORITIES.includes(text)) {
      session.priority = text;
      session.step = 'PAY_TYPE';
      return ctx.reply("💳 To'lov turi:", Markup.keyboard(['Karta', 'Naqd', 'MCHJ hisobi', 'Bekor qilish']).resize());
    }
  }

  if (session.type === 'expense' && session.step === 'PAY_TYPE') {
    session.payType = text;
    if (text === 'Naqd') {
      session.payDetail = 'N/A';
      return showSummary(ctx, session);
    }
    session.step = 'PAY_DETAIL';
    return ctx.reply(text === 'Karta' ? '💳 Karta raqamini kiriting:' : '🏢 Firma nomini kiriting:');
  }

  if (session.type === 'expense' && session.step === 'PAY_DETAIL') {
    session.payDetail = text;
    return showSummary(ctx, session);
  }
});

// ==========================================
// 19. SO'ROV YUBORISH (FINAL SUBMIT)
// ==========================================
bot.action(/^(submit_final|cancel_final)$/, async (ctx) => {
  const action = ctx.match[1];
  const userId = ctx.from.id;
  const session = userSessions[userId];

  if (action === 'cancel_final') {
    delete userSessions[userId];
    await ctx.editMessageText('❌ So\'rov bekor qilindi.');
    const branches = await getUserBranches(userId);
    const displayBranches = branches.map(b => `📍 ${b}`);
    return ctx.reply('Yangi so\'rov uchun filialni tanlang:', Markup.keyboard(displayBranches, { columns: 2 }).resize());
  }

  if (action === 'submit_final' && session && session.type === 'expense') {
    try {
      const budgetCheck = await checkBudget(session.branch, session.category, session.amount);
      if (budgetCheck.blocked) {
        delete userSessions[userId];
        return ctx.editMessageText(`❌ RAD ETILDI!\n\n${budgetCheck.reason}\n\nIltimos, rahbariyat bilan bog'laning.`);
      }

      await doc.loadInfo();
      let expSheet = doc.sheetsByTitle['Pending_Expenses'];
      if (!expSheet) {
        expSheet = await doc.addSheet({ title: 'Pending_Expenses', headerValues: [
          'Timestamp', 'Branch', 'Staff Name', 'Amount', 'Payment Type', 'Payment Detail',
          'Description', 'Status', '_StaffChatId', 'Priority', 'GroupMsgId', 'Scheduled Date'
        ]});
      }

      const row = await expSheet.addRow({
        'Timestamp': new Date().toLocaleString('en-US', { timeZone: 'Asia/Tashkent' }),
        'Branch': `📍 ${session.branch}`,
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

      let buttons = [
        [Markup.button.callback('✅ Tasdiqlash', `decide_${row.rowNumber}`)],
        [Markup.button.callback('❌ Rad etish', `rej_${row.rowNumber}`)]
      ];

      let warningText = '';
      if (budgetCheck.warnings && budgetCheck.warnings.length > 0) {
        warningText = `\n\n⚠️ OGOHLANTIRISH:\n${budgetCheck.warnings.join('\n')}`;
      }

      const managerMsg =
        `🆕 Yangi So'rov\n` +
        `🏢 Filial: 📍 ${session.branch}\n` +
        `👤 Kimdan: ${ctx.from.first_name}\n` +
        `💰 Summa: ${session.amount.toLocaleString('en-US')} UZS\n` +
        `💳 To'lov: ${session.payType} (${session.payDetail})\n` +
        `📝 Sabab: ${session.description}\n` +
        `⚡ Muhimligi: ${session.priority}` +
        warningText;

      for (let managerId of MANAGER_IDS) {
        await bot.telegram.sendMessage(managerId, managerMsg, Markup.inlineKeyboard(buttons)).catch(() => {});
        if (session.voiceFileId) {
          await bot.telegram.sendVoice(managerId, session.voiceFileId, { caption: `🎤 Ovozli izoh (ID: ${row.rowNumber})` }).catch(() => {});
        }
      }

      if (MAINTENANCE_GROUP_ID) {
        const groupMsg = `🆕 Yangi So'rov Yaratildi\n\n🏢 Filial: 📍 ${session.branch}\n📂 Kategoriya: ${session.category}\n💰 Summa: ${session.amount.toLocaleString('en-US')} UZS\n👤 Sotirdi: ${ctx.from.first_name}\n📝 Sabab: ${session.description}\n⏳ Holati: Menejer tasdig'i kutilmoqda...`;
        const groupPost = await bot.telegram.sendMessage(MAINTENANCE_GROUP_ID, groupMsg).catch(() => null);
        if (groupPost) {
          try { row.set('GroupMsgId', groupPost.message_id.toString()); await row.save(); } catch (e) {}
          if (session.voiceFileId) {
            await bot.telegram.sendVoice(MAINTENANCE_GROUP_ID, session.voiceFileId, { reply_to_message_id: groupPost.message_id }).catch(() => {});
          }
        }
      }

      delete userSessions[userId];
      await ctx.editMessageText(`✅ Muvaffaqiyatli yuborildi!\n🆔 ID: ${row.rowNumber}`);
      const branches = await getUserBranches(userId);
      const displayBranches = branches.map(b => `📍 ${b}`);
      ctx.reply('Yangi so\'rov uchun filialni tanlang:', Markup.keyboard(displayBranches, { columns: 2 }).resize());
    } catch (e) {
      delete userSessions[userId];
      console.error(e);
      ctx.editMessageText('❌ Xatolik yuz berdi.');
    }
  } else {
    delete userSessions[userId];
    ctx.editMessageText('⏳ Sessiya tugadi. /start bosing.');
  }
});

// ==========================================
// 20. CHEK VA TASDIQLASH
// ==========================================
bot.on('photo', async (ctx) => {
  if (!MANAGER_IDS.includes(ctx.from.id.toString())) return;

  const reply = ctx.message.reply_to_message;
  if (!reply || !reply.text || !reply.text.includes('ID:')) return;

  const rowNum = reply.text.split('ID:')[1].trim().split('\n')[0].trim();
  try {
    await doc.loadInfo();
    const rows = await doc.sheetsByTitle['Pending_Expenses'].getRows();
    const row = rows.find(r => r.rowNumber == rowNum);
    if (!row) return ctx.reply('❌ ID topilmadi.');

    const staffChatId = row.get('_StaffChatId');
    const amount = parseSafeInt(row.get('Amount')).toLocaleString('en-US');
    const fileId = ctx.message.photo[ctx.message.photo.length - 1].file_id;

    row.set('Status', 'CHEQUE_SENT');
    await row.save();

    ctx.reply('✅ Chek xodimga tasdiqlash uchun yuborildi!');
    await bot.telegram.sendPhoto(staffChatId, fileId, {
      caption: `💵 TOLOV QILINDI!\nProcurement Manager pulni o'tkazdi.\n💰 Summa: ${amount} UZS\n\nIltimos, pulni olganingizni tasdiqlang:`,
      reply_markup: { inline_keyboard: [[{ text: '✅ Qabul qildim', callback_data: 'staffconfirm_' + rowNum }]] }
    }).catch(e => console.error('Staff photo error:', e.message));

    const groupMsgId = row.get('GroupMsgId');
    if (MAINTENANCE_GROUP_ID && groupMsgId) {
      await bot.telegram.sendPhoto(MAINTENANCE_GROUP_ID, fileId, {
        reply_to_message_id: parseInt(groupMsgId),
        caption: '📎 Procurement menejer chekni yubordi. Xodim tasdig\'i kutilmoqda...'
      }).catch(e => console.error('Group photo error:', e.message));
    }
  } catch (e) {
    console.error('Photo handler error:', e);
    ctx.reply('❌ Xatolik: ' + e.message);
  }
});

bot.action(/^staffconfirm_(\d+)$/, async (ctx) => {
  const rowNum = ctx.match[1];
  try {
    await doc.loadInfo();
    const rows = await doc.sheetsByTitle['Pending_Expenses'].getRows();
    const row = rows.find(r => r.rowNumber == rowNum);
    if (!row) return ctx.answerCbQuery('ID topilmadi.');

    row.set('Status', 'PAID');
    await row.save();

    await ctx.editMessageCaption('✅ PUL QABUL QILINDI VA YOPILDI.');
    for (let managerId of MANAGER_IDS) {
      await bot.telegram.sendMessage(managerId, `✅ Xodim ${parseSafeInt(row.get('Amount')).toLocaleString('en-US')} UZS miqdoridagi pulni olganini tasdiqladi. (ID: ${rowNum})`).catch(() => {});
    }
    const groupMsgId = row.get('GroupMsgId');
    if (MAINTENANCE_GROUP_ID && groupMsgId) {
      await bot.telegram.sendMessage(MAINTENANCE_GROUP_ID, '✅ Xodim tolovni qabul qildi. Tasdiqlandi.', { reply_to_message_id: parseInt(groupMsgId) }).catch(() => {});
    }
  } catch (e) {
    ctx.answerCbQuery('❌ Xatolik.');
  }
});

// ==========================================
// 21. MANAGER TASDIQLASH AMALLARI
// ==========================================
bot.action(/^(decide|paynow|schedD|schedF|schedM|rej)_(\d+)(?:_(\d+))?$/, async (ctx) => {
  if (!isAdmin(ctx.from.id)) return ctx.answerCbQuery("❌ Sizda huquq yo'q.");

  const [action, rowNum, param] = [ctx.match[1], ctx.match[2], ctx.match[3]];
  try {
    await doc.loadInfo();
    const rows = await doc.sheetsByTitle['Pending_Expenses'].getRows();
    const row = rows.find(r => r.rowNumber == rowNum);
    if (!row) return ctx.editMessageText('❌ Xatolik: Qator topilmadi.');

    if (['decide', 'rej'].includes(action) && row.get('Status') !== 'PENDING') {
      return ctx.editMessageText('⚠️ Boshqa menejer tomonidan ko‘rib chiqilgan.');
    }
    if (action === 'paynow' && !['PENDING', 'SCHEDULED'].includes(row.get('Status'))) {
      return ctx.answerCbQuery('Bu so‘rov allaqachon qayta ishlangan!');
    }

    const staffId = row.get('_StaffChatId');
    const payType = row.get('Payment Type');
    const payDetail = row.get('Payment Detail');
    const amount = parseSafeInt(row.get('Amount')).toLocaleString('en-US');

    if (action === 'decide') {
      return ctx.editMessageText(
        `⏰ Qachon to'laysiz?\n💳 To'lov: ${payType} (${payDetail})\n💰 Summa: ${amount} UZS`,
        Markup.inlineKeyboard([
          [Markup.button.callback('💸 Hozir Tolash', `paynow_${rowNum}`)],
          [Markup.button.callback('📅 Dushanba', `schedD_${rowNum}_1`), Markup.button.callback('📅 Seshanba', `schedD_${rowNum}_2`)],
          [Markup.button.callback('📅 Chorshanba', `schedD_${rowNum}_3`), Markup.button.callback('📅 Payshanba', `schedD_${rowNum}_4`)],
          [Markup.button.callback('📅 Juma', `schedD_${rowNum}_5`)],
          [Markup.button.callback('📅 15 kun', `schedF_${rowNum}_15`), Markup.button.callback('📅 1 oy', `schedM_${rowNum}`)]
        ])
      );
    }

    if (action === 'paynow') {
      row.set('Status', 'SCHEDULED');
      row.set('Scheduled Date', getTodayStr());
      await row.save();
      await updateGroupStatus(row, true);
      await bot.telegram.sendMessage(staffId, "✅ To'lov tasdiqlandi! Pul o'tkazilmoqda.").catch(() => {});
      await ctx.editMessageText(`✅ Hozir to'lash tanlandi.\n💳 To'lov: ${payType} (${payDetail})\n💰 Summa: ${amount} UZS`);
      await bot.telegram.sendMessage(ctx.from.id, `📎 Ushbu xabarga CHEK RASMINI REPLY qilib yuboring.\n🆔 ID: ${rowNum}`);
      return;
    }

    if (action.startsWith('sched')) {
      let d = '';
      if (action === 'schedD') d = getScheduledDateStr('D', parseInt(param));
      if (action === 'schedF') d = getScheduledDateStr('F', parseInt(param));
      if (action === 'schedM') d = getScheduledDateStr('M', 0);
      row.set('Status', 'SCHEDULED');
      row.set('Scheduled Date', d);
      await row.save();
      await updateGroupStatus(row, true);
      await bot.telegram.sendMessage(staffId, `✅ Tasdiqlandi. To'lov sanasi: ${d}`).catch(() => {});
      return ctx.editMessageText(`📅 ${d} sanasiga rejalashtirildi.\n💳 To'lov: ${payType} (${payDetail})\n💰 Summa: ${amount} UZS`);
    }

    if (action === 'rej') {
      row.set('Status', 'REJECTED');
      await row.save();
      await updateGroupStatus(row, false);
      await bot.telegram.sendMessage(staffId, "❌ So'rov rad etildi.").catch(() => {});
      return ctx.editMessageText('❌ Rad etildi va yopildi.');
    }
  } catch (e) {
    console.error(e);
    ctx.editMessageText('❌ Amalni bajarishda xatolik.');
  }
});

// ==========================================
// 22. FOYDALANUVCHI TAHRIRLASH ACTIONS
// ==========================================
bot.action(/^edit_branch_(.+)$/, async (ctx) => {
  if (!isAdmin(ctx.from.id)) return ctx.answerCbQuery();
  const tid = ctx.match[1];
  const uid = ctx.from.id;
  userSessions[uid] = {
    type: 'admin',
    step: 'EDIT_BRANCH',
    editUserId: tid,
    selectedBranches: [],
    allBranchesSelected: false
  };
  try {
    const user = await getUserData(tid);
    if (user) {
      const br = user.get('Branches') || '';
      if (br === 'hammasi') {
        userSessions[uid].selectedBranches = [...ALL_BRANCHES];
        userSessions[uid].allBranchesSelected = true;
      } else {
        userSessions[uid].selectedBranches = br.split(',').map(b => b.trim()).filter(Boolean);
      }
    }
  } catch(e) {}
  const sel = userSessions[uid].selectedBranches;
  await ctx.editMessageReplyMarkup(null).catch(() => {});
  await ctx.reply(`✏️ Filiallarni tanlang (hozirgi: ${sel.length > 0 ? sel.join(', ') : 'hech biri'}):`, buildBranchButtons(sel));
  ctx.answerCbQuery();
});

bot.action(/^edit_cat_(.+)$/, async (ctx) => {
  if (!isAdmin(ctx.from.id)) return ctx.answerCbQuery();
  const tid = ctx.match[1];
  const uid = ctx.from.id;
  const allCats = await getActiveCategories();
  userSessions[uid] = {
    type: 'admin',
    step: 'EDIT_CAT',
    editUserId: tid,
    selectedCategories: [],
    allCatsSelected: false
  };
  try {
    const user = await getUserData(tid);
    if (user) {
      const cats = user.get('Categories') || '';
      if (cats === 'hammasi') {
        userSessions[uid].selectedCategories = [...allCats];
        userSessions[uid].allCatsSelected = true;
      } else {
        userSessions[uid].selectedCategories = cats.split(',').map(c => c.trim()).filter(Boolean);
      }
    }
  } catch(e) {}
  const sel = userSessions[uid].selectedCategories;
  await ctx.editMessageReplyMarkup(null).catch(() => {});
  await ctx.reply(`✏️ Kategoriyalarni tanlang (${sel.length > 0 ? sel.length + ' ta tanlangan' : 'hech biri'}):`, await buildCategoryButtons(sel));
  ctx.answerCbQuery();
});

bot.action(/^del_user_(.+)$/, async (ctx) => {
  if (!isAdmin(ctx.from.id)) return ctx.answerCbQuery();
  const tid = ctx.match[1];
  try {
    const sheet = await ensureSheet('Users', ['Telegram ID', 'Name', 'Role', 'Branches', 'Categories']);
    const rows = await sheet.getRows();
    const row = rows.find(r => r.get('Telegram ID') === tid);
    if (!row) return ctx.answerCbQuery('Topilmadi.');
    const name = row.get('Name');
    await row.delete();
    await ctx.editMessageText(`🗑 Xodim ${name} o'chirildi.`);
    ctx.answerCbQuery();
  } catch(e) {
    ctx.answerCbQuery('Xatolik.');
  }
});

// ==========================================
// 23. KUNLIK ESLATMA (CRON)
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
          `⏰ ESLATMA: Bugun to'lov qilinishi kerak!\n\n` +
          `${row.get('Branch')}\n` +
          `${parseSafeInt(row.get('Amount')).toLocaleString('en-US')} UZS\n` +
          `💳 To'lov: ${row.get('Payment Type')} (${row.get('Payment Detail')})\n` +
          `${row.get('Description')}\n\n` +
          `📎 To'lovni amalga oshirgach, ushbu xabarga CHEK RASMINI REPLY qilib yuboring.\n🆔 ID: ${row.rowNumber}`
        ).catch(() => {});
      }
    }
  } catch (e) {
    console.error('Cron Error:', e);
  }
}, { scheduled: true, timezone: 'Asia/Tashkent' });

// ==========================================
// 24. ISHGA TUSHIRISH
// ==========================================
bot.launch({ dropPendingUpdates: true }).then(() => console.log('✅ IELTS Zone Finance Bot ishga tushdi!'));
process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
