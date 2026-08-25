# Stream session activity polish

**Date:** 2026-08-25
**Follows:** [contextual-stream-session-final-stabilization.md](contextual-stream-session-final-stabilization.md)
**Migration:** none. 0020 and 0021 untouched.
**Status:** P1A complete.

---

## 1. Combo preview root cause

**The activity window compared two different clocks.**

```ts
// before
messages.filter((entry) => now - entry.at < ACTIVITY_TTL_MS)
```

`entry.at` is the **server's** `created_at`, parsed straight out of the row.
`now` is `Date.now()` on the **viewer's machine**. The window is eight seconds
wide, so a machine a few seconds out of step with Supabase never had a single
message inside it — and `liveReactions` had exactly the same comparison.

That produces precisely the reported symptom, and explains why it looked like
only Gravity was broken:

| Surface | Source | Behaviour |
|---|---|---|
| The `×2` beside a message in the session | `scanCombos` over the **whole retained log**, no time window | **worked** — this is the ×2 in the screenshot |
| The session's combo bar | `roomActivity`, 8-second window | silently empty |
| The card's combo | `roomActivity`, 8-second window | silently empty |

Both window-based surfaces failed together while the badge kept working, which
is why it read as "the session is fine, Gravity is not".

It survived every automated check because a test and the Test Lab each have one
clock. Two clocks only exist in a real deployment.

**Fix.** Ordering and recency are different questions and now use different
clocks. Every row carries `receivedAt` — when *this* client learned of it —
alongside the server's `at`:

- **ordering** stays the server's, or two clients would disagree about which
  emote came first and therefore about the combo;
- **recency** is ours, because "is this happening now" is a question about the
  person looking at the screen;
- **retention** (30 minutes) stays on `at`, where seconds of skew are noise.

History fetched after a refresh gets `receivedAt = 0`: a message read back did
not just happen, however recently the server wrote it. That also stops a
refresh flashing somebody else's expired combo.

## 2. Canonical combo propagation

Unchanged, and now actually reaching both ends:

```
reactions + emote-only messages
  → comboStream()        one merged stream, ordered by server time
  → scanCombos()         the one engine
  → roomActivity()       trailing run within the activity window
      ├── session  → ActiveComboBar at COMBO_MIN_DISPLAY
      └── card     → combo + CTA at COMBO_MIN_DISPLAY
```

There is no Gravity-specific scan. A test asserts `SocialGravity` contains
neither `scanCombos` nor `activeCombo` — it may only ask `roomActivity`.

> **Superseded in part by §13 below.** The `Join Room →` invitation described
> in §3–§5 was removed after a further real-browser pass. Everything else in
> this report - the clock fix, the canonical propagation, the removal of the
> permanent ROOM button, unread ownership and the participant count - stands.

## 3. Gravity combo CTA

```
TheBurntPeanut                              HERE
How To Fish                    🐸 ×4  Join Room →  ● LIVE 41K
1 friend watching with you
AnoterosTV
```

Rendered only at `COMBO_MIN_DISPLAY` (×2), inside `.kb-gravity-status` with the
other ephemeral numbers. A single emote produces **nothing** on the card.

Compact by construction: `flex: none`, tabular digits, a pill that appears and
vanishes without moving its neighbours. Measured at ~103px in the browser gate,
which asserts it stays under 150px — a badge, never a banner.

## 4. Join Room behaviour

It is a real `<button>` — it can be tabbed to and shows a focus ring — and it
does exactly one thing:

```tsx
onClick={() => onOpenRoom(section.channel!)}   // → chooseTab('session')
```

No Twitch navigation, no second room, no membership change, no duplicated
session state. It selects the tab the session already lives in. Tests assert
`SocialGravity` contains neither `window.location` nor `channelUrl`, and the
browser gate clicks it and checks the session opens with its tab selected.

## 5. Permanent Room affordance removal

The `ROOM [1]` control on the left is gone, and `Together.tsx` is deleted.

It was a second, always-present doorway into a session the contextual streamer
tab already offers, and it carried a **duplicate unread badge** — one waiting
message announced twice in the same panel.

The two doorways that remain are not redundant:

| | Job | Lifetime | Unread |
|---|---|---|---|
| **Streamer tab** | the normal way in | while the session exists | **owns it** |
| **Combo CTA** | something is happening *now* | while the combo exists | none |

## 6. Unread ownership

`Friends │ TheBurntPeanut [2] │ Groups` — and nowhere else. The card draws no
count at all, asserted both in render tests and in the browser gate.

Unread is content *waiting for you*; the combo is something *happening right
now*. Keeping them on separate surfaces is what keeps either legible.

## 7. Watching Together count

`WATCHING TOGETHER · 1` was real: the header counted `members.length + 1`, and
`members` is the server's answer. Since availability became presence-or-server,
a session can exist on presence alone while the graph query is still in the air
— so somebody demonstrably not alone was told they were.

```ts
const participants = Math.max(members.length, peers.length) + 1
```

The union, because either source can be ahead: presence sees a direct friend
immediately, the server sees anybody reached *through* one. Gravity counts other
people ("1 friend watching with you"); the session counts everybody in it.
Covered for members-only, peers-only, and both.

## 8. Offline behaviour

Unchanged and extended: a combo is social-session activity, not evidence of live
viewing, so the CTA appears on an offline destination too. The card says
OFFLINE, there is no LIVE dot, and no shared-watch analytics accrue.

## 9. Tests

**1603 passed.** New `tests/extension/comboCta.test.tsx` covers the brief's
cases A–H: single emote → nothing; real combo → emote, count and CTA; growth to
×3; TTL removing the whole CTA; the CTA asking only for a tab selection; unread
absent from the card; the count including the viewer in all three shapes; and
the CTA surviving OFFLINE. Placement is asserted **semantically** — the CTA is
inside the status region and absent from the participant list — rather than by
pixel.

Also pinned: the recency comparison uses `receivedAt`, `now - entry.at` is gone,
history parses with `receivedAt = 0`, and `SocialGravity` adds no request,
subscription or second timer.

**Browser gate** additionally drives the real path: no permanent button and no
card unread; a lone emote producing no CTA; `Join Room →` appearing with the
combo, being a `<button>`, opening the session and selecting its tab; the whole
CTA leaving on expiry while the tab stays; unread on the tab only, clearing on
view, and not incremented by a reaction; `WATCHING TOGETHER · 2`.

`tests/db` **not run** — no DB, RPC or schema change. The mutation verifier was
**not** run.

## 10. Migration / deployment

**None.** 0020 and 0021 untouched, no Supabase function deployed. Everything
here was client render state and one field on two parsed row types.

Reload the extension.

## 11. Manual retest

1. A and B on the same destination → contextual streamer tab exists, and the
   card has **no** ROOM button.
2. Open the session → `WATCHING TOGETHER · 2`.
3. A sends one 7TV emote → artwork once in the timeline, **nothing** on Gravity.
4. B sends the same emote → session shows ×2, and the card's **right** side
   shows `[emote] ×2  Join Room →`.
5. From Friends, click `Join Room →` → the session opens, Twitch does not
   navigate.
6. Wait ~8 s → combo and CTA both disappear; the streamer tab remains.
7. With A on Friends, B sends a normal message → badge on the **tab only**.
8. Open the session → unread clears.
9. Offline sanity: both on an offline destination → session and chat still work,
   a real combo still produces the CTA, and no shared-watch time accrues.

## 12. Git

One commit. Full diff reviewed; no mutation residue (the verifier was not run),
no secrets, no `.env.local`, no dist or release artefacts.

---

## 13. Final note: the CTA came back out

**Date:** 2026-08-25, after another two-account pass.

The combo pipeline was confirmed working end to end - single emote silent, ×2
appearing on both surfaces, growing, and expiring. Looking at it in a real
panel, the `Join Room →` attached to it was the wrong call: the invitation was
more visually expensive than the signal it was attached to, and it competed
with the destination for attention every time three people laughed at once.

The combo already says everything it needs to by existing. Something is
happening, right now, among the people you are watching with. Somebody who
wants to join has a doorway that is always there and already tells them how
much they have missed:

```
Friends │ TheBurntPeanut [2] │ Groups
```

So the card now shows the mark and nothing else, on its own line directly under
the status:

```
TheBurntPeanut · 1                         HERE
How To Fish                       ● LIVE 41K
                                      🐸 ×4

1 friend watching with you
AnoterosTV
```

Its own line rather than a fifth item in the status row, which at the narrowest
panel already carries a category, a badge and a viewer count. It is a `<span>`
and deliberately **not** clickable - making the mark itself the doorway would
have been the same mistake in quieter clothes.

**What this changed:** the CTA markup, its styling, and the tests and gate
checks that asserted it. Combo semantics, the `receivedAt` clock fix, session
lifecycle, unread and the room architecture are all untouched, and the suites
covering them ran unchanged.

**Asserted now:** the combo is a `<span>`, never a `<button>` or an `<a>`; it
sits inside `.kb-gravity-activity` below `.kb-gravity-status` (checked
geometrically in the browser gate); `SocialGravity` no longer takes an
`onOpenRoom` callback at all, which is the strongest form of "this card cannot
open a session"; and JOIN and the user card still work everywhere else on the
map.

---

## P1A is complete

Arrival, departure, return, offline continuity, chat, emotes, combos, the
contextual tab, unread, mute and the activity CTA are all implemented and
verified.

Still deferred, unchanged: **Block/unblock is P1B and a gate** before this opens
past controlled testing — mute stops somebody being loud, not being there or
seeing you. Pre-JOIN previews, Growth, and Twitch/BTTV/FFZ emote providers
remain roadmap.
