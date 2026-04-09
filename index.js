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

const showMainMenu = (ctx, text = 'Please choose a category:') => {
  return ctx.reply(text, 
    Markup.keyboard([...categories, '❌ Cancel'], { columns: 2 }).resize()
  );
};

bot.command(['start', 'new'], (ctx) => {
  userSessions[ctx.from.id] = { step: 'CATEGORY' };
  showMainMenu(ctx, 'IELTS Zone Expense Tracker 🎓');
});

bot.on('text', async (ctx) => {
  const userId = ctx.from.id;
  const text = ctx.message.text;

  if (text === '❌ Cancel') {
    userSessions[userId] = { step: 'CATEGORY' };
    return showMainMenu(ctx, 'Cancelled. Choose a new category:');
  }

  if (!userSessions[userId]) userSessions[userId] = { step: 'CATEGORY' };
  const session = userSessions[userId];

  // STEP 1: CATEGORY
  if (session.step === 'CATEGORY') {
    if (categories.includes(text)) {
      session.category = text;
      session.step = 'AMOUNT';
      return ctx.reply(`Selected: ${text}\n\nEnter Amount:`, Markup.keyboard(['❌ Cancel']).resize());
    }
    return showMainMenu(ctx);
  }

  // STEP 2: AMOUNT
  if (session.step === 'AMOUNT') {
    const amt = text.replace(/[^0-9]/g, '');
    if (!amt) return ctx.reply('Numbers only please.');
    session.amount = amt;
    session.step = 'DESCRIPTION';
    return ctx.reply('What is this for? (Description)');
  }

  // STEP 3: DESCRIPTION & SUBMIT (Photo step removed)
  if (session.step === 'DESCRIPTION') {
    session.description = text;
    ctx.reply('Saving... ⏳');
    
    try {
      await doc.loadInfo();
      const sheet = doc.sheetsByTitle['Pending_Expenses'];
      const row = await sheet.addRow({
        'Timestamp': new Date().toLocaleString(),
        'Staff Name': ctx.from.first_name || 'Staff',
        'Amount': session.amount,
        'Description': `[${session.category}] ${session.description}`,
        'Status': 'PENDING',
        '_StaffChatId': userId.toString()
      });

      await bot.telegram.sendMessage(MANAGER_ID, 
        `💰 *New Request*\n👤 From: ${ctx.from.first_name}\n📂 Category: ${session.category}\n💵 Amount: ${session.amount} UZS\n📝 Reason: ${session.description}`, 
        {
          parse_mode: 'Markdown',
          ...Markup.inlineKeyboard([
            [Markup.button.callback('✅ Approve', `app_${row.rowNumber}`)],
            [Markup.button.callback('❌ Reject', `rej_${row.rowNumber}`)]
          ])
        }
      );

      userSessions[userId] = { step: 'CATEGORY' };
      ctx.reply('✅ Sent to Manager!');
      return showMainMenu(ctx, 'Ready for next:');
    } catch (e) {
      console.error('Save Error:', e);
      ctx.reply('Error saving. Please try /start');
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

    if (!targetRow) return ctx.answerCbQuery('Error: Request not found.');

    const amount = targetRow.get('Amount') || '0';

    if (action === 'app') {
      targetRow.set('Status', 'APPROVED');
      await targetRow.save();
      await ctx.editMessageText(`✅ Approved: ${amount} UZS`).catch(() => {});
      bot.telegram.sendMessage(targetRow.get('_StaffChatId'), `✅ Your request for ${amount} UZS was APPROVED.`).catch(() => {});
    } else {
      targetRow.set('Status', 'REJECTED');
      await targetRow.save();
      await ctx.editMessageText(`❌ Rejected: ${amount} UZS`).catch(() => {});
      bot.telegram.sendMessage(targetRow.get('_StaffChatId'), `❌ Your request for ${amount} UZS was REJECTED.`).catch(() => {});
    }
  } catch (e) {
    console.error('Action Error:', e.message);
  }
});

bot.launch();
console.log('IELTS Zone Lean Bot Active');
// Add this command inside your code (before bot.launch)

bot.command('report', async (ctx) => {
  // Only allows the manager to see the report
  if (ctx.from.id.toString() !== MANAGER_ID) return ctx.reply('Unauthorized.');

  try {
    await doc.loadInfo();
    const sheet = doc.sheetsByTitle['Pending_Expenses'];
    const rows = await sheet.getRows();

    // Filter only Approved rows
    const approvedRows = rows.filter(r => r.get('Status') === 'APPROVED');
    
    // Calculate total
    const totalSpent = approvedRows.reduce((sum, r) => sum + Number(r.get('Amount') || 0), 0);

    // Group by category (pulling from the [Category] part of the description)
    const categoryTotals = {};
    approvedRows.forEach(r => {
      const desc = r.get('Description') || '';
      const category = desc.split(']')[0].replace('[', '') || 'Other';
      categoryTotals[category] = (categoryTotals[category] || 0) + Number(r.get('Amount') || 0);
    });

    let reportMsg = `📊 *IELTS Zone Spending Report*\n\n`;
    reportMsg += `✅ Total Approved: *${totalSpent.toLocaleString()} UZS*\n\n`;
    reportMsg += `*Breakdown by Category:*\n`;
    
    for (const [cat, amt] of Object.entries(categoryTotals)) {
      reportMsg += `• ${cat}: ${amt.toLocaleString()} UZS\n`;
    }

    ctx.reply(reportMsg, { parse_mode: 'Markdown' });

  } catch (e) {
    console.error(e);
    ctx.reply('Error generating report.');
  }
});
