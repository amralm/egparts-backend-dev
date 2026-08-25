'use strict';
// Migration completeness audit: compares tables referenced by CREATE TABLE in
// supabase_tabled-and-rows/*.sql against actual public schema tables.
// Usage: SUPA_DEV_DB_URL=postgres://... node scripts/pg-migration-audit.js
const fs = require('fs');
const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '../.env') });
const { Client } = require('pg');

const MIGRATIONS_DIR = path.resolve(__dirname, '..', 'supabase_tabled-and-rows');

function extractTables(sql) {
  const names = new Set();
  const re = /CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?(?:public\.)?([A-Za-z_][A-Za-z0-9_]*)/gi;
  let m;
  while ((m = re.exec(sql))) names.add(m[1].toLowerCase());
  return [...names];
}

async function main() {
  if (!process.env.SUPA_DEV_DB_URL && !process.env.SUPA_PG_PASSWORD) {
    console.error('SUPA_DEV_DB_URL is required');
    process.exit(2);
  }
  const files = fs.readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith('.sql'))
    .sort((a, b) => parseInt(a, 10) - parseInt(b, 10));

  const expectedByFile = {};
  const allExpected = new Set();
  for (const f of files) {
    const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, f), 'utf8');
    const tables = extractTables(sql);
    if (tables.length) {
      expectedByFile[f] = tables;
      tables.forEach((t) => allExpected.add(t));
    }
  }

  const client = new Client({
    connectionString: process.env.SUPA_DEV_DB_URL,
    host: process.env.SUPA_PG_HOST, port: process.env.SUPA_PG_PORT ? Number(process.env.SUPA_PG_PORT) : undefined,
    user: process.env.SUPA_PG_USER, password: process.env.SUPA_PG_PASSWORD, database: process.env.SUPA_PG_DATABASE || 'postgres',
    ssl: { rejectUnauthorized: false }
  });
  await client.connect();
  const { rows } = await client.query(
    "SELECT tablename FROM pg_tables WHERE schemaname = 'public'"
  );
  await client.end();
  const existing = new Set(rows.map((r) => r.tablename.toLowerCase()));

  const missingTables = [...allExpected].filter((t) => !existing.has(t));
  const missingMigrations = Object.entries(expectedByFile)
    .filter(([, tables]) => tables.some((t) => !existing.has(t)))
    .map(([file, tables]) => ({
      file,
      missing_tables: tables.filter((t) => !existing.has(t))
    }));

  console.log(JSON.stringify({
    checked_files: files.length,
    files_creating_tables: Object.keys(expectedByFile).length,
    expected_tables: allExpected.size,
    existing_public_tables: existing.size,
    missing_tables_count: missingTables.length,
    missing_tables: missingTables,
    migrations_to_apply: missingMigrations
  }, null, 2));
}

main().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
