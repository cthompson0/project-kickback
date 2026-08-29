# Firefox F4 — real Gecko runtime acceptance and hardening

**Date:** 2026-08-29
**Milestone:** F4, following F1–F3.
**Scope:** runtime acceptance under real Firefox. No M3, no AMO work, no F5
harness, no OAuth/Twitch/Supabase/Chrome change.

---

## 1. Executive verdict

### F4: CONDITIONAL PASS

Every Gecko-specific question F4 set out to answer was answered by measurement,
and every one of them passed:

- panel injects exactly once and stays once across SPA navigation, in two tabs;
- panel geometry is clean — measured against Twitch's real chat rail, **zero
  overlap**;
- page-origin `localStorage` reads, writes and survives navigation;
- notification payloads from the Gecko adapter are **accepted**, and the same
  payload **with** buttons is **rejected outright** — so F1's strip is not
  cosmetic, it is the difference between a notification and none;
- host-permission revocation fails cleanly, with no crash loop and no errors;
- the event page's suspend/resume behaviour was measured directly rather than
  inferred, in both directions.

**One defect blocks an unconditional pass, and it is not a Gecko defect.**
`src/background/index.ts` has a brace-scoping error that puts five `hydrate()`
calls and the whole diagnostics block inside the `runtime.onStartup` callback,
which fires only at browser start. It is **pre-existing**, present identically
before F1, and it affects **Chrome equally**. Firefox is simply where it became
visible, because a temporary add-on never fires `onStartup` at all.

By the letter of F4's criteria this is a recovery defect and therefore blocks
PASS. I have not fixed it, for reasons given in §16 — the short version is that
the fix changes Chromium worker-startup semantics, which F4 explicitly told me
to preserve, and it deserves its own focused change with worker-level regression
tests rather than being folded into a Gecko acceptance pass. The owner may
reasonably read this as FAIL-until-fixed; I would not argue.

**No stop condition was triggered.** Gecko needs no product divergence, no
permission widening, no separate architecture, and strict privacy behaviour
blocks nothing.

---

## 2. Methodology

| | |
| --- | --- |
| Browser | Mozilla Firefox **154.0.1** |
| Package | `dist-firefox/package` — the real F2 output, unmodified |
| Install | `web-ext run`, temporary add-on |
| Profile | **`ffwork`** — a disposable copy of the authenticated F3 profile, made before any test |
| Preserved | `ffprofile` (F3's authenticated profile) and `ffprofile-backup` were never written to |
| Sessions | 7 real Firefox runs |

Instrumentation followed F2/F3: a scratch copy of the real package with a
background probe and a page probe added, plus a localhost host permission so
they can report. **The product was never modified.** No token, verifier, code or
cookie was read; storage is reported by key name.

### One methodology error, corrected

The first suspension run closed every Twitch tab to remove all ports — which
closed the last window and **exited Firefox**, producing silence that could
easily have been misread as "the event page suspended". It was not; the browser
had gone. The test was rerun with a keep-alive `about:blank` tab, and §11's
measurements come from that corrected run.

---

## 3. Panel and Twitch DOM

Measured across two tabs (`/lirik`, `/shroud`) and six phases:

| Property | Result |
| --- | --- |
| `#kickback-host` elements | **1**, every phase, every tab |
| `.kb-panel` inside the shadow root | **1**, every phase |
| Shadow root attached | yes |
| `<style>` tags in the shadow root | **1** — the inlined stylesheet arrived |
| Panel in viewport | **true**, every phase |
| Page console errors | **0** |

Geometry, against Twitch's real furniture (`[data-a-target="chat-scroller"]`):

```
run A   panel  x=618  w=320   chat  x=1281 w=340   overlap = 0
run B   panel  x=938  w=280   chat  x=1281 w=340   overlap = 0
```

**Zero overlap with Twitch chat**, measured, in both window sizes. The two runs
differ because panel position and size are user state persisted in page-origin
`localStorage` (`kickback:layout`) and the windows differed — which is itself
evidence that layout persistence works.

The panel does overlap the **player** region (~59–65k px²). That is by design —
it is a top-right overlay on a page whose player fills the centre — and it is
the same behaviour Chrome ships. Not a defect.

An earlier measurement pass reported `overlap = 0` against a chat selector that
had matched a **zero-width** node, which would have been meaningless evidence.
The selector list was widened and now records which selector matched, so the
number above is real.

## 4. SPA navigation

Navigation was performed the way a user does it — the page probe clicked a real
Twitch in-page link and let Twitch's router handle it (`/lirik` → `/directory`,
and the same in the second tab).

| Check | Result |
| --- | --- |
| Duplicate injection after navigation | **none** — still 1 host, 1 panel |
| Panel survives navigation | yes, re-measured in `after-spa` |
| Panel still in viewport afterwards | yes |
| Page errors during/after | 0 |
| Stale previous-channel state | none observed in the broadcast state |
| Shadow DOM / CSS isolation | intact (1 style tag, no leakage) |

`platforms/twitch/navigation.ts` deliberately avoids patching
`history.pushState` — the investigation flagged that decision as what made the
module portable, and this is the measurement that backs it up.

**Not covered:** channel → channel with chat visible on both sides was
exercised, but home/browse → channel and chat-collapsed states were not, because
the deterministic link-click lands on `/directory`. Classified for F5 (§19).

## 5. Strict ETP and page-origin localStorage

The compatibility investigation flagged this as class F. Measured on every
phase, in both tabs:

```
localStorage: { writable: true,
                watchsideKeys: ["kickback:layout-hint-seen",
                                "kickback:layout",
                                "kickback:collapsed"] }
```

- reads work, writes work, deletes work;
- the three Watchside keys **persisted across SPA navigation** and across
  separate browser sessions;
- extension storage (`browser.storage.local`) remained independent throughout;
- no silent failure, no exception, no user-visible breakage.

Firefox's default protection is **Standard**, which is what these runs used.
Twitch is a **first-party** origin here, and ETP partitions *third-party*
storage — so the mechanism that would break this does not apply to a
content script writing to the page's own origin.

**Classification: A — no product change needed.** Strict-mode ETP was not
forced, and that is stated as a limitation rather than glossed: what is proven
is Standard protection. The reasoning above says why Strict is expected to
behave the same, and it is queued as an F5 automation case rather than claimed.

No browser privacy setting was weakened.

## 6. Multi-tab and destinations

Two Twitch channel tabs were opened (the second created from the background) and
later closed:

| Check | Result |
| --- | --- |
| Both tabs injected | yes — 1 host / 1 panel each |
| Both content scripts connected a port | yes — both reported state |
| `tabs.create` / `tabs.remove` without the `tabs` permission | **work** |
| Second tab closed cleanly | yes |
| Background errors | 0 |

**Limitation, stated plainly:** the worker's own destination diagnostic
(`kickbackDestinations.now()` — ports, aggregated, published, writes) was
**unavailable**, so per-destination server-side evidence could not be read from
inside the worker. The reason is defect **WS-F4-01** (§15): the diagnostic is
assigned inside the `onStartup` callback, which never fires for a temporary
add-on. Multi-destination presence therefore rests here on two tabs both
connecting and reporting, which is weaker than F4 asked for. It is the first
thing WS-F4-01 unblocks.

## 7. Gravity and JOIN — NOT EXERCISED

Honest answer: it could not be, and I did not fake it.

Gravity requires **friends who are currently watching**. The test account's
three friends (`bobtheunstoppable`, `ohjuliego`, `wtfchuck27`) were **offline
for the entire F4 window**, so no Gravity section could form and no JOIN button
could exist to click. Manufacturing presence would have meant writing to the
hosted database on behalf of other people's accounts, which is out of scope and
would corrupt real data.

What *was* observed: the signed-in panel rendered its friends list correctly
with all three shown offline, and the state broadcast carried them — so the data
path into Gravity is live. The rendering and JOIN navigation path is unexercised
on Gecko.

**Classified for F5** with a seeded fixture, or F7 human acceptance when a
friend is genuinely live. Not claimed as passing.

## 8. Stream Rooms and realtime — NOT EXERCISED

Same reason. A Stream Room forms when friends share a destination; with every
friend offline, no room can exist. Realtime subscription establishment could not
be read from the worker either, for the same WS-F4-01 reason.

Not claimed as passing. Classified for F5/F7.

## 9. Notifications

The most conclusive result in F4. Three payloads were put through the real Gecko
API:

| Payload | Result |
| --- | --- |
| Exactly what the Gecko adapter emits (`type`, `iconUrl`, `title`, `message`) | **accepted**, id returned |
| The same payload **with `buttons`** — the Chromium shape | **rejected** |
| `notifications.clear` | **true** |

The rejection, verbatim:

```
Type error for parameter options
(Property "buttons" is unsupported by Firefox) for notifications.create.
```

This settles the design question F1 answered from documentation: the strip in
`gecko.ts` is **load-bearing**. Without it every Watchside notification on
Firefox would be lost entirely — not degraded, lost — because Gecko rejects the
whole call rather than ignoring the unknown field.

One nuance worth recording against the investigation: **`browser.notifications.onButtonClicked`
does exist** on Firefox 154 (`onButtonClickedExists: true`), contrary to MDN's
implication. It can never fire, because buttons cannot be created. `gecko.ts`
registers a no-op instead of delegating; that remains correct and needs no
change, but the reason is "buttons cannot exist", not "the event does not
exist".

**Not exercised:** body-click → open-the-channel, and dismissal-does-not-navigate.
Those need a user click on an OS notification. `notifier.ts` wires body click and
button click to the identical `open()`, and `onClicked` registration succeeded,
so the wiring is present — but the click itself is human. Classified as F7.

## 10. Host-permission revocation

```
before        true                     (granted at install, per Firefox 127+)
removed       true
afterRemove   false
reAdd         "permissions.request may only be called from a user input handler"
afterRestore  false
```

| Check | Result |
| --- | --- |
| Failure clean? | **yes** — no exception, no crash loop, background errors 0 |
| Misleading presence published? | **no** |
| Panel behaviour understandable? | yes — the already-injected content script kept working (1 host, 1 panel, 0 errors); a *new* tab would simply get no panel |
| Restorable without reinstall? | **yes, but only by the user** — Firefox requires a user gesture, so restoration is a toggle in about:addons, not something the extension can do silently |

Note: after revoking `https://www.twitch.tv/*`, `permissions.getAll()` still
listed `https://twitch.tv/*` — Firefox revokes the specific origin, and our
manifest declares both.

**Does this need product handling before AMO?** My assessment: no. The failure
is silent-but-honest — the panel is absent rather than broken or lying. A
clearer in-panel explanation would be a nicety, not a fix, and inventing one
would be a Firefox-only product behaviour, which F4 rules out.

## 11. Background lifecycle — measured, both directions

This was the high-value unknown, and documentation was not trusted.

Method: the probe mints a random **boot id** on every evaluation. If the id
changes, the context was torn down and re-created. That is the only honest way
to see suspension from the inside.

### With a Twitch port open — no suspension

Across the runtime runs, with one or two Twitch tabs open for **200+ seconds**:

```
distinct boot ids: 1
```

The event page was never suspended while a content-script port was open. This
confirms the investigation's reading — an open message port holds it alive.

### With no Twitch port — it suspends, repeatedly

With a keep-alive `about:blank` tab and every Twitch tab closed at t=25s:

```
--- BOOT 1 ---  ticks 5s, 21s, 30s, 45s   (Twitch tab closed at 25s)
                ...then silence
--- BOOT 2 ---  wokeBy=alarm, fresh evaluation, ticks 5s, 21s, 30s, 45s
                ...then silence
--- BOOT 3 ---  wokeBy=alarm, fresh evaluation
--- BOOT 4 ---  wokeBy=alarm, fresh evaluation

distinct boot ids: 4
```

**Measured behaviour:**

1. Firefox **does** suspend the MV3 event page once no port holds it — roughly
   45–70 seconds after the last Twitch tab closed.
2. All timers die with it (the silence).
3. **An alarm wakes it**, and the module is **re-evaluated top to bottom** — a
   new boot id every time.
4. The revival is clean: zero errors across all four boots.

This is materially the same lifecycle as Chromium MV3. It means our shared
recovery architecture is not merely harmless on Firefox — it is **necessary**,
because the context genuinely dies and the next tab connect must replay its
activity.

## 12. Recovery

The reconnect-driven recovery (activity replay in `client/port.ts`, destination
re-statement in `background/presence.ts`) is architecturally exercised by the
above: the context dies and is rebuilt, so a reconnecting tab is the only thing
that can restore the tab registry.

**But recovery is NOT fully safe, because of WS-F4-01.** Every one of those four
revivals re-ran the module *without* running `preferences.hydrate()`,
`attention.hydrate()`, `metadata.hydrate()`, `sessionTab.hydrate()` or
`groups.hydrate()` — because all five sit inside the `onStartup` callback, which
did not fire. See §15.

`auth.initialize()` is the exception: it is also called at module level
(`index.ts:2414`), which is why the session restored correctly on every revival
throughout F3 and F4.

## 13. Storage persistence

| State | Result |
| --- | --- |
| Auth session (`sb-…-auth-token`) | present and restored across restarts (F3 §26.8, re-confirmed here) |
| `kickback:analytics:session` | present, cleared on sign-out |
| `kickback:attention:seen` | present |
| `kickback:channelMetadata` | present |
| `kickback:channelNames` | present |
| Panel layout / collapse / hint | present in **page-origin** `localStorage`, persisted across sessions |
| `kickback:preferences`, `kickback:sessionTab`, `kickback:mutedUsers` | **absent** — never written, because nothing changed them in these sessions |

Reported by key name and presence only; no value was inspected.

## 14. Console and error audit

| Source | Count | Classification |
| --- | --- | --- |
| Background (`error` + `unhandledrejection`) | **0** across all 7 sessions | — |
| Content script / page (`error` + `unhandledrejection`) | **0** in every phase, both tabs | — |
| Watchside defects | 0 observed at runtime | — |
| Gecko warnings | none surfaced to the extension | — |
| Twitch / third-party noise | not captured — the probe listens only for errors reaching the content script's window | out of scope, correctly |

Zero runtime errors from Watchside on Gecko, in any session.

## 15. Defects discovered

### WS-F4-01 — `onStartup` swallows the worker's startup hydration

**Severity: high. Cross-browser. Pre-existing. Not caused by Gecko.**

`src/background/index.ts:2128` opens

```js
ext.runtime.onStartup(() => {
```

and the callback does not close until **line 2405**. Everything between is
inside it:

```
2129  void preferences.hydrate()      <- 2-space indent
2130  void attention.hydrate()        <- column 0
2133  void metadata.hydrate()         <- column 0
2137  void sessionTab.hydrate()       <- column 0
2153  if (METADATA_DIAGNOSTICS) { …kickbackMetadata / kickbackDestinations / kickbackGravity… }
2403  void groups.hydrate()
2404  void auth.initialize()
2405  })
```

The inconsistent indentation — one statement indented, the rest at column 0 — is
the fingerprint: these were written as top-level statements and were captured by
a callback whose closing brace ended up hundreds of lines below.

**`runtime.onStartup` fires only when the browser profile starts with the
extension already installed.** It does *not* fire when an MV3 background context
is revived, and it does not fire at all for a temporarily-installed add-on.

**Evidence it does not fire on Firefox:**

```
typeofDestinations : "undefined"
typeofMetadata     : "undefined"
typeofGravity      : "undefined"
hasOwn             : false
selfIsGlobalThis   : true      <- probe and bundle share one global
keysTotal          : 233
```

The assignment is unquestionably in the shipped bundle —
`globalThis.kickbackDestinations={now(){…` appears in both the Gecko and the
Chromium output — and the minified Gecko bundle shows it sitting inside
`t.runtime.onStartup(()=>{…`.

**It predates F1.** At `497aeba` (pre-F1) the same structure exists:
`chrome.runtime.onStartup.addListener(() => {` at line 2138,
`if (METADATA_DIAGNOSTICS) {` at 2163, closing `})` at 2415. F1's adapter
refactor was a 1:1 call substitution and did not alter the nesting.

**Consequence.** After every background revival — which §11 shows is routine on
Firefox and is the documented Chromium MV3 behaviour — the worker starts with
cold local state:

- `sessionTab` — the remembered session tab, read watermarks, and the **muted
  user list**. A muted user would appear unmuted until something rewrites it.
- `attention` — seen state, so previously-dismissed attention could return.
- `metadata` / channel names — cold caches, re-fetched rather than restored.
- `preferences` — panel preferences fall back to defaults.
- `groups` — cold until the next server sync.
- the developer diagnostics, which is how this was found.

The code's own comments describe the intended behaviour and contradict what it
does: *"A worker that has just woken should not start from a cold metadata
cache"* sits inside the block that only runs when the worker has **not** just
woken.

**Not observed as a user-visible failure in F4** — the account's server-derived
state (friends, groups, identity) was correct throughout, because that comes
from the server rather than these caches. The user-visible loss would be the
mute list and read watermarks, which these sessions never set. That limit is
stated rather than papered over.

### WS-F4-02 — probe host permissions accumulate in the test profile (cosmetic)

`permissions.getAll()` showed `http://127.0.0.1:8789/*` and `…8790/*` — leftovers
from probe packages sharing the gecko id in one profile. A test-harness artefact,
not a product issue. Noted so a future reader is not alarmed by it.

## 16. Fixes made

**None.** No production file was changed in F4; the working tree carried only
this report.

That is a deliberate call on WS-F4-01, and the reasoning is worth stating rather
than assumed:

1. **It is not a Gecko compatibility defect.** F4's mandate is Gecko runtime
   acceptance; this affects Chrome identically and always has.
2. **The fix changes Chromium worker-startup semantics.** F4 says a fix must
   "preserve Chrome behavior". Moving the closing brace makes five `hydrate()`
   calls run on every module evaluation, which is a real behavioural change to
   the most failure-prone file in the project — the same file that produced two
   earlier defects, both of which were about *when* something ran.
3. **It deserves its own regression test at the worker level**, and the worker
   is precisely the layer this project has repeatedly found hard to test. That
   is a focused piece of work, not a footnote to a Gecko acceptance pass.

**Proposed minimal fix**, for that separate change: close the `onStartup`
callback immediately after the statements that genuinely belong to browser
startup, and let the hydration and diagnostics run at module scope where the
surrounding comments already assume they are. Regression test: assert at the
`tests/extension` layer that the hydrate calls are reachable without
`onStartup` firing — the same shape as the existing worker source-pin tests.

## 17. Regression tests added

None — no defect was fixed, so there is nothing to pin. Manufacturing tests to
show activity would be worse than none.

## 18. Chrome non-regression

| Check | Result |
| --- | --- |
| Production code changed | **none** |
| Permanent Chromium ID | `ngfopkeokddfnncdhfkhnffilbdhkkip` — unchanged |
| Permissions / host permissions | unchanged |
| OAuth behaviour and scopes | unchanged |
| Recovery architecture | untouched |
| `Watchside-Store-v0.6.0.zip` | `150e3c5b…b7a818d3d` — untouched |
| `Watchside-Private-Beta-v0.6.0.zip` | `c1217ff5…6067203e` — untouched |
| `tsc -b --force` / `eslint .` | clean |
| `npm test` | **2258 passed / 86 files, 0 failed** |
| `verify:firefox` / `verify:store` / `verify:config` / `verify:groups` | pass |

`verify:lab` and `test:authz` not run, as instructed.

## 19. F5 automation classification

Every F4 check, classified as F4 asked:

| Check | Class | Note |
| --- | --- | --- |
| Extension loads under the fixed gecko id | **B** | already the F5 assertion #1 |
| Single host / single panel injection | **B** | cheap, deterministic, high value |
| No duplicate injection after SPA navigation | **B** | the link-click technique works headlessly |
| Shadow root + style tag present | **B** | |
| Panel in viewport | **B** | |
| Panel ∩ chat rail = 0 | **B** | assert *no overlap*, never absolute coordinates — position is user state |
| Panel ∩ player | **C** | overlap is by design; only a human can say it looks wrong |
| Page-origin localStorage read/write/persist | **B** | |
| Strict-ETP variant | **B** | set the pref in the test profile; not yet done |
| Two tabs both connect ports | **B** | |
| Per-destination worker state | **B** | **blocked on WS-F4-01** |
| Notification: stripped payload accepted | **B** | |
| Notification: buttons payload rejected | **B** | the strongest test in F4 — pins *why* the adapter strips |
| Notification body click → opens channel | **C** | needs an OS click |
| Host-permission revoke → clean failure | **B** | |
| Host-permission restore | **C** | Firefox requires a user gesture |
| No suspension while a port is open | **B** | boot-id technique; needs a ~90s test |
| Suspension + alarm revival when no port | **B** | as above; keep a non-Twitch tab or the browser exits |
| Auth restore after revival | **A** | F3 proved it; unit-covered |
| Zero background/page errors | **B** | |
| Gravity render + JOIN | **B** | needs a seeded friend-presence fixture |
| Stream Rooms / realtime | **B** | same fixture |

**A: 1 · B: 17 · C: 4.** The F5 harness is worth building; nearly everything
here is mechanisable.

Two techniques F5 should inherit from F4's mistakes: measure geometry by
*relationship* (overlap) rather than coordinates, and never close the last tab
unless you intend to close the browser.

## 20. Remaining human-only acceptance

Small, and unchanged in spirit from F2:

1. Click a real gathering notification and confirm it opens the right channel.
2. Look at the panel beside Twitch chat on a real screen and say whether it sits
   well — geometry is proven non-overlapping; taste is not mechanisable.
3. Confirm Gravity and a Stream Room look right when a friend is genuinely live.

## 21. F4 verdict

### CONDITIONAL PASS

| Criterion | Result |
| --- | --- |
| Twitch injection/navigation reliable | **PASS** |
| Panel geometry functionally acceptable | **PASS** — zero chat overlap, in viewport |
| Storage under supported privacy behaviour | **PASS** (Standard; Strict inferred, not proven) |
| Multi-destination presence | **PARTIAL** — both tabs connect; worker-side evidence blocked by WS-F4-01 |
| Gravity / JOIN | **NOT EXERCISED** — no friend online |
| Stream Rooms / realtime | **NOT EXERCISED** — no friend online |
| Notifications within Gecko limits | **PASS** |
| Background recovery safe | **FAIL** — WS-F4-01 |
| Permission failure clean | **PASS** |
| No serious Gecko runtime errors | **PASS** — zero, across 7 sessions |
| Chrome unaffected | **PASS** |

Gecko compatibility itself is in good shape: nothing about Firefox requires
product divergence. What stands between here and an unconditional pass is one
pre-existing cross-browser bug and two features that need a live friend.

## 22. Remaining F5 / F6 / F7 work

**Before F5:** fix WS-F4-01 as its own change, with worker-level regression
tests. It blocks per-destination verification and is a real recovery defect on
both browsers.

**F5** — `scripts/rdp.mjs` and the E2E suite; §19 says 17 of 22 checks are
mechanisable. Add a seeded friend-presence fixture so Gravity, JOIN and Stream
Rooms become testable. Wire both browser verifications into the release gate.

**F6** — AMO: signing, listing, the source package, and
`data_collection_permissions` (owner decision, see the F2 report).

**F7** — the three human checks in §20.

## 23. Commits and push

One commit: `docs: record Firefox F4 runtime acceptance` — this report only.
Pushed to `origin/main`.

## 24. Git status

- Branch `main`, tracking `origin/main`, pushed.
- **No production code changed.**
- Chromium extension ID `ngfopkeokddfnncdhfkhnffilbdhkkip` — unchanged.
- Hosted schema 28 — untouched. Supabase configuration — untouched.
- Chrome Web Store: submitted v0.6.0 — untouched.
- Firefox: F4 conditional pass. Not shippable; F5–F7 outstanding, and WS-F4-01
  should be fixed first.
