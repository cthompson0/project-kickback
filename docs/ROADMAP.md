# Kickback roadmap

Where things stand, and — more usefully — what has already been decided so it
does not get re-decided by accident.

**Last updated:** 2026-08-27, at Friends Beta Patch 1.

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
| Developer mode required to install | Solved by Chrome Web Store distribution; the ZIP fallback still needs it |
| **Realtime presence is one binding per friend** | Linear and unavoidable in the current design. Expected to break somewhere between 100 and 250 friends, silently. Unchanged by the multi-destination work |
| **`broadcast()` is undebounced** | Every state change serialises the full snapshot to every tab. Fine at three testers; the first thing to bite at scale |
| **Tab switch and stream navigation are indistinguishable to the backend** | The user experiences them as very different actions; presence treats them identically. The multi-destination model makes closing a tab the stronger signal |
| **The `ohjuliego` group incident has no known cause** | Server-side authorization was eliminated by execution. Telemetry now exists to catch a recurrence. Do not mark it solved without evidence |
| `https://cdn.7tv.app/*` host permission is probably unnecessary | Emote images are `<img>` loads, which do not need one - `static-cdn.jtvnw.net` is the proof, used the same way with no permission. Not removed before submission because the failure mode is silent; permissions can be reduced later without user re-consent |
| Account deletion is a manual email request | Correct and complete, but not self-service. Fine for this cohort, a real gap before public launch |
