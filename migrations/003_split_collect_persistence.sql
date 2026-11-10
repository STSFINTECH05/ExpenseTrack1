-- =========================================================================
-- STS FINTECH PRIVATE LIMITED
-- Migration 003: Split & Collect Group Persistence and Multi-User Isolation
-- Target Database: PostgreSQL (Local sts_fintech & Production)
-- =========================================================================

BEGIN;

-- -------------------------------------------------------------------------
-- STEP 1: Verify schema_migrations table exists
-- -------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS schema_migrations (
    id SERIAL PRIMARY KEY,
    filename VARCHAR(255) UNIQUE NOT NULL,
    applied_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
);

-- -------------------------------------------------------------------------
-- STEP 2: Create split_groups Table
-- -------------------------------------------------------------------------
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

CREATE INDEX IF NOT EXISTS idx_split_groups_owner_id
    ON split_groups(owner_id);

-- -------------------------------------------------------------------------
-- STEP 3: Create split_group_members Table
-- Supports registered members (user_id is set) and guest participants
-- (user_id is NULL) without granting guests unauthenticated access.
-- -------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS split_group_members (
    id SERIAL PRIMARY KEY,
    group_id INTEGER NOT NULL REFERENCES split_groups(id) ON DELETE CASCADE,
    user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
    name VARCHAR(150) NOT NULL,
    email VARCHAR(255),
    role VARCHAR(50) NOT NULL DEFAULT 'member', -- 'owner', 'member'
    status VARCHAR(50) NOT NULL DEFAULT 'accepted', -- 'accepted', 'pending'
    is_self BOOLEAN NOT NULL DEFAULT FALSE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT chk_split_group_members_role CHECK (role IN ('owner', 'member', 'admin')),
    CONSTRAINT chk_split_group_members_status CHECK (status IN ('accepted', 'pending', 'declined'))
);

CREATE INDEX IF NOT EXISTS idx_split_group_members_group_id
    ON split_group_members(group_id);

CREATE INDEX IF NOT EXISTS idx_split_group_members_user_id
    ON split_group_members(user_id);

CREATE INDEX IF NOT EXISTS idx_split_group_members_email
    ON split_group_members(LOWER(email));

-- -------------------------------------------------------------------------
-- STEP 4: Create split_expenses Table
-- -------------------------------------------------------------------------
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

CREATE INDEX IF NOT EXISTS idx_split_expenses_group_id
    ON split_expenses(group_id);

CREATE INDEX IF NOT EXISTS idx_split_expenses_created_by
    ON split_expenses(created_by_user_id);

-- -------------------------------------------------------------------------
-- STEP 5: Create split_expense_shares Table
-- Tracks individual member shares for each split expense
-- -------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS split_expense_shares (
    id SERIAL PRIMARY KEY,
    expense_id INTEGER NOT NULL REFERENCES split_expenses(id) ON DELETE CASCADE,
    member_id INTEGER NOT NULL REFERENCES split_group_members(id) ON DELETE CASCADE,
    share_amount NUMERIC(12, 2) NOT NULL DEFAULT 0.00,
    is_paid BOOLEAN NOT NULL DEFAULT FALSE
);

CREATE INDEX IF NOT EXISTS idx_split_expense_shares_expense_id
    ON split_expense_shares(expense_id);

CREATE INDEX IF NOT EXISTS idx_split_expense_shares_member_id
    ON split_expense_shares(member_id);

-- -------------------------------------------------------------------------
-- STEP 6: Create split_settlements Table
-- Tracks debt repayments, settlements, and collections between members
-- -------------------------------------------------------------------------
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

CREATE INDEX IF NOT EXISTS idx_split_settlements_group_id
    ON split_settlements(group_id);

CREATE INDEX IF NOT EXISTS idx_split_settlements_debt_key
    ON split_settlements(debt_key);

-- -------------------------------------------------------------------------
-- STEP 7: Record Migration in schema_migrations
-- -------------------------------------------------------------------------
INSERT INTO schema_migrations (filename)
VALUES ('003_split_collect_persistence.sql')
ON CONFLICT (filename) DO NOTHING;

COMMIT;
