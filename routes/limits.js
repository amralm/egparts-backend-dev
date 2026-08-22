const { apiError } = require('../utils/apiError');
const express = require('express');
const router = express.Router();
const { verifyUser } = require('../middleware/auth');
const { supabase } = require('../services/supabase');
const { getFeatureStates, getUsageSummary, resetMonthlyUsage, checkFeatureLimit } = require('../services/subscriptionLimitService');
const logger = require('../utils/logger');

router.get('/features', verifyUser, async (req, res) => {
  try {
    if (!req.store?.id) {
      return apiError(res, 400, 'Tenant context required', `HTTP_400`);
    }

    const states = await getFeatureStates(req.store.id);
    const usage = await getUsageSummary(req.store.id);
    res.json({ ...states, usage });
  } catch (err) {
    logger.error('Failed to load feature limits:', err.message);
    apiError(res, 500, 'Failed to load feature limits', `HTTP_500`);
  }
});

router.post('/reset-monthly', verifyUser, async (req, res) => {
  try {
    // Only platform super-admins may trigger a global monthly usage reset
    const { data: superAdmin } = await supabase
      .from('super_admins')
      .select('user_id')
      .eq('user_id', req.user?.sub)
      .maybeSingle();

    if (!superAdmin) {
      return apiError(res, 403, 'Platform admin access required', `HTTP_403`);
    }

    const ok = await resetMonthlyUsage();
    res.json({ success: ok });
  } catch (err) {
    logger.error('Failed to reset monthly limits:', err.message);
    apiError(res, 500, 'Failed to reset monthly limits', `HTTP_500`);
  }
});

router.get('/platform-dashboard', verifyUser, async (req, res) => {
  try {
    const { data: superAdmin } = await supabase
      .from('super_admins')
      .select('user_id')
      .eq('user_id', req.user?.sub)
      .maybeSingle();

    if (!superAdmin) {
      return apiError(res, 403, 'Platform admin access required', `HTTP_403`);
    }

    const [{ data: stores }, { data: usageRows }] = await Promise.all([
      supabase.from('stores').select('id, name, subdomain, status, subscription_expires_at').order('name', { ascending: true }),
      supabase.from('feature_usage').select('store_id, feature_key, usage_count, period').order('usage_count', { ascending: false }).limit(50)
    ]);

    const normalizedUsage = (usageRows || []).map(row => ({ ...row, usage: row.usage_count || 0, limit_value: null }));
    const productLimits = new Map(await Promise.all((stores || []).map(async store => [store.id, await checkFeatureLimit(store.id, 'products', 0)])));
    const topStorageUsers = normalizedUsage
      .filter((row) => row.feature_key === 'storage_bytes')
      .sort((a, b) => (b.usage || 0) - (a.usage || 0))
      .slice(0, 5);

    const topWhatsAppUsers = normalizedUsage
      .filter((row) => row.feature_key === 'whatsapp_messages_month')
      .sort((a, b) => (b.usage || 0) - (a.usage || 0))
      .slice(0, 5);

    const topAiUsers = normalizedUsage
      .filter((row) => row.feature_key === 'ai_requests_month')
      .sort((a, b) => (b.usage || 0) - (a.usage || 0))
      .slice(0, 5);

    const overLimitStores = (stores || []).filter((store) => {
      const feature = productLimits.get(store.id);
      return feature && !feature.is_unlimited && feature.limit != null && (feature.usage || 0) >= feature.limit;
    });

    const nearLimitStores = (stores || []).filter((store) => {
      const feature = productLimits.get(store.id);
      return feature && !feature.is_unlimited && feature.limit != null && (feature.usage || 0) >= Math.max(1, Math.floor(feature.limit * 0.8));
    });

    res.json({
      stores: stores || [],
      over_limit_stores: overLimitStores,
      near_limit_stores: nearLimitStores,
      top_storage_users: topStorageUsers,
      top_whatsapp_users: topWhatsAppUsers,
      top_ai_users: topAiUsers
    });
  } catch (err) {
    logger.error('Failed to load platform dashboard:', err.message);
    apiError(res, 500, 'Failed to load platform dashboard', `HTTP_500`);
  }
});

module.exports = router;
