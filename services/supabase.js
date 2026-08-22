const { createClient } = require('@supabase/supabase-js');

const supabaseUrl = process.env.SUPABASE_URL;
// SUPABASE_SERVICE_KEY is the canonical name used by the runtime. Keep the
// role-suffixed name as a compatibility fallback for existing Render services.
const supabaseServiceKey = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;
const supabaseAnonKey = process.env.SUPABASE_ANON_KEY || process.env.VITE_SUPABASE_ANON_KEY;

if (!supabaseUrl || !supabaseServiceKey) {
  throw new Error('SUPABASE_URL and SUPABASE_SERVICE_KEY (or SUPABASE_SERVICE_ROLE_KEY) are required');
}

const supabase = createClient(supabaseUrl, supabaseServiceKey);
// Auth-only client: token validation must not depend on a stale service key.
// It intentionally has no session persistence or database privilege.
const supabaseAuth = createClient(supabaseUrl, supabaseAnonKey || supabaseServiceKey, {
  auth: { persistSession: false, autoRefreshToken: false }
});

module.exports = { supabase, supabaseAuth };
