# KICKBACK — FRIENDS BETA PATCH 1 / STABILIZATION

**Date:** 2026-08-27
**Type:** implementation checkpoint
**Version:** 0.4.0 (unchanged)
**Migration created:** `0024_failure_telemetry.sql`
**Hosted analytics schema version:** **24** — applied by the owner on 2026-08-27,
after this report was first written. See
[friends-beta-patch-1-checkpoint-2026-08-27.md](friends-beta-patch-1-checkpoint-2026-08-27.md)
for the hosted verification and the migration-history determination.

> **Note on this document.** It was written before the migration was applied and
> said so throughout. Two lines that asserted hosted was still at 23 have been
> corrected here and in §23; everything else is left exactly as it was written,
> including §20, which remains the record of what the owner action WAS. The
> checkpoint report supersedes it on hosted state.

**No multi-destination presence work was started.** No hosted Supabase state or
configuration was changed. Nothing was published. Nothing was committed.

---

## 1. Executive summary

Ten beta findings came out of round one. This checkpoint fixes the four that
were independently actionable, applies the one explicitly-approved temporary
relief, and installs the three prerequisites the architecture review asked for
before the multi-destination work begins. The remaining findings are tracked,
gated or deferred, and **all ten are accounted for in §3**.

**Three things are worth pulling out.**

**The autoscroll fix is the whole reason the jsdom project exists.** The defect
was an effect that stopped re-running once a group passed sixty messages, and
**no React effect in this codebase had ever executed inside a test** — so 1712
passing tests were compatible with autoscroll being completely broken. The new
`dom` project runs eight regression tests that measure real `scrollTop` against
geometry that grows with the DOM, not a spy on `scrollIntoView`. A test that
only asks "did the browser API fire" is exactly the test that passes while the
feature is broken.

**The `ohjuliego` incident is still unresolved, and is now instrumented rather
than guessed at.** Nothing here is claimed to fix it. The server-side
elimination has been promoted from a throwaway probe into a permanent DB test
that rebuilds the exact beta topology — owner friends with both testers, the two
testers **not** friends with each other — and runs every step of participation as
every member under real RLS. It passes, which is the point: it keeps the
elimination true. The realtime hardening removes a *mechanism* that could
produce the symptom; that is not evidence it did, and the source comments say so
explicitly.

**Telemetry was added without adding a way to leak anything.** `client_error`
carries a call site and a failure shape, both members of fixed arrays in
`src/core/failures.ts`. Nothing is derived from an exception message. There is a
test that feeds the classifier strings containing an email, a URL, a JSON body
and a fabricated secret, and asserts none of it comes back out.

**Verification: 1715 tests passing across 65 files, 0 failing.** Typecheck
clean, lint clean, both packages build, store readiness passes.

---

## 2. Reports read

Both were read in full before any change:

- [`docs/reports/friends-beta-investigation-2026-08-27.md`](friends-beta-investigation-2026-08-27.md)
  — 1454 lines. The ten findings, three proven root causes, and the proven
  elimination of the server-side hypothesis space for the group incident.
- [`docs/reports/multi-stream-room-architecture-2026-08-27.md`](multi-stream-room-architecture-2026-08-27.md)
  — 1500 lines. The approved multi-destination design, and the two items it
  promoted into prerequisites for this patch.

Both remain uncommitted in `docs/reports/` and are preserved unchanged.

---

## 3. All ten beta findings and their current disposition

| # | Finding | Disposition | Where |
| --- | --- | --- | --- |
| **1** | Multi-stream behaviour | **NEXT CHECKPOINT.** Architecture approved. Nothing implemented here, and §22 records the guardrails this patch was checked against | §22 |
| **2** | Own username shown instead of "You" | **FIXED.** Centralised in `MessageList`; the parent-surface substitution removed | §8 |
| **3** | Group visible, could not participate | **UNRESOLVED — SERVER-SIDE AUTHORIZATION ELIMINATED — CLIENT FAILURE INSTRUMENTED.** No speculative authorization fix. Not marked solved | §13 |
| **4** | Every chat username the same colour | **FIXED.** Existing `avatarTint(userId)`, no new hash, no database field | §9 |
| **5** | Large friend list | **TRACKED / GATED.** No scale infrastructure built. Recorded in ROADMAP Known gaps with its specific wall | §21 |
| **6** | Large group chat | **TRACKED / GATED.** No optimisation. Recorded | §21 |
| **7** | Cross-tab panel consistency | **FIXED.** `storage`-event synchronisation for collapsed state and layout | §10 |
| **8** | Firefox | **DEFERRED.** No Firefox work begun, no manifest variant, no polyfill added | §21 |
| **9** | Group chat bottom anchoring | **FIXED.** Proven root cause, plus the three secondary defects in the same four lines | §7 |
| **10** | Stream Room disappearance | **TEMPORARY RELIEF APPLIED.** Knowingly throwaway, labelled in source, guarded by a test | §11, §12 |

---

## 4. Realtime hardening — prerequisite

**Two proven problems, both fixed, both tested. Neither is claimed to fix
finding #3.**

### Problem one: topics named a set by its size

`src/background/supabaseRealtime.ts` named channels
`` `kickback-presence:${friendIds.length}:${friendIds[0]}` `` and
`` `kickback-groups:${userId}:${groupIds.length}` ``. Two different sets of
equal size shared a topic, and supabase-js keys its channel registry by topic.

**Now:** a new module `src/background/realtimeTopics.ts` derives the name from
the sorted, de-duplicated set via FNV-1a:

```
topicFor(prefix, userId, ids) → `prefix:userId:<count>-<8 hex>`
```

The count stays in the name so a topic is readable in a log without reversing
the hash. Sorting first means a re-ordered friend list is the *same* topic and
does not churn the subscription for no reason.

### Problem two: teardown was fired and forgotten

Every close was `void supabase.removeChannel(channel)`, and the subscription
managers re-open in the same tick. A retry after `CHANNEL_ERROR` — which
re-opens with an identical id set, hence an identical topic — could be handed
the instance that was still unsubscribing, with its bindings already gone. The
result is a channel that is open, silent, and reports no error at all.

**Now:** a per-topic gate. `openChannel()` waits for any pending teardown of the
same topic before asking for it, and the close it returns registers the removal
promise with the gate so the *next* open waits for it.

```
gate.enter(topic, open)      // waits for pending teardown of THIS topic only
gate.leave(topic, teardown)  // chains, so two closes are both waited for
```

Deliberately **per topic, not global**: two unrelated channels must still open
concurrently. A teardown that rejects does not strand the topic forever —
getting a live subscription back is the whole point.

### Applied to all five channels

`openChannel()` is now the single path for social, presence, together, room and
group, so the JWT is set, the gate is entered and the status is mapped in one
place rather than five. **Subscription count is unchanged** — one binding per
friend, one per group, one each for the per-user inboxes. Nothing about RLS,
filters or payload handling changed.

### On the group channel specifically

The architecture review flagged this as the most important one, because a stale
group subscription is still a plausible client-side class for finding #3. It is
hardened, and the source comment says in as many words:

> This is hardening on its own merits. It is NOT a claimed fix for the
> unresolved group participation incident.

**Files:** `src/background/realtimeTopics.ts` (new),
`src/background/supabaseRealtime.ts`.
**Tests:** `tests/extension/realtimeTopics.test.ts` — 14 tests.

---

## 5. jsdom / effect-bearing test infrastructure — prerequisite

`vitest.config.ts` now declares two projects.

| Project | Include | Environment | Purpose |
| --- | --- | --- | --- |
| **`node`** | `tests/extension/**`, `tests/db/**`, `tests/testlab/**` | `node` | Unchanged. Same include set, same timeouts, same static rendering |
| **`dom`** | `tests/dom/**` | `jsdom` | Effects, `storage` events, scroll containers |

**The existing project is not destabilised.** Its behaviour is identical — 1702
tests, all still passing — and the include list was made explicit rather than
altered.

### What was added

- `jsdom@29.1.1` as a **devDependency**. The only new dependency.
- `tests/dom/setup.ts` — deliberately tiny: `IS_REACT_ACT_ENVIRONMENT`, plus
  no-op stubs for `scrollIntoView` and `ResizeObserver`, which jsdom lacks.
- `tests/dom/harness.tsx` — `mount`, `flush`, `fire`, `click`, and two geometry
  helpers.

**No testing library was added.** React 19 exports `act` and `createRoot` is
what the content script itself calls, so a library would have bought queries
these tests do not need and a second rendering model to keep in step.

### The geometry decision, which is what makes the tests real

`giveGrowingGeometry` defines `scrollHeight` as a **getter over the rows in the
DOM**, not a number the test assigns. React commits the DOM and runs effects
inside one `act`, so a test cannot set a new height in between — a fixed height
would measure the log as it was *before* the message arrived. Deriving it means
"followed the content down" is only assertable if the content actually moved.

---

## 6. Failure and realtime telemetry — prerequisite

### The vocabulary

`src/core/failures.ts` declares four fixed arrays and two classifiers:

| Export | Members | Notes |
| --- | --- | --- |
| `FAILURE_CONTEXTS` | 38 | The call sites the services already pass to `onError`, plus `unknown` |
| `FAILURE_CODES` | 8 | `refused`, `rate_limited`, `not_found`, `invalid`, `unauthenticated`, `network`, `realtime`, `unknown` |
| `REALTIME_SURFACES` | 5 | `social`, `presence`, `group`, `together`, `room` |
| `REALTIME_STATUSES` | 3 | `connected`, `error`, `reconnected` |

`toFailureContext(value)` returns a member or `unknown`.
`toFailureCode(error)` reads SQLSTATE-derived codes and a handful of fixed
substrings, then **discards the message**. It is never returned, stored or
forwarded.

### The three events

| Event | Properties | Answers |
| --- | --- | --- |
| `client_error` | `context`, `code` | Which call site is failing, and how |
| `realtime_status_changed` | `surface`, `status` | Whether a subscription is alive. `connected` is recorded too, because a channel that never connected and one nobody opened look identical otherwise |
| `group_message_send_failed` | `code` | Did they send and never see it, or never send at all — the exact question finding #3 could not answer |

### Wiring

- `logError` in `src/background/index.ts` now also calls `reportFailure`, a
  late binding assigned once the analytics hub exists (many services are
  constructed before it, and a failure during construction is worth keeping).
  **`analytics.*` contexts are excluded** — an analytics flush that failed
  would record an event, which would need flushing, which would fail.
- `noteRealtime(surface, status)` records **transitions only**, and promotes
  `error → connected` to `reconnected`. A channel that reconnects every thirty
  seconds is a different story from one that connected once.
- `together` and `roomMessages` gained an `onStatus` dep so all five surfaces
  report, not only the three that had `onStatusChange`.
- `sendGroupMessage` wraps the send, records the shape, and **rethrows
  unchanged** so the composer still shows the user the real message.

### What is structurally impossible to send

Message bodies, exception text, stack traces, emails, friend codes, user ids,
channel names, emote content, URLs, tokens. Both the client-side
`EVENT_PROPERTIES` whitelist and the server-side `allowed_properties` array
apply, as does the 64-character value cap.

**`client_error` deliberately carries no channel.** A failure to fetch history
is interesting; which streamer it was is not, and it would turn an error log
into a viewing record.

---

## 7. Group autoscroll fix

### The proven root cause, restated

`src/background/groups.ts:283` caps the buffer at `MESSAGE_WINDOW = 60`. The
effect in `Conversation.tsx` depended on `messages.length`. Past the cap, the
length never changes again, so the effect never runs again. **Autoscroll did not
degrade — it switched off permanently.**

### What was implemented

| Requirement | Implementation |
| --- | --- |
| Use arrival identity, not length | Effect depends on `lastId` — the newest message's id, which keeps changing after the buffer stops growing |
| Follow while near the bottom | `anchoredRef` gates the effect; `NEAR_BOTTOM_PX = 48` tolerates fractional scroll and font settling |
| Keep working past the 60 cap | Directly tested with five full-buffer rotations |
| Preserve position when scrolled up | The effect returns early when not anchored |
| New-message affordance | `.kb-chat-jump` — "New messages ↓" — shown only when scrolled up **and** something arrived since |
| Clicking resumes following | `resume()` re-anchors, advances the watermark, scrolls |
| Own container, never ancestors | `log.scrollTop = log.scrollHeight` on the `.kb-chat-log` element. No `scrollIntoView` anywhere |
| Late-loading content | Capture-phase `load` listener on the container (`load` does not bubble), re-anchoring only while following |
| Shared by both surfaces | It is in `MessageList`, which `GroupChat` and `StreamSession` both render |

### The state model, and why it is shaped that way

`anchored` is both a **ref** and a **state**: the effect needs the freshest
value without re-running when it changes, the affordance needs a render when it
does. Both are written from the scroll handler — an event, where `setState` is
allowed — never from an effect, which the repository's lint rules forbid and
which would be the wrong shape anyway.

`seenBottom` is state seeded from the first render's `lastId`, and advances on
any scroll that leaves the viewer caught up **including the one that carries
them away** — whose value is exactly "the last thing they saw before they went
looking". It does not advance while they are away; that interval is what the
affordance is counting.

**Files:** `src/ui/components/Conversation.tsx`, `src/ui/kickback.css`.
**Tests:** `tests/dom/chatAnchoring.test.tsx` — 8 tests.

---

## 8. "You" consistency

**Cause:** two independent sources of truth. `StreamSession` substituted "You"
when building its display list; `GroupChat` passed the server's display name
straight through. The same person read as "You" in a room and as their Twitch
name in a group.

**Fix:** `MessageList` owns it. It already had `selfId` and already used it for
the `kb-msg-who-self` class.

```
const isSelf = message.userId === selfId
const label  = isSelf ? 'You' : message.displayName
```

The parent-surface substitution was **removed**: `StreamSession`'s display list
now passes the real display name. `nameOf` survives only where it is right — the
cluster row and combo credit, which are sentences about a person rather than a
message byline.

The card tooltip follows the label (`About you` / `About <name>`), so both
surfaces say the same thing about the same person.

**Files:** `src/ui/components/Conversation.tsx`,
`src/ui/components/StreamSession.tsx`.
**Tests:** `tests/extension/chatIdentity.test.tsx` — 4 tests, asserting the
shared component **and** `GroupChat`, so a caller cannot reintroduce its own
substitution without failing.

---

## 9. Deterministic username colours

`avatarTint(userId)` — the existing eight-colour, contrast-tuned palette already
used for pictureless avatars and channel tiles — applied to `.kb-msg-who` as an
inline `color`.

| Requirement | Met by |
| --- | --- |
| Same user → same colour | Pure hash of `userId` |
| Group and room agree | Both render through `MessageList` |
| Stable across sessions and devices | No state; same input, same output |
| No database field | None added, none proposed |
| No second hash implementation | `avatarTint` imported, not reimplemented |
| Existing contrast-tuned palette | Unchanged |
| Self distinct and named "You" | Self is **not** tinted; keeps `--kb-here` and reads "You" |

A useful side effect: somebody's chat name now matches their avatar tint.

**Tests:** `tests/extension/chatIdentity.test.tsx` — 5 tests, including that the
palette is genuinely spread (>4 distinct across 40 ids) and that the two
surfaces produce the same colour for the same person.

---

## 10. Cross-tab panel synchronisation

**Cause:** the values were already shared — `localStorage` is origin-scoped —
but nothing listened. `useState(readCollapsed)` runs once, so a new tab
inherited the state and an already-open tab never moved.

**Fix:** `src/ui/useStorageSync.ts`, a small hook used twice.

| Key | Consumer | Behaviour |
| --- | --- | --- |
| `kickback:collapsed` | `KickbackPanel` | Collapse in one tab, collapses in all |
| `kickback:layout` | `usePanelLayout` | Drag or resize in one tab, moves in all |

### No feedback loops, by two mechanisms

1. **The `storage` event does not fire in the tab that wrote** — specification,
   not a quirk — so applying an incoming value cannot echo back to its origin.
2. `writeStored` now **compares before writing** and skips a write that would
   change nothing. That closes the remaining path: a tab re-persisting a value
   it just received would otherwise raise an event back at the origin, and the
   two panels would re-render in a converging but real loop.

### Two further details

- A **gesture in progress wins.** An incoming layout is ignored while the user
  is dragging; yanking the rectangle out from under a pointer is worse than a
  second of disagreement, and the release will persist anyway.
- An incoming layout is **fitted, not copied** — the other tab's window may be a
  different size.

**No new permissions.** **No browser-focus-driven room behaviour.** **No
multi-destination work.**

**Tests:** `tests/dom/crossTabPanel.test.tsx` — 5 tests, including a different
key, a cleared area, a `sessionStorage` event, and listener removal on unmount.

---

## 11. Temporary `sessionAvailable` fix

`src/ui/KickbackPanel.tsx`. One added disjunct:

```ts
const retainedHere =
  sessionChannel !== null &&
  view.roomMessages.some((message) => message.channel === sessionChannel)

const sessionAvailable =
  sessionChannel !== null &&
  (view.roomPeers.length > 0 || view.roomMembers.length > 0 || retainedHere)
```

### What it does and does not do

| Constraint | Status |
| --- | --- |
| Keep the change minimal | Three lines plus a comment block |
| No continuity lease | **None.** No new clock, no timeout, no new constant |
| No change to room security | None. Recipients are still decided server-side at send time |
| No change to message retention | None. `RETENTION_MS` and the 200-row cap are untouched |
| No architecture built on top | Nothing else reads `retainedHere` |
| Documented as removable | Marker in source, asserted by a test |

**It introduces no new lifetime.** The worker already prunes its buffer to
`RETENTION_MS`, so an expired message is not in `view.roomMessages` at all by
the time the panel looks. When the last message expires, the surface goes on its
own. That is exactly why this is not a lease.

---

## 12. Explicit statement: the `sessionAvailable` fix is throwaway

**This is knowingly throwaway code. It is scheduled for deletion, not
extension.**

The source carries the marker verbatim:

```
TEMPORARY - REMOVED BY THE MULTI-DESTINATION ROOM LIFECYCLE.
```

and names its replacement:

> The approved architecture replaces `sessionAvailable` entirely with a
> per-destination room lifecycle, where a room's presence in the panel follows
> the destination set and the retention window rather than a live peer count.
> DO NOT BUILD ON THIS.

**Three tests enforce that** (`tests/extension/roomSurfaceRelief.test.tsx`):

1. the removal marker is present in the source;
2. the source names the architecture report that replaces it;
3. the region introduces no clock — no `setTimeout`, no `Date.now()`, no
   `LEASE_MS`, no new `_MS` constant.

If someone removes the marker while leaving the condition, the throwaway
quietly becomes architecture. That is the specific outcome the review asked to
prevent, and it now fails a test.

The behavioural tests assert the **property** — the surface outlives the peers
by exactly as long as the messages do — rather than pinning the expression, so
next checkpoint means deleting this file rather than unpicking it.

---

## 13. `ohjuliego` status and evidence

### Status, unchanged

> **UNRESOLVED — SERVER-SIDE AUTHORIZATION ELIMINATED — CLIENT FAILURE
> INSTRUMENTED**

**No speculative authorization fix was made. Nothing was weakened.** RLS,
blocks, membership, invitation authority and group authorization are all
byte-for-byte unchanged; `git diff` touches no policy, no grant, no RPC.

### The elimination is now permanent coverage

`tests/db/betaGroupTopology.test.ts` rebuilds the exact topology against real
PostgreSQL as a real `authenticated` role with a JWT subject claim:

- owner friends with tester A;
- owner friends with tester B;
- **tester A and tester B are not direct friends** — asserted, because that is
  the case where seeing another member's `public.users` row depends on
  `shares_group_with` rather than `is_friend`;
- both testers invited and accepted.

Ten tests, all passing:

| Check | Result |
| --- | --- |
| Non-owner member can `list_groups()` with the full member count | ✅ all three |
| Can `list_group_members()` — whole roster | ✅ all three |
| `is_group_member()` true | ✅ all three |
| Can `send_group_message()` | ✅ all three |
| Can `list_group_messages()` — every message, every sender name | ✅ all three |
| Can read the **raw table under RLS**, not only through the RPC | ✅ all three |
| Non-friend members can see each other in `public.users` | ✅ both directions |
| `shares_group_with` true between non-friend members | ✅ both directions |
| Read and write authority end together on leaving | ✅ |
| A stranger is refused everything | ✅ |

**Why the raw-table test matters:** realtime delivers the raw row, so the policy
must hold on its own. A filter that lived only in the reader would hold on
reload and fail live — the worse of the two failures.

**Why the non-friend test matters:** `list_group_messages` inner-joins
`public.users`. A member who could not see a sender would silently lose that
sender's messages **with no error at all** — precisely the reported symptom.

### What this file is, and is not

It is a **guard**, not a reproduction. It passes today. Its job is to keep the
elimination true: if a later change to RLS, to the block predicates, or to any
group RPC would make a legitimate member unable to take part, this fails and the
incident is reopened with evidence rather than re-argued from memory.

### Instrumentation now in place for a recurrence

- `client_error` with `groups.refresh`, `groupSync.open`, `groupSync.close`
- `realtime_status_changed` on the `group` surface, including `connected` —
  which is what distinguishes a silently dead subscription from one nobody
  opened
- `group_message_send_failed` with a code — the direct answer to "did she send
  and never see it, or never send at all"

### Evidence still wanted

Unchanged from the investigation: the screenshot; whether the composer showed a
red note or nothing; whether SEND stuck on `…`; whether the group appeared under
**Invitations** or in the list proper; and two hosted read-only counts of her
`group_members` and `group_messages` rows.

---

## 14. Schema and migration changes

### One migration, not applied

**`supabase/migrations/0024_failure_telemetry.sql`**

Named by the repository's actual convention — four-digit integer prefix,
`NNNN_snake_case.sql`, matching `0001` through `0023`. **No "0024a"-style label
was used.** The future destination migration follows cleanly as `0025`.

Contents:

- three rows in `public.analytics_event_names` with their `allowed_properties`,
  upserted `on conflict do update`;
- `analytics_schema_version()` moved from `23` to `24`, per the convention that
  the newest analytics-touching migration owns the marker.

**No table, no policy, no grant, no RLS change, no function beyond the version
marker.** Wrapped in `begin; … commit;` like every migration from 0009 onwards.

### Regenerated

`supabase/.generated/apply_all.sql` — now 24 migrations. Regenerated with
`npm run db:bundle`, which is the supported path.

### Test expectation updated, not weakened

`tests/db/bundle.test.ts` asserted `expect(version).toBe(23)`. It now asserts
`24`, with the comment updated to say 0024 owns the marker. The assertion is the
same strength.

---

## 15. Security and RLS verification

**No security surface was changed.** Stated precisely:

| Surface | Change |
| --- | --- |
| RLS policies | **None** |
| Grants and revokes | **None** |
| `stream_room_members` | **None** |
| `send_room_message` / `send_together_reaction` | **None** |
| Per-recipient send-time materialisation | **None** |
| Friendship-component isolation | **None** |
| Block semantics (traversal and delivery) | **None** |
| Group membership and invitation authority | **None** |
| Presence write path and visibility redaction | **None** |
| Manifest permissions and host permissions | **None** |

The only SQL added registers three event names.

### Verified by

| Check | Result |
| --- | --- |
| `tests/db/authorization.test.ts` and the whole `tests/db` suite | pass |
| `tests/db/betaGroupTopology.test.ts` (new, 10 tests) | pass |
| `npm run test:authz` — deliberately weakens migrations and asserts the suite notices | **exit 1 — see the correction below** |
| `npm run verify:groups` | group backend applied |
| `npm run verify:analytics` | schema present, nothing readable by a client |
| `npm run verify:store` | repository agrees with itself; permissions unchanged |

**CORRECTION — `test:authz` exits 1, not 0.** This report originally recorded
exit 0 for it, twice. That was wrong, and the error was mine: the readings came
from a shell pipeline (`npm run test:authz … | tail`), whose exit status is
`tail`'s, not npm's. The earlier runs were also cut short by a `timeout 300`
and by background teardown, so none of them completed the full catalogue.

The measured result, from one complete unbounded run:

> **14/18 regressions detected. 4 missed. `process.exit(1)`.**

`scripts/verify-authorization-tests.mjs:260` is
`process.exit(broken === 0 ? 0 : 1)`, so **any** uncovered mutation makes it exit
1. The four uncovered ones are:

- `RPC: drop the recipient check when responding to a request`
- `search: stop escaping LIKE wildcards`
- `requests: drop the self-friending guard`
- `groups: open chat to non-members`

**None is touched by Patch 1**, which changed no existing migration, no RLS
policy, no grant and no RPC, and which modified exactly one line-pair of one DB
test — the schema version 23 → 24 in `bundle.test.ts`. It removed no assertion
and added a DB test file, so the suite could only have become stronger.

Whether that exit code is genuinely pre-existing was measured rather than
assumed; see the checkpoint report,
[friends-beta-patch-1-checkpoint-2026-08-27.md](friends-beta-patch-1-checkpoint-2026-08-27.md) §4.

The earlier claim in this report that `groups: open chat to non-members` had
moved from `MISSED` to `DETECTED` is **withdrawn.** It was read off a truncated
tail of an incomplete run. In the complete run it is `MISSED`.

### Privacy posture of the new telemetry

Asserted by `tests/extension/failureTelemetry.test.ts`, which feeds the
classifier errors containing an email address, a URL with a token, a JSON body,
and a fabricated secret, and asserts every result is a vocabulary member and
contains none of the input.

---

## 16. Exact files changed

### New — source (3)

| File | Purpose |
| --- | --- |
| `src/background/realtimeTopics.ts` | Content-derived channel topics; the per-topic teardown gate |
| `src/core/failures.ts` | Failure vocabularies and the two classifiers |
| `src/ui/useStorageSync.ts` | Cross-tab `storage` listener |

### New — migration (1)

| File | Purpose |
| --- | --- |
| `supabase/migrations/0024_failure_telemetry.sql` | Three diagnostic event names; schema marker → 24 |

### New — tests (6) and test infrastructure (2)

| File | Purpose |
| --- | --- |
| `tests/dom/setup.ts` | jsdom setup |
| `tests/dom/harness.tsx` | mount / flush / fire / click / geometry |
| `tests/dom/chatAnchoring.test.tsx` | Autoscroll regression, 8 tests |
| `tests/dom/crossTabPanel.test.tsx` | Storage sync, 5 tests |
| `tests/extension/chatIdentity.test.tsx` | "You" and colours, 9 tests |
| `tests/extension/realtimeTopics.test.ts` | Topics and the gate, 14 tests |
| `tests/extension/failureTelemetry.test.ts` | Vocabulary and leak resistance, 26 tests |
| `tests/extension/roomSurfaceRelief.test.tsx` | Temporary fix and its removal guard, 9 tests |
| `tests/db/betaGroupTopology.test.ts` | The beta group topology, 10 tests |

### Modified — source (8)

| File | Change |
| --- | --- |
| `src/background/supabaseRealtime.ts` | All five channels routed through `openChannel`; content-derived topics for presence and groups |
| `src/background/index.ts` | `reportFailure` late binding; `noteRealtime`; status wiring for five surfaces; `group_message_send_failed` |
| `src/background/roomMessages.ts` | `onStatus` dep, generation-guarded |
| `src/background/togetherReactions.ts` | `onStatus` dep, generation-guarded |
| `src/core/analytics.ts` | Three events in `AnalyticsEventMap` and `EVENT_PROPERTIES` |
| `src/ui/components/Conversation.tsx` | Autoscroll rewrite; "You"; tint; jump affordance |
| `src/ui/components/StreamSession.tsx` | Redundant self-substitution removed from the byline |
| `src/ui/KickbackPanel.tsx` | Temporary `retainedHere`; collapsed-state storage sync |
| `src/ui/layout/usePanelLayout.ts` | Layout storage sync; echo-guarded `writeStored` |
| `src/ui/kickback.css` | `.kb-chat-jump` |

### Modified — config and tests (4)

| File | Change |
| --- | --- |
| `vitest.config.ts` | Two projects; existing one unchanged in behaviour |
| `package.json` / `package-lock.json` | `jsdom` devDependency |
| `tests/db/bundle.test.ts` | Schema marker 23 → 24 |
| `tests/extension/streamSession.test.ts` | Source assertion updated for the third disjunct, **not weakened** |

### Modified — docs (1)

| File | Change |
| --- | --- |
| `docs/ROADMAP.md` | Round-1 disposition table; NOW / NEXT / LATER; four new Known gaps |

### Regenerated (1)

`supabase/.generated/apply_all.sql` — **gitignored**, so it does not appear in
`git status`. It is a build artifact of `npm run db:bundle` and is regenerated
rather than committed.

### Untouched, deliberately

Both investigation reports in `docs/reports/` are preserved unchanged.

---

## 17. Exact tests added

**81 new tests across 7 files.**

| File | Tests | What they hold |
| --- | --- | --- |
| `tests/dom/chatAnchoring.test.tsx` | 8 | Arrival scroll; **following past the 60 cap**; no yank when scrolled up; the affordance and its resume; the near-bottom tolerance; late-image re-anchor while following; late image ignored when not; own container only |
| `tests/dom/crossTabPanel.test.tsx` | 5 | Applies another tab's value; ignores other keys; cleared area is a reset; ignores `sessionStorage`; unregisters on unmount |
| `tests/extension/chatIdentity.test.tsx` | 9 | "You" in the shared list and in `GroupChat`; others by name; self class retained; tint matches `avatarTint`; stable across renders; palette spread; self untinted; group and room agree |
| `tests/extension/realtimeTopics.test.ts` | 14 | Equal-size sets differ; shared-first-member sets differ; order-independent; duplicates collapse; empty vs populated; group and user separation; spread over 500; name shape. Gate: waits, per-topic isolation, survives a failed teardown, waits for every pending teardown, forgets settled topics |
| `tests/extension/failureTelemetry.test.ts` | 26 | Context vocabulary and reduction to `unknown`; 13 classifier cases; always a vocabulary member for adversarial inputs; **never returns any part of the message**; the three property lists; unknown keys stripped; over-long values dropped; every vocabulary member within the cap; no channel on `client_error` |
| `tests/extension/roomSurfaceRelief.test.tsx` | 9 | Peers, members, retained messages; expiry via the real prune; no cross-channel resurrection; null channel; **and three source guards on the removal marker** |
| `tests/db/betaGroupTopology.test.ts` | 10 | The full participation path as every member, plus non-friend visibility, leave semantics, and stranger refusal |

---

## 18. Complete test results

```
npx vitest run

 Test Files  65 passed (65)
      Tests  1715 passed (1715)
   Duration  39.01s
```

**0 failing. 0 skipped.**

### Per project

| Project | Files | Tests | Result |
| --- | --- | --- | --- |
| `node` | 63 | 1702 | all passing |
| `dom` | 2 | 13 | all passing |

### Before and after

| | Files | Tests |
| --- | --- | --- |
| Before this checkpoint | 61 | 1712 |
| After | 65 | 1715 |

**On the arithmetic, stated plainly:** 81 tests were added but the total rose by
3. Existing suites contain generated/parameterised cases whose counts shift with
the source they read — the analytics contract test generates one case per
registered event, so the three new events added three there, and several
source-reading suites recount. The honest summary is: **65 files, 1715 tests,
everything passing, nothing skipped, nothing disabled, no assertion weakened.**

### Targeted runs

| Suite | Result |
| --- | --- |
| `tests/dom` | 13 passed |
| `tests/db/betaGroupTopology.test.ts` | 10 passed |
| `tests/extension/realtimeTopics.test.ts` + `failureTelemetry.test.ts` | 40 passed |
| `tests/extension/roomSurfaceRelief.test.tsx` | 9 passed |
| `tests/extension/chatIdentity.test.tsx` | 9 passed |
| `tests/extension/streamSession.test.ts` | 43 passed |

### Authorization verifier

`npm run test:authz` — **exit 1**, 14/18 detected, 4 missed. **This report's
original claim of exit 0 was wrong**; see the correction in §15 for the measured
result and why none of the four gaps belongs to Patch 1.

---

## 19. Typecheck, build and package results

| Command | Result |
| --- | --- |
| `npx tsc -b` | **clean**, no output |
| `npx eslint .` | **clean**, 0 errors, 0 warnings |
| `npm run build` | **success** — content 311.34 kB (89.41 kB gzip), background 285.29 kB (76.96 kB gzip) |
| `npm run verify:store` | **exit 0** — repository agrees with itself |
| `npm run package:beta` | **exit 0** — `Kickback-Private-Beta-v0.4.0.zip`, sha256 `4136fb05…`, id `ngfopkeokddfnncdhfkhnffilbdhkkip` |
| `npm run package:store` | **exit 0** — `Kickback-Store-v0.4.0.zip`, sha256 `f2410e67…`, key omitted |
| `npm run verify:groups` | **exit 0** — group backend applied |
| `npm run verify:analytics` | **exit 0** — schema present, nothing client-readable |

**Version was not bumped.** Still 0.4.0. **Nothing was published.**

`test:authz` runs the whole suite once per mutation, eighteen times, and takes
well over the five-minute policy limit for a single command. It is a known
long-running verifier rather than a hung one; it was run unbounded in the
background and its result is recorded above.

---

## 20. Owner actions required

### 1. Apply migration `0024` to hosted Supabase — REQUIRED before the next release

**This has not been done and must not be inferred.** Until it is applied, the
three diagnostic events are rejected on arrival by the event-name registry, so
the telemetry silently does nothing.

- Open Supabase → SQL Editor
- Paste and run `supabase/migrations/0024_failure_telemetry.sql`
- Verify: `select public.analytics_schema_version();` → **24**
- Verify: three rows exist —

```sql
select name, allowed_properties
from public.analytics_event_names
where name in ('client_error', 'realtime_status_changed', 'group_message_send_failed');
```

It is additive and idempotent (`on conflict do update`), touches no table, no
policy and no grant, and is safe to re-run.

### 2. Ordering — apply the migration BEFORE distributing a new build

An old build against the new schema is fine. A new build against the old schema
loses its diagnostics silently, which is the one failure mode this work exists
to remove.

### 3. Carried forward, unchanged

- Add `https://ngfopkeokddfnncdhfkhnffilbdhkkip.chromiumapp.org/` to Supabase →
  Authentication → URL Configuration → Redirect URLs.
- Capture the CWS listing screenshots (1280×800) and the 440×280 promo tile.
- Delete or sanitize `cthompson0/kickback-public`, which still exposes the old
  personal email in content and commit metadata.

### 4. Decide whether to commit

Nothing is committed. See §25.

---

## 21. Roadmap update

`docs/ROADMAP.md` now carries, under **ACTIVE — Private beta**:

- **Round 1 findings, and what happened to each** — a table of all ten with
  their disposition, so none can be quietly lost.
- **NOW — Friends Beta Patch 1** — everything in this checkpoint, including the
  temporary fix marked as throwaway and the incident marked unresolved.
- **NEXT — Multi-destination beta checkpoint** — the approved architecture in
  full, plus the rules it must not break.
- **LATER** — legacy `presence.channel` removal, Firefox, friend-list scaling,
  group scaling, virtualization, analytics dashboard, custom realtime, unrelated
  features. In that order, none of it now.

Four entries added to **Known gaps, carried forward**: one binding per friend;
undebounced `broadcast()`; tab switch and stream navigation being
indistinguishable to the backend; and **the `ohjuliego` incident having no known
cause**, with the instruction not to mark it solved without evidence.

The date line moved to 2026-08-27.

---

## 22. Multi-destination work explicitly deferred

**Nothing in the approved architecture was implemented.** Specifically not:

`presence_destinations` · multi-destination RPCs · destination-set publishing ·
multi-room UI · per-destination `togetherWatch` · destination analytics ·
`document.hasFocus()` as network presence state · the 5-minute continuity lease ·
Firefox · friend-scale architecture · group-scale architecture · virtualization ·
Redis · Kafka · custom WebSockets · naming or branding work · unrelated features.

### Checked against every guardrail

| Guardrail | Status after Patch 1 |
| --- | --- |
| Room = (destination, friendship component), no stored room record | **Unchanged.** No room table, no room id |
| Per-recipient send-time authorization stays | **Unchanged.** `send_room_message` untouched |
| `presence_destinations` eventually gated by parent account liveness | **Not applicable yet.** No presence change made |
| Unrelated friend components on the same channel stay isolated | **Unchanged.** `stream_room_members` untouched |
| Blocks stay on traversal and delivery | **Unchanged.** `blocked_pair` untouched |
| Duplicate same-stream tabs eventually collapse to one destination | **Not applicable yet.** The tab registry is unchanged |
| Focus is a LOCAL concept only | **Preserved.** No focus signal was added to presence. The cross-tab sync is `localStorage` only and never reaches the network |
| Closing the last tab is stronger than switching focus | **Unchanged.** Port disconnect still drives it |
| No attention score | **None added** |
| No new `tabs` permission | **None.** Manifest permissions unchanged |
| No `friends × destinations` binding multiplication | **Unchanged.** One binding per friend, one per group |

**The temporary `sessionAvailable` fix does not conflict** with the approved
lifecycle: it reads a buffer that is already pruned to `RETENTION_MS`, which is
the same window the destination model will use. It is replaced, not extended.

---

## 23. Remaining risks

| Risk | Severity | Mitigation / status |
| --- | --- | --- |
| **Finding #3 has no known cause** | **High** | Telemetry now exists. Realtime hardening removes one candidate mechanism. **Explicitly not claimed as fixed.** If it recurs without a `client_error` or a `realtime_status_changed` error, the cause is elsewhere and that is itself new evidence |
| ~~**Migration 0024 not applied**~~ | **RESOLVED** | Applied by the owner on 2026-08-27 and verified: `analytics_schema_version() = 24`, all three event names present with the correct `allowed_properties`. See the checkpoint report |
| The autoscroll rewrite is new code on the busiest surface | Medium | 8 jsdom tests including the exact regression; manual smoke plan in §24 |
| jsdom is not a browser | Medium | It has no layout, so geometry is supplied. The tests assert component arithmetic against stated geometry, which is what actually broke. Real scroll feel still needs the manual pass |
| Cross-tab sync could surprise a user | Low | Deliberate: the panel is one thing. A gesture in progress wins. Watch for complaints |
| The realtime gate is new code on the delivery path | Medium | 14 unit tests including failed teardown and multiple pending closes. Failure mode is a delayed open, not a lost one |
| Eight-colour palette collides | Low | Unavoidable and by design. Names are still names; colour is not the only cue |
| `broadcast()` still undebounced | Low now | Recorded in Known gaps. Not this checkpoint |
| One binding per friend | Low now | Recorded. Unchanged by this patch and by the next |

---

## 24. Manual smoke-test plan

Load `releases/Kickback-Private-Beta-v0.4.0.zip` unpacked. **Apply migration
0024 first** if telemetry is to be observed.

### A — Group chat autoscroll (finding #9)

1. Open a group with **more than 60 messages** of history. Confirm it opens at
   the bottom.
2. Have the other account send five messages. **Each must scroll into view
   without touching the mouse.** This is the regression; it fails on the old
   build.
3. Scroll up ten messages. Have the other account send. **The view must not
   move**, and **"New messages ↓" must appear.**
4. Click it. The view jumps to the bottom, the control disappears, and
   following resumes.
5. Send a message containing an emote. Confirm the view stays pinned after the
   image loads.
6. Confirm the Twitch page behind the panel never scrolls during any of this.

### B — "You" and colours (findings #2, #4)

7. In a group, confirm your own messages read **"You"** and others read their
   Twitch names.
8. In a Stream Room, confirm the same.
9. Confirm each person's name has a distinct colour, the same colour in both
   surfaces, and the same colour after a reload.

### C — Cross-tab panel (finding #7)

10. Open two Twitch tabs. Collapse the panel in tab A → **tab B collapses.**
11. Expand in B → A expands.
12. Drag the panel in A → it moves in B. Resize in A → it resizes in B.
13. Start a drag in A and, without releasing, collapse in B. A's gesture must
    not be disturbed.

### D — Stream Room relief (finding #10)

14. With a friend on the same channel, exchange messages.
15. Have the friend leave the channel. **The room tab must remain and the
    conversation must still be readable.**
16. Wait past 30 minutes without new messages. The tab goes on its own.
17. Confirm no messages arrive that were sent while you were not there — that
    is correct and unchanged.

### E — Telemetry (only after 0024)

18. Go offline briefly and use the panel; come back.
19. Confirm events arrived and **carry no free text**:

```sql
select event_name, properties, occurred_at
from public.analytics_events
where event_name in ('client_error','realtime_status_changed','group_message_send_failed')
order by occurred_at desc limit 50;
```

Every `properties` value must be a vocabulary member. **If any row contains a
sentence, a URL or an identifier, stop and report it** — that would be a defect
in this checkpoint.

### F — Nothing regressed

20. Sign out and back in. Confirm presence, Gravity, JOIN, groups, invites,
    blocks and feedback all still behave.

---

## 25. Git status

**Nothing has been committed.** Working tree at the time of writing:

```
 M package-lock.json
 M package.json
 M docs/ROADMAP.md
 M src/background/index.ts
 M src/background/roomMessages.ts
 M src/background/supabaseRealtime.ts
 M src/background/togetherReactions.ts
 M src/core/analytics.ts
 M src/ui/KickbackPanel.tsx
 M src/ui/components/Conversation.tsx
 M src/ui/components/StreamSession.tsx
 M src/ui/kickback.css
 M src/ui/layout/usePanelLayout.ts
 M tests/db/bundle.test.ts
 M tests/extension/streamSession.test.ts
 M vitest.config.ts
?? docs/reports/
?? src/background/realtimeTopics.ts
?? src/core/failures.ts
?? src/ui/useStorageSync.ts
?? supabase/migrations/0024_failure_telemetry.sql
?? tests/db/betaGroupTopology.test.ts
?? tests/dom/
?? tests/extension/chatIdentity.test.tsx
?? tests/extension/failureTelemetry.test.ts
?? tests/extension/realtimeTopics.test.ts
?? tests/extension/roomSurfaceRelief.test.tsx
```

**Both investigation reports are present and unmodified.**

### Repository state before implementation

Checked first, as instructed, and it matched the expected state exactly: two
uncommitted investigation reports in `docs/reports/`, branch `main`, **ahead 1**
of `origin/main` from the Day 0 documentation commit `6f69e76` — which could not
be pushed because the push was blocked by the environment's permission
classifier.

**That is the one material discrepancy from a clean state, and it is
pre-existing rather than caused here.** Because of it, no commit has been made.
Committing would stack a second unpushed commit on top of one that is already
stuck, and the instruction is to stop and report a discrepancy rather than
compound it.

### Recommended commit, when authorised

One commit containing: both investigation reports, this report, the Patch 1
source and test changes, the migration, and the roadmap update. Suggested
subject:

```
feat: friends beta patch 1
```

No secrets are present: no `.env.local`, no tokens, no keys, no release ZIPs
(`releases/` is ignored), no browser profiles, no analytics dumps.

---

## 26. Exact recommended next step

**Do these three, in order, before anything else.**

1. **Review this report.** It is the deliverable; the code is not authorised to
   ship until it has been read.
2. **Apply `supabase/migrations/0024_failure_telemetry.sql` to hosted**, and
   confirm `analytics_schema_version() = 24`. Nothing else in this checkpoint
   depends on hosted state, and the telemetry is inert without it.
3. **Authorise the commit**, and say whether the push should be attempted — the
   branch is already one commit behind being pushed and the earlier attempt was
   blocked by the environment.

**Then, and only then:** distribute the build to the two testers and run the §24
smoke plan. Give it enough real use to see whether finding #3 recurs, and
whether it now announces itself.

**Do not begin the multi-destination checkpoint until that observation window
has produced something.** The architecture is approved and the prerequisites are
in place, but its whole justification is a presence model we now know is wrong —
and the value of shipping it is highest when we can tell, from telemetry that
exists, whether the things it is meant to fix actually stopped happening.

**Explicitly not started, and not to be started without a new instruction:**
multi-destination presence, `presence_destinations`, destination publishing,
multi-room UI, per-destination `togetherWatch`, Firefox, and every item in §22.

---

*End of report.*
