const express = require('express');
const router = express.Router();
const axios = require('axios');
const crypto = require('crypto');
const rateLimit = require('express-rate-limit');
const { verifyUser, verifyPermission } = require('../middleware/auth');
const { supabase } = require('../services/supabase');
const { decryptCredentials, encryptCredentials, getEncryptionKeyForVersion } = require('../utils/crypto');

const paymentRateLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 5,
  message: { error: 'طلبات إنشاء الدفع كثيرة جداً، حاول بعد دقيقة' },
  standardHeaders: true,
  legacyHeaders: false,
});

const paymentSetupRateLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 5,
  message: { error: 'طلبات إعدادات الدفع كثيرة جداً، حاول بعد دقيقة' },
  standardHeaders: true,
  legacyHeaders: false,
});


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

// ===== GET Active Payment Gateways (Public) =====
router.get('/active', async (req, res) => {
  if (!req.store?.id) {
    return res.status(404).json({ error: 'Store not found' });
  }

  try {
    const { data: gateways } = await supabase
      .from('store_payment_gateways')
      .select('provider_name')
      .eq('store_id', req.store.id)
      .eq('is_active', true);

    const activeProviders = (gateways || []).map(g => g.provider_name);
    return res.json({ active_providers: activeProviders });
  } catch (err) {
    console.error('Fetch active gateways error:', err.message);
    return res.status(500).json({ error: 'Failed to fetch active gateways' });
  }
});

// ===== GET Store Payment Settings (Admin Only) =====
router.get('/settings', verifyPermission('payments.view'), async (req, res) => {
  try {
    // 1. Get active subscription
    const { data: subscription } = await supabase
      .from('store_subscriptions')
      .select('plan_id')
      .eq('store_id', req.store.id)
      .eq('status', 'active')
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();

    if (!subscription) {
      return res.status(403).json({ error: 'عذراً، يجب أن يكون لديك اشتراك نشط لتفعيل بوابات الدفع.' });
    }

    // 2. Check if payment_gateways feature is enabled for this plan
    const { data: featureCheck } = await supabase
      .from('plan_features')
      .select('id, features!inner(key)')
      .eq('plan_id', subscription.plan_id)
      .eq('features.key', 'payment_gateways')
      .maybeSingle();

    let isEnabled = false;
    if (featureCheck) {
      const { data: limit } = await supabase
        .from('feature_limits')
        .select('limit_config')
        .eq('plan_feature_id', featureCheck.id)
        .eq('limit_type', 'boolean')
        .maybeSingle();
      
      // If no limit is found, default to enabled since the feature exists in plan_features.
      isEnabled = !limit || limit.limit_config?.enabled === true;
    }

    if (!isEnabled) {
      return res.json({ 
        allowed: false,
        error: 'بوابات الدفع الإلكتروني (Paymob) غير متوفرة في باقتك الحالية. يرجى الترقية للباقة الاحترافية أو أعلى لتفعيلها.' 
      });
    }

    // 3. Fetch gateway settings for this store
    const { data: gateway } = await supabase
      .from('store_payment_gateways')
      .select('*')
      .eq('store_id', req.store.id)
      .eq('provider_name', 'paymob')
      .maybeSingle();

    let config = {
      is_active: false,
      api_key: '',
      integration_id: '',
      iframe_id: '',
      hmac_secret: ''
    };

    if (gateway) {
      config.is_active = gateway.is_active;
      let credentials = {};
      if (gateway.credentials) {
        const key = getEncryptionKeyForVersion(gateway.key_version);
        credentials = decryptCredentials(gateway.credentials, key) || {};
      }
      config.api_key = credentials.api_key ? 'd_••••••••••••••••' + credentials.api_key.slice(-4) : '';
      config.integration_id = credentials.integration_id || '';
      config.iframe_id = credentials.iframe_id || '';
      config.hmac_secret = credentials.hmac_secret ? 'd_••••••••••••••••' + credentials.hmac_secret.slice(-4) : '';
    }

    return res.json({ allowed: true, config });
  } catch (err) {
    console.error('Fetch payment settings error:', err.message);
    return res.status(500).json({ error: 'Failed to fetch payment settings' });
  }
});

// ===== POST Store Payment Settings (Admin Only) =====
router.post('/settings', paymentSetupRateLimiter, verifyPermission('payments.configure'), async (req, res) => {
  const { is_active, api_key, integration_id, iframe_id, hmac_secret } = req.body;

  try {
    // 1. Get active subscription
    const { data: subscription } = await supabase
      .from('store_subscriptions')
      .select('plan_id')
      .eq('store_id', req.store.id)
      .eq('status', 'active')
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();

    if (!subscription) {
      return res.status(403).json({ error: 'عذراً، يجب أن يكون لديك اشتراك نشط لتفعيل بوابات الدفع.' });
    }

    // 2. Check if feature is enabled
    const { data: featureCheck } = await supabase
      .from('plan_features')
      .select('id, features!inner(key)')
      .eq('plan_id', subscription.plan_id)
      .eq('features.key', 'payment_gateways')
      .maybeSingle();

    if (!featureCheck) {
      return res.status(403).json({ error: 'بوابات الدفع الإلكتروني غير متوفرة في باقتك الحالية.' });
    }

    // 3. Get existing config to preserve original credentials if masked ones are sent back
    const { data: existing } = await supabase
      .from('store_payment_gateways')
      .select('*')
      .eq('store_id', req.store.id)
      .eq('provider_name', 'paymob')
      .maybeSingle();

    let existingCreds = {};
    if (existing?.credentials) {
      const key = getEncryptionKeyForVersion(existing.key_version);
      existingCreds = decryptCredentials(existing.credentials, key) || {};
    }

    const finalApiKey = (api_key && api_key.startsWith('d_')) ? existingCreds.api_key : api_key;
    const finalHmacSecret = (hmac_secret && hmac_secret.startsWith('d_')) ? existingCreds.hmac_secret : hmac_secret;

    const credentialsPayload = {
      api_key: finalApiKey || '',
      integration_id: integration_id || '',
      iframe_id: iframe_id || '',
      hmac_secret: finalHmacSecret || ''
    };

    // Encrypt new credentials
    const encryptionKey = getEncryptionKeyForVersion();
    const encrypted = encryptCredentials(credentialsPayload, encryptionKey);

    const { error } = await supabase
      .from('store_payment_gateways')
      .upsert({
        store_id: req.store.id,
        provider_name: 'paymob',
        is_active: !!is_active,
        credentials: encrypted,
        key_version: 1, // default key version
        updated_at: new Date().toISOString()
      }, { onConflict: 'store_id, provider_name' });

    if (error) throw error;

    return res.json({ success: true, message: 'تم حفظ إعدادات بوابة الدفع بنجاح.' });
  } catch (err) {
    console.error('Save payment settings error:', err.message);
    return res.status(500).json({ error: 'Failed to save payment settings' });
  }
});

// ===== STEP 1: Create Payment Intent =====
router.post('/create', paymentRateLimiter, verifyUser, async (req, res) => {
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
    const paymobTransactionId = String(obj.id); // âœ… Transaction-level tracking

    const { data: order } = await supabase
      .from('orders').select('*').eq('paymob_order_id', paymobOrderId).single();

    if (!order) {
      console.error('Order not found for Paymob ID:', paymobOrderId);
      return res.sendStatus(404);
    }

    // âœ… Idempotency Check: if already paid, ignore
    if (order.payment_status === 'paid') {
      console.log(`Webhook ignored: Order ${order.id} is already paid.`);
      return res.sendStatus(200);
    }

    // âœ… Replay Attack Guard
    if (order.paymob_transaction_id === paymobTransactionId) {
      console.log(`Replay attack blocked for Transaction ${paymobTransactionId}`);
      return res.sendStatus(200);
    }

    // âœ… Append Audit Log
    const auditLogs = Array.isArray(order.payment_details?.audit_logs) 
      ? order.payment_details.audit_logs 
      : [];
    
    auditLogs.push({
      timestamp: new Date().toISOString(),
      transaction_id: paymobTransactionId,
      amount: obj.amount_cents,
      success: isSuccess,
      payload_summary: {
        currency: obj.currency,
        source: obj.source_data?.type,
        error_occured: obj.error_occured
      }
    });

    const newPaymentDetails = {
      ...(typeof order.payment_details === 'object' ? order.payment_details : {}),
      latest_transaction: obj,
      audit_logs: auditLogs
    };

    if (isSuccess) {
      // Update order payment status
      const { data: updatedOrder, error: updateError } = await supabase
        .from('orders')
        .update({
          payment_status: 'paid',
          status: 'confirmed',
          paymob_transaction_id: paymobTransactionId,
          payment_details: newPaymentDetails
        })
        .eq('id', order.id)
        .select().single();

      if (updateError || !updatedOrder) {
        console.log(`Concurrent or duplicate webhook ignored for Order ${order.id}`);
        return res.sendStatus(200);
      }

      console.log(`âœ… Order ${order.id} confirmed | Transaction ${paymobTransactionId}`);

    } else {
      await supabase.from('orders')
        .update({ payment_status: 'failed', payment_details: newPaymentDetails })
        .eq('id', order.id);
      console.log(`â Œ Order ${order.id} payment failed.`);
    }

    res.sendStatus(200);

  } catch (err) {
    console.error('Webhook Error:', err.message);
    res.sendStatus(500);
  }
});

// ===== STEP 3: Verify Redirect (Frontend Callback) =====
router.get('/verify-redirect', async (req, res) => {
  const query = req.query;
  const paymobOrderId = query.order;
  const receivedHmac = query.hmac;

  if (!paymobOrderId || !receivedHmac) {
    return res.status(400).json({ error: 'Missing parameters' });
  }

  try {
    const { data: order } = await supabase
      .from('orders')
      .select('store_id, payment_status')
      .eq('paymob_order_id', paymobOrderId)
      .single();

    if (!order) return res.status(404).json({ error: 'Order not found' });

    // If already marked as paid by webhook, we don't even need to verify HMAC here
    if (order.payment_status === 'paid') {
      return res.json({ success: true, payment_status: 'paid' });
    }

    // Otherwise, verify the GET HMAC to confirm success instantly
    let hmacSecret = process.env.PAYMOB_HMAC_SECRET;
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

    const concatFields = [
      query.amount_cents, query.created_at, query.currency, query.error_occured,
      query.has_parent_transaction, query.id, query.integration_id, query.is_3d_secure,
      query.is_auth, query.is_capture, query.is_refunded, query.is_standalone_payment,
      query.is_voided, query.order, query.owner, query.pending,
      query['source_data.pan'], query['source_data.sub_type'], query['source_data.type'], query.success
    ].map(v => String(v ?? ''));

    const computedHmac = crypto
      .createHmac('sha512', hmacSecret)
      .update(concatFields.join(''))
      .digest('hex');

    if (computedHmac.length !== receivedHmac.length) {
      return res.status(401).json({ error: 'Invalid HMAC signature' });
    }

    const isValid = crypto.timingSafeEqual(
      Buffer.from(computedHmac, 'hex'),
      Buffer.from(receivedHmac, 'hex')
    );

    if (!isValid) {
      return res.status(401).json({ error: 'Invalid HMAC signature' });
    }

    // HMAC is valid, return the parsed success state
    const isSuccess = query.success === 'true';
    return res.json({ success: isSuccess, payment_status: isSuccess ? 'paid' : 'failed' });

  } catch (err) {
    console.error('Verify Redirect Error:', err.message);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

module.exports = router;
