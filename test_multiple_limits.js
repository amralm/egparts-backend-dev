require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

async function run() {
  const { data } = await supabase.from('feature_limits').select('plan_feature_id');
  const counts = {};
  data.forEach(d => {
    counts[d.plan_feature_id] = (counts[d.plan_feature_id] || 0) + 1;
  });
  const multiple = Object.entries(counts).filter(([k,v]) => v > 1);
  console.log('Plan features with multiple limits:', multiple);
}
run();
