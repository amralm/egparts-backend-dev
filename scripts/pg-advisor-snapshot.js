'use strict';
// Advisor-equivalent snapshot for Supabase Postgres (read-only).
// Usage: SUPA_DEV_DB_URL=postgres://... node scripts/pg-advisor-snapshot.js --out audit/advisors-before.json
const fs = require('fs');
const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '../.env') });
const { Client } = require('pg');

const queries = {
  rls_enabled_without_policies: `
    SELECT c.relname AS table_name
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relkind = 'r' AND c.relrowsecurity = true
      AND NOT EXISTS (
        SELECT 1 FROM pg_policies p
        WHERE p.schemaname = 'public' AND p.tablename = c.relname
      )
    ORDER BY 1`,
  security_definer_without_search_path: `
    SELECT p.proname
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public'
      AND p.prosecdef = true
      AND (p.proconfig IS NULL OR NOT EXISTS (
        SELECT 1 FROM unnest(p.proconfig) AS cfg(entry)
        WHERE entry LIKE 'search_path=%'
      ))
    ORDER BY 1`,
  duplicate_indexes: `
    SELECT t.relname AS table_name,
           string_agg(i.relname, ', ' ORDER BY i.relname) AS duplicate_indexes
    FROM pg_index ix
    JOIN pg_class i ON i.oid = ix.indexrelid
    JOIN pg_class t ON t.oid = ix.indrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE n.nspname = 'public'
    GROUP BY t.relname, ix.indkey, ix.indpred, ix.indisunique, ix.indisprimary
    HAVING count(*) > 1`,
  foreign_keys_without_index: `
    SELECT c.conrelid::regclass AS table_name,
           c.conname AS constraint_name,
           array_to_string(c.conkey, ',') AS key_columns
    FROM pg_constraint c
    JOIN pg_namespace n ON n.oid = c.connamespace
    WHERE n.nspname = 'public' AND c.contype = 'f'
      AND NOT EXISTS (
        SELECT 1 FROM pg_index i
        WHERE i.indrelid = c.conrelid
          AND (i.indkey::int2[])[0:array_length(c.conkey,1)-1] @> c.conkey
      )
    ORDER BY 1`,
  definer_execute_granted_wide: `
    SELECT p.proname, g.grantee
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    JOIN pg_roles r ON r.rolname = n.nspname
    CROSS JOIN LATERAL (
      SELECT gr.grantee FROM pg_proc_acl_status_placeholder WHERE false
    ) g
    WHERE false`,
  // Real wide-grant check implemented separately below (ACL parsing).
  unused_indexes_large_tables: `
    SELECT s.relname AS index_name, s.idx_scan, pg_size_pretty(pg_relation_size(s.relid)) AS size
    FROM pg_stat_user_indexes s
    JOIN pg_index i ON i.indexrelid = s.indexrelid
    WHERE s.schemaname = 'public' AND NOT i.indisunique AND NOT i.indisprimary
      AND s.idx_scan < 5
      AND pg_relation_size(s.relid) > 1024 * 512
    ORDER BY pg_relation_size(s.relid) DESC
    LIMIT 25`
};

async function wideGrants(client) {
  const { rows } = await client.query(`
    SELECT proname AS function_name,
           unnest(proacl) AS acl
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND p.prosecdef = true`);
  return rows
    .filter((r) => {
      const acl = String(r.acl || '');
      const grantee = acl.split('=')[0];
      return (grantee === '' || grantee === 'anon' || grantee === 'authenticated') && /X/.test(acl);
    })
    .map((r) => ({ function_name: r.function_name, acl_entry: r.acl }));
}

async function main() {
  const outIdx = process.argv.indexOf('--out');
  const outFile = outIdx > -1 ? process.argv[outIdx + 1] : null;
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
  const report = { generated_at: new Date().toISOString(), database: 'dev' };
  try {
    for (const [name, sql] of Object.entries(queries)) {
      if (sql.includes('placeholder')) continue;
      const { rows } = await client.query(sql);
      report[name] = rows;
    }
    report.definer_execute_wide_grants = await wideGrants(client);
    report.counts = Object.fromEntries(
      Object.entries(report)
        .filter(([k, v]) => Array.isArray(v))
        .map(([k, v]) => [k, v.length])
    );
  } finally {
    await client.end();
  }
  const json = JSON.stringify(report, null, 2);
  if (outFile) {
    fs.mkdirSync(path.dirname(path.resolve(outFile)), { recursive: true });
    fs.writeFileSync(outFile, json);
    console.log(`Snapshot written to ${outFile}`);
  }
  console.log(JSON.stringify(report.counts));
  if (process.env.ADVISOR_VERBOSE === 'true') console.log(json);
}

main().catch((err) => {
  console.error('Advisor snapshot failed:', err.message);
  process.exit(1);
});
