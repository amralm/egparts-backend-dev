const { Client } = require('pg');
const client = new Client({ connectionString: 'postgresql://postgres.pfubitpzrmgrnzalcsgr:eE7YmFwa4I0RWIyN@aws-1-ap-northeast-1.pooler.supabase.com:5432/postgres' });
async function run() {
  await client.connect();
  const res = await client.query("SELECT column_name, data_type FROM information_schema.columns WHERE table_name = 'notification_templates'");
  console.log('notification_templates columns:');
  console.log(res.rows);
  const res2 = await client.query("SELECT column_name, data_type FROM information_schema.columns WHERE table_name = 'notification_layouts'");
  console.log('notification_layouts columns:');
  console.log(res2.rows);
  await client.end();
}
run();
