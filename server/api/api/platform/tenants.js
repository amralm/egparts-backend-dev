const express = require('express');
const router = express.Router();

/**
 * Super Admin Tenant Management Routes
 */
module.exports = (commandBus, queryBus) => {
  
  // List all tenants (Uses QueryBus)
  router.get('/', async (req, res) => {
    try {
      const data = await queryBus.ask('platform.tenants.list', req.query, req.executionContext);
      res.json(data);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // Suspend a tenant (Uses CommandBus)
  router.post('/:id/suspend', async (req, res) => {
    try {
      const result = await commandBus.execute('platform.tenants.suspend', { tenantId: req.params.id, reason: req.body.reason }, req.executionContext);
      res.json(result);
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  // Resume a tenant
  router.post('/:id/resume', async (req, res) => {
    try {
      const result = await commandBus.execute('platform.tenants.resume', { tenantId: req.params.id }, req.executionContext);
      res.json(result);
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  // Toggle a specific module for a tenant (e.g. Turn on 'Pharmacy')
  router.post('/:id/modules/toggle', async (req, res) => {
    try {
      const { moduleId, enabled } = req.body;
      const result = await commandBus.execute('platform.tenants.toggleModule', { tenantId: req.params.id, moduleId, enabled }, req.executionContext);
      res.json(result);
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  return router;
};\n