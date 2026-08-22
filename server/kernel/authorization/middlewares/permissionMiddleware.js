const { PolicyDeniedError } = require('../../errors');
const { apiError } = require('../../../../utils/apiError');

/**
 * permissionMiddleware
 * Ensures the AuthorizationSnapshot contains the required Permission.
 * Accepts Route Metadata.
 */
const requirePermission = (routeMetadata) => {
    return (req, res, next) => {
        try {
            if (!req.context || !req.context.identity) {
                return apiError(res, 500, 'Authorization context is missing. Ensure authMiddleware is executed first.', 'AUTHORIZATION_CONTEXT_MISSING');
            }

            const { requiredPermission } = routeMetadata;
            
            if (!requiredPermission) {
                // If the route has no specific permission requirement, allow it but log a warning
                console.warn(`[PermissionMiddleware] Route ${req.path} has no requiredPermission defined.`);
                return next();
            }

            const hasAccess = req.context.hasPermission(requiredPermission);

            if (!hasAccess) {
                return apiError(res, 403, 'Forbidden', 'PERMISSION_DENIED', { requiredPermission });
            }

            // Optional: attach routeMetadata to context for audit trails down the line
            // Wait, req.context is frozen! So we just add it to req
            req.routeMetadata = routeMetadata;

            next();
        } catch (err) {
            console.error('[PermissionMiddleware] Error:', err);
            return apiError(res, 500, 'Internal server error during permission check', 'PERMISSION_CHECK_FAILED');
        }
    };
};

module.exports = { requirePermission };
