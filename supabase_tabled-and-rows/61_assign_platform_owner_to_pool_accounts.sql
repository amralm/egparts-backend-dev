-- Central WhatsApp accounts need a valid owner for the encrypted session row.
-- Their dispatch identity remains whatsapp_account_id, not this system store.
UPDATE public.whatsapp_accounts
SET store_id = '00000000-0000-0000-0000-000000000000'::uuid,
    updated_at = now()
WHERE store_id IS NULL;
