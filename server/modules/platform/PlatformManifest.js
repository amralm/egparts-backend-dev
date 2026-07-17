const PluginManifest = require('../../kernel/registry/PluginManifest');
const getDashboardKPIs = require('./queries/GetDashboardKPIsQuery');

module.exports = new PluginManifest({
  id: 'platform',
  version: '1.0.0',
  type: 'platform',
  compatibility: { kernel: '>=1.0.0' },
  
  queries: [
    {
      name: 'platform.dashboard.kpis',
      handler: getDashboardKPIs,
      cachePolicy: { ttl: 60, dependsOn: ['Tenant', 'Subscription', 'Order'] } // Cache for 60 seconds or until any of these entities change
    }
  ],
  
  // Manifest-Driven UI Contributions
  navigation: [
    { id: 'dashboard', name: 'Dashboard', path: '/platform', icon: 'space_dashboard', order: 1 },
    { id: 'tenants', name: 'Tenants', path: '/platform/tenants', icon: 'storefront', order: 2 },
    { id: 'plans', name: 'Plans', path: '/platform/plans', icon: 'local_offer', order: 3 },
    { id: 'capabilities', name: 'Capabilities', path: '/platform/capabilities', icon: 'settings_suggest', order: 4 },
    { id: 'usage', name: 'Usage', path: '/platform/usage', icon: 'monitoring', order: 5 },
    { id: 'security', name: 'Security', path: '/platform/security', icon: 'security', order: 6 },
    { id: 'infrastructure', name: 'Infrastructure', path: '/platform/infrastructure', icon: 'memory', order: 7 },
    { id: 'developer', name: 'Developer', path: '/platform/developer', icon: 'code', order: 8 },
    { id: 'success', name: 'Customer Success', path: '/platform/success', icon: 'support_agent', order: 9 }
  ],
  
  widgets: [
    { id: 'platform.kpi.arr', type: 'metric', provider: 'platform.dashboard.kpis', path: 'kpis.arr' },
    { id: 'platform.kpi.mrr', type: 'metric', provider: 'platform.dashboard.kpis', path: 'kpis.mrr' },
    { id: 'platform.kpi.tenants', type: 'metric', provider: 'platform.dashboard.kpis', path: 'kpis.activeTenants' },
    { id: 'platform.kpi.churn', type: 'metric', provider: 'platform.dashboard.kpis', path: 'kpis.churnRate' },
    { id: 'platform.health', type: 'health_card', provider: 'platform.dashboard.kpis', path: 'health' },
    { id: 'platform.action_required', type: 'alerts_card', provider: 'platform.dashboard.kpis', paths: ['trials', 'grace'] },
    { id: 'platform.top_tenants', type: 'list_card', provider: 'platform.dashboard.kpis', path: 'topTenants' }
  ],
  
  // Future implementation of Platform Commands (Tenant mgmt, etc.)
  commands: [],
  
  onInstall: async () => {
    console.log('[PlatformModule] Installing...');
    // e.g. seed super_admins table if needed
  },
  
  onStart: async (eventBus) => {
    console.log('[PlatformModule] Started successfully.');
  },
  
  healthCheck: async () => {
    return { status: 'UP', message: 'Platform Module is healthy.' };
  }
});
