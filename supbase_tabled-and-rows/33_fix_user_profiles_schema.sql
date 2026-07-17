-- ============================================================
-- SQL Migration: Fix user_profiles multi-tenant constraints
-- Run this in your Supabase SQL Editor
-- ============================================================

BEGIN;

-- 1. Drop global unique constraints on phone
ALTER TABLE public.user_profiles DROP CONSTRAINT IF EXISTS user_profiles_phone_key;
ALTER TABLE public.user_profiles DROP CONSTRAINT IF EXISTS user_profiles_phone_key1;
ALTER TABLE public.user_profiles DROP CONSTRAINT IF EXISTS user_profiles_phone_unique;

-- 2. Drop the old primary key (which was just user_id in single-tenant)
ALTER TABLE public.user_profiles DROP CONSTRAINT IF EXISTS user_profiles_pkey CASCADE;

-- 3. Add 'id' column if it doesn't exist
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns 
        WHERE table_schema = 'public' AND table_name = 'user_profiles' AND column_name = 'id'
    ) THEN
        ALTER TABLE public.user_profiles ADD COLUMN id uuid DEFAULT gen_random_uuid();
    END IF;
END $$;

-- 4. Set 'id' as the new primary key
-- We use a DO block to avoid errors if it's already the primary key
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint 
        WHERE conname = 'user_profiles_pkey' AND conrelid = 'public.user_profiles'::regclass
    ) THEN
        ALTER TABLE public.user_profiles ADD CONSTRAINT user_profiles_pkey PRIMARY KEY (id);
    END IF;
END $$;

-- 5. Ensure tenant-level uniqueness for phone numbers
ALTER TABLE public.user_profiles DROP CONSTRAINT IF EXISTS user_profiles_store_id_phone_key;
ALTER TABLE public.user_profiles ADD CONSTRAINT user_profiles_store_id_phone_key UNIQUE (store_id, phone);

-- 6. Ensure a user only has one profile per store
ALTER TABLE public.user_profiles DROP CONSTRAINT IF EXISTS user_profiles_user_id_store_id_key;
ALTER TABLE public.user_profiles ADD CONSTRAINT user_profiles_user_id_store_id_key UNIQUE (user_id, store_id);

COMMIT;
