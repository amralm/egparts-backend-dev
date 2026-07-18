const fs = require('fs');
const postgres = require('postgres');

// Read server/.env and populate process.env
const envContent = fs.readFileSync('server/.env', 'utf8');
const env = require('dotenv').parse(envContent);
const dbUrl = env.SUPABASE_DB_URL || env.DATABASE_URL;

if (!dbUrl) {
  // Let's fallback to construct connection string if possible or read from env
  console.error('No database URL found');
  process.exit(1);
}

const sql = postgres(dbUrl, {
  ssl: { rejectUnauthorized: false }
});

async function main() {
  try {
    console.log('Querying RLS policies for site_settings...');
    const policies = await sql`
      SELECT tablename, policyname, permissive, roles, cmd, qual, with_check
      FROM pg_policies
      WHERE tablename = 'site_settings';
    `;
    console.log('=== POLICIES ===');
    console.log(JSON.stringify(policies, null, 2));

    console.log('Querying triggers for site_settings...');
    const triggers = await sql`
      SELECT trigger_name, event_manipulation, action_statement
      FROM information_schema.triggers
      WHERE event_object_table = 'site_settings';
    `;
    console.log('=== TRIGGERS ===');
    console.log(JSON.stringify(triggers, null, 2));
  } catch (err) {
    console.error('DB Error:', err.message);
  } finally {
    process.exit(0);
  }
}
main();
