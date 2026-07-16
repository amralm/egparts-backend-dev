import { useEffect, useState } from "react";
import { supabase } from "../lib/supabase";
import { getClientIP } from "../lib/ip";

export function useAuth() {
  const [session, setSession] = useState(undefined);

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => {
      setSession(data.session);
    });

    const { data: listener } = supabase.auth.onAuthStateChange(
      async (event, session) => {
        setSession(session);

        if (event === 'SIGNED_IN' && session?.user && sessionStorage.getItem('pending_login_log')) {
          sessionStorage.removeItem('pending_login_log');

          const ip_address = await getClientIP();
          const provider = session.user.app_metadata?.provider || 'email';
          const login_method = provider === 'google' ? 'google' :
            provider === 'otp' ? 'otp' :
            session.user.app_metadata?.role === 'admin' ? 'admin' : 'email';

          supabase.from('user_login_logs').insert({
            user_id: session.user.id,
            email: session.user.email,
            ip_address,
            user_agent: navigator.userAgent,
            login_method,
          }).then().catch(() => {});
        }
      }
    );

    return () => listener.subscription.unsubscribe();
  }, []);

  return session;
}
