-- Function to safely fetch a user from auth.users by email using SECURITY DEFINER.
-- Since the auth schema is not exposed to the REST API, this function allows the backend 
-- (acting as superuser/service_role) to search for users by email.

CREATE OR REPLACE FUNCTION public.get_auth_user_by_email(p_email text)
RETURNS jsonb
SECURITY DEFINER
AS $$
DECLARE
  v_user jsonb;
BEGIN
  SELECT jsonb_build_object('id', id, 'email', email)
  INTO v_user
  FROM auth.users
  WHERE LOWER(email) = LOWER(TRIM(p_email))
  LIMIT 1;
  
  RETURN v_user;
END;
$$ LANGUAGE plpgsql;
