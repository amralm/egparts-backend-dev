const express = require('express');
const router = express.Router();
const axios = require('axios');
const crypto = require('crypto');
const { verifyUser } = require('../middleware/auth');
const { supabase } = require('../services/supabase');
const { decryptCredentials, getEncryptionKeyForVersion } = require('../utils/crypto');

const PAYMOB_API_KEY = process.env.PAYMOB_API_KEY;
const INTEGRATION_ID = process.env.PAYMOB_INTEGRATION_ID;
const IFRAME_ID = process.env.PAYMOB_IFRAME_ID;
const PAYMOB_HMAC_SECRET = process.env.PAYMOB_HMAC_SECRET;

const axiosPaymob = axios.create({ timeout: 10000 });

// ===== HMAC Verification Middleware =====
async function verifyPaymobHMAC(req, res, next) {
  if (!req.body || !req.body.obj || !req.body.hmac) {
    return res.status(400).json({ error: 'Invalid webhook payload' });
  }

  const receivedHmac = req.body.hmac;
  const obj = req.body.obj;
  const paymobOrderId = String(obj.order?.id || '');

  let hmacSecret = process.env.PAYMOB_HMAC_SECRET;

  if (paymobOrderId) {
    try {
      const { data: order } = await supabase
        .from('orders')
        .select('store_id')
        .eq('paymob_order_id', paymobOrderId)
        .single();
      
      if (order?.store_id) {
        const { data: gateway } = await supabase
          .from('store_payment_gateways')
          .select('credentials, key_version')
          .eq('store_id', order.store_id)
          .eq('provider_name', 'paymob')
          .eq('is_active', true)
          .maybeSingle();
        
        if (gateway?.credentials) {
          const key = getEncryptionKeyForVersion(gateway.key_version);
          const decryptedCreds = decryptCredentials(gateway.credentials, key);
          if (decryptedCreds?.hmac_secret) {
            hmacSecret = decryptedCreds.hmac_secret;
          }
        }
      }
    } catch (err) {
      console.error('Error fetching store HMAC secret:', err.message);
    }
  }

  const concatFields = [
    obj.amount_cents, obj.created_at, obj.currency, obj.error_occured,
    obj.has_parent_transaction, obj.id, obj.integration_id, obj.is_3d_secure,
    obj.is_auth, obj.is_capture, obj.is_refunded, obj.is_standalone_payment,
    obj.is_voided, obj.order?.id, obj.owner, obj.pending,
    obj.source_data?.pan, obj.source_data?.sub_type, obj.source_data?.type, obj.success,
  ].map(v => String(v ?? ''));

  const computedHmac = crypto
    .createHmac('sha512', hmacSecret)
    .update(concatFields.join(''))
    .digest('hex');

  // ✅ Fix: check length equality before timingSafeEqual to prevent runtime throw
  if (computedHmac.length !== receivedHmac.length) {
    console.error('HMAC length mismatch. Possible forged request.');
    return res.status(401).json({ error: 'Invalid HMAC signature' });
  }

  // ✅ Timing-safe comparison (prevents timing attacks)
  const isValid = crypto.timingSafeEqual(
    Buffer.from(computedHmac, 'hex'),
    Buffer.from(receivedHmac, 'hex')
  );

  if (!isValid) {
    console.error('HMAC mismatch! Potential forged webhook.');
    return res.status(401).json({ error: 'Invalid HMAC signature' });
  }

  next();
}

// ===== STEP 1: Create Payment Intent =====
router.post('/create', verifyUser, async (req, res) => {
  const { orderId } = req.body;

  try {
    const { data: order, error: orderError } = await supabase
      .from('orders').select('*')
      .eq('id', orderId)
      .eq('user_id', req.user.sub)
      .eq('store_id', req.store.id)
      .single(); // Supabase JWT uses 'sub'

    if (orderError || !order) return res.status(404).json({ error: 'Order not found' });
    if (order.payment_status === 'paid') return res.status(400).json({ error: 'Order already paid' });

    // Fetch store-specific payment gateway settings from table and decrypt in-memory
    const { data: gateway } = await supabase
      .from('store_payment_gateways')
      .select('credentials, key_version')
      .eq('store_id', req.store.id)
      .eq('provider_name', 'paymob')
      .eq('is_active', true)
      .maybeSingle();

    let credentials = {};
    if (gateway?.credentials) {
      const key = getEncryptionKeyForVersion(gateway.key_version);
      credentials = decryptCredentials(gateway.credentials, key) || {};
    }
    const apiKey = credentials.api_key || process.env.PAYMOB_API_KEY;
    const integrationId = credentials.integration_id || process.env.PAYMOB_INTEGRATION_ID;
    const iframeId = credentials.iframe_id || process.env.PAYMOB_IFRAME_ID;

    if (!apiKey || !integrationId || !iframeId) {
      return res.status(400).json({ error: 'بوابة الدفع الإلكتروني غير مهيأة لهذا المتجر حالياً. يرجى اختيار وسيلة دفع أخرى.' });
    }

    const amountCents = Math.round(order.total * 100);

    const authRes = await axiosPaymob.post('https://accept.paymob.com/api/auth/tokens', { api_key: apiKey });
    const token = authRes.data.token;

    const paymobOrderRes = await axiosPaymob.post('https://accept.paymob.com/api/ecommerce/orders', {
      auth_token: token, delivery_needed: false, amount_cents: amountCents, currency: 'EGP', items: []
    });

    const paymentKeyRes = await axiosPaymob.post('https://accept.paymob.com/api/acceptance/payment_keys', {
      auth_token: token, amount_cents: amountCents, expiration: 3600,
      order_id: paymobOrderRes.data.id,
      billing_data: {
        first_name: req.user.user_metadata?.name?.split(' ')[0] || 'Customer',
        last_name: req.user.user_metadata?.name?.split(' ')[1] || 'User',
        email: req.user.email || 'customer@egparts.com', phone_number: order.phone,
        apartment: 'NA', floor: 'NA', street: order.address, building: 'NA',
        shipping_method: 'NA', postal_code: 'NA', city: order.city, country: 'EG', state: 'NA'
      },
      currency: 'EGP', integration_id: integrationId
    });

    const paymentUrl = `https://accept.paymob.com/api/acceptance/iframes/${iframeId}?payment_token=${paymentKeyRes.data.token}`;
    await supabase.from('orders').update({ paymob_order_id: String(paymobOrderRes.data.id) }).eq('id', orderId).eq('store_id', req.store.id);

    return res.json({ success: true, payment_url: paymentUrl, orderId: order.id });

  } catch (error) {
    console.error('Paymob Error:', error.response?.data || error.message);
    return res.status(500).json({ error: 'Failed to initiate payment' });
  }
});

// ===== STEP 2: Webhook =====
router.post('/webhook', verifyPaymobHMAC, async (req, res) => {
  const { obj } = req.body;

  try {
    const isSuccess = obj.success === true;
    const paymobOrderId = String(obj.order.id);
    const paymobTransactionId = String(obj.id); // ✅ Transaction-level tracking

    const { data: order } = await supabase
      .from('orders').select('*').eq('paymob_order_id', paymobOrderId).single();

    if (!order) {
      console.error('Order not found for Paymob ID:', paymobOrderId);
      return res.sendStatus(404);
    }

    if (isSuccess) {
      // ✅ Replay Attack Guard: block same transaction from being processed twice
      if (order.paymob_transaction_id === paymobTransactionId) {
        console.log(`Replay attack blocked for Transaction ${paymobTransactionId}`);
        return res.sendStatus(200);
      }

      // ✅ Atomic DB update — only proceeds if stock_decremented is still false
      const { data: updatedOrder, error: updateError } = await supabase
        .from('orders')
        .update({
          payment_status: 'paid',
          status: 'confirmed',
          stock_decremented: true,
          paymob_transaction_id: paymobTransactionId, // ✅ Store for replay prevention
          payment_details: obj
        })
        .eq('id', order.id)
        .eq('stock_decremented', false) // 🔥 DB-level race condition guard
        .select().single();

      if (updateError || !updatedOrder) {
        console.log(`Concurrent or duplicate webhook ignored for Order ${order.id}`);
        return res.sendStatus(200);
      }

      // ✅ Parallel stock decrement (faster + cleaner) — card orders only
      if (order.payment_method === 'card') {
        await Promise.all(
          order.items.map(item =>
            supabase.rpc('decrement_stock', { p_id: item.id, p_qty: item.qty })
          )
        );
      }

      console.log(`✅ Order ${order.id} confirmed | Transaction ${paymobTransactionId}`);

    } else {
      await supabase.from('orders')
        .update({ payment_status: 'failed', payment_details: obj })
        .eq('id', order.id);
      console.log(`❌ Order ${order.id} payment failed.`);
    }

    res.sendStatus(200);

  } catch (err) {
    console.error('Webhook Error:', err.message);
    res.sendStatus(500);
  }
});

module.exports = router;
