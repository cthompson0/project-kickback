-- ===========================================================================
-- 0031 — M3C.1: observed stream dwell
--
-- The M3C.1 correction. 0030 registered `channel_dwell_ended` as a
-- focused-tab-only measurement: one interval at a time, so a viewer with two
-- streams open had one of them discarded. That protected the headline number
-- by destroying evidence nobody could recover later.
--
-- Dwell is now PER STREAM and concurrent streams both accrue. Two streams open
-- for an hour are two observed stream-hours and one wall-clock hour, and this
-- file is where the difference between those two sentences is made computable
-- rather than left to whoever writes the query.
--
-- WHAT CHANGES
--
--   contract   channel_dwell_ended gains focused_duration_ms and
--              background_duration_ms. Data, not DDL - one array widened.
--   views      analytics_stream_dwell_v      one row per observed interval
--              analytics_viewing_daily_v     stream-minutes vs wall-clock
--
-- NO DESTRUCTIVE STATEMENT. 0030 is not edited; a migration that has been
-- applied is history. Nothing is dropped except the two views this file owns.
--
-- ZERO PRODUCTION DATA EXISTS for channel_dwell_ended at the time of writing,
-- which is why the contract can be corrected rather than versioned around.
-- ===========================================================================

begin;

-- ------------------------------------------------------------- the contract

insert into public.analytics_event_names (name, description, allowed_properties) values
  /*
   * One observed stream-dwell interval.
   *
   * PER STREAM. A viewer with three eligible live streams open produces three
   * intervals, concurrently. Summing them gives STREAM-minutes, which is not
   * the same quantity as minutes spent watching Twitch - the union of the
   * intervals is. analytics_viewing_daily_v computes both so nobody has to
   * choose the wrong one by accident.
   *
   * FOCUS IS A DIMENSION, NOT A GATE. A stream on a second monitor is still
   * being consumed, so losing focus does not end an interval. Which stream was
   * in front of the viewer is carried alongside:
   *
   *   focused_duration_ms + background_duration_ms = duration_ms, exactly.
   *
   * Still nothing about the stream itself - no title, no category, no viewer
   * count. A duration, a channel login, and how it ended.
   */
  ('channel_dwell_ended',
   'One observed stream-dwell interval: how long Watchside could see one live Twitch stream. Per stream, so concurrent streams each accrue; focus is carried as a subduration rather than gating the interval.',
   array[
     'duration_ms',
     'focused_duration_ms',
     'background_duration_ms',
     'from_join',
     'had_social',
     'end_reason'
   ])
on conflict (name) do update
  set description        = excluded.description,
      allowed_properties = excluded.allowed_properties;

-- ------------------------------------------------------------------- views

drop view if exists public.analytics_viewing_daily_v;
drop view if exists public.analytics_stream_dwell_v;

/*
 * One row per observed stream-dwell interval, with its start reconstructed.
 *
 * THE RECONSTRUCTION, AND WHY NO EXTRA TELEMETRY WAS NEEDED. The event is
 * dated to the EFFECTIVE end and carries the duration, so
 *
 *   started_at = occurred_at - duration_ms
 *
 * exactly. That is enough to answer every concurrency and wall-clock question
 * below, which is why M3C.1 added two subduration properties and no new event.
 *
 * GRAIN: one interval. An actor may have several overlapping rows at once, and
 * that is the point rather than a defect.
 *
 * UNIT: milliseconds. Sum these and you have STREAM-milliseconds.
 */
create view public.analytics_stream_dwell_v as
select
  e.id                                              as dwell_event_id,
  e.actor_id,
  e.environment,
  e.app_version,
  e.session_id,
  e.destination_channel,
  e.attribution_id,
  e.occurred_at                                     as ended_at,
  e.occurred_at
    - make_interval(secs => (e.properties ->> 'duration_ms')::bigint / 1000.0)
                                                    as started_at,
  (e.properties ->> 'duration_ms')::bigint          as duration_ms,
  (e.properties ->> 'focused_duration_ms')::bigint  as focused_duration_ms,
  (e.properties ->> 'background_duration_ms')::bigint as background_duration_ms,
  (e.properties ->> 'from_join') = 'true'           as from_join,
  (e.properties ->> 'had_social') = 'true'          as had_social,
  e.properties ->> 'end_reason'                     as end_reason,
  -- The interval itself, so overlap questions are range operations rather than
  -- hand-rolled timestamp arithmetic in every query that asks one.
  tstzrange(
    e.occurred_at - make_interval(secs => (e.properties ->> 'duration_ms')::bigint / 1000.0),
    e.occurred_at,
    '[)'
  )                                                 as observed_during
from public.analytics_reportable_events_v e
where e.event_name = 'channel_dwell_ended'
  and e.destination_channel is not null
  and e.properties ->> 'duration_ms' is not null;

/*
 * Stream-minutes and wall-clock minutes, side by side, per actor-day.
 *
 * THIS VIEW EXISTS TO STOP ONE SPECIFIC MISTAKE: quoting summed stream-minutes
 * as "time the user spent watching Twitch". They are different numbers, they
 * differ by exactly the concurrency, and putting both in one row means the
 * wrong one cannot be reached for by accident.
 *
 *   observed_stream_ms   sum of per-stream durations. Concurrency INFLATES it,
 *                        legitimately - two streams for an hour is two
 *                        stream-hours of Twitch consumption.
 *   wall_clock_ms        union of the intervals. Concurrency does NOT inflate
 *                        it. This is the one that may be described as time the
 *                        person was watching Twitch.
 *   concurrent_ms        observed_stream_ms - wall_clock_ms. How much of the
 *                        consumption happened alongside something else.
 *
 * The union is computed by the ordinary gaps-and-islands method: order the
 * intervals, start a new island whenever one begins after every previous one
 * has ended, then sum the islands.
 */
create view public.analytics_viewing_daily_v as
with intervals as (
  select
    actor_id,
    environment,
    (ended_at at time zone 'utc')::date as day,
    started_at,
    ended_at,
    duration_ms,
    focused_duration_ms,
    background_duration_ms,
    from_join,
    had_social,
    destination_channel
  from public.analytics_stream_dwell_v
),
marked as (
  select
    i.*,
    case
      when i.started_at > max(i.ended_at) over (
        partition by i.actor_id, i.environment, i.day
        order by i.started_at, i.ended_at
        rows between unbounded preceding and 1 preceding
      ) then 1
      else 0
    end as starts_island
  from intervals i
),
islands as (
  select
    m.*,
    sum(m.starts_island) over (
      partition by m.actor_id, m.environment, m.day
      order by m.started_at, m.ended_at
      rows unbounded preceding
    ) as island
  from marked m
),
island_spans as (
  select
    actor_id,
    environment,
    day,
    island,
    min(started_at) as island_start,
    max(ended_at)   as island_end
  from islands
  group by actor_id, environment, day, island
),
wall_clock as (
  select
    actor_id,
    environment,
    day,
    sum(extract(epoch from (island_end - island_start)) * 1000)::bigint as wall_clock_ms
  from island_spans
  group by actor_id, environment, day
),
totals as (
  select
    actor_id,
    environment,
    day,
    count(*)::int                                            as interval_count,
    count(distinct destination_channel)::int                 as distinct_channels,
    sum(duration_ms)                                         as observed_stream_ms,
    sum(focused_duration_ms)                                 as focused_stream_ms,
    sum(background_duration_ms)                              as background_stream_ms,
    sum(duration_ms) filter (where from_join)                as attributed_stream_ms,
    sum(duration_ms) filter (where had_social)               as social_stream_ms
  from intervals
  group by actor_id, environment, day
)
select
  t.actor_id,
  t.environment,
  t.day,
  t.interval_count,
  t.distinct_channels,
  t.observed_stream_ms,
  t.focused_stream_ms,
  t.background_stream_ms,
  t.attributed_stream_ms,
  t.social_stream_ms,
  w.wall_clock_ms,
  /*
   * Never negative: the union of a set of intervals cannot exceed their sum.
   * greatest() is a guard against clock skew between a client's occurred_at
   * values rather than an expected case.
   */
  greatest(t.observed_stream_ms - w.wall_clock_ms, 0) as concurrent_stream_ms
from totals t
join wall_clock w
  on  w.actor_id    = t.actor_id
  and w.environment = t.environment
  and w.day         = t.day;

-- ---------------------------------------------------------------- the revokes

revoke all on public.analytics_stream_dwell_v  from anon, authenticated;
revoke all on public.analytics_viewing_daily_v from anon, authenticated;

/*
 * The applied marker moves to the newest analytics-touching migration, so
 * verify:analytics can tell a database that stopped at 0030 from one fully up
 * to date. Everything else here is a view or a contract row, and both are
 * revoked from every client role and therefore invisible to that script.
 */
create or replace function public.analytics_schema_version()
returns int
language sql
immutable
set search_path = public, pg_temp
as $$ select 31; $$;

revoke all on function public.analytics_schema_version() from public, anon, authenticated;

commit;
