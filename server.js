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

// In-memory goal wallets store for memory-backed operation when DATABASE_URL is not provided or offline
const inMemoryGoalWallets = [];

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
      console.warn('[STS FINTECH] Database connection unavailable; utilizing in-memory wallet store.');
    }
  }

  // Handle in-memory query simulation for wallets when database is unavailable or not configured
  const sql = (typeof text === 'string' ? text : text?.text || '').toLowerCase();

  // Check DELETE first
  if (sql.includes('delete from goal_wallets') || sql.includes('delete from wallets')) {
    const id = params[0];
    const idx = inMemoryGoalWallets.findIndex((w) => String(w.id) === String(id));
    if (idx !== -1) inMemoryGoalWallets.splice(idx, 1);
    return { rows: [{ id }] };
  }

  // Check UPDATE second
  if (sql.includes('update goal_wallets') || sql.includes('update wallets')) {
    const amount = parseFloat(params[0]) || 0;
    const id = params[1];
    const item = inMemoryGoalWallets.find((w) => String(w.id) === String(id));
    if (item) {
      item.saved_amount = (parseFloat(item.saved_amount) || 0) + amount;
      if (item.saved_amount >= item.target_amount) {
        item.status = 'target_met';
      }
      return { rows: [item] };
    }
    return { rows: [] };
  }

  // Check SELECT third
  if (sql.includes('from goal_wallets') || sql.includes('from wallets')) {
    if (sql.includes('where id =')) {
      const id = params[0];
      const found = inMemoryGoalWallets.find((w) => String(w.id) === String(id));
      return { rows: found ? [found] : [] };
    }
    return { rows: [...inMemoryGoalWallets] };
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
    'X-User-Id',
    'x-user-email',
    'X-User-Email',
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

// Split & Collect persistent group APIs
app.use('/api/splits', splitsRoutes);

// Financial Intelligence & Analytics APIs
app.use('/api/ai', aiRoutes);

/**
 * GET /health & GET /api/health
 * Operational status and company metadata (Publicly accessible)
 */
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
      ...row,
      amount: parseFloat(row.amount) || 0,
    }));

    return res.status(200).json({
      success: true,
      count: formattedRows.length,
      data: formattedRows,
      company: COMPANY_NAME,
    });
  } catch (err) {
    console.error('Error fetching payments:', err.message);
    return res.status(500).json({
      success: false,
      message: 'Failed to retrieve payments',
      error: err.message,
    });
  }
});

/**
 * POST /api/payments
 * Validate and insert a new payment record assigned to the authenticated user
 */
app.post('/api/payments', authenticate, async (req, res) => {
  try {
    const userId = req.user.id;
    const { title, name, amount, status = 'completed' } = req.body;
    const itemTitle = (title || name || '').trim();

    if (!itemTitle) {
      return res.status(400).json({
        success: false,
        message: 'Payment title is required and must be a non-empty string.',
      });
    }

    const numericAmount = parseFloat(amount);
    if (isNaN(numericAmount) || numericAmount <= 0) {
      return res.status(400).json({
        success: false,
        message: 'Payment amount must be a positive number greater than 0.',
      });
    }

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

    return res.status(201).json({
      success: true,
      message: 'Payment recorded successfully',
      data: createdPayment,
      company: COMPANY_NAME,
    });
  } catch (error) {
    console.error('Error creating payment:', error);
    return res.status(500).json({
      success: false,
      message: 'Internal server error while creating payment',
      error: error.message,
    });
  }
});

/**
 * GET /api/segregation & GET /api/finance-records
 * Retrieve finance segregation records for the authenticated user
 */
app.get(['/api/segregation', '/api/finance-records'], authenticate, async (req, res) => {
  try {
    const userId = req.user.id;
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
    console.error('Unhandled segregation fetch error:', err.message);
    return res.status(500).json({
      success: false,
      message: 'Failed to retrieve finance records',
      error: err.message,
    });
  }
});

/**
 * POST /api/segregation & POST /api/finance-records
 * Create a new finance segregation record for the authenticated user
 */
app.post(['/api/segregation', '/api/finance-records'], authenticate, async (req, res) => {
  try {
    const userId = req.user.id;
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

    const insertSegregationQuery = `
      INSERT INTO segregation (type, name, description, date, time, schedule, category, associated_wallet, amount, user_id)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
      RETURNING id, type, name, description, date, time, schedule, category, associated_wallet, amount, user_id, created_at;
    `;
    const result = await pool.query(insertSegregationQuery, insertParams);

    // Dual-write to finance_records for consistency
    try {
      const insertFinanceQuery = `
        INSERT INTO finance_records (type, name, description, date, time, schedule, category, associated_wallet, amount, user_id)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10);
      `;
      await pool.query(insertFinanceQuery, insertParams);
    } catch (e) {}

    const createdRecord = {
      ...result.rows[0],
      amount: parseFloat(result.rows[0].amount),
    };

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
 * PUT /api/segregation/:id & PUT /api/finance-records/:id
 * Update an existing finance record owned by the authenticated user
 */
app.put(['/api/segregation/:id', '/api/finance-records/:id'], authenticate, async (req, res) => {
  try {
    const userId = req.user.id;
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
        message: 'Finance record not found.',
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
 * DELETE /api/segregation/:id & DELETE /api/finance-records/:id
 * Delete a finance record owned by the authenticated user
 */
app.delete(['/api/segregation/:id', '/api/finance-records/:id'], authenticate, async (req, res) => {
  try {
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
 * GET /api/wallets & GET /api/goal-wallets
 * Retrieve all segregated goal wallets for the authenticated user
 */
app.get(['/api/wallets', '/api/goal-wallets'], authenticate, async (req, res) => {
  try {
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
    console.error('Error fetching wallets:', err.message);
    return res.status(500).json({
      success: false,
      message: 'Failed to retrieve wallets',
      error: err.message,
    });
  }
});

/**
 * POST /api/wallets & POST /api/goal-wallets
 * Setup a new purpose target wallet assigned to the authenticated user
 */
app.post(['/api/wallets', '/api/goal-wallets'], authenticate, async (req, res) => {
  try {
    const userId = req.user.id;

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

    return res.status(201).json({
      success: true,
      message: 'Target wallet activated successfully',
      data: createdWallet,
      company: COMPANY_NAME,
    });
  } catch (error) {
    console.error('Error creating wallet:', error);
    return res.status(500).json({
      success: false,
      message: 'Failed to create goal wallet',
      error: error.message,
    });
  }
});

/**
 * POST /api/wallets/:id/add-cash & POST /api/goal-wallets/:id/add-cash
 * Allocate cash towards an owned goal wallet
 */
app.post(['/api/wallets/:id/add-cash', '/api/goal-wallets/:id/add-cash'], authenticate, async (req, res) => {
  try {
    const userId = req.user.id;
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

    // Verify wallet ownership
    const checkQuery = `
      SELECT id, name, target_amount, saved_amount, status
      FROM goal_wallets
      WHERE id = $1 AND user_id = $2;
    `;
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
      RETURNING id, name, target_amount, saved_amount, description, status, user_id, created_at;
    `;
    let result = await pool.query(updateQuery, [numericAmount, walletId, userId]);

    if (!result.rows || result.rows.length === 0) {
      const updateWalletsQuery = `
        UPDATE wallets
        SET saved_amount = saved_amount + $1,
            status = CASE WHEN (saved_amount + $1) >= target_amount THEN 'target_met' ELSE status END
        WHERE id = $2 AND user_id = $3
        RETURNING id, name, target_amount, saved_amount, description, status, user_id, created_at;
      `;
      result = await pool.query(updateWalletsQuery, [numericAmount, walletId, userId]);
    }

    if (!result.rows || result.rows.length === 0) {
      return res.status(404).json({
        success: false,
        message: 'Wallet container not found.',
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
 * DELETE /api/wallets/:id & DELETE /api/goal-wallets/:id
 * Remove an owned goal wallet
 */
app.delete(['/api/wallets/:id', '/api/goal-wallets/:id'], authenticate, async (req, res) => {
  try {
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
    }));

    return res.status(200).json({
      success: true,
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
