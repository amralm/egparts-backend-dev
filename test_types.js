require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

async function run() {
  const { data } = await supabase.from('feature_limits').select('limit_type');
  const uniqueTypes = [...new Set(data.map(d => d.limit_type))];
  console.log('Unique limit types:', uniqueTypes);
}
run();
