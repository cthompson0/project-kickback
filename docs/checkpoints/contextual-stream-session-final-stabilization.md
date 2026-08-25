# Contextual Stream Session — final stabilization

**Date:** 2026-08-25
**Follows:** [contextual-stream-session-stabilization.md](contextual-stream-session-stabilization.md)
**Migration:** none. 0020 and 0021 untouched.

---

## 1. Why arrival still failed

The previous fix was real but was not the whole cause. It removed one way for an
invalidation to be swallowed; it did not remove the **live-status dependency**
sitting in front of the entire session.

`socialChannel()` returned null unless Twitch metadata said the channel was
live, and everything hung off it — the room query, the reaction inbox, the
conversation, the surface event. Two consequences, and both produce exactly the
reported symptom:

- **Any non-`live` answer silenced the session.** `unknown` counts: a cold
  cache, a slow refresh, a record past the 15-minute staleness tolerance. A
  viewer who has been sitting on a channel is far more likely to be in that
  state than one who just navigated — which is precisely the asymmetry. B had
  fetched metadata seconds ago; A may not have.
- **When it returned null, `coPresenceKey(null)` returned `''`.** So the
  co-present key never changed, the room was never invalidated, and no request
  was ever made. Nothing to converge, nothing to retry.

A refresh fixed it because a page load re-runs `pushActivity()` and re-fetches
metadata.

Underneath that is a second, more basic problem: **availability was waiting on a
graph RPC to rediscover a friend the client could already see.** Authenticated
realtime presence had already told A that B was on this destination — it is the
same evidence "1 friend watching with you" is drawn from. Making the tab wait
for `stream_room_members` to independently confirm it added a round trip whose
only job was to restate a known fact, and every failure lived inside it.

## 2. Why departure still failed

Same two causes, mirrored. If `sessionChannel()` was null, the key stayed `''`
and B's departure invalidated nothing; if it was non-null, the tab still waited
on a membership round trip to notice something presence already knew.

## 3. Final session availability model

Four concepts, permanently separated:

| | Question | Source |
|---|---|---|
| **Presence** | where is this person's browser? | presence rows, unchanged |
| **Social session** | are these connected people at the same destination? | presence + friendship |
| **Live metadata** | is the broadcaster streaming? | Twitch, via the metadata service |
| **Shared-watch analytics** | are they co-viewing a *live* broadcast? | session **and** live |

```ts
// A session needs somewhere to be and somebody to be there with.
canSessionForm(channel, peers)          // no metadata, no live status

// A shared watch additionally needs something to watch.
canWatchLiveTogether(channel, metadata) // analytics only
```

In the worker:

```ts
sessionChannel()   // signed in + own presence written + on a channel
liveWatchChannel() // sessionChannel() AND authoritatively live
sessionPeers()     // direct friends presence proves are here
```

`sessionChannel()` drives the room, the inbox, the conversation and the tab.
`liveWatchChannel()` has exactly one consumer: `analytics.noteTogether`. A test
asserts the live question is asked in **one** place, and that
`canSessionForm`'s body contains neither `metadata` nor `live`.

**Availability** is now:

```ts
sessionAvailable =
  sessionChannel !== null && (view.roomPeers.length > 0 || view.roomMembers.length > 0)
```

## 4. Direct presence vs server membership

The hybrid the brief proposed, and it is cleaner:

| | Decided by | Why |
|---|---|---|
| Is a session available? | **presence** (direct friends) or the server | The client already holds authenticated proof; waiting to be told again is the round trip that kept failing |
| Who is *in* the room, including friends-of-friends | **server** | The client cannot see other people's friendships and must not guess |
| Who **receives** a message or a reaction | **server**, at send time | Unchanged. `send_room_message` computes the component itself; there is no client-supplied recipient |

The client never invents membership — it only declines to pretend it does not
already know about a direct friend it can see. Recipient authorization is
untouched, and no migration was needed.

## 5. Offline room semantics

A stream ending no longer ends the conversation around it.

- Session, tab, participants, conversation, composer, emotes and combos all
  remain.
- The card shows OFFLINE; the LIVE badge and viewer count disappear.
- `watching_together` analytics stops.
- If the stream comes back, nothing is recreated — the session was never gone —
  and the shared-watch lifecycle resumes under the existing rules.
- Two people meeting on an already-offline channel get a session. **Offline does
  not mean you cannot hang out here.**

The server already permitted this: neither `stream_room_members` nor
`send_room_message` ever checked live status. The restriction was entirely
client-side, and removing it needed no schema change.

## 6. Live analytics separation

The previous offline-contamination fix is **not** regressed, and is now narrower
and better named. `updateTogether()` passes `liveWatchChannel()`, so:

| Situation | Session | `watching_together` |
|---|---|---|
| Same live channel, connected | yes | yes |
| Same **offline** channel, connected | **yes** | **no** |
| Metadata unknown / stale | **yes** | no (conservative) |
| Alone | no | no |

Uncertainty still under-counts rather than fabricating watch time — but it no
longer costs anybody a conversation, which is what made the old rule too
expensive to be conservative with.

## 7. Combo-only Gravity preview

A single emote is a thing one person did and belongs in the conversation. A
combo is several people agreeing at once, which is worth catching from across
the panel.

```ts
const combo = activity && activity.count >= COMBO_MIN_DISPLAY ? activity : null
```

One engine, one threshold — the combo engine's own. Below it the card renders
nothing at all. No names, no narration, no timestamps, no stale state. The
preview disappears completely when the activity window expires.

## 8. Gravity placement

The combo moved to the **right**, into the status lane with `● LIVE` and the
viewer count:

```
TheBurntPeanut · 3                    HERE
How To Fish              😂 ×4  ● LIVE 41K
1 friend watching with you
AnoterosTV
```

The left half is identity — who is streaming, what they are playing, who is
there — and must not move. `flex: none` plus tabular digits mean the badge can
grow from ×2 to ×9 without shifting anything. The stream row now also renders
when there is a combo but no metadata, so the badge always has a home.

The browser gate asserts it is in `.kb-gravity-status`, that nothing renders it
beside the friends or in the doorway, and that it stays under 70px.

Moving it moved the clock with it: the card needs its own one-second heartbeat
to age the combo out, because nothing else re-renders it between presence
updates. That bug has now been fixed once per surface the combo has lived on;
it belongs to the combo, so it travels with it.

## 9. Duplicate emote cleanup

The lone glyph above the composer is gone. An emote you sent appeared twice —
once as your message, once on its own above the input. The conversation already
carries it.

What remains between the log and the composer is the `ActiveComboBar`, and only
at `COMBO_MIN_DISPLAY` — several people agreeing at once is genuinely something
other than the messages themselves.

```
[ Message……………………… ] [😀] [SEND]
```

## 10. Emote provider support

Audited from `src/background/emoteCatalog.ts` and `src/background/sevenTv.ts`:

| Provider | Status | Path |
|---|---|---|
| Kickback built-ins | **SUPPORTED** | `EMOTES` in `core/emotes.ts`, inline SVG, fixed ids |
| 7TV channel set | **SUPPORTED** | `7tv.io/v3`, for the channel the viewer is on, 30-min cache |
| 7TV global set | **SUPPORTED** | `7tv.io/v3`, 6-hour cache |
| Twitch global | **NOT SUPPORTED** | no fetch exists |
| Twitch channel / **subscriber** | **NOT SUPPORTED** | no fetch exists |
| BTTV | **NOT SUPPORTED** | no code |
| FFZ | **NOT SUPPORTED** | no code |

**Twitch subscriber emotes should not be expected to work.** `EmoteProvider`
includes `'twitch'` and `externalEmoteUrl` can build a `static-cdn.jtvnw.net`
URL, so a message carrying one would *render* — but nothing ever produces one,
because no catalog layer fetches Twitch emotes. Doing so needs Helix
`chat/emotes` (global/channel) and, for subscriber sets, `chat/emotes/user` with
a **viewer-authorized user token** — a token the extension deliberately does not
hold, since provider tokens must never reach the page. That is a roadmap item,
not a side effect of this checkpoint.

## 11. Diagnostics

`kickbackSession.why()` in the worker console, development and beta only, on the
same build-time constant the metadata probe uses. It answers the question this
checkpoint kept having to answer by reasoning:

```
destination · sessionChannel · presenceReported
peerIds · memberIds · sessionAvailable
roomChannel · roomPending
liveWatchChannel · live · messages · unread
```

Counts, ids we already hold locally, and our own machine state. No tokens, no
message bodies, no metadata beyond the live word the card already shows.

## 12. Tests

**1585 passed.** New and rewritten:

- `socialViewing.test.ts` — the two rules, and what each must **not** do:
  `canSessionForm`'s body is asserted to contain neither `metadata` nor `live`;
  the live question is asked in exactly one place.
- `sessionStability.test.ts` — a session outlives the broadcast; availability is
  presence-or-server; the worker exposes `sessionPeers()`; no lone emote above
  the composer.
- `testlab/together.test.tsx` — the offline block inverted: a room **forms** on
  an ended stream and when Twitch has not answered, survives LIVE→OFFLINE with
  the people unchanged, and still ends when the **people** go.
- `togetherRender.test.tsx` — a single emote renders **nothing** on the card; a
  combo renders one compact `.kb-gravity-combo`.

**Browser gate** additionally drives: the offline preset opening a working
session with a composer and no LIVE badge; a lone emote reaching neither the
card nor the composer area; the combo appearing in `.kb-gravity-status`, not on
the left, under 70px, and gone after 8.5 s.

`tests/db` **not run** — no DB, RPC or schema change. The mutation verifier was
**not** run.

## 13. Migration / deployment

**None.** 0020 and 0021 untouched. Every fix was client-side: the server already
allowed offline rooms and already authorizes recipients itself.

Reload the extension.

## 14. Exact manual retest

**Arrival**
1. A opens a LIVE streamer X. B is on Y.
2. B navigates to X.
3. A shows B HERE and "1 friend watching with you".
4. **Without refreshing A**: the contextual X tab appears promptly. *(§1)*

**Chat**
5. Both open the session. Text A→B, then B→A.
6. Send a 7TV channel emote from the picker → artwork appears **once** in the
   timeline, and **nothing** above the composer. *(§9)*

**Combo**
7. A sends emote X → the card shows **nothing**. *(§7)*
8. B sends the same X → session shows ×2, and the card shows a compact `X ×2`
   on the **right**, beside LIVE and the viewer count. *(§8)*
9. Wait ~8 s → the card's preview disappears completely.

**Departure**
10. B navigates X → Y. **Without refreshing A**: A's X tab disappears promptly.
11. B returns Y → X. **Without refreshing A**: the tab reappears, **not**
    selected.

**Offline**
12. With A and B still together, use an offline channel (or wait for X to end).
    → tab **remains**, session **remains**, chat still works, card says OFFLINE,
    no LIVE badge, and no shared-watch time accrues. *(§5)*

**Mute**
13. Mute B from their UserCard → messages and emotes hidden for A only, and A's
    combo count drops. Unmute from the account card.

**If anything above fails**, open the extension's service-worker console and run
`kickbackSession.why()` — it will say which of presence, membership, the request
or live status disagrees.

## 15. Deferred, unchanged

Block/unblock remains **P1B and a gate** before this opens past controlled
testing. Pre-JOIN previews, Growth, Twitch/BTTV/FFZ emote providers, transcripts
and room records all still deferred.
