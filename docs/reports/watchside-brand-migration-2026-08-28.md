# Watchside — Kickback → Watchside brand migration

**Date:** 2026-08-28
**Branch:** merged into `main` and pushed — `main` = `origin/main` = `33c7dcb`
**Version:** 0.6.0 — unchanged, see *Version* below
**Extension ID:** `ngfopkeokddfnncdhfkhnffilbdhkkip` — unchanged and verified

---

## The rule this migration was built on

Every string a **person reads** now says Watchside. Almost nothing a
**machine reads** changed at all.

That split decided every judgement call below. The objective was *no active
user-facing Kickback branding*, not *`grep Kickback` returns zero* — and the
two would have pulled in opposite directions on storage keys, badge keys, the
invite parameter and thirty years of migration comments.

---

## Phase 1 — Inventory and classification

485 occurrences in `src/ public/ scripts/`, plus docs, tests and migrations.
Classified before anything was edited.

### A. MUST RENAME — user-facing

| Site | What a person saw |
| --- | --- |
| `public/manifest.json` | extension name, toolbar tooltip, store description |
| `public/popup.html` | title, wordmark, body copy |
| `src/ui/KickbackPanel.tsx` | the panel header wordmark |
| `src/ui/components/*.tsx` | sign-in title, quiet states, account version, badge shelf, chat badge chips, block dialog, "No Kickback user found" |
| `src/background/{auth,friends,groups,index}.ts` | every error sentence shown in the panel |
| `src/background/emoteCatalog.ts`, `EmotePicker.tsx` | the emote pack section title |
| `src/core/invites.ts` | `INVITE_LANDING_BASE` |
| `docs/web/invite-landing/index.html` | the whole landing page |
| `public/icons/*.png` | the K mark in the toolbar |
| `src/ui/components/Icons.tsx` | the K mark in the panel header |
| DB: fallback display name | the name a friend sees when Twitch sent no metadata |
| DB: 5 badge descriptions | the tooltip on a badge somebody earned |
| Anoteros Labs Pages | org page, privacy, support, invite |

### B. SHOULD RENAME — the codebase's own voice

Doc comments and prose across `src/`, `scripts/`, `tests/`, living docs
(`README.md`, `docs/PRIVACY.md`, `docs/ANALYTICS.md`, `docs/ROADMAP.md`,
`docs/TOGETHER.md`, `docs/TEST_LAB.md`, `docs/TWITCH_METADATA.md`,
`docs/BETA_*.md`, `docs/architecture/`, `supabase/README.md`, vite configs),
and the unreleased sections of `CHANGELOG.md`. No behaviour depends on any of
it.

### C. PRESERVE — and why each one would have cost something

| Preserved | Cost of renaming it |
| --- | --- |
| `chrome.storage` keys `kickback:preferences`, `kickback:sessionTab`, `kickback:mutedUsers`, `kickback:sessionRead`, `kickback:groups:*`, `kickback:attention:seen`, `kickback:channelMetadata`, `kickback:channelNames`, `kickback:analytics:*` | **Persisted user state.** Silently resets layout, muted list, read positions, group mutes. Invisible until a user complains. |
| `kickback_invite` query parameter | Wire contract between the landing page and the installed extension, which update **independently**. A renamed page + an un-updated extension = referral credit lost silently. |
| `SALT = 'kickback:social-gravity:v1'` | Reshuffles every experiment bucket mid-experiment. |
| Badge keys `referrer_1` … `referrer_25` | Referenced by `award_badge()`, `award_referral_badges()`, every `user_badges` row already granted, and `user_preferences.displayed_badge_key`. Orphans every badge earned. Explicitly ruled out by the brief. |
| `badge_definitions.issuer = 'kickback'` | Carried to the client and **compared, never rendered** — the shelf shows name/icon/description, the chat chip shows the icon. No user-facing branding exists here to fix. |
| DB object names (`sync_kickback_identity()`, tables, policies) | Referenced by triggers, grants and older migrations. Explicitly ruled out by the brief. |
| The `kickback: ` error prefix | Raised by the **hosted** database; the client strips it. Renaming the client half alone breaks error copy. |
| CSS prefix `kb-`, filename `src/ui/kickback.css` | ~1,500 internal selectors. Nothing user-visible; every layout and Test Lab selector depends on them. |
| Type names `KickbackClient`, `KickbackState`, `KickbackPreferences`, `KickbackIdentity`, `KickbackEmote`, `KickbackPanel`, `KickbackView` | Internal identifiers. Not product branding. |
| Bundle filenames `kickback-content.js`, `kickback-background.js` | Referenced by the manifest, packaging, and `tests/extension/bundle.test.ts`. A JS filename is not product branding. |
| `__KICKBACK_VERSION__`, `VITE_KICKBACK_ENV` | Build-time defines; the env var is in the owner's un-versioned `.env.local`. |
| Migrations 0001–0027 comments, `docs/checkpoints/**`, `docs/reports/**`, released changelog entries (0.4.0, 0.4.1) | A record of what was built and when, under the name it had. Rewriting it would be falsifying history. |
| `supabase/.temp/linked-project.json` | Supabase CLI local state naming the hosted project. Renaming that project is an owner action in the dashboard. |

### D. REVIEW — resolved

- **`package.json` name `kickback`** → kept; description renamed. Private
  package, read by nothing.
- **Store listing name "Kickback BETA"** → **owner action**, see below.
- **`WatchsideMark`** → renamed (not a data type; it *is* the identity, and
  its geometry was replaced wholesale).
- **`--kb-accent` / `--kb-accent-2`** → retuned from orange→pink to
  orange→indigo so every gradient in the stylesheet ends where the mark does.
  Neutral greys left alone: they are tuned against Twitch's dark UI, not
  against a brand.

---

## Phase 2–3 — The mark

`assets/brand/watchside-mark.svg` is the single canonical source: real
geometry on a 128 grid, **not** a trace of concept art.

Two people leaning together to form a W — an orange stroke, a purple stroke,
and a **white centre that is what actually completes the letter**. Neither
coloured half is a whole shape alone. Two circular heads sit above the outer
strokes. Navy ground, `rx 28`.

`scripts/render-icons.mjs` rasterises that one file into 16/32/48/128 through
the same browser engine that will later draw them — one CSS pixel to one PNG
pixel, no downsampling. `--check` re-renders into memory and fails on drift,
so the committed PNGs can be proven to still match their source. All four
currently match.

**16px drove the proportions.** At that size the mark is roughly eleven device
pixels of artwork, so the stroke went to 15/128, the heads to r=11 (larger
than the concept showed), and the stance to 74 units wide. Silhouette over
detail wherever the two disagreed. Verified by eye at 16 and 128.

The panel header carries the identical geometry inline in `Icons.tsx`.

Not Twitch's logo. Not a play triangle. Not a letter K.

---

## Phase 5 — The invite contract

- `INVITE_LANDING_BASE` → `https://anoteros-labs.github.io/watchside/invite/`
- `INVITE_PARAM` stays `kickback_invite` (reason in the table above)
- `codeFromUrl` still accepts both `c` and `kickback_invite` — unchanged

**Old links keep working.** `/kickback/{invite,privacy,support}/` are *not*
deleted; each is now a forwarding stub with two mechanisms:

1. a script that carries `location.search` — and therefore `c` — through
   untouched;
2. a `meta refresh` for when scripting is off, which loses only the
   attribution and still lands the visitor on Watchside.

No loop is possible: `/watchside/` never forwards anywhere. The Store
listing's privacy and support URLs, which point at the old paths, keep
resolving.

---

## Phase 6 — Migration 0028 (`0028_watchside_copy.sql`)

**NOT APPLIED TO HOSTED. Expects 27, advances 27 → 28.** Changes no table,
column, policy, grant or function signature.

Why the rename needs a migration at all: two pieces of copy a person reads
live in the database and cannot be reached from the extension — the fallback
display name a *friend* sees when Twitch sent no metadata, and the badge
descriptions the shelf renders into a tooltip. Everything else in this
migration is refusal to touch things (see the PRESERVE table).

1. `sync_kickback_identity()` replaced in full — byte-for-byte 0011's body
   with `'Kickback user'` → `'Watchside user'`. Restated in full because
   pl/pgsql cannot be patched in place; the trigger binds by name, so no
   trigger is dropped and no sign-in is interrupted.
2. Backfill of `users.display_name` and `connected_accounts.platform_display_name`
   **by exact equality** with `'Kickback user'` — never a pattern match, since
   a display name is otherwise the person's own.
3. The five badge descriptions, by key. Idempotent.
4. Marker → 28.

---

## Verification

| Gate | Result |
| --- | --- |
| `npm run build` | pass |
| `npm test` | **2162 passed / 83 files, 0 failed** |
| `npm run verify:store` | pass — ID matches, name `Watchside`, description 74/132, all four icons present |
| `npm run verify:config` | pass — hosted project reachable, Twitch auth enabled |
| `npm run verify:groups` | pass |
| `npm run verify:lab` | **11 failures — PRE-EXISTING** |
| `npm run verify:analytics` | **not run** — it mutates repo files in place |
| `node scripts/render-icons.mjs --check` | all four icons match the SVG |

**On `verify:lab`:** I did not assume these were pre-existing. I created a
detached worktree at `HEAD` (pre-migration), copied `node_modules` in, and ran
the gate there: **the identical 11 failures, same messages, same counts.** The
harness reads `.kb-gravity-count` and cannot parse what the Gravity work
earlier in this project now renders into it. Not caused by the rename, and out
of scope here — flagged as separate debt.

**Built artifacts:** zero occurrences of `Kickback` in either shipped bundle.
`dist/manifest.json` reads `Watchside`.

**Packages:**

- `releases/Watchside-Private-Beta-v0.6.0.zip`
  `sha256 c1217ff5093ed2cb65a918eea21d14df4f66cbf48283487cae12c81e6067203e`
- `releases/Watchside-Store-v0.6.0.zip`
  `sha256 150e3c5b9319d3ccccba5ca0d07ba5a6ea38ccde1a9f426b8ffb280b7a818d3d`

Beta keeps the manifest `key`; the Store package omits it and still resolves
to `ngfopkeokddfnncdhfkhnffilbdhkkip`.

---

## Version

**Stays at 0.6.0.** Chrome Web Store rules do not mechanically require a bump:
the Store item is at **0.4.1**, so 0.6.0 has never been uploaded and is still
available. A rename alone is not a reason to bump.

---

## What I did NOT do

- Did not upload anything to the Chrome Web Store.
- Did not apply any migration to hosted Supabase.
- Did not push either repository.
- Did not run the `test:authz` mutation harness, or `verify:analytics`.
- Did not generate a new extension identity or create a new Store item.
- Did not claim human acceptance — that is the owner's, and it has not happened.

---

## Publication — final state (2026-08-28)

Everything below was done after the migration itself and verified against what
is actually live, not against what was pushed.

**Database — DONE.** The owner ran `select public.analytics_schema_version();`
in the hosted SQL Editor and it returned **28**. 0028 is applied and confirmed.
No migration was applied, replayed or bundled from here. Owner action 1 below
is retained as a record of what was run and why; **it is complete — do not run
it again.**

**Pages — PUBLISHED.** `b600e95..f2881a4` pushed to
`Anoteros-Labs/anoteros-labs.github.io`, no force. All six routes verified
live over HTTP:

| Route | |
| --- | --- |
| `/watchside/invite/` `/watchside/privacy/` `/watchside/support/` | 200 |
| `/kickback/invite/` `/kickback/privacy/` `/kickback/support/` | 200 |

**Legacy invite compatibility — verified in a real browser, not from source.**
The forward is client-side, so HTTP alone cannot answer it. Driving the
deployed page with Chrome DevTools Protocol:

```
/kickback/invite/?c=TESTCODE   ->  /watchside/invite/?c=TESTCODE
/kickback/privacy/             ->  /watchside/privacy/
/kickback/support/             ->  /watchside/support/
```

and a real 22-character code survives **both** hops — the canonical page built
`https://www.twitch.tv/?kickback_invite=<CODE>` and its headline read
*"A friend invited you to Watchside"*. The live invite page points at
`chromewebstore.google.com/detail/ngfopkeokddfnncdhfkhnffilbdhkkip`, carries no
`authuser`/`hl` parameters, no stale non-hyphenated domain, and no Kickback
branding. 16/16 checks passed.

**Code — MERGED AND PUSHED.** `watchside-migration` fast-forwarded into `main`
(this repository's history is linear; there has never been a merge commit, so a
fast-forward is the established shape and it preserves all four commits without
squashing or rewriting). `497aeba..33c7dcb` pushed to `origin/main`.

**Artifacts — NOT rebuilt, and not needed.** The merge was a fast-forward, so
the tree hash is unchanged either side of it: `634060e9…` before and after,
with `src`, `public` and `scripts` byte-identical (`175fe48e…`, `adc26faa…`,
`cfe7bacb…`). The two ZIPs were re-hashed on disk rather than regenerated and
both still match, so no third set of "final" artifacts exists.

**Post-merge identity re-proved on `main`:** name `Watchside`, version `0.6.0`,
ID `ngfopkeokddfnncdhfkhnffilbdhkkip`. Permissions and host permissions are
byte-identical to pre-migration `497aeba`. `signInWithOAuth` requests **no**
`scopes` option, before or after — every diff in `auth.ts` and
`supabaseBackend.ts` is a comment string. Beta package keeps the manifest
`key`; Store package omits it. Shipped package contains **zero** occurrences of
`Kickback`, while the compatibility keys (`kickback:preferences`,
`kickback:sessionTab`, `kickback:channelMetadata`, `kickback_invite`) are all
still present. Shipped icons are byte-identical to `public/icons/` and all four
still match `assets/brand/watchside-mark.svg`.

**Gates on merged `main`:** `verify:store`, `verify:config`, `verify:groups`
all pass. Full suite **2162 passed / 83 files**.

> One wrinkle worth recording, because it will recur. Immediately after
> `git checkout main`, three source-pin tests failed. That is the CRLF debt
> already listed below, not a regression: `core.autocrlf=true` rewrote the
> working copy on checkout, and those assertions match multi-line template
> literals containing `\n`. Converting *only the line endings* of two files —
> no content change — took all 54 of their assertions green. The committed
> blobs are pure LF and `cmp` reports the working file byte-identical to
> `HEAD`, so nothing was altered; `git status` may show `src/background/index.ts`
> as modified purely because autocrlf wants CRLF in the working tree. There is
> nothing to commit.

**Still not done, deliberately:** nothing uploaded to the Chrome Web Store, no
new Store item, human browser acceptance pending, Firefox not started.

---

## Owner actions

1. ~~**Hosted database is one migration behind: apply 0028, alone.**~~
   **COMPLETE — hosted reports 28, confirmed by the owner. Do not re-run.**
   Retained below as the record of what was applied.

   > **Corrected 2026-08-28.** An earlier draft of this report said hosted was
   > at **26** and told you to paste the whole bundle. Both were wrong. The
   > owner ran `select public.analytics_schema_version();` in the hosted SQL
   > Editor and it returned **27** — 0027 is already applied. That reading is
   > authoritative and this section now follows it. **Do not run the bundle**:
   > it contains 0027 and there is no reason to replay it.

   Paste the contents of `supabase/migrations/0028_watchside_copy.sql` — that
   one file, nothing else — into the hosted SQL Editor and run it. It opens
   with `begin;` and ends with `commit;`, so it is one transaction: it either
   lands whole or not at all.

   Then confirm:

   ```sql
   select public.analytics_schema_version();   -- expect 28
   ```

   **0028 does not depend on 0027.** Its highest dependency is 0026
   (`badge_definitions`); it also touches `sync_kickback_identity()`,
   `users` and `connected_accounts`, all of which predate 0027. It neither
   reads nor alters `list_displayed_badges()`.

   This path is proven, not assumed. Migrations 0001–0027 were applied to real
   PostgreSQL, the marker read **27**, then 0028 alone was applied:

   ```
   marker before 0028               : 27
   fallback display name before     : "Kickback user"
   referrer_1 description before    : "Brought a friend to Kickback."
   marker after 0028                : 28
   existing row backfilled to       : "Watchside user"
   referrer_1 description after     : "Brought a friend to Watchside."
   a NEW signup after 0028 is named : "Watchside user"
   marker after applying 0028 twice : 28
   0027 list_displayed_badges intact: true
   badge rows still saying Kickback : 0
   ```

   Applying it twice leaves the marker at 28 and the copy unchanged, so a
   double-paste is harmless.
2. ~~**Push the Pages repo.**~~ **COMPLETE** — `f2881a4` pushed, all six routes
   verified live, query preservation verified in a real browser. See
   *Publication* above.
3. **Rename the Store listing** from "Kickback BETA" to "Watchside BETA", and
   refresh the listing description, screenshots and promo tile. `verify:store`
   now expects the "Watchside BETA" name.
4. **Two ZIPs in `releases/` share version 0.6.0** —
   `Kickback-Store-v0.6.0.zip` (stale) and `Watchside-Store-v0.6.0.zip`
   (current). I did not delete the old ones. Upload the **Watchside** file.
5. ~~**Merge `watchside-migration`** into `main`.~~ **COMPLETE** —
   fast-forwarded and pushed; `main` = `origin/main` = `33c7dcb`.
6. **Human acceptance test.**

## Flagged, not fixed

- ~~**`public/popup.html`** still says *"Phase 1 — sign in with Twitch.
  Friends and presence are still being built."*~~ **Fixed 2026-08-28** at the
  owner's instruction. That line was stale and untrue at 0.6.0; it now reads
  *"Private beta — see who's around, what they're watching, and join them."*
  Copy only — the popup was not redesigned. Both packages were rebuilt
  afterwards, so the hashes below are the ones that include it.
- **`verify:lab`'s 11 failures**, above.
- **CRLF**: `core.autocrlf` rewrites line endings on checkout, and three
  source-pin tests match on `\n`. Pre-existing, recorded earlier as debt; a
  fresh checkout of this branch could trip them.
