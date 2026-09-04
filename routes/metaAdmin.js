'use strict';

const express = require('express');
const router = express.Router();
const metaWhatsAppService = require('../services/metaWhatsAppService');
const unifiedWhatsAppRouter = require('../services/unifiedWhatsAppRouter');
const { supabase } = require('../services/supabase');
const { verifyPermission } = require('../middleware/auth');
const { apiError } = require('../utils/apiError');
const { sendSuccess } = require('../utils/apiResponse');
const logger = require('../utils/logger');

function requireStore(req, res) {
  if (!req.store?.id) {
    apiError(res, 400, 'سياق المتجر مطلوب لهذه العملية.', 'TENANT_CONTEXT_REQUIRED');
    return null;
  }
  return req.store.id;
}

/**
 * 1. Get Meta WhatsApp Config & Status
 */
router.get('/config', verifyPermission('settings.view'), async (req, res) => {
  const storeId = requireStore(req, res);
  if (!storeId) return;

  try {
    const { data: settings } = await supabase
      .from('site_settings')
      .select('whatsapp_provider, meta_phone_number_id, meta_access_token, meta_verify_token, meta_app_secret, meta_waba_id')
      .eq('store_id', storeId)
      .maybeSingle();

    const maskedToken = settings?.meta_access_token
      ? `${settings.meta_access_token.slice(0, 6)}••••••••${settings.meta_access_token.slice(-4)}`
      : '';

    const overallStatus = await unifiedWhatsAppRouter.getStatus(storeId);

    sendSuccess(res, {
      config: {
        whatsapp_provider: settings?.whatsapp_provider || 'pool',
        meta_phone_number_id: settings?.meta_phone_number_id || '',
        meta_access_token_masked: maskedToken,
        has_access_token: Boolean(settings?.meta_access_token),
        meta_verify_token: settings?.meta_verify_token || '',
        meta_app_secret: settings?.meta_app_secret || '',
        meta_waba_id: settings?.meta_waba_id || ''
      },
      status: overallStatus
    });
  } catch (err) {
    logger.error('[MetaAdmin] Error fetching config:', err.message);
    apiError(res, 500, 'تعذر جلب إعدادات واتساب ميتا', 'HTTP_500');
  }
});

/**
 * 2. Save Meta WhatsApp Config
 */
router.put('/config', verifyPermission('settings.update'), async (req, res) => {
  const storeId = requireStore(req, res);
  if (!storeId) return;

  const {
    whatsapp_provider = 'pool',
    meta_phone_number_id,
    meta_access_token,
    meta_verify_token,
    meta_app_secret,
    meta_waba_id
  } = req.body || {};

  const validProviders = new Set(['pool', 'meta', 'hybrid']);
  if (!validProviders.has(whatsapp_provider)) {
    return apiError(res, 400, 'مزود الواتساب غير مدعوم', 'INVALID_PROVIDER');
  }

  try {
    const updatePayload = {
      whatsapp_provider,
      updated_at: new Date().toISOString()
    };

    if (meta_phone_number_id !== undefined) updatePayload.meta_phone_number_id = meta_phone_number_id ? meta_phone_number_id.trim() : null;
    if (meta_access_token !== undefined && meta_access_token !== '') updatePayload.meta_access_token = meta_access_token.trim();
    if (meta_verify_token !== undefined) updatePayload.meta_verify_token = meta_verify_token ? meta_verify_token.trim() : null;
    if (meta_app_secret !== undefined) updatePayload.meta_app_secret = meta_app_secret ? meta_app_secret.trim() : null;
    if (meta_waba_id !== undefined) updatePayload.meta_waba_id = meta_waba_id ? meta_waba_id.trim() : null;

    const { error } = await supabase
      .from('site_settings')
      .update(updatePayload)
      .eq('store_id', storeId);

    if (error) throw error;

    sendSuccess(res, {
      message: 'تم حفظ إعدادات واتساب ميتا بنجاح',
      provider: whatsapp_provider
    });
  } catch (err) {
    logger.error('[MetaAdmin] Error saving config:', err.message);
    apiError(res, 500, 'تعذر حفظ الإعدادات', 'HTTP_500');
  }
});

/**
 * 3. Test Meta Connection Live
 */
router.post('/test-connection', verifyPermission('settings.view'), async (req, res) => {
  const storeId = requireStore(req, res);
  if (!storeId) return;

  let { phoneNumberId, accessToken } = req.body || {};

  // If not passed in body, fetch from store settings
  if (!phoneNumberId || !accessToken) {
    const { data: settings } = await supabase
      .from('site_settings')
      .select('meta_phone_number_id, meta_access_token')
      .eq('store_id', storeId)
      .maybeSingle();

    phoneNumberId = phoneNumberId || settings?.meta_phone_number_id;
    accessToken = accessToken || settings?.meta_access_token;
  }

  if (!phoneNumberId || !accessToken) {
    return apiError(res, 400, 'يرجى إدخال Phone Number ID و Access Token للاختبار.', 'MISSING_CREDENTIALS');
  }

  try {
    const testResult = await metaWhatsAppService.testConnection({
      phoneNumberId,
      accessToken
    });

    sendSuccess(res, {
      ...testResult,
      message: `تم الاتصال بنجاح بـ Meta Cloud API! الرقم المسجل: ${testResult.displayPhoneNumber} (${testResult.verifiedName || 'حساب نشط'})`
    });
  } catch (err) {
    logger.error('[MetaAdmin] Connection test failed:', err.message);
    apiError(res, 400, err.message || 'فشل الاتصال بـ Meta Cloud API', 'CONNECTION_FAILED');
  }
});

module.exports = router;
