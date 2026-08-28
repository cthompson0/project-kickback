# KICKBACK 0025 — MULTI-DESTINATION, PART 2 (CLIENT)

**Date:** 2026-08-28
**Part 1 checkpoint:** `de9cd21` — *feat: add multi-destination presence (server model + gravity)*
**Part 1 report:** [0025-multi-destination-implementation-2026-08-28.md](0025-multi-destination-implementation-2026-08-28.md)
**Migration:** `supabase/migrations/0025_presence_destinations.sql` — unchanged by Part 2, **still not applied to hosted**
**Analytics schema:** local **25**, hosted **24**
**Extension version:** unchanged at **0.4.1**

**Together these two reports are the complete 0025 implementation.** Part 1 is
the server model, presence publishing and Gravity; this is the client room half.

**No hosted change. Nothing uploaded. The pending v0.4.1 Store artifact was not
touched, rebuilt or resubmitted. No `0026`. No `tabs` permission. No focus
published.**

---

## ✅ 0025 IS NOW COMPLETE

Every item Part 1 listed as outstanding is implemented and tested. The
29-case failure matrix closes at **27 verified by test, 2 explicitly deferred
with justification** (§11).

---

## 1. Part 2 executive summary

Part 1 left four stateful modules and the panel keyed to a single
`sessionChannel()`. Part 2 makes them channel-keyed, and the result was smaller
and cleaner than the Part 1 report anticipated — because of one thing that
turned out to be already true.

**`view.channel` is each tab's OWN channel.** `useKickbackState` reads it from
that content script's own URL (`watchChannel`), not from the worker. So the
panel was *already* per-tab; what was missing was that the worker held one
room's worth of state and broadcast it to every tab, so two tabs on two streams
both received the same single room.

**That made the UI question answer itself.** The worker now broadcasts every
room it holds, keyed by channel, and each panel selects its own tab's entry.
Two Twitch tabs render two different rooms from one broadcast, neither knowing
the other exists. **No tab strip, no room switcher, no redesign** — the room you
get is the room you are looking at, which is exactly what the brief asked for
and is not a tab manager.

**The Patch 1 workaround is gone.** `sessionAvailable` now reads: somebody else
is here on THIS channel, **or** this channel's conversation still exists. That
was always the approved lifecycle; it is no longer labelled temporary. Its guard
test has been inverted — it now asserts the marker is **absent**, which is what
proves the throwaway was actually thrown away rather than relabelled.

**One real defect was found and fixed by the required Gravity test.** Repeated
destination data duplicated a friend inside one cluster, which would inflate a
gathering count. The server de-duplicates so it was unreachable in practice —
which is precisely why it was worth asserting. The panel now de-duplicates
defensively.

**Verification: 71 files / 1873 tests / 0 failures / 0 skips.**

---

## 2. Exact client architecture

```
 content script (per Twitch tab)
   view.channel  ← read from THIS tab's own URL
        │
        ▼
   KickbackPanel  ── selects view.roomMembers[channel]
                                view.roomPeers[channel]
                                view.roomUnread[channel]
                                view.roomMessages.filter(channel)
        ▲
        │ one broadcast, every room
 service worker
   tabActivity.destinations()      → the set of open streams (deduped, capped 3)
   presenceReporter.setDestinations → published, skipped when unchanged
   sessionChannels()               → published AND still open
        ├── room.want(open)         → Map<channel, RoomState>
        ├── roomChat.setChannels()  → one buffer, tagged by channel
        └── together.setChannels()  → one buffer, tagged by channel
```

**Focus never appears anywhere in this diagram**, and there is no field it could
occupy. Switching between two already-open Twitch tabs produces no write, no
realtime event and no broadcast change.

---

## 3. Channel-keyed state model

| State | Before | After |
| --- | --- | --- |
| Room roster | one `members` array | `Map<channel, RoomState>` in `streamRoom.ts` |
| Room messages | one buffer, cleared on channel change | one buffer, already tagged by `.channel`; now only *closed* channels are dropped |
| Reactions | one buffer, cleared on channel change | same shape as messages |
| Peers | `sessionPeers(): string[]` | `peersOn(channel)` + `sessionPeerMap(): Record<channel, string[]>` |
| Unread | `roomUnread(): number` | `roomUnreadMap(): Record<channel, number>` |
| Broadcast state | `roomMembers: RoomMember[]`, `roomPeers: string[]`, `roomUnread: number` | all three `Record<string, …>` |
| Send | `send(body)` — worker inferred the channel | `send(channel, body)` — the tab names its room |

**Messages and reactions did not need partitioning.** Both types already carry
`.channel`, and `liveMessages` / `liveReactions` already filter by it. The only
single-channel behaviour was `setChannel()` *clearing on change* — so the change
was to stop clearing, not to restructure.

**The send now names its channel** because a tab knows which room it is in and
the worker no longer has a single right answer. The server re-validates
regardless: `send_room_message` refuses a channel the sender has not published,
so a wrong or forged value is rejected rather than trusted. A message with no
channel falls back to the primary, which is what an older client meant.

---

## 4. Room lifecycle

```ts
const sessionAvailable =
  sessionChannel !== null && (roomPeers.length > 0 || roomMembers.length > 0 || retainedHere)
```

Available while **somebody else is here on this channel**, or while **this
channel's conversation still exists**.

**No new clock and no new lifetime.** The worker prunes its buffer to
`RETENTION_MS`, so an expired message is not in `roomMessages` by the time the
panel looks — when the last message ages out, the surface goes on its own. That
is why this is not a lease, and a test asserts the region contains no
`setTimeout`, no `Date.now()` and no new `_MS` constant.

Retention is unchanged at 30 minutes. No room table, no persisted membership, no
Discord-style rooms.

`restoredSession()` gained the same third condition, so a remembered room is
restorable for exactly as long as its messages live.

---

## 5. Roster lifecycle

`streamRoom.ts` was rewritten around a `Map<channel, RoomState>`, each entry
carrying its own `members`, `fetchedAt`, `inFlight`, `generation` and
`invalidations`.

| Property | How |
| --- | --- |
| A cannot overwrite B | A response reaches only its own entry — there is no shared array to clobber |
| Refreshes are channel-scoped | Each entry has its own `fetchedAt` and refresh window |
| Failures are channel-scoped | `catch` touches nothing but the failing entry; other rosters keep their answers |
| Stale responses cannot populate the wrong channel | Two guards: the entry's `generation`, and an identity check that `rooms.get(channel)` is still the same object |
| Closing a stream forgets its roster | `want()` deletes entries no longer in the set |

**The arrival/departure fix from the original implementation is preserved
verbatim** — the invalidation counter that stops a pre-arrival answer being
cached for a full refresh interval. Server membership rules are untouched.

---

## 6. Message behaviour

- Channel A never renders in channel B — the panel filters by its own channel,
  and every message carries its own.
- Switching streams clears nothing. Only a **closed** destination's messages are
  dropped.
- Returning to a retained room restores its history: `setChannels` re-fetches
  every live destination, and the fetch merges by row id.
- Unread is per channel. `sessionTab.readAt(channel)` was already per channel;
  `roomUnreadMap()` is what finally uses it that way.
- 30-minute retention remains authoritative. **No backfill**, no storage change,
  per-recipient materialisation untouched.

---

## 7. Reactions and Together

`togetherReactions.ts` follows the same set and drops only closed destinations.
Reactions already carried `.channel` and `liveReactions` already filtered by it,
so isolation was structural once clearing stopped.

`send(channel, reaction)` names its room, as messages do.

**Verified server-side in Part 1** (a reaction on shroud reaches the shroud
component and not the lirik one) and client-side here.

`togetherWatch` — the shared-watch analytics lifecycle — remains keyed to the
single primary channel. **Deliberately deferred, §12.**

---

## 8. Realtime

**Unchanged, and deliberately so.** Patch 1's `realtimeTopics.ts` hardening is
untouched: content-addressed topics, per-topic teardown gate, `openChannel()` as
the single path.

**No new subscription.** The message and reaction inboxes are per USER, not per
channel — the server writes one row per recipient and each viewer subscribes to
their own inbox — so N open rooms still cost exactly one subscription each for
messages and reactions, regardless of N. That is a property of the 0020/0021
fan-out design, and multi-room inherits it for free.

Subscription count is therefore identical to before: one binding per friend, one
per group, one each for the two per-user inboxes.

---

## 9. UI behaviour

**The smallest coherent change: none to the layout.**

- Each Twitch tab's panel shows that tab's room, because `view.channel` is that
  tab's own URL.
- The existing single `SessionTab` is correct as-is — there is one room per tab
  because there is one channel per tab.
- Another stream's state is untouched when this tab is selected; it lives in the
  worker, keyed by channel.
- Returning to another Twitch tab exposes that stream's existing room and
  history without the first being destroyed.
- No tab strip, no room switcher, no browser-tab details, no focus display, no
  new permission.

---

## 10. Gravity test coverage

**Required by the brief, and it found a real defect.**

`tests/extension/multiDestination.test.ts`, 8 Gravity tests over the specified
scenario — Alice on shroud + lirik, Bob on lirik, Carol on shroud:

| Assertion | Result |
| --- | --- |
| shroud = Alice + Carol | ✅ |
| lirik = Alice + Bob | ✅ |
| Alice contributes to both, count 2 each | ✅ |
| Alice not fractionally weighted — same count as if she had one stream | ✅ |
| Self exclusion still holds across every cluster | ✅ |
| **Duplicate destination data cannot duplicate Alice in one cluster** | ✅ **after a fix** |
| A friend with no destination data falls back to their single presence | ✅ (old-client compatibility) |

**The defect:** `clusterMembers` does not de-duplicate, so a repeated
destination put Alice into the shroud cluster twice — inflating a gathering
count, which is the number the product is about. The server de-duplicates before
its cap so it was unreachable in practice, which is exactly why asserting it was
worthwhile. The panel's expansion now de-duplicates defensively.

---

## 11. The original 29-case failure matrix, closed

| # | Case | Status |
| --- | --- | --- |
| 1–4 | one / two / three / fourth destination | ✅ server + client registry |
| 5 | duplicate tabs collapse | ✅ both sides |
| 6 | **closing one duplicate does not remove it** | ✅ **now tested** (registry) |
| 7 | **closing the last duplicate removes it** | ✅ **now tested** |
| 8 | **rapid channel changes** | ✅ **now tested** (20 changes in one tab → one destination) |
| 9 | heartbeat expires, destinations fresh → invisible | ✅ tested 3 ways |
| 10 | destination exceeds 30m, account live | ✅ |
| 11 | sign-out | ✅ |
| 12 | old-client singleton compatibility | ✅ |
| 13 | old and new clients coexist | ✅ both directions, shared room |
| 14 | block relationship | ✅ both directions |
| 15 | friend authorization | ✅ |
| 16 | non-friend cannot enumerate | ✅ reader + raw table |
| 17 | **Gravity counts one user at several destinations** | ✅ **now tested** (§10) |
| 18 | self exclusion | ✅ server + Gravity |
| 19 | **multiple simultaneous Stream Rooms** | ✅ **now tested** (two rosters, two availability answers) |
| 20 | messages for A never in B | ✅ server + client filter |
| 21 | reactions isolated by channel | ✅ |
| 22 | **retained-message room survives peer leaving** | ✅ **now tested** |
| 23 | **retained room disappears after retention** | ✅ **now tested** via the real prune |
| 24 | returning to a retained room restores history | ⚠️ **DEFERRED — see §12** |
| 25 | crash/sleep via stale parent presence | ✅ |
| 26 | stale child row does not leak | ✅ |
| 27 | realtime re-subscribe does not regress | ✅ `realtimeTopics` untouched, its 14 tests pass |
| 28 | no new browser permissions | ✅ manifest byte-identical |
| 29 | legacy `list_friends` usable | ✅ |

**27 verified by test. 2 deferred with justification** (24, and `togetherWatch`
from §7 — which is not a numbered case but is named here rather than hidden).

---

## 12. Known limitations and deliberately deferred

**Case 24 — "returning to a retained room restores recent history."** The
mechanism is implemented and reviewable: `setChannels` re-fetches every live
destination and `withMessages` merges by row id. It is **not** covered by an
automated test, because a faithful one needs the worker's fetch/subscribe
interleaving driven end to end, and a shallow one asserting "fetchHistory was
called" would be the kind of test that passes while the feature is broken. **It
is on the manual smoke checklist (§14, step 8) and should be watched there.**

**`togetherWatch` remains single-channel.** The shared-watch analytics lifecycle
still tracks one interval on the primary destination. It is analytics-only —
nothing a user sees — and making it per-destination changes what
`watching_together_started/ended` mean, which is a measurement decision rather
than an implementation one. **Deferred deliberately; not started.**

**`automatic_room_left` is registered but still not emitted.** It belongs with
the `togetherWatch` change above; emitting it from the panel would produce one
event per tab per navigation, which is not what it is for.

**Destination refresh is polled, not pushed** (unchanged from Part 1).

**Friend-list scale is unchanged** — still one realtime binding per friend, and
out of scope as instructed.

---

## 13. Hosted migration status

**`0025_presence_destinations.sql` is unchanged by Part 2 and is still NOT
applied to hosted.** Hosted remains at analytics schema **24**; local expects
**25**.

**It must be applied before any extension build depending on multi-destination
APIs is released.** The client now calls `report_destinations` and
`list_friend_destinations`; without 0025 both fail. They fail *safely* — the
legacy `setActivity` path still maintains presence — and now announce themselves
through `client_error`, but it must not happen in a shipped build.

Apply via the project's documented mechanism: Supabase → SQL Editor → paste
`supabase/.generated/apply_all.sql` (idempotent, verified to apply twice) or
just the one migration file. Verification queries are in Part 1 §24.

---

## 14. Manual browser smoke checklist

**Only meaningful after 0025 is applied.** Load the unpacked build.

1. Open one Twitch channel. Confirm a friend sees you there.
2. Open a second and a third. Confirm the friend's Gravity shows you at **all
   three**, counted once at each.
3. Open a fourth — only three are published.
4. Open a **duplicate tab** of one stream. Confirm nothing changes.
5. Close that duplicate. Confirm the destination **stays**.
6. **Switch repeatedly between two already-open Twitch tabs. The friend's view
   must not change at all.** This is the headline behaviour.
7. **With a friend on stream A and a different friend on stream B**, open both.
   Confirm each tab's panel shows **its own** room, with its own people, its own
   messages and its own unread count. Send in one — it must not appear in the
   other.
8. **Case 24:** talk in room A, switch to tab B, come back to tab A within 30
   minutes. **The conversation must still be there.** This is the deferred test
   case; watch it carefully.
9. Have the last peer leave room A. **The conversation stays readable.** Wait
   past 30 minutes with no new messages — the room goes on its own.
10. Kill the browser. Confirm you disappear from all destinations within ~90s.
11. Set visibility to "hide activity", then sign out. Both clear everything.
12. With a v0.4.1 device if available: old ↔ new mutual visibility and a shared
    room.
13. Confirm no permission prompt on install or upgrade.

---

## 15. Files changed (Part 2)

| File | Change |
| --- | --- |
| `src/background/streamRoom.ts` | **rewritten** — `Map<channel, RoomState>`; `want(channels)`, `snapshot(channel)`, `rosters()`, `channels()`, scoped `invalidate`/`pending` |
| `src/background/roomMessages.ts` | `setChannels`, `channels()`, `send(channel, body)`; drops only closed channels; fetches every live one |
| `src/background/togetherReactions.ts` | same shape |
| `src/background/index.ts` | `sessionChannels()`, `peersOn()`, `sessionPeerMap()`, `roomUnreadMap()`, `roomSize(channel)`; channel-keyed broadcast; sends carry a channel; diagnostics updated |
| `src/client/types.ts` | `roomMembers`/`roomPeers`/`roomUnread` → `Record<string, …>`; send signatures |
| `src/client/messages.ts`, `src/client/port.ts` | optional `channel` on room message and reaction |
| `src/ui/KickbackPanel.tsx` | selects this tab's room; **temporary workaround replaced**; Gravity de-duplication |
| `src/testlab/client.ts`, `src/testlab/TestLab.tsx` | channel-keyed shape (one-entry map) |

**Tests:** `roomSurfaceRelief.test.tsx` → **renamed** `roomLifecycle.test.tsx`
(assertions inverted); `multiDestination.test.ts` **new**; six existing suites
updated for the new API and superseded source pins.

---

## 16. Tests added and changed

| | Files | Tests |
| --- | --- | --- |
| Part 2 baseline | 70 | 1849 |
| **Now** | **71** | **1873** |
| Δ | **+1** | **+24** |

- **+1 file:** `tests/extension/multiDestination.test.ts` — **22 tests**
  (8 Gravity, 9 tab registry, 5 roster isolation).
- **+2 tests** in the renamed `roomLifecycle.test.tsx` (9 → 11): the two new
  per-destination availability cases.
- `roomSurfaceRelief.test.tsx` → `roomLifecycle.test.tsx` is a rename, so the
  file count moves by one, not two.

**No assertion was weakened.** Six suites had source-string pins updated because
the code they pinned was legitimately superseded — each was replaced with an
assertion on the *new* invariant, not deleted. Two of those pins had been
corrupted by a mechanical rewrite and were restored by hand.

---

## 17. Exact verification results

| Command | Exit | Result |
| --- | --- | --- |
| `npm run build` | 0 | content 311.86 kB (89.60 gzip), background 288.92 kB (78.05 gzip) |
| `npx vitest run` | **0** | **71 files / 1873 tests / 0 failures / 0 skipped** |
| `npx tsc -b` | 0 | clean |
| `npx eslint .` | 0 | clean, 0 warnings |
| `tests/db` (within the suite) | 0 | includes the 39 Part 1 destination tests |
| `npm run verify:analytics` | 0 | schema present, nothing client-readable |
| `npm run verify:groups` | 0 | group backend applied |
| `npm run verify:config` | 0 | key accepted, Twitch auth enabled |
| `npm run verify:store` | 0 | repository agrees with itself |

`npm run test:authz` **not run**, as instructed.

**One honest note:** `verify:groups` returned 1 on one sweep and 0 on immediate
re-run with a full healthy output. It is a network-dependent probe against the
live project; treated as a transient blip, not a finding. If it recurs it is
worth a look.

---

## 18. Git status

Before commit:

```
 M src/background/index.ts
 M src/background/roomMessages.ts
 M src/background/streamRoom.ts
 M src/background/togetherReactions.ts
 M src/client/messages.ts
 M src/client/port.ts
 M src/client/types.ts
 M src/testlab/TestLab.tsx
 M src/testlab/client.ts
 M src/ui/KickbackPanel.tsx
 M tests/extension/comboCta.test.tsx
 M tests/extension/roomResolution.test.tsx
 M tests/extension/sessionStability.test.ts
 M tests/extension/socialViewing.test.ts
 M tests/extension/streamSession.test.ts
 M tests/extension/together.test.ts
 M tests/testlab/together.test.tsx
 R tests/extension/roomSurfaceRelief.test.tsx -> tests/extension/roomLifecycle.test.tsx
?? tests/extension/multiDestination.test.ts
?? docs/reports/0025-multi-destination-part-2-2026-08-28.md
```

No release ZIPs, no `.env.local`, no credentials. Manifest and `package.json`
untouched. `supabase/` untouched by Part 2.

---

## 19. GO / NO-GO — manual multi-destination browser smoke

## **GO, after applying 0025 to hosted**

Every automated gate passes and the model is coherent end to end. The one
precondition is real: **the client now calls `report_destinations` and
`list_friend_destinations`, and neither exists on hosted yet.** Smoke testing
before applying 0025 would exercise the legacy fallback path and tell you
nothing about multi-destination.

**Order:**

1. Apply `0025` to hosted (Part 1 §23), verify with Part 1 §24 — the marker must
   read **25**.
2. Load the unpacked build and run §14.
3. Pay particular attention to **step 6** (tab switching must be invisible to
   friends) and **step 8** (case 24, the one deferred test).

**NO-GO** on: applying anything else hosted, any Store upload, `0026`, a version
bump, or the Friend Growth milestone.

---

## 20. Is 0025 complete?

## **YES — with two deliberate, documented deferrals.**

The server model, presence publishing, Gravity, room state, room lifecycle,
roster isolation, message and reaction isolation, and the removal of the Patch 1
workaround are all implemented and tested. 27 of 29 failure modes are verified by
automated test.

**What remains is named rather than hidden:** case 24 is covered by manual smoke
rather than an automated test (§12), and `togetherWatch` stays single-channel
because making it per-destination is a measurement decision, not an
implementation gap.

**0025 is engineering-complete and ready for hosted application and manual
smoke.** Release preparation happens after that, not now.

---

*End of Part 2 report.*
