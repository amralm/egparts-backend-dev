/**
 * QueryBus
 * Executes read operations (Queries) with caching policies.
 */
class QueryBus {
  constructor() {
    this.handlers = new Map();
    this.cache = new Map(); // Simple in-memory cache stub
    this.entityDependencyGraph = new Map(); // Entity -> Set of cacheKeys
  }

  /**
   * Registers a handler for a query.
   */
  register(queryName, handler, cachePolicy = { ttl: 0, dependsOn: [] }) {
    if (this.handlers.has(queryName)) {
      throw new Error(\`Query handler for \${queryName} is already registered.\`);
    }
    this.handlers.set(queryName, { handler, cachePolicy });
  }

  /**
   * Invalidates all cached queries that depend on a specific entity.
   */
  invalidate(entityName) {
    const dependentKeys = this.entityDependencyGraph.get(entityName);
    if (dependentKeys) {
      for (const key of dependentKeys) {
        this.cache.delete(key);
      }
      dependentKeys.clear();
      console.log(\`[QueryBus] Invalidated cache for entity: \${entityName}\`);
    }
  }

  /**
   * Executes a query, respecting its caching policy and dependency graph.
   * Options:
   *  - bypassCache (boolean): Skip reading from cache, but still write to it.
   *  - forceRefresh (boolean): Skip reading, execute handler, and overwrite cache.
   */
  async ask(queryName, payload, context, options = {}) {
    const registration = this.handlers.get(queryName);
    if (!registration) {
      throw new Error(\`No handler registered for query: \${queryName}\`);
    }
    
    const { handler, cachePolicy } = registration;
    const executionContext = context.clone({ command: queryName });
    const { bypassCache = false, forceRefresh = false } = options;
    
    if (cachePolicy.ttl > 0) {
      const cacheKey = \`\${queryName}_\${JSON.stringify(payload)}_\${context.tenantId}\`;
      const cached = this.cache.get(cacheKey);
      const isExpired = !cached || cached.expires <= Date.now();
      const isStale = cached && cachePolicy.staleWhileRevalidate && cached.staleAt <= Date.now();
      
      // Cache Hit (Valid or Stale)
      if (cached && !isExpired && !bypassCache && !forceRefresh) {
        if (isStale) {
           // Fire-and-forget revalidation in background
           this._executeAndCache(handler, payload, executionContext, cacheKey, cachePolicy).catch(err => {
              console.error(\`[QueryBus] Background revalidation failed for \${queryName}:\`, err);
           });
        }
        return cached.data;
      }
      
      // Cache Miss or Expired or Force Refresh
      return await this._executeAndCache(handler, payload, executionContext, cacheKey, cachePolicy);
    }

    return handler(payload, executionContext);
  }

  async _executeAndCache(handler, payload, context, cacheKey, cachePolicy) {
    const result = await handler(payload, context);
    
    const expires = Date.now() + (cachePolicy.ttl * 1000);
    const staleAt = cachePolicy.staleWhileRevalidate 
        ? Date.now() + (cachePolicy.staleWhileRevalidate * 1000) 
        : expires;
        
    this.cache.set(cacheKey, { data: result, expires, staleAt });
    
    // Register in Dependency Graph
    if (cachePolicy.dependsOn && Array.isArray(cachePolicy.dependsOn)) {
       for (const entity of cachePolicy.dependsOn) {
          if (!this.entityDependencyGraph.has(entity)) {
             this.entityDependencyGraph.set(entity, new Set());
          }
          this.entityDependencyGraph.get(entity).add(cacheKey);
       }
    }
    
    return result;
  }
}

module.exports = QueryBus;\n