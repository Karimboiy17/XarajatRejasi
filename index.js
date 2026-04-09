const { Telegraf, Markup } = require('telegraf');
const { JWT } = require('google-auth-library');
const { GoogleSpreadsheet } = require('google-spreadsheet');

const bot = new Telegraf(process.env.BOT_TOKEN);
const SHEET_ID = process.env.SHEET_ID;
const MANAGER_ID = process.env.MANAGER_CHAT_ID;

const creds = JSON.parse(process.env.GCP_SERVICE_ACCOUNT);
const serviceAccountAuth = new JWT({
  email: creds.client_email,
  key: creds.private_key,
  scopes: ['https://www.googleapis.com/auth/spreadsheets'],
});

const doc = new GoogleSpreadsheet(SHEET_ID, serviceAccountAuth);

// Temporary storage to remember which category the user picked
const userSessions = {};

const categories = ['🏠 Rent', '📢 Marketing', '💻 IT/Office', '☕️ Kitchen', '🎓 Teacher Salary', '🛠 Maintenance'];

bot.command(['start', 'new'], (ctx) => {
  ctx.reply('Welcome to IELTS Zone Expense Bot! 🎓\nChoose a category:', 
    Markup.keyboard(categories, { columns: 2 }).oneTime().resize()
  );
});

bot.on('text', async (ctx) => {
  const text = ctx.message.text;
  const userId = ctx.from.id;

  // 1. Handle Category Selection
  if (categories.includes(text)) {
    userSessions[userId] = { category: text };
    return ctx.reply(`Selected: ${text}\nNow send the **Amount** and **Reason**.\n\nExample: 150000 Printer ink`, Markup.removeKeyboard());
  }

  // 2. Handle the Amount + Description
  const parts = text.split(' ');
  const amount = parts[0];
  const description = parts.slice(1).join(' ');

  if (!isNaN(amount) && amount > 0) {
    const category = userSessions[userId]?.category || 'General';
    await processRequest(ctx, amount, `${category}: ${description}`);
    delete userSessions[userId]; // Clear session
  } else {
    ctx.reply('Please start with a number (Amount). Example: 50000 Lunch');
  }
});

async function processRequest(ctx, amount, fullDescription) {
  const staffName = ctx.from.first_name || 'Staff';
  try {
    await doc.loadInfo();
    const sheet = doc.sheetsByTitle['Pending_Expenses']; 
    
    const row = await sheet.addRow({
      'Timestamp': new Date().toLocaleString('en-GB'),
      'Staff Name': staffName,
      'Amount': amount,
      'Description': fullDescription,
      'Status': 'PENDING',
      '_StaffChatId': ctx.from.id.toString()
    });

    await bot.telegram.sendMessage(MANAGER_ID, 
      `💰 *New Request*\n\nFrom: ${staffName}\nAmount: ${amount}\nDetails: ${fullDescription}`, 
      {
        parse_mode: 'Markdown',
        ...Markup.inlineKeyboard([
          [Markup.button.callback('✅ Approve', `app_${row.rowNumber}`)],
          [Markup.button.callback('❌ Reject', `rej_${row.rowNumber}`)]
        ])
      }
    );

    ctx.reply('✅ Sent to Manager!');
  } catch (e) {
    ctx.reply('Connection Error.');
    console.error(e);
  }
}

// Keep your Approve/Reject logic the same
bot.action(/^(app|rej)_(.+)$/, async (ctx) => {
  const action = ctx.match[1];
  const rowNum = ctx.match[2];
  try {
    await doc.loadInfo();
    const sheet = doc.sheetsByTitle['Pending_Expenses'];
    const rows = await sheet.getRows();
    const targetRow = rows.find(r => r.rowNumber == rowNum);
    if (action === 'app') {
      targetRow.Status = 'APPROVED';
      await targetRow.save();
      ctx.editMessageText(`✅ Approved: ${targetRow.Amount}`);
      bot.telegram.sendMessage(targetRow._StaffChatId, `✅ Approved: ${targetRow.Amount}`);
    } else {
      targetRow.Status = 'REJECTED';
      await targetRow.save();
      ctx.editMessageText(`❌ Rejected: ${targetRow.Amount}`);
      bot.telegram.sendMessage(targetRow._StaffChatId, `❌ Rejected: ${targetRow.Amount}`);
    }
  } catch (e) { console.error(e); }
});

bot.launch();
