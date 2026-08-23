'use strict';
// General-purpose read/write SQL runner for Dev database.
// Usage:
//   SUPA_DEV_DB_URL=postgres://... node scripts/pg-query.js --file query.sql
//   SUPA_DEV_DB_URL=... node scripts/pg-query.js --sql "SELECT 1"
// Prints JSON rows. Read-only by default; pass --write to allow mutations.
const fs = require('fs');
const { Client } = require('pg');

async function main() {
  const fileIdx = process.argv.indexOf('--file');
  const sqlIdx = process.argv.indexOf('--sql');
  const allowWrite = process.argv.includes('--write');

  let sql = null;
  if (fileIdx > -1) sql = fs.readFileSync(process.argv[fileIdx + 1], 'utf8');
  else if (sqlIdx > -1) sql = process.argv[sqlIdx + 1];
  if (!sql) {
    console.error('usage: pg-query.js (--sql "..." | --file q.sql) [--write]');
    process.exit(2);
  }
  if (!allowWrite && /^\s*(insert|update|delete|drop|alter|truncate|grant|revoke|create\s+policy)/i.test(sql)) {
    console.error('Refusing mutating SQL without --write');
    process.exit(2);
  }
  if (!process.env.SUPA_DEV_DB_URL && !process.env.SUPA_PG_PASSWORD) {
    console.error('SUPA_DEV_DB_URL is required');
    process.exit(2);
  }

  const client = new Client({
    connectionString: process.env.SUPA_DEV_DB_URL,
    host: process.env.SUPA_PG_HOST, port: process.env.SUPA_PG_PORT ? Number(process.env.SUPA_PG_PORT) : undefined,
    user: process.env.SUPA_PG_USER, password: process.env.SUPA_PG_PASSWORD, database: process.env.SUPA_PG_DATABASE || 'postgres',
    ssl: { rejectUnauthorized: false }
  });
  await client.connect();
  try {
    const { rows } = await client.query(sql);
    console.log(JSON.stringify(rows, null, 1));
  } finally {
    await client.end();
  }
}

main().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
