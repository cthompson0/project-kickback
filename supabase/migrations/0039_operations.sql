-- ===========================================================================
-- 0039 — Two operational gaps, closed before controlled public use
--
-- M6B audited Watchside's production failure domains and found most of the
-- machinery already there: a closed failure vocabulary, `client_error` emitted
-- from every logError, rate budgets on presence, groups, messages, reactions
-- and feedback, and a shared helper to add more.
--
-- Two things were missing, and both are small.
--
--   1. FRIEND REQUESTS HAVE NO RATE BUDGET. Every other write surface adopted
--      consume_rate_budget; this one never did. One authenticated account can
--      send unlimited requests to everybody search can find, and each one lands
--      in a stranger's Requests list. Blocking exists, but it is reactive - the
--      victim has to be spammed first.
--
--   2. `client_error` IS COLLECTED AND UNREADABLE. Every client failure has been
--      recorded since 0024 and there is no view over it, so the question "are
--      twenty people failing to sign in right now" is answerable only by
--      writing ad-hoc SQL during an incident, which is exactly when nobody
--      wants to be writing SQL.
--
-- ADDITIVE ONLY. One function body changes - send_friend_request gains four
-- lines - and its signature, return values and every other behaviour are
-- identical. Chrome 0.7 (live), Chrome 0.8 (in review) and Firefox 0.6 (in
-- review) all keep working; the only difference any of them can observe is a
-- 53400 they already know how to render, because every other write surface
-- already raises it.
-- ===========================================================================

begin;

-- ===========================================================================
-- 1. A BUDGET FOR FRIEND REQUESTS
-- ===========================================================================

/*
 * Unchanged except for the budget.
 *
 * WHERE THE CHECK SITS, AND WHY IT MATTERS
 *
 * After the cheap validations and AFTER the "already friends / mutual intent /
 * already requested" resolutions, immediately before the INSERT. That ordering
 * is the whole design:
 *
 *   - a legitimate user pressing Add on somebody who already asked them gets a
 *     friendship, not a rate-limit error, however many times they have pressed
 *     Add today;
 *   - re-pressing Add on a pending request returns 'already_requested' without
 *     consuming budget, so an impatient click is free;
 *   - only an actual NEW request - the thing that lands in a stranger's list -
 *     costs anything.
 *
 * Budget consumed only when the insert is really going to happen, so the number
 * below means what it says: new people contacted, not buttons pressed.
 *
 * TWENTY IN AN HOUR. A real person adding friends after installing might add a
 * handful; twenty is generous for that and useless for spraying a user
 * directory. It is deliberately not tighter: the cost of blocking a genuine
 * enthusiastic new user is much higher than the cost of letting a spammer send
 * twenty rather than five.
 */
create or replace function public.send_friend_request(p_target uuid)
returns text
language plpgsql
volatile
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor uuid := public.require_actor();
  v_first uuid;
  v_second uuid;
begin
  if p_target is null then
    raise exception 'kickback: target required' using errcode = '22023';
  end if;
  if p_target = v_actor then
    raise exception 'kickback: you cannot add yourself' using errcode = '22023';
  end if;
  if not exists (select 1 from public.users u where u.id = p_target) then
    raise exception 'kickback: user not found' using errcode = 'P0002';
  end if;

  /*
   * Either direction refuses, and the message says nothing about which.
   *
   * "not found" would be a lie about a user the searcher can plainly see, and
   * "they blocked you" is precisely the fact this feature exists not to
   * publish. So it is a flat refusal, and it reads the same whether the caller
   * did the blocking or was blocked.
   */
  if public.blocked_pair(v_actor, p_target) then
    raise exception 'kickback: cannot add that user' using errcode = '42501';
  end if;

  -- Lock both users in a deterministic order so two people pressing Add at the
  -- same instant serialise into one friendship rather than deadlocking.
  v_first := least(v_actor, p_target);
  v_second := greatest(v_actor, p_target);
  perform 1 from public.users where id = v_first for update;
  perform 1 from public.users where id = v_second for update;

  if exists (
    select 1 from public.friendships f
    where f.user_id = v_actor and f.friend_id = p_target
  ) then
    return 'already_friends';
  end if;

  -- Mutual intent: they already asked us, so this is an acceptance, not a
  -- second request. Resolve it atomically instead of leaving two pending rows.
  update public.friend_requests
     set status = 'accepted', responded_at = now()
   where from_user = p_target
     and to_user = v_actor
     and status = 'pending';

  if found then
    perform public.create_friendship(v_actor, p_target);
    return 'friends';
  end if;

  if exists (
    select 1 from public.friend_requests r
    where r.from_user = v_actor and r.to_user = p_target and r.status = 'pending'
  ) then
    return 'already_requested';
  end if;

  /*
   * The only new behaviour in this function.
   *
   * Reached only when a genuinely new request is about to be created, so the
   * budget counts strangers contacted rather than clicks. 53400 is the code
   * every other rate-limited surface raises, and the client already maps it to
   * `rate_limited` in its failure vocabulary and to an ordinary message.
   */
  if not public.consume_rate_budget('friend_request', 20, interval '1 hour') then
    raise exception 'kickback: you are sending friend requests too quickly'
      using errcode = '53400';
  end if;

  insert into public.friend_requests (from_user, to_user) values (v_actor, p_target);
  return 'requested';
end;
$$;

revoke all on function public.send_friend_request(uuid) from public, anon;
grant execute on function public.send_friend_request(uuid) to authenticated;

-- ===========================================================================
-- 2. FAILURES, READABLE
-- ===========================================================================

/*
 * What is failing, for whom, and how much - per hour.
 *
 * WHY A VIEW AND NOT A DASHBOARD
 *
 * `client_error` has been collected since 0024 and read by nobody, because
 * answering "is something broken right now" meant writing a join against
 * analytics_events during an incident. This is that query, written once, while
 * nothing is on fire.
 *
 * GRAIN: one row per (hour, environment, context, code).
 *
 * `actors` is the column that matters. Ten failures from one person is somebody
 * with a flaky connection; ten failures from ten people is an outage, and the
 * two are indistinguishable from a raw count. That distinction is the whole
 * reason this view exists rather than a `count(*)`.
 *
 * Internal actors are excluded, as everywhere - the owner testing a failure
 * path should not look like users experiencing one.
 */
create or replace view public.ops_client_failures_v as
select
  date_trunc('hour', e.occurred_at)      as hour,
  e.environment,
  e.properties ->> 'context'             as context,
  e.properties ->> 'code'                as code,
  count(*)::int                          as failures,
  count(distinct e.actor_id)::int        as actors,
  max(e.occurred_at)                     as last_seen_at
from public.analytics_reportable_events_v e
where e.event_name = 'client_error'
group by 1, 2, 3, 4;

comment on view public.ops_client_failures_v is
  'Client failures per hour by context and code. `actors` distinguishes one '
  'person with a bad connection from an outage. Internal actors excluded.';

/*
 * The same question at the only grain that answers "is Watchside up".
 *
 * A single row per hour and environment: how many people were active, how many
 * hit a failure of any kind, and how many hit the two that mean Watchside is
 * unusable rather than merely degraded.
 *
 * `unauthenticated` and `network` are separated because they are the two that
 * say "this person cannot use the product at all". Everything else - a metadata
 * fetch failing, a room history not loading - degrades a surface while the rest
 * keeps working.
 *
 * NO THRESHOLDS ARE ENCODED HERE. There is no production baseline yet, so any
 * number written into a view today would be a guess wearing an alert's
 * clothing. The shape is what is needed first; the thresholds come after there
 * is data to set them from.
 */
create or replace view public.ops_health_v as
with active as (
  select
    date_trunc('hour', e.occurred_at) as hour,
    e.environment,
    e.actor_id,
    bool_or(e.event_name = 'client_error')                       as had_failure,
    bool_or(
      e.event_name = 'client_error'
      and e.properties ->> 'code' in ('unauthenticated', 'network')
    )                                                            as had_blocking_failure,
    bool_or(e.event_name = 'authenticated_session_started')       as authenticated,
    bool_or(e.event_name = 'join_clicked')                        as joined
  from public.analytics_reportable_events_v e
  group by 1, 2, 3
)
select
  hour,
  environment,
  count(*)::int                                        as active_actors,
  count(*) filter (where authenticated)::int           as authenticated_actors,
  count(*) filter (where joined)::int                  as joining_actors,
  count(*) filter (where had_failure)::int             as actors_with_any_failure,
  count(*) filter (where had_blocking_failure)::int    as actors_blocked
from active
group by 1, 2;

comment on view public.ops_health_v is
  'Hourly service health from the user side: who was active, who authenticated, '
  'who joined, and who was blocked by an auth or network failure. No thresholds '
  'are encoded - there is no production baseline to set them from yet.';

-- ===========================================================================
-- The contract version.
-- ===========================================================================

create or replace function public.analytics_schema_version()
returns int
language sql
immutable
set search_path = public, pg_temp
as $$ select 39; $$;

revoke all on function public.analytics_schema_version() from public, anon, authenticated;

commit;
