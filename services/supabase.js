const { createClient } = require('@supabase/supabase-js');

const supabaseUrl = process.env.SUPABASE_URL;
// SUPABASE_SERVICE_KEY is the canonical name used by the runtime. Keep the
// role-suffixed name as a compatibility fallback for existing Render services.
const supabaseServiceKey = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!supabaseUrl || !supabaseServiceKey) {
  throw new Error('SUPABASE_URL and SUPABASE_SERVICE_KEY (or SUPABASE_SERVICE_ROLE_KEY) are required');
}

const supabase = createClient(supabaseUrl, supabaseServiceKey);

module.exports = { supabase };
