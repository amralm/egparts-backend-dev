const { GoogleGenAI } = require('@google/genai');
const { supabase } = require('./supabase');
const aiPlanner = require('./aiPlanner');
const guardrails = require('./safetyGuardrails');
const logger = require('../utils/logger');

let geminiClient = null;

function getGeminiClient() {
  if (!geminiClient) {
    geminiClient = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
  }
  return geminiClient;
}

function safeJsonParse(text) {
  try {
    return JSON.parse(text);
  } catch (err) {
    logger.error('Gemini returned invalid JSON:', err.message);
    return null;
  }
}

function fallbackResponse(plan, message) {
  const store = plan.facts.getStoreProfile || {};
  const sales = plan.facts.getSalesSummary || {};
  const inventory = plan.facts.getInventoryMetrics || { totals: {} };
  const usage = plan.facts.getStoreUsageSummary || { realtimeCounts: {} };

  return {
    answer: [
      `I reviewed ${store.name || 'your store'} using tenant-scoped backend tools only.`,
      `Last period orders: ${sales.ordersCount || 0}, revenue: ${sales.revenue || 0}, average order value: ${sales.avgOrderValue || 0}.`,
      `Inventory health: ${inventory.totals?.lowStockCount || 0} low-stock products, ${inventory.totals?.outOfStockCount || 0} out of stock, ${inventory.totals?.missingImagesCount || 0} missing images.`,
      `Current catalog count: ${usage.realtimeCounts?.products || 0} products.`
    ].join('\n'),
    recommendations: plan.deterministic.recommendations || [],
    alerts: plan.toolErrors.map((err) => ({ type: 'warning', message: `Tool ${err.tool} could not complete: ${err.message}` })),
    upgrade: plan.deterministic.upgrade || { recommended: false },
    actions: [],
    meta: {
      planner: plan.plannerMeta,
      source: 'deterministic_fallback',
      userMessage: message
    }
  };
}

function buildSystemInstruction(plan) {
  return `
# ROLE & MISSION
You are the EGParts Autonomous AI Agent — a secure digital employee and operations orchestrator for EGParts merchants.
Your mission is to perform real business operations on behalf of the merchant, optimize daily tasks, and proactively drive business growth.
You act within strictly enforced boundaries, respecting tenant isolation, subscription limits, and the exact role permissions of the authenticated user.

# CORE LAWS & TENANT ISOLATION
1. NEVER bypass multi-tenant isolation. Every operation must strictly use the backend-provided facts and tools.
2. NEVER assume platform super-admin privileges unless the current authenticated user holds that exact role.
3. NEVER expose raw database SQL, backend secrets, API keys, or cross-tenant data.
4. If you lack the required permissions, subscription quota, or feature limits, you MUST stop execution and inform the user clearly.

# EXECUTION PIPELINE
Every user request or autonomous trigger must strictly follow this pipeline before any action is executed:
1. User Intent Recognition
2. Planner & Capability Selection
3. Tool Chain Orchestration
4. Permission Validation (Does the user's role allow this?)
5. Subscription & Feature Limit Validation (Does the store's plan allow this?)
6. Business Rules Validation (Is this operation logical and safe?)
7. Risk Assessment (Determine Level 1-4)
8. Execution (or Approval Request for L3/L4)
9. Audit Logging
10. Merchant Feedback

# AUTONOMOUS EXECUTION LEVELS
Evaluate the risk of every tool chain and apply the corresponding execution rule:
- [LEVEL 1 - AUTOMATIC]: Zero risk. Execute immediately. (e.g., Read data, generate SEO, analyze sales, categorize products).
- [LEVEL 2 - SMART EXECUTION]: Reversible actions. Execute automatically. (e.g., Publish AI descriptions, update metadata, archive expired coupons, generate purchase drafts).
- [LEVEL 3 - APPROVAL REQUIRED]: High impact. Present the plan, explain the expected ROI/impact, and wait for explicit approval. (e.g., Create coupons, bulk updates). Return as drafted actions.
- [LEVEL 4 - NEVER AUTONOMOUS]: Destructive or critical. ONLY prepare a draft or instruct user. (e.g., Delete Store).

# MULTI-STEP PLANNING & CAPABILITIES
You solve complete business goals, not isolated tasks.
Chain capabilities to achieve goals. Return requested actions in the actions array.

# SELF-REFLECTION & ROLLBACK
Before pulling the trigger on ANY execution (Level 1, 2, or 3), perform a self-check:
- "Do I have enough information, or should I ask clarifying questions?"
- "Is there a safer way to execute this?"
- "Will this negatively impact active customers?"
- "Can this action be rolled back if the merchant dislikes it?"
If confidence is low, DO NOT GUESS. Ask the merchant.

Required JSON schema:
{
  "answer": "merchant-facing response explaining the plan, executed safe tools, and pending drafts.",
  "recommendations": [
    {
      "title": "short recommendation",
      "description": "specific business advice",
      "confidence": 0.85,
      "reason": "metric-backed reason",
      "businessImpact": "expected impact",
      "difficulty": "low|medium|high",
      "executionTime": "estimated time",
      "dataSources": ["toolName"]
    }
  ],
  "alerts": [
    { "type": "info|warning|error", "message": "metric-backed alert" }
  ],
  "upgrade": {
    "recommended": false,
    "reason": "",
    "urgency": "low|medium|high",
    "estimatedDays": 0,
    "pitchText": ""
  },
  "actions": [
    {
       "actionType": "create_coupon|update_settings|update_theme_colors|create_description|update_stock|update_order_status|delete_product|send_whatsapp_campaign|issue_refund|create_product|update_product_price|toggle_product_visibility|create_category|toggle_maintenance_mode|update_shipping_fee|ban_customer|update_store_seo",
       "payload": {}
    }
  ]
}

Backend facts:
${JSON.stringify({
    facts: plan.facts,
    deterministic: plan.deterministic,
    toolErrors: plan.toolErrors,
    plannerMeta: plan.plannerMeta,
    availableTools: plan.availableTools
  }, null, 2)}
`;
}

async function generateCopilotResponse(storeId, userId, message, currentRoute, history = [], requestContext = {}) {
  const plan = await aiPlanner.buildPlan({
    storeId,
    userId,
    message,
    currentRoute,
    context: requestContext
  });

  if (plan.blocked) {
    return {
      answer: plan.reason,
      recommendations: [],
      alerts: [{ type: 'error', message: plan.reason }],
      upgrade: { recommended: false },
      actions: []
    };
  }

  if (!process.env.GEMINI_API_KEY) {
    return fallbackResponse(plan, message);
  }

  try {
    const response = await getGeminiClient().models.generateContent({
      model: 'gemini-2.5-flash',
      contents: JSON.stringify({
        message,
        currentRoute,
        history: Array.isArray(history) ? history.slice(-8) : []
      }),
      config: {
        responseMimeType: 'application/json',
        systemInstruction: buildSystemInstruction(plan)
      }
    });

    const parsedResponse = safeJsonParse(response.text) || fallbackResponse(plan, message);

    if (!Array.isArray(parsedResponse.recommendations) || parsedResponse.recommendations.length === 0) {
      parsedResponse.recommendations = plan.deterministic.recommendations || [];
    }

    if (!parsedResponse.upgrade) {
      parsedResponse.upgrade = plan.deterministic.upgrade || { recommended: false };
    }

    if (parsedResponse.upgrade?.recommended && !plan.deterministic.upgrade?.recommended) {
      parsedResponse.upgrade = { recommended: false, reason: '', urgency: 'low', estimatedDays: 0, pitchText: '' };
    }

    parsedResponse.actions = Array.isArray(parsedResponse.actions)
      ? parsedResponse.actions.map((action) => guardrails.sanitizeActionDraft(action))
      : [];

    parsedResponse.meta = {
      ...(parsedResponse.meta || {}),
      planner: plan.plannerMeta,
      source: 'gemini_with_backend_tools'
    };

    try {
      await supabase.from('ai_logs').insert({
        store_id: storeId,
        user_id: userId,
        message,
        response_json: parsedResponse,
        prompt_version: guardrails.PROMPT_VERSION
      });
    } catch (err) {
      logger.error('Failed to log AI metrics:', err.message);
    }

    return parsedResponse;
  } catch (err) {
    logger.error('Error during generateCopilotResponse:', err.message);
    return fallbackResponse(plan, message);
  }
}

module.exports = {
  generateCopilotResponse
};
