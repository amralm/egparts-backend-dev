'use strict';
// Index completeness audit: compares indexes declared by migrations against
// live pg_indexes. Usage: SUPA_DEV_DB_URL=... node scripts/pg-index-audit.js
const fs = require('fs');
const path = require('path');
const { Client } = require('pg');

const DIR = path.resolve(__dirname, '..', 'supabase_tabled-and-rows');

function extractIndexes(sql, file) {
  const out = [];
  const re = /CREATE\s+(UNIQUE\s+)?INDEX\s+(?:IF\s+NOT\s+EXISTS\s+)?([A-Za-z_][A-Za-z0-9_]*)\s+ON\s+(?:public\.)?([A-Za-z_][A-Za-z0-9_]*)/gi;
  let m;
  while ((m = re.exec(sql))) {
    out.push({ name: m[2].toLowerCase(), table: m[3].toLowerCase(), file, unique: !!m[1] });
  }
  return out;
}

async function main() {
  if (!process.env.SUPA_DEV_DB_URL) throw new Error('SUPA_DEV_DB_URL required');
  const files = fs.readdirSync(DIR).filter((f) => f.endsWith('.sql'));
  const declared = [];
  for (const f of files) {
    declared.push(...extractIndexes(fs.readFileSync(path.join(DIR, f), 'utf8'), f));
  }
  const client = new Client({ connectionString: process.env.SUPA_DEV_DB_URL, ssl: { rejectUnauthorized: false } });
  await client.connect();
  const { rows } = await client.query("SELECT indexname FROM pg_indexes WHERE schemaname='public'");
  await client.end();
  const existing = new Set(rows.map((r) => r.indexname.toLowerCase()));

  // Indexes intentionally absent because a later migration superseded them
  // with a constraint (documented in the corresponding migration file).
  const SUPERSEDED = new Set([
    'notification_preferences_store_event_uq' // superseded by notification_preferences_pkey (58)
  ]);

  const missing = declared.filter(
    (d) => !existing.has(d.name) && !SUPERSEDED.has(d.name)
  );
  console.log(JSON.stringify({
    declared_total: declared.length,
    existing_total: existing.size,
    missing_count: missing.length,
    missing
  }, null, 2));
}

main().catch((e) => { console.error(e.message); process.exit(1); });
