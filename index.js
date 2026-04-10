const { Telegraf, Markup } = require('telegraf');
const { JWT } = require('google-auth-library');
const { GoogleSpreadsheet } = require('google-spreadsheet');

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
const managerSessions = {};

const branches = ['📍 Integro', '📍 Drujba', '📍 Amir Temur', '📍 Central', '📍 Marketing'];
const categories = ['naqd', 'tugilgan kun uchun', 'printer rang', 'Printer tuzatish', 'remont-tuzatish', 'Hodimlar uchun dorilar', 'jihoz', 'Texnikalar', 'Transport', 'aromatizator', 'Internet', 'Telefon', 'of the month', 'Event', 'Reklama mahsulotlarini chiqarish', 'giftbox sovgalar', 'syomka xarajatlari', 'bozorlik xojalik', 'Suv va stakan', 'Konstovar', 'Plastik foizi', 'ofis xarajatlari', 'remont qurilish'];

// --- ANALYTICS REPORT ---
bot.command('report', async (ctx) => {
  if (ctx.from.id.toString() !== MANAGER_ID) return;
  try {
    await doc.loadInfo();
    const sheet = doc.sheetsByTitle['Pending_Expenses'];
    const rows = await sheet.getRows();
    const paid = rows.filter(r => r.get('Status') === 'PAID');
    
    let branchTotals = {};
    let typeTotals = { 'Karta': 0, 'Naqd': 0, 'MCHJ': 0 };
    let total = 0;

    paid.forEach(r => {
      const b = r.get('Branch') || 'Other';
      const t = r.get('Payment Type') || 'Other';
      const a = Number(r.get('Amount') || 0);
      
      branchTotals[b] = (branchTotals[b] || 0) + a;
      if (typeTotals.hasOwnProperty(t)) typeTotals[t] += a;
      total += a;
    });

    let msg = `📊 *IELTS Zone Final Report*\n━━━━━━━━━━━━━━━\n`;
    msg += `💰 *Total Paid:* ${total.toLocaleString()} UZS\n\n`;
    
    msg += `🏢 *By Branch:*\n`;
    branches.forEach(b => {
      msg += `• ${b}: ${(branchTotals[b] || 0).toLocaleString()} UZS\n`;
    });

    msg += `\n💳 *By Payment Type:*\n`;
    msg += `• Karta: ${typeTotals['Karta'].toLocaleString()} UZS\n`;
    msg += `• Naqd: ${typeTotals['Naqd'].toLocaleString()} UZS\n`;
    msg += `• MCHJ: ${typeTotals['MCHJ'].toLocaleString()} UZS\n`;
    msg += `━━━━━━━━━━━━━━━`;

    ctx.reply(msg, { parse_mode: 'Markdown' });
  } catch (e) { ctx.reply('Report Error.'); console.error(e); }
});

bot.command(['start', 'new'], (ctx) => {
  userSessions[ctx.from.id] = { step: 'BRANCH' };
  ctx.reply('IELTS Zone Finance Bot 🎓\nSelect Branch:', Markup.keyboard(branches, { columns: 2 }).oneTime().resize());
});

bot.on(['text', 'photo'], async (ctx) => {
  const userId = ctx.from.id.toString();
  const text = ctx.message.text;

  if (userId === MANAGER_ID && managerSessions[userId]) {
    if (ctx.message.photo) {
      const { rowNum, staffId } = managerSessions[userId];
      try {
        await doc.loadInfo();
        const sheet = doc.sheetsByTitle['Pending_Expenses'];
        const rows = await sheet.getRows();
        const row = rows.find(r => r.rowNumber == rowNum);
        row.set('Status', 'PAID');
        await row.save();
        await bot.telegram.sendPhoto(staffId, ctx.message.photo
