# KICKBACK — MULTI-STREAM / SIMULTANEOUS STREAM ROOM ARCHITECTURE

**Date:** 2026-08-27
**Type:** architecture and product investigation. **No implementation.**
**Follows:** [friends-beta-investigation-2026-08-27.md](friends-beta-investigation-2026-08-27.md)
**Version investigated:** 0.4.0, hosted schema current through `0023_feedback.sql`

**Status: INVESTIGATION ONLY.** No product code changed, no migration created,
no hosted Supabase state or configuration touched, nothing published, nothing
committed. This report file is the only repository change.

---

## Evidence grades

Used strictly throughout. Nothing is promoted beyond what the evidence supports.

| Grade | Meaning |
| --- | --- |
| **PROVEN CURRENT BEHAVIOUR** | Read directly from source or migration. The citation is the proof. |
| **ARCHITECTURAL REQUIREMENT** | A constraint the design must satisfy. Not negotiable, and where it comes from is stated. |
| **PRODUCT RECOMMENDATION** | A decision that needs an owner. The reasoning and the alternative are given. |
| **RISK** | A way this can go wrong, with its mitigation. |
| **OPEN QUESTION** | Genuinely unresolved. Not dressed up as a decision. |

---

## 1. Executive recommendation

**Adopt the multi-destination model (alternative D). Do not ship
`document.hasFocus()`. Do not ship the five-minute continuity lease. Run it as
its own checkpoint immediately after Friends Beta Patch 1. Complexity: MEDIUM.**

The investigation produced one finding that decides the question, and it was not
the finding expected going in.

**The current architecture is already almost entirely channel-parameterised.**
`send_room_message(p_channel, p_body)`, `send_together_reaction(p_channel,
p_reaction)` and `stream_room_members(p_channel)` all take the channel as an
argument. `room_messages` and `together_reactions` both carry a `channel`
column. The client already filters its message buffer by channel
(`src/core/roomMessages.ts:166`). **Nothing in the room, message, reaction or
security layer assumes a user has only one channel.**

The single-channel assumption lives in exactly two places:

1. `public.presence` has one nullable `channel` column
   (`supabase/migrations/0001_schema.sql:109-122`); and
2. four presence *predicates* — in `stream_room_members`, `send_room_message`,
   `send_together_reaction`, and `report_presence` — spell it
   `p.channel = v_channel` rather than "is this channel among theirs".

**That is the whole of it.** The change is narrow, and it is narrow because the
0020/0021 design already made the right call: a room is `(destination,
connected component)` computed on demand, and the destination was always a
parameter.

**The security model does not change at all, and this is the decisive point.**
Component isolation comes from the recursive walk over `friendships` seeded at
the caller with `blocked_pair` cut into the join
(`supabase/migrations/0022_blocks.sql:446-532`). The channel predicate only
decides *candidacy* — who is standing on this destination. The friendship walk
decides *membership*. Two unrelated components on the same channel were never
kept apart by single-channel presence, so making presence multi-valued cannot
merge them. **§9 proves this against all seven required scenarios.**

**Realtime does not get worse.** The binding is filtered `user_id=eq.<friend>`
(`src/background/supabaseRealtime.ts:106-121`), so it is O(friends) whether a
friend publishes one destination or three. Multi-destination does **not**
multiply bindings by open streams. The first scaling wall is exactly where it
was: the per-client `postgres_changes` cap, somewhere between 100 and 250
friends. Unchanged.

The genuinely new work is the honesty problem the brief identifies — **an open
tab is not a watched stream.** The recommendation solves it with **one
timestamp and one threshold**, no attention scoring:

> **A stream counts as yours while its tab is open, and stops showing to your
> friends thirty minutes after you last looked at it.**

Thirty minutes is not arbitrary: it is already `RETENTION_MS`
(`src/core/roomMessages.ts:67`) and already `OPPORTUNITY_WINDOW_MS`
(`src/core/socialGravity.ts:84`). A destination's aliveness and its
conversation's lifetime then expire *together*, which structurally prevents the
bug class found in the previous investigation — a surface outliving, or being
outlived by, its data.

**Crucially, focus stops being a network event.** Today, switching Twitch tabs
writes to the database and reshapes every downstream surface. Under the
recommendation, focus is a purely client-local concept: it never leaves the
browser, and it never changes what friends see. Bouncing between tabs becomes
free. That is what makes the panel stable, and it is the actual fix for the
complaint that started this.

**One-line summary of the model:**

> Presence becomes *the set of Twitch destinations you have open and have
> looked at recently*, capped at three. Everything downstream keeps working
> because everything downstream already took a channel.

---

## 2. Current architecture

**Grade: PROVEN CURRENT BEHAVIOUR throughout this section.**

### 2.1 The single effective channel

`src/background/activity.ts` is a pure function over a map of tabs. The tab key
is the content script's `chrome.runtime.Port` object itself
(`src/background/index.ts:1426-1436`, `:1570-1576`); there is no `tabs`
permission and no tab id.

`pick()` (`activity.ts:63-77`), in order:

1. a visible tab beats a hidden one;
2. among equals, highest `updatedAt` wins;
3. no tabs → `IDLE`.

The content script reports `{channel, visible: !document.hidden, channelName}`
on connect, SPA navigation, `visibilitychange`, `pageshow`, and on the title
correction (`src/content/index.tsx:110-140`).

### 2.2 The storage shape

`supabase/migrations/0001_schema.sql:109-122`:

```sql
create table if not exists public.presence (
  user_id      uuid primary key references public.users (id) on delete cascade,
  status       text not null default 'offline' check (status in ('online','offline')),
  platform     text check (platform in ('twitch')),
  channel      text check (channel is null or channel ~ '^[a-z0-9_]{1,25}$'),
  last_seen_at timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  constraint presence_channel_requires_platform check (channel is null or platform is not null),
  constraint presence_offline_has_no_activity
    check (status = 'online' or (platform is null and channel is null))
);
```

**One row per user, one channel.** Provisioned automatically for every account
by `sync_kickback_identity()` (`supabase/migrations/0004_auth_bootstrap.sql`).

### 2.3 The write path, and where privacy is applied

`report_presence(p_platform, p_channel)`
(`supabase/migrations/0006_presence_rate_limit.sql:66-126`):

- rate-limited via `consume_presence_budget()` — 90 writes/minute;
- **visibility is applied at WRITE time**, not read time:
  - `invisible` → the row is forced to offline/null, and timestamps are only
    touched when the row was not already blank, so a friend cannot infer
    "online but hiding" from a ticking `last_seen_at`;
  - `hide_activity` → platform and channel are nulled before the upsert;
- otherwise upserts `status='online'` with the channel.

`heartbeat()` (`:129-146`) touches `last_seen_at` only.

Client side: `createPresenceReporter` (`src/background/presence.ts`) debounces
writes by **1 000 ms**, heartbeats every **45 s** (half the 90 s staleness
window), and delays offline by **5 000 ms** because JOIN tears one tab down and
opens another.

### 2.4 Staleness is a read-time rule, and there is precedent

`src/core/presence.ts:9-14`:

```ts
export const PRESENCE_STALE_MS = 90_000
// ... now - presence.lastSeenAt > PRESENCE_STALE_MS
```

**No write marks somebody stale.** Every client evaluates the same rule against
the same timestamp. The server does the same, inline, in three functions —
`and p.last_seen_at > now() - interval '90 seconds'`. This is the precedent the
recommended staleness policy follows exactly (§7).

### 2.5 Rooms: destination is already a parameter

`stream_room_members(p_channel text)`
(`supabase/migrations/0022_blocks.sql:446-532`). It:

1. refuses unless the **caller** is online on that channel and fresh within 90 s
   — "knowing a channel name grants nothing";
2. builds `present` = everyone online on that channel and fresh;
3. walks `friendships` recursively from the caller, joined against `present`,
   bounded at 3 hops, cycle-guarded by a path array, with
   `not public.blocked_pair(v_actor, f.friend_id)` **on the join**;
4. returns at most 50 members with `hops` and `via_user_id`.

`send_room_message(p_channel, p_body)`
(`supabase/migrations/0021_room_messages.sql:137-224`) validates the channel,
rate-limits, checks the sender's presence *on that channel*, then fans out one
row per recipient plus a self-row, and sweeps on the way past (30 minutes,
200 rows per recipient per channel).

`send_together_reaction(p_channel, p_reaction)`
(`supabase/migrations/0020_stream_rooms.sql:~250-300`) has the identical shape.

Read policy for both is only `recipient_id = (select auth.uid())` — the
authorization decision was materialised at write time.

### 2.6 The coupling that actually hurts

`sessionChannel()` (`src/background/index.ts:765-774`) returns null until the
presence **write has landed**. Because writes are debounced by a second, **every
channel change has a 1–2 second window where the room surface, its buffer and
its roster are all torn down** — `pushActivity()` calls
`roomChat.setChannel(null)`, which clears the buffer and does not fetch
(`src/background/roomMessages.ts:174-190`).

And `sessionAvailable` (`src/ui/KickbackPanel.tsx:236`) gates the entire room
surface on at least one *other* live person, while its messages live thirty
minutes.

**These two are the mechanism behind everything the brief describes:** tabs
appearing and disappearing, conversations hidden, holes in history, chat state
tied to focus. They were the proven root cause of finding #10 in the previous
report.

### 2.7 What single-channel presence is NOT responsible for

**ARCHITECTURAL REQUIREMENT, stated here because it governs §9.** Component
isolation is produced entirely by the friendship walk and the block predicate.
The channel predicate contributes candidacy only. **No security property in this
system depends on a user having exactly one channel.**

---

## 3. Proposed presence semantics

### 3.1 The redefinition

**PRODUCT RECOMMENDATION.** Presence becomes:

```
user → { liveness } + { set of published destinations }
```

- **Liveness** stays exactly where it is: one row per user, `status` +
  `last_seen_at`, heartbeated every 45 s, stale at 90 s. Unchanged semantics,
  unchanged constants, unchanged privacy behaviour.
- **Destinations** become a set: which Twitch channels this user has open and
  has looked at recently.

### 3.2 The state vocabulary — deliberately two states, not five

The brief asks whether we need `primary` / `open` / `active` / `recently
active` / `stale`, and warns against an attention-scoring system.

**We need two states, and both fall out of one timestamp.**

| Concept | Where it lives | How it is decided |
| --- | --- | --- |
| **OPEN** | client only | a content-script Port exists for a tab on that channel |
| **FOCUSED** | **client only — never written, never sent** | `document.hidden === false` **and** `document.hasFocus() === true` |
| **ACTIVE** | published to the server | `last_active_at > now() - 30 minutes` |
| **STALE** | derived by every reader | published, but `last_active_at` older than 30 minutes |
| **PRIMARY** | **client only** | the focused destination, else the most recently active one |

Three of the five are client-local. **The server stores one extra timestamp per
destination and nothing else.**

**Why FOCUSED must not be published — this is the core insight.** Today, focus
changes are database writes, and therefore realtime events, and therefore
reshape every friend's map. That is exactly why the panel feels unstable. Under
this model **focus never leaves the browser.** Bouncing between three Twitch
tabs produces zero network traffic and zero visible change for anybody.

**Why PRIMARY must not be published.** Nothing on the server needs it. Rooms
take a channel parameter. Gravity takes a set. JOIN attribution is client-side.
Publishing a primary would reintroduce exactly the focus-follows-network
coupling being removed.

### 3.3 The write rule

`last_active_at` for a destination is refreshed when, and only when:

- the tab opens on that channel, or navigates to it; **or**
- the tab is focused-and-visible and the value is older than a refresh interval
  (recommend **5 minutes**, so a long viewing session writes at most 12 times an
  hour per destination).

A destination is **removed** when its tab closes, navigates away, or is evicted
by the cap.

**RISK, and its mitigation.** A naive implementation would write on every focus
change and be *worse* than today. The 5-minute refresh floor is what prevents
that; it must be a client-side throttle in the background worker, not a
server-side rate limit. Server-side, `consume_presence_budget()` (90/minute)
already backstops a misbehaving client.

### 3.4 The cap

**PRODUCT RECOMMENDATION: publish at most 3 destinations per user**, keeping the
three most recently active and evicting the rest.

Reasons, in order of weight:

1. **It is true.** Nobody meaningfully watches four streams. A fourth
   destination in the last thirty minutes is a tab you passed through.
2. **It bounds everything downstream** — Gravity clusters, room fan-out,
   realtime row volume, analytics dimensionality — with one number.
3. **It is enforceable server-side** in the write RPC, so a modified client
   cannot inflate its own gravity by publishing twenty destinations.

The cap applies to *published* destinations. The client may track more locally;
it simply does not tell anyone about them.

### 3.5 Privacy carries over unchanged

**ARCHITECTURAL REQUIREMENT.** Redaction stays at write time:

- `invisible` → publish **zero** destinations and force liveness to offline,
  with the same "do not touch timestamps if already blank" rule.
- `hide_activity` → stay online, publish **zero** destinations.
- `visible` → publish up to 3.

This is strictly simpler than today's `v_channel := null` branch, because
"publish nothing" is the natural expression of "hide my activity" when activity
is a set.

### 3.6 The one-sentence user model

> **Kickback shows the streams you have open, and stops showing one to your
> friends thirty minutes after you last looked at it.**

---

## 4. Proposed Stream Room semantics

### 4.1 What does not change

**ARCHITECTURAL REQUIREMENT — preserve all of this:**

- A room has **no record**: no room table, no room id, no membership table. A
  room *is* `(destination, connected component)` computed on demand.
- **Recipients are materialised at send time.** One row per recipient. A split
  room stops delivering; a merged room never backfills.
- Read policy stays `recipient_id = (select auth.uid())`.
- Bounds stay 30 minutes and 200 rows per recipient per channel.
- Nothing is drawn optimistically; the sender's own copy returns by the same
  route as everyone else's.

### 4.2 What changes

**Exactly one thing: a user may now satisfy the "is present on this channel"
predicate for more than one channel at a time.**

Concretely, in four places, `p.channel = v_channel` becomes an existence test
against the destination set with the activity window applied. No signature
changes. No new tables in the message path. No change to the fan-out shape.

### 4.3 Lifecycle answers

| Event | Behaviour |
| --- | --- |
| **Room appears** | A destination is ACTIVE **and** `stream_room_members(channel)` returns ≥1 person. Same rule as today, evaluated per destination. |
| **Room disappears** | When the destination is gone **and** its retained messages have expired. Not when the last peer leaves — that was the proven root cause of finding #10. |
| **Messages routed** | Unchanged. Per-recipient rows carrying `channel`. The client already buckets its buffer by channel. |
| **Retained history** | Unchanged: 30 minutes, 200 rows, per recipient per channel, opportunistically swept. |
| **Reactions** | Unchanged. `send_together_reaction` is already channel-parameterised; only its presence predicate widens. The 8-second activity window is per channel already (`roomActivity` in `src/core/roomMessages.ts`). |
| **Room tabs in UI state** | One tab per ACTIVE destination with a room, plus retained-but-closed rooms. Selection is user intent only. See §11. |
| **Its Twitch tab closes** | The destination is removed immediately — a close is an unambiguous signal. The **room tab stays** until retained messages expire, marked as no longer live. |
| **That tab navigates to another channel** | Old destination removed, new one added, in one write. Two rooms transition; nothing else moves. |
| **Destination goes stale** | It drops out of Gravity and out of other people's rooms. **Locally the room tab remains** while messages are retained, so the user is never ejected from a conversation they can still read. |
| **Browser restart** | No tabs → no destinations → offline after the 5 s grace. On restart, tabs re-register and destinations are republished. Retained messages are re-fetched by channel, exactly as today. |
| **Service-worker eviction** | Ports die, the worker restarts, content scripts reconnect and re-report. The 90 s liveness window covers the gap; the 30-minute activity window is far wider than any eviction. **Strictly more robust than today**, because today a re-report races the debounce and blanks the surface (§2.6). |

### 4.4 The asymmetry the brief identified is now encoded

> "Closing a Twitch stream tab is a much stronger signal that I have left that
> destination than merely focusing another Twitch tab."

**PRODUCT RECOMMENDATION — adopt this as the governing rule.** Under the
proposal, closing a tab removes a destination immediately; focusing another tab
does nothing at all. The two signals are treated as differently as they deserve,
which is the opposite of today.

---

## 5. Proposed schema / data model

### 5.1 The five candidates, compared

| Criterion | **A.** child table `presence_destinations` | **B.** presence row + separate open-destination table | **C.** ephemeral room-membership table | **D.** array column on `presence` | **E.** keep singular presence, track open destinations separately |
| --- | --- | --- | --- | --- | --- |
| Conceptual clarity | **High** — "presence is liveness; destinations are where" | Medium — two tables that both mean presence | Low — conflates a derived thing (room) with a stored one | Medium — arrays hide structure | **Low** — two sources of truth for the same question |
| Query complexity | Low — one `exists` per predicate | Medium | High — membership must be maintained | Medium — `= any()` works but per-destination timestamps do not fit | High — every reader must reconcile two answers |
| RLS / security | **Same posture as `presence` today** | Same, doubled | **Dangerous** — a stored room record is a new object needing its own policy | Same | Two policies to keep in agreement |
| Realtime complexity | **Unchanged** — filter on `user_id`, O(friends) bindings | Unchanged, but two tables to subscribe | New table, new subscription | Unchanged | Two subscriptions |
| Gravity computation | Natural — group destinations by channel | Natural | Awkward — rooms are not gravity | Workable | Awkward |
| Room computation | **One-line predicate change** | One-line change | Contradicts "a room has no record" | One-line change | Ambiguous which table wins |
| Cleanup / staleness | Read-time rule on `last_active_at`; rows removed on close | Same | Requires an explicit lifecycle | **Cannot express per-destination timestamps** | Same |
| Analytics | Clean per-destination rows | Clean | Poor | Poor — arrays are hostile to SQL analysis | Poor |
| Future scaling | Indexed `(channel, last_active_at)` gives cheap "who is on X" | Same | Worst | Poor | Poor |
| Migration risk | **Low** — additive; `presence.channel` retained as a compat shim | Low | High | Medium | Low but permanently confusing |
| Reasoning about correctness | **Easiest** — one fact per row | Harder | Hardest | Hard | Hardest |

### 5.2 Recommendation

**Adopt A: a child table, with `public.presence` retained as the liveness row.**

**PRODUCT RECOMMENDATION.** Conceptual shape (not a migration — deliberately
prose, per the constraints):

- **`public.presence` keeps** `user_id`, `status`, `last_seen_at`, `updated_at`.
  It becomes purely "is this account alive, and when did we last hear from it".
  `platform` and `channel` are **retained but deprecated** during the compat
  window (§13) and stop being read afterwards.
  - The `presence_offline_has_no_activity` constraint continues to do useful
    work during the window and is retired with the columns.
- **New `public.presence_destinations`**, primary key `(user_id, channel)`:
  - `user_id` → `public.users(id)` on delete cascade
  - `channel` — the same `^[a-z0-9_]{1,25}$` check the current column carries
  - `platform` — `'twitch'`, same check, kept so a second platform is a value
    rather than a migration
  - `opened_at` — when this destination first appeared. Stable; used for **UI
    ordering**, which is why it must not be touched by activity.
  - `last_active_at` — the single timestamp the whole staleness model rests on
  - index on `(channel, last_active_at)` — makes "who is on this channel"
    an index scan, which is what `stream_room_members`' `present` CTE needs
  - index on `(user_id)` — implied by the PK
  - **RLS identical in posture to `presence` today**: readable by the same
    predicate that governs `presence` (self, friends, group co-members), all
    writes through SECURITY DEFINER RPCs only.
  - **A cap of 3 rows per user enforced in the write RPC**, evicting the
    least-recently-active.

### 5.3 Why not the smallest migration

**The brief explicitly forbids choosing on migration size, and the honest answer
is that A is not the smallest.** E (keep singular presence, track destinations
separately) is smaller and is *worse* — it leaves two tables answering "where is
this person", which is the same defect that made the previous investigation's
finding #10 hard to see: a surface and its data disagreeing about a fact. A has
exactly one row per (person, destination) and one timestamp per row, and every
question is answered from that.

### 5.4 Derived reads

- **"Where is X?"** → their destination rows, filtered to
  `last_active_at > now() - 30m`, ordered by `last_active_at desc`.
- **"Is X on channel C?"** → `exists (…)` with the same window. This is the
  predicate the four functions need.
- **"Is X online?"** → unchanged: `presence.status='online' and last_seen_at >
  now() - 90s`.

**Two clocks, both pre-existing concepts:** 90 seconds for *is this person
here*, thirty minutes for *does this stream still count*. Neither is new.

---

## 6. Social Gravity behaviour

**This is the section the brief marked critical, and the answer is yes — with
one hard rule that protects the meaning.**

### 6.1 The example, answered

> Chuck has Summit and Peanut open. Julie has Summit. Mike has Peanut.

**Gravity should show:**

```
Summit — Chuck + Julie
Peanut — Chuck + Mike
```

**PRODUCT RECOMMENDATION: yes.** Because it is true, and because it is more
useful than either alternative. Under today's model Chuck appears on exactly one
of them and the other gathering is invisible — which is precisely the
"conversations being hidden" complaint. Under a "primary only" model the same
loss occurs with extra machinery.

### 6.2 The rule that prevents fake gravity

**ARCHITECTURAL REQUIREMENT: only ACTIVE destinations enter Gravity. Stale ones
contribute nothing — not a reduced weight, nothing.**

**Binary, not weighted.** A weighting system would need a scoring function, a
tuning process, and a way to explain to a user why they count as 0.4 of a
person. The brief rules that out and it is right to. A destination is either
recent enough to be real or it is not.

**So: "how do we prevent forgotten tabs creating fake Gravity?" — the thirty
minute activity window, and nothing else.** A tab you opened six hours ago and
forgot has a `last_active_at` six hours old and is simply not in the set.

### 6.3 When does Chuck stop contributing to Summit?

Whichever of these happens first:

1. he closes the Summit tab (immediate);
2. he navigates that tab elsewhere (immediate);
3. thirty minutes pass without Summit being focused-and-visible;
4. Summit is evicted by the 3-destination cap;
5. his account goes stale at 90 seconds, or offline, or invisible.

All five are already-existing concepts, applied per destination.

### 6.4 Do we need to distinguish active from merely open in the UI?

**PRODUCT RECOMMENDATION: no, and this is a deliberate simplification.** Since
stale destinations never reach any other user, there is no "merely open" state
for anyone else to see. The distinction exists only inside the owner's own
browser, where it needs no label because the user knows which tab they are
looking at.

**One exception worth building:** on a friend's **UserCard**, where the panel
already shows richer detail, listing their active destinations ("watching
summit1g · also has gingy open") is genuinely informative and costs nothing.
That is the natural place for multiplicity, because a card is about one person.

### 6.5 What this does to the thesis

**Presence → Social Gravity → JOIN → Together is preserved, and Gravity gets
better.** Today a gathering is invisible whenever the friends who make it up
happen to have that stream in a background tab. Multi-destination presence means
Gravity sees gatherings it currently cannot — which is the middle step of the
thesis doing more work, not less.

**RISK: cluster inflation.** With three destinations each, clusters could
overlap enough to feel noisy. **Mitigations already in place:** the
`GRAVITY_THRESHOLD = 2` emphasis rule (`src/core/socialGravity.ts:47`), the
existing size-then-alphabetical ordering (`clusterMembers`, `groupPresence.ts:127-132`),
and the 3-destination cap. **This should be watched in the beta rather than
pre-solved.** It is listed as an open question in §19.

### 6.6 Implementation shape

`clusterMembers` (`src/core/groupPresence.ts:88-133`) takes a flat list of
`{userId, presence}` and buckets by `channelOf(presence)`. Under the new model
the caller expands each friend into one entry per active destination before
calling it. **`clusterMembers` itself does not change**, which preserves the
property its own comment insists on: HERE, group clusters, the user card, JOIN
eligibility and Gravity all answer from one interpretation.

The `here` cluster continues to key on the viewer's **primary** destination —
a client-local concept, so it follows focus instantly with no network round
trip. That is a strict improvement: HERE becomes *more* responsive, not less.

---

## 7. Stale-tab policy

### 7.1 The recommendation

**PRODUCT RECOMMENDATION:**

> **A stream stops counting thirty minutes after you last looked at it.**

Formally: a destination is ACTIVE while
`last_active_at > now() - interval '30 minutes'`, where `last_active_at` is
refreshed on open, on navigation, and while the tab is focused-and-visible (at
most once per 5 minutes).

### 7.2 Why thirty minutes, and what each candidate creates

| Threshold | Behaviour it creates | Verdict |
| --- | --- | --- |
| **5 min** | An ad break, a bathroom trip or a long look at another tab drops you out of a gathering. Friends see you flicker. Rooms churn. | **Too aggressive.** Reintroduces exactly the instability being fixed. |
| **15 min** | Better, but a genuine second stream that you check every twenty minutes keeps disappearing and reappearing. | Workable, no particular virtue. |
| **30 min** | A stream you glance at twice an hour stays yours. A tab you forgot about this morning does not. Matches how people actually use a second stream. | **Recommended.** |
| **60 min** | A forgotten lunchtime tab still advertises you at 2pm. | Too permissive — this is the failure the brief named. |
| **Until closed** | The naive "open = watching" model the brief rejects. | Rejected. |

### 7.3 The real reason it is thirty and not fifteen

**Thirty minutes is already two constants in this codebase:**

- `RETENTION_MS = 30 * 60_000` — how long room messages live
  (`src/core/roomMessages.ts:67`, mirrored by the sweep in
  `supabase/migrations/0021_room_messages.sql:209`);
- `OPPORTUNITY_WINDOW_MS = 30 * 60 * 1000` — how long one Gravity opportunity
  lasts (`src/core/socialGravity.ts:84`).

Aligning the activity window with these means **a destination and its
conversation expire together.** A room can never outlive its messages, and
messages can never outlive their room. The previous investigation's finding #10
was precisely a mismatch between a surface's lifetime and its data's lifetime;
choosing a third, different number here would invite the same class of bug back.

**This is the strongest argument available for the number, and it is why no
other threshold should be chosen without also moving the other two.**

### 7.4 Two clocks, and why both are needed

| Clock | Question | Value | Existing? |
| --- | --- | --- | --- |
| Liveness | Is this person at their computer? | **90 s** | Yes — `PRESENCE_STALE_MS`, and the SQL predicates |
| Activity | Does this open stream still count as theirs? | **30 min** | New, but equal to two existing constants |

They compose correctly: shutting the laptop takes everything offline within 90
seconds regardless of activity timestamps, because the liveness row goes stale.
Staleness is only ever a *narrowing* of an already-live account.

### 7.5 What staleness does NOT do

**ARCHITECTURAL REQUIREMENT.** A destination going stale removes it from
*other people's* view — Gravity, room membership, message delivery. It **must
not** close the owner's own room tab while retained messages exist. The user
keeps reading and scrolling their conversation; they simply stop being
advertised. Conflating "stop publishing me" with "close my chat" is how finding
#10 happened.

---

## 8. Room membership and recipient algorithm

### 8.1 Membership

`stream_room_members(p_channel)` keeps its signature, its shape, its 3-hop
bound, its 50-row cap, its cycle guard and its block-on-the-join. **Two
predicates change, in the same way:**

```
-- caller gate (currently: p.channel = v_channel)
the caller must have p_channel among their ACTIVE destinations

-- the `present` CTE (currently: p.channel = v_channel)
present := every user with p_channel ACTIVE, whose account is online and fresh
```

Everything after that is untouched: the recursive walk over `friendships`
starting at the caller, `join present`, `not blocked_pair(v_actor, friend_id)`
on the join, `hops < 3`, path-based cycle guard, `limit 50`.

### 8.2 The recipient algorithm, exactly

For `send_room_message(C, B)` executed by user `U`:

```
1.  Validate C matches ^[a-z0-9_]{3,25}$ and B is 1..280 chars.
2.  Consume the 'room_message' rate budget (20/min). Refuse if exhausted.
3.  GATE:   require  U.online AND U.last_seen_at fresh (90s)
                AND  C ∈ ACTIVE_DESTINATIONS(U)
       else raise 'kickback: you are not watching that' (42501)
4.  MEMBERS := stream_room_members(C)          -- seeded at U
       = { v : ∃ friendship path U→v of length 1..3
                 where every intermediate w has C ∈ ACTIVE_DESTINATIONS(w)
                   and every step admits only v with ¬blocked_pair(U, v) }
5.  RECIPIENTS := { r ∈ MEMBERS : ¬blocked_pair(U, r) }   -- pairwise, again
6.  INSERT one room_messages row (recipient_id=r, sender_id=U, channel=C, body=B)
       for each r ∈ RECIPIENTS ∪ {U}
7.  Sweep U's own inbox for C: drop rows older than 30 min, then rows beyond 200.
```

**Step 5 is a second lock on the same door and is deliberately redundant** — it
is pairwise against the sender and does not care how the recipient was found
(`supabase/migrations/0022_blocks.sql:538-552`). It stays.

`send_together_reaction` is identical with the reaction vocabulary and its own
60/min budget.

### 8.3 The brief's cross-room question, answered

> If Chuck has Summit and Peanut open, and belongs to a valid friend component
> on both, can messages from each room be independently routed without
> cross-room leakage?

**Yes. Proven by construction, and the proof is short.**

`C` appears in **step 3** (the gate), **step 4** (candidacy for every node in
the walk), and **step 6** (the stored row). Recipient selection is therefore a
function of the channel at every stage — it is never a label applied to an
already-computed set.

Concretely, with Chuck↔Julie and Chuck↔Mike, Chuck on {Summit, Peanut}, Julie
on {Summit}, Mike on {Peanut}:

- `stream_room_members('summit1g')` seeded at Chuck: `present` = users with
  Summit active = {Chuck, Julie}. Mike is not in `present`, so the walk cannot
  reach him. → **{Julie}**.
- `stream_room_members('theburntpeanut')` seeded at Chuck: `present` =
  {Chuck, Mike}. → **{Mike}**.

Chuck's Summit message writes rows for Julie and Chuck, `channel='summit1g'`.
Mike has no row and RLS gives him nothing to read. The client buffers by channel
(`liveMessages(messages, channel)`, `src/core/roomMessages.ts:166`) so Chuck's
own two conversations do not blend on screen either.

**Leakage would require a friendship edge that does not exist, or a row written
to a recipient who was never in the walk. Neither is reachable.**

### 8.4 Verdict on the message model

**ARCHITECTURAL REQUIREMENT: keep per-recipient materialisation. It gets
*better* under multi-destination.**

The property that makes it valuable — the authorization decision is frozen at
send time and no permissive read can widen it — is exactly what makes
simultaneous rooms safe. A read-time-filtered design would need a correct
`(viewer, channel, moment)` predicate evaluated on every read, across a user who
is now legitimately in several rooms. That is far more surface area for the same
job.

**One cost, accepted and stated:** storage is messages × recipients, and a user
in three rooms can receive from three components. The existing bounds (200 rows
per recipient **per channel**, 30 minutes, 50 members per room) already scope
per channel, so worst-case retention grows linearly with the destination cap —
**3× the current worst case, with the cap as the multiplier.** That is bounded,
predictable, and small.

---

## 9. Security and component-isolation analysis

**ARCHITECTURAL REQUIREMENT: component isolation is non-negotiable. This
section proves the proposal against all seven required scenarios.**

### 9.1 The load-bearing observation

**Component isolation has never been a function of single-channel presence.** It
is produced by:

1. the walk being **seeded at the caller** and stepping only along rows in
   `public.friendships`;
2. `not public.blocked_pair(v_actor, f.friend_id)` **on the join**, so a blocked
   person is not traversed *through*, merely excluded from the output;
3. a hard 3-hop bound and a path-based cycle guard;
4. a second **pairwise** block filter at delivery.

The channel predicate answers only "who is standing here". Making that predicate
set-valued cannot create a friendship edge, and edges are the only thing that
merges components.

### 9.2 The seven required proofs

**(1) Unrelated components on the same channel.** A↔B and C↔D, no path between
them, all four with Summit active.

`present` = {A,B,C,D}. Walk seeded at A steps only along A's friendship rows:
reaches B, then B's rows, which do not include C or D. → **{B}**. C's walk
symmetrically → **{D}**. `send_room_message` from A writes rows only for A and
B. **Isolation holds, unchanged, because the only thing multi-destination
changed was which users appear in `present` — and `present` was never the
isolating mechanism.**

**(2) Block between previously connected users.** A↔B↔C, A blocks B.

Blocking a direct friend also deletes the friendship (`0022_blocks.sql`), so the
A–B edge is gone twice: the row is deleted **and** `blocked_pair(A,B)` is true
on the join. A's walk cannot enter B, therefore cannot continue through B to C.
B's own component still legitimately contains both A and C — B blocked nobody —
but delivery is pairwise against the sender, so nothing crosses. **Unchanged by
this proposal**, because the block predicate lives on the friendship join, which
is untouched.

**(3) Friendship removal.** The edge disappears from `public.friendships`. The
next `stream_room_members` call does not traverse it. Rooms are computed on
demand with a 90-second client-side refresh (`streamRoom.ts` `DEFAULT_REFRESH_MS`),
so the effect is bounded by that interval. **Already-written `room_messages`
rows are not retracted** — that is existing, correct behaviour: they were
authorised when written, and they expire on the 30-minute sweep. **Unchanged.**

**(4) Sign-out.** `require_actor()` raises, every RPC refuses. Client-side,
`roomMessages.reset()` and `streamRoom.reset()` clear buffers. **New
requirement, minor:** sign-out must also delete the user's `presence_destinations`
rows, exactly as `goOffline()` currently blanks the presence row. This is
explicit handling, not automatic.

**(5) Account / session loss.** No valid JWT → `require_actor()` refuses. The
account goes stale at 90 seconds. Destinations linger as rows but **cannot be
seen**, because every reader requires the parent account to be online and fresh.
**ARCHITECTURAL REQUIREMENT: destination visibility must be gated on account
liveness, not only on `last_active_at`** — otherwise a crashed browser would
advertise stale destinations for thirty minutes. This is explicit handling and
is the single most important correctness detail in the schema.

**(6) Late arrival to a channel.** X opens Summit where A and B are already
talking. X's walk now finds them (if a friendship path exists) and the room
appears. **X receives no backfill**, because rows were materialised for the
recipients who existed at each send. Unchanged, and it is the property 0021 was
built for.

**(7) Reopening a recently closed stream.** Closing removed the destination;
reopening re-adds it with a fresh `last_active_at`. Room membership recomputes.
**Messages sent during the gap were never addressed to the user and do not
return** — unchanged, and correct. **What does return is their own retained
history for that channel**, because `room_messages` rows survive the destination
row's deletion and `history(channel)` fetches by channel. That is a genuine
improvement over today, where the surface would have been destroyed as well.

### 9.3 RLS posture for the new table

**ARCHITECTURAL REQUIREMENT.** `presence_destinations` must carry the **same**
read predicate as `public.presence` does today — self, friends
(`is_friend`), and group co-members (`shares_group_with`), both of which already
have block predicates inserted by 0022. All writes revoked from `anon` and
`authenticated`; the only writer is a SECURITY DEFINER RPC.

**RISK: a new table is a new place to get RLS wrong.** Mitigation: the existing
`tests/db/authorization.test.ts` harness runs real RLS as a real non-owner role
with a JWT claim, and `npm run test:authz` deliberately weakens migrations to
confirm the tests notice. Any destination work must extend both.

**RISK: `presence_destinations` becomes an oracle for "who is watching X".** The
`(channel, last_active_at)` index makes that query cheap, and cheap queries
invite exposure. Mitigation: **never grant a channel-seeded read.** The only
channel-seeded entry point stays `stream_room_members`, which refuses unless the
caller is themselves present — the "knowing a channel name grants nothing" rule
in `0022_blocks.sql:465-470`. This must be restated in the new migration's
comments or it will be eroded later.

---

## 10. Realtime impact

### 10.1 The decisive finding

**PROVEN CURRENT BEHAVIOUR.** `src/background/supabaseRealtime.ts:106-121`:

```ts
const channel = supabase.channel(`${PRESENCE_PREFIX}:${friendIds.length}:${friendIds[0]}`)
for (const friendId of friendIds) {
  channel.on('postgres_changes',
    { event: '*', schema: 'public', table: 'presence', filter: `user_id=eq.${friendId}` }, …)
}
```

**The filter is on `user_id`, not on `(user_id, channel)`.** Pointing the same
binding at `presence_destinations` yields **one binding per friend regardless of
how many destinations that friend publishes.**

**Multi-destination does NOT multiply bindings by open streams.** The brief's
stated red line — "do NOT approve an architecture that obviously multiplies
realtime bindings by friends × open streams" — is not crossed.

### 10.2 Row-event volume

This is where multi-destination *could* have hurt, and where the design earns
its keep.

| Write | Today | Naive multi-destination | **Recommended** |
| --- | --- | --- | --- |
| Heartbeat (45 s) | 1 row event / friend | 3 (touching each destination) | **1** — heartbeat stays on the parent `presence` row only |
| Focus change between tabs | **1** (channel rewrite) | 1–2 | **0** — focus is never published |
| Destination goes stale | 0 (concept absent) | 1 (a write to mark it) | **0** — staleness is a read-time rule, per §2.4 precedent |
| Open / close / navigate a tab | 1 | 1 | **1** |
| Activity refresh | n/a | every focus change | **≤ 1 per destination per 5 min** |

**Steady-state realtime volume goes DOWN.** Today, every tab switch is a
database write and a realtime event to every friend. Under the recommendation it
is nothing at all. The heavy user this whole investigation is about — three tabs,
constant switching — currently generates the most traffic and would generate
almost none.

**Two design choices carry that result and must not be dropped:** heartbeat on
the parent row only, and staleness computed rather than written.

### 10.3 Estimates

Bindings are per friend. Row events are per friend per interval.

| Scenario | Bindings | Steady-state events | Assessment |
| --- | --- | --- | --- |
| **10 friends / 3 streams** | 10 | ~10 per 45 s + open/close | Trivial. Identical to today. |
| **50 friends / 3 streams** | 50 | ~50 per 45 s | Fine. Identical to today. |
| **250 friends / 3 streams** | 250 | — | **Breaks — at exactly the same point as today.** Exceeds the documented per-client `postgres_changes` cap (100 at the time of writing; **re-confirm against current Supabase limits before acting**). Expected symptom: `CHANNEL_ERROR` → the `socialSync` retry ladder spins → presence silently stops updating. |
| **1 000 friends / 3 streams** | 1 000 | — | Broken, as today. |

### 10.4 The first actual scaling wall

**The per-client `postgres_changes` binding cap, between roughly 100 and 250
friends. It is unchanged by this proposal.** Multi-destination neither causes it
nor moves it.

**PRODUCT RECOMMENDATION: do not build scale infrastructure as part of this
work.** The cap is a pre-existing gap already recorded in the previous report and
in the roadmap. Solving it (chunked channels, or a per-user presence fan-out
table following the 0020/0021 precedent) is separate work with a separate
trigger.

### 10.5 The topic-identity defect, and why it now matters more

**PROVEN CURRENT BEHAVIOUR.** The presence topic is keyed by
`friendIds.length` plus `friendIds[0]`; the group topic by `groupIds.length`
(`:289`). Teardown is `void supabase.removeChannel(...)` — **not awaited** (`:83`,
`:139`, `:217`, `:275`, `:356`).

**RISK.** Under the new write pattern the presence subscription is the sole
carrier of destination changes. A silently dead presence channel today loses
channel updates; tomorrow it loses the entire room surface. **The
teardown/topic hardening recommended in the previous report is promoted from
"safe cleanup" to a prerequisite** — see §16 and §17.

---

## 11. UI model

### 11.1 The shape

```
┌──────────────────────────────────────────┐
│  Friends │ summit1g ② │ gingy │ Groups   │
└──────────────────────────────────────────┘
```

**PRODUCT RECOMMENDATION.** `Tab` in `src/ui/KickbackPanel.tsx:35` becomes
`'friends' | 'groups' | { room: channel }`. The existing `SessionTab` component
(`:48-72`) already renders a channel-named tab with an unread badge and the
correct Twitch casing via `useChannelName()` — **it is already the right
component; there simply needs to be more than one of it.**

### 11.2 The nine questions, answered

**How many room tabs?** At most 3, matching the destination cap, plus any
retained-but-closed room. In practice one or two.

**Ordering?** **By `opened_at`, ascending.** Stable for the life of the tab.
Explicitly *not* by recent activity — that would make tabs reorder underneath a
click, which is the single worst thing a tab strip can do. `opened_at` exists in
the schema for exactly this reason (§5.2).

**Unread?** The existing per-tab badge. `unreadCount` (`src/core/roomMessages.ts:180`)
already takes a channel and a read watermark, and `sessionTab.readAt(channel)`
(`src/background/sessionTab.ts`) is already keyed by channel. **No new
mechanism.**

**Does browser focus change the selected Kickback tab?** **No. This is the
central requirement.** Selection is user intent, stored in `sessionTab.select()`,
and nothing else may write it.

**Should it ever auto-switch?** **Never.** The existing comment at
`KickbackPanel.tsx:31-33` — "selecting it is never automatic. A tab appearing
must not move somebody's feet" — is already the rule and should be restated for
multi-room.

**When the corresponding Twitch tab closes?** The destination goes; the room tab
**stays** while retained messages exist, marked as no longer live (dimmed label,
disabled composer — the server would refuse the send anyway). It disappears when
the last retained message expires.

**Should a recently closed room stay visible while retained messages exist?**
**Yes.** This is the direct fix for the previous investigation's finding #10, and
it is why `sessionAvailable` must be replaced rather than patched.

**How does the user get back to the Twitch stream?** Make the room header's
channel name activate that stream. **It can be done without the `tabs`
permission:** the background worker already knows which `Port` belongs to which
channel (§2.1), so it posts a message to that port and the content script calls
`window.focus()`. If no port matches, fall back to `chrome.tabs.create` — which
needs no permission. **PRODUCT RECOMMENDATION: do not request `tabs` for this.**

**How does this coexist with Groups?** Untouched. Groups key on `group_id` and
never consult presence. Groups keeps its own tab; group chat, group unread and
group membership are entirely unaffected by everything in this report.

### 11.3 What makes the panel feel stable

Three properties, all of which follow from decisions made above rather than from
UI polish:

1. **Focus is never published**, so no friend's view changes when you switch
   tabs;
2. **Selection is never automatic**, so your own view does not change either;
3. **Rooms outlive their destinations** by exactly the retention window, so
   nothing vanishes mid-sentence.

### 11.4 Room tab overflow

**RISK: at 3 rooms plus Friends plus Groups, the tab strip is 5 items in a
narrow floating panel.** The panel is resizable and the existing `SessionTab`
truncates with a `title` tooltip. Mitigation if it proves cramped: collapse
inactive rooms behind a count. **OPEN QUESTION — should not be pre-solved; see
§19.**

---

## 12. Analytics impact

### 12.1 The question that must survive

> **Does seeing friends gathering somewhere cause users to JOIN?**

**It survives, and it gets a cleaner answer.** The funnel is
`gravity_cluster_impression` → `join_clicked` (carrying `opportunity_key`) →
`join_arrived` → `watching_together_started`. None of those events is
structurally tied to a user having one channel. `opportunityKey(channel, now)`
(`src/core/socialGravity.ts:109`) is derived from channel and clock only, so
cross-viewer agreement is unaffected.

### 12.2 Event-by-event

| Event | Impact | Change needed |
| --- | --- | --- |
| `extension_session_started` / `_ended` | Unaffected. Session is per worker, not per channel. | Add an `open_destination_count` property. |
| `friend_presence_impression` | Denominator meaning shifts slightly: one friend may be impressed on two destinations. | None structurally. **Document the shift** or a rate silently changes meaning. |
| `gathering_impression`, `gravity_cluster_impression` | Unaffected. Already per cluster, and clusters are per channel. | None. |
| `join_clicked` | `already_on_destination` becomes **more** precise — set membership rather than an inference from a single channel. | None; the property gets better. |
| `join_arrived` | Driven by `noteChannel(currentChannel())` (`analyticsHub.ts:545`). Arrival becomes "the attributed channel entered the destination set". | Moderate rewiring in `analyticsHub.noteChannel`. |
| **`watching_together_started` / `_ended`** | **This is the one that genuinely breaks.** | See below. |
| `automatic_room_entered` / `_opened` | Fire per room. Already channel-dimensioned. | None, but volume rises with multiple rooms. |
| `automatic_room_message_sent`, `_reaction`, `_combo` | Already channel-dimensioned. | None. |
| Retention / session duration | Unaffected — measured on sessions and attributed arrivals, not on channel exclusivity. | None. |

### 12.3 The shared-watch lifecycle — the one real break

**PROVEN CURRENT BEHAVIOUR.** `src/background/togetherWatch.ts:254-262`:

```ts
update({ channel, otherCount }): TogetherEvent[] {
  // Moving channels ends everything on the old one at once …
  if (state && state.channel !== channel) {
    events.push(...closeAll('left_channel', at))
  }
```

**It holds exactly one open interval and closes it on channel change.** Under
multi-destination this is wrong in both directions: switching tabs would end a
shared watch that is still happening, and a genuine second shared watch could
never open.

**Required change:** `togetherWatch` becomes a map keyed by channel, one
interval per destination. `closeAll('left_channel')` fires when a *destination*
leaves the set, not when focus moves. `end_reason` gains a value distinguishing
"the destination closed" from "the destination went stale".

This is contained — one module plus `src/core/socialViewing.ts` — but it is real
work and it is the single largest analytics item.

### 12.4 New properties and events

**Requires migration `0024`** (event-name and property registry). **Not
written**, per constraints.

- `open_destination_count` on session and JOIN events.
- `destination_count` on `automatic_room_entered`.
- `end_reason` extended on `watching_together_ended` (`destination_closed`,
  `destination_stale`).
- **The `client_error` and `realtime_status_changed` events recommended in the
  previous report should land in the same migration.** They are needed *more*
  under this architecture, not less.

**Privacy posture unchanged.** Counts and fixed-vocabulary strings only. No
message content, no identities, no URLs. The 64-character value cap and
server-side key whitelist continue to make anything else structurally
impossible.

---

## 13. Migration and rollout design

**No migration is written here.** This is the sequencing design only.

### 13.1 The shape that avoids a flag day

**PRODUCT RECOMMENDATION: an additive migration with a compatibility shim, so
old and new clients coexist. No coordinated release is required.**

**`0024` — additive only:**

1. Create `public.presence_destinations` with RLS mirroring `presence`, the
   `(channel, last_active_at)` index, and no client grants.
2. Backfill one row per user from any current `presence.channel`, with
   `opened_at = last_active_at = presence.updated_at`.
3. Add the write RPC (set-valued, cap-enforcing, visibility-redacting).
4. **Keep `report_presence(text, text)` working as a shim** that writes exactly
   one destination and continues to maintain `presence.channel`.
5. Widen the four predicates in `stream_room_members`, `send_room_message`,
   `send_together_reaction` to accept **either** an active destination row **or**
   the legacy `presence.channel`. This is what lets an old client keep
   participating in rooms.
6. Add a read RPC returning friends' destinations, or extend `list_friends`.
7. Register the new analytics event names and properties (§12.4).
8. Bump `analytics_schema_version()` to **24**.

**Then:** the extension release. New clients publish sets; old clients publish
singletons; both are visible to each other.

**Later, `0025`:** drop the legacy branch, drop `presence.channel` and
`presence.platform`, retire `presence_offline_has_no_activity`. Only after every
tester is confirmed on the new build.

### 13.2 Do old clients behave incorrectly?

**No.** An old client calls `report_presence`, the shim writes one destination,
and the widened predicates accept it. It sees friends through `list_friends`,
which continues to expose a single channel — a new client's **primary**. An old
client therefore sees a correct subset, never anything wrong.

**RISK: `list_friends` must keep returning one channel per friend during the
window**, or old clients break. Mitigation: derive it as the most-recently-active
destination and leave the RPC's shape alone.

### 13.3 Coordinated release required?

**No — and that is the main argument for this migration shape.** The tiny beta
would tolerate a flag day, but not needing one removes an entire class of
rollout failure at essentially no cost.

### 13.4 Rollback

- **Extension:** roll back to the previous version. It works against `0024`
  because of the shim. This is the real rollback path.
- **Database:** do **not** roll back `0024`. It is additive; leaving it in place
  is harmless and dropping it would strand any new client. `0025` is the
  irreversible step and must not run until the new build is confirmed.
- **RISK:** the "one hosted action" pattern from the store checkpoint applies —
  `0024` must be applied to hosted **before** the extension release, or new
  clients call an RPC that does not exist. Ordering is not optional.

---

## 14. Alternative comparison

Scored 1–5, higher is better.

| | **A.** Current single-channel | **B.** A + `hasFocus()` | **C.** A + 5-min room lease | **D.** Multi-destination | **E.** Hybrid: D for rooms, A for Gravity |
| --- | --- | --- | --- | --- | --- |
| **UX** | 1 — tabs vanish, holes in history | 2 — fixes two-window only | 3 — hides flicker, still one room | **5** — rooms persist, focus is free | 3 — inconsistent: two rooms, one gravity |
| **Conceptual complexity** | 5 — trivially simple | 4 | 3 — a lease is a new lifetime with no user meaning | **4** — one new set, one new clock | 2 — two presence meanings at once |
| **Technical complexity** | 5 — none | **5** — ~10 lines | 4 — client-only, ~40 lines | 3 — MEDIUM, one table, four predicates | 2 — all of D plus a reconciliation layer |
| **Security** | 5 | 5 | 4 — a lease outlives the presence check that authorised it | **5** — isolation provably unchanged (§9) | 4 |
| **Gravity quality** | 2 — background gatherings invisible | 2 — unchanged | 2 — unchanged | **5** — sees gatherings it currently cannot | 2 — no better than today |
| **Room continuity** | 1 | 1 | 3 — 5 minutes, then the same cliff | **5** — bounded by retention, which is the right bound | 5 |
| **Stale-tab behaviour** | 5 — cannot occur | 5 | 5 | **4** — solved by one rule, needs the rule | 4 |
| **Scaling** | 4 | 4 | 4 | **4** — same wall, same place (§10.3) | 3 |
| **Future flexibility** | 1 — blocks multi-platform and any "where are you really" question | 1 | 1 | **5** — destinations generalise to YouTube/Kick unchanged | 2 |
| **Total** | 29 | 29 | 29 | **40** | 27 |

### 14.1 Why B and C are rejected

**B — `document.hasFocus()`.** It is a genuine improvement to a genuine defect
(two visible windows resolve by recency rather than focus), and it is ~10 lines.
But it **makes focus a better input to a model whose problem is that focus is an
input at all.** It cannot fix vanishing rooms, hidden conversations, or holes in
history, because those follow from one-channel presence and not from picking the
wrong channel. **Rejected as a solution; noted as a possible micro-fix if
multi-destination were deferred, which it should not be.**

**C — the five-minute lease.** It introduces a third lifetime — alongside 90 s
liveness and 30 min retention — that corresponds to nothing a user could
describe. It papers over the flicker for five minutes and then produces the same
cliff, now at a confusing moment. It also weakens the security story: a lease
lets somebody act on a room after the presence check that authorised them has
lapsed. **Rejected on both counts.**

**E — the hybrid.** Superficially attractive: get room continuity, leave Gravity
alone. But it requires *all* of D's schema work and then adds a reconciliation
layer, and it leaves the product saying a person is in two rooms and one place.
**Strictly dominated by D. Rejected.**

### 14.2 Decision

**D. Multi-destination presence.** Not "it depends" — D wins on UX, Gravity
quality, room continuity and future flexibility, ties on security and scaling,
and loses only on technical complexity, where the gap is MEDIUM versus trivial.

---

## 15. Failure-mode analysis

| # | Scenario | Behaviour | Verdict |
| --- | --- | --- | --- |
| 1 | **10 Twitch tabs open** | The 3-destination cap publishes only the 3 most recently active. The other 7 are local-only. | **Naturally correct** — the cap exists for this. |
| 2 | **Duplicate tabs, same streamer** | PK is `(user_id, channel)`, so two tabs on summit1g are one row. Whichever tab is focused refreshes `last_active_at`. Closing one must not remove the destination while another remains. | **Requires explicit handling** — the worker must count ports per channel and remove only on the last one. Deterministically unit-testable. |
| 3 | **Two browser windows** | Both may report `document.hidden === false`. Under this model that no longer matters: both destinations are published, and FOCUSED is local. | **Naturally correct — and it dissolves the defect `hasFocus()` was proposed for.** |
| 4 | **Rapid tab open/close** | Each is a write. `consume_presence_budget()` (90/min) backstops. | **Requires explicit handling** — debounce destination-set writes as `presence.ts` debounces today (1 s), and coalesce a set change into one call. |
| 5 | **Rapid Twitch SPA navigation** | Same as 4; the existing 1 s debounce already collapses "clicking through five channels" into one write. | **Naturally correct** — the existing debounce transfers. |
| 6 | **Sleeping laptop** | Timers stop; no heartbeat. Account goes stale at 90 s and disappears everywhere, destinations included, because visibility is gated on account liveness (§9.2 case 5). | **Naturally correct.** |
| 7 | **Browser crash** | Identical to 6. Destination rows persist but are invisible. | **Naturally correct — and this is exactly why the liveness gate is an architectural requirement, not an optimisation.** |
| 8 | **Service-worker eviction** | Ports die, worker restarts, content scripts reconnect and re-report. The 90 s liveness window covers the gap; 30 min activity is far wider. | **Naturally correct, and strictly better than today**, where re-report races the debounce and blanks the surface (§2.6). |
| 9 | **Stale content-script port** | A port whose tab is gone but which has not disconnected. Its destination keeps a stale `last_active_at` and ages out in 30 minutes. | **Naturally correct** — 30 minutes is the backstop for exactly this. |
| 10 | **Network disconnect** | Writes fail; `presence.ts` deliberately leaves `reported` unchanged so the next change retries, with no write storm. Realtime reconnects and `onResync` re-reads. | **Naturally correct** — existing behaviour transfers. |
| 11 | **Sign-out** | Every RPC refuses. **Destination rows must be deleted**, as `goOffline()` blanks presence today. | **Requires explicit handling** (§9.2 case 4). |
| 12 | **Block / unfriend while rooms active** | Rooms recompute on the next `stream_room_members` call, bounded by the 90 s refresh. Existing rows are not retracted and expire on the sweep — existing, correct behaviour. | **Naturally correct.** |
| 13 | **Same-channel unrelated components** | Proven in §9.2 case 1. `present` is candidacy; friendship is membership. | **Naturally correct.** |
| 14 | **Zero friends** | `stream_room_members` returns empty, no room appears, destinations are published but seen by nobody. Gravity is empty. | **Naturally correct.** |
| 15 | **Hundreds of friends** | Room membership capped at 50 and 3 hops. Gravity clustering is client-side and unbounded. Realtime bindings are the wall (§10.3–10.4). | **Requires explicit handling — but as pre-existing work, not as part of this.** Unchanged by multi-destination. |

**Four scenarios need explicit handling: duplicate tabs (2), rapid open/close
(4), sign-out (11), and the pre-existing friend-scale wall (15).** All four are
deterministic and unit-testable without a browser.

---

## 16. Impact on existing Beta Patch recommendations

The previous report recommended six fixes plus telemetry and test
infrastructure. Assessed against this architecture:

| Item | Safe regardless? | Verdict |
| --- | --- | --- |
| **Group chat autoscroll** (`Conversation.tsx:119`) | **Yes** | **Ship in Patch 1.** Touches only the shared `MessageList`; groups never consult presence. Multi-room makes it *more* valuable — more conversations, same component. |
| **"You" consistency** (`Conversation.tsx` / `StreamSession.tsx:107`) | **Yes** | **Ship in Patch 1.** Purely a rendering concern. |
| **Deterministic username colours** (`avatarTint.ts`) | **Yes** | **Ship in Patch 1.** Pure function on `userId`. Multi-room makes it more valuable — more conversations to scan. |
| **Cross-tab panel state** (`storage` listener) | **Yes** | **Ship in Patch 1.** Independent of presence, and it pulls in the same direction: the panel should feel like one thing across tabs. |
| **Realtime teardown / topic hardening** (`supabaseRealtime.ts`) | **Yes — and PROMOTED** | **Ship in Patch 1, and treat it as a prerequisite.** Under the new architecture the presence subscription carries the entire room surface, so a silently dead channel goes from "stale channel names" to "no rooms at all". §10.5. |
| **Error / realtime telemetry** | **Yes — and SEQUENCED FIRST** | **Ship before the architecture change**, so the migration lands into a system that can report its own failures. Needs migration `0024`; can share it with the destination work or precede it. |
| **jsdom / effect test coverage** | **Yes** | **Ship in Patch 1.** Prerequisite for testing multi-room UI at all — room tab selection, unread, and ordering are all effect-bearing. |

### The one item to flag

**`sessionAvailable` accepting live messages** (`KickbackPanel.tsx:236`, fix #4
in the previous report) **is superseded by this architecture.** Under
multi-destination the room surface is driven by the destination set and the
retention window, and `sessionAvailable` disappears entirely.

**PRODUCT RECOMMENDATION: ship it anyway in Patch 1.** It is three lines, it
gives testers immediate relief from the proven finding #10, and Patch 1 lands
before the architecture work. **Flagged as knowingly throwaway** — it must not
be built out into anything larger, and nothing should be layered on top of it.

### Explicitly do NOT build

- **`document.hasFocus()` presence input** — superseded (§14.1). Failure mode 3
  dissolves under D without it.
- **The 5-minute room continuity lease** — rejected (§14.1). It would add a
  third lifetime that this architecture then has to remove.

---

## 17. Implementation sequence

Smallest safe steps. **Each step is independently shippable and independently
revertable.** Nothing below is authorised by this report.

### Phase 0 — Friends Beta Patch 1 (unchanged, ships first)

The six fixes from the previous report, including the throwaway
`sessionAvailable` patch. No presence work. Testers get relief immediately.

### Phase 1 — Prerequisites (still no schema change)

1. **Realtime teardown and topic hardening.** `await` removal before re-open;
   key topics by a content hash of the id set rather than by `.length`. Small,
   safe, and load-bearing for everything after it.
2. **jsdom test project.** Second vitest project so effects execute. Required to
   test any of the UI work that follows.
3. **Error and realtime-status telemetry.** Migration `0024a` (event registry
   only) plus client wiring. Ship and observe for at least one beta cycle before
   Phase 3, so the architecture change lands into an observable system.

### Phase 2 — Client-side destination tracking (no schema, no behaviour change)

4. **Generalise the tab registry.** `createActivityRegistry` grows from "pick
   one" to "maintain a set", keeping `effective()` as the derived primary so
   nothing downstream changes yet. Pure function; fully unit-testable; handles
   failure modes 2 and 4.
5. **Ship it.** Behaviour is identical. This de-risks the largest client change
   by separating it from the schema.

### Phase 3 — Schema and the widened predicates

6. **Migration `0024b`:** `presence_destinations`, RLS, index, backfill, the
   set-valued write RPC, the `report_presence` shim, the four widened
   predicates, the friend-destinations read. Applied to hosted **before** the
   release.
7. **Worker:** publish the destination set with the 5-minute refresh floor and
   the cap; delete destinations on sign-out.
8. **Ship.** Old clients still work via the shim.

### Phase 4 — Consume the set

9. **Gravity:** expand friends into one entry per active destination before
   `clusterMembers`. `clusterMembers` itself unchanged.
10. **Rooms:** per-destination room state in the worker; `roomMessages` keyed by
    channel rather than holding one current channel.
11. **UI:** multi-room tab strip, `opened_at` ordering, per-room unread,
    retained-but-closed rooms, the return-to-stream affordance via port
    messaging. Replaces `sessionAvailable` and removes the Phase 0 throwaway.
12. **Analytics:** `togetherWatch` becomes per destination; new properties.

### Phase 5 — Cleanup

13. **Migration `0025`:** drop `presence.channel`, `presence.platform` and the
    legacy predicate branch. Only after every tester is confirmed on the new
    build.

**Phases 1 and 2 change no behaviour and can ship alongside Patch 1 if
convenient. Phase 3 is the first irreversible step.**

---

## 18. Complexity estimate

### 18.1 By area

| Area | Work | Size |
| --- | --- | --- |
| **Schema** | One new table, RLS, two indexes, backfill, a compat shim, a later drop migration | **MEDIUM** |
| **RPC / functions** | New set-valued write RPC; `report_presence` shim; four widened predicates (`stream_room_members`, `send_room_message`, `send_together_reaction`, plus the read); friend-destinations read. **No signature changes to the message or reaction RPCs.** | **SMALL–MEDIUM** |
| **Background worker** | `activity.ts` set-valued; destination publishing with throttle and cap; per-destination room and message state; `togetherWatch` per destination | **MEDIUM** |
| **Content script** | Add `document.hasFocus()` to the report. Everything else already exists. | **SMALL** |
| **UI** | Multi-room tab strip, ordering, per-room unread, retained-closed rooms, return-to-stream | **MEDIUM** |
| **Analytics** | Registry migration; `togetherWatch` rework; new properties | **MEDIUM** |
| **Tests** | jsdom project; destination-set unit tests; PGlite tests for the widened predicates and all seven isolation proofs; failure modes 2, 4, 11 | **MEDIUM** |

### 18.2 Overall

**MEDIUM.**

Not SMALL: it touches schema, four SQL functions, the worker's core state, the
UI tab model and the analytics lifecycle.

Not LARGE: the security model does not change, the message and reaction models
do not change, `clusterMembers` does not change, `stream_room_members` keeps its
signature and its walk, and no scale infrastructure is involved. **The bulk of
the work is widening predicates and letting one-of-a-thing become several.**

### 18.3 Where should it go?

**PRODUCT RECOMMENDATION: a separate beta checkpoint immediately after Friends
Beta Patch 1. Not part of Patch 1. Not deferred.**

- **Not part of Patch 1** — Patch 1 is six small fixes that should reach testers
  in days. Attaching a MEDIUM architecture change would delay proven relief for
  proven bugs, which is exactly the "giant feature-building milestone" the
  previous brief warned against.
- **Not deferred** — this is not a feature. It is the cause of two of the ten
  beta findings, and every day it is deferred is a day of beta observation
  collected against a presence model we have decided is wrong. Observing the
  wrong model produces data we will have to discount.
- **Immediately after** — Phases 1 and 2 change no behaviour and can begin at
  once.

### 18.4 Against the roadmap's learning rule

`docs/ROADMAP.md` stops normal feature development once the cohort begins,
allowing P0 breakage, reliability bugs, safety issues and obvious UX blockers.

**This qualifies as an obvious UX blocker, not a feature.** It adds no new
capability; it makes an existing one behave the way testers already expect.
Recording it that way in the roadmap matters, so it does not later read as a
precedent for building features mid-beta.

---

## 19. Open questions

**OPEN QUESTION 1 — Is 3 the right destination cap?** It is defensible and
bounds everything, but it is a judgement, not a measurement. Once
`open_destination_count` telemetry exists (§12.4) the real distribution will
settle it. **Do not tune before then.**

**OPEN QUESTION 2 — Does multi-destination Gravity feel noisy?** §6.5. With
three destinations each, clusters may overlap enough to blur the map. The
existing `GRAVITY_THRESHOLD` emphasis and size-ordering may absorb it. **Watch in
the beta; do not pre-solve.**

**OPEN QUESTION 3 — Should a stale destination still show on a friend's
UserCard?** The card is about one person and has room for detail; "also has
gingy open (quiet for 40 min)" may be useful or may be clutter. **Recommend
excluding stale destinations everywhere for v1**, and revisiting only on
feedback.

**OPEN QUESTION 4 — Room tab overflow.** §11.4. Three rooms plus Friends plus
Groups is five tabs in a narrow panel. **Ship and observe.**

**OPEN QUESTION 5 — Does `list_friends` stay singular forever?** During the
compat window it must (§13.2). Afterwards it could return the full set or a new
RPC could. **Decide at `0025`, not before.**

**OPEN QUESTION 6 — The exact Supabase `postgres_changes` per-client cap.**
§10.3 assumes 100 from documentation at the time of writing. **This must be
re-confirmed against current Supabase limits before any scaling decision.** It
does not affect the recommendation, since the wall is unchanged either way.

**OPEN QUESTION 7 — Should closing the last Twitch tab still be a 5-second
grace?** The existing grace exists because JOIN tears one tab down and opens
another. Under multi-destination the destination set makes that transition
visible as "one removed, one added", so a shorter grace may be safe. **Leave at
5 s; revisit only if it misbehaves.**

---

## 20. Exact final recommendation

**Adopt the multi-destination presence model (alternative D), implemented as a
child table with a single activity timestamp and a thirty-minute window, run as
a dedicated beta checkpoint immediately after Friends Beta Patch 1.**

### The model in full

1. **Presence splits into liveness and destinations.** `public.presence` keeps
   `status` and `last_seen_at`, heartbeated at 45 s, stale at 90 s — unchanged.
   A new `public.presence_destinations` holds `(user_id, channel)` with
   `opened_at` and `last_active_at`.
2. **A destination is ACTIVE while `last_active_at` is within thirty minutes.**
   Staleness is computed by every reader, never written — the same pattern
   `PRESENCE_STALE_MS` already uses.
3. **Focus is never published.** OPEN, FOCUSED and PRIMARY are client-local.
   Switching Twitch tabs produces no write, no realtime event, and no change to
   what any friend sees.
4. **At most three destinations are published**, most-recently-active first,
   enforced server-side.
5. **Gravity includes every active destination and no stale one.** Binary, not
   weighted. No attention scoring.
6. **Rooms are per destination.** A user may be in several at once. The room
   surface persists while its retained messages do — thirty minutes — not while
   a peer happens to be present.
7. **The security model is untouched.** `stream_room_members` keeps its
   signature, its friendship walk, its block-on-the-join, its hop bound and its
   50-member cap. Only its presence predicate widens. §9 proves isolation against
   all seven required scenarios.
8. **The message model is untouched.** Per-recipient materialisation at send
   time, channel on every row, `recipient_id = auth.uid()` on read. It gets
   *better* under multi-destination, because frozen authorization is what makes
   simultaneous rooms safe.
9. **Realtime is not materially affected.** One binding per friend, as today.
   Steady-state event volume goes down. The first wall is the pre-existing
   per-client binding cap between 100 and 250 friends.
10. **Migration is additive with a shim**, so no coordinated release is needed
    and old clients keep working.

### The one sentence for users

> **Kickback shows the streams you have open, and stops showing one to your
> friends thirty minutes after you last looked at it.**

### What must NOT be built

- `document.hasFocus()` as a presence input — superseded.
- The five-minute room continuity lease — rejected.
- Any weighted attention score — explicitly avoided; one timestamp, one
  threshold.
- The `tabs` permission — not required, and §11.2 gives a way to return to a
  stream without it.
- Scale infrastructure for the realtime binding cap — pre-existing work with its
  own trigger.

### Sequencing decision

**Friends Beta Patch 1 ships first, unchanged.** Then Phases 1–2, which change
no behaviour. Then Phase 3, the first irreversible step. **Complexity: MEDIUM.**

### The reason to do this rather than patch around it

Two of the ten beta findings — vanishing rooms and hidden conversations — are
symptoms of one architectural assumption. Both intermediate fixes considered
would hide a symptom while leaving the assumption in place, and both would then
have to be removed. The multi-destination model removes the cause, is a smaller
change than it appears because the room layer was already channel-parameterised,
costs nothing in security, costs nothing in realtime, and leaves Presence →
Social Gravity → JOIN → Together not merely intact but better served.

---

## Appendix A — Constraints observed

| Constraint | Status |
| --- | --- |
| Do NOT implement anything | Observed. |
| Do NOT modify product code | Observed. This report is the only repository change. |
| Do NOT create migrations | Observed. `0024`/`0025` are described in prose only. |
| Do NOT modify hosted Supabase | Observed. No hosted connection was made. |
| Do NOT modify analytics schema | Observed. §12.4 describes; nothing written. |
| Do NOT publish anything | Observed. |
| Do NOT commit implementation changes | Observed. Nothing committed. |
| Do NOT begin Firefox work | Observed. Not touched. |
| Do NOT build secondary presence | Observed. §6 recommends against a secondary tier. |
| Do NOT implement the 5-minute lease | Observed, and rejected on the merits (§14.1). |
| Do NOT implement `document.hasFocus()` | Observed, and superseded (§14.1). |
| Do NOT implement any beta fixes | Observed. §16 assesses only. |
| Do NOT introduce Twitch-player DOM inspection | Observed. No signal in §3 reads Twitch's DOM. |
| Do NOT request `tabs` for audible state | Observed. §11.2 gives a permission-free alternative and explicitly recommends against it. |

## Appendix B — Source references

| Reference | Subject |
| --- | --- |
| `supabase/migrations/0001_schema.sql:109-122` | `presence` — one row, one channel, both constraints |
| `supabase/migrations/0004_auth_bootstrap.sql` | `sync_kickback_identity()` auto-provisions a presence row |
| `supabase/migrations/0006_presence_rate_limit.sql:66-126` | `report_presence` — visibility applied at write time |
| `supabase/migrations/0006_presence_rate_limit.sql:129-146` | `heartbeat()` |
| `supabase/migrations/0006_presence_rate_limit.sql` | `consume_presence_budget()` — 90 writes/minute |
| `supabase/migrations/0020_stream_rooms.sql:~250-300` | `send_together_reaction` — channel-parameterised fan-out |
| `supabase/migrations/0021_room_messages.sql:20-55` | The room design commitments |
| `supabase/migrations/0021_room_messages.sql:110-125` | `room_messages_select` — `recipient_id = auth.uid()` |
| `supabase/migrations/0021_room_messages.sql:137-224` | `send_room_message` — gate, fan-out, sweep |
| `supabase/migrations/0022_blocks.sql:422-532` | `stream_room_members` — the walk, the block on the join |
| `supabase/migrations/0022_blocks.sql:538-552` | Why delivery is filtered pairwise as well |
| `src/background/activity.ts:63-77` | The single-channel pick rule |
| `src/background/presence.ts` | Debounce 1 s, heartbeat 45 s, offline grace 5 s |
| `src/background/index.ts:765-774` | `sessionChannel()` — the write-lands gate |
| `src/background/index.ts:806-820` | `sessionPeers()` — excludes self |
| `src/background/index.ts:922-955` | `pushActivity()` |
| `src/background/index.ts:1426-1436`, `:1570-1576` | Port as tab key |
| `src/background/roomMessages.ts:174-190` | `setChannel` clears the buffer |
| `src/background/streamRoom.ts` | 90 s membership refresh |
| `src/background/supabaseRealtime.ts:106-121` | One binding per friend, filtered on `user_id` |
| `src/background/supabaseRealtime.ts:83,139,217,275,356` | Un-awaited `removeChannel` |
| `src/background/togetherWatch.ts:254-262` | One interval, closed on channel change |
| `src/background/analyticsHub.ts:224,236,509,545,609,619,633` | Shared-watch, JOIN and impression events |
| `src/core/presence.ts:9-14` | `PRESENCE_STALE_MS = 90_000`, read-time staleness |
| `src/core/groupPresence.ts:88-133` | `clusterMembers` |
| `src/core/socialGravity.ts:47,84,109` | `GRAVITY_THRESHOLD`, `OPPORTUNITY_WINDOW_MS`, `opportunityKey` |
| `src/core/roomMessages.ts:67-69,166,180` | `RETENTION_MS`, `MAX_MESSAGES`, `liveMessages`, `unreadCount` |
| `src/ui/KickbackPanel.tsx:31-35,48-72,236` | Tab type, `SessionTab`, `sessionAvailable` |
| `src/content/index.tsx:110-140` | What the content script reports |
| `src/platforms/twitch/navigation.ts:40-67` | SPA navigation detection |
| `tests/db/harness.ts` | Real-RLS PGlite harness used for the §9 proofs |
| `vitest.config.ts:13` | `environment: 'node'` — no effects in tests |

---

*End of report.*
