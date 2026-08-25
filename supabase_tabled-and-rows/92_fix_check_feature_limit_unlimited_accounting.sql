-- ─────────────────────────────────────────────────────────────────────────────
-- 92_fix_check_feature_limit_unlimited_accounting.sql
-- Bug: usage_count was only incremented when v_limit <> -1, but -1 is the
-- platform convention for UNLIMITED — so usage on unlimited plans (e.g.
-- Copilot messages on enterprise) was never recorded and admin counters
-- stayed at zero. Enforcement is unchanged (unlimited is always allowed);
-- only the accounting now runs. Idempotent. Rollback: previous definition in
-- git history (git show 523aef8:scratch is gone — use parent commit of 92).
-- ─────────────────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.check_feature_limit(p_store_id uuid, p_feature_key text, p_requested_increment integer DEFAULT 1)
 RETURNS TABLE(allowed boolean, remaining bigint, limit_value bigint, usage bigint, reason text, out_feature_key text, limit_type text, period_type text, is_unlimited boolean)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_key text := lower(trim(coalesce(p_feature_key, ''))); v_increment integer := greatest(coalesce(p_requested_increment, 0), 0);
  v_plan_id uuid; v_status text; v_limit_type text; v_config jsonb; v_limit bigint; v_period text;
  v_start timestamptz; v_end timestamptz; v_usage bigint := 0; v_reserved bigint := 0;
  v_remaining bigint; v_allowed boolean := false; v_reason text;
BEGIN
  IF p_store_id IS NULL OR v_key = '' THEN RETURN QUERY SELECT false,0::bigint,0::bigint,0::bigint,'Missing store or feature key',v_key,NULL::text,'lifetime',false; RETURN; END IF;
  SELECT ss.plan_id,ss.status INTO v_plan_id,v_status FROM public.store_subscriptions ss WHERE ss.store_id=p_store_id ORDER BY (ss.status='active') DESC,ss.created_at DESC LIMIT 1;
  IF v_plan_id IS NULL OR v_status IN ('expired','canceled') THEN RETURN QUERY SELECT false,0::bigint,0::bigint,0::bigint,'No active plan found',v_key,NULL::text,public.infer_feature_period_type(v_key),false; RETURN; END IF;
  SELECT fl.limit_type,fl.limit_config INTO v_limit_type,v_config FROM public.plan_features pf JOIN public.features f ON f.id=pf.feature_id AND f.key=v_key LEFT JOIN public.feature_limits fl ON fl.plan_feature_id=pf.id WHERE pf.plan_id=v_plan_id ORDER BY fl.updated_at DESC NULLS LAST LIMIT 1;
  IF v_limit_type IS NULL AND v_config IS NULL THEN RETURN QUERY SELECT false,0::bigint,0::bigint,0::bigint,'No limit configured for this plan',v_key,NULL::text,public.infer_feature_period_type(v_key),false; RETURN; END IF;
  v_period := coalesce(v_config->>'period_type',v_config->>'period',public.infer_feature_period_type(v_key));
  IF v_period='monthly' THEN v_start:=date_trunc('month',now()); v_end:=v_start+interval '1 month'; ELSIF v_period='daily' THEN v_start:=date_trunc('day',now()); v_end:=v_start+interval '1 day'; ELSE v_start:=to_timestamp(0); v_end:='9999-12-31 23:59:59+00'::timestamptz; END IF;
  SELECT coalesce(fu.usage_count,0) INTO v_usage FROM public.feature_usage fu WHERE fu.store_id=p_store_id AND fu.feature_key=v_key AND fu.period=v_period AND fu.period_start=v_start;
  SELECT coalesce(sum(fr.amount),0) INTO v_reserved FROM public.feature_reservations fr WHERE fr.store_id=p_store_id AND fr.feature_key=v_key AND fr.expires_at>now();

  IF v_limit_type='boolean' THEN
    IF coalesce(v_config->>'enabled','false')='true' THEN v_allowed:=true; v_remaining:=NULL; v_limit:=NULL; v_reason:='Feature enabled by current plan';
    ELSE v_allowed:=false; v_remaining:=0; v_limit:=0; v_reason:='Feature disabled by current plan'; END IF;
  ELSIF v_limit_type='disabled' OR coalesce(v_config->>'enabled','true')='false' OR coalesce(v_config->>'mode','')='disabled' THEN
    v_limit:=0; v_remaining:=0; v_reason:='Feature disabled by current plan';
  ELSE
    v_limit:=NULLIF(v_config->>'max_value','')::bigint;
    IF v_limit=-1 OR v_limit_type='unlimited' OR coalesce(v_config->>'mode','')='unlimited' THEN v_allowed:=true; v_remaining:=NULL; v_reason:='Unlimited by current plan';
    ELSIF v_limit IS NULL THEN v_limit:=0; v_remaining:=0; v_reason:='No limit configured for this plan';
    ELSE v_remaining:=v_limit-v_usage-v_reserved-v_increment; v_allowed:=v_remaining>=0; v_reason:=CASE WHEN v_allowed THEN NULL ELSE 'Feature limit reached for this plan' END; END IF;
  END IF;
  IF v_allowed AND v_increment>0 AND v_limit IS NOT NULL THEN -- migration 92: -1 (unlimited) is now accounted too
    INSERT INTO public.feature_usage(store_id,feature_key,period,period_start,period_end,usage_count) VALUES(p_store_id,v_key,v_period,v_start,v_end,v_increment)
    ON CONFLICT(store_id,feature_key,period,period_start) DO UPDATE SET usage_count=public.feature_usage.usage_count+EXCLUDED.usage_count,updated_at=now();
    SELECT usage_count INTO v_usage FROM public.feature_usage WHERE store_id=p_store_id AND feature_key=v_key AND period=v_period AND period_start=v_start;
  END IF;
  RETURN QUERY SELECT v_allowed,v_remaining,v_limit,v_usage,v_reason,v_key,v_limit_type,v_period,coalesce(v_limit=-1,false);
END; $function$

