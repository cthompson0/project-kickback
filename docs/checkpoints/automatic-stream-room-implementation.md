# Automatic Stream Rooms — Implementation

Commit `faa6df5` — `feat: converge automatic stream rooms`. Pushed to `main`.

Architecture: [automatic-stream-room-convergence.md](automatic-stream-room-convergence.md).

**One action required: apply migration 0020.**

---

## 1. Architecture implemented

```
presence (unchanged)  ──┐
friendships (unchanged) ├─▶ stream_room_members(channel)   SECURITY DEFINER
                        │      seeded at auth.uid()
                        │      ≤3 hops, ≤50 members, cycle-guarded
                        │      returns MEMBERS, never edges
                        ▼
              KickbackState.roomMembers  ──▶  the HERE card
                        │
send_together_reaction ─┴─▶ one row PER RECIPIENT
                                 ▼
             kickback-together:<userId>, filter recipient_id=eq.<me>
             RLS: recipient_id = auth.uid()
```

**Nothing is stored.** No room record, no membership table, no lifecycle. A
room is the answer to a question, asked again when presence changes — which is
why merge and split need no ceremony: they *are* recomputation.

| New | Purpose |
|---|---|
| `src/core/streamRoom.ts` | member model, hop semantics, bounds |
| `src/background/streamRoom.ts` | asks the server, caches for 90 s, forgets on move |
| `supabase/migrations/0020_stream_rooms.sql` | the walk, the fan-out, the policy |

| Rewritten | Why |
|---|---|
| `src/core/together.ts` | reactions are Kickback emotes; `reactionBursts`/`isCombo` deleted |
| `src/background/togetherReactions.ts` | per-user inbox instead of per-channel topic |
| `src/ui/components/Together.tsx` | one combo engine, plus the roster |

Groups, GroupChat, presence RLS and the metadata service are untouched.

---

## 2. UI behaviour

Gravity → JOIN → arrival, and the **same card** becomes the room:

```
   LVNDMARK · 2                         HERE
   Escape from Tarkov · ● LIVE · 18K
   2 friends watching with you
   Jake · Matt
   [lol][heart][fire][sad][eyes]   lol ×2   [ROOM]
```

`ROOM` expands the roster in place:

```
   Jake
   Sarah
     Friend of Jake
```

- Reaction buttons are Kickback's inline-SVG artwork, the same drawings group
  chat uses. No unicode palette anywhere — asserted.
- The reaction row is **one line that never changes height**; the browser gate
  measures the card before and after a reaction and fails on >1 px movement.
- A combo is **one badge with a count**, not symbols side by side.
- One hop of context only: `Friend of Jake` at two hops, nothing at three.
- Somebody Kickback has no identity for gets a neutral mark rather than an
  invented avatar.
- UserCards open from the roster and are anchored to the card, so they keep the
  width fixed in the previous checkpoint.
- No text, no unread, no room name, no create/leave/invite.

---

## 3. Migration / deployment

**MIGRATION REQUIRED — `supabase/migrations/0020_stream_rooms.sql`**

```bash
npm run db:bundle
```
→ **Supabase → SQL Editor → New query** → paste
`supabase/.generated/apply_all.sql` → Run.

Idempotent, no CLI, no database password. **No Edge Function, no secrets, no
deployment step.**

It contains:

1. `presence_channel_idx` — partial index; the walk starts from "everyone on
   this channel", which was otherwise a sequential scan.
2. `stream_room_members(text)` — the component walk. Granted to `authenticated`.
3. `together_reactions` **dropped and recreated** with `recipient_id`. The table
   holds at most a minute of ephemeral events, so there is nothing to migrate
   and a guarded rename sequence would be more ways to be half-applied.
4. `send_together_reaction` — recomputes the component and fans out.
5. Analytics: four `automatic_room_*` names.

**Reload the extension** after applying, so the worker picks up the per-user
inbox. Until 0020 is applied, sends fail and nothing arrives; the room surface
still forms and still shows who is here, because that comes from presence.

The four `together_*` event names from 0019 are **left registered**. That is not
tidiness: `analytics_events.event_name` has a foreign key to the contract table
and beta recorded real events under them, so deleting the rows would fail the
migration. `tests/extension/analyticsContract.test.ts` lists them as retired so
that dropping an event stays deliberate.

---

## 4. Bug A — root cause and resolution

**Root cause: `postgres_changes` was the wrong transport, and the topic name
broke this codebase's own pattern.**

Every pre-existing realtime topic is unique per user:

```
kickback-social:<userId>
kickback-presence:<n>:<firstFriendId>
kickback-groups:<userId>:<n>
kickback-together:lvndmark            ← 0019. Identical for every viewer.
```

Presence binds **one subscription per friend**, so every presence row matches
exactly one subscription. 0019's reactions had every viewer on the *same*
filter, so one row matched *many* — the precise trigger for a documented
hosted-only Supabase defect where **only the most recently created subscription
receives** ([supabase/realtime#1524](https://github.com/supabase/realtime/issues/1524)).
Whoever subscribed last got reactions; the other side got nothing.

**It was never friendship direction.** `is_friend` is symmetric, and
`link_friendship` inserts both mirrored rows atomically —
`values (p_a, p_b), (p_b, p_a)`. I verified both before looking further.

**Resolution — by shape, not patch:**

| | 0019 | 0020 |
|---|---|---|
| Rows | one per reaction | one per recipient |
| Topic | `…:<channel>`, shared | `…:<userId>`, per user |
| Filter | `channel=eq.X` | `recipient_id=eq.<me>` |
| RLS | `is_friend(user_id)` | `recipient_id = auth.uid()` |
| Recipients decided | read time, per subscriber | write time, once |

Every row now has exactly one interested subscriber — the property presence has
always had. Supabase's own documentation confirms this is also cheaper:
*"Postgres Changes authorizes every event against each subscriber."*

Symmetry is an acceptance requirement and is asserted directly: the inbox test
delivers from another sender and from the viewer themselves and requires both,
and the lab test sends in both directions.

---

## 5. Bug B — root cause and resolution

**Root cause: there were two combo systems, and mine had a different output
shape.**

`scanCombos` walks a timeline, finds runs of the same emote from *different*
senders, and annotates the run's last entry — so `×3` appears **in place** and
grows. My `reactionBursts` returned an **array of bursts** and the UI rendered
**every one side by side**. Three reactions became three floating symbols.

**Resolution: delete the duplicate and change the currency.**

Kickback already had its own emotes — `lol`, `heart`, `fire`, `sad`, `eyes` —
which are exactly the reaction palette. A reaction *is* one of them, so:

- `scanCombos` counts them, unchanged;
- `ComboBadge`'s `×N` treatment applies;
- `EmoteImage` draws the artwork;
- `reactionBursts` and `isCombo` are gone.

The combo engine itself was **not modified** — no widened key, no injected
extractor. Changing the currency was enough.

One residual half of the stacking was found by the render test: the engine
annotates only the run's *last* contribution, because in a chat the earlier ones
are still separate messages above it. Here they are not, so the contributors
behind each annotation are folded into the badge — reconstructed from the
engine's own count rather than by re-deciding its rules.

**Combo breakers** are preserved and reused, and cannot fire in a reaction-only
stream: a breaker is an ordinary message interrupting a run, and there are no
ordinary messages here. That is asserted rather than left implicit, and it is
why v1 having no text is what makes the rule dormant rather than removed.

---

## 6. Privacy and security

| Threat | Answer | Tested |
|---|---|---|
| Client crawls the friendship graph | The walk is server-side; it returns members, never edges, and is seeded at `auth.uid()` — there is no parameter naming a user | ✓ |
| "Give me all friends-of-friends globally" | The function takes a *channel*, and refuses unless the caller's presence says they are on it | ✓ |
| Stranger on the same stream gains presence | Not in the component; never a recipient; never returned | ✓ |
| Unrelated cluster on one destination | Two components, computed independently | ✓ lab |
| Friend-of-friend leaks beyond the room | Contextual only — the moment they leave, membership returns nothing | ✓ lab |
| Global presence RLS weakened | Untouched. 0020 adds an index, no policy | ✓ |
| Sender spoofing | `require_actor()`; no sender parameter | ✓ |
| Reacting into a cluster you are not in | Recipients come from the walk; the RPC refuses if you are not present | ✓ |
| Enumerating members without being connected | Same presence guard | ✓ |
| Stale ex-participant keeps receiving | Recipients fixed at write time; a departed user gets no new rows | ✓ |
| Old merged-room subscription persists | The subscription is per **user**, not per room — it only ever delivers rows addressed to you | ✓ |
| Runaway traversal | 3 hops, 50 members, cycle-guarded on `path` | ✓ |
| Malformed payload | Closed emote set, validated in SQL and again in the client parser | ✓ |
| Reaction spam | `consume_rate_budget('together_reaction', 60, 1 minute)` | ✓ |
| Analytics leaking content | Only counts and a direction; property names asserted | ✓ |

**One hop of context** is the deliberate limit on what the room reveals about
the graph: `Friend of Jake` at two hops, and nothing at three. The client parser
drops a connector outside two hops rather than carrying it around.

---

## 7. Test Lab

The lab now models friendships **between** simulated people (`SimWorld.edges`),
which is the only way these graphs can exist at all — the observer's own edges
still drive `relationship`, because that is what presence visibility depends on.

Nine presets, one per scenario in the brief:

| Preset | Proves |
|---|---|
| Room · A↔B | the smallest room |
| Room · A↔B↔C | a friend-of-friend is a member, with `Friend of` context |
| Room · A↔B↔C↔D | three hops reachable, ordered 1/2/3 |
| Room · two clusters | disconnected clusters stay separate |
| Room · bridge left | the room splits when the connector goes |
| Room · clusters merged | a new edge makes one room, a strict superset |
| Room · unrelated stranger | same stream, no path, invisible |
| Room · friend-of-friend left | contextual visibility ends |
| Room · 10 people | the hop limit holds on a long chain |

The lab computes the component itself — the one place it duplicates production,
because the real one is SQL inside Postgres. A dedicated describe block reads
**both** and asserts they agree on hops, member bound, staleness window, the
presence guard and the two-hop connector rule.

`verify:lab` drives all of it in a real browser: room formation, a single
reaction, a two-person combo reading `×2` as **one** badge, one person hammering
a button producing none, the roster for each graph, and the hop limit at a
260 px panel.

---

## 8. Verification

| Command | Result | Time |
|---|---|---|
| 24 affected test files (666 tests) | pass | **5 s** |
| `npx tsc -b --force` | pass | 6 s |
| `npm run lint` | pass | 8 s |
| `npm run build` | pass | 6 s |
| `npm run verify:lab` (real Chrome) | pass | 24 s |

No mutation testing, no unrelated suites. Nothing near the 5-minute limit.

Four things were found by tests rather than by inspection, and all four were
real:

1. **Residual stacking** — the render test caught that folding annotated runs
   was not enough; earlier contributors still drew separately.
2. **The analytics contract test** correctly refused a contract registering
   events the client no longer emits. Investigating showed the rows *cannot* be
   deleted (foreign key from recorded events), so the test now distinguishes
   retired names from drift.
3. **A stale membership answer** landing after the viewer moved — the fixture
   answered identically for every channel, hiding it.
4. **The browser gate's `openRoom` was toggling** — the roster stays open across
   preset changes, so a blind click closed it.

---

## 9. Manual acceptance test

### A. Test Lab — the graphs (no accounts needed)

```bash
npm run dev:lab          # http://localhost:5199
```

1. **Room · A↔B** → HERE card, reaction strip, `ROOM` control.
2. Click `ROOM` → roster shows Bianca.
3. Click a reaction under Bianca in the lab, then a strip button yourself →
   **one badge reading `×2`**, not two symbols.
4. Click one person's `fire` five times → **no** counter.
5. **Room · A↔B↔C** → roster shows two people, the second captioned
   `Friend of Bianca`.
6. **Room · A↔B↔C↔D** → three people, hops 1/2/3, no caption on the third.
7. **Room · two clusters** → roster shows **one** person; Dana and Eli are absent.
8. **Room · clusters merged** → the same world plus one edge → **three** people.
9. **Room · bridge left** → no room at all.
10. **Room · unrelated stranger** → roster shows one; the stranger never appears.
11. **Room · 10 people**, drag the panel to minimum → roster shows **three**
    (the hop limit), five buttons still fit, nothing overflows.
12. **Room · friend-of-friend left** → only the direct friend remains.

### B. Two real Twitch accounts

**After applying 0020 and reloading the extension in both browsers.**

1. **A** opens `twitch.tv/<streamer>`.
2. **B** sees `🔥 <streamer> · 1` in Gravity → clicks **JOIN**.
3. B arrives → the same card becomes HERE with the reaction strip and `ROOM`.
   **No room was created.**
4. Both click `ROOM` → each sees the other.
5. **A reacts → B sees it.**
6. **B reacts → A sees it.** *(This is the acceptance requirement Bug A broke.)*
7. Both react with the same emote within four seconds → both see **one badge
   `×2`**.
8. B presses the same button five times alone → no counter.
9. A moves to another stream → B's room empties within ~90 s (or immediately on
   B's next presence update); B's card becomes a destination with a JOIN again.
10. **Negative:** put A and B on different streams and react → neither sees the
    other.

Friends-of-friends, merges, splits and cluster isolation are **not** testable
with two accounts — that is what §A is for.

---

## 10. Git

24 files, +2,460 / −967. One clean commit, pushed, no force push.

```
faa6df5 feat: converge automatic stream rooms
2720015..faa6df5  main -> main
```

Full staged diff reviewed. Secret scan (JWTs, bearer tokens, private keys, hex
secrets, service-role, client secrets, passwords) returned **nothing** — this
checkpoint adds no external service and no new credential.

`docs/TOGETHER.md` is marked superseded rather than deleted, pointing at the
convergence architecture and this report.

---

## 11. Deferred

- **Text in automatic rooms.** Decided against for v1 and unchanged. Adding it
  is what would force room identity and merge/split continuity into existence.
- **Promoting a room into a Group.** A room already knows a channel and a member
  set, which is `create_group` plus invites. Not built.
- **Membership push.** Membership is polled at 90 s and on channel change; a
  friend arriving is visible on the next presence tick. Making it realtime would
  mean either a subscription per room or recomputation on every presence write —
  neither worth it until rooms are demonstrably used.
- **Room-scoped analytics on friend requests.** `friend_request_sent` carries a
  `source`, so Gravity → JOIN → room → new friend edge is measurable, but the
  UserCard does not yet pass `together` as the source. One line when wanted.
- **Fan-out scale mitigations** — collapsing bursts before write, per-user inbox
  channels, moving reactions off Postgres. Listed in the convergence doc; none
  worth building at current scale.
- **`kickbackMetadata.check()` DevTools debt** — untouched.

Growth milestone not started.
