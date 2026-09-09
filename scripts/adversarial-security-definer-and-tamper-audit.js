require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');
const { supabase } = require('../services/supabase');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY || process.env.VITE_SUPABASE_ANON_KEY;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!SUPABASE_URL || !SUPABASE_ANON_KEY || !SERVICE_KEY) {
  console.error('Missing required env variables');
  process.exit(1);
}

const OMAR_STORE_ID = '684ddb71-32d2-4628-852e-ecd9ea68129d';
const BACKEND_URL = 'http://localhost:5599';

async function runAdversarialAudit() {
  console.log('================================================================');
  console.log(' ADVERSARIAL RIGOROUS AUDIT: SECURITY DEFINER & TAMPER RESISTANCE');
  console.log('================================================================\n');

  let allPassed = true;

  // ─────────────────────────────────────────────────────────────
  // SUITE 1: DIRECT RPC PRIVILEGE ENFORCEMENT (SECURITY DEFINER)
  // ─────────────────────────────────────────────────────────────
  console.log('--- SUITE 1: Direct PostgREST RPC Access Tests (Privilege Revocation) ---');

  // 1.1 Anonymous client direct RPC call
  const supabaseAnon = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    auth: { persistSession: false }
  });

  const dummyPayload = {
    p_store_id: OMAR_STORE_ID,
    p_order_id: '00000000-0000-0000-0000-000000000000',
    p_user_id: '10ee570a-688a-4419-84ba-4027ce493f77',
    p_items: [{ id: '00000000-0000-0000-0000-000000000000', qty: 1 }],
    p_refund_method: 'cash',
    p_reason: 'audit-test',
    p_allow_negative_cash: false,
    p_override_reason: null
  };

  const anonRpcResult = await supabaseAnon.rpc('create_pos_return_atomic', dummyPayload);
  const anonBlocked = anonRpcResult.error && (
    anonRpcResult.error.message.includes('permission denied') ||
    anonRpcResult.error.code === '42501' ||
    anonRpcResult.status === 401 ||
    anonRpcResult.status === 403
  );

  console.log('1.1 Anon Direct RPC (create_pos_return_atomic):');
  console.log('    HTTP Status:', anonRpcResult.status);
  console.log('    SQLSTATE:   ', anonRpcResult.error?.code);
  console.log('    Message:    ', anonRpcResult.error?.message);
  console.log('    Evaluation: ', anonBlocked ? 'DENIED (PASS)' : 'ALLOWED (FAIL)');
  if (!anonBlocked) allPassed = false;

  // 1.2 Authenticated cashier direct RPC call
  const jwt = require('jsonwebtoken');
  const cashierUserId = '10ee570a-688a-4419-84ba-4027ce493f77';
  const cashierToken = jwt.sign(
    {
      sub: cashierUserId,
      email: 'cashier_audit_test@omar-store.com',
      role: 'authenticated',
      aud: 'authenticated',
      iss: 'supabase'
    },
    process.env.SUPABASE_JWT_SECRET,
    { expiresIn: '2h' }
  );

  const supabaseCashier = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    global: { headers: { Authorization: `Bearer ${cashierToken}` } },
    auth: { persistSession: false }
  });

  const cashierRpcResult = await supabaseCashier.rpc('create_pos_return_atomic', dummyPayload);
  const cashierBlocked = cashierRpcResult.error && (
    cashierRpcResult.error.message.includes('permission denied') ||
    cashierRpcResult.error.code === '42501' ||
    cashierRpcResult.status === 401 ||
    cashierRpcResult.status === 403
  );

  console.log('\n1.2 Authenticated Cashier Direct RPC (create_pos_return_atomic):');
  console.log('    Cashier Sub:', '10ee570a-688a-4419-84ba-4027ce493f77');
  console.log('    HTTP Status:', cashierRpcResult.status);
  console.log('    SQLSTATE:   ', cashierRpcResult.error?.code);
  console.log('    Message:    ', cashierRpcResult.error?.message);
  console.log('    Evaluation: ', cashierBlocked ? 'DENIED (PASS)' : 'ALLOWED (FAIL)');
  if (!cashierBlocked) allPassed = false;

  // 1.3 Test direct RPC for create_store_staff_atomic
  const cashierStaffRpc = await supabaseCashier.rpc('create_store_staff_atomic', {
    p_store_id: OMAR_STORE_ID,
    p_user_id: cashierUserId,
    p_email: 'hacked@evil.com',
    p_role_name: 'owner'
  });
  const staffRpcBlocked = cashierStaffRpc.error && (
    cashierStaffRpc.error.message.includes('permission denied') ||
    cashierStaffRpc.error.code === '42501'
  );
  console.log('\n1.3 Authenticated Cashier Direct create_store_staff_atomic RPC:');
  console.log('    Status/Code:', cashierStaffRpc.error?.code);
  console.log('    Message:    ', cashierStaffRpc.error?.message);
  console.log('    Evaluation: ', staffRpcBlocked ? 'DENIED (PASS)' : 'ALLOWED (FAIL)');
  if (!staffRpcBlocked) allPassed = false;

  // 1.4 Backend service_role execution is permitted
  // We will prove this live in Suite 2!
  console.log('\n1.4 Service Role Access: Authorized via Backend Server Path.');

  // ─────────────────────────────────────────────────────────────
  // SUITE 2: REFUND PRICE TAMPERING RESISTANCE
  // ─────────────────────────────────────────────────────────────
  console.log('\n--- SUITE 2: Refund Price Tampering Attack Tests ---');

  // Setup: Find or create a test product
  const { data: testProduct, error: prodErr } = await supabase
    .from('products')
    .select('id, name, price, stock_quantity')
    .eq('store_id', OMAR_STORE_ID)
    .gt('stock_quantity', 10)
    .limit(1)
    .single();

  if (prodErr || !testProduct) {
    console.error('No suitable product found for testing:', prodErr?.message);
    process.exit(1);
  }

  const EXACT_PRICE = 550.00;
  console.log(`Setting up test product: ${testProduct.name} (ID: ${testProduct.id})`);

  // Ensure manager PIN is set to 1234
  const crypto = require('crypto');
  const pinHash = crypto.createHash('sha256').update(`${OMAR_STORE_ID}:1234`).digest('hex');
  await supabase.from('stores').update({ pos_manager_pin_hash: pinHash }).eq('id', OMAR_STORE_ID);

  // Close previous shifts and open fresh shift with 1500 EGP drawer cash
  await supabase.from('pos_shifts').update({ status: 'closed', closed_at: new Date().toISOString() }).eq('store_id', OMAR_STORE_ID).eq('status', 'open');

  const { data: shift, error: shiftErr } = await supabase
    .from('pos_shifts')
    .insert({
      store_id: OMAR_STORE_ID,
      cashier_user_id: cashierUserId,
      cashier_name: 'Auditor Cashier',
      opening_cash: 1500,
      cash_sales: 0,
      cash_refunds: 0,
      pay_ins: 0,
      pay_outs: 0,
      card_sales: 0,
      card_refunds: 0,
      total_sales: 0,
      total_refunds: 0,
      status: 'open',
      opened_at: new Date().toISOString()
    })
    .select()
    .single();

  if (shiftErr) {
    console.error('Failed to create test shift:', shiftErr.message);
    process.exit(1);
  }

  // Create Order 1: 1 unit @ 550 EGP
  const orderNumber1 = Math.floor(200000 + Math.random() * 700000);
  const { data: order1, error: ordErr1 } = await supabase
    .from('orders')
    .insert({
      store_id: OMAR_STORE_ID,
      order_number: orderNumber1,
      customer_note: 'Tamper Test Customer 1',
      total: EXACT_PRICE,
      subtotal: EXACT_PRICE,
      status: 'completed',
      items: [
        {
          id: testProduct.id,
          product_id: testProduct.id,
          name: testProduct.name,
          price: EXACT_PRICE,
          unit_price: EXACT_PRICE,
          qty: 1
        }
      ],
      created_at: new Date().toISOString()
    })
    .select()
    .single();

  if (ordErr1) {
    console.error('Failed to create order 1:', ordErr1.message);
    process.exit(1);
  }

  console.log(`Order 1 created: ID=${order1.id}, order_number=${orderNumber1}, item price=${EXACT_PRICE} EGP`);

  // Attack 2.1: Client sends refund price = 1.00
  console.log('\n2.1 Tampering Test: Client attempts under-refund (client sends price = 1.00 EGP)');
  const tamperUnderPayload = {
    order_id: order1.id,
    items: [
      {
        id: testProduct.id,
        qty: 1,
        price: 1.00, // MALICIOUS TAMPERED PRICE
        unit_price: 1.00,
        condition: 'sound'
      }
    ],
    refund_method: 'cash',
    reason: 'Under-refund price tamper attempt'
  };

  const resUnder = await fetch(`${BACKEND_URL}/api/pos/returns`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-store-subdomain': 'omar',
      Authorization: `Bearer ${cashierToken}`
    },
    body: JSON.stringify(tamperUnderPayload)
  });

  const bodyUnder = await resUnder.json();
  const actualRefundUnder = bodyUnder.data?.total_refund;
  console.log('    HTTP Status:      ', resUnder.status);
  console.log('    Client sent price: 1.00 EGP');
  console.log('    Original price:   ', EXACT_PRICE, 'EGP');
  console.log('    Actual refund:    ', actualRefundUnder, 'EGP');
  console.log('    Recorded items:   ', JSON.stringify(bodyUnder.data?.items?.map(i => ({ name: i.name, qty: i.qty, price: i.price }))));

  const underPass = (Number(actualRefundUnder) === EXACT_PRICE);
  console.log('    Evaluation:       ', underPass ? 'PRICE ENFORCED AUTHORITATIVELY AT 550 EGP (PASS)' : 'TAMPER EXPLOITED (FAIL)');
  if (!underPass) allPassed = false;

  // Create Order 2: 1 unit @ 550 EGP
  const orderNumber2 = Math.floor(200000 + Math.random() * 700000);
  const { data: order2, error: ordErr2 } = await supabase
    .from('orders')
    .insert({
      store_id: OMAR_STORE_ID,
      order_number: orderNumber2,
      customer_note: 'Tamper Test Customer 2',
      total: EXACT_PRICE,
      subtotal: EXACT_PRICE,
      status: 'completed',
      items: [
        {
          id: testProduct.id,
          product_id: testProduct.id,
          name: testProduct.name,
          price: EXACT_PRICE,
          unit_price: EXACT_PRICE,
          qty: 1
        }
      ],
      created_at: new Date().toISOString()
    })
    .select()
    .single();

  if (ordErr2) {
    console.error('Failed to create order 2:', ordErr2.message);
    process.exit(1);
  }

  console.log(`\nOrder 2 created: ID=${order2.id}, order_number=${orderNumber2}, item price=${EXACT_PRICE} EGP`);

  // Attack 2.2: Client sends refund price = 999999.00 (Cash siphoning attempt)
  console.log('\n2.2 Tampering Test: Client attempts over-refund / theft (client sends price = 999999.00 EGP)');
  const tamperOverPayload = {
    order_id: order2.id,
    items: [
      {
        id: testProduct.id,
        qty: 1,
        price: 999999.00, // MALICIOUS INFLATED TAMPERED PRICE
        unit_price: 999999.00,
        condition: 'sound'
      }
    ],
    refund_method: 'cash',
    reason: 'Over-refund price tamper attempt'
  };

  const resOver = await fetch(`${BACKEND_URL}/api/pos/returns`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-store-subdomain': 'omar',
      Authorization: `Bearer ${cashierToken}`
    },
    body: JSON.stringify(tamperOverPayload)
  });

  const bodyOver = await resOver.json();
  const actualRefundOver = bodyOver.data?.total_refund;
  console.log('    HTTP Status:      ', resOver.status);
  console.log('    Client sent price: 999999.00 EGP');
  console.log('    Original price:   ', EXACT_PRICE, 'EGP');
  console.log('    Actual refund:    ', actualRefundOver, 'EGP');
  console.log('    Recorded items:   ', JSON.stringify(bodyOver.data?.items?.map(i => ({ name: i.name, qty: i.qty, price: i.price }))));

  const overPass = (Number(actualRefundOver) === EXACT_PRICE);
  console.log('    Evaluation:       ', overPass ? 'PRICE ENFORCED AUTHORITATIVELY AT 550 EGP (PASS)' : 'TAMPER EXPLOITED (FAIL)');
  if (!overPass) allPassed = false;

  // Attack 2.3: Return quantity exceeds original purchased quantity
  console.log('\n2.3 Tampering Test: Client attempts to return qty=5 when only 1 was purchased');
  const tamperQtyPayload = {
    order_id: order2.id,
    items: [
      {
        id: testProduct.id,
        qty: 5,
        condition: 'sound'
      }
    ],
    refund_method: 'cash',
    reason: 'Excessive quantity tamper attempt'
  };

  const resQty = await fetch(`${BACKEND_URL}/api/pos/returns`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-store-subdomain': 'omar',
      Authorization: `Bearer ${cashierToken}`
    },
    body: JSON.stringify(tamperQtyPayload)
  });

  const bodyQty = await resQty.json();
  console.log('    HTTP Status:      ', resQty.status);
  console.log('    Error Code:       ', bodyQty.code);
  console.log('    Error Message:    ', bodyQty.message);
  const qtyPass = (resQty.status === 400 && bodyQty.message.includes('exceeds available purchased quantity'));
  console.log('    Evaluation:       ', qtyPass ? 'QUANTITY CAP ENFORCED (PASS)' : 'QUANTITY EXCEEDED (FAIL)');
  if (!qtyPass) allPassed = false;

  // ─────────────────────────────────────────────────────────────
  // SUITE 3: DETERMINISTIC SINGLE PLAN QUOTAS
  // ─────────────────────────────────────────────────────────────
  console.log('\n--- SUITE 3: Deterministic Single Plan Quota Audit ---');
  const { data: plansWithLimits } = await supabase
    .from('plan_features')
    .select('plan_id, plans(code, display_name, sort_order), features(key), feature_limits(limit_type, limit_config)')
    .in('features.key', ['employees', 'staff_users']);

  const quotaMap = {};
  for (const row of (plansWithLimits || [])) {
    const code = row.plans?.code;
    const feat = row.features?.key;
    const maxVal = row.feature_limits?.[0]?.limit_config?.max_value;
    if (!quotaMap[code]) quotaMap[code] = { name: row.plans?.display_name, sort: row.plans?.sort_order };
    quotaMap[code][feat] = maxVal;
  }

  const sortedPlans = Object.entries(quotaMap).sort((a, b) => a[1].sort - b[1].sort);

  console.log('Plan Code   | Plan Name       | employees quota | staff_users quota | Deterministic Integer?');
  console.log('-----------------------------------------------------------------------------------------');
  for (const [code, info] of sortedPlans) {
    const empVal = info.employees;
    const staffVal = info.staff_users;
    const isSingleInt = Number.isInteger(Number(empVal)) && Number.isInteger(Number(staffVal)) && empVal === staffVal;
    console.log(
      `${code.padEnd(11)} | ${info.name.padEnd(15)} | ${String(empVal).padEnd(15)} | ${String(staffVal).padEnd(17)} | ${isSingleInt ? 'YES (PASS)' : 'NO (FAIL)'}`
    );
    if (!isSingleInt) allPassed = false;
  }

  console.log('\n================================================================');
  console.log(` FINAL VERDICT: ${allPassed ? 'ALL TESTS PASSED WITH RIGOROUS PROOF' : 'AUDIT FAILED'}`);
  console.log('================================================================');

  process.exit(allPassed ? 0 : 1);
}

runAdversarialAudit().catch(err => {
  console.error('Unhandled error in audit:', err);
  process.exit(1);
});
