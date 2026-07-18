require('dotenv').config({path: 'server/.env'});
const { createClient } = require('@supabase/supabase-js');
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

const sql = `SELECT conname, pg_get_constraintdef(oid) FROM pg_constraint WHERE conrelid = 'payment_intents'::regclass AND contype = 'c'`;

async function tryParam(name) {
  const { data, error } = await supabase.rpc('exec_sql', { [name]: sql });
  console.log(`Parameter "${name}":`, JSON.stringify({ data, error: error?.message }));
}

async function main() {
  await tryParam('query');
  await tryParam('sql');
  await tryParam('sql_query');
  await tryParam('sql_string');
}
main();
