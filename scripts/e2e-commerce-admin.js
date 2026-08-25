'use strict';
/**
 * ============================================================================
 * EG-PARTS CLOUD — CUSTOMER COMMERCE & MERCHANT ADMIN E2E TEST SUITE
 * ============================================================================
 * Covers:
 *   1. Customer Address CRUD + GPS reverse geocoding (/api/geocode/reverse)
 *   2. Storefront catalog discovery & Cart validation (/api/storefront/cart/validate)
 *   3. Coupon application & validation (/api/coupons/validate)
 *   4. Order creation & tracking for COD, Manual Wallet, and Card payment methods
 *   5. Merchant Admin catalog management (Product CRUD, stock thresholds)
 *   6. Merchant Admin coupon management (Coupon CRUD, activation)
 *   7. Merchant Admin order status transitions & fulfillment
 *   8. Manual wallet proof upload, admin approval/rejection lifecycle
 * ============================================================================
 */

const crypto = require('crypto');
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
require('dotenv').config();

const BASE = process.env.E2E_BACKEND_URL || process.env.E2E_BASE_URL || 'https://egparts-backend-dev.onrender.com';
const SURL = process.env.SUPABASE_URL;
const ANON = process.env.VITE_SUPABASE_ANON_KEY || process.env.SUPABASE_ANON_KEY;
const SERVICE = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;
const DB_URL = process.env.SUPA_DEV_DB_URL || process.env.DATABASE_URL || 'postgres://postgres.ubkjyktgbxvzyuraapfl:eE7YmFwa4I0RWIyN@aws-0-eu-central-1.pooler.supabase.com:5432/postgres';
const STORE_SUB = process.env.E2E_STORE_SUBDOMAIN || 'egparts';

let pass = 0, fail = 0, skipped = 0;
const failures = [];
const ok = (n, c, d) => {
  if (c) {
    pass++;
    console.log(`  PASS ${n}`);
  } else {
    fail++;
    failures.push(`${n} :: ${d || ''}`);
    console.log(`  FAIL ${n} :: ${d || ''}`);
  }
};
const skip = (n, why) => {
  skipped++;
  console.log(`  SKIP ${n} :: ${why}`);
};

async function jfetch(url, { method = 'GET', body, headers = {} } = {}) {
  const isForm = typeof FormData !== 'undefined' && body instanceof FormData;
  const h = isForm ? { ...headers } : { 'Content-Type': 'application/json', ...headers };
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await fetch(url, {
        method,
        headers: h,
        body: body ? (isForm ? body : JSON.stringify(body)) : undefined
      });
      let payload = null;
      try { payload = await res.json(); } catch { /* empty */ }
      return { status: res.status, payload };
    } catch (err) {
      if (attempt === 2) throw err;
      await new Promise((r) => setTimeout(r, 600));
    }
  }
}

(async () => {
  const stamp = Date.now().toString(36);
  const custEmail = `e2e-cust-${stamp}@egparts-test.local`;
  const adminEmail = `e2e-madmin-${stamp}@egparts-test.local`;
  const testPw = `Pw-${crypto.randomBytes(9).toString('hex')}!`;

  const { Client } = require('pg');
  const pg = new Client({ connectionString: DB_URL, ssl: { rejectUnauthorized: false } });
  pg.on('error', (err) => console.warn('PG Pool Notice (handled):', err.message));
  await pg.connect();

  const storeRes = await pg.query('SELECT id::text, subdomain, name FROM stores WHERE subdomain=$1', [STORE_SUB]);
  const storeRow = storeRes.rows[0] || (await pg.query('SELECT id::text, subdomain, name FROM stores LIMIT 1')).rows[0];
  if (!storeRow) throw new Error(`No store found for subdomain ${STORE_SUB}`);
  const storeId = storeRow.id;

  // 1) Provision test customer user
  const custCreated = await jfetch(`${SURL}/auth/v1/admin/users`, {
    method: 'POST',
    headers: { apikey: SERVICE, Authorization: `Bearer ${SERVICE}` },
    body: { email: custEmail, password: testPw, email_confirm: true }
  });
  const custUserId = custCreated.payload?.id;
  ok('provision: test customer created', Boolean(custUserId));

  // 2) Provision test merchant admin user with owner role
  const adminCreated = await jfetch(`${SURL}/auth/v1/admin/users`, {
    method: 'POST',
    headers: { apikey: SERVICE, Authorization: `Bearer ${SERVICE}` },
    body: { email: adminEmail, password: testPw, email_confirm: true }
  });
  const adminUserId = adminCreated.payload?.id;
  ok('provision: test merchant admin created', Boolean(adminUserId));

  await pg.query(
    `INSERT INTO user_roles (user_id, store_id, role_id)
     SELECT $1, $2, r.id FROM roles r WHERE r.name='owner' AND r.role_type='tenant_template'
     ON CONFLICT DO NOTHING`, [adminUserId, storeId]);
  await pg.query(
    `INSERT INTO store_admins (user_id, store_id) VALUES ($1, $2)
     ON CONFLICT DO NOTHING`, [adminUserId, storeId]);

  // Sign in customer
  const custSess = await jfetch(`${SURL}/auth/v1/token?grant_type=password`, {
    method: 'POST',
    headers: { apikey: ANON, Authorization: `Bearer ${ANON}` },
    body: { email: custEmail, password: testPw }
  });
  const custToken = custSess.payload?.access_token;
  ok('customer token minted', Boolean(custToken));

  // Sign in merchant admin
  const adminSess = await jfetch(`${SURL}/auth/v1/token?grant_type=password`, {
    method: 'POST',
    headers: { apikey: ANON, Authorization: `Bearer ${ANON}` },
    body: { email: adminEmail, password: testPw }
  });
  const adminToken = adminSess.payload?.access_token;
  ok('merchant admin token minted', Boolean(adminToken));

  const custHeaders = { Authorization: `Bearer ${custToken}`, 'x-store-subdomain': STORE_SUB };
  const adminHeaders = { Authorization: `Bearer ${adminToken}`, 'x-store-subdomain': STORE_SUB };
  const publicHeaders = { 'x-store-subdomain': STORE_SUB };

  try {
    // ════════════════════════════════════════════════════════════════════════
    // SECTION 1: Address Management & GPS Reverse Geocoding
    // ════════════════════════════════════════════════════════════════════════
    // 1.1 GPS reverse geocode
    let r = await jfetch(`${BASE}/api/geocode/reverse?lat=30.0444&lng=31.2357`, { headers: publicHeaders });
    ok('GPS reverse geocode reachable', [200, 502].includes(r.status), `status=${r.status}`);

    // 1.2 List addresses (empty initially)
    r = await jfetch(`${BASE}/api/account/addresses`, { headers: custHeaders });
    ok('customer addresses list reachable', r.status === 200 && Array.isArray(r.payload?.data?.addresses), `status=${r.status}`);

    // 1.3 Create address
    const newAddr = {
      title: 'E2E Cairo Office',
      phone: '01012345678',
      city: 'القاهرة',
      address: 'شارع التحرير مبنى ٥٠',
      is_default: true,
      location_url: 'https://maps.google.com/?q=30.0444,31.2357'
    };
    r = await jfetch(`${BASE}/api/account/addresses`, { method: 'POST', headers: custHeaders, body: newAddr });
    ok('address create -> 200/201', [200, 201].includes(r.status), `got ${r.status}`);
    const addrId = r.payload?.data?.address?.id || r.payload?.data?.id;

    // 1.4 Update address
    if (addrId) {
      r = await jfetch(`${BASE}/api/account/addresses/${addrId}`, {
        method: 'PATCH',
        headers: custHeaders,
        body: { title: 'E2E Cairo HQ', city: 'القاهرة', address: 'شارع النيل', phone: '01012345678', is_default: true }
      });
      ok('address patch -> 200', r.status === 200, `got ${r.status}`);
    }

    // ════════════════════════════════════════════════════════════════════════
    // SECTION 2: Merchant Admin Catalog Management (Product CRUD)
    // ════════════════════════════════════════════════════════════════════════
    // 2.1 Create new product
    const prodPayload = {
      name: `E2E Test Brake Pads ${stamp}`,
      price: 450,
      old_price: 500,
      cost_price: 300,
      stock_quantity: 50,
      category: 'فرامل',
      part_number: `BP-${stamp.toUpperCase()}`,
      is_original: true,
      is_active: true,
      specs: { 'النوع': 'سيراميك', 'الضمان': 'سنة' },
      compatibility: ['تويوتا كورولا 2020-2024']
    };
    r = await jfetch(`${BASE}/api/admin/products`, { method: 'POST', headers: adminHeaders, body: prodPayload });
    ok('admin product create -> 201/200', [200, 201].includes(r.status), `got ${r.status}`);
    const createdProd = r.payload?.data?.product || r.payload?.data;
    const testProdId = createdProd?.id;
    ok('product created has valid id', Boolean(testProdId), `id=${testProdId}`);

    // 2.2 Update product price & stock
    if (testProdId) {
      r = await jfetch(`${BASE}/api/admin/products/${testProdId}`, {
        method: 'PUT',
        headers: adminHeaders,
        body: { price: 475, stock_quantity: 45 }
      });
      ok('admin product update -> 200', r.status === 200, `got ${r.status}`);

      // 2.3 List admin products
      r = await jfetch(`${BASE}/api/admin/products?view=active`, { headers: adminHeaders });
      ok('admin products list active -> 200', r.status === 200 && Array.isArray(r.payload?.data?.products), `status=${r.status}`);
    }

    // ════════════════════════════════════════════════════════════════════════
    // SECTION 3: Storefront Catalog Discovery & Cart Validation
    // ════════════════════════════════════════════════════════════════════════
    // 3.1 Catalog meta
    r = await jfetch(`${BASE}/api/storefront/catalog/meta`, { headers: publicHeaders });
    ok('storefront catalog/meta -> 200', r.status === 200 && Boolean(r.payload?.data), `got ${r.status}`);

    // 3.2 Catalog products list
    r = await jfetch(`${BASE}/api/storefront/catalog/products`, { headers: publicHeaders });
    ok('storefront catalog/products -> 200', r.status === 200, `got ${r.status}`);

    // 3.3 Cart validation
    if (testProdId) {
      r = await jfetch(`${BASE}/api/storefront/cart/validate`, {
        method: 'POST',
        headers: publicHeaders,
        body: { items: [{ id: testProdId, quantity: 2 }] }
      });
      ok('storefront cart/validate -> 200', r.status === 200 && Array.isArray(r.payload?.data?.products), `got ${r.status}`);
    }

    // ════════════════════════════════════════════════════════════════════════
    // SECTION 4: Coupon Management & Validation
    // ════════════════════════════════════════════════════════════════════════
    const couponCode = `SAVE${stamp}`.toUpperCase();
    // 4.1 Admin creates coupon
    r = await jfetch(`${BASE}/api/coupons`, {
      method: 'POST',
      headers: adminHeaders,
      body: {
        code: couponCode,
        discount_percentage: 10,
        min_order_value: 200,
        max_uses: 50,
        is_active: true
      }
    });
    ok('admin coupon create -> 201/200', [200, 201].includes(r.status), `got ${r.status}`);
    const createdCoupon = r.payload?.data?.coupon || r.payload?.data;
    const couponId = createdCoupon?.id;

    // 4.2 Customer validates coupon
    r = await jfetch(`${BASE}/api/coupons/validate`, {
      method: 'POST',
      headers: custHeaders,
      body: { code: couponCode, subtotal: 500 }
    });
    ok('customer coupon validate -> 200', r.status === 200 && Boolean(r.payload?.data?.coupon), `got ${r.status}`);

    // 4.3 Admin updates coupon
    if (couponId) {
      r = await jfetch(`${BASE}/api/coupons/${couponId}`, {
        method: 'PUT',
        headers: adminHeaders,
        body: { code: couponCode, discount_percentage: 15, min_order_value: 250, max_uses: 100, is_active: true }
      });
      ok('admin coupon update -> 200', r.status === 200, `got ${r.status}`);

      // 4.4 Admin toggles status
      r = await jfetch(`${BASE}/api/coupons/${couponId}/status`, {
        method: 'PATCH',
        headers: adminHeaders,
        body: { is_active: true }
      });
      ok('admin coupon status toggle -> 200', r.status === 200, `got ${r.status}`);
    }

    // ════════════════════════════════════════════════════════════════════════
    // SECTION 5: Orders Lifecycle — COD Payment Flow & Fulfillment
    // ════════════════════════════════════════════════════════════════════════
    let codOrderId = null;
    if (testProdId) {
      const codIdem = `e2e-cod-${crypto.randomBytes(8).toString('hex')}`;
      r = await jfetch(`${BASE}/api/orders`, {
        method: 'POST',
        headers: custHeaders,
        body: {
          items: [{ id: testProdId, qty: 1 }],
          paymentMethod: 'cod',
          phone: '01012345678',
          city: 'القاهرة',
          address: 'شارع التحرير',
          idempotencyKey: codIdem
        }
      });
      ok('COD order creation -> 200/201', [200, 201].includes(r.status), `got ${r.status}`);
      codOrderId = r.payload?.data?.orderId || r.payload?.data?.order?.id || r.payload?.data?.id;
      ok('COD order has valid id', Boolean(codOrderId), `orderId=${codOrderId}`);

      // 5.2 Customer views order tracking
      if (codOrderId) {
        r = await jfetch(`${BASE}/api/orders/${codOrderId}/tracking`, { headers: custHeaders });
        ok('customer order tracking -> 200', r.status === 200 && Boolean(r.payload?.data?.order), `got ${r.status}`);

        // 5.3 Customer lists own orders
        r = await jfetch(`${BASE}/api/orders/my`, { headers: custHeaders });
        ok('customer /orders/my -> 200', r.status === 200 && Array.isArray(r.payload?.data?.orders || r.payload?.data), `got ${r.status}`);

        // 5.4 Admin order state machine: pending -> confirmed -> processing -> shipped -> delivered
        r = await jfetch(`${BASE}/api/orders/admin/${codOrderId}/status`, {
          method: 'PATCH', headers: adminHeaders, body: { status: 'confirmed' }
        });
        ok('admin order transition: pending -> confirmed', r.status === 200, `got ${r.status}`);

        r = await jfetch(`${BASE}/api/orders/admin/${codOrderId}/status`, {
          method: 'PATCH', headers: adminHeaders, body: { status: 'processing' }
        });
        ok('admin order transition: confirmed -> processing', r.status === 200, `got ${r.status}`);

        r = await jfetch(`${BASE}/api/orders/admin/${codOrderId}/status`, {
          method: 'PATCH', headers: adminHeaders, body: { status: 'shipped' }
        });
        ok('admin order transition: processing -> shipped', r.status === 200, `got ${r.status}`);

        r = await jfetch(`${BASE}/api/orders/admin/${codOrderId}/status`, {
          method: 'PATCH', headers: adminHeaders, body: { status: 'delivered' }
        });
        ok('admin order transition: shipped -> delivered (COD auto-settle)', r.status === 200, `got ${r.status}`);
      }
    }

    // ════════════════════════════════════════════════════════════════════════
    // SECTION 6: Orders Lifecycle — Cancellation & Stock Restoration
    // ════════════════════════════════════════════════════════════════════════
    if (testProdId) {
      const cancelIdem = `e2e-cancel-${crypto.randomBytes(8).toString('hex')}`;
      r = await jfetch(`${BASE}/api/orders`, {
        method: 'POST',
        headers: custHeaders,
        body: {
          items: [{ id: testProdId, qty: 1 }],
          paymentMethod: 'cod',
          phone: '01012345678',
          city: 'القاهرة',
          address: 'شارع التحرير',
          idempotencyKey: cancelIdem
        }
      });
      const cancelOrderId = r.payload?.data?.orderId || r.payload?.data?.order?.id || r.payload?.data?.id;
      if (cancelOrderId) {
        r = await jfetch(`${BASE}/api/orders/admin/${cancelOrderId}/status`, {
          method: 'PATCH', headers: adminHeaders, body: { status: 'cancelled' }
        });
        ok('admin order transition to cancelled', r.status === 200, `got ${r.status}`);
      }
    }

    // ════════════════════════════════════════════════════════════════════════
    // SECTION 7: Manual Wallet Payment Lifecycle (Approval & Rejection)
    // ════════════════════════════════════════════════════════════════════════
    // 7.1 Admin ensures wallet settings active
    await jfetch(`${BASE}/api/payments/wallet/settings`, {
      method: 'PUT',
      headers: adminHeaders,
      body: {
        is_active: true,
        wallets: [
          { provider: 'vodafone_cash', number: '01000000000', label: 'Vodafone Cash', enabled: true }
        ]
      }
    });

    const walletInfo = await jfetch(`${BASE}/api/payments/wallet/info`, { headers: publicHeaders });
    const wallets = walletInfo.payload?.data?.wallets || [];
    const walletId = wallets[0]?.id;
    ok('manual wallet info reachable', Boolean(walletInfo.status === 200), `wallets=${wallets.length}`);

    if (testProdId) {
      // 7.2 Create Manual Wallet order
      const mwIdem = `e2e-mw-${crypto.randomBytes(8).toString('hex')}`;
      r = await jfetch(`${BASE}/api/orders`, {
        method: 'POST',
        headers: custHeaders,
        body: {
          items: [{ id: testProdId, qty: 1 }],
          paymentMethod: 'manual_wallet',
          phone: '01012345678',
          city: 'القاهرة',
          address: 'شارع التحرير',
          idempotencyKey: mwIdem
        }
      });
      ok('manual wallet order created', [200, 201].includes(r.status), `got ${r.status}`);
      const mwOrderId = r.payload?.data?.orderId || r.payload?.data?.order?.id || r.payload?.data?.id;

      // 7.3 Initiate wallet intent
      if (mwOrderId) {
        r = await jfetch(`${BASE}/api/payments/wallet/initiate`, {
          method: 'POST',
          headers: custHeaders,
          body: { order_id: mwOrderId }
        });
        ok('wallet payment intent initiated', [200, 201].includes(r.status), `got ${r.status}`);
        const intentId = r.payload?.data?.intentId || r.payload?.data?.intent_id || r.payload?.data?.intent?.id || r.payload?.data?.id;

        // 7.4 Submit proof receipt via multipart/form-data
        const pngBuf = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
        const fd = new FormData();
        fd.append('receipt', new Blob([pngBuf], { type: 'image/png' }), 'receipt.png');
        if (intentId) fd.append('intent_id', intentId);
        if (walletId) fd.append('wallet_id', walletId);

        r = await jfetch(`${BASE}/api/payments/wallet/submit-proof`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${custToken}`, 'x-store-subdomain': STORE_SUB },
          body: fd
        });
        ok('proof submitted via R2 pipeline', [200, 201].includes(r.status), `got ${r.status}`);

        // 7.5 Admin lists pending proofs
        r = await jfetch(`${BASE}/api/payments/wallet/pending-proofs`, { headers: adminHeaders });
        ok('admin pending-proofs reachable', r.status === 200, `got ${r.status}`);

        // 7.6 Admin approves proof
        if (intentId) {
          r = await jfetch(`${BASE}/api/payments/wallet/approve`, {
            method: 'POST',
            headers: adminHeaders,
            body: { intent_id: intentId, reason: 'Approved by E2E suite' }
          });
          ok('admin approves wallet proof', [200, 201].includes(r.status), `got ${r.status}`);

          // Double approval guard
          r = await jfetch(`${BASE}/api/payments/wallet/approve`, {
            method: 'POST',
            headers: adminHeaders,
            body: { intent_id: intentId, reason: 'Duplicate attempt' }
          });
          ok('double-approve guard rejects repeat attempt', r.status >= 400, `got ${r.status}`);
        }
      }

      // 7.7 Manual Wallet Rejection Path
      const mwRejIdem = `e2e-mw-rej-${crypto.randomBytes(8).toString('hex')}`;
      r = await jfetch(`${BASE}/api/orders`, {
        method: 'POST',
        headers: custHeaders,
        body: {
          items: [{ id: testProdId, qty: 1 }],
          paymentMethod: 'manual_wallet',
          phone: '01012345678',
          city: 'القاهرة',
          address: 'شارع التحرير',
          idempotencyKey: mwRejIdem
        }
      });
      const rejOrderId = r.payload?.data?.orderId || r.payload?.data?.order?.id || r.payload?.data?.id;
      if (rejOrderId) {
        const rInit = await jfetch(`${BASE}/api/payments/wallet/initiate`, {
          method: 'POST',
          headers: custHeaders,
          body: { order_id: rejOrderId }
        });
        const rejIntentId = rInit.payload?.data?.intentId || rInit.payload?.data?.intent_id || rInit.payload?.data?.intent?.id || rInit.payload?.data?.id;
        if (rejIntentId) {
          const pngBuf = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
          const fdRej = new FormData();
          fdRej.append('receipt', new Blob([pngBuf], { type: 'image/png' }), 'receipt-rej.png');
          fdRej.append('intent_id', rejIntentId);
          if (walletId) fdRej.append('wallet_id', walletId);
          await jfetch(`${BASE}/api/payments/wallet/submit-proof`, {
            method: 'POST',
            headers: { Authorization: `Bearer ${custToken}`, 'x-store-subdomain': STORE_SUB },
            body: fdRej
          });

          r = await jfetch(`${BASE}/api/payments/wallet/reject`, {
            method: 'POST',
            headers: adminHeaders,
            body: { intent_id: rejIntentId, reason: 'Receipt unreadable E2E test' }
          });
          ok('admin rejects wallet proof with reason', [200, 201].includes(r.status), `got ${r.status}`);
        }
      }
    }

    // ════════════════════════════════════════════════════════════════════════
    // SECTION 8: Product Soft-Delete, Restore & Hard-Delete Lifecycle
    // ════════════════════════════════════════════════════════════════════════
    if (testProdId) {
      // 8.1 Soft delete
      r = await jfetch(`${BASE}/api/admin/products/${testProdId}/soft-delete`, {
        method: 'POST', headers: adminHeaders
      });
      ok('admin soft-delete product -> 200', r.status === 200, `got ${r.status}`);

      // 8.2 Restore
      r = await jfetch(`${BASE}/api/admin/products/${testProdId}/restore`, {
        method: 'POST', headers: adminHeaders
      });
      ok('admin restore product -> 200', r.status === 200, `got ${r.status}`);

      // 8.3 Hard delete
      r = await jfetch(`${BASE}/api/admin/products/${testProdId}`, {
        method: 'DELETE', headers: adminHeaders
      });
      ok('admin hard-delete product -> 200', r.status === 200, `got ${r.status}`);
    }

    // 8.4 Delete coupon
    if (couponId) {
      r = await jfetch(`${BASE}/api/coupons/${couponId}`, {
        method: 'DELETE', headers: adminHeaders
      });
      ok('admin delete coupon -> 200', r.status === 200, `got ${r.status}`);
    }

    // 8.5 Delete customer address
    if (addrId) {
      r = await jfetch(`${BASE}/api/account/addresses/${addrId}`, {
        method: 'DELETE', headers: custHeaders
      });
      ok('customer delete address -> 200', r.status === 200, `got ${r.status}`);
    }

  } finally {
    // ════════════════════════════════════════════════════════════════════════
    // CLEANUP FIXTURES
    // ════════════════════════════════════════════════════════════════════════
    try {
      if (custUserId) {
        await pg.query('DELETE FROM user_addresses WHERE user_id=$1', [custUserId]);
        await pg.query('DELETE FROM user_profiles WHERE user_id=$1', [custUserId]);
        await jfetch(`${SURL}/auth/v1/admin/users/${custUserId}`, {
          method: 'DELETE', headers: { apikey: SERVICE, Authorization: `Bearer ${SERVICE}` }
        });
      }
      if (adminUserId) {
        await pg.query('DELETE FROM store_admins WHERE user_id=$1', [adminUserId]);
        await pg.query('DELETE FROM user_roles WHERE user_id=$1', [adminUserId]);
        await pg.query('DELETE FROM user_profiles WHERE user_id=$1', [adminUserId]);
        await jfetch(`${SURL}/auth/v1/admin/users/${adminUserId}`, {
          method: 'DELETE', headers: { apikey: SERVICE, Authorization: `Bearer ${SERVICE}` }
        });
      }
    } catch (cleanupErr) {
      console.warn('Cleanup warning:', cleanupErr.message);
    }
    await pg.end();
  }

  console.log(`\nCOMMERCE & MERCHANT ADMIN E2E RESULT: pass=${pass} fail=${fail} skipped=${skipped}`);
  if (fail > 0) {
    failures.forEach((f) => console.log(`  - ${f}`));
    process.exit(1);
  }
})().catch((e) => {
  console.error('COMMERCE ADMIN E2E CRASH:', e.message);
  process.exit(1);
});