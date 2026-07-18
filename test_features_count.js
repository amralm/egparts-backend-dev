require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

async function run() {
  const { data: plans } = await supabase.from('plans').select('*, plan_features(id, feature_id, features(*), feature_limits(*))');
  console.log('Plan 1 features count:', plans[0].plan_features.length);
  const { data: feats } = await supabase.from('features').select('*');
  console.log('Total system features count:', feats.length);
}
run();
