# G5 — `subscribed_at_join`: decision pass

**Date:** 2026-09-02
**Type:** DECISION ONLY. No code, no migration, no OAuth change, no roadmap edit.
**Recommendation:** **B — DEFER AND ACCEPT DATA LOSS**, with a stated trigger to
revisit.

---

## 1. The recovered G5 contract

Verbatim, from `m3b-twitch-economic-attribution-2026-08-30.md` §26.9:

> | **G5** | `subscribed_at_join` shipped **or** an explicit recorded owner
> decision to accept permanent loss, with D8's answer on the record | 🔴
> **BLOCKING** (decision or delivery) |

And immediately below it:

> **G4 and G5 are satisfiable by a decision rather than by delivery** — the
> invariant demands that the loss be *chosen and recorded*, not that it never
> happen.

**G5 does not require the feature. It requires that we not lose it by accident.**
That is the whole gate.

### History, in order

| When | Document | Position |
| --- | --- | --- |
| §23 | m3b | **D4: accept permanent loss** — "low volume, weak claim" |
| §26.3 | m3b | **D4 REVERSED — collect it.** The earlier analysis "priced M3E as one indivisible expensive thing when it is two separable things" |
| 2026-08-30 | m3d-m3e-policy-gates | `subscribed_at_join` **does not meet Mozilla's literal definition** of `financialAndPaymentInfo` — but Twitch's DSA calls subscription data *"data about purchases"*. **Ask AMO** (D8) |
| 2026-08-30 | g6-m3d report | **M3E-a HOLD** — D8 unresolved |
| shipped | `src/background/auth.ts`, `docs/M3D-MEASUREMENT.md` | HOLD, and hardened into the code |

### The conflict, and which document wins

§26.3 says "collect it". The shipped implementation says the opposite, in a
source comment that is not ambiguous:

> **WHAT MUST NEVER BE ADDED**
> Anything about subscriptions, purchases or writing to somebody's account.
> Watchside reads one relationship — do you already follow this creator — and
> the scope set is the enforceable statement of that.

**The implementation is the later and the accepted decision**, and it is enforced
by **eight assertions across six test files** (`followBaseline`,
`followPermission` ×4, `relationshipBinding` ×2, `joinRelationshipTrigger`,
`accountDeletion`). §26.3 was a *recommendation gated on D7 and D8*; neither was
ever answered, so the gate never opened and HOLD is where it stayed.

### The assumption that has changed — and it cuts both ways

§26.3's reversal rested on this claim:

> | **M3E-a — baseline** | … | Custody: ❌ **none** — token is in hand in-session |

**That was factually wrong**, and the roadmap says so:

> The M3B and M3D/M3E research reports both asserted the token would be "in hand
> in-session" at the JOIN. That conflated the **Supabase session** (long-lived)
> with the **provider token** (one-shot).

So the reversal was argued on a false premise about cost. **M3D has since built
the custody that premise wrongly assumed unnecessary** — the credential is
captured at sign-in, encrypted with a key held outside the database, refreshed,
and destroyed on de-authorisation. The token half of M3E-a is therefore **already
paid for**. That is the one material change since the original decision, and it
makes the feature *cheaper* than when it was put on hold.

It does not make it cheap. §6.

---

## 2. Relationship to M3D — a different question, not a stronger one

M3D answers: **on a socially initiated JOIN, did this actor already follow that
creator?**

`subscribed_at_join` would answer: **did they already pay for that creator?**

These are different relationships, and the second is not a refinement of the
first. Follow is free, ambient and high-volume; subscription is a financial
relationship with a low base rate. A viewer can follow without subscribing (the
overwhelming majority), and can subscribe without following.

**What subscription state adds that follow state cannot:** it is the only signal
in Watchside's reach that touches **Twitch revenue**. Everything else in the
measurement ladder — exposure, arrival, dwell, repeat viewing, follows — is
attention. Bits, gifting, hype trains, channel points and ad revenue are all
**H3, permanently impossible** for Watchside to observe. So this is the only
economic baseline Watchside could ever establish.

**What it does not add:** any causal claim. §4.

---

## 3. The four cases, honestly separated

| Case | With `subscribed_at_join` | Without it |
| --- | --- | --- |
| Sent to a creator they already pay for | known | unknown |
| Sent to a creator they follow but do not pay for | known (follow ✓, sub ✗) | **partly known** — M3D gives the follow half |
| Sent to a creator they have no relationship with | known precisely | **known** — M3D's `following_at_join = false` already says "no prior relationship" for the free relationship |
| **Social viewing leads to a subscription** | **NOT ESTABLISHED** — see below | not established |

### The fourth case is where this metric is most likely to be oversold

**A baseline alone establishes nothing about conversion.** It is one half of a
two-part observation. To say "Watchside led to a subscription" you need:

1. a baseline of `false` at the JOIN, **and**
2. a later observation that the subscription exists, **and**
3. a defensible reason to attribute the change to the JOIN rather than to the
   creator, the stream, the moment, or the viewer's own intent.

Watchside can build (1) and (2). **It cannot build (3) without randomisation**,
which is L8 — explicitly *not blocking* and needing ~3,000 users.

The strongest honest sentence remains what §26.3 itself conceded:

> *"was not subscribed at the socially-driven JOIN; was subscribed when next
> observed"* — **sequence, bounded by observation, never a revenue figure.**

That is a correlation with a timestamp on it. It is worth something. It is not
"Watchside drove revenue", and the gap between those two sentences is exactly
where this metric would get misused.

---

## 4. Twitch API feasibility — verified against current docs

**Endpoint:** `GET /helix/subscriptions/user?broadcaster_id=…&user_id=…`
("Check User Subscription").

| Property | Finding |
| --- | --- |
| **Scope** | `user:read:subscriptions` |
| **Token** | **User** access token. Not an app token |
| **`user_id`** | *"must match the user ID in the access token"* — you may only ask about yourself |
| **Arbitrary creators?** | **Yes.** `broadcaster_id` is unconstrained; **no broadcaster cooperation or authorization is required** |
| **Not subscribed** | **404** |
| **Response fields** | `broadcaster_id/login/name`, `gifter_*`, `is_gift`, `tier` |
| **Timestamp** | **None. There is no subscription start date, and no history endpoint** |
| **Prime** | **Not distinguishable.** Prime and paid Tier 1 are both `tier: "1000"` |
| **Rate limits** | Per client-id **per user** — each viewer's handful of calls is in their own bucket. Not a constraint even at 10,000 DAU |

**So the answer to the sharpest question in the brief is: yes, Watchside could
query this reliably for arbitrary creators without broadcaster cooperation.** The
API is not the obstacle. One historical caveat: `twitchdev/issues#344` recorded
the advertised scope failing on this endpoint; it is marked resolved, but it
would need a live check before anyone relied on it.

**The absence of a timestamp is the load-bearing fact.** It is what makes this
H2 — irrecoverable — rather than H1 like `following_at_join`, which is partly
reconstructable because `Get Followed Channels` returns `followed_at`.

---

## 5. OAuth and token implications

| Question | Answer |
| --- | --- |
| Is M3D custody sufficient? | **For the token mechanics, yes.** Capture, encryption, refresh, revocation and deletion all exist |
| New scope required? | **Yes** — `user:read:subscriptions`, added to `REQUESTED_SCOPES` |
| Would existing users need to re-authorize? | **Yes, every one of them.** A Twitch grant is fixed at authorization; a new scope needs a new consent |
| Is there machinery for that? | **Yes.** `twitch_credentials` already carries `scopes text[]` and `status … check (status in ('active','needs_reauthorization'))`, and a `needs_follow_permission` upgrade path already exists as precedent |
| Twitch developer console change? | **No.** Scopes are requested per-authorization, not registered |
| Consent experience | A second line on Twitch's consent screen, naming subscriptions |
| New failure modes | Partial grants (Twitch completes a flow with fewer scopes than asked), 404-as-negative vs 404-as-error, and a third "absent" state on token expiry — all of which M3D already models |

**The schema anticipated this.** `creator_relationship_observations` declares
`relationship_type text not null default 'follow' check (relationship_type in
('follow'))` — an enum with one member, sized for a second. Adding
`'subscription'` is one line.

---

## 6. Privacy and store implications

| Surface | Impact |
| --- | --- |
| Privacy policy | **Substantial.** "The one check Watchside makes with it", "the only Twitch permission Watchside asks for beyond signing you in", and the Permissions section all become false. A new section on subscription state, retention and deletion is required |
| **Firefox AMO** | **The genuine risk.** If AMO rules subscription state is `financialAndPaymentInfo`, that is a **new REQUIRED data-collection category** |
| Chrome Web Store | Privacy-practices declaration update. No new permission, no host permission, ID unchanged |
| Twitch DSA | Twitch-derived → already covered by the per-user deletion path built for M3D. **No incremental deletion work** |
| Data classification | A new Twitch-derived category, governed by delete-on-revocation like `following_at_join` |

### The Firefox consequence is worse than a form field

This repository has already established, and acted on, the Firefox asymmetry:

> Removing a required permission in an update is silent and free. **Adding one
> makes Firefox disable the extension until the user re-approves it.**

If `financialAndPaymentInfo` is required, then every existing Firefox user is
**disabled until they re-consent** — *and* must separately re-authorize on Twitch.
**Two consent walls**, at the exact moment Watchside is trying to establish
first-run activation, on a base that has been public for days.

And the policy-gates report already found the declaration itself would be
misleading:

> Over-declaring is not the safe default here. A Firefox prompt naming financial
> and payment information, for a product that stores one boolean about a
> streamer relationship, tells users something untrue in the other direction.

**D8 was never asked.** Mozilla publishes no category-choice guidance, so this is
genuinely unresolved — not a lookup somebody skipped.

---

## 7. Permanent data loss — the honest accounting

**Can it be reconstructed later?** **No.** No timestamp, no history endpoint, no
EventSub for subscription start. Firmly H2.

**Could current state be mistaken for historical state?** **Yes, and this is the
trap.** A check run today returns "subscribed" with no indication of since when.
Without a baseline, *"subscribed for three years"* and *"subscribed because of
Watchside"* are the same observation. Anyone reading current state as historical
state would be wrong in the flattering direction.

**Which cohorts become permanently incomplete?**

Here is the part that changes the decision, and it was not stated in the original
analysis:

> **The loss is per-JOIN, not per-user.**

`subscribed_at_join` is recorded per socially attributed JOIN. A user who joins
today and joins again after instrumentation ships **still produces baselines from
that point on**. Deferring does not write anyone off; it loses the baselines for
JOINs made in the gap.

Contrast M5C acquisition, where first touch happens **once per account, forever** —
that loss genuinely is per-user, which is why M5C was worth building before
distribution and this is not.

**The one genuinely permanent per-user loss** is narrow: a viewer who was *not* subscribed
during the gap, subscribes during the gap, and is already subscribed at their
first measured JOIN. That conversion is invisible forever. **The size of that
population is the number of Watchside-driven subscription conversions occurring
in the gap** — which at the current installed base is approximately zero, and
which is the quantity the metric exists to measure in the first place.

**Is the loss strategically meaningful at Watchside's current stage?** **No.**
It becomes meaningful when the user base is large enough that conversions happen
at a measurable rate. That is the trigger, and it is not today. §10.

---

## 8. Implementation cost: **MEDIUM** (engineering) / **LARGE** (rollout)

| Component | Cost | Why |
| --- | --- | --- |
| Schema | **TRIVIAL** | One value on an existing CHECK; the table was built for it |
| Server / Edge Function | **SMALL** | A second call beside the follow check, same credential, same decrypt path |
| Client | **SMALL** | The JOIN trigger and readiness model already exist |
| Analytics | **SMALL** | One property or one `relationship_type` value; registry is append-only |
| Token handling | **SMALL** | Custody exists; `scopes[]` and `needs_reauthorization` exist |
| Tests | **MEDIUM** | Eight assertions in six files exist **specifically to prevent this**. They are not obstacles to route around — they encode the decision, and reversing it means rewriting each one deliberately |
| Privacy documentation | **MEDIUM** | Several load-bearing sentences become false |
| **OAuth re-authorization** | **LARGE** | Every existing user, on Twitch |
| **Firefox re-consent** | **LARGE, and conditional on D8** | Possibly disables the add-on for every Firefox user until re-approval |
| Store review | **MEDIUM** | New Chrome submission and new AMO submission, both after Chrome 0.8 clears |

**Engineering is genuinely MEDIUM** — M3D did the hard part. **The rollout is
LARGE**, and it is LARGE in the one currency Watchside cannot spare right now:
existing users being asked to consent twice.

---

## 9. Adversarial pass — what would make this metric look valuable and mislead

| # | Failure mode | Severity |
| --- | --- | --- |
| **1** | **Prime is indistinguishable from paid Tier 1** — both `tier: "1000"`. "Subscribed" therefore does not mean "paid". A Prime sub costs the viewer nothing marginal, and the economic claim silently absorbs them | **HIGH** — it is the flagship claim that weakens |
| **2** | **Gifted subs are somebody else's economic act.** `is_gift` flags them, but a conversion counted from a gift measures the gifter's behaviour, not the viewer's | **HIGH** |
| **3** | **Current-state-as-historical-state.** Without a baseline, an observed subscription is uninterpretable — and *with* a partial baseline it is worse, because it looks interpretable | **HIGH** |
| **4** | **Lapse and resubscribe is invisible.** sub → lapse → resub reads as one continuous subscription. Between two checks, Watchside sees a boolean, not a history | **MEDIUM** |
| **5** | **Correlation with existing fandom.** People JOIN creators their friends watch, and friends share taste. A high "already subscribed" rate measures homophily in the friend graph, not Watchside | **HIGH** — and it will look like a strong result |
| **6** | **Tiny cohorts.** M3D and M5C both suppress rates below three actors. Subscription conversion has a low base rate on a small base; the honest output would be NULL for a long time, and the temptation to lower the threshold would be strongest exactly where it is least safe | **HIGH** |
| **7** | **404 conflation.** "Not subscribed" and "the call failed" are both non-200. Collapsing them fabricates negatives — which inflate conversion, since a false `false` baseline creates a conversion that never happened | **HIGH**, and fully preventable — M3D's three-state model already handles it |
| **8** | **Selection into measurement.** Only users who granted the scope are measurable, and grant is correlated with enthusiasm. The measured population is the keenest users | **MEDIUM** |

**Findings 1, 5 and 6 together are decisive.** A first result reading *"38% of
socially driven JOINs were to creators the viewer already subscribed to"* would be
presented as evidence Watchside reaches committed fans — when it may be
homophily, Prime, and a cohort of nine people. The metric is not
self-interpreting, and at this scale it is more likely to mislead than inform.

---

## 10. Launch tradeoff

The brief's own test: a theoretically useful metric should not block launch
unless **all four** hold.

| Test | Verdict |
| --- | --- |
| 1. Captures permanently lost information | **YES** — H2, genuinely irrecoverable |
| 2. That information is strategically important | **NOT YET.** It is per-JOIN, not per-user, and the population of gap-window conversions is ~0 at the current base |
| 3. Technically reliable | **PARTLY.** The API works; the *interpretation* does not, at this scale — §9 |
| 4. Implementation/review/privacy cost justified | **NO.** Two consent walls for every existing user, an unanswered Mozilla question, and two store reviews |

**One of four.** That is not a launch blocker; that is a thing to build when the
base can support the analysis.

The cost of delaying launch is concrete and immediate: Watchside has been public
on Firefox for days, Chrome 0.8 is still in review, and **M3D and M5C have
between them observed almost nobody**. The binding constraint on Watchside's
measurement programme right now is *users*, not *instruments*. Adding a metric
that requires re-consent from the few users there are, to measure an event that
is currently near-zero-frequency, spends the scarce resource to improve the
abundant one.

---

## 11. Recommendation: **B — DEFER AND ACCEPT DATA LOSS**

### What we knowingly lose

**For every socially attributed JOIN between now and whenever `subscribed_at_join`
ships: whether the viewer already had a paid relationship with that creator.**
That fact has no timestamp and no history endpoint. It cannot be reconstructed,
inferred, or bought back later.

Concretely, the permanent loss is: **viewers who convert to a subscription during
the gap will be indistinguishable from viewers who were already subscribed.**
Their conversions are invisible forever.

### Why that is acceptable

1. **The loss is per-JOIN, not per-user.** Every user still measurable from the
   day it ships. Deferral costs a window, not a cohort — which is precisely the
   opposite of M5C, where first touch happens once per account and *was* built
   before distribution for exactly that reason.
2. **The lost quantity is currently near zero.** The thing lost is
   Watchside-driven subscription conversions during the gap. Watchside went
   public days ago. There is very little to lose right now, and the amount grows
   with the user base — which is the trigger, §12.
3. **At this scale the metric would mislead.** §9: Prime conflation, homophily,
   and cohorts below the suppression threshold. A number that cannot be safely
   interpreted is not evidence, and shipping it early buys the *appearance* of
   economic measurement while the honest output stays NULL.
4. **The price is paid in the currency we cannot spare.** Twitch
   re-authorization for every user, plus — if D8 rules `financialAndPaymentInfo`
   required — Firefox **disabling the add-on** until re-consent. At the activation
   stage, that is the most expensive thing on the table.
5. **D8 was never asked, and Mozilla publishes no guidance.** Shipping into an
   unanswered classification question risks a declaration that is wrong in either
   direction — and the policy-gates report already found over-declaring would
   itself misinform users.
6. **The causal claim needs L8 regardless.** Randomised lift needs ~3,000 users
   and is explicitly not blocking. Until then the baseline supports sequence, not
   causation — so the flagship sentence is unsayable for other reasons anyway.

**Not C.** This is the only economic baseline Watchside can ever establish; Bits,
gifting, hype trains and ad revenue are permanently out of reach. Dropping it
forecloses the one revenue-adjacent argument the product could ever make. The
signal deserves a place in the measurement model — just not before the product
has users to measure.

---

## 12. Owner and engineering actions if B is accepted

**Owner — one decision to record, and it is the gate itself:**

> **G5: `subscribed_at_join` is deferred. We accept that subscription state at
> JOIN is unrecoverable for every JOIN before it ships, and specifically that
> conversions occurring in that window are permanently invisible.**

G5 asks for exactly this: *"an explicit recorded owner decision to accept
permanent loss."* Recording it satisfies the gate.

**On D8:** G5's wording says *"with D8's answer on the record."* Read strictly
that would require asking AMO before deferring. **I recommend reading it as
attaching to delivery, not to deferral** — D8 asks how to *declare* data
Watchside would collect, and deferral means collecting none of it. There is
nothing to declare and no answer to record.

**This has a second effect worth stating plainly: accepting B closes G8 as well.**
G8 is *"BLOCKING for M3E-a only"*. With M3E-a deferred, G8 blocks nothing. **One
decision retires two of the four outstanding launch gates.**

**Engineering — nothing now.** Do not add the scope, the value, the migration or
the tests. The eight assertions preventing subscription scope should **stay
exactly as they are**; they are the mechanism that keeps this decision true.

**The revisit trigger — this is the part that makes deferral honest rather than
convenient:**

Reopen G5 when **either**:
- Watchside passes **~1,000 monthly active users with a measurable social JOIN
  rate** — the point at which conversions occur often enough to clear the
  small-cohort threshold and the loss starts compounding; **or**
- a randomised lift experiment (**L8**) becomes viable, since subscription
  baseline is worth far more inside a randomised design than outside one.

At that point the decision should be re-made on the same four tests, with D8
asked first.

---

## 13. What happens to the M7 gate

| Gate | Before | After accepting B |
| --- | --- | --- |
| **G5** `subscribed_at_join` | 🔴 open | ✅ **satisfied by recorded decision** |
| **G8** D8 AMO clarification | 🔴 open (M3E-a only) | ✅ **moot — nothing to declare** |
| **G1** dwell confirmed in production | 🔴 open | unchanged — needs production data, now possible |
| **G7** D7 Twitch DSA legal read | 🔴 open | unchanged — **still required** |

M7 would then be blocked by **G1 (data, not work)** and **G7 (counsel)**.

**One flag outside this pass:** G7 is recorded as *"BLOCKING for M3D/M3E-a"*, and
**M3D shipped while G7 was still open.** That is a pre-existing inconsistency
between the gate list and what was released, not something this decision creates —
but it should be resolved deliberately rather than noticed later.
