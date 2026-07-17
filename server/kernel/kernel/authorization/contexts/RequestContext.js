const CorrelationId = require('./CorrelationId');

class RequestContext {
    /**
     * @param {Object} params
     * @param {import('./TenantContext')} params.tenant - The tenant context
     * @param {import('./AuditContext')} params.audit - The audit context
     * @param {CorrelationId} [params.correlationId] - The correlation ID for tracing
     */
    constructor({ tenant, audit, correlationId }) {
        if (!tenant) throw new Error('RequestContext requires a tenant context');
        if (!audit) throw new Error('RequestContext requires an audit context');
        
        this.tenant = tenant;
        this.audit = audit;
        this.correlationId = correlationId || new CorrelationId();
        this.timestamp = Date.now();
    }
}

module.exports = RequestContext;
