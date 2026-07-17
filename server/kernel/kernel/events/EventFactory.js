const { EventTypes } = require('./EventTypes');
const { DomainEvent } = require('./DomainEvent');

class EventFactory {
    static createFeatureConsumed(storeId, payload, metadata = {}) {
        return new DomainEvent(EventTypes.FEATURE_CONSUMED, storeId, payload, metadata);
    }

    static createFeatureRefunded(storeId, payload, metadata = {}) {
        return new DomainEvent(EventTypes.FEATURE_REFUNDED, storeId, payload, metadata);
    }

    static createPolicyDenied(storeId, payload, metadata = {}) {
        return new DomainEvent(EventTypes.POLICY_DENIED, storeId, payload, metadata);
    }
}

module.exports = { EventFactory };
