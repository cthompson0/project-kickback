# Reading the private beta

Everything needed to answer the beta's questions, as SQL you can paste into the
Supabase SQL editor. No dashboard, no script, no export.

**Every query here is scoped to `environment = 'private_beta'`.** Leave that in.
Your own development build writes `development`, and mixing the two is how a
beta result quietly becomes a number about you.

Run these against `analytics_reportable_events_v` and the lifecycle views —
they already exclude accounts marked `is_internal`. Mark your own account
internal first, or you are the biggest user in the cohort:

```sql
update public.analytics_actors set is_internal = true
where user_id in (select id from public.users where display_name in ('AnoterosTV'));
```

Read [ANALYTICS.md §12](ANALYTICS.md) before quoting any of this at anybody. A
handful of friends for a week is a story about whether the product works, not a
measurement of how well.

---

## 0. Is anything arriving at all?

Run this first, every time. If it is empty, nothing below means anything.

```sql
select environment,
       count(*)                  as events,
       count(distinct actor_id)  as people,
       min(occurred_at)          as first_seen,
       max(occurred_at)          as last_seen
from public.analytics_reportable_events_v
group by environment;
```

Then check the events you expect exist at all — a zero here is a broken build or
a surface nobody reached, and both are worth knowing before you interpret a rate.

```sql
select event_name, count(*) as n, count(distinct actor_id) as people
from public.analytics_reportable_events_v
where environment = 'private_beta'
group by event_name
order by n desc;
```

## 1. Did people actually open Kickback?

```sql
-- One row per person per day they did anything.
select day, count(distinct actor_id) as people, sum(event_count) as events
from public.analytics_actor_days_v
where environment = 'private_beta'
group by day
order by day;
```

## 2. Gravity exposure

**The important one.** How much social opportunity was actually put in front of
people, and how big it was.

```sql
select count(*)                        as impressions,
       count(distinct actor_id)        as people,
       count(distinct destination_channel) as destinations
from public.analytics_reportable_events_v
where environment = 'private_beta'
  and event_name = 'gravity_cluster_impression';
```

Segmented by how many friends were in the cluster — this is what tells you
whether social density matters:

```sql
select case
         when (properties ->> 'friend_count')::int = 1 then '1 friend'
         when (properties ->> 'friend_count')::int = 2 then '2 friends'
         else '3+ friends'
       end                              as size,
       count(*)                         as impressions,
       count(distinct actor_id)         as people,
       count(*) filter (where properties ->> 'destination_live' = 'true') as while_live
from public.analytics_reportable_events_v
where environment = 'private_beta'
  and event_name = 'gravity_cluster_impression'
group by size
order by size;
```

## 3. Gravity → JOIN

**This is the product thesis.** There is no view for it, because exposure and
JOIN are joined on a time window rather than on a minted id — see
[the attribution section](#a-note-on-what-this-join-is-not).

```sql
-- Gravity exposures, and whether the same person JOINed that same destination
-- within ten minutes.
with shown as (
  select actor_id, destination_channel, occurred_at,
         (properties ->> 'friend_count')::int as friend_count
  from public.analytics_reportable_events_v
  where environment = 'private_beta'
    and event_name = 'gravity_cluster_impression'
), converted as (
  select s.*,
         exists (
           select 1
           from public.analytics_reportable_events_v j
           where j.event_name = 'join_clicked'
             and j.source = 'social_gravity'
             and j.actor_id = s.actor_id
             and j.destination_channel = s.destination_channel
             and j.occurred_at between s.occurred_at and s.occurred_at + interval '10 minutes'
         ) as joined
  from shown s
)
select case when friend_count = 1 then '1 friend'
            when friend_count = 2 then '2 friends'
            else '3+ friends' end                             as size,
       count(*)                                               as exposures,
       count(*) filter (where joined)                         as followed_by_join,
       round(100.0 * count(*) filter (where joined) / nullif(count(*), 0), 1) as pct
from converted
group by size
order by size;
```

### A note on what this join is not

`join_clicked` carries a minted `attribution_id` that everything downstream
quotes, so **click → arrival → shared watch is deterministic**. Exposure is not
part of that chain: `gravity_cluster_impression` mints nothing, so exposure →
click is matched on `(actor, channel, 10 minutes)`.

That is a correlation, and a generous one. Somebody who saw the cluster, ignored
it, and navigated to the channel through Twitch a minute later is counted as
converted if they happened to press JOIN. Quote it as *"exposures followed by a
JOIN"*, never as *"exposures that caused a JOIN"*.

## 4. JOIN → arrival, by surface

Deterministic. This is the strongest claim the schema supports.

```sql
select source,
       count(*)                                                  as clicks,
       count(arrived_at)                                         as arrivals,
       round(100.0 * count(arrived_at) / nullif(count(*), 0), 1)  as arrival_pct,
       count(*) filter (where already_on_twitch)                  as already_had_twitch_open
from public.analytics_join_funnel_v
where environment = 'private_beta'
group by source
order by clicks desc;
```

`source` is `social_gravity`, `user_card` or `notification`. **Organic Twitch
navigation emits nothing**, so it can never appear here and can never be
mistaken for a Kickback-caused visit.

## 5. Notification → JOIN → arrival

```sql
select
  count(*) filter (where event_name = 'gathering_notification_shown')   as shown,
  count(*) filter (where event_name = 'gathering_notification_clicked') as clicked,
  count(*) filter (where event_name = 'join_arrived' and source = 'notification') as arrived
from public.analytics_reportable_events_v
where environment = 'private_beta';
```

If `shown` is high and `clicked` is near zero, that is the annoyance answer.

## 6. Watching Together

Did a JOIN turn into people actually watching together, and for how long?

```sql
select from_join,
       count(*)                        as intervals,
       avg(duration)                   as avg_duration,
       percentile_cont(0.5) within group (order by extract(epoch from duration))
                                       as median_seconds,
       avg(other_count_peak)           as avg_people
from public.analytics_together_v
where environment = 'private_beta' and duration is not null
group by from_join;
```

`from_join = false` is organic co-viewing — people who ended up on the same
stream without Kickback moving anybody. **It is the baseline**, and the honest
thing to compare an attributed shared watch against.

And whether they stayed after everyone else left:

```sql
select source,
       count(*)                                                     as shared_watches,
       count(*) filter (where post_social_duration > interval '60 seconds') as retained,
       avg(post_social_duration) filter (where post_social_retained) as avg_stay
from public.analytics_join_funnel_v
where environment = 'private_beta' and together_started_at is not null
group by source;
```

## 7. The session — is Together used at all?

Kept separate from everything above **on purpose**. Discovery working while
sessions go unused is a real and acceptable result; see the readiness checkpoint.

```sql
select
  count(*) filter (where event_name = 'automatic_room_entered')      as sessions_available,
  count(*) filter (where event_name = 'automatic_room_opened')       as sessions_opened,
  count(*) filter (where event_name = 'automatic_room_message_sent') as messages,
  count(*) filter (where event_name = 'automatic_room_reaction'
                     and properties ->> 'direction' = 'sent')        as reactions_sent,
  count(*) filter (where event_name = 'automatic_room_combo')        as combos,
  count(distinct actor_id) filter (where event_name = 'automatic_room_opened') as people_who_opened
from public.analytics_reportable_events_v
where environment = 'private_beta';
```

How people got in — the navigation bet was that the contextual tab gets opened
on its own rather than only from an affordance:

```sql
select properties ->> 'opened_from' as opened_from, count(*) as n
from public.analytics_reportable_events_v
where environment = 'private_beta' and event_name = 'automatic_room_opened'
group by opened_from order by n desc;
```

And whether friend-of-friend exposure is really happening, or every session is
just your own friends:

```sql
select (properties ->> 'participant_count')::int   as participants,
       (properties ->> 'direct_friend_count')::int as of_whom_direct_friends,
       count(*) as n
from public.analytics_reportable_events_v
where environment = 'private_beta' and event_name = 'automatic_room_entered'
group by participants, of_whom_direct_friends
order by n desc;
```

## 8. Social density

Friend counts, and how long it took to get there. `authenticated_session_started`
carries the count at the start of every signed-in session, so this is a time
series without any extra instrumentation.

```sql
-- Where everybody is now.
select friends, count(*) as people
from (
  select distinct on (actor_id) actor_id,
         (properties ->> 'friend_count')::int as friends
  from public.analytics_reportable_events_v
  where environment = 'private_beta' and event_name = 'authenticated_session_started'
  order by actor_id, occurred_at desc
) latest
group by friends order by friends;
```

```sql
-- How long from first sight to first friend, and to three.
with first_seen as (
  select actor_id, min(occurred_at) as started
  from public.analytics_reportable_events_v
  where environment = 'private_beta' group by actor_id
), counts as (
  select actor_id, occurred_at, (properties ->> 'friend_count')::int as friends
  from public.analytics_reportable_events_v
  where environment = 'private_beta' and event_name = 'authenticated_session_started'
)
select f.actor_id,
       min(c.occurred_at) filter (where c.friends >= 1) - f.started as to_first_friend,
       min(c.occurred_at) filter (where c.friends >= 3) - f.started as to_three_friends,
       max(c.friends)                                              as peak_friends
from first_seen f left join counts c on c.actor_id = f.actor_id
group by f.actor_id, f.started
order by peak_friends desc;
```

```sql
-- Requests, and how many stuck.
select
  count(*) filter (where event_name = 'friend_search')           as searches,
  count(*) filter (where event_name = 'friend_request_sent')     as requests_sent,
  count(*) filter (where event_name = 'friend_request_accepted') as accepted,
  count(*) filter (where event_name = 'friend_removed')          as removed,
  count(*) filter (where event_name = 'friend_search'
                     and properties ->> 'result_count' = '0')    as searches_finding_nobody
from public.analytics_reportable_events_v
where environment = 'private_beta';
```

`searches_finding_nobody` is the cold-start number. A high one means people are
looking for friends who have not installed it.

## 9. Retention

```sql
select first_day,
       count(distinct actor_id) filter (where day_index = 0)  as cohort,
       count(distinct actor_id) filter (where day_index = 1)  as d1,
       count(distinct actor_id) filter (where day_index = 7)  as d7,
       count(distinct actor_id) filter (where day_index = 14) as d14
from public.analytics_actor_days_v
where environment = 'private_beta'
group by first_day order by first_day;
```

**Active means "did anything at all"** — an event of any kind on that day. That
is the only definition in the codebase and this document does not invent a
second one. With a week of data, D14 will be empty and D7 will have one cohort.

## 9a. What people actually said

Feedback is **not** in analytics. It is prose somebody typed, and analytics is
built on the promise that it never contains free text — so it lives in its own
table, with its own rules, and analytics records only that a submission
happened.

```sql
-- Everything sent, newest first. This is the whole workflow.
select created_at, category, body, display_name,
       app_version, environment, browser, surface, channel,
       friend_count, session_available, social_sync, presence_sync
from public.feedback_v
order by created_at desc;
```

The context columns are what make a one-line report actionable. Somebody writing
*"my friend didn't appear"* arrives with the channel they were on, how many
friends they had, whether a session existed, and whether realtime was connected
at the time — which is most of a first diagnosis.

```sql
-- Is anybody using it, and what do they reach for it about?
select category, count(*) as n, count(distinct display_name) as people
from public.feedback_v
group by category order by n desc;
```

`feedback_v` is revoked from every client role, like the analytics views. Run it
in the SQL editor. There is no in-product read path — not even for the person
who wrote it.

Cross-check against the analytics counter, which carries the category and
nothing else:

```sql
select properties ->> 'category' as category, count(*) as n
from public.analytics_reportable_events_v
where environment = 'private_beta' and event_name = 'feedback_submitted'
group by category;
```

## 10. One person's whole story

When somebody reports something, this is the query. One row per JOIN, the entire
lifecycle across it.

```sql
select source, destination_channel, social_count,
       clicked_at, arrived_at,
       together_started_at, together_duration, together_end_reason,
       post_social_retained, post_social_duration
from public.analytics_join_funnel_v
where environment = 'private_beta'
order by clicked_at desc
limit 20;
```

---

## What none of this can tell you

- **Whether Kickback caused a JOIN.** Everyone is in the `gravity` arm during
  beta — deliberately, because a holdout across five people measures nothing.
  There is no control group, so nothing here is a causal claim.
- **Whether a visible combo makes people JOIN.** Combos are only drawn on the
  HERE card, and HERE is the channel you are already on — never a JOIN
  opportunity. The question is unanswerable by construction, not by omission.
- **Incremental Twitch watch hours.** See ANALYTICS.md §11a. What exists is
  shared-watch duration and post-social retention on destinations Kickback
  attributed. Generic Twitch watch time is not measured and must not be claimed.
- **Anything with a p-value.** Six people for a week.
