require('dotenv').config({path: 'server/.env'});
const { createClient } = require('@supabase/supabase-js');
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

async function main() {
  const { data, error } = await supabase.rpc('exec_sql', {
    query: `SELECT conname, pg_get_constraintdef(oid) FROM pg_constraint WHERE conrelid = 'payment_intents'::regclass AND contype = 'c'`
  });
  console.log(JSON.stringify({ data, error }, null, 2));
}
main();
