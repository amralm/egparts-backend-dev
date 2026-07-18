require('dotenv').config({path: 'server/.env'});
const supabaseUrl = process.env.SUPABASE_URL;
const serviceKey = process.env.SUPABASE_SERVICE_KEY;

const sql = `SELECT conname, pg_get_constraintdef(oid) FROM pg_constraint WHERE conrelid = 'payment_intents'::regclass AND contype = 'c'`;

const headers = {
  'Content-Type': 'application/json',
  'apikey': serviceKey,
  'Authorization': `Bearer ${serviceKey}`
};

async function test(name) {
  const res = await fetch(`${supabaseUrl}/rest/v1/rpc/exec_sql`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ [name]: sql })
  });
  const body = await res.json();
  console.log(`${name}: status=${res.status}`, JSON.stringify(body).slice(0, 300));
}

async function main() {
  await test('query');
  await test('sql');
  await test('sql_query');
  await test('sql_string');
  await test('sql_text');
  await test('sql_code');
  await test('command');
  // Try unnamed (just the string directly)
  try {
    const res = await fetch(`${supabaseUrl}/rest/v1/rpc/exec_sql`, {
      method: 'POST',
      headers: { ...headers, 'Content-Type': 'text/plain' },
      body: sql
    });
    const body = await res.json();
    console.log(`unnamed text/plain: status=${res.status}`, JSON.stringify(body).slice(0, 300));
  } catch(e) { console.error('text/plain error:', e.message); }
}
main();
