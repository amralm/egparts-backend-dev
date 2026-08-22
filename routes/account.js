const express = require('express');
const router = express.Router();
const { validateBody } = require('../middleware/requestValidation');
const { addressSchema } = require('../schemas/accountSchemas');
const logger = require('../utils/logger');
const { verifyUser } = require('../middleware/auth');
const accountService = require('../services/accountService');
const phoneVerificationService = require('../services/phoneVerificationService');
const { apiError } = require('../utils/apiError');

router.get('/profile-status', verifyUser, async (req, res) => {
  if (!req.store?.id) return apiError(res, 400, 'Tenant context required', 'TENANT_CONTEXT_REQUIRED');
  try {
    const status = await accountService.getProfileStatus(req.store?.id, req.user.sub);
    const phoneVerification = await phoneVerificationService.getStatus(req.user.sub, req.store.id);
    res.json({ success: true, ...status, phone_verification: phoneVerification });
  } catch (err) {
    logger.error('[account] profile status failed:', err.message);
    apiError(res, 500, 'Unable to load profile status.', 'PROFILE_STATUS_LOAD_FAILED');
  }
});

router.get('/profile', verifyUser, async (req, res) => {
  if (!req.store?.id) return apiError(res, 400, 'Tenant context required', 'TENANT_CONTEXT_REQUIRED');
  try {
    const { data } = await require('../services/supabase').supabase
      .from('user_profiles')
      .select('*')
      .eq('user_id', req.user.sub)
      .eq('store_id', req.store.id)
      .maybeSingle();
    res.json({ success: true, profile: data || null });
  } catch (err) {
    logger.error('[account] profile fetch failed:', err.message);
    apiError(res, 500, 'Unable to load profile.', 'PROFILE_LOAD_FAILED');
  }
});

router.patch('/profile', verifyUser, async (req, res) => {
  try {
    if (!req.store?.id) return apiError(res, 400, 'Tenant context required', 'TENANT_CONTEXT_REQUIRED');
    const profile = await accountService.updateProfile(req.store?.id, req.user.sub, req.body || {});
    res.json({ success: true, profile });
  } catch (err) {
    logger.error('[account] profile update failed:', err.message);
    apiError(res, err.statusCode || 500, err.statusCode === 403 ? err.message : 'Unable to update profile.', err.code || 'PROFILE_UPDATE_FAILED');
  }
});

router.get('/addresses', verifyUser, async (req, res) => {
  try {
    if (!req.store?.id) return apiError(res, 400, 'Tenant context required', 'TENANT_CONTEXT_REQUIRED');
    const addresses = await accountService.listAddresses(req.user.sub, req.store.id);
    res.json({ success: true, addresses });
  } catch (err) {
    logger.error('[account] address list failed:', err.message);
    apiError(res, 500, 'Unable to load addresses.', 'ADDRESS_LIST_FAILED');
  }
});

router.post('/addresses', verifyUser, validateBody(addressSchema), async (req, res) => {
  try {
    if (!req.store?.id) return apiError(res, 400, 'Tenant context required', 'TENANT_CONTEXT_REQUIRED');
    const address = await accountService.saveAddress(req.user.sub, null, req.body || {}, req.store?.id);
    res.json({ success: true, address });
  } catch (err) {
    logger.error('[account] address create failed:', err.message);
    apiError(res, err.statusCode || 500, 'Unable to save address.', err.code || 'ADDRESS_SAVE_FAILED');
  }
});

router.patch('/addresses/:id', verifyUser, validateBody(addressSchema), async (req, res) => {
  try {
    if (!req.store?.id) return apiError(res, 400, 'Tenant context required', 'TENANT_CONTEXT_REQUIRED');
    const address = await accountService.saveAddress(req.user.sub, req.params.id, req.body || {}, req.store?.id);
    res.json({ success: true, address });
  } catch (err) {
    logger.error('[account] address update failed:', err.message);
    apiError(res, err.statusCode || 500, 'Unable to save address.', err.code || 'ADDRESS_SAVE_FAILED');
  }
});

router.delete('/addresses/:id', verifyUser, async (req, res) => {
  try {
    if (!req.store?.id) return apiError(res, 400, 'Tenant context required', 'TENANT_CONTEXT_REQUIRED');
    await accountService.deleteAddress(req.user.sub, req.params.id, req.store.id);
    res.json({ success: true });
  } catch (err) {
    logger.error('[account] address delete failed:', err.message);
    apiError(res, 500, 'Unable to delete address.', 'ADDRESS_DELETE_FAILED');
  }
});

router.get('/notifications', verifyUser, async (req, res) => {
  try {
    if (!req.store?.id) return apiError(res, 400, 'Tenant context required', 'TENANT_CONTEXT_REQUIRED');
    const limit = Math.min(Number(req.query.limit) || 10, 50);
    const notifications = await accountService.listNotifications(req.user.sub, req.store.id, limit);
    res.json({ success: true, notifications });
  } catch (err) {
    logger.error('[account] notifications list failed:', err.message);
    apiError(res, 500, 'Unable to load notifications.', 'NOTIFICATIONS_LOAD_FAILED');
  }
});

router.post('/notifications/read-all', verifyUser, async (req, res) => {
  try {
    if (!req.store?.id) return apiError(res, 400, 'Tenant context required', 'TENANT_CONTEXT_REQUIRED');
    const notifications = await accountService.markNotificationsRead(req.user.sub, req.store.id);
    res.json({ success: true, notifications });
  } catch (err) {
    logger.error('[account] notifications mark-read failed:', err.message);
    apiError(res, 500, 'Unable to update notifications.', 'NOTIFICATIONS_UPDATE_FAILED');
  }
});

router.post('/login-log', verifyUser, async (req, res) => {
  try {
    if (!req.store?.id) return apiError(res, 400, 'Tenant context required', 'TENANT_CONTEXT_REQUIRED');
    await accountService.recordLogin(req.store?.id, req.user, req.body);
    res.json({ success: true });
  } catch (err) {
    logger.error('[account] login log failed:', err.message);
    apiError(res, 500, 'Unable to record login.', 'LOGIN_LOG_FAILED');
  }
});

module.exports = router;
