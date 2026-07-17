/**
 * PolicyRegistry
 * Maps Policies to the Capabilities they consume.
 */
class PolicyRegistry {
  constructor() {
    this.policies = new Map(); // policyId -> Policy Definition
  }

  register(def) {
    if (!def.id) throw new Error('Policy must have an ID');
    if (this.policies.has(def.id)) throw new Error(`Policy ${def.id} already exists`);
    this.policies.set(def.id, def);
  }

  get(id) {
    return this.policies.get(id);
  }
  
  getAll() {
    return Array.from(this.policies.values());
  }
}

module.exports = new PolicyRegistry();\n