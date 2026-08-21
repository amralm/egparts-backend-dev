-- The first ambiguity fix exposed a second PL/pgSQL name collision at
-- ON CONFLICT (user_id). Use the table's primary-key constraint explicitly.

create or replace function public.claim_phone_verification_ticket(
  p_user_id uuid,
  p_phone_e164 text,
  p_store_id uuid default null,
  p_ticket_hash text default null
)
returns table (
  user_id uuid,
  phone_e164 text,
  verified_at timestamptz,
  last_verified_at timestamptz,
  verification_method text
)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_ticket public.phone_verification_tickets%rowtype;
  v_now timestamptz := now();
begin
  if p_user_id is null or p_phone_e164 !~ '^20[0-9]{10}$' then
    raise exception 'invalid phone verification input' using errcode = '22023';
  end if;

  if p_ticket_hash is null and p_store_id is null then
    raise exception 'verification store is required' using errcode = '22023';
  end if;

  select t.* into v_ticket
  from public.phone_verification_tickets as t
  where t.phone_e164 = p_phone_e164
    and t.user_id is null
    and t.consumed_at is null
    and t.expires_at > v_now
    and (p_ticket_hash is not null and t.ticket_hash = p_ticket_hash
         or p_ticket_hash is null and t.store_id = p_store_id)
  order by t.created_at desc
  limit 1
  for update;

  if not found then
    raise exception 'verification ticket is invalid or expired' using errcode = 'P0001';
  end if;

  if exists (
    select 1
    from public.account_phone_verifications as av
    where av.phone_e164 = p_phone_e164
      and av.user_id <> p_user_id
  ) then
    raise exception 'phone already verified by another account' using errcode = '23505';
  end if;

  insert into public.account_phone_verifications (
    user_id, phone_e164, verification_method, verified_at, last_verified_at, updated_at
  ) values (
    p_user_id, p_phone_e164, 'whatsapp_otp', v_now, v_now, v_now
  )
  on conflict on constraint account_phone_verifications_pkey do update set
    phone_e164 = excluded.phone_e164,
    verification_method = excluded.verification_method,
    last_verified_at = excluded.last_verified_at,
    updated_at = excluded.updated_at;

  update public.phone_verification_tickets as t
  set user_id = p_user_id, consumed_at = v_now
  where t.id = v_ticket.id;

  return query
  select av.user_id, av.phone_e164, av.verified_at, av.last_verified_at, av.verification_method
  from public.account_phone_verifications as av
  where av.user_id = p_user_id;
end;
$$;

revoke execute on function public.claim_phone_verification_ticket(uuid, text, uuid, text) from public, anon, authenticated;
grant execute on function public.claim_phone_verification_ticket(uuid, text, uuid, text) to service_role;
