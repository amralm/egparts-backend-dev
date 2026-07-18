require('dotenv').config({path: 'server/.env'});
const { createClient } = require('@supabase/supabase-js');
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

async function main() {
  // Try all functions that might exist
  for (const fn of ['exec_sql_raw', 'exec_sql_admin', 'exec_sql_simple', 'run_sql', 'query_sql', 'pg_exec']) {
    const { data, error } = await supabase.rpc(fn, { query: 'SELECT 1 as x' });
    if (!error || (error?.code !== 'PGRST202')) console.log(fn, JSON.stringify({ data, error }));
    else console.log(fn, 'NOT FOUND');
  }
}
main();
