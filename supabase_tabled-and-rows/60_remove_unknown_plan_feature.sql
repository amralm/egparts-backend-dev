-- Remove a test-only feature that was accidentally persisted from the plan editor.
-- It is not part of the runtime entitlement catalog.
BEGIN;

DELETE FROM public.plan_features
WHERE feature_id IN (
  SELECT id FROM public.features WHERE key = 'random_nonexistent_feature'
);

DELETE FROM public.features
WHERE key = 'random_nonexistent_feature';

COMMIT;
