const { Client } = require('pg');

async function test(url) {
  const client = new Client(url);
  try {
    await client.connect();
    console.log("Connected to", url);
    const res1 = await client.query(`SELECT tgname, tgenabled, pg_get_triggerdef(oid) as def FROM pg_trigger WHERE tgrelid = 'public.orders'::regclass`);
    res1.rows.forEach(r => console.log(r.tgname, "->", r.def));
    await client.end();
  } catch (err) {
    console.error("Failed", err.message);
  }
}

async function run() {
  if (!process.env.DATABASE_URL) {
    throw new Error('DATABASE_URL is required to run this diagnostic script.');
  }
  await test(process.env.DATABASE_URL);
}
run();
