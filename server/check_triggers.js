const { Client } = require('pg');
const client = new Client(process.env.DATABASE_URL);

if (!process.env.DATABASE_URL) {
  throw new Error('DATABASE_URL is required to run this diagnostic script.');
}

async function run() {
  await client.connect();
  const res1 = await client.query(`SELECT tgname, tgenabled, pg_get_triggerdef(oid) as def FROM pg_trigger WHERE tgrelid = 'public.orders'::regclass`);
  console.log("Orders Triggers:", res1.rows);
  
  const res2 = await client.query(`SELECT tgname, tgenabled, pg_get_triggerdef(oid) as def FROM pg_trigger WHERE tgrelid = 'public.order_logs'::regclass`);
  console.log("Order Logs Triggers:", res2.rows);

  const res3 = await client.query(`SELECT * FROM pg_policies WHERE tablename IN ('order_tracking', 'orders', 'order_logs')`);
  console.log("Policies:", res3.rows.map(r => ({ table: r.tablename, name: r.policyname, cmd: r.cmd, roles: r.roles, qual: r.qual, with_check: r.with_check })));

  await client.end();
}
run().catch(console.error);
