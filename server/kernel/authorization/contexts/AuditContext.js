class AuditContext {
    /**
     * @param {Object} params
     * @param {string} params.ipAddress - The client's IP address
     * @param {string} params.userAgent - The client's user agent
     * @param {string} params.actorId - The user performing the action
     * @param {string} [params.impersonatorId] - If the action is being performed via impersonation, the ID of the super admin
     */
    constructor({ ipAddress, userAgent, actorId, impersonatorId = null }) {
        this.ipAddress = ipAddress;
        this.userAgent = userAgent;
        this.actorId = actorId;
        this.impersonatorId = impersonatorId;
        this.timestamp = new Date().toISOString();
    }

    isImpersonated() {
        return !!this.impersonatorId;
    }
}

module.exports = AuditContext;
