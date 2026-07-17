const express = require('express');
const router = express.Router();

module.exports = (moduleRegistry) => {
  /**
   * GET /api/platform/context
   * Returns the global Execution Context for the Platform Shell,
   * including the dynamically generated Manifest (Navigation, Widgets, etc.)
   */
  router.get('/', async (req, res) => {
    try {
      // In a real app, this comes from req.executionContext populated by Auth/Tenant middleware
      const executionContext = req.executionContext || {
        environment: process.env.NODE_ENV || 'production',
        region: 'Global',
        user: {
          id: req.user?.id || 'sysadmin-1',
          email: req.user?.email || 'admin@platform.com',
          role: 'SuperAdmin'
        },
        impersonation: null,
        featureFlags: {
          beta_dashboard: true
        },
        permissions: ['*'],
        capabilities: ['*']
      };

      // Get manifest-driven UI elements filtered by context
      const uiManifest = moduleRegistry.getUIManifest(executionContext);

      res.json({
        context: executionContext,
        manifest: uiManifest
      });
    } catch (err) {
      console.error('[Platform Context API] Error:', err);
      res.status(500).json({ error: 'Internal Server Error' });
    }
  });

  return router;
};
