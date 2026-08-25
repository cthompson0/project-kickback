-- ===========================================================================
-- 0020 — Automatic Stream Rooms
--
-- Converges the Automatic Together prototype (0019) onto the architecture in
-- docs/checkpoints/automatic-stream-room-convergence.md. Two things change,
-- and they are the same change seen from two sides.
--
-- 1. A ROOM IS A CONNECTED COMPONENT, NOT A FRIEND LIST
--
-- 0019 scoped a Together to the viewer's DIRECT friends. With A ↔ B ↔ C ↔ D
-- all on one channel that gives four people four different rooms, none of
-- which is the gathering. A room is now the connected component of the
-- friendship graph restricted to people present on the destination, computed
-- here and never stored.
--
-- 2. RECIPIENTS ARE DECIDED AT WRITE TIME, NOT READ TIME
--
-- 0019 wrote one row per reaction and let each subscriber's RLS decide whether
-- to deliver it. That is the wrong shape for Realtime twice over:
--
--   * Every viewer subscribed to the SAME filter, so one row matched MANY
--     subscriptions - the exact condition for a documented hosted-only defect
--     where only the most recently created subscription receives it. That is
--     the one-way reaction bug: not friendship direction (is_friend is
--     symmetric and link_friendship writes both mirrored rows), but whichever
--     side subscribed last.
--   * Supabase's own documentation is explicit that Postgres Changes
--     "authorizes every event against each subscriber", so read-time
--     authorization costs one policy evaluation per subscriber per row.
--
-- Presence never hit either problem because it binds one subscription per
-- friend, so every presence row has exactly ONE interested subscriber. This
-- migration gives reactions the same property: one row per recipient, a
-- per-user filter, and `recipient_id = auth.uid()` as the whole policy.
--
-- Deciding recipients once, server-side, is therefore both the correct fix and
-- the cheaper one - and it is what makes friend-of-friend delivery possible at
-- all without a recursive predicate in RLS.
-- ===========================================================================

-- --------------------------------------------------- presence, by channel
--
-- The component walk starts from "everyone present on this channel". Without
-- this index that is a sequential scan of the presence table on every call.
-- Partial, because a row with no channel can never be a starting point - and
-- a hidden user's row has no channel, which is what keeps them out for free.

create index if not exists presence_channel_idx
  on public.presence (channel)
  where channel is not null;

-- ------------------------------------------------------- room membership
--
-- Returns the connected component containing the CALLER, among people present
-- on one channel. Members, never edges. Seeded at auth.uid(), so there is no
-- parameter naming a user and no way to ask about somebody else's graph.
--
-- SECURITY DEFINER because it must read presence and friendships the caller
-- cannot read directly - and that is precisely why it returns so little: the
-- caller learns who is in this gathering, on this channel, now. Not what those
-- people watch later, not their friend lists, not the path beyond one hop.
--
-- Global presence RLS is untouched. Nothing here loosens a policy.

create or replace function public.stream_room_members(p_channel text)
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
     * One step along a real friendship edge, into somebody who is also here.
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

-- --------------------------------------------------------- the reactions
--
-- Dropped and recreated rather than altered. The table holds at most a minute
-- of ephemeral events - there is nothing to migrate, and a guarded sequence of
-- renames would be more code and more ways to be half-applied.

drop table if exists public.together_reactions;

create table if not exists public.together_reactions (
  id           uuid        primary key default gen_random_uuid(),
  -- Exactly one interested subscriber per row. This is the whole fix.
  recipient_id uuid        not null references public.users(id) on delete cascade,
  sender_id    uuid        not null references public.users(id) on delete cascade,
  channel      text        not null check (channel ~ '^[a-z0-9_]{3,25}$'),
  reaction     text        not null,
  created_at   timestamptz not null default now()
);

-- The only access pattern, and what the sweep uses.
create index if not exists together_reactions_recipient_idx
  on public.together_reactions (recipient_id, created_at desc);

alter table public.together_reactions enable row level security;

revoke all on public.together_reactions from anon, authenticated;
grant select on public.together_reactions to authenticated;

/*
 * The entire read policy.
 *
 * No is_friend, no component walk, no recursion - because the question "may
 * this person see this row" was already answered when the row was written.
 * Read-time authorization is now a single equality, which is what Realtime
 * evaluates per subscriber per row.
 */
drop policy if exists together_reactions_select on public.together_reactions;
create policy together_reactions_select on public.together_reactions
  for select to authenticated
  using (recipient_id = (select auth.uid()));

/*
 * Send a reaction to everybody in your room.
 *
 * The actor comes from require_actor(), so there is no sender parameter and
 * nothing to spoof. The recipients come from stream_room_members, so there is
 * no recipient parameter either - you cannot address a reaction at somebody
 * you are not socially connected to, and you cannot send into a channel you
 * are not on, because that function returns nothing when you are not there.
 *
 * The sender receives their own copy through the same path everyone else
 * does. One way for a reaction to appear, and no optimistic rendering to take
 * back if the send fails.
 */
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

  -- Kickback's own emotes, and only these five. Kept in step with REACTIONS
  -- in src/core/together.ts by a test that reads both. A closed set cannot
  -- carry a payload, so no arbitrary text reaches another person's screen.
  if p_reaction not in ('lol', 'heart', 'fire', 'sad', 'eyes') then
    raise exception 'kickback: not a reaction' using errcode = '22023';
  end if;

  -- Fast enough to hammer during a big play, far below what a script does.
  if not public.consume_rate_budget('together_reaction', 60, interval '1 minute') then
    raise exception 'kickback: you are reacting too quickly' using errcode = '53400';
  end if;

  -- Presence decides whether you are in the room, here as everywhere else.
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

  insert into public.together_reactions (recipient_id, sender_id, channel, reaction)
  select m.user_id, v_actor, v_channel, p_reaction
    from public.stream_room_members(v_channel) m
   union all
  -- Your own copy, so the sender and the room see the same event by the same
  -- route.
  select v_actor, v_actor, v_channel, p_reaction;

  get diagnostics v_sent = row_count;

  /*
   * Sweep on the way past.
   *
   * Opportunistic rather than scheduled: no pg_cron, bounded by the index, and
   * it only ever touches rows for somebody who is actively reacting. A minute
   * is comfortably longer than the client's eight-second display window, so
   * nothing is deleted while it could still be shown.
   */
  delete from public.together_reactions
   where recipient_id = v_actor
     and created_at < now() - interval '1 minute';

  return v_sent;
end;
$fn$;

revoke all on function public.send_together_reaction(text, text) from public, anon;
grant execute on function public.send_together_reaction(text, text) to authenticated;

-- --------------------------------------------------------------- realtime
--
-- Same guard as 0005: a no-op on a plain Postgres, which is what the test
-- harness runs. The table was dropped and recreated above, so its publication
-- membership has to be re-established.

do $$
begin
  if not exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    raise notice 'supabase_realtime publication not present; skipping (expected outside Supabase)';
    return;
  end if;

  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'together_reactions'
  ) then
    alter publication supabase_realtime add table public.together_reactions;
  end if;
end;
$$;

-- --------------------------------------------------- the analytics contract
--
-- 0019's four events renamed into room vocabulary, plus `direct_friend_count`
-- so we can tell whether friend-of-friend exposure is actually happening -
-- which is the question the whole connected-component model exists to answer.
--
-- Still NO new lifecycle: watching_together_started / _ended and
-- post_social_retention_ended already measure the shared watch, and measuring
-- it twice would be two chances to disagree.
--
-- Still no reaction content. Which of five emotes somebody pressed answers no
-- question we have.
--
-- The old names are left registered rather than deleted, and that is not
-- tidiness - `analytics_events.event_name` has a FOREIGN KEY to this table.
-- Beta already recorded events under together_surface_shown and its siblings,
-- so deleting the contract rows would fail this migration outright. They stay,
-- unused, and tests/extension/analyticsContract.test.ts lists them as retired
-- so that dropping an event stays a deliberate act rather than drift.

insert into public.analytics_event_names (name, description, allowed_properties) values
  ('automatic_room_entered',
   'The viewer arrived on a destination where a connected social cluster exists, and the room surface appeared.',
   array['participant_count', 'direct_friend_count']),

  ('automatic_room_opened',
   'The viewer opened the richer room surface from the quick reaction strip.',
   array['participant_count', 'direct_friend_count']),

  ('automatic_room_reaction',
   'A reaction was sent or received in a room. No content, only that it happened.',
   array['participant_count', 'direction']),

  ('automatic_room_combo',
   'Two or more people in the room reacted the same way at the same moment.',
   array['combo_size', 'participant_count'])
on conflict (name) do update
  set description        = excluded.description,
      allowed_properties = excluded.allowed_properties;

/*
 * Gravity → JOIN → room → new friend edge, for free.
 *
 * friend_request_sent already exists and already carries a source, so meeting
 * somebody in a room and adding them is measurable without a new event. The
 * property is added here so the funnel can be joined on the destination the
 * meeting happened at.
 */
insert into public.analytics_event_names (name, description, allowed_properties) values
  ('friend_request_sent',
   'A friend request was sent. `source` says which surface it came from - including a Stream Room, which is how organic graph growth is measured.',
   array['outcome'])
on conflict (name) do update
  set description        = excluded.description,
      allowed_properties = excluded.allowed_properties;
