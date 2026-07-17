const { supabase } = require('./supabase'); // Assuming this exports a configured client
const cacheProvider = require('./cacheProvider'); // Use the existing cache provider
const auditLogger = require('./auditLogger'); // Use the existing audit logger

class PolicyEngine {
  /**
   * Evaluate if a specific capability action is allowed for a tenant.
   * @param {string} storeId The UUID of the store
   * @param {string} capabilityCode e.g., 'products.create'
   * @param {object} context Requested action details (e.g., requested usage count)
   * @param {string} source Source of the decision
   */
  static async evaluate(storeId, capabilityCode, context = {}, source = 'API') {
    const startTime = Date.now();
    try {
      // 1. Fetch capability definition
      const { data: cap, error: capErr } = await supabase
        .from('capabilities')
        .select('*')
        .eq('code', capabilityCode)
        .single();
      
      if (capErr || !cap) {
        throw new Error(`Capability not found: ${capabilityCode}`);
      }

      // 2. Fetch the store's active entitlements (Overrides + Plan + Addons)
      const { data: overrides } = await supabase
        .from('store_feature_overrides')
        .select('limit_value')
        .eq('store_id', storeId)
        .eq('capability_id', cap.id)
        .or('expires_at.is.null,expires_at.gt.now()')
        .order('created_at', { ascending: false })
        .limit(1);

      let appliedLimit = cap.default_value;
      let decisionSource = 'Default';

      if (overrides && overrides.length > 0) {
        appliedLimit = overrides[0].limit_value;
        decisionSource = 'Override';
      } else {
        // Query current active plan for the store
        // Need to join stores -> subscriptions -> plan_versions -> plan_version_bundles -> bundle_capabilities
        const { data: storeSub } = await supabase
          .from('subscriptions')
          .select('plan_version_id')
          .eq('store_id', storeId)
          .eq('status', 'active')
          .single();

        if (storeSub && storeSub.plan_version_id) {
            // Find if there is a plan-specific capability limit
            const { data: planCap } = await supabase
               .from('plan_version_capabilities')
               .select('limit_value')
               .eq('plan_version_id', storeSub.plan_version_id)
               .eq('capability_id', cap.id)
               .single();

            if (planCap) {
                appliedLimit = planCap.limit_value;
                decisionSource = 'Plan Override';
            } else {
                // Otherwise find it through the bundle
                // Note: Simplified query for MVP, ideally done via DB Function/View
                const { data: bundleCap } = await supabase
                  .from('plan_version_bundles')
                  .select(`
                    bundles (
                        bundle_capabilities ( limit_value )
                    )
                  `)
                  .eq('plan_version_id', storeSub.plan_version_id)
                  .eq('bundles.bundle_capabilities.capability_id', cap.id)
                  .single();
                  
                if (bundleCap && bundleCap.bundles) {
                    appliedLimit = bundleCap.bundles.bundle_capabilities[0].limit_value;
                    decisionSource = 'Plan Bundle';
                }
            }
        }
      }

      // 3. Dependency Check (Does it depend on something else?)
      if (cap.depends_on) {
        const depAllowed = await this.evaluate(storeId, cap.depends_on, {}, source);
        if (!depAllowed.isAllowed) {
          return this._logDecision({
            storeId, capabilityCode, isAllowed: false, reason: `Dependency ${cap.depends_on} failed`,
            decisionSource: 'Dependency', latencyMs: Date.now() - startTime
          });
        }
      }

      // 4. Usage check
      let isAllowed = true;
      let reason = 'Allowed by default';

      if (cap.type === 'NUMERIC') {
        const limitValue = appliedLimit ? parseInt(appliedLimit.max || appliedLimit) : 0;
        const currentUsage = context.currentUsage || 0;
        const requestedAmount = context.requestedAmount || 1;

        if (currentUsage + requestedAmount > limitValue) {
          isAllowed = false;
          reason = `Limit exceeded. Max: ${limitValue}, Requested: ${currentUsage + requestedAmount}`;
        } else {
            reason = `Usage OK. Max: ${limitValue}, New Total: ${currentUsage + requestedAmount}`;
        }
      } else if (cap.type === 'BOOLEAN') {
         isAllowed = appliedLimit === true || appliedLimit === 'true';
         reason = isAllowed ? 'Feature enabled' : 'Feature disabled';
      }

      return this._logDecision({
        storeId, capabilityCode, isAllowed, reason, decisionSource,
        latencyMs: Date.now() - startTime, usage: context, appliedLimit
      });

    } catch (err) {
      console.error(`[PolicyEngine] Error evaluating ${capabilityCode}:`, err);
      // Fail secure: deny by default on error
      return this._logDecision({
        storeId, capabilityCode, isAllowed: false, reason: `Error: ${err.message}`,
        decisionSource: 'Error', latencyMs: Date.now() - startTime
      });
    }
  }

  static async getStoreLimits(storeId) {
    try {
      const { data: caps } = await supabase.from('capabilities').select('*');
      if (!caps) return {};

      const { data: sub } = await supabase
        .from('store_subscriptions')
        .select('plan_id')
        .eq('store_id', storeId)
        .eq('status', 'active')
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle();

      let resolvedLimits = {};
      caps.forEach(c => {
        resolvedLimits[c.code] = {
          max_value: c.default_value?.max ?? c.default_value,
          is_unlimited: c.default_value === null,
          limit_type: c.type === 'BOOLEAN' ? 'boolean' : 'numeric',
          limit_config: c.default_value
        };
      });

      if (sub && sub.plan_id) {
         const { data: planVersion } = await supabase
           .from('plan_versions')
           .select('id')
           .eq('plan_id', sub.plan_id)
           .eq('status', 'PUBLISHED')
           .order('version_number', { ascending: false })
           .limit(1)
           .maybeSingle();

         if (planVersion) {
            const { data: versionCaps } = await supabase
              .from('plan_version_capabilities')
              .select('limit_value, capability_id, capabilities(code, type)')
              .eq('plan_version_id', planVersion.id);

            if (versionCaps) {
              versionCaps.forEach(vc => {
                const code = vc.capabilities?.code;
                if (code) {
                  resolvedLimits[code] = {
                    max_value: vc.limit_value?.max ?? vc.limit_value,
                    is_unlimited: vc.limit_value === null,
                    limit_type: vc.capabilities?.type === 'BOOLEAN' ? 'boolean' : 'numeric',
                    limit_config: vc.limit_value
                  };
                }
              });
            }
         } else {
            const { data: oldLimits } = await supabase
              .from('plan_features')
              .select('features(key), feature_limits(limit_type, limit_config)')
              .eq('plan_id', sub.plan_id);

            if (oldLimits) {
              oldLimits.forEach(ol => {
                const key = ol.features?.key;
                const limitConfig = ol.feature_limits?.[0]?.limit_config;
                if (key) {
                   resolvedLimits[key] = {
                     max_value: limitConfig?.max_value ?? null,
                     is_unlimited: limitConfig?.max_value === null || !limitConfig,
                     limit_type: ol.feature_limits?.[0]?.limit_type,
                     limit_config: limitConfig
                   };
                }
              });
            }
         }
      }

      const { data: overrides } = await supabase
        .from('store_feature_overrides')
        .select('limit_value, capability_id, capabilities(code, type)')
        .eq('store_id', storeId)
        .or('expires_at.is.null,expires_at.gt.now()');

      if (overrides) {
        overrides.forEach(ov => {
          const code = ov.capabilities?.code;
          if (code) {
            resolvedLimits[code] = {
              max_value: ov.limit_value?.max ?? ov.limit_value,
              is_unlimited: ov.limit_value === null,
              limit_type: ov.capabilities?.type === 'BOOLEAN' ? 'boolean' : 'numeric',
              limit_config: ov.limit_value
            };
          }
        });
      }

      return resolvedLimits;
    } catch (err) {
      console.error('[PolicyEngine] Error fetching store limits:', err);
      return {};
    }
  }

  static async _logDecision(decisionParams) {
    const { storeId, capabilityCode, isAllowed, reason, decisionSource, latencyMs, usage, appliedLimit } = decisionParams;
    
    supabase.from('entitlement_decisions').insert([{
      store_id: storeId,
      capability_code: capabilityCode,
      is_allowed: isAllowed,
      reason,
      usage,
      applied_limit: appliedLimit,
      decision_source: decisionSource,
      latency_ms: latencyMs
    }]).then(({ error }) => {
      if (error) console.error('[PolicyEngine] Failed to log decision:', error);
    });

    return {
      isAllowed,
      reason,
      decisionSource,
      latencyMs
    };
  }
}

module.exports = PolicyEngine;
