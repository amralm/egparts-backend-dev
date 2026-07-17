const KernelError = require('./KernelError');

class PolicyDeniedError extends KernelError {
    constructor(message, details = {}, correlationId = null) {
        super('ERR_POLICY_DENIED', message, details, correlationId, false);
    }
}

class LimitExceededError extends KernelError {
    constructor(message, details = {}, correlationId = null) {
        super('ERR_LIMIT_EXCEEDED', message, details, correlationId, false);
    }
}

class ConcurrencyError extends KernelError {
    constructor(message, details = {}, correlationId = null) {
        super('ERR_CONCURRENCY', message, details, correlationId, true);
    }
}

class ValidationError extends KernelError {
    constructor(message, details = {}, correlationId = null) {
        super('ERR_VALIDATION', message, details, correlationId, false);
    }
}

class MembershipNotFoundError extends KernelError {
    constructor(message, details = {}, correlationId = null) {
        super('MEMBERSHIP_NOT_FOUND', message, details, correlationId, false);
    }
}

class IdentityNotFoundError extends KernelError {
    constructor(message, details = {}, correlationId = null) {
        super('IDENTITY_NOT_FOUND', message, details, correlationId, false);
    }
}

class DuplicateCommandError extends KernelError {
    constructor(message, details = {}, correlationId = null) {
        super('DUPLICATE_COMMAND', message, details, correlationId, false);
    }
}

class PermissionDeniedError extends KernelError {
    constructor(message, details = {}, correlationId = null) {
        super('PERMISSION_DENIED', message, details, correlationId, false);
    }
}

module.exports = {
    KernelError,
    PolicyDeniedError,
    LimitExceededError,
    ConcurrencyError,
    ValidationError,
    MembershipNotFoundError,
    IdentityNotFoundError,
    DuplicateCommandError,
    PermissionDeniedError
};
