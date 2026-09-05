const { apiError } = require('../utils/apiError');
const { sendSuccess } = require('../utils/apiResponse');
const express = require('express');
const router = express.Router();
const logger = require('../utils/logger');
const { verifyPermission } = require('../middleware/auth');
const adminDashboardService = require('../services/adminDashboardService');

router.post('/', verifyPermission('usage.view'), async (req, res) => {
  if (!req.store?.id) {
    return apiError(res, 400, 'Tenant context is required.', 'TENANT_CONTEXT_REQUIRED');
  }

  try {
    const period = typeof req.body?.period === 'string' ? req.body.period.trim() : '30d';
    const dashboard = await adminDashboardService.getDashboard(req.store.id, req.body?.settings || {}, period);
    sendSuccess(res, { ...dashboard });
  } catch (err) {
    logger.error('[admin-dashboard] load failed:', err.message);
    apiError(res, 500, 'Unable to load dashboard.', `HTTP_500`);
  }
});

module.exports = router;
