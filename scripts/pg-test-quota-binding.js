'use strict';
// Functional regression test: quota reservation tenant binding (migration 82).
//
// Verifies, WITHOUT depending on store plans or feature limits:
//   1. commit_feature_usage refuses a foreign p_expected_store_id (row survives)
//   2. rollback_feature_usage refuses a foreign p_expected_store_id (row survives)
//   3. rollback_feature_usage with the OWNER store succeeds and removes the row
//   4. Legacy call shape (no expected store) keeps working (backward compat)
//
// Usage: SUPA_DEV_DB_URL=postgres://... node scripts/pg-test-quota-binding.js
const { Client } = require('pg');

const FOREIGN_STORE = '00000000-0000-0000-0000-0000000000f1';

async function main() {
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

  const results = [];
  const stamp = Date.now();
  const keyOwner = `matrix_bind_owner_${stamp}`;
  const keyLegacy = `matrix_bind_legacy_${stamp}`;

  const assert = (name, cond, detail) => {
    results.push({ name, pass: !!cond, detail });
    console.log(`${cond ? 'PASS' : 'FAIL'} ${name}${detail ? ' :: ' + detail : ''}`);
  };

  try {
    await client.query('BEGIN');
    // Isolated transaction-style run: we roll everything back at the end so the
    // database stays untouched regardless of outcome.
    const { rows: storeRows } = await client.query(
      'SELECT id FROM public.stores ORDER BY created_at LIMIT 1'
    );
    if (!storeRows.length) throw new Error('No store rows exist in this environment');
    const ownerId = storeRows[0].id;

    const insertReservation = async (key) => {
      const { rows } = await client.query(
        `INSERT INTO public.feature_reservations
           (store_id, feature_key, amount, idempotency_key, expires_at)
         VALUES ($1, 'matrix_test_quota', 1, $2, now() + interval '10 minutes')
         RETURNING id`,
        [ownerId, key]
      );
      return rows[0].id;
    };
    const rowCount = async (key) => {
      const { rows } = await client.query(
        'SELECT count(*)::int AS n FROM public.feature_reservations WHERE idempotency_key = $1',
        [key]
      );
      return rows[0].n;
      };

    await insertReservation(keyOwner);

    // 1) Foreign commit must refuse and leave the reservation intact.
    const foreignCommit = await client.query(
      'SELECT public.commit_feature_usage($1, $2) AS ok',
      [keyOwner, FOREIGN_STORE]
    );
    assert(
      'commit with FOREIGN store refused',
      foreignCommit.rows[0].ok === false,
      `returned ${foreignCommit.rows[0].ok}`
    );
    assert('reservation survived foreign commit', (await rowCount(keyOwner)) === 1);

    // 2) Foreign rollback must refuse and leave the reservation intact.
    const foreignRollback = await client.query(
      'SELECT public.rollback_feature_usage($1, $2) AS ok',
      [keyOwner, FOREIGN_STORE]
    );
    assert(
      'rollback with FOREIGN store refused',
      foreignRollback.rows[0].ok === false,
      `returned ${foreignRollback.rows[0].ok}`
    );
    assert('reservation survived foreign rollback', (await rowCount(keyOwner)) === 1);

    // 3) Owner rollback succeeds and removes the reservation.
    const ownerRollback = await client.query(
      'SELECT public.rollback_feature_usage($1, $2) AS ok',
      [keyOwner, ownerId]
    );
    assert(
      'rollback with OWNER store succeeded',
      ownerRollback.rows[0].ok === true,
      `returned ${ownerRollback.rows[0].ok}`
    );
    assert('reservation removed by owner rollback', (await rowCount(keyOwner)) === 0);

    // 4) Backward-compatible legacy shape (no expected store).
    await insertReservation(keyLegacy);
    const legacyRollback = await client.query(
      'SELECT public.rollback_feature_usage($1) AS ok',
      [keyLegacy]
    );
    assert(
      'legacy rollback (no store arg) still works',
      legacyRollback.rows[0].ok === true && (await rowCount(keyLegacy)) === 0
    );

    await client.query('ROLLBACK');
    console.log('(transaction rolled back — no data written)');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('Test harness error:', err.message);
    results.push({ name: 'harness', pass: false, detail: err.message });
  } finally {
    await client.end();
  }

  const failed = results.filter((r) => !r.pass);
  console.log(`\nRESULT: ${results.length - failed.length}/${results.length} passed`);
  process.exit(failed.length ? 1 : 0);
}

main().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
