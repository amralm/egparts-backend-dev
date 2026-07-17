const IEventBus = require('../contracts/IEventBus');

class FakeEventBus extends IEventBus {
    constructor() {
        super();
        this.events = [];
    }

    async publish(event) {
        this.events.push(event);
    }

    subscribe(eventType, handler) {
        // Not needed for simple fakes yet
    }

    getPublishedEvents() {
        return this.events;
    }

    clear() {
        this.events = [];
    }
}

module.exports = FakeEventBus;
