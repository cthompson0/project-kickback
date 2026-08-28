# KICKBACK 0025 — MULTI-DESTINATION PRESENCE

**Date:** 2026-08-28
**Baseline:** `55a3149` (v0.4.1 release prep)
**Migration created:** `supabase/migrations/0025_presence_destinations.sql` — **NOT applied to hosted**
**Analytics schema:** local **25**, hosted still **24**
**Extension version:** unchanged at **0.4.1** — see §16

## ⚠ STATUS: PARTIAL — the milestone is NOT complete

**The server model and the presence/Gravity half are implemented, tested and
verified. The Stream Room client rework and the multi-room UI are NOT.**

This is stated first because everything below must be read in that light. What
landed is coherent, safe and fully tested; it is not the whole milestone, and
this report does not claim otherwise.

**No hosted Supabase change was made. Nothing was uploaded to the Chrome Web
Store. The pending v0.4.1 store artifact was not touched, rebuilt or
resubmitted. No `0026` cleanup was created.**

---

## 1. Executive summary

The approved architecture divides cleanly into two halves, and I completed the
first and did not complete the second.

**Half one — the presence model — is done.** `public.presence` keeps its job as
account liveness; a new `public.presence_destinations` child table holds the
set of open streams. Every "is this person present at this channel" question in
the database now goes through one function, `is_present_at(user, channel)`,
which makes the parent-liveness gate structural rather than remembered: a
destination row is only ever an *inner* condition on a live account, so a
crashed browser's rows become invisible at ninety seconds no matter how fresh
their own timers are. The cap of three is enforced server-side. The client
publishes a set, Gravity consumes every active destination, and a v0.4.1 client
keeps working unchanged and stays mutually visible with a new one.

**Half two — the Stream Room client — is not done.** Room messages, reactions,
the room roster and the panel's session tab are still keyed to a single
`sessionChannel()`. The temporary `sessionAvailable` workaround from Patch 1 is
still in place and was *not* removed, because removing it without the
multi-room lifecycle behind it would leave the room surface worse than it is
today. §22 lists exactly what remains.

**Why I stopped rather than pushed on.** The remaining work is not a tidy-up: it
is re-keying four stateful modules and the panel's tab model, plus the DOM tests
that would make any of it trustworthy. Doing it hurriedly would have produced an
untested room surface on top of a presence change — and the room surface is the
part testers actually touch. The instruction not to falsely report success is
better served by a precise boundary than by a rushed second half.

**What is safe about the intermediate state:** the migration is additive; old
clients are unaffected; the new client's room behaviour is exactly what it is
today (single primary channel), because `is_present_at` accepts a destination
just as it accepts the legacy channel. Nothing regressed.

**Verification:** 70 files / 1849 tests / **0 failures, 0 skips**. Typecheck,
lint, build and all four verifiers clean.

---

## 2. Architecture implemented

```
        ┌──────────────────────────────┐
        │  public.presence             │   ACCOUNT LIVENESS
        │  status, last_seen_at        │   heartbeat 45s, stale 90s
        │  channel  ← legacy, retained │   (what a v0.4.1 client reads)
        └──────────────┬───────────────┘
                       │ 1..n, gated
        ┌──────────────▼───────────────┐
        │  public.presence_destinations│   OPEN STREAMS
        │  (user_id, channel) PK       │   opened_at, last_active_at
        │  ACTIVE while < 30 minutes   │   max 3, server-enforced
        └──────────────────────────────┘

        is_present_at(user, channel)
          = account online AND fresh (90s)
            AND ( destination active (30m)  OR  legacy presence.channel )
```

**Client-local, never published:** OPEN, FOCUSED, PRIMARY. There is no column,
no parameter and no RPC argument anywhere in this migration that could carry a
focused tab, and none was added. `document.hasFocus()` is not read. No `tabs`
permission. Switching between two already-open Twitch tabs produces **no write
at all** — the reporter compares the set and returns early.

---

## 3. Migration contents and behaviour

`supabase/migrations/0025_presence_destinations.sql`, one transaction.

| Object | Kind | Behaviour |
| --- | --- | --- |
| `presence_destinations` | new table | PK `(user_id, channel)`; `platform`, `opened_at`, `last_active_at`; channel bounded `^[a-z0-9_]{1,25}$` — the same bound as `presence.channel`, so any legacy value is representable |
| `presence_destinations_channel_idx` | new index | `(channel, last_active_at desc)` — "who is on this channel" is the hot path in `stream_room_members` |
| RLS + grants | new | `select` to `authenticated`; all DML revoked. Writes go only through SECURITY DEFINER functions |
| `presence_destinations_select` | new policy | authorization **and** liveness **and** the 30-minute window |
| `is_present_at(uuid, text)` | new fn | The one predicate. SECURITY DEFINER, granted to `authenticated` because policies evaluate as the caller |
| `apply_destinations(uuid, text[])` | new internal fn | Validate → lowercase → de-duplicate → cap at 3 → upsert → delete the rest. Returns the kept, ordered set. Revoked from every client role |
| `report_destinations(text[])` | new RPC | What a new client calls. Rate limit, visibility redaction, then `apply_destinations`, then the legacy singleton. Returns how many were kept |
| `report_presence(text, text)` | **replaced, behaviour preserved** | Identical to before, plus it mirrors its singleton into one destination row |
| `report_offline()` | **replaced** | Also deletes the account's destination rows |
| `list_friend_destinations()` | new RPC | SECURITY INVOKER, seeded at the caller's own graph. The minimum new read surface |
| `stream_room_members(text)` | **replaced** | Presence predicate widened; walk, blocks, hop bound and 50-cap untouched |
| `send_room_message(text, text)` | **replaced** | Presence gate via `is_present_at`; fan-out unchanged |
| `send_together_reaction(text, text)` | **replaced** | Same |
| realtime publication | additive | `presence_destinations` added, guarded and idempotent |
| `analytics_event_names` | +2 rows | `destinations_published`, `automatic_room_left` |
| `analytics_schema_version()` | replaced | 24 → **25** |

### Idempotency

`apply_destinations` is dropped by exact signature before creation, because its
return type changed shape during development and `create or replace` cannot
change a return type (42P13). **Verified: the full bundle applies twice in a row
against a fresh Postgres with no error.**

### Nothing is dropped

No column removed, no function deleted, no policy narrowed, no data migrated.

---

## 4. RLS and security model

**Unchanged:** the friendship walk, `blocked_pair` on the join, the three-hop
bound, the path cycle guard, the 50-member cap, per-recipient message
materialisation, the pairwise delivery filter, and every existing policy.

**New policy**, which is the presence policy plus two gates:

```sql
using (
  ( user_id = auth.uid() or is_friend(user_id) or shares_group_with(user_id) )
  and last_active_at > now() - interval '30 minutes'
  and exists ( select 1 from presence p
                where p.user_id = presence_destinations.user_id
                  and p.status = 'online'
                  and p.last_seen_at > now() - interval '90 seconds' )
)
```

Blocks are inherited rather than restated — they already live inside
`is_friend` and `shares_group_with` from 0022.

**Not a directory.** `list_friend_destinations()` takes no channel and is seeded
at the caller's own social graph, so it cannot answer "who is watching X".
`stream_room_members` remains the only channel-seeded entry point, and it still
refuses a caller who is not themselves present. **Tested:** a non-friend reading
the raw table gets zero rows; a friend-of-nobody sees only their own friend.

---

## 5. Old-client compatibility

**A v0.4.1 client changes nothing and keeps working.**

| What it does | What now happens |
| --- | --- |
| `report_presence('twitch','shroud')` | Liveness + `presence.channel` exactly as before, **plus** one destination row mirroring the singleton |
| `report_presence(null,null)` | Clears the destination too |
| `list_friends()` | **Untouched.** Still one channel per friend — the primary |
| `report_offline()` | Also clears destinations |
| Sharing a room with a new client | Works both ways — `is_present_at` accepts either evidence |

**Tested in both directions:** an old client on `shroud` and a new client on
`shroud + lirik` each find the other in `stream_room_members('shroud')`.

The new client's primary is written to `presence.channel`, so an old client
reading `list_friends()` sees something true — a subset, not a wrong answer.

---

## 6. New-client presence behaviour

`activity.ts` grew a `destinations()` accessor beside `effective()`:

- de-duplicates by channel, so **duplicate tabs collapse before the cap** — two
  tabs on shroud must not consume two of three slots;
- orders by `updatedAt` descending, which is what "most recently active" means
  and what decides the server's legacy primary;
- caps at 3 locally as a courtesy; the server is the boundary;
- **visibility is deliberately not a factor** — a hidden tab is still an open
  stream, and focus never reaches the network.

`presence.ts` gained `setDestinations()`, debounced on the same 1s clock and
**skipped entirely when the set is unchanged**. `effective()` still drives
`setActivity` for HERE and attribution and is never published as a field.

---

## 7. Max-3 enforcement

In `apply_destinations`, server-side, before any write:

```
validate → lowercase → de-duplicate → exit when 3 reached
```

`report_destinations` returns how many were kept, so the client learns the cap
bit rather than inferring it. **Tested:** four channels → 3 kept, returns 3;
`['shroud','shroud','lirik','summit1g']` → 3 kept including all three distinct
streams, proving de-duplication precedes the cap.

---

## 8. Parent-liveness gating

The single most important property, and the one with the most tests.

Liveness is the **outer** `exists` in `is_present_at` and a separate `exists` in
the policy. A destination can only narrow a live account; it can never assert
presence on its own.

**Tested:**

- friend's destinations visible while live;
- after ageing `last_seen_at` to 120s: rows still present, still within their
  own 30-minute window, and **invisible to the friend** — through the reader
  *and* through a raw table read;
- `is_present_at` returns false;
- a heartbeat brings them straight back;
- `stream_room_members` empties of a stale member;
- a stale account cannot send to a room it "has" a destination for.

---

## 9. Duplicate-tab / port lifecycle

The client reports a **set**, so this is structural rather than bookkeeping.

| Scenario | Behaviour |
| --- | --- |
| Tab A → shroud, Tab B → shroud, Tab C → lirik | Published: `shroud, lirik` |
| Close Tab A | Set is unchanged → **no write at all**, shroud stays |
| Close Tab B | shroud leaves the set → one write |
| Rapid open/close | 1s debounce; unchanged sets are dropped before the timer even fires |
| Port dies without a clean disconnect | The set stops including it on the next report; if the worker itself dies, the account goes stale at 90s and everything vanishes |

---

## 10. Social Gravity

`clusterMembers` is **unchanged** — the architecture report was explicit that
HERE, group rosters, the user card, JOIN eligibility and Gravity must keep
answering from one interpretation. What changed is its input: `KickbackPanel`
now expands each friend into **one entry per active destination**, each carrying
the same presence with a different channel.

Presence at a destination is **binary**. Somebody with three streams open counts
once at each. There is no weight, no score, and nowhere to put one.

A friend with no destination entry falls back to their presence as it stands —
which is what keeps a v0.4.1 friend in Gravity during rollout.

Block behaviour, self-exclusion, metadata enrichment, the gathering threshold
and JOIN semantics are all untouched.

**Not yet covered by a test.** See §22.

---

## 11–13. Stream Room lifecycle, multi-room client state, reactions

## **NOT IMPLEMENTED.**

The server supports all of it — a user with three destinations is a full member
of three rooms, can send to each, and messages and reactions are channel-isolated
end to end (**tested**, §20 rows 19–21). The *client* does not yet expose it.

Still single-channel, all keyed off `sessionChannel()`:

- `src/background/roomMessages.ts` — clears its buffer on channel change
- `src/background/togetherReactions.ts` — one current channel
- `src/background/streamRoom.ts` — one cached roster
- `src/ui/KickbackPanel.tsx` — one `SessionTab`, and the Patch 1
  `sessionAvailable` workaround **still present and still labelled temporary**

**The temporary workaround was deliberately left in place.** Removing it is only
correct once the multi-room lifecycle replaces it; removing it now would leave
the room surface worse than it is in the shipped build.

**Encouraging note for whoever finishes this:** the two message stores are closer
than they look. `RoomMessage` and `TogetherReaction` both already carry
`.channel`, and `liveMessages(messages, channel)` / `liveReactions(reactions,
channel)` already filter by it. The buffers are *already* channel-tagged — the
only single-channel behaviour is `setChannel()` clearing on change. `streamRoom`
needs a real Map, and the panel needs N tabs.

---

## 14. Realtime

**Patch 1's hardening is preserved and not regressed.** `realtimeTopics.ts` is
untouched; every channel still goes through `openChannel()` with the per-topic
teardown gate and content-addressed topics.

**No new subscription was added.** `presence_destinations` was added to the
publication so a future client *can* subscribe, but the current client refreshes
through `list_friend_destinations()` on signals it already has — friend-list
changes, presence events (coalesced to at most one query per second) and the
existing 30-minute alarm. Subscription count is unchanged: still one binding per
friend, one per group, one each for the per-user inboxes.

No Redis, no Kafka, no custom WebSockets. Friend-list scale is out of scope and
untouched.

---

## 15. Analytics

Two events registered in 0025 and declared in `src/core/analytics.ts`:

| Event | Properties | Emitted? |
| --- | --- | --- |
| `destinations_published` | `count_bucket` (`none`/`one`/`two`/`three`), `at_max` (bool) | **Yes**, from the presence reporter's write callback |
| `automatic_room_left` | `reason`, `had_messages` | **Registered, not yet emitted** — it belongs to the room lifecycle work in §11 |

`count_bucket` is enumerated rather than an integer so it can never become a
fingerprint, and `at_max` is read back from the **server's** answer rather than
inferred from what was sent — which is the only way to know the cap actually
bit.

**No channel names, no URLs, no browsing history, no message bodies, no emails,
no friend codes, no tokens, no free-form text.** The existing client-side
`EVENT_PROPERTIES` whitelist, the server-side `allowed_properties` array and the
64-character value cap all apply unchanged.

---

## 16. UI changes

**Gravity only**, and it is a data change rather than a visual one: a friend
watching two streams now appears in both clusters. Nothing was redesigned, no
tab manager, no browser-tab details, no focus displayed.

**Version deliberately not bumped.** This repository bumps at release prep — that
is what `chore: prepare 0.4.1 beta release` did, and `verify:store` enforces
manifest/package agreement at that point. Bumping mid-development would also
disturb the artifact currently pending Store review. **Left at 0.4.1, reported
as a decision.**

**No changelog entry added.** The next release version is not chosen, and this
repository's changelog convention is release-named sections written at release
prep. Adding an `Unreleased` heading would invent a convention the file does not
have.

**No new browser permissions.** The manifest is byte-identical.

---

## 17. Files changed

| File | Change |
| --- | --- |
| `supabase/migrations/0025_presence_destinations.sql` | **new** — the migration |
| `src/background/activity.ts` | `destinations()`, `MAX_DESTINATIONS` |
| `src/background/presence.ts` | `setDestinations`, `lastDestinations`, `onDestinations`, backend method |
| `src/background/supabaseBackend.ts` | `reportDestinations`, `listFriendDestinations` |
| `src/background/index.ts` | publish the set; friend-destination map, refresh triggers, broadcast; `destinations_published` |
| `src/client/types.ts` | `friendDestinations` on state |
| `src/ui/KickbackPanel.tsx` | Gravity expansion per destination |
| `src/core/analytics.ts` | two events, `DestinationCountBucket`, `RoomEndReason`, `destinationBucket()` |
| `tests/db/bundle.test.ts` | schema marker 24 → 25 |
| `tests/db/presenceDestinations.test.ts` | **new** — 39 tests |
| `tests/extension/presence.test.ts` | fake gains `reportDestinations` |
| `tests/extension/roomResolution.test.tsx`, `tests/extension/togetherStore.test.ts` | fakes gain `reportDestinations` |
| `docs/reports/0025-multi-destination-implementation-2026-08-28.md` | this report |

---

## 18. Tests added

**`tests/db/presenceDestinations.test.ts` — 39 tests**, in seven groups:
publishing (10), the liveness gate (6), visibility (5), privacy (3), sign-out
(1), old-client compatibility (6), rooms with multiple destinations (8).

Existing fakes updated to satisfy the widened `PresenceBackend`. **No assertion
was weakened**; the bundle schema-marker expectation moved 24 → 25 because 0025
now owns it.

---

## 19. Verification results

| Command | Exit | Result |
| --- | --- | --- |
| `npm run db:bundle` | 0 | 25 migrations |
| bundle applied twice to fresh Postgres | — | **APPLIED OK / RE-APPLIED OK**, `analytics_schema_version = 25` |
| `npm run build` | 0 | both bundles |
| `npx vitest run` | **0** | **70 files / 1849 tests / 0 failures / 0 skipped** |
| `npx tsc -b` | 0 | clean |
| `npx eslint .` | 0 | clean, 0 warnings |
| `npm run verify:groups` | 0 | group backend applied |
| `npm run verify:config` | 0 | key accepted, Twitch auth enabled |
| `npm run verify:analytics` | 0 | schema present, nothing client-readable |
| `npm run verify:store` | 0 | repository agrees with itself |

`npm run test:authz` **not run**, as instructed.

### Test totals

| | Files | Tests |
| --- | --- | --- |
| Baseline (`55a3149`) | 69 | 1808 |
| Now | **70** | **1849** |
| Δ | **+1** | **+41** |

The +1 file is `presenceDestinations.test.ts`. Of +41 tests, 39 are that file;
the other 2 are the analytics contract suite, which generates one case per
registered event and gained two.

---

## 20. Failure-mode matrix

| # | Case | Status |
| --- | --- | --- |
| 1 | one user / one destination | ✅ tested |
| 2 | one user / two destinations | ✅ tested |
| 3 | one user / three destinations | ✅ tested |
| 4 | fourth destination → server max-3 | ✅ tested (returns 3, keeps first 3) |
| 5 | duplicate tabs collapse to one destination | ✅ tested (server) + client `destinations()` de-dupes |
| 6 | closing one duplicate does not remove it | ✅ set unchanged → no write. **Not yet unit-tested** |
| 7 | closing the last duplicate removes it | ✅ same mechanism. **Not yet unit-tested** |
| 8 | rapid channel changes | ✅ 1s debounce + unchanged-set skip. **Not yet unit-tested** |
| 9 | **heartbeat expires, destinations still <30m → invisible** | ✅ **tested, 3 ways** |
| 10 | destination exceeds 30m, account live | ✅ tested |
| 11 | sign-out | ✅ tested |
| 12 | old-client singleton compatibility | ✅ tested (4) |
| 13 | old and new clients coexist | ✅ tested (both directions, shared room) |
| 14 | block relationship | ✅ tested (both directions) |
| 15 | friend authorization | ✅ tested |
| 16 | non-friend cannot enumerate | ✅ tested (reader + raw table) |
| 17 | Gravity counts one user at several destinations | ⚠ **implemented, not tested** |
| 18 | self exclusion | ✅ tested (reader excludes caller); `clusterMembers` unchanged |
| 19 | multiple simultaneous Stream Rooms | ⚠ **server tested; client not implemented** |
| 20 | messages for A do not appear in B | ✅ tested |
| 21 | reactions isolated by channel | ✅ tested |
| 22 | retained-message room survives peer leaving | ❌ **not implemented** (Patch 1 workaround still in place) |
| 23 | retained room disappears after retention | ❌ **not implemented** |
| 24 | returning to a retained room restores history | ❌ **not implemented** |
| 25 | crash/sleep via stale parent presence | ✅ tested |
| 26 | stale child row does not leak | ✅ tested |
| 27 | realtime re-subscribe does not regress | ✅ `realtimeTopics` untouched; its 14 tests pass |
| 28 | no new browser permissions | ✅ manifest byte-identical |
| 29 | legacy `list_friends` still usable | ✅ tested |

**21 of 29 verified by test. 3 implemented but untested (6, 7, 8, 17). 5 not
implemented (19 client, 22, 23, 24).**

---

## 21. Known limitations

1. **The room client is single-channel.** A user with three destinations is a
   member of three rooms server-side but sees one in the panel.
2. **`automatic_room_left` is registered but never emitted.**
3. **Gravity multi-destination expansion has no test.** It is a small,
   reviewable change, but "implemented" is not "verified".
4. **Destination refresh is polled, not pushed.** `presence_destinations` is in
   the realtime publication but nothing subscribes; the client re-reads on
   presence events, coalesced to at most one query per second. Adequate at beta
   scale, and it deliberately does not add a subscription.
5. **Friend-list scale is unchanged and still one binding per friend.** Out of
   scope, as instructed.

---

## 22. Deliberately deferred

**To finish this milestone:** re-key `roomMessages`, `togetherReactions` and
`streamRoom` by channel; multi-tab room UI; **remove the temporary
`sessionAvailable` workaround**; emit `automatic_room_left`; DOM tests for
multi-room state; tests for failure modes 6, 7, 8, 17, 19, 22, 23, 24.

**Deferred by instruction:** `0026` cleanup (dropping `presence.channel`,
`presence.platform` and the legacy branch in `is_present_at`) — only after every
tester is upgraded. Firefox, friend-list scale, group scale, `test:authz`.

---

## 23. Migration deployment instructions

**0025 must be applied to hosted BEFORE any extension release that depends on
multi-destination APIs.** No such release is proposed here.

1. `npm run db:bundle` (already run — 25 migrations)
2. Supabase → SQL Editor → New query
3. Paste **either** the whole of `supabase/.generated/apply_all.sql` (safe: the
   bundle is idempotent and verified to apply twice) **or** just
   `supabase/migrations/0025_presence_destinations.sql`
4. Run

This is the project's documented mechanism — `supabase/README.md` states the CLI
is deliberately not required. There is no migration-history bookkeeping to
reconcile.

---

## 24. Hosted verification queries

```sql
-- 1. The marker moves to 25.
select public.analytics_schema_version();

-- 2. The table and its index exist.
select column_name, data_type
  from information_schema.columns
 where table_schema = 'public' and table_name = 'presence_destinations'
 order by ordinal_position;

select indexname from pg_indexes
 where schemaname = 'public' and tablename = 'presence_destinations';

-- 3. RLS is on, and clients hold SELECT only.
select relrowsecurity from pg_class where relname = 'presence_destinations';
select grantee, privilege_type from information_schema.role_table_grants
 where table_name = 'presence_destinations' and grantee in ('anon','authenticated');

-- 4. The functions exist with the right signatures.
select p.proname, pg_get_function_identity_arguments(p.oid) as args
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
 where n.nspname = 'public'
   and p.proname in ('is_present_at','apply_destinations','report_destinations',
                     'list_friend_destinations','report_presence','report_offline',
                     'stream_room_members','send_room_message','send_together_reaction')
 order by p.proname;

-- 5. The two new events are registered.
select name, allowed_properties from public.analytics_event_names
 where name in ('destinations_published','automatic_room_left');

-- 6. Old clients are unaffected: a legacy write still yields a destination.
--    (Run as a real session, or inspect an existing account after a client reports.)
select user_id, channel, last_active_at from public.presence_destinations limit 10;
```

Then, from the repository: `npm run verify:analytics` — it should still report
*"Analytics schema is present, and nothing in it is readable by a client"*.

---

## 25. Rollback considerations

**The migration is additive and does not need rolling back.** Nothing was
dropped, and a v0.4.1 client is unaffected by its presence.

- **Client rollback:** revert the commit. The old client calls `report_presence`,
  which still works whether or not 0025 is applied.
- **Database rollback:** not recommended and not necessary. If it were ever
  required, dropping `presence_destinations` and restoring the 0024 versions of
  the six replaced functions would return the system to its prior behaviour —
  but leaving 0025 in place is harmless and is the safer default.
- **The irreversible step is `0026`**, which has not been written.
- **Ordering risk:** if the new client ships before 0025 is applied,
  `report_destinations` does not exist and every publish fails. It fails
  *safely* — the legacy `setActivity` path still maintains presence — and it now
  announces itself through `client_error`, but it must not happen.

---

## 26. Manual browser smoke checklist

Only meaningful **after 0025 is applied to hosted**. Load the unpacked build.

1. Open one Twitch channel. Confirm a friend sees you there as before.
2. Open a second and a third. Confirm the friend's Gravity now shows you at
   **all three** — and that you appear once per destination, not weighted.
3. Open a fourth. Confirm only three are published (the least recently active
   drops out).
4. Open a **duplicate tab** of one stream. Confirm nothing changes.
5. Close that duplicate. Confirm the destination **stays**.
6. Close the last tab for a stream. Confirm it disappears from the friend's view
   within a few seconds.
7. Switch between two already-open Twitch tabs repeatedly. Confirm the friend's
   view **does not change at all** — no flicker, no reordering. This is the
   headline behaviour.
8. Kill the browser. Confirm the friend sees you disappear entirely within ~90
   seconds, from all destinations at once.
9. Set visibility to "hide activity". Confirm you stay online and every
   destination vanishes.
10. Sign out. Confirm the same.
11. With a v0.4.1 device if one is available: confirm old ↔ new mutual
    visibility and a shared Stream Room.
12. Confirm the Stream Room still behaves exactly as it does today — one room,
    on your primary channel. **This milestone does not change it.**

---

## 27. Git status

Working tree at the time of writing, before any commit:

```
 M src/background/activity.ts
 M src/background/index.ts
 M src/background/presence.ts
 M src/background/supabaseBackend.ts
 M src/client/types.ts
 M src/core/analytics.ts
 M src/ui/KickbackPanel.tsx
 M tests/db/bundle.test.ts
 M tests/extension/presence.test.ts
 M tests/extension/roomResolution.test.tsx
 M tests/extension/togetherStore.test.ts
?? supabase/migrations/0025_presence_destinations.sql
?? tests/db/presenceDestinations.test.ts
?? docs/reports/0025-multi-destination-implementation-2026-08-28.md
```

`supabase/.generated/` is gitignored. No release ZIPs, no `.env.local`, no
credentials. The manifest and `package.json` are untouched.

---

## 28. Recommended next step

**Do not treat this as a finished milestone.**

1. **Review this report**, and in particular the §20 matrix and §22.
2. **Decide whether to apply 0025 to hosted now or when the client half is
   done.** Applying now is safe and unblocks local testing; waiting costs
   nothing because no release depends on it yet.
3. **Authorise the second half** — the room client rework in §22. It is the part
   testers will actually notice, and it is the reason the milestone exists.
4. Only then consider a release version and a changelog entry.

---

## 29. GO / NO-GO — applying 0025 to hosted Supabase

## **GO**

The migration itself is complete, self-consistent and well tested, and applying
it is low-risk and reversible in practice.

**Why GO despite the milestone being partial:**

- It is **purely additive** — nothing dropped, nothing narrowed, no data
  migrated.
- **v0.4.1 clients are unaffected**, and that is tested in both directions
  including a shared Stream Room.
- It **applies twice in a row without error** against a fresh Postgres, so
  pasting the whole bundle is safe.
- The client half that exists **already calls `report_destinations`**, so
  applying it is what makes local testing of that half possible at all.
- 39 dedicated tests cover the security-critical behaviour, including the
  parent-liveness gate three separate ways.

**Conditions:**

1. Apply via the SQL Editor — the project's documented mechanism.
2. Verify with §24, in particular that the marker reads **25** and that
   `verify:analytics` still reports nothing client-readable.
3. **Do not ship an extension build depending on multi-destination APIs until
   this is applied.** No such build is proposed.

**NO-GO on anything else.** Not on a Store upload, not on `0026`, and **not on
declaring the milestone complete** — §11–13 and §22 are outstanding.

---

*End of report.*
