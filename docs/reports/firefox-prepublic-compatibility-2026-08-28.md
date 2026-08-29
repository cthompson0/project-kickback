# Firefox — pre-public compatibility and architecture investigation

**Date:** 2026-08-28
**Scope:** investigation and design only. No production code, manifest,
dependency, packaging, OAuth, Supabase or Chrome artefact was modified.
**Repository state at investigation:** `main` = `origin/main` = `3a98f3f`,
Watchside 0.6.0, Chromium ID `ngfopkeokddfnncdhfkhnffilbdhkkip`.

---

## 1. Executive conclusion

Firefox support is **substantially cheaper than expected**, and the reason is
architectural rather than lucky.

Watchside already funnels every browser API through dependency injection. The
whole codebase contains **43 `chrome.*` references across 10 files**, and once
comments are removed, **every real call site lives in exactly two files**:
`src/background/index.ts` (the composition root) and `src/client/port.ts`. Every
service below them — auth, presence, notifier, storage, metadata, gatherings,
analytics — already receives its browser capabilities as an injected interface
(`AuthDeps`, `NotifierDeps`, `KeyValueStorage`, `AsyncStorageArea`, and 20 more
`*Deps` types). **The adapter seam this task is asking for already exists.** It
just currently has one implementation.

Nothing in the investigation found a capability Firefox cannot provide. The
three genuine differences are small and each has a clean answer:

1. Firefox MV3 uses an **event page**, not a service worker. One extra manifest
   key; our worker-eviction recovery stays valid and becomes a harmless no-op.
2. `identity.getRedirectURL()` returns a **different URL** on Firefox. Needs one
   Supabase allow-list entry and a fixed extension ID. **It cannot fork account
   identity** — see §8.
3. Firefox notifications **do not support buttons**. Our button and our body
   click already call the identical function, so stripping the button loses a
   label and no capability.

The largest real cost is not code. It is **AMO review friction**: minified
bundles require a source-code submission, and our `https://*.supabase.co/*`
wildcard host permission is the kind of thing a reviewer asks about.

---

## 2. Verdict

### CONDITIONAL GO

Conditional on two **owner** actions, neither of which is a technical blocker
and neither of which touches Chrome:

- **C1.** Add the Firefox redirect URL to the Supabase Auth redirect allow-list
  (§10). Without it, Firefox sign-in fails at the last hop.
- **C2.** Accept AMO's source-code submission requirement for minified builds
  (§15), which means publishing a reproducible build recipe.

No stop condition was triggered. Specifically, none of the following is true:
Firefox can support every critical Watchside capability; OAuth preserves account
identity exactly; no separate codebase is required; no AMO policy conflicts with
a core feature; and nothing here asks Chrome to be weakened.

---

## 3. Current browser API inventory

Counted across `src/`, `scripts/`, `tests/`, `public/`:

| Namespace | References |
| --- | --- |
| `chrome.storage` | 17 |
| `chrome.runtime` | 10 |
| `chrome.identity` | 6 |
| `chrome.notifications` | 4 |
| `chrome.tabs` | 3 |
| `chrome.alarms` | 3 |

**43 total — and roughly half are prose in doc comments.** The real call sites:

### `src/background/index.ts` — the composition root

| Line | Call |
| --- | --- |
| 130–132, 469–471 | `chrome.storage.local.get/set/remove` (two injected `AsyncStorageArea` adapters) |
| 204 | `chrome.identity.launchWebAuthFlow({ url, interactive: true })` |
| 208 | `chrome.identity.getRedirectURL()` |
| 971–974 | `chrome.notifications.create/clear/onClicked/onButtonClicked` |
| 975 | `chrome.tabs.create({ url })` |
| 992 | `chrome.runtime.getURL('icons/icon-128.png')` |
| 1290, 1296 | `chrome.storage.local.set/get` (channel-name cache) |
| 1418, 1875 | `chrome.runtime.Port` (type position only) |
| 1920 | `chrome.runtime.onConnect.addListener` |
| 2122, 2124 | `chrome.alarms.create` / `onAlarm.addListener` |
| 2138 | `chrome.runtime.onStartup.addListener` |
| 2417 | `chrome.runtime.onInstalled.addListener` |

### `src/client/port.ts` — the content-script end of the pipe

| Line | Call |
| --- | --- |
| 54 | `chrome.runtime.Port` (type position only) |
| 81 | `chrome.runtime.connect({ name: PORT_NAME })` |

### Everything else

`analyticsHub.ts:184`, `analyticsSession.ts:21`, `preferences.ts:6`,
`storage.ts:6`, `supabaseBackend.ts:50,125`, `messages.ts:9`,
`KickbackPanel.tsx:97`, `usePanelLayout.ts:25`, `index.ts:119` — **all
comments.** No call.

### Manifest surfaces (`public/manifest.json`)

```
manifest_version           3
background                 { "service_worker": "kickback-background.js" }
content_scripts            [{ matches: twitch.tv, js: [kickback-content.js], run_at: document_idle }]
permissions                ["identity","storage","alarms","notifications"]
host_permissions           ["https://*.supabase.co/*","https://7tv.io/*","https://cdn.7tv.app/*"]
action                     { default_title, default_popup: popup.html, default_icon }
web_accessible_resources   (absent)
content_security_policy    (absent)
browser_specific_settings  (absent)
key                        (Chromium identity)
```

The two absences matter: with **no `web_accessible_resources`** and **no custom
CSP**, the two manifest areas where Firefox and Chrome differ most are not
areas we use. Panel CSS is inlined into the shadow root
(`src/content/index.tsx:12`, `import panelStyles from '../ui/kickback.css?inline'`),
which is why no web-accessible resource is needed.

---

## 4. Compatibility matrix

**A** works unchanged · **B** syntax/API adaptation only · **C** manifest/config
difference · **D** behavioural difference needing architecture work ·
**E** unsupported/blocker · **F** needs real Firefox verification

| # | Surface | Evidence | Class | Note |
| --- | --- | --- | --- | --- |
| 1 | `runtime.connect` / `onConnect` / long-lived Port | `port.ts:81`, `index.ts:1920` | **A** | Identical semantics. Port identity as tab key holds. |
| 2 | `runtime.getURL` | `index.ts:992` | **A** | |
| 3 | `runtime.onInstalled` / `onStartup` | `index.ts:2417, 2138` | **A** | |
| 4 | `storage.local` get/set/remove | `index.ts:130–132, 469–471, 1290, 1296` | **A** | Behind `AsyncStorageArea`. |
| 5 | `alarms.create` / `onAlarm` | `index.ts:2122–2124` | **A** | 30-minute period (`REFRESH_PERIOD_MINUTES = 30`), far above any minimum. |
| 6 | `tabs.create` | `index.ts:975` | **A** | Needs no `tabs` permission in either browser. |
| 7 | `chrome.*` vs `browser.*` namespace + promise style | all of the above | **B/F** | The one real syntax risk. See §6. |
| 8 | `identity.launchWebAuthFlow` | `index.ts:204` | **B** | Supported since Firefox 75 with the constraint in row 9. |
| 9 | `identity.getRedirectURL` | `index.ts:208` | **C+D** | Different URL. Requires fixed gecko ID + Supabase allow-list. §8, §9. |
| 10 | `notifications.create` with `buttons` | `notifier.ts:107` | **D** | Firefox supports only `type:'basic'`, `title`, `message`, `iconUrl`. §13. |
| 11 | `notifications.onButtonClicked` | `index.ts:974`, `notifier.ts:90` | **D** | Unsupported. Degrades cleanly — §13. |
| 12 | `notifications.onClicked` / `clear` | `index.ts:972–973` | **A** | |
| 13 | Background context model | `manifest.background.service_worker` | **C+D** | Event page, not worker. §7. |
| 14 | Manifest version | MV3 | **C** | Stay MV3. §5. |
| 15 | Declared permissions | 4 permissions | **A** | All four supported. |
| 16 | Host permissions | 3 hosts | **C+D** | Granted at install from Firefox 127, but user-revocable at any time. |
| 17 | CSP | absent | **A** | Default MV3 CSP satisfies both. |
| 18 | `web_accessible_resources` | absent | **A** | Nothing to reconcile. |
| 19 | Content-script injection | `content_scripts` matches | **A** | |
| 20 | Shadow DOM host | `content/index.tsx`, `HOST_ID='kickback-host'` | **A** | Standard DOM; Firefox has full support. |
| 21 | Twitch SPA navigation | `platforms/twitch/navigation.ts:32,53,54,58` | **A** | `MutationObserver` + `popstate` + `<title>` observer + poll. Deliberately does **not** patch `history.pushState` — which is exactly what makes it portable. |
| 22 | Panel positioning / chat-rail measurement | `platforms/twitch/anchor.ts`, `chatRail.ts` | **F** | Pure DOM measurement, but Twitch layout under Firefox needs eyes. |
| 23 | Page-origin `localStorage` (layout, collapse, hint) | `usePanelLayout.ts:76,94,95`, `KickbackPanel.tsx:102,110`, `useLayoutHint.ts:22,31` | **F** | Content scripts share the page origin in both browsers; verify under strict ETP. |
| 24 | Multiple Twitch tabs / cross-tab coordination | `background/activity.ts`, port-per-tab | **A** | Port object as key, no `tabs` permission. |
| 25 | Stream Rooms, Gravity, JOIN | `background/streamRoom.ts`, `core/socialGravity.ts` | **A** | Pure product logic, no browser API. |
| 26 | 7TV / emotes | `background/sevenTv.ts` | **A** | Background `fetch` under host permission. |
| 27 | All Supabase/metadata network I/O | `supabaseBackend.ts:771`, `index.ts:2168` | **A** | Happens in the background context, so no page CORS. §11. |
| 28 | Popup (`popup.html`) | `manifest.action.default_popup` | **A** | `action` is MV3 in both. |
| 29 | Persisted `kickback:*` keys | 12 keys | **A** | §12. |
| 30 | Invite attribution (`kickback_invite`) | `core/invites.ts` | **A** | Pure URL parsing in the content script. |
| 31 | Extension identity assumptions | `manifest.key`, `scripts/extension-identity.mjs` | **C** | Chromium key is meaningless to Firefox; Firefox needs its own ID. §9. |

**Zero class-E findings.**

---

## 5. MV3 vs MV2 — recommendation

### Target Firefox **Manifest V3**.

Not out of preference for symmetry, but because MV2 is the worse engineering
choice on its own merits:

- **AMO is steering to MV3.** Choosing MV2 now buys a second migration later,
  on Mozilla's timetable rather than ours.
- **MV2 would fork the manifest genuinely**, not cosmetically: different
  `browser_action` vs `action`, different CSP shape, different permission
  model. That is the "substantially different Firefox product" the brief rules
  out.
- **MV3 lets one manifest source serve both.** From Firefox 121, `background`
  may carry **both** `scripts` and `service_worker`; Firefox takes `scripts` and
  starts an event page, Chrome takes `service_worker`. The background key stops
  being a fork and becomes an addition.
- **The MV3 gaps that historically justified MV2 are closed for our surface.**
  From Firefox 127, host permissions in `host_permissions` *and*
  `content_scripts` are shown at install and **granted on installation** — the
  old "MV3 content scripts need a manual opt-in" problem, which would have been
  fatal to a Twitch overlay, no longer applies.

Per-key assessment for MV3:

| Key | Firefox MV3 | Action |
| --- | --- | --- |
| `background` | event page via `scripts`; `service_worker` unsupported | add `scripts` |
| `browser_specific_settings` | required for a stable ID | add `gecko.id` + `strict_min_version` |
| extension ID | developer-defined (see §9) | choose an email-form ID |
| `permissions` | all four supported | none |
| `host_permissions` | granted at install (127+), revocable | handle revocation |
| CSP | object form; `script-src 'self'`/`'wasm-unsafe-eval'` only | none (we set no CSP) |
| `content_scripts` | supported | none |
| `web_accessible_resources` | supported except `use_dynamic_url` | none (unused) |
| `notifications` | basic only | §13 |
| `alarms` | supported | none |
| `storage` | supported | none |
| messaging | supported | none |
| updates | AMO-managed for listed add-ons | none |
| AMO | accepts MV3 | §15 |

**`strict_min_version` recommendation: `"128.0"`.** It sits above the Firefox
127 host-permission change with margin, and 128 is an ESR, so it is the version
institutional users are actually on.

---

## 6. `chrome.*` vs `browser.*` — abstraction recommendation

### Recommendation: a **thin internal adapter**, no new runtime dependency.

Rejected alternatives, with reasons:

- **`webextension-polyfill`** — adds a runtime dependency and a global shim to
  serve *two files*. It also does the thing the brief warns against: it makes
  the browser difference ambient rather than explicit.
- **Native `browser.*` everywhere** — Chrome does not expose `browser`.
- **Build-time alias** — hides which surface is browser-specific, and cannot
  express a *behavioural* difference such as stripping notification buttons.

The reason an adapter is not optional: our code calls `chrome.storage.local.get(...)`
and awaits the result. On Firefox the promise-returning namespace is `browser.*`;
`chrome.*` exists for compatibility but is callback-shaped. **Silently getting
`undefined` where a promise was expected is exactly the failure mode that is
invisible in unit tests and fatal in the browser.** Marked **F** in the matrix —
the adapter makes it moot rather than leaving it to be discovered.

### Proposed shape

```
src/platforms/browser/
  index.ts        // export const ext: BrowserExtensionApi  (picks per build)
  types.ts        // BrowserExtensionApi — our own interface, our own vocabulary
  chromium.ts     // reads chrome.*
  gecko.ts        // reads browser.*, strips notification buttons
```

`BrowserExtensionApi` should be **narrow to what we actually call** — storage
area, `launchWebAuthFlow`, `getRedirectURL`, notifications, `tabs.create`,
`getURL`, `connect`/`onConnect`, alarms, `onStartup`/`onInstalled`. Roughly
fifteen members. Selected by the existing Vite build-mode mechanism (the same
one `VITE_KICKBACK_MODE` already uses for demo builds), so the unused
implementation is tree-shaken out and neither package ships the other's adapter.

`@types/chrome` stays; no new type dependency, because the boundary is typed by
**our** interface, not by either vendor's.

### Estimated shared product code

**~99%.** Precisely: two files acquire a different import, one new directory of
~150 lines appears, and **no file under `src/core/`, `src/ui/`, `src/platforms/twitch/`,
or any `src/background/*` service changes at all** — they already consume
injected interfaces. There will be **no browser conditionals in feature code**;
the only `if (firefox)` in the product is the choice of adapter module, made
once, at build time.

---

## 7. Background lifecycle

**Firefox MV3 runs an event page, not a service worker.** It suspends on idle
like a Chromium MV3 worker: in-memory state is lost, top-level listeners
registered synchronously survive, and `alarms` and `runtime.onConnect` both wake
it.

One difference works strongly in our favour: **a Firefox background page does
not unload while a message port is open.** Watchside holds a long-lived
`runtime.Port` per Twitch tab (`port.ts:81` ↔ `index.ts:1920`), so on Firefox the
background context stays alive for exactly as long as the user has Twitch open —
which is precisely the window in which it matters.

### Does our Chromium recovery architecture stay useful?

**Yes, unchanged, and it should stay shared.** The recovery is not a Chrome
workaround bolted on top; it is triggered by *reconnection*:

- `src/client/port.ts` replays the last `activity` message on reconnect, so a
  restarted background context relearns the tab registry;
- `src/background/presence.ts` re-states the full destination set on a
  `destinationRefreshMs` tick when marked stale.

Both are **conditional on the context having actually died**. On Firefox, where
it usually will not while a port is open, they simply never fire. That is a
no-op, not dead weight — and if Firefox does suspend (all Twitch tabs closed,
memory pressure, a future policy change), the recovery is already there.

**Recommendation: no lifecycle adapter.** Keep one shared implementation. Do not
remove or weaken the Chromium recovery behaviour. The correct Firefox
verification is an E2E assertion that presence survives a background restart
(§16), not a code branch.

---

## 8. Auth architecture

### The flow today

1. `index.ts:208` — `chrome.identity.getRedirectURL()` →
   `https://ngfopkeokddfnncdhfkhnffilbdhkkip.chromiumapp.org/`
2. `supabaseBackend.ts:120` — `supabase.auth.signInWithOAuth({ provider:'twitch', options:{ redirectTo, skipBrowserRedirect:true } })`
   returns an authorize URL. **No `scopes` are requested** — confirmed by
   inspection; the option is absent.
3. `index.ts:204` — `chrome.identity.launchWebAuthFlow({ url, interactive:true })`
4. Twitch → **Supabase's** callback → back to our redirect URL with a code
5. `auth.ts` exchanges the code; `sync_kickback_identity()` maps the auth user
   to `public.users`.

### Proposed cross-browser architecture

Only **step 1 and step 3** are browser-specific, and both are already injected
(`AuthDeps.redirectUrl`, `AuthDeps.launchWebAuthFlow`). So:

```
ext.identity.getRedirectURL()      // chromium.ts -> chrome.*   gecko.ts -> browser.*
ext.identity.launchWebAuthFlow(u)  // same
```

**`src/background/auth.ts` does not change by a single line.** The composition
root passes a different `redirectUrl`, and everything downstream — PKCE,
exchange, refresh, the 120-second expiry skew, the alarm-driven refresh — is
already browser-agnostic.

### Will Chrome and Firefox produce the same account?

**Yes, and this is structurally guaranteed rather than merely likely.**

Supabase keys an `auth.users` row on **(provider, provider_id)** — the Twitch
`sub`. The redirect URL is a *transport detail of the authorization hop*; it is
not part of the identity. Signing in with the same Twitch account from Firefox
therefore resolves to the same `auth.users` row, which means:

- `sync_kickback_identity()` hits its `on conflict (id) do update` path and
  updates the existing `public.users` row rather than creating one;
- `connected_accounts` hits `on conflict (platform, platform_user_id)`, with the
  `where public.connected_accounts.user_id = excluded.user_id` guard that exists
  precisely to stop a Twitch account migrating to a different user;
- friends, badges, invite code, referrals and presence are all keyed on that
  same user id.

**Browser choice cannot fork identity.** The only way to get two Watchside
accounts remains what it has always been: signing in with two different Twitch
accounts.

**Risk to watch, not a blocker:** if the Firefox redirect URL is *missing* from
Supabase's allow-list, sign-in fails cleanly at the redirect — it does not
create a second account. The failure mode is a refusal, which is the right one.

---

## 9. Firefox identity and redirect requirements

| Item | Chromium (today) | Firefox (proposed) |
| --- | --- | --- |
| ID source | `manifest.key` → `ngfopkeokddfnncdhfkhnffilbdhkkip` | `browser_specific_settings.gecko.id`, developer-chosen |
| ID form | 32 chars `a`–`p` | email-like or GUID — propose **`watchside@anoteros-labs.com`** |
| Redirect URL | `https://<id>.chromiumapp.org/` | `https://<hex-derived-from-id>.extensions.allizom.org/` |
| Must the redirect be `getRedirectURL()`'s value? | yes | **yes, since Firefox 75** — arbitrary redirects are rejected |
| AMO-assigned vs developer-defined | n/a | **developer-defined.** AMO will assign one if omitted, and it would then differ per upload — which would break the redirect URL. **Set it explicitly.** |

**The Chromium `manifest.key` must not appear in the Firefox package**, and the
Chromium ID must not change. These are independent identities for the same
product; that is normal and expected.

**The exact Firefox redirect URL cannot be computed here** — it is a hash of the
add-on ID produced by Gecko. It must be read once from a real Firefox by calling
`browser.identity.getRedirectURL()` after loading the extension with the final
ID, then registered in Supabase. That is owner action **O3** (§22) and is the
single hard ordering dependency in the whole plan.

---

## 10. Supabase and Twitch configuration implications

### Supabase — **one change required**

Add the Firefox redirect URL to **Authentication → URL Configuration →
Redirect URLs**:

```
https://<hex>.extensions.allizom.org/
```

A wildcard (`https://*.extensions.allizom.org/`) would also work but is
**not recommended**: it would allow *any* Firefox extension's redirect URL to be
a valid destination for our auth flow. Register the exact URL.

This is **additive**. The existing `chromiumapp.org` entry stays, and Chrome is
unaffected.

### Twitch — **no change required**

Twitch's registered OAuth redirect is **Supabase's** callback
(`https://<project>.supabase.co/auth/v1/callback`), not the extension's. The
extension's redirect URL is a Supabase-level `redirectTo`, invisible to Twitch.
No Twitch developer-console change, and **no OAuth scope change** — none are
requested today and none are needed.

### Database — **no change required**

No migration. Schema stays at 28.

---

## 11. Content-script compatibility

| Concern | Finding |
| --- | --- |
| Injection | `content_scripts` with `https://www.twitch.tv/*`, `https://twitch.tv/*`, `run_at: document_idle`. Supported identically. Host permission granted at install from Firefox 127. |
| SPA navigation | `platforms/twitch/navigation.ts` uses `MutationObserver`, `popstate`, a `<title>` observer and a poll — and its own comment (line 5) records that it deliberately does **not** patch `history.pushState` because a content script cannot. That decision, made for Chrome, is exactly what makes it portable. **Class A.** |
| Shadow DOM | Single host `#kickback-host` with an open shadow root; CSS inlined via `?inline`. Full Firefox support, and no `web_accessible_resources` needed. |
| CSS isolation | Shadow root, so Twitch's stylesheet cannot leak in and ours cannot leak out. Same guarantee in Gecko. |
| Panel positioning / launcher | `anchor.ts` + `chatRail.ts` measure Twitch's real layout. Portable APIs, but **class F** — Twitch's DOM under Firefox deserves eyes, and pixel measurement is the classic place engines differ. |
| Channel detection | `platforms/twitch/channels.ts` parses the URL path. Class A. |
| Multiple tabs / visibility | One port per tab; the port object *is* the key, so no `tabs` permission. `visibilitychange`/focus reporting is standard DOM. Class A. |
| Stream Rooms / Gravity / JOIN | No browser API — pure product code plus `tabs.create` for JOIN. Class A. |
| 7TV / emotes | Fetched in the **background** under host permission, so no page CORS boundary. Class A. |
| Page `localStorage` | Layout, collapse and hint state use the **page's** `localStorage` (twitch.tv origin), by design (`usePanelLayout.ts:25` explains why: synchronous reads avoid a first-paint flash). Content scripts share the page origin in both engines. **Class F** — verify under Firefox strict Enhanced Tracking Protection. |

**Nothing Chromium-specific was found in the Twitch integration.**

---

## 12. Storage compatibility

**All `kickback:*` keys stay byte-identical on Firefox.** They are internal
compatibility contracts and there is no reason to touch them — the same
reasoning that kept them through the Watchside rename applies unchanged, and a
cosmetic rename here would be worse than pointless because it would desynchronise
the two ports.

Affected keys: `kickback:preferences`, `kickback:sessionTab`,
`kickback:sessionRead`, `kickback:mutedUsers`, `kickback:groups:seen`,
`kickback:groups:muted`, `kickback:attention:seen`, `kickback:channelMetadata`,
`kickback:channelNames`, `kickback:analytics:session`,
`kickback:analytics:join`, `kickback:analytics:lifecycle`,
`kickback:refresh-session` (alarm name), `kickback:gathering:` (notification id
prefix), `kickback:social-gravity:v1` (experiment salt).

`storage.local` semantics are equivalent: async, structured-clonable values,
survives restarts. We use no `storage.sync` and no `storage.session`, so the
areas where the engines differ are unused.

**One product observation, not a defect.** Extension storage is per-browser and
per-profile. A user running Watchside in both Chrome and Firefox gets **one
account, one friend list, one badge shelf** (all server-side) but **two
independent panel layouts, two collapse states and two local muted-user lists**,
since those are deliberately local. This is the correct behaviour for layout and
arguably the wrong one for mutes — but it is pre-existing, identical to running
two Chrome profiles today, and is out of scope here. Worth a product decision
before public launch; not a Firefox blocker.

---

## 13. Notifications

Firefox supports **only** `type: 'basic'`, `title`, `message`, `iconUrl` — and
**not** `buttons`, `requireInteraction`, `silent`, `contextMessage`,
`imageUrl`, or the `image`/`list`/`progress` types. `notifications.onButtonClicked`
does not exist.

We send (`notifier.ts:103–109`):

```js
deps.create(`${ID_PREFIX}${safeChannel}`, {
  type: 'basic',
  iconUrl: deps.iconUrl,
  title: `${describeNames(names)} on Twitch`,
  message: `Watching ${formatChannelName(safeChannel, channelName)}`,
  buttons: [{ title: 'Join them' }],
})
```

Only `buttons` is a problem — and passing an unsupported property to Firefox's
`notifications.create` is a schema validation error, not a silent ignore, so
this must be handled rather than hoped over.

**It degrades to nothing.** `notifier.ts:89–93`:

```js
deps.onClicked(open)
deps.onButtonClicked((id, buttonIndex) => { if (buttonIndex !== 0) return; open(id) })
```

The button and the notification body call the **identical** `open()`. Dropping
the button removes a label, not a capability: on Firefox the user clicks the
notification and lands in exactly the same place.

**Recommendation.** `gecko.ts` strips `buttons` and registers a no-op
`onButtonClicked`. `notifier.ts` — which holds the product decisions about *when*
to notify, de-duplication by channel id, and dismissal — **does not change**.
Icon handling is identical (`runtime.getURL('icons/icon-128.png')`, and the
128px Watchside icon is already in the package).

Gathering and friend notifications therefore behave identically apart from the
missing button affordance.

---

## 14. Packaging architecture

Extend `scripts/package-beta.mjs` rather than adding a second packager — it
already knows how to stage, exclude, hash and verify, and already has a
`--store` variant that transforms the manifest by **removing** `key`.

```
npm run package:firefox        # AMO listing artefact
npm run package:firefox-beta   # unlisted / self-test artefact
```

| Decision | Recommendation |
| --- | --- |
| Manifest strategy | **One source, transformed.** `public/manifest.json` stays the Chromium truth; a `manifestFor('firefox')` transform adds `browser_specific_settings` and `background.scripts`, and removes `key`. A checked-in second manifest would drift. |
| Firefox-specific fields | `browser_specific_settings.gecko.id`, `.strict_min_version: "128.0"`. Optionally `background.scripts` alongside `service_worker`, or `service_worker` removed entirely for the Firefox package — **prefer removed**, so `web-ext lint` never warns about a key Gecko ignores. |
| Extension ID | `watchside@anoteros-labs.com`, checked into the transform and asserted by a test — the redirect URL is derived from it, so an accidental change silently breaks auth. Treat it with the same care as the Chromium key. |
| Icons | Unchanged. The same four PNGs, still rasterised from `assets/brand/watchside-mark.svg`. |
| Artefact naming | `Watchside-Firefox-v0.6.0.zip`, `Watchside-Firefox-Beta-v0.6.0.zip` — matching the existing `Watchside-Store-` / `Watchside-Private-Beta-` shape. |
| Version | **Synchronised.** One `package.json` version drives all artefacts. `tests/extension/releaseVersion.test.tsx` already pins manifest against package.json; extend it to the Firefox manifest. |
| Source maps | **Excluded from the shipped package**, as today — but see §15: AMO wants *source*, which is the repository plus a build recipe, not source maps. |
| Determinism | The existing packager's fixed file ordering and stripped timestamps carry over. Same-input-same-hash must hold for the Firefox artefact too. |
| Verification | `npm run verify:firefox` mirroring `verify:store`: asserts gecko ID, `strict_min_version`, **absence of `key`**, absence of `background.service_worker`, permission parity with the Chromium manifest, all four icons, and version match. Plus `web-ext lint`, which is AMO's own validator. |

---

## 15. AMO requirements

| Requirement | Status |
| --- | --- |
| Developer account | Mozilla Account connected to addons.mozilla.org. **Owner action.** |
| Signing | Mandatory. AMO signs; listed add-ons are signed on submission. |
| Package format | ZIP/XPI, ≤200 MB. Ours is ~175 KB. |
| Listed vs unlisted | **Listed** for public launch. **Unlisted** is available for signed private-beta distribution — the closest analogue to our current sideloaded beta, and it gets a signed installable XPI without a public listing. |
| **Source-code submission** | **REQUIRED — we are affected.** Vite minifies. AMO requires a source package plus build instructions whenever shipped code is minified or bundled. |
| Privacy policy | Required where data is transmitted. We have one — `docs/PRIVACY.md`, published at `/watchside/privacy/`. |
| Data disclosure | Must declare what is collected. Our analytics posture is already documented and deliberately narrow. |
| Permission justification | Four permissions + three hosts, each needing a reason. `verify:store` already carries justification text that can be reused. |
| Remote code | **Prohibited.** We are clean: no CDN script, no `eval`, no remote module loading. Supabase JS is bundled, not fetched. |
| CSP | Default MV3 CSP; we set none, so nothing to defend. |
| Updates | AMO-managed for listed add-ons. Self-distribution would need `update_url`; not recommended. |
| Review friction | **Moderate.** An extension that injects into twitch.tv, authenticates, and talks to a backend attracts human review. |

### Things to fix *before* public release

1. **`https://*.supabase.co/*` is a wildcard over every Supabase project on the
   internet.** It is the single most likely reviewer question, and it is
   genuinely broader than we need. Narrowing to the project host would be
   tighter and easier to justify — but it is currently environment-configurable,
   so this is a real design decision, not a one-line edit. **Flagged, not
   changed.** It affects the Chrome listing equally.
2. **Prepare the source submission now, not at review time**: a clean-checkout
   build recipe (`npm ci && npm run build && npm run package:firefox`) that a
   reviewer can run to reproduce the artefact byte-for-byte. Our deterministic
   packaging makes this genuinely provable, which is an unusually strong
   position to be in.
3. **Run `web-ext lint` in CI** so AMO validation failures surface locally
   rather than after submission.

---

## 16. Automated testing strategy

The brief is right that Firefox must not be held together by manual QA. Mapping
the existing layers:

| Layer | Today | Under Firefox |
| --- | --- | --- |
| `tests/db/` (12 files, PGlite) | real Postgres | **unchanged** — no browser involved |
| `tests/extension/` (64 files, Vitest node+dom) | injected fakes | **unchanged** — this is precisely what dependency injection bought |
| New: adapter contract tests | — | **one shared suite, run against both adapters**, asserting they satisfy `BrowserExtensionApi` identically and that `gecko.ts` strips `buttons` |
| New: packaging tests | `tests/extension/bundle.test.ts` | extend to the Firefox artefact: gecko ID, no `key`, no `service_worker`, permission parity |
| New: `web-ext lint` | — | `npm run verify:firefox` — AMO's own validator, locally |
| E2E | `scripts/cdp.mjs` (zero-dependency CDP driver, Edge) | **`scripts/rdp.mjs`** — sibling driver |

### Why a sibling driver rather than Playwright

**Playwright does not support loading extensions in Firefox** — extension
loading is Chromium-only, and the community workaround (`playwright-webextext`)
explicitly does not fully support MV3 on Firefox. Adopting Playwright would mean
a large new dependency that cannot do the one thing we need it for.

Firefox instead exposes **RDP `installTemporaryAddon`** over a debugger port —
which is exactly how `web-ext run` installs extensions internally, and exactly
the shape of `scripts/cdp.mjs`, which already speaks a JSON-over-socket
debugging protocol with zero dependencies. A `scripts/rdp.mjs` sibling is the
consistent choice, not a novel one.

**One justified new devDependency: `web-ext`.** Not for driving the browser, but
because `web-ext lint` *is* the AMO validator and `web-ext sign` is the official
signing path. Dev-only; never shipped.

### The smallest real Firefox E2E suite — 8 assertions

1. **Extension loads** — `installTemporaryAddon` returns our gecko ID.
2. **Content script injects** — `#kickback-host` exists on a twitch.tv page.
3. **Panel renders** — the shadow root contains `.kb-panel` and the wordmark.
4. **Messaging works** — the content script's port connects and the background
   answers a `hello`.
5. **Storage works** — a `kickback:*` round-trip through `storage.local`.
6. **Auth redirect constructs** — `browser.identity.getRedirectURL()` returns an
   `extensions.allizom.org` URL matching the ID, and the built authorize URL
   carries it as `redirect_to`. **Asserts the URL, does not perform a sign-in** —
   no credentials in CI.
7. **Twitch navigation detected** — SPA-navigate between two channels and assert
   the reported channel changes.
8. **Background restart recovery** — the one that earns its keep: restart the
   background context, reconnect, and assert destinations are re-stated. This is
   where two Chromium defects lived, and it is the assertion that would catch a
   Gecko lifecycle surprise.

Notification creation is deliberately *not* in the E2E set — it needs OS-level
permission and is flaky in CI. Cover it in the adapter contract test instead
(assert the payload Firefox would receive contains no `buttons`).

**Human acceptance stays tiny:** install the signed XPI, confirm the toolbar
mark, sign in once, confirm the same friends appear as in Chrome. Four steps.

---

## 17. Cross-browser release pipeline

```
shared source (one repo, one version)
        │
        ├── shared tests            vitest: tests/db + tests/extension  (unchanged)
        ├── adapter contract tests  both adapters, one suite
        │
        ├── Chromium verification   verify:store  + cdp E2E
        └── Firefox verification    verify:firefox + web-ext lint + rdp E2E
                │
                ├── Watchside-Store-v<X>.zip           / Watchside-Private-Beta-v<X>.zip
                └── Watchside-Firefox-v<X>.zip         / Watchside-Firefox-Beta-v<X>.zip
```

- **Versions stay synchronised.** One `package.json` version, four artefacts.
  Divergent versions would make "which build is this?" unanswerable in a bug
  report, and both stores accept the same string.
- **Browser-specific:** the manifest transform, the adapter module, the E2E
  driver, the packaging target, the store listing.
- **Shared:** everything else — all product code, all `tests/db`, all
  `tests/extension`, icons, the mark, the landing page, the privacy policy, the
  changelog.
- **Release gate:** a version ships only when *both* verifications pass. A
  Firefox regression must be able to block a Chrome release, or Firefox becomes
  second-class again by default.

---

## 18. Implementation estimate

### Complexity: **LOW–MEDIUM**

Low for the code; medium only because of AMO process and the one-time redirect
URL/allow-list ordering.

### Architectural seams requiring adaptation: **6**

1. Storage area (`index.ts:130–132`, `469–471`)
2. Identity — redirect URL + `launchWebAuthFlow` (`index.ts:204`, `208`)
3. Notifications — including the `buttons` strip (`index.ts:971–975`, `notifier.ts:107`)
4. Runtime — `getURL`, `connect`, `onConnect`, `onStartup`, `onInstalled`
   (`index.ts:992`, `1920`, `2138`, `2417`; `port.ts:81`)
5. Alarms (`index.ts:2122–2124`)
6. Manifest generation + packaging target

### Shared code: **~99%**

New browser-specific code is roughly **150 lines of adapter + ~60 lines of
manifest transform**, against a product codebase of tens of thousands. No file
in `src/core/`, `src/ui/`, `src/platforms/twitch/`, or any `src/background/`
service changes.

### Risk register

| Risk | Level | Why |
| --- | --- | --- |
| **Largest technical risk** | LOW–MED | Twitch's DOM under Gecko — panel anchoring and chat-rail measurement are pixel work (`anchor.ts`, `chatRail.ts`). Portable APIs, but the class of thing that only a real browser reveals. |
| **Largest distribution/review risk** | **MEDIUM** | AMO source-code submission for minified builds, plus the `*.supabase.co` wildcard host permission inviting reviewer questions. |
| **Largest auth risk** | LOW | Not identity forking — that is structurally impossible (§8). The risk is *operational*: the Firefox redirect URL must be read from a real Firefox and registered in Supabase before any Firefox build can sign in. A forgotten step, not a design flaw. |
| **Largest testing risk** | MEDIUM | No off-the-shelf Firefox extension E2E. Needs a small RDP driver written by us. Mitigated by `scripts/cdp.mjs` already proving the pattern in this repo. |

### Could anything make Firefox pre-public unreasonable?

**Nothing found.** The three candidates were checked and dismissed:

- *MV3 content scripts needing manual opt-in* — closed by Firefox 127 granting
  `content_scripts` host permissions at install. Had this still been true, a
  Twitch overlay would have been untenable and this report would say NO-GO.
- *No service worker* — Firefox's event page is a **better** fit for us, not a
  worse one, because an open port keeps it alive.
- *Identity forking* — impossible given Supabase's (provider, provider_id) key.

---

## 19. Risks and blockers

**Blockers: none.**

Open items requiring real Firefox verification (class F), all narrow:

- **F-1** `chrome.*` vs `browser.*` promise semantics — the adapter removes the
  risk by construction, but confirm on first run.
- **F-2** Panel anchoring and chat-rail measurement on Twitch under Gecko.
- **F-3** Page-origin `localStorage` under Firefox strict Enhanced Tracking
  Protection.
- **F-4** The exact `getRedirectURL()` value, which must be read from a real
  Firefox (§9) and cannot be derived here.
- **F-5** Whether a user-revoked host permission produces our existing honest
  failure ("Watchside can't reach its server right now") rather than a silent
  hang. It should — but it must be seen, because a silent fallback would violate
  our standing rule that normal mode never quietly degrades.

---

## 20. Implementation milestones

Derived from the six seams, ordered so each one is verifiable before the next.

| | Milestone | Contents | Done when |
| --- | --- | --- | --- |
| **F1** | Browser abstraction | `src/platforms/browser/{types,chromium,gecko}.ts`; rewire `index.ts` + `port.ts`; adapter contract tests | **Chrome is byte-identical** — same artefact hashes as today, full suite green. Nothing Firefox-specific ships yet. |
| **F2** | Manifest + packaging | manifest transform, gecko ID, `strict_min_version`, `package:firefox{,-beta}`, `verify:firefox`, `web-ext lint` | A Firefox ZIP builds, lints clean, and packaging tests pin ID/no-key/no-service-worker/permission parity |
| **F3** | Firefox auth | read the real `getRedirectURL()`; owner registers it in Supabase; end-to-end sign-in in a real Firefox | A **pre-existing** Watchside account signs in on Firefox and shows the **same** friends, badges and invite code as Chrome |
| **F4** | Runtime/content-script compatibility | resolve F-1…F-3, F-5; notification button strip verified | Panel anchors correctly, SPA navigation tracked, presence and Gravity correct across multiple tabs |
| **F5** | Firefox automated verification | `scripts/rdp.mjs` + the 8-assertion E2E; wire both verifications into the release gate | A Firefox regression fails the build |
| **F6** | AMO submission | source package + build recipe, permission justifications, privacy/data disclosure, unlisted beta first | Signed XPI installs from AMO |
| **F7** | Human acceptance | 4-step pass | Owner sign-off |

**F1 is deliberately a no-op for Chrome.** It must land with identical artefact
hashes, so the abstraction is proven not to have cost anything before any
Firefox-specific behaviour exists.

---

## 21. Roadmap sequencing recommendation

Assumed trajectory: M2 Friends Beta → M3 Measurement + Twitch Intelligence →
M4 Firefox → M5 Pre-Public Pack → M6 RC → M7 Launch.

### Recommendation: **B — begin partially alongside M3. Specifically, land F1 *before* substantial M3 work.**

Not because Firefox is urgent, but because **F1 is a refactor whose cost scales
with the amount of background code that exists when you do it.**

Today the entire browser surface is 43 references in two real files. That is the
cheapest this abstraction will ever be. M3 — Measurement and Twitch Intelligence
— is by its nature *background-context* work: more storage, more alarms,
probably more network scheduling. Every `chrome.*` call M3 adds before F1 is a
call that must be found and rewired afterwards, and rework in a background
context is exactly where this project has already lost time twice.

Sequencing:

- **F1 now**, before M3 lands substantial background code. Small, self-contained,
  verifiable by "Chrome artefacts unchanged", and it makes M3 write to a
  browser-neutral interface from its first line.
- **F2–F3 alongside or just after M3.** F3 has an owner dependency (Supabase
  allow-list) worth starting early because it is a waiting-on-someone step.
- **F4–F7 as M4**, unchanged.

This is not moving Firefox ahead of M3. It is extracting the one piece of M4
that gets more expensive the longer it waits, and leaving the rest where it is.

---

## 22. Owner actions eventually required

None of these is needed now. Listed in dependency order.

| | Action | Blocks |
| --- | --- | --- |
| **O1** | Create/connect a Mozilla Account on addons.mozilla.org | F6 |
| **O2** | Approve the permanent Firefox add-on ID (proposed `watchside@anoteros-labs.com`). Like the Chromium key, changing it later breaks the auth redirect. | F2 |
| **O3** | **Register the Firefox redirect URL in Supabase** → Authentication → URL Configuration → Redirect URLs. Exact URL, not a wildcard. Value must be read from a real Firefox at F3. | F3 |
| **O4** | Decide on the `https://*.supabase.co/*` wildcard host permission — keep and justify, or narrow to the project host. Affects the Chrome listing too. | F6 |
| **O5** | Decide unlisted-signed vs listed for the Firefox beta | F6 |
| **O6** | Approve `web-ext` as a dev-only dependency | F2 |
| **O7** | AMO listing content: description, screenshots, categories, support URL, privacy policy URL (`/watchside/privacy/` already live) | F6 |
| **O8** | Human acceptance on Firefox | F7 |

**Explicitly NOT required:** no Twitch developer-console change, no OAuth scope
change, no database migration, no Chrome resubmission, no change to the
Chromium extension ID.

---

## 23. Sources

- [MDN — `manifest.json/background`](https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/manifest.json/background) — Firefox does not support `background.service_worker` ([bug 1573659](https://bugzilla.mozilla.org/show_bug.cgi?id=1573659)); from Firefox 121 the background page starts regardless of `service_worker` being present
- [MDN — Background scripts](https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/Background_scripts) — event-page suspension, listener persistence, "a background page does not unload until all visible views and message ports are closed"
- [Firefox Extension Workshop — Manifest V3 migration guide](https://extensionworkshop.com/documentation/develop/manifest-v3-migration-guide/) — "From Firefox 127, host permissions listed in `host_permissions` and `content_scripts` are displayed in the install prompt and granted on installation"; CSP object form; `web_accessible_resources` minus `use_dynamic_url`
- [MDN — `identity` API](https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/API/identity) — Firefox 75+ must use `getRedirectURL()`'s value; Firefox 86+ loopback alternative; `browser_specific_settings` for a fixed ID
- [MDN — `identity.getRedirectURL()`](https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/API/identity/getRedirectURL) — URL derived from the extension ID
- [Mozilla Discourse — OAuth2 redirect to `extensions.allizom.org`](https://discourse.mozilla.org/t/oauth2-redirect-to-https-extensions-allizom-org-seems-to-fail/35994) — the `https://<hex>.extensions.allizom.org/` form
- [MDN — `notifications.NotificationOptions`](https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/API/notifications/NotificationOptions) — "Firefox currently: only supports the `type`, `title`, `message`, and `iconUrl` properties; and the only supported value for `type` is `'basic'`"
- [Firefox Extension Workshop — Submitting an add-on](https://extensionworkshop.com/documentation/publish/submitting-an-add-on/) — signing, listed vs self-distribution, source-code requirement for minified code, privacy policy
- [Mozilla Add-ons blog — Manifest V3 & Manifest V2 (March 2024 update)](https://blog.mozilla.org/addons/2024/03/13/manifest-v3-manifest-v2-march-2024-update/)
- [Playwright — Browsers](https://playwright.dev/docs/browsers) and [issue #2644](https://github.com/microsoft/playwright/issues/2644) — extension loading is Chromium-only
- [`playwright-webextext`](https://github.com/ueokande/playwright-webextext) — third-party workaround; does not fully support MV3 on Firefox
- [web-ext — temporary add-on installation](https://deepwiki.com/mozilla/web-ext/5.3-temporary-add-on-installation) and [Firefox Remote Debugging Protocol](https://firefox-source-docs.mozilla.org/devtools/backend/protocol.html) — `installTemporaryAddon` over the debugger port

---

## 24. Git status

Investigation only. **No production code, manifest, dependency, packaging
script, OAuth configuration, Supabase setting or Chrome artefact was modified.**

- Branch: `main`, tracking `origin/main`
- Only change: this report, added under `docs/reports/`
- Chromium extension ID unchanged: `ngfopkeokddfnncdhfkhnffilbdhkkip`
- Hosted schema unchanged: 28
- Chrome Web Store submission untouched
- Artefact hashes unchanged:
  - Beta `c1217ff5093ed2cb65a918eea21d14df4f66cbf48283487cae12c81e6067203e`
  - Store `150e3c5b9319d3ccccba5ca0d07ba5a6ea38ccde1a9f426b8ffb280b7a818d3d`
