-- Group icons.
--
-- A group is a persistent social circle, and circles have identities. One
-- emoji is the cheapest way to give a group a face that people recognise in a
-- list, with none of the machinery a real avatar would need - no uploads, no
-- storage bucket, no cropping, no moderation, no CDN.
--
-- The column is nullable with no default. Null means "no icon chosen", which
-- the client renders as a neutral placeholder, so every group that already
-- exists keeps working untouched and picking an icon stays optional.
--
-- Idempotent: safe to run against a database that already has it.

begin;

alter table public.groups
  add column if not exists icon text;

-- A single emoji, not a label. The length bound is generous because one
-- user-perceived emoji can be several code points - a ZWJ sequence like a
-- flag or a profession is legitimately long - but it is bounded so the column
-- cannot become a second name field.
do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'groups_icon_len'
  ) then
    alter table public.groups
      add constraint groups_icon_len
      check (icon is null or char_length(icon) between 1 and 24);
  end if;
end
$$;

-- ---------------------------------------------------------------- reads

-- list_groups gains the icon. Same security posture as before: security
-- invoker, so a caller only ever sees groups their RLS policy already allows.
--
-- Dropped first: Postgres refuses to let CREATE OR REPLACE change the columns
-- a set-returning function declares, so adding one means replacing it.
drop function if exists public.list_groups();

create function public.list_groups()
returns table (
  group_id     uuid,
  name         text,
  icon         text,
  owner_id     uuid,
  is_owner     boolean,
  member_count int,
  created_at   timestamptz
)
language sql
stable
security invoker
set search_path = public, pg_temp
as $$
  select g.id,
         g.name,
         g.icon,
         g.owner_id,
         g.owner_id = (select auth.uid()),
         (select count(*)::int from public.group_members m where m.group_id = g.id),
         g.created_at
  from public.groups g
  where exists (
    select 1 from public.group_members m
    where m.group_id = g.id and m.user_id = (select auth.uid())
  )
  order by g.created_at;
$$;

-- ---------------------------------------------------------------- writes

-- Creating a group may name an icon up front.
create or replace function public.create_group(p_name text, p_icon text default null)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor uuid := public.require_actor();
  v_name  text := btrim(coalesce(p_name, ''));
  v_icon  text := nullif(btrim(coalesce(p_icon, '')), '');
  v_group uuid;
begin
  if char_length(v_name) < 1 or char_length(v_name) > 40 then
    raise exception 'kickback: group name must be 1-40 characters' using errcode = '22023';
  end if;
  if v_icon is not null and char_length(v_icon) > 24 then
    raise exception 'kickback: group icon is too long' using errcode = '22023';
  end if;

  insert into public.groups (name, icon, owner_id)
  values (v_name, v_icon, v_actor)
  returning id into v_group;

  insert into public.group_members (group_id, user_id, role)
  values (v_group, v_actor, 'owner');

  return v_group;
end;
$$;

-- Changing the icon is an owner action, exactly like renaming.
create or replace function public.set_group_icon(p_group uuid, p_icon text)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor uuid := public.require_actor();
  v_icon  text := nullif(btrim(coalesce(p_icon, '')), '');
begin
  if v_icon is not null and char_length(v_icon) > 24 then
    raise exception 'kickback: group icon is too long' using errcode = '22023';
  end if;

  -- The ownership check is the authorization boundary. A member who is not
  -- the owner gets the same answer as a stranger: no such group.
  if not exists (
    select 1 from public.groups g
    where g.id = p_group and g.owner_id = v_actor
  ) then
    raise exception 'kickback: group not found' using errcode = 'P0002';
  end if;

  update public.groups set icon = v_icon where id = p_group;
end;
$$;

-- Same posture as every other RPC: reachable by signed-in callers only, and
-- never by anon.
revoke all on function public.list_groups() from public, anon, authenticated;
revoke all on function public.create_group(text, text) from public, anon, authenticated;
revoke all on function public.set_group_icon(uuid, text) from public, anon, authenticated;

grant execute on function public.list_groups() to authenticated;
grant execute on function public.create_group(text, text) to authenticated;
grant execute on function public.set_group_icon(uuid, text) to authenticated;

-- The single-argument create_group is superseded by the defaulted version;
-- dropping it prevents PostgREST resolving an ambiguous overload.
drop function if exists public.create_group(text);

commit;
