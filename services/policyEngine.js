const { supabase } = require('./supabase');
const {
  checkFeatureLimit,
  getFeatureStates,
  DEFAULT_FEATURE_KEYS
} = require('./subscriptionLimitService');

// Canonical entitlement boundary. Historical capabilities/plan_versions are
// intentionally not queried here: there must be one source of truth for plan
// decisions and no missing-plan fallback may become unlimited.
function canonicalFeatureKey(capabilityCode) {
  const key = String(capabilityCode || '').toLowerCase().trim();
  const aliases = {
    'orders.create': 'orders_per_month',
    'orders.update': 'orders_per_month',
    'whatsapp.send': 'whatsapp_messages_month',
    'whatsapp.messages': 'whatsapp_messages_month',
    'whatsapp.accounts': 'whatsapp_accounts_max',
    'domains.custom': 'custom_domains'
  };
  return aliases[key] || (key.includes('.') ? key.split('.')[0] : key);
}

class PolicyEngine {
  static async evaluate(storeId, capabilityCode, context = {}, source = 'API') {
    const startTime = Date.now();
    try {
      const featureKey = canonicalFeatureKey(capabilityCode);
      const state = await checkFeatureLimit(storeId, featureKey, 0);
      const requested = Math.max(0, Number(context.requestedAmount || 0));
      const withinLimit = state.is_unlimited === true
        || (state.limit !== null && state.limit !== undefined && Number(state.usage || 0) + requested <= Number(state.limit));
      const isAllowed = state.allowed === true && withinLimit;
      return this._logDecision({
        storeId,
        capabilityCode,
        isAllowed,
        reason: isAllowed ? 'Allowed by canonical feature limit' : (state.reason || 'Feature limit denied'),
        decisionSource: 'Canonical feature limits',
        source,
        latencyMs: Date.now() - startTime,
        usage: { ...context, feature_key: featureKey, usage: state.usage, limit: state.limit },
        appliedLimit: state.limit
      });
    } catch (err) {
      console.error(`[PolicyEngine] Error evaluating ${capabilityCode}:`, err.message);
      return this._logDecision({
        storeId,
        capabilityCode,
        isAllowed: false,
        reason: 'Entitlement service unavailable',
        decisionSource: 'Error',
        source,
        latencyMs: Date.now() - startTime
      });
    }
  }

  static async getStoreLimits(storeId) {
    try {
      const state = await getFeatureStates(storeId, DEFAULT_FEATURE_KEYS);
      return Object.fromEntries(Object.entries(state.features || {}).map(([key, feature]) => [key, {
        max_value: feature.limit,
        is_unlimited: feature.is_unlimited === true,
        limit_type: feature.limit_type,
        limit_config: { max_value: feature.limit, period_type: feature.period_type },
        usage: feature.usage
      }]));
    } catch (err) {
      console.error('[PolicyEngine] Error fetching canonical store limits:', err.message);
      return {};
    }
  }

  static async _logDecision(decisionParams) {
    const { storeId, capabilityCode, isAllowed, reason, decisionSource, source, latencyMs, usage, appliedLimit } = decisionParams;
    supabase.from('entitlement_decisions').insert({
      store_id: storeId,
      capability_code: capabilityCode,
      is_allowed: isAllowed,
      reason,
      usage,
      applied_limit: appliedLimit,
      decision_source: decisionSource,
      source,
      latency_ms: latencyMs
    }).then(({ error }) => {
      if (error) console.error('[PolicyEngine] Failed to log entitlement decision:', error.message);
    }).catch((error) => console.error('[PolicyEngine] Failed to log entitlement decision:', error.message));
    return { isAllowed, reason, decisionSource, latencyMs };
  }
}

module.exports = PolicyEngine;
