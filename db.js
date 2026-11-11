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
 * - split_groups & split_group_members & split_expenses & split_expense_shares & split_settlements
 * - ai_conversations & ai_chat_messages
 * - bills, goal_targets, expenses
 */
const initDatabase = async (client = pool) => {
  if (!process.env.DATABASE_URL) {
    console.log('ℹ️ [STS FINTECH] No DATABASE_URL provided; skipping PostgreSQL table auto-initialization.');
    return;
  }

  // 0. Base users and session tables created first so foreign keys and migrations succeed
  const baseUsersSql = `
    CREATE TABLE IF NOT EXISTS users (
      id SERIAL PRIMARY KEY,
      name VARCHAR(150),
      full_name VARCHAR(150),
      email VARCHAR(255) NOT NULL,
      password_hash TEXT NOT NULL,
      role VARCHAR(50) NOT NULL DEFAULT 'finance_member',
      is_active BOOLEAN NOT NULL DEFAULT TRUE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    ALTER TABLE users ADD COLUMN IF NOT EXISTS name VARCHAR(150);
    ALTER TABLE users ADD COLUMN IF NOT EXISTS full_name VARCHAR(150);
    ALTER TABLE users ADD COLUMN IF NOT EXISTS role VARCHAR(50) DEFAULT 'finance_member';
    ALTER TABLE users ADD COLUMN IF NOT EXISTS is_active BOOLEAN DEFAULT TRUE;
    ALTER TABLE users ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP;

    CREATE UNIQUE INDEX IF NOT EXISTS users_email_lower_unique ON users (LOWER(email));

    CREATE TABLE IF NOT EXISTS user_sessions (
      sid VARCHAR NOT NULL PRIMARY KEY,
      sess JSON NOT NULL,
      expire TIMESTAMP(6) NOT NULL
    );
    CREATE INDEX IF NOT EXISTS user_sessions_expire_idx ON user_sessions (expire);

    CREATE TABLE IF NOT EXISTS schema_migrations (
      id SERIAL PRIMARY KEY,
      filename VARCHAR(255) UNIQUE NOT NULL,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
  `;

  const statements = [
    { name: 'users and sessions base schema', sql: baseUsersSql },
    {
      name: 'wallets table',
      sql: `
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
        ALTER TABLE wallets ADD COLUMN IF NOT EXISTS user_email VARCHAR(255);
        CREATE INDEX IF NOT EXISTS idx_wallets_user_id ON wallets(user_id);
        CREATE INDEX IF NOT EXISTS idx_wallets_user_email ON wallets(user_email);
      `,
    },
    {
      name: 'segregation table',
      sql: `
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
        ALTER TABLE segregation ADD COLUMN IF NOT EXISTS user_email VARCHAR(255);
        CREATE INDEX IF NOT EXISTS idx_segregation_user_id ON segregation(user_id);
        CREATE INDEX IF NOT EXISTS idx_segregation_user_email ON segregation(user_email);
      `,
    },
    {
      name: 'payments table',
      sql: `
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
        ALTER TABLE payments ADD COLUMN IF NOT EXISTS user_email VARCHAR(255);
        CREATE INDEX IF NOT EXISTS idx_payments_user_id ON payments(user_id);
        CREATE INDEX IF NOT EXISTS idx_payments_user_email ON payments(user_email);
      `,
    },
    {
      name: 'goal_wallets table',
      sql: `
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
        ALTER TABLE goal_wallets ADD COLUMN IF NOT EXISTS user_email VARCHAR(255);
        CREATE INDEX IF NOT EXISTS idx_goal_wallets_user_id ON goal_wallets(user_id);
        CREATE INDEX IF NOT EXISTS idx_goal_wallets_user_email ON goal_wallets(user_email);
      `,
    },
    {
      name: 'finance_records table',
      sql: `
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
        ALTER TABLE finance_records ADD COLUMN IF NOT EXISTS user_email VARCHAR(255);
        CREATE INDEX IF NOT EXISTS idx_finance_records_user_id ON finance_records(user_id);
        CREATE INDEX IF NOT EXISTS idx_finance_records_user_email ON finance_records(user_email);
      `,
    },
    {
      name: 'split_groups and related tables',
      sql: `
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

        CREATE TABLE IF NOT EXISTS split_expense_shares (
          id SERIAL PRIMARY KEY,
          expense_id INTEGER NOT NULL REFERENCES split_expenses(id) ON DELETE CASCADE,
          member_id INTEGER NOT NULL REFERENCES split_group_members(id) ON DELETE CASCADE,
          share_amount NUMERIC(12, 2) NOT NULL DEFAULT 0.00,
          is_paid BOOLEAN NOT NULL DEFAULT FALSE
        );

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
      `,
    },
    {
      name: 'ai_conversations and ai_chat_messages tables',
      sql: `
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
      `,
    },
    {
      name: 'bills table',
      sql: `
        CREATE TABLE IF NOT EXISTS bills (
          id SERIAL PRIMARY KEY,
          name VARCHAR(255) NOT NULL,
          description TEXT DEFAULT '',
          date DATE DEFAULT CURRENT_DATE,
          due_date DATE DEFAULT CURRENT_DATE,
          time VARCHAR(50),
          schedule VARCHAR(100) DEFAULT 'Monthly (1st)',
          category VARCHAR(100) DEFAULT 'Utilities',
          associated_wallet VARCHAR(100) DEFAULT 'Primary Wallet',
          amount NUMERIC(12, 2) NOT NULL DEFAULT 0.00,
          status VARCHAR(50) DEFAULT 'pending',
          user_id INTEGER REFERENCES users(id) ON DELETE RESTRICT,
          user_email VARCHAR(255),
          created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
        );

        ALTER TABLE bills ADD COLUMN IF NOT EXISTS due_date DATE DEFAULT CURRENT_DATE;
        ALTER TABLE bills ADD COLUMN IF NOT EXISTS status VARCHAR(50) DEFAULT 'pending';
        ALTER TABLE bills ADD COLUMN IF NOT EXISTS user_id INTEGER;
        ALTER TABLE bills ADD COLUMN IF NOT EXISTS user_email VARCHAR(255);
        CREATE INDEX IF NOT EXISTS idx_bills_user_id ON bills(user_id);
        CREATE INDEX IF NOT EXISTS idx_bills_user_email ON bills(user_email);
      `,
    },
    {
      name: 'goal_targets table',
      sql: `
        CREATE TABLE IF NOT EXISTS goal_targets (
          id SERIAL PRIMARY KEY,
          name VARCHAR(255) NOT NULL,
          target_amount NUMERIC(12, 2) NOT NULL DEFAULT 0.00,
          saved_amount NUMERIC(12, 2) NOT NULL DEFAULT 0.00,
          description TEXT DEFAULT '',
          status VARCHAR(50) DEFAULT 'in_progress',
          type VARCHAR(100) DEFAULT 'goal',
          balance NUMERIC(12, 2) DEFAULT 0.00,
          user_id INTEGER REFERENCES users(id) ON DELETE RESTRICT,
          user_email VARCHAR(255),
          created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
        );

        ALTER TABLE goal_targets ADD COLUMN IF NOT EXISTS type VARCHAR(100) DEFAULT 'goal';
        ALTER TABLE goal_targets ADD COLUMN IF NOT EXISTS balance NUMERIC(12, 2) DEFAULT 0.00;
        ALTER TABLE goal_targets ADD COLUMN IF NOT EXISTS user_id INTEGER;
        ALTER TABLE goal_targets ADD COLUMN IF NOT EXISTS user_email VARCHAR(255);
        CREATE INDEX IF NOT EXISTS idx_goal_targets_user_id ON goal_targets(user_id);
        CREATE INDEX IF NOT EXISTS idx_goal_targets_user_email ON goal_targets(user_email);
      `,
    },
    {
      name: 'expenses table',
      sql: `
        CREATE TABLE IF NOT EXISTS expenses (
          id SERIAL PRIMARY KEY,
          name VARCHAR(255) NOT NULL,
          description TEXT DEFAULT '',
          date DATE DEFAULT CURRENT_DATE,
          time VARCHAR(50),
          category VARCHAR(100) DEFAULT 'General',
          associated_wallet VARCHAR(100) DEFAULT 'Primary Wallet',
          amount NUMERIC(12, 2) NOT NULL DEFAULT 0.00,
          type VARCHAR(50) DEFAULT 'additional_expense',
          user_id INTEGER REFERENCES users(id) ON DELETE RESTRICT,
          user_email VARCHAR(255),
          created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
        );

        ALTER TABLE expenses ADD COLUMN IF NOT EXISTS type VARCHAR(50) DEFAULT 'additional_expense';
        ALTER TABLE expenses ADD COLUMN IF NOT EXISTS user_id INTEGER;
        ALTER TABLE expenses ADD COLUMN IF NOT EXISTS user_email VARCHAR(255);
        CREATE INDEX IF NOT EXISTS idx_expenses_user_id ON expenses(user_id);
        CREATE INDEX IF NOT EXISTS idx_expenses_user_email ON expenses(user_email);
      `,
    },
  ];

  for (const step of statements) {
    try {
      await client.query(step.sql);
    } catch (err) {
      console.warn(`⚠️ [STS FINTECH] Non-fatal notice in table initialization (${step.name}):`, err.message);
    }
  }

  console.log('✅ [STS FINTECH] PostgreSQL tables verified and initialized: "users", "wallets", "segregation", "payments", "goal_wallets", "finance_records", "split_groups", "ai_conversations", "bills", "goal_targets", "expenses".');
};

pool.initDatabase = initDatabase;

module.exports = pool;
