# Contextual Stream Session — architecture

**Date:** 2026-08-24
**Status:** design only. No production code, no migration, no commit.
**Supersedes the UX of:** [automatic-stream-room-ux.md](automatic-stream-room-ux.md)
**Keeps:** the connected-component membership model (migration 0020) and the
shared live-eligibility rule (`src/core/socialViewing.ts`).

---

## 0. What real use showed

The Room works and does not justify itself.

Two findings, and they are related:

**It costs the radar.** Opening the room replaces the Friends body. Kickback's
primary surface — "where are my people right now" — is the thing you gave up to
look at four names and five buttons. Nothing in the room was worth that trade,
so the room got opened once and never again.

**It has nothing to do.** A roster plus reactions is a presence list with
buttons. The no-text decision was made to avoid building a second GroupChat,
which was the right *fear* and the wrong *conclusion*: what makes a room a place
is that something is being said in it. Reactions are punctuation for a
conversation that was never there.

The fix is not more room. It is: put the session **beside** Friends rather than
on top of it, and give it a reason to exist.

---

## 1. Recommended navigation

A third tab, present only while there is a session to be in, labelled with the
streamer.

```
No eligible room:      Friends │ Groups
Eligible room:         Friends │ TheBurntPeanut │ Groups
```

`type Tab = 'friends' | 'groups' | 'session'`.

**Label** is the authoritative Twitch display name via `useChannelName()` —
`TheBurntPeanut`, not `theburntpeanut`. Falls back to the login when metadata
has not supplied casing, which is what every other channel label already does.

**Truncation** is CSS, not string slicing: `max-width: 92px; overflow: hidden;
text-overflow: ellipsis; white-space: nowrap`, with the full name in `title=`.
The tab bar already has `.kb-header-spacer` and a `+ Add` button competing for
width at a 260px minimum panel; the session tab takes the remainder and yields
first. The full name is the heading **inside** the tab, where there is room for
it.

**No "Room", no "Together", no "Chat" in the label.** The streamer's name in the
tab bar between Friends and Groups already says what it is: the place where the
people watching this are. Adding a noun would make it a feature name.

### Why the streamer tab and not a view

| | Dedicated view (today) | Contextual tab (proposed) |
|---|---|---|
| Radar | replaced | always one click away |
| Getting back | Back button | tab, same as Groups |
| Discoverability | only from the HERE card | visible whenever it exists |
| Mental model | "I navigated somewhere" | "there is a place, it is open" |
| Refresh | selection lost | selection restorable (§4) |
| Unread | impossible — nothing to badge | a tab can carry a count |

The tab is also what makes ephemeral chat viable at all. A conversation you have
to *navigate away from the map* to read is a conversation you will not read.

---

## 2. Session lifecycle

The tab exists **iff** the worker has a server-confirmed room for the viewer's
effective destination. That is exactly today's condition — `roomMembers.length >
0` — which already implies live eligibility, presence, and the caller being
present, because `stream_room_members` refuses otherwise.

- **Appears** when membership resolves non-empty. **Never auto-selects.** A tab
  appearing must not move the user's feet.
- **Selected** by clicking it, or by the `ROOM` affordance on the HERE card,
  which becomes `setTab('session')` rather than a navigation.
- **Disappears** when membership empties. If the user was on Friends or Groups,
  it simply goes. If it was selected, fall back to `'friends'` — derived, not
  imperative, so there is no frame where a session tab is selected and absent:

```ts
const sessionAvailable = view.roomMembers.length > 0 && view.channel !== null
const tab = requestedTab === 'session' && !sessionAvailable ? 'friends' : requestedTab
```

The same derivation the current `roomOpen` uses, moved up a level. No empty room
view is reachable, because "selected" is never stored as truth.

---

## 3. Refresh continuity

**What is persisted:** one record, in `chrome.storage.local`, alongside
`kickback:channelMetadata` and `kickback:collapsed`.

```ts
// kickback:sessionTab
{ channel: string /* canonical login */, selectedAt: number /* epoch ms */ }
```

**Where:** the worker, not the panel. The panel is torn down on every Twitch
navigation; the worker is the thing that survives, and it already owns
`roomMembers` and `channelMetadata`. It broadcasts `sessionRestore: boolean` in
`KickbackState`, and the panel uses it once, on mount.

**When written:** when the user *selects* the session tab — the intent, not the
existence. Overwritten on channel change. **Deleted** when the user selects
Friends or Groups, so leaving is remembered as leaving.

**When it expires:** on read, if any of these fail, the record is deleted and
the panel opens on Friends —

1. `record.channel === socialChannel()` — same canonical destination, which by
   construction means still live and still eligible;
2. `roomMembers.length > 0` — a room still exists;
3. `now - selectedAt < 12h` — a bound so a forgotten key cannot resurface after
   a weekend.

Conditions 1 and 2 are what prevent a stale record reopening an *unrelated*
room: the channel must match the one the viewer is on right now, and the server
must have confirmed a component on it. Condition 3 is belt and braces.

**No database record.** Nothing about a room needs to be persistent for this;
the only durable fact is "this browser's user chose to open the session on
`lirik` at time T", which is local, small, and self-cleaning. This is
deliberately weaker than a room id — it cannot be used to rejoin anything.

**Restore is not instant, and should not pretend to be.** After a refresh the
chain is: presence written (~1s, §fix d9b2f33) → metadata (cached, ~0) →
membership (~1 round trip). Expect the tab to appear and select itself within
**1–2 seconds**. Until then the panel shows Friends. Do not show a placeholder
session tab; a tab that appears and then vanishes is worse than one that appears
late.

---

## 4. Ephemeral chat

Yes. The roster-and-reactions room was tested and is too shallow; text is what
makes "watching together" into something you are doing rather than something you
are told.

**What it is:** the conversation among the people watching this stream with you,
right now, which stops existing when that stops being true.

**What it is not:** GroupChat. No transcript, no history, no scrollback beyond
the retention window, no read receipts, no threading, no editing, no deletion UI
(there is nothing durable to delete), no unread that accrues for days.

**Contents:** text, Kickback emotes, external emotes from the existing catalog,
reactions, combos, combo breakers, sender identity opening a UserCard.

**One combo model, extended.** `scanCombos` already treats an emote-only message
as an emote contribution — that is how group chat combos work. So in a session,
**reactions and emote-only messages feed the same combo stream**, ordered by
time. There is no second engine and no second currency; a reaction is simply the
fastest way to send an emote-only message. Combo breakers now have something to
fire on for the first time: an ordinary text message ending a run is exactly the
case `COMBO_BREAKER_THRESHOLD` was written for, and it becomes live here without
a line of new combo logic.

---

## 5. Retention — three lifetimes, deliberately different

The brief asks whether delivery, storage and display should differ. They should,
and conflating them is how this gets expensive.

| | Value | Owned by | Why |
|---|---|---|---|
| **Delivery authorization** | instant, at send | server RPC | recipients are fixed when the message is written; see §6 |
| **Storage / retention** | **30 minutes**, capped at **200 rows per recipient per channel** | server sweep | enough to survive refresh and a break; short enough that nobody treats it as history |
| **Client display window** | everything retained, rendered to the last 100 | panel | what you can scroll is what still exists |
| **Activity preview window** | **8 seconds** (`REACTION_TTL_MS`) | `roomActivity()` | "this is happening right now" — §9 |

**Why 30 minutes.** It is the brief's candidate and it survives audit. The
things it must cover: a page refresh (seconds), a worker eviction (minutes), an
ad break (~3 min), stepping away (~10 min). Thirty minutes covers all of them
with margin. Going shorter (15 min) saves storage that the row cap already
bounds; going longer starts to feel like a log.

**Why the row cap matters more than the clock.** Retention cost is
`messages × recipients`, and recipients can be 51. Worst case at 30 minutes with
no cap, in a maximal room, is order 10⁵ rows for one channel. The cap makes the
worst case `200 × 51 ≈ 10⁴` rows per channel regardless of how fast people type,
and it is what makes the time window safe to state generously.

**Deletion** rides the existing pattern: every insert sweeps rows on that channel
older than the window, so cleanup touches only channels somebody is actively
using and needs no `pg_cron`. Add a nightly full sweep only if beta shows
abandoned channels accumulating.

---

## 6. Merge / split semantics

**Recommended, and it is the brief's candidate:** authorize at send time,
materialize recipients, never backfill.

```
send → server verifies sender is eligible (live + present)
     → server computes sender's component NOW
     → server writes one row per recipient (component + sender)
     → each client reads only rows addressed to it
```

### The scenarios

**`A ↔ B ↔ C`, B leaves → `A` `C`**

- Already-delivered messages: **kept** until TTL, by both. A said something to C
  while C was authorized; you cannot un-send, and deleting on split would make
  the conversation flicker as presence wobbled.
- New messages: **no cross-delivery.** A's next message computes a component
  that no longer contains C, so no row is written for C. Nothing to filter
  client-side; the row does not exist.
- The split is **not instantaneous**: B's departure is observed through presence
  (immediate on an explicit offline write, up to 90 s on a dropped client). For
  up to 90 s after a hard disconnect, A and C are still one component. This
  matches every other presence-derived behaviour in Kickback and should not be
  special-cased.

**`A ↔ B` and `C ↔ D` merge via `B ↔ C`**

- C and D receive **nothing** historical. They were not authorized when those
  messages were written, and there is no row addressed to them. This is secure
  *by construction* rather than by a filter — the authorization decision was
  materialized, so there is no query that could accidentally re-evaluate it
  permissively.
- Future messages fan out to the merged component.
- This is also the intuitive behaviour: you walked in, you hear what is said
  from now on.

### Why this beats persistent room identity

A `room_id` would require deciding what happens to it on split (does it follow A
or C?) and on merge (which id survives?), storing membership, and reconciling a
stored answer against presence that already changed. Every one of those is a
second source of truth about a fact presence already owns. The materialized-
recipient model has no such questions: there is no room object to have an
opinion about.

### The one coherence wrinkle to document

Components at a bounded hop count are **not equivalence classes**. With
`A ↔ B ↔ C ↔ D ↔ E` and `MAX_HOPS = 3`:

- A's room: B, C, D. D's room: C, B, A, E.
- D's message reaches A **and** E. E's message reaches D but not A.
- So A can see a reply without seeing what it replied to.

This is inherent to bounded traversal and is already true of the roster; text
makes it visible. At realistic sizes (2–6 people, one or two hops) it does not
occur. **Recommendation: accept it for v1 and do not paper over it.** The
alternative — collapsing to a true equivalence class — either removes the hop
bound (unbounded fan-out, unbounded exposure) or forces a room object. Revisit
only if beta produces a real five-hop chain, which would be a good problem.

---

## 7. Message transport

**Recommendation: generalize the per-recipient fan-out.** Not because reactions
use it, but because the two credible alternatives are both already disqualified.

### Rejected: one row, read-time RLS

This is what 0019 did for reactions. It fails on hosted Supabase: when several
realtime subscriptions match a single row, only the most recently created one
receives it ([supabase/realtime#1524](https://github.com/supabase/realtime/issues/1524)).
That is precisely the one-direction reaction bug that 0020 fixed by fanning out.
Text would reproduce it exactly, and more visibly.

### Rejected: broadcast channel keyed by channel

`twitch:lirik` as a broadcast topic delivers every Kickback user's messages to
every other Kickback user on that channel — forty thousand strangers on a big
stream — with authorization done client-side. Not a candidate.

### Rejected: envelope (body table + recipient table)

Storage-optimal: one body, N tiny pointers. But realtime would deliver the
pointer, and the client would need a follow-up query per message to fetch the
body — a round trip per message, on the latency path of a live conversation.
Publishing the *body* table via realtime instead puts us back on read-time RLS
and the defect above. The storage it saves is bounded by §5's row cap anyway.

### Recommended shape

```sql
create table public.room_messages (
  id           uuid primary key default gen_random_uuid(),
  recipient_id uuid not null references public.users(id) on delete cascade,
  sender_id    uuid not null references public.users(id) on delete cascade,
  channel      text not null check (channel ~ '^[a-z0-9_]{3,25}$'),
  body         text not null check (length(body) between 1 and 280),
  created_at   timestamptz not null default now()
);
create index room_messages_inbox_idx
  on public.room_messages (recipient_id, channel, created_at desc);
```

RLS: `select` where `recipient_id = (select auth.uid())`. No client `insert`.
Realtime: same per-user topic as reactions, `recipient_id=eq.<uid>`.

`send_room_message(p_channel, p_body)`: `SECURITY DEFINER`, actor from
`require_actor()` so there is no sender parameter to spoof; validates channel
regex and body length; requires the caller's own live presence on the channel;
consumes a rate budget; fans out via `stream_room_members` plus a self-row;
sweeps the channel's expired rows on the way past.

### The analysis the brief asked for

- **Volume.** 280 chars × 51 recipients ≈ 14 KB per message worst case. At the
  recommended 20 msg/min budget, a maximal room is ~280 KB/min, bounded at rest
  by the 200-row cap. Realistic rooms are three orders of magnitude smaller.
- **Subscriptions.** Unchanged: one per user, already open for reactions. The
  same channel should carry both tables rather than opening a second socket.
- **Ordering.** `created_at` from the server, so every client orders identically
  — the same rule `scanCombos` already depends on. Ties broken by `id`.
- **Deduplication.** Realtime can redeliver; fold by `id`, as
  `withReaction` already does.
- **Refresh recovery.** One `select` on the inbox index, bounded by the display
  window. This is the capability reactions deliberately lack, and it is why the
  table needs an index reactions were explicitly denied.
- **Sender's own copy.** A self-row, exactly as reactions do. One code path for
  a message appearing, so a sender cannot see a message the server did not
  accept.
- **Cluster size.** Bounded at 50 by `stream_room_members`; the RPC should
  refuse rather than truncate if that is ever exceeded.
- **Abuse.** Rate budget `('room_message', 20, '1 minute')`; 280-char cap; body
  is text and never markup — `parseMessage` renders React nodes, never HTML;
  fan-out is server-computed so no one can address a stranger.
- **Retention.** §5.

**Rate limit note:** the reaction budget (60/min) and the message budget should
be **separate**, so hammering emotes cannot silence someone's typing.

---

## 8. Reuse from GroupChat

Extract, do not fork. `GroupChat.tsx` is 348 lines and most of it is not about
groups.

| Piece | Action |
|---|---|
| `MessageBody` (parseMessage → React nodes, emote-only sizing) | **extract** to `components/MessageBody.tsx`, use in both |
| `ComboBadge`, `ActiveComboBar`, `.kb-combo-*` | **extract** to `components/Combo.tsx` |
| Message row markup (`.kb-msg`, `.kb-msg-head`, `.kb-msg-sep`) | **extract** as `MessageList`, taking messages + annotations |
| Composer (`.kb-composer`, `EmotePicker`, Enter-to-send, length cap) | **extract** as `Composer`, parameterised by max length and `onSend` |
| `scanCombos`, `annotateCombos`, `activeCombo` | **already shared** — no change |
| `UserCard` + `UserCardContext` | **already shared** — no change |
| Scroll-to-end on new message | moves with `MessageList` |
| Combo analytics de-duplication (`reportedComboRef`, `seenBreaksRef`) | **extract** — the "seed on first pass" rule is subtle and must not be reimplemented |
| Group membership, `group_messages`, `markGroupRead`, invites, roles | **do not reuse** |

**Explicitly not reused:** `group_messages`. Storing session messages there for
convenience would give ephemeral conversation permanent-transcript persistence,
group RLS, and group unread semantics — three wrong answers for one saved table.

`ChatMessage` currently carries `groupId`. Generalise to a `Message` shape with
an optional source discriminator, or give the session its own type and have
`MessageList` take the minimum it needs (`id`, `userId`, `displayName`,
`avatarUrl`, `body`, `createdAt`). **Prefer the latter** — the presentational
components should not know what a group is.

---

## 9. Proposed UI hierarchy

Conversation is the reason the surface exists, so it gets the vertical space.

```
┌──────────────────────────────────────────┐
│ Friends │ TheBurntPeanut 2 │ Groups  +Add│
├──────────────────────────────────────────┤
│ TheBurntPeanut                           │  destination identity
│ ● LIVE · Escape from Tarkov · 18K        │  (● red — §17)
│ WATCHING TOGETHER · 4                    │
│ ◕◕◕◕  ›                                  │  participants: avatar row, tap to expand
├──────────────────────────────────────────┤
│ Jake   holy shit                         │
│ Sarah  LMAO                              │  ← the majority of the height
│ You    😂                                │
│                            😂 ×4         │
├──────────────────────────────────────────┤
│ Message…                            [😀] │
└──────────────────────────────────────────┘
```

- **Participants collapse to an avatar row** (`Avatar` at 20px, `showDot=false`,
  overlapped like `.kb-avatar-stack` in the HERE banner) with a count. Expanding
  reveals the current list with `Friend of X` context and UserCards. Today's full
  list consumes a third of the panel to answer a question asked once.
- **Header** reuses `.kb-detail-head` geometry minus the back button — the tab
  is the way out now.
- **Messages** reuse the extracted `MessageList` verbatim, so a session message
  and a group message are visually the same object, because they are.
- **Composer** is the extracted one, at 280 chars.
- The **active combo bar** sits where it does in group chat: anchored above the
  composer, not inline in the log.

No new visual language. Everything above already exists in `kickback.css`.

---

## 10. Combo / activity preview on HERE

Unchanged in semantics, and the **8-second window stays**.

The question is whether text changes it. It does not: the preview says "this is
happening right now", and eight seconds is what "now" means for a reaction that
landed while you were looking at the video. Lengthening it to cover a slower
chat rhythm would turn it into "recently", which is the thing §12 forbids.

What *does* change is the input. With emote-only messages contributing to
combos, the preview's source becomes **reactions plus emote-only messages within
the last 8 seconds** — one stream, `roomActivity()` unchanged in shape, given a
merged and time-filtered list. Ordinary text never contributes and never leaks;
the preview can only ever render an emote and a number.

This is the concrete reason §5 separates the display window from retention: the
room shows 30 minutes, the preview shows 8 seconds, and they read the same
underlying list.

`REACTION_TTL_MS` should be renamed `ACTIVITY_TTL_MS` when this lands, since it
now governs both.

---

## 11. Pre-JOIN preview — the path, not the implementation

**Not in the next checkpoint.** Designing so we do not foreclose it:

**What could be exposed:** an aggregate only — `{ channel, emote, count }`. No
message id, no body, no sender, no participant list, no timestamp.

**Who could receive it:** the sender's **direct friends who are not on the
channel**. Not friends-of-friends: someone two hops away has no Gravity card for
this destination and no reason to be told anything about it.

**What must never leak:** identities of anyone the recipient cannot already see;
any message body or emote-only message *content* beyond the emote itself; the
existence of a room the recipient is not entitled to know about. A direct friend
already sees "LIRIK · 4 · Jake + 3 others" from presence, so the combo adds a
signal, not a subject.

**Does the architecture support it:** yes, additively. Recipients are computed
server-side inside one RPC. Adding a second recipient set — direct friends off
the channel, receiving an aggregate row on a separate ephemeral table with its
own short TTL — is a new fan-out branch, not a new architecture.

**The constraint to hold now:** never let the client choose recipients, and
never put a message body on the same row as an activity aggregate. Both are
already true and must stay true.

---

## 12. Unread

**Model:** one persisted watermark per channel, unread derived from it.

```ts
// kickback:sessionRead  →  { [channel]: lastSeenAtMs }
```

- **Count** = retained messages on the channel with `createdAt > lastSeenAt`
  **and** `senderId !== selfId`. Own messages cannot increment because they are
  filtered from the count, not because sending also marks read.
- **Cleared** by having the session tab selected — write `lastSeenAt = now()` on
  select and on each new message while selected.
- **Survives rerender**: derived from worker state, not component state.
- **Survives refresh**: yes, and it should. The messages themselves survive
  (§5), so unread that reset would claim you had read something you had not. The
  watermark is one number per channel in `chrome.storage.local`, pruned with the
  same 12-hour bound as `kickback:sessionTab`.
- **Cap** at `9+`.
- **Reactions and combos do not increment it.** They are ephemeral activity, not
  things to catch up on. If the tab should signal them, use a **transient dot**
  that follows the same 8-second activity TTL and disappears on its own — never
  a number that accrues.

**Tab treatment:** `TheBurntPe… 2`, reusing `.kb-tab-count` / `.kb-tab-badge`
which Groups already has. Nothing else on the tab. The HERE card remains the
richer preview; the tab says only "something was said".

**No OS notifications** for session messages. The existing gathering
notification is a separate thing and stays as it is.

---

## 13. Mute

**Local, personal, silent, reversible.**

| Question | Answer |
|---|---|
| Where does it live? | `chrome.storage.local` → `kickback:mutedUsers: string[]`, held in the worker, broadcast in `KickbackState` |
| Server involvement? | **None.** No table, no RPC, no migration |
| Does the muted person know? | No. No signal of any kind |
| Can they still participate? | Yes, fully, for everyone else |
| Does it affect friendship? | No |
| Does it affect presence, Gravity, HERE? | **No.** A muted friend still appears on the map. Mute is about noise in the session, not about hiding a person |
| Does it affect Groups? | Yes — same local filter, same list. One mute, everywhere it means "quieter" |

**What is suppressed:** their session messages, their reactions, and **their
contribution to combo counts you see**. The last one is the non-obvious call: a
muted person still inflating a `×6` in your panel is still them getting your
attention. The cost is that two viewers can see different counts for the same
moment — unavoidable for any local mute, and preferable to a mute that half
works.

**Entry point:** `UserCard`, which is already the one place every person-level
action lives (remove friend, JOIN). **Management:** a "Muted" list in the
account card, which is the discoverable place to reverse it. A mute you cannot
find is a mute you cannot undo.

**Ships with:** ephemeral chat, phase 1. It is cheap, it is entirely local, and
it is the minimum civility control for a surface where people can type.

---

## 14. Block

**Server-side, graph-affecting, and not a display filter.**

Recommended semantics, `A blocks C`:

| Surface | Effect |
|---|---|
| `blocks` table | row `(blocker_id, blocked_id)`, RLS: only the blocker reads their own |
| Friendship | **removed** if present, both rows |
| Friend requests | refused in **both** directions while the block stands |
| Presence | follows from friendship removal — global presence RLS is friendship-based, so neither sees the other |
| Social Gravity, HERE | follows presence |
| Room traversal | `stream_room_members` **must not traverse into or through** anyone in a block relation with the seed |
| Message / reaction delivery | follows automatically — recipients come from the same walk |
| Groups | see open decision D5 |
| Analytics | a `user_blocked` event; blocked pairs cannot appear in co-presence attribution because they are no longer friends |

### The bridge question

`A ↔ B ↔ C`, A blocks C. **B must not bridge them.**

The walk is seeded at the caller, so the filter is seed-relative:

```
and not exists (
  select 1 from public.blocks b
   where (b.blocker_id = v_actor and b.blocked_id = f.friend_id)
      or (b.blocker_id = f.friend_id and b.blocked_id = v_actor)
)
```

Applied to each candidate as it is admitted. Consequence: A's room excludes C;
C's room excludes A; **B's room contains both.** That asymmetry is correct — B
has blocked nobody — and it is the same asymmetry the hop bound already
produces (§6). It does mean B sees a conversation that A and C each see half of;
that is the honest outcome of a local social graph and the alternative
(dissolving B's room) punishes an uninvolved person.

Crucially the filter must exclude blocked users from being **traversed through**,
not merely from the result set — otherwise A could reach D via C and learn that
C is present from the `Friend of C` context.

**Client filtering alone is not acceptable.** A blocked person must not be able
to have rows written addressed to the blocker, because rows are evidence; and a
modified client must not be able to render what the server declined to hide.

### When it must ship

**Before broader testers, and it is a hard gate.** The reasoning is specific to
this product: connected components reach three hops, so a user can be in a room
with someone they have never met and did not choose. That is the feature. The
moment that room also carries text, "I never chose this person and they are
typing at me" becomes reachable, and mute is not a sufficient answer when the
person can also see you.

- **Private beta with trusted testers, chat on:** mute is enough.
- **Broader testers / anyone invites anyone:** block required.
- **Public beta:** block required, plus a reporting path (out of scope here).

---

## 15. Safety and privacy

Unchanged invariants, restated because text is the first thing that could break
them:

- Recipients are **always** server-computed. No client-supplied recipient,
  sender, or channel is trusted.
- Message bodies are rendered as React text and emote components, never as
  markup — `parseMessage` already guarantees this and is shared.
- No message content ever leaves the session surface. The HERE preview carries
  an emote and an integer; the tab carries an integer.
- A stranger on the same channel receives nothing, because no row is addressed
  to them.
- Global presence RLS is untouched. Nothing here lets a client enumerate the
  graph: `stream_room_members` returns members, never edges, and only for a
  channel the caller is provably on.
- Retention is bounded in two dimensions (time and rows) and swept on write.
- Rate budgets are per-action, so one action cannot exhaust another.
- Analytics records **no message bodies**, only length buckets and a has-emote
  flag — the same contract `group_message_sent` already meets.

---

## 16. Live eligibility

**No change, no regression.** `canWatchTogether` remains the single rule: a
session requires authoritative `live`, `unknown` is not eligible, and stale
metadata degrades to `unknown` via `liveStateOf`. Raw presence still knows a
user is on an offline channel page and the HERE card still says OFFLINE.

The session tab inherits this for free: it exists iff membership exists, and
membership is only ever fetched for an eligible channel.

**Multiple Twitch tabs (§20):** the session follows `socialChannel()`, which is
derived from `tabActivity.effective()` — the existing single-effective-
destination rule. One viewer, one effective destination, **at most one session
tab**, regardless of how many Twitch tabs are open. Nothing new is needed;
the requirement is simply that no session state is ever keyed on a `Port`.

---

## 17. Lifecycle table

Concrete enough to write tests from.

| Event | Tab | Selection | Delivery | Retained msgs | Unread | Combo | Analytics |
|---|---|---|---|---|---|---|---|
| First eligible friend arrives | appears | unchanged | opens | — | 0 | — | `automatic_room_entered` |
| User selects the tab | present | `session` | — | rendered | cleared | — | `automatic_room_opened{source:'tab'}` |
| ROOM on HERE card clicked | present | `session` | — | rendered | cleared | — | `automatic_room_opened{source:'here_card'}` |
| Message sent | present | unchanged | fan-out now | +1 | not incremented (own) | may break a run | `automatic_room_message_sent` |
| Message received, tab not selected | present | unchanged | — | +1 | +1 | — | — |
| Reaction sent/received | present | unchanged | fan-out now | n/a | **unchanged** | may extend a run | `automatic_room_reaction` |
| Combo reaches 2 | present | unchanged | — | — | — | shown in room **and** on HERE | `automatic_room_combo` |
| 8 s with no activity | present | unchanged | — | kept | kept | **preview vanishes** | — |
| Twitch refresh | reappears in 1–2 s | restored if §3 passes | resubscribes | re-read from inbox | derived from watermark | reset (nothing live) | `automatic_room_opened{source:'restored'}` |
| Member's presence goes stale (<90 s) | present | unchanged | still fans out to them | kept | — | — | — |
| Member returns | present | unchanged | unchanged | kept | — | — | — |
| Member leaves for good | present | unchanged | stops for them | **both sides keep** delivered | — | — | — |
| Component splits | present | unchanged | no cross-delivery for new msgs | kept until TTL | — | — | — |
| Components merge | present | unchanged | future msgs to all | **no backfill** for newcomers | — | — | — |
| Last friend leaves | **disappears** | → `friends` | closes | kept until TTL | cleared | cleared | `watching_together_ended` |
| Stream goes offline | **disappears** | → `friends` | closes | kept until TTL | cleared | cleared | `watching_together_ended` |
| Viewer changes streamer | disappears, may reappear for the new channel | → `friends`, `sessionTab` rewritten | rebinds | previous channel's kept until TTL | per channel | cleared | `watching_together_ended` / `_started` |
| Browser closes | — | — | closes | kept until TTL | persisted | — | shutdown path unchanged |
| Browser reopens, same live channel, room re-forms | appears | restored if §3 passes | reopens | re-read | derived | — | `automatic_room_entered` |
| Browser reopens, channel now offline | absent | `friends`, record deleted | none | swept | cleared | — | — |
| Worker evicted mid-session | — | — | resubscribes on wake | re-read from inbox | derived from watermark | cleared | existing `togetherStore` rules |

---

## 18. Analytics plan

**Do not implement in this checkpoint.** The minimum that answers "does the
contextual session make watching together more valuable":

**One new event.**

| Event | Properties | Why |
|---|---|---|
| `automatic_room_message_sent` | `length_bucket`, `has_emote`, `participant_count` | the interaction that did not exist before. Mirrors `group_message_sent` exactly — no bodies |

**Two new property values, no new events.**

- `automatic_room_opened` gains `source: 'here_card' | 'tab' | 'restored'` —
  answers "does the tab get opened on its own, or only from the card", which is
  the whole navigation bet.
- `friend_request_sent` gains `source: 'stream_room'` — relationship formation
  attributable to a session, without a bespoke event.

**Deliberately not added:**

- `room_available` — `automatic_room_entered` already is this.
- `combo_participated` — `automatic_room_combo` already is this.
- shared-watch duration after interaction — `watching_together_started/_ended`
  already measure the interval; the join is `automatic_room_message_sent` inside
  it. A second measurement would be a second chance to disagree.
- `streamer_tab_opened` — that is `automatic_room_opened{source:'tab'}`.

**The funnel** is then queryable end to end with one new name:

```
gravity_cluster_impression → join_clicked → join_arrived
  → automatic_room_entered → automatic_room_opened
  → automatic_room_message_sent | _reaction
  → watching_together_ended (duration)
  → friend_request_sent{source:'stream_room'}
```

---

## 19. Implementation phases

**Phase 1 — contextual session with chat.** One migration.
Tab + eligibility-derived selection · refresh continuity (`kickback:sessionTab`)
· `room_messages` + `send_room_message` + realtime + sweep · extracted
`MessageBody`/`MessageList`/`Composer`/`Combo` · session layout · unread
watermark · merged combo input · mute (local) · analytics contract · red LIVE
dot (§17 of the brief, folded in here).

**Phase 2 — block.** One migration. `blocks` table · traversal filter in
`stream_room_members` · friendship removal and request refusal · blocked-users
management UI. **Gate: required before broader testers.**

**Phase 3 — pre-JOIN activity preview.** One migration, only if approved.
Second fan-out branch, aggregate-only rows, direct friends off-channel.

Growth remains deferred.

### Migration requirements

| Phase | Migration | Contents |
|---|---|---|
| 1 | `0021_room_messages.sql` | table + index + RLS + grants + `send_room_message` + realtime publication guard + rate budget + analytics event name and property updates |
| 2 | `0022_blocks.sql` | `blocks` table + RLS + block/unblock RPCs + `drop`/recreate `stream_room_members` with the traversal filter + friendship/request changes |
| 3 | `0023_room_activity_preview.sql` | aggregate table + second fan-out branch |

0020 is deployed and is **not** modified. Phase 2 must `DROP FUNCTION` before
recreating `stream_room_members` if its signature changes — the 42P13 lesson —
and every file stays wrapped in `begin;`/`commit;`. `tests/db` runs on all three.

---

## 20. Open product decisions

**D1 — Retention window.**
Alternatives: 15 min · **30 min** · session-lifetime.
**Recommend 30 minutes plus a 200-row-per-recipient-per-channel cap.** It covers
refresh, eviction, ad breaks and short absences; the row cap is what actually
bounds worst-case storage, which makes the generous clock safe. Session-lifetime
becomes a transcript. **Does not block implementation** — it is a constant.

**D2 — Does unread survive a Twitch refresh?**
Alternatives: **yes, via a persisted watermark** · no, worker-memory only.
**Recommend yes.** The messages survive, so unread that reset would claim you
had read something you had not. Cost is one number per channel in local storage.
**Does not block.**

**D3 — Do emote-only messages feed the same combo stream as reactions?**
Alternatives: **yes, one stream** · separate.
**Recommend yes.** `scanCombos` already treats them identically in group chat,
and a reaction is just the fastest way to send an emote-only message. Separating
them would be a second combo model, which this project has already deleted once.
**Does not block**, but decide before building the preview.

**D4 — Do muted users still contribute to combo counts?**
Alternatives: **no, excluded** · yes, counted.
**Recommend excluded.** A muted person inflating a number in your panel is still
them getting your attention. Accept that two viewers may see different counts —
that is inherent to any local mute. **Does not block.**

**D5 — Does blocking someone remove a shared persistent Group?**
Alternatives: **no — hide their messages locally within shared groups** · remove
one of them from the group · forbid the block.
**Recommend the first for v1.** Groups are intentional structures with other
members; a block between two of them must not silently reshape a third person's
group. Revisit with real cases. **Blocks phase 2**, not phase 1.

**D6 — Session tab label when metadata has no display casing.**
Alternatives: **the bare login** · a placeholder · hide the tab until casing
arrives.
**Recommend the bare login**, which is what every other channel label already
falls back to. Hiding a working session because of cosmetics is worse.
**Does not block.**

**D7 — Should the session tab show a transient activity dot for reactions?**
Alternatives: **yes, an 8-second dot** · nothing · fold into the unread number.
**Recommend the dot**, matching the activity TTL so it cannot accrue. Folding
reactions into unread would make a number that never settles. **Does not block**
— it is additive and can land after phase 1 if the tab looks busy.

**D8 — Message body length cap.**
Alternatives: 500 (group parity) · **280**.
**Recommend 280.** It suits the medium, and it nearly halves the worst-case
fan-out storage that §5's cap is protecting against. **Does not block.**

**D9 — Accept non-equivalence-class rooms (§6 wrinkle)?**
Alternatives: **accept and document** · remove the hop bound · introduce room
identity.
**Recommend accept.** It does not occur at realistic sizes; the alternatives
cost either unbounded exposure or a persistent room object, both of which this
architecture exists to avoid. **Does not block.**

None of the nine blocks implementation. D1, D3 and D8 should be settled before
the first line of phase 1; the rest can be settled while building.

---

## 21. Recommendation

**Build phase 1.**

The connected-component backend is sound and stays. What was wrong was never the
model — it was that the room replaced the radar and then had nothing in it. The
tab fixes the first, ephemeral text fixes the second, and neither requires
inventing room identity, persistent membership, or a second combo engine.

Three things make this cheap: the fan-out transport already exists and
generalises to messages with one table and one RPC; the entire chat presentation
layer already exists in `GroupChat` and needs extraction rather than authorship;
and the eligibility rule that this all hangs from was settled last checkpoint and
does not move.

The one thing that must not slip is **block before broader testers**. Three-hop
components mean a user can end up in a room with someone they never chose; the
moment that room carries text, that stops being a nice property and starts being
a duty of care.
