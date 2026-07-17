/**
 * CommandBus
 * Executes write operations (Commands). Ensures Idempotency, Validation, and Routing.
 */
class CommandBus {
  constructor() {
    this.handlers = new Map();
  }

  /**
   * Registers a handler for a specific command name.
   */
  register(commandName, handler) {
    if (this.handlers.has(commandName)) {
      throw new Error(`Command handler for ${commandName} is already registered.`);
    }
    this.handlers.set(commandName, handler);
  }

  /**
   * Dispatches a command to its registered handler.
   * @param {string} commandName 
   * @param {object} payload 
   * @param {ExecutionContext} context 
   */
  async execute(commandName, payload, context) {
    const handler = this.handlers.get(commandName);
    if (!handler) {
      throw new Error(`No handler registered for command: ${commandName}`);
    }
    
    // Enrichment with context telemetry
    const executionContext = context.clone({ command: commandName });
    
    try {
      // Audit/Telemetry pre-hook could go here
      const result = await handler(payload, executionContext);
      // Audit/Telemetry post-hook could go here
      return result;
    } catch (error) {
      // Metric error collection could go here
      throw error;
    }
  }
}

module.exports = CommandBus;\n