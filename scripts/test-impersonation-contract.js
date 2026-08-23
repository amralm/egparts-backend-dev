'use strict';
// Live E2E for the canonical impersonation contract (docs/impersonation-contract-v1.md).
// Usage:
//   BASE=http://localhost:5050 SUPA_DEV_DB_URL=postgres://... node scripts/test-impersonation-contract.js
// Requires the server under test to run against the DEV Supabase project.
// Read-only against business tables; creates and revokes its own impersonation sessions.

const crypto = require('crypto');

const BASE = process.env.BASE || 'http://localhost:5050';
const DB_URL = process.env.SUPA_DEV_DB_URL;
if (!DB_URL) {
  console.error('SUPA_DEV_DB_URL is required');
  process.exit(2);
}

let pass = 0;
let fail = 0;
const failures = [];
const createdSessionIds = [];

function ok(name, cond, detail) {
  if (cond) {
    pass += 1;
    console.log(`  PASS ${name}`);
  } else {
    fail += 1;
    failures.push(`${name} :: ${detail || ''}`);
    console.log(`  FAIL ${name} :: ${detail || ''}`);
  }
}

async function api(method, path, { body, headers } = {}) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(headers || {})
    },
    body: body ? JSON.stringify(body) : undefined
  });
  let payload = null;
  try { payload = await res.json(); } catch { /* non-json */ }
  return { status: res.status, payload };
}

function sha256(value) {
  return crypto.createHash('sha256').update(String(value), 'utf8').digest('hex');
}

async function main() {
  const { Client } = require('pg');
  const jwt = require('jsonwebtoken');
  const client = new Client({ connectionString: DB_URL, ssl: { rejectUnauthorized: false } });
  await client.connect();

  // ── identities ────────────────────────────────────────────────
  const sa = (await client.query(
    "SELECT u.id::text AS id, u.email FROM auth.users u JOIN super_admins s ON s.user_id = u.id LIMIT 1"
  )).rows[0];
  const plain = (await client.query(
    "SELECT u.id::text AS id, u.email FROM auth.users u WHERE NOT EXISTS (SELECT 1 FROM super_admins s WHERE s.user_id = u.id) LIMIT 1"
  )).rows[0];
  const stores = (await client.query(
    `SELECT s.id::text, s.subdomain FROM stores s
     JOIN store_subscriptions ss ON ss.store_id = s.id
     WHERE s.status <> 'deleted' AND ss.status = 'active'
       AND s.subscription_expires_at > now()
     ORDER BY s.created_at LIMIT 2`
  )).rows;
  ok('fixtures: super admin + plain user + two stores', Boolean(sa && plain && stores.length === 2),
    `sa=${Boolean(sa)} plain=${Boolean(plain)} stores=${stores.length}`);

  const secret = process.env.SUPABASE_JWT_SECRET;
  async function goTrueSession(email) {
    const surl = process.env.SUPABASE_URL;
    const sk = process.env.SUPABASE_SERVICE_KEY;
    const gl = await (await fetch(`${surl}/auth/v1/admin/generate_link`, {
      method: 'POST',
      headers: { apikey: sk, Authorization: `Bearer ${sk}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'magiclink', email })
    })).json();
    if (!gl.hashed_token) throw new Error(`generate_link failed: ${JSON.stringify(gl).slice(0, 120)}`);
    const v = await (await fetch(`${surl}/auth/v1/verify`, {
      method: 'POST',
      headers: { apikey: sk, 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'magiclink', token_hash: gl.hashed_token })
    })).json();
    if (!v.access_token) throw new Error(`verify failed: ${JSON.stringify(v).slice(0, 120)}`);
    return v.access_token;
  }

  // Local fallback when GoTrue admin API is unreachable: HS256 with project secret.
  function mintLocal(userId) {
    return jwt.sign({ sub: userId, role: 'authenticated', aud: 'authenticated' }, secret, { expiresIn: '20m' });
  }

  let adminToken = null;
  try {
    adminToken = await goTrueSession(sa.email);
    console.log('  auth: real GoTrue session acquired');
  } catch (e) {
    adminToken = mintLocal(sa.id);
    console.log(`  auth: GoTrue unavailable (${e.message.slice(0, 60)}); using locally-signed token`);
  }
  const plainBearer = (() => {
    try { return mintLocal(plain.id); } catch { return null; }
  })();

  const adminHdr = { Authorization: `Bearer ${adminToken}` };

  // ── I. start validation ───────────────────────────────────────
  let r = await api('POST', '/api/platform/impersonation/start', { headers: adminHdr, body: {} });
  ok('start without store_id -> 400', r.status === 400, `got ${r.status}`);

  r = await api('POST', '/api/platform/impersonation/start', { body: { store_id: stores[0].id } });
  ok('start without any auth -> 401', r.status === 401, `got ${r.status}`);

  r = await api('POST', '/api/platform/impersonation/start', {
    headers: { Authorization: `Bearer ${plainBearer}` },
    body: { store_id: stores[0].id }
  });
  ok('start as non-super-admin -> 401/403', r.status === 401 || r.status === 403, `got ${r.status}`);

  // ── A. happy start ────────────────────────────────────────────
  r = await api('POST', '/api/platform/impersonation/start', {
    headers: adminHdr,
    body: { store_id: stores[0].id, reason: 'contract-e2e' }
  });
  ok('start -> 200 envelope.success', r.status === 200 && r.payload?.success === true, `got ${r.status} ${JSON.stringify(r.payload).slice(0, 120)}`);
  const { handoff_code: code, session_id: sessionId, store } = r.payload?.data || {};
  ok('start returns handoff_code + session + store', Boolean(code && sessionId && store?.id === stores[0].id),
    `code=${Boolean(code)} session=${sessionId} store=${store?.id}`);
  if (sessionId) createdSessionIds.push(sessionId);
  ok('start response carries NO raw session token', !('token' in (r.payload?.data || {})), JSON.stringify(Object.keys(r.payload?.data || {})));

  // handoff hash stored, raw never stored
  const dbHandoff = (await client.query('SELECT code_hash FROM impersonation_handoff_codes WHERE session_id=$1', [sessionId])).rows[0];
  ok('handoff stored hashed only', dbHandoff?.code_hash === sha256(code), 'hash mismatch');

  // ── G. expired handoff rejected ───────────────────────────────
  await client.query("UPDATE impersonation_handoff_codes SET expires_at = now() - interval '1 min' WHERE session_id=$1", [sessionId]);
  r = await api('POST', '/api/platform/impersonation/redeem', { body: { handoff_code: code } });
  ok('expired handoff -> 401', r.status === 401 && /HANDOFF/.test(r.payload?.code || ''), `got ${r.status} ${r.payload?.code}`);
  await client.query("UPDATE impersonation_handoff_codes SET expires_at = now() + interval '2 min' WHERE session_id=$1", [sessionId]);

  // ── B. redeem issues opaque token once ────────────────────────
  r = await api('POST', '/api/platform/impersonation/redeem', { body: { handoff_code: code } });
  ok('redeem -> 200 with token', r.status === 200 && typeof r.payload?.data?.token === 'string' && r.payload.data.token.length >= 32,
    `got ${r.status} keys=${JSON.stringify(Object.keys(r.payload?.data || {}))}`);
  const impToken = r.payload?.data?.token;

  const sessRow = (await client.query('SELECT token_hash FROM impersonation_sessions WHERE id=$1', [sessionId])).rows[0];
  ok('session token stored as sha256 only', sessRow?.token_hash === sha256(impToken), 'hash mismatch');

  // ── C. replay redeem -> single-use enforced ───────────────────
  r = await api('POST', '/api/platform/impersonation/redeem', { body: { handoff_code: code } });
  ok('redeem replay -> 409/401 single-use', r.status === 409 || r.status === 401, `got ${r.status} ${r.payload?.code}`);

  // ── D. impersonated tenant call overrides hostile header ──────
  const impHdr = { 'x-impersonate-session': impToken };
  r = await api('GET', '/api/security/blocked-ips', {
    headers: { ...impHdr, 'x-store-subdomain': stores[1].subdomain }
  });
  const authorizedShape = r.status === 200 || (r.status === 403 && /permission/i.test(r.payload?.message || ''));
  ok('tenant call with hostile store header stays authorized', authorizedShape, `got ${r.status} ${JSON.stringify(r.payload).slice(0, 100)}`);

  // forged/garbage token -> 401
  r = await api('GET', '/api/security/blocked-ips', { headers: { 'x-impersonate-session': crypto.randomBytes(32).toString('hex') } });
  ok('forged impersonation token -> 401', r.status === 401, `got ${r.status}`);

  // legacy-format uuid token -> fail-closed rejection (documented contract behavior)
  r = await api('GET', '/api/store-context', { headers: { 'x-impersonate-session': '11111111-1111-1111-1111-111111111111' } });
  ok('legacy-format token is fail-closed rejected', r.status === 401 && r.payload?.code === 'IMPERSONATION_SESSION_INVALID',
    `got ${r.status} ${r.payload?.code}`);

  // ── F. expiry enforcement ─────────────────────────────────────
  await client.query("UPDATE impersonation_sessions SET expires_at = now() - interval '1 min' WHERE id=$1", [sessionId]);
  r = await api('GET', '/api/security/blocked-ips', { headers: impHdr });
  ok('expired session -> 401', r.status === 401, `got ${r.status} ${r.payload?.code}`);
  await client.query("UPDATE impersonation_sessions SET expires_at = now() + interval '25 min' WHERE id=$1", [sessionId]);

  // ── E. revoke kills access immediately ────────────────────────
  r = await api('POST', '/api/platform/impersonation/end', { headers: adminHdr, body: { token: impToken } });
  ok('end -> 200', r.status === 200, `got ${r.status} ${JSON.stringify(r.payload).slice(0, 80)}`);
  r = await api('GET', '/api/security/blocked-ips', { headers: impHdr });
  ok('revoked token -> 401', r.status === 401, `got ${r.status}`);

  // audit event written for end (session id lives in new_values payload)
  const auditRow = (await client.query(
    "SELECT count(*)::int AS n FROM audit_logs WHERE action='platform.impersonation.end' AND new_values::text LIKE $1",
    ['%' + sessionId + '%']
  )).rows[0];
  ok('end wrote audit event', auditRow.n >= 1, `count=${auditRow.n}`);

  // ── cleanup own rows ──────────────────────────────────────────
  for (const sid of createdSessionIds) {
    await client.query('DELETE FROM impersonation_handoff_codes WHERE session_id=$1', [sid]);
    await client.query("DELETE FROM audit_logs WHERE entity_id=$1 AND action LIKE 'platform.impersonation%'", [sid]);
    await client.query('DELETE FROM impersonation_sessions WHERE id=$1', [sid]);
  }
  await client.end();

  console.log(`\nRESULT: pass=${pass} fail=${fail}`);
  if (fail > 0) {
    failures.forEach((f) => console.log(`  - ${f}`));
    process.exit(1);
  }
}

main().catch((e) => {
  console.error('E2E crashed:', e.message);
  process.exit(1);
});
