const { Telegraf, Markup } = require('telegraf');
const { JWT } = require('google-auth-library');
const { GoogleSpreadsheet } = require('google-spreadsheet');

// 1. Configuration (Railway fills these)
const bot = new Telegraf(process.env.BOT_TOKEN);
const SHEET_ID = process.env.SHEET_ID;
const MANAGER_ID = process.env.MANAGER_CHAT_ID;

const serviceAccountAuth = new JWT({
  email: process.env.GCP_CLIENT_EMAIL,
  key: process.env.GCP_PRIVATE_KEY.replace(/\\n/g, '\n'),
  scopes: ['https://www.googleapis.com/auth/spreadsheets'],
});

const doc = new GoogleSpreadsheet(SHEET_ID, serviceAccountAuth);

// 2. Staff sends a request: /request [Amount] [Description]
bot.command('request', async (ctx) => {
  const text = ctx.message.text.split(' ');
  if (text.length < 3) return ctx.reply('Format: /request [Amount] [Description]');

  const amount = text[1];
  const description = text.slice(2).join(' ');
  const staffName = ctx.from.first_name;

  try {
    await doc.loadInfo();
    // MATCHING YOUR NEW SHEET NAME
    const sheet = doc.sheetsByTitle['Expense Register']; 
    
    // Adding row using the column headers from your Dashboard Script
    const row = await sheet.addRow({
      'Date': new Date().toLocaleDateString('en-GB'),
      'Branch': 'Central', // Defaulting to Central
      'Expense Category': 'General',
      'Amount (UZS)': amount,
      'Requested By': staffName,
      'Status': 'Pending',
      'Notes': description
    });

    // Notify Manager (You)
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
    ctx.reply('Error connecting to sheet. Make sure the bot email is shared as Editor.');
    console.log(e);
  }
});

// 3. Manager clicks Approve/Reject
bot.action(/^(app|rej)_(.+)$/, async (ctx) => {
  const action = ctx.match[1];
  const rowNum = ctx.match[2];

  try {
    await doc.loadInfo();
    const sheet = doc.sheetsByTitle['Expense Register'];
    const rows = await sheet.getRows();
    
    // Find row (accounting for header offset)
    const targetRow = rows.find(r => r.rowNumber == rowNum);

    if (!targetRow) return ctx.reply('Could not find that row.');

    if (action === 'app') {
      targetRow.Status = 'Approved';
      targetRow['Approved By'] = 'Karim X.'; // Your name
      await targetRow.save();
      
      ctx.editMessageText(`✅ You APPROVED the expense of ${targetRow['Amount (UZS)']}`);
    } else {
      targetRow.Status = 'Rejected';
      await targetRow.save();
      ctx.editMessageText(`❌ You REJECTED the expense of ${targetRow['Amount (UZS)']}`);
    }
  } catch (e) {
    console.log(e);
    ctx.reply('Error processing approval.');
  }
});

bot.launch();
console.log('Bot is running...');
