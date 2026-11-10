/**
 * Phase 3 Verification Test Suite
 * Tests Frontend Authentication & Backend Session Integration (Tests A through F)
 */

const http = require('http');

const BASE_URL = 'http://localhost:5000';

class SessionClient {
  constructor() {
    this.cookie = null;
    this.csrfToken = null;
  }

  async request(method, path, body = null) {
    const url = new URL(path, BASE_URL);

    // Fetch CSRF token if mutating request and missing
    if (['POST', 'PUT', 'DELETE', 'PATCH'].includes(method) && !this.csrfToken && path !== '/api/auth/csrf') {
      await this.getCsrf();
    }

    return new Promise((resolve, reject) => {
      const headers = {};
      if (this.cookie) headers['Cookie'] = this.cookie;
      if (this.csrfToken) headers['X-CSRF-Token'] = this.csrfToken;

      let payload = null;
      if (body) {
        payload = JSON.stringify(body);
        headers['Content-Type'] = 'application/json';
        headers['Content-Length'] = Buffer.byteLength(payload);
      }

      const req = http.request(
        {
          hostname: url.hostname,
          port: url.port,
          path: url.pathname + url.search,
          method,
          headers,
        },
        (res) => {
          // Track cookies
          const setCookie = res.headers['set-cookie'];
          if (setCookie) {
            this.cookie = setCookie.map((c) => c.split(';')[0]).join('; ');
          }

          let data = '';
          res.on('data', (chunk) => (data += chunk));
          res.on('end', () => {
            let json = null;
            try {
              json = JSON.parse(data);
            } catch (e) {
              json = data;
            }

            if (json && json.csrfToken) {
              this.csrfToken = json.csrfToken;
            }

            resolve({
              status: res.statusCode,
              headers: res.headers,
              body: json,
            });
          });
        }
      );

      req.on('error', reject);
      if (payload) req.write(payload);
      req.end();
    });
  }

  async getCsrf() {
    const res = await this.request('GET', '/api/auth/csrf');
    if (res.body && res.body.csrfToken) {
      this.csrfToken = res.body.csrfToken;
    }
    return this.csrfToken;
  }

  get(path) {
    return this.request('GET', path);
  }

  post(path, body) {
    return this.request('POST', path, body);
  }

  put(path, body) {
    return this.request('PUT', path, body);
  }

  delete(path) {
    return this.request('DELETE', path);
  }
}

async function runTests() {
  console.log('========================================================');
  console.log('🧪 STS FINTECH - PHASE 3 INTEGRATION VERIFICATION SUITE');
  console.log('========================================================\n');

  // -------------------------------------------------------------------------
  // TEST A: Demo User Login & Legacy Verification
  // -------------------------------------------------------------------------
  console.log('▶ [TEST A] Demo User Session Login & Data Verification...');
  const demoClient = new SessionClient();
  const demoLogin = await demoClient.post('/api/auth/login', {
    email: 'demo@stsfintech.com',
    password: 'demo-password',
  });

  if (demoLogin.status !== 200 || !demoLogin.body.success) {
    throw new Error(`Demo login failed: ${JSON.stringify(demoLogin.body)}`);
  }
  console.log('  ✔ Demo login successful. User ID:', demoLogin.body.user.id);

  // Check /me
  const demoMe = await demoClient.get('/api/auth/me');
  if (demoMe.status !== 200 || demoMe.body.user.id !== 1) {
    throw new Error(`Demo session verification failed: ${JSON.stringify(demoMe.body)}`);
  }
  console.log('  ✔ /api/auth/me confirmed Demo User ID = 1');

  // Verify Demo categories (10) and transactions (3)
  const demoCategories = await demoClient.get('/api/categories');
  const demoTransactions = await demoClient.get('/api/transactions');
  console.log(`  ✔ Demo User categories count: ${demoCategories.body.data?.length}`);
  console.log(`  ✔ Demo User transactions count: ${demoTransactions.body.data?.length}`);

  if (demoCategories.body.data?.length !== 10) {
    throw new Error(`Expected 10 categories for demo user, got ${demoCategories.body.data?.length}`);
  }
  if (demoTransactions.body.data?.length !== 3) {
    throw new Error(`Expected 3 transactions for demo user, got ${demoTransactions.body.data?.length}`);
  }
  console.log('✅ TEST A PASSED: Demo User login, session, and 10 categories / 3 transactions verified!\n');

  // -------------------------------------------------------------------------
  // TEST B: User A Registration & Data Creation
  // -------------------------------------------------------------------------
  console.log('▶ [TEST B] Register User A, Create Financial Data & Verify Retrieval...');
  const userAClient = new SessionClient();
  const ts = Date.now();
  const emailA = `test_user_a_${ts}@stsfintech.com`;
  const passA = 'SecurePassword1234!';

  const regA = await userAClient.post('/api/auth/register', {
    name: 'Test User A',
    email: emailA,
    password: passA,
  });

  if (regA.status !== 201 || !regA.body.success) {
    throw new Error(`User A registration failed: ${JSON.stringify(regA.body)}`);
  }
  const userAId = regA.body.user.id;
  console.log(`  ✔ User A registered successfully with ID: ${userAId}`);

  // Create segregation entry
  const segA = await userAClient.post('/api/segregation', {
    type: 'additional_income',
    name: 'User A Freelance Project',
    amount: 45000,
    date: '2026-11-09',
    category: 'Consulting',
  });
  if (segA.status !== 201) throw new Error(`User A segregation create failed: ${JSON.stringify(segA.body)}`);
  console.log('  ✔ User A created segregation entry: "User A Freelance Project" (₹45,000)');

  // Create wallet entry
  const walA = await userAClient.post('/api/wallets', {
    name: 'User A Emergency Fund',
    target_amount: 100000,
  });
  if (walA.status !== 201) throw new Error(`User A wallet create failed: ${JSON.stringify(walA.body)}`);
  console.log('  ✔ User A created goal wallet: "User A Emergency Fund" (₹100,000)');

  // Create payment entry
  const payA = await userAClient.post('/api/payments', {
    title: 'User A Server Hosting',
    amount: 3200,
    status: 'completed',
  });
  if (payA.status !== 201) throw new Error(`User A payment create failed: ${JSON.stringify(payA.body)}`);
  console.log('  ✔ User A created payment: "User A Server Hosting" (₹3,200)');

  // Verify retrieval
  const listSegA = await userAClient.get('/api/segregation');
  const listWalA = await userAClient.get('/api/wallets');
  const listPayA = await userAClient.get('/api/payments');

  if (listSegA.body.data.length !== 1 || listSegA.body.data[0].name !== 'User A Freelance Project') {
    throw new Error('User A segregation retrieval mismatch');
  }
  if (listWalA.body.data.length !== 1 || listWalA.body.data[0].name !== 'User A Emergency Fund') {
    throw new Error('User A wallet retrieval mismatch');
  }
  if (listPayA.body.data.length !== 1 || listPayA.body.data[0].title !== 'User A Server Hosting') {
    throw new Error('User A payment retrieval mismatch');
  }
  console.log('✅ TEST B PASSED: User A successfully created and retrieved isolated financial records!\n');

  // -------------------------------------------------------------------------
  // TEST C: Logout User A, Register User B, Clean Zeroed State
  // -------------------------------------------------------------------------
  console.log('▶ [TEST C] Logout User A, Register User B, Verify Clean Empty Ledger...');
  const logoutA = await userAClient.post('/api/auth/logout', {});
  if (logoutA.status !== 200) throw new Error('User A logout failed');
  console.log('  ✔ User A logged out successfully');

  // Confirm User A session is dead
  const deadSession = await userAClient.get('/api/auth/me');
  if (deadSession.status !== 401) {
    throw new Error('Destroyed session did not return 401 Unauthorized');
  }
  console.log('  ✔ User A session confirmed destroyed (401 Unauthorized)');

  // Register User B
  const userBClient = new SessionClient();
  const emailB = `test_user_b_${ts}@stsfintech.com`;
  const passB = 'SecurePassword5678!';

  const regB = await userBClient.post('/api/auth/register', {
    name: 'Test User B',
    email: emailB,
    password: passB,
  });

  if (regB.status !== 201) throw new Error(`User B registration failed: ${JSON.stringify(regB.body)}`);
  const userBId = regB.body.user.id;
  console.log(`  ✔ User B registered successfully with ID: ${userBId}`);

  // Verify User B sees 0 records (No leakage from User A)
  const bSeg = await userBClient.get('/api/segregation');
  const bWal = await userBClient.get('/api/wallets');
  const bPay = await userBClient.get('/api/payments');

  if (bSeg.body.data.length !== 0 || bWal.body.data.length !== 0 || bPay.body.data.length !== 0) {
    throw new Error(`Data leakage! User B sees non-empty records: seg=${bSeg.body.data.length}, wal=${bWal.body.data.length}, pay=${bPay.body.data.length}`);
  }
  console.log('  ✔ User B dashboard is completely zeroed (0 segregation, 0 wallets, 0 payments)');
  console.log('✅ TEST C PASSED: Absolute zero-data start verified for newly registered user!\n');

  // -------------------------------------------------------------------------
  // TEST D: User B Creates Own Data & Verifies Persistence
  // -------------------------------------------------------------------------
  console.log('▶ [TEST D] User B Creates Records & Verifies Independent Persistence...');
  await userBClient.post('/api/segregation', {
    type: 'fixed_expense',
    name: 'User B Coworking Desk',
    amount: 12000,
    date: '2026-11-09',
    category: 'Office Rent',
  });

  await userBClient.post('/api/wallets', {
    name: 'User B Vacation Fund',
    target_amount: 80000,
  });

  await userBClient.post('/api/payments', {
    title: 'User B Internet Subscription',
    amount: 1500,
    status: 'completed',
  });

  const bSeg2 = await userBClient.get('/api/segregation');
  const bWal2 = await userBClient.get('/api/wallets');
  const bPay2 = await userBClient.get('/api/payments');

  if (bSeg2.body.data.length !== 1 || bSeg2.body.data[0].name !== 'User B Coworking Desk') {
    throw new Error('User B segregation mismatch');
  }
  if (bWal2.body.data.length !== 1 || bWal2.body.data[0].name !== 'User B Vacation Fund') {
    throw new Error('User B wallet mismatch');
  }
  if (bPay2.body.data.length !== 1 || bPay2.body.data[0].title !== 'User B Internet Subscription') {
    throw new Error('User B payment mismatch');
  }
  console.log('✅ TEST D PASSED: User B records created and persisted independently!\n');

  // -------------------------------------------------------------------------
  // TEST E: Account Switching: Logout User B, Login User A
  // -------------------------------------------------------------------------
  console.log('▶ [TEST E] Account Switching: Logout User B, Log Back In as User A...');
  await userBClient.post('/api/auth/logout', {});

  const userALoginClient = new SessionClient();
  const reLoginA = await userALoginClient.post('/api/auth/login', {
    email: emailA,
    password: passA,
  });
  if (reLoginA.status !== 200) throw new Error('User A re-login failed');
  console.log('  ✔ User A successfully re-authenticated');

  const aSegCheck = await userALoginClient.get('/api/segregation');
  const aWalCheck = await userALoginClient.get('/api/wallets');
  const aPayCheck = await userALoginClient.get('/api/payments');

  if (aSegCheck.body.data.length !== 1 || aSegCheck.body.data[0].name !== 'User A Freelance Project') {
    throw new Error('User A segregation data lost or mutated after account switch');
  }
  if (aWalCheck.body.data.length !== 1 || aWalCheck.body.data[0].name !== 'User A Emergency Fund') {
    throw new Error('User A wallet data lost or mutated after account switch');
  }
  if (aPayCheck.body.data.length !== 1 || aPayCheck.body.data[0].title !== 'User A Server Hosting') {
    throw new Error('User A payment data lost or mutated after account switch');
  }

  // Ensure NO records of User B are present in User A's view
  const leakedFromB = [
    ...aSegCheck.body.data.filter((r) => r.name.includes('User B')),
    ...aWalCheck.body.data.filter((r) => r.name.includes('User B')),
    ...aPayCheck.body.data.filter((r) => r.title.includes('User B')),
  ];
  if (leakedFromB.length > 0) {
    throw new Error('Data leakage detected: User A sees User B records!');
  }
  console.log('  ✔ User A retrieved 100% of their original records intact; zero data from User B.');
  console.log('✅ TEST E PASSED: Account switching with strict data isolation verified!\n');

  // -------------------------------------------------------------------------
  // TEST F: Unauthenticated Access Security
  // -------------------------------------------------------------------------
  console.log('▶ [TEST F] Unauthenticated Access Security...');
  const unauthClient = new SessionClient();

  const unauthEndpoints = [
    ['GET', '/api/auth/me'],
    ['GET', '/api/segregation'],
    ['POST', '/api/segregation'],
    ['GET', '/api/wallets'],
    ['POST', '/api/wallets'],
    ['GET', '/api/payments'],
    ['POST', '/api/payments'],
  ];

  for (const [m, ep] of unauthEndpoints) {
    const res = await unauthClient.request(m, ep, m === 'POST' ? { name: 'Hack' } : null);
    if (res.status !== 401) {
      throw new Error(`Endpoint ${m} ${ep} did not reject unauthenticated request! Status: ${res.status}`);
    }
  }
  console.log('  ✔ All 7 financial/session endpoints rejected unauthenticated requests with 401 Unauthorized.');
  console.log('✅ TEST F PASSED: Unauthenticated session protection verified!\n');

  // Cleanup test accounts (delete dependent financial test records first due to ON DELETE RESTRICT)
  const pool = require('../db');
  await pool.query('DELETE FROM finance_records WHERE user_id IN ($1, $2)', [userAId, userBId]);
  await pool.query('DELETE FROM segregation WHERE user_id IN ($1, $2)', [userAId, userBId]);
  await pool.query('DELETE FROM goal_wallets WHERE user_id IN ($1, $2)', [userAId, userBId]);
  await pool.query('DELETE FROM wallets WHERE user_id IN ($1, $2)', [userAId, userBId]);
  await pool.query('DELETE FROM payments WHERE user_id IN ($1, $2)', [userAId, userBId]);
  await pool.query('DELETE FROM users WHERE id IN ($1, $2)', [userAId, userBId]);
  console.log('🧹 Cleaned up temporary test accounts.');

  console.log('========================================================');
  console.log('🎉 ALL TESTS (A THROUGH F) PASSED WITH 100% SUCCESS!');
  console.log('========================================================\n');
}

runTests().catch((err) => {
  console.error('\n❌ TEST SUITE FAILED:', err);
  process.exit(1);
});
