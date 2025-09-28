-- Add idempotency support to messages table
-- This migration adds provider and provider_id fields and creates a unique index

-- Add new columns to messages table if they don't exist
DO $$
BEGIN
  -- Add provider column if it doesn't exist
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns 
    WHERE table_name = 'messages' AND column_name = 'provider'
  ) THEN
    ALTER TABLE messages ADD COLUMN provider text;
  END IF;
  
  -- Add provider_id column if it doesn't exist  
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns 
    WHERE table_name = 'messages' AND column_name = 'provider_id'
  ) THEN
    ALTER TABLE messages ADD COLUMN provider_id text;
  END IF;
  
  -- Add meta column if it doesn't exist (for storing original payloads)
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns 
    WHERE table_name = 'messages' AND column_name = 'meta'
  ) THEN
    ALTER TABLE messages ADD COLUMN meta jsonb DEFAULT '{}'::jsonb;
  END IF;
END $$;

-- Update existing records to have default values
UPDATE messages 
SET provider = 'legacy', 
    provider_id = COALESCE(provider_id, 'legacy-' || id::text),
    meta = COALESCE(meta, '{}'::jsonb)
WHERE provider IS NULL OR provider_id IS NULL;

-- Make provider and provider_id NOT NULL
ALTER TABLE messages ALTER COLUMN provider SET NOT NULL;
ALTER TABLE messages ALTER COLUMN provider_id SET NOT NULL;

-- Create unique index for idempotency (provider, provider_id)
-- This ensures no duplicate messages from the same provider
CREATE UNIQUE INDEX IF NOT EXISTS idx_messages_provider_idempotency 
ON messages (provider, provider_id);

-- Add index for efficient lookups by provider
CREATE INDEX IF NOT EXISTS idx_messages_provider 
ON messages (provider);

-- Add index for efficient lookups by provider_id
CREATE INDEX IF NOT EXISTS idx_messages_provider_id 
ON messages (provider_id);
