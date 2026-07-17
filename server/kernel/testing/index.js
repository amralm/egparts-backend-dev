const { FakeClock } = require('./FakeClock');
const { FakeEventBus } = require('./FakeEventBus');
const { FakeEntitlementRepository } = require('./FakeEntitlementRepository');
const { 
    FakeTransactionManager,
    FakeConfigurationProvider,
    FakeLogger,
    FakeCache,
    FakeLockProvider 
} = require('./expandedFakes');

module.exports = {
    FakeClock,
    FakeEventBus,
    FakeEntitlementRepository,
    FakeTransactionManager,
    FakeConfigurationProvider,
    FakeLogger,
    FakeCache,
    FakeLockProvider
};
