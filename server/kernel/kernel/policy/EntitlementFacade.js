const { StoreId, FeatureId, IdempotencyKey } = require('../ids');
const { LimitExceededError, PolicyDeniedError } = require('../errors');
const { PolicyDecision, createEntitlementResult, createUsageResult } = require('../types');
const { EventFactory } = require('../events');
const SupabaseEntitlementRepository = require('../repositories/SupabaseEntitlementRepository');

/**
 * EntitlementFacade - Platform Policy Engine
 * Core interface for evaluating, checking, consuming, and refunding features.
 * Fully decoupled from specific modules (Products, Ecommerce, AI, etc.)
 */
class EntitlementFacade {
    constructor(repository, eventBus = null) {
        // DI pattern: allow injecting mock repositories for testing
        this.repository = repository || new SupabaseEntitlementRepository();
        this.eventBus = eventBus;
    }

    /**
     * Evaluate the current entitlement (Check Limit & Snapshot)
     */
    async evaluate(rawTenantId, rawFeatureKey) {
        const tenantId = StoreId.parse(rawTenantId);
        const featureKey = FeatureId.parse(rawFeatureKey);

        // 1. Resolve featureKey to definition
        const def = await this.repository.getFeatureDefinition(featureKey);

        // 2. Evaluate limit via Repository
        const entitlement = await this.repository.calculateEntitlement(tenantId, def ? def.id : featureKey);
        
        // 3. Fetch current usage
        const { current_usage } = await this.repository.getUsageSnapshot(tenantId, def ? def.id : featureKey);

        const hardLimit = entitlement.hard_limit || 0;
        const isAllowed = current_usage < hardLimit;

        return createEntitlementResult({
            isAllowed,
            featureId: featureKey,
            requestedAmount: 0,
            currentUsage: current_usage,
            hardLimit: hardLimit,
            reason: isAllowed ? 'WITHIN_LIMITS' : 'LIMIT_REACHED'
        });
    }

    /**
     * Check if an action is authorized based on amount
     */
    async authorize(rawTenantId, rawFeatureKey, amount = 1) {
        const evalResult = await this.evaluate(rawTenantId, rawFeatureKey);
        
        // Ensure type definitions exist and evaluate accordingly (omitted specific type branching here for generic approach)
        const isAllowed = (evalResult.currentUsage + amount) <= evalResult.hardLimit;
        
        if (!isAllowed) {
            throw new LimitExceededError(`Cannot consume ${amount} of ${rawFeatureKey}. Limit is ${evalResult.hardLimit}, usage is ${evalResult.currentUsage}.`);
        }

        return {
            decision: PolicyDecision.ALLOW,
            evalResult
        };
    }

    /**
     * Consume a feature (atomic, enforced)
     */
    async consume(rawTenantId, rawFeatureKey, amount, options = {}) {
        const tenantId = StoreId.parse(rawTenantId);
        const featureKey = FeatureId.parse(rawFeatureKey);
        const idempotencyKey = IdempotencyKey.parse(options.idempotencyKey || require('uuid').v4());
        
        const evalResult = await this.evaluate(tenantId, featureKey);

        const result = await this.repository.consume(tenantId, featureKey, amount, {
            ...options,
            idempotencyKey
        });

        if (!result.allowed) {
            throw new PolicyDeniedError(`Policy denied consumption of ${amount} for ${featureKey}`);
        }

        if (this.eventBus) {
            const event = EventFactory.createFeatureConsumed(tenantId, { feature: featureKey, amount, limit: evalResult.hardLimit }, options);
            await this.eventBus.publish(event);
        }

        return result;
    }

    /**
     * Refund usage
     */
    async refund(rawTenantId, rawFeatureKey, amount, options = {}) {
        const tenantId = StoreId.parse(rawTenantId);
        const featureKey = FeatureId.parse(rawFeatureKey);
        const idempotencyKey = IdempotencyKey.parse(options.idempotencyKey || require('uuid').v4());

        const result = await this.repository.consume(tenantId, featureKey, -Math.abs(amount), {
            ...options,
            eventType: 'refund',
            idempotencyKey
        });

        if (this.eventBus) {
            const event = EventFactory.createFeatureRefunded(tenantId, { feature: featureKey, amount }, options);
            await this.eventBus.publish(event);
        }

        return result;
    }

    /**
     * Get usage only
     */
    async getUsage(rawTenantId, rawFeatureKey) {
        const evalResult = await this.evaluate(rawTenantId, rawFeatureKey);
        return createUsageResult({
            featureId: evalResult.featureId,
            usage: evalResult.currentUsage,
            limit: evalResult.hardLimit,
            remaining: Math.max(0, evalResult.hardLimit - evalResult.currentUsage)
        });
    }
}

// Export a singleton instance by default, or the class for tests
module.exports = new EntitlementFacade();
module.exports.EntitlementFacade = EntitlementFacade;
