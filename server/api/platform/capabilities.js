const express = require('express');
const router = express.Router();

module.exports = (commandBus, queryBus, capabilityMatrix, entitlementResolver) => {
  
  // List the entire Capability Matrix
  router.get('/matrix', async (req, res) => {
    try {
      res.json(capabilityMatrix.getAll());
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // Simulate/Resolve entitlements for a tenant (Debugging tool for Super Admin)
  router.get('/resolve/:tenantId', async (req, res) => {
    try {
      const caps = capabilityMatrix.getAll();
      const resolved = {};
      for (const cap of caps) {
        resolved[cap.id] = await entitlementResolver.resolveLimit(req.params.tenantId, cap.id);
      }
      res.json(resolved);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // Manage Manual Overrides for a Tenant
  router.post('/overrides/:tenantId', async (req, res) => {
    try {
      const result = await commandBus.execute('platform.capabilities.setOverride', { tenantId: req.params.tenantId, overrides: req.body.overrides }, req.executionContext);
      res.json(result);
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  return router;
};\n