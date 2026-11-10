-- =========================================================================
-- Migration: 002_user_data_isolation.sql
-- Description: Implement secure multi-user data isolation preserving INTEGER user ID
-- Target Database: PostgreSQL 14+
-- Safe, non-destructive, and idempotent migration
-- =========================================================================

BEGIN;

-- -------------------------------------------------------------------------
-- STEP 1: Schema Migrations Tracking Table
-- -------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS schema_migrations (
    id SERIAL PRIMARY KEY,
    filename VARCHAR(255) UNIQUE NOT NULL,
    applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- -------------------------------------------------------------------------
-- STEP 2: Harmonize `users` Table Schema with Auth System (Preserving INTEGER PK)
-- -------------------------------------------------------------------------
-- Add missing columns expected by routes/auth.routes.js & middleware/authenticate.js
-- Preserves existing user IDs, full_name, and password hashes
ALTER TABLE users ADD COLUMN IF NOT EXISTS name VARCHAR(150);
ALTER TABLE users ADD COLUMN IF NOT EXISTS role VARCHAR(50) DEFAULT 'finance_member';
ALTER TABLE users ADD COLUMN IF NOT EXISTS is_active BOOLEAN DEFAULT TRUE;
ALTER TABLE users ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ DEFAULT NOW();

-- Safely backfill `name` from `full_name` where `name` is NULL
DO $$
BEGIN
    IF EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'users' AND column_name = 'full_name'
    ) THEN
        UPDATE users
        SET name = full_name
        WHERE name IS NULL AND full_name IS NOT NULL;
    END IF;
END $$;

-- Add role check constraint if not present (table-specific check)
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.table_constraints
        WHERE table_schema = 'public'
          AND table_name = 'users'
          AND constraint_name = 'users_role_check'
    ) THEN
        ALTER TABLE users ADD CONSTRAINT users_role_check CHECK (role IN ('finance_member', 'admin'));
    END IF;
END $$;

-- Case-insensitive unique index on lower(email)
CREATE UNIQUE INDEX IF NOT EXISTS users_email_lower_unique ON users (LOWER(email));

-- Ensure user_sessions table exists for session management
CREATE TABLE IF NOT EXISTS user_sessions (
    sid VARCHAR NOT NULL PRIMARY KEY,
    sess JSON NOT NULL,
    expire TIMESTAMP(6) NOT NULL
);
CREATE INDEX IF NOT EXISTS user_sessions_expire_idx ON user_sessions (expire);

-- -------------------------------------------------------------------------
-- STEP 3: Convert Financial Tables `user_id` Column to INTEGER Type
-- -------------------------------------------------------------------------
-- Safely converts existing VARCHAR user_id to INTEGER (preserves NULLs for unowned records)

-- 3.1 segregation table
DO $$
BEGIN
    IF EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'segregation'
          AND column_name = 'user_id' AND data_type != 'integer'
    ) THEN
        ALTER TABLE segregation
            ALTER COLUMN user_id TYPE INTEGER USING (NULLIF(user_id, '')::integer);
    END IF;
END $$;

-- 3.2 finance_records table (Preserves existing NULL records like Test Expense)
DO $$
BEGIN
    IF EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'finance_records'
          AND column_name = 'user_id' AND data_type != 'integer'
    ) THEN
        ALTER TABLE finance_records
            ALTER COLUMN user_id TYPE INTEGER USING (NULLIF(user_id, '')::integer);
    END IF;
END $$;

-- 3.3 wallets table
DO $$
BEGIN
    IF EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'wallets'
          AND column_name = 'user_id' AND data_type != 'integer'
    ) THEN
        ALTER TABLE wallets
            ALTER COLUMN user_id TYPE INTEGER USING (NULLIF(user_id, '')::integer);
    END IF;
END $$;

-- 3.4 goal_wallets table
DO $$
BEGIN
    IF EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'goal_wallets'
          AND column_name = 'user_id' AND data_type != 'integer'
    ) THEN
        ALTER TABLE goal_wallets
            ALTER COLUMN user_id TYPE INTEGER USING (NULLIF(user_id, '')::integer);
    END IF;
END $$;

-- 3.5 payments table
DO $$
BEGIN
    IF EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'payments'
          AND column_name = 'user_id' AND data_type != 'integer'
    ) THEN
        ALTER TABLE payments
            ALTER COLUMN user_id TYPE INTEGER USING (NULLIF(user_id, '')::integer);
    END IF;
END $$;

-- -------------------------------------------------------------------------
-- STEP 4: Add Foreign Key Constraints with ON DELETE RESTRICT (Table-Specific Checks)
-- -------------------------------------------------------------------------
-- Uses ON DELETE RESTRICT for financial data retention and audit integrity.
-- Allows NULL for legacy unassigned records while enforcing valid user references for assigned records.

DO $$
BEGIN
    -- 4.1 segregation
    IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'segregation')
       AND NOT EXISTS (
           SELECT 1 FROM information_schema.table_constraints
           WHERE table_schema = 'public'
             AND table_name = 'segregation'
             AND constraint_name = 'fk_segregation_user'
       ) THEN
        ALTER TABLE segregation
            ADD CONSTRAINT fk_segregation_user
            FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE RESTRICT;
    END IF;

    -- 4.2 finance_records
    IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'finance_records')
       AND NOT EXISTS (
           SELECT 1 FROM information_schema.table_constraints
           WHERE table_schema = 'public'
             AND table_name = 'finance_records'
             AND constraint_name = 'fk_finance_records_user'
       ) THEN
        ALTER TABLE finance_records
            ADD CONSTRAINT fk_finance_records_user
            FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE RESTRICT;
    END IF;

    -- 4.3 wallets
    IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'wallets')
       AND NOT EXISTS (
           SELECT 1 FROM information_schema.table_constraints
           WHERE table_schema = 'public'
             AND table_name = 'wallets'
             AND constraint_name = 'fk_wallets_user'
       ) THEN
        ALTER TABLE wallets
            ADD CONSTRAINT fk_wallets_user
            FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE RESTRICT;
    END IF;

    -- 4.4 goal_wallets
    IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'goal_wallets')
       AND NOT EXISTS (
           SELECT 1 FROM information_schema.table_constraints
           WHERE table_schema = 'public'
             AND table_name = 'goal_wallets'
             AND constraint_name = 'fk_goal_wallets_user'
       ) THEN
        ALTER TABLE goal_wallets
            ADD CONSTRAINT fk_goal_wallets_user
            FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE RESTRICT;
    END IF;

    -- 4.5 payments
    IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'payments')
       AND NOT EXISTS (
           SELECT 1 FROM information_schema.table_constraints
           WHERE table_schema = 'public'
             AND table_name = 'payments'
             AND constraint_name = 'fk_payments_user'
       ) THEN
        ALTER TABLE payments
            ADD CONSTRAINT fk_payments_user
            FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE RESTRICT;
    END IF;
END $$;

-- -------------------------------------------------------------------------
-- STEP 5: Add Performance Indexes (Guarded by Table-Existence Checks)
-- -------------------------------------------------------------------------
DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'categories') THEN
        CREATE INDEX IF NOT EXISTS idx_categories_user_id ON categories(user_id);
    END IF;

    IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'transactions') THEN
        CREATE INDEX IF NOT EXISTS idx_transactions_user_id ON transactions(user_id);
    END IF;

    IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'segregation') THEN
        CREATE INDEX IF NOT EXISTS idx_segregation_user_id ON segregation(user_id);
        IF EXISTS (
            SELECT 1 FROM information_schema.columns
            WHERE table_schema = 'public' AND table_name = 'segregation' AND column_name = 'type'
        ) THEN
            CREATE INDEX IF NOT EXISTS idx_segregation_user_type ON segregation(user_id, type);
        END IF;
    END IF;

    IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'finance_records') THEN
        CREATE INDEX IF NOT EXISTS idx_finance_records_user_id ON finance_records(user_id);
    END IF;

    IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'wallets') THEN
        CREATE INDEX IF NOT EXISTS idx_wallets_user_id ON wallets(user_id);
    END IF;

    IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'goal_wallets') THEN
        CREATE INDEX IF NOT EXISTS idx_goal_wallets_user_id ON goal_wallets(user_id);
    END IF;

    IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'payments') THEN
        CREATE INDEX IF NOT EXISTS idx_payments_user_id ON payments(user_id);
        IF EXISTS (
            SELECT 1 FROM information_schema.columns
            WHERE table_schema = 'public' AND table_name = 'payments' AND column_name = 'date'
        ) THEN
            CREATE INDEX IF NOT EXISTS idx_payments_user_date ON payments(user_id, date);
        END IF;
    END IF;
END $$;

-- -------------------------------------------------------------------------
-- STEP 6: Record Migration in schema_migrations
-- -------------------------------------------------------------------------
-- Note: 001_auth_tables.sql is NOT recorded as it was not fully applied.
INSERT INTO schema_migrations (filename) VALUES ('002_user_data_isolation.sql')
ON CONFLICT (filename) DO NOTHING;

COMMIT;
