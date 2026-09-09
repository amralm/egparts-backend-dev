/**
 * QueryBus
 * Executes read operations (Queries) with caching policies.
 */
class QueryBus {
  constructor() {
    this.handlers = new Map();
    this.cache = new Map();
    this.entityDependencyGraph = new Map();
  }

  register(queryName, handler, cachePolicy = { ttl: 0, dependsOn: [] }) {
    if (this.handlers.has(queryName)) {
      throw new Error('Query handler for ' + queryName + ' is already registered.');
    }
    this.handlers.set(queryName, { handler, cachePolicy });
  }

  invalidate(entityName) {
    const dependentKeys = this.entityDependencyGraph.get(entityName);
    if (dependentKeys) {
      for (const key of dependentKeys) {
        this.cache.delete(key);
      }
      dependentKeys.clear();
    }
  }

  async ask(queryName, payload, context, options = {}) {
    const registration = this.handlers.get(queryName);
    if (!registration) {
      throw new Error('No handler registered for query: ' + queryName);
    }
    const { handler, cachePolicy } = registration;
    const executionContext = context.clone ? context.clone({ command: queryName }) : context;
    const { bypassCache = false, forceRefresh = false } = options;
    if (cachePolicy.ttl > 0) {
      const cacheKey = queryName + '_' + JSON.stringify(payload) + '_' + (context.tenantId || 'default');
      const cached = this.cache.get(cacheKey);
      const isExpired = !cached || cached.expires <= Date.now();
      const isStale = cached && cachePolicy.staleWhileRevalidate && cached.staleAt <= Date.now();
      if (cached && !isExpired && !bypassCache && !forceRefresh) {
        if (isStale) {
          this._executeAndCache(handler, payload, executionContext, cacheKey, cachePolicy).catch(err => {
            console.error('[QueryBus] Background revalidation failed for ' + queryName, err);
          });
        }
        return cached.data;
      }
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


module.exports = QueryBus;
