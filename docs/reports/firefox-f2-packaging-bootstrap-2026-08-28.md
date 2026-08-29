# Firefox F2 — real package and Mozilla validation

**Date:** 2026-08-28
**Milestone:** F2 of the plan in
`docs/reports/firefox-prepublic-compatibility-2026-08-28.md` §20, following
`docs/reports/firefox-f1-cross-browser-foundation-2026-08-28.md`
**Scope:** packaging and first real-browser bootstrap. No M3, no product
behaviour change, no hosted change, no OAuth configuration change, no Twitch
console change, no Chrome modification.

---

## 1. Executive result

**Firefox accepted Watchside.** The Gecko package built from the same source as
Chromium, passed Mozilla's own validator with **0 errors**, installed into a
real Firefox 154.0.1, started its background context, injected on twitch.tv,
rendered the panel, opened a port, and read and wrote storage through the Gecko
adapter — none of which had ever executed in a real browser before today.

The critical output, obtained from the running add-on rather than derived:

```
browser.identity.getRedirectURL()
  -> https://5af6f5498bb0be3a64c0567c9ef1c8ebebc7a1e3.extensions.allizom.org/
```

Identical across three independent Firefox launches with fresh profiles.

Two things were found that the investigation did not predict, both recorded in
full below: Mozilla now requires a `data_collection_permissions` declaration for
new extensions (a warning today, an AMO blocker at F6), and our ZIP writer was
**not reproducible** — measured, isolated to the container timestamp, and fixed
for the Firefox path.

No stop condition was triggered.

---

## 2. Files changed

### New

| File | What it is |
| --- | --- |
| `scripts/package-shared.mjs` | The safety net both packagers now share |
| `scripts/package-shared.d.mts` | Types for it |
| `scripts/package-firefox.mjs` | The Firefox packager |
| `scripts/verify-firefox.mjs` | The Firefox gate |
| `scripts/extension-identity.d.mts` | Types, so the test is not `any` |
| `tests/extension/firefoxPackage.test.ts` | 25 tests |

### Modified

| File | Change |
| --- | --- |
| `scripts/package-beta.mjs` | 158 lines of duplicated machinery deleted; imports the shared module |
| `vite.config.ts`, `vite.background.config.ts` | `WATCHSIDE_OUT_DIR`, defaulting to `dist` |
| `package.json` | three scripts; `web-ext` as a **dev**-only dependency |
| `.gitignore` | `dist-firefox` |

**Unchanged:** `public/manifest.json`, every file under `src/`, every file under
`supabase/`, and both submitted Chromium artifacts.

---

## 3. Packaging architecture

```
public/manifest.json  ── the one canonical manifest, still a Chromium manifest
   │
   ├─ (copied verbatim)                    ─► dist/          ─► Chrome packages
   └─ manifestFor('gecko')                 ─► dist-firefox/  ─► Firefox packages
```

`package-firefox.mjs` is a **sibling** of `package-beta.mjs`, not a second
pipeline. The allow-list, forbidden paths, secret patterns and demo markers now
live once, in `package-shared.mjs`, and both import them — so a Firefox package
cannot be laxer than a Chrome one about what it lets through. A test asserts
neither packager keeps a private copy.

Two decisions worth recording:

**Why a separate file rather than a `--firefox` mode.** `package-beta.mjs` is
the path that builds the artifact currently in Chrome Web Store review, and it
is bound to Chromium's identity model — it refuses to package unless the
manifest key hashes to the permanent extension ID. Firefox has no key. Bolting a
third mode onto that control flow would have meant threading "unless Firefox"
through the one script that must not change behaviour this week.

**Why `dist-firefox/`.** Firefox needs bundles built with
`WATCHSIDE_BROWSER=gecko`. Building those into `dist/` would replace the
Chromium output the Store package is made from. Separate directories mean both
can exist and neither can be mistaken for the other. `WATCHSIDE_OUT_DIR`
defaults to `dist`, so a build with no flags is still the shipping product.

Commands: `npm run package:firefox`, `npm run package:firefox-beta`,
`npm run verify:firefox`.

---

## 4. Firefox manifest output

Derived, never hand-maintained. **Exactly three keys** differ from Chromium's,
and `verify:firefox` re-derives the manifest and refuses anything else:

```json
{
  "manifest_version": 3,
  "name": "Watchside",
  "version": "0.6.0",
  "background": { "scripts": ["kickback-background.js"] },
  "permissions": ["identity", "storage", "alarms", "notifications"],
  "host_permissions": [
    "https://*.supabase.co/*", "https://7tv.io/*", "https://cdn.7tv.app/*"
  ],
  "browser_specific_settings": {
    "gecko": { "id": "watchside@anoteros-labs.com", "strict_min_version": "128.0" }
  }
}
```

`key` absent. `background.service_worker` absent. Name, version, description,
icons, action and content scripts identical to Chromium. **No permission Chrome
does not also ask for**, and no optional permissions.

---

## 5. verify:firefox

A deterministic gate over the **unpacked package on disk** — the same bytes the
archive holds — rather than over the source tree, because checking the source
would prove the transform is right and say nothing about what was produced.

Manifest (version, name, version match, gecko id, `strict_min_version`, no
Chromium key, no service worker, event page shape, and that it is *exactly*
`manifestFor('gecko', public/manifest.json)`); capabilities (permissions, host
permissions, content scripts all equal to Chromium's, no optional permissions);
contents (allow-list, forbidden paths, all four icons); engine (all six
`browser.*` namespaces reached, **no `chrome.*` in either bundle**, no
background-only API in the content script, `private_beta` label); leaks (no
source maps, no secret keys, no JWT literals); and Chromium (canonical manifest
still has its key, still declares a service worker, still has no Gecko
settings).

All pass. It deliberately says nothing about Mozilla's rules — that is
`web-ext lint`, kept separate so a validator warning and a Watchside invariant
are never confused.

---

## 6. web-ext and Mozilla validation

Current Mozilla documentation confirms the investigation's conclusion: `web-ext
lint` runs **addons-linter**, the same validator AMO uses, and it checks
manifest keys and APIs against the declared `strict_min_version`. Added as a
**dev-only** dependency (`web-ext@^10.6.0`); `dependencies` remains
`@supabase/supabase-js`, `react`, `react-dom`.

`web-ext build` was **not** adopted — our own packager gives an allow-list, a
secret scan, a Gecko-engine check and now reproducible output. `web-ext` is used
for validation and for `run`, which is what installed the add-on into a real
Firefox.

```
npx web-ext lint --source-dir dist-firefox/package
summary: { errors: 0, notices: 0, warnings: 3 }
```

Same result for the beta package.

---

## 7. Validator warnings, in full

Nothing suppressed. Three warnings, two of them the same finding.

### 7.1 `MISSING_DATA_COLLECTION_PERMISSIONS` — manifest.json

> The `"data_collection_permissions"` property is missing. […] required for all
> new Firefox extensions, and will be required for new versions of existing
> extensions in the future.

**Classification: MUST FIX BEFORE AMO (F6).** Not before F3.

**This is new since the investigation and worth flagging as such.** From
**3 November 2025**, all new extensions must adopt Firefox's built-in data
collection consent system. The key is
`browser_specific_settings.gecko.data_collection_permissions`, with `required`
and `optional` arrays drawn from a fixed vocabulary
(`personallyIdentifyingInfo`, `healthInfo`, `financialAndPaymentInfo`,
`authenticationInfo`, `personalCommunications`, `locationInfo`,
`browsingActivity`, `websiteContent`, `websiteActivity`, `searchTerms`,
`bookmarksInfo`, `technicalAndInteraction` — optional only — and `none`).

**Deliberately not added in F2**, for a reason that is not laziness: these values
are shown to the user in the install prompt and constitute a **public privacy
declaration**. Declaring the wrong set is worse than declaring none yet, and the
right set is a product and legal decision that should agree with
`docs/PRIVACY.md` rather than be guessed by a packaging script. A first reading
of what Watchside actually does suggests `required` would include
`authenticationInfo` (a Twitch-derived session), `websiteActivity` (which Twitch
channel you are on, transmitted to our backend) and `personalCommunications`
(friend and room chat), with `technicalAndInteraction` optional. **Owner
decision, tracked as O4 below.**

### 7.2 `UNSAFE_VAR_ASSIGNMENT` ×2 — kickback-content.js:9

> Unsafe assignment to innerHTML

**Classification: harmless / tooling — a library false positive.** Evidence:

- `grep -rn "innerHTML" src/` returns **nothing**. We never write it.
- `grep -rn "dangerouslySetInnerHTML" src/` returns **nothing**. We never pass it.
- The flagged text is inside bundled **react-dom 19.2.8**, in the branch that
  implements `dangerouslySetInnerHTML` — code that only runs if a component
  passes that prop, which none of ours does.

Not fixed, because fixing it would mean patching a third-party library to
silence a warning about a code path our application cannot reach. Recorded here
so that when an AMO reviewer asks, the answer already exists with its evidence.

---

## 8. Firefox artifacts

| Artifact | Purpose |
| --- | --- |
| `releases/Watchside-Firefox-v0.6.0.zip` | the AMO-shaped candidate |
| `releases/Watchside-Firefox-Beta-v0.6.0.zip` | the same, plus `README-TESTERS.txt` |

Both flat — `manifest.json` at the archive root — because every Firefox install
path (about:debugging, web-ext, AMO) expects it there, unlike Chrome's "Load
unpacked", which wants a folder. The bundles in the two are identical; only the
README differs.

**These are DEVELOPMENT artifacts.** Unsigned, no AMO source package, and
sign-in does not work until the redirect URL is registered. The README says so
in the archive itself, so a human who installs it cannot mistake a known
limitation for a bug.

## 9. SHA256

```
5bd08982e9dced4a97324c48efcd90ffad685f3fc196528e4e086a840f8f35d8  Watchside-Firefox-v0.6.0.zip
05ba1702c12b1ecba3bdbf3bd4dba40ef27ca778a0a700a5772681b85c7bd28f  Watchside-Firefox-Beta-v0.6.0.zip
```

### A reproducibility defect, found and fixed

The first two builds of **identical source** produced **different archives**
(`be627746…` then `5755bb9b…`). Rather than record the second hash and move on,
it was isolated: every packaged **file** was byte-identical across builds, and
only the ZIP container differed. `writeZip` defaults its entry timestamps to the
wall clock.

`package-firefox.mjs` now pins them to a fixed DOS-epoch date built from local
components, so the numbers read the same in every timezone. Two consecutive
builds now produce byte-identical archives — verified with `cmp`.

This matters beyond tidiness: AMO requires a source-code submission for minified
extensions precisely so a reviewer can rebuild and compare, and "same source in,
same bytes out" has to be literally true for that to mean anything.

**The Chromium packager was left on its wall-clock default**, so nothing about
the artifact in review changed. A test pins that.

---

## 10. Real Firefox version

**Mozilla Firefox 154.0.1**, at `C:\Program Files\Mozilla Firefox\firefox.exe`,
already installed. No software was installed.

## 11. Installation method

`web-ext run --source-dir … --firefox … --start-url … --no-reload --no-input`,
which installs the add-on over Firefox's remote debugging protocol:

```
Installed …\probe-pkg as a temporary add-on
```

**Firefox accepted the MV3 manifest** — the event-page background, the
`browser_specific_settings`, the permissions and the content-script matches — on
first attempt, with no manifest error and no permission prompt failure.

### How the evidence was captured, honestly

`web-ext run` does not relay extension console output, so a scratch copy of the
**real generated package** was made in a temp directory with two development
probes added: one background script and one content script, plus a
`http://127.0.0.1:8787/*` host permission so they could report to a local
collector. (A first attempt had the page probe `fetch` directly; Twitch's CSP
blocks that, so it reports through the background instead.)

**The product was not modified.** The probes live only in a scratch copy; the
repository, the packages and the archives are untouched. Everything reported
below came from the real Watchside bundles running beside the probes in the same
event page.

---

## 12. Gecko adapter execution

Verbatim from the collector:

```json
{"runtimeId":"watchside@anoteros-labs.com",
 "redirectURL":"https://5af6f5498bb0be3a64c0567c9ef1c8ebebc7a1e3.extensions.allizom.org/",
 "storageReturnsPromise":true,
 "storageRoundTrip":"ok",
 "portConnected":"kickback",
 "portMessages":["hello","activity","activity","activity","exposure","exposure","exposure","activity","exposure"],
 "realExtensionKeys":["kickback:analytics:session","kickback:attention:seen",
                      "kickback:channelMetadata","kickback:channelNames"]}
```

- **`runtimeId` is our fixed Gecko id** — a temporary add-on honours
  `browser_specific_settings.gecko.id`.
- **`storageReturnsPromise: true`** — the premise the whole adapter rests on,
  confirmed against a real Gecko rather than a fake.
- **`realExtensionKeys`** is the decisive line. Those keys were written by the
  **real background bundle**, not the probe, through the Gecko adapter — so
  `ext.storage` executed, in the product, in Firefox, with the `kickback:*`
  vocabulary intact.
- No `identityError`, no `storageError`, no `windowError`, no
  `unhandledRejection` in any report across three runs.

## 13. Content script and panel

From the page-side probe on `twitch.tv/lirik`:

```json
{"page":"www.twitch.tv/lirik","hostElement":true,"shadowRoot":true,
 "panelRendered":true,"wordmarkText":"watchside","markSvg":true,"styleTags":1,
 "panelText":"watchsideYou're watchingLIRIKWatchsideSee who's around.Continue with TwitchWatchsidev0.6.0"}
```

Every part of the rendering path worked: the host element was created, the
shadow root attached, the inlined stylesheet reached it (`styleTags: 1`), the
panel rendered, the **W mark** drew in the header, the wordmark read
**watchside**, and the version read **v0.6.0**.

`panelText` also shows **`You're watching LIRIK`** — Twitch channel detection
worked, meaning `platforms/twitch/` ran correctly under Gecko. The signed-out
state rendered exactly as designed.

## 14. Runtime messaging and storage

`portConnected: "kickback"` — the content script opened the long-lived port to
the background, and `portMessages` shows the real protocol flowing: `hello`,
then `activity` (the tab reporting which channel it is showing), then
`exposure`. The messaging architecture that Chromium's presence model depends on
works unchanged on Gecko.

Storage: a probe round-trip returned `ok`, and separately the real extension's
own keys appeared, as above.

---

## 15. `browser.identity.getRedirectURL()`

```
https://5af6f5498bb0be3a64c0567c9ef1c8ebebc7a1e3.extensions.allizom.org/
```

Read from the running add-on under the fixed Gecko id. **Not derived, not
guessed, not a wildcard.** This is the value the owner registers with Supabase
in F3.

## 16. Redirect stability

Identical in **all 16 reports across 3 independent runs**, each a separate
Firefox process with a fresh temporary profile and a fresh temporary install:

| Run | Start URL | Redirect URL |
| --- | --- | --- |
| 1 | twitch.tv | `https://5af6f549…allizom.org/` |
| 2 | twitch.tv/lirik | `https://5af6f549…allizom.org/` |
| 3 | twitch.tv/lirik | `https://5af6f549…allizom.org/` |

It also stayed constant across content-script reconnects within a run (visible
as a second `hello` in `portMessages`).

**Conclusion: the redirect URL is a deterministic function of the add-on ID**,
not of the install or the profile — which is exactly the property that makes
registering one value with Supabase workable. No stop condition.

The remaining caveat, stated plainly: this was measured on temporary installs.
An AMO-signed install carries the same ID, so the same hash should follow, but
that is inference and will be re-verified at F6.

---

## 17. Chromium non-regression

No Chromium artifact was rebuilt, replaced or overwritten. `package:beta` and
`package:store` were **not run** — deliberately, since both would have rewritten
the ZIPs currently in review.

| Check | Result |
| --- | --- |
| `releases/Watchside-Store-v0.6.0.zip` | `150e3c5b…b7a818d3d` — unchanged |
| `releases/Watchside-Private-Beta-v0.6.0.zip` | `c1217ff5…6067203e` — unchanged |
| `dist/` still the Chromium build | `chrome.*` present, `browser.*` absent |
| Submitted manifest vs current `dist/manifest.json` | **identical**, key aside |
| permissions / host permissions / background | identical |
| `public/manifest.json` | untouched: has `key`, declares `service_worker`, no Gecko settings |
| `verify:store` | pass, ID `ngfopkeokddfnncdhfkhnffilbdhkkip` |
| Chromium packager timestamps | still wall-clock; only the Firefox path was pinned |

`package-beta.mjs` did change — 158 lines of duplicated safety machinery were
deleted in favour of the shared module. The constants and functions moved
verbatim; a test asserts the allow-list, forbidden paths, secret patterns and
demo markers are still exactly what they were, and the manifest comparison above
shows the output it produces is unchanged.

## Tests and gates

| Gate | Result |
| --- | --- |
| `tsc -b --force` | clean |
| `eslint .` | clean |
| focused F2 tests | 25 passed |
| F1 adapter tests | 61 passed |
| `npm test` | **2250 passed / 85 files, 0 failed** (was 2223 / 84) |
| `verify:firefox` | pass |
| `web-ext lint` | 0 errors, 3 warnings (§7) |
| `verify:store` | pass |
| `verify:config` | pass |
| `verify:groups` | pass |
| `verify:lab` | not run — known debt, excluded by instruction |
| `test:authz` | not run — mutation harness, excluded by instruction |

---

## 18. What F2 proves

1. Firefox **accepts** our MV3 structure — event page, gecko settings,
   permissions, content scripts — with no manifest error.
2. Mozilla's own validator reports **zero errors**.
3. The background context **starts** and runs the real product code.
4. The content script **injects** on twitch.tv and the **panel renders**, with
   the correct brand, mark, version and channel detection.
5. **Runtime messaging works**: the port opens and the real protocol flows.
6. **Storage works through the Gecko adapter**, promise-shaped, with the
   `kickback:*` keys intact — written by the product, not the probe.
7. **No immediate manifest or API exception** anywhere across three runs.
8. The **redirect URL is known and stable**.
9. Packaging is **reproducible**.
10. **Chrome is untouched.**

## 19. What remains unproven

- **Sign-in.** Not attempted, by instruction. The redirect is not registered.
- **Everything behind an account**: friends, presence, Gravity, JOIN, Stream
  Rooms, badges, invites. The panel rendered its signed-out state, and that is
  all that was exercised.
- **Notifications on Gecko.** The button strip is unit-tested; no notification
  was created in a real Firefox.
- **Panel anchoring against Twitch's layout** — it rendered, but nobody has
  looked at *where*. Still class F.
- **Page-origin `localStorage` under strict ETP.** Untested.
- **Host-permission revocation behaviour.** Untested.
- **Background suspend/resume.** Firefox keeps the event page alive while a port
  is open, which is what happened here; the recovery path never fired.
- **AMO acceptance.** Unsigned, no source package, and the data-collection
  declaration is missing.

## 20. Exact F3 owner action

**O-F3.** In the Supabase dashboard → **Authentication → URL Configuration →
Redirect URLs**, add exactly:

```
https://5af6f5498bb0be3a64c0567c9ef1c8ebebc7a1e3.extensions.allizom.org/
```

Exact URL, **not** a wildcard — `https://*.extensions.allizom.org/` would make
any Firefox extension's redirect a valid destination for our auth flow.
Additive: the existing `chromiumapp.org` entry stays and Chrome is unaffected.

No Twitch console change. No scope change. No migration.

### Also queued, not blocking F3

- **O4.** Decide `data_collection_permissions` (§7.1) — a public privacy
  declaration; needs to agree with `docs/PRIVACY.md`. Required before AMO.
- **O5.** Decide the `https://*.supabase.co/*` wildcard host permission, carried
  over from the investigation. Affects the Chrome listing too.

---

## 21. Commits and push

1. `feat: Watchside packages for Firefox` — shared packaging module, the Firefox
   packager, the gate, the build wiring, `web-ext`, and the tests.
2. `docs: record the Firefox F2 packaging bootstrap` — this report.

Pushed to `origin/main`.

## 22. Git status

- Branch `main`, tracking `origin/main`, pushed.
- `dist-firefox/` is gitignored; `releases/` was already.
- Chromium extension ID: `ngfopkeokddfnncdhfkhnffilbdhkkip` — unchanged.
- Hosted schema: 28 — untouched.
- Chrome Web Store: submitted v0.6.0, untouched.
- Firefox: F2 complete. **Not supported yet** — no sign-in, no AMO listing.
