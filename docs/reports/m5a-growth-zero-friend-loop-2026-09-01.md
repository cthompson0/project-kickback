# M5A — Growth and the zero-friend product loop

**Date:** 2026-09-01
**Entering commit:** `2bbed15` · tree clean · hosted schema **36 → 37**
**Baseline:** 2,764 tests / 108 files · 47/47 mutations

> No Store work. No version bump, no tag, no Chrome upload, no AMO upload, no
> `watchside.app` migration, no campaign attribution. Both submissions remain
> **WAIT**.

---

## 1. Executive verdict

## **GO**

A brand-new account is now told what Watchside is for before being asked to do
anything, the three states that used to look alike are distinct, the suggestion
list no longer disappears in the one surface built to show it, and the growth
loop's outcomes are measured for the first time.

**Two of M4.5's findings were wrong, and the corrections mattered more than the
original claims.** `friend_suggestion_impression` and `invite_claimed` were
recorded as missing; both existed. The impression was firing at the **fetch**,
counting "we asked the server" as "somebody saw suggestions" — including every
empty result, for a list that rendered nothing when empty. A missing event is a
gap; an event measuring the wrong thing is a number that looks fine and is not.

**No STOP condition was triggered.** The successful-referral rule already
existed, server-side and authoritative, so `referral_succeeded` needed no new
product decision.

---

## 2. Starting state

| | |
| --- | --- |
| Chrome | 0.6.0 published · 0.7.0 pending review |
| Firefox | 0.6.0 pending first review · 0.7.0 local only |
| Schema | 36 |
| Growth events emitted by nothing | `referral_succeeded`, `badge_awarded` |

---

## 3. Cold-start state trace

Traced against the implementation, not M4.5's summary.

| State | What actually rendered (before) |
| --- | --- |
| **A** signed out | `SignInCard` — *Watchside · See who's around · Continue with Twitch*. Fine. |
| **B** zero friends, no requests, no suggestions | `EmptyFriends`: *"Your Watchside is quiet"* + **Find friends**. A CTA with no promise behind it. |
| **C** zero friends, suggestions available | Impossible in practice — suggestions are friends-of-friends |
| **D** zero friends + incoming request | `IncomingRequests` only; `EmptyFriends` correctly suppressed. **Already right.** |
| **E** friends, nobody watching | Social Gravity's quiet sections — an "Offline · N" list, no explanation |
| **F** one friend watching, below the gathering threshold | A normal destination card with JOIN. **Already useful** — the threshold only changes emphasis |
| **G** Gravity available | Cards, ranked, with JOIN. Unchanged |
| **H** invite available | `+ Add` → Find friends → copyable link. Reachable |
| **I/J** referral recipient | Landing page → install → sign in → `claim_invite` |
| **K** no badges | Empty shelf |
| **L** badges | Shelf with earned badges; descriptions said **"Kickback"** |

Three things this trace corrected in M4.5:

1. The button is **`+ Add`**, not a bare `+`.
2. Incoming requests are **already** prioritised over the zero-friend state.
3. One friend watching is **already** useful — `GRAVITY_THRESHOLD` changes
   emphasis, not availability, so no copy may imply nothing happens below it.

---

## 4. The zero-friend design

Empty states and contextual copy. **No modal, no wizard, no walkthrough,** and
nothing a person must dismiss before using Twitch.

`EmptyFriends` now leads with the promise, then the requirement, then the action:

> **See where your friends are watching.**
> When a friend is watching someone on Twitch, they show up here and you can
> jump in and watch together.
> Add a friend or two and it starts working.
> `[ Find friends ]`

Three short lines. The product is one panel and can afford to explain itself in
place; a person who has just installed something they do not understand needs
the promise before the instruction.

**Deliberately not done:** a first-run overlay. After the empty states carry the
explanation, an overlay would repeat it in a fourth place — which the brief
explicitly warned against and which would be the first thing dismissed unread.

---

## 5. Friend-growth entry point

The button already read `+ Add` with `title="Find friends"`. The real problem was
that **"Add" never said what**, not that it was unlabelled.

The visible label stays short — the tab row carries Friends, a streamer name,
Groups and this button, and must survive the **280px minimum width** (default
320). "Add friends" would wrap. So:

- `aria-label="Add friends"` — a real name for anybody not reading the icon
- `title="Add friends"` — the tooltip now names the destination
- `aria-expanded` — it toggles a surface, and now says so

and the **discovery weight moved to the states**, which have room: the
zero-friend card's *Find friends* button, and the Gravity idle line for people
who already have friends.

---

## 6. Suggested friends

**The fix:** an empty list now explains itself instead of returning `null`.

> **People you may know**
> Nobody to suggest yet. Watchside suggests people your friends already know, so
> this fills up as you add a few. Search for somebody above, or invite a friend
> below.

Loading still renders nothing — a flash of "nobody to suggest" before the fetch
returns would be worse than a beat of silence. A failed fetch degrades to the
same empty state rather than to nothing.

**No privacy rule was weakened and nothing was fabricated.** Suggestions remain
friends-of-friends with a count and never a name.

---

## 7. Search

Unchanged. Twitch username or friend code, minimum query length, results with
add/accept. It is the one path that works from a standing start, which is why
both new empty states point at it.

---

## 8. Invite

Unchanged mechanically — durable code, copyable link, count beside it. The
landing base is still the GitHub Pages URL, deliberately: **`watchside.app` is
not M5A**, and shipped clients carry the current one.

---

## 9. Referral success semantics

**No new definition was invented.** `0026` already decided it, server-side:

```
attributed_at   they claimed a valid code
friended_at     the intended connection actually formed
activated_at    they used the product for its purpose at least once
succeeded_at    all three — THIS is a successful referral
```

`settle_referral` stamps `succeeded_at` once, guarded twice (an early return on
a non-null value, and `where … and succeeded_at is null` on the update), and
`referrals` has **one row per invitee, ever** as its primary key.

So `referral_succeeded` is emitted **from inside the `if found` block** — the
same guard that already proves the transition happened. It cannot fire on a link
visit, on authentication, on a self-referral, on an unknown code, or twice.

---

## 10. Referral and badge analytics

New in `0037`: `analytics_emit_server(actor, event, properties)` — a
security-definer emitter granted to nobody, for facts no browser is in a
position to report.

| Decision | Why |
| --- | --- |
| Environment is **looked up** from the actor's most recent event | a server fact has no build behind it, and every number is read per environment; `production` is the conservative fallback |
| `session_id` is **null** | it genuinely happens outside a session — the inviter may not have a browser open |
| The event name is **checked against the contract** | exactly as the client path does |
| The **inviter** owns `referral_succeeded` | they did the inviting; theirs is the count that moves |
| Properties are **empty** | no names, no logins, no readable graph detail |

`badge_awarded` is emitted from `award_badge` — the only place a badge is ever
granted — and only when a row is actually inserted. `on conflict do nothing`
already made repeats a no-op, so the event inherits that.

**The claim discipline holds.** These are OBSERVED (the server saw the state
change) and ATTRIBUTED (they connect to a prior referral). Nothing here says
Watchside *caused* a friendship.

---

## 11. Suggestion analytics — the correction

`friend_suggestion_impression` was emitted from `suggestFriends()` in the worker:
the **fetch**. It fired for every call, including the empty ones, for a list that
rendered nothing when empty.

It now fires from the component, when it actually draws people:

- guarded on a non-empty list, so an empty result records nothing
- guarded by a `useRef`, so a re-render cannot emit twice
- a failed fetch records nothing

**The dependency array was not enough**, and the tests say so: re-rendering with
the same client never re-runs the effect, so the ref only earns its place when
the client reference changes — which the panel can do at any time. The
regression test re-renders with a **fresh client** for exactly that reason, and
the mutation that removes the ref is DETECTED.

---

## 12. Incoming requests

**Already correct, and verified rather than changed.** A user with an incoming
request sees `IncomingRequests` and the zero-friend card is suppressed —
somebody with a request waiting is not pushed toward inviting strangers.

---

## 13. First-friend transition

Handled by the states rather than by an event. Zero friends shows the promise and
the ask; the moment a friendship exists the panel switches to Social Gravity,
which now explains what will appear.

**No celebration was added.** A milestone is not a reason for confetti, and the
useful acknowledgement is the interface changing to describe the new situation.

---

## 14. Friends but nobody watching

The distinction the brief called out, now real:

> Nobody is watching anything right now. When a friend starts watching someone,
> they show up here and you can jump in.

Shown only when no section is `here` or `destination` — it disappears the moment
there is anything real to show, so it never sits above live cards as noise.
Styled quiet: dim text, no border, no CTA. It reports a normal state rather than
an alert.

Two mutations cover it: collapsing it into silence, and never hiding it.

---

## 15. Social Gravity zero state

The above **is** the Gravity zero state. It avoids `presence`, `destination`,
`threshold`, `social_count` and any mention of an algorithm, and it does not
imply that nothing happens until several friends gather — because one friend
watching is already a card with a JOIN.

---

## 16. Badges

**Two things done, one deliberately deferred.**

Done: `badge_awarded` is emitted (§10). And the badge **descriptions** were
fixed — they still said *"Brought a friend to Kickback."* and are shown to users
in the badge tooltip.

That last one is a correction to M4.5, which concluded no human-facing Kickback
branding remained. It was wrong in the one place a source sweep cannot look: the
strings live in the **database**. `issuer = 'kickback'` is deliberately unchanged
— an internal discriminator that released clients compare against by exact
string.

Deferred: showing **unearned** milestones. It is a badge-UI question, and letting
it into the growth surface now would crowd the thing being fixed. → **M5B**.

---

## 17. Accessibility

For every changed control: real `<button>` elements, an accessible name on the
one icon-adjacent control, `aria-expanded` on the toggle, and every new state
communicated as text rather than by colour alone. The idle line and the empty
suggestion state are ordinary text in normal flow — keyboard and screen-reader
behaviour comes free.

Not attempted: a full accessibility audit. That is not this milestone.

---

## 18. Privacy

**No disclosure change required, and none made.**

`referral_succeeded` carries no properties. `badge_awarded` carries a badge key.
`friend_suggestion_impression` carries a count and a bucket — no names, no
logins, no user ids — and a test asserts exactly that. Nothing new is stored
about anybody; two events that were already declared now actually fire.

The policy already describes analytics as small facts from fixed lists and
already discloses friend and referral analytics. Nothing became true that the
policy did not already cover.

---

## 19. Backend and schema

**Migration 0037**, schema 36 → 37, applied. Strictly additive:

- one new function, granted to nobody
- two existing functions replaced with the same behaviour plus an emission
- one data update to badge descriptions

No RPC contract changed. No table, column, grant or policy changed. No client
call signature changed.

---

## 20–21. Chrome and Firefox compatibility

**Compatible with 0.6.0, 0.7.0 and the pending Firefox build.**

Every changed function keeps its signature and its behaviour; the additions are
emissions those clients neither make nor observe. The badge description change
is data, and every client renders whatever the row says. `analytics_track` still
skips unrecognised event names, so nothing a new client emits can break an old
one.

The UI changes are client-side only and reach nobody until a build ships.

| | |
| --- | --- |
| Chrome permissions / host permissions | unchanged |
| Version | **0.7.0** — not bumped |
| Firefox categories | `authenticationInfo`, `browsingActivity`, `personalCommunications`, `websiteActivity` — unchanged |
| `technicalAndInteraction` / `financialAndPaymentInfo` | NO / NO |

---

## 22. Test coverage

**2,808 tests / 111 files, 0 failures.** New:

- `tests/db/growthOutcomes.test.ts` — **18 tests**. Every referral rule proven in
  **both** directions: attribution alone emits nothing **and** a complete referral
  emits; a repeat award emits nothing **and** a real award emits.
- `tests/dom/friendSuggestions.test.tsx` — **9 tests**, mounted in jsdom.
- `tests/extension/zeroFriendLoop.test.tsx` — **15 tests** for the panel states.

### A test that had to move

The suggestion assertions started in the node project, reading the component's
source. They passed — and the mutation restoring the silent-`null` behaviour
walked straight past them, because a source assertion is happy while the
component returns `null` two lines earlier.

`renderToStaticMarkup` cannot run effects, and everything here depends on them.
So they moved to `tests/dom`, where mounting is real. **The mutation harness
caught a weak test, which is what it is for.**

---

## 23. Mutation proofs

`npm run test:destruction` — **58 of 58 DETECTED** (was 47).

| New lever | Guards |
| --- | --- |
| credit a referral for attribution alone | the three-condition rule |
| lose referral idempotency | single-stamp credit |
| emit a badge event for a repeat award | award-once |
| let clients emit server-authoritative events | the grant boundary |
| let suggestions vanish silently when empty | the empty state |
| emit the suggestion impression from the fetch | impression = seen |
| let a re-render emit a second impression | the dedup ref |
| drop the zero-friend explanation | the promise |
| collapse the friends-idle state into silence | the state distinction |
| show the idle caption even when friends are watching | not-noise |
| make the friend-growth button nameless again | the accessible name |

**Two levers had to be corrected before they bit**, and both taught something:
referral idempotency is guarded twice, so no single-line change breaks it (the
lever now removes the redundancy); and the impression-dedup ref is only
load-bearing when the client identity changes, so the test now re-renders with a
fresh client.

Harnesses ran serially. One crashed on a syntax error in the harness itself;
`git status` was inspected immediately, no mutation was live, and it was rerun
clean.

---

## 24. E2E

**Unchanged, and deliberately not extended.** The two-actor harness covers
friend request → accept → presence → JOIN, which M5A did not touch. Zero-graph
states are better served deterministically than by tearing down the canonical
seed friendship to prove an empty list — which would damage the fixture the
social scenarios depend on.

No owner interaction was required at any point.

---

## 25. `docs/FEATURES.md`

| Feature | Change |
| --- | --- |
| Friends | entry point corrected and described accurately |
| Suggested friends | **M5 BLOCKER → READY** on main |
| Invites/referrals | **M5 BLOCKER → M5 POLISH** (URL migration only) |
| Badges | award analytics + branding noted; unearned display deferred |
| Social Gravity | zero state recorded |
| Analytics gaps | two closed, two corrected, one still open |

Counts: **READY 10 · M5 POLISH 8 · M5 BLOCKER 1 · EXPERIMENTAL 1 ·
POST-LAUNCH 1**.

**Nothing became RELEASED.** Every change is on `main`; the Store state is
untouched.

---

## 26. Remaining M5 work

**The one remaining M5 blocker is shipping a build that can do M3D** — unchanged
from M4.5, and not something M5A could address.

Then: `watchside.app` migration with backward-compatible Pages URLs · unearned
badge milestones · notification-permission-denied state · a support route ·
saying why Rooms and Groups both exist · `automatic_room_opened` / `_left` ·
acquisition and creator/campaign attribution.

---

## 27. Store trigger check

Checked against the high-severity list. **No new trigger appeared in M5A:**

- no security issue
- no privacy issue — no disclosure change was required
- no backend incompatibility — 0037 is additive and signature-preserving
- no auth change
- no crash
- **no invalid analytics from Store clients** — the events M5A adds are emitted
  by the *server*, so 0.6.0 and 0.7.0 clients produce correct data without
  updating

**Chrome: WAIT** (0.7.0 already in review — resubmitting would replace it).
**Firefox: WAIT** (first review pending; a new upload resets it).

M4.5's Chrome recommendation was SUBMIT; the owner has since submitted 0.7.0, so
that recommendation is satisfied and WAIT is now correct for both.

---

## 28. Verdict

## **M5A — GO**

A stranger is told what Watchside is before being asked for anything. The three
states that used to look identical — no friends, friends idle, friends watching
— now read differently. The suggestion surface explains itself when it is empty,
which is exactly when a new user meets it. And for the first time the growth
loop can be evaluated: not just how many links were copied, but whether any of
it worked.

The most useful thing M5A produced is not a feature. It is that
`friend_suggestion_impression` was measuring the fetch, and that only reading the
emitter revealed it — a reminder that a registered event firing is not the same
as a correct one.
