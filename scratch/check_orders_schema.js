const { Client } = require('pg');

const connectionString = 'postgresql://postgres.pfubitpzrmgrnzalcsgr:eE7YmFwa4I0RWIyN@aws-1-ap-northeast-1.pooler.supabase.com:5432/postgres';

async function main() {
  const client = new Client({ connectionString, ssl: { rejectUnauthorized: false } });
  await client.connect();
  console.log('Connected.\n');

  // Check orders table constraints
  const { rows: orderConstraints } = await client.query(`
    SELECT conname, pg_get_constraintdef(oid)
    FROM pg_constraint
    WHERE conrelid = 'orders'::regclass AND contype = 'c';
  `);
  console.log('Orders CHECK constraints:', JSON.stringify(orderConstraints, null, 2));

  // Check orders table column defaults
  const { rows: orderCols } = await client.query(`
    SELECT column_name, data_type, is_nullable, column_default
    FROM information_schema.columns
    WHERE table_name = 'orders' AND column_name = 'payment_status';
  `);
  console.log('\nOrders payment_status column:', JSON.stringify(orderCols, null, 2));

  // Check payment_intents column
  const { rows: intentCols } = await client.query(`
    SELECT column_name, data_type, is_nullable, column_default
    FROM information_schema.columns
    WHERE table_name = 'payment_intents' AND column_name = 'status';
  `);
  console.log('\nPayment_intents status column:', JSON.stringify(intentCols, null, 2));
  
  // Check if there's any trigger on orders that might block updates
  const { rows: triggers } = await client.query(`
    SELECT trigger_name, event_manipulation, action_statement
    FROM information_schema.triggers
    WHERE event_object_table = 'orders';
  `);
  console.log('\nOrders triggers:', JSON.stringify(triggers, null, 2));

  // Check RLS policies on orders
  const { rows: policies } = await client.query(`
    SELECT schemaname, tablename, policyname, permissive, roles, cmd, qual, with_check
    FROM pg_policies
    WHERE tablename = 'orders';
  `);
  console.log('\nOrders RLS policies:', JSON.stringify(policies, null, 2));

  // Check RLS policies on payment_intents
  const { rows: intentPolicies } = await client.query(`
    SELECT schemaname, tablename, policyname, permissive, roles, cmd, qual, with_check
    FROM pg_policies
    WHERE tablename = 'payment_intents';
  `);
  console.log('\nPayment_intents RLS policies:', JSON.stringify(intentPolicies, null, 2));

  await client.end();
}
main().catch(e => { console.error('Error:', e); process.exit(1); });
