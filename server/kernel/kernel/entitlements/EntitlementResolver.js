/**
 * EntitlementResolver
 * The ONLY place where limits and entitlements are calculated.
 */
class EntitlementResolver {
  constructor(capabilityMatrix, dependencyGraph) {
    this.matrix = capabilityMatrix;
    this.graph = dependencyGraph;
  }

  /**
   * Resolves the final limit for a specific capability for a tenant.
   * Cascade: Plan -> Version -> Add-ons -> Overrides -> Feature Flags -> Grants -> Usage
   */
  async resolveLimit(tenantId, capabilityId) {
    const cap = this.matrix.get(capabilityId);
    if (!cap) throw new Error(`Unknown capability ${capabilityId}`);
    
    // 1. Fetch raw data (In real implementation, from DB/Cache)
    const { plan, addOns, overrides, usage, flags } = await this._fetchTenantData(tenantId);
    
    // 2. Cascade computation
    let baseLimit = plan?.capabilities?.[cap.id] ?? 0;
    
    if (addOns) {
      for (const addon of addOns) {
        if (addon.capabilities?.[cap.id]) {
          baseLimit += addon.capabilities[cap.id];
        }
      }
    }
    
    if (overrides?.[cap.id] !== undefined) {
      baseLimit = overrides[cap.id]; // Absolute override
    }
    
    // 3. Dependency Check: If a parent/dependency is disabled, this is disabled (limit = 0)
    // (We would check if any required dependency has limit === 0 or flag === false)
    if (flags?.[cap.id] === false) {
      baseLimit = 0;
    }
    
    const currentUsage = usage?.[cap.id] ?? 0;
    
    return {
      allowed: baseLimit === -1 || currentUsage < baseLimit,
      limit: baseLimit,
      usage: currentUsage,
      remaining: baseLimit === -1 ? Infinity : Math.max(0, baseLimit - currentUsage)
    };
  }
  
  async _fetchTenantData(tenantId) {
    // Stub for fetching data via Repositories
    return { plan: {}, addOns: [], overrides: {}, usage: {}, flags: {} };
  }
}

module.exports = EntitlementResolver;\n