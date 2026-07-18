const { Client } = require('pg');
const client = new Client({ connectionString: 'postgresql://postgres.pfubitpzrmgrnzalcsgr:eE7YmFwa4I0RWIyN@aws-1-ap-northeast-1.pooler.supabase.com:5432/postgres' });
async function run() {
  await client.connect();
  const res = await client.query("SELECT * FROM features");
  console.log(res.rows);
  await client.end();
}
run();
