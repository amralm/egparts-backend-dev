require('dotenv').config({path: 'server/.env'});
const { createClient } = require('@supabase/supabase-js');
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

async function main() {
  // Try the /sql endpoint directly
  const url = process.env.SUPABASE_URL + '/sql';
  const key = process.env.SUPABASE_SERVICE_KEY;
  
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'apikey': key,
      'Authorization': 'Bearer ' + key,
    },
    body: JSON.stringify({ query: 'SELECT 1 as num' })
  });
  console.log('Status:', res.status);
  const text = await res.text();
  console.log('Response:', text.substring(0, 500));
}
main().catch(e => console.error(e));
