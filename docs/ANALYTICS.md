# Watchside analytics

What Watchside measures, why, and exactly what leaves your browser.

This document is the source for beta disclosure, the eventual privacy policy,
and the Chrome Web Store listing. It is meant to be factual rather than
reassuring: if something is collected, it is named here.

---

## 1. Two kinds of data, kept apart

**Product data** is what Watchside needs in order to work at all: your account,
your friendships, your groups, the messages in them, and your presence. Without
it there is no product. It lives in the `users`, `friendships`, `groups`,
`group_messages` and `presence` tables.

**Analytics data** is what we look at to understand whether Watchside works: a
small set of events about what was shown and what was done. It lives in
`analytics_events` and nothing else reads it while Watchside is running.

The two are deliberately separate islands. No product table has a foreign key
into analytics, nothing in the extension ever reads analytics back, and all
analytics for an environment can be deleted without touching a single
friendship, message or presence row. There is a test for each of those claims.

---

## 2. What is collected

Every event carries:

| Field | What it is |
|---|---|
| `actor_id` | Your Watchside user id. **Taken from your session server-side**, never from anything the extension sends. |
| `environment` | `development`, `private_beta` or `production` — which build produced it. |
| `event_name` | One of the events in section 4. Anything else is discarded. |
| `session_id` | A random id for this stretch of Watchside use. Not linked to anything outside analytics. |
| `occurred_at` | When the thing **happened**, which for a shared watch ending is not when it was noticed. See section 8. |
| `received_at` | When the row reached the database. Always the server's clock. |
| `app_version` | e.g. `0.5.0`. So a tester on an old ZIP is identifiable as such. |
| `source` | Which Watchside surface: `friend_row`, `user_card`, `social_gravity`, `notification`, `group`. `gathering` is retired — see section 6a. |
| `destination_channel` | A Twitch channel login, for events that are about going somewhere. See section 3. |
| `attribution_id` | A random id linking one JOIN click to its arrival, shared watch and post-social retention. Held in the browser for minutes, then dropped. |
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
impression of somebody being somewhere, a shared watch, and the retention that
followed one. Ordinary browsing records nothing. There are no URLs, no paths,
no titles, and no history.

Post-social retention does not widen this. It is recorded **only** for a
destination where co-viewing had already happened, so it adds one interval to a
channel that was already in the record for a social reason. Watching a channel
Watchside knows nothing about produces no event at all, whatever you do there
and however long you stay.

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

**Exposure** — `friend_presence_impression`, `gravity_cluster_impression`;
`gathering_impression` is retired — see section 6a

**JOIN** — `join_clicked`, `join_arrived`

**Watching together** — `watching_together_started`, `watching_together_ended`,
`post_social_retention_ended`

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

A Watchside session **opens** the first time a Twitch tab reports activity with
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

## 6a. Social Gravity

The panel's Friends view is a map of destinations rather than a list of people.
Friends on the same channel become one card; the card is what you act on.

### What is recorded

`gravity_cluster_impression` — a destination was visible in the open panel.
Properties: `friend_count`, `rank`, `visible_clusters`, `opportunity_key`,
`destination_live`. Source `social_gravity`, `destination_channel` set.

`destination_live` is **absent** when nothing told us, rather than sent as
"unknown" — a property that is absent reads as absent in every query, whereas a
literal would have to be excluded by hand in each one, and eventually would not
be. It is the only Twitch metadata field recorded anywhere: stream titles,
viewer counts, categories and profile image URLs answer no question we have,
and a title is free text somebody else wrote.

Added by migration 0017, additively (`on conflict do update`), so events already
recorded keep their meaning.

```sql
-- Are we showing people destinations that have stopped streaming?
select coalesce((properties ->> 'destination_live')::boolean::text, 'unknown') as live,
       count(*)                                                                as impressions
from public.analytics_reportable_events_v
where event_name = 'gravity_cluster_impression'
group by live;

-- And do JOINs go to live ones? Joined on the opportunity, not on the channel.
select coalesce((s.properties ->> 'destination_live')::boolean::text, 'unknown') as live,
       count(distinct (s.actor_id, s.properties ->> 'opportunity_key'))          as shown,
       count(distinct (c.actor_id, c.properties ->> 'opportunity_key'))          as joined
from public.analytics_reportable_events_v s
left join public.analytics_reportable_events_v c
  on c.event_name = 'join_clicked'
 and c.source = 'social_gravity'
 and c.actor_id = s.actor_id
 and c.properties ->> 'opportunity_key' = s.properties ->> 'opportunity_key'
where s.event_name = 'gravity_cluster_impression'
group by live;
```

Deduped through the same exposure path as everything else: one per channel per
30-minute window, re-firing after a 5-minute absence. A presence heartbeat
re-renders the map and does **not** produce an impression.

**Only joinable destinations are reported.** The channel the viewer is already
on has no JOIN, so counting it would put rows that can never convert into the
denominator of impression-to-JOIN conversion.

`join_clicked` from the map carries `source: 'social_gravity'`, `social_count`,
and the same `opportunity_key`. It does **not** carry `rank` — the impression
already has it, and the two join on `opportunity_key`, so recording it twice
would be a second copy of a fact that could disagree with the first.

### Canonical identity versus display casing

A channel has two spellings and they do different jobs.

| | Spelling | Used for |
|---|---|---|
| **Canonical** | the lowercase login (`lvndmark`) | clustering, equality, "am I already here", the JOIN target, `destination_channel`, `opportunity_key` |
| **Display** | whatever casing Twitch chose (`LVNDMARK`) | on-screen text, and nothing else |

`parseChannelFromPath` lowercases at the point a channel enters the system, so
everything downstream - presence over the wire included - is canonical by
construction. `LVNDMARK` and `lvndmark` are one cluster, one destination and
one opportunity, and no analytics row can ever be split by capitalisation.

The display spelling is resolved separately, at render time, by
`resolveChannelName` in `src/core/channelNames.ts`. It never invents casing: it
looks the login up and returns the login unchanged if nothing knows better.
Two sources, neither needing a Twitch API call:

1. **A person Watchside already knows.** A channel is a Twitch user, so a
   friend's stored display name IS that channel's display name.
2. **A page this browser has opened.** The content script reads the casing off
   the `<title>`, which is Twitch telling us directly, and the worker keeps a
   capped `login -> display` map.

Both are keyed by login and hold one value per channel, so which friend is in a
cluster - or how many - cannot change the answer. The resolution is a function
of the channel, not of the people standing on it.

Source 2 needs the content script to report activity **again** once the title
catches up. Twitch changes the URL first and the title a beat later, so a report
sent at navigation time carries the *previous* page's title and learns nothing;
`watchTitle` exists for exactly that correction. Reporting only on channel
change is what left every destination showing its bare login.

**Twitch metadata now fills that slot.** `resolveChannelName` takes a third
source, ahead of both of the above: the metadata service's authoritative
`display_name`. It is the only source that can spell a channel this browser has
never opened and nobody here is friends with.

The order is provenance, not freshness. Metadata is the creator's own account
record; a known person is a copy of that record taken when they signed in; a
page title is a string. Each is a step further from the source, so each yields
to the one above it — and all three are still only text. See
docs/TWITCH_METADATA.md.

### The opportunity key

```
gravity:<channel>:<floor(now / 30 minutes)>
```

Derived only from what every viewer sees identically — the channel and the
clock — because amplification counts the viewers who *arrive* at one gathering,
and they can only be counted together if they all write down the same name for
it. Nothing about who is in the cluster goes into it.

| Requirement | How |
|---|---|
| Same across viewers | Both inputs are public and shared |
| No friend identities | Channel and time only |
| Brief flap keeps it | Same window |
| Re-forms later as new | Next window |
| Never random | Pure function of (channel, now) |

**Known cost, accepted:** a gathering spanning a window boundary is recorded as
two opportunities. Anchoring to when the cluster formed would keep it whole but
give late arrivals a different key from the people already there — and late
arrivals are exactly who amplification counts. Queries wanting the whole
gathering group by `destination_channel` over a time range.

Both the impression and the click derive the key in the **service worker** at
event time, from the same function, so they cannot disagree about which
opportunity they were.

### What happened to the gathering banner

The in-panel gathering banner said "🔥 N friends watching X" with a JOIN. The
top card of Social Gravity says the same thing, so keeping both would have
shown one gathering twice and counted one exposure twice.

| Thing | Status |
|---|---|
| Gathering **banner** in the panel | **Removed.** Gravity is the in-panel representation. |
| Gathering **notification** | **Unchanged.** Same threshold, cooldown and dismiss rules. |
| `gathering_notification_shown` / `_clicked` | **Unchanged**, still emitted. |
| `gathering_impression` | **No longer emitted.** It meant "the banner was visible"; there is no banner. |
| `join_clicked` with `source: 'gathering'` | **No longer emitted** from the panel. The notification path has always used `source: 'notification'`. |
| `gravity_cluster_impression` | **New**, and a strict superset: it also covers single-friend destinations, which never had a banner. |

This is a **deliberate discontinuity in the time series**, not a silent one. Any
query spanning the change must union the two events:

```sql
-- Social exposure across the Gravity boundary.
select case when event_name = 'gathering_impression' then 'banner' else 'gravity' end as surface,
       date_trunc('day', occurred_at) as day,
       count(*)                       as impressions
from public.analytics_reportable_events_v
where event_name in ('gathering_impression', 'gravity_cluster_impression')
group by surface, day
order by day;
```

Note the two are not like-for-like: the banner showed **one** gathering of 2+
friends, the map shows **every** destination including single friends. Compare
rates within a surface, not counts across the boundary.

### Experiment arms

`resolveArm` in `src/core/experiment.ts` decides which view a user sees. The
assignment is a **hash of the user id** — stable forever, identical on every
device, needing no table, no migration and no synchronisation.

| Environment | Arm |
|---|---|
| `development` | always `gravity` |
| `private_beta` | always `gravity` |
| `production` | deterministic 50/50 by user id |

Beta forces Gravity on purpose: a holdout across a handful of testers measures
nothing and would cost the feature half the people who are there to test it.
**Nothing derived from beta usage is a causal claim**, and `isRandomisedArm()`
returns false there so no query can mistake a constant for an experiment.

The arm is **not yet recorded on `authenticated_session_started`**. In beta it
would be a constant, and adding a property needs a contract row. When public
randomisation begins, recording it is one `INSERT` into `analytics_event_names`
plus one line at the call site — no schema change. **Do not run a public
experiment without doing that first.**

### The two questions Gravity has to answer

Deliberately not collapsed into one number:

```sql
-- A. Does the map persuade people to move?
with shown as (
  select properties ->> 'opportunity_key' as opportunity, actor_id, occurred_at
  from public.analytics_reportable_events_v
  where event_name = 'gravity_cluster_impression'
), clicked as (
  select properties ->> 'opportunity_key' as opportunity, actor_id, attribution_id
  from public.analytics_reportable_events_v
  where event_name = 'join_clicked' and source = 'social_gravity'
)
select count(distinct (s.actor_id, s.opportunity))                     as impressions,
       count(distinct (c.actor_id, c.opportunity))                     as joins,
       round(100.0 * count(distinct (c.actor_id, c.opportunity))
                   / nullif(count(distinct (s.actor_id, s.opportunity)), 0), 1) as pct
from shown s
left join clicked c on c.opportunity = s.opportunity and c.actor_id = s.actor_id;
```

```sql
-- B. Do those moves become anything?
select count(*)                                          as gravity_joins,
       count(together_started_at)                        as became_shared_watching,
       count(*) filter (where post_social_retained)      as stayed_after,
       avg(together_duration)                            as avg_shared_watch,
       avg(post_social_duration)                         as avg_stay_after
from public.analytics_join_funnel_v
where source = 'social_gravity';
```

```sql
-- Social amplification: viewers one opportunity produced.
select opportunity_key,
       destination_channel,
       count(distinct actor_id)                     as viewers_who_joined,
       count(distinct actor_id) filter (where arrived_at is not null) as arrived
from public.analytics_join_funnel_v
where source = 'social_gravity' and opportunity_key is not null
group by opportunity_key, destination_channel
order by viewers_who_joined desc;
```

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

## 8. Watching together, and what happens after

Two intervals, measured separately, because merging them would answer neither
question.

**Shared watch** — you are on a channel and at least one person visible to you
is too. Detected from real presence through the same `describePresence`
selector the UI uses, so "Watching with you" on screen and
`watching_together` in analytics cannot mean different things.

**Post-social retention** — the last of them has gone and you are still there.
This is the interval that says whether a socially-attributed destination
survived the social context that produced it.

### Detection time is not event time

This is the correction that this whole section exists for, and it came out of
real two-account testing.

A was watching summit1g. B joined and both were Watching Together. A left; B
kept watching alone for forty minutes and then left. B's shared watch was
recorded with the right *duration* — but stamped forty minutes late, and
labelled `left_channel` when what actually ended it was running out of people.
The forty minutes B stayed on were recorded nowhere at all.

The cause is that a remote friend leaving is not something we are told. It is
something we work out, when presence stops arriving — and if no presence
traffic arrives at all, we may not work it out until the user themselves moves.

So every end carries **both** times:

| | Meaning |
|---|---|
| `occurred_at` | When co-viewing actually stopped. This is the event's time and what every duration is measured against. |
| `detection_delay_ms` | How long after that we worked it out. Zero when immediate. For an `alone_again` end it is **bounded** at the 2-minute grace plus one 45s heartbeat — roughly 165s — because a longer silence is now read as a gap we cannot vouch for and closes as `observation_lost` instead. |
| `received_at` | When the row reached the database, as always. |

`analytics_together_v` exposes `effective_ended_at`, `detected_at` and
`detection_delay` as separate columns. **A late detection can no longer inflate
a duration**, and how late we were stays visible instead of being lost.

### Surviving the service worker being evicted

An MV3 worker is thrown away whenever Chrome decides to, and both intervals
routinely outlive one. Held only in memory, an evicted worker took the open
interval with it: the end was never emitted, and if the user was still watching
with somebody a second **start** was — counting one evening as two. The numbers
most likely to be lost were the long ones.

So the currently open interval is kept in `chrome.storage.local`: the phase,
the destination, its timestamps, the attribution, the peak count, the session it
began in, and when we last confirmed the user was there. **One value, describing
only what is open right now.** No history, no list of channels, no events. It is
deleted the moment the interval closes, so somebody who is not in a shared watch
has nothing about their viewing stored anywhere.

The same doubt is applied **on every tick**, not only on the way back from
storage. An OS suspend freezes a service worker without killing it, so a worker
can wake up holding an interval it has no business trusting — with its state
intact and no reason to question it. Before that check existed, the entire
sleep was reported as time spent watching together, which was the one place in
the system that could invent viewing time rather than merely lose some.

A frozen worker and a restarted one now reach the same answer, so correctness
no longer depends on whether Chrome happened to keep the worker.

Coming back — or waking up — we do not guess:

| On restart | What happens |
|---|---|
| Same channel, gap under **5 minutes** | Resume, or simply carry on. Nothing is emitted — the start was already recorded. |
| Gap over 5 minutes | **Close** at the last moment we could vouch for, reason `observation_lost`. |
| Channel changed | **Close** at the last moment we could vouch for, reason `left_channel`; the gap becomes detection lag. |
| A different account's interval | **Discard silently.** The actor is `auth.uid()` server-side, so emitting it would file one person's viewing under another's name. |
| Unreadable stored value | Discard. Fails closed: nothing resumed, nothing invented. |

That is deliberately conservative. A long eviction is split into two intervals
rather than credited as unbroken viewing — under-reporting, never over-reporting.
An interval also keeps the **session id it began in**, so its end pairs with its
start in the reporting views even when it outlives that session.

The gap is measured against the presence heartbeat, which ticks every 45s while
the worker is alive and the user is online. That is what distinguishes a
two-second restart from a laptop shut for three hours — without it, a quiet ten
minutes of watching looked identical to being away. It also means the
"everyone left" grace now expires on its own rather than waiting for the user to
move, so detection lag is usually seconds rather than however long they stay.

### Hysteresis, and why durations still exclude it

- Presence heartbeats every 45s and goes stale at 90s, so a friend can briefly
  appear to vanish. Ending on that would chop one evening into a dozen
  fragments, so the end waits **2 minutes** — but the interval is dated to when
  they actually went, not to when the wait expired.
- A channel change ends it immediately, because that is not ambiguous.
- `other_count_peak` is the most people it ever had, which answers "how shared
  was this" better than whoever happened to still be there at the end.

### The rules, precisely

| Situation | Shared watch | Post-social retention |
|---|---|---|
| Last co-viewer leaves at T1, user leaves at T2 | ends at **T1**, reason `alone_again` | T1 → T2 |
| User leaves while still with people | ends now, reason `left_channel` | none |
| One of several friends leaves | continues | none — it starts only when the **last** one goes |
| Friend vanishes briefly and returns | continues, gap included | none |
| Friend returns after the context dissolved | a **new** shared watch starts | ends, reason `rejoined` |
| User changes channel | ends | ends, reason `left_channel` |
| Sign-out | ends, reason `session_ended` | ends, reason `session_ended` |
| Worker evicted **or machine slept**, gap over 5 min | ends, reason `observation_lost` | ends, reason `observation_lost` |
| Co-viewing that no JOIN caused | measured | measured, but with **no attribution** |

That last row matters. The intervals are facts and are recorded either way; the
*credit* is not. `from_join` is false and `attribution_id` is null for organic
co-viewing, and `analytics_join_funnel_v` does not contain it at all.

### A shared watch requires a live stream

Being on `twitch.tv/lirik` and watching LIRIK are two different facts, and
until 2026-08-24 everything downstream of presence treated them as one.

Presence reports where a browser is - correctly, and that has not changed. What
changed is that the shared-watch lifecycle no longer opens from presence alone:
`updateTogether()` in the worker passes `socialChannel()`, which is the
current channel **only when Twitch says a stream is running on it**. The rule
lives in `src/core/socialViewing.ts` and is the same one that decides whether
a Stream Room forms, so the panel and the database cannot disagree about what
"watching together" meant.

Uncertainty is not live. A cold cache, a Twitch outage and a channel nobody has
asked about all report `unknown`, and none of them starts an interval. This
undercounts - a live stream whose metadata has not arrived yet loses the first
moments of a shared watch - and that is the intended direction. It is the same
trade as everywhere else here: conservative undercounting over fabricated
watch time.

**A limitation in historical rows.** `watching_together_started` /
`_ended` rows written before 2026-08-24 were produced by the presence-only
rule, so a private-beta interval may record two people sitting on a channel
with no stream on it. The rows are not distinguishable after the fact - nothing
recorded the live state of the destination at the time - so **nothing has been
rewritten**. Treat pre-2026-08-24 `together_duration` figures as an upper
bound rather than a measurement. Rows from the reset before public launch
(section 9) are unaffected, because there are none.

### Retention as a metric, not a judgement

`post_social_retained` is true whenever the user was still on the destination
after the social context dissolved — including by two seconds. **How long** is
`post_social_duration`. A query that wants "meaningfully retained" should
threshold on the duration; the boolean deliberately does not decide for you.

## 8a. Individual referral versus cluster referral

A JOIN's social cause is not always a person.

| | `source` | What caused it |
|---|---|---|
| Individual referral | `friend_row`, `user_card` | one person, whose row was clicked |
| Cluster referral | `gathering`, `group`, later `social_gravity` | the **opportunity**, not any one member of it |

`social_count` records how many people the surface was showing. Nothing
anywhere records *which* friend was in a cluster, and nothing picks one to
credit: when A sees "🔥 xQc · 3 friends" and joins, the social context gets the
attribution, not Jake.

`opportunity_key` is registered on `join_clicked` and
`gravity_cluster_impression` and is **not set by anything yet**. A friend row is
one person and needs no key; a Gravity cluster is a thing several people act on
separately, and "how many viewers did *one* gathering produce" needs them to
agree on what one gathering was. It is reserved now, and its round-trip is
tested, so that checkpoint sets a property rather than changing a contract.


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
| 0–9 | shared-watch starts and ends, plus the retention that followed one |
| 0–30 | group opens, messages, combos |

**Roughly 10–90 events per user per day**, dominated by impressions and
therefore by how long the panel is left open with a large friends list.

The server budget is **600 events per 5 minutes per user**, charged per *event*
rather than per call so batching cannot be used to cheat it, with a hard cap of
**50 events per call**. That is around forty times the heaviest realistic
session and is not reachable by using Watchside.

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
-- The whole socially-attributed destination lifecycle, one row per JOIN.
-- This is the query to run when inspecting a single real test.
select source,
       destination_channel                      as destination,
       social_count,
       opportunity_key,                          -- null until Social Gravity
       clicked_at,
       arrived_at,
       together_started_at,
       together_effective_ended_at,              -- when co-viewing really ended
       together_detected_at,                     -- when we worked that out
       together_detection_delay,
       together_duration,
       together_end_reason,
       post_social_retained,
       post_social_duration,
       destination_left_at
from public.analytics_join_funnel_v
where environment = 'private_beta'
order by clicked_at desc
limit 20;
```

```sql
-- Post-social retention rate, by the surface that produced the JOIN.
-- The 60-second floor is a choice, not a definition: `post_social_retained`
-- is true for two seconds of retention, and thresholding belongs in the query.
select source,
       count(*)                                                     as shared_watches,
       count(*) filter (where post_social_duration > interval '60 seconds')
                                                                    as retained,
       round(100.0 * count(*) filter (where post_social_duration > interval '60 seconds')
                   / nullif(count(*), 0), 1)                        as retention_pct,
       avg(post_social_duration) filter (where post_social_retained) as avg_stay
from public.analytics_join_funnel_v
where environment = 'private_beta'
  and together_started_at is not null
group by source
order by shared_watches desc;
```

```sql
-- Shared-watch duration, split by whether a JOIN caused it.
-- Organic co-viewing is measured but never credited to a JOIN, so it is the
-- honest baseline to compare an attributed shared watch against.
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

```sql
-- How late our detection actually is. Worth watching: a large delay does not
-- corrupt any duration, but it does mean live dashboards lag reality.
select count(*)                                          as ended_intervals,
       count(*) filter (where detection_delay > interval '0')  as noticed_late,
       max(detection_delay)                              as worst,
       percentile_cont(0.9) within group (order by extract(epoch from detection_delay))
                                                         as p90_seconds
from public.analytics_together_v
where environment = 'private_beta' and effective_ended_at is not null;
```

```sql
-- Social amplification, as far as it can be measured today: how many distinct
-- viewers a destination drew through Watchside in a window.
--
-- Per-DESTINATION, not per-gathering. Counting the viewers one specific
-- gathering produced needs `opportunity_key`, which nothing sets yet.
select destination_channel,
       date_trunc('hour', arrived_at)   as hour,
       count(distinct actor_id)         as arrivals,
       count(distinct actor_id) filter (where post_social_retained) as stayed_on
from public.analytics_join_funnel_v
where environment = 'private_beta' and arrived_at is not null
group by destination_channel, hour
order by arrivals desc
limit 20;
```

```sql
-- Everything split by environment, to check nothing is mixed
select environment, count(*) as events, count(distinct actor_id) as people,
       min(occurred_at) as first_seen, max(occurred_at) as last_seen
from public.analytics_reportable_events_v
group by environment;
```

---

## 11a. The strategic metrics

What the schema can answer today, and what it cannot. Anything marked FUTURE is
not computable now and must not be quoted.

| # | Metric | Status | How |
|---|---|---|---|
| 1 | **Social JOIN Rate** | ✅ now | share of weekly actives with a `join_clicked`; by `source` for surface comparison |
| 2 | **Non-Followed Creator JOIN Rate** | 🚫 FUTURE | needs Twitch follow state; see §11b |
| 3 | **Shared-Watch Duration** | ✅ now | `analytics_together_v.duration`, measured to the effective end |
| 4 | **Post-Social Retention Rate** | ✅ now | share of shared watches with `post_social_retained` and a duration over your threshold |
| 5 | **Post-Social Retention Duration** | ✅ now | `analytics_together_v.post_social_duration` |
| 6 | **Social Follow Conversion** | 🚫 FUTURE | needs Twitch follow state; see §11b |
| 7 | **Social Amplification** | ⚠️ partial | arrivals per destination per window are computable now; *per gathering* needs `opportunity_key`, which is reserved and unset until Social Gravity |
| 8 | **Incremental Twitch Engagement** | 🚫 FUTURE | requires a randomised holdout **and** watch-time measurement Watchside does not have |
| 9 | **Retention lift** | ⚠️ partial | D1/D7/D30 by cohort is computable; *lift* is a causal claim and needs an experiment |

## 11b. Twitch follow state: the future integration point

Two of the metrics above need to know whether the viewer already followed the
creator when they joined, and whether they followed afterwards. **Watchside
cannot know either today**, and nothing in the schema pretends otherwise.

The reason is architectural, not an oversight: Watchside deliberately retains no
usable Twitch provider token. Supabase holds the OAuth result, the extension
never sees a provider access token, and no scope beyond the default has been
requested. Inventing `following_at_join` from anything we *do* have would be
fabrication.

### What would be needed

A separate **Twitch OAuth/API capability** checkpoint — explicitly not this one
— that adds server-side provider-token handling, a scope audit, and
`user:read:follows`.

### Why adding it later is cheap

The contract is **data, not DDL**. Registering a new event or a new property is
one `INSERT ... ON CONFLICT DO UPDATE` into `analytics_event_names`, exactly as
migration 0015 does. Concretely, that checkpoint would need:

1. `following_at_join` added to `join_clicked`'s allowed properties — one row.
2. A `creator_followed` event, with `destination_channel` — one row.

No table, column, index, policy or grant changes; no client transport changes.

### Joining a later follow back to the JOIN that may have caused it

The browser drops an attribution within minutes, so a follow observed days
later cannot quote `attribution_id`. It does not need to: the destination and
the actor are enough to find the JOIN in SQL.

```sql
-- The shape a follow-conversion query would take, once the event exists.
select j.source, j.destination_channel, count(*) as follows
from public.analytics_reportable_events_v f
join public.analytics_join_funnel_v j
  on j.actor_id = f.actor_id
 and j.destination_channel = f.destination_channel
 and f.occurred_at between j.clicked_at and j.clicked_at + interval '7 days'
where f.event_name = 'creator_followed'   -- FUTURE: does not exist yet
group by j.source, j.destination_channel;
```

### One semantic distinction to preserve

**"Not following" does not mean "has never watched before."** A viewer may have
watched a creator for years without following them. Any future field must be
named for what it observes — `following_at_join` — and never read as
first-ever-exposure.

If we later want to track first exposure, it must be named honestly (something
like `first_observed_by_kickback_at`), scoped to destinations Watchside already
records for a social reason, and understood as *what Watchside saw*, never as
*what the viewer had done*. Watchside's records begin when Watchside was
installed; they are not the viewer's history.

---

## 12. What these numbers can and cannot say

This matters more than any single query.

**Observational data supports** statements about *association*, and about
things Watchside itself did, where the counterfactual is not in question:

- ✅ "This JOIN was initiated through Watchside" — we performed the navigation.
- ✅ "31% of weekly active users clicked JOIN" — a fact about our own UI.
- ✅ "62% of JOIN clicks resulted in arriving at that channel" — our funnel.
- ✅ "After co-viewing ended, viewers stayed a median of 11 more minutes" — a
  measured interval, stated as a measurement.
- ✅ "Sessions containing a JOIN are 18% longer than sessions without one" — an
  association, and it must be stated as one.
- ✅ *(once follow state exists)* "The viewer was not following this creator at
  the time of the JOIN", and "the viewer followed within 7 days of it" — both
  observations about sequence, not about cause.

**Observational data cannot support** causal claims about Twitch behaviour:

- ❌ "Watchside caused +18% watch time."
- ❌ "Watchside caused the follow." Following *after* an attributed JOIN is a
  sequence, not a cause: the viewer chose to join because they were already
  interested, and might well have found the creator anyway.
- ❌ "X% of gathering notifications *produced* a Twitch session."
- ❌ "Social Gravity increased JOINs by Y%."
- ❌ "Post-social retention proves Watchside creates lasting viewership." It
  shows the viewer stayed; it does not show they would have left otherwise.

The reason is selection, not sample size. People who click JOIN are people who
had a reason to — friends online, an evening free, an interest in that
streamer. They would very likely have watched longer anyway. No amount of extra
observational data separates "Watchside caused this" from "the kind of person
who does this was going to".

**What would establish causality:**

| Claim | What it needs |
|---|---|
| "Social Gravity outperforms a flat friends list" | A randomised holdout: assign users to Gravity or flat at signup, compare JOIN rate between arms. This is the one the current schema is shaped for — `source` and the impression events make the comparison a group-by once the arms exist. |
| "Watchside caused +N% watch time" | A holdout where some users get no gathering surface at all, plus watch-time measurement Watchside does not currently have. Out of scope today. |
| "Notifications produce sessions" | A randomised notification holdout. `gathering_notification_shown` is recorded for everyone precisely so a suppressed arm would be comparable. |
| "Watchside caused the follow" | A holdout on the social surface, plus follow state. Comparing followers-after-JOIN to a group that never saw the opportunity - not to people who saw it and declined, who differ in exactly the way that matters. |
| "Watchside creates lasting viewership" | A holdout, plus watch-time measurement. Post-social retention is the right *outcome* to measure in such an experiment; on its own it is a description of one arm. |

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
| Social Gravity clustering and opportunity keys | `src/core/socialGravity.ts` |
| Experiment arms | `src/core/experiment.ts` |
| Shared-watch and post-social detection | `src/background/togetherWatch.ts` |
| Surviving a worker restart | `src/background/togetherStore.ts` |
| Schema, contract, writer, reset | `supabase/migrations/0013_analytics.sql` |
| Reporting views | `supabase/migrations/0014_analytics_views.sql` |
| Social discovery semantics, contract and clock | `supabase/migrations/0015_social_discovery.sql` |
| Lifecycle reporting views | `supabase/migrations/0016_social_discovery_views.sql` |

`npm run test:analytics` breaks each rule above in turn and asserts a specific
test goes red. `npm run verify:analytics` checks the hosted schema is applied
and that nothing in it is readable by a client.
