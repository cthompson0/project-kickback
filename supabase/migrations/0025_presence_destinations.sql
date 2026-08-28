-- ===========================================================================
-- 0025 — Multi-destination presence
--
-- Presence stops being "the one channel you are on" and becomes "the streams
-- you have open". See docs/reports/multi-stream-room-architecture-2026-08-27.md
-- for the approved design and why it is shaped this way.
--
-- WHAT THIS CHANGES, AND WHAT IT DELIBERATELY DOES NOT
--
-- public.presence keeps its job: account LIVENESS. status, last_seen_at, the
-- 45-second heartbeat and the 90-second staleness window are untouched. Its
-- `channel` and `platform` columns are ALSO untouched and are still written -
-- they are what a v0.4.1 client reads through list_friends(), and that client
-- will still be installed while the Chrome Web Store rolls the next one out.
--
-- What is new is a child table: which destinations this account has open, and
-- when each was last looked at. Nothing here infers attention. There is no
-- focused-tab column, no weight, no score, and no way to express one.
--
-- THE ONE PREDICATE
--
-- Every question of the form "is this person present at this channel" now goes
-- through public.is_present_at(user, channel). It exists so that the parent
-- liveness gate cannot be forgotten at a call site: liveness is the OUTER
-- condition, and a destination row can only ever narrow it.
--
--   If Chrome crashes, the laptop sleeps, the worker dies or the network goes,
--   public.presence goes stale after ninety seconds - and at that moment every
--   destination for that account becomes invisible, however recent its own
--   last_active_at is. An orphaned child row cannot leak presence, because it
--   is never consulted on its own.
--
-- That is the property the architecture review called critical, and it is
-- enforced structurally here rather than by remembering to check twice.
--
-- COMPATIBILITY IS THE WHOLE REASON THIS IS ADDITIVE
--
-- Nothing is dropped. No column is removed, no function deleted, no policy
-- narrowed. report_presence() still works and now also maintains a single
-- destination row, so a v0.4.1 client publishes a singleton set without
-- knowing this table exists. is_present_at() accepts EITHER a destination row
-- or the legacy presence.channel, so old and new clients are mutually visible
-- and can share a Stream Room.
--
-- The cleanup - dropping presence.channel and the legacy branch - is a later
-- migration, and only after every tester is confirmed upgraded.
-- ===========================================================================

begin;

-- ------------------------------------------------------------------- table
--
-- One row per (person, destination). The primary key is what makes duplicate
-- browser tabs on the same stream collapse to one destination for free: the
-- client reports a SET, and two tabs on shroud are one member of it.

create table if not exists public.presence_destinations (
  user_id        uuid not null references public.users (id) on delete cascade,
  -- The same canonical lowercase login presence, Gravity, JOIN, rooms,
  -- reactions and analytics all use. Same bound as presence.channel, so a
  -- legacy value can always be represented here.
  channel        text not null check (channel ~ '^[a-z0-9_]{1,25}$'),
  platform       text not null default 'twitch' check (platform in ('twitch')),
  /*
   * When this destination was first opened.
   *
   * Stable for the life of the destination, which is what makes it safe for
   * the client to order room tabs by: a tab strip that re-orders itself while
   * somebody is reaching for a tab is worse than one in an arbitrary order.
   * Deliberately NOT touched by activity.
   */
  opened_at      timestamptz not null default now(),
  /*
   * The only clock in the destination model.
   *
   * Refreshed when the destination opens, when a tab navigates to it, and at
   * most occasionally while it is genuinely being used. A destination is
   * ACTIVE while this is within thirty minutes - a rule every reader applies
   * for itself, exactly as PRESENCE_STALE_MS is applied to last_seen_at. No
   * write marks a destination stale.
   */
  last_active_at timestamptz not null default now(),
  primary key (user_id, channel)
);

/*
 * "Who is on this channel" is the hot question - stream_room_members asks it
 * on every room refresh - so it gets the index rather than relying on the PK.
 */
create index if not exists presence_destinations_channel_idx
  on public.presence_destinations (channel, last_active_at desc);

alter table public.presence_destinations enable row level security;

-- Same posture as every other table: clients read, and only SECURITY DEFINER
-- functions write. Supabase's default privileges grant DML automatically, so
-- this revoke is load-bearing rather than decorative.
revoke all on public.presence_destinations from anon, authenticated;
grant select on public.presence_destinations to authenticated;

-- ------------------------------------------------------------- the predicate
--
-- One function, so the liveness gate exists once.

create or replace function public.is_present_at(p_user uuid, p_channel text)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select exists (
    /*
     * Liveness FIRST, and structurally.
     *
     * Everything about a destination is an inner condition on a live account.
     * A crashed browser leaves rows behind; ninety seconds later this returns
     * false for every one of them, which is the entire point.
     */
    select 1
      from public.presence p
     where p.user_id = p_user
       and p.status = 'online'
       and p.last_seen_at > now() - interval '90 seconds'
       and (
         exists (
           select 1
             from public.presence_destinations d
            where d.user_id = p_user
              and d.channel = p_channel
              -- Thirty minutes: the same window room messages are retained
              -- for, deliberately, so a destination and its conversation
              -- expire together.
              and d.last_active_at > now() - interval '30 minutes'
         )
         /*
          * The compatibility branch.
          *
          * A v0.4.1 client writes presence.channel and knows nothing about
          * this table. Accepting it here is what lets an old and a new client
          * see each other and share a room during the Store rollout. It is
          * removed by the cleanup migration, not by this one.
          */
         or p.channel = p_channel
       )
  );
$$;

revoke all on function public.is_present_at(uuid, text) from public, anon, authenticated;
-- Policies below are evaluated as the caller, so the caller must be able to
-- execute it.
grant execute on function public.is_present_at(uuid, text) to authenticated;

-- ------------------------------------------------------------------ policy
--
-- Who may see somebody's destinations is exactly who may see their presence -
-- and the block predicates already live inside is_friend and
-- shares_group_with, so this inherits them rather than restating them.
--
-- The liveness and activity gates are IN THE POLICY as well as in
-- is_present_at, so a direct table read cannot see an orphaned or expired row
-- either. There is no way to reach this table that skips the gate.

drop policy if exists presence_destinations_select on public.presence_destinations;
create policy presence_destinations_select on public.presence_destinations
  for select to authenticated
  using (
    (
      user_id = (select auth.uid())
      or public.is_friend(user_id)
      or public.shares_group_with(user_id)
    )
    and last_active_at > now() - interval '30 minutes'
    and exists (
      select 1
        from public.presence p
       where p.user_id = presence_destinations.user_id
         and p.status = 'online'
         and p.last_seen_at > now() - interval '90 seconds'
    )
  );

-- ------------------------------------------------------------------ writes
--
-- One internal helper both the new RPC and the legacy shim call, so there is
-- one place that decides what a published set means.

/*
 * Replace this account's published destinations with p_channels.
 *
 * Returns how many were published, after validation and the cap.
 *
 * THE CAP IS ENFORCED HERE, NOT IN THE CLIENT
 *
 * Three, most-recently-active first, which is the order the client sends. A
 * modified extension cannot inflate its own Gravity by publishing twenty
 * destinations, because everything past the third is discarded server-side.
 *
 * NOT rate-limited or visibility-checked here: both callers do that first, and
 * doing it twice would charge a legacy client's single write two budget units.
 */
/*
 * Dropped by its exact signature before being created.
 *
 * CREATE OR REPLACE cannot change a function's return type (42P13), and this
 * one returns the kept set rather than a count. The bundle is applied in full
 * on every deploy, so without this a database that had seen an earlier shape
 * would fail here rather than upgrade.
 */
drop function if exists public.apply_destinations(uuid, text[]);

create function public.apply_destinations(p_actor uuid, p_channels text[])
returns text[]
language plpgsql
volatile
security definer
set search_path = public, pg_temp
as $$
declare
  v_clean text[] := '{}';
  v_channel text;
begin
  /*
   * Validate, lowercase, de-duplicate, then cap.
   *
   * De-duplication before the cap matters: two tabs on the same stream must
   * not consume two of the three slots.
   */
  foreach v_channel in array coalesce(p_channels, '{}'::text[]) loop
    v_channel := lower(btrim(coalesce(v_channel, '')));
    continue when v_channel !~ '^[a-z0-9_]{1,25}$';
    continue when v_channel = any(v_clean);
    v_clean := v_clean || v_channel;
    exit when array_length(v_clean, 1) >= 3;
  end loop;

  /*
   * Upsert, then delete what is no longer open.
   *
   * opened_at is preserved on conflict - a destination that stays open keeps
   * the moment it opened, which is what the client orders room tabs by.
   */
  if array_length(v_clean, 1) > 0 then
    insert into public.presence_destinations (user_id, channel, platform, opened_at, last_active_at)
    select p_actor, c, 'twitch', now(), now()
      from unnest(v_clean) as c
    on conflict (user_id, channel) do update
      set last_active_at = now();
  end if;

  delete from public.presence_destinations d
   where d.user_id = p_actor
     and not (d.channel = any(v_clean));

  /*
   * The CLEAN, ORDERED set is returned rather than a count.
   *
   * The caller needs both the size and the primary, and the primary is
   * position one - the client's most-recently-active. It cannot be recovered
   * from the table afterwards: every row in one publish shares the same
   * last_active_at, so ordering by it ties and any tie-break is arbitrary.
   * Returning the array is what keeps "primary" meaning what the client said.
   */
  return v_clean;
end;
$$;

revoke all on function public.apply_destinations(uuid, text[]) from public, anon, authenticated;

/*
 * What a multi-destination client calls.
 *
 * The channels arrive most-recently-active first. Everything else - who the
 * actor is, whether they may publish at all, how many survive - is decided
 * here, because a client is not a trusted caller of anything.
 */
create or replace function public.report_destinations(p_channels text[])
returns int
language plpgsql
volatile
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor uuid := public.require_actor();
  v_mode  text;
  v_kept  text[];
begin
  -- One budget unit per call, shared with report_presence: a client cannot
  -- get more writes by alternating between the two entry points.
  if not public.consume_presence_budget() then
    raise exception 'kickback: presence rate limit exceeded' using errcode = '53400';
  end if;

  select up.presence_visibility into v_mode
  from public.user_preferences up
  where up.user_id = v_actor;
  v_mode := coalesce(v_mode, 'visible');

  /*
   * Redaction at WRITE time, exactly as report_presence does it.
   *
   * "Hide my activity" is expressed as publishing no destinations at all,
   * which is a great deal simpler than filtering on read and cannot be got
   * wrong by a reader. Invisible additionally blanks the liveness row, and
   * only when it is not already blank - a friend watching last_seen_at tick
   * upward could otherwise infer "online but hiding".
   */
  if v_mode = 'invisible' then
    perform public.apply_destinations(v_actor, '{}'::text[]);
    update public.presence
       set status = 'offline', platform = null, channel = null,
           updated_at = now(), last_seen_at = now()
     where user_id = v_actor
       and (status <> 'offline' or platform is not null or channel is not null);
    return 0;
  end if;

  if v_mode = 'hide_activity' then
    -- Online, and nowhere in particular.
    insert into public.presence (user_id, status, platform, channel, last_seen_at, updated_at)
    values (v_actor, 'online', null, null, now(), now())
    on conflict (user_id) do update
      set status = 'online', platform = null, channel = null,
          last_seen_at = now(), updated_at = now();
    perform public.apply_destinations(v_actor, '{}'::text[]);
    return 0;
  end if;

  v_kept := public.apply_destinations(v_actor, p_channels);

  /*
   * The legacy singleton, kept in step.
   *
   * presence.channel becomes the PRIMARY destination - the first one the
   * client sent, which is its most recently active. A v0.4.1 client reading
   * list_friends() therefore sees something true and useful rather than
   * nothing, for the whole of the rollout.
   */
  insert into public.presence (user_id, status, platform, channel, last_seen_at, updated_at)
  values (
    v_actor,
    'online',
    case when array_length(v_kept, 1) > 0 then 'twitch' else null end,
    -- Position one: the client sends most-recently-active first, so this is
    -- the primary. Not re-derived from the table, which cannot answer it.
    v_kept[1],
    now(),
    now()
  )
  on conflict (user_id) do update
    set status = 'online',
        platform = excluded.platform,
        channel = excluded.channel,
        last_seen_at = now(),
        updated_at = now();

  return coalesce(array_length(v_kept, 1), 0);
end;
$$;

revoke all on function public.report_destinations(text[]) from public, anon;
grant execute on function public.report_destinations(text[]) to authenticated;

-- ------------------------------------------------------- the legacy shim
--
-- Unchanged behaviour for a v0.4.1 client, plus the child row it does not know
-- to write. Its singleton becomes a one-element destination set, so it is
-- visible to new clients, can be found by stream_room_members, and appears in
-- multi-destination Gravity like anybody else.

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

  if not public.consume_presence_budget() then
    raise exception 'kickback: presence rate limit exceeded' using errcode = '53400';
  end if;

  select up.presence_visibility into v_mode
  from public.user_preferences up
  where up.user_id = v_actor;
  v_mode := coalesce(v_mode, 'visible');

  if v_mode = 'invisible' then
    -- Appear exactly as if offline. Crucially the timestamps are only touched
    -- when the row is not already blank: a friend watching last_seen_at tick
    -- upward could otherwise infer "online but hiding".
    perform public.apply_destinations(v_actor, '{}'::text[]);
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

  /*
   * The singleton, mirrored into the destination table.
   *
   * This is the whole of the compatibility story on the write side: an old
   * client keeps calling exactly what it always called, and the multi-
   * destination world sees it correctly without the client changing.
   */
  perform public.apply_destinations(
    v_actor,
    case when v_channel is null then '{}'::text[] else array[v_channel] end
  );

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

revoke all on function public.report_presence(text, text) from public, anon;
grant execute on function public.report_presence(text, text) to authenticated;

-- --------------------------------------------------------------- sign out
--
-- report_offline already blanks the liveness row. It must also drop the
-- destinations: parent gating would hide them anyway, but leaving a signed-out
-- account's rows behind to be protected by a second mechanism is not a posture
-- worth having.

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
  delete from public.presence_destinations where user_id = v_actor;

  update public.presence
     set status = 'offline', platform = null, channel = null,
         last_seen_at = now(), updated_at = now()
   where user_id = v_actor;
end;
$$;

revoke all on function public.report_offline() from public, anon;
grant execute on function public.report_offline() to authenticated;

-- ------------------------------------------------------------------- read
--
-- The minimum new surface. list_friends() is deliberately untouched: it still
-- returns one channel per friend, which is what a v0.4.1 client expects and
-- what this migration keeps true.

create or replace function public.list_friend_destinations()
returns table (
  user_id        uuid,
  channel        text,
  opened_at      timestamptz,
  last_active_at timestamptz
)
language sql
stable
security invoker
set search_path = public, pg_temp
as $$
  /*
   * SECURITY INVOKER, so the policy above does the authorization - the same
   * shape list_friends uses. The explicit scoping below is about returning
   * the right rows, not about who may see them.
   *
   * Note what is NOT here: any way to ask about a CHANNEL. This function is
   * seeded at the caller's own social graph, so it cannot become a directory
   * of who is watching X. Arrival is what earns contextual visibility, and
   * stream_room_members remains the only channel-seeded entry point.
   */
  select d.user_id, d.channel, d.opened_at, d.last_active_at
    from public.presence_destinations d
   where d.user_id <> (select auth.uid())
     and (public.is_friend(d.user_id) or public.shares_group_with(d.user_id))
   order by d.user_id, d.last_active_at desc;
$$;

revoke all on function public.list_friend_destinations() from public, anon;
grant execute on function public.list_friend_destinations() to authenticated;

-- ------------------------------------------------- rooms, reactions, walk
--
-- The presence predicate widens; nothing else about the security model moves.
-- The friendship walk, the block-on-the-join, the three-hop bound, the cycle
-- guard and the fifty-member cap are all exactly as 0022 left them.

drop function if exists public.stream_room_members(text);

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
   * visibility, exactly as clicking JOIN alone does not. is_present_at carries
   * the parent liveness gate, so a crashed browser leaves the room on its own.
   */
  if not public.is_present_at(v_actor, v_channel) then
    return;
  end if;

  return query
  with recursive present as (
    /*
     * The candidate set, now destination-aware.
     *
     * Liveness is the outer condition and a destination narrows it, which is
     * the same shape is_present_at has - written out here rather than called
     * per row so this stays one index-friendly query. A user hiding their
     * activity has no destinations and a null channel, so they are simply not
     * here.
     */
    select p.user_id as id
      from public.presence p
     where p.status = 'online'
       and p.last_seen_at > now() - interval '90 seconds'
       and (
         exists (
           select 1
             from public.presence_destinations d
            where d.user_id = p.user_id
              and d.channel = v_channel
              and d.last_active_at > now() - interval '30 minutes'
         )
         -- Legacy singleton, so a v0.4.1 client is still in the room.
         or p.channel = v_channel
       )
  ),
  walk (id, hops, via, path) as (
    select v_actor, 0, null::uuid, array[v_actor]

    union all

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
         (array_agg(w.via order by w.hops))[1] as via_user_id
    from walk w
   where w.id <> v_actor
   group by w.id
   order by min(w.hops), w.id
   limit 50;
end;
$fn$;

revoke all on function public.stream_room_members(text) from public, anon;
grant execute on function public.stream_room_members(text) to authenticated;

/*
 * Sending: the presence gate widens, the fan-out does not change at all.
 *
 * Recipients are still materialised at send time, one row each, still filtered
 * pairwise against the sender. A user may now be in several rooms at once, and
 * the channel is on every step - the gate, the walk, and the stored row - so
 * two of their rooms cannot leak into each other.
 */
create or replace function public.send_room_message(p_channel text, p_body text)
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

  if not public.is_present_at(v_actor, v_channel) then
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

create or replace function public.send_together_reaction(p_channel text, p_reaction text)
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

  if not public.is_present_at(v_actor, v_channel) then
    raise exception 'kickback: you are not watching that' using errcode = '42501';
  end if;

  insert into public.together_reactions (recipient_id, sender_id, channel, reaction)
  select m.user_id, v_actor, v_channel, p_reaction
    from public.stream_room_members(v_channel) m
   where not public.blocked_pair(v_actor, m.user_id)
   union all
  select v_actor, v_actor, v_channel, p_reaction;

  get diagnostics v_sent = row_count;

  delete from public.together_reactions
   where recipient_id = v_actor
     and channel = v_channel
     and created_at < now() - interval '1 minute';

  return v_sent;
end;
$fn$;

revoke all on function public.send_together_reaction(text, text) from public, anon;
grant execute on function public.send_together_reaction(text, text) to authenticated;

-- --------------------------------------------------------------- realtime
--
-- Same guard as 0005, 0020 and 0021: a no-op on plain Postgres, which is what
-- the test harness runs, and idempotent so re-running the bundle does not
-- error on a table that is already published.

do $$
begin
  if not exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    raise notice 'supabase_realtime publication not present; skipping (expected outside Supabase)';
    return;
  end if;
  if not exists (
    select 1 from pg_publication_tables
     where pubname = 'supabase_realtime'
       and schemaname = 'public'
       and tablename = 'presence_destinations'
  ) then
    alter publication supabase_realtime add table public.presence_destinations;
  end if;
end
$$;

-- -------------------------------------------------------------- analytics
--
-- Two events, both enumerated, both about the SHAPE of multi-destination use
-- rather than about where anybody is. No channel names, no counts of who,
-- nothing that could reconstruct a viewing history.

insert into public.analytics_event_names (name, description, allowed_properties) values
  ('destinations_published',
   'How many destinations this client published, bucketed. Answers whether the max of three is too restrictive. Never carries a channel.',
   array['count_bucket', 'at_max']),
  ('automatic_room_left',
   'A Stream Room surface went away, and why. The counterpart to automatic_room_entered, which had no exit event.',
   array['reason', 'had_messages'])
on conflict (name) do update
  set description        = excluded.description,
      allowed_properties = excluded.allowed_properties;

/*
 * The applied marker, as 0016 asks: the newest analytics-touching migration
 * owns it, because everything else these files change is revoked from clients
 * and so is invisible to verify:analytics.
 */
create or replace function public.analytics_schema_version()
returns int
language sql
immutable
set search_path = public, pg_temp
as $fn$ select 25 $fn$;

revoke all on function public.analytics_schema_version() from public, anon, authenticated;

commit;
