jest.mock('../../kernel/repositories/SupabaseEntitlementRepository', () => {
    return jest.fn().mockImplementation(() => {
        return {};
    });
});

const { EntitlementFacade } = require('../../kernel/policy/EntitlementFacade');
const { LimitExceededError, PolicyDeniedError } = require('../../kernel/errors');
const { FakeEventBus } = require('../../kernel/testing/expandedFakes');

class FakeEntitlementRepository {
    constructor() {
        this.entitlements = new Map(); // tenantId -> limit
        this.usages = new Map(); // tenantId -> current_usage
    }
    
    async getFeatureDefinition(featureKey) {
        return { id: featureKey, hard_limit: 100 };
    }

    async calculateEntitlement(tenantId, featureId) {
        return { hard_limit: this.entitlements.get(tenantId) || 100 };
    }

    async getUsageSnapshot(tenantId, featureId) {
        return { current_usage: this.usages.get(tenantId) || 0 };
    }

    async consume(tenantId, featureId, amount, options) {
        const usage = this.usages.get(tenantId) || 0;
        const limit = this.entitlements.get(tenantId) || 100;
        
        if (usage + amount > limit) {
            return { allowed: false, remaining: limit - usage };
        }
        
        this.usages.set(tenantId, usage + amount);
        return { allowed: true, remaining: limit - (usage + amount) };
    }
}

describe('EntitlementFacade', () => {
    let facade;
    let eventBus;
    let repo;

    beforeEach(() => {
        repo = new FakeEntitlementRepository();
        eventBus = new FakeEventBus();
        facade = new EntitlementFacade(repo, eventBus);
    });

    describe('evaluate', () => {
        it('should return allowed if usage is within limits', async () => {
            const result = await facade.evaluate('a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11', 'catalog.items.max');
            expect(result.isAllowed).toBe(true);
            expect(result.currentUsage).toBe(0);
            expect(result.hardLimit).toBe(100);
        });

        it('should return denied if usage is at limit', async () => {
            repo.usages.set('a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11', 100);
            const result = await facade.evaluate('a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11', 'catalog.items.max');
            expect(result.isAllowed).toBe(false);
            expect(result.reason).toBe('LIMIT_REACHED');
        });
    });

    describe('authorize', () => {
        it('should throw LimitExceededError if requested amount exceeds limit', async () => {
            repo.usages.set('a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11', 99);
            await expect(facade.authorize('a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11', 'catalog.items.max', 2))
                .rejects.toThrow(LimitExceededError);
        });

        it('should return ALLOW decision if within limits', async () => {
            const result = await facade.authorize('a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11', 'catalog.items.max', 5);
            expect(result.decision).toBe('ALLOW');
        });
    });

    describe('consume', () => {
        it('should consume feature and publish event if successful', async () => {
            const result = await facade.consume('a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11', 'catalog.items.max', 5);
            expect(result.allowed).toBe(true);
            expect(eventBus.events).toHaveLength(1);
            expect(eventBus.events[0].type).toBe('FEATURE_CONSUMED');
            expect(eventBus.events[0].payload.amount).toBe(5);
        });

        it('should throw PolicyDeniedError if repository denies', async () => {
            repo.usages.set('a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11', 99);
            await expect(facade.consume('a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11', 'catalog.items.max', 2))
                .rejects.toThrow(PolicyDeniedError);
            expect(eventBus.events).toHaveLength(0); // Should not publish consumed event
        });
    });

    describe('refund', () => {
        it('should refund feature and publish refund event', async () => {
            repo.usages.set('a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11', 10);
            const result = await facade.refund('a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11', 'catalog.items.max', 5);
            expect(result.allowed).toBe(true);
            expect(repo.usages.get('a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11')).toBe(5);
            
            expect(eventBus.events).toHaveLength(1);
            expect(eventBus.events[0].type).toBe('FEATURE_REFUNDED');
            expect(eventBus.events[0].payload.amount).toBe(5);
        });
    });

    describe('getUsage', () => {
        it('should return correct usage stats', async () => {
            repo.usages.set('a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11', 20);
            const usage = await facade.getUsage('a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11', 'catalog.items.max');
            expect(usage.usage).toBe(20);
            expect(usage.limit).toBe(100);
            expect(usage.remaining).toBe(80);
        });
    });
});
