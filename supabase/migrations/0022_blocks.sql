-- ===========================================================================
-- 0022 — Block and unblock
--
-- The safety gate before contextual sessions reach anybody outside controlled
-- testing. See docs/checkpoints/p1b-block-unblock.md.
--
-- WHY THIS CANNOT BE A CLIENT FILTER
--
-- A Stream Room is the connected component of the friendship graph among people
-- present on a destination, walked up to three hops. That is the feature: you
-- can end up in a room with somebody you have never met, because a friend of
-- yours knows them. It is also exactly why Block has to be here rather than in
-- the panel - "do not show me this person" is not the same promise as "do not
-- place us in a room together", and only the server can keep the second one.
--
-- MUTE ALREADY EXISTS AND IS A DIFFERENT THING
--
-- Mute is local, silent and reversible: I do not want to hear you. It never
-- reaches the server, and it stays that way. Block is: I do not want us
-- socially connected through Kickback. It destroys the friendship, refuses new
-- requests, hides presence, and cuts the graph.
--
-- DIRECTIONAL ROW, SYMMETRIC EFFECT
--
-- One row is stored - A blocked B - because only one person made a decision and
-- the other must not be told about it. But EITHER row prohibits connectivity in
-- both directions: `blocked_pair` asks whether a row exists in either
-- direction, and every check below asks that rather than "did I block them".
-- Requiring a reciprocal row would let the blocked party re-establish contact
-- by not blocking back, which is the opposite of what blocking means.
--
-- WHAT THIS DELIBERATELY IS NOT
--
-- It is not Report. Blocking rearranges one user's own social graph; it sends
-- nothing to us and asks nothing of us. A reporting path is a different feature
-- with different obligations and is not built here.
-- ===========================================================================

begin;

-- ------------------------------------------------------------------ table

create table if not exists public.blocks (
  blocker_id uuid        not null references public.users (id) on delete cascade,
  blocked_id uuid        not null references public.users (id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (blocker_id, blocked_id),
  constraint blocks_not_self check (blocker_id <> blocked_id)
);

/*
 * The reverse lookup.
 *
 * Every check below asks "is there a row in EITHER direction", so the
 * blocked_id side is queried exactly as often as the blocker_id side that the
 * primary key already covers.
 */
create index if not exists blocks_blocked_idx on public.blocks (blocked_id);

alter table public.blocks enable row level security;

revoke all on public.blocks from anon, authenticated;
grant select on public.blocks to authenticated;

/*
 * You can see the blocks YOU created. Nothing else.
 *
 * Deliberately not `or blocked_id = auth.uid()`: "who has blocked me" is not a
 * question Kickback answers. The blocked person experiences a friend request
 * that will not go through and a friend who is no longer there - the same thing
 * they would experience if the other person had simply removed them - and the
 * difference between those two is not ours to publish.
 *
 * Every rule that needs the other direction runs inside a SECURITY DEFINER
 * function, which can see the row without handing it to anybody.
 */
drop policy if exists blocks_select on public.blocks;
create policy blocks_select on public.blocks
  for select to authenticated
  using (blocker_id = (select auth.uid()));

-- ---------------------------------------------------------------- the test

/*
 * Is this pair prohibited from being socially connected?
 *
 * The one question the rest of this migration asks. SECURITY DEFINER, so it can
 * see a row the caller may not read - which is what lets the blocked party be
 * refused without being told why.
 */
create or replace function public.blocked_pair(p_a uuid, p_b uuid)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select exists (
    select 1 from public.blocks b
     where (b.blocker_id = p_a and b.blocked_id = p_b)
        or (b.blocker_id = p_b and b.blocked_id = p_a)
  );
$$;

revoke all on function public.blocked_pair(uuid, uuid) from public, anon, authenticated;

/*
 * Not granted to clients, and that is the point.
 *
 * A client that could call this could ask "is there a block between me and X"
 * for any X and learn what the policy above declines to say. Internal callers
 * are SECURITY DEFINER functions, which run as the owner and do not need the
 * grant.
 */

-- ---------------------------------------------------- friendship, re-checked

/*
 * is_friend now refuses a blocked pair.
 *
 * The block transaction deletes the friendship rows, so this is belt and
 * braces - but it is the belt that matters most, because is_friend is the
 * single predicate behind presence visibility, the users policy and the
 * connected-accounts policy. If a friendship row ever survived a block through
 * some path nobody has thought of yet, this is what still keeps presence
 * private.
 *
 * CREATE OR REPLACE with the same signature and return type, so the bundle can
 * re-run: 0002 recreates the original, and this file replaces it again in
 * order.
 */
create or replace function public.is_friend(p_other uuid)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select exists (
    select 1
    from public.friendships f
    where f.user_id = (select auth.uid())
      and f.friend_id = p_other
  )
  and not public.blocked_pair((select auth.uid()), p_other);
$$;

-- --------------------------------------------------------------- the action

drop function if exists public.block_user(uuid);

/*
 * Block somebody, and take the relationship apart in one transaction.
 *
 * Three things have to happen together or not at all: the block exists, the
 * friendship is gone, and no pending request survives to recreate it. Doing
 * them separately would leave a window in which a stale request could be
 * accepted a moment after the block landed.
 *
 * Requests are CANCELLED rather than deleted, so the row keeps saying what
 * happened for whoever sent it, and the partial unique index that allows one
 * live request per direction is freed for a future one after an unblock.
 */
create function public.block_user(p_target uuid)
returns void
language plpgsql
volatile
security definer
set search_path = public, pg_temp
as $fn$
declare
  v_actor uuid := public.require_actor();
  v_first uuid;
  v_second uuid;
begin
  if p_target is null then
    raise exception 'kickback: target required' using errcode = '22023';
  end if;
  if p_target = v_actor then
    raise exception 'kickback: you cannot block yourself' using errcode = '22023';
  end if;
  if not exists (select 1 from public.users u where u.id = p_target) then
    raise exception 'kickback: user not found' using errcode = 'P0002';
  end if;

  -- The same deterministic lock order send_friend_request uses, so blocking and
  -- befriending at the same instant serialise instead of deadlocking.
  v_first := least(v_actor, p_target);
  v_second := greatest(v_actor, p_target);
  perform 1 from public.users where id = v_first for update;
  perform 1 from public.users where id = v_second for update;

  insert into public.blocks (blocker_id, blocked_id)
  values (v_actor, p_target)
  on conflict (blocker_id, blocked_id) do nothing;

  -- Both mirrored rows. link_friendship writes two; this removes two.
  delete from public.friendships
   where (user_id = v_actor and friend_id = p_target)
      or (user_id = p_target and friend_id = v_actor);

  update public.friend_requests
     set status = 'cancelled', responded_at = now()
   where status = 'pending'
     and ((from_user = v_actor and to_user = p_target)
       or (from_user = p_target and to_user = v_actor));
end;
$fn$;

revoke all on function public.block_user(uuid) from public, anon;
grant execute on function public.block_user(uuid) to authenticated;

drop function if exists public.unblock_user(uuid);

/*
 * Unblock, and nothing else.
 *
 * It removes the caller's own block row. It does NOT restore the friendship,
 * revive a cancelled request, or put anybody back in a room - after this, two
 * people are simply two Kickback users who are not blocked. If they want to be
 * friends again, somebody sends a request and the other accepts, exactly as
 * they would have the first time.
 *
 * Deleting only `blocker_id = actor` matters: if both blocked each other, one
 * of them unblocking must not quietly undo the other's decision.
 */
create function public.unblock_user(p_target uuid)
returns void
language plpgsql
volatile
security definer
set search_path = public, pg_temp
as $fn$
declare
  v_actor uuid := public.require_actor();
begin
  if p_target is null then
    raise exception 'kickback: target required' using errcode = '22023';
  end if;

  delete from public.blocks
   where blocker_id = v_actor and blocked_id = p_target;
end;
$fn$;

revoke all on function public.unblock_user(uuid) from public, anon;
grant execute on function public.unblock_user(uuid) to authenticated;

drop function if exists public.list_blocked_users();

/*
 * Who the caller has blocked, so the settings card can offer Unblock.
 *
 * Only the caller's own blocks, and only enough to name somebody: a block you
 * cannot find is a block you cannot undo. Display name and login come from the
 * users table, which the caller may not otherwise be able to read once the
 * friendship is gone - so this is SECURITY DEFINER and deliberately narrow.
 */
create function public.list_blocked_users()
returns table (
  user_id      uuid,
  display_name text,
  avatar_url   text,
  twitch_login text,
  created_at   timestamptz
)
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $fn$
declare
  v_actor uuid := public.require_actor();
begin
  return query
  select u.id, u.display_name, u.avatar_url, ca.platform_login, b.created_at
    from public.blocks b
    join public.users u on u.id = b.blocked_id
    left join public.connected_accounts ca
      on ca.user_id = u.id and ca.platform = 'twitch'
   where b.blocker_id = v_actor
   order by b.created_at desc;
end;
$fn$;

revoke all on function public.list_blocked_users() from public, anon;
grant execute on function public.list_blocked_users() to authenticated;

-- ------------------------------------------------------- requests, refused

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

  /*
   * Either direction refuses, and the message says nothing about which.
   *
   * "not found" would be a lie about a user the searcher can plainly see, and
   * "they blocked you" is precisely the fact this feature exists not to
   * publish. So it is a flat refusal, and it reads the same whether the caller
   * did the blocking or was blocked.
   */
  if public.blocked_pair(v_actor, p_target) then
    raise exception 'kickback: cannot add that user' using errcode = '42501';
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

  /*
   * Re-checked HERE, not only when the request was sent.
   *
   * block_user cancels pending requests, so this should be unreachable - but
   * "should be" is not a security property. A request that was in flight when
   * the block landed, or one resurrected by any future path, must not be able
   * to recreate a friendship the block destroyed. Accepting is the one moment
   * that can do that, so it asks again.
   */
  if p_accept and public.blocked_pair(v_actor, v_req.from_user) then
    update public.friend_requests
       set status = 'cancelled', responded_at = now()
     where id = p_request_id;
    raise exception 'kickback: cannot add that user' using errcode = '42501';
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

-- ------------------------------------------------------- the graph itself

drop function if exists public.stream_room_members(text);

/*
 * The connected component, with block boundaries cut out of the walk.
 *
 * THE PART THAT MATTERS
 *
 * A blocked person is excluded from being TRAVERSED THROUGH, not merely from
 * the result. Filtering the final rows would leave the block decorative: with
 * A ↔ B ↔ C and A blocking B, a walk that stepped through B and then dropped B
 * from the output would still deliver C to A - reachable only through somebody
 * A refused to be connected to.
 *
 * So the predicate sits on the join, and the walk simply stops. Blocking a
 * direct friend also deletes the friendship, so that edge is gone twice over;
 * this is what handles the case where the blocked person was never a friend and
 * there is no row to delete.
 *
 * SEEDED AT THE CALLER, SO IT IS THEIR VIEW
 *
 * With A ↔ B ↔ C and A blocking C, B's own component still contains both A and
 * C - B blocked nobody and has no reason to lose either. What must not happen
 * is A and C reaching each other THROUGH B, and they do not: A's walk refuses
 * to admit C, and C's refuses to admit A. Delivery is a separate, pairwise
 * check at send time, so B knowing both never carries a message across.
 */
create function public.stream_room_members(p_channel text)
returns table (user_id uuid, hops int, via_user_id uuid)
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $fn$
declare
  v_actor   uuid := public.require_actor();
  v_channel text := lower(btrim(coalesce(p_channel, '')));
begin
  if v_channel !~ '^[a-z0-9_]{3,25}$' then
    return;
  end if;

  /*
   * The caller must actually be there.
   *
   * Knowing a channel name grants nothing: this is what stops the function
   * being an oracle for "who is watching X". Arrival is what earns contextual
   * visibility, exactly as clicking JOIN alone does not.
   */
  if not exists (
    select 1
      from public.presence p
     where p.user_id = v_actor
       and p.status = 'online'
       and p.channel = v_channel
       -- The same 90 seconds the client's staleness rule uses. A closed laptop
       -- leaves the room on its own, here as well as on screen.
       and p.last_seen_at > now() - interval '90 seconds'
  ) then
    return;
  end if;

  return query
  with recursive present as (
    -- The candidate set. A user hiding their activity has a null channel by
    -- the time it is written, so they are simply not here.
    select p.user_id as id
      from public.presence p
     where p.status = 'online'
       and p.channel = v_channel
       and p.last_seen_at > now() - interval '90 seconds'
  ),
  walk (id, hops, via, path) as (
    select v_actor, 0, null::uuid, array[v_actor]

    union all

    /*
     * One step along a real friendship edge, into somebody who is also here
     * and is not on either side of a block with the caller.
     *
     * `path` is carried to stop cycles: friendships are mirrored rows, so
     * A → B → A exists on every edge and an unguarded walk would not
     * terminate. Bounded at three hops, which is the product limit and also
     * what keeps this a small query.
     */
    select f.friend_id,
           w.hops + 1,
           case when w.hops = 0 then f.friend_id else w.via end,
           w.path || f.friend_id
      from walk w
      join public.friendships f on f.user_id = w.id
      join present pr          on pr.id = f.friend_id
     where w.hops < 3
       and not (f.friend_id = any(w.path))
       -- The block boundary, on the JOIN: they are not admitted, and because
       -- they are not admitted the walk cannot continue through them either.
       and not public.blocked_pair(v_actor, f.friend_id)
  )
  select w.id,
         min(w.hops)::int as hops,
         -- The connecting friend, from the SHORTEST path to this person. Only
         -- meaningful at two hops; the reader drops it otherwise.
         (array_agg(w.via order by w.hops))[1] as via_user_id
    from walk w
   where w.id <> v_actor
   group by w.id
   order by min(w.hops), w.id
   -- A pathological component must not become a denial of service, and fifty
   -- people have stopped being a room.
   limit 50;
end;
$fn$;

revoke all on function public.stream_room_members(text) from public, anon;
grant execute on function public.stream_room_members(text) to authenticated;

-- ------------------------------------------------ delivery, pairwise checked

/*
 * Why the recipient sets are filtered again, when the walk already was.
 *
 * The walk answers "who is in MY room". Delivery answers "may this message
 * reach that person", and with A ↔ B ↔ C those are different questions: B's
 * component legitimately contains both A and C, so a message from B fans out to
 * both - which is right, because B blocked nobody.
 *
 * What must never happen is A's message reaching C because B is standing
 * between them. A's own walk already refuses to admit C, so the filter below is
 * the second lock on the same door: it is pairwise, against the SENDER, and it
 * does not care how the recipient was found.
 */

drop function if exists public.send_room_message(text, text);

create function public.send_room_message(p_channel text, p_body text)
returns integer
language plpgsql
volatile
security definer
set search_path = public, pg_temp
as $fn$
declare
  v_actor   uuid := public.require_actor();
  v_channel text := lower(btrim(coalesce(p_channel, '')));
  v_body    text := btrim(coalesce(p_body, ''));
  v_sent    integer;
begin
  if v_channel !~ '^[a-z0-9_]{3,25}$' then
    raise exception 'kickback: not a channel' using errcode = '22023';
  end if;

  if length(v_body) = 0 or length(v_body) > 280 then
    raise exception 'kickback: message too long' using errcode = '22023';
  end if;

  if not public.consume_rate_budget('room_message', 20, interval '1 minute') then
    raise exception 'kickback: you are sending messages too quickly' using errcode = '53400';
  end if;

  if not exists (
    select 1
      from public.presence p
     where p.user_id = v_actor
       and p.status = 'online'
       and p.channel = v_channel
       and p.last_seen_at > now() - interval '90 seconds'
  ) then
    raise exception 'kickback: you are not watching that' using errcode = '42501';
  end if;

  insert into public.room_messages (recipient_id, sender_id, channel, body)
  select m.user_id, v_actor, v_channel, v_body
    from public.stream_room_members(v_channel) m
   where not public.blocked_pair(v_actor, m.user_id)
   union all
  select v_actor, v_actor, v_channel, v_body;

  get diagnostics v_sent = row_count;

  delete from public.room_messages
   where recipient_id = v_actor
     and channel = v_channel
     and created_at < now() - interval '30 minutes';

  delete from public.room_messages
   where id in (
     select id
       from public.room_messages
      where recipient_id = v_actor
        and channel = v_channel
      order by created_at desc
      offset 200
   );

  return v_sent;
end;
$fn$;

revoke all on function public.send_room_message(text, text) from public, anon;
grant execute on function public.send_room_message(text, text) to authenticated;

drop function if exists public.send_together_reaction(text, text);

create function public.send_together_reaction(p_channel text, p_reaction text)
returns integer
language plpgsql
volatile
security definer
set search_path = public, pg_temp
as $fn$
declare
  v_actor   uuid := public.require_actor();
  v_channel text := lower(btrim(coalesce(p_channel, '')));
  v_sent    integer;
begin
  if v_channel !~ '^[a-z0-9_]{3,25}$' then
    raise exception 'kickback: not a channel' using errcode = '22023';
  end if;

  if p_reaction not in ('lol', 'heart', 'fire', 'sad', 'eyes') then
    raise exception 'kickback: not a reaction' using errcode = '22023';
  end if;

  if not public.consume_rate_budget('together_reaction', 60, interval '1 minute') then
    raise exception 'kickback: you are reacting too quickly' using errcode = '53400';
  end if;

  if not exists (
    select 1
      from public.presence p
     where p.user_id = v_actor
       and p.status = 'online'
       and p.channel = v_channel
       and p.last_seen_at > now() - interval '90 seconds'
  ) then
    raise exception 'kickback: you are not watching that' using errcode = '42501';
  end if;

  /*
   * The same pairwise filter the conversation gets.
   *
   * A blocked person's reaction must not reach the other's screen, and - since
   * the combo engine counts what arrives - must not reach their combo either.
   * Filtering the recipient set is what makes that true; a client-side filter
   * would leave the count wrong for anybody running a modified panel.
   */
  insert into public.together_reactions (recipient_id, sender_id, channel, reaction)
  select m.user_id, v_actor, v_channel, p_reaction
    from public.stream_room_members(v_channel) m
   where not public.blocked_pair(v_actor, m.user_id)
   union all
  select v_actor, v_actor, v_channel, p_reaction;

  get diagnostics v_sent = row_count;

  delete from public.together_reactions
   where recipient_id = v_actor
     and created_at < now() - interval '1 minute';

  return v_sent;
end;
$fn$;

revoke all on function public.send_together_reaction(text, text) from public, anon;
grant execute on function public.send_together_reaction(text, text) to authenticated;

-- ------------------------------------------------------------- discovery

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
           /*
            * 'blocked' means "I blocked them", and only the blocker ever sees
            * it. Somebody the OTHER person blocked falls through to 'none' -
            * an ordinary-looking result whose Add button will be refused by
            * the server. That refusal is deliberately indistinguishable from
            * any other failure: the alternative is a search result that
            * announces "this person blocked you", which is the one thing this
            * feature exists not to say.
            */
           when exists (select 1 from public.blocks b
                        where b.blocker_id = v_actor and b.blocked_id = m.id) then 'blocked'
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

-- ------------------------------------------------------------------ groups
--
-- Groups are the one place where two people can be socially connected without
-- a friendship, so a block that only understood friendships would leave a door
-- open: A blocks B, and B goes on seeing A's presence and A's chat because
-- they happen to share a group.
--
-- WHAT IS CHANGED HERE, AND WHAT IS NOT
--
-- Membership is not touched. Neither of them is removed from the group, no
-- group is dissolved, no owner loses anything. Rewriting how groups work is not
-- what this checkpoint is for, and a block silently deleting somebody from a
-- named space they chose to join would be a much larger promise than the one
-- the confirmation makes.
--
-- What changes is what group co-membership GRANTS. Today it grants three
-- things: seeing each other's identity and presence, receiving each other's
-- group chat, and being invitable. All three now stop at a block, in both
-- directions, while the group itself carries on for everybody else.
--
-- The result is a group whose member list and transcript have a hole in them,
-- but only for the pair involved. That is the same shape every other surface
-- takes after a block, and it is the smallest thing that can be said to work:
-- a block that held everywhere except inside groups would not be a block.

/*
 * Group co-membership, minus anyone in a blocked pair.
 *
 * Same one-line addition `is_friend` took, for the same reason - this is the
 * other function the presence and identity policies consult, and leaving it
 * alone would mean the block held for friends and failed for group-mates.
 */
create or replace function public.shares_group_with(p_other uuid)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select exists (
    select 1
    from public.group_members mine
    join public.group_members theirs on theirs.group_id = mine.group_id
    where mine.user_id = (select auth.uid())
      and theirs.user_id = p_other
  )
  and not public.blocked_pair((select auth.uid()), p_other);
$$;

/*
 * Whether one group message is visible to the caller.
 *
 * A wrapper rather than an inline predicate because RLS expressions are
 * evaluated as the querying user, and `blocked_pair` is not granted to
 * clients - that is what keeps "has this person blocked me" unanswerable. The
 * definer wrapper lets the policy consult it without handing it out.
 *
 * In the policy rather than only in `list_group_messages`, because that reader
 * is not the only delivery path: group chat also arrives over realtime, which
 * applies the raw row. A filter that lived only in the reader would hold on
 * reload and fail live, which is the worse of the two failures.
 */
create or replace function public.group_message_visible(p_group uuid, p_sender uuid)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select public.is_group_member(p_group)
     and not public.blocked_pair((select auth.uid()), p_sender);
$$;

revoke all on function public.group_message_visible(uuid, uuid) from public, anon, authenticated;
grant execute on function public.group_message_visible(uuid, uuid) to authenticated;

drop policy if exists group_messages_select on public.group_messages;
create policy group_messages_select on public.group_messages
  for select to authenticated
  using (public.group_message_visible(group_id, user_id));

/*
 * An invitation cannot route around a block.
 *
 * Without this, an owner who had been blocked could pull the person who
 * blocked them into a group and get the connection back. The message is the
 * same generic one `send_friend_request` raises, and for the same reason: it
 * must not distinguish "you blocked them" from "they blocked you".
 */
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
  if public.blocked_pair(v_actor, p_target) then
    raise exception 'kickback: cannot invite that user' using errcode = '42501';
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

-- --------------------------------------------------- the analytics contract
--
-- Two events, and no properties beyond the fact that it happened.
--
-- Deliberately NOT recorded: who was blocked, in any form. A user id, a login
-- or a display name would each turn this table into a record of who dislikes
-- whom, which is a far more sensitive thing than anything else Kickback keeps -
-- and it answers no question we have. What is worth knowing is whether people
-- need this at all, and a bare count answers that.
--
-- There is no `reason`. That would be Report, which is a different feature with
-- different obligations and is not built here.

insert into public.analytics_event_names (name, description, allowed_properties) values
  ('user_blocked',
   'Somebody blocked another user. No identifiers of either party beyond the acting session.',
   array[]::text[]),

  ('user_unblocked',
   'Somebody removed a block they had created.',
   array[]::text[])
on conflict (name) do update
  set description        = excluded.description,
      allowed_properties = excluded.allowed_properties;

commit;
