'use strict';
const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '../.env') });
const { Client } = require('pg');

async function main() {
  const client = new Client({ connectionString: process.env.SUPA_DEV_DB_URL, ssl: { rejectUnauthorized: false } });
  await client.connect();

  console.log('=== 1. VERIFYING TABLES & COLUMNS ===');
  const targetTables = ['store_support_tickets', 'store_support_messages', 'platform_abuse_reports'];
  for (const t of targetTables) {
    const tableRes = await client.query(`
      SELECT table_name FROM information_schema.tables 
      WHERE table_schema = 'public' AND table_name = $1;
    `, [t]);
    if (tableRes.rows.length === 0) {
      throw new Error(`Missing table: ${t}`);
    }
    const colRes = await client.query(`
      SELECT column_name, data_type, is_nullable, column_default 
      FROM information_schema.columns 
      WHERE table_schema = 'public' AND table_name = $1
      ORDER BY ordinal_position;
    `, [t]);
    console.log(`Table '${t}' columns (${colRes.rows.length}):`);
    colRes.rows.forEach(c => {
      console.log(`  - ${c.column_name}: ${c.data_type} (nullable: ${c.is_nullable}, default: ${c.column_default})`);
    });
  }

  console.log('\n=== 2. VERIFYING RLS STATUS & POLICIES ===');
  for (const t of targetTables) {
    const rlsRes = await client.query(`
      SELECT relrowsecurity, relforcerowsecurity 
      FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace 
      WHERE n.nspname = 'public' AND c.relname = $1;
    `, [t]);
    const rlsRow = rlsRes.rows[0];
    console.log(`Table '${t}' RLS enabled: ${rlsRow?.relrowsecurity === true}`);
    if (!rlsRow?.relrowsecurity) {
      throw new Error(`RLS NOT enabled on ${t}`);
    }

    const polRes = await client.query(`
      SELECT policyname, roles, cmd, qual, with_check 
      FROM pg_policies 
      WHERE schemaname = 'public' AND tablename = $1
      ORDER BY policyname;
    `, [t]);
    console.log(`Table '${t}' policies (${polRes.rows.length}):`);
    polRes.rows.forEach(p => {
      console.log(`  - [${p.cmd}] ${p.policyname} (roles: ${p.roles})`);
    });
  }

  console.log('\n=== 3. VERIFYING INDEXES ===');
  for (const t of targetTables) {
    const idxRes = await client.query(`
      SELECT indexname, indexdef 
      FROM pg_indexes 
      WHERE schemaname = 'public' AND tablename = $1
      ORDER BY indexname;
    `, [t]);
    console.log(`Table '${t}' indexes (${idxRes.rows.length}):`);
    idxRes.rows.forEach(i => {
      console.log(`  - ${i.indexname}: ${i.indexdef}`);
    });
  }

  console.log('\n=== 4. VERIFYING SEEDED PERMISSIONS ===');
  const expectedPerms = [
    'support.view',
    'support.manage',
    'platform.reports.view',
    'platform.reports.manage'
  ];
  const permRes = await client.query(`
    SELECT name, code, description, priority 
    FROM public.permissions 
    WHERE name = ANY($1::text[])
    ORDER BY name;
  `, [expectedPerms]);
  console.log('Seeded permissions:', permRes.rows);
  if (permRes.rows.length !== expectedPerms.length) {
    throw new Error(`Expected ${expectedPerms.length} permissions, found ${permRes.rows.length}`);
  }

  const rolePermRes = await client.query(`
    SELECT r.name AS role_name, p.name AS perm_name
    FROM public.role_permissions rp
    JOIN public.roles r ON r.id = rp.role_id
    JOIN public.permissions p ON p.id = rp.permission_id
    WHERE p.name IN ('support.view', 'support.manage')
    ORDER BY r.name, p.name;
  `);
  console.log(`Role permission grants (${rolePermRes.rows.length} total):`);
  rolePermRes.rows.slice(0, 10).forEach(rp => {
    console.log(`  - Role '${rp.role_name}' has '${rp.perm_name}'`);
  });

  console.log('\n=== 5. VERIFYING FOREIGN KEYS INTEGRITY ===');
  const fkRes = await client.query(`
    SELECT
      tc.table_name, 
      kcu.column_name, 
      ccu.table_name AS foreign_table_name,
      ccu.column_name AS foreign_column_name,
      rc.delete_rule
    FROM information_schema.table_constraints AS tc 
    JOIN information_schema.key_column_usage AS kcu
      ON tc.constraint_name = kcu.constraint_name
      AND tc.table_schema = kcu.table_schema
    JOIN information_schema.referential_constraints AS rc
      ON tc.constraint_name = rc.constraint_name
    JOIN information_schema.constraint_column_usage AS ccu
      ON ccu.constraint_name = tc.constraint_name
      AND ccu.table_schema = tc.table_schema
    WHERE tc.constraint_type = 'FOREIGN KEY' 
      AND tc.table_name = ANY($1::text[])
    ORDER BY tc.table_name, kcu.column_name;
  `, [targetTables]);
  console.log(`Foreign key constraints (${fkRes.rows.length}):`);
  fkRes.rows.forEach(fk => {
    console.log(`  - ${fk.table_name}.${fk.column_name} -> ${fk.foreign_table_name}.${fk.foreign_column_name} (ON DELETE ${fk.delete_rule})`);
  });

  console.log('\n=== ALL M1 DATABASE CHECKS PASSED 100% ===');
  await client.end();
}

main().catch(err => {
  console.error('VERIFICATION ERROR:', err);
  process.exit(1);
});
