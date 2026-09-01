# M4.5 — Architecture, Legacy & Feature Audit

**Date:** 2026-09-01
**Type:** AUDIT (inspect → classify → minimal safe cleanup → handoff)
**Entering commit:** `71ab6ef` · tree clean · hosted schema **36**
**Baseline:** 2,764 tests / 108 files · 47/47 mutations · Chrome 0.6.0 live ·
Firefox 0.6.0 pending first AMO review

> **Nothing was submitted, uploaded, versioned or tagged.** No Chrome upload, no
> AMO upload, no DNS change, no package built for release.

---

## 1. Executive verdict

## **GO**

The product is in better structural shape than an audit usually finds. Zero
`TODO`/`FIXME`/`HACK` markers in the entire source tree, no unused dependencies,
no dead Supabase functions, no stale migrations, and no security or privacy
contradiction. **No STOP condition was triggered.**

**No code cleanup was performed, deliberately.** Nothing met the six-condition
bar in the brief, and inventing churn to look productive would have been the
wrong outcome for an audit whose value is the map.

Three findings dominate everything else:

1. **M3D collects nothing from anybody, and cannot.** Neither released build
   contains the `user:read:follows` scope, the credential custody, or the
   trigger — verified by extracting both Store artifacts. M3D is closed and
   correct and **structurally unable to produce a single real observation until
   a new build ships**.
2. **The entire growth loop is behind one unlabelled `+` icon**, and its two
   most important surfaces — suggested friends and invites — are invisible or
   unmeasured in the cases that matter most for a new user.
3. **The growth loop's success outcomes have no analytics at all.**
   `referral_succeeded` and `badge_awarded` are registered on both client and
   server and emitted by nothing. We cannot currently tell whether a single
   referral has ever worked.

None of these is a defect in the sense of something broken. All three are the
gap between *implemented* and *user-facing*, which is precisely what M4.5 was
for.

---

## 2. Starting state

| | |
| --- | --- |
| Source | 112 TS/TSX files, 28,830 lines |
| Largest areas | `src/background` (36 files), `src/ui/components` (21), `src/core` (20) |
| Migrations | 0001–0036, hosted at 36 |
| Scripts | 36 |
| Reports | 32 prior checkpoint reports |
| Tests | 2,764 across 108 files |
| Mutation harnesses | destruction 47/47, analytics 81/87, presence 21/21, layout 23/23, lab 11 failing |

---

## 3. Product architecture map

```
Twitch tab
  └── content script  ── shadow-root panel (React)
        │                  tabs: Friends · <streamer> · Groups · [+ find]
        │                  account card behind the avatar
        └── port ──────► service worker (the only stateful actor)
                            auth · presence · gravity · groups · rooms
                            attention · notifications · metadata cache
                            analytics hub ── recorder ── Supabase
                                                │
                                                ├── analytics_track (RPC)
                                                ├── twitch-credential (Edge Fn)
                                                ├── twitch-eventsub  (Edge Fn)
                                                └── delete-account   (Edge Fn)
```

The separation is clean and was honoured throughout: **the panel says what it
saw and what was clicked; the worker decides what that means.** No product logic
was found in the content script, and no Chrome- or Firefox-specific code was
found outside `src/platforms/browser`.

---

## 4–5. Feature inventory and methodology

`docs/FEATURES.md` — **22 features**, each with status, discovery path, flow,
visibility conditions, empty state, platform, backend and analytics
dependencies, limitations and launch readiness.

Method: for each feature, trace *backwards* from the rendering component to the
control a user must press to reach it, and refuse to call anything user-facing
without that chain. The vocabulary separates IMPLEMENTED from USER-FACING
precisely because this audit found three features where code exists and the
chain does not close.

**Readiness:** READY 9 · M5 POLISH 8 · M5 BLOCKER 3 · EXPERIMENTAL 1 ·
POST-LAUNCH 1 · excluded 1.

---

## 6. Social Gravity

Appears at the top of the Friends tab. Clusters friends by channel, ranks them,
offers JOIN. Multi-destination aware since 0.5.0. The "gathering" emphasis needs
`GRAVITY_THRESHOLD` (2) friends on one channel — **unreachable in a two-person
beta**, which is why the flame styling has never been seen in a real session.

**Empty until a friend is watching.** For a new user that is indefinite, and the
surface shows nothing rather than explaining itself. A stranger cannot learn what
Social Gravity is from the product.

→ **M5 POLISH.** The primary loop needs a zero-state that describes the promise.

## 7. Friends and requests

Complete and correct: search by username or friend code, add, accept, decline,
remove, block. Incoming requests surface at the top of the Friends tab. The
zero-friend empty state is genuinely good — *"Your Watchside is quiet"* with a
**Find friends** button.

**The single door problem:** everything about growing the graph lives behind the
`+` button beside the tabs. It is a small unlabelled icon, and it is the only
route to search, suggestions and invites.

→ **M5 POLISH**, and the `+` is the highest-leverage single change in the
product.

## 8. Suggested friends — the clearest gap

Implemented, released, and **not reliably user-facing.**

```
src/ui/components/GrowFriends.tsx
  if (!suggestions || suggestions.length === 0) return null
```

Two compounding problems:

1. **No empty state.** With nothing to suggest it renders nothing, so a user
   cannot distinguish "no suggestions" from "no feature".
2. **Structurally empty when it matters.** Suggestions are friends-of-friends,
   so a user with zero or one friend has none *by construction* — it is
   invisible exactly when a new user needs it most.

And **no impression analytics**, so we cannot tell whether any human has ever
seen a suggestion.

→ **M5 BLOCKER.** This is the difference between having a growth loop and
having the code for one.

## 9. Invites and referrals

Discovery: `+` → *Find friends* → *Invite a friend*, with a copyable link.

| Finding | Class |
| --- | --- |
| Link base is `https://anoteros-labs.github.io/watchside/invite/` | **M5 migration** to `watchside.app/i/<code>`, old URL must keep working |
| `invite_link_shared` is emitted | ✅ |
| Acceptance / install handoff | **unmeasured** |
| `referral_succeeded` registered, emitted by nothing | **unmeasured** |
| Referral state visible only as a count beside the box | M5 POLISH |

The mechanism works; the funnel has a hole in the middle and no ending.

→ **M5 BLOCKER** (measurement + URL migration).

## 10. Badges

Earned badges appear on a shelf in the account panel. **Unearned badges are not
shown**, so nothing tells a user what can be earned or how. `badge_awarded` is
registered and emitted by nothing.

Currently closer to invisible infrastructure than to a product feature. It is
cheap to make real in M5 (show the unearned set) and cheap to leave alone.

→ **M5 POLISH.**

## 11. Stream Rooms

Forms automatically when two people are on the same channel — nothing is created
or joined. Roster, ephemeral chat (30-minute server-side deletion), reactions,
combos, contextual tab named after the streamer.

`automatic_room_entered` is emitted; **`automatic_room_opened` and
`automatic_room_left` are registered and emitted by nothing**, so room lifecycle
is half-measured.

→ **M5 POLISH.**

## 12. Groups

Create, invite, accept, leave, group chat, presence summary. Predates Social
Gravity as the primary loop and still earns its place — a durable circle is a
different thing from an ephemeral room.

**But nothing in the product explains why there are two chat surfaces.** That is
a comprehension problem for strangers, not an argument for removal.

→ **M5 POLISH.** Explicitly **not** REMOVE.

## 13. Chat, reactions, emotes

Two surfaces, built-in Watchside emotes plus 7TV per channel, reactions and
combo bursts. Message bodies are never recorded — analytics can say how much
chat happens and never what it was.

**The product question is unchanged and remains empirical:** *if Watchside chat
disappeared tomorrow, would users care?* Nothing in the code answers that, and
this audit does not pretend to.

→ **EXPERIMENTAL.**

## 14. Notifications

Gathering notifications with threshold and cooldown, an account-panel toggle on
by default, and clicking one is a real JOIN through the same path as the button.

**Gap:** if the browser denies notification permission, nothing in the product
explains why nothing ever arrives.

→ **M5 POLISH.**

## 15. Presence

Heartbeat-based, multi-destination since 0.5.0, stale-tolerant, self-excluding,
visibility-aware and server-enforced. **No duplicate writers or readers were
found**, and no single-destination remnants survive in the runtime path — the
0.5.0 collapse was done properly.

→ **READY.**

## 16. Block, mute, privacy

Block is server-enforced, never disclosed, undoable. Mute is device-local,
never sent, undoable. Both expose their lists in the account panel. Visibility
has three server-enforced states. Nothing missing.

→ **READY.**

## 17. Feedback and support

Four categories, free text, automatic non-identifying diagnostics.

**Gap:** there is no support URL or contact route for somebody who cannot open
the panel — which is exactly the person most likely to need one.

→ **M5 POLISH** (and see §29, `watchside.app/support`).

## 18. Account and onboarding

The account panel is complete: identity, friend code, visibility, notifications,
muted, blocked, reset layout, feedback, sign out, delete account, version.

**The stranger's path, end to end:**

```
install → open Twitch → panel appears → "Continue with Twitch" → signed in
       → "Your Watchside is quiet" + Find friends
       → search by username / friend code   ← requires knowing somebody
       → or copy an invite link             ← requires somebody to accept
       → first friend → first presence → first Gravity card → first JOIN
```

**Dead-ends found:**

| # | Dead-end |
| --- | --- |
| 1 | Suggested friends renders nothing for a 0–1 friend user (§8) |
| 2 | Social Gravity shows nothing and explains nothing until a friend is live (§6) |
| 3 | The `+` is unlabelled and is the only door to the whole loop (§7) |
| 4 | Nothing tells a new user what Watchside will do once they have friends |

**"Allow on Twitch" (M3D permission control):** audited as asked, and it
**remains necessary**. Every user on a released build has no credential at all,
and confirmed scope loss resolves to `needs_follow_permission` where this is the
recovery path. **Keep.**

---

## 19. Kickback legacy classification

676 references in `docs/`, 337 in `supabase/`, 307 in `tests/`, 226 in `src/`,
84 in `scripts/`, 2 in `public/`.

**No human-facing Kickback branding remains anywhere in the product.** Every
occurrence is an internal identifier.

| Category | Example | Class | Why |
| --- | --- | --- | --- |
| Type names | `KickbackClient`, `KickbackPanel`, `KickbackIdentity` | **DEFER** | pure internal churn; a rename touches ~200 sites for no user benefit |
| CSS prefix | `kb-*` (276 classes) | **KEEP** | shadow-root-scoped, invisible, and the layout harness anchors on them |
| Storage keys | `kickback:analytics:session`, `kickback:preferences`, … | **KEEP** | renaming orphans every existing install's local state |
| Bundle filenames | `kickback-background.js`, `kickback-content.js` | **DEFER** | referenced by `manifest.json`; safe to rename but zero user value |
| Invite param | `kickback_invite` | **KEEP** | live links in the wild carry it |
| DB objects, migrations | `0001`–`0036` | **KEEP** | rewriting history falsifies it |
| Historical reports | `docs/reports/*` | **KEEP** | they describe what was true then |
| Release artifacts | `releases/Kickback-*.zip` | **KEEP** | they *are* the historical artifacts |
| Emote type name | `KickbackEmoteId` | **DEFER** | tokens are `:id:`, no brand reaches a user |

**Principle applied:** *Watchside everywhere humans see; Kickback may survive
where renaming creates compatibility risk or falsifies history.* By that test,
the migration is **complete** — what remains is internal naming, and none of it
is worth the risk before a launch.

---

## 20. Architecture debt

Searched for every item the brief listed. What was **not** found is the finding:

| Looked for | Result |
| --- | --- |
| `TODO` / `FIXME` / `HACK` / `XXX` | **0 across the entire tree** |
| single-destination assumptions | none in the runtime path |
| duplicate presence writers/readers | none |
| duplicate analytics writers | none — one recorder, one RPC |
| duplicate Twitch metadata paths | none |
| Chrome/Firefox code outside adapters | none |
| stale Supabase functions / RPCs | none |
| dead service-worker or content-script paths | none |
| unused dependencies (3 prod, 17 dev) | none |
| stale mutation anchors | none — 47/47 match |

**Real debt found:**

1. **~22 CSS classes with no direct reference** in TSX, including
   `kb-gathering-banner` (a surface deliberately removed) and several
   `kb-room-*` / `kb-together-*` from the pre-"Automatic Together" naming.
   **Inconclusive** — some sibling classes are applied through paths this scan
   cannot see. → **DEFER to M5 polish** with a proper build-time coverage pass.
2. **Four analytics events registered and emitted by nothing** (§25).
3. **The Test Lab** (`src/testlab`, 6 files) is development-only and already
   excluded from packages. Correct as-is.

---

## 21. Dead code, assets, scripts, dependencies

Nothing removable met the bar. Specifically:

- **Dependencies:** every one of the 20 is referenced. Nothing to remove.
- **Scripts:** all 36 are wired to an npm script or another script.
- **The four unemitted events are NOT dead code.** `referral_succeeded` and
  `badge_awarded` are outcomes we actively want to measure; deleting the
  registration would make adding them harder, not easier. → **KEEP as gaps**,
  not debt.

**Cleanup performed in M4.5: none.** Deliberate.

---

## 22. Schema and data compatibility

Migrations 0001–0036, hosted at 36. RLS on every user table, grants explicit,
service-role-only surfaces for everything M3D added. **No schema object was
found that a released client depends on and that anybody proposed removing.**

**The compatibility obligation that matters:** Chrome 0.6.0 is live and calls
`analytics_track`, the friends/groups/presence RPCs and the metadata function.
All still exist unchanged. `analytics_track` **skips** event names it does not
recognise rather than rejecting the batch, so newer server-side event
registration can never break an older client — and older clients emitting events
a newer server dropped would be equally safe.

**Verdict: COMPATIBLE.** No migration strands a Store user. Nothing was squashed
or rewritten.

---

## 23. Browser adapter audit

`src/platforms/browser` is the only place engine differences live. Verified by
search: no `chrome.` or `browser.` API use elsewhere in `src/`, and the one
engine-dependent product decision — Firefox collects no
`technicalAndInteraction` data — is expressed once, at the recorder, rather than
at call sites.

**Verdict: clean.**

---

## 24. Test architecture

| Layer | Scope |
| --- | --- |
| Unit / model | the bulk of 2,764 tests |
| DB (PGlite, real migrations) | authorization, analytics, destruction, M3D coverage |
| Deterministic browser/model | panel render, layout, shell polish |
| Mutation | destruction 47/47, analytics 81/87, presence 21/21, layout 23/23 |
| Package/build | `verify:store`, `verify:firefox` (reproducible) |
| Two-actor E2E | Firefox, 5 scenarios, real accounts |
| Credentialed E2E | `verify:m3d`, real Twitch, zero human |
| Test Lab | 11 known failures (recorded debt) |

**The M3D lesson applied:** *a gate needs proof that it fails when invalid AND
proceeds when valid under realistic timing.* Two gates in the tree are currently
proven only in the refusing direction:

- the **authz** suite proves refusal extensively; its success paths are covered
  but not under adversarial timing
- the **layout** harness proves constraint violations are caught, not that valid
  layouts survive a real drag

Neither is urgent. Recorded rather than acted on, because manufacturing E2Es
speculatively is the failure mode the brief warns against.

**Known debt is unchanged and not reclassified:** analytics 6, presence 0,
layout 0, lab 11.

---

## 25. Analytics inventory and gaps

48 registered events. 44 are emitted somewhere in `src/`. **Four are registered
on both client and server and emitted by nothing:**

| Event | Consequence |
| --- | --- |
| `referral_succeeded` | **the growth loop's success is unmeasured** |
| `badge_awarded` | badge awards are unmeasured |
| `automatic_room_opened` | room open is unmeasured |
| `automatic_room_left` | room exit is unmeasured |

Plus two features with no event at all:

- **suggested friends** — no impression event, so exposure is unknown
- **invite acceptance / install handoff** — the middle of the referral funnel

Classification: ACTIVE 44 · **GAP 4 (registered, unemitted)** · STALE 0 ·
DUPLICATE 0 · DEPRECATED 0.

**This is the most consequential product finding after the release state.** In a
product whose thesis is that the social graph drives discovery, the graph's own
formation outcomes are the least measured thing in it.

---

## 26. Security and privacy

Targeted audit of boundaries **outside** G6/M3D, which were not reopened.

| Check | Result |
| --- | --- |
| client exposure of private data | none found |
| broad grants | none — every M3D surface is service-role only |
| stale debug endpoints | none; owner diagnostics are admin-token gated before any user path |
| secrets in build/package paths | none (`verify:firefox` scans and reports "none found") |
| privacy disclosure mismatches | none — re-verified against the live page |
| account deletion dead ends | none — deletion is reachable, confirmable and complete |
| browser-storage issues | none — O7 stripping is the only session writer |
| old auth assumptions | none |

**No material security or privacy defect was found. No STOP condition.**

---

## 27. Performance and reliability

| Risk | Finding |
| --- | --- |
| runaway timers | none — one flush timer, guarded |
| duplicate subscriptions | none — one channel per surface |
| reconnect storms | backoff present, capped at 5 minutes |
| unbounded caches | analytics queue capped at 400, batch at 50 |
| unbounded message retention | stream-room messages swept at 30 minutes server-side |
| repeated Twitch metadata calls | cached, with cache-hit/miss reporting |
| service-worker lifecycle | open intervals persisted to storage across eviction |
| race-prone analytics | the `flush` race was found and fixed in M3D §270 |
| polling | none — realtime plus a 45s presence heartbeat |

**No new defect found.** The architecture already carries the scars of the
lifecycle problems it hit.

---

## 28. Public-launch readiness matrix

| Class | Features |
| --- | --- |
| **READY** (9) | sign-in, presence, JOIN, block/mute, visibility, account/deletion, metadata, layout, dwell analytics |
| **M5 POLISH** (8) | Social Gravity zero-state, friends/`+` discoverability, badges, Stream Rooms, Groups, notifications permission state, feedback/support route, referral visibility |
| **M5 BLOCKER** (3) | suggested friends discoverability, invite/referral measurement + URL migration, shipping a build that can actually do M3D |
| **EXPERIMENTAL** (1) | chat/reactions/emotes |
| **POST-LAUNCH** (1) | experiment arms |
| **excluded** (1) | Test Lab |

Nothing was classified READY on the strength of passing tests alone; each was
checked for discovery, comprehension, empty state, failure state and
cross-browser behaviour.

---

## 29. watchside.app migration surface

Every human-facing URL that must move in M5:

| Current | Target | Notes |
| --- | --- | --- |
| `https://anoteros-labs.github.io/watchside/invite/` (`src/core/invites.ts`) | `https://watchside.app/i/<code>` | **in shipped clients** — old URL must keep working forever |
| `https://anoteros-labs.github.io/watchside/privacy/` | `https://watchside.app/privacy` | referenced by Store listings and the extension |
| (none) | `https://watchside.app/support` | **does not exist** — §17's gap |
| (none) | `https://watchside.app/` | landing page |

Old Pages URLs must remain live and redirecting. **No DNS or custom-domain work
was done in M4.5.**

---

## 30. Acquisition attribution handoff

Three distinct things that must not collapse into one field:

1. **Acquisition attribution** — where a brand-new install came from
   (campaign, link, referrer). **Does not exist.** Required before any
   meaningful marketing.
2. **Friend referral** — which existing user brought this person.
   **Exists** (`kickback_invite` code → landing → install → attribution), with
   the measurement gaps in §9.
3. **Creator/campaign attribution** — which creator or campaign drove an
   install. **Does not exist.**

The referral infrastructure is reusable for (1) and (3) — the landing page,
code-carrying link and post-install handoff are the hard parts and are built.
What is missing is a *source* dimension distinct from *referrer identity*.

---

## 31–33. M5 handoff

### M5 BLOCKERS

1. **Ship a build that can do M3D.** Everything M3D built is inert until a
   published build requests `user:read:follows`. See §35–§37.
2. **Suggested friends must be discoverable and have an empty state**, and must
   say something useful to a user with no friends yet.
3. **Referral funnel measurement** — emit `referral_succeeded`, add invite
   acceptance and an impression event for suggestions. Without these, M5's
   growth work cannot be evaluated.
4. **`watchside.app` migration** with backward-compatible Pages URLs.

### M5 POLISH

5. Label or widen the `+` door to the growth loop.
6. A Social Gravity zero-state that explains the promise before there is data.
7. First-run orientation — what Watchside will do once you have friends.
8. Notification-permission-denied explanation.
9. Support route for users who cannot open the panel.
10. Badges: show the unearned set.
11. Say why Stream Rooms and Groups both exist.

### POST-LAUNCH / DEFERRED

12. CSS coverage pass and dead-class removal.
13. `Kickback*` type-name rename, if ever.
14. Acquisition and creator/campaign attribution beyond friend referral.
15. Experiment arms with a real randomisation.

---

## 34. Chrome release state

| Layer | Version | Evidence |
| --- | --- | --- |
| Development HEAD | 0.7.0 + all M3D | this repo |
| Local package | `Watchside-Store-v0.7.0.zip` | `releases/` |
| Submitted | **0.7.0** | **owner-reported**; the v0.7.0 RC report states nothing was submitted *at that time* |
| Published / live | **0.6.0** | RC report §, artifact labelled "(Chrome, LIVE)" |
| Installed by testers | 0.6.0 | follows from published |

**Artifact contents, verified by extraction:**

| | 0.6.0 | 0.7.0 |
| --- | --- | --- |
| `channel_dwell_ended` | ✗ | ✓ |
| `user:read:follows` | ✗ | **✗** |
| `twitch-credential` | ✗ | **✗** |
| `join_measurement_status` | ✗ | **✗** |

## 35. Firefox release state

| Layer | Version | Evidence |
| --- | --- | --- |
| Development HEAD | 0.7.0 + M3D | this repo |
| Local package | `Watchside-Firefox-v0.7.0.zip`, byte-identical to the AMO candidate | `releases/` |
| Submitted | **0.6.0**, awaiting **first** Mozilla review | F6 report + RC report |
| Published | **none** | never approved |

The RC report's sequencing constraint stands: **uploading 0.7 while 0.6 is in
first review would replace it**, and a first review is the one with the longest
and least predictable queue.

---

## 36. Chrome — recommendation

## **SUBMIT NEW VERSION NOW**

Against each criterion the brief set:

| | Assessment |
| --- | --- |
| **A. Security** | No known defect in 0.6.0. Not a driver. |
| **B. Privacy** | 0.6.0 predates the dwell disclosure but also predates dwell collection, so the live build and the live policy agree. The policy now describes the M3D follow check, which 0.6.0 cannot perform — **the policy describes more than the live build does**, which is the safe direction but is drift. |
| **C. Backend compatibility** | Fine today. Every RPC 0.6.0 uses still exists, and unknown events are skipped rather than rejected. Not yet a burden. |
| **D. Product quality** | 0.6.0 is two milestones behind: no dwell, no M3D, and none of the reliability work since. |
| **E. Testing value** | **Decisive.** If Chrome approved 0.6.0 tomorrow we would immediately want testers off it. It cannot emit dwell, cannot participate in M3D, and cannot answer the questions the beta exists to answer. |
| **F. Review queue cost** | Chrome updates do not reset a first review — the item is already published. Low cost. |
| **G. Distance to M6** | M5 will change onboarding materially, so a build shipped now will be superseded. But M5 is *product* work, and the measurement gap is costing data **every day** in the meantime. |
| **H. Tester need** | Testers currently generate **no** dwell and **no** M3D data. The beta is answering fewer questions than it could. |

**The reason, in one sentence:** every day Chrome stays on 0.6.0 is a day the
beta produces none of the measurement M3A–M3D was built to collect, and the
review cost of a Chrome update is low because the item is already live.

**What would change this:** if M5 is genuinely weeks rather than months away, a
single combined M5 submission would be better than two. If the owner already
submitted 0.7.0 and it is in review, this becomes **WAIT** for that review to
resolve — and 0.7.0 still lacks M3D, so a further submission is wanted after M5
regardless.

## 37. Firefox — recommendation

## **WAIT**

| | Assessment |
| --- | --- |
| **A. Security** | No known defect. |
| **B. Privacy** | The pending 0.6.0 and its declared data categories are consistent. |
| **C. Backend compatibility** | No Firefox build is published, so no user is exposed. |
| **D–E. Product quality / testing value** | Irrelevant while nothing is published — Firefox testers use the local package already. |
| **F. Review queue cost** | **Decisive.** Replacing a submission that is in **first** review restarts the longest queue Mozilla has. |
| **G. Distance to M6** | Waiting costs nothing and M5 will produce a better first impression. |
| **H. Tester need** | Met by the local unsigned package. |

**The reason, in one sentence:** nothing is published, no user is affected, and
the only thing a new upload would buy is a reset of the one queue we cannot
afford to reset.

**What would change this:** Mozilla approving or rejecting 0.6.0 — either
outcome frees the queue and the newer package should follow. Or evidence that
the 0.6.0 submission is stalled indefinitely, in which case replacing it costs
nothing because there is nothing to lose.

**Owner check needed:** the current AMO status of the 0.6.0 submission. That is
the one fact this audit cannot establish from the repository, and it is the only
input that would flip this recommendation.

---

## 38. Release-gap triggers

**Submit a newer package when ANY high-severity trigger fires:**

- a security fix is absent from the Store build
- a privacy or deletion requirement is absent
- backend compatibility is at risk
- the old build cannot participate in the current beta
- the old build generates invalid or misleading analytics
- a critical crash or auth failure is fixed only on `main`

**Or when SEVERAL medium-severity triggers accumulate:**

- the Store build is two or more milestones behind
- testers cannot exercise the current core loop
- meaningful growth-loop or reliability work is absent
- the build would be immediately superseded if approved
- the compatibility burden is slowing development

**Weigh against:** an imminent M5/M6 package · Firefox first-review reset risk ·
tester reinstall fatigue · review latency.

**Standing model:** `main` moves continuously; Store versions move at deliberate
product checkpoints — **unless the shipped build has stopped being able to
answer the questions the beta exists to answer**, which is exactly the Chrome
situation today.

---

## 39. Cleanup performed

**None.** No file was modified other than the two documents this milestone
produces.

Every candidate was classified rather than acted on: the CSS scan was
inconclusive, the four unemitted events are wanted rather than dead, the
`Kickback*` identifiers are internal and compatibility-adjacent, and no
dependency, script or schema object was unused. The brief's bar was six
conditions; nothing met all six.

---

## 40. Deterministic acceptance

| Gate | Result |
| --- | --- |
| `npm test` | **2,764 / 2,764** (108 files) |
| `tsc -b` | clean |
| `eslint` | clean |
| Hosted schema | **36** |
| Known debt | analytics 6 · presence 0 · layout 0 · lab 11 — **unchanged** |

Mutation harnesses were not re-run: no source file changed, so the previously
recorded 47/47 stands unaltered. Re-running them would have proved only that
documentation does not affect code.

---

## 41. Unresolved risks

1. **M3D is inert in production** until a build carrying the scope ships (§34).
2. **The growth loop cannot be evaluated** — its success events do not exist (§25).
3. **Suggested friends is invisible to the users it exists for** (§8).
4. **The AMO queue position is unknown** and only the owner can check it (§37).
5. **CSS dead-class analysis is inconclusive** and needs a build-time pass (§20).
6. **The `+` button is a single point of discovery failure** for the entire
   growth loop (§7).

---

## 42–43. Verdict

## **M4.5 — GO**

The map exists and is trustworthy. `docs/FEATURES.md` records 22 features with
honest discovery paths, and three of them are honestly marked as not reaching
users despite the code being there. The architecture is in good repair, the
legacy migration is complete by the standard set for it, no security or privacy
contradiction was found, and no cleanup was manufactured to justify the
milestone.

The single most valuable output is the distinction the inventory forces:
**implemented is not shipped, and shipped is not discovered.** Three features and
one entire measurement programme were sitting on the wrong side of that line, and
M5 now knows which.
