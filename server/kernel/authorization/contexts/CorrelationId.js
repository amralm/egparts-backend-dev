const crypto = require('crypto');

class CorrelationId {
    constructor(id) {
        this.id = id || crypto.randomUUID();
    }

    toString() {
        return this.id;
    }
}

module.exports = CorrelationId;
