# Contextual Stream Session — P1A

**Date:** 2026-08-24
**Implements:** [contextual-stream-session-architecture.md](contextual-stream-session-architecture.md), P1A scope
**Migration:** `0021_room_messages.sql` — **not yet applied to hosted**
**Status:** implemented, verified, awaiting manual two-account acceptance

---

## 1. UI implemented

**The contextual streamer tab.** `Friends │ TheBurntPeanut │ Groups`, present only
while a session exists, labelled with the authoritative Twitch display name.

```ts
type Tab = 'friends' | 'groups' | 'session'

const sessionAvailable = sessionChannel !== null && view.roomMembers.length > 0
const tab: Tab =
  requestedTab === null
    ? restorable ? 'session' : 'friends'
    : requestedTab === 'session' && !sessionAvailable ? 'friends' : requestedTab
```

`requestedTab` is the viewer's **intent**; the shown tab is derived. Nothing is
stored, so there is no frame in which a tab that does not exist is selected, and
the session vanishing while you are in it drops you on Friends without a state
update firing during a render.

**It never auto-selects.** A tab appearing does not move anybody's feet. The
only automatic selection is a *restore*, which requires a remembered intent.

**The `ROOM` affordance on the HERE card** now calls `chooseTab('session')` —
same destination, one of two ways in.

**Truncation is CSS** (`max-width: 92px`, ellipsis) with the full name in
`title` and as the session heading. Slicing the string would lose it in both.

**The session layout** — conversation dominant, context compact:

```
TheBurntPeanut
● LIVE · Escape from Tarkov · 18K       ← red dot (§9)
◕◕◕◕  WATCHING TOGETHER · 4        ⌄    ← tap to expand the roster
─────────────────────────────────────
Jake   holy shit
Sarah  LMAO
You    😂  ×3
─────────────────────────────────────
       😂 ❤️ 🔥 😭 👀
Message…                          [😀]
```

Participants collapse to an avatar row; the full list with `Friend of X` and
UserCards is one tap away. There is **no Back button** — the tabs are the way
out, which is the whole point of moving it beside Friends.

## 2. Ephemeral chat architecture

Send-time authorization, materialised recipients:

```
send → server verifies the sender is live-eligible and present
     → server computes the sender's component NOW
     → one row per recipient, plus the sender's own copy
     → each client reads only rows addressed to it
```

`room_messages(id, recipient_id, sender_id, channel, body, created_at)`, RLS
`recipient_id = (select auth.uid())`, realtime filtered per user on
`kickback-room:<uid>`. No client `INSERT` grant — the only writer is
`send_room_message`, `SECURITY DEFINER`, actor from `require_actor()`, so there
is no sender parameter to spoof.

**Why fan-out and not a body table with a policy.** A policy is *re-evaluated*,
and re-evaluation is where backfill leaks in. Also: one shared row matching many
subscriptions is the documented hosted Realtime defect that produced the
one-direction reaction bug in 0019.

**Refresh recovery** is the one functional difference from reactions, and why
0021 has an inbox index that 0020 deliberately denied. `roomChat.setChannel()`
re-fetches even when the channel has not changed — which is exactly what a page
refresh looks like from the worker's side.

Subscription opens *before* the fetch, and rows fold by id, so a message sent
mid-fetch is neither lost nor shown twice.

## 3. Retention

| | Value | Enforced by |
|---|---|---|
| Delivery authorization | at send | `send_room_message` |
| Storage | **30 min** or **200 rows** per recipient per channel, whichever bites first | sweep on every insert |
| Client display | everything retained | `liveMessages` |
| Activity indicator | **8 s** (`ACTIVITY_TTL_MS`) | `roomActivity` |

The row cap is what makes the clock safe to state: retention cost is
`messages × recipients` and a room holds up to 50 people, so 30 minutes alone
does not bound a fast conversation.

Sweeping is opportunistic — every participant clears their own inbox as they
speak, and a silent participant's rows are collected by whoever does. No
`pg_cron`.

**No retention language in the UI.** No timer, no "30 minute chat", no "expires
in". It simply feels transient, which is the point.

`REACTION_TTL_MS` is now an alias of `ACTIVITY_TTL_MS` — one number, two
readers, so they cannot drift.

## 4. Merge / split

- **Split** (`A ↔ B ↔ C`, B leaves): already-delivered messages stay until TTL
  — you cannot un-send, and deleting on split would make a conversation flicker
  every time presence wobbled. New messages compute a component without C, so
  **no row for C is ever written**. Nothing filters it; there is nothing to
  filter.
- **Merge** (`A ↔ B` + `C ↔ D` bridged): **no backfill.** C and D were not
  authorized when A spoke, so no row addressed to them exists. Secure by
  construction rather than by a query.
- **Post-merge** messages reach the whole merged component.

All four are asserted against real Postgres in `tests/db/roomMessages.test.ts`.

## 5. Unread

`kickback:sessionRead → { [channel]: lastSeenAtMs }`, in `chrome.storage.local`.

- Counts retained messages newer than the watermark, **excluding the viewer's
  own** — a thing you said is not a thing waiting for you.
- Cleared by having the tab selected, and re-marked as messages arrive while it
  is open.
- **Survives a Twitch refresh**, because the messages do; unread that reset
  would claim you had read something you had not.
- Capped at `9+`, shown on the tab and on the HERE doorway.
- **Reactions and combos never increment it.** Unread is *something waiting*;
  a combo is *something happening* and is gone in eight seconds.

Watermarks age out with the 12-hour selection bound, so the key cannot grow a
row per channel the browser has ever visited.

## 6. Mute / unmute

Local, silent, reversible. `kickback:mutedUsers`, worker-held, broadcast in
state. **No table, no RPC, no migration** — asserted by reading both `0021` and
`core/mute.ts`.

Suppresses their messages, their reactions, **and their contribution to the
combo counts you see** — filtered *before* the engine, because a muted person
inflating a ×6 in your panel is still them getting your attention. Two viewers
can therefore see different counts, which is unavoidable for any local mute and
better than one that half works.

Does **not** touch friendship, presence, Gravity or the HERE card. The muted
person is not told and keeps participating normally for everyone else.

Entry point: `UserCard`, everywhere it opens. Management: a **Muted** list in
the account card — a mute you cannot find is a mute you cannot undo.

## 7. Combo convergence

**One stream.** `comboStream()` merges reactions and messages by server
timestamp and hands the result to `scanCombos` — the engine group chat has
always used.

- A reaction is an emote.
- An emote-only message is the same emote sent the slow way, and joins the same
  run.
- Ordinary text does **not** contribute — it *closes* a run, and can be credited
  with breaking it.

That last rule has existed in `scanCombos` since group chat and has never had
anything to fire on in a room, because a room had no text in it. **It fires
now**, unchanged and unduplicated: `COMBO BROKEN BY …` is live in a session.

`roomActivity()` reads the same stream through an 8-second window and is called
by both the session and the HERE preview, so opening the tab continues what the
card was showing rather than offering a second opinion.

`reactionBursts` and `isCombo` remain deleted.

## 8. Red LIVE indicator

`--kb-live: #e91916`, and a real bug surfaced doing it: there were **two**
`.kb-live-dot` rules, and the later one painted it `--kb-here` green. Every LIVE
badge in the panel was the colour of the HERE badge, and nothing looked broken
because green is a perfectly reasonable colour for a dot.

The duplicate is deleted rather than recoloured. One definition, one meaning:

| Colour | Means |
|---|---|
| `--kb-live` red | a broadcast is happening |
| green | a person is online |
| accent | something to press |

The browser gate now asserts the computed colour, so this cannot silently
regress again.

## 9. Analytics

**One new event**, `automatic_room_message_sent` (`length_bucket`, `has_emote`,
`participant_count`). **Never the body.** Recorded when the sender's own copy is
*delivered*, not when send is called — the self-row is the one signal the server
accepted it.

**One new property**, `automatic_room_opened.opened_from`
(`here_card | tab | restored`) — the navigation bet, answered in the data.

Deliberately **not** added: `room_available` (that is `automatic_room_entered`),
`streamer_tab_opened` (that is `opened_from: 'tab'`), `combo_participated`
(`automatic_room_combo`), or any duration event (`watching_together_*` already
measures the interval a session happens inside).

## 10. Tests

| Suite | Count |
|---|---|
| `tests/db/roomMessages.test.ts` | **20** — fan-out, FoF delivery, cluster isolation, split, merge-no-backfill, post-merge delivery, 280 cap, rate limit in its own bucket, no client INSERT, RLS, 30-min sweep, 200-row cap, per-channel scoping |
| `tests/db/bundle.test.ts` | +3 — applies on top of deployed 0020, `send_room_message` identical either way, grants/RLS survive a re-run |
| `tests/extension/streamSession.test.ts` | **43** — retention, dedup, ordering, parsing, unread, one combo stream, breakers, mute, the remembered selection, the inbox, worker/panel wiring |
| `tests/extension/togetherRender.test.tsx` | **40** — rewritten for the tab; asserts the absence of both older shapes |
| `tests/testlab/*` | 122 — graph scenarios repointed at the session |
| **Full suite** | **1558 passed** |

**Browser gate** (`npm run verify:lab`, real Edge over CDP) drives: tab appears
with authoritative casing and does **not** self-select · `ROOM` opens it and
selects it · Friends restores the map with the HERE card intact · the tab is the
other way in · a friend's message and the viewer's own both land · a reaction
plus an emote-only message make **one** ×2 · text closes the run · the same ×2
appears on the card outside and is gone 8.5 s later · unread 2 on both the
doorway and the tab, cleared by looking · a reaction does not increment it ·
offline and unknown produce no tab · the graph scenarios · 260px without
overflow · the LIVE dot's computed colour.

**Not run:** the full mutation universe, per policy.

## 11. Migration / deployment

**`0021_room_messages.sql` is written and tested but NOT applied to hosted.**

To deploy: paste `supabase/.generated/apply_all.sql` into the Supabase SQL
editor and run it. It is regenerated and includes 0021.

- Wrapped in `begin;`/`commit;`, so a failure leaves nothing behind.
- `create table if not exists`, `drop policy if exists`, `drop function if
  exists` before create, and a guarded publication add — safe under
  `apply_all.sql` bundling and safe to re-run.
- `drop function` before `create` specifically to avoid the 42P13 that broke the
  0020 deploy.
- **0020 is untouched.**
- Verified from a database stopped at 0020, from empty, and applied twice.

Reload the extension after deploying; the worker subscribes to `room_messages`
on sign-in.

## 12. Two-account manual acceptance

1. Deploy `apply_all.sql`; reload the extension on both accounts.
2. Both open the same **live** channel.
   → within ~2 s both show `Friends │ <STREAMER> │ Groups`, and **Friends is
   still selected**.
3. Account A clicks the streamer tab.
   → session opens: `WATCHING TOGETHER · 2`, composer, five reactions, no Back.
4. A types "hello".
   → appears for A **and** B within a second.
5. B replies from the tab. → appears for both.
6. B stays on Friends; A sends two more.
   → B's tab shows `2`, and the `ROOM` button on B's HERE card shows `2`.
7. B opens the tab. → unread clears; all messages are there.
8. Both press the same reaction emote.
   → one `×2` inside; leave to Friends → the same `×2` on the HERE card; ~8 s
   later it is gone and the `ROOM` button remains.
9. A sends `:lol:` as a **message**, B presses the `lol` **reaction**.
   → one combo, `×2` — not two indicators.
10. A types ordinary text after a 3-combo. → `COMBO BROKEN BY …`.
11. **A refreshes Twitch with the session tab selected.**
    → after 1–2 s the panel reopens on the streamer tab with the conversation
    intact.
12. A switches to Friends, then refreshes. → opens on Friends.
13. A opens B's UserCard → **Mute**.
    → B's messages and reactions disappear for A only; B sees no change. The
    account card lists B under **Muted**; Unmute restores them.
14. Both move to an **offline** channel.
    → the streamer tab disappears, the card still says OFFLINE and still lists
    the friend, and there is no `ROOM` button.
15. Wait ~30 min on a live channel without speaking, then refresh.
    → old messages are gone; nothing says why.

## 13. Git

One commit. Full diff reviewed; no `.env.local`, no tokens, no keys, no browser
profiles, no dist or release ZIP, no analytics dumps, no mutation residue, no
scratch files.

## 14. Not done, deliberately

- **Block / unblock — P1B, and it is a gate.** Must land before Automatic Room
  chat is opened past controlled testing. Three-hop components mean a viewer can
  be in a room with somebody they never chose; the moment that room carries text
  that stops being a nice property and becomes a duty of care. Mute is **not** a
  substitute: it stops somebody being loud, not being there or seeing you. Block
  must be server-side and must affect graph traversal and delivery — see the
  architecture doc §14.
- Pre-JOIN combo previews (P3).
- Growth, invite links, creator tools, cross-platform.
- Persistent transcripts, permanent room records, room ownership, OS chat
  notifications.
