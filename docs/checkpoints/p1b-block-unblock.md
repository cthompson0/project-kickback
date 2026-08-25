# P1B — Block / Unblock

**Date:** 2026-08-25
**Migration:** `0022_blocks.sql` — **not yet applied to hosted**
**Status:** implemented, verified against real Postgres, awaiting manual two-account acceptance
**Follows:** [contextual-stream-session-p1a.md](contextual-stream-session-p1a.md) (frozen)

---

## 1. Architecture audit

What existed before this checkpoint, and what each thing turned out to imply.

| Concern | Where it lives | Bearing on Block |
| --- | --- | --- |
| Friendship | `public.friendships`, **two rows** per pair (`user_id`, `friend_id`) | Both must go, or one direction keeps seeing the other |
| Requests | `public.friend_requests` with `status`, partial unique index on pending | Pending rows in *either* direction must stop being pending |
| Presence RLS | `presence_select` → `public.is_friend(user_id)` **or** `public.shares_group_with(user_id)` | Two chokepoints, not one |
| Identity RLS | `users_select`, `connected_accounts_select` → same two predicates | Same two chokepoints |
| Room traversal | `stream_room_members(text)` — recursive CTE over `friendships`, 3 hops, 50 members | Needs a **join-level** predicate; there are no rows to delete between non-friends |
| Recipient materialisation | `send_room_message`, `send_together_reaction` — one row per recipient at send time | Needs a **pairwise** filter; the sender's component legitimately contains both parties |
| Group chat | `group_messages`, RLS `is_group_member(group_id)`, plus a realtime `INSERT` subscription that applies the raw row | Reader-only filtering would hold on reload and fail live |
| Client caches | `friends` service, `presenceIndex`, `streamRoom` membership cache (90 s) | Converge on the existing invalidation channel; one addition, below |

The important finding is that **the friendship-shaped fix is not sufficient
three times over**:

1. `shares_group_with` grants presence and identity independently of `is_friend`.
2. The room walk connects people who were never friends, so there is no row to
   delete between them.
3. Group chat is delivered twice — by an RPC and by realtime — and only one of
   those goes through a join that RLS can prune.

Each is handled explicitly below rather than by a single deletion.

## 2. Database model

`0022_blocks.sql`, one new table:

```sql
create table public.blocks (
  blocker_id uuid not null references public.users (id) on delete cascade,
  blocked_id uuid not null references public.users (id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (blocker_id, blocked_id),
  constraint blocks_not_self check (blocker_id <> blocked_id)
);
create index blocks_blocked_idx on public.blocks (blocked_id);
```

**Directional row, symmetric effect.** One row is stored — *A blocked B* —
because one person made a decision and the other must not be told about it. But
every check asks `blocked_pair`, which is true if a row exists in **either**
direction:

```sql
create function public.blocked_pair(p_a uuid, p_b uuid) returns boolean
language sql stable security definer as $$
  select exists (
    select 1 from public.blocks b
    where (b.blocker_id = p_a and b.blocked_id = p_b)
       or (b.blocker_id = p_b and b.blocked_id = p_a)
  );
$$;
```

Requiring a reciprocal row would let the blocked party re-establish contact by
simply not blocking back, which is the opposite of what blocking means.

**RLS.** `blocks_select` is `using (blocker_id = (select auth.uid()))` — the
blocker's own rows, never `blocked_id`. `insert`, `update` and `delete` are not
granted at all; the two RPCs are the only writers.

**`blocked_pair` is revoked from `authenticated` and never granted back.** It is
callable only from inside `SECURITY DEFINER` functions. That is what makes *"has
this person blocked me?"* unanswerable through any client path — there is no
endpoint that takes the question.

## 3. The block transaction

`block_user(p_target uuid)`, `SECURITY DEFINER`, one transaction:

1. `require_actor()`; refuse self-block.
2. Lock both user rows in a stable order (lowest id first), so two people
   blocking each other at the same instant cannot deadlock.
3. `insert … on conflict do nothing` — idempotent.
4. `delete from friendships` where the pair matches in **either** direction.
5. `update friend_requests set status = 'cancelled'` for any `pending` row in
   **either** direction.

Requests are **cancelled, not deleted**, so the partial unique index on pending
requests frees up and a fresh request can be sent after an unblock.

Everything else — presence, Gravity, the room, delivery — follows from the
predicates below rather than from a cascade of deletes. There is nothing to keep
in step.

## 4. Friendship and request behaviour

`is_friend` gained one line:

```sql
  select exists (select 1 from public.friendships …)
     and not public.blocked_pair((select auth.uid()), p_other);
```

Belt and braces: the rows are already gone, and this makes a stale or
hand-inserted row inert as well.

`send_friend_request` raises **before** any insert:

```
kickback: cannot add that user     (errcode 42501)
```

The same message in both directions, so the refusal cannot be used to work out
who blocked whom. `respond_to_friend_request` re-checks on accept — a request
that was pending before the block and is accepted after it is refused and
cancelled, rather than quietly resurrecting the friendship.

## 5. Presence privacy

Nothing was added to the presence policies. Both predicates they already consult
now stop at a block:

- `is_friend` — above.
- `shares_group_with` — same one-line addition (§8).

Because RLS is evaluated per query, revocation is immediate: the very next read
returns nothing. The panel converges without a refresh via the existing social
invalidation channel (§10).

## 6. FoF traversal — the walk stops, it does not filter

`stream_room_members` walks the friendship graph. The predicate is in the
**recursive join**, not in a final `where`:

```sql
  join public.friendships f on f.user_id = w.user_id
  join public.presence p    on p.user_id = f.friend_id
  where …
    and not public.blocked_pair(v_actor, f.friend_id)
```

So a blocked person is never *entered*, and therefore cannot be traversed
through. Filtering the result set would have been wrong in a way that is easy to
miss: `A ↔ B ↔ C ↔ D` with `A` blocking `B` would still surface `C` and `D`,
who are reachable only via the person `A` refused to be connected to.

`tests/db/blocks.test.ts` asserts this on a four-person chain in both directions,
and asserts that an **uninvolved** `B` still sees both `A` and `C` — the
asymmetry is the point, and it is preserved.

## 7. Room delivery and reaction authorisation

The bridge case needs a *second*, different check. `B` is legitimately connected
to both `A` and `C`, so when `B` sends, `B`'s own room contains both — the walk
was never wrong. Delivery is therefore filtered pairwise at materialisation:

```sql
  insert into public.room_messages (…, recipient_id, …)
  select …
  from public.stream_room_members(p_channel) m
  where not public.blocked_pair(v_actor, m.user_id);
```

`send_together_reaction` does the same, and the count it returns is the count of
rows actually written — so a blocked user contributes nothing to the combo
stream, the `WATCHING TOGETHER` count, or the Gravity activity preview. There is
no Block-specific code in the combo engine or in Gravity: the rows simply are not
there.

The client still sends only *destination + body*. It has never named a recipient
and still cannot.

## 8. Group behaviour

Groups are the one place two people can be connected without a friendship, so a
friendship-shaped block would have left a door open. **Membership is not
touched** — nobody is removed, no group is dissolved, no owner loses anything.
What changes is what co-membership *grants*:

| Grant | Before | After a block |
| --- | --- | --- |
| Identity + presence (`shares_group_with`) | co-membership is enough | withheld, both directions |
| Group chat (`group_messages` select policy) | any member reads any message | the pair do not receive each other |
| Invitations (`invite_to_group`) | any user may be invited | refused, generic message |

The chat filter is in the **RLS policy**, not only in `list_group_messages`,
because group chat also arrives over realtime, which applies the raw row without
the `users` join. A reader-only filter would have held on reload and failed live
— the worse of the two failures. The policy calls a `SECURITY DEFINER` wrapper
(`group_message_visible`) because RLS expressions are evaluated as the querying
user, and `blocked_pair` is deliberately not granted to clients.

The result is a group whose member list and transcript have a hole in them, but
**only for the pair involved**. Everybody else's view is unchanged.

**Not done, and deliberately named as follow-up:** whether a block should also
*remove* shared group co-membership, or prompt the blocker to leave groups they
share with the person they blocked. Both are group-architecture decisions, out
of scope here per the brief. The current behaviour is coherent and safe — the
two of them cannot see or reach each other anywhere — but a user who blocks
somebody and then notices they are still nominally in the same group may find
that surprising. **This should be decided before public beta.**

## 9. UI

**On the card** (`UserCard.tsx`). `Block` is the last control in the action row,
styled identically to `Mute` and `Remove friend` — not visually dominant, and
positioned so a rarely-used safety action is not the first thing under somebody's
name. A test pins that ordering.

**Confirmation** is the card's own in-place primitive, the same one `Remove
friend` already used. No `confirm()` — it blocks the page, cannot be styled or
placed, and inside a content script it appears to belong to Twitch. While it is
open the ordinary action row stands down, so there are never two buttons reading
`Block` on screen.

> Block AnoterosTV? You won't see each other's Kickback activity or be put in
> stream sessions together. This also removes them as a friend.
>
> `[ Cancel ]` `[ Block ]`

The friendship consequence is stated because it is the one somebody could
reasonably be surprised by.

**A blocked person's card** shows `Blocked` where the friendship controls were,
and offers neither `Add friend` nor `Mute` nor `Block`. Every one of those would
be refused by the server, and a control that exists to fail is worse than no
control.

**Management** is a `Blocked · N` list in the account card, **separate from**
`Muted`, directly below it. Absent entirely when nobody is blocked. `Unblock` has
no confirmation: it is not destructive.

## 10. Convergence without a refresh

`block_user` deletes a `friendships` row on **each** side, and both clients
already subscribe to `friendships` filtered on their own `user_id`. That existing
channel — the one friend-removal uses — carries the block with no new
subscription and no polling.

One addition was needed. `onInvalidate` previously only re-read the friends list;
room membership was re-asked only when somebody arrived on or left the channel.
That is not what a block is, and in the bridge case nothing about the removed
person's presence changes for the viewer — `C` was never visible to `A` in the
first place. So:

```ts
onInvalidate: () => {
  void friends.refresh()
  room.invalidate()
  room.want(sessionChannel())
},
```

No timer, no shortened TTL, no polling.

## 11. Privacy and non-disclosure

- No notification of any kind — OS, in-panel, chat, or friend-list.
- `list_blocked_users()` returns only the caller's own blocks.
- `search_users` returns `blocked` **only to the blocker**. Somebody who blocked
  *you* comes back as an ordinary `none` result whose `Add friend` the server
  then refuses — a refusal deliberately indistinguishable from any other.
- `blocked_pair` is not callable by any client.
- No string anywhere in `src/ui/` can tell somebody they have been blocked; a
  test walks every `.ts`, `.tsx` and `.css` file under `src/ui` (comments
  stripped) and asserts it.

What the blocked person *can* observe is that the other person is no longer
visible. That is unavoidable — any effective block produces some difference —
and it is generic: indistinguishable from going invisible, unfriending, or
deleting the account.

## 12. Block and Mute stay independent

Different promises. Mute is local, silent, reversible: *I do not want to hear
you*. It never reaches the server. Block is server-enforced: *I do not want us
socially connected*. Blocking does not mute, and **unblocking does not unmute** —
if somebody was muted before they were blocked, they are still muted after the
unblock. Separate lists in the account card, so the two never start to look like
one setting.

## 13. Unblock

Removes the block row and nothing else.

- Friendship is **not** restored.
- Cancelled requests are **not** revived.
- Room membership is **not** recreated — it is derived, so it simply recomputes.
- Mute is **not** cleared.

`unblock_user` deletes only `where blocker_id = actor`, so it cannot remove
somebody else's block. If both blocked each other, one unblocking leaves the
other's block standing and `blocked_pair` still true.

## 14. Analytics

Two events, **no properties at all**:

| Event | Properties |
| --- | --- |
| `user_blocked` | `array[]::text[]` |
| `user_unblocked` | `array[]::text[]` |

No blocked user id, login, or display name. No message bodies. No reason field.
Recording who was blocked would turn the analytics table into a record of who
dislikes whom — more sensitive than anything else Kickback keeps, and it answers
no question we have. Whether people need the feature at all is answered by a bare
count.

**Block is not Report.** Nothing is sent to us, and nothing is asked of us.

## 15. Tests

| Suite | Count | What it covers |
| --- | --- | --- |
| `tests/db/blocks.test.ts` | 36 | Real Postgres (PGlite), real migrations |
| `tests/db/bundle.test.ts` | 25 (3 new) | 0021 → 0022 upgrade, no overloads, `blocked_pair` never granted |
| `tests/extension/blockUi.test.tsx` | 12 | Control placement, confirmation, management list, non-disclosure sweep |

The DB suite covers: friendship destruction both rows; request cancellation both
directions; presence hidden both ways; requests refused both directions with
**identical** wording; a stale request refused on accept; unblock removing only
the block; unblock not undoing the other party's block; the walk stopping at a
block on a four-person chain, in both directions; an uninvolved bridge keeping
both sides; messages and reactions not crossing; blocks unreadable by others;
direct `insert`/`update`/`delete` refused; `blocked_pair` not callable;
blocking on another's behalf refused; self-block refused; idempotence; `search`
saying `blocked` only to the blocker; and the six group cases from §8.

The UI tests are not relied on for any safety guarantee — those are all in the DB
suite, as the brief requires.

## 16. Verification

| Gate | Result |
| --- | --- |
| `tests/db` | 239 passed |
| `tests/extension` + `tests/core` | 1298 passed |
| `npm run test:lab` | 121 passed |
| `npm run verify:lab` (real browser, CDP) | 9 scenarios passed |
| `npm run typecheck` | clean |
| `npm run lint` | clean |
| `npm run build` | clean |

The mutation universe and `test:analytics` were **not** run — no narrow mutation
command exists for these invariants, and the analytics verifier mutates repo
files in place. No command exceeded five minutes.

## 17. Migration deployment

`0022_blocks.sql` is **not applied to hosted.** It is:

- additive — one new table, no column changes to anything deployed;
- self-contained in `begin;` / `commit;`;
- safe to re-run — `create table if not exists`, `create or replace`, and
  `drop function if exists` by exact signature before every set-returning
  redefinition;
- verified applying to an empty database, twice, three times, and on top of a
  database stopped at 0021.

`0020` and `0021` were not modified. `supabase/.generated/apply_all.sql` was
regenerated (22 migrations).

## 18. Manual retest (two accounts, real browser)

1. **A and B are friends, both watching the same channel.** Confirm each appears
   in the other's HERE and in the stream session.
2. **A opens B's card → Block → confirm.** Without refreshing either browser:
   B disappears from A's Friends list, HERE, session roster and count; A
   disappears from B's, same list. Neither sees the other's presence.
3. **B sends a message in the session.** A does not receive it. Anybody else in
   the room does.
4. **B reacts.** A's combo stream and `WATCHING TOGETHER` count do not move.
5. **B opens A's profile from search → Add friend.** Refused, with a generic
   message. No indication a block exists.
6. **A searches for B.** Result shows as blocked. **B searches for A.** Result
   looks ordinary.
7. **Chain test.** A ↔ B ↔ C, all three on the same channel, A and C not
   friends. Before the block, A's session includes C. After A blocks B, A's
   session includes neither B nor C. B's session still includes both A and C…
   except A, whom B can no longer see. C is unaffected apart from losing A.
8. **Shared group.** A and B in one group with C. After the block, A and B do not
   see each other's presence or group messages; C sees everyone's. Both are still
   group members.
9. **A opens the account card → Blocked → Unblock.** B reappears **only** as a
   stranger: no friendship, no pending request, no session membership. If B was
   muted before, B is still muted.
10. **A sends B a friend request after the unblock.** Accepted normally.

## 19. Git

One commit: `feat: add block and unblock`. Full diff reviewed; no `.env.local`,
no service-role key, no JWT, no client secret, no database dump, no `dist/`, no
release archive, no analytics test output.
