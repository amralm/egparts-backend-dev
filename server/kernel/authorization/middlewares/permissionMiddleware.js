const { PolicyDeniedError } = require('../../errors');

/**
 * permissionMiddleware
 * Ensures the AuthorizationSnapshot contains the required Permission.
 * Accepts Route Metadata.
 */
const requirePermission = (routeMetadata) => {
    return (req, res, next) => {
        try {
            if (!req.context || !req.context.identity) {
                return res.status(500).json({ error: 'Authorization context is missing. Ensure authMiddleware is executed first.' });
            }

            const { requiredPermission } = routeMetadata;
            
            if (!requiredPermission) {
                // If the route has no specific permission requirement, allow it but log a warning
                console.warn(`[PermissionMiddleware] Route ${req.path} has no requiredPermission defined.`);
                return next();
            }

            const hasAccess = req.context.hasPermission(requiredPermission);

            if (!hasAccess) {
                return res.status(403).json({ 
                    error: 'Forbidden', 
                    details: `You do not have the required permission: ${requiredPermission}` 
                });
            }

            // Optional: attach routeMetadata to context for audit trails down the line
            // Wait, req.context is frozen! So we just add it to req
            req.routeMetadata = routeMetadata;

            next();
        } catch (err) {
            console.error('[PermissionMiddleware] Error:', err);
            return res.status(500).json({ error: 'Internal server error during permission check' });
        }
    };
};

module.exports = { requirePermission };
