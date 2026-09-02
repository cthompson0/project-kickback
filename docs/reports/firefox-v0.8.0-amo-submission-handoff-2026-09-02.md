# Firefox v0.8.0 — AMO submission handoff

**Date:** 2026-09-02
**HEAD:** `629b8942e344595c44ac1a90a5810f7b4412e8d7` (`629b894`)
**Decision applied:** the Supabase custom-domain migration is **deferred**.
v0.8.0 ships against the existing project URL.
**Status:** artifacts built, verified, and **ready for owner submission**. Nothing
was uploaded.

---

## 1. The artifacts

| File | Bytes | SHA-256 |
| --- | --- | --- |
| `releases/Watchside-AMO-Candidate-v0.8.0.zip` | **186,466** | `ccb9a942178bf8df603c2646f7b7c7093ea486a572a9411b81df81fb26e5398e` |
| `releases/Watchside-AMO-Source-v0.8.0.zip` | **1,200,533** | `62fff42b97204b1b20604162dcad0ace2f3e99f3e25d3dd070cf9c705e0571c8` |

**The obsolete `acef1c34…` candidate no longer exists** — it was overwritten in
place by this build, so there is no way to submit it by accident. Its source
counterpart (`580f33ea…`) was replaced the same way.

**Chrome v0.8 was not touched.** `Watchside-Store-v0.8.0.zip` remains
`cb3af261448280cb33866a4b466fa186dd2bdc691db31e0116766e5ee15e19a0`, 186,424
bytes — byte-identical to what was submitted.

**Candidate contents — 8 files, 658,005 bytes unpacked:**

```
manifest.json            1,390     kickback-background.js  315,677
popup.html               1,818     kickback-content.js     333,437
icons/icon-16.png          438     icons/icon-48.png         1,264
icons/icon-32.png          803     icons/icon-128.png        3,178
```

---

## 2. The manifest surface

```json
"permissions":       ["identity", "storage", "alarms", "notifications"]
"host_permissions":  ["https://ezikxbbcwcxhkboeekkk.supabase.co/*",
                      "https://7tv.io/*"]
"content_scripts":   ["https://www.twitch.tv/*", "https://twitch.tv/*"]
```

| | |
| --- | --- |
| Install dialog will say | **4 domains** — `7tv.io`, `ezikxbbcwcxhkboeekkk.supabase.co`, `twitch.tv`, `www.twitch.tv` |
| Was, in 0.6.0 | 5 domains |
| Gecko id | `watchside@anoteros-labs.com` |
| `strict_min_version` | 140.0 |
| `data_collection_permissions` | `authenticationInfo`, `browsingActivity`, `personalCommunications`, `websiteActivity` — **no optional collection** |
| Chromium key | absent |
| Service worker | absent (event page) |
| `<all_urls>` / optional permissions / wildcards | none |

---

## 3. What was verified, and against what

**Everything below ran against `dist-firefox/package-amo` — the unpacked bytes
of the candidate above, not a development build.** That distinction turned out
to matter; §5.

| Check | Result |
| --- | --- |
| `npm run verify:firefox -- --amo` | **pass** — manifest derived exactly from `public/manifest.json`, 8 allow-listed files, no source maps, no secrets, Chromium key intact and absent from the Gecko build |
| `npx web-ext lint` | **0 errors**, 0 notices, **3 warnings** |
| `npm run verify:candidate` | **pass** — 13 M3D/M5A–M5D/compat markers present, 5 forbidden markers absent, version 0.8.0 |
| Full test suite | **3,091 passed / 127 files, 0 skipped** |
| Destruction mutations | **96 / 96 detected** |
| `npm run lint`, `npm run typecheck` (`tsc -b`) | clean |
| Reproducibility | **byte-identical** across two consecutive builds |

**The 3 web-ext warnings** are `UNSAFE_VAR_ASSIGNMENT` ×2 (innerHTML in the
shadow-DOM renderer) and `KEY_FIREFOX_ANDROID_UNSUPPORTED_BY_MIN_VERSION` ×1.
Both were present in 0.6.0, which Mozilla reviewed, signed, and is distributing
today. Documented in the F6 report rather than bought off.

### `cdn.7tv.app` (step 5)

Absent from `host_permissions` and from every field of `manifest.json`. The
emote URL is still *built* in `core/emotes.ts` and loaded by an `<img>` in the
content script's shadow DOM, which is governed by the page's CSP rather than by
extension host permissions — the control case being `static-cdn.jtvnw.net`,
never permitted, rendering fine in the signed 0.6.0.

### The backend (step 6)

| | |
| --- | --- |
| `https://ezikxbbcwcxhkboeekkk.supabase.co/*` | **granted**, and the background bundle talks to it |
| `api.watchside.app` | **not in the manifest, not in any packaged file** |

The build requires nothing that does not exist today. The deferred custom domain
is genuinely deferred, not half-applied.

### Reproducibility (what an AMO reviewer will do)

`REVIEWER-BUILD.md` tells reviewers to run `npm ci` then
`npm run package:firefox`. That produces `Watchside-Firefox-v0.8.0.zip` at
`ccb9a942178bf8df…` — **the same SHA-256 as the candidate being uploaded**
(`--amo` changes the filename and the console message, not the bytes). So the
instruction in the source archive actually reproduces the uploaded artifact,
which is checkable rather than asserted.

The source archive carries `REVIEWER-BUILD.md` and `.env.amo` (318 entries, no
`node_modules`, no `.env.local`, no `dist/`, no `.git/`, no E2E profiles). The
two values in `.env.amo` are the project URL and the **publishable** key — both
already compiled into the reviewed extension, both protected by row-level
security, and the file says so.

---

## 4. Two sweep hits that are not blockers

An automated sweep flagged `localhost`, `127.0.0.1`, `[::1]` and one
`http://localhost:9999` inside `kickback-background.js`. All of them are
**vendored `@supabase/supabase-js` internals** — gotrue-js's default endpoint
constant, a hostname-validity helper, and the library's own allowed-hosts list.

Rather than reason about whether that is acceptable, I checked it: every one of
those strings is **byte-for-byte present in `Watchside-AMO-Candidate-v0.6.0-r2.zip`,
the artifact Mozilla signed and is publicly distributing as Watchside 0.6.0.**

| String | in signed 0.6.0 | in new 0.8.0 |
| --- | --- | --- |
| `http://localhost:9999` | yes | yes |
| `127.0.0.1` | yes | yes |
| `[::1]` | yes | yes |
| `*.supabase.in` | yes | yes |

So the check was re-expressed as the question that actually matters — *did we
add one* — measured against that signed baseline. **Nothing new:** no Watchside
code introduces a loopback address, a dev port, or an `http://` endpoint, and
host permissions name only two hosts regardless.

---

## 5. What had to be fixed, and why it was necessary

Three defects, all the same shape: tooling that hardcoded `dist-firefox/package`
while `npm run package:amo` unpacks to `dist-firefox/package-amo`.

**1. `verify-firefox.mjs` could not see the AMO candidate.** Running it after an
AMO build printed a full PASS — about a *different* archive, built earlier, from
possibly different source. **The one artifact that gets uploaded to Mozilla was
the only one nothing could verify.** It now accepts `--amo`, `--beta` or
`--package=<dir>`, defaults exactly as before, and prints which package it read.

**2. `firefoxPackage.test.ts` crashed instead of skipping.** Its comment says the
artifact tests skip when `dist-firefox/` is absent so `npm test` never requires a
packaging run. `describe.runIf` decides whether the *tests* run, but the callback
body is evaluated during collection either way — so four `readFileSync` calls at
suite scope threw `ENOENT` in exactly the case the skip was written for. A fresh
clone could not run `npm test`.

**3. `firefoxTelemetryBoundary.test.ts` skipped silently** for the same reason,
and what it was declining to check was the AMO candidate's
`data_collection_permissions` — the declaration Mozilla reads most closely.

Both test files now find whichever package was built, so **the AMO candidate is
covered by the artifact tests for the first time**. Committed as `629b894`.

Also corrected: `verify-firefox` described a verified AMO candidate as "a
DEVELOPMENT package" and pointed the reader at a directory it was not built from.

**Nothing about the extension's behaviour, permissions or bytes changed.** The
candidate hash is identical before and after these fixes, because they touch
verification and tests only.

---

## 6. One thing to be aware of, not a blocker

**Every published Watchside client tags its analytics `private_beta`**, including
Chrome 0.7 (live), the submitted Chrome 0.8, and this Firefox build — all three
packagers hardcode `VITE_KICKBACK_ENV=private_beta`, and the verifiers require
it. So production traffic lands in the `private_beta` bucket of
`ops_health_v.environment`.

That is consistent across every artifact rather than a Firefox regression, and
changing it here would diverge Firefox from the already-submitted Chrome 0.8 and
split the environment column mid-flight. **Left alone deliberately** — it is a
product decision for a release where both stores move together, not a fix to
smuggle into a submission.

---

## 7. AMO submission checklist

Everything below is done except the upload itself.

1. **Upload** `releases/Watchside-AMO-Candidate-v0.8.0.zip`
   (`ccb9a942178bf8df…`, 186,466 bytes) as a new version of Watchside.
2. **Attach the source archive** `releases/Watchside-AMO-Source-v0.8.0.zip`
   (`62fff42b97204b1b…`, 1,200,533 bytes) — AMO requires it because the upload
   is a minified build. It contains `REVIEWER-BUILD.md` with the exact
   reproduction steps.
3. **Data collection:** declare the four required types already in the manifest
   (`authenticationInfo`, `browsingActivity`, `personalCommunications`,
   `websiteActivity`). None optional.
4. **Permissions note for the reviewer**, if the form invites one:

   > Watchside needs access to four things: **twitch.tv** and **www.twitch.tv**,
   > where it draws its panel; **7tv.io**, to show the same emotes you already
   > see in chat; and its own backend, which stores your friends list and
   > presence.

5. **Release notes:** the install dialog now names four domains instead of five —
   `cdn.7tv.app` was removed because nothing fetches it.
6. **Do not** submit anything under `acef1c34…`; that artifact no longer exists.

**Not done and not required for this submission:** the `api.watchside.app`
custom domain (deferred by owner decision), migration 0039, and the
`watchside.app` apex certificate. All three are tracked in
`docs/reports/api-watchside-firefox-v0.8-2026-09-02.md`.
