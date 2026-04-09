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

// --- START COMMAND ---
bot.command(['start', 'new'], (ctx) => {
  const userId = ctx.from.id;
  userSessions[userId] = { step: 'CATEGORY' };
  ctx.reply('IELTS Zone Expense Pro 🎓\n\nStep 1: Choose a category:', 
    Markup.keyboard(categories, { columns: 2 }).oneTime().resize()
  );
});

// --- MANAGER REPORT COMMAND ---
bot.command('report', async (ctx) => {
  if (ctx.from.id.toString() !== MANAGER_ID) return ctx.reply('Unauthorized.');
  
  try {
    await doc.loadInfo();
    const sheet = doc.sheetsByTitle['Pending_Expenses'];
    const rows = await sheet.getRows();
    const approved = rows.filter(r => r.Status === 'APPROVED');
    const total = approved.reduce((sum, r) => sum + Number(r.Amount || 0), 0);
    
    ctx.reply(`📊 *IELTS Zone Spending Report*\n\n✅ Total Approved: *${total.toLocaleString()} UZS*\n📝 Approved Requests: ${approved.length}`, { parse_mode: 'Markdown' });
  } catch (e) { ctx.reply('Error generating report.'); }
});

// --- MESSAGE HANDLING ---
bot.on(['text', 'photo'], async (ctx) => {
  const userId = ctx.from.id;
  const session = userSessions[userId];
  if (!session) return;

  // STEP 1: CATEGORY
  if (session.step === 'CATEGORY') {
    if (categories.includes(ctx.message.text)) {
      session.category = ctx.message.text;
      session.step = 'AMOUNT';
      return ctx.reply(`Category: ${session.category}\n\nStep 2: Enter Amount:`);
    }
  }

  // STEP 2: AMOUNT
  if (session.step === 'AMOUNT') {
    const amt = ctx.message.text.replace(/[^0-9]/g, '');
    if (!amt) return ctx.reply('Please enter numbers only.');
    session.amount = amt;
    session.step = 'DESCRIPTION';
    return ctx.reply(`Amount: ${amt} UZS\n\nStep 3: What is this for?`);
  }

  // STEP 3: DESCRIPTION
  if (session.step === 'DESCRIPTION') {
    session.description = ctx.message.text;
    session.step = 'PHOTO';
    return ctx.reply('Step 4: Please send a photo of the receipt (or type "skip"):');
  }

  // STEP 4: PHOTO / FINAL SUBMISSION
  if (session.step === 'PHOTO') {
    session.receipt = ctx.message.photo ? 'Photo Attached' : 'No Photo';
    const { category, amount, description, receipt } = session;
    
    ctx.reply('Saving... ⏳');
    try {
      await doc.loadInfo();
      const sheet = doc.sheetsByTitle['Pending_Expenses'];
      const row = await sheet.addRow({
        'Timestamp': new Date().toLocaleString(),
        'Staff Name': ctx.from.first_name,
        'Amount': amount,
        'Description': `[${category}] ${description}`,
        'Status': 'PENDING',
        '_StaffChatId': userId.toString()
      });

      await bot.telegram.sendMessage(MANAGER_ID, 
        `💰 *New Request*\n👤 From: ${ctx.from.first_name}\n📂 Category: ${category}\n💵 Amount: ${amount} UZS\n📝 Reason: ${description}\n📸 Receipt: ${receipt}`, 
        {
          parse_mode: 'Markdown',
          ...Markup.inlineKeyboard([
            [Markup.button.callback('✅ Approve', `app_${row.rowNumber}`)],
            [Markup.button.callback('❌ Reject', `rej_${row.rowNumber}`)]
          ])
        }
      );
      ctx.reply('✅ Sent to Manager!');
      delete userSessions[userId];
    } catch (e) { ctx.reply('Error saving.'); console.error(e); }
  }
});

// --- APPROVE / REJECT ---
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
console.log('Expense Pro Active');
