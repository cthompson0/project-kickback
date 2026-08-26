# CHROME WEB STORE — PRIVATE BETA READINESS

**Date:** 2026-08-25
**Version:** 0.4.0
**Migration:** none. Hosted is current through `0023_feedback.sql`.
**Status:** repository ready. **Two owner actions block submission**, both dashboard-side.
**Follows:** [final-pre-beta.md](final-pre-beta.md)

---

## ADDENDUM — 26 August 2026: the identity is settled

The item has passed review and the Chrome Web Store has minted its keypair, so
the open question this checkpoint was written around is now answered.

**Permanent extension ID: `ngfopkeokddfnncdhfkhnffilbdhkkip`**

**Redirect: `https://ngfopkeokddfnncdhfkhnffilbdhkkip.chromiumapp.org/`**

The store's public key has been copied from the item's **Package** tab into
`public/manifest.json`, and `scripts/extension-identity.mjs` now names the store
ID. A local unpacked build and the published extension are the same extension to
Chrome — same ID, same redirect, one allow-list entry serving both.

**The old ID `almhfkicihekhiloapoimglfdoneglni` is no longer canonical.** It was
a locally generated identity and appears below only as a record of what was true
when this was written. `npm run verify:store` exempts this directory from its
stale-ID scan for exactly that reason; every live reference — README, tests,
packaging — has been updated.

### The one hosted action still outstanding

**Supabase dashboard → Authentication → URL Configuration → Redirect URLs → add:**

```
https://ngfopkeokddfnncdhfkhnffilbdhkkip.chromiumapp.org/
```

Nothing in this repository can perform or observe that change, and it has **not**
been made. Sign-in fails at the final hop without it: Twitch approves, Supabase
redirects, and Chrome refuses a destination that is not on the list — which reads
to a tester as "Kickback is broken" rather than "a URL is missing from a
dashboard".

**Twitch's developer app is unaffected.** Its redirect points at Supabase's own
callback (`https://<project>.supabase.co/auth/v1/callback`), which does not
depend on our extension ID and does not change.

Everything below is the original checkpoint, unedited.

---

## Verdict

**GO for submission, after two owner actions.** Neither is a code change and
neither is hard, but both must happen in a specific order — see the runbook.

The audit found **one P0 that was fixed here** (the ZIP we produce cannot be
uploaded to the store at all) and **one P0 the owner must resolve** (the
extension ID will change, and Supabase must be told). Everything else is P1 or
lower.

---

## Task 1 — Requirement matrix

Audited against current Chrome Web Store documentation, not recollection.
Sources at the end.

| Requirement | Current state | Action |
| --- | --- | --- |
| **Manifest V3** | `manifest_version: 3`, service worker background | none |
| **Single purpose** | One purpose: see which friends are watching Twitch and join them. Every surface serves it | none — statement drafted below |
| **Minimum functionality** | Real product, not a wrapper around a website | none |
| **Least privilege** | 4 permissions, 3 host permissions, **no `<all_urls>`, no `tabs`** | none; one candidate for removal later (P2) |
| **Remote code** | **Zero.** No `eval`, no `new Function`, no `importScripts`, no CDN script. Verified against both built bundles | none |
| **Privacy policy URL** | Policy **written** (`docs/PRIVACY.md`); **not yet hosted** | **OWNER: publish it at a public URL** |
| **Privacy practices declarations** | Data inventory complete (Task 3); answers prepared | **OWNER: fill in the dashboard** |
| **Limited Use certification** | We comply: no ads, no sale, no transfer, no human reading beyond support | **OWNER: tick the certifications** |
| **Disclosure** | Nothing hidden; every capability is visible in the panel | none |
| **Authentication** | Twitch OAuth via `chrome.identity`. No client secret ships; no password seen | none |
| **Listing assets** | 128px icon present. **Screenshots and promo tile missing** | **OWNER: capture — Task 6** |
| **Reviewer instructions** | Kickback needs a Twitch account *and a second one* to show anything | drafted below — **essential**, see P1 |
| **Trusted testers** | Not configured | **OWNER: dashboard** |
| **Version increments** | 0.4.0, manifest and package.json agree | enforced by `verify:store` |
| **Package shape** | **Was wrong** — manifest nested inside `Kickback/` | **FIXED: `npm run package:store`** |
| **2-Step Verification** | Required on the publisher account | **OWNER** |

### 2026 policy notes

The current program policies are organised into Fostering a Safe Ecosystem,
Protecting User Privacy, Responsible Marketing, Building Quality Products,
Technical Requirements and Enforcement. The two that bear on us are **Protecting
User Privacy** (policy URL, Limited Use, disclosure, handling) and **Technical
Requirements** (MV3, code readability, 2SV). Nothing in the current policy set
conflicts with how Kickback is built.

One thing worth knowing: an item that leaves the **Privacy practices** tab
incomplete is marked as not having provided the information and, after a 30-day
warning, **suspended**. It is not optional paperwork.

---

## Task 2 — Permission audit

Every permission, where it is used, and whether it could be narrower.

| Permission | Used at | Why | Narrower? |
| --- | --- | --- | --- |
| `identity` | `background/index.ts` — `launchWebAuthFlow`, `getRedirectURL` | The entire sign-in flow | No. `identity.email` is not requested and is not needed |
| `storage` | `storage.ts`, `preferences.ts`, `analyticsSession.ts`, `index.ts` | Session, panel layout, mutes, analytics session id. An MV3 worker is evicted after ~30s idle, so memory is not an option | No. `chrome.storage.sync` would be *wider* (leaves the device) |
| `alarms` | `index.ts` — one periodic alarm | Refreshes the Supabase session; safety net if the realtime socket dies quietly. A worker cannot hold a timer across eviction | No |
| `notifications` | `index.ts` — create/clear/onClicked/onButtonClicked | Optional desktop alert when friends gather. User-toggleable in the account panel | No |

| Host permission | Used at | Why | Narrower? |
| --- | --- | --- | --- |
| `https://*.supabase.co/*` | `supabaseBackend.ts`, realtime | Our whole backend | Could be pinned to the one project subdomain. **Not done**: it would hard-code the project into the manifest, and the URL comes from `.env.local`, so dev/staging builds would silently lose network access |
| `https://7tv.io/*` | `sevenTv.ts` — `fetch` | Public emote metadata, so chat renders the emotes viewers already see | No |
| `https://cdn.7tv.app/*` | `core/emotes.ts` — **URL construction only** | Emote images | **Probably removable — see below** |

### Not requested, and deliberately

`tabs` is **not** requested. `chrome.tabs.create` — the only tabs API used —
needs no permission, and Kickback learns which channel you are on from its own
content script rather than by reading tab URLs. This is worth stating in the
listing: it is the permission reviewers expect a product like this to want.

### The `cdn.7tv.app` candidate (P2, not changed)

`core/emotes.ts` only *builds* a `https://cdn.7tv.app/...` string; the image is
loaded by an `<img>` in the content script's shadow DOM. Image loads are
governed by the page's CSP, not by extension host permissions.

The evidence that this permission is unnecessary is in the repository already:
`static-cdn.jtvnw.net` is used exactly the same way — emote and avatar image
URLs, never fetched — and has **no host permission at all**, yet renders fine.

**Not removed before submission.** The failure mode if the reasoning is wrong is
"7TV emotes silently stop rendering for every tester", and it cannot be verified
without a real Twitch page carrying 7TV emotes. Permissions can be **reduced**
in a later version with no user re-consent, so this is strictly cheaper to do
after the beta confirms it. Recorded in the roadmap.

### Justification copy

Kept in `scripts/verify-store-readiness.mjs` rather than in a document, so a new
permission cannot be added without someone writing the sentence that defends it.
Paste-ready text is in Task 5.

---

## Task 3 — Data inventory

| Category | Collected | Transmitted | Persisted | Visible to others | In analytics | Retention |
| --- | --- | --- | --- | --- | --- | --- |
| Twitch identity (id, login, display name, avatar URL) | yes | yes | yes (Supabase) | name/avatar/login to friends and group members | **no** | until account deletion |
| Kickback identity (user id, friend code) | yes | yes | yes | friend code only if shared | **no** | until account deletion |
| Session tokens (Supabase access/refresh) | yes | — | `chrome.storage.local` | **never** | **never** | until sign-out/expiry |
| Twitch provider token | yes | — | worker only | **never reaches the content script** | never | session |
| Friendships, requests | yes | yes | yes | to the parties | counts only | until removed |
| Groups, membership | yes | yes | yes | to members | counts only | until left/deleted |
| Presence (online + channel) | yes | yes | transient row, overwritten | friends + group members, subject to visibility | destination of a JOIN only | not historical |
| Stream-session messages | yes | yes | yes | authorised recipients at send time | **body never** | **30 min**, capped count |
| Reactions / emotes | yes | yes | yes | same | count and direction; **never which emote** | seconds |
| Mute | yes | **no** | **device only** | no | no | until unmuted |
| Block | yes | yes | yes | **never disclosed** | that it happened, **no identifiers** | until unblocked |
| Panel layout | yes | **no** | `localStorage` | no | no | until reset |
| Analytics events | yes | yes | yes | never | — | per environment, deletable wholesale |
| JOIN attribution id | yes | yes | minutes, then dropped | never | yes | window only |
| Feedback body | yes | yes | yes | **never** — no client read path at all | category only | until acted on |
| Feedback diagnostics | yes | yes | yes | never | no | with the feedback |

### Mapping onto the dashboard's Privacy practices tab

| Dashboard category | Do we collect it? | Notes |
| --- | --- | --- |
| Personally identifiable information | **Yes** | Twitch display name, login, user id, avatar URL. **No email address, no name, no address, no phone** |
| Health information | No | |
| Financial and payment information | No | |
| Authentication information | **Yes** | Our own session tokens, stored locally. No passwords — Twitch handles that |
| Personal communications | **Yes** | Stream-session messages and group messages between users |
| Location | No | |
| Web history | **No** | See below — this is the one worth being careful about |
| User activity | **Yes** | Which Twitch channel you are watching, and clicks on Kickback's own surfaces |
| Website content | No | Kickback does not read, scrape or screenshot page content |

**Why "web history" is No and "user activity" is Yes.** Kickback runs on
`twitch.tv` only, and records the channel you are watching so friends can see
it — that is the product. It does not record URLs, does not track navigation
across sites, and cannot see any other site. Declaring "web history" would be
*more* alarming and less accurate than the truth.

### Certifications we can honestly make

- Not being sold to third parties — **true**, no third-party recipients at all.
- Not used or transferred for purposes unrelated to the single purpose — **true**.
- Not used or transferred to determine creditworthiness or for lending — **true**.

### Nothing needs a product or backend change before submission

The one thing worth flagging is **account deletion**: it works (every table
cascades from `public.users`), but it is a **manual, email-request process**, not
a self-service button. That is acceptable for a 12–20 person beta with the
developer one message away, and it is stated plainly in the policy. It becomes a
real gap at public launch — recorded as P1.

---

## Task 4 — Privacy policy

Drafted at **[`docs/PRIVACY.md`](../PRIVACY.md)**. Written against the
implementation, not from a template: retention numbers come from the migrations,
the "never collected" list comes from the analytics contract, and the visibility
rules come from how presence is actually written.

**Hosting.** The store requires a **publicly reachable URL**, and a file in a
private repo is not one.

**Recommended: GitHub Pages on this repository.** Free, no new account, the
policy stays version-controlled beside the code that makes it true, and the URL
is stable. Enable Pages, and the policy is at
`https://<user>.github.io/project-kickback/PRIVACY.html` — or keep a
`docs/index.md` and let Pages render markdown directly.

If the repository must stay private: a GitHub **Gist**, or any static host. The
requirement is only that it is reachable without a login.

> **OWNER ACTION.** Publish `docs/PRIVACY.md` at a public URL before submitting.
> Update the "Last updated" date and the contact address if it changes.

---

## Task 5 — Store listing package

### Name

```
Kickback BETA
```

Under the 75-character limit. The `BETA` suffix is also what the distribution
docs suggest for a parallel test item, so it does double duty.

### Short description (132 char limit — this is 118)

```
See which friends are watching on Twitch, what they're watching, and jump in with one click. Private beta.
```

### Detailed description

```
Kickback shows you which of your friends are on Twitch right now, what they're
watching, and lets you join them in one click.

It adds a small panel to Twitch — drag it wherever you like, or minimise it to a
button. Nothing else about Twitch changes.

WHAT IT DOES

• See which friends are online and which channels they're watching.
• When several friends end up on the same stream, Kickback groups them so you
  can see where everyone is.
• JOIN takes you straight there.
• Friends already on the stream you're watching show up as HERE.
• When you're watching the same thing, a small session appears beside your
  friends list, with quick emote reactions and a short-lived chat.
• Groups, for the people you watch with regularly.
• Mute anyone locally, or block them outright.

HOW IT WORKS

Sign in with Twitch. Kickback never sees your password — sign-in goes through
Twitch's own page — and the extension contains no secret keys.

Kickback runs on twitch.tv and nowhere else. It cannot see any other site you
visit, and does not ask for permission to.

Add friends by Twitch username or by sharing a Kickback friend code. You only
see people who have added you back.

PRIVATE BETA

This is an early build being tested by a small group. Things will change, and
there's a Feedback button in the account panel — please use it.

Kickback is not affiliated with or endorsed by Twitch Interactive, Inc.
```

### Single purpose statement

```
Kickback's single purpose is to show a Twitch viewer which of their Kickback
friends are currently watching Twitch and what they are watching, and to let
them navigate to the same channel. Every feature — the friends list, the
grouping of friends by channel, the JOIN button, presence, groups, and the
short-lived session chat that appears when friends watch the same stream —
exists to support that one purpose. Kickback runs only on twitch.tv.
```

### Category

**Social & Communication.** Primary and clearly correct — the product is a
friends list. *Entertainment* is the plausible alternative and is worse: it
would put Kickback beside media players, and the single-purpose statement is
about people, not video.

### Permission justifications (paste-ready)

| Field | Text |
| --- | --- |
| `identity` | Used to sign the user in with their Twitch account via `chrome.identity.launchWebAuthFlow`. Kickback holds no OAuth client secret and never sees the user's Twitch password. |
| `storage` | Stores the user's own sign-in session, panel position and locally-muted users in `chrome.storage.local`. A Manifest V3 service worker is terminated when idle, so this state cannot be held in memory. |
| `alarms` | A single periodic alarm refreshes the authentication session and re-reads the friends list if the realtime connection has dropped. A service worker cannot keep a timer across termination. |
| `notifications` | An optional desktop notification when several of the user's friends gather on the same channel. It is a preference the user can turn off in the extension's account panel. |
| `https://*.supabase.co/*` | Kickback's own backend, which stores the user's account, friend list, groups and presence, and provides realtime updates. All application data is held here. |
| `https://7tv.io/*` | Reads the public emote set for the channel being watched, so the extension's chat can display the same emotes the user already sees on Twitch. Read-only and unauthenticated; no user data is sent. |
| `https://cdn.7tv.app/*` | Serves the emote images referenced by that metadata. |
| Host access justification | Kickback's content script runs only on `twitch.tv`, where it renders the extension's own panel and reads which channel the page is showing. It does not read page content, Twitch chat, or any other site. |
| Remote code | Kickback executes no remote code. All logic is contained in the uploaded package. The only external requests are to Kickback's own backend and to 7TV's public emote API for metadata and images. |

### Reviewer / tester instructions — **important**

Kickback shows nothing until you have a friend. A reviewer with one fresh
account will see an empty panel, which is the single most likely reason for a
rejection or a "does not function" note. Give them a way through:

```
Kickback is a social layer for Twitch: it shows you which of your friends are
watching and lets you join them. It therefore needs at least two accounts with
a friendship between them before anything appears.

TO TEST WITH ONE ACCOUNT

1. Install and go to https://www.twitch.tv/ — the Kickback panel appears on the
   right. It works signed out and shows what you're currently watching.
2. Click "Continue with Twitch" and approve. You'll be signed in.
3. The Friends tab shows "Your Kickback is quiet" with a "Find friends" button.
   This is the correct empty state for an account with no friends.
4. Click the avatar (top right of the panel) to open the account panel: your
   Twitch identity, a friend code, presence visibility, and Feedback.

TO SEE THE FULL PRODUCT (recommended)

Use the test account below, which already has friends on Kickback who are
regularly watching. Sign in with it at step 2 instead.

   Twitch username: [OWNER TO PROVIDE]
   Password:        [OWNER TO PROVIDE]

With that account, open any Twitch page: the Friends tab shows friends grouped
by the channel they're watching, with a JOIN button on each. Clicking JOIN
navigates to that channel.

No special hardware, region or paid subscription is required.
```

> **OWNER ACTION.** Create a dedicated Twitch test account, befriend it with one
> or two accounts that are actually watching something, and put the credentials
> in the reviewer-instructions field. Do **not** use your personal account.

### Support and contact

- **Support email:** required for the developer account and shown publicly.
  Currently `chuckdthompson27@gmail.com`. See Task 10 — a project address is
  better before this becomes public-facing.
- **Support URL:** optional. A GitHub issues URL or the Pages site is enough.
- **Homepage URL:** optional.

---

## Task 6 — Asset audit

| Asset | Requirement | Have it? |
| --- | --- | --- |
| Store icon | **128×128 PNG**, required | ✅ `public/icons/icon-128.png`, verified 128×128 RGBA |
| Toolbar icons | 16/32/48/128 | ✅ all four present and correctly sized |
| Screenshots | **1280×800**, **at least 1, at most 5**, PNG or JPEG | ❌ **none** |
| Small promo tile | **440×280**, PNG or JPEG, required | ❌ **none** |
| Marquee promo tile | 1400×560, **optional** | ❌ none — skip it |
| Promo video | YouTube link, optional | ❌ none — skip it |

**Icons are compliant. No icon work is needed.**

> **OWNER CHECKLIST — assets to capture**
>
> No screenshot may be fabricated, so these must be taken from a real signed-in
> Kickback with real friends visible.
>
> 1. **1280×800 — the friends list with friends grouped on a channel.** The
>    single most important image: it is the product in one picture.
> 2. **1280×800 — a JOIN in context**, the panel beside a Twitch stream.
> 3. **1280×800 — friends HERE on the stream you are watching**, ideally with
>    the session tab visible.
> 4. *(optional)* **1280×800 — the account panel**, showing presence visibility
>    and that controls exist.
>
> Capture at 1280×800 exactly, or capture larger and crop — do not upscale.
> Blur or use throwaway accounts if you would rather not show real friends'
> names.
>
> 5. **440×280 small promo tile.** The Kickback mark plus the wordmark on the
>    dark background, with no screenshot inside it — text in a tile that small
>    is unreadable.

---

## Task 7 — Extension identity — the highest-risk item

### Why the current build has that ID

`public/manifest.json` pins a public `key`. **Chrome derives an unpacked
extension's ID from the first 128 bits of SHA-256 over that key**, mapped into
`a`–`p`. That is why every machine loading our files gets
`almhfkicihekhiloapoimglfdoneglni`, and why one Supabase redirect allow-list
entry serves every sideloaded tester. The private half lives in `.keys/` and is
gitignored.

### What happens on upload

**The Chrome Web Store mints its own keypair when an item is created, and the
item ID follows from that.** Our key is a local invention; the store's is the
real one.

The documented flow is the **reverse** of what we did:

1. Upload the package (do not publish).
2. Open the item's **Package** tab → **View public key**.
3. Strip the PEM header/footer and newlines, put the result in the manifest's
   `key` field.
4. Confirm the ID at `chrome://extensions` now matches the dashboard item ID.

There are also reports of the dashboard **rejecting** an upload whose manifest
carries a `key` that does not match the item, with *"key field is not allowed in
manifest"*. Whether it is ignored or rejected is not consistently documented.

**So the store package ships no `key` at all.** That is unambiguously accepted,
and it is what `npm run package:store` now produces.

### The ID **will** change, and here is exactly what that breaks

| Depends on the ID | Breaks? | Fix |
| --- | --- | --- |
| **Supabase redirect allow-list** | **YES — sign-in fails completely** | **OWNER: add `https://<new-id>.chromiumapp.org/` in Supabase → Authentication → URL Configuration** |
| Twitch developer app redirect | **No.** It points at Supabase's callback (`https://<project>.supabase.co/auth/v1/callback`), which never changes | none |
| Supabase project / anon key | No | none |
| `scripts/extension-identity.mjs` | yes | one constant |
| `public/manifest.json` `key` | yes | adopt the store's public key |
| `tests/extension/bundle.test.ts`, `auth.test.ts` | yes | literals; `verify:store` catches them |
| README, PRIVACY, docs | yes | `verify:store` scans prose too |
| Anything else in the code | **No** | Nothing reads `chrome.runtime.id`; the redirect is always `chrome.identity.getRedirectURL()` at runtime |

**The failure mode if the Supabase entry is missed is nasty**: Twitch says yes,
the user approves, and the flow dies on the final hop. It reads as "Kickback is
broken", not as "a URL is missing from a dashboard". It is the single most
likely way this beta starts badly.

### Upgrade from sideloaded to store install

They are **different extensions** to Chrome — different IDs, separate storage,
separate sessions. A tester who installs from the store keeps the sideloaded
copy until it is removed, and would run two Kickbacks at once, each with its own
panel.

> **OWNER ACTION.** Tell testers to remove the sideloaded Kickback at
> `chrome://extensions` **before** installing from the store. They will sign in
> again; their account, friends and groups are all server-side and unaffected.

### The repository change

`scripts/extension-identity.mjs` is now the one place the ID lives, and
`npm run verify:store` recomputes it from the manifest key **and scans every
`.ts`, `.tsx`, `.md`, `.mjs`, `.json` and `.txt` file for an ID that disagrees**
— checkpoint reports excepted, because they are a record of what was true when
written. Rotating the ID is now a two-line edit with a check behind it.

---

## Task 8 — Private distribution

Three visibility options exist, and **all three go through the same review**:

- **Public** — listed and findable.
- **Unlisted** — not listed, installable by anyone with the URL.
- **Private** — installable only by specified users.

**Recommendation: Private, using a Google Group.**

How it works today:

- Testers are named in **account-level trusted testers**, or by adding a
  **Google Group you own**. Group members plus trusted testers can install.
- **Every tester needs a Google account**, and must be signed into Chrome with
  the account you listed.
- The trusted-tester list is **per developer account, not per item**.
- Installation is an ordinary **Add to Chrome** from the item's URL.
- **Automatic updates work**, exactly as for a public item.

**Why a Google Group rather than individual emails.** Adding and removing a
tester becomes a group-membership change instead of a dashboard edit and
(possibly) a re-review, and the list is reusable if a second item ever exists.
For 12–20 people either works; the group is less friction over a few weeks.

**Why not Unlisted.** It looks easier — a link, no Google-account gate — but
anyone with the link can install, and links get forwarded. For a first cohort
whose whole value is a *known* social graph, controlled access is the point.

> **OWNER ACTION.** Create a Google Group (e.g. `kickback-beta@googlegroups.com`),
> add the testers' Google addresses, and name the group under Private
> visibility. Ask testers which Google account they use in Chrome — it is
> frequently not the one you would guess.

---

## Task 9 — Update pipeline

```
0.4.0 published  →  bug found  →  bump to 0.4.1  →  npm run package:store
                 →  upload as a new package  →  review  →  testers auto-update
```

**What changes per release:** `package.json` and `public/manifest.json` version,
together. `npm run verify:store` fails if they disagree, and the store rejects
an upload whose version is not higher than the published one.

**Store packaging is now separate, and had to be.** The beta ZIP nests
everything under `Kickback/` so that Load unpacked has exactly one folder to
select. **The Chrome Web Store requires `manifest.json` at the root** and
rejects a nested package with an error about the manifest being missing — which
reads as a corrupt file rather than a wrong shape. That was a genuine P0: the
artifact we had could not have been uploaded at all.

| Command | Produces | Shape | Manifest key |
| --- | --- | --- | --- |
| `npm run package:beta` | `Kickback-Private-Beta-v<version>.zip` | everything under `Kickback/`, plus `README-TESTERS.txt` | **kept** |
| `npm run package:store` | `Kickback-Store-v<version>.zip` | **manifest at root**, runtime files only | **removed** |

Both run the identical preflight — hosted Supabase config, analytics and
feedback schema, group backend, production-not-demo, `private_beta` stamped in
the worker, file allow-list, secret and demo-marker scan of staging *and* the
finished archive. **The wrong analytics environment cannot be uploaded**: the
packager forces `VITE_KICKBACK_ENV=private_beta` at the build call rather than
inheriting `.env.local`, and then checks the built artifact for the string.

**Verifying what testers actually have.** The version is in the panel's
bottom-left, and testers are asked to quote it. Server-side:

```sql
select properties ->> 'app_version', count(distinct actor_id)
from public.feedback_v group by 1;
```

**Rollback: there is none.** The store has no "revert to previous version"
button. The only remedy is to publish a higher version containing the fix —
which is why the version number must always go up and never be reused.

**Staged rollout** (percentage rollouts) exists for public items. **Not relevant
here** — with 20 testers, a partial rollout means "some unlucky subset does not
get the fix".

**No CI/CD.** Two commands and a browser upload, for 20 people. Automating it
would cost more than it saves and add a place for the wrong environment to leak
in.

---

## Task 10 — Ownership model

### MUST DO before creating the store account

1. **Decide which Google account owns the publisher.** This is the one genuinely
   hard-to-undo decision: the Chrome Web Store publisher account **cannot be
   transferred between individual Google accounts**. Whatever you register with
   owns the listing.
   **Recommendation: create a dedicated project Google account now** — e.g.
   `kickback.app@gmail.com` — and register the publisher with it. It costs
   nothing, takes five minutes, does not require settling the permanent product
   name, and avoids the situation where the product lives on a personal account
   forever.
2. **Enable 2-Step Verification** on that account. The store requires it.
3. **A support email address.** The project Google account's own address is
   fine and is what the listing should show — not a personal address.
4. **A public privacy policy URL** (Task 4).

### SHOULD DO soon

5. **Move the Twitch developer app** to the project account, or at least add it
   as a second owner. It currently holds the OAuth client for every tester.
6. **Add the project account to Supabase** as an owner/admin, so the backend is
   not reachable from exactly one personal login.
7. **A GitHub organisation** owning the repository. Cheap now, awkward later.

### CAN DEFER until public launch

8. Permanent product name and any trademark work.
9. A custom domain and a real website.
10. **Any company formation.** A Chrome Web Store publisher can be an
    **individual**; incorporation is not required to publish, to take a listing
    private, or to run a beta. Revisit it if and when money is involved — it is
    not a blocker and should not be treated as one.

**Registration fee:** Google charges a **one-time developer registration fee**
(historically US$5) per publisher account. Confirm the current amount and
payment method in the dashboard at signup.

---

## Task 11 — Readiness checks added

One new command, one new module, no test-count inflation.

**`npm run verify:store`** — offline, reads files only:

- recomputes the extension ID from the manifest key and compares it with
  `scripts/extension-identity.mjs`;
- **scans the whole repository for an extension ID that disagrees** — including
  markdown, because prose does not fail a test and prose is where the stale copy
  will be;
- requires a **justification sentence for every permission and host permission**,
  and fails on a justification for one that was removed — so a permission cannot
  be added without someone writing the defence out loud;
- refuses `<all_urls>` and refuses `tabs`;
- checks manifest ↔ `package.json` version agreement and the `x.y.z` shape;
- checks the store name and description length limits;
- requires `docs/PRIVACY.md` to exist and to **name every permission the
  manifest requests** and every third-party host;
- checks the icons the manifest declares are actually present.

Screenshots are deliberately **not** checked: a check satisfiable by committing
a placeholder is worse than no check.

`package:beta` keeps every guarantee it had and gained the shared identity
module and a printed SHA-256.

---

## Task 12 — Owner runbook

Starting from *"I have the code and a Google account."*

Steps marked **[you]** cannot be done from here — they need a browser, a Google
login, a payment method, or a screenshot of a running product.

### Phase 1 — before the dashboard

1. **[you]** Create a dedicated project Google account (recommended) and enable
   **2-Step Verification** on it.
2. **[you]** Publish `docs/PRIVACY.md` at a public URL. Simplest: enable GitHub
   Pages on this repository. Note the URL.
3. **[you]** Capture the assets from Task 6 — three or four 1280×800
   screenshots and one 440×280 promo tile.
4. **[you]** Create a Twitch test account for the reviewer, befriend it with an
   account that actually watches things, and note the credentials.
5. `npm run verify:store` — must pass.
6. `npm run package:store` — produces `releases/Kickback-Store-v0.4.0.zip`.

### Phase 2 — the developer account

7. **[you]** Go to the Chrome Web Store developer dashboard and sign in with the
   project account.
8. **[you]** Pay the **one-time registration fee** and complete verification.
   Google may ask for a contact email and address; the address is not shown
   publicly for an unpublished item.

### Phase 3 — create the item

9. **[you]** **Add new item** → upload `Kickback-Store-v0.4.0.zip`.
   *If it is rejected for a manifest key, you have uploaded the beta ZIP by
   mistake — use the `-Store-` one.*
10. **[you]** **Do not publish.** Open the **Package** tab → **View public key**
    and copy it.

### Phase 4 — adopt the store identity ⚠️ **the critical step**

11. Put that key into `public/manifest.json` as `"key"` (one line, no PEM
    header/footer, no newlines).
12. Run `node -e "..."` — or just `npm run verify:store`, which prints the ID the
    new key produces and fails until `EXPECTED_EXTENSION_ID` matches. Update
    `scripts/extension-identity.mjs` to that ID.
13. Fix every stale copy `verify:store` reports, then re-run until it passes.
14. **[you]** In **Supabase → Authentication → URL Configuration**, add
    `https://<new-id>.chromiumapp.org/` to the redirect allow-list. **Leave the
    old one in place** until the sideloaded testers have moved over.
15. Commit the rotation.

### Phase 5 — the listing

16. **[you]** **Store listing** tab: name `Kickback BETA`, the short and detailed
    descriptions from Task 5, category **Social & Communication**, language
    English, upload the screenshots, icon and 440×280 tile.
17. **[you]** **Privacy practices** tab: single purpose statement, the permission
    justifications, the remote-code answer, the data-collection answers from
    Task 3, the privacy-policy URL, and the three certification checkboxes.
18. **[you]** Add the **reviewer instructions** from Task 5, with the test
    account filled in.
19. **[you]** **Distribution** tab: visibility **Private**, and select the Google
    Group (create it first at Google Groups and add the testers).

### Phase 6 — submit

20. **[you]** **Submit for review.** Review for a private item is typically
    faster than for a public one, but there is no guaranteed time — plan for
    days, not hours.
21. **[you]** On approval, install it yourself first from the item URL, signed in
    as a listed tester.
22. **[you]** Smoke test the store build: sign in with Twitch (**this is where a
    missed Supabase redirect shows up**), confirm friends and presence, JOIN,
    and send one Feedback. Confirm the row arrives:
    `select * from public.feedback_v order by created_at desc limit 5;`
23. **[you]** Only then send testers the item URL, telling them to **remove the
    sideloaded Kickback first**.

### Phase 7 — the update test

24. Bump to `0.4.1` in `package.json` and `public/manifest.json`, run
    `npm run verify:store`, then `npm run package:store`.
25. **[you]** Upload as a new package on the same item and submit.
26. **[you]** After approval, confirm a tester's Chrome updates on its own — it
    may take a few hours, or `chrome://extensions` → **Update**. Check the
    version in the panel's bottom-left.

**A note on UI labels.** *Add new item*, *Store listing*, *Privacy practices*,
*Distribution*, *Package*, *Submit for review* are the terms the dashboard uses
today. Google reorganises this dashboard periodically — if a label does not
match, the grouping above is still the right mental model.

---

## Decision

### GO / NO-GO

**GO**, once the two owner P0s are done. Nothing in the code blocks submission.

### P0

1. ~~**The ZIP we produce cannot be uploaded.**~~ **Fixed here.** The store
   requires `manifest.json` at the root; ours nested it under `Kickback/`.
   `npm run package:store` now produces a correctly shaped, key-free package.
2. **The extension ID will change, and Supabase must be told.** Phase 4 of the
   runbook. If missed, sign-in fails for every tester at the last hop.
   **OWNER.**

### P1

3. **Reviewer instructions with a test account.** Kickback shows nothing to a
   lone new account. Without credentials, a reviewer sees an empty panel — the
   most likely cause of a rejection. **OWNER.**
4. **Privacy policy must be publicly hosted.** Written, not yet reachable.
   **OWNER.**
5. **Account deletion is manual.** Correct and complete, but by email. Fine for
   this cohort; a real gap before public launch.
6. **Testers must remove the sideloaded copy**, or run two Kickbacks at once.

### P2

7. `https://cdn.7tv.app/*` is very likely unnecessary. Not removed before
   submission; permissions can be reduced later without re-consent.
8. `https://*.supabase.co/*` could be pinned to the one project subdomain, at
   the cost of hard-coding the project into the manifest.
9. Support email is currently personal. Task 10.

### Files changed

| File | Change |
| --- | --- |
| `scripts/extension-identity.mjs` | **new** — the ID and its derivation, in one place |
| `scripts/verify-store-readiness.mjs` | **new** — the offline readiness gate |
| `scripts/package-beta.mjs` | `--store` mode; shared identity module; prints SHA-256 |
| `package.json` | `verify:store`, `package:store` |
| `docs/PRIVACY.md` | **new** — the privacy policy |
| `docs/checkpoints/chrome-web-store-private-beta-readiness.md` | **new** — this |
| `docs/ROADMAP.md` | distribution decisions recorded |
| `tests/extension/bundle.test.ts` | comment only — why the ID stays a literal |

**No product behaviour changed.** No `src/` file was touched.

### Checks run

| Gate | Result |
| --- | --- |
| `npm run verify:store` | passes |
| `npm run package:store` | `releases/Kickback-Store-v0.4.0.zip`, 171 226 bytes, sha256 `678e54f5832c51ccd0e91fce3e5b76845008b8f5fd10864bbae32a6b50605190` |
| `npm run package:beta` | `releases/Kickback-Private-Beta-v0.4.0.zip`, 173 067 bytes, sha256 `bbb28c539035566058b4059be9566ae6fdfc0c156fd9925f86b03bd21e31a965` |
| store manifest inspected in the archive | at root, **no `key`**, 4 permissions |
| `tests/extension` + `tests/core` | 1334 passed |
| `npm run typecheck` | clean |
| `npm run lint` | clean |
| remote-code scan of both bundles | 0 occurrences of `eval` / `new Function` / `importScripts` |

`tests/db` not run — no DB change. Mutation universe not run.

### Recommended next action

**Phase 1 of the runbook**, in this order: project Google account with 2SV →
publish the privacy policy → capture assets → create the reviewer's test
account. Those four are the whole critical path; everything after them is
mechanical.

---

## Sources

- [Chrome Web Store program policies](https://developer.chrome.com/docs/webstore/program-policies/)
- [User data FAQ](https://developer.chrome.com/docs/webstore/program-policies/user-data-faq)
- [Store listing and assets](https://developer.chrome.com/docs/webstore/cws-dashboard-listing)
- [Distribution and visibility](https://developer.chrome.com/docs/webstore/cws-dashboard-distribution)
- [Manifest `key`](https://developer.chrome.com/docs/extensions/reference/manifest/key)
- [Publish in the Chrome Web Store](https://developer.chrome.com/docs/webstore/publish)
- [Hosting an extension yourself](https://developer.chrome.com/docs/extensions/how-to/distribute/host-on-linux)
- ["key field is not allowed in manifest"](https://groups.google.com/a/chromium.org/g/chromium-extensions/c/x_NBS6_-NKs)
- [Manifest must be at the package root](https://groups.google.com/a/chromium.org/g/chromium-apps/c/LPPiwaF7MbU)
