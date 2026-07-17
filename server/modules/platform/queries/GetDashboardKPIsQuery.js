const DashboardCompositionService = require('../services/DashboardCompositionService');

/**
 * GetDashboardKPIsQuery
 * Retrieves the aggregated KPIs for the Platform Dashboard.
 */
module.exports = async (payload, context) => {
  // We use the CompositionService to aggregate across domain modules
  // The queryBus is passed via context, assuming standard Kernel architecture
  const queryBus = context.kernel?.queryBus || { ask: async () => ({}) }; // Fallback for testing
  
  const compositionService = new DashboardCompositionService(queryBus);
  return await compositionService.buildDashboardPayload(context);
};
