# Firefox F5 — automated real-browser regression harness

**Date:** 2026-08-29
**Milestone:** F5, following F1–F4 (WS-F4-01 closed by `7beaa0b`).
**Scope:** automation infrastructure and Firefox E2E. No M3, no AMO, no OAuth
scope change, no Chrome Store action, no hosted change.

---

## 1. Executive result

> **Updated 2026-08-29 - see '28. Social E2E - two-actor architecture' at the
> end of this report.** The two-actor harness is built and verified; the social
> scenarios remain blocked on a one-time owner sign-in for Actor B.

**A real-Firefox E2E harness exists and passes**: four scenarios, ~65
assertions, **95 seconds**, driving the real packaged extension in a real
Firefox 154.0.1. It closes three of F4's six gaps outright and permanently
guards WS-F4-01 at the browser level.

| F4 gap | F5 |
| --- | --- |
| home/browse → channel | **automated, passing** |
| collapsed Twitch chat | **automated, passing** |
| Strict ETP | **automated, passing** — the investigation's open question is answered |
| notification body-click | **classified human (F7)** — see §12 |
| **Gravity / JOIN** | **NOT DELIVERED — stop condition** |
| **Stream Rooms / realtime** | **NOT DELIVERED — stop condition** |

### The stop condition, stated plainly

F5's brief made the social fixture the critical requirement, and it is the one
thing I did not build. Every route to a second social identity hits a rule the
brief itself set:

- a second **real Twitch account** requires handling the owner's credentials —
  an explicit stop condition;
- a **privileged seeding RPC** means a hosted schema/policy change and a
  testing backdoor in production — the brief says stop and report the design
  first, and says not to add one casually;
- a **local Supabase-compatible backend** (auth + PostgREST + realtime) is the
  "large invasive framework" the brief rules out;
- **demo mode** cannot serve: `src/content/index.tsx:32` swaps in
  `createDemoClient()` *instead of* the port client, so it never exercises the
  worker, the Gecko adapter, the port or realtime — it would test the UI and
  quietly prove nothing about the pipeline.

There is also no existing seam to borrow: `grep` across `supabase/migrations/`
finds no test-account, `is_test` or synthetic-user concept.

So §4's design is written up in §4 for approval rather than implemented. The
rest of F5 was built, and the harness is deliberately shaped so that adding the
fixture later is a new scenario file, not a new harness.

No other stop condition fired. Zero production code changed.

---

## 2. Automation architecture

```
scripts/firefox-e2e/
  harness.mjs          launcher, profile sandbox, command channel, waitFor
  agents.mjs           the two injected agents, as source strings
  run.mjs              scenario runner, diagnostics, exit code
  scenarios/
    01-injection.mjs   panel, geometry, SPA navigation, collapsed chat
    02-lifecycle.mjs   multi-destination, suspend, revival, hydration
    03-platform.mjs    notifications, permissions, storage
    04-strict-etp.mjs  the same core, under Firefox Strict
```

### Why not `scripts/rdp.mjs`

The investigation proposed an RDP driver mirroring `scripts/cdp.mjs`. F2–F4
then showed two things that made it unnecessary: **`web-ext run` already
installs the add-on** over Mozilla's own protocol, and **the interesting state
lives inside the extension**, where an injected agent can read it directly. A
second protocol client would have been something to maintain for no capability
we lack. Re-evaluated against evidence, as the brief asked; the smallest
reliable mechanism won.

### The transport, and the two walls it had to get around

```
harness  <--HTTP-->  background agent  <--extension port-->  page agent
```

**Wall 1 — no remote eval.** MV3 extension pages run under `script-src 'self'`,
so `eval` and `new Function` do not exist. The agents therefore expose a **fixed
command vocabulary** (`dom`, `state`, `destinations`, `navigate`, `click`,
`chatToggle`, `notify.create`, `perm.remove`, `tabs.*`, `alarm.create`, …). That
turned out better than eval: each scenario reads as a sentence, and the whole
surface is greppable.

**Wall 2 — Twitch's CSP.** A content script cannot fetch localhost; Twitch's
policy blocks it. F2 hit this and so did the first draft of this harness. The
background agent is therefore the **only** HTTP client, and page agents reach it
over an extension port — the same mechanism the product uses. The harness
addresses a tab by a substring of its URL, and the page agent re-registers when
Twitch navigates, so a stale path never routes a command to the wrong tab.

### No sleeps

`waitFor(predicate, { timeout, label })` is the only waiting primitive. Every
wait carries a sentence that becomes the failure message — *"timed out after
45000ms waiting for the worker to aggregate a second destination"* — so a slow
machine waits longer instead of flaking, and a real break reads as prose.

That discipline caught two of my own mistakes: publishing trails aggregation by
the reporter's debounce, and sign-in restore is asynchronous. Both first
appeared as sampled-once assertions that were races dressed as tests; both are
now settled states.

---

## 3. Profile isolation

Structural, not conventional. `createProfile()` builds only under
`dist-firefox/e2e/` and throws if a resolved path escapes it, so the owner's
Firefox profile, the preserved F3 authenticated profile and `ffprofile-backup`
are **unreachable from the harness by construction**.

- Fresh profiles are left absent for `web-ext --profile-create-if-missing` to
  build — an empty directory it did not create makes it refuse to start.
- A seeded profile is **copied**, never opened, so the source cannot be mutated.
- Nothing reads cookies, credentials or tokens. Storage is reported by key name
  and shape; a session is a boolean.

---

## 4. Test-data architecture — PROPOSED, NOT BUILT

What a fixture must produce, per the brief: an accepted test friend; that friend
on channel A; A → B; leaving; joining the owner's channel; Stream Room
conditions; a realtime message.

All of it needs a **second authenticated identity** whose presence rows we may
write. Options, and why each stops:

| Option | Verdict |
| --- | --- |
| A — existing fixtures | **none exist**; no test-account concept in any migration |
| B — a second real Twitch identity | needs owner credentials — **stop condition** |
| C — local backend seam | demo mode bypasses the worker entirely; a real Supabase-compatible stub is the **large invasive framework** the brief rules out |
| D — privileged seeding RPC | hosted schema + policy change, and a production backdoor — **stop and report first** |

### The design I would propose, for approval

A **test-only identity, isolated by data rather than by privilege**:

1. One additional Supabase user created **once, by the owner**, from a
   throwaway Twitch account, and befriended normally through the product. No
   new RPC, no new policy, no impersonation — it is an ordinary account that
   happens to be ours.
2. Its credentials never touch this repository or the harness. The E2E run
   drives it through a **second Firefox profile** seeded the same way the owner
   seeded the first, exactly as `WATCHSIDE_E2E_SEED_PROFILE` already does for
   the primary. Two browsers, two profiles, one real friendship.
3. Presence is then produced **by the product**, not injected: profile B opens a
   Twitch tab and the real publisher does the rest. That is what makes the
   Gravity assertion worth anything.
4. Analytics isolation comes free — see §5.

This needs **no hosted change, no schema change and no backdoor**. What it needs
is a decision and a one-off account setup, which is why it is here rather than
in the code.

Rejected on purpose: writing presence rows for the three real beta friends
(`bobtheunstoppable`, `ohjuliego`, `wtfchuck27`). It would have made Gravity go
green today and it would have been fabricating other people's activity in a
production database.

---

## 5. Analytics contamination protection

The E2E build is packaged with `VITE_KICKBACK_ENV=private_beta`, so every event
a run emits is already **labelled with the beta cohort** and separable from
production. That is the same guarantee the tester builds carry, and it exists
because analytics were designed to be removable by cohort.

F5 adds no analytics and asserts on none. The proposed fixture identity would be
a distinct `user_id`, so its rows are filterable without any new marker; if a
stronger signal is wanted later, a dedicated `VITE_KICKBACK_ENV=e2e` value is a
one-line change to the packaging call and would need the analytics enum widened
— flagged, not done.

---

## 6. Gravity — NOT COVERED

No scenario exists, because no friend can be made present without §4. Not
written as a skipped test either: a permanently-skipped scenario is a claim that
decays into looking like coverage. The harness is ready for it — the page agent
can already read Gravity cards from the shadow root and `kickbackGravity.now()`
is reachable from the background.

## 7. JOIN — NOT COVERED

Same cause. JOIN needs a Gravity card to click.

## 8. Stream Rooms and realtime — NOT COVERED

Same cause. A room forms when friends share a destination.

---

## 9. SPA navigation — COVERED

`01-injection.mjs`, all four transitions, every one a **real click on a real
Twitch link** so Twitch's own router does the work. Assigning `location` would
be a full page load and would prove nothing about the SPA path, which is exactly
where duplicate injection happens.

| Transition | Result |
| --- | --- |
| channel → channel (`/lirik` → `/kaicenat`) | one host, one panel, in viewport |
| channel → non-channel (`/directory`) | one host, one panel |
| browse → channel | one host, one panel, in viewport |
| initial load | one host, one panel, shadow root, 1 style tag |

Plus zero page errors and zero background errors across the whole sequence.

## 10. Collapsed chat — COVERED

Twitch's own collapse control is clicked (`[data-a-target="right-column__toggle-collapse-btn"]`,
falling back to the aria-labelled button). With chat collapsed the panel stays
at exactly one, stays in the viewport, and still does not overlap chat.

Geometry is asserted as **relationships only** — `overlapChat === 0`,
`inViewport === true` — never coordinates. F4's lesson: the panel is draggable,
its position is user state, and Twitch's pixels are not ours to pin. Two runs at
different window sizes produced panel origins of `x=612` and `x=952`; both
passed, which is the point.

## 11. Strict ETP — COVERED, and the investigation's question is answered

`04-strict-etp.mjs` writes a `user.js` applying Firefox's own Strict category —
`browser.contentblocking.category=strict`, full tracking protection, cookie
behaviour 5 (dynamic first-party isolation), network state partitioning. Every
pref is **tightened**; nothing is loosened, because loosening one would answer a
different question.

Under Strict: the panel injects (one host, one panel, stylesheet present, in
viewport), **page-origin `localStorage` is writable**, extension storage is
unaffected and independent, the content script still opens a port and receives
state broadcasts, navigation still works and storage still works after it, and
there are zero page and background errors.

**Strict ETP does not materially change Watchside behaviour.** The open item
from the compatibility investigation is closed.

## 12. Notifications — PARTLY COVERED

`03-platform.mjs` asserts the pair that matters:

```
ok  Gecko accepts the payload the adapter emits
ok  Gecko rejects the same payload with buttons
    (Type error for parameter options (Property "buttons" is unsupported by Firefox))
ok  and rejects it specifically because of buttons
ok  a notification can be cleared
```

This is the most valuable assertion in the suite. It pins **why** `gecko.ts`
strips buttons: not tidiness, but the difference between a notification and
none. A future simplification that removed the strip fails here rather than
silently costing every Firefox user every notification.

**Body-click → open the channel: classified HUMAN (F7).** Clicking a real OS
notification is not something this harness can do without OS-level automation,
and the brief is explicit that faking a body-click and calling it OS acceptance
is not acceptable. It is one item on the F7 list.

## 13. Lifecycle — COVERED, and WS-F4-01 is permanently guarded

`02-lifecycle.mjs`, the only slow scenario (82s), isolated so the rest stay in
seconds:

```
ok  the destinations diagnostic is attached
ok  one port is registered / the first channel is aggregated
ok  the seeded profile is signed in
ok  the destination is published to the server
ok  two ports are registered / both channels are aggregated
ok  both channels are published to the server
ok  a background tab still contributes a destination      <- no focus weighting
ok  nothing is aggregated once no tab is watching / and nothing is published
ok  the background context was torn down and rebuilt
ok  the revived worker attached its diagnostics           <- WS-F4-01
ok  the revived worker hydrated its local caches          <- WS-F4-01
ok  the reconnecting tab restored the destination
ok  publishing resumed after revival
ok  no background errors across the whole lifecycle
```

The suite runs **signed-out by default**, so it works on any machine with no
credentials near it. Point `WATCHSIDE_E2E_SEED_PROFILE` at an authenticated
profile and the same scenario additionally proves what reaches the **server** —
and if a seed is supplied but sign-in never arrives, it **fails** rather than
silently downgrading, so a broken seed cannot hide behind a green run.

## 14. Permissions — COVERED

Granted at install, revocable at runtime, absent afterwards, no background
errors, browser still healthy, and the other host permissions untouched by
revoking one. Re-granting needs a user gesture, so restoration stays F7 rather
than becoming a testing-only product pathway.

## 15. Failure diagnostics

Every scenario attaches a diagnostics bundle on failure: the failed assertion in
prose, Firefox path and extension name/version/id (printed at start), current
URLs, background errors, page errors, tab list, storage key shapes, permission
state, and the last state broadcasts. A boot timeout additionally prints the
last twelve lines of web-ext's own output — added after a failure where the
browser's explanation was being thrown away.

`E2E_DEBUG=1` turns the channel into a transcript.

**Never captured:** tokens, refresh tokens, PKCE verifiers, OAuth state,
cookies, credentials. Storage is key names and shapes; a session is a boolean.
No screenshots are taken — nothing so far has been a visual failure, and a
screenshot of a Twitch page is a privacy question I did not need to open.

## 16. A/B/C classification

F4 guessed **A:1 · B:17 · C:4**. Measured:

| Check | F4 | F5 | Note |
| --- | --- | --- | --- |
| Extension loads under the fixed gecko id | B | **B — done** | |
| Single host / single panel | B | **B — done** | |
| No duplicate injection after SPA nav | B | **B — done** | |
| Shadow root + style tag | B | **B — done** | |
| Panel in viewport | B | **B — done** | |
| Panel ∩ chat = 0 | B | **B — done** | relationships, not coordinates |
| Panel ∩ player | C | **C** | by design; only a human can call it wrong |
| Page localStorage | B | **B — done** | |
| Strict ETP | B | **B — done** | |
| Two tabs connect ports | B | **B — done** | |
| Per-destination worker state | B (blocked) | **B — done** | unblocked by `7beaa0b` |
| Notification: stripped accepted | B | **B — done** | |
| Notification: buttons rejected | B | **B — done** | |
| Notification body click | C | **C** | OS-level; F7 |
| Permission revoke → clean failure | B | **B — done** | |
| Permission restore | C | **C** | user gesture required |
| No suspension while a port is open | B | **B — done** | |
| Suspension + alarm revival | B | **B — done** | |
| Auth restore after revival | A | **A** | F3 + unit-covered |
| Zero background/page errors | B | **B — done** | |
| Gravity render + JOIN | B | **B — blocked** | needs §4 |
| Stream Rooms / realtime | B | **B — blocked** | needs §4 |
| home/browse → channel | — | **B — done** | new |
| collapsed chat | — | **B — done** | new |
| worker hydrates on revival | — | **A + B — done** | unit *and* real-browser |

**A: 2 · B: 20 (18 built, 2 blocked) · C: 4.** The provisional estimate held up.

## 17. Release gate

```
npm run verify:firefox:e2e            all scenarios
npm run verify:firefox:e2e -- strict  by name
```

Deliberately **not** part of `npm test`. The lifecycle scenario has to out-wait
an event page suspending; folding 80 seconds of browser into the fast suite
would make ordinary development miserable and would train people to skip it.

Intended pre-public Firefox gate, fast to slow:

```
npm run build
npm test                      2273 tests, seconds
npm run verify:firefox        package invariants
npx web-ext lint              Mozilla's own validator
npm run verify:firefox:e2e    real browsers, ~95s
```

## 18. False-positive proof

Five deliberate mutations, each reverted immediately. Nothing was committed.

| | Mutation | Result |
| --- | --- | --- |
| M1 | content script removed from the manifest | **FAIL** — "timed out waiting for the panel to inject on a channel page" |
| M2 | content script listed twice | **passed** — see below |
| M3 | duplicate guard defeated **and** injected twice | **FAIL** — "exactly one host element — expected 1, got 2" |
| M4 | pre-fix worker bundle (WS-F4-01 reintroduced) | **FAIL** — "the destinations diagnostic is attached — expected object, got undefined" |
| M5 | second tab opened on the **same** channel | **FAIL** — "timed out waiting for the worker to aggregate a second destination" |

**M2 is worth its own line.** Listing the content script twice did *not* produce
a duplicate panel, and that is not a weak test — it is the product working:
`src/content/index.tsx:57` returns early if `#kickback-host` already exists. M3
defeats that guard in the packaged bundle and the assertion fails immediately,
which proves both that the assertion bites and that the guard is what normally
stops it.

Between them these cover the brief's list: extension not injected (M1),
duplicate panel (M3), wrong destination (M5), worker hydration absent (M4).
**Gravity absent and room message absent are not covered**, because those
scenarios do not exist.

## 19. Product defects discovered

**None.** Every scenario passes against the current build. One product
behaviour worth recording as a *good* finding: the content script's
duplicate-mount guard (§18, M2).

## 20. Production-code changes

**Zero.** `git status` shows only `package.json` (one new script) and the new
`scripts/firefox-e2e/` directory. No testability seam was added to the product —
the harness uses the diagnostics that already exist and the product's own port
protocol.

## 21. Hosted changes

**None.** No schema change, no policy change, no Supabase configuration change,
no new RPC. The fixture design in §4 is deliberately built to need none.

## 22. Chrome impact

**None.** No Chromium behaviour was changed to make Firefox tests easier. Both
submitted artifacts are untouched:

```
150e3c5b9319d3ccccba5ca0d07ba5a6ea38ccde1a9f426b8ffb280b7a818d3d  Watchside-Store-v0.6.0.zip
c1217ff5093ed2cb65a918eea21d14df4f66cbf48283487cae12c81e6067203e  Watchside-Private-Beta-v0.6.0.zip
```

Neither Chromium packager was run and no Store action taken. The harness is
written against a package directory and a browser binary rather than against
Gecko assumptions, so pointing it at Chromium later is a launcher change and a
second adapter for the transport — not a rewrite. That is design intent, not a
promise; no Chromium E2E work was started.

## 23. Test results

| Gate | Result |
| --- | --- |
| `tsc -b --force` | clean |
| `eslint .` | clean |
| `npm test` | **2273 passed / 87 files, 0 failed** |
| `backgroundLifecycle` · `browserAdapter` · `oauthContract` | included above, passing |
| `verify:firefox` | pass |
| `web-ext lint` | 0 errors, 3 warnings (unchanged from F2: data-collection key, two react-dom `innerHTML` false positives) |
| `verify:store` · `verify:config` · `verify:groups` | pass |
| **`verify:firefox:e2e`** | **4/4 scenarios, ~65 assertions, 95s** |
| `verify:lab` / `test:authz` | not run — excluded by instruction |

Firefox package rebuilt after the mutation work:
`1f456194c7e45f5f06ef7771005f8def2404938ee386e38bf882000ea75e9317` — the same
hash as before it, since packaging is reproducible.

## 24. Runtime and cost

| Scenario | Time |
| --- | --- |
| panel injection and SPA navigation | 4.5s |
| Gecko platform surfaces | 3.9s |
| strict Enhanced Tracking Protection | 4.1s |
| multi-destination and background revival | 82.3s |
| **total** | **~95s** |

Three of four scenarios finish in under five seconds because nothing sleeps. The
lifecycle scenario is slow for a real reason — an event page takes about a
minute of idle to suspend — and is isolated so the others stay fast. Running
just the fast three (`-- injection`, `-- platform`, `-- strict`) takes about 13
seconds.

## 25. Remaining F6 / F7 work

**Blocking F5 completion** — owner decision on §4, then one scenario file for
Gravity/JOIN and one for Stream Rooms. The harness needs no changes.

**F6 — AMO:** signing, listing, the source package for minified code, and
`data_collection_permissions` (owner decision, F2 report). `web-ext lint` still
reports it.

**F7 — human acceptance**, now a short list:
1. click a real gathering notification and confirm it opens the right channel;
2. look at the panel beside Twitch chat and say whether it sits well;
3. restore a revoked host permission from about:addons;
4. confirm Gravity and a Stream Room look right with a friend genuinely live —
   until §4 lands.

## 26. Commits and push

One commit: `feat: drive a real Firefox from Node` — the harness, the four
scenarios, the npm script, and this report. Pushed to `origin/main`.

## 27. Git status

- Branch `main`, tracking `origin/main`, pushed.
- **No production code changed**; `package.json` gained one script.
- `dist-firefox/` (including `e2e/`) is gitignored.
- Chromium extension ID `ngfopkeokddfnncdhfkhnffilbdhkkip` — unchanged.
- Hosted schema 28 — untouched. Supabase configuration — untouched.
- Chrome Web Store: submitted v0.6.0 — untouched.
- Firefox: harness live and green; **Gravity, JOIN and Stream Rooms remain
  unproven** and Firefox is not yet shippable.

---

# 28. Social E2E — two-actor architecture (2026-08-29)

The §4 design is approved and the harness now supports it. **Actor B does not
exist yet**, so the social scenarios are not written and F5 remains incomplete.
This section records what was built, one finding that needs a decision, and the
exact owner step.

## 28.1 Approved two-actor architecture

Built into the existing harness rather than beside it:

```
seed profile A (authenticated, read-only)  ──copy──▶  disposable profile A ──▶ Firefox A
seed profile B (authenticated, read-only)  ──copy──▶  disposable profile B ──▶ Firefox B
```

Three changes, all in `scripts/firefox-e2e/`:

- **`launch({ label })`** gives each actor its own instrumented package
  directory, so two browsers never share one.
- **The port is now assigned by the OS.** The channel binds port 0, reads back
  what it was given, and only then writes the agents with that port baked in.
  The old design guessed a port in a range and hoped — a race with nothing to
  gain, and one that two concurrent actors would eventually lose.
- **`seedProfile(actor)`** resolves `WATCHSIDE_E2E_SEED_A` / `WATCHSIDE_E2E_SEED_B`
  (the older `WATCHSIDE_E2E_SEED_PROFILE` still works for A).

### Verified, not assumed

Two browsers were driven concurrently against two isolated profiles:

```
actor A port 55580  boot boot-1787998550730-883
actor B port 55581  boot boot-1787998551139-813
distinct ports : true      distinct boots : true
A url /lirik  hosts 1      B url /shroud  hosts 1
A aggregated ["lirik"]     B aggregated ["shroud"]
ISOLATED     : true
```

Deliberately run with two **signed-out** profiles: this proves concurrency, port
allocation and isolation while touching no Watchside account.

## 28.2 Seed-profile model

A seed is authenticated **once**, by the owner, and thereafter only ever
**copied**. `createProfile()` builds solely under `dist-firefox/e2e/` and throws
if a resolved path escapes it, so a test cannot execute against a seed even by
mistake. Credentials never reach the harness — it handles a filesystem path and
nothing else.

## 28.3 Actor A — a finding that needs your decision

§4 said to stop and recommend if Actor A is the owner's normal account and
isolation cannot be guaranteed. **It cannot**, and the reason is structural
rather than a matter of care:

1. **Presence is broadcast to every friend.** `0026_growth_loop.sql:343` gates
   destination reads on `public.is_friend(user_id)`. Every E2E run would publish
   `AnoterosTV` watching test channels to all three real beta friends —
   `bobtheunstoppable`, `ohjuliego`, `wtfchuck27` — with no per-run opt-out.
2. **Rooms admit any friend on the channel.** `sessionState.ts:74` builds room
   peers from *every* friend whose presence matches the channel. A real friend
   who happened to be on the E2E channel would be pulled into the room and would
   see the per-run marker messages.
3. **Gathering notifications** would fire on real friends' machines.

None of that mutates their rows, which is the line §4 draws — but it does inject
synthetic activity into three real people's experience on every run, forever.

### Recommendation: two dedicated identities, A′ and B′

Then the E2E friend graph is exactly `{A′, B′}`, and "no unrelated user is
introduced" becomes **provable** rather than hoped. The cost is one extra
sign-in, once. Against sending indefinite synthetic presence and possible room
messages to three real testers, that is cheap.

If you would rather keep `AnoterosTV` as Actor A, that is a legitimate call —
the data is not corrupted, only observed — but it should be a decision, not a
default, which is why it is here.

## 28.4 Actor B setup — READY, AWAITING YOU

The profile directory has been created and the launch command verified end to
end in real PowerShell (it started Firefox, installed the add-on and wrote
`prefs.js`). No credential of any kind passed through this session: the harness
handles a path, and Twitch authentication happens directly between you and
Twitch in a browser window.

See §28.10 for the command and steps.

## 28.5 Friendship establishment — NOT PERFORMED

Planned as the normal product flow — A sends a friend request, B accepts,
through the panel UI the page agent already knows how to click. No row
insertion, no authorization bypass, no test-only mechanism. Once it exists it is
durable server state, so the suite will **verify** friendship rather than
recreate it each run.

## 28.6 Presence provenance — NOT PERFORMED

By design, Actor B's presence will be produced **by Watchside**: profile B opens
a Twitch channel and the real publisher does the rest. The harness may open
tabs, navigate and read diagnostics; it may not write presence. That is the
whole point — a Gravity assertion fed by injected rows would prove nothing about
the pipeline.

## 28.7 Gravity — NOT PERFORMED
## 28.8 JOIN — NOT PERFORMED
## 28.9 Stream Room and bidirectional messaging — NOT PERFORMED

All three need Actor B. Not written as skipped tests: the runner now **fails**
on a missing seed rather than skipping (§28.13), because a permanently-skipped
social scenario decays into looking like coverage.

## 28.10 OWNER ACTION — authenticate Actor B

Run this from `c:\Users\sk8bo\Projects\Kickback` in PowerShell. One line:

```
node node_modules\web-ext\bin\web-ext.js run --source-dir dist-firefox\package --firefox "C:\Program Files\Mozilla Firefox\firefox.exe" --firefox-profile C:\Users\sk8bo\watchside-e2e\seed-b --profile-create-if-missing --keep-profile-changes --start-url https://www.twitch.tv/lirik --no-reload
```

Then:

1. Sign in to **a dedicated throwaway Twitch account** — not your main one.
2. In the Watchside panel, click **Continue with Twitch**.
3. Wait until the panel shows the test identity.
4. Close Firefox, and tell me.

The profile keeps the session, so no further sign-in is needed on any run.

**If you accept §28.3**, run the same command a second time with `seed-a`
instead of `seed-b`, signing in as a second dedicated throwaway account. That
becomes Actor A′ and replaces the current Actor A seed.

## 28.11 Isolation proof

- Harness-level: §28.1's measurement — two profiles, two contexts, two
  destination sets, no bleed.
- Structural: `createProfile()` cannot address a path outside its sandbox.
- Social-level: **not yet provable**, and that is exactly what §28.3 is about.

## 28.12 False-positive mutations

The five from §18 stand and still bite. The three new social mutations the brief
requires — suppress B's presence, break the rendered JOIN, drop one actor's room
message — cannot be written before the scenarios exist. They are the first thing
to land after Actor B.

## 28.13 Release gate

A scenario may now declare `requires: ['A', 'B']`. The runner resolves each seed
and, if one is missing, **fails that scenario with a named reason** —
`WATCHSIDE_E2E_SEED_B is not set` — and stops the gate. It never skips.

Filtering still works for development: `npm run verify:firefox:e2e -- injection`.

Once the social scenarios land, `npm run verify:firefox:e2e` runs everything by
default, including the ~83s lifecycle scenario. That is the right shape for a
release gate; the fast subsets remain available by name.

## 28.14 Analytics

Unchanged. E2E runs are built `VITE_KICKBACK_ENV=private_beta`, so their events
are cohort-labelled and separable, but they **currently share the `private_beta`
cohort with real testers**. A dedicated `e2e` value would need the analytics
enum widened, which the brief rules out for F5 — recorded as potential
M3/pre-public work.

## 28.15 Runtime

Unchanged: 4 scenarios, ~97s, of which the lifecycle scenario is ~83s. The
social scenarios will add browser launches; two concurrent actors start in about
the same wall-clock as one, since they launch in parallel.

## 28.16 Remaining human acceptance

Unchanged from §25, plus the one-time Actor B (and possibly A′) sign-in above.

## 28.17 F5 verdict

### F5: INCOMPLETE - stopped at the owner boundary, as instructed

Infrastructure for two actors is built and verified. Seven of the thirteen
completion criteria in §14 of the brief are met and passing; the six social ones
are not, and no fake data was introduced to make them look met.

| Criterion | State |
| --- | --- |
| initial injection · SPA navigation · collapsed chat · Strict ETP · notifications · lifecycle · permission revocation | **PASS** |
| two-actor presence · Gravity · rendered JOIN · arrival · Stream Room · bidirectional messages | **blocked on Actor B** |

## 28.18 Production and hosted impact

**Zero production code.** **Zero hosted changes** — no schema, policy, RPC or
configuration change, and no seeding mechanism of any kind. Changes are confined
to `scripts/firefox-e2e/` and this report.

## 28.19 Chrome

Untouched. Both submitted artifacts unchanged
(`150e3c5b…b7a818d3d`, `c1217ff5…6067203e`), neither packager run, no Store
action.

## 28.20 Git status

- Branch `main`, tracking `origin/main`, pushed.
- Changed: `scripts/firefox-e2e/{harness,run}.mjs`,
  `scripts/firefox-e2e/scenarios/02-lifecycle.mjs`, this report.
- `dist-firefox/` and the seed profiles are outside version control.
- Chromium extension ID `ngfopkeokddfnncdhfkhnffilbdhkkip` — unchanged.
- Hosted schema 28 — untouched.
- Firefox: harness ready for two actors; **social pipeline still unproven**.
