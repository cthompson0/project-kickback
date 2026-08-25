# Automatic Stream Rooms

> **Superseded.** This document described the direct-friend Automatic Together
> prototype (migration 0019). It was converged onto connected-component Stream
> Rooms in migration 0020 - see
> [the convergence architecture](checkpoints/automatic-stream-room-convergence.md)
> and [the implementation report](checkpoints/automatic-stream-room-implementation.md).
>
> What changed: a room is now the connected component of the friendship graph
> among people present on a destination, not the viewer's direct friends;
> reaction recipients are decided at write time rather than by read-time RLS;
> and reactions are Kickback emotes counted by the existing combo engine rather
> than a second implementation.
>
> **Superseded again by the UX correction** -
> [automatic-stream-room-ux.md](checkpoints/automatic-stream-room-ux.md).
> The reaction row and roster drawn on the Gravity card below are gone: the
> card carries an ephemeral combo and a doorway, and the room is a distinct
> view you enter and come back from. A room also now requires a **live
> stream** - see `src/core/socialViewing.ts` - which is why two people sitting
> on an offline channel no longer form one, or accrue shared watch time.

The last step of **Presence → Social Gravity → JOIN → Together**.

When you and some friends end up on the same Twitch stream, Kickback notices.
That is the whole feature: no room to create, no name to choose, nobody to
invite, nothing to leave.

---

## It is not a room

Kickback already has persistent private spaces — **Groups**, with intentional
membership and a conversation that is still there tomorrow. Automatic Together
is the opposite of that on every axis, and the two must not be merged.

| | Groups | Automatic Together |
|---|---|---|
| How it starts | somebody creates it | co-presence |
| Membership | explicit, managed | derived, never stored |
| Identity | a name, an icon, an owner | a channel |
| Conversation | persistent | eight seconds |
| Ends when | somebody deletes it | you stop watching |
| Records | groups, members, invites, messages | none |

They share transport (Supabase Realtime), identity, authorization helpers and
UI primitives. They share no product semantics. **Groups are untouched by this
checkpoint** — a test asserts the migration mentions none of their tables.

---

## Participants are derived, never stored

```
you.channel = lvndmark
Jake.channel = lvndmark
Matt.channel = lvndmark
                      ↓
   Together { destination: lvndmark, participants: [Jake, Matt] }
```

There is no participant list anywhere in the code. The panel reads the `here`
cluster from `clusterMembers` — the same one Social Gravity has drawn since
that checkpoint — which means Together inherits, for free and without a second
interpretation:

- **multi-tab effective activity** — one person, not one per tab; two tabs on
  one channel are one participant and one subscription;
- **the 90-second staleness rule** — a closed laptop leaves on its own, with no
  departure message and nothing to clean up;
- **write-time privacy redaction** — a friend who hides their activity has no
  channel by the time anyone reads it, so they are simply not here;
- **self-exclusion** — you are never one of the people you are with;
- **one actor per user** — several sessions or browser profiles are one person,
  because presence is keyed by user id.

Nothing is created when a Together forms and nothing is deleted when it
dissolves, because nothing existed. Moving to another stream ends it by making
it untrue.

### Destination identity

The canonical lowercase login — `lvndmark` — the same value presence, Gravity,
JOIN, `destination_channel` and `opportunity_key` all use. Conceptually
`twitch:lvndmark`; the platform is implicit while Twitch is the only one.

Deliberately **not** the Twitch stream id: a stream ending and restarting is
the same people in the same place, and keying the social context to a stream id
would dissolve it mid-conversation. Display casing, category, title and viewer
count remain enrichment; Together works with no metadata at all.

---

## Channel is context. Friendship is authorization.

The one thing that must not be got wrong.

Reactions are rows in `together_reactions`, and the row policy is:

```sql
using (user_id = (select auth.uid()) or public.is_friend(user_id))
```

Delivery is `postgres_changes` on the realtime publication, re-checked by the
server **per subscriber** — the same mechanism presence has always used.

| Scenario | Result |
|---|---|
| 40,000 strangers on xQc | you receive nothing from any of them |
| A↔B and C↔D all on LIRIK | A sees B; C sees D; neither pair sees the other |
| A↔B, B↔C, A not friends with C | A does not see C — `is_friend` is direct |
| A friend goes invisible | no presence, so not a participant |
| Somebody knows the channel name | knowing it grants nothing |

**Nothing is filtered client-side.** A client-side privacy filter is one the
attacker controls; the server simply never sends the row.

### Why not a broadcast channel

A broadcast channel keyed `twitch:lvndmark` is the obvious design and the wrong
one: everyone on the channel receives everyone's reactions, and privacy becomes
a client-side promise. A table costs one insert and buys per-subscriber
authorization that already exists and is already tested.

---

## Reactions

Five, fixed: 😂 ❤️ 🔥 😭 👀

A closed set rather than free emoji entry, for three reasons in order of
importance: it is a couch and not a keyboard; a closed set cannot carry a
payload, so no arbitrary text ever reaches another person's screen; and combos
only mean something when people can collide on the same symbol.

The palette is written in `src/core/together.ts` and enforced again in SQL. A
test reads both and asserts they agree.

### Ephemeral

- Shown for **8 seconds**, then gone.
- No history, no inbox, no transcript, no unread, no search, no moderation log.
- Every insert sweeps rows older than **1 minute** on that channel — no pg_cron,
  bounded by the index, and never touching a channel nobody is using.
- Nothing reads the table back. There is no query that returns yesterday's
  reactions and deliberately no index that would make one cheap.

The rows are a transport, not a record. That is a real trade-off and worth
stating plainly: reactions do touch disk for about a minute.

### Combos

Two or more **different** people, on the same reaction, within **4 seconds**:

```
Jake 😂   Matt 😂   You 😂   →   😂 ×3
```

One person pressing a button five times is one 😂. That single rule is what
keeps this from becoming a clicker game — and it needs no points, streaks, XP
or leaderboard to enforce, because enthusiasm is not a second voice.

**Not `scanCombos`.** The chat combo scanner models a conversation: ordinary
prose closes a run and a closing message can earn breaker credit. Neither
concept exists here — there is no prose in this stream and nothing to break — so
reusing it would mean feeding it synthetic messages and discarding half its
output. The threshold and the `×N` language are shared; the rules are not.

### No text chat

Deliberately. Twitch chat exists, Groups exist, and a third place to type would
be the point at which Kickback started becoming Discord. Nothing in this
checkpoint adds a text field, and the reaction table has no body column for one
to arrive in.

---

## UX

Gravity and Together are two states of **one** destination, not two things.

Before you arrive — a place to go:

```
🔥 LVNDMARK · 2                    JOIN
   Jake · Matt
```

After you arrive — the same card, in place:

```
   LVNDMARK · 2                    HERE
   Escape from Tarkov · ● LIVE · 18K
   2 friends watching with you
   Jake · Matt
   😂 ❤️ 🔥 😭 👀            😂 ×2
```

No second card, no modal, no ceremony. The card already said "you are here with
these people"; all it lacked was something to do about it.

The reaction row is **one line that never changes height**, so a reaction
landing cannot push the friends or the JOIN around — which matters because they
arrive while somebody is watching a stream, not looking at the panel. The
browser gate measures this.

Reactions fade out rather than vanishing; `prefers-reduced-motion` turns the
animation off while keeping the reaction. No sound. No OS notifications — the
existing gathering notification is a separate thing and is unchanged.

---

## Analytics

Four events, and deliberately **no new lifecycle**:
`watching_together_started` / `_ended` and `post_social_retention_ended` already
measure the shared watch, and measuring it twice would be two chances to
disagree.

| Event | When | Properties |
|---|---|---|
| `together_surface_shown` | a Together forms (transition, once per gathering) | `participant_count` |
| `together_reaction_sent` | the viewer reacts | `participant_count` |
| `together_reaction_received` | a friend's reaction arrives | `participant_count` |
| `together_combo_formed` | 2+ people agree at once | `combo_size`, `participant_count` |

**No reaction content anywhere.** Which of five emoji somebody pressed answers
no question we have, and "what did this person react to" is a
surveillance-shaped fact rather than a product one.

The questions this answers, by joining on the existing funnel:

```sql
-- Of JOINs through Gravity, how many became a Together?
select count(*) filter (where t.actor_id is not null) as reached_together,
       count(*)                                       as gravity_joins
from public.analytics_join_funnel_v j
left join public.analytics_reportable_events_v t
  on t.event_name = 'together_surface_shown'
 and t.actor_id = j.actor_id
 and t.destination_channel = j.destination_channel
 and t.occurred_at between j.occurred_at and j.occurred_at + interval '10 minutes'
where j.source = 'social_gravity';

-- Do people who interact stay longer?
select (r.actor_id is not null) as interacted,
       count(*)                 as shared_watches,
       avg(f.together_duration) as avg_shared_watch,
       avg(f.post_social_duration) as avg_stay_after
from public.analytics_join_funnel_v f
left join public.analytics_reportable_events_v r
  on r.event_name = 'together_reaction_sent'
 and r.actor_id = f.actor_id
 and r.destination_channel = f.destination_channel
group by interacted;
```

The `together` analytics surface replaces the reserved-but-never-emitted
`stream_room`. Nothing recorded changes meaning, because nothing ever used it.

---

## Failure and degradation

| Failure | Result |
|---|---|
| Realtime unavailable | The Together surface still shows who is here. No reactions arrive. |
| A send fails (offline, rate limited) | Nothing appears — for the sender too. Nothing is drawn optimistically, so nothing has to be taken back. |
| Metadata unavailable | Together works unchanged; the card is just plainer. |
| A friend's client dies | The 90-second staleness rule removes them. |
| Worker restarts | Reactions are not restored — an eight-second moment restored later would be a lie. Participants come straight back from presence. |
| Migration 0019 not applied | Sends fail and nothing arrives. Gravity, JOIN and presence are untouched. |

Presence is the source of truth for participants in every one of these.

---

## Scale

Reactions scale with **people who are actually watching with friends**, not
with channel popularity.

| Concurrent users | Subscriptions | Notes |
|---|---|---|
| 10 | ≤10 | trivial |
| 1,000 | ≤1,000, one per person on a channel | comfortable for Supabase Realtime |
| 100,000 | ≤100,000 | the point to reconsider |

One subscription per user, only while they are on a channel, closed when they
leave. Inserts are bounded by the rate budget (60/minute/user) and rows live a
minute.

The pressure that would arrive first is **fan-out**: 10,000 Kickback users on
one popular stream means 10,000 subscribers on one `postgres_changes` filter,
and Realtime evaluates RLS per subscriber per row. The mitigations, in order of
how much they cost: raise the combo window so bursts collapse before they are
sent; move to a per-user inbox channel; move reactions off Postgres entirely.
None is worth building now — a channel needs thousands of *Kickback* users
before any of it matters, and that is a problem worth having.

---

## Deployment

**MIGRATION REQUIRED:** `supabase/migrations/0019_automatic_together.sql`

```bash
npm run db:bundle
```
→ **Supabase → SQL Editor → New query** → paste
`supabase/.generated/apply_all.sql` → Run. Idempotent; no CLI, no database
password.

It adds the `together_reactions` table, its index and row policy, the
`send_together_reaction` RPC, the realtime publication entry, and four analytics
event names. No Edge Function, no secrets, no new external service.

Until it is applied: reactions do nothing and nothing arrives. Everything else —
including the Together surface itself and who is in it — works, because that
comes from presence.

---

## Test Lab

`npm run dev:lab` → the **Together** section.

Nine presets: 1 / 2 / 5 / 10 friends, live metadata, nobody yet, competing
graphs, privacy mix, stale friend. Per-friend reaction buttons, plus
"Combo 😂 (all)" and "Burst 🔥 (one person ×5)".

The lab supplies reactions at the same boundary production reads them from —
`KickbackState.togetherReactions` — and holds **no subscription, no row policy,
no rate limit and no sweep**, because those belong to the service. A test
asserts no lab source mentions any of them.

Reactions persist across a preset change, because the *channel* did not change.
That mirrors production, where the buffer is cleared only when the viewer moves.
