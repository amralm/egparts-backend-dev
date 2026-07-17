const { 
    KernelError,
    PolicyDeniedError,
    LimitExceededError,
    ConcurrencyError,
    ValidationError
} = require('../../kernel/errors');

describe('Kernel Errors Hierarchy', () => {

    it('KernelError should assign basic properties correctly', () => {
        const err = new KernelError('TEST_CODE', 'Test message', { someDetail: 1 }, 'corr-123', true);
        
        expect(err).toBeInstanceOf(Error);
        expect(err.message).toBe('Test message');
        expect(err.code).toBe('TEST_CODE');
        expect(err.details).toEqual({ someDetail: 1 });
        expect(err.retryable).toBe(true);
        expect(typeof err.correlationId).toBe('string');
        expect(err.correlationId.length).toBeGreaterThan(0);
    });

    it('PolicyDeniedError should inherit KernelError and set properties', () => {
        const err = new PolicyDeniedError('Access denied', { feature: 'products.max' });
        
        expect(err).toBeInstanceOf(KernelError);
        expect(err.code).toBe('ERR_POLICY_DENIED');
        expect(err.message).toBe('Access denied');
        expect(err.details).toEqual({ feature: 'products.max' });
        expect(err.retryable).toBe(false);
        expect(err.correlationId).toBeDefined();
    });

    it('LimitExceededError should inherit KernelError and set properties', () => {
        const err = new LimitExceededError('Limit reached', { limit: 100 });
        
        expect(err).toBeInstanceOf(KernelError);
        expect(err.code).toBe('ERR_LIMIT_EXCEEDED');
        expect(err.message).toBe('Limit reached');
        expect(err.details).toEqual({ limit: 100 });
        expect(err.retryable).toBe(false);
        expect(err.correlationId).toBeDefined();
    });

    it('ConcurrencyError should inherit KernelError and be retryable', () => {
        const err = new ConcurrencyError('Lock failed', { resource: 'store_1' });
        
        expect(err).toBeInstanceOf(KernelError);
        expect(err.code).toBe('ERR_CONCURRENCY');
        expect(err.message).toBe('Lock failed');
        expect(err.details).toEqual({ resource: 'store_1' });
        expect(err.retryable).toBe(true); // Concurrency errors are retryable
        expect(err.correlationId).toBeDefined();
    });

    it('ValidationError should inherit KernelError and set properties', () => {
        const err = new ValidationError('Invalid ID', { field: 'store_id' });
        
        expect(err).toBeInstanceOf(KernelError);
        expect(err.code).toBe('ERR_VALIDATION');
        expect(err.message).toBe('Invalid ID');
        expect(err.details).toEqual({ field: 'store_id' });
        expect(err.retryable).toBe(false);
        expect(err.correlationId).toBeDefined();
    });
});
