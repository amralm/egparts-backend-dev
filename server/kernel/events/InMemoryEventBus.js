const IEventBus = require('../interfaces/IEventBus');
const EventEmitter = require('events');

/**
 * InMemoryEventBus
 * Implementation of IEventBus using Node's EventEmitter.
 * Supports Inbox/Outbox stubs for Idempotency and reliable delivery guarantees.
 */
class InMemoryEventBus extends IEventBus {
  constructor() {
    super();
    this.emitter = new EventEmitter();
    this.outbox = []; // Stub for Outbox pattern
    this.inbox = new Set(); // Stub for Inbox pattern (Idempotency)
  }

  async publish(eventName, payload, context) {
    const eventId = context?.requestId || Date.now().toString();
    const version = payload.version || 1;
    
    const eventObj = {
      eventId,
      eventName,
      version,
      payload,
      context,
      timestamp: new Date().toISOString()
    };
    
    // Outbox logic: Normally save to DB in the same transaction, then emit later.
    // Here we just queue and emit immediately.
    this.outbox.push(eventObj);
    
    // Asynchronous emission to decouple domains
    setImmediate(() => {
      this.emitter.emit(eventName, eventObj);
    });
  }

  subscribe(eventName, handler) {
    this.emitter.on(eventName, async (eventObj) => {
      const { eventId, payload, context } = eventObj;
      
      // Inbox pattern: Prevent duplicate processing of the same event
      if (this.inbox.has(eventId)) {
        return; // Already processed
      }
      
      try {
        await handler(payload, context);
        this.inbox.add(eventId); // Mark as successfully processed
      } catch (error) {
        // Dead letter queue logic would go here in production
        console.error(`Error handling event ${eventName}:`, error);
      }
    });
  }
}

module.exports = InMemoryEventBus;\n