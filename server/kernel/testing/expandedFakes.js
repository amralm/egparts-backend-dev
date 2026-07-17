class FakeTransactionManager {
    constructor() {
        this.transactions = [];
        this.activeTransaction = null;
    }

    async begin() {
        this.activeTransaction = { id: Date.now(), status: 'active', operations: [] };
        this.transactions.push(this.activeTransaction);
        return this.activeTransaction;
    }

    forceFailure(error) {
        this.forcedError = error;
    }

    async executeTransaction(callback) {
        if (this.forcedError) {
            const err = this.forcedError;
            this.forcedError = null;
            throw err;
        }
        return await callback();
    }

    async commit(tx) {
        if (!tx || tx.status !== 'active') throw new Error("Invalid transaction");
        tx.status = 'committed';
    }

    async rollback(tx) {
        if (!tx || tx.status !== 'active') throw new Error("Invalid transaction");
        tx.status = 'rolled_back';
        // Mock undoing operations if necessary for complex tests
    }

    getCommittedTransactions() {
        return this.transactions.filter(t => t.status === 'committed');
    }

    getRolledBackTransactions() {
        return this.transactions.filter(t => t.status === 'rolled_back');
    }
}

class FakeConfigurationProvider {
    constructor(config = {}) {
        this.config = config;
    }

    get(key, defaultValue) {
        if (this.config.hasOwnProperty(key)) {
            return this.config[key];
        }
        if (defaultValue !== undefined) {
            return defaultValue;
        }
        throw new Error(`Configuration key ${key} not found and no default provided.`);
    }

    set(key, value) {
        this.config[key] = value;
    }
}

class FakeLogger {
    constructor() {
        this.logs = { info: [], warn: [], error: [], debug: [] };
    }

    info(message, meta = {}) { this.logs.info.push({ message, meta }); }
    warn(message, meta = {}) { this.logs.warn.push({ message, meta }); }
    error(message, meta = {}) { this.logs.error.push({ message, meta }); }
    debug(message, meta = {}) { this.logs.debug.push({ message, meta }); }

    getLogs(level) {
        return this.logs[level] || [];
    }
    
    clear() {
        this.logs = { info: [], warn: [], error: [], debug: [] };
    }
}

class FakeCache {
    constructor() {
        this.store = new Map();
    }

    async get(key) {
        const item = this.store.get(key);
        if (!item) return null;
        if (item.expiry && Date.now() > item.expiry) {
            this.store.delete(key);
            return null;
        }
        return item.value;
    }

    async set(key, value, ttlSeconds) {
        const expiry = ttlSeconds ? Date.now() + (ttlSeconds * 1000) : null;
        this.store.set(key, { value, expiry });
    }

    async delete(key) {
        this.store.delete(key);
    }

    async clear() {
        this.store.clear();
    }
}

class FakeLockProvider {
    constructor() {
        this.locks = new Set();
    }

    async acquire(lockKey, ttlMs = 5000) {
        if (this.locks.has(lockKey)) {
            return false; // Could not acquire
        }
        this.locks.add(lockKey);
        
        // In a real fake, we might auto-release based on FakeClock,
        // but for now we just hold it until released.
        return {
            release: async () => {
                this.locks.delete(lockKey);
            }
        };
    }

    isLocked(lockKey) {
        return this.locks.has(lockKey);
    }
}

class FakeEventBus {
    constructor() {
        this.events = [];
    }
    
    async publish(event) {
        this.events.push(event);
    }
    
    clear() {
        this.events = [];
    }
}

module.exports = {
    FakeTransactionManager,
    FakeConfigurationProvider,
    FakeLogger,
    FakeCache,
    FakeLockProvider,
    FakeEventBus
};
