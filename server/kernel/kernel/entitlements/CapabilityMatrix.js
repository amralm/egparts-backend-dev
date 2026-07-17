/**
 * CapabilityMatrix
 * The ultimate single source of truth for what the system can do.
 */
class CapabilityMatrix {
  constructor() {
    this.capabilities = new Map(); // id -> Capability Definition
    this.aliases = new Map(); // alias -> id
  }

  /**
   * Registers a capability definition.
   * @param {Object} def 
   */
  register(def) {
    if (!def.id) throw new Error('Capability must have an ID');
    if (this.capabilities.has(def.id)) throw new Error(`Capability ${def.id} already exists`);

    this.capabilities.set(def.id, def);
    
    // Register aliases
    if (def.aliases && Array.isArray(def.aliases)) {
      for (const alias of def.aliases) {
        if (this.aliases.has(alias)) throw new Error(`Alias ${alias} is already registered to ${this.aliases.get(alias)}`);
        this.aliases.set(alias, def.id);
      }
    }
  }

  get(idOrAlias) {
    if (this.capabilities.has(idOrAlias)) {
      return this.capabilities.get(idOrAlias);
    }
    const mappedId = this.aliases.get(idOrAlias);
    if (mappedId) {
      return this.capabilities.get(mappedId);
    }
    return null;
  }
  
  getAll() {
    return Array.from(this.capabilities.values());
  }
}

module.exports = new CapabilityMatrix();\n