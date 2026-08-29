# Firefox F1 — cross-browser foundation

**Date:** 2026-08-28
**Milestone:** F1 of the plan in
`docs/reports/firefox-prepublic-compatibility-2026-08-28.md` §20
**Scope:** architecture only. No feature behaviour, no auth configuration, no
hosted change, no Chrome Web Store change, no M3 work.
**Chromium extension ID:** `ngfopkeokddfnncdhfkhnffilbdhkkip` — unchanged.

---

## 1. Implementation summary

F1 removes the product's direct dependence on `chrome.*` at the six seams the
investigation identified, and adds the manifest-generation architecture Firefox
will need — while leaving Chromium behaviour exactly where it was.

Four product files changed. **Two of them are the composition root and the
client port**, which is what the investigation predicted: everything below them
already took its browser capabilities as an injected interface, so nothing
below them had to move.

```
 src/background/index.ts   | 56 +++++-------------------------
 src/client/port.ts        |  6 ++--
 vite.background.config.ts |  8 +++-
 vite.config.ts            | 17 +++++++-
 4 files changed, 50 insertions(+), 37 deletions(-)
```

`src/background/index.ts` came out **20 lines shorter**: six inline API blocks
became six delegations.

Nothing under `src/core/`, `src/ui/`, `src/platforms/twitch/`, or any
`src/background/*` service was touched. **`src/background/auth.ts`,
`notifier.ts`, `storage.ts`, `presence.ts` and `preferences.ts` did not change
by a single character** — they already spoke through `AuthDeps`, `NotifierDeps`,
`AsyncStorageArea` and friends.

**There are zero `chrome.*` or `browser.*` references anywhere in `src/` outside
`src/platforms/browser/`.** Verified, comments excluded.

---

## 2. Files changed

### New

| File | Lines | What it is |
| --- | --- | --- |
| `src/platforms/browser/types.ts` | 167 | The interface — our vocabulary, not a vendor's |
| `src/platforms/browser/chromium.ts` | 101 | Faithful `chrome.*` passthrough |
| `src/platforms/browser/gecko.ts` | 155 | `browser.*`, plus the notification-button strip |
| `src/platforms/browser/index.ts` | 86 | Picks the adapter at build time |
| `scripts/manifest.mjs` | 101 | `manifestFor(target, source)` |
| `scripts/manifest.d.mts` | 20 | Types for the above, so the test is not `any` |
| `tests/extension/browserAdapter.test.ts` | 601 | 61 tests at the boundary |

### Modified

| File | Change |
| --- | --- |
| `src/background/index.ts` | six seams delegate to `ext`; two `chrome.runtime.Port` type positions became `ExtensionPort` |
| `src/client/port.ts` | `runtime.connect(PORT_NAME)`; port type |
| `vite.config.ts` | build-time `browserTarget` → `import.meta.env.VITE_WATCHSIDE_BROWSER` |
| `vite.background.config.ts` | same |

### Deliberately NOT changed

`public/manifest.json`, `package.json`, `releases/**`, every file under
`supabase/`, and every existing product test.

---

## 3. Adapter API

`BrowserExtensionApi` is narrow to what Watchside actually calls — six
namespaces, seventeen members. It is not a general-purpose WebExtension
wrapper; a bigger surface would be a bigger thing to keep true across two
engines for no gain. Ordinary web APIs (DOM, `fetch`, `MutationObserver`,
`localStorage`) are **not** abstracted: they are standardised, and wrapping them
would be noise.

```ts
storage        get / set / remove                      → Promise
identity       getRedirectURL / launchWebAuthFlow
notifications  create / clear / onClicked / onButtonClicked
runtime        getURL / connect / onConnect / onStartup / onInstalled
alarms         create / onAlarm
tabs           create
```

Two design decisions worth recording:

**`ExtensionPort` is structural, not a wrapper.** Both engines' port objects
satisfy the shape exactly, so the adapter hands back the *real* port. That
matters more than it looks: the background keeps a `Set` of ports and a
`WeakMap` keyed on them, using the port's own identity as the tab key — which
is how Watchside tracks tabs without the `tabs` permission. A wrapper would put
a new object between that invariant and the truth. Two tests pin it.

**`onAlarm` passes the name, not the alarm.** Nothing in Watchside reads
anything else off an alarm, so the narrower thing crosses the boundary.

---

## 4. Chromium implementation

A faithful passthrough and nothing more. Every call is the call the composition
root used to make inline — same API, same arguments, same semantics, same
order — relocated and otherwise untouched. Notification `buttons` pass straight
through; the Gecko adapter's decision to drop them does not leak back.

The one piece of logic is the `if (!redirectedTo) throw` guard, which was
already there inline: Chromium resolves with `undefined` when the user closes
the sign-in window rather than rejecting, so "cancelled" becomes a rejection
once, at the boundary, instead of at every call site.

---

## 5. Gecko implementation

Reads `browser.*`, and that is the whole reason the adapter is not optional.
Firefox exposes both namespaces, but only `browser.*` is promise-shaped; the
compatibility `chrome.*` alias is callback-shaped, so `await
chrome.storage.local.get(key)` yields `undefined` rather than the stored value —
no throw, no warning, nothing a unit test would see.

The `browser` global is declared as the narrow set of members this file
touches, not `any`, so a typo is still a compile error. It is the only untyped
global bridge in the codebase and it is confined to that one file.

**Notification buttons are stripped at the boundary.** Firefox supports only
`type`, `title`, `message`, `iconUrl` — and it does not *ignore* the extras;
passing `buttons` fails schema validation and the whole notification is lost.
`forGecko()` therefore builds the payload by **naming the four survivors** rather
than deleting the extras, so a field added to the options type later cannot
reach Firefox by being forgotten about.

Per the investigation, this costs nothing: `notifier.ts` wires the button and
the notification body to the identical `open()`, so a Firefox user clicking the
notification lands exactly where a Chromium user clicking "Join them" lands.
**`notifier.ts` — where the product decisions live — did not change.**
`onButtonClicked` accepts a handler and never calls it, keeping the contract
total so no caller has to know which engine it is on.

---

## 6. Manifest architecture

`public/manifest.json` stays the single source of truth and stays a **Chromium**
manifest, byte-for-byte, because it is the file Vite copies into `dist/` and
therefore the file that ships to the Chrome Web Store. **`manifestFor` is not
invoked during a Chromium build at all** — `manifestFor('chromium', …)` exists
so a test can assert the transform leaves it alone.

A second checked-in Firefox manifest was the obvious alternative and is the
wrong one: two files that must agree about permissions, version, icons and
content-script matches will eventually disagree, and the disagreement would be
found by a user rather than by us.

`manifestFor('gecko', …)` changes **exactly three keys**, and a test enumerates
every other key to prove nothing else moved:

| Key | Change | Why |
| --- | --- | --- |
| `key` | removed | The Chromium identity means nothing to Gecko and has no business in a package uploaded elsewhere |
| `background` | `{ service_worker }` → `{ scripts }` | Firefox runs an event page; `service_worker` is not implemented. Dropped rather than kept alongside, so `web-ext lint` never warns about a key Gecko ignores |
| `browser_specific_settings` | added | `gecko.id` = `watchside@anoteros-labs.com`, `strict_min_version` = `128.0` |

`128.0` is an ESR and sits above Firefox 127 — the release where MV3 host
permissions in `host_permissions` *and* `content_scripts` began being granted at
install rather than needing a separate opt-in. Below that line a Twitch overlay
would install and then quietly do nothing.

The background **script itself is unchanged**. Watchside's restart recovery is
triggered by *reconnection*, so it stays correct on an engine that suspends
differently and simply never fires on one that does not suspend. No lifecycle
branch was added, exactly as the investigation recommended.

---

## 7. Chrome invariants

Every one re-verified on the F1 tree:

| Invariant | Result |
| --- | --- |
| Extension ID | `ngfopkeokddfnncdhfkhnffilbdhkkip` — unchanged |
| `manifest.json` in `dist/` | **byte-identical** to pre-F1 |
| Permissions | `identity, storage, alarms, notifications` — unchanged, pinned by test |
| Host permissions | the same three — unchanged, pinned by test |
| OAuth | no scopes requested before or after; same PKCE flow, same `redirectTo`, same `skipBrowserRedirect` |
| Notification buttons | preserved on Chromium, pinned by test |
| Background restart recovery | untouched |
| `kickback:*` storage keys | untouched, pinned by test |
| Version | 0.6.0 |
| `popup.html`, all four icons | **byte-identical** to pre-F1 |

---

## 8. Byte-equivalence result

A pre-F1 `dist/` was captured before any edit and compared against a fresh
post-F1 build.

| Artefact | Result |
| --- | --- |
| `manifest.json` | **IDENTICAL** |
| `popup.html` | **IDENTICAL** |
| `icons/icon-16.png` | **IDENTICAL** |
| `icons/icon-32.png` | **IDENTICAL** |
| `icons/icon-48.png` | **IDENTICAL** |
| `icons/icon-128.png` | **IDENTICAL** |
| `kickback-content.js` | differs, +234 bytes (319,485 → 319,719) |
| `kickback-background.js` | differs, +527 bytes (300,325 → 300,852) |

### Why the two JS bundles cannot be byte-identical

Because a module was added and six inline call sites became delegations through
it. Rollup emits different — and differently minified — output for
`chrome.storage.local.get(k)` written inline versus reached through an exported
const. There is no way to add an indirection layer and produce identical bytes,
and the only way to get the hash to match would be to not do the refactor. It
was not gamed.

**+761 bytes total, 0.12% of the shipped JavaScript.**

### Semantic equivalence, proved instead

**The `chrome.*` API surface of the built bundles was diffed against the
baseline.** Every call the pre-F1 background made, the post-F1 background still
makes. The only additions are inert members of the `chrome.runtime` object
literal — a namespace both bundles already used:

- background gained `chrome.runtime.connect` (used by the content script);
- content gained `getURL`, `onConnect`, `onStartup`, `onInstalled`.

These are property-level, not namespace-level, and cost the ~761 bytes above.

**Namespace-level, which is the claim that matters:**

| Bundle | `storage` | `identity` | `notifications` | `alarms` | `tabs` |
| --- | --- | --- | --- | --- | --- |
| content, pre-F1 | absent | absent | absent | absent | absent |
| content, post-F1 | **absent** | **absent** | **absent** | **absent** | **absent** |
| background, both | present | present | present | present | present |

This was not free. A first cut exported one `ext` object, and because bundlers
cannot tree-shake individual properties off an object, the **content script
picked up `chrome.identity`, `chrome.notifications`, `chrome.alarms`,
`chrome.tabs` and `chrome.storage`** — inert, but code a reviewer would
reasonably ask about and code that has no business being there. The adapter was
restructured to export one const per namespace so each bundle carries only what
it calls. The table above is the post-fix state, asserted against the real built
output by four tests.

**Neither Chromium bundle contains any Gecko adapter**: zero matches for
`browser.(storage|identity|notifications|alarms|tabs|runtime).`.

**The fold works in both directions.** A Gecko background bundle was built to a
temporary directory and inspected: all six namespaces resolve to `browser.*` and
**none** to `chrome.*`. `dist/` was then rebuilt for Chromium and re-verified.

Plus: all 2,223 tests pass, `manifest.json` is byte-identical, permissions and
host permissions are pinned, and the extension ID resolves unchanged.

---

## 9. Tests

`tests/extension/browserAdapter.test.ts` — **61 tests**, in four parts.

**The shared contract** runs against *both* adapters via `describe.each`, so a
member added to one engine and forgotten on the other fails here rather than
surprising someone in a browser: namespace completeness, storage delegation,
storage returning a real promise, `kickback:*` keys passed verbatim, identity
delegation, the closed-window rejection, runtime delegation, port identity
(twice), alarm delegation and name-only forwarding, tab opening, and
notification create/clear/click.

**Where the engines diverge** — deliberately short: buttons kept on Chromium,
stripped on Gecko, Gecko receiving *only* the four supported fields, Gecko never
delivering a button click, Chromium registering a real one, and each adapter
touching only its own global.

**The manifest transform** — Chromium returned unchanged, source not mutated,
Chromium key preserved, service worker preserved, no Gecko settings added;
permissions and host permissions pinned on both targets; and for Gecko, the key
dropped, event page substituted, same background script, gecko id and
`strict_min_version` pinned, still MV3, name/version/icons/action identical, and
an enumeration proving **nothing else changed**.

**The built artefact** — four tests reading `dist/` directly, because "neither
bundle ships the other engine's adapter" is a claim about what the bundler did,
not about what the source says.

### The tests were verified to bite

Five mutations, each reverted immediately:

| Mutation | Caught by |
| --- | --- |
| Gecko stops stripping buttons | 2 tests |
| Transform forgets to drop the Chromium `key` | 1 test |
| Transform leaves `service_worker` in the Gecko manifest | 2 tests |
| Chromium adapter reads `browser.*` | 3 tests |
| Gecko id silently changes | 1 test |

Every mutation failed the suite. A test that has never been seen to fail is not
evidence.

**No existing product test was modified.**

---

## 10. Verification

| Gate | Result |
| --- | --- |
| `tsc -b --force` | clean |
| `eslint .` | clean |
| `npm run build` | clean |
| `npm test` | **2223 passed / 84 files, 0 failed** (was 2162 / 83) |
| `npm run verify:store` | pass — ID `ngfopkeokddfnncdhfkhnffilbdhkkip`, name `Watchside`, all icons |
| `npm run verify:config` | pass |
| `npm run verify:groups` | pass |
| `npm run verify:analytics` | **not run** — F1 touched no analytics code, and it is a mutation harness that rewrites repo files in place |
| `npm run verify:lab` | **not run** — known pre-existing debt, excluded by instruction |
| `npm run test:authz` | **not run** — mutation harness, excluded by instruction |

---

## 11. What Firefox can now do

- A Gecko adapter exists, compiles, and is covered by the same contract tests as
  Chromium.
- A Gecko bundle **builds** (`WATCHSIDE_BROWSER=gecko`) and provably reads
  `browser.*` throughout.
- A Firefox MV3 manifest can be **derived** from the canonical source, with the
  gecko id, `strict_min_version`, event-page background and no Chromium key.
- Firefox notifications will not be rejected for carrying an unsupported field.
- The permanent Firefox add-on id is fixed and test-pinned, so the OAuth
  redirect URL derived from it cannot move by accident.

## 12. What Firefox still CANNOT do

To be unambiguous: **Firefox is not supported.** F1 is a foundation, not a port.

- **No Firefox package.** No `package:firefox`, no `verify:firefox`, no XPI.
  The Gecko build used here went to a temporary directory for inspection only.
- **No Firefox sign-in.** The real `getRedirectURL()` value has not been read
  from a real Firefox, and nothing has been registered with Supabase — correctly,
  since that was explicitly out of scope.
- **Nothing has run in Firefox.** Not the panel, not the content script, not the
  port, not one line of the Gecko adapter. It is verified against a fake engine.
- **The class-F items are still open** — panel anchoring under Gecko,
  page-origin `localStorage` under strict ETP, host-permission revocation
  behaviour.
- **Not AMO-ready.** No source package, no listing, no `web-ext`.

---

## 13. Remaining F2+ work

Unchanged from the investigation, minus what F1 completed.

| | Milestone | Now needs |
| --- | --- | --- |
| **F2** | Manifest + packaging | `package:firefox{,-beta}` and `verify:firefox` on top of `manifestFor` (the transform itself is done); `web-ext lint` |
| **F3** | Firefox auth | read the real redirect URL; **owner** registers it in Supabase; sign in as an existing account and confirm the same friends, badges and invite code |
| **F4** | Runtime compatibility | resolve the class-F items; verify the button strip against real Firefox |
| **F5** | Automated verification | `scripts/rdp.mjs` + the 8-assertion E2E; wire both verifications into the release gate |
| **F6** | AMO submission | source package, permission justifications, unlisted beta first |
| **F7** | Human acceptance | 4-step pass |

F1's own follow-through: `scripts/package-beta.mjs` does not yet import
`manifestFor`. That is F2's first move and deliberately not done here — adding a
packaging path Chrome does not use would have put new code in the path that
builds the submitted artefact.

---

## 14. Chrome Web Store submission impact

**None.**

The v0.6.0 submission currently in review is unaffected. F1 changed no manifest,
no permission, no host permission, no OAuth behaviour and no extension identity.
The `dist/manifest.json` this tree produces is byte-identical to the one in the
submitted package.

F1 belongs to the **next** development state. It is not part of, and does not
alter, the release under review.

---

## 15. Artifact impact

**None. The submitted artefacts were never touched** — not rebuilt, not
replaced, not deleted, not re-hashed into.

Re-verified after all F1 work:

```
150e3c5b9319d3ccccba5ca0d07ba5a6ea38ccde1a9f426b8ffb280b7a818d3d  Watchside-Store-v0.6.0.zip
c1217ff5093ed2cb65a918eea21d14df4f66cbf48283487cae12c81e6067203e  Watchside-Private-Beta-v0.6.0.zip
```

Both match the values recorded before F1 began. The byte-equivalence comparison
used a `dist/` snapshot in a scratch directory and a Gecko build in a temporary
directory; `releases/` was only ever read.

No new artefact was produced. F1 ships no package.

---

## 16. Commits and push

Two commits, pushed to `origin/main`:

1. `feat: one Watchside, two engines` — the adapter, the manifest transform,
   the build wiring, and the boundary tests.
2. `docs: record the Firefox F1 cross-browser foundation` — this report.

---

## 17. Git status

- Branch `main`, tracking `origin/main`, pushed.
- Working tree clean apart from the known EOL-only status artefact on
  `src/background/index.ts` (`core.autocrlf`), which is byte-identical to `HEAD`.
- Chromium extension ID: `ngfopkeokddfnncdhfkhnffilbdhkkip` — unchanged.
- Hosted schema: 28 — untouched.
- Chrome Web Store: submitted v0.6.0, untouched.
- Firefox: F1 complete, F2–F7 outstanding, **not supported yet**.
