-- Kickback Phase 2B — 0008: group and chat RPCs
--
-- Same discipline as every other mutation in Kickback: SECURITY DEFINER, the
-- actor is always auth.uid(), and no function accepts an actor id.

-- ------------------------------------------------------------ group admin

create or replace function public.create_group(p_name text)
returns uuid
language plpgsql
volatile
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor uuid := public.require_actor();
  v_name  text := btrim(coalesce(p_name, ''));
  v_group uuid;
begin
  if char_length(v_name) < 1 or char_length(v_name) > 40 then
    raise exception 'kickback: group name must be 1-40 characters' using errcode = '22023';
  end if;
  if not public.consume_rate_budget('group_create', 10, interval '1 hour') then
    raise exception 'kickback: too many groups created' using errcode = '53400';
  end if;

  insert into public.groups (name, owner_id) values (v_name, v_actor)
  returning id into v_group;

  -- The creator is a member from the outset; a group with no members is not
  -- a state anything else should have to handle.
  insert into public.group_members (group_id, user_id, role)
  values (v_group, v_actor, 'owner');

  return v_group;
end;
$$;

create or replace function public.rename_group(p_group uuid, p_name text)
returns text
language plpgsql
volatile
security definer
set search_path = public, pg_temp
as $$
declare
  v_name text := btrim(coalesce(p_name, ''));
begin
  perform public.require_actor();
  if not public.is_group_owner(p_group) then
    raise exception 'kickback: only the group owner can do that' using errcode = '42501';
  end if;
  if char_length(v_name) < 1 or char_length(v_name) > 40 then
    raise exception 'kickback: group name must be 1-40 characters' using errcode = '22023';
  end if;

  update public.groups set name = v_name where id = p_group;
  return v_name;
end;
$$;

create or replace function public.delete_group(p_group uuid)
returns boolean
language plpgsql
volatile
security definer
set search_path = public, pg_temp
as $$
begin
  perform public.require_actor();
  if not public.is_group_owner(p_group) then
    raise exception 'kickback: only the group owner can do that' using errcode = '42501';
  end if;

  -- Members, invites and messages all cascade.
  delete from public.groups where id = p_group;
  return true;
end;
$$;

-- ------------------------------------------------------------- membership

-- Returns 'invited' | 'already_member' | 'already_invited'
create or replace function public.invite_to_group(p_group uuid, p_target uuid)
returns text
language plpgsql
volatile
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor uuid := public.require_actor();
begin
  if not public.is_group_owner(p_group) then
    raise exception 'kickback: only the group owner can invite' using errcode = '42501';
  end if;
  if p_target is null or p_target = v_actor then
    raise exception 'kickback: you are already in this group' using errcode = '22023';
  end if;
  if not exists (select 1 from public.users u where u.id = p_target) then
    raise exception 'kickback: user not found' using errcode = 'P0002';
  end if;

  if exists (
    select 1 from public.group_members m
    where m.group_id = p_group and m.user_id = p_target
  ) then
    return 'already_member';
  end if;

  if exists (
    select 1 from public.group_invites i
    where i.group_id = p_group and i.to_user = p_target and i.status = 'pending'
  ) then
    return 'already_invited';
  end if;

  insert into public.group_invites (group_id, from_user, to_user)
  values (p_group, v_actor, p_target);

  return 'invited';
end;
$$;

-- Returns 'accepted' | 'declined'
create or replace function public.respond_to_group_invite(p_invite uuid, p_accept boolean)
returns text
language plpgsql
volatile
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor  uuid := public.require_actor();
  v_invite public.group_invites%rowtype;
begin
  select * into v_invite from public.group_invites where id = p_invite for update;

  -- One message for "no such invite" and "not yours", so this cannot be used
  -- to probe whether an invite id exists.
  if not found or v_invite.to_user <> v_actor then
    raise exception 'kickback: invitation not found' using errcode = 'P0002';
  end if;
  if v_invite.status <> 'pending' then
    raise exception 'kickback: invitation already resolved' using errcode = '22023';
  end if;

  if p_accept then
    update public.group_invites
       set status = 'accepted', responded_at = now()
     where id = p_invite;

    -- Joining a group creates no friendship. B and C can share a group
    -- without ever becoming friends; that is the whole point.
    insert into public.group_members (group_id, user_id, role)
    values (v_invite.group_id, v_actor, 'member')
    on conflict (group_id, user_id) do nothing;

    return 'accepted';
  end if;

  update public.group_invites
     set status = 'declined', responded_at = now()
   where id = p_invite;
  return 'declined';
end;
$$;

create or replace function public.leave_group(p_group uuid)
returns boolean
language plpgsql
volatile
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor uuid := public.require_actor();
begin
  if public.is_group_owner(p_group) then
    -- Keeping ownership transfer out of the beta: the owner deletes instead.
    raise exception 'kickback: the owner cannot leave; delete the group instead'
      using errcode = '22023';
  end if;

  delete from public.group_members
   where group_id = p_group and user_id = v_actor;
  return true;
end;
$$;

create or replace function public.remove_group_member(p_group uuid, p_user uuid)
returns boolean
language plpgsql
volatile
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor uuid := public.require_actor();
begin
  if not public.is_group_owner(p_group) then
    raise exception 'kickback: only the group owner can do that' using errcode = '42501';
  end if;
  if p_user = v_actor then
    raise exception 'kickback: the owner cannot remove themselves' using errcode = '22023';
  end if;

  delete from public.group_members
   where group_id = p_group and user_id = p_user;

  -- Drop any live invite too, so removal is not undone by an old invitation.
  update public.group_invites
     set status = 'cancelled', responded_at = now()
   where group_id = p_group and to_user = p_user and status = 'pending';

  return true;
end;
$$;

-- ------------------------------------------------------------------- chat

create or replace function public.send_group_message(p_group uuid, p_body text)
returns uuid
language plpgsql
volatile
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor uuid := public.require_actor();
  v_body  text := btrim(coalesce(p_body, ''));
  v_id    uuid;
begin
  if not public.is_group_member(p_group) then
    raise exception 'kickback: you are not in this group' using errcode = '42501';
  end if;
  if char_length(v_body) < 1 then
    raise exception 'kickback: message is empty' using errcode = '22023';
  end if;
  if char_length(v_body) > 500 then
    raise exception 'kickback: message is too long' using errcode = '22023';
  end if;
  -- Fast enough for a lively conversation, far below what a script would do.
  if not public.consume_rate_budget('group_message', 30, interval '1 minute') then
    raise exception 'kickback: you are sending messages too quickly' using errcode = '53400';
  end if;

  insert into public.group_messages (group_id, user_id, body)
  values (p_group, v_actor, v_body)
  returning id into v_id;

  return v_id;
end;
$$;

-- --------------------------------------------------------------- readers
--
-- SECURITY INVOKER: these run as the caller so RLS applies on top of the
-- explicit scoping, exactly like list_friends.

-- Dropped by its exact zero-argument signature before being created.
--
-- CREATE OR REPLACE cannot change the columns a set-returning function
-- declares, and 0009 adds one. Without this drop, re-running the bundle
-- against a database that already has 0009 fails here with
--
--   42P13: cannot change return type of existing function
--   HINT:  Use DROP FUNCTION list_groups() first.
--
-- because this statement meets the seven-column function 0009 left behind and
-- cannot replace it with a six-column one. The signature is spelled out so
-- this can never remove an unrelated overload.
drop function if exists public.list_groups();

create function public.list_groups()
returns table (
  group_id     uuid,
  name         text,
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
         g.owner_id,
         g.owner_id = (select auth.uid()),
         (select count(*)::int from public.group_members m where m.group_id = g.id),
         g.created_at
  from public.groups g
  join public.group_members me on me.group_id = g.id and me.user_id = (select auth.uid())
  order by g.created_at;
$$;

create or replace function public.list_group_members(p_group uuid)
returns table (
  group_id     uuid,
  user_id      uuid,
  display_name text,
  avatar_url   text,
  twitch_login text,
  role         text,
  status       text,
  platform     text,
  channel      text,
  last_seen_at timestamptz,
  updated_at   timestamptz
)
language sql
stable
security invoker
set search_path = public, pg_temp
as $$
  select m.group_id, u.id, u.display_name, u.avatar_url, ca.platform_login, m.role,
         coalesce(p.status, 'offline'), p.platform, p.channel, p.last_seen_at, p.updated_at
  from public.group_members m
  join public.users u on u.id = m.user_id
  left join public.connected_accounts ca on ca.user_id = u.id and ca.platform = 'twitch'
  left join public.presence p on p.user_id = u.id
  where m.group_id = p_group
  order by u.display_name;
$$;

create or replace function public.list_group_invites()
returns table (
  invite_id    uuid,
  group_id     uuid,
  group_name   text,
  from_user    uuid,
  from_name    text,
  created_at   timestamptz
)
language sql
stable
-- DEFINER, unlike the other readers: an invitee is not yet a member and has no
-- other reason to be able to read the inviter's profile, so an invoker-rights
-- join against `users` would silently drop the row. Scoped explicitly to
-- to_user = auth.uid(), so it can only ever return invitations addressed here.
security definer
set search_path = public, pg_temp
as $$
  select i.id, i.group_id, g.name, i.from_user, inviter.display_name, i.created_at
  from public.group_invites i
  join public.groups g on g.id = i.group_id
  join public.users inviter on inviter.id = i.from_user
  where i.to_user = (select auth.uid())
    and i.status = 'pending'
  order by i.created_at desc;
$$;

create or replace function public.list_group_messages(p_group uuid, p_limit int default 100)
returns table (
  message_id   uuid,
  group_id     uuid,
  user_id      uuid,
  display_name text,
  avatar_url   text,
  body         text,
  created_at   timestamptz
)
language sql
stable
security invoker
set search_path = public, pg_temp
as $$
  -- Newest N, handed back oldest-first so the client can render and derive
  -- combos in reading order without re-sorting.
  select m.id, m.group_id, m.user_id, u.display_name, u.avatar_url, m.body, m.created_at
  from (
    select * from public.group_messages
    where group_id = p_group
    order by created_at desc, id desc
    limit least(greatest(coalesce(p_limit, 100), 1), 200)
  ) m
  join public.users u on u.id = m.user_id
  order by m.created_at, m.id;
$$;

-- ------------------------------------------------------------ entry points

revoke all on function public.create_group(text) from public, anon, authenticated;
revoke all on function public.rename_group(uuid, text) from public, anon, authenticated;
revoke all on function public.delete_group(uuid) from public, anon, authenticated;
revoke all on function public.invite_to_group(uuid, uuid) from public, anon, authenticated;
revoke all on function public.respond_to_group_invite(uuid, boolean) from public, anon, authenticated;
revoke all on function public.leave_group(uuid) from public, anon, authenticated;
revoke all on function public.remove_group_member(uuid, uuid) from public, anon, authenticated;
revoke all on function public.send_group_message(uuid, text) from public, anon, authenticated;
revoke all on function public.list_groups() from public, anon, authenticated;
revoke all on function public.list_group_members(uuid) from public, anon, authenticated;
revoke all on function public.list_group_invites() from public, anon, authenticated;
revoke all on function public.list_group_messages(uuid, int) from public, anon, authenticated;

grant execute on function public.create_group(text) to authenticated;
grant execute on function public.rename_group(uuid, text) to authenticated;
grant execute on function public.delete_group(uuid) to authenticated;
grant execute on function public.invite_to_group(uuid, uuid) to authenticated;
grant execute on function public.respond_to_group_invite(uuid, boolean) to authenticated;
grant execute on function public.leave_group(uuid) to authenticated;
grant execute on function public.remove_group_member(uuid, uuid) to authenticated;
grant execute on function public.send_group_message(uuid, text) to authenticated;
grant execute on function public.list_groups() to authenticated;
grant execute on function public.list_group_members(uuid) to authenticated;
grant execute on function public.list_group_invites() to authenticated;
grant execute on function public.list_group_messages(uuid, int) to authenticated;

-- Realtime: chat and membership need to reach clients live.
do $$
begin
  if not exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    return;
  end if;
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'group_messages'
  ) then
    alter publication supabase_realtime add table public.group_messages;
  end if;
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'group_members'
  ) then
    alter publication supabase_realtime add table public.group_members;
  end if;
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'group_invites'
  ) then
    alter publication supabase_realtime add table public.group_invites;
  end if;
end;
$$;
