-- ============================================================
-- Security Fixes: Over-posting & Rate Limiting
-- ============================================================

-- 1. سد ثغرة Over-posting (منع المستخدم من تعديل رصيده أو إحصائياته بنفسه)
CREATE OR REPLACE FUNCTION protect_user_profiles()
RETURNS TRIGGER AS $$
BEGIN
  -- إذا كان الطلب من مستخدم عادي (وليس أدمن)
  IF auth.uid() IS NOT NULL AND (current_setting('request.jwt.claims', true)::jsonb -> 'app_metadata' ->> 'role') IS DISTINCT FROM 'admin' THEN
    -- يتم تجاهل أي تعديل على هذه الحقول الحساسة وإرجاعها لقيمتها القديمة
    NEW.wallet_balance = OLD.wallet_balance;
    NEW.total_spent = OLD.total_spent;
    NEW.orders_count = OLD.orders_count;
    NEW.is_banned = OLD.is_banned;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

DROP TRIGGER IF EXISTS tr_protect_user_profiles ON public.user_profiles;
CREATE TRIGGER tr_protect_user_profiles
BEFORE UPDATE ON public.user_profiles
FOR EACH ROW EXECUTE FUNCTION protect_user_profiles();


-- 2. سد ثغرة Spam Orders (تحديد عدد الطلبات المعلقة لكل مستخدم)
CREATE OR REPLACE FUNCTION rate_limit_orders()
RETURNS TRIGGER AS $$
DECLARE
  pending_count INT;
BEGIN
  -- يتم تطبيق الشرط فقط على المستخدمين العاديين وليس الأدمن
  IF auth.uid() IS NOT NULL AND (current_setting('request.jwt.claims', true)::jsonb -> 'app_metadata' ->> 'role') IS DISTINCT FROM 'admin' THEN
    -- حساب عدد الطلبات قيد التنفيذ أو المعلقة
    SELECT COUNT(*) INTO pending_count
    FROM public.orders
    WHERE user_id = auth.uid()
      AND status IN ('pending', 'processing');

    -- الحد الأقصى هو 5 طلبات
    IF pending_count >= 5 THEN
      RAISE EXCEPTION 'لقد وصلت للحد الأقصى من الطلبات قيد التنفيذ (5 طلبات). يرجى انتظار تأكيد أو توصيل طلباتك الحالية.';
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

DROP TRIGGER IF EXISTS tr_rate_limit_orders ON public.orders;
CREATE TRIGGER tr_rate_limit_orders
BEFORE INSERT ON public.orders
FOR EACH ROW EXECUTE FUNCTION rate_limit_orders();
