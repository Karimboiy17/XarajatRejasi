const { Telegraf, Markup } = require('telegraf');
const { JWT } = require('google-auth-library');
const { GoogleSpreadsheet } = require('google-spreadsheet');

const bot = new Telegraf(process.env.BOT_TOKEN);
const SHEET_ID = process.env.SHEET_ID;
const MANAGER_ID = process.env.MANAGER_CHAT_ID;

const serviceAccountAuth = new JWT({
  email: process.env.GCP_CLIENT_EMAIL,
  key: process.env.GCP_PRIVATE_KEY.replace(/\\n/g, '\n'),
  scopes: ['https://www.googleapis.com/auth/spreadsheets'],
});

const doc = new GoogleSpreadsheet(SHEET_ID, serviceAccountAuth);

bot.command('request', async (ctx) => {
  const text = ctx.message.text.split(' ');
  if (text.length < 3) return ctx.reply('Format: /request [Amount] [Description]');

  const amount = text[1];
  const description = text.slice(2).join(' ');
  const staffName = ctx.from.first_name;

  try {
    await doc.loadInfo();
    // MATCHING YOUR TAB NAME IN THE PHOTO
    const sheet = doc.sheetsByTitle['Pending_Expenses']; 
    
    // MATCHING YOUR HEADERS IN THE PHOTO
    const row = await sheet.addRow({
      Timestamp: new Date().toLocaleString(),
      'Staff Name': staffName,
      Amount: amount,
      Description: description,
      Status: 'PENDING',
      _StaffChatId: ctx.from.id
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
    ctx.reply('Error connecting to sheet. Check sharing permissions.');
    console.log(e);
  }
});

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
    console.log(e);
  }
});

bot.launch();
console.log('Bot is live!');
