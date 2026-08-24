-- Kickback — 0016: reporting for the socially-attributed destination lifecycle
--
-- The lifecycle this is meant to make readable, end to end:
--
--   social exposure -> JOIN -> arrival -> watching together
--                   -> the social context dissolves
--                   -> post-social retention -> leaving the destination
--
-- Two views carry it, not three. `analytics_together_v` gains the post-social
-- interval, because that interval belongs to the shared watch it followed and
-- keeping them apart would mean joining them back together in every query.
-- `analytics_join_funnel_v` then reads the same lifecycle for the subset that
-- a JOIN brought about.
--
-- Dropped and recreated rather than CREATE OR REPLACE'd, for the reason 0014
-- gives: replacing a relation whose column list has changed fails with 42P13,
-- and a migration that only works on a database which has never seen an
-- earlier version of itself is not idempotent.

begin;

-- Dependants first: the funnel reads the together view.
drop view if exists public.analytics_join_funnel_v;
drop view if exists public.analytics_together_v;

-- ------------------------------------------------- shared watching, complete
--
-- One row per stretch of co-viewing, with what happened after it.
--
-- THE TWO TIMESTAMPS
--
--   effective_ended_at  when co-viewing actually stopped. This is the ended
--                       event's occurred_at, and what every duration is
--                       measured against.
--   detected_at         when the extension worked that out. Reconstructed by
--                       adding the recorded lag back on, so a late detection
--                       stays visible without ever being mistaken for the end.
--
-- A start with no end is still reported, with nulls, so an unfinished or lost
-- interval is visible rather than quietly dropped.

create view public.analytics_together_v as
select
  s.id                          as started_event_id,
  s.actor_id,
  s.environment,
  s.session_id,
  s.destination_channel,
  s.attribution_id,
  s.occurred_at                 as started_at,

  e.occurred_at                 as effective_ended_at,
  e.occurred_at
    + make_interval(secs => coalesce((e.properties ->> 'detection_delay_ms')::bigint, 0) / 1000.0)
                                as detected_at,
  make_interval(secs => coalesce((e.properties ->> 'detection_delay_ms')::bigint, 0) / 1000.0)
                                as detection_delay,

  -- From the events' own measurement, not from subtracting timestamps: the
  -- extension measured it on one clock, and that is the honest number.
  make_interval(secs => (e.properties ->> 'duration_ms')::bigint / 1000.0)
                                as duration,

  (s.properties ->> 'other_count')::int      as other_count_at_start,
  (e.properties ->> 'other_count_peak')::int as other_count_peak,
  (s.properties ->> 'from_join') = 'true'    as from_join,
  e.properties ->> 'end_reason'              as end_reason,

  -- ------------------------------------------------------ post-social
  --
  -- The stretch after the last co-viewer left and before the user left too.
  -- Null when there was none: they left at the same moment, or the interval
  -- is still open.
  make_interval(secs => (p.properties ->> 'duration_ms')::bigint / 1000.0)
                                as post_social_duration,
  p.properties ->> 'end_reason' as post_social_end_reason,
  p.occurred_at                 as destination_left_at,
  /*
   * Retained, as a fact rather than a judgement.
   *
   * True when the user was still on the destination after the social context
   * dissolved. HOW LONG is the next column; a query that wants "meaningfully
   * retained" should threshold on the duration rather than on this, because
   * a friend leaving two seconds before you do is retention of two seconds.
   */
  p.id is not null              as post_social_retained
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
left join lateral (
  select *
  from public.analytics_reportable_events_v y
  where y.event_name = 'post_social_retention_ended'
    and y.actor_id = s.actor_id
    and y.session_id is not distinct from s.session_id
    and y.destination_channel is not distinct from s.destination_channel
    -- Begins where the shared watch effectively ended, so it cannot be earlier.
    and e.occurred_at is not null
    and y.occurred_at >= e.occurred_at
  order by y.occurred_at
  limit 1
) p on true
where s.event_name = 'watching_together_started';

-- --------------------------------------------------------------- the funnel
--
-- click -> arrival -> shared watch -> post-social retention, joined on the
-- attribution id the client minted at the click. Deterministic: no timestamp
-- guessing anywhere in it.
--
-- Every column after `arrived_at` is null for a JOIN that never turned into
-- co-viewing, which is itself an answer worth having.

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
  -- Null until Social Gravity sets it; see 0015.
  c.properties ->> 'opportunity_key'              as opportunity_key,
  (c.properties ->> 'already_on_twitch') = 'true' as already_on_twitch,
  (c.properties ->> 'navigated') = 'true'         as navigated,

  a.occurred_at                                   as arrived_at,
  (a.properties ->> 'elapsed_ms')::int            as arrival_elapsed_ms,

  t.started_at                                    as together_started_at,
  t.effective_ended_at                            as together_effective_ended_at,
  t.detected_at                                   as together_detected_at,
  t.detection_delay                               as together_detection_delay,
  t.duration                                      as together_duration,
  t.other_count_peak                              as together_other_count_peak,
  t.end_reason                                    as together_end_reason,

  coalesce(t.post_social_retained, false)         as post_social_retained,
  t.post_social_duration,
  t.post_social_end_reason,
  t.destination_left_at
from public.analytics_reportable_events_v c
left join public.analytics_reportable_events_v a
  on a.event_name = 'join_arrived'
 and a.attribution_id = c.attribution_id
left join public.analytics_together_v t
  on t.attribution_id = c.attribution_id
where c.event_name = 'join_clicked'
  and c.attribution_id is not null;

-- ------------------------------------------------------- an applied marker
--
-- Everything 0015 and 0016 change is a contract row, a function body or a view
-- column - and all of those are revoked from clients, so `verify:analytics`
-- could see nothing to distinguish a database that had stopped at 0014 from
-- one fully up to date. It would have reported a half-applied schema as
-- healthy, which is precisely the failure mode that script exists to prevent.
--
-- So the newest analytics migration leaves a marker. It is revoked like
-- everything else: PostgREST answers PGRST202 when a function does not exist
-- and 42501 when it does but the caller may not run it, and telling those two
-- apart is all the check needs.
--
-- A later analytics migration should replace this with its own number.

create or replace function public.analytics_schema_version()
returns int
language sql
immutable
set search_path = public, pg_temp
as $fn$ select 16 $fn$;

revoke all on function public.analytics_schema_version() from public, anon, authenticated;

revoke all on public.analytics_together_v    from anon, authenticated;
revoke all on public.analytics_join_funnel_v from anon, authenticated;

commit;
