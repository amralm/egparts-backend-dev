-- Keep the same tenant/user boundary while allowing PostgreSQL to evaluate
-- auth.uid() once per statement instead of once per row.
DROP POLICY IF EXISTS account_phone_verifications_self_read ON public.account_phone_verifications;
CREATE POLICY account_phone_verifications_self_read
  ON public.account_phone_verifications
  FOR SELECT
  TO authenticated
  USING (user_id = (SELECT auth.uid()));

DROP POLICY IF EXISTS phone_verification_tickets_self_read ON public.phone_verification_tickets;
CREATE POLICY phone_verification_tickets_self_read
  ON public.phone_verification_tickets
  FOR SELECT
  TO authenticated
  USING (user_id = (SELECT auth.uid()));
