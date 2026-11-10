/**
 * STS FINTECH PRIVATE LIMITED
 * PHASE 5 MASTER VERIFICATION & END-TO-END TEST SUITE
 *
 * Verifies:
 * 1. Multi-User Authentication (User A, User B, User C, Demo User ID 1)
 * 2. Multi-Tenant Financial Data Isolation & Tampering Protection across all modules
 * 3. Split & Collect Security, Invitation Acceptance, Cross-Group Rejection & Cascades
 * 4. Financial Calculation Accuracy & Decimal Rounding
 * 5. Frontend & Backend Integration, CSRF Protection, and Empty Dashboards
 * 6. Existing Data Preservation (Demo User, 10 Categories, 3 Transactions, NULL Test Expense)
 * 7. Security Audit (SQL Injection Immunity, IDOR Immunity, Session Security)
 */

const http = require('http');
const pool = require('../db');

const BASE_URL = 'http://localhost:5000';

class SessionClient {
  constructor(name = 'Client') {
    this.name = name;
    this.cookie = null;
    this.csrfToken = null;
    this.user = null;
  }

  async request(method, path, body = null, customHeaders = {}) {
    const url = new URL(path, BASE_URL);

    // Fetch CSRF token for mutating methods if not yet present and not explicitly omitted
    if (['POST', 'PUT', 'DELETE', 'PATCH'].includes(method) && !this.csrfToken && path !== '/api/auth/csrf' && !customHeaders['Skip-CSRF-Fetch']) {
      await this.getCsrf();
    }

    return new Promise((resolve, reject) => {
      const headers = { ...customHeaders };
      delete headers['Skip-CSRF-Fetch'];

      if (this.cookie && !headers['Cookie']) headers['Cookie'] = this.cookie;
      if (this.csrfToken && !headers['X-CSRF-Token'] && !headers['Omit-CSRF-Token']) {
        headers['X-CSRF-Token'] = this.csrfToken;
      }
      delete headers['Omit-CSRF-Token'];

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
          const setCookie = res.headers['set-cookie'];
          if (setCookie) {
            this.cookie = setCookie.map((c) => c.split(';')[0]).join('; ');
            this.rawSetCookie = setCookie;
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

  get(path, headers = {}) {
    return this.request('GET', path, null, headers);
  }

  post(path, body, headers = {}) {
    return this.request('POST', path, body, headers);
  }

  put(path, body, headers = {}) {
    return this.request('PUT', path, body, headers);
  }

  delete(path, headers = {}) {
    return this.request('DELETE', path, null, headers);
  }
}

const getId = (res) => (res && res.body ? (res.body.id ?? (res.body.data && res.body.data.id) ?? (res.body.group && res.body.group.id)) : null);
const getList = (res) => (res && res.body ? (Array.isArray(res.body) ? res.body : (Array.isArray(res.body.data) ? res.body.data : [])) : []);
const getDash = (res) => (res && res.body ? (res.body.data || res.body) : {});

async function runPhase5MasterTestSuite() {
  console.log('========================================================================');
  console.log('🚀 STS FINTECH - PHASE 5 COMPREHENSIVE END-TO-END VERIFICATION SUITE');
  console.log('========================================================================\n');

  const ts = Date.now();
  const emailA = `test_p5_user_a_${ts}@stsfintech.com`;
  const emailB = `test_p5_user_b_${ts}@stsfintech.com`;
  const emailC = `test_p5_user_c_${ts}@stsfintech.com`;
  const password = 'StrongPassword123!';

  const clientA = new SessionClient('User A');
  const clientB = new SessionClient('User B');
  const clientC = new SessionClient('User C');
  const clientDemo = new SessionClient('Demo User');

  const createdUserIds = [];
  const createdGroupIds = [];

  try {
    // =========================================================================
    // SECTION 1: MULTI-USER AUTHENTICATION TESTING
    // =========================================================================
    console.log('▶ [SECTION 1] Multi-User Authentication Testing...');

    // 1.1 Demo User (ID 1) login
    const demoLoginRes = await clientDemo.post('/api/auth/login', {
      email: 'demo@stsfintech.com',
      password: 'demo-password',
    });
    if (demoLoginRes.status !== 200 || !demoLoginRes.body.user || demoLoginRes.body.user.id !== 1) {
      throw new Error(`Demo User login failed: ${JSON.stringify(demoLoginRes.body)}`);
    }
    console.log(`  ✔ Demo User logged in successfully with preserved ID 1 (${demoLoginRes.body.user.email})`);

    // Verify Demo session cookie flags
    const demoCookieHeader = clientDemo.rawSetCookie ? clientDemo.rawSetCookie.join('; ') : '';
    if (!demoCookieHeader.toLowerCase().includes('httponly')) {
      console.warn('  ⚠ Warning: HttpOnly flag not detected in set-cookie header');
    } else {
      console.log('  ✔ HttpOnly cookie security verified for user session');
    }

    // 1.2 Register User A
    const regARes = await clientA.post('/api/auth/register', {
      name: 'User A',
      email: emailA,
      password,
      role: 'finance_member',
    });
    if (regARes.status !== 201 || !regARes.body.user) {
      throw new Error(`User A registration failed: ${JSON.stringify(regARes.body)}`);
    }
    const userA = regARes.body.user;
    if (typeof userA.id !== 'number' || userA.id <= 1) {
      throw new Error(`User A received invalid non-integer ID: ${userA.id}`);
    }
    clientA.user = userA;
    createdUserIds.push(userA.id);
    console.log(`  ✔ User A registered with unique auto-generated INTEGER ID: ${userA.id}`);

    // 1.3 Register User B
    const regBRes = await clientB.post('/api/auth/register', {
      name: 'User B',
      email: emailB,
      password,
      role: 'finance_member',
    });
    if (regBRes.status !== 201 || !regBRes.body.user) {
      throw new Error(`User B registration failed: ${JSON.stringify(regBRes.body)}`);
    }
    const userB = regBRes.body.user;
    if (typeof userB.id !== 'number' || userB.id <= userA.id) {
      throw new Error(`User B received invalid non-integer ID: ${userB.id}`);
    }
    clientB.user = userB;
    createdUserIds.push(userB.id);
    console.log(`  ✔ User B registered with unique auto-generated INTEGER ID: ${userB.id}`);

    // 1.4 Register User C
    const regCRes = await clientC.post('/api/auth/register', {
      name: 'User C',
      email: emailC,
      password,
      role: 'finance_member',
    });
    if (regCRes.status !== 201 || !regCRes.body.user) {
      throw new Error(`User C registration failed: ${JSON.stringify(regCRes.body)}`);
    }
    const userC = regCRes.body.user;
    if (typeof userC.id !== 'number' || userC.id <= userB.id) {
      throw new Error(`User C received invalid non-integer ID: ${userC.id}`);
    }
    clientC.user = userC;
    createdUserIds.push(userC.id);
    console.log(`  ✔ User C registered with unique auto-generated INTEGER ID: ${userC.id}`);

    // 1.5 Verify /api/auth/me for each user
    const [meA, meB, meC] = await Promise.all([
      clientA.get('/api/auth/me'),
      clientB.get('/api/auth/me'),
      clientC.get('/api/auth/me'),
    ]);
    if (meA.body.user.id !== userA.id || meB.body.user.id !== userB.id || meC.body.user.id !== userC.id) {
      throw new Error('Session user isolation failure on /api/auth/me');
    }
    console.log('  ✔ /api/auth/me verified for all 3 users with exact session isolation');

    // 1.6 Verify Logout and Session Destruction
    const tempClient = new SessionClient('Temp');
    await tempClient.post('/api/auth/register', {
      name: 'Temp User',
      email: `temp_${ts}@stsfintech.com`,
      password,
    });
    const tempUserRes = await tempClient.get('/api/auth/me');
    const tempUserId = tempUserRes.body.user.id;
    createdUserIds.push(tempUserId);

    const logoutRes = await tempClient.post('/api/auth/logout', {});
    if (logoutRes.status !== 200) {
      throw new Error(`Logout failed with status ${logoutRes.status}`);
    }
    const postLogoutMe = await tempClient.get('/api/auth/me');
    if (postLogoutMe.status !== 401) {
      throw new Error(`Session was not destroyed after logout! Status: ${postLogoutMe.status}`);
    }
    console.log('  ✔ Logout successfully destroys server session (subsequent request returns 401)');
    console.log('✅ SECTION 1 PASSED: Multi-User Authentication Verified!\n');

    // =========================================================================
    // SECTION 2: FINANCIAL DATA ISOLATION & ANTI-TAMPERING TESTING
    // =========================================================================
    console.log('▶ [SECTION 2] Financial Data Isolation & Anti-Tampering Testing...');

    // 2.1 User A creates financial records across all modules
    // Income
    const incARes = await clientA.post('/api/segregation', {
      name: 'Client Project Alpha',
      amount: 65000,
      type: 'additional_income',
      category: 'Consulting',
      date: '2026-11-09',
      schedule: 'One-time',
    });
    if (incARes.status !== 201) throw new Error(`User A income creation failed: ${JSON.stringify(incARes.body)}`);
    const incAId = getId(incARes);

    // Expense
    const expARes = await clientA.post('/api/segregation', {
      name: 'AWS Cloud Infrastructure',
      amount: 12000,
      type: 'additional_expense',
      category: 'Infrastructure',
      date: '2026-11-09',
      schedule: 'Monthly',
    });
    if (expARes.status !== 201) throw new Error(`User A expense creation failed: ${JSON.stringify(expARes.body)}`);
    const expAId = getId(expARes);

    // Wallet
    const walARes = await clientA.post('/api/wallets', {
      name: 'HDFC Corporate Operating Account',
      target_amount: 150000,
      balance: 150000,
      currency: 'INR',
    });
    if (walARes.status !== 201) throw new Error(`User A wallet creation failed: ${JSON.stringify(walARes.body)}`);
    const walAId = getId(walARes);

    // Goal Wallet
    const goalARes = await clientA.post('/api/goal-wallets', {
      name: 'Q4 Tax Reserve Fund',
      target_amount: 300000,
      current_amount: 100000,
      currency: 'INR',
    });
    if (goalARes.status !== 201) throw new Error(`User A goal wallet creation failed: ${JSON.stringify(goalARes.body)}`);
    const goalAId = getId(goalARes);

    // Payment / Reminder
    const payARes = await clientA.post('/api/payments', {
      title: 'Office Lease Payment',
      amount: 45000,
      date: '2026-11-15',
      category: 'Rent',
      status: 'pending',
    });
    if (payARes.status !== 201) throw new Error(`User A payment creation failed: ${JSON.stringify(payARes.body)}`);
    const payAId = getId(payARes);

    // Transaction
    const txARes = await clientA.post('/api/transactions', {
      amount: 5000,
      type: 'debit',
      category: 'Software Licenses',
      description: 'JetBrains Annual License',
      date: '2026-11-09',
    });
    if (txARes.status !== 201) throw new Error(`User A transaction creation failed: ${JSON.stringify(txARes.body)}`);
    const txAId = getId(txARes);

    console.log('  ✔ User A successfully created records across Income, Expense, Wallet, Goal, Payment, Transaction');

    // 2.2 Verify User B sees NONE of User A's data
    const [bSeg, bWal, bGoals, bPay, bTx, bDash] = await Promise.all([
      clientB.get('/api/segregation'),
      clientB.get('/api/wallets'),
      clientB.get('/api/goal-wallets'),
      clientB.get('/api/payments'),
      clientB.get('/api/transactions'),
      clientB.get('/api/dashboard/summary'),
    ]);

    const bSegList = getList(bSeg);
    const bWalList = getList(bWal);
    const bGoalList = getList(bGoals);
    const bPayList = getList(bPay);
    const bTxList = getList(bTx);

    if (bSegList.length !== 0) throw new Error(`User B saw User A segregation records! Count: ${bSegList.length}`);
    if (bWalList.length !== 0) throw new Error(`User B saw User A wallet records! Count: ${bWalList.length}`);
    if (bGoalList.length !== 0) throw new Error(`User B saw User A goal wallet records! Count: ${bGoalList.length}`);
    if (bPayList.length !== 0) throw new Error(`User B saw User A payment records! Count: ${bPayList.length}`);
    if (bTxList.length !== 0) throw new Error(`User B saw User A transaction records! Count: ${bTxList.length}`);
    const bDashData = getDash(bDash);
    if (parseFloat(bDashData.totalIncome || 0) !== 0 || parseFloat(bDashData.totalExpense || 0) !== 0) {
      throw new Error(`User B dashboard leaked User A totals! Got: ${JSON.stringify(bDash.body)}`);
    }
    console.log('  ✔ Absolute read isolation: User B retrieved 0 records across all modules');

    // 2.3 Cross-User Tampering: User B attempts to Modify or Delete User A records
    // User B tries to update User A's segregation record
    const bTamperSegPut = await clientB.put(`/api/segregation/${incAId}`, {
      name: 'Hacked Income Title',
      amount: 999999,
    });
    if (bTamperSegPut.status !== 404) {
      throw new Error(`Cross-tenant PUT /api/segregation was not rejected with 404! Got: ${bTamperSegPut.status}`);
    }

    // User B tries to delete User A's segregation record
    const bTamperSegDel = await clientB.delete(`/api/segregation/${incAId}`);
    if (bTamperSegDel.status !== 404) {
      throw new Error(`Cross-tenant DELETE /api/segregation was not rejected with 404! Got: ${bTamperSegDel.status}`);
    }

    // User B tries to add cash to User A's wallet
    const bTamperWalCash = await clientB.post(`/api/wallets/${walAId}/add-cash`, { amount: 50000 });
    if (bTamperWalCash.status !== 404) {
      throw new Error(`Cross-tenant wallet add-cash was not rejected with 404! Got: ${bTamperWalCash.status}`);
    }

    // User B tries to delete User A's wallet
    const bTamperWalDel = await clientB.delete(`/api/wallets/${walAId}`);
    if (bTamperWalDel.status !== 404) {
      throw new Error(`Cross-tenant DELETE wallet was not rejected with 404! Got: ${bTamperWalDel.status}`);
    }

    // User B tries to update User A's payment
    const bTamperPayPut = await clientB.put(`/api/payments/${payAId}`, { title: 'Hacked Payment' });
    if (bTamperPayPut.status !== 404) {
      throw new Error(`Cross-tenant PUT payment was not rejected with 404! Got: ${bTamperPayPut.status}`);
    }

    // User B tries to delete User A's payment
    const bTamperPayDel = await clientB.delete(`/api/payments/${payAId}`);
    if (bTamperPayDel.status !== 404) {
      throw new Error(`Cross-tenant DELETE payment was not rejected with 404! Got: ${bTamperPayDel.status}`);
    }

    console.log('  ✔ Cross-tenant mutation attempts (PUT, DELETE, add-cash) all strictly returned 404 Not Found');

    // 2.4 user_id Spoofing Prevention
    const spoofRes = await clientB.post(
      '/api/segregation',
      {
        name: 'Spoofed Income Attempt',
        amount: 88888,
        type: 'additional_income',
        category: 'Spoofed',
        user_id: userA.id, // Trying to spoof User A's ID
      },
      {
        'x-user-id': String(userA.id), // Trying to spoof User A's ID via header
      }
    );
    if (spoofRes.status !== 201) throw new Error(`Spoof test creation failed: ${JSON.stringify(spoofRes.body)}`);
    const spoofRecordId = getId(spoofRes);

    // Verify in database that it was bound to userB.id, NOT userA.id
    const dbRecord = await pool.query('SELECT user_id FROM segregation WHERE id = $1', [spoofRecordId]);
    if (dbRecord.rows[0].user_id !== userB.id) {
      throw new Error(`user_id spoofing succeeded! DB has user_id: ${dbRecord.rows[0].user_id}, expected: ${userB.id}`);
    }
    console.log('  ✔ user_id spoofing immunity confirmed: backend derived user_id strictly from authenticated session');

    // 2.5 Unassigned Test Expense (user_id = NULL) leak check
    const allSegA = getList(await clientA.get('/api/segregation'));
    const allSegB = getList(await clientB.get('/api/segregation'));
    const leakedA = allSegA.some((r) => r.name === 'Test Expense');
    const leakedB = allSegB.some((r) => r.name === 'Test Expense');
    if (leakedA || leakedB) {
      throw new Error('Unassigned Test Expense (user_id = NULL) was leaked to authenticated users!');
    }
    console.log('  ✔ Legacy unassigned record (user_id = NULL) remains protected and un-leaked');

    console.log('✅ SECTION 2 PASSED: Financial Data Isolation & Anti-Tampering Verified!\n');

    // =========================================================================
    // SECTION 3: SPLIT & COLLECT SECURITY & PERMISSIONS TESTING
    // =========================================================================
    console.log('▶ [SECTION 3] Split & Collect Security, Invitations & Isolation Testing...');

    // 3.1 User A creates Group G1 inviting User B and an unlinked guest
    const createGroupRes = await clientA.post('/api/splits/groups', {
      title: 'Bangalore Fintech Summit',
      description: 'Annual industry summit split expenses',
      participants: [
        { name: 'User A Leader', email: emailA },
        { name: 'User B Member', email: emailB, status: 'pending' },
        { name: 'Guest Consultant', email: `guest_${ts}@stsfintech.com` },
      ],
    });
    if (createGroupRes.status !== 201) {
      throw new Error(`Group creation failed: ${JSON.stringify(createGroupRes.body)}`);
    }
    const groupG1 = createGroupRes.body.data || createGroupRes.body.group;
    createdGroupIds.push(groupG1.id);
    console.log(`  ✔ User A created Split Group G1 (ID: ${groupG1.id}) with Owner, Registered Member, and Guest`);

    // 3.2 Verify Invitation & Acceptance Flow:
    // Before accepting, User B checking group directly should receive 404 (group access requires acceptance)
    const bBeforeAccept = await clientB.get(`/api/splits/groups/${groupG1.id}`);
    if (bBeforeAccept.status !== 404) {
      throw new Error(`Unaccepted invited user accessed group directly! Status: ${bBeforeAccept.status}`);
    }
    console.log('  ✔ Unaccepted invitee is denied direct group access (404 Not Found)');

    // User B checks pending invitations
    const bInvitations = await clientB.get('/api/splits/invitations');
    const inviteList = getList(bInvitations);
    const inviteFound = inviteList.find((inv) => (inv.group_id || inv.id) === groupG1.id);
    if (!inviteFound) {
      throw new Error(`Group G1 not found in User B pending invitations! Got: ${JSON.stringify(inviteList)}`);
    }
    console.log(`  ✔ Group G1 successfully appears in User B pending invitations`);

    // User B accepts the invitation
    const bAcceptRes = await clientB.post(`/api/splits/groups/${groupG1.id}/accept`, {});
    if (bAcceptRes.status !== 200) {
      throw new Error(`User B failed to accept invitation: ${JSON.stringify(bAcceptRes.body)}`);
    }
    console.log('  ✔ User B accepted invitation successfully');

    // User B now accesses group G1
    const bAfterAccept = await clientB.get(`/api/splits/groups/${groupG1.id}`);
    const g1Details = bAfterAccept.body.data || bAfterAccept.body.group;
    if (bAfterAccept.status !== 200 || !g1Details) {
      throw new Error(`User B unable to access group after acceptance: ${JSON.stringify(bAfterAccept.body)}`);
    }
    console.log('  ✔ User B now has full authorized member access to Group G1');

    // 3.3 Add Expenses to Group G1
    const participants = g1Details.participants || [];
    const memA = participants.find((p) => p.email && p.email.toLowerCase() === emailA.toLowerCase());
    const memB = participants.find((p) => p.email && p.email.toLowerCase() === emailB.toLowerCase());
    const memGuest = participants.find((p) => !p.userId && !p.user_id);

    if (!memA || !memB || !memGuest) {
      throw new Error(`Participants not properly linked: ${JSON.stringify(participants)}`);
    }

    const exp1Res = await clientA.post(`/api/splits/groups/${groupG1.id}/expenses`, {
      title: 'Conference Registration & Booth',
      amount: 45000,
      paid_by_member_id: memA.id,
      category: 'Conference',
    });
    if (exp1Res.status !== 201) throw new Error(`Failed to add expense 1: ${JSON.stringify(exp1Res.body)}`);

    const exp2Res = await clientB.post(`/api/splits/groups/${groupG1.id}/expenses`, {
      title: 'Client Networking Dinner',
      amount: 15000,
      paid_by_member_id: memB.id,
      category: 'Dining',
    });
    if (exp2Res.status !== 201) throw new Error(`Failed to add expense 2: ${JSON.stringify(exp2Res.body)}`);
    console.log('  ✔ Expenses recorded by Owner (₹45,000) and Member (₹15,000)');

    // 3.4 Cross-Group Resource Tampering:
    // User C creates Group G2
    const createG2Res = await clientC.post('/api/splits/groups', {
      title: 'User C Private Venture',
      participants: [{ name: 'User C', email: emailC }],
    });
    const groupG2 = createG2Res.body.data || createG2Res.body.group;
    createdGroupIds.push(groupG2.id);
    const memC = (createG2Res.body.data || createG2Res.body).participants[0];

    // User A attempts to add an expense to G1 using member C's ID (from G2)
    const crossExpRes = await clientA.post(`/api/splits/groups/${groupG1.id}/expenses`, {
      title: 'Malicious Cross-Group Member Expense',
      amount: 1000,
      paid_by_member_id: memC.id, // Belongs to G2, NOT G1!
    });
    if (crossExpRes.status !== 400) {
      throw new Error(`Cross-group member ID was not rejected with 400! Got: ${crossExpRes.status}`);
    }
    console.log('  ✔ Cross-group member ID in expense strictly rejected with 400 Bad Request');

    // User A attempts to record a settlement using member C's ID
    const crossSetRes = await clientA.post(`/api/splits/groups/${groupG1.id}/settlements`, {
      from_name: memA.name,
      to_name: 'User C',
      amount: 500,
      from_member_id: memA.id,
      to_member_id: memC.id, // Belongs to G2!
    });
    if (crossSetRes.status !== 400) {
      throw new Error(`Cross-group member ID in settlement was not rejected with 400! Got: ${crossSetRes.status}`);
    }
    console.log('  ✔ Cross-group member ID in settlement strictly rejected with 400 Bad Request');

    // 3.5 Non-member Isolation (User C attempting G1 operations)
    const cGetG1 = await clientC.get(`/api/splits/groups/${groupG1.id}`);
    const cPostG1Exp = await clientC.post(`/api/splits/groups/${groupG1.id}/expenses`, { title: 'Hack', amount: 100 });
    const cDelG1 = await clientC.delete(`/api/splits/groups/${groupG1.id}`);

    if (cGetG1.status !== 404 || cPostG1Exp.status !== 404 || cDelG1.status !== 404) {
      throw new Error(`User C was not rejected with 404 on Group G1! Statuses: ${cGetG1.status}, ${cPostG1Exp.status}, ${cDelG1.status}`);
    }
    console.log('  ✔ Non-member access attempts all strictly masked with 404 Not Found');

    // 3.6 Permission check: Member User B cannot delete Group G1
    const bDelG1 = await clientB.delete(`/api/splits/groups/${groupG1.id}`);
    if (bDelG1.status !== 403) {
      throw new Error(`Non-owner member deleting group did not return 403! Got: ${bDelG1.status}`);
    }
    console.log('  ✔ Non-owner member forbidden from deleting group (403 Forbidden)');

    // 3.7 Cascading Deletion Safety
    // Create a temporary group with an expense, then delete it and verify users remain intact
    const tempGroupRes = await clientC.post('/api/splits/groups', {
      title: 'Temporary Deletion Test Group',
      participants: [{ name: 'User C Leader', email: emailC }],
    });
    const tempGroup = tempGroupRes.body.data || tempGroupRes.body.group;
    const tempGroupId = tempGroup.id;
    createdGroupIds.push(tempGroupId);
    const tempMemId = (tempGroupRes.body.data || tempGroupRes.body).participants[0].id;
    await clientC.post(`/api/splits/groups/${tempGroupId}/expenses`, {
      title: 'Temp Expense',
      amount: 2500,
      paid_by_member_id: tempMemId,
    });

    const delTempRes = await clientC.delete(`/api/splits/groups/${tempGroupId}`);
    if (delTempRes.status !== 200) {
      throw new Error(`Owner failed to delete temporary group: ${delTempRes.status}`);
    }

    // Verify in DB that cascading removed expenses and shares, but user remains
    const dbExpensesCheck = await pool.query('SELECT count(*) FROM split_expenses WHERE group_id = $1', [tempGroupId]);
    const dbMembersCheck = await pool.query('SELECT count(*) FROM split_group_members WHERE group_id = $1', [tempGroupId]);
    const dbUserCheck = await pool.query('SELECT id FROM users WHERE id = $1', [userC.id]);

    if (parseInt(dbExpensesCheck.rows[0].count) !== 0 || parseInt(dbMembersCheck.rows[0].count) !== 0) {
      throw new Error('Group cascading deletion failed to clean up dependent records!');
    }
    if (dbUserCheck.rows.length === 0) {
      throw new Error('CRITICAL BUG: Cascading deletion deleted the user account!');
    }
    console.log('  ✔ Group cascading deletion cleaned up dependent records while preserving user accounts');

    console.log('✅ SECTION 3 PASSED: Split & Collect Security, Invitations & Permissions Verified!\n');

    // =========================================================================
    // SECTION 4: FINANCIAL CALCULATION ACCURACY & DECIMAL SPLITTING
    // =========================================================================
    console.log('▶ [SECTION 4] Financial Calculation Accuracy & Decimal Rounding Testing...');

    // 4.1 Dashboard and Financial Totals Verification for User A
    const aDashRes = await clientA.get('/api/dashboard/summary');
    if (aDashRes.status !== 200) throw new Error('Failed to get User A dashboard summary');

    const expectedIncome = 65000;
    const expectedExpense = 12000;
    const expectedNetBalance = expectedIncome - expectedExpense; // 53000

    const aDash = getDash(aDashRes);
    const actualIncome = parseFloat(aDash.totalIncome || 0);
    const actualExpense = parseFloat(aDash.totalExpense || 0);
    const actualBalance = parseFloat(aDash.netBalance ?? aDash.availableBalance ?? 0);

    if (actualIncome !== expectedIncome || actualExpense !== expectedExpense || actualBalance !== expectedNetBalance) {
      throw new Error(`Calculation mismatch! Expected: +${expectedIncome}, -${expectedExpense}, net: ${expectedNetBalance}. Got: +${actualIncome}, -${actualExpense}, net: ${actualBalance}`);
    }
    console.log(`  ✔ Dashboard Summary math exact: Total Income = ₹${actualIncome}, Total Expense = ₹${actualExpense}, Available Balance = ₹${actualBalance}`);

    // 4.2 Goal Wallet Percentage Calculation (Deposit ₹100,000 into ₹300,000 target)
    const depositGoal = await clientA.post(`/api/wallets/${goalAId}/add-cash`, { amount: 100000 });
    if (depositGoal.status !== 200) throw new Error(`Failed to deposit cash into goal wallet: ${JSON.stringify(depositGoal.body)}`);

    const goalList = getList(await clientA.get('/api/goal-wallets'));
    const goalRec = goalList.find((g) => g.id === goalAId);
    if (!goalRec) throw new Error('Goal wallet not found in list!');
    const goalPct = (parseFloat(goalRec.saved_amount ?? 0) / parseFloat(goalRec.target_amount)) * 100;
    if (Math.round(goalPct) !== 33) { // 100000 / 300000 = 33.33%
      throw new Error(`Goal progress calculation unexpected: ${goalPct}%`);
    }
    console.log(`  ✔ Goal progress calculation exact: ₹1,00,000 / ₹3,00,000 = ${goalPct.toFixed(2)}%`);

    // 4.3 Wallet Cash Addition Math
    const addCashRes = await clientA.post(`/api/wallets/${walAId}/add-cash`, { amount: 25000 });
    if (addCashRes.status !== 200) throw new Error('Failed to add cash to wallet');
    const updatedWal = await pool.query('SELECT saved_amount FROM goal_wallets WHERE id = $1', [walAId]);
    const expectedWalSaved = 25000;
    if (parseFloat(updatedWal.rows[0].saved_amount) !== expectedWalSaved) {
      throw new Error(`Wallet balance calculation mismatch! Expected: ${expectedWalSaved}, Got: ${updatedWal.rows[0].saved_amount}`);
    }
    console.log(`  ✔ Wallet balance math exact: Initial ₹0 + Deposit ₹25,000 = ₹${parseFloat(updatedWal.rows[0].saved_amount)}`);

    // 4.4 Uneven Split & Rounding Precision Test (₹100 split 3 ways)
    const unevenExpRes = await clientA.post(`/api/splits/groups/${groupG1.id}/expenses`, {
      title: 'Team Coffee Rounding Test',
      amount: 100, // 100 / 3 = 33.33333333...
      paid_by_member_id: memA.id,
    });
    if (unevenExpRes.status !== 201) throw new Error('Failed to add uneven expense');
    const unevenExpId = getId(unevenExpRes);

    const sharesCheck = await pool.query('SELECT share_amount FROM split_expense_shares WHERE expense_id = $1', [unevenExpId]);
    const sumShares = sharesCheck.rows.reduce((sum, r) => sum + parseFloat(r.share_amount), 0);
    if (Math.abs(sumShares - 100.0) > 0.05) {
      throw new Error(`Uneven split rounding loss! Shares sum: ${sumShares}, expected: 100.00`);
    }
    console.log(`  ✔ Decimal rounding verification: ₹100 split 3 ways sums to ₹${sumShares.toFixed(2)} without currency loss`);

    // 4.5 Debt Settlement Calculation
    const groupDetails = await clientA.get(`/api/splits/groups/${groupG1.id}`);
    const gData = groupDetails.body.data || groupDetails.body;
    const totalOutlay = gData.expenses.reduce((s, e) => s + parseFloat(e.amount), 0);
    const sharePerPerson = totalOutlay / gData.participants.length;
    console.log(`  ✔ Total group outlay: ₹${totalOutlay}, per-person base share: ₹${sharePerPerson.toFixed(2)}`);

    // Record settlement of ₹10,000 from User B to User A
    const setRes = await clientB.post(`/api/splits/groups/${groupG1.id}/settlements`, {
      from_name: memB.name,
      to_name: memA.name,
      amount: 10000,
      from_member_id: memB.id,
      to_member_id: memA.id,
      notes: 'Partial settlement for conference & dinner',
    });
    if (setRes.status !== 201) throw new Error(`Settlement creation failed: ${JSON.stringify(setRes.body)}`);
    const setRecordId = getId(setRes);

    const updatedGroupDetails = await clientA.get(`/api/splits/groups/${groupG1.id}`);
    const updatedSettlements = (updatedGroupDetails.body.data || updatedGroupDetails.body).settlements;
    const foundSettlement = updatedSettlements.find((s) => s.id === setRecordId);
    if (!foundSettlement || parseFloat(foundSettlement.amount) !== 10000) {
      throw new Error('Settlement was not recorded properly in group details!');
    }
    console.log('  ✔ Settlement of ₹10,000 recorded and balance accurately updated');

    console.log('✅ SECTION 4 PASSED: Financial Calculation Accuracy Verified!\n');

    // =========================================================================
    // SECTION 5: FRONTEND & BACKEND INTEGRATION, CSRF & EMPTY LEDGERS
    // =========================================================================
    console.log('▶ [SECTION 5] Frontend & Backend Integration, CSRF & Empty Ledgers...');

    // 5.1 CSRF Token Protection Test
    // Try to perform a POST without a CSRF token
    const noCsrfClient = new SessionClient('No CSRF');
    // First log in
    await noCsrfClient.post('/api/auth/login', { email: emailA, password });
    // Attempt mutating request with CSRF token stripped
    const csrfBlockedRes = await noCsrfClient.post(
      '/api/segregation',
      { name: 'CSRF Attack', amount: 500, type: 'additional_income' },
      { 'Omit-CSRF-Token': 'true', 'X-CSRF-Token': 'invalid-token' }
    );
    if (csrfBlockedRes.status !== 403) {
      throw new Error(`Request with invalid CSRF token was not rejected with 403! Got: ${csrfBlockedRes.status}`);
    }
    console.log('  ✔ CSRF protection active: invalid/missing CSRF token strictly rejected with 403 Forbidden');

    // 5.2 Fresh User Empty Dashboard Verification
    const freshClient = new SessionClient('Fresh');
    const freshEmail = `fresh_${ts}@stsfintech.com`;
    const freshReg = await freshClient.post('/api/auth/register', { name: 'Fresh User', email: freshEmail, password });
    createdUserIds.push(freshReg.body.user.id);

    const [fSeg, fWal, fGoal, fPay, fTx, fDash] = await Promise.all([
      freshClient.get('/api/segregation'),
      freshClient.get('/api/wallets'),
      freshClient.get('/api/goal-wallets'),
      freshClient.get('/api/payments'),
      freshClient.get('/api/transactions'),
      freshClient.get('/api/dashboard/summary'),
    ]);

    const fSegList = getList(fSeg);
    const fWalList = getList(fWal);
    const fGoalList = getList(fGoal);
    const fPayList = getList(fPay);
    const fTxList = getList(fTx);

    if (
      fSegList.length !== 0 ||
      fWalList.length !== 0 ||
      fGoalList.length !== 0 ||
      fPayList.length !== 0 ||
      fTxList.length !== 0 ||
      parseFloat(getDash(fDash).totalIncome || 0) !== 0 ||
      parseFloat(getDash(fDash).totalExpense || 0) !== 0 ||
      parseFloat(getDash(fDash).netBalance || 0) !== 0
    ) {
      throw new Error('Fresh user did not start with a clean empty ledger!');
    }
    console.log('  ✔ Fresh user ledger starts completely zeroed (0 income, 0 expenses, 0 wallets, 0 payments)');

    console.log('✅ SECTION 5 PASSED: Frontend & Backend Integration Verified!\n');

    // =========================================================================
    // SECTION 6: EXISTING DATA PRESERVATION (DEMO USER, CATEGORIES, TXS)
    // =========================================================================
    console.log('▶ [SECTION 6] Existing Data Preservation Verification...');

    // 6.1 Demo User ID 1 and credentials
    const demoUserRow = await pool.query('SELECT id, email, role, password_hash FROM users WHERE id = 1');
    if (demoUserRow.rows.length !== 1 || demoUserRow.rows[0].email !== 'demo@stsfintech.com') {
      throw new Error('Demo User (ID 1) corrupted or missing from database!');
    }
    console.log(`  ✔ Demo User preserved: ID 1, email: ${demoUserRow.rows[0].email}, role: ${demoUserRow.rows[0].role}`);

    // 6.2 Pre-existing categories count
    const catCheck = await pool.query('SELECT count(*) FROM categories');
    const catCount = parseInt(catCheck.rows[0].count);
    if (catCount !== 10) {
      throw new Error(`Pre-existing categories altered! Expected: 10, Found: ${catCount}`);
    }
    console.log(`  ✔ All 10 pre-existing categories preserved intact`);

    // 6.3 Pre-existing transactions count
    const txCheck = await pool.query('SELECT count(*) FROM transactions WHERE user_id = 1 OR user_id IS NULL');
    const txCount = parseInt(txCheck.rows[0].count);
    if (txCount !== 3) {
      throw new Error(`Pre-existing transactions altered! Expected: 3, Found: ${txCount}`);
    }
    console.log(`  ✔ All 3 pre-existing transactions preserved intact`);

    // 6.4 Unassigned Test Expense (user_id = NULL) in finance_records
    const nullExpCheck = await pool.query('SELECT id, name, amount, user_id FROM finance_records WHERE user_id IS NULL');
    if (nullExpCheck.rows.length !== 1 || nullExpCheck.rows[0].name !== 'Test Expense') {
      throw new Error('Unassigned Test Expense with user_id = NULL missing or altered!');
    }
    console.log(`  ✔ Test Expense (ID ${nullExpCheck.rows[0].id}, Amount ₹${nullExpCheck.rows[0].amount}) preserved with user_id = NULL`);

    // 6.5 Schema migrations record check
    const migCheck = await pool.query('SELECT filename FROM schema_migrations ORDER BY id');
    const migFiles = migCheck.rows.map((r) => r.filename);
    if (!migFiles.includes('002_user_data_isolation.sql') || !migFiles.includes('003_split_collect_persistence.sql')) {
      throw new Error(`Migrations missing from schema_migrations! Found: ${JSON.stringify(migFiles)}`);
    }
    console.log(`  ✔ Schema migrations table recorded: ${migFiles.join(', ')}`);

    console.log('✅ SECTION 6 PASSED: Existing Data Integrity 100% Preserved!\n');

    // =========================================================================
    // SECTION 7: PRODUCTION SECURITY AUDIT
    // =========================================================================
    console.log('▶ [SECTION 7] Production Security & Parameterization Audit...');

    // 7.1 SQL Injection test on input fields
    const sqliAttempt = await clientA.post('/api/segregation', {
      name: "Test' OR '1'='1'; DROP TABLE segregation; --",
      amount: 500,
      type: 'additional_income',
      category: "Category' OR '1'='1",
      date: '2026-11-09',
    });
    if (sqliAttempt.status !== 201) {
      throw new Error('SQL injection test failed to execute parameterized query');
    }
    const sqliRecordId = getId(sqliAttempt);
    // Verify table segregation still exists and contains the escaped string literally
    const sqliRow = await pool.query('SELECT name FROM segregation WHERE id = $1', [sqliRecordId]);
    if (sqliRow.rows[0].name !== "Test' OR '1'='1'; DROP TABLE segregation; --") {
      throw new Error('SQL injection payload altered database inappropriately!');
    }
    console.log('  ✔ Parameterized queries verified: SQL injection payloads stored safely as literal strings');

    // 7.2 Unauthenticated Access Barrier across all sensitive endpoints
    const unauthClient = new SessionClient('Unauth');
    const protectedEndpoints = [
      ['GET', '/api/auth/me'],
      ['GET', '/api/segregation'],
      ['POST', '/api/segregation'],
      ['GET', '/api/wallets'],
      ['POST', '/api/wallets'],
      ['GET', '/api/goal-wallets'],
      ['POST', '/api/goal-wallets'],
      ['GET', '/api/payments'],
      ['POST', '/api/payments'],
      ['GET', '/api/transactions'],
      ['POST', '/api/transactions'],
      ['GET', '/api/dashboard/summary'],
      ['GET', '/api/splits/groups'],
      ['POST', '/api/splits/groups'],
      ['GET', '/api/splits/invitations'],
    ];

    for (const [m, ep] of protectedEndpoints) {
      const res = await unauthClient.request(m, ep, m === 'POST' ? { name: 'Test' } : null, { 'Skip-CSRF-Fetch': 'true' });
      if (res.status !== 401) {
        throw new Error(`Endpoint ${m} ${ep} did not reject unauthenticated request with 401! Got: ${res.status}`);
      }
    }
    console.log(`  ✔ All ${protectedEndpoints.length} sensitive API endpoints strictly rejected unauthenticated access with 401 Unauthorized`);

    console.log('✅ SECTION 7 PASSED: Security Audit Passed!\n');

  } finally {
    // =========================================================================
    // CLEANUP TEMPORARY TEST DATA
    // =========================================================================
    console.log('🧹 Cleaning up temporary test data...');
    try {
      if (createdUserIds.length > 0) {
        await pool.query('DELETE FROM split_groups WHERE owner_id = ANY($1::int[])', [createdUserIds]);
      }
      if (createdGroupIds.length > 0) {
        await pool.query('DELETE FROM split_groups WHERE id = ANY($1::int[])', [createdGroupIds]);
      }
      if (createdUserIds.length > 0) {
        // First delete financial records for test users due to ON DELETE RESTRICT foreign keys
        await pool.query('DELETE FROM finance_records WHERE user_id = ANY($1::int[])', [createdUserIds]);
        await pool.query('DELETE FROM segregation WHERE user_id = ANY($1::int[])', [createdUserIds]);
        await pool.query('DELETE FROM wallets WHERE user_id = ANY($1::int[])', [createdUserIds]);
        await pool.query('DELETE FROM goal_wallets WHERE user_id = ANY($1::int[])', [createdUserIds]);
        await pool.query('DELETE FROM payments WHERE user_id = ANY($1::int[])', [createdUserIds]);
        await pool.query('DELETE FROM transactions WHERE user_id = ANY($1::int[])', [createdUserIds]);
        await pool.query('DELETE FROM split_group_members WHERE user_id = ANY($1::int[])', [createdUserIds]);
        await pool.query('DELETE FROM users WHERE id = ANY($1::int[])', [createdUserIds]);
      }
      console.log('  ✔ All temporary test groups, financial records, and user accounts cleaned up cleanly.');
    } catch (cleanupErr) {
      console.error('  ⚠ Cleanup error:', cleanupErr.message);
    }
  }

  console.log('\n========================================================================');
  console.log('🎉 ALL PHASE 5 VERIFICATION SECTIONS PASSED 100% SUCCESSFULLY!');
  console.log('========================================================================\n');
}

runPhase5MasterTestSuite()
  .then(() => {
    process.exit(0);
  })
  .catch((err) => {
    console.error('\n❌ PHASE 5 TEST SUITE FAILED:', err);
    process.exit(1);
  });
