# M5C — Acquisition attribution and campaign measurement

**Date:** 2026-09-01
**Branch:** main
**Schema:** 37 → **38**
**Preceded by:** M5B — public surface + product comprehension

---

## 1. Executive verdict

**★ GO.**

Watchside can now answer "how did this person come to Watchside" as a durable,
server-authoritative fact, kept strictly apart from "who invited them" — which
already existed and is untouched.

The shape is small on purpose. A campaign link carries **one opaque code and
nothing else**; everything about what that campaign *is* resolves server-side
from a registry the visitor cannot write to. First touch is immutable and is
what every report joins on. The pre-auth touch lives in the extension's own
storage for seven days and then expires. Two new tables, one new RPC, one new
analytics event, three views.

**The finding that governs everything else:** the acquisition parameter is read
by **no released build**. Chrome 0.6 is live, Chrome 0.7 is in review, Firefox
0.6 is awaiting first review — none of them contains this code. So M5C collects
nothing today, and **the marketing gate stays closed until a build carrying it
is distributed**. That is not a defect; it is the honest state, and it is the
reason to build the instrumentation before spending rather than after.

The second finding is a limit rather than a gap. Link clicks, Store page views
and installs are **unobservable** without cross-site tracking, which Watchside
does not do and will not. A campaign touch becomes a fact at the moment it binds
to an authenticated account and never before. Every number built on this is
therefore "acquired users we could attribute", never "clicks".

---

## 2. What already existed

Traced from the implementation rather than from previous reports.

| Concern | Where it lives | State |
| --- | --- | --- |
| Friend referral | `referrals` (0026), one row per invitee ever | durable, in production |
| Referral settlement | `settle_referral`, three-condition rule | untouched |
| Invite handoff | landing page → `twitch.tv/?kickback_invite=` → content script | untouched |
| Pre-auth invite hold | worker **memory only**, `pendingInviteCode` | untouched |
| Analytics ingestion | `analytics_track`, actor is always `auth.uid()` | untouched |
| Internal exclusion | `analytics_actors.is_internal` → `analytics_reportable_events_v` | reused |
| Deletion | `auth.admin.deleteUser` → cascade from `public.users` | reused |
| Activation vocabulary | `referrals.activated_at`, `authenticated_session_started`, `join_clicked` | reused |
| Retention | `analytics_return_v` (1d/7d/30d) | reused |
| Campaign/source fields | **none anywhere** | clean slate |

Two facts from that audit shaped the whole design.

**There is no anonymous analytics identity.** `analytics_events.actor_id` is
`not null` and is always `auth.uid()`. Nothing pre-auth can be recorded at all
without inventing an anonymous identity and an endpoint to receive it — which is
precisely the tracking this project has refused everywhere else. So the
observability map below has genuine holes in it, and they are left as holes.

**Deletion is a cascade, not a procedure.** Any table referencing
`public.users(id) on delete cascade` is deleted correctly by construction. That
is the pattern the new attribution table follows, so account deletion needed no
new code and no new promise.

---

## 3. Observability map

The stage-by-stage honest answer, written before implementation.

| Stage | Class | Why |
| --- | --- | --- |
| Campaign link visited | **UNOBSERVABLE** | The site is static, has no backend, sets no cookies and makes no third-party requests. Observing this means adding a beacon, which is the tracking we refuse. |
| Store listing viewed | **UNOBSERVABLE** | Google exposes nothing we possess that ties a view to a later install. |
| Extension installed | **UNOBSERVABLE** | No install attribution exists on either store. Claiming otherwise would be fabrication. |
| Campaign touch seen on Twitch | **OBSERVED, client-local** | The content script reads the parameter. Not reported anywhere until it binds. |
| First authenticated session | **OBSERVED** | `authenticated_session_started`, already existed. |
| Campaign touch bound to an actor | **ATTRIBUTED** | `bind_acquisition`, server-authoritative. This is where acquisition becomes a fact. |
| Friend referral carried into auth | **ATTRIBUTED** | Unchanged from 0026. |
| Friend graph formation | **OBSERVED** | `friendships`. |
| Gravity exposure | **OBSERVED** | `gravity_cluster_impression`. |
| JOIN | **OBSERVED** | `join_clicked` / `join_arrived`. |
| Twitch consumption | **OBSERVED, partial** | `channel_dwell_ended` — only what Watchside sees. |
| Retention | **OBSERVED** | `analytics_return_v`. |
| Downstream invitees | **ATTRIBUTED, reconstructable** | A join across `referrals`, never a copied value. |
| "Campaign X caused more viewing" | **NOT OBSERVABLE — never claimed** | Observational cohort comparison is not causal. |

The three UNOBSERVABLE rows are the whole of what a conventional ad-tech setup
would buy, and each would cost cross-site tracking. The consequence, stated
where it will be read: **there is no denominator of clicks**, so no campaign
conversion rate can ever be computed. What is computable is everything from
"bound" rightwards.

---

## 4. Three concepts, kept apart

| | Question | Where |
| --- | --- | --- |
| **acquisition** | how did they discover Watchside | `acquisition_attribution` |
| **friend referral** | which Watchside user invited them | `referrals` (0026) |
| **creator/campaign** | which campaign the touch belonged to | `acquisition_campaigns` |

A person can have all three. The separation is enforced at every layer, not by
convention:

| Layer | Referral | Acquisition |
| --- | --- | --- |
| path | `/i/<code>` | `/c/<code>` |
| code shape | 22 chars, uppercase alphabet | lowercase slug, 2–32 |
| Twitch parameter | `kickback_invite` | `watchside_campaign` |
| worker message | `invite` | `campaign` |
| pre-auth storage | memory | storage, with expiry |
| RPC | `claim_invite` | `bind_acquisition` |
| table | `referrals` | `acquisition_attribution` |

**A subtlety worth recording, because the comfortable assumption is wrong.** The
two code alphabets are *not* disjoint: an invite code lower-cased is also a
syntactically valid campaign code. Shape alone does not separate them. What does
is the three structural differences above plus the registry lookup — a
lowercased invite code offered as a campaign resolves to nothing and writes no
row. A test asserts exactly this, including the overlap, rather than asserting a
disjointness that would have been false and would have broken the first time
either pattern was widened.

---

## 5. Campaign links

```
https://watchside.app/c/lirik-oct
https://watchside.app/c/tiktok-launch
```

**Not UTM parameters.** The conventional `?utm_source=tiktok&utm_campaign=…`
form lets the URL assert its own metadata, which is fine when the only consumer
is a marketer reading their own dashboard and fatal when the number is meant to
be evidence: anybody can write any source into any link, including into a link
they post as somebody else. A registry-resolved code means a campaign's meaning
is something the server already agreed to.

**Readable, not opaque.** These end up in a stream panel, a TikTok bio and a
YouTube description, where a hash is a thing people mistype and nobody can sanity
check. `lirik-oct` can be read aloud.

**The code is the identity; the label is not.** `code` is immutable; `label` is
a separate column that can be edited freely. A campaign renamed from "October
creator test" to "LIRIK October" keeps every link already sitting in a Discord
message, a screenshot or a bookmark. Deriving the URL from a display name would
have made a rename a silent link breakage — which is exactly the failure the
brief asked to avoid, and it is enforced by a trigger rather than by discipline.

Minting is one command:

```
npm run campaign -- --code lirik-oct --source creator --creator lirik --label "LIRIK October"
```

It validates every constraint the database enforces and prints SQL. It does not
execute: minting a campaign is a decision rather than a build step, and the
alternative would mean holding a database credential somewhere that never needed
one. `--retire <code>` prints the statement that closes a campaign to new
attribution without deleting any history.

No dashboard, no builder, no creator portal.

---

## 6. The attribution model

**Acquisition touch** — a campaign code observed by the extension in a Twitch
URL. Client-local, unreported.

**Bind** — the moment a touch is attached to `auth.uid()` by `bind_acquisition`.
This is the only event that exists server-side.

**First touch** — `first_campaign_code` + `first_touch_at`. Written once at the
first successful bind, **immutable**, enforced by a trigger. This is how the
account came to Watchside, and it is what every report joins on.

**Last touch** — `last_campaign_code` + `last_touch_at` + `touch_count`.
Overwritten by every later bind including a repeat of the same campaign.

Two columns rather than one mutable field, because "how did they originally
arrive" and "which link did they most recently click" are different questions
and one field can only ever answer whichever wrote it last. A cohort computed
today and the same cohort computed next year contain the same people, because
the column they are computed from cannot move.

**Outcomes**, all ordinary, none raising:

| | |
| --- | --- |
| `first` | bound; this is where they came from |
| `repeat` | already attributed; last touch moved, first did not |
| `unknown` | no such campaign — **nothing written at all** |
| `inactive` | campaign exists, closed to new attribution |

`unknown` writing nothing is deliberate. Not a row with a null campaign, not a
row recording the offered string: storing unresolvable client text is exactly
how arbitrary input ends up in a table later read as authoritative.

**Self-attribution** does not arise — a campaign is not a user. The adjacent
protection that does matter is that a campaign cannot grant anything: possession
of a code lets somebody say a campaign brought them and nothing else, exactly as
an invite code confers nothing (0026).

**Idempotency and races.** One row per actor, by primary key. Two tabs binding
at once resolve through `on conflict (actor_id) do nothing`, and the loser
becomes an ordinary no-op rather than an error.

---

## 7. The attribution window

**Seven days. PROVISIONAL.**

The chain it must survive: click the link → read the page → install from the
Store → open Twitch → sign in. The first four are usually one sitting; the last
is not. Somebody who installs on a Tuesday because a streamer mentioned Watchside
may not sign in until the weekend, and a window shorter than that would drop real
acquisitions and make every campaign look worse than it was.

The other direction matters more. **"Forever" is the value that happens by
accident**, and it is the one that corrupts the data: a code left in storage for
two months would attribute a completely unrelated later sign-in to a campaign
that had nothing to do with it. Seven days covers the honest lag and expires
instead of lying.

**Enforced on the client, and that is not an oversight.** The server cannot know
when a link was clicked — only when a bind arrived — so an age passed to it would
be a client assertion wearing a server check's clothes. The rule is one pure
function, `isWithinAttributionWindow`, with its own tests and its own mutation
lever. The boundary is stated explicitly: a touch exactly seven days old still
binds, one millisecond later does not. A touch from the future is refused, so a
machine with a wrong clock cannot hold a code that never expires.

It is a judgement made before there is any data on the real click-to-auth
distribution. The right revision is to measure that lag once data exists; because
the rule is one constant behind one function, revising it is a one-line change
with a proof attached.

---

## 8. The pre-auth handoff

The hardest part, and the one where the honest answer is smaller than the
convenient one.

```
watchside.app/c/lirik-oct
        ↓  (the page builds a link; nothing is stored, nothing is sent)
twitch.tv/?watchside_campaign=lirik-oct
        ↓  content script reads it — Watchside already runs here
worker holds it in extension storage, with a 7-day expiry
        ↓  the person signs in
bind_acquisition('lirik-oct')
```

**Why the hop through Twitch.** A content script on `watchside.app` would need a
host permission, which the browser presents as *"read your data on that site"* —
for one string. The hop reads the code where Watchside already runs, so no new
permission is requested. This is the same mechanism the invite has used since
0026, with a separate key.

**Why persisted, where the invite code is not.** An invite arrives on Twitch
moments before the sign-in the link was pushing towards, so worker memory covers
the gap. A campaign touch has to survive install-then-later-sign-in, and MV3
service workers are recycled in minutes — holding it in memory would mean every
campaign under-reported by however often Chrome felt like recycling. What is
stored is **one opaque slug and a timestamp**, in the extension's own storage,
about its own install; it names a campaign and says nothing about who is reading
it, and it is deleted the moment it binds or expires.

**What was refused:** fingerprinting, cross-site tracking, advertising
identifiers, history inspection, referrer capture, and any claim of deterministic
install attribution. None of these is available honestly, so none is used.

**Coverage limitations, explicitly:**

- **A different browser or device breaks the chain.** Click on a phone, install
  on a desktop — unattributed, and correctly so.
- **A reinstall loses the touch**, unless the person opens the link again.
- **Never signing in means never attributed**, which is right: there is no
  account for the fact to be about.
- **Clearing extension storage** discards it.
- **No released build reads the parameter**, so coverage today is zero.

Every one of those biases attribution *downwards*. A campaign will never be
credited with more than it produced, only less — which is the safer direction for
a number that will be used to decide where to spend.

---

## 9. Campaign registry

`acquisition_campaigns`: `code` (PK, immutable), `source` (closed set),
`creator_key` (nullable, immutable), `label` (mutable), `active`, `created_at`.

**Readable by nobody.** RLS with zero policies, revoked from every client role. A
client never needs it: it sends a code and receives an outcome. Keeping it closed
means the set of live campaigns cannot be enumerated by anyone who installs the
extension — not because the codes are secret, but because the *list* is business
information and nothing needs it.

**`source` and `creator_key` are immutable, enforced by a trigger.** This earns
its keep: `acquisition_attributed` events carry `source` so funnels can group
without a join, and that is only safe while a code's source cannot change.
Otherwise editing one row would silently rewrite what every historical event
meant, and nothing would look wrong. A campaign whose source was recorded wrongly
gets a **new code** — codes are cheap, retroactively-changed history is not.

**`active` closes the future, never the past.** Rows already attributed keep
their attribution and the definition stays, so old numbers remain readable. That
is the difference between disabling a bad link and deleting history, and only one
of them is recoverable.

---

## 10. Creator attribution

`creator_key` is a **stable key we assign** — not a Twitch login, not an account,
not a claim.

Being an acquisition campaign identity must not require the creator to authorize
Watchside, sign in, or know Watchside exists. A streamer who mentions Watchside
once has a campaign associated with them and has authorized nothing. Storing a
Twitch login here would blur exactly that line, and would break if they renamed.

*"This campaign was associated with creator X"* is all it means. It is not
consent, not a partnership, and not a statement about them. Nothing in this
milestone reads any creator's Twitch data, and no scope was added.

---

## 11. Friend-referral coexistence

Nothing in 0038 writes to `referrals`, reads its meaning, or changes any function
that touches it. `claim_invite`, `settle_referral`, `award_referral_badges` and
`my_referral_summary` are byte-identical.

Proved in both directions, in `tests/db/acquisition.test.ts`:

- an acquired user can also be referred, both facts intact;
- a referral does not overwrite acquisition, **in either order**;
- a referred user with no campaign has **no** acquisition row — Bob is not "from"
  Alice's campaign;
- self-referral is still refused;
- `referral_succeeded` and `badge_awarded` are unchanged (their own suite still
  passes untouched).

---

## 12. Downstream lineage

```
streamer campaign → Alice acquired → Alice invites Bob → Bob activates
```

Alice's acquisition is the campaign. Bob's referral is Alice. **Bob's acquisition
is whatever brought Bob**, which is usually nothing at all.

`acquisition_downstream_v` expresses the relationship as a join — one row per
(acquired inviter, invitee) — and carries `invitee_own_campaign_code` so the
invitee's own origin is visible and visibly separate. Nothing is copied into
Bob's row, so no report can accidentally count him as a campaign acquisition.

**One hop, deliberately.** A transitive closure over an invite graph is where
attribution systems go to explode, and the second hop answers a question nobody
has asked. It can be built on this later without unwinding anything.

A mutation lever exists for exactly the wrong version of this — attributing the
invitee to the inviter's campaign — and it is caught.

---

## 13. Activation, by acquisition cohort

No new activation vocabulary was invented. The existing signals are reused, and
`acquisition_actor_v` exposes them per acquired actor:

| Stage | Signal | Existing since |
| --- | --- | --- |
| authenticated | `authenticated_session_started` | 0013 |
| connected | `friendships` count > 0 | 0001 |
| socially exposed | `gravity_cluster_impression` | 0029 |
| joining | `join_clicked` / `join_arrived` | 0013 |
| observed viewing | `channel_dwell_ended` | 0031 |
| inviting | `referrals` where inviter | 0026 |
| downstream success | `referrals.succeeded_at` | 0026 |
| retention | `analytics_return_v` | 0029 |

A staged progression rather than one magic boolean, because "activated" means
different things at different points and collapsing them would lose the thing
Watchside actually cares about: whether an acquired user *connected to anybody*.

---

## 14. Reportable metrics

**`acquisition_actor_v`** — one row per attributed, non-internal actor: first
touch joined to observed behaviour.

**`acquisition_campaign_v`** — the rollup. Counts always shown; **rates
suppressed below 3 actors, as NULL rather than 0**, following the 0035
precedent. A campaign that acquired two users, one of whom made a JOIN, does not
have a "50% JOIN rate" — it has two people. Threshold **PROVISIONAL**.

**`acquisition_downstream_v`** — viral lineage, one hop.

Internal actors are excluded through `analytics_actors.is_internal`, and are
proved unable to satisfy the small-cohort threshold — the owner and test accounts
click their own campaign links constantly, and a campaign that looks like it
acquired four people when three were us is worse than no number at all.

A campaign nobody has bound produces **no row**, rather than a row of zeroes. No
fabricated cohorts.

---

## 15. Analytics: one event, and why only one

`acquisition_attributed` — `{ source, touch }` — emitted **server-side** from
inside `bind_acquisition` via `analytics_emit_server` (0037).

Server-side because the fact is decided there and no client is in a position to
report it. Emitted inside the guard that already fires exactly once, so there is
no new idempotency to get wrong.

**No other event was added.** The stages a marketer would want — link visited,
page viewed, installed — are not observable (§3), so inventing events for them
would mean inventing the data. The stages that *are* observable already have
events; they gain acquisition meaning by joining to the durable table.

**Dimensions: option B, joined rather than copied.** Campaign dimensions are not
denormalised onto other events. Joining through **immutable first touch** is
sufficient and cannot silently change meaning, which is the exact risk the brief
flagged. The single exception is `source` on this one event, and it is safe only
because a code's source is immutable — enforced by trigger, with its own mutation
lever. The campaign **code** is deliberately absent from event properties: it
lives on the durable row, and an event stream is not where campaign identity
should be joined from.

---

## 16. Privacy

**Materially new collection, so the policy changed in the same commit.**
`docs/PRIVACY.md` gains *"How you found Watchside"* — in plain language, not
buried under "analytics":

- the link carries one short code and nothing else, identical for everybody;
- the code is held **on your own device** until sign-in, and discarded after
  seven days whether you sign in or not;
- what the campaign *means* is worked out server-side, so **a link cannot claim
  to be something it is not**;
- first touch is kept as how you found Watchside and is not overwritten;
- it is **not a cookie, not a pixel, not a third-party product**, cannot tell
  where else you have been, and does not follow you across sites;
- a friend's invite is a different thing, stored separately;
- deleting your account deletes it.

The "never does" list gains an explicit denial of third-party analytics: no
Google Analytics, no Meta pixel, no TikTok pixel, no advertising SDK, no
fingerprinting, no cross-site tracking. The website sets no cookies and makes no
external requests at all — asserted by `publicRouting`.

The privacy page is generated from the policy, so the published page cannot
drift from it.

**Data minimisation.** What is stored per actor: two campaign codes, two
timestamps, a counter. Not stored: referring URLs, arbitrary query strings, IP
history, social-media identifiers, fingerprinting signals, or any creator profile
data.

---

## 17. Deletion

`acquisition_attribution.actor_id references public.users(id) on delete cascade`
— the same pattern every user-owned table uses, so account deletion removes it
with everything else and needed no new code.

Proved: deleting the user removes the attribution row **and** the
`acquisition_attributed` events, and there is deliberately no aggregate copy
anywhere that would survive. The campaign *definition* remains, because a
campaign is not user data.

Friend-referral deletion semantics are unchanged.

---

## 18. Security

| Threat | Answer |
| --- | --- |
| forged campaign code | resolves against the registry or writes nothing |
| arbitrary source injection | **there is no source parameter** — `bind_acquisition(p_code text)` takes a code and nothing else, asserted against `pg_get_function_identity_arguments` |
| creator impersonation | `creator_key` comes from the registry, never from a link |
| malformed path / traversal | pattern-checked at three layers; `/c/..%2F..%2Fevil` stays a plain 404 |
| open redirect | the page builds only literal `twitch.tv` destinations; the count of href writes is asserted at **exactly two**, so a third route cannot be added without revisiting the check |
| query smuggling | the route reads the code and nothing else; `?source=…&utm_…` provably not forwarded |
| code enumeration | the registry is readable by nobody |
| replay / duplicate binding | one row per actor by primary key; concurrent binds resolve to a no-op |
| privileged metadata assertion | the client learns an outcome, never asserts a meaning |

The strongest of these is structural rather than validated: a client cannot
assert a source because **there is no parameter for one**.

---

## 19. Schema and compatibility

**37 → 38.** Additive only: two tables, three functions, two triggers, one event
registration, three views. No existing table, column, policy, grant or RPC
changes shape.

| Client | State | Effect |
| --- | --- | --- |
| Chrome 0.6.0 | published, live | none — calls none of this |
| Chrome 0.7.0 | pending review | none |
| Firefox 0.6.0 | submitted, awaiting first AMO review | none |
| Firefox 0.7.0 | packaged locally, not submitted | none |

Store state is owner-confirmed and authoritative. No package was uploaded, no
version bumped, no tag created.

**The compatibility point that matters is the inverse one:** because no released
build reads `watchside_campaign`, none of them will attribute anything. M5C is
inert in production until a build ships.

---

## 20. Tests and mutations

**2,971 deterministic tests across 117 files.** Lint clean, `tsc -b` clean.

| Suite | Count | Covers |
| --- | --- | --- |
| `tests/db/acquisition.test.ts` | 43 | resolution, first/last touch, immutability, authority, referral coexistence, downstream, deletion, events, metrics |
| `tests/extension/acquisition.test.ts` | 47 | code shape, URL parsing, window boundaries, first-touch selection, bindability |
| `tests/extension/publicRouting.test.ts` | +13 | the `/c/` route, separation from `/i/`, forged-source rejection, open redirect |

Every gate is proved in **both directions**: a valid campaign binds as well as an
invalid one refusing; a fresh touch binds as well as an expired one refusing; a
cohort of three reports rates as well as a cohort of two suppressing them. A gate
that only ever refuses might be refusing everything.

**Mutation proofs: 78/78 detected**, thirteen of them new and each removing a
semantic whose failure would be *invisible*:

| Lever | Caught by |
| --- | --- |
| first touch becomes overwriteable | refuses an UPDATE that would rewrite the origin |
| newest pre-auth touch wins | keeps the first one when a second arrives |
| expired touch binds anyway | refuses an expired touch |
| window widened to 30 days | is seven days, deliberately |
| storage treated as trusted | refuses a malformed code that reached storage |
| unknown campaign accepted | writes nothing at all |
| retired campaign still binds | refuses an inactive campaign |
| campaign source becomes editable | will not let a source change under its history |
| internal actors counted | excludes internal actors |
| rates reported for a cohort of two | suppresses rates below the threshold |
| invitee attributed to inviter's campaign | links a campaign to the people its user brought |
| campaign arrival sent as a referral | never sets the referral parameter |
| campaign code read from any path segment | refuses a trailing segment not under `/c/` |

Cosmetic campaign copy was deliberately not mutated. Known debt unchanged:
analytics 6/87, presence 0, layout 0, lab 11.

---

## 21. watchside.app HTTPS follow-up

Checked once, mid-milestone, not polled.

**Still provisioning — and GitHub confirms nothing is blocking it.** The Pages
health endpoint reports, for both `watchside.app` and `www.watchside.app`:

```
is_valid                     true       reason        null
is_pointed_to_github_pages_ip true      caa_error     null
is_served_by_pages           true       is_https_eligible  true
https_error                  peer_failed_verification
```

`is_https_eligible: true` with `caa_error: null` is the useful finding: DNS,
routing and certificate-authority policy all pass, and issuance is **queued
rather than refused**. `peer_failed_verification` simply means no certificate
exists yet.

DNS was not touched. Enforcement remains one authenticated API call once the
certificate exists, needing no owner action. Because `.app` is HSTS-preloaded,
the domain is still not usable in a browser, and is **not live**.

---

## 22. Limitations

1. **Zero coverage today.** No released build reads the parameter.
2. **No click denominator, ever.** Conversion rate from link click is not
   computable without tracking, and will not be.
3. **Same-browser only.** Cross-device journeys are unattributed.
4. **Reinstall loses the touch.**
5. **The 7-day window is a judgement**, not a measurement. PROVISIONAL.
6. **The 3-actor suppression threshold is provisional**, matching M3D.
7. **Cohort comparison is observational.** Campaigns reach different audiences;
   nothing here isolates a campaign's effect from who it reached.
8. **No campaign UI.** Minting is a command plus a paste, by design.

All of these bias attribution downwards or leave it absent. None inflates a
campaign.

---

## 23. Claim discipline

| Level | Example | Allowed |
| --- | --- | --- |
| OBSERVED | "Campaign X produced N authenticated Watchside users." | yes, once data exists |
| ATTRIBUTED | "These users entered Watchside through Campaign X." | yes |
| CAUSAL | "Campaign X caused higher Twitch engagement." | **no** |

Comparing campaign cohorts is not causal, and the views say so in their own
comments — `acquisition_campaign_v` carries "OBSERVATIONAL, never causal" where a
reader will meet it.

---

## 24. The marketing gate

**Still closed.** The instrumentation exists on `main` and collects nothing.

It opens when a build containing `watchside_campaign` is distributed and
verified attributing in production — the same discipline M3D used, and for the
same reason: M3D was in `main` for a whole milestone while measuring nobody,
because neither released build contained it. That is the mistake worth not
repeating.

Until then: organic beta behaviour is unaffected and unsuppressed, and no
meaningful paid, creator or launch traffic should be bought.

---

## 25. M5D handoff

The blocker is now explicit and shared with M3D: **two measurement systems are
finished in `main` and present in no released build.** They ship together or the
next milestone repeats this paragraph.

M5D should:

1. ship a build carrying M3D **and** M5C;
2. verify a real campaign bind in production, once, end to end;
3. mint the first real campaigns before any of them is published anywhere;
4. only then consider spend.

Also open, unchanged: `INVITE_LANDING_BASE` and the two Support links still point
at the Pages subpath and flip in M5E once HTTPS is live; the contrast and
screen-reader passes remain M5 polish.
