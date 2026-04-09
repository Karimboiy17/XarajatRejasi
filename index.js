const { Telegraf, Markup } = require('telegraf');
const { JWT } = require('google-auth-library');
const { GoogleSpreadsheet } = require('google-spreadsheet');

// 1. Config
const bot = new Telegraf(process.env.BOT_TOKEN);
const SHEET_ID = process.env.SHEET_ID;
const MANAGER_ID = process.env.MANAGER_CHAT_ID;

// Safely parse the full JSON block from Railway
const creds = JSON.parse(process.env.GCP_SERVICE_ACCOUNT);

const serviceAccountAuth = new JWT({
  email: creds.client_email,
  key: creds.private_key,
  scopes: ['https://www.googleapis.com/auth/spreadsheets'],
});

const doc = new GoogleSpreadsheet(SHEET_ID, serviceAccountAuth);

// 2. Request Command
bot.command('request', async (ctx) => {
  const text = ctx.message.text.split(' ');
  if (text.length < 3) return ctx.reply('Format: /request [Amount] [Description]');

  const amount = text[1];
  const description = text.slice(2).join(' ');
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

    ctx.reply('✅ Your request has been sent to the manager for approval.');
  } catch (e) {
    ctx.reply('Connection Error. Check if the bot email is shared on the sheet.');
    console.error(e);
  }
});

// 3. Manager Actions
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
  } catch (e) {
    console.error(e);
  }
});

bot.launch();
console.log('IELTS Zone Bot is ACTIVE');
