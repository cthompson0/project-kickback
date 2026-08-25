# Kickback roadmap

Where things stand, and — more usefully — what has already been decided so it
does not get re-decided by accident.

**Last updated:** 2026-08-25, at the final pre-beta checkpoint.

---

## The core loop

```
Presence  →  Social Gravity  →  JOIN  →  Together
```

Everything below is judged against that, and against two filters:

**A — User experience value.** Does this make Kickback meaningfully better for
the person using it?

**B — Incremental platform value.** Does this plausibly create viewing or
activity that would not otherwise have happened?

Infrastructure, reliability, privacy and safety may be mandatory without scoring
on B. Nothing else gets a free pass.

---

## ACTIVE — Private beta

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

---

## Decided, and not to be re-opened without new evidence

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

### Invites — **DEFER**

During the hand-distributed cohort, distribution *is* the invitation. An invite
affordance means "send your friend a way to get Kickback", and there is no such
way while installation is a ZIP.

**Revisit before organic or public distribution.** It becomes P0 the day
Kickback is listed.

### Suggested Friends — **DEFER**

Not implemented, verified against the repository.

In a 4–6 person cluster where everyone knows everyone, friend-of-friend
suggestions surface people already added. It also solves the wrong problem: it
cannot introduce you to somebody who has not installed anything.

**Revisit on beta evidence** about friend density and how people actually
discover each other. Do not build it because social apps have it.

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

- Gravity strong, sessions weak → Kickback is a **discovery** product
- sessions strong, Gravity weak → Kickback is a **communication** product
- both, or neither

All four are real answers. **Discovery value and communication value are kept
analytically separate** in BETA_ANALYSIS.md (§3–6 versus §7) precisely so one
cannot be quietly read as evidence for the other.

### Twitch-native rail — **AUDITED / DEFERRED**

See [twitch-native-surface.md](architecture/twitch-native-surface.md). Feasible;
no blocker found; the overlay strategy makes chat preservation a non-problem.

**Floating remains first-class permanently** — a tester specifically valued
positioning Kickback over Twitch chat. Observe feedback before implementing.

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

The strategic purpose is not feature count. It is to test whether Kickback can
become a cross-platform social layer, and whether that creates strategic
interest among platforms.

### Monetisation — **not during the beta**

Optional Ko-fi/Patreon-style support may eventually exist. Recorded explicitly:

> **DONATIONS ARE NOT THE MONETISATION THESIS.**

Future monetisation must be evaluated against demonstrated Kickback value, not
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
| Developer mode required to install | Inherent to unpacked distribution |
