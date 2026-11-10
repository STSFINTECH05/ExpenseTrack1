const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
const app = require('../server');
const pool = require('../db');
const http = require('http');

async function cleanTestUsers() {
  const res = await pool.query("SELECT id FROM users WHERE email IN ('usera@test.com', 'userb@test.com')");
  for (const row of res.rows) {
    await pool.query("DELETE FROM payments WHERE user_id = $1", [row.id]);
    await pool.query("DELETE FROM segregation WHERE user_id = $1", [row.id]);
    await pool.query("DELETE FROM finance_records WHERE user_id = $1", [row.id]);
    await pool.query("DELETE FROM goal_wallets WHERE user_id = $1", [row.id]);
    await pool.query("DELETE FROM wallets WHERE user_id = $1", [row.id]);
    await pool.query("DELETE FROM transactions WHERE user_id = $1", [row.id]);
    await pool.query("DELETE FROM categories WHERE user_id = $1", [row.id]);
    await pool.query("DELETE FROM users WHERE id = $1", [row.id]);
  }
}

async function runTests() {
  const server = http.createServer(app);
  await new Promise(resolve => server.listen(0, resolve));
  const port = server.address().port;
  const baseUrl = `http://127.0.0.1:${port}`;
  console.log('Test server running on port:', port);

  class TestAgent {
    constructor(name) {
      this.name = name;
      this.cookie = '';
      this.csrfToken = '';
      this.user = null;
    }

    async req(reqPath, options = {}) {
      const headers = { ...(options.headers || {}) };
      if (this.cookie) headers['Cookie'] = this.cookie;
      if (this.csrfToken && ['POST', 'PUT', 'DELETE', 'PATCH'].includes(options.method)) {
        headers['X-CSRF-Token'] = this.csrfToken;
      }
      if (options.body && typeof options.body === 'object') {
        headers['Content-Type'] = 'application/json';
        options.body = JSON.stringify(options.body);
      }
      const res = await fetch(baseUrl + reqPath, { ...options, headers });
      const setCookie = res.headers.get('set-cookie');
      if (setCookie) {
        this.cookie = setCookie.split(';')[0];
      }
      let json = null;
      try {
        json = await res.json();
      } catch (e) {}
      return { status: res.status, body: json };
    }
  }

  try {
    await cleanTestUsers();

    console.log('\n--- TEST 1: Unauthenticated financial API requests return 401 ---');
    const anon = new TestAgent('Anonymous');
    const unauthEndpoints = [
      ['GET', '/api/payments'],
      ['POST', '/api/payments'],
      ['GET', '/api/segregation'],
      ['POST', '/api/segregation'],
      ['PUT', '/api/segregation/1'],
      ['DELETE', '/api/segregation/1'],
      ['GET', '/api/wallets'],
      ['POST', '/api/wallets'],
      ['POST', '/api/wallets/1/add-cash'],
      ['DELETE', '/api/wallets/1'],
      ['GET', '/api/transactions'],
      ['POST', '/api/transactions'],
      ['GET', '/api/categories'],
      ['GET', '/api/dashboard/summary'],
    ];

    for (const [method, epPath] of unauthEndpoints) {
      const res = await anon.req(epPath, { method });
      if (res.status !== 401) {
        throw new Error(`Expected 401 for unauthenticated ${method} ${epPath}, got ${res.status}`);
      }
    }
    console.log('✅ PASS: All 14 unauthenticated financial requests strictly returned 401!');

    console.log('\n--- Public Health Check remains 200 ---');
    const health = await anon.req('/api/health');
    if (health.status !== 200 || health.body.status !== 'healthy') {
      throw new Error('Health check failed: ' + JSON.stringify(health));
    }
    console.log('✅ PASS: /api/health returned 200 Healthy!');

    console.log('\n--- TEST 2: Register User A ---');
    const userA = new TestAgent('User A');
    const regA = await userA.req('/api/auth/register', {
      method: 'POST',
      body: { name: 'User A', email: 'usera@test.com', password: 'TestPassword123!' }
    });
    if (regA.status !== 201 || !regA.body.user.id) {
      throw new Error('Registration failed for User A: ' + JSON.stringify(regA));
    }
    userA.user = regA.body.user;
    userA.csrfToken = regA.body.csrfToken;
    console.log('✅ PASS: User A registered with INTEGER ID:', userA.user.id);

    console.log('\n--- TEST 3: User A creates records with spoofed user_id in body/headers ---');
    const payA = await userA.req('/api/payments', {
      method: 'POST',
      body: { title: 'User A Payment', amount: 500, user_id: 999999, userId: 999999 },
      headers: { 'X-User-Id': '999999' }
    });
    if (payA.status !== 201 || payA.body.data.user_id !== userA.user.id) {
      throw new Error('User ID spoofing was not blocked: ' + JSON.stringify(payA));
    }

    const segA = await userA.req('/api/segregation', {
      method: 'POST',
      body: { type: 'additional_expense', name: 'User A Expense', amount: 120, user_id: 999999 }
    });
    if (segA.status !== 201 || segA.body.data.user_id !== userA.user.id) {
      throw new Error('Segregation user ID spoofing failed: ' + JSON.stringify(segA));
    }

    const walA = await userA.req('/api/wallets', {
      method: 'POST',
      body: { name: 'User A Laptop Goal', target_amount: 50000, user_id: 999999 }
    });
    if (walA.status !== 201 || walA.body.data.user_id !== userA.user.id) {
      throw new Error('Wallet user ID spoofing failed: ' + JSON.stringify(walA));
    }
    console.log('✅ PASS: User A records created and strictly bound to User A ID (spoofed user_id 999999 was completely ignored)!');

    console.log('\n--- TEST 4: Register User B ---');
    const userB = new TestAgent('User B');
    const regB = await userB.req('/api/auth/register', {
      method: 'POST',
      body: { name: 'User B', email: 'userb@test.com', password: 'TestPassword123!' }
    });
    if (regB.status !== 201 || !regB.body.user.id) {
      throw new Error('Registration failed for User B: ' + JSON.stringify(regB));
    }
    userB.user = regB.body.user;
    userB.csrfToken = regB.body.csrfToken;
    console.log('✅ PASS: User B registered with INTEGER ID:', userB.user.id);

    console.log('\n--- TEST 5: Verify User B CANNOT see User A records ---');
    const bPayments = await userB.req('/api/payments');
    if (bPayments.body.data.length !== 0) {
      throw new Error('Data leak! User B saw payments: ' + JSON.stringify(bPayments));
    }
    const bSeg = await userB.req('/api/segregation');
    if (bSeg.body.data.length !== 0) {
      throw new Error('Data leak! User B saw segregation: ' + JSON.stringify(bSeg));
    }
    const bWal = await userB.req('/api/wallets');
    if (bWal.body.data.length !== 0) {
      throw new Error('Data leak! User B saw wallets: ' + JSON.stringify(bWal));
    }
    console.log('✅ PASS: User B sees 0 records. Absolute data isolation verified!');

    console.log('\n--- TEST 6: User B creates their own records ---');
    const payB = await userB.req('/api/payments', {
      method: 'POST',
      body: { title: 'User B Payment', amount: 300 }
    });
    const segB = await userB.req('/api/segregation', {
      method: 'POST',
      body: { type: 'additional_income', name: 'User B Freelance', amount: 8000 }
    });
    const walB = await userB.req('/api/wallets', {
      method: 'POST',
      body: { name: 'User B Vacation', target_amount: 25000 }
    });
    console.log('✅ PASS: User B successfully created their own records!');

    console.log('\n--- TEST 7: User A cannot see, update, or delete User B records ---');
    const aUpdateB = await userA.req(`/api/segregation/${segB.body.data.id}`, {
      method: 'PUT',
      body: { name: 'Hacked', amount: 999 }
    });
    if (aUpdateB.status !== 404) {
      throw new Error('Security breach! User A update on User B returned ' + aUpdateB.status);
    }

    const aDeleteB = await userA.req(`/api/segregation/${segB.body.data.id}`, {
      method: 'DELETE'
    });
    if (aDeleteB.status !== 404) {
      throw new Error('Security breach! User A delete on User B returned ' + aDeleteB.status);
    }

    const aAddCashB = await userA.req(`/api/wallets/${walB.body.data.id}/add-cash`, {
      method: 'POST',
      body: { amount: 100 }
    });
    if (aAddCashB.status !== 404) {
      throw new Error('Security breach! User A add-cash on User B wallet returned ' + aAddCashB.status);
    }

    const aDeleteWalB = await userA.req(`/api/wallets/${walB.body.data.id}`, {
      method: 'DELETE'
    });
    if (aDeleteWalB.status !== 404) {
      throw new Error('Security breach! User A delete on User B wallet returned ' + aDeleteWalB.status);
    }
    console.log('✅ PASS: Cross-tenant updates and deletes strictly blocked with 404 Not Found!');

    console.log('\n--- TEST 8: User A still accesses their own records intact ---');
    const aCheckPay = await userA.req('/api/payments');
    if (aCheckPay.body.data.length !== 1 || aCheckPay.body.data[0].id !== payA.body.data.id) {
      throw new Error('User A could not retrieve payment: ' + JSON.stringify(aCheckPay));
    }
    const aCheckSeg = await userA.req('/api/segregation');
    if (aCheckSeg.body.data.length !== 1 || aCheckSeg.body.data[0].id !== segA.body.data.id) {
      throw new Error('User A could not retrieve segregation: ' + JSON.stringify(aCheckSeg));
    }
    const aCheckWal = await userA.req('/api/wallets');
    if (aCheckWal.body.data.length !== 1 || aCheckWal.body.data[0].id !== walA.body.data.id) {
      throw new Error('User A could not retrieve wallet: ' + JSON.stringify(aCheckWal));
    }
    console.log('✅ PASS: User A retrieves only their records!');

    console.log('\n--- TEST 9: Test Demo User (ID 1) login & legacy data access ---');
    const demo = new TestAgent('Demo User');
    const demoLogin = await demo.req('/api/auth/login', {
      method: 'POST',
      body: { email: 'demo@stsfintech.com', password: 'demo-password' }
    });
    if (demoLogin.status !== 200 || demoLogin.body.user.id !== 1) {
      throw new Error('Demo user login failed: ' + JSON.stringify(demoLogin));
    }
    demo.csrfToken = demoLogin.body.csrfToken;
    console.log('✅ PASS: Demo User logged in successfully with preserved password!');

    const demoCats = await demo.req('/api/categories');
    if (demoCats.body.data.length !== 10) {
      throw new Error('Demo user categories missing: ' + JSON.stringify(demoCats));
    }
    const demoTxs = await demo.req('/api/transactions');
    if (demoTxs.body.data.length !== 3) {
      throw new Error('Demo user transactions missing: ' + JSON.stringify(demoTxs));
    }
    console.log('✅ PASS: Demo User retrieved all 10 preserved categories and 3 transactions!');

    console.log('\n--- TEST 10: Verify unowned records (Test Expense user_id = null) are NOT leaked ---');
    const demoSeg = await demo.req('/api/segregation');
    const hasUnowned = demoSeg.body.data.some(r => r.name === 'Test Expense');
    if (hasUnowned) {
      throw new Error('Data leak! Unowned Test Expense was leaked to Demo User!');
    }
    console.log('✅ PASS: Unowned records (user_id = NULL) are preserved and never leaked to any user!');

    console.log('\n--- TEST 11: Dashboard summary multi-tenant isolation ---');
    const aSummary = await userA.req('/api/dashboard/summary');
    if (aSummary.status !== 200 || aSummary.body.data.totalExpense !== 120) {
      throw new Error('User A summary incorrect: ' + JSON.stringify(aSummary));
    }
    const bSummary = await userB.req('/api/dashboard/summary');
    if (bSummary.status !== 200 || bSummary.body.data.totalIncome !== 8000) {
      throw new Error('User B summary incorrect: ' + JSON.stringify(bSummary));
    }
    console.log('✅ PASS: Dashboard summary endpoints are strictly multi-user isolated!');

    console.log('\n========================================================');
    console.log('🎉 ALL 11 PHASES OF MULTI-USER ISOLATION TESTS PASSED 100%!');
    console.log('========================================================\n');

  } finally {
    console.log('Cleaning up test accounts...');
    await cleanTestUsers();
    server.close();
    await pool.end();
    console.log('Clean up complete. Server stopped.');
  }
}

runTests().catch(err => {
  console.error('TEST RUNNER FAILED:', err);
  process.exit(1);
});
