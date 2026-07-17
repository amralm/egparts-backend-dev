const { FEATURES, FeatureRegistry } = require('./kernel/core/FeatureRegistry');

for (const [constantName, featureKey] of Object.entries(FEATURES)) {
    const def = FeatureRegistry.getDefinition(featureKey);
    if (!def) {
        console.log("Missing definition for:", constantName, featureKey);
    }
}
