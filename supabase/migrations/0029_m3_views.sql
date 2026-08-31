-- ===========================================================================
-- 0029 — M3A/M3C reporting views
--
-- Five views, no new tables, no new columns, no new collection. Everything
-- here reads data the extension has been sending for weeks; the only reason
-- these questions could not be answered before is that nobody had written the
-- SQL.
--
--   analytics_gravity_conversion_v   Gravity exposure -> JOIN (M3A slice 1)
--   analytics_growth_funnel_v        invite -> claim -> referral (slice 2)
--   analytics_graph_cohort_v         friend-count cohorts (slice 3)
--   analytics_return_v               Watchside return (slice 4)
--   analytics_creator_repeat_v       repeat creator viewing (M3C part C)
--
-- WHAT THESE VIEWS ARE AND ARE NOT
--
-- Every one of them is OBSERVATIONAL. Not one column is named for a causal
-- claim, and that is deliberate rather than fussy: a column called
-- `gravity_lift` would be quoted as lift by somebody who never read this file.
-- Where a number could be misread as causal the column carries the word that
-- makes it descriptive - `converted`, `observed`, `attributed` - and
-- docs/ANALYTICS.md §14 states the exact numerator and denominator for each.
--
-- Dropped and recreated rather than CREATE OR REPLACE'd, for the reason 0014
-- gives: replacing a relation whose column list has changed fails with 42P13,
-- and a migration that only applies to a database which has never seen an
-- earlier version of itself is not idempotent. Dropping is always safe because
-- a view holds no data.
--
-- Owner-only, like everything else in analytics. Nothing in the extension
-- reads any of this, and the revokes at the bottom are what keep an event log
-- from becoming a side channel.
-- ===========================================================================

begin;

drop view if exists public.analytics_creator_repeat_v;
drop view if exists public.analytics_return_v;
drop view if exists public.analytics_graph_cohort_v;
drop view if exists public.analytics_growth_funnel_v;
drop view if exists public.analytics_gravity_conversion_v;

-- ---------------------------------------------- slice 1: gravity conversion
--
-- GRAIN: one row per (viewer, opportunity). An "opportunity" is one gathering
-- in one 30-second window - `gravity:{channel}:{floor(now/30s)}` - computed by
-- the SAME function on the impression and on the JOIN, so the two sides cannot
-- disagree about what one gathering was. See src/core/socialGravity.ts.
--
-- WHY PER VIEWER RATHER THAN PER OPPORTUNITY. Several people can be shown the
-- same gathering and act on it separately. Conversion is a property of a
-- person being shown something, so the denominator is exposures; how many
-- distinct gatherings that was is `count(distinct opportunity_key)` on top.
--
-- NUMERATOR   rows where `converted`
-- DENOMINATOR all rows
-- EXCLUDES    internal actors (via analytics_reportable_events_v); impressions
--             with no opportunity_key, which is every pre-Gravity row
--
-- This is exposure -> JOIN CONVERSION. It is not lift, and there is no control
-- group anywhere in it.

create view public.analytics_gravity_conversion_v as
with shown as (
  select
    e.actor_id,
    e.environment,
    e.properties ->> 'opportunity_key'                     as opportunity_key,
    e.destination_channel,
    min(e.app_version)                                     as app_version,
    min(e.occurred_at)                                     as first_shown_at,
    max(e.occurred_at)                                     as last_shown_at,
    count(*)::int                                          as impression_count,
    -- The most people it ever showed, which is what made it an opportunity.
    max((e.properties ->> 'friend_count')::int)            as friend_count_peak,
    -- Best position it was ever shown at; 1 is the top card.
    min((e.properties ->> 'rank')::int)                    as best_rank,
    /*
     * Whether Twitch said the destination was live when it was SHOWN.
     *
     * Absent on rows where nothing told us, which is a third state and not a
     * false - so this is null when we never knew, rather than claiming the
     * stream was offline.
     */
    bool_or((e.properties ->> 'destination_live') = 'true') as shown_live
  from public.analytics_reportable_events_v e
  where e.event_name = 'gravity_cluster_impression'
    and e.properties ->> 'opportunity_key' is not null
  group by
    e.actor_id, e.environment, e.properties ->> 'opportunity_key', e.destination_channel
),
acted as (
  select
    e.actor_id,
    e.environment,
    e.properties ->> 'opportunity_key'              as opportunity_key,
    count(*)::int                                   as join_count,
    min(e.occurred_at)                              as first_join_at,
    bool_or((e.properties ->> 'navigated') = 'true') as navigated,
    max((e.properties ->> 'social_count')::int)     as social_count
  from public.analytics_reportable_events_v e
  where e.event_name = 'join_clicked'
    and e.source = 'social_gravity'
    and e.properties ->> 'opportunity_key' is not null
  group by e.actor_id, e.environment, e.properties ->> 'opportunity_key'
)
select
  s.opportunity_key,
  s.actor_id,
  s.environment,
  s.app_version,
  s.destination_channel,
  s.first_shown_at,
  s.last_shown_at,
  s.impression_count,
  s.friend_count_peak,
  s.best_rank,
  s.shown_live,
  coalesce(a.join_count, 0)      as join_count,
  a.join_count is not null       as converted,
  a.first_join_at,
  a.first_join_at - s.first_shown_at as time_to_first_join,
  coalesce(a.navigated, false)   as navigated,
  a.social_count
from shown s
left join acted a
  on  a.actor_id        = s.actor_id
  and a.environment     = s.environment
  and a.opportunity_key = s.opportunity_key;

-- ------------------------------------------------- slice 2: the growth funnel
--
-- GRAIN: one row per inviter.
--
-- THE MISSING STAGE IS MISSING ON PURPOSE. There is no `installs` column and
-- there never can be: analytics_events.actor_id is auth.uid(), so no event can
-- exist before somebody signs in. Invite -> install -> auth is structurally
-- unmeasurable, and a zero would read as "nobody installed" rather than "we
-- cannot see this". So the column is absent and this comment is the reason.
--
-- Server state is authoritative for the outcome stages. `referrals` already
-- stamps attributed_at / friended_at / activated_at / succeeded_at, and 0026
-- defines a successful referral precisely; that definition is reused here
-- rather than re-litigated in SQL.
--
-- NUMERATOR/DENOMINATOR: each stage over the one before it. The honest top of
-- the funnel is `invites_created`, not installs.

create view public.analytics_growth_funnel_v as
with created as (
  select actor_id, environment, count(*)::int as invites_created
  from public.analytics_reportable_events_v
  where event_name = 'invite_link_created'
  group by actor_id, environment
),
shared as (
  select
    actor_id,
    environment,
    count(*)::int                                                as invites_shared,
    count(*) filter (where properties ->> 'method' = 'copy')::int as shared_by_copy,
    count(*) filter (where properties ->> 'method' = 'share_sheet')::int as shared_by_sheet
  from public.analytics_reportable_events_v
  where event_name = 'invite_link_shared'
  group by actor_id, environment
),
/*
 * Outcomes come from server state, not from client events.
 *
 * `referrals` is stamped by SECURITY DEFINER functions from server facts, so
 * it cannot be inflated by a modified extension - which is exactly the
 * property a growth number needs. It has no environment column, so these
 * counts span environments and are joined onto whichever environment row the
 * inviter has events in. Read them as "this person's referrals", not "this
 * person's referrals in private_beta".
 */
outcomes as (
  select
    inviter_id                                                       as actor_id,
    count(*)::int                                                    as claims_attributed,
    count(*) filter (where friended_at is not null)::int             as friendships_formed,
    count(*) filter (where activated_at is not null)::int            as invitees_activated,
    count(*) filter (where succeeded_at is not null)::int            as referrals_succeeded,
    min(attributed_at)                                               as first_claim_at,
    min(succeeded_at)                                                as first_success_at
  from public.referrals
  group by inviter_id
),
actors as (
  select actor_id, environment from created
  union
  select actor_id, environment from shared
)
select
  x.actor_id,
  x.environment,
  coalesce(c.invites_created, 0)     as invites_created,
  coalesce(s.invites_shared, 0)      as invites_shared,
  coalesce(s.shared_by_copy, 0)      as shared_by_copy,
  coalesce(s.shared_by_sheet, 0)     as shared_by_sheet,
  coalesce(o.claims_attributed, 0)   as claims_attributed,
  coalesce(o.friendships_formed, 0)  as friendships_formed,
  coalesce(o.invitees_activated, 0)  as invitees_activated,
  coalesce(o.referrals_succeeded, 0) as referrals_succeeded,
  o.first_claim_at,
  o.first_success_at
from actors x
left join created  c on c.actor_id = x.actor_id and c.environment = x.environment
left join shared   s on s.actor_id = x.actor_id and s.environment = x.environment
left join outcomes o on o.actor_id = x.actor_id;

-- ------------------------------------------------- slice 3: graph-size cohort
--
-- GRAIN: one row per authenticated session.
--
-- Session grain rather than per-user, deliberately. friend_count is recorded
-- AT EACH SIGN-IN, so a user who grew from 2 friends to 11 contributes rows in
-- both cohorts, at the time each was true. Bucketing users by today's count
-- would relabel their whole history, which is the usual way this analysis goes
-- wrong.
--
-- THE BUCKETS. 0 / 1 / 2 / 3-4 / 5-9 / 10+. The low boundaries are a product
-- discontinuity rather than an arbitrary cut: Gravity needs GRAVITY_THRESHOLD
-- friends on one channel before a cluster renders at all.
--
-- OBSERVATIONAL, AND THE CONFOUND IS NOT SUBTLE. Users with ten friends are
-- not users with two friends plus eight; they are more social, earlier-
-- adopting people. Nothing here shows that adding friends causes engagement,
-- and no column is named as if it does.

create view public.analytics_graph_cohort_v as
select
  e.actor_id,
  e.environment,
  e.session_id,
  e.app_version,
  e.occurred_at                              as session_started_at,
  (e.properties ->> 'friend_count')::int     as friend_count,
  (e.properties ->> 'group_count')::int      as group_count,
  case
    when (e.properties ->> 'friend_count')::int <= 0 then '0'
    when (e.properties ->> 'friend_count')::int = 1  then '1'
    when (e.properties ->> 'friend_count')::int = 2  then '2'
    when (e.properties ->> 'friend_count')::int <= 4 then '3-4'
    when (e.properties ->> 'friend_count')::int <= 9 then '5-9'
    else '10+'
  end                                        as friend_bucket,
  /*
   * Present only when the arm is a real randomisation.
   *
   * Null in development and private beta because the client does not send it
   * there - everybody is forced into one arm, and recording a constant as an
   * experiment result is how a fake causal claim reaches a deck. A null here
   * means "not randomised", never "unknown arm".
   */
  e.properties ->> 'experiment_arm'           as experiment_arm,
  -- What that session went on to do. Sourced from the session view so the
  -- definition of "had a JOIN" has one home.
  coalesce(v.had_gathering_impression, false) as had_gathering_impression,
  coalesce(v.had_join_click, false)           as had_join_click,
  coalesce(v.had_join_arrival, false)         as had_join_arrival,
  coalesce(v.had_watching_together, false)    as had_watching_together,
  v.observed_duration                         as session_observed_duration
from public.analytics_reportable_events_v e
left join public.analytics_sessions_v v
  on v.session_id = e.session_id and v.actor_id = e.actor_id
where e.event_name = 'authenticated_session_started'
  and e.properties ->> 'friend_count' is not null;

-- ----------------------------------------------------- slice 4: return rate
--
-- GRAIN: one row per (actor, environment, active day).
--
-- ⚠ THIS MEASURES RETURN TO WATCHSIDE, NOT RETURN TO TWITCH.
--
-- Every row here requires a Watchside event, which requires the extension to
-- be installed, signed in and running. Somebody who watches Twitch on a phone,
-- in another browser profile, or after uninstalling is invisible - and an
-- uninstall is indistinguishable from having stopped watching Twitch entirely.
--
-- The columns are therefore named `returned_within_*` and NOT `twitch_return`
-- or `retention`. docs/ANALYTICS.md §14 repeats this; it is the single most
-- likely number in this migration to be overstated in a deck.
--
-- NUMERATOR   rows where returned_within_7d
-- DENOMINATOR rows on the same day cohort
-- COMPARISON  had_social_interaction splits the cohort. That comparison is an
--             ASSOCIATION: people whose friends were online are different
--             people from those whose friends were not, in exactly the way
--             that matters.
--
-- CENSORING: the last 30 days of data cannot have a complete 30-day window.
-- Filter on `day <= current_date - 30` before quoting returned_within_30d.

create view public.analytics_return_v as
with active as (
  select
    e.actor_id,
    e.environment,
    (e.occurred_at at time zone 'utc')::date as day,
    count(*)::int                            as event_count,
    bool_or(e.event_name in ('join_arrived', 'watching_together_started'))
                                             as had_social_interaction,
    bool_or(e.event_name = 'channel_dwell_ended') as had_observed_viewing
  from public.analytics_reportable_events_v e
  group by e.actor_id, e.environment, (e.occurred_at at time zone 'utc')::date
)
select
  a.actor_id,
  a.environment,
  a.day,
  a.event_count,
  a.had_social_interaction,
  a.had_observed_viewing,
  exists (
    select 1 from active b
    where b.actor_id = a.actor_id and b.environment = a.environment
      and b.day > a.day and b.day <= a.day + 1
  ) as returned_within_1d,
  exists (
    select 1 from active b
    where b.actor_id = a.actor_id and b.environment = a.environment
      and b.day > a.day and b.day <= a.day + 7
  ) as returned_within_7d,
  exists (
    select 1 from active b
    where b.actor_id = a.actor_id and b.environment = a.environment
      and b.day > a.day and b.day <= a.day + 30
  ) as returned_within_30d
from active a;

-- ------------------------------------------- M3C part C: repeat creator view
--
-- GRAIN: one row per (actor, environment, creator) that the actor ever
-- ARRIVED at through a Watchside JOIN.
--
-- THE QUESTION: after Watchside took somebody to a creator, did they come back
-- to that creator on their own?
--
-- `later_organic_dwell_count` is the honest answer, and the word `organic`
-- carries the weight: it counts observed viewing of that creator AFTER the
-- first attributed arrival, on intervals that were NOT themselves covered by a
-- JOIN attribution. Viewing that a later JOIN produced is counted separately,
-- because attributing a second Watchside-driven visit to "they came back on
-- their own" would be the same error twice.
--
-- ⚠ NOT "Twitch retention". This is repeat OBSERVED viewing of a creator after
-- a Watchside-attributed visit. It sees only what Watchside sees.
--
-- NO NEW TELEMETRY. Built entirely from join_arrived and channel_dwell_ended.
--
-- CENSORING: empty until channel_dwell_ended has data - see
-- docs/ANALYTICS.md §15 for the measurement start timestamp. Rows will exist
-- for historical JOINs with no later viewing, which is correct: they are the
-- denominator.

create view public.analytics_creator_repeat_v as
with arrivals as (
  select
    e.actor_id,
    e.environment,
    e.destination_channel,
    min(e.occurred_at) as first_attributed_arrival_at,
    count(*)::int      as attributed_arrival_count
  from public.analytics_reportable_events_v e
  where e.event_name = 'join_arrived'
    and e.destination_channel is not null
  group by e.actor_id, e.environment, e.destination_channel
),
viewing as (
  select
    e.actor_id,
    e.environment,
    e.destination_channel,
    e.occurred_at,
    coalesce((e.properties ->> 'duration_ms')::bigint, 0) as duration_ms,
    (e.properties ->> 'from_join') = 'true'               as from_join
  from public.analytics_reportable_events_v e
  where e.event_name = 'channel_dwell_ended'
    and e.destination_channel is not null
)
select
  a.actor_id,
  a.environment,
  a.destination_channel,
  a.first_attributed_arrival_at,
  a.attributed_arrival_count,
  count(v.*)::int                                                   as later_dwell_count,
  coalesce(sum(v.duration_ms), 0)                                   as later_dwell_ms,
  count(v.*) filter (where not v.from_join)::int                    as later_organic_dwell_count,
  coalesce(sum(v.duration_ms) filter (where not v.from_join), 0)    as later_organic_dwell_ms,
  min(v.occurred_at) filter (where not v.from_join)                 as first_organic_return_at,
  max(v.occurred_at)                                                as last_observed_view_at,
  (min(v.occurred_at) filter (where not v.from_join)) - a.first_attributed_arrival_at
                                                                    as time_to_first_organic_return
from arrivals a
left join viewing v
  on  v.actor_id            = a.actor_id
  and v.environment         = a.environment
  and v.destination_channel = a.destination_channel
  and v.occurred_at         > a.first_attributed_arrival_at
group by
  a.actor_id, a.environment, a.destination_channel,
  a.first_attributed_arrival_at, a.attributed_arrival_count;

-- ---------------------------------------------------------------- the revokes
--
-- An event log is a record of when and where somebody was. Everything above is
-- owner-only, exactly like the views 0014 and 0016 install.

revoke all on public.analytics_gravity_conversion_v from anon, authenticated;
revoke all on public.analytics_growth_funnel_v      from anon, authenticated;
revoke all on public.analytics_graph_cohort_v       from anon, authenticated;
revoke all on public.analytics_return_v             from anon, authenticated;
revoke all on public.analytics_creator_repeat_v     from anon, authenticated;

commit;
