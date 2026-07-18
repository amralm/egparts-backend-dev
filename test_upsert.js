require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

async function run() {
  const { data, error } = await supabase.from('feature_limits').upsert({
    plan_feature_id: '00000000-0000-0000-0000-000000000000',
    limit_type: 'count',
    limit_config: { max_value: 10 }
  }, { onConflict: 'plan_feature_id,limit_type' });
  
  console.log(error);
}
run();
