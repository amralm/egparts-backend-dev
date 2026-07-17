const { v4: uuidv4 } = require('uuid');
const { ValidationError } = require('../errors');

class DomainEvent {
    constructor(type, storeId, payload, metadata = {}) {
        if (!storeId) throw new ValidationError('Event must have a valid storeId');
        if (!payload || typeof payload !== 'object') throw new ValidationError('Event must have a payload object');
        if (!type) throw new ValidationError('Event must have a valid type');

        this.id = uuidv4();
        this.type = type;
        this.storeId = storeId;
        this.payload = payload;
        this.metadata = metadata;
        this.timestamp = new Date().toISOString();
        this.correlationId = metadata.correlationId || uuidv4();
    }
}

module.exports = { DomainEvent };
