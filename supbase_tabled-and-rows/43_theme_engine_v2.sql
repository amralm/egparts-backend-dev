-- Theme Engine v2: backward-compatible site_settings columns.
-- Safe for Supabase/PostgreSQL. This migration does not remove theme_colors.

begin;

alter table public.site_settings
  add column if not exists theme_id text default 'midnight';

alter table public.site_settings
  add column if not exists theme_overrides jsonb default '{}'::jsonb;

alter table public.site_settings
  add column if not exists theme_version integer default 1;

update public.site_settings
set
  theme_id = coalesce(nullif(theme_id, ''), 'midnight'),
  theme_overrides = coalesce(theme_overrides, '{}'::jsonb),
  theme_version = coalesce(theme_version, 1);

alter table public.site_settings
  alter column theme_id set not null,
  alter column theme_overrides set not null,
  alter column theme_version set not null;

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'site_settings_theme_id_check'
      and conrelid = 'public.site_settings'::regclass
  ) then
    alter table public.site_settings
      add constraint site_settings_theme_id_check
      check (theme_id in ('midnight', 'ocean'));
  end if;

  if not exists (
    select 1
    from pg_constraint
    where conname = 'site_settings_theme_overrides_object_check'
      and conrelid = 'public.site_settings'::regclass
  ) then
    alter table public.site_settings
      add constraint site_settings_theme_overrides_object_check
      check (jsonb_typeof(theme_overrides) = 'object');
  end if;

  if not exists (
    select 1
    from pg_constraint
    where conname = 'site_settings_theme_version_check'
      and conrelid = 'public.site_settings'::regclass
  ) then
    alter table public.site_settings
      add constraint site_settings_theme_version_check
      check (theme_version >= 1);
  end if;
end $$;

create index if not exists idx_site_settings_theme_id
  on public.site_settings(theme_id);

commit;
