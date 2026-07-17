const express = require('express');
const router = express.Router();

module.exports = (commandBus, queryBus) => {
  
  // View live consumption across the platform
  router.get('/live', async (req, res) => {
    try {
      const data = await queryBus.ask('platform.usage.live', req.query, req.executionContext);
      res.json(data);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // View historical usage for billing forecast
  router.get('/historical', async (req, res) => {
    try {
      const data = await queryBus.ask('platform.usage.historical', req.query, req.executionContext);
      res.json(data);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  return router;
};\n