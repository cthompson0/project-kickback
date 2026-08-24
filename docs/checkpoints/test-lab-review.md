# Kickback Test Lab — Checkpoint Review

Developer infrastructure for simulating multi-user social state against the
real production selectors, state machines and UI.

Commit `2924de3` — `dev: add multi-user test lab`. Pushed to `main`.

---

## 1. The injection seam, and why

**The presence row.**

`toPresence()` in `src/background/supabaseBackend.ts` maps a row of the
`presence` table into the domain model. The lab constructs rows; everything
after is production:

```
simulated people
      ↓
PRESENCE ROW            ← the only thing the lab constructs
      ↓
toPresence              ← production
mergePresence           ← production
stampFriends            ← production
clusterMembers          ← production
socialGravity           ← production
<SocialGravity>         ← production
KickbackPanel           ← production
```

Three candidate seams were considered:

| Seam | Rejected because |
|---|---|
| `Friend[]` into the UI | The simulator would have to decide who is online, who is stale and whose channel is visible — the exact decisions worth testing. It would grade its own homework. |
| Inside the service worker | Would need `chrome.storage`, `chrome.alarms` and port shims. `chrome.*` turns out to be concentrated in `background/index.ts`; every interesting module is already `createX(deps)`, so the shims would buy nothing. |
| **The presence row** | The last point at which the answer is *data* rather than a *judgement*. The simulator does not know what stale means, what a cluster is, or how to rank one. |

That the background modules are chrome-free and dependency-injected is what
made this cheap: `createAnalyticsHub`, `createGatheringWatcher`,
`createNotifier`, `createAttentionService` and `createMemoryStorageArea` are
all used unmodified.

### The one piece of production behaviour reimplemented

Privacy is applied at **write time** by `report_presence`
(`supabase/migrations/0003_rpcs.sql`), so clients only ever see redacted rows.
There is no TypeScript copy to reuse — it is SQL — so `presenceRow()` mirrors
it in six lines, directly beneath a quotation of the SQL:

| Setting | Row | Reads as |
|---|---|---|
| `visible` | `online`, platform + channel | watching that channel |
| `hide_activity` | `online`, platform/channel **null** | around on Twitch |
| `invisible` | `offline`, platform/channel **null** | offline |

`tests/testlab/world.test.ts` pins all three, including that an invisible row is
byte-identical to a genuinely offline one — because a distinguishable hidden row
*is* the leak.

### Substituted edges — exactly three

1. **Analytics backend** — captured, not sent. The real hub, session,
   attribution, lifecycle, exposure tracker, dedupe and contract all run.
2. **Notification backend** — logged, not shown. Real `createNotifier` and real
   `createGatheringWatcher` rules.
3. **Storage** — `createMemoryStorageArea()`, production's own test double.

### The one production seam added

`setJoinNavigator()` in `src/platforms/twitch/join.ts` replaces the final
statement of `joinChannel` — the browser navigation — and nothing above it. The
guard ("a JOIN to where you already are goes nowhere") is the shipped one.

The alternative was a second `joinChannel` for the lab, which would mean the
JOIN under test was not the JOIN that ships. The setter's body sits behind a
build-time constant, and the symbol does not survive into
`dist/kickback-content.js` at all — asserted in `isolation.test.ts`.

Total production change: that seam, plus widening the `VITE_KICKBACK_MODE`
union type to include `test_lab`. **No production behaviour changed.**

---

## 2. Running it

```
npm run dev:lab      # opens http://localhost:5199
npm run test:lab     # the lab's vitest suites (fast, no browser)
npm run verify:lab   # boots the real page in Chrome and drives it
```

Left: simulation controls. Right: the real `KickbackPanel`, mounted in the same
full-viewport `.kb-root` layer the content script uses, so its own placement,
drag and resize behave as they do on Twitch.

### Observer

The observer's channel is written into the **address bar** (`/lirik`), because
`useKickbackState` reads the local user's channel from `getCurrentChannel()`,
which parses `window.location.pathname`. HERE, "watching with you" and the
JOIN-to-where-you-already-are guard are therefore exercised for real rather than
being told the answer.

**Multi-observer was not built.** The world holds one observer with configurable
friends, as the brief's minimum allows. Making it cheap would mean modelling a
friendship *graph* plus per-observer RLS visibility — a materially bigger
simulator that would then be modelling a second piece of server behaviour (who
may read whose row). The current design does not preclude it: `SimUser` already
carries a per-person relationship, so a future `relationships: Record<observerId,
...>` is an additive change.

### Simulated users — up to 10

Relationship (friend / asked you / you asked / stranger) · activity (watching /
around / offline) · channel (free text, five offered) · visibility (visible /
hide activity / invisible) · `silent` to stop their heartbeat.

Only friends produce presence — the observer is not entitled to anyone else's.

Channels may be typed in any casing. The row stores canonical lowercase (as
`parseChannelFromPath` does); the casing is offered to the channel-name map,
first-offer-wins, so a world spelling one channel two ways resolves it one way
on every rebuild.

### Time

`+45s` `+90s` `+5m` `+30m`. Two mechanisms, because two things measure time:

- **Presence ages.** People are described by *ages*, not timestamps, so a silent
  client crosses the real 90-second staleness window against the real clock.
  Clients still beating do not go stale — in the real world they would not.
- **The analytics clock advances.** The hub, exposure tracker and gathering
  watcher already accept an injected `now`, so exposure windows, gathering
  cooldowns and opportunity-key boundaries are crossed without patching `Date`.

No fake-clock framework was built. Presence needed ageing; analytics already had
an injection point. This is the "deterministic timestamp editing / state ageing"
option the brief allowed, and for presence it is strictly better than a fake
clock.

### Presets — 13

Empty · 1 friend watching · 2/3/5-friend Gravity · 10-friend stress · Two
competing clusters · Watching with you · Privacy mix · Around + offline mix ·
Cluster split/reform · Casing mix · Stale heartbeat · Requests + strangers.

Pure functions of nothing, so a bug is reproducible by name. A preset configures
**people**, never an expected outcome — tested.

### Events inspector

Captured at the analytics **send boundary**: exactly what would have gone to
Supabase, contract and all, including the `opportunity_key` production minted.
`clear` empties the log without disturbing the analytics state behind it; `copy
JSON` puts it on the clipboard. JOIN clicks appear above as `JOIN →
twitch.tv/lirik`.

---

## 3. Gravity acceptance

Run twice: in vitest against the production `SocialGravity` component, and in a
real browser through the actual page.

| Friends on one destination | Cards | Count | Flame | JOIN | Distinct people |
|---|---|---|---|---|---|
| 1 | 1 | 1 | no | 1 | 1 |
| 2 | 1 | 2 | yes | 1 | 2 |
| 3 | 1 | 3 | yes | 1 | 3 |
| 5 | 1 | 5 | yes | 1 | 5 |
| 10 | 1 | 10 | yes | 1 | 10 |

No duplicate friend at any size; the flame appears at exactly two and does not
compound; one JOIN however many people are there.

Also verified:

| Scenario | Result |
|---|---|
| Two competing clusters | LIRIK 3 above xQc 2 |
| Move one person live | Re-ranks to xQc 3 above LIRIK 2, no reload |
| Split | 2 → 1 + 1, two cards |
| Re-form | back to one card of 2 |
| HERE | `kb-gravity-card-here`, no JOIN, "3 friends watching with you", viewer uncounted |
| HERE across casing | observer on `LIRIK`, rows on `lirik` → one channel |
| Leave the channel | HERE reverts to a joinable destination |
| Privacy mix | 1 destination of 1; hider → Around; invisible → Offline; hidden channel absent from markup entirely |
| Casing mix | `LVNDMARK` + `lvndmark` → one cluster of 2, drawn `LVNDMARK` |
| Stale | silent friend drops from the destination, appears Offline |
| Narrow panel | all 10 present and wrappable, not clipped |

`verify:lab` additionally confirms the panel **mounts**, the page throws nothing
on load or while being driven, JOIN reaches the navigation boundary without
navigating the developer away, and `join_clicked` + `gravity_cluster_impression`
are captured.

---

## 4. Safety

Three independent guarantees, each separately tested.

| # | Guarantee | How it is enforced | Test |
|---|---|---|---|
| 1 | The lab cannot ship | Separate Vite app (`vite.testlab.config.ts`, root `src/testlab`). Nothing outside `src/testlab` imports anything inside it, so no lab code reaches `dist/` — not behind a flag, not in a dead branch, not as a string | import-rule scan over all of `src/`, plus string scan of the built bundles |
| 2 | Nothing hosted is reachable | The lab constructs no Supabase client — no session, no URL, no key. `toPresence` is imported, but it is a pure row mapper | no lab source may contain `createClient`, `.rpc(`, `VITE_SUPABASE` |
| 3 | The page has no network | `sealNetwork()` replaces `fetch`, `XMLHttpRequest`, `WebSocket`, `sendBeacon` with versions that **throw loudly** for any host but the dev server that served the page | all four asserted against a Supabase-shaped host |

Plus `assertTestLabBuild()` refuses to initialise in any build that is not
`VITE_KICKBACK_MODE=test_lab`, and that mode is set by the lab's Vite config
rather than an `.env` file, so it cannot be switched on elsewhere. Existing
environment validation was extended (a new union member), never weakened.

**Panel actions are local.** Removing a friend or accepting a request edits the
simulated world; group writes throw rather than pretending. `reportActivity` is
inert. No simulated presence, friendship, group or chat can reach Supabase.

**Why the dev server is exempt from (3):** Vite serves the modules and keeps a
hot-reload socket, both to the page's own origin. Blocking them would not make
the lab safer — the dev server is on this machine and holds nothing — it would
only make the lab unusable, and a safety measure that gets switched off to get
work done protects nothing. Matched on host, so every Supabase host is still
refused.

---

## 5. Tests

66 new tests across three files.

**`tests/testlab/world.test.ts` (22)** — the redaction mirror, canonicalisation,
casing determinism, time ageing, preset determinism, distinct ids, the 10-user
cap, and that presets describe people rather than outcomes.

**`tests/testlab/gravity.test.tsx` (26)** — the acceptance table above, driven
through the production component from lab-produced state.

**`tests/testlab/isolation.test.ts` (18)** — the three safety guarantees, the
analytics capture boundary, opportunity-key derivation in the worker, impression
and JOIN agreeing on one opportunity, no `fetch` during a full analytics cycle,
local-only panel actions, and the JOIN navigator being inert outside a lab build
while still refusing a JOIN to the current channel inside one.

No screenshot tests. `verify:lab` reads semantic DOM (counts, classes, text),
which is what actually regresses.

### Notes on two test decisions

- The render tests drive `SocialGravity` rather than the whole `KickbackPanel`,
  because there is no jsdom in this project and the panel's mount path needs a
  DOM. Adding jsdom for this would be a new dependency; `verify:lab` covers the
  full panel in a real browser instead, which is stronger.
- The analytics tests await a short settle before flushing. The hub reads its
  session from storage, which is a promise even in memory, so an event tracked
  on the first tick is queued behind it. Production never notices — it flushes
  on a five-second timer. This is a harness detail, not a defect.

---

## 6. Verification

Checkpoint policy. Nothing near the 5-minute limit.

| Command | Result | Time |
|---|---|---|
| Test Lab + Gravity + presence/privacy + analytics + bundle + panel (20 files, 531 tests) | pass | 39 s |
| `npx tsc -b --force` | pass | 5 s |
| `npm run lint` | pass | 6 s |
| `npm run build` | pass | 5 s |
| `npm run verify:lab` (real Chrome, full drive-through) | pass | 7 s |

No mutation testing. No unrelated emote/combo/group suites.

Two things needed fixing during the run, both found by actually running the lab
rather than by a test:

1. **The page did not boot.** With `root: testlab/`, the dev server could not
   resolve `../src/testlab/main.tsx` — it built fine and served a blank page.
   Fixed by moving the entry HTML to `src/testlab/index.html` and setting root
   there. This is exactly the failure `verify:lab` exists to catch.
2. **The network seal strangled Vite.** Sealing `WebSocket` unconditionally
   killed hot reload, and comparing *origins* rejected `ws://localhost:5199`
   against `http://localhost:5199`. Fixed by matching on host and exempting the
   serving origin only.

Also corrected: `channelNames` was last-write-wins, contradicting the documented
first-offer precedence; a missing `XMLHttpRequest` (Node has none) silently left
that primitive unguarded rather than refusing.

---

## 7. What still needs a real browser and a real account

The lab is a social-state simulator, not a Twitch emulator.

| Still requires the real thing | Why |
|---|---|
| Twitch navigation detection | Needs Twitch's SPA and its `<title>` timing |
| Content-script injection, shadow DOM, panel anchoring | Needs Twitch's page and CSS |
| Channel-name learning from page titles | The lab supplies casing directly |
| Supabase auth (Twitch PKCE) | Needs a real OAuth round trip |
| Supabase realtime presence propagation | One process, no server |
| RLS and server-side privacy enforcement | The lab models the write-time rule; it cannot test who may *read* a row |
| Rate limits, `SECURITY DEFINER` RPCs | Server behaviour |
| Real JOIN navigation | The lab stops at the boundary on purpose |
| OS notification permission and delivery | Logged at the display boundary |
| MV3 worker lifecycle, eviction, alarms | No service worker in the lab |
| Browser close / crash behaviour | Same |
| Emote fetching from 7TV | No network |
| Groups and group chat | Not simulated yet — group writes throw |

Everything else — clustering, ranking, HERE, privacy combinations, large
clusters, split/re-form, casing, staleness, UserCards, opportunity derivation,
local analytics — no longer needs a second account.

---

## 8. Extensibility

The world is one flat type. To add a field: extend `SimUser`, put it in
`presenceRow()` **only if the database would really hold it** (if production
derives it, do not derive it here), add a control, add a preset.

Stream Room membership, chat participation, reactions and creator identity are
all extra fields on `SimUser`. Destinations already travel as
`{ platform, channel }` through the existing `Activity` type rather than as a
bare string, so a non-Twitch platform is a new `Platform` member and not a
restructure. Nothing was redesigned around platforms that do not exist yet.

---

## 9. Git

21 files, +3,177 / −6. Production source touched in two places only:
`join.ts` (the navigator seam) and `vite-env.d.ts` (the mode union).

Full staged diff reviewed. No mutation residue — no mutation run happened. Secret
scan (secrets, passwords, service-role, JWTs, private keys, client/access/refresh
tokens, API keys, Supabase hosts) returned only `example.supabase.co` inside the
tests that prove the network seal blocks it. No `.env.local`, no credentials, no
browser profiles, no analytics dumps, no release artifacts. `dist-testlab/` added
to `.gitignore`.

One clean commit, pushed, no force push:

```
2924de3 dev: add multi-user test lab
aecf40d..2924de3  main -> main
```

Working tree clean.

Twitch Metadata and Stream Rooms remain unstarted.
