const postgres = require('postgres');

async function test() {
  if (!process.env.DATABASE_URL) {
    throw new Error('DATABASE_URL is required to run this diagnostic script.');
  }

  const sql = postgres(process.env.DATABASE_URL, {
    ssl: 'require'
  });

  try {
    const res = await sql`SELECT tgname, tgenabled, pg_get_triggerdef(oid) as def FROM pg_trigger WHERE tgrelid = 'public.orders'::regclass`;
    res.forEach(r => console.log(r.tgname, "->", r.def));
  } catch (err) {
    console.error("Failed", err.message);
  } finally {
    await sql.end();
  }
}

test();
