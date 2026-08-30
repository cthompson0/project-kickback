# Firefox F6 — AMO release readiness (2026-08-29)

## 1. Executive verdict

**GO.** The one open decision is now resolved - see §16, which supersedes §5.3
and §9 on the artifacts.

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

**RESOLVED in §16: option A, and more.** Firefox now collects none of it, and
the boundary turned out to be three events rather than one. This is a product
decision with a business consequence, so it was reported rather than taken here. `tests/extension/firefoxPackage.test.ts` fails if
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
6. ~~**Privacy policy URL.** Republish the Pages privacy page.~~ **DONE — §17.**
   The policy URL for the listing is
   `https://anoteros-labs.github.io/watchside/privacy/`.
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
| ~~Privacy page not republished~~ | **Cleared — §17.** Published and verified live. |

No blocker prevents producing the artifacts, and the privacy page is now
published (§17). **There is no remaining pre-submission blocker.**

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

---

# 16. Owner decision on `technicalAndInteraction` — RESOLVED (2026-08-29)

§5.3 left one question open. It is now decided.

## 16.1 The decision

**Watchside collects no Mozilla `technicalAndInteraction` data on Firefox.**

Not declared as optional, not requested at runtime, not collected. There is no
second consent prompt, no analytics toggle, and no setting to manage — because
there is nothing to consent to.

The reasoning is worth stating plainly, because "we collect less" is easy to say
and usually costs something. Mozilla permits that category only behind an
optional permission, and an optional permission is a promise: a second question
at install and a user choice to honour forever after. The alternative to asking
is not collecting. Watchside took the second, and the price is paid on the
Firefox side of error reporting rather than by users being asked another
question.

**Everything else is unchanged.** The required declaration established in §5 is
exactly as it was, and every product and funnel measurement still runs on both
engines.

## 16.2 Classification — all 46 events

The boundary was drawn from the taxonomy, not from convenience.
`technicalAndInteraction` is *"device and browser info, extension usage and
settings data, crash and error reports."* Watchside collects **no device or
browser information at all** in analytics — the envelope carries an app version,
an environment label and a session id, all properties of the BUILD — so the
question reduces to one test:

> Is this event a report about our software's health, or a record of something a
> person did?

| Event family | Purpose | Mozilla category | Req/Opt | Firefox | Chrome | Rationale |
| --- | --- | --- | --- | --- | --- | --- |
| `extension_session_started` · `extension_session_ended` | session frame; the denominator of every funnel | websiteActivity | required | **sends** | sends | Bounded by the person being active on Twitch; `duration_ms` measures how long they were. Reading it as "extension usage" would gate the denominator and bias every rate computed against it. |
| `authenticated_session_started` | friends/groups at sign-in | authenticationInfo | required | **sends** | sends | Account state. |
| `friend_search` · `friend_request_*` · `friend_removed` · `group_invite_*` | social graph actions | websiteActivity | required | **sends** | sends | Actions a person took. The search query itself is never recorded. |
| `friend_presence_impression` · `gathering_impression` · `gravity_cluster_impression` | **Gravity exposure** | browsingActivity | required | **sends** | sends | Carries the channel. The core of the product thesis. |
| `join_clicked` · `join_arrived` | **JOIN, its source/surface, and arrival** | browsingActivity | required | **sends** | sends | A click and its outcome. |
| `watching_together_started` · `watching_together_ended` | **shared-watch behaviour and duration** | browsingActivity | required | **sends** | sends | What the person watched, with whom, for how long. |
| `post_social_retention_ended` | **post-social linger** | browsingActivity | required | **sends** | sends | Continued viewing after a shared watch. |
| `gathering_notification_shown` · `_clicked` | notification funnel | browsingActivity | required | **sends** | sends | Shown and acted on. |
| `destinations_published` | how many streams are open | browsingActivity | required | **sends** | sends | Buckets, never the channel list. |
| `automatic_room_entered` · `_opened` · `_left` | Stream Room lifecycle | browsingActivity | required | **sends** | sends | Channel-bound room activity. |
| `automatic_room_message_sent` · `_reaction` · `_combo` · `combo_formed` · `combo_broken` · `group_message_sent` | that a message or reaction happened | personalCommunications | required | **sends** | sends | Bucket and flag only, never a body — but still a record that a communication occurred. |
| `group_created` · `group_opened` · `user_blocked` · `user_unblocked` · `feedback_submitted` | product actions | websiteActivity | required | **sends** | sends | `feedback_submitted` carries the category only; what was written goes to `submit_feedback`, never through analytics. |
| `friend_suggestion_*` · `invite_link_*` · `invite_claimed` · `referral_succeeded` · `badge_awarded` · `badge_displayed` | **referrals and the growth funnel** | websiteActivity | required | **sends** | sends | Acquisition measurement. Counts, buckets and fixed vocabularies. |
| **`client_error`** | a caught failure, as a call site and a code | **technicalAndInteraction** | optional-only | **SUPPRESSED** | sends | Nobody did this on purpose. It is an error report, which is the category verbatim. |
| **`realtime_status_changed`** | a subscription changed state | **technicalAndInteraction** | optional-only | **SUPPRESSED** | sends | Transport health, not behaviour. |
| **`group_message_send_failed`** | a group message was refused | **technicalAndInteraction** | optional-only | **SUPPRESSED** | sends | The nearest thing to a borderline case — a person did try to send something — but the event carries a `FailureCode` and nothing else, and what it measures is whether our messaging works. The SUCCESSFUL send is `group_message_sent`, which is product data and is not gated, so what Firefox loses is reliability visibility rather than any part of the funnel. |

### The STOP condition was checked and not triggered

No Gravity, JOIN, discovery, shared-watch or growth event falls into
`technicalAndInteraction`. Every one of them records something a person did, and
lands in `websiteActivity` or `browsingActivity` — both of which Mozilla permits
as **required**, and both of which Watchside already declares. Nothing
strategically important needed to become optional, so nothing was suppressed and
no owner escalation was needed.

## 16.3 The suppression boundary

**Three events, one check, one place.**

`src/background/analytics.ts`, inside `track()`, immediately after the existing
`enabled` guard:

```ts
if (deps.collectTechnical === false && isTechnicalAndInteraction(request.name)) return
```

Why there and nowhere else:

- **It is the one place every event already passes through.** A per-call-site
  check is a rule somebody eventually forgets, and product code stays free of
  engine awareness entirely.
- **It fails closed.** The drop happens *before* the queue, so a suppressed
  event cannot be revived by a later flush, by the retry path that pushes a
  failed batch back on the front, or by anything that inspects the queue.
  Nothing is held, so nothing survives a worker restart.
- **It consults the classification, not a hand-kept list.**
  `EVENT_DATA_CATEGORY` is a `Record<AnalyticsEventName, MozillaDataCategory>`,
  so **an event cannot be added without being classified — that is a compile
  error** — and a new diagnostic event is suppressed the moment it is.

The engine is named exactly once, in `src/background/index.ts`:

```ts
collectTechnical: !IS_GECKO,
```

`IS_GECKO` is now exported from the browser adapter for this one purpose. The
adapter exists to make the engine invisible to feature code; this is the single
named exception, and a test asserts the worker contains exactly two references
to it — the import and the one use.

### One place outside analytics

Feedback attached `browser: browserName()`, which reads the user agent. That is
"device and browser info" — the first thing Mozilla lists under the category —
so on Firefox **the field is omitted**. It is dropped rather than faked:
`submit_feedback` runs its context through `jsonb_strip_nulls`, so an absent key
is simply absent, and **no schema change was needed**. Everything else a report
needs — version, environment, channel, friend count, sync health — is unchanged,
so feedback from Firefox is still answerable.

This was found by auditing rather than assumed: it would otherwise have made the
privacy policy's claim about browser information false.

## 16.4 What was NOT done

- No optional declaration in the manifest.
- No `permissions.request({ data_collection: … })` anywhere — asserted against
  the built bundles, which contain the string `data_collection` nowhere.
- No consent prompt, no settings screen, no analytics toggle.
- No synthetic or replacement events when telemetry is suppressed. A suppressed
  event leaves no trace at all; it is not counted, bucketed or stand-in-logged.
- No change to any event name, property or semantic.
- No OAuth scope change, no hosted schema change, no new permission.
- No product behaviour changes because diagnostics are absent — the code paths
  that call `noteFailure` still run and still recover; only the report is
  dropped.

## 16.5 Regression coverage

`tests/extension/firefoxTelemetryBoundary.test.ts`, 14 tests.

| Requirement | Test |
| --- | --- |
| A — Firefox suppresses `client_error` | nothing queued, nothing sent after a flush |
| B — no other technical event escapes | every member of `TECHNICAL_AND_INTERACTION_EVENTS`, all dropped |
| B — fails closed | a suppressed and a product event tracked together; two flushes; only the product event ever sends |
| C — core funnel unaffected | all 43 non-technical events sent under the Firefox flag |
| D — the strategic set, named individually | Gravity, JOIN, arrival, shared watch, linger, sessions, growth — asserted **not** technical, and asserted to send. Written out by name so that reclassifying JOIN cannot be made to pass by editing one list. |
| E — Chromium `client_error` unchanged | queued and sent |
| F — Chromium unchanged overall | all 46 events sent; absent and `true` flags behave identically |
| G — manifest declares no optional collection | `optional` undefined; the string `technicalAndInteraction` absent from the declaration; required list still the F6 four |
| H — nothing requests the permission | `data_collection` and `permissions.request` absent from both built bundles |
| I — classification and wiring cannot drift | every event has a category; the technical set is exactly three; the worker wires `collectTechnical: !IS_GECKO` in one place; the recorder consults `isTechnicalAndInteraction` |
| — | analytics source contains no `navigator.`, `userAgent`, `screen.` or `deviceMemory` |

One assertion was wrong on the first pass and is worth recording: it required the
string `technicalAndInteraction` to be absent from the Firefox bundle. It is
present — as the classification literal that does the suppressing. Asserting on
the word rather than on the permissions API would have failed for the one reason
that means everything is working.

## 16.6 Verification

| Check | Result |
| --- | --- |
| `npm test` | **2300 passed / 89 files** |
| `tsc -b --force` · `eslint .` | clean |
| `verify:firefox` · `verify:store` | pass |
| `verify:firefox:e2e` | **5/5 scenarios, 135s** |
| Seed fingerprints | `490abc069b69176b` / `230347d30f6355fa` — unchanged |

## 16.7 Artifacts — revision r2

The §9 candidate was built before this decision, so it is **superseded**. It was
never uploaded. Per the instruction to avoid ambiguity, the new artifacts are
revisioned rather than overwriting it, and `WATCHSIDE_AMO_REV` now labels a
pre-submission candidate.

| | File | SHA256 |
| --- | --- | --- |
| **Candidate (current)** | `releases/Watchside-AMO-Candidate-v0.6.0-r2.zip` | `5635e11472e8de3fe812fa0f099a58bd9605597274beb0a7bc16e61d60dd4d40` |
| **Source (current)** | `releases/Watchside-AMO-Source-v0.6.0-r2.zip` | `fe541412e05129e991c121a00c620814749f41fd20187ce4f215e10edf8ba1bb` |
| Candidate (r1, superseded) | `releases/Watchside-AMO-Candidate-v0.6.0.zip` | `6a2365fd…` — retained, do not upload |
| Source (r1, superseded) | `releases/Watchside-AMO-Source-v0.6.0.zip` | retained, do not upload |

**Upload r2.**

### Reproducibility, re-proved

Extracted clean, then following `REVIEWER-BUILD.md` literally:

```
unzip Watchside-AMO-Source-v0.6.0-r2.zip
cp .env.amo .env.local
npm ci
npm run package:firefox
```

| | |
| --- | --- |
| Rebuilt SHA256 | `5635e11472e8de3fe812fa0f099a58bd9605597274beb0a7bc16e61d60dd4d40` |
| r2 candidate SHA256 | `5635e11472e8de3fe812fa0f099a58bd9605597274beb0a7bc16e61d60dd4d40` |
| `diff -r` of unpacked contents | **empty** |

The README also names the r2 candidate and its hash, which the first build of it
did not — caught by reading the generated file rather than trusting the template.

### Validator

`web-ext lint` against the **extracted upload candidate** itself:

**0 errors, 0 notices, 3 warnings** — the same three as §9, unchanged by this
work and each still documented rather than suppressed:

| Warning | Verdict |
| --- | --- |
| `KEY_FIREFOX_ANDROID_UNSUPPORTED_BY_MIN_VERSION` ×1 | Describes a configuration that does not exist: omitting `gecko_android` makes the add-on desktop-only. |
| `UNSAFE_VAR_ASSIGNMENT` ×2 | Inside React's `dangerouslySetInnerHTML` branch, which Watchside never uses — asserted by test. |

`MISSING_DATA_COLLECTION_PERMISSIONS` remains resolved: the required declaration
is present and unchanged.

## 16.8 Privacy

`docs/PRIVACY.md` updated, and three claims were made more accurate rather than
merely added to:

1. **New section, "Technical and interaction data: Firefox collects none."** It
   says what is not collected, names the three signals, says they are dropped
   inside the extension and never queued or retried, and states plainly that
   **there is no consent prompt and no analytics switch** — because there is
   nothing to switch. It does not imply an opt-out exists.
2. **The feedback section corrected.** It previously said feedback attaches the
   browser name and version. It now says that happens on Chrome and that the
   field is omitted on Firefox.
3. **The device-information claim corrected.** A draft of this section said
   Watchside had never collected browser information on any browser. That was
   false — feedback did. It now reads: no device information on any browser, and
   no browser information on Firefox.

The 7TV wording was also made precise in the introduction, matching §6: the
request carries the channel name and nothing that identifies the user.

**The published page still needs republishing.** `scripts/build-privacy-page.mjs`
renders `docs/PRIVACY.md` and takes the output path as its first argument,
writing into the Pages site checkout — which is not this repository. There is no
credential or deployment mechanism here, and none was invented. It remains the
owner action in §12.6.

## 16.9 Chrome

**Untouched, and verified.**

- `releases/Watchside-Store-v0.6.0.zip` — `150e3c5b9319d3cc…`, unchanged.
- Chrome behaviour is byte-for-byte the same: `collectTechnical` defaults to
  collecting, and the Chromium build passes `!IS_GECKO === true`. Tests assert
  that an absent flag and `true` behave identically.
- No Chrome build, package, submission or publication.
- Extension ID, permissions, manifest `key`, OAuth scopes: unchanged.
- WS-F5-01 remains queued for the next coherent Chrome release.

## 16.10 Final F6 verdict

**READY TO SUBMIT.**

The candidate is validator-clean, its source archive provably rebuilds it byte
for byte, its data declaration is mapped from the code rather than asserted, and
the one open question from §5.3 is now closed in the direction that collects
less.

The privacy page is published and verified live (§17), so **nothing is
outstanding on our side**. Everything remaining on the §12 checklist is
owner-side AMO mechanics.

F7 and M3 remain unstarted. Nothing has been submitted to Mozilla.

---

# 17. Privacy page published (2026-08-29)

The last outstanding item in §12 is done. It was an ordinary commit and push to
an existing repository — no credential decision, no new mechanism, nothing
invented.

## 17.1 Where it went

| | |
| --- | --- |
| Pages repository | `Anoteros-Labs/anoteros-labs.github.io` |
| Local checkout | `c:/Users/sk8bo/Projects/anoteros-pages` — found by inspection, already cloned, on `main`, clean and in sync |
| Destination | `watchside/privacy/index.html` |
| Public URL | **https://anoteros-labs.github.io/watchside/privacy/** — unchanged |
| Commit | `64d170f` |
| Push | `f2881a4..64d170f  main -> main`, normal push |
| Diff | **one file, 22 insertions, 4 deletions.** No other Pages file touched. |

The same one-directory-per-page layout and the same ordinary-push workflow the
invite page used in `0.6.0-final-release-blockers-2026-08-28.md` §23.

## 17.2 How it was rendered

```
node scripts/build-privacy-page.mjs \
  <pages>/watchside/privacy/index.html ../../ "Anoteros Labs"
```

The two trailing arguments are **not** the script's defaults (`../` and
`Watchside`). They were read back out of the page already published — its back
link is `<a class="back" href="../../">← Anoteros Labs</a>` — rather than
guessed, and the resulting diff touching only content confirms they were right.
A wrong back-href would have shown up as structural churn.

## 17.3 A defect found by publishing

The generated diff showed one sentence twice:

> Watchside requests **no access to sites other than Twitch**, and cannot read
> any other page you visit.

Introduced in §16.8, when the new "What Firefox tells you at install" section
was inserted ahead of that closing line and a copy was left at the end of it.
The duplicate was removed from `docs/PRIVACY.md` and the page re-rendered. That
is a repair of an accidental duplication, not a change of substance: the
sentence still appears once, where it belongs, after the permissions list.

Worth recording because it is the argument for rendering rather than
transcribing — the defect was in the source and only became visible when the
output was diffed.

## 17.4 Fidelity check

The renderer handles exactly the constructs the policy uses and refuses others,
so its own comment calls for a word-level check by the caller. Run:

| | |
| --- | --- |
| Policy words | 2062 |
| Page words | 2499 |
| Missing from the page | **2** — `1.` and `2.` |

Both are ordered-list markers, which the renderer turns into a real `<ol>`, so
the digits become list numbering instead of literal text. Verified by reading
the generated `<ol>`. **No policy text was dropped.**

## 17.5 Verified on the live page

Fetched from the public URL after the Pages build completed. The first fetch
served the previous build (16,275 bytes) — the same behaviour recorded for the
invite page — and the next was current.

**The served bytes are identical to the pushed file** (`cmp`, 19,739 bytes).
Content confirmed on the live page:

| Requirement | Live |
| --- | --- |
| Firefox collects no technicalAndInteraction telemetry | yes — "Technical and interaction data: Firefox collects none" |
| Firefox sends no error reports | yes |
| No secondary consent prompt or toggle | yes — "no consent prompt and no analytics switch" |
| Firefox feedback omits browser information | yes |
| Device/browser claim accurate | yes — "no device information on any browser, and no browser information on Firefox" |
| Required data and product analytics disclosed | yes — the install-time table |
| 7TV receives the channel name | yes |
| Chrome still records the three diagnostics | yes |
| Duplicate sentence gone | 1 occurrence |
| Stale Kickback branding | **0 matches** |
| Title / back link | `Privacy Policy — Watchside` · `← Anoteros Labs` |

Sibling routes `/watchside/support/` and `/` returned 200 throughout.

## 17.6 What was not touched

Neither AMO artifact was rebuilt or modified:

- `releases/Watchside-AMO-Candidate-v0.6.0-r2.zip` — `5635e114…`
- `releases/Watchside-AMO-Source-v0.6.0-r2.zip` — `fe541412…`

`docs/` is not part of the source archive, so the `PRIVACY.md` repair does not
invalidate either one and neither needed regenerating.

Chrome untouched: no build, no submission, no publication.

## 17.7 Status

**There is no remaining pre-submission blocker.** Everything left in §12 is
owner-side AMO mechanics: developer account, channel choice, uploading the r2
pair, listing metadata, and the reviewer note. The privacy policy URL to give
AMO is `https://anoteros-labs.github.io/watchside/privacy/`.
