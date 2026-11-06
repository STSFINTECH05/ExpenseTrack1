require('dotenv').config();

const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const pool = require('./db');

const { sessionMiddleware } = require('./config/session');
const { csrfProtection } = require('./middleware/csrf');
const authenticate = require('./middleware/authenticate');
const authRoutes = require('./routes/auth.routes');

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

// Exact frontend origin allowlist.
// Configure CLIENT_URLS as comma-separated URLs.
const allowedOrigins = (
  process.env.CLIENT_URLS ||
  process.env.CLIENT_URL ||
  'http://localhost:5173'
)
  .split(',')
  .map(origin => origin.trim())
  .filter(Boolean);

const corsOptions = {
  origin: (origin, callback) => {
    if (!origin || allowedOrigins.includes(origin)) {
      return callback(null, true);
    }

    return callback(new Error('Origin not allowed by CORS'));
  },
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: [
    'Content-Type',
    'X-CSRF-Token',
    'X-Company-Name',
    'X-Service'
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

// CSRF protection for all API requests that modify data
app.use('/api', csrfProtection);

// Authentication endpoints
app.use('/api/auth', authRoutes);

// Protect all remaining API endpoints
app.use('/api', authenticate);
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
