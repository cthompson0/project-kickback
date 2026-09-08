# Marketing acquisition attribution, and Reddit Ads as the first paid provider

**Date:** 2026-09-08
**Scope:** investigation only. No code changed, no migration written, no
migration applied, nothing deployed, no v0.9 artifact touched.
**Status:** awaiting owner review. Nothing below has been built.

---

## 0. Verdict, in four sentences

**The attribution foundation you are asking for mostly exists.** M5C (0038),
coverage (0040) and the activation denominator (0042) already give trusted,
server-resolved, immutable first-touch campaign attribution joined to the full
product funnel, and — unlike when M5C was written — **it is now carried by
public released builds on both stores**, so the marketing gate is closed on the
extension side.

**The gap is not the data model. It is the two ends of the journey**: the
website measures nothing at all, and the campaign code has no reliable way to
get from the landing page into the extension after an install.

**Reddit CAPI cannot be implemented in V1** — not because it is too much work,
but because Watchside possesses **no valid Reddit matching signal at signup**.
Reddit requires at least one of click ID / email / IP+UA / device IDs, and
Watchside has, by deliberate design, none of them at the moment an account is
created.

**The single highest-value change is not Reddit-shaped at all**: it is fixing
the landing→store→extension handoff, which is currently the step that will
silently eat most of a $200 experiment's attribution.

---

## 1. Existing analytics / event infrastructure

| Piece | Where | What it is |
| --- | --- | --- |
| Event vocabulary | `src/core/analytics.ts` | ~50 named events, each with a closed property list. Pure module — no Supabase, no chrome, no React. |
| Server contract | `supabase/migrations/0013_analytics.sql` | `analytics_event_names` restates the same contract; `tests/extension/analyticsContract.test.ts` proves the two agree. |
| Writer | `analytics_track(jsonb)` | SECURITY DEFINER, actor from `require_actor()`, batch capped at 50, rate-budgeted at 600 events / 5 min, never raises. |
| Server-side emitter | `analytics_emit_server(uuid,text,jsonb)` (0037) | Revoked from every client role. Used by `bind_acquisition`, `referral_succeeded`, `badge_awarded`. |
| Actor registry | `analytics_actors` | `is_internal` set **by hand in SQL**; a modified client cannot un-mark itself. |
| Reportable lens | `analytics_reportable_events_v` (0014) | `analytics_events ⋈ analytics_actors where not is_internal`. **Every** reporting view builds on this. |
| Client pipeline | `src/background/analyticsHub.ts`, `analyticsRecorder`, `analyticsSession.ts` | Queues before auth, flushes after sign-in, fails open (`analyticsFailOpen.test.ts`). |
| Gecko boundary | `EVENT_DATA_CATEGORY` + `firefoxTelemetryBoundary.test.ts` | `technicalAndInteraction` events are dropped entirely on Firefox. |

**Four properties of this system constrain everything that follows:**

1. **There is no anonymous ingestion path.** `analytics_track` is granted to
   `authenticated` only and derives its actor from `auth.uid()`.
   `tests/db/authorizationSurface.test.ts` proves `anon` can execute **no**
   function in `public` and read **no** table. Website visitor measurement has
   no door to walk through today.
2. **Property values are capped at 64 chars** and unknown keys are stripped on
   both sides. A URL, a referrer or a UTM string cannot be carried by an
   analytics property even by mistake — enforced by the shape of the data, not
   by discipline at call sites.
3. **`environment` is a property of the build** (`development` / `private_beta`
   / `production`). A website has no build, so website events do not fit the
   existing envelope without a decision about what to put there.
4. **Every `%_v` reporting view must be revoked from `anon`/`authenticated`**,
   and `authorizationSurface.test.ts` now fails the build if one is not. This
   was a live production security defect found in the v0.9 RC pass and fixed by
   0043; any new view inherits the rule.

---

## 2. The existing M5C acquisition architecture, and what it already solves

### 2.1 The concept split (0038, `src/core/acquisition.ts`)

Three things are kept apart on purpose, with a different URL prefix, a different
query parameter, a different table and a different RPC each:

| Concept | Question | Where it lives |
| --- | --- | --- |
| **acquisition / campaign** | how did this person discover Watchside | `acquisition_campaigns`, `acquisition_attribution`, `/c/<code>`, `?watchside_campaign=` |
| **friend referral** | which existing user invited them | `referrals` (0026), `/i/<code>`, `?kickback_invite=` |
| **creator association** | which creator a campaign is associated with | `acquisition_campaigns.creator_key` |

### 2.2 The trust model

**The URL carries an opaque code and nothing else.** Every fact about what a
campaign *is* — source, creator, label — resolves server-side from
`acquisition_campaigns`, a table with **RLS enabled and zero policies**
(deny-all) plus `revoke all ... from anon, authenticated`. The registry cannot
be enumerated by anybody holding the publishable key that ships inside the
extension.

`?source=official_twitch_partnership` in a URL changes nothing, because nothing
reads it. This is not a mitigation bolted on; it is the reason the code is the
only payload.

### 2.3 Immutability, enforced by triggers

- `acquisition_campaign_immutable()` — `code`, `source` and `creator_key` cannot
  be updated. `label` and `active` can. Rationale: `acquisition_attributed`
  events carry `source` in their properties, so editing a source would silently
  rewrite the meaning of historical events.
- `acquisition_first_touch_immutable()` — `first_campaign_code` and
  `first_touch_at` cannot be updated by anything, including a future
  "just refresh attribution" helper or an `UPDATE` that forgot its `WHERE`.

### 2.4 First touch vs last touch — already modelled

`acquisition_attribution` has **five columns, not one mutable field**:
`first_campaign_code`, `first_touch_at`, `last_campaign_code`, `last_touch_at`,
`touch_count`. First is written once. Last is overwritten freely. The requested
"if last-touch is cheap, propose it" is already shipped.

### 2.5 The binding RPC

`bind_acquisition(p_code text) → text`. SECURITY DEFINER, `search_path` pinned,
takes exactly one argument. **There is no parameter for whose attribution to
write, what source to record, or which creator to credit** — a stronger
guarantee than validating one. Four outcomes, all ordinary: `first`, `repeat`,
`unknown`, `inactive`. Since 0040 all four are recorded (`unknown`/`inactive`
emit `acquisition_touch_rejected`, carrying a reason and never a code).

### 2.6 The pre-auth window

`ATTRIBUTION_WINDOW_MS = 7 days`, enforced **client-side** in one pure function
with its own tests (`isWithinAttributionWindow`). This is deliberate and
correctly reasoned: the server cannot know when a link was clicked, only when a
bind arrived, so an age passed to SQL would be a client assertion wearing a
server check's clothes. Future-dated touches are refused (clock-skew defence).

`nextPendingTouch()` implements first-touch-wins while both are pre-auth; an
**expired** held touch is replaced rather than kept, because it can no longer
bind and holding it would block one that can.

### 2.7 Storage

`CAMPAIGN_TOUCH_KEY = 'watchside:campaignTouch'` in `ext.storage.local`, holding
`{ code, capturedAt }` and nothing else. Persisted (unlike the invite code)
specifically to survive MV3 worker eviction across the install→later-sign-in
gap. Expiry is checked on the way in *and* out. Deleted the moment it binds or
is refused.

### 2.8 What M5C already solves — summary

- trusted, unspoofable campaign identity ✅
- immutable first touch ✅
- last touch and touch count ✅
- 7-day pre-auth window with clock-skew defence ✅
- MV3 eviction survival ✅
- internal/test actor exclusion ✅
- small-cohort rate suppression (n ≥ 3) ✅
- rejected-touch visibility ✅
- attribution coverage denominator ✅
- deletion on account deletion (`on delete cascade`) ✅
- campaign definitions survive account deletion (not user data) ✅
- one-hop downstream viral lineage without overwriting the invitee's own
  acquisition ✅

**This is a well-built system. The milestone should extend it and must not
replace any of it.**

---

## 3. Current landing-site architecture

**`watchside.app` is a fully static GitHub Pages site with no backend, no
cookies, no JavaScript on the landing page, and zero external requests.**

- Source: `docs/web/watchside-app/` (`shell.html` + `pages/*.html` + `landing.css`).
- Build: `scripts/build-site.mjs` → `dist-site/`, pushed to
  `Anoteros-Labs/watchside-app`.
- Second target: `npm run build:site:pages` → `dist-pages/` under `/watchside/`
  on the org Pages site (compatibility tree for shipped builds).
- Privacy page is **generated from `docs/PRIVACY.md`**, so the policy and the
  published page cannot drift.

### Routes

| Route | File | HTTP status |
| --- | --- | --- |
| `/` | `index.html` | 200 |
| `/privacy/` | generated from `docs/PRIVACY.md` | 200 |
| `/support/` | `support.html` | 200 |
| `/i/<code>` | `404.html` (invite branch) | **404** |
| `/c/<code>` | `404.html` (campaign branch) | **404** |
| `/i/`, `/c/` bare | copies of `404.html` | 200 |

### Findings that matter for paid traffic

**F1 — `/c/<code>` returns HTTP 404 and shows the stripped-down page.** GitHub
Pages has no router; `404.html` reads the code out of `location.pathname`. So a
Reddit ad clicking through to `watchside.app/c/rdt-launch-a` lands on a **404
status** page containing a logo, one headline, one paragraph, two store buttons
and a "continue to Twitch" link — **not** the real landing page with the
screenshots, the how-it-works section and the privacy section. That is the page
paid traffic would meet.

**F2 — `index.html` contains no `<script>` at all.** The landing page reads
nothing from the query string. `https://watchside.app/?c=...&utm_source=reddit`
— the shape sketched in the brief — **does nothing today**. Worse, `?c=` is
already claimed: on `404.html` it is the **legacy invite** parameter (22-char
uppercase code). Reusing `?c=` for campaigns would create exactly the
context-dependent ambiguity `src/core/acquisition.ts` was written to prevent.

**F3 — The site's own copy is a load-bearing promise.** `index.html` states, in
the privacy section a visitor reads before installing:

> **No ads, no trackers, no selling.** No advertising SDK, no third-party
> analytics, no fingerprinting. This website sets no cookies.

Installing the Reddit Pixel makes every clause of that sentence false.

---

## 4. Current Chrome / Firefox store CTA implementation

Plain `<a href>` elements. No click handlers, no instrumentation, no parameters.

| File | Chrome CTAs | Firefox CTAs |
| --- | --- | --- |
| `docs/web/watchside-app/pages/index.html` | 2 (hero, finale) | 2 |
| `docs/web/watchside-app/pages/404.html` | 1 | 1 |
| `docs/web/pages-watchside/index.html` | 2 | 2 |
| `docs/web/invite-landing/index.html` | 1 (`CHROME_URL`) | 1 (`FIREFOX_URL`) |

URLs:
- Chrome — `https://chromewebstore.google.com/detail/ngfopkeokddfnncdhfkhnffilbdhkkip`
- Firefox — `https://addons.mozilla.org/firefox/addon/watchside/`

Pinned by `tests/extension/publicRouting.test.ts` (asserts exactly 2 of each on
the root page) and `tests/extension/betaLoop.test.tsx`. A mutation in
`scripts/verify-destruction-tests.mjs` depends on the exact Firefox link line.

**No CTA is measured anywhere, on either surface, today.**

---

## 5. Current signup / account creation / authentication path

This is the finding that decides the Reddit design.

```
extension UI  →  auth.signIn()                    src/background/auth.ts
              →  backend.startOAuth(redirectUrl)  Supabase signInWithOAuth
              →  ext.identity.launchWebAuthFlow() browser identity API
              →  Twitch consent page              (Twitch's own domain)
              →  callback to the extension redirect URL
              →  backend.exchangeCode(code)       Supabase
              →  trigger on auth.users            0004_auth_bootstrap.sql
                   sync_kickback_identity() → public.users, user_preferences,
                                              presence, connected_accounts
              →  analyticsHub.noteSignedIn()      authenticated_session_started
              →  bindPendingCampaign()            bind_acquisition(code)
```

**Signup happens entirely inside the extension. It never touches
`watchside.app`.** There is no web signup page, no web OAuth callback, and no
account-creation form on the site.

Consequences, stated plainly:

- **The Reddit Pixel can never observe a Watchside SignUp.** No client-side
  `rdt('track','SignUp')` is possible, because the browser never loads a
  Watchside page at the moment an account is created.
- **Any SignUp conversion must be server-side, or not at all.**
- `sync_kickback_identity` **deliberately does not copy `auth.users.email`** —
  the migration comment says so explicitly. No Watchside query can reach an
  email.
- The database trigger has **no HTTP request context**: no IP, no user agent, no
  screen dimensions. Watchside stores no IP anywhere, by policy, and there is no
  IP column in the schema.

---

## 6. Existing user / session / database structures relevant to attribution

| Table | Grain | Deletion |
| --- | --- | --- |
| `public.users` | one per account | root of every cascade |
| `analytics_actors` | one per actor analytics has seen | `on delete cascade` |
| `analytics_events` | one per event; `actor_id` always `auth.uid()` | `on delete cascade` |
| `acquisition_campaigns` | one per campaign; **not user data**, survives deletion | never |
| `acquisition_attribution` | **one per actor, ever** — PK is `actor_id` | `on delete cascade` |
| `referrals` (0026) | inviter → invitee | separate concept, untouched by M5C |
| `friendships` | mirrored pair; the cold-start ground truth | `on delete cascade` |
| `connected_accounts` | Twitch login/id per user | `on delete cascade` |

`session_id` in `analytics_events` is a random per-stretch id, explicitly "not
linked to anything outside analytics" — it is **not** a visitor identifier and
must not become one.

**There is no anonymous visitor entity anywhere in the schema.** Introducing one
is a decision, not an implementation detail.

---

## 7. Existing activation / retention / JOIN / dwell events

**There is a canonical activation vocabulary. Nothing needs inventing.**

It is a *derived view*, not a single event — which is stronger, because it
cannot be lost by a client that never sent it. `activation_actor_v` (0042):

| Milestone | Source |
| --- | --- |
| authenticated | `authenticated_session_started` |
| made a friend | `friendships.created_at` — **read from the graph, not telemetry** |
| saw a friend watching | `friend_presence_impression` |
| saw a gathering | `gravity_cluster_impression` |
| **socially useful JOIN** | `m3d_social_joins_v` (0034) — a `join_clicked` that navigated, minted an attribution, and had `social_count > 0` |
| arrived | `join_arrived` |
| watched | `channel_dwell_ended` |
| returned | `active_days > 1` |
| **cold start** | `still_without_friends` = no friendship row has ever existed |

`activation_funnel_v` counts **every stage against all authenticated actors**,
never against the survivors of the previous stage — so a user who signed in,
found an empty panel and left is in every denominator. `cold_start_rate` is the
headline it exists to make sayable.

**Mapping to the funnel in the brief:**

| Requested | Existing semantics |
| --- | --- |
| signup / authenticated user | `authenticated_session_started` |
| activated | `activation_actor_v.first_friendship_at is not null` (the graph), plus `first_friend_presence_at` for "saw value" |
| useful social experience | `first_gravity_at` (`gravity_cluster_impression`) |
| JOIN | `first_social_join_at` (`m3d_social_joins_v`) — the strict one — or `join_clicked` / `join_arrived` for the loose ones |
| retention / repeat usage | `active_days`, `analytics_return_v` (0029) |

Dwell semantics are defined at length in `docs/ANALYTICS.md` §8b and §14.6 (six
named quantities, per-stream, focus as a dimension not a gate, live streams
only). Do not redefine any of them.

---

## 8. Current acquisition reporting views and semantics

All exist; all are **revoked from `anon` and `authenticated`** by 0043.

| View | Grain | Notes |
| --- | --- | --- |
| `acquisition_actor_v` | one row per attributed **non-internal** actor | first/last campaign + source + creator, joined to gravity impressions, join clicks/arrivals, dwell intervals, active days, friend count, downstream invitees, inbound referrer |
| `acquisition_campaign_v` | one row per campaign | counts always shown; **rates NULL below 3 actors**; `rates_reportable` flag; comment says "OBSERVATIONAL, never causal" |
| `acquisition_downstream_v` | one row per (acquired inviter, invitee) | one hop only, deliberately not recursive; **the invitee keeps their own acquisition** |
| `acquisition_coverage_v` | (environment, first app version) | attributed vs unattributed over the **real arrival population**; **deliberately no "direct" column** |
| `acquisition_touch_outcomes_v` | (environment, day, outcome) | accepted + rejected touches; a rising `unknown` means dead links in the wild |
| `activation_actor_v` / `activation_funnel_v` | per actor / per (env, build) | the activation denominator |

Two semantics worth restating because they will be tempting to violate:

- **There is no "direct" bucket and there must not be one.** Watchside cannot
  distinguish somebody who typed the store URL from somebody whose campaign
  touch expired. Both are unattributed. Naming either "direct" invents a fact
  about people. `tests/db/acquisitionCoverage.test.ts` holds this.
- **`first_app_version` is in the grain of both coverage views** because the
  campaign parameter is only read by builds carrying M5C and there is no
  backfill. Accounts created before v0.8 are permanently unattributable.

### Correction to a stale document

`m5c-acquisition-attribution-2026-09-01.md` §22 says *"Zero coverage today. No
released build reads the parameter"* and §24 declares the marketing gate closed.
**That is historical.** Verified against the release artifacts:

```
releases/Watchside-Store-v0.9.0.zip         kickback-content.js  contains watchside_campaign
releases/Watchside-AMO-Candidate-v0.9.0.zip kickback-content.js  contains watchside_campaign
releases/Watchside-Store-v0.8.0.zip         kickback-content.js  contains watchside_campaign
```

Chrome 0.8.0 is public, Firefox 0.9.0 is public. **The extension half of the
marketing gate is open.** The website half is not (§9).

Production schema is at `analytics_schema_version() = 44` — 0038, 0040, 0042,
0043 and 0044 are all applied (owner-verified, G7 report §A14). The "not yet
applied to production" notes at `ROADMAP.md` §469–470 are stale.

---

## 9. Exact gaps between the current system and the desired marketing system

| # | Gap | Severity |
| --- | --- | --- |
| **G-A** | **The landing→store→extension handoff is not automatic.** The touch is only captured if the visitor arrives on `twitch.tv` carrying `?watchside_campaign=`, which only happens if they click "Already installed — continue to Twitch" on the `/c/` page. Install from the store and then open Twitch normally → **no touch, no attribution**. There is no post-install welcome tab (`onInstalled` only calls `auth.initialize()`). | **Critical** — this will eat most of a paid campaign's attribution |
| **G-B** | `/c/<code>` serves **HTTP 404** and the stripped page, not the real landing page | High — poor paid landing experience |
| **G-C** | **No website measurement of any kind.** Landing views, store CTA clicks, Chrome-vs-Firefox choice: all unobservable | High |
| **G-D** | **No anonymous ingestion path exists** in the backend. `anon` can execute nothing | Architectural — closing G-C requires opening the first anon-writable surface, or accepting aggregate vendor data |
| **G-E** | Store URLs are untagged, so the **free** aggregate attribution both stores offer is being discarded | Medium — cheapest win available |
| **G-F** | The campaign registry has **no provider / medium / content / term columns**, so per-creative reporting requires the meaning to live outside the database | Medium |
| **G-G** | No view joins acquisition to `activation_actor_v`. `acquisition_actor_v` predates 0042 and does not know about cold start or social JOIN | Medium |
| **G-H** | No spend record anywhere, so no CPA can be computed inside the database | Low (a spreadsheet is fine at $200) |
| **G-I** | **No Reddit matching signal exists at signup** — see §17 | Decisive for CAPI |
| **G-J** | Landing-page copy and `docs/PRIVACY.md` both promise no trackers / no cookies / no third-party requests | Blocking for the Pixel |

---

## 10. Proposed first-party attribution data model

**Extend the registry. Do not add a parallel visitor-attribution table.**

The insight that resolves the whole UTM question: **`acquisition_campaigns` is
already the trusted metadata store.** UTM parameters exist because most vendors
have nowhere trusted to put marketing metadata, so they put it in the URL.
Watchside has somewhere trusted to put it.

Proposed additive columns on `acquisition_campaigns` (migration 0045):

```
provider   text  null  -- 'reddit' | 'meta' | 'google' | 'tiktok' | 'x'
                       -- | 'producthunt' | 'hackernews' | null (unpaid)
                       -- closed set, check constraint, IMMUTABLE
medium     text  null  -- 'paid_social' | 'organic_social' | 'launch'
                       -- | 'referral' | 'organic_search' | 'press' | 'creator'
                       -- closed set, check constraint, IMMUTABLE
content    text  null  -- creative/variant label, e.g. 'creative_a'. MUTABLE.
term       text  null  -- keyword/targeting label. MUTABLE.
```

- `provider` and `medium` are **immutable** (same trigger, same reason as
  `source`): they are grouping keys a report will treat as stable.
- `content` and `term` are **mutable**, like `label`: they are human names for a
  creative, and renaming a creative must not invalidate a published link.
- `source` stays exactly as it is. `reddit` is **already** in its check
  constraint and in `AcquisitionSource` in `src/core/analytics.ts`. **No change
  to `source` is needed for Reddit.**
- Nothing new is copied into event properties, so nothing here can rewrite
  history.

**Granularity rule: one campaign code per cell you want to compare.** For the
Reddit experiment that is one code per creative:

```
rdt-launch-a   provider=reddit medium=paid_social content=creative_a
rdt-launch-b   provider=reddit medium=paid_social content=creative_b
rdt-launch-c   provider=reddit medium=paid_social content=creative_c
```

`scripts/campaign.mjs` grows `--provider`, `--medium`, `--content`, `--term`
flags and prints the same paste-able SQL. No campaign UI, still.

### Proposed new view (migration 0045)

`acquisition_activation_v` — `acquisition_attribution ⋈ activation_actor_v`,
grouped by campaign, giving per-campaign: authenticated actors, cold-start
actors, friended actors, socially exposed actors, social-JOIN actors, arrived,
watched, returned. Same n ≥ 3 rate suppression. Revoked from `anon` and
`authenticated` **in the same migration** (0043's lesson).

This is the view that answers *"which campaigns produce users who actually use
Watchside rather than merely visit the site"*.

### What I recommend NOT adding to the data model

- No `acquisition_visitors` table.
- No anonymous visitor id column anywhere.
- No `utm_*` columns on any user-scoped table.
- No `referrer` / `landing_url` column on any user-scoped table.
- No provider-specific columns (`rdt_cid`, `fbclid`, …) on any table.

---

## 11. How UTMs / referrers / click IDs coexist with trusted campaign codes

**Recommendation: UTMs are outbound-only. They are generated *from* the registry
and are never read *into* attribution.**

```
                        acquisition_campaigns  (server, deny-all, immutable)
                                   |
                   +---------------+----------------+
                   |                                |
       AUTHORITATIVE ATTRIBUTION            DERIVED MARKETING LABELS
       /c/<code> -> ?watchside_campaign=    ?utm_source=reddit
       -> bind_acquisition(code)              &utm_medium=paid_social
       -> acquisition_attribution             &utm_campaign=launch_test_01
                                              &utm_content=creative_a
       the ONLY thing that becomes          for Reddit's dashboard, the store
       a Watchside fact                     dashboards, and humans reading a
                                            link. NEVER read back.
```

The published Reddit ad URL:

```
https://watchside.app/c/rdt-launch-a/?utm_source=reddit&utm_medium=paid_social&utm_campaign=launch_test_01&utm_content=creative_a
```

- The **path segment** is the trusted identity.
- The **query string** is decoration, and the site continues to read nothing
  from it.
- The UTMs are *redundant with* the code, derived from the same registry row. If
  they disagree, the code wins — silently and by construction, because there is
  no code path in which a UTM can win.

**Why not store the UTMs as debug metadata?** Because storing arbitrary
client-supplied strings in a table later read as authoritative is precisely the
failure 0038 was designed against, and 0040 already refused to store
unresolvable campaign codes for the same reason. The UTMs add no information the
registry does not already hold with more integrity. If a link is mistyped,
`acquisition_touch_outcomes_v` already surfaces it as a rising `unknown` rate.

**Referrers.** `document.referrer` is not read today and should stay that way
for user-scoped data. Reddit strips or downgrades referrers anyway, and a
referrer captured pre-auth and bound to an account is a browsing fact about a
person that Watchside currently does not hold.

**Click IDs (`rdt_cid`, `fbclid`, `gclid`, `ttclid`).** These are advertising
identifiers, not marketing metadata. Carrying one from the website into
extension storage and later transmitting it to an ad platform **is** building an
advertising identity path, and the brief's constraints forbid that without
explicit owner approval. See §17 and §20. Recommendation: not in V1, and if
ever, as its own approved decision with its own privacy disclosure — never as a
side effect of "adding Reddit support".

---

## 12. Proposed first-touch behaviour

**No change. The existing rules are correct and already tested.** Restated so
the review has something concrete to accept or reject:

| Situation | Behaviour | Where |
| --- | --- | --- |
| First campaign touch, nothing held | held | `nextPendingTouch` |
| Second touch while first is held and unexpired | **first wins**, second discarded | `nextPendingTouch` |
| Same code arrives again pre-auth | first wins (`capturedAt` not refreshed) | `nextPendingTouch` |
| Held touch has expired | replaced by the arriving one | `nextPendingTouch` |
| Touch older than 7 days at sign-in | discarded, never offered | `touchIsBindable` |
| Touch dated in the future | refused | `isWithinAttributionWindow` |
| Bind when actor already attributed | `repeat`; **first touch untouched**, last touch + count updated | `bind_acquisition` + trigger |
| Code not in registry | `unknown`, nothing written, rejection event emitted | `bind_acquisition` (0040) |
| Code retired | `inactive`, nothing written, rejection event emitted | `bind_acquisition` (0040) |
| Two tabs bind concurrently | `on conflict (actor_id) do nothing`; loser is a no-op | `bind_acquisition` |
| Network error during bind | touch **kept** for a later attempt; the 7-day window bounds "later" | `bindPendingCampaign` |
| Any server answer at all | touch deleted; no retry | `bindPendingCampaign` |
| Account deleted | attribution row cascades away | FK |

**Campaign-code precedence over UTM precedence over referrer precedence** is not
a runtime decision in this design — the code is the only input, so there is
nothing to rank. That is the property worth preserving.

**Do not change the 7-day window** in this milestone. It is provisional and
should be revisited *with data*, which the Reddit experiment may finally
produce. `acquisition_touch_outcomes_v` plus `acquisition_coverage_v` are the
instruments for that.

---

## 13. Proposed anonymous visitor → website → store → extension → user mechanism

**This is the milestone's real work, and it contains no tracking.**

### 13.1 The problem, precisely

The chain requires the visitor to arrive on `twitch.tv` with
`?watchside_campaign=<code>`. Today the only thing that produces that URL is a
button on the `/c/` page labelled *"Already installed — continue to Twitch"*.
The realistic sequence is:

```
click ad -> /c/rdt-launch-a -> "Add to Chrome" -> store page -> Install
         -> ??? -> eventually opens Twitch -> signs in
```

At `???` the `/c/` tab is usually gone (the store opened in the same tab, or the
person closed it), and nothing takes them back. **The attributed path requires
the visitor to return to a page they have already left and click a second
button.** Every touch lost here is an acquisition that becomes permanently
"unattributed" and — per 0040's deliberate design — indistinguishable from
organic.

### 13.2 Proposed fix: keep the campaign page alive, and make returning to it the natural next step

Three parts, all first-party, none of them tracking:

**(a) Store links from a campaign page open in a new tab.**
`target="_blank" rel="noopener"` on the store CTAs **only when a campaign code
is present**. The `/c/` page survives the install. `rel="noopener"` is required
anyway; `rel="noreferrer"` must **not** be set on the store links, because the
referrer is part of what makes the store-side aggregate attribution in §13.4
work.

**(b) The `/c/` page's post-install step becomes the primary action.**
Once a store link has been clicked, the page rewrites itself to lead with
*"Installed? Continue to Twitch to finish setting up"*, pointing at
`twitch.tv/?watchside_campaign=<code>`. This is a copy and DOM change in
`404.html`, testable with the existing `publicRouting.test.ts` sandbox harness
that already executes that file's inline script.

**(c) `/c/<code>` becomes a real 200 page carrying the full landing content.**
`build-site.mjs` reads a small committed campaign manifest (the codes minted by
`scripts/campaign.mjs`) and emits `c/<code>/index.html` per code — the real
landing page plus the campaign continue-block. `404.html` keeps its `/c/`
handling as the fallback for a code that has not been rebuilt yet, so nothing
regresses.

**What this deliberately does not do:** no `chrome.runtime.onInstalled` tab
opening. It would work, but it is a behaviour change to the **submitted v0.9
extension**, and v0.9 scope is frozen. It belongs in a later release, not here.

### 13.3 What remains structurally unobservable — and stays that way

- Which store page a person visited, per person.
- Whether they installed.
- The link between a website visit and an install.
- Cross-device journeys (click on phone, install on desktop).
- Reinstalls.

None of these is recoverable without cross-site tracking or a permanent
anonymous identifier. **Do not attempt them.**

### 13.4 What *is* available for free, aggregate-only, today

Both stores report tagged traffic to the developer, with no code, no cookie, no
privacy change, and no first-party data leaving Watchside:

| Store | What it reports | Source |
| --- | --- | --- |
| **Chrome Web Store** | listing **page views** broken down by `utm_source` / `utm_medium` / `utm_campaign` in the revamped developer dashboard (CSV export available). Installs are **not** broken down by UTM. | [Chrome for Developers](https://developer.chrome.com/blog/cws-analytics-revamp) |
| **AMO** | **downloads** broken down by appended UTM parameters, in the Developer Hub statistics dashboard. 40-char cap per value. Counts only downloads originating from the AMO listing page. | [Firefox Extension Workshop](https://extensionworkshop.com/documentation/manage/monitoring-extension-usage-statistics/) |

So: **tag the store URLs.** Chrome gives you "how many people from this campaign
reached the Chrome listing"; AMO gives you one step further — "how many
downloaded". That is a genuine landing→store→(Firefox) install funnel, aggregate
and non-identifying, for the cost of editing six `href`s.

**Recommended tagging** (derived from the registry, same values as the ad URL):

```
.../detail/ngfopkeokddfnncdhfkhnffilbdhkkip?utm_source=watchside_site&utm_medium=<medium>&utm_campaign=<code>
.../firefox/addon/watchside/?utm_source=watchside_site&utm_medium=<medium>&utm_campaign=<code>
```

On a campaign page the code is known and substituted client-side; on the plain
landing page it is the constant `organic`.

---

## 14. Funnel map with OBSERVED / ATTRIBUTED / INFERRED / UNOBSERVABLE

| # | Transition | Class | Instrument | Note |
| --- | --- | --- | --- | --- |
| 1 | Ad impression | **UNOBSERVABLE to Watchside** | Reddit dashboard only | Vendor-reported, unverifiable |
| 2 | Ad click | **UNOBSERVABLE to Watchside** | Reddit dashboard only | Reddit's click count is the denominator you will never own |
| 3 | Landing page view | **UNOBSERVABLE today** | — | Becomes OBSERVED only with a first-party beacon or the Reddit Pixel. See §15 |
| 4 | Chrome store CTA click | **UNOBSERVABLE today → INFERRED (aggregate) with tagging** | CWS page views by UTM | A page view is not a click, but it is a tight, upper-bounded proxy |
| 5 | Firefox store CTA click | **UNOBSERVABLE today → INFERRED (aggregate) with tagging** | AMO downloads by UTM | AMO reports downloads, i.e. one step *past* the click |
| 6 | Store page → install (Chrome) | **UNOBSERVABLE** | — | CWS does not break installs down by source |
| 7 | Store page → install (Firefox) | **INFERRED (aggregate)** | AMO tagged downloads | Download ≠ install; treat as an upper bound |
| 8 | Install → extension running | **OBSERVED** (post-auth only) | `extension_session_started` | Requires a signed-in actor to be recorded at all |
| 9 | Campaign code reaches the extension | **OBSERVED, client-local** | content script → `ext.storage.local` | Reported nowhere until it binds. **Conditional on §13.1** |
| 10 | Signup / authenticated | **OBSERVED** | `authenticated_session_started` | |
| 11 | Campaign bound to account | **ATTRIBUTED** | `bind_acquisition` → `acquisition_attribution` | Server-authoritative. This is where acquisition becomes a fact |
| 12 | Cold start escaped (first friend) | **OBSERVED** | `friendships.created_at` via `activation_actor_v` | Read from the graph; cannot be lost |
| 13 | Saw a friend watching | **OBSERVED** | `friend_presence_impression` | |
| 14 | Useful social experience (gathering) | **OBSERVED** | `gravity_cluster_impression` | |
| 15 | Social JOIN | **OBSERVED** | `m3d_social_joins_v` | The strict definition; already canonical |
| 16 | Arrival at destination | **OBSERVED** | `join_arrived` | |
| 17 | Viewing time | **OBSERVED, partial** | `channel_dwell_ended` | Only what Watchside sees; six named quantities in ANALYTICS §14.6 |
| 18 | Retention / repeat use | **OBSERVED** | `active_days`, `analytics_return_v` | |
| 19 | Downstream invitees | **ATTRIBUTED, reconstructable** | `acquisition_downstream_v` | A join, never a copied value |
| 20 | Reddit-reported conversions ↔ Watchside counts | **WILL NOT RECONCILE** | — | Different populations, windows and loss modes. Do not build a reconciliation report; document the discrepancy |

**Steps 3–7 are the whole of what a conventional ad-tech setup would claim to
observe, and Watchside will observe none of them at the individual level.** That
is the honest boundary. Everything from 9 onwards is stronger than what most
products have, because it is server-authoritative and joined to real behaviour.

---

## 15. Proposed website event model

Three options. I recommend the first for this experiment.

### Option W0 — no website event collection (recommended for V1)

Rely on: Reddit's own click count (upstream), CWS/AMO tagged aggregates
(midstream), and `bind_acquisition` (downstream). Distinguish creatives by
**minting one campaign code per creative**, so creative-level comparison happens
entirely inside trusted first-party attribution and needs no visitor measurement
at all.

- Cost: zero code on the site, zero privacy change, zero consent question, zero
  new abuse surface, no promise broken.
- Loss: no landing-view count you own; no Chrome-vs-Firefox CTA split you own.
- For a $200 / ~10-day read this is enough to answer *"did Reddit produce
  Watchside users, and which creative"*, which is the actual question.

### Option W1 — first-party aggregate beacon (deferred; owner decision)

A single Supabase Edge Function `POST /site-event` accepting a **fixed enum**
(`landing_view`, `store_cta_chrome`, `store_cta_firefox`) plus a campaign code,
writing to a new `site_events` table with **no visitor identifier, no IP, no
referrer, no user agent** — aggregate counts only, keyed
`(day, event, campaign_code)`.

This is the only honest way to own steps 3–5, and it is genuinely small. But:

- it opens the **first anonymous-writable surface in the entire backend**, which
  `authorizationSurface.test.ts` currently proves does not exist;
- it needs its own abuse story (an unauthenticated counter is a free
  denial-of-wallet and a free way to poison a metric);
- it needs a privacy-policy paragraph.

**Recommend deferring to its own approved milestone.** It is not required for
Reddit and should not be smuggled in under a Reddit ticket.

### Option W2 — third-party analytics SaaS

**Explicitly forbidden by the constraints without owner approval.** Not
recommended: it breaks the same promise the Reddit Pixel breaks, for less
benefit.

---

## 16. Proposed Reddit Pixel integration and exact event mapping

Designed in full so it can be built on approval. **See §26.2 for why I recommend
holding it.**

### 16.1 What the Pixel can and cannot see on `watchside.app`

| Reddit standard event | Available on the site? |
| --- | --- |
| `PageVisit` | ✅ |
| `Lead` / `Custom` | ✅ (repurposed as store CTA) |
| `SignUp` | ❌ **impossible** — signup happens in the extension (§5) |
| `Purchase`, `AddToCart`, `AddToWishlist`, `ViewContent`, `Search` | not applicable |

### 16.2 Proposed event set — the smallest that is useful

| Watchside moment | Reddit event | Fires where | Conversion ID |
| --- | --- | --- | --- |
| Landing or campaign page loaded | `PageVisit` | `/`, `/c/<code>` | page-load nonce |
| Chrome store CTA clicked | `Custom`, name `StoreCtaChrome` | click handler | random UUID per click, guarded once per page load |
| Firefox store CTA clicked | `Custom`, name `StoreCtaFirefox` | click handler | random UUID per click, guarded once per page load |

Reddit's optimisation model wants **one** conversion event to optimise toward.
With signup unobservable, the only candidate is a store CTA click — which is a
**self-reported intent proxy**, not an install and not an account. Reddit would
be optimising for "people who click Add to Chrome", which correlates with but is
not the outcome. **State that limitation in the ad account, not just here.**

Explicitly **not** sent to Reddit: anything from the extension, anything about
friends, JOINs, dwell, activation, or retention, and no Watchside event name.
The Pixel sees three page-level facts and nothing else. Watchside first-party
analytics remains the source of truth.

### 16.3 Configuration

- Pixel ID from `WATCHSIDE_REDDIT_PIXEL_ID`, read by `scripts/build-site.mjs` at
  build time and injected into `shell.html`'s `{{HEAD}}` slot.
- **Absent env var → the snippet is not emitted at all.** No placeholder, no
  dead script tag, no console noise. A local `npm run build:site` produces
  today's byte-identical tracker-free site. A test should assert exactly this.
- Never emitted for the `dist-pages` subpath build — that tree is the org Pages
  compatibility surface and is not where ads land.

### 16.4 Pixel settings to review before enabling

- **Advanced Matching** (`email`, `phoneNumber`, `externalId`, `aaid`, `idfa` in
  the `rdt('init', …)` options): **pass none of them.** Watchside has no email on
  the website and must not acquire one.
- **First-party cookies** are on by default and set `_rdt_uuid` (~90-day
  first-party advertising identifier). `rdt('disableFirstPartyCookies')` exists.
  Disabling it reduces match rate substantially — but it is the difference
  between "the site sets no cookies" being false and merely weakened. **This is
  an owner decision and must be made explicitly, not defaulted.**
- **Data processing options** (`dpm: 'LDU'`, `dpcc`, `dprc`) exist in the
  official GTM template and are the mechanism for limited data use.

Sources: [reddit/reddit-gtm-template](https://github.com/reddit/reddit-gtm-template/blob/master/template.tpl),
[Reddit Pixel help](https://business.reddithelp.com/s/article/reddit-pixel).

---

## 17. Does Reddit CAPI belong in V1? — **No. And not for cost reasons.**

### 17.1 The decisive finding: Watchside has no valid matching signal

Reddit requires **at least one** user identifier per conversion event. The full
list, against what Watchside actually possesses at the moment an account is
created:

| Reddit signal | Available at Watchside signup? | Why not |
| --- | --- | --- |
| `click_id` (`rdt_cid`) | ❌ | Lives in the website URL. Would have to be carried website → Twitch → extension storage → bind, i.e. **build an advertising click identifier into the extension**. Explicitly gated by the brief's constraints. |
| `email` (SHA-256) | ❌ by design | `sync_kickback_identity` **deliberately does not copy `auth.users.email`**. Sending a hashed user email to an ad platform also contradicts *"No selling or sharing of personal data with third parties"* in `docs/PRIVACY.md`. |
| `phone_number` (SHA-256) | ❌ | Never collected. |
| `external_id` (SHA-256) | ⚠️ derivable | A salted hash of `actor_id` is possible — but Reddit has never seen that id, so it matches nothing. It provides **deduplication, not attribution**. |
| `ip_address` (SHA-256) | ❌ | The account is created by a **database trigger on `auth.users`** with no HTTP context. Watchside stores no IP anywhere and has no IP column. |
| `user_agent` | ❌ | Same reason. |
| `screen_width` / `screen_height` | ❌ | Device characteristics. Collecting them is explicitly forbidden. |
| `_rdt_uuid` | ❌ | A first-party cookie on `watchside.app`, unreadable by the extension. |
| `idfa` / `aaid` | ❌ | Desktop browser extension. Do not exist. |

**A Reddit CAPI `SignUp` event from Watchside today would carry no identifier
Reddit can attribute to a click.** It would be a zero-match event, contribute
nothing to optimisation, and produce a conversion count Reddit could not tie to
any campaign. Building it would be building telemetry that reports to nobody.

This is not "CAPI is not worth $200 of spend". It is **CAPI is not implementable
under the current architecture and the stated privacy constraints.**

### 17.2 The secondary reason: the experiment is too small for optimisation

$20/day × 10 days ≈ $200. On Reddit, desktop-targeted Twitch/gaming-community
CPCs realistically put that at a few hundred clicks in total. Reddit's conversion
optimisation needs meaningful weekly conversion volume to leave the learning
phase. A SignUp count in the low single digits optimises nothing; the model runs
on prior alone. For this experiment, **manual/CPC bidding with creative-level
first-party attribution will produce a cleaner read than conversion optimisation
on a starved signal.**

### 17.3 The comparison, as requested

| | A. Pixel + first-party | B. Pixel + CAPI + first-party | **A0. First-party only (recommended)** |
| --- | --- | --- | --- |
| Reddit can optimise toward | store CTA click (proxy) | nothing better — SignUp cannot match (§17.1) | clicks / impressions |
| Watchside owns landing + CTA counts | yes, via a third party | yes, via a third party | no (aggregate store data only) |
| Creative-level attribution to real users | yes, via campaign codes | yes, via campaign codes | **yes, via campaign codes** |
| New third-party script on `watchside.app` | yes | yes | **no** |
| Cookies set | `_rdt_uuid` (~90d) unless disabled | same | **none** |
| Privacy-policy rewrite required | yes | yes, larger | **none** |
| Landing-page "no trackers" copy | must be rewritten | must be rewritten | **unchanged** |
| Consent mechanism needed for EU/UK | yes | yes | **no** |
| Ad-blocker loss | high (see §29) | high on the Pixel half | n/a |
| New secrets | none | `REDDIT_CONVERSION_ACCESS_TOKEN` | none |
| New failure domain near signup | none | must be engineered out | none |
| Build cost | small | medium | **smallest** |

### 17.4 When CAPI *would* become right

All three must be true:

1. The owner explicitly approves carrying `rdt_cid` (or an equivalent click ID)
   through the extension handoff, with the privacy disclosure that implies; **or**
   Watchside gains a web-based signup surface where the Pixel can see the
   conversion directly.
2. §13's handoff fix is deployed and `acquisition_coverage_v` shows the chain
   actually holding for paid traffic.
3. Spend is large enough that optimisation, rather than measurement, is the
   point.

---

## 18. If CAPI is approved later — proposed integration

Documented now so approval does not require re-investigation.

### 18.1 Contract (verified against current third-party implementations)

```
POST https://ads-api.reddit.com/api/v3/...conversions/events
     (v2.0 form: https://ads-api.reddit.com/api/v2.0/conversions/events/{account_id})
Authorization: Bearer <REDDIT_CONVERSION_ACCESS_TOKEN>
Content-Type: application/json

{ "events": [ {
    "event_at": <unix ms, 13-digit>,          // NOT seconds - a known trap
    "event_type": { "tracking_type": "SIGN_UP" },
    "action_source": "WEBSITE",
    "click_id": "<rdt_cid>",                  // the only signal that matters
    "user": { ... },
    "event_metadata": { "conversion_id": "<dedup id>" }
} ] }
```

Tracking types: `ADD_TO_CART`, `ADD_TO_WISHLIST`, `LEAD`, `PAGE_VISIT`,
`PURCHASE`, `SEARCH`, `SIGN_UP`, `VIEW_CONTENT`, `CUSTOM`. `event_at` must be
within 7 days of the event. Sources:
[Tealium](https://docs.tealium.com/server-side-connectors/reddit-conversions-connector/),
[Commanders Act](https://doc.commandersact.com/features/destinations/destinations-catalog/reddit-conversions-api),
[Reddit CAPI help](https://business.reddithelp.com/s/article/Conversions-API).

### 18.2 Placement

A Supabase **Edge Function** `reddit-conversions`, following the exact pattern of
`supabase/functions/twitch-metadata/index.ts`: secrets from `Deno.env`, never
returned, never logged, never reachable by a client.

### 18.3 Failure isolation — the hard constraint

**Reddit must never be in the signup path.** Proposed shape:

```
bind_acquisition()  --(only when the campaign's provider = 'reddit')-->
        insert into reddit_conversion_outbox (actor_id, event, ...)
        wrapped in `exception when others then null` - a failed insert
        must not roll back the attribution, let alone the signup
                                |
              pg_cron (available: v1.6.4, verified in production)
              every 5 minutes ----> drain the outbox via the Edge Function
                                |
                    +-----------+------------+
                delivered                  failed
                mark + keep 30d            attempts+1, exponential backoff,
                                           give up at 6, surface in an ops view
```

- **Idempotency:** `conversion_id` is deterministic and unique per (actor,
  event): `encode(sha256(actor_id::text || ':signup' || <server salt>), 'hex')`.
  A SignUp happens once per account, so retries, repeated OAuth callbacks,
  extension reconnects and worker revivals all produce the same id, and Reddit
  deduplicates by (event name, conversion_id).
- **The outbox row's primary key is `(actor_id, event)`** — the database refuses
  a second SignUp row for the same actor. Duplicate conversions become
  structurally impossible rather than defended against.
- `pg_net` availability must be verified before committing to this shape; the
  fallback is a scheduled Edge Function invoked by pg_cron, which is what
  Supabase's own Cron UI does underneath.

### 18.4 Exact event mapping (if built)

| Watchside fact | Reddit `tracking_type` | Trigger point |
| --- | --- | --- |
| `bind_acquisition` returned `'first'` for a `provider='reddit'` campaign | `SIGN_UP` | server, inside the bind |
| — nothing else — | | |

**Never** report landing, page visit, store CTA click, or extension install as
`SIGN_UP`. Those may be sent as `PAGE_VISIT` / `Custom` from the Pixel if the
Pixel is enabled, and are separate events with separate conversion IDs.

Note the semantic: `'first'` means *first campaign attribution*, which is not
identical to *account creation* — an account created organically that later
clicks a Reddit link would fire. If exact signup semantics are required, gate on
`acquisition_attribution.first_touch_at` being within a short window of
`users.created_at`. **Flagging this rather than deciding it.**

---

## 19. Pixel / CAPI deduplication strategy

**The strongest answer is structural: under the design above, no logical event is
ever sent by both surfaces.**

| Event | Pixel | CAPI |
| --- | --- | --- |
| `PageVisit` | ✅ website only | ✗ |
| `StoreCtaChrome` / `StoreCtaFirefox` | ✅ website only | ✗ |
| `SignUp` | ✗ (impossible, §5) | ✅ server only, if ever built |

Deduplication is therefore not load-bearing for correctness. It is still
specified, because Reddit dedupes on **(conversion event name, conversion ID)**
and a shared id costs nothing:

| Hazard | Defence |
| --- | --- |
| Page refresh re-firing `PageVisit` | Accepted — a refresh *is* a page visit. Reddit's own session logic handles it |
| Double-click on a store CTA | Per-page-load `fired` flag; the second click sends nothing |
| Back-button return to the campaign page | `pageshow` with `event.persisted` does not re-fire the CTA event |
| CAPI retry from the outbox | Deterministic `conversion_id` (§18.3) — byte-identical on every attempt |
| Repeated OAuth callbacks | `bind_acquisition` returns `'repeat'`, which does not enqueue |
| Two tabs binding concurrently | `on conflict (actor_id) do nothing` already; only one `'first'` exists |
| Extension reconnect / worker revival | The touch is deleted after any server answer; a second bind is `'repeat'` |
| Signup retry after a failed exchange | One `auth.users` row → one attribution row → one outbox row (PK) |

---

## 20. Reddit matching signals and data minimisation

Full inventory of what *would* be sent, with a recommendation on each. **Under
the recommended V1 (§26) nothing in this table is sent, because neither the Pixel
nor CAPI is enabled.**

| Signal | Purpose | Hashed? | Where hashed | Watchside stores it? | Recommendation |
| --- | --- | --- | --- | --- | --- |
| `rdt_cid` (click ID) | the only real click→conversion match | no | n/a | **no** | **Do not carry.** Requires ad-identifier plumbing through the extension. Owner decision, separate milestone |
| `email` | match | SHA-256 | would be server-side | **no** (deliberately not copied from `auth.users`) | **Never send.** Contradicts existing policy |
| `phone_number` | match | SHA-256 | — | no | **Never send.** Not held |
| `external_id` | match / dedup | SHA-256 | server-side, salted | derivable from `actor_id` | Send **only** as a salted hash if CAPI is ever built, understanding it provides dedup, not attribution. Never send a raw Watchside user id |
| `ip_address` | match | SHA-256 | — | **no** | **Never send.** No IP column, and no IP at the trigger |
| `user_agent` | match | no | — | no | **Never send** |
| `screen_width` / `screen_height` | match | no | — | no | **Never send.** Device characteristics |
| `_rdt_uuid` | Reddit's own first-party cookie | no | — | no (Reddit's) | Only exists if the Pixel is enabled and first-party cookies are left on. Owner decision |
| `idfa` / `aaid` | mobile match | SHA-256 | — | no | N/A |
| `conversion_id` | dedup only | SHA-256 by Reddit if unhashed | server-side | derived | Safe. Carries no user meaning |
| `event_at` | timing | no | — | yes | Safe |
| `tracking_type` | event kind | no | — | yes | Safe |

**Rule to hold:** anything sent to Reddit must be either (a) a fact about a
campaign, or (b) a salted derived identifier meaningless outside Watchside.
Nothing that identifies a person, nothing about their device, nothing about
their behaviour inside the product.

**Secrets:** `REDDIT_CONVERSION_ACCESS_TOKEN` is a non-expiring bearer token and
must exist only as a Supabase function secret. It must never appear in
`.env.example`, `.env.local`, the site build, the extension bundle, or any
committed file. `scripts/verify-store-readiness.mjs` and
`scripts/verify-candidate.mjs` already scan artifacts for secrets; the check
should be extended to name it.

---

## 21. Proposed migrations

**One, and only if the registry extension is approved.**

**`0045_acquisition_provider_metadata.sql`** — additive only:

1. `alter table acquisition_campaigns add column provider / medium / content /
   term`, with check constraints on the two closed sets.
2. Extend `acquisition_campaign_immutable()` to cover `provider` and `medium`
   (leave `content` / `term` mutable, like `label`).
3. `create or replace view acquisition_campaign_v` to expose the four new
   columns (additive shape; no released client reads it).
4. `create or replace view acquisition_activation_v` — campaign ⋈
   `activation_actor_v`, n ≥ 3 suppression.
5. **`revoke all on public.acquisition_activation_v from public, anon,
   authenticated;`** in the same migration.
6. Bump `analytics_schema_version()` to 45 and update the pin in
   `tests/db/bundle.test.ts`.

No table is dropped, no column changes type, no function signature changes, no
grant is widened. Chrome 0.8/0.9 and Firefox 0.9 call none of it.

**Deferred, needing separate approval:**
- `site_events` + an anonymous ingest function (Option W1, §15).
- `reddit_conversion_outbox` + pg_cron drain (§18).
- `acquisition_campaign_spend` (recommend a spreadsheet at this scale).

---

## 22. Proposed environment / configuration variables

| Variable | Where | Required? | Behaviour when absent |
| --- | --- | --- | --- |
| `WATCHSIDE_REDDIT_PIXEL_ID` | build-time, read by `scripts/build-site.mjs` | no | **Snippet not emitted at all.** Site is byte-identical to today |
| `WATCHSIDE_SITE_BASE` | build-time (optional) | no | defaults to `https://watchside.app` |
| `REDDIT_CONVERSION_ACCESS_TOKEN` | Supabase function secret | only if CAPI is built | function returns 503; outbox rows drain to `skipped` |
| `REDDIT_ADS_ACCOUNT_ID` (or pixel id for CAPI) | Supabase function secret | only if CAPI is built | same |
| `REDDIT_CONVERSION_SALT` | Supabase function secret | only if CAPI is built | function refuses to run rather than sending an unsalted id |

None of these goes anywhere near the extension bundle. `.env.example` gets the
first two, documented as build-only and optional.

---

## 23. Exact files / services likely to change

### V1 (recommended scope) — no privacy change

| File | Change |
| --- | --- |
| `supabase/migrations/0045_acquisition_provider_metadata.sql` | **new** |
| `tests/db/bundle.test.ts` | schema version pin 44 → 45 |
| `tests/db/acquisition.test.ts` | new columns; immutability of `provider` / `medium` |
| `tests/db/authorizationSurface.test.ts` | passes unchanged; proves the new view is revoked |
| `scripts/campaign.mjs` | `--provider`, `--medium`, `--content`, `--term` |
| `docs/web/watchside-app/pages/404.html` | campaign continue-block promotion; `target="_blank"` on store CTAs when a code is present; UTM-tagged store URLs |
| `docs/web/watchside-app/pages/index.html` | UTM-tagged store URLs (4 links) |
| `scripts/build-site.mjs` | emit `c/<code>/index.html` per minted code from a committed manifest |
| `docs/web/watchside-app/campaigns.json` (or similar) | **new** — the codes to pre-render. No secrets; mirrors the registry |
| `docs/web/pages-watchside/index.html` | regenerate (a test asserts it matches the build output) |
| `tests/extension/publicRouting.test.ts` | CTA counts, new `/c/<code>` route, tagged URLs |
| `scripts/verify-destruction-tests.mjs` | the Firefox-link mutation string if that line moves |
| `docs/ROADMAP.md`, `docs/ANALYTICS.md` | new views + the corrected marketing-gate state |
| `docs/OPERATIONS.md` | "when to pause marketing" — the gate is no longer closed |

**Not touched:** any file under `src/`, any `dist*` tree, any `releases/*.zip`,
the extension manifest, the privacy policy.

### If the Pixel is approved — additionally

| File | Change |
| --- | --- |
| `docs/web/watchside-app/shell.html` | pixel snippet into `{{HEAD}}`, conditional |
| `scripts/build-site.mjs` | read `WATCHSIDE_REDDIT_PIXEL_ID`; inject or omit |
| `docs/web/watchside-app/pages/index.html` | **rewrite the "No ads, no trackers" bullet** |
| `docs/PRIVACY.md` | §"What Watchside never does", §"How you found Watchside", §"Where your data goes" |
| `dist-pages` privacy copy | regenerate |
| `tests/extension/sitePixel.test.ts` | **new** — absent env → no snippet; no advanced-matching fields present |

### If CAPI is approved — additionally

`supabase/functions/reddit-conversions/`, a `reddit_conversion_outbox`
migration, an ops view, and `docs/OPERATIONS.md` runbook entries.

---

## 24. Privacy-policy / consent implications

### V1 (recommended): **no privacy-policy change is required at all**

Nothing new is collected. Campaign codes are already documented in
`docs/PRIVACY.md` §"How you found Watchside". Tagged store URLs send a UTM
string to Google and Mozilla inside a URL the visitor is already navigating to;
they collect nothing about the person on Watchside's behalf and Watchside
receives no per-person data back. Worth one clarifying sentence, not a policy
change.

### If the Pixel is approved: three published promises become false and must be rewritten *before* deployment

1. `docs/web/watchside-app/pages/index.html`:
   > "No ads, no trackers, no selling. No advertising SDK, no third-party
   > analytics, no fingerprinting. **This website sets no cookies.**"
2. `docs/PRIVACY.md` §"What Watchside never does":
   > "**No third-party analytics or tracking of any kind.** No Google Analytics,
   > no Meta pixel, no TikTok pixel, no advertising SDK… **The watchside.app
   > website sets no cookies and makes no requests to anyone else at all.**"
3. `docs/PRIVACY.md` §"How you found Watchside":
   > "**It is not a cookie, not a tracking pixel**, and not a third-party
   > analytics or advertising product — Watchside uses none of those, anywhere."

There is a fourth clause the Pixel arguably strains:
> "No advertising, ever, and no use or transfer of your data for personalised,
> retargeted or interest-based advertising."

The Reddit Pixel's `_rdt_uuid` exists precisely to build advertiser audiences. If
the Pixel ships, that sentence must be narrowed to the extension, or the
audience-building behaviour must be disabled and said so.

**Consent.** `_rdt_uuid` is a non-essential first-party advertising identifier.
Under ePrivacy Art. 5(3) and UK PECR, EU/UK visitors require prior informed
consent before it is written. **Watchside has no consent banner and no consent
infrastructure.** Options, in order of preference:

1. **Geo-target the Reddit campaign to non-EU/UK only**, and record that
   decision. Cheapest, and reasonable for a US-oriented Twitch test.
2. Ship the Pixel with `rdt('disableFirstPartyCookies')` — reduces but does not
   eliminate the question, since the Pixel still discloses page visits to Reddit.
3. Build a consent gate. Disproportionate for a $200 test.

**Store disclosures are unaffected.** The Pixel is on the website, not in the
extension, so the Chrome Web Store data-use declarations and the Firefox
`data_collection_permissions` in `scripts/manifest.mjs` do not change. Worth
saying explicitly, because it is the first thing a reviewer would ask.

**Account deletion.** Watchside-side attribution already cascades on deletion.
**Data already sent to Reddit does not.** If CAPI is ever built, the policy must
say that a conversion already reported to Reddit cannot be recalled by deleting
a Watchside account, and that Reddit's own retention governs it. Do not imply
otherwise.

---

## 25. CSP / security implications

**Today `watchside.app` loads zero external resources.** Every style is inline,
the favicon is a data URI, the only images are same-origin `.webp` files, and
there is no external script anywhere. That is an unusually strong posture and it
is currently free.

- **No CSP header exists**, and GitHub Pages cannot set response headers. The
  only available mechanism is `<meta http-equiv="Content-Security-Policy">`,
  which cannot express `frame-ancestors` or `report-uri`. **Recommendation
  independent of Reddit: add a strict meta CSP now**, while the site genuinely
  has nothing external to allow. One addition to `shell.html`, and it converts
  today's good posture into an enforced one.
- **The Pixel forces the CSP open**: `script-src https://www.redditstatic.com`
  plus `'unsafe-inline'` or a hash for the bootstrap snippet, plus `img-src` /
  `connect-src` for Reddit's beacon hosts. Once `'unsafe-inline'` is present the
  CSP stops being a meaningful XSS control for the whole site.
- **Third-party JS on the invite/campaign routing page.** `404.html` is the file
  that reads codes out of `location.pathname` and builds the Twitch handoff link.
  Loading Reddit's script into that same document gives a third party full DOM
  access to Watchside's referral routing. A compromise of Reddit's CDN would
  execute on `watchside.app`. This is a real, if low-probability, escalation and
  is the security argument against the Pixel that carries the most weight.
- **Open-redirect surface: unchanged.** `404.html` can only ever build a link to
  `twitch.tv` or the two store URLs — no destination comes from the URL. Any
  change to that file must preserve this; `publicRouting.test.ts` already tests
  it.
- **Referrer.** The store links must keep sending a referrer for §13.4 to work,
  so `rel="noreferrer"` must **not** be added. `rel="noopener"` must be, with
  `target="_blank"`. The referrer sent is `https://watchside.app/c/<code>` — a
  campaign code, not a person.

---

## 26. Testing and verification plan

### 26.0 Tests to add

| Area | Test | Asserts |
| --- | --- | --- |
| Registry | `tests/db/acquisition.test.ts` | `provider`/`medium` reject out-of-set values; both are immutable after insert; `content`/`term` are editable |
| New view | `tests/db/acquisition.test.ts` | `acquisition_activation_v` returns one row per campaign; rates NULL below 3 actors; internal actors excluded |
| Authorization | `tests/db/authorizationSurface.test.ts` (existing) | passes unchanged — proves the new `%_v` view is not client-readable |
| Bundle | `tests/db/bundle.test.ts` | `analytics_schema_version()` = 45 |
| Site routing | `tests/extension/publicRouting.test.ts` | `/c/<code>` pre-rendered pages exist and carry the continue link; the invite path is unchanged; no destination is taken from the URL |
| Store CTAs | `tests/extension/publicRouting.test.ts` | every store link carries the UTM triplet; counts still 2 + 2 on the root page; `rel="noopener"` present, `noreferrer` absent |
| Campaign copy | `tests/extension/publicRouting.test.ts` sandbox | the campaign branch promotes the continue step after a store click |
| Pixel (if built) | `tests/extension/sitePixel.test.ts` | absent env → the built site contains no `redditstatic` reference at all; present env → exactly one snippet, no `email`/`externalId`/`aaid`/`idfa` in the init options |
| Secrets | `scripts/verify-candidate.mjs` | no Reddit token string in any artifact |

### 26.1 Production verification, before any spend

1. `npm test` green; `npm run test:authz` green (mutation harness).
2. Apply 0045; confirm `analytics_schema_version()` = 45.
3. `npm run build:site`; publish; then check with `curl`:
   - `https://watchside.app/c/<code>` → **200**, full landing content;
   - store links carry the UTM triplet;
   - the continue link points at `twitch.tv/?watchside_campaign=<code>`.
4. **One real end-to-end bind in production**, by hand, on a non-internal test
   account: click the campaign link, install, continue to Twitch, sign in, then
   confirm one row in `acquisition_attribution` and one
   `acquisition_attributed` event with `touch='first'`.
5. Confirm `acquisition_touch_outcomes_v` shows the touch, and
   `acquisition_coverage_v` moves.
6. Only then publish the ad.

### 26.2 Why I recommend holding the Pixel

Not a refusal — it is designed in §16 and can be built on approval. The
reasoning, so the decision is yours on the facts:

- The Pixel cannot see a signup, so its best available conversion is a
  self-reported store-CTA click.
- Watchside's audience — Twitch users who install browser extensions — has an
  unusually high ad-blocker and tracking-protection rate. Firefox strict ETP and
  uBlock both block Reddit's pixel. Expect large, unquantifiable loss on exactly
  the population you are buying.
- The cost is not the code. The cost is that *"No ads, no trackers, no selling…
  this website sets no cookies"* is currently on the landing page **as a selling
  point**, twenty lines above the install button, in a product whose pitch is
  "it knows where you are watching, that is all". Trading that for a proxy
  metric on a $200 test is a bad exchange.
- If the goal is "did Reddit work", **one campaign code per creative answers it
  with better data than the Pixel would**, because it is joined to real
  activation rather than to clicks.

**If you decide to run the Pixel anyway** — for optimisation, for a future larger
campaign, or because Reddit's ad review prefers it — the design in §16 stands,
and the honest sequence is: rewrite the copy first, make the cookie/consent
decision explicitly, then ship it behind the env var.

---

## 27. Future dashboard compatibility

The proposed shape leaves a clean path without building anything for it:

- Everything is **structured relational data in named columns**, not a
  Reddit-shaped blob. `provider`, `medium`, `content`, `term`, `source`,
  `creator_key` are queryable dimensions.
- `acquisition_activation_v` already produces, per campaign: acquired,
  authenticated, cold-start, friended, socially exposed, social JOIN, arrived,
  watched, returned. Add a spend number from anywhere and the CPA table in the
  brief falls out of one join.
- **Coverage travels with the numbers.** `acquisition_coverage_v` and
  `acquisition_touch_outcomes_v` mean a future dashboard can render the
  denominator beside the headline instead of shipping a believable, wrong chart.
- Internal-actor exclusion and n ≥ 3 suppression are enforced **in the views**,
  so any consumer inherits them and cannot accidentally read raw per-actor rows
  (0043 revokes them from every client role).

**Not built, deliberately:** no export pipeline, no dashboard schema, no metrics
service, no generic event bus.

---

## 28. How future acquisition providers plug in

| Provider | What it takes |
| --- | --- |
| Meta / Google / TikTok / X ads | add the value to the `provider` check constraint (one migration line); mint codes; publish `/c/<code>?utm_…` links. Their pixels, if ever wanted, are the same §16 decision with the same cost |
| Product Hunt / Hacker News | `provider = 'producthunt'` / `'hackernews'`, `medium = 'launch'` / `'referral'`. Nothing else |
| Creator partnerships | already supported — `source = 'creator'`, `creator_key`. Shipped since 0038 |
| Organic social | mint codes with `medium = 'organic_social'`. Untagged organic remains correctly unattributed |
| Organic search / direct | **structurally unattributable and must stay so.** No "direct" bucket — 0040 refused to build one and `tests/db/acquisitionCoverage.test.ts` holds that |
| Referral / invite campaigns | a **different system** (`referrals`, 0026). Do not fold them together. `acquisition_downstream_v` already expresses the relationship as a join |

The property that makes this cheap: **provider knowledge lives in exactly one
table, and no client, no URL and no event carries a provider-specific field.**

---

## 29. Risks, blockers, unresolved questions, unavoidable gaps

### Adversarial pass — what I tried to break

| Attack / failure | Outcome | Residual risk |
| --- | --- | --- |
| Spoofed campaign attribution | Impossible to fabricate meaning; a forged code resolves to `unknown` and writes nothing | Someone can *claim* an existing campaign brought them. Cost: one inflated count. Same as an invite code; accepted since 0038 |
| Arbitrary UTM poisoning | **Structurally impossible** — nothing reads UTMs | none, provided the "outbound-only" rule holds. It should be stated in a code comment where a future reader will meet it |
| Campaign-code enumeration | Registry is deny-all RLS with zero policies, revoked from `anon`/`authenticated` | Codes appearing in public ads are public by design. The *list* stays private |
| First-touch overwrite | Trigger raises `23514`; the column is absent from every `SET` list | none |
| Conflicting campaign inputs | First held touch wins pre-auth; `repeat` post-auth | deliberate, documented |
| Duplicate conversions | Structural: no event is sent by both surfaces; outbox PK is `(actor, event)` | only if CAPI is built |
| Refresh-generated duplicates | `PageVisit` on refresh is correct; CTA guarded per page load | low |
| Repeated OAuth callbacks | `bind_acquisition` → `'repeat'`, no enqueue | none |
| Bot traffic | **Unmitigated at the website layer today**, and the main risk of Option W1. At the attribution layer a bot must complete Twitch OAuth to be counted | Paid social attracts click fraud; Reddit's click count will exceed reality. Your first-party count is the defensible one |
| Internal / test traffic | Excluded by `analytics_actors.is_internal`, set by hand in SQL. Every view builds on `analytics_reportable_events_v` | **The owner clicking their own ad still costs money and still appears in Reddit's numbers.** Only Watchside's side excludes it |
| Ad blockers / tracking protection | The first-party path is **immune** — one path segment and one query parameter, no script, no cookie, no third-party host. The Pixel is heavily blocked | This asymmetry is the strongest argument for the recommended architecture |
| Reddit script failure | Site has no dependency on it; the snippet is async and the page works without it | none, if the CTA handler does not await `rdt()` |
| Reddit API failure | Outbox + backoff; never in the signup path | only if CAPI is built |
| Extension install attribution discontinuity | **Unavoidable and acknowledged.** Mitigated, not solved, by §13 | the dominant source of undercount |
| OAuth redirect losing attribution | Does not apply — OAuth happens in the extension, after the touch is already in `ext.storage.local` | none |
| MV3 service-worker eviction | Solved since M5C: the touch is persisted, not held in memory, and expiry is checked on read | none |
| Chrome vs Firefox differences | Both carry the campaign parameter (verified in the artifacts). Firefox additionally drops `technicalAndInteraction` events — none of the acquisition events are in that category. AMO reports tagged downloads; CWS reports tagged page views | Funnels are comparable at the attribution layer; **not** at the store layer, and a report must not present them as one series |
| Accidental PII leakage | Analytics properties are capped at 64 chars with unknown keys stripped on both sides. Campaign codes match a strict alphabet | The Pixel, if enabled, sends full page URLs to Reddit — including `/c/<code>` and `/i/<code>`. **An invite code would be disclosed to Reddit** if a visitor holding an invite link loads a pixel-bearing page. If the Pixel ships it must be omitted from `404.html`, or the URL scrubbed |
| Referrer leakage | Store links will send `https://watchside.app/c/<code>` — a campaign code, not a person | acceptable, and required for §13.4 |
| CSP expansion | see §25 | material if the Pixel ships |
| Third-party script / XSS | see §25 — Reddit's script would run in the document that routes invites | material if the Pixel ships |
| Account deletion | Attribution cascades. Data already at Reddit does not | must be disclosed if CAPI is ever built |
| Analytics emitted before consent | V1 collects nothing new, so the question does not arise. It arises immediately with the Pixel | see §24 |
| Reddit ↔ Watchside discrepancy | **Guaranteed.** Reddit counts clicks it served; Watchside counts accounts that bound a touch. Different populations, windows and loss modes | Do not build a reconciliation report. Publish both with their definitions |

### Blockers and open questions for the owner

1. **Pixel: yes or no?** If yes, the copy rewrite and the cookie/consent decision
   happen *before* deployment, not after.
2. **`rdt_cid` through the extension: yes or no?** This is the gate on CAPI ever
   being useful. My recommendation is no for now.
3. **`_rdt_uuid` first-party cookie: on or off?** Only relevant if (1) is yes.
4. **Geo-targeting**: is the Reddit campaign US-only? It changes the consent
   answer materially.
5. **Option W1 (first-party aggregate beacon)**: worth its own milestone, or not
   worth having landing/CTA counts at all?
6. **Are any `/c/` links already published anywhere?** If so, pre-rendering codes
   must not change an existing URL.
7. **Spend recording**: spreadsheet, or a table? Recommend a spreadsheet at this
   scale.
8. **`pg_net` availability** in the Supabase project — needed only if CAPI is
   ever approved.

### Unavoidable gaps, stated rather than papered over

- No click → install → account chain will ever be complete.
- Cross-device journeys are unattributed.
- Reinstalls lose the touch.
- Never signing in means never attributed — correctly, since there is no account
  for the fact to be about.
- Accounts created before v0.8 are permanently unattributable.
- **Every one of these biases attribution downwards.** A campaign will be
  credited with less than it produced, never more. For a spend decision that is
  the safe direction, and it is worth saying out loud when the numbers come in
  looking small.

---

## 30. What I explicitly recommend NOT building

1. **Reddit CAPI in V1.** No valid matching signal exists (§17.1).
2. **A permanent anonymous visitor ID.** Not needed for anything above.
3. **Any fingerprinting or device-characteristic collection.**
4. **`rdt_cid` carriage through the extension**, unless separately approved.
5. **UTM values stored on any user-scoped table.** They add no information the
   registry does not hold with more integrity, and they add a poisoning surface.
6. **A `direct` bucket.** 0040 refused it; a test holds it.
7. **A generic event-collection service / Segment or Amplitude clone.**
8. **A third-party analytics SaaS.**
9. **A campaign management UI.** `scripts/campaign.mjs` remains correct.
10. **A dashboard.** Data model only.
11. **A Reddit↔Watchside reconciliation report.** They will not reconcile;
    documenting why is more useful than a chart implying they should.
12. **`chrome.runtime.onInstalled` opening a welcome tab in this milestone** — it
    is a change to the frozen v0.9 extension. Revisit for v1.0.
13. **Changing the 7-day window** before there is data about the real
    click-to-auth lag.
14. **Any change to `dist*`, `releases/*.zip`, or the submitted v0.9 artifacts.**

---

## 31. Smallest safe implementation sequence, after approval

Each step is independently shippable and independently revertible.

| # | Step | Touches | Risk / value |
| --- | --- | --- | --- |
| **1** | **Tag the store URLs with UTMs.** Six `href`s + regenerate `pages-watchside`; update `publicRouting.test.ts` | website only | ~zero risk. Unlocks free aggregate Chrome/Firefox funnel data immediately |
| **2** | **Fix the handoff.** `target="_blank" rel="noopener"` on campaign-page store CTAs; promote the "Continue to Twitch" step after a store click | `404.html` + tests | low. **Highest attribution value per line changed** |
| **3** | **Add a strict meta CSP** while the site still loads nothing external | `shell.html` + test | low. Do this before any decision about the Pixel |
| **4** | **Migration 0045** — registry metadata + `acquisition_activation_v` + revokes + version bump. Apply to production once the DB suite is green | backend | low, additive only |
| **5** | **`scripts/campaign.mjs`** gains the new flags; mint the Reddit creative codes; **do not publish them yet** | tooling | none |
| **6** | **Pre-render `/c/<code>` as real 200 pages** from a committed manifest | `build-site.mjs` + test | low. Removes the 404-status landing page |
| **7** | **Publish the site.** Verify each `/c/<code>` returns 200, store links carry UTMs, and one end-to-end bind works in production before spending anything | deployment | **this is the go/no-go gate** |
| **8** | **Run the Reddit experiment** with per-creative codes and manual/CPC bidding | ads | — |
| **9** | *(only if approved)* **Reddit Pixel** — copy rewrite and consent decision first, then the env-gated snippet | website + policy | medium; reversible by unsetting the env var and rebuilding |
| **10** | *(only if approved, and only after §17.4 is satisfied)* **CAPI** | backend + secrets | highest; keep it out of the signup path |

**Steps 1–7 require no privacy-policy change, add no third-party script, set no
cookie, and collect nothing new about anybody.** They are the milestone.

---

## Recommended architecture — summary

```
        Reddit Ads
            |  one ad URL per creative, each with its own campaign code
            v
  watchside.app/c/rdt-launch-a/            <- real 200 landing page (new)
      ?utm_source=reddit&utm_medium=paid_social
      &utm_campaign=launch_test_01&utm_content=creative_a
            |                                 ^ decoration. never read.
            |
            +--> store CTA (new tab, UTM-tagged) --> CWS page views / AMO downloads
            |                                        (aggregate, free, vendor-side)
            |
            +--> "Continue to Twitch"  --> twitch.tv/?watchside_campaign=rdt-launch-a
                        ^                            |
              the page survives the install          v
              because the store opened in     content script -> ext.storage.local
              a new tab (the fix)             {code, capturedAt}, 7-day window
                                                     |
                                              sign in -> bind_acquisition()
                                                     |
                              +----------------------+----------------------+
                       acquisition_attribution                  acquisition_campaigns
                       (immutable first touch)                  provider / medium /
                                                                content / term  <- NEW
                                                     |
                       acquisition_actor_v . acquisition_campaign_v
                       acquisition_coverage_v . acquisition_touch_outcomes_v
                       acquisition_activation_v  <- NEW (x activation_actor_v)
```

**Reddit is an adapter over this, not a layer inside it.** The registry's
`provider` column is the entire extent of Reddit's presence in the data model.
Adding Meta, Google, TikTok, Product Hunt or a creator partnership is: add a
value to the enum, mint codes, publish links. No schema redesign, no new tables,
no new code paths.

### The tradeoffs, stated plainly

| Choice | You gain | You give up |
| --- | --- | --- |
| First-party only | no promise broken, no consent question, no third-party script, creative-level attribution to *activated users* | landing-view and CTA counts you own; Reddit optimises on clicks only |
| Campaign code per creative | trusted per-creative comparison with zero URL trust | more codes to mint; codes are visible in the URL (they are not secret, and possession grants nothing) |
| UTMs outbound-only | no poisoning surface at all | no interoperability with tools that expect to *read* UTMs — none are in use |
| Aggregate store data | free, no privacy change, real Chrome/Firefox split | vendor-reported, coarse, not joinable to a person (which is the point) |
| Deferring CAPI | no new failure domain near signup, no secrets, no unmatched events | Reddit cannot optimise toward signup — which it could not do anyway (§17.1) |
| Deferring the site beacon | no anon-writable backend surface | no first-party landing/CTA counts |

---

## Sources consulted for the Reddit contract

- [Reddit official GTM template](https://github.com/reddit/reddit-gtm-template/blob/master/template.tpl) — pixel init options, standard event list, `conversionId`, `disableFirstPartyCookies`
- [Reddit Ads Help — About the Reddit Pixel](https://business.reddithelp.com/s/article/reddit-pixel)
- [Reddit Ads Help — About the Conversions API](https://business.reddithelp.com/s/article/Conversions-API)
- [Tealium — Reddit Conversions connector](https://docs.tealium.com/server-side-connectors/reddit-conversions-connector/) — v3 endpoint, field list, hashing rules, required-identifier rule
- [Commanders Act — Reddit Conversions API](https://doc.commandersact.com/features/destinations/destinations-catalog/reddit-conversions-api) — payload schema, `tracking_type` values
- [mParticle — Reddit event integration](https://docs.mparticle.com/integrations/reddit/event/) — hashing and deduplication behaviour
- [Chrome for Developers — CWS analytics revamp](https://developer.chrome.com/blog/cws-analytics-revamp) — UTM breakdown of *page views*
- [Firefox Extension Workshop — monitoring usage statistics](https://extensionworkshop.com/documentation/manage/monitoring-extension-usage-statistics/) — UTM breakdown of *downloads*, 40-char cap

---

**Nothing in this report has been implemented. Awaiting owner approval.**
