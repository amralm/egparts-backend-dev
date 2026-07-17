/**
 * ConsumptionStrategies
 * Pluggable strategies for how capabilities are consumed.
 */

class BaseStrategy {
  async execute(context, capability, usageDelta) {
    throw new Error('Not implemented');
  }
}

class ImmediateStrategy extends BaseStrategy {
  async execute(context, capability, usageDelta) {
    // Check limit -> consume immediately -> return success
    return { success: true, consumed: usageDelta, strategy: 'immediate' };
  }
}

class ReserveStrategy extends BaseStrategy {
  async execute(context, capability, usageDelta) {
    // Reserve quota for 2 phase commit (e.g. AI token reservation)
    return { success: true, reservationId: `res_${Date.now()}`, strategy: 'reserve' };
  }
  
  async commit(context, reservationId, finalUsage) {
    // Finalize the reserved quota
    return { success: true, consumed: finalUsage };
  }
  
  async rollback(context, reservationId) {
    // Free the reservation
    return { success: true };
  }
}

class DeferredStrategy extends BaseStrategy {
  async execute(context, capability, usageDelta) {
    // Log intent, process consumption async (e.g. webhook delivery count)
    return { success: true, strategy: 'deferred' };
  }
}

class MeteredStrategy extends BaseStrategy {
  async execute(context, capability, usageDelta) {
    // Log to metered billing ledger
    return { success: true, strategy: 'metered' };
  }
}

const strategies = {
  'immediate': new ImmediateStrategy(),
  'reserve': new ReserveStrategy(),
  'deferred': new DeferredStrategy(),
  'metered': new MeteredStrategy()
};

module.exports = strategies;\n