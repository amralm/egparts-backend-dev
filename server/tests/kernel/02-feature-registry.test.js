const { FeatureRegistry, FEATURES, FEATURE_DEFINITIONS_METADATA } = require('../../kernel/core/FeatureRegistry');

describe('FeatureRegistry Self-Verification', () => {

    it('should have no duplicate feature keys in FEATURES', () => {
        const keys = Object.values(FEATURES);
        const uniqueKeys = new Set(keys);
        expect(keys.length).toBe(uniqueKeys.size);
    });

    it('should have a definition for every feature in FEATURES', () => {
        for (const [constantName, featureKey] of Object.entries(FEATURES)) {
            const def = FeatureRegistry.getDefinition(featureKey);
            expect(def).toBeDefined();
            expect(def.key).toBe(featureKey);
        }
    });

    it('should have no duplicate display names', () => {
        const names = Object.values(FEATURE_DEFINITIONS_METADATA).map(def => def.display_name);
        const uniqueNames = new Set(names);
        expect(names.length).toBe(uniqueNames.size);
    });

    it('every feature must have required structural properties', () => {
        for (const [featureKey, def] of Object.entries(FEATURE_DEFINITIONS_METADATA)) {
            // Must have a category
            expect(typeof def.category).toBe('string');
            expect(def.category.length).toBeGreaterThan(0);

            // Must have a reset_period
            expect(['LIFETIME', 'MONTHLY', 'DAILY']).toContain(def.reset_period);

            // Must have a feature_type
            expect(['LIMIT', 'BOOLEAN', 'QUOTA', 'RATE_LIMIT']).toContain(def.feature_type);

            // Must have display_name and description (for seeding)
            expect(typeof def.display_name).toBe('string');
            expect(def.display_name.length).toBeGreaterThan(0);
            expect(typeof def.description).toBe('string');
            expect(def.description.length).toBeGreaterThan(0);
        }
    });

    it('should return undefined for unknown feature', () => {
        const def = FeatureRegistry.getDefinition('non.existent.feature');
        expect(def).toBeUndefined();
    });

});
