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
  connectionString: databaseUrl,
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
      user_id INTEGER REFERENCES users(id) ON DELETE RESTRICT,
      created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
    );

    ALTER TABLE wallets ADD COLUMN IF NOT EXISTS type VARCHAR(100) DEFAULT 'general';
    ALTER TABLE wallets ADD COLUMN IF NOT EXISTS balance NUMERIC(12, 2) NOT NULL DEFAULT 0.00;
    ALTER TABLE wallets ADD COLUMN IF NOT EXISTS target_amount NUMERIC(12, 2) DEFAULT 0.00;
    ALTER TABLE wallets ADD COLUMN IF NOT EXISTS saved_amount NUMERIC(12, 2) DEFAULT 0.00;
    ALTER TABLE wallets ADD COLUMN IF NOT EXISTS description TEXT DEFAULT '';
    ALTER TABLE wallets ADD COLUMN IF NOT EXISTS status VARCHAR(50) DEFAULT 'active';
    ALTER TABLE wallets ADD COLUMN IF NOT EXISTS user_id INTEGER;

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
      user_id INTEGER REFERENCES users(id) ON DELETE RESTRICT,
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
    ALTER TABLE segregation ADD COLUMN IF NOT EXISTS user_id INTEGER;

    -- 3. payments
    CREATE TABLE IF NOT EXISTS payments (
      id SERIAL PRIMARY KEY,
      name VARCHAR(255),
      title VARCHAR(255),
      amount NUMERIC(12, 2) NOT NULL DEFAULT 0.00,
      date DATE DEFAULT CURRENT_DATE,
      status VARCHAR(50) DEFAULT 'completed',
      user_id INTEGER REFERENCES users(id) ON DELETE RESTRICT,
      created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
    );

    ALTER TABLE payments ADD COLUMN IF NOT EXISTS name VARCHAR(255);
    ALTER TABLE payments ADD COLUMN IF NOT EXISTS title VARCHAR(255);
    ALTER TABLE payments ADD COLUMN IF NOT EXISTS amount NUMERIC(12, 2) NOT NULL DEFAULT 0.00;
    ALTER TABLE payments ADD COLUMN IF NOT EXISTS date DATE DEFAULT CURRENT_DATE;
    ALTER TABLE payments ADD COLUMN IF NOT EXISTS status VARCHAR(50) DEFAULT 'completed';
    ALTER TABLE payments ADD COLUMN IF NOT EXISTS user_id INTEGER;

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
      user_id INTEGER REFERENCES users(id) ON DELETE RESTRICT,
      created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
    );

    ALTER TABLE goal_wallets ADD COLUMN IF NOT EXISTS type VARCHAR(100) DEFAULT 'goal';
    ALTER TABLE goal_wallets ADD COLUMN IF NOT EXISTS balance NUMERIC(12, 2) DEFAULT 0.00;
    ALTER TABLE goal_wallets ADD COLUMN IF NOT EXISTS user_id INTEGER;

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
      user_id INTEGER REFERENCES users(id) ON DELETE RESTRICT,
      created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
    );

    ALTER TABLE finance_records ADD COLUMN IF NOT EXISTS wallet_id VARCHAR(100);
    ALTER TABLE finance_records ADD COLUMN IF NOT EXISTS user_id INTEGER;

    -- 6. split_groups
    CREATE TABLE IF NOT EXISTS split_groups (
      id SERIAL PRIMARY KEY,
      title VARCHAR(255) NOT NULL,
      location VARCHAR(255) DEFAULT '',
      currency VARCHAR(50) DEFAULT 'INR (₹)',
      description TEXT DEFAULT '',
      owner_id INTEGER NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    -- 7. split_group_members
    CREATE TABLE IF NOT EXISTS split_group_members (
      id SERIAL PRIMARY KEY,
      group_id INTEGER NOT NULL REFERENCES split_groups(id) ON DELETE CASCADE,
      user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
      name VARCHAR(150) NOT NULL,
      email VARCHAR(255),
      role VARCHAR(50) NOT NULL DEFAULT 'member',
      status VARCHAR(50) NOT NULL DEFAULT 'accepted',
      is_self BOOLEAN NOT NULL DEFAULT FALSE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    -- 8. split_expenses
    CREATE TABLE IF NOT EXISTS split_expenses (
      id SERIAL PRIMARY KEY,
      group_id INTEGER NOT NULL REFERENCES split_groups(id) ON DELETE CASCADE,
      title VARCHAR(255) NOT NULL,
      amount NUMERIC(12, 2) NOT NULL CHECK (amount > 0),
      paid_by_member_id INTEGER REFERENCES split_group_members(id) ON DELETE SET NULL,
      paid_by_name VARCHAR(150) NOT NULL,
      created_by_user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
      expense_date DATE DEFAULT CURRENT_DATE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    -- 9. split_expense_shares
    CREATE TABLE IF NOT EXISTS split_expense_shares (
      id SERIAL PRIMARY KEY,
      expense_id INTEGER NOT NULL REFERENCES split_expenses(id) ON DELETE CASCADE,
      member_id INTEGER NOT NULL REFERENCES split_group_members(id) ON DELETE CASCADE,
      share_amount NUMERIC(12, 2) NOT NULL DEFAULT 0.00,
      is_paid BOOLEAN NOT NULL DEFAULT FALSE
    );

    -- 10. split_settlements
    CREATE TABLE IF NOT EXISTS split_settlements (
      id SERIAL PRIMARY KEY,
      group_id INTEGER NOT NULL REFERENCES split_groups(id) ON DELETE CASCADE,
      from_member_id INTEGER REFERENCES split_group_members(id) ON DELETE SET NULL,
      from_name VARCHAR(150) NOT NULL,
      to_member_id INTEGER REFERENCES split_group_members(id) ON DELETE SET NULL,
      to_name VARCHAR(150) NOT NULL,
      amount NUMERIC(12, 2) NOT NULL CHECK (amount > 0),
      debt_key VARCHAR(255),
      settled_by_user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
      notes TEXT DEFAULT '',
      settled_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    -- 11. ai_conversations
    CREATE TABLE IF NOT EXISTS ai_conversations (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      title VARCHAR(255) DEFAULT 'Financial Advisory Session',
      language VARCHAR(10) DEFAULT 'en-IN',
      created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE INDEX IF NOT EXISTS idx_ai_conversations_user_id ON ai_conversations(user_id);
    CREATE INDEX IF NOT EXISTS idx_ai_conversations_updated_at ON ai_conversations(updated_at DESC);

    -- 12. ai_chat_messages
    CREATE TABLE IF NOT EXISTS ai_chat_messages (
      id SERIAL PRIMARY KEY,
      conversation_id UUID NOT NULL REFERENCES ai_conversations(id) ON DELETE CASCADE,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      role VARCHAR(20) NOT NULL CHECK (role IN ('user', 'assistant', 'system', 'tool')),
      content TEXT NOT NULL,
      tool_calls JSONB,
      tool_call_id VARCHAR(100),
      financial_data JSONB,
      created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE INDEX IF NOT EXISTS idx_ai_chat_messages_conv_created ON ai_chat_messages(conversation_id, created_at ASC);
    CREATE INDEX IF NOT EXISTS idx_ai_chat_messages_user_id ON ai_chat_messages(user_id);
  `;

  try {
    await client.query(bootstrapSql);
    console.log('✅ [STS FINTECH] PostgreSQL tables verified and initialized: "wallets", "segregation", "payments", "goal_wallets", "finance_records", "split_groups".');
  } catch (err) {
    console.error(
      '❌ [STS FINTECH] Database initialization failed:',
      err.message
    );
    throw err;
  }
};

pool.initDatabase = initDatabase;

module.exports = pool;

