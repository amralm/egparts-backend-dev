/**
 * PluginManifest
 * Defines the structure that every Business Module must export.
 */
class PluginManifest {
  constructor(data) {
    this.id = data.id; // e.g., 'billing' or 'pharmacy'
    this.moduleVersion = data.moduleVersion || data.version;
    this.manifestVersion = data.manifestVersion || '1.0.0';
    this.type = data.type; // 'platform' or 'tenant'
    
    // Core Registry Dependencies
    this.minimumKernelVersion = data.minimumKernelVersion || data.compatibility?.kernel || '1.0.0';
    this.dependencies = data.dependencies || []; // e.g., ['billing']
    
    // Feature & Operational Metadata
    this.features = data.features || [];
    this.permissions = data.permissions || [];
    this.commands = data.commands || [];
    this.queries = data.queries || [];
    this.policies = data.policies || [];
    this.events = data.events || [];
    this.routes = data.routes || []; // e.g., Express routes
    
    // Massive Manifest Extensions (UI/UX Contributions)
    this.navigation = data.navigation || [];
    this.widgets = data.widgets || [];
    this.workspaceTabs = data.workspaceTabs || [];
    this.inspectorPanels = data.inspectorPanels || [];
    this.contextActions = data.contextActions || [];
    this.searchProviders = data.searchProviders || [];
    this.quickActions = data.quickActions || [];
    
    this.assets = data.assets || {};
    this.configuration = data.configuration || {};
    
    // Infrastructure
    this.migrations = data.migrations || [];
    this.seeders = data.seeders || [];
    this.jobs = data.jobs || []; // Cron, Delayed
    this.webhooks = data.webhooks || [];
    
    // Lifecycle Hooks
    this.onInstall = data.onInstall || (async () => {});
    this.onStart = data.onStart || (async () => {});
    this.onStop = data.onStop || (async () => {});
    this.healthCheck = data.healthCheck || (async () => ({ status: 'UP' }));
  }
}

module.exports = PluginManifest;\n