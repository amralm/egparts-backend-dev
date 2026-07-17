-- ============================================================
-- SQL Migration: EGParts Copilot & Multi-Niche AI Engine Schema
-- Run in Supabase SQL Editor to support dynamic tenant niches,
-- action queues, metrics tracking, and automotive compatibility.
-- ============================================================

-- 1. Add business_type to stores
ALTER TABLE public.stores ADD COLUMN IF NOT EXISTS business_type text DEFAULT 'general' CHECK (business_type IN ('general', 'automotive', 'fashion', 'electronics'));

-- 2. Create AI Sessions Table
CREATE TABLE IF NOT EXISTS public.ai_sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  store_id uuid NOT NULL REFERENCES public.stores(id) ON DELETE CASCADE,
  created_at timestamptz DEFAULT now(),
  last_active timestamptz DEFAULT now(),
  saved_time_minutes integer DEFAULT 0,
  actions_suggested integer DEFAULT 0,
  actions_accepted integer DEFAULT 0
);

-- Enable RLS for ai_sessions
ALTER TABLE public.ai_sessions ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS ai_sessions_isolation ON public.ai_sessions;
CREATE POLICY ai_sessions_isolation ON public.ai_sessions FOR ALL USING (store_id IN (SELECT public.get_my_stores())) WITH CHECK (store_id IN (SELECT public.get_my_stores()));

-- 3. Create AI Logs Table
CREATE TABLE IF NOT EXISTS public.ai_logs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  store_id uuid NOT NULL REFERENCES public.stores(id) ON DELETE CASCADE,
  user_id uuid,
  message text,
  response_json jsonb,
  prompt_version text DEFAULT 'v2.0',
  created_at timestamptz DEFAULT now()
);

-- Enable RLS for ai_logs
ALTER TABLE public.ai_logs ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS ai_logs_isolation ON public.ai_logs;
CREATE POLICY ai_logs_isolation ON public.ai_logs FOR ALL USING (store_id IN (SELECT public.get_my_stores())) WITH CHECK (store_id IN (SELECT public.get_my_stores()));

-- 4. Create AI Action Queue Table
CREATE TABLE IF NOT EXISTS public.ai_action_queue (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  store_id uuid NOT NULL REFERENCES public.stores(id) ON DELETE CASCADE,
  action_type text NOT NULL,
  payload jsonb NOT NULL,
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'approved', 'executing', 'completed', 'failed')),
  created_at timestamptz DEFAULT now(),
  executed_at timestamptz
);

-- Enable RLS for ai_action_queue
ALTER TABLE public.ai_action_queue ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS ai_action_queue_isolation ON public.ai_action_queue;
CREATE POLICY ai_action_queue_isolation ON public.ai_action_queue FOR ALL USING (store_id IN (SELECT public.get_my_stores())) WITH CHECK (store_id IN (SELECT public.get_my_stores()));

-- 5. Create AI Recommendation Feedback Table
CREATE TABLE IF NOT EXISTS public.ai_recommendation_feedback (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  store_id uuid NOT NULL REFERENCES public.stores(id) ON DELETE CASCADE,
  recommendation_id text NOT NULL,
  recommendation_type text NOT NULL,
  action_state text NOT NULL CHECK (action_state IN ('accepted', 'rejected', 'ignored')),
  revenue_impact numeric(12,2) DEFAULT 0.00,
  created_at timestamptz DEFAULT now()
);

-- Enable RLS for ai_recommendation_feedback
ALTER TABLE public.ai_recommendation_feedback ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS ai_recommendation_feedback_isolation ON public.ai_recommendation_feedback;
CREATE POLICY ai_recommendation_feedback_isolation ON public.ai_recommendation_feedback FOR ALL USING (store_id IN (SELECT public.get_my_stores())) WITH CHECK (store_id IN (SELECT public.get_my_stores()));

-- 6. Create Specialized Automotive Tables
CREATE TABLE IF NOT EXISTS public.vehicle_brands (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text UNIQUE NOT NULL,
  created_at timestamptz DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.vehicle_models (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  brand_id uuid NOT NULL REFERENCES public.vehicle_brands(id) ON DELETE CASCADE,
  name text NOT NULL,
  years_range text,
  created_at timestamptz DEFAULT now(),
  UNIQUE (brand_id, name, years_range)
);

CREATE TABLE IF NOT EXISTS public.parts_compatibility (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  product_id uuid NOT NULL REFERENCES public.products(id) ON DELETE CASCADE,
  brand_id uuid REFERENCES public.vehicle_brands(id) ON DELETE SET NULL,
  model_id uuid REFERENCES public.vehicle_models(id) ON DELETE SET NULL,
  engine_code text,
  oem_number text,
  cross_reference_oem text,
  created_at timestamptz DEFAULT now()
);

-- Enable RLS for parts_compatibility
ALTER TABLE public.parts_compatibility ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS parts_compatibility_isolation ON public.parts_compatibility;
CREATE POLICY parts_compatibility_isolation ON public.parts_compatibility FOR ALL USING (product_id IN (SELECT id FROM public.products)) WITH CHECK (product_id IN (SELECT id FROM public.products));

-- 7. Add avatar_url to user_profiles
ALTER TABLE public.user_profiles ADD COLUMN IF NOT EXISTS avatar_url text;
