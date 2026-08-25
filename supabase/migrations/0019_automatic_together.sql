-- ===========================================================================
-- 0019 — Automatic Together
--
-- Friends who happen to be on the same channel can send each other a handful
-- of reactions. There is NO room here: no room table, no membership, no
-- ownership, no lifecycle. Who is "in" a Together is derived from presence by
-- the client, exactly as the Gravity `here` cluster already is, and this
-- migration adds only the transport for the one thing presence cannot carry.
--
-- WHY A TABLE AND NOT A BROADCAST CHANNEL
--
-- Authorization. A broadcast channel keyed by `twitch:lvndmark` would deliver
-- every Kickback user's reactions to every other Kickback user on that
-- channel - forty thousand strangers on a big stream. What we want is "the
-- people Kickback already lets me see", and that is a question the database
-- answers with `is_friend`, per subscriber, on every row.
--
-- So reactions ride the same rails as presence: a table in the realtime
-- publication, with RLS re-checked for each subscriber. Two friends of mine
-- who are not friends with each other never see one another, and a stranger on
-- the same channel receives nothing at all - not because the client filters
-- it, but because the server never sends it.
--
-- WHY IT IS STILL EPHEMERAL
--
-- Rows are a transport, not a history. Nothing reads them back: the client
-- subscribes to inserts and renders them for eight seconds. Every insert
-- sweeps the channel's expired rows, so the table holds roughly "the last
-- minute of reactions on channels somebody is actively watching" and nothing
-- accumulates. There is no query anywhere that returns yesterday's reactions,
-- and there is deliberately no index that would make one cheap.
-- ===========================================================================

-- One transaction, as every migration from 0009 onwards is meant to be: a
-- failure part-way through must leave nothing behind.
begin;

/*
 * Dropped first, so the bundle can be re-run after 0020 has already reshaped
 * this table.
 *
 * The bundle applies every migration in order, every time - so on a database
 * that has seen 0020, this file meets a together_reactions with recipient_id
 * and sender_id rather than user_id. `create table if not exists` would skip
 * silently and the policy below would then fail on a column that no longer
 * exists. Starting from nothing costs nothing: the table holds at most a
 * minute of ephemeral events, and 0020 recreates it moments later anyway.
 */
drop table if exists public.together_reactions;

create table if not exists public.together_reactions (
  id         uuid        primary key default gen_random_uuid(),
  user_id    uuid        not null references public.users(id) on delete cascade,
  -- Canonical lowercase login. The same identity presence, Gravity, JOIN and
  -- analytics use; enforced here so the column cannot drift from them.
  channel    text        not null check (channel ~ '^[a-z0-9_]{3,25}$'),
  reaction   text        not null,
  created_at timestamptz not null default now()
);

-- The only access pattern: recent rows for one channel. Also what the sweep
-- uses, so cleanup is a range scan rather than a table scan.
create index if not exists together_reactions_channel_idx
  on public.together_reactions (channel, created_at desc);

alter table public.together_reactions enable row level security;

-- Clients read; only the RPC below writes. Same shape as group_messages.
revoke all on public.together_reactions from anon, authenticated;
grant select on public.together_reactions to authenticated;

/*
 * Friendship is the authorization; the channel is only the context.
 *
 * This is the whole privacy model in one predicate. A and B are friends, C and
 * D are friends, all four are watching LVNDMARK: A sees B and nobody else,
 * because `is_friend` is evaluated as A. Friend-of-friend does not leak -
 * `is_friend` is direct, and this policy asks nothing else.
 */
drop policy if exists together_reactions_select on public.together_reactions;
create policy together_reactions_select on public.together_reactions
  for select to authenticated
  using (user_id = (select auth.uid()) or public.is_friend(user_id));

/*
 * Send a reaction.
 *
 * SECURITY DEFINER with the actor from require_actor(), so there is no sender
 * parameter and nothing to spoof: you can only ever react as yourself.
 *
 * The reaction is checked against a fixed list rather than sanitised. A closed
 * set cannot carry a payload, so no arbitrary text can reach another person's
 * screen even if every client were modified.
 *
 * Nothing here checks who else is on the channel. It does not need to: a
 * reaction is only ever DELIVERED to the sender's friends, and a reaction sent
 * into an empty channel is simply seen by nobody. Adding a "are you actually
 * together" check would mean re-deriving presence in SQL, which is a second
 * answer to a question the client already answers from the same rows.
 */
/*
 * Dropped first, for the same reason 0020 drops it: the bundle re-runs every
 * migration in order, so on a database that has already seen 0020 this meets a
 * send_together_reaction returning INTEGER and CREATE OR REPLACE cannot turn it
 * back into one returning uuid.
 *
 * Both files therefore drop before creating, and the pair converges on 0020's
 * definition however many times the bundle is applied. Exactly what 0009 had to
 * do to list_groups() after 0008.
 */
drop function if exists public.send_together_reaction(text, text);

create function public.send_together_reaction(p_channel text, p_reaction text)
returns uuid
language plpgsql
volatile
security definer
set search_path = public, pg_temp
as $fn$
declare
  v_actor   uuid := public.require_actor();
  v_channel text := lower(btrim(coalesce(p_channel, '')));
  v_id      uuid;
begin
  if v_channel !~ '^[a-z0-9_]{3,25}$' then
    raise exception 'kickback: not a channel' using errcode = '22023';
  end if;

  -- The palette, and nothing else. Kept in step with REACTIONS in
  -- src/core/together.ts by a test that reads both.
  if p_reaction not in ('😂', '❤️', '🔥', '😭', '👀') then
    raise exception 'kickback: not a reaction' using errcode = '22023';
  end if;

  /*
   * Fast enough to hammer during a big play, slow enough that a script cannot
   * flood a friend's panel. Five per five seconds is roughly one per second
   * sustained, which is well past what a person does with five buttons.
   */
  if not public.consume_rate_budget('together_reaction', 60, interval '1 minute') then
    raise exception 'kickback: you are reacting too quickly' using errcode = '53400';
  end if;

  insert into public.together_reactions (user_id, channel, reaction)
  values (v_actor, v_channel, p_reaction)
  returning id into v_id;

  /*
   * Sweep this channel on the way past.
   *
   * Opportunistic rather than scheduled: it needs no pg_cron, it only ever
   * touches a channel somebody is actively using, and it is bounded by the
   * index above. A minute is comfortably longer than the client's eight-second
   * display window, so nothing is deleted while it could still be shown.
   */
  delete from public.together_reactions
   where channel = v_channel
     and created_at < now() - interval '1 minute';

  return v_id;
end;
$fn$;

revoke all on function public.send_together_reaction(text, text) from public, anon;
grant execute on function public.send_together_reaction(text, text) to authenticated;

-- --------------------------------------------------------------- realtime
--
-- Same guard as 0005: a no-op on a plain Postgres, which is what the test
-- harness runs.

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
-- Four events, chosen to answer one question: does Together add anything after
-- JOIN? The shared-watch lifecycle itself is NOT re-measured - 0015's
-- watching_together_started / _ended and post_social_retention_ended already
-- do that, and a second measurement of the same interval would be a second
-- chance to disagree.
--
-- Reaction CONTENT is not recorded. Which of five emoji somebody pressed
-- answers no question we have, and "what did this person react to" is a
-- surveillance-shaped fact. Only that an interaction happened.

insert into public.analytics_event_names (name, description, allowed_properties) values
  ('together_surface_shown',
   'The Automatic Together surface was visible: the viewer was on a channel with at least one friend.',
   array['participant_count', 'from_join']),

  ('together_reaction_sent',
   'The viewer sent a reaction. No content, only that they interacted.',
   array['participant_count']),

  ('together_reaction_received',
   'A reaction from a friend arrived while the viewer was together with them.',
   array['participant_count']),

  ('together_combo_formed',
   'Two or more people reacted the same way at the same moment.',
   array['combo_size', 'participant_count'])
on conflict (name) do update
  set description        = excluded.description,
      allowed_properties = excluded.allowed_properties;

commit;
