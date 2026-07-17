const express = require('express');
const router = express.Router();

module.exports = (queryBus) => {
  /**
   * GET /dashboard/kpis
   * Aggregates all top-level metrics for the Platform Admin Dashboard.
   * Powered by QueryBus caching policies.
   */
  router.get('/kpis', async (req, res) => {
    try {
      // Execute the aggregated query via QueryBus
      // The QueryBus handles cache hit/miss transparently based on TTL policy
      const dashboardData = await queryBus.ask(
        'platform.dashboard.kpis', 
        {}, // payload
        req.executionContext
      );
      
      res.json(dashboardData);
    } catch (err) {
      console.error('[Dashboard API] Error fetching KPIs:', err);
      res.status(500).json({ error: 'Internal Server Error' });
    }
  });

  return router;
};
