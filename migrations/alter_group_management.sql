-- Migration: Add columns to group_management table based on API structure
-- Run this SQL script to add all required columns

DO $$
BEGIN
    -- Server column
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns 
                   WHERE table_name = 'group_management' AND column_name = 'server') THEN
        ALTER TABLE group_management ADD COLUMN server INTEGER DEFAULT 1;
    END IF;

    -- Company column
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns 
                   WHERE table_name = 'group_management' AND column_name = 'company') THEN
        ALTER TABLE group_management ADD COLUMN company VARCHAR(255);
    END IF;

    -- Currency column
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns 
                   WHERE table_name = 'group_management' AND column_name = 'currency') THEN
        ALTER TABLE group_management ADD COLUMN currency INTEGER DEFAULT 0;
    END IF;

    -- Currency Digits column
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns 
                   WHERE table_name = 'group_management' AND column_name = 'currency_digits') THEN
        ALTER TABLE group_management ADD COLUMN currency_digits INTEGER DEFAULT 2;
    END IF;

    -- Margin Call column (percentage)
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns 
                   WHERE table_name = 'group_management' AND column_name = 'margin_call') THEN
        ALTER TABLE group_management ADD COLUMN margin_call DECIMAL(5,2) DEFAULT 100.00;
    END IF;

    -- Stop Out column (percentage)
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns 
                   WHERE table_name = 'group_management' AND column_name = 'stop_out') THEN
        ALTER TABLE group_management ADD COLUMN stop_out DECIMAL(5,2) DEFAULT 50.00;
    END IF;

    -- Trade Flags column
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns 
                   WHERE table_name = 'group_management' AND column_name = 'trade_flags') THEN
        ALTER TABLE group_management ADD COLUMN trade_flags INTEGER DEFAULT 16;
    END IF;

    -- Auth Mode column
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns 
                   WHERE table_name = 'group_management' AND column_name = 'auth_mode') THEN
        ALTER TABLE group_management ADD COLUMN auth_mode INTEGER DEFAULT 0;
    END IF;

    -- Min Password Chars column
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns 
                   WHERE table_name = 'group_management' AND column_name = 'min_password_chars') THEN
        ALTER TABLE group_management ADD COLUMN min_password_chars INTEGER DEFAULT 8;
    END IF;

    -- Website column
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns 
                   WHERE table_name = 'group_management' AND column_name = 'website') THEN
        ALTER TABLE group_management ADD COLUMN website VARCHAR(255);
    END IF;

    -- Email column
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns 
                   WHERE table_name = 'group_management' AND column_name = 'email') THEN
        ALTER TABLE group_management ADD COLUMN email VARCHAR(255);
    END IF;

    -- Support Page column
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns 
                   WHERE table_name = 'group_management' AND column_name = 'support_page') THEN
        ALTER TABLE group_management ADD COLUMN support_page VARCHAR(255);
    END IF;

    -- Support Email column
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns 
                   WHERE table_name = 'group_management' AND column_name = 'support_email') THEN
        ALTER TABLE group_management ADD COLUMN support_email VARCHAR(255);
    END IF;

    -- Reports Mode column
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns 
                   WHERE table_name = 'group_management' AND column_name = 'reports_mode') THEN
        ALTER TABLE group_management ADD COLUMN reports_mode INTEGER DEFAULT 1;
    END IF;

    -- Margin Mode column
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns 
                   WHERE table_name = 'group_management' AND column_name = 'margin_mode') THEN
        ALTER TABLE group_management ADD COLUMN margin_mode INTEGER DEFAULT 2;
    END IF;

    -- Demo Leverage column
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns 
                   WHERE table_name = 'group_management' AND column_name = 'demo_leverage') THEN
        ALTER TABLE group_management ADD COLUMN demo_leverage INTEGER DEFAULT 0;
    END IF;

    -- News Mode column
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns 
                   WHERE table_name = 'group_management' AND column_name = 'news_mode') THEN
        ALTER TABLE group_management ADD COLUMN news_mode INTEGER DEFAULT 2;
    END IF;

    -- Margin Free Mode column
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns 
                   WHERE table_name = 'group_management' AND column_name = 'margin_free_mode') THEN
        ALTER TABLE group_management ADD COLUMN margin_free_mode INTEGER DEFAULT 1;
    END IF;

    -- Demo Deposit column
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns 
                   WHERE table_name = 'group_management' AND column_name = 'demo_deposit') THEN
        ALTER TABLE group_management ADD COLUMN demo_deposit DECIMAL(10,2) DEFAULT 0.00;
    END IF;

    -- Mail Mode column
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns 
                   WHERE table_name = 'group_management' AND column_name = 'mail_mode') THEN
        ALTER TABLE group_management ADD COLUMN mail_mode INTEGER DEFAULT 1;
    END IF;

    -- Margin SO Mode column
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns 
                   WHERE table_name = 'group_management' AND column_name = 'margin_so_mode') THEN
        ALTER TABLE group_management ADD COLUMN margin_so_mode INTEGER DEFAULT 0;
    END IF;

    -- Trade Transfer Mode column
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns 
                   WHERE table_name = 'group_management' AND column_name = 'trade_transfer_mode') THEN
        ALTER TABLE group_management ADD COLUMN trade_transfer_mode INTEGER DEFAULT 0;
    END IF;

    -- Group Path column
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns 
                   WHERE table_name = 'group_management' AND column_name = 'group_path') THEN
        ALTER TABLE group_management ADD COLUMN group_path VARCHAR(255);
    END IF;
END $$;


