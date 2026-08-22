/**
 * Payment Methods Router
 * Handles fetching and managing available payment methods per store.
 *
 * Routes:
 *   GET  /api/payments/methods             — Customer: list available methods
 *   GET  /api/payments/methods/:method/settings — Admin: get method config
 *   POST /api/payments/methods/:method/toggle   — Admin: enable/disable method
 *
 * SECURITY CONTRACT:
 * - Customer endpoint returns ONLY what to display (id, label, type, icon).
 * - Backend is the SOLE authority on availability — never the frontend.
 * - Admin routes require permissions.
 */

const express = require('express');
const router = express.Router();
const { supabase } = require('../services/supabase');
const { verifyPermission } = require('../middleware/auth');
const { resolvePaymentMethods, assertPaymentMethodAvailable } = require('../services/paymentMethodPolicy');
const { apiError } = require('../utils/apiError');
const { sendSuccess } = require('../utils/apiResponse');
const { validateBody } = require('../middleware/requestValidation');
const { paymentToggleSchema } = require('../schemas/paymentSchemas');

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Get a gateway row from store_payment_gateways.
 */
async function getGateway(storeId, providerName) {
  const { data } = await supabase
    .from('store_payment_gateways')
    .select('*')
    .eq('store_id', storeId)
    .eq('provider_name', providerName)
    .maybeSingle();
  return data;
}

// ─── Customer: GET /api/payments/methods ─────────────────────────────────────

router.get('/', async (req, res) => {
  if (!req.store?.id) {
    return apiError(res, 404, 'Store not found', 'STORE_NOT_FOUND');
  }

  try {
    const storeId = req.store.id;
    const resolved = await resolvePaymentMethods(storeId);
    return sendSuccess(res, { ...resolved });

  } catch (err) {
    console.error('[payments/methods] Error:', err.message);
    return apiError(res, 500, 'Failed to load payment methods', 'PAYMENT_METHODS_LOAD_FAILED');
  }
});

// ─── Admin: GET /api/payments/methods/:method/settings ───────────────────────

router.get('/:method/settings', verifyPermission('payments.view'), async (req, res) => {
  const { method } = req.params;
  const storeId = req.store?.id;
  if (!storeId) return apiError(res, 404, 'Store not found', 'STORE_NOT_FOUND');

  const SUPPORTED = ['cod', 'manual_wallet', 'card'];
  if (!SUPPORTED.includes(method)) {
    return apiError(res, 400, `Unsupported payment method: ${method}`, 'UNSUPPORTED_PAYMENT_METHOD');
  }

  try {
    const gateway = await getGateway(storeId, method === 'card' ? 'paymob' : method);
    const resolved = await resolvePaymentMethods(storeId);
    return sendSuccess(res, { availability: resolved.availability[method],
      settings: {
        is_active: gateway ? gateway.is_active : (method === 'cod'), // COD defaults true
      } });
  } catch (err) {
    console.error(`[payments/methods/${method}/settings] Error:`, err.message);
    return apiError(res, 500, 'Failed to fetch settings', 'PAYMENT_SETTINGS_LOAD_FAILED');
  }
});

// ─── Admin: POST /api/payments/methods/:method/toggle ────────────────────────

router.post('/:method/toggle', verifyPermission('payments.configure'), validateBody(paymentToggleSchema), async (req, res) => {
  const { method } = req.params;
  const { is_active } = req.body;
  const storeId = req.store?.id;

  if (!storeId) return apiError(res, 404, 'Store not found', 'STORE_NOT_FOUND');

  const SUPPORTED = ['cod', 'manual_wallet'];
  if (!SUPPORTED.includes(method)) {
    return apiError(res, 400, `Cannot toggle payment method: ${method}`, 'UNSUPPORTED_PAYMENT_METHOD');
  }

  // Paymob toggle is handled via /api/payments/settings — it needs credential management
  // COD and manual_wallet can be simply toggled here

  try {
    if (is_active && method === 'manual_wallet') {
      const resolved = await resolvePaymentMethods(storeId);
      if (!resolved.availability.manual_wallet || resolved.availability.manual_wallet.reason === 'PLAN_FEATURE_NOT_INCLUDED' || resolved.availability.manual_wallet.reason === 'NO_ACTIVE_SUBSCRIPTION' || resolved.availability.manual_wallet.reason === 'PLAN_FEATURE_DISABLED') {
        return apiError(res, 409, 'Payment method is not included in the active plan', 'PAYMENT_METHOD_UNAVAILABLE', { reason: resolved.availability.manual_wallet.reason });
      }
    }
    const { error } = await supabase
      .from('store_payment_gateways')
      .upsert({
        store_id: storeId,
        provider_name: method,
        is_active: !!is_active,
        updated_at: new Date().toISOString(),
      }, { onConflict: 'store_id,provider_name' });

    if (error) throw error;

    // Also sync legacy site_settings for manual_wallet backward compatibility
    if (method === 'manual_wallet') {
      await supabase
        .from('site_settings')
        .update({ manual_wallet_enabled: !!is_active })
        .eq('store_id', storeId);
    }

    return sendSuccess(res, { message: `تم ${is_active ? 'تفعيل' : 'تعطيل'} وسيلة الدفع بنجاح.` });
  } catch (err) {
    console.error(`[payments/methods/${method}/toggle] Error:`, err.message);
    return apiError(res, 500, 'Failed to toggle payment method', 'PAYMENT_METHOD_TOGGLE_FAILED');
  }
});

module.exports = router;
