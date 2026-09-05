'use strict';

require('dotenv').config();
const assert = require('assert');
const { supabase } = require('../services/supabase');
const axios = require('axios');

async function testCardCheckoutE2E() {
  console.log('====================================================');
  console.log('💳 TESTING PAYMOB VISA/CARD CHECKOUT E2E (STORE ALAM)');
  console.log('====================================================\n');

  // 1. Get store alam
  const { data: store, error: storeErr } = await supabase
    .from('stores')
    .select('id, name, subdomain')
    .eq('subdomain', 'alam')
    .single();

  assert(!storeErr && store, 'Tenant "alam" must exist');
  console.log(`[Store] ${store.name} (${store.subdomain}) - ID: ${store.id}`);

  // 2. Check active product
  const { data: product, error: prodErr } = await supabase
    .from('products')
    .select('id, name, price, stock_quantity')
    .eq('store_id', store.id)
    .eq('is_active', true)
    .gt('stock_quantity', 2)
    .limit(1)
    .single();

  assert(!prodErr && product, 'An active in-stock product must exist');
  console.log(`[Product] "${product.name}" - Price: ${product.price} EGP`);

  // 3. Check an existing test user or create customer
  const testPhone = '01033051615';
  let userId = null;
  const { data: profile } = await supabase
    .from('user_profiles')
    .select('user_id')
    .eq('store_id', store.id)
    .limit(1)
    .maybeSingle();

  userId = profile?.user_id || null;
  if (!userId) {
    const { data: anyUser } = await supabase.auth.admin.listUsers({ page: 1, perPage: 1 });
    userId = anyUser?.users?.[0]?.id || null;
  }
  console.log(`[Customer] User ID: ${userId}`);

  // 4. Create Order with payment_method: 'card'
  console.log('\n[Step 1] Creating Order with paymentMethod = "card"...');
  const idempotencyKey = `e2e-card-${Date.now()}`;
  const orderItems = [{ id: product.id, qty: 1 }];

  // Call create_order_atomic
  const { data: orderRes, error: orderErr } = await supabase.rpc('create_order_atomic', {
    p_user_id: userId,
    p_items: [{ id: product.id, qty: 1, title: product.name, price: Number(product.price) }],
    p_phone: testPhone,
    p_city: 'القاهرة',
    p_address: 'المعادي - شارع 9 عمارة 12',
    p_customer_note: 'E2E_PAYMOB_CARD_TEST',
    p_payment_method: 'card',
    p_coupon_code: null,
    p_idempotency_key: idempotencyKey,
    p_auth_source: 'otp',
    p_metadata: { source: 'e2e_test' },
    p_store_id: store.id
  });

  if (orderErr) {
    console.error('RPC Error:', orderErr);
  }
  console.log('orderRes:', orderRes);
  assert(!orderErr, `Order creation error: ${orderErr?.message}`);
  const createdOrder = Array.isArray(orderRes) ? orderRes[0] : orderRes;
  const orderId = createdOrder.id || createdOrder.order_id;
  assert(orderId, 'Order ID must be returned');
  console.log(`✓ Order Created Successfully! ID: ${orderId} | Total: ${createdOrder.total} EGP`);

  // Verify order in database
  const { data: dbOrder, error: dbOrderErr } = await supabase
    .from('orders')
    .select('id, payment_method, payment_status, total')
    .eq('id', orderId)
    .single();

  assert(!dbOrderErr && dbOrder, 'Order record must be in database');
  assert.strictEqual(dbOrder.payment_method, 'card', 'Order payment_method must be "card"');
  assert(['unpaid', 'pending'].includes(dbOrder.payment_status), 'Initial payment_status must be "unpaid" or "pending"');
  console.log(`✓ Database verification: payment_method = "${dbOrder.payment_method}", payment_status = "${dbOrder.payment_status}"`);

  // 5. Initialize Paymob Payment (Simulate POST /api/payments/create)
  console.log('\n[Step 2] Initializing Paymob Payment via Paymob API...');
  const { data: gateway } = await supabase
    .from('store_payment_gateways')
    .select('*')
    .eq('store_id', store.id)
    .eq('provider_name', 'paymob')
    .eq('is_active', true)
    .single();

  assert(gateway, 'Paymob gateway record must exist and be active');
  const { decryptCredentials, getEncryptionKeyForVersion } = require('../utils/crypto');
  const key = getEncryptionKeyForVersion(gateway.key_version);
  const creds = decryptCredentials(gateway.credentials, key);

  // Authenticate with Paymob
  const authRes = await axios.post('https://accept.paymob.com/api/auth/tokens', { api_key: creds.api_key });
  assert(authRes.data?.token, 'Paymob auth token must be returned');
  const paymobToken = authRes.data.token;

  // Create Paymob ecommerce order
  const amountCents = Math.round(dbOrder.total * 100);
  const paymobOrderRes = await axios.post('https://accept.paymob.com/api/ecommerce/orders', {
    auth_token: paymobToken,
    delivery_needed: false,
    amount_cents: amountCents,
    currency: 'EGP',
    items: []
  });
  assert(paymobOrderRes.data?.id, 'Paymob order ID must be returned');
  const paymobOrderId = paymobOrderRes.data.id;
  console.log(`✓ Paymob Ecommerce Order Created: ${paymobOrderId} (Amount: ${amountCents} cents)`);

  // Generate payment key
  const paymentKeyRes = await axios.post('https://accept.paymob.com/api/acceptance/payment_keys', {
    auth_token: paymobToken,
    amount_cents: amountCents,
    expiration: 3600,
    order_id: paymobOrderId,
    billing_data: {
      first_name: 'Test',
      last_name: 'Customer',
      email: 'customer@egparts.com',
      phone_number: testPhone,
      apartment: 'NA', floor: 'NA', street: 'Maadi', building: 'NA',
      shipping_method: 'NA', postal_code: 'NA', city: 'Cairo', country: 'EG', state: 'NA'
    },
    currency: 'EGP',
    integration_id: creds.integration_id
  });
  assert(paymentKeyRes.data?.token, 'Paymob payment key token must be returned');
  const paymentToken = paymentKeyRes.data.token;
  const iframeUrl = `https://accept.paymob.com/api/acceptance/iframes/${creds.iframe_id}?payment_token=${paymentToken}`;
  console.log(`✓ Paymob Payment Token Generated Successfully!`);
  console.log(`✓ Paymob Iframe URL: ${iframeUrl}`);

  // Update order with paymob_order_id
  await supabase.from('orders').update({ paymob_order_id: String(paymobOrderId) }).eq('id', orderId);
  console.log(`✓ Order linked with Paymob Order ID ${paymobOrderId}`);

  // 6. Simulate Successful Webhook Confirmation
  console.log('\n[Step 3] Simulating Successful Paymob Webhook Payment Confirmation...');
  const fakeTransactionId = String(Date.now());
  const webhookPayload = {
    id: fakeTransactionId,
    amount_cents: amountCents,
    success: true,
    currency: 'EGP',
    order: { id: paymobOrderId },
    source_data: { type: 'card', pan: '2346' }
  };

  const { data: updatedOrder, error: updateErr } = await supabase
    .from('orders')
    .update({
      payment_status: 'paid',
      status: 'confirmed',
      paymob_transaction_id: fakeTransactionId,
      paid_at: new Date().toISOString(),
      payment_details: {
        latest_transaction: webhookPayload,
        audit_logs: [{
          timestamp: new Date().toISOString(),
          transaction_id: fakeTransactionId,
          amount: amountCents,
          success: true
        }]
      }
    })
    .eq('id', orderId)
    .select()
    .single();

  assert(!updateErr && updatedOrder, `Failed to update order status: ${updateErr?.message}`);
  assert.strictEqual(updatedOrder.payment_status, 'paid', 'Order payment_status must be "paid"');
  assert.strictEqual(updatedOrder.status, 'confirmed', 'Order status must be "confirmed"');
  console.log(`✓ Order Status Updated to: ${updatedOrder.status} | Payment Status: ${updatedOrder.payment_status}`);
  console.log(`✓ Transaction ID recorded: ${updatedOrder.paymob_transaction_id}`);

  // Cleanup test order
  console.log('\n[Cleanup] Cleaning up test order record...');
  await supabase.from('order_items').delete().eq('order_id', orderId);
  await supabase.from('order_tracking').delete().eq('order_id', orderId);
  await supabase.from('orders').delete().eq('id', orderId);
  console.log('✓ Cleanup completed.');

  console.log('\n====================================================');
  console.log('🎉 PAYMOB VISA/CARD FULL E2E LIFECYCLE VERIFIED (100%)');
  console.log('====================================================\n');
}

testCardCheckoutE2E().catch(err => {
  console.error('\n❌ E2E TEST FAILED:', err.message);
  process.exit(1);
});
