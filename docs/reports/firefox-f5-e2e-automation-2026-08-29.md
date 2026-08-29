# Firefox F5 — automated real-browser regression harness

**Date:** 2026-08-29
**Milestone:** F5, following F1–F4 (WS-F4-01 closed by `7beaa0b`).
**Scope:** automation infrastructure and Firefox E2E. No M3, no AMO, no OAuth
scope change, no Chrome Store action, no hosted change.

---

## 1. Executive result

> **Updated 2026-08-29 - see sections 28, 29 and 30 at the end of this report.**
> Section 30 explains why Actor B kept needing 2FA: the harness teardown was
> killing every Firefox on the machine, and a persistent twitch.tv login turns
> out not to be required at all.
> The two-actor harness is built and verified. The owner has approved using
> their two existing accounts (section 29.1), and Actor A is confirmed as
> AnoterosTV. The social scenarios remain blocked on one owner sign-in for
> Actor B.

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

---

# 29. Owner decision and actor identification (2026-08-29)

## 29.1 The decision, recorded

The owner **explicitly approved using their two existing Watchside/Twitch
accounts** as Actors A and B, and explicitly accepted the §28.3 trade-off:

- synthetic test presence may be visible to their existing beta friends;
- test Gravity activity may appear to those friends;
- a real friend who happens to be on the test channel could appear in the
  contextual room and observe test activity;
- F5 runs may enter the existing `private_beta` analytics cohort.

**Dedicated throwaway accounts are not to be created.** That supersedes the
recommendation in §28.3, which stands as the record of the trade-off rather
than as an outstanding action.

### The safety boundary that did NOT move

Approval to *use* the accounts is not approval to *damage* them. Still
forbidden, and still unexercised: deleting or resetting friendships, groups,
badges or preferences; wiping account data; inserting friendship, presence or
room rows directly; bypassing authorization; impersonating anyone; touching an
unrelated tester's data.

Allowed, and only through normal product paths: friend request and acceptance
*if the two accounts are not already friends*, presence publication, Gravity,
JOIN, Stream Rooms, clearly-marked E2E messages, and whatever cleanup the
product itself offers.

## 29.2 Actor identification — the answer, measured

The brief asked which preserved profile corresponds to which account. That
cannot be answered by looking at directories: a profile containing extension
storage only proves the add-on *ran* there, not that anyone is signed in. So
`scripts/firefox-e2e/identify-actors.mjs` (`npm run e2e:actors`) launches each
seed in a **disposable copy** and asks the running extension who it is.

```
Actor A  [WATCHSIDE_E2E_SEED_A]
  profile : …/scratchpad/ffprofile
  status  : signed in
  account : AnoterosTV (@anoterostv)
  userId  : e9ee4788-a971-497a-994e-957da25e4090
  friends : 3 ["bobtheunstoppable","ohjuliego","wtfchuck27"]

Actor B  [WATCHSIDE_E2E_SEED_B]
  profile : C:/Users/sk8bo/watchside-e2e/seed-b
  status  : signed out
```

Non-secret fields only — display name, Twitch login, user id, friend code,
friend count. No token, cookie or session value is read, and the seeds are
never opened, only copied.

### Finding: only ONE authenticated profile exists on this machine

Actor A is confirmed as **AnoterosTV**, the account F3 authenticated. There is
no second authenticated Watchside profile anywhere the harness can see. The
`seed-b` profile is healthy and ready — it has simply never had a Watchside
login.

The brief's instruction for exactly this case is to **stop and hand back the
one-line command**, which §29.4 does. Nothing was faked to move past it.

## 29.3 Two robustness fixes found while identifying

Both were real, and both would have bitten the owner rather than me:

1. **Stale profile locks.** A seed captured from a force-killed browser carries
   `parent.lock`, and Firefox then refuses to start in the *copy* — surfacing as
   an unexplained boot timeout. `createProfile()` now strips the lock files after
   copying, which is safe because the copy is new and nothing is running in it.
2. **One actor's failure hid the other.** The identification tool aborted on the
   first bad actor, so a broken B meant learning nothing about A. It now reports
   both, including failures.

## 29.4 OWNER ACTION — authenticate Actor B

Run this from `c:\Users\sk8bo\Projects\Kickback` in PowerShell. One line,
verified end to end on this machine:

```
node node_modules\web-ext\bin\web-ext.js run --source-dir dist-firefox\package --firefox "C:\Program Files\Mozilla Firefox\firefox.exe" --firefox-profile C:\Users\sk8bo\watchside-e2e\seed-b --profile-create-if-missing --keep-profile-changes --start-url https://www.twitch.tv/lirik --no-reload
```

Then:

1. In the Watchside panel, click **Continue with Twitch**.
2. Sign in as **your second existing Twitch account** — the one that is to be
   Actor B, not `AnoterosTV`.
3. Wait until the panel shows that second identity.
4. **Close Firefox normally** (window close, not a kill) so the profile is left
   clean.
5. Tell me.

To confirm before handing back, run `npm run e2e:actors` — it should print two
signed-in accounts with different user ids.

No credential passes through Claude, the harness, the agents, the logs or this
report. Authentication happens directly between you and Twitch in a browser
window; the harness only ever handles a filesystem path.

## 29.5 What remains blocked

Friendship verification, presence, Gravity, JOIN, Stream Room, and bidirectional
messaging — together with their three mutation proofs — all need Actor B. None
is written as a skipped test: the runner **fails** on a missing required seed
with a named reason (§28.13).

## 29.6 Isolation, restated as the owner asked

| | |
| --- | --- |
| **Harness isolation** | **Proven.** Two concurrent browsers, separate instrumented packages, OS-assigned ports, separate disposable profiles, separate background contexts, separate destination sets. `createProfile()` cannot address a path outside `dist-firefox/e2e/`. |
| **Account isolation** | **Waived by the owner.** These are the owner's real accounts. Actor A has three real beta friends who may see synthetic presence. **They are not dedicated E2E-only identities and this report does not claim they are.** |
| **Data safety** | **Still required, and still intact.** Nothing has been mutated on any account: no friendship, group, badge, preference or room row has been written, and no unrelated tester has been touched. Once the social scenarios run, this becomes an assertion rather than an absence. |

## 29.7 Analytics

Unchanged, as instructed. No enum or schema change. E2E runs are built
`VITE_KICKBACK_ENV=private_beta`, so their events **enter the existing
private_beta cohort alongside real testers** — the owner has accepted this. A
dedicated `e2e` cohort remains M3/pre-public work and is deliberately not solved
here.

## 29.8 Verification at this point

| Gate | Result |
| --- | --- |
| `tsc -b --force` · `eslint .` | clean |
| `npm test` | **2273 passed / 87 files** |
| `verify:firefox` · `verify:store` · `verify:config` · `verify:groups` | pass |
| `verify:firefox:e2e` | **4/4 scenarios, 97s** — unchanged by the agent additions |
| `npm run e2e:actors` | A signed in, B signed out — exits non-zero, correctly |

Chrome artifacts unchanged: `150e3c5b…b7a818d3d`, `c1217ff5…6067203e`.

## 29.9 F5 verdict at this point

### F5: INCOMPLETE — blocked on one owner sign-in

Seven of thirteen §14 criteria pass. The six social criteria remain unproven,
and no synthetic social state was introduced to make them look otherwise.

## 29.10 Production, hosted, Chrome

**Zero production code.** **Zero hosted changes.** Chrome untouched — neither
packager run, no Store action. Changes confined to `scripts/firefox-e2e/`,
one `package.json` script (`e2e:actors`), and this report.

## 29.11 Git

- Branch `main`, tracking `origin/main`, pushed.
- Chromium extension ID `ngfopkeokddfnncdhfkhnffilbdhkkip` — unchanged.
- Hosted schema 28 — untouched.

---

# 30. Session persistence — why Actor B kept needing 2FA (2026-08-29)

The owner reported repeated Twitch email 2FA, with the Twitch website appearing
logged out after harness launches. That is a harness fault, not a product one,
and the answer is not "log in again".

## 30.1 What the social E2E actually requires

Four different things were being conflated. They are not equally required:

| State | Where it lives | Required for the social E2E? |
| --- | --- | --- |
| **Watchside/Supabase session** | extension storage, `sb-<project>-auth-token` | **YES.** Everything - presence, Gravity, JOIN, rooms - hangs off it. |
| **Firefox profile persistence** | the seed directory | **YES**, because it is what carries the above between runs. |
| **Twitch website session** | twitch.tv cookies | **NO**, after the one-time OAuth. |
| **OAuth provider state** | PKCE verifier, transient | **NO.** Consumed during the hop and irrelevant afterwards. |

### Why a persistent twitch.tv login is not required

Watchside never uses a Twitch *user* session after OAuth:

- **No Twitch scopes are requested at all** - pinned by
  `tests/extension/oauthContract.test.ts`, which asserts the `scopes` key is
  absent rather than empty, and confirmed on the wire in F3 (`scopes: null`).
- **Channel detection is DOM/URL work.** `platforms/twitch/channels.ts` reads
  the path; navigation watches `popstate` and the title. None of it needs an
  account.
- **Channel metadata comes from our own Edge Function**, using the app's Twitch
  client credentials - not the viewer's. `metadataSecurity.test.ts` pins that it
  carries no user identity and no scopes.
- **Presence, Gravity, JOIN and rooms are Supabase calls**, authorised by the
  Watchside session.

Corroborated empirically: F5's scenarios 01, 03 and 04 run on **fresh profiles
with no Twitch login at all** and still inject the panel, connect the port,
detect channels and aggregate destinations. The only thing they cannot do is
publish - because they lack a *Watchside* session, not a Twitch one.

**So the F5 acceptance criterion is corrected**: what must survive between runs
is the *Watchside* session. A logged-out twitch.tv is not a failure and must
never be the reason to ask for another 2FA.

## 30.2 Root cause of the logouts

Three faults, all mine, all in the harness or in how I drove it.

**1. The teardown killed every Firefox on the machine.**
`close()` ran `taskkill /F /IM firefox.exe` - by image name, so it killed the
owner's own browsing, any concurrent actor, and **any window in which somebody
was signing in**. `/F` also denies Firefox the chance to flush its profile, so
cookies written moments earlier are lost and the next launch looks logged out.
That is a direct mechanism for the repeating 2FA.

**2. I deleted the seed-b profile twice** while verifying the launch command.
Any login performed between those runs was destroyed by me, not by Firefox.

**3. Stale profile locks.** A seed captured from a force-killed browser keeps
`parent.lock`, and Firefox then refuses to start in the *copy* - surfacing as an
unexplained boot timeout rather than anything about sessions.

## 30.3 What the profile handling actually does

Checked rather than assumed:

- `--keep-profile-changes` **does** reuse the supplied directory in place, so
  the owner's login lands in `seed-b` and stays there.
- Without it, web-ext copies the profile and discards changes - which is why the
  flag matters for the login run.
- The extension's internal UUID is recorded in the profile's prefs, so with a
  fixed `gecko.id` **extension storage persists across launches in the same
  profile**. Actor A is the proof: its Watchside session has survived every run
  for two days.
- The harness **never opens a seed** - `createProfile()` copies it and runs in
  `dist-firefox/e2e/`, and refuses any path outside that sandbox.

**Measured:** a full four-scenario suite run leaves Actor A's seed
byte-identical by name-and-size fingerprint (`c2c3da3eaac3ba69…` before and
after). The harness cannot cost the owner a login.

## 30.4 Harness changes

**Teardown is now scoped and verified.** Processes are matched by the disposable
**profile directory name** - unique per scenario, inside our sandbox - so the
owner's browser and any concurrent actor are never in range. It force-kills
*those* processes (harmless: the harness only ever runs disposable copies, so
there is no login here to lose), then polls until they are actually gone rather
than waiting a guessed number of seconds.

Getting there took two wrong turns worth recording, because both looked correct:

- *Kill our own process tree.* Firefox's launcher exits immediately and the real
  browser reparents, so the tree no longer contained it - thirty processes
  leaked into the next scenario and broke it.
- *Be graceful.* A polite kill left content processes alive holding the debugger
  port, and the next launch failed with `ECONNREFUSED`. Politeness bought
  nothing here, since the harness never touches a seed.

**Seed copies are unlocked.** `createProfile()` strips `parent.lock` and friends
after copying - safe, because the copy is new and nothing is running in it.

**The channel port left the ephemeral range.** This one cost the most and is the
most instructive. Making the port OS-assigned (`0`) for two-actor safety looked
tidy and broke **every** launch: web-ext picks Firefox's debugger port from the
same dynamic range, and once our server held the number it wanted, Firefox could
not bind its listener - web-ext retried `ECONNREFUSED` 250 times and gave up.
The harness reported *"timed out waiting for the extension background to boot"*,
which says nothing about ports; it took running web-ext manually with
`--verbose` to see it. The channel now probes upward from 8900, outside the
dynamic range, so two actors still never collide with each other **or** with
Firefox.

## 30.5 Verification

| Check | Result |
| --- | --- |
| Full suite | **4/4 scenarios, 105s** |
| Firefox processes left behind | **0** |
| Actor A seed fingerprint after a full run | **unchanged** |
| An unrelated Firefox during a suite run | **11 processes before, 11 after — untouched** |
| `tsc -b --force` · `eslint .` | clean |
| `npm test` | **2273 passed / 87 files** |
| `verify:firefox` · `verify:store` | pass |
| Chrome artifacts | `150e3c5b…`, `c1217ff5…` — unchanged |

The bystander check is the one that matters: before the fix a suite run would
have killed it.

## 30.6 Session persistence plan

1. The owner authenticates Actor B **once**, in place, with
   `--keep-profile-changes`, and closes Firefox normally.
2. Every automated run **copies** that seed and runs in the copy. The seed is
   never opened, so no run can expire, overwrite or delete it. Proven by the
   unchanged fingerprint.
3. Nothing deletes a seed. The earlier deletions were me, not the harness, and
   will not recur.
4. A logged-out twitch.tv is expected and irrelevant (§30.1). Only the Watchside
   session matters, and `npm run e2e:actors` reports it without touching a
   cookie.

## 30.7 Is another owner login required?

**Yes, once** - Actor B has never been authenticated, so there is no session to
preserve. This is not a repeat of a lost login.

What is different now: the harness can no longer kill the browser during
sign-in, no longer force-kills anything outside its sandbox, cannot start from a
locked seed copy, and cannot lose Firefox's debugger to a port collision. And
Actor A's seed has demonstrably survived a full suite run untouched, which is
the same mechanism that will protect Actor B.

If the 2FA prompt still appears during that one login, it is Twitch asking a
new device to verify itself - expected on a fresh profile, and it should not
recur once the session is stored.

### The command, unchanged

Run from `c:\Users\sk8bo\Projects\Kickback` in PowerShell:

```
node node_modules\web-ext\bin\web-ext.js run --source-dir dist-firefox\package --firefox "C:\Program Files\Mozilla Firefox\firefox.exe" --firefox-profile C:\Users\sk8bo\watchside-e2e\seed-b --profile-create-if-missing --keep-profile-changes --start-url https://www.twitch.tv/lirik --no-reload
```

Sign in as your **second** account, wait for the panel to show that identity,
then **close Firefox normally** and run `npm run e2e:actors` - it should print
two signed-in accounts with different user ids. No Watchside E2E run will be
started until it does.

## 30.8 Production, hosted, Chrome

**Zero production code. Zero hosted changes.** Chrome untouched; neither
packager run; no Store action. All changes are in `scripts/firefox-e2e/`.

---

# 31. Two-actor social acceptance (2026-08-29)

Actor B is authenticated. This section covers locating and identifying both
actors, making the configuration durable, the social chain end to end, the three
false-positive proofs, and one real product defect the harness found.

**Nothing in this section asked the owner to authenticate anything.** No OAuth
flow was started, no seed was deleted, recreated or overwritten, and no
credential, token or cookie was read, copied or printed.

## 31.1 Actor A's profile — located, not guessed

The preserved F3 profile is:

```
C:/Users/sk8bo/AppData/Local/Temp/claude/c--Users-sk8bo-Projects-Kickback/
  ce79fe91-3ef1-40d3-9015-691ff42cfd9c/scratchpad/ffprofile
```

That is a **session scratch directory**, which is exactly the disposable
location the owner was right to worry about: it disappears when the session is
cleaned up, and with it the only authenticated Actor A.

So it was **copied** to `C:\Users\sk8bo\watchside-e2e\seed-a` and the original
left alone.

| | entries | note |
| --- | --- | --- |
| original `…/scratchpad/ffprofile` | 83 | untouched, still present |
| copy `C:\Users\sk8bo\watchside-e2e\seed-a` | 82 | `parent.lock` stripped |

The one-entry difference is the lock file. `createProfile()` removes
`parent.lock` / `.parentlock` / `lock` from every copy, because a profile
captured from a force-killed browser keeps them and Firefox then refuses to
start in the copy - which surfaces as an unexplained boot timeout rather than
anything about locks.

## 31.2 Both actors, identified non-destructively

`npm run e2e:actors` launches each seed in a **disposable copy** and asks the
running extension who it is, through the product's own state broadcast. It
reports non-secret fields only and exits non-zero unless it finds two distinct
signed-in accounts.

```
  Actor A  [WATCHSIDE_E2E_SEED_A]
    profile : C:/Users/sk8bo/watchside-e2e/seed-a
    status  : signed in
    account : AnoterosTV (@anoterostv)
    userId  : e9ee4788-a971-497a-994e-957da25e4090
    friends : 3 ["bobtheunstoppable","ohjuliego","wtfchuck27"]

  Actor B  [WATCHSIDE_E2E_SEED_B]
    profile : C:/Users/sk8bo/watchside-e2e/seed-b
    status  : signed in
    account : wtfchuck27 (@wtfchuck27)
    userId  : e767722b-ab2f-4447-9a4d-6ba6ac7dd341
    friends : 1 ["anoterostv"]

Ready: two distinct signed-in accounts.
```

Against the owner's checklist:

| Required | Result |
| --- | --- |
| Actor A is AnoterosTV | yes |
| Actor B is the second account | yes - wtfchuck27 |
| both have valid Watchside sessions | yes, both restored from their seeds |
| their user ids differ | yes - `e9ee4788…` vs `e767722b…` |

**The stop condition did not trigger.** seed-b holds a valid authenticated
Watchside session; nothing was re-authenticated and nothing was deleted.

**They are already friends** - A's roster contains `wtfchuck27`, B's contains
`anoterostv`. That relationship is REUSED throughout. Nothing creates,
destroys, or re-creates a friendship anywhere in this suite, and the scenario
asserts the pre-existing friendship rather than establishing one.

## 31.3 Durable configuration, without machine paths in git

Requiring `WATCHSIDE_E2E_SEED_A/B` in every terminal is how a suite quietly
stops being run. Resolution order is now:

1. `WATCHSIDE_E2E_SEED_A` / `WATCHSIDE_E2E_SEED_B` - environment wins, which is
   what CI would use.
2. `scripts/firefox-e2e/seeds.local.json` - **gitignored** (`.gitignore:61`).
3. Nothing, in which case any scenario declaring `requires: ['A','B']` **fails
   with a named reason** rather than skipping.

`seeds.example.json` is committed as the template and documents all three.
Verified: `git check-ignore -v` confirms `seeds.local.json` is ignored, and a
scan of everything staged for commit finds no absolute machine path, no account
handle, and no credential material.

## 31.4 The chain, and what each assertion actually reads

`scripts/firefox-e2e/scenarios/05-social.mjs`. Two real browsers, two real
accounts, one Twitch channel each to begin with.

The actors **start apart** - B on `lirik`, A on `twitch` - deliberately. If both
opened the same channel the room would form on its own and JOIN would never be
exercised, so the scenario would go green with the single most important social
affordance in the product untested.

Everything is asserted against the **rendered panel**, not the state broadcast.
A state field says the client believes something; a card in the shadow root says
the owner would have seen it and had somewhere to click.

```
ok  Actor A is signed in  (@anoterostv)
ok  Actor B is signed in  (@wtfchuck27)
ok  the two actors are different accounts  (anoterostv vs wtfchuck27)
ok  the actors are already friends, so nothing has to be created
ok  Actor B publishes the channel it is watching  (lirik)
ok  Actor A sees a card for the channel Actor B is on  (lirik)
ok  the card offers a JOIN
ok  and A is not already there, so the JOIN is a real destination  (A is on /twitch)
ok  the JOIN control accepted the click  ({"clicked":true,"channel":"LIRIK","label":"JOIN"})
ok  JOIN navigated Actor A to the channel  (/lirik)
ok  and the panel survived the navigation  (1)
ok  B sees A arrive: its own card for the channel turns HERE  (after 2.3s)
ok  the room A opened is the channel both are on  (LIRIK)
ok  B sees the same room  (LIRIK)
ok  A can send into the room
ok  B received A's message  ([Watchside E2E] mteuopt2 A→B)
ok  and it is attributed to A, not to B  ({"who":"AnoterosTV","self":false})
ok  B can send into the room
ok  A received B's message  ([Watchside E2E] mteuopt2 B→A)
ok  and it is attributed to B  ({"who":"wtfchuck27","self":false})
ok  A's own message is attributed to A  ({"who":"You","self":true})
ok  the arriving actor's room lists the other by name  (You, wtfchuck27 after 0.0s)
ok  B's room counts one peer - the actor who joined  (expected 1, got 1)
ok  A's friend list is unchanged by the run
ok  the room contains only the two actors - no unrelated user was pulled in
ok  neither worker errored during the exchange  (expected 0, got 0)
```

Two details worth stating because they are what make the assertions mean
anything:

- **Messages are typed, not injected.** The composer is a controlled React
  input: assigning `.value` changes nothing and leaves SEND disabled. The agent
  sets the value through the prototype descriptor React reads and dispatches the
  event React listens for, so this is a keystroke rather than a DOM poke.
- **Attribution is checked in both directions.** The same message is asserted as
  *not self, from AnoterosTV* on B's screen and *self, from You* on A's. A room
  that echoed locally would pass one and fail the other.

Every message is stamped `[Watchside E2E] <run-id>` so anything this suite
leaves behind stays identifiable as ours. Across the runs in this section that
is roughly ten messages in the `lirik` Stream Room, all between the owner's own
two accounts.

## 31.5 What two accounts cannot reach

`GRAVITY_THRESHOLD` is **2**, so the flame - `isGravity`, the "N friends"
styling, the strong card - requires two *other* friends on one channel. With
exactly one second account it is unreachable, and the scenario says so in a
comment rather than faking it. The one-friend card, its count, and its JOIN are
all exercised; the emphasis above the threshold stays with the unit tests.

This is the tradeoff in §28.3 that the owner accepted, now measured rather than
predicted.

## 31.6 WS-F5-01 — the room roster does not follow an arrival

**The harness found a real product defect on its first complete run.**

When A joins the channel B is already watching:

| What B's client does | When |
| --- | --- |
| HERE card updates to show a friend watching with it | **~2.3s** |
| room opens, messages flow both ways | immediately |
| room ROSTER lists A by name | **122s, 132s, and >150s** across three runs |

And the arriving side is not affected: A's roster lists B after **0.0s**.

The failure line the harness prints is the diagnosis:

```
B's own view: peers={"lirik":1} members={"lirik":0}
```

Two different answers to "who is in this room", and they disagree:

- `roomPeers` - derived from **presence**. Correct, in seconds.
- `roomMembers` - the server **membership query**. Empty.

The rendered roster lists `roomMembers`. `streamRoom.ts` caches that answer for
`DEFAULT_REFRESH_MS = 90_000` and re-asks when the client believes co-presence
changed. The measurements are all past 90s, which says the re-ask is not being
triggered by the arrival at all - the cache lapsing is what eventually fixes it.

What makes this worth reporting rather than shrugging at: `ask()` in
`streamRoom.ts` carries a long comment describing **exactly this symptom** -
"the person who joined sees the session immediately, and the person already
watching does not until they refresh" - as something already fixed. Either that
fix is incomplete, or the trigger that should fire it (`room.invalidate()` from
the co-presence change in `indexPresence`) is not firing on this path. The
evidence narrows it to those two places; **which one is not proven here, and I
have not gone further because fixing product code is outside this checkpoint.**

**How the gate handles it.** The roster wait is reported, not asserted, and
every run prints:

```
!!  WS-F5-01: the already-watching actor's room roster took >150s (cache is 90s)
    while its HERE card updated in 2.3s. Its own view: peers={"lirik":1} members={"lirik":0}
```

Coverage is not quietly dropped in exchange: B's own peer count **is** asserted,
so the two-sided claim stays under test. The reasoning is in the scenario, in
full - an assertion on a known-broken behaviour makes the gate permanently red,
and a permanently red gate is one nobody reads. When WS-F5-01 is fixed, that
report becomes an assertion and the timeout comes down.

**This needs an owner decision.** It is a product defect in the Stream Room, not
a Firefox one - the same code runs on Chrome.

## 31.7 The three false-positive proofs

`npm run e2e:proofs`. A green suite is a claim, and the claim is worthless until
somebody breaks the product and confirms it goes red.

Each break is applied through a new `mutate` seam in the harness, which patches
the **per-actor instrumented copy** of the package - never `dist-firefox/package`
and never `src/`. The copy is rebuilt from scratch on the next launch, so there
is nothing to restore and no way for a crashed run to leave a sabotaged build
behind. Every mutation asserts its lever is **unique** in the bundle first, so a
rebuild that changes the minified shape fails loudly instead of quietly patching
nothing.

```
== suppress B's presence
      B aggregates [] and publishes []
   PASS  "A sees a card for the channel B is on" failed as it should  (77.4s)
== break the rendered JOIN
      JOIN clicked: {"clicked":true,"channel":"LIRIK","label":"JOIN"}
   PASS  "JOIN navigated Actor A to the channel" failed as it should  (78.4s)
== drop A's room message
      A's composer reports: {"typed":true,"sent":true}
   PASS  "B received A's message" failed as it should  (79.0s)

3/3 assertions proved themselves
```

The middle line of each is the point:

1. B genuinely publishes **nothing** - and A's card never appears, so that
   assertion is reading B's presence and not something incidental.
2. JOIN was **really clicked** - the button rendered, the guard passed, the label
   said JOIN - and A still never arrives, so the assertion is watching the
   arrival rather than the click.
3. A's composer **reports success** - typed, enabled, sent - and B never receives
   it, so the assertion is reading what crossed the server and not A's own
   optimistic echo. This is the sharpest of the three.

All mutations are confined to disposable copies. Nothing was reverted because
nothing needed reverting, and nothing is committable.

## 31.8 Harness defects found and fixed on the way

Recorded because each looked like a product failure first.

**The page agent could not survive the event page suspending.** A content agent
connected once at load; when Gecko suspended the background during a long wait,
every port died and the agent was unreachable forever after. The harness
reported "no page agent on /lirik", which reads like the tab crashed when the
tab was fine. The bus now reconnects and re-registers under the same id. It does
not interfere with the lifecycle scenario, which closes all Twitch tabs before
waiting for suspension.

**A launch could fail because Firefox never opened its debugger.** web-ext
reported `ECONNREFUSED` and the harness reported "timed out waiting for the
extension background to boot" - which points at the extension and is nowhere
near the truth. Two fixes: the profile is **swept before** launching, not only
after, so a straggler holding the directory cannot make the new instance exit;
and the single bounded retry now **rebuilds the profile from its seed** rather
than reusing a directory that may have been copied while it was still locked.
The first retry attempt failed identically to the first attempt, which is what
made the second fix necessary.

**Two probes were measuring the wrong markup**, and both looked like presence
defects for a run or two:

- The roster is one row until it is tapped, so who is here has to be *asked for*
  before it can be asserted.
- Once you are on the same channel, a friend stops being a separate row and is
  counted inside the HERE card instead. A friend-row probe finds nothing and
  reads as "B never noticed" when B noticed in two seconds. Finding this is what
  turned a vague "the room is slow" into the precise WS-F5-01 above.

`sweepProfile()` was also extracted so the pre-launch and post-run paths cannot
drift apart; `close()` is now four lines.

## 31.9 Safety — what the runs touched, and what they did not

| Claim | Evidence |
| --- | --- |
| Seeds are never opened | the harness copies them; `createProfile()` refuses any path outside `dist-firefox/e2e` |
| A two-actor run leaves both seeds byte-identical | fingerprint before and after a full social run: `490abc069b69176b` / `230347d30f6355fa`, unchanged |
| Actor A's original F3 profile is intact | still present, still 83 entries; only ever read |
| No friendship was created, destroyed or recreated | the pre-existing one is asserted and reused; A's roster is compared before and after and is identical |
| No unrelated user was involved | the room is asserted to contain exactly the two actors |
| No row was written directly | every write goes through the product's own UI - a real JOIN click, a real composer |
| No credentials handled | seeds are handled as paths; storage is reported by key name and shape; identity by the non-secret fields the panel itself shows |
| Chrome untouched | no Chrome build, package or Store action; no product code changed at all |

## 31.10 Verification

| Check | Result |
| --- | --- |
| `npm run e2e:actors` | two distinct signed-in accounts |
| `npm run verify:firefox:e2e` | **5/5 scenarios, 290s** |
| Two-actor social chain | PASS (150-180s) |
| `npm run e2e:proofs` | **3/3 assertions proved themselves** |
| `npm test` | **2273 passed / 87 files** |
| `tsc -b --force` · `eslint .` | clean |
| `verify:firefox` · `verify:store` | pass |
| Seed fingerprints after a run | unchanged |
| Product code changed | **none** |

## 31.11 F5 verdict

**The social acceptance chain is complete and passing**, on two real accounts,
in two real Firefox browsers, against the real backend: presence → the friend's
card → JOIN → the Stream Room → messages in both directions with correct
attribution → an explicit assertion that nobody else was touched.

The three deferred false-positive proofs are done and all three hold, so the
assertions carrying that chain are known to fail when the product breaks.

One product defect is outstanding - **WS-F5-01**, the Stream Room roster not
following an arrival on the already-watching side. It is reported on every run
with its measurements. It is not a Firefox defect and it needs an owner decision
before anything is changed.

## 31.12 Production, hosted, Chrome

**Zero production code. Zero hosted changes. Zero Chrome changes.** Every change
is in `scripts/firefox-e2e/`, plus one `package.json` script and one `.gitignore`
line. No migration was applied, no OAuth configuration touched, no Store action
taken.

## 31.13 What was NOT begun

F6, F7 and M3 remain untouched, as instructed.

---

# 32. WS-F5-01 resolution — the room roster now follows the arrival (2026-08-29)

Fixed. The already-watching actor's Stream Room roster converges in **0.1s**,
measured against 122s / 132s / >150s before.

## 32.1 How it was diagnosed

Four measurements, each one ruling something out, because the symptom pointed at
three different layers and only one of them was guilty.

**1. The SQL is not at fault.** A diagnostic was added to ask the server the
room question directly, bypassing the cache. At the same instant the client's
roster was empty, the server answered correctly for that same client:

```
B room diagnostic: rooms={"lirik":{"members":0,"ageMs":5749,"inFlight":false,"invalidations":0}}
B asks the server directly: [{ user_id: <A>, hops: 1, via_user_id: <A> }]
```

**2. It is not slow convergence, and not the cache doing its job.** Polling both
answers together for 45s, without touching the other actor:

```
t+0s   cache: members=0 ageMs=5844  inv=0  |  server says: 1
t+25s  cache: members=0 ageMs=31232 inv=0  |  server says: 1
t+30s  cache: (room dropped)               |  server says: 1
t+35s  cache: members=1 ageMs=3445  inv=0  |  server says: 1
```

The server said "1" the whole time. `invalidations` never left **0** — so
`room.invalidate()` was never called. The room only recovered when `want()`
happened to drop and recreate the channel, which is also why the timing was so
erratic across runs.

**3. The co-presence key was never updated.** Reporting it beside the value it
would have if recomputed:

```
here=lirik  key=''  keyNow='e9ee4788-…'
```

`coPresence` — the remembered key whose CHANGE triggers the invalidation — was
empty while the correct value was sitting right there.

**4. The trigger never ran.** Counting entries into `indexPresence`:

```
{"calls":2,"completed":0,"sameObject":2,"error":null}
```

Two calls, both returning at the first guard, **zero completions** — while the
presence index demonstrably contained the arriving friend. Something else was
writing it.

## 32.2 Root cause

`presenceIndex` had **four writers**, and the co-presence check that re-asks the
room lived inside only one of them.

| Writer | Path | Re-asked the room? |
| --- | --- | --- |
| `indexPresence` | realtime `postgres_changes` on `presence` | yes |
| `friends.subscribe` | the friends service | **no** |
| `groups.subscribe` | the groups service | **no** |
| `watchPresence` | forgetting people no longer visible | **no** |

The arrival reached the client through the **friends service**, which assigned
`presenceIndex` directly. Every presence-derived surface therefore updated — the
HERE card lit up in ~2.3s, `roomPeers` was correct, messages flowed — while the
room was never told anything had changed. Its cached pre-arrival answer stood
until the 90s interval lapsed and something incidental re-asked.

## 32.3 Why the existing protection did not cover it

`ask()` in `streamRoom.ts` already guards this class of bug, and its comment
describes this exact symptom — *"the person who joined sees the session
immediately, and the person already watching does not until they refresh."*

That guard defends against an invalidation that **races a request already in the
air**. It presumes an invalidation happens at all. Here none did. No downstream
guard could have helped, because the fault was upstream of it: the trigger had
four writers and only one fired it. The protection was correct and complete for
the case it was written for; the case it was written for was not this one.

## 32.4 The fix

**`src/background/index.ts`** — one function is now the only way `presenceIndex`
can change, and it carries the consequence:

```ts
function setPresenceIndex(next: PresenceIndex): boolean {
  if (next === presenceIndex) return false
  presenceIndex = next

  const key = coPresenceKey(sessionChannel())
  if (key !== coPresence) {
    coPresence = key
    room.invalidate()
  }
  room.want(sessionChannels())
  return true
}
```

All four writers go through it. Making the assignment and its consequence the
same statement is the point: a fifth writer cannot reintroduce this by
forgetting a call, because there is no separate call to forget.

Nothing else changed. The 90s cache is untouched, no polling was added, no
sleeps, no extra membership queries on a quiet channel — the re-ask is still
keyed on WHO is here, so it is one query per real arrival or departure rather
than one per heartbeat per friend.

**`src/background/streamRoom.ts`** — a latent race in `ask()`, found while
reading the same path. The retry was launched from inside the `try`, so the
outer call's `finally` ran afterwards and cleared the `inFlight` flag the retry
had just set. `want()` could then start a second concurrent request for the same
channel, and whichever answer landed last won — including the older, pre-arrival
one, which would stamp itself fresh and be cached for the full interval. The
retry is now launched after the `finally`.

`inspect()` was also added to `StreamRoom`: members beside the age of the answer
that produced them, plus the in-flight and invalidation counters. It is what
turned this from "the room is slow" into a one-line diagnosis, and it is what
measurement 2 above is reading.

**Diagnostics.** `kickbackRoom.now()` and `kickbackRoom.check(channel)` sit
inside the existing `if (METADATA_DIAGNOSTICS)` block — development and beta
only, absent from a production build (`grep -c kickbackRoom dist/…` is 0). They
follow the `kickbackMetadata.check` idiom already in that file, for the reason
that file already gives: the alternative is inferring backend health from
whether a React card looks right.

## 32.5 Deterministic regression coverage

`tests/extension/roomInvalidation.test.ts`, 6 tests. **5 of the 6 fail against
the pre-fix source**, verified by stashing the fix and re-running.

The structural tests are the ones that would actually have caught WS-F5-01,
because the wiring is what broke:

- `presenceIndex` is assigned in **exactly one place** — four before the fix.
- that place is `setPresenceIndex`, and it calls `room.invalidate()` and
  `room.want(...)`.
- `friends.subscribe`, `groups.subscribe` and `watchPresence` each adopt presence
  through it and none assigns the field directly.

The behavioural tests cover the service:

- an invalidation converges **well inside** the refresh interval — asserted on
  the clock, so a "fix" that merely shortened the cache cannot pass.
- a retry keeps its in-flight flag, so no duplicate request can be started and
  no older answer can win. This is the `ask()` race above.
- `inspect()` reports members beside the age of the answer.

Four existing source-shape guards in `destinationPublishing`, `roomResolution`,
`sessionStability` and `socialViewing` asserted the literal text of
`indexPresence`. They were updated to pin the same invariants in their new home
rather than relaxed — `sessionStability`'s is now strictly stronger, checking
every presence path instead of the realtime one only.

## 32.6 Two-actor E2E — the workaround is gone

The temporary acceptance is removed. The scenario no longer asserts a peer count
while reporting stale membership; it asserts the **rendered roster on both
sides**, with a convergence window of **45s — deliberately below the 90s cache**,
so neither a regression nor a cache-shortening "fix" can pass.

```
ok  B sees A arrive: its own card for the channel turns HERE  (after 2.8s)
ok  A can send into the room
ok  B received A's message           ([Watchside E2E] mtex0edb A→B)
ok  and it is attributed to A, not to B
ok  B can send into the room
ok  A received B's message           ([Watchside E2E] mtex0edb B→A)
ok  and it is attributed to B
ok  A's own message is attributed to A
ok  the arriving actor's room lists the other by name            (after 0.0s)
ok  the already-watching actor's room lists the arriver (WS-F5-01) (after 0.1s)
ok  and it converged on the arrival, not on the 90s cache expiring  (0.1s)
ok  B's room counts one peer - the actor who joined
ok  and the server's membership answer agrees with it
ok  A's friend list is unchanged by the run
ok  the room contains only the two actors - no unrelated user was pulled in
ok  neither worker errored during the exchange
```

### Convergence timing

| | before | after |
| --- | --- | --- |
| arriving actor's roster | 0.0s | 0.0s |
| **already-watching actor's roster** | **122s / 132s / >150s** | **0.1s** |
| HERE card | 2.3s | 2.8s |
| social scenario runtime | 150–180s | **21.4s** |
| full 5-scenario suite | 290s | **128s** |

The suite is faster because it is no longer waiting out a cache.

## 32.7 Messaging

Unaffected and still proven both ways, with attribution checked from both
screens: the same message reads *not self, from AnoterosTV* on B and *self, from
You* on A. Message retention was not touched; neither was the 30-minute window,
room retention, or Presence/Gravity semantics.

## 32.8 Seed safety

| | |
| --- | --- |
| `seed-a` before / after | `490abc069b69176b` / `490abc069b69176b` |
| `seed-b` before / after | `230347d30f6355fa` / `230347d30f6355fa` |

Unchanged across the full suite. Seeds are copied, never opened; `createProfile()`
still refuses any path outside `dist-firefox/e2e`.

## 32.9 Chrome and shared-code implications

**This is shared code.** `background/index.ts` and `background/streamRoom.ts` are
not Firefox-specific, so **Chrome had the identical defect** and this fix cures
it there too. It was only ever found on Firefox because that is where the
two-actor harness runs.

The submitted Chrome artifact was **not rebuilt**:
`releases/Watchside-Store-v0.6.0.zip` is still `150e3c5b9319d3cc…`, unchanged.
The fix is therefore in source and in the Firefox development package, and will
reach Chrome users at the next Store build — which is an owner decision, not
one taken here.

`releases/Watchside-Firefox-v0.6.0.zip` **was** rebuilt to
`ecfd6b683f9ee672…`, necessarily: it is the unsigned development package the
E2E runs against, and it has to carry the fix for the E2E to prove anything. The
submitted beta artifact `Watchside-Firefox-Beta-v0.6.0.zip` was not touched.

No hosted schema change was needed or made. The SQL was proven correct in
measurement 1 and not altered. No migration was applied. OAuth scopes untouched.

## 32.10 Full verification

| Check | Result |
| --- | --- |
| `roomInvalidation.test.ts` against the PRE-fix source | **5 of 6 fail** |
| `roomInvalidation.test.ts` against the fix | 6/6 pass |
| `npm test` | **2279 passed / 88 files** |
| `tsc -b --force` | clean |
| `eslint .` | clean |
| `verify:firefox` · `verify:store` | pass |
| `npm run verify:firefox:e2e` | **5/5 scenarios, 128s** |
| Seed fingerprints | unchanged |
| Chrome Store artifact | `150e3c5b…` unchanged |

## 32.11 F5 final verdict

**F5 is complete.** The two-actor Firefox E2E infrastructure and the social
acceptance chain were accepted at `128aba0`. The one defect that work found,
WS-F5-01, is now root-caused, fixed in the shared implementation, covered by
deterministic tests that fail without the fix, and proven end to end on two real
accounts in two real browsers.

The E2E assertion that reported the defect is now a hard assertion with a
window below the cache it used to wait for. There is no outstanding workaround
and no known outstanding defect from F5.

F6, F7 and M3 remain unstarted.
