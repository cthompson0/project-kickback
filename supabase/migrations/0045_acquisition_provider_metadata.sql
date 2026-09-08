-- ===========================================================================
-- 0045 — Provider metadata on the campaign registry, and the view that joins
--        acquisition to activation
--
-- WHAT THIS IS FOR
--
-- M5C (0038) answered "which campaign brought this account", and answered it
-- well: an opaque code in the URL, everything about what the campaign MEANS
-- resolved server-side, first touch immutable. What it could not answer is the
-- shape of question a marketing decision actually needs:
--
--   which PROVIDER acquired them        reddit, google, meta, ...
--   through which MEDIUM                paid_social, launch, referral, ...
--   with which CREATIVE                 creative A vs creative B
--   against which TARGETING             the term or audience
--
-- Those four facts existed nowhere, so the only way to compare two Reddit
-- creatives was to mint two codes and remember out-of-band which was which.
-- Remembering out-of-band is how the meaning of a number gets lost.
--
-- THE RULE THIS MIGRATION EXISTS TO PRESERVE
--
-- These are REGISTRY facts, not URL facts. A visitor may append
-- `?utm_source=google` to a Reddit campaign link and it changes nothing at all,
-- because nothing reads it - exactly as 0038 arranged for `source`. UTM
-- parameters are generated OUTBOUND from this table for vendor dashboards and
-- store analytics; they are never an input. There is deliberately no code path
-- anywhere that turns a query parameter into attribution.
--
-- WHAT IS NOT TOUCHED
--
-- `source`, `creator_key`, `label`, `active`, `code`, the first/last touch
-- columns, `bind_acquisition`, the attribution window, the four bind outcomes,
-- and every existing view keep their exact current meaning. `reddit` was
-- already in `source`'s check constraint (0038) and needed no change.
--
-- ADDITIVE ONLY. Four nullable columns, one trigger body replaced with a
-- superset of itself, one view replaced additively, one view created. No table
-- is dropped, no column changes type, no grant is widened, and no function
-- signature changes - so Chrome 0.8/0.9 and Firefox 0.9, none of which call any
-- of this, are unaffected.
-- ===========================================================================

begin;

-- ===========================================================================
-- 1. FOUR COLUMNS ON THE REGISTRY
-- ===========================================================================

/*
 * The advertising or distribution platform, or null.
 *
 * NOT A SYNONYM FOR `source`, and the distinction is load-bearing. `source` is
 * the channel class Watchside has grouped by since 0038 - what KIND of thing
 * brought them. `provider` is the vendor whose dashboard holds the spend and
 * the click count. Usually the same word; occasionally not. A creator campaign
 * paid for through Reddit ads is `source = 'creator'`, `provider = 'reddit'`,
 * and one column could only ever answer one of those questions.
 *
 * NULL MEANS NO PAID PROVIDER. An organic post, a launch, a link in a README.
 * Absence is the honest value; it is emphatically not a "direct" bucket, which
 * 0040 refused to invent and which this migration does not smuggle back in.
 *
 * The list is short on purpose. Widening it is a migration, which is the point:
 * a new provider is a decision somebody made rather than a string somebody
 * typed into a form.
 */
alter table public.acquisition_campaigns
  add column if not exists provider text
    check (provider is null or provider in (
      'reddit', 'google', 'meta', 'tiktok', 'x', 'producthunt', 'hackernews'
    ));

/*
 * How the traffic was obtained. A closed set, for the same reason `source` is:
 * free text becomes 'paid_social', 'Paid Social' and 'paid-social' inside a
 * month and every report then quietly undercounts.
 */
alter table public.acquisition_campaigns
  add column if not exists medium text
    check (medium is null or medium in (
      'paid_social', 'organic_social', 'launch', 'referral',
      'organic_search', 'press', 'creator'
    ));

/*
 * The creative or variant this campaign is. MUTABLE, like `label`.
 *
 * WHY MUTABLE WHERE provider AND medium ARE NOT. Nothing groups on it across
 * time and no event carries it, so renaming "creative_a" to "friends_gathering"
 * rewrites no history - it renames a thing. The stable identity is the CODE,
 * which is why a creative can be renamed without invalidating a published link,
 * and that is the same split 0038 made between `code` and `label`.
 *
 * Constrained to a UTM-safe alphabet because this value is emitted into store
 * URLs, and 40 characters because AMO truncates a UTM parameter there - a label
 * that arrives whole in one dashboard and cut in another is a label two reports
 * disagree about.
 */
alter table public.acquisition_campaigns
  add column if not exists content text
    check (content is null or content ~ '^[a-z0-9][a-z0-9_-]{0,39}$');

/** The targeting, audience or keyword. Mutable, same reasoning as `content`. */
alter table public.acquisition_campaigns
  add column if not exists term text
    check (term is null or term ~ '^[a-z0-9][a-z0-9_-]{0,39}$');

comment on column public.acquisition_campaigns.provider is
  'Advertising/distribution platform. IMMUTABLE. Not a synonym for source: a '
  'creator campaign bought through Reddit is source=creator, provider=reddit. '
  'NULL means no paid provider - never a "direct" bucket.';
comment on column public.acquisition_campaigns.medium is
  'How the traffic was obtained. IMMUTABLE - it is a grouping key.';
comment on column public.acquisition_campaigns.content is
  'Creative/variant label. MUTABLE: nothing groups on it across time and no '
  'event carries it, so a rename rewrites no history.';
comment on column public.acquisition_campaigns.term is
  'Targeting/keyword label. MUTABLE, same reasoning as content.';

-- ===========================================================================
-- 2. IMMUTABILITY, EXTENDED RATHER THAN REPLACED
-- ===========================================================================

/*
 * `provider` and `medium` join `code`, `source` and `creator_key` as immutable.
 *
 * WHY THESE TWO AND NOT THE OTHER TWO
 *
 * The test is whether a report GROUPS on the column across time. It does for
 * provider and medium: "what did Reddit acquire, ever" has to mean one thing,
 * and editing the column afterwards would silently rewrite what every earlier
 * comparison meant - without a single row looking wrong. It does not for
 * `content` and `term`, which name a creative rather than classify it.
 *
 * If a provider or medium was genuinely entered wrong, the answer is the same
 * one 0038 gave for a wrong source: mint a NEW code. Codes are cheap;
 * retroactively-changed history is not.
 *
 * A SUPERSET of the 0038 body, not a rewrite - the three existing rules are
 * reproduced exactly, so replacing this function cannot relax anything.
 */
create or replace function public.acquisition_campaign_immutable()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  if new.code is distinct from old.code then
    raise exception 'kickback: a campaign code is immutable' using errcode = '23514';
  end if;
  if new.source is distinct from old.source then
    raise exception 'kickback: a campaign source is immutable; mint a new code'
      using errcode = '23514';
  end if;
  if new.creator_key is distinct from old.creator_key then
    raise exception 'kickback: a campaign creator is immutable; mint a new code'
      using errcode = '23514';
  end if;
  if new.provider is distinct from old.provider then
    raise exception 'kickback: a campaign provider is immutable; mint a new code'
      using errcode = '23514';
  end if;
  if new.medium is distinct from old.medium then
    raise exception 'kickback: a campaign medium is immutable; mint a new code'
      using errcode = '23514';
  end if;
  return new;
end;
$$;

revoke all on function public.acquisition_campaign_immutable() from public, anon, authenticated;

-- ===========================================================================
-- 3. THE CAMPAIGN ROLLUP, CARRYING THE NEW DIMENSIONS
-- ===========================================================================

/*
 * Identical to 0040's shape with four columns added to the projection.
 *
 * Everything else is unchanged and deliberately so: the same small-cohort
 * suppression at three actors, the same counts-always/rates-sometimes rule, the
 * same "OBSERVATIONAL, never causal" warning where a reader will meet it.
 */
create or replace view public.acquisition_campaign_v as
with reportable as (
  select * from public.acquisition_actor_v
),
rolled as (
  select
    r.first_campaign_code                                    as campaign_code,
    r.first_source                                           as source,
    r.first_creator_key                                      as creator_key,
    count(*)::int                                            as acquired_actors,
    count(*) filter (where r.first_authenticated_at is not null)::int
                                                             as authenticated_actors,
    count(*) filter (where r.is_connected)::int              as connected_actors,
    count(*) filter (where r.gravity_impressions > 0)::int   as socially_exposed_actors,
    count(*) filter (where r.join_clicks > 0)::int           as joining_actors,
    count(*) filter (where r.join_arrivals > 0)::int         as arriving_actors,
    count(*) filter (where r.observed_dwell_intervals > 0)::int
                                                             as observed_viewing_actors,
    count(*) filter (where r.invitees_attributed > 0)::int   as inviting_actors,
    sum(r.invitees_succeeded)::int                           as downstream_successes,
    min(r.first_touch_at)                                    as first_touch_at,
    max(r.first_touch_at)                                    as latest_touch_at
  from reportable r
  group by r.first_campaign_code, r.first_source, r.first_creator_key
)
select
  x.*,
  c.label,
  c.active,
  case when x.acquired_actors >= 3
       then round(x.connected_actors::numeric / x.acquired_actors, 3) end
                                                             as connected_share,
  case when x.acquired_actors >= 3
       then round(x.joining_actors::numeric / x.acquired_actors, 3) end
                                                             as joining_share,
  case when x.acquired_actors >= 3
       then round(x.inviting_actors::numeric / x.acquired_actors, 3) end
                                                             as inviting_share,
  x.acquired_actors >= 3                                     as rates_reportable,

  /*
   * The 0045 dimensions, read live from the registry rather than copied, and
   * APPENDED rather than inserted.
   *
   * `create or replace view` refuses to rename or reorder an existing column -
   * it raises 42P16 and tells you to use ALTER VIEW. So a new column goes on
   * the end, always. Putting these next to `label` where they read better cost
   * a failed migration to learn, and the lesson is worth the comment: the
   * column ORDER of a replaced view is part of its contract.
   */
  c.provider,
  c.medium,
  c.content,
  c.term
from rolled x
join public.acquisition_campaigns c on c.code = x.campaign_code;

comment on view public.acquisition_campaign_v is
  'Campaign rollup, with provider/medium/content/term from the registry. Counts '
  'always shown; rates NULL below 3 actors (PROVISIONAL). Comparing campaigns '
  'here is OBSERVATIONAL, never causal.';

-- ===========================================================================
-- 4. ACQUISITION -> ACTIVATION
-- ===========================================================================

/*
 * The bridge: trusted campaign attribution joined to the canonical activation
 * milestones, per campaign.
 *
 * WHY THIS IS A JOIN AND NOT A NEW DEFINITION
 *
 * Every stage below is read from `activation_actor_v` (0042), which is itself
 * derived from the friend graph and from `m3d_social_joins_v` (0034). Nothing
 * is redefined here. That matters more than it looks: a second definition of
 * "socially joined" would drift from the first, and the two would then disagree
 * about the most important step in the funnel while both looked correct.
 *
 * GRAIN: one row per (campaign, environment, first app version).
 *
 * `environment` and `first_app_version` are in the grain rather than summed
 * over, carrying the same warning they carry in `acquisition_coverage_v` and
 * `activation_funnel_v`: behaviour is only comparable within a build, because
 * what a build could do bounds what its users could reach.
 *
 * THE DENOMINATOR IS ATTRIBUTED ACTORS WHO AUTHENTICATED.
 *
 * Stated plainly because it is the thing a reader will get wrong. This view
 * CANNOT see clicks, store visits or installs - none of them is observable, and
 * 0038 says why. So `authenticated_actors` is the top of this funnel and every
 * rate below divides by it. It is emphatically NOT a conversion rate from ad
 * click; the click denominator lives in the provider's dashboard and the two
 * will never reconcile. `acquisition_coverage_v` remains the honest answer to
 * "how much of arrival do we see at all".
 *
 * Every stage is counted against that same denominator rather than against the
 * survivors of the stage before - the 0042 rule - so a campaign that acquires
 * users who never make a friend shows a collapsing funnel rather than a healthy
 * one measured over the few who escaped.
 */
create or replace view public.acquisition_activation_v as
with attributed as (
  /*
   * Attributed actors, non-internal, via the actor view that already applies
   * that exclusion. Reading `acquisition_actor_v` rather than the table means
   * the internal-actor rule is enforced in exactly one place.
   */
  select
    a.actor_id,
    a.first_campaign_code,
    a.first_touch_at
  from public.acquisition_actor_v a
),
joined as (
  select
    t.first_campaign_code                as campaign_code,
    v.environment,
    v.first_app_version,
    v.actor_id,
    t.first_touch_at,
    v.first_authenticated_at,
    v.first_friendship_at,
    v.first_friend_presence_at,
    v.first_gravity_at,
    v.first_social_join_at,
    v.first_join_arrival_at,
    v.first_dwell_at,
    v.still_without_friends,
    v.active_days,
    v.time_to_first_friend
  from attributed t
  /*
   * INNER JOIN, deliberately. `activation_actor_v` holds only actors who have
   * authenticated, and an attributed actor who never signed in has no
   * activation story to tell - they would arrive here as a row of nulls that
   * every count below would read as a failure at every stage. Their absence is
   * visible where it belongs: in acquisition_coverage_v and in the gap between
   * acquisition_campaign_v.acquired_actors and authenticated_actors here.
   */
  join public.activation_actor_v v on v.actor_id = t.actor_id
)
select
  j.campaign_code,
  c.source,
  c.provider,
  c.medium,
  c.content,
  c.term,
  c.creator_key,
  c.label,
  c.active,
  j.environment,
  j.first_app_version,

  -- The denominator, and the stages, all against it.
  count(*)::int                                                     as authenticated_actors,
  count(*) filter (where j.still_without_friends)::int              as cold_start_actors,
  count(*) filter (where j.first_friendship_at is not null)::int    as friended_actors,
  count(*) filter (where j.first_friend_presence_at is not null)::int
                                                                    as friend_presence_actors,
  count(*) filter (where j.first_gravity_at is not null)::int       as gravity_actors,
  count(*) filter (where j.first_social_join_at is not null)::int   as social_join_actors,
  count(*) filter (where j.first_join_arrival_at is not null)::int  as arrived_actors,
  count(*) filter (where j.first_dwell_at is not null)::int         as watched_actors,
  count(*) filter (where j.active_days > 1)::int                    as returned_actors,

  /*
   * Rates NULL below three actors, matching 0035, 0038, 0040 and 0042. A rate
   * over two people is that person's behaviour wearing a percentage sign.
   * Suppressed as NULL rather than 0, so an absent rate can never be mistaken
   * for a bad one.
   */
  case when count(*) >= 3
       then round(count(*) filter (where j.first_friendship_at is not null)::numeric
                  / count(*), 4) end                                as friended_rate,
  case when count(*) >= 3
       then round(count(*) filter (where j.first_gravity_at is not null)::numeric
                  / count(*), 4) end                                as gravity_rate,
  case when count(*) >= 3
       then round(count(*) filter (where j.first_social_join_at is not null)::numeric
                  / count(*), 4) end                                as social_join_rate,
  case when count(*) >= 3
       then round(count(*) filter (where j.active_days > 1)::numeric
                  / count(*), 4) end                                as returned_rate,
  case when count(*) >= 3
       then round(count(*) filter (where j.still_without_friends)::numeric
                  / count(*), 4) end                                as cold_start_rate,
  count(*) >= 3                                                     as rates_reportable,

  percentile_disc(0.5) within group (order by j.time_to_first_friend)
                                                                    as median_time_to_first_friend,
  min(j.first_touch_at)                                             as first_touch_at,
  max(j.first_touch_at)                                             as latest_touch_at
from joined j
join public.acquisition_campaigns c on c.code = j.campaign_code
group by
  j.campaign_code, c.source, c.provider, c.medium, c.content, c.term,
  c.creator_key, c.label, c.active, j.environment, j.first_app_version;

comment on view public.acquisition_activation_v is
  'Campaign attribution joined to the CANONICAL activation milestones from '
  'activation_actor_v - nothing is redefined here. Grain: campaign x environment '
  'x first app version. The denominator is ATTRIBUTED ACTORS WHO AUTHENTICATED, '
  'never ad clicks: clicks, store visits and installs are unobservable to '
  'Watchside and these numbers will never reconcile with a provider dashboard. '
  'Rates NULL below 3 actors. OBSERVATIONAL, never causal.';

-- ===========================================================================
-- 5. REVOKED, IN THIS MIGRATION, BEFORE IT CAN BE FORGOTTEN
-- ===========================================================================

/*
 * The 0043 lesson, applied at birth rather than four migrations later.
 *
 * Supabase grants SELECT on anything newly created in `public` to `anon` and
 * `authenticated` by default. 0038, 0039, 0040 and 0042 each missed this and
 * shipped nine per-actor reporting views readable by anybody holding the
 * publishable key that ships inside the extension - a stop-ship found in the
 * v0.9 RC security pass and already live in production at the time.
 *
 * `acquisition_activation_v` is per-campaign rather than per-actor, but it is
 * still business information nothing on a client needs, and the rule is the
 * rule. `acquisition_campaign_v` is re-revoked because CREATE OR REPLACE VIEW
 * above may reset its privileges.
 *
 * tests/db/authorizationSurface.test.ts introspects the built schema and fails
 * on any `%_v` reachable by a client, which is the real fix - this was missed
 * four times by review alone.
 */
revoke all on public.acquisition_activation_v from public, anon, authenticated;
revoke all on public.acquisition_campaign_v   from public, anon, authenticated;

-- ===========================================================================
-- The contract version.
-- ===========================================================================

create or replace function public.analytics_schema_version()
returns int
language sql
immutable
set search_path = public, pg_temp
as $$ select 45; $$;

revoke all on function public.analytics_schema_version() from public, anon, authenticated;

commit;
