# Kickback Test Lab

A development-only surface for simulating multi-user social state, so that
testing three, five or ten friends does not mean owning three, five or ten
Twitch accounts.

```
npm run dev:lab      # starts the lab and opens it at http://localhost:5199
```

Left: the world. Right: the **real** Kickback panel, rendered from that world
by production code.

---

## The rule the lab is built around

> The Test Lab does not duplicate production logic.

It injects simulated input at the narrowest boundary it can, and then gets out
of the way:

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

### Why the presence row

`toPresence` in `src/background/supabaseBackend.ts` maps a row of the
`presence` table into the domain model. That row is the last point at which
"who is online, who is stale, whose channel is visible" is *data* rather than a
*decision*.

A simulator that produced `Friend[]` would have to make those decisions — and
they are exactly the decisions worth testing, so it would be grading its own
homework. A simulator that produced rows cannot: it does not know what stale
means, does not know what a cluster is, and has no opinion about ranking.

### The one piece of server behaviour the lab models

Privacy is applied at **write time** by `report_presence`
(`supabase/migrations/0003_rpcs.sql`), so every client sees rows that are
already redacted. There is no TypeScript copy of that rule to reuse — it is
SQL — so `presenceRow()` in `src/testlab/world.ts` mirrors it, in six lines,
directly beneath a quotation of the SQL it mirrors.

| Setting | Row | Reads as |
|---|---|---|
| `visible` | `online`, platform + channel | watching that channel |
| `hide_activity` | `online`, platform and channel **null** | around on Twitch |
| `invisible` | `offline`, platform and channel **null** | offline |

This is the **only** production behaviour reimplemented anywhere in the lab. If
you change the SQL, change this, and `tests/testlab/world.test.ts` will tell
you what you broke.

---

## Controls

### Observer

The person whose panel you are looking at. Their channel is written into the
**address bar** (`/lirik`), because `useKickbackState` reads the local user's
channel from `getCurrentChannel()`, which parses `window.location.pathname`.
That is how HERE, "watching with you" and the JOIN-to-where-you-already-are
guard get exercised for real rather than being told the answer.

### Simulated users

Up to ten. Each has:

| Field | Values |
|---|---|
| Relationship | friend · asked you · you asked · stranger |
| Activity | watching · around · offline |
| Channel | any text; `LIRIK`, `xQc`, `LVNDMARK`, `summit1g`, `shroud` offered |
| Visibility | visible · hide activity · invisible |
| `silent` | stops their heartbeat, so they can age out |

Only **friends** produce presence, which is correct: the observer is not
entitled to anyone else's.

Channels may be typed in any casing. The row stores the canonical lowercase —
the same thing `parseChannelFromPath` does — and the casing is offered to the
channel-name map instead, so `LVNDMARK` and `lvndmark` are one cluster drawn in
Twitch's spelling.

### Time

`+45s` `+90s` `+5m` `+30m`. Two things move, because two mechanisms measure
time:

- **Silent clients fall further behind.** People are described by *ages*, so a
  client that stopped beating crosses the real 90-second staleness window
  against the real clock. Clients still beating do not go stale, because in the
  real world they would not.
- **The analytics clock advances.** The hub, the exposure tracker and the
  gathering watcher all already accept an injected `now`, so exposure windows,
  gathering cooldowns and opportunity-key boundaries are crossed without
  patching `Date` anywhere.

There is deliberately no fake-clock framework. Presence needed ageing, not a
fake clock; analytics already had an injection point.

### Metadata

Per-destination controls for what Twitch would say: **live / offline /
unavailable**, the avatar (present, missing, broken) and the category.

Fed at exactly the boundary production reads it from —
`KickbackState.channelMetadata` — so the panel cannot tell a simulated record
from a fetched one. The lab holds **no token, no Helix parsing, no cache and no
batching**: those belong to the service, and a copy of them here would prove
nothing about the original.

`unavailable` is modelled as **absence**, not as a state, because that is what
it is. A metadata outage, a cold cache and a channel nobody has asked about all
reach the panel as "no record", and all three must draw the plain card. A lab
that distinguished them would be inventing a state production cannot produce —
which is why "Metadata loading" and "Metadata error" are one preset here, and
why a test asserts its output is byte-identical to no metadata at all.

The stand-in avatar is an inline `data:` URI rather than a Twitch CDN URL: the
lab has no network, so a real URL would simply fail to load and leave the
avatar slot untested. A `data:` URI is not a request, so the seal is untouched.
The real host check lives in `core/twitchMetadata.ts` and is tested there
against actual URLs.

### Together

Per-friend reaction buttons for whoever is on the observer's channel, plus
"Combo 😂 (all)" and "Burst 🔥 (one person ×5)" - the two cases that must look
different, because a combo is several people agreeing and not one person
pressing a button repeatedly.

Fed at , the same field production reads.
The lab holds **no subscription, no row policy, no rate limit and no sweep**:
those belong to the service, and a copy of them here would prove nothing about
the original. A test asserts no lab source mentions any of them.

Reactions persist across a preset change because the *channel* did not change -
which mirrors production, where the buffer clears only when the viewer moves.

### Presets

Empty · 1 friend watching · 2/3/5-friend Gravity · 10-friend stress · Two
competing clusters · Watching with you · Privacy mix · Around + offline mix ·
Cluster split/reform · Casing mix · Stale heartbeat · Requests + strangers.

Metadata: Live creator · Offline creator · Metadata unavailable · Long title +
category · Missing avatar · Mixed live/offline · Authoritative casing · HERE
with the stream ended.

A preset configures **people**, never an expected outcome. They are pure
functions, so a bug is reproducible by name.

### Events

Analytics captured at the **send boundary** — precisely what would have gone to
Supabase, contract and all, including the `opportunity_key` production minted.
`clear` empties the log without disturbing the analytics state behind it;
`copy JSON` puts the log on the clipboard.

JOIN clicks appear above it as `JOIN → twitch.tv/lirik`.

---

## Safety

Three independent guarantees. Each is tested in
`tests/testlab/isolation.test.ts`.

1. **The lab cannot ship.** It is a separate Vite app (`vite.testlab.config.ts`,
   root `src/testlab`). The extension is built from `src/content/index.tsx` and
   `src/background/index.ts`, and nothing outside `src/testlab` imports
   anything inside it — so no lab code reaches `dist/` at all: not behind a
   flag, not in a dead branch, not as a string. A test asserts both the import
   rule and the built bundles.
2. **Nothing hosted is reachable.** The lab constructs no Supabase client, so
   there is no session, no URL and no key. `toPresence` is imported, but it is
   a pure row mapper. A test asserts no lab source mentions `createClient`,
   `.rpc(` or `VITE_SUPABASE`.
3. **The page has no network.** `sealNetwork()` replaces `fetch`,
   `XMLHttpRequest`, `WebSocket` and `sendBeacon` with versions that **throw
   loudly** for any host except the dev server that served the page. If a
   future edit reintroduces a hosted write, it fails at the moment it is
   attempted with a stack trace naming the caller — rather than succeeding.

Plus: `assertTestLabBuild()` refuses to initialise in any build that is not
`VITE_KICKBACK_MODE=test_lab`, and that mode is set by the lab's Vite config
rather than by an `.env` file, so it cannot be turned on elsewhere.

**Panel actions are local.** Removing a friend or accepting a request edits the
simulated world. Group writes throw rather than pretending to work.

### The one production seam

`setJoinNavigator()` in `src/platforms/twitch/join.ts` replaces the final
statement of `joinChannel` — the browser navigation — and nothing else. The
decision above it, including "a JOIN to where you already are goes nowhere", is
the shipped one.

The alternative was a second `joinChannel` for the lab, which would mean the
JOIN under test was not the JOIN that ships. The setter's body is behind a
build-time constant, so any other build folds it to an immediate return, and
the symbol does not survive into `dist/kickback-content.js` at all.

---

## Running the checks

```
npm run test:lab      # the lab's own vitest suites (fast, no browser)
npm run verify:lab    # boots the real page in Chrome and drives it
```

`verify:lab` is the one that catches "every unit test is green and the page is
blank": it starts the dev server, opens the page, clicks the preset buttons and
reads what the panel actually drew.

---

## What the Test Lab does **not** test

It is a social-state simulator, not a Twitch emulator. These still need a real
browser, a real extension and a real account:

| Still requires the real thing | Why |
|---|---|
| Twitch navigation detection | Needs Twitch's SPA and its `<title>` timing |
| Content-script injection, shadow DOM, panel anchoring | Needs Twitch's page and CSS |
| Channel-name learning from page titles | The lab supplies casing directly |
| Supabase auth (Twitch PKCE) | Needs a real OAuth round trip |
| Supabase realtime presence propagation | The lab has one process and no server |
| RLS and server-side privacy enforcement | The lab models the write-time rule; it cannot test who may read a row |
| Rate limits, `SECURITY DEFINER` RPCs | Server behaviour |
| Real JOIN navigation | The lab stops at the boundary on purpose |
| OS notification permission and delivery | The lab logs at the display boundary |
| MV3 worker lifecycle, eviction, alarms | There is no service worker in the lab |
| Browser close / crash behaviour | Same |
| Emote fetching from 7TV | No network |
| The metadata service itself — token, Helix, cache, batching | The lab supplies records; it does not fetch them |
| Groups and group chat | Not simulated yet |
| The reaction transport - realtime delivery, RLS, rate limits, sweep | The lab supplies reactions; it does not deliver them |

Everything else — clustering, ranking, HERE, privacy combinations, large
clusters, split and re-form, casing, staleness, UserCards, opportunity
derivation, local analytics — is now reachable without a second account.

---

## Adding to the simulator

The world is one flat type. To add a field:

1. Add it to `SimUser` (or `SimObserver`) in `src/testlab/world.ts`.
2. If it belongs in presence, put it in `presenceRow()` — and only if the
   database would really hold it. If production derives it, do **not** derive
   it here.
3. Add a control in `src/testlab/TestLab.tsx`.
4. Add a preset if it has an interesting combination.

Future checkpoints will want Stream Room membership, chat participation,
reactions, creator identity, Twitch metadata and eventually non-Twitch
destinations. None of those need the lab restructured: membership and
participation are extra fields on `SimUser`, and destinations already travel as
`{ platform, channel }` through `Activity` rather than as a bare string.

Do not redesign production around a platform that does not exist yet. Add the
field when the feature arrives.
