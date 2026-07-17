const { Client } = require('pg');
const client = new Client(process.env.DATABASE_URL);

if (!process.env.DATABASE_URL) {
  throw new Error('DATABASE_URL is required to run this diagnostic script.');
}

async function run() {
  try {
    await client.connect();
    console.log("Connected!");
    const res1 = await client.query(`SELECT tgname, tgenabled, pg_get_triggerdef(oid) as def FROM pg_trigger WHERE tgrelid = 'public.orders'::regclass`);
    console.log("Orders Triggers:");
    res1.rows.forEach(r => console.log(r.tgname, "->", r.def));
    await client.end();
  } catch (err) {
    console.error("Connection Error:", err);
  }
}
run();
