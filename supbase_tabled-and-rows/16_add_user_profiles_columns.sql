-- Add missing columns to user_profiles table that are required by the frontend syncUserProfile and the handle_new_user trigger.
-- Added: is_email_verified (boolean) and role (text).

ALTER TABLE public.user_profiles 
  ADD COLUMN IF NOT EXISTS is_email_verified boolean DEFAULT false,
  ADD COLUMN IF NOT EXISTS role text DEFAULT 'user';
