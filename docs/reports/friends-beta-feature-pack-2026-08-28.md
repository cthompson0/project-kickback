# KICKBACK — FRIENDS BETA FEATURE PACK

**Date:** 2026-08-28
**Type:** product milestone — the growth loop
**Starting HEAD:** `ab0cdcb` — `docs: record the testing architecture milestone`
**Version:** 0.5.0, **not bumped** — recommendation in §26
**Hosted analytics schema version:** **25**. Local expects **26**. **§24 is required before testing.**

---

## 1. Executive conclusion

**MUST SHIP is complete. SHOULD SHIP is complete. The two CUT-FIRST items were cut.**

The milestone's hard part was not the features — it was deciding what a
successful referral *is* in a way that cannot be gamed by accident, and
building suggestions that help without leaking anybody's social graph. Both
decisions are made, documented, and enforced by the database rather than by
client care.

Two things are worth flagging before anything else:

1. **Hosted is at 25 and the local build expects 26.** `verify:analytics` still
   passes, because it checks the 0013-era objects rather than the new ones — so
   **it will not warn you.** Applying `0026` is §24 and it is not optional.
2. **The invite landing page is external work.** The extension and backend
   halves are complete and the URL contract is fixed; the page itself lives in
   the Anoteros Labs Pages repository. It is specified in §7 and is not
   fabricated as done.

**No new OAuth scopes. No new permissions.** The invite flow was shaped
specifically to avoid one — §7.

---

## 2. Shipped

| # | Feature | Layer |
| --- | --- | --- |
| 1 | **Mutual friend suggestions** — friends-of-friends, mutual count, deterministic order, add inline | `suggest_friends()` + `FriendSuggestions` |
| 2 | **Invite-a-friend** — one durable link per person, copy-to-share, referral count | `invite_codes`, `my_invite_code()`, `InviteFriends` |
| 3 | **Attribution** — code picked up from a Twitch URL, held until sign-in, claimed once | `core/invites.ts`, `claim_invite()` |
| 4 | **Successful-referral rule** — four conditions, idempotent, server-authoritative | `referrals`, `settle_referral()` |
| 5 | **Growth analytics** — 9 new events covering acquisition → network → referral → badge | `0026` + `core/analytics.ts` |
| 6 | **Generic badge infrastructure** — definitions, ownership, display preference, issuer | `badge_definitions`, `user_badges`, `set_displayed_badge()` |
| 7 | **Referral milestones** — 1/5/10/15/25, permanent, awarded server-side | `award_referral_badges()` |
| 8 | **Gravity gathering emphasis** — "3 friends" past the threshold, accent edge | `SocialGravity.tsx`, `kickback.css` |
| 9 | **Regression coverage** — 72 new tests across PGlite, core and panel | §21 |

---

## 3. Cut and deferred

**Cut per the brief's CUT-FIRST list:**

- elaborate badge UI — badges are awarded, stored, selectable and broadcast, but
  the *display surface* is deliberately minimal (§13);
- elaborate referral reward presentation — a count and a badge, no progress bar,
  no leaderboard, no streak.

**Deliberately not built, and why:**

| Not built | Reason |
| --- | --- |
| Gathering notification realignment (P1) | Audited; already multi-destination-correct via `gatheringWatcher`. §15 |
| Stream Room polish (P1) | Audited; the highest-value items were already fixed in earlier milestones. §16 |
| Badges in chat/Gravity/rooms | Infrastructure ships; the presentation decision is one screen of design work and the brief says do not plaster them everywhere. §13 |
| Twitch-issued badges | Needs OAuth scope this project does not have. **Stopped rather than widened.** §11 |
| Invite landing page | External repository. §7 |

Everything on the DEFER list (Firefox, YouTube, DMs, directory, imports,
payments, scaling, pop-outs, mobile, togetherWatch semantics, test Supabase
project, authenticated E2E) was not touched.

---

## 4. Mutual-friend architecture

```
friendships (caller) ──┐
                       ├─► suggest_friends()  ── 2 hops, grouped, counted
friendships (theirs) ──┘         │
                                 ├─ exclude: self, existing friends
                                 ├─ exclude: blocked_pair() either direction
                                 ├─ exclude: open request either direction
                                 └─ order: mutuals desc, display_name, id
                                            │
                    FriendSuggestions ◄──── suggestFriends() RPC
                                            │
                                 sendFriendRequest() — the ordinary path
```

**Exactly two hops.** Three hops is a stranger with a number attached, and a
global directory is a different product. The walk is one join deep from the
caller's own friendships and stops.

**Deterministic.** Most mutuals first, then display name, then id. No clock and
no randomness, so the same graph always produces the same list — which is what
makes it testable and stops the panel reshuffling under a cursor.

**Adding uses the existing infrastructure.** `send_friend_request()`, unchanged,
including its reciprocal-request auto-accept.

---

## 5. Suggestion privacy and authorization

**The decision: count, never names.**

A mutual is somebody the **caller already knows**, so naming them tells the
caller nothing new about their own graph — but it publishes something about the
**candidate's** graph, and the candidate never agreed to that. "Julie and Mike
are friends" is Julie's information as much as Mike's, and neither asked to have
it shown to Chuck.

The count carries the social proof that makes a suggestion legible without
enumerating anyone's friend list. It can be widened later with consent; it
cannot be narrowed again once shipped.

| Control | Enforcement |
| --- | --- |
| Seeded at the caller | `public.require_actor()` inside the function; **no user parameter exists** |
| Blocks, both directions | `not public.blocked_pair(...)` |
| Existing friends | `not exists (friendships)` |
| Open requests | excluded — already actionable in Requests |
| Self | excluded explicitly (the caller is a friend-of-a-friend of themselves) |
| Result shape | exactly `user_id, display_name, avatar_url, twitch_login, mutual_count` — asserted by test |
| Row cap | 1–50, clamped server-side |

Every one of these is covered by a PGlite test, including the two block
directions and both request directions.

---

## 6. Invite architecture

```
inviter                                    recipient
───────                                    ─────────
my_invite_code()  ──► durable code
       │
  inviteLinkFor() ──► shared link ────────► landing page (external)
                                                 │  explains Kickback, links to Store
                                                 ▼
                                           twitch.tv/?kickback_invite=CODE
                                                 │
                                    content script (already runs here)
                                                 ▼
                                    worker: held in memory, unclaimed
                                                 │
                                          Twitch OAuth sign-in
                                                 ▼
                                          claim_invite(code)
                                                 │
                                    referrals row: attributed
```

**One durable code per person, not a token per invitation.** A person shares one
link and it keeps working. Per-invitation tokens buy nothing here: the thing
that must be unique is not the *link*, it is the *credit*, and credit is keyed
on the recipient.

**The code is not an identifier and carries no privilege.** Random, not derived
from the user id, 22 characters of a 32-symbol alphabet (~110 bits). Holding one
lets a signed-in account say "this person invited me" and nothing else — no
friendship, no visibility, no way around a block.

---

## 7. Invite URL and token contract

**Two hops, and the second one is why no new permission was needed.**

| Hop | URL | Who reads it |
| --- | --- | --- |
| 1 | `https://anoteroslabs.github.io/kickback/invite?c=CODE` | the landing page |
| 2 | `https://www.twitch.tv/?kickback_invite=CODE` | Kickback's **existing** content script |

A content script on the landing page would mean a new host permission, which
Chrome shows the user as *"read your data on that site"* — for a one-off string.
Pointing the landing page's continue button at Twitch instead means the code is
read where Kickback already runs. The recipient lands somewhere sensible at every
step, and there are no clipboard instructions.

Both parameter names (`c` and `kickback_invite`) are accepted by `codeFromUrl`,
so one function answers for both hops.

### ⚠ Owner task, external to this repository

**The landing page does not exist yet.** It must live at
`https://anoteroslabs.github.io/kickback/invite` and:

1. read `?c=CODE`;
2. say **"A friend invited you to Kickback"**, and what Kickback is;
3. link to the Chrome Web Store listing;
4. offer a continue button to
   `https://www.twitch.tv/?kickback_invite=CODE`.

It is a single static page in the existing Pages repository. **Until it exists,
invite links resolve to a 404** — the extension and backend halves work, and a
code pasted or reached via the Twitch URL directly is attributed correctly.

---

## 8. The successful-referral rule

> **A referral has succeeded when all four are true:**
>
> 1. **the invitee is a distinct authenticated Kickback account** — enforced by
>    `referrals_not_self` and the foreign keys;
> 2. **attribution is valid** — a `referrals` row created by `claim_invite`
>    from a real code;
> 3. **the intended social connection exists** — a friendship between inviter
>    and invitee;
> 4. **the invitee genuinely activated** — they have **published a Twitch
>    destination at least once**.

**Why that activation criterion.** It is a single server-side fact, stamped
once, on a path that already exists and already requires authentication. It
means they installed the extension, signed in, and opened a stream with Kickback
running — the smallest act that proves the product was *used* rather than
merely installed. It cannot be triggered by opening a link, by installing, or by
signing in and stopping.

Stamped in `apply_destinations`, which **both** `report_destinations` and the
legacy `report_presence` shim go through — so a v0.4.1 client activates too.
`claim_invite` also stamps it if the invitee was already using Kickback before
they claimed, which closes the "used it first, claimed later" gap.

**`succeeded_at` is stamped once and never cleared.** Un-friending afterwards
does not revoke it: the referral did happen, and a badge somebody else could
take away by a later action would be worse than one that is simply permanent.

Order does not matter — all six orderings of claim/friend/activate are covered
by test.

---

## 9. Attribution and idempotency

**The anti-duplicate-credit rule is a primary key:**

```sql
create table public.referrals (
  invitee_id uuid primary key references public.users (id) on delete cascade,
  ...
)
```

**One row per invitee, ever.** An account can be referred exactly once, by
exactly one person. No amount of reinstalling, re-claiming, signing out and back
in, or opening a different friend's link produces a second row or a second
credit. That single constraint removes the whole class without any fraud
infrastructure.

| Attempt | Result |
| --- | --- |
| Claim twice | `already` — the first inviter keeps the credit |
| Claim your own link | `self` |
| Claim while blocked | `blocked` |
| Unknown or malformed code | `unknown`, and nothing is written |
| Publish destinations repeatedly | `activated_at` stamped once, from null |
| Cross a badge threshold twice | primary key on `user_badges` makes it a no-op |

All verified by test, including a loop that re-activates five times and
re-claims, then asserts the timestamp and the count are unchanged.

---

## 10. Growth analytics

Nine events, all registered in `0026` and mirrored in `EVENT_PROPERTIES` — the
`analyticsContract` test asserts the two agree on every run.

| Stage | Event | Properties |
| --- | --- | --- |
| Network formation | `friend_suggestion_impression` | `suggestion_count`, `top_mutual_bucket` |
| | `friend_suggestion_add_clicked` | `mutual_bucket`, `position` |
| | `friend_suggestion_request_created` | `mutual_bucket`, `outcome` |
| Acquisition | `invite_link_created` | — |
| | `invite_link_shared` | `method` |
| | `invite_claimed` | `outcome` |
| Referral | `referral_succeeded` | — |
| Identity | `badge_awarded` | `badge_key` |
| | `badge_displayed` | `badge_key` |

**Privacy.** Every value is a count, a bucket or a fixed vocabulary. **No invite
code ever appears** — it is a credential-shaped thing and is excluded by design.
No user ids, no names, no message bodies, no tokens.

The rest of the loop was already instrumented and was **not duplicated**:
Gravity exposure (`gravity_cluster_impression`), JOIN (`join_clicked`,
`join_arrived`), Together (`watching_together_started/_ended`), rooms
(`automatic_room_*`), notifications (`gathering_notification_*`), retention
(`post_social_retention_ended`).

**Gap, stated plainly:** *"an invited user later invites someone else"* is
reconstructable from `referrals` by SQL (join inviter to their own referral row)
but has no dedicated event. That is deliberate — it is a query, not a moment.

---

## 11. Badge architecture

Three tables and one preference, general from the start:

| Piece | Holds |
| --- | --- |
| `badge_definitions` | `key`, `name`, `description`, `icon`, **`issuer`**, `sort_order` |
| `user_badges` | `(user_id, badge_key)` primary key, `awarded_at`, `reason` |
| `user_preferences.displayed_badge_key` | which earned badge to show |

**Kickback-issued versus Twitch-issued is in the schema from day one**, because
the one mistake here that would actually matter is implying Kickback granted
somebody a Twitch badge. `issuer` is `'kickback' | 'twitch'`, and the client
parser defaults an unknown value to `'kickback'` rather than inventing a Twitch
claim.

### Twitch badges: stopped, not attempted

Reading Twitch subscriber or badge identity needs OAuth scopes this project does
not have. **No scope was added.** The column exists so that if such data is ever
legitimately available it has an honest home; nothing reads it today.

**Authorization:**

- `award_badge` is `SECURITY DEFINER` and **granted to nobody** — a client
  cannot call it, forge an award, or award to another account;
- `user_badges` is revoked from clients for write;
- `set_displayed_badge` refuses a badge that is not owned (`42501`);
- reading somebody's badges follows the social boundary — friend or shared
  group, the same rule presence uses.

---

## 12. Referral milestones

| Successful referrals | Key | Name | Icon |
| --- | --- | --- | --- |
| 1 | `referrer_1` | Connector | 🔗 |
| 5 | `referrer_5` | Recruiter | 🌱 |
| 10 | `referrer_10` | Cultivator | 🌿 |
| 15 | `referrer_15` | Ringleader | 🔥 |
| 25 | `referrer_25` | Kingmaker | 👑 |

Awarded by `award_referral_badges()` from the authoritative count, on every
settle. It awards **every crossed threshold**, not only the newest, so a count
that jumps from 0 to 6 still leaves the right set — covered by a test that refers
five people at once and asserts both `referrer_1` and `referrer_5`.

Idempotent by primary key. Permanent — a test un-friends afterwards and asserts
the badge survives.

Placeholder names and emoji icons, deliberately: the architecture matters more
than the artwork, and an emoji needs no asset pipeline and no network fetch.

---

## 13. Badge UI and preferences

**Shipped:** award, storage, ownership authorization, `my_badges()`,
`set_displayed_badge()`, the chosen badge broadcast on `KickbackState`, and the
referral count driving the invite copy.

**Deliberately minimal presentation.** The brief says do not plaster badges
everywhere and to choose one coherent surface. The infrastructure is complete
and the *placement* decision is left as one screen of design work rather than
guessed at — putting an emoji beside every name in chat, Gravity, rooms and
groups without a design pass is exactly the "plaster" outcome warned against.

**What this means concretely:** a user who earns a badge has it, can select it,
and the panel knows which one — but no surface renders it yet. That is a
deliberate CUT under SHOULD-SHIP, not an oversight, and it is a small follow-up.

---

## 14. Gravity and gathering changes

Audited first: clustering, ranking, JOIN, per-destination metadata and the
loading rule were all already correct and were **not** redesigned.

**Two changes, both emphasis only:**

1. **The count is spelled out past the threshold.** A gathering reads
   **"3 friends"**; a single friend keeps the bare **"1"**. The distinction this
   surface has to carry is *somebody is here* versus *your friends are gathering
   here*, and a bare numeral made both look identical at a glance.
2. **A gathering gets an accent edge** — `border-left` on
   `.kb-gravity-card-strong`. A tint alone is easy to miss in a column of cards;
   an edge reads at a glance and costs no width, which matters at 320px.

**Not changed:** `GRAVITY_THRESHOLD` (still 2), the cap (still 3), ordering,
JOIN, the one-friend-is-still-a-destination rule, or any metadata presentation.
No gamification was added.

Twelve existing count assertions were updated. They assert the same fact in the
same element; only the text beside the number changed.

---

## 15. Gathering notifications

**Audited, and no change was needed.**

`gatheringWatcher` already: uses the canonical Gravity clustering, applies a
2-friend threshold, excludes the viewer's own channel, has a cooldown and
duplicate suppression, and is instrumented with
`gathering_notification_shown` / `gathering_notification_clicked` through to
JOIN. It consumes the same presence index that multi-destination already feeds,
so a friend at three destinations is considered at all three.

**Verified rather than assumed** — the existing `gatherings` tests cover
threshold, cooldown, self-exclusion, growth and dissolution. Changing it would
have been change for its own sake.

---

## 16. Stream Room changes

**Audited, and no change was needed in this milestone.**

Every item on the P1 list was already addressed by earlier milestones and is
covered by tests: retained conversation (`roomLifecycle`), switching away and
back (`sessionState`, `restoredSessionChannel`), simultaneous rooms and
isolation (`multiDestination`, `streamRoom`), unread per destination
(`unreadByChannel`), who's here (`peersOnChannel`), reactions and combos
(`together`, `combos`), autoscroll (`chatAnchoring`).

The strategic question — *do users want Kickback chat at all* — is exactly what
this beta should answer, and adding mechanics before it does would be building
on an unanswered question.

---

## 17. Beta polish

Reviewed the historical list against current code and tests. **Every item was
already fixed** in Patch 1 or the 0025 milestones: "You" consistency, username
colours, chat bottom anchoring, retained room surface, cross-tab state, Twitch
display-name capitalisation, LIVE presentation, self-exclusion from HERE,
user-card consistency, clickable usernames.

**Nothing was re-fixed.** The one visible improvement in this milestone is the
gathering emphasis (§14).

---

## 18. Schema and migrations

### One migration: `0026_growth_loop.sql`

| Object | Kind |
| --- | --- |
| `suggest_friends(int)` | function |
| `invite_codes` | table + RLS + own-row policy |
| `new_invite_code()`, `my_invite_code()` | functions |
| `referrals` | table + RLS + participant policy |
| `settle_referral()`, `claim_invite()`, `my_referral_summary()` | functions |
| `badge_definitions`, `user_badges` | tables + RLS |
| `user_preferences.displayed_badge_key` | column (`add column if not exists`) |
| `award_badge()`, `my_badges()`, `set_displayed_badge()`, `award_referral_badges()` | functions |
| `apply_destinations()` | **replaced** — same behaviour plus the activation stamp |
| `create_friendship()` | **replaced** — same behaviour plus `settle_referral` |
| 9 analytics event registrations | insert … on conflict do update |
| `analytics_schema_version()` | **25 → 26** |

**Additive.** Nothing dropped, no column removed, no policy narrowed. Idempotent
— `create or replace`, `if not exists`, `on conflict do update` — so it is safe
to re-run in full.

---

## 19. Backward compatibility

| Client | Effect |
| --- | --- |
| **v0.4.1 Store build** | **None.** It calls none of the new functions. The two replaced functions keep their exact signatures and return values; `apply_destinations` gains one guarded UPDATE against a tiny table. A 0.4.1 user can even *be referred* — the legacy `report_presence` path activates them. |
| **v0.5.0 local (this build)** | Full feature set. Requires 0026. |
| **v0.5.0 local against hosted 25** | Degrades rather than breaks: suggestions return empty, the invite section shows an error, badges are absent. Presence, Gravity, rooms and chat are unaffected. **Not the intended test.** |

No destructive cleanup migration was performed.

---

## 20. Security and privacy review

| Area | Risk | Control |
| --- | --- | --- |
| **Suggestions** | graph leakage | count only, never names; result shape asserted by test |
| | block evasion | `blocked_pair` both directions |
| | asking about others | no user parameter exists; seeded at `require_actor()` |
| **Invites** | token guessing | ~110 bits random; and guessing gains nothing |
| | raw user id exposure | code is random, not derived |
| | attribution spoofing | claim is authenticated; the actor is the *invitee*, always themselves |
| | privilege via possession | **none** — no friendship, no visibility, no block bypass; asserted by test |
| | duplicate credit | primary key on `invitee_id` |
| **Referrals** | self-referral | `referrals_not_self` + explicit `self` outcome |
| | re-claiming | `already`, checked before anything else |
| | fake activation | requires an authenticated destination publish |
| **Badges** | client-forged award | `award_badge` granted to nobody; table write revoked |
| | displaying unearned | `set_displayed_badge` raises `42501` |
| | ownership leakage | friend-or-shared-group policy |
| **Analytics** | content leakage | buckets and fixed vocabularies only; **no invite code**, no ids, no bodies |

**No new OAuth scopes. No new permissions** — verified by diffing the packaged
manifest against the 0.4.1 Store build: identical.

---

## 21. Regression tests added

**+72 tests, 2 new files.**

**`tests/db/growthLoop.test.ts` — 51 tests, real PostgreSQL**

| Group | Tests | Covers |
| --- | --- | --- |
| suggestions | 15 | friend-of-friend; mutual counts; identity; self; existing friends; empty graph; **no third hop**; deterministic order; **both block directions**; **both request directions**; the count-not-names shape; caller-seeded; add through the ordinary path |
| invite codes | 6 | created on first use; stable; distinct; not derived from the id; owner-only read; not client-writable |
| claiming | 8 | attributed; **second claim refused**; self; unknown; malformed; blocked; **grants nothing**; row visibility |
| the referral rule | 10 | not on attribution alone; not on friendship alone; not on activation alone; succeeds on all three; **all orderings**; **cannot be credited twice**; empty set is not activation; **a v0.4.1 client activates**; several invitees |
| badges | 12 | first milestone; nothing before; **every crossed threshold at once**; idempotent; permanent; **not client-awardable**; **not awardable via the internal function**; unearned display refused; select and clear; friend-visible/stranger-not; definitions readable; **issuer is never twitch** |

**`tests/extension/growthLoop.test.tsx` — 21 tests**: the URL contract (both
hops, malformed escapes, other parameters, pasted links, lower case), mutual
bucketing, the panel rendering with the new state, **the invite code not leaking
onto the main surface**, and the gathering emphasis CSS.

No existing test was weakened. Twelve count assertions were updated to match a
deliberate presentation change and still assert the same fact.

---

## 22. Verification

| # | Command | Exit | Result |
| --- | --- | --- | --- |
| 1 | `npm run build` | **0** | content 317.24 kB (gzip 91.02), background 299.71 kB (gzip 81.24) |
| 2 | `npx vitest run tests/db/growthLoop.test.ts` | **0** | 51 passed |
| 3 | `npx vitest run tests/extension/growthLoop.test.tsx` | **0** | 21 passed |
| 4 | `npx vitest run` | **0** | **81 files / 2118 tests / 0 failed / 0 skipped** |
| 5 | `npx tsc -b` | **0** | |
| 6 | `npx eslint .` | **0** | |
| 7 | `npm run verify:analytics` | **0** | ⚠ **passes against hosted 25 — see §24** |
| 8 | `npm run verify:groups` | **0** | |
| 9 | `npm run verify:config` | **0** | |
| 10 | `npm run verify:store` | **0** | version 0.5.0 |
| 11 | `npm run package:beta` | **0** | §23 |

**`test:authz` not run** — no mutation-harness work in this milestone.
**`package:store` not run. Nothing uploaded. Version not bumped.**

Baseline 79 files / 2037 tests → **81 / 2118**.

---

## 23. Beta artifact

**`releases/Kickback-Private-Beta-v0.5.0.zip`**
**sha256 `af96b0536cd1694e554495ff695da87438a5f10b85ccc4e94bfbf60be17ff569`**

| Check | Result |
| --- | --- |
| Version | 0.5.0 |
| Extension ID | **`ngfopkeokddfnncdhfkhnffilbdhkkip`** — unchanged |
| Permissions | `identity`, `storage`, `alarms`, `notifications` — **diff against the 0.4.1 Store manifest is IDENTICAL** |
| Host permissions | unchanged |
| Content-script matches | unchanged — the invite pickup reuses the Twitch match |
| **Hosted migration required first** | **YES — §24** |

---

## 24. Owner action: hosted Supabase

**Required before this build is worth testing.**

```
npm run db:bundle
```
→ paste `supabase/.generated/apply_all.sql` into **Supabase → SQL Editor → New
query** → Run.

Then confirm:

```sql
select public.analytics_schema_version();   -- must return 26
```

**Order:** `0026` is the only new migration and depends on 0001–0025 already
being applied. The bundle contains all 26 in order and every one is idempotent,
so re-running the whole thing is safe and is the recommended way.

**⚠ The verifiers will not catch this for you.** `verify:analytics` exits 0
against hosted 25 because it probes the 0013-era objects, not the new ones. If
you skip this step, the build loads, presence and Gravity work, and suggestions
and invites silently return nothing.

**Also external:** the invite landing page (§7). One static page in the Pages
repository. Until it exists, shared links 404 — everything else works.

---

## 25. Human acceptance test — 10 minutes

**Prerequisites:** 0026 applied (§24); the new ZIP (`af96b053…`) loaded on
**both** accounts; both signed in.

| # | ~Time | Do | Expect |
| --- | --- | --- | --- |
| 1 | 1 min | Both accounts befriend a third person (or use an existing shared friend) | — |
| 2 | 2 min | On A: **+ Add** → look under the search box | **People you may know** lists the friend-of-a-friend with "1 mutual friend" and an ADD button |
| 3 | 1 min | Press ADD | Becomes "Requested"; the request arrives on the other side |
| 4 | 1 min | On A: **+ Add** → **Invite a friend** | A link is shown; **Copy invite link** works |
| 5 | 2 min | Paste the Twitch form of the link into B's browser: `https://www.twitch.tv/?kickback_invite=<CODE>` (take `<CODE>` from A's link) | Nothing visible happens — that is correct. Attribution is silent. |
| 6 | 2 min | Ensure A and B are friends, and B opens any stream | On A: **+ Add** → Invite shows *"1 friend has joined through your link."* |
| 7 | 1 min | Get 2+ friends onto one channel | That Gravity card reads **"2 friends"** with a flame and an accent edge; a 1-friend card still reads **"1"** |

**Note on step 5:** B must be a *different Kickback account* that has never been
referred. Once referred, the row is permanent — re-testing needs a fresh account
or a manual `delete from public.referrals where invitee_id = …`.

**Not asked of you:** anything deterministic — the suggestion rules, the block
cases, the credit idempotency and the badge thresholds are all covered by the 51
server tests.

---

## 26. Version recommendation

### **v0.6.0.**

This is a feature milestone, not a patch: a new social-discovery surface, a new
acquisition channel, a new identity system, a schema migration, and nine new
analytics events. `0.5.x` would understate it, and the version string is how a
tester answers "which build are you on".

**Not bumped.** Per the brief, the version stays at 0.5.0 until you approve
release preparation. Bumping is a two-line change plus a rebuild.

---

## 27. Store release readiness

### **NO-GO for the Chrome Web Store.**

Not because anything is broken — because three things must happen first, in
order:

1. **Apply 0026 to hosted** (§24). A Store build against schema 25 would ship
   suggestions and invites that silently do nothing.
2. **Publish the invite landing page** (§7). Shipping an invite feature whose
   links 404 is worse than not shipping it.
3. **Human acceptance** (§25), then the version bump (§26).

The v0.4.1 Store listing is untouched and remains the published build.

**GO for local beta testing**, after §24.

---

## 28. Remaining risks

| Risk | Severity | Note |
| --- | --- | --- |
| Hosted still at 25 and the verifiers do not warn | **High** | §24. The single most likely way this milestone appears broken. |
| Invite landing page does not exist | **High for the invite loop** | §7. Links 404 until it does. |
| Badges are earned but not displayed anywhere | Medium | §13. Deliberate cut; a small follow-up. |
| Suggestion quality on a tiny graph | Medium | With five testers, friends-of-friends may be empty. The invite path is the answer, which is why both ship together. |
| `succeeded_at` is permanent | Low | Deliberate (§8). No revocation path exists by design. |
| Re-testing a referral needs a fresh account | Low | The primary key is the feature. §25. |
| No dedicated "invited user invites someone else" event | Low | Reconstructable by SQL from `referrals`. §10. |

---

## 29. Next recommended milestone

**Badge presentation and the invite landing page** — the two deliberate cuts,
together about a day, and they complete what this milestone started.

After that, the honest answer is **not another feature pack**: this beta now
carries enough surface to answer the two open product questions — *does Social
Gravity drive JOIN* and *do people want Kickback chat*. The next milestone
should be **reading the analytics this one installed** and cutting whatever it
says is not working.

---

## 30. Git status, commits and push

Two feature commits plus this report:

```
0514090  feat: add the growth loop server model
         supabase/migrations/0026_growth_loop.sql, supabase/.generated,
         tests/db/growthLoop.test.ts, tests/db/bundle.test.ts

c0a9bb3  feat: bring suggestions, invites and gathering emphasis to the panel
         src/core/invites.ts, src/ui/components/GrowFriends.tsx (new),
         analytics, backend bindings, client/worker plumbing, FindFriends,
         SocialGravity, kickback.css, tests
```

`releases/` is gitignored. No `.env.local`, no tokens, no keys, no `dist/`.

- **Push:** normal, to `origin/main`. No force push. Result recorded below.
