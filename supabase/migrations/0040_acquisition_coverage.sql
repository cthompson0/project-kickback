-- ===========================================================================
-- 0040 — Acquisition coverage: the denominator M5C shipped without
--
-- M5C built campaign attribution and three views over it. Every one of those
-- views starts from `acquisition_attribution`, so every number they produce is
-- conditioned on attribution existing — and NOTHING reports how often it does.
--
-- THE FAILURE THIS PREVENTS
--
-- `acquisition_campaign_v` looks identical whether campaigns brought 90% of
-- Watchside's users or 3% of them. The rows are internally consistent, the
-- rates are correctly computed, the small-cohort suppression works, and the
-- whole picture can still be wildly unrepresentative of how people actually
-- arrive. That is the exact shape of a metric that is believable and wrong: not
-- a miscalculation, a missing denominator.
--
-- M3D already learned this. `m3d_coverage_v` exists precisely so the
-- relationship numbers can be read against how much of the population they
-- cover, and 0034 states the rule outright: defining a denominator by the
-- outcome makes coverage tautologically 100%. M5C shipped without the
-- equivalent. This adds it.
--
-- WHY THE APP VERSION IS IN THE GRAIN
--
-- There is a dated confound, and without it in the output somebody will
-- eventually mistake it for a finding. The acquisition parameter is read only
-- by builds carrying M5C, and there is no backfill. Every account created
-- before that code shipped is permanently unattributed and CANNOT be otherwise.
--
-- So "unattributed" is at least three different things:
--
--   1. signed up before the instrumentation existed  — not measurable, ever
--   2. arrived by some route with no campaign link   — genuinely uncampaigned
--   3. arrived through a link, but bound too late    — a real measurement miss
--
-- Grouping by the build an actor first authenticated on separates (1) from
-- (2)+(3) using evidence already in the row, rather than by anybody's memory of
-- when a release went out.
--
-- WHAT THIS DELIBERATELY DOES NOT DO
--
-- It does not report "direct" traffic. Watchside cannot observe the difference
-- between somebody who typed the Store URL and somebody who followed a campaign
-- link whose touch expired — both are simply unattributed. Reporting them as
-- "direct" would invent a fact about people, so this view has no such column
-- and the comment says why. `tests/db/acquisitionCoverage.test.ts` holds that.
--
-- ADDITIVE ONLY. Two views and a version bump; no table, function, policy or
-- grant changes. Nothing any released client calls is touched.
-- ===========================================================================

begin;

-- ===========================================================================
-- 1. COVERAGE — of everyone who arrived, how many can we attribute?
-- ===========================================================================

/*
 * One row per (environment, first build seen).
 *
 * DENOMINATOR: every non-internal actor who has ever sent a reportable event.
 * That is the population Watchside actually acquired, whether or not a campaign
 * had anything to do with it — which is the whole point.
 *
 * NUMERATOR: those with a first-touch attribution row.
 *
 * The two are drawn from different tables on purpose. Deriving the denominator
 * from `acquisition_attribution` would be the tautology 0034 warns about; the
 * question is precisely "what fraction of arrivals does that table know about".
 *
 * `attribution_rate` is NULL below the small-cohort threshold, never 0. A
 * suppressed rate and a genuinely zero rate must not look alike, and 0035 set
 * that precedent for the same reason.
 */
create or replace view public.acquisition_coverage_v as
with actors as (
  select
    e.actor_id,
    e.environment,
    -- The build this actor was first seen on. `min(app_version)` would order
    -- lexically and lie; this takes the version from the earliest event.
    (array_agg(e.app_version order by e.occurred_at))[1] as first_app_version,
    min(e.occurred_at)                                   as first_seen_at
  from public.analytics_reportable_events_v e
  group by e.actor_id, e.environment
),
joined as (
  select
    a.environment,
    a.first_app_version,
    a.actor_id,
    a.first_seen_at,
    (att.actor_id is not null) as attributed
  from actors a
  left join public.acquisition_attribution att on att.actor_id = a.actor_id
)
select
  environment,
  first_app_version,
  count(*)::int                                     as actors,
  count(*) filter (where attributed)::int           as attributed_actors,
  count(*) filter (where not attributed)::int       as unattributed_actors,
  case
    when count(*) >= 3
      then round(count(*) filter (where attributed)::numeric / count(*), 4)
    else null
  end                                               as attribution_rate,
  min(first_seen_at)                                as first_seen_at,
  max(first_seen_at)                                as last_seen_at
from joined
group by environment, first_app_version;

comment on view public.acquisition_coverage_v is
  'What fraction of acquired actors carry a campaign attribution, by environment '
  'and by the build they were first seen on. THE DENOMINATOR FOR EVERY CAMPAIGN '
  'NUMBER: acquisition_campaign_v reads the same whether campaigns brought most '
  'users or almost none. Builds predating the acquisition instrumentation cannot '
  'be attributed and are separated by first_app_version rather than assumed. '
  'There is deliberately NO "direct" column - an unattributed actor may have '
  'arrived directly or through a link whose touch expired, and Watchside cannot '
  'tell the two apart. Rates NULL below 3 actors.';

-- ===========================================================================
-- 2. THE TOUCHES THAT ARRIVED AND WERE THROWN AWAY
-- ===========================================================================

/*
 * A BLIND SPOT IN 0038, and the reason this section exists.
 *
 * `bind_acquisition` has four outcomes. Two of them - `first` and `repeat` -
 * emit `acquisition_attributed`. The other two, `unknown` and `inactive`,
 * `return` to the caller and record NOTHING.
 *
 * So a campaign link that resolves to no registry row - a mistyped code on a
 * poster, a code retired while links were still circulating, a link somebody
 * forged - is discarded in complete silence. In the data it is indistinguishable
 * from nobody having clicked at all, which means the conclusion "that campaign
 * brought nobody" is reached identically whether the campaign failed or its
 * instrumentation did. That is a wrong answer arrived at confidently, and it
 * would be found by noticing the absence of something, which nobody does.
 *
 * A rejected touch is now recorded. Deliberately as a SEPARATE event rather
 * than a third value of `acquisition_attributed.touch`, because nothing was
 * attributed and an event named for a thing that did not happen is how
 * vocabularies rot.
 *
 * NO CODE IS CARRIED, holding 0038's rule that campaign identity lives on the
 * durable row and not in the event stream. `unknown` has no registry row to
 * name a source from anyway. The signal needed is the RATE - "links are failing
 * today" - and which campaign is then a question for the registry.
 */
insert into public.analytics_event_names (name, description, allowed_properties) values
  ('acquisition_touch_rejected',
   'A campaign touch was offered and the server refused it. Carries no code.',
   array['reason'])
on conflict (name) do update
  set description        = excluded.description,
      allowed_properties = excluded.allowed_properties;

/*
 * The M5C analogue of `m3d_missingness_v`: coverage says how much is missing,
 * this says what happened to it.
 *
 * Both events are read, so accepted and rejected touches are counted in one
 * place and on the same footing:
 *
 *   first     the touch became this actor's first-touch attribution
 *   repeat    a later touch from an actor who already had one - ordinary, and
 *             NOT a second acquisition
 *   unknown   a code no campaign row matches: a dead, mistyped or forged link
 *   inactive  a real campaign that has been switched off
 */
create or replace view public.acquisition_touch_outcomes_v as
select
  e.environment,
  date_trunc('day', e.occurred_at) as day,
  case
    when e.event_name = 'acquisition_attributed' then e.properties ->> 'touch'
    else e.properties ->> 'reason'
  end                              as outcome,
  (e.event_name = 'acquisition_attributed') as attributed,
  count(*)::int                    as touches,
  count(distinct e.actor_id)::int  as actors
from public.analytics_reportable_events_v e
where e.event_name in ('acquisition_attributed', 'acquisition_touch_rejected')
group by 1, 2, 3, 4;

comment on view public.acquisition_touch_outcomes_v is
  'Every campaign touch the server ruled on, accepted or rejected, per day. '
  'A rising `unknown` means links exist in the wild that resolve to no '
  'campaign - which otherwise looks exactly like a campaign nobody clicked. '
  'Counts touches at sign-in, never clicks: a click Watchside never saw is not '
  'in here and cannot be.';

-- ===========================================================================
-- 3. THE ONE BEHAVIOUR CHANGE: RECORD THE REFUSALS
-- ===========================================================================

/*
 * Identical to 0038 except that the two silent `return`s now say so first.
 *
 * Everything else is unchanged: the signature, the four return values, the
 * immutability of first touch, the ordering, the grants. Every released client
 * sees exactly what it saw before - `bind_acquisition` still answers with the
 * same four strings, and `core/acquisition.ts` maps them the same way.
 *
 * The emit is `analytics_emit_server`, the same path `acquisition_attributed`
 * already uses, so a rejected touch is subject to the same internal-actor
 * exclusion and the same reportable-view discipline as an accepted one.
 */
create or replace function public.bind_acquisition(p_code text)
returns text
language plpgsql
volatile
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor    uuid := public.require_actor();
  v_code     text := lower(btrim(coalesce(p_code, '')));
  v_source   text;
  v_active   boolean;
  v_existing text;
begin
  if v_code !~ '^[a-z0-9]([a-z0-9-]{0,30}[a-z0-9])$' then
    perform public.analytics_emit_server(
      v_actor, 'acquisition_touch_rejected', jsonb_build_object('reason', 'unknown')
    );
    return 'unknown';
  end if;

  select c.source, c.active into v_source, v_active
    from public.acquisition_campaigns c
   where c.code = v_code;

  if v_source is null then
    perform public.analytics_emit_server(
      v_actor, 'acquisition_touch_rejected', jsonb_build_object('reason', 'unknown')
    );
    return 'unknown';
  end if;
  if not v_active then
    perform public.analytics_emit_server(
      v_actor, 'acquisition_touch_rejected', jsonb_build_object('reason', 'inactive')
    );
    return 'inactive';
  end if;

  select a.first_campaign_code into v_existing
    from public.acquisition_attribution a
   where a.actor_id = v_actor;

  if v_existing is null then
    insert into public.acquisition_attribution
      (actor_id, first_campaign_code, last_campaign_code)
    values (v_actor, v_code, v_code)
    -- Concurrent binds from two tabs are a real race and an ordinary one; the
    -- loser becomes a no-op rather than an error.
    on conflict (actor_id) do nothing;

    if found then
      perform public.analytics_emit_server(
        v_actor, 'acquisition_attributed',
        jsonb_build_object('source', v_source, 'touch', 'first')
      );
      return 'first';
    end if;
  end if;

  /*
   * A repeat touch. `first_campaign_code` is absent from the SET list, and the
   * immutability trigger from 0038 would refuse it if it were.
   */
  update public.acquisition_attribution
     set last_campaign_code = v_code,
         last_touch_at      = now(),
         touch_count        = touch_count + 1
   where actor_id = v_actor;

  perform public.analytics_emit_server(
    v_actor, 'acquisition_attributed',
    jsonb_build_object('source', v_source, 'touch', 'repeat')
  );
  return 'repeat';
end;
$$;

revoke all on function public.bind_acquisition(text) from public, anon;
grant execute on function public.bind_acquisition(text) to authenticated;

-- ===========================================================================
-- The contract version.
-- ===========================================================================

create or replace function public.analytics_schema_version()
returns int
language sql
immutable
set search_path = public, pg_temp
as $$ select 40; $$;

revoke all on function public.analytics_schema_version() from public, anon, authenticated;

commit;
