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

bot.command(['start', 'new'], (ctx) => {
  userSessions[ctx.from.id] = { step: 'BRANCH' };
  ctx.reply('IELTS Zone Finance Bot 🎓\nSelect Branch:', Markup.keyboard(branches, { columns: 2 }).oneTime().resize());
});

bot.on(['text', 'photo'], async (ctx) => {
  const userId = ctx.from.id.toString();
  const text = ctx.message.text;

  // --- MANAGER: CHEQUE HANDLER ---
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
        await bot.telegram.sendPhoto(staffId, ctx.message.photo[0].file_id, { caption: `✅ To'lov tasdiqlandi: ${row.get('Amount')} UZS` });
        ctx.reply('💰 Muvaffaqiyatli! Status "PAID" ga o\'zgardi.');
        delete managerSessions[userId];
      } catch (e) { ctx.reply('Xatolik!'); }
      return;
    }
  }

  if (text === '❌ Cancel' || text === '/start') {
    userSessions[userId] = { step: 'BRANCH' };
    return ctx.reply('Bekor qilindi. Filialni tanlang:', Markup.keyboard(branches, { columns: 2 }).resize());
  }

  const session = userSessions[userId];
  if (!session) return;

  // 1. BRANCH
  if (session.step === 'BRANCH') {
    if (branches.includes(text)) {
      session.branch = text;
      session.step = 'CATEGORY';
      return ctx.reply('Kategoriyani tanlang:', Markup.keyboard([...categories, '❌ Cancel'], { columns: 2 }).resize());
    }
  }

  // 2. CATEGORY
  if (session.step === 'CATEGORY') {
    if (categories.includes(text)) {
      session.category = text;
      session.step = 'AMOUNT';
      return ctx.reply('Summani kiriting (Faqat raqam):', Markup.keyboard(['❌ Cancel']).resize());
    }
  }

  // 3. AMOUNT
  if (session.step === 'AMOUNT') {
    session.amount = text.replace(/[^0-9]/g, '');
    session.step = 'DESCRIPTION';
    return ctx.reply('Xarajat haqida qisqacha ma\'lumot (Description):');
  }

  // 4. DESCRIPTION
  if (session.step === 'DESCRIPTION') {
    session.description = text;
    session.step = 'PAY_TYPE';
    return ctx.reply('To\'lov turi qanday bo\'ladi?', Markup.keyboard(['Karta', 'Naqd', 'MCHJ hisobi', '❌ Cancel']).resize());
  }

  // 5. PAYMENT TYPE LOGIC
  if (session.step === 'PAY_TYPE') {
    if (text === 'Karta') {
      session.payType = 'Karta';
      session.step = 'PAY_DETAIL';
      return ctx.reply('Karta raqamini kiriting:');
    } else if (text === 'MCHJ hisobi') {
      session.payType = 'MCHJ';
      session.step = 'PAY_DETAIL';
      return ctx.reply('Firma nomini kiriting:');
    } else if (text === 'Naqd') {
      session.payType = 'Naqd';
      session.payDetail = 'N/A';
      return submitToManager(ctx, session);
    }
  }

  // 6. PAYMENT DETAIL (Card or Firm Name)
  if (session.step === 'PAY_DETAIL') {
    session.payDetail = text;
    return submitToManager(ctx, session);
  }
});

async function submitToManager(ctx, session) {
  const userId = ctx.from.id.toString();
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
      '_StaffChatId': userId
    });

    await bot.telegram.sendMessage(MANAGER_ID, 
      `🏢 *Yangi so'rov*\n📍 Filial: ${session.branch}\n👤 Kimdan: ${ctx.from.first_name}\n💵 Summa: ${session.amount} UZS\n💳 Tur: ${session.payType}\n📝 Tafsilot: ${session.payDetail}\n💬 Sabab: ${session.description}`, 
      { parse_mode: 'Markdown', ...Markup.inlineKeyboard([[Markup.button.callback('✅ Tasdiqlash va Chek yuborish', `app_${row.rowNumber}`)], [Markup.button.callback('❌ Rad etish', `rej_${row.rowNumber}`)]]) }
    );

    delete userSessions[userId];
    ctx.reply('✅ So\'rov yuborildi!');
    return ctx.reply('Keyingi xarajat?', Markup.keyboard(branches, { columns: 2 }).resize());
  } catch (e) { ctx.reply('Xatolik! Sheet formatini tekshiring.'); console.error(e); }
}

bot.action(/^(app|rej)_(.+)$/, async (ctx) => {
  const [action, rowNum] = [ctx.match[1], ctx.match[2]];
  if (action === 'app') {
    await doc.loadInfo();
    const sheet = doc.sheetsByTitle['Pending_Expenses'];
    const rows = await sheet.getRows();
    const row = rows.find(r => r.rowNumber == rowNum);
    managerSessions[MANAGER_ID] = { rowNum, staffId: row.get('_StaffChatId') };
    ctx.editMessageText(`💰 ${row.get('Amount')} UZS uchun to'lov chekini (Rasm) yuboring:`);
  } else {
    ctx.editMessageText('❌ Rad etildi.');
  }
});

bot.launch();
