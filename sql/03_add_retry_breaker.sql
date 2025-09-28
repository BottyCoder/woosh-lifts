-- Add retry and breaker support to messages table
-- This migration adds status tracking, attempt counting, and error handling

-- Add retry/breaker columns to messages table (idempotent)
ALTER TABLE messages
  ADD COLUMN IF NOT EXISTS status text NOT NULL DEFAULT 'queued',
  ADD COLUMN IF NOT EXISTS attempt_count integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS next_attempt_at timestamptz NOT NULL DEFAULT NOW(),
  ADD COLUMN IF NOT EXISTS last_error text,
  ADD COLUMN IF NOT EXISTS last_error_at timestamptz,
  ADD COLUMN IF NOT EXISTS template_name text,
  ADD COLUMN IF NOT EXISTS template_language text,
  ADD COLUMN IF NOT EXISTS template_components jsonb;

-- Create status enum if it doesn't exist
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'message_status_t') THEN
    CREATE TYPE message_status_t AS ENUM (
      'queued',
      'sending', 
      'sent',
      'permanently_failed'
    );
  END IF;
END $$;

-- Update status column to use enum (only if not already converted)
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns 
    WHERE table_name = 'messages' AND column_name = 'status' AND data_type = 'text'
  ) THEN
    ALTER TABLE messages ALTER COLUMN status TYPE message_status_t USING status::message_status_t;
  END IF;
END $$;

-- Create wa_attempts table for tracking individual attempts
CREATE TABLE IF NOT EXISTS wa_attempts (
  id uuid primary key default uuid_generate_v4(),
  message_id uuid not null references messages(id) on delete cascade,
  attempt_number integer not null,
  http_code integer not null,
  status text not null check (status in ('success', 'retry', 'fail', 'breaker_open')),
  latency_ms integer not null,
  error_kind text,
  response_excerpt text,
  created_at timestamptz not null default now()
);

-- Create breaker_state table for circuit breaker
CREATE TABLE IF NOT EXISTS breaker_state (
  service text primary key,
  state text not null check (state in ('closed', 'open', 'half_open')),
  failure_count integer not null default 0,
  success_count integer not null default 0,
  opened_at timestamptz,
  updated_at timestamptz not null default now()
);

-- Create indexes for performance
CREATE INDEX IF NOT EXISTS idx_messages_status ON messages(status);
CREATE INDEX IF NOT EXISTS idx_messages_next_attempt ON messages(next_attempt_at) WHERE status = 'queued';
CREATE INDEX IF NOT EXISTS idx_messages_attempt_count ON messages(attempt_count);
CREATE INDEX IF NOT EXISTS idx_messages_status_next_attempt ON messages (status, next_attempt_at);
CREATE INDEX IF NOT EXISTS idx_wa_attempts_message_id ON wa_attempts(message_id);
CREATE INDEX IF NOT EXISTS idx_wa_attempts_created_at ON wa_attempts(created_at);
CREATE INDEX IF NOT EXISTS idx_wa_attempts_status ON wa_attempts(status);

-- Update existing messages to have default status
UPDATE messages 
SET status = 'sent' 
WHERE status IS NULL AND direction = 'out';

UPDATE messages 
SET status = 'queued' 
WHERE status IS NULL AND direction = 'in';
