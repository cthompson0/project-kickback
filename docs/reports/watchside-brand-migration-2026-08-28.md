# Watchside — Kickback → Watchside brand migration

**Date:** 2026-08-28
**Branch:** `watchside-migration` (2 commits, not merged, not pushed)
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

**NOT APPLIED TO HOSTED.** Changes no table, column, policy, grant or function
signature.

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
  `sha256 fe921819499c6fd326bf9f07527df60e5ddc7792ac10dd83896d61925d03dca4`
- `releases/Watchside-Store-v0.6.0.zip`
  `sha256 e3b2ef48c32a7c685bae519f3d47dfd65ea2947c7759ce232071ac5c792200c2`

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

## Owner actions

1. **Hosted database is two migrations behind.** It reports **26**; local
   expects **28**. Run `npm run db:bundle`, paste
   `supabase/.generated/apply_all.sql` into the SQL Editor, then confirm
   `select public.analytics_schema_version();` returns **28**. This applies
   0027 (the badge projection, outstanding from the previous checkpoint) and
   0028 together.
2. **Push the Pages repo.** `c:/Users/sk8bo/Projects/anoteros-pages`, commit
   `f2881a4`, committed locally but **not pushed** — publishing to a public
   site is your call. Until it is pushed, `/watchside/invite/` 404s. Nothing
   is live-broken today, because the shipped Store build is still 0.4.1 and
   does not mint links at that path.
3. **Rename the Store listing** from "Kickback BETA" to "Watchside BETA", and
   refresh the listing description, screenshots and promo tile. `verify:store`
   now expects the "Watchside BETA" name.
4. **Two ZIPs in `releases/` share version 0.6.0** —
   `Kickback-Store-v0.6.0.zip` (stale) and `Watchside-Store-v0.6.0.zip`
   (current). I did not delete the old ones. Upload the **Watchside** file.
5. **Merge `watchside-migration`** into `main` when you have reviewed it.
6. **Human acceptance test.**

## Flagged, not fixed

- **`public/popup.html`** still says *"Phase 1 — sign in with Twitch. Friends
  and presence are still being built."* That is stale for 0.6.0 and untrue.
  Unrelated to branding, so I left it rather than widen scope.
- **`verify:lab`'s 11 failures**, above.
- **CRLF**: `core.autocrlf` rewrites line endings on checkout, and three
  source-pin tests match on `\n`. Pre-existing, recorded earlier as debt; a
  fresh checkout of this branch could trip them.
