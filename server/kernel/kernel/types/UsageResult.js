function createUsageResult({ featureId, usage, limit, remaining }) {
    return {
        featureId,
        usage: Number(usage),
        limit: Number(limit),
        remaining: Number(remaining),
        timestamp: new Date().toISOString()
    };
}

module.exports = {
    createUsageResult
};
