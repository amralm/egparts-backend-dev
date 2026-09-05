'use strict';

require('dotenv').config();
const assert = require('assert');
const { supabase } = require('../services/supabase');

async function runPosSecurityE2ETests() {
  console.log('====================================================');
  console.log('🛡️  STARTING POS SECURITY & SERVER-SIDE HARDENING E2E');
  console.log('====================================================\n');

  // 1. Fetch active test tenant and an active product
  const { data: store, error: storeErr } = await supabase
    .from('stores')
    .select('id, name, subdomain')
    .eq('subdomain', 'alam')
    .maybeSingle();

  assert(!storeErr && store, 'Tenant "alam" must exist in database');
  console.log(`[Setup] Using Tenant: ${store.name} (${store.subdomain}) ID: ${store.id}`);

  const { data: product, error: prodErr } = await supabase
    .from('products')
    .select('id, name, price, stock_quantity')
    .eq('store_id', store.id)
    .eq('is_active', true)
    .gt('stock_quantity', 5)
    .limit(1)
    .single();

  assert(!prodErr && product, 'An active in-stock product must exist for testing');
  const officialPrice = Number(product.price);
  console.log(`[Setup] Target Product: "${product.name}" (Official DB Price: ${officialPrice} EGP, Stock: ${product.stock_quantity})`);

  // ----------------------------------------------------
  // TEST 1: Price Tampering Defense in create_pos_order_atomic
  // ----------------------------------------------------
  console.log('\n[Test 1] Testing POS Price Tampering Defense (Client injects 0.01 EGP)...');
  const tamperedItem = [
    {
      id: product.id,
      qty: 2,
      price: 0.01,
      name: product.name
    }
  ];

  const { data: orderRes, error: orderErr } = await supabase.rpc('create_pos_order_atomic', {
    p_store_id: store.id,
    p_user_id: null,
    p_items: tamperedItem,
    p_payment_method: 'cash',
    p_discount_amount: 0,
    p_customer_name: 'عميل اختبار أمني E2E',
    p_customer_phone: '01000000000',
    p_notes: 'SECURITY_E2E_ORDER'
  });

  assert(!orderErr, `Order creation should succeed: ${orderErr?.message}`);
  const createdOrder = Array.isArray(orderRes) ? orderRes[0] : orderRes;
  assert(createdOrder?.success, 'Order RPC must return success: true');

  const expectedSubtotal = officialPrice * 2;
  assert.strictEqual(
    Number(createdOrder.subtotal),
    expectedSubtotal,
    `Order subtotal MUST be official price (${expectedSubtotal}), but got ${createdOrder.subtotal}`
  );
  assert.strictEqual(
    Number(createdOrder.total),
    expectedSubtotal,
    `Order total MUST match official DB price calculation (${expectedSubtotal}), but got ${createdOrder.total}`
  );
  console.log(`  ✓ SUCCESS: Client price (0.01 EGP) was REJECTED.`);
  console.log(`  ✓ Subtotal was computed from database product record: ${createdOrder.subtotal} EGP.`);

  const testOrderId = createdOrder.order_id;

  // ----------------------------------------------------
  // TEST 2: Return Price Tampering Defense in create_pos_return_atomic
  // ----------------------------------------------------
  console.log('\n[Test 2] Testing POS Return Price Tampering (Client requests 999,999 EGP refund)...');
  const tamperedReturnItems = [
    {
      id: product.id,
      qty: 1,
      price: 999999,
      condition: 'sound',
      name: product.name
    }
  ];

  const { data: returnRes, error: returnErr } = await supabase.rpc('create_pos_return_atomic', {
    p_store_id: store.id,
    p_order_id: testOrderId,
    p_user_id: null,
    p_items: tamperedReturnItems,
    p_refund_method: 'cash',
    p_reason: 'SECURITY_TEST_TAMPERED_PRICE'
  });

  assert(!returnErr, `Return RPC should succeed: ${returnErr?.message}`);
  const createdReturn = Array.isArray(returnRes) ? returnRes[0] : returnRes;
  assert(createdReturn?.success, 'Return RPC must return success: true');

  assert.strictEqual(
    Number(createdReturn.total_refund),
    officialPrice,
    `Total refund MUST equal original item unit_price (${officialPrice} EGP), but got ${createdReturn.total_refund} EGP`
  );
  console.log(`  ✓ SUCCESS: Client-injected refund price (999,999 EGP) was REJECTED.`);
  console.log(`  ✓ Refund amount was computed strictly from original invoice: ${createdReturn.total_refund} EGP.`);

  // ----------------------------------------------------
  // TEST 3: Excess Return Quantity Prevention
  // ----------------------------------------------------
  console.log('\n[Test 3] Testing Excess Return Quantity Prevention (Trying to return 5 units when only 1 is left)...');
  const excessReturnItems = [
    {
      id: product.id,
      qty: 5,
      condition: 'sound',
      name: product.name
    }
  ];

  const { data: excessRes, error: excessErr } = await supabase.rpc('create_pos_return_atomic', {
    p_store_id: store.id,
    p_order_id: testOrderId,
    p_user_id: null,
    p_items: excessReturnItems,
    p_refund_method: 'cash',
    p_reason: 'SECURITY_TEST_EXCESS_RETURN'
  });

  assert(excessErr, 'Excess return quantity MUST throw an error');
  console.log(`  ✓ SUCCESS: Excess return blocked with error: "${excessErr.message}"`);

  // ----------------------------------------------------
  // TEST 4: Non-existent Item Return Prevention
  // ----------------------------------------------------
  console.log('\n[Test 4] Testing Non-existent Item Return Prevention (Item not in order)...');
  const bogusProductId = '00000000-0000-0000-0000-000000000001';
  const bogusReturnItems = [
    {
      id: bogusProductId,
      qty: 1,
      condition: 'sound',
      name: 'Unbought Product'
    }
  ];

  const { data: bogusRes, error: bogusErr } = await supabase.rpc('create_pos_return_atomic', {
    p_store_id: store.id,
    p_order_id: testOrderId,
    p_user_id: null,
    p_items: bogusReturnItems,
    p_refund_method: 'cash',
    p_reason: 'SECURITY_TEST_BOGUS_ITEM'
  });

  assert(bogusErr, 'Returning an unbought item MUST throw an error');
  console.log(`  ✓ SUCCESS: Bogus item return blocked with error: "${bogusErr.message}"`);

  // ----------------------------------------------------
  // TEST 5: Cashier Role Permission Isolation
  // ----------------------------------------------------
  console.log('\n[Test 5] Testing Cashier Role Permission Isolation...');
  const { resolveStorePermissions } = require('../middleware/auth');
  const cashierPermissions = await resolveStorePermissions('test-cashier-id', store.id, { role: 'cashier' });

  assert(Array.isArray(cashierPermissions), 'Cashier permissions must be an array');
  assert(cashierPermissions.includes('tenant.orders.write'), 'Cashier must have POS write permission');
  assert(cashierPermissions.includes('orders.create'), 'Cashier must have POS order create permission');
  assert(!cashierPermissions.includes('products.create'), 'Cashier MUST NOT have products.create permission');
  assert(!cashierPermissions.includes('products.delete'), 'Cashier MUST NOT have products.delete permission');
  assert(!cashierPermissions.includes('settings.update'), 'Cashier MUST NOT have settings.update permission');
  assert(!cashierPermissions.includes('platform.stores.manage'), 'Cashier MUST NOT have platform permissions');

  console.log(`  ✓ SUCCESS: Cashier permissions strictly isolated (${cashierPermissions.length} allowed POS permissions).`);
  console.log(`  ✓ Administrative permissions (products.create/delete, settings.update) strictly denied.`);

  // Cleanup: Delete the test order and return record
  console.log('\n[Cleanup] Cleaning up test order and return records...');
  await supabase.from('pos_returns').delete().eq('order_id', testOrderId);
  await supabase.from('order_items').delete().eq('order_id', testOrderId);
  await supabase.from('order_tracking').delete().eq('order_id', testOrderId);
  await supabase.from('orders').delete().eq('id', testOrderId);
  console.log('  ✓ Test artifacts cleaned up successfully.');

  console.log('\n====================================================');
  console.log('🎉 ALL 5 POS SECURITY E2E GATES PASSED (100% EXIT 0)');
  console.log('====================================================\n');
}

runPosSecurityE2ETests().catch((err) => {
  console.error('\n❌ POS SECURITY E2E TEST FAILED:', err.message);
  process.exit(1);
});
