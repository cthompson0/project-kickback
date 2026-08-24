# Twitch Metadata — Real-Browser Fix

Commit `cd32204` — `fix: restore metadata and gravity polish`. Pushed to `main`.

**One action required from you: apply migration 0018.** Details in §2.

---

## 1. Metadata root cause

### First failed boundary: Edge Function → rate-limit RPC

**This is a code bug I shipped, not hosted configuration.**

The pipeline was traced end to end. Everything up to the Edge Function was
correct — the worker did want `lvndmark`, the scheduler did run, `functions.invoke`
did carry the session JWT — and everything after it was never reached.

`supabase/functions/twitch-metadata/index.ts` called:

```ts
await caller.rpc('consume_rate_budget_n', { p_bucket: 'twitch_metadata', ... })
```

`consume_rate_budget_n` is an **internal helper**. Migration 0013 ends with:

```sql
revoke all on function public.consume_rate_budget_n(text, int, int, interval)
  from public, anon, authenticated;
```

That revoke is deliberate and correct — it stops a client charging an arbitrary
bucket by an arbitrary amount, and the function is only ever meant to be called
from inside another `SECURITY DEFINER` function. Calling it with the caller's
JWT is a guaranteed permission error.

The handler then did:

```ts
if (error) return json({ error: 'unauthorized' }, 401)
```

So **every metadata request in every session returned 401 before Twitch was
contacted**. Get Users, Get Streams, the app token and the cache were never
exercised at all.

### Why it went unnoticed for a whole checkpoint

Two design decisions combined badly:

1. Metadata degrades correctly by design, so a total failure and "no friends
   are watching anything" produce **the same screen**.
2. A rate-limit failure was mapped onto **401**, so "the migration was not
   applied" was indistinguishable from "you are not signed in".

Nothing was logged. There was no way to tell the two apart from outside.

### Everything else checked, and found correct

| Boundary | Status |
|---|---|
| Gravity → `wantMetadata()` | correct — `friendsState.friends` does carry presence (patched by `applyPresence`), and `refreshAttention()` runs on friends, groups and tab-activity changes |
| Worker cache / scheduler | correct — TTL, batching, dedupe all behave |
| `functions.invoke` and the JWT | correct — the worker's client holds the session |
| Deployed function requires JWT | correct — and `invoke` satisfies it |
| Client parser | correct — but never received anything to parse |
| `channelMetadata` in `KickbackState` | correct — but always empty |
| `SocialGravity` receiving it | correct — but always empty |

I could not verify `TWITCH_CLIENT_ID` / `TWITCH_CLIENT_SECRET` from here; they
are only reachable from the deployed function. The new `twitch_credentials_missing`
diagnostic reports it if they are absent.

---

## 2. Fix, and what you must do

### Code (done)

`supabase/migrations/0018_twitch_metadata_budget.sql` adds
`consume_metadata_budget(p_amount int)` — `SECURITY DEFINER`, granted to
`authenticated`, hard-coding the bucket (`twitch_metadata`), the allowance
(600) and the window (5 minutes) so the caller chooses nothing but how many
logins they asked about. The internal helper stays revoked.

It also states the service role's grants on `twitch_metadata_cache` explicitly
rather than relying on inherited defaults — a silent failure there would look
like a cache that never hits.

The handler no longer maps a budget failure onto 401. It degrades to cache and
reports `budget_unavailable`.

### ACTION REQUIRED: apply migration 0018

```bash
npm run db:bundle
```

→ **Supabase → SQL Editor → New query** → paste
`supabase/.generated/apply_all.sql` → Run. Idempotent; no CLI, no database
password.

### ACTION REQUIRED: redeploy the function

```bash
npx supabase functions deploy twitch-metadata
```

(Without `--no-verify-jwt`.) The deployed copy still calls the revoked RPC.

### Verify the secrets are set

```bash
npx supabase secrets list
```

`TWITCH_CLIENT_ID` and `TWITCH_CLIENT_SECRET` must both be listed. Values are
not shown, which is correct. If either is missing, the new diagnostic reports
`twitch_credentials_missing`.

---

## 3. Casing

Unchanged in design; it simply had nothing to work with.

| | Value | Used for |
|---|---|---|
| Canonical | `lvndmark` | equality, clustering, JOIN, `destination_channel`, `opportunity_key`, caches |
| Display | `LVNDMARK` | on-screen text only |

Precedence remains metadata → locally learned casing → login. `resolveChannelName`
already checked metadata first; `ChannelNameProvider` already received it. The
lowercase you saw was the correct *fallback* for a channel with no display
information — which was every channel, because the pipeline was dead.

`tests/extension/metadataPipeline.test.tsx` now pins the exact observed case
end to end: presence `lvndmark` → metadata `LVNDMARK` → UI `LVNDMARK`, while
the cluster key, the opportunity key and the JOIN target all stay `lvndmark`.
No new casing workaround was added.

---

## 4. Gravity fallback

**Root cause:** the destination avatar rendered *only when Twitch supplied an
image*. So the header had two geometries — the channel name started flush left
without metadata and 28px in with it. The plain card was structurally a rich
card with a piece removed, which is exactly what it looked like; and metadata
arriving shoved the whole header sideways.

**Fix:** the avatar slot is always rendered. With a picture it holds the
picture; without one it holds a **tinted monogram** seeded from the channel
login — the same treatment every avatar in Kickback already falls back to, so
it reads as "no picture", not as an error, and it is visibly generated rather
than pretending to be Twitch's.

`avatarTint` moved to `src/ui/avatarTint.ts` and is shared by the friend avatar
and the channel avatar. They stay **different identities** (§9 of the brief): a
friend's picture is never promoted into the streamer slot; only the tint
function is shared, so the two look consistent without being the same thing.

Also: `.kb-gravity-people` now has its own top margin instead of inheriting
whatever sits above it, so the gap under the header is identical with and
without a stream line.

### The four states

| State | Renders |
|---|---|
| **LIVE** | avatar, authoritative casing, category, `● LIVE`, compact viewers, clamped title |
| **OFFLINE** | avatar + casing, `OFFLINE`, card dimmed to 0.72, friends + count + JOIN kept, demoted below live |
| **UNKNOWN** | avatar (monogram) + login, count, friends, JOIN. No badge, no category, no title, no reserved space |
| **STALE** | identical to UNKNOWN. Past 15 minutes a record stops asserting anything about *now*; it is not shown as OFFLINE, and there is deliberately no badge — staleness is an internal concept and a "possibly out of date" chip would be noise |

Nothing is faked in any state. A test asserts the plain card contains no
`static-cdn.jtvnw.net`, no `LIVE`, no `OFFLINE`, no `kb-gravity-stream` and no
`kb-gravity-title` — while still containing the avatar slot, the count, the
JOIN and the people.

Loading is progressive enhancement: a test compares the head's box sequence and
the avatar's size with and without metadata and asserts they are identical, so
metadata arriving adds rows *below* the header and moves nothing.

**Ranking is untouched.** Friend count still decides; viewer count still
decides nothing. The 5-friends/50-viewers vs 1-friend/50,000-viewers test still
passes unchanged.

---

## 5. UserCard regression

**Root cause:** `.kb-usercard` is `position: absolute; left: 6px; right: 6px`.
Those offsets resolve against the nearest **positioned ancestor**, so the
popup's width is whatever opened it.

| Surface | Anchor | Width |
|---|---|---|
| PersonRow | `.kb-row` | block in a column — full panel ✓ |
| Group chat | `.kb-msg` | block in a column — full panel ✓ |
| Group roster | `.kb-cluster-row` | block in a column — full panel ✓ |
| **Social Gravity** | **`.kb-gravity-person`** | **flex item in a wrapping row — ~90px** ✗ |

`left: 6px; right: 6px` on a ~90px containing block gives a ~78px card:
"AnoterosTV" ellipsised to "Anot…", the identity cramped, controls stacked.

**This came from the Social Gravity checkpoint, not the metadata one** —
`.kb-gravity-person { position: relative }` was added there, and a test
asserted it ("anchors a user card to the person it belongs to"), so the test
encoded the bug. The metadata checkpoint made the card denser, which is
probably why it became noticeable.

**Fix:** `.kb-gravity-card` is now the positioning context and
`.kb-gravity-person` is `position: static`. The person is still what you click;
the card is what the popup is measured against. Plus `min-width: 208px` on the
popup as a floor that never binds today but makes a future narrow anchor fail
visibly rather than unreadably.

Nothing about behaviour changed: outside-click, Escape, Profile, Remove Friend
and JOIN are untouched, and there is still exactly one `.kb-usercard` rule —
asserted, so no Gravity-specific variant can be added and drift.

`tests/extension/userCardWidth.test.ts` pins all four anchors. `verify:lab`
opens the card from a Gravity member in a real browser and measures it —
width ≥ 200px, name not clipped (`scrollWidth` vs `clientWidth`), handle
present, controls on ≤ 2 rows, no panel overflow — and repeats it at a 260px
panel.

---

## 6. Diagnostics

### Worker console (development and private_beta only; folded out of production)

```
[kickback:metadata] requested channels=1
[kickback:metadata] backend channels=1 backend=cache_miss
[kickback:metadata] stored channels=1
```

| Code | Meaning |
|---|---|
| `requested` / `fresh` | a call was made / everything was already cached |
| `stored` | records arrived and are in state |
| `rejected` | the backend answered, nothing survived the parser |
| `failed` | the call itself failed — offline, 401, 5xx, not deployed |
| `backend=…` | what the function reported about itself |

Backend codes: `budget_unavailable`, `budget_error`, `rate_limited`,
`twitch_credentials_missing`, `twitch_unavailable`, `twitch_error`,
`cache_unavailable`, `cache_hit`, `cache_miss`.

**Fixed codes and counts only.** No tokens, headers, JWTs, channel names or
user ids. Unrecognised codes from a future backend are dropped rather than
echoed — tested.

### Ask the backend directly

From **chrome://extensions → Kickback → "service worker"**:

```js
await kickbackMetadata.check('lvndmark')   // the deployed function's response
kickbackMetadata.snapshot()                // what the worker believes
```

Uses the session the worker already holds — no token to paste, none to leak.
Comparing the two separates "the backend is broken" from "the panel is not
showing what arrived".

### Supabase logs

**Dashboard → Edge Functions → `twitch-metadata` → Logs**, and
**Database → Logs → Postgres** for RPC permission errors (which is where the
original bug would have been visible).

---

## 7. Verification

| Command | Result | Time |
|---|---|---|
| 19 affected test files (517 tests) | pass | **3 s** |
| `npx tsc -b --force` | pass | 7 s |
| `npm run lint` | pass | 5 s |
| `npm run build` | pass | 5 s |
| `npm run verify:lab` (real Chrome) | pass | 11 s |

No mutation testing, no unrelated suites. Nothing near the 5-minute limit.

New: `metadataPipeline.test.tsx` (13) and `userCardWidth.test.ts` (16), plus
additions to `gravityMetadata.test.tsx`.

**Four existing tests were changed because they asserted the old, wrong
behaviour** — the Gravity anchor rule, the avatar-only-when-present markup, the
"plain card has no avatar" assertion, and the security test's RPC name. Each
now pins the corrected invariant with a note explaining what it used to say.

The browser gate found one real thing I would have missed: the user card's
controls appeared to stack onto three rows. That turned out to be **my
measurement** — a `<button>` and an `<a>` on the same visual line sit a pixel
apart, and I was counting distinct `top` values. Rows are now clustered with a
6px tolerance, the same technique the chat wrap gate uses.

Three times this checkpoint an assertion was defeated by my own explanatory
comment (`Intl.NumberFormat`, `scope`, `401`). The last one is now asserted
against comment-stripped source; the others were replaced with structural
checks.

---

## 8. Manual retest

### A. Test Lab (no accounts, no network)

```
npm run dev:lab            # http://localhost:5199
```

1. **Live creator** — avatar, `LIRIK`, category, `● LIVE`, `18K`, title, 3 friends, JOIN.
2. **Offline creator** — xQc (1 friend, live) sits **above** LIRIK (3 friends, `OFFLINE`, dimmed). JOIN still present.
3. **Metadata unavailable** — polished plain card: monogram avatar, count, friends, JOIN. No badge, no gaps.
4. **Mixed live / offline** — only the offline one is demoted; the unknown one holds its place.
5. **Authoritative casing** — `LVNDMARK`, from metadata alone.
6. **Long title + category** — both clamp to one line; JOIN stays put.
7. **Missing avatar** — monogram, header unmoved.
8. Click a friend inside any card → the user card should be full width with `AnoterosTV` readable.
9. Drag the panel down to its minimum width and repeat 1, 3 and 8.
10. Simulate failure: the **Metadata** section's `unavailable` control per destination is exactly a metadata outage.

### B. Real Twitch, two accounts

**After applying 0018 and redeploying the function.**

1. Account **A**: open `twitch.tv/ROOTCatZ` (or any live streamer).
2. Account **B**: open Twitch, open Kickback, look at Friends.
3. Expected:
   ```
   [avatar] ROOTCatZ · 1                    JOIN
            <category> · ● LIVE · 4.2K
            <stream title…>
            AnoterosTV
   ```
4. Click **AnoterosTV** → user card with a sensible width, full display name,
   `@anoterostv`, the destination, JOIN, Profile, Remove Friend.
5. Have A move to a channel that is **not** live → that card should mark
   `OFFLINE`, dim slightly, and sink below any live destination.
6. Swap roles and repeat with LVNDMARK to confirm casing on a channel neither
   of you has opened.

If metadata still does not appear, check the worker console for
`[kickback:metadata]` and run `await kickbackMetadata.check('rootcatz')`.

---

## 9. Git

16 files, +1,147 / −80. One clean commit, pushed, no force push.

```
cd32204 fix: restore metadata and gravity polish
4506cca..cd32204  main -> main
```

Secret scan over the staged diff (JWTs, bearer tokens, private keys, hex
secrets, passwords, authorization headers) returned **nothing**. Every
diagnostic string is a fixed literal; the worker prints a code and a count. No
`.env.local`, no credentials, no build artifacts.

---

## 10. Remaining caveats

- **The fix is unverified against the real backend.** I cannot apply the
  migration or redeploy from here, so the 401 is proven by reading the grants
  in 0013 and by the tests, not by a live request. The first real check is
  step B above.
- **Twitch credentials are still unconfirmed.** If they were never set, the
  next symptom after 0018 will be `twitch_credentials_missing` rather than
  metadata.
- **The `min-width` floor on the user card is a floor, not a guarantee.** A
  future surface that anchors the popup to something genuinely narrow would
  overflow rather than collapse. The four-anchor test is the real defence.
- **`index.ts` of the Edge Function is still outside the gate** — it is Deno and
  cannot be typechecked or linted here. Its pure logic is in `twitch.ts`, which
  is tested; the handler is verified by deploying it.
- **Stale metadata has no badge**, deliberately. If you decide a viewer should
  be told a record is old, that is a product change rather than a bug.
- The double gap between user-card controls (`gap: 5px` plus a legacy
  `margin-left: 6px` on `.kb-ghost-btn-inline`) was left alone: that class is
  shared by five surfaces and changing it is outside this checkpoint.

Stream Rooms not started.
