# M3D + M5C — contract recovery and acquisition coverage

**Date:** 2026-09-02
**Commit:** `dfd83221b40761319fd913beae35d201808a81c1`
**Schema:** 39 → **40**
**Deployment:** committed and pushed; **no migration applied to production**, no
store submission, no infrastructure change.

---

## 1. The headline

**M3D and M5C were already implemented.** This milestone found them built,
accepted, released and — as of Firefox 0.8.0 going public — **observing real
users for the first time**. Rebuilding them would have been redundant work.

What it did find is a real defect in M5C, of the exact class the brief asked
about: **an implementation bug that would make future metrics look believable
while being wrong.**

> All three M5C views start from `acquisition_attribution`, so every number they
> produce is conditioned on attribution existing — and **nothing reported how
> often it does**. `acquisition_campaign_v` reads identically whether campaigns
> brought most of Watchside's users or almost none of them.

That is not a miscalculation. It is a missing denominator, and no test of any
single view could have seen it. §9.

---

## 2. Recovered M3D contract

**Purpose.** Establish a creator-discovery *baseline*: when somebody performs a
socially initiated Watchside JOIN, did they **already follow that creator** on
Twitch?

**Required behaviour.**

- One question, at one moment, about **one creator** — the one just joined.
- A **baseline, not an outcome.** It does not claim Watchside caused a follow,
  and there is **no backfill**: a JOIN that could not be measured never gets an
  answer later.
- Requires provider-token custody (**M3E-b**): the credential is captured at
  sign-in, held encrypted server-side with a key outside the database, and
  destroyed on de-authorisation or account deletion.
- **Deletion built and proved before the first credential exists** (G6).
- Coverage and missingness reported alongside the metric, so it can be read
  against how much of the population it covers.

**Non-goals, explicit:** follow conversion after a JOIN, economic attribution,
causal lift, representativeness, statistical confidence at scale, and
`subscribed_at_join` (M3E-a — still HOLD, no subscription scope, tests assert
its absence).

**Source:** `docs/M3D-MEASUREMENT.md` (operational contract),
`docs/reports/g6-m3d-creator-discovery-2026-08-30.md` (evidence).

## 3. Recovered M5C contract

**Purpose.** Answer "how did this person come to Watchside" as a durable,
server-authoritative fact, kept strictly apart from "who invited them".

**Required behaviour.**

- A campaign link carries **one opaque code and nothing else**; what the
  campaign *means* resolves server-side from a registry the visitor cannot write
  to.
- **First touch is immutable** and is what every report joins on; last touch is
  kept separately. A later click never overwrites the origin.
- The pre-auth touch lives in extension storage for **seven days**, then
  expires — so attribution survives the install/onboarding boundary, which is
  the only boundary that matters.
- **Clicks, Store views and installs are unobservable** without cross-site
  tracking, which Watchside does not do. Every number is "acquired users we could
  attribute", never "clicks".

**Non-goals:** cross-site tracking, fingerprinting, ad-tech SDKs, a second hop of
viral lineage, and any claim about traffic Watchside never saw.

**Source:** `docs/reports/m5c-acquisition-attribution-2026-09-01.md`.

## 4. Why they were paired

They are the two halves of one funnel and were **written before either could
observe anything**. M5C explains how somebody arrived; M3D explains what
happened when they acted. Pairing them here is correct for a different reason
than originally planned: **v0.8 is the first build carrying either**, so this is
the first moment both are live, and the first moment their measurement
weaknesses cost anything real.

Both reports state their own blocking condition in the same terms — M5C: *"the
marketing gate stays closed until a build carrying it is distributed."* **That
gate is now open.**

---

## 5. What already existed

Verified against implementation, not prose.

| Piece | Where | State |
| --- | --- | --- |
| M3D relationship observation | `0033_m3d_relationship.sql` | shipped |
| M3D coverage / relationship views | `0034`, `0035` (small cohort), `0036` (numerator) | shipped |
| M3D acceptance harness | `npm run verify:m3d` | shipped |
| M3D contract doc | `docs/M3D-MEASUREMENT.md` | shipped |
| M5C attribution tables + RPC | `0038_acquisition_attribution.sql` | shipped |
| M5C client logic | `src/core/acquisition.ts` | shipped |
| M5C reporting views | `acquisition_actor_v`, `_campaign_v`, `_downstream_v` | shipped |
| Tests | 43 DB + 47 extension (M5C), 4 suites (M3D) | passing |

**Nothing in either contract was unimplemented.** The M5C guardrails in the brief
were checked one by one and all held: first-touch immutability, expiry, a refused
future-dated clock, `BindOutcome` distinguishing `unknown` from `inactive`, and
M3D's denominator explicitly *not* defined by its outcome (`0034` says so in
terms).

---

## 6. What was implemented

### `acquisition_coverage_v` — the denominator

Attributed vs unattributed actors over the **real arrival population**, grouped
by environment and by the build each actor was **first seen on**.

That grain is load-bearing rather than decorative. The acquisition parameter is
read only by builds carrying M5C and **there is no backfill**, so every account
created earlier is permanently unattributable. Folding them in makes a working
campaign look like it is missing most of its arrivals. The split uses
`app_version` already on the event — evidence in the row, not somebody's memory
of a release date.

Rates are **NULL below three actors**, never 0, following the 0035 precedent: a
suppressed rate and a genuinely zero rate must not look alike.

### `acquisition_touch_outcomes_v` — the refusals

`bind_acquisition` has four outcomes and recorded **two**. `unknown` and
`inactive` returned to the caller and wrote nothing, so a campaign link
resolving to no registry row — mistyped on a poster, retired while links still
circulated, forged — was discarded **in silence**.

In the data that is indistinguishable from nobody clicking. *"That campaign
brought nobody"* was therefore the conclusion whether the campaign failed **or
its instrumentation did**.

Refusals are now recorded via a new server-emitted event,
`acquisition_touch_rejected { reason }`. Separate from `acquisition_attributed`
because nothing was attributed, and **carrying no campaign code** — an `unknown`
code has no registry row to name anyway, and 0038's rule that campaign identity
stays off the event stream is preserved.

### Deliberately not built

**No "direct" bucket.** Watchside cannot distinguish somebody who typed the Store
URL from somebody who followed a campaign link whose touch expired. Both are
unattributed; naming either "direct" would invent a fact about people. The column
does not exist, and a test asserts no view grows one.

---

## 7. Product behaviour, analytics semantics, schema

**Product behaviour is unchanged.** No UI, no permission, no host, no user-facing
flow. The only behavioural delta is server-side: two `return`s now record why
they refused.

**Analytics semantics preserved.** `acquisition_attributed` is untouched — same
name, same `{source, touch}`, same values. One event was **added**; the registry
is append-only and `verify-released-clients.mjs` continues to hold that. The new
event is classified `websiteActivity`, matching the event it shadows, so the
Firefox `technicalAndInteraction` boundary is unaffected — still exactly three
diagnostic events, and `privacyAccuracy.test.ts` asserts it.

**Schema:** migration `0040_acquisition_coverage.sql`. Two views, one new event
name, one function redefinition, version → 40. **Additive**: no table, policy,
grant or column change.

**Compatibility with released clients is exact.** `bind_acquisition` still
returns the same four strings, and `core/acquisition.ts` maps them the same way.
**Firefox 0.8.0 is public and calls this function today** — a test asserts all
four values explicitly for that reason.

**Privacy.** No new data category, no new third party, no new host, no code in
the event stream, no IP. `privacyAccuracy.test.ts` (which derives third-party
hosts from source) and `hostPermissions.test.ts` both pass unchanged. The privacy
policy needs **no** amendment: the new event records that a refusal happened, and
the policy's existing analytics description already covers it.

---

## 8. Migrations and production state

`0040` is written, bundled and proved against real PostgreSQL via PGlite. **It
has not been applied to production**, for the same reason `0039` has not: this
environment holds no Supabase credential of any kind. §13.

---

## 9. Adversarial pass — findings

*"What plausible bug would make M3D/M5C metrics look believable while being
wrong?"*

| # | Finding | Status |
| --- | --- | --- |
| **1** | **Campaign reports with no denominator.** Every M5C view conditioned on attribution existing; nothing reported coverage. A campaign explaining 3% of arrivals renders identically to one explaining 90% | **FIXED** — `acquisition_coverage_v` |
| **2** | **Silent refusals.** A broken campaign link and an unclicked campaign produced identical data | **FIXED** — `acquisition_touch_rejected` |
| **3** | **The dated confound.** Pre-M5C accounts are permanently unattributable; folded into one rate they make a working campaign look broken | **FIXED** — grouped by first build seen |
| **4** | **Lexical version ordering.** `min(app_version)` on text calls `0.10.0` older than `0.9.0` | **AVOIDED** — ordered by time; a test uses exactly that pair |
| **5** | **Two destruction levers had gone inert.** Redefining `bind_acquisition` in 0040 left the 0038-targeted levers mutating a superseded copy — reading as defended while defending nothing | **FIXED** — both retargeted |
| **6** | Tautological coverage (denominator drawn from the outcome) | **PRE-EXISTING, HELD** — 0034 avoids it for M3D; 0040 avoids it for M5C, and a lever proves it |

**Finding 5 is the one worth remembering.** It was not found by reasoning — the
mutation harness verifies that each lever still changes behaviour, and reported
two as `UNDETECTED` the moment 0040 superseded the function they targeted. A
harness that checks its own levers is what turned a silent loss of coverage into
a build failure.

---

## 10. Verification

| Gate | Result |
| --- | --- |
| Full suite | **3,124 passed / 129 files** (was 3,108 / 128) |
| Destruction mutations | **103 / 103 detected** (was 100) |
| `npm run lint`, `npm run typecheck` | clean |
| `npm run build` (extension), `build:site` | clean |
| `npm run verify:store` | clean |
| Privacy / third-party host verification | **22 passed** |
| `npm run db:bundle` | 40 migrations, bundle test green |
| Manifest permissions / host permissions | **unchanged** |
| **Chrome v0.8 submitted artifact** | `cb3af261448280cb…` — **byte-identical** |
| Firefox v0.8 artifacts | `ccb9a942…` / `62fff42b…` — untouched |

**New tests:** `tests/db/acquisitionCoverage.test.ts` (15) — coverage against the
real population, the tautology case, build separation, chronological version
ordering, small-cohort suppression, internal-actor exclusion, each refusal
outcome, no code in the event, the four return values released clients depend
on, and the absence of a "direct" column.

**New destruction levers (3):** define coverage by the outcome; discard a refused
touch without recording it; report a rate for a cohort of one. Each was confirmed
to fail the suite before being accepted.

---

## 11. Roadmap corrections

The roadmap described a world that no longer exists, and would have sent the next
reader to rebuild finished work.

| Was | Now |
| --- | --- |
| M3D "**BLOCKED** on an owner decision" | **SHIPPED**, with migrations and acceptance named |
| M3E-b "the precondition, not yet built" | **SHIPPED** as part of M3D |
| "v0.8 — relationship measurement, **BLOCKED**… not currently buildable" | **SHIPPED**; Firefox public, Chrome in review |
| No mention of M5A–M5E anywhere | Listed, with their reports |
| No acquisition-coverage entry | New section explaining the denominator and the blind spot |

Superseded reasoning was **kept where it explains why a decision was made** and
marked as historical, rather than deleted.

---

## 12. Owner action

**None required for this milestone.** Nothing here needs a purchase, a console
change or an irreversible action.

**Carried forward, unchanged:** migration `0039` (M6B operations) and now `0040`
are both written and proved but **not applied to production**, because this
environment has no Supabase credential. They are additive and safe for all
published clients. Applying them needs the same access as the deferred
custom-domain work — cheapest to do in one pass.

---

## 13. What the roadmap says comes next

The pipeline reads:

```
M4.5 → M5 → Store Assets → M6 → M7 PUBLIC LAUNCH
```

M4.5, M5 (A–E), Store Assets, M6A and M6B are all complete. **Next is the rest of
M6 and then M7**, which is gated by G1–G9 in
`m3b-twitch-economic-attribution-2026-08-30.md` §26.9. Against that list today:

| Gate | State |
| --- | --- |
| **G1** `channel_dwell_ended` confirmed emitting **in production** | now *possible* for the first time — Firefox 0.8 is public |
| **G2** repeat-creator analysis (ships with G1) | follows G1 |
| **G3** `experiment_arm` on `authenticated_session_started` | shipped in v0.7 |
| **G4** `following_at_join` **shipped** or loss accepted | **SATISFIED by delivery** (M3D) |
| **G5** `subscribed_at_join` shipped **or** loss explicitly accepted | **OPEN — an owner decision, not work.** M3E-a is HOLD |
| **G6** deletion path before any Twitch-derived write | **SATISFIED** |
| **G7** D7 legal read of the Twitch DSA | **OPEN — counsel** |
| **G8** D8 AMO clarification for `financialAndPaymentInfo` | **OPEN**, blocking G5/M3E-a only |
| **G9** privacy policy updated for every shipped measurement | **SATISFIED** — accuracy pass, `5d3b65b` |

So the launch path is blocked by **three things, none of which is engineering**:
a recorded decision (G5), a legal read (G7), and a question to AMO (G8) — plus
G1, which is now simply a matter of production data existing.
