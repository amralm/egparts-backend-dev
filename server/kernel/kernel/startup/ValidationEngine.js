/**
 * ValidationEngine
 * Fails fast at startup if architectural invariants are violated.
 */
class ValidationEngine {
  constructor(moduleRegistry, capabilityMatrix, dependencyGraph, policyRegistry) {
    this.moduleRegistry = moduleRegistry;
    this.capabilityMatrix = capabilityMatrix;
    this.dependencyGraph = dependencyGraph;
    this.policyRegistry = policyRegistry;
  }

  validate() {
    console.log('[ValidationEngine] Starting strict invariant checks...');
    
    // 1. Validate Capabilities
    const caps = this.capabilityMatrix.getAll();
    if (caps.length === 0) console.warn('[ValidationEngine] Warning: 0 capabilities registered.');
    
    // 2. Validate Dependency Graph (Cycles)
    this.dependencyGraph.build(); // Throws if cycles or missing deps
    
    // 3. Validate Policies
    const policies = this.policyRegistry.getAll();
    for (const policy of policies) {
      if (policy.consume) {
        for (const capRef of policy.consume) {
          const capId = capRef.id || capRef;
          if (!this.capabilityMatrix.get(capId)) {
            throw new Error(`Policy ${policy.id} references unknown capability: ${capId}`);
          }
        }
      }
    }
    
    console.log('[ValidationEngine] Validation successful. System is safe to start.');
    return true;
  }
}

module.exports = ValidationEngine;\n