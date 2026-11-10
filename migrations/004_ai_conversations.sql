-- =========================================================================
-- STS FINTECH PRIVATE LIMITED
-- Migration 004: AI Financial Chatbot Conversations & Message Persistence
-- Target Database: PostgreSQL 14+ (Local sts_fintech & Production)
-- =========================================================================

BEGIN;

-- -------------------------------------------------------------------------
-- STEP 1: Verify schema_migrations table exists and record migration
-- -------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS schema_migrations (
    id SERIAL PRIMARY KEY,
    filename VARCHAR(255) UNIQUE NOT NULL,
    applied_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
);

-- -------------------------------------------------------------------------
-- STEP 2: Create ai_conversations Table
-- Multi-turn conversational threads isolated by authenticated user_id
-- -------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS ai_conversations (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    title VARCHAR(255) DEFAULT 'Financial Advisory Session',
    language VARCHAR(10) DEFAULT 'en-IN',
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_ai_conversations_user_id
    ON ai_conversations(user_id);

CREATE INDEX IF NOT EXISTS idx_ai_conversations_updated_at
    ON ai_conversations(updated_at DESC);

-- -------------------------------------------------------------------------
-- STEP 3: Create ai_chat_messages Table
-- Stores user prompts, assistant answers, and financial tool call metadata
-- -------------------------------------------------------------------------
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

CREATE INDEX IF NOT EXISTS idx_ai_chat_messages_conv_created
    ON ai_chat_messages(conversation_id, created_at ASC);

CREATE INDEX IF NOT EXISTS idx_ai_chat_messages_user_id
    ON ai_chat_messages(user_id);

-- -------------------------------------------------------------------------
-- STEP 4: Record Migration
-- -------------------------------------------------------------------------
INSERT INTO schema_migrations (filename)
VALUES ('004_ai_conversations.sql')
ON CONFLICT (filename) DO NOTHING;

COMMIT;
