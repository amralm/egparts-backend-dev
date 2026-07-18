const { Client } = require('pg');

const connectionString = 'postgresql://postgres.pfubitpzrmgrnzalcsgr:eE7YmFwa4I0RWIyN@aws-1-ap-northeast-1.pooler.supabase.com:5432/postgres';

async function main() {
  const client = new Client({ connectionString, ssl: { rejectUnauthorized: false } });
  await client.connect();
  console.log('Connected.');

  // Step 1: Check current constraint
  const { rows: constraints } = await client.query(`
    SELECT conname, pg_get_constraintdef(oid)
    FROM pg_constraint
    WHERE conrelid = 'payment_intents'::regclass AND contype = 'c';
  `);
  console.log('Current constraint:', JSON.stringify(constraints, null, 2));

  // Step 2: Alter the constraint
  await client.query(`
    ALTER TABLE payment_intents DROP CONSTRAINT IF EXISTS payment_intents_status_check;
  `);
  console.log('Dropped old constraint.');

  await client.query(`
    ALTER TABLE payment_intents ADD CONSTRAINT payment_intents_status_check
      CHECK (status IN ('created','processing','authorized','captured','failed','cancelled','waiting_verification','approved'));
  `);
  console.log('Added new constraint with waiting_verification and approved.');

  // Step 3: Verify
  const { rows: verify } = await client.query(`
    SELECT conname, pg_get_constraintdef(oid)
    FROM pg_constraint
    WHERE conrelid = 'payment_intents'::regclass AND contype = 'c';
  `);
  console.log('Updated constraint:', JSON.stringify(verify, null, 2));

  await client.end();
  console.log('Done.');
}
main().catch(e => { console.error('Error:', e); process.exit(1); });
