const express = require('express');
const router = express.Router();
const { supabase } = require('../services/supabase');
const { sendSuccess } = require('../utils/apiResponse');

const VALID_EVENTS = new Set([
  'otp_success','otp_failure','checkout_start','checkout_complete',
  'checkout_abandon','gps_granted','gps_denied','gps_failure',
  'address_autofill','payment_success','payment_failure','order_retry'
]);

router.post('/event', async (req, res) => {
  if (!req.store?.id) return apiError(res, 400, 'تعذر تنفيذ الطلب.', 'TENANT_CONTEXT_REQUIRED');
  // Always respond immediately — fire and forget
  sendSuccess(res, {});
  
  const { event_type, metadata } = req.body || {};
  if (!event_type || !VALID_EVENTS.has(event_type)) return;
  
  try {
    await supabase.from('analytics_events').insert({
      event_type,
      store_id: req.store.id,
      metadata: metadata && typeof metadata === 'object' && !Array.isArray(metadata) ? metadata : {},
      created_at: new Date().toISOString()
    });
  } catch (err) {
    // Silent fail — analytics must never block the user
    console.error('[Analytics] Failed to log event:', err.message);
  }
});

module.exports = router;
