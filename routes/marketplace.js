'use strict';

const express = require('express');
const router = express.Router();
const { supabase } = require('../services/supabase');
const { verifyPermission } = require('../middleware/auth');
const { apiError } = require('../utils/apiError');
const { sendSuccess } = require('../utils/apiResponse');
const logger = require('../utils/logger');
const { validateAppConfig } = require('../schemas/marketplaceSchemas');
const { encryptCredentials, getEncryptionKeyForVersion } = require('../utils/crypto');

function requireStore(req, res) {
  if (!req.store?.id) {
    apiError(res, 400, 'سياق المتجر مطلوب لهذه العملية.', 'TENANT_CONTEXT_REQUIRED');
    return null;
  }
  return req.store.id;
}

const SENSITIVE_FIELDS = ['access_token', 'api_key', 'password', 'account_pin', 'hmac_secret'];

function maskSecret(val) {
  if (!val || typeof val !== 'string') return '';
  if (val.length <= 8) return '••••••••';
  return `${val.slice(0, 4)}••••••••${val.slice(-4)}`;
}

function sanitizeSettingsForClient(settings = {}) {
  const sanitized = { ...settings };
  for (const field of SENSITIVE_FIELDS) {
    if (sanitized[field]) {
      sanitized[`has_${field}`] = true;
      sanitized[field] = maskSecret(sanitized[field]);
    }
  }
  return sanitized;
}

/**
 * 1. List all platform apps with store-specific install/active status
 */
router.get('/apps', verifyPermission('settings.view'), async (req, res) => {
  const storeId = requireStore(req, res);
  if (!storeId) return;

  try {
    const [platformAppsRes, storeAppsRes] = await Promise.all([
      supabase
        .from('platform_apps')
        .select('*')
        .eq('is_active', true)
        .order('sort_order', { ascending: true }),
      supabase
        .from('store_apps')
        .select('*')
        .eq('store_id', storeId)
    ]);

    if (platformAppsRes.error) throw platformAppsRes.error;
    if (storeAppsRes.error) throw storeAppsRes.error;

    const installedMap = new Map();
    for (const sa of storeAppsRes.data || []) {
      installedMap.set(sa.app_id, sa);
    }

    const apps = (platformAppsRes.data || []).map((app) => {
      const installed = installedMap.get(app.id);
      return {
        id: app.id,
        slug: app.slug,
        name: app.name,
        category: app.category,
        description: app.description,
        developer: app.developer,
        icon: app.icon,
        badge: app.badge,
        config_schema: app.config_schema,
        is_installed: Boolean(installed),
        is_active: Boolean(installed?.is_active),
        settings: installed ? sanitizeSettingsForClient(installed.settings) : {}
      };
    });

    sendSuccess(res, { apps });
  } catch (err) {
    logger.error('[Marketplace] Error fetching apps:', err.message);
    apiError(res, 500, 'تعذر تحميل قائمة التطبيقات والربط.', 'HTTP_500');
  }
});

/**
 * 2. Get specific app details and store configuration
 */
router.get('/apps/:slug', verifyPermission('settings.view'), async (req, res) => {
  const storeId = requireStore(req, res);
  if (!storeId) return;

  const { slug } = req.params;

  try {
    const { data: app, error: appErr } = await supabase
      .from('platform_apps')
      .select('*')
      .eq('slug', slug)
      .maybeSingle();

    if (appErr) throw appErr;
    if (!app) {
      return apiError(res, 404, 'التطبيق المطلوب غير موجود.', 'APP_NOT_FOUND');
    }

    const { data: storeApp, error: saErr } = await supabase
      .from('store_apps')
      .select('*')
      .eq('store_id', storeId)
      .eq('app_id', app.id)
      .maybeSingle();

    if (saErr) throw saErr;

    sendSuccess(res, {
      app: {
        id: app.id,
        slug: app.slug,
        name: app.name,
        category: app.category,
        description: app.description,
        developer: app.developer,
        icon: app.icon,
        badge: app.badge,
        config_schema: app.config_schema,
        is_installed: Boolean(storeApp),
        is_active: Boolean(storeApp?.is_active),
        settings: storeApp ? sanitizeSettingsForClient(storeApp.settings) : {}
      }
    });
  } catch (err) {
    logger.error(`[Marketplace] Error fetching app ${slug}:`, err.message);
    apiError(res, 500, 'تعذر جلب تفاصيل التطبيق.', 'HTTP_500');
  }
});

/**
 * 3. Configure and save an app for the current store
 */
router.post('/apps/:slug/configure', verifyPermission('settings.update'), async (req, res) => {
  const storeId = requireStore(req, res);
  if (!storeId) return;

  const { slug } = req.params;
  const { settings = {}, is_active = true } = req.body || {};

  try {
    // 1. Verify platform app exists
    const { data: app, error: appErr } = await supabase
      .from('platform_apps')
      .select('*')
      .eq('slug', slug)
      .maybeSingle();

    if (appErr) throw appErr;
    if (!app) {
      return apiError(res, 404, 'التطبيق غير معرّف في المنصة.', 'APP_NOT_FOUND');
    }

    // 2. Load existing settings if any to preserve masked passwords
    const { data: existingStoreApp } = await supabase
      .from('store_apps')
      .select('*')
      .eq('store_id', storeId)
      .eq('app_id', app.id)
      .maybeSingle();

    const mergedSettings = { ...(existingStoreApp?.settings || {}), ...settings };

    // Restore masked secrets if unchanged
    for (const field of SENSITIVE_FIELDS) {
      if (settings[field] && settings[field].includes('••••')) {
        mergedSettings[field] = existingStoreApp?.settings?.[field] || '';
      }
    }

    // 3. Strict Zod Validation
    const validation = validateAppConfig(slug, mergedSettings);
    if (!validation.success) {
      return apiError(res, 400, validation.error, 'VALIDATION_ERROR');
    }

    const validatedSettings = validation.data;

    // 4. Upsert store_apps record
    const { data: saved, error: saveErr } = await supabase
      .from('store_apps')
      .upsert({
        store_id: storeId,
        app_id: app.id,
        is_active: Boolean(is_active),
        settings: validatedSettings,
        updated_at: new Date().toISOString()
      }, { onConflict: 'store_id,app_id' })
      .select('*')
      .single();

    if (saveErr) throw saveErr;

    // 5. Cross-service state synchronization for backwards compatibility:
    // (a) Bosta Shipping sync with store_courier_settings
    if (slug === 'bosta-shipping' && validatedSettings.api_key) {
      await supabase
        .from('store_courier_settings')
        .upsert({
          store_id: storeId,
          provider: 'bosta',
          api_key: validatedSettings.api_key,
          is_active: Boolean(is_active),
          is_test_mode: Boolean(validatedSettings.is_test_mode !== false),
          updated_at: new Date().toISOString()
        }, { onConflict: 'store_id,provider' });
    }

    // (b) Meta WhatsApp sync with site_settings
    if (slug === 'meta-whatsapp' && validatedSettings.phone_number_id) {
      await supabase
        .from('site_settings')
        .update({
          meta_phone_number_id: validatedSettings.phone_number_id,
          meta_access_token: validatedSettings.access_token,
          meta_waba_id: validatedSettings.waba_id
        })
        .eq('store_id', storeId);
    }

    // (c) Abandoned Cart sync with site_settings
    if (slug === 'cart-recovery') {
      await supabase
        .from('site_settings')
        .update({
          abandoned_cart_enabled: Boolean(is_active),
          abandoned_cart_delay_minutes: validatedSettings.delay_minutes || 30
        })
        .eq('store_id', storeId);
    }

    // (d) Paymob payment gateways sync with store_payment_gateways (Encrypted)
    if (slug === 'payment-gateways' && validatedSettings.api_key) {
      const encryptionKey = getEncryptionKeyForVersion();
      const encrypted = encryptCredentials({
        api_key: validatedSettings.api_key,
        integration_id: validatedSettings.integration_id,
        iframe_id: validatedSettings.iframe_id,
        hmac_secret: validatedSettings.hmac_secret
      }, encryptionKey);

      await supabase
        .from('store_payment_gateways')
        .upsert({
          store_id: storeId,
          provider_name: 'paymob',
          is_active: Boolean(is_active),
          credentials: encrypted,
          key_version: 1,
          updated_at: new Date().toISOString()
        }, { onConflict: 'store_id,provider_name' });
    }

    sendSuccess(res, {
      success: true,
      message: 'تم حفظ إعدادات التطبيق بنجاح',
      app: {
        id: app.id,
        slug: app.slug,
        name: app.name,
        is_installed: true,
        is_active: Boolean(saved.is_active),
        settings: sanitizeSettingsForClient(saved.settings)
      }
    });
  } catch (err) {
    logger.error(`[Marketplace] Error configuring app ${slug}:`, err.message);
    apiError(res, 500, 'فشل حفظ إعدادات التطبيق.', 'HTTP_500');
  }
});

/**
 * 4. Fast Toggle (Enable / Disable)
 */
router.post('/apps/:slug/toggle', verifyPermission('settings.update'), async (req, res) => {
  const storeId = requireStore(req, res);
  if (!storeId) return;

  const { slug } = req.params;
  const { is_active } = req.body || {};

  try {
    const { data: app, error: appErr } = await supabase
      .from('platform_apps')
      .select('id')
      .eq('slug', slug)
      .maybeSingle();

    if (appErr || !app) {
      return apiError(res, 404, 'التطبيق غير موجود.', 'APP_NOT_FOUND');
    }

    const nextActive = Boolean(is_active);

    const { data: updated, error: updErr } = await supabase
      .from('store_apps')
      .update({ is_active: nextActive, updated_at: new Date().toISOString() })
      .eq('store_id', storeId)
      .eq('app_id', app.id)
      .select('*')
      .maybeSingle();

    if (updErr) throw updErr;

    if (!updated) {
      return apiError(res, 400, 'يرجى تهيئة إعدادات التطبيق أولاً قبل التفعيل.', 'APP_NOT_CONFIGURED');
    }

    // Keep courier in sync if bosta
    if (slug === 'bosta-shipping') {
      await supabase
        .from('store_courier_settings')
        .update({ is_active: nextActive })
        .eq('store_id', storeId)
        .eq('provider', 'bosta');
    }

    // Keep payment gateways in sync if paymob
    if (slug === 'payment-gateways') {
      await supabase
        .from('store_payment_gateways')
        .update({ is_active: nextActive, updated_at: new Date().toISOString() })
        .eq('store_id', storeId)
        .eq('provider_name', 'paymob');
    }

    sendSuccess(res, {
      success: true,
      is_active: nextActive,
      message: nextActive ? 'تم تفعيل التطبيق بنجاح' : 'تم تعطيل التطبيق بنجاح'
    });
  } catch (err) {
    logger.error(`[Marketplace] Error toggling app ${slug}:`, err.message);
    apiError(res, 500, 'تعذر تحديث حالة التطبيق.', 'HTTP_500');
  }
});

module.exports = router;
