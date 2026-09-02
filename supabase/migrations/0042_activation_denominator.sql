-- ===========================================================================
-- 0042 — The activation denominator: who never got past the cold start
--
-- THE BLIND SPOT THIS CLOSES
--
-- Watchside's social value is unreachable without at least one friend, and the
-- zero-friend state emits nothing at all. So every activation rate the product
-- could compute was conditioned on users who had ALREADY escaped the cold
-- start: "what share of users reach a JOIN" was measured across people who had
-- friends to see, and a stranger who installed, signed in, found an empty panel
-- and left was invisible.
--
-- That is the M5C coverage failure again, in a different funnel. The rates
-- would be arithmetically correct and would describe a population selected by
-- the very thing being measured. Cold start could be total and activation could
-- look healthy.
--
-- WHY NO NEW TELEMETRY
--
-- None is needed, and adding some would be worse. The facts already exist and
-- are authoritative:
--
--   who authenticated, and when   `authenticated_session_started`
--   whether they have a friend    `public.friendships` - the graph itself
--   WHEN the first friend arrived `friendships.created_at`
--   what they reached afterwards  events that have existed since M3A/M5A
--
-- A client event announcing "I am in the zero-friend state" would be a worse
-- source than the friend graph: it can be lost, it can be emitted by a client
-- that has not synced yet, and it would go missing in exactly the cases that
-- matter - a browser closed in disappointment thirty seconds after install.
-- Deriving the state from the graph cannot miss anybody, because the absence of
-- a row IS the state.
--
-- THE DENOMINATOR IS EVERY AUTHENTICATED ACTOR. Not those with friends, not
-- those who sent a second event, not those who reached a surface. Signing in is
-- the last thing that happens before Watchside owes the user something, so it
-- is where the funnel starts.
--
-- ADDITIVE ONLY. Two views, no table, no policy, no grant, no client change.
-- ===========================================================================

begin;

-- ===========================================================================
-- 1. ONE ROW PER PERSON WHO EVER SIGNED IN
-- ===========================================================================

/*
 * Every non-internal actor who has authenticated, and what became of them.
 *
 * `first_app_version` carries the same warning it does in acquisition
 * coverage: behaviour is only comparable within a build, because what a build
 * could do bounds what its users could reach.
 *
 * FRIENDSHIPS ARE READ FROM THE GRAPH, NOT FROM EVENTS. `friendships` is
 * symmetric - `create_friendship` writes both directions - so one row per
 * actor is enough and `min(created_at)` is genuinely their first.
 *
 * NULL means "has not happened", never "did not measure". Every column below
 * is derived from a fact that exists for everybody or from an absence that is
 * itself the answer.
 */
create or replace view public.activation_actor_v as
with authenticated as (
  select
    e.actor_id,
    e.environment,
    min(e.occurred_at) filter (where e.event_name = 'authenticated_session_started')
                                                          as first_authenticated_at,
    (array_agg(e.app_version order by e.occurred_at))[1]   as first_app_version,
    -- The milestones, from events that have existed since M3A and M5A.
    min(e.occurred_at) filter (where e.event_name = 'friend_presence_impression')
                                                          as first_friend_presence_at,
    min(e.occurred_at) filter (where e.event_name = 'gravity_cluster_impression')
                                                          as first_gravity_at,
    min(e.occurred_at) filter (where e.event_name = 'join_arrived')
                                                          as first_join_arrival_at,
    min(e.occurred_at) filter (where e.event_name = 'channel_dwell_ended')
                                                          as first_dwell_at,
    max(e.occurred_at)                                    as last_seen_at,
    count(distinct (e.occurred_at at time zone 'utc')::date)::int as active_days
  from public.analytics_reportable_events_v e
  group by e.actor_id, e.environment
),
graph as (
  select f.user_id as actor_id, min(f.created_at) as first_friendship_at
  from public.friendships f
  group by f.user_id
),
/*
 * The socially initiated JOIN, borrowed from M3D rather than redefined.
 *
 * `m3d_social_joins_v` already encodes what "social" means - a join_clicked
 * that navigated, minted an attribution, and had somebody else there. A second
 * definition here would drift from it, and the two would quietly disagree about
 * the most important step in the funnel.
 */
social as (
  select j.actor_id, min(j.occurred_at) as first_social_join_at
  from public.m3d_social_joins_v j
  group by j.actor_id
)
select
  a.actor_id,
  a.environment,
  a.first_app_version,
  a.first_authenticated_at,
  g.first_friendship_at,
  a.first_friend_presence_at,
  a.first_gravity_at,
  s.first_social_join_at,
  a.first_join_arrival_at,
  a.first_dwell_at,
  a.last_seen_at,
  a.active_days,
  /*
   * THE COLD-START POPULATION. No friendship row has ever existed for this
   * person, so Watchside's social value was never reachable for them. This is
   * the thing that used to be invisible.
   */
  (g.first_friendship_at is null)                          as still_without_friends,
  /* How long the cold start lasted, for those who escaped it. */
  (g.first_friendship_at - a.first_authenticated_at)        as time_to_first_friend
from authenticated a
left join graph  g on g.actor_id = a.actor_id
left join social s on s.actor_id = a.actor_id
where a.first_authenticated_at is not null;

comment on view public.activation_actor_v is
  'One row per non-internal actor who has ever authenticated, with the cold-start '
  'state read from the friend graph rather than from telemetry. `still_without_friends` '
  'is the population whose Watchside never became usable. Internal actors excluded.';

-- ===========================================================================
-- 2. THE FUNNEL, OVER A DENOMINATOR THAT CANNOT EXCLUDE THE FAILURES
-- ===========================================================================

/*
 * Each stage counted against ALL authenticated actors, never against the
 * survivors of the stage before.
 *
 * That is the whole design. A funnel whose stages each divide by the previous
 * one reports conversion between steps and hides how many people never entered;
 * this reports what share of everyone who signed in ever reached each thing. If
 * cold start is failing, `friended_rate` falls and every rate below it falls
 * with it, which is exactly the signal that was missing.
 *
 * Rates are NULL below three actors, matching 0035, 0038 and 0040: a rate over
 * two people is that person's behaviour wearing a percentage sign.
 */
create or replace view public.activation_funnel_v as
select
  environment,
  first_app_version,
  count(*)::int                                                   as authenticated_actors,
  count(*) filter (where still_without_friends)::int              as never_made_a_friend,
  count(*) filter (where first_friendship_at is not null)::int    as made_a_friend,
  count(*) filter (where first_friend_presence_at is not null)::int as saw_a_friend_watching,
  count(*) filter (where first_gravity_at is not null)::int       as saw_a_gathering,
  count(*) filter (where first_social_join_at is not null)::int   as joined_socially,
  count(*) filter (where first_join_arrival_at is not null)::int  as arrived,
  count(*) filter (where first_dwell_at is not null)::int         as watched,
  count(*) filter (where active_days > 1)::int                    as returned,
  case when count(*) >= 3
       then round(count(*) filter (where first_friendship_at is not null)::numeric
                  / count(*), 4) end                              as friended_rate,
  case when count(*) >= 3
       then round(count(*) filter (where first_social_join_at is not null)::numeric
                  / count(*), 4) end                              as social_join_rate,
  /* The headline this exists to make sayable. */
  case when count(*) >= 3
       then round(count(*) filter (where still_without_friends)::numeric
                  / count(*), 4) end                              as cold_start_rate,
  percentile_disc(0.5) within group (order by time_to_first_friend)
                                                                  as median_time_to_first_friend,
  min(first_authenticated_at)                                     as first_seen_at,
  max(last_seen_at)                                               as last_seen_at
from public.activation_actor_v
group by environment, first_app_version;

comment on view public.activation_funnel_v is
  'Activation measured against EVERY authenticated actor, not against the '
  'survivors of the previous stage - so a user who signed in, found an empty '
  'panel and left is counted in every denominator. `cold_start_rate` is the '
  'share who never formed a single friendship. Rates NULL below 3 actors.';

-- ===========================================================================
-- The contract version.
-- ===========================================================================

create or replace function public.analytics_schema_version()
returns int
language sql
immutable
set search_path = public, pg_temp
as $$ select 42; $$;

revoke all on function public.analytics_schema_version() from public, anon, authenticated;

commit;
