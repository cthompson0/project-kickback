# Firefox F6 — AMO release readiness (2026-08-29)

## 1. Executive verdict

**GO, with one owner decision recorded and not taken here.**

Watchside has one deliberate, unsigned, AMO-submittable release candidate, an
accompanying source archive that has been **proved** to rebuild it byte for byte,
a data-collection declaration mapped line by line from what the code actually
transmits, and a backend host permission narrowed from a wildcard over every
Supabase project on the internet to our own project alone.

The validator reports **0 errors**. Three warnings remain, each documented below
and none of them suppressed.

Nothing has been submitted, published, signed, or uploaded. The Chrome Web Store
artifact is byte-identical to the one already submitted.

**The one thing not decided here:** whether to declare `technicalAndInteraction`
and build the analytics opt-out that declaring it would oblige us to honour.
See §5.3. It is a product decision with a business consequence, so it is
reported rather than made.

## 2. Current Firefox release architecture

One codebase, one manifest source of truth, three Firefox artifacts that must
never be confused with each other.

```
public/manifest.json            the CHROMIUM manifest, byte-for-byte, submitted
      |
      | scripts/manifest.mjs  —  manifestFor('gecko', source, { supabaseOrigin })
      v
dist-firefox/                   built with WATCHSIDE_BROWSER=gecko (browser.*)
      |
      +-- package/              npm run package:firefox   DEVELOPMENT
      |     -> releases/Watchside-Firefox-v0.6.0.zip      what the E2E installs
      |
      +-- package-beta/         npm run package:firefox --beta
      |     -> releases/Watchside-Firefox-Beta-v0.6.0.zip  + a tester README
      |
      +-- package-amo/          npm run package:amo       THE CANDIDATE
            -> releases/Watchside-AMO-Candidate-v0.6.0.zip
            -> releases/Watchside-AMO-Source-v0.6.0.zip
```

None of the three is a signed add-on. Mozilla produces that from the candidate,
and it is the only one an ordinary Firefox user can install.

`npm run package:amo` wipes `dist-firefox/` for a clean build, so it also removes
the development unpack directory the E2E harness uses. Run `npm run package:firefox`
afterwards to restore it.

## 3. Mozilla requirements checked

Verified against current documentation rather than from memory, because two of
these changed within the last year.

| Requirement | Source | Watchside |
| --- | --- | --- |
| MV3 supported on Gecko | MDN | yes — `manifest_version: 3`, event page not service worker |
| Explicit add-on id required for MV3 | MDN `browser_specific_settings` | `watchside@anoteros-labs.com`, unchanged |
| `strict_min_version` required for MV3 | MDN | `140.0` (raised — §4.1) |
| `data_collection_permissions` | [Extension Workshop](https://extensionworkshop.com/documentation/develop/firefox-builtin-data-consent/) | required for new extensions from 3 Nov 2025; **declared** (§5) |
| Source submission for bundled/minified code | [Extension Workshop](https://extensionworkshop.com/documentation/publish/source-code-submission/) | required; **built and proved** (§7) |
| Reviewer environment | same | Ubuntu 24.04, Node 24.x, npm 11.x — our build needs nothing beyond it |
| Source archive ≤ 200 MB | same | 895 KiB |
| Obfuscated code forbidden | same | minified only; sources supplied |
| `gecko_android` omitted ⇒ desktop-only | MDN | omitted deliberately (§4.3) |

## 4. Manifest

### 4.1 `strict_min_version`: 128.0 → 140.0

**Firefox 128 ESR went out of support on 16 September 2025.** The floor was
originally chosen because 128 was the current ESR — institutional users are on
ESR, and the floor sits above Firefox 127 where MV3 host permissions began being
granted at install. That reasoning is still right; the number had simply gone
stale. **140 is the current ESR**, and 153 is announced as the next one.

140 is also the release that introduced `data_collection_permissions`. Below it
the key is *ignored*, so a user on 139 would install without ever seeing
Firefox's built-in data-collection consent — the disclosure would exist in the
manifest and never reach the person it is for. Raising the floor is what makes
§5 mean something at install time rather than only on the listing page.

This narrows the install base to Firefox 140+. Given 128 ESR is end-of-life,
that is not a live audience being dropped.

### 4.2 `data_collection_permissions`

Declared. Full mapping in §5.

### 4.3 No `gecko_android`

MDN is explicit: *"To support Firefox for Android without specifying a version
range, the `gecko_android` sub-key must be an empty object... Otherwise, the
extension is only made available on desktop Firefox."*

Watchside is a panel that lives beside a Twitch player and a chat column. It has
never been run on Firefox for Android. Adding `gecko_android` to silence a linter
warning would claim a platform we have not tested, which is the wrong trade — so
the key is absent and the warning is documented in §9 instead.

### 4.4 Everything else

Unchanged: name, version, icons, action, content-script matches, and the four
API permissions (`identity`, `storage`, `alarms`, `notifications`). The Chromium
`key` is still stripped, and the background is still an event page.

## 5. Data-collection mapping

Mapped from what the code transmits, not from what reads well. Every row was
traced to a call site.

### 5.1 What is transmitted, and where it lands

| Behaviour | What goes out | Mozilla category |
| --- | --- | --- |
| Twitch OAuth sign-in, account creation | Twitch identity → our Supabase project | `authenticationInfo` |
| Profile (`me`) | user id, display name, avatar URL, Twitch login, friend code | `authenticationInfo` |
| Presence / destinations (`report_destinations`) | **the Twitch channel you are watching** | `browsingActivity` |
| Friend destinations (`list_friend_destinations`) | reads friends' channels | `browsingActivity` |
| 7TV emote lookup | **the channel login**, unauthenticated, to a third party | `browsingActivity` |
| Stream-room messages (`send_room_message`) | the message body | `personalCommunications` |
| Reactions (`send_together_reaction`) | which emote, to whom | `personalCommunications` |
| Feedback (`submit_feedback`) | free text the user wrote | `personalCommunications` |
| Analytics (`analytics_track`) | JOINs, surfaces, counts, buckets — **and `destination_channel`** | `websiteActivity` + `browsingActivity` |
| Friendships, groups, blocks | the social graph | covered by `authenticationInfo` (account state) |
| Error telemetry (`client_error`) | two values from fixed enums — no free text, no stack traces, no device or browser info | see §5.3 |

**Declared:**

```json
"data_collection_permissions": {
  "required": [
    "authenticationInfo",
    "browsingActivity",
    "personalCommunications",
    "websiteActivity"
  ]
}
```

### 5.2 What is deliberately NOT declared, and why

**`personallyIdentifyingInfo`** — Mozilla defines it as *"contact information
such as name and address, email, and phone number, as well as other identifying
data such as ID numbers, voice or video recordings, age, demographic information,
or biometric data."* Watchside collects none of that. There is **no email address
anywhere in the client** — verified by grep across `src/`. The Twitch handle,
display name and avatar are the account's own public Twitch profile, which
`authenticationInfo` explicitly covers (*"registration information for
extensions"*). Declaring PII as well would tell users something untrue in the
more alarming direction, which is its own kind of dishonesty.

**`websiteContent`** — the content script reads the channel from the URL and
locates the chat container to position the panel. None of that page content is
transmitted. Only the channel login leaves, and that is `browsingActivity`.

**`searchTerms`, `bookmarksInfo`, `healthInfo`, `financialAndPaymentInfo`,
`locationInfo`** — not collected in any form.

### 5.3 `technicalAndInteraction` — OPEN OWNER DECISION

Mozilla allows this type **only as optional**, and an optional data permission
must be honoured: `browser.permissions.getAll()` returns a `data_collection`
key, and a declining user must not have that data collected.

Watchside's `client_error` events are error reports, which is squarely what this
category describes. **But Watchside has no analytics opt-out.** Declaring the
type without building the gate would be a promise the code does not keep, and
that is worse than not declaring it.

The two honest options:

- **A — leave it undeclared (what ships today).** The analytics pipeline is
  already disclosed by `browsingActivity` and `websiteActivity`, which is where
  its privacy weight actually sits: it carries channel names. The error events
  carry two enum values and nothing else. Risk: a reviewer may ask why error
  reporting is not declared.
- **B — declare it optional and build the gate.** Check `permissions.getAll()`
  before sending, and suppress when declined. Contained work in one place — the
  analytics backend — but it is a real behaviour change that reduces analytics
  completeness on Firefox by an unknown fraction.

This is a product decision with a business consequence, so it is reported rather
than taken. `tests/extension/firefoxPackage.test.ts` fails if
`technicalAndInteraction` is added without the gate, so option B cannot be
half-done by accident.

## 6. Privacy policy

`docs/PRIVACY.md` was already accurate and unusually specific — the analytics
section already said channel names are recorded and message bodies never are.
Two things needed correcting, neither of which widens collection:

1. **The permissions list named the wildcard.** Updated to describe the narrowed
   Firefox grant, and to say plainly that Chrome still has the wildcard and will
   be narrowed at its next release.
2. **"Nothing about you is sent" to 7TV was too strong.** The request carries the
   **channel name** in order to look up that channel's emote set. Nothing that
   identifies the user goes with it — no account, user id, token or cookie — and
   the text now says exactly that instead of implying no request content at all.

A new section, *"What Firefox tells you at install"*, maps Mozilla's four
user-facing strings to the rows of the existing table, so the consent prompt and
the policy cannot be read as describing different products.

**The published page is not regenerated here.** `scripts/build-privacy-page.mjs`
writes into the Pages site checkout, which is not this repository, and publishing
is out of scope. It is an owner step — §12.

**Verdict: the policy is sufficient for AMO** once the page is republished.

## 7. Host permission

### 7.1 The decision

`https://*.supabase.co/*` → `https://ezikxbbcwcxhkboeekkk.supabase.co/*`, **in
the Gecko manifest only.**

The wildcard grants every Supabase project on the internet. That is far more than
Watchside needs and exactly the kind of breadth an AMO reviewer has to stop and
ask about.

### 7.2 Why it is safe — established, not assumed

Reading the bundled supabase-js:

```js
this.realtimeUrl  = new URL('realtime/v1', supabaseUrl)   // http -> ws, same host
this.authUrl      = new URL('auth/v1',     supabaseUrl)
this.storageUrl   = new URL('storage/v1',  supabaseUrl)
this.functionsUrl = new URL('functions/v1', supabaseUrl)
```

Every service — auth, REST, realtime, storage and Edge Functions — is derived
from the single project URL. There is no `<ref>.functions.supabase.co` rewrite in
this version. The only other `*.supabase.co` occurrence in the bundle is an
allow-list inside supabase-js's own redirect validation, not a request target.

The origin is not hard-coded: the packager **reads it back out of the built
background bundle**, so a manifest can only ever grant the project the code
actually talks to. A drift between the two would present as a Firefox user who
cannot sign in, and would look like a backend outage.

### 7.3 Regression coverage

| Layer | What it pins |
| --- | --- |
| `tests/extension/firefoxPackage.test.ts` | wildcard absent; exactly one Supabase origin; it matches the origin in the bundle; every other host permission unchanged; **the Chromium manifest still has the wildcard** |
| `scripts/verify-firefox.mjs` | the packaged manifest equals the transform for the bundle's origin; the wildcard did not survive |
| `scripts/package-firefox.mjs` | fails the build if the wildcard survives or the origin is missing |
| E2E `03-platform` | after revoking Twitch at runtime, the backend grant is still exactly one project, matched by shape rather than by literal |
| E2E `05-social` | **the Edge Function is reachable under the narrowed grant** — `lirik -> "LIRIK"` |

That last one is the one that matters. Edge Functions are the only call that is
not a plain PostgREST request, so if the narrowing were wrong they would be the
first thing to break. Channel metadata enriched, so the grant covers every
service.

Chromium keeps the wildcard. Narrowing it there means a new Chrome Web Store
submission, which is a separate decision and explicitly out of scope.

## 8. Source package and reproducibility

### 8.1 Design

`scripts/package-source.mjs`, an **allow-list**. A deny-list ships whatever
nobody thought of, and the things nobody thinks of here are
`.keys/kickback-extension.pem` — the Chrome Web Store signing key — `.env.local`,
and the authenticated Firefox profiles the E2E runs against.

**Included:** `package.json`, `package-lock.json`, all four tsconfigs, the four
Vite/Vitest configs, `eslint.config.js`, `public/`, `src/`, `tests/`,
`supabase/functions/`, and all of `scripts/` except `firefox-e2e/`. Plus two
generated files: `.env.amo` and `REVIEWER-BUILD.md`.

**Excluded:** `node_modules/`, `.env.local`, `.keys/`, `*.pem`, `dist*/`,
`releases/`, `scripts/firefox-e2e/`, `seeds.local.json`, `supabase/.temp/` (the
Supabase CLI's local link state — a project ref and a pooler URL belonging to
this machine), `supabase/migrations/`, `docs/`, and the git history.

`tests/` is present because it has to be: `npm run build` starts with `tsc -b`,
and `tsconfig.json` references `tsconfig.test.json`. `supabase/functions/` is
present for the same reason — a test imports the Edge Function's Twitch client.

The scan is retuned for source rather than reused wholesale. `package-shared.mjs`
matches bare words like `service_role` and `client_secret`, which is right for a
built bundle and wrong here: `tests/extension/bundle.test.ts` is the test that
asserts the bundle contains no secrets, so it names every one of them, and
`package-shared.mjs` *is* the pattern list. The source scan matches credential
**values** instead — a key with a body, a real PEM block, a signed token, a
connection string carrying a password.

### 8.2 The two build values

`.env.amo` carries `VITE_SUPABASE_URL` and `VITE_SUPABASE_PUBLISHABLE_KEY`, read
back out of the built bundle so they cannot drift. Both are **public**: they are
compiled into the artifact under review and can be read straight out of it. The
publishable key is client-safe by design and protected by row-level security.

A service-role key would not be — so the packager refuses to run if the bundle
contains one, matched on a key body rather than on the `sb_secret_` prefix.
(supabase-js carries both prefixes as string literals in order to *reject* one of
them; a looser match calls that a leak.)

### 8.3 Proved, not claimed

The archive was extracted to a clean directory and built as a reviewer would:

```
unzip Watchside-AMO-Source-v0.6.0.zip
cp .env.amo .env.local
npm ci
npm run package:firefox
```

| | |
| --- | --- |
| Rebuilt archive SHA256 | `6a2365fdf7425b918727f928adba9ca4eb3d8764fe4bde2dff5c37a07b2e8081` |
| Uploaded candidate SHA256 | `6a2365fdf7425b918727f928adba9ca4eb3d8764fe4bde2dff5c37a07b2e8081` |
| `diff -r` of unpacked contents | **empty** |

That is Mozilla's stated standard — *"There must be no differences"* — met
literally.

**Running it is what made it correct.** The first archive did not build: it was
missing `scripts/extension-identity.mjs` and the `.d.mts` declarations that stop
`tsc` treating every `.mjs` import as `any`, and `supabase/functions/`. An
itemised list of "the five scripts the packager calls" was too clever by half.
The rule is now the whole directory minus the one subtree that must not travel.

## 9. AMO candidate and validation

| | |
| --- | --- |
| **Candidate** | `releases/Watchside-AMO-Candidate-v0.6.0.zip` |
| **SHA256** | `6a2365fdf7425b918727f928adba9ca4eb3d8764fe4bde2dff5c37a07b2e8081` |
| Size | 175.7 KB, 8 entries |
| **Source** | `releases/Watchside-AMO-Source-v0.6.0.zip` |
| **SHA256** | `dfdf9e45234cbefe54cd6ac864e2c9b253a34b001806c4366337beaf9cf0c5b2` |
| Size | 895 KiB, 257 entries |
| Analytics cohort | `private_beta` — this is the 0.6.0 beta line, same as Chrome |

`npx web-ext lint` (web-ext 10.6.0 / addons-linter 10.10.0):

**0 errors. 0 notices. 3 warnings**, each treated individually:

| Warning | Verdict |
| --- | --- |
| `MISSING_DATA_COLLECTION_PERMISSIONS` | **fixed** — this is what §5 resolves |
| `KEY_FIREFOX_ANDROID_UNSUPPORTED_BY_MIN_VERSION` ×1 | **documented.** The Android floor is inherited from `gecko.strict_min_version` (140), and Android 142 is where the key landed. Silencing it means adding `gecko_android`, which would *opt in* to a platform we have never tested. Per MDN, omitting the key means the add-on is desktop-only — so the warning describes a configuration that does not exist. |
| `UNSAFE_VAR_ASSIGNMENT` ×2 | **documented.** Both are inside React's own DOM implementation, on the `dangerouslySetInnerHTML` branch. Watchside passes that prop nowhere, so the code is unreachable — and a test now asserts that no file under `src/` contains `dangerouslySetInnerHTML` or `.innerHTML =`, so the day somebody uses it, the claim fails instead of quietly becoming false. |

Nothing was suppressed.

## 10. Cross-browser regression

| Check | Result |
| --- | --- |
| `npm test` | **2286 passed / 88 files** |
| `tsc -b --force` | clean |
| `eslint .` | clean |
| `verify:firefox` | pass |
| `verify:store` | pass |
| `verify:firefox:e2e` | **5/5 scenarios, 128s** |
| Chromium extension ID | `ngfopkeokddfnncdhfkhnffilbdhkkip` — unchanged |
| Gecko add-on ID | `watchside@anoteros-labs.com` — unchanged |
| Chrome `permissions` | `identity, storage, alarms, notifications` — unchanged |
| Chrome `host_permissions` | wildcard retained — unchanged |
| Chrome manifest `key` | present — unchanged |
| `public/manifest.json` | **not modified** (`git diff` empty) |
| OAuth scopes | `oauthContract.test.ts` 8/8 — still no scopes requested |

### Chrome artifact untouched

`releases/Watchside-Store-v0.6.0.zip` — `150e3c5b9319d3ccccba5ca0d07ba5a6ea38ccde1a9f426b8ffb280b7a818d3d`,
modified 2026-08-28 20:46. Byte-identical to the submitted artifact recorded in
the brand-migration and F5 reports. Neither `package:store` nor `package:beta`
was run.

### Seed safety

| | before | after |
| --- | --- | --- |
| `seed-a` | `490abc069b69176b` | `490abc069b69176b` |
| `seed-b` | `230347d30f6355fa` | `230347d30f6355fa` |

Unchanged across the full E2E suite. Seeds are copied, never opened, and are
excluded from the source archive by name.

## 11. Release strategy — WS-F5-01

Recorded as instructed: **WS-F5-01 does not trigger a standalone Chrome Store
release.** The fix is in shared code (`background/index.ts`,
`background/streamRoom.ts`) and is already in `main`, so it will ship to Chrome
users in the next coherent Chrome release package. The published and submitted
Chrome v0.6.0 artifacts are unchanged.

## 12. Owner submission checklist

Verified against current AMO documentation. Nothing here is optional and nothing
else is required.

1. **Firefox Add-on Developer account.** Sign in at
   `addons.mozilla.org/developers/` with a Mozilla account and accept the
   distribution agreement. One-time.
2. **Choose the distribution channel.** *Listed* (public on AMO, full review) or
   *Unlisted* (signed for self-distribution, faster review). The beta line
   suggests unlisted or listed-with-a-beta-note; either works with these
   artifacts.
3. **Upload** `releases/Watchside-AMO-Candidate-v0.6.0.zip`.
4. **Upload the source archive** `releases/Watchside-AMO-Source-v0.6.0.zip` when
   AMO asks — it will, because the code is minified. It contains
   `REVIEWER-BUILD.md`.
5. **Listing metadata** (listed only): name, summary, description, category,
   icon, screenshots. The Chrome listing copy transfers.
6. **Privacy policy URL.** Republish the Pages privacy page from the updated
   `docs/PRIVACY.md` first — the §6 changes are not live until you do.
7. **Reviewer notes.** Suggested text:
   > Watchside is a Twitch overlay. Sign-in is Twitch OAuth via Supabase with
   > **no Twitch scopes requested**. The backend is a single Supabase project,
   > named exactly in `host_permissions`. Source archive included; see
   > `REVIEWER-BUILD.md` — `npm ci && cp .env.amo .env.local && npm run package:firefox`
   > reproduces the upload byte for byte. The two `innerHTML` warnings are inside
   > React's `dangerouslySetInnerHTML` branch, which this add-on never uses.
8. **Submit and wait.** Signing is Mozilla's step; do not re-upload in the
   meantime.

**Not required:** a separate data-disclosure form (the manifest declaration
drives it), Android compatibility (desktop-only by omission), a paid account.

## 13. Remaining risks and blockers

| Risk | Assessment |
| --- | --- |
| `technicalAndInteraction` not declared | §5.3 — the one open decision. A reviewer may ask; the answer is that error reporting has no opt-out and we would rather not claim one. |
| Firefox 140 floor | Deliberate. Drops nothing supported: 128 ESR ended 2025-09-16. |
| Reviewer build environment | Ours is Windows + Node 24.13.1; theirs is Ubuntu + Node 24.14.0. The build is lockfile-pinned and the ZIP timestamps are fixed, so any Node 24.x should match. **Not verified on Ubuntu** — the residual reproducibility risk, and the likeliest cause of a "does not match" review note. |
| Supabase redirect URL | The Gecko redirect is registered (F3) and sign-in works on real Firefox. Unaffected by the narrowing. |
| Android warning | Cosmetic; §9. |
| Privacy page not republished | Owner step 6. **Blocks submission** if a listed policy URL is required. |

No blocker prevents producing the artifacts; the only pre-submission blocker is
republishing the privacy page.

## 14. F7 prerequisites

F7 (real-Firefox permission/consent acceptance) can start once:

1. The `technicalAndInteraction` decision in §5.3 is made — it changes what the
   install prompt says, and F7 would otherwise test a prompt that is about to
   change.
2. The privacy page is republished.
3. Optionally, Mozilla has signed the candidate, so F7 can exercise a signed
   install rather than a temporary add-on.

What F7 inherits ready: a validator-clean candidate, a five-scenario real-browser
suite including two-actor social, two authenticated seeds, and a reproducible
source archive.

## 15. Production, hosted, Chrome

**Zero hosted changes. Zero schema changes. Zero OAuth changes.** No migration
applied, no Supabase configuration touched, no Chrome artifact rebuilt.

Product code changed in exactly one respect — none. The changes are in
`scripts/manifest.mjs`, `scripts/package-firefox.mjs`, `scripts/verify-firefox.mjs`,
the new `scripts/package-source.mjs`, tests, the E2E scenarios, and
`docs/PRIVACY.md`.

Nothing was submitted to Mozilla. F7 and M3 remain unstarted.
