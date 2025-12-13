-- Migration: Alter ib_client_linking table to use TEXT for user_id (to support UUIDs)
-- This allows the table to work with User table which uses UUID (TEXT) for user IDs

-- Alter user_id column in ib_client_linking table
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'ib_client_linking' AND column_name = 'user_id' AND data_type = 'integer'
  ) THEN
    ALTER TABLE ib_client_linking ALTER COLUMN user_id TYPE TEXT USING user_id::text;
    RAISE NOTICE 'Altered ib_client_linking.user_id from INTEGER to TEXT';
  ELSE
    RAISE NOTICE 'ib_client_linking.user_id is already TEXT or column does not exist';
  END IF;
END $$;

-- Alter user_id column in ib_client_linking_history table
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'ib_client_linking_history' AND column_name = 'user_id' AND data_type = 'integer'
  ) THEN
    ALTER TABLE ib_client_linking_history ALTER COLUMN user_id TYPE TEXT USING user_id::text;
    RAISE NOTICE 'Altered ib_client_linking_history.user_id from INTEGER to TEXT';
  ELSE
    RAISE NOTICE 'ib_client_linking_history.user_id is already TEXT or column does not exist';
  END IF;
END $$;


