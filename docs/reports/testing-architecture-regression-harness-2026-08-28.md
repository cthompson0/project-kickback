# KICKBACK — TESTING ARCHITECTURE AND REGRESSION HARNESS

**Date:** 2026-08-28
**Type:** testing architecture milestone + one product UX fix
**Starting HEAD:** `51e1f13` — `docs: record the metadata convergence commit and push`
**Version:** 0.5.0, unchanged
**Hosted analytics schema version:** **25** — unchanged, no migration

No schema, no migration, no backend change, no state-management rewrite, no new
product features, no Gravity/Friends/Rooms/Groups redesign, no Firefox work.
Nothing uploaded.

---

## 1. Executive conclusion

The suite was strong at *"what does this function compute"* and blind to
*"when does it run"*. Every defect that reached a browser this beta was in the
second category, and every one of them lived in code that could not be
imported.

Four things were done, in that order of value:

1. **The one product defect left** — a new Gravity card rendering bare and then
   visibly transforming — is fixed, driven by real metadata state with no timer
   and no arbitrary delay.
2. **A reusable orchestration kit** (`tests/support/orchestration.ts`) makes
   adversarial ordering a one-liner: deferred call queues, fake `runtime.Port`s
   that can be killed the way an evicted worker kills them, and a clock that
   only moves when asked.
3. **The session derivations left the worker.** Five rules that decide whether
   a Stream Room exists were protected only by string-matching `index.ts`. They
   are now importable, and three brittle pins became thirty behavioural tests.
4. **Chromium E2E is specified but deliberately not built**, for a concrete
   blocker: the journeys worth automating need authenticated accounts, and
   running them today would write to the private-beta database. §12.

**Test count is not the result and is not the claim.** 2,037 from 1,990 — +47.
The result is that all four beta regression classes now have a test that fails
deterministically at the layer where the bug actually lived.

**MACHINE: GO. HUMAN: pending** — a 7-minute smoke, §17.

---

## 2. Existing test architecture map

| Layer | Files | What it proves | What it does NOT prove | Cost | Right use |
| --- | --- | --- | --- | --- | --- |
| **Pure/core** (`src/core`) | ~25 in `tests/extension` | Clustering, ranking, presence interpretation, combos, unread, channel-name resolution | That anything calls it, or calls it at the right moment | ~1ms | Rules with real edge cases |
| **PGlite / Supabase** | 11 (`tests/db`) | Real Postgres, real `authenticated` role, real migrations: RLS, RPC semantics, the destination model, authorization walks | Anything client-side; ordering; whether the client sends the right thing | ~2s/file | Every authorization and SQL-semantics question |
| **Worker services** | `presence`, `streamRoom`, `metadata`, `roomMessages`, `activity`, `friendDestinations`, `sessionState` | Each service's own behaviour and lifecycle in isolation | How they compose in the worker | ~ms | Stateful units with timers |
| **Worker orchestration** | `destinationPublishing`, `workerPortPublishing`, `destinationsConvergence`, `gravityLoading` | Composition under adversarial timing — ports, eviction, races, convergence | Real Chrome timing; real network | ~50ms | **The highest-value layer, and the newest** |
| **Panel-level (SSR)** | `panelRender`, `gravityMultiDestination`, `gravityEnrichment`, `gravityLoading`, `roomLifecycle`, … | What the real `KickbackPanel` puts in the DOM from a given state | Effects, scroll, layout, interaction | ~5ms | User-visible contracts. Caught two beta regressions. |
| **jsdom (`dom` project)** | 4 (`tests/dom`) | React effects that need a document — chat anchoring | Real layout; real scroll metrics | ~50ms | Effect-dependent behaviour only |
| **Source/bundle pins** | 15 files, 93 assertions | That the shipped artifact contains/excludes specific things | Behaviour of any kind | ~1ms | Artifact and privacy invariants |
| **Testlab** | 5 | The isolated component playground stays isolated | Production wiring | ~ms | Design surface |
| **Browser / manual** | — | Everything real | Nothing repeatable | minutes of a human | Last resort |
| **E2E infrastructure** | **none** | — | — | — | §12 |

---

## 3. Blind spots found

| # | Blind spot | Status |
| --- | --- | --- |
| 1 | **MV3 worker lifecycle.** Nothing constructed a worker, destroyed it, and asserted what the next one knew. | Closed by `workerPortPublishing` (previous milestone) and generalised into the harness here |
| 2 | **Consumer divergence.** Two consumers deriving the same domain state separately. | Closed by `gravityModel` + panel-level tests |
| 3 | **Discovery vs presentation.** "Which destinations exist" had three implementations. | Closed by `gravityChannels` + `gravityEnrichment` |
| 4 | **Async convergence.** Trigger ordering, dropped reads, out-of-order responses. | Closed by `destinationsConvergence` |
| 5 | **Loading states.** Nothing asserted what renders *while* data is in flight. | **Closed here** — `gravityLoading` |
| 6 | **The worker's own decisions.** `sessionChannel`, `restoredSession`, `unreadByChannel`, `peersOn` were string-matched only. | **Closed here** — extracted and tested |
| 7 | **Broadcast contract.** No test asserts `currentState()` carries every field the panel needs. | **Open** — §18 |
| 8 | **Real Chromium.** Shadow DOM, drag/resize, OAuth, notifications, eviction timing. | **Open by decision** — §12, §13 |

---

## 4. `src/background/index.ts` responsibility audit

2,236 lines; **20 of its collaborators are already extracted services** (`createAuthService`, `createFriendsService`, `createPresenceReporter`, `createMetadataService`, `createStreamRoom`, `createFriendDestinations`, …). What remained inline was derivations and wiring.

| Responsibility | Could a timing/ordering/stale-state bug ship while tests stay green? | Class |
| --- | --- | --- |
| Supabase/storage/auth construction | No — configuration | **A** leave inline |
| `broadcast()`, `currentState()` | Partly — a missing field is invisible | **D** defer (§18) |
| `logError`, `noteRealtime`, `browserName` | No | **A** |
| `rememberChannelName`, `loadChannelNames` | No | **A** |
| Port `onConnect` / `onMessage` / `onDisconnect` | Yes — and it did | **C** covered by `workerPortPublishing` |
| `wantMetadata()` | Yes — and it did, twice | **C** now a 10-line adapter over `gravityChannels` |
| Friend destinations orchestration | Yes — and it did | **C** extracted last milestone |
| `sessionChannel`, `sessionChannels` | Yes | **B → extracted** |
| `restoredSession` | Yes — stale record reopening another room | **B → extracted** |
| `roomUnreadMap`, `peersOn`, `sessionPeerMap` | Yes — per-channel isolation | **B → extracted** |
| `pushActivity()` | Yes — it is the hub | **D** defer; see below |
| `updateTogether`, `noteTogetherSurface`, `liveWatchChannel` | Yes | **D** defer — analytics-only blast radius |
| `refreshAttention` | No longer — it is now three calls | **A** |
| `handleRpc` | Low — thin dispatch | **A** |
| Alarms, `onInstalled` | No | **A** |

**`pushActivity` was deliberately left inline.** Extracting it means passing
eight collaborators through a seam that exists only for the test, which is the
"abstraction for abstraction's sake" the brief warned against. Its *inputs* are
now all independently tested (`sessionState`, `activity`, `presence`,
`streamRoom`, `roomMessages`), and its wiring is asserted by
`workerPortPublishing` and `socialViewing`. Revisit if a third defect lands in it.

---

## 5. Extractions performed

### `src/background/sessionState.ts` — 5 pure functions

`sessionChannelOf`, `openSessionChannels`, `peersOnChannel`,
`restoredSessionChannel`, `unreadByChannel`.

**Justification:** these decide whether a Stream Room exists at all, they were
implicated in the room-resolution bug, and they were protected by three source
pins — one of which broke on a CRLF checkout. They are pure functions over
explicit inputs, so they move out whole and `index.ts` keeps the wiring.

**Not a rewrite:** every body is the previous body with its module-scope reads
turned into parameters. `describePresence` and `unreadCount` are still the
functions the panel uses; nothing reinterprets presence.

### Supporting API additions

- `metadata.inFlightChannels()` — the in-flight set, needed by §11.
- `KickbackState.channelMetadataPending` — broadcast, empty by default.
- `awaitingEnrichment()` / `visibleGravity()` in core — the readiness rule.

---

## 6. Source-pin audit

**93 assertions across 15 files.** Classified:

| Class | Count | Action |
| --- | --- | --- |
| **1 — Security / build invariant** | ~40 | **Keep.** `bundle.test.ts` (16) asserts the shipped artifact carries no `message_body`, `access_token`, `refresh_token` or `friend_code`, that demo code is absent, that the version is present, and that the four worker diagnostics are attached to `globalThis`. `metadataSecurity`, `analyticsContract`, `releaseVersion`, `testlab/isolation` are the same kind: inspecting the artifact **is** the point. |
| **2 — Behavioural substitute** | 3 | **Replaced this milestone.** The `restoredSession`, `sessionChannel` and `sessionChannels` pins now run the rule instead of spelling it. Each keeps one short pin proving the worker *calls* the tested function — a seam assertion, not a behaviour assertion. |
| **3 — Redundant** | 0 | None removed. Nothing was found that stronger coverage already fully covered. |
| **Remaining, justified** | ~50 | `sessionStability` (14), `comboCta` (11), `socialViewing` (9), `shellPolish` (5), `blockUi` (4) and others pin CSS rules and worker wiring that has no importable seam yet. Each is a candidate for class 2 as its subject is extracted; none is worth extracting *for the pin alone*. |

**Line-ending fragility is now understood and recorded**, not fixed: pins match
on `\n`, and `core.autocrlf` rewrites working files on some git operations. The
fix is a `.gitattributes` entry or normalising in the assertion — §18.

---

## 7. Orchestration harness design

`tests/support/orchestration.ts`. Three pieces, all about holding the world
still:

- **`deferred<T>()`** — a promise somebody else decides the fate of.
- **`createCallQueue<A, R>()`** — wrap any async dependency and answer its calls
  in any order: `resolveNext`, `resolveWhere`, `rejectNext`, `drain`, plus
  `calls` and `open()`. This is what makes *"B arrives before A"* one line.
- **`installPortNetwork()`** — a fake `chrome.runtime` whose ports are plain
  objects, exactly as the worker keys tabs by the port itself. `evictWorker()`
  kills every port the way MV3 does.
- **`settle(ms = 1500)`** — advance the fake clock past the 500ms reconnect
  backoff and the 1s coalesce windows.

**Nothing sleeps.** No test in this milestone depends on a real delay.

---

## 8. Race and timing cases now covered

| Case from the brief | Where | Status |
| --- | --- | --- |
| A starts → B changes → A resolves | `destinationsConvergence` | ✅ |
| Request B while A pending → A resolves → **B must run** | `destinationsConvergence` "does not drop a change that arrives during a read" | ✅ |
| Destination set changes twice mid-flight → converge to newest | `destinationsConvergence` | ✅ |
| Worker destroyed → new worker → ports replay → state reconstructed | `workerPortPublishing` "still publishes all three once the tabs reconnect" | ✅ |
| Metadata response B before A | `destinationsConvergence` ordering group | ✅ |
| One metadata request fails → later trigger retries | `destinationsConvergence`, `gravityLoading` | ✅ |
| Rapid updates coalesce, final update not lost | `destinationsConvergence` | ✅ |
| Tab closes while a request is in flight | `destinationsConvergence` "destination removed mid-flight" | ✅ |
| Duplicate channel tabs → one closes → destination remains | `destinationPublishing`, `workerPortPublishing` | ✅ |
| **Metadata pending → card held → resolves → card complete** | **`gravityLoading`** | ✅ **new** |
| Realtime event before initial load completes | — | ⚠️ **not covered** (§18) |

The invariant asserted throughout is **eventual convergence to the newest
authoritative state**, never a fixed wait.

---

## 9. Production-path coverage

Tested through the real modules, not re-created helpers:

| Path | Real modules composed | File |
| --- | --- | --- |
| ports → aggregation → presence reporter | `createPortClient`, `createActivityRegistry`, `createPresenceReporter` | `workerPortPublishing` |
| destinations → discovery → metadata → model → panel DOM | `createFriendDestinations`, `createMetadataService`, `gravityChannels`, `KickbackPanel` | `destinationsConvergence` |
| model → cards → analytics projection | `gravityModel`, `gravityOpportunities`, `KickbackPanel` | `gravityEnrichment` |
| metadata in-flight → held card → complete card | `createMetadataService`, `visibleGravity`, `KickbackPanel` | `gravityLoading` |
| session rules → room surface | `sessionState`, `createStreamRoom` | `sessionState`, `roomResolution` |

Each uses the **cheapest layer that can prove the invariant** — the brief's rule,
applied.

---

## 10. Frontend/panel contracts

Already established and kept green: Social Gravity singular behaviour,
one friend at several destinations, several friends at one destination,
per-destination display name / category / viewers / live state / avatar / JOIN
target, **no metadata leakage between destinations**, and analytics
opportunities equalling the rendered cards.

**Added here:** the loading contract (§11) — 17 tests including "does not block
the rest of the panel" and "never renders a loading placeholder".

**Not duplicated:** Friends naming, stable colours, room retention, unread,
autoscroll and group-chat anchoring already have dedicated coverage
(`chatIdentity`, `chatAnchoring`, `roomLifecycle`, `cardConsistency`). Adding
panel-level copies would restate them at higher cost.

---

## 11. Gravity loading UX

**The rule, and it has no clock in it:**

- metadata present → render the complete card;
- no metadata **and a request open** → **hold it**, because it is arriving;
- no metadata **and no request open** → render the plain card, because it is not.

Both facts already existed inside the metadata service; they were simply never
published. The worker now broadcasts `channelMetadataPending`, and
`visibleGravity()` filters on it.

**Consequences, each asserted:**

- an existing enriched card is never disturbed by a new destination arriving;
- a failed fetch degrades to the plain card the panel has always drawn — not to
  a card that never appears, and not to a spinner that never stops;
- **HERE is never held back** (the viewer is already there; hiding it would
  remove the people they are with), nor are the `around`/`offline` sections;
- holding one card back never holds the map back;
- `channelMetadataPending` defaults to empty, so every existing caller and test
  behaves exactly as before.

**Verified as a real fix:** reverting the filter and re-running produces four
failures whose captured markup is exactly the bare `lirik` / `teamliquid` /
`timthetatman` cards that were reported.

All three required cases are covered: CASE 1 (second destination pending),
CASE 2 (three resolving out of order, no bare intermediate at any step),
CASE 3 (failure → usable panel, deliberate fallback, no indefinite loading).

---

## 12. Chromium / Playwright: decision

### **Specified, deliberately not built. There is a concrete blocker.**

Investigated: Playwright is **not** installed; system Chrome **is** present at
`C:\Program Files\Google\Chrome\Application\chrome.exe`, so `channel: 'chrome'`
would avoid a browser download. The dependency is not the obstacle.

**The obstacle is the backend.** Seven of the ten candidate journeys need two
authenticated accounts, and the only Supabase project configured is the live
one carrying private-beta data and analytics. Running an E2E suite against it
would write presence, destinations, room messages and analytics events into
beta data on every run — which standing project rules forbid, and which would
corrupt the very analytics this beta exists to gather.

| # | Journey | Needs auth? | Automatable |
| --- | --- | --- | --- |
| 1 | Extension boots as unpacked MV3 | No | ✅ **today** |
| 2 | Multiple tabs publish multiple destinations | Yes | after a test project |
| 3 | SPA channel navigation updates destination state | No (worker state observable) | ✅ **today** |
| 4 | Tab close updates destination state | No | ✅ **today** |
| 5 | Worker restart reconstructs destination state | Partly | ⚠️ eviction is not controllable; `chrome://serviceworker-internals` stop is a proxy, not the real thing |
| 6 | Observer renders multi-destination Gravity | Yes | after a test project |
| 7 | Cross-tab panel/layout state | No | ✅ **today** |
| 8 | Stream Room isolation | Yes | after a test project |
| 9 | Chat scroll anchoring in real DOM | No | ✅ **today** — highest value, jsdom needs a hand-built geometry harness |
| 10 | Shadow DOM / drag / resize | No | ✅ **today** |

**Recommended first slice — six journeys, no accounts, no hosted writes:**
1, 3, 4, 7, 9, 10. That is a real suite and it is unblocked.

**Prerequisite for the rest:** a dedicated Supabase test project with the same
migrations, two seeded accounts, and `VITE_KICKBACK_ENV=test`. That is a
half-day of setup and is the right first task of the E2E milestone — not
something to improvise inside this one.

**What Playwright cannot do honestly:** force a genuine MV3 eviction on Chrome's
own schedule. It can stop a worker manually, which exercises reconstruction but
not the timing. The eviction *behaviour* is covered deterministically by
`workerPortPublishing`; the *timing* stays manual.

---

## 13. What remains impossible or unreliable to automate

- **Real MV3 eviction timing** and background-tab timer throttling.
- **Twitch DOM changes** breaking the anchor or chat-rail measurement — an
  external dependency that changes without notice; a failing E2E here would be
  noise, not signal.
- **Real Twitch OAuth** through `chrome.identity.launchWebAuthFlow`.
- **Desktop notification appearance** and OS behaviour.
- **Store-installed artifact behaviour** — permissions prompts, update flow.
- **Subjective polish** — spacing, motion, whether a card "feels" right.

These are exactly what the human smoke in §17 covers, and nothing else.

---

## 14. Before / after regression protection

| Beta regression | Would it be caught now? | By what, and how fast |
| --- | --- | --- |
| **1. MV3 eviction loses destinations** | ✅ | `workerPortPublishing` — real port client, worker rebuilt as eviction rebuilds it. 6/14 fail without the fix. ~200ms |
| **2. Gravity UI/analytics divergence** | ✅ | `gravityMultiDestination` — panel-level, counts cards. 7/14 fail without the fix. ~600ms |
| **3. Enrichment discovery divergence** | ✅ | `gravityEnrichment` — per-destination metadata + a seam pin on `gravityChannels`. ~600ms |
| **4. Async metadata convergence race** | ✅ | `destinationsConvergence` — 4 tests run the old wiring and assert it never converges. ~900ms |
| **5. Bare-then-transforming card** | ✅ | `gravityLoading` — 4 fail without the rule. ~600ms |

**Every one of the five now fails deterministically, in under a second, at the
layer where the bug actually lived.**

---

## 15. Verification

| # | Command | Exit | Result |
| --- | --- | --- | --- |
| 1 | `npm run build` | **0** | content 312.51 kB (gzip 89.79), background 295.23 kB (gzip 80.00) |
| 2 | `npx vitest run` (focused: gravityLoading, sessionState, destinationsConvergence) | **0** | 17 + 30 + 23 |
| 3 | `npx vitest run` | **0** | **79 files / 2037 tests / 0 failed / 0 skipped** |
| 4 | `npx tsc -b` | **0** | |
| 5 | `npx eslint .` | **0** | |
| 6 | `npm run verify:analytics` | **0** | |
| 7 | `npm run verify:groups` | **0** | |
| 8 | `npm run verify:config` | **0** | |
| 9 | `npm run verify:store` | **0** | version 0.5.0 |
| 10 | `npm run package:beta` | **0** | §16 |

**`test:authz` not run. `package:store` not run. Version not bumped** — nothing
here required it.

Baseline 77 files / 1990 tests → **79 / 2037**: +2 files, +47 tests. Three
source assertions were replaced by thirty behavioural ones, which is the number
that matters rather than the total.

---

## 16. Beta artifact

**`releases/Kickback-Private-Beta-v0.5.0.zip`**
**sha256 `06f40203ed16947b36802840eaecbea3737934dc00f73aabb94ed089c52ce3f9`**

> **Replace the loaded build.** The previous ZIP (`17e9a0f1…`) converges
> correctly but still shows the bare-then-transforming card.

| Check | Result |
| --- | --- |
| Version | 0.5.0, unchanged |
| Extension ID | `ngfopkeokddfnncdhfkhnffilbdhkkip` — unchanged |
| Permissions | `identity`, `storage`, `alarms`, `notifications` — none added |
| Worker diagnostics | all four attached to `globalThis` |
| Chrome Web Store | untouched |

---

## 17. Human smoke — 7 minutes

Everything below is something automation cannot convincingly prove. **Nothing
here asks you to verify a deterministic state transition.**

**Setup (1 min).** Extract the ZIP over the same folder, reload at
`chrome://extensions`, refresh one Twitch tab.

| # | ~Time | Do | Expect |
| --- | --- | --- | --- |
| 1 | 1 min | Sign in with **Continue with Twitch** | Real OAuth completes; the account card reads `Kickback v0.5.0` |
| 2 | 1 min | Open two more streams in new tabs | Panel appears on each; nothing about Twitch's own page looks disturbed |
| 3 | **2 min** | On the **observing** account, watch the panel while the other account opens a third stream | **Each new card appears already complete** — Twitch capitalisation, LIVE badge, category, viewers, avatar. **No card should appear bare and then fill in.** |
| 4 | 1 min | Drag the panel, resize it from a corner, minimise and restore | Smooth; stays where you put it; survives a tab switch |
| 5 | 1 min | Open a Stream Room and send a message | Arrives on the other account; the conversation stays anchored to the bottom |
| 6 | 1 min | Leave one tab in the background for a minute, come back | Destinations still correct; no flicker |

**If step 3 shows a bare card**, run `kickbackGravity.now()` in the service-worker
console and send the `enrichment` block — `missing`, `requested` and `cached`
distinguish the three possible causes.

**Do not** manually verify destination counts, room isolation, unread counts or
analytics — all deterministic and covered.

---

## 18. Remaining technical debt

| Item | Priority | Note |
| --- | --- | --- |
| No broadcast-contract test | **High** | Nothing asserts `currentState()` carries every field the panel reads. A field silently dropped would be invisible until a browser. One test comparing the broadcast's keys against `INITIAL_STATE` would close it. |
| E2E blocked on a test Supabase project | **High** | §12. First task of the E2E milestone. |
| `pushActivity` still inline | Medium | Deliberate (§4). Revisit on a third defect. |
| Source pins match `\n` | Medium | A CRLF checkout breaks them; `.gitattributes` or normalising in the assertion. |
| "Realtime event before initial load completes" untested | Medium | The one brief case with no coverage; needs the socialSync seam. |
| `updateTogether` / `liveWatchChannel` inline | Low | Analytics-only blast radius. |
| `expandDestinations` runs twice per render | Low | Pure, memoised, identical inputs. |

---

## 19. Recommended release gate

**Every release, in order — about 8 minutes of machine time:**

1. `npm run build`
2. `npx vitest run` — must be **0 failed, 0 skipped**
3. `npx tsc -b` and `npx eslint .`
4. `verify:analytics`, `verify:groups`, `verify:config`, `verify:store`
5. `npm run package:beta`, and **record the sha256**
6. **The 7-minute human smoke (§17)** — on the ZIP just built, sha confirmed

**And the standing rule, which is what actually changed this beta:**

> When a bug is found manually, add its regression test at the **highest
> practical layer that would have caught the actual failure**, and prove it
> fails against the pre-fix code before accepting it as evidence.

Every fix this beta followed that rule, and the "prove it fails first" half is
what stopped two tests from being decoration.

---

## 20. MACHINE GO / NO-GO

### **MACHINE: GO.**

| Acceptance criterion | State |
| --- | --- |
| High-risk orchestration boundaries deterministic and testable | ✅ harness + 4 orchestration files |
| Recent regression classes have meaningful automated coverage | ✅ all five, each proven to fail pre-fix (§14) |
| Frontend contracts protect user-visible behaviour | ✅ Gravity enrichment, multi-destination and loading |
| Small Chromium E2E layer if worthwhile | ⚠️ **specified, not built** — blocked on a test backend, §12 |
| Brittle source pins reduced where behaviour is superior | ✅ 3 replaced by 30; ~40 artifact invariants correctly kept |
| Full existing suite green | ✅ 79 / 2037 / 0 / 0 |
| No production behaviour regression | ✅ one intended UX change, defaulted off by empty state |
| Build and package verification | ✅ all exit 0 |

The one criterion not met is E2E, and it is not met **for a stated reason with a
named prerequisite**, not for lack of attempt.

---

## 21. HUMAN acceptance

**Pending.** This milestone is MACHINE complete only. Human acceptance is the
§17 smoke, and I am not claiming it.

---

## 22. Git status, commits and push

Two coherent commits:

```
bed46f8  feat: hold a gravity card until its metadata arrives
         src/background/{metadata,index}.ts, src/client/types.ts,
         src/core/socialGravity.ts, src/ui/{KickbackPanel,components/SocialGravity}.tsx,
         tests/extension/gravityLoading.test.tsx, tests/support/orchestration.ts

230ba2b  refactor: extract the session derivations from the worker
         src/background/sessionState.ts (new),
         tests/extension/sessionState.test.ts (new),
         tests/extension/{roomResolution,socialViewing,streamSession} (pins replaced)
```

`releases/` is gitignored. No `.env.local`, no tokens, no keys, no `dist/`.

- **Push:** normal, to `origin/main`. No force push. Result recorded below.
