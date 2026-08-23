'use strict';
// Authenticated lifecycle E2E against the DEV backend (mutations allowed):
//   dedicated test user -> password login/change -> TOTP 2FA enable/disable
//   -> tenant-scoped addresses CRUD -> OTP send (external channel noted).
// Usage: node scripts/test-auth-lifecycle.js   (env from backend/.env + SUPA_DEV_DB_URL)

const crypto = require('crypto');
require('dotenv').config();

const BASE = process.env.E2E_BACKEND_URL || 'https://egparts-backend-dev.onrender.com';
const SURL = process.env.SUPABASE_URL;
const ANON = process.env.VITE_SUPABASE_ANON_KEY || process.env.SUPABASE_ANON_KEY;
const SERVICE = process.env.SUPABASE_SERVICE_KEY;
const DB_URL = process.env.SUPA_DEV_DB_URL;
const STORE_SUB = process.env.E2E_STORE_SUBDOMAIN || 'egparts';

let pass = 0, fail = 0, skipped = 0;
const failures = [];
const ok = (n, c, d) => { if (c) { pass++; console.log(`  PASS ${n}`); } else { fail++; failures.push(`${n} :: ${d || ''}`); console.log(`  FAIL ${n} :: ${d || ''}`); } };
const skip = (n, why) => { skipped++; console.log(`  SKIP ${n} :: ${why}`); };

async function jfetch(url, { method = 'GET', body, headers = {} } = {}) {
  const res = await fetch(url, {
    method,
    headers: { 'Content-Type': 'application/json', ...headers },
    body: body ? JSON.stringify(body) : undefined
  });
  let payload = null;
  try { payload = await res.json(); } catch { /* html/empty */ }
  return { status: res.status, payload };
}

// ── RFC 6238 TOTP (SHA-1, 30s, 6 digits, ±1 window) ──────────────
const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
function base32Decode(input) {
  let bits = 0, value = 0; const out = [];
  for (const ch of input.replace(/=+$/, '').toUpperCase()) {
    const idx = B32.indexOf(ch);
    if (idx === -1) continue;
    value = (value << 5) | idx; bits += 5;
    if (bits >= 8) { out.push((value >>> (bits - 8)) & 0xff); bits -= 8; }
  }
  return Buffer.from(out);
}
function totpNow(secretB32, offset = 0) {
  const key = base32Decode(secretB32);
  const counter = Math.floor(Date.now() / 30000) + offset;
  const buf = Buffer.alloc(8); buf.writeBigUInt64BE(BigInt(counter));
  const hmac = crypto.createHmac('sha1', key).update(buf).digest();
  const pos = hmac[hmac.length - 1] & 0x0f;
  const bin = ((hmac[pos] & 0x7f) << 24) | (hmac[pos + 1] << 16) | (hmac[pos + 2] << 8) | hmac[pos + 3];
  return String(bin % 1_000_000).padStart(6, '0');
}

(async () => {
  const stamp = Date.now().toString(36);
  const email = `e2e-lifecycle-${stamp}@egparts-test.local`;
  const password1 = `Pw1-${crypto.randomBytes(9).toString('hex')}!`;
  const password2 = `Pw2-${crypto.randomBytes(9).toString('hex')}!`;

  // ── provision dedicated user + owner role on the E2E store ──
  const created = await jfetch(`${SURL}/auth/v1/admin/users`, {
    method: 'POST',
    headers: { apikey: SERVICE, Authorization: `Bearer ${SERVICE}` },
    body: { email, password: password1, email_confirm: true }
  });
  const userId = created.payload?.id;
  ok('provision: dedicated confirmed test user', Boolean(userId), JSON.stringify(created.payload).slice(0, 120));

  const { Client } = require('pg');
  const pg = new Client({ connectionString: DB_URL, ssl: { rejectUnauthorized: false } });
  await pg.connect();
  const storeRow = (await pg.query('SELECT id::text FROM stores WHERE subdomain=$1', [STORE_SUB])).rows[0];
  await pg.query(
    `INSERT INTO user_roles (user_id, store_id, role_id)
     SELECT $1, $2, r.id FROM roles r WHERE r.name='owner' AND r.role_type='tenant_template'
     ON CONFLICT DO NOTHING`, [userId, storeRow.id]);
  ok('provision: owner role bound to store', Boolean(storeRow?.id), `store=${STORE_SUB}`);

  try {
    // ── 1. password login ──
    let r = await jfetch(`${SURL}/auth/v1/token?grant_type=password`, {
      method: 'POST', headers: { apikey: ANON },
      body: { email, password: password1 }
    });
    ok('login with seeded password -> 200', r.status === 200 && Boolean(r.payload?.access_token), `got ${r.status}`);
    let bearer = { Authorization: `Bearer ${r.payload?.access_token}`, apikey: ANON };

    r = await jfetch(`${SURL}/auth/v1/token?grant_type=password`, {
      method: 'POST', headers: { apikey: ANON }, body: { email, password: 'definitely-wrong' }
    });
    ok('wrong password -> 400', r.status === 400, `got ${r.status}`);

    // ── 2. password change ──
    r = await jfetch(`${SURL}/auth/v1/user`, {
      method: 'PUT', headers: bearer, body: { password: password2 }
    });
    ok('change password -> 200', r.status === 200, `got ${r.status}`);

    r = await jfetch(`${SURL}/auth/v1/token?grant_type=password`, {
      method: 'POST', headers: { apikey: ANON }, body: { email, password: password1 }
    });
    ok('old password rejected after change', r.status === 400, `got ${r.status}`);

    r = await jfetch(`${SURL}/auth/v1/token?grant_type=password`, {
      method: 'POST', headers: { apikey: ANON }, body: { email, password: password2 }
    });
    ok('new password accepted', r.status === 200 && Boolean(r.payload?.access_token), `got ${r.status}`);
    bearer = { Authorization: `Bearer ${r.payload?.access_token}`, apikey: ANON };

    // ── 3. TOTP 2FA lifecycle ──
    const authHdr = { ...bearer, 'x-store-subdomain': STORE_SUB };

    r = await jfetch(`${BASE}/api/auth/2fa/status`, { headers: authHdr });
    ok('2fa/status reachable', r.status === 200 && r.payload?.success !== false, `got ${r.status} ${JSON.stringify(r.payload).slice(0, 90)}`);

    r = await jfetch(`${BASE}/api/auth/2fa/totp/setup`, { headers: authHdr });
    const secret = r.payload?.data?.secret || r.payload?.secret;
    ok('totp/setup returns secret', r.status === 200 && Boolean(secret), `got ${r.status} keys=${JSON.stringify(Object.keys(r.payload?.data || r.payload || {}))}`);

    if (secret) {
      r = await jfetch(`${BASE}/api/auth/2fa/totp/verify-setup`, {
        method: 'POST', headers: authHdr, body: { token: totpNow(secret) }
      });
      ok('totp/verify-setup accepts live code', r.status === 200 && r.payload?.success !== false, `got ${r.status} ${JSON.stringify(r.payload).slice(0, 110)}`);

      r = await jfetch(`${BASE}/api/auth/2fa/enable`, { method: 'POST', headers: authHdr, body: { code: totpNow(secret) } });
      ok('2fa/enable -> success', r.status === 200 && r.payload?.success !== false, `got ${r.status} ${JSON.stringify(r.payload).slice(0, 110)}`);

      r = await jfetch(`${BASE}/api/auth/2fa/status`, { headers: authHdr });
      const enabled = JSON.stringify(r.payload).match(/"(enabled|is_enabled|two_factor_enabled)"\s*:\s*true/i);
      ok('status reports enabled after enable', Boolean(enabled), JSON.stringify(r.payload).slice(0, 140));

      r = await jfetch(`${BASE}/api/auth/2fa/disable`, { method: 'POST', headers: authHdr, body: { code: totpNow(secret) } });
      ok('2fa/disable -> success', r.status === 200 && r.payload?.success !== false, `got ${r.status} ${JSON.stringify(r.payload).slice(0, 110)}`);

      r = await jfetch(`${BASE}/api/auth/2fa/status`, { headers: authHdr });
      const stillEnabled = JSON.stringify(r.payload).match(/"(enabled|is_enabled|two_factor_enabled)"\s*:\s*true/i);
      ok('status reports disabled after disable', !stillEnabled, JSON.stringify(r.payload).slice(0, 140));
    }

    // ── 4. tenant-scoped addresses CRUD ──
    const addrHdr = { ...authHdr };
    r = await jfetch(`${BASE}/api/account/addresses`, { headers: addrHdr });
    ok('addresses list reachable', r.status === 200 && Array.isArray(r.payload?.data?.addresses), `got ${r.status} ${JSON.stringify(r.payload).slice(0, 100)}`);
    const before = r.payload?.data?.addresses?.length ?? 0;

    const newAddr = { title: 'E2E Home', phone: '+201000000000', city: 'القاهرة', address: 'شارع الاختبار رقم ١٢٣', is_default: false };
    r = await jfetch(`${BASE}/api/account/addresses`, { method: 'POST', headers: addrHdr, body: newAddr });
    ok('address create -> 201/200', [200, 201].includes(r.status), `got ${r.status} ${JSON.stringify(r.payload).slice(0, 110)}`);
    const addrId = r.payload?.data?.address?.id || r.payload?.data?.id;

    r = await jfetch(`${BASE}/api/account/addresses`, { headers: addrHdr });
    const after = r.payload?.data?.addresses?.length ?? 0;
    ok('address persisted (+1)', after === before + 1, `before=${before} after=${after}`);

    if (addrId) {
      r = await jfetch(`${BASE}/api/account/addresses/${addrId}`, { method: 'DELETE', headers: addrHdr });
      ok('address delete -> 200', r.status === 200, `got ${r.status}`);
      r = await jfetch(`${BASE}/api/account/addresses`, { headers: addrHdr });
      ok('address removed (-1)', (r.payload?.data?.addresses?.length ?? 0) === before, `now=${r.payload?.data?.addresses?.length}`);
    } else {
      skip('address delete roundtrip', 'create response carried no id');
    }

    // cross-store isolation: switching store header must never leak this store's addresses
    const otherStore = (await pg.query("SELECT subdomain FROM stores WHERE subdomain<>$1 AND status<>'deleted' LIMIT 1", [STORE_SUB])).rows[0];
    r = await jfetch(`${BASE}/api/account/addresses`, { headers: { ...addrHdr, 'x-store-subdomain': otherStore.subdomain } });
    const leaked = r.status === 200 && JSON.stringify(r.payload?.data || {}).includes('E2E Home');
    ok('addresses tenant-scoped (no cross-store leak)', !leaked,
      `status=${r.status} leaked=${leaked} (403 from ineligible store counts as safe)`);

    // ── 5. order creation + COD payment path ──
    const prodRow = (await pg.query(
      "SELECT id::text FROM products WHERE store_id=$1 AND is_active=true AND COALESCE(stock_quantity, stock, 0) > 0 ORDER BY created_at DESC LIMIT 1",
      [storeRow.id]
    )).rows[0];
    if (prodRow) {
      const idem = `e2e-${crypto.randomBytes(10).toString('hex')}`;
      const orderBody = {
        items: [{ id: prodRow.id, qty: 1 }],
        phone: '+201000000000',
        city: 'القاهرة',
        address: 'شارع الاختبار رقم ١٢٣',
        paymentMethod: 'cod',
        note: 'auth-lifecycle e2e',
        idempotencyKey: idem
      };
      r = await jfetch(`${BASE}/api/orders`, { method: 'POST', headers: addrHdr, body: orderBody });
      ok('COD order create -> 200/201', [200, 201].includes(r.status) && Boolean(r.payload?.data?.order?.id || r.payload?.data?.id),
        `got ${r.status} ${JSON.stringify(r.payload).slice(0, 120)}`);
      const orderId = r.payload?.data?.order?.id || r.payload?.data?.id;

      if (orderId) {
        r = await jfetch(`${BASE}/api/orders`, { method: 'POST', headers: addrHdr, body: orderBody });
        const payloadText = JSON.stringify(r.payload || {});
        const replayedSame = payloadText.includes(orderId);
        ok('same idempotencyKey replays SAME order', replayedSame && [200, 201].includes(r.status),
          `first=${orderId} status=${r.status} body=${payloadText.slice(0, 140)}`);
      }
    } else {
      skip('order + COD flow', 'no products seeded on E2E store');
    }

    // ── 6. OTP send (external WhatsApp channel) ──
    const otpPhone = '+201000000001';
    r = await jfetch(`${BASE}/api/auth/send-otp`, {
      method: 'POST', headers: { 'x-store-subdomain': STORE_SUB },
      body: { phone: otpPhone, turnstile_token: 'dev-mode-bypass' }
    });
    if (r.status === 200) {
      ok('otp/send accepted (200)', true);
      const echoed = JSON.stringify(r.payload?.data || r.payload || {}).match(/"(code|otp)"\s*:\s*"?\d{4,6}/);
      if (echoed) {
        const code = echoed[1] ? JSON.stringify(r.payload?.data || r.payload).match(new RegExp(`"${echoed[1]}"\\s*:\\s*"?(\d{4,6})`))[1] : null;
        const vr = await jfetch(`${BASE}/api/auth/verify-otp`, {
          method: 'POST', headers: { 'x-store-subdomain': STORE_SUB },
          body: { phone: otpPhone, code }
        });
        ok('otp/verify roundtrip with dev-echoed code', vr.status === 200 && vr.payload?.success !== false, `got ${vr.status} ${JSON.stringify(vr.payload).slice(0, 90)}`);
      } else {
        skip('otp/verify roundtrip', 'code delivered to external WhatsApp inbox — not readable by automation');
      }
    } else if (r.status === 503 && r.payload?.code === 'OTP_CHANNEL_UNAVAILABLE') {
      // Graceful typed degradation when no WhatsApp account is provisioned:
      // the CONTRACT is correct; the channel needs a paired device (manual).
      ok('otp/send degrades gracefully (503 OTP_CHANNEL_UNAVAILABLE)', true);
      skip('otp/verify roundtrip', 'requires a physically paired WhatsApp session on the dev pool');
    } else {
      ok('otp/send fails with typed contract error', false, `status ${r.status}: ${JSON.stringify(r.payload).slice(0, 110)}`);
    }
  } finally {
    // ── cleanup dedicated user + bindings ──
    await pg.query('DELETE FROM user_roles WHERE user_id=$1', [userId]);
    if (userId) await jfetch(`${SURL}/auth/v1/admin/users/${userId}`, {
      method: 'DELETE', headers: { apikey: SERVICE, Authorization: `Bearer ${SERVICE}` }
    });
    await pg.end();
  }

  console.log(`\nRESULT: pass=${pass} fail=${fail} skipped=${skipped}`);
  if (fail > 0) { failures.forEach((f) => console.log(`  - ${f}`)); process.exit(1); }
})().catch((e) => { console.error('LIFECYCLE CRASH:', e.message); process.exit(1); });
