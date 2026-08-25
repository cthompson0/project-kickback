# Automatic Stream Room — UX correction

**Date:** 2026-08-24
**Commit:** `fix: refine automatic stream room experience`
**Status:** implemented, verified, no schema change

---

## 1. What ROOM previously did

It was a disclosure toggle. `src/ui/components/Together.tsx` held
`const [open, setOpen] = useState(false)`, and `.kb-together-open` flipped it.
Nothing navigated; the same Gravity card grew a `.kb-room` list underneath its
existing content and the button changed its label to `CLOSE`.

Alongside it the card carried five permanent `.kb-together-react` buttons and a
`.kb-together-live` strip. So the HERE card was, at once: the social map, a
reaction composer, an activity feed and a collapsible roster.

Every test passed. They asserted the wrong thing — `roomButton === true`,
`reactionButtons === 5`, `roster.length === 2` on the card — and the browser
gate had a helper whose comment explained how to keep the toggle idempotent
across preset changes. Tests passing did not make it the intended UX.

## 2. Why the previous UX missed the vision

Two failures, neither of them a bug.

**The map became a control panel.** Gravity answers "where is everybody" at a
glance. Five always-present controls in the middle of that answer turn a thing
you read into a thing you operate.

**Arriving was not arriving.** Presence → Gravity → JOIN → Together ends
somewhere. Expanding a section of a card is not somewhere; it is the same card,
taller. The last step of the product's core loop had no destination.

## 3. Existing components reused

Nothing was invented that already existed.

| Need | Reused |
|---|---|
| Detail navigation | `KickbackPanel`'s `openGroupId` / `chatOpen` pattern |
| Back header | `.kb-detail-head`, `.kb-back`, `BackIcon` from group chat |
| Combo counting | `scanCombos` → `activeCombo` (`src/core/combos.ts`) |
| Combo rendering | `EmoteImage`, `.kb-together-count` |
| Membership | `stream_room_members` (0020), `src/background/streamRoom.ts` |
| Transport | `src/background/togetherReactions.ts`, unchanged |
| Reaction TTL | `REACTION_TTL_MS`, through `liveReactions` |
| Identity | `useChannelName`, `Avatar`, `UserCard` |
| Freshness | `liveStateOf`, `STALE_TOLERANCE_MS` |

One new core module (`socialViewing.ts`, 3 functions) and one new component
(`StreamRoom.tsx`).

## 4. The new Room surface

`src/ui/components/StreamRoom.tsx`, rendered by `KickbackPanel` **instead of**
the map, exactly as a group conversation is:

```
←  LIRIK                                   ← .kb-detail-head / .kb-back
   Escape from Tarkov · ● LIVE · 18K

   WATCHING TOGETHER · 4

   You
   Jake
   Sarah
     Friend of Jake
   Matt

              😂 ×3                         ← the run still going

        😂  ❤️  🔥  😭  👀                  ← the only reaction buttons

   Some people here arrived through a friend.
```

The panel holds `openRoomChannel`, and whether the room is open is **derived**:

```ts
const roomOpen =
  tab === 'friends' && !finding &&
  openRoomChannel !== null &&
  openRoomChannel === view.channel &&
  view.roomMembers.length > 0
```

Leaving the channel closes it. The stream ending closes it (membership empties).
Nothing has to notice; both are the same derivation.

No tab, no window, no persistent record, no room id. Membership is still the
connected component the server computes on demand.

## 5. HERE / Gravity behaviour

The card keeps everything it said — channel, count, LIVE/OFFLINE, category,
title, "N friends watching with you", the people — and loses the composer. What
is left of `Together.tsx` is a preview and a doorway.

One condition changed. It was:

```tsx
here && section.channel && (section.count > 0 || (roomMembers?.length ?? 0) > 0)
```

and is now the server's membership alone. The `or` meant the card could offer a
room nobody was in: the count comes from presence the client already holds,
while membership comes from a query that also requires eligibility. Asking only
the second makes the doorway honest — if it is there, there is somewhere to go.

## 6. Room interaction

Reactions live inside. Same five Kickback emotes, same `client.sendReaction`,
same per-recipient realtime fan-out, same rate budget. Bigger targets (34×30 vs
24×24) because this is the surface you came to use.

Participants are `sortMembers(members)` with the viewer first, direct friends
rendered with `Avatar` + `UserCard`, and two-hop members rendered with a neutral
mark and `Friend of X` — one hop of context, no more.

**Still not included:** persistent chat, transcript, room creation, ownership,
membership management, join/leave. No text was added.

## 7. Combo convergence

There is one engine and one derivation.

```ts
export function roomActivity(reactions, channel, displayName, now = Date.now()) {
  const live = liveReactions(reactions, channel, now)
  const last = live[live.length - 1]
  if (!last) return null
  const combo = activeCombo(reactionMessages(live, displayName))
  return { emote: reactionEmote(last.reaction), count: combo?.count ?? 1 }
}
```

Both surfaces call it. Neither imports `scanCombos`, neither reconstructs runs,
neither counts anything — a test asserts that by reading both sources. The
`covered`/`badges`/`singles` folding that used to live in `Together.tsx` is
gone; `activeCombo` already answers the question it was reconstructing.

`reactionBursts` and `isCombo` remain deleted.

**Combo breakers.** A breaker is an ordinary message interrupting a run, and a
v1 room has no text in it. The rule is preserved in `scanCombos` and simply has
nothing to fire on — a *different* emote starts its own run rather than breaking
one. A lab test states this rather than leaving it to be discovered, so nobody
adds a second way to end a run.

## 8. Ephemeral activity preview

`😂 ×6` on the HERE card, driven by real reactions inside the room.

No names. No "Sarah and Jake are reacting". No timestamps, no "recently", no
sender narration. The combo is the whole message: glance at Kickback, see a
number climbing, understand something is happening right now.

A single reaction shows the emote with no count (`count < COMBO_MIN_DISPLAY`).

## 9. Preview lifetime semantics

`REACTION_TTL_MS = 8_000`, through `liveReactions`. There is no second TTL.

- The count is recomputed from what is still live, so it **shrinks** as
  contributors age out rather than freezing at its peak.
- When the last reaction expires, `roomActivity` returns `null` and the preview
  vanishes completely — no faded remnant, no stale badge kept to hold the
  layout. The row holds its own height (`min-height` on `.kb-together`), so
  there is nothing to preserve state for.
- A one-second heartbeat runs **only while there are reactions**; an idle card
  ticks nothing.

The browser gate advances 8.5 s and asserts both the symbol and the counter are
gone while the doorway remains.

## 10. Offline root cause — §13 answered

**A. Was Twitch Metadata correctly reporting LIRIK as offline?**
Yes. The card said OFFLINE, which only renders on `liveStateOf(...) ===
'offline'`, i.e. a fresh record whose `live` field was `offline`. Metadata was
right; nothing consumed it.

**B. Does raw Presence treat `/lirik` as watching LIRIK?**
Yes. `parseChannelFromPath` maps any channel path to
`{ type: 'watching', channel }` regardless of live state. This is correct for
presence and stays.

**C. Does Social Gravity form for an offline destination?**
Yes — deliberately, and unchanged. `socialGravity` demotes offline destinations
below live and unknown ones but keeps them, because "three friends are sitting
on a channel that just ended" is real information. This was an approved decision
in the metadata checkpoint.

**D. Did Automatic Together form?**
Yes, and it should not have. `together.setChannel()` was driven by
`currentChannel()`.

**E. Did Stream Room membership form?**
Yes. `room.want(currentChannel())`, and `stream_room_members` has no live check
of its own — it authorizes on presence and friendship only.

**F. Did `watching_together` analytics count it?**
Yes. `updateTogether()` passed `currentChannel()` to `analytics.noteTogether`,
which opens the shared-watch interval. **This is the serious half**: the panel
was wrong for as long as it was on screen; the interval would have been in the
database permanently.

**G. Can JOIN target an offline gathering?**
Yes, and that stays. The destination is visibly demoted and labelled OFFLINE,
and someone choosing to go there is making an informed choice. What changes is
that arriving does not manufacture a room or shared watch time.

**H. UI inconsistency or analytics contamination?**
**Both, and contamination is the real finding.** Every layer was reading
presence correctly. The defect was that "browser is on /lirik" and "watching
LIRIK" were the same fact to everything downstream, because presence was the
only thing any of them asked.

The OFFLINE label is not hidden. `watchTogetherState` still distinguishes
`offline` from `unknown` precisely so the card can keep saying it.

## 11. Live eligibility

`src/core/socialViewing.ts` — the one rule, in one place.

```ts
export function isSocialViewing(live: LiveState): boolean { return live === 'live' }
export function canWatchTogether(channel, metadata, now = Date.now()): boolean
export function watchTogetherState(channel, metadata, now = Date.now()): LiveState
```

The separation the brief asked for:

| | Question | Answered by | Changed? |
|---|---|---|---|
| **Raw activity** | where is this browser? | presence | **no** |
| **Social viewing** | watching a stream, with people, now? | presence **and** `canWatchTogether` | new |

Presence is untouched: URL parsing, multi-tab effective activity, the 90 s
staleness rule and write-time redaction are all as they were. The Friends list
still says a friend is on an offline channel, because they are.

In the worker, `socialChannel()` is the single consumer, and everything that
means "together" reads it:

- `together.setChannel(here)` — the reaction inbox filter
- `room.want(here)` — membership
- `noteTogetherSurface()` — `automatic_room_entered`
- `updateTogether()` — the shared-watch lifecycle, **and** `coWatcherCount`

A test asserts `canWatchTogether` appears exactly once in the worker.

## 12. Metadata uncertainty

`unknown` is **not** eligible. A cold cache, an undeployed function, a Twitch
outage and a never-requested channel all look identical, and treating any of
them as live invents certainty in the one place that cannot be repaired later.

The cost is a false negative: a live stream whose metadata has not arrived yet
shows no doorway for a moment, and loses the first seconds of a shared watch.
That is visible and self-correcting. The false positive is neither. Same trade
the analytics work has made throughout — conservative undercounting over
fabricated activity.

Stale records go through `liveStateOf`, so a record past `STALE_TOLERANCE_MS`
reports `unknown` and is therefore not eligible.

## 13. Live status changes

Both directions are bounded, with **no new polling loop**.

The metadata service already refetches any record older than `LIVE_TTL_MS`
(2 min), and `refreshAttention()` — driven by presence heartbeats every 45 s —
always includes the viewer's own channel in `want()`. `needsRefresh` is
state-independent, so an `offline` record is refreshed on the same schedule as a
live one.

What changed is one callback:

```ts
onChange: () => { pushActivity(); updateTogether(); broadcast() }
```

Metadata arriving is now an eligibility change as well as a state change. LIVE →
OFFLINE closes the room, the subscription and the interval; OFFLINE → LIVE opens
them. Both within roughly two minutes, through the two functions that already
decide. A test asserts the worker contains no `setInterval`.

## 14. Analytics implications

| Event | Before | After |
|---|---|---|
| `gravity_cluster_impression` | fires for offline destinations | unchanged — the map still shows them, with `live` recorded |
| `join_clicked` / `join_arrived` | can target offline | unchanged |
| `watching_together_started` / `_ended` | **fired on offline co-presence** | requires a live stream |
| `together_duration` | could accrue on an offline page | cannot |
| `post_social_retention_ended` | followed the above | follows the corrected lifecycle |
| `automatic_room_entered` | on presence | on eligibility |
| `automatic_room_opened` | on the disclosure toggle | on entering the room view |
| `automatic_room_reaction` | unchanged | unchanged (now only sendable inside) |
| `automatic_room_combo` | per annotated badge | once per `(emote, count)` while a run grows |

No event names were added, removed or renamed; no migration was needed for
analytics.

**Historical limitation, documented not rewritten.** Private-beta
`watching_together_*` rows written before today were produced by the
presence-only rule and may include offline co-presence. Nothing recorded the
destination's live state at the time, so they are not distinguishable after the
fact and **nothing was rewritten**. `docs/ANALYTICS.md` §8 now says to treat
pre-2026-08-24 `together_duration` as an upper bound.

## 15. Privacy / security

No change to the threat model, and nothing new is exposed.

- The preview shows an emote and a number. **No identities leak** — a two-hop
  member's name appears only inside the room, which is the surface that also
  explains how they got there.
- No text content of any kind crosses the card; there is no text in a room.
- Membership still comes from `stream_room_members` (SECURITY DEFINER, seeded at
  `require_actor()`, refuses unless the caller's own presence puts them on the
  channel, 3 hops, 50 members).
- Reaction recipients are still fixed at write time by the server. No client can
  subscribe to another user's inbox.
- Global presence RLS unchanged. No new RPC, no new grant, no new table.
- Narrowing eligibility only ever **reduces** what forms; it cannot expose
  anything that was previously hidden.

Reviewed and unchanged: no secrets in the extension, no service-role key, no
provider tokens reaching the page, no client-supplied user ids trusted.

## 16. Test Lab

`roomMembers` in `src/testlab/world.ts` now calls `canWatchTogether` — imported
from production, not reimplemented. This is the one rule the lab must not copy,
because reproducing the offline bug is the point.

Three new presets, the same world with three answers from Twitch:
`Room · stream ended`, `Room · Twitch has not answered`, `Room · just went live`.
Existing room and together presets now declare LIRIK live.

New lab coverage: card is a doorway not a roster · friend-of-friend named inside
· combo identical inside and out · no breaker to fire · offline forms nothing
while presence and the OFFLINE label survive · unknown forms nothing ·
LIVE→OFFLINE and OFFLINE→LIVE on one world with the people unchanged.

The lab still holds no subscription, no rate limit, no policy and no sweep of
its own; the assertion that no lab source mentions them still passes.

## 17. Verification

| Gate | Result |
|---|---|
| `npm run typecheck` | pass |
| `npm run lint` | pass |
| `npx vitest run` | **1470 passed**, 51 files |
| `npx vitest run tests/db` | **177 passed** — run explicitly, per the earlier miss |
| `npm run verify:lab` (real browser, CDP) | pass |
| `npm run build` | pass |

No command approached five minutes; the longest was the DB suite at 23 s.

The browser gate drives the whole corrected flow in a real browser: ROOM opens a
distinct view with the map gone, Back restores the HERE card with its count
intact, reacting inside produces one badge at ×2, the same ×2 appears on the
card outside, and 8.5 s later it is gone while the doorway remains. Offline and
unknown presets produce no doorway; `just went live` produces one.

## 18. Migration / deployment

**No schema change was required, and none was made.** Migration 0020 is
untouched, as is the connected-component architecture.

The fix is entirely client-side because the client is what forms the room: the
worker no longer asks `stream_room_members` about an ineligible channel, and no
longer subscribes or reports there.

**Audited and reported, not changed:** `stream_room_members` and
`send_together_reaction` have no live-stream check of their own. Adding one
would require the database to know live status, which lives in an Edge Function
cache rather than a table an RPC can read — a materially different architecture
for a case with no impact today, since a modified client sending into an
ineligible channel reaches only room members computed from presence, and every
recipient's own client filters by its own eligible channel. Recorded as
deferred, not as a silent gap.

Nothing needs to be applied to hosted Supabase for this checkpoint.

## 19. Manual two-account test

To confirm in the real browser:

1. Both accounts on a **live** channel → HERE card shows the count and a `ROOM`
   button, and **no reaction buttons**.
2. Click `ROOM` → the panel shows the room: Back, channel, `WATCHING TOGETHER ·
   2`, both people, five reaction buttons.
3. React from A → B sees it inside the room within a second.
4. Both react the same → one badge, `×2`, not two symbols.
5. Back → the HERE card returns with its count, and carries the same `×2`.
6. Wait ~8 s → the badge is gone entirely; the `ROOM` button remains.
7. Both accounts on an **offline** channel → the card still says OFFLINE and
   still lists the friend, and there is **no** `ROOM` button.

## 20. Git

One commit, `fix: refine automatic stream room experience`. Full diff inspected;
no `.env.local`, no tokens, no keys, no browser profiles, no dist or release
ZIP, no analytics dumps, no mutation residue.

## 21. Deferred

- **Pre-JOIN activity preview** (§11 of the brief). Showing `😂 ×6` on a
  destination the viewer has not joined requires reactions to reach the sender's
  direct friends who are *not* on the channel — the fan-out in
  `send_together_reaction` currently targets room members only. That is a new
  migration and a new privacy surface (an off-channel user learning that
  activity is happening in a room they are not in). Not rushed into this
  checkpoint; the post-JOIN preview it would mirror is shipped and proven.
- **Server-side live check** on `stream_room_members` / `send_together_reaction`
  — see §18.
- Growth work — **not started**, as instructed.
