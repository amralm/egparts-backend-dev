const { apiError } = require('../utils/apiError');
const { sendSuccess } = require('../utils/apiResponse');
const express = require('express');
const router = express.Router();
const axios = require('axios');
const crypto = require('crypto');
const rateLimit = require('express-rate-limit');
const { verifyUser, verifyPermission, optionalAuth } = require('../middleware/auth');
const { supabase } = require('../services/supabase');
const { decryptCredentials, encryptCredentials, getEncryptionKeyForVersion } = require('../utils/crypto');
const { validateBody } = require('../middleware/requestValidation');
const { paymentSettingsSchema, paymentToggleSchema, intentSchema } = require('../schemas/paymentSchemas');

const paymentRateLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 5,
  message: { success: false, code: 'RATE_LIMITED', message: 'طلبات إنشاء الدفع كثيرة جداً، حاول بعد دقيقة', data: null },
  standardHeaders: true,
  legacyHeaders: false,
});

const paymentSetupRateLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 5,
  message: { success: false, code: 'RATE_LIMITED', message: 'طلبات إعدادات الدفع كثيرة جداً، حاول بعد دقيقة', data: null },
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
  // express.raw() delivers body as a Buffer — parse it first
  if (Buffer.isBuffer(req.body)) {
    try {
      req.body = JSON.parse(req.body.toString('utf-8'));
    } catch (e) {
      return apiError(res, 400, 'Invalid webhook JSON payload', `HTTP_400`);
    }
  }

  if (!req.body || !req.body.obj || !req.body.hmac) {
    return apiError(res, 400, 'Invalid webhook payload', `HTTP_400`);
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
    return apiError(res, 401, 'Invalid HMAC signature', `HTTP_401`);
  }

  // ✅ Timing-safe comparison (prevents timing attacks)
  const isValid = crypto.timingSafeEqual(
    Buffer.from(computedHmac, 'hex'),
    Buffer.from(receivedHmac, 'hex')
  );

  if (!isValid) {
    console.error('HMAC mismatch! Potential forged webhook.');
    return apiError(res, 401, 'Invalid HMAC signature', `HTTP_401`);
  }

  next();
}

// ===== GET Active Payment Gateways (Public) =====
router.get('/active', async (req, res) => {
  if (!req.store?.id) {
    return apiError(res, 404, 'Store not found', `HTTP_404`);
  }

  try {
    const { data: gateways } = await supabase
      .from('store_payment_gateways')
      .select('provider_name')
      .eq('store_id', req.store.id)
      .eq('is_active', true);

    const activeProviders = (gateways || []).map(g => g.provider_name);
    return sendSuccess(res, { active_providers: activeProviders });
  } catch (err) {
    console.error('Fetch active gateways error:', err.message);
    return apiError(res, 500, 'Failed to fetch active gateways', `HTTP_500`);
  }
});

// ===== Cash on Delivery (COD) Endpoints =====
router.get('/methods/cod/settings', verifyUser, verifyPermission('payments.configure'), async (req, res) => {
  const storeId = req.store?.id;
  if (!storeId) return apiError(res, 400, 'Tenant context required', `HTTP_400`);
  try {
    const { data, error } = await supabase
      .from('store_payment_gateways')
      .select('is_active')
      .eq('store_id', storeId)
      .eq('provider_name', 'cod')
      .maybeSingle();
      
    if (error) throw error;
    sendSuccess(res, { settings: data || { is_active: true } });
  } catch (err) {
    apiError(res, 500, 'Server error', `HTTP_500`);
  }
});

router.post('/methods/cod/toggle', verifyUser, verifyPermission('payments.configure'), validateBody(paymentToggleSchema), async (req, res) => {
  const storeId = req.store?.id;
  if (!storeId) return apiError(res, 400, 'Tenant context required', `HTTP_400`);
  const { is_active } = req.body;
  try {
    const { error } = await supabase
      .from('store_payment_gateways')
      .upsert({
        store_id: storeId,
        provider_name: 'cod',
        is_active: !!is_active,
        credentials: '{}',
        key_version: 1
      }, { onConflict: 'store_id,provider_name' });
      
    if (error) throw error;
    sendSuccess(res, {});
  } catch (err) {
    apiError(res, 500, 'Server error', `HTTP_500`);
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
      return apiError(res, 403, 'عذراً، يجب أن يكون لديك اشتراك نشط لتفعيل بوابات الدفع.', `HTTP_403`);
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
      return sendSuccess(res, { allowed: false,
        code: 'FEATURE_DISABLED',
        message: 'بوابات الدفع الإلكتروني (Paymob) غير متوفرة في باقتك الحالية. يرجى الترقية للباقة الاحترافية أو أعلى لتفعيلها.',
        data: null });
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

    return sendSuccess(res, { allowed: true, config });
  } catch (err) {
    console.error('Fetch payment settings error:', err.message);
    return apiError(res, 500, 'Failed to fetch payment settings', `HTTP_500`);
  }
});

// ===== POST Store Payment Settings (Admin Only) =====
router.post('/settings', paymentSetupRateLimiter, verifyPermission('payments.configure'), validateBody(paymentSettingsSchema), async (req, res) => {
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
      return apiError(res, 403, 'عذراً، يجب أن يكون لديك اشتراك نشط لتفعيل بوابات الدفع.', `HTTP_403`);
    }

    // 2. Check if feature is enabled
    const { data: featureCheck } = await supabase
      .from('plan_features')
      .select('id, features!inner(key)')
      .eq('plan_id', subscription.plan_id)
      .eq('features.key', 'payment_gateways')
      .maybeSingle();

    if (!featureCheck) {
      return apiError(res, 403, 'بوابات الدفع الإلكتروني غير متوفرة في باقتك الحالية.', `HTTP_403`);
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

    return sendSuccess(res, { message: 'تم حفظ إعدادات بوابة الدفع بنجاح.' });
  } catch (err) {
    console.error('Save payment settings error:', err.message);
    return apiError(res, 500, 'Failed to save payment settings', `HTTP_500`);
  }
});

// ===== STEP 1: Create Payment Intent =====
router.post('/create', paymentRateLimiter, verifyUser, validateBody(intentSchema), async (req, res) => {
  const orderId = req.body?.orderId || req.body?.order_id || req.body?.order;

  if (!orderId) {
    return apiError(res, 400, 'Order ID is required', `HTTP_400`);
  }

  try {
    const { data: order, error: orderError } = await supabase
      .from('orders').select('*')
      .eq('id', orderId)
      .eq('user_id', req.user.sub)
      .eq('store_id', req.store.id)
      .single();

    if (orderError || !order) return apiError(res, 404, 'Order not found', `HTTP_404`);
    if (order.payment_status === 'paid') return apiError(res, 400, 'Order already paid', 'ORDER_ALREADY_PAID', { isPaid: true });

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
      return apiError(res, 400, 'بوابة الدفع الإلكتروني غير مهيأة لهذا المتجر حالياً. يرجى اختيار وسيلة دفع أخرى.', `HTTP_400`);
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
        first_name: req.user?.user_metadata?.name?.split(' ')[0] || 'Customer',
        last_name: req.user?.user_metadata?.name?.split(' ')[1] || 'User',
        email: req.user?.email || 'customer@egparts.com',
        phone_number: order.phone || '01000000000',
        apartment: 'NA', floor: 'NA', street: order.address || 'Cairo', building: 'NA',
        shipping_method: 'NA', postal_code: 'NA', city: order.city || 'Cairo', country: 'EG', state: 'NA'
      },
      currency: 'EGP', integration_id: integrationId
    });

    const paymentUrl = `https://accept.paymob.com/api/acceptance/iframes/${iframeId}?payment_token=${paymentKeyRes.data.token}`;
    await supabase.from('orders').update({ paymob_order_id: String(paymobOrderRes.data.id) }).eq('id', orderId).eq('store_id', req.store.id);

    return sendSuccess(res, { payment_url: paymentUrl,
      iframe_url: paymentUrl,
      orderId: order.id,
      amount: order.total });

  } catch (error) {
    console.error('Paymob Error:', error.response?.data || error.message);
    return apiError(res, 500, 'Failed to initiate payment', `HTTP_500`);
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
    // ✅ Append Audit Log
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
          paid_at: new Date().toISOString(),
          payment_details: newPaymentDetails
        })
        .eq('id', order.id)
        .select().single();

      if (updateError || !updatedOrder) {
        console.log(`Concurrent or duplicate webhook ignored for Order ${order.id}`);
        return res.sendStatus(200);
      }

      // Trigger notifications via payment_outbox (same pattern as walletPayments.js)
      await supabase.from('payment_outbox').insert({
        store_id: order.store_id,
        order_id: order.id,
        event_type: 'payment_confirmed',
        payload: {
          order_id: order.id,
          payment_method: 'card',
          transaction_id: paymobTransactionId,
          amount: obj.amount_cents / 100
        },
        status: 'pending',
        idempotency_key: `payment:${order.id}:transaction:${paymobTransactionId}`
      }).catch(err => console.error('[webhook] outbox insert failed (non-fatal):', err.message));

      console.log(`✅ Order ${order.id} confirmed | Transaction ${paymobTransactionId}`);

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

function getStoreUrl(store) {
  const primaryDomain = (process.env.PRIMARY_DOMAIN || 'egparts.store').toLowerCase().replace(/^https?:\/\//i, '').split('/')[0];
  if (!store) return `https://${primaryDomain}`;
  if (store.custom_domain) return `https://${store.custom_domain}`;
  if (store.subdomain) return `https://${store.subdomain}.${primaryDomain}`;
  return `https://${primaryDomain}`;
}

// ===== STEP 3: Verify Redirect (Paymob / Frontend Callback) =====
router.get('/verify-redirect', async (req, res) => {
  const query = req.query;
  const paymobOrderId = query.order;
  const receivedHmac = query.hmac;

  const isBrowserNavigation = req.headers.accept && req.headers.accept.includes('text/html');

  if (!paymobOrderId || !receivedHmac) {
    if (isBrowserNavigation) {
      const primaryDomain = (process.env.PRIMARY_DOMAIN || 'egparts.store').toLowerCase().replace(/^https?:\/\//i, '').split('/')[0];
      return res.redirect(302, `https://${primaryDomain}/payment/fail?error=missing_parameters`);
    }
    return apiError(res, 400, 'Missing parameters', `HTTP_400`);
  }

  try {
    const { data: order } = await supabase
      .from('orders')
      .select('id, store_id, payment_status, stores (id, name, subdomain, custom_domain)')
      .eq('paymob_order_id', paymobOrderId)
      .single();

    if (!order) {
      if (isBrowserNavigation) {
        const primaryDomain = (process.env.PRIMARY_DOMAIN || 'egparts.store').toLowerCase().replace(/^https?:\/\//i, '').split('/')[0];
        return res.redirect(302, `https://${primaryDomain}/payment/fail?error=order_not_found`);
      }
      return apiError(res, 404, 'Order not found', `HTTP_404`);
    }

    const storeUrl = getStoreUrl(order.stores);

    // If already marked as paid by webhook
    if (order.payment_status === 'paid') {
      if (isBrowserNavigation) {
        return res.redirect(302, `${storeUrl}/payment/success?method=card&orderId=${order.id}&isPaymob=true`);
      }
      return sendSuccess(res, { payment_status: 'paid', 
        orderId: order.id, 
        store: order.stores });
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

    // Express query parser ('qs') parses URL dots into nested objects (e.g. source_data.pan -> query.source_data.pan)
    const pan = query['source_data.pan'] ?? query.source_data?.pan ?? '';
    const subType = query['source_data.sub_type'] ?? query.source_data?.sub_type ?? '';
    const type = query['source_data.type'] ?? query.source_data?.type ?? '';

    const concatFields = [
      query.amount_cents, query.created_at, query.currency, query.error_occured,
      query.has_parent_transaction, query.id, query.integration_id, query.is_3d_secure,
      query.is_auth, query.is_capture, query.is_refunded, query.is_standalone_payment,
      query.is_voided, query.order, query.owner, query.pending,
      pan, subType, type, query.success
    ].map(v => String(v ?? ''));

    const computedHmac = crypto
      .createHmac('sha512', hmacSecret)
      .update(concatFields.join(''))
      .digest('hex');

    let isValid = false;
    if (computedHmac.length === receivedHmac.length) {
      isValid = crypto.timingSafeEqual(
        Buffer.from(computedHmac, 'hex'),
        Buffer.from(receivedHmac, 'hex')
      );
    }

    if (!isValid) {
      console.error('[verify-redirect] Invalid HMAC signature for Paymob order:', paymobOrderId, '| computed:', computedHmac, '| received:', receivedHmac);
      if (isBrowserNavigation) {
        return res.redirect(302, `${storeUrl}/payment/fail?orderId=${order.id}&error=invalid_signature`);
      }
      return apiError(res, 401, 'Invalid HMAC signature', `HTTP_401`);
    }

    // HMAC is valid, check success
    const isSuccess = query.success === 'true';
    if (isSuccess && order.payment_status !== 'paid') {
      await supabase.from('orders').update({
        payment_status: 'paid',
        status: 'confirmed',
        paid_at: new Date().toISOString()
      }).eq('id', order.id).eq('store_id', order.store_id);
      await supabase.from('payment_outbox').insert({
        store_id: order.store_id,
        order_id: order.id,
        event_type: 'payment_confirmed',
        payload: { order_id: order.id, payment_method: 'card', transaction_id: query.id || null, source: 'verify_redirect' },
        status: 'pending',
        idempotency_key: `payment:${order.id}:redirect:${query.id || 'unknown'}`,
      }).catch((outboxError) => console.error('[verify-redirect] outbox insert failed:', outboxError.message));
    }

    if (isBrowserNavigation) {
      if (isSuccess) {
        return res.redirect(302, `${storeUrl}/payment/success?method=card&orderId=${order.id}&isPaymob=true`);
      } else {
        return res.redirect(302, `${storeUrl}/payment/fail?orderId=${order.id}&isPaymob=true`);
      }
    }

    return sendSuccess(res, { success: isSuccess, 
      payment_status: isSuccess ? 'paid' : 'failed',
      orderId: order.id,
      store: order.stores });

  } catch (err) {
    console.error('Verify Redirect Error:', err.message);
    if (isBrowserNavigation) {
      const primaryDomain = (process.env.PRIMARY_DOMAIN || 'egparts.store').toLowerCase().replace(/^https?:\/\//i, '').split('/')[0];
      return res.redirect(302, `https://${primaryDomain}/payment/fail?error=server_error`);
    }
    return apiError(res, 500, 'Internal server error', `HTTP_500`);
  }
});

module.exports = router;
