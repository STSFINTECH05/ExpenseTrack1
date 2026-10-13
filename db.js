const { Pool } = require('pg');
require('dotenv').config();

/**
 * PostgreSQL Connection Pool for STS FINTECH PRIVATE LIMITED
 * Configured with SSL support for Render, production, and cloud environments.
 */
const databaseUrl = process.env.DATABASE_URL || '';
const isProduction = process.env.NODE_ENV === 'production';
const requiresSsl =
  isProduction ||
  databaseUrl.includes('render.com') ||
  databaseUrl.includes('dpg-') ||
  databaseUrl.includes('supabase') ||
  databaseUrl.includes('neon.tech') ||
  databaseUrl.includes('amazonaws.com') ||
  databaseUrl.includes('sslmode=require');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: requiresSsl ? { rejectUnauthorized: false } : false,
});

pool.on('error', (err) => {
  console.error(' PostgreSQL connection error: ', err.message || err);
});

/**
 * Automatically initializes and migrates all required PostgreSQL tables on startup:
 * - wallets (id, name, type, balance, user_id, created_at)
 * - segregation (id, name, description, date, time, category, wallet_id, amount, schedule, type, user_id, created_at)
 * - payments (id, name, amount, date, status, user_id, created_at)
 * - goal_wallets & finance_records (referenced in routes)
 */
const initDatabase = async (client = pool) => {
  if (!process.env.DATABASE_URL) {
    console.log('ℹ️ [STS FINTECH] No DATABASE_URL provided; skipping PostgreSQL table auto-initialization.');
    return;
  }

  const bootstrapSql = `
    -- 1. wallets
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

    ALTER TABLE wallets ADD COLUMN IF NOT EXISTS type VARCHAR(100) DEFAULT 'general';
    ALTER TABLE wallets ADD COLUMN IF NOT EXISTS balance NUMERIC(12, 2) NOT NULL DEFAULT 0.00;
    ALTER TABLE wallets ADD COLUMN IF NOT EXISTS target_amount NUMERIC(12, 2) DEFAULT 0.00;
    ALTER TABLE wallets ADD COLUMN IF NOT EXISTS saved_amount NUMERIC(12, 2) DEFAULT 0.00;
    ALTER TABLE wallets ADD COLUMN IF NOT EXISTS description TEXT DEFAULT '';
    ALTER TABLE wallets ADD COLUMN IF NOT EXISTS status VARCHAR(50) DEFAULT 'active';
    ALTER TABLE wallets ADD COLUMN IF NOT EXISTS user_id VARCHAR(255);

    -- 2. segregation
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

    ALTER TABLE segregation ADD COLUMN IF NOT EXISTS description TEXT DEFAULT '';
    ALTER TABLE segregation ADD COLUMN IF NOT EXISTS date DATE DEFAULT CURRENT_DATE;
    ALTER TABLE segregation ADD COLUMN IF NOT EXISTS time VARCHAR(50);
    ALTER TABLE segregation ADD COLUMN IF NOT EXISTS category VARCHAR(100) DEFAULT 'General';
    ALTER TABLE segregation ADD COLUMN IF NOT EXISTS wallet_id VARCHAR(100);
    ALTER TABLE segregation ADD COLUMN IF NOT EXISTS associated_wallet VARCHAR(100) DEFAULT 'Primary Wallet';
    ALTER TABLE segregation ADD COLUMN IF NOT EXISTS amount NUMERIC(12, 2) NOT NULL DEFAULT 0.00;
    ALTER TABLE segregation ADD COLUMN IF NOT EXISTS schedule VARCHAR(100) DEFAULT 'One-time';
    ALTER TABLE segregation ADD COLUMN IF NOT EXISTS type VARCHAR(50) DEFAULT 'additional_expense';
    ALTER TABLE segregation ADD COLUMN IF NOT EXISTS user_id VARCHAR(255);

    -- 3. payments
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

    ALTER TABLE payments ADD COLUMN IF NOT EXISTS name VARCHAR(255);
    ALTER TABLE payments ADD COLUMN IF NOT EXISTS title VARCHAR(255);
    ALTER TABLE payments ADD COLUMN IF NOT EXISTS amount NUMERIC(12, 2) NOT NULL DEFAULT 0.00;
    ALTER TABLE payments ADD COLUMN IF NOT EXISTS date DATE DEFAULT CURRENT_DATE;
    ALTER TABLE payments ADD COLUMN IF NOT EXISTS status VARCHAR(50) DEFAULT 'completed';
    ALTER TABLE payments ADD COLUMN IF NOT EXISTS user_id VARCHAR(255);

    -- 4. goal_wallets (referenced in routes)
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

    ALTER TABLE goal_wallets ADD COLUMN IF NOT EXISTS type VARCHAR(100) DEFAULT 'goal';
    ALTER TABLE goal_wallets ADD COLUMN IF NOT EXISTS balance NUMERIC(12, 2) DEFAULT 0.00;
    ALTER TABLE goal_wallets ADD COLUMN IF NOT EXISTS user_id VARCHAR(255);

    -- 5. finance_records (referenced in routes)
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

    ALTER TABLE finance_records ADD COLUMN IF NOT EXISTS wallet_id VARCHAR(100);
    ALTER TABLE finance_records ADD COLUMN IF NOT EXISTS user_id VARCHAR(255);
  `;

  try {
    await client.query(bootstrapSql);
    console.log('✅ [STS FINTECH] PostgreSQL tables verified and initialized: "wallets", "segregation", "payments", "goal_wallets", "finance_records".');
  } catch (err) {
    console.error('❌ [STS FINTECH] Error initializing tables:', err.message);
  }
};

// Immediate test query to verify database connectivity on startup and run migration
if (process.env.DATABASE_URL) {
  pool.query('SELECT NOW()')
    .then(async () => {
      console.log(' Connected to PostgreSQL database successfully');
      await initDatabase(pool);
    })
    .catch((err) => {
      console.error(' PostgreSQL connection error: ', err.message || err);
    });
}

pool.initDatabase = initDatabase;
pool.pool = pool;

module.exports = pool;
