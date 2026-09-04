'use strict';

const express = require('express');
const router = express.Router();
const multer = require('multer');
const path = require('path');
const axios = require('axios');
const { supabase } = require('../services/supabase');
const { verifyUser } = require('../middleware/auth');
const { sendSuccess } = require('../utils/apiResponse');
const { apiError } = require('../utils/apiError');
const logger = require('../utils/logger');
const { decryptCredentials, getEncryptionKeyForVersion } = require('../utils/crypto');
const r2 = require('../services/r2StorageService');

const ROOT_PLATFORM_STORE_ID = '00000000-0000-0000-0000-000000000000';

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const allowed = ['.jpg', '.jpeg', '.png', '.webp'];
    const ext = path.extname(file.originalname).toLowerCase();
    if (allowed.includes(ext)) return cb(null, true);
    cb(new Error('يسمح فقط بالصور بصيغة JPG أو PNG أو WebP'));
  },
});

// ── Feature summaries for display in pricing cards ──
const PLAN_FEATURE_MAP = {
  free: {
    products_limit: 15,
    orders_limit: 50,
    coupons: false,
    pos: false,
    whatsapp: false,
    custom_domain: false,
    branches: 1,
    support_level: 'مجتمعي'
  },
  basic: {
    products_limit: 100,
    orders_limit: 300,
    coupons: false,
    pos: true,
    whatsapp: true,
    custom_domain: false,
    branches: 1,
    support_level: 'بريد إلكتروني'
  },
  starter: {
    products_limit: 300,
    orders_limit: 800,
    coupons: true,
    pos: true,
    whatsapp: true,
    custom_domain: true,
    branches: 2,
    support_level: 'واتساب ودردشة'
  },
  growth: {
    products_limit: 1000,
    orders_limit: 2500,
    coupons: true,
    pos: true,
    whatsapp: true,
    custom_domain: true,
    branches: 5,
    support_level: 'مدير حساب مخصص'
  },
  scale: {
    products_limit: 5000,
    orders_limit: 10000,
    coupons: true,
    pos: true,
    whatsapp: true,
    custom_domain: true,
    branches: 15,
    support_level: 'دعم VIP على مدار الساعة'
  },
  enterprise: {
    products_limit: 'غير محدود',
    orders_limit: 'غير محدود',
    coupons: true,
    pos: true,
    whatsapp: true,
    custom_domain: true,
    branches: 'غير محدود',
    support_level: 'فريق هندسي وتقني مخصص'
  }
};

// ── GET /api/billing/plans ──
// Public & merchant view of subscription plans
router.get('/plans', async (req, res) => {
  try {
    const { data: plans, error } = await supabase
      .from('plans')
      .select('id, code, display_name, description, price_monthly, price_yearly, trial_days, trial_enabled, sort_order, is_public')
      .eq('is_public', true)
      .order('sort_order', { ascending: true });

    if (error) throw error;

    const mapped = (plans || []).map(p => ({
      ...p,
      features: PLAN_FEATURE_MAP[p.code] || {
        products_limit: 50,
        orders_limit: 200,
        coupons: true,
        pos: true,
        whatsapp: true,
        custom_domain: false
      }
    }));

    sendSuccess(res, { plans: mapped });
  } catch (err) {
    logger.error('[billing] failed to fetch plans:', err.message);
    apiError(res, 500, 'Unable to load plans', 'HTTP_500');
  }
});

// ── GET /api/billing/current ──
// Current store subscription status, renewal date, and invoice history
router.get('/current', verifyUser, async (req, res) => {
  if (!req.store?.id) return apiError(res, 400, 'Tenant context required', 'TENANT_REQUIRED');

  try {
    const [subRes, invRes, storeRes] = await Promise.all([
      supabase
        .from('store_subscriptions')
        .select(`
          id, plan_id, status, started_at, expires_at, created_at,
          is_over_quota, suggested_plan_code,
          plans ( id, code, display_name, price_monthly, price_yearly )
        `)
        .eq('store_id', req.store.id)
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle(),
      supabase
        .from('invoices')
        .select('id, invoice_number, total, amount_paid, status, billing_cycle, payment_method, proof_url, proof_submitted_at, created_at, plans(display_name)')
        .eq('store_id', req.store.id)
        .order('created_at', { ascending: false })
        .limit(10),
      supabase
        .from('stores')
        .select('id, name, status')
        .eq('id', req.store.id)
        .maybeSingle()
    ]);

    if (subRes.error) throw subRes.error;
    if (invRes.error) throw invRes.error;

    const subscription = subRes.data || null;
    const isSuspended = storeRes.data?.status === 'suspended' || subscription?.status === 'suspended';

    sendSuccess(res, {
      subscription,
      invoices: invRes.data || [],
      store_status: storeRes.data?.status || 'active',
      is_suspended: isSuspended
    });
  } catch (err) {
    logger.error('[billing] failed to fetch current subscription:', err.message);
    apiError(res, 500, 'Unable to load billing data', 'HTTP_500');
  }
});

// ── GET /api/billing/gateways ──
// Payment gateways configured on root platform store (Paymob + Manual Wallets)
router.get('/gateways', async (req, res) => {
  try {
    let paymobAvailable = Boolean(process.env.PAYMOB_API_KEY && process.env.PAYMOB_INTEGRATION_ID && process.env.PAYMOB_IFRAME_ID);
    const wallets = [];
    let instructions = 'يرجى تحويل المبلغ عبر فودافون كاش أو إنستاباي ثم رفع إيصال التحويل لتفعيل الاشتراك فوراً.';

    // Check root platform store gateways
    const { data: rootGateways } = await supabase
      .from('store_payment_gateways')
      .select('provider_name, credentials, key_version, is_active')
      .eq('store_id', ROOT_PLATFORM_STORE_ID)
      .eq('is_active', true);

    if (Array.isArray(rootGateways)) {
      for (const gw of rootGateways) {
        if (gw.provider_name === 'paymob' && gw.credentials) {
          const key = getEncryptionKeyForVersion(gw.key_version);
          const creds = decryptCredentials(gw.credentials, key) || {};
          if (creds.api_key && creds.integration_id) {
            paymobAvailable = true;
          }
        }
        if (gw.provider_name === 'manual_wallet' && gw.credentials) {
          const key = getEncryptionKeyForVersion(gw.key_version);
          const creds = decryptCredentials(gw.credentials, key) || {};
          if (Array.isArray(creds.wallets)) {
            wallets.push(...creds.wallets.filter(w => w.enabled));
          }
        }
      }
    }

    // Fallback to platform store site_settings for wallets
    if (wallets.length === 0) {
      const { data: rootSettings } = await supabase
        .from('site_settings')
        .select('vodafone_cash_number, etisalat_cash_number, orange_cash_number, manual_wallet_instructions')
        .eq('store_id', ROOT_PLATFORM_STORE_ID)
        .maybeSingle();

      if (rootSettings) {
        if (rootSettings.manual_wallet_instructions) instructions = rootSettings.manual_wallet_instructions;
        if (rootSettings.vodafone_cash_number) {
          wallets.push({ id: 'platform-vodafone', provider: 'vodafone_cash', label: 'فودافون كاش (الرسمي)', number: rootSettings.vodafone_cash_number });
        }
        if (rootSettings.etisalat_cash_number) {
          wallets.push({ id: 'platform-etisalat', provider: 'etisalat_cash', label: 'اتصالات كاش (الرسمي)', number: rootSettings.etisalat_cash_number });
        }
        if (rootSettings.orange_cash_number) {
          wallets.push({ id: 'platform-orange', provider: 'orange_cash', label: 'أورانج كاش (الرسمي)', number: rootSettings.orange_cash_number });
        }
      }
    }

    // Default platform wallet fallback if not yet entered
    if (wallets.length === 0) {
      wallets.push({
        id: 'platform-default-wallet',
        provider: 'vodafone_cash',
        label: 'فودافون كاش / إنستاباي',
        number: '01000000000'
      });
    }

    sendSuccess(res, {
      paymob_available: paymobAvailable,
      wallets,
      instructions
    });
  } catch (err) {
    logger.error('[billing] failed to fetch billing gateways:', err.message);
    apiError(res, 500, 'Unable to load payment methods', 'HTTP_500');
  }
});

// ── POST /api/billing/subscribe ──
// Merchant chooses a plan & payment method
router.post('/subscribe', verifyUser, async (req, res) => {
  if (!req.store?.id) return apiError(res, 400, 'Tenant context required', 'TENANT_REQUIRED');

  const { plan_id, billing_cycle = 'monthly', payment_method = 'manual_wallet' } = req.body || {};

  if (!plan_id) return apiError(res, 400, 'Plan ID is required', 'PLAN_REQUIRED');

  try {
    // 1. Fetch plan
    const { data: plan, error: planError } = await supabase
      .from('plans')
      .select('id, code, display_name, price_monthly, price_yearly')
      .eq('id', plan_id)
      .maybeSingle();

    if (planError || !plan) return apiError(res, 404, 'Plan not found', 'PLAN_NOT_FOUND');

    const isYearly = billing_cycle === 'yearly';
    const amount = isYearly ? Number(plan.price_yearly) : Number(plan.price_monthly);
    const durationDays = isYearly ? 365 : 30;
    const now = new Date();
    const expiresAt = new Date(now.getTime() + durationDays * 24 * 60 * 60 * 1000);

    // If free plan
    if (amount === 0) {
      // Upsert store subscription
      const { data: newSub, error: subErr } = await supabase
        .from('store_subscriptions')
        .insert([{
          store_id: req.store.id,
          plan_id: plan.id,
          status: 'active',
          started_at: now.toISOString(),
          expires_at: expiresAt.toISOString()
        }])
        .select()
        .single();

      if (subErr) throw subErr;

      // Unsuspend store
      await supabase.from('stores').update({ status: 'active' }).eq('id', req.store.id);

      // Create zero-amount paid invoice
      const invoiceNumber = `INV-${Date.now().toString().slice(-6)}`;
      await supabase.from('invoices').insert([{
        store_id: req.store.id,
        plan_id: plan.id,
        invoice_number: invoiceNumber,
        subtotal: 0,
        total: 0,
        amount_paid: 0,
        status: 'paid',
        billing_cycle,
        payment_method: 'free',
        billing_period_start: now.toISOString(),
        billing_period_end: expiresAt.toISOString()
      }]);

      return sendSuccess(res, {
        activated: true,
        message: 'تم تفعيل الباقة بنجاح!',
        expires_at: expiresAt.toISOString()
      });
    }

    // 2. Paid Plan: Create pending invoice
    const invoiceNumber = `INV-${Date.now().toString().slice(-6)}`;
    const { data: invoice, error: invErr } = await supabase
      .from('invoices')
      .insert([{
        store_id: req.store.id,
        plan_id: plan.id,
        invoice_number: invoiceNumber,
        subtotal: amount,
        total: amount,
        amount_paid: 0,
        status: 'pending',
        billing_cycle,
        payment_method,
        billing_period_start: now.toISOString(),
        billing_period_end: expiresAt.toISOString()
      }])
      .select()
      .single();

    if (invErr) throw invErr;

    // 3a. Paymob Flow
    if (payment_method === 'paymob') {
      let apiKey = process.env.PAYMOB_API_KEY;
      let integrationId = process.env.PAYMOB_INTEGRATION_ID;
      let iframeId = process.env.PAYMOB_IFRAME_ID;

      // Check root store override
      const { data: rootGw } = await supabase
        .from('store_payment_gateways')
        .select('credentials, key_version')
        .eq('store_id', ROOT_PLATFORM_STORE_ID)
        .eq('provider_name', 'paymob')
        .eq('is_active', true)
        .maybeSingle();

      if (rootGw?.credentials) {
        const key = getEncryptionKeyForVersion(rootGw.key_version);
        const creds = decryptCredentials(rootGw.credentials, key) || {};
        if (creds.api_key) apiKey = creds.api_key;
        if (creds.integration_id) integrationId = creds.integration_id;
        if (creds.iframe_id) iframeId = creds.iframe_id;
      }

      if (!apiKey || !integrationId || !iframeId) {
        return apiError(res, 400, 'بوابة الدفع الإلكتروني غير مهيأة للمنصة حالياً، يرجى الدفع بالمحفظة الإلكترونية.', 'PAYMOB_UNCONFIGURED');
      }

      const amountCents = Math.round(amount * 100);
      const authRes = await axios.post('https://accept.paymob.com/api/auth/tokens', { api_key: apiKey }, { timeout: 10000 });
      const token = authRes.data.token;

      const orderRes = await axios.post('https://accept.paymob.com/api/ecommerce/orders', {
        auth_token: token,
        delivery_needed: false,
        amount_cents: amountCents,
        currency: 'EGP',
        items: []
      }, { timeout: 10000 });

      const paymentKeyRes = await axios.post('https://accept.paymob.com/api/acceptance/payment_keys', {
        auth_token: token,
        amount_cents: amountCents,
        expiration: 3600,
        order_id: orderRes.data.id,
        billing_data: {
          first_name: req.user?.user_metadata?.name?.split(' ')[0] || 'Merchant',
          last_name: req.user?.user_metadata?.name?.split(' ')[1] || 'Store',
          email: req.user?.email || 'admin@egparts.store',
          phone_number: '01000000000',
          apartment: 'NA', floor: 'NA', street: 'Platform', building: 'NA',
          shipping_method: 'NA', postal_code: 'NA', city: 'Cairo', country: 'EG', state: 'NA'
        },
        currency: 'EGP',
        integration_id: integrationId
      }, { timeout: 10000 });

      const paymentUrl = `https://accept.paymob.com/api/acceptance/iframes/${iframeId}?payment_token=${paymentKeyRes.data.token}`;

      // Log transaction
      await supabase.from('payment_transactions').insert([{
        provider: 'paymob',
        provider_transaction_id: String(orderRes.data.id),
        invoice_id: invoice.id,
        status: 'pending',
        amount,
        currency: 'EGP'
      }]);

      return sendSuccess(res, {
        invoice_id: invoice.id,
        invoice_number: invoiceNumber,
        payment_url: paymentUrl,
        amount,
        requires_proof: false
      });
    }

    // 3b. Manual Wallet Flow
    return sendSuccess(res, {
      invoice_id: invoice.id,
      invoice_number: invoiceNumber,
      amount,
      requires_proof: true,
      message: 'تم إنشاء الفاتورة بنجاح. يرجى تحويل المبلغ ورفع صورة إيصال التحويل.'
    });

  } catch (err) {
    logger.error('[billing] subscribe failed:', err.message);
    apiError(res, 500, err.message || 'حدث خطأ أثناء معالجة طلب الاشتراك', 'HTTP_500');
  }
});

// ── POST /api/billing/upload-proof ──
// Merchant uploads payment proof for manual wallet transfer
router.post('/upload-proof', verifyUser, upload.single('receipt'), async (req, res) => {
  if (!req.store?.id) return apiError(res, 400, 'Tenant context required', 'TENANT_REQUIRED');
  const { invoice_id } = req.body;

  if (!invoice_id || !req.file) {
    return apiError(res, 400, 'رقم الفاتورة وصورة الإيصال مطلوبان', 'PROOF_REQUIRED');
  }

  try {
    // 1. Verify invoice
    const { data: invoice, error: invErr } = await supabase
      .from('invoices')
      .select('id, store_id, status, plan_id, billing_cycle')
      .eq('id', invoice_id)
      .eq('store_id', req.store.id)
      .single();

    if (invErr || !invoice) return apiError(res, 404, 'الفاتورة غير موجودة', 'INVOICE_NOT_FOUND');
    if (invoice.status === 'paid') return apiError(res, 400, 'هذه الفاتورة مدفوعة بالفعل', 'ALREADY_PAID');

    // 2. Upload image to R2
    const key = `subscription-proofs/${req.store.id}/${invoice_id}_${Date.now()}.jpg`;
    await r2.upload({
      buffer: req.file.buffer,
      key,
      contentType: req.file.mimetype || 'image/jpeg'
    });

    // 3. Update invoice
    const { error: updateErr } = await supabase
      .from('invoices')
      .update({
        proof_url: key,
        proof_submitted_at: new Date().toISOString(),
        status: 'pending',
        updated_at: new Date().toISOString()
      })
      .eq('id', invoice.id);

    if (updateErr) throw updateErr;

    logger.info(`[billing] Proof uploaded for invoice ${invoice_id} by store ${req.store.id}`);

    sendSuccess(res, {
      success: true,
      message: 'تم رفع إيصال التحويل بنجاح! سيتم مراجعة الدفع وتفعيل الباقة في أقرب وقت.'
    });
  } catch (err) {
    logger.error('[billing] proof upload failed:', err.message);
    apiError(res, 500, 'فشل رفع إيصال الدفع', 'HTTP_500');
  }
});

module.exports = router;
