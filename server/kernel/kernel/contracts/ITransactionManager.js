class ITransactionManager {
    async begin() { throw new Error('Not implemented'); }
    async commit(transaction) { throw new Error('Not implemented'); }
    async rollback(transaction) { throw new Error('Not implemented'); }
    
    /**
     * Helper to run a callback inside a transaction automatically
     */
    async runInTransaction(callback) { throw new Error('Not implemented'); }
}

module.exports = ITransactionManager;
