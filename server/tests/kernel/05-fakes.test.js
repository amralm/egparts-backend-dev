const { 
    FakeTransactionManager,
    FakeEventBus,
    FakeConfigurationProvider
} = require('../../kernel/testing/expandedFakes');

describe('Test Infrastructure Validation (Fakes)', () => {
    
    describe('FakeEventBus', () => {
        it('should record published events', async () => {
            const bus = new FakeEventBus();
            const event = { id: 'evt_1', type: 'TEST_EVENT' };
            await bus.publish(event);
            
            expect(bus.events).toHaveLength(1);
            expect(bus.events[0]).toEqual(event);
        });

        it('should allow clearing events', async () => {
            const bus = new FakeEventBus();
            await bus.publish({ type: 'TEST_EVENT' });
            expect(bus.events).toHaveLength(1);
            
            bus.clear();
            expect(bus.events).toHaveLength(0);
        });
    });

    describe('FakeTransactionManager', () => {
        it('should execute callback and return result', async () => {
            const tm = new FakeTransactionManager();
            const result = await tm.executeTransaction(async () => {
                return 'success';
            });
            expect(result).toBe('success');
        });

        it('should allow forcing failures for chaos testing', async () => {
            const tm = new FakeTransactionManager();
            tm.forceFailure(new Error('Chaos Error'));

            await expect(tm.executeTransaction(async () => {
                return 'success';
            })).rejects.toThrow('Chaos Error');
            
            // Should reset after firing
            const nextResult = await tm.executeTransaction(async () => {
                return 'recovered';
            });
            expect(nextResult).toBe('recovered');
        });
    });

    describe('FakeConfigurationProvider', () => {
        it('should return configured values', async () => {
            const config = new FakeConfigurationProvider({ 'key_1': 'value_1' });
            const val = await config.get('key_1');
            expect(val).toBe('value_1');
        });

        it('should return default if value not configured', async () => {
            const config = new FakeConfigurationProvider({});
            const val = await config.get('missing_key', 'fallback');
            expect(val).toBe('fallback');
        });
    });
});
