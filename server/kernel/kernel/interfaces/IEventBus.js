/**
 * IEventBus Interface
 * Represents the contract for publishing and subscribing to Domain Events.
 */
class IEventBus {
  /**
   * Publishes an event to the bus.
   * @param {string} eventName - The name of the event.
   * @param {object} payload - The event payload.
   * @param {object} context - ExecutionContext attached to this event.
   */
  async publish(eventName, payload, context) {
    throw new Error('Method not implemented.');
  }

  /**
   * Subscribes to an event.
   * @param {string} eventName - The name of the event.
   * @param {function} handler - The handler function (payload, context).
   */
  subscribe(eventName, handler) {
    throw new Error('Method not implemented.');
  }
}

module.exports = IEventBus;\n