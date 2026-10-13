require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { pool, query, isDatabaseConfigured } = require('./db');

const app = express();
const PORT = process.env.PORT || 5000;
const CLIENT_URL = process.env.CLIENT_URL || 'http://localhost:5173';

const COMPANY_NAME = 'STS FINTECH PRIVATE LIMITED';

// Configure CORS to support frontend client communication
const allowedOrigins = [
  CLIENT_URL,
  'http://localhost:5173',
  'http://localhost:3000',
  'http://localhost:5174',
  'http://127.0.0.1:5173',
];

app.use(cors({
  origin: (origin, callback) => {
    // Allow requests with no origin (like mobile apps, curl, Postman)
    if (!origin || allowedOrigins.includes(origin) || process.env.NODE_ENV !== 'production') {
      return callback(null, true);
    }
    return callback(new Error('CORS not allowed for this origin by STS FINTECH policy'));
  },
  credentials: true,
}));

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
  if (isDatabaseConfigured && pool) {
    const createPaymentsTableQuery = `
      CREATE TABLE IF NOT EXISTS payments (
        id SERIAL PRIMARY KEY,
        title VARCHAR(255) NOT NULL,
        amount NUMERIC(12, 2) NOT NULL,
        status VARCHAR(50) DEFAULT 'completed',
        created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
      );
    `;

    const createFinanceRecordsTableQuery = `
      CREATE TABLE IF NOT EXISTS finance_records (
        id SERIAL PRIMARY KEY,
        type VARCHAR(50) NOT NULL,
        name VARCHAR(255) NOT NULL,
        description TEXT,
        date DATE,
        time VARCHAR(50),
        schedule VARCHAR(100),
        category VARCHAR(100),
        associated_wallet VARCHAR(100),
        amount NUMERIC(12, 2) NOT NULL DEFAULT 0.00,
        created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
      );
    `;

    const createGoalWalletsTableQuery = `
      CREATE TABLE IF NOT EXISTS goal_wallets (
        id SERIAL PRIMARY KEY,
        name VARCHAR(255) NOT NULL,
        target_amount NUMERIC(12, 2) NOT NULL DEFAULT 0.00,
        saved_amount NUMERIC(12, 2) NOT NULL DEFAULT 0.00,
        description TEXT,
        status VARCHAR(50) DEFAULT 'in_progress',
        created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
      );
    `;

    try {
      await pool.query(createPaymentsTableQuery);
      await pool.query(createFinanceRecordsTableQuery);
      await pool.query(createGoalWalletsTableQuery);
      console.log('✅ [STS FINTECH] PostgreSQL "payments", "finance_records" & "goal_wallets" tables verified.');
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
      SELECT id, title, amount, status, created_at 
      FROM payments 
      ORDER BY created_at DESC;
    `;
    const result = await query(selectQuery);

    const formattedRows = result.rows.map((row) => ({
      ...row,
      amount: parseFloat(row.amount),
    }));

    return res.status(200).json({
      success: true,
      count: formattedRows.length,
      data: formattedRows,
      company: COMPANY_NAME,
    });
  } catch (error) {
    console.error('Error fetching payments:', error);
    return res.status(500).json({
      success: false,
      message: 'Failed to retrieve payments',
      error: error.message,
    });
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
    let result;

    if (type) {
      const selectQuery = `
        SELECT id, type, name, description, date, time, schedule, category, associated_wallet, amount, created_at
        FROM finance_records
        WHERE type = $1
        ORDER BY date DESC, created_at DESC;
      `;
      result = await query(selectQuery, [type]);
    } else {
      const selectQuery = `
        SELECT id, type, name, description, date, time, schedule, category, associated_wallet, amount, created_at
        FROM finance_records
        ORDER BY date DESC, created_at DESC;
      `;
      result = await query(selectQuery);
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
  } catch (error) {
    console.error('Error fetching segregation records:', error);
    return res.status(500).json({
      success: false,
      message: 'Failed to retrieve segregation records',
      error: error.message,
    });
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

    const insertQuery = `
      INSERT INTO finance_records (type, name, description, date, time, schedule, category, associated_wallet, amount)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
      RETURNING id, type, name, description, date, time, schedule, category, associated_wallet, amount, created_at;
    `;

    const result = await query(insertQuery, [
      type,
      name.trim(),
      description.trim(),
      cleanDate,
      cleanTime,
      schedule,
      category,
      associated_wallet,
      numericAmount,
    ]);

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

    const updateQuery = `
      UPDATE finance_records
      SET name = $1, description = $2, date = $3, time = $4, schedule = $5, category = $6, associated_wallet = $7, amount = $8
      WHERE id = $9
      RETURNING id, type, name, description, date, time, schedule, category, associated_wallet, amount, created_at;
    `;

    const result = await query(updateQuery, [
      name.trim(),
      description.trim(),
      cleanDate,
      cleanTime,
      schedule,
      category,
      associated_wallet,
      numericAmount,
      parseInt(id, 10),
    ]);

    if (!result.rows || result.rows.length === 0) {
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
    const selectQuery = `
      SELECT id, name, target_amount, saved_amount, description, status, created_at
      FROM goal_wallets
      ORDER BY created_at DESC;
    `;
    const result = await query(selectQuery);

    const formattedRows = result.rows.map((row) => ({
      ...row,
      target_amount: parseFloat(row.target_amount) || 0,
      saved_amount: parseFloat(row.saved_amount) || 0,
    }));

    return res.status(200).json({
      success: true,
      count: formattedRows.length,
      data: formattedRows,
      company: COMPANY_NAME,
    });
  } catch (error) {
    console.error('Error fetching goal wallets:', error);
    return res.status(500).json({
      success: false,
      message: 'Failed to retrieve goal wallets',
      error: error.message,
    });
  }
});

/**
 * POST /api/wallets
 * Setup a new purpose target wallet
 */
app.post('/api/wallets', async (req, res) => {
  try {
    const { name, target_amount, description = '' } = req.body;

    if (!name || typeof name !== 'string' || name.trim().length === 0) {
      return res.status(400).json({
        success: false,
        message: 'Purpose / Item name is required.',
      });
    }

    const numericTarget = parseFloat(target_amount);
    if (isNaN(numericTarget) || numericTarget <= 0) {
      return res.status(400).json({
        success: false,
        message: 'Target cap amount must be a positive number.',
      });
    }

    const insertQuery = `
      INSERT INTO goal_wallets (name, target_amount, saved_amount, description, status)
      VALUES ($1, $2, $3, $4, $5)
      RETURNING id, name, target_amount, saved_amount, description, status, created_at;
    `;

    const result = await query(insertQuery, [
      name.trim(),
      numericTarget,
      0.0,
      (description || '').trim(),
      'in_progress',
    ]);

    const createdWallet = {
      ...result.rows[0],
      target_amount: parseFloat(result.rows[0].target_amount) || numericTarget,
      saved_amount: parseFloat(result.rows[0].saved_amount) || 0,
    };

    console.log(`[STS FINTECH] Goal wallet created: "${createdWallet.name}" (Target: ₹${createdWallet.target_amount})`);

    return res.status(201).json({
      success: true,
      message: 'Target wallet activated successfully',
      data: createdWallet,
      company: COMPANY_NAME,
    });
  } catch (error) {
    console.error('Error creating goal wallet:', error);
    return res.status(500).json({
      success: false,
      message: 'Failed to create goal wallet',
      error: error.message,
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
