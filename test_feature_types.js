require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

async function run() {
  const { data } = await supabase.from('feature_limits').select('limit_type, limit_config, plan_features!inner(features!inner(key))');
  const map = {};
  data.forEach(d => {
    const key = d.plan_features.features.key;
    if (!map[key]) map[key] = new Set();
    map[key].add(d.limit_type);
  });
  
  for (const [k, v] of Object.entries(map)) {
    console.log(k, [...v]);
  }
}
run();
