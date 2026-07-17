const express = require('express');
const { verifyPermission } = require('../middleware/auth');
const tenantSecurityService = require('../services/tenantSecurityService');
const logger = require('../utils/logger');

const router = express.Router();

function getStoreId(req, res) {
  const storeId = req.store?.id;
  if (!storeId) {
    res.status(403).json({ error: 'Tenant context required' });
    return null;
  }
  return storeId;
}

function sendError(res, err) {
  const status = err.statusCode || 500;
  return res.status(status).json({
    error: status >= 500 ? 'Internal server error' : (err.code || 'Request failed')
  });
}

router.get('/blocked-ips', verifyPermission('platform.security.block_ip'), async (req, res) => {
  const storeId = getStoreId(req, res);
  if (!storeId) return;
  try {
    const blockedIps = await tenantSecurityService.listBlockedIps(storeId);
    res.json({ success: true, blockedIps });
  } catch (err) {
    logger.error('[tenant-security] list blocked IPs failed:', err.message);
    sendError(res, err);
  }
});

router.post('/blocked-ips', verifyPermission('platform.security.block_ip'), async (req, res) => {
  const storeId = getStoreId(req, res);
  if (!storeId) return;
  try {
    const blockedIp = await tenantSecurityService.blockIp(storeId, req.body || {});
    res.status(201).json({ success: true, blockedIp });
  } catch (err) {
    logger.error('[tenant-security] block IP failed:', err.message);
    sendError(res, err);
  }
});

router.delete('/blocked-ips/:id', verifyPermission('platform.security.block_ip'), async (req, res) => {
  const storeId = getStoreId(req, res);
  if (!storeId) return;
  try {
    await tenantSecurityService.unblockIpById(storeId, req.params.id);
    res.json({ success: true });
  } catch (err) {
    logger.error('[tenant-security] unblock IP failed:', err.message);
    sendError(res, err);
  }
});

router.post('/blocked-ips/toggle', verifyPermission('platform.security.block_ip'), async (req, res) => {
  const storeId = getStoreId(req, res);
  if (!storeId) return;
  try {
    if (req.body?.blocked) {
      await tenantSecurityService.unblockIpAddress(storeId, req.body.ip_address);
      return res.json({ success: true, blocked: false });
    }
    const blockedIp = await tenantSecurityService.blockIp(storeId, {
      ip_address: req.body?.ip_address,
      reason: req.body?.reason || 'Blocked from login logs'
    });
    res.json({ success: true, blocked: true, blockedIp });
  } catch (err) {
    logger.error('[tenant-security] toggle IP failed:', err.message);
    sendError(res, err);
  }
});

router.get('/login-logs', verifyPermission('platform.security.view_logs'), async (req, res) => {
  const storeId = getStoreId(req, res);
  if (!storeId) return;
  try {
    const result = await tenantSecurityService.listLoginLogs(storeId, req.query || {});
    res.json({ success: true, ...result });
  } catch (err) {
    logger.error('[tenant-security] list login logs failed:', err.message);
    sendError(res, err);
  }
});

router.delete('/login-logs/:id', verifyPermission('platform.security.view_logs'), async (req, res) => {
  const storeId = getStoreId(req, res);
  if (!storeId) return;
  try {
    await tenantSecurityService.deleteLoginLog(storeId, req.params.id);
    res.json({ success: true });
  } catch (err) {
    logger.error('[tenant-security] delete login log failed:', err.message);
    sendError(res, err);
  }
});

router.post('/login-logs/prune', verifyPermission('platform.security.view_logs'), async (req, res) => {
  const storeId = getStoreId(req, res);
  if (!storeId) return;
  try {
    const result = await tenantSecurityService.pruneLoginLogs(storeId, req.body?.keepLatest || 500);
    res.json({ success: true, ...result });
  } catch (err) {
    logger.error('[tenant-security] prune login logs failed:', err.message);
    sendError(res, err);
  }
});

module.exports = router;
