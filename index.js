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
const categories = ['🏠 Rent', '📢 Marketing', '💻 IT/Office', '☕️ Kitchen', '🎓 Teacher Salary', '🛠 Maintenance'];

// Helper to show the main menu
const showMainMenu = (ctx, text = 'Welcome back! Please choose a category to start:') => {
  return ctx.reply(text, 
    Markup.keyboard([...categories, '❌ Cancel'], { columns: 2 }).resize()
  );
};

bot.command(['start', 'new'], (ctx) => {
  const userId = ctx.from.id;
  userSessions[userId] = { step: 'CATEGORY' };
  showMainMenu(ctx, 'IELTS Zone Expense Tracker 🎓\n\nChoose a category:');
});

bot.on(['text', 'photo'], async (ctx) => {
  const userId = ctx.from.id;
  const text = ctx.message.text;

  // 1. If they hit Cancel, reset everything
  if (text === '❌ Cancel') {
    userSessions[userId] = { step: 'CATEGORY' };
    return showMainMenu(ctx, 'Request cancelled. Ready for a new one:');
  }

  // 2. If no session exists, start one automatically
  if (!userSessions[userId]) {
    userSessions[userId] = { step: 'CATEGORY' };
  }

  const session = userSessions[userId];

  // STEP 1: CATEGORY
  if (session.step === 'CATEGORY') {
    if (categories.includes(text)) {
      session.category = text;
      session.step = 'AMOUNT';
      return ctx.reply(`Category: ${text}\n\nStep 2: Enter Amount (numbers only):`, Markup.keyboard(['❌ Cancel']).resize());
    }
    return showMainMenu(ctx, 'Please choose a category from the buttons below:');
  }

  // STEP 2: AMOUNT
  if (session.step === 'AMOUNT') {
    const amt = text.replace(/[^0-9]/g, '');
    if (!amt) return ctx.reply('Please enter numbers only.');
    session.amount = amt;
    session.step = 'DESCRIPTION';
    return ctx.reply(`Amount: ${amt} UZS\n\nStep 3: What is this for?`);
  }

  // STEP 3: DESCRIPTION
  if (session.step === 'DESCRIPTION') {
    session.description = text;
    session.step = 'PHOTO';
    return ctx.reply('Step 4: Send a photo of the receipt or type "skip":');
  }

  // STEP 4: PHOTO & SUBMIT
  if (session.step === 'PHOTO') {
    session.receipt = ctx.message.photo ? 'Photo Attached' : 'No Photo';
    ctx.reply('Processing... ⏳');
    
    try {
      await doc.loadInfo();
      const sheet = doc.sheetsByTitle['Pending_Expenses'];
      const row = await sheet.addRow({
        'Timestamp': new Date().toLocaleString(),
        'Staff Name': ctx.from.first_name,
        'Amount': session.amount,
        'Description': `[${session.category}] ${session.description}`,
        'Status': 'PENDING',
        '_StaffChatId': userId.toString()
      });

      await bot.telegram.sendMessage(MANAGER_ID, 
        `💰 *New Request*\n👤 From: ${ctx.from.first_name}\n📂 Category: ${session.category}\n💵 Amount: ${session.amount} UZS\n📝 Reason: ${session.description}\n📸 Receipt: ${session.receipt}`, 
        {
          parse_mode: 'Markdown',
          ...Markup.inlineKeyboard([
            [Markup.button.callback('✅ Approve', `app_${row.rowNumber}`)],
            [Markup.button.callback('❌ Reject', `rej_${row.rowNumber}`)]
          ])
        }
      );

      // RESET SESSION AUTOMATICALLY
      userSessions[userId] = { step: 'CATEGORY' };
      ctx.reply('✅ Sent to Manager!');
      return showMainMenu(ctx, 'Ready for your next request:');

    } catch (e) {
      ctx.reply('Error saving. Try /start');
      console.error(e);
    }
  }
});

// Manager Actions
bot.action(/^(app|rej)_(.+)$/, async (ctx) => {
  const [action, rowNum] = [ctx.match[1], ctx.match[2]];
  try {
    await doc.loadInfo();
    const sheet = doc.sheetsByTitle['Pending_Expenses'];
    const rows = await sheet.getRows();
    const targetRow = rows.find(r => r.rowNumber == rowNum);
    if (action === 'app') {
      targetRow.Status = 'APPROVED';
      await targetRow.save();
      ctx.editMessageText(`✅ Approved: ${targetRow.Amount} UZS`);
      bot.telegram.sendMessage(targetRow._StaffChatId, `✅ Approved: ${targetRow.Amount} UZS`);
    } else {
      targetRow.Status = 'REJECTED';
      await targetRow.save();
      ctx.editMessageText(`❌ Rejected: ${targetRow.Amount} UZS`);
      bot.telegram.sendMessage(targetRow._StaffChatId, `❌ Rejected: ${targetRow.Amount} UZS`);
    }
  } catch (e) { console.error(e); }
});

bot.launch();
