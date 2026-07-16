const express = require('express');
const router = express.Router();
const { supabase } = require('../services/supabase');

router.get('/limits/features', async (req, res) => {
  try {
    const storeId = req.store.id;

    const { data: store, error: storeErr } = await supabase
      .from('stores')
      .select('plan_id')
      .eq('id', storeId)
      .single();

    if (storeErr) {
      console.error('Store query error:', storeErr);
      return res.status(500).json({ error: 'Failed to load store' });
    }

    let features = {};
    if (store?.plan_id) {
      const { data: planFeatures, error: pfErr } = await supabase
        .from('plan_features')
        .select('feature_key, limit_value, is_enabled')
        .eq('plan_id', store.plan_id);

      if (pfErr) {
        console.error('Plan features query error:', pfErr);
        return res.status(500).json({ error: 'Failed to load plan features' });
      }

      if (planFeatures) {
        planFeatures.forEach(pf => {
          features[pf.feature_key] = { limit: pf.limit_value, enabled: pf.is_enabled };
        });
      }
    }

    res.json({ features, plan_id: store?.plan_id });
  } catch (err) {
    console.error('Features error:', err);
    res.status(500).json({ error: 'Failed to load features' });
  }
});

module.exports = router;