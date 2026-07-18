const { Client } = require('pg');
const client = new Client({ connectionString: 'postgresql://postgres.pfubitpzrmgrnzalcsgr:eE7YmFwa4I0RWIyN@aws-1-ap-northeast-1.pooler.supabase.com:5432/postgres' });
async function run() {
  await client.connect();
  const res = await client.query("SELECT column_name, data_type FROM information_schema.columns WHERE table_name = 'plans'");
  console.log('plans columns:');
  console.log(res.rows);
  const res2 = await client.query("SELECT column_name, data_type FROM information_schema.columns WHERE table_name = 'plan_features'");
  console.log('plan_features columns:');
  console.log(res2.rows);
  const res3 = await client.query("SELECT column_name, data_type FROM information_schema.columns WHERE table_name = 'feature_limits'");
  console.log('feature_limits columns:');
  console.log(res3.rows);
  await client.end();
}
run();
