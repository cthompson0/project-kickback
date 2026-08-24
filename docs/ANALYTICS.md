# Kickback analytics

What Kickback measures, why, and exactly what leaves your browser.

This document is the source for beta disclosure, the eventual privacy policy,
and the Chrome Web Store listing. It is meant to be factual rather than
reassuring: if something is collected, it is named here.

---

## 1. Two kinds of data, kept apart

**Product data** is what Kickback needs in order to work at all: your account,
your friendships, your groups, the messages in them, and your presence. Without
it there is no product. It lives in the `users`, `friendships`, `groups`,
`group_messages` and `presence` tables.

**Analytics data** is what we look at to understand whether Kickback works: a
small set of events about what was shown and what was done. It lives in
`analytics_events` and nothing else reads it while Kickback is running.

The two are deliberately separate islands. No product table has a foreign key
into analytics, nothing in the extension ever reads analytics back, and all
analytics for an environment can be deleted without touching a single
friendship, message or presence row. There is a test for each of those claims.

---

## 2. What is collected

Every event carries:

| Field | What it is |
|---|---|
| `actor_id` | Your Kickback user id. **Taken from your session server-side**, never from anything the extension sends. |
| `environment` | `development`, `private_beta` or `production` — which build produced it. |
| `event_name` | One of the events in section 4. Anything else is discarded. |
| `session_id` | A random id for this stretch of Kickback use. Not linked to anything outside analytics. |
| `occurred_at` / `received_at` | Your clock and the server's. A client clock more than a day out is replaced. |
| `app_version` | e.g. `0.5.0`. So a tester on an old ZIP is identifiable as such. |
| `source` | Which Kickback surface: `friend_row`, `gathering`, `notification`, `group`, `user_card`. |
| `destination_channel` | A Twitch channel login, for events that are about going somewhere. See section 3. |
| `attribution_id` | A random id linking one JOIN click to what followed it. Expires within minutes. |
| `properties` | A handful of counts, buckets and flags. Each event's allowed keys are listed in the database. |

### What is never collected

None of the following has a column to live in or an allowed property key:

- chat message bodies, or any message content
- emote identities
- Twitch OAuth tokens, or any token
- email addresses
- friend codes
- browsing history, URLs, page titles, paths, query strings or VOD ids
- search terms (a friend search records the number of results, never the query)
- any device, browser or hardware fingerprint
- any third-party advertising or tracking identifier

This is enforced rather than promised. Property values are capped at 64
characters, may not be objects or arrays, and any key an event has not declared
is stripped — **twice**, once in the extension and once in the database, because
the server does not trust the client. A message body cannot fit through even if
a future call site tried to send one.

---

## 3. Why the Twitch channel is stored as a login

`destination_channel` holds a lowercase Twitch login (`lirik`), not a hash.

A hash would group and join exactly as well, so hashing would cost nothing
analytically. It would also protect nobody: a Twitch login is public,
low-entropy and enumerable, so a hash of one is reversible by anyone who cares
to build the table. It would be privacy theatre, and it would block joining to
channel metadata later.

What matters for privacy is the *scope*, and the scope is narrow: the channel
is recorded only for events that are about a destination — a JOIN, an
impression of somebody being somewhere, a shared watch. Ordinary browsing
records nothing. There are no URLs, no paths, no titles, and no history.

---

## 4. The events

The full list, with each event's allowed properties, is in the database:

```sql
select name, description, allowed_properties
from public.analytics_event_names
order by name;
```

In summary:

**Lifecycle** — `extension_session_started`, `extension_session_ended`,
`authenticated_session_started`

**Social graph** — `friend_search` (result count only), `friend_request_sent`,
`friend_request_accepted`, `friend_removed`, `group_invite_sent`,
`group_invite_accepted`

**Exposure** — `friend_presence_impression`, `gathering_impression`,
`gravity_cluster_impression` *(registered, not yet emitted)*

**JOIN** — `join_clicked`, `join_arrived`

**Watching together** — `watching_together_started`, `watching_together_ended`

**Gatherings** — `gathering_notification_shown`,
`gathering_notification_clicked`

**Groups and chat** — `group_created`, `group_opened`, `group_message_sent`
(length bucket and a has-emote flag only), `combo_formed`, `combo_broken`

There is **one** JOIN event. Which surface drove it is the `source` column, not
a separate event name — so "which surface converts best" is a `group by` rather
than a union of near-duplicates, and adding Social Gravity next checkpoint adds
a source value rather than a parallel funnel.

---

## 5. What a session means

A Kickback session **opens** the first time a Twitch tab reports activity with
the extension loaded, and **closes** after 30 minutes with no Twitch tab open.
Signing out closes it too.

It is defined on the tab lifecycle that already drives presence, rather than on
a tracker of its own, so there is only one answer to "is this person here".

The session id and its last-active time are kept in `chrome.storage.local`.
That is not an implementation detail: an MV3 service worker is killed after
about thirty seconds idle, so a session held in memory would end every time the
user stopped clicking and one evening would look like forty sessions. A worker
waking up inside the 30-minute window resumes the session it finds.

`extension_session_ended` is **best-effort and says so**. A browser that is
quit outright never runs anything again; that session's end is emitted later,
when something wakes up and finds it expired, dated to when it actually
stopped. A browser that is never opened again emits nothing at all. **Every
duration question is therefore answered from the session's first and last
event**, and the explicit end event is only a cross-check. `analytics_sessions_v`
does this for you.

---

## 6. Impressions: what "shown" means

An impression means social information was **on screen**, not that it existed.
Nothing is recorded while the panel is collapsed — a launcher badge is a
notification, not an exposure.

The panel reports the whole visible set as often as it likes; the service
worker turns that into events:

- a key that becomes visible emits **one** impression;
- while it stays visible, nothing more is emitted;
- it may emit again after **30 minutes**, so a panel open all evening records a
  fresh exposure every half hour rather than one for the evening or one per
  repaint;
- if it disappears for **5 minutes or more** and returns, that is a new
  exposure — the friend left and came back, and being shown that again is a
  real second opportunity;
- a briefer disappearance is not enough.

A key is the identity of the *opportunity*: a friend **and** the channel they
are on, or a gathering's channel. A gathering growing from two friends to six
is the same gathering and does not re-impress; the count is recorded as a
property at the moment of the impression. A friend moving channel is a
different opportunity, and does.

---

## 7. JOIN attribution

A JOIN click mints a short-lived `attribution_id` carrying the destination, the
surface and the session. Arrival and the shared watch that follows quote it, so
the funnel is a join on one column rather than a guess made from timestamps.

Handled explicitly:

| Situation | What happens |
|---|---|
| Navigation fails, or the user never arrives | The attribution expires after **90 seconds**. No arrival is recorded; arrival rate is arrivals ÷ clicks, so this is already counted correctly. |
| The user goes somewhere else instead | An arrival at a different channel does not answer the click; the click stays pending in case they are passing through. |
| Five rapid clicks | One intention. The latest click supersedes; there is one attribution. |
| A second JOIN to a different channel | The first is abandoned — they are going to the second place. |
| The service worker restarts mid-navigation | The attribution is in `chrome.storage.local`, so it survives. |
| JOIN on the channel already being watched | Recorded as a click with `navigated: false` and **no attribution**, because no arrival is coming. |

After arrival the attribution is kept for **10 minutes**, so a shared watch that
begins once presence catches up is still credited to the JOIN that caused it.
Then it is dropped. Nothing here accumulates.

---

## 8. Watching together

A shared watch starts when you are on a channel and at least one person visible
to you is too, and ends when you leave, when the last of them does, or when the
session ends.

Two pieces of hysteresis, both earned:

- Presence heartbeats every 45s and goes stale at 90s, so a friend can briefly
  appear to vanish. The end therefore waits **2 minutes** — otherwise one
  evening becomes a dozen sessions, each too short to mean anything.
- A channel change ends it immediately, because that is not ambiguous.

The recorded duration runs to when the others were **last actually there**, not
through the grace period, so durations are not inflated by two minutes each.
`other_count_peak` is the most people it ever had, which answers "how shared was
this" better than whoever happened to still be there at the end.

---

## 9. Environments and test data

| Environment | Which build |
|---|---|
| `development` | Local builds. The default when `VITE_KICKBACK_ENV` is unset. |
| `private_beta` | The tester ZIP. `npm run package:beta` sets this at build time and verifies the artifact, so a packager's local setting cannot leak in. |
| `production` | The public build. |

**The demo build sends nothing at all.** Not "is configured off": the demo
client's analytics methods are empty, the demo build never connects to the
service worker, and `tests/extension/bundle.test.ts` asserts the string
`analytics_track` does not appear in the demo bundle.

Internal and test accounts are marked **server-side**:

```sql
update public.analytics_actors set is_internal = true
where user_id in (select id from public.users where /* your accounts */ true);
```

Every reporting view already excludes them. A modified client cannot un-mark
itself, because the extension never writes that column.

### Resetting before public launch

```sql
select * from public.analytics_reset_environment('private_beta', 'RESET private_beta');
```

Three guards, because a careless call is unrecoverable: the confirmation phrase
must name the environment, `production` needs the longer phrase
`RESET production I AM SURE`, and the function is revoked from every client
role so it exists only for whoever is already in the SQL editor as the owner.

It deletes from `analytics_events` and removes actor rows that have nothing
left. It cannot reach product data.

---

## 10. Volume

Per active user per day, on ordinary use:

| Events | Source |
|---|---|
| 2–6 | session starts and ends |
| 5–40 | presence and gathering impressions (one per friend-and-channel per 30 min the panel is open) |
| 0–10 | JOIN clicks and arrivals |
| 0–6 | shared-watch starts and ends |
| 0–30 | group opens, messages, combos |

**Roughly 10–90 events per user per day**, dominated by impressions and
therefore by how long the panel is left open with a large friends list.

The server budget is **600 events per 5 minutes per user**, charged per *event*
rather than per call so batching cannot be used to cheat it, with a hard cap of
**50 events per call**. That is around forty times the heaviest realistic
session and is not reachable by using Kickback.

The extension batches every 5 seconds, holds at most 400 events, drops the
**oldest** when full, and backs off exponentially on failure. Analytics being
down costs events; it never costs a JOIN or a message.

---

## 11. Queries

All of these read `analytics_reportable_events_v` (internal accounts already
excluded) or `analytics_production_events_v` (also production-only). **Always
name the environment** unless you are using the production view.

```sql
-- Active users, by environment, over the last 7 days
select environment, count(distinct actor_id) as wau
from public.analytics_reportable_events_v
where occurred_at > now() - interval '7 days'
group by environment;
```

```sql
-- Friend counts, from the authenticated-session event
select environment,
       count(*) filter (where friends >= 1)                   as with_a_friend,
       round(avg(friends)::numeric, 1)                        as avg_friends
from (
  select distinct on (actor_id, environment)
         actor_id, environment, (properties ->> 'friend_count')::int as friends
  from public.analytics_reportable_events_v
  where event_name = 'authenticated_session_started'
  order by actor_id, environment, occurred_at desc
) latest
group by environment;
```

```sql
-- JOIN clicks by source, and how many actually arrived
select environment, source,
       count(*)                                              as clicks,
       count(arrived_at)                                     as arrivals,
       round(100.0 * count(arrived_at) / nullif(count(*), 0), 1) as arrival_rate_pct
from public.analytics_join_funnel_v
group by environment, source
order by clicks desc;
```

```sql
-- Share of weekly actives who JOIN at all
with active as (
  select distinct actor_id from public.analytics_production_events_v
  where occurred_at > now() - interval '7 days'
), joined as (
  select distinct actor_id from public.analytics_production_events_v
  where event_name = 'join_clicked' and occurred_at > now() - interval '7 days'
)
select (select count(*) from active)                                    as actives,
       (select count(*) from joined)                                    as joiners,
       round(100.0 * (select count(*) from joined)
                   / nullif((select count(*) from active), 0), 1)       as pct;
```

```sql
-- Watching-together sessions and how long they lasted
select environment,
       count(*)                            as sessions,
       count(*) filter (where from_join)   as from_a_join,
       avg(duration)                       as avg_duration,
       percentile_cont(0.5) within group (order by extract(epoch from duration))
                                           as median_seconds
from public.analytics_together_v
where duration is not null
group by environment;
```

```sql
-- Gathering impressions -> JOIN conversion
with shown as (
  select actor_id, destination_channel, occurred_at
  from public.analytics_reportable_events_v
  where event_name = 'gathering_impression'
), clicked as (
  select actor_id, destination_channel, occurred_at
  from public.analytics_reportable_events_v
  where event_name = 'join_clicked' and source = 'gathering'
)
select count(distinct (s.actor_id, s.destination_channel, s.occurred_at)) as impressions,
       count(distinct (c.actor_id, c.destination_channel, c.occurred_at)) as joins
from shown s
left join clicked c
  on c.actor_id = s.actor_id
 and c.destination_channel = s.destination_channel
 and c.occurred_at between s.occurred_at and s.occurred_at + interval '10 minutes';
```

```sql
-- Notification shown -> clicked -> arrived
select
  count(*) filter (where event_name = 'gathering_notification_shown')   as shown,
  count(*) filter (where event_name = 'gathering_notification_clicked') as clicked,
  count(*) filter (where event_name = 'join_arrived' and source = 'notification') as arrived
from public.analytics_reportable_events_v
where environment = 'private_beta';
```

```sql
-- D1 / D7 / D30 retention
select first_day,
       count(distinct actor_id) filter (where day_index = 0)  as cohort,
       count(distinct actor_id) filter (where day_index = 1)  as d1,
       count(distinct actor_id) filter (where day_index = 7)  as d7,
       count(distinct actor_id) filter (where day_index = 30) as d30
from public.analytics_actor_days_v
where environment = 'production'
group by first_day
order by first_day;
```

```sql
-- Everything split by environment, to check nothing is mixed
select environment, count(*) as events, count(distinct actor_id) as people,
       min(occurred_at) as first_seen, max(occurred_at) as last_seen
from public.analytics_reportable_events_v
group by environment;
```

---

## 12. What these numbers can and cannot say

This matters more than any single query.

**Observational data supports** statements about *association* and about
*Kickback's own funnel*, where the counterfactual is not in question:

- "31% of weekly active users clicked JOIN" — a fact about our own UI.
- "62% of JOIN clicks resulted in arriving at that channel" — our funnel.
- "Sessions containing a JOIN are 18% longer than sessions without one" — an
  association, and it must be stated as one.

**Observational data cannot support** causal claims about Twitch behaviour:

- ❌ "Kickback caused +18% watch time."
- ❌ "X% of gathering notifications *produced* a Twitch session."
- ❌ "Social Gravity increased JOINs by Y%."

The reason is selection, not sample size. People who click JOIN are people who
had a reason to — friends online, an evening free, an interest in that
streamer. They would very likely have watched longer anyway. No amount of extra
observational data separates "Kickback caused this" from "the kind of person
who does this was going to".

**What would establish causality:**

| Claim | What it needs |
|---|---|
| "Social Gravity outperforms a flat friends list" | A randomised holdout: assign users to Gravity or flat at signup, compare JOIN rate between arms. This is the one the current schema is shaped for — `source` and the impression events make the comparison a group-by once the arms exist. |
| "Kickback caused +N% watch time" | A holdout where some users get no gathering surface at all, plus watch-time measurement Kickback does not currently have. Out of scope today. |
| "Notifications produce sessions" | A randomised notification holdout. `gathering_notification_shown` is recorded for everyone precisely so a suppressed arm would be comparable. |

Nothing is ever stored under a name like `incremental`. Events record
descriptive facts — `already_on_twitch`, `navigated`, `from_join` — and the
interpretation stays in the query, where it can be argued with.

---

## 13. Where the code is

| Concern | File |
|---|---|
| Event vocabulary and property contract | `src/core/analytics.ts` |
| Queue, batching, retry, disable switch | `src/background/analytics.ts` |
| Composition, and every decision about what an event means | `src/background/analyticsHub.ts` |
| Session lifecycle | `src/background/analyticsSession.ts` |
| JOIN attribution | `src/background/joinAttribution.ts` |
| Impression dedupe | `src/background/exposure.ts` |
| Shared-watch detection | `src/background/togetherWatch.ts` |
| Schema, contract, writer, reset | `supabase/migrations/0013_analytics.sql` |
| Reporting views | `supabase/migrations/0014_analytics_views.sql` |

`npm run test:analytics` breaks each rule above in turn and asserts a specific
test goes red. `npm run verify:analytics` checks the hosted schema is applied
and that nothing in it is readable by a client.
