# Watchside roadmap

Where things stand, and — more usefully — what has already been decided so it
does not get re-decided by accident.

**Last updated:** 2026-09-02, after the M3D + M5C acquisition-coverage pass.

> **Read the state table in "Measurement" and the v0.8 section with the dates in
> mind.** Both were written while M3D was blocked and describe a world that no
> longer exists: the custody decision was taken, M3D shipped, M5A–M5E shipped,
> and Watchside is public on two stores. Corrected in place below; the
> superseded reasoning is kept where it explains why a decision was made, and
> marked where it no longer describes the present.

---

## The core loop

```
Presence  →  Social Gravity  →  JOIN  →  Together
```

Everything below is judged against that, and against two filters:

**A — User experience value.** Does this make Watchside meaningfully better for
the person using it?

**B — Incremental platform value.** Does this plausibly create viewing or
activity that would not otherwise have happened?

Infrastructure, reliability, privacy and safety may be mandatory without scoring
on B. Nothing else gets a free pass.

---

## ACTIVE — Private beta

> ## **Private Beta Day 0: `2026-08-26 20:45:37.549219+00`**

**The hosted `private_beta` analytics baseline began at zero at that instant.**
All 462 development-residue events were deleted, along with the whole
development social graph; `development` analytics (93 events) were preserved.
Every measurement of the beta is "since Day 0", and there is no earlier beta
data to exclude — the environment started empty.

Three auth identities were preserved: `anoterostv` and `wtfchuck27` (owner /
development, both `is_internal` and excluded from beta reporting) and
`ohjuliego` (a real tester, counted in the cohort). The full procedure, the
verified result and the reasoning behind each decision are recorded in
[BETA_DAY_ZERO.md](BETA_DAY_ZERO.md).

Hand-distributed to a connected cohort. See
[private-beta-readiness.md](checkpoints/private-beta-readiness.md).

**Learn → analyse → fix evidence-backed problems.** In that order.

### The learning rule

**Once the cohort begins, normal feature development stops.**

Allowed during the observation window:

- P0 breakage
- serious reliability bugs
- safety or privacy issues
- extremely obvious UX blockers preventing normal use

**Not allowed:** reacting to individual suggestions by building them. Collect
feedback, observe behaviour, analyse after there is enough usage. The point is
to see what people do with the product we have, not to converge on the product
each tester imagined.

A suggestion is data about what somebody wanted in a moment. Three weeks of
behaviour is data about what the product is.

### Round 1 findings, and what happened to each

The first session with two external testers produced ten findings. All of them
are accounted for below and none has been quietly dropped. Full analysis:
[friends-beta-investigation-2026-08-27.md](reports/friends-beta-investigation-2026-08-27.md).

| # | Finding | Disposition |
| --- | --- | --- |
| 1 | Multi-stream behaviour | **NEXT CHECKPOINT** — architecture approved, see below |
| 2 | Own username shown instead of "You" | **FIXED** in Patch 1 |
| 3 | Group visible, could not participate | **UNRESOLVED.** Server-side authorization eliminated by execution; the client failure is now instrumented. Not claimed solved |
| 4 | Every chat username the same colour | **FIXED** in Patch 1 |
| 5 | Large friend list | **TRACKED / GATED** — see Known gaps. No scale work now |
| 6 | Large group chat | **TRACKED / GATED** — no optimisation now |
| 7 | Panel state not shared across Twitch tabs | **FIXED** in Patch 1 |
| 8 | Firefox | **DEFERRED** — audited at MEDIUM, no port started |
| 9 | Group chat lost its bottom anchor | **FIXED** in Patch 1 (proven root cause) |
| 10 | Stream Room messages appeared to disappear | **TEMPORARY RELIEF** in Patch 1; properly fixed by the next checkpoint |

### NOW — Friends Beta Patch 1

Shipped together as one checkpoint. See
[friends-beta-patch-1-2026-08-27.md](reports/friends-beta-patch-1-2026-08-27.md).

- **Realtime teardown and topic hardening.** Channel topics are derived from
  the id set rather than its size, and teardown is serialised per topic so a
  re-subscribe cannot be handed a channel that is still unsubscribing.
  Prerequisite, promoted by the architecture review.
- **jsdom / effect test coverage.** A second Vitest project. No React effect in
  this codebase had ever run inside a test, which is how finding #9 shipped.
- **Failure and realtime telemetry.** `client_error`,
  `realtime_status_changed`, `group_message_send_failed` — fixed vocabularies,
  never a message. **Migration `0024`; not yet applied to hosted.**
- **Group chat autoscroll**, **"You" consistency**, **deterministic username
  colours**, **cross-tab panel synchronisation**.
- **Temporary `sessionAvailable` relief** for finding #10. Explicitly
  throwaway, labelled in the source, guarded by a test.
- **The `ohjuliego` incident remains unresolved and instrumented.**

### NEXT — Multi-destination beta checkpoint

**Approved at the product and architecture level.** Not implemented. Full
design: [multi-stream-room-architecture-2026-08-27.md](reports/multi-stream-room-architecture-2026-08-27.md).

- `public.presence` becomes account **liveness** only
- `presence_destinations` becomes destination truth
- **30-minute ACTIVE window**; at most **3 published destinations**
- **Focus is never published** — it is a client-local concept, and a local
  PRIMARY drives only the viewer's own HERE context
- destination-set activity registry in the worker
- **additive compatibility migration with an old-client shim**, so no
  coordinated release is required
- Gravity consumes every active destination; stale ones contribute nothing
- per-destination Stream Room state, multiple stable room tabs, per-room
  unread, retained-but-closed rooms
- return-to-stream affordance **without adding the `tabs` permission**
- `togetherWatch` becomes channel-keyed; JOIN and arrival analytics adapt to a
  destination set
- **the temporary `sessionAvailable` patch is removed, not extended**
- RLS and authorization tests expanded for `presence_destinations`

**The rules this must not break:** a room stays `(destination, friendship
component)` with no stored room record; per-recipient send-time authorization
stays; unrelated friend components on the same channel stay isolated; blocks
stay on both graph traversal and delivery; no attention score; no
`friends × destinations` realtime binding multiplication.

### LATER

In this order, none of it now:

1. removal of legacy `presence.channel` / `presence.platform`, after every
   tester has upgraded
2. Firefox
3. friend-list realtime scaling
4. group scaling
5. list virtualization
6. analytics dashboard
7. custom realtime infrastructure
8. unrelated feature expansion

---

## Measurement — M3, and the road to public launch

The measurement work is core product infrastructure, not telemetry: the
strategic bet is that Watchside can show it contributes to Twitch consumption,
and that argument is only as good as the evidence recorded while it happened.

### Two permanent principles

> **NO MEANINGFUL PUBLIC GROWTH WHILE A HIGH-STRATEGIC-VALUE H2 MEASUREMENT
> WITH REASONABLE COLLECTION COST IS KNOWINGLY MISSING.**

> **MEASURE OBSERVABLE TWITCH CONSUMPTION FAITHFULLY; PRESERVE DIMENSIONS FOR
> STRICTER ANALYSIS LATER; BE CONSERVATIVE IN CLAIMS RATHER THAN DESTRUCTIVE IN
> COLLECTION.**

The second was adopted in M3C.1 after focused-tab-only dwell was rejected. A
metric made artificially conservative by *discarding* legitimate behaviour
cannot be widened afterwards - the behaviour is simply gone. Collect the
dimensions; argue about the claim in the query, where it can be argued with.

### Canonical dwell definition

> How long Watchside had defensible continuing evidence that one eligible **live**
> Twitch stream was open and observed - **per stream**, not gated on focus, not
> human attention.

Unit: **stream-milliseconds**. Concurrent legitimate streams count
independently: two streams open for an hour are **120 observed stream-minutes**
and **60 wall-clock Twitch-observed minutes**. Never describe summed
stream-minutes as time a person spent watching Twitch.

Focus is a **diagnostic subduration**, not a gate:
`focused_duration_ms + background_duration_ms = duration_ms`.

Full definitions: `docs/ANALYTICS.md` §8b and §14.

### State

| Phase | What | State |
|---|---|---|
| **M3A** | Five reporting views + experiment-arm instrumentation | **DONE.** Views live server-side (schema 31); the arm property ships with v0.7 |
| **M3B** | Economic attribution research, incl. M3B.1 D9 resolution | **CLOSED** |
| **M3C / M3C.1** | Observed **per-stream** dwell, focus/background split, concurrency views, repeat-creator foundation | **IMPLEMENTED AND ACCEPTED**, awaiting v0.7. Zero production rows existed, so the contract was corrected rather than versioned around |
| **D7** | Twitch DSA / policy read | **OPEN** - substantively researched; counsel confirmation outstanding. See `docs/reports/m3d-m3e-policy-gates-2026-08-30.md` |
| **D8** | Mozilla `financialAndPaymentInfo` classification for `subscribed_at_join` | **OPEN - genuinely unresolved.** Mozilla publishes no category-choice guidance; **must ask AMO** |
| **G6 + M3D** | Deletion architecture, `following_at_join` | **SHIPPED.** Custody was approved, the lifecycle built and the deletion path proved before the first credential existed. Migrations 0033–0036; contract in `docs/M3D-MEASUREMENT.md`; acceptance is `npm run verify:m3d`. **Distributed for the first time in v0.8** |
| **M3E-a** | `subscribed_at_join` | **HOLD, unchanged.** No subscription scope is requested and tests assert its absence. Still conditional on **D8** |
| **M3E-b** | Token custody, refresh loop, scheduled polling | **SHIPPED as part of M3D.** The credential is captured at sign-in, stored encrypted with a key held outside the database, and destroyed on de-authorisation or account deletion |
| **M5A–M5E** | Public product pack, delivered as five sub-milestones | **SHIPPED.** Zero-friend loop (M5A), public surface (M5B), **acquisition attribution (M5C)**, product closure (M5D), release convergence (M5E). See the reports of the same names |
| **M5C.1** | Acquisition **coverage** — the denominator M5C shipped without | **SHIPPED 2026-09-02.** Migration 0040. §"Acquisition coverage" below |

### The M3D blocker - corrected 2026-08-30, refined 2026-08-31

The earlier entries above described G6 + M3D as needing **no token vault**, and
M3E-b as a precision layer that "buys a tighter conversion window, not the
measurement itself". **Both statements were wrong**, and the implementation
checkpoint that tried to build M3D is what exposed them.

`Get Followed Channels` requires a **user** access token - there is no
app-token path. Supabase emits the Twitch `provider_token` **once, immediately
after sign-in**, and *"Supabase Auth does not manage refreshing the provider
token for the user"*. Watchside's session is refreshed indefinitely; the provider
token is not, and cannot be reissued. A JOIN happens hours or days after sign-in,
with no token available.

**Refined by O3 on 2026-08-31.** A live sign-in proved `provider_refresh_token`
**is** delivered by the real flow - so a refreshable credential does exist, and
the paragraph above is precise only about the *window*: both provider fields are
present at sign-in and persist until the **first** session refresh, after which
they are gone permanently. M3D is therefore feasible **if** the credential is
captured at sign-in and held server-side. That is custody, and it is an owner
decision (**O1**) rather than an architectural dead end.

**O1 answered 2026-08-31: YES IN PRINCIPLE.** The credential lifecycle is now
designed - capture, encryption, rotation, revocation, scope loss, relationship
deletion, account deletion and destruction - and the architecture verdict is
**GO** subject to three conditions: close the EventSub payload unknown, decide
what account deletion does to that user's analytics, and ship the whole
lifecycle as one atomic milestone with deletion built and proven **before** the
first credential exists. See §58-§90 of
`docs/reports/g6-m3d-creator-discovery-2026-08-30.md`.

**No credential may be stored until that architecture is explicitly approved.**

The M3B and M3D/M3E research reports both asserted the token would be "in hand
in-session" at the JOIN. That conflated the **Supabase session** (long-lived)
with the **provider token** (one-shot). Nothing had yet tried to obtain a token
at JOIN time, so the error survived two research checkpoints and was caught at
the first implementation attempt - before any write, migration or release.

Consequence: **M3D and M3E-a are both gated on provider-token custody**, which is
what M3E-b is. Deferring custody means deferring relationship measurement
entirely; it is a legitimate choice, but it is now an explicit trade rather than
a free one.

### Two findings that constrain everything downstream

**Aggregation is not an exit from Twitch's terms.** The DSA's change-of-control
clause requires Twitch's prior written permission before an acquirer may process
Twitch Data *"including any insights or aggregated information derived from such
data"*. Any plan that assumes "we will just aggregate it" is wrong.

**The hybrid architecture is load-bearing twice over.** It was adopted so
Twitch-derived data could be deleted on de-authorization without destroying
Watchside-owned analytics. It turns out to also be what keeps the majority of
the strategic evidence - exposure, JOIN, arrival, **observed stream dwell**,
repeat viewing, randomised lift - **outside Twitch's data terms entirely**,
because those are Watchside observing its own product rather than reading
Twitch's API. Keep Twitch-derived data minimal, separable and small.

---

### Acquisition coverage - the denominator M5C shipped without

M5C answered "which campaign brought this account". It did not answer **"how
often do we know that at all"**, and the difference is what makes campaign
numbers mean something.

All three M5C views start from `acquisition_attribution`, so every number they
produce is conditioned on attribution existing. `acquisition_campaign_v` reads
identically whether campaigns brought most of Watchside's users or almost none
of them: the rows are well-formed, the rates are correct, the suppression works,
and the picture can still be completely unrepresentative. **That is not a
miscalculation - it is a missing denominator**, and no test of any single view
could see it.

M3D had already learned this lesson. `m3d_coverage_v` exists so relationship
numbers can be read against how much of the population they cover, and 0034
states the rule outright: *defining a denominator by the outcome makes coverage
tautologically 100%*. M5C shipped without the equivalent; **0040 adds it**.

**`acquisition_coverage_v`** - attributed vs unattributed actors over the real
arrival population, grouped by the build each actor was first seen on. That
grain is load-bearing: the acquisition parameter is read only by builds carrying
M5C and **there is no backfill**, so every account created earlier is
permanently unattributable. Without the split, a working campaign looks like it
is missing most of its arrivals.

**`acquisition_touch_outcomes_v`** - closes a blind spot in 0038.
`bind_acquisition` has four outcomes and recorded two: `unknown` and `inactive`
returned to the caller and wrote nothing. So a campaign link resolving to no
registry row - mistyped on a poster, retired while links still circulated,
forged - was discarded in silence, and **"that campaign brought nobody" was the
conclusion whether the campaign failed or its instrumentation did.** Refusals
are now recorded, without the code.

**Deliberately not built: a "direct" bucket.** Watchside cannot distinguish
somebody who typed the Store URL from somebody who followed a campaign link
whose touch expired. Both are unattributed, calling either "direct" would invent
a fact about people, and the column does not exist for a dashboard to pick up by
mistake.

---

## The road to public launch

```
M3C.1 accepted
      ├── D7 (counsel)  ── in parallel ──┐
      ├── D8 (ask AMO)  ── in parallel ──┤
      ▼                                  │
    v0.7   NO consent change             │
      ▼                                  ▼
    v0.8   ONE consent change, no token vault
      ▼
    M4.5   architecture/legacy audit + docs/FEATURES.md
      ▼
    M5     public product pack + watchside.app migration
      ▼
  Store Assets
      ▼
    M6     public release candidate
      ▼
    M7     PUBLIC LAUNCH   (gated by the G1-G9 checks in
                            m3b-twitch-economic-attribution-2026-08-30.md §26.9)

  F7  Firefox signed-build acceptance - INDEPENDENT, whenever Mozilla
      approves the pending v0.6 submission. Does not block development.
      NOT the same as v0.7 RC acceptance: F7 tests the SIGNED v0.6 artifact
      from AMO; the v0.7 checklist tests an UNSIGNED v0.7 package locally.
```

### v0.9 - LAUNCH ACTIVATION: the five P0 items, complete

The cold-start audit found the social machinery substantially built and the
FIRST EDGE unreliable. v0.9 repaired it. Scope was frozen to five items and
stayed frozen.

| | What | State |
|---|---|---|
| **P0-1** | Invite page offers Firefox as well as Chrome | **SHIPPED AND LIVE** - website only, no release |
| **P0-2** | Pending invite persisted across worker eviction | **DONE** - in v0.9 |
| **P0-3** | Canonical `watchside.app/i/` invite minting | **DONE** - in v0.9 |
| **P0-4** | Rate budget on `search_users` | **DONE** - migration 0041, **not yet applied to production** |
| **P0-5** | Zero-friend activation denominator | **DONE** - migration 0042, **not yet applied to production** |

**P0-1 was the urgent one and needed no release.** Every invite in circulation
pointed at a page offering Chrome alone, while Firefox was the only build a
person could actually install - a dead end on the single path a stranger with
no Watchside friends has to a first connection. Fixed and deployed
independently; all three invite surfaces (canonical, legacy, and the
pre-rename path) now serve both browsers.

**Mutual Friend Suggestions were not touched.** They shipped in v0.8, they
correctly return nothing for a zero-friend user, and that is network
formation working rather than a defect.

**"People you know already use Watchside" was not built.** Twitch exposes no
viewer-to-viewer social graph, and shared creator follows are not acquaintance.

---

### The M7 launch gates - current standing

**G5 is SATISFIED by explicit owner decision, 2026-09-02.**

> **`subscribed_at_join` is DEFERRED.** The owner accepts the permanent
> historical loss, for socially attributed JOINs occurring during the deferral
> window, of whether the viewer was already subscribed to that creator at the
> moment of JOIN. Conversions occurring in that gap may likewise be permanently
> unrecoverable.

G5 was always satisfiable *"by a decision rather than by delivery - the invariant
demands that the loss be chosen and recorded, not that it never happen."* It has
now been chosen and recorded. Accepted because the loss is **per-JOIN and
time-bounded rather than a whole acquisition cohort**; production volume is
currently near zero; the metric is potentially misleading at small scale; Prime
and paid Tier 1 are indistinguishable in the relevant API result; and shipping it
would need a second Twitch scope, reauthorization for every existing user, and
possibly a fresh Firefox consent - activation friction that is least affordable
immediately before public launch. **M3D's `followed_at_join` already provides the
more important early-stage baseline**: whether socially initiated viewing reaches
creators outside an existing follow relationship.

**Revisit at ~1,000 MAU with a measurable social JOIN rate, or when a credible
randomised-lift measurement becomes viable. Resolve D8 before implementing.**

Full analysis: `docs/reports/g5-subscribed-at-join-decision-2026-09-02.md`
(`71270bb`).

**The existing assertions prohibiting subscription and purchase measurement stay
exactly as they are.** Eight of them, across six test files. They are the
mechanism that keeps this decision true, not an obstacle to it.

| Gate | Standing |
|---|---|
| **G1** dwell confirmed emitting in production | **OPEN - needs real production observations, not implementation.** Possible for the first time now that v0.8 is distributed |
| **G2** repeat-creator analysis | follows G1 |
| **G3** `experiment_arm` on `authenticated_session_started` | **SATISFIED** - shipped in v0.7 |
| **G4** `following_at_join` | **SATISFIED by delivery** - M3D |
| **G5** `subscribed_at_join` | **SATISFIED by recorded decision** - above |
| **G6** deletion path before any Twitch-derived write | **SATISFIED** |
| **G7** D7 legal read of the Twitch DSA | **OPEN - counsel.** Note: recorded as blocking for M3D/M3E-a, and M3D shipped while it was open. That inconsistency predates this pass and should be closed deliberately |
| **G8** D8 AMO `financialAndPaymentInfo` clarification | **RETIRED / NON-BLOCKING for M7** while M3E-a is deferred. D8 asks how to *declare* data Watchside has now chosen not to collect; there is nothing to declare. It returns if and only if `subscribed_at_join` is revisited |
| **G9** privacy policy updated for every shipped measurement | **SATISFIED** - accuracy pass, `5d3b65b` |

**M7 is therefore blocked by G1 (data, not work) and G7 (counsel)** - plus the
cold-start question below, which is a product judgement rather than a gate.

### v0.7.0 - RELEASE CANDIDATE / PACKAGED / NOT SUBMITTED

**Cut 2026-08-30.** See
`docs/reports/v0.7.0-release-candidate-2026-08-30.md`.

Contents:

- experiment-arm instrumentation (production randomisation only)
- corrected **observed per-stream dwell**
- focused / background diagnostic subdurations
- repeat-creator measurement foundation
- **no Twitch OAuth scope change**, no new Firefox data category

**Not blocked by D7 or D8.**

#### Release state - do not read past what is written here

| State | Chrome | Firefox |
|---|---|---|
| development HEAD | v0.7.0 source | v0.7.0 source |
| release candidate | **v0.7.0** | **v0.7.0** |
| packaged artifact | `Watchside-Store-v0.7.0.zip` | `Watchside-AMO-Candidate-v0.7.0.zip` + source archive |
| **submitted** | **v0.6.0 - UNCHANGED** | **v0.6.0 r2 - UNCHANGED, awaiting Mozilla** |
| **published** | **v0.6.0 - LIVE** | **not assumed** - whatever AMO's actual state is |
| installed by testers | unknown - publication does not prove propagation | unknown |

**v0.7.0 is NOT live and NOT submitted.** A package is not a submission; a
submission is not publication.

⚠️ **Firefox v0.7 must wait for Mozilla to finish with v0.6.** Uploading it
while v0.6 is in review would replace the pending submission.

Tagging is **deferred**: the repository has no git tags, so there is no
established convention, and one was not invented.

### v0.8 - relationship measurement, SHIPPED

**Firefox 0.8.0 is approved and public on AMO. Chrome 0.8.0 is submitted and in
review.** v0.8 carries M3D, M5A–M5E and the compatibility work, verified marker
by marker by `npm run verify:candidate`.

**What actually happened**, against the blocked plan recorded below: the custody
decision (**O1**) was taken, the credential lifecycle was built with deletion
proved *before* the first credential existed, and M3D shipped. `subscribed_at_join`
(M3E-a) was **not** shipped and remains on hold, so the OAuth change was
`user:read:follows` alone — one scope, not two — and no financial declaration was
ever needed.

**The measurement systems are only now observing anybody.** M3D and M5C were both
written, accepted and released before any build carrying them was distributed;
Firefox 0.8 going public is the first time either has seen a real user. Numbers
from them should be read as early and thin rather than as findings.

*The blocked plan is kept below because it records why custody was treated as a
decision rather than a task. It no longer describes the present.*

- **G6 deletion architecture** - must land *before* the first Twitch-derived
  write, and its shape **depends on the custody decision**: with custody,
  revocation must also shred the stored refresh token, which is a different
  security posture rather than an extension of the same one. Building it now
  would build the wrong G6
- `following_at_join` (M3D) - **blocked**, see above
- `subscribed_at_join` (M3E-a) - blocked by the same constraint, **and**
  conditional on D8
- **ONE** Twitch OAuth authorization change: `user:read:follows` +
  `user:read:subscriptions` - not made
- **no provider-token vault** - *this is the constraint that blocks the release*

Do not guess a financial declaration, and do not request a scope that is not yet
used.

**RESOLVED 2026-08-31 - outcome A.** A real Watchside Twitch sign-in confirmed
that `provider_refresh_token` **is** delivered, non-null, by the actual flow. So
M3D is *technically* feasible; it is blocked by a **policy decision**, not by the
architecture. See §38-§47 of
`docs/reports/g6-m3d-creator-discovery-2026-08-30.md`.

The credential does **not** survive the first Supabase session refresh, so it
would have to be captured at sign-in and stored server-side - which is custody,
and remains unapproved. §44 of that report lists the twelve requirements custody
would commit us to before a single token is stored.

**Also found, and NOT gated on the custody decision - now FIXED (O7, `6740af4`).**
Watchside was persisting a live Twitch access token and refresh token to
`chrome.storage.local` on every sign-in, as an unintended side effect of
`persistSession: true`. It was invisible in Watchside's own source because the
write happened inside supabase-js - a test asserting that no Watchside file
mentioned `provider_token` passed the entire time.

The Supabase storage adapter now strips both provider fields before writing, so
the credential is never persisted rather than persisted and deleted; a session
left by an earlier sign-in is purged on first read. Supabase's own tokens are
untouched and sign-in behaviour is unchanged. See §48-§57 of
`docs/reports/g6-m3d-creator-discovery-2026-08-30.md`.

### Pre-public hardening - ACCOUNT DELETION (COMMITTED)

**Committed pre-public-launch requirement. Not started. Independent of M3D.**

Watchside has **no user-triggerable account-deletion path** - no UI, no RPC, no
function. 24 tables carry `references public.users (id) on delete cascade`, so
the cascade is correct and complete, but **nothing lets a user trigger it**. The
only way an account is deleted today is somebody removing a `public.users` row by
hand.

This was previously filed as an M5 UX item. **That was the wrong milestone.** It
is a hardening requirement and it blocks public launch:

- Watchside holds user-owned persisted data across 24 user-scoped tables
- shipping a public product with no way for a user to delete any of it is a
  GDPR/CCPA exposure regardless of anything Twitch requires
- if O1 is ever approved, account deletion also has to destroy a stored Twitch
  credential - so the delete path wants to exist **before** there is one to
  destroy, not after

Not conditional on M3D, on custody, or on D7/D8. If relationship measurement is
deferred indefinitely, this is still required.

**Scope when it is built:** a user-triggerable deletion that removes the account
and everything cascading from it, destroys any stored provider credential, and
is verifiable by test. Deletion semantics for relationship observations are
already designed (§6-§10 of the G6/M3D report) and must be honoured if they exist
by then.

### M4.5 - architecture, legacy and feature audit

**Committed pre-M5 milestone. Not started.** Purpose: enter public-product
hardening with a coherent codebase and an authoritative account of what
Watchside actually exposes to users.

Audit and classify (**KEEP** / **REMOVE** / **CONSOLIDATE** / **RENAME** /
**DEFER**): Kickback→Watchside legacy references · compatibility-sensitive
`kickback:*` identifiers · `kickback_invite` · salts · badge keys · DB names ·
`kb-` CSS · historical docs and migrations · obsolete human-facing branding ·
stale brand assets · old URLs · **old single-destination assumptions** ·
superseded Gravity and Stream Room paths · duplicate presence/cache/invalidation
architecture · stale analytics assumptions · **abandoned focused-only dwell
assumptions** · Chromium/Firefox adapter leakage · obsolete beta flags and
scaffolding · dead code, files, scripts and assets · unused dependencies ·
TODO/FIXME/HACK inventory · stale tests and fixtures.

**Do NOT indiscriminately rename compatibility-sensitive identifiers.** Some are
effectively immutable, and the audit must say why rather than rename them:

| Identifier | Why it is held |
|---|---|
| `kickback:*` storage keys | Renaming orphans live state on every installed client - open dwell intervals, sessions, attributions, layout |
| `SALT = 'kickback:social-gravity:v1'` | Changing it **re-randomises every user's experiment arm** and destroys longitudinal comparability |
| `KB-` friend-code prefix | Enforced by a DB `CHECK` constraint; existing codes are shared with real people |
| `kickback-host`, `kb-` CSS | A full-surface CSS migration with visual-regression risk and no user benefit |
| `kickback-background.js`, `kickback-content` | Named in both manifests; a packaging change |
| Migration comments 0001-0027 | History. 0028 already recorded that rewriting them would falsify the record |

**Exit criterion:** every remaining Kickback reference is provably either
compatibility/history-sensitive **or** scheduled for removal/rename, with the
reason recorded.

### M4.5 - docs/FEATURES.md

**Does not exist yet.** M4.5 must create and maintain it as the authoritative
user-facing feature inventory and how-to.

Per feature: name · product purpose · implementation status · first release
version · currently released platforms · **exact UI entry point** · literal user
flow · visibility conditions · empty state · backend dependency · relevant
analytics · known UX limitation.

Lifecycle states: `PLANNED` · `IMPLEMENTED` · `USER-FACING` · `RELEASED` ·
`VERIFIED`.

> **Nothing is "shipped" because backend infrastructure exists.**

Must cover at minimum: Twitch authentication · Friends · Friend Requests ·
Suggested Friends · Invite Friends · referral attribution · referral milestones ·
referral badges · presence · multi-destination presence · Social Gravity · JOIN ·
Stream Rooms · room chat · emotes · reactions · combos · Groups · group chat ·
notifications · blocking · muting · privacy controls · feedback · Twitch
metadata · analytics-visible product behaviour · Chrome support · Firefox
support.

**Suggested Friends, referrals and badges** additionally need a discoverability
verdict: `DISCOVERABLE` · `DISCOVERABLE BUT WEAK` · `CONDITIONAL / INVISIBLE
WHEN EMPTY` · `BURIED` · `INFRASTRUCTURE ONLY` · `BROKEN / UNREACHABLE`. All
three have substantial server-side implementation in `0026_growth_loop.sql`
whose user-facing surface has never been audited against it - which is exactly
the failure mode this inventory exists to catch.

> **Permanent invariant: a feature is not user-facing complete unless we can
> explain where a user encounters it and how they use it.**

### M5 - public product pack

New-user onboarding · **zero-friend experience** · Suggested Friends
discoverability · Invite Friends discoverability · referral UX · badge and
milestone discoverability · empty states · failure and recovery states ·
privacy/trust presentation · **branded public-domain migration** · full
referral-flow acceptance.

M4.5's inventory is the input to M5's design, which is why it is sequenced
first.

### watchside.app - canonical public domain, LOCKED

The owner has reserved **`watchside.app`**. It is the canonical public Watchside
domain. Target URLs:

```
https://watchside.app/
https://watchside.app/i/<referral-code>
https://watchside.app/privacy
https://watchside.app/support
```

**Existing `https://anoteros-labs.github.io/watchside/…` URLs must keep
working.** They appear in a published privacy policy, in both Store listings,
and in invite links already shared with real testers. Current GitHub Pages
hosting may remain underneath the custom domain.

**Migrated in M5, not before.** The migration must cover: GitHub Pages
custom-domain configuration · domain ownership verification · DNS · HTTPS ·
canonical URLs · referral-link generation · old-link compatibility ·
**invite → install → auth → referral attribution verified end to end** · Chrome
listing URLs · Firefox listing URLs.

The current long GitHub Pages referral URLs are accepted **beta-era
compatibility URLs**, not the intended public presentation.

### Store assets

**After** major M3/M5 product and UI work settles - not now. Requirements:
intentional seeded/demo states · capture automated with the two-actor E2E
harness where practical · polished Chrome Store screenshots and assets ·
source captures reused/adapted for AMO · **no stale Kickback branding** · Chrome
and Firefox listings telling the same product story · branded `watchside.app`
URLs.

---

## Decided, and not to be re-opened without new evidence

### Distribution — **CHROME WEB STORE, PRIVATE**

Preferred over hand-distributed ZIPs. Not for convenience: it gives real update
delivery, controlled access, and a stable install destination that invites can
eventually point at.

- **Visibility: Private**, via a Google Group. Every tester needs a Google
  account and must be signed into Chrome with it.
- **The ZIP remains** as the fallback and as the local packaged-build test
  artifact. `npm run package:beta` is unchanged.
- **Store packaging is separate** — `npm run package:store`. The store requires
  `manifest.json` at the root of the archive and mints its own extension ID, so
  the store package is flat and carries no manifest `key`.
- **The extension ID is the store's, and is now adopted.**
  `ngfopkeokddfnncdhfkhnffilbdhkkip` — the item's own identity, copied from
  its Package tab into the manifest, so a sideloaded build and the published one
  are the same extension. Nothing in `src/` reads the ID; the redirect comes
  from `chrome.identity.getRedirectURL()` at runtime. **One hosted action
  remains: add `https://ngfopkeokddfnncdhfkhnffilbdhkkip.chromiumapp.org/`
  to Supabase's redirect allow-list.**
- **No CI/CD.** Two commands and a browser upload, for 20 people.
- **No rollback exists.** The only remedy for a bad release is a higher version.

See [chrome-web-store-private-beta-readiness.md](checkpoints/chrome-web-store-private-beta-readiness.md).

### Privacy policy — **PUBLISHED**

[PRIVACY.md](PRIVACY.md) is the source, written against the implementation
rather than from a template. It is published at
`https://anoteros-labs.github.io/kickback/privacy/`, with a support page
alongside it, from the **public** `Anoteros-Labs/anoteros-labs.github.io`
repository.

**This repository stays private.** The public site carries the rendered policy
and support page only — no source, no checkpoints, no architecture or analytics
documentation, and none of this repository's git history.

### Feedback — **SHIPPED**

In-product, in the account panel. Four categories, a text box, and diagnostics
the service worker assembles.

Treat it as a **durable product capability, not beta scaffolding.** Any product
with users benefits from a way for them to say why; there is no plan to remove
it after the beta.

### Social Gravity / pre-JOIN signal — **ALREADY IMPLEMENTED**

Not future work. Do not list it as unbuilt. Future work here is
**optimisation**, not construction.

### Cold start — **NOT SOLVED, and knowingly so**

The hand-distributed connected cohort bypasses organic cold start entirely:
testers receive the ZIP from the developer and already know each other's Twitch
usernames.

**Therefore a successful private beta validates the core social loop, not
organic acquisition.** Do not let a good beta result be read as evidence that a
stranger can find their way in — that has not been tested and will not be.

### Invites — **BUILT.** Discoverability unaudited

**Superseded 2026-08-30 by the M3D/M3E policy-gate roadmap sync.** The condition
this entry set - "revisit the day Watchside is listed" - was met when Chrome
v0.6.0 went live, and the work was done: `invite_codes` and `claim_invite` in
`0026_growth_loop.sql`, referral attribution with a four-condition success rule,
the `invite_link_created` / `_shared` / `invite_claimed` events, an invite
landing page in `docs/web/invite-landing/`, and `InviteFriends` in
`src/ui/components/GrowFriends.tsx`.

**What is NOT established is whether a user can find any of it.** That is an
M4.5 question (`docs/FEATURES.md` discoverability verdict) and an M5 design
task, not a build task.

### Suggested Friends — **BUILT.** Discoverability unaudited

**Superseded 2026-08-30 by the M3D/M3E policy-gate roadmap sync.** This entry
said "not implemented, verified against the repository", and that is no longer
true: `suggest_friends()` exists in `0026_growth_loop.sql`, is wired through
`src/background/index.ts`, surfaces as `FriendSuggestions` in
`src/ui/components/GrowFriends.tsx`, and emits
`friend_suggestion_impression` / `_add_clicked` / `_request_created`.

The original reasoning still stands as a *caution about value*, not about
existence: in a dense cluster, friend-of-friend suggestions surface people
already added, and they cannot introduce you to somebody who has not installed
anything. Whether the feature earns its place is a **beta-evidence** question -
and M3A's `analytics_growth_funnel_v` is now the instrument for answering it.

**Discoverability is unaudited**; see M4.5 and `docs/FEATURES.md`.

> This entry going stale is the clearest argument for the FEATURES.md invariant:
> the roadmap asserted something was unbuilt while it was shipping in
> production. A feature inventory that is checked is the fix.

### Analytics dashboard — **DEFER**

[BETA_ANALYSIS.md](BETA_ANALYSIS.md) — SQL-first — is the active strategy.

Build a dashboard only when repeated real analysis demonstrates one would
materially improve the workflow. Pretty charts are not the bottleneck;
trustworthy answers are, and those exist.

### Pre-JOIN activity / combo signal — **CORRECTION, then future experiment**

**The correction, because it is easy to get wrong:** combo activity is drawn
only on the HERE card — the destination the viewer is already on — and HERE is
never a JOIN opportunity. So current combo analytics **cannot** measure
combo-driven JOIN lift, and must never be presented as if they do.

**Preserved as a future experiment:** privacy-safe aggregate activity on a
*joinable* destination, and whether showing it changes JOIN probability. That is
a change to what Social Gravity draws, and it is not implemented now.

### Rooms / contextual sessions — **do not assume they are the product**

Substantial investment does not entitle a feature to succeed. The beta may
validly conclude:

- Gravity strong, sessions weak → Watchside is a **discovery** product
- sessions strong, Gravity weak → Watchside is a **communication** product
- both, or neither

All four are real answers. **Discovery value and communication value are kept
analytically separate** in BETA_ANALYSIS.md (§3–6 versus §7) precisely so one
cannot be quietly read as evidence for the other.

### Twitch-native rail — **AUDITED / DEFERRED**

See [twitch-native-surface.md](architecture/twitch-native-surface.md). Feasible;
no blocker found; the overlay strategy makes chat preservation a non-problem.

**Floating remains first-class permanently** — a tester specifically valued
positioning Watchside over Twitch chat. Observe feedback before implementing.

### Browser support — **Chromium-first**

Chrome is primary through core-loop validation. Edge and Brave can be tested
opportunistically since they share Chromium.

**Firefox comes after** initial core-loop validation, and after shell, auth and
presence behaviour are stable enough that compatibility work will not compete
with product learning.

### Multi-platform — **after Twitch core-loop validation**

Strategically important. Potential future: Twitch + YouTube + Kick.

**Before implementing a second platform, do a platform abstraction audit** —
identify the seams for:

- presence
- destination identity
- metadata and live status
- navigation / JOIN
- viewer identity
- content-script mounting
- auth
- emotes
- analytics destination and platform dimensions

**Do not prematurely rewrite existing Twitch code.** Then prototype exactly one
additional platform before generalising.

The strategic purpose is not feature count. It is to test whether Watchside can
become a cross-platform social layer, and whether that creates strategic
interest among platforms.

### Monetisation — **not during the beta**

Optional Ko-fi/Patreon-style support may eventually exist. Recorded explicitly:

> **DONATIONS ARE NOT THE MONETISATION THESIS.**

Future monetisation must be evaluated against demonstrated Watchside value, not
assumed. Open questions, none of them answered: consumer willingness to pay,
creator value, platform value, B2B, cross-platform strategic value.

**The beta's job is to reveal what users and platforms would actually value.**

---

## Known gaps, carried forward

| Gap | Impact |
| --- | --- |
| Exposure → JOIN is matched on a time window, not a minted id | The central claim is correlational, not causal. Say "followed by", never "caused" |
| No experiment holdout in beta | Everyone is in the `gravity` arm. Nothing from the beta is a causal claim |
| No generic Twitch watch time | Only shared-watch duration and post-social retention on attributed destinations |
| **Incremental Social Watch Hours does not exist** | Do not quote it. The nearest honest proxy is attributed-arrival dwell |
| Empty state does not sell the value proposition | Matters for organic installs, not for a hand-delivered cohort |
| Developer mode required to install | Solved by Chrome Web Store distribution; the ZIP fallback still needs it |
| **Realtime presence is one binding per friend** | Linear and unavoidable in the current design. Expected to break somewhere between 100 and 250 friends, silently. Unchanged by the multi-destination work |
| **`broadcast()` is undebounced** | Every state change serialises the full snapshot to every tab. Fine at three testers; the first thing to bite at scale |
| **Tab switch and stream navigation are indistinguishable to the backend** | The user experiences them as very different actions; presence treats them identically. The multi-destination model makes closing a tab the stronger signal |
| **The `ohjuliego` group incident has no known cause** | Server-side authorization was eliminated by execution. Telemetry now exists to catch a recurrence. Do not mark it solved without evidence |
| `https://cdn.7tv.app/*` host permission is probably unnecessary | Emote images are `<img>` loads, which do not need one - `static-cdn.jtvnw.net` is the proof, used the same way with no permission. Not removed before submission because the failure mode is silent; permissions can be reduced later without user re-consent |
| Account deletion is a manual email request | Correct and complete, but not self-service. Fine for this cohort, a real gap before public launch |
