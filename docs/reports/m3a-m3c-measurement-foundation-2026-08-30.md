# M3A + M3C — Measurement foundation and channel dwell

**Date:** 2026-08-30
**Type:** IMPLEMENTATION checkpoint
**Starting commit:** `bfdbd39` · branch `main` · tree clean
**Predecessors:** `docs/reports/m3-twitch-intelligence-design-2026-08-30.md`,
`docs/reports/m3b-twitch-economic-attribution-2026-08-30.md` (incl. §26 M3B.1)

---

## 1. Executive verdict

## **GO**

M3A slices 1–5 and M3C channel dwell are implemented, tested, applied to the
hosted database, and disclosed. Every hard boundary in the brief held: **no
Twitch OAuth scope was added, no provider token is captured or persisted, no
Twitch-derived relationship data is collected, and Firefox's declared data
categories are unchanged.**

Five things worth the owner's attention:

- **Migration numbering was clear.** `0029` and `0030` were both free (highest
  existing was `0028`). No conflict, no renumbering.
- **The focused-tab invariant is structural, not a check.** Dwell is fed
  `liveWatchChannel()` — the primary destination from the activity registry,
  narrowed to live streams — and the machine holds one interval. There is
  nowhere to put a second one, so background tabs cannot accrue even if
  somebody later forgets the rule.
- **A real bug was caught by the existing bundle test, not by me.** My first
  version of the views broke `apply_all.sql` re-runnability: 0014 could no
  longer drop `analytics_sessions_v` because a new view depended on it. Fixed
  properly (§17.3) rather than worked around.
- **The mutation harnesses got materially better.** `test:analytics` went from
  34/87 undetected at HEAD to **18/87**; `test:presence` from 9/21 to **4/21**.
  Nothing regressed anywhere.
- **⚠ Part H could not be completed, and I stopped rather than improvise.** The
  private-beta snapshot needs owner-level reads of views that are deliberately
  revoked from every client role, and no service-role credential or SQL path
  exists in this environment. §24 contains the exact SQL to paste. **This is
  the one deliverable not finished.**

**M3C ships no data until a Store release.** The views are live now; dwell
collection begins with the first production build carrying this code (§25).

---

## 2. Starting repository and release state

| | |
|---|---|
| Commit at start | `bfdbd39`, tree clean |
| Chrome | v0.6.0 **live**; `main` is ahead |
| Firefox | v0.6.0 **submitted to AMO, awaiting Mozilla — untouched** |
| Highest migration | `0028_watchside_copy.sql` |
| `analytics_schema_version()` | 28 |
| Hosted views | 7 (feedback + 6 analytics) |

Nothing in this checkpoint bumped a package version, built a Store artifact, or
touched the pending Firefox submission.

---

## 3. Locked owner decisions applied

| Decision | How it shows up here |
|---|---|
| **D1** H3 economic ceiling accepted, framed as upstream-only | No economic collection attempted; §31 keeps M3D/M3E-a scoped |
| **D2** dwell belongs in v0.7 | Implemented; ships with the next cross-browser release |
| **D3** `user:read:follows` in M3D, **not here** | Guarded by test — §21.4 |
| **D4** `subscribed_at_join` preserved for M3E-a, **not here** | Same guard |
| **D5** hybrid attribution architecture when Twitch data arrives | **Not built** — correctly not required by M3A/M3C (§13.4) |
| **D6** per-user Twitch deletion path before first Twitch write | **Not built** — nothing Twitch-derived is written (§13.4) |
| **D7/D8** DSA and AMO gates | Untouched; still open for M3D/M3E-a |
| **D10** repeat-creator viewing from dwell | `analytics_creator_repeat_v` (§15) |
| **D11** invariant: no growth while a cheap H2 measurement is missing | Dwell is the H2 measurement; now closed |
| **D12** dwell is **focused-tab only** | §10 — structural |
| **D13** externally reproducible definitions | `docs/ANALYTICS.md` §14 (§16) |

---

## 4. M3A Slice 1 — Gravity exposure → JOIN

**View:** `analytics_gravity_conversion_v` (migration 0029).
**New collection: none.** Both sides already carry `opportunity_key`.

**Grain:** one row per (viewer, opportunity), where an opportunity is
`gravity:{channel}:{floor(now/30s)}` — computed by the same function on the
impression and the JOIN, so the two cannot disagree about what one gathering
was.

| Column | Meaning |
|---|---|
| `opportunity_key`, `actor_id`, `environment`, `app_version` | identity and dimensions |
| `destination_channel` | the creator |
| `first_shown_at` / `last_shown_at` / `impression_count` | exposure |
| `friend_count_peak` | the most people the card ever showed |
| `best_rank` | best position it appeared at (1 = top) |
| `shown_live` | whether Twitch said it was live when shown; **null when never known** |
| `join_count`, `converted`, `first_join_at`, `time_to_first_join` | the outcome |
| `navigated`, `social_count` | JOIN detail |

- **Denominator** — rows. **Numerator** — rows where `converted`.
- **Excludes** JOINs from other surfaces, and pre-Gravity impressions with no
  opportunity key.
- **Class: observational conversion. Not lift.** No control group exists in
  this view, and no column is named as if one did.

**Stale documentation corrected.** `docs/ANALYTICS.md` §8a said
`opportunity_key` was "not set by anything yet" and §11a listed Social
Amplification as blocked on it. Both were false — `analyticsHub.ts:525` and
`:646` have been setting it. Fixed.

---

## 5. M3A Slice 2 — Growth funnel

**View:** `analytics_growth_funnel_v`. **New collection: none.**

**Grain:** one row per inviter.

`invites_created` → `invites_shared` → `claims_attributed` →
`friendships_formed` → `invitees_activated` → `referrals_succeeded`.

Outcome stages come from **server state** (`public.referrals`), stamped by
SECURITY DEFINER functions from server facts, so they cannot be inflated by a
modified client. 0026's definition of a successful referral is reused, not
re-litigated.

**There is no install stage, and the absence is the point.**
`analytics_events.actor_id` is `auth.uid()`, so no event can exist before
sign-in — invite → install → auth is structurally unmeasurable. A zero column
would read as "nobody installed" rather than "we cannot see this", so the
column is absent and the migration says why.

**Known limitation:** `referrals` has no environment column, so outcome counts
span environments. Documented in the view.

---

## 6. M3A Slice 3 — Graph-size cohorts

**View:** `analytics_graph_cohort_v`. **New collection: none.**

**Grain:** one row per authenticated session — deliberately, because
`friend_count` is recorded at each sign-in. A user who grew from 2 to 11
friends contributes to both cohorts *at the time each was true*, which avoids
the usual error of relabelling somebody's whole history by today's count.

**Buckets:** `0` · `1` · `2` · `3-4` · `5-9` · `10+`. The low boundaries are a
product discontinuity (Gravity needs `GRAVITY_THRESHOLD` friends on one channel
to render a cluster at all), not an arbitrary cut.

Outcome columns come from `analytics_sessions_v` so "had a JOIN" has one
definition: `had_gathering_impression`, `had_join_click`, `had_join_arrival`,
`had_watching_together`, `session_observed_duration`.

**Class: observational.** No column is named as if friend count causes
activation, and the migration states the confound explicitly — users with ten
friends are not users with two plus eight.

---

## 7. M3A Slice 4 — Watchside return

**View:** `analytics_return_v`. **New collection: none.**

**Grain:** one row per (actor, environment, active day).
Columns: `returned_within_1d` / `_7d` / `_30d`, plus `had_social_interaction`
(a `join_arrived` or `watching_together_started` that day) and
`had_observed_viewing`.

**⚠ Named to prevent the overstatement.** Every row requires the extension
installed, signed in and running. Someone watching Twitch on a phone, in
another profile, or after uninstalling is invisible, and an uninstall is
indistinguishable from having stopped watching Twitch. The columns are
`returned_within_*` and there is deliberately no `twitch_retention` or
`return_to_twitch` anywhere.

**Censoring:** the most recent 30 days cannot have a complete 30-day window.
Filter `day <= current_date - 30` before quoting `returned_within_30d`.

**Class:** observational **association**. The social/non-social split compares
different kinds of people.

---

## 8. M3A Slice 5 — Experiment arm

**Property:** `authenticated_session_started.experiment_arm`.

`src/core/experiment.ts` is unchanged — the randomisation architecture, the
salt, and the production-only rule are all as they were. The only change is
that the arm is now **recorded**, which is what makes any future causal
analysis possible at all.

### The gate, and where it lives

The gate is in the **hub**, not at the call site:

```ts
...(experimentArm && isRandomisedArm(deps.environment)
  ? { experiment_arm: experimentArm }
  : {}),
```

`index.ts` resolves the arm and passes it; the hub decides whether it is
recorded. That means a beta build cannot leak a constant arm by passing one —
the property is simply dropped. Defence in depth rather than one place to
remember.

**Absent, not `'gravity'`.** A missing property reads as missing in every
query; a literal would have to be excluded by hand in each one, and eventually
would not be.

**No experiment is running.** No treatment or control behaviour changed.

Proven by test from both sides (§21.2), and by mutation: removing the gate
makes the private-beta test go red.

---

## 9. Channel-dwell semantics

**Event:** `channel_dwell_ended` · **File:** `src/background/channelDwell.ts`

> How long Watchside **observed** this user watching one **live** Twitch
> channel.

Not how long a tab was open. Not how many tabs existed. Not how long the
browser ran.

| Property | Meaning |
|---|---|
| `duration_ms` | measured to the **effective** end, never to when a gap was noticed |
| `from_join` | an active JOIN attribution covered the interval, under the existing §7 rules |
| `had_social` | a shared watch was open at some point during the interval — **sticky** |
| `end_reason` | `switched_channel` · `left_channel` · `session_ended` · `observation_lost` |

`destination_channel` rides the envelope, as for every other
destination-bearing event. No title, no category, no viewer count.

### End reasons — the smallest truthful model

The brief asked whether focus change needs its own reason. It does, and only
that one does:

- **`switched_channel`** — one eligible live destination handed straight over
  to another in the same tick. This **is** distinguishable, it is the ordinary
  shape of focused-tab measurement once somebody has two streams open, and
  folding it into `left_channel` would hide exactly the behaviour D12 creates.
- **`left_channel`** — the eligible live destination went away and nothing
  replaced it. Covers navigating away, closing the tab, backgrounding every
  Twitch tab **and the stream ending**. From the worker those are one
  observation, and claiming to tell them apart would be inventing detail. It is
  the same word the shared watch already uses for the same situation, which is
  why no new vocabulary was introduced for it.
- **`session_ended`**, **`observation_lost`** — as for the shared watch.

### No start event

Deliberate, matching `post_social_retention_ended`: the interval is fully
described by its end, and a second event would be a second chance to disagree.

### Detected versus effective end

Identical discipline to the shared watch. `duration_ms` measures to the last
moment we could vouch for. A frozen worker or a closed laptop can put hours
between viewing stopping and us noticing; dating the event to the detection
would report every one of those hours as watching. **Stale-detection grace is
never inside a duration.**

---

## 10. The focused-tab invariant

**Owner decision D12, and it is structural rather than checked.**

Dwell is fed `liveWatchChannel()`, which is:

```
tabActivity.effective()   →  the primary destination; a VISIBLE tab always
                             beats a hidden one (src/background/activity.ts)
  → sessionChannel()      →  narrowed to a published destination
  → canWatchLiveTogether() → narrowed to channels Twitch says are LIVE
```

The machine holds **one** open interval. So:

- there is no code path on which two channels accrue at once;
- a background tab never appears, so it cannot accrue;
- switching focus A→B closes A (`switched_channel`) and opens B, with B's
  start equal to A's end — no overlap, no gap.

This is enforced by having nowhere to put a second interval, not by a guard
somebody could later forget.

**Why it matters:** counting three background tabs as three concurrent hours is
the one way this system could **invent** watch time rather than merely lose
some — and invented watch time cannot be detected afterwards.

Proven by six tests including an explicit "does not multiply watch time by the
number of open tabs" and a disjointness assertion on A→B→A (§21.1).

---

## 11. The live-stream invariant

Dwell reuses the **same** rule as the shared watch, asked in the **same place**:
`liveWatchChannel()` in `src/background/index.ts`, which calls
`canWatchLiveTogether()` from `src/core/socialViewing.ts`.

There is deliberately **no second definition of "watching"**.

- A channel that is not live arrives as `null`, which is exactly what leaving
  looks like, so the interval closes through the path that already existed.
- `unknown` is not live. A cold cache, a Twitch outage and a channel nobody has
  asked about all under-count — the intended direction.

Because dwell and the shared watch are driven from the same value in the same
tick, **a shared watch always sits inside a dwell interval on the same
channel**. `dwell ≥ together` is asserted by test rather than assumed (§21.1).

---

## 12. MV3 and storage lifecycle

Dwell reuses the proven machinery rather than inventing a parallel one.

| Concern | Reuse |
|---|---|
| Recovery policy | **`reconcileLifecycle` itself**, made generic over the state it carries |
| Staleness rule | `isObservationLost` / `RESUME_WINDOW_MS` — the same constant |
| Storage shape | `PersistedLifecycle<DwellState>` at `kickback:analytics:dwell` |
| Frozen-worker doubt | `closeDwellIfObservationLost` on every tick, mirroring the shared watch |

### The generic refactor

`PersistedLifecycle` and `reconcileLifecycle` are now generic over
`S extends { channel: string }`, defaulting to `TogetherState`. The policy reads
only the channel from the state, so that is all the constraint asks for.

`isPersistedLifecycle` now delegates to a shared envelope validator
(`isPersistedLifecycleOf`) plus a state guard (`isTogetherState`), so the
envelope check has one definition and each lifecycle brings its own state
guard. **No existing call site changed shape.**

The alternative — a second copy of the recovery policy — would have been two
chances to answer "is this still the world we left" differently.

### What is stored

One value: the open interval only — channel, start, the sticky social flag, the
attribution, and when we last saw the user. **Deleted the moment the interval
closes.** Somebody who is not watching has nothing about their viewing stored
anywhere.

### Coming back

| On restart | What happens |
|---|---|
| Same channel, gap < 5 min | Resume. **Nothing emitted** — there is no start event to replay |
| Gap > 5 min | Close at the last vouched moment, `observation_lost` |
| Channel changed | Close at the last vouched moment, `left_channel` |
| Different account | **Discard silently** — the actor is `auth.uid()` server-side |
| Unreadable stored value | Discard. Fails closed |

Conservative by construction: a long eviction becomes two shorter intervals
rather than one inflated one.

---

## 13. Attribution semantics

### 13.1 `from_join`

An interval is attributed when an active JOIN attribution legitimately covers
it, under the **existing** rules in `joinAttribution.ts` — 90s arrival window,
10 minutes retained after arrival. **Nothing in M3C widens the attribution
lifetime**, which the brief explicitly forbade.

The attribution is looked up once per tick and shared between the two
lifecycles:

```ts
if (login && (together.wantsAttribution() || dwell.wantsAttribution())) {
  const credit = await attribution.forTogether(login)
  ...
}
```

### 13.2 No retroactive credit

An interval that opened without an attribution never acquires one — the
attribution is fixed at open. Organic viewing therefore cannot later be
credited to a JOIN.

### 13.3 No leakage

Attribution does not carry to a different channel. Tested at both the state
machine level and through the hub: after a JOIN to `lirik`, later viewing of
`shroud` has `from_join: false` and a null `attribution_id` (§21.1, §21.2).

### 13.4 What was NOT built, and why that is correct

**D5's hybrid architecture and D6's per-user Twitch deletion path are not built
here — and should not be.** Both exist to isolate *Twitch-derived relationship
data* so it can be deleted on de-authorisation without destroying
Watchside-owned analytics. M3A/M3C write **no Twitch-derived relationship data
at all**: every value comes from Watchside's own observation of its own tabs.
Building the isolation table now would create an empty structure whose purpose
nobody could check. It is required before the first M3D write, not before this.

---

## 14. `had_social` semantics

> A **valid shared-watch interval** occurred during this dwell interval.

Read from the shared-watch lifecycle's own state, never from a friend count:

```ts
emitTogether(together.update({ channel: login, otherCount }))
emitDwell(dwell.update({ channel: login, social: together.current() !== null }))
```

Ordering is load-bearing — the shared watch updates first, then dwell reads its
state. That is what makes `had_social` mean "a shared watch actually occurred"
rather than "some friends were around somewhere on Twitch".

### Sticky, and why

The flag is set once and never cleared. A friend who watches for two minutes
and leaves leaves the rest of the evening still marked `had_social`.

Reading it at close time instead would report `false` for every interval that
outlived its social part — which is most of them, and precisely the
post-social behaviour Watchside exists to demonstrate. Proven by mutation:
changing `if (social) state.hadSocial = true` to `state.hadSocial = social`
makes the test go red.

It does not carry across a channel switch.

---

## 15. Repeat-creator-viewing support

**View:** `analytics_creator_repeat_v`. **No new telemetry** — built entirely
from `join_arrived` and `channel_dwell_ended`, as Part C preferred.

**Grain:** one row per (actor, environment, creator) the actor ever arrived at
through a Watchside JOIN.

| Question from the brief | Column |
|---|---|
| how many actors returned to a creator reached through a JOIN | rows where `later_organic_dwell_count > 0` |
| how often a socially reached creator was watched again | `later_organic_dwell_count` |
| time between first attributed JOIN and later viewing | `time_to_first_organic_return` |
| later viewing duration | `later_organic_dwell_ms` |

**Why "organic".** Viewing that a *later* JOIN produced is counted separately
(`later_dwell_count` / `later_dwell_ms`), because calling a second
Watchside-driven visit "they came back on their own" would be the same error
twice.

**⚠ Not "Twitch retention".** This is repeat *observed* viewing of a creator
after a Watchside-attributed visit. It sees only what Watchside sees.

**Censoring:** empty until dwell data exists. Rows will exist for historical
JOINs with no later viewing — those are the denominator, not missing data.

---

## 16. Analytical reproducibility (D13)

`docs/ANALYTICS.md` gained two sections so that strategically important
definitions are **not buried in TypeScript or SQL**:

- **§14 Metric definitions (reproducible)** — for each of the seven metrics
  added: numerator, denominator, inclusion criteria, exclusion criteria,
  environment filtering, valid-from date, known lifecycle censoring,
  attribution semantics, and whether it is observational, attributed or causal.
- **§15 Measurement start timestamps** — see §25 below.

It also gained **§8b Channel dwell**, the full semantic description, and had
two stale claims corrected (§4).

A reviewer can reproduce any number in a deck from §14 without reading code.

---

## 17. Schema and migrations

### 17.1 Numbering — checked first, as instructed

Highest existing was `0028`. **Neither `0029` nor `0030` existed.** No conflict,
so no STOP and no invented numbering.

### 17.2 What was added

| File | Contents |
|---|---|
| `0029_m3_views.sql` | the five views + revokes |
| `0030_m3_contract.sql` | `channel_dwell_ended`; `experiment_arm` on `authenticated_session_started`; version marker → **30** |

**0030 is data, not DDL** — one `insert ... on conflict do update` into
`analytics_event_names`. No table, column, index, policy or grant change.

Statement audit of both files: 5 `create view`, 5 `drop view if exists`, 5
`revoke`, 1 `insert`, 1 `create or replace function`, 1 `revoke ... function`.
**No `drop table`, `delete`, `truncate`, or `alter table ... drop`.**

### 17.3 The re-runnability bug the existing tests caught

My first version broke `apply_all.sql`:

```
error: cannot drop view analytics_sessions_v because other objects depend on it
```

`tests/db/bundle.test.ts` requires the bundle to apply **three times** and on
top of partial states, because the hosted database is upgraded by re-pasting
it. 0014 unconditionally drops its views; my new views depended on them, so the
second pass failed.

**Root cause:** any view created after 0014 that depends on 0014's views blocks
0014's drops on a re-run. 0016 only avoids this because 0014 happens to drop
0016's two views by name.

**Fix:** `cascade` on the view drops in 0014 and 0016.

Naming the dependants instead would work until somebody forgot one — a stale
list waiting to be a bug. `cascade` cannot go stale, and it is safe for exactly
the reason 0014's header already gives for dropping at all: *a view holds no
data*, and everything dropped is recreated later in the same bundle. Dependency
order is still respected, so `cascade` is a backstop rather than the mechanism.

Both files carry a comment explaining this.

**Verified:** `tests/db/` — **390 passed**, including applies-twice,
applies-three-times, and five partial-state upgrade paths.

---

## 18. Privacy changes

`docs/PRIVACY.md` gained a summary-table row and a dedicated **"Viewing time"**
section. It is deliberately not euphemised — the opening sentence is:

> **Watchside records how long you watch a live Twitch channel.**

followed by an explicit acknowledgement that this is a change:

> Until now Watchside recorded how long you watched *with a friend*; it now
> also records how long you watched.

The section states **why** (whether social features actually lead to viewing
and repeat creator engagement), exactly what is recorded, and five explicit
limits: not the video/title/category/viewer count, not browsing generally, not
background tabs, not offline channels, and **not time we did not observe**.

It also states that only the in-progress interval is on the device and is
deleted as soon as it ends, and that this is never shared, sold, or used for
advertising.

**Guarded by test.** `tests/extension/dwellDisclosure.test.ts` fails if the
plain sentence, the section, or any of the five limits is removed while the
event still exists — so the measurement and its disclosure cannot drift apart.

**Public page:** rendered with the established command into
`anoteros-pages/watchside/privacy/index.html`. See §30 for publication status.

---

## 19. Firefox implications

**The F6 decision is intact: Firefox collects no `technicalAndInteraction`
telemetry.** Nothing here is a diagnostic event.

| Item | Category | Manifest change |
|---|---|---|
| `channel_dwell_ended` | `browsingActivity` | **none** — already REQUIRED |
| `experiment_arm` | property on an `authenticationInfo` event | **none** |
| All five views | n/a | **none** |

`scripts/manifest.mjs` is **unmodified**. Declared required categories remain
exactly `authenticationInfo`, `browsingActivity`, `personalCommunications`,
`websiteActivity`.

Three assertions now pin this:

- dwell classifies as `browsingActivity`, which is declared;
- the required list is **exactly** those four — a new required category changes
  the install prompt for every existing user, so it must be a deliberate act
  with a failing test to acknowledge;
- neither `financialAndPaymentInfo` nor `technicalAndInteraction` is declared.

The `financialAndPaymentInfo` assertion is deliberately forward-looking: it is
the category M3E-a may require (M3B §17), and D8 is still open.

**`verify:firefox` passes. The pending v0.6.0 AMO submission was not touched.**

---

## 20. Chrome implications

- **No new permission, no new host permission, no manifest change.** The
  permanent extension ID is unaffected.
- **Privacy disclosure:** the Chrome Web Store privacy-practices answers will
  need updating when M3C ships, because dwell is web-history-adjacent. That is
  a listing action at release time, not a repository change, and no Store
  listing text or package was modified here.
- `verify:store` passes — the repository agrees with itself, and the policy
  still names every permission and host.

---

## 21. Tests and regressions

**Full suite: 93 files, 2369 tests, all passing** (was 92/2360).
`npm run lint` clean · `tsc -b --force` clean · `npm run build` clean.

### 21.1 `tests/extension/channelDwell.test.ts` — 26 new

One interval at a time · no overlap on switch · **does not multiply watch time
by open tabs** · A→B→A disjointness · nothing accrues without an eligible live
channel · `left_channel` when the stream stops being eligible · attribution
present/absent/non-leaking · `had_social` false/true/sticky/not-carried ·
restore emits nothing · restored interval measured from its original start ·
observation loss closed at the last vouched moment · storage guard rejects
unknown shapes · the shared recovery policy resumes/closes/discards correctly.

### 21.2 `tests/extension/analyticsHub.test.ts` — 13 new

Wiring, at the highest practical layer: correct duration and `switched_channel`
on the wire · nothing accrues with no live channel · **no double-count across a
worker restart** · **three-hour gap not fabricated** · `had_social` from the
shared watch and sticky after friends leave · `from_join` matching the click's
`attribution_id` · no leak to unrelated later viewing · closes on sign-out ·
**dwell ≥ shared watch** · arm absent in private beta even when passed · arm
present in production · arm absent when not passed.

### 21.3 Mutation-proved

Four guards were broken on purpose and a specific test confirmed red each time:

| Mutation | Result |
|---|---|
| arm gate removed (beta would leak a constant) | **DETECTED** |
| restored dwell interval re-opens instead of resuming | **DETECTED** |
| dwell closes at `now()` instead of the last vouched moment | **DETECTED** |
| `had_social` cleared instead of sticky | **DETECTED** |

### 21.4 `tests/extension/dwellDisclosure.test.ts` — 9 new

The disclosure guard (§18), the Firefox category guards (§19), and the
**M3A/M3C hard boundary**: no `following_at_join`, `subscribed_at_join`,
`tier`, `is_gift`, `gifter_login` property and no `creator_followed` event
exists anywhere in the contract; and the privacy policy makes no claim about
follows or subscriptions, because describing collection we do not perform is as
wrong as the reverse.

### 21.5 Known debt — compared against HEAD, not assumed

| Harness | Baseline at `bfdbd39` | After this work |
|---|---|---|
| `test:analytics` | 34/87 undetected | **18/87** ✅ improved by 16 |
| `test:presence` | 9/21 undetected | **4/21** ✅ improved by 5 |
| `test:layout` | 5/23 undetected | 5/23 — unchanged, pre-existing |
| `verify:lab` | 11 failures | 11 — unchanged, pre-existing Gravity harness debt |

Measured by building a worktree at `bfdbd39` and running each harness there.
**No new failure appeared anywhere**, and two harnesses improved materially
because the new tests catch mutations that previously escaped.

`verify:lab` was not investigated — this checkpoint does not change the code or
contract those checks cover.

---

## 22. Hosted migration apply

**Authorised by Part G, and applied with the smallest possible blast radius.**

The repository's established workflow is `npm run db:bundle` plus a manual
paste into the Supabase SQL editor — a browser action. The Supabase CLI was
found already authenticated and linked, so it was used instead, but only after
establishing that it would touch **nothing except the two new migrations**.

### Pre-flight

1. `npm run db:bundle` — regenerated from 30 migrations.
2. **Statement audit** — no destructive statements (§17.2).
3. **`tests/db/` — 390 passed** against real Postgres, including three bundle
   re-runs.
4. **`verify:analytics` baseline** — everything through 0028 present; exactly
   the five new views missing.
5. Migration history showed **no tracking rows at all** (`remote: ""` for all
   28), because the schema was applied by hand. A naive `db push` would
   therefore have tried to re-apply all 30.

### The apply

```
supabase migration repair --status applied 0001 … 0028 --linked   # history only
supabase db push --linked --dry-run                               # → 0029, 0030 only
supabase db push --linked
```

`migration repair` writes only to the migration-history table and runs no
schema SQL. The dry run confirmed the scope before anything was written:

> Would push these migrations: • 0029_m3_views.sql • 0030_m3_contract.sql

**Result:** both applied. No error.

**Note for the owner:** this baselines the project's migration history, so
future applies can use `supabase db push` for new migrations only. The SQL-editor
paste path still works and is unchanged; 0014/0016 now carry `cascade`, which
only matters on a full re-paste.

---

## 23. Hosted verification

`npm run verify:analytics` after the apply:

- **all five new views present** — `analytics_gravity_conversion_v`,
  `analytics_growth_funnel_v`, `analytics_graph_cohort_v`, `analytics_return_v`,
  `analytics_creator_repeat_v`;
- **none readable by an anonymous client** — the revokes took effect. A readable
  analytics relation is a failure, not a success, and the script checks for it;
- all seven pre-existing views still present and still unreadable;
- all six functions present, including `analytics_schema_version`;
- final line: *"Analytics schema is present, and nothing in it is readable by a
  client."*

Migration history now reports **30/30 tracked remote**, with `0029` and `0030`
both `local=remote`.

**Ingestion:** the write path was not modified. `analytics_track` is present and
correctly refuses an unauthenticated caller. The contract change (one widened
property array, one new event) is exercised against real Postgres by
`tests/db/analytics.test.ts` — 47 passing.

---

## 24. Private-beta snapshot — ⚠ NOT COMPLETED

**This is the one deliverable I could not finish, and I stopped rather than
improvise.**

### Why

Part H requires querying `private_beta` data through the M3A views. Those views
are **deliberately revoked from `anon` and `authenticated`** — that revoke is a
security property this checkpoint just verified, and it is doing its job.

Reading them needs owner-level access, and none exists in this environment:

| Path | Why not |
|---|---|
| Publishable key (`.env.local`) | Correctly refused — the revokes work |
| Service-role key | Not present anywhere on this machine |
| `supabase db push` credentials | The CLI connects for DDL but exposes **no arbitrary-SQL command** — `db` has only `diff`/`dump`/`push`/`pull`/`reset`, and `inspect` offers only canned reports |
| CLI access token via Management API | The token is in the **OS keyring**, not a file. Extracting a credential from the keyring is beyond what this checkpoint should do |
| `psql` via pooler URL | Needs the database password, which this project deliberately does not hold |

Fabricating numbers, or reporting the empty result a refused query returns as
though it were data, would both be worse than reporting the gap.

### What the owner can run

Paste into **Supabase → SQL Editor**. Every query is read-only and filters
`environment` explicitly, as §14 requires.

```sql
-- 1. Gravity exposure -> JOIN
select count(*) as opportunities_shown,
       count(*) filter (where converted) as opportunities_with_join,
       sum(join_count) as joins,
       round(100.0 * count(*) filter (where converted) / nullif(count(*), 0), 1) as pct
from public.analytics_gravity_conversion_v where environment = 'private_beta';

-- 2. JOIN -> arrival
select count(*) as join_clicks,
       count(arrived_at) as arrivals,
       round(100.0 * count(arrived_at) / nullif(count(*), 0), 1) as arrival_pct
from public.analytics_join_funnel_v where environment = 'private_beta';

-- 3. Shared watch and post-social linger (post-2026-08-24 rows only)
select count(*) as shared_watches,
       round(avg(extract(epoch from duration)) / 60.0, 1) as avg_minutes,
       count(*) filter (where post_social_retained) as with_linger,
       round(avg(extract(epoch from post_social_duration)) / 60.0, 1) as avg_linger_minutes
from public.analytics_together_v
where environment = 'private_beta' and started_at >= timestamptz '2026-08-24';

-- 4. Graph-size distribution
select friend_bucket, count(*) as sessions,
       count(*) filter (where had_join_click) as sessions_with_join
from public.analytics_graph_cohort_v where environment = 'private_beta'
group by friend_bucket order by friend_bucket;

-- 5. Watchside return (NOT Twitch return)
select had_social_interaction, count(*) as actor_days,
       count(*) filter (where returned_within_7d) as returned_7d
from public.analytics_return_v where environment = 'private_beta'
group by had_social_interaction;

-- 6. Growth funnel
select sum(invites_created) as created, sum(invites_shared) as shared,
       sum(claims_attributed) as claimed, sum(referrals_succeeded) as succeeded
from public.analytics_growth_funnel_v where environment = 'private_beta';

-- 7. Sanity: never mix environments
select environment, count(*) as events, count(distinct actor_id) as people,
       min(occurred_at) as first_seen, max(occurred_at) as last_seen
from public.analytics_reportable_events_v group by environment;
```

**Whatever these return, they are low-N private-beta data.** They are
descriptive only; no causal claim is supportable from them, and arm comparison
is meaningless because private beta records no arm.

**Query 8 (dwell) is deliberately omitted: it would return zero rows.** See §25.

---

## 25. Measurement start timestamps

| Measurement | Data valid from |
|---|---|
| The five M3A views | **immediately** — views over existing history, live since the apply in §22 |
| `opportunity_key` on both sides | already live before this checkpoint |
| **`channel_dwell_ended`** | **the first production release carrying M3C — no data exists yet, and none can be reconstructed** |
| **`experiment_arm`** | the first **production** release carrying slice 5. Never present in private beta |
| `analytics_creator_repeat_v` | depends on dwell, so effectively the same date |
| Durations before 2026-08-24 | upper bound, not measurement (pre-live-rule) |

**The dwell start timestamp must be recorded in the release notes of whichever
version ships M3C, and quoted beside any watch-time figure.** Recorded in
`docs/ANALYTICS.md` §15.

---

## 26. Known limitations and censoring

- **Dwell systematically under-counts.** A live stream whose metadata has not
  arrived loses the opening moments; an eviction splits one interval into two;
  an unobserved gap is excluded entirely. It never over-counts — the direction
  chosen everywhere in this system.
- **Metadata flapping chops intervals.** If live state briefly goes `unknown`,
  the interval closes and a new one opens. The shared watch has the same
  exposure and the same accepted trade.
- **Background viewing is invisible by design** (D12). Someone genuinely
  watching a background tab while working in another records nothing.
- **`analytics_return_v` measures return to Watchside**, never to Twitch (§7).
- **`analytics_creator_repeat_v` is empty until dwell data exists**, and rows
  with zero later viewing are the denominator, not missing data.
- **30-day return is censored** for the most recent 30 days.
- **Growth-funnel outcome counts span environments** (`referrals` has no
  environment column).
- **Install and install→auth remain unmeasurable** — structural.
- **Opportunity keys split at 30-second boundaries**; a gathering spanning one
  is two opportunities. Pre-existing, documented, accepted.
- **Private beta records no experiment arm**, so no arm comparison is possible
  or meaningful there.

---

## 27. Security and data-minimisation review

- **No new Twitch data of any kind.** Every value dwell records comes from
  Watchside observing its own tabs.
- **No new permission, host permission, or OAuth scope.**
- **No provider token captured, stored, or refreshed.**
- **The property contract still cannot carry content** — values capped at 64
  characters, unknown keys stripped on both sides. `channel_dwell_ended` adds a
  number, two booleans and a fixed-vocabulary word.
- **Storage minimised**: one open interval, deleted the moment it closes.
  Nothing historical is kept on the device.
- **Views are owner-only** — verified against the hosted project after the
  apply.
- **Secret scan** of every changed and added file: no JWTs, no `sb_secret_`, no
  service-role values, no bearer tokens, no PEM blocks, no Supabase project
  URLs, and no machine-specific absolute paths.
- **No generated or authenticated seed material** was added;
  `scripts/firefox-e2e/seeds.local.json` remains untracked and untouched.
- **No credential was printed** at any point, including during the hosted
  apply.

### One judgement worth flagging

`end_reason` cannot distinguish "the user left" from "the stream ended", and
`left_channel` covers both. That is a deliberate loss of resolution rather than
a bug: distinguishing them would need a second signal, and claiming to know
which happened would be inventing detail. Documented in `ANALYTICS.md` §8b and
in the enum's own comment.

---

## 28. Release implications

**Nothing was released, packaged, or version-bumped.**

| | State |
|---|---|
| Chrome | v0.6.0 live — untouched |
| Firefox | v0.6.0 at AMO — **untouched** |
| Package version | unchanged (`0.6.0`) |
| Store artifacts | none built |
| `main` | advances through this checkpoint |

**M3A ships now, without a release.** The five views are already live on the
hosted project and answer questions over existing history.

**M3C needs a Store release.** No dwell data is collected until a production
build carrying this code reaches users. The intended vehicle is the next
coherent cross-browser release (v0.7), which **this checkpoint does not
create**. That release will also need the Chrome privacy-practices answers
updated (§20).

---

## 29. Files changed

### Added
| File | Purpose |
|---|---|
| `src/background/channelDwell.ts` | the dwell state machine |
| `supabase/migrations/0029_m3_views.sql` | five reporting views |
| `supabase/migrations/0030_m3_contract.sql` | contract rows + version marker |
| `tests/extension/channelDwell.test.ts` | 26 tests |
| `tests/extension/dwellDisclosure.test.ts` | 9 tests — disclosure, Firefox, hard boundary |
| `docs/reports/m3a-m3c-measurement-foundation-2026-08-30.md` | this report |

### Modified
| File | Change |
|---|---|
| `src/core/analytics.ts` | `channel_dwell_ended`, `DwellEndReason`, `experiment_arm`, properties, Mozilla classification |
| `src/background/analyticsHub.ts` | dwell lifecycle; the arm gate; shared attribution lookup |
| `src/background/togetherStore.ts` | recovery policy made generic; envelope/state guards split |
| `src/background/index.ts` | dwell store; arm resolved and passed |
| `src/testlab/client.ts` | dwell store for the lab |
| `supabase/migrations/0014_analytics_views.sql` | `cascade` on view drops (§17.3) |
| `supabase/migrations/0016_social_discovery_views.sql` | same |
| `scripts/verify-analytics.mjs` | five new views registered |
| `tests/db/bundle.test.ts` | version marker 28 → 30 |
| `tests/extension/analyticsHub.test.ts` | 13 new tests |
| `docs/ANALYTICS.md` | §8b, §14, §15; two stale claims corrected |
| `docs/PRIVACY.md` | viewing-time disclosure |

### Pages repository (separate history)
| File | Change |
|---|---|
| `watchside/privacy/index.html` | re-rendered from `docs/PRIVACY.md` |

### Explicitly unchanged
`src/core/experiment.ts` · `src/core/socialViewing.ts` ·
`src/background/joinAttribution.ts` · `src/background/togetherWatch.ts` ·
`src/core/socialGravity.ts` · `scripts/manifest.mjs` · every manifest ·
`package.json` version · all Store artifacts · OAuth.

---

## 30. Commits and push status

See the terminal summary accompanying this report for the exact hashes. Two
repositories, committed and pushed separately, with no mixing of histories:

- **Watchside** — one commit covering M3A, M3C, the migrations, tests and docs.
- **anoteros-pages** — one commit containing only the re-rendered privacy page.

The Pages repository was verified clean before any modification, as Part E
requires.

---

## 31. Remaining work for M3D / M3E-a

Unchanged by this checkpoint, and still gated:

| Gate | Status |
|---|---|
| **D7** Twitch DSA legal read | **open** — blocks any Twitch-derived collection |
| **D8** AMO `financialAndPaymentInfo` classification | **open** — blocks M3E-a only |
| **G6** per-user Twitch-data deletion path | **not built** — required before the first M3D write (§13.4) |
| **D5** hybrid attribution table | **not built** — required with G6, not before |
| `user:read:follows` | not requested; `oauthContract.test.ts` still asserts `scopes` is absent |
| `user:read:subscriptions` | not requested |
| Provider-token capture | not implemented |

M3B.1 §26.4's recommended sequencing stands: **v0.7 carries M3A + M3C with no
consent change; v0.8 carries M3D + M3E-a as one consent change**, once D7 and
D8 clear.

The forward-looking Firefox assertions in §19 mean adding
`financialAndPaymentInfo` later will require deliberately updating a failing
test — which is the intended friction.

---

## 32. Final recommendation

## **GO**

1. **Every slice is implemented, tested and verified.** 2369 tests pass; the
   migrations apply cleanly to real Postgres three times over; the hosted
   project has the five views and none is readable by a client.
2. **The invariants that matter are structural.** Focused-tab-only is enforced
   by there being nowhere to put a second interval; the live rule is the
   shared watch's own rule asked in the same place; a shared watch is always
   inside a dwell interval on the same channel.
3. **The measurement cannot outrun its disclosure.** The privacy section is
   plain, and a test fails if it is removed while the event still fires.
4. **No boundary was crossed.** No scope, no token, no Twitch relationship
   data, no Firefox category change, no release.
5. **The known-debt comparison was measured, not assumed** — and two mutation
   harnesses improved.

**One item is outstanding and is an owner action:** the private-beta snapshot
(§24), which requires SQL-editor access this environment does not have. The
exact queries are ready to paste.

**Recommended next step:** run §24's queries, then treat M3C as ready for the
v0.7 cross-browser release — recording the dwell measurement start date in that
release's notes, as §25 requires.

---

## 33. M3C.1 — Observed Stream Dwell Correction

**Appended:** 2026-08-30
**Starting commit:** `7ce6f43` · both trees clean
**Type:** focused implementation correction, made before any production data
existed.

> **The whole reason this was cheap: `channel_dwell_ended` had produced ZERO
> production rows.** v0.7 was never packaged, so the contract could be
> corrected outright rather than versioned around. There is no mixed-semantics
> window, no cut-over date, and no query anywhere will ever need a footnote
> about which rule produced a row.

---

### 33.1 Why focused-only was rejected

The M3C implementation measured only the focused tab, one interval at a time
(§9, §10). The reasoning was that counting three open tabs as three concurrent
hours would *invent* watch time, and invented watch time cannot be detected
afterwards.

That reasoning was right about the risk and wrong about the remedy. It
protected the headline number by **destroying the evidence**:

- a viewer with two streams legitimately open for an hour really did consume
  two stream-hours of Twitch, and one of them was discarded;
- a stream on a second monitor, or running while the viewer read something
  else, recorded nothing at all;
- none of it was recoverable later, because a measurement that never ran leaves
  nothing to re-analyse.

The asymmetry is the point. **A metric made conservative by discarding
behaviour cannot be widened afterwards; one made faithful can always be
narrowed in the query.** Focused-only threw away the strict reading's
alternatives; per-stream keeps both.

So the governing principle, now recorded in `docs/ROADMAP.md`:

> **Measure observable Twitch consumption faithfully; preserve dimensions for
> stricter analysis later; be conservative in claims rather than destructive in
> collection.**

The original concern is not dismissed — it is relocated. Inventing watch time is
still the failure that matters, which is why §33.3 keeps *wall-clock* time a
separate, union-based quantity that concurrency cannot inflate, and why §14.0 of
`docs/ANALYTICS.md` forbids the one sentence that would confuse them.

---

### 33.2 New canonical dwell definition

> **Observed stream dwell** — how long Watchside had defensible continuing
> evidence that one eligible **live** Twitch stream was open and observed.

- **Per stream.** Not capped to one per actor.
- **Not gated on focus.**
- **Not human attention**, and never described as such.

**Unit: stream-milliseconds.** Summing across concurrent streams yields
stream-time, which is a different quantity from wall-clock time and is named
differently everywhere (§14.0).

What still ends an interval is unchanged in spirit and now more precise:

| Reason | Evidence |
|---|---|
| `left_channel` | the destination left the observed set — tab closed or navigated |
| `stream_ended` | still open, but Twitch no longer says it is live |
| `session_ended` | sign-out or session close |
| `observation_lost` | gap beyond the 5-minute resume window; closed at the last vouched moment |

`stream_ended` is **new and newly possible**: tracking the destination set and
live state separately means "the stream ended under a viewer who stayed" is now
distinguishable from "the viewer left". Under focused-only both arrived as a
null channel and were necessarily folded together.

`switched_channel` was **removed**. It existed only because focused-only dwell
had to close one interval to open another; per-stream dwell does not, so the
value became unreachable. A vocabulary listing outcomes that can no longer occur
misleads whoever reads a `group by` next.

---

### 33.3 Multi-stream semantics

Concurrent streams accrue simultaneously and independently.

```
two streams open 60 minutes  →  120 observed stream-minutes
                                 60 wall-clock minutes
                                 60 concurrent stream-minutes
```

All three are computed, and `analytics_viewing_daily_v` puts them **in the same
row** so the wrong one cannot be reached for by accident:

| Column | Concurrency | May be described as |
|---|---|---|
| `observed_stream_ms` | **inflates** it, legitimately | "observed Twitch stream-hours" |
| `wall_clock_ms` | does **not** inflate it | "Watchside-observed Twitch time" |
| `concurrent_stream_ms` | the exact difference | "consumption alongside another stream" |

`wall_clock_ms` is the union of an actor's intervals for a day, by
gaps-and-islands. It is the only dwell quantity that may be described as time a
person spent watching Twitch.

#### What establishes "observed" — existing evidence only

The brief asked whether presence destinations could serve, and whether all of
them count. They cannot be assumed equal to valid dwell; the set used is the
intersection that already exists:

| Evidence | Source |
|---|---|
| the tab exists on that channel | `tabActivity.destinations()` (capped at 3, deduped, visibility-independent) |
| the destination was published and acknowledged by the server | `presenceReporter.lastDestinations()` |
| both | **`sessionChannels()`** — their intersection |
| the stream is live | `canWatchLiveTogether()`, per channel |
| observation is continuing | the existing 45-second presence heartbeat |

**No polling was added.** Nothing new is fetched on dwell's behalf except one
thing:

**`wantMetadata()` now requests metadata for every open destination, not only
the focused one.** This was a genuine blocker found during inspection: it pushed
`currentChannel()` alone, so a background stream would have read `unknown`
forever, `unknown` is not live, and the interval would never have opened — the
measurement would have silently collapsed back to focused-only while looking
correct. Cost: at most two extra logins per refresh against a budget of **600
per five minutes**, batched, TTL-guarded and idempotent.

#### One rule, two consumers

`canWatchLiveTogether()` is now called from two places — `liveWatchChannel()`
(the single-channel shared watch) and `observedStreams()` (per destination).
Two existing tests asserted **one** call site.

I did not relax them. Unifying was considered and **rejected on evidence**:
`sessionChannel()` consults only the published set while `sessionChannels()`
also intersects `tabActivity.destinations()`, so deriving `liveWatchChannel()`
from the observed set would change shared-watch behaviour in an edge case (more
than three tabs, the focused one outside the top three). Changing accepted
shared-watch semantics is a stated STOP condition.

Instead the guards were **strengthened**: they now assert the count is two, name
both consumers by their source, and additionally assert that nothing else in the
worker decides liveness (`liveStateOf(`, `=== 'live'`, `.live ===` are all
forbidden). The invariant that matters — *one rule, no second definition* — is
now checked more directly than a bare count checked it.

---

### 33.4 Focus / background semantics

Focus is a **dimension**, not a gate. The representation is the one the brief
preferred, and no better alternative was found:

```
duration_ms
focused_duration_ms
background_duration_ms

focused_duration_ms + background_duration_ms = duration_ms      (exactly)
```

Carried on the same event rather than split into separate events — the brief's
stated preference, and correct here: two events would need pairing, and pairing
is a second chance to disagree.

**Banked at each focus transition, not sampled per tick.** Sampling would smear
every transition across the 45-second heartbeat, and the error would always fall
the same way for whichever stream happened to be focused at tick time. A
transition is observed as it happens, because content scripts report on
`visibilitychange`.

**Clamped at close**, so the invariant holds by construction rather than by the
arithmetic happening to line up. The case that makes this real: an interval
carrying focus time banked before a worker died, then closed retroactively at an
*earlier* last-vouched moment. Without the clamp, `background_duration_ms` would
go negative and silently poison every sum built on it. Mutation-proved (§33.10).

**"Focused" means the primary destination** — the tab the activity registry
picks, visible beating hidden. At most one stream is focused at a time, which
keeps focused stream-minutes comparable to wall-clock time. Two visible Twitch
windows on two monitors are one primary and one background, deliberately.

---

### 33.5 Interval and concurrency derivation

**No new telemetry was needed**, and the brief asked this be checked rather than
assumed.

`analytics_events.occurred_at` is the **effective end** and `duration_ms` is
the interval length, so:

```
started_at = occurred_at - duration_ms      (exact)
```

That is sufficient to reconstruct every interval, and therefore to derive
overlap, union and concurrency in SQL. Two views make it usable:

- **`analytics_stream_dwell_v`** — one row per interval, with `started_at`,
  `ended_at`, the durations, `from_join`, `had_social`, `end_reason`, and
  `observed_during` as a `tstzrange` so overlap questions are range operations
  rather than hand-rolled timestamp arithmetic in every query.
- **`analytics_viewing_daily_v`** — per actor-day: stream-time, focused,
  background, attributed, social, **wall-clock union**, and concurrent time.

Asserted on the wire, not just in SQL: a hub test reconstructs both spans from
emitted events and checks that stream-time exceeds the union for two concurrent
streams (§33.10).

---

### 33.6 Attribution isolation

Per-stream JOIN attribution is unchanged in rule and newly isolated in
mechanism.

Attribution is now looked up **per destination**:

```ts
for (const candidate of needsCredit) {
  const credit = await attribution.forTogether(candidate)
  ...
}
```

`forTogether()` answers for one channel and returns null for any other, so a
stream open alongside an attributed one **cannot inherit its credit**. An
interval that opens without an attribution never acquires one, so organic
viewing cannot be retroactively credited.

**Nothing widens the attribution lifetime** — the 90-second arrival window and
10-minute retention are untouched.

`had_social` is likewise per stream, and deliberately conservative: the
shared-watch lifecycle is single-channel by design, so **only the stream it
actually held** may be marked social. A background stream where friends happen
to be is *not* claimed as shared viewing, because the shared watch never opened
there. That under-reports, which is the right direction, and it keeps
`had_social` meaning exactly "the shared watch was open on this stream" rather
than "friends were around somewhere".

Both isolations are mutation-proved.

---

### 33.7 Repeat-creator implications

`analytics_creator_repeat_v` is **semantically correct unchanged**, and its
definition was checked against the new semantics rather than assumed.

It never referenced focus. It asks: after a Watchside-attributed arrival at a
creator, did a later qualifying dwell interval on that creator occur, not itself
covered by a JOIN attribution. Under per-stream dwell that question is
unchanged — and **strictly better answered**, because a return visit in a
background tab now produces a qualifying interval where before it produced
nothing.

The view's SQL required no edit. `docs/ANALYTICS.md` §14.7 now states explicitly
that focus is irrelevant to it, so nobody later assumes the old rule applied.

---

### 33.8 Schema and contract changes

**Numbering checked first, as instructed.** Highest existing was `0030`;
`0031` was free. No conflict, no STOP.

**`0030` was not edited.** An applied migration is history.

**New: `supabase/migrations/0031_m3c_stream_dwell.sql`**

| Change | Kind |
|---|---|
| `channel_dwell_ended` gains `focused_duration_ms`, `background_duration_ms` | contract row — **data, not DDL** |
| `analytics_stream_dwell_v` | new view |
| `analytics_viewing_daily_v` | new view |
| version marker → **31** | function replace |

Statement audit: 2 `create view`, 2 `drop view if exists`, 2 `revoke`, 1
`insert ... on conflict do update`, 1 `create or replace function`, 1 `revoke
... function`. **No `drop table`, `delete`, `truncate`, or `alter table`.**

Both new views are revoked from `anon` and `authenticated`, like every other
analytics relation. Verified against the hosted project after the apply.

**Validated against real Postgres** before any hosted change:
`tests/db/` — **390 passing**, including applies-twice, applies-three-times and
five partial-state upgrade paths.

---

### 33.9 Privacy changes

The previous wording was now **inaccurate**, and the disclosure guard caught it
rather than a human noticing: the policy claimed *"Not tabs you are not looking
at — three streams open in background tabs record nothing"*, which the
correction makes false.

`docs/PRIVACY.md` now states, in plain words and without analytics jargon:

> **If you have more than one stream open, each one is counted separately.**
> Two streams open for an hour are recorded as two one-hour stretches, not one.
> That is how we can tell how much Twitch viewing Watchside is part of; it is
> not a claim that you were sitting there for two hours, and we do not describe
> it that way.

and

> A stream still counts while its tab is in the background — on another monitor,
> or behind something else. We also record how much of each stretch the stream
> was the one you had in front of you, because "playing in the background" and
> "the thing you were watching" are genuinely different and we would rather not
> confuse them.

The false limit was replaced with a true one — **"Not other tabs. Watchside only
ever looks at Twitch"** — and the on-device sentence now says stretches, plural,
one per open stream, each deleted as it ends.

The opening sentence is unchanged and still un-euphemised: *"Watchside records
how long you watch a live Twitch channel."*

**The guard was also made wrapping-insensitive.** It matched literal substrings,
so an 80-column line break could break a disclosure check for a reason having
nothing to do with disclosure. It now matches against whitespace-collapsed text
— asserting what the policy *says* rather than how it is laid out.

**Firefox: no change.** Still `browsingActivity`, already declared REQUIRED. The
correction widened *what is observed*, not the *category*: still a duration and
a channel login, still nothing about the stream itself. No
`technicalAndInteraction`, no `financialAndPaymentInfo` — both still asserted
absent.

---

### 33.10 Tests and mutation proof

**Full suite: 93 files, 2380 passing.** Lint, `tsc -b --force`, build all clean.

All sixteen required proofs, mapped:

| # | Requirement | Where |
|---|---|---|
| 1 | unfocused stream accrues | `channelDwell` "accrues dwell for a live stream that is not focused"; hub "accrues an unfocused stream" |
| 2 | focused stream accrues | "accrues dwell for a focused stream" |
| 3 | focus loss does not end dwell | "does not end an interval when focus is lost" |
| 4 | focus regain does not duplicate | "does not duplicate an interval when focus returns" |
| 5 | focused + background = duration | "splits the duration exactly across several focus changes" + two clamp tests + hub invariant check |
| 6 | two concurrent streams both accrue | "lets two streams accrue at the same time"; hub equivalent |
| 7 | concurrent intervals stay separate | "keeps concurrent intervals separate per destination" |
| 8 | attribution cannot leak | "attributes only the stream the JOIN led to"; hub "does not leak attribution to a concurrent stream" |
| 9 | `had_social` cannot leak | "marks only the stream the shared watch was open on"; hub equivalent |
| 10 | closing one does not close another | "closing one stream does not close another"; hub equivalent |
| 11 | navigation closes only the affected | "navigating one tab closes only the affected interval" |
| 12 | `observation_lost` stays conservative | "closes a lost observation at the last vouched moment, not now"; hub three-hour-gap test |
| 13 | offline stream does not accrue | "accrues nothing while no stream is eligible"; "closes as `stream_ended`" |
| 14 | restart cannot duplicate | "cannot duplicate an interval across a restart"; hub restart test |
| 15 | repeat-creator remains correct | §33.7; view unchanged, `analytics_creator_repeat_v` covered by existing tests |
| 16 | data permits union/concurrency | "emits enough to recover start and end for overlapping streams"; hub "emits enough for wall-clock and concurrency analysis" |

#### Mutation proof — seven invariants, all detected

| Mutation | Result |
|---|---|
| focus gates dwell again (background discarded) | **DETECTED** |
| attribution shared across concurrent streams | **DETECTED** |
| `had_social` spread to every open stream | **DETECTED** |
| focus partition unclamped (background could go negative) | **DETECTED** |
| closing one stream closes them all | **DETECTED** |
| interval restarts on focus change (duplicates) | **DETECTED** |
| observation loss dated to now, not the last vouched moment | **DETECTED** |

**A first attempt reported four of these as MISSED, and that was my error, not
the tests'.** Three levers were ineffective — one mutated the worker, which no
unit test loads; one replaced a lookup whose entry had already been deleted, so
behaviour was identical; one mutated a branch the affected tests never reached.
The fourth was a genuinely weak test: the clamp case it exercised produced the
same answer clamped or not. That test was **strengthened** (an interval carrying
banked focus time, closed retroactively earlier than the bank) and now fails
without the clamp. Worth recording because a passing mutation run means nothing
until the levers are shown to bite.

#### Known debt — measured against `7ce6f43`, not assumed

| Harness | Baseline | Now |
|---|---|---|
| `test:analytics` | 18/87 undetected | **18/87** — unchanged |
| `test:presence` | 4/21 | **4/21** — unchanged |
| `test:layout` | 5/23 | **5/23** — unchanged, pre-existing |
| `verify:lab` | 11 failures | **11** — unchanged, pre-existing |

**No new failure anywhere.**

---

### 33.11 Hosted apply and verification

Same disciplined sequence as §22, with the smallest possible blast radius.

1. `npm run db:bundle` — regenerated from 31 migrations.
2. Statement audit — no destructive statements (§33.8).
3. `tests/db/` — 390 passing against real Postgres, three bundle re-runs.
4. `supabase db push --linked --dry-run` → **`0031_m3c_stream_dwell.sql` only**.
5. `supabase db push --linked` — applied, no error.

**Verification after the apply:**

- `verify:analytics`: **all nine analytics views present**, including
  `analytics_stream_dwell_v` and `analytics_viewing_daily_v`, and **none
  readable by an anonymous client** — the revokes took effect.
- Migration history: **31/31 tracked remote**, `0031` `local=remote`.
- Schema version marker → 31.
- Ingestion path untouched; `analytics_track` present and correctly refusing an
  unauthenticated caller. The widened contract is exercised against real
  Postgres by `tests/db/analytics.test.ts`.
- `verify:store` and `verify:firefox` pass.

---

### 33.12 Updated roadmap

`docs/ROADMAP.md` gained a **Measurement — M3** section carrying the permanent
principle from §33.1 and the current state:

| Phase | State |
|---|---|
| **M3A** | **DONE** — views live server-side; arm property ships with v0.7 |
| **M3B** (incl. M3B.1) | **CLOSED** |
| **M3C** | **IMPLEMENTED**, corrected by M3C.1, awaiting v0.7 |
| **M3C.1** | **IMPLEMENTED** — corrected while the table was empty |
| **D7 / D8** | **OPEN**, in parallel. Gate M3D/M3E-a; neither gates v0.7 |
| **G6 + M3D + M3E-a** | after the policy gates; one OAuth change; target **v0.8** |

**v0.7 — next coherent cross-browser measurement release** (not created):
experiment-arm instrumentation · corrected observed stream dwell ·
focus/background diagnostic · repeat-creator foundation · **no Twitch OAuth
scope change, no new Firefox data category**.

Then **F7** independently when Mozilla approves v0.6, and **M5 → Store assets →
M6 → M7**, gated by §26.9.

---

### 33.13 Measurement start state

**Zero `channel_dwell_ended` rows exist in any environment.** v0.7 has not been
packaged or released.

| Measurement | Data valid from |
|---|---|
| **`channel_dwell_ended`** (per-stream semantics) | **the first production release carrying M3C.1** |
| `focused_duration_ms` / `background_duration_ms` | same release |
| `analytics_stream_dwell_v`, `analytics_viewing_daily_v` | live now — views, so they see whatever rows exist |
| `experiment_arm` | first **production** release; never in private beta |
| `analytics_creator_repeat_v` | depends on dwell — same date |

**There is no mixed-semantics window.** The focused-only contract shipped in no
release and produced no rows, so every `channel_dwell_ended` row that will ever
exist is per-stream. No query needs a cut-over date; no figure needs a footnote
about which rule produced it. **That is the entire reason for correcting this
now rather than after v0.7**, and it is recorded in `docs/ANALYTICS.md` §15.

The dwell start timestamp must be recorded in the release notes of the version
that ships it, and quoted beside any watch-time figure.

---

### 33.14 Final recommendation

## **GO**

1. **The correction is complete and the semantics are now faithful.** Per-stream
   dwell, concurrency preserved, focus kept as a dimension rather than a gate,
   and every stricter reading still derivable — focused-only, single-stream,
   wall-clock union.
2. **The original concern is answered rather than dismissed.** Inventing watch
   time was the real risk; it is prevented by keeping wall-clock a separate
   union-based quantity, putting it in the same row as stream-time, and
   forbidding the one sentence that would confuse them (§14.0).
3. **One genuine blocker was found and fixed** — metadata was only requested for
   the focused destination, which would have silently collapsed the measurement
   back to focused-only while appearing to work.
4. **Two architectural guards were strengthened, not relaxed.** Unifying the
   live-rule call sites was rejected because it would have changed accepted
   shared-watch behaviour in an edge case; the guards now check the real
   invariant more directly than the count did.
5. **The privacy disclosure followed the behaviour**, because a test forced it
   to. The claim that background tabs record nothing was false the moment the
   semantics changed, and the guard failed until the policy was corrected.
6. **Timed to cost nothing.** Zero production rows existed, so there is no
   migration of old data, no dual-semantics query, and no footnote.

**Nothing was released.** Chrome v0.6.0 live; Firefox v0.6.0 at AMO untouched;
no version bump, no package, no upload. v0.7 does not exist.

**Outstanding and unchanged:** the private-beta snapshot (§24) still needs
SQL-editor access this environment does not have, and D7/D8 remain open ahead of
M3D/M3E-a.
