# M3 — Measurement + Twitch Intelligence: design and research

**Date:** 2026-08-30
**Repository state:** `1abad80` (polish pass), branch `main`, tree clean
**Type:** DESIGN / RESEARCH CHECKPOINT — no product code, schema, migrations, OAuth
scopes, or packaging were changed.
**Twitch documentation consulted:** 2026-08-30, against `dev.twitch.tv` and
`legal.twitch.com` rather than memory.

---

## 1. Executive verdict

**Recommendation: MODIFY.**

Watchside's existing analytics are considerably stronger than the M3 brief
assumes. Of the eleven questions M3 asks, **four are already answerable today**,
**four need only SQL** over data we are already collecting, and **one needs a
single new client event that requires no Twitch permission at all**. The gap is
narrower than expected and is concentrated in exactly one place.

That one place is real, and it is a STOP-condition finding rather than a task:

> **Creator discovery and follow conversion — questions 3, 4 and half of 11 —
> cannot be measured at all without requesting the Twitch scope
> `user:read:follows`, AND building provider-token custody that Watchside
> deliberately does not have today, AND accepting a Twitch Developer Services
> Agreement obligation to delete that data on de-authorisation.**

Those three are a package. The scope alone is insufficient, which is the finding
that most changes the shape of the decision: `docs/ANALYTICS.md` §11b currently
frames follow state as "cheap to add later — two contract rows, no DDL". The
contract half of that is still true. The *access* half is not, and §11b does not
mention it.

Five further findings materially change the plan:

- **`opportunity_key` is now emitted on both sides.** `docs/ANALYTICS.md` §11a
  says it is "reserved and unset until Social Gravity". That is **stale** —
  `analyticsHub.ts:525` and `:646` both set it. Exposure→JOIN conversion *per
  gathering* is therefore a query away, not a checkpoint away. This is the
  single highest-value, lowest-risk slice in M3.
- **There is no watch-time measurement of any kind.** Not partial — none.
  `grep` for `watch_time|watchTime|watched_ms|viewing_ms` across `src/` and
  `supabase/` returns nothing. The only viewing intervals recorded are
  *shared-watch* and *post-social linger*, which are by construction a subset of
  viewing. Every "incremental watch time" claim is therefore currently
  unsupportable, and will remain so even with a holdout until the denominator
  exists.
- **That denominator needs no Twitch permission.** Watchside already observes
  which Twitch tab is focused, on a 45-second heartbeat, in order to drive
  presence. Total channel dwell is measurable from our own tab observation.
  This decouples the most strategically valuable metric (incremental watch time)
  from the most expensive decision (the Twitch scope).
- **Install→auth cannot be measured.** `analytics_events.actor_id` is
  `auth.uid()`, server-side, always. No event can exist before sign-in, so the
  growth funnel structurally begins at first authenticated session. Install and
  install→auth drop-off are **F: cannot be reliably measured** — and no amount
  of instrumentation inside the current architecture changes that.
- **Moderator/VIP relationships are broadcaster-scoped and are permanently
  out of reach** for a viewer-side product. `moderation:read` and
  `channel:read:vips` are authorised by the *broadcaster*, not the viewer.

**Do not run an experiment yet.** The machinery (`src/core/experiment.ts`) is
correct and already refuses to randomise outside production. An order-of-magnitude
power calculation puts a defensible first holdout at roughly **1,000 users per
arm**; the private beta is orders of magnitude below that.

**Twitch OAuth conclusion: OWNER DECISION REQUIRED.** Not "no change" — because
two named M3 questions are unanswerable without it — and not "blocked", because
the path exists and is well-defined. It is a genuine product trade, laid out in
§7.

---

## 2. Current analytics architecture and inventory

### 2.1 Shape

Watchside's analytics is a **closed vocabulary with a server-side contract**. The
client cannot invent an event or a property; the server re-checks both. This is
unusual and it is the reason most of M3 is cheaper than expected — adding a
measurement is usually a row, not a migration.

| Layer | File | Role |
|---|---|---|
| Vocabulary + property contract | `src/core/analytics.ts` | Every event, every allowed property, the wire shape, Mozilla classification |
| Queue, batching, retry, kill switch | `src/background/analytics.ts` | Transport; the single Firefox suppression point |
| Composition — what an event *means* | `src/background/analyticsHub.ts` | Where every semantic decision lives |
| Session lifecycle | `src/background/analyticsSession.ts` | 30-minute idle, storage-backed, MV3-safe |
| JOIN attribution | `src/background/joinAttribution.ts` | 90s arrival window, 10min together window |
| Impression dedupe | `src/background/exposure.ts` | What "shown" means |
| Gravity clustering + opportunity keys | `src/core/socialGravity.ts` | 30s opportunity windows |
| Experiment arms | `src/core/experiment.ts` | FNV-1a of user id, production-only |
| Shared-watch / post-social detection | `src/background/togetherWatch.ts` | Two intervals, effective vs detected time |
| Worker-restart survival | `src/background/togetherStore.ts` | Conservative: undercounts, never invents |
| Table, contract, writer, reset | `supabase/migrations/0013_analytics.sql` | |
| Reporting views | `0014`, `0016` | |
| Growth loop | `0026_growth_loop.sql` | Suggestions, invites, referrals, badges |

### 2.2 The event table

`public.analytics_events` — no automatic retention purge exists; rows persist
until an explicit environment reset (`0013`, line 536).

| Column | Note |
|---|---|
| `actor_id` | **Always `auth.uid()`.** Never client-supplied. This is why pre-auth measurement is impossible. |
| `environment` | `development` / `private_beta` / `production` — never filtered away in the base view, deliberately |
| `event_name` | FK to `analytics_event_names` — the server-side contract |
| `session_id` | Nullable |
| `occurred_at` / `received_at` | Client clock (clamped ±1 day) and server clock, both kept, so skew is visible |
| `source` | The `AnalyticsSurface` vocabulary, promoted out of `properties` because every funnel groups by it |
| `destination_channel` | Twitch login, `^[a-z0-9_]{1,25}$`. The **only** thing recorded about where someone was |
| `attribution_id` | Ties click → arrival → shared watch deterministically |
| `properties` | `jsonb`, ≤12 keys, values ≤64 chars, unknown keys stripped both sides |

The 64-character/12-key cap is a structural privacy guarantee, not a convention:
a property cannot be a message, a URL, a token, or a search term.

### 2.3 The 48 events

Grouped as the code groups them.

- **Lifecycle** — `extension_session_started`, `extension_session_ended`
  (`duration_ms`, `end_reason`), `authenticated_session_started`
  (**`friend_count`**, `group_count`)
- **Social graph** — `friend_search`, `friend_request_sent`,
  `friend_request_accepted`, `friend_removed`, `group_invite_sent`,
  `group_invite_accepted`
- **Presence exposure** — `friend_presence_impression`, `gathering_impression`,
  `gravity_cluster_impression` (`friend_count`, `rank`, `visible_clusters`,
  **`opportunity_key`**, `destination_live`)
- **Together** — `automatic_room_entered` / `_opened` / `_left` / `_message_sent`
  / `_reaction` / `_combo`
- **JOIN** — `join_clicked` (`social_count`, `already_on_twitch`,
  `already_on_destination`, `navigated`, **`opportunity_key`**),
  `join_arrived` (`elapsed_ms`)
- **Shared watch** — `watching_together_started` (`other_count`, `from_join`),
  `watching_together_ended` (`other_count_peak`, `duration_ms`, `end_reason`,
  `detection_delay_ms`), `post_social_retention_ended` (`duration_ms`,
  `from_join`, `end_reason`)
- **Gatherings** — `gathering_notification_shown` / `_clicked`
- **Groups / chat / safety** — `group_created`, `group_opened`,
  `group_message_sent`, `user_blocked`, `user_unblocked`, `feedback_submitted`,
  `combo_formed`, `combo_broken`
- **Growth** — `friend_suggestion_impression` / `_add_clicked` /
  `_request_created`, `invite_link_created`, `invite_link_shared`,
  `invite_claimed` (`outcome`), `referral_succeeded`, `badge_awarded`,
  `badge_displayed`
- **Diagnostics** — `client_error`, `destinations_published`,
  `realtime_status_changed`, `group_message_send_failed`

### 2.4 Views

Six analytics views exist. **All are `revoke`d from `anon` and `authenticated`** —
nothing in the extension reads any of them.

| View | Grain | Carries |
|---|---|---|
| `analytics_reportable_events_v` | event | all events minus internal actors |
| `analytics_production_events_v` | event | the above, production only |
| `analytics_sessions_v` | session | duration, `had_join_click`, `had_join_arrival`, `had_watching_together`, `authenticated`, `joined_from_twitch` |
| `analytics_together_v` | shared watch | `duration`, `effective_ended_at`, `detected_at`, `detection_delay`, `other_count_peak`, `from_join`, `end_reason`, `post_social_duration`, `post_social_end_reason`, `post_social_retained` |
| `analytics_join_funnel_v` | JOIN click | click → arrival → together → post-social, on `attribution_id`; carries `source`, `social_count`, **`opportunity_key`**, `already_on_twitch`, `navigated` |
| `analytics_actor_days_v` | actor-day | `day_index` from first day — retention as a subtraction |

**There is no view over the growth loop, and no view that joins exposure to
JOIN.** Both are gaps of SQL, not of data.

### 2.5 Semantics worth not re-deriving

These are already correct and M3 should build on them rather than reopen them.

- **Sessions** — a stretch of being on Twitch with Watchside loaded; 30-minute
  idle; storage-backed so MV3 eviction does not shred one evening into forty.
  Duration is read from first/last event in SQL, with the explicit end as a
  cross-check.
- **JOIN attribution** — click mints an id; 90s arrival window; 10 minutes
  retained afterwards so a late shared watch is still credited. Expiry is
  silent, which is correct: arrival rate is arrivals ÷ clicks.
- **Shared watch requires a live stream.** Since 2026-08-24, presence alone does
  not open an interval — `socialViewing.ts` requires Twitch to say a stream is
  running. Uncertainty is not live. **Pre-2026-08-24 `together_duration` is an
  upper bound, not a measurement**, and must not be quoted.
- **Effective vs detected time.** Every end carries both. A late detection can no
  longer inflate a duration.
- **Conservative on eviction.** A gap over 5 minutes closes the interval as
  `observation_lost`. The system undercounts and never invents.
- **`post_social_retained` is a fact, not a judgement** — true even at two
  seconds. Thresholding is the query's job.
- **Opportunity keys** — `gravity:{channel}:{floor(now/30s)}`, computed by the
  same function on both the impression and the JOIN, so they cannot disagree.

---

## 3. Current funnel: what we can measure TODAY

Everything below is computable against the hosted schema right now, with no code
change.

```
                          [ NOT MEASURABLE — no pre-auth event ]
  install ─────────────────────────X
                                   │
  first authenticated session ─────┼──► authenticated_session_started
     (friend_count, group_count)   │      └─ graph size at session start
                                   ▼
  social exposure ──────────────► gravity_cluster_impression   ◄─ opportunity_key
     (friend_count, rank,          friend_presence_impression      destination_live
      visible_clusters)            gathering_impression
                                   │
                                   ▼
  JOIN click ───────────────────► join_clicked                 ◄─ opportunity_key
     (source, social_count,        │                              already_on_twitch
      navigated)                   │  mints attribution_id        already_on_destination
                                   ▼
  arrival ──────────────────────► join_arrived (elapsed_ms)
                                   │
                                   ▼
  shared watch ─────────────────► watching_together_started (other_count, from_join)
                                   watching_together_ended
                                     (duration_ms, other_count_peak,
                                      end_reason, detection_delay_ms)
                                   │
                                   ▼
  post-social linger ───────────► post_social_retention_ended
                                     (duration_ms, from_join, end_reason)
                                   │
                                   ▼
  [ TOTAL WATCH TIME ]  ────────X  NOT MEASURED AT ALL
  [ creator discovery ]  ───────X  needs user:read:follows
  [ follow conversion ]  ───────X  needs user:read:follows + token custody
                                   │
                                   ▼
  return sessions ──────────────► analytics_actor_days_v (day_index)
                                   ⚠ measures Twitch sessions WITH WATCHSIDE RUNNING
```

The two things to notice: the middle of the funnel is genuinely well
instrumented, and both ends are weak — the top because no anonymous event can
exist, the bottom because viewing time was never measured.

---

## 4. Gap matrix (A–F)

**A** already measurable correctly · **B** query/view work only · **C** new client
event or property · **D** backend/schema work · **E** new Twitch permission/API ·
**F** cannot be reliably measured

| # | M3 question | Class | Existing data reused | What is missing |
|---|---|---|---|---|
| 1 | **Social JOIN rate** (exposure → JOIN) | **B** | `gravity_cluster_impression` + `join_clicked`, both with `opportunity_key`; `source` on both | A view joining exposure to JOIN. **No new data.** |
| 1b | JOIN rate by source/surface | **A** | `analytics_join_funnel_v.source` | — |
| 2 | **JOIN arrival rate** | **A** | `analytics_join_funnel_v` (`clicked_at`, `arrived_at`, `arrival_elapsed_ms`) | — |
| 3 | **Non-followed creator discovery** | **E** + **D** | `join_clicked.destination_channel` | `user:read:follows`; provider-token custody; `following_at_join` property |
| 4 | **Social follow conversion** | **E** + **D** | `analytics_join_funnel_v`; `followed_at` from Helix | Same as 3, plus a `creator_followed` event and a defensible window |
| 5 | **Shared watch** (overlap, duration, friend count) | **A** | `analytics_together_v` — `duration`, `other_count_peak`, `from_join`, `end_reason` | — |
| 5b | "materially extends viewing" | **F** (today) | — | Causal claim: needs §7 watch-time + §12 holdout |
| 6 | **Post-social linger** | **A** | `post_social_duration`, `post_social_retained`, `post_social_end_reason` | — |
| 7 | **Observed** total watch time | **C** | tab focus + 45s heartbeat already in `presence.ts` | One new event (`channel_dwell_ended`). **No Twitch scope.** |
| 7b | **Attributed** watch time | **B** (after 7) | `attribution_id` + dwell | View work |
| 7c | **Causal / incremental** watch time | **F** until experiment | — | Randomised holdout (§12) **and** 7 |
| 8 | **Return Twitch sessions** | **B** | `analytics_actor_days_v`, `analytics_sessions_v` | A view; and honest naming — see caveat below |
| 9 | **Graph size / cold start** | **B** | `authenticated_session_started.friend_count` per session | A cohorting view. **No new data.** |
| 10 | Growth: invite created → shared → claimed → friendship → activation | **B** | `invite_link_created/_shared`, `invite_claimed.outcome`, `referral_succeeded`; server `referrals(attributed_at, succeeded_at)` | A funnel view spanning events + `referrals` |
| 10b | Growth: **install**, install→auth | **F** | — | Structurally impossible: `actor_id = auth.uid()` |
| 11a | Followed creator + follow timestamp | **E** | — | `user:read:follows` (viewer-side) — feasible |
| 11b | Subscription relationship | **E** | — | `user:read:subscriptions` (viewer-side); **no timestamp** returned |
| 11c | Moderator / VIP relationship | **F** | — | `moderation:read` / `channel:read:vips` are **broadcaster**-authorised |

**Caveat on question 8 that must survive into any deck.** `analytics_actor_days_v`
measures *Twitch sessions during which Watchside was installed, signed in and
running*. It does not measure the user's Twitch sessions. Someone who watches
Twitch on a phone, in a different browser profile, or after uninstalling is
invisible. Any "return session" figure is **return-to-Watchside**, and calling it
"return to Twitch" would be false.

---

## 5. Twitch API + OAuth scope research

Verified against `dev.twitch.tv` and `legal.twitch.com` on 2026-08-30.

### 5.1 Where Watchside stands today

| Fact | Evidence |
|---|---|
| **No Twitch scopes requested.** `signInWithOAuth({ provider: 'twitch', options: { redirectTo, skipBrowserRedirect: true } })` — no `scopes` key | `src/background/supabaseBackend.ts:120`; pinned by `tests/extension/oauthContract.test.ts`, verified on the wire in F3 |
| Channel metadata uses an **app access token** (client credentials), which by design has **no scopes and no refresh token** | `supabase/functions/twitch-metadata/twitch.ts` |
| Helix endpoints in use: `helix/users`, `helix/streams` — **public data only** | same file |
| The extension **never sees a provider token** | `docs/ANALYTICS.md` §11b |

### 5.2 The endpoints that would matter

| Endpoint | Scope | Token | Whose auth | Returns | Verdict |
|---|---|---|---|---|---|
| `GET /helix/channels/followed?user_id=&broadcaster_id=` | `user:read:follows` | user | **viewer** | `broadcaster_id/login/name`, **`followed_at`**, `total` | ✅ the primitive for Q3 + Q4 |
| `GET /helix/streams/followed` | `user:read:follows` | user | viewer | live streams among followed channels | ✅ same scope; product value, see §7.5 |
| `GET /helix/subscriptions/user?broadcaster_id=&user_id=` | `user:read:subscriptions` | user | viewer | tier / gift; **404 when not subscribed**; **no timestamp** | ⚠️ Q11b — weak |
| `GET /helix/channels/followers` | `moderator:read:followers` | user | **broadcaster/mod** | followers + `followed_at` | ❌ not viewer-authorisable |
| EventSub `channel.follow` v2 | `moderator:read:followers` | — | **broadcaster/mod** | follow notifications | ❌ not viewer-authorisable |
| `GET /helix/moderation/moderators` | `moderation:read` | user | **broadcaster** | mods | ❌ Q11c impossible |
| `GET /helix/channels/vips` | `channel:read:vips` | user | **broadcaster** | VIPs | ❌ Q11c impossible |
| ~~`GET /helix/users/follows`~~ | none (app token) | app | — | — | **Removed 2023-09-12.** No scopeless path exists. |

### 5.3 Four findings that shape the design

**(a) `followed_at` is returned — so this is not a polling problem.**
`Get Followed Channels` filtered by `broadcaster_id` answers "does this viewer
follow this creator, and since when" in one request. We therefore do **not** need
to poll frequently to catch a transition: two checks — one at JOIN, one at the end
of the attribution window — plus the timestamp reconstruct the whole interval
exactly. This is much cheaper and much more defensible than a polling design.

**(b) There is no follower-side EventSub. At all.**
Every follow-related subscription is authorised by the broadcaster. A viewer
cannot subscribe to notifications about their own follows. Follow conversion is
therefore **necessarily pull-based**, and the `followed_at` timestamp in (a) is
what makes that acceptable rather than crude.

**(c) Rate limits are per client ID *per user*.**
The guide states: *"For requests that specify a user access token, the limits are
applied per client ID per user per minute."* App-token and user-token requests use
separate buckets. This substantially de-risks the operational concern: two
follow checks per JOIN, per user, against that user's own bucket, is negligible
and does not compete with the existing app-token metadata budget. Headers
`Ratelimit-Limit` / `-Remaining` / `-Reset`; back off on 429.

**(d) Supabase does not persist provider tokens — this is the real blocker.**
`provider_token` and `provider_refresh_token` are returned **once**, at sign-in,
in the session; Supabase/GoTrue does not store them, does not refresh them, and
offers no endpoint to refresh them. They vanish from the session after roughly an
hour. To check follow state *days after* a JOIN — which is the entire point of
follow conversion — Watchside would have to **capture the provider refresh token
at sign-in and operate its own token vault**: encrypted at rest, refreshed against
`id.twitch.tv`, revocable, and never exposed to the extension.

That is a new class of secret in a product that currently holds none, and it is
the reason `docs/ANALYTICS.md` §11b's "cheap to add later" is only half right.
The *contract* is cheap. The *custody* is not.

### 5.4 Twitch Developer Services Agreement

Retrieved via search summary of the DSA; the canonical pages are JavaScript-rendered
and I could not extract verbatim clause text. **Exact wording should be confirmed
by the owner before implementation** — the substance below is consistent across
sources but the section numbering is not something I could verify directly.

| Obligation | Consequence for M3 |
|---|---|
| Developers must **delete all Twitch Data** on termination, on **revocation or reduction in scope of end-user authorization**, or on Twitch's or the user's request | A stored `following_at_join` becomes **deletable-on-demand data**. Watchside's analytics currently has no per-user deletion path other than a whole-environment reset. This is new machinery. |
| Must not store copies of Twitch Content/Program Materials unless authorised, rights-controlled, or **cached for only 24 hours** without sharing | A cached follow *list* is clearly caught. A derived boolean recorded as our own observation is arguably not — but "arguably" is the operative word, and this is a legal judgement, not an engineering one. |
| Must delete all of an end user's Twitch-derived data on request | Same as above. |
| Must not continue to associate a user ID with an end user who un-authenticates | Interacts with the deletion obligation. |

**This is a genuine STOP condition** under the brief's "measuring a proposed
metric would materially expand sensitive data collection". It is not a blocker in
the sense of being impossible; it is a decision that belongs to the owner and
plausibly to a lawyer.

### 5.5 Consent-screen impact

Adding `user:read:follows` changes the Twitch authorisation screen from
"Watchside would like to access your account" to a screen that **names the ability
to view the channels you follow**. For a social product whose entire trust
position is "we can't see what you watch", that is a material change in how the
first-run experience reads.

It also requires a privacy-policy update (`docs/PRIVACY.md`, published at
`anoteros-labs.github.io/watchside/privacy/`) — and the AMO listing's data
disclosure would need to be revisited, though **not** the Firefox manifest's
`data_collection_permissions` (see §13).

---

## 6. Detailed design — creator-discovery measurement (Q3)

**Question:** *What share of socially-driven JOINs put a viewer in front of a
creator they did not already follow?*

This is, in my read, the **single most strategically valuable metric in M3** —
it is the one that speaks directly to Twitch's own interest (discovery), it is
the one no other social layer can claim, and unlike follow conversion it needs
only a **single point-in-time check at the moment of the JOIN**, when the
provider token is most likely to be fresh.

### Mechanism

At `join_clicked`, before navigating:

```
GET https://api.twitch.tv/helix/channels/followed
      ?user_id={viewer}&broadcaster_id={destination}
  Authorization: Bearer {viewer provider token}
  Client-Id: {watchside client id}
```

Empty `data` ⇒ not following. Non-empty ⇒ following, and `followed_at` says since
when.

### Recording

One new property on an existing event — **no DDL**:

- `join_clicked.following_at_join: boolean | absent`

**Absent is a third state and must stay one.** Token expired, request failed,
rate-limited, or user revoked ⇒ the property is omitted, exactly as
`destination_live` is omitted on `gravity_cluster_impression` today. A literal
`"unknown"` would have to be excluded by hand in every query and eventually would
not be.

### Where it must run

**Not in the extension.** The check needs a provider token, and putting one in the
extension would mean a Twitch access token sitting in `chrome.storage`, readable
by anything with the extension's origin. It belongs in an Edge Function beside
`twitch-metadata`, which already owns Twitch credentials and already has an
SSRF-gated login validator to copy.

The synchronous-at-click constraint is real: the tab is about to be torn down.
The honest design is **fire-and-forget from the worker to the Edge Function,
which records the property server-side against the `attribution_id`** rather
than blocking navigation. That means `following_at_join` arrives as a *late
update* to an existing row, which is a schema behaviour `analytics_events` does
not currently have — see §19.

### The semantic trap, restated

`docs/ANALYTICS.md` §11b already states this and it must not be lost:

> **"Not following" does not mean "has never watched before."** A viewer may have
> watched a creator for years without following them.

The metric is *"introduced to a creator they had not followed"*, never *"first
exposure"*. Any deck that upgrades one to the other is making a false claim.

### Classification

**E + D.** Needs the scope, needs token custody, needs a late-update path.

---

## 7. Detailed design — follow-conversion measurement (Q4)

**Question:** *For a creator not followed before the JOIN, does the viewer
subsequently follow — and can we defend the attribution?*

### The window

I recommend **7 days**, with 24h and 30d computed alongside as sensitivity checks.

Rationale: 7 days is long enough for a returning viewer to come back to a creator
they liked and short enough that ordinary discovery through Twitch's own surfaces
does not dominate. It matches the window `docs/ANALYTICS.md` §11b already sketches.
Reporting three windows makes the sensitivity of the number visible rather than
hidden in a footnote.

### The mechanism `followed_at` makes possible

Because `Get Followed Channels` returns `followed_at`, we do **not** need to poll
daily. Two checks suffice:

1. **At JOIN** — `following_at_join` (§6).
2. **Once, at window close** (T+7d) — for JOINs where `following_at_join = false`,
   one request per (viewer, destination) pair.

If the second check returns a row, `followed_at` tells us precisely when the
follow happened, so we can assert it fell inside the window rather than assuming
it. If it returns empty, no follow occurred. **One deferred request per candidate
JOIN**, against that user's own rate-limit bucket.

### Recording

Second new contract row — again no DDL:

- `creator_followed` event, carrying `destination_channel`, plus
  `hours_since_join` (bucketed) and `from_join: boolean`

### The join back to the JOIN

`docs/ANALYTICS.md` §11b already has the query shape, and it is correct: the
browser drops an attribution within minutes, but a follow days later does not
need `attribution_id` — actor + destination + a time range is enough.

### What blocks it, and it is not the scope

Follow conversion is **strictly harder than creator discovery**, because it needs
a provider token **days after sign-in**. That is precisely what Supabase does not
give us (§5.3d). Creator discovery can *just* be done with a fresh session token;
follow conversion cannot.

So the honest sequencing is: **Q3 and Q4 are not one decision.** Q3 is
"scope + a check at click time". Q4 is "scope + a persistent token vault + a
scheduled job + a deletion path". If the owner wants to buy one and not the
other, Q3 is the one that carries most of the strategic value for a fraction of
the risk.

### What it still cannot say

Even fully built, this is **attribution, not causation**. A viewer who clicks
JOIN on a creator their three friends are watching is *already interested*. They
might well have followed anyway. Follow-after-JOIN is a **sequence**. Only the
holdout in §12 can make it a cause — and see §15.

### Classification

**E + D**, and a **STOP condition**.

---

## 8. Shared watch, watch time and linger (Q5, Q6, Q7)

### 8.1 Already correct — do not rebuild (Q5, Q6)

`analytics_together_v` answers, today:

- did the viewer overlap with friends — every row *is* an overlap
- for how long — `duration`, from the client's own measurement, to the
  *effective* end
- with how many — `other_count_at_start`, `other_count_peak`
- was it socially caused — `from_join`, `attribution_id`
- what ended it — `end_reason`, with `observation_lost` kept honest
- did they stay afterwards — `post_social_retained`, `post_social_duration`

**Class A.** The only defensible additions are query-side: threshold
`post_social_duration` rather than using the boolean, and exclude
pre-2026-08-24 rows from any duration figure.

### 8.2 The hole: total watch time (Q7)

There is no measurement of how long anyone watches anything. Shared-watch and
post-social intervals are a *socially-selected subset* of viewing, so:

- an "average watch time" from them is **biased upward by construction**
- there is no denominator against which "incremental" could ever be computed
- a holdout would have **nothing to compare**, because the control arm produces
  no shared watches at all

**This is the metric that blocks question 7 far more than the Twitch scope does.**

### 8.3 Design: `channel_dwell_ended` — no Twitch permission required

Watchside already knows, continuously, which Twitch tab is focused and on what
channel: the activity registry drives presence on a 45-second heartbeat
(`src/background/presence.ts:136`). Total dwell is derivable from data we already
hold in memory and deliberately do not record.

Proposed event:

```
channel_dwell_ended: {
  duration_ms: number
  from_join: boolean         // an attribution was live for this channel
  had_social: boolean        // any shared watch occurred during it
  end_reason: DwellEndReason // left_channel | session_ended | observation_lost
}
```

with `destination_channel` on the envelope, as everywhere else.

Design constraints, inherited rather than invented — reuse
`togetherWatch.ts`/`togetherStore.ts` wholesale:

- **stream must be live** — same `socialViewing.ts` rule, or dwell and
  shared-watch will disagree about what watching means
- **conservative on eviction** — gap >5min closes as `observation_lost`
- **one open interval in storage**, deleted on close
- **effective vs detected time** — same two-clock discipline

**What this unlocks:** total attributable watch time; shared-watch as a *fraction*
of viewing; a real denominator for a holdout; and post-social linger expressed as
a share of the session rather than an absolute.

**What it costs:** this is the most privacy-significant new event in M3. It
records *how long you watched a channel*, where today we record only *how long you
watched it with someone*. It is still bucketed to one channel per interval with no
title, category, or viewer count — but it should be described plainly in
`docs/PRIVACY.md` rather than folded in quietly. Mozilla category:
`browsingActivity`, already declared (§13).

**Class C.** No Twitch API, no scope, no schema change beyond one contract row.

### 8.4 Observed / attributed / causal, applied

| Statement | Class | Supportable when |
|---|---|---|
| "Viewers watched N minutes on channels they reached via a Watchside JOIN" | **attributed** | after §8.3 |
| "Shared watches average N minutes" | **observed** | today (post-2026-08-24 rows only) |
| "Viewers stayed a median of N minutes after their friends left" | **observed** | today |
| "Watchside generated N incremental hours" | **causal** | only after §8.3 **and** §12 |

---

## 9. Return-session measurement (Q8)

### Denominators and windows

Grain: `analytics_actor_days_v` (actor × day, with `day_index` from first day).

Proposed definition, stated so it cannot be inflated:

> **Social return rate (7d)** = of actors who had ≥1 `watching_together_started`
> or ≥1 `join_arrived` on day D, the share with ≥1 `extension_session_started`
> on any day in [D+1, D+7].

Comparison group: actors active on day D with **no** social interaction. This is
an association and must be labelled as one — the two groups differ in exactly the
way that matters (people with friends online are different people).

Windows: D+1, D+7, D+30. Report all three.

### The honesty constraint

Repeating §4 because this is the claim most likely to be overstated: this measures
**return to Watchside**, not return to Twitch. A user who watches Twitch without
Watchside is invisible; a user who uninstalls looks identical to one who stopped
watching Twitch. Any external statement must say "returning Watchside users",
and uninstall is not measurable.

**Class B.**

---

## 10. Graph-size / cold-start measurement (Q9)

`authenticated_session_started.friend_count` is emitted on every authenticated
session, so graph size is available **at the time of each session** — not merely
as a current snapshot. That is better than it sounds: it means the analysis is
naturally longitudinal and does not suffer the usual "bucket users by today's
friend count and mislabel their whole history" error.

### Buckets

`0` · `1` · `2` · `3–4` · `5–9` · `10+`

Chosen because Gravity's own threshold (`GRAVITY_THRESHOLD` in
`src/core/socialGravity.ts`) is where clusters begin to render at all — the
0/1/2 boundary is a product discontinuity, not an arbitrary cut.

### The activation curve

For each bucket, per user-week: share of sessions with a Gravity impression;
share with a JOIN; share with a shared watch; median shared-watch duration;
7-day return rate.

**The question this answers:** *at what graph size does Social Gravity start
producing value?* If the curve is flat below 3 and rises sharply after, that is
the strongest possible argument for prioritising the invite loop over every other
feature — and it is computable from data already in the table.

### The confound to state every time

Users with 10 friends are not users with 2 friends plus 8 friends. They are more
social, earlier-adopting, more invested people. **This curve describes; it does
not prove that adding friends causes engagement.** A referral-tree-randomised
experiment (§12) is the only thing that would.

**Class B.**

---

## 11. Growth / referral measurement (Q10)

### What exists

Client events: `invite_link_created`, `invite_link_shared` (`method`),
`invite_claimed` (`outcome`: `attributed`/`already`/`self`/`blocked`/`unknown`),
`referral_succeeded`, and the three `friend_suggestion_*` events.

Server: `invite_codes`; `referrals(inviter_id, invitee_id, attributed_at,
succeeded_at)`.

**`succeeded_at` is a genuinely good definition** and should be reused, not
re-litigated (`0026`, lines 487–520): a referral succeeds when the invitee is a
distinct authenticated account, attribution is valid, a friendship exists, **and**
the invitee has published a Twitch destination at least once — i.e. actually used
the product. It is stamped once and never cleared.

### The funnel, and where it breaks

| Stage | Source | Class |
|---|---|---|
| invite generated | `invite_link_created` / `invite_codes` | **A** |
| invite shared | `invite_link_shared.method` | **A** |
| **install** | — | **F** |
| **install → auth** | — | **F** |
| invite claimed | `invite_claimed.outcome`, `referrals.attributed_at` | **A** |
| friendship formed | `friendships` | **B** |
| active usage | destination published | **B** |
| successful social JOIN / shared watch | funnel + together views | **B** |
| retained | `analytics_actor_days_v` | **B** |

**The F rows are structural.** `actor_id` is `auth.uid()`, so no event exists
before sign-in. Closing that gap would require anonymous pre-auth telemetry — a
new actor model, a new privacy posture, and a new Mozilla disclosure. **I do not
recommend it**, and M3 should report invite→claim conversion (which we have)
rather than invite→install (which we cannot get).

Missing: a `growth_funnel_v` spanning events and `referrals`. **Class B.**

---

## 12. Causality — holdout experiment design (§12)

### What exists and is correct

`src/core/experiment.ts` is already right and should not be redesigned:

- assignment is **derived, not stored** — FNV-1a of user id, stable across
  devices, unaffected by clearing storage
- **salted per experiment**, so arms do not correlate across future tests
- **production-only randomisation**; dev and private beta are forced to `gravity`
- `isRandomisedArm()` exists specifically so analytics can refuse to describe a
  constant as an experiment result

The one thing missing: **the arm is not recorded on any event.** Without it the
machinery cannot produce an analysis. That is a one-property change
(`authenticated_session_started.experiment_arm`), and it should be gated on
`isRandomisedArm()` so a beta constant can never be filed as a result.

### Unit of randomisation — the hard problem

**Individual randomisation is contaminated**, and the contamination is not
incidental to Watchside, it *is* Watchside. If A is in holdout and B is in
treatment, B still sees the gathering, still JOINs, and A still ends up in a
shared watch with B. The control arm receives treatment through the graph.

Three options:

| Unit | Contamination | Feasible? |
|---|---|---|
| **User** | Severe — friends leak treatment across arms | Available now; biased toward the null |
| **Friend-graph connected component** | Low | Components **merge over time**; assignment is unstable, which is fatal |
| **Referral-tree root** | Low–moderate | **Recommended.** `referrals` already records inviter→invitee, and Watchside grows by invitation, so trees approximate social clusters and a root never changes |

**Recommendation: randomise on referral-tree root**, falling back to user-level
for organically-acquired users with no inviter (reported as a separate stratum,
not pooled).

### Design

- **Treatment:** Social Gravity as shipped.
- **Control:** flat friends list — the same information, without the clustered
  gravity surface. Not "no social features": a control that removes the product
  measures uninstallation, not Gravity.
- **Primary metric:** socially-initiated Twitch sessions per user-week
  (`join_arrived` count, or `channel_dwell_ended` minutes once §8.3 exists).
- **Guardrails:** total session duration; 7-day return rate; `client_error` rate;
  `feedback_submitted` volume; friend-request and invite rates. **Any guardrail
  regression stops the test**, regardless of the primary metric.
- **Analysis:** intention-to-treat, by assigned arm, never by whether Gravity was
  actually seen.

### Sample size — and why not to run it

Order of magnitude, two-proportion test, α=0.05, 80% power, detecting a **20%
relative lift** on a baseline weekly JOIN rate of ~30%:

> **≈ 1,000 users per arm** (≈2,000 total).

Detecting a 10% relative lift needs roughly **four times** that. Cluster
randomisation on referral trees inflates these further by the design effect —
realistically **1.5–2×** — so a defensible first experiment wants **3,000–4,000
users**.

**Do not run this during private beta.** With a handful of testers, a holdout is
statistically worthless *and* actively harmful: half a friend group cannot see the
feature they are there to test, which corrupts the qualitative signal too. This is
already encoded — `resolveArm` forces `gravity` outside production — and that
behaviour must not be "fixed".

**Instrument now, run later.** Recording the arm costs one property. Running the
experiment costs the beta.

---

## 13. Privacy and Firefox implications

### The Firefox boundary is not at risk

Watchside suppresses `technicalAndInteraction` on Gecko entirely (F6 owner
decision), enforced at one point in `background/analytics.ts` and made
unforgettable by the exhaustive `EVENT_DATA_CATEGORY` record — an unclassified
event is a **compile error**.

**Every metric proposed in this report classifies as `browsingActivity` or
`websiteActivity`, both already declared REQUIRED in the Firefox manifest.**
Nothing in M3 is designed around data Firefox suppresses.

| Proposed | Mozilla category | Manifest change? |
|---|---|---|
| `join_clicked.following_at_join` | `browsingActivity` | No — property on an existing event |
| `creator_followed` | `browsingActivity` | No — new event, already-declared category |
| `channel_dwell_ended` | `browsingActivity` | No |
| `authenticated_session_started.experiment_arm` | `authenticationInfo` | No |
| All view/query work | n/a | No |

**No change to `data_collection_permissions` is required by anything in M3.**
`scripts/manifest.mjs` line 90 stays as it is.

### What *does* change

| Change | Trigger |
|---|---|
| **`docs/PRIVACY.md`** — new Twitch scope, what we read, retention, deletion | Q3/Q4 only |
| **`docs/PRIVACY.md`** — channel dwell is a new kind of record | §8.3, independent of any scope |
| **AMO listing data disclosure** | Q3/Q4 |
| **Chrome Web Store privacy disclosures** | Q3/Q4 |
| **A per-user Twitch-data deletion path** | Q3/Q4 — DSA obligation (§5.4); does not exist today |
| Published privacy page redeploy | either |

### The trust cost, stated plainly

Watchside's privacy position is currently unusually strong and unusually simple:
*we record which channel, never what you watched or for how long, and we ask
Twitch for nothing about you.* Both Q3/Q4 and §8.3 weaken that sentence — the
first by asking Twitch for something about you, the second by recording how long.

Neither is disqualifying. Both should be decided deliberately rather than
absorbed as implementation detail, and §8.3 in particular deserves its own
decision because it is easy to wave through as "just a duration".

---

## 14. Proposed acquisition-quality dashboard

Six metrics. Each with the exact evidence that makes it truthful.

| # | Headline | Statement it supports | Evidence required | Status |
|---|---|---|---|---|
| 1 | **Socially-initiated Twitch sessions** | "Watchside initiated N Twitch channel arrivals from social context." | `join_arrived` count. We performed the navigation — the counterfactual is not in question. | ✅ **today** |
| 2 | **Gathering → JOIN conversion** | "X% of Gravity gatherings shown produced at least one JOIN." | `gravity_cluster_impression` ⋈ `join_clicked` on `opportunity_key` | ✅ **today, via one view** |
| 3 | **Shared-watch hours** | "Watchside-attributed shared watching totalled N hours." | `analytics_together_v.duration` where `from_join`, post-2026-08-24 only | ✅ **today** |
| 4 | **Post-social linger** | "After friends left, viewers stayed a median of N more minutes." | `post_social_duration`, thresholded | ✅ **today** |
| 5 | **Creator discovery rate** | "Y% of social JOINs took viewers to creators they did not follow." | `following_at_join` | 🚫 needs §6 |
| 6 | **Follow conversion** | "Z% of those discoveries were followed within 7 days." | `creator_followed` + `followed_at` | 🚫 needs §7 |

**Supporting cut, not headline:** the graph-size curve (§10) — *"users with ≥5
friends produce X× the social engagement of users with 1–2"* — stated as an
association, never as a promise that adding friends causes it.

**Reportable today with no new data: 1, 2, 3, 4.** That is a credible story on
its own: Watchside initiates real Twitch arrivals, converts gatherings into them
at a measurable rate, produces measurable shared viewing, and viewers stay after.
What it does *not* yet include is discovery, which is the part Twitch would care
about most.

---

## 15. Claims we must NOT make yet

**Causal claims — none of these are supportable, with or without M3's query work:**

- ❌ "Watchside caused +N% watch time." Needs §8.3 **and** §12.
- ❌ "Watchside caused the follow." Following after an attributed JOIN is a
  **sequence**. The viewer clicked because they were already interested.
- ❌ "Social Gravity increased JOINs by Y%." Needs the holdout.
- ❌ "Watchside drove N incremental Twitch sessions." *Incremental* is a causal
  word. "Socially-initiated" is the honest one.
- ❌ "Post-social retention proves Watchside creates lasting viewership."

**Claims that would be false for measurement reasons, not causal ones:**

- ❌ Anything about **install** or install→auth conversion — not measurable (§11).
- ❌ "Users returned to **Twitch** N% more" — we measure return to **Watchside** (§9).
- ❌ Any watch-time total before §8.3 exists — shared-watch minutes are a
  socially-selected subset and are biased upward.
- ❌ Any duration figure spanning **pre-2026-08-24** rows — upper bound, not
  measurement.
- ❌ "First time this viewer encountered this creator" — `following_at_join`
  observes follow state, never history.
- ❌ Any arm comparison from private-beta data — everyone is forced to `gravity`;
  `isRandomisedArm()` exists to prevent exactly this.

**Vanity metrics to keep off the dashboard:**

- Total events recorded, total impressions served — volume of our own logging.
- Registered users / installs — unqualified by activation.
- Total friendships — a graph can be large and inert; §10's activation curve is
  the honest version.
- Badges awarded — internal gamification, not Twitch value.
- Messages and reactions sent — engagement with *Watchside*, not with Twitch.
  Genuinely useful for product health; misleading in an acquisition deck.
- Raw JOIN clicks without arrival — always pair with arrival rate.

---

## 16. Recommended M3 implementation slices

Ordered by value ÷ risk. **Slices 1–4 need no Twitch decision and no new data
collection whatsoever.**

---

### Slice 1 — Exposure→JOIN conversion view · **HIGHEST VALUE, LOWEST RISK**

- **Question:** Does Social Gravity actually convert? Which surfaces work?
- **Existing data:** `gravity_cluster_impression` + `join_clicked`, both already
  carrying `opportunity_key`; `source` on both.
- **New data:** none.
- **Client:** none.
- **Backend:** one migration adding `analytics_gravity_conversion_v`; bump
  `analytics_schema_version()` from 16.
- **Twitch:** none.
- **Privacy:** none — no new collection.
- **Tests:** view-shape test; a test asserting `opportunity_key` is emitted on
  both sides (guards the regression that made §11a stale); `verify:analytics`.
- **Complexity:** Low.
- **Owner approval:** No.
- **Note:** also correct `docs/ANALYTICS.md` §11a line 902, which is now false.

---

### Slice 2 — Growth funnel view

- **Question:** Where does the invite loop leak?
- **Existing data:** invite/referral events + `referrals`, `invite_codes`.
- **New data:** none.
- **Client:** none.
- **Backend:** `analytics_growth_funnel_v`.
- **Twitch:** none. **Privacy:** none.
- **Tests:** view shape; a test asserting the funnel **omits install** so nobody
  later reads a missing stage as zero.
- **Complexity:** Low. **Owner approval:** No.

---

### Slice 3 — Graph-size activation curve

- **Question:** At what friend count does Gravity start working?
- **Existing data:** `authenticated_session_started.friend_count`.
- **New data:** none.
- **Backend:** `analytics_graph_cohort_v` with the 0/1/2/3–4/5–9/10+ buckets.
- **Twitch:** none. **Privacy:** none.
- **Tests:** bucket-boundary tests; a test that the view carries no causal naming.
- **Complexity:** Low. **Owner approval:** No.

---

### Slice 4 — Return-session view

- **Question:** Does social interaction associate with coming back?
- **Existing data:** `analytics_actor_days_v`, `analytics_sessions_v`.
- **New data:** none.
- **Backend:** `analytics_return_v`, D+1/D+7/D+30.
- **Twitch:** none. **Privacy:** none.
- **Tests:** window-boundary tests; naming test — the column must not be called
  `twitch_return`.
- **Complexity:** Low–Medium. **Owner approval:** No.

---

### Slice 5 — Experiment-arm instrumentation · *instrument now, run much later*

- **Question:** Makes any future causal claim possible at all.
- **Existing data:** `resolveArm`, `isRandomisedArm`.
- **New data:** `authenticated_session_started.experiment_arm`, emitted **only
  when `isRandomisedArm()`**.
- **Client:** small change in `analyticsHub.ts`.
- **Backend:** one contract row.
- **Twitch:** none. **Privacy:** negligible — an arm label, not user data.
- **Tests:** a test that the property is **absent** in `private_beta` and
  `development` (this is the load-bearing one); contract test.
- **Complexity:** Low.
- **Owner approval:** **Yes** — confirm we instrument without committing to run.

---

### Slice 6 — Channel dwell / watch time · *the strategic unlock*

- **Question:** How much Twitch viewing does Watchside actually touch? Creates
  the denominator without which "incremental" is meaningless.
- **Existing data:** activity registry, presence heartbeat, `socialViewing.ts`
  live rule, `togetherStore.ts` eviction discipline.
- **New data:** `channel_dwell_ended { duration_ms, from_join, had_social,
  end_reason }`.
- **Client:** a dwell tracker mirroring `togetherWatch.ts`; one stored open
  interval; same live-stream rule; same conservative eviction handling.
- **Backend:** one contract row; extend `analytics_join_funnel_v`.
- **Twitch:** **none.**
- **Privacy:** **Material.** New kind of record: how long you watched a channel.
  `browsingActivity` — no manifest change — but **`docs/PRIVACY.md` must be
  updated** and the privacy page redeployed.
- **Tests:** eviction/suspend cases; live-stream requirement; that dwell ≥
  shared-watch on the same channel; that no dwell is recorded when the stream is
  not live; mutation tests via `test:analytics`.
- **Complexity:** **Medium–High** — this is real MV3 lifecycle work with known
  traps, all of which `togetherWatch.ts` has already hit and solved.
- **Owner approval:** **Yes** — new privacy surface.

---

### Slice 7 — Creator discovery (`following_at_join`) · **OWNER DECISION**

- **Question:** Do social JOINs introduce viewers to creators they don't follow?
- **New data:** `join_clicked.following_at_join`.
- **Client:** report the JOIN to an Edge Function.
- **Backend:** new Edge Function; **provider-token capture at sign-in**;
  late-update path for an existing event row (§19); contract row.
- **Twitch:** **`user:read:follows`** — changes the consent screen.
- **Privacy:** **Significant** — new scope, new Twitch-derived per-user data,
  DSA deletion obligation, privacy policy + both store disclosures.
- **Tests:** absent-on-failure behaviour; token never reaches the extension;
  scope-contract test updated deliberately (it currently asserts *absence*);
  deletion path.
- **Complexity:** **High.**
- **Owner approval:** **YES — blocking.**

---

### Slice 8 — Follow conversion (`creator_followed`) · **OWNER DECISION**

- **Question:** Do those discoveries convert to follows?
- **New data:** `creator_followed { hours_since_join, from_join }`.
- **Backend:** **persistent provider-token vault** (encrypted, refreshed against
  `id.twitch.tv`, revocable); scheduled window-close job; deletion-on-revocation.
- **Twitch:** `user:read:follows` (same scope as Slice 7).
- **Privacy:** **Highest in M3** — long-lived provider refresh tokens.
- **Tests:** token custody; revocation deletes; window boundaries via
  `followed_at`; rate-limit backoff.
- **Complexity:** **High**, and strictly greater than Slice 7.
- **Owner approval:** **YES — blocking.** Should be decided *separately* from
  Slice 7.

---

## 17. Owner decisions required

| # | Decision | Blocks | My recommendation |
|---|---|---|---|
| **D1** | Request Twitch scope **`user:read:follows`**? | Slices 7, 8; M3 Q3, Q4, Q11a | **Defer.** Ship Slices 1–4 first — they cost nothing and may make the case for D1 far stronger with real numbers. |
| **D2** | If D1 is yes: build **provider-token custody**? | Slice 8 only | **Treat as a separate decision.** Slice 7 is viable without a persistent vault; Slice 8 is not. |
| **D3** | Accept the **DSA deletion obligation** and build a per-user Twitch-data deletion path? | Slices 7, 8 | Required if D1 is yes. Worth a legal read of the exact clause (§5.4). |
| **D4** | Record **channel dwell time**? | Slice 6; M3 Q7 | **Yes, and sooner than D1.** It is the real blocker on incremental watch time, needs no Twitch permission, and is a smaller trust cost than a new scope. |
| **D5** | Instrument the **experiment arm** now, without running? | Slice 5 | **Yes.** One property; makes future causality possible; costs nothing. |
| **D6** | Confirm we will **not** run a holdout until ≥3,000 production users | §12 | **Confirm.** Current code already enforces it. |
| **D7** | Accept that **install / install→auth is permanently unmeasurable**? | §11 | **Accept.** The alternative is anonymous pre-auth telemetry — a worse trade. |
| **D8** | Correct `docs/ANALYTICS.md` §11a (stale `opportunity_key` claim) | Slice 1 | **Yes**, as part of Slice 1. |

---

## 18. Release implications

**None of this changes the release position, and nothing here argues for a
release.**

- **Chrome:** v0.6.0 live; `main` is ahead by WS-F5-01, the Firefox telemetry
  boundary, the rebrand, and `1abad80`. M3 is a design checkpoint and adds
  nothing to that queue.
- **Firefox:** initial v0.6.0 AMO submission awaiting Mozilla. **Untouched.** No
  artifact rebuilt, no manifest modified, no `data_collection_permissions`
  changed.
- **Release policy honoured:** `main` may move continuously; Store releases happen
  at coherent product checkpoints; Chrome and Firefox should ship from the same
  tagged state once Firefox's initial release is established.

Forward-looking, and worth stating now rather than discovering later:

- **Slices 1–4 are server-only.** They ship as migrations without any extension
  release at all.
- **Slice 6 (dwell)** requires a privacy-policy update and a store release, and
  should not be bundled into an unrelated release.
- **Slice 7/8** would change the **OAuth consent screen**, which is user-visible
  and reviewer-visible on both stores. It should be its own coherent checkpoint,
  and **must not** be the change that ships alongside Firefox's first signed
  release.

---

## 19. Files, schema and components likely to change

Nothing below was modified in this checkpoint.

### Client
| File | Slice | Change |
|---|---|---|
| `src/core/analytics.ts` | 5, 6, 7, 8 | New events/properties in `AnalyticsEventMap`, `EVENT_PROPERTIES`, **and `EVENT_DATA_CATEGORY`** (exhaustive — omission is a compile error) |
| `src/background/analyticsHub.ts` | 5, 6, 7 | Arm property; dwell composition; JOIN follow-check dispatch |
| `src/background/channelDwell.ts` *(new)* | 6 | Dwell tracker, mirroring `togetherWatch.ts` |
| `src/background/togetherStore.ts` | 6 | Extend, or add a sibling, for the open dwell interval |
| `src/background/index.ts` | 6 | Wire dwell to the activity registry |
| `src/background/supabaseBackend.ts` | 7, 8 | Capture `provider_token` / `provider_refresh_token` at sign-in |

### Backend
| File | Slice | Change |
|---|---|---|
| `supabase/migrations/0029_m3_views.sql` *(new)* | 1–4 | Four views; bump `analytics_schema_version()` past 16 |
| `supabase/migrations/0030_m3_contract.sql` *(new)* | 5, 6 | `analytics_event_names` / property rows — **data, not DDL** |
| `supabase/migrations/00xx_twitch_follows.sql` *(new)* | 7, 8 | Provider-token vault; deletion path; contract rows |
| `supabase/functions/twitch-follows/` *(new)* | 7, 8 | Follow check; SSRF gate copied from `twitch-metadata` |
| `supabase/functions/twitch-metadata/` | — | **Unchanged** |

### Docs, tests, tooling
| File | Slice | Change |
|---|---|---|
| `docs/ANALYTICS.md` | 1, 5–8 | Fix stale §11a; rewrite §11b (custody, not just contract); document dwell |
| `docs/PRIVACY.md` | 6, 7, 8 | Dwell; scope; retention; deletion — then redeploy the published page |
| `tests/extension/analyticsContract.test.ts` | all | SQL ⋈ TS agreement |
| `tests/extension/oauthContract.test.ts` | 7, 8 | Currently asserts `scopes` is **absent**; changing it must be deliberate and reviewed |
| `tests/extension/firefoxTelemetryBoundary.test.ts` | 5–8 | New events must classify outside `technicalAndInteraction` |
| `scripts/verify-analytics.mjs` | 1–4 | New views must be revoked from clients |
| `scripts/manifest.mjs` | — | **No change** — categories already declared |

### Explicitly unchanged
`src/core/experiment.ts` (correct as written) · `src/background/joinAttribution.ts`
· `src/core/socialGravity.ts` · `src/core/socialViewing.ts` · all Gravity, Groups
and Rooms behaviour · OAuth scopes · Chrome and Firefox artifacts.

### One schema behaviour that does not exist yet

Slice 7 needs `following_at_join` attached to a `join_clicked` row **after** it was
written, because the tab is torn down at click time. `analytics_events` has no
update path — the writer is insert-only, and `properties` is not mutated after
insert. Options: a narrow `SECURITY DEFINER` function keyed on `attribution_id`;
or a separate `join_follow_state` event joined in the view. **The second is more
in keeping with the existing design** (events are immutable facts; views do the
joining) and avoids introducing mutation into an append-only table.

---

## 20. Final recommendation

## **MODIFY**

**Proceed with Slices 1–5. Decide D4 (dwell) next. Defer D1/D2/D3 (the Twitch
scope) until Slices 1–4 have produced real numbers.**

The reasoning:

1. **The cheap wins are real wins.** Four of M3's questions are answerable with
   SQL over data already collected, and one of them — gathering→JOIN conversion —
   is the closest thing Watchside has to a proof that Social Gravity works. It has
   been available since `opportunity_key` was wired and nobody noticed, because
   the documentation still says it isn't.

2. **The scope is not the main blocker on the most valuable metric.** Incremental
   watch time is the claim with the most strategic weight, and it is blocked by
   the absence of *any* watch-time measurement — which needs no Twitch permission
   at all. Buying `user:read:follows` first would be paying the largest trust cost
   for the second-most-valuable metric.

3. **Follow conversion is more expensive than the documentation implies.** §11b's
   "two contract rows, no DDL" is true of the contract and false of the access
   path: Supabase does not persist provider tokens, so Slice 8 means building
   token custody, a refresh loop, and a deletion path under a DSA obligation.
   That is a checkpoint, not a slice, and it should be entered deliberately.

4. **Nothing here should be rushed toward a release.** The scope change is
   consent-screen-visible on both stores, and Firefox's first signed artifact is
   still pending. Slices 1–4 ship as migrations with no extension release at all,
   which is exactly the right way to start a measurement milestone.

**STOP conditions triggered, reported rather than worked around:**

- ✅ A strategically important metric (creator discovery, follow conversion)
  requires a Twitch permission we do not request → **§5, §17 D1**
- ✅ Follow conversion is unreliable as currently architected — no follower-side
  EventSub, and no persisted provider token → **§5.3b, §5.3d**
- ✅ Measuring it would materially expand sensitive data collection → **§5.4, §13**
- ✅ Existing semantics insufficient in one place: no watch-time denominator →
  **§8.2**
- ✅ Backend/hosted changes required for every slice → **§19**
- ✅ Documentation defect found: `docs/ANALYTICS.md` §11a is stale → **§16 Slice 1**

**Twitch OAuth conclusion: OWNER DECISION REQUIRED.**
