-- 85: FK index for plan_features on the actual column present in this schema.
--
-- Migration 52 declared idx_fk_plan_features_feature on plan_features(feature),
-- but this database's plan_features carries feature_id. Create the index under
-- the same advisor name against the real column.
--
-- Note: notification_preferences_store_event_uq (from 58) is intentionally
-- absent — migration 58 supersedes it with notification_preferences_pkey.

CREATE INDEX IF NOT EXISTS idx_fk_plan_features_feature
  ON public.plan_features (feature_id);
