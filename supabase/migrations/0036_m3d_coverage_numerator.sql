-- ===========================================================================
-- 0036 — M3D: the coverage numerator must come from the coverage population
--
-- Found by Slice F's contract verification, reading the deployed SQL against
-- the documented contract rather than re-reading the report.
--
-- `m3d_coverage_v` counted observations like this:
--
--   count(o.attribution_id)                        as observed_baselines
--   count(*) filter (where m.measurement_eligible) as measurement_eligible
--
-- The denominator was filtered to the eligible population and the numerator was
-- not. So an observation attached to a JOIN the client had DECLINED to measure -
-- or to a pre-instrumentation JOIN with no status at all - still counted toward
-- coverage of the eligible population it was never part of.
--
-- Two consequences, both bad:
--
--   * the rate could exceed 100%, which is not a coverage rate at all
--   * even below 100% it silently overstated coverage, in the flattering
--     direction, by borrowing evidence from a different population
--
-- It had not yet shown up in production only because the historical JOINs that
-- would trigger it belong to an internal actor and are excluded. It would have
-- appeared as soon as post-instrumentation traffic mixed with the historical
-- rows - which is to say, immediately after this became useful.
--
-- The fix is one FILTER. The numerator and the denominator now describe the
-- same JOINs.
-- ===========================================================================

begin;

drop view if exists public.m3d_missingness_v cascade;
drop view if exists public.m3d_coverage_v cascade;

/*
 * COVERAGE — of the JOINs we judged measurable, how many do we hold a baseline
 * for?
 *
 * `coverage_rate` is NULL when nothing was eligible, never 0: a zero reads as
 * "we measured none of them" when the truth is "there was nothing to measure",
 * and the two must not look alike in a chart.
 *
 * `observed_outside_eligible` is reported rather than discarded. It is not part
 * of coverage, but a non-zero value is worth seeing - it means baselines exist
 * for JOINs the client did not judge measurable, which today is history and
 * tomorrow would be a bug.
 */
create view public.m3d_coverage_v as
select
  m.environment,
  count(*)                                            as social_joins,
  count(*) filter (where m.client_status is null)     as status_missing,
  count(*) filter (where m.measurement_eligible)      as measurement_eligible,
  count(*) filter (where m.client_status = 'not_ready')       as skipped_not_ready,
  count(*) filter (where m.client_status = 'unacknowledged')  as skipped_unacknowledged,
  -- The numerator, drawn from the SAME population as the denominator.
  count(o.attribution_id) filter (where m.measurement_eligible)
                                                      as observed_baselines,
  count(o.attribution_id) filter (where not coalesce(m.measurement_eligible, false))
                                                      as observed_outside_eligible,
  case
    when count(*) filter (where m.measurement_eligible) = 0 then null
    else round(
      count(o.attribution_id) filter (where m.measurement_eligible)::numeric
        / count(*) filter (where m.measurement_eligible),
      4)
  end                                                 as coverage_rate
from public.m3d_measurement_v m
left join public.m3d_observations_v o
  on o.actor_id = m.actor_id
 and o.attribution_id = m.attribution_id
group by m.environment;

revoke all on public.m3d_coverage_v from public, anon, authenticated;
grant select on public.m3d_coverage_v to service_role;

comment on view public.m3d_coverage_v is
  'Of the socially initiated JOINs the client judged measurable, how many have a '
  'currently retained follow baseline. Numerator and denominator describe the '
  'same JOINs; the denominator is a client-reported decision.';

-- ---------------------------------------------------------------------------
-- Measured against unmeasured, on dimensions that already exist.
-- ---------------------------------------------------------------------------

/*
 * The comparison Slice E said must be run before the headline may be spoken.
 *
 * It answers one question: do the eligible JOINs we managed to measure look
 * like the eligible JOINs we did not? If they differ systematically, the
 * relationship share describes the measured subset and not social JOINs in
 * general - and nothing downstream would reveal that on its own.
 *
 * DIMENSIONS ARE REUSED, NEVER ADDED. Environment and source surface are
 * already on every event; social_count is already on the JOIN. No new tracking
 * was introduced for this, and none should be: fingerprinting, geography or a
 * device profile would each be a larger privacy cost than the analysis is
 * worth.
 *
 * What is deliberately NOT here: anything per-user, per-creator, or fine enough
 * to identify. This is a shape comparison between two buckets.
 */
create view public.m3d_missingness_v as
select
  m.environment,
  m.source,
  case when o.attribution_id is not null then 'measured' else 'unmeasured' end as bucket,
  count(*)                                as eligible_joins,
  round(avg(j.social_count), 2)           as mean_social_count,
  min(j.occurred_at)                      as first_join,
  max(j.occurred_at)                      as last_join
from public.m3d_measurement_v m
join public.m3d_social_joins_v j
  on j.actor_id = m.actor_id
 and j.attribution_id = m.attribution_id
left join public.m3d_observations_v o
  on o.actor_id = m.actor_id
 and o.attribution_id = m.attribution_id
where m.measurement_eligible
group by m.environment, m.source, (o.attribution_id is not null);

revoke all on public.m3d_missingness_v from public, anon, authenticated;
grant select on public.m3d_missingness_v to service_role;

comment on view public.m3d_missingness_v is
  'Eligible JOINs split by whether a baseline was obtained, on dimensions that '
  'already existed. Answers whether the measured subset resembles the unmeasured '
  'one; it does not establish that it does.';

create or replace function public.analytics_schema_version()
returns int
language sql
immutable
set search_path = public, pg_temp
as $$ select 36; $$;

revoke all on function public.analytics_schema_version() from public, anon, authenticated;

commit;
