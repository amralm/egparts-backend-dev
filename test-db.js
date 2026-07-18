require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
const supabase = createClient(supabaseUrl, supabaseKey);

async function test() {
  const { data, error } = await supabase.from('orders').select('total, payment_status, payment_method, created_at');
  console.log('Error:', error);
  console.log('Orders length:', data ? data.length : 0);
  console.log('First 2 orders:', data ? data.slice(0, 2) : 'null');
}
test();
