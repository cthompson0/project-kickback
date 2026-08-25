# Automatic Stream Rooms — Convergence Architecture

**IMPLEMENTATION NOT STARTED — DECISION REQUIRED**

No production code was changed. The audit found a definitive, architectural root
cause for Bug A that means the current reaction transport **does not survive**
the convergence — so patching it now would be work thrown away, exactly as the
brief anticipated. It also surfaced one product decision I should not make
unilaterally.

The design below is complete and, once the decision in §0 is made, implementable
without further architecture work.

---

## 0. The decision I need

### Do automatic Stream Rooms have text?

Everything else in this document follows from the answer, because **room
identity, merge/split semantics and storage all exist only to serve chat
continuity.** Without text there is nothing to keep continuous.

| | **A — no text (recommended)** | **B — ephemeral text** | **C — reuse GroupChat** |
|---|---|---|---|
| Room = | a continuously recomputed view | a thing with an identity | a Group record |
| Identity needed | **none** | yes | group id |
| Merge/split | free — recomputation | a real UX question | a real UX question |
| New storage | one reaction table reshape | + messages table + sweep | none |
| Transcripts | none | bounded | **permanent** |
| Migrations | 1 | 2 | 1 + semantics change |

**I recommend A**, and would implement it immediately:

- `group_messages` has **no retention or sweep of any kind** — I checked. Reusing
  it (option C) would create permanent transcripts of ad-hoc gatherings between
  people who are not friends, which directly contradicts the ephemerality the
  brief has insisted on since the last checkpoint. I would not do this without
  you saying so explicitly.
- Option B is buildable but is what forces room identity into existence. The
  moment messages must survive a bridge user leaving, "which half is the room"
  becomes a question with materially different answers — which is one of your
  own STOP conditions.
- Under A there is no identity to argue about: the room is the connected
  component *right now*, membership is recomputed, merge and split are just
  recomputation, and reactions live eight seconds so continuity is a non-problem.

Rooms can gain text later without rework: it is additive to the membership
model, and by then we would know from analytics whether anyone opens the room at
all.

**Secondary, non-blocking recommendation** (§16 asked me to recommend, not
decide): before JOIN, Gravity names **only your direct friends** and counts the
rest — `🔥 LVNDMARK · 3 · Jake + 2 others`. Contextual visibility should be
earned by arriving, not by looking at a card.

---

## 1. What the previous implementation got wrong

Three things, in descending order of importance.

**It scoped the room to the viewer's direct friends.** You are right that this
is not a room. With `A ↔ B ↔ C ↔ D` all on one channel, A sees {B}, B sees
{A, C}, C sees {B, D}, D sees {C} — four people in four different rooms, none
of which is the gathering. Nobody can be shown a coherent participant list
because there is no coherent participant list to show.

**It chose the wrong realtime transport**, which is Bug A (see §12).

**It built a second combo system** instead of converging on the existing one,
which is Bug B (see §11).

What it got *right*, and should survive: participants derived from presence
rather than stored; canonical lowercase destination identity; the reaction as an
event model; write-time privacy inheritance; the HERE card as the surface rather
than a second card; no room creation ceremony.

---

## 2. Existing systems audited

### A. Persistent social system

| Piece | Shape |
|---|---|
| `groups`, `group_members`, `group_invites`, `group_messages` | intentional membership, owner, invites, **messages persist forever — no sweep** |
| `send_group_message` | `SECURITY DEFINER`, actor from `require_actor()`, 500-char cap, 30/min budget |
| `group_messages_select` policy | membership-scoped |
| `createSupabaseGroupChannel` | topic `kickback-groups:<userId>:<n>`, one binding per group |
| `GroupChat.tsx` | message list, emote rendering, `ComboBadge`, UserCards, unread |
| `scanCombos` / `annotateCombos` / `activeCombo` | runs of the same emote from *different* senders; `COMBO_MIN_DISPLAY = 2`; **combo breaker** at 3; annotates the run's last message in place |
| `GroupPresence` | `clusterMembers` roster with `here` / channel / browsing / offline |

### B. Social discovery

Presence (write-time redaction, 90s staleness, multi-tab effective activity) →
`clusterMembers` → `socialGravity` (ranking, HERE, opportunity keys) → `JoinButton`
→ `togetherWatch` lifecycle analytics → Twitch metadata as enrichment.

### C. New Automatic Together (0019)

`core/together.ts` (palette, bursts, TTL), `background/togetherReactions.ts`
(one subscription for the current channel), `createSupabaseTogetherChannel`,
`send_together_reaction`, `together_reactions` + RLS `is_friend`, the HERE
reaction strip, four analytics events, Test Lab presets.

---

## 3. Reuse / replace / adapt / separate

| Decision | Item | Why |
|---|---|---|
| **Reuse unchanged** | Presence, `clusterMembers`, Gravity, JOIN, metadata, `togetherWatch`, UserCards, `is_friend`, `require_actor`, `consume_rate_budget`, Test Lab | All correct and all load-bearing |
| **Reuse** | `scanCombos` / `ComboBadge` as the **one** combo engine | §11 |
| **Adapt** | `core/together.ts` — keep palette, TTL, parsing; delete `reactionBursts`/`isCombo` | Superseded by the existing combo engine |
| **Adapt** | HERE reaction strip → doorway that feeds the same event stream | §10 |
| **Adapt** | Analytics — rename to room vocabulary, keep the shape | §13 |
| **Replace** | `together_reactions` table, its RLS, `createSupabaseTogetherChannel` | §12 — the transport is the bug |
| **Replace** | Direct-friend participant scoping | §4 |
| **Keep separate** | Groups: tables, semantics, chat, ownership | An automatic room must never become a Group record |
| **Do not build** | A third room/chat/reaction stack | — |

---

## 4. Social-cluster model

> **Room = the connected component of the friendship graph, restricted to
> people whose presence says they are on this destination, right now.**

`A ↔ B ↔ C ↔ D` on `lvndmark` → one room of four. Unrelated `E` on `lvndmark` →
not in it. `A ↔ B` and `C ↔ D` with no edge → two rooms.

Membership is **computed, never stored**. It is a `SECURITY DEFINER` RPC:

```sql
-- Sketch. Returns ONLY the component containing the caller, and only if the
-- caller's own presence says they are on that channel.
create function public.stream_room_members(p_channel text)
returns table (user_id uuid, hops int)
-- recursive CTE over friendships ⋈ presence, seeded at auth.uid(),
-- bounded by max_hops and max_members
```

It returns **members, never edges**, never another component, and never anything
when the caller is not there. Everything presence already enforces — staleness,
write-time redaction, multi-tab, one-actor-per-user — is inherited, because the
traversal is over presence rows that were already filtered by those rules.

---

## 5. Friends-of-friends privacy

The rule: **the room grants contextual visibility; it does not grant presence
visibility.**

| A may learn | A may not learn |
|---|---|
| C is in *this* gathering on *this* channel, now | what C watches later |
| C's public identity (UserCard) | C's global presence |
| that C is connected via a real social path | C's friend list, or the path itself |

Enforced by construction:

- Global presence RLS is **unchanged**. No policy is loosened.
- The traversal is server-side. A client cannot ask for friends-of-friends
  generally — the RPC takes a channel, not a user, and seeds at `auth.uid()`.
- It refuses if the caller is not on that channel, so a channel name grants
  nothing.
- It returns a bounded set (see §16), so it cannot be used to enumerate.
- When you leave, the RPC returns nothing. Visibility ends with the gathering.

**Whether to show "Sarah — friend of Jake":** I recommend showing the connecting
friend, and only at one hop. It is what makes the person legible rather than a
stranger, and it reveals a single edge that Sarah's presence in the room already
implies. Beyond one hop, show nothing — "friend of a friend of Jake" is graph
detail nobody needs.

---

## 6. Room identity

**Under option A: there is none, deliberately.**

The room is a view, recomputed on every presence change, exactly as the HERE
cluster already is. No id, no record, no lifecycle, nothing to reconcile with
reality, and nothing to leak.

Identity only becomes necessary if something must persist *across* a membership
change — which is chat, and only chat. Hashing sorted member ids would be
actively wrong: membership changes constantly, so the room would be destroyed
and recreated every time somebody blinked.

Under option B, my recommendation would be a **channel-scoped room id minted on
first formation and retained by the largest surviving component on a split**,
with the smaller component starting fresh. But that is a decision, not a
derivation, which is why it is in §0.

---

## 7. Merge and split

Under option A these are not events. They are what recomputation looks like.

| Graph change | Result |
|---|---|
| `B ↔ C` friendship forms | next recomputation returns one component; both halves see everyone |
| Bridge `B` leaves the channel | `A` alone, `C ↔ D` together — two components, computed independently |
| Last person leaves | nothing to compute; no room |
| One participant remains | one member — the UI shows no room, matching today's HERE behaviour |

No animation, no ceremony, no "the room split" message. The participant list
changes, which is the signal.

Architecturally the important property is that **nothing assumes membership is
fixed**, which is satisfied trivially because nothing stores it.

---

## 8. Persistent vs automatic rooms

Unchanged from the last checkpoint and reaffirmed: shared *mechanisms* (realtime,
identity, authorization helpers, emote rendering, combo engine, UserCards),
different *product semantics*. Groups keep intentional membership, ownership,
persistence and history. Automatic rooms have none of those and must never be
written into `groups`.

Promotion ("turn this gathering into a group") stays a clean future move: a room
already knows a channel and a member set, which is `create_group` plus invites.

---

## 9. HERE / quick reactions

**Keep it.** It becomes the doorway, not the whole feature:

```
LVNDMARK
WATCHING TOGETHER · 4                    [OPEN ROOM]
You · Jake · Sarah · Matt
😂 ❤️ 🔥 😭 👀            😂 ×3
```

The strip and the room feed **one** event stream and **one** combo engine, so a
😂 pressed on the card and a 😂 pressed in the room are the same event. That is
only true if the transport is unified first — which is §12.

`OPEN ROOM` exposes the participant list with UserCards, the connecting friend
for one-hop participants, and the same reactions at a comfortable size.

---

## 10. Room interaction

Under option A: participants, identity, UserCards, reactions, combos, arrival
and departure through the participant list. No text, no unread, no history.

Arrival/departure stay implicit — the list changing is the signal. A line per
arrival is the notification spam the brief has warned about twice.

---

## 11. Combo convergence — Bug B root cause

**Root cause: I wrote a second combo system instead of reusing the one that
exists, and the two have different output shapes.**

- Existing (`scanCombos` + `ComboBadge`): walks a **timeline**, finds runs of the
  same emote from **different** senders, and annotates the run's last entry —
  so `×3` appears **in place**, on one item, and grows. It also implements a
  **combo breaker** at 3.
- Mine (`reactionBursts`): returns an **array of bursts** and the UI renders
  **every one of them side by side**. Three different reactions become three
  floating emoji in a row; that is the "stacking" you saw. There is no breaker.

The convergence: **delete `reactionBursts` and `isCombo`.** Model the reaction
stream as a timeline of `ComboMessage`-shaped entries and run `scanCombos` over
it, rendering with `ComboBadge`. Reactions then behave identically to chat
combos because they *are* chat combos, and the breaker comes for free.

One wrinkle to decide during implementation, not now: `scanCombos` keys on 7TV
`Emote` objects via `soleEmote`. Reactions are five fixed emoji. The clean fix is
to widen the combo engine's key from `emoteKey(emote)` to a string, which is a
small, well-tested change to a pure module — not a second engine.

---

## 12. One-direction reaction bug — root cause

**Root cause: `postgres_changes` is the wrong transport for a shared fan-out
stream, and the current design has two subscriptions matching the same row.**

Two contributing facts, both verified:

**1. The topic name breaks this codebase's own pattern.** Every pre-existing
realtime topic is unique per user:

```
kickback-social:<userId>
kickback-presence:<n>:<firstFriendId>     ← derived from the caller's own list
kickback-groups:<userId>:<n>
kickback-together:lvndmark                ← mine. IDENTICAL for every viewer.
```

**2. Supabase has a documented hosted-only defect** where, when multiple
subscriptions should both receive the same row, **only the most recently created
subscription does** ([supabase/realtime#1524](https://github.com/supabase/realtime/issues/1524)).
It does not reproduce locally.

That is exactly the symptom. It is not about friendship direction — `is_friend`
is symmetric, and I confirmed `link_friendship` inserts **both** mirrored rows
atomically (`values (p_a, p_b), (p_b, p_a)`). It is about *which subscription was
created last*: whoever subscribed most recently receives, and the other does not.

**Why presence never hit this:** presence binds **one subscription per friend**
with `filter: user_id=eq.<friendId>`. Every presence row therefore matches
exactly **one** subscription. My reactions channel has every viewer subscribed to
the **same** filter (`channel=eq.lvndmark`), so one row matches **many**
subscriptions — the precise condition the defect needs.

**The fix, which is also the fix for friend-of-friend authorization:** write
**one row per recipient** and give each user their own topic and filter.

```
together_reactions(recipient_id, sender_id, channel, reaction, created_at)
RLS:      recipient_id = (select auth.uid())
topic:    kickback-together:<userId>
filter:   recipient_id=eq.<userId>
```

Now every row has exactly one interested subscriber — the same shape presence
already proves works — and the RPC computes the recipient set as the connected
component. Authorization stops being a recursive predicate evaluated per row per
subscriber and becomes `recipient_id = auth.uid()`.

**This is why I did not patch Bug A.** Fixing delivery for direct friends means
building the thing the convergence deletes.

---

## 13. Realtime authorization

| | Now (0019) | Proposed |
|---|---|---|
| Rows | one per reaction | one per recipient |
| RLS | `is_friend(user_id)` | `recipient_id = auth.uid()` |
| Topic | shared per channel | per user |
| Filter | `channel=eq.X` | `recipient_id=eq.<me>` |
| Recipients decided | at read time, per subscriber | at write time, once, server-side |
| FoF support | impossible | falls out |

Supabase's own documentation confirms the cost model: *"Postgres Changes
authorizes every event against each subscriber... throughput scales with the
number of subscribers, not the write rate."* Deciding recipients once at write
time is therefore also the cheaper design, not merely the correct one.

---

## 14. Analytics

Reuse `watching_together_started` / `_ended` and `post_social_retention_ended`
unchanged — no second lifecycle. Rename the four 0019 events into room
vocabulary and add exactly one:

| Event | Answers |
|---|---|
| `automatic_room_entered` (was `together_surface_shown`) + `participant_count`, `direct_friend_count` | How often does JOIN produce a room? How much of it is friends-of-friends? |
| `automatic_room_opened` | Do people open it, or is the strip enough? |
| `automatic_room_reaction` (was sent/received, merged with a direction property) | Does it produce interaction? |
| `automatic_room_combo` | Do people interact *with each other*? |
| `friend_request_sent` with `source: 'together'` — **existing event, new source** | **Gravity → JOIN → room → new friend edge**, with no new event at all |

That last row is the important one and it costs nothing: `friend_request_sent`
already exists and already carries a source.

No message or reaction content, ever. `direct_friend_count` alongside
`participant_count` is what tells us whether friend-of-friend exposure is
actually happening.

---

## 15. Test Lab

The lab already models a friendship *relationship to the observer*
(`friend | incoming_request | outgoing_request | stranger`). Connected components
need **edges between simulated people**, which it cannot express.

The change is small and additive: `SimWorld.edges: Array<[string, string]>`, with
the observer's own edges continuing to drive `relationship`. Then scenarios A–H
are presets, and the component computation under test stays production's — the
lab supplies the graph and the presence, never the answer.

The lab must gain a **stub for the membership RPC** at the client boundary
(`KickbackState.roomMembers`), the same way it stubs metadata. It must not
reimplement the traversal.

---

## 16. Security

| Threat | Answer |
|---|---|
| Stranger on the same channel | Not in the component; never a recipient |
| Guessing a room identifier | There is no identifier |
| Claiming membership | Recipients computed server-side from `auth.uid()` |
| Spoofing a sender | `require_actor()`; no sender parameter |
| Sending into a cluster you are not in | RPC recomputes the component for the sender and refuses if empty |
| Enumerating members without being connected | RPC refuses if the caller's own presence is not on that channel |
| Traversing the graph through the API | Returns members, never edges; seeded at `auth.uid()`; hop- and size-bounded |
| Stale ex-participant still receiving | Recipients fixed at write time; a departed user gets no new rows |
| Bridge leaves, old subscription persists | The subscription is per-user, not per-room; it only ever delivers rows addressed to you |
| Payload / spam | Closed palette, existing rate budget |

Two bounds must be in the RPC and are not negotiable: **max hops** (I suggest 3)
and **max members** (I suggest 50). Both make the traversal a bounded query and
stop a pathological component becoming a denial of service.

---

## 17. Scale

Destination limits the candidate set; friendship determines the room. A
50,000-viewer Twitch channel with 200 Kickback users is not one room — it is
however many components those 200 form, which in practice is many small ones.

| Concurrent | Component query | Fan-out |
|---|---|---|
| 10 | trivial | trivial |
| 1K | recursive CTE over a handful of rows; cache per channel per presence tick | ≤50 rows per reaction |
| 100K | the query needs an index on `presence(channel)` and a short server-side cache | fan-out dominates; consider collapsing bursts before write |
| 1M | not this architecture | — |

The thing that breaks first is **not** the traversal — it is Realtime's
per-subscriber authorization, which the Supabase docs are explicit about. The
per-recipient design already minimises it.

No client-side BFS. The client never receives the graph.

---

## 18. Migration / deployment

One migration, `0020`, and it must assume **0019 is already applied** (it is —
that is how the bug was observed).

1. `together_reactions`: add `recipient_id`, drop the old policy, add
   `recipient_id = auth.uid()`. Old rows are ephemeral, so no backfill.
2. `stream_room_members(p_channel)` — `SECURITY DEFINER`, bounded, granted to
   `authenticated`.
3. `send_together_reaction` — recompute recipients, fan out.
4. Index on `presence(channel)` for the traversal.
5. Analytics contract rename.

No Edge Function, no secrets, no new service. Same paste-into-SQL-editor flow.

---

## 19. Verification

**None run — no code changed.** The repository is exactly as `4588d85` left it,
and `npm run build`, the test suites and `verify:lab` were all green at that
commit.

---

## 20. Manual test

Not applicable this checkpoint. When the decision lands, the two-account test in
the brief becomes the acceptance gate for Bug A specifically — **both directions
must be asserted**, and the Test Lab covers the graph scenarios two accounts
cannot reach.

---

## 21. Git

Report only. No production changes, no fake commits.

---

## 22. Deferred

- Text in automatic rooms — §0.
- Room identity and persistence — only meaningful with text.
- Promoting a room into a Group.
- Friend suggestions or growth prompts inside the room (explicitly out of scope).
- `kickbackMetadata.check()` DevTools debt — untouched.
- Growth milestone — not started.
