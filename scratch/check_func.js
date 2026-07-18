require('dotenv').config({path: 'server/.env'});
const { createClient } = require('@supabase/supabase-js');
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

async function main() {
  // Try exec_sql with a simple JSON param to see what PostgREST expects
  // Maybe the function expects a single JSON parameter
  const tests = [
    // Try using raw REST API 
    async () => {
      const url = `${process.env.SUPABASE_URL}/rest/v1/rpc/exec_sql`;
      // Try with single unnamed param via array body (PostgREST supports this for single-param functions)
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Prefer': 'params=single-object' },
        body: JSON.stringify({ sql: `SELECT 1 as test` })
      });
      return { method: 'single-object with sql', status: res.status, body: await res.json() };
    },
  ];
  
  for (const t of tests) {
    const r = await t();
    console.log(r);
  }
}
main();
