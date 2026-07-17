-- Migration: Add phone column to tenant_invitations, make email nullable
-- This supports the new invitation flow where invites are sent via WhatsApp to a phone number
-- and the invitee provides their email during account activation.

ALTER TABLE public.tenant_invitations ALTER COLUMN email DROP NOT NULL;
ALTER TABLE public.tenant_invitations ADD COLUMN IF NOT EXISTS phone TEXT;

-- Index for phone lookups
CREATE INDEX IF NOT EXISTS idx_tenant_invitations_phone ON public.tenant_invitations(phone);