/**
 * DependencyGraph
 * Resolves hierarchies and enforces capability dependencies.
 */
class DependencyGraph {
  constructor(matrix) {
    this.matrix = matrix;
    this.graph = new Map(); // id -> array of dependent ids
  }

  build() {
    const caps = this.matrix.getAll();
    this.graph.clear();
    
    // Initialize graph
    for (const cap of caps) {
      this.graph.set(cap.id, []);
    }

    // Populate edges (Dependencies)
    for (const cap of caps) {
      if (cap.dependencies) {
        for (const depId of cap.dependencies) {
          if (!this.graph.has(depId)) {
             throw new Error(`Dependency ${depId} for ${cap.id} does not exist in Matrix.`);
          }
          // depId must exist for cap to function. So cap depends on depId.
          this.graph.get(depId).push(cap.id); 
        }
      }
      if (cap.parent) {
         if (!this.graph.has(cap.parent)) {
             throw new Error(`Parent ${cap.parent} for ${cap.id} does not exist in Matrix.`);
         }
         this.graph.get(cap.parent).push(cap.id);
      }
    }

    this.detectCycles();
  }

  detectCycles() {
    const visited = new Set();
    const recStack = new Set();

    const dfs = (nodeId) => {
      if (!visited.has(nodeId)) {
        visited.add(nodeId);
        recStack.add(nodeId);

        const neighbors = this.graph.get(nodeId) || [];
        for (const neighbor of neighbors) {
          if (!visited.has(neighbor) && dfs(neighbor)) {
            return true;
          } else if (recStack.has(neighbor)) {
            return true;
          }
        }
      }
      recStack.delete(nodeId);
      return false;
    };

    for (const nodeId of this.graph.keys()) {
      if (dfs(nodeId)) {
        throw new Error(`Cyclic dependency detected involving capability ${nodeId}`);
      }
    }
  }
  
  /**
   * If a capability is disabled, recursively get all capabilities that must also be disabled.
   */
  getCascadingDisabled(disabledId) {
    const disabled = new Set([disabledId]);
    const queue = [disabledId];
    
    while (queue.length > 0) {
      const current = queue.shift();
      const dependents = this.graph.get(current) || [];
      for (const dep of dependents) {
        if (!disabled.has(dep)) {
          disabled.add(dep);
          queue.push(dep);
        }
      }
    }
    return Array.from(disabled);
  }
}

module.exports = DependencyGraph;\n