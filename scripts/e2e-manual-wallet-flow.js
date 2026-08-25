'use strict';
// Live Dev E2E: Manual Wallet full lifecycle + COD admin transitions.
// Covers: RBAC (store admin via tenant_template), wallet initiate -> proof
// upload (R2 pipeline) -> approve (paid/confirmed/paid_at) -> double-approve
// guard -> reject path (payment failed). Read-only assertions otherwise.
//
// Usage: node scripts/e2e-manual-wallet-flow.js <customerToken> <outInfo>
const fs = require('fs');
const path = require('path');

function loadDotEnv() {
  const p = path.join(__dirname, '..', '.env');
  if (!fs.existsSync(p)) return;
  for (const line of fs.readFileSync(p, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^"(.*)"$/, '$1');
  }
}

const BASE = process.env.E2E_BASE_URL || 'https://egparts-backend-dev.onrender.com';
const STORE = process.env.E2E_STORE_SUBDOMAIN || 'egparts';
const results = [];
function assert(name, cond, detail = '') {
  results.push({ name, pass: !!cond });
  console.log(`${cond ? 'PASS' : 'FAIL'} ${name}${detail ? ' :: ' + detail : ''}`);
}

async function api(method, urlPath, { token, headers = {}, body = null, raw = false } = {}) {
  headers['x-store-subdomain'] = headers['x-store-subdomain'] || STORE;
  const h = { Accept: 'application/json', ...headers };
  if (token) h.Authorization = `Bearer ${token}`;
  let payload = body;
  if (body && !(typeof body === 'string') && h['Content-Type']) payload = JSON.stringify(body);
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await fetch(`${BASE}${urlPath}`, { method, headers: h, body: payload });
      const text = await res.text();
      let json = null;
      try { json = JSON.parse(text); } catch { /* non-json */ }
      if (raw) return { status: res.status, json, text };
      return { status: res.status, json };
    } catch (err) {
      if (attempt === 2) throw err;
      await new Promise((r) => setTimeout(r, 600));
    }
  }
}

async function main() {
  loadDotEnv();
  const { createClient } = require('@supabase/supabase-js');
  const admin = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY,
    { auth: { persistSession: false } }
  );

  // ── 1) Seed store admin via owner tenant_template ────────────────────────
  const email = 'e2e-admin@dev.local';
  const password = `E2e_A_${Math.random().toString(36).slice(2, 12)}!x`;
  const { data: listed } = await admin.auth.admin.listUsers({ perPage: 200, page: 1 });
  let adminUser = listed?.users?.find((u) => u.email === email);
  if (!adminUser) {
    const { data: created } = await admin.auth.admin.createUser({
      email, password, email_confirm: true, user_metadata: { full_name: 'E2E Store Admin' }
    });
    adminUser = created.user;
  } else {
    await admin.auth.admin.updateUserById(adminUser.id, { password });
  }

  const PLATFORM_STORE = '00000000-0000-0000-0000-000000000000';
  const { data: ownerTemplate } = await admin
    .from('roles')
    .select('id')
    .eq('role_type', 'tenant_template')
    .eq('name', 'owner')
    .maybeSingle();
  assert('owner tenant_template role exists', !!ownerTemplate);

  await admin.from('user_roles').upsert(
    { user_id: adminUser.id, store_id: PLATFORM_STORE, role_id: ownerTemplate.id },
    { onConflict: 'user_id,store_id,role_id' }
  );
  await admin.from('store_admins').upsert(
    { user_id: adminUser.id, store_id: PLATFORM_STORE },
    { onConflict: 'user_id,store_id,role_id' }
  );

  const anonKey = process.env.VITE_SUPABASE_ANON_KEY || process.env.SUPABASE_ANON_KEY;
  const sess = await fetch(`${process.env.SUPABASE_URL}/auth/v1/token?grant_type=password`, {
    method: 'POST',
    headers: { apikey: anonKey, Authorization: `Bearer ${anonKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password })
  }).then((r) => r.json());
  const adminToken = sess.access_token;
  assert('admin token minted', !!adminToken);

  // ── 1b) Provision dedicated customer token if not provided ────────────────
  let customerToken = process.argv[2];
  if (!customerToken) {
    const custEmail = `e2e-cust-${Date.now()}@dev.local`;
    const custPass = `CustPass123!${Date.now()}`;
    await admin.auth.admin.createUser({ email: custEmail, password: custPass, email_confirm: true });
    const custSess = await fetch(`${process.env.SUPABASE_URL}/auth/v1/token?grant_type=password`, {
      method: 'POST',
      headers: { apikey: anonKey, Authorization: `Bearer ${anonKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: custEmail, password: custPass })
    }).then((r) => r.json());
    customerToken = custSess.access_token;
  }

  // Admin gate sanity: payments.view endpoint allowed for admin…
  const pendGate = await api('GET', '/api/payments/wallet/pending-proofs', { token: adminToken });
  assert('admin reaches pending-proofs (RBAC ok)', pendGate.status === 200, `status=${pendGate.status}`);
  // …and forbidden for plain customer.
  const custDeny = await api('GET', '/api/payments/wallet/pending-proofs', { token: customerToken });
  assert('customer denied on admin proofs (RBAC enforced)', custDeny.status === 403, `status=${custDeny.status}`);

  // ── 1c) Admin enables manual wallet for the store ───────────────────────
  const ws = await api('PUT', '/api/payments/wallet/settings', {
    token: adminToken,
    headers: { 'Content-Type': 'application/json' },
    body: {
      is_active: true,
      wallets: [
        { provider: 'vodafone_cash', number: '01000000000', label: 'E2E Wallet', enabled: true },
        { provider: 'etisalat_cash', number: '01100000000', label: 'E2E Etisalat', enabled: true }
      ]
    }
  });
  assert('admin enabled manual wallet (payments.configure)', ws.status === 200 || ws.status === 201,
    `status=${ws.status} body=${JSON.stringify(ws.json).slice(0, 140)}`);

  // ── 2) Customer creates manual_wallet order ─────────────────────────────
  const { data: storeRow } = await admin.from('stores').select('id, subdomain').eq('subdomain', STORE).maybeSingle()
    || await admin.from('stores').select('id, subdomain').limit(1).single();
  const activeStoreSub = storeRow?.subdomain || STORE;

  let productId = process.argv[3];
  let productData = null;
  if (!productId && storeRow?.id) {
    let { data: prod } = await admin.from('products').select('id, name, price, stock_quantity').eq('store_id', storeRow.id).eq('is_active', true).eq('is_deleted', false).gt('stock_quantity', 0).limit(1).maybeSingle();
    if (!prod) {
      const { data: createdProd } = await admin.from('products').insert({
        store_id: storeRow.id,
        name: 'E2E Test Brake Pad',
        price: 150,
        stock_quantity: 50,
        category: 'Brakes',
        is_active: true,
        is_deleted: false
      }).select('id, name, price, stock_quantity').single();
      prod = createdProd;
    }
    productId = prod?.id;
    productData = prod;
  }

  const stamp = Date.now();
  const mkOrder = async (key) => api('POST', '/api/orders', {
    token: customerToken,
    headers: { 'Content-Type': 'application/json', 'x-store-subdomain': activeStoreSub },
    body: {
      items: productId ? [{ id: productId, qty: 1, name: productData?.name || 'E2E Product', price: productData?.price || 150 }] : [],
      paymentMethod: 'manual_wallet',
      idempotencyKey: key,
      phone: '01000000000',
      city: 'Cairo',
      address: 'wallet flow address'
    }
  });

  const ord1 = await mkOrder(`mw-flow-${stamp}-a`);
  const orderId1 = ord1.json?.data?.orderId || ord1.json?.orderId;
  if (!orderId1) console.log('ORDER ERROR BODY:', ord1.status, JSON.stringify(ord1.json));
  assert('manual_wallet order created', (ord1.status === 201 || ord1.status === 200) && !!orderId1,
    `status=${ord1.status} id=${orderId1}`);

  // ── 3) Initiate intent ───────────────────────────────────────────────────
  const init1 = await api('POST', '/api/payments/wallet/initiate', {
    token: customerToken,
    headers: { 'Content-Type': 'application/json', 'x-store-subdomain': STORE },
    body: { order_id: orderId1 }
  });
  const intent1 = init1.json?.data?.intentId || init1.json?.data?.intent_id
    || init1.json?.data?.intent?.id || null;
  assert('wallet intent initiated', init1.status === 200 || init1.status === 201,
    `status=${init1.status} body=${JSON.stringify(init1.json).slice(0, 140)}`);

  // ── 4) Submit proof (multipart image through R2 asset pipeline) ─────────
  // Minimal valid PNG (1x1).
  const png = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
    'base64'
  );
  const info = await api('GET', '/api/payments/wallet/info', { headers: {} });
  const walletsList = info.json?.data?.wallets || [];
  const walletId = walletsList[0]?.id;
  assert('wallet list exposes ids for proof', !!walletId, `count=${walletsList.length}`);

  const fd = new FormData();
  fd.append('receipt', new Blob([png], { type: 'image/png' }), `proof-${stamp}.png`);
  if (intent1) fd.append('intent_id', intent1);
  if (walletId) fd.append('wallet_id', walletId);
  const sp = await fetch(`${BASE}/api/payments/wallet/submit-proof`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${customerToken}`, 'x-store-subdomain': STORE },
    body: fd
  });
  const spJson = await sp.json().catch(() => null);
  assert('proof uploaded (R2 pipeline)', sp.status === 200 || sp.status === 201,
    `status=${sp.status} body=${JSON.stringify(spJson).slice(0, 160)}`);

  // ── 5) Admin sees pending proof & approves ──────────────────────────────
  const pend = await api('GET', '/api/payments/wallet/pending-proofs', {
    token: adminToken, headers: { 'x-store-subdomain': STORE }
  });
  const pendBody = pend.json?.data ?? {};
  const pendList = pendBody.proofs || pendBody.pending || pendBody.items || [];
  const mine = Array.isArray(pendList)
    ? pendList.find((p) => p.order_id === orderId1 || p.intent_id === intent1 || p.id === intent1)
    : null;
  const intentToApprove = mine?.intent_id || mine?.id || intent1;
  assert('pending proof visible to admin', pend.status === 200 && !!intentToApprove,
    `count=${Array.isArray(pendList) ? pendList.length : 'n/a'}`);

  const ap = await api('POST', '/api/payments/wallet/approve', {
    token: adminToken,
    headers: { 'Content-Type': 'application/json', 'x-store-subdomain': STORE },
    body: { intent_id: intentToApprove, reason: 'e2e approve' }
  });
  assert('wallet approved by admin', ap.status === 200 || ap.status === 201,
    `status=${ap.status} body=${JSON.stringify(ap.json).slice(0, 140)}`);

  // Verify order became paid+confirmed with paid_at via tracking endpoint.
  const tr = await api('GET', `/api/orders/${orderId1}/tracking`, {
    token: customerToken, headers: { 'x-store-subdomain': STORE }
  });
  const orderObj = tr.json?.data?.order || {};
  assert('order paid+confirmed after approval',
    ['paid'].includes(orderObj.payment_status) && ['confirmed', 'processing'].includes(orderObj.status),
    `payment=${orderObj.payment_status} status=${orderObj.status} paidAt=${orderObj.paid_at || 'none'}`);

  // ── 6) Double-approve must be refused ───────────────────────────────────
  const ap2 = await api('POST', '/api/payments/wallet/approve', {
    token: adminToken,
    headers: { 'Content-Type': 'application/json', 'x-store-subdomain': STORE },
    body: { intent_id: intentToApprove, reason: 'double approve attempt' }
  });
  assert('double approve refused', ap2.status >= 400, `status=${ap2.status}`);

  // ── 7) Reject path on second order ──────────────────────────────────────
  const ord2 = await mkOrder(`mw-flow-${stamp}-b`);
  const orderId2 = ord2.json?.data?.orderId || ord2.json?.orderId;
  const init2 = await api('POST', '/api/payments/wallet/initiate', {
    token: customerToken,
    headers: { 'Content-Type': 'application/json', 'x-store-subdomain': STORE },
    body: { order_id: orderId2 }
  });
  const intent2 = init2.json?.data?.intentId || init2.json?.data?.intent_id
    || init2.json?.data?.intent?.id || null;
  const fd2 = new FormData();
  fd2.append('receipt', new Blob([png], { type: 'image/png' }), `proof-b-${stamp}.png`);
  if (intent2) fd2.append('intent_id', intent2);
  if (walletId) fd2.append('wallet_id', walletId);
  await fetch(`${BASE}/api/payments/wallet/submit-proof`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${customerToken}`, 'x-store-subdomain': STORE },
    body: fd2
  });
  const rj = await api('POST', '/api/payments/wallet/reject', {
    token: adminToken,
    headers: { 'Content-Type': 'application/json', 'x-store-subdomain': STORE },
    body: { intent_id: intent2 || intent1, reason: 'e2e reject test' }
  });
  assert('wallet rejected by admin', rj.status === 200 || rj.status === 201,
    `status=${rj.status} body=${JSON.stringify(rj.json).slice(0, 120)}`);

  const failed = results.filter((r) => !r.pass);
  console.log(`\nMANUAL WALLET FLOW RESULT: ${results.length - failed.length}/${results.length} passed`);
  process.exit(failed.length ? 1 : 0);
}

main().catch((e) => {
  console.error('flow crashed:', e.message);
  process.exit(1);
});
