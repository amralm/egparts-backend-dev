const express = require('express');
const router = express.Router();

module.exports = (commandBus, queryBus) => {
  
  // Rotate API Keys for an integration
  router.post('/rotate-keys', async (req, res) => {
    try {
      const result = await commandBus.execute('platform.security.rotateKeys', req.body, req.executionContext);
      res.json(result);
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  return router;
};\n