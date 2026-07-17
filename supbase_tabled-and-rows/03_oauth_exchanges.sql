-- SQL Migration: Add OAuth Exchanges table for secure session exchange (Auth v2)
-- Run in Supabase SQL Editor to enable secure PKCE session exchange

CREATE TABLE IF NOT EXISTS public.oauth_exchanges (
    token TEXT PRIMARY KEY,
    encrypted_session TEXT NOT NULL,
    iv TEXT NOT NULL,
    auth_tag TEXT NOT NULL,
    ip_address TEXT NOT NULL,
    user_agent TEXT NOT NULL,
    expires_at TIMESTAMPTZ NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_oauth_exchanges_token ON public.oauth_exchanges(token);

-- Enable Row Level Security (RLS) with no policies (restricts all public client access)
ALTER TABLE public.oauth_exchanges ENABLE ROW LEVEL SECURITY;

-- Cleanup function for expired exchanges
CREATE OR REPLACE FUNCTION public.cleanup_expired_oauth_exchanges()
RETURNS void AS $$
BEGIN
  DELETE FROM public.oauth_exchanges WHERE expires_at < now();
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;
