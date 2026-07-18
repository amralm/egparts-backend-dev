require('dotenv').config({path: 'server/.env'});
const { createClient } = require('@supabase/supabase-js');
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

async function main() {
  const sql = `SELECT proname, pg_get_function_identity_arguments(oid) as args FROM pg_proc WHERE pronamespace = 'public'::regnamespace AND proname LIKE '%exec%'`;
  
  const { data, error } = await supabase.rpc('exec_sql_raw', { query: sql });
  console.log('Raw:', JSON.stringify({ data, error }));
  
  // Try other approaches
  const { data: d2, error: e2 } = await supabase.rpc('exec_sql', { sql_text: sql });
  console.log('sql_text:', JSON.stringify({ data: d2, error: e2?.message }));
}
main();
