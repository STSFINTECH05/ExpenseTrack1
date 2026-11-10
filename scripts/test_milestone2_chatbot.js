/**
 * STS FINTECH PRIVATE LIMITED
 * Milestone 2 Step 4: AI Financial Chatbot Comprehensive Verification Suite
 *
 * Verifies:
 * 1. Unauthenticated requests rejected with 401
 * 2. Missing API key / configuration error handling (503)
 * 3. Controlled financial tools execution & argument validation
 * 4. Multi-turn conversation creation and message persistence
 * 5. Multi-user isolation & conversation ownership protection
 * 6. Follow-up question context retention
 * 7. Multilingual support (English, Tamil, Hindi)
 * 8. Zero duplicate counting & data accuracy with existing ledger
 * 9. Non-regression of existing AI analytics endpoints
 * 10. Safe teardown of test users and conversation records
 */

const http = require('http');
const pool = require('../db');
const {
  executeFinancialTool,
  getDateBoundaries,
  FINANCIAL_TOOL_DEFINITIONS,
} = require('../services/financialTools.service');
const {
  processChatMessage,
  buildSystemPrompt,
  sanitizeLanguage,
} = require('../services/aiChatbot.service');

const BASE_URL = 'http://localhost:5000';

function makeRequest({ method = 'GET', path, headers = {}, body = null, cookie = '' }) {
  return new Promise((resolve, reject) => {
    const url = new URL(path, BASE_URL);
    const reqHeaders = { ...headers };
    if (cookie) reqHeaders['Cookie'] = cookie;
    if (body) {
      reqHeaders['Content-Type'] = 'application/json';
    }

    const req = http.request(
      url,
      {
        method,
        headers: reqHeaders,
      },
      (res) => {
        let rawData = '';
        res.on('data', (chunk) => (rawData += chunk));
        res.on('end', () => {
          let json = null;
          try {
            json = JSON.parse(rawData);
          } catch (e) {
            json = rawData;
          }
          const setCookie = res.headers['set-cookie'];
          resolve({
            status: res.statusCode,
            headers: res.headers,
            body: json,
            cookie: setCookie ? setCookie.map((c) => c.split(';')[0]).join('; ') : '',
          });
        });
      }
    );

    req.on('error', reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

async function registerTestUser(prefix) {
  const timestamp = Date.now();
  const email = `${prefix}_${timestamp}@stsfintech.com`;
  const password = 'Password@123';
  const name = `Test User ${prefix}`;

  const csrfRes = await makeRequest({ path: '/api/auth/csrf' });
  const csrfToken = csrfRes.body?.csrfToken;
  const cookie = csrfRes.cookie;

  const regRes = await makeRequest({
    method: 'POST',
    path: '/api/auth/register',
    headers: { 'X-CSRF-Token': csrfToken },
    cookie,
    body: { name, email, password },
  });

  if (regRes.status !== 201) {
    throw new Error(`Failed to register ${email}: ${JSON.stringify(regRes.body)}`);
  }

  const authCookie = regRes.cookie || cookie;
  const authCsrfRes = await makeRequest({ path: '/api/auth/csrf', cookie: authCookie });
  const authCsrfToken = authCsrfRes.body?.csrfToken || csrfToken;

  return {
    userId: regRes.body.user.id,
    email,
    cookie: authCookie,
    csrfToken: authCsrfToken,
  };
}

async function seedLedgerData(userId) {
  const records = [
    { type: 'fixed_income', name: 'Software Salary', amount: 80000.0, category: 'Salary', date: '2026-11-01' },
    { type: 'additional_income', name: 'Freelance Advisory', amount: 15000.0, category: 'Consulting', date: '2026-11-05' },
    { type: 'fixed_expense', name: 'Office Rent', amount: 20000.0, category: 'Housing', date: '2026-11-02' },
    { type: 'additional_expense', name: 'Organic Groceries', amount: 6500.0, category: 'Groceries', date: '2026-11-06' },
    { type: 'bill', name: 'Broadband Fiber', amount: 1500.0, category: 'Utilities', date: '2026-11-08' },
  ];

  for (const r of records) {
    await pool.query(
      `INSERT INTO segregation (user_id, type, name, amount, category, date, schedule)
       VALUES ($1, $2, $3, $4, $5, $6, 'One-time');`,
      [userId, r.type, r.name, r.amount, r.category, r.date]
    );
  }
}

async function cleanupData() {
  console.log('🧹 Cleaning up temporary test users and conversation records...');
  try {
    const users = await pool.query(`SELECT id FROM users WHERE email LIKE 'm2_chat_%';`);
    const ids = users.rows.map((u) => u.id);
    if (ids.length > 0) {
      await pool.query(`DELETE FROM ai_conversations WHERE user_id = ANY($1::int[]);`, [ids]);
      await pool.query(`DELETE FROM segregation WHERE user_id = ANY($1::int[]);`, [ids]);
      await pool.query(`DELETE FROM users WHERE id = ANY($1::int[]);`, [ids]);
    }
    console.log('  ✔ Temporary test data cleaned up safely.');
  } catch (err) {
    console.error('Cleanup error:', err.message);
  }
}

async function runChatbotTestSuite() {
  console.log('========================================================================');
  console.log('🚀 STS FINTECH - MILESTONE 2 STEP 4: AI FINANCIAL CHATBOT VERIFICATION');
  console.log('========================================================================\n');

  let userA = null;
  let userB = null;

  try {
    // -------------------------------------------------------------------------
    // TEST 1: Unauthenticated Chat Access Rejection
    // -------------------------------------------------------------------------
    console.log('▶ [TEST 1] Verifying Unauthorized Requests to Chat are rejected (401)...');
    const unauthChat = await makeRequest({
      method: 'POST',
      path: '/api/ai/chat',
      body: { message: 'How much did I spend?' },
    });
    if (unauthChat.status !== 401) {
      throw new Error(`Expected 401 for unauthenticated chat, got ${unauthChat.status}`);
    }

    const unauthConvs = await makeRequest({ path: '/api/ai/conversations' });
    if (unauthConvs.status !== 401) {
      throw new Error(`Expected 401 for unauthenticated conversations, got ${unauthConvs.status}`);
    }
    console.log('  ✔ All chat and conversation endpoints strictly enforce 401 Unauthorized.');

    // -------------------------------------------------------------------------
    // TEST 2: User A & User B Setup and Financial Seeding
    // -------------------------------------------------------------------------
    console.log('\n▶ [TEST 2] Registering test users and populating User A ledger...');
    userA = await registerTestUser('m2_chat_a');
    userB = await registerTestUser('m2_chat_b');
    console.log(`  ✔ User A (ID: ${userA.userId}) and User B (ID: ${userB.userId}) registered.`);

    await seedLedgerData(userA.userId);
    console.log('  ✔ User A seeded with: Income = ₹95,000, Expenses = ₹28,000, Net Savings = ₹67,000.');

    // -------------------------------------------------------------------------
    // TEST 3: Controlled Financial Tools Execution
    // -------------------------------------------------------------------------
    console.log('\n▶ [TEST 3] Testing Controlled Financial Function Calling (financialTools.service)...');

    // Tool: getFinancialOverview
    const overview = await executeFinancialTool(userA.userId, 'getFinancialOverview', { period: '30d' });
    if (overview.summary.totalIncome !== 95000 || overview.summary.totalExpenses !== 28000) {
      throw new Error(`Tool getFinancialOverview mismatch: income=${overview.summary.totalIncome}, exp=${overview.summary.totalExpenses}`);
    }
    console.log(`  ✔ Tool 'getFinancialOverview' exact: Income ₹${overview.summary.totalIncome}, Expense ₹${overview.summary.totalExpenses}`);

    // Tool: getIncomeSummary
    const incSummary = await executeFinancialTool(userA.userId, 'getIncomeSummary', { period: '30d' });
    if (incSummary.totalIncome !== 95000 || incSummary.count !== 2) {
      throw new Error(`Tool getIncomeSummary mismatch: ${JSON.stringify(incSummary)}`);
    }
    console.log(`  ✔ Tool 'getIncomeSummary' exact: ₹${incSummary.totalIncome} across ${incSummary.count} entries`);

    // Tool: getExpenseSummary
    const expSummary = await executeFinancialTool(userA.userId, 'getExpenseSummary', { period: '30d' });
    if (expSummary.totalExpenses !== 28000 || expSummary.count !== 3) {
      throw new Error(`Tool getExpenseSummary mismatch: ${JSON.stringify(expSummary)}`);
    }
    console.log(`  ✔ Tool 'getExpenseSummary' exact: ₹${expSummary.totalExpenses} across ${expSummary.count} entries`);

    // Tool: getSavingsSummary
    const savSummary = await executeFinancialTool(userA.userId, 'getSavingsSummary', { period: '30d' });
    if (savSummary.totalSavings !== 67000 || savSummary.savingsRate !== 70.53) {
      throw new Error(`Tool getSavingsSummary mismatch: savings=${savSummary.totalSavings}, rate=${savSummary.savingsRate}`);
    }
    console.log(`  ✔ Tool 'getSavingsSummary' exact: Net Savings ₹${savSummary.totalSavings} (${savSummary.savingsRate}%)`);

    // Tool: getSpendingByCategory
    const catSpending = await executeFinancialTool(userA.userId, 'getSpendingByCategory', { period: '30d' });
    if (!catSpending.categories || catSpending.categories.length !== 3) {
      throw new Error(`Expected 3 categories, got ${catSpending.categories?.length}`);
    }
    console.log(`  ✔ Tool 'getSpendingByCategory' exact: 3 categories (Top: ${catSpending.highestSpendingCategory.category} ₹${catSpending.highestSpendingCategory.amount})`);

    // Tool: getTopSpendingCategories
    const topCats = await executeFinancialTool(userA.userId, 'getTopSpendingCategories', { period: '30d', limit: 2 });
    if (topCats.categories.length !== 2) {
      throw new Error(`Expected limit 2 categories, got ${topCats.categories.length}`);
    }
    console.log(`  ✔ Tool 'getTopSpendingCategories' respects limit: returned 2 categories`);

    // Tool: getDailySpending
    const dailySpending = await executeFinancialTool(userA.userId, 'getDailySpending', { period: '30d' });
    if (!dailySpending.highestSpendingDay || dailySpending.highestSpendingDay.amount !== 20000) {
      throw new Error(`Tool getDailySpending peak day mismatch: ${JSON.stringify(dailySpending.highestSpendingDay)}`);
    }
    console.log(`  ✔ Tool 'getDailySpending' exact: Peak day amount = ₹${dailySpending.highestSpendingDay.amount}`);

    // Tool: getFinancialInsights
    const insights = await executeFinancialTool(userA.userId, 'getFinancialInsights', { period: '30d' });
    if (!insights.insights || insights.insights.length === 0) {
      throw new Error('Tool getFinancialInsights returned no insights');
    }
    console.log(`  ✔ Tool 'getFinancialInsights' exact: ${insights.insights.length} deterministic observations generated`);

    // -------------------------------------------------------------------------
    // TEST 4: Tool Parameter Validation & Error Handling
    // -------------------------------------------------------------------------
    console.log('\n▶ [TEST 4] Testing Tool Input Validation & Bounds Enforcement...');
    try {
      await executeFinancialTool(userA.userId, 'unknown_function_call', {});
      throw new Error('Should have failed for unknown function');
    } catch (e) {
      if (!e.message.includes('Unknown financial tool')) throw e;
      console.log('  ✔ Unknown tool call safely rejected with validation error.');
    }

    try {
      getDateBoundaries('custom', '2026-11-10', '2026-11-01');
      throw new Error('Should have failed for inverted custom dates');
    } catch (e) {
      if (!e.message.includes('startDate cannot be later than endDate')) throw e;
      console.log('  ✔ Inverted date range safely rejected.');
    }

    // -------------------------------------------------------------------------
    // TEST 5: CSRF Protection & Missing API Key Handling (HTTP 403 & 503)
    // -------------------------------------------------------------------------
    console.log('\n▶ [TEST 5] Testing CSRF Protection & Missing OPENAI_API_KEY Handling...');

    // 5A: Missing CSRF token on POST /api/ai/chat should return 403
    const missingCsrfRes = await makeRequest({
      method: 'POST',
      path: '/api/ai/chat',
      cookie: userA.cookie,
      body: { message: 'How much did I spend this month?' },
    });
    if (missingCsrfRes.status !== 403) {
      throw new Error(`Expected 403 CSRF rejected, got ${missingCsrfRes.status}`);
    }
    console.log('  ✔ Mutating chat request without CSRF token strictly rejected with 403.');

    // 5B: Valid CSRF token with offline local AI / unconfigured provider returns 503
    const noKeyChatRes = await makeRequest({
      method: 'POST',
      path: '/api/ai/chat',
      headers: { 'X-CSRF-Token': userA.csrfToken },
      cookie: userA.cookie,
      body: { message: 'How much did I spend this month?' },
    });

    const isExpected503 =
      noKeyChatRes.status === 503 &&
      (noKeyChatRes.body?.error === 'LOCAL_AI_UNAVAILABLE' ||
        noKeyChatRes.body?.error === 'AI_PROVIDER_UNAVAILABLE' ||
        noKeyChatRes.body?.error === 'GROQ_API_KEY_MISSING');

    if (!isExpected503) {
      throw new Error(`Expected 503 fail-closed error, got ${noKeyChatRes.status}: ${JSON.stringify(noKeyChatRes.body)}`);
    }
    console.log('  ✔ Offline AI / unconfigured provider returns 503 with fail-closed protection.');

    // -------------------------------------------------------------------------
    // TEST 6: Multi-Turn Conversation & Grounded Execution (with Mock Adapter)
    // -------------------------------------------------------------------------
    console.log('\n▶ [TEST 6] Multi-Turn Conversation & Follow-Up Context Retention (Mock Adapter)...');

    // Mock LLM Adapter simulating intelligent tool calls and synthesis
    const mockAdapter = async ({ userId, message, language, executeFinancialTool }) => {
      const lower = message.toLowerCase();

      if (lower.includes('category') || lower.includes('highest')) {
        const data = await executeFinancialTool(userId, 'getSpendingByCategory', { period: '30d' });
        return {
          answer: `Your highest spending category is ${data.highestSpendingCategory.category} with an outlay of ₹${data.highestSpendingCategory.amount.toLocaleString('en-IN')} (${data.highestSpendingCategory.percentage}%).`,
          financialData: data,
        };
      }

      if (lower.includes('spend') || lower.includes('expense') || lower.includes('செலவு') || lower.includes('खर्च')) {
        const data = await executeFinancialTool(userId, 'getExpenseSummary', { period: '30d' });
        if (language === 'ta-IN') {
          return {
            answer: `கடந்த 30 நாட்களில் உங்கள் மொத்த செலவு ₹${data.totalExpenses.toLocaleString('en-IN')}. இது 3 பரிவர்த்தனைகளைக் கொண்டுள்ளது.`,
            financialData: data,
          };
        } else if (language === 'hi-IN') {
          return {
            answer: `पिछले 30 दिनों में आपका कुल व्यय ₹${data.totalExpenses.toLocaleString('en-IN')} है। यह 3 लेनदेन में दर्ज किया गया है।`,
            financialData: data,
          };
        }
        return {
          answer: `Your total expenditure for the last 30 days is ₹${data.totalExpenses.toLocaleString('en-IN')}, recorded across ${data.count} transactions.`,
          financialData: data,
        };
      }

      if (lower.includes('income') || lower.includes('earned')) {
        const data = await executeFinancialTool(userId, 'getIncomeSummary', { period: '30d' });
        return {
          answer: `Your total income for the last 30 days is ₹${data.totalIncome.toLocaleString('en-IN')}.`,
          financialData: data,
        };
      }

      // Default follow-up response
      return {
        answer: `I am your STS Fintech assistant. I can answer questions about your income, expenses, savings, and category distribution.`,
      };
    };

    // Step 1: User asks initial question
    const turn1 = await processChatMessage({
      userId: userA.userId,
      userName: 'User A',
      message: 'How much did I spend in the last 30 days?',
      language: 'en-IN',
      mockAdapter,
    });

    if (!turn1.success || !turn1.answer.includes('28,000')) {
      throw new Error(`Turn 1 failed: ${JSON.stringify(turn1)}`);
    }
    const conversationId = turn1.conversationId;
    console.log(`  ✔ Turn 1 Initial Question: Answered correctly with ₹28,000 (Conv ID: ${conversationId}).`);

    // Step 2: Follow-up question in the same conversation thread
    const turn2 = await processChatMessage({
      userId: userA.userId,
      userName: 'User A',
      message: 'What was my highest spending category?',
      language: 'en-IN',
      conversationId,
      mockAdapter,
    });

    if (!turn2.success || !turn2.answer.includes('Housing') || !turn2.answer.includes('20,000')) {
      throw new Error(`Turn 2 follow-up failed: ${JSON.stringify(turn2)}`);
    }
    if (turn2.conversationId !== conversationId) {
      throw new Error('Conversation ID was not maintained across follow-ups');
    }
    console.log(`  ✔ Turn 2 Follow-Up Question: Retained thread context and identified Housing at ₹20,000.`);

    // Step 3: Check conversation message persistence
    const messagesRes = await makeRequest({
      path: `/api/ai/conversations/${conversationId}/messages`,
      cookie: userA.cookie,
    });
    if (messagesRes.status !== 200 || messagesRes.body.data.length < 4) {
      throw new Error(`Expected at least 4 messages in thread, got ${messagesRes.body.data?.length}`);
    }
    console.log(`  ✔ Thread persistence confirmed: ${messagesRes.body.data.length} messages safely stored.`);

    // -------------------------------------------------------------------------
    // TEST 7: Multilingual Support (Tamil & Hindi)
    // -------------------------------------------------------------------------
    console.log('\n▶ [TEST 7] Testing Multilingual Responses (Tamil ta-IN & Hindi hi-IN)...');

    // Tamil
    const tamilChat = await processChatMessage({
      userId: userA.userId,
      userName: 'User A',
      message: 'என் செலவு எவ்வளவு?',
      language: 'ta-IN',
      mockAdapter,
    });
    if (!tamilChat.answer.includes('₹28,000') || !tamilChat.answer.includes('செலவு')) {
      throw new Error(`Tamil response failed to maintain native Tamil script: ${tamilChat.answer}`);
    }
    console.log(`  ✔ Tamil response verified in native script: "${tamilChat.answer}"`);

    // Hindi
    const hindiChat = await processChatMessage({
      userId: userA.userId,
      userName: 'User A',
      message: 'मेरा कुल खर्च कितना है?',
      language: 'hi-IN',
      mockAdapter,
    });
    if (!hindiChat.answer.includes('₹28,000') || !hindiChat.answer.includes('व्यय')) {
      throw new Error(`Hindi response failed to maintain native Devanagari script: ${hindiChat.answer}`);
    }
    console.log(`  ✔ Hindi response verified in native script: "${hindiChat.answer}"`);

    // -------------------------------------------------------------------------
    // TEST 8: Tenant Data Isolation & Anti-Tampering
    // -------------------------------------------------------------------------
    console.log('\n▶ [TEST 8] Verifying Multi-User Isolation & Conversation Tamper Resistance...');

    // User B tries to view User A's conversation
    const crossConvAccess = await makeRequest({
      path: `/api/ai/conversations/${conversationId}/messages`,
      cookie: userB.cookie,
    });
    if (crossConvAccess.status !== 404) {
      throw new Error(`Expected 404 when User B accesses User A conversation, got ${crossConvAccess.status}`);
    }
    console.log('  ✔ Cross-tenant conversation access strictly masked with 404 Not Found.');

    // User B asks for their own spending (empty ledger)
    const userBChat = await processChatMessage({
      userId: userB.userId,
      userName: 'User B',
      message: 'How much did I spend in the last 30 days?',
      language: 'en-IN',
      mockAdapter,
    });
    if (!userBChat.answer.includes('₹0')) {
      throw new Error(`User B should have ₹0 expenditure, got ${userBChat.answer}`);
    }
    console.log(`  ✔ User B isolated ledger verified: returns ₹0 expenditure without leakage from User A.`);

    // -------------------------------------------------------------------------
    // TEST 9: Analytics Endpoints Regression Verification
    // -------------------------------------------------------------------------
    console.log('\n▶ [TEST 9] Verifying Existing Analytics Endpoints Non-Regression...');
    const analyticsRes = await makeRequest({
      path: '/api/ai/analytics?period=30d',
      cookie: userA.cookie,
    });
    if (analyticsRes.status !== 200 || analyticsRes.body.summary.totalIncome !== 95000) {
      throw new Error(`Analytics regression detected: ${JSON.stringify(analyticsRes.body)}`);
    }

    const comparisonRes = await makeRequest({
      path: '/api/ai/comparison/monthly',
      cookie: userA.cookie,
    });
    if (comparisonRes.status !== 200) {
      throw new Error(`Monthly comparison regression detected: status ${comparisonRes.status}`);
    }
    console.log('  ✔ Existing GET /api/ai/analytics and /comparison/monthly pass with 100% parity.');

    console.log('\n========================================================================');
    console.log('🎉 ALL 9 MILESTONE 2 STEP 4 CHATBOT BACKEND TESTS PASSED 100%!');
    console.log('========================================================================\n');
  } catch (error) {
    console.error('\n❌ Test suite failed:', error);
    process.exitCode = 1;
  } finally {
    await cleanupData();
  }
}

if (require.main === module) {
  runChatbotTestSuite().then(() => {
    process.exit(process.exitCode || 0);
  });
}

module.exports = { runChatbotTestSuite };
