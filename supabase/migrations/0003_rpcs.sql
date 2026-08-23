-- Kickback Phase 1 — 0003: the RPC layer
--
-- Every mutation lives here. Two rules hold without exception:
--
--   * The actor is always `auth.uid()`. No function accepts an actor id, so a
--     client cannot forge one — there is no parameter to forge.
--   * Mutations are SECURITY DEFINER (they must write through the revokes in
--     0002); read helpers are SECURITY INVOKER so RLS still applies to them as
--     a second line of defence.

-- ------------------------------------------------------------------ guards

create or replace function public.require_actor()
returns uuid
language plpgsql
stable
set search_path = public, pg_temp
as $$
declare
  v_actor uuid := (select auth.uid());
begin
  if v_actor is null then
    raise exception 'kickback: not authenticated' using errcode = '28000';
  end if;
  return v_actor;
end;
$$;

-- Internal only. The single place allowed to create the mirrored pair, so the
-- two-row invariant cannot be half-applied: both rows land in one statement.
create or replace function public.create_friendship(p_a uuid, p_b uuid)
returns void
language sql
volatile
security definer
set search_path = public, pg_temp
as $$
  insert into public.friendships (user_id, friend_id)
  values (p_a, p_b), (p_b, p_a)
  on conflict (user_id, friend_id) do nothing;
$$;

-- ---------------------------------------------------------------- presence

-- Report what the local user is doing. The caller's own privacy setting is
-- applied here, server-side, before anything is persisted.
create or replace function public.report_presence(p_platform text, p_channel text)
returns void
language plpgsql
volatile
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor    uuid := public.require_actor();
  v_mode     text;
  v_platform text := nullif(btrim(coalesce(p_platform, '')), '');
  v_channel  text := nullif(lower(btrim(coalesce(p_channel, ''))), '');
begin
  if v_platform is not null and v_platform <> 'twitch' then
    raise exception 'kickback: unsupported platform %', v_platform using errcode = '22023';
  end if;

  if v_channel is not null then
    if v_channel !~ '^[a-z0-9_]{1,25}$' then
      raise exception 'kickback: invalid channel' using errcode = '22023';
    end if;
    if v_platform is null then
      raise exception 'kickback: channel requires a platform' using errcode = '22023';
    end if;
  end if;

  select up.presence_visibility into v_mode
  from public.user_preferences up
  where up.user_id = v_actor;
  v_mode := coalesce(v_mode, 'visible');

  if v_mode = 'invisible' then
    -- Appear exactly as if offline. Crucially the timestamps are only touched
    -- when the row is not already blank: a friend watching last_seen_at tick
    -- upward could otherwise infer "online but hiding".
    update public.presence
       set status = 'offline', platform = null, channel = null,
           updated_at = now(), last_seen_at = now()
     where user_id = v_actor
       and (status <> 'offline' or platform is not null or channel is not null);
    return;
  end if;

  if v_mode = 'hide_activity' then
    v_platform := null;
    v_channel := null;
  end if;

  insert into public.presence (user_id, status, platform, channel, last_seen_at, updated_at)
  values (v_actor, 'online', v_platform, v_channel, now(), now())
  on conflict (user_id) do update
    set status = 'online',
        platform = excluded.platform,
        channel = excluded.channel,
        last_seen_at = now(),
        updated_at = now();
end;
$$;

-- Cheap keepalive that never changes what you are doing.
create or replace function public.heartbeat()
returns void
language plpgsql
volatile
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor uuid := public.require_actor();
begin
  update public.presence
     set last_seen_at = now()
   where user_id = v_actor
     and status = 'online';
end;
$$;

create or replace function public.report_offline()
returns void
language plpgsql
volatile
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor uuid := public.require_actor();
begin
  update public.presence
     set status = 'offline', platform = null, channel = null,
         updated_at = now(), last_seen_at = now()
   where user_id = v_actor
     and (status <> 'offline' or platform is not null or channel is not null);
end;
$$;

create or replace function public.set_presence_visibility(p_mode text)
returns text
language plpgsql
volatile
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor uuid := public.require_actor();
begin
  if p_mode is null or p_mode not in ('visible', 'hide_activity', 'invisible') then
    raise exception 'kickback: invalid presence visibility' using errcode = '22023';
  end if;

  insert into public.user_preferences (user_id, presence_visibility, updated_at)
  values (v_actor, p_mode, now())
  on conflict (user_id) do update
    set presence_visibility = excluded.presence_visibility, updated_at = now();

  -- Tightening privacy must take effect immediately, not at the next heartbeat.
  if p_mode = 'invisible' then
    update public.presence
       set status = 'offline', platform = null, channel = null,
           updated_at = now(), last_seen_at = now()
     where user_id = v_actor
       and (status <> 'offline' or platform is not null or channel is not null);
  elsif p_mode = 'hide_activity' then
    update public.presence
       set platform = null, channel = null, updated_at = now()
     where user_id = v_actor
       and (platform is not null or channel is not null);
  end if;

  -- Loosening privacy cannot restore activity: the raw value was never stored.
  -- The client re-reports on the next tick.
  return p_mode;
end;
$$;

-- ----------------------------------------------------------------- friends

-- Returns one of: requested | friends | already_friends | already_requested
create or replace function public.send_friend_request(p_target uuid)
returns text
language plpgsql
volatile
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor uuid := public.require_actor();
  v_first uuid;
  v_second uuid;
begin
  if p_target is null then
    raise exception 'kickback: target required' using errcode = '22023';
  end if;
  if p_target = v_actor then
    raise exception 'kickback: you cannot add yourself' using errcode = '22023';
  end if;
  if not exists (select 1 from public.users u where u.id = p_target) then
    raise exception 'kickback: user not found' using errcode = 'P0002';
  end if;

  -- Lock both users in a deterministic order so two people pressing Add at the
  -- same instant serialise into one friendship rather than deadlocking.
  v_first := least(v_actor, p_target);
  v_second := greatest(v_actor, p_target);
  perform 1 from public.users where id = v_first for update;
  perform 1 from public.users where id = v_second for update;

  if exists (
    select 1 from public.friendships f
    where f.user_id = v_actor and f.friend_id = p_target
  ) then
    return 'already_friends';
  end if;

  -- Mutual intent: they already asked us, so this is an acceptance, not a
  -- second request. Resolve it atomically instead of leaving two pending rows.
  update public.friend_requests
     set status = 'accepted', responded_at = now()
   where from_user = p_target
     and to_user = v_actor
     and status = 'pending';

  if found then
    perform public.create_friendship(v_actor, p_target);
    return 'friends';
  end if;

  if exists (
    select 1 from public.friend_requests r
    where r.from_user = v_actor and r.to_user = p_target and r.status = 'pending'
  ) then
    return 'already_requested';
  end if;

  insert into public.friend_requests (from_user, to_user) values (v_actor, p_target);
  return 'requested';
end;
$$;

-- Returns 'accepted' or 'declined'.
create or replace function public.respond_to_friend_request(p_request_id uuid, p_accept boolean)
returns text
language plpgsql
volatile
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor uuid := public.require_actor();
  v_req   public.friend_requests%rowtype;
begin
  select * into v_req
  from public.friend_requests
  where id = p_request_id
  for update;

  -- One message for "does not exist" and for "not addressed to you", so this
  -- cannot be used to probe whether a given request id exists.
  if not found or v_req.to_user <> v_actor then
    raise exception 'kickback: friend request not found' using errcode = 'P0002';
  end if;
  if v_req.status <> 'pending' then
    raise exception 'kickback: friend request already resolved' using errcode = '22023';
  end if;

  if p_accept then
    update public.friend_requests
       set status = 'accepted', responded_at = now()
     where id = p_request_id;
    perform public.create_friendship(v_req.from_user, v_req.to_user);
    return 'accepted';
  end if;

  update public.friend_requests
     set status = 'declined', responded_at = now()
   where id = p_request_id;
  return 'declined';
end;
$$;

create or replace function public.cancel_friend_request(p_request_id uuid)
returns text
language plpgsql
volatile
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor uuid := public.require_actor();
  v_req   public.friend_requests%rowtype;
begin
  select * into v_req
  from public.friend_requests
  where id = p_request_id
  for update;

  if not found or v_req.from_user <> v_actor then
    raise exception 'kickback: friend request not found' using errcode = 'P0002';
  end if;
  if v_req.status <> 'pending' then
    raise exception 'kickback: friend request already resolved' using errcode = '22023';
  end if;

  update public.friend_requests
     set status = 'cancelled', responded_at = now()
   where id = p_request_id;
  return 'cancelled';
end;
$$;

-- Friendship is mutual, so removal is mutual: both mirrored rows go.
create or replace function public.remove_friend(p_other uuid)
returns boolean
language plpgsql
volatile
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor uuid := public.require_actor();
  v_removed int;
begin
  delete from public.friendships
   where (user_id = v_actor and friend_id = p_other)
      or (user_id = p_other and friend_id = v_actor);
  get diagnostics v_removed = row_count;
  return v_removed > 0;
end;
$$;

-- -------------------------------------------------------------- discovery

-- Searches Kickback users only. Never reveals Twitch accounts that have not
-- joined, and never returns anyone else's friend code.
create or replace function public.search_users(p_query text)
returns table (
  user_id      uuid,
  display_name text,
  avatar_url   text,
  twitch_login text,
  relationship text,
  matched_by   text
)
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor uuid := public.require_actor();
  v_raw   text := btrim(coalesce(p_query, ''));
  v_code  text := upper(v_raw);
  v_login text := lower(v_raw);
  v_prefix text;
begin
  if char_length(v_raw) < 2 then
    return;
  end if;

  -- Underscore is legal in Twitch logins and is also a LIKE wildcard, so escape
  -- the pattern rather than letting "a_b" quietly match "axb".
  v_prefix := replace(replace(v_login, '\', '\\'), '_', '\_') || '%';

  return query
  with matches as (
    select u.id, u.display_name, u.avatar_url, ca.platform_login,
           case when u.friend_code = v_code then 'friend_code' else 'twitch_login' end as how
    from public.users u
    left join public.connected_accounts ca
      on ca.user_id = u.id and ca.platform = 'twitch'
    where u.friend_code = v_code
       or (ca.platform_login is not null and ca.platform_login like v_prefix)
    order by (u.friend_code = v_code) desc, ca.platform_login
    limit 10
  )
  select m.id,
         m.display_name,
         m.avatar_url,
         m.platform_login,
         case
           when m.id = v_actor then 'self'
           when exists (select 1 from public.friendships f
                        where f.user_id = v_actor and f.friend_id = m.id) then 'friend'
           when exists (select 1 from public.friend_requests r
                        where r.from_user = v_actor and r.to_user = m.id
                          and r.status = 'pending') then 'request_sent'
           when exists (select 1 from public.friend_requests r
                        where r.to_user = v_actor and r.from_user = m.id
                          and r.status = 'pending') then 'request_received'
           else 'none'
         end,
         m.how
  from matches m;
end;
$$;

-- ------------------------------------------------------------------ reads
--
-- SECURITY INVOKER: these run as the caller, so RLS applies on top of the
-- explicit auth.uid() scoping. Both layers must agree.

create or replace function public.me()
returns table (
  user_id             uuid,
  display_name        text,
  avatar_url          text,
  twitch_login        text,
  friend_code         text,
  presence_visibility text,
  created_at          timestamptz
)
language sql
stable
security invoker
set search_path = public, pg_temp
as $$
  select u.id, u.display_name, u.avatar_url, ca.platform_login, u.friend_code,
         coalesce(up.presence_visibility, 'visible'), u.created_at
  from public.users u
  left join public.connected_accounts ca on ca.user_id = u.id and ca.platform = 'twitch'
  left join public.user_preferences up on up.user_id = u.id
  where u.id = (select auth.uid());
$$;

create or replace function public.list_friends()
returns table (
  user_id      uuid,
  display_name text,
  avatar_url   text,
  twitch_login text,
  status       text,
  platform     text,
  channel      text,
  last_seen_at timestamptz
)
language sql
stable
security invoker
set search_path = public, pg_temp
as $$
  select u.id, u.display_name, u.avatar_url, ca.platform_login,
         coalesce(p.status, 'offline'), p.platform, p.channel, p.last_seen_at
  from public.friendships f
  join public.users u on u.id = f.friend_id
  left join public.connected_accounts ca on ca.user_id = u.id and ca.platform = 'twitch'
  left join public.presence p on p.user_id = u.id
  where f.user_id = (select auth.uid())
  order by u.display_name;
$$;

create or replace function public.list_friend_requests()
returns table (
  request_id   uuid,
  direction    text,
  user_id      uuid,
  display_name text,
  avatar_url   text,
  twitch_login text,
  created_at   timestamptz
)
language sql
stable
security invoker
set search_path = public, pg_temp
as $$
  select r.id,
         case when r.to_user = (select auth.uid()) then 'incoming' else 'outgoing' end,
         other.id, other.display_name, other.avatar_url, ca.platform_login, r.created_at
  from public.friend_requests r
  join public.users other
    on other.id = case when r.to_user = (select auth.uid()) then r.from_user else r.to_user end
  left join public.connected_accounts ca on ca.user_id = other.id and ca.platform = 'twitch'
  where r.status = 'pending'
    and (r.from_user = (select auth.uid()) or r.to_user = (select auth.uid()))
  order by r.created_at desc;
$$;

-- ------------------------------------------------------------ entry points
--
-- Supabase grants EXECUTE on new functions to anon and authenticated by
-- default. Revoke everything, then re-grant only the intended API surface.
-- require_actor / create_friendship / generate_friend_code stay internal.

revoke all on all functions in schema public from public, anon, authenticated;

grant execute on function public.is_friend(uuid)                          to authenticated;
grant execute on function public.has_open_request_with(uuid)              to authenticated;
grant execute on function public.report_presence(text, text)              to authenticated;
grant execute on function public.heartbeat()                              to authenticated;
grant execute on function public.report_offline()                         to authenticated;
grant execute on function public.set_presence_visibility(text)            to authenticated;
grant execute on function public.send_friend_request(uuid)                to authenticated;
grant execute on function public.respond_to_friend_request(uuid, boolean) to authenticated;
grant execute on function public.cancel_friend_request(uuid)              to authenticated;
grant execute on function public.remove_friend(uuid)                      to authenticated;
grant execute on function public.search_users(text)                       to authenticated;
grant execute on function public.me()                                     to authenticated;
grant execute on function public.list_friends()                           to authenticated;
grant execute on function public.list_friend_requests()                   to authenticated;
