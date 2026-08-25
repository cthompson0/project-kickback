# PRIVATE BETA READINESS

**Date:** 2026-08-25
**HEAD at audit:** `393390c polish: improve kickback shell UX`
**Migrations in repo:** through `0022_blocks.sql`. **No new migration.**
**Companion:** [../BETA_ANALYSIS.md](../BETA_ANALYSIS.md) — the queries

---

## Executive verdict

**READY AFTER BLOCKERS** — and the blockers are done. One P0 was found and
fixed. Nothing else discovered rises above P2.

The question this checkpoint exists to answer:

> Can I give Kickback to a small, socially connected group of non-developer
> friends and actually learn whether Presence → Gravity → JOIN → Together works?

**Yes**, for a cohort the developer distributes to directly. Not yet for anyone
who has to find their own way in — see *Cold-start audit*, which is a real
limitation and, for this cohort, an acceptable one.

### Deployment precondition — verified, with one caveat

Repository state matches the brief: clean tree, HEAD `393390c`, migrations
through `0022_blocks.sql` present, and `0022` is in the regenerated
`supabase/.generated/apply_all.sql` (22 migrations, verified by
`tests/db/bundle.test.ts` applying it to an empty database, twice, and on top
of a database stopped at 0021).

**The caveat:** *this repository cannot see the hosted database.* The bundle is
gitignored and regenerated locally; nothing here proves the hosted project has
run it. `npm run verify:analytics` and `npm run verify:groups` probe hosted
state, and **`npm run package:beta` refuses to build unless both pass** — so
that check is enforced at the moment it matters rather than assumed here.
Neither probe covers `0022` specifically, because everything `0022` adds is
revoked from clients by design.

**Before distributing:** apply `apply_all.sql` to hosted and confirm Block works
end to end with two accounts. If `blocks` is missing, the extension's `Block`
button fails at the RPC — a visible failure, not a silent one, which is the
correct failure mode but is not something to discover through a tester.

## Current product loop

```
install (ZIP)  →  Continue with Twitch  →  + Add → search by Twitch username
                                                 →  friend request  →  accepted
      ↓
Presence          friends' channels appear in the panel
      ↓
Social Gravity    friends clustered by destination, ranked, LIVE state, JOIN
      ↓
JOIN              opens the destination; attribution minted at the click
      ↓
Together          co-presence detected; WATCHING TOGETHER; contextual session tab
                  with ephemeral chat, emotes and combos
```

Everything in that loop is implemented and instrumented. Block/Unblock sits
underneath it as the safety gate.

## Analytics coverage matrix

Confidence is about whether the **current data can answer the question
honestly**, not whether an event exists.

| # | Question | Events | Exposure represented? | Joinable to outcome? | Confidence |
|---|---|---|---|---|---|
| A1 | User was exposed to Gravity | `gravity_cluster_impression` | **yes** — deduped per channel, 30-min window, 5-min absence rule (`exposure.ts`) | via `(actor, channel, time)` | **YES** |
| A2 | Destination shown | same, `destination_channel` column | yes | yes | **YES** |
| A3 | Friends represented | `friend_count` | yes | yes | **YES** |
| A4 | Direct vs gathering | n/a — the banner is gone; Gravity is the only surface | — | — | **YES** (one surface) |
| A5 | Live / offline | `destination_live`, absent when unknown | yes | yes | **YES** |
| A6 | Combo visible | — | **no** | — | **NO** — see below |
| A7 | Subsequently JOINed | `join_clicked` `source='social_gravity'` | yes | window join | **PARTIAL** |
| B1 | JOIN from Gravity | `join_clicked.source='social_gravity'` | — | `attribution_id` | **YES** |
| B2 | JOIN from friend row / card | `source='user_card'` | — | yes | **YES** |
| B3 | JOIN from notification | `source='notification'` | — | yes | **YES** |
| B4 | Organic navigation excluded | emits **nothing** | — | — | **YES** |
| B5 | Click vs arrival | `join_clicked` → `join_arrived`, same `attribution_id`, 90 s window | — | deterministic | **YES** |
| C1 | Friend count | `authenticated_session_started.friend_count`, every session | — | time series | **YES** |
| C2 | First friend / time to 3 / to 5 | derived from C1 | — | — | **YES** |
| C3 | Requests sent / accepted | `friend_request_sent`, `friend_request_accepted` | — | — | **YES** |
| C4 | Relationship growth over time | C1 as a series | — | — | **YES** |
| D1 | Session became available | `automatic_room_entered` + `participant_count`, `direct_friend_count` | — | — | **YES** |
| D2 | Session opened | `automatic_room_opened` + `opened_from` | — | — | **YES** |
| D3 | Messages / reactions / combos | `automatic_room_message_sent`, `_reaction`, `_combo` | — | — | **YES** |
| D4 | Co-presence state | `watching_together_started/_ended` | — | `attribution_id` | **YES** |
| D5 | Shared-watch duration | `analytics_together_v.duration`, measured to the effective end | — | — | **YES** |
| E1 | D1 / D7 / D14 / D30 | `analytics_actor_days_v` | — | — | **YES** (thin at beta scale) |
| F1 | Notification → JOIN → arrival | `gathering_notification_shown/_clicked` → `join_*` | — | yes | **YES** |
| G1 | Combo-visible JOIN lift | — | **no** | — | **NO** |
| H1 | Generic Twitch watch time | — | — | — | **NO**, and deliberately |
| H2 | Shared-watch duration | `analytics_together_v` | — | — | **YES** |
| H3 | Post-JOIN dwell | `post_social_retention_ended` | — | `attribution_id` | **YES** |
| H4 | Incremental social watch hours | — | — | — | **NO** |

### A6 / G1 — the combo question, and why no instrumentation would fix it

The brief flags this as important, and the honest answer is not "we forgot to
log it".

Combos are rendered **only on the HERE card** — `SocialGravity.tsx` passes
`reactions` and `roomMessages` to a card only when `section.kind === 'here'`.
And `gravityOpportunities()` **excludes HERE**, because the channel you are
already watching is not somewhere you can JOIN; counting it would put rows that
can never convert into the conversion denominator.

So a combo can never be visible on a destination the viewer could JOIN. Adding
`combo_visible` to `gravity_cluster_impression` would register a property that
is **false by construction**, which is worse than absent: it would make the
question look covered.

This is a **product** finding, not a measurement one: *should combo activity be
shown on joinable destinations?* Answering it means changing what Social
Gravity draws, which §0 puts out of scope. Recorded as P3 with the reasoning,
so the next Gravity checkpoint starts from it.

## Attribution model

**Strong, and deterministic where it matters.** `joinAttribution.ts` mints an id
at the click and everything downstream quotes it, so the funnel is a join on one
column rather than a guess.

| Property | Behaviour |
|---|---|
| Arrival window | 90 s; a click with no arrival expires **silently**, so arrival rate is arrivals ÷ clicks and an abandoned click is already counted correctly by being absent |
| Together window | 10 min after arrival, because a shared watch can start when a friend turns up later |
| Duplicate clicks | a new click for the **same** destination replaces the pending one — five clicks in a second is one intention |
| Competing clicks | a click for a **different** destination abandons the first; the user is going to the second place |
| Storage | `chrome.storage.local`, not memory — the MV3 worker is killed at ~30 s idle and a navigation is exactly the kind of pause that kills it |
| Last vs first touch | single-slot, last-touch |
| Already on destination | recorded as `already_on_destination` on the click, so it can be excluded |
| Organic navigation | emits nothing at all — structurally cannot be attributed |
| Notification vs Gravity | one `source` per click; the notification path calls the same `recordJoin` rather than being a second notion of joining |

**What is defensible:** *saw Gravity for X → clicked JOIN for X → arrived at X →
watched with N people for D minutes → stayed R minutes after they left.* Every
step after the click is id-joined.

**What is not:** exposure → click. `gravity_cluster_impression` mints nothing,
so the analysis matches on `(actor, channel, 10 minutes)`. Someone who ignored
the cluster and pressed JOIN later still counts. Say *"exposures followed by a
JOIN"*, never *"caused"*.

**Not changed.** Minting an exposure id would make exposure → click
deterministic, and it is the obvious next attribution improvement. It is not a
beta blocker: with a cohort this small the window join is inspectable by hand,
and `analytics_join_funnel_v` already carries the strong half.

## Measurement limitations

1. **No control group.** Beta forces everyone into the `gravity` arm
   (`experiment.ts`) — a holdout across five people measures nothing and costs
   the feature half its testers. Nothing from the beta is a causal claim.
2. **Exposure → click is a time window**, not an id.
3. **Combo lift is unanswerable by construction** (above).
4. **No generic Twitch watch time.** Kickback measures shared-watch duration and
   post-social retention on attributed destinations. It does not measure how
   long anybody watched Twitch, and getting that would need permanent detailed
   browsing history — which is explicitly not wanted.
5. **Incremental Social Watch Hours does not exist.** The nearest honest proxy
   is *attributed arrival → post-social retention duration*, which is a
   Kickback-caused-visit duration, not an incremental-hours figure. Label it
   that way.
6. **Six people for a week.** No significance, no rates quoted to a decimal.

## Canonical beta funnel

Actual product semantics, with the telemetry for each transition:

| # | Transition | Telemetry | Hole |
|---|---|---|---|
| 1 | install → extension runs | `extension_session_started` | none |
| 2 | → authenticated | `authenticated_session_started` | none |
| 3 | → friend discovery attempted | `friend_search` (+ `result_count`) | none |
| 4 | → first friend | `friend_request_accepted`, `friend_count` ≥ 1 | none |
| 5 | → useful density (3+) | `friend_count` series | none |
| 6 | → first presence exposure | `friend_presence_impression` | none |
| 7 | → first Gravity exposure | `gravity_cluster_impression` | none |
| 8 | → first Kickback JOIN | `join_clicked` + `source` | **exposure→click is a window** |
| 9 | → arrival | `join_arrived`, id-joined | none |
| 10 | → Watching Together | `watching_together_started.from_join` | none |
| 11 | → repeat social JOIN | repeated `join_clicked` per actor | none |
| 12 | → retained | `analytics_actor_days_v` | thin at this scale |

**The one structural hole is step 8**, and it is a strength-of-claim hole rather
than a missing event.

## Cold-start audit

Walked as code, as a new user with zero friends and nobody coaching them.

**What they see.** Sign in with Twitch. Then the Friends tab with:

> **Your Kickback is quiet.**
> Your friends will show up here once you add them.
> `[ Find friends ]`

Plus a persistent `+ Add` button in the tab row. `RIGHT NOW / Browsing Twitch`
sits above it and works signed out.

| Question | Answer |
|---|---|
| What tells them what Kickback does? | The install README, and the store-style description in the manifest. **In-product: almost nothing.** The empty state says friends will appear; it does not say why that is worth doing |
| Do they know it needs friends? | Yes — the empty state and the CTA both say so |
| How do they find their first friend? | `Find friends` → search by Twitch username or friend code |
| How do they know whom they can add? | **They do not.** Search only matches people who already have Kickback |
| Search returns nobody? | Handled well: *"No Kickback user found — they may not have joined Kickback yet. Try their exact Twitch username, or swap friend codes."* Honest, and never implies the Twitch user does not exist |
| Real friends have not installed it? | **Dead end in-product.** Nothing to send them |
| Can they invite someone? | **No.** There is no invite affordance anywhere |
| Empty state exists? | Yes, with a working next action |
| Does it explain the value? | Weakly |
| Can they reach value without being told "search for Anoteros"? | **Only if they already know a cohort member's Twitch username** — which, for this cohort, they do |

**Verdict: not a blocker for a distributed cohort, and a hard blocker for
organic growth.** The people in this beta receive the ZIP from the developer,
already know each other, and know each other's Twitch names. The cold start is
solved *outside* the product, by the distribution.

That is worth saying plainly: **do not treat "the beta worked" as evidence that
the cold start works.** It will not have been tested.

## Friend discovery

Verified against the repository.

| Capability | State |
|---|---|
| Kickback user search by Twitch login | **yes** — prefix match, LIKE-escaped so `a_b` cannot match `axb`, capped at 10 |
| Search by friend code | **yes**, exact match |
| Arbitrary Twitch account lookup | **no, and deliberately** — Kickback does not call the Twitch API from the client |
| Friend request / accept / decline / cancel | **yes** |
| Incoming and outgoing requests | **yes**, both surfaced |
| Reciprocal auto-accept | **yes**, server-side |
| FoF graph capability | exists **only inside `stream_room_members`**, bounded 3 hops / 50 members, never exposed as a list |
| Groups as graph information | exists; grants presence via `shares_group_with` |
| Block privacy constraints | `blocked_pair` in search, requests, traversal, delivery and groups; `'blocked'` shown only to the blocker |
| **Suggested Friends** | **NOT IMPLEMENTED** — confirmed: zero matches for `suggest` across `src/` and `supabase/migrations/` |

**Smallest discovery experience required for private beta: what already exists.**
An intentionally connected cohort who know each other's Twitch usernames need
search, requests and accept. They have all three.

## Suggested Friends decision

**DEFER.**

1. **No signal.** In a 4–6 person cluster where everyone knows everyone, FoF
   suggestions surface people they have already added. The recommendation set is
   empty or trivially redundant almost immediately.
2. **It solves the wrong problem.** The cold-start pain is *"my friends are not
   on Kickback"*, not *"I cannot find the ones who are"*. Suggestions cannot
   introduce you to somebody who has not installed it.
3. **The graph is the thing being tested.** Auto-suggesting connections would
   contaminate the density measurement — we want to see how people actually
   build a friend list, not how well an algorithm builds it for them.
4. **It would need privacy design work** to avoid disclosing block direction and
   pending state, for a feature with no signal to justify it.
5. §0 and §8 both say do not build it unless the audit concludes it is
   necessary. It is not.

**Revisit when** a cohort routinely reaches 5+ friends and starts asking who
else is on it — that is the point at which FoF has anything to say.

## Invitation decision

**DEFER**, and the reason is decisive rather than a judgement call.

An invite affordance means *"send your friend a way to get Kickback"*. There is
no such way. Distribution is a ZIP the developer sends, with a README about
Developer mode and Load unpacked. A "copy install link" button would copy a link
to nothing.

**Distribution *is* the invitation for this beta.** Building an invite flow
before there is anything to invite somebody to would be building the affordance
before the destination.

**This becomes a P0 the moment Kickback is on the Chrome Web Store**, and it
should be the first growth item then: a share link plus a one-line "your friends
need Kickback too" in the empty state. Recorded in the backlog.

## Analytics analysis workflow

Preference order from §10 applied: existing tooling was **insufficient**, and
the fix is **documented canonical queries** — level 2, no views, no migration,
no dashboard.

**What was insufficient.** `docs/ANALYTICS.md §11` has a *"Gathering impressions
→ JOIN conversion"* query, and `gathering_impression` **is never emitted any
more**: the gathering banner was removed in P1A and `KickbackPanel` now reports
`gatherings: []` unconditionally. The single most important beta question had a
documented query that returns zero rows. There was no Gravity equivalent.

**What now exists:** [`docs/BETA_ANALYSIS.md`](../BETA_ANALYSIS.md) — ten
numbered sections, every query scoped to `private_beta`, covering: is anything
arriving; daily actives; Gravity exposure and exposure by friend-count segment
(1 / 2 / 3+); **Gravity → JOIN conversion by segment**; JOIN → arrival by
source; notification funnel; Watching Together with the organic baseline;
post-social retention; the session block kept deliberately separate; social
density and time-to-first-friend; retention; and one-person-story debugging.

It ends with an explicit *"what none of this can tell you"* section, so the
limitations travel with the numbers instead of living in a different file.

No dashboard. The queries are boring and reproducible, which is the requirement.

## Packaging / installation

**Already strong — this was the biggest surprise of the audit.**
`npm run package:beta` exists and refuses to produce an archive unless every
precondition holds:

- `verify:config` — the Supabase publishable key actually works
- `verify:groups` — the hosted group backend actually exists
- a **fresh** production build, forced to `VITE_KICKBACK_ENV=private_beta` at
  the build call rather than inherited from the packager's `.env.local`
- the manifest still pins the key whose extension ID matches the OAuth
  allow-list (`almhfkicihekhiloapoimglfdoneglni`) — checked by recomputing the
  ID from the key
- the staged file list is an **allow-list**, not "copy dist and delete the bad
  bits", so a stray file cannot be shipped by omission
- content scanning for secret keys, service-role, client secrets, private key
  blocks, Postgres URLs, JWT-shaped literals, and **demo-mode fingerprints**
- a file-scoped rule that `kickback-content.js` contains no provider token
  handling and no direct Twitch API call — the content script runs in the page,
  and that is where a token must never be
- the finished **archive** is re-inspected, not just the staging directory

It also writes `README-TESTERS.txt` into the ZIP with install, use, update and
troubleshooting instructions in plain language.

| Requirement | State |
|---|---|
| Not a developer | ✅ extract, Developer mode, Load unpacked |
| No repo / npm | ✅ |
| No Supabase knowledge | ✅ |
| Receives no secrets | ✅ enforced by the scanner |
| No DevTools | ✅ |
| Developer mode required | ⚠️ **yes** — unavoidable for unpacked, and stated in the README |
| Manifest production-safe | ✅ 4 permissions, 3 host permissions, no `<all_urls>` |
| OAuth works from packaged install | ✅ pinned key → stable ID → matches the allow-list |
| Instructions exist and are understandable | ✅ |

The one friction is Chrome's Developer-mode requirement, which no unpacked
install can avoid and which the README covers in seven numbered steps.

## Update strategy

**Replacement ZIP into the same folder**, which is what the README already
documents:

1. extract the new ZIP
2. copy its files over the old ones **in the same folder**
3. `chrome://extensions` → reload arrow
4. refresh the Twitch tab

Keeping the folder path matters and the README says why: Chrome treats a moved
folder as a different install, which means signing in again.

**Recommended for this cohort: keep it.** The alternative — an unlisted Chrome
Web Store listing with automatic updates — is genuinely lower friction and is
the right answer for the *next* cohort, but it requires a review cycle and a
developer account, and it removes the ability to push a fix in ten minutes. For
5–15 people who are in contact with the developer, the ZIP is faster.

**Revisit at ~20 testers or when a review round-trip is cheaper than the
messages.** Do not publish publicly.

## Safety / privacy

| Check | State |
|---|---|
| Block available | ✅ UserCard, behind an in-card confirmation |
| Unblock available | ✅ account card, separate list, no confirmation |
| Mute available | ✅ independent of block; unblock does not unmute |
| Blocked-pair privacy | ✅ `blocked_pair` never granted to clients; no endpoint asks "who blocked me" |
| Token / secret exposure | ✅ scanned at package time, including a content-script-scoped rule |
| Message bodies in analytics | ✅ impossible — 64-char values, unknown keys dropped **on both sides**, and the server strips anything not in `allowed_properties` |
| Sensitive social content | ✅ no reaction content, no search terms, no blocked identities |
| Debug interfaces in production | ✅ none — no `window.__*` globals; the only build-time constant surfaced is the version string in the footer |
| Dev/beta diagnostics gated | ✅ `console.info`/`console.warn` only, message text only, no tokens or bodies |
| Friend graph enumeration | ✅ search capped at 10 and prefix-matched; FoF exists only inside a bounded server RPC |
| Sign-out works | ✅ closes the analytics session too |

Nothing here needed changing.

## Observability

*"Kickback didn't show my friend"* — what can we distinguish?

| Cause | Diagnosable | How |
|---|---|---|
| Auth failure | ✅ | panel shows the signed-out card; `authenticated_session_started` absent |
| Realtime disconnect | ✅ | `console.info('[Kickback] social sync' / 'presence sync', status)` in the service worker console |
| Presence failure | ✅ | no `friend_presence_impression` for that actor |
| Stale presence | ⚠️ partial | the 90 s rule fades them to offline; indistinguishable from actually offline **by design** — that is the privacy model, not a gap |
| Friend relationship issue | ✅ | `friend_count` on every session; `friend_request_*` events |
| Block issue | ⚠️ deliberately opaque | a block is invisible by design, so a tester's report cannot distinguish it. The developer can query `public.blocks` directly |
| Gravity construction | ✅ | `gravity_cluster_impression` with `friend_count` and `destination_live` |
| Session membership | ✅ | `automatic_room_entered` with `participant_count` / `direct_friend_count` |
| Metadata failure | ✅ | `destination_live` absent rather than false |

Sufficient. Not changed. The practical route for a live report is: ask for the
version from the panel footer, then run §10 of BETA_ANALYSIS.md for that person.

## Cohort design

**Two or three clusters of 4–6 real friends each. Not 12 unrelated people.**

Social Gravity clusters people by destination. With a sparse graph nobody is
ever co-present, no cluster ever forms, and the beta would conclude that Gravity
does not work when what it actually measured is that the graph was too thin.
Density is a precondition for the feature existing at all, not a variable.

Recommended:

- **Cluster A** — 5–6 people who already watch similar things together. The
  primary signal.
- **Cluster B** — 4–5 people with a different centre of gravity. Confirms the
  first cluster was not one unusual group.
- **One or two bridge people** in both clusters. This is the only way
  friend-of-friend session membership gets exercised at all —
  `direct_friend_count` vs `participant_count` is the measurement, and without a
  bridge it is always equal.
- **Everyone installs within a day or two of each other.** Staggered installs
  mean the early people see an empty product and churn before density arrives.

**What not to tell them.** Do not say "click Social Gravity", "try JOIN",
"open the streamer tab", or "send some emotes". Every one of those manufactures
the behaviour being measured. Say only what the README says: *use Twitch
normally for a few days, then tell me what was useful, annoying, confusing,
broken or missing.*

Do not explain what a combo is. Do not explain Gravity. If they do not discover
something, that is the finding.

## Beta questions

The smallest set worth answering, and where each is read:

| # | Question | Where |
|---|---|---|
| 1 | Do people open Kickback unprompted? | §1 daily actives, §9 retention |
| 2 | Does seeing a friend on a destination cause JOIN? | §3, with the correlation caveat |
| 3 | How does JOIN change with 1 / 2 / 3+ friends? | §3 segmented |
| 4 | Are notifications useful or annoying? | §5 — high shown, near-zero clicked is the annoyance answer |
| 5 | Does visible combo activity increase JOIN? | **unanswerable** — see A6 |
| 6 | After JOIN, does Watching Together form, and do people stay? | §6 |
| 7 | Do people open the contextual session? | §7 `automatic_room_opened`, and `opened_from` |
| 8 | If opened — chat, emotes, combos? | §7 |
| 9 | Do they keep using Twitch/Discord chat instead? | qualitative only; **not a failure** |
| 10 | How many friends before it becomes useful? | §8 density vs §3 conversion |
| 11 | Do they come back unprompted? | §9 |
| 12 | What causes abandonment? | qualitative |

## Discovery value versus session value

Recorded because it changes how the result is read.

The beta **must be allowed to conclude**: *Gravity works strongly, and the
contextual session is barely used.* That is not failure. It would mean
Kickback's value is social **discovery** rather than replacement chat — a
sharper product, not a worse one.

`BETA_ANALYSIS.md` keeps them in separate sections (§3–§6 discovery, §7 session)
specifically so one cannot be quietly read as evidence for the other. If the
session is heavily used, that is recorded just as plainly.

## P0 blockers

**1. UserCard rendered invisible over its own content.** *Found, fixed,
verified in a real browser.* See *UserCard fix*. P0 because the card is the only
route to Profile, Mute, Remove friend and **Block** — the safety control — and
on a default-sized panel it was cropped to nothing. A tester could not have
blocked anybody from Gravity, and the product looked broken at first contact.

No other P0 found.

## P1 blockers

**None.**

The candidate was combo-visibility instrumentation (§3G). Investigation showed
the question is unanswerable by construction rather than by omission, so
instrumenting it would have registered a property that is always false. Demoted
to P3 as a product question. **This is why no migration was needed.**

The second candidate was the broken analysis path for Gravity → JOIN. It is
real, and it was fixed with documentation rather than code — `BETA_ANALYSIS.md`.

## P2 issues

Not implemented; the beta proceeds without them.

1. **Exposure → click is a time window, not a minted id.** Weakens the central
   claim from causal to correlational. Not fixed because it needs an exposure id
   threaded through Gravity and quoted at the click — a real change to a
   just-frozen surface, for a cohort small enough to inspect by hand.
2. **The empty state does not explain the value proposition.** It says friends
   will appear; it does not say why that is worth doing. Matters for organic
   installs, not for a hand-delivered cohort.
3. **`gathering_impression` is registered but never emitted.** Harmless dead
   contract; removing it would be a migration for tidiness.
4. **Developer mode required.** Inherent to unpacked installs.

## P3 backlog

1. **Should combos be shown on joinable destinations?** The product question
   behind A6. Currently combos exist only where you already are.
2. **Invite flow** — becomes P0 the day Kickback is on the Web Store.
3. **Suggested Friends** — revisit at 5+ friends per user.
4. **Unlisted Web Store distribution** — revisit at ~20 testers.
5. **Twitch-native rail mode** — audited and deferred; see
   [twitch-native-surface.md](../architecture/twitch-native-surface.md).
6. **Incremental Social Watch Hours** — needs measurement Kickback deliberately
   does not do today.

## Roadmap corrections

Recorded explicitly, as required:

| Item | Status |
|---|---|
| **Social Gravity / pre-JOIN signal** | **ALREADY IMPLEMENTED.** Not future work. Future work is *optimisation* |
| **Suggested Friends** | **NOT IMPLEMENTED** — verified against the repository, zero matches |
| **Twitch-native rail** | **AUDITED / DEFERRED** |
| **Multi-platform (YouTube, Kick)** | strategic future work, not beta scope |
| **Monetisation** | strategic exploration, not beta scope |
| **Analytics dashboard** | **NOT REQUIRED.** Queries and views until repeated real use proves otherwise |

### Active prioritisation rule

For significant product/growth work:

- **A — User experience value.** Does this make Kickback meaningfully better?
- **B — Incremental platform value.** Does this plausibly create viewing or
  activity that otherwise would not have happened?

Infrastructure, reliability, privacy and safety may be mandatory without scoring
on B. The UserCard fix is exactly that: it scores nothing on B and was still the
one thing that had to be done.

### Platform coupling

The only code changed in this checkpoint is the UserCard's positioning, which is
DOM-generic and knows nothing about Twitch. **No new Twitch coupling was
introduced.**

## Changes implemented

1. **`src/ui/components/UserCard.tsx`** — the card escapes the scrolling body
   and is clamped to the panel. See below.
2. **`scripts/verify-test-lab.mjs`** — a card-coverage browser gate that samples
   60 points and fails if any of them show what is behind the card; run at both
   a content-height and a user-grown panel.
3. **`tests/extension/shellPolish.test.tsx`** — pins both halves of the fix.
4. **`docs/BETA_ANALYSIS.md`** — new; the analysis workflow.
5. **`docs/checkpoints/private-beta-readiness.md`** — this file.

**No migration. No schema, RPC, RLS or analytics contract change.**

## UserCard fix

**The previous checkpoint's diagnosis was wrong**, and the fix it shipped was
necessary but not sufficient.

`--kb-bg-popover: #1e1e24` really is opaque — the browser confirms the computed
background is `rgb(30, 30, 36)`, with no ancestor opacity, filter, blend mode or
backdrop-filter anywhere in the chain. The card was not translucent.

**It was not being painted.** Measured in a real browser on a default panel:

```
card box    x 1262  y 267  w 284  h 139   (bottom 406)
panel box   x 1248  y  16  w 320  h 287   (bottom 303)
overflow past the panel bottom: 103px
60 of 60 sample points inside the card showed something else
```

The card is laid out below its cluster — the stylesheet's `top: calc(100% + 3px)`
against `.kb-gravity-card`, the nearest positioned ancestor. That ancestor lives
inside `.kb-body`, which is `overflow-y: auto` — **and a scroll container clips
its absolutely-positioned descendants.** Before anyone resizes the panel it is
content-height, so the body is frequently *shorter than the card itself*.
Clicking somebody opened a card that was cropped to nothing, leaving their
avatar, name, handle and activity plainly readable exactly where the card should
have been. Which is precisely what the bug report described.

Repositioning alone cannot fix it: an intermediate attempt that pulled the card
up by its overflow got 60 bad points down to 12 and no further, because there
was genuinely less room in the body than the card needed.

**The fix** is that the card leaves the scroller. A `useLayoutEffect` measures
the anchor and switches the card to `position: fixed`, whose containing block is
`.kb-panel` — the panel's `backdrop-filter` makes it one. So the card is clipped
by the **panel**, which is the right boundary: it may cover the body, the footer
and the tabs, and it may not escape Kickback. Placement reproduces what the
stylesheet did, clamped so a card near the bottom rides up instead of being cut
off, and pinned to the top rather than pushed through it when even that is not
enough.

Two subtleties, both found by measuring rather than reasoning:

- **Coordinates are panel-relative, not viewport-relative.** Writing viewport
  coordinates into a fixed element whose containing block is the panel lands it
  at twice the panel's offset — observed at `x = 2503` on a 1600px screen.
- **The effect resets `style.cssText` before measuring.** It runs after every
  render, and `position: fixed` makes `offsetParent` report the containing block
  instead of the cluster, so a second pass would measure the card against itself
  and walk it off screen.

A `ResizeObserver` on the panel keeps it in bounds when Kickback is resized —
which is not a window resize, so watching the window alone left the card hanging
outside a panel the user had just made smaller.

**Result:** 0 of 60 sample points show anything behind the card, at both panel
heights, in a real browser. Profile, Mute, Remove friend, Block, the block
confirmation, the blocked state and Escape precedence are all unchanged, and the
1316-test suite passes untouched.

### Why the old test suite missed it

Because it asked the wrong question. Every assertion was *"is the background
opaque"*, which was true throughout. The question that matters is *"is the card
what you actually see"*, and only a browser can answer it. The new gate asks
that one.

## Tests

| Gate | Result |
| --- | --- |
| `tests/extension` + `tests/core` | 1316 passed (48 files) |
| `npm run test:lab` | 121 passed |
| `npm run verify:lab` (real browser, CDP) | **11 scenarios** — 1 new |
| `npm run typecheck` | clean |
| `npm run lint` | clean |
| `npm run build` | clean |
| private_beta build (`VITE_KICKBACK_ENV=private_beta`) | clean |

`tests/db` not run — no DB, RPC, RLS or migration change. Mutation universe not
run. `test:analytics` not run. Nothing exceeded five minutes.

## Exact beta installation instructions

**Developer, once per release:**

```bash
npm run package:beta
```

Produces `releases/Kickback-Private-Beta-v0.4.0.zip` after verifying hosted
config, the group backend, the extension ID, the file allow-list and the secret
scan. **If it refuses, do not hand-assemble a ZIP** — the refusal is the check
working.

Send the ZIP. It contains `README-TESTERS.txt` with these steps:

**Tester:**

1. Extract the ZIP somewhere permanent (Documents or Desktop — **not**
   Downloads).
2. Open Chrome → `chrome://extensions`.
3. Turn on **Developer mode** (top right).
4. **Load unpacked** → select the extracted `Kickback` folder.
5. Open Twitch.
6. Click **Continue with Twitch** in the Kickback panel.
7. `+ Add` → search your friends by Twitch username → send requests.

**Updates:** extract the new ZIP over the **same folder**, reload on
`chrome://extensions`, refresh Twitch. Same folder path = stays signed in.

## Exact developer analysis instructions

Open the Supabase SQL editor and work through
[`docs/BETA_ANALYSIS.md`](../BETA_ANALYSIS.md) top to bottom. Run §0 first
every time.

Before the first read, mark yourself internal:

```sql
update public.analytics_actors set is_internal = true
where user_id in (select id from public.users where display_name in ('AnoterosTV'));
```

To answer *"did Gravity actually cause people to JOIN?"* after a week: run §2
(exposure), then §3 (conversion by friend-count segment), then §4 (arrival by
source). Read the *"what this join is not"* note before quoting anything.

Schema health, any time: `npm run verify:analytics`.

## Recommendation

**GO**, for a hand-distributed cohort, once `apply_all.sql` has been applied to
hosted and Block is confirmed working with two accounts.

The product loop is complete and instrumented end to end. Packaging is stronger
than expected and refuses to ship a broken or leaky artifact. The safety gate is
done. The one genuine blocker — a user card that was invisible on the panel size
every tester starts with — is fixed and now has a browser gate that would have
caught it.

Go in knowing two things. The **cold start is solved by the distribution, not by
the product**, so a successful beta says nothing about organic growth. And the
central claim will be *correlational*, not causal: no holdout, and exposure →
click matched on a time window. Both are the right trades at this size, and both
must travel with the numbers.
