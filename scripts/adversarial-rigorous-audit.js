'use strict';

/**
 * ==============================================================================
 *   ADVERSARIAL RIGOROUS AUDIT & MATHEMATICAL VERIFICATION SUITE
 * ==============================================================================
 * Target: http://localhost:5599 (Live Running Platform API)
 *
 * Suites:
 *  1. RBAC Endpoint Matrix (Live HTTP Requests: 403 on admin, 200 on POS)
 *  2. POS Identity & Tamper-Proofing (Body injection strip, cross-tenant barrier, JWT auth)
 *  3. Concurrency / Race Condition on Staff Quota (10 simultaneous requests against FOR UPDATE lock)
 *  4. Cash Drawer Safety & Manager Override (Insufficient cash rejected 400, PIN verified 403/200, zero pay_outs)
 *  5. Complete GPS Path & Zero-Fallback Elimination (Reverse geocode, out-of-coverage 400, outside Egypt 400)
 *  6. Staff Lifecycle & Deactivation (Invite -> Active 200 -> Deactivate 403 -> Reactivate 200)
 */

const path = require('path');
const assert = require('assert');
const jwt = require('jsonwebtoken');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const { supabase } = require('../services/supabase');
const shippingZoneEngine = require('../services/location/shippingZoneEngine');

const BASE_URL = process.env.API_URL || 'http://localhost:5599';
const STORE_OMAR_ID = '684ddb71-32d2-4628-852e-ecd9ea68129d';
const STORE_OMAR_SUBDOMAIN = 'omar';
const OWNER_AUTH_ID = '504afdcc-b963-4f27-b41e-8a5d346afd9d';
const OWNER_EMAIL = 'marshmallowoma@gmai.com';
const CASHIER_EMAIL = 'cashier_audit_test@omar-store.com';

function makeToken(userId, email, role = 'authenticated') {
  return jwt.sign(
    {
      sub: userId,
      email: email,
      role: role,
      aud: 'authenticated',
      iss: 'supabase'
    },
    process.env.SUPABASE_JWT_SECRET,
    { expiresIn: '2h' }
  );
}

const ownerToken = makeToken(OWNER_AUTH_ID, OWNER_EMAIL);

async function run() {
  console.log('\n================================================================');
  console.log('  ADVERSARIAL RIGOROUS AUDIT & VERIFICATION SUITE              ');
  console.log('================================================================');
  console.log(`Live Server Endpoint: ${BASE_URL}`);
  console.log(`Store Under Test:     ${STORE_OMAR_SUBDOMAIN} (${STORE_OMAR_ID})`);
  console.log(`Store Owner Auth ID:  ${OWNER_AUTH_ID}`);
  console.log('----------------------------------------------------------------\n');

  // Ensure Cashier exists in DB
  let cashierAuthId = null;
  const { data: staffRow } = await supabase
    .from('store_staff')
    .select('user_id')
    .eq('invited_email', CASHIER_EMAIL)
    .eq('store_id', STORE_OMAR_ID)
    .maybeSingle();

  if (staffRow?.user_id) {
    cashierAuthId = staffRow.user_id;
  } else {
    const { data: cashierUsers } = await supabase.auth.admin.listUsers({ perPage: 1000, page: 1 });
    cashierAuthId = cashierUsers?.users?.find(u => u.email?.toLowerCase() === CASHIER_EMAIL.toLowerCase())?.id;
  }

  if (!cashierAuthId) {
    const { data: newCashier, error: cErr } = await supabase.auth.admin.createUser({
      email: CASHIER_EMAIL,
      password: 'AuditCashier123!',
      email_confirm: true,
      user_metadata: { full_name: 'كاشير التدقيق الصارم', store_id: STORE_OMAR_ID, role: 'cashier' }
    });
    if (cErr) throw cErr;
    cashierAuthId = newCashier.user.id;
  }

  // Ensure role cashier in user_roles and store_staff
  const { data: cashierRole } = await supabase
    .from('roles')
    .select('id')
    .eq('name', 'cashier')
    .order('created_at', { ascending: true })
    .limit(1)
    .single();

  await supabase.from('user_roles').upsert({
    user_id: cashierAuthId,
    store_id: STORE_OMAR_ID,
    role_id: cashierRole.id
  }, { onConflict: 'user_id,store_id,role_id' });

  await supabase.from('store_staff').upsert({
    store_id: STORE_OMAR_ID,
    user_id: cashierAuthId,
    role_id: cashierRole.id,
    role_name: 'cashier',
    invited_email: CASHIER_EMAIL,
    is_active: true
  }, { onConflict: 'store_id,user_id' });

  const cashierToken = makeToken(cashierAuthId, CASHIER_EMAIL);
  console.log(`[OK] [Setup] Cashier Auth ID: ${cashierAuthId}`);
  console.log(`[OK] [Setup] Cashier Token & DB membership verified.\n`);

  // ============================================================================
  // SUITE 1: RBAC ENDPOINT MATRIX (LIVE HTTP CALLS)
  // ============================================================================
  console.log('================================================================');
  console.log('  [SUITE 1] RBAC ENDPOINT MATRIX (LIVE HTTP VERIFICATION)      ');
  console.log('================================================================');

  const rbacCases = [
    {
      name: 'Cashier -> POST /api/admin/products',
      url: `${BASE_URL}/api/admin/products`,
      method: 'POST',
      body: { name: 'Exploit Product', price: 999 },
      expectedStatus: 403,
      expectedCode: 'CASHIER_SCOPE_RESTRICTED'
    },
    {
      name: 'Cashier -> GET /api/admin/settings',
      url: `${BASE_URL}/api/admin/settings`,
      method: 'GET',
      expectedStatus: 403,
      expectedCode: 'CASHIER_SCOPE_RESTRICTED'
    },
    {
      name: 'Cashier -> POST /api/staff/invite',
      url: `${BASE_URL}/api/staff/invite`,
      method: 'POST',
      body: { email: 'fake_invite@test.com', role_name: 'admin' },
      expectedStatus: 403,
      expectedCode: 'CASHIER_SCOPE_RESTRICTED'
    },
    {
      name: 'Cashier -> POST /api/admin/dashboard',
      url: `${BASE_URL}/api/admin/dashboard`,
      method: 'POST',
      body: { period: '30d' },
      expectedStatus: 403,
      expectedCode: 'CASHIER_SCOPE_RESTRICTED'
    },
    {
      name: 'Cashier -> GET /api/coupons',
      url: `${BASE_URL}/api/coupons`,
      method: 'GET',
      expectedStatus: 403,
      expectedCode: 'CASHIER_SCOPE_RESTRICTED'
    },
    {
      name: 'Cashier -> GET /api/admin/banners',
      url: `${BASE_URL}/api/admin/banners`,
      method: 'GET',
      expectedStatus: 403,
      expectedCode: 'CASHIER_SCOPE_RESTRICTED'
    },
    {
      name: 'Cashier -> GET /api/pos/shifts/current',
      url: `${BASE_URL}/api/pos/shifts/current`,
      method: 'GET',
      expectedStatus: 200,
      expectedCode: null
    },
    {
      name: 'Cashier -> GET /api/pos/products',
      url: `${BASE_URL}/api/pos/products?search=`,
      method: 'GET',
      expectedStatus: 200,
      expectedCode: null
    }
  ];

  const rbacResults = [];
  for (const tc of rbacCases) {
    const res = await fetch(tc.url, {
      method: tc.method,
      headers: {
        'Authorization': `Bearer ${cashierToken}`,
        'x-store-subdomain': STORE_OMAR_SUBDOMAIN,
        'Content-Type': 'application/json'
      },
      body: tc.body ? JSON.stringify(tc.body) : undefined
    });
    const json = await res.json().catch(() => ({}));
    const passed = res.status === tc.expectedStatus && (!tc.expectedCode || json.code === tc.expectedCode);

    rbacResults.push({
      Endpoint: tc.name,
      'Actual HTTP': res.status,
      'Expected HTTP': tc.expectedStatus,
      'Error Code': json.code || (res.status === 200 ? 'SUCCESS' : 'NONE'),
      Verdict: passed ? 'PASSED [OK]' : 'FAILED [X]'
    });

    assert.strictEqual(res.status, tc.expectedStatus, `${tc.name} must return HTTP ${tc.expectedStatus}`);
    if (tc.expectedCode && tc.expectedStatus === 403) {
      assert.strictEqual(json.code, tc.expectedCode, `${tc.name} must return error code ${tc.expectedCode}`);
    }
  }

  console.table(rbacResults);
  console.log('[PASSED] SUITE 1: Strict cashier perimeter confirmed across all admin endpoints.\n');

  // ============================================================================
  // SUITE 2: POS IDENTITY & TAMPER-PROOFING
  // ============================================================================
  console.log('================================================================');
  console.log('  [SUITE 2] POS IDENTITY & TAMPER-PROOFING                     ');
  console.log('================================================================');

  // Find a product
  const { data: testProduct } = await supabase
    .from('products')
    .select('id, name, price')
    .eq('store_id', STORE_OMAR_ID)
    .gt('stock_quantity', 1)
    .limit(1)
    .single();

  assert(testProduct, 'Test product required in store Omar');

  // Test 2.1: Body injection of fake cashier_user_id and customer user_id
  const forgedCashierId = '00000000-0000-0000-0000-000000000000';
  const injectedCustomerId = '11111111-1111-1111-1111-111111111111';

  const orderRes = await fetch(`${BASE_URL}/api/pos/orders`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${cashierToken}`,
      'x-store-subdomain': STORE_OMAR_SUBDOMAIN,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      items: [{ id: testProduct.id, qty: 1 }],
      payment_method: 'cash',
      customer_name: 'عميل تدقيق التزوير',
      cashier_user_id: forgedCashierId, // Forged!
      user_id: injectedCustomerId,       // Injected!
      cash_tendered: Number(testProduct.price),
      change_due: 0
    })
  });

  const orderJson = await orderRes.json();
  assert.strictEqual(orderRes.status, 200, `POS order must succeed: ${orderJson.message}`);
  const createdOrderId = orderJson.data?.order_id;
  assert(createdOrderId, 'Created order ID must be returned');

  // Query DB directly to verify identity integrity
  const { data: dbOrder } = await supabase
    .from('orders')
    .select('id, user_id, cashier_user_id')
    .eq('id', createdOrderId)
    .single();

  console.log(`* Tamper-proofing test result:`);
  console.log(`   - Client injected cashier_user_id: ${forgedCashierId}`);
  console.log(`   - Database saved cashier_user_id:  ${dbOrder.cashier_user_id} (Matches JWT: ${dbOrder.cashier_user_id === cashierAuthId})`);
  console.log(`   - Client injected customer user_id:${injectedCustomerId}`);
  console.log(`   - Database saved customer user_id: ${dbOrder.user_id} (Zero FK violation: ${dbOrder.user_id === null})`);

  assert.strictEqual(dbOrder.cashier_user_id, cashierAuthId, 'cashier_user_id must be extracted from verified JWT');
  assert.strictEqual(dbOrder.user_id, null, 'Walk-in POS customer user_id must be NULL');
  console.log('[PASSED] Test 2.1: Client parameter tampering completely ignored; JWT identity enforced.');

  // Test 2.2: Cross-tenant barrier
  const crossTenantRes = await fetch(`${BASE_URL}/api/pos/orders`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${cashierToken}`,
      'x-store-subdomain': 'another-store',
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      items: [{ id: testProduct.id, qty: 1 }],
      payment_method: 'cash'
    })
  });
  console.log(`* Cross-tenant access attempt: HTTP ${crossTenantRes.status}`);
  assert([400, 403, 404].includes(crossTenantRes.status), 'Cross-tenant request must be rejected');
  console.log('[PASSED] Test 2.2: Cross-tenant cashier requests rejected.');

  // Test 2.3: Forged JWT token signature
  const fakeToken = jwt.sign(
    { sub: cashierAuthId, email: CASHIER_EMAIL, role: 'authenticated' },
    'FORGED_SECRET_KEY_WRONG_12345',
    { expiresIn: '1h' }
  );
  const fakeTokenRes = await fetch(`${BASE_URL}/api/pos/shifts/current`, {
    headers: {
      'Authorization': `Bearer ${fakeToken}`,
      'x-store-subdomain': STORE_OMAR_SUBDOMAIN
    }
  });
  console.log(`* Forged JWT token attempt: HTTP ${fakeTokenRes.status}`);
  assert.strictEqual(fakeTokenRes.status, 401, 'Forged JWT must return 401 Unauthorized');
  console.log('[PASSED] Test 2.3: Forged JWT token rejected with HTTP 401.\n');

  // Clean up test order
  await supabase.from('orders').delete().eq('id', createdOrderId);

  // ============================================================================
  // SUITE 3: CONCURRENCY / RACE CONDITION ON STAFF QUOTA (10 CONCURRENT REQUESTS)
  // ============================================================================
  console.log('================================================================');
  console.log('  [SUITE 3] CONCURRENCY ON STAFF QUOTA (10 CONCURRENT PROMISES)');
  console.log('================================================================');

  // 1. Get current active staff count
  const { count: initialStaffCount } = await supabase
    .from('store_staff')
    .select('id', { count: 'exact', head: true })
    .eq('store_id', STORE_OMAR_ID)
    .eq('is_active', true);

  console.log(`* Initial active staff count: ${initialStaffCount}`);

  // 2. Fetch plan feature limit record for store Omar specifically for 'employees'
  const { data: sub } = await supabase
    .from('store_subscriptions')
    .select('plan_id')
    .eq('store_id', STORE_OMAR_ID)
    .limit(1)
    .single();

  const { data: employeeFeature } = await supabase
    .from('features')
    .select('id')
    .eq('key', 'employees')
    .single();

  const { data: planFeat } = await supabase
    .from('plan_features')
    .select('id, feature_limits(id, limit_config)')
    .eq('plan_id', sub.plan_id)
    .eq('feature_id', employeeFeature.id)
    .limit(1)
    .single();

  const flId = planFeat?.feature_limits?.[0]?.id;
  const originalLimitConfig = planFeat?.feature_limits?.[0]?.limit_config || { max_value: -1 };

  // Set tight quota: exactly initialStaffCount + 2 allowed
  const targetLimit = initialStaffCount + 2;
  console.log(`* Setting temporary atomic quota limit: ${targetLimit} staff members`);

  if (flId) {
    await supabase.from('feature_limits').update({
      limit_config: { max_value: targetLimit },
      updated_at: new Date().toISOString()
    }).eq('id', flId);
  }

  // 3. Fire 10 simultaneous asynchronous requests via Promise.all
  console.log(`* Launching 10 simultaneous staff invites against PostgreSQL row lock (FOR UPDATE)...`);
  const concurrentEmails = Array.from({ length: 10 }, (_, i) => `race_staff_${Date.now()}_${i}@audit-test.com`);

  const concurrencyResponses = await Promise.all(
    concurrentEmails.map(email =>
      fetch(`${BASE_URL}/api/staff/invite`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${ownerToken}`,
          'x-store-subdomain': STORE_OMAR_SUBDOMAIN,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          email: email,
          role_name: 'cashier',
          name: `موظف السباق ${email}`
        })
      }).then(async res => ({
        email,
        status: res.status,
        data: await res.json().catch(() => ({}))
      }))
    )
  );

  const successCount = concurrencyResponses.filter(r => r.status === 200).length;
  const quotaBlockedCount = concurrencyResponses.filter(r => r.status === 403 && (r.data.code === 'PLAN_LIMIT_REACHED' || r.data.message?.includes('استنفد'))).length;

  console.log(`* Results of 10 Concurrent Requests:`);
  console.log(`   - Succeeded (HTTP 200):        ${successCount}`);
  console.log(`   - Quota Blocked (HTTP 403):    ${quotaBlockedCount}`);
  console.log(`   - Other Responses:             ${10 - successCount - quotaBlockedCount}`);

  // Query actual DB count
  const { count: finalStaffCount } = await supabase
    .from('store_staff')
    .select('id', { count: 'exact', head: true })
    .eq('store_id', STORE_OMAR_ID)
    .eq('is_active', true);

  console.log(`   - Final Active Staff in DB:    ${finalStaffCount} (Quota: ${targetLimit})`);

  assert.strictEqual(successCount, 2, 'Exactly 2 staff creations must succeed under the quota limit');
  assert.strictEqual(quotaBlockedCount, 8, 'Exactly 8 staff creations must be blocked with PLAN_LIMIT_REACHED');
  assert.strictEqual(finalStaffCount, targetLimit, 'Active staff in DB must strictly equal target limit (ZERO overflow)');

  // Clean up race staff and restore plan limit
  await supabase.from('store_staff').delete().in('invited_email', concurrentEmails);
  if (flId) {
    await supabase.from('feature_limits').update({
      limit_config: originalLimitConfig,
      updated_at: new Date().toISOString()
    }).eq('id', flId);
  }

  console.log('[PASSED] SUITE 3: Atomic row-level lock verified under high concurrency (0 overflow).\n');

  // ============================================================================
  // SUITE 4: CASH DRAWER SAFETY & MANAGER OVERRIDE ENFORCEMENT
  // ============================================================================
  console.log('================================================================');
  console.log('  [SUITE 4] CASH DRAWER SAFETY & MANAGER OVERRIDE ENFORCEMENT   ');
  console.log('================================================================');

  // 1. Close any currently open shift
  await supabase
    .from('pos_shifts')
    .update({ status: 'closed', closed_at: new Date().toISOString() })
    .eq('store_id', STORE_OMAR_ID)
    .eq('status', 'open');

  // 2. Open Shift A
  const { data: shiftA, error: errShiftA } = await supabase
    .from('pos_shifts')
    .insert({
      store_id: STORE_OMAR_ID,
      cashier_user_id: cashierAuthId,
      cashier_name: 'كاشير وردية أ',
      status: 'open',
      opening_cash: 1000,
      cash_sales: 0,
      cash_refunds: 0,
      pay_outs: 0,
      pay_ins: 0,
      expected_cash: 1000
    })
    .select()
    .single();

  if (errShiftA) throw errShiftA;
  console.log(`* Opened Shift A (ID: ${shiftA.id}) with 1000 EGP Float`);

  // Set product price to 550 EGP
  await supabase.from('products').update({ price: 550 }).eq('id', testProduct.id);

  // 3. Create POS Sale of 550 EGP in Shift A
  const { data: orderA, error: errOrderA } = await supabase.rpc('create_pos_order_atomic', {
    p_store_id: STORE_OMAR_ID,
    p_user_id: cashierAuthId,
    p_items: [{ id: testProduct.id, qty: 1 }],
    p_payment_method: 'cash',
    p_discount_amount: 0,
    p_customer_name: 'عميل وردية أ',
    p_cash_tendered: 550,
    p_change_due: 0,
    p_customer_user_id: null
  });

  if (errOrderA) throw errOrderA;
  console.log(`* Sale of 550 EGP placed in Shift A (Order ID: ${orderA.order_id})`);

  // 4. Close Shift A
  await supabase
    .from('pos_shifts')
    .update({ status: 'closed', closed_at: new Date().toISOString(), closing_cash: 1550 })
    .eq('id', shiftA.id);
  console.log(`* Closed Shift A with 1,550 EGP closing cash.`);

  // 5. Open Shift B with exactly 500 EGP Float
  const { data: shiftB, error: errShiftB } = await supabase
    .from('pos_shifts')
    .insert({
      store_id: STORE_OMAR_ID,
      cashier_user_id: cashierAuthId,
      cashier_name: 'كاشير وردية ب',
      status: 'open',
      opening_cash: 500,
      cash_sales: 0,
      cash_refunds: 0,
      pay_outs: 0,
      pay_ins: 0,
      expected_cash: 500
    })
    .select()
    .single();

  if (errShiftB) throw errShiftB;
  console.log(`* Opened Shift B (ID: ${shiftB.id}) with 500 EGP Float`);

  // --------------------------------------------------------------------------
  // TEST 4.1: Cashier attempts 550 EGP cash refund without override (allow_negative_cash: false)
  // MUST FAIL WITH HTTP 400 and INSUFFICIENT_DRAWER_CASH
  // --------------------------------------------------------------------------
  console.log(`\n* [Test 4.1] Cashier attempts 550 EGP refund without override (Drawer has 500 EGP)...`);
  const rejectRes = await fetch(`${BASE_URL}/api/pos/returns`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${cashierToken}`,
      'x-store-subdomain': STORE_OMAR_SUBDOMAIN,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      order_id: orderA.order_id,
      items: [{ id: testProduct.id, qty: 1, condition: 'sound', price: 550 }],
      refund_method: 'cash',
      reason: 'محاولة إرجاع عادية بدون تصريح مدير',
      allow_negative_cash: false
    })
  });

  const rejectJson = await rejectRes.json();
  console.log(`   - HTTP Status: ${rejectRes.status} (Expected: 400)`);
  console.log(`   - Error Code:  ${rejectJson.code} (Expected: INSUFFICIENT_DRAWER_CASH)`);
  console.log(`   - Message:     ${rejectJson.message}`);

  assert.strictEqual(rejectRes.status, 400, 'Cash refund exceeding drawer cash must return HTTP 400');
  assert.strictEqual(rejectJson.code, 'INSUFFICIENT_DRAWER_CASH', 'Code must be INSUFFICIENT_DRAWER_CASH');
  assert(rejectJson.message.includes('500') && rejectJson.message.includes('550'), 'Message must display available drawer cash vs required refund amount');

  // Verify Shift B state remains pristine (no cash was subtracted, no pay_outs)
  const { data: shiftBAfterReject } = await supabase.from('pos_shifts').select('*').eq('id', shiftB.id).single();
  assert.strictEqual(Number(shiftBAfterReject.cash_refunds), 0, 'Shift B cash_refunds must remain 0 after rejected refund');
  assert.strictEqual(Number(shiftBAfterReject.pay_outs), 0, 'Shift B pay_outs must remain 0');
  console.log('[PASSED] Test 4.1: Cash refund exceeding drawer cash blocked deterministically with INSUFFICIENT_DRAWER_CASH.');

  // --------------------------------------------------------------------------
  // TEST 4.2: Cashier attempts override with invalid manager PIN (Fake PIN '9999')
  // MUST FAIL WITH HTTP 403 and INVALID_MANAGER_PIN
  // --------------------------------------------------------------------------
  console.log(`\n* [Test 4.2] Cashier attempts override with forged PIN '9999'...`);
  const fakePinRes = await fetch(`${BASE_URL}/api/pos/returns`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${cashierToken}`,
      'x-store-subdomain': STORE_OMAR_SUBDOMAIN,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      order_id: orderA.order_id,
      items: [{ id: testProduct.id, qty: 1, condition: 'sound', price: 550 }],
      refund_method: 'cash',
      reason: 'محاولة إرجاع بـ PIN مزور',
      allow_negative_cash: true,
      manager_pin: '9999'
    })
  });

  const fakePinJson = await fakePinRes.json();
  console.log(`   - HTTP Status: ${fakePinRes.status} (Expected: 403)`);
  console.log(`   - Error Code:  ${fakePinJson.code} (Expected: INVALID_MANAGER_PIN)`);
  console.log(`   - Message:     ${fakePinJson.message}`);

  assert.strictEqual(fakePinRes.status, 403, 'Invalid PIN must return HTTP 403');
  assert.strictEqual(fakePinJson.code, 'INVALID_MANAGER_PIN', 'Code must be INVALID_MANAGER_PIN');
  console.log('[PASSED] Test 4.2: Forged manager PIN rejected with HTTP 403 INVALID_MANAGER_PIN.');

  // --------------------------------------------------------------------------
  // TEST 4.3: Cashier attempts override with NO manager PIN provided
  // MUST FAIL WITH HTTP 403 and MANAGER_AUTHORIZATION_REQUIRED
  // --------------------------------------------------------------------------
  console.log(`\n* [Test 4.3] Cashier attempts override with NO PIN provided...`);
  const noPinRes = await fetch(`${BASE_URL}/api/pos/returns`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${cashierToken}`,
      'x-store-subdomain': STORE_OMAR_SUBDOMAIN,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      order_id: orderA.order_id,
      items: [{ id: testProduct.id, qty: 1, condition: 'sound', price: 550 }],
      refund_method: 'cash',
      reason: 'محاولة إرجاع بدون PIN',
      allow_negative_cash: true
    })
  });

  const noPinJson = await noPinRes.json();
  console.log(`   - HTTP Status: ${noPinRes.status} (Expected: 403)`);
  console.log(`   - Error Code:  ${noPinJson.code} (Expected: MANAGER_AUTHORIZATION_REQUIRED)`);
  console.log(`   - Message:     ${noPinJson.message}`);

  assert.strictEqual(noPinRes.status, 403, 'Missing manager auth must return HTTP 403');
  assert.strictEqual(noPinJson.code, 'MANAGER_AUTHORIZATION_REQUIRED', 'Code must be MANAGER_AUTHORIZATION_REQUIRED');
  console.log('[PASSED] Test 4.3: Missing manager credentials rejected with HTTP 403 MANAGER_AUTHORIZATION_REQUIRED.');

  // --------------------------------------------------------------------------
  // TEST 4.4: Manager authorizes 550 EGP refund with valid PIN '1234'
  // MUST SUCCEED WITH HTTP 200, manager_override: true, drawer: -50 EGP
  // --------------------------------------------------------------------------
  console.log(`\n* [Test 4.4] Manager authorizes 550 EGP refund with valid PIN '1234'...`);
  const overrideReasonText = 'تصريح استثنائي للمدير لصرف مرتجع 550 ج.م مع عجز مؤقت بالدرج';
  const approvedRes = await fetch(`${BASE_URL}/api/pos/returns`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${cashierToken}`,
      'x-store-subdomain': STORE_OMAR_SUBDOMAIN,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      order_id: orderA.order_id,
      items: [{ id: testProduct.id, qty: 1, condition: 'sound', price: 550 }],
      refund_method: 'cash',
      reason: 'مرتجع وردية سابقة مع تصريح المدير',
      allow_negative_cash: true,
      manager_pin: '1234',
      override_reason: overrideReasonText
    })
  });

  const approvedJson = await approvedRes.json();
  console.log(`   - HTTP Status:        ${approvedRes.status} (Expected: 200)`);
  console.log(`   - Return Number:      ${approvedJson.data?.return_number}`);
  console.log(`   - Total Refund:       ${approvedJson.data?.total_refund} EGP`);
  console.log(`   - Manager Override:   ${approvedJson.data?.manager_override}`);
  console.log(`   - Drawer Cash Before: ${approvedJson.data?.drawer_cash_before} EGP`);
  console.log(`   - Drawer Cash After:  ${approvedJson.data?.drawer_cash_after} EGP`);

  assert.strictEqual(approvedRes.status, 200, 'Authorized refund must succeed with HTTP 200');
  assert.strictEqual(approvedJson.data?.manager_override, true, 'manager_override must be true in response');
  assert.strictEqual(Number(approvedJson.data?.drawer_cash_after), -50, 'drawer_cash_after must be -50');

  // Verify Shift B state in DB
  const { data: shiftBAfterApproved } = await supabase.from('pos_shifts').select('*').eq('id', shiftB.id).single();

  console.log(`\n* Accounting State of Shift B after Authorized Override:`);
  console.log(`   - opening_cash:  ${shiftBAfterApproved.opening_cash} EGP`);
  console.log(`   - cash_sales:    ${shiftBAfterApproved.cash_sales} EGP (Must be 0 EGP)`);
  console.log(`   - pay_outs:      ${shiftBAfterApproved.pay_outs} EGP (MUST REMAIN 0 EGP!)`);
  console.log(`   - cash_refunds:  ${shiftBAfterApproved.cash_refunds} EGP (Must be 550 EGP)`);

  const expectedCalculated = Number(shiftBAfterApproved.opening_cash) +
                            Number(shiftBAfterApproved.cash_sales) -
                            Number(shiftBAfterApproved.cash_refunds) +
                            Number(shiftBAfterApproved.pay_ins) -
                            Number(shiftBAfterApproved.pay_outs);

  console.log(`   - Formula: ${shiftBAfterApproved.opening_cash} + 0 - 550 + 0 - 0 = ${expectedCalculated} EGP`);

  assert.strictEqual(Number(shiftBAfterApproved.cash_sales), 0, 'Shift B cash sales must remain 0');
  assert.strictEqual(Number(shiftBAfterApproved.pay_outs), 0, 'pay_outs MUST NOT be contaminated (0 EGP)');
  assert.strictEqual(Number(shiftBAfterApproved.cash_refunds), 550, 'cash_refunds must strictly equal 550 EGP');
  assert.strictEqual(expectedCalculated, -50, 'Expected cash math is deterministic (500 - 550 = -50 EGP)');

  // Verify pos_returns audit record in DB
  const { data: returnAuditRow } = await supabase
    .from('pos_returns')
    .select('manager_override, override_reason, total_refund')
    .eq('id', approvedJson.data?.return_id)
    .single();

  assert.strictEqual(returnAuditRow.manager_override, true, 'pos_returns.manager_override must be true in DB');
  assert.strictEqual(returnAuditRow.override_reason, overrideReasonText, 'pos_returns.override_reason must match audit reason');

  // Clean up shifts and test order
  await supabase.from('pos_returns').delete().eq('order_id', orderA.order_id);
  await supabase.from('pos_shifts').delete().in('id', [shiftA.id, shiftB.id]);
  await supabase.from('orders').delete().eq('id', orderA.order_id);

  console.log('[PASSED] SUITE 4: Cash drawer safety enforced; Manager override verified with full audit trail.\n');

  // ============================================================================
  // SUITE 5: COMPLETE GPS PATH & ZERO-FALLBACK ELIMINATION
  // ============================================================================
  console.log('================================================================');
  console.log('  [SUITE 5] COMPLETE GPS PATH & ZERO-FALLBACK ELIMINATION       ');
  console.log('================================================================');

  const customerToken = makeToken(OWNER_AUTH_ID, 'customer_audit@test.com');

  // --------------------------------------------------------------------------
  // TEST 5.1: GPS Reverse Geocoding for Cairo (Tahrir Square: 30.0444, 31.2357)
  // MUST RESOLVE TO CAIRO AND is_in_egypt: true
  // --------------------------------------------------------------------------
  console.log(`* [Test 5.1] Reverse geocode GPS coordinates (lat=30.0444, lng=31.2357)...`);
  const geoRes = await fetch(`${BASE_URL}/api/geocode/reverse?lat=30.0444&lng=31.2357`);
  const geoJson = await geoRes.json();
  console.log(`   - HTTP Status:    ${geoRes.status} (Expected: 200)`);
  console.log(`   - Canonical Name: ${geoJson.data?.canonical_name}`);
  console.log(`   - Governorate:    ${geoJson.data?.governorate_name || geoJson.data?.state}`);
  console.log(`   - Is In Egypt:    ${geoJson.data?.is_in_egypt}`);

  assert.strictEqual(geoRes.status, 200, 'Reverse geocode must return HTTP 200');
  assert.strictEqual(geoJson.data?.is_in_egypt, true, 'Location must be identified within Egypt');

  // --------------------------------------------------------------------------
  // TEST 5.2: Direct POST /api/orders with GPS coordinates outside store omar's coverage
  // MUST FAIL WITH HTTP 400 and SHIPPING_OUT_OF_COVERAGE
  // --------------------------------------------------------------------------
  console.log(`\n* [Test 5.2] POST /api/orders with GPS coordinates (30.0444, 31.2357) outside store coverage...`);
  const directGpsRes = await fetch(`${BASE_URL}/api/orders`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${customerToken}`,
      'x-store-subdomain': STORE_OMAR_SUBDOMAIN
    },
    body: JSON.stringify({
      customer_name: 'عميل خارج نطاق الشحن',
      phone: '01099887766',
      city: 'القاهرة',
      address: 'ميدان التحرير، وسط البلد',
      lat: 30.0444,
      lng: 31.2357,
      paymentMethod: 'cod',
      idempotencyKey: `audit-gps-${Date.now()}`,
      items: [{ id: testProduct.id, qty: 1 }]
    })
  });

  const directGpsJson = await directGpsRes.json();
  console.log(`   - HTTP Status: ${directGpsRes.status} (Expected: 400)`);
  console.log(`   - Error Code:  ${directGpsJson.code} (Expected: SHIPPING_OUT_OF_COVERAGE)`);
  console.log(`   - Message:     ${directGpsJson.message}`);

  assert.strictEqual(directGpsRes.status, 400, 'Order outside coverage must return HTTP 400');
  assert.strictEqual(directGpsJson.code, 'SHIPPING_OUT_OF_COVERAGE', 'Code must be SHIPPING_OUT_OF_COVERAGE');

  // --------------------------------------------------------------------------
  // TEST 5.3: POST /api/orders with Google Maps location_url outside coverage
  // MUST FAIL WITH HTTP 400 and SHIPPING_OUT_OF_COVERAGE
  // --------------------------------------------------------------------------
  console.log(`\n* [Test 5.3] POST /api/orders with location_url outside store coverage...`);
  const mapsUrlRes = await fetch(`${BASE_URL}/api/orders`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${customerToken}`,
      'x-store-subdomain': STORE_OMAR_SUBDOMAIN
    },
    body: JSON.stringify({
      customer_name: 'عميل رابط الخريطة',
      phone: '01099887766',
      city: 'القاهرة',
      address: 'عنوان من رابط خرائط جوجل',
      location_url: 'https://maps.google.com/?q=30.0444,31.2357',
      paymentMethod: 'cod',
      idempotencyKey: `audit-url-${Date.now()}`,
      items: [{ id: testProduct.id, qty: 1 }]
    })
  });

  const mapsUrlJson = await mapsUrlRes.json();
  console.log(`   - HTTP Status: ${mapsUrlRes.status} (Expected: 400)`);
  console.log(`   - Error Code:  ${mapsUrlJson.code} (Expected: SHIPPING_OUT_OF_COVERAGE)`);
  console.log(`   - Message:     ${mapsUrlJson.message}`);

  assert.strictEqual(mapsUrlRes.status, 400, 'Order via location_url outside coverage must return HTTP 400');
  assert.strictEqual(mapsUrlJson.code, 'SHIPPING_OUT_OF_COVERAGE', 'Code must be SHIPPING_OUT_OF_COVERAGE');

  // --------------------------------------------------------------------------
  // TEST 5.4: Coordinates outside Egypt (lat: 35.0, lng: 18.0 in Mediterranean)
  // MUST FAIL WITH HTTP 400 and COORDINATES_OUTSIDE_EGYPT
  // --------------------------------------------------------------------------
  console.log(`\n* [Test 5.4] Reverse geocode coordinates outside Egypt (35.0, 18.0)...`);
  const foreignGeoRes = await fetch(`${BASE_URL}/api/geocode/reverse?lat=35.0&lng=18.0`);
  const foreignGeoJson = await foreignGeoRes.json();
  console.log(`   - HTTP Status: ${foreignGeoRes.status} (Expected: 400)`);
  console.log(`   - Error Code:  ${foreignGeoJson.code} (Expected: COORDINATES_OUTSIDE_EGYPT)`);
  assert.strictEqual(foreignGeoRes.status, 400, 'Foreign coordinates must return HTTP 400 on reverse geocode');
  assert.strictEqual(foreignGeoJson.code, 'COORDINATES_OUTSIDE_EGYPT', 'Code must be COORDINATES_OUTSIDE_EGYPT');

  console.log(`* [Test 5.4b] POST /api/orders with coordinates outside Egypt (35.0, 18.0)...`);
  const foreignOrderRes = await fetch(`${BASE_URL}/api/orders`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${customerToken}`,
      'x-store-subdomain': STORE_OMAR_SUBDOMAIN
    },
    body: JSON.stringify({
      customer_name: 'عميل خارج مصر',
      phone: '01099887766',
      city: 'أثينا',
      address: 'جزيرة كريت',
      lat: 35.0,
      lng: 18.0,
      paymentMethod: 'cod',
      idempotencyKey: `audit-foreign-${Date.now()}`,
      items: [{ id: testProduct.id, qty: 1 }]
    })
  });

  const foreignOrderJson = await foreignOrderRes.json();
  console.log(`   - HTTP Status: ${foreignOrderRes.status} (Expected: 400)`);
  console.log(`   - Error Code:  ${foreignOrderJson.code} (Expected: COORDINATES_OUTSIDE_EGYPT)`);
  assert.strictEqual(foreignOrderRes.status, 400, 'Order outside Egypt must return HTTP 400');
  assert.strictEqual(foreignOrderJson.code, 'COORDINATES_OUTSIDE_EGYPT', 'Code must be COORDINATES_OUTSIDE_EGYPT');

  // --------------------------------------------------------------------------
  // TEST 5.5: Zero-Fallback Elimination (Direct Engine Verification)
  // Verify shippingZoneEngine NEVER assigns 0 fee for uncovered zones
  // --------------------------------------------------------------------------
  console.log(`\n* [Test 5.5] Strict Zero-Fallback Elimination Verification...`);
  const uncovEval = await shippingZoneEngine.evaluateCoverage({
    storeId: STORE_OMAR_ID,
    lat: 30.0444,
    lng: 31.2357,
    cityName: 'القاهرة'
  });
  console.log(`   - Out-of-coverage evaluation: allowed=${uncovEval.allowed}, fee=${uncovEval.fee}`);
  assert.strictEqual(uncovEval.allowed, false, 'Uncovered zone must strictly have allowed: false');
  assert.strictEqual(uncovEval.fee, undefined, 'Uncovered zone fee must never fall back to 0');

  const outsideEgyptEval = await shippingZoneEngine.evaluateCoverage({
    storeId: STORE_OMAR_ID,
    lat: 35.0,
    lng: 18.0
  });
  console.log(`   - Outside Egypt evaluation:   allowed=${outsideEgyptEval.allowed}, code=${outsideEgyptEval.code}`);
  assert.strictEqual(outsideEgyptEval.allowed, false, 'Outside Egypt must strictly have allowed: false');
  assert.strictEqual(outsideEgyptEval.code, 'COORDINATES_OUTSIDE_EGYPT', 'Code must be COORDINATES_OUTSIDE_EGYPT');

  console.log('[PASSED] SUITE 5: Full GPS path verified, coordinates outside Egypt blocked, zero fallback eliminated.\n');

  // ============================================================================
  // SUITE 6: STAFF LIFECYCLE & INSTANT DEACTIVATION
  // ============================================================================
  console.log('================================================================');
  console.log('  [SUITE 6] STAFF LIFECYCLE & INSTANT DEACTIVATION             ');
  console.log('================================================================');

  const testLifecycleEmail = `lifecycle_${Date.now()}@omar-test.com`;

  // Step 1: Invite staff member via Store Owner
  const inviteRes = await fetch(`${BASE_URL}/api/staff/invite`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${ownerToken}`,
      'x-store-subdomain': STORE_OMAR_SUBDOMAIN,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      email: testLifecycleEmail,
      role_name: 'cashier',
      name: 'كاشير اختبار دورة الحياة'
    })
  });

  const inviteJson = await inviteRes.json();
  assert.strictEqual(inviteRes.status, 200, `Staff invite failed: ${inviteJson.message}`);
  const staffMemberId = inviteJson.data?.staff?.staff_id;
  const staffUserId = inviteJson.data?.staff?.user_id;
  assert(staffMemberId && staffUserId, 'Must return staff_id and user_id');
  console.log(`* Step 1: Staff created successfully: ID=${staffMemberId}, Email=${testLifecycleEmail}`);

  const lifecycleStaffToken = makeToken(staffUserId, testLifecycleEmail);

  // Step 2: Test API with active staff -> 200 OK
  const activeStaffRes = await fetch(`${BASE_URL}/api/pos/shifts/current`, {
    method: 'GET',
    headers: {
      'Authorization': `Bearer ${lifecycleStaffToken}`,
      'x-store-subdomain': STORE_OMAR_SUBDOMAIN
    }
  });
  assert.strictEqual(activeStaffRes.status, 200, 'Active staff must access POS shift endpoint');
  console.log(`* Step 2: Active staff authenticated and accessed POS (HTTP 200 OK)`);

  // Step 3: Deactivate staff (is_active = false)
  const deactivateRes = await fetch(`${BASE_URL}/api/staff/${staffMemberId}/toggle`, {
    method: 'PUT',
    headers: {
      'Authorization': `Bearer ${ownerToken}`,
      'x-store-subdomain': STORE_OMAR_SUBDOMAIN,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ is_active: false })
  });
  assert.strictEqual(deactivateRes.status, 200, 'Deactivation must succeed');
  console.log(`* Step 3: Store Owner toggled staff to is_active = false`);

  // Step 4: Test API with deactivated staff token -> MUST BE 403 STAFF_DEACTIVATED
  const deactivatedCallRes = await fetch(`${BASE_URL}/api/pos/shifts/current`, {
    method: 'GET',
    headers: {
      'Authorization': `Bearer ${lifecycleStaffToken}`,
      'x-store-subdomain': STORE_OMAR_SUBDOMAIN
    }
  });
  const deactivatedCallJson = await deactivatedCallRes.json();
  console.log(`* Step 4: Deactivated staff request result:`);
  console.log(`   - HTTP Status: ${deactivatedCallRes.status}`);
  console.log(`   - Error Code:  ${deactivatedCallJson.code}`);
  console.log(`   - Message:     ${deactivatedCallJson.message}`);

  assert.strictEqual(deactivatedCallRes.status, 403, 'Deactivated staff must return HTTP 403');
  assert.strictEqual(deactivatedCallJson.code, 'STAFF_DEACTIVATED', 'Must return STAFF_DEACTIVATED');
  console.log(`* Immediate block verified: Deactivated staff denied instantly.`);

  // Step 5: Reactivate staff (is_active = true)
  const reactivateRes = await fetch(`${BASE_URL}/api/staff/${staffMemberId}/toggle`, {
    method: 'PUT',
    headers: {
      'Authorization': `Bearer ${ownerToken}`,
      'x-store-subdomain': STORE_OMAR_SUBDOMAIN,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ is_active: true })
  });
  assert.strictEqual(reactivateRes.status, 200, 'Reactivation must succeed');
  console.log(`* Step 5: Store Owner toggled staff to is_active = true`);

  // Step 6: Test API with reactivated staff token -> MUST BE 200 OK
  const reactivatedCallRes = await fetch(`${BASE_URL}/api/pos/shifts/current`, {
    method: 'GET',
    headers: {
      'Authorization': `Bearer ${lifecycleStaffToken}`,
      'x-store-subdomain': STORE_OMAR_SUBDOMAIN
    }
  });
  assert.strictEqual(reactivatedCallRes.status, 200, 'Reactivated staff must regain POS access');
  console.log(`* Step 6: Reactivated staff regained POS access (HTTP 200 OK)`);

  // Step 7: Clean up test lifecycle staff
  await supabase.from('store_staff').delete().eq('id', staffMemberId);
  console.log('[PASSED] SUITE 6: Staff lifecycle (Create -> Block -> Unblock) fully proven.\n');

  console.log('================================================================');
  console.log('  [ALL SUITES PASSED] ALL 6 RIGOROUS ADVERSARIAL SUITES PASSED  ');
  console.log('================================================================\n');
}

run().catch(err => {
  console.error('\n[FAILED] AUDIT SUITE FAILED:', err);
  process.exit(1);
});
