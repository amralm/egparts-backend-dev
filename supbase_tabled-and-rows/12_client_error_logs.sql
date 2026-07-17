-- Create client_error_logs table to collect frontend exceptions from localhost and production
CREATE TABLE IF NOT EXISTS public.client_error_logs (
    id BIGSERIAL PRIMARY KEY,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT timezone('utc'::text, now()) NOT NULL,
    message TEXT,
    stack TEXT,
    url TEXT,
    store_name TEXT,
    user_agent TEXT
);

-- Enable Row Level Security (RLS)
ALTER TABLE public.client_error_logs ENABLE ROW LEVEL SECURITY;

-- Drop existing policies if they exist
DROP POLICY IF EXISTS "service_role_all" ON public.client_error_logs;

-- Allow service_role to have full control, restrict public read/write access for privacy
CREATE POLICY "service_role_all" ON public.client_error_logs FOR ALL TO service_role USING (true);
