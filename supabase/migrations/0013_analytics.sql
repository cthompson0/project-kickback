-- Kickback — 0013: the analytics foundation
--
-- Analytics exists to answer product questions about Kickback, and nothing
-- else. It is deliberately a SEPARATE island from the product data: no foreign
-- key points from a product table into it, nothing here is read while Kickback
-- runs, and the whole thing can be emptied for one environment without a
-- single friendship, message or presence row being touched.
--
-- Three ideas carry the design.
--
--   1. EVENTS ARE FACTS, SESSIONS ARE DERIVED. There is no sessions table.
--      A session's start, end and duration are read from the events that
--      carry its id - the same "derived, not counted" rule the unread badge,
--      the combo counter and offline-from-staleness already follow here. A
--      stored duration is a second source of truth that can disagree with the
--      events; a view cannot.
--
--   2. THE PROPERTY CONTRACT LIVES IN THE DATABASE. `analytics_event_names`
--      holds every event Kickback may emit and the exact property keys that
--      event is allowed to carry. Anything else is stripped on the way in.
--      That is what stops the properties column becoming a garbage bag, and
--      it means the next checkpoint adds an event with one INSERT rather than
--      by touching any plumbing.
--
--   3. THE CLIENT NEVER SAYS WHO IT IS. `analytics_track` takes no actor. The
--      actor is auth.uid(), server-side, exactly as everywhere else in this
--      schema. A modified extension can lie about what happened; it cannot
--      lie about whose account it happened on.
--
-- WHAT IS NOT COLLECTED, BY CONSTRUCTION
--
-- Message bodies, emote identities, tokens, emails, friend codes, URLs, page
-- titles and search terms have no column to live in and no allowed property
-- key. Property values are capped at 64 characters and may not be objects or
-- arrays, so there is nowhere for a body to hide even if a future call site
-- tried. See docs/ANALYTICS.md.
--
-- Additive and idempotent: new tables, new functions, no change to anything
-- that existed before this file.

begin;

-- ------------------------------------------------------------- environments
--
-- Which build produced an event. The client declares it - it is a property of
-- the BUILD, not a claim about identity, so there is nothing to spoof that is
-- worth spoofing. Internal accounts are marked server-side instead; see
-- analytics_actors.is_internal.

create table if not exists public.analytics_environments (
  name        text primary key,
  description text not null
);

insert into public.analytics_environments (name, description) values
  ('development',  'Local dev build. Also the demo build, which never sends at all.'),
  ('private_beta', 'The friends-and-testers ZIP. Removable before public launch.'),
  ('production',   'The public build.')
on conflict (name) do nothing;

-- ------------------------------------------------------------- event names
--
-- One row per event Kickback may emit, with the exact property keys it may
-- carry. `allowed_properties` is the contract: the writer strips every key
-- that is not listed, so an event can never grow a field by accident and a
-- typo silently drops rather than being stored forever.

create table if not exists public.analytics_event_names (
  name               text primary key,
  description        text not null,
  allowed_properties text[] not null default '{}'
);

insert into public.analytics_event_names (name, description, allowed_properties) values
  -- lifecycle -------------------------------------------------------------
  ('extension_session_started',
   'Kickback became active on Twitch. Emitted once per session id.',
   array[]::text[]),
  ('extension_session_ended',
   'Best-effort. Duration is also derivable from the session''s first and last event.',
   array['duration_ms', 'end_reason']),
  ('authenticated_session_started',
   'The user is signed in within this Kickback session.',
   array['friend_count', 'group_count']),

  -- social graph ----------------------------------------------------------
  ('friend_search',
   'Someone searched for a person to add. The query itself is never recorded.',
   array['result_count', 'matched_by']),
  ('friend_request_sent',      'A friend request went out.', array['outcome']),
  ('friend_request_accepted',  'A friend request was accepted.', array['direction']),
  ('friend_removed',           'A friendship ended.', array[]::text[]),
  ('group_invite_sent',        'A group invitation went out.', array['member_count']),
  ('group_invite_accepted',    'A group invitation was accepted.', array['member_count']),

  -- presence exposure -----------------------------------------------------
  --
  -- The point of these is that social information was actually SHOWN, not
  -- merely that it existed. Deduped client-side; see exposure.ts.
  ('friend_presence_impression',
   'A friend''s live activity was visible in the open panel.',
   array['state', 'visible_count']),
  ('gathering_impression',
   'A gathering banner was visible in the open panel.',
   array['friend_count', 'rank', 'visible_count']),
  ('gravity_cluster_impression',
   'Reserved for Social Gravity. Registered now so the next checkpoint adds no plumbing.',
   array['friend_count', 'rank', 'visible_clusters']),

  -- join ------------------------------------------------------------------
  --
  -- ONE canonical join event. The surface is `source`, never a separate event
  -- name, so "which surface drove a JOIN" is a group-by rather than a union.
  ('join_clicked',
   'A JOIN control was clicked. Carries the attribution that arrival is matched against.',
   array['social_count', 'already_on_twitch', 'already_on_destination', 'navigated']),
  ('join_arrived',
   'The user actually reached the channel a JOIN pointed at. Clicks are not successes.',
   array['elapsed_ms']),

  -- watching together -----------------------------------------------------
  ('watching_together_started',
   'The user is on a channel where at least one visible person also is.',
   array['other_count', 'from_join']),
  ('watching_together_ended',
   'That stopped being true. Duration is also derivable from the pair of events.',
   array['other_count_peak', 'duration_ms', 'end_reason']),

  -- gatherings ------------------------------------------------------------
  ('gathering_notification_shown',
   'A desktop notification about a gathering was raised.',
   array['friend_count']),
  ('gathering_notification_clicked',
   'That notification was clicked.',
   array['friend_count']),

  -- groups and chat -------------------------------------------------------
  ('group_created',       'A group was created.', array[]::text[]),
  ('group_opened',        'A group was opened in the panel.', array['member_count']),
  ('group_message_sent',  'A message was sent. No body, no emote identity - only shape.',
   array['length_bucket', 'has_emote']),
  ('combo_formed',        'An emote combo reached the display threshold.', array['count']),
  ('combo_broken',        'An emote combo was broken.', array['count'])
on conflict (name) do update
  -- Descriptions and contracts are owned by this file, so re-running it after
  -- an event gains a property brings the database up to date rather than
  -- leaving it silently stripping the new key.
  set description        = excluded.description,
      allowed_properties = excluded.allowed_properties;

-- ------------------------------------------------------------------ actors
--
-- One row per person analytics has ever seen, maintained by the writer.
--
-- This is what makes cohort and retention questions answerable without
-- scanning the whole event table, and what lets production reporting exclude
-- the people building the thing: `is_internal` is set by hand in SQL, so a
-- modified client cannot un-mark itself.

create table if not exists public.analytics_actors (
  user_id       uuid primary key references public.users (id) on delete cascade,
  first_seen_at timestamptz not null default now(),
  last_seen_at  timestamptz not null default now(),
  -- Every environment this account has ever sent from. A tester who later
  -- installs the public build is visible as both.
  environments  text[] not null default '{}',
  is_internal   boolean not null default false
);

comment on column public.analytics_actors.is_internal is
  'Set by hand in SQL for the team and known test accounts. Excluded from production reporting.';

-- ------------------------------------------------------------------ events

create table if not exists public.analytics_events (
  id          uuid primary key default gen_random_uuid(),
  -- Always auth.uid(). Never a value the client supplied.
  actor_id    uuid not null references public.users (id) on delete cascade,
  environment text not null references public.analytics_environments (name),
  event_name  text not null references public.analytics_event_names (name),

  -- Null only for events that genuinely happen outside a session.
  session_id  uuid,

  -- The client's clock, clamped to a sane window by the writer, alongside the
  -- server's. Keeping both means clock skew is visible rather than silently
  -- reordering a funnel.
  occurred_at timestamptz not null,
  received_at timestamptz not null default now(),

  app_version text,

  -- Which Kickback surface this came from - the JoinSource vocabulary, widened
  -- to cover impressions. Promoted out of `properties` because every funnel
  -- question groups by it.
  source      text,

  /*
   * The Twitch channel a JOIN, impression or shared watch is about.
   *
   * A LOGIN, NOT A HASH, and that is a deliberate choice worth defending. A
   * hash would group and join exactly as well, so it costs nothing analytically
   * - but a Twitch login is public, low-entropy and enumerable, so a hash of one
   * is reversible by anyone who wants to and protects nobody. It would be
   * privacy theatre that also blocks joining to channel metadata later.
   *
   * What matters for privacy is that this is the ONLY thing recorded about
   * where someone was: no URLs, no paths, no VOD ids, no titles, and only for
   * events that are about a destination in the first place.
   */
  destination_channel text check (
    destination_channel is null or destination_channel ~ '^[a-z0-9_]{1,25}$'
  ),

  -- Ties a join click to the arrival and the shared watch that followed it,
  -- deterministically, rather than by matching timestamps after the fact.
  attribution_id uuid,

  properties jsonb not null default '{}'::jsonb
);

-- Reporting reads by environment and event over a date range; that is the
-- index. The others serve the funnel joins.
create index if not exists analytics_events_report_idx
  on public.analytics_events (environment, event_name, occurred_at desc);
create index if not exists analytics_events_actor_idx
  on public.analytics_events (actor_id, occurred_at desc);
create index if not exists analytics_events_session_idx
  on public.analytics_events (session_id) where session_id is not null;
create index if not exists analytics_events_attribution_idx
  on public.analytics_events (attribution_id) where attribution_id is not null;

-- --------------------------------------------------------------------- RLS
--
-- No client reads analytics. Not their own, not anyone's.
--
-- There is no product reason for the extension to read this back, and a
-- readable event log is an activity side channel of exactly the kind 0003 and
-- 0006 were careful to close - "when was this person last active, and where"
-- is precisely what an event row says. Analysis happens in SQL, as the owner.

alter table public.analytics_events       enable row level security;
alter table public.analytics_actors       enable row level security;
alter table public.analytics_event_names  enable row level security;
alter table public.analytics_environments enable row level security;

revoke all on public.analytics_events       from anon, authenticated;
revoke all on public.analytics_actors       from anon, authenticated;
revoke all on public.analytics_event_names  from anon, authenticated;
revoke all on public.analytics_environments from anon, authenticated;

comment on table public.analytics_events is
  'Product analytics. Write-only from clients, read only in SQL by the owner.';

-- ------------------------------------------------------------- the writer
--
-- One RPC, taking a batch. Best-effort by contract: it never raises for a bad
-- event, because a failing analytics call must not be able to break a JOIN or
-- a message. It reports how many events it kept so the client - and the tests
-- - can tell silence from success.

/** Scalar, short, and not an object. Anything else is not a property. */
create or replace function public.analytics_clean_properties(
  p_properties jsonb,
  p_allowed    text[]
)
returns jsonb
language plpgsql
immutable
set search_path = public, pg_temp
as $$
declare
  v_out   jsonb := '{}'::jsonb;
  v_key   text;
  v_value jsonb;
  v_kept  int := 0;
begin
  if p_properties is null or jsonb_typeof(p_properties) <> 'object' then
    return v_out;
  end if;

  for v_key, v_value in select * from jsonb_each(p_properties) loop
    -- Not in the contract: drop it. This is the line that keeps message
    -- bodies, search terms and tokens out even if a call site tried.
    continue when not (v_key = any (p_allowed));
    -- No nesting. A property is one small fact, not a document.
    continue when jsonb_typeof(v_value) in ('object', 'array');
    -- A long string is not a property; it is content.
    continue when jsonb_typeof(v_value) = 'string'
                  and char_length(v_value #>> '{}') > 64;
    -- Twelve is far more than any event here needs, and a hard stop.
    exit when v_kept >= 12;

    v_out := v_out || jsonb_build_object(v_key, v_value);
    v_kept := v_kept + 1;
  end loop;

  return v_out;
end;
$$;

/*
 * A fixed-window counter that charges an AMOUNT rather than one unit.
 *
 * public.consume_rate_budget from 0007 charges one per call, which is right
 * for "created a group" and wrong for a batch: batching is the honest way to
 * send events, so charging per call would let a modified client pack ten
 * thousand into one request and pay a single unit. This one charges what the
 * batch actually costs.
 *
 * Its own function rather than a change to 0007's, so nothing that already
 * depends on that behaviour moves under it.
 */
create or replace function public.consume_rate_budget_n(
  p_bucket text,
  p_amount int,
  p_limit  int,
  p_window interval
)
returns boolean
language plpgsql
volatile
security definer
set search_path = public, pg_temp
as $fn$
declare
  v_actor  uuid := public.require_actor();
  v_writes int;
begin
  insert into public.rate_limits (user_id, bucket, window_started_at, writes)
  values (v_actor, p_bucket, now(), greatest(p_amount, 0))
  on conflict (user_id, bucket) do update
    set window_started_at = case
          when public.rate_limits.window_started_at < now() - p_window then now()
          else public.rate_limits.window_started_at
        end,
        writes = case
          when public.rate_limits.window_started_at < now() - p_window then greatest(p_amount, 0)
          else public.rate_limits.writes + greatest(p_amount, 0)
        end
  returning writes into v_writes;

  return v_writes <= p_limit;
end;
$fn$;

revoke all on function public.consume_rate_budget_n(text, int, int, interval)
  from public, anon, authenticated;

create or replace function public.analytics_track(p_events jsonb)
returns int
language plpgsql
volatile
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor    uuid := public.require_actor();
  v_event    jsonb;
  v_name     text;
  v_env      text;
  v_allowed  text[];
  v_occurred timestamptz;
  v_channel  text;
  v_source   text;
  v_version  text;
  v_kept     int := 0;
  v_seen     int := 0;
  v_envs     text[] := '{}';
begin
  if p_events is null or jsonb_typeof(p_events) <> 'array' then
    return 0;
  end if;

  /*
   * Budget first, and charged in EVENTS rather than calls.
   *
   * Batching is the honest way to send these, so charging per call would let a
   * modified client pack ten thousand events into one request and pay one unit.
   * 600 events per five minutes is roughly forty times a heavy real session -
   * see docs/ANALYTICS.md for the volume estimate - and unreachable by using
   * Kickback.
   *
   * The batch cap is applied to the charge as well, so a client sending 10,000
   * is billed for the 50 that could possibly be stored rather than for all of
   * them: the cap is a limit on what is accepted, not an extra punishment.
   */
  if not public.consume_rate_budget_n(
       'analytics',
       least(jsonb_array_length(p_events), 50),
       600,
       interval '5 minutes'
     ) then
    return 0;
  end if;

  for v_event in select * from jsonb_array_elements(p_events) loop
    v_seen := v_seen + 1;
    -- A batch is capped so one call cannot be a bulk import.
    exit when v_seen > 50;

    continue when jsonb_typeof(v_event) <> 'object';

    v_name := v_event ->> 'event_name';
    v_env  := v_event ->> 'environment';

    -- Unknown event or unknown environment: dropped, silently and without
    -- failing the batch. The foreign keys below would refuse it anyway; this
    -- is what turns that refusal into "ignored" rather than "everything lost".
    select aen.allowed_properties into v_allowed
    from public.analytics_event_names aen
    where aen.name = v_name;
    continue when v_allowed is null;

    continue when not exists (
      select 1 from public.analytics_environments ae where ae.name = v_env
    );

    /*
     * The client's clock is not trusted to be right, only to be close.
     *
     * A skewed or hostile clock could otherwise park events in 2077 and
     * poison every time series. Anything outside a day either side is
     * replaced by the server's clock; `received_at` always tells the truth.
     */
    begin
      v_occurred := (v_event ->> 'occurred_at')::timestamptz;
    exception when others then
      v_occurred := null;
    end;
    if v_occurred is null
       or v_occurred > now() + interval '1 day'
       or v_occurred < now() - interval '1 day' then
      v_occurred := now();
    end if;

    v_channel := nullif(lower(btrim(coalesce(v_event ->> 'destination_channel', ''))), '');
    if v_channel is not null and v_channel !~ '^[a-z0-9_]{1,25}$' then
      v_channel := null;
    end if;

    v_source  := left(nullif(btrim(coalesce(v_event ->> 'source', '')), ''), 40);
    v_version := left(nullif(btrim(coalesce(v_event ->> 'app_version', '')), ''), 20);

    insert into public.analytics_events (
      actor_id, environment, event_name, session_id,
      occurred_at, app_version, source, destination_channel, attribution_id, properties
    )
    values (
      v_actor,
      v_env,
      v_name,
      case when (v_event ->> 'session_id') ~ '^[0-9a-fA-F-]{36}$'
           then (v_event ->> 'session_id')::uuid end,
      v_occurred,
      v_version,
      v_source,
      v_channel,
      case when (v_event ->> 'attribution_id') ~ '^[0-9a-fA-F-]{36}$'
           then (v_event ->> 'attribution_id')::uuid end,
      public.analytics_clean_properties(v_event -> 'properties', v_allowed)
    );

    v_kept := v_kept + 1;
    if not (v_env = any (v_envs)) then
      v_envs := v_envs || v_env;
    end if;
  end loop;

  if v_kept > 0 then
    insert into public.analytics_actors (user_id, first_seen_at, last_seen_at, environments)
    values (v_actor, now(), now(), v_envs)
    on conflict (user_id) do update
      set last_seen_at  = now(),
          -- Union, so an account that moves from the beta ZIP to the public
          -- build is visible as having been both.
          environments  = (
            select coalesce(array_agg(distinct e), '{}')
            from unnest(public.analytics_actors.environments || v_envs) as e
          );
  end if;

  return v_kept;
end;
$$;

revoke all on function public.analytics_clean_properties(jsonb, text[]) from public, anon, authenticated;
revoke all on function public.analytics_track(jsonb) from public, anon, authenticated;
grant execute on function public.analytics_track(jsonb) to authenticated;

-- ------------------------------------------------- reset before public launch
--
-- Private-beta analytics exist to prove the pipeline works. They must not
-- become the first week of "real" numbers, so there is a deliberate way to
-- drop them - and only them.
--
-- Three guards, because a careless call here is unrecoverable:
--   1. it takes a confirmation phrase that names the environment;
--   2. 'production' needs a second, longer phrase on top of that;
--   3. it is revoked from every client role, so it exists only for whoever is
--      already sitting in the SQL editor as the owner.
--
-- It touches analytics tables and nothing else. Friendships, groups, messages
-- and presence are not reachable from here.

create or replace function public.analytics_reset_environment(
  p_environment text,
  p_confirm     text
)
returns table (deleted_events bigint, deleted_actors bigint)
language plpgsql
volatile
set search_path = public, pg_temp
as $$
declare
  v_expected text := 'RESET ' || coalesce(p_environment, '');
  v_events   bigint;
  v_actors   bigint;
begin
  if not exists (
    select 1 from public.analytics_environments where name = p_environment
  ) then
    raise exception 'kickback: unknown analytics environment %', p_environment
      using errcode = '22023';
  end if;

  if p_environment = 'production' then
    v_expected := 'RESET production I AM SURE';
  end if;

  if p_confirm is distinct from v_expected then
    raise exception 'kickback: refusing to reset %. Pass the confirmation phrase: %',
      p_environment, v_expected using errcode = '22023';
  end if;

  delete from public.analytics_events where environment = p_environment;
  get diagnostics v_events = row_count;

  -- Only actors with nothing left at all. An account that also sent from
  -- another environment keeps its row, and its first_seen_at with it.
  delete from public.analytics_actors aa
  where not exists (
    select 1 from public.analytics_events ae where ae.actor_id = aa.user_id
  );
  get diagnostics v_actors = row_count;

  return query select v_events, v_actors;
end;
$$;

revoke all on function public.analytics_reset_environment(text, text)
  from public, anon, authenticated;

commit;
