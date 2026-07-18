require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

async function run() {
  const { data: pfData } = await supabase.from('plan_features').select('id').limit(1);
  if (!pfData || pfData.length === 0) return console.log('no plan_features');
  
  const planFeatId = pfData[0].id;

  const { data, error } = await supabase.from('feature_limits').upsert({
    plan_feature_id: planFeatId,
    limit_type: 'count',
    limit_config: { max_value: 10 }
  }, { onConflict: 'plan_feature_id,limit_type' });
  
  console.log('Error:', error);
  console.log('Data:', data);
}
run();
