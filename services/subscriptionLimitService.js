const { supabase } = require('./supabase');
const logger = require('../utils/logger');
const cacheProvider = require('./cacheProvider');

const DEFAULT_FEATURE_KEYS = [
  'products', 'categories', 'brands', 'product_images', 'product_variants', 'attributes',
  'branches', 'warehouses', 'shelves', 'employees', 'roles', 'customers', 'suppliers',
  'orders_per_month', 'active_orders', 'coupons', 'discount_campaigns', 'return_requests',
  'storage_bytes', 'uploaded_images', 'uploaded_files', 'banner_images', 'logos',
  'whatsapp_messages_month', 'otp_messages_month', 'email_messages_month', 'push_notifications_month',
  'custom_domains', 'api_keys', 'webhooks', 'integrations', 'payment_gateways',
  'ai_requests_month', 'forecast_jobs', 'report_generation', 'analytics_exports',
  'api_requests_day', 'export_formats', 'copilot_messages_day'
];

function normalizeFeatureKey(featureKey) {
  return String(featureKey || '').trim().toLowerCase();
}

function inferPeriodType(featureKey) {
  const key = normalizeFeatureKey(featureKey);
  if (['api_requests_day', 'copilot_messages_day'].includes(key)) {
    return 'daily';
  }
  if ([
    'whatsapp_messages_month', 'otp_messages_month', 'email_messages_month', 'push_notifications_month',
    'ai_requests_month', 'analytics_exports', 'report_generation', 'forecast_jobs'
  ].includes(key)) {
    return 'monthly';
  }
  if ([
    'storage_bytes', 'uploaded_images', 'uploaded_files', 'banner_images', 'logos'
  ].includes(key)) {
    return 'lifetime';
  }
  return 'lifetime';
}

async function getActiveStoreSubscription(storeId) {
  if (!storeId) return null;

  const { data, error } = await supabase
    .from('store_subscriptions')
    .select('id, plan_id, status, expires_at, created_at, plans(code, display_name)')
    .eq('store_id', storeId)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error) {
    logger.warn('Unable to load store subscription:', error.message);
    return null;
  }

  return data;
}

async function checkFeatureLimit(storeId, featureKey, requestedIncrement = 0) {
  const normalizedKey = normalizeFeatureKey(featureKey);
  if (!storeId || !normalizedKey) {
    return {
      allowed: false,
      remaining: 0,
      limit: 0,
      usage: 0,
      reason: 'Store context or feature key is missing',
      feature_key: normalizedKey,
      limit_type: null,
      period_type: inferPeriodType(normalizedKey),
      is_unlimited: false,
      plan: null
    };
  }

  const cacheKey = `feature_limit:${storeId}:${normalizedKey}`;
  const isReadOnly = (Number(requestedIncrement) === 0);

  if (isReadOnly) {
    const cached = await cacheProvider.get(cacheKey);
    if (cached) return cached;
  }

  const { data, error } = await supabase.rpc('check_feature_limit', {
    p_store_id: storeId,
    p_feature_key: normalizedKey,
    p_requested_increment: Number(requestedIncrement || 0)
  });

  if (error) {
    logger.warn(`Subscription limit check failed for ${normalizedKey}:`, error.message);
    return {
      allowed: false,
      remaining: 0,
      limit: 0,
      usage: 0,
      reason: 'Subscription limit service is unavailable',
      feature_key: normalizedKey,
      limit_type: null,
      period_type: inferPeriodType(normalizedKey),
      is_unlimited: false,
      plan: null
    };
  }

  const entry = Array.isArray(data) ? data[0] : data;
  const plan = await getActiveStoreSubscription(storeId);

  let result = {
    allowed: entry?.allowed !== false,
    remaining: entry?.remaining ?? null,
    limit: entry?.limit_value ?? null,
    usage: entry?.usage ?? 0,
    reason: entry?.reason || null,
    feature_key: entry?.feature_key || entry?.out_feature_key || normalizedKey,
    limit_type: entry?.limit_type || null,
    period_type: entry?.period_type || inferPeriodType(normalizedKey),
    is_unlimited: entry?.is_unlimited === true || entry?.limit_value == null,
    plan: plan ? { id: plan.plan_id, name: plan.plans?.display_name || plan.plans?.code || 'Current Plan' } : null
  };

  // Enforce correct reset for copilot_messages_day due to legacy DB lifetime accumulation
  if (normalizedKey === 'copilot_messages_day' && !isReadOnly && requestedIncrement > 0) {
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const todayISO = today.toISOString();
    
    // Check if the DB is tracking it under a previous day's period_start or lifetime
    const { data: usageEntry } = await supabase
      .from('feature_usage')
      .select('id, usage_count, period_start')
      .eq('store_id', storeId)
      .eq('feature_key', normalizedKey)
      .order('updated_at', { ascending: false })
      .limit(1)
      .maybeSingle();

    if (usageEntry) {
       const entryStart = new Date(usageEntry.period_start);
       entryStart.setHours(0, 0, 0, 0);
       
       // If the latest tracked usage is from a previous day (or epoch), reset it!
       if (entryStart.getTime() !== today.getTime()) {
           await supabase
             .from('feature_usage')
             .update({ usage_count: requestedIncrement, period: 'daily', period_start: todayISO, updated_at: new Date().toISOString() })
             .eq('id', usageEntry.id);
             
           // Re-fetch the limit so it reflects the reset usage
           const { data: freshEntry } = await supabase.rpc('check_feature_limit', {
             p_store_id: storeId,
             p_feature_key: normalizedKey,
             p_requested_increment: 0
           });
           const parsed = Array.isArray(freshEntry) ? freshEntry[0] : freshEntry;
           result.allowed = parsed?.allowed !== false;
           result.remaining = parsed?.remaining ?? null;
           result.usage = parsed?.usage ?? 0;
       }
    }
  }

  if (isReadOnly) {
    await cacheProvider.set(cacheKey, result, 60);
  } else {
    await cacheProvider.del(cacheKey);
  }

  return result;
}

// Reservation Pattern API
async function reserveFeatureUsage(storeId, featureKey, amount = 1, idempotencyKey, ttlMinutes = 5) {
  const normalizedKey = normalizeFeatureKey(featureKey);
  if (!storeId || !normalizedKey || !idempotencyKey) return false;

  const { data, error } = await supabase.rpc('reserve_feature_usage', {
    p_store_id: storeId,
    p_feature_key: normalizedKey,
    p_amount: Number(amount),
    p_idempotency_key: idempotencyKey,
    p_ttl_minutes: Number(ttlMinutes)
  });

  if (error) {
    logger.warn(`Failed to reserve feature usage for ${normalizedKey}:`, error.message);
    return false;
  }

  if (data) {
    await cacheProvider.del(`feature_limit:${storeId}:${normalizedKey}`);
  }

  return !!data;
}

async function commitFeatureUsage(idempotencyKey) {
  if (!idempotencyKey) return false;
  const { data, error } = await supabase.rpc('commit_feature_usage', {
    p_idempotency_key: idempotencyKey
  });

  if (error) {
    logger.warn(`Failed to commit feature usage for key ${idempotencyKey}:`, error.message);
    return false;
  }
  return !!data;
}

async function rollbackFeatureUsage(idempotencyKey) {
  if (!idempotencyKey) return false;
  const { data, error } = await supabase.rpc('rollback_feature_usage', {
    p_idempotency_key: idempotencyKey
  });

  if (error) {
    logger.warn(`Failed to rollback feature usage for key ${idempotencyKey}:`, error.message);
    return false;
  }
  return !!data;
}

async function getFeatureStates(storeId, featureKeys = DEFAULT_FEATURE_KEYS) {
  const requestedKeys = (featureKeys || DEFAULT_FEATURE_KEYS).map(normalizeFeatureKey).filter(Boolean);
  
  const cacheKey = `feature_states:${storeId}:${requestedKeys.join(',')}`;
  const cached = await cacheProvider.get(cacheKey);
  if (cached) return cached;

  const states = await Promise.all(requestedKeys.map((key) => checkFeatureLimit(storeId, key, 0)));
  const plan = await getActiveStoreSubscription(storeId);

  const result = {
    store_id: storeId,
    plan: plan ? { id: plan.plan_id, name: plan.plans?.display_name || plan.plans?.code || 'Current Plan' } : null,
    features: Object.fromEntries(requestedKeys.map((key, index) => [key, states[index]]))
  };

  await cacheProvider.set(cacheKey, result, 60);
  return result;
}

async function getUsageSummary(storeId) {
  if (!storeId) return { store_id: null, totals: [] };

  const { data, error } = await supabase
    .from('feature_usage')
    .select('*')
    .eq('store_id', storeId)
    .order('updated_at', { ascending: false });

  if (error) {
    logger.warn('Unable to load feature usage summary:', error.message);
    return { store_id: storeId, totals: [] };
  }

  return { store_id: storeId, totals: data || [] };
}

async function canCreateProduct(storeId, requestedIncrement = 0) {
  return checkFeatureLimit(storeId, 'products', requestedIncrement);
}

async function canUploadImage(storeId, requestedIncrement = 0) {
  return checkFeatureLimit(storeId, 'uploaded_images', requestedIncrement);
}

async function canUploadFile(storeId, requestedIncrement = 0) {
  return checkFeatureLimit(storeId, 'uploaded_files', requestedIncrement);
}

async function canSendOTP(storeId, requestedIncrement = 0) {
  return checkFeatureLimit(storeId, 'otp_messages_month', requestedIncrement);
}

async function canCreateBranch(storeId, requestedIncrement = 0) {
  return checkFeatureLimit(storeId, 'branches', requestedIncrement);
}

async function canCreateEmployee(storeId, requestedIncrement = 0) {
  return checkFeatureLimit(storeId, 'employees', requestedIncrement);
}

async function resetMonthlyUsage(now = new Date()) {
  const monthStart = new Date(now);
  monthStart.setDate(1);
  monthStart.setHours(0, 0, 0, 0);
  const { error } = await supabase
    .from('feature_usage')
    .delete()
    .eq('period', 'monthly')
    .lt('period_start', monthStart.toISOString());

  if (error) {
    logger.warn('Monthly usage reset failed:', error.message);
    return false;
  }

  return true;
}

// Ensure cache invalidation when subscriptions change
async function clearStoreCache(storeId) {
  // To keep it simple, we could flush all or specific keys. In distributed env, tag based flush is better.
  // For now, we clear the states cache.
  await cacheProvider.del(`feature_states:${storeId}:${DEFAULT_FEATURE_KEYS.join(',')}`);
}

async function decrementFeatureUsage(storeId, featureKey, amount = 1) {
  const normalizedKey = normalizeFeatureKey(featureKey);
  const period = inferPeriodType(normalizedKey);
  let periodStart;
  const now = new Date();
  if (period === 'monthly') {
    periodStart = new Date(now.getFullYear(), now.getMonth(), 1).toISOString();
  } else if (period === 'daily') {
    periodStart = new Date(now.getFullYear(), now.getMonth(), now.getDate()).toISOString();
  } else {
    periodStart = new Date(0).toISOString();
  }

  // Fetch current usage (ignoring period strictly, sorting by newest to get whichever record was tracked)
  const { data: entry } = await supabase
    .from('feature_usage')
    .select('id, usage_count')
    .eq('store_id', storeId)
    .eq('feature_key', normalizedKey)
    .order('updated_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  if (entry) {
    const newUsage = Math.max(0, (entry.usage_count || 0) - amount);
    await supabase
      .from('feature_usage')
      .update({ usage_count: newUsage, updated_at: now.toISOString() })
      .eq('id', entry.id);
    
    // Clear cache
    const cacheKey = `feature_limit:${storeId}:${normalizedKey}`;
    await cacheProvider.del(cacheKey);
    await clearStoreCache(storeId);
  }
}

module.exports = {
  DEFAULT_FEATURE_KEYS,
  checkFeatureLimit,
  reserveFeatureUsage,
  commitFeatureUsage,
  rollbackFeatureUsage,
  decrementFeatureUsage,
  getFeatureStates,
  getUsageSummary,
  canCreateProduct,
  canUploadImage,
  canUploadFile,
  canSendOTP,
  canCreateBranch,
  canCreateEmployee,
  resetMonthlyUsage,
  clearStoreCache
};
