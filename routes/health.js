const express = require('express');
const router = express.Router();
const { getSnapshot } = require('../services/healthCollector');
const { verifyPlatformPermission } = require('../middleware/platformAdmin');
const { supabase } = require('../services/supabase');
const logger = require('../utils/logger');

// GET /api/health/platform
router.get('/platform', verifyPlatformPermission('platform.health.read'), async (req, res) => {
  try {
    const snapshot = await getSnapshot();
    res.json(snapshot);
  } catch (err) {
    logger.error('Failed to retrieve health snapshot:', err);
    // Return a degraded snapshot instead of 500 to prevent frontend crash
    res.status(200).json({
      timestamp: new Date().toISOString(),
      overall_status: 'degraded',
      services: {},
      error: 'Failed to retrieve full health snapshot'
    });
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

    res.json({
      maintenance: settings['maintenance_mode'] === 'true',
      devMode: settings['dev_mode_enabled'] === 'true' || global.DEV_MODE_ENABLED === true
    });
  } catch (err) {
    res.json({ maintenance: false, devMode: global.DEV_MODE_ENABLED === true });
  }
});

module.exports = router;
