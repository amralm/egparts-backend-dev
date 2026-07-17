const { StoreId, FeatureId, IdempotencyKey } = require('../../kernel/ids');
const { v4: uuidv4 } = require('uuid');

describe('ID Parsers Validation', () => {

    describe('StoreId', () => {
        it('should parse a valid UUID correctly', () => {
            const validUuid = uuidv4();
            expect(StoreId.parse(validUuid)).toBe(validUuid);
        });

        it('should throw on null', () => {
            expect(() => StoreId.parse(null)).toThrow('StoreId must be a valid UUID');
        });

        it('should throw on undefined', () => {
            expect(() => StoreId.parse(undefined)).toThrow('StoreId must be a valid UUID');
        });

        it('should throw on empty string', () => {
            expect(() => StoreId.parse("")).toThrow('StoreId must be a valid UUID');
        });

        it('should throw on number', () => {
            expect(() => StoreId.parse(123)).toThrow('StoreId must be a valid UUID');
        });

        it('should throw on Object', () => {
            expect(() => StoreId.parse({ id: uuidv4() })).toThrow('StoreId must be a valid UUID');
        });

        it('should throw on invalid UUID string', () => {
            expect(() => StoreId.parse('not-a-uuid')).toThrow('StoreId must be a valid UUID');
        });

        it('should throw on overly long string', () => {
            expect(() => StoreId.parse('a'.repeat(100))).toThrow('StoreId must be a valid UUID');
        });
    });

    describe('FeatureId', () => {
        it('should parse a valid string key correctly', () => {
            expect(FeatureId.parse('products.max')).toBe('products.max');
        });

        it('should throw on null', () => {
            expect(() => FeatureId.parse(null)).toThrow('FeatureId must be a non-empty string');
        });

        it('should throw on undefined', () => {
            expect(() => FeatureId.parse(undefined)).toThrow('FeatureId must be a non-empty string');
        });

        it('should throw on empty string', () => {
            expect(() => FeatureId.parse("")).toThrow('FeatureId must be a non-empty string');
        });

        it('should throw on number', () => {
            expect(() => FeatureId.parse(123)).toThrow('FeatureId must be a non-empty string');
        });

        it('should throw on Object', () => {
            expect(() => FeatureId.parse({ key: 'a' })).toThrow('FeatureId must be a non-empty string');
        });

        it('should throw on overly long string', () => {
            expect(() => FeatureId.parse('a'.repeat(300))).toThrow('FeatureId must not exceed 255 characters');
        });
    });

    describe('IdempotencyKey', () => {
        it('should parse a valid UUID correctly', () => {
            const validUuid = uuidv4();
            expect(IdempotencyKey.parse(validUuid)).toBe(validUuid);
        });

        it('should throw on null', () => {
            expect(() => IdempotencyKey.parse(null)).toThrow('IdempotencyKey must be a valid UUID');
        });

        it('should throw on undefined', () => {
            expect(() => IdempotencyKey.parse(undefined)).toThrow('IdempotencyKey must be a valid UUID');
        });

        it('should throw on empty string', () => {
            expect(() => IdempotencyKey.parse("")).toThrow('IdempotencyKey must be a valid UUID');
        });

        it('should throw on number', () => {
            expect(() => IdempotencyKey.parse(123)).toThrow('IdempotencyKey must be a valid UUID');
        });

        it('should throw on Object', () => {
            expect(() => IdempotencyKey.parse({ key: uuidv4() })).toThrow('IdempotencyKey must be a valid UUID');
        });

        it('should throw on invalid UUID string', () => {
            expect(() => IdempotencyKey.parse('not-a-uuid')).toThrow('IdempotencyKey must be a valid UUID');
        });
    });
});
