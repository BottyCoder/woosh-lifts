-- Ensure contacts.primary_msisdn is unique on existing databases (idempotent)
DO $$
BEGIN
  -- Drop the old non-unique index if it exists (not needed once a UNIQUE constraint exists)
  IF EXISTS (
    SELECT 1 FROM pg_indexes
    WHERE schemaname = 'public' AND indexname = 'idx_contacts_msisdn'
  ) THEN
    EXECUTE 'DROP INDEX IF EXISTS idx_contacts_msisdn';
  END IF;

  -- Add the UNIQUE constraint only if it's not already there
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE c.conname = 'uq_contacts_primary_msisdn'
      AND t.relname = 'contacts'
      AND n.nspname = 'public'
  ) THEN
    ALTER TABLE public.contacts
      ADD CONSTRAINT uq_contacts_primary_msisdn UNIQUE (primary_msisdn);
  END IF;
END $$;
