require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

async function run() {
  const { data } = await supabase.from('feature_limits').select('limit_type, limit_config, plan_features!inner(features!inner(key))').eq('plan_features.features.key', 'export_formats').limit(5);
  console.log(JSON.stringify(data, null, 2));
}
run();
