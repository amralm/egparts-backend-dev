'use strict';

const express = require('express');
const router = express.Router();
const courierManager = require('../services/couriers/courierManager');
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
 * 1. Get Courier Settings for Store (e.g. Bosta credentials)
 */
router.get('/settings', verifyPermission('settings.view'), async (req, res) => {
  const storeId = requireStore(req, res);
  if (!storeId) return;

  const provider = req.query.provider || 'bosta';
  try {
    const settings = await courierManager.getSettings(storeId, provider);
    // Mask sensitive API Key for security
    const maskedApiKey = settings?.api_key
      ? `${settings.api_key.slice(0, 4)}••••••••${settings.api_key.slice(-4)}`
      : '';

    sendSuccess(res, {
      settings: settings ? {
        ...settings,
        has_key: Boolean(settings.api_key),
        api_key_masked: maskedApiKey
      } : null
    });
  } catch (err) {
    logger.error('[CourierShipping] Error fetching settings:', err.message);
    apiError(res, 500, 'تعذر جلب إعدادات شركة الشحن', 'HTTP_500');
  }
});

/**
 * 2. Save Courier Settings
 */
router.put('/settings', verifyPermission('settings.update'), async (req, res) => {
  const storeId = requireStore(req, res);
  if (!storeId) return;

  const { provider = 'bosta', apiKey, isActive = true, isTestMode = true, pickupAddress = {} } = req.body || {};

  try {
    const saved = await courierManager.saveSettings(storeId, {
      provider,
      apiKey,
      isActive,
      isTestMode,
      pickupAddress
    });

    sendSuccess(res, {
      settings: {
        ...saved,
        has_key: Boolean(saved.api_key),
        api_key_masked: saved.api_key ? `${saved.api_key.slice(0, 4)}••••••••${saved.api_key.slice(-4)}` : ''
      },
      message: 'تم حفظ إعدادات شركة الشحن بنجاح'
    });
  } catch (err) {
    logger.error('[CourierShipping] Error saving settings:', err.message);
    apiError(res, 500, err.message || 'تعذر حفظ إعدادات شركة الشحن', 'HTTP_500');
  }
});

/**
 * 3. Dispatch Order with Courier (creates delivery & AWB)
 */
router.post('/dispatch/:orderId', verifyPermission('orders.update_status'), async (req, res) => {
  const storeId = requireStore(req, res);
  if (!storeId) return;

  const { orderId } = req.params;
  const { provider = 'bosta', customTrackingNumber, notes } = req.body || {};

  try {
    const result = await courierManager.dispatchOrder({
      orderId,
      storeId,
      provider,
      customTrackingNumber,
      notes
    });

    sendSuccess(res, {
      ...result,
      message: `تم إسناد الطلب لشركة الشحن (${provider.toUpperCase()}) بنجاح وتوليد رقم التتبع.`
    });
  } catch (err) {
    logger.error(`[CourierShipping] Dispatch failed for order ${orderId}:`, err.message);
    apiError(res, 400, err.message || 'فشل إسناد الطلب لشركة الشحن', 'DISPATCH_FAILED');
  }
});

/**
 * 4. Live Tracking for an Order
 */
router.get('/track/:orderId', verifyPermission('orders.view'), async (req, res) => {
  const storeId = requireStore(req, res);
  if (!storeId) return;

  const { orderId } = req.params;

  try {
    const tracking = await courierManager.trackOrder(orderId, storeId);
    sendSuccess(res, { tracking });
  } catch (err) {
    logger.error(`[CourierShipping] Tracking failed for order ${orderId}:`, err.message);
    apiError(res, 500, err.message || 'تعذر جلب بيانات التتبع', 'TRACKING_FAILED');
  }
});

/**
 * 5. Get Airway Bill (AWB) for an Order
 */
router.get('/awb/:orderId', verifyPermission('orders.view'), async (req, res) => {
  const storeId = requireStore(req, res);
  if (!storeId) return;

  const { orderId } = req.params;

  try {
    const awb = await courierManager.getAirwayBill(orderId, storeId);
    sendSuccess(res, { awb });
  } catch (err) {
    logger.error(`[CourierShipping] AWB retrieval failed for order ${orderId}:`, err.message);
    apiError(res, 500, err.message || 'تعذر جلب بوليصة الشحن', 'AWB_FAILED');
  }
});

/**
 * 6. Inbound Webhook from Courier Services (Public)
 */
router.post('/webhook/:courier', async (req, res) => {
  const { courier } = req.params;
  try {
    const result = await courierManager.handleWebhook(courier, req.body);
    sendSuccess(res, { result, handled: true }, { message: 'Webhook processed' });
  } catch (err) {
    logger.error(`[CourierWebhook] Error processing webhook from ${courier}:`, err.message);
    sendSuccess(res, { handled: false, detail: err.message }, { message: 'Webhook error' });
  }
});

module.exports = router;
