const registry = require('./toolRegistry');
const rulesEngine = require('./businessRulesEngine');
const guardrails = require('./safetyGuardrails');
const subscriptionLimitService = require('./subscriptionLimitService');
const logger = require('../utils/logger');

const DEFAULT_TOOLS = [
  'getStoreProfile',
  'getSubscriptionSnapshot',
  'getStoreUsageSummary',
  'getSalesSummary',
  'getInventoryMetrics'
];

function includesAny(text, words) {
  return words.some((word) => text.includes(word));
}

function selectTools(message, currentRoute, businessType) {
  const text = `${message || ''} ${currentRoute || ''}`.toLowerCase();
  const selected = new Set(DEFAULT_TOOLS);

  if (includesAny(text, ['product', 'products', 'catalog', 'inventory', 'stock', 'منتج', 'منتجات', 'مخزون'])) {
    selected.add('getProductsList');
  }

  if (includesAny(text, ['coupon', 'discount', 'promo', 'كوبون', 'خصم', 'عرض'])) {
    selected.add('getCouponsList');
  }

  if (includesAny(text, ['customer', 'customers', 'churn', 'عميل', 'عملاء'])) {
    selected.add('getCustomerInsights');
  }

  if (includesAny(text, ['payment', 'paymob', 'cash', 'wallet', 'دفع', 'باي موب', 'محفظة'])) {
    selected.add('getPaymentGatewayStatus');
  }

  if (businessType === 'automotive' || includesAny(text, ['compatibility', 'vehicle', 'car', 'سيارة', 'توافق'])) {
    selected.add('getAutomotiveCompatibility');
  }

  return Array.from(selected);
}

async function executeSelectedTools(storeId, toolNames, context) {
  const facts = {};
  const errors = [];

  for (const toolName of toolNames) {
    try {
      facts[toolName] = await registry.executeTool(toolName, storeId, {}, context);
    } catch (err) {
      logger.error(`AI planner tool failed: ${toolName}`, err.message);
      errors.push({ tool: toolName, message: err.message });
    }
  }

  return { facts, errors };
}

async function buildPlan({ storeId, userId, message, currentRoute, context = {} }) {
  const filterResult = guardrails.applyPolicyFilter(message);
  if (!filterResult.allowed) {
    return {
      blocked: true,
      reason: filterResult.reason,
      facts: {},
      toolErrors: [],
      availableTools: [],
      deterministic: {
        recommendations: [],
        upgrade: { recommended: false }
      }
    };
  }

  const bootstrap = await registry.executeTool('getStoreProfile', storeId, {}, { ...context, userId });
  const toolNames = selectTools(message, currentRoute, bootstrap.business_type || 'general');
  const { facts, errors } = await executeSelectedTools(storeId, toolNames, { ...context, userId });

  const usageSummary = facts.getStoreUsageSummary || { realtimeCounts: {}, featureUsage: [] };
  const salesSummary = facts.getSalesSummary || { ordersCount: 0, revenue: 0, avgOrderValue: 0 };
  const inventoryMetrics = facts.getInventoryMetrics || { totals: {} };
  const subscriptionSnapshot = facts.getSubscriptionSnapshot || {};
  const planCode = subscriptionSnapshot.planCode || 'starter';

  let couponLimit = { allowed: false };
  try {
    couponLimit = await subscriptionLimitService.checkFeatureLimit(storeId, 'coupons', 0);
  } catch (err) {
    errors.push({ tool: 'checkFeatureLimit:coupons', message: err.message });
  }

  const upgrade = rulesEngine.calculateUpgradeUrgency(
    usageSummary.realtimeCounts || {},
    usageSummary.featureUsage || [],
    planCode
  );

  const recommendations = rulesEngine
    .generateGrowthRecommendations(
      { last30Days: salesSummary },
      inventoryMetrics,
      usageSummary,
      bootstrap.business_type || 'general'
    )
    .map((rec) => {
      if (rec.action) rec.action = guardrails.sanitizeActionDraft(rec.action);
      return rec;
    });

  return {
    blocked: false,
    facts: {
      ...facts,
      couponLimit
    },
    toolErrors: errors,
    availableTools: registry.getAvailableTools(bootstrap.business_type || 'general'),
    deterministic: {
      recommendations,
      upgrade
    },
    plannerMeta: {
      selectedTools: toolNames,
      currentRoute: currentRoute || null,
      businessType: bootstrap.business_type || 'general'
    }
  };
}

module.exports = {
  buildPlan,
  selectTools
};
