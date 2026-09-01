-- ===========================================================================
-- 0034 — M3D: coverage before the headline, and a narrower deletion
--
-- Slice D proved Watchside CAN obtain a trustworthy follow baseline. This is
-- about whether the resulting numbers can be INTERPRETED, which is a different
-- and harder question.
--
-- THE PROBLEM THIS SOLVES
--
-- A socially initiated JOIN with no observation is ambiguous. It could have
-- been ineligible, or eligible and declined, or eligible and asked with nothing
-- coming back, or measured and later deleted by the Twitch lifecycle. Those are
-- different facts, and the observation table cannot tell them apart, because
-- absence is absence.
--
-- So a percentage computed over "JOINs" would have a denominator nobody could
-- defend. `join_measurement_status` records what M3D decided for each socially
-- initiated JOIN, and the views below keep the two questions separate:
--
--   COVERAGE      of the JOINs we judged measurable, how many do we hold a
--                 baseline for?
--   RELATIONSHIP  among the baselines we currently hold, how many went to
--                 creators the viewer did not already follow?
--
-- The relationship denominator is RETAINED observations, never all JOINs and
-- never all eligible JOINs. That makes the headline smaller and honest, and it
-- means historical percentages legitimately change when Twitch-derived data is
-- deleted - which is the correct behaviour, not a defect.
--
-- WHAT IS DELIBERATELY NOT HERE
--
-- Any COALESCE of relationship_present. A null is a failed or absent check and
-- must never become "did not follow"; every view below filters nulls out of
-- both numerator and denominator rather than folding them into either.
-- ===========================================================================

begin;

-- ---------------------------------------------------------------------------
-- The coverage event.
-- ---------------------------------------------------------------------------

/*
 * Watchside's own decision about its own measurement.
 *
 * `attempted` means the client asked the server. It is NOT evidence that Twitch
 * answered - that fact lives only in creator_relationship_observations - and
 * the naming keeps the two apart on purpose. Because it never holds an answer,
 * it carries nothing Twitch-derived and correctly survives a deauthorization,
 * exactly as the JOIN it describes does.
 */
insert into public.analytics_event_names (name, description, allowed_properties) values
  ('join_measurement_status',
   'What M3D decided to do about one socially initiated JOIN. Client-side decision; never a follow result.',
   array['status'])
on conflict (name) do update
  set description        = excluded.description,
      allowed_properties = excluded.allowed_properties;

-- ---------------------------------------------------------------------------
-- Confirmed scope loss: a narrower deletion than deauthorization.
-- ---------------------------------------------------------------------------

/*
 * Deletes the Twitch-derived observations and NOTHING else.
 *
 * Distinct from purge_twitch_derived, which also destroys the credential. The
 * difference matters: losing `user:read:follows` is not losing authorization.
 * The credential remains valid for what it still carries, and readiness will
 * correctly report `needs_follow_permission` rather than "broken" - so the user
 * is not pushed through a repair flow for a permission they simply withdrew.
 *
 * WHAT MAY CALL THIS
 *
 * Only an AUTHORITATIVE observation that the scope is gone: a SUCCESSFUL Twitch
 * response whose scope list omits it. A timeout, a 5xx, a network error, a
 * malformed body or an ambiguous 401/403 are none of them evidence of anything,
 * and must never reach here - a transient failure that deleted user data would
 * be far worse than a missing measurement.
 */
create or replace function public.purge_creator_relationships(p_actor uuid)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_observations integer := 0;
begin
  if p_actor is null then
    return jsonb_build_object('observations', 0, 'actor', false);
  end if;

  delete from public.creator_relationship_observations where actor_id = p_actor;
  get diagnostics v_observations = row_count;

  -- Idempotent, like its sibling: a second confirmation deletes nothing further
  -- and still succeeds.
  return jsonb_build_object('observations', v_observations, 'actor', true);
end;
$$;

revoke all on function public.purge_creator_relationships(uuid) from public, anon, authenticated;
grant execute on function public.purge_creator_relationships(uuid) to service_role;

comment on function public.purge_creator_relationships(uuid) is
  'Deletes an actor''s Twitch-derived follow baselines, leaving the credential '
  'and all Watchside-owned analytics intact. For CONFIRMED scope removal only.';

-- ---------------------------------------------------------------------------
-- The reporting lens.
-- ---------------------------------------------------------------------------

drop view if exists public.m3d_relationship_v      cascade;
drop view if exists public.m3d_coverage_v          cascade;
drop view if exists public.m3d_observations_v      cascade;
drop view if exists public.m3d_measurement_v       cascade;
drop view if exists public.m3d_social_joins_v      cascade;

/*
 * POPULATION A — socially initiated JOINs.
 *
 * The canonical model, unchanged: a join_clicked that navigated, minted an
 * attribution, and had somebody else there. Built on the reportable view, so
 * internal accounts are excluded exactly as they are everywhere else.
 */
create view public.m3d_social_joins_v as
select
  e.actor_id,
  e.attribution_id,
  e.destination_channel,
  e.occurred_at,
  e.environment,
  e.source,
  coalesce((e.properties ->> 'social_count')::integer, 0) as social_count
from public.analytics_reportable_events_v e
where e.event_name = 'join_clicked'
  and e.attribution_id is not null
  and coalesce((e.properties ->> 'navigated')::boolean, false)
  and coalesce((e.properties ->> 'social_count')::integer, 0) > 0;

/*
 * POPULATION B — what M3D decided, per socially initiated JOIN.
 *
 * `status` is the CLIENT's decision and is named as such wherever it is read.
 * Eligibility is defined by this decision, NOT by whether an observation
 * exists: an observation is an outcome of measurement, and defining the
 * denominator by the outcome would make coverage tautologically 100%.
 */
create view public.m3d_measurement_v as
select
  j.actor_id,
  j.attribution_id,
  j.destination_channel,
  j.occurred_at,
  j.environment,
  j.source,
  s.properties ->> 'status' as client_status,
  (s.properties ->> 'status') = 'attempted' as measurement_eligible
from public.m3d_social_joins_v j
left join public.analytics_reportable_events_v s
  on s.event_name = 'join_measurement_status'
 and s.actor_id = j.actor_id
 and s.attribution_id = j.attribution_id;

/*
 * POPULATION C — retained baselines, and only retained ones.
 *
 * `relationship_present is not null` is the whole definition of "observed". A
 * row written without an answer is not a measurement, and a row deleted by the
 * Twitch lifecycle stops being one - which is why this reads the table live
 * rather than anything cached.
 */
create view public.m3d_observations_v as
select
  o.actor_id,
  o.attribution_id,
  o.broadcaster_login,
  o.observed_at,
  o.relationship_present
from public.creator_relationship_observations o
join public.analytics_actors a on a.user_id = o.actor_id
where not a.is_internal
  and o.attribution_id is not null
  and o.relationship_present is not null;

/*
 * COVERAGE — asked before the headline is allowed.
 *
 * `coverage_rate` is NULL when nothing was eligible, never 0. A zero would read
 * as "we measured none of them" when the truth is "there was nothing to
 * measure", and the two must not look alike in a chart.
 */
create view public.m3d_coverage_v as
select
  m.environment,
  count(*)                                            as social_joins,
  count(*) filter (where m.client_status is null)     as status_missing,
  count(*) filter (where m.measurement_eligible)      as measurement_eligible,
  count(*) filter (where m.client_status = 'not_ready')       as skipped_not_ready,
  count(*) filter (where m.client_status = 'unacknowledged')  as skipped_unacknowledged,
  count(o.attribution_id)                             as observed_baselines,
  case
    when count(*) filter (where m.measurement_eligible) = 0 then null
    else round(
      count(o.attribution_id)::numeric
        / count(*) filter (where m.measurement_eligible),
      4)
  end                                                 as coverage_rate
from public.m3d_measurement_v m
left join public.m3d_observations_v o
  on o.actor_id = m.actor_id
 and o.attribution_id = m.attribution_id
group by m.environment;

/*
 * THE RELATIONSHIP RESULT — over RETAINED observations only.
 *
 * The denominator is deliberately the smallest defensible one. Not all JOINs,
 * not all eligible JOINs, not all users: only the baselines currently held. A
 * JOIN we could not measure tells us nothing about follow state and must not
 * silently become a "did not follow".
 *
 * `not_followed_share` is NULL rather than 0 when there is nothing to divide,
 * for the same reason coverage_rate is.
 */
create view public.m3d_relationship_v as
select
  environment,
  count(*)                                                   as retained_baselines,
  count(*) filter (where relationship_present)               as followed_at_baseline,
  count(*) filter (where not relationship_present)           as not_followed_at_baseline,
  case
    when count(*) = 0 then null
    else round(count(*) filter (where not relationship_present)::numeric / count(*), 4)
  end                                                        as not_followed_share
from (
  select o.relationship_present, j.environment
  from public.m3d_observations_v o
  join public.m3d_social_joins_v j
    on j.actor_id = o.actor_id
   and j.attribution_id = o.attribution_id
) bound
group by environment;

-- ---------------------------------------------------------------------------
-- Owner-only, like everything else under it.
-- ---------------------------------------------------------------------------

revoke all on public.m3d_social_joins_v  from public, anon, authenticated;
revoke all on public.m3d_measurement_v   from public, anon, authenticated;
revoke all on public.m3d_observations_v  from public, anon, authenticated;
revoke all on public.m3d_coverage_v      from public, anon, authenticated;
revoke all on public.m3d_relationship_v  from public, anon, authenticated;

grant select on public.m3d_social_joins_v  to service_role;
grant select on public.m3d_measurement_v   to service_role;
grant select on public.m3d_observations_v  to service_role;
grant select on public.m3d_coverage_v      to service_role;
grant select on public.m3d_relationship_v  to service_role;

-- ---------------------------------------------------------------------------
-- Schema marker.
-- ---------------------------------------------------------------------------

create or replace function public.analytics_schema_version()
returns int
language sql
immutable
set search_path = public, pg_temp
as $$ select 34; $$;

revoke all on function public.analytics_schema_version() from public, anon, authenticated;

commit;
