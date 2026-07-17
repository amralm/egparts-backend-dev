const CorrelationChain = require('./CorrelationChain');

/**
 * AuthorizationSnapshot
 * An immutable representation of the authorization state at the moment the request was processed.
 * Prevents downstream middlewares from modifying context and guarantees predictability.
 */
class AuthorizationSnapshot {
    constructor({ identity, membership, store, permissions, planVersion, entitlementsVersion, audit, correlationChain }) {
        this.contextVersion = 1;
        
        this.identity = Object.freeze(identity);
        this.membership = Object.freeze(membership);
        this.store = Object.freeze(store);
        this.permissions = Object.freeze([...(permissions || [])]);
        this.plan_version = planVersion;
        this.entitlements_version = entitlementsVersion;
        this.audit = Object.freeze(audit);
        this.correlation = Object.freeze(correlationChain || new CorrelationChain({}));

        Object.freeze(this);
    }

    hasPermission(permission) {
        if (this.authorization?.role === 'super_admin' || this.authorization?.role === 'owner') return true;
        return this.permissions.includes(permission);
    }
}

module.exports = AuthorizationSnapshot;
