const express = require('express');
const router = express.Router();
const logger = require('../utils/logger');
const { verifyUser } = require('../middleware/auth');
const accountService = require('../services/accountService');
const phoneVerificationService = require('../services/phoneVerificationService');

router.get('/profile-status', verifyUser, async (req, res) => {
  if (!req.store?.id) return res.status(400).json({ success: false, error: 'Tenant context required' });
  try {
    const status = await accountService.getProfileStatus(req.store?.id, req.user.sub);
    const phoneVerification = await phoneVerificationService.getStatus(req.user.sub, req.store.id);
    res.json({ success: true, ...status, phone_verification: phoneVerification });
  } catch (err) {
    logger.error('[account] profile status failed:', err.message);
    res.status(500).json({ success: false, error: 'Unable to load profile status.' });
  }
});

router.get('/profile', verifyUser, async (req, res) => {
  if (!req.store?.id) return res.status(400).json({ success: false, error: 'Tenant context required' });
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
    res.status(500).json({ success: false, error: 'Unable to load profile.' });
  }
});

router.patch('/profile', verifyUser, async (req, res) => {
  try {
    if (!req.store?.id) return res.status(400).json({ success: false, error: 'Tenant context required' });
    const profile = await accountService.updateProfile(req.store?.id, req.user.sub, req.body || {});
    res.json({ success: true, profile });
  } catch (err) {
    logger.error('[account] profile update failed:', err.message);
    res.status(err.statusCode || 500).json({
      success: false,
      code: err.code || 'PROFILE_UPDATE_FAILED',
      error: err.statusCode === 403 ? err.message : 'Unable to update profile.'
    });
  }
});

router.get('/addresses', verifyUser, async (req, res) => {
  try {
    if (!req.store?.id) return res.status(400).json({ success: false, error: 'Tenant context required' });
    const addresses = await accountService.listAddresses(req.user.sub, req.store.id);
    res.json({ success: true, addresses });
  } catch (err) {
    logger.error('[account] address list failed:', err.message);
    res.status(500).json({ success: false, error: 'Unable to load addresses.' });
  }
});

router.post('/addresses', verifyUser, async (req, res) => {
  try {
    if (!req.store?.id) return res.status(400).json({ success: false, error: 'Tenant context required' });
    const address = await accountService.saveAddress(req.user.sub, null, req.body || {}, req.store?.id);
    res.json({ success: true, address });
  } catch (err) {
    logger.error('[account] address create failed:', err.message);
    res.status(err.statusCode || 500).json({ success: false, error: 'Unable to save address.' });
  }
});

router.patch('/addresses/:id', verifyUser, async (req, res) => {
  try {
    if (!req.store?.id) return res.status(400).json({ success: false, error: 'Tenant context required' });
    const address = await accountService.saveAddress(req.user.sub, req.params.id, req.body || {}, req.store?.id);
    res.json({ success: true, address });
  } catch (err) {
    logger.error('[account] address update failed:', err.message);
    res.status(err.statusCode || 500).json({ success: false, error: 'Unable to save address.' });
  }
});

router.delete('/addresses/:id', verifyUser, async (req, res) => {
  try {
    if (!req.store?.id) return res.status(400).json({ success: false, error: 'Tenant context required' });
    await accountService.deleteAddress(req.user.sub, req.params.id, req.store.id);
    res.json({ success: true });
  } catch (err) {
    logger.error('[account] address delete failed:', err.message);
    res.status(500).json({ success: false, error: 'Unable to delete address.' });
  }
});

router.get('/notifications', verifyUser, async (req, res) => {
  try {
    if (!req.store?.id) return res.status(400).json({ success: false, error: 'Tenant context required' });
    const limit = Math.min(Number(req.query.limit) || 10, 50);
    const notifications = await accountService.listNotifications(req.user.sub, req.store.id, limit);
    res.json({ success: true, notifications });
  } catch (err) {
    logger.error('[account] notifications list failed:', err.message);
    res.status(500).json({ success: false, error: 'Unable to load notifications.' });
  }
});

router.post('/notifications/read-all', verifyUser, async (req, res) => {
  try {
    if (!req.store?.id) return res.status(400).json({ success: false, error: 'Tenant context required' });
    const notifications = await accountService.markNotificationsRead(req.user.sub, req.store.id);
    res.json({ success: true, notifications });
  } catch (err) {
    logger.error('[account] notifications mark-read failed:', err.message);
    res.status(500).json({ success: false, error: 'Unable to update notifications.' });
  }
});

router.post('/login-log', verifyUser, async (req, res) => {
  try {
    if (!req.store?.id) return res.status(400).json({ success: false, error: 'Tenant context required' });
    await accountService.recordLogin(req.store?.id, req.user, req.body);
    res.json({ success: true });
  } catch (err) {
    logger.error('[account] login log failed:', err.message);
    res.status(500).json({ success: false, error: 'Unable to record login.' });
  }
});

module.exports = router;
