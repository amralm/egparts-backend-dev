const { v4: uuidv4 } = require('uuid');

class StoreBuilder {
    constructor() {
        this.store = {
            id: uuidv4(),
            name: 'Test Store',
            domain: 'test-store.egparts.store',
            created_at: new Date().toISOString()
        };
    }

    withId(id) {
        this.store.id = id;
        return this;
    }

    withName(name) {
        this.store.name = name;
        return this;
    }

    build() {
        return { ...this.store };
    }
}

class MembershipBuilder {
    constructor() {
        this.membership = {
            id: uuidv4(),
            store_id: null,
            identity_id: uuidv4(),
            role: 'owner',
            status: 'active'
        };
    }

    forStore(storeId) {
        this.membership.store_id = storeId;
        return this;
    }

    withRole(role) {
        this.membership.role = role;
        return this;
    }

    build() {
        if (!this.membership.store_id) throw new Error("Membership must have a store_id");
        return { ...this.membership };
    }
}

class FeatureBuilder {
    constructor() {
        this.feature = {
            id: uuidv4(),
            key: 'test.feature.max',
            feature_type: 'LIMIT',
            reset_period: 'LIFETIME'
        };
    }

    withKey(key) {
        this.feature.key = key;
        return this;
    }

    withType(type) {
        this.feature.feature_type = type;
        return this;
    }

    withResetPeriod(period) {
        this.feature.reset_period = period;
        return this;
    }

    build() {
        return { ...this.feature };
    }
}

class PlanBuilder {
    constructor() {
        this.plan = {
            id: uuidv4(),
            name: 'Pro Plan',
            entitlements: {} // featureKey -> limit
        };
    }

    withName(name) {
        this.plan.name = name;
        return this;
    }

    withEntitlement(featureKey, limit) {
        this.plan.entitlements[featureKey] = limit;
        return this;
    }

    build() {
        return { ...this.plan };
    }
}

module.exports = {
    StoreBuilder,
    MembershipBuilder,
    FeatureBuilder,
    PlanBuilder
};
