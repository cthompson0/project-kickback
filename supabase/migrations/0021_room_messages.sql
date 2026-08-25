-- ===========================================================================
-- 0021 — Ephemeral Stream Room messages
--
-- The room got a conversation. See
-- docs/checkpoints/contextual-stream-session-architecture.md.
--
-- WHY TEXT, AFTER DECIDING AGAINST IT
--
-- The roster-and-reactions room was built, shipped and used, and it is a
-- presence list with buttons. What makes a room a place is that something is
-- being said in it; reactions are punctuation for a conversation that was
-- never there. The earlier no-text decision was avoiding a second GroupChat -
-- the right fear, the wrong conclusion.
--
-- WHAT THIS IS NOT
--
-- Not group_messages. Groups are intentional, durable and administered: you
-- create one, you invite people, and the conversation is still there tomorrow.
-- This is the opposite on every axis, and the difference is enforced here
-- rather than in the client:
--
--   * no room record, no room id, no membership table - a room is still the
--     connected component computed on demand by stream_room_members;
--   * rows carry a recipient, so there is nothing to "join";
--   * rows are swept, so there is no transcript to read tomorrow;
--   * there is no query that returns another person's inbox.
--
-- RECIPIENTS ARE DECIDED AT SEND TIME, AND THAT IS THE SECURITY MODEL
--
-- The component is computed once, when the message is written, and one row is
-- written per recipient. This is the same shape 0020 gave reactions, for the
-- same Realtime reason - one row, one interested subscriber - but here it also
-- answers the question text introduces and reactions never did:
--
--   A ↔ B ↔ C, then B leaves.  A and C are no longer one room. A's next
--   message computes a component without C in it, so no row for C is ever
--   written. Nothing filters it; there is nothing to filter.
--
--   A ↔ B and C ↔ D later merge through B ↔ C.  C and D receive nothing that
--   was said before. Not because a query excludes it - because the
--   authorization decision was MATERIALIZED at send time, and no row addressed
--   to them exists. A permissive read can never resurrect it.
--
-- That is why this is a fan-out table and not a body table with a policy: a
-- policy is re-evaluated, and re-evaluation is where backfill leaks in.
--
-- WHY IT IS STILL BOUNDED
--
-- Two dimensions, because one is not enough. Thirty minutes covers a page
-- refresh, a worker eviction, an ad break and stepping away - the things that
-- must not destroy a conversation. Two hundred rows per recipient per channel
-- is what makes that clock safe to state: retention cost is
-- messages x recipients, and a room can hold fifty people, so without a row
-- cap a fast conversation is unbounded no matter how short the window.
-- ===========================================================================

-- One transaction, as every migration from 0009 onwards is meant to be: a
-- failure part-way through must leave nothing behind.
begin;

-- ------------------------------------------------------------ the messages
--
-- One row per RECIPIENT, not per message. Denormalised on purpose: the
-- alternatives were audited and both fail.
--
--   * One row + read-time RLS is what 0019 did for reactions. On hosted
--     Supabase several subscriptions matching one row means only the most
--     recently created one receives it (supabase/realtime#1524) - the exact
--     one-direction bug 0020 fixed by fanning out. Text would reproduce it
--     more visibly, not less.
--
--   * A body table plus a pointer table is storage-optimal and puts a query
--     on the latency path of every single message: Realtime would deliver the
--     pointer and the client would have to go and fetch the words. The
--     storage it saves is already bounded by the row cap below.

create table if not exists public.room_messages (
  id           uuid        primary key default gen_random_uuid(),
  -- Who this copy is for. The whole authorization model in one column.
  recipient_id uuid        not null references public.users(id) on delete cascade,
  sender_id    uuid        not null references public.users(id) on delete cascade,
  -- Canonical lowercase login: the same identity presence, Gravity, JOIN,
  -- reactions and analytics use, enforced here so it cannot drift from them.
  channel      text        not null check (channel ~ '^[a-z0-9_]{3,25}$'),
  /*
   * 280 characters.
   *
   * Suits the medium - this is a thing you say during a play, not a post -
   * and it nearly halves the worst-case fan-out storage the row cap is there
   * to protect. Checked here as well as in the client, because the client is
   * a suggestion.
   */
  body         text        not null check (length(body) between 1 and 280),
  created_at   timestamptz not null default now()
);

/*
 * The only access pattern: my inbox for one channel, newest first.
 *
 * Also what the sweep and the row cap use, so both are range scans rather than
 * table scans. Deliberately keyed on recipient FIRST - there is no index that
 * would make "everything said on this channel" cheap, because no query anywhere
 * is allowed to ask that.
 */
create index if not exists room_messages_inbox_idx
  on public.room_messages (recipient_id, channel, created_at desc);

alter table public.room_messages enable row level security;

-- Clients read their own inbox; only the RPC below writes.
revoke all on public.room_messages from anon, authenticated;
grant select on public.room_messages to authenticated;

/*
 * You can read what was addressed to you. Nothing else.
 *
 * Note what is NOT here: no is_friend, no channel predicate, no component
 * walk. Authorization already happened when the row was written, and the whole
 * point of materialising it is that this policy cannot be more generous than
 * that decision was.
 */
drop policy if exists room_messages_select on public.room_messages;
create policy room_messages_select on public.room_messages
  for select to authenticated
  using (recipient_id = (select auth.uid()));

-- ------------------------------------------------------------------- send
--
-- Dropped before creating, for the reason 0009 learned the hard way and 0020
-- repeated: the bundle applies every migration in order every time, and
-- CREATE OR REPLACE cannot change a function's return type (42P13). A drop
-- first makes this file idempotent under apply_all.sql regardless of what
-- shape a previous run left behind.

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

  /*
   * Its own budget, separate from reactions.
   *
   * Twenty a minute is a fast conversation and nowhere near a flood. Separate
   * so that hammering emotes cannot silence somebody's typing - one action
   * exhausting another's allowance is a denial of service you build yourself.
   */
  if not public.consume_rate_budget('room_message', 20, interval '1 minute') then
    raise exception 'kickback: you are sending messages too quickly' using errcode = '53400';
  end if;

  -- Presence decides whether you are in the room, here as everywhere else.
  -- stream_room_members would refuse anyway; failing here says why.
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
   * The component, as it is RIGHT NOW, plus a copy for the sender.
   *
   * The self-row is not an optimisation - it is what makes a message appear by
   * exactly one route. A client that rendered its own message optimistically
   * could show something the server declined, and the sender would be the one
   * person who could not tell.
   */
  insert into public.room_messages (recipient_id, sender_id, channel, body)
  select m.user_id, v_actor, v_channel, v_body
    from public.stream_room_members(v_channel) m
   union all
  select v_actor, v_actor, v_channel, v_body;

  get diagnostics v_sent = row_count;

  /*
   * Sweep on the way past, in both dimensions.
   *
   * Opportunistic rather than scheduled: no pg_cron, bounded by the inbox
   * index, and it only ever touches the sender's own rows on a channel they
   * are actively using. Every participant sweeps their own inbox as they
   * speak, and a silent participant's rows are collected by whoever does.
   */
  delete from public.room_messages
   where recipient_id = v_actor
     and channel = v_channel
     and created_at < now() - interval '30 minutes';

  -- And the row cap, which is what actually bounds a fast conversation.
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

-- --------------------------------------------------------------- realtime
--
-- Same guard as 0005 and 0020: a no-op on a plain Postgres, which is what the
-- test harness runs, and idempotent so re-running the bundle does not error on
-- a table that is already published.

do $$
begin
  if not exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    raise notice 'supabase_realtime publication not present; skipping (expected outside Supabase)';
    return;
  end if;

  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'room_messages'
  ) then
    alter publication supabase_realtime add table public.room_messages;
  end if;
end;
$$;

-- --------------------------------------------------- the analytics contract
--
-- ONE new event, and one new property on an existing one.
--
-- The temptation here is a funnel's worth of names - room_available,
-- streamer_tab_opened, combo_participated, session_duration - and every one of
-- them is already answered: automatic_room_entered IS availability,
-- automatic_room_combo IS participation, and watching_together_started/_ended
-- already measure the interval a session happens inside. A second measurement
-- of the same fact is a second chance to disagree with ourselves.
--
-- No message bodies, ever. A length bucket and whether it contained an emote
-- answer "is anybody talking"; the words answer nothing we have asked and are
-- not ours to keep.

insert into public.analytics_event_names (name, description, allowed_properties) values
  ('automatic_room_message_sent',
   'The viewer sent an ephemeral message in a Stream Room. Length bucket and an emote flag only - never the body.',
   array['length_bucket', 'has_emote', 'participant_count'])
on conflict (name) do update
  set description        = excluded.description,
      allowed_properties = excluded.allowed_properties;

/*
 * How the room was opened.
 *
 * The whole navigation bet is that a contextual tab gets opened on its own
 * rather than only from the card it used to hide behind, so the answer has to
 * be in the event. A property rather than a new surface value: `source` says
 * which product surface an event came from, and all three of these are the
 * same surface reached three ways.
 */
insert into public.analytics_event_names (name, description, allowed_properties) values
  ('automatic_room_opened',
   'The viewer opened the contextual stream session. `opened_from` distinguishes the HERE affordance, the tab itself, and a selection restored after a refresh.',
   array['participant_count', 'direct_friend_count', 'opened_from'])
on conflict (name) do update
  set description        = excluded.description,
      allowed_properties = excluded.allowed_properties;

commit;
