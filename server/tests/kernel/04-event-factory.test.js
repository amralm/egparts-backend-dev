const { EventFactory, EventTypes, DomainEvent } = require('../../kernel/events');
const { v4: uuidv4 } = require('uuid');

describe('EventFactory Validation', () => {

    it('should create a valid DomainEvent with all standard fields', () => {
        const storeId = uuidv4();
        const payload = { feature: 'products.max', amount: 1 };
        const metadata = { source: 'API' };

        const event = EventFactory.createFeatureConsumed(storeId, payload, metadata);

        expect(event).toBeInstanceOf(DomainEvent);
        expect(event.type).toBe(EventTypes.FEATURE_CONSUMED);
        expect(event.storeId).toBe(storeId);
        expect(event.payload).toEqual(payload);
        expect(event.metadata).toEqual(metadata);
        
        expect(typeof event.id).toBe('string');
        expect(event.id.length).toBeGreaterThan(0);
        
        expect(typeof event.correlationId).toBe('string');
        expect(event.correlationId.length).toBeGreaterThan(0);
        
        expect(typeof event.timestamp).toBe('string'); // ISO date
        expect(new Date(event.timestamp).getTime()).not.toBeNaN();
    });

    it('should fail if storeId is missing or invalid', () => {
        expect(() => {
            EventFactory.createFeatureConsumed(null, { feature: 'x' });
        }).toThrow('Event must have a valid storeId');
    });

    it('should fail if payload is missing', () => {
        const storeId = uuidv4();
        expect(() => {
            EventFactory.createFeatureConsumed(storeId, null);
        }).toThrow('Event must have a payload object');
        
        expect(() => {
            EventFactory.createFeatureConsumed(storeId, undefined);
        }).toThrow('Event must have a payload object');
    });

    it('should assign a correlationId if not provided in metadata', () => {
        const storeId = uuidv4();
        const event = EventFactory.createFeatureConsumed(storeId, { a: 1 });
        expect(event.correlationId).toBeDefined();
    });

    it('should reuse correlationId if provided in metadata', () => {
        const storeId = uuidv4();
        const customCorrelation = 'custom-123';
        const event = EventFactory.createFeatureConsumed(storeId, { a: 1 }, { correlationId: customCorrelation });
        
        expect(event.correlationId).toBe(customCorrelation);
    });

    it('should capture requestId if provided in metadata', () => {
        const storeId = uuidv4();
        const reqId = 'req-999';
        const event = EventFactory.createFeatureConsumed(storeId, { a: 1 }, { requestId: reqId });
        
        expect(event.metadata.requestId).toBe(reqId);
    });

});
