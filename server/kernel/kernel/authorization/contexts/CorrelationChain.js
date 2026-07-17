const crypto = require('crypto');

class CorrelationChain {
    constructor({ requestId, causationId, sessionId, correlationId }) {
        this.requestId = requestId || crypto.randomUUID();
        this.causationId = causationId || this.requestId;
        this.sessionId = sessionId || null;
        this.correlationId = correlationId || crypto.randomUUID();
        
        Object.freeze(this);
    }
}

module.exports = CorrelationChain;
