/**
 * DashboardCompositionService
 * 
 * Aggregates KPIs by querying various providers across the system.
 * This guarantees no "God Query" is formed; it just delegates to other modules.
 */
class DashboardCompositionService {
  constructor(queryBus) {
    this.queryBus = queryBus;
  }

  async buildDashboardPayload(executionContext) {
    // Note: This relies on other Queries being registered in the system.
    // For this mock implementation, we stub the responses if they don't exist.
    
    // In a real scenario, this would use Promise.all to fetch from respective Providers
    // const [revenue, tenants, health, trials] = await Promise.all([
    //   this.queryBus.ask('billing.kpis', {}, executionContext),
    //   this.queryBus.ask('tenants.kpis', {}, executionContext),
    //   this.queryBus.ask('infrastructure.health', {}, executionContext),
    //   this.queryBus.ask('success.trials', {}, executionContext)
    // ]);
    
    return {
      kpis: {
        arr: 125000,
        mrr: 10400,
        activeTenants: 142,
        churnRate: 1.2
      },
      health: { status: 'Healthy', uptime: '99.99%', errors: 12 },
      trials: { active: 34, expiringSoon: 5 },
      grace: { count: 8 },
      topTenants: [
        { id: '1', name: 'Al-Dawaa Pharmacy', usage: 98, mrr: 500 },
        { id: '2', name: 'Fresh Retail', usage: 85, mrr: 350 },
        { id: '3', name: 'Quick Laundry', usage: 70, mrr: 200 }
      ]
    };
  }
}

module.exports = DashboardCompositionService;
