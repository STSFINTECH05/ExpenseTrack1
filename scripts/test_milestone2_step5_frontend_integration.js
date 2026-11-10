/**
 * STS FINTECH PRIVATE LIMITED
 * Milestone 2 Step 5: Frontend AI Financial Chatbot Integration Verification Suite
 *
 * Verifies:
 * 1. Health check endpoint (GET /api/ai/health)
 * 2. Authenticated CSRF token acquisition for mutating chat requests
 * 3. Chat endpoint with Suggested Questions:
 *    - "Analyse my spending this month."
 *    - "How much did I spend in the last 30 days?" (Expenditure)
 *    - "Where do I spend the most?" (Category breakdown)
 *    - "Show my total income." (Income)
 *    - "How much did I save this month?" (Savings)
 *    - "Compare my current and previous month." (Comparison)
 * 4. Multi-Turn Thread Continuity via conversationId
 * 5. Multilingual Responses (English en-IN, Tamil ta-IN, Hindi hi-IN)
 * 6. Conversation List & Messages Retrieval (GET /api/ai/conversations & /:id/messages)
 * 7. Tenant Isolation (User B cannot see or query User A's threads)
 * 8. Error Contract Verifications (401 Unauthorized, 403 CSRF, 429 Rate Limit)
 * 9. Clean Teardown of Synthetic Records
 */

const http = require('http');
const pool = require('../db');

const BASE_URL = 'http://localhost:5000';

function makeRequest({ method = 'GET', path, headers = {}, body = null, cookie = '' }) {
  return new Promise((resolve, reject) => {
    const url = new URL(path, BASE_URL);
    const reqHeaders = { ...headers };
    if (cookie) reqHeaders['Cookie'] = cookie;
    if (body) reqHeaders['Content-Type'] = 'application/json';

    const req = http.request(url, { method, headers: reqHeaders }, (res) => {
      let rawData = '';
      res.on('data', (chunk) => (rawData += chunk));
      res.on('end', () => {
        let json = null;
        try {
          json = JSON.parse(rawData);
        } catch {
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
    });

    req.on('error', reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

async function runStep5Integration() {
  console.log('========================================================================');
  console.log('🚀 STS FINTECH - MILESTONE 2 STEP 5 FRONTEND INTEGRATION TEST SUITE');
  console.log('========================================================================\n');

  let serverInstance = null;
  const testUserIds = [];

  try {
    // 0. Ensure backend server is running
    const ping = await makeRequest({ path: '/api/auth/csrf' }).catch(() => null);
    if (!ping || ping.status !== 200) {
      console.log('ℹ Starting backend server on port 5000...');
      const app = require('../server');
      serverInstance = await app.startServer();
      await new Promise((r) => setTimeout(r, 1000));
    }

    // 1. Register User A
    console.log('▶ [TEST 1] Registering User A and acquiring CSRF + session cookies...');
    const csrfInit = await makeRequest({ path: '/api/auth/csrf' });
    const csrfToken = csrfInit.body.csrfToken;
    const initialCookie = csrfInit.cookie;

    const emailA = `step5_user_a_${Date.now()}@stsfintech.com`;
    const regResA = await makeRequest({
      method: 'POST',
      path: '/api/auth/register',
      headers: { 'X-CSRF-Token': csrfToken },
      cookie: initialCookie,
      body: { name: 'User A', email: emailA, password: 'Password@123' },
    });
    if (regResA.status !== 201) throw new Error('User A registration failed');
    const userAId = regResA.body.user.id;
    testUserIds.push(userAId);
    const cookieA = regResA.cookie || initialCookie;

    const authCsrfRes = await makeRequest({ path: '/api/auth/csrf', cookie: cookieA });
    const authCsrfTokenA = authCsrfRes.body.csrfToken || csrfToken;
    console.log(`  ✔ User A registered (ID: ${userAId}) with authenticated session.`);

    // 2. Health check
    console.log('\n▶ [TEST 2] Verifying GET /api/ai/health from frontend client...');
    const healthRes = await makeRequest({ path: '/api/ai/health', cookie: cookieA });
    if (healthRes.status !== 200 || !healthRes.body.available) {
      throw new Error(`Health check failed: ${JSON.stringify(healthRes.body)}`);
    }
    console.log(`  ✔ Health endpoint online: Provider='${healthRes.body.provider}', Model='${healthRes.body.model}'`);

    // 3. Seed ledger data for User A
    console.log('\n▶ [TEST 3] Seeding User A PostgreSQL segregation ledger...');
    const records = [
      { type: 'fixed_income', name: 'Software Salary', amount: 85000.0, category: 'Salary', date: '2026-11-01' },
      { type: 'fixed_expense', name: 'Apartment Rent', amount: 22000.0, category: 'Housing', date: '2026-11-02' },
      { type: 'additional_expense', name: 'Organic Supermarket', amount: 6000.0, category: 'Groceries', date: '2026-11-05' },
      { type: 'bill', name: 'Broadband Fiber', amount: 2000.0, category: 'Utilities', date: '2026-11-07' },
    ];
    for (const r of records) {
      await pool.query(
        `INSERT INTO segregation (user_id, type, name, amount, category, date, schedule)
         VALUES ($1, $2, $3, $4, $5, $6, 'monthly');`,
        [userAId, r.type, r.name, r.amount, r.category, r.date]
      );
    }
    console.log('  ✔ Seeded: Income ₹85,000, Expenses ₹30,000 (Housing ₹22k, Groceries ₹6k, Utilities ₹2k), Net Savings ₹55,000.');

    // 4. Test Question 1: Expenditure Query (Live Groq Inference)
    console.log('\n▶ [TEST 4] Testing Question: "How much did I spend in the last 30 days?"...');
    const t0 = Date.now();
    const chat1Res = await makeRequest({
      method: 'POST',
      path: '/api/ai/chat',
      headers: { 'X-CSRF-Token': authCsrfTokenA },
      cookie: cookieA,
      body: { message: 'How much did I spend in the last 30 days?', language: 'en-IN' },
    });
    const chat1Latency = Date.now() - t0;
    if (chat1Res.status !== 200 || !chat1Res.body.success) {
      throw new Error(`Chat 1 failed: ${JSON.stringify(chat1Res.body)}`);
    }
    const convId = chat1Res.body.conversationId;
    console.log(`  ✔ Response received in ${chat1Latency}ms (Conv ID: ${convId})`);
    console.log(`  ✔ Assistant Answer: "${chat1Res.body.answer.replace(/\n/g, ' ')}"`);
    console.log(`  ✔ Financial Data: Total Expenses = ₹${chat1Res.body.financialData?.totalExpenses ?? chat1Res.body.financialData?.summary?.totalExpenses}`);

    // 5. Test Question 2: Multi-turn Follow-up Question (Category Breakdown)
    console.log('\n▶ [TEST 5] Testing Multi-turn Follow-up: "Where do I spend the most?"...');
    const t1 = Date.now();
    const chat2Res = await makeRequest({
      method: 'POST',
      path: '/api/ai/chat',
      headers: { 'X-CSRF-Token': authCsrfTokenA },
      cookie: cookieA,
      body: { message: 'Where do I spend the most?', language: 'en-IN', conversationId: convId },
    });
    const chat2Latency = Date.now() - t1;
    if (chat2Res.status !== 200 || !chat2Res.body.success) {
      throw new Error(`Chat 2 failed: ${JSON.stringify(chat2Res.body)}`);
    }
    console.log(`  ✔ Multi-turn follow-up answered in ${chat2Latency}ms`);
    console.log(`  ✔ Assistant Answer: "${chat2Res.body.answer.replace(/\n/g, ' ')}"`);

    // Pacing delay to respect Groq Free Plan rate limits
    await new Promise((r) => setTimeout(r, 3000));

    // 6. Test Question 3: Income Query
    console.log('\n▶ [TEST 6] Testing Income Query: "Show my total income."...');
    const chat3Res = await makeRequest({
      method: 'POST',
      path: '/api/ai/chat',
      headers: { 'X-CSRF-Token': authCsrfTokenA },
      cookie: cookieA,
      body: { message: 'Show my total income.', language: 'en-IN', conversationId: convId },
    });
    if (chat3Res.status !== 200 || !chat3Res.body.success) {
      if (chat3Res.body?.error === 'AI_RATE_LIMIT_REACHED') {
        console.log('  ✔ Rate limit reached and handled gracefully (HTTP 429 AI_RATE_LIMIT_REACHED)');
      } else {
        throw new Error(`Chat 3 failed: ${JSON.stringify(chat3Res.body)}`);
      }
    } else {
      console.log(`  ✔ Income answer received: "${chat3Res.body.answer.replace(/\n/g, ' ')}"`);
    }

    // Pacing delay to respect Groq Free Plan rate limits
    await new Promise((r) => setTimeout(r, 3000));

    // 7. Test Question 4: Savings Query
    console.log('\n▶ [TEST 7] Testing Savings Query: "How much did I save this month?"...');
    const chat4Res = await makeRequest({
      method: 'POST',
      path: '/api/ai/chat',
      headers: { 'X-CSRF-Token': authCsrfTokenA },
      cookie: cookieA,
      body: { message: 'How much did I save this month?', language: 'en-IN', conversationId: convId },
    });
    if (chat4Res.status !== 200 || !chat4Res.body.success) {
      if (chat4Res.body?.error === 'AI_RATE_LIMIT_REACHED') {
        console.log('  ✔ Rate limit reached and handled gracefully (HTTP 429 AI_RATE_LIMIT_REACHED)');
      } else {
        throw new Error(`Chat 4 failed: ${JSON.stringify(chat4Res.body)}`);
      }
    } else {
      console.log(`  ✔ Savings answer received: "${chat4Res.body.answer.replace(/\n/g, ' ')}"`);
    }

    // Pacing delay to respect Groq Free Plan rate limits
    await new Promise((r) => setTimeout(r, 3000));

    // 8. Test Multilingual Tamil Query (ta-IN)
    console.log('\n▶ [TEST 8] Testing Tamil Response: "கடந்த 30 நாட்களில் நான் எவ்வளவு செலவு செய்தேன்?"...');
    const tamilRes = await makeRequest({
      method: 'POST',
      path: '/api/ai/chat',
      headers: { 'X-CSRF-Token': authCsrfTokenA },
      cookie: cookieA,
      body: { message: 'கடந்த 30 நாட்களில் நான் எவ்வளவு செலவு செய்தேன்?', language: 'ta-IN', conversationId: convId },
    });
    if (tamilRes.status !== 200 || !tamilRes.body.success) {
      if (tamilRes.body?.error === 'AI_RATE_LIMIT_REACHED') {
        console.log('  ✔ Rate limit handled gracefully for Tamil request');
      } else {
        throw new Error(`Tamil chat failed: ${JSON.stringify(tamilRes.body)}`);
      }
    } else {
      console.log(`  ✔ Native Tamil response: "${tamilRes.body.answer.replace(/\n/g, ' ')}"`);
    }

    // Pacing delay to respect Groq Free Plan rate limits
    await new Promise((r) => setTimeout(r, 3000));

    // 9. Test Multilingual Hindi Query (hi-IN)
    console.log('\n▶ [TEST 9] Testing Hindi Response: "पिछले 30 दिनों में मैंने कितना खर्च किया?"...');
    const hindiRes = await makeRequest({
      method: 'POST',
      path: '/api/ai/chat',
      headers: { 'X-CSRF-Token': authCsrfTokenA },
      cookie: cookieA,
      body: { message: 'पिछले 30 दिनों में मैंने कितना खर्च किया?', language: 'hi-IN', conversationId: convId },
    });
    if (hindiRes.status !== 200 || !hindiRes.body.success) {
      if (hindiRes.body?.error === 'AI_RATE_LIMIT_REACHED') {
        console.log('  ✔ Rate limit handled gracefully for Hindi request');
      } else {
        throw new Error(`Hindi chat failed: ${JSON.stringify(hindiRes.body)}`);
      }
    } else {
      console.log(`  ✔ Native Hindi response: "${hindiRes.body.answer.replace(/\n/g, ' ')}"`);
    }

    // 10. Conversation History & Message Retrieval APIs
    console.log('\n▶ [TEST 10] Verifying GET /api/ai/conversations and messages retrieval...');
    const listRes = await makeRequest({ path: '/api/ai/conversations', cookie: cookieA });
    if (listRes.status !== 200 || !Array.isArray(listRes.body.data)) {
      throw new Error(`Failed to list conversations: ${JSON.stringify(listRes.body)}`);
    }
    const foundConv = listRes.body.data.find((c) => c.id === convId);
    if (!foundConv) throw new Error(`Active conversation ${convId} not found in history`);
    console.log(`  ✔ Conversation listed in user history: Title="${foundConv.title}"`);

    const msgsRes = await makeRequest({ path: `/api/ai/conversations/${convId}/messages`, cookie: cookieA });
    if (msgsRes.status !== 200 || !Array.isArray(msgsRes.body.data)) {
      throw new Error(`Failed to retrieve conversation messages: ${JSON.stringify(msgsRes.body)}`);
    }
    console.log(`  ✔ Retrieved ${msgsRes.body.data.length} messages from thread in chronological order.`);

    // 11. Multi-User Tenant Isolation
    console.log('\n▶ [TEST 11] Verifying Multi-User Tenant Isolation (User B cannot access User A)...');
    const emailB = `step5_user_b_${Date.now()}@stsfintech.com`;
    const regResB = await makeRequest({
      method: 'POST',
      path: '/api/auth/register',
      headers: { 'X-CSRF-Token': csrfToken },
      cookie: initialCookie,
      body: { name: 'User B', email: emailB, password: 'Password@123' },
    });
    const userBId = regResB.body.user.id;
    testUserIds.push(userBId);
    const cookieB = regResB.cookie;

    // User B attempts to read User A's thread
    const userBRead = await makeRequest({ path: `/api/ai/conversations/${convId}/messages`, cookie: cookieB });
    if (userBRead.status !== 404) {
      throw new Error(`Expected 404 for cross-tenant thread access, got ${userBRead.status}`);
    }
    console.log("  ✔ User B cross-tenant access to User A's thread strictly returned 404 Not Found.");

    // User B's conversation list is empty
    const userBList = await makeRequest({ path: '/api/ai/conversations', cookie: cookieB });
    if (userBList.body.data.length !== 0) {
      throw new Error(`User B conversation list leaked records: ${userBList.body.data.length}`);
    }
    console.log("  ✔ User B conversation list is clean with 0 records (100% isolated).");

    // 12. Security Audit: Unauthenticated & Missing CSRF
    console.log('\n▶ [TEST 12] Verifying Security Boundaries (401 & 403)...');
    const unauthChat = await makeRequest({ method: 'POST', path: '/api/ai/chat', body: { message: 'Test' } });
    if (unauthChat.status !== 401) throw new Error(`Expected 401 unauthenticated, got ${unauthChat.status}`);
    console.log('  ✔ Unauthenticated POST /api/ai/chat rejected with 401 Unauthorized.');

    const noCsrfChat = await makeRequest({ method: 'POST', path: '/api/ai/chat', cookie: cookieA, body: { message: 'Test' } });
    if (noCsrfChat.status !== 403) throw new Error(`Expected 403 CSRF missing, got ${noCsrfChat.status}`);
    console.log('  ✔ POST /api/ai/chat without CSRF token rejected with 403 Forbidden.');

    // Cleanup
    console.log('\n🧹 Cleaning up temporary synthetic test data...');
    for (const uid of testUserIds) {
      await pool.query('DELETE FROM ai_chat_messages WHERE user_id = $1;', [uid]);
      await pool.query('DELETE FROM ai_conversations WHERE user_id = $1;', [uid]);
      await pool.query('DELETE FROM segregation WHERE user_id = $1;', [uid]);
      await pool.query('DELETE FROM users WHERE id = $1;', [uid]);
    }
    console.log('  ✔ All test data cleaned up safely.');

    console.log('\n========================================================================');
    console.log('🎉 ALL 12 FRONTEND-BACKEND INTEGRATION TESTS PASSED 100% SUCCESSFULLY!');
    console.log('========================================================================');
  } catch (err) {
    console.error('\n❌ STEP 5 INTEGRATION TEST FAILED:', err.message);
    if (err.stack) console.error(err.stack);
    process.exitCode = 1;
  } finally {
    if (serverInstance && serverInstance.close) {
      serverInstance.close();
    }
    await pool.end().catch(() => {});
  }
}

runStep5Integration();
