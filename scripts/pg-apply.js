'use strict';
// Apply a SQL migration file to the Dev database (session pooler).
// Usage: SUPA_DEV_DB_URL=postgres://... node scripts/pg-apply.js --file supabase_tabled-and-rows/82_x.sql
const fs = require('fs');
const { Client } = require('pg');

async function main() {
  const idx = process.argv.indexOf('--file');
  if (idx < 0 || !process.argv[idx + 1]) {
    console.error('usage: node scripts/pg-apply.js --file <migration.sql>');
    process.exit(2);
  }
  if (!process.env.SUPA_DEV_DB_URL && !process.env.SUPA_PG_PASSWORD) {
    console.error('SUPA_DEV_DB_URL is required');
    process.exit(2);
  }
  const file = process.argv[idx + 1];
  const sql = fs.readFileSync(file, 'utf8');

  const client = new Client({
    connectionString: process.env.SUPA_DEV_DB_URL,
    host: process.env.SUPA_PG_HOST, port: process.env.SUPA_PG_PORT ? Number(process.env.SUPA_PG_PORT) : undefined,
    user: process.env.SUPA_PG_USER, password: process.env.SUPA_PG_PASSWORD, database: process.env.SUPA_PG_DATABASE || 'postgres',
    ssl: { rejectUnauthorized: false }
  });
  await client.connect();
  try {
    await client.query('BEGIN');
    await client.query(sql);
    // Verification is the caller's job; commit only when statements parsed+ran.
    await client.query('COMMIT');
    console.log(`APPLIED ${file}`);
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    console.error(`FAILED ${file}: ${err.message}`);
    process.exit(1);
  } finally {
    await client.end();
  }
}

main().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
