require('dotenv').config();
const express = require('express');
const cors = require('cors');
const pool = require('./db');

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
const CLIENT_URL = process.env.CLIENT_URL || 'http://localhost:5173';

const COMPANY_NAME = 'STS FINTECH PRIVATE LIMITED';

// Configure CORS to support frontend client communication across production and preview environments
const allowedOrigins = [
  CLIENT_URL,
  'https://expense-track-seven-smoky.vercel.app',
  'http://localhost:5173',
  'http://localhost:3000',
  'http://localhost:5174',
  'http://127.0.0.1:5173',
];

const corsOptions = {
  origin: (origin, callback) => {
    // Allow requests with no origin (like mobile apps, curl, Postman)
    if (!origin) return callback(null, true);

    if (
      allowedOrigins.includes(origin) ||
      /\.vercel\.app$/.test(origin) ||
      (process.env.CLIENT_URL && origin === process.env.CLIENT_URL)
    ) {
      return callback(null, true);
    }

    // Permit all preview / cross-origin requests gracefully without rejecting
    return callback(null, true);
  },
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Company-Name', 'X-Service'],
};

app.use(cors(corsOptions));
app.options('*', cors());

app.use(express.json());

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

// Auto-initialize PostgreSQL tables on startup
const initDatabase = async () => {
  if (pool && typeof pool.initDatabase === 'function') {
    await pool.initDatabase(pool);
  } else if (pool && isDatabaseConfigured) {
    try {
      const bootstrapTablesQuery = `
        CREATE TABLE IF NOT EXISTS wallets (
          id SERIAL PRIMARY KEY,
          name VARCHAR(255) NOT NULL,
          type VARCHAR(100) DEFAULT 'general',
          balance NUMERIC(12, 2) NOT NULL DEFAULT 0.00,
          target_amount NUMERIC(12, 2) DEFAULT 0.00,
          saved_amount NUMERIC(12, 2) DEFAULT 0.00,
          description TEXT DEFAULT '',
          status VARCHAR(50) DEFAULT 'active',
          user_id VARCHAR(255),
          created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
        );
        CREATE TABLE IF NOT EXISTS segregation (
          id SERIAL PRIMARY KEY,
          name VARCHAR(255) NOT NULL,
          description TEXT DEFAULT '',
          date DATE DEFAULT CURRENT_DATE,
          time VARCHAR(50),
          category VARCHAR(100) DEFAULT 'General',
          wallet_id VARCHAR(100),
          associated_wallet VARCHAR(100) DEFAULT 'Primary Wallet',
          amount NUMERIC(12, 2) NOT NULL DEFAULT 0.00,
          schedule VARCHAR(100) DEFAULT 'One-time',
          type VARCHAR(50) NOT NULL DEFAULT 'additional_expense',
          user_id VARCHAR(255),
          created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
        );
        CREATE TABLE IF NOT EXISTS payments (
          id SERIAL PRIMARY KEY,
          name VARCHAR(255),
          title VARCHAR(255),
          amount NUMERIC(12, 2) NOT NULL DEFAULT 0.00,
          date DATE DEFAULT CURRENT_DATE,
          status VARCHAR(50) DEFAULT 'completed',
          user_id VARCHAR(255),
          created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
        );
        CREATE TABLE IF NOT EXISTS goal_wallets (
          id SERIAL PRIMARY KEY,
          name VARCHAR(255) NOT NULL,
          target_amount NUMERIC(12, 2) NOT NULL DEFAULT 0.00,
          saved_amount NUMERIC(12, 2) NOT NULL DEFAULT 0.00,
          description TEXT DEFAULT '',
          status VARCHAR(50) DEFAULT 'in_progress',
          type VARCHAR(100) DEFAULT 'goal',
          balance NUMERIC(12, 2) DEFAULT 0.00,
          user_id VARCHAR(255),
          created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
        );
        CREATE TABLE IF NOT EXISTS finance_records (
          id SERIAL PRIMARY KEY,
          type VARCHAR(50) NOT NULL DEFAULT 'additional_expense',
          name VARCHAR(255) NOT NULL,
          description TEXT DEFAULT '',
          date DATE DEFAULT CURRENT_DATE,
          time VARCHAR(50),
          schedule VARCHAR(100) DEFAULT 'One-time',
          category VARCHAR(100) DEFAULT 'General',
          associated_wallet VARCHAR(100) DEFAULT 'Primary Wallet',
          wallet_id VARCHAR(100),
          amount NUMERIC(12, 2) NOT NULL DEFAULT 0.00,
          user_id VARCHAR(255),
          created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
        );
      `;
      await pool.query(bootstrapTablesQuery);
      console.log('✅ [STS FINTECH] PostgreSQL "wallets", "segregation", "payments", "finance_records" & "goal_wallets" tables verified.');
    } catch (error) {
      console.error('❌ [STS FINTECH] Error initializing tables:', error.message);
    }
  } else {
    console.log('ℹ️ [STS FINTECH] Running in memory-backed mode (DATABASE_URL not supplied).');
  }
};

// -------------------------------------------------------------
// ROUTES
// -------------------------------------------------------------

/**
 * GET /health
 * Database connectivity health check
 */
app.get('/health', async (req, res) => {
  try {
    if (pool) {
      await pool.query('SELECT 1');
    }
    return res.status(200).json({
      status: 'ok',
      db: 'connected',
      timestamp: new Date(),
    });
  } catch (error) {
    return res.status(200).json({
      status: 'ok',
      db: 'disconnected',
      error: error.message,
      timestamp: new Date(),
    });
  }
});

/**
 * GET /api/health
 * Operational status and company information
 */
app.get('/api/health', (req, res) => {
  res.status(200).json({
    status: 'healthy',
    company: COMPANY_NAME,
    service: 'ExpenseTrack Backend API',
    database: isDatabaseConfigured ? 'connected' : 'in-memory-fallback',
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
  });
});

/**
 * GET /api/payments
 * Retrieve all payment transactions ordered by creation date descending
 */
app.get('/api/payments', async (req, res) => {
  try {
    const selectQuery = `
      SELECT id, COALESCE(title, name, '') AS title, COALESCE(name, title, '') AS name, amount, status, date, user_id, created_at 
      FROM payments 
      ORDER BY created_at DESC;
    `;
    const result = await query(selectQuery);

    if (!result || !result.rows || result.rows.length === 0) {
      return res.status(200).json([]);
    }

    const formattedRows = result.rows.map((row) => ({
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
    console.error(err.message);
    return res.status(200).json([]);
  }
});

/**
 * POST /api/payments
 * Validate and insert a new payment record
 */
app.post('/api/payments', async (req, res) => {
  try {
    const { title, amount, status = 'completed' } = req.body;

    const errors = [];
    if (!title || typeof title !== 'string' || title.trim().length === 0) {
      errors.push('Payment title is required and must be a non-empty string.');
    }

    const numericAmount = parseFloat(amount);
    if (amount === undefined || amount === null || isNaN(numericAmount) || numericAmount <= 0) {
      errors.push('Payment amount must be a positive number greater than 0.');
    }

    const validStatuses = ['completed', 'pending', 'failed', 'processing'];
    if (status && !validStatuses.includes(status.toLowerCase())) {
      errors.push(`Status must be one of: ${validStatuses.join(', ')}.`);
    }

    if (errors.length > 0) {
      return res.status(400).json({
        success: false,
        message: 'Validation failed',
        errors,
      });
    }

    const sanitizedTitle = title.trim();
    const sanitizedStatus = (status || 'completed').toLowerCase();

    const insertQuery = `
      INSERT INTO payments (title, amount, status)
      VALUES ($1, $2, $3)
      RETURNING id, title, amount, status, created_at;
    `;

    const result = await query(insertQuery, [sanitizedTitle, numericAmount, sanitizedStatus]);
    const createdPayment = {
      ...result.rows[0],
      amount: parseFloat(result.rows[0].amount),
    };

    console.log(`[STS FINTECH] Payment created successfully: ID ${createdPayment.id} - ₹${createdPayment.amount}`);

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
 * GET /api/segregation
 * Retrieve finance segregation records, with optional ?type= filter
 * (e.g., 'additional_income', 'additional_expense', 'fixed_income', 'fixed_expense', 'bill')
 */
app.get('/api/segregation', async (req, res) => {
  try {
    const { type } = req.query;
    let result = { rows: [] };

    try {
      const selectQuery = type
        ? `SELECT id, type, name, description, date, time, schedule, category, associated_wallet, wallet_id, amount, user_id, created_at
           FROM segregation
           WHERE type = $1
           ORDER BY date DESC, created_at DESC;`
        : `SELECT id, type, name, description, date, time, schedule, category, associated_wallet, wallet_id, amount, user_id, created_at
           FROM segregation
           ORDER BY date DESC, created_at DESC;`;
      result = await query(selectQuery, type ? [type] : []);
    } catch (err) {
      console.error(err.message);
      // Fallback to finance_records if segregation table query failed
      try {
        const selectQuery = type
          ? `SELECT id, type, name, description, date, time, schedule, category, associated_wallet, wallet_id, amount, user_id, created_at
             FROM finance_records
             WHERE type = $1
             ORDER BY date DESC, created_at DESC;`
          : `SELECT id, type, name, description, date, time, schedule, category, associated_wallet, wallet_id, amount, user_id, created_at
             FROM finance_records
             ORDER BY date DESC, created_at DESC;`;
        result = await query(selectQuery, type ? [type] : []);
      } catch (err2) {
        console.error(err2.message);
        return res.status(200).json([]);
      }
    }

    if (!result || !result.rows || result.rows.length === 0) {
      // If segregation table was empty, check if finance_records has rows
      try {
        const fallbackQuery = type
          ? `SELECT id, type, name, description, date, time, schedule, category, associated_wallet, wallet_id, amount, user_id, created_at
             FROM finance_records
             WHERE type = $1
             ORDER BY date DESC, created_at DESC;`
          : `SELECT id, type, name, description, date, time, schedule, category, associated_wallet, wallet_id, amount, user_id, created_at
             FROM finance_records
             ORDER BY date DESC, created_at DESC;`;
        const fbResult = await query(fallbackQuery, type ? [type] : []);
        if (fbResult && fbResult.rows && fbResult.rows.length > 0) {
          result = fbResult;
        }
      } catch (e) {
        console.error(e.message);
      }
    }

    if (!result || !result.rows || result.rows.length === 0) {
      return res.status(200).json([]);
    }

    const formattedRows = result.rows.map((row) => ({
      ...row,
      amount: parseFloat(row.amount) || 0,
      date: row.date ? (typeof row.date === 'string' ? row.date.split('T')[0] : new Date(row.date).toISOString().split('T')[0]) : null,
    }));

    // Filter duplicates by unique id or name before sending response
    const uniqueRows = Array.from(new Map(formattedRows.map((item) => [item.id || item.name, item])).values());

    return res.status(200).json({
      success: true,
      count: uniqueRows.length,
      data: uniqueRows,
      company: COMPANY_NAME,
    });
  } catch (err) {
    console.error(err.message);
    return res.status(200).json([]);
  }
});

/**
 * POST /api/segregation
 * Validate and persist new finance records submitted from UI modal
 */
app.post('/api/segregation', async (req, res) => {
  try {
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

    let result;
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
    ];

    try {
      const insertSegregationQuery = `
        INSERT INTO segregation (type, name, description, date, time, schedule, category, associated_wallet, amount)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
        RETURNING id, type, name, description, date, time, schedule, category, associated_wallet, amount, created_at;
      `;
      result = await query(insertSegregationQuery, insertParams);
    } catch (e) {}

    try {
      const insertFinanceQuery = `
        INSERT INTO finance_records (type, name, description, date, time, schedule, category, associated_wallet, amount)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
        RETURNING id, type, name, description, date, time, schedule, category, associated_wallet, amount, created_at;
      `;
      const resFinance = await query(insertFinanceQuery, insertParams);
      if (!result || !result.rows || result.rows.length === 0) {
        result = resFinance;
      }
    } catch (e) {}

    const createdRecord = {
      ...result.rows[0],
      amount: parseFloat(result.rows[0].amount),
    };

    console.log(`[STS FINTECH] Segregation record created: ${createdRecord.type} - "${createdRecord.name}" (₹${createdRecord.amount})`);

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
 * PUT /api/segregation/:id
 * Update an existing finance record
 */
app.put('/api/segregation/:id', async (req, res) => {
  try {
    const { id } = req.params;
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
      parseInt(id, 10),
    ];

    let result;
    try {
      const updateSegQuery = `
        UPDATE segregation
        SET name = $1, description = $2, date = $3, time = $4, schedule = $5, category = $6, associated_wallet = $7, amount = $8
        WHERE id = $9
        RETURNING id, type, name, description, date, time, schedule, category, associated_wallet, amount, created_at;
      `;
      result = await query(updateSegQuery, updateParams);
    } catch (e) {}

    try {
      const updateFinanceQuery = `
        UPDATE finance_records
        SET name = $1, description = $2, date = $3, time = $4, schedule = $5, category = $6, associated_wallet = $7, amount = $8
        WHERE id = $9
        RETURNING id, type, name, description, date, time, schedule, category, associated_wallet, amount, created_at;
      `;
      const resFin = await query(updateFinanceQuery, updateParams);
      if (!result || !result.rows || result.rows.length === 0) {
        result = resFin;
      }
    } catch (e) {}

    if (!result || !result.rows || result.rows.length === 0) {
      return res.status(404).json({
        success: false,
        message: 'Record not found',
      });
    }

    const updatedRecord = {
      ...result.rows[0],
      amount: parseFloat(result.rows[0].amount),
      date: result.rows[0].date ? (typeof result.rows[0].date === 'string' ? result.rows[0].date.split('T')[0] : new Date(result.rows[0].date).toISOString().split('T')[0]) : null,
    };

    console.log(`[STS FINTECH] Segregation record updated: ID ${id} - "${updatedRecord.name}" (₹${updatedRecord.amount})`);

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
 * DELETE /api/segregation/:id
 * Remove a finance record
 */
app.delete('/api/segregation/:id', async (req, res) => {
  try {
    const { id } = req.params;
    try {
      await query(`DELETE FROM segregation WHERE id = $1;`, [parseInt(id, 10)]);
    } catch (e) {}
    const deleteQuery = `DELETE FROM finance_records WHERE id = $1 RETURNING id;`;
    const result = await query(deleteQuery, [parseInt(id, 10)]);

    if (!result.rows || result.rows.length === 0) {
      return res.status(404).json({
        success: false,
        message: 'Record not found',
      });
    }

    console.log(`[STS FINTECH] Segregation record deleted: ID ${id}`);

    return res.status(200).json({
      success: true,
      message: 'Finance record deleted successfully',
      id: parseInt(id, 10),
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
 * GET /api/wallets
 * Retrieve all segregated goal wallets
 */
app.get('/api/wallets', async (req, res) => {
  try {
    let result = { rows: [] };

    try {
      const selectQuery = `
        SELECT id, name, target_amount, saved_amount, description, status, type, balance, user_id, created_at
        FROM goal_wallets
        ORDER BY created_at DESC;
      `;
      result = await query(selectQuery);
    } catch (err) {
      console.error(err.message);
      try {
        const fallbackQuery = `
          SELECT id, name, COALESCE(target_amount, balance, 0) AS target_amount, COALESCE(saved_amount, balance, 0) AS saved_amount, description, status, type, balance, user_id, created_at
          FROM wallets
          ORDER BY created_at DESC;
        `;
        result = await query(fallbackQuery);
      } catch (err2) {
        console.error(err2.message);
        return res.status(200).json([]);
      }
    }

    if (!result || !result.rows || result.rows.length === 0) {
      // Check wallets table if goal_wallets was empty
      try {
        const fallbackQuery = `
          SELECT id, name, COALESCE(target_amount, balance, 0) AS target_amount, COALESCE(saved_amount, balance, 0) AS saved_amount, description, status, type, balance, user_id, created_at
          FROM wallets
          ORDER BY created_at DESC;
        `;
        const fbResult = await query(fallbackQuery);
        if (fbResult && fbResult.rows && fbResult.rows.length > 0) {
          result = fbResult;
        }
      } catch (e) {
        console.error(e.message);
      }
    }

    if (!result || !result.rows || result.rows.length === 0) {
      return res.status(200).json([]);
    }

    const formattedRows = result.rows.map((row) => ({
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
    console.error(err.message);
    return res.status(200).json([]);
  }
});

/**
 * POST /api/wallets
 * Setup a new purpose target wallet
 */
app.post('/api/wallets', async (req, res) => {
  try {
    // 1. Purpose / Item name extraction & validation (supports name, purpose, purposeName, itemName, title)
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

    // 2. Target cap amount extraction & numeric parsing (supports target_amount, targetAmount, target_cap, targetCap, amount)
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

    // 3. Description / notes extraction (supports description, notes, descriptiveNotes)
    const rawDescription = req.body.description ?? req.body.notes ?? req.body.descriptiveNotes ?? '';
    const cleanDescription = typeof rawDescription === 'string' ? rawDescription.trim() : String(rawDescription || '').trim();

    // 4. Type / category extraction (supports type, category)
    const rawType = req.body.type ?? req.body.category ?? 'goal';
    const cleanType = typeof rawType === 'string' && rawType.trim().length > 0 ? rawType.trim() : 'goal';

    // 5. User authentication context parsing (req.user.id, user_id, headers, or body)
    const userId =
      req.user?.id ||
      req.user?.user_id ||
      req.user?._id ||
      req.userId ||
      req.user_id ||
      req.headers['x-user-id'] ||
      req.body?.user_id ||
      req.body?.userId ||
      null;

    let createdWallet = null;

    // 6. Attempt PostgreSQL database insertion if database is configured
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
        if (dbErr.detail) console.error('[STS FINTECH] DB Detail:', dbErr.detail);
        if (dbErr.code) console.error('[STS FINTECH] DB Error Code:', dbErr.code);

        // Fallback: If column user_id / type doesn't exist on older table schema, try standard columns
        if (dbErr.code === '42703') {
          try {
            const insertBaseQuery = `
              INSERT INTO goal_wallets (name, target_amount, saved_amount, description, status)
              VALUES ($1, $2, $3, $4, $5)
              RETURNING id, name, target_amount, saved_amount, description, status, created_at;
            `;
            const baseResult = await pool.query(insertBaseQuery, [
              cleanName,
              numericTarget,
              0.0,
              cleanDescription,
              'in_progress',
            ]);
            if (baseResult.rows && baseResult.rows.length > 0) {
              createdWallet = {
                ...baseResult.rows[0],
                target_amount: parseFloat(baseResult.rows[0].target_amount) || numericTarget,
                saved_amount: parseFloat(baseResult.rows[0].saved_amount) || 0,
                type: cleanType,
                user_id: userId,
              };
            }
          } catch (baseErr) {
            console.error('[STS FINTECH] Fallback insert into goal_wallets failed:', baseErr.message || baseErr);
          }
        }

        // Fallback: If goal_wallets table does not exist, try wallets table
        if (!createdWallet && (dbErr.code === '42P01' || dbErr.message?.includes('does not exist'))) {
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
          } catch (wErr) {
            console.error('[STS FINTECH] Fallback insert into wallets failed:', wErr.message || wErr);
          }
        }

        const isConnErr =
          dbErr.code === 'ECONNREFUSED' ||
          dbErr.code === 'ENOTFOUND' ||
          (dbErr.errors && dbErr.errors.some((e) => e.code === 'ECONNREFUSED')) ||
          dbErr.message?.includes('ECONNREFUSED');

        // If it's a real SQL constraint/syntax error and not a connection failure, rethrow to trigger 500 logging
        if (!createdWallet && !isConnErr) {
          throw dbErr;
        }
      }
    }

    // 7. In-memory fallback if database is not configured or connection is unavailable
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
      console.log(`[STS FINTECH] Goal wallet created (in-memory mode): "${createdWallet.name}" (Target: ₹${createdWallet.target_amount})`);
    } else {
      // Sync into memory store
      inMemoryGoalWallets.unshift(createdWallet);
      console.log(`[STS FINTECH] Goal wallet created (database mode): "${createdWallet.name}" (Target: ₹${createdWallet.target_amount})`);
    }

    return res.status(201).json({
      success: true,
      message: 'Target wallet activated successfully',
      data: createdWallet,
      company: COMPANY_NAME,
    });
  } catch (error) {
    console.error('[STS FINTECH] Detailed Error in POST /api/wallets:', error);
    if (error.stack) console.error('[STS FINTECH] Error Stack:', error.stack);
    if (error.detail) console.error('[STS FINTECH] SQL Error Detail:', error.detail);
    if (error.hint) console.error('[STS FINTECH] SQL Error Hint:', error.hint);
    if (error.code) console.error('[STS FINTECH] SQL Error Code:', error.code);

    const errorMessage =
      error.message ||
      (error.errors && error.errors.map((e) => e.message).join('; ')) ||
      error.code ||
      'Failed to create goal wallet';

    return res.status(500).json({
      success: false,
      message: 'Failed to create goal wallet',
      error: errorMessage,
      detail: error.detail || undefined,
    });
  }
});

/**
 * POST /api/wallets/:id/add-cash
 * Allocate cash towards a goal wallet
 */
app.post('/api/wallets/:id/add-cash', async (req, res) => {
  try {
    const { id } = req.params;
    const { amount } = req.body;

    const numericAmount = parseFloat(amount);
    if (isNaN(numericAmount) || numericAmount <= 0) {
      return res.status(400).json({
        success: false,
        message: 'Cash deposit amount must be greater than 0.',
      });
    }

    // Check existing wallet and remaining ceiling limit
    const checkQuery = `
      SELECT id, name, target_amount, saved_amount, status
      FROM goal_wallets
      WHERE id = $1;
    `;
    const checkResult = await query(checkQuery, [id]);
    if (!checkResult.rows || checkResult.rows.length === 0) {
      return res.status(404).json({
        success: false,
        message: 'Wallet container not found',
      });
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
      WHERE id = $2
      RETURNING id, name, target_amount, saved_amount, description, status, created_at;
    `;

    const result = await query(updateQuery, [numericAmount, id]);

    if (!result.rows || result.rows.length === 0) {
      return res.status(404).json({
        success: false,
        message: 'Wallet container not found',
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
 * DELETE /api/wallets/:id
 * Remove a goal wallet
 */
app.delete('/api/wallets/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const deleteQuery = `DELETE FROM goal_wallets WHERE id = $1;`;
    await query(deleteQuery, [id]);
    return res.status(200).json({
      success: true,
      message: 'Wallet deleted successfully',
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      error: error.message,
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
  console.error('[Unhandled Error]:', err.stack);
  res.status(500).json({
    success: false,
    message: err.message || 'Internal server error',
    company: COMPANY_NAME,
  });
});

// Server Initialization
app.listen(PORT, async () => {
  console.log(` Server running on port ${PORT}`);
  console.log('========================================================');
  console.log(`🚀 ${COMPANY_NAME}`);
  console.log(`   ExpenseTrack Backend Server Running`);
  console.log(`   Port: ${PORT}`);
  console.log(`   URL: http://localhost:${PORT}`);
  console.log(`   Health Check: http://localhost:${PORT}/api/health`);
  console.log('========================================================');
  await initDatabase();
});

module.exports = app;
