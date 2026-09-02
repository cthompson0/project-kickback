-- ===========================================================================
-- 0038 — Acquisition attribution: how somebody came to Watchside
--
-- Before spending streamer goodwill, creator outreach, TikTok effort or money,
-- we need to know which sources produce Watchside users who actually connect to
-- other people. This migration is the durable half of that.
--
-- THREE CONCEPTS, KEPT APART ON PURPOSE
--
--   acquisition       how did this person discover Watchside
--   friend referral   which Watchside user invited them  -- 0026, UNTOUCHED
--   creator/campaign  which campaign the touch belonged to
--
-- A person can have all three. Alice arrives from a streamer campaign and
-- invites Bob: Bob's referral is Alice, Bob's acquisition is whatever brought
-- Bob, and Alice's campaign is reachable from Bob only by walking the referral
-- edge. Nothing here writes to `referrals`, reads its meaning, or changes any
-- function that touches it.
--
-- THE URL CARRIES A CODE AND NOTHING ELSE
--
-- Everything about what a campaign IS - its source, its creator, its label -
-- lives here and resolves server-side. A visitor editing a query string changes
-- nothing, because there is nothing in the query string to change. That is the
-- entire defence against `?source=official_twitch_partnership`.
--
-- WHAT THIS CANNOT SEE, STATED HERE SO IT IS NOT DISCOVERED IN A REPORT
--
-- Link clicks and installs are unobservable without cross-site tracking, which
-- Watchside will not do. A touch becomes a fact at the moment it BINDS to an
-- authenticated actor, and never before. Every number built on this is
-- therefore "acquired users we could attribute", not "clicks".
--
-- ADDITIVE ONLY. Two new tables, one new function, one new event, three views.
-- No existing table, column, policy, grant or RPC changes shape, so Chrome 0.6
-- (live), Chrome 0.7 (pending) and Firefox 0.6 (pending first review) are
-- unaffected - none of them calls any of this.
-- ===========================================================================

begin;

-- ===========================================================================
-- THE CAMPAIGN REGISTRY
-- ===========================================================================

/*
 * What campaigns exist, and what each one means.
 *
 * WHY A REGISTRY RATHER THAN TRUSTING THE LINK
 *
 * The alternative is UTM-style parameters, where the URL asserts its own
 * source. That is fine when the only consumer is a marketer reading their own
 * dashboard and fatal when the number is meant to be evidence: anybody can
 * write any source into any link, including into a link they post as somebody
 * else. Resolving from here means a campaign code is a claim the SERVER already
 * agreed to.
 *
 * `code` IS THE IDENTITY AND IT NEVER CHANGES. `label` is the human name and
 * changes freely. That split is what lets a campaign be renamed without
 * invalidating links that already live in YouTube descriptions, Discord
 * scrollback, stream panels and screenshots - places nobody can edit.
 */
create table if not exists public.acquisition_campaigns (
  /*
   * The immutable public identity. Lowercase and readable, because these get
   * typed off a stream overlay by hand; an opaque hash would be mistyped and
   * unverifiable. It is not a secret, and it does not need to be: possession
   * lets somebody say "this campaign brought me" and nothing else, exactly as
   * an invite code confers nothing (0026).
   */
  code text primary key check (code ~ '^[a-z0-9]([a-z0-9-]{0,30}[a-z0-9])$'),

  /*
   * The channel class, from a closed set.
   *
   * A free-text source column becomes 'tiktok', 'TikTok', 'tik-tok' and
   * 'tiktok ' within a month, and every report then quietly undercounts. A
   * check constraint is the cheapest possible fix and the list is easy to widen
   * in a later migration when a genuinely new channel appears.
   */
  source text not null check (source in (
    'tiktok', 'x', 'youtube', 'twitch', 'creator', 'discord', 'reddit',
    'press', 'direct', 'other'
  )),

  /*
   * Which creator or partner this campaign was associated with, or null.
   *
   * A STABLE KEY WE ASSIGN, not a Twitch identity. Being an acquisition
   * campaign identity must not require the creator to authorize Watchside, log
   * in, or know we exist - a streamer who mentions Watchside once has a
   * campaign associated with them and has authorized nothing. Storing a Twitch
   * login here would blur that line, and would break if they renamed.
   *
   * "Associated with creator X" is all this means. It is not consent, not a
   * partnership, and not a claim about them.
   */
  creator_key text check (
    creator_key is null or creator_key ~ '^[a-z0-9]([a-z0-9-]{0,30}[a-z0-9])$'
  ),

  /** The mutable human name. Changing it never touches a published link. */
  label text not null check (char_length(label) between 1 and 80),

  /*
   * Whether new attribution may bind.
   *
   * Inactive stops the FUTURE, never the past: rows already attributed to this
   * campaign keep their attribution and the definition stays here so old
   * numbers remain readable. That is the difference between disabling a bad
   * link and deleting history, and only one of them is recoverable.
   */
  active boolean not null default true,

  created_at timestamptz not null default now()
);

/*
 * Source and creator are immutable after creation, enforced rather than agreed.
 *
 * WHY THIS TRIGGER EARNS ITS KEEP
 *
 * `acquisition_attributed` events carry `source` in their properties so a
 * funnel can group without a join. That is only safe while a code's source
 * cannot change - otherwise editing one row would silently rewrite the meaning
 * of every historical event that referenced it, and nobody would ever notice.
 *
 * If a campaign's source was genuinely wrong, the answer is a NEW code. Codes
 * are cheap; retroactively-changed history is not.
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
  return new;
end;
$$;

drop trigger if exists acquisition_campaigns_immutable on public.acquisition_campaigns;
create trigger acquisition_campaigns_immutable
  before update on public.acquisition_campaigns
  for each row execute function public.acquisition_campaign_immutable();

/*
 * Readable by nobody.
 *
 * A client never needs the registry: it sends a code and the server answers
 * with an outcome. Keeping it closed means the set of live campaigns cannot be
 * enumerated by anybody who installs the extension, which matters when a
 * campaign code is about to appear in a competitor-visible place anyway - not
 * because the codes are secret, but because the LIST is business information
 * and nothing needs it.
 *
 * RLS with zero policies is deny-all, so a future accidental GRANT still
 * cannot be reached. Same posture as twitch_credentials in 0032.
 */
alter table public.acquisition_campaigns enable row level security;
revoke all on public.acquisition_campaigns from anon, authenticated;

comment on table public.acquisition_campaigns is
  'Authoritative campaign definitions. Not user data: survives account deletion.';

-- ===========================================================================
-- THE ATTRIBUTION
-- ===========================================================================

/*
 * One row per actor, ever. How they arrived, and most recently arrived.
 *
 * FIRST TOUCH AND LAST TOUCH ARE DIFFERENT COLUMNS, NOT ONE MUTABLE FIELD
 *
 * "How did this user originally come to Watchside" and "which campaign did they
 * most recently click" are different questions, and a single `source` column
 * can only answer whichever one it was last written by. The first columns are
 * written once and never updated; the last columns are overwritten freely.
 *
 * Every analytical join goes through FIRST touch, which is immutable - so a
 * cohort computed today and the same cohort computed next year contain the same
 * people. Last touch exists for the narrower question of which link is
 * currently circulating, and no report should join on it without saying so.
 *
 * DELETION. `on delete cascade` from public.users, exactly like every other
 * user-owned table: account deletion removes this row with everything else, and
 * there is deliberately no aggregate copy of it anywhere that would survive.
 * The campaign DEFINITION survives, because a campaign is not user data.
 */
create table if not exists public.acquisition_attribution (
  actor_id uuid primary key references public.users (id) on delete cascade,

  /** Written once, at the first bind. Never updated. See the trigger below. */
  first_campaign_code text not null references public.acquisition_campaigns (code),
  first_touch_at      timestamptz not null default now(),

  /** Overwritten by every later bind, including a repeat of the same campaign. */
  last_campaign_code  text not null references public.acquisition_campaigns (code),
  last_touch_at       timestamptz not null default now(),

  /** How many binds this actor has made. Cheap, and it makes repeats visible. */
  touch_count int not null default 1 check (touch_count > 0)
);

create index if not exists acquisition_attribution_first_idx
  on public.acquisition_attribution (first_campaign_code);

/*
 * First touch is immutable, enforced.
 *
 * The single most valuable property in this migration, and the one an ordinary
 * bug would quietly break: an UPDATE that forgot its WHERE clause, or a future
 * "just refresh the attribution" helper, would rewrite the origin of every
 * user it touched and no test that only checked the happy path would notice.
 */
create or replace function public.acquisition_first_touch_immutable()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  if new.first_campaign_code is distinct from old.first_campaign_code
     or new.first_touch_at is distinct from old.first_touch_at then
    raise exception 'kickback: first-touch attribution is immutable'
      using errcode = '23514';
  end if;
  return new;
end;
$$;

drop trigger if exists acquisition_attribution_first_touch on public.acquisition_attribution;
create trigger acquisition_attribution_first_touch
  before update on public.acquisition_attribution
  for each row execute function public.acquisition_first_touch_immutable();

/*
 * A person may read their own attribution and nobody else's.
 *
 * Symmetric with `referrals`, where the invitee may see who is credited with
 * bringing them. Somebody is entitled to know what Watchside believes about how
 * they arrived; nobody is entitled to know it about anyone else.
 */
alter table public.acquisition_attribution enable row level security;
revoke all on public.acquisition_attribution from anon, authenticated;
grant select on public.acquisition_attribution to authenticated;

drop policy if exists acquisition_attribution_own on public.acquisition_attribution;
create policy acquisition_attribution_own on public.acquisition_attribution
  for select to authenticated
  using (actor_id = (select auth.uid()));

-- ===========================================================================
-- BINDING
-- ===========================================================================

/*
 * Attach a campaign touch to the authenticated actor.
 *
 * THE ONLY WAY ATTRIBUTION IS EVER WRITTEN. SECURITY DEFINER, seeded at
 * require_actor(), taking exactly one argument: a code. It cannot be told whose
 * attribution to write, what source to record, or which creator to credit -
 * there is no parameter for any of that, which is a stronger guarantee than
 * validating one.
 *
 * OUTCOMES, all ordinary, none raising:
 *
 *   'first'     bound, and this is where they came from
 *   'repeat'    already attributed; last touch moved, first touch did not
 *   'unknown'   no such campaign - nothing written
 *   'inactive'  campaign exists but is closed to new attribution
 *
 * AN UNKNOWN CODE WRITES NOTHING. Not a row with a null campaign, not a row
 * recording the string that was offered. Storing unresolvable codes is exactly
 * how arbitrary client-supplied text ends up in a table that is later read as
 * if it were authoritative.
 *
 * THE WINDOW IS ENFORCED ON THE CLIENT, and that is not an oversight. The
 * server cannot know when a link was clicked - only when a bind arrived - so an
 * age passed in here would be a client assertion dressed up as a server check.
 * The extension discards an expired touch instead of offering it; see
 * core/acquisition.ts, where the rule is one pure function with its own tests.
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
    return 'unknown';
  end if;

  select c.source, c.active into v_source, v_active
    from public.acquisition_campaigns c
   where c.code = v_code;

  if v_source is null then
    return 'unknown';
  end if;
  if not v_active then
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
   * A later touch. First touch is untouched by construction - it is not in the
   * SET list, and the trigger would refuse it if it were.
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

comment on function public.bind_acquisition(text) is
  'Binds a campaign touch to auth.uid(). Campaign metadata resolves server-side; '
  'the caller supplies a code and nothing else.';

/** What Watchside believes about how the caller arrived. Their row only. */
create or replace function public.my_acquisition()
returns table (
  first_campaign_code text,
  first_touch_at      timestamptz,
  touch_count         int
)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select a.first_campaign_code, a.first_touch_at, a.touch_count
    from public.acquisition_attribution a
   where a.actor_id = public.require_actor();
$$;

revoke all on function public.my_acquisition() from public, anon;
grant execute on function public.my_acquisition() to authenticated;

-- ===========================================================================
-- THE EVENT
-- ===========================================================================

/*
 * One new event, emitted server-side from inside the bind.
 *
 * WHY ONLY ONE. The other stages a marketer would want - link visited, page
 * viewed, extension installed - are not observable to Watchside without
 * tracking people across sites, so inventing events for them would mean
 * inventing the data. The stages that ARE observable already have events:
 * `authenticated_session_started`, `join_clicked`, `channel_dwell_ended`,
 * `referral_succeeded`. They gain acquisition meaning by JOINING to this
 * table, not by carrying a copy of it.
 *
 * `source` is copied into the properties because it can never change for a code
 * - the immutability trigger above is what makes that safe - so a funnel can
 * group without a join and still be reading the truth years later.
 */
insert into public.analytics_event_names (name, description, allowed_properties) values
  ('acquisition_attributed',
   'A campaign touch was bound to this account. Server-authoritative.',
   array['source', 'touch'])
on conflict (name) do update
  set description        = excluded.description,
      allowed_properties = excluded.allowed_properties;

-- ===========================================================================
-- REPORTING
-- ===========================================================================

/*
 * Per-actor acquisition, joined to what that actor went on to do.
 *
 * GRAIN: one row per attributed actor, INTERNAL ACTORS EXCLUDED.
 *
 * The exclusion is the point of building this on analytics_actors rather than
 * on users: the owner and the test accounts click their own campaign links
 * constantly while testing, and a campaign that looks like it acquired four
 * people when three of them were us is worse than no number at all.
 *
 * Everything to the right of the attribution is OBSERVED product behaviour
 * already recorded for other reasons. Nothing here is a new measurement; it is
 * the existing measurements finally answerable by "and where did they come
 * from".
 */
create or replace view public.acquisition_actor_v as
with attributed as (
  select
    a.actor_id,
    a.first_campaign_code,
    a.first_touch_at,
    a.last_campaign_code,
    a.touch_count
  from public.acquisition_attribution a
  join public.analytics_actors aa on aa.user_id = a.actor_id
  where not aa.is_internal
),
behaviour as (
  select
    e.actor_id,
    min(e.occurred_at) filter (where e.event_name = 'authenticated_session_started')
                                                                  as first_authenticated_at,
    count(*) filter (where e.event_name = 'join_clicked')::int     as join_clicks,
    count(*) filter (where e.event_name = 'join_arrived')::int     as join_arrivals,
    count(*) filter (where e.event_name = 'gravity_cluster_impression')::int
                                                                  as gravity_impressions,
    count(*) filter (where e.event_name = 'channel_dwell_ended')::int
                                                                  as observed_dwell_intervals,
    max(e.occurred_at)                                            as last_event_at,
    count(distinct (e.occurred_at at time zone 'utc')::date)::int  as active_days
  from public.analytics_reportable_events_v e
  group by e.actor_id
),
graph as (
  select f.user_id as actor_id, count(*)::int as friend_count
  from public.friendships f
  group by f.user_id
),
/*
 * What this actor did for the GRAPH, not just for themselves.
 *
 * Read from `referrals`, which is stamped by SECURITY DEFINER functions from
 * server facts - so an acquired user's downstream contribution cannot be
 * inflated by a modified extension. This is the column that answers "does this
 * campaign bring people who bring people".
 */
downstream as (
  select
    r.inviter_id as actor_id,
    count(*)::int                                        as invitees_attributed,
    count(*) filter (where r.succeeded_at is not null)::int as invitees_succeeded
  from public.referrals r
  group by r.inviter_id
),
/** Whether this actor was themselves brought by a Watchside friend. */
inbound as (
  select r.invitee_id as actor_id, r.inviter_id
  from public.referrals r
)
select
  t.actor_id,
  t.first_campaign_code,
  t.first_touch_at,
  t.last_campaign_code,
  t.touch_count,
  c.source                                       as first_source,
  c.creator_key                                  as first_creator_key,
  b.first_authenticated_at,
  coalesce(g.friend_count, 0)                    as friend_count,
  coalesce(g.friend_count, 0) > 0                as is_connected,
  coalesce(b.gravity_impressions, 0)             as gravity_impressions,
  coalesce(b.join_clicks, 0)                     as join_clicks,
  coalesce(b.join_arrivals, 0)                   as join_arrivals,
  coalesce(b.observed_dwell_intervals, 0)        as observed_dwell_intervals,
  coalesce(b.active_days, 0)                     as active_days,
  b.last_event_at,
  coalesce(d.invitees_attributed, 0)             as invitees_attributed,
  coalesce(d.invitees_succeeded, 0)              as invitees_succeeded,
  i.inviter_id                                   as referred_by
from attributed t
join public.acquisition_campaigns c on c.code = t.first_campaign_code
left join behaviour  b on b.actor_id = t.actor_id
left join graph      g on g.actor_id = t.actor_id
left join downstream d on d.actor_id = t.actor_id
left join inbound    i on i.actor_id = t.actor_id;

comment on view public.acquisition_actor_v is
  'One row per attributed, non-internal actor: first-touch campaign joined to '
  'observed product behaviour. OBSERVED and ATTRIBUTED only - never causal.';

/*
 * Per-campaign rollup, with small-cohort suppression.
 *
 * SUPPRESSION FOLLOWS THE 0035 PRECEDENT and for the same reason: a rate over
 * three people is that individual's behaviour wearing a percentage sign. A
 * campaign that acquired two users, one of whom made a JOIN, does not have a
 * "50% JOIN rate" - it has two people.
 *
 * COUNTS ARE ALWAYS SHOWN; RATES ARE SUPPRESSED BELOW THE THRESHOLD. Knowing a
 * campaign acquired two users reveals nothing about either of them, and it is
 * the number you need to decide whether the campaign is worth continuing at
 * all. Suppressed as NULL rather than 0, so an absent rate can never be
 * mistaken for a bad one.
 *
 * PROVISIONAL threshold, matching m3d_relationship_v.
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
  /*
   * Below the threshold every rate is NULL. The counts above stand on their own.
   */
  case when x.acquired_actors >= 3
       then round(x.connected_actors::numeric / x.acquired_actors, 3) end
                                                             as connected_share,
  case when x.acquired_actors >= 3
       then round(x.joining_actors::numeric / x.acquired_actors, 3) end
                                                             as joining_share,
  case when x.acquired_actors >= 3
       then round(x.inviting_actors::numeric / x.acquired_actors, 3) end
                                                             as inviting_share,
  x.acquired_actors >= 3                                     as rates_reportable
from rolled x
join public.acquisition_campaigns c on c.code = x.campaign_code;

comment on view public.acquisition_campaign_v is
  'Campaign rollup. Counts always shown; rates NULL below 3 actors (PROVISIONAL). '
  'Comparing campaigns here is OBSERVATIONAL, never causal.';

/*
 * Downstream lineage: campaign -> acquired user -> the people they brought.
 *
 * GRAIN: one row per (acquired inviter, invitee they brought).
 *
 * THE INVITEE'S OWN ACQUISITION IS NOT OVERWRITTEN, and that is the whole
 * design. Bob is not "from" Alice's streamer campaign - Bob is from wherever
 * Bob came from, which is usually nowhere at all. What is true is that Bob
 * exists downstream of Alice, who came from that campaign, and that is
 * expressed as a JOIN rather than as a value copied into Bob's row.
 *
 * ONE HOP. Deliberately not recursive: a transitive closure over an invite
 * graph is where attribution systems go to explode, and the second hop answers
 * a question nobody has asked yet. If it is ever needed it can be built on
 * this without unwinding anything.
 */
create or replace view public.acquisition_downstream_v as
select
  a.first_campaign_code                as campaign_code,
  a.actor_id                           as inviter_id,
  r.invitee_id,
  r.attributed_at                      as invitee_attributed_at,
  r.succeeded_at is not null           as invitee_referral_succeeded,
  /* The invitee's OWN acquisition, which is usually null and must stay so. */
  b.first_campaign_code                as invitee_own_campaign_code
from public.acquisition_attribution a
join public.analytics_actors aa on aa.user_id = a.actor_id and not aa.is_internal
join public.referrals r on r.inviter_id = a.actor_id
left join public.acquisition_attribution b on b.actor_id = r.invitee_id;

comment on view public.acquisition_downstream_v is
  'One hop of viral lineage. The invitee keeps their own acquisition; the '
  'campaign relationship is a join, never a copied value.';

-- ===========================================================================
-- The contract version.
-- ===========================================================================

create or replace function public.analytics_schema_version()
returns int
language sql
immutable
set search_path = public, pg_temp
as $$ select 38; $$;

revoke all on function public.analytics_schema_version() from public, anon, authenticated;

commit;
