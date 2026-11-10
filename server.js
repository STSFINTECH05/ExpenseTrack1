require('dotenv').config();

const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const pool = require('./db');

const { sessionMiddleware } = require('./config/session');
const { csrfProtection } = require('./middleware/csrf');
const authenticate = require('./middleware/authenticate');
const authRoutes = require('./routes/auth.routes');
const splitsRoutes = require('./routes/splits.routes');
const aiRoutes = require('./routes/ai.routes');

const isDatabaseConfigured = Boolean(process.env.DATABASE_URL);

// In-memory data stores for memory-backed operation when DATABASE_URL is not provided or offline
const inMemoryGoalWallets = [];
const inMemorySegregation = [];
const inMemoryBills = [];
const inMemoryPayments = [];
const inMemoryExpenses = [];

const getUserId = (req) => {
  return (
    req.user?.id ||
    req.user?.userId ||
    req.user?.user_id ||
    req.user?._id ||
    req.userId ||
    req.user?.email ||
    req.session?.userId ||
    req.headers['x-user-id'] ||
    req.headers['x-auth-user-id'] ||
    req.headers['x-user-email'] ||
    null
  );
};

const getUserEmail = (req) => {
  return (
    req.user?.email ||
    req.userEmail ||
    req.headers['x-user-email'] ||
    (req.user?.id && String(req.user.id).includes('@') ? String(req.user.id) : null) ||
    null
  );
};

const query = async (text, params = []) => {
  if (isDatabaseConfigured && pool) {
    try {
      return await pool.query(text, params);
    } catch (err) {
      const isConnErr =
        err.code === 'ECONNREFUSED' ||
        err.code === 'ENOTFOUND' ||
        (err.errors && err.errors.some((e) => e.code === 'ECONNREFUSED')) ||
        err.message?.includes('ECONNREFUSED');
      if (!isConnErr) throw err;
      console.warn('[STS FINTECH] Database connection unavailable; utilizing in-memory store.');
    }
  }

  // Handle in-memory query simulation with user scoping when database is offline
  const sql = (typeof text === 'string' ? text : text?.text || '').toLowerCase();

  // DELETE
  if (sql.includes('delete from goal_wallets') || sql.includes('delete from wallets') || sql.includes('delete from goal_targets')) {
    const id = params[0];
    const userId = params[1];
    const idx = inMemoryGoalWallets.findIndex(
      (w) => String(w.id) === String(id) && (!userId || String(w.user_id) === String(userId))
    );
    if (idx !== -1) {
      const removed = inMemoryGoalWallets.splice(idx, 1);
      return { rows: removed };
    }
    return { rows: [] };
  }

  if (sql.includes('delete from bills')) {
    const id = params[0];
    const userId = params[1];
    const idx = inMemoryBills.findIndex(
      (b) => String(b.id) === String(id) && (!userId || String(b.user_id) === String(userId))
    );
    if (idx !== -1) {
      const removed = inMemoryBills.splice(idx, 1);
      return { rows: removed };
    }
    return { rows: [] };
  }

  if (sql.includes('delete from segregation') || sql.includes('delete from finance_records') || sql.includes('delete from expenses')) {
    const id = params[0];
    const userId = params[1];
    const idx = inMemorySegregation.findIndex(
      (s) => String(s.id) === String(id) && (!userId || String(s.user_id) === String(userId))
    );
    if (idx !== -1) {
      const removed = inMemorySegregation.splice(idx, 1);
      return { rows: removed };
    }
    return { rows: [] };
  }

  // UPDATE
  if (sql.includes('update goal_wallets') || sql.includes('update wallets')) {
    const amount = parseFloat(params[0]) || 0;
    const id = params[1];
    const userId = params[2];
    const item = inMemoryGoalWallets.find(
      (w) => String(w.id) === String(id) && (!userId || String(w.user_id) === String(userId))
    );
    if (item) {
      item.saved_amount = (parseFloat(item.saved_amount) || 0) + amount;
      if (item.saved_amount >= item.target_amount) {
        item.status = 'target_met';
      }
      return { rows: [item] };
    }
    return { rows: [] };
  }

  // SELECT
  if (sql.includes('from goal_wallets') || sql.includes('from wallets') || sql.includes('from goal_targets')) {
    if (sql.includes('where id =')) {
      const id = params[0];
      const userId = params[1];
      const found = inMemoryGoalWallets.find(
        (w) => String(w.id) === String(id) && (!userId || String(w.user_id) === String(userId))
      );
      return { rows: found ? [found] : [] };
    }
    const userId = params[0];
    const list = userId ? inMemoryGoalWallets.filter((w) => String(w.user_id) === String(userId)) : [];
    return { rows: [...list] };
  }

  if (sql.includes('from bills')) {
    const userId = params[0];
    const list = userId ? inMemoryBills.filter((b) => String(b.user_id) === String(userId)) : [];
    return { rows: [...list] };
  }

  if (sql.includes('from segregation') || sql.includes('from finance_records') || sql.includes('from expenses')) {
    if (params.length === 2) {
      const type = params[0];
      const userId = params[1];
      const list = inMemorySegregation.filter(
        (s) => s.type === type && (!userId || String(s.user_id) === String(userId))
      );
      return { rows: [...list] };
    }
    const userId = params[0];
    const list = userId ? inMemorySegregation.filter((s) => String(s.user_id) === String(userId)) : [];
    return { rows: [...list] };
  }

  if (sql.includes('from payments')) {
    const userId = params[0];
    const list = userId ? inMemoryPayments.filter((p) => String(p.user_id) === String(userId)) : [];
    return { rows: [...list] };
  }

  return { rows: [] };
};

const app = express();
const PORT = process.env.PORT || 5000;

const COMPANY_NAME = 'STS FINTECH PRIVATE LIMITED';

const isProduction = process.env.NODE_ENV === 'production';

if (isProduction) {
  app.set('trust proxy', 1);
}

// Frontend origin allowlist configuration
// Supports CLIENT_URLS / CLIENT_URL, local dev ports, and Vercel deployments
const configuredOrigins = (
  process.env.CLIENT_URLS ||
  process.env.CLIENT_URL ||
  'http://localhost:5173,http://localhost:5174,http://localhost:3000,https://expense-track-seven-smoky.vercel.app'
)
  .split(',')
  .map(origin => origin.trim())
  .filter(Boolean);

const defaultAllowedOrigins = [
  'http://localhost:5173',
  'http://localhost:5174',
  'http://localhost:3000',
  'http://127.0.0.1:5173',
  'http://127.0.0.1:5174',
  'http://127.0.0.1:3000',
  'https://expense-track-seven-smoky.vercel.app',
];

const allowedOrigins = Array.from(new Set([...configuredOrigins, ...defaultAllowedOrigins]));

const isOriginAllowed = (origin) => {
  // Allow requests with no origin (like mobile apps, curl, Postman, or same-origin)
  if (!origin) return true;
  // Direct match against allowlist
  if (allowedOrigins.includes(origin)) return true;
  // Allow all STS Fintech Vercel preview/production domains
  if (/^https:\/\/.*\.vercel\.app$/.test(origin)) return true;
  // In development, allow any localhost, 127.0.0.1, or local LAN/private IP port (192.168.x.x, 10.x.x.x, 172.16-31.x.x)
  if (
    !isProduction &&
    /^https?:\/\/(localhost|127\.0\.0\.1|192\.168\.\d+\.\d+|10\.\d+\.\d+\.\d+|172\.(1[6-9]|2\d|3[01])\.\d+\.\d+)(:\d+)?$/.test(origin)
  ) {
    return true;
  }
  return false;
};

const corsOptions = {
  origin: (origin, callback) => {
    if (isOriginAllowed(origin)) {
      return callback(null, true);
    }

    // Return null, false to reject CORS cleanly without throwing a 500 unhandled error
    return callback(null, false);
  },
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: [
    'Content-Type',
    'X-CSRF-Token',
    'X-Company-Name',
    'X-Service',
    'Authorization',
    'x-user-id',
    'x-user-email',
    'x-auth-user-id'
  ],
};

app.use(helmet());

app.use(cors(corsOptions));
app.options('*', cors(corsOptions));

app.use(express.json({ limit: '1mb' }));

// Server-side PostgreSQL sessions
app.use(sessionMiddleware);

// Company Branding Header Middleware
app.use((req, res, next) => {
  res.setHeader('X-Company-Name', COMPANY_NAME);
  res.setHeader('X-Service', 'ExpenseTrack-API');
  next();
});

// Request Logger
app.use((req, res, next) => {
  console.log(`[${new Date().toISOString()}] ${req.method} ${req.url}`);
  next();
});

// Company branding headers
app.use((req, res, next) => {
  res.setHeader('X-Company-Name', COMPANY_NAME);
  res.setHeader('X-Service', 'ExpenseTrack-API');
  next();
});

// CSRF protection for requests with an established session CSRF token
app.use('/api', csrfProtection);

// Authentication endpoints (/api/auth/login, /api/auth/register, /api/auth/csrf, /api/auth/me, /api/auth/logout)
app.use('/api/auth', authRoutes);

<<<<<<< HEAD
// Split & Collect persistent group APIs
app.use('/api/splits', splitsRoutes);

// Financial Intelligence & Analytics APIs
app.use('/api/ai', aiRoutes);

/**
 * GET /health & GET /api/health
 * Operational status and company metadata (Publicly accessible)
 */
=======
// Public Health Check
>>>>>>> 05e1eb0e99dc5cb24da27162ad325b8805b5018b
app.get(['/health', '/api/health'], (req, res) => {
  res.status(200).json({
    status: 'healthy',
    company: COMPANY_NAME,
    service: 'ExpenseTrack Backend API',
    database: isDatabaseConfigured ? 'connected' : 'offline',
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
  });
});

<<<<<<< HEAD
/**
 * =========================================================================
 * PROTECTED FINANCIAL APIs
 * All routes below require valid server-side session authentication.
 * All queries are strictly scoped to req.user.id (INTEGER).
 * =========================================================================
 */

/**
 * GET /api/payments
 * Retrieve payment transactions for the authenticated user
 */
app.get('/api/payments', authenticate, async (req, res) => {
  try {
    const userId = req.user.id;
    const selectQuery = `
      SELECT id, COALESCE(title, name, '') AS title, COALESCE(name, title, '') AS name, amount, status, date, user_id, created_at
      FROM payments
      WHERE user_id = $1
      ORDER BY created_at DESC;
    `;
    const result = await pool.query(selectQuery, [userId]);

    const rows = result.rows || [];
    const formattedRows = rows.map((row) => ({
=======
// Protect all remaining API endpoints
app.use('/api', authenticate);

/**
 * GET /api/bills
 * Retrieve scheduled bills strictly scoped to authenticated user
 */
app.get('/api/bills', async (req, res) => {
  try {
    const userId = getUserId(req);
    if (!userId) {
      return res.status(401).json({ success: false, message: 'Authentication required' });
    }

    let result = { rows: [] };
    try {
      const selectQuery = `
        SELECT id, name, description, date, COALESCE(due_date, date) AS due_date, time, schedule, category, associated_wallet, amount, status, user_id, created_at
        FROM bills
        WHERE user_id = $1
        ORDER BY date DESC, created_at DESC;
      `;
      result = await query(selectQuery, [userId]);
    } catch (err) {
      console.error('Error querying bills table:', err.message);
      // Fallback to segregation WHERE type = 'bill' AND user_id = $1
      try {
        const fallbackQuery = `
          SELECT id, type, name, description, date, time, schedule, category, associated_wallet, amount, user_id, created_at
          FROM segregation
          WHERE type = 'bill' AND user_id = $1
          ORDER BY date DESC, created_at DESC;
        `;
        result = await query(fallbackQuery, [userId]);
      } catch (err2) {
        console.error('Fallback query error:', err2.message);
        return res.status(200).json({ success: true, count: 0, data: [] });
      }
    }

    if (!result || !result.rows || result.rows.length === 0) {
      // Check segregation table if bills table was empty
      try {
        const fallbackQuery = `
          SELECT id, type, name, description, date, time, schedule, category, associated_wallet, amount, user_id, created_at
          FROM segregation
          WHERE type = 'bill' AND user_id = $1
          ORDER BY date DESC, created_at DESC;
        `;
        const fbResult = await query(fallbackQuery, [userId]);
        if (fbResult && fbResult.rows && fbResult.rows.length > 0) {
          result = fbResult;
        }
      } catch (e) {}
    }

    const rows = (result?.rows || []).map((row) => ({
>>>>>>> 05e1eb0e99dc5cb24da27162ad325b8805b5018b
      ...row,
      amount: parseFloat(row.amount) || 0,
      date: row.date ? (typeof row.date === 'string' ? row.date.split('T')[0] : new Date(row.date).toISOString().split('T')[0]) : null,
      due_date: row.due_date ? (typeof row.due_date === 'string' ? row.due_date.split('T')[0] : new Date(row.due_date).toISOString().split('T')[0]) : null,
    }));

    return res.status(200).json({
      success: true,
      count: rows.length,
      data: rows,
      company: COMPANY_NAME,
    });
  } catch (err) {
<<<<<<< HEAD
    console.error('Error fetching payments:', err.message);
    return res.status(500).json({
      success: false,
      message: 'Failed to retrieve payments',
      error: err.message,
    });
=======
    console.error('GET /api/bills error:', err);
    return res.status(500).json({ success: false, message: 'Error retrieving bills', error: err.message });
>>>>>>> 05e1eb0e99dc5cb24da27162ad325b8805b5018b
  }
});

/**
<<<<<<< HEAD
 * POST /api/payments
 * Validate and insert a new payment record assigned to the authenticated user
 */
app.post('/api/payments', authenticate, async (req, res) => {
  try {
    const userId = req.user.id;
    const { title, name, amount, status = 'completed' } = req.body;
    const itemTitle = (title || name || '').trim();
=======
 * POST /api/bills
 * Add a new bill with automatic user_id assignment
 */
app.post('/api/bills', async (req, res) => {
  try {
    const userId = getUserId(req);
    if (!userId) {
      return res.status(401).json({ success: false, message: 'Authentication required' });
    }
>>>>>>> 05e1eb0e99dc5cb24da27162ad325b8805b5018b

    const {
      name,
      description = '',
      date,
      due_date,
      time,
      schedule = 'Monthly (1st)',
      category = 'Utilities',
      associated_wallet = 'Primary Wallet',
      amount = 0,
    } = req.body;

    if (!name || typeof name !== 'string' || name.trim().length === 0) {
      return res.status(400).json({ success: false, message: 'Bill name is required.' });
    }

    const numericAmount = parseFloat(amount);
    if (isNaN(numericAmount) || numericAmount < 0) {
      return res.status(400).json({ success: false, message: 'Amount must be a valid positive number or 0.' });
    }

<<<<<<< HEAD
    const insertQuery = `
      INSERT INTO payments (title, name, amount, status, user_id)
      VALUES ($1, $1, $2, $3, $4)
      RETURNING id, title, name, amount, status, user_id, created_at;
    `;

    const result = await pool.query(insertQuery, [
      itemTitle,
      numericAmount,
      (status || 'completed').toLowerCase(),
      userId,
    ]);

    const createdPayment = {
      ...result.rows[0],
      amount: parseFloat(result.rows[0].amount),
    };
=======
    const cleanDate = date || due_date || new Date().toISOString().split('T')[0];
    const cleanDueDate = due_date || cleanDate;
    const cleanTime = time || new Date().toTimeString().slice(0, 5);

    let createdRecord = null;
    const insertParams = [
      name.trim(),
      description.trim(),
      cleanDate,
      cleanDueDate,
      cleanTime,
      schedule,
      category,
      associated_wallet,
      numericAmount,
      userId,
    ];

    try {
      const insertQuery = `
        INSERT INTO bills (name, description, date, due_date, time, schedule, category, associated_wallet, amount, user_id)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
        RETURNING *;
      `;
      const result = await query(insertQuery, insertParams);
      if (result && result.rows && result.rows.length > 0) {
        createdRecord = {
          ...result.rows[0],
          amount: parseFloat(result.rows[0].amount),
        };
      }
    } catch (dbErr) {
      console.error('Error inserting into bills table:', dbErr.message);
    }

    // Sync into segregation table with type = 'bill' and user_id
    try {
      const syncQuery = `
        INSERT INTO segregation (type, name, description, date, time, schedule, category, associated_wallet, amount, user_id)
        VALUES ('bill', $1, $2, $3, $4, $5, $6, $7, $8, $9)
        RETURNING id, type, name, description, date, time, schedule, category, associated_wallet, amount, user_id, created_at;
      `;
      const segResult = await query(syncQuery, [
        name.trim(),
        description.trim(),
        cleanDate,
        cleanTime,
        schedule,
        category,
        associated_wallet,
        numericAmount,
        userId,
      ]);
      if (!createdRecord && segResult && segResult.rows && segResult.rows.length > 0) {
        createdRecord = {
          ...segResult.rows[0],
          amount: parseFloat(segResult.rows[0].amount),
        };
      }
    } catch (syncErr) {
      console.error('Error syncing bill to segregation:', syncErr.message);
    }

    if (!createdRecord) {
      createdRecord = {
        id: Date.now(),
        name: name.trim(),
        description: description.trim(),
        date: cleanDate,
        due_date: cleanDueDate,
        time: cleanTime,
        schedule,
        category,
        associated_wallet,
        amount: numericAmount,
        user_id: userId,
        created_at: new Date().toISOString(),
      };
      inMemoryBills.unshift(createdRecord);
    }
>>>>>>> 05e1eb0e99dc5cb24da27162ad325b8805b5018b

    return res.status(201).json({
      success: true,
      message: 'Bill created successfully',
      data: createdRecord,
      company: COMPANY_NAME,
    });
  } catch (err) {
    console.error('POST /api/bills error:', err);
    return res.status(500).json({ success: false, message: 'Internal server error while creating bill', error: err.message });
  }
});

/**
 * PUT /api/bills/:id
 * Update an existing bill strictly scoped by user_id
 */
app.put('/api/bills/:id', async (req, res) => {
  try {
    const userId = getUserId(req);
    if (!userId) {
      return res.status(401).json({ success: false, message: 'Authentication required' });
    }

    const { id } = req.params;
    const {
      name,
      description = '',
      date,
      due_date,
      time,
      schedule = 'Monthly (1st)',
      category = 'Utilities',
      associated_wallet = 'Primary Wallet',
      amount = 0,
    } = req.body;

    if (!name || typeof name !== 'string' || name.trim().length === 0) {
      return res.status(400).json({ success: false, message: 'Bill name is required.' });
    }

    const numericAmount = parseFloat(amount);
    if (isNaN(numericAmount) || numericAmount < 0) {
      return res.status(400).json({ success: false, message: 'Amount must be a valid positive number.' });
    }

    const cleanDate = date || due_date || new Date().toISOString().split('T')[0];
    const cleanDueDate = due_date || cleanDate;
    const cleanTime = time || new Date().toTimeString().slice(0, 5);

    let updatedRecord = null;
    try {
      const updateQuery = `
        UPDATE bills
        SET name = $1, description = $2, date = $3, due_date = $4, time = $5, schedule = $6, category = $7, associated_wallet = $8, amount = $9
        WHERE id = $10 AND user_id = $11
        RETURNING *;
      `;
      const result = await query(updateQuery, [
        name.trim(),
        description.trim(),
        cleanDate,
        cleanDueDate,
        cleanTime,
        schedule,
        category,
        associated_wallet,
        numericAmount,
        parseInt(id, 10),
        userId,
      ]);
      if (result && result.rows && result.rows.length > 0) {
        updatedRecord = {
          ...result.rows[0],
          amount: parseFloat(result.rows[0].amount),
        };
      }
    } catch (e) {}

    // Also update segregation if exists
    try {
      const updateSegQuery = `
        UPDATE segregation
        SET name = $1, description = $2, date = $3, time = $4, schedule = $5, category = $6, associated_wallet = $7, amount = $8
        WHERE id = $9 AND user_id = $10
        RETURNING *;
      `;
      const segResult = await query(updateSegQuery, [
        name.trim(),
        description.trim(),
        cleanDate,
        cleanTime,
        schedule,
        category,
        associated_wallet,
        numericAmount,
        parseInt(id, 10),
        userId,
      ]);
      if (!updatedRecord && segResult && segResult.rows && segResult.rows.length > 0) {
        updatedRecord = {
          ...segResult.rows[0],
          amount: parseFloat(segResult.rows[0].amount),
        };
      }
    } catch (e) {}

    if (!updatedRecord) {
      return res.status(404).json({ success: false, message: 'Bill not found or unauthorized' });
    }

    return res.status(200).json({
      success: true,
      message: 'Bill updated successfully',
      data: updatedRecord,
      company: COMPANY_NAME,
    });
  } catch (err) {
    console.error('PUT /api/bills/:id error:', err);
    return res.status(500).json({ success: false, message: 'Internal server error while updating bill', error: err.message });
  }
});

/**
 * DELETE /api/bills/:id
 * Remove a bill strictly scoped by user_id
 */
app.delete('/api/bills/:id', async (req, res) => {
  try {
    const userId = getUserId(req);
    if (!userId) {
      return res.status(401).json({ success: false, message: 'Authentication required' });
    }

    const { id } = req.params;
    let deleted = false;

    try {
      const deleteBillsQuery = `DELETE FROM bills WHERE id = $1 AND user_id = $2 RETURNING id;`;
      const bRes = await query(deleteBillsQuery, [parseInt(id, 10), userId]);
      if (bRes && bRes.rows && bRes.rows.length > 0) deleted = true;
    } catch (e) {}

    try {
      const deleteSegQuery = `DELETE FROM segregation WHERE id = $1 AND user_id = $2 RETURNING id;`;
      const sRes = await query(deleteSegQuery, [parseInt(id, 10), userId]);
      if (sRes && sRes.rows && sRes.rows.length > 0) deleted = true;
    } catch (e) {}

    if (!deleted) {
      return res.status(404).json({ success: false, message: 'Bill not found or unauthorized' });
    }

    return res.status(200).json({
      success: true,
      message: 'Bill deleted successfully',
      id: parseInt(id, 10),
      company: COMPANY_NAME,
    });
  } catch (err) {
    console.error('DELETE /api/bills/:id error:', err);
    return res.status(500).json({ success: false, message: 'Internal server error while deleting bill', error: err.message });
  }
});

/**
<<<<<<< HEAD
 * GET /api/segregation & GET /api/finance-records
 * Retrieve finance segregation records for the authenticated user
=======
 * GET /api/segregation
 * Retrieve finance segregation records strictly scoped to authenticated user
>>>>>>> 05e1eb0e99dc5cb24da27162ad325b8805b5018b
 */
app.get(['/api/segregation', '/api/finance-records'], authenticate, async (req, res) => {
  try {
<<<<<<< HEAD
    const userId = req.user.id;
=======
    const userId = getUserId(req);
    if (!userId) {
      return res.status(401).json({ success: false, message: 'Authentication required' });
    }

>>>>>>> 05e1eb0e99dc5cb24da27162ad325b8805b5018b
    const { type } = req.query;

    const selectSegregation = type
      ? `SELECT id, type, name, description, date, time, schedule, category, associated_wallet, wallet_id, amount, user_id, created_at
         FROM segregation
         WHERE user_id = $1 AND type = $2
         ORDER BY date DESC, created_at DESC;`
      : `SELECT id, type, name, description, date, time, schedule, category, associated_wallet, wallet_id, amount, user_id, created_at
         FROM segregation
         WHERE user_id = $1
         ORDER BY date DESC, created_at DESC;`;

    const params = type ? [userId, type] : [userId];
    let result = await pool.query(selectSegregation, params);

    // If segregation table has no records for this user, check finance_records scoped to user
    if (!result.rows || result.rows.length === 0) {
      const selectFinance = type
        ? `SELECT id, type, name, description, date, time, schedule, category, associated_wallet, wallet_id, amount, user_id, created_at
<<<<<<< HEAD
           FROM finance_records
           WHERE user_id = $1 AND type = $2
           ORDER BY date DESC, created_at DESC;`
        : `SELECT id, type, name, description, date, time, schedule, category, associated_wallet, wallet_id, amount, user_id, created_at
           FROM finance_records
           WHERE user_id = $1
           ORDER BY date DESC, created_at DESC;`;
      const finResult = await pool.query(selectFinance, params);
      if (finResult.rows && finResult.rows.length > 0) {
        result = finResult;
      }
    }

    const rows = result.rows || [];
    const formattedRows = rows.map((row) => ({
=======
           FROM segregation
           WHERE type = $1 AND user_id = $2
           ORDER BY date DESC, created_at DESC;`
        : `SELECT id, type, name, description, date, time, schedule, category, associated_wallet, wallet_id, amount, user_id, created_at
           FROM segregation
           WHERE user_id = $1
           ORDER BY date DESC, created_at DESC;`;
      result = await query(selectQuery, type ? [type, userId] : [userId]);
    } catch (err) {
      console.error('Error querying segregation:', err.message);
      // Fallback to finance_records if segregation table query failed
      try {
        const selectQuery = type
          ? `SELECT id, type, name, description, date, time, schedule, category, associated_wallet, wallet_id, amount, user_id, created_at
             FROM finance_records
             WHERE type = $1 AND user_id = $2
             ORDER BY date DESC, created_at DESC;`
          : `SELECT id, type, name, description, date, time, schedule, category, associated_wallet, wallet_id, amount, user_id, created_at
             FROM finance_records
             WHERE user_id = $1
             ORDER BY date DESC, created_at DESC;`;
        result = await query(selectQuery, type ? [type, userId] : [userId]);
      } catch (err2) {
        console.error('Fallback finance_records error:', err2.message);
        return res.status(200).json({ success: true, count: 0, data: [] });
      }
    }

    if (!result || !result.rows || result.rows.length === 0) {
      // If type === 'bill' and segregation is empty, check bills table
      if (type === 'bill') {
        try {
          const bResult = await query(
            `SELECT id, 'bill' AS type, name, description, date, time, schedule, category, associated_wallet, amount, user_id, created_at
             FROM bills
             WHERE user_id = $1
             ORDER BY date DESC, created_at DESC;`,
            [userId]
          );
          if (bResult && bResult.rows && bResult.rows.length > 0) {
            result = bResult;
          }
        } catch (e) {}
      }
    }

    const formattedRows = (result?.rows || []).map((row) => ({
>>>>>>> 05e1eb0e99dc5cb24da27162ad325b8805b5018b
      ...row,
      amount: parseFloat(row.amount) || 0,
      date: row.date
        ? typeof row.date === 'string'
          ? row.date.split('T')[0]
          : new Date(row.date).toISOString().split('T')[0]
        : null,
    }));

    const uniqueRows = Array.from(new Map(formattedRows.map((item) => [item.id || item.name, item])).values());

    return res.status(200).json({
      success: true,
      count: uniqueRows.length,
      data: uniqueRows,
      company: COMPANY_NAME,
    });
  } catch (err) {
<<<<<<< HEAD
    console.error('Unhandled segregation fetch error:', err.message);
    return res.status(500).json({
      success: false,
      message: 'Failed to retrieve finance records',
      error: err.message,
    });
=======
    console.error('GET /api/segregation error:', err);
    return res.status(200).json({ success: true, count: 0, data: [] });
>>>>>>> 05e1eb0e99dc5cb24da27162ad325b8805b5018b
  }
});

/**
<<<<<<< HEAD
 * POST /api/segregation & POST /api/finance-records
 * Create a new finance segregation record for the authenticated user
=======
 * POST /api/segregation
 * Validate and persist new finance records scoped to user_id
>>>>>>> 05e1eb0e99dc5cb24da27162ad325b8805b5018b
 */
app.post(['/api/segregation', '/api/finance-records'], authenticate, async (req, res) => {
  try {
<<<<<<< HEAD
    const userId = req.user.id;
=======
    const userId = getUserId(req);
    if (!userId) {
      return res.status(401).json({ success: false, message: 'Authentication required' });
    }

>>>>>>> 05e1eb0e99dc5cb24da27162ad325b8805b5018b
    const {
      type,
      name,
      description = '',
      date,
      time,
      schedule = 'One-time',
      category = 'General',
      associated_wallet = 'Primary Wallet',
      amount = 0,
    } = req.body;

    const errors = [];
    const validTypes = ['additional_income', 'additional_expense', 'fixed_income', 'fixed_expense', 'bill'];

    if (!type || !validTypes.includes(type)) {
      errors.push(`Type is required and must be one of: ${validTypes.join(', ')}.`);
    }

    if (!name || typeof name !== 'string' || name.trim().length === 0) {
      errors.push('Record name is required.');
    }

    const numericAmount = parseFloat(amount);
    if (isNaN(numericAmount) || numericAmount < 0) {
      errors.push('Amount must be a valid positive number or 0.');
    }

    if (errors.length > 0) {
      return res.status(400).json({
        success: false,
        message: 'Validation failed',
        errors,
      });
    }

    const cleanDate = date || new Date().toISOString().split('T')[0];
    const cleanTime = time || new Date().toTimeString().slice(0, 5);

    const insertParams = [
      type,
      name.trim(),
      description.trim(),
      cleanDate,
      cleanTime,
      schedule,
      category,
      associated_wallet,
      numericAmount,
      userId,
    ];

<<<<<<< HEAD
    const insertSegregationQuery = `
      INSERT INTO segregation (type, name, description, date, time, schedule, category, associated_wallet, amount, user_id)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
      RETURNING id, type, name, description, date, time, schedule, category, associated_wallet, amount, user_id, created_at;
    `;
    const result = await pool.query(insertSegregationQuery, insertParams);
=======
    try {
      const insertSegregationQuery = `
        INSERT INTO segregation (type, name, description, date, time, schedule, category, associated_wallet, amount, user_id)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
        RETURNING id, type, name, description, date, time, schedule, category, associated_wallet, amount, user_id, created_at;
      `;
      result = await query(insertSegregationQuery, insertParams);
    } catch (e) {}
>>>>>>> 05e1eb0e99dc5cb24da27162ad325b8805b5018b

    // Dual-write to finance_records for consistency
    try {
      const insertFinanceQuery = `
        INSERT INTO finance_records (type, name, description, date, time, schedule, category, associated_wallet, amount, user_id)
<<<<<<< HEAD
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10);
=======
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
        RETURNING id, type, name, description, date, time, schedule, category, associated_wallet, amount, user_id, created_at;
>>>>>>> 05e1eb0e99dc5cb24da27162ad325b8805b5018b
      `;
      await pool.query(insertFinanceQuery, insertParams);
    } catch (e) {}

    // If type === 'bill', also sync into bills table
    if (type === 'bill') {
      try {
        await query(
          `INSERT INTO bills (name, description, date, due_date, time, schedule, category, associated_wallet, amount, user_id)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10);`,
          [name.trim(), description.trim(), cleanDate, cleanDate, cleanTime, schedule, category, associated_wallet, numericAmount, userId]
        );
      } catch (e) {}
    }

<<<<<<< HEAD
=======
    // If type is expense, sync into expenses table
    if (type === 'additional_expense' || type === 'fixed_expense') {
      try {
        await query(
          `INSERT INTO expenses (name, description, date, time, category, associated_wallet, amount, type, user_id)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9);`,
          [name.trim(), description.trim(), cleanDate, cleanTime, category, associated_wallet, numericAmount, type, userId]
        );
      } catch (e) {}
    }

    let createdRecord;
    if (result && result.rows && result.rows.length > 0) {
      createdRecord = {
        ...result.rows[0],
        amount: parseFloat(result.rows[0].amount),
      };
    } else {
      createdRecord = {
        id: Date.now(),
        type,
        name: name.trim(),
        description: description.trim(),
        date: cleanDate,
        time: cleanTime,
        schedule,
        category,
        associated_wallet,
        amount: numericAmount,
        user_id: userId,
        created_at: new Date().toISOString(),
      };
      inMemorySegregation.unshift(createdRecord);
    }

    console.log(`[STS FINTECH] Segregation record created: ${createdRecord.type} - "${createdRecord.name}" (₹${createdRecord.amount}) for user ${userId}`);

>>>>>>> 05e1eb0e99dc5cb24da27162ad325b8805b5018b
    return res.status(201).json({
      success: true,
      message: 'Finance record created successfully',
      data: createdRecord,
      company: COMPANY_NAME,
    });
  } catch (error) {
    console.error('Error creating segregation record:', error);
    return res.status(500).json({
      success: false,
      message: 'Internal server error while creating finance record',
      error: error.message,
    });
  }
});

/**
<<<<<<< HEAD
 * PUT /api/segregation/:id & PUT /api/finance-records/:id
 * Update an existing finance record owned by the authenticated user
=======
 * PUT /api/segregation/:id
 * Update an existing finance record strictly scoped by user_id
>>>>>>> 05e1eb0e99dc5cb24da27162ad325b8805b5018b
 */
app.put(['/api/segregation/:id', '/api/finance-records/:id'], authenticate, async (req, res) => {
  try {
<<<<<<< HEAD
    const userId = req.user.id;
=======
    const userId = getUserId(req);
    if (!userId) {
      return res.status(401).json({ success: false, message: 'Authentication required' });
    }

>>>>>>> 05e1eb0e99dc5cb24da27162ad325b8805b5018b
    const { id } = req.params;
    const recordId = parseInt(id, 10);

    if (isNaN(recordId)) {
      return res.status(400).json({
        success: false,
        message: 'Invalid record ID.',
      });
    }

    const {
      name,
      description = '',
      date,
      time,
      schedule = 'One-time',
      category = 'General',
      associated_wallet = 'Primary Wallet',
      amount = 0,
    } = req.body;

    if (!name || typeof name !== 'string' || name.trim().length === 0) {
      return res.status(400).json({
        success: false,
        message: 'Record name is required.',
      });
    }

    const numericAmount = parseFloat(amount);
    if (isNaN(numericAmount) || numericAmount < 0) {
      return res.status(400).json({
        success: false,
        message: 'Amount must be a valid positive number.',
      });
    }

    const cleanDate = date || new Date().toISOString().split('T')[0];
    const cleanTime = time || new Date().toTimeString().slice(0, 5);

    const updateParams = [
      name.trim(),
      description.trim(),
      cleanDate,
      cleanTime,
      schedule,
      category,
      associated_wallet,
      numericAmount,
<<<<<<< HEAD
      recordId,
      userId,
    ];

    const updateSegQuery = `
      UPDATE segregation
      SET name = $1, description = $2, date = $3, time = $4, schedule = $5, category = $6, associated_wallet = $7, amount = $8
      WHERE id = $9 AND user_id = $10
      RETURNING id, type, name, description, date, time, schedule, category, associated_wallet, amount, user_id, created_at;
    `;
    let result = await pool.query(updateSegQuery, updateParams);
=======
      parseInt(id, 10),
      userId,
    ];

    let result;
    try {
      const updateSegQuery = `
        UPDATE segregation
        SET name = $1, description = $2, date = $3, time = $4, schedule = $5, category = $6, associated_wallet = $7, amount = $8
        WHERE id = $9 AND user_id = $10
        RETURNING id, type, name, description, date, time, schedule, category, associated_wallet, amount, user_id, created_at;
      `;
      result = await query(updateSegQuery, updateParams);
    } catch (e) {}
>>>>>>> 05e1eb0e99dc5cb24da27162ad325b8805b5018b

    // Also update finance_records if segregation was not matched
    if (!result.rows || result.rows.length === 0) {
      const updateFinQuery = `
        UPDATE finance_records
        SET name = $1, description = $2, date = $3, time = $4, schedule = $5, category = $6, associated_wallet = $7, amount = $8
        WHERE id = $9 AND user_id = $10
        RETURNING id, type, name, description, date, time, schedule, category, associated_wallet, amount, user_id, created_at;
      `;
      result = await pool.query(updateFinQuery, updateParams);
    } else {
      // Dual-sync update to finance_records
      try {
        const updateFinQuery = `
          UPDATE finance_records
          SET name = $1, description = $2, date = $3, time = $4, schedule = $5, category = $6, associated_wallet = $7, amount = $8
          WHERE id = $9 AND user_id = $10;
        `;
        await pool.query(updateFinQuery, updateParams);
      } catch (e) {}
    }

    if (!result.rows || result.rows.length === 0) {
      return res.status(404).json({
        success: false,
<<<<<<< HEAD
        message: 'Finance record not found.',
=======
        message: 'Record not found or unauthorized',
>>>>>>> 05e1eb0e99dc5cb24da27162ad325b8805b5018b
      });
    }

    const updatedRecord = {
      ...result.rows[0],
      amount: parseFloat(result.rows[0].amount),
      date: result.rows[0].date
        ? typeof result.rows[0].date === 'string'
          ? result.rows[0].date.split('T')[0]
          : new Date(result.rows[0].date).toISOString().split('T')[0]
        : null,
    };

    return res.status(200).json({
      success: true,
      message: 'Finance record updated successfully',
      data: updatedRecord,
      company: COMPANY_NAME,
    });
  } catch (error) {
    console.error('Error updating segregation record:', error);
    return res.status(500).json({
      success: false,
      message: 'Internal server error while updating finance record',
      error: error.message,
    });
  }
});

/**
<<<<<<< HEAD
 * DELETE /api/segregation/:id & DELETE /api/finance-records/:id
 * Delete a finance record owned by the authenticated user
=======
 * DELETE /api/segregation/:id
 * Remove a finance record strictly scoped by user_id
>>>>>>> 05e1eb0e99dc5cb24da27162ad325b8805b5018b
 */
app.delete(['/api/segregation/:id', '/api/finance-records/:id'], authenticate, async (req, res) => {
  try {
<<<<<<< HEAD
    const userId = req.user.id;
    const { id } = req.params;
    const recordId = parseInt(id, 10);

    if (isNaN(recordId)) {
      return res.status(400).json({
        success: false,
        message: 'Invalid record ID.',
      });
    }

    const delSeg = await pool.query('DELETE FROM segregation WHERE id = $1 AND user_id = $2 RETURNING id;', [recordId, userId]);
    const delFin = await pool.query('DELETE FROM finance_records WHERE id = $1 AND user_id = $2 RETURNING id;', [recordId, userId]);

    if ((!delSeg.rows || delSeg.rows.length === 0) && (!delFin.rows || delFin.rows.length === 0)) {
      return res.status(404).json({
        success: false,
        message: 'Finance record not found.',
      });
    }
=======
    const userId = getUserId(req);
    if (!userId) {
      return res.status(401).json({ success: false, message: 'Authentication required' });
    }

    const { id } = req.params;
    let deleted = false;

    try {
      const sRes = await query(`DELETE FROM segregation WHERE id = $1 AND user_id = $2 RETURNING id;`, [parseInt(id, 10), userId]);
      if (sRes && sRes.rows && sRes.rows.length > 0) deleted = true;
    } catch (e) {}

    try {
      const fRes = await query(`DELETE FROM finance_records WHERE id = $1 AND user_id = $2 RETURNING id;`, [parseInt(id, 10), userId]);
      if (fRes && fRes.rows && fRes.rows.length > 0) deleted = true;
    } catch (e) {}

    try {
      const bRes = await query(`DELETE FROM bills WHERE id = $1 AND user_id = $2 RETURNING id;`, [parseInt(id, 10), userId]);
      if (bRes && bRes.rows && bRes.rows.length > 0) deleted = true;
    } catch (e) {}

    if (!deleted) {
      return res.status(404).json({
        success: false,
        message: 'Record not found or unauthorized',
      });
    }

    console.log(`[STS FINTECH] Segregation record deleted: ID ${id} for user ${userId}`);
>>>>>>> 05e1eb0e99dc5cb24da27162ad325b8805b5018b

    return res.status(200).json({
      success: true,
      message: 'Finance record deleted successfully',
      id: recordId,
      company: COMPANY_NAME,
    });
  } catch (error) {
    console.error('Error deleting segregation record:', error);
    return res.status(500).json({
      success: false,
      message: 'Internal server error while deleting finance record',
      error: error.message,
    });
  }
});

/**
<<<<<<< HEAD
 * GET /api/wallets & GET /api/goal-wallets
 * Retrieve all segregated goal wallets for the authenticated user
=======
 * GET /api/wallets
 * Retrieve all segregated goal wallets strictly scoped to authenticated user
>>>>>>> 05e1eb0e99dc5cb24da27162ad325b8805b5018b
 */
app.get(['/api/wallets', '/api/goal-wallets'], authenticate, async (req, res) => {
  try {
<<<<<<< HEAD
    const userId = req.user.id;
    const selectQuery = `
      SELECT id, name, target_amount, saved_amount, description, status, type, balance, user_id, created_at
      FROM goal_wallets
      WHERE user_id = $1
      ORDER BY created_at DESC;
    `;
    let result = await pool.query(selectQuery, [userId]);

    if (!result.rows || result.rows.length === 0) {
      const fallbackQuery = `
        SELECT id, name, COALESCE(target_amount, balance, 0) AS target_amount, COALESCE(saved_amount, balance, 0) AS saved_amount, description, status, type, balance, user_id, created_at
        FROM wallets
        WHERE user_id = $1
        ORDER BY created_at DESC;
      `;
      const fbResult = await pool.query(fallbackQuery, [userId]);
      if (fbResult.rows && fbResult.rows.length > 0) {
        result = fbResult;
      }
    }

    const rows = result.rows || [];
    const formattedRows = rows.map((row) => ({
=======
    const userId = getUserId(req);
    if (!userId) {
      return res.status(401).json({ success: false, message: 'Authentication required' });
    }

    let result = { rows: [] };

    try {
      const selectQuery = `
        SELECT id, name, target_amount, saved_amount, description, status, type, balance, user_id, created_at
        FROM goal_wallets
        WHERE user_id = $1
        ORDER BY created_at DESC;
      `;
      result = await query(selectQuery, [userId]);
    } catch (err) {
      console.error('Error querying goal_wallets:', err.message);
      try {
        const fallbackQuery = `
          SELECT id, name, COALESCE(target_amount, balance, 0) AS target_amount, COALESCE(saved_amount, balance, 0) AS saved_amount, description, status, type, balance, user_id, created_at
          FROM goal_targets
          WHERE user_id = $1
          ORDER BY created_at DESC;
        `;
        result = await query(fallbackQuery, [userId]);
      } catch (err2) {
        try {
          const fallbackQuery2 = `
            SELECT id, name, COALESCE(target_amount, balance, 0) AS target_amount, COALESCE(saved_amount, balance, 0) AS saved_amount, description, status, type, balance, user_id, created_at
            FROM wallets
            WHERE user_id = $1
            ORDER BY created_at DESC;
          `;
          result = await query(fallbackQuery2, [userId]);
        } catch (err3) {
          return res.status(200).json({ success: true, count: 0, data: [] });
        }
      }
    }

    if (!result || !result.rows || result.rows.length === 0) {
      try {
        const fallbackQuery = `
          SELECT id, name, COALESCE(target_amount, balance, 0) AS target_amount, COALESCE(saved_amount, balance, 0) AS saved_amount, description, status, type, balance, user_id, created_at
          FROM goal_targets
          WHERE user_id = $1
          ORDER BY created_at DESC;
        `;
        const fbResult = await query(fallbackQuery, [userId]);
        if (fbResult && fbResult.rows && fbResult.rows.length > 0) {
          result = fbResult;
        } else {
          const fb2 = await query(
            `SELECT id, name, COALESCE(target_amount, balance, 0) AS target_amount, COALESCE(saved_amount, balance, 0) AS saved_amount, description, status, type, balance, user_id, created_at
             FROM wallets
             WHERE user_id = $1
             ORDER BY created_at DESC;`,
            [userId]
          );
          if (fb2 && fb2.rows && fb2.rows.length > 0) {
            result = fb2;
          }
        }
      } catch (e) {}
    }

    const formattedRows = (result?.rows || []).map((row) => ({
>>>>>>> 05e1eb0e99dc5cb24da27162ad325b8805b5018b
      ...row,
      target_amount: parseFloat(row.target_amount) || parseFloat(row.balance) || 0,
      saved_amount: parseFloat(row.saved_amount) || 0,
    }));

    return res.status(200).json({
      success: true,
      count: formattedRows.length,
      data: formattedRows,
      company: COMPANY_NAME,
    });
  } catch (err) {
<<<<<<< HEAD
    console.error('Error fetching wallets:', err.message);
    return res.status(500).json({
      success: false,
      message: 'Failed to retrieve wallets',
      error: err.message,
    });
=======
    console.error('GET /api/wallets error:', err.message);
    return res.status(200).json({ success: true, count: 0, data: [] });
>>>>>>> 05e1eb0e99dc5cb24da27162ad325b8805b5018b
  }
});

/**
<<<<<<< HEAD
 * POST /api/wallets & POST /api/goal-wallets
 * Setup a new purpose target wallet assigned to the authenticated user
=======
 * POST /api/wallets
 * Setup a new purpose target wallet scoped to user_id
>>>>>>> 05e1eb0e99dc5cb24da27162ad325b8805b5018b
 */
app.post(['/api/wallets', '/api/goal-wallets'], authenticate, async (req, res) => {
  try {
<<<<<<< HEAD
    const userId = req.user.id;
=======
    const userId = getUserId(req);
    if (!userId) {
      return res.status(401).json({ success: false, message: 'Authentication required' });
    }
>>>>>>> 05e1eb0e99dc5cb24da27162ad325b8805b5018b

    const rawName =
      req.body.name ??
      req.body.purpose ??
      req.body.purposeName ??
      req.body.itemName ??
      req.body.item_name ??
      req.body.title ??
      '';
    const cleanName = typeof rawName === 'string' ? rawName.trim() : String(rawName || '').trim();

    if (!cleanName || cleanName.length === 0) {
      return res.status(400).json({
        success: false,
        message: 'Purpose / Item name is required.',
      });
    }

    const rawTarget =
      req.body.target_amount ??
      req.body.targetAmount ??
      req.body.target_cap ??
      req.body.targetCap ??
      req.body.amount;
    const numericTarget = typeof rawTarget === 'number' ? rawTarget : parseFloat(rawTarget);

    if (rawTarget === undefined || rawTarget === null || isNaN(numericTarget) || numericTarget <= 0) {
      return res.status(400).json({
        success: false,
        message: 'Target cap amount must be a positive number greater than 0.',
      });
    }

    const rawDescription = req.body.description ?? req.body.notes ?? req.body.descriptiveNotes ?? '';
    const cleanDescription = typeof rawDescription === 'string' ? rawDescription.trim() : String(rawDescription || '').trim();

    const rawType = req.body.type ?? req.body.category ?? 'goal';
    const cleanType = typeof rawType === 'string' && rawType.trim().length > 0 ? rawType.trim() : 'goal';

<<<<<<< HEAD
    const insertFullQuery = `
      INSERT INTO goal_wallets (name, target_amount, saved_amount, description, status, type, balance, user_id)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
      RETURNING id, name, target_amount, saved_amount, description, status, type, balance, user_id, created_at;
    `;
    const result = await pool.query(insertFullQuery, [
      cleanName,
      numericTarget,
      0.0,
      cleanDescription,
      'in_progress',
      cleanType,
      0.0,
      userId,
    ]);

    const createdWallet = {
      ...result.rows[0],
      target_amount: parseFloat(result.rows[0].target_amount) || numericTarget,
      saved_amount: parseFloat(result.rows[0].saved_amount) || 0,
    };
=======
    let createdWallet = null;

    if (isDatabaseConfigured && pool) {
      try {
        const insertFullQuery = `
          INSERT INTO goal_wallets (name, target_amount, saved_amount, description, status, type, balance, user_id)
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
          RETURNING id, name, target_amount, saved_amount, description, status, type, balance, user_id, created_at;
        `;
        const result = await pool.query(insertFullQuery, [
          cleanName,
          numericTarget,
          0.0,
          cleanDescription,
          'in_progress',
          cleanType,
          0.0,
          userId,
        ]);

        if (result.rows && result.rows.length > 0) {
          createdWallet = {
            ...result.rows[0],
            target_amount: parseFloat(result.rows[0].target_amount) || numericTarget,
            saved_amount: parseFloat(result.rows[0].saved_amount) || 0,
          };
        }
      } catch (dbErr) {
        console.error('[STS FINTECH] Error inserting into goal_wallets table:', dbErr.message || dbErr);

        // Fallback to goal_targets table
        try {
          const insertGtQuery = `
            INSERT INTO goal_targets (name, target_amount, saved_amount, description, status, type, balance, user_id)
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
            RETURNING id, name, target_amount, saved_amount, description, status, type, balance, user_id, created_at;
          `;
          const gtRes = await pool.query(insertGtQuery, [
            cleanName,
            numericTarget,
            0.0,
            cleanDescription,
            'in_progress',
            cleanType,
            0.0,
            userId,
          ]);
          if (gtRes.rows && gtRes.rows.length > 0) {
            createdWallet = {
              ...gtRes.rows[0],
              target_amount: parseFloat(gtRes.rows[0].target_amount) || numericTarget,
              saved_amount: parseFloat(gtRes.rows[0].saved_amount) || 0,
            };
          }
        } catch (gtErr) {}

        // Fallback to wallets table
        if (!createdWallet) {
          try {
            const insertWalletsQuery = `
              INSERT INTO wallets (name, type, balance, target_amount, saved_amount, description, status, user_id)
              VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
              RETURNING id, name, target_amount, saved_amount, description, status, type, balance, user_id, created_at;
            `;
            const wResult = await pool.query(insertWalletsQuery, [
              cleanName,
              cleanType,
              0.0,
              numericTarget,
              0.0,
              cleanDescription,
              'in_progress',
              userId,
            ]);
            if (wResult.rows && wResult.rows.length > 0) {
              createdWallet = {
                ...wResult.rows[0],
                target_amount: parseFloat(wResult.rows[0].target_amount) || numericTarget,
                saved_amount: parseFloat(wResult.rows[0].saved_amount) || 0,
              };
            }
          } catch (wErr) {}
        }
      }
    }

    if (!createdWallet) {
      const nextId =
        inMemoryGoalWallets.length > 0
          ? Math.max(...inMemoryGoalWallets.map((w) => Number(w.id) || 0)) + 1
          : 1;

      createdWallet = {
        id: nextId,
        name: cleanName,
        target_amount: numericTarget,
        saved_amount: 0.0,
        balance: 0.0,
        description: cleanDescription,
        status: 'in_progress',
        type: cleanType,
        user_id: userId,
        created_at: new Date().toISOString(),
      };
      inMemoryGoalWallets.unshift(createdWallet);
    } else {
      inMemoryGoalWallets.unshift(createdWallet);
    }
>>>>>>> 05e1eb0e99dc5cb24da27162ad325b8805b5018b

    console.log(`[STS FINTECH] Goal wallet created: "${createdWallet.name}" (Target: ₹${createdWallet.target_amount}) for user ${userId}`);

    return res.status(201).json({
      success: true,
      message: 'Target wallet activated successfully',
      data: createdWallet,
      company: COMPANY_NAME,
    });
  } catch (error) {
<<<<<<< HEAD
    console.error('Error creating wallet:', error);
=======
    console.error('[STS FINTECH] Error in POST /api/wallets:', error);
>>>>>>> 05e1eb0e99dc5cb24da27162ad325b8805b5018b
    return res.status(500).json({
      success: false,
      message: 'Failed to create goal wallet',
      error: error.message,
    });
  }
});

/**
<<<<<<< HEAD
 * POST /api/wallets/:id/add-cash & POST /api/goal-wallets/:id/add-cash
 * Allocate cash towards an owned goal wallet
=======
 * POST /api/wallets/:id/add-cash
 * Allocate cash towards a goal wallet strictly scoped by user_id
>>>>>>> 05e1eb0e99dc5cb24da27162ad325b8805b5018b
 */
app.post(['/api/wallets/:id/add-cash', '/api/goal-wallets/:id/add-cash'], authenticate, async (req, res) => {
  try {
<<<<<<< HEAD
    const userId = req.user.id;
=======
    const userId = getUserId(req);
    if (!userId) {
      return res.status(401).json({ success: false, message: 'Authentication required' });
    }

>>>>>>> 05e1eb0e99dc5cb24da27162ad325b8805b5018b
    const { id } = req.params;
    const walletId = parseInt(id, 10);

    if (isNaN(walletId)) {
      return res.status(400).json({
        success: false,
        message: 'Invalid wallet ID.',
      });
    }

    const { amount } = req.body;
    const numericAmount = parseFloat(amount);
    if (isNaN(numericAmount) || numericAmount <= 0) {
      return res.status(400).json({
        success: false,
        message: 'Cash deposit amount must be greater than 0.',
      });
    }

<<<<<<< HEAD
    // Verify wallet ownership
=======
    // Check existing wallet strictly scoped by user_id
>>>>>>> 05e1eb0e99dc5cb24da27162ad325b8805b5018b
    const checkQuery = `
      SELECT id, name, target_amount, saved_amount, status
      FROM goal_wallets
      WHERE id = $1 AND user_id = $2;
    `;
<<<<<<< HEAD
    let checkResult = await pool.query(checkQuery, [walletId, userId]);

    if (!checkResult.rows || checkResult.rows.length === 0) {
      const checkWallets = `SELECT id, name, COALESCE(target_amount, balance, 0) AS target_amount, saved_amount, status FROM wallets WHERE id = $1 AND user_id = $2;`;
      checkResult = await pool.query(checkWallets, [walletId, userId]);
      if (!checkResult.rows || checkResult.rows.length === 0) {
        return res.status(404).json({
          success: false,
          message: 'Wallet container not found.',
        });
      }
=======
    let checkResult = await query(checkQuery, [id, userId]);
    if (!checkResult.rows || checkResult.rows.length === 0) {
      // Check goal_targets
      try {
        checkResult = await query(`SELECT id, name, target_amount, saved_amount, status FROM goal_targets WHERE id = $1 AND user_id = $2;`, [id, userId]);
      } catch (e) {}
    }

    if (!checkResult.rows || checkResult.rows.length === 0) {
      return res.status(404).json({
        success: false,
        message: 'Wallet container not found or unauthorized',
      });
>>>>>>> 05e1eb0e99dc5cb24da27162ad325b8805b5018b
    }

    const currentWallet = checkResult.rows[0];
    const currentSaved = parseFloat(currentWallet.saved_amount) || 0;
    const currentTarget = parseFloat(currentWallet.target_amount) || 0;
    const remaining = Math.max(0, currentTarget - currentSaved);

    if (numericAmount > remaining) {
      return res.status(400).json({
        success: false,
        message: `Deposit cannot exceed the target ceiling. Maximum remaining deposit is ₹${remaining}.`,
      });
    }

    const updateQuery = `
      UPDATE goal_wallets
      SET saved_amount = saved_amount + $1,
          status = CASE WHEN (saved_amount + $1) >= target_amount THEN 'target_met' ELSE status END
      WHERE id = $2 AND user_id = $3
<<<<<<< HEAD
      RETURNING id, name, target_amount, saved_amount, description, status, user_id, created_at;
=======
      RETURNING id, name, target_amount, saved_amount, description, status, created_at;
>>>>>>> 05e1eb0e99dc5cb24da27162ad325b8805b5018b
    `;
    let result = await pool.query(updateQuery, [numericAmount, walletId, userId]);

<<<<<<< HEAD
    if (!result.rows || result.rows.length === 0) {
      const updateWalletsQuery = `
        UPDATE wallets
        SET saved_amount = saved_amount + $1,
            status = CASE WHEN (saved_amount + $1) >= target_amount THEN 'target_met' ELSE status END
        WHERE id = $2 AND user_id = $3
        RETURNING id, name, target_amount, saved_amount, description, status, user_id, created_at;
      `;
      result = await pool.query(updateWalletsQuery, [numericAmount, walletId, userId]);
=======
    let result = await query(updateQuery, [numericAmount, id, userId]);

    if (!result.rows || result.rows.length === 0) {
      try {
        result = await query(
          `UPDATE goal_targets
           SET saved_amount = saved_amount + $1,
               status = CASE WHEN (saved_amount + $1) >= target_amount THEN 'target_met' ELSE status END
           WHERE id = $2 AND user_id = $3
           RETURNING id, name, target_amount, saved_amount, description, status, created_at;`,
          [numericAmount, id, userId]
        );
      } catch (e) {}
>>>>>>> 05e1eb0e99dc5cb24da27162ad325b8805b5018b
    }

    if (!result.rows || result.rows.length === 0) {
      return res.status(404).json({
        success: false,
<<<<<<< HEAD
        message: 'Wallet container not found.',
=======
        message: 'Wallet container not found or unauthorized',
>>>>>>> 05e1eb0e99dc5cb24da27162ad325b8805b5018b
      });
    }

    const updated = {
      ...result.rows[0],
      target_amount: parseFloat(result.rows[0].target_amount),
      saved_amount: parseFloat(result.rows[0].saved_amount),
    };

    return res.status(200).json({
      success: true,
      message: `Allocated ₹${numericAmount} to ${updated.name}`,
      data: updated,
    });
  } catch (error) {
    console.error('Error adding cash to goal wallet:', error);
    return res.status(500).json({
      success: false,
      message: 'Failed to allocate cash',
      error: error.message,
    });
  }
});

/**
<<<<<<< HEAD
 * DELETE /api/wallets/:id & DELETE /api/goal-wallets/:id
 * Remove an owned goal wallet
=======
 * DELETE /api/wallets/:id
 * Remove a goal wallet strictly scoped by user_id
>>>>>>> 05e1eb0e99dc5cb24da27162ad325b8805b5018b
 */
app.delete(['/api/wallets/:id', '/api/goal-wallets/:id'], authenticate, async (req, res) => {
  try {
<<<<<<< HEAD
    const userId = req.user.id;
    const { id } = req.params;
    const walletId = parseInt(id, 10);

    if (isNaN(walletId)) {
      return res.status(400).json({
        success: false,
        message: 'Invalid wallet ID.',
      });
    }

    const delGoal = await pool.query('DELETE FROM goal_wallets WHERE id = $1 AND user_id = $2 RETURNING id;', [walletId, userId]);
    const delWal = await pool.query('DELETE FROM wallets WHERE id = $1 AND user_id = $2 RETURNING id;', [walletId, userId]);

    if ((!delGoal.rows || delGoal.rows.length === 0) && (!delWal.rows || delWal.rows.length === 0)) {
      return res.status(404).json({
        success: false,
        message: 'Wallet container not found.',
=======
    const userId = getUserId(req);
    if (!userId) {
      return res.status(401).json({ success: false, message: 'Authentication required' });
    }

    const { id } = req.params;
    let deleted = false;

    try {
      const deleteQuery = `DELETE FROM goal_wallets WHERE id = $1 AND user_id = $2 RETURNING id;`;
      const res1 = await query(deleteQuery, [id, userId]);
      if (res1 && res1.rows && res1.rows.length > 0) deleted = true;
    } catch (e) {}

    try {
      const deleteGtQuery = `DELETE FROM goal_targets WHERE id = $1 AND user_id = $2 RETURNING id;`;
      const res2 = await query(deleteGtQuery, [id, userId]);
      if (res2 && res2.rows && res2.rows.length > 0) deleted = true;
    } catch (e) {}

    try {
      const deleteWQuery = `DELETE FROM wallets WHERE id = $1 AND user_id = $2 RETURNING id;`;
      const res3 = await query(deleteWQuery, [id, userId]);
      if (res3 && res3.rows && res3.rows.length > 0) deleted = true;
    } catch (e) {}

    if (!deleted) {
      return res.status(404).json({
        success: false,
        message: 'Wallet not found or unauthorized',
>>>>>>> 05e1eb0e99dc5cb24da27162ad325b8805b5018b
      });
    }

    return res.status(200).json({
      success: true,
      message: 'Wallet deleted successfully',
      id: walletId,
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: 'Failed to delete wallet',
      error: error.message,
    });
  }
});

/**
<<<<<<< HEAD
 * GET /api/transactions
 * Retrieve transactions for the authenticated user
 */
app.get('/api/transactions', authenticate, async (req, res) => {
  try {
    const userId = req.user.id;
    const result = await pool.query(
      `SELECT t.id, t.user_id, t.account_id, t.category_id, t.transaction_type, t.amount, t.description, t.transaction_date, t.created_at,
              c.name AS category_name, a.account_name
       FROM transactions t
       LEFT JOIN categories c ON t.category_id = c.id AND c.user_id = $1
       LEFT JOIN accounts a ON t.account_id = a.id AND a.user_id = $1
       WHERE t.user_id = $1
       ORDER BY t.transaction_date DESC, t.created_at DESC;`,
      [userId]
    );

    const formatted = (result.rows || []).map(r => ({
      ...r,
      amount: parseFloat(r.amount) || 0,
=======
 * GET /api/goals
 * Retrieve goal targets strictly scoped to authenticated user
 */
app.get('/api/goals', async (req, res) => {
  try {
    const userId = getUserId(req);
    if (!userId) {
      return res.status(401).json({ success: false, message: 'Authentication required' });
    }

    let result = { rows: [] };
    try {
      const selectQuery = `
        SELECT id, name, target_amount, saved_amount, description, status, type, balance, user_id, created_at
        FROM goal_wallets
        WHERE user_id = $1
        ORDER BY created_at DESC;
      `;
      result = await query(selectQuery, [userId]);
    } catch (err) {
      try {
        result = await query(
          `SELECT id, name, COALESCE(target_amount, balance, 0) AS target_amount, COALESCE(saved_amount, balance, 0) AS saved_amount, description, status, type, balance, user_id, created_at
           FROM goal_targets
           WHERE user_id = $1
           ORDER BY created_at DESC;`,
          [userId]
        );
      } catch (e) {}
    }

    const formattedRows = (result?.rows || []).map((row) => ({
      ...row,
      target_amount: parseFloat(row.target_amount) || parseFloat(row.balance) || 0,
      saved_amount: parseFloat(row.saved_amount) || 0,
>>>>>>> 05e1eb0e99dc5cb24da27162ad325b8805b5018b
    }));

    return res.status(200).json({
      success: true,
<<<<<<< HEAD
      count: formatted.length,
      data: formatted,
    });
  } catch (err) {
    console.error('Error fetching transactions:', err.message);
    return res.status(500).json({
      success: false,
      message: 'Failed to retrieve transactions',
      error: err.message,
    });
  }
});

/**
 * POST /api/transactions
 * Create a new transaction for the authenticated user
 */
app.post('/api/transactions', authenticate, async (req, res) => {
  try {
    const userId = req.user.id;
    const { account_id, category_id, transaction_type = 'expense', amount, description, transaction_date } = req.body;

    const numericAmount = parseFloat(amount);
    if (isNaN(numericAmount) || numericAmount <= 0) {
      return res.status(400).json({
        success: false,
        message: 'Amount must be a positive number greater than 0.',
      });
    }

    const cleanDate = transaction_date || new Date().toISOString().split('T')[0];

    const result = await pool.query(
      `INSERT INTO transactions (user_id, account_id, category_id, transaction_type, amount, description, transaction_date)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING id, user_id, account_id, category_id, transaction_type, amount, description, transaction_date, created_at;`,
      [userId, account_id || null, category_id || null, transaction_type, numericAmount, description || '', cleanDate]
    );

    return res.status(201).json({
      success: true,
      message: 'Transaction recorded successfully',
      data: {
        ...result.rows[0],
        amount: parseFloat(result.rows[0].amount),
      },
    });
  } catch (err) {
    console.error('Error creating transaction:', err.message);
    return res.status(500).json({
      success: false,
      message: 'Failed to create transaction',
      error: err.message,
    });
  }
});

/**
 * PUT /api/transactions/:id
 * Update an existing transaction owned by the authenticated user
 */
app.put('/api/transactions/:id', authenticate, async (req, res) => {
  try {
    const userId = req.user.id;
    const txId = parseInt(req.params.id, 10);
    if (isNaN(txId)) {
      return res.status(400).json({ success: false, message: 'Invalid transaction ID.' });
    }

    const { amount, description, transaction_type } = req.body;
    const numericAmount = parseFloat(amount);

    const result = await pool.query(
      `UPDATE transactions
       SET amount = COALESCE($1, amount),
           description = COALESCE($2, description),
           transaction_type = COALESCE($3, transaction_type)
       WHERE id = $4 AND user_id = $5
       RETURNING id, user_id, account_id, category_id, transaction_type, amount, description, transaction_date, created_at;`,
      [isNaN(numericAmount) ? null : numericAmount, description ?? null, transaction_type ?? null, txId, userId]
    );

    if (!result.rows || result.rows.length === 0) {
      return res.status(404).json({ success: false, message: 'Transaction not found.' });
    }

    return res.status(200).json({
      success: true,
      message: 'Transaction updated successfully',
      data: {
        ...result.rows[0],
        amount: parseFloat(result.rows[0].amount),
      },
    });
  } catch (err) {
    console.error('Error updating transaction:', err.message);
    return res.status(500).json({ success: false, message: 'Failed to update transaction', error: err.message });
  }
});

/**
 * DELETE /api/transactions/:id
 * Delete an existing transaction owned by the authenticated user
 */
app.delete('/api/transactions/:id', authenticate, async (req, res) => {
  try {
    const userId = req.user.id;
    const txId = parseInt(req.params.id, 10);
    if (isNaN(txId)) {
      return res.status(400).json({ success: false, message: 'Invalid transaction ID.' });
    }

    const result = await pool.query(
      `DELETE FROM transactions WHERE id = $1 AND user_id = $2 RETURNING id;`,
      [txId, userId]
    );

    if (!result.rows || result.rows.length === 0) {
      return res.status(404).json({ success: false, message: 'Transaction not found.' });
    }

    return res.status(200).json({ success: true, message: 'Transaction deleted successfully', id: txId });
  } catch (err) {
    console.error('Error deleting transaction:', err.message);
    return res.status(500).json({ success: false, message: 'Failed to delete transaction', error: err.message });
  }
});

/**
 * GET /api/categories
 * Retrieve categories for the authenticated user
 */
app.get('/api/categories', authenticate, async (req, res) => {
  try {
    const userId = req.user.id;
    const result = await pool.query(
      `SELECT id, user_id, name, category_type, created_at
       FROM categories
       WHERE user_id = $1
       ORDER BY name ASC;`,
      [userId]
    );

    return res.status(200).json({
      success: true,
      count: result.rows.length,
      data: result.rows,
    });
  } catch (err) {
    console.error('Error fetching categories:', err.message);
    return res.status(500).json({
      success: false,
      message: 'Failed to retrieve categories',
      error: err.message,
    });
  }
});

/**
 * POST /api/categories
 * Create a new category for the authenticated user
 */
app.post('/api/categories', authenticate, async (req, res) => {
  try {
    const userId = req.user.id;
    const { name, category_type = 'expense' } = req.body;

    if (!name || typeof name !== 'string' || name.trim().length === 0) {
      return res.status(400).json({ success: false, message: 'Category name is required.' });
    }

    const result = await pool.query(
      `INSERT INTO categories (user_id, name, category_type)
       VALUES ($1, $2, $3)
       RETURNING id, user_id, name, category_type, created_at;`,
      [userId, name.trim(), category_type]
    );

    return res.status(201).json({
      success: true,
      message: 'Category created successfully',
      data: result.rows[0],
    });
  } catch (err) {
    console.error('Error creating category:', err.message);
    return res.status(500).json({ success: false, message: 'Failed to create category', error: err.message });
  }
});

/**
 * GET /api/accounts
 * Retrieve accounts for the authenticated user
 */
app.get('/api/accounts', authenticate, async (req, res) => {
  try {
    const userId = req.user.id;
    const result = await pool.query('SELECT * FROM accounts WHERE user_id = $1 ORDER BY id ASC;', [userId]);
    return res.status(200).json({ success: true, count: result.rows.length, data: result.rows });
  } catch (err) {
    return res.status(500).json({ success: false, message: 'Failed to retrieve accounts', error: err.message });
  }
});

/**
 * GET /api/budgets
 * Retrieve budgets for the authenticated user
 */
app.get('/api/budgets', authenticate, async (req, res) => {
  try {
    const userId = req.user.id;
    const result = await pool.query('SELECT * FROM budgets WHERE user_id = $1 ORDER BY id ASC;', [userId]);
    return res.status(200).json({ success: true, count: result.rows.length, data: result.rows });
  } catch (err) {
    return res.status(500).json({ success: false, message: 'Failed to retrieve budgets', error: err.message });
  }
});

/**
 * GET /api/dashboard/summary & GET /api/summary
 * Multi-user isolated financial summary for dashboard
 */
app.get(['/api/dashboard/summary', '/api/summary'], authenticate, async (req, res) => {
  try {
    const userId = req.user.id;

    // Total income from segregation
    const incomeRes = await pool.query(
      `SELECT COALESCE(SUM(amount), 0) AS total_income
       FROM segregation
       WHERE user_id = $1 AND type IN ('additional_income', 'fixed_income');`,
      [userId]
    );

    // Total expense from segregation
    const expenseRes = await pool.query(
      `SELECT COALESCE(SUM(amount), 0) AS total_expense
       FROM segregation
       WHERE user_id = $1 AND type IN ('additional_expense', 'fixed_expense', 'bill');`,
      [userId]
    );

    // Total saved in goal wallets
    const walletsRes = await pool.query(
      `SELECT COALESCE(SUM(saved_amount), 0) AS total_saved,
              COALESCE(SUM(target_amount), 0) AS total_target
       FROM goal_wallets
       WHERE user_id = $1;`,
      [userId]
    );

    // Total payments
    const paymentsRes = await pool.query(
      `SELECT COALESCE(SUM(amount), 0) AS total_payments
       FROM payments
       WHERE user_id = $1;`,
      [userId]
    );

    const totalIncome = parseFloat(incomeRes.rows[0].total_income) || 0;
    const totalExpense = parseFloat(expenseRes.rows[0].total_expense) || 0;
    const totalSaved = parseFloat(walletsRes.rows[0].total_saved) || 0;
    const totalTarget = parseFloat(walletsRes.rows[0].total_target) || 0;
    const totalPayments = parseFloat(paymentsRes.rows[0].total_payments) || 0;
    const netBalance = totalIncome - totalExpense;

    return res.status(200).json({
      success: true,
      data: {
        totalIncome,
        totalExpense,
        netBalance,
        totalSaved,
        totalTarget,
        totalPayments,
      },
      company: COMPANY_NAME,
    });
  } catch (err) {
    console.error('Error fetching dashboard summary:', err.message);
    return res.status(500).json({
      success: false,
      message: 'Failed to retrieve dashboard summary',
      error: err.message,
    });
=======
      count: formattedRows.length,
      data: formattedRows,
      company: COMPANY_NAME,
    });
  } catch (err) {
    console.error('GET /api/goals error:', err);
    return res.status(500).json({ success: false, message: 'Error retrieving goals', error: err.message });
  }
});

/**
 * POST /api/goals
 * Create a new goal target strictly scoped to user_id
 */
app.post('/api/goals', async (req, res) => {
  req.url = '/api/wallets';
  return app._router.handle(req, res);
});

/**
 * PUT /api/goals/:id
 * Update goal strictly scoped to user_id
 */
app.put('/api/goals/:id', async (req, res) => {
  try {
    const userId = getUserId(req);
    if (!userId) {
      return res.status(401).json({ success: false, message: 'Authentication required' });
    }
    const { id } = req.params;
    const { name, target_amount, saved_amount, description, status } = req.body;
    const updateParams = [
      name ? name.trim() : null,
      target_amount !== undefined ? parseFloat(target_amount) : null,
      saved_amount !== undefined ? parseFloat(saved_amount) : null,
      description !== undefined ? description.trim() : null,
      status || null,
      id,
      userId,
    ];
    const updateQuery = `
      UPDATE goal_wallets
      SET name = COALESCE($1, name),
          target_amount = COALESCE($2, target_amount),
          saved_amount = COALESCE($3, saved_amount),
          description = COALESCE($4, description),
          status = COALESCE($5, status)
      WHERE id = $6 AND user_id = $7
      RETURNING *;
    `;
    let result = await query(updateQuery, updateParams);
    if (!result.rows || result.rows.length === 0) {
      try {
        result = await query(
          `UPDATE goal_targets
           SET name = COALESCE($1, name),
               target_amount = COALESCE($2, target_amount),
               saved_amount = COALESCE($3, saved_amount),
               description = COALESCE($4, description),
               status = COALESCE($5, status)
           WHERE id = $6 AND user_id = $7
           RETURNING *;`,
          updateParams
        );
      } catch (e) {}
    }
    if (!result.rows || result.rows.length === 0) {
      return res.status(404).json({ success: false, message: 'Goal not found or unauthorized' });
    }
    return res.status(200).json({ success: true, data: result.rows[0] });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
});

/**
 * DELETE /api/goals/:id
 * Delete goal strictly scoped to user_id
 */
app.delete('/api/goals/:id', async (req, res) => {
  req.url = `/api/wallets/${req.params.id}`;
  return app._router.handle(req, res);
});

/**
 * GET /api/expenses
 * Retrieve expenses strictly scoped to authenticated user
 */
app.get('/api/expenses', async (req, res) => {
  try {
    const userId = getUserId(req);
    if (!userId) {
      return res.status(401).json({ success: false, message: 'Authentication required' });
    }

    let result = { rows: [] };
    try {
      const selectQuery = `
        SELECT id, name, description, date, time, category, associated_wallet, amount, type, user_id, created_at
        FROM expenses
        WHERE user_id = $1
        ORDER BY date DESC, created_at DESC;
      `;
      result = await query(selectQuery, [userId]);
    } catch (err) {
      // Fallback to segregation WHERE (type = 'additional_expense' OR type = 'fixed_expense') AND user_id = $1
      try {
        const fallbackQuery = `
          SELECT id, type, name, description, date, time, schedule, category, associated_wallet, amount, user_id, created_at
          FROM segregation
          WHERE type IN ('additional_expense', 'fixed_expense') AND user_id = $1
          ORDER BY date DESC, created_at DESC;
        `;
        result = await query(fallbackQuery, [userId]);
      } catch (err2) {
        return res.status(200).json({ success: true, count: 0, data: [] });
      }
    }

    const rows = (result?.rows || []).map((row) => ({
      ...row,
      amount: parseFloat(row.amount) || 0,
      date: row.date ? (typeof row.date === 'string' ? row.date.split('T')[0] : new Date(row.date).toISOString().split('T')[0]) : null,
    }));

    return res.status(200).json({
      success: true,
      count: rows.length,
      data: rows,
      company: COMPANY_NAME,
    });
  } catch (err) {
    console.error('GET /api/expenses error:', err);
    return res.status(500).json({ success: false, message: 'Error retrieving expenses', error: err.message });
  }
});

/**
 * POST /api/expenses
 * Create a new expense strictly scoped to user_id
 */
app.post('/api/expenses', async (req, res) => {
  req.body.type = req.body.type || 'additional_expense';
  req.url = '/api/segregation';
  return app._router.handle(req, res);
});

/**
 * PUT /api/expenses/:id
 * Update expense strictly scoped to user_id
 */
app.put('/api/expenses/:id', async (req, res) => {
  req.url = `/api/segregation/${req.params.id}`;
  return app._router.handle(req, res);
});

/**
 * DELETE /api/expenses/:id
 * Delete expense strictly scoped to user_id
 */
app.delete('/api/expenses/:id', async (req, res) => {
  req.url = `/api/segregation/${req.params.id}`;
  return app._router.handle(req, res);
});

/**
 * GET /api/payments
 * Retrieve payments strictly scoped to authenticated user
 */
app.get('/api/payments', async (req, res) => {
  try {
    const userId = getUserId(req);
    if (!userId) {
      return res.status(401).json({ success: false, message: 'Authentication required' });
    }

    const selectQuery = `
      SELECT id, name, COALESCE(title, name) AS title, amount, date, status, user_id, created_at
      FROM payments
      WHERE user_id = $1
      ORDER BY date DESC, created_at DESC;
    `;
    const result = await query(selectQuery, [userId]);
    const rows = (result?.rows || []).map((row) => ({
      ...row,
      amount: parseFloat(row.amount) || 0,
      date: row.date ? (typeof row.date === 'string' ? row.date.split('T')[0] : new Date(row.date).toISOString().split('T')[0]) : null,
    }));

    return res.status(200).json({
      success: true,
      count: rows.length,
      data: rows,
      company: COMPANY_NAME,
    });
  } catch (error) {
    console.error('GET /api/payments error:', error);
    return res.status(200).json({ success: true, count: 0, data: [] });
  }
});

/**
 * POST /api/payments
 * Create a new payment record strictly scoped to user_id
 */
app.post('/api/payments', async (req, res) => {
  try {
    const userId = getUserId(req);
    if (!userId) {
      return res.status(401).json({ success: false, message: 'Authentication required' });
    }

    const { name, title, amount = 0, date, status = 'completed' } = req.body;
    const cleanTitle = (title || name || '').trim();
    if (!cleanTitle) {
      return res.status(400).json({ success: false, message: 'Payment title/name is required.' });
    }

    const numericAmount = parseFloat(amount);
    if (isNaN(numericAmount) || numericAmount < 0) {
      return res.status(400).json({ success: false, message: 'Amount must be a valid positive number.' });
    }

    const cleanDate = date || new Date().toISOString().split('T')[0];

    const insertQuery = `
      INSERT INTO payments (name, title, amount, date, status, user_id)
      VALUES ($1, $2, $3, $4, $5, $6)
      RETURNING id, name, title, amount, date, status, user_id, created_at;
    `;
    let result = await query(insertQuery, [cleanTitle, cleanTitle, numericAmount, cleanDate, status, userId]);

    let createdRecord;
    if (result && result.rows && result.rows.length > 0) {
      createdRecord = {
        ...result.rows[0],
        amount: parseFloat(result.rows[0].amount),
      };
    } else {
      createdRecord = {
        id: Date.now(),
        name: cleanTitle,
        title: cleanTitle,
        amount: numericAmount,
        date: cleanDate,
        status,
        user_id: userId,
        created_at: new Date().toISOString(),
      };
      inMemoryPayments.unshift(createdRecord);
    }

    return res.status(201).json({
      success: true,
      message: 'Payment recorded successfully',
      data: createdRecord,
      company: COMPANY_NAME,
    });
  } catch (error) {
    console.error('POST /api/payments error:', error);
    return res.status(500).json({ success: false, message: 'Error recording payment', error: error.message });
>>>>>>> 05e1eb0e99dc5cb24da27162ad325b8805b5018b
  }
});

// Root route
app.get('/', (req, res) => {
  res.json({
    message: `Welcome to ${COMPANY_NAME} Expense & Payment Tracking API`,
    documentation: {
      health: 'GET /api/health',
      payments: 'GET /api/payments',
      createPayment: 'POST /api/payments',
      segregation: 'GET /api/segregation',
      createSegregation: 'POST /api/segregation',
    },
  });
});

// 404 Handler
app.use((req, res) => {
  res.status(404).json({
    success: false,
    message: `Endpoint ${req.originalUrl} not found on this server`,
    company: COMPANY_NAME,
  });
});

// Global Error Handler
app.use((err, req, res, next) => {
  if (err.message === 'Origin not allowed by CORS') {
    return res.status(403).json({
      success: false,
      message: 'Origin not allowed by CORS',
      company: COMPANY_NAME,
    });
  }
  console.error('[Unhandled Error]:', err.stack);
  res.status(500).json({
    success: false,
    message: err.message || 'Internal server error',
    company: COMPANY_NAME,
  });
});


// Server Initialization
async function startServer() {
  try {
    if (!process.env.DATABASE_URL) {
      throw new Error('DATABASE_URL is required. Server startup cancelled.');
    }

    console.log('[STS FINTECH] Connecting to PostgreSQL...');

    await pool.query('SELECT 1');

    console.log('[STS FINTECH] PostgreSQL connection successful.');

    console.log('[STS FINTECH] Initializing database tables...');

    await pool.initDatabase();

    console.log('[STS FINTECH] Database initialization successful.');

    // Validate Local AI configuration (Step 4.1 - Non-blocking diagnostic)
    try {
      const { checkAiHealth, getConfig } = require('./services/aiProvider.service');
      const aiConfig = getConfig();
      console.log(`[STS FINTECH AI] Provider configured: '${aiConfig.provider}' (Model: '${aiConfig.model}')`);
      const aiHealth = await checkAiHealth();
      if (aiHealth.available) {
        console.log(`✅ [STS FINTECH AI] Provider '${aiConfig.provider}' verified with model '${aiConfig.model}'.`);
      } else {
        console.warn(`⚠️ [STS FINTECH AI] Provider diagnostic: ${aiHealth.message}`);
        if (aiHealth.instructions) {
          console.warn(`   Setup instructions: ${aiHealth.instructions}`);
        }
      }
    } catch (aiErr) {
      console.warn('[STS FINTECH AI] Startup AI validation warning:', aiErr.message);
    }

    const server = app.listen(PORT, () => {
      console.log('========================================================');
      console.log(`🚀 ${COMPANY_NAME}`);
      console.log('   ExpenseTrack Backend Server Running');
      console.log(`   Port: ${PORT}`);
      console.log(`   URL: http://localhost:${PORT}`);
      console.log('========================================================');
    });

    return server;
  } catch (error) {
    console.error('[STS FINTECH] Server startup failed:', error.message);
    await pool.end().catch(() => {});
    process.exitCode = 1;
    throw error;
  }
}

if (require.main === module) {
  startServer().catch(() => {});
}

module.exports = app;
module.exports.startServer = startServer;
