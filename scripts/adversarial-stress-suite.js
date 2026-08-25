'use strict';

/**
 * ============================================================================
 * EG-PARTS CLOUD — EMPIRICAL ADVERSARIAL STRESS TEST SUITE
 * ============================================================================
 * Comprehensive verification of security boundaries, state machines, and edge cases:
 *   1. Missing & Invalid Auth on Protected API Endpoints
 *   2. Malformed Payloads, Bad Content-Types & Schema Violations
 *   3. Non-Existent Tenants & Subdomain Injection Attack Surface
 *   4. Double-Wallet-Approval Prevention & State Immutability
 *   5. Double-Wallet-Rejection Prevention & Cross-Transition Guards
 *   6. Concurrent Race Condition Stress & Atomicity Verification
 * ============================================================================
 */

const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const http = require('http');

const PORT = 5699;
const BASE = `http://127.0.0.1:${PORT}`;
const LOG_FILE = path.join(require('os').tmpdir(), `egparts-adversarial-${PORT}.log`);

function loadDotEnv() {
  const p = path.join(__dirname, '..', '.env');
  if (!fs.existsSync(p)) return;
  for (const line of fs.readFileSync(p, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^"(.*)"$/, '$1');
  }
}

loadDotEnv();

const results = [];
function assert(name, cond, detail = '') {
  results.push({ name, pass: !!cond, detail });
  console.log(`${cond ? '✅ PASS' : '❌ FAIL'} ${name}${detail ? ' :: ' + detail : ''}`);
}

function rawRequest(method, urlPath, { headers = {}, body = null } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(`${BASE}${urlPath}`, { method, headers }, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => {
        let json = null;
        try { json = JSON.parse(data); } catch { /* non-json */ }
        resolve({ status: res.statusCode, headers: res.headers, body: data, json });
      });
    });
    req.on('error', reject);
    req.setTimeout(15000, () => req.destroy(new Error('request timeout')));
    if (body !== null) req.write(body);
    req.end();
  });
}

async function waitForHealth(timeoutMs = 45000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    try {
      const r = await rawRequest('GET', '/api/health');
      if (r.status === 200) return true;
    } catch { /* waiting for server */ }
    await new Promise((r) => setTimeout(r, 1000));
  }
  return false;
}

async function runAdversarialSuite() {
  console.log('\n================================================================');
  console.log('⚔️  EG-PARTS CLOUD — EMPIRICAL ADVERSARIAL STRESS TEST');
  console.log('================================================================\n');

  // Spawn local server instance
  const child = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
    cwd: path.join(__dirname, '..'),
    env: { ...process.env, PORT: String(PORT) },
    stdio: ['ignore', fs.openSync(LOG_FILE, 'a'), fs.openSync(LOG_FILE, 'a')]
  });

  console.log(`[BOOT] Server process spawned pid=${child.pid} on port ${PORT}...`);
  const healthy = await waitForHealth();
  if (!healthy) {
    console.error('Server failed to start in time.');
    child.kill('SIGKILL');
    process.exit(1);
  }
  console.log('[BOOT] Server healthy. Commencing stress scenarios.\n');

  try {
    // ──────────────────────────────────────────────────────────────────────────
    // SECTION 1: Missing & Invalid Auth on Protected API Endpoints
    // ──────────────────────────────────────────────────────────────────────────
    console.log('─── SECTION 1: Missing & Invalid Auth on Protected API Endpoints ───');

    const authProbes = [
      { name: 'POST /api/orders without auth', method: 'POST', path: '/api/orders', body: '{}' },
      { name: 'POST /api/payments/wallet/approve without auth', method: 'POST', path: '/api/payments/wallet/approve', body: '{}' },
      { name: 'POST /api/payments/wallet/reject without auth', method: 'POST', path: '/api/payments/wallet/reject', body: '{}' },
      { name: 'GET /api/payments/wallet/pending-proofs without auth', method: 'GET', path: '/api/payments/wallet/pending-proofs' },
      { name: 'POST /api/coupons without auth', method: 'POST', path: '/api/coupons', body: '{}' },
      { name: 'GET /api/account/profile without auth', method: 'GET', path: '/api/account/profile' },
      { name: 'POST /api/account/addresses without auth', method: 'POST', path: '/api/account/addresses', body: '{}' },
      { name: 'POST /api/auth/2fa/disable without auth', method: 'POST', path: '/api/auth/2fa/disable', body: '{}' },
      { name: 'POST /api/admin/dashboard without auth', method: 'POST', path: '/api/admin/dashboard', body: '{}' },
    ];

    for (const p of authProbes) {
      const res = await rawRequest(p.method, p.path, {
        headers: {
          'Content-Type': 'application/json',
          'x-store-subdomain': 'egparts'
        },
        body: p.body || null
      });
      assert(
        p.name,
        res.status === 401 && res.json?.success === false && typeof res.json?.requestId === 'string',
        `status=${res.status} code=${res.json?.code || 'none'}`
      );
    }

    // Invalid Token Probe
    const invalidTokenRes = await rawRequest('GET', '/api/account/profile', {
      headers: {
        Authorization: 'Bearer invalid.bogus.jwt.token',
        'x-store-subdomain': 'egparts'
      }
    });
    assert(
      'GET /api/account/profile with bogus Bearer token returns 401',
      invalidTokenRes.status === 401 && invalidTokenRes.json?.success === false,
      `status=${invalidTokenRes.status}`
    );

    // ──────────────────────────────────────────────────────────────────────────
    // SECTION 2: Malformed Payloads, Bad Content-Types & Schema Violations
    // ──────────────────────────────────────────────────────────────────────────
    console.log('\n─── SECTION 2: Malformed Payloads & Bad Content-Types ───');

    // Broken JSON string
    const brokenJson = await rawRequest('POST', '/api/orders', {
      headers: { 'Content-Type': 'application/json', 'x-store-subdomain': 'egparts' },
      body: '{"items": [ {"id": "broken'
    });
    assert(
      'Malformed unparseable JSON returns 400 Bad Request with JSON envelope',
      brokenJson.status === 400 && brokenJson.json?.success === false,
      `status=${brokenJson.status} code=${brokenJson.json?.code}`
    );

    // Unsupported Content-Type on mutation
    const xmlRes = await rawRequest('POST', '/api/orders', {
      headers: { 'Content-Type': 'application/xml', 'x-store-subdomain': 'egparts' },
      body: '<order><item>1</item></order>'
    });
    assert(
      'Unsupported Content-Type application/xml returns 415',
      xmlRes.status === 415 && xmlRes.json?.success === false,
      `status=${xmlRes.status}`
    );

    const textRes = await rawRequest('POST', '/api/orders', {
      headers: { 'Content-Type': 'text/plain', 'x-store-subdomain': 'egparts' },
      body: 'plain-text-payload'
    });
    assert(
      'Unsupported Content-Type text/plain returns 415',
      textRes.status === 415 && textRes.json?.success === false,
      `status=${textRes.status}`
    );

    // Zod Schema Violations on Auth & Address
    const invalidOtpRes = await rawRequest('POST', '/api/auth/send-otp', {
      headers: { 'Content-Type': 'application/json', 'x-store-subdomain': 'egparts' },
      body: JSON.stringify({ phone: 'invalid-phone-string' })
    });
    assert(
      'POST /api/auth/send-otp with invalid phone schema returns 400',
      invalidOtpRes.status === 400 && invalidOtpRes.json?.success === false,
      `status=${invalidOtpRes.status}`
    );

    // ──────────────────────────────────────────────────────────────────────────
    // SECTION 3: Tenant Resolution Boundary & Injection Stress
    // ──────────────────────────────────────────────────────────────────────────
    console.log('\n─── SECTION 3: Tenant Resolution Boundary & Injection Stress ───');

    // Non-existent tenant
    const nonExistent = await rawRequest('GET', '/api/products', {
      headers: { 'x-store-subdomain': 'non-existent-tenant-xyz-999' }
    });
    assert(
      'Non-existent tenant subdomain returns 404 Store Not Found',
      nonExistent.status === 404 && nonExistent.json?.success === false,
      `status=${nonExistent.status} msg="${nonExistent.json?.message}"`
    );

    // Malformed & Injection Subdomains
    const injectionSubdomains = [
      { name: 'SQL Injection in subdomain', sub: "'; DROP TABLE stores; --" },
      { name: 'Path Traversal in subdomain', sub: '../../../../etc/passwd' },
      { name: 'XSS script injection in subdomain', sub: '<script>alert(1)</script>' },
      { name: 'Consecutive dots in subdomain', sub: 'store..invalid' },
      { name: 'Leading hyphen in subdomain', sub: '-invalidstore' },
      { name: 'Whitespace injection in subdomain', sub: 'store with spaces' }
    ];

    for (const inj of injectionSubdomains) {
      const injRes = await rawRequest('GET', '/api/products', {
        headers: { 'x-store-subdomain': inj.sub }
      });
      assert(
        inj.name,
        injRes.status === 400 && injRes.json?.code === 'INVALID_TENANT_IDENTIFIER',
        `status=${injRes.status} code=${injRes.json?.code}`
      );
    }

    // ──────────────────────────────────────────────────────────────────────────
    // SECTION 4: State Machine — Concurrency, Double-Approval & Double-Rejection
    // ──────────────────────────────────────────────────────────────────────────
    console.log('\n─── SECTION 4: State Machine: Concurrency & Double-Action Guards ───');

    const { createClient } = require('@supabase/supabase-js');
    const admin = createClient(
      process.env.SUPABASE_URL,
      process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY,
      { auth: { persistSession: false } }
    );

    // Mint Admin and Customer credentials with isolated lifecycle
    const adminEmail = `stress-admin-${Date.now()}@dev.local`;
    const adminPass = `E2e_A_${Math.random().toString(36).slice(2, 12)}!x`;
    const { data: createdAdmin } = await admin.auth.admin.createUser({
      email: adminEmail, password: adminPass, email_confirm: true, user_metadata: { full_name: 'Stress Store Admin' }
    });
    const adminUser = createdAdmin.user;

    const PLATFORM_STORE = '00000000-0000-0000-0000-000000000000';
    const { data: ownerTemplate } = await admin
      .from('roles')
      .select('id')
      .eq('role_type', 'tenant_template')
      .eq('name', 'owner')
      .maybeSingle();

    await admin.from('user_roles').upsert(
      { user_id: adminUser.id, store_id: PLATFORM_STORE, role_id: ownerTemplate.id },
      { onConflict: 'user_id,store_id,role_id' }
    );
    await admin.from('store_admins').upsert(
      { user_id: adminUser.id, store_id: PLATFORM_STORE },
      { onConflict: 'user_id,store_id,role_id' }
    );

    const anonKey = process.env.VITE_SUPABASE_ANON_KEY || process.env.SUPABASE_ANON_KEY;
    const adminSess = await fetch(`${process.env.SUPABASE_URL}/auth/v1/token?grant_type=password`, {
      method: 'POST',
      headers: { apikey: anonKey, Authorization: `Bearer ${anonKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: adminEmail, password: adminPass })
    }).then((r) => r.json());
    const adminToken = adminSess.access_token;

    const custEmail = `stress-cust-${Date.now()}@dev.local`;
    const custPass = `StressPass123!${Date.now()}`;
    await admin.auth.admin.createUser({ email: custEmail, password: custPass, email_confirm: true });
    const custSess = await fetch(`${process.env.SUPABASE_URL}/auth/v1/token?grant_type=password`, {
      method: 'POST',
      headers: { apikey: anonKey, Authorization: `Bearer ${anonKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: custEmail, password: custPass })
    }).then((r) => r.json());
    const customerToken = custSess.access_token;

    // Ensure manual wallet is enabled
    await rawRequest('PUT', '/api/payments/wallet/settings', {
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${adminToken}`,
        'x-store-subdomain': 'egparts'
      },
      body: JSON.stringify({
        is_active: true,
        wallets: [
          { provider: 'vodafone_cash', number: '01000000000', label: 'E2E Wallet', enabled: true }
        ]
      })
    });

    // Get active product
    const { data: storeRow } = await admin.from('stores').select('id, subdomain').eq('subdomain', 'egparts').maybeSingle();
    let { data: prod } = await admin.from('products').select('id, name, price, stock_quantity')
      .eq('store_id', storeRow.id).eq('is_active', true).eq('is_deleted', false).gt('stock_quantity', 0).limit(1).maybeSingle();
    if (!prod) {
      const { data: createdProd } = await admin.from('products').insert({
        store_id: storeRow.id,
        name: 'Stress Test Brake Pad',
        price: 200,
        stock_quantity: 100,
        category: 'Brakes',
        is_active: true,
        is_deleted: false
      }).select('id, name, price, stock_quantity').single();
      prod = createdProd;
    }

    const STORE = storeRow.subdomain || 'egparts';

    // Helper: Create an order, initiate intent, and submit proof
    async function createOrderWithProof(tag) {
      const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
      const ordRes = await rawRequest('POST', '/api/orders', {
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${customerToken}`,
          'x-store-subdomain': STORE
        },
        body: JSON.stringify({
          items: [{ id: prod.id, qty: 1, name: prod.name, price: prod.price }],
          paymentMethod: 'manual_wallet',
          idempotencyKey: `stress-ord-${tag}-${stamp}`,
          phone: '01000000000',
          city: 'Cairo',
          address: 'Stress Test Address'
        })
      });
      const orderId = ordRes.json?.data?.orderId || ordRes.json?.orderId;

      const initRes = await rawRequest('POST', '/api/payments/wallet/initiate', {
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${customerToken}`,
          'x-store-subdomain': STORE
        },
        body: JSON.stringify({ order_id: orderId })
      });
      const intentId = initRes.json?.data?.intentId || initRes.json?.data?.intent_id || initRes.json?.data?.intent?.id;

      const infoRes = await rawRequest('GET', '/api/payments/wallet/info', {
        headers: { 'x-store-subdomain': STORE }
      });
      const walletId = infoRes.json?.data?.wallets?.[0]?.id;

      const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
      const fd = new FormData();
      fd.append('receipt', new Blob([png], { type: 'image/png' }), `proof-stress-${stamp}.png`);
      if (intentId) fd.append('intent_id', intentId);
      if (walletId) fd.append('wallet_id', walletId);

      const sp = await fetch(`${BASE}/api/payments/wallet/submit-proof`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${customerToken}`, 'x-store-subdomain': STORE },
        body: fd
      });
      const spJson = await sp.json().catch(() => null);

      return { orderId, intentId, walletId, proofSubmitted: sp.status === 200 || sp.status === 201 };
    }

    // --- Scenario A: Double-Approval & Rejection on Approved Intent ---
    console.log('\n[Scenario A] Double-Approval and Reject-After-Approve Guard:');
    const flowA = await createOrderWithProof('double-app');
    assert('Scenario A: Order + proof generated', flowA.proofSubmitted && !!flowA.intentId, `intentId=${flowA.intentId}`);

    const approve1 = await rawRequest('POST', '/api/payments/wallet/approve', {
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${adminToken}`,
        'x-store-subdomain': STORE
      },
      body: JSON.stringify({ intent_id: flowA.intentId, reason: 'Initial legitimate approval' })
    });
    assert('First approval succeeds (200 OK)', approve1.status === 200, `status=${approve1.status}`);

    const approve2 = await rawRequest('POST', '/api/payments/wallet/approve', {
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${adminToken}`,
        'x-store-subdomain': STORE
      },
      body: JSON.stringify({ intent_id: flowA.intentId, reason: 'Illegal second approval' })
    });
    assert('Second sequential approval is strictly refused (400 Bad Request)', approve2.status === 400, `status=${approve2.status}`);

    const rejectAfterApprove = await rawRequest('POST', '/api/payments/wallet/reject', {
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${adminToken}`,
        'x-store-subdomain': STORE
      },
      body: JSON.stringify({ intent_id: flowA.intentId, reason: 'Illegal reject after approval' })
    });
    assert('Reject on already-approved intent is refused (400 Bad Request)', rejectAfterApprove.status === 400, `status=${rejectAfterApprove.status}`);

    // Verify order state
    const { data: orderA } = await admin.from('orders').select('payment_status, status').eq('id', flowA.orderId).single();
    assert('Order A remains paid and confirmed', orderA.payment_status === 'paid' && orderA.status === 'confirmed', `status=${orderA.status}`);

    // --- Scenario B: Double-Rejection & Approve on Rejected Intent ---
    console.log('\n[Scenario B] Double-Rejection and Approve-After-Reject Guard:');
    const flowB = await createOrderWithProof('double-rej');
    assert('Scenario B: Order + proof generated', flowB.proofSubmitted && !!flowB.intentId, `intentId=${flowB.intentId}`);

    const reject1 = await rawRequest('POST', '/api/payments/wallet/reject', {
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${adminToken}`,
        'x-store-subdomain': STORE
      },
      body: JSON.stringify({ intent_id: flowB.intentId, reason: 'Initial legitimate rejection' })
    });
    assert('First rejection succeeds (200 OK)', reject1.status === 200, `status=${reject1.status}`);

    const reject2 = await rawRequest('POST', '/api/payments/wallet/reject', {
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${adminToken}`,
        'x-store-subdomain': STORE
      },
      body: JSON.stringify({ intent_id: flowB.intentId, reason: 'Illegal second rejection' })
    });
    assert('Second sequential rejection is strictly refused (400 Bad Request)', reject2.status === 400, `status=${reject2.status}`);

    const approveAfterReject = await rawRequest('POST', '/api/payments/wallet/approve', {
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${adminToken}`,
        'x-store-subdomain': STORE
      },
      body: JSON.stringify({ intent_id: flowB.intentId, reason: 'Illegal approve after reject' })
    });
    assert('Approve on already-rejected intent is refused (400 Bad Request)', approveAfterReject.status === 400, `status=${approveAfterReject.status}`);

    // Verify order state
    const { data: orderB } = await admin.from('orders').select('payment_status, status').eq('id', flowB.orderId).single();
    assert('Order B remains payment_failed / cancelled', ['failed', 'unpaid', 'cancelled'].includes(orderB.payment_status) || orderB.status === 'cancelled', `status=${orderB.status}, payment=${orderB.payment_status}`);

    // --- Scenario C: Concurrency Stress & Atomicity Verification ---
    console.log('\n[Scenario C] Concurrency Stress & Atomicity Verification:');
    const flowC = await createOrderWithProof('race-app');
    assert('Scenario C: Order + proof generated', flowC.proofSubmitted && !!flowC.intentId, `intentId=${flowC.intentId}`);

    // Spawn 5 simultaneous approval requests in parallel
    const parallelApprovals = await Promise.all([
      rawRequest('POST', '/api/payments/wallet/approve', {
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${adminToken}`, 'x-store-subdomain': STORE },
        body: JSON.stringify({ intent_id: flowC.intentId, reason: 'Parallel App 1' })
      }),
      rawRequest('POST', '/api/payments/wallet/approve', {
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${adminToken}`, 'x-store-subdomain': STORE },
        body: JSON.stringify({ intent_id: flowC.intentId, reason: 'Parallel App 2' })
      }),
      rawRequest('POST', '/api/payments/wallet/approve', {
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${adminToken}`, 'x-store-subdomain': STORE },
        body: JSON.stringify({ intent_id: flowC.intentId, reason: 'Parallel App 3' })
      }),
      rawRequest('POST', '/api/payments/wallet/approve', {
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${adminToken}`, 'x-store-subdomain': STORE },
        body: JSON.stringify({ intent_id: flowC.intentId, reason: 'Parallel App 4' })
      }),
      rawRequest('POST', '/api/payments/wallet/approve', {
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${adminToken}`, 'x-store-subdomain': STORE },
        body: JSON.stringify({ intent_id: flowC.intentId, reason: 'Parallel App 5' })
      }),
    ]);

    // All parallel calls must succeed gracefully or return 400 without crashing/500
    const non500 = parallelApprovals.every(r => r.status === 200 || r.status === 400);
    assert('Parallel approval storm completed with 0 server crashes/500s', non500, `statuses=${parallelApprovals.map(r => r.status).join(',')}`);

    // Check that outbox has exactly ONE outbox event created for this intent (atomicity check)
    const { data: outboxRows } = await admin
      .from('payment_outbox')
      .select('id, idempotency_key')
      .eq('idempotency_key', `payment:${flowC.intentId}:captured`);

    assert('Outbox contains exactly ONE payment_confirmed event (idempotency key held)', outboxRows?.length === 1, `count=${outboxRows?.length}`);

    // And subsequent request after race is strictly 400
    const postRaceApprove = await rawRequest('POST', '/api/payments/wallet/approve', {
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${adminToken}`, 'x-store-subdomain': STORE },
      body: JSON.stringify({ intent_id: flowC.intentId, reason: 'Post-race approve' })
    });
    assert('Post-race approval attempt is rejected (400 Bad Request)', postRaceApprove.status === 400, `status=${postRaceApprove.status}`);

  } finally {
    console.log('\n[SHUTDOWN] Terminating server instance pid=' + child.pid);
    child.kill('SIGKILL');
  }

  const failed = results.filter(r => !r.pass);
  console.log('\n================================================================');
  console.log(`🏁 ADVERSARIAL STRESS SUITE RESULT: ${results.length - failed.length}/${results.length} PASSED`);
  console.log('================================================================\n');

  if (failed.length > 0) {
    console.error(`❌ ${failed.length} ADVERSARIAL CHALLENGES FAILED:`);
    for (const f of failed) {
      console.error(`  - ${f.name} (${f.detail})`);
    }
    process.exit(1);
  } else {
    console.log('🎉 ALL ADVERSARIAL CHALLENGES EMPIRICALLY PASSED WITH ZERO FLAWS.');
    process.exit(0);
  }
}

runAdversarialSuite().catch((err) => {
  console.error('Adversarial suite crashed:', err);
  process.exit(1);
});
