# Watchside — first-impression validation

**For:** the v0.9 release candidate, before any store submission.
**Participants:** 10–30 people who did not build Watchside.
**Purpose:** find out whether a stranger can reach Watchside's value. Not a
survey, not a satisfaction score, not a statistical exercise.

---

## The one rule for facilitators

**Do not help.**

The whole question is whether the product explains itself. Every hint you give
deletes the finding you were about to get. If somebody is stuck, let them be
stuck, write down where, and wait. Only step in when the session is genuinely
over — and record that you did.

If you catch yourself about to say *"you need to press…"*, that sentence is the
result. Write it down instead of saying it.

**What you may say:** "Take your time." · "Say what you're thinking." · "Do
whatever you'd normally do."

**What you may not say:** anything naming a button, a tab, a feature, or what
Watchside is for. Do not explain the empty panel. Do not explain JOIN.

---

## Before you start

1. Confirm which browser they use, and record it. **Chrome and Firefox paths
   must both be covered across the cohort.**
2. Give them the store link or the invite link — the scenario says which — and
   nothing else.
3. Start recording notes. Timestamps matter more than prose.
4. Ask one question at the end of each scenario, before any discussion:
   **"In your own words, what does Watchside do?"**

---

## Scenario A — solo stranger

**Setup:** they install from the store link, alone, knowing nobody on Watchside.

| Observe | Why it matters |
| --- | --- |
| Can they say what Watchside does, unprompted? | If not, the first screen failed |
| Do they understand *why* the panel is empty? | The zero-friend state names its own precondition; does that land? |
| Do they find the friend/invite path without help? | This is the only route out of cold start |
| What do they try first — search, invite, or nothing? | Tells us which affordance reads as primary |
| Where do they hesitate, and for how long? | Hesitation is the finding, not the outcome |
| Do they give up? At which screen? | |

**Expected honest outcome:** many will stop here. A solo stranger with nobody to
invite has no way to reach the product's value, and that is a known property of
a social product rather than a defect. **What matters is whether they understand
why**, and whether they know what would fix it.

---

## Scenario B — two-friend pair

**Setup:** two brand-new people, together, deciding to try Watchside. Give them
nothing but the store link.

| Observe | Why it matters |
| --- | --- |
| Can one invite the other **without being told how**? | The core first-edge loop |
| Which mechanism do they reach for — invite link, search, or asking for a code? | Reveals what people expect to exist |
| Does the second install complete? | |
| Does Twitch sign-in complete? | |
| **Do they end up as friends without anyone intervening?** | The single most important observation in the whole exercise |
| How long between invite sent and friendship visible? | |
| Can they find each other afterwards? | |
| Do they reach Presence — one seeing where the other is? | |

**Watch the sign-in especially closely.** The invite is now persisted across
service-worker eviction; if a friendship fails to form here, capture what was on
screen and how long the Twitch consent step took.

---

## Scenario C — invited user

**Setup:** an existing Watchside user sends an invite to somebody who has never
installed it. **Run this on Chrome and on Firefox separately.**

| Observe | Why it matters |
| --- | --- |
| Does the invite page make sense at a glance? | |
| **Is the right browser obvious?** | Both buttons are always shown; does the hint help or confuse? |
| Do they understand somebody invited them? | The page says so — does it register? |
| Does the code survive install and sign-in? | |
| **Are they friends when they land in Watchside?** | |
| Does the inviter know anything happened? | Currently they do not — record whether they expect to |
| On a phone: do they understand it is desktop-only? | |

---

## Scenario D — small existing graph

**Setup:** a participant who already has one or more real Watchside
relationships, so suggestions, Presence and Gravity can operate.

| Observe | Why it matters |
| --- | --- |
| Do mutual suggestions read as relevant, or as creepy? | This is the line the product must not cross |
| Do they understand *why* somebody is suggested? | Only a mutual count is shown, never names |
| Can they tell where their friends are? | |
| Do they understand HERE / a gathering? | Without the words being explained |
| Do they understand what JOIN does before pressing it? | |
| **Do they actually press JOIN?** | |
| What happens after they arrive — do they stay? | |
| Does anything feel spammy or invasive? | |

---

## Recording sheet

One row per participant per scenario.

```
participant   __  browser __________  scenario ____  date ________

what they said Watchside does, verbatim:
_____________________________________________________________________

first action taken:                       time to it: ______
reached a friendship?      yes / no       time: ______
reached Presence?          yes / no
reached JOIN?              yes / no / did not understand it

hesitations (where, how long, what they said):
_____________________________________________________________________

what they expected that did not happen:
_____________________________________________________________________

anything that felt invasive or spammy:
_____________________________________________________________________

did the facilitator intervene?  no / yes — what was said:
_____________________________________________________________________
```

---

## Severity rubric

| | |
| --- | --- |
| **STOP-SHIP** | Blocks the first edge, or breaks a security/privacy promise |
| **HIGH** | Most participants confused at the same point; fix before broad launch |
| **MEDIUM** | Repeated friction that did not prevent success |
| **LOW** | One person's preference, or a wording nit |

### Telling the three failure kinds apart

This matters more than the severity itself, because they have different owners.

**Product confusion** — the software did what it was built to do, and the person
did not understand it. *"I didn't know what JOIN meant."* → copy or design.

**A bug** — the software did not do what it was built to do. *"I pressed JOIN
and nothing happened."* → get the Watchside version from the account panel, the
browser, and what was on screen.

**Cold start** — the software worked and there was nothing to show, because they
have no friends yet. An empty panel with no friends is **not** a bug, and must
not be filed as one. Check the friend list before classifying.

**Unrelated Twitch behaviour** — Twitch was slow, the stream was offline, the
page was mid-navigation. Note it and move on; it is not a Watchside finding.

---

## Qualitative stop-ship criteria

Any one of these stops the release. **No numeric thresholds** — the roadmap sets
none, and this exercise is discovery, not significance testing.

- **An invited user cannot complete the first edge**, on either browser.
- **Invite state disappears more than once** across the cohort.
- Participants **cannot say what Watchside does** after using it.
- Participants **cannot identify how to connect** with somebody.
- **The Chrome path or the Firefox path is broken.**
- Any **security or privacy surprise** — somebody sees data they should not,
  or is surprised by what is shared.
- A **block invariant fails** anywhere it is observed.
- **The same material confusion recurs across most participants** at one point.

---

## What to send back

- One recording sheet per participant per scenario.
- The verbatim answers to *"what does Watchside do?"* — these are the most
  useful single artifact.
- A list of every facilitator intervention, with what was said.
- Any stop-ship trigger, immediately, without waiting for the rest.
