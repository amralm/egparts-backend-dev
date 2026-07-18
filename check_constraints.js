const { Client } = require('pg');
const client = new Client({ connectionString: 'postgresql://postgres.pfubitpzrmgrnzalcsgr:eE7YmFwa4I0RWIyN@aws-1-ap-northeast-1.pooler.supabase.com:5432/postgres' });
async function run() {
  await client.connect();
  const res = await client.query("SELECT conname, pg_get_constraintdef(c.oid) FROM pg_constraint c JOIN pg_namespace n ON n.oid = c.connamespace WHERE contype IN ('u', 'p') AND conrelid = 'plan_features'::regclass;");
  console.log('plan_features constraints:');
  console.log(res.rows);
  const res2 = await client.query("SELECT conname, pg_get_constraintdef(c.oid) FROM pg_constraint c JOIN pg_namespace n ON n.oid = c.connamespace WHERE contype IN ('u', 'p') AND conrelid = 'feature_limits'::regclass;");
  console.log('feature_limits constraints:');
  console.log(res2.rows);
  await client.end();
}
run();
