-- ─────────────────────────────────────────────────────────────────────────────
-- Migration 93: Dual-Layer Support & Platform Abuse System
-- 
-- Architecture:
-- 1. store_support_tickets: Tenant-scoped customer service tickets.
-- 2. store_support_messages: Threaded ticket messages with internal note support.
-- 3. platform_abuse_reports: Platform-wide confidential abuse & fraud reports.
--
-- Security & Isolation:
-- - RLS enabled on all 3 tables.
-- - store_support_tickets / messages scoped to store members (via get_my_stores()),
--   ticket owners (auth.uid()), and super admins (is_super_admin()).
-- - Internal notes in store_support_messages strictly invisible to customers.
-- - platform_abuse_reports STRICTLY accessible only to Super Admins (is_super_admin()).
--   100% hidden from store merchants and public anon callers.
-- - All foreign keys explicitly indexed to prevent full table scans.
-- - Permissions seeded into public.permissions and role_permissions.
-- ─────────────────────────────────────────────────────────────────────────────

-- 1. Table: store_support_tickets
CREATE TABLE IF NOT EXISTS public.store_support_tickets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  store_id uuid NOT NULL REFERENCES public.stores(id) ON DELETE CASCADE,
  user_id uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  order_id uuid REFERENCES public.orders(id) ON DELETE SET NULL,
  ticket_number text NOT NULL,
  customer_name text NOT NULL,
  customer_phone text NOT NULL,
  customer_email text,
  category text NOT NULL DEFAULT 'order_issue'
    CHECK (category IN ('order_issue', 'payment', 'product_inquiry', 'shipping', 'other')),
  subject text NOT NULL,
  status text NOT NULL DEFAULT 'open'
    CHECK (status IN ('open', 'in_progress', 'resolved', 'closed')),
  priority text NOT NULL DEFAULT 'normal'
    CHECK (priority IN ('low', 'normal', 'high', 'urgent')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT uq_store_support_tickets_ticket_number UNIQUE (store_id, ticket_number)
);

-- Foreign key indexes & query acceleration for store_support_tickets
CREATE INDEX IF NOT EXISTS idx_fk_store_support_tickets_store ON public.store_support_tickets(store_id);
CREATE INDEX IF NOT EXISTS idx_fk_store_support_tickets_user ON public.store_support_tickets(user_id);
CREATE INDEX IF NOT EXISTS idx_fk_store_support_tickets_order ON public.store_support_tickets(order_id);
CREATE INDEX IF NOT EXISTS idx_store_support_tickets_store_status_created ON public.store_support_tickets(store_id, status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_store_support_tickets_user_created ON public.store_support_tickets(user_id, created_at DESC);

-- 2. Table: store_support_messages
CREATE TABLE IF NOT EXISTS public.store_support_messages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  ticket_id uuid NOT NULL REFERENCES public.store_support_tickets(id) ON DELETE CASCADE,
  sender_type text NOT NULL
    CHECK (sender_type IN ('customer', 'merchant', 'system', 'agent')),
  sender_id uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  message text NOT NULL,
  attachments jsonb NOT NULL DEFAULT '[]'::jsonb,
  is_internal_note boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- Foreign key indexes & query acceleration for store_support_messages
CREATE INDEX IF NOT EXISTS idx_fk_store_support_messages_ticket ON public.store_support_messages(ticket_id);
CREATE INDEX IF NOT EXISTS idx_fk_store_support_messages_sender ON public.store_support_messages(sender_id);
CREATE INDEX IF NOT EXISTS idx_store_support_messages_ticket_created ON public.store_support_messages(ticket_id, created_at ASC);

-- 3. Table: platform_abuse_reports
CREATE TABLE IF NOT EXISTS public.platform_abuse_reports (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  store_id uuid NOT NULL REFERENCES public.stores(id) ON DELETE CASCADE,
  reporter_user_id uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  reporter_name text NOT NULL,
  reporter_phone text NOT NULL,
  reporter_email text,
  order_id uuid REFERENCES public.orders(id) ON DELETE SET NULL,
  reason_category text NOT NULL
    CHECK (reason_category IN ('fraud', 'counterfeit', 'scam', 'abusive_behavior', 'policy_violation', 'other')),
  description text NOT NULL,
  evidence_urls jsonb NOT NULL DEFAULT '[]'::jsonb,
  status text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'investigating', 'action_taken', 'dismissed', 'resolved')),
  admin_action text
    CHECK (admin_action IS NULL OR admin_action IN ('none', 'warning_issued', 'store_suspended', 'store_frozen', 'dismissed', 'resolved')),
  admin_notes text,
  resolved_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  resolved_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- Foreign key indexes & query acceleration for platform_abuse_reports
CREATE INDEX IF NOT EXISTS idx_fk_platform_abuse_reports_store ON public.platform_abuse_reports(store_id);
CREATE INDEX IF NOT EXISTS idx_fk_platform_abuse_reports_reporter ON public.platform_abuse_reports(reporter_user_id);
CREATE INDEX IF NOT EXISTS idx_fk_platform_abuse_reports_order ON public.platform_abuse_reports(order_id);
CREATE INDEX IF NOT EXISTS idx_fk_platform_abuse_reports_resolver ON public.platform_abuse_reports(resolved_by);
CREATE INDEX IF NOT EXISTS idx_platform_abuse_reports_status_created ON public.platform_abuse_reports(status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_platform_abuse_reports_store_created ON public.platform_abuse_reports(store_id, created_at DESC);

-- Automatic updated_at triggers
DROP TRIGGER IF EXISTS trg_store_support_tickets_updated_at ON public.store_support_tickets;
CREATE TRIGGER trg_store_support_tickets_updated_at
  BEFORE UPDATE ON public.store_support_tickets
  FOR EACH ROW
  EXECUTE FUNCTION public.update_updated_at_column();

DROP TRIGGER IF EXISTS trg_platform_abuse_reports_updated_at ON public.platform_abuse_reports;
CREATE TRIGGER trg_platform_abuse_reports_updated_at
  BEFORE UPDATE ON public.platform_abuse_reports
  FOR EACH ROW
  EXECUTE FUNCTION public.update_updated_at_column();

-- Enable Row Level Security (RLS)
ALTER TABLE public.store_support_tickets ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.store_support_messages ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.platform_abuse_reports ENABLE ROW LEVEL SECURITY;

-- 4. RLS Policies: store_support_tickets
DROP POLICY IF EXISTS store_support_tickets_authenticated_access ON public.store_support_tickets;
CREATE POLICY store_support_tickets_authenticated_access
  ON public.store_support_tickets FOR ALL TO authenticated
  USING (
    store_id IN (SELECT public.get_my_stores())
    OR user_id = (SELECT auth.uid())
    OR public.is_super_admin()
  )
  WITH CHECK (
    store_id IN (SELECT public.get_my_stores())
    OR user_id = (SELECT auth.uid())
    OR public.is_super_admin()
  );

DROP POLICY IF EXISTS store_support_tickets_deny_anon ON public.store_support_tickets;
CREATE POLICY store_support_tickets_deny_anon
  ON public.store_support_tickets FOR ALL TO anon
  USING (false)
  WITH CHECK (false);

-- 5. RLS Policies: store_support_messages
DROP POLICY IF EXISTS store_support_messages_authenticated_access ON public.store_support_messages;
CREATE POLICY store_support_messages_authenticated_access
  ON public.store_support_messages FOR ALL TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.store_support_tickets t
      WHERE t.id = store_support_messages.ticket_id
        AND (
          t.store_id IN (SELECT public.get_my_stores())
          OR (t.user_id = (SELECT auth.uid()) AND store_support_messages.is_internal_note = false)
          OR public.is_super_admin()
        )
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM public.store_support_tickets t
      WHERE t.id = store_support_messages.ticket_id
        AND (
          t.store_id IN (SELECT public.get_my_stores())
          OR (t.user_id = (SELECT auth.uid()) AND store_support_messages.is_internal_note = false)
          OR public.is_super_admin()
        )
    )
  );

DROP POLICY IF EXISTS store_support_messages_deny_anon ON public.store_support_messages;
CREATE POLICY store_support_messages_deny_anon
  ON public.store_support_messages FOR ALL TO anon
  USING (false)
  WITH CHECK (false);

-- 6. RLS Policies: platform_abuse_reports (Strictly Super Admin only; 100% hidden from merchants)
DROP POLICY IF EXISTS platform_abuse_reports_super_admin_only ON public.platform_abuse_reports;
CREATE POLICY platform_abuse_reports_super_admin_only
  ON public.platform_abuse_reports FOR ALL TO authenticated
  USING (public.is_super_admin())
  WITH CHECK (public.is_super_admin());

DROP POLICY IF EXISTS platform_abuse_reports_deny_anon ON public.platform_abuse_reports;
CREATE POLICY platform_abuse_reports_deny_anon
  ON public.platform_abuse_reports FOR ALL TO anon
  USING (false)
  WITH CHECK (false);

-- 7. Seed Permissions
INSERT INTO public.permissions (name, code, description, priority)
VALUES 
  ('support.view', 'support.view', 'عرض تذاكر الدعم الفني للمتجر', 50),
  ('support.manage', 'support.manage', 'إدارة والرد على تذاكر الدعم الفني وتحديث حالتها', 50),
  ('platform.reports.view', 'platform.reports.view', 'عرض تقارير الإبلاغ عن مخالفات المتاجر', 50),
  ('platform.reports.manage', 'platform.reports.manage', 'إدارة ومعالجة بلاغات مخالفات المتاجر واتخاذ الإجراءات التأديبية', 50),
  ('platform.stores.manage', 'platform.stores.manage', 'إدارة المتاجر على مستوى المنصة', 50),
  ('platform.stores.view', 'platform.stores.view', 'عرض المتاجر على مستوى المنصة', 50)
ON CONFLICT (name) DO UPDATE SET 
  description = EXCLUDED.description,
  code = EXCLUDED.code,
  priority = EXCLUDED.priority;

-- Grant support permissions to store admin and support roles
INSERT INTO public.role_permissions (role_id, permission_id)
SELECT r.id, p.id
FROM public.roles r
CROSS JOIN public.permissions p
WHERE r.name IN ('owner', 'admin', 'customer_support', 'support', 'manager')
  AND p.name IN ('support.view', 'support.manage')
ON CONFLICT (role_id, permission_id) DO NOTHING;

-- Grant platform permissions to platform super_admin role
INSERT INTO public.role_permissions (role_id, permission_id)
SELECT r.id, p.id
FROM public.roles r
CROSS JOIN public.permissions p
WHERE r.role_type = 'platform' AND r.name = 'super_admin'
  AND p.name IN ('platform.reports.view', 'platform.reports.manage', 'platform.stores.manage', 'platform.stores.view')
ON CONFLICT (role_id, permission_id) DO NOTHING;
