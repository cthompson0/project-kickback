# Marketing capture: state at the point work stopped

**Date:** 2026-09-08
**Status:** **HALTED** — blocked on production Twitch OAuth, which is degraded.
**Outcome:** tooling complete and verified up to the sign-in gate. **Zero enriched
captures produced.** No capture set is final, and none should be used.

---

## 1. Why this stopped

The owner attempted to rotate the Twitch application secret. The Twitch
Developer Console returned `ResetOauthAppSecret: service timeout`. Twitch
sign-in subsequently fails **in the owner's ordinary Firefox Watchside install**,
not only in capture tooling.

**Production Twitch OAuth is to be treated as degraded.** Nothing in this
milestone caused it and nothing in this milestone can fix it.

Independent corroboration from this session: the metadata harvest attached to
the Watchside service worker successfully, printed its sign-in prompt, and then
**timed out after five minutes waiting for a session to appear** — i.e. the
sign-in the owner attempted never completed. That is the same failure, observed
from a second direction.

### What the evidence points at (diagnosis only — nothing was changed)

`npm run verify:config` (read-only, uses the publishable key that already ships
in the extension) reports:

```
key accepted : yes
twitch auth  : enabled
```

**"enabled" is not "working."** `/auth/v1/settings` reports only that the
provider is *configured*, never whether its client secret is still valid. So the
registration is intact and the failure is almost certainly the **secret**:

- A rotation that times out may still have rotated the secret **server-side at
  Twitch**, leaving Twitch expecting a value nobody holds.
- Supabase's Twitch provider config then presents a stale secret. The user is
  redirected to Twitch normally and the flow dies at the **code exchange**,
  which is exactly the reported symptom and exactly why it reproduces in a
  normal browser install rather than only under automation.

**Two places hold that secret**, and a recovery must consider both:

| Where | Used for | Symptom if stale |
| --- | --- | --- |
| Supabase → Auth → Providers → Twitch | user sign-in | **sign-in fails** (current) |
| Supabase → Edge Functions → Secrets → `TWITCH_CLIENT_SECRET` | `twitch-metadata` | metadata silently stops enriching; panel falls back to the plain card |

The second may already be broken and would not be visible as an outage — by
design, metadata is enrichment and never a dependency (`src/core/twitchMetadata.ts`).

### Operational note

`docs/OPERATIONS.md` §"When to pause marketing" already says to pause when
**"sign-in failing for anybody"**. That condition is currently met. This is a
user-facing outage on a public build, not merely a tooling inconvenience.

---

## 2. What was built, and what state it is in

All of it is dev/capture-only. **Nothing production, nothing shipped, nothing
submitted.**

| File | State | What it is |
| --- | --- | --- |
| `src/mock/capture.ts` | **new** | The capture seam. Reads a staged override from `localStorage`, revalidates every field, and returns `{}` on anything absent or malformed. Mock-only. |
| `src/mock/presenceService.ts` | modified | `CHANNELS` is now defaults **merged with** an optional override; adds `STEADY` to freeze roaming/follower drift during a capture. Defaults are byte-identical to the Store set. |
| `src/client/demo.ts` | modified | Sets `channelMetadata` from the override. `{}` on every ordinary demo load, exactly as before. |
| `scripts/metadata-harvest.mjs` | **new** | Drives a real signed-in Watchside client so the production `twitch-metadata` Edge Function fetches the records. **Blocked here.** |
| `scripts/marketing-capture.mjs` | **new** | The four-shot capture run. Reads harvested records; refuses records older than 30 minutes. |
| `scripts/cdp.mjs` | modified | `setViewport` gains an optional `deviceScaleFactor` (default 1); adds `targets()`, `attach()`, `page.close()`, and an optional kept `profileDir`. All additive; every existing caller behaves identically. |
| `eslint.config.js`, `package.json`, `.gitignore` | modified | Two npm scripts, lint globals for the two new browser-driving scripts, ignore rules. |

### Verification at the point of stopping

```
npm run typecheck    pass
npm run lint         pass
npm test             140 files, 3318 tests, all pass
```

**The capture seam cannot reach production.** Rebuilt `dist/` from current
source and grepped: `watchside:capture`, `readCaptureOverride`,
`mockPresenceService` and the fixture names all return **0 matches** in both
`kickback-content.js` and `kickback-background.js`.
`tests/extension/bundle.test.ts` (53 assertions) passes against that build.

### Submitted v0.9 artifacts — untouched, proven by hash

| Artifact | SHA-256 | Matches `ROADMAP.md` |
| --- | --- | --- |
| `Watchside-Store-v0.9.0.zip` | `a6dd55b5ae6de466f82e970f05acc052d073850ab9e5bf7a1303566c694945be` | ✅ |
| `Watchside-AMO-Candidate-v0.9.0.zip` | `b05ad845c90d2b1a46efa266c08752a4c2472cbd03eac0c338919a8f94642147` | ✅ |
| `Watchside-AMO-Source-v0.9.0.zip` | `778cdaf354d5012cbea4a94f24433f55fc86cef082d1f299f045f572bb57d026` | ✅ |

---

## 3. What was proven to work, and what was never reached

### Proven (dry run, un-enriched, against the real live channels)

The harness was run end to end at 1600×1000 CSS / 2× → **3200×2000** masters:

- Channel override applies to the fixtures; roles filled from the preference list.
- `steady: true` freezes the roamers and the follower, so a shot is reproducible.
- **Hero state correct:** viewer on Sequisha; `theburntpeanut` card carries
  **3 friends — Chris, Jake, Matt — and JOIN**.
- **HERE semantics correct:** viewer on TheBurntPeanut → that card reads
  **`3 | HERE` with no JOIN**. The invariant holds — the product does not offer
  to JOIN the stream you are already watching.
- Demo disclosure present in every frame: `DEMO` badge and the footer
  `Watchside • demo mode — mock data`.
- Twitch is unmistakable; the panel is readable; nothing important is clipped.

### Never reached

**Enrichment.** Every Gravity card still shows a monogram avatar and a lowercase
login, with `game=null viewers=null title=null avatar=none`. That is the exact
deficiency this milestone exists to fix, and it is untouched.

The dry-run images were **deleted**, not kept. They are not a capture set, and
leaving them where a set is expected is how the wrong image ends up in an advert.

---

## 4. Corrections to the record, established during this work

**There has never been an enriched Watchside capture.** The premise that the
existing store pipeline produced one is not supported by the repository:

- `git log --all -S "channelMetadata" -- src/client/demo.ts` → **empty**.
- `git log --all -S "api.twitch.tv/helix" -- scripts/` → **empty**.
- The only caller of `twitch-metadata` anywhere is
  `src/background/supabaseBackend.ts:879`, using the caller's own session.
- The metadata service shipped **Aug 24** (`4fd878a`); the store screenshots
  were captured **Sep 2** (`58780e5`). The feature existed and still did not appear.
- `assets/store/current/chrome/store-02-gravity-join.png` shows
  `[E] 🔥 esl_sc2  3 friends  JOIN` — monogram, lowercase login, no LIVE badge,
  no category, no viewer count, no title.
- `scripts/site-images.mjs` derives watchside.app's images **from those same
  PNGs**, so the website imagery is equally un-enriched.
- `src/testlab/world.ts` simulates metadata but is explicitly synthetic
  ("no token here, no Helix parsing") and renders a lab page, not the panel over
  real Twitch.

**The production Edge Function *can* be consumed as-is**, which is what the
harvest was built on: `src/background/index.ts:1435` pushes
`tabActivity.destinations()` into `metadata.want(channels)` **unconditionally**,
so a signed-in client fetches metadata for any channel it has a tab open on.
Opening a tab is the supported interface. No bypass was needed or used.

That path also genuinely requires a real user, so it is not a loophole:
`supabase/functions/twitch-metadata/index.ts:283` calls `consume_metadata_budget`
**as the caller**, and an `anon` caller — lacking the grant — sets
`mayFetch = false` and is served from cache only.

---

## 5. Resuming, once credentials are recovered

Nothing here needs rewriting. In order:

1. **Owner recovers the Twitch secret** and updates **both** places in §1.
2. Confirm ordinary sign-in works in a normal install. That is the real gate;
   it is a user-facing outage, not a capture prerequisite.
3. Confirm channel liveness — the five candidates were all live on 2026-09-08 and
   will not be next time. The preference list is an argument, not a fixture:
   ```
   npm run metadata:harvest -- --channels theburntpeanut,sequisha,heyyouvideogame,cdnthe3rd,grimmmz
   ```
   Sign in once when prompted; the profile is kept, so it is asked once.
4. `npm run capture:marketing` — within 30 minutes of the harvest.
5. **Inspect every image before accepting any of it.** Automation exiting 0 is
   not evidence; the probe reports per-card `live`, `game`, `viewers`, `title`
   and whether each avatar actually decoded, and those must be read.

### Still undecided, and deliberately so

- Whether these replace the Chrome/Firefox store screenshots. They land in
  `assets/marketing/current/`, which is a **separate directory** from
  `assets/store/current/` precisely so that decision stays open.
- Which capture becomes the primary Reddit creative. Not answerable from
  un-enriched dry runs; the enriched hero has to be seen first.
- Interactive recording (`--headful --hold`) is implemented but **unverified**,
  because it needs the same sign-in-adjacent run to be worth doing.

---

## 6. Confirmation

- Production behaviour: **unchanged**. No auth, Supabase, Twitch or extension
  configuration was modified at any point.
- Submitted v0.9 artifacts: **untouched**, hash-verified above.
- Database: no schema change, no migration written or applied.
- The only network calls made were ordinary page loads of `twitch.tv`, one
  read-only `/auth/v1/settings` check via the existing `verify:config` script,
  and public liveness reads of five Twitch channel pages.
- Capture browsers started by this session were located by their
  `--load-extension` argument and stopped; `.harvest-profile` and
  `.metadata-harvest.json` were deleted. No session material remains on disk.
- Nothing is committed. The working tree holds the tooling and this report.

---

## Addendum — 2026-09-08, later: the credential blocker is gone, a different one is not

**§1's blocker is resolved.** The owner created a **replacement Twitch
application** after the original's secret rotation failed, pointed Supabase →
Authentication → Twitch at its new Client ID and Client Secret, and verified a
fresh Watchside login succeeds in normal Firefox. The project-level
`TWITCH_CLIENT_ID` and `TWITCH_CLIENT_SECRET` were updated to the same
replacement application.

That was the exact thing §1 was waiting for, and it means `npm run
metadata:harvest` can now complete: it needs a human sign-in and nothing else,
and the Edge Function's secret is current again.

**Do not resume the capture yet.** Production is not healthy: after a fresh
login, Watchside shows no friend online or presence state. That matters here
more than it would for most work, because the capture set is *of* friend
presence — captures 1, 2 and 3 are the presence panel, the Social Gravity
cluster and the HERE state. Photographing that while presence is broken would
either fail outright or, worse, produce a subtly wrong picture of the product.

Two things to check when it is resumed, both of which have moved since §5 was
written:

- **Channel liveness.** The five candidates were all live on 2026-09-08 and will
  not be next time. The preference list is an argument, not a fixture.
- **The metadata path.** It now runs on a replacement Twitch application. The
  harvest exercises it end to end, so a first run doubles as a check that the
  new credentials work for `twitch-metadata` and not only for sign-in — worth
  knowing, since a stale function secret breaks enrichment *silently*.

Nothing in the tooling changed. §2's file list, §3's verification and §6's
confirmations all still stand.
