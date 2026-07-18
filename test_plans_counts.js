require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

async function run() {
  const { data: plans } = await supabase.from('plans').select('id, code, plan_features(id)');
  for (const p of plans) {
    console.log('Plan', p.code, ':', p.plan_features.length, 'features mapped');
  }
}
run();
