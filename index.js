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

// 1. Staff clicks /start or /new_request
bot.command(['start', 'new_request'], (ctx) => {
  ctx.reply('Welcome to IELTS Zone Expense Bot! 🎓\n\nPlease choose a category:', 
    Markup.keyboard([
      ['🏠 Rent', '📢 Marketing'],
      ['💻 IT/Office', '☕️ Kitchen'],
      ['🎓 Teacher Salary', '🛠 Maintenance']
    ]).oneTime().resize()
  );
});

// 2. Logic to handle the text from those buttons
bot.on('text', async (ctx) => {
  const message = ctx.message.text;
  
  // If they used the /request command manually
  if (message.startsWith('/request')) {
    const parts = message.split(' ');
    if (parts.length < 3) return ctx.reply('Format: /request [Amount] [Description]');
    return processRequest(ctx, parts[1], parts.slice(2).join(' '));
  }

  // If they clicked a category button, ask for the amount
  if (['🏠 Rent', '📢 Marketing', '💻 IT/Office', '☕️ Kitchen', '🎓 Teacher Salary', '🛠 Maintenance'].includes(message)) {
    return ctx.reply(`You selected ${message}. Please send the amount and description in this format:\n\n[Amount] [Reason]\nExample: 50000 Lunch for staff`);
  }

  // Handle free-form text if it starts with a number (e.g. "50000 Rent")
  const parts = message.split(' ');
  if (!isNaN(parts[0])) {
    return processRequest(ctx, parts[0], parts.slice(1).join(' '));
  }
});

async function processRequest(ctx, amount, description) {
  const staffName = ctx.from.first_name || 'Staff';
  try {
    await doc.loadInfo();
    const sheet = doc.sheetsByTitle['Pending_Expenses']; 
    
    const row = await sheet.addRow({
      'Timestamp': new Date().toLocaleString('en-GB'),
      'Staff Name': staffName,
      'Amount': amount,
      'Description': description,
      'Status': 'PENDING',
      '_StaffChatId': ctx.from.id.toString()
    });

    // Notify Manager
    await bot.telegram.sendMessage(MANAGER_ID, 
      `💰 *New Expense Request*\n\nFrom: ${staffName}\nAmount: ${amount}\nReason: ${description}`, 
      {
        parse_mode: 'Markdown',
        ...Markup.inlineKeyboard([
          [Markup.button.callback('✅ Approve', `app_${row.rowNumber}`)],
          [Markup.button.callback('❌ Reject', `rej_${row.rowNumber}`)]
        ])
      }
    );

    ctx.reply('✅ Sent! Manager notified.');
  } catch (e) {
    ctx.reply('Error. Try again later.');
    console.error(e);
  }
}

// 3. Keep existing Approve/Reject logic
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
      ctx.editMessageText(`✅ You APPROVED ${targetRow.Amount}`);
      bot.telegram.sendMessage(targetRow._StaffChatId, `✅ Your request for ${targetRow.Amount} was APPROVED.`);
    } else {
      targetRow.Status = 'REJECTED';
      await targetRow.save();
      ctx.editMessageText(`❌ You REJECTED ${targetRow.Amount}`);
      bot.telegram.sendMessage(targetRow._StaffChatId, `❌ Your request for ${targetRow.Amount} was REJECTED.`);
    }
  } catch (e) { console.error(e); }
});

bot.launch();
console.log('Bot with buttons is Active');
