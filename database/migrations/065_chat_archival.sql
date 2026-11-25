-- Migration: 065_chat_archival
-- Description: Creates tables for agent chat sessions and messages to support
--              archival of idle sessions (>30 days) to cold storage.
--              This enables reducing hot database storage footprint by >90%.

-- Chat sessions table: tracks agent chat conversations
CREATE TABLE IF NOT EXISTS chat_sessions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id VARCHAR(255) NOT NULL UNIQUE,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  agent_id VARCHAR(255) NOT NULL,
  delegation_id VARCHAR(255),
  title TEXT,
  message_count INTEGER NOT NULL DEFAULT 0,
  total_tokens INTEGER NOT NULL DEFAULT 0,
  last_message_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  archived_at TIMESTAMPTZ,
  archived_to_s3_key TEXT,
  summary_text TEXT
);

-- Index for finding idle sessions for archival
CREATE INDEX IF NOT EXISTS idx_chat_sessions_last_message_at
  ON chat_sessions (last_message_at)
  WHERE archived_at IS NULL;

-- Index for user lookups
CREATE INDEX IF NOT EXISTS idx_chat_sessions_user_id
  ON chat_sessions (user_id, created_at DESC);

-- Index for agent lookups
CREATE INDEX IF NOT EXISTS idx_chat_sessions_agent_id
  ON chat_sessions (agent_id, created_at DESC);

-- Chat messages table: stores individual messages in a session
CREATE TABLE IF NOT EXISTS chat_messages (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id VARCHAR(255) NOT NULL REFERENCES chat_sessions(session_id) ON DELETE CASCADE,
  role VARCHAR(50) NOT NULL CHECK (role IN ('system', 'user', 'assistant', 'tool')),
  content TEXT NOT NULL,
  tool_call_id VARCHAR(255),
  name VARCHAR(255),
  token_count INTEGER,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Index for session message retrieval
CREATE INDEX IF NOT EXISTS idx_chat_messages_session_id
  ON chat_messages (session_id, created_at ASC);

-- Index for archival queries (messages older than X days)
CREATE INDEX IF NOT EXISTS idx_chat_messages_created_at
  ON chat_messages (created_at)
  WHERE session_id IN (SELECT session_id FROM chat_sessions WHERE archived_at IS NULL);

-- Archive summary table: stores summaries of archived sessions
CREATE TABLE IF NOT EXISTS chat_archival_summaries (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id VARCHAR(255) NOT NULL UNIQUE REFERENCES chat_sessions(session_id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  message_count INTEGER NOT NULL,
  summary_text TEXT NOT NULL,
  archived_to_s3_key TEXT NOT NULL,
  archived_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Index for summary lookups
CREATE INDEX IF NOT EXISTS idx_chat_archival_summaries_session_id
  ON chat_archival_summaries (session_id);

-- Index for user summary lookups
CREATE INDEX IF NOT EXISTS idx_chat_archival_summaries_user_id
  ON chat_archival_summaries (user_id, archived_at DESC);

COMMENT ON TABLE chat_sessions IS
  'Agent chat sessions with metadata for archival tracking';

COMMENT ON TABLE chat_messages IS
  'Individual messages in chat sessions, archived to S3 when session is idle >30 days';

COMMENT ON TABLE chat_archival_summaries IS
  'Summaries of archived chat sessions for quick retrieval without accessing cold storage';

-- ── Down migration ─────────────────────────────────────────────────────────────
-- DROP TABLE IF EXISTS chat_archival_summaries;
-- DROP TABLE IF EXISTS chat_messages;
-- DROP TABLE IF EXISTS chat_sessions;
