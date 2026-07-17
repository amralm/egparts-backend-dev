const supabase = require('../supabase');

class EntitlementsEngine {
  /**
   * Calculates the full entitlements for a membership in a specific store.
   * @param {Object} store - The store context
   * @param {Object} membership - The resolved membership profile
   * @returns {Promise<Object>} Entitlements object containing limits, features, quotas
   */
  async calculate(store, membership) {
    // 1. loadPlanVersion()
    // Fetch the base plan limits
    let baseLimits = {
      RemainingProducts: 50,
      RemainingStorage: 1024,
    };
    let baseFeatures = {
      HasAI: false,
      HasPaymob: false,
    };

    if (store.plan_id) {
      const { data: plan } = await supabase
        .from('plans')
        .select('*')
        .eq('id', store.plan_id)
        .maybeSingle();

      if (plan) {
        // Overlay plan limits/features
        baseLimits = { ...baseLimits, ...(plan.limits || {}) };
        baseFeatures = { ...baseFeatures, ...(plan.features || {}) };
      }
    }

    // 2. loadOverrides()
    // Fetch store-specific overrides
    const { data: overrides } = await supabase
      .from('store_overrides')
      .select('*')
      .eq('store_id', store.id)
      .maybeSingle();

    if (overrides) {
      baseLimits = { ...baseLimits, ...(overrides.limits || {}) };
      baseFeatures = { ...baseFeatures, ...(overrides.features || {}) };
    }

    // 3. loadAddons()
    // Could fetch active addons from subscriptions/addons table
    const { data: addons } = await supabase
      .from('store_addons')
      .select('addon_code, value')
      .eq('store_id', store.id)
      .eq('status', 'active');

    if (addons && addons.length > 0) {
      addons.forEach(addon => {
        // Merge addon logic (e.g. Extra Storage)
        if (addon.addon_code === 'EXTRA_STORAGE') {
          baseLimits.RemainingStorage += (addon.value || 0);
        } else if (addon.addon_code === 'PAYMOB_ACCESS') {
          baseFeatures.HasPaymob = true;
        }
      });
    }

    // 4. calculateLimits()
    // Here we would ideally subtract usage from the baseLimits
    // e.g. Count current products and subtract from total limit to get RemainingProducts
    
    // For now, return calculated limits
    return {
      limits: baseLimits,
      features: baseFeatures,
      quotas: {}
    };
  }
}

module.exports = new EntitlementsEngine();
