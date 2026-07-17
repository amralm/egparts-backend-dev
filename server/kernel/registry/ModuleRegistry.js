/**
 * ModuleRegistry
 * The heart of the Universal SaaS Framework. 
 * Manages the full lifecycle of Business Modules (Platform & Tenant).
 */
class ModuleRegistry {
  constructor(commandBus, queryBus, eventBus) {
    this.commandBus = commandBus;
    this.queryBus = queryBus;
    this.eventBus = eventBus;
    this.system = {
      kernelVersion: '1.0.0',
      uiContractVersion: '1.0.0'
    };
    
    this.modules = new Map(); // id -> Manifest
    this.states = new Map(); // id -> state (INSTALLED, STARTED, STOPPED, ERROR)
  }

  /**
   * Discovers and validates a module without starting it.
   */
  async discover(manifest) {
    // Check compatibility and dependencies
    if (this.modules.has(manifest.id)) {
      throw new Error(`Module ${manifest.id} is already discovered.`);
    }

    // Version Validation
    if (manifest.minimumKernelVersion && manifest.minimumKernelVersion > this.system.kernelVersion) {
      throw new Error(`Module ${manifest.id} requires Kernel v${manifest.minimumKernelVersion} but system is v${this.system.kernelVersion}`);
    }
    
    if (manifest.uiContractVersion && manifest.uiContractVersion > this.system.uiContractVersion) {
       throw new Error(`Module ${manifest.id} requires UI Contract v${manifest.uiContractVersion} but system is v${this.system.uiContractVersion}`);
    }
    
    // Check dependencies...
    for (const dep of manifest.dependencies) {
      if (!this.modules.has(dep)) {
        throw new Error(`Missing dependency ${dep} for module ${manifest.id}.`);
      }
    }
    
    this.modules.set(manifest.id, manifest);
    this.states.set(manifest.id, 'DISCOVERED');
    console.log(`[Registry] Discovered module: ${manifest.id}@${manifest.version}`);
  }

  /**
   * Installs a module (runs migrations, seeders).
   */
  async install(moduleId) {
    const manifest = this.modules.get(moduleId);
    if (!manifest) throw new Error('Module not found');
    
    try {
      console.log(`[Registry] Installing module ${moduleId}...`);
      await manifest.onInstall(); // Execute migrations/seeders
      this.states.set(moduleId, 'INSTALLED');
    } catch (err) {
      this.states.set(moduleId, 'ERROR');
      throw err;
    }
  }

  /**
   * Starts a module (wires up CQRS, Policies, Jobs).
   */
  async start(moduleId) {
    const manifest = this.modules.get(moduleId);
    if (!manifest) throw new Error('Module not found');
    
    try {
      // Register Commands
      for (const cmd of manifest.commands) {
        this.commandBus.register(cmd.name, cmd.handler);
      }
      
      // Register Queries
      for (const qry of manifest.queries) {
        this.queryBus.register(qry.name, qry.handler, qry.cachePolicy);
      }
      
      await manifest.onStart(this.eventBus);
      this.states.set(moduleId, 'STARTED');
      console.log(`[Registry] Started module ${moduleId}`);
    } catch (err) {
      this.states.set(moduleId, 'ERROR');
      throw err;
    }
  }

  async health(moduleId) {
    const manifest = this.modules.get(moduleId);
    if (!manifest) return { status: 'NOT_FOUND' };
    return await manifest.healthCheck();
  }

  /**
   * getUIManifest
   * Aggregates UI contributions from all STARTED modules, optionally filtering by permissions/capabilities
   * defined in the executionContext.
   */
  getUIManifest(executionContext) {
    const ui = {
      navigation: [],
      widgets: [],
      workspaceTabs: [],
      inspectorPanels: [],
      contextActions: [],
      searchProviders: [],
      quickActions: []
    };

    for (const [id, state] of this.states.entries()) {
      if (state === 'STARTED') {
        const manifest = this.modules.get(id);
        
        // In a full implementation, you would filter these arrays based on executionContext.permissions
        // and executionContext.capabilities (e.g. if item.capability is required, check if user has it).
        // For now, we aggregate everything.
        
        if (manifest.navigation) ui.navigation.push(...manifest.navigation);
        if (manifest.widgets) ui.widgets.push(...manifest.widgets);
        if (manifest.workspaceTabs) ui.workspaceTabs.push(...manifest.workspaceTabs);
        if (manifest.inspectorPanels) ui.inspectorPanels.push(...manifest.inspectorPanels);
        if (manifest.contextActions) ui.contextActions.push(...manifest.contextActions);
        if (manifest.searchProviders) ui.searchProviders.push(...manifest.searchProviders);
        if (manifest.quickActions) ui.quickActions.push(...manifest.quickActions);
      }
    }
    
    // Sort navigation by order if provided
    ui.navigation.sort((a, b) => (a.order || 99) - (b.order || 99));

    return ui;
  }
}

module.exports = ModuleRegistry;\n