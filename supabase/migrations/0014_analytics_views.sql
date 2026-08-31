-- Kickback — 0014: reporting views over the analytics events
--
-- Separate from 0013 on purpose. The write path is a contract that other
-- software depends on; reporting is a lens that will be reshaped often. Views
-- live here so reshaping one never means editing the file that defines the
-- table.
--
-- Every view is dropped and recreated rather than CREATE OR REPLACE'd. That is
-- the lesson from 0008: replacing a relation whose column list has changed
-- fails with 42P13, and a migration that only applies to a database which has
-- never seen an earlier version of itself is not idempotent. Dropping first is
-- always safe here because a view holds no data.
--
-- Views are owner-only, like the tables under them. Nothing in the extension
-- reads any of this.

begin;

-- Dependency order: dependants first, and CASCADE.
--
-- WHY CASCADE. These are the base views every later analytics view is built
-- on, and the bundle must be safe to re-run - see tests/db/bundle.test.ts. A
-- migration numbered after this one cannot drop its own views before this file
-- runs, so without CASCADE the FIRST view anybody adds on top of these makes
-- the second bundle pass fail with "cannot drop view ... because other objects
-- depend on it". That is exactly what 0029 hit.
--
-- Naming the dependants here instead would work until somebody forgot to add
-- one, which is a stale list waiting to be a bug. CASCADE cannot go stale, and
-- it is safe for the same reason the drops themselves are: a view holds no
-- data, and everything dropped is recreated later in the same bundle.
-- Dependency order is still respected below, so CASCADE is a backstop rather
-- than the mechanism.
drop view if exists public.analytics_production_events_v cascade;
drop view if exists public.analytics_actor_days_v          cascade;
drop view if exists public.analytics_join_funnel_v         cascade;
drop view if exists public.analytics_together_v            cascade;
drop view if exists public.analytics_sessions_v            cascade;
drop view if exists public.analytics_reportable_events_v   cascade;

-- --------------------------------------------------------------- base views

/*
 * Every event, minus the people building Kickback.
 *
 * `environment` is deliberately still a column rather than being filtered
 * here: which environment a number came from is exactly the thing that must
 * never be invisible, so every query has to name it. Use
 * analytics_production_events_v when the answer is meant to be public.
 */
create view public.analytics_reportable_events_v as
select e.*
from public.analytics_events e
join public.analytics_actors a on a.user_id = e.actor_id
where not a.is_internal;

/** The safe default: public build, real users, nothing from the beta ZIP. */
create view public.analytics_production_events_v as
select * from public.analytics_reportable_events_v
where environment = 'production';

-- ------------------------------------------------------------------ sessions
--
-- Derived, not stored. A session is whatever events share its id: it began at
-- the first one and ended at the last. `extension_session_ended` is emitted
-- best-effort - a browser that is killed never sends one - so duration is read
-- from the events themselves and the explicit end is only a cross-check.

create view public.analytics_sessions_v as
select
  e.session_id,
  e.actor_id,
  min(e.environment)                  as environment,
  min(e.app_version)                  as app_version,
  min(e.occurred_at)                  as started_at,
  max(e.occurred_at)                  as last_event_at,
  max(e.occurred_at) - min(e.occurred_at) as observed_duration,
  count(*)                            as event_count,
  bool_or(e.event_name = 'extension_session_ended')       as ended_cleanly,
  bool_or(e.event_name = 'authenticated_session_started') as authenticated,
  bool_or(e.event_name = 'join_clicked')                  as had_join_click,
  bool_or(e.event_name = 'join_arrived')                  as had_join_arrival,
  bool_or(e.event_name = 'watching_together_started')     as had_watching_together,
  bool_or(e.event_name = 'gathering_impression')          as had_gathering_impression,
  bool_or(e.event_name = 'gathering_notification_clicked') as had_notification_click,
  -- Descriptive, never "incremental": this says the user was already on Twitch
  -- when they clicked, not that Kickback caused anything. See docs/ANALYTICS.md.
  bool_or(e.event_name = 'join_clicked'
          and (e.properties ->> 'already_on_twitch') = 'true') as joined_from_twitch
from public.analytics_reportable_events_v e
where e.session_id is not null
group by e.session_id, e.actor_id;

-- ------------------------------------------------------------ shared watching
--
-- One row per shared-watch stretch, pairing each start with the end that
-- followed it. A start with no end is still reported, with a null duration, so
-- unfinished sessions are visible rather than quietly dropped.

create view public.analytics_together_v as
select
  s.id                        as started_event_id,
  s.actor_id,
  s.environment,
  s.session_id,
  s.destination_channel,
  s.attribution_id,
  s.occurred_at               as started_at,
  e.occurred_at               as ended_at,
  e.occurred_at - s.occurred_at as duration,
  (s.properties ->> 'other_count')::int      as other_count_at_start,
  (e.properties ->> 'other_count_peak')::int as other_count_peak,
  (s.properties ->> 'from_join') = 'true'    as from_join,
  e.properties ->> 'end_reason'              as end_reason
from public.analytics_reportable_events_v s
left join lateral (
  select *
  from public.analytics_reportable_events_v x
  where x.event_name = 'watching_together_ended'
    and x.actor_id = s.actor_id
    and x.session_id is not distinct from s.session_id
    and x.destination_channel is not distinct from s.destination_channel
    and x.occurred_at >= s.occurred_at
  order by x.occurred_at
  limit 1
) e on true
where s.event_name = 'watching_together_started';

-- ------------------------------------------------------------------ the funnel
--
-- click -> arrival -> shared watch, joined on the attribution id the client
-- minted at the click. Deterministic: no timestamp guessing.

create view public.analytics_join_funnel_v as
select
  c.attribution_id,
  c.actor_id,
  c.environment,
  c.session_id,
  c.source,
  c.destination_channel,
  c.occurred_at                                   as clicked_at,
  (c.properties ->> 'social_count')::int          as social_count,
  (c.properties ->> 'already_on_twitch') = 'true' as already_on_twitch,
  (c.properties ->> 'navigated') = 'true'         as navigated,
  a.occurred_at                                   as arrived_at,
  (a.properties ->> 'elapsed_ms')::int            as arrival_elapsed_ms,
  t.started_at                                    as together_started_at,
  t.duration                                      as together_duration
from public.analytics_reportable_events_v c
left join public.analytics_reportable_events_v a
  on a.event_name = 'join_arrived'
 and a.attribution_id = c.attribution_id
left join public.analytics_together_v t
  on t.attribution_id = c.attribution_id
where c.event_name = 'join_clicked'
  and c.attribution_id is not null;

-- --------------------------------------------------------------- actor days
--
-- The grain every retention and active-user question is built from: one row
-- per person per day they did anything, with their first day alongside so
-- D1/D7/D30 is a subtraction rather than a self-join.

create view public.analytics_actor_days_v as
select
  e.actor_id,
  e.environment,
  (e.occurred_at at time zone 'utc')::date as day,
  min(f.first_day)                          as first_day,
  ((e.occurred_at at time zone 'utc')::date - min(f.first_day)) as day_index,
  count(*)                                  as event_count
from public.analytics_reportable_events_v e
join lateral (
  select min((x.occurred_at at time zone 'utc')::date) as first_day
  from public.analytics_reportable_events_v x
  where x.actor_id = e.actor_id
    and x.environment = e.environment
) f on true
group by e.actor_id, e.environment, (e.occurred_at at time zone 'utc')::date;

revoke all on public.analytics_reportable_events_v from anon, authenticated;
revoke all on public.analytics_production_events_v from anon, authenticated;
revoke all on public.analytics_sessions_v          from anon, authenticated;
revoke all on public.analytics_together_v          from anon, authenticated;
revoke all on public.analytics_join_funnel_v       from anon, authenticated;
revoke all on public.analytics_actor_days_v        from anon, authenticated;

commit;
