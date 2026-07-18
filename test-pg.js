const { Client } = require('pg');
const client = new Client({
  connectionString: 'postgresql://postgres.pfubitpzrmgrnzalcsgr:eE7YmFwa4I0RWIyN@aws-1-ap-northeast-1.pooler.supabase.com:5432/postgres'
});

async function test() {
  await client.connect();
  const res = await client.query("SELECT column_name, data_type FROM information_schema.columns WHERE table_name = 'custom_domains'");
  console.log('Columns:', res.rows);
  await client.end();
}
test();
