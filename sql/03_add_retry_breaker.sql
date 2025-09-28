-- Add retry and breaker support to messages table
-- This migration adds status tracking, attempt counting, and error handling

-- Add new columns to messages table if they don't exist
DO $$
BEGIN
  -- Add status column if it doesn't exist
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns 
    WHERE table_name = 'messages' AND column_name = 'status'
  ) THEN
    ALTER TABLE messages ADD COLUMN status text DEFAULT 'queued';
  END IF;
  
  -- Add attempt_count column if it doesn't exist
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns 
    WHERE table_name = 'messages' AND column_name = 'attempt_count'
  ) THEN
    ALTER TABLE messages ADD COLUMN attempt_count integer DEFAULT 0;
  END IF;
  
  -- Add last_error column if it doesn't exist
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns 
    WHERE table_name = 'messages' AND column_name = 'last_error'
  ) THEN
    ALTER TABLE messages ADD COLUMN last_error text;
  END IF;
  
  -- Add last_error_at column if it doesn't exist
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns 
    WHERE table_name = 'messages' AND column_name = 'last_error_at'
  ) THEN
    ALTER TABLE messages ADD COLUMN last_error_at timestamptz;
  END IF;
  
  -- Add next_attempt_at column if it doesn't exist
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns 
    WHERE table_name = 'messages' AND column_name = 'next_attempt_at'
  ) THEN
    ALTER TABLE messages ADD COLUMN next_attempt_at timestamptz;
  END IF;
  
  -- Add template_name column if it doesn't exist
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns 
    WHERE table_name = 'messages' AND column_name = 'template_name'
  ) THEN
    ALTER TABLE messages ADD COLUMN template_name text;
  END IF;
  
  -- Add template_language column if it doesn't exist
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns 
    WHERE table_name = 'messages' AND column_name = 'template_language'
  ) THEN
    ALTER TABLE messages ADD COLUMN template_language text;
  END IF;
  
  -- Add template_components column if it doesn't exist
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns 
    WHERE table_name = 'messages' AND column_name = 'template_components'
  ) THEN
    ALTER TABLE messages ADD COLUMN template_components jsonb;
  END IF;
END $$;

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

-- Update status column to use enum
ALTER TABLE messages ALTER COLUMN status TYPE message_status_t USING status::message_status_t;

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
