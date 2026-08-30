# M3B — Twitch Economic Attribution: research and design

**Date:** 2026-08-30
**Repository state:** `8f4e6ca`, branch `main`, tree clean at start and end
**Type:** DESIGN / RESEARCH CHECKPOINT — nothing implemented. No product code,
schema, migrations, OAuth, manifests, privacy policy, Store artifacts or package
versions were touched.
**Predecessor:** `docs/reports/m3-twitch-intelligence-design-2026-08-30.md`
**Twitch and Mozilla documentation consulted:** 2026-08-30, against
`dev.twitch.tv`, `legal.twitch.com` and `extensionworkshop.com`. Nothing below
is from memory.

---

## 1. Executive verdict

**Recommendation: MODIFY.**

The research produced one finding that reshapes the strategy, and one that
reverses the owner's stated priority.

### The strategic ceiling is lower than the thesis assumes

The desired attribution chain ends `… → subscription → gifted subscription →
Bits/Cheers → repeat viewing`. **Watchside can never observe the last three.**

Every Twitch economic primitive except one is **broadcaster-authorized**, and the
one exception carries no timestamp. Specifically, after enumerating the complete
set of `user:*` OAuth scopes — the entire surface a *viewer* can authorize —
there is:

- **no viewer-side Bits endpoint of any kind.** The Bits section of the Helix
  reference contains exactly four endpoints (Bits Leaderboard, Cheermotes, Custom
  Power-up, Extension Transactions) and none of them expose a viewer's own
  spending. `channel.cheer` and `channel.bits.use` EventSub both require
  `bits:read`, which is a **broadcaster** scope over their own channel.
- **no way for a viewer to authorize us to see subscriptions they gift.** All
  four `channel.subscription.*` EventSub types require `channel:read:subscriptions`,
  granted by the broadcaster.
- **no EventSub subscription type of any kind that reports a specific viewer's
  own spending, subscribing or cheering across channels.**

So **Level 5 of the business-value ladder is not reachable as written.** Watchside
cannot demonstrate Twitch *revenue* attribution. It can credibly reach Level 4
(discovery → follow), and a strictly weakened Level 5 (*"subscription state
changed after a socially-driven JOIN"* — no amount, no timestamp, no revenue
figure). This should be corrected in any strategic narrative now rather than
discovered in a partner conversation.

### The irreversible-data-loss priority is inverted

The brief singles out `following_at_join` as the datum whose delay is most
damaging. The research says the opposite:

| Datum | Class | Why |
|---|---|---|
| `following_at_join` | **H1** — partially reconstructable | `Get Followed Channels` returns **`followed_at`**. For any past JOIN we can later ask "does this viewer follow this creator, and since when" and infer the state at that time — **valid only if the relationship was never unfollowed and refollowed.** |
| `subscribed_at_join` | **H2 — NOT reconstructable** | `Check User Subscription` returns `broadcaster_*`, `user_*`, `is_gift`, `tier` and **no timestamp whatsoever**, and 404 when not subscribed. There is no historical query. If we do not record it at the JOIN, the fact is gone permanently. |

So the genuinely irrecoverable economic baseline is the **subscription** one — and
it is also the most expensive: a second OAuth scope, mandatory polling (no
timestamp means no reconstruction), and a probable **new required Firefox data
category** (§17).

### The measurement that is both irrecoverable and free

`channel_dwell_ended` (M3's Slice 6) needs **no Twitch permission at all** — it
is derived from Watchside's own tab observation — and past viewing is equally
unreconstructable. Every day of growth without it is permanently lost viewing
history, at zero Twitch cost and modest privacy cost.

**This, not the follow scope, is the measurement that should begin before
meaningful beta growth.**

### Architecture

The current chain (`opportunity_key → join_clicked → attribution_id →
join_arrived → watching_together → post-social`) is **sufficient for
Watchside-owned attribution and insufficient for Twitch-derived attribution** —
not because of the join logic, which is sound, but because the Twitch DSA
requires Twitch-derived data to be deletable on de-authorization, and
`analytics_events` is deliberately append-only. Mixing the two makes one
obligation impossible to honour without destroying the other.

**Recommended: the hybrid (§14)** — events stay immutable and purely
Watchside-owned; Twitch-derived relationship observations live in a separate,
separately-deletable table; a view joins them.

### Verdict

**MODIFY.** Proceed with M3A (server-only, no new collection). Prioritise **M3C
(viewing intelligence)** as the pre-growth measurement. Treat M3D (follow) as a
deliberate but *not* urgent scope decision, since `followed_at` buys real
lookback. Treat M3E (economic) as **research-complete and probably not worth
building** at its true cost — and be explicit that Bits and gifting are
permanently out of reach.

---

## 2. Business-model framing

Watchside has no direct monetization and is deliberately free: adoption and
social-graph density are worth more than revenue. The strategic bet is that
Watchside can prove it *causes or contributes to* economically valuable behavior
on Twitch. Analytics is therefore **core business infrastructure**, not telemetry.

Three consequences follow, and they are in tension:

1. **Evidence has a shelf life that runs backwards.** Some facts can only be
   recorded as they happen. That argues for collecting early.
2. **Trust is the product's moat.** Watchside's current position — *we record
   which channel, never what you watched or for how long, and we ask Twitch for
   nothing about you* — is unusually strong, and it is what makes a social
   presence layer acceptable at all. Every economic datum weakens it. That argues
   for collecting late, or never.
3. **A measurement nobody will ever have enough data to use is pure cost.**
   Subscription conversion is a low-single-digit-percentage event. At 10,000
   users, socially-driven sub conversions would be a handful — enough to be
   anecdote, not evidence.

The resolution this report argues for: **collect aggressively where the cost is
Watchside-owned observation (dwell, repeat viewing), and conservatively where the
cost is a Twitch scope** — because that is exactly where the strategic ceiling
turns out to be lowest anyway.

---

## 3. Current Watchside attribution capability

Established in M3 and re-verified. Nothing here changed.

| Capability | State |
|---|---|
| Opportunity identity | `opportunity_key` = `gravity:{channel}:{floor(now/30s)}`, emitted on **both** `gravity_cluster_impression` and `join_clicked` |
| Click → arrival | `attribution_id` minted at click; **90s** arrival window |
| Arrival → shared watch | attribution retained **10 minutes** after arrival |
| Shared watch | `analytics_together_v` — duration, `other_count_peak`, `from_join`, `end_reason`, effective-vs-detected time |
| Post-social | `post_social_duration`, `post_social_retained`, `post_social_end_reason` |
| Graph size | `authenticated_session_started.friend_count`, per session |
| Return | `analytics_actor_days_v` — **return to Watchside**, not to Twitch |
| Experiment arms | `resolveArm()` — derived, salted, production-only; **arm not yet recorded on any event** |
| Total watch time | **none** |
| Creator relationship | **none** |
| Pre-auth / install | **impossible** — `actor_id` is always `auth.uid()` |

### The three properties that matter for economic attribution

- **Append-only.** `analytics_events` has no update path; `properties` is never
  mutated after insert. This is a correctness feature and it is the reason
  Twitch-derived state cannot simply be added to `join_clicked`.
- **Short attribution lifetime.** The `attribution_id` is dropped within ~10
  minutes. Economic outcomes happen over days. M3 already established that this
  is fine — a later event joins on actor + creator + time range, not on the id.
- **No per-user deletion path.** The only deletion primitive is a whole-environment
  reset (`0013`, line 536). The DSA requires per-user deletion of Twitch-derived
  data (§16). **This machinery does not exist.**

### The identifiers we would need, and already have

| Needed for Helix | Available? |
|---|---|
| Viewer's Twitch numeric ID | ✅ `provider_id` / `sub` in `auth.users.raw_user_meta_data`, already read at bootstrap (`0028`, line 73). Server-side only. Not stored in `public.users` — and need not be. |
| Broadcaster's numeric ID | ✅ derivable app-side. `twitch-metadata` already calls `helix/users`, which returns `id`, using an **app token with no scopes**. |

Neither requires a new Twitch permission. The gap is authorization to ask about
the *relationship*, not the ability to name the parties.

---

## 4. Twitch authorization and token model

### 4.1 Where Watchside stands

| Fact | Evidence |
|---|---|
| **No Twitch scopes requested.** No `scopes` key in `signInWithOAuth` | `src/background/supabaseBackend.ts:120`; pinned by `tests/extension/oauthContract.test.ts` asserting *absence*; verified on the wire in F3 |
| Channel metadata uses an **app access token** — no scopes, no refresh token by design | `supabase/functions/twitch-metadata/twitch.ts` |
| The extension **never sees a provider token** | `docs/ANALYTICS.md` §11b |

### 4.2 The complete viewer-authorizable surface

This is the central research artifact of M3B: **every `user:*` scope Twitch
offers.** If a fact is not reachable through one of these, a viewer cannot
authorize Watchside to see it, full stop.

| Scope | Unlocks | Useful to Watchside? |
|---|---|---|
| `user:read:follows` | Get Followed Channels (**`followed_at`**), Get Followed Streams | ✅ **the one genuinely valuable scope** |
| `user:read:subscriptions` | Check User Subscription | ⚠️ weak — no timestamp |
| `user:read:moderated_channels` | Get Moderated Channels | ⚠️ marginal — no timestamp |
| `user:read:emotes` | Get User Emotes | ❌ rejected proxy (§10) |
| `user:read:chat` | chat EventSub types | ❌ rejected — delivers everyone's messages (§10) |
| `user:read:email` | Get Users (email) | ❌ not needed |
| `user:read:blocked_users`, `user:manage:blocked_users` | block list | ❌ |
| `user:read:whispers`, `user:manage:whispers` | whispers | ❌ |
| `user:read:broadcast`, `user:edit:broadcast` | the user's own *broadcasting* config | ❌ |
| `user:bot`, `user:write:chat` | send chat as the user | ❌ |
| `user:edit`, `user:manage:chat_color` | profile edits | ❌ |

**There is no `user:*` scope for Bits, cheering, gifting, channel points, hype
trains, or any purchase.** That absence is the finding.

### 4.3 Provider-token custody — the standing blocker

Re-confirmed from M3: Supabase/GoTrue returns `provider_token` and
`provider_refresh_token` **once, at sign-in**, does not persist them, does not
refresh them, and offers no refresh endpoint; they disappear from the session
after roughly an hour.

The consequence differs sharply by measurement, and this is what makes the
sequencing in §21 possible:

| Timing | Custody needed? |
|---|---|
| A check **at sign-in** | ❌ no — token is in hand |
| A check **at JOIN**, same session | ⚠️ usually not, if captured at sign-in and held for session lifetime |
| A check **days later** (follow window close, sub polling) | ✅ **yes** — a persistent, encrypted, refreshable token vault |

**M3D can be built without a persistent vault. M3E cannot.**

### 4.4 Rate limits

Per the API guide: *"For requests that specify a user access token, the limits are
applied per client ID per user per minute."* App-token and user-token requests use
separate buckets; headers `Ratelimit-Limit` / `-Remaining` / `-Reset`; back off on
429.

This is favourable. Per-viewer checks scale linearly with users and never compete
with the existing app-token metadata budget. Two follow checks per JOIN is
negligible. **Subscription polling is the exception** — with no timestamp, the
measurement resolution *is* the polling frequency, so cost scales with
(candidate JOINs × polls), not with JOINs.

### 4.5 One documented ambiguity — flagged, not designed around

`Check User Subscription`'s reference page states *"Requires an app access token
or user access token"*, while the scopes page maps `user:read:subscriptions`
unambiguously to that endpoint. If an app token genuinely permitted checking
arbitrary (viewer, broadcaster) pairs, subscription state would need no scope at
all — a materially different conclusion.

I could not resolve this from documentation. The near-certain reading is that the
app-token path depends on the **broadcaster** having previously granted
`channel:read:subscriptions` to the client ID, which Watchside will never have.

A second ambiguity: the scopes page lists `user:read:moderated_channels` for Get
Moderated Channels, while the reference page renders `moderation:read`. Similarly
`user:read:emotes` vs `emotes:read`.

**STOP condition (API mechanism ambiguous).** These must be settled by a live
call against a test client before any design depends on them. Nothing in this
report's recommendations does.

---

## 5. Follow attribution (A)

### Mechanism

`GET /helix/channels/followed?user_id={viewer}&broadcaster_id={creator}` ·
scope `user:read:follows` · **viewer-authorized** · user access token.
Returns `broadcaster_id/login/name`, **`followed_at`**, `total`. Empty `data` ⇒
not following.

**No follower-side EventSub exists.** Every follow EventSub
(`channel.follow` v2) requires `moderator:read:followers`, authorized by the
broadcaster or their moderator. Follow measurement is therefore **necessarily
pull-based** — and `followed_at` is what makes that acceptable rather than crude.

### What `followed_at` does and does not buy

This is the crux of the owner's historical-data concern, and it deserves
precision.

**What it reconstructs.** For a JOIN that happened at time T, a query today
returns the current follow relationship and when it began. If `followed_at < T`,
the viewer was following at the JOIN. If `followed_at > T`, they followed
afterwards, and we know when to the second. **One retroactive lookback per
(viewer, creator) pair, at any later date.**

**What breaks it.** `followed_at` describes the *current* follow, not the
relationship's history. Twitch exposes no follow history.

| Real sequence | What a later query sees | Wrong conclusion |
|---|---|---|
| Followed 2024 → unfollowed → **refollowed after JOIN** | one row, `followed_at` after T | "Watchside caused a new discovery." **False** — a years-old relationship is credited to us |
| Not following → **followed after JOIN** → unfollowed | no row | "No conversion." **False negative** — the conversion happened |
| Followed 2024, never churned | one row, `followed_at` before T | ✅ correct |
| Never followed | no row | ✅ correct |

Both errors are **unbounded and grow with elapsed time**: the longer between the
JOIN and the lookback, the more churn accumulates. The first error is the
dangerous one, because it inflates exactly the claim we most want to make.

**Classification: H1**, degrading toward H2 with time. Recording
`following_at_join` at the moment of the JOIN converts it to **H0** and
eliminates both errors — the observation is made before any churn can occur.

### Baseline requirement

**Yes**, for full correctness — but the H1 fallback is real and is why this is
*not* the most urgent collection decision. Delay costs precision, not existence.

### Summary

| Question | Answer |
|---|---|
| Observable by Watchside? | Yes, with a scope |
| Authorization | **Viewer** |
| Endpoint | `GET /helix/channels/followed` |
| Scope | `user:read:follows` |
| Timestamp | ✅ `followed_at` |
| Historical query | ✅ current state + origin date |
| Reconstructable after the fact | ⚠️ H1 — invalid under unfollow/refollow |
| Baseline needed | Recommended, not strictly required |
| Polling | Two checks per JOIN (at click, at window close) |
| Token custody | Not for the at-JOIN check; **yes** for window close |
| Rate limits | Negligible — per-user buckets |
| DSA | Twitch-derived; deletable on de-auth |
| Firefox | `browsingActivity` — **already declared** |
| Chrome | Privacy-disclosure update |
| Strategic value | **High** — this is Level 3→4 |

---

## 6. Paid subscription attribution (B)

### Mechanism

`GET /helix/subscriptions/user?broadcaster_id=&user_id=` · scope
`user:read:subscriptions` · viewer-authorized.

Verified response fields: `broadcaster_id`, `broadcaster_login`,
`broadcaster_name`, `user_id`, `user_login`, `user_name`, `is_gift` (boolean),
`tier` (`1000`/`2000`/`3000`). **200** when subscribed, **404** when not.

**Notably absent: any timestamp.** No start date, no renewal date, no gifter
identity.

### Consequences of having no timestamp

This single fact drives everything about B:

1. **No historical reconstruction is possible at all.** Unlike follows, there is
   no `followed_at` equivalent. A query today says only *"subscribed now / not
   now"*. Whether a sub predated a JOIN six months ago is **permanently
   unknowable** unless observed at the time. → **H2.**
2. **Conversion detection requires polling**, and measurement resolution equals
   polling frequency. "Subscribed within 7 days" becomes "was not subscribed at
   T0 and was subscribed at the next poll" — a coarser and more contestable claim
   than the follow equivalent.
3. **Churn is invisible.** Sub → lapse → resub is one boolean at each poll.
4. **Prime is not distinguishable.** Prime subs are tier 1000, identical in this
   response to a paid tier-1. Any "paid conversion" claim would silently include
   Prime, which costs the viewer nothing. → **H3 for that distinction.**

### Broadcaster-side alternative — unavailable

`Get Broadcaster Subscriptions` and every `channel.subscription.*` EventSub
require `channel:read:subscriptions`, authorized by the **broadcaster**. These
carry richer data (including `channel.subscription.message`'s cumulative months).
Watchside is a viewer-side product and will never hold them. → **H3.**

### Summary

| Question | Answer |
|---|---|
| Observable? | Point-in-time only |
| Authorization | **Viewer** (`user:read:subscriptions`); broadcaster path unavailable |
| Endpoint | `GET /helix/subscriptions/user` |
| Timestamp | ❌ **none** |
| Historical query | ❌ none |
| Reconstructable | ❌ **H2 — permanently lost if not recorded at the time** |
| Baseline needed | ✅ **Mandatory** — this is the genuine irreversible datum |
| Polling | ✅ Required, and resolution = frequency |
| Token custody | ✅ **Required** for any post-JOIN detection |
| Rate limits | Scales with polls × candidates, not with JOINs |
| DSA | Twitch-derived; deletable |
| Firefox | ⚠️ possibly **`financialAndPaymentInfo`** — a NEW required category (§17) |
| Chrome | Disclosure update |
| Strategic value | **Moderate, and lower than it looks** — no amount, no timestamp, Prime indistinguishable, low base rate |

---

## 7. Gifted-subscription attribution (C)

Investigated as three separate questions, as instructed. The answers differ.

### 7.1 Viewer *receives* a gifted sub

Visible only as `is_gift: true` on Check User Subscription. **No gifter identity,
no timestamp.** Inherits every limitation of §6, plus: we cannot tell *when* the
gift arrived or *who* gave it. → **H2**, and weak even with a baseline.

### 7.2 Viewer *gifts* one subscription

**No viewer-side mechanism exists.** `channel.subscription.gift` requires
`channel:read:subscriptions` — broadcaster-authorized. No Helix endpoint reports
subscriptions a user has given. → **H3, impossible.**

### 7.3 Viewer gifts community / multiple subs

Same mechanism, same answer. `channel.subscription.gift` carries `total` and
`is_anonymous`, but only to the **broadcaster**. → **H3, impossible.**

### 7.4 Recipient / broadcaster relationships

Not visible from the viewer side in any form. → **H3.**

### Verdict

Gifting is **the single most socially-driven economic act on Twitch** — a viewer
watching with friends is precisely who gifts subs — and it is **completely
invisible to Watchside**. This is the most painful finding in M3B, and there is
no design that works around it. **STOP condition: an economic event we hoped to
measure is not exposed to viewers.**

---

## 8. Bits / Cheers attribution (D)

### What exists

The Helix reference's **Bits** section contains exactly four endpoints:

| Endpoint | Auth | Returns |
|---|---|---|
| Get Bits Leaderboard | `bits:read` — **broadcaster**, own channel | leaderboard for the authenticated broadcaster |
| Get Cheermotes | — | cheermote images |
| Get Custom Power-up | — | channel power-up config |
| Get Extension Transactions | app token, **your own extension** | Bits-in-Extensions transactions |

EventSub: `channel.cheer` and `channel.bits.use` — both `bits:read`, **broadcaster**.

### What does not exist

- No viewer Bits **balance** endpoint.
- No viewer Bits **spending history** endpoint.
- No viewer **cheer history** across channels.
- No EventSub reporting a viewer's own cheering.
- No `user:*` scope for Bits of any kind.

### Anonymous cheering

Compounds it: even broadcaster-side, `is_anonymous` cheers hide the viewer. So
even a hypothetical broadcaster partnership could not attribute all spend back to
a Watchside viewer.

### Extensions

`Get Extension Transactions` uses an app token but is scoped to **the extension
you own**. Watchside is a browser extension, not a Twitch Extension, and building
one to observe Bits would only observe Bits spent *inside that extension* — not
channel cheering. Not a workaround.

### Verdict

**H3 — permanently impossible.** Bits are the most direct, most quantifiable
economic signal on Twitch (they carry an actual amount), and Watchside has no
path to them. **STOP condition.**

---

## 9. Other economic Twitch outcomes (E)

Searched rather than assumed. Every one is broadcaster-authorized.

| Outcome | Mechanism | Auth | Class |
|---|---|---|---|
| **Prime subscription** | tier 1000 on Check User Subscription | viewer | **H3** — indistinguishable from paid tier 1 |
| **Subscription renewal** | `channel.subscription.message` (cumulative months) | **broadcaster** | **H3** viewer-side |
| **Subscription upgrade** | tier change | viewer, by polling | **H2** — needs baseline + polling |
| **Subscription end / churn** | `channel.subscription.end` | **broadcaster** | **H3**; H2 by polling |
| **Hype Train contribution** | `channel.hype_train.*` | **broadcaster** | **H3** |
| **Channel points redemption** | `channel.channel_points_custom_reward_redemption.add` (`channel:read:redemptions`) | **broadcaster** | **H3** |
| **Ad revenue / ad breaks** | `channel.ad_break.begin` (`channel:read:ads`) | **broadcaster** | **H3** |
| **Charity donations** | `channel.charity_campaign.donate` | **broadcaster** | **H3** |
| **Extension transactions** | Get Extension Transactions | app token, own extension | **H3** for us |
| **Raids** | `channel.raid` — **no authorization required** | app token | contextual only (broadcaster→broadcaster) |

`channel.raid` is the one app-token-accessible signal here and the only mild
surprise. It says nothing about a viewer's economic behavior; at most it is
context for why a channel's audience spiked. **Not recommended.**

### Verdict

**There is no second viewer-observable economic primitive.** Follows and
subscription state are the entire surface. This is the finding that caps the
value ladder at a weakened Level 5.

---

## 10. Creator relationship / engagement signals (F)

Not all strategic value is revenue. These are the defensible relationship signals.

| Signal | Mechanism | Auth | Class | Recommendation |
|---|---|---|---|---|
| **Repeated viewing of same creator** | **Watchside's own observation** — `destination_channel` across events | **none** | **H0** for the future; H3 for the past (never recorded) | ✅ **Strongest option. Free, no Twitch involvement, no new scope.** |
| **Follow relationship** | §5 | viewer | H1 → H0 if recorded | ✅ see M3D |
| **Subscription relationship** | §6 | viewer | H2 | ⚠️ see M3E |
| **Viewer's moderator status** | Get Moderated Channels (scope name ambiguous, §4.5) | viewer | H1 current / **H2** transitions — no timestamp | ❌ no committed claim depends on it |
| **VIP status** | `channel:read:vips` | **broadcaster** | **H3** | ❌ impossible |
| **Chat participation** | `channel.chat.message` EventSub, `user:read:chat` | **viewer** | H2 | ❌ **rejected** — see below |
| **Channel points activity** | `channel:read:redemptions` | **broadcaster** | **H3** | ❌ impossible |
| **Emote access as sub proxy** | Get User Emotes | viewer | H2, noisy | ❌ rejected — a worse `user:read:subscriptions` |
| **Raids into destination** | `channel.raid` | none | H0 | ❌ not viewer-attributable |

### Why chat participation is rejected despite being technically available

`user:read:chat` is genuinely viewer-authorizable, and `channel.chat.message`
would let us observe that the viewer chatted in a channel they socially joined —
a real engagement signal.

It also delivers **every message from every user in that channel**, including
people who have never heard of Watchside and cannot consent. Watchside's
analytics contract is built on the promise that no free text ever enters the
pipeline (`src/core/analytics.ts`: 64-character values, no message bodies, even
Stream Room messages recorded only as a length bucket). Subscribing to a Twitch
chat firehose to extract one boolean would invert that promise for a marginal
metric.

**Rejected on data-minimization grounds (§15), not on feasibility.**

### The signal worth taking seriously

**Repeat creator viewing is H0, costs nothing, and needs no Twitch permission.**
"Viewers who discovered a creator through Watchside returned to that creator N
times over the following 30 days" is a genuinely strong relationship claim, it is
Watchside-owned end to end, and it is currently unmeasured only because dwell and
repeat-visit views do not exist. It is arguably a better strategic proxy than
subscription state, and it is free.

---

## 11. Historical recoverability matrix (H0–H3)

**H0** fully reconstructable later · **H1** partially, with named ambiguity ·
**H2** NOT reconstructable unless captured at the time · **H3** impossible under
Twitch's current authorization model

| Outcome | Class | If we delay collection, what is lost |
|---|---|---|
| Twitch arrival (JOIN → arrived) | **H0** | nothing — Watchside-owned, already recorded |
| Shared watch, post-social linger | **H0** | nothing — already recorded |
| **Channel dwell / watch time** | **H2** | ⚠️ **All past viewing, permanently.** Watchside-owned, currently unrecorded. **No Twitch permission needed.** |
| **Repeat creator viewing** | **H2** (partly derivable from existing `destination_channel` history) | Partial — existing events carry the channel, so some repeat-visit signal is already latent |
| **`following_at_join`** | **H1** | Precision. `followed_at` gives one lookback; **invalid under unfollow/refollow**, and error grows with time |
| Follow *after* JOIN | **H1** | Same ambiguity |
| Unfollow / refollow history | **H3** | Twitch exposes no follow history |
| **`subscribed_at_join`** | **H2** | ⚠️ **Everything. No timestamp exists — the fact is unrecoverable.** |
| Subscription tier at JOIN | **H2** | same |
| Subscription conversion after JOIN | **H2** | requires baseline **and** polling |
| Prime vs paid distinction | **H3** | not exposed |
| Subscription renewal / cumulative months | **H3** viewer-side | broadcaster-only |
| Received gifted sub (that one exists) | **H2** | `is_gift` only; no gifter, no timestamp |
| **Viewer gifts a sub** | **H3** | impossible |
| **Viewer gifts community subs** | **H3** | impossible |
| **Bits / cheering by viewer** | **H3** | impossible — no endpoint, no EventSub, no scope |
| Hype Train, channel points, ads, charity | **H3** | broadcaster-only |
| Viewer moderator status | **H1** current / **H2** transitions | no timestamp |
| VIP status | **H3** | broadcaster-only |
| Chat participation | **H2** | recoverable only by firehose subscription — rejected |
| Install, install→auth | **H3** | structural: `actor_id = auth.uid()` |
| Experiment arm | **H2** | assignment is derived and stable, but *which arm was live at the time* needs recording |

### The three H2s that matter

Ordered by (irreversibility × strategic value) ÷ cost:

1. **Channel dwell.** Irrecoverable, high value, **zero Twitch cost**. → M3C.
2. **`following_at_join`.** Technically H1, so partially defensible late; converts
   to H0 if recorded. Moderate cost (one scope). → M3D.
3. **`subscribed_at_join`.** Fully irrecoverable, but low base rate, weak claim,
   highest cost (second scope + polling + custody + probable new Firefox
   category). → M3E, and see §25.

---

## 12. Baseline-at-JOIN requirements

The minimum set of facts that must exist at a socially-initiated creator visit
for downstream economic attribution to remain possible. Determined, not assumed.

### Already recorded — no change

| Fact | Source |
|---|---|
| `attribution_id` | `join_clicked` |
| actor | `actor_id = auth.uid()`, server-side |
| creator | `destination_channel` |
| `occurred_at` | on every event |
| social context | `social_count`, `source`, `opportunity_key` |

**The Watchside half of the baseline is complete today.** Nothing needs adding.

### Candidate Twitch-derived additions

| Candidate | Class | Verdict |
|---|---|---|
| `following_at_join` (boolean) | H1→H0 | ✅ **Include if M3D proceeds.** The whole of Level 3. |
| `subscribed_at_join` (boolean) | H2 | ⚠️ **Only if M3E is genuinely committed.** Irrecoverable, but see §15. |
| Raw `followed_at` timestamp | — | ❌ **Reject.** The bool answers the claim; the timestamp is strictly more Twitch data for no additional claim. |
| Subscription `tier` at JOIN | H2 | ❌ Reject initially — no committed claim needs tier. |
| `is_gift` at JOIN | H2 | ❌ Reject — no gifter, no timestamp; supports no defensible claim. |
| Viewer's Twitch numeric ID, stored | — | ❌ Reject. Derivable server-side from auth metadata at call time; storing it durably adds a durable Twitch identifier for nothing. |
| Moderator status at JOIN | H2 | ❌ Reject — no committed claim. |
| Chat participation | H2 | ❌ Reject — §10. |

### The recommended baseline

> `attribution_id` · actor · creator · `observed_at` · **`following_at_join`**
> *(only if M3D proceeds)* · **`subscribed_at_join`** *(only if M3E is committed)*

Two booleans, at most. Everything else is already recorded or fails the
data-minimization test in §15.

### Timing constraint

The tab is torn down at click time, and `analyticsHub` already flushes
synchronously before navigating. A blocking Helix round-trip would delay the
navigation — unacceptable. The baseline observation must therefore be
**dispatched fire-and-forget to a server-side function**, which records it
against the `attribution_id` independently. This is a further argument for §14's
architecture: the observation naturally lands in its own table rather than
needing to mutate an already-written event.

---

## 13. Attribution architecture options

The question: is `opportunity_key → join_clicked → attribution_id → join_arrived
→ watching_together → post-social` sufficient for long-lived economic
attribution?

**For Watchside-owned outcomes: yes, and it should not be changed.** The chain is
deterministic, survives worker eviction, and M3 already established that outcomes
days later join on actor + creator + time rather than needing the id to survive.

**For Twitch-derived outcomes: no** — for one reason, which is not about joins.

### Option 1 — Continue append-only events; join on actor + creator + time

*Add `following_at_join` / `subscribed_at_join` as properties on `join_clicked`;
add a `creator_followed` event; join in SQL.*

| Dimension | Assessment |
|---|---|
| Correctness | ✅ Good. The join key is sound. |
| Multiple JOINs to same creator | ✅ Each click is its own row |
| Multiple social opportunities | ✅ `opportunity_key` distinguishes |
| Worker/browser lifecycle | ⚠️ **Requires mutating an already-written event** — the tab is gone before Helix answers. `analytics_events` is append-only by design and has no update path. |
| **Twitch-derived data separation** | ❌ **Fatal.** Twitch-derived facts sit inside `properties` alongside Watchside-owned facts. |
| **Deletion** | ❌ **Fatal.** DSA deletion-on-revocation would mean either mutating an append-only table or deleting whole events — destroying the Watchside-owned funnel to satisfy a Twitch obligation. |
| Queryability at scale | ✅ Fine |

**Rejected.** Not because the joins fail, but because it makes the DSA obligation
in §16 impossible to honour without data loss we control.

### Option 2 — Durable attribution record keyed from the original JOIN

*A `social_creator_attribution` row per JOIN, mutated as outcomes arrive.*

| Dimension | Assessment |
|---|---|
| Correctness | ⚠️ Mutable state — the failure mode the current design avoids everywhere (`togetherStore.ts` is conservative precisely to avoid inventing facts) |
| Multiple JOINs to same creator | ⚠️ Needs an explicit policy: new row per JOIN, or update the existing one? Both are defensible, which is the problem |
| Attribution windows | ⚠️ Windows get baked into the row rather than argued in the query — the opposite of `docs/ANALYTICS.md`'s standing principle that interpretation lives in the query |
| Deletion | ✅ Clean — one table to purge |
| Future experimentation | ⚠️ A mutable row that has already been "settled" is awkward to re-analyse under a different window |
| Queryability | ✅ Good |

**Rejected.** It solves deletion but reintroduces mutable derived state and bakes
attribution policy into storage.

### Option 3 — Hybrid: immutable events + a separate Twitch-derived observation table + a derived view

*Events stay exactly as they are and never carry Twitch-derived state. A separate
table records point-in-time Twitch relationship observations. A view joins them.*

| Dimension | Assessment |
|---|---|
| Correctness | ✅ Both halves append-only; every row is an observation with a time |
| Multiple JOINs to same creator | ✅ One observation row per (attribution, kind) |
| Multiple social opportunities | ✅ Unchanged — `opportunity_key` still distinguishes |
| Attribution windows | ✅ Stay in the query, where they can be argued with |
| Worker/browser lifecycle | ✅ The late-arriving observation is an insert, not a mutation |
| **Twitch-derived separation** | ✅ **Physically separate table** |
| **Deletion** | ✅ **`delete from creator_relationship_observations where actor_id = $1` — the Watchside funnel is untouched** |
| Future experimentation | ✅ Raw observations; re-analysable under any window |
| Queryability | ✅ A view; indexes on `(actor_id, broadcaster_login, observed_at)` |

**Recommended.**

---

## 14. Recommended attribution architecture

**Option 3 — hybrid.** Conceptually (not a schema to implement):

- `analytics_events` — **unchanged.** Append-only, Watchside-owned, never
  contains Twitch-derived relationship state. The existing chain stays exactly as
  it is.
- A separate table of **point-in-time Twitch relationship observations**:
  actor, broadcaster login, the `attribution_id` that occasioned it (nullable —
  a window-close observation has no live attribution), `observed_at`, the kind of
  relationship, and a small value. One row per observation; never updated.
- A **view** joining observations to `analytics_join_funnel_v` on actor +
  creator + time, exactly as `docs/ANALYTICS.md` §11b already sketches.

### Why this shape, specifically

1. **It is the only option that satisfies the DSA without collateral damage.**
   De-authorization deletes one table. Watchside's own funnel — the thing that
   proves Levels 1 and 2, which needs no Twitch permission — survives intact.
   Under Option 1 the same deletion destroys it.
2. **It keeps interpretation in the query.** Attribution windows, thresholds and
   "does this count as a conversion" stay arguable rather than frozen at write
   time. This is the standing principle in `docs/ANALYTICS.md` §12 and it is what
   makes the numbers defensible.
3. **It matches the lifecycle.** The tab dies before Helix answers, so the
   observation was always going to arrive late. An insert into a second table is
   the natural shape; mutating a flushed event is not.
4. **It makes the observed/attributed/causal boundary structural.** Twitch-derived
   facts are physically separate from Watchside-caused facts, so a query cannot
   accidentally present one as the other.

### Naming

Prefer **`creator_relationship_observations`** over
`social_creator_attribution`. The rows are *observations*, not attributions —
the attribution is what the view computes. Naming storage after a conclusion is
how a conclusion stops being questioned.

### What it does not need

No change to `opportunity_key`, `attribution_id`, the 90s/10min windows, or any
existing view. The current chain is sufficient; it needs a **companion**, not a
replacement.

---

## 15. Data-minimization analysis

For each candidate: *what future strategic claim becomes impossible or materially
weaker without it?*

| Datum | Claim at risk | Verdict |
|---|---|---|
| **Channel dwell** | Level 2 (viewing), the denominator for *any* incremental claim, and all of Level 6 | ✅ **Collect.** Nothing else provides a denominator. |
| **Repeat creator viewing** | Level 4 relationship claims without any Twitch permission | ✅ **Collect** — derivable from data already held |
| **`following_at_join`** | Level 3 discovery — *"Y% of social JOINs exposed viewers to creators they did not follow"* | ✅ **Collect if M3D proceeds.** Nothing else answers it. |
| **Follow after JOIN** | Level 4 conversion | ✅ with M3D |
| **`subscribed_at_join`** | Weakened Level 5 — *"subscription state changed after a socially-driven JOIN"* | ⚠️ **Only with a genuine M3E commitment.** Irrecoverable, but the claim it enables is weak (§6) and unlikely to reach significance at plausible scale. |
| Raw `followed_at` | **None** — the boolean answers the claim | ❌ **Do not collect** |
| Subscription `tier` | **None committed** | ❌ Do not collect |
| `is_gift` | **None defensible** — no gifter, no timestamp | ❌ Do not collect |
| Stored Twitch numeric ID | **None** — derivable at call time | ❌ Do not store |
| Moderator status | **None committed** | ❌ Do not collect |
| Chat participation | Marginal engagement colour, at the cost of a chat firehose | ❌ **Do not collect** |
| Emote sets | **None** — strictly worse than `user:read:subscriptions` | ❌ Do not collect |
| Followed-channel **list** | **None** — we only ever need one creator at a time; the filtered query exists | ❌ **Never fetch the list.** Always `broadcaster_id`-filtered. |

### The rule this yields

> **Ask Twitch about one creator at a time, store one boolean, and never keep a
> copy of the viewer's relationships.**

The filtered `broadcaster_id` form of `Get Followed Channels` makes this possible
— we never need to see, transmit or store the follow list. That single choice is
the difference between "Watchside checks whether you follow the channel your
friends are watching" and "Watchside downloads who you follow", and they are very
different sentences in a consent dialog.

---

## 16. Privacy and Twitch DSA implications

### DSA obligations

Carried forward from M3, **with the same caveat, which is itself a STOP
condition**: `legal.twitch.com` is JavaScript-rendered and I could not extract
verbatim clause text or section numbering on either attempt. The substance below
is consistent across sources but **the exact wording must be confirmed by the
owner, and this is a legal read rather than an engineering one.**

| Obligation | Consequence |
|---|---|
| Delete all Twitch Data on termination, **revocation or reduction in scope of end-user authorization**, or on user/Twitch request | Any stored relationship fact becomes **deletable-on-demand**. §14's separate table exists for this. |
| Do not store copies of Twitch Content/Program Materials unless authorised, rights-controlled, or **cached ≤24 hours** | A cached follow *list* is plainly caught. §15's "one boolean, never the list" is designed to stay far away from this line — but whether a derived boolean is "Twitch Data" is a legal judgement, not mine. |
| Delete an end user's Twitch-derived data on request | Same |
| Do not continue associating a user ID with a user who un-authenticates | Interacts with the above |

**Machinery that does not exist today:** a per-user deletion path. The only
deletion primitive is a whole-environment reset. Any M3D/M3E work must build
per-user Twitch-data deletion **as part of the same slice**, not afterwards.

### Trust cost

Watchside's current privacy sentence is short and strong: *we record which
channel, never what you watched or for how long, and we ask Twitch for nothing
about you.*

- **M3C (dwell)** breaks the second clause. We would record how long.
- **M3D (follows)** breaks the third. We would ask Twitch about you.
- **M3E (subs)** breaks the third harder, and adds a purchase relationship.

None is disqualifying. All three should be decided deliberately. M3C in
particular is easy to wave through as "just a duration" and should not be.

### Consent-screen impact

Adding `user:read:follows` changes the Twitch authorization screen to name the
ability to view channels the user follows. Adding `user:read:subscriptions` adds
a second, more sensitive line. For a product whose trust position is "we can't
see what you watch", this is material — and it is the first thing a new user
sees.

---

## 17. Firefox implications

### The F6 decision is preserved

Firefox collects **no** `technicalAndInteraction` telemetry. Enforced at one
point in `src/background/analytics.ts`, made unforgettable by the exhaustive
`EVENT_DATA_CATEGORY` record — an unclassified event is a **compile error**.
**Nothing proposed here is a diagnostic event**; every candidate is a record of
user activity. The boundary is untouched.

### Currently declared

`scripts/manifest.mjs` line 90 — required:
`authenticationInfo`, `browsingActivity`, `personalCommunications`,
`websiteActivity`.

### The complete Mozilla category list — verified 2026-08-30

`authenticationInfo` · `bookmarksInfo` · `browsingActivity` ·
**`financialAndPaymentInfo`** · `healthInfo` · `locationInfo` ·
`personalCommunications` · `personallyIdentifyingInfo` · `searchTerms` ·
`websiteActivity` · `websiteContent` — plus `technicalAndInteraction`, which
**may only be optional**.

### Per-measurement assessment

| Measurement | Category | Manifest change? |
|---|---|---|
| `channel_dwell_ended` | `browsingActivity` | ❌ none — already required |
| Repeat creator viewing | `browsingActivity` | ❌ none |
| `following_at_join`, `creator_followed` | `browsingActivity` / `websiteActivity` | ❌ none — already required |
| Experiment arm | `authenticationInfo` | ❌ none |
| **`subscribed_at_join`** | ⚠️ **possibly `financialAndPaymentInfo`** | ⚠️ **possibly a NEW REQUIRED category** |

### The M3E Firefox finding

A paid subscription relationship is a record of a purchase. Whether Mozilla
classifies a boolean "is subscribed to this creator" as `financialAndPaymentInfo`
or as ordinary `websiteActivity` is a judgement an AMO reviewer makes, and the
downside of guessing wrong is significant: adding a **new required** data
category changes the install-time consent screen for **every existing user**, and
required categories cannot be opted out of.

**This must be clarified with AMO before M3E is designed, not discovered at
review.** It is a STOP condition — *Firefox disclosure would materially change* —
and it is a cost that M3C and M3D do not carry.

**M3C and M3D require no Firefox manifest change whatsoever.**

---

## 18. Chrome Web Store implications

| Measurement | Disclosure impact |
|---|---|
| M3A (views, arm) | None — no new collection |
| M3C (dwell) | ⚠️ Privacy-practices update: web-history-adjacent. Policy questions on "Web History" and "User Activity" need re-answering. |
| M3D (follows) | ⚠️ New Twitch scope; consent screen changes; privacy policy must describe it |
| M3E (subs) | ⚠️ As M3D, plus a purchase relationship |

Watchside's Chrome permissions and the permanent extension ID are unaffected by
all of these — none requires a new host permission or a new manifest permission.
The changes are **disclosure and consent**, not capability, which keeps the store
risk lower than it might appear. But a changed Twitch consent screen is
user-visible on first run and should not ride along with an unrelated release.

---

## 19. Business-value ladder

| Level | Claim | Data required | Have today | Missing | History recoverable? | Eng cost | Privacy cost | Twitch cost | Strategic value |
|---|---|---|---|---|---|---|---|---|---|
| **1** | Watchside creates Twitch channel arrivals | `join_clicked` → `join_arrived` | ✅ **complete** | — | n/a | none | none | none | **High** — and uniquely uncontestable: we performed the navigation |
| **2** | Watchside creates viewing / shared viewing | shared watch ✅; **total dwell ❌** | ⚠️ partial | `channel_dwell_ended` | ❌ **H2 — past viewing lost** | Medium | Moderate | **none** | **High** |
| **3** | Watchside introduces users to creators outside their graph | `following_at_join` | ❌ | scope + at-JOIN check | ⚠️ **H1** — `followed_at` gives lookback, invalid under churn | Medium–High | Significant | `user:read:follows` | **Highest** — the Twitch-facing claim |
| **4** | Discoveries create new follows / recurring relationships | follow after JOIN; **repeat viewing** | ❌ follows / ⚠️ repeat viewing latent | window-close check + token custody; repeat-view analysis | ⚠️ H1 / H2 | High | Significant | same scope | **High** |
| **5** | Those relationships generate subscriptions, Bits, gifts | subscription state only | ❌ | 2nd scope, polling, custody, possible new FF category | ❌ **H2** | High | **Highest** | `user:read:subscriptions` | ⚠️ **Capped — Bits and gifts are H3, permanently** |
| **6** | Controlled experimentation shows incremental value | arm + dwell + ≥~3,000 users | ❌ | arm property; dwell; scale | H2 (arm) | Low + scale | Low | none | **Highest, and gated on Level 2** |

### Reading the ladder

- **Levels 1–2 are Watchside-owned and need no Twitch permission.** Level 2 is
  one event away.
- **Level 3 is the highest-value Twitch-facing claim** and costs one scope.
- **Level 5 cannot be completed.** Bits and gifting are H3. The honest version is
  *"subscription state changed"*, with no amount and no timestamp.
- **Level 6 depends on Level 2, not on any Twitch scope** — a point worth
  emphasising, because "incremental value" sounds like it needs deep Twitch
  integration and does not. It needs dwell and users.

**The ladder's centre of gravity is Levels 2, 3 and 6 — and only one of the three
needs a Twitch permission.**

---

## 20. Fallback monetization options

Secondary. Evaluated, not designed. Ranked by likelihood of actually working.

| # | Option | Product fit | Revenue potential | Damage to network growth | Eng burden | Likely to work |
|---|---|---|---|---|---|---|
| 1 | **Creator/community tools** — a streamer-facing view of social arrivals into their channel | Good — reuses the funnel already built | Medium | **Low** — different payer from the viewer | Medium | ⭐⭐⭐⭐ |
| 2 | **B2B analytics** — aggregate social-discovery data to platforms/agencies | Uses existing pipeline | Medium–High | **High risk** — conflicts with the privacy position that makes the product acceptable, and with DSA transfer restrictions | Medium | ⭐⭐ |
| 3 | **Premium consumer features** — cosmetics, larger groups, history | Natural | Low–Medium | **Moderate** — paywalling social features directly suppresses graph density, the one thing strategy says not to suppress | Low | ⭐⭐⭐ |
| 4 | **Sponsorship / affiliate** — sponsored channels in Gravity | ⚠️ Poor — Gravity's credibility is that it shows where your friends are | Low–Medium | **Severe** — corrupts the core surface | Low | ⭐ |
| 5 | **Streamer/community SaaS** — a broader community product | Weak — a different product | Medium | Low | **High** | ⭐⭐ |
| 6 | **Platform expansion** (YouTube, Kick) | Strategy-compatible: more graph, more surface | Indirect | **Negative damage** — helps growth | High | ⭐⭐⭐ (as strategy, not revenue) |

**Observation worth recording:** option 1 is the only fallback that both preserves
the free-for-viewers model and reuses the M3 investment. If the platform thesis
fails, the funnel built for Levels 1–4 is *exactly* the product a creator would
pay for — "here is where your socially-referred audience came from". That makes
the M3A/M3C work a hedge rather than a bet.

**Option 2 should be treated with suspicion**: selling data derived from Twitch
likely runs into the DSA's transfer restrictions (§16), and it would trade the
trust position for revenue at precisely the moment trust is the asset.

---

## 21. Revised M3 roadmap

| Phase | Scope | Store release? | Twitch OAuth? | Token custody? | Legal/privacy? | Irreversible if delayed? |
|---|---|---|---|---|---|---|
| **M3A** — Existing Intelligence | 4 views + experiment-arm property (M3 Slices 1–5) | Arm property: yes. **Views: no — server-only** | ❌ | ❌ | ❌ | Arm: mild (H2) |
| **M3B** — Economic Attribution Research | **this report** | ❌ | ❌ | ❌ | ❌ | — |
| **M3C** — Viewing Intelligence | `channel_dwell_ended`; repeat-creator-viewing views | ✅ **yes** | ❌ **none** | ❌ | ⚠️ privacy policy | ✅ **YES — every day of growth loses viewing history permanently** |
| **M3D** — Creator Relationship Attribution | `following_at_join`, `creator_followed`; `creator_relationship_observations`; per-user deletion | ✅ yes | ✅ `user:read:follows` | ⚠️ at-JOIN no; window-close **yes** | ✅ policy + DSA + both stores | ⚠️ **Partial — H1.** `followed_at` buys real lookback |
| **M3E** — Economic Conversion | `subscribed_at_join` + polling | ✅ yes | ✅ `user:read:subscriptions` | ✅ **yes** | ✅ + **AMO category clarification** | ✅ **YES — H2, but see §25** |

### Sequencing

1. **M3A now.** Four views ship as migrations with no extension release. The arm
   property rides the next release.
2. **M3C next, and it is the priority.** It is the only measurement that is
   simultaneously irrecoverable, strategically load-bearing (Levels 2 and 6), and
   free of Twitch permissions. **Candidate requirement for the next coherent
   cross-browser release.**
3. **M3D deliberately, not urgently.** H1 means delay costs precision, not
   existence. Let M3A/M3C numbers make or break the case for the scope.
4. **M3E: research complete; recommend deferring indefinitely** pending §23 D4.

### Why M3C outranks M3D despite M3D being the "Twitch-facing" claim

The owner's instinct — collect the creator baseline before it is lost — is right
in principle and lands on the wrong datum. `following_at_join` is **H1**:
`followed_at` lets us look back. Dwell is **H2**: nothing looks back. And dwell
costs no scope, no consent-screen change, and no DSA obligation.

---

## 22. Public-launch blockers

**Strictly blocking public launch: none.** No measurement in M3 or M3B is
required for the product to function, be reviewed, or be shipped.

**Blocking on *evidence*, which is different and is the point of this milestone:**

| Item | Blocks | Why |
|---|---|---|
| **M3C — channel dwell** | Levels 2, 6, and any "incremental" claim ever | ⚠️ **Strongest pre-growth candidate.** Unrecorded viewing is gone. Costs no Twitch permission. |
| **M3A — experiment arm** | Level 6 | One property; without it no future arm analysis is possible |
| **M3A — views** | Levels 1–2 reporting | Server-only; ship immediately |
| **M3D — `following_at_join`** | Levels 3–4 at full precision | ⚠️ H1: delay is survivable, degrading |
| **M3E — `subscribed_at_join`** | Weakened Level 5 | ⚠️ H2: delay is permanent — but the claim is weak (§6, §23 D4) |

### Recommendation

**M3C is a candidate requirement for the next coherent cross-browser release** —
on irreversibility grounds, not urgency. It is the one thing where waiting has a
strictly increasing, unrecoverable cost, and it is the cheapest of the three in
every dimension except engineering.

**This is not an argument for an emergency release.** Firefox v0.6.0 is pending
at AMO and must not be disturbed. The recommendation is that when the next
coherent checkpoint arrives, M3C should be in it.

---

## 23. Owner decisions required

| # | Decision | Blocks | Recommendation |
|---|---|---|---|
| **D1** | Accept that **Bits, gifted subs, hype trains, channel points and ad revenue are permanently unmeasurable**, and correct any strategic narrative that implies otherwise | Level 5 framing | **Accept.** No design works around it. Better corrected now than in a partner conversation. |
| **D2** | Ship **M3C (channel dwell)** in the next coherent cross-browser release? | Levels 2, 6 | ✅ **Yes.** The highest irreversibility-to-cost ratio in the milestone. |
| **D3** | Request **`user:read:follows`** (M3D)? | Levels 3–4 | **Defer, deliberately.** H1 means the door is not closing fast. Let M3A/M3C numbers argue for it. |
| **D4** | Request **`user:read:subscriptions`** (M3E)? | Weakened Level 5 | ⚠️ **Recommend no, for now.** Genuinely H2 — but no timestamp, Prime indistinguishable, needs polling + custody + a probable new Firefox required category, for a low-base-rate event unlikely to reach significance at plausible scale. **This is the one place I am recommending we accept permanent data loss**, and it should be an explicit, recorded decision rather than a drift. |
| **D5** | Adopt the **hybrid attribution architecture** (§14) as the standing design? | M3D, M3E | ✅ **Yes**, in principle now — it is what makes DSA deletion survivable. |
| **D6** | Accept building a **per-user Twitch-data deletion path** as part of the first slice that touches Twitch data? | M3D, M3E | ✅ **Yes.** Not optional under the DSA, and retrofitting is worse. |
| **D7** | Commission a **legal read of the Twitch DSA** (24-hour caching; deletion on revocation; whether a derived boolean is "Twitch Data") | M3D, M3E | ✅ **Yes** before either. I could not verify verbatim text (§16). |
| **D8** | Obtain **AMO clarification** on whether subscription state is `financialAndPaymentInfo` | M3E | ✅ **Yes**, before designing M3E. Getting it wrong changes install consent for every existing user. |
| **D9** | Resolve the **documented scope ambiguities** (§4.5) by live call | M3D, M3E | ✅ Yes, cheap — one authenticated request each. |
| **D10** | Accept that **repeat creator viewing** (H0, free) is the strongest relationship signal available without any Twitch permission, and prioritise it in M3C | Level 4 | ✅ **Yes.** It is nearly free and it partially substitutes for M3D. |

---

## 24. Files, schema and components likely to change

**Nothing below was modified in this checkpoint.** Listed for planning only.

### M3A (already scoped in M3)
`supabase/migrations/00xx_m3_views.sql` *(new)* · `src/core/analytics.ts` ·
`src/background/analyticsHub.ts` · `docs/ANALYTICS.md` (fix stale §11a)

### M3C — Viewing Intelligence
| File | Change |
|---|---|
| `src/core/analytics.ts` | `channel_dwell_ended` + `DwellEndReason`; `EVENT_PROPERTIES`; **`EVENT_DATA_CATEGORY`** (exhaustive — omission is a compile error) |
| `src/background/channelDwell.ts` *(new)* | Dwell tracker mirroring `togetherWatch.ts` |
| `src/background/togetherStore.ts` | Extend or add a sibling for the open dwell interval |
| `src/background/index.ts` | Wire to the activity registry |
| `supabase/migrations/00xx_dwell_contract.sql` *(new)* | Contract rows — **data, not DDL** |
| `docs/PRIVACY.md` | New: duration recorded. Then redeploy the published page |
| `tests/extension/` | Eviction/suspend; live-stream requirement; dwell ≥ shared watch |

### M3D — Creator Relationship Attribution
| File | Change |
|---|---|
| `supabase/migrations/00xx_creator_relationships.sql` *(new)* | `creator_relationship_observations`; RLS; **per-user deletion function**; view |
| `supabase/functions/twitch-follows/` *(new)* | Follow check; SSRF gate copied from `twitch-metadata` |
| `src/background/supabaseBackend.ts` | Capture `provider_token` at sign-in |
| `src/background/analyticsHub.ts` | Fire-and-forget baseline dispatch at JOIN |
| `tests/extension/oauthContract.test.ts` | ⚠️ Currently asserts `scopes` is **absent** — changing it must be deliberate and reviewed |
| `docs/PRIVACY.md`, AMO + CWS disclosures | Scope, retention, deletion |

### M3E — Economic Conversion (only if D4 reverses)
Adds: persistent encrypted provider-token vault; refresh loop against
`id.twitch.tv`; scheduled polling job; **`scripts/manifest.mjs`** if
`financialAndPaymentInfo` is required.

### Explicitly unchanged
`src/core/experiment.ts` · `src/background/joinAttribution.ts` ·
`src/core/socialGravity.ts` · `src/core/socialViewing.ts` ·
`supabase/functions/twitch-metadata/` · all Gravity/Groups/Rooms behaviour ·
OAuth scopes · manifests · Chrome and Firefox artifacts · package versions.

---

## 25. Final recommendation

## **MODIFY**

**Proceed with M3A. Prioritise M3C. Defer M3D deliberately. Recommend against
M3E, explicitly and on the record.**

The reasoning:

1. **The economic thesis needs correcting before it needs building.** Bits,
   gifted subscriptions, hype trains, channel points and ad revenue are
   **H3 — permanently unmeasurable** by any viewer-side product. Every one is
   broadcaster-authorized, and there is no `user:*` scope for any of them. Level 5
   as written is not reachable, and the honest ceiling should be established now.

2. **The irreversibility argument points at dwell, not follows.** `followed_at`
   makes `following_at_join` **H1** — recoverable with a named ambiguity that
   grows over time. Channel dwell is **H2** with no fallback at all, and it costs
   **no Twitch permission, no consent-screen change, and no DSA obligation**. It
   is also what Level 6 depends on. That combination makes it the measurement to
   start now.

3. **Subscription state is the one place to accept permanent loss.** It is
   genuinely H2. It is also timestamp-free, Prime-blind, polling-dependent,
   custody-dependent, and probably a new required Firefox data category — for an
   event whose base rate means it will not reach significance at any scale
   Watchside will see soon. **Recommending we let this one go is the most
   consequential judgement in this report**, and it should be recorded as a
   decision (D4) rather than allowed to happen by default.

4. **The architecture question has a clear answer for an unobvious reason.** The
   current chain joins correctly; what it cannot do is let Twitch-derived data be
   deleted on de-authorization without destroying Watchside-owned analytics. The
   hybrid in §14 is the only option that honours both, and adopting it in
   principle now costs nothing.

5. **Nothing here justifies disturbing the release position.** Firefox v0.6.0 is
   pending at AMO and stays untouched. M3A's views ship as migrations with no
   extension release at all. M3C is a *candidate requirement for the next
   coherent cross-browser checkpoint* — not an emergency.

### STOP conditions triggered — reported, not designed around

- ✅ **Twitch does not expose economic events we hoped to measure** — Bits,
  gifting, hype trains, channel points, ads → §7, §8, §9
- ✅ **Events require broadcaster rather than viewer authorization** — every
  `channel.subscription.*`, `channel.cheer`, `channel.bits.use`, hype train,
  redemptions, ads → §4.2, §9
- ✅ **Attribution cannot be reconstructed historically** — subscription state has
  no timestamp (**H2**); follow state is churn-ambiguous (**H1**) → §5, §6, §11
- ✅ **New OAuth scopes required** — `user:read:follows`, `user:read:subscriptions`
  → §23 D3, D4
- ✅ **Persistent provider-token custody required** — Supabase does not persist
  provider tokens → §4.3
- ✅ **Twitch-derived data creates deletion/retention obligations** — DSA; no
  per-user deletion path exists today → §16, §23 D6
- ✅ **API/EventSub mechanisms ambiguous** — Check User Subscription's app-token
  line; `user:read:moderated_channels` vs `moderation:read`; `user:read:emotes`
  vs `emotes:read` → §4.5, §23 D9
- ✅ **Legal documentation could not be verified** — `legal.twitch.com` is
  JS-rendered; no verbatim clause text obtained → §16, §23 D7
- ✅ **Firefox disclosure would materially change** — subscription state may
  require `financialAndPaymentInfo` as a **new required** category → §17, §23 D8
- ✅ **Current architecture cannot support defensible long-term Twitch-derived
  attribution** without the §14 companion table → §13, §14

---

## 26. M3B.1 — D9 Resolution + Locked Roadmap

**Appended:** 2026-08-30
**Repository state at append:** `8f4e6ca`, branch `main`
**Type:** narrow research/decision checkpoint. Nothing implemented. No product
code, schema, migrations, OAuth, manifests, package versions or Store artifacts
touched.
**Sources consulted:** `dev.twitch.tv` (scopes and API reference),
`discuss.dev.twitch.com`, and the `nicklaw5/helix` Go client library
(`raw.githubusercontent.com`), all 2026-08-30.

> **Verification status for everything in §26: DOCUMENTATION-CONFIRMED with
> independent third-party corroboration. NOT LIVE-VERIFIED.**
> No live Twitch API call was made. §26.1.4 explains exactly why, and §26.1.5
> lists precisely what remains unknown.

---

### 26.1 D9 ambiguity resolution

#### 26.1.0 A methodological finding that comes first

While resolving these, the research surfaced a problem with the evidence itself,
and it changes how much weight §4.5's original framing deserves.

**`dev.twitch.tv/docs/api/reference/` is a single very large JavaScript-rendered
page, and automated extraction of it is unreliable.** Two fetches of the *same*
anchor (`#check-user-subscription`), on the same day, returned **contradictory
authorization text**. One of those fetches also attributed the scope
`moderation:read:subscriptions` to Get Broadcaster Subscriptions — **a scope that
does not exist in Twitch's scope list at all.**

By contrast:

- the **scopes page** (`/docs/authentication/scopes/`) is a simple table and
  extracted **consistently across three independent fetches** (M3, M3B, M3B.1);
- the **`nicklaw5/helix` Go library** is a plain-text source file, extracts
  exactly, and encodes requirements derived from real API behaviour.

**Conclusion: all three "ambiguities" recorded in §4.5 were extraction
artifacts, not genuine contradictions in Twitch's documentation.** Twitch's
actual position is consistent. This is a correction to §4.5, which framed them as
Twitch's own inconsistency.

**Standing guidance for future research:** treat the API reference page's
extracted authorization lines as unreliable; corroborate against the scopes page
and at least one maintained client library before depending on them.

---

#### 26.1.1 Ambiguity 1 — Check User Subscription authorization

| | |
|---|---|
| **Disputed capability** | Whether `GET /helix/subscriptions/user` accepts an ordinary **app access token**, which would make viewer subscription state readable with **no scope and no viewer consent** |
| **Source A** | `dev.twitch.tv/docs/api/reference/#check-user-subscription`, fetched 2026-08-30 (first fetch) — rendered as *"Requires an app access token or user access token."* |
| **Source B** | Same URL, same day (second fetch) — rendered as *"Requires a user access token that includes the **user:read:subscriptions** scope."* |
| **Source C** | `dev.twitch.tv/docs/authentication/scopes/`, fetched 2026-08-30 (and twice previously) — `user:read:subscriptions` = *"View if an authorized user is subscribed to specific channels."* APIs: **Check User Subscription**. Consistent across all three fetches. |
| **Source D** | `nicklaw5/helix`, `subscriptions.go` — `// Check if a specific user is subscribed to a specific channel` / `// Required scope: user:read:subscriptions` |
| **Authoritative** | **C + D.** Source A is the extraction artifact described in §26.1.0. |

**RESOLVED: Option B.** Check User Subscription requires a **viewer user access
token bearing `user:read:subscriptions`**. There is **no app-access-token
shortcut**, and therefore **no path to subscription state without viewer
consent**.

Source D independently confirms the neighbouring endpoint too, which is what
settles the confusion the owner warned about:

| Endpoint | Library comment | Scope | Authorized by |
|---|---|---|---|
| `GET /helix/subscriptions/user` — **Check User Subscription** | "Check if a specific user is subscribed to a specific channel" | **`user:read:subscriptions`** | **viewer** |
| `GET /helix/subscriptions` — **Get Broadcaster Subscriptions** | "Broadcasters can only request their own subscriptions" | **`channel:read:subscriptions`** | **broadcaster** |

The two were never the same authorization model, and Source A's "app access
token" line was almost certainly bleed-through from the broadcaster endpoint —
exactly the confusion the brief flagged as Option C.

#### 26.1.2 Ambiguity 2 — Get Moderated Channels

| | |
|---|---|
| **Disputed capability** | Whether a viewer can authorize us to read the channels they moderate |
| **Source A** | API reference extraction — `moderation:read` (the **broadcaster** scope) |
| **Source B** | Scopes page — `user:read:moderated_channels` = *"Read the list of channels you have moderator privileges in"* → Get Moderated Channels |
| **Source C** | `nicklaw5/helix`, `moderation.go` — *"Gets a list of channels that the specified user has moderator privileges in. Required scope: `user:read:moderated_channels`"* |
| **Authoritative** | **B + C** |

**RESOLVED: `user:read:moderated_channels`, viewer-authorized.** Source C also
confirms the response is `broadcaster_id` / `broadcaster_login` /
`broadcaster_name` only — **no timestamp**, so moderator-status *transitions*
remain H2. Unchanged verdict: rejected on data-minimization grounds (§15); no
committed claim depends on it.

#### 26.1.3 Ambiguity 3 — Get User Emotes

| | |
|---|---|
| **Disputed capability** | Scope for `GET /helix/chat/emotes/user` |
| **Source A** | API reference extraction — `emotes:read` |
| **Source B** | Scopes page — `user:read:emotes` = *"View emotes available to a user"* → Get User Emotes |
| **Source C** | `nicklaw5/helix`, `chat.go` — **does not implement this endpoint**; no corroboration available |
| **Authoritative** | **B, by inference** from §26.1.0's demonstrated reliability ordering |

**PARTIALLY RESOLVED — `user:read:emotes`, by inference rather than
corroboration.** This is the one D9 item that remains formally open. It is
**strategically inert**: Get User Emotes was rejected in §10/§15 as a strictly
worse proxy for `user:read:subscriptions`, and no recommendation in this report
depends on it. **No further work warranted.**

#### 26.1.4 Live verification — attempted, and why it was stopped

The brief authorized a safe live call *"using our established Twitch development
environment and existing credentials/tokens."* **No such local credentials
exist.**

Inspection (by key **name** only — no value was read, printed, or logged):

- `.env.local` contains exactly `VITE_KICKBACK_MODE`,
  `VITE_SUPABASE_PUBLISHABLE_KEY`, `VITE_SUPABASE_URL`. No Twitch credentials.
- `TWITCH_CLIENT_ID` / `TWITCH_CLIENT_SECRET` appear only as **hosted Supabase
  Edge Function secrets**, referenced by
  `supabase/functions/twitch-metadata/index.ts`. They are not present on this
  machine.

Every route to a live call was rejected against the brief's own constraints:

| Route | Rejected because |
|---|---|
| Mint an app access token locally | No client secret on this machine — and an app token cannot answer the question anyway (§26.1.1: the endpoint requires a *user* token) |
| Extend the deployed `twitch-metadata` function to probe the endpoint | **Modifies product code**, and would deploy a hosted change |
| Extract the hosted secret to use locally | Handling a production credential outside its intended boundary; outside authorization |
| Register a separate Twitch dev app | *"Do not alter Twitch developer-app settings"*; also needs owner credentials |
| Obtain a scoped viewer token | Requires `user:read:subscriptions`, which we do not request — this would **change OAuth and force a reauthorization**, both explicitly forbidden |

**The decisive point is structural, not logistical:** verifying that Check User
Subscription requires `user:read:subscriptions` would require *already holding*
`user:read:subscriptions`. **The verification is circular** — it cannot be
performed without first taking the exact action the verification is meant to
inform. No amount of environment setup changes that.

**STOPPED, as instructed.** Everything in §26 is DOCUMENTATION-CONFIRMED with
third-party library corroboration, and is stated as such.

#### 26.1.5 What remains unknown

Honest residue after D9:

1. **`user:read:emotes` vs `emotes:read`** — inference only (§26.1.3). Inert.
2. **⚠️ NEW, and it partially corrects §6/§7.1: gifter identity may be
   returned.** `nicklaw5/helix` defines `UserSubscriptionResponse` as
   `BroadcasterID`, `BroadcasterLogin`, `BroadcasterName`, `IsGift`,
   **`GifterLogin`, `GifterName`**, `Tier`. One API-reference extraction listed
   gifter fields as *absent*. If the library is right, Check User Subscription
   reveals **who gifted the subscription** — a third party's identity.
   **This does not change any recommendation**, because §15 already rejects
   storing gifter data and §26.3 continues to. It is recorded because it would
   *increase* the sensitivity of the response we receive, which matters for D7
   and D8. **Requires live verification before M3E-a is implemented.**
3. **Exact HTTP semantics** — that 404 means "not subscribed" is
   documentation-confirmed but untested against the live API.
4. **Rate-limit bucket values** for user-token requests — the *per client ID per
   user* rule is documented; the numeric bucket is not.
5. **DSA verbatim clause text** — unchanged from §16; `legal.twitch.com` remains
   JavaScript-rendered. Still D7.

Items 2 and 3 are the ones that should be settled by a single live call **at the
start of M3E-a implementation**, when a scoped token will exist as a normal
consequence of the work rather than as a special exception.

---

### 26.2 Check User Subscription — definitive authorization result

Answering the brief's checklist directly.

| Question | Answer | Confidence |
|---|---|---|
| **A.** Ordinary app access token? | **NO** | Documentation-confirmed + library-corroborated |
| **B.** Viewer user access token with `user:read:subscriptions`? | **YES — this is the only path** | Documentation-confirmed + library-corroborated |
| **C.** Confused with a broadcaster/Extension app-token case? | **YES — this was the source of the ambiguity.** Get Broadcaster Subscriptions (`/subscriptions`, `channel:read:subscriptions`, broadcaster-only) is a different endpoint with a different model | Confirmed |
| **D.** Anything else? | No other path found | — |
| `user_id` must equal the authenticated viewer? | **Yes in practice** — the token's scope authorizes only that viewer's own subscription state. The library names it "check if a *specific user* is subscribed", and the viewer scope is what carries the authority | Documentation-confirmed; **not live-verified** |
| `broadcaster_id` may be any Affiliate/Partner? | **Yes** — any channel that can have subscriptions. No relationship to the broadcaster is required | Documentation-confirmed |
| Response contains only `broadcaster_id`, `broadcaster_login`, `broadcaster_name`, `is_gift`, `tier`? | **⚠️ NO — corrected.** The library adds **`gifter_login`, `gifter_name`**. See §26.1.5 item 2 | **Unresolved — flagged** |
| Still **no** subscription-start timestamp? | **CONFIRMED — none.** Independently corroborated: a Twitch staff member on `discuss.dev.twitch.com/t/.../33152` acknowledges the absence of `created_at` in Helix (it existed in the deprecated Kraken API) and points to an open "Subs Tenure in Helix" feature request. **The gap is known to Twitch and unfilled.** | Strong |
| 404 still means not subscribed? | Yes | Documentation-confirmed; not live-verified |
| Prime vs paid still unavailable? | **CONFIRMED.** `tier` is `1000`/`2000`/`3000` only. Prime is tier 1000, indistinguishable from paid tier 1 | Confirmed |
| Gifted vs self-paid represented only by `is_gift`? | **Yes for the boolean** — plus possibly gifter identity (above) | Partially resolved |

**Net effect on cost:** the optimistic possibility — that subscription state was
free via an app token — is **eliminated**. `user:read:subscriptions` is required,
it is viewer-authorized, and it appears on the consent screen. The §6 cost
assessment stands.

---

### 26.3 `subscribed_at_join` — revised decision analysis

The owner rejected §23 D4 ("accept permanent loss because it is low-volume"). On
re-analysis **that rejection is correct, and §23 D4 was wrong** — but not for the
reason the owner gave. It was wrong because it **priced M3E as one indivisible
expensive thing when it is two separable things**, and the irreversible half is
far cheaper than the report claimed.

#### The ten questions

**1. What becomes permanently unavailable?**
For every socially-attributed JOIN that happens before collection begins: whether
the viewer already had a paid relationship with that creator. Without it, every
later observation of a subscription is uninterpretable — we cannot tell a
pre-existing subscriber from a conversion. **The discovery claim and the
conversion claim both collapse into "this person is subscribed", which proves
nothing.**

**2. Could current subscription state be reconstructed later?**
**No.** No timestamp, no history endpoint, no EventSub. Corroborated by Twitch
staff acknowledging the gap (§26.2). **H2, firmly.**

**3. Could conversion be inferred later without the baseline?**
**No** — and this is the sharpest way to put it. Observing "subscribed at T1"
without a baseline is compatible with *"subscribed for three years"* and with
*"subscribed because of Watchside"*, and nothing distinguishes them. A baseline
of `false` is what converts a meaningless observation into evidence.

**4. Ambiguities that remain even with a baseline**

| Case | With baseline at T0 | Residual ambiguity |
|---|---|---|
| Already subscribed before JOIN | ✅ known exactly | none |
| Subscribed after JOIN | ✅ known to have occurred in (T0, T1] | **when**, within the window |
| Gifted subscription | ⚠️ `is_gift` distinguishes it | someone else's act — arguably *not* the viewer's economic behaviour at all |
| Expiration / cancellation | ❌ invisible between checks | sub → lapse → resub reads as one sub |
| Renewal | ❌ not exposed viewer-side | H3 |
| Resubscription | ❌ indistinguishable from continuous | H3 |

The honest claim shape is therefore: *"was not subscribed at the socially-driven
JOIN; was subscribed when next observed"* — **sequence, bounded by observation,
never a revenue figure.**

**5. What to collect at JOIN**
One boolean: `subscribed_at_join`. Absent (a third state) on any failure —
expired token, 429, network — exactly as `destination_live` is absent today.
**Not** `tier`, **not** `is_gift`, **not** gifter identity: none supports a
committed claim, and gifter identity names a third party who never consented.

**6. OAuth/token infrastructure actually required — the correction**

§6 and §23 D4 asserted that subscription measurement *requires* persistent
provider-token custody plus a polling job. **That is only true of continuous
conversion detection, and continuous detection is not necessary.**

Two separable slices:

| Slice | What it does | Scope | Custody | Polling job | Irreversible? |
|---|---|---|---|---|---|
| **M3E-a — baseline** | Check at JOIN, store one boolean | `user:read:subscriptions` | ❌ **none** — token is in hand in-session | ❌ none | ✅ **YES — this is the H2 half** |
| **M3E-b — conversion detection** | Determine whether a sub later appeared | same scope | ⚠️ only if we want tight windows | ⚠️ only for tight windows | ❌ **No — deferrable indefinitely** |

And the observation that collapses M3E-b's cost:

> **If the baseline says `false`, a *single* later check is sufficient to
> establish that a conversion occurred.** Any check, at any time, suffices —
> "not subscribed at T0, subscribed at T1" is a valid bounded conversion.
> **A viewer signing in again hands us a fresh provider token for free.**

So conversion can be measured **opportunistically at subsequent sign-ins**, with
**no vault, no refresh loop, and no scheduled job**. The only thing bought by
custody and polling is a *tighter window* — precision, not existence. Precision
is deferrable; existence is not.

**This is the analytical error in §23 D4**, and it inverts the conclusion.

**7. Only for socially-attributed JOINs?**
**Yes, and this must be a hard constraint.** The check fires only when a
`join_clicked` carries a social attribution — never on ordinary Twitch browsing.
That keeps volume proportional to the claim, and keeps the honest sentence
*"Watchside checks your relationship with the channel your friends are watching"*
rather than *"Watchside tracks your subscriptions."*

**8. API-call volume**

*Assumptions — stated, not measured. No production JOIN-rate data exists yet;
these are planning figures to be replaced by M3A's actual numbers.*

- **A1:** 30% of DAU perform ≥1 socially-attributed JOIN on an active day
- **A2:** those users average 1.5 such JOINs per active day
- **A3:** one baseline check per JOIN
- **A4:** conversion re-checks are opportunistic at sign-in — ~1 per user per
  active day, only for outstanding `false` baselines (assume 20% of users)

| DAU | Social JOINs/day | Baseline calls/day | Opportunistic re-checks/day | **Total/day** | Peak/min (assume 10% in busiest 60 min) |
|---|---|---|---|---|---|
| 100 | 45 | 45 | 20 | **~65** | ~1 |
| 1,000 | 450 | 450 | 200 | **~650** | ~2 |
| 10,000 | 4,500 | 4,500 | 2,000 | **~6,500** | ~11 |

Against the **per client ID per user per minute** rule (§4.4), each viewer's
handful of calls sits in their own bucket. Even at 10,000 DAU this is
**operationally trivial**, and it does not touch the app-token bucket that
`twitch-metadata` uses. **Rate limiting is not a reason to decline M3E-a.**

**9. Privacy / Firefox / Chrome consequences**

| Surface | Consequence |
|---|---|
| Consent screen | A second scope line. **Mitigated by bundling with M3D — one consent change, not two** (§26.4) |
| Privacy policy | Must describe the check, the boolean, retention, and deletion |
| DSA | Twitch-derived → per-user deletion path (D6). **Shared with M3D — no incremental cost if bundled** |
| **Firefox** | ⚠️ **The genuine open risk.** Subscription state may be `financialAndPaymentInfo` — a **NEW REQUIRED** category, which changes install consent for **every existing user** and cannot be opted out of. **D8 must clear first.** |
| Chrome | Disclosure update; no new permission, no host permission, ID unchanged |

**10. The strategic claim that becomes impossible without it**

> *"Viewers who met a creator through Watchside — having no prior paid
> relationship with them — went on to subscribe."*

This is the only sentence Watchside could ever say that connects its social layer
to **Twitch revenue**. Everything else in the ladder is arrivals, viewing,
discovery and follows: valuable, but not money. Without the baseline this
sentence is **unsayable forever**, because the "having no prior paid
relationship" clause is exactly the H2 fact.

Given that Bits, gifting, hype trains, channel points and ad revenue are all
**H3 — permanently impossible** (§26.6), `subscribed_at_join` is **the only
economic baseline Watchside will ever be able to establish.** Its scarcity is
precisely the argument for collecting it.

#### Revised recommendation

**D4 REVERSED: collect `subscribed_at_join`.**

- ✅ **Collect it**, as **M3E-a**, bundled into the same release and the same
  consent change as M3D.
- ❌ **Do not build** custody, a refresh loop, or a polling job (M3E-b). Use
  opportunistic re-checks at sign-in.
- ⚠️ **Gated on D8** (AMO `financialAndPaymentInfo` clarification) and **D7**
  (DSA legal read). If D8 says a new required category is needed, that is an
  owner decision about install consent — **not a reason to abandon the baseline**,
  but a reason to sequence it deliberately.
- Store **one boolean**. Not tier, not `is_gift`, not gifter identity.

**§23 D4 and §25 point 3 are superseded by this subsection.**

---

### 26.4 `following_at_join` — revised priority

No new evidence changes the mechanism: `user:read:follows`, `followed_at`
returned, no follower-side EventSub, **H1**.

What changes is the **framing**, and §21's "M3C outranks M3D" reasoning was
subtly wrong.

#### The unfollow/refollow ambiguity is not symmetric

§5 recorded both error directions. Only one of them matters strategically, and it
is the dangerous one:

> **Followed years ago → unfollowed → refollowed after a Watchside JOIN** reads,
> to a later `followed_at` lookback, as *"Watchside caused a new creator
> discovery."*

That is a **false positive on Watchside's single most important claim**, in our
own favour, in a number we would put in front of a platform partner. A claim that
can only be wrong in the flattering direction is exactly the claim a diligence
process will attack — and "we reconstructed it afterwards from `followed_at`"
is a materially weaker answer than "we observed it at the moment."

The false-negative direction (followed → unfollowed, conversion invisible) merely
understates us. Tolerable.

**So H1 is not a licence to defer.** It means the *data* survives; it does not
mean the *claim* survives scrutiny. §21 conflated the two.

#### Decision

**A — next-release requirement**, with one qualification.

Recommended sequencing, which also resolves the consent-screen problem:

- **v0.7** — M3A + M3C. No Twitch scope, **no consent change**, no external
  dependency. Ships as soon as it is ready.
- **v0.8** — **M3D + M3E-a together**, as **one** scope request and **one**
  consent-screen change, gated on D7 and D8.
- **Public launch** — after v0.8.

Bundling is not merely convenient. Two separate consent changes in consecutive
releases would be a worse user experience than one, and would spend the trust
budget twice for a single capability.

If D7/D8 stall beyond a reasonable window, ship **M3D alone** at v0.8 (it needs
no Firefox category change) and M3E-a immediately after. **Do not let M3E-a's
Firefox uncertainty delay M3D.**

---

### 26.5 Channel dwell — locked priority

Every M3B conclusion **confirmed**. Investigation found **no new blocker**.

| Claim | Status |
|---|---|
| H2 / irrecoverable historically | ✅ Confirmed — nothing records viewing today; no reconstruction exists |
| Requires no Twitch OAuth scope | ✅ Confirmed — derived entirely from Watchside's own tab observation |
| Derives from behaviour already observed for presence | ✅ Confirmed — activity registry + 45s heartbeat (`src/background/presence.ts:136`) |
| Supplies the denominator for total and attributed watch time | ✅ Confirmed — shared-watch intervals are a socially-selected subset and are biased upward |
| Required before any incremental-watch-time experiment | ✅ Confirmed — a control arm produces no shared watches, so without dwell there is nothing to compare |
| Should include repeat-creator-viewing analysis | ✅ Confirmed, and it is **partly latent already**: existing events carry `destination_channel`, so some repeat-visit signal is recoverable from history |
| Next coherent cross-browser release, not an emergency | ✅ Confirmed — Firefox v0.6.0 stays untouched at AMO |

#### Implementation caveats found (none invalidates the conclusion)

1. **Multi-destination is a real design decision, not a detail.** Watchside
   supports up to three simultaneous destinations (`destinations_published`,
   `DestinationCountBucket`). Dwell must define whether it counts the **focused**
   tab only or every open Twitch tab. **Recommendation: focused tab only**,
   documented as deliberate undercounting — consistent with every other
   conservative choice in `togetherWatch.ts`. Counting three background tabs as
   three concurrent viewing hours would be the one place the system could
   *invent* watch time.
2. **The live-stream rule must be reused, not re-derived.** Dwell must open only
   when `socialViewing.ts` says a stream is live, or dwell and shared watch will
   disagree about what "watching" means — and dwell would exceed shared watch on
   a dead channel.
3. **Dwell must be ≥ shared watch on the same channel**, by construction. Worth a
   test; it is the cheapest available check that the two lifecycles agree.
4. **MV3 eviction discipline must be inherited wholesale** from
   `togetherStore.ts` — the >5-minute gap closing as `observation_lost`, and the
   frozen-worker check that applies doubt on every tick rather than only on
   restore. That check exists because it was the one place the system could
   report a laptop sleep as viewing time.
5. **Chrome Web Store "Web History" disclosure** likely needs re-answering. Not a
   blocker; part of the release checklist.

**VERDICT: M3C LOCKED. Approved in principle, no blocker found.**

---

### 26.6 Economic ceiling — H3 / platform-cooperation matrix

The owner's third category is the most strategically important reframe in this
checkpoint, and it substantially rehabilitates the ceiling finding in §1.

**Categories:** **(1)** impossible for Watchside under viewer authorization ·
**(2)** possible only with broadcaster authorization · **(3)** possible if Twitch
itself cooperates or shares internal data during partnership/diligence

| Outcome | (1) Viewer-auth | (2) Broadcaster-auth | (3) Twitch-internal | M3B verdict |
|---|---|---|---|---|
| Viewer gifts a subscription | ❌ impossible | ✅ `channel:read:subscriptions` (per channel) | ✅ **fully available to Twitch** | **Confirmed H3** |
| Community / multi-gifting | ❌ impossible | ✅ `channel.subscription.gift` (`total`, `is_anonymous`) | ✅ fully available | **Confirmed H3** |
| Bits / Cheers spending | ❌ impossible — no endpoint, no EventSub, no scope | ⚠️ partial — `channel.cheer`, `bits:read`; **anonymous cheers hide the viewer even here** | ✅ **fully available, with amounts** | **Confirmed H3** |
| Hype Train contribution | ❌ | ✅ `channel:read:hype_train` | ✅ | **Confirmed H3** |
| Channel Points | ❌ | ✅ `channel:read:redemptions` | ✅ | **Confirmed H3** |
| Ad revenue | ❌ | ⚠️ `channel:read:ads` — ad *breaks*, not revenue | ✅ **only Twitch has revenue** | **Confirmed H3** |
| Charity donations | ❌ | ✅ `channel:read:charity` | ✅ | **Confirmed H3** |
| Prime vs paid | ❌ `tier` alone | ⚠️ richer broadcaster data | ✅ | **Confirmed H3** |
| Subscription renewals / cumulative months | ❌ | ✅ `channel.subscription.message` | ✅ | **Confirmed H3** |
| **Subscription state (point-in-time)** | ✅ **`user:read:subscriptions`** | ✅ | ✅ | **Corrected → collect (§26.3)** |
| **Follow state + `followed_at`** | ✅ **`user:read:follows`** | ✅ | ✅ | **Confirmed available** |

**All nine H3 classifications are CONFIRMED.** None was overturned.

#### Why this is less damaging than §1 implied

Every category-1 item is category-3. **Twitch can already see all of it.**

Watchside does not need to independently observe downstream monetization. It
needs to prove the **upstream causal link** — that the social layer produces
incremental viewing and creator discovery that would not otherwise have happened.
If that link is established with credible, randomized evidence, then during
partnership or acquisition diligence **Twitch evaluates the downstream economics
with its own internal data**, against Watchside's own cohort and arm definitions.

This changes what Watchside must build:

- ❌ **Not** a revenue-observation system. It cannot be built, and attempting it
  buys scopes for data Twitch already owns.
- ✅ **A defensible, randomized upstream causal claim** — Levels 3, 7 and 8 —
  plus **clean cohort and arm definitions Twitch can join against internally**.

**This is a strictly better strategic position than the one §1 described**, and
it means the H3 wall is a limit on *our observation*, not on the *thesis*.

**Practical implication worth recording now:** Watchside's experiment arms,
cohorts and attributed-JOIN sets should be defined so they are **externally
reproducible** — stable user-level assignment (already true: `resolveArm` is a
salted hash of user id), explicit windows, and no interpretation baked into
storage (already true: §14). A partner must be able to take our cohort definition
and run it against their own data. **That is the real deliverable of Level 9, and
it costs nothing extra if the architecture stays as recommended.**

---

### 26.7 Final business-value ladder

| L | Claim | Measurable today? | H-class | New collection | Twitch scope | Custody | Strategic importance | Ships |
|---|---|---|---|---|---|---|---|---|
| **L1** | Social exposure shown | ✅ **yes** — `gravity_cluster_impression` + `opportunity_key` | H0 | none | ❌ | ❌ | High — the funnel's denominator | **M3A** |
| **L2** | JOIN / Twitch arrival | ✅ **yes** — `analytics_join_funnel_v` | H0 | none | ❌ | ❌ | **High — uncontestable; we performed the navigation** | **M3A** |
| **L3** | Total + attributed channel dwell | ❌ | **H2** | `channel_dwell_ended` | ❌ **none** | ❌ | **Highest** — denominator for every later claim | **M3C / v0.7** |
| **L4** | Socially driven creator discovery | ❌ | **H1** (degrading; false-positive risk §26.4) | `following_at_join` | `user:read:follows` | ❌ at JOIN | **Highest — the Twitch-facing claim** | **M3D / v0.8** |
| **L5** | Follow relationship / conversion | ❌ | H1 | `creator_followed` | same | ⚠️ tighter windows only | High | **M3D / v0.8** |
| **L6** | Subscription relationship / conversion | ❌ | **H2 — irrecoverable** | `subscribed_at_join` | `user:read:subscriptions` | ❌ (opportunistic re-check) | **Moderate–High — the only economic baseline we can ever hold** | **M3E-a / v0.8, gated D7+D8** |
| **L7** | Repeat creator viewing / relationship depth | ⚠️ **partly latent** — `destination_channel` history exists | H2 forward / H1 back | dwell + views | ❌ **none** | ❌ | **High — strongest relationship signal needing no scope** | **M3C / v0.7** |
| **L8** | Randomized incremental watch-time lift | ❌ | H2 (arm) | arm property + dwell + scale (~3,000 users) | ❌ **none** | ❌ | **Highest — the only causal claim** | **arm: M3A · analysis: post-growth** |
| **L9** | Twitch-internal economic conversion | ❌ **by us, ever** | H3 for us | **reproducible cohort/arm definitions** | ❌ | ❌ | **Highest at diligence** | **falls out of L8 if architecture holds** |

**Reading it:** L1, L2 done. **L3 and L7 need no Twitch permission and are the
priority.** L4–L6 need one consent change between them. L8 needs scale, not
permissions. **L9 is not built — it is enabled**, by keeping cohorts and arms
externally reproducible.

---

### 26.8 Revised M3 roadmap

| Phase | Contents | Status |
|---|---|---|
| **M3A — Existing Intelligence** | M3 Slices 1–5: four views + experiment-arm property | **Execute now.** Views server-only; arm property rides v0.7 |
| **M3B — Economic Attribution Research** | This report incl. §26 | **CLOSED** on recording §26.11 decisions |
| **M3C — Viewing Intelligence** | `channel_dwell_ended` (focused-tab, live-stream rule); repeat-creator-viewing views | **Execute immediately after / alongside M3A. v0.7.** No scope, no consent change |
| **M3D — Creator Relationship Attribution** | `following_at_join`, `creator_followed`, `creator_relationship_observations`, per-user deletion | **v0.8**, gated on D7 |
| **M3E-a — Subscription Baseline** | `subscribed_at_join` (one boolean) | **v0.8, bundled with M3D**, gated on D7 + D8 |
| **M3E-b — Conversion Precision** | custody, refresh loop, scheduled polling | **Deferred indefinitely.** Buys window precision only |
| **F7 — Firefox** | Against Mozilla's signed artifact | Whenever AMO approves. **Independent** |
| **M5 — Pre-Public Product Pack** | Store assets, listing, onboarding | After v0.8 |
| **M6 — Public RC** | Cross-browser release candidate | After M5 |
| **M7 — Public Launch** | | **Gated by §26.9** |

#### Roadmap invariant — adopted

> **NO MEANINGFUL PUBLIC GROWTH WHILE A HIGH-STRATEGIC-VALUE H2 MEASUREMENT WITH
> REASONABLE COLLECTION COST IS KNOWINGLY MISSING.**

Applied to the current H2 set:

| H2 measurement | Strategic value | Collection cost | Invariant verdict |
|---|---|---|---|
| Channel dwell (L3) | Highest | Low — no scope | 🚦 **Gates public growth. Must ship (v0.7).** |
| Repeat creator viewing (L7) | High | Low — no scope | 🚦 **Gates public growth. Ships with M3C.** |
| Experiment arm (L8) | Highest | Trivial — one property | 🚦 **Gates public growth. Ships with M3A.** |
| `subscribed_at_join` (L6) | Moderate–High | Moderate — scope + D8 | 🚦 **Gates public growth**, unless D8 forces a new Firefox required category and the owner explicitly accepts the loss on the record |
| `following_at_join` (L4) | Highest | Moderate — scope | ⚠️ **H1, not H2** — technically outside the invariant, but §26.4's false-positive argument makes it a **de facto gate** |
| Install / install→auth | n/a | **H3** | Not applicable — structurally impossible |

**Every H2 measurement with reasonable cost is scheduled before M7.** The
invariant is satisfiable without delaying anything already planned.

---

### 26.9 Irreversible-data launch gates

Explicit gate list for M7 — Public Launch.

| Gate | Requirement | Blocking? |
|---|---|---|
| **G1** | `channel_dwell_ended` shipped and confirmed emitting in production | 🔴 **BLOCKING** |
| **G2** | Repeat-creator-viewing analysis available (ships with G1) | 🔴 **BLOCKING** |
| **G3** | `experiment_arm` recorded on `authenticated_session_started`, gated on `isRandomisedArm()` | 🔴 **BLOCKING** |
| **G4** | `following_at_join` shipped **or** an explicit recorded owner decision to accept degraded H1 reconstruction and its false-positive risk | 🔴 **BLOCKING** (decision or delivery) |
| **G5** | `subscribed_at_join` shipped **or** an explicit recorded owner decision to accept permanent loss, with D8's answer on the record | 🔴 **BLOCKING** (decision or delivery) |
| **G6** | Per-user Twitch-data deletion path exists before any Twitch-derived data is stored | 🔴 **BLOCKING** for M3D/M3E-a |
| **G7** | D7 legal read of the DSA complete | 🔴 **BLOCKING** for M3D/M3E-a |
| **G8** | D8 AMO clarification obtained | 🔴 **BLOCKING** for M3E-a only |
| **G9** | Privacy policy updated and republished for every shipped measurement | 🔴 **BLOCKING** |
| — | L8 experiment *executed* | ⚪ **Not blocking** — needs ~3,000 users; instrument now, run later |

**G4 and G5 are satisfiable by a decision rather than by delivery** — the
invariant demands that the loss be *chosen and recorded*, not that it never
happen.

---

### 26.10 Exact implementation handoff

#### Dependency graph

```
  M3A ────────────────────────────────────────────────┐
  ├── 4 reporting views          [migrations only]    │
  │     └─► DEPLOYS WITHOUT A STORE RELEASE ──────────┼──► ships today
  └── experiment_arm property    [client + contract]  │
                                                      ▼
  M3C ─────────────────────────────────────────► v0.7 CANDIDATE
  ├── channel_dwell_ended        [client + contract]      (Chrome + Firefox
  ├── repeat-creator views       [migrations only]         from ONE tagged
  └── privacy policy + republish [docs + Pages]            source state)
                                                      │
        ┌─── D7 legal read (DSA) ────────────┐        │
        │                                    ▼        ▼
        │                          M3D ──────────────────► v0.8 CANDIDATE
        │                          ├── following_at_join        (ONE consent
        │                          ├── creator_followed          change for
        │                          ├── creator_relationship_      both)
        │                          │     observations + RLS
        │                          ├── per-user deletion (G6)
        │                          ├── twitch-follows fn
        │                          └── OAuth: +user:read:follows
        │                                    ▲
        └─── D8 AMO clarification ───► M3E-a ┘
                                      └── subscribed_at_join
                                          OAuth: +user:read:subscriptions
                                                      │
                                                      ▼
                                    M5 ──► M6 ──► M7 (gated by §26.9)

  F7 (Firefox signed artifact) ── independent, whenever Mozilla approves
  M3E-b (custody + polling) ───── deferred indefinitely; precision only
```

#### Work classification

| Work | Migrations only | Client change | OAuth change | Token custody | Privacy policy | Firefox declaration | Chrome disclosure | Store submission | Deploys w/o Store |
|---|---|---|---|---|---|---|---|---|---|
| M3A — views | ✅ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ✅ **yes** |
| M3A — arm property | contract row | ✅ | ❌ | ❌ | ❌ | ❌ | ❌ | ✅ | ❌ |
| M3C — dwell | contract row | ✅ | ❌ | ❌ | ✅ | ❌ **none** | ⚠️ update | ✅ | ❌ |
| M3C — repeat-view views | ✅ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ✅ **yes** |
| M3D — follows | ✅ + Edge fn | ✅ | ✅ **`user:read:follows`** | ❌ at JOIN | ✅ | ❌ **none** | ⚠️ update | ✅ | ❌ |
| M3E-a — sub baseline | ✅ + Edge fn | ✅ | ✅ **`user:read:subscriptions`** | ❌ | ✅ | ⚠️ **possibly `financialAndPaymentInfo`** | ⚠️ update | ✅ | ❌ |
| M3E-b — conversion precision | ✅ | ❌ | ❌ | ✅ **yes** | ✅ | ❌ | ⚠️ | ❌ | ✅ |
| Per-user deletion (G6) | ✅ | ❌ | ❌ | ❌ | ✅ | ❌ | ⚠️ | ❌ | ✅ **yes** |

#### Sequence

1. **M3A views** — migration; deploy now; no release.
2. **M3A arm property** + **M3C dwell** — client work; **v0.7**.
3. **M3C repeat-view views** — migration; anytime after dwell data exists.
4. **Privacy policy** for dwell — before v0.7 ships.
5. **v0.7** — Chrome + Firefox from one tagged source state.
6. **D7 and D8 in parallel** with 1–5. They are owner/external actions with
   unknown latency and are the long poles.
7. **G6 deletion path** — migration; must land *before* any Twitch-derived write.
8. **M3D + M3E-a** — one scope request, one consent change; **v0.8**.
9. **M5 → M6 → M7**, gated by §26.9.

**F7 is independent and must not be sequenced against any of this.**

#### One live call to make at the start of M3D/M3E-a

When a scoped token first exists, resolve §26.1.5 items 2 and 3 in a single
session: confirm whether `gifter_login`/`gifter_name` are returned, and confirm
404-means-not-subscribed. **This is the moment the circular-verification problem
in §26.1.4 dissolves.**

---

### 26.11 Owner decisions still required

Superseding §23 where they conflict.

| # | Decision | Status | Recommendation |
|---|---|---|---|
| **D1** | Bits, gifting, hype trains, channel points, ads permanently unmeasurable **by Watchside** | **Confirmed, and reframed** (§26.6) — all are Twitch-internal-observable | ✅ **Accept**, with the §26.6 framing: we prove upstream; Twitch evaluates downstream |
| **D2** | Ship M3C in the next coherent release | **Locked** (§26.5) | ✅ **Yes — v0.7** |
| **D3** | Request `user:read:follows` | **Revised** (§26.4) — was "defer" | ✅ **Yes — v0.8.** H1 protects the data, not the claim |
| **D4** | Request `user:read:subscriptions` / collect `subscribed_at_join` | ⚠️ **REVERSED** (§26.3) — was "recommend no" | ✅ **Yes — v0.8, bundled with D3**, gated on D7+D8. Baseline only; **no custody, no polling** |
| **D5** | Adopt hybrid attribution architecture (§14) | Unchanged | ✅ **Yes** — and it is what makes L9 reproducibility possible |
| **D6** | Per-user Twitch-data deletion path in the first Twitch-touching slice | Unchanged; now **G6** | ✅ **Yes — blocking** |
| **D7** | Legal read of the Twitch DSA | Unchanged; **long pole** | ✅ **Start now** — blocks v0.8 |
| **D8** | AMO clarification: is subscription state `financialAndPaymentInfo`? | Unchanged; **long pole** | ✅ **Start now** — blocks M3E-a only. If it forces a new required category, that is an install-consent decision for the owner, **not automatically a reason to drop the baseline** |
| **D9** | Resolve documentation ambiguities | ✅ **CLOSED** (§26.1) — all three resolved; two corroborated, one inferred and inert | — |
| **D10** | Prioritise repeat-creator viewing in M3C | Unchanged | ✅ **Yes** |
| **D11** | 🆕 Adopt the **roadmap invariant** and the §26.9 launch gates | New | ✅ **Yes** |
| **D12** | 🆕 Accept **focused-tab-only** dwell as deliberate undercounting | New (§26.5 caveat 1) | ✅ **Yes** — the alternative can invent watch time |
| **D13** | 🆕 Keep cohort/arm definitions **externally reproducible** for L9 diligence | New (§26.6) | ✅ **Yes** — costs nothing under D5 |

---

### 26.12 Final recommendation

## **GO** — with the M3E scope corrected

M3B's research conclusions survive. Its **prioritisation did not**, and this
subsection supersedes §25 point 3 and the D3/D4 rows of §23.

1. **D9 is closed.** All three ambiguities resolved. Check User Subscription
   requires a **viewer token with `user:read:subscriptions`** — Option B. There
   is no app-token shortcut, no free path, and no confusion remaining between it
   and Get Broadcaster Subscriptions. The apparent contradictions were
   **extraction artifacts from a JavaScript-rendered page**, not Twitch
   inconsistency. **Documentation-confirmed and library-corroborated; not
   live-verified** — and §26.1.4 shows why live verification is *circular* here
   rather than merely inconvenient.

2. **The owner was right to reject D4, and §23 was wrong for a reason neither of
   us had identified.** M3E was priced as one indivisible expensive thing. It is
   two. The irreversible half — the baseline boolean — needs **no token custody
   and no polling job**, because a `false` baseline plus *any single later check*
   is a valid bounded conversion, and a returning viewer hands us a fresh token
   for free. **Collect `subscribed_at_join`.**

3. **`following_at_join` is upgraded to a next-release requirement.** H1 protects
   the *data*; it does not protect the *claim*. The unfollow/refollow error runs
   in our favour on our most important number, which is the worst possible
   direction for something a partner will scrutinise.

4. **M3C is locked and unblocked.** No new blocker. One genuine design decision
   surfaced — focused-tab-only dwell (D12) — which is the difference between
   measuring viewing and inventing it.

5. **The H3 ceiling is real but far less damaging than §1 implied.** Every
   economic primitive we cannot see, **Twitch can**. Watchside's job is the
   upstream causal claim plus **externally reproducible cohorts** (D13); the
   downstream economics are evaluated with Twitch's own data at diligence. That
   is a better position than trying to buy scopes for data Twitch already owns.

6. **Nothing here disturbs the release position.** Firefox v0.6.0 stays untouched
   at AMO. M3A's views deploy with no Store release at all. v0.7 carries M3C with
   **no consent change**; v0.8 carries M3D + M3E-a as **one** consent change.

**Immediate next action:** execute **M3A**, then **M3C**. Start **D7 and D8 in
parallel today** — they are external, they have unknown latency, and they are the
only things standing between v0.8 and both remaining baselines.
