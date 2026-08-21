-- Central, server-authoritative WhatsApp phone verification.
-- Existing profiles are intentionally not auto-marked verified: a stored phone
-- number is not proof that the current account completed an OTP challenge.

create table if not exists public.account_phone_verifications (
  user_id uuid primary key references auth.users(id) on delete cascade,
  phone_e164 text not null,
  verification_method text not null default 'whatsapp_otp',
  verified_at timestamptz not null default now(),
  last_verified_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint account_phone_verifications_phone_format check (phone_e164 ~ '^20[0-9]{10}$')
);

create unique index if not exists account_phone_verifications_phone_uq
  on public.account_phone_verifications (phone_e164);

create table if not exists public.phone_verification_tickets (
  id uuid primary key default gen_random_uuid(),
  ticket_hash text not null unique,
  phone_e164 text not null,
  store_id uuid not null,
  purpose text not null default 'signup',
  user_id uuid references auth.users(id) on delete set null,
  expires_at timestamptz not null,
  consumed_at timestamptz,
  created_at timestamptz not null default now(),
  constraint phone_verification_tickets_phone_format check (phone_e164 ~ '^20[0-9]{10}$')
);

create index if not exists phone_verification_tickets_expiry_idx
  on public.phone_verification_tickets (expires_at)
  where consumed_at is null;

alter table public.account_phone_verifications enable row level security;
alter table public.phone_verification_tickets enable row level security;

revoke all on table public.account_phone_verifications from anon, authenticated;
revoke all on table public.phone_verification_tickets from anon, authenticated;
grant select on table public.account_phone_verifications to authenticated;
grant select on table public.phone_verification_tickets to authenticated;

drop policy if exists account_phone_verifications_self_read on public.account_phone_verifications;
create policy account_phone_verifications_self_read
  on public.account_phone_verifications for select to authenticated
  using (user_id = auth.uid());

drop policy if exists phone_verification_tickets_self_read on public.phone_verification_tickets;
create policy phone_verification_tickets_self_read
  on public.phone_verification_tickets for select to authenticated
  using (user_id = auth.uid());

grant all on table public.account_phone_verifications to service_role;
grant all on table public.phone_verification_tickets to service_role;

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

  select * into v_ticket
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
    select 1 from public.account_phone_verifications as av
    where av.phone_e164 = p_phone_e164 and av.user_id <> p_user_id
  ) then
    raise exception 'phone already verified by another account' using errcode = '23505';
  end if;

  insert into public.account_phone_verifications (
    user_id, phone_e164, verification_method, verified_at, last_verified_at, updated_at
  ) values (
    p_user_id, p_phone_e164, 'whatsapp_otp', v_now, v_now, v_now
  )
  on conflict (user_id) do update set
    phone_e164 = excluded.phone_e164,
    verification_method = excluded.verification_method,
    last_verified_at = excluded.last_verified_at,
    updated_at = excluded.updated_at;

  update public.phone_verification_tickets
  set user_id = p_user_id, consumed_at = v_now
  where id = v_ticket.id;

  return query
  select v.user_id, v.phone_e164, v.verified_at, v.last_verified_at, v.verification_method
  from public.account_phone_verifications v
  where v.user_id = p_user_id;
end;
$$;

revoke execute on function public.claim_phone_verification_ticket(uuid, text, uuid, text) from public, anon, authenticated;
grant execute on function public.claim_phone_verification_ticket(uuid, text, uuid, text) to service_role;
