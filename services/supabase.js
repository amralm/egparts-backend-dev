const { createClient } = require('@supabase/supabase-js');

const supabaseUrl = process.env.SUPABASE_URL;

function resolveServiceKey() {
  const envKeys = [
    process.env.SUPABASE_SERVICE_ROLE_KEY,
    process.env.SUPABASE_SERVICE_KEY
  ].filter(Boolean);

  for (const k of envKeys) {
    try {
      const parts = k.split('.');
      if (parts.length === 3) {
        const payload = JSON.parse(Buffer.from(parts[1], 'base64').toString('utf8'));
        if (payload.role === 'service_role') return k;
      }
    } catch {}
  }
  return envKeys[0] || null;
}

function resolveAnonKey() {
  const envKeys = [
    process.env.SUPABASE_ANON_KEY,
    process.env.VITE_SUPABASE_ANON_KEY
  ].filter(Boolean);

  for (const k of envKeys) {
    try {
      const parts = k.split('.');
      if (parts.length === 3) {
        const payload = JSON.parse(Buffer.from(parts[1], 'base64').toString('utf8'));
        if (payload.role === 'anon') return k;
      }
    } catch {}
  }
  return envKeys[0] || null;
}

const supabaseServiceKey = resolveServiceKey();
const supabaseAnonKey = resolveAnonKey();

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
