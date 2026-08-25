# Contextual Stream Session — stabilization

**Date:** 2026-08-25
**Follows:** [contextual-stream-session-p1a.md](contextual-stream-session-p1a.md)
**Migration:** none. 0020 and 0021 untouched.

Three findings from two-account testing. Two of them turned out to be the same
bug, and chasing the third surfaced two more that only appear once emotes
travel as messages.

---

## 1. Arrival (Bug A) and departure (Bug C) — one root cause

**A swallowed invalidation in `background/streamRoom.ts`.**

```ts
invalidate() { fetchedAt = 0 }          // "the answer is out of date"
want()      { … if (inFlight) return … }
ask()       { … fetchedAt = now() … }   // "this answer is fresh"
```

Joining produces **two presence events in quick succession** — the friend goes
idle as their old tab closes, then appears on the new channel about a second
later. Each one invalidates the room. The first fires a request; the second
arrives while that request is still in the air, hits `if (inFlight) return`, and
does nothing further.

The request then lands carrying the answer computed **before** the arrival, and
stamps `fetchedAt = now()`. The invalidation is gone, the pre-arrival room is
cached, and nothing re-asks until the 90-second refresh interval.

That explains the asymmetry exactly:

| | What happens |
|---|---|
| **B**, who joined | navigates, so `want()` takes the channel-changed branch, which resets `inFlight`, clears the cache and re-asks. Works. |
| **A**, already watching | never navigates. Presence tells A that B is here — which is why the HERE card truthfully said "1 friend watching with you" — but membership stayed cached at the pre-arrival answer. |

Departure is the same shape: navigating away is also two events (off this
channel, then onto the next), so the departure was swallowed the same way and
surfaced only when the cache expired. "Roughly 30–60 seconds" is what waiting
for that looks like.

**Fix.** Invalidation is a *counter*, not a flag, so a request can tell whether
one happened while it was in flight:

```ts
let invalidations = 0
invalidate() { invalidations += 1; fetchedAt = 0 }

async function ask(forChannel, mine, seen) {
  …
  members = sortMembers(parseRoomMembers(payload))
  deps.onChange?.()

  if (invalidations !== seen) {   // it went stale while we were fetching
    fetchedAt = 0
    inFlight = false
    void ask(forChannel, mine, invalidations)
    return
  }
  fetchedAt = now()               // only now is it fresh
}
```

The answer is still applied — it is the best we have — and immediately asked
again. This terminates because each retry observes the latest count, and the
count only moves when the co-present set actually changes.

No polling, no timer, no shortened TTL, no schema change. The event that lets
A truthfully redraw HERE is the same event that now converges membership.

**Timing.** Arrival and graceful departure now resolve within one round trip of
the presence event — sub-second in practice. Graceful **tab close** still goes
through the reporter's 5-second offline grace, unchanged and deliberate: it is
what stops JOIN (which closes one tab and opens another) flashing offline.
Abrupt death is still the 90-second staleness rule, on both the client and in
`stream_room_members`. None of that was touched.

## 2. Emote messages (Bug B) — one missing call

The picker inserts a **Kickback** emote as its token (`:lol:`) and an
**external** emote as its bare name, so the composer reads the way Twitch chat
does. Group chat rewrites the name into a stable provider+id token on the way
out:

```ts
const resolved = emoteCatalog.resolveOutgoing(String(body))
```

The room's send path never made that call. So an emote picked from the channel's
own set was stored as the word: it rendered as plain text, `soleEmote()` did not
recognise it, and it therefore contributed nothing to a combo — which is also
why the activity preview on HERE never lit up. Kickback built-ins worked, which
is why it looked intermittent.

**Fix:** the room's `roomMessage` handler resolves through the same call.

### Two more, found while proving it

**The preview only knew Kickback emotes.** `emoteOf()` matched against the
built-in palette, so an external emote counted in the room and not on the card —
two surfaces disagreeing about one run. It now uses `soleEmote()`, which is the
same function that decides whether a message *qualifies* for a combo, so a body
can never be countable and unrenderable at once.

**The clock only ran for reactions.** The one-second heartbeat that ages the
preview was gated on `reactions.length`. Once an emote from the picker became a
*message*, a room with a live combo and no reactions had nothing driving the
clock — the preview formed correctly and then never went away. Both surfaces now
tick on `reactions.length + messages.length`. Caught by the browser gate.

## 3. The session and the card now share one definition of "now"

The session's combo bar was the trailing run of the **whole 30-minute log**;
the card's preview has always been the **8-second activity window**. Once a room
retains half an hour of conversation those stop being the same thing, and the
gate caught it: the session said `×4` while the card said `×2`.

Both now read `roomActivity`. The per-message `×N` badges still come from the
full log, because a count beside an old message is history and is correct there.

One engine, one window for "right now", two surfaces that cannot disagree.

## 4. Quick-reaction strip removed

The permanent five-button row above the composer is gone. There were two emoji
surfaces stacked on top of each other and the strip was the weaker one: five
emotes where the picker offers everything the channel has, costing a row of
height that belongs to the conversation.

```
[ Message……………………… ] [😀] [SEND]
```

Kept: the picker, inline emote sending, the reaction backend and transport (the
unified event stream still counts reactions), the combo engine, the activity
preview. The activity indicator remains — it is not a control.

**Future, deliberately not built:** when a combo is already running, surfacing
*that* emote as a one-click way to join it. Unlike a permanent strip it would
appear only when there is something to join.

## 5. Tests

`tests/extension/sessionStability.test.ts` — 23 tests, driving the real
`createStreamRoom` against a server whose answer we control **one request at a
time**, because every one of these bugs lives in the window while a request is
unanswered:

- arrival converges with no refresh, no timer, no extra heartbeat — and the
  change reaches `onChange`, which is what the tab is derived from
- departure empties the room without advancing the clock at all
- ten heartbeats that changed nothing cause **one** request, not ten
- a burst of invalidations causes one re-ask, not one each
- a slow answer for a channel the viewer has left is still discarded
- an emote resolves to a token, renders as artwork, and qualifies as emote-only
- two people, same emote, as messages → ×2; a reaction plus an emote message →
  ×2; text does not contribute and breaks a run
- the session and the card read the same window; badges stay on the full log
- the heartbeat ticks on messages as well as reactions
- the strip is absent and the picker is present

`tests/extension/togetherRender.test.tsx` updated for the removed strip.

**Browser gate** (`npm run verify:lab`) now drives the real path a person uses:
open the picker, choose an emote, send it, and assert one `×2` in the session,
the same `×2` on the card after switching to Friends, and nothing at all 8.5 s
later. The lab's `searchEmotes` returned `[]`, which the picker treats as a real
(empty) answer rather than falling back — so the lab rendered a picker with no
emotes and the gate could not exercise this at all. It now returns the built-ins.

**Full suite: 1581 passed.** `tests/db` not run — no database, RPC or schema
behaviour changed. The mutation verifier was **not** run.

## 6. Migration / deployment

**None.** 0020 and 0021 are untouched, and 0021 is already deployed. These were
client bugs and are fixed in the worker and the UI.

Reload the extension to pick up the build.

## 7. Two-account acceptance

1. **A** watches a live streamer. **B** is elsewhere.
2. **B** clicks JOIN on A's card.
3. **Without refreshing A**: A's contextual streamer tab appears within a second
   or two of A's card showing "1 friend watching with you". *(Bug A.)*
4. Both open the session.
5. A sends normal text → B receives it.
6. B replies → A receives it.
7. A opens the emote picker, chooses a **channel** emote (not a Kickback one)
   and sends it → B sees the **artwork**, not the word. *(Bug B.)*
8. B sends the same emote → both see **one `×2`**, in one place.
9. Switch to Friends → the same `×2` is on the HERE card.
10. Wait ~8 s → the preview disappears completely, on both. *(The heartbeat fix
    — this is the one that previously stuck.)*
11. Confirm there is no five-button row above the composer; only the picker.
12. B navigates away to another channel → **A's tab disappears promptly**,
    no refresh. *(Bug C.)*
13. B returns → A's tab comes back automatically.
14. Mute B from their UserCard → their messages and emotes vanish for A only,
    and the combo count A sees drops accordingly. Unmute from the account card.

## 8. Deferred, unchanged

Block/unblock remains **P1B and a gate** before this opens past controlled
testing — mute stops somebody being loud, not being there or seeing you.
Pre-JOIN previews, Growth, transcripts and room records all still deferred.
