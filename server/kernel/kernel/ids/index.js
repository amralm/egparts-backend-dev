const { validate: isUuid } = require('uuid');
const { ValidationError } = require('../errors');

/**
 * Validates and parses a UUID based ID.
 * Throws a ValidationError if the format is invalid.
 */
function createIdParser(idName) {
    return {
        parse: (value) => {
            if (!value) {
                throw new ValidationError(`${idName} must be a valid UUID`);
            }
            if (!isUuid(value)) {
                throw new ValidationError(`${idName} must be a valid UUID`);
            }
            return value;
        },
        validate: (value) => {
            return value && isUuid(value);
        },
        equals: (a, b) => {
            return a === b;
        }
    };
}

/**
 * Validates and parses a string based ID (e.g. FeatureId like 'catalog.items.max')
 */
function createStringIdParser(idName) {
    return {
        parse: (value) => {
            if (!value || typeof value !== 'string' || value.trim().length === 0) {
                throw new ValidationError(`${idName} must be a non-empty string`);
            }
            if (value.length > 255) {
                throw new ValidationError(`${idName} must not exceed 255 characters`);
            }
            return value.trim();
        },
        validate: (value) => {
            return typeof value === 'string' && value.trim().length > 0;
        },
        equals: (a, b) => {
            return a === b;
        }
    };
}

const StoreId = createIdParser('StoreId');
const MembershipId = createIdParser('MembershipId');
const IdentityId = createIdParser('IdentityId');
const PlanVersionId = createIdParser('PlanVersionId');
const RequestId = createIdParser('RequestId');
const CorrelationId = createIdParser('CorrelationId');
const IdempotencyKey = createIdParser('IdempotencyKey');

const FeatureId = createStringIdParser('FeatureId');

module.exports = {
    StoreId,
    MembershipId,
    IdentityId,
    PlanVersionId,
    RequestId,
    CorrelationId,
    IdempotencyKey,
    FeatureId
};
