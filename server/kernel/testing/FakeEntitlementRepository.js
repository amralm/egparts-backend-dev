const IEntitlementRepository = require('../contracts/IEntitlementRepository');

class FakeEntitlementRepository extends IEntitlementRepository {
    constructor() {
        super();
        this.records = new Map();
        this.definitions = new Map();
        this.consumedHistory = [];
    }

    async getFeatureDefinition(featureKey) {
        return this.definitions.get(featureKey) || null;
    }

    async calculateEntitlement(tenantId, featureId) {
        const key = `${tenantId}_${featureId}`;
        const record = this.records.get(key) || { limit: 0, usage: 0 };
        return { hard_limit: record.limit, soft_limit: record.limit };
    }

    async getUsageSnapshot(tenantId, featureId) {
        const key = `${tenantId}_${featureId}`;
        const record = this.records.get(key) || { limit: 0, usage: 0 };
        return { current_usage: record.usage };
    }

    async consume(tenantId, featureId, amount, options = {}) {
        const idempotencyKey = options && options.idempotencyKey;
        if (idempotencyKey) {
            const existing = this.consumedHistory.find(e => e.idempotencyKey === idempotencyKey);
            if (existing) return { ...existing.result };
        }

        const key = `${tenantId}_${featureId}`;
        let record = this.records.get(key) || { limit: 0, usage: 0 };

        if (amount < 0) {
            record.usage = Math.max(0, record.usage + amount);
            this.records.set(key, record);
            const result = {
                allowed: true,
                remaining: record.limit - record.usage,
                limit: record.limit,
                current: record.usage
            };
            if (idempotencyKey) this.consumedHistory.push({ idempotencyKey, result });
            return result;
        }

        if (record.usage + amount > record.limit) {
            const result = {
                allowed: false,
                remaining: record.limit - record.usage,
                limit: record.limit,
                current: record.usage
            };
            if (idempotencyKey) this.consumedHistory.push({ idempotencyKey, result });
            return result;
        }

        record.usage += amount;
        this.records.set(key, record);

        const result = {
            allowed: true,
            remaining: record.limit - record.usage,
            limit: record.limit,
            current: record.usage
        };
        if (idempotencyKey) this.consumedHistory.push({ idempotencyKey, result });
        return result;
    }

    seedData(tenantId, featureId, limit, usage = 0) {
        this.records.set(`${tenantId}_${featureId}`, { limit, usage });
    }

    seedDefinition(featureKey, def) {
        this.definitions.set(featureKey, def);
    }
}

module.exports = FakeEntitlementRepository;
