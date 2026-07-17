/**
 * Factory for creating EntitlementResults
 */
function createEntitlementResult({ isAllowed, featureId, requestedAmount, currentUsage, hardLimit, reason = null }) {
    return {
        isAllowed: Boolean(isAllowed),
        featureId,
        requestedAmount: Number(requestedAmount),
        currentUsage: Number(currentUsage),
        hardLimit: Number(hardLimit),
        reason,
        timestamp: new Date().toISOString()
    };
}

module.exports = {
    createEntitlementResult
};
