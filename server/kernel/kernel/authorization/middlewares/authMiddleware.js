const { supabase } = require('../../../services/supabase');
const AuthorizationSnapshot = require('../contexts/AuthorizationSnapshot');
const CorrelationChain = require('../contexts/CorrelationChain');
const DomainResolutionStrategy = require('../strategies/DomainResolutionStrategy');

/**
 * authMiddleware Pipeline
 * Verifies JWT -> Resolves Store -> Builds Immutable AuthorizationSnapshot -> Freezes it
 */
const requireAuth = async (req, res, next) => {
    try {
        const authHeader = req.headers.authorization;
        if (!authHeader || !authHeader.startsWith('Bearer ')) {
            return res.status(401).json({ error: 'Missing or invalid authorization header' });
        }

        const token = authHeader.split(' ')[1];

        // 1. Verify JWT
        const { data: { user }, error: authError } = await supabase.auth.getUser(token);
        
        if (authError || !user) {
            return res.status(401).json({ error: 'Unauthorized', details: authError?.message });
        }

        const userId = user.id;

        // 2. Resolve Store (DomainResolutionStrategy)
        let targetStoreId;
        try {
            targetStoreId = await DomainResolutionStrategy.resolve(req);
        } catch (e) {
            return res.status(400).json({ error: 'Bad Request', details: e.message });
        }

        // 3. Resolve Membership & Identity
        const { data: membership, error: membershipError } = await supabase
            .from('store_memberships')
            .select('id, role')
            .eq('user_id', userId)
            .eq('store_id', targetStoreId)
            .maybeSingle();

        // 4. Fetch the real snapshot values (In a real app, use PermissionCache here)
        // Mocking cache retrieval for now
        let permissions = [];
        let planVersion = 'v1';
        let entitlementsVersion = 'e1';

        let audit = {
            ipAddress: req.ip,
            userAgent: req.headers['user-agent'],
            actorId: userId,
            real_user: userId,
            acting_as: userId,
            reason: 'Normal Access',
            expires_at: null
        };

        if (membershipError || !membership) {
            // Check Impersonation
            const { data: superAdmin } = await supabase
                .from('super_admins')
                .select('id')
                .eq('user_id', userId)
                .maybeSingle();

            if (!superAdmin) {
                return res.status(403).json({ error: 'Access denied to this store' });
            }

            // Super Admin Impersonation
            audit.acting_as = 'impersonated_tenant_owner'; // Usually fetched from a temporary grant table
            audit.reason = req.headers['x-impersonation-reason'] || 'Platform Support';
            audit.expires_at = new Date(Date.now() + 3600000).toISOString(); // 1 hour

            req.context = new AuthorizationSnapshot({
                identity: { userId: userId, email: user.email },
                membership: { membershipId: 'impersonation_grant', status: 'active', role: 'super_admin' },
                store: { storeId: targetStoreId, domain: req.get('host') },
                permissions: ['*'], // Super admins typically have wildcard access
                planVersion,
                entitlementsVersion,
                audit,
                correlationChain: new CorrelationChain({
                    requestId: req.headers['x-request-id'],
                    sessionId: req.headers['x-session-id'],
                    correlationId: req.headers['x-correlation-id']
                })
            });
        } else {
            // Normal Access
            req.context = new AuthorizationSnapshot({
                identity: { userId: userId, email: user.email },
                membership: { membershipId: membership.id, status: 'active', role: membership.role },
                store: { storeId: targetStoreId, domain: req.get('host') },
                permissions, // Loaded from permission cache
                planVersion,
                entitlementsVersion,
                audit,
                correlationChain: new CorrelationChain({
                    requestId: req.headers['x-request-id'],
                    sessionId: req.headers['x-session-id'],
                    correlationId: req.headers['x-correlation-id']
                })
            });
        }

        // Keep backwards compatibility temporarily (will be phased out)
        req.user = { sub: userId };
        req.store = { id: targetStoreId };

        next();
    } catch (err) {
        console.error('[AuthMiddleware] Error:', err);
        return res.status(500).json({ error: 'Internal server error during authorization' });
    }
};

module.exports = { requireAuth };
