# Privacy policy — accuracy pass

**Date:** 2026-09-02
**Commit:** `5d3b65b0e92d8df1e34865cc7a1fa8728f9ffe50`
**Deployed:** both live copies updated and verified
**Scope:** `docs/PRIVACY.md` accuracy and durable verification. No product
behaviour was changed.

---

## 1. Verdict

The policy was substantially accurate and unusually specific — the retention
periods, the encrypted Twitch credential, the write-time visibility rule and the
Firefox diagnostic boundary all check out against code exactly as written.

**Three things were wrong in ways worth fixing, and one of them was a claim the
implementation could not support.**

1. It described a product that no longer exists — a "private beta (v0.4.x)",
   Chrome-only, with a promise to narrow a permission "at its next release" that
   the next release did not keep.
2. **Two third parties the extension contacts were not disclosed**, and a third
   was described only as a permission.
3. **"Two places, and nowhere else"** left a reader to infer that no other server
   learns anything about them. Every HTTP request reveals an IP address. The
   policy now says so, and says what Watchside does with it (nothing).

**The trap the brief warned about was real.** Removing `cdn.7tv.app` from host
permissions before Firefox v0.8 did **not** stop it being contacted — it is
still fetched by every emote image in the panel. It stays disclosed; only its
description as a *permission* was wrong. §3.

---

## 2. Every substantive change

| # | Change | Evidence |
| --- | --- | --- |
| 1 | `Applies to: … private beta (v0.4.x)` → the extension for Chrome and Firefox, plus the website | Firefox 0.8.0 public on AMO; Chrome 0.7 live, 0.8 pending |
| 2 | Removed "currently in a small private beta" from *Who runs it* | same |
| 3 | Removed "This is a private beta … told to beta testers directly" from *Changes*; points at the canonical URL instead | same |
| 4 | **Added a table of every host the browser contacts** | §3 |
| 5 | **Added "What any web request unavoidably reveals"** — IP addresses | §4 |
| 6 | `chrome.storage.local` → named for both browsers | `src/platforms/browser/gecko.ts`; AMO build uses `browser.storage.local` |
| 7 | "Chrome's `identity` API" → "the browser's `identity` API" | both engines use it |
| 8 | "background service worker" → "background script" | Gecko MV3 uses an event page, not a service worker |
| 9 | Rewrote the host-permission bullets; **dropped the "will be narrowed at its next release" promise** | §5 |
| 10 | `storage` bullet now lists what is actually stored | §6 |
| 11 | Feedback diagnostics "complete list" gained the two fields it was missing | §7 |
| 12 | "touch any other site" → "run on any other site" | §8 |

The **Last updated** date moved from 25 August to 2 September 2026, which
changes 4, 5 and 9 warrant. Nothing else in the document's structure, legal
character or existing commitments was altered.

---

## 3. The third parties — what is actually contacted

Derived from source, not from the manifest:

| Host | How it is reached | Was it disclosed before? |
| --- | --- | --- |
| `7tv.io` | `fetch` from `background/sevenTv.ts` — emote-set lookup | yes |
| `cdn.7tv.app` | `<img>` in `ui/components/EmoteImage.tsx`, URL built in `core/emotes.ts:126` | **only as a permission** |
| `static-cdn.jtvnw.net` | Twitch avatars and Twitch emotes, `core/emotes.ts:129` and `Avatar.tsx` | **no — not at all** |

**`cdn.7tv.app` is still contacted.** `core/emotes.ts:126` builds
`https://cdn.7tv.app/emote/{id}/{size}.webp` and `EmoteImage.tsx:138` renders it.
Image loads are governed by the page's CSP rather than by host permissions, which
is why the permission could be removed — the request could not.

One genuine protection was undocumented and is now stated: emote images carry
`referrerPolicy="no-referrer"` (`EmoteImage.tsx:145`), so 7TV is not told which
page the image was rendered on. Avatars do not set it, so the policy claims it
only for the emote CDN.

**Watchside talks to Twitch's API only from the server** — there is no
`api.twitch.tv` reference anywhere in `src/`, confirmed by enumerating every
`https://` host in the source. That matches what the policy already said.

---

## 4. The IP-address statement, and why it was added

The brief asked to distinguish what Watchside intentionally stores from ordinary
infrastructure processing. The old wording did not.

**Evidence for the claim now made:** no `ip`, `ip_address`, `inet` or
`user_agent` column exists in any of the 39 migrations, and no such value appears
in `analytics_events` (whose columns are `actor_id`, `environment`, `event_name`,
`session_id`, `occurred_at`, `received_at`, `app_version`, `source`,
`properties`) or in the server-rebuilt feedback context.

So the policy now says both halves: every request reveals an IP because that is
how a reply gets back to you; Watchside stores none, and the host processes them
as any host does. **No retention period was invented for it** — we do not control
or measure the provider's.

---

## 5. Permissions — what each browser actually asks for

Verified against three artifacts, not assumed:

| | `permissions` | `host_permissions` |
| --- | --- | --- |
| **Firefox 0.8.0** (approved, live on AMO) | identity, storage, alarms, notifications | `ezikxbbcwcxhkboeekkk.supabase.co/*`, `7tv.io/*` |
| **Chrome 0.7.0** (live) | same | `*.supabase.co/*`, `7tv.io/*`, `cdn.7tv.app/*` |
| **Chrome 0.8.0** (submitted) | same | `*.supabase.co/*`, `7tv.io/*`, `cdn.7tv.app/*` |
| **Source** (next Chrome build) | same | `*.supabase.co/*`, `7tv.io/*` |

The old text said the Chrome wildcard "will be narrowed to match at its next
release". **v0.8 was that release and it shipped with the wildcard**, so the
sentence was a broken promise. The policy now describes the difference as a fact,
explains that a permission is a ceiling rather than a description of use, and
commits to no schedule.

---

## 6. Data categories, retention and deletion — all verified

| Claim | Evidence |
| --- | --- |
| Stream-session messages deleted after 30 minutes | `0021_room_messages.sql:209` — `created_at < now() - interval '30 minutes'` |
| Reactions swept after about a minute | `0020_stream_rooms.sql:299` — `interval '1 minute'` |
| Campaign code discarded after seven days | `core/acquisition.ts:171` — `ATTRIBUTION_WINDOW_MS = 7 * 24 * 60 * 60 * 1000` |
| Presence is transient and overwritten | `presence.user_id` is the primary key — one row per person, no history |
| Visibility applied when presence is **written** | `0003_rpcs.sql:78` — `invisible` writes `status='offline', platform=null, channel=null` |
| Analytics values capped at 64 chars, unknown keys discarded | `0013_analytics.sql:290` |
| Deleting the account removes everything, analytics included | `functions/delete-account/index.ts` — purges the Twitch credential first, then `auth.admin.deleteUser` cascades `public.users` |
| Disconnecting Twitch removes only the Twitch-derived layer | same file — `purge_twitch_derived` is a separate step, deliberately |

**Local storage** now listed accurately: session, panel position and size, muted
people, analytics session id, and in-progress viewing stretches — matching the
`kickback:` keys in source (kept in code for compatibility; the name does not
appear in the policy).

---

## 7. Feedback diagnostics

The policy said "that is the complete list" and was missing two fields the server
accepts. From `0023_feedback.sql:135` the allowlist is: `app_version`,
`environment`, `browser`, `surface`, **`collapsed`**, `channel`,
**`on_channel`**, `friend_count`, `session_available`, `social_sync`,
`presence_sync`. Both are now named.

The Firefox omission is real: `background/index.ts:1990` —
`...(IS_GECKO ? {} : { browser: browserName() })`, and `jsonb_strip_nulls` drops
the absent key.

---

## 8. Store declaration consistency

**Firefox — consistent.** AMO reports `data_collection_permissions` of
`authenticationInfo`, `browsingActivity`, `personalCommunications`,
`websiteActivity`, with **no optional categories**. That is exactly the four-row
table in the policy, and the "Firefox collects none" section is backed by
`src/core/analytics.ts`, where exactly three events are classified
`technicalAndInteraction` (`client_error`, `realtime_status_changed`,
`group_message_send_failed`) and dropped before the queue on Gecko
(`background/analytics.ts:191`).

**Chrome — cannot be verified from the repository.** The Web Store's data-use
declarations live in the developer console; the repo keeps permission
justifications but not those checkboxes. §10.

**watchside.app — now consistent.** The landing page's "Runs on Twitch only"
card said Watchside "touches any other site"; since it does fetch emote images,
both it and the policy now say "runs on any other site", which is the claim the
code supports.

---

## 9. Verification

| Gate | Result |
| --- | --- |
| Full suite | **3,108 passed / 128 files** |
| Destruction mutations | **100 / 100 detected** (was 97) |
| `npm run lint`, `npm run typecheck` | clean |
| `npm run build:site`, `build:site:pages`, `npm run build` | clean |
| `npm run verify:store` | clean |

**`tests/extension/privacyAccuracy.test.ts` (14 new).** The load-bearing one
derives the host list **from source**, so a new third party cannot be contacted
without the policy naming it. Proved by pointing `emotes.ts` at
`cdn.undisclosed-example.net` and watching it fail with that host named.

Also pinned: no private-beta framing, no version number that a release would
falsify, no `Kickback` in public text, not Chrome-only language, every manifest
permission explained, `cdn.7tv.app` not presented as a permission, no
promises about future releases, the four Firefox categories explained, exactly
three diagnostic events, and the IP statement present.

Deliberately **not** pinned: dates, version numbers, or wording a clarity edit
should be free to change.

**Three destruction levers** make it permanent: drop a third party from the
disclosure list, contact a new third party without disclosing it, and describe
the shipped product as a private beta. The first was retargeted mid-run — it
originally removed one of two `cdn.7tv.app` mentions, which is not a loss of
disclosure, so it now removes the Twitch CDN row, which is named exactly once.

---

## 10. Owner action

**One, and it is a store-console change I cannot make.**

The Chrome Web Store listing name is **"Watchside BETA"** (reported by
`npm run verify:store`; the manifest name is "Watchside", and the divergence was
intentional at the time). Watchside is now published on two stores and the
privacy policy no longer describes a beta. The listing name is the last place
that framing survives.

**Required:** decide whether to rename the Chrome listing, in the Web Store
developer console. If it is renamed, `scripts/verify-store-readiness.mjs`
expects the current name and will need its expectation updated with it.

**Also worth a look, same console:** the Chrome Web Store *Privacy practices*
data-use declarations are not recorded in the repository, so I could not check
them against this policy. They should assert the same categories the Firefox
declaration does. I have not changed anything there.

Nothing else is outstanding. Both published copies of the policy are live,
current and identical in substance:

| | |
| --- | --- |
| `watchside.app/privacy` | `Anoteros-Labs/watchside-app` `e88460e` |
| `anoteros-labs.github.io/watchside/privacy/` | `Anoteros-Labs/anoteros-labs.github.io` `1dab75d` |

The subpath copy is normally left untouched so a routine publish cannot clobber
a live policy page by accident. That protection does not apply to a deliberate
policy update, and two published privacy policies that disagree would be worse
than the thing the convention guards against.
