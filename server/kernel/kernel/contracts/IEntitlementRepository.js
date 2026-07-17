/**
 * IEntitlementRepository Interface (Contract)
 * Decouples the Policy Engine from the underlying database or ORM (e.g., Supabase, Prisma, Mongoose).
 */
class IEntitlementRepository {
    /**
     * Finds a feature definition by its generic key (e.g. 'catalog.items.max').
     * @param {string} featureKey 
     * @returns {Promise<{id: string, feature_type: string, reset_period: string}>}
     */
    async getFeatureDefinition(featureKey) {
        throw new Error("Method not implemented.");
    }

    /**
     * Calculates the resolved entitlement (Hard Limit) for a tenant.
     * The DB/Repository handles logic of summing Plans, Addons, and Overrides.
     * @param {string} tenantId 
     * @param {string} featureId 
     * @returns {Promise<{hard_limit: number, soft_limit: number}>}
     */
    async calculateEntitlement(tenantId, featureId) {
        throw new Error("Method not implemented.");
    }

    /**
     * Retrieves the current usage snapshot for a tenant and feature.
     * @param {string} tenantId 
     * @param {string} featureId 
     * @returns {Promise<{current_usage: number}>}
     */
    async getUsageSnapshot(tenantId, featureId) {
        throw new Error("Method not implemented.");
    }

    /**
     * Consumes a specific amount of a feature atomically.
     * Must be idempotent and protected against race conditions.
     * @param {string} tenantId 
     * @param {string} featureId 
     * @param {number} amount 
     * @param {Object} options (eventType, source, actorId, idempotencyKey, correlationId, etc)
     * @returns {Promise<{allowed: boolean, remaining: number, limit: number, current: number}>}
     */
    async consume(tenantId, featureId, amount, options) {
        throw new Error("Method not implemented.");
    }
}

module.exports = IEntitlementRepository;
