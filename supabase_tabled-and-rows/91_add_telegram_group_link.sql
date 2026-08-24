-- ─────────────────────────────────────────────────────────────────────────────
-- 91_add_telegram_group_link.sql
-- The tenant settings page sends telegram_group_link (Telegram channel/group
-- URL, optional alternative to WhatsApp) but site_settings never had the
-- column → PUT /api/admin/settings failed with 500 on every save.
-- Idempotent. Reversible: ALTER TABLE … DROP COLUMN telegram_group_link;
-- ─────────────────────────────────────────────────────────────────────────────
ALTER TABLE public.site_settings
  ADD COLUMN IF NOT EXISTS telegram_group_link text;
