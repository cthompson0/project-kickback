-- ===========================================================================
-- 0035 — M3D: a share of one is not a share
--
-- 0034 shipped `m3d_relationship_v` with the correct denominator and a real
-- leak in it. With one retained baseline, `not_followed_share` is 0 or 1 - and
-- that IS the individual's follow state, printed as a percentage. The same is
-- true of the two counts beside it. Everything M3D does to keep the follow
-- answer server-side is undone by a reporting view that divides one row by
-- itself.
--
-- It was caught before the view was ever read for its numbers, and the honest
-- fix is in the view rather than in a habit of not looking. A metric that is
-- only safe when somebody remembers to be careful is not safe.
--
-- WHAT THIS CHANGES
--
-- The breakdown - followed, not-followed, and the share - is withheld until
-- the aggregate is genuinely an aggregate. `retained_baselines` is still
-- reported at any size, because a count of measurements is not a relationship
-- and coverage needs it.
--
-- THE THRESHOLD IS PROVISIONAL
--
-- Ten baselines across at least three actors, chosen to be clearly past the
-- point where a row identifies a person and honest about being a first pass.
-- Two conditions rather than one because ten baselines from a single actor is
-- still one person's viewing, and a count alone cannot tell the difference.
-- ===========================================================================

begin;

drop view if exists public.m3d_relationship_v cascade;

/*
 * THE RELATIONSHIP RESULT — over retained observations, and only when the
 * result is about a population rather than a person.
 *
 * Nulls remain excluded from both numerator and denominator: a failed or absent
 * check is not a "did not follow", and no COALESCE appears anywhere here.
 */
create view public.m3d_relationship_v as
select
  environment,
  count(*)                                              as retained_baselines,
  count(distinct actor_id)                              as measured_actors,
  /*
   * Suppressed below the threshold, and suppressed as NULL rather than 0.
   *
   * A zero would read as "nobody followed them", which is a claim; NULL reads
   * as "not enough to say", which is the truth.
   */
  case when count(*) >= 10 and count(distinct actor_id) >= 3
       then count(*) filter (where relationship_present) end
                                                        as followed_at_baseline,
  case when count(*) >= 10 and count(distinct actor_id) >= 3
       then count(*) filter (where not relationship_present) end
                                                        as not_followed_at_baseline,
  case when count(*) >= 10 and count(distinct actor_id) >= 3
       then round(count(*) filter (where not relationship_present)::numeric / count(*), 4) end
                                                        as not_followed_share,
  (count(*) >= 10 and count(distinct actor_id) >= 3)     as reportable
from (
  select o.relationship_present, o.actor_id, j.environment
  from public.m3d_observations_v o
  join public.m3d_social_joins_v j
    on j.actor_id = o.actor_id
   and j.attribution_id = o.attribution_id
) bound
group by environment;

revoke all on public.m3d_relationship_v from public, anon, authenticated;
grant select on public.m3d_relationship_v to service_role;

comment on view public.m3d_relationship_v is
  'Follow-baseline outcome over CURRENTLY RETAINED observations. The breakdown '
  'is withheld until at least 10 baselines across at least 3 actors, because '
  'below that the share is an individual''s follow state.';

create or replace function public.analytics_schema_version()
returns int
language sql
immutable
set search_path = public, pg_temp
as $$ select 35; $$;

revoke all on function public.analytics_schema_version() from public, anon, authenticated;

commit;
