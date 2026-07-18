require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

async function test() {
  const { data, error } = await supabase.rpc('get_table_columns', { table_name_param: 'custom_domains' });
  if (error) {
    // try direct SQL if RPC fails
    console.log('RPC Failed:', error.message);
  } else {
    console.log('Columns:', data);
  }
}
test();
