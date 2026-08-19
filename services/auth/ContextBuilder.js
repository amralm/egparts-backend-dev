const supabase = require('../supabase');

class ContextBuilder {
  /**
   * Resolves the Store ID and metadata from the request origin/host
   * @param {Object} req - The Express request object
   * @returns {Promise<Object>} Store context object
   */
  async build(req) {
    const origin = req.headers.origin || req.headers.host;
    
    // Fallback parsing for localhost or dev domains if needed
    // In production, this would query a domains or stores table to find the store mapping.
    // For EGParts SaaS architecture, we map the host/subdomain to a store.
    
    let hostname;
    try {
      hostname = new URL(origin).hostname;
    } catch {
      hostname = origin.split(':')[0]; // Fallback for raw host
    }
    hostname = String(hostname || '').toLowerCase().trim();
    if (!/^[a-z0-9][a-z0-9.-]{0,250}$/.test(hostname)) {
      const err = new Error('Invalid host');
      err.statusCode = 400;
      throw err;
    }

    // Default to the main store if parsing fails, but ideally look up by domain
    // For this implementation, we will query the `stores` or `domains` table.
    // We assume there's a `domains` table or a `custom_domain` column in `stores`.
    
    // We will do a generic lookup. If you have a specific table for domains, adjust this.
    const subdomain = hostname.endsWith('.egparts.store')
      ? hostname.slice(0, -'.egparts.store'.length)
      : hostname;
    let { data: store, error } = await supabase
      .from('stores')
      .select('id, store_name, custom_domain, subdomain, status, plan_id')
      .eq('custom_domain', hostname)
      .eq('status', 'active')
      .limit(1)
      .maybeSingle();

    if (!store && !error) {
      ({ data: store, error } = await supabase
        .from('stores')
        .select('id, store_name, custom_domain, subdomain, status, plan_id')
        .eq('subdomain', subdomain)
        .eq('status', 'active')
        .limit(1)
        .maybeSingle());
    }

    if (error || !store) {
      // If we can't resolve from domain, we might need a fallback or fail.
      // For local dev, maybe fallback to a known test store ID, but for security, we throw.
      const err = new Error('Could not resolve store context from host');
      err.statusCode = 404;
      throw err;
    }

    return store;
  }
}

module.exports = new ContextBuilder();
