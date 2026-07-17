require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

async function run() {
  const { data, error } = await supabase.rpc('exec_sql', { query: "SELECT 1 as num" });
  console.log("exec_sql test:", { data, error });
}
run();
