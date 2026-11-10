/**
 * STS FINTECH PRIVATE LIMITED
 * Milestone 2 - Step 2: Backend Financial Intelligence Engine Verification Suite
 *
 * Verifies:
 * 1. Last 10 days analytics
 * 2. Last 30 days analytics
 * 3. Current month analytics
 * 4. Previous month comparison
 * 5. Yearly reports & comparisons
 * 6. Custom date range validation
 * 7. Empty financial history (graceful zero handling)
 * 8. Zero income calculation safety
 * 9. Income > Expenses (positive savings & rate)
 * 10. Expenses > Income (deficit detection)
 * 11. Multi-user data isolation (User A vs User B)
 * 12. Unauthorized access rejection (401)
 * 13. Zero duplicate counting between segregation and finance_records
 * 14. Consistency with /api/dashboard/summary
 */

const assert = require('assert');
const pool = require('../db');

const BASE_URL = 'http://localhost:5000';

// Cookie & CSRF jar for requests
class SessionClient {
  constructor(name) {
    this.name = name;
    this.cookies = '';
    this.csrfToken = '';
  }

  async fetch(url, options = {}) {
    const method = (options.method || 'GET').toUpperCase();
    if (['POST', 'PUT', 'DELETE', 'PATCH'].includes(method) && !this.csrfToken) {
      await this.refreshCsrf();
    }

    const headers = { ...(options.headers || {}) };
    if (this.cookies) headers['Cookie'] = this.cookies;
    if (this.csrfToken && ['POST', 'PUT', 'DELETE', 'PATCH'].includes(method)) {
      headers['X-CSRF-Token'] = this.csrfToken;
    }
    if (options.body && typeof options.body === 'object' && !(options.body instanceof String)) {
      headers['Content-Type'] = 'application/json';
      options.body = JSON.stringify(options.body);
    }

    const res = await fetch(`${BASE_URL}${url}`, { ...options, headers });

    const setCookie = res.headers.get('set-cookie');
    if (setCookie) {
      const parts = setCookie.split(',').map((c) => c.split(';')[0].trim());
      this.cookies = parts.join('; ');
    }

    return res;
  }

  async refreshCsrf() {
    const headers = {};
    if (this.cookies) headers['Cookie'] = this.cookies;
    const res = await fetch(`${BASE_URL}/api/auth/csrf`, { headers });
    const setCookie = res.headers.get('set-cookie');
    if (setCookie) {
      const parts = setCookie.split(',').map((c) => c.split(';')[0].trim());
      this.cookies = parts.join('; ');
    }
    const json = await res.json();
    this.csrfToken = json.csrfToken;
    return this.csrfToken;
  }

  async register(email, password, name) {
    await this.refreshCsrf();
    const res = await this.fetch('/api/auth/register', {
      method: 'POST',
      body: { email, password, name },
    });
    // Crucial: session ID was regenerated upon register, obtain fresh CSRF token for the authenticated session
    await this.refreshCsrf();
    return res;
  }

  async login(email, password) {
    await this.refreshCsrf();
    const res = await this.fetch('/api/auth/login', {
      method: 'POST',
      body: { email, password },
    });
    await this.refreshCsrf();
    return res;
  }
}

async function runTests() {
  console.log('========================================================================');
  console.log('🚀 STS FINTECH - MILESTONE 2: FINANCIAL INTELLIGENCE VERIFICATION SUITE');
  console.log('========================================================================\n');

  const timestamp = Date.now();
  const userAEmail = `m2_user_a_${timestamp}@stsfintech.com`;
  const userBEmail = `m2_user_b_${timestamp}@stsfintech.com`;
  const password = 'StrongPassword123!';

  const clientA = new SessionClient('User A');
  const clientB = new SessionClient('User B');
  const unauthClient = new SessionClient('Unauthenticated');

  try {
    // -------------------------------------------------------------------------
    // TEST 12: Unauthorized Requests Rejection
    // -------------------------------------------------------------------------
    console.log('▶ [TEST 12] Verifying Unauthorized Requests are strictly rejected (401)...');
    const unauthAnalytics = await unauthClient.fetch('/api/ai/analytics?period=30d');
    assert.strictEqual(unauthAnalytics.status, 401, 'Unauthenticated /api/ai/analytics must return 401');
    const unauthInsights = await unauthClient.fetch('/api/ai/insights');
    assert.strictEqual(unauthInsights.status, 401, 'Unauthenticated /api/ai/insights must return 401');
    console.log('  ✔ Unauthorized access correctly rejected with 401.\n');

    // -------------------------------------------------------------------------
    // Setup Users
    // -------------------------------------------------------------------------
    console.log('▶ Setting up test users User A and User B...');
    const regARes = await clientA.register(userAEmail, password, 'User A Analytics');
    assert.strictEqual(regARes.status, 201, 'User A registration must succeed');
    const userAData = (await regARes.json()).user;
    const userAId = userAData.id;

    const regBRes = await clientB.register(userBEmail, password, 'User B Fresh');
    assert.strictEqual(regBRes.status, 201, 'User B registration must succeed');
    console.log(`  ✔ User A (ID: ${userAId}) and User B registered successfully.\n`);

    // -------------------------------------------------------------------------
    // TEST 7: Empty Financial History
    // -------------------------------------------------------------------------
    console.log('▶ [TEST 7] Testing empty financial history (User B fresh ledger)...');
    const emptyRes = await clientB.fetch('/api/ai/analytics?period=30d');
    assert.strictEqual(emptyRes.status, 200, 'Empty ledger analytics must return 200');
    const emptyJson = await emptyRes.json();
    assert.strictEqual(emptyJson.summary.totalIncome, 0);
    assert.strictEqual(emptyJson.summary.totalExpenses, 0);
    assert.strictEqual(emptyJson.summary.totalSavings, 0);
    assert.strictEqual(emptyJson.summary.savingsRate, 0);
    assert.strictEqual(emptyJson.categories.length, 0);
    assert.ok(Array.isArray(emptyJson.insights));
    assert.ok(emptyJson.insights.some((i) => i.id === 'empty_ledger'));
    console.log('  ✔ Empty financial history returns safe defaults with 0s and no NaNs.\n');

    // -------------------------------------------------------------------------
    // Populate User A Financial Ledger
    // -------------------------------------------------------------------------
    console.log('▶ Populating User A with controlled financial ledger entries...');
    const today = new Date().toISOString().split('T')[0];
    const fiveDaysAgo = new Date(Date.now() - 5 * 86400000).toISOString().split('T')[0];
    const twentyDaysAgo = new Date(Date.now() - 20 * 86400000).toISOString().split('T')[0];

    // Income entries
    await clientA.fetch('/api/segregation', {
      method: 'POST',
      body: { type: 'fixed_income', name: 'Primary Salary', amount: 80000, category: 'Salary', date: twentyDaysAgo },
    });
    await clientA.fetch('/api/segregation', {
      method: 'POST',
      body: { type: 'additional_income', name: 'Consulting Gig', amount: 20000, category: 'Consulting', date: fiveDaysAgo },
    });

    // Expense entries
    await clientA.fetch('/api/segregation', {
      method: 'POST',
      body: { type: 'fixed_expense', name: 'House Rent', amount: 25000, category: 'Housing', date: twentyDaysAgo },
    });
    await clientA.fetch('/api/segregation', {
      method: 'POST',
      body: { type: 'additional_expense', name: 'Gourmet Dining', amount: 5000, category: 'Food & Dining', date: fiveDaysAgo },
    });
    await clientA.fetch('/api/segregation', {
      method: 'POST',
      body: { type: 'bill', name: 'Electricity Bill', amount: 3500, category: 'Utilities', date: today },
    });

    console.log('  ✔ User A: Total Income = ₹1,00,000 | Total Expenses = ₹33,500 | Net Savings = ₹66,500.\n');

    // -------------------------------------------------------------------------
    // TEST 13: Duplicate-Counting Protection Check
    // -------------------------------------------------------------------------
    console.log('▶ [TEST 13] Verifying no duplicate counting between segregation & finance_records...');
    const countSeg = await pool.query('SELECT COUNT(*) FROM segregation WHERE user_id = $1;', [userAId]);
    const countFin = await pool.query('SELECT COUNT(*) FROM finance_records WHERE user_id = $1;', [userAId]);
    assert.strictEqual(parseInt(countSeg.rows[0].count, 10), 5);
    assert.strictEqual(parseInt(countFin.rows[0].count, 10), 5);

    const a30d = await clientA.fetch('/api/ai/analytics?period=30d');
    const a30dJson = await a30d.json();
    assert.strictEqual(a30dJson.summary.totalIncome, 100000, 'Total income must NOT be duplicated to 200000');
    assert.strictEqual(a30dJson.summary.totalExpenses, 33500, 'Total expense must NOT be duplicated to 67000');
    assert.strictEqual(a30dJson.summary.totalTransactions, 5, 'Total transactions count must equal 5');
    console.log('  ✔ Zero duplicate counting verified: exactly 1x tally maintained.\n');

    // -------------------------------------------------------------------------
    // TEST 14: Existing Dashboard Summary Consistency
    // -------------------------------------------------------------------------
    console.log('▶ [TEST 14] Verifying consistency with /api/dashboard/summary...');
    const dashRes = await clientA.fetch('/api/dashboard/summary');
    const dashJson = await dashRes.json();
    assert.strictEqual(dashJson.data.totalIncome, a30dJson.summary.totalIncome);
    assert.strictEqual(dashJson.data.totalExpense, a30dJson.summary.totalExpenses);
    assert.strictEqual(dashJson.data.netBalance, a30dJson.summary.totalSavings);
    console.log('  ✔ Dashboard summary numbers match Financial Intelligence Engine precisely.\n');

    // -------------------------------------------------------------------------
    // TEST 1 & 2: Last 10 Days & Last 30 Days
    // -------------------------------------------------------------------------
    console.log('▶ [TEST 1 & 2] Testing 10d and 30d periods...');
    const a10d = await clientA.fetch('/api/ai/analytics?period=10d');
    const a10dJson = await a10d.json();
    assert.strictEqual(a10dJson.period, '10d');
    assert.strictEqual(a10dJson.summary.totalIncome, 20000, 'Only consulting income fell in last 10 days');
    assert.strictEqual(a10dJson.summary.totalExpenses, 8500, 'Food (5000) + Utilities (3500) = 8500 in last 10 days');
    assert.strictEqual(a10dJson.summary.totalSavings, 11500);
    assert.ok(a10dJson.dailyBreakdown.length > 0);
    assert.ok(a10dJson.categories.length > 0);
    assert.ok(a10dJson.highestSpendingDay);
    console.log('  ✔ 10d period calculations verified.\n');

    // -------------------------------------------------------------------------
    // TEST 3 & 4: Current Month & Previous Month Comparison
    // -------------------------------------------------------------------------
    console.log('▶ [TEST 3 & 4] Testing currentMonth and monthly comparison...');
    const mRes = await clientA.fetch('/api/ai/analytics?period=currentMonth');
    const mJson = await mRes.json();
    assert.strictEqual(mJson.period, 'currentMonth');
    assert.ok(mJson.summary.savingsRate > 0);

    const compRes = await clientA.fetch('/api/ai/comparison/monthly');
    const compJson = await compRes.json();
    assert.strictEqual(compRes.status, 200);
    assert.ok(compJson.data.currentPeriod);
    assert.ok(compJson.data.previousPeriod);
    assert.ok(compJson.data.comparison);
    console.log('  ✔ Current month and monthly comparisons verified.\n');

    // -------------------------------------------------------------------------
    // TEST 5: Yearly Analytics & Monthly Breakdown
    // -------------------------------------------------------------------------
    console.log('▶ [TEST 5] Testing yearly report and monthly breakdown...');
    const yRes = await clientA.fetch('/api/ai/analytics?period=yearly');
    const yJson = await yRes.json();
    assert.strictEqual(yJson.period, 'yearly');
    assert.strictEqual(yJson.summary.totalIncome, 100000);
    assert.strictEqual(yJson.summary.totalExpenses, 33500);

    const yCompRes = await clientA.fetch('/api/ai/comparison/yearly');
    const yCompJson = await yCompRes.json();
    assert.strictEqual(yCompRes.status, 200);
    assert.ok(Array.isArray(yCompJson.data.monthlyBreakdown));
    console.log('  ✔ Yearly analytics and monthly history breakdown verified.\n');

    // -------------------------------------------------------------------------
    // TEST 6: Custom Date Range & Validation
    // -------------------------------------------------------------------------
    console.log('▶ [TEST 6] Testing custom date range validation...');
    const customRes = await clientA.fetch(`/api/ai/analytics?period=custom&start_date=${twentyDaysAgo}&end_date=${today}`);
    const customJson = await customRes.json();
    assert.strictEqual(customJson.period, 'custom');
    assert.strictEqual(customJson.summary.totalIncome, 100000);

    // Invalid date formats
    const badDateRes = await clientA.fetch('/api/ai/analytics?period=custom&start_date=invalid&end_date=2026-11-10');
    assert.strictEqual(badDateRes.status, 400);

    // Inverted date range
    const invertedRes = await clientA.fetch(`/api/ai/analytics?period=custom&start_date=${today}&end_date=${twentyDaysAgo}`);
    assert.strictEqual(invertedRes.status, 400);
    console.log('  ✔ Custom date range and bounds enforcement verified.\n');

    // -------------------------------------------------------------------------
    // TEST 8, 9, 10: Statistical Insights & Deficit/Surplus Dynamics
    // -------------------------------------------------------------------------
    console.log('▶ [TEST 8, 9, 10] Testing statistical observations and surplus/deficit insights...');
    const insightsRes = await clientA.fetch('/api/ai/insights?period=30d');
    const insightsJson = await insightsRes.json();
    assert.strictEqual(insightsRes.status, 200);
    assert.ok(insightsJson.insights.length > 0);
    // User A has 66.5% savings rate -> healthy savings insight
    assert.ok(insightsJson.insights.some((i) => i.id === 'healthy_savings'));

    // Create User C with Deficit (Expenses > Income)
    const userCEmail = `m2_user_c_${timestamp}@stsfintech.com`;
    const clientC = new SessionClient('User C');
    await clientC.register(userCEmail, password, 'User C Deficit');
    await clientC.fetch('/api/segregation', {
      method: 'POST',
      body: { type: 'additional_income', name: 'Pocket Money', amount: 5000, category: 'Allowance', date: today },
    });
    await clientC.fetch('/api/segregation', {
      method: 'POST',
      body: { type: 'additional_expense', name: 'Smartphone EMI', amount: 18000, category: 'Gadgets', date: today },
    });
    const cInsightsRes = await clientC.fetch('/api/ai/insights?period=30d');
    const cInsightsJson = await cInsightsRes.json();
    assert.ok(cInsightsJson.insights.some((i) => i.id === 'deficit_alert'), 'Deficit alert must be triggered when Expenses > Income');
    console.log('  ✔ Deficit alert and healthy savings statistical insights verified.\n');

    // -------------------------------------------------------------------------
    // TEST 11: Multi-User Isolation Guarantee
    // -------------------------------------------------------------------------
    console.log('▶ [TEST 11] Verifying multi-user data isolation...');
    const bAnalytics = await clientB.fetch('/api/ai/analytics?period=30d');
    const bJson = await bAnalytics.json();
    assert.strictEqual(bJson.summary.totalIncome, 0, 'User B must see zero of User A or User C records');
    assert.strictEqual(bJson.summary.totalExpenses, 0);
    console.log('  ✔ Complete data isolation confirmed across all test users.\n');

    console.log('========================================================================');
    console.log('🎉 ALL 14 FINANCIAL INTELLIGENCE ENGINE TESTS PASSED 100% SUCCESSFULLY!');
    console.log('========================================================================');
  } finally {
    // Clean up test users
    console.log('\n🧹 Cleaning up temporary test data...');
    try {
      await pool.query(
        `DELETE FROM segregation WHERE user_id IN (SELECT id FROM users WHERE email LIKE 'm2_user_%');`
      );
      await pool.query(
        `DELETE FROM finance_records WHERE user_id IN (SELECT id FROM users WHERE email LIKE 'm2_user_%');`
      );
      await pool.query(
        `DELETE FROM users WHERE email LIKE 'm2_user_%';`
      );
      console.log('  ✔ Temporary test data cleaned up cleanly.');
    } catch (cleanErr) {
      console.warn('Cleanup warning:', cleanErr.message);
    }
  }
}

runTests()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('\n❌ TEST RUN FAILED:', err);
    process.exit(1);
  });
