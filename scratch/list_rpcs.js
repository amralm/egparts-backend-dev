require('dotenv').config({path: 'server/.env'});
const supabaseUrl = process.env.SUPABASE_URL;
const serviceKey = process.env.SUPABASE_SERVICE_KEY;
const headers = { 'apikey': serviceKey, 'Authorization': `Bearer ${serviceKey}` };

async function main() {
  // Try listing functions
  const res = await fetch(`${supabaseUrl}/rest/v1/rpc/`, { method: 'GET', headers });
  const body = await res.json();
  console.log('status:', res.status, JSON.stringify(body).slice(0, 500));
  
  // Try with open-api
  const res2 = await fetch(`${supabaseUrl}/rest/v1/`, { method: 'GET', headers });
  const body2 = await res2.json();
  console.log('root:', res2.status, JSON.stringify(body2).slice(0, 500));
}
main();
