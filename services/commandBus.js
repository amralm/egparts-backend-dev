const PolicyEngine = require('./policyEngine');
const eventBus = require('./eventBus'); // Assuming we will create an eventBus
const auditLogger = require('./auditLogger');

class CommandBus {
  /**
   * Execute a platform command safely through the Entitlements engine.
   * @param {string} commandName The name of the command
   * @param {object} payload Command data
   * @param {object} context Contains storeId, userId, ip, etc.
   * @param {function} executor The actual function to execute if allowed
   */
  static async execute(commandName, payload, context, executor) {
    const { storeId, capabilityCode, usageContext } = payload;
    
    // 1. Policy Evaluation
    if (capabilityCode) {
      const decision = await PolicyEngine.evaluate(storeId, capabilityCode, usageContext, commandName);
      
      if (!decision.isAllowed) {
        // Log to audit logger
        auditLogger.log('COMMAND_DENIED', { storeId, commandName, reason: decision.reason, userId: context.userId });
        throw new Error(`Action denied: ${decision.reason}`);
      }
    }

    // 2. Execution
    try {
      const result = await executor();

      // 3. Audit & Events
      auditLogger.log('COMMAND_EXECUTED', { storeId, commandName, userId: context.userId });
      
      if (eventBus) {
        eventBus.publish(`${commandName}.success`, { storeId, payload, result, context });
      }

      return result;
    } catch (err) {
      auditLogger.log('COMMAND_FAILED', { storeId, commandName, error: err.message, userId: context.userId });
      
      if (eventBus) {
        eventBus.publish(`${commandName}.failed`, { storeId, payload, error: err.message, context });
      }

      throw err;
    }
  }
}

module.exports = CommandBus;
