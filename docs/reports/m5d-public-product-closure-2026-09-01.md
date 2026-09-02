# M5D — Public product closure

**Date:** 2026-09-01
**Branch:** main
**Schema:** 38 (unchanged — M5D needed no migration)
**Preceded by:** M5C — acquisition attribution

---

## 1. Executive verdict

**★ GO.**

M5D asked one question: if a stranger got Watchside tomorrow, is anything
obviously confusing, broken, hidden, embarrassing, inaccessible, misleading or
unrecoverable? The answer was mostly no — M5A, M5B and M5C had already closed
the visible gaps — with **one significant exception that had been there the
whole time and that no previous milestone looked at.**

**Every failure surface in the panel was showing users the raw thrown error.**
Eighteen call sites were written as

```ts
setError(cause instanceof Error ? cause.message : 'Could not send that request.')
```

which reads as "the real reason, with a sentence as backup" and behaves as the
exact reverse: a thrown cause is nearly always an `Error`, so the raw message
was the normal path and the carefully written sentence was the branch almost
nobody took. A failed friend request showed `TypeError: Failed to fetch`. A
rejected insert could have shown a Postgres constraint name. The sentences were
already good — they simply were never reached.

Alongside it, M5B's two deferred accessibility items are closed, and closing
them found five real contrast failures and two missing semantics.

Nothing found needed a schema change, a redesign, or a product-direction
decision. The remaining M5 surface is genuinely release convergence, which is
what M5D was meant to establish.

---

## 2. The real remaining-M5 inventory

Re-derived from the implementation, not from earlier reports' TODO lists.
Several items were still classified M5 POLISH purely because an old report said
so; M5A and M5B had already fixed them.

| Feature | Was | Now | Why |
| --- | --- | --- | --- |
| Social Gravity | M5 POLISH | **READY** | M5A added the friends-idle state. The remaining note — `GRAVITY_THRESHOLD` unreachable in a two-person beta — is a fact about the beta's size, not a defect. |
| Friends / requests | M5 POLISH | **READY** | M5A relabelled the control, added `aria-label`/`aria-expanded`, and rewrote the empty state. |
| Stream Rooms | M5 POLISH | **READY** | M5B added the comprehension line; M5D closed the analytics half (§6). |
| Groups | M5 POLISH | **READY** | M5B's one-sentence distinction is present and tested. |
| Notifications | M5 POLISH | **READY** | M5B corrected the mental model to what a manifest permission actually is. |
| Feedback / Support | M5 POLISH | **READY** | The support page is live and linked; M5B published it. |
| Invite links | M5 POLISH | **M5E RELEASE GATE** | One constant flips when HTTPS is live. Not product work. |
| Public web | M5 POLISH | **M5E RELEASE GATE** | TLS is GitHub's to issue (§9). |
| M3D | M5 BLOCKER | **M5E DISTRIBUTION GATE** | Finished; in no distributed build. |
| M5C | M5 BLOCKER | **M5E DISTRIBUTION GATE** | Same. |
| Chat / emotes | EXPERIMENTAL | **unchanged** | The open question is empirical and the beta has not answered it. |
| Test Lab | excluded | **unchanged** | Not in the package. |

Counts moved from READY 12 / POLISH 7 / BLOCKER 2 to **READY 19 / M5E RELEASE
GATE 2 / M5E DISTRIBUTION GATE 2 / EXPERIMENTAL 1 / POST-LAUNCH 1 / excluded 1**.

Nothing stayed in M5 because a report once listed it, and nothing was deferred
because it was inconvenient.

---

## 3. The stranger journey

Walked against the assembled panel rather than component by component, using the
demo client, which is the only client that drives every surface without a
backend.

Install → first open → auth → zero friends → search/invite → first friend →
friends idle → friend watching → Gravity → JOIN → together → room → leave →
return: **coherent, with no dead end**. M5A's work holds up: the zero-friend
state leads with what Watchside does before asking for anything, and the
friends-idle state is now distinguishable from having no friends.

Also inspected: incoming requests, suggestions, notifications, groups, badges,
preferences, feedback, support, privacy, block, mute, sign-out, account
deletion, and the empty/no-data state of each.

**One systemic defect, in the failure states rather than the happy ones** —
§4. Everything else was either already right or a matter of taste, and matters
of taste were left alone.

---

## 4. The failure-recovery defect, and its fix

### What was wrong

Eighteen call sites across nine files displayed `cause.message` whenever the
cause was an `Error`. The affected paths are the ordinary ones: friend search,
sending a request, accepting a request, cancelling a request, creating a group,
group actions, sending a message, changing a displayed badge, deleting an
account.

Two things made this worse than it looks:

- **It reads as correct.** The ternary looks like a considered choice, and the
  written sentence sitting right there makes the line look finished.
- **It only shows up when something is already going wrong**, which is exactly
  when a public user has least patience and least context.

### The fix

`src/core/errors.ts`, one function:

```ts
export function humanMessage(cause: unknown, fallback: string): string {
  void cause
  return fallback
}
```

The written sentence is what a person sees, always. The raw cause was never
being logged from these call sites — it was only being *displayed* — so nothing
diagnostic is lost by removing it. The worker already logs backend failures
through `logError`, and the Feedback form attaches diagnostics automatically.

A second function, `serverMessage`, exists for the handful of paths where the
**server** composed a sentence for a person (account deletion, permission
grants). It passes such a string through, and refuses anything shaped like
machine output — a stack frame, a type name, a SQL constraint, a JSON blob, a
URL, or anything over a sentence long — degrading to the written fallback
instead. That pattern is hoisted into a named `JARGON` constant so the check is
one readable line and a mutation can remove it cleanly.

### Why not an error framework

Because the valuable part of an error message is the sentence somebody wrote for
that specific failure, and a framework's job would be to replace those with
categories. The call sites still say exactly what they always said.

### Coverage

`tests/extension/errorMessages.test.ts` (16) proves the helper and then **scans
`src/ui` for the banned pattern**, because this is precisely the shape of fix
that gets undone later by somebody restoring `cause.message` "to give users more
detail" — which is how it got here. An inverse assertion checks the helper is
actually used, so the scan cannot be satisfied by deleting the error handling.

### The rest of the failure surface, which was fine

- **Auth** — every `fail()` in `auth.ts` supplies a human sentence and routes
  the raw error to `onError`. Signed-out-ness is deliberately not inferred from
  an unreachable backend.
- **`ErrorState`** — "Watchside is offline", the message, and *Try again*.
- **Realtime** — `realtime_status_changed` records connect as well as failure,
  so a channel nobody opened and a channel that never connected are
  distinguishable.
- **Twitch metadata** — enrichment failure degrades to the un-enriched card.
- **Support** — reachable with the panel completely broken, which is its point.

---

## 5. Accessibility

M5B left a contrast audit and a screen-reader pass explicitly open. Both are
closed as far as a machine can close them, and the residue is named rather than
pretended away.

### Semantics — two real defects

`tests/dom/accessibilityAudit.test.tsx` mounts the **whole panel** and walks it.
Six invariants passed on the first run — every focusable control had a name,
every input had a label, no positive `tabindex`, nothing focusable inside
`aria-hidden`, no skipped heading levels. Two failed:

- **The panel was an anonymous `<div>`.** Watchside renders inside Twitch's own
  page, so a screen-reader user arriving at it has no context for what it is —
  it is simply more content on twitch.tv. It is now
  `role="complementary" aria-label="Watchside"`, a landmark that can be jumped
  to and that says what it is.
- **No tab exposed which one was current.** That state was carried entirely by
  colour and weight. Now `aria-pressed` — deliberately not `aria-selected` with
  a `tablist` role, because that would promise arrow-key navigation between tabs
  that the panel does not implement, and a half-kept ARIA promise is worse than
  none.

### Contrast — five real failures

`tests/extension/contrast.test.ts` computes ratios from the token palette,
flattening translucency onto the panel ground. WCAG 2.1 AA: 4.5:1 body, 3:1
large text and meaningful indicators. **Not a certification, and none is
claimed.**

| Surface | Was | Now |
| --- | --- | --- |
| An offline friend's **name** | 3.54:1 | 6.85:1 |
| An offline friend's **status** | 3.54:1 | 6.85:1 |
| Section headings (10px uppercase) | 3.54:1 | 6.85:1 |
| The settings hint line | 3.54:1 | 6.85:1 |
| White on the brand accent | **3.96:1** | **5.38:1** |

The first four were the decorative `--kb-faint` tier applied to text people
actually have to read. Most of a friend list is offline most of the time, so the
offline name is not an edge case — it is the common case.

The fifth is the important one: **white on `--kb-accent` is 3.96:1**, and that
is the JOIN button, the sign-in button and every unread/request count badge —
the smallest, boldest text in the product. `--kb-accent` is the pinned brand
identity and was **not** changed; what changed is that surfaces *carrying text*
now fill with a new `--kb-accent-deep` (`#9333ea`, 5.38:1). The bare accent
keeps its job on borders, indicators, focus rings and glows, all of which clear
the 3:1 non-text floor comfortably.

`--kb-faint` itself is asserted to **fail** AA, deliberately — if somebody
lightens it enough to pass, that test fails and forces "so is it text now?" to
be answered on purpose rather than by drift.

### A test that was wrong, caught by a mutation

The first version of the contrast suite checked `--kb-accent-deep` in isolation.
A mutation pointing `--kb-gradient` back at the bare accent went **UNDETECTED**:
the deep token still existed and still passed, while every JOIN button had
quietly returned to 3.96:1. The assertion now resolves the gradient definition
and checks the stops it *actually uses*. A contrast test has to read the value
that renders.

### What remains, honestly

One narrow human item: **a single real screen-reader pass** over sign-in →
friends → JOIN. Everything decidable by machine is decided and regression-
covered; what a person still adds is whether the announcements make sense in
sequence, which no static check can judge. It is an acceptance item, not an
implementation blocker.

---

## 6. Analytics coverage

Re-audited rather than copied from M4.5.

**Closed:** `automatic_room_opened`, registered since 0020 and emitted by
nothing. `automatic_room_entered` fires when the contextual tab *becomes
available*, whether or not anybody looks — so whether the tab is ever opened,
which is the entire navigation bet behind Stream Rooms, was unmeasured. For a
feature whose open question is "would anybody miss this", that was the one
number worth having. It now fires on the transition into open, once per opening,
with `opened_from` distinguishing a deliberate choice from a session restored
across a Twitch refresh.

**Left open, deliberately:** `automatic_room_left`. Its `reason` vocabulary —
`destination_closed` / `retention_expired` / `signed_out` — is decided in the
worker's room lifecycle, and the panel, the only place that sees the surface
disappear, cannot tell those apart. **A guessed reason would be worse than a
missing event**, and room duration is approximable from `automatic_room_opened`
plus `channel_dwell_ended`. This is intentional debt, recorded in
`docs/FEATURES.md` with the reason.

**Left open, correctly:** install handoff. Not observable without cross-site
tracking, and not claimed — M5C §3.

Nothing else was instrumented. The test applied was "would this measurement
materially change a product, reliability, growth or acquisition decision", and
for everything else the answer was no.

---

## 7. Visual, layout and brand

**Layout:** the mutation harness covering the 280px minimum-width constraint
passes 23/23. The contrast fixes changed colour values only — no geometry, no
type scale, no spacing — so nothing could clip or reflow.

**Brand:** every remaining occurrence of "Kickback" in user-facing execution
surfaces was checked. All of them are type names, identifiers and
compatibility-sensitive wire values (`KickbackClient`, `KickbackEmoteId`,
`kickback_invite`, `kb-` CSS, storage keys). **No stale human-facing branding
exists** — the emote labels, the manifest and the panel copy are clean. M4.5's
conclusion holds and nothing compatibility-sensitive was reopened.

---

## 8. Rooms vs Groups, badges, notifications

Verified against the implementation rather than re-designed.

**Rooms vs Groups** — the Groups empty state carries M5B's sentence, and the
product's primary story is still *friends are watching → JOIN → together* rather
than *create a room first*. The contextual tab is labelled with the streamer's
name and appears only while somebody else is there. No change.

**Badges** — earned and locked states both render, locked as non-focusable
spans with "not earned yet" in the tooltip rather than as disabled buttons. No
counter, no progress bar, no "two more to go". Descriptions carry no stale
branding (fixed in the database by 0037). `badge_awarded` is still emitted
server-side from `award_badge`. No change.

**Notifications** — `notifications` is a manifest permission in both Chrome and
Firefox, granted at install, with no runtime prompt and therefore no denial
state to recover from. The copy says the browser has to allow them too and links
to Support. No invented denial states were added. No change.

---

## 9. watchside.app TLS

Checked **once**, as instructed, not polled.

**Still provisioning.** `https_certificate` is null and the handshake fails.
M5C's diagnosis stands and was not re-litigated: GitHub's own Pages health
endpoint reported both apex and `www` as `is_valid: true`, `caa_error: null` and
**`is_https_eligible: true`** — issuance is queued, not refused.

DNS was not touched. Hosting was not reconfigured. **This is now an M5E release
gate**, and it gates one thing: flipping `INVITE_LANDING_BASE` and the two
Support links to the canonical domain. Nothing in the product depends on it
today, because nothing points at the domain yet.

---

## 10. Chrome and Firefox

One codebase. Everything M5D changed is shared UI, shared CSS or a shared core
module; nothing touches the event-page lifecycle, the OAuth redirect surface or
notification scheduling, which are the three places the two browsers diverge.

`npm run build` clean, `npm run verify:firefox` clean, `tsc -b` clean.

**No divergent product behaviour was introduced or is required.**

---

## 11. Tests and mutations

| Gate | Result |
| --- | --- |
| deterministic suite | **3,015 passed / 120 files** |
| `npm run lint` | clean |
| `npm run typecheck` (`tsc -b`) | clean — the meaningful gate, per M5B §29 |
| `npm run build` | clean |
| `npm run verify:firefox` | clean |
| `test:destruction` | **85/85 detected** (7 new M5D levers) |
| `test:layout` | 23/23 |
| `test:analytics` | 6 of 87 undetected — **known debt, unchanged** |
| `verify:lab` | 11 failures — **known debt, unchanged** |
| `test:presence` | not re-run — no presence semantics changed |

New suites: `accessibilityAudit` (10), `contrast` (19), `errorMessages` (16).

The seven M5D levers each remove a semantic whose failure is invisible: raw
error text returning, the jargon filter dropping, tab state disappearing, the
landmark disappearing, the offline name dimming below the floor, the gradient
returning to the bare accent, and the room-opened event firing on availability
instead of opening. All detected — one only after the test that should have
caught it was corrected (§5).

Known debt was preserved and documented, not normalised: no new failure was
absorbed into a baseline.

---

## 12. Intentional debt

| Item | Why it stays |
| --- | --- |
| `automatic_room_left` unemitted | Its `reason` cannot be determined where the event would fire; a guessed reason is worse than none (§6). |
| `test:analytics` 6/87 undetected | Long-standing, documented, and none covers release-critical behaviour. |
| `verify:lab` 11 failures | Same. The Test Lab is excluded from public builds. |
| Chat/emotes EXPERIMENTAL | The open question is empirical; the beta has not answered it. |
| One screen-reader pass | Genuinely human; everything machine-decidable is done (§5). |

---

## 13. M5E release gates

Exactly four, and none of them is product work:

1. **Converged candidate.** Build and accept locally a candidate containing
   M3D + M5A + M5B + M5C + M5D. Both measurement systems are finished on `main`
   and present in no distributed build — that is the same trap M3D fell into
   for a whole milestone, and it is why they ship together.
2. **Prove M3D in that candidate**: correct follows scope, secure credential
   custody, a real creator-discovery baseline.
3. **Prove M5C in that candidate**: a real campaign touch captured, a real
   authenticated bind, friend referral demonstrably independent, expected
   reporting behaviour.
4. **TLS, then the constant flip.** When GitHub issues the certificate, enable
   enforcement through the already-proven API call, verify the four public
   routes, then flip `INVITE_LANDING_BASE` and the two Support links.

"Ship together" means include and prove together in the converged candidate. It
does not mean uploading anything during M5D, and nothing was uploaded.

---

## 14. Store trigger assessment

Owner-confirmed state: **Chrome 0.7 approved and live, nothing pending. Firefox
0.6 submitted and awaiting its first AMO review; 0.7 packaged locally, not
submitted.**

### Chrome — KEEP WAITING

There is no pending review to protect any more, so the argument that held during
M5B and M5C is gone. The reason to wait is now different and simpler: **M5E is
immediately next and will produce the converged candidate.** Shipping M5D alone
would spend a review cycle on accessibility and error-message fixes and then
require a second submission days later for the thing that actually matters —
M3D and M5C, which measure nobody until they are distributed.

**Nothing found in M5D triggers an emergency submission.** No security defect,
no privacy defect, no auth breakage, no backend incompatibility, no corrupt
data. The error-message defect is a real public-product defect and it is the
closest call in this assessment — users on 0.7 are being shown raw error text
today. It stays below the trigger because it appears only on already-failing
paths, degrades to jargon rather than to data loss or a security exposure, and
M5E is days away rather than weeks.

**If M5E slips materially, revisit this specific finding** — it is the one that
would justify shipping M5D on its own.

### Firefox — KEEP WAITING

Different cost structure and an easy call. 0.6 is awaiting its **first** review,
which is the slowest and most scrutinised one an add-on ever gets. Replacing it
now resets that queue position for changes that will themselves be superseded by
the converged candidate, and nothing publicly released on Firefox is affected
because nothing is publicly released on Firefox.

Reassess both at M5E against the actual Store state at that time.

---

## 15. Marketing gate

**Closed, unchanged.** No paid campaigns, no creator spend, no streamer
outreach, no TikTok or X launch push, no intentional launch traffic — until M5C
exists in an accepted distributed build and has been proven to capture a real
touch and a real bind.

Organic beta activity continues and is not suppressed.

---

## 16. Verdict

**★ GO.**

| Criterion | |
| --- | --- |
| remaining M5 debt re-audited against reality | ✓ |
| meaningful public-release defects fixed | ✓ error messages, contrast, semantics |
| zero-friend through JOIN coherent | ✓ |
| failure/recovery acceptable | ✓ |
| no obvious accessibility blocker | ✓ one human acceptance item named |
| no obvious visual/layout blocker | ✓ |
| analytics gaps intentional and documented | ✓ |
| privacy accurate | ✓ unchanged — M5D collects nothing new |
| Chrome compatibility | ✓ |
| Firefox compatibility | ✓ |
| M3D and M5C classified as distribution gates | ✓ |
| marketing gated on distributed M5C | ✓ |
| deterministic gates pass | ✓ 3,015 / 120 |
| mutation gates pass | ✓ 85/85, known debt unchanged |
| `docs/FEATURES.md` reflects reality | ✓ |
| remaining work is convergence, not a hidden milestone | ✓ |

The thing worth carrying into M5E: **the biggest defect in this pass was a line
that looked finished.** `cause instanceof Error ? cause.message : 'a good
sentence'` survived every previous audit because reading it feels like reading a
decision, and the good sentence sitting next to it makes the line look complete.
It took walking the failure states as a stranger, rather than reading the code as
its author, to notice which branch actually runs.
