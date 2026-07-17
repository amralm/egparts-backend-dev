const express = require('express');
const router = express.Router();

module.exports = (commandBus, queryBus) => {
  
  // List plans
  router.get('/', async (req, res) => {
    try {
      const data = await queryBus.ask('platform.plans.list', req.query, req.executionContext);
      res.json(data);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // Create a new plan definition
  router.post('/', async (req, res) => {
    try {
      const result = await commandBus.execute('platform.plans.create', req.body, req.executionContext);
      res.status(201).json(result);
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  // Publish a new plan version
  router.post('/:id/versions', async (req, res) => {
    try {
      const result = await commandBus.execute('platform.plans.publishVersion', { planId: req.params.id, ...req.body }, req.executionContext);
      res.json(result);
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  return router;
};\n