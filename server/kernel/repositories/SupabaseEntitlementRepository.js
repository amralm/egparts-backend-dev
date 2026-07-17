const IEntitlementRepository = require('../contracts/IEntitlementRepository');
const { supabase } = require('../../../services/supabase');

class SupabaseEntitlementRepository extends IEntitlementRepository {
    async getFeatureDefinition(featureKey) {
        const { data: def, error } = await supabase
            .from('feature_definitions')
            .select('id, feature_type, reset_period')
            .eq('key', featureKey)
            .single();
            
        if (error || !def) {
            throw new Error(`Feature definition not found: ${featureKey}`);
        }
        return def;
    }

    async calculateEntitlement(tenantId, featureId) {
        const { data: entitlement, error } = await supabase.rpc('calculate_entitlement', {
            p_store_id: tenantId,
            p_feature_definition_id: featureId
        });

        if (error) {
            throw new Error(`Entitlement calculation failed: ${error.message}`);
        }
        
        return {
            hard_limit: parseFloat(entitlement.hard_limit),
            soft_limit: parseFloat(entitlement.soft_limit)
        };
    }

    async getUsageSnapshot(tenantId, featureId) {
        const { data: snapshot, error } = await supabase
            .from('feature_usage_snapshots')
            .select('current_usage')
            .eq('store_id', tenantId)
            .eq('feature_definition_id', featureId)
            .maybeSingle();

        if (error) {
            throw new Error(`Failed to fetch current usage: ${error.message}`);
        }

        return {
            current_usage: snapshot ? parseFloat(snapshot.current_usage) : 0
        };
    }

    async consume(tenantId, featureId, amount, options) {
        const { data, error } = await supabase.rpc('consume_feature', {
            p_store_id: tenantId,
            p_feature_definition_id: featureId,
            p_amount: amount,
            p_event_type: options.eventType,
            p_source: options.source,
            p_idempotency_key: options.idempotencyKey,
            p_actor_id: options.actorId,
            p_reference_id: options.referenceId,
            p_correlation_id: options.correlationId,
            p_causation_id: options.causationId,
            p_request_id: options.requestId,
            p_metadata: options.metadata
        });

        if (error) {
            throw new Error(`Entitlement consume failed: ${error.message}`);
        }

        return data; 
    }
}

module.exports = SupabaseEntitlementRepository;
