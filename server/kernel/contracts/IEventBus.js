class IEventBus {
    /**
     * Publish a domain event
     * @param {DomainEvent} event 
     */
    async publish(event) { throw new Error('Not implemented'); }

    /**
     * Subscribe to a specific event type
     * @param {string} eventType 
     * @param {Function} handler 
     */
    subscribe(eventType, handler) { throw new Error('Not implemented'); }
}

module.exports = IEventBus;
