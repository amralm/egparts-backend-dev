const { supabase } = require('./supabase');
const cacheProvider = require('./cacheProvider');
const { logAudit } = require('./auditLogger');
const logger = require('../utils/logger');

const RISK_LEVELS = Object.freeze({
  SAFE: 'SAFE',
  MEDIUM: 'MEDIUM',
  HIGH: 'HIGH',
  VERY_HIGH: 'VERY_HIGH'
});

const READ_ONLY_PERMISSION = 'ai.agent.read';

function requireStoreId(storeId) {
  if (!storeId) {
    throw new Error('A verified tenant store_id is required for every AI tool execution');
  }
}

function percent(used, limit) {
  if (!limit || Number(limit) <= 0) return 0;
  return Math.min(100, Math.round((Number(used || 0) / Number(limit)) * 100));
}

function normalizeManifest(manifest) {
  const normalized = {
    tenantScope: true,
    riskLevel: RISK_LEVELS.SAFE,
    approvalRequired: false,
    auditLogging: true,
    permissionRequired: READ_ONLY_PERMISSION,
    inputs: {},
    outputs: {},
    examples: [],
    supportedNiches: ['*'],
    cacheTtl: 120,
    ...manifest
  };

  const requiredFields = ['name', 'description', 'permissionRequired', 'riskLevel'];
  for (const field of requiredFields) {
    if (!normalized[field]) {
      throw new Error(`Invalid AI tool manifest. Missing ${field}`);
    }
  }

  if (!Object.values(RISK_LEVELS).includes(normalized.riskLevel)) {
    throw new Error(`Invalid risk level for AI tool ${normalized.name}`);
  }

  if (!Array.isArray(normalized.supportedNiches)) {
    throw new Error(`supportedNiches must be an array for AI tool ${normalized.name}`);
  }

  return normalized;
}

class ToolRegistry {
  constructor() {
    this.tools = new Map();
  }

  registerTool(manifest, executionFn) {
    if (typeof executionFn !== 'function') {
      throw new Error(`AI tool ${manifest?.name || 'unnamed'} requires an execution function`);
    }

    const normalized = normalizeManifest(manifest);
    this.tools.set(normalized.name, { manifest: normalized, execute: executionFn });
  }

  getTool(name) {
    return this.tools.get(name);
  }

  listTools({ niche, includeUnsafe = false } = {}) {
    const businessType = niche || 'general';
    return Array.from(this.tools.values())
      .map((tool) => tool.manifest)
      .filter((manifest) => {
        const nicheAllowed = manifest.supportedNiches.includes('*') || manifest.supportedNiches.includes(businessType);
        const riskAllowed = includeUnsafe || manifest.riskLevel === RISK_LEVELS.SAFE;
        return nicheAllowed && riskAllowed;
      });
  }

  getAvailableTools(niche) {
    // We now include unsafe (active) tools because the AI needs to know about them 
    // to prepare drafts (Level 2/3) even if it cannot execute them directly.
    return this.listTools({ niche, includeUnsafe: true });
  }

  async executeTool(name, storeId, args = {}, context = {}) {
    requireStoreId(storeId);

    const tool = this.tools.get(name);
    if (!tool) throw new Error(`Tool not found in registry: ${name}`);

    if (tool.manifest.riskLevel !== RISK_LEVELS.SAFE || tool.manifest.approvalRequired) {
      throw new Error(`Tool ${name} is not read-only and cannot be executed by the Phase 1 AI agent`);
    }

    const { data: store, error: storeError } = await supabase
      .from('stores')
      .select('id, business_type')
      .eq('id', storeId)
      .maybeSingle();

    if (storeError) throw storeError;
    if (!store) throw new Error('Tenant store was not found for AI tool execution');

    const niche = store.business_type || 'general';
    const nicheAllowed = tool.manifest.supportedNiches.includes('*') || tool.manifest.supportedNiches.includes(niche);
    if (!nicheAllowed) {
      throw new Error(`Tool ${name} is not available for store type: ${niche}`);
    }

    const cacheKey = `copilot_tool_cache:${storeId}:${name}:${JSON.stringify(args)}`;
    if (tool.manifest.cacheTtl) {
      const cached = await cacheProvider.get(cacheKey);
      if (cached !== undefined && cached !== null) return cached;
    }

    const start = Date.now();
    try {
      const result = await tool.execute(storeId, args, context);

      if (tool.manifest.cacheTtl && result !== undefined) {
        await cacheProvider.set(cacheKey, result, tool.manifest.cacheTtl);
      }

      if (tool.manifest.auditLogging) {
        logAudit({
          correlationId: context.correlationId || null,
          storeId,
          userId: context.userId || null,
          action: 'ai.tool.execute.success',
          entityType: 'ai_tool',
          entityId: name,
          newValues: {
            tool: name,
            riskLevel: tool.manifest.riskLevel,
            args: Object.keys(args || {})
          },
          ipAddress: context.ipAddress || null,
          userAgent: context.userAgent || null,
          durationMs: Date.now() - start
        }).catch((err) => logger.error('Failed to audit AI tool execution:', err.message));
      }

      return result;
    } catch (err) {
      logger.error(`Error executing Copilot tool ${name}:`, err.message);
      throw err;
    }
  }
}

const registry = new ToolRegistry();

registry.registerTool({
  name: 'getStoreProfile',
  description: 'Reads the tenant profile, status, subscription expiry, business type, and public domain identifiers.',
  inputs: { storeId: 'Verified tenant store id from backend context' },
  outputs: { profile: 'Tenant profile safe for AI reasoning' },
  cacheTtl: 300
}, async (storeId) => {
  const { data, error } = await supabase
    .from('stores')
    .select('id, name, subdomain, custom_domain, business_type, is_active, subscription_expires_at, created_at')
    .eq('id', storeId)
    .maybeSingle();

  if (error) throw error;
  if (!data) throw new Error('Store profile not found');
  return data;
});

registry.registerTool({
  name: 'getSubscriptionSnapshot',
  description: 'Reads the active subscription, plan, expiry state, and key feature usage percentages.',
  inputs: { storeId: 'Verified tenant store id from backend context' },
  outputs: { subscription: 'Current plan and usage summary' },
  cacheTtl: 180
}, async (storeId) => {
  const [{ data: subscription, error: subscriptionError }, { data: usage, error: usageError }] = await Promise.all([
    supabase
      .from('store_subscriptions')
      .select('id, status, current_period_start, current_period_end, trial_ends_at, plans(code, display_name, limits, features)')
      .eq('store_id', storeId)
      .eq('status', 'active')
      .maybeSingle(),
    supabase
      .from('feature_usage')
      .select('feature_key, usage, period_start, period_end, updated_at')
      .eq('store_id', storeId)
  ]);

  if (subscriptionError) throw subscriptionError;
  if (usageError) throw usageError;

  const limits = subscription?.plans?.limits || {};
  const usageRows = usage || [];
  const featureUsage = usageRows.map((row) => ({
    ...row,
    limit: limits[row.feature_key] ?? null,
    usagePct: percent(row.usage, limits[row.feature_key])
  }));

  return {
    planCode: subscription?.plans?.code || 'starter',
    planName: subscription?.plans?.display_name || 'Starter',
    status: subscription?.status || 'inactive',
    currentPeriodEnd: subscription?.current_period_end || null,
    trialEndsAt: subscription?.trial_ends_at || null,
    features: subscription?.plans?.features || {},
    featureUsage
  };
});

registry.registerTool({
  name: 'getStoreUsageSummary',
  description: 'Counts products, branches, coupons, staff, and feature usage for the tenant.',
  inputs: { storeId: 'Verified tenant store id from backend context' },
  outputs: { realtimeCounts: 'Tenant resource counts', featureUsage: 'Usage rows' },
  cacheTtl: 120
}, async (storeId) => {
  const [
    { data: usage, error },
    { count: productCount },
    { count: branchCount },
    { count: couponCount },
    { count: staffCount }
  ] = await Promise.all([
    supabase.from('feature_usage').select('*').eq('store_id', storeId),
    supabase.from('products').select('*', { count: 'exact', head: true }).eq('store_id', storeId).eq('is_deleted', false),
    supabase.from('branches').select('*', { count: 'exact', head: true }).eq('store_id', storeId),
    supabase.from('coupons').select('*', { count: 'exact', head: true }).eq('store_id', storeId),
    supabase.from('user_roles').select('*', { count: 'exact', head: true }).eq('store_id', storeId)
  ]);

  if (error) throw error;

  return {
    realtimeCounts: {
      products: productCount || 0,
      branches: branchCount || 0,
      coupons: couponCount || 0,
      staff: staffCount || 0
    },
    featureUsage: usage || []
  };
});

registry.registerTool({
  name: 'getSalesSummary',
  description: 'Computes tenant revenue, order count, delivered orders, and average order value for the last 30 days.',
  inputs: { days: 'Optional number of days, max 90' },
  outputs: { lastNDays: 'Sales metrics for the selected period' },
  cacheTtl: 300
}, async (storeId, args = {}) => {
  const days = Math.min(Math.max(Number(args.days || 30), 1), 90);
  const since = new Date();
  since.setDate(since.getDate() - days);

  const { data: orders, error } = await supabase
    .from('orders')
    .select('id, total, created_at, status, payment_status')
    .eq('store_id', storeId)
    .gt('created_at', since.toISOString());

  if (error) throw error;

  const rows = orders || [];
  const validOrders = rows.filter((o) => o.status !== 'cancelled');
  const deliveredOrders = rows.filter((o) => ['delivered', 'completed'].includes(String(o.status || '').toLowerCase()));
  const revenue = validOrders.reduce((sum, order) => sum + Number(order.total || 0), 0);

  return {
    periodDays: days,
    ordersCount: validOrders.length,
    deliveredOrdersCount: deliveredOrders.length,
    revenue,
    avgOrderValue: validOrders.length > 0 ? Number((revenue / validOrders.length).toFixed(2)) : 0,
    failedPaymentsCount: rows.filter((o) => String(o.payment_status || '').toLowerCase() === 'failed').length
  };
});

registry.registerTool({
  name: 'getInventoryMetrics',
  description: 'Identifies low stock, out-of-stock products, inactive products, and products missing catalog content.',
  inputs: { sampleSize: 'Optional sample size, max 20' },
  outputs: { totals: 'Inventory health counters', samples: 'Small tenant-scoped samples' },
  cacheTtl: 300
}, async (storeId, args = {}) => {
  const sampleSize = Math.min(Math.max(Number(args.sampleSize || 5), 1), 20);
  const [productsRes, settingsRes] = await Promise.all([
    supabase
      .from('products')
      .select('id, name, price, stock_quantity, low_stock_threshold, is_active, category, image, specs, description')
      .eq('store_id', storeId)
      .eq('is_deleted', false),
    supabase
      .from('site_settings')
      .select('low_stock_warning_enabled, low_stock_threshold')
      .eq('store_id', storeId)
      .maybeSingle()
  ]);

  if (productsRes.error) throw productsRes.error;

  const products = productsRes.data || [];
  const settings = settingsRes.data || {};
  const globalThreshold = settings.low_stock_threshold ?? 10;
  const warningsEnabled = settings.low_stock_warning_enabled !== false;
  const lowStock = warningsEnabled
    ? products.filter((p) => Number(p.stock_quantity || 0) > 0 && Number(p.stock_quantity || 0) <= Number(p.low_stock_threshold || globalThreshold))
    : [];
  const outOfStock = products.filter((p) => Number(p.stock_quantity || 0) === 0);
  const missingImages = products.filter((p) => !p.image);
  const missingDescriptions = products.filter((p) => !p.description && (!p.specs || !p.specs.description));

  return {
    totals: {
      activeProducts: products.filter((p) => p.is_active).length,
      inactiveProducts: products.filter((p) => !p.is_active).length,
      lowStockCount: lowStock.length,
      outOfStockCount: outOfStock.length,
      missingImagesCount: missingImages.length,
      missingDescriptionsCount: missingDescriptions.length
    },
    lowStockSamples: lowStock.slice(0, sampleSize).map((p) => ({ id: p.id, name: p.name, stock: p.stock_quantity })),
    outOfStockSamples: outOfStock.slice(0, sampleSize).map((p) => ({ id: p.id, name: p.name })),
    missingContentSamples: missingImages.concat(missingDescriptions).slice(0, sampleSize).map((p) => ({ id: p.id, name: p.name }))
  };
});

registry.registerTool({
  name: 'getProductsList',
  description: 'Reads a bounded product list for tenant-scoped product search and catalog advice.',
  inputs: { limit: 'Optional max products, max 100' },
  outputs: { products: 'Bounded product list' },
  cacheTtl: 120
}, async (storeId, args = {}) => {
  const limit = Math.min(Math.max(Number(args.limit || 50), 1), 100);
  const { data: products, error } = await supabase
    .from('products')
    .select('id, name, price, stock_quantity, category, is_active, brand, part_number, specs, compatibility')
    .eq('store_id', storeId)
    .eq('is_deleted', false)
    .order('created_at', { ascending: false })
    .limit(limit);

  if (error) throw error;
  return products || [];
});

registry.registerTool({
  name: 'getCouponsList',
  description: 'Reads coupons configured for the tenant without creating or changing them.',
  inputs: { limit: 'Optional max coupons, max 100' },
  outputs: { coupons: 'Bounded coupon list' },
  cacheTtl: 120
}, async (storeId, args = {}) => {
  const limit = Math.min(Math.max(Number(args.limit || 50), 1), 100);
  const { data: coupons, error } = await supabase
    .from('coupons')
    .select('id, code, discount_percentage, is_active, expiry_date')
    .eq('store_id', storeId)
    .order('created_at', { ascending: false })
    .limit(limit);

  if (error) throw error;
  return coupons || [];
});

registry.registerTool({
  name: 'getCustomerInsights',
  description: 'Reads safe customer counters and recent customer activity for churn and growth analysis.',
  inputs: { days: 'Optional lookback days, max 90' },
  outputs: { customers: 'Customer metrics and safe samples' },
  cacheTtl: 300
}, async (storeId, args = {}) => {
  const days = Math.min(Math.max(Number(args.days || 30), 1), 90);
  const since = new Date();
  since.setDate(since.getDate() - days);

  const [{ count: totalCustomers }, { count: newCustomers }, { data: recentCustomers, error }] = await Promise.all([
    supabase.from('customers').select('*', { count: 'exact', head: true }).eq('store_id', storeId),
    supabase.from('customers').select('*', { count: 'exact', head: true }).eq('store_id', storeId).gt('created_at', since.toISOString()),
    supabase.from('customers').select('id, name, created_at').eq('store_id', storeId).order('created_at', { ascending: false }).limit(10)
  ]);

  if (error) throw error;
  return {
    periodDays: days,
    totalCustomers: totalCustomers || 0,
    newCustomers: newCustomers || 0,
    recentCustomers: recentCustomers || []
  };
});

registry.registerTool({
  name: 'getPaymentGatewayStatus',
  description: 'Reads enabled tenant payment methods and Paymob configuration status without exposing secrets.',
  inputs: { storeId: 'Verified tenant store id from backend context' },
  outputs: { payments: 'Payment capability status without secret values' },
  cacheTtl: 300
}, async (storeId) => {
  const { data, error } = await supabase
    .from('payment_settings')
    .select('provider, enabled, payment_method, updated_at')
    .eq('store_id', storeId);

  if (error) throw error;

  return {
    enabledProviders: (data || []).filter((row) => row.enabled).map((row) => ({
      provider: row.provider,
      paymentMethod: row.payment_method,
      updatedAt: row.updated_at
    })),
    totalConfiguredMethods: (data || []).length
  };
});

registry.registerTool({
  name: 'getAutomotiveCompatibility',
  description: 'Reads automotive compatibility coverage for tenant products and global vehicle reference samples.',
  supportedNiches: ['automotive'],
  inputs: { storeId: 'Verified tenant store id from backend context' },
  outputs: { compatibility: 'Compatibility coverage counters and reference samples' },
  cacheTtl: 300
}, async (storeId) => {
  const { data: products, error: productsError } = await supabase
    .from('products')
    .select('id')
    .eq('store_id', storeId)
    .eq('is_deleted', false);

  if (productsError) throw productsError;

  const productIds = (products || []).map((p) => p.id);
  let compatibilityRecordsCount = 0;

  if (productIds.length > 0) {
    const { count, error } = await supabase
      .from('parts_compatibility')
      .select('*', { count: 'exact', head: true })
      .in('product_id', productIds);
    if (error) throw error;
    compatibilityRecordsCount = count || 0;
  }

  const [{ data: brands }, { data: models }] = await Promise.all([
    supabase.from('vehicle_brands').select('id, name').limit(10),
    supabase.from('vehicle_models').select('id, name, years_range').limit(20)
  ]);

  return {
    tenantProductsCount: productIds.length,
    compatibilityRecordsCount,
    availableBrands: brands || [],
    availableModels: models || []
  };
});

// ==========================================
// ACTIVE CAPABILITIES (LEVEL 2 & 3 ACTIONS)
// ==========================================

registry.registerTool({
  name: 'create_coupon',
  description: 'Creates a discount coupon for marketing campaigns or customer retention.',
  riskLevel: RISK_LEVELS.MEDIUM,
  approvalRequired: true,
  inputs: {
    code: 'String: Coupon code (e.g. SUMMER20)',
    discount_percentage: 'Number: Discount percentage between 1 and 100'
  },
  outputs: { status: 'drafted' }
}, async () => { return { status: 'drafted' }; });

registry.registerTool({
  name: 'create_description',
  description: 'Updates a product with an AI-generated description.',
  riskLevel: RISK_LEVELS.MEDIUM,
  approvalRequired: true,
  inputs: {
    productId: 'UUID: The product ID to update',
    description: 'String: The new SEO-optimized description'
  },
  outputs: { status: 'drafted' }
}, async () => { return { status: 'drafted' }; });

registry.registerTool({
  name: 'update_settings',
  description: 'Updates global store settings like store name, social links, and contact info.',
  riskLevel: RISK_LEVELS.MEDIUM,
  approvalRequired: true,
  inputs: {
    store_name: 'String: The store name',
    whatsapp_number: 'String: Contact number'
  },
  outputs: { status: 'drafted' }
}, async () => { return { status: 'drafted' }; });

registry.registerTool({
  name: 'update_theme_colors',
  description: 'Updates the website color theme (primary, secondary, background, surface, text).',
  riskLevel: RISK_LEVELS.MEDIUM,
  approvalRequired: true,
  inputs: {
    primary: 'String (Hex): Main primary brand color',
    primary_foreground: 'String (Hex): Text color on primary background',
    secondary: 'String (Hex): Secondary brand color',
    background: 'String (Hex): Dark mode background color',
    surface: 'String (Hex): Dark mode card surface color',
    text: 'String (Hex): Main text color for dark mode',
    light_background: 'String (Hex): Light mode background color',
    light_surface: 'String (Hex): Light mode card surface color',
    light_text: 'String (Hex): Main text color for light mode'
  },
  outputs: { status: 'drafted' }
}, async () => { return { status: 'drafted' }; });

registry.registerTool({
  name: 'update_stock',
  description: 'Adjusts inventory stock levels for a product.',
  riskLevel: RISK_LEVELS.HIGH,
  approvalRequired: true,
  inputs: {
    productId: 'UUID: The product ID to update',
    new_stock: 'Number: The exact new stock quantity'
  },
  outputs: { status: 'drafted' }
}, async () => { return { status: 'drafted' }; });

registry.registerTool({
  name: 'send_whatsapp_campaign',
  description: 'Sends a promotional WhatsApp message to a segment of customers.',
  riskLevel: RISK_LEVELS.HIGH,
  approvalRequired: true,
  inputs: {
    segment: 'String: active | inactive | all',
    message: 'String: The promotional text message',
    couponCode: 'String (Optional): Included coupon'
  },
  outputs: { status: 'drafted' }
}, async () => { return { status: 'drafted' }; });

registry.registerTool({
  name: 'update_order_status',
  description: 'Updates the fulfillment status of a specific order.',
  riskLevel: RISK_LEVELS.MEDIUM,
  approvalRequired: true,
  inputs: {
    orderId: 'UUID: The order ID',
    status: 'String: new | processing | shipped | delivered | cancelled'
  },
  outputs: { status: 'drafted' }
}, async () => { return { status: 'drafted' }; });

registry.registerTool({
  name: 'issue_refund',
  description: 'Initiates a payment refund for an order via the payment gateway.',
  riskLevel: RISK_LEVELS.VERY_HIGH,
  approvalRequired: true,
  inputs: {
    orderId: 'UUID: The order ID',
    amount: 'Number: Refund amount',
    reason: 'String: Reason for refund'
  },
  outputs: { status: 'drafted' }
}, async () => { return { status: 'drafted' }; });

registry.registerTool({
  name: 'delete_product',
  description: 'Permanently removes a product from the catalog.',
  riskLevel: RISK_LEVELS.HIGH,
  approvalRequired: true,
  inputs: {
    productId: 'UUID: The product ID to delete'
  },
  outputs: { status: 'drafted' }
}, async () => { return { status: 'drafted' }; });

registry.registerTool({
  name: 'create_product',
  description: 'Creates a new product draft in the store catalog.',
  riskLevel: RISK_LEVELS.VERY_HIGH,
  approvalRequired: true,
  inputs: {
    name: 'String: Product name',
    price: 'Number: Product price',
    stock: 'Number: Initial stock quantity',
    category_id: 'UUID (Optional): Category ID'
  },
  outputs: { status: 'drafted' }
}, async () => { return { status: 'drafted' }; });

registry.registerTool({
  name: 'update_product_price',
  description: 'Updates the price and compare_at_price of a specific product.',
  riskLevel: RISK_LEVELS.HIGH,
  approvalRequired: true,
  inputs: {
    productId: 'UUID: The product ID',
    price: 'Number: The new selling price',
    compare_at_price: 'Number (Optional): The original price before discount'
  },
  outputs: { status: 'drafted' }
}, async () => { return { status: 'drafted' }; });

registry.registerTool({
  name: 'toggle_product_visibility',
  description: 'Hides or shows a product on the storefront.',
  riskLevel: RISK_LEVELS.MEDIUM,
  approvalRequired: true,
  inputs: {
    productId: 'UUID: The product ID',
    is_active: 'Boolean: true to show, false to hide'
  },
  outputs: { status: 'drafted' }
}, async () => { return { status: 'drafted' }; });

registry.registerTool({
  name: 'create_category',
  description: 'Creates a new product category.',
  riskLevel: RISK_LEVELS.MEDIUM,
  approvalRequired: true,
  inputs: {
    name: 'String: Category name',
    slug: 'String: URL friendly slug (e.g. smart-phones)'
  },
  outputs: { status: 'drafted' }
}, async () => { return { status: 'drafted' }; });

registry.registerTool({
  name: 'toggle_maintenance_mode',
  description: 'Enables or disables maintenance mode for the entire store.',
  riskLevel: RISK_LEVELS.HIGH,
  approvalRequired: true,
  inputs: {
    enabled: 'Boolean: true to enable maintenance mode, false to disable'
  },
  outputs: { status: 'drafted' }
}, async () => { return { status: 'drafted' }; });

registry.registerTool({
  name: 'update_shipping_fee',
  description: 'Updates the default shipping fee for the store.',
  riskLevel: RISK_LEVELS.MEDIUM,
  approvalRequired: true,
  inputs: {
    fee: 'Number: The new flat shipping fee amount'
  },
  outputs: { status: 'drafted' }
}, async () => { return { status: 'drafted' }; });

registry.registerTool({
  name: 'ban_customer',
  description: 'Bans or unbans a customer from making purchases.',
  riskLevel: RISK_LEVELS.HIGH,
  approvalRequired: true,
  inputs: {
    customerId: 'UUID: The customer user ID',
    is_banned: 'Boolean: true to ban, false to unban',
    reason: 'String: Reason for banning'
  },
  outputs: { status: 'drafted' }
}, async () => { return { status: 'drafted' }; });

registry.registerTool({
  name: 'update_store_seo',
  description: 'Updates global SEO metadata for the store.',
  riskLevel: RISK_LEVELS.MEDIUM,
  approvalRequired: true,
  inputs: {
    seo_title: 'String: The SEO title',
    seo_description: 'String: The SEO meta description'
  },
  outputs: { status: 'drafted' }
}, async () => { return { status: 'drafted' }; });

module.exports = registry;
module.exports.RISK_LEVELS = RISK_LEVELS;
