require('dotenv').config({path: 'server/.env'});
const { createClient } = require('@supabase/supabase-js');
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

async function main() {
  // Try without parameters (unnamed JSON param)
  const { data, error } = await supabase.rpc('exec_sql', {});
  console.log('Empty params:', JSON.stringify({ data, error: error?.message }));

  // Try with a single unnamed parameter
  try {
    const res = await fetch(`${process.env.SUPABASE_URL}/rest/v1/rpc/exec_sql`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'apikey': process.env.SUPABASE_SERVICE_KEY,
        'Authorization': `Bearer ${process.env.SUPABASE_SERVICE_KEY}`
      },
      body: JSON.stringify({})
    });
    const body = await res.json();
    console.log('Direct fetch empty:', JSON.stringify({ status: res.status, body }));
  } catch(e) {
    console.error('Fetch error:', e.message);
  }
}
main();
