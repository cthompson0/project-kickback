# Acquisition V1: the first-party attribution foundation — implementation

**Date:** 2026-09-08
**Scope:** approved steps 1–7. Built, tested, and stopped at the owner-action boundary.
**Status:** **NOT deployed. Migration NOT applied. No ad spend. No E2E proof yet.**

*Runtime state updated 2026-09-08: Twitch sign-in has since been recovered on a
replacement Twitch application. Friend presence is still broken after login, so
the remaining blocker is **Twitch integration / presence recovery**, not "no
sign-in". That incident is out of scope here — see §19 step 0.*

The durable architecture is in **`docs/ANALYTICS.md` §16**. This report is state
and handoff, not design.

---

## 1. What was implemented

All seven approved steps, plus the documentation pass.

| # | Step | State |
| --- | --- | --- |
| 1 | UTM-tag both store URLs | done, derived from the registry |
| 2 | Fix the landing → store → Twitch handoff | done |
| 3 | Strict meta CSP | done, on every page |
| 4 | Migration 0045 | written, tested, **not applied** |
| 5 | `campaign.mjs` metadata flags | done |
| 6 | Mint the three Reddit creative codes | done, **not published** |
| 7 | Pre-render `/c/<code>/` as real 200 pages | done |

Nothing from the deferred list was built. No Pixel, no CAPI, no `rdt_cid`, no
cookie, no anonymous visitor entity, no beacon, no dashboard, no spend table, no
campaign UI, and no change to the 7-day window.

---

## 2. Files changed

**New**

| File | What |
| --- | --- |
| `supabase/migrations/0045_acquisition_provider_metadata.sql` | the migration |
| `scripts/campaign-vocabulary.mjs` (+ `.d.mts`) | one closed-set vocabulary |
| `docs/web/watchside-app/campaigns.json` | committed campaign manifest |
| `docs/web/watchside-app/js/route.js` | the invite/campaign routing, extracted |
| `docs/web/watchside-app/js/campaign.js` | promotes the continue step |
| `tests/db/acquisitionProvider.test.ts` | 26 tests |
| `tests/extension/campaignPages.test.ts` | 29 tests |
| `tests/extension/campaignVocabulary.test.ts` | 9 tests |

**Modified**

`scripts/build-site.mjs` · `scripts/build-privacy-page.mjs` · `scripts/campaign.mjs`
· `scripts/verify-destruction-tests.mjs` · `docs/web/watchside-app/shell.html`
· `pages/index.html` · `pages/404.html` · `landing.css` · `README.md`
· `docs/web/pages-watchside/{index,support/index}.html` (regenerated)
· `docs/ANALYTICS.md` · `docs/ROADMAP.md` · `docs/OPERATIONS.md` · `docs/PRIVACY.md`
· `tests/db/bundle.test.ts` · `tests/db/twitchMetadataRetention.test.ts`
· `tests/extension/publicRouting.test.ts`

This milestone needs **no** change to `package.json`, `eslint.config.js` or
`.gitignore`. Those carry marketing-capture changes only, and are not part of
this commit.

**No file under `src/` was changed by this milestone**, and no extension was
rebuilt for it.

---

## 3. Migration 0045

Additive only. Four nullable columns, one trigger body replaced with a superset
of itself, one view replaced additively, one view created, two revokes, version
bump to 45.

1. `provider`, `medium`, `content`, `term` on `acquisition_campaigns`, with
   check constraints on the two closed sets.
2. `acquisition_campaign_immutable()` extended to refuse changes to `provider`
   and `medium`. The three 0038 rules are reproduced exactly, so replacing the
   function cannot relax one.
3. `acquisition_campaign_v` replaced, with the four dimensions **appended**.
4. `acquisition_activation_v` created.
5. Both views revoked from `public`, `anon`, `authenticated` **in this migration**.

**One implementation-level correction to the investigation.** The plan put the
new columns beside `label` where they read better. `create or replace view`
refuses to rename or reorder an existing column — it raises `42P16` — so they
had to be appended. The column *order* of a replaced view is part of its
contract; the migration now says so where the next person will meet it.

---

## 4. `acquisition_campaigns` after 0045

| Column | Mutable | Notes |
| --- | --- | --- |
| `code` | no | the identity; the only thing in the URL |
| `source` | no | 0038, untouched. `reddit` was already in it |
| `provider` | **no** | closed set of 7; `null` = no paid provider |
| `medium` | **no** | closed set of 7 |
| `creator_key` | no | 0038, untouched |
| `content` | yes | creative label, UTM-safe, ≤40 chars |
| `term` | yes | targeting label, UTM-safe, ≤40 chars |
| `label` | yes | human name |
| `active` | yes | closes to new attribution; destroys nothing |

`provider` is **not** a synonym for `source`. A creator campaign bought through
Reddit is `source='creator'`, `provider='reddit'`.

Immutability follows one test: does a report *group* on it across time? If yes,
editing it silently rewrites what every earlier comparison meant while no row
looks wrong. Wrong immutable field → mint a new code.

---

## 5. `acquisition_activation_v`

**Grain:** campaign × environment × first app version.

**Redefines nothing.** Every milestone is read from `activation_actor_v` (0042),
itself derived from the friend graph and `m3d_social_joins_v` (0034).

Counts: `authenticated_actors`, `cold_start_actors`, `friended_actors`,
`friend_presence_actors`, `gravity_actors`, `social_join_actors`,
`arrived_actors`, `watched_actors`, `returned_actors`,
`median_time_to_first_friend`. Rates: friended, gravity, social-join, returned,
cold-start.

**The denominator is attributed actors who AUTHENTICATED — never ad clicks.** An
attributed actor who never signed in is absent entirely (inner join), because a
row of nulls would read as a failure at every stage.

Preserved: internal-actor exclusion, n ≥ 3 suppression as `NULL` (never `0`),
`environment`/`first_app_version` in the grain, observational-not-causal in the
view comment.

---

## 6. Authorization verification

- `revoke all … from public, anon, authenticated` on **both**
  `acquisition_activation_v` and the replaced `acquisition_campaign_v`, in 0045.
- `tests/db/authorizationSurface.test.ts` passes — it introspects the built
  schema and fails on any client-readable `%_v`.
- `tests/db/acquisitionProvider.test.ts` asserts zero grants for both roles on
  both views, beside the migration that could break it.
- A **destruction mutation** deletes the revoke line; it is now caught.

---

## 7–10. The Reddit campaigns and their exact URLs

| Code | provider | medium | content | Label (mutable) |
| --- | --- | --- | --- | --- |
| `reddit-launch-a` | reddit | paid_social | `explanatory_presence` | Reddit launch - explanatory |
| `reddit-launch-b` | reddit | paid_social | `social_gravity` | Reddit launch - gravity |
| `reddit-launch-c` | reddit | paid_social | `join_payoff` | Reddit launch - JOIN payoff |

All `source = reddit`. `term` unset — it is mutable and can be added when
targeting is decided.

**Campaign URLs (not published):**

```
https://watchside.app/c/reddit-launch-a/?utm_source=reddit&utm_medium=paid_social&utm_campaign=reddit-launch-a&utm_content=explanatory_presence
https://watchside.app/c/reddit-launch-b/?utm_source=reddit&utm_medium=paid_social&utm_campaign=reddit-launch-b&utm_content=social_gravity
https://watchside.app/c/reddit-launch-c/?utm_source=reddit&utm_medium=paid_social&utm_campaign=reddit-launch-c&utm_content=join_payoff
```

The **path segment is the trusted identity**; the query string is decoration.

**Store URLs (creative A):**

```
https://chromewebstore.google.com/detail/ngfopkeokddfnncdhfkhnffilbdhkkip?utm_source=reddit&utm_medium=paid_social&utm_campaign=reddit-launch-a&utm_content=explanatory_presence
https://addons.mozilla.org/firefox/addon/watchside/?utm_source=reddit&utm_medium=paid_social&utm_campaign=reddit-launch-a&utm_content=explanatory_presence
```

Ordinary landing page: `utm_source=watchside_site&utm_medium=referral&utm_campaign=site_landing`.
Fallback/invite page: `…&utm_campaign=site_fallback`. Neither is ever converted
into authenticated attribution.

**Chrome reports tagged listing PAGE VIEWS. AMO reports tagged DOWNLOADS.**
Different events, one step apart. Never add them.

---

## 11–12. Landing and handoff behaviour

`/c/<code>/` is a **real HTTP 200 page with the full landing content** —
screenshots, how-it-works, privacy section. It is ~33 KB against the fallback
page's ~5 KB, and a test asserts it is more than twice the 404's size so it
cannot silently regress to the stripped page.

The handoff:

1. Store CTAs carry `target="_blank" rel="noopener" data-store="…"` — campaign
   pages only, so the page survives the store visit.
2. **`rel="noreferrer"` is deliberately absent.** It would strip the referrer
   the store reports attribute on. A test pins its absence so a future tidy-up
   cannot "helpfully" add it.
3. The continue block is rendered **complete and visible in the HTML**. No
   JavaScript is required to finish the journey — which matters because people
   blocking scripts are exactly the people most likely to.
4. `campaign.js` only *promotes* it after a store click:
   "Installed? Continue to Twitch to finish setting up."
5. Continue → `https://www.twitch.tv/?watchside_campaign=<code>`, **baked at
   build time**. Nothing at runtime reads the URL, so nothing can redirect it.

The released extension then does the rest unchanged: content script reads the
parameter, worker persists it with the 7-day window, `bind_acquisition` runs at
sign-in. **No extension change. No `onInstalled` welcome tab.**

`/c/` and `/i/` remain separate systems: separate prefixes, separate parameters,
separate tables, asserted by test.

---

## 13. CSP

```
default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline';
img-src 'self' data:; connect-src 'none'; form-action 'none'; base-uri 'none'
```

On every page. The privacy page is stricter still — `script-src 'none'`, because
it has no script at all.

To make `script-src 'self'` honest, the two inline scripts became **files**. An
inline script would have forced `'unsafe-inline'` (not strict) or per-page
hashes (more machinery than two small files are worth).

`style-src` permits `'unsafe-inline'` and the policy says so plainly: the shell's
`<style>` block, the injected landing CSS and two style attributes need it.
Style injection is a real if minor vector; the one that matters is closed.

`frame-ancestors` and `report-uri` are **deliberately absent** — meta tags ignore
them, and writing them would imply a protection that does not exist. GitHub
Pages cannot set response headers.

**Not weakened in anticipation of anything.** Adding a third-party script would
require editing this, which is the point.

---

## 14–15. Tests and gates

| Gate | Result |
| --- | --- |
| `npm run typecheck` | pass |
| `npm run lint` | pass |
| `npm test` | **143 files, 3382 tests, all pass** (was 3318; +64) |
| `npm run test:destruction` | **All 113 mutations detected** (was 109; +4) |
| `npm run test:authz` | pass |
| `npm run verify:released` | Chrome 0.7/0.8, Firefox 0.6 all compatible |
| `npm run db:bundle` | 45 migrations, applies cleanly, re-runnable |

Coverage added: provider/medium closed sets both directions, provider/medium
immutability, content/term mutability, the 0038 rules still refusing,
`acquisition_activation_v` semantics, n ≥ 3 suppression, internal-actor
exclusion, deletion, view authorization, vocabulary-vs-SQL agreement, "no code
reads a UTM or click ID anywhere", campaign route generation, 200-page content,
placeholder resolution, invite/campaign separation, store tagging correctness,
`target`/`noopener`/no-`noreferrer`, continue-URL correctness, open-redirect
resistance, CSP shape and satisfiability, no Pixel, no third-party analytics, no
storage, no network from any script.

### Four things the harnesses caught that review had not

1. **Five destruction anchors went stale** when the routing script moved to a
   file and the store links became placeholders. Repointed at the real targets.
2. **Two mutations became UNDETECTED** because 0045 redefines the trigger and
   `acquisition_campaign_v`, so mutating 0038's copy was silently overwritten. A
   mutation must target the *last* definition. Both repointed; a comment now
   records why.
3. **My own new test was vacuous.** The `left join` mutation didn't fail it,
   because an actor absent from `analytics_actors` never reaches
   `acquisition_actor_v` either. Rewritten so the actor is visible to
   acquisition and invisible to activation — the real case.
4. **Then it was still vacuous.** A `left join` doesn't inflate a count; it adds
   a *separate group*, because the nulls are in the grain. Now asserts exactly
   one row.

### One pre-existing failure, not mine

`npm run test:analytics` reports **6 of 87** undetected. Proven pre-existing by
stashing all of this work and re-running: **identical 6 of 87** on a clean tree.
Every one is in `src/background/analyticsHub.ts` — frozen v0.9 extension code,
untouched here, and out of this milestone's scope.

---

## 16–18. Deployment state

| | |
| --- | --- |
| Production migration state | **0045 NOT applied.** Production is at 44 |
| Local ↔ remote alignment | 45 local; production 44; **0045 is the only delta** |
| Website | **NOT deployed.** `dist-site/` builds clean locally |
| Production E2E attribution proof | **NOT performed** |

### Local pre-deployment verification (all pass)

Root, privacy, support, 404, `/i/`, `/c/`, three campaign pages, both scripts,
CNAME and `.nojekyll` all present. Campaign pages carry full landing content,
correct store UTMs, correct continue URL, `target`/`noopener`, no `noreferrer`,
no unresolved placeholders. Invite routing unchanged. **The only two destinations
the routing script can build are `twitch.tv` literals** — no open redirect. No
Reddit script, no third-party analytics, no cookie, no storage, no network call.
No personal or test data in the output.

---

## 19. Owner actions still required

**In this order. Step 0 blocks everything.**

### 0. Twitch integration — RECOVERED for sign-in, NOT healthy for presence

**Sign-in works again.** After the old application's failed secret rotation
(`ResetOauthAppSecret: service timeout`), the owner created a **replacement
Twitch application**, pointed Supabase → Authentication → Twitch at its new
Client ID and Client Secret, and verified a fresh Watchside login succeeds in
normal Firefox. The Supabase project-level `TWITCH_CLIENT_ID` and
`TWITCH_CLIENT_SECRET` were updated to the replacement application's credentials
at the same time.

**Production is not fully healthy.** After a fresh login, Watchside no longer
shows friend online/presence state. The remaining blocker is therefore **Twitch
integration / presence recovery**, not "no sign-in".

**That incident is out of scope here and is deliberately not investigated in
this milestone.** It is the subject of a separate production-incident
investigation.

**What it means for this milestone, precisely.** The attribution chain's own
dependency — sign-in, and therefore `bind_acquisition` — is satisfied, so 0045
and the website deployment are no longer blocked by it. But the end-to-end
attribution test in step 4 walks a real user through to a working panel, and a
panel that shows no presence is not a state to certify a funnel against. **Do
not run the E2E test, and do not spend, until presence is understood** — the
first thing an acquired user is supposed to reach is the friend presence this
foundation exists to measure them reaching.

### 1. Apply migration 0045

```bash
npm run db:bundle          # already run; 45 migrations
```

Then **Supabase → SQL Editor → New query**, paste
`supabase/.generated/apply_all.sql`, run. Safe to re-run.

*(`supabase db push` also works and was used for 0044; the bundle path needs no
database password.)*

Verify afterwards:

```sql
select public.analytics_schema_version();                    -- 45
select provider, medium, content, term
  from public.acquisition_campaigns limit 1;                  -- columns exist
update public.acquisition_campaigns set provider = 'google'
 where code = 'reddit-launch-a';                              -- must RAISE
select * from public.acquisition_activation_v;                -- exists, empty
select count(*) from information_schema.role_table_grants
 where table_name in ('acquisition_activation_v','acquisition_campaign_v')
   and grantee in ('anon','authenticated');                   -- 0
```

### 2. Insert the three campaigns

The three `insert` statements are reproducible at any time with
`npm run campaign -- --code reddit-launch-a …` (see §7 of this report for the
exact arguments). They are **not** applied.

### 3. Deploy the website

`npm run build:site`, then push `dist-site/` to `Anoteros-Labs/watchside-app`.
Publishing is the owner's by convention.

Verify the **public URLs**, not the build output:

```bash
curl -sI https://watchside.app/                        # 200
curl -sI https://watchside.app/c/reddit-launch-a/      # 200  <- the new one
curl -sI https://watchside.app/privacy                 # 301 -> 200
curl -s  https://watchside.app/c/reddit-launch-a/ | grep watchside_campaign
curl -sI https://watchside.app/i/SOMECODE              # 404 + invite page (unchanged)
```

### 4. The real end-to-end attribution test

**Do not fake it by inserting attribution.** The point is to validate the public
handoff.

Use a **non-internal** test actor — a Twitch account that is *not* marked
`is_internal` in `analytics_actors`, or the row will be excluded from every view
and prove nothing.

1. Open `https://watchside.app/c/reddit-launch-a/` in a clean browser profile.
2. Click **Add to Chrome** (or Firefox). It opens in a new tab; the campaign
   page stays.
3. Install the **public** store build.
4. Return to the campaign tab; the continue step is now promoted. Click it.
5. Land on `twitch.tv/?watchside_campaign=reddit-launch-a`.
6. Open the Watchside panel and sign in.
7. Verify:

```sql
select * from public.acquisition_attribution where actor_id = '<actor>';
--   first_campaign_code = 'reddit-launch-a', touch_count = 1

select event_name, properties from public.analytics_events
 where actor_id = '<actor>' and event_name like 'acquisition%';
--   acquisition_attributed, properties->>'touch' = 'first', source = 'reddit'

select * from public.acquisition_touch_outcomes_v where outcome = 'first';
select * from public.acquisition_coverage_v;
select * from public.acquisition_activation_v where campaign_code = 'reddit-launch-a';
```

**On the browser-profile risk:** use a separate browser profile rather than the
normal one. Installing the public build into a profile that already has a
development unpacked build loaded gives two Watchside instances racing for the
same panel, and uninstalling afterwards clears extension storage. A clean
profile costs nothing and avoids both.

---

## 20. Git

Nothing committed. 24 modified, 13 untracked (§2). `releases/` is untouched —
`git status --porcelain releases/` is empty. Say the word and I will commit.

---

## 21–24. Confirmations

- **Submitted v0.9 artifacts untouched**, hash-verified against `ROADMAP.md`:
  `a6dd55b5…`, `b05ad845…`, `778cdaf3…`. No extension was rebuilt for this
  milestone and no file under `src/` was changed by it.
- **Reddit Pixel NOT installed.** No `redditstatic`, no `rdt(`, no `rdt_cid`
  anywhere. Asserted per page by test, and the CSP would block it.
- **Reddit CAPI NOT implemented.** No Edge Function, no outbox, no secret, no
  conversion code of any kind.
- **No anonymous visitor tracking introduced.** No cookie, no `localStorage`, no
  `sessionStorage`, no visitor id, no beacon, no `fetch`/`sendBeacon`/`Image`
  from any script, no IP, no user agent, no referrer stored, no fingerprinting,
  no device characteristics. The site still makes **zero** requests to any third
  party, and `connect-src 'none'` now enforces it.
- **Privacy posture materially unchanged.** No rewrite was required. Every
  existing promise in `docs/PRIVACY.md` — including "the watchside.app website
  sets no cookies and makes no requests to anyone else at all" — remains true. A
  single clarifying paragraph was added about the outbound tags on campaign and
  store links, explaining that Watchside ignores them completely.

---

## 25. Remaining unavoidable attribution gaps

Unchanged from the investigation, and documented in `docs/ANALYTICS.md` §16.5:

- Click → landing → store → install → extension is **not observable at the
  individual level**, and will not be made so.
- Cross-device journeys (click on phone, install on desktop) are unattributed.
- A reinstall loses the touch. Clearing extension storage discards it.
- Never signing in means never attributed — correctly, since there is no account
  for the fact to be about.
- Accounts created before v0.8 are permanently unattributable.
- Chrome reports store **page views**; AMO reports **downloads**. Neither is an
  install, and they are one funnel step apart.
- The four measurement layers **will not reconcile**, and no metric implies they do.

**Every one of these biases attribution downwards.** A campaign will be credited
with less than it produced, never more — the safe direction for a spend
decision, and worth saying out loud when the first numbers look small.

---

## 26. The exact next action before Reddit Ads can spend

**Understand why friend presence is missing after a fresh login.**

Sign-in is recovered (§19 step 0), so 0045 and the website deployment are
unblocked. What is not recovered is the product state an acquired user is
supposed to land in: after a fresh login, Watchside shows no friend online or
presence state.

That matters to this milestone specifically rather than generally. This
foundation exists to measure whether an acquired user reaches Watchside's social
value, and friend presence is the **first** stage of that funnel —
`friend_presence_actors` in `acquisition_activation_v`. Certifying an
attribution funnel against a panel that shows no presence would prove the
plumbing and nothing about the product, and any early campaign numbers would
describe an outage rather than a campaign.

So the order is:

1. **Twitch presence incident** — separate investigation, not this milestone.
2. Apply 0045 → insert the campaigns → deploy the site. Safe to do before (1)
   resolves; none of it changes production behaviour or extension behaviour.
3. Real end-to-end attribution test — **after** (1), so it walks a healthy panel.
4. Publish ads.

`docs/OPERATIONS.md` carries this as a **"Before any ad spend"** checklist so it
does not depend on this report being found.
