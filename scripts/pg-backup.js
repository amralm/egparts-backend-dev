'use strict';
// Logical backup for Supabase Postgres: full schema inventory + data snapshots
// of business-critical tables into local files.
// Usage: SUPA_DEV_DB_URL=postgres://... node scripts/pg-backup.js --out dir
const fs = require('fs');
const path = require('path');
const { Client } = require('pg');

const CRITICAL_TABLES = [
  'stores', 'store_subscriptions', 'store_settings', 'site_settings',
  'store_payment_gateways', 'products', 'product_stock', 'orders', 'order_items',
  'payment_intents', 'payment_transactions', 'payment_outbox',
  'user_profiles', 'user_roles', 'user_addresses', 'user_global_phones',
  'coupons', 'notification_templates', 'notification_queue', 'whatsapp_accounts',
  'whatsapp_sessions', 'tenant_invitations', 'roles', 'role_permissions',
  'permissions', 'plans'
];

async function main() {
  const outIdx = process.argv.indexOf('--out');
  const outDir = path.resolve(outIdx > -1 ? process.argv[outIdx + 1] : './prod-backup');
  fs.mkdirSync(outDir, { recursive: true });
  if (!process.env.SUPA_DEV_DB_URL && !process.env.SUPA_PG_PASSWORD) throw new Error('SUPA_DEV_DB_URL required');

  const client = new Client({
    connectionString: process.env.SUPA_DEV_DB_URL,
    host: process.env.SUPA_PG_HOST, port: process.env.SUPA_PG_PORT ? Number(process.env.SUPA_PG_PORT) : undefined,
    user: process.env.SUPA_PG_USER, password: process.env.SUPA_PG_PASSWORD, database: process.env.SUPA_PG_DATABASE || 'postgres',
    ssl: { rejectUnauthorized: false }
  });
  await client.connect();

  // 1) Schema inventory (DDL-ish)
  const schema = {};
  const { rows: cols } = await client.query(`
    SELECT table_name, ordinal_position, column_name, data_type, is_nullable,
           column_default
    FROM information_schema.columns
    WHERE table_schema='public' ORDER BY table_name, ordinal_position`);
  schema.columns = cols;
  const { rows: cons } = await client.query(`
    SELECT conrelid::regclass AS table_name, conname, contype,
           pg_get_constraintdef(oid) AS def
    FROM pg_constraint WHERE connamespace='public'::regnamespace`);
  schema.constraints = cons;
  const { rows: idxs } = await client.query(`SELECT indexname, indexdef FROM pg_indexes WHERE schemaname='public'`);
  schema.indexes = idxs;
  const { rows: funcs } = await client.query(`
    SELECT p.proname, pg_get_function_arguments(p.oid) AS args,
           p.prosecdef, p.proconfig
    FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
    WHERE n.nspname='public'`);
  schema.functions = funcs;
  const { rows: policies } = await client.query(`SELECT * FROM pg_policies WHERE schemaname='public'`);
  schema.policies = policies;
  fs.writeFileSync(path.join(outDir, 'schema.json'), JSON.stringify(schema, null, 2));

  // 2) Rollback-DDL capture: definitions of objects the migration set will alter
  const rollback = { indexes: {}, functions: {} };
  const targets = [
    ['orders_idempotency_key_unique', null],
    ['orders_store_idempotency_unique', null],
    ['notification_queue_idempotency_key_unique', null],
    ['payment_outbox_idempotency_key_uq', null],
    ['idx_order_items_order', null],
    ['idx_products_store_active', null]
  ];
  for (const [name] of targets) {
    const def = idxs.find((i) => i.indexname === name);
    if (def) rollback.indexes[name] = def.indexdef;
  }
  for (const fn of ['commit_feature_usage', 'rollback_feature_usage',
    'approve_manual_wallet_payment', 'reject_manual_wallet_payment',
    'restore_order_stock', 'create_order_atomic']) {
    const f = funcs.find((x) => x.proname === fn);
    if (f) rollback.functions[fn] = f;
  }
  fs.writeFileSync(path.join(outDir, 'rollback-ddl.json'), JSON.stringify(rollback, null, 2));

  // 3) Data snapshots of critical tables (JSONL)
  const manifest = [];
  for (const table of CRITICAL_TABLES) {
    try {
      const exists = await client.query(
        `SELECT to_regclass($1) IS NOT NULL AS ok`, [`public.${table}`]);
      if (!exists.rows[0].ok) { manifest.push({ table, skipped: 'missing' }); continue; }
      const { rowCount, rows } = await client.query(`SELECT * FROM public.${table}`);
      const file = path.join(outDir, `data_${table}.jsonl`);
      fs.writeFileSync(file, rows.map((r) => JSON.stringify(r)).join('\n'));
      manifest.push({ table, rows: rowCount, file });
    } catch (e) {
      manifest.push({ table, error: e.message });
    }
  }
  fs.writeFileSync(path.join(outDir, 'MANIFEST.json'), JSON.stringify(manifest, null, 2));
  await client.end();
  console.log(JSON.stringify({ outDir, tables: manifest.length }, null, 1));
}

main().catch((e) => { console.error(e.message); process.exit(1); });
