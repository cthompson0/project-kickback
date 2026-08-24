# Automatic Together — Checkpoint Review

Commit `3b8eebd` — `feat: add automatic together rooms`. Pushed to `main`.

**One action required: apply migration 0019.**

Reference documentation: **`docs/TOGETHER.md`**.

---

## 1. Audit — what was already there

I traced the existing architecture before designing anything. Almost everything
this needed already existed.

| Existing | Reused how |
|---|---|
| `clusterMembers` `here` cluster | **Is** the participant list. Nothing new derives one. |
| `postgres_changes` + RLS per subscriber (0005) | The delivery model. Friendship authorization for free. |
| `public.is_friend(uuid)` | The privacy predicate, already granted to `authenticated`. |
| `require_actor()` | The sender. No actor parameter exists to forge. |
| `consume_rate_budget` | Rate limiting, in the same shape `send_group_message` uses. |
| `group_messages` table + policy | The template for the reactions table's grants and policy. |
| Social Gravity HERE card | The Together surface. No new card. |
| `togetherWatch` lifecycle analytics | Reused unchanged — no second measurement of the shared watch. |
| Test Lab | Extended; injects at the production boundary. |
| Metadata | Enrichment only, untouched. |

**Not reused, with reasons:**

- **Groups / GroupChat / GroupPresence** — the *mechanisms* (realtime, identity,
  UI primitives) are shared; the *semantics* are not. A Together has no
  membership, ownership or persistence, and forcing it into Group semantics
  would have meant creating and deleting room records to track something
  presence already knows.
- **`scanCombos`** — models a chat: ordinary prose closes a run, and a closing
  message can earn breaker credit. Neither concept exists in a reaction stream,
  so reusing it would mean feeding it synthetic messages and discarding half its
  output. `COMBO_MIN_DISPLAY` and the `×N` language are shared; the rules are
  not.
- **Emote infrastructure** — `soleEmote` resolves 7TV emotes. Reactions are five
  fixed emoji, and a closed set is what makes them safe.

No blocker was found. No new server, no auth redesign, no persistent room
infrastructure, no weakening of friendship privacy — so I implemented.

---

## 2. The model

```
you.channel = lvndmark + friends on lvndmark  =  Together { lvndmark, [Jake, Matt] }
```

There is **no participant list in the new code**. The panel reads the `here`
cluster, which means Together inherits multi-tab effective activity (one person,
not one per tab), the 90-second staleness rule, write-time privacy redaction,
self-exclusion, and one-actor-per-user across browser profiles — none of it
restated.

Nothing is created when it forms and nothing deleted when it dissolves.

**Destination identity:** canonical lowercase login, conceptually
`twitch:lvndmark`. Not the stream id — a stream ending and restarting is the
same people in the same place, and keying to a stream id would dissolve the
context mid-conversation.

---

## 3. Realtime and authorization

Reactions are rows in `together_reactions`, delivered by `postgres_changes` with
the policy:

```sql
using (user_id = (select auth.uid()) or public.is_friend(user_id))
```

RLS is re-checked **per subscriber** — the mechanism presence has always used.

| Scenario | Result |
|---|---|
| 40,000 strangers on xQc | you receive nothing |
| A↔B and C↔D on LIRIK | A sees B; C sees D; neither pair sees the other |
| A↔B, B↔C, A∦C | A does not see C — `is_friend` is direct |
| Knowing the channel name | grants nothing |

**A broadcast channel keyed `twitch:lvndmark` was the obvious design and the
wrong one** — everyone receives everyone, and privacy becomes a client-side
promise. Nothing is filtered client-side here; the server never sends the row.

One subscription per user, only while on a channel, closed on leaving.

---

## 4. UX

The HERE card **becomes** the Together surface. No second card, no modal, no
ceremony.

```
   LVNDMARK · 2                    HERE
   Escape from Tarkov · ● LIVE · 18K
   2 friends watching with you
   Jake · Matt
   😂 ❤️ 🔥 😭 👀            😂 ×2
```

One row that never changes height — a reaction landing cannot push the friends
or the JOIN around, which matters because they arrive while somebody is watching
a stream. The browser gate measures the card's height before and after a
reaction and fails if it moves by more than a pixel.

No surface at all when the viewer is on a channel alone. Fades rather than
blinks; `prefers-reduced-motion` keeps the reaction and drops the animation. No
sound, no notifications, no unread.

---

## 5. Reactions and combos

Five fixed: 😂 ❤️ 🔥 😭 👀 — validated in TypeScript and again in SQL, with a
test that reads both and asserts they agree.

Shown 8 seconds; swept after 1 minute by the insert itself (no pg_cron). Nothing
reads the table back; there is no query that returns old reactions and
deliberately no index that would make one cheap.

A combo is **two or more different people** on the same reaction within 4
seconds. One person pressing a button five times is one reaction — the single
rule that keeps this from becoming a clicker game, with no points, XP, streaks
or leaderboard needed to enforce it.

**No text chat.** Twitch chat exists, Groups exist, and a third place to type is
where Kickback would start becoming Discord. The table has no body column for
one to arrive in.

---

## 6. Analytics

Four events; **no new lifecycle**, because `watching_together_started` /
`_ended` and `post_social_retention_ended` already measure the shared watch.

`together_surface_shown` (on the transition into a Together, once per gathering)
· `together_reaction_sent` · `together_reaction_received` ·
`together_combo_formed`.

Properties are `participant_count` and `combo_size`. **No reaction content
anywhere** — which of five emoji somebody pressed answers no question we have.

The `together` surface replaces the reserved-but-never-emitted `stream_room`.
Nothing recorded changes meaning; carrying both would mean two words for one
thing in every query.

`docs/TOGETHER.md` has the SQL for "of Gravity JOINs, how many became a
Together" and "do people who interact stay longer".

---

## 7. Test Lab

Nine presets: 1 / 2 / 5 / 10 friends, live metadata, nobody yet, competing
graphs, privacy mix, stale friend. Per-friend reaction buttons plus
"Combo 😂 (all)" and "Burst 🔥 (one person ×5)".

Fed at `KickbackState.togetherReactions` — the production boundary. The lab
holds **no subscription, no row policy, no rate limit and no sweep**; a test
asserts no lab source mentions any of them. Still network-sealed.

---

## 8. Persistent Groups vs Automatic Together

**Should Groups filter Together?** Not now, and probably not as filtering. A
"Close Friends" group narrowing who counts as a participant would mean two
sources of truth about who you are with, and a Together that disagrees with
presence is worse than one that is simply everybody. The more interesting
version is the *reverse*: a group as a **notification** filter — "3 of Close
Friends are on LVNDMARK" — which is the existing gathering notifier's business,
not this surface's. Deferred, cleanly.

**Could a Together be promoted into a Group?** Yes, and the architectures are
compatible: a Together already knows a channel and a set of user ids, which is
exactly `create_group` plus invites. Nothing here forecloses it. Nothing here
implements it either.

**Groups are untouched.** A test asserts migration 0019 mentions none of their
tables.

---

## 9. Security and privacy

| Threat | Answer |
|---|---|
| Stranger on the same channel receives reactions | RLS `is_friend`, per subscriber. Never sent. |
| Spoofing a sender | `require_actor()`; there is no sender parameter. Tested. |
| Subscribing to arbitrary social activity by channel name | The channel is context; the policy is authorization. |
| Friend-of-friend leakage | `is_friend` is direct; the policy asks nothing else. Tested. |
| Arbitrary payload | Five fixed values, checked in SQL and again in the client parser. |
| Channel injection | `^[a-z0-9_]{3,25}$` in the RPC and as a column check. |
| Flooding | 60/minute/user via `consume_rate_budget`. |
| Malformed row | `parseReaction` drops it; nothing unrenderable reaches the DOM. |
| Unbounded memory | Buffer capped at 60, de-duplicated, self-expiring. |
| Secrets | None involved. No new external service. |

---

## 10. Scale

Scales with **people watching with friends**, not channel popularity. One
subscription per user, only while on a channel.

10 users trivial · 1,000 comfortable · 100,000 is where to reconsider.

The pressure that arrives first is fan-out: 10,000 Kickback users on one stream
means 10,000 subscribers on one filter, with RLS evaluated per subscriber per
row. Mitigations in cost order: widen the combo window so bursts collapse before
sending; per-user inbox channel; move reactions off Postgres. None worth
building — a single channel needs thousands of *Kickback* users first.

---

## 11. Migration required

`supabase/migrations/0019_automatic_together.sql`

```bash
npm run db:bundle
```
→ **Supabase → SQL Editor → New query** → paste
`supabase/.generated/apply_all.sql` → Run. Idempotent, no CLI, no database
password.

Table + index + policy, the `send_together_reaction` RPC, the realtime
publication entry, four analytics event names. **No Edge Function, no secrets,
no deployment step.**

Until applied: sends fail and nothing arrives. The Together surface still forms
and still shows who is here, because that comes from presence.

---

## 12. Verification

| Command | Result | Time |
|---|---|---|
| 24 affected test files (649 tests) | pass | **4 s** |
| `npx tsc -b --force` | pass | 5 s |
| `npm run lint` | pass | 6 s |
| `npm run build` | pass | 6 s |
| `npm run verify:lab` (real Chrome) | pass | 13 s |

78 new tests. No mutation testing, no unrelated suites. Nothing near the
5-minute limit.

The browser gate found one real thing — and it was my own assertion, not the
product: I checked a total combo count after switching preset, but the previous
step's 😂 combo was still inside its 8-second TTL. Reactions persisting across a
preset change is *correct* (the channel did not change), so the assertion was
narrowed to the specific burst. Also fixed a shadowed `narrow` identifier in the
gate.

---

## 13. Manual acceptance test

### A. Test Lab — no accounts

```
npm run dev:lab            # http://localhost:5199
```

1. **Together · 2 friends** — HERE card, "2 friends watching with you", five
   reaction buttons, no JOIN, exactly one card.
2. Click 😂 under one friend → one reaction, no counter.
3. Click 😂 under the other within 4s → **😂 ×2**.
4. **Burst 🔥 (one person ×5)** → still no counter.
5. **Together · competing graphs** → 2 friends; the two strangers on the same
   channel are absent.
6. **Together · privacy mix** → "1 friend watching with you".
7. **Together · nobody yet** → no Together surface; friends appear as
   destinations with JOIN.
8. **Together · 10 friends**, drag the panel to its minimum → five buttons still
   fit, nothing overflows, all ten people visible.
9. **Together · stale friend**, press `+90s` → they drop out.
10. Change the observer's channel → the surface disappears; change back → it
    returns, empty.

### B. Two real Twitch accounts

**After applying migration 0019.**

1. **A** opens `twitch.tv/<streamer>`.
2. **B** sees `🔥 <streamer> · 1` in Gravity and clicks **JOIN**.
3. B arrives → the same card becomes HERE with "1 friend watching with you" and
   a reaction row. **No room was created.**
4. A reacts 😂 → it appears for B within a second, and for A.
5. B reacts 😂 within 4 seconds → both see **😂 ×2**.
6. B presses 🔥 five times → no counter.
7. A moves to a different stream → B's Together dissolves; B's card becomes a
   destination with a JOIN again.
8. **Negative:** put A and B on different streams and react → neither sees the
   other's reaction.
9. **Negative (needs a third account):** C, not friends with A or B, on the same
   stream → C sees nothing from either, and neither sees C.

To simulate failure locally: sign out, or leave 0019 unapplied — sends fail and
nothing arrives, while the surface and participants stay correct.

---

## 14. Git

24 files, +2,915 / −2. One clean commit, pushed, no force push.

```
3b8eebd feat: add automatic together rooms
db0acfa..3b8eebd  main -> main
```

Secret scan over the staged diff (JWTs, bearer tokens, private keys, hex
secrets, service-role, client secrets, passwords) returned **nothing**. No new
secrets exist — this checkpoint adds no external service.

---

## 15. Deferred

- **Groups × Together** — as a notification filter rather than a participant
  filter. Architecturally compatible; not built.
- **Promoting a Together into a Group** — it already knows a channel and a set
  of user ids. Not built.
- **`from_join` on `together_surface_shown`** — declared in the contract but not
  emitted; the same fact is derivable by joining the existing funnel on actor,
  channel and time, which avoids a second source for it.
- **Arrival/departure lines** ("Jake joined") — the participant list updating is
  already the signal, and a message per arrival is exactly the notification
  spam the brief warned against. Reconsider only if real use shows people miss
  arrivals.
- **Sound** — v1 has none, and any future version must be opt-in.
- **Fan-out mitigations** — listed in `docs/TOGETHER.md`, none worth building.
- **`kickbackMetadata.check()` not callable in DevTools** — pre-existing tooling
  debt, untouched; this checkpoint did not go near that surface.

Growth milestone not started.
