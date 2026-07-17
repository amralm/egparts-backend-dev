const strategies = require('./ConsumptionStrategies');

/**
 * PolicyPipeline
 * Middleware that intercepts requests, evaluates policy, and consumes limits.
 */
class PolicyPipeline {
  constructor(registry, resolver, matrix) {
    this.registry = registry;
    this.resolver = resolver;
    this.matrix = matrix;
  }

  async execute(policyId, context, usageDelta = 1) {
    const policy = this.registry.get(policyId);
    if (!policy) throw new Error(`Policy ${policyId} not found`);
    
    // 1. Permission Check (Authorization)
    if (policy.permission && !this._hasPermission(context, policy.permission)) {
      throw new Error(`Missing permission: ${policy.permission}`);
    }
    
    // 2. Entitlement Resolution & Strategy Application
    const consumedCapabilities = [];
    
    for (const capRef of policy.consume || []) {
      const capId = capRef.id || capRef;
      const delta = capRef.delta || usageDelta;
      
      const capability = this.matrix.get(capId);
      if (!capability) throw new Error(`Capability ${capId} not found`);
      
      const entitlement = await this.resolver.resolveLimit(context.tenantId, capability.id);
      
      if (!entitlement.allowed) {
        // Rollback any reserves here if needed
        throw new Error(`Quota exceeded for ${capability.id}`);
      }
      
      // Execute Strategy
      const strategyName = policy.strategy || capability.defaultStrategy || 'immediate';
      const strategy = strategies[strategyName];
      if (!strategy) throw new Error(`Unknown strategy ${strategyName}`);
      
      const result = await strategy.execute(context, capability, delta);
      consumedCapabilities.push({ capability: capability.id, result });
    }
    
    // 3. Emit Domain Events
    if (policy.auditEvent) {
      // eventBus.publish(...)
    }
    
    return { success: true, consumed: consumedCapabilities };
  }
  
  _hasPermission(context, permission) {
    // Evaluate against context.actorId roles
    return true; // Stub
  }
}

module.exports = PolicyPipeline;