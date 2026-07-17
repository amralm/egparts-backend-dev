const EntitlementFacade = require('./EntitlementFacade');
const { LimitExceededError, PolicyDeniedError, KernelError } = require('../errors');
const { FeatureRegistry } = require('../core/FeatureRegistry');

/**
 * Policy Middleware
 * The universal gateway for all feature access, quotas, and limits.
 * 
 * Usage:
 * router.post('/copilot', requireEntitlement([
 *   { feature: FEATURES.AI_MESSAGES_DAILY, consume: 1 },
 *   { feature: FEATURES.AI_REQUESTS_MONTHLY, consume: 1 }
 * ]), controller)
 */
const requireEntitlement = (policies) => {
    // Normalize to array
    const policyArray = Array.isArray(policies) ? policies : [policies];

    return async (req, res, next) => {
        try {
            const storeId = req.store?.id;
            const userId = req.user?.sub;

            if (!storeId) {
                return res.status(400).json({ error: 'Tenant context required for policy evaluation' });
            }

            req.policies = req.policies || {};
            const authResults = [];

            // 1. Authorize ALL first (Fail-fast before consuming)
            for (const policy of policyArray) {
                if (!policy.feature) {
                    return res.status(500).json({ error: 'Feature key is missing in policy configuration' });
                }

                const consumeAmt = policy.consume || 0;
                let authResult;
                try {
                    authResult = await EntitlementFacade.authorize(storeId, policy.feature, consumeAmt);
                } catch (error) {
                    if (error instanceof LimitExceededError) {
                        const def = FeatureRegistry.getDefinition(policy.feature);
                        const isPermission = def && def.feature_type === 'BOOLEAN';
                        const status = isPermission ? 403 : 429;
                        
                        return res.status(status).json({
                            error: 'Policy Enforced',
                            reason: error.code,
                            feature: policy.feature,
                            answer: isPermission 
                                ? `عذراً، هذه الميزة غير متاحة في باقتك الحالية. يرجى الترقية.`
                                : `عذراً، لقد استهلكت الحد المسموح لهذه الميزة. يرجى الترقية للاستمرار.`,
                            details: error.message,
                            upgrade: {
                                recommended: true,
                                reason: policy.feature,
                                urgency: 'high'
                            }
                        });
                    }
                    throw error;
                }
                
                authResults.push({ policy, authResult });
            }

            // 2. Consume ALL securely (since all authorized)
            const consumedList = [];
            try {
                for (const item of authResults) {
                    const { policy, authResult } = item;
                    const consumeAmt = policy.consume || 0;
                    
                    if (consumeAmt > 0) {
                        const consumptionData = await EntitlementFacade.consume(storeId, policy.feature, consumeAmt, {
                            eventType: policy.eventType || 'consume',
                            source: policy.source || 'API',
                            actorId: userId,
                            requestId: req.headers['x-request-id'] || null,
                            metadata: { path: req.path, method: req.method }
                        });

                        consumedList.push({ feature: policy.feature, amount: consumeAmt });

                        req.policies[policy.feature] = {
                            amountConsumed: consumeAmt,
                            remaining: consumptionData.remaining,
                            hardLimit: consumptionData.limit
                        };
                    } else {
                        // Just checked
                        req.policies[policy.feature] = {
                            amountConsumed: 0,
                            remaining: authResult.evalResult?.remaining,
                            hardLimit: authResult.evalResult?.hardLimit
                        };
                    }
                }
            } catch (consumeError) {
                console.error(`[PolicyMiddleware] Consume failed during batch execution, attempting rollback:`, consumeError);
                // Rollback previously consumed in this batch
                for (const item of consumedList) {
                    await EntitlementFacade.refund(storeId, item.feature, item.amount, { source: 'Rollback' }).catch(e => 
                        console.error(`[PolicyMiddleware] CRITICAL: Failed to rollback ${item.feature} after batch error:`, e)
                    );
                }
                
                if (consumeError instanceof KernelError) {
                     return res.status(403).json({ error: consumeError.code, details: consumeError.message });
                }
                
                return res.status(500).json({ error: 'Internal policy evaluation error', details: consumeError.message });
            }

            next();
        } catch (error) {
            console.error(`[PolicyMiddleware] Error in policy evaluation:`, error);
            if (error instanceof KernelError) {
                return res.status(400).json({ error: error.code, details: error.message });
            }
            return res.status(500).json({ error: 'Internal policy evaluation error', details: error.message });
        }
    };
};

module.exports = {
    requireEntitlement
};
