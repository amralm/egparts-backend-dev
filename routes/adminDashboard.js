const express = require('express');
const router = express.Router();
const logger = require('../utils/logger');
const { verifyPermission } = require('../middleware/auth');
const adminDashboardService = require('../services/adminDashboardService');

router.post('/', verifyPermission('usage.view'), async (req, res) => {
  if (!req.store?.id) {
    return res.status(400).json({ success: false, code: 'TENANT_CONTEXT_REQUIRED', error: 'Tenant context is required.' });
  }

  try {
    const dashboard = await adminDashboardService.getDashboard(req.store.id, req.body?.settings || {});
    res.json({ success: true, ...dashboard });
  } catch (err) {
    logger.error('[admin-dashboard] load failed:', err.message);
    res.status(500).json({ success: false, error: 'Unable to load dashboard.' });
  }
});

module.exports = router;
