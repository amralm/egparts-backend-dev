require('dotenv').config({path: 'server/.env'});
const { createClient } = require('@supabase/supabase-js');

// Try service_role client
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

async function main() {
  // Try directly querying pg_proc via the REST API (table access)
  const { data, error } = await supabase
    .from('pg_proc')
    .select('proname, pronargs, proargnames')
    .eq('proname', 'exec_sql');
  
  console.log('pg_proc:', JSON.stringify({ data, error }));
  
  // Try via information_schema
  const { data: d2, error: e2 } = await supabase
    .from('routines')
    .select('specific_name, routine_name, specific_schema')
    .eq('routine_name', 'exec_sql');
  console.log('routines:', JSON.stringify({ data: d2, error: e2 }));
}
main();
