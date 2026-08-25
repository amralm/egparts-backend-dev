const { Client } = require('pg');
const PROD_DB = 'postgresql://postgres.pfubitpzrmgrnzalcsgr:eE7YmFwa4I0RWIyN@aws-1-ap-northeast-1.pooler.supabase.com:5432/postgres';

async function main() {
  const client = new Client({ connectionString: PROD_DB, ssl: { rejectUnauthorized: false } });
  await client.connect();
  
  console.log('--- account_phone_verifications ---');
  const r1 = await client.query("SELECT * FROM account_phone_verifications WHERE phone_e164 = '201211697881'");
  console.log(r1.rows);
  
  console.log('--- user 1 (owner of phone): 238124eb-89b7-466c-9ac4-9cd2aafba325 ---');
  const u1 = await client.query("SELECT id, email, raw_user_meta_data FROM auth.users WHERE id = '238124eb-89b7-466c-9ac4-9cd2aafba325'");
  console.log(u1.rows);

  console.log('--- user 2 (requesting user): 97da0e58-4d88-4c93-a5ca-845282825437 ---');
  const u2 = await client.query("SELECT id, email, raw_user_meta_data FROM auth.users WHERE id = '97da0e58-4d88-4c93-a5ca-845282825437'");
  console.log(u2.rows);

  await client.end();
}
main().catch(console.error);
