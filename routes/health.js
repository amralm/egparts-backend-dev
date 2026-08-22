const express = require('express');
const router = express.Router();
const { getSnapshot } = require('../services/healthCollector');
const { verifyPlatformPermission } = require('../middleware/platformAdmin');
const { supabase } = require('../services/supabase');
const logger = require('../utils/logger');
const { sendSuccess } = require('../utils/apiResponse');

// Public liveness endpoint for Render/load balancers. Keep infrastructure
// details out of this response; the authenticated platform endpoint exposes
// the full health snapshot.
router.get('/', (req, res) => {
  sendSuccess(res, { status: 'ok',
    service: 'eg-parts-backend',
    timestamp: new Date().toISOString(),
    requestId: req.correlationId || req.id || null }, { status: 200 });
});

// GET /api/health/platform
router.get('/platform', verifyPlatformPermission('platform.health.read'), async (req, res) => {
  try {
    const snapshot = await getSnapshot();
    sendSuccess(res, snapshot);
  } catch (err) {
    logger.error('Failed to retrieve health snapshot:', err);
    // Return a degraded snapshot instead of 500 to prevent frontend crash
    sendSuccess(res, {
      timestamp: new Date().toISOString(),
      overall_status: 'degraded',
      services: {},
      message: 'Failed to retrieve full health snapshot'
    }, { status: 200 });
  }
});

// GET /api/health/maintenance - Public endpoint to check maintenance status
router.get('/maintenance', async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('system_settings')
      .select('key, value')
      .in('key', ['maintenance_mode', 'dev_mode_enabled']);

    const settings = {};
    if (!error && data) {
      data.forEach(s => { settings[s.key] = s.value; });
    }

    sendSuccess(res, {
      maintenance: settings['maintenance_mode'] === 'true',
      devMode: settings['dev_mode_enabled'] === 'true' || global.DEV_MODE_ENABLED === true
    });
  } catch (err) {
    sendSuccess(res, { maintenance: false, devMode: global.DEV_MODE_ENABLED === true });
  }
});

module.exports = router;
