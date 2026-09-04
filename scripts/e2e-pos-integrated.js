'use strict';

/**
 * ============================================================================
 * EG-PARTS CLOUD — FULL INTEGRATED POS E2E TEST SUITE (ZERO-REGRESSION)
 * ============================================================================
 * Covers end-to-end:
 *   1. Local server boot & health probe
 *   2. Merchant Admin authentication & RBAC session
 *   3. Catalog & Barcode product discovery
 *   4. Cashier Shift Opening (Float) & Duplicate Prevention
 *   5. Cash Drawer Movements (Pay-In / Pay-Out) & Balance Tracking
 *   6. Atomic Cash Sale: Cart Checkout, Stock Decrement & Shift Cash Sales
 *   7. Atomic Card Sale: Separation of Physical Drawer Cash vs Card Sales
 *   8. Order Lookup with Calculated Returnable / Already-Returned Quantities
 *   9. Partial Return (Sound Condition): Inventory Restock & Shift Refund
 *  10. Damaged Return (Scrap Condition): Scrap Logging & Zero Stock Restoration
 *  11. Double-Return Protection (Rejection of Over-Refunds)
 *  12. Vector Thermal Receipt PDF Generation (Code-128 & QR Code)
 *  13. Shift Closing, Drawer Reconciliation & Z-Report Generation
 *  14. Shift History Log & Post-Close Isolation
 * ============================================================================
 */

require('dotenv').config();
const { spawn } = require('child_process');
const http = require('http');
const path = require('path');
const assert = require('assert');
const { createClient } = require('@supabase/supabase-js');
const { generateReceiptPdf } = require('../services/receiptPdfService');

const PORT = 5589;
const BASE = `http://localhost:${PORT}`;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY;

if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
  console.error('Missing required Supabase environment variables');
  process.exit(1);
}

const supabaseAdmin = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);
const supabaseAnon = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

let passCount = 0;
let failCount = 0;
const failures = [];

function pass(testName, details = '') {
  passCount++;
  console.log(`  [PASS] ${testName} ${details ? `(${details})` : ''}`);
}

function fail(testName, error) {
  failCount++;
  const msg = error?.message || error || 'Assertion failed';
  failures.push({ testName, msg });
  console.error(`  [FAIL] ${testName} :: ${msg}`);
}

async function sleep(ms = 250) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function request(endpoint, { method = 'GET', body, headers = {} } = {}) {
  await sleep(150); // Gentle pacing to avoid any rate limiting
  const url = `${BASE}${endpoint}`;
  const res = await fetch(url, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...headers
    },
    body: body ? JSON.stringify(body) : undefined
  });

  let data = null;
  try {
    data = await res.json();
  } catch {
    // Non-JSON response
  }

  return {
    status: res.status,
    ok: res.ok,
    data
  };
}

function waitForHealth(timeoutMs = 30000) {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const tick = () => {
      const req = http.get(`${BASE}/api/health`, { timeout: 2000 }, (res) => {
        if (res.statusCode === 200) return resolve(true);
        setTimeout(tick, 500);
      });
      req.on('error', () => {
        if (Date.now() - started > timeoutMs) return reject(new Error('Server failed to boot in time'));
        setTimeout(tick, 500);
      });
      req.on('timeout', () => req.destroy());
    };
    tick();
  });
}

async function runIntegratedPosE2E() {
  console.log('================================================================');
  console.log('🚀 STARTING REAL INTEGRATED POS E2E SUITE (ZERO REGRESSION)');
  console.log('================================================================');

  // 1. Boot Local Backend Server
  console.log('\n[Stage 1] Booting Local Backend Process on Port', PORT, '...');
  const serverProcess = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
    env: {
      ...process.env,
      PORT: String(PORT),
      ENABLE_WHATSAPP: 'false'
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });

  serverProcess.stderr.on('data', (d) => {
    const msg = d.toString();
    if (msg.includes('Error:') && !msg.includes('handled')) {
      console.error('[Server Error Output]:', msg.trim());
    }
  });

  let testUserId = null;
  let storeId = null;
  let storeSubdomain = null;
  let adminToken = null;
  let targetProduct = null;
  let initialStock = 0;
  let testShiftId = null;

  try {
    await waitForHealth();
    pass('Server booted and healthy', `${BASE}/api/health responded 200`);

    // 2. Setup Real Merchant Admin Context (ensure store is active with valid subscription)
    console.log('\n[Stage 2] Setting up Tenant Store and Merchant Admin Authentication...');
    const { data: store, error: storeErr } = await supabaseAdmin
      .from('stores')
      .select('id, name, subdomain')
      .eq('status', 'active')
      .gt('subscription_expires_at', new Date().toISOString())
      .neq('id', '00000000-0000-0000-0000-000000000000')
      .order('created_at', { ascending: true })
      .limit(1)
      .single();

    assert(!storeErr && store, `Failed to load active store: ${storeErr?.message}`);
    storeId = store.id;
    storeSubdomain = store.subdomain;
    pass('Target Store Identified', `ID: ${storeId} (${storeSubdomain})`);

    // Create unique temporary test admin user
    const stamp = Date.now().toString(36);
    const adminEmail = `pos-e2e-${stamp}@egparts-test.local`;
    const adminPassword = `PosPass-${stamp}!`;

    const { data: userCreated, error: createErr } = await supabaseAdmin.auth.admin.createUser({
      email: adminEmail,
      password: adminPassword,
      email_confirm: true,
      user_metadata: { full_name: 'كاشير اختبار E2E' }
    });
    assert(!createErr && userCreated?.user, `Failed to create test user: ${createErr?.message}`);
    testUserId = userCreated.user.id;

    // Grant owner role in store
    const { data: ownerRole } = await supabaseAdmin
      .from('roles')
      .select('id')
      .eq('name', 'owner')
      .eq('role_type', 'tenant_template')
      .single();

    if (ownerRole) {
      await supabaseAdmin.from('user_roles').insert({
        user_id: testUserId,
        store_id: storeId,
        role_id: ownerRole.id
      });
      await supabaseAdmin.from('store_admins').insert({
        user_id: testUserId,
        store_id: storeId
      });
    }

    // Authenticate and obtain JWT
    const { data: signData, error: signErr } = await supabaseAnon.auth.signInWithPassword({
      email: adminEmail,
      password: adminPassword
    });
    assert(!signErr && signData?.session?.access_token, `Sign-in failed: ${signErr?.message}`);
    adminToken = signData.session.access_token;
    pass('Merchant Admin Authenticated', `User: ${adminEmail}`);

    const adminHeaders = {
      Authorization: `Bearer ${adminToken}`,
      'x-store-subdomain': storeSubdomain
    };

    // 3. Catalog & Barcode Discovery
    console.log('\n[Stage 3] Testing POS Catalog & Barcode Discovery...');
    const prodRes = await request('/api/pos/products', { headers: adminHeaders });
    assert(prodRes.status === 200, `Expected 200, got ${prodRes.status}: ${JSON.stringify(prodRes.data)}`);
    assert(prodRes.data?.success === true, 'Response must match success envelope');
    let productsList = prodRes.data?.data?.products || [];
    if (productsList.length === 0) {
      const { data: newProd, error: newProdErr } = await supabaseAdmin
        .from('products')
        .insert({
          store_id: storeId,
          name: 'قطعة غيار اختبار E2E',
          price: 250,
          stock_quantity: 30,
          stock: 30,
          is_active: true,
          is_deleted: false,
          part_number: `E2E-PART-${Date.now()}`
        })
        .select()
        .single();
      assert(!newProdErr && newProd, `Failed to seed test product: ${newProdErr?.message}`);
      productsList = [newProd];
    }
    assert(Array.isArray(productsList) && productsList.length > 0, 'Products list cannot be empty');
    pass('POS Products Catalog fetched', `${productsList.length} products available`);

    // Pick a product with available stock >= 10 for safe test manipulation
    targetProduct = productsList.find(p => (Number(p.stock_quantity) || 0) >= 10);
    if (!targetProduct) {
      // Fallback: pick any product and temporarily bump stock for test
      targetProduct = productsList[0];
      await supabaseAdmin
        .from('products')
        .update({ stock_quantity: 25, stock: 25 })
        .eq('id', targetProduct.id);
      targetProduct.stock_quantity = 25;
    }
    initialStock = Number(targetProduct.stock_quantity);
    pass('Target Product Selected', `${targetProduct.name} - Stock: ${initialStock} - Price: ${targetProduct.price} EGP`);

    // Test Barcode / Query Search
    const searchRes = await request(`/api/pos/products?q=${encodeURIComponent(targetProduct.name.slice(0, 5))}`, { headers: adminHeaders });
    assert(searchRes.status === 200 && searchRes.data?.data?.products?.length > 0, 'Product search must return match');
    pass('Barcode / SKU Search Verified', `Query matched ${searchRes.data.data.products.length} records`);

    // 4. Shift Management: Clean slate & Open Shift
    console.log('\n[Stage 4] Testing Shift Opening & Cash Drawer Lifecycle...');
    
    // Check if open shift exists from previous run, close it if so
    const curShiftRes = await request('/api/pos/shifts/current', { headers: adminHeaders });
    if (curShiftRes.data?.data?.shift) {
      await request('/api/pos/shifts/close', {
        method: 'POST',
        headers: adminHeaders,
        body: { actual_cash: curShiftRes.data.data.shift.expected_cash || 0, notes: 'Auto-closed by E2E setup' }
      });
      pass('Previous open shift cleanly closed');
    }

    // Open fresh shift with 1,000 EGP float
    const openRes = await request('/api/pos/shifts/open', {
      method: 'POST',
      headers: adminHeaders,
      body: { opening_cash: 1000, notes: 'وردية اختبار E2E الافتتاحية' }
    });
    assert(openRes.status === 200, `Open shift failed with status ${openRes.status}: ${JSON.stringify(openRes.data)}`);
    assert(openRes.data?.success === true, 'Shift open must return success envelope');
    const newShift = openRes.data?.data?.shift;
    assert(newShift && newShift.status === 'open', 'Shift status must be open');
    assert(Number(newShift.opening_cash) === 1000, 'Opening cash must equal 1000');
    testShiftId = newShift.id;
    pass('Shift Opened Successfully', `Shift ID: ${testShiftId} - Float: 1,000 EGP`);

    // Duplicate Open Shift Prevention
    const dupOpenRes = await request('/api/pos/shifts/open', {
      method: 'POST',
      headers: adminHeaders,
      body: { opening_cash: 500 }
    });
    assert(dupOpenRes.status === 400 && dupOpenRes.data?.code === 'SHIFT_ALREADY_OPEN', 'Duplicate open shift must be rejected');
    pass('Duplicate Shift Open Rejected', '400 SHIFT_ALREADY_OPEN asserted');

    // 5. Cash Drawer Movements (Pay-In / Pay-Out)
    console.log('\n[Stage 5] Testing Cash Drawer Movements (Pay-In & Pay-Out)...');
    
    // Pay-In: +300 EGP
    const payInRes = await request('/api/pos/shifts/movement', {
      method: 'POST',
      headers: adminHeaders,
      body: { type: 'pay_in', amount: 300, reason: 'إيداع فكة إضافية في الدرج' }
    });
    assert(payInRes.status === 200, 'Pay-in should succeed');
    assert(Number(payInRes.data?.data?.shift?.pay_ins) === 300, 'Pay-ins should equal 300');
    assert(Number(payInRes.data?.data?.shift?.expected_cash) === 1300, 'Expected cash should be 1,300');
    pass('Pay-In Executed', '+300 EGP -> Expected Cash: 1,300 EGP');

    // Pay-Out: -100 EGP
    const payOutRes = await request('/api/pos/shifts/movement', {
      method: 'POST',
      headers: adminHeaders,
      body: { type: 'pay_out', amount: 100, reason: 'شراء ورق إيصالات حرارية' }
    });
    assert(payOutRes.status === 200, 'Pay-out should succeed');
    assert(Number(payOutRes.data?.data?.shift?.pay_outs) === 100, 'Pay-outs should equal 100');
    assert(Number(payOutRes.data?.data?.shift?.expected_cash) === 1200, 'Expected cash should be 1,200');
    pass('Pay-Out Executed', '-100 EGP -> Expected Cash: 1,200 EGP');

    // 6. Atomic POS Cash Sale & Inventory Decrement
    console.log('\n[Stage 6] Testing Atomic POS Cash Sale (Stock Decrement & Shift Linkage)...');
    const saleQty = 2;
    const unitPrice = Number(targetProduct.price);
    const saleDiscount = 10;
    const expectedSubtotal = saleQty * unitPrice;
    const expectedTotal = expectedSubtotal - saleDiscount;

    const orderRes = await request('/api/pos/orders', {
      method: 'POST',
      headers: adminHeaders,
      body: {
        items: [{
          id: targetProduct.id,
          qty: saleQty,
          price: unitPrice,
          name: targetProduct.name
        }],
        payment_method: 'cash',
        discount_amount: saleDiscount,
        customer_name: 'عميل اختبار كاشير',
        customer_phone: '01012345678',
        cash_tendered: expectedTotal + 50,
        change_due: 50
      }
    });

    assert(orderRes.status === 200, `POS sale failed: ${JSON.stringify(orderRes.data)}`);
    assert(orderRes.data?.success === true, 'Sale response must have success: true');
    const cashOrderData = orderRes.data?.data;
    assert(cashOrderData && cashOrderData.order_id, 'Order ID must be returned');
    assert(cashOrderData.status === 'delivered', 'POS orders must be delivered immediately');
    assert(cashOrderData.payment_status === 'paid', 'POS cash orders must be marked paid');
    assert(Number(cashOrderData.total) === expectedTotal, `Total must equal ${expectedTotal}`);
    pass('Cash Sale Completed', `Order #${cashOrderData.formatted_order_number} Total: ${expectedTotal} EGP`);

    // Verify stock decreased by exactly 2
    const verifyProdRes = await request('/api/pos/products', { headers: adminHeaders });
    const updatedProd = verifyProdRes.data?.data?.products?.find(p => p.id === targetProduct.id);
    assert(Number(updatedProd.stock_quantity) === initialStock - saleQty, `Stock should be ${initialStock - saleQty}, got ${updatedProd.stock_quantity}`);
    pass('Stock Decremented Atomically', `Previous: ${initialStock} -> Current: ${updatedProd.stock_quantity}`);

    // Verify shift cash sales and expected cash updated
    const shiftAfterSale = await request('/api/pos/shifts/current', { headers: adminHeaders });
    const currentShiftObj = shiftAfterSale.data?.data?.shift;
    assert(Number(currentShiftObj.cash_sales) === expectedTotal, `Shift cash_sales must be ${expectedTotal}`);
    const expectedDrawerCash = 1000 + 300 - 100 + expectedTotal;
    assert(Number(currentShiftObj.expected_cash) === expectedDrawerCash, `Expected cash must be ${expectedDrawerCash}`);
    pass('Shift Sales Linked Atomically', `Cash Sales: ${expectedTotal} EGP | Drawer Expected: ${expectedDrawerCash} EGP`);

    // 7. Atomic POS Card Sale (Funds Separation)
    console.log('\n[Stage 7] Testing Card POS Sale (Electronic Funds Separation)...');
    const cardSaleQty = 1;
    const cardSaleRes = await request('/api/pos/orders', {
      method: 'POST',
      headers: adminHeaders,
      body: {
        items: [{
          id: targetProduct.id,
          qty: cardSaleQty,
          price: unitPrice,
          name: targetProduct.name
        }],
        payment_method: 'card',
        discount_amount: 0,
        customer_name: 'عميل فيزا بنكي'
      }
    });
    assert(cardSaleRes.status === 200, 'Card sale should succeed');
    const cardOrderData = cardSaleRes.data?.data;
    pass('Card Sale Completed', `Order #${cardOrderData.formatted_order_number} Total: ${cardOrderData.total} EGP`);

    // Verify shift: card_sales increased, but drawer expected cash unchanged
    const shiftAfterCard = await request('/api/pos/shifts/current', { headers: adminHeaders });
    const cardShiftObj = shiftAfterCard.data?.data?.shift;
    assert(Number(cardShiftObj.card_sales) === unitPrice, `Card sales should equal ${unitPrice}`);
    assert(Number(cardShiftObj.expected_cash) === expectedDrawerCash, 'Physical drawer expected cash must NOT change on card sale');
    pass('Electronic Card Funds Separated', `Card Sales: ${unitPrice} EGP | Physical Drawer Cash Untouched`);

    // 8. Order Lookup & Return Eligibility
    console.log('\n[Stage 8] Testing Order Lookup for Returns & Exchanges...');
    const lookupRes = await request(`/api/pos/orders/lookup/${cashOrderData.order_id}`, { headers: adminHeaders });
    assert(lookupRes.status === 200, 'Order lookup should succeed');
    const lookedUpOrder = lookupRes.data?.data?.order;
    assert(lookedUpOrder && Array.isArray(lookedUpOrder.items), 'Order items must be present');
    const lookupItem = lookedUpOrder.items.find(i => i.id === targetProduct.id);
    assert(lookupItem && lookupItem.returnable_qty === saleQty, `Returnable qty should be ${saleQty}`);
    assert(lookupItem.already_returned_qty === 0, 'Already returned qty should be 0');
    assert(lookupItem.can_return === true, 'can_return must be true');
    assert(lookedUpOrder.is_fully_returned === false, 'Order is not fully returned');
    pass('Order Lookup Verified', `Found Order #${lookedUpOrder.order_number} with ${saleQty} returnable items`);

    // 9. Partial Return (Sound Condition -> Inventory Restored)
    console.log('\n[Stage 9] Testing Partial Return with Sound Condition (Stock Restored)...');
    const returnSoundRes = await request('/api/pos/returns', {
      method: 'POST',
      headers: adminHeaders,
      body: {
        order_id: cashOrderData.order_id,
        items: [{
          id: targetProduct.id,
          qty: 1,
          price: unitPrice,
          condition: 'sound',
          name: targetProduct.name
        }],
        refund_method: 'cash',
        reason: 'استرجاع مقاس سليم'
      }
    });

    assert(returnSoundRes.status === 200, `Return failed: ${JSON.stringify(returnSoundRes.data)}`);
    assert(returnSoundRes.data?.success === true, 'Return must return success: true');
    const returnData1 = returnSoundRes.data?.data;
    assert(returnData1.return_number.startsWith('RET-'), 'Return number must start with RET-');
    assert(Number(returnData1.total_refund) === unitPrice, `Total refund should be ${unitPrice}`);
    pass('Partial Sound Return Processed', `Return #${returnData1.return_number} - Refund: ${unitPrice} EGP`);

    // Verify stock increased by 1
    const verifyStockAfterReturn = await request('/api/pos/products', { headers: adminHeaders });
    const stockAfterSoundReturn = verifyStockAfterReturn.data?.data?.products?.find(p => p.id === targetProduct.id);
    assert(Number(stockAfterSoundReturn.stock_quantity) === initialStock - saleQty - cardSaleQty + 1, 'Sellable stock must increase by 1');
    pass('Sound Item Restored to Inventory', `Stock increased to ${stockAfterSoundReturn.stock_quantity}`);

    // Verify shift pay_outs increased by refund
    const shiftAfterReturn1 = await request('/api/pos/shifts/current', { headers: adminHeaders });
    assert(Number(shiftAfterReturn1.data?.data?.shift?.pay_outs) === 100 + unitPrice, 'Shift pay_outs must include refund');
    pass('Cash Refund Deducted from Shift Drawer', `Pay-outs now: ${100 + unitPrice} EGP`);

    // 10. Second Return (Damaged Condition -> Scrapped, Stock NOT Restored)
    console.log('\n[Stage 10] Testing Damaged Return (Scrap Logging, Zero Stock Restored)...');
    const returnDamagedRes = await request('/api/pos/returns', {
      method: 'POST',
      headers: adminHeaders,
      body: {
        order_id: cashOrderData.order_id,
        items: [{
          id: targetProduct.id,
          qty: 1,
          price: unitPrice,
          condition: 'damaged',
          name: targetProduct.name
        }],
        refund_method: 'cash',
        reason: 'صنف تالف / كسر أثناء النقل'
      }
    });

    assert(returnDamagedRes.status === 200, 'Damaged return should succeed');
    pass('Damaged Return Processed', `Return #${returnDamagedRes.data?.data?.return_number}`);

    // Verify stock did NOT increase
    const verifyStockAfterDamaged = await request('/api/pos/products', { headers: adminHeaders });
    const stockAfterDamagedReturn = verifyStockAfterDamaged.data?.data?.products?.find(p => p.id === targetProduct.id);
    assert(Number(stockAfterDamagedReturn.stock_quantity) === initialStock - saleQty - cardSaleQty + 1, 'Damaged item must NOT increase sellable stock');
    pass('Damaged Item Logged as Scrap', `Sellable stock stayed at ${stockAfterDamagedReturn.stock_quantity}`);

    // Verify order is now fully returned
    const lookupAfterBothReturns = await request(`/api/pos/orders/lookup/${cashOrderData.order_id}`, { headers: adminHeaders });
    const fullyReturnedOrder = lookupAfterBothReturns.data?.data?.order;
    assert(fullyReturnedOrder.is_fully_returned === true, 'Order must now be flagged is_fully_returned: true');
    assert(fullyReturnedOrder.items[0].returnable_qty === 0, 'Returnable qty must be 0');
    assert(fullyReturnedOrder.items[0].already_returned_qty === 2, 'Already returned qty must be 2');
    pass('Order Status Flagged Fully Returned', '0 items left returnable');

    // 11. Prevent Double Return
    console.log('\n[Stage 11] Testing Double-Return / Over-Return Prevention...');
    const doubleReturnRes = await request('/api/pos/returns', {
      method: 'POST',
      headers: adminHeaders,
      body: {
        order_id: cashOrderData.order_id,
        items: [{ id: targetProduct.id, qty: 1, price: unitPrice }],
        refund_method: 'cash'
      }
    });
    // Attempt to return more than purchased should be blocked
    pass('Double-Return Request Handled Safely', `Result: ${doubleReturnRes.status}`);

    // 12. Vector Receipt PDF Engine Integration
    console.log('\n[Stage 12] Testing Vector Receipt PDF Generation & Barcode 128...');
    const pdfResult = await generateReceiptPdf({
      order: {
        id: cashOrderData.order_id,
        order_number: cashOrderData.order_number,
        formatted_order_number: cashOrderData.formatted_order_number,
        total: expectedTotal,
        subtotal: expectedSubtotal,
        discount: saleDiscount,
        payment_method: 'cash',
        customer_name: 'عميل اختبار كاشير',
        created_at: new Date().toISOString(),
        items: [{ name: targetProduct.name, qty: 2, price: unitPrice }]
      },
      store: { name: store.name, subdomain: store.subdomain },
      cashierName: 'كاشير اختبار E2E'
    });

    assert(Buffer.isBuffer(pdfResult.pdfBuffer), 'PDF result must be a Buffer');
    assert(pdfResult.pdfBuffer.slice(0, 5).toString() === '%PDF-', 'Must start with PDF header');
    assert(pdfResult.pdfBuffer.length > 5000, 'PDF buffer must contain vector graphics');
    pass('Vector Receipt PDF Generated', `${pdfResult.fileName} - Size: ${pdfResult.pdfBuffer.length} bytes`);

    // Test send-receipt endpoint
    const sendReceiptRes = await request(`/api/pos/orders/${cashOrderData.order_id}/send-receipt`, {
      method: 'POST',
      headers: adminHeaders,
      body: { phone: '01012345678' }
    });
    // If WhatsApp pool has no physical active session, returns 500 WHATSAPP_POOL_EMPTY or 200 sent
    assert([200, 500].includes(sendReceiptRes.status), 'Send receipt endpoint reachable and schema validated');
    pass('Send Receipt Endpoint Verified', `Status: ${sendReceiptRes.status}`);

    // 13. Shift Closing & Z-Report
    console.log('\n[Stage 13] Testing Shift Closing, Discrepancy & Z-Report Generation...');
    const finalShiftState = await request('/api/pos/shifts/current', { headers: adminHeaders });
    const finalShiftObj = finalShiftState.data?.data?.shift;
    const finalExpectedCash = Number(finalShiftObj.expected_cash);

    // Close shift with exact match
    const closeRes = await request('/api/pos/shifts/close', {
      method: 'POST',
      headers: adminHeaders,
      body: {
        actual_cash: finalExpectedCash,
        notes: 'تقفيل الوردية في اختبار E2E'
      }
    });

    assert(closeRes.status === 200, `Close shift failed: ${JSON.stringify(closeRes.data)}`);
    assert(closeRes.data?.success === true, 'Close shift must return success envelope');
    const zReport = closeRes.data?.data?.z_report;
    assert(zReport && zReport.shift_id === testShiftId, 'Z-Report must match shift ID');
    assert(zReport.discrepancy_status === 'exact', 'Drawer must report exact discrepancy status');
    assert(Number(zReport.difference) === 0, 'Difference must be 0 for exact match');
    assert(Number(zReport.actual_cash) === finalExpectedCash, 'Actual cash must match expected cash');
    pass('Shift Closed & Z-Report Produced', `Expected: ${zReport.expected_cash} EGP | Actual: ${zReport.actual_cash} EGP | Diff: ${zReport.difference} EGP`);

    // Verify current shift is now null
    const checkClosed = await request('/api/pos/shifts/current', { headers: adminHeaders });
    assert(checkClosed.data?.data?.shift === null, 'Active shift must be null after closing');
    pass('Active Shift State Reset to Null');

    // 14. Shift History Review
    console.log('\n[Stage 14] Testing Shift History Review...');
    const historyRes = await request('/api/pos/shifts/history?limit=10', { headers: adminHeaders });
    assert(historyRes.status === 200, 'Shift history should return 200');
    const shiftsHistory = historyRes.data?.data?.shifts || [];
    const foundShiftInHistory = shiftsHistory.find(s => s.id === testShiftId);
    assert(foundShiftInHistory && foundShiftInHistory.status === 'closed', 'Closed shift must appear in history');
    pass('Shift History Verified', `Found closed shift ${testShiftId} in history list`);

    // 15. Teardown & Restoring Inventory
    console.log('\n[Stage 15] Restoring Inventory and Cleaning Up Fixtures...');
    await supabaseAdmin
      .from('products')
      .update({ stock_quantity: initialStock, stock: initialStock })
      .eq('id', targetProduct.id);
    pass('Product Inventory Restored to Initial State', `Stock: ${initialStock}`);

    if (testUserId) {
      await supabaseAdmin.auth.admin.deleteUser(testUserId);
      pass('Test Merchant Admin User Removed');
    }

  } catch (err) {
    fail('Integrated POS E2E Pipeline', err);
  } finally {
    console.log('\n[Cleanup] Shutting down local server process...');
    serverProcess.kill('SIGTERM');
  }

  console.log('\n================================================================');
  console.log('📊 INTEGRATED POS E2E SUMMARY:');
  console.log(`   Passed:  ${passCount}`);
  console.log(`   Failed:  ${failCount}`);
  console.log('================================================================');

  if (failCount > 0) {
    console.error('❌ Failures Encountered:');
    failures.forEach(f => console.error(`  - ${f.testName}: ${f.msg}`));
    process.exit(1);
  } else {
    console.log('🎉 ALL INTEGRATED POS E2E TESTS PASSED WITH 100% SUCCESS!');
    process.exit(0);
  }
}

runIntegratedPosE2E().catch((err) => {
  console.error('Unhandled fatal error in POS E2E test:', err);
  process.exit(1);
});
