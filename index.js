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

const userSessions = {};
const categories = ['🏠 Rent', '📢 Marketing', '💻 IT/Office', '☕️ Kitchen', '🎓 Teacher Salary', '🛠 Maintenance'];

bot.command(['start', 'new'], (ctx) => {
  const userId = ctx.from.id;
  userSessions[userId] = { step: 'CATEGORY' };
  
  ctx.reply('Welcome to IELTS Zone Expense Bot! 🎓\n\nStep 1: Choose a category:', 
    Markup.keyboard(categories, { columns: 2 }).oneTime().resize()
  );
});

bot.on('text', async (ctx) => {
  const userId = ctx.from.id;
  const text = ctx.message.text;

  if (!userSessions[userId]) return;

  const session = userSessions[userId];

  if (session.step === 'CATEGORY') {
    if (categories.includes(text)) {
      session.category = text;
      session.step = 'AMOUNT';
      return ctx.reply(`${text} selected.\n\nStep 2: Enter the amount (numbers only):`, Markup.removeKeyboard());
    }
    return ctx.reply('Please choose a category from the buttons.');
  }

  if (session.step === 'AMOUNT') {
    const amount = text.replace(/[^0-9]/g, ''); 
    if (!amount) return ctx.reply('Please enter numbers only (e.g. 50000).');
    session.amount = amount;
    session.step = 'DESCRIPTION';
    return ctx.reply(`Amount: ${amount} UZS.\n\nStep 3: What is this for? (Description)`);
  }

  if (session.step === 'DESCRIPTION') {
    session.description = text;
    const { category, amount, description } = session;
    ctx.reply('Sending request... ⏳');
    
    try {
      await doc.loadInfo();
      const sheet = doc.sheetsByTitle['Pending_Expenses']; 
      const row = await sheet.addRow({
        'Timestamp': new Date().toLocaleString(),
        'Staff Name': ctx.from.first_name || 'Staff',
        'Amount': amount,
        'Description': `[${category}] ${description}`,
        'Status': 'PENDING',
        '_StaffChatId': userId.toString()
      });

      await bot.telegram.sendMessage(MANAGER_ID, 
        `💰 *New Expense Request*\n\n👤 *From:* ${ctx.from.first_name}\n📂 *Category:* ${category}\n💵 *Amount:* ${amount} UZS\n📝 *Reason:* ${description}`, 
        {
          parse_mode: 'Markdown',
          ...Markup.inlineKeyboard([
            [Markup.button.callback('✅ Approve', `app_${row.rowNumber}`)],
            [Markup.button.callback('❌ Reject', `rej_${row.rowNumber}`)]
          ])
        }
      );

      ctx.reply('✅ Request sent to manager!');
      delete userSessions[userId]; 
    } catch (e) {
      ctx.reply('Error connecting to the system.');
      console.error(e);
    }
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
