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

// Auto-initialize the payments table on startup
const initDatabase = async () => {
  if (isDatabaseConfigured && pool) {
    const createTableQuery = `
      CREATE TABLE IF NOT EXISTS payments (
        id SERIAL PRIMARY KEY,
        title VARCHAR(255) NOT NULL,
        amount NUMERIC(12, 2) NOT NULL,
        status VARCHAR(50) DEFAULT 'completed',
        created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
      );
    `;
    try {
      await pool.query(createTableQuery);
      console.log('✅ [STS FINTECH] PostgreSQL "payments" table verified and ready.');
    } catch (error) {
      console.error('❌ [STS FINTECH] Error initializing payments table:', error.message);
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

    // Format amounts as numbers for consistent frontend consumption
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

    // Validation
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

// Root route
app.get('/', (req, res) => {
  res.json({
    message: `Welcome to ${COMPANY_NAME} Expense & Payment Tracking API`,
    documentation: {
      health: 'GET /api/health',
      payments: 'GET /api/payments',
      createPayment: 'POST /api/payments',
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
