# M7 — Cold start / stranger activation audit

**Date:** 2026-09-02
**Type:** AUDIT + PRODUCT DESIGN + ROADMAP. **No cold-start features implemented.**
**Scope frozen for:** Watchside **v0.9 — Launch Activation**

---

## 1. Headline

The cold-start machinery is **almost all built**. Mutual friend suggestions,
friend search, friend requests, invite links, referral attribution, badges,
zero-friend copy and growth analytics all exist and shipped in v0.8.

**Three defects sit directly on the one path a stranger can actually use**, and
two of them are severe:

1. **The invite landing page every v0.8 invite points at offers Chrome only.** It
   contains **zero** references to Firefox or Mozilla and does no UA detection —
   verified against the live page. Firefox is currently the **only publicly
   approved Watchside build**. A Firefox user who receives an invite has no path.
2. **The pending invite code is held in a bare background-script variable and is
   never persisted.** `src/background/index.ts` states the rule it breaks, in its
   own header: *"MV3 workers are killed after ~30s idle, so nothing here may live
   only in memory."* M5C's campaign touch is persisted *on purpose*; the older and
   more important invite path is not.
3. **Invite links still point at `anoteros-labs.github.io`**, months after
   `watchside.app/i/<code>` went live and while the branded page is strictly
   better — it offers both browsers.

**The good news is the sequencing.** Defect 1 is a *website* fix needing **no
extension build and no store review** — it can ship today and immediately repairs
the worst cold-start failure for the only browser Watchside is public on.

---

## 2. G5 / G8 bookkeeping — done

Recorded in `docs/ROADMAP.md` under **"The M7 launch gates - current standing"**:

- **G5 SATISFIED by explicit owner decision.** `subscribed_at_join` deferred;
  permanent per-JOIN historical loss accepted, with the reasons and the
  revisit triggers (~1,000 MAU with a measurable social JOIN rate, or a credible
  randomised-lift design) recorded.
- **G8 RETIRED / NON-BLOCKING for M7** while M3E-a is deferred — D8 asks how to
  declare data Watchside has chosen not to collect.
- **G7 remains OPEN** (counsel), with the noted inconsistency that it is recorded
  as blocking for M3D and M3D shipped anyway.
- **G1 remains OPEN and depends on production observations, not implementation.**
- The eight assertions prohibiting subscription/purchase measurement are
  untouched.

**M7 is gated on G1 (data), G7 (counsel), and the cold-start judgement below.**

---

## 3. Capability inventory

**A = shipped in v0.8 · B = in HEAD, not distributed · C = partial · D = roadmap only · E = absent**

| Capability | Status | Note |
| --- | --- | --- |
| First authentication (Twitch OAuth) | **A** | |
| Sign-in card copy | **A** | rewritten in M6A |
| Zero-friend empty state + "Find friends" CTA | **A** | M5A; genuinely good |
| Friend search — exact friend code | **A** | |
| Friend search — Twitch login **prefix** | **A** | ≥2 chars, limit 10, **unbounded** — §10 |
| Friend requests: send / receive / accept / reject | **A** | rate-budgeted (0039) |
| **Mutual friend suggestions** | **A** | `suggest_friends`, 0026 — §8 |
| Invite link creation + copy | **A** | |
| Invite landing page | **A** | **Chrome-only** — §6 |
| Invite → Twitch → extension continuity | **C** | **memory-only** — §6 |
| Referral attribution (`claim_invite`, `referrals`) | **A** | server-authoritative |
| M5C acquisition attribution + coverage | **A** | 0038/0040, live |
| Groups + group invitations | **A** | |
| Presence / HERE / Social Gravity / JOIN | **A** | the product |
| Watch-together, messages, reactions | **A** | |
| Notifications (gathering alert) | **A** | opt-out in panel |
| Badges for successful referrals | **A** | |
| Branded `watchside.app/i/<code>` invite links | **B** | page live; **extension does not mint them** |
| "People you already know use Watchside" | **E** | infeasible — §9 |
| Activation funnel coverage denominator | **E** | §12 |
| Search rate limiting | **E** | §10 |
| Internal-actor exclusion from suggestions | **E** | §10 |

**Nothing in the cold-start feature set needs building from scratch.** This is a
repair-and-connect milestone, not a build milestone.

---

## 4. The zero-friend stranger journey

Assume: never heard of Watchside, installs from a store, authenticates, knows
nobody's username, has zero friends, nobody coaching.

| Stage | What happens | Verdict |
| --- | --- | --- |
| Store listing → install | Listing promises "see where your Twitch friends are watching" | fine |
| First panel — signed out | *"See where your friends are watching Twitch."* + Continue with Twitch + "It never sees your password" | **good** (M6A fixed this) |
| Twitch consent | Asks to view channels you follow | expected, explained |
| First panel — signed in, zero friends | *"See where your friends are watching. … Add a friend or two and it starts working."* + **Find friends** | **good** — states the precondition plainly |
| **Find friends surface** | Three things: **search**, **suggestions**, **invite link** | **the pinch point** |
| Search | Needs a Twitch login or friend code they do not have | **dead end for a true stranger** |
| Suggestions | *"Nobody to suggest yet… this fills up as you add a few"* | **structurally empty** — §8 |
| Invite link | Copy a link and send it to someone | **the only working path** |

**So the funnel narrows to exactly one mechanism**, and that mechanism is the one
carrying all three defects in §1.

**This is not a comprehension failure.** M5A and M6A did their job — every screen
says the right thing, and the zero-friend state honestly names its own
precondition. It is a *reachability* failure: the product correctly tells the
user what to do, and the one road it points down has a pothole in it.

---

## 5. First-impression dead ends

1. **Firefox invitee.** Receives a link, lands on a Chrome-only page. **Hard dead
   end on the only publicly approved build.**
2. **Invite lost to worker eviction.** Clicks invite → Twitch → OAuth (tens of
   seconds, another tab) → worker evicted → code gone. Lands in Watchside with
   **no friend, no referral credit, and no error** — indistinguishable from
   installing cold. The inviter is never told either.
3. **Solo stranger with no one to invite.** Nothing to search, nothing to suggest.
   Honest, but terminal.
4. **Trust wobble.** A branded product hands out a `github.io` URL.

---

## 6. Invitation end-to-end audit

**Verified live in a real browser**, not by reading code:

| Link | Status | Chrome CTA | Firefox CTA |
| --- | --- | --- | --- |
| `anoteros-labs.github.io/watchside/invite/?c=…` **(what v0.8 mints)** | works | ✅ | ❌ **absent** |
| `anoteros-labs.github.io/kickback/invite/?c=…` (oldest) | forwards correctly | ✅ | ❌ absent |
| `watchside.app/i/<code>` **(live, product never links to it)** | works | ✅ | ✅ |

All three correctly carry the code to `twitch.tv/?kickback_invite=…`. **The
routing is sound; the presentation is not.**

**Where state survives, and where it does not:**

| Boundary | Survives? |
| --- | --- |
| Link → landing page | ✅ |
| Landing page → Twitch | ✅ `?kickback_invite=` |
| Twitch page → content script → background | ✅ `codeFromUrl` |
| **Background across OAuth** | ❌ **memory-only `pendingInviteCode`** |
| Sign-in → `claim_invite` | ✅ when the code survived |
| Referral → friendship | ✅ server-authoritative |

The contrast is inside one file: line 1518 reads *"A campaign touch outlives the
worker on purpose; read it back at startup."* The invite code gets no such
treatment.

**Attribution vs referral separation is correctly maintained** — M5C answers "how
did they come to Watchside", referrals answer "who invited them", stored
separately, and `acquisition_downstream_v` joins rather than copies. No
conflation found.

---

## 7. First edge — every way to get a first connection

| Mechanism | Exists | Discoverable | Works for a lone stranger? |
| --- | --- | --- | --- |
| **Invite link** | ✅ | ✅ | **Only if they know someone to send it to** — and currently defective |
| Friend code search | ✅ | ✅ | ❌ requires a code they do not have |
| Twitch login search | ✅ | ✅ | ⚠️ only if they know a friend's *Twitch* login |
| Incoming friend request | ✅ | ✅ | ❌ requires someone else to act |
| Group invitation | ✅ | ✅ | ❌ requires an existing member |
| Mutual suggestions | ✅ | ✅ | ❌ **structurally empty at zero friends** |
| Acquaintance discovery | ❌ | — | §9 |

**Minimum viable set before launch: the invite link, working properly, on both
browsers.** Everything else is either derivative of having a first friend, or
requires knowledge a stranger lacks.

Second-order but real: **Twitch-login search is better than it looks.** A user who
knows their friend's *Twitch* handle — plausible for people who already watch
together — can find them. That path works today and needs nothing.

---

## 8. Network formation, and the recovered Mutual Friend Suggestions contract

**Already implemented** — `suggest_friends`, migration 0026. Recovered contract:

- **Exactly two hops.** *"Three hops is a stranger with a number attached, and a
  global directory is a different product."*
- **Mutual count, never names.** *"'Julie and Mike are friends' is Julie's
  information as much as Mike's, and neither of them asked to have it published
  to Chuck."*
- **Excludes:** self, existing friends, blocks in **either** direction, pending
  requests in either direction.
- **Deterministic ordering** — mutuals desc, then display name, then id. No clock,
  no randomness.
- Limit capped at 50.
- Impression measured at **render**, not fetch (M5A corrected this — the old event
  counted empty results as "somebody saw suggestions").

**Recommendation: it is already P0-complete. Do not touch it.** It is the correct
network-formation mechanism and it is well-built. It is simply *not* a first-edge
mechanism, because it walks the caller's own friendships and a new account has
none.

**One real gap:** it does **not** exclude internal/test accounts. `analytics_actors.is_internal`
exists and is used everywhere in reporting, but `suggest_friends` has no such
filter — the owner's test accounts can surface as suggestions to real users. §10.

---

## 9. "People you already know use Watchside" — **not feasible**

Stated plainly, as the brief asks.

**Twitch exposes no social graph.** There is no friends API, no mutual-follower
API, and no contact concept. The only relationship endpoints are
`Get Followed Channels` (a viewer→creator list, already used by M3D under
`user:read:follows`) and the subscription check.

**Following the same creators is not acquaintance.** Two people who both follow a
large streamer have no social relationship; matching on it would produce exactly
the "random popularity-driven recommendation" the brief prohibits. At Watchside's
current size it would be noise; at scale it would be worse, because popular
creators dominate.

The only genuinely acquaintance-like Twitch signal would be *mutual follows
between two viewer accounts* — and Twitch does not expose viewer-to-viewer
follows to third parties at all.

**Every remaining route is prohibited or unsafe:** address books, contact
scraping, third-party matching, cross-site tracking — all excluded by the brief
and by Watchside's privacy posture. Any "is X on Watchside" primitive is a
membership oracle regardless of how it is dressed up.

**Verdict: E — absent, and correctly so. Mutual Friend Suggestions already
captures the achievable value**, from Watchside's own graph, with consent implicit
in the friendships that produced it.

---

## 10. Abuse and privacy findings

| # | Finding | Severity |
| --- | --- | --- |
| **1** | **`search_users` has no rate budget.** Six write surfaces are budgeted (`friend_request`, `group_create`, `group_message`, `room_message`, `together_reaction`, `feedback`); search is not. A ≥2-char **prefix** match returning 10 rows makes **Watchside membership enumeration unbounded** — and answers "does this specific person use Watchside" for anyone who knows a Twitch handle | **P0 for public launch.** Harmless at beta scale, not at public scale |
| **2** | **Internal/test accounts are not excluded from `suggest_friends`** | **P1** |
| **3** | Block semantics in search | **correct** — "I blocked them" shows only to the blocker; being blocked falls through to `none` and the refusal is deliberately indistinguishable |
| **4** | Blocks in suggestions | **correct** — excluded in both directions |
| **5** | Friend-request spam | **handled** — 20/hour budget, charged only on genuinely new requests (0039) |
| **6** | Mutual-friend leakage | **handled by design** — count, never names |
| **7** | Invite-link forwarding | **acceptable** — the code is not a secret; it binds a referral, and 0026 prevents it bypassing a block |
| **8** | Repeated account creation to inspect a graph | **partially mitigated** — suggestions need real friendships first; search is the exposed surface, see #1 |
| **9** | Notification spam | **handled** — one gathering notification type, user-disableable |

**Finding 1 is the one that must not ship into a public launch.** Everything else
is either already right or P1.

---

## 11. Cold-start analytics coverage

| Funnel stage | Measurable? |
| --- | --- |
| New authenticated user | ✅ `authenticated_session_started` |
| **Zero-friend state reached** | ❌ **not measurable** — no event distinguishes "signed in with zero friends" |
| Find-friends surface opened | ⚠️ partial — `friend_suggestion_impression` fires on render, but only when non-empty |
| Search performed | ✅ `friend_search` |
| Invite link created / shared | ✅ `invite_link_created`, `invite_link_shared` |
| Invite claimed | ✅ `invite_claimed` with outcome |
| Referral succeeded | ✅ `referral_succeeded`, server-authoritative |
| Friend request sent / accepted | ✅ |
| First friendship established | ⚠️ derivable, not first-class |
| First friend-presence exposure | ✅ `friend_presence_impression` |
| First Gravity exposure | ✅ `gravity_cluster_impression` |
| Socially initiated JOIN | ✅ `join_clicked` + `join_arrived` |
| Meaningful dwell | ✅ `channel_dwell_ended` |
| Return session | ✅ derivable from sessions |

**The M5C coverage lesson applies here, and it is the analytics finding of this
audit:**

> **The activation funnel has no denominator for the zero-friend state.**

Every downstream rate is conditioned on a user having friends, because the
zero-friend state emits nothing. So "% of new users who reach a JOIN" is computed
over users who got past the pinch point — and a stranger who installs, finds an
empty panel and leaves is **invisible in exactly the same way** the M5C
unattributed users were. The funnel would look healthy while the cold-start
problem was total.

**The minimum honest fix is one event** marking that an authenticated session
began with zero friends, plus a coverage view expressing activation against *all*
new authenticated actors. Not more telemetry — a denominator.

---

## 12. First-impression human QA plan (for the v0.9 RC)

10–30 people, no coaching, four scenarios:

| Scenario | Setup | Watch for |
| --- | --- | --- |
| **Solo stranger** | Installs alone, knows nobody | Can they say what Watchside does? Do they understand *why* it is empty? Do they find the one useful action? Do they abandon? |
| **Two-friend pair** | Two people try it together from scratch | Can they connect **without being told how**? Which mechanism do they reach for — invite link, search, or asking each other for a code? |
| **Invited user** | Existing user sends an invite | **Does the invite survive install and auth?** Are they friends when they land? Does the inviter learn anything happened? **Run on Firefox and Chrome separately.** |
| **Small existing graph** | One or more proximate users already present | Do suggestions appear and read as genuine? Does presence make sense? Do they JOIN? |

Also observe: does anything feel spammy or invasive; where do they hesitate; what
do they expect that does not happen; do they understand HERE/Gravity/JOIN without
the words being explained.

**No numeric thresholds** — the roadmap defines none, and this is first-impression
discovery, not significance testing.

---

## 13. Proposed **v0.9 — Launch Activation** scope

### P0 — required before meaningful public launch

| # | Item | Complexity | Needs a build? |
| --- | --- | --- | --- |
| **P0-1** | **Invite landing page offers Chrome *and* Firefox.** The page v0.8 mints links to is Chrome-only; Firefox is the only public build | **TRIVIAL** | **NO — website only** |
| **P0-2** | **Persist the pending invite code** across worker eviction, mirroring M5C's campaign touch (bounded window, cleared on claim) | **SMALL** | **YES** |
| **P0-3** | **Mint branded `watchside.app/i/<code>` invite links**; keep every legacy shape working forever | **SMALL** | **YES** |
| **P0-4** | **Rate-limit `search_users`** using the existing `consume_rate_budget` helper | **SMALL** | **NO — migration only** |
| **P0-5** | **Zero-friend activation denominator**: one event + a coverage view, so the funnel cannot look healthy while cold start fails | **SMALL** | **YES** (event) |

### P1 — valuable, can follow launch

- Exclude internal/test accounts from `suggest_friends` (**TRIVIAL**, migration)
- Tell the **inviter** something happened when a referral lands (**SMALL**)
- First-friendship as a first-class event (**TRIVIAL**)
- Copy pass on the find-friends surface once QA says where people hesitate

### P2 — later / speculative

- Any acquaintance-discovery mechanism (§9 says not feasible)
- Suggestion ranking beyond mutual count
- Invite QR codes, share targets, deep-link handlers

### v0.9 as a whole: **SMALL–MEDIUM**

Two migrations (search budget, activation view), one analytics event, one storage
key, one URL constant, one website change, plus tests. **No OAuth change, no new
permission, no new host, no privacy-declaration change, no new third party.**

**Store impact: yes, both.** P0-2, P0-3 and P0-5 touch the extension, so v0.9
needs **a Chrome submission and an AMO submission** — but only *after* the current
Chrome v0.8 review completes, since v0.8 must not be disturbed.

**P0-1 and P0-4 ship without any release**, which is the sequencing point: the
worst defect and the worst abuse gap are both fixable before a single byte of
extension is rebuilt.

---

## 14. Scope freeze — explicitly **not** in v0.9

Richer Stream Rooms · Together redesign · chat improvements · creator
recommendation · Gravity ranking · YouTube · Kick · mobile · monetisation ·
`subscribed_at_join` (G5 deferred) · cosmetic redesign · Supabase custom domain ·
Chrome listing metadata cleanup · friend-list/group scaling · analytics dashboard.

**The goal is not "make Watchside feature complete". It is "make the Watchside
that already exists reachable by a stranger."**

---

## 15. Proposed roadmap through 1.0

```
v0.8  (shipped — Firefox public, Chrome in review)
  │
  ├─ NOW, no release needed:
  │     P0-1 invite page offers both browsers        ← fixes the worst defect today
  │     P0-4 rate-limit search                        ← closes enumeration
  │
  ├─ G7 counsel — in parallel, blocks nothing else
  │
  ▼
v0.9  LAUNCH ACTIVATION   (P0-2, P0-3, P0-5 + tests)
  ▼
first-impression stranger QA (10–30 people, four scenarios)
  ▼
Chrome + Firefox submissions  ← after v0.8 review clears
  ▼
CONTROLLED PUBLIC LAUNCH      ← gated on G1, G7
  ▼
G1 satisfied by real production observations
  ▼
iterate on evidence
  ▼
1.0   shaped by what reality said
```

**One change from the hypothesised sequence, and it matters:** P0-1 and P0-4 are
pulled *ahead* of v0.9 because neither needs an extension build. Waiting for a
release to fix a Chrome-only invite page would leave Firefox — the only public
build — with a broken invite path for the entire v0.9 cycle.

Public launch and 1.0 stay separate. v0.8 proved the system exists; v0.9 makes it
reachable; launch tests it against reality; 1.0 is shaped by what reality says.

---

## 16. Decisions required from the owner

1. **Approve the v0.9 P0 set** (five items), or cut it further.
2. **Approve shipping P0-1 and P0-4 immediately**, ahead of v0.9, since neither
   needs a release.
3. **Confirm branded invite links** (P0-3) — legacy links keep working forever
   either way; this changes only what *new* links look like.
4. **G7**: instruct counsel, or record an explicit decision to launch without it.
5. **Confirm the QA cohort** — 10–30 uncoached people, four scenarios.

---

## 17. What this pass changed

| File | Change |
| --- | --- |
| `docs/ROADMAP.md` | G5 decision recorded, G8 retired, gate standing table added |
| `docs/reports/m7-cold-start-stranger-activation-2026-09-02.md` | this report |

**No feature code, no migrations, no OAuth, no production, no store artifacts.**
Chrome v0.8 remains `cb3af261448280cb…`.

**Verification run:** the audit was read-only plus live checks against the
published invite pages in a real browser. No test or build state was altered.

---

## 18. Recommended next action

**Ship P0-1 today.** One page, no release, no review — and it restores the only
working first-edge path on the only browser Watchside is currently public on.

Then P0-4, then freeze v0.9 on the remaining three P0 items.
