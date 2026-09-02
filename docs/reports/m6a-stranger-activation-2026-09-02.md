# M6A — Stranger activation and first-run acceptance

**Date:** 2026-09-02
**Question:** can somebody who has never heard of Watchside install it and reach its core value without the owner explaining the product?
**Preceded by:** Store Assets

---

## 1. Verdict

**★ GO**, with one real finding fixed.

The activation path holds up. M5A's zero-friend work, M5B's comprehension copy
and M5D's error handling do the job they were built for, and reading them in
sequence as a stranger rather than in isolation as their author confirms it.

**One defect, and it was the first screen.**

The signed-out card — the very first thing anybody sees after installing — said:

> Watchside
> **See who's around.**
> [Continue with Twitch]

Four words naming neither Twitch, nor friends, nor watching. Shown to somebody
who arrived from a listing promising *"see where your Twitch friends are
watching and jump into the stream with them"*, and who is one click away from a
Twitch consent screen asking to **view the list of channels you follow**.

That is the shape of first-run rot: every screen written well in isolation,
nobody reading them in sequence, and the weakest one first. The zero-friend
state one screen later was rewritten carefully in M5A and is genuinely good. The
screen before it never got the same treatment because nobody arrived at it as a
stranger.

**P1, fixed.** No other P0 or P1 remains.

---

## 2. How this was tested

Deterministically, by mounting the real panel in each first-run state and
reading every word a person could actually read — not by reasoning about the
code.

| State | What a stranger reads |
| --- | --- |
| Loading | `Right now · Browsing Twitch · Connecting…` |
| **Signed out** | **the finding** — see §3 |
| Error | `Watchside is offline · Watchside can't reach its server right now. · Try again` |
| Signed in, zero friends | `See where your friends are watching. When a friend is watching someone on Twitch, they show up here and you can jump in and watch together. Add a friend or two and it starts working. · Find friends` |
| Friends, nobody watching | `Nobody is watching anything right now. When a friend starts watching someone, they show up here and you can jump in. · Around on Twitch · Alex — Around · Robin — Offline` |

The Gravity, JOIN and Together states were read from the **real captures taken
during Store Assets** — a real browser, the real extension, real Twitch — rather
than simulated. That is stronger evidence than a fixture, and it was taken
hours earlier from the same source state.

---

## 3. The finding, and the fix

**P1 — the first screen did not describe the product.**

Rewritten to two lines and the same single action:

> Watchside
> **See where your friends are watching on Twitch, and jump in.**
> [Continue with Twitch]
> *Sign in with Twitch so Watchside knows who you are. It never sees your password.*

Three deliberate constraints:

- **Still one action.** The comment on that component says *"signing in should
  not feel like onboarding"*, which is the right rule and is not broken here. No
  tour, no carousel, no second button. A test asserts the button count stays 1.
- **It answers the next screen's question before the next screen asks it.**
  Twitch's consent page requests the follow scope; a stranger meeting that with
  no preparation is a stranger who cancels. One quiet line is proportionate
  where a paragraph would not be.
- **It matches the Store listing's promise**, which is what set the expectation
  ninety seconds earlier.

`tests/dom/firstRun.test.tsx` (10 tests) locks the *sequence*: what has been
answered by the time a person has to decide something. The assertions are about
**meaning, not sentences** — copy should stay free to improve; what must not
happen is a screen quietly losing the question it answers.

Two mutation levers cover it, and the second exposed a weakness in my own test.
Removing the reason-for-Twitch line went **undetected**, because the mutation
added `hidden` to the element and my text walker only excluded `aria-hidden` —
so the words were still in the DOM and the test still passed. That is precisely
the failure a person would experience and the test would not. The walker now
excludes both. **87/87 detected** after the fix.

---

## 4. The first sixty seconds

Every question a stranger needs answered, and where the product answers it:

| Question | Answered by |
| --- | --- |
| What is Watchside? | The sign-in card, now (§3) |
| Where is Watchside? | The panel renders on twitch.tv on load — verified by four real captures |
| What does it do? | Sign-in card, then the zero-friend state in full |
| Why should I sign in? | Sign-in card |
| Why does it need Twitch auth? | Sign-in card's quiet line |
| What if I have no friends here yet? | Zero-friend state: what will happen, then **Find friends** |
| What happens when my friends are watching? | Zero-friend state says it in advance; Gravity shows it when true |

**Before the fix, the first two were unanswered at the moment they mattered
most.** Everything else was already in place.

---

## 5. Personas

| | Result |
| --- | --- |
| **A — zero graph** | **Pass.** Leads with what Watchside does before asking for anything, explains what will happen, offers *Find friends*. Not a dead end. |
| **B — suggestions available** | **Pass.** *People you may know* with mutual counts and ADD, plus one durable invite link. Verified in the real capture (screenshot 4). |
| **C — friends, nobody watching** | **Pass.** *"Nobody is watching anything right now. When a friend starts watching someone, they show up here and you can jump in."* Reads as quiet, not broken — and it does **not** repeat the zero-friend ask, which would read as "you did it wrong". Asserted. |
| **D — Gravity available** | **Pass.** The card carries channel, a friend count, the friends' names and JOIN. A stranger reads "three friends are on this, I can join them" without knowing the word *Gravity* — which never appears in the UI. |
| **E — JOIN / together** | **Pass.** After JOIN: *"You're watching ESL_SC2 · 4 friends are here · WATCHING TOGETHER · 5"*, with the conversation open. Arrival is recognised as joining a social context rather than merely navigating. |
| **F — failure during activation** | **Pass.** Auth failure gives a human sentence and *Try again*; the error state names the problem without infrastructure words. M5D removed raw-error leakage and a source scan keeps it out. |

---

## 6. Store promise versus product

| Store beat | Product delivers |
| --- | --- |
| See where your friends are watching | Yes — and now the first screen says it too |
| Jump into the stream | Yes — JOIN on the card |
| Watch together | Yes — the together state and session |
| Find your Twitch friends | Yes — suggestions, search, invite |

**No mismatch remains.** The one that existed was the sign-in card promising
less than the listing, which is the safer direction to be wrong in but still
wrong: a person who installs on a clear promise and meets a vague screen has
been given a reason to doubt, at the exact moment they must grant a permission.

Nothing in the listing implies a prerequisite the product hides. The screenshots
show states an ordinary user reaches, and the "friends must also use Watchside"
condition is stated in both the listing's GETTING STARTED section and the
zero-friend state.

---

## 7. Terminology

No internal vocabulary leaks. Checked against the words a stranger meets:

- **"Social Gravity" never appears in the UI.** The cards simply group friends
  by channel and say how many. The concept teaches itself; the name would need
  teaching.
- **"Room" is never a noun in the interface.** The contextual tab is labelled
  with the streamer's name, which is the most specific thing that could be said
  about it.
- No *acquisition attribution*, *presence destination*, *campaign bind*,
  *automatic room*, or milestone names anywhere user-facing.

Nothing was renamed. There is no evidence of comprehension ambiguity in the
established terms — Friends, HERE, JOIN, Groups, Invite — and renaming a term
people already read correctly is churn.

---

## 8. Discoverability

**A stranger finds the panel.** Proven rather than assumed: the Store Assets
capture run loaded the extension into a real browser and rendered the panel on
four separate real Twitch page loads — the Browse directory and three channels —
today, from this source. The panel appears anchored to the right of the page,
with the wordmark visible.

Collapsed state, drag and the minimised launcher are covered by the existing
layout and Test Lab harnesses. The Test Lab's 11 known failures include launcher
and drag checks; that is **pre-existing, documented debt**, unchanged by this
milestone, and it is a lab-harness gap rather than an observed product defect.

---

## 9. Activation measurement

**Audited, and nothing was added — deliberately.**

Every stage of the funnel is already both contracted and emitted:

| Stage | Event |
| --- | --- |
| session start | `extension_session_started` |
| auth complete | `authenticated_session_started` |
| suggestion exposure | `friend_suggestion_impression` |
| add / request | `friend_request_sent`, `friend_request_accepted` |
| invite | `invite_link_created`, `invite_link_shared` |
| referral outcome | `referral_succeeded` |
| Gravity exposure | `gravity_cluster_impression` |
| JOIN | `join_clicked` |
| arrival | `join_arrived` |
| together | `watching_together_started` |

**The zero-friend state has no event of its own and does not need one.**
`authenticated_session_started` carries `friend_count`, so sessions that began
with zero friends are identifiable, and a stranger stuck at the empty panel is
countable, without recording a new fact about anybody.

Install remains unobservable and is not claimed. Claim discipline unchanged:
these are OBSERVED and ATTRIBUTED; nothing here supports a causal claim.

---

## 10. Support escape hatch

Verified reachable in the cases that matter:

- **panel opens** — Feedback in the account panel, which attaches version and
  diagnostics automatically;
- **panel does not open** — the support page, live at
  `anoteros-labs.github.io/watchside/support/`, covering the panel not
  appearing, sign-in trouble, stale builds, notifications and account deletion;
- **auth fails** — the error state's own message and retry, with support one
  link away in the account panel.

Credible, and it does not depend on the extension working.

---

## 11. Findings by severity

| | Finding | State |
| --- | --- | --- |
| **P1** | The first screen described no product and did not explain why Twitch auth was wanted | **Fixed** |
| P2 | Test Lab's 11 known failures include launcher/drag checks | Pre-existing documented debt, unchanged |
| P3 | The invite link shown in the panel is a long Pages URL; it shortens when `watchside.app` is live | Deferred to the domain, not a defect |

**No P0. No unresolved P1.**

Nothing else met the bar. Several things were *noticed* and deliberately left
alone — the signed-out Twitch chrome in the screenshots, the Browse page's
busyness behind screenshot 1, the wording of individual status lines — because
"I wonder if" is not evidence and this pass was not an invitation to redesign.

---

## 12. Validation

| Gate | Result |
| --- | --- |
| deterministic suite | **3,044 passed / 123 files** |
| lint | clean |
| `npm run typecheck` (`tsc -b`) | clean |
| build | clean |
| `verify:firefox` | clean |
| `test:destruction` | **87/87 detected** (2 new activation levers) |

Only `src/ui/components/AuthStates.tsx` and `src/ui/kickback.css` changed in
production source — a copy change and one style rule — so the analytics,
presence and layout harnesses were not re-run: no semantics they cover moved.
Known debt unchanged and not normalised.

**Automated browsers stayed quiet.** The Store Assets rule holds: `--mute-audio`
on Chromium and `media.volume_scale = "0.0"` on Firefox, both still asserted by
`tests/extension/captureAudio.test.ts`. No regression, and no capture run was
needed for this milestone anyway.

---

## 13. External state

**watchside.app** — checked once. Still no certificate;
`ERR_TLS_CERT_ALTNAME_INVALID`. GitHub continues to report both hosts valid and
`is_https_eligible: true`. DNS untouched.

**Chrome** — 0.7 live, **0.8 pending review**. The submitted artifact is
untouched: `cb3af261…`, unchanged and unrebuilt.

**Firefox** — 0.6 awaiting first AMO review. Untouched.

The fix in this milestone is **not** in the submitted 0.8 package. It ships in
the next version, which is the correct trade: replacing a package under review
for a copy improvement would cost the review cycle that finally distributes M3D
and M5C.

---

## 14. Human acceptance

Three questions automation cannot answer. Each is a judgement about a stranger's
reaction, not a fact about the product.

1. **Does the new sign-in card earn the Twitch permission?** Read it cold:
   *"See where your friends are watching on Twitch, and jump in."* then *"Sign in
   with Twitch so Watchside knows who you are. It never sees your password."*
   Would you approve the consent screen after that?
2. **Is the zero-friend state encouraging or discouraging?** It is accurate and
   offers a next action; whether it reads as *"I see how this becomes useful"*
   rather than *"nothing is here"* is a feel judgement.
3. **Does the JOIN card read as "my friends are there" at a glance?** Screenshot
   2 in `assets/store/current/contact-sheet.png` is the exact state.

No manual reproduction of the flow is required for any of them.

---

## 15. Recommendation

**M6A ★ GO.** Activation is coherent for a stranger, the one real defect is
fixed and covered, and no blocker remains.

The fix rides the next release rather than disturbing 0.8. Nothing here changes
the Chrome or Firefox recommendations, and the marketing gate stays closed.
