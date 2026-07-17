/**
 * Base class for all Kernel errors.
 * Ensures consistent error formatting across the framework.
 */
class KernelError extends Error {
    /**
     * @param {string} code - Unique error code (e.g., 'LIMIT_EXCEEDED')
     * @param {string} message - Human readable error message
     * @param {Object} [details] - Additional contextual data
     * @param {string} [correlationId] - Tracing ID for logs
     * @param {boolean} [retryable] - Whether the operation can be retried safely
     */
    constructor(code, message, details = {}, correlationId = null, retryable = false) {
        super(message);
        this.name = this.constructor.name;
        this.code = code;
        this.details = details;
        this.correlationId = correlationId;
        this.retryable = retryable;
        Error.captureStackTrace(this, this.constructor);
    }

    toJSON() {
        return {
            name: this.name,
            code: this.code,
            message: this.message,
            details: this.details,
            correlationId: this.correlationId,
            retryable: this.retryable
        };
    }
}

module.exports = KernelError;
