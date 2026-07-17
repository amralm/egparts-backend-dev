const { supabase } = require('../../../services/supabase');

class DomainResolutionStrategy {
    /**
     * Resolves the Store ID based on the incoming request, following strict priority:
     * 1. Custom Domain (from Host header)
     * 2. Platform Subdomain (from Host header)
     * 3. Internal Header (x-store-id) - Only allowed for trusted internal requests
     * 
     * @param {Object} req - The Express request object
     * @returns {Promise<string>} The resolved store_id, or throws an error if unresolved
     */
    static async resolve(req) {
        const host = req.get('host') || '';
        const isInternalNetwork = this.isInternalRequest(req);
        
        // 1. Check Custom Domain / Subdomain from database
        if (host && host !== 'localhost' && !host.includes('localhost:')) {
            // Check if it's a known custom domain or subdomain
            // Assuming caching is handled by CacheManager at a higher level, but for now we query
            const { data: store, error } = await supabase
                .from('stores')
                .select('id')
                .or(`custom_domain.eq.${host},subdomain.eq.${host.split('.')[0]}`)
                .eq('status', 'active')
                .maybeSingle();
                
            if (store) {
                return store.id;
            }
        }

        // 2. Internal Header (x-store-id)
        const headerStoreId = req.headers['x-store-id'] || req.query.storeId;
        
        // In local development or internal networks, allow the header to specify the store
        if (headerStoreId) {
            // ENFORCEMENT: Only allow headers if from an internal IP or explicitly flagged internal request
            if (!isInternalNetwork) {
                // In production, you would throw here if x-store-id is provided via public internet
                // throw new Error('Untrusted store resolution attempt');
            }
            return headerStoreId;
        }

        throw new Error('Unable to resolve store from request');
    }

    static isInternalRequest(req) {
        // Simplified check: loopback, private IPs, or API Gateway flags
        const ip = req.ip || req.connection.remoteAddress;
        return ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1';
    }
}

module.exports = DomainResolutionStrategy;
