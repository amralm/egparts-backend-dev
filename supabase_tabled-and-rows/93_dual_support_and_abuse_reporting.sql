-- ==============================================================================
-- 93_dual_support_and_abuse_reporting.sql
-- EG-Parts Cloud Multi-Tenant SaaS: Store Support Tickets & Platform Abuse Reports
-- ==============================================================================

-- 1. Store Support Tickets (Tenant-Scoped Customer Support)
CREATE TABLE IF NOT EXISTS public.store_support_tickets (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  store_id uuid NOT NULL REFERENCES public.stores(id) ON DELETE CASCADE,
  user_id uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  order_id uuid REFERENCES public.orders(id) ON DELETE SET NULL,
  ticket_number text NOT NULL,
  customer_name text NOT NULL,
  customer_phone text NOT NULL,
  customer_email text,
  category text NOT NULL DEFAULT 'general',
  subject text NOT NULL,
  status text NOT NULL DEFAULT 'open',
  priority text NOT NULL DEFAULT 'medium',
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);

-- Unique ticket number per store
CREATE UNIQUE INDEX IF NOT EXISTS idx_support_tickets_num ON public.store_support_tickets(store_id, ticket_number);
CREATE INDEX IF NOT EXISTS idx_support_tickets_store_status ON public.store_support_tickets(store_id, status);
CREATE INDEX IF NOT EXISTS idx_support_tickets_user ON public.store_support_tickets(user_id);
CREATE INDEX IF NOT EXISTS idx_support_tickets_order ON public.store_support_tickets(order_id);

-- 2. Store Support Messages (Ticket Message Thread)
CREATE TABLE IF NOT EXISTS public.store_support_messages (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  ticket_id uuid NOT NULL REFERENCES public.store_support_tickets(id) ON DELETE CASCADE,
  sender_type text NOT NULL CHECK (sender_type IN ('customer', 'merchant', 'system')),
  sender_id uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  message text NOT NULL,
  attachments jsonb DEFAULT '[]'::jsonb,
  is_internal_note boolean DEFAULT false,
  created_at timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_support_messages_ticket ON public.store_support_messages(ticket_id, created_at ASC);

-- 3. Platform Abuse Reports (Confidential Super Admin Trust & Safety)
CREATE TABLE IF NOT EXISTS public.platform_abuse_reports (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  store_id uuid NOT NULL REFERENCES public.stores(id) ON DELETE CASCADE,
  reporter_user_id uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  reporter_name text NOT NULL,
  reporter_phone text NOT NULL,
  reporter_email text,
  order_id uuid REFERENCES public.orders(id) ON DELETE SET NULL,
  reason_category text NOT NULL DEFAULT 'other',
  description text NOT NULL,
  evidence_urls jsonb DEFAULT '[]'::jsonb,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'investigating', 'action_taken', 'dismissed')),
  admin_action text,
  admin_notes text,
  resolved_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  resolved_at timestamptz,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_platform_reports_store ON public.platform_abuse_reports(store_id, status);
CREATE INDEX IF NOT EXISTS idx_platform_reports_status ON public.platform_abuse_reports(status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_platform_reports_reporter ON public.platform_abuse_reports(reporter_user_id);

-- 4. Enable RLS
ALTER TABLE public.store_support_tickets ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.store_support_messages ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.platform_abuse_reports ENABLE ROW LEVEL SECURITY;

-- Grants to service_role and authenticated
GRANT ALL ON TABLE public.store_support_tickets TO service_role;
GRANT ALL ON TABLE public.store_support_messages TO service_role;
GRANT ALL ON TABLE public.platform_abuse_reports TO service_role;

GRANT SELECT, INSERT ON TABLE public.store_support_tickets TO authenticated, anon;
GRANT SELECT, INSERT ON TABLE public.store_support_messages TO authenticated, anon;
GRANT INSERT ON TABLE public.platform_abuse_reports TO authenticated, anon;
