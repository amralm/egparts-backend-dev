const express = require('express');
const router = express.Router();
const { verifyUser } = require('../middleware/auth');
const { supabase } = require('../services/supabase');
const { getFeatureStates, getUsageSummary, resetMonthlyUsage } = require('../services/subscriptionLimitService');
const logger = require('../utils/logger');

router.get('/features', verifyUser, async (req, res) => {
  try {
    if (!req.store?.id) {
      return res.status(400).json({ error: 'Tenant context required' });
    }

    const states = await getFeatureStates(req.store.id);
    const usage = await getUsageSummary(req.store.id);
    res.json({ ...states, usage });
  } catch (err) {
    logger.error('Failed to load feature limits:', err.message);
    res.status(500).json({ error: 'Failed to load feature limits' });
  }
});

router.post('/reset-monthly', verifyUser, async (req, res) => {
  try {
    const ok = await resetMonthlyUsage();
    res.json({ success: ok });
  } catch (err) {
    logger.error('Failed to reset monthly limits:', err.message);
    res.status(500).json({ error: 'Failed to reset monthly limits' });
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
      return res.status(403).json({ error: 'Platform admin access required' });
    }

    const [{ data: stores }, { data: usageRows }] = await Promise.all([
      supabase.from('stores').select('id, name, subdomain, status, subscription_expires_at').order('name', { ascending: true }),
      supabase.from('feature_usage').select('store_id, feature_key, usage, limit_value, period').order('usage', { ascending: false }).limit(50)
    ]);

    const topStorageUsers = (usageRows || [])
      .filter((row) => row.feature_key === 'storage_bytes')
      .sort((a, b) => (b.usage || 0) - (a.usage || 0))
      .slice(0, 5);

    const topWhatsAppUsers = (usageRows || [])
      .filter((row) => row.feature_key === 'whatsapp_messages_month')
      .sort((a, b) => (b.usage || 0) - (a.usage || 0))
      .slice(0, 5);

    const topAiUsers = (usageRows || [])
      .filter((row) => row.feature_key === 'ai_requests_month')
      .sort((a, b) => (b.usage || 0) - (a.usage || 0))
      .slice(0, 5);

    const overLimitStores = (stores || []).filter((store) => {
      const feature = (usageRows || []).find((row) => row.store_id === store.id && row.feature_key === 'products');
      return feature && feature.limit_value != null && (feature.usage || 0) >= (feature.limit_value || 0);
    });

    const nearLimitStores = (stores || []).filter((store) => {
      const feature = (usageRows || []).find((row) => row.store_id === store.id && row.feature_key === 'products');
      return feature && feature.limit_value != null && (feature.usage || 0) >= Math.max(1, Math.floor((feature.limit_value || 0) * 0.8));
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
    res.status(500).json({ error: 'Failed to load platform dashboard' });
  }
});

module.exports = router;
