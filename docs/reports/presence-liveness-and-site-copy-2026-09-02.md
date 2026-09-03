# Presence vs stream liveness, and one sentence of site copy

**Date:** 2026-09-02
**Base:** `ce48e4e` (pushed)
**Head:** `54e41b1`
**Scope:** two narrow items. No schema change, no migration, no permission or
scope change, no JOIN change, nothing published or submitted.

---

## 1. Root cause of the Julie presence bug

**She was never classified as offline. She was *positioned* as offline.**

Every classifier was already correct, and I checked each rather than assuming:

- `effectiveStatus` reads the friend's own `status` and staleness. It has never
  consulted channel metadata.
- `bucketOf` in the Friends tab keys off `effectiveStatus` and `isWatching`.
- `describePresence`, `useKickbackState` (`friendsHere`, `onlineCount`,
  `sortForDisplay`) — no metadata reference at all.
- `clusterMembers` put her in a `channel` cluster, which `gravityModel` maps to
  `kind: 'destination'`.

The defect is one expression in `src/core/socialGravity.ts`:

```js
const ordered = [
  ...sections.filter((s) => s.kind !== 'destination' || s.live !== 'offline'),
  ...sections.filter((s) => s.kind === 'destination' && s.live === 'offline'),
]
```

`clusterMembers` emits sections in kind order — `here`, channels, `browsing`,
`offline`. This partition moves an ended destination to the **end of the whole
list**, which is past `around` and past `offline`. So a friend who was online,
with Twitch left open on a channel that had stopped streaming, rendered as the
last thing on screen, underneath the heading for people who are gone.

Position is what a reader sees. That makes it a presence bug even though
presence was computed correctly everywhere.

**What makes this more than a slip:** the function's own doc comment already
drew the correct line — metadata *"may move a destination Twitch says has
STOPPED STREAMING **below the ones that have not**"*. Below the ones that have
not; not below everything. The code reached further than the sentence licensed,
and the comment had been sitting directly above it saying so.

---

## 2. Behaviour before and after

Given: Julie online on `originangel` (offline stream), plus a friend who is
genuinely offline.

| | before | after |
|---|---|---|
| Julie's `kind` | `destination` | `destination` (unchanged) |
| Julie's `effectiveStatus` | `online` | `online` (unchanged) |
| **section order** | `offline`, then Julie | **Julie, then `offline`** |
| Julie's card opacity | `0.72` on the whole card, avatar and name included | stream context dimmed; the people row at full strength |
| channel shown | `originangel`, marked OFFLINE | unchanged |
| JOIN offered | yes | yes — deliberately unchanged |
| ended stream vs live stream | ended sinks below live | unchanged |
| `unknown` metadata | moves nothing | unchanged |

Measured across all three metadata states, the order is now
`['destination', 'around', 'offline']` whatever Twitch says about the channel.

---

## 3. Affected surfaces

**Changed — two, and the second is the same conflation in visual form:**

1. `src/core/socialGravity.ts` — the ordering. Now a stable sort keyed on
   section kind first, so an ended stream sinks below live destinations and no
   further. Stability preserves everything else: friend count still decides,
   the alphabetical tie-break still holds, `here`/`around`/`offline` do not
   move.
2. `.kb-gravity-card-offline` in `src/ui/kickback.css` — put `opacity: 0.72` on
   the **whole card**, so an online friend's avatar and name were faded because
   the *channel* had ended. Found by auditing outward from the ordering bug.
   Scoped to `> *:not(.kb-gravity-people)`: the stream context dims, the people
   do not.

**Audited and already correct — no change needed:**

| surface | why it is fine |
|---|---|
| `effectiveStatus`, `isHere`, `isSameActivity` | presence only; no metadata parameter exists |
| `bucketOf` / Friends tab sections | keys off `effectiveStatus`; Julie was correctly under "Watching elsewhere" here all along |
| `describePresence` | no metadata reference |
| `useKickbackState` | `friendsHere`, `onlineCount`, `sortForDisplay` all presence-only |
| `isLiveSharedWatch` / `canWatchLiveTogether` | analytics only — its own comment records that nothing visible hangs off it |
| `watchTogetherState` | returns liveness for a *label about the stream*, which is correct |
| `StreamSession` LIVE badge | describes the channel, not the people |
| launcher presence dot | already fixed in the previous pass; untouched here |

---

## 4. Regression tests added

`tests/extension/presenceVsLiveState.test.ts` — 10 tests. The three required
cases and the invariants around them:

1. **online + stream LIVE** — destination, above the offline section.
2. **online + stream OFFLINE** — still `online`, still a `destination`, **renders
   above the offline section**, keeps its channel and `live: 'offline'`, and
   still offers JOIN.
3. **genuinely offline** — in the `offline` section for every metadata state
   (`live`, `offline`, `unknown`).

Plus: ended destinations still sink below live ones; a destination is never
moved below `around` or `offline` whatever metadata says; and the card CSS does
not dim the people row.

**These assert ORDER, not only classification, and that distinction is the
point.** Verified by reverting the fix and re-running: exactly the two
order-asserting tests fail, and every classification test passes. A test that
checked `kind === 'destination'` would have passed for the entire period the bug
existed — which is why one did not catch it.

---

## 5. Website copy

Replaced verbatim in `docs/web/watchside-app/pages/index.html`, the source of
truth for both public surfaces:

> Watchside puts a small panel beside Twitch showing which streams your friends
> are on. **When you see friends watching together, press JOIN and jump in with
> them.**

Confirmed as an exact character-for-character match on all four surfaces —
source, `dist-site`, `dist-pages`, and the checked-in published snapshot — and
the old wording appears nowhere in the site sources.

`docs/web/pages-watchside/` is a checked-in copy of the exact bytes served under
`anoteros-labs.github.io/watchside/`. Its README says to regenerate rather than
hand-edit, and `pagesArtifact.test.ts` asserts it still matches the build, so it
was rebuilt from `build-site.mjs` rather than edited. That test passes.

**Rendering verified with Chrome device emulation** at 1440, 1024, 768, 430, 390
and 320px: the sentence renders in full at every width, nothing clips, and the
page never scrolls horizontally. The only diff in either file is the sentence.

**The site is not published.** watchside.app is served from a separate
repository, publishing was not authorized here, and the live site still shows the
old sentence.

---

## 6. Gate results

| gate | result |
|---|---|
| `npm test` | **3,304 passing, 139 files, 0 failing** (3,294 → 3,304: the 10 new tests) |
| `npm run typecheck` | clean |
| `npm run lint` | clean |
| `tests/db/authorizationSurface` | **10/10** |
| `tests/extension/authzHarness` | **28/28** |
| `npm run test:authz` | **18/18, exit 0**, from a baseline verified green (3,304 tests, schema `344c21dc1589`) |
| `npm run test:destruction` | **all 109 detected, exit 0** |
| `npm run build` | ok |
| `npm run verify:store` | pass |
| `npm run verify:candidate` | pass |
| `pagesArtifact` | 8/8 |

---

## 7. Commits

**`Kickback` (the extension repository — the website source lives here too):**

```
51b99a6  fix(v0.9): an online friend on an ended stream is still online
54e41b1  copy(site): the hero lede says what a person actually sees
```

Two commits, kept separate because they are unrelated changes. There is no
second repository to commit to: `docs/web/watchside-app/` is the source of truth
for watchside.app, and the published Pages repository is generated from it.
Nothing was copied into the extension repository that did not already live here.

Also pushed at the start of this pass, as approved: the 11 commits
`a5cf0fd..ce48e4e`.

---

## 8. Fresh v0.9.0 RC artifacts

**Required** — extension runtime source changed (`socialGravity.ts`,
`kickback.css`). The `ce48e4e` artifacts are superseded.

| artifact | bytes | SHA-256 |
|---|---:|---|
| `Watchside-Store-v0.9.0.zip` | 187,661 | `a6dd55b5ae6de466f82e970f05acc052d073850ab9e5bf7a1303566c694945be` |
| `Watchside-Private-Beta-v0.9.0.zip` | 189,511 | `04b4c73d7be99dd9d011799a82b4a523d2e2cf1ac0348fed0eb69e2398abc40b` |
| `Watchside-AMO-Candidate-v0.9.0.zip` | 187,672 | `b05ad845c90d2b1a46efa266c08752a4c2472cbd03eac0c338919a8f94642147` |
| `Watchside-AMO-Source-v0.9.0.zip` | 1,280,016 | `778cdaf354d5012cbea4a94f24433f55fc86cef082d1f299f045f572bb57d026` |

Superseded: `05a59740…`, `7cf89694…`, `407bb52c…`, `717a5be6…`.

The AMO candidate is the deterministic one, and it **did** change this time
(`407bb52c` → `b05ad845`). That is the expected result and a small confirmation
of the previous report's claim: it holds steady when only tests move, and moves
when shipped code does.

---

## 9. Schema

**43.** Unchanged. No migration added, `git status supabase/` empty, and the
schema fingerprint is still
`344c21dc1589476a8a627ee5a99051ec587d4ae784090647f7e0cbb45d8e5e24` — identical
to the digest recorded before the harness repair. Production authorization is
untouched.

---

## 10. v0.8 artifacts

Untouched, verified with `sha256sum -c` against hashes taken before any build in
this session:

```
Watchside-AMO-Candidate-v0.8.0.zip: OK
Watchside-AMO-Source-v0.8.0.zip:    OK
Watchside-Firefox-v0.8.0.zip:       OK
Watchside-Store-v0.8.0.zip:         OK
```

---

## 11. Unexpected findings

**The card dimming was a second instance of the same bug.** Only the ordering
was reported. Auditing outward found `opacity` applied to the whole offline card
— the stream's state painted onto the people standing in it. Same conflation,
different layer, and it would have kept half the visual symptom after the
ordering fix. Fixed, and covered.

**The comment was right and the code was wrong, and they sat adjacent.** The
sentence describing the intended behaviour was directly above the expression
that violated it. Worth recording because it is the second time this pass that a
correct comment failed to prevent an incorrect implementation — the wordmark's
`.kb-ghost-link` was the first. Prose next to code is not a check on that code.

**A measurement artifact I nearly reported as a defect.** Testing the site at
mobile widths inside a sized `<iframe>` showed horizontal overflow at every
width (`scrollWidth` 1495, constant). It was the technique, not the page: an
iframe does not honour the viewport meta. Re-measured with proper CDP device
emulation, the page has no horizontal scroll at any width from 320 to 1440. The
iframe result was wrong and is recorded here rather than quietly dropped.

**A `/watchside/` argument was rewritten to a Windows path.** Invoking
`build-site.mjs` directly from Git Bash produced a page whose every internal link
read `C:/Program Files/Git/watchside/…` — MSYS path conversion mangling the base
argument. It affected only a scratch build directory; `npm run build:site:pages`
goes through cmd and is unaffected, and the checked-in artifact was regenerated
from a clean build and byte-compared. No repository content was damaged. Worth
knowing before anyone runs that script from a bash prompt.

---

**Stopped for owner review.** Nothing was published, nothing submitted, the
Twitch metadata edge function was not deployed, and G7 was not touched. The two
commits are local and unpushed.
