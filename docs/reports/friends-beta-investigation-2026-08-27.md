# KICKBACK — FIRST REAL-USER BETA INVESTIGATION

**Date:** 2026-08-27
**Scope:** first friends-beta session, two external testers (`ohjuliego`, plus owner accounts `anoterostv` / `wtfchuck27`)
**Private Beta Day 0:** `2026-08-26 20:45:37.549219+00`
**Version investigated:** 0.4.0, hosted schema current through `0023_feedback.sql` (`analytics_schema_version() = 23`)

**Status: INVESTIGATION ONLY. No code was changed, no migration written, no hosted
operation performed, no store version published.** `git status` was clean before
this report and the report file is the only addition.

**Baseline test run before investigating:** `npx vitest run` — **61 files, 1712
tests, all passing, 37.55s.** Nothing below is a pre-existing red test.

---

## How to read the evidence grades

Every finding is graded. The grades are used strictly and nothing has been
promoted beyond what the evidence supports.

| Grade | Meaning |
| --- | --- |
| **PROVEN ROOT CAUSE** | The mechanism is visible in the source and the causal chain is complete. Reproducing it requires no assumption about what the tester did. |
| **PROVEN ELIMINATION** | A hypothesis was tested and falsified by execution, not by reading. |
| **STRONG HYPOTHESIS** | A specific mechanism exists in the code that would produce exactly the reported symptom, but the causal chain has an untested link. |
| **PRODUCT RECOMMENDATION** | Not a defect. A decision that needs an owner. |
| **UNRESOLVED — NEEDS EVIDENCE** | Cannot be closed from the repository. The exact evidence required is named. |

---

## 1. Executive summary

Ten findings were reported. Three are root-caused to a specific line; one whole
class of hypotheses was eliminated by execution; the rest are product decisions
or measured assessments with no current problem.

**The headline is that none of this is architectural.** The thesis —
Presence → Social Gravity → JOIN → Together — is not implicated anywhere in this
report. Nothing here requires rethinking what Kickback is.

**Three things are worth pulling out of the detail.**

**First: two of the reported bugs are the same bug wearing different clothes.**
Group chat stops following new messages once a conversation passes sixty; the
Stream Room stops *existing* the moment the last co-viewer leaves, while its
messages survive thirty minutes. In both cases a surface has a shorter lifetime
than the data behind it, and in both cases the tester experiences that as "my
messages disappeared." Fixing them is small. Noticing that they are the same
shape is what stops a third one being built.

**Second: the `ohjuliego` group bug is not in the database.** This is the most
useful negative result of the session. The exact beta topology was reconstructed
in real Postgres against the real migrations and every step of the participation
path was executed as each user. Everything passes. That eliminates the entire P0
hypothesis space named in the brief — RLS, RPC grants, membership, invite/accept
state, SELECT-versus-INSERT divergence, block predicates — and moves the hunt to
the client, where it could not be closed without evidence the workspace does not
contain. **It is recorded as UNRESOLVED, not as a fixed bug.**

**Third, and most uncomfortable: there is no error telemetry at all.** Every
failure in the extension goes to `console.warn` (`src/background/index.ts:125`)
and nowhere else. That is precisely why finding #3 is still open, and it is the
single highest-leverage change available. It is also the one item here that
needs a migration, so it is flagged for the owner rather than done.

**Recommended now: five small, isolated fixes** (§14). Everything else defers
(§15). None of the recommended work is a feature, and none of it turns this
report into a milestone.

### Finding index

| # | Finding | Priority | Grade |
| --- | --- | --- | --- |
| 3 | Group visible, cannot participate | **P0** | UNRESOLVED — server-side space PROVEN ELIMINATED |
| 10 | Stream Room messages appear to disappear | **P0/P1** | **PROVEN ROOT CAUSE** |
| 9 | Group chat does not stay anchored to bottom | **P1** | **PROVEN ROOT CAUSE** |
| 1 | Multi-stream presence semantics | **P1** | Fully characterised; PRODUCT RECOMMENDATION |
| 2 | "You" label inconsistency | P2 | **PROVEN ROOT CAUSE** (two exact lines) |
| 4 | Chat username colours | P2 | Confirmed; PRODUCT RECOMMENDATION |
| 7 | Cross-tab panel state | P2 | Fully characterised; PRODUCT RECOMMENDATION |
| 5 | Large friend list | Roadmap | Measured; specific wall identified |
| 6 | Large group chat | Roadmap | Measured; healthier than expected |
| 8 | Firefox | Roadmap | Audited; **MEDIUM** effort |

---

## 2. P0 findings

### #3 — Group visible but tester cannot participate (`ohjuliego`)

**Grade: UNRESOLVED — NEEDS EVIDENCE. The server-side hypothesis space is
PROVEN ELIMINATED.**

#### What was proven, and how

The beta topology was reconstructed in PGlite (real PostgreSQL in WASM) running
`supabase/.generated/apply_all.sql` — every real migration, in order, through
`0023` — with a Supabase auth shim providing `auth.users` and `auth.uid()`.

The topology deliberately matched the real beta rather than a convenient
fixture:

- three accounts: `anoterostv` (owner), `wtfchuck27`, `ohjuliego`
- the owner is friends with **both** testers
- **the two testers are not friends with each other** — this matters, because it
  is the case where `public.users` visibility depends on `shares_group_with`
  rather than on `is_friend`
- the owner creates a group and invites both; both accept via
  `respond_to_group_invite`

Every call was executed the way PostgREST executes it: `set role authenticated`
with `request.jwt.claim.sub` set to that user's id, so RLS was genuinely
enforced rather than bypassed by the owner role.

**Result — every step passed for every user:**

| Step | `anoterostv` | `wtfchuck27` | `ohjuliego` |
| --- | --- | --- | --- |
| `list_groups()` | OK — 1 group, member_count 3 | OK — 1 group, member_count 3 | OK — 1 group, member_count 3 |
| `list_group_members(g)` | OK — 3 rows | OK — 3 rows | OK — 3 rows |
| `is_group_member(g)` | OK — true | OK — true | OK — true |
| `send_group_message(g, …)` | OK — returns uuid | OK — returns uuid | OK — returns uuid |
| `list_group_messages(g, 100)` | OK — 3 messages | OK — 3 messages | OK — 3 messages |
| raw `select … from group_messages` under RLS | OK — 3 | OK — 3 | OK — 3 |

Supplementary checks, all passing:

- **Cross-visibility between non-friends who share a group.** `wtfchuck27` can
  see `ohjuliego`'s `public.users` row and vice versa, and `shares_group_with`
  returns true both ways. This matters specifically because
  `list_group_messages` (`0008_group_rpcs.sql:356`) is `security invoker` and
  performs `join public.users u on u.id = m.user_id` — an **inner** join. If a
  caller could not see a sender's user row, that sender's messages would be
  silently dropped from the result with no error. They are not.
- **Non-friend invite.** The owner can invite an account they are not friends
  with; `invite_to_group` returns `invited`.
- **Departure is atomic.** After `leave_group`, `list_groups()` returns empty,
  `send_group_message` correctly raises `kickback: you are not in this group`,
  and the raw table returns 0 rows — read and write authority end in the same
  instant.

#### What this eliminates, item by item, against the brief

| Brief hypothesis | Status |
| --- | --- |
| membership does not exist | **Eliminated.** `respond_to_group_invite` (`0008_group_rpcs.sql:126`) inserts `group_members` under `for update` on the invite row, `on conflict do nothing`. |
| invite/accept state differs between client and server | **Eliminated server-side.** Status transitions are atomic within the RPC. |
| RLS differs between SELECT and INSERT | **Eliminated.** Writes go exclusively through `send_group_message` (SECURITY DEFINER, gated on `is_group_member`); reads go through `group_messages_select` using `group_message_visible` (`0022_blocks.sql:839`). Both agree. |
| RPC / function permissions | **Eliminated.** `is_group_member` is revoked from clients then re-granted to `authenticated` (`0007_groups.sql:270` and `:277`) precisely because RLS policies are evaluated as the caller. Verified by execution. |
| block predicates from 0022 misfiring | **Eliminated.** No blocks exist between these accounts, and `group_message_visible` returns true for all three. |
| session / auth identity mismatch | **Eliminated as a schema concern.** `require_actor()` resolves correctly for each JWT subject. A *client-side* token problem remains possible — see below. |

#### What remains — ranked, and explicitly not claimed as root cause

**(a) Stale realtime channel on re-subscribe — STRONG HYPOTHESIS.**

`createSupabaseGroupChannel` names its channel
`` `${GROUP_PREFIX}:${userId}:${groupIds.length}` `` — **keyed by group *count*,
not by group ids** (`src/background/supabaseRealtime.ts:289`). Teardown is
`void supabase.removeChannel(channel)` (`:356`) and is **not awaited**;
`groupSync.openFor` (`src/background/groupSync.ts:93`) re-opens immediately
afterwards.

Two paths reach the same topic name twice in quick succession: a retry after
`CHANNEL_ERROR` (the retry ladder re-opens with an identical `ids` array), and
any transition between two different single-group states. supabase-js keys
channels by topic; asking for a topic whose previous instance is still
unsubscribing can hand back the dying channel, whose `postgres_changes` bindings
have already been torn down.

The symptom that produces is **exactly** what was reported: the group is
visible, the composer is enabled, sends succeed server-side, and nothing ever
appears. Critically, **Kickback draws nothing optimistically** — group messages
reach the UI only via realtime `onRawMessage` or a full `groups.refresh()` — so
a dead subscription is indistinguishable from "my messages vanish", and it is
completely silent.

*Why this is not graded as proven:* the collision depends on supabase-js
internal channel-registry timing that was not instrumented, and no captured
realtime status from the tester's session exists.

**(b) A dropped message that self-heals only if the roster is intact — STRONG
HYPOTHESIS, lower likelihood.**

`onRawMessage` (`src/background/index.ts:367`) resolves the sender's display
name from the cached member roster. If the sender is unknown it **drops the
message** and calls `groups.refresh()` instead. `refresh()` does re-fetch
messages, so this normally self-heals.

But in `groups.refresh()` (`src/background/groups.ts:195-210`) the per-group
loop writes results conditionally:

```ts
if (memberResult.value) members[group.groupId] = memberResult.value
if (messageResult.value) messages[group.groupId] = messageResult.value
```

If `listMembers` fails for a group, `members[groupId]` stays **absent**. Every
subsequent realtime message from a sender in that group is then dropped and
triggers another refresh — a quiet livelock in which messages never render and
nothing is reported.

**(c) She was looking at the invitation, not the group — STRONG HYPOTHESIS,
mundane and therefore worth taking seriously.**

`GroupsTab` renders pending invites in a separate section headed
`Invitations · N` (`src/ui/components/GroupsTab.tsx:496-525`). The row shows the
group's **name**, a 👥 glyph, "X invited you", and ACCEPT / Decline buttons. The
row itself is deliberately **not clickable**; only the buttons are.

A first-time tester who sees the group's name in her Groups tab and taps the row
gets nothing at all. That is a very literal reading of "can SEE the group but
cannot participate", and it requires no bug.

#### Ruled out on inspection (not merely unlisted)

- **Error swallowing.** `handleRpc` (`src/background/index.ts:1361-1402`) always
  replies, converting a thrown error into `{ok: false, error}`. `groups.mutate`
  (`src/background/groups.ts:159`) rethrows the database's own message when it
  is a `kickback: ` validation complaint. Both `Composer.send`
  (`src/ui/components/Conversation.tsx:236`) and `GroupsTab.respond` /
  `GroupDetail.act` catch and render into `.kb-inline-note`. **A failing send
  shows the user a message.** So a *silent* failure is not a send that was
  refused — which is itself evidence pointing at (a).
- **Composer disabled by membership.** It is not.
  `disabled={sending || draft.trim().length === 0}` is the only condition
  (`Conversation.tsx:290`). Membership never disables the composer.
- **Subscription never established for a newly joined group.**
  `groups.subscribe` → `groupSync.setGroups(...)` is wired
  (`src/background/index.ts:1131`) and fires on every groups-state change.

#### Evidence that would close this in one pass

1. **The screenshot.** It is not in this workspace — `git status --ignored` and
   a filesystem sweep found only pre-existing development captures from earlier
   checkpoints. **Nothing here should be read as having seen it.**
2. Whether the composer showed a red inline note, or nothing at all. This alone
   separates (a) from a refused send.
3. Whether the SEND button stuck on `…` (which would mean the RPC promise never
   settled — a different bug again).
4. Whether the group appeared under **Invitations** or in the group list proper.
   This alone settles (c).
5. Two hosted read-only queries, which separate "never joined" from "sent but
   never saw":

```sql
select count(*) from public.group_members  where user_id = '<her user id>';
select count(*) from public.group_messages where user_id = '<her user id>';
```

#### Recommendation

**Do not fix this blind.** Guessing at a P0 with three plausible mechanisms is
how a fourth one gets built. Instead:

- ship the error telemetry in §17, which makes this class of failure
  self-reporting; and
- apply the `await`-teardown / content-keyed-topic change in §14 item 6, which
  is safe on its own merits regardless of whether it is the cause.

If the cause is (a), it stops happening. If it is not, the telemetry will say
so on the next occurrence.

---

### #10 — Stream Room messages appear to disappear

**Grade: PROVEN ROOT CAUSE.** Full mechanism in §8. Summary here because it is
P0/P1 in the brief.

`src/ui/KickbackPanel.tsx:236`:

```ts
const sessionAvailable =
  sessionChannel !== null && (view.roomPeers.length > 0 || view.roomMembers.length > 0)
```

`sessionPeers()` (`src/background/index.ts:806`) **excludes self**; so does
`room.snapshot()`. **The Stream Room surface therefore exists only while at
least one other person is live on the channel — while its messages live for
thirty minutes.** Two lifetimes, and the shorter one silently hides the longer
one. This is not data loss.

---

## 3. P1 findings

### #9 — Group chat does not reliably stay anchored to the bottom

**Grade: PROVEN ROOT CAUSE.**

Two facts, in two files, that combine into an unconditional failure.

**Fact one** — `src/ui/components/Conversation.tsx:119-122`:

```ts
// Follow the conversation as it arrives.
useEffect(() => {
  endRef.current?.scrollIntoView({ block: 'end' })
}, [messages.length])
```

**Fact two** — `src/background/groups.ts:73` and `:281-283`:

```ts
export const MESSAGE_WINDOW = 60
// ...
const merged = [...existing, message]
  .sort((a, b) => …)
  .slice(-MESSAGE_WINDOW)
```

**Once a group's buffer reaches sixty messages, `messages.length` is pinned at
sixty permanently.** The effect's only dependency stops changing, so React never
re-runs it. **Autoscroll does not degrade — it switches off, and stays off for
the life of that conversation.**

This explains the "not always" in the report exactly: it works perfectly for the
first sixty messages of a group's existence and never again. It is not
intermittent, not timing-dependent, and not load-related — it is a threshold.

#### Three further defects in the same four lines

These matter because they mean the correct fix is not "change the dependency
array".

1. **It yanks unconditionally.** There is no check for whether the user has
   scrolled up. A user re-reading earlier messages is dragged to the bottom —
   the behaviour the brief explicitly does not want. It is currently *masked* in
   long conversations by the primary bug, and visible in short ones.
2. **`scrollIntoView` scrolls every scrollable ancestor.** Inside Kickback's
   shadow-DOM overlay that can move Twitch's own page, not just `.kb-chat-log`.
3. **Images load after the effect runs.** `EmoteImage` and `Avatar` resolve
   asynchronously and grow the content afterwards, leaving the view short of the
   bottom even on the occasions the effect *did* fire. This is likely why the
   symptom felt inconsistent even below the sixty-message threshold.

#### The same bug exists in the Stream Room

`MessageList` is shared. The room's cap is `MAX_MESSAGES = 200`
(`src/core/roomMessages.ts:69`), and room messages are also swept at thirty
minutes, so a room buffer very rarely reaches two hundred. That is consistent
with only group chat being reported, and it means the fix must be made in the
shared component rather than in `GroupChat`.

#### Why this shipped — and this is the important part

`vitest.config.ts:13` sets `environment: 'node'`, and the UI tests use
`renderToStaticMarkup` from `react-dom/server`.

**No React effect in this repository has ever executed inside a test.**

Autoscroll, the `UserCard` positioning effect, combo reporting, `markGroupRead`
— all of it is uncovered *by construction*, not by oversight. A defect in an
effect cannot currently be caught by the 1712 tests that pass. See §16.

### #1 — Multi-stream presence semantics

**Grade: fully characterised — not a defect.** The current rule is deterministic
and documented in code. The gap is a product decision, not an implementation
error. Full behaviour in §5, recommendation in §6.

---

## 4. P2 findings

### #2 — Local user label: "You" in rooms, username in group chat

**Grade: PROVEN ROOT CAUSE — two exact lines.**

Two independent sources of truth for the same label:

**Stream Room** — `src/ui/components/StreamSession.tsx:107-108`:

```ts
const nameOf = (userId: string) =>
  userId === selfId ? 'You' : (byId.get(userId)?.user.displayName ?? 'Someone')
```

applied when the display list is built at `:215-221`:

```ts
const display = heard.map((message) => ({
  …
  displayName: nameOf(message.senderId),
  …
}))
```

**Group chat** — `src/ui/components/GroupChat.tsx` passes the `ChatMessage[]`
straight into `MessageList` with no name mapping at all. Those `displayName`
values come from `list_group_messages`, which reads `u.display_name` from
`public.users`. So group chat renders the tester's Twitch display name.

`MessageList` (`Conversation.tsx:96-190`) already receives `selfId` and already
uses it to apply the `kb-msg-who-self` class (`:150`). **It has everything it
needs and simply does not use it for the text.**

**Proposed shared behaviour:** perform the substitution inside `MessageList`,
where `selfId` already lives, and delete the self-branch from `StreamSession`'s
`nameOf`. One behaviour, one place, both surfaces, no new prop, and it becomes
structurally impossible for the two to diverge again.

### #4 — Chat username colours

**Grade: confirmed. PRODUCT RECOMMENDATION — and the mechanism already exists.**

Confirmed in `src/ui/kickback.css:1469-1477`:

```css
.kb-msg-who      { font-weight: 800; color: var(--kb-accent); margin-right: 5px; }
.kb-msg-who-self { color: var(--kb-here); }
```

Every non-self sender is the same accent colour. In a three-person conversation
that is exactly as hard to scan as reported.

**The answer is already in the codebase.** `src/ui/avatarTint.ts` is a
deterministic eight-colour palette seeded by a string hash, already used for
avatars without pictures and for channel tiles, and already tuned for contrast
against the panel background.

Seeding it with `userId` on `.kb-msg-who` satisfies every stated requirement:

| Requirement | How it is met |
| --- | --- |
| deterministic for a user | pure hash of `userId` |
| stable across sessions | no state involved; same input, same output |
| stable across devices and between viewers | everyone computes the same colour for the same person |
| never randomised per render | it is a pure function, not a random draw |
| sufficient contrast | the palette is already used on this background |
| local user still shows "You" | self keeps `--kb-here` and reads "You" per #2, so the viewer is never one of the eight |
| no database storage | none required, and none proposed |

A useful side effect: a person's chat name will match their avatar tint, which
is real coherence rather than decoration.

**Accessibility note:** colour must not be the *sole* differentiator, and here
it is not — the name text is still the name, and the self/other distinction is
carried by the word "You" as well as by colour. Eight hues at weight 800 is
within reasonable bounds; if a tester reports difficulty, the palette is one
constant.

**Twitch light/dark themes do not apply.** Kickback renders inside its own
shadow root with its own tokens and does not inherit Twitch's theme.

### #7 — Panel position / open state across multiple Twitch tabs

**Grade: fully characterised. PRODUCT RECOMMENDATION in §12.**

Open/closed state — `src/ui/KickbackPanel.tsx:76` and `:88-104`:

```ts
const COLLAPSED_KEY = 'kickback:collapsed'

function readCollapsed(): boolean {
  try { return window.localStorage.getItem(COLLAPSED_KEY) === '1' } catch { return false }
}
```

consumed at `:118`:

```ts
const [collapsed, setCollapsed] = useState(readCollapsed)
```

Panel geometry lives the same way — `src/ui/layout/usePanelLayout.ts:30`,
`LAYOUT_KEY = 'kickback:layout'`, read synchronously before first paint.

`localStorage` is **origin-scoped**, so it is already shared by every
`twitch.tv` tab. But:

- there is **no `storage` event listener anywhere in `src/ui/`** (verified by
  search); and
- `useState(readCollapsed)` runs its initialiser **once per mount**.

**So the behaviour today is precisely: a newly opened Twitch tab inherits the
last saved state; already-open tabs never change.** That is option C from the
brief, arrived at accidentally — and it is exactly what produces the "feels
tab-local" complaint, because the state the user just changed is the one that
does not propagate.

---

## 5. Current multi-stream behaviour, precisely

This is fully determined. `src/background/activity.ts` is a pure function over a
tab map and states its own rule.

### The model

Each Twitch tab holds a long-lived `chrome.runtime.Port`. **The port object
itself is the tab key** — `tabActivity.update(port, …)`
(`src/background/index.ts:1426-1436`) and `tabActivity.remove(port)` on
disconnect (`:1570-1576`). There is no `tabs` permission and no tab id.

The content script reports `{channel, visible: !document.hidden, channelName}`
(`src/content/index.tsx:110-140`) on:

- initial connect
- SPA navigation, via `watchChannel`
- `visibilitychange`
- `pageshow`
- a title correction, when Twitch finally updates `<title>` with the real casing

### The pick

`src/background/activity.ts:63-77`, in order:

1. **A visible tab always beats a hidden one.**
2. Among tabs of equal visibility, **the highest `updatedAt` wins** — the tab
   you just navigated or just switched to.
3. No tabs at all → `IDLE`.

**So the answer to the brief's question is: neither the first stream opened nor
the last. It is the focused tab, with ties broken toward the most recently
updated.**

### The database cannot hold more than one

`public.presence` (`supabase/migrations/0001_schema.sql:109-122`) is **one row
per user** with a single nullable `channel`, constrained by
`presence_offline_has_no_activity` (offline rows may carry no platform or
channel) and `presence_channel_requires_platform`.

**Any multi-stream model is therefore a schema change, not a client change.**

### Timing

`presenceReporter.setActivity` (`src/background/presence.ts:139`) debounces
writes by **1 000 ms** (`DEFAULT_DEBOUNCE_MS`), heartbeats every **45 s**
(`DEFAULT_HEARTBEAT_MS`, half the 90 s staleness window), and delays going
offline by **5 000 ms** (`DEFAULT_OFFLINE_GRACE_MS`) because JOIN tears one tab
down and brings another up.

### The scenarios in the brief

**A = `summit1g`, B = `theburntpeanut`, C = `gingy`**

| Action | Exact behaviour today |
| --- | --- |
| Open A, then B, then C | Each new tab is visible as it opens, so presence follows to **C**. A and B are open, hidden, and invisible to every friend. |
| Switch focus between tabs | `visibilitychange` fires in **both** the leaving and the arriving tab. The registry re-picks immediately; the presence *write* lands after the 1 s debounce plus a round trip. |
| Leave all three playing, focused on B | Presence = **B only**. A and C are watched-but-unreported. Friends see one stream. |
| Close one tab | The port disconnects → `tabActivity.remove(port)` → recompute. If it was the focused tab, presence falls to the next best candidate. |
| Navigate one tab to another streamer | `watchChannel` (`src/platforms/twitch/navigation.ts:40-67`) detects it via a 400 ms poll plus `popstate`, `hashchange`, and a `<title>` MutationObserver. If that tab is focused, presence follows. |
| Background a tab | Reported hidden immediately. It stops being a candidate unless **every** tab is hidden. |
| Close all Twitch tabs | Registry empties → `IDLE` → **5 s grace** → `reportOffline()`. |

### Two edge cases that matter

**Two visible windows.** `document.hidden` is `false` for the active tab of an
*unfocused* window. With two Twitch windows side by side, both report visible,
so rule 2 decides — meaning presence follows **the stream you last touched**,
not the one you are looking at. `document.hasFocus()` would disambiguate this
and is **not currently used**.

**Background tab navigation is throttled.** The 400 ms `setInterval` in
`watchChannel` is throttled by Chrome to ≥1 s in a hidden tab, and after roughly
five minutes hidden, to approximately once per minute (intensive throttling). A
background tab that navigates on its own can therefore be a long time out of
date. This is currently harmless — a hidden tab loses the pick anyway — but it
would stop being harmless the moment secondary streams became meaningful.

### Downstream consumers, and a consequential asymmetry

`currentChannel()` (`src/background/index.ts:709`) returns the effective
activity channel **immediately**.

`sessionChannel()` (`:765-774`) is stricter:

```ts
function sessionChannel(): string | null {
  if (authState.status !== 'signed_in') return null
  const here = currentChannel()
  if (!here) return null
  const reported = presenceReporter.lastReported()
  if (reported?.type !== 'watching' || reported.channel !== here) return null
  return here
}
```

It returns null until the presence **write has actually landed** — deliberately,
because `stream_room_members` refuses unless the caller's presence puts them on
the channel, and asking too early returned an empty room that was then cached.

**Consequence: there is a 1–2 second window on every channel change during which
`sessionChannel()` is null.** In that window `pushActivity()`
(`src/background/index.ts:922-955`) calls `roomChat.setChannel(null)`, which
**clears the message buffer and does not fetch**
(`src/background/roomMessages.ts:174-190`), and `room.want(null)`, which clears
the roster. This is a real contributor to #10.

### What is driven by the single effective channel

Presence; Social Gravity; HERE; JOIN; automatic Stream Room membership,
messages and reactions; gathering notifications; the emote catalog; and every
channel-dimensioned analytics event.

**Group chats are entirely unaffected by any of this** — they key on `group_id`
and never consult presence.

---

## 6. Recommended multi-stream model

**Recommendation: do NOT build PRIMARY + SECONDARY yet.** It is the right
instinct at the wrong time, and one cheap change captures most of the value.

### What Chrome MV3 and this architecture can reliably know

| Signal | Reliable? | Assessment |
| --- | --- | --- |
| `document.hidden` | **Yes** | Already used. Accurate per tab; weak across windows. |
| `document.hasFocus()` | **Yes** | Distinguishes two visible windows. **Not currently used.** Cheap and correct. |
| Recency of navigation / switch | **Yes** | Already the tie-break. |
| Recent user interaction in the tab | **Yes**, cheap | Pointer/key listeners in the content script. Not currently gathered. |
| Audio / playback state | **No** | Requires reading Twitch's player DOM, which the project forbids. |
| `chrome.tabs.query({audible: true})` | **No** | Requires the `tabs` permission, which is deliberately not requested and is the permission a store reviewer most expects a product like this to abuse. `docs/checkpoints/chrome-web-store-private-beta-readiness.md` states this explicitly as a selling point. **Not worth it.** |
| Player paused vs playing | **No** | Same objection as audio. |

**The honest signal set is: visible + focused + recent interaction + recency.**
That is enough to pick a good primary. It gives **no** reliable way to
distinguish "a second stream genuinely being watched" from "a tab I forgot to
close" — which is the entire difficulty, and the reason to wait.

### Recommended now — one small change, no schema, no new concept

Add `document.hasFocus()` to the activity report and prefer **focused-and-visible**
over merely-visible in `activity.ts`'s `pick()`.

- It is a pure function change, fully unit-testable without a browser.
- It fixes the two-window case, which is a real and currently wrong answer.
- It changes nothing else, and adds no product surface.

This is listed as a *candidate* in §14 rather than a required fix, because no
tester reported it — it was found by inspection.

### Recommended later, and only on evidence

If secondary streams are eventually built, the shape that preserves the thesis
is:

- **`presence` keeps exactly one channel — the primary.** Social Gravity, HERE,
  JOIN, automatic Stream Rooms, gathering notifications and every
  channel-dimensioned analytic stay on the primary **and only the primary**.
  These surfaces answer "where are my people, and can I go there"; an answer of
  "Jake is in four places" destroys the question.
- **Secondary streams become a separate, additive, lower-tier fact** — at most a
  small "+2 more" affordance on a friend's row. Informational. Never a gravity
  cluster, never a room, never a notification, never a JOIN target.

**The containment is the point.** The failure mode to avoid is a friend with
three tabs open appearing as three separate gravity clusters of one, which
fragments the map the product exists to draw. If secondary streams cannot be
kept out of Gravity, they should not be built.

### The product question that must be answered first

**Is a background Twitch tab "watching"?**

The evidence available suggests mostly not — people leave tabs open for hours.
If that is right, then secondary streams are noise, and the correct long-term
answer is what exists today plus `hasFocus()`. That question should be answered
from beta behaviour, not from architecture.

**No new multi-stream semantics have been implemented.**

---

## 7. Stream Room lifecycle

Worth stating in full, because it is the least intuitive thing in the product
and it is what makes §8 comprehensible.

### A room has no record

There is no room table, no room id, and no membership table. **A room *is* the
connected component of the friendship graph among people whose presence puts
them on a destination**, computed on demand by `stream_room_members()`. This is
stated as a design commitment in `supabase/migrations/0021_room_messages.sql:20-25`
and in `src/core/roomMessages.ts:40-44`.

### Recipients are materialised at send time — and that is the security model

`send_room_message` (`0021_room_messages.sql:137-224`):

```sql
insert into public.room_messages (recipient_id, sender_id, channel, body)
select m.user_id, v_actor, v_channel, v_body
  from public.stream_room_members(v_channel) m
 union all
select v_actor, v_actor, v_channel, v_body;
```

One row **per recipient**, plus one for the sender. The read policy is only:

```sql
create policy room_messages_select on public.room_messages
  for select to authenticated
  using (recipient_id = (select auth.uid()));
```

No channel predicate, no `is_friend`, no component walk — because the
authorization decision already happened when the row was written. A room that
splits stops delivering; a room that merges never backfills. A permissive read
can never resurrect what was never written.

**The consequence that matters for #10: if you were not present when it was
said, it was never addressed to you, and it will never appear — no matter how
soon you return.**

### The sender's self-row is deliberate

It exists so that a message appears by exactly one route. Nothing is drawn
optimistically (`src/background/roomMessages.ts:196-206`), so a message the
server declined never appears for the one person who could not otherwise tell.

### Bounds — two dimensions, because one is not enough

Swept opportunistically inside `send_room_message`, by whoever next speaks:

- **30 minutes** — covers a page refresh, a worker eviction, an ad break, and
  stepping away.
- **200 rows per recipient per channel** — retention cost is
  messages × recipients and a room can hold fifty people, so the clock alone
  would not bound a fast conversation.

The client agrees exactly: `RETENTION_MS = 30 * 60_000` and
`MAX_MESSAGES = 200` (`src/core/roomMessages.ts:67-69`).

### Sending requires live presence

`send_room_message` refuses unless the caller is `online`, on that `channel`,
with `last_seen_at > now() - interval '90 seconds'`.

### Client-side lifecycle

`roomMessages.setChannel` (`src/background/roomMessages.ts:174-190`) clears the
buffer whenever the channel changes and re-fetches history **even when the
channel did not change** — which is what makes a page refresh or a worker
eviction recover the conversation rather than start an empty one. The inbox
subscription is **per user**, not per channel, and survives channel changes.

`history()` (`src/background/supabaseBackend.ts:685-702`) selects from
`room_messages` filtered by channel, newest-first, capped at `MAX_MESSAGES`,
with RLS doing the authorization. **This path is correct and was verified by
inspection; it is not implicated in #10.**

---

## 8. Root cause of disappearing messages (#10)

**Grade: PROVEN ROOT CAUSE.**

### The mechanism

`src/ui/KickbackPanel.tsx:236-237`:

```ts
const sessionAvailable =
  sessionChannel !== null && (view.roomPeers.length > 0 || view.roomMembers.length > 0)
```

`sessionPeers()` (`src/background/index.ts:806-820`) **excludes self**:

```ts
for (const [userId, presence] of Object.entries(presenceIndex)) {
  if (userId === selfId || !friendIds.has(userId)) continue
  if (describePresence(presence, viewer).kind === 'watching_with_you') peers.push(userId)
}
```

`room.snapshot()` is `stream_room_members`, which also excludes the caller —
confirmed by `roomSize()` at `:503-505` returning `members + 1`.

**Therefore: the Stream Room surface exists only while at least one *other*
person is live on the channel. Its messages live for thirty minutes. Two
different lifetimes, and the shorter one silently hides the longer one.**

The same rule gates restoration — `restoredSession()` (`:480-488`) will not
reopen a remembered session unless `room.snapshot().length > 0 || sessionPeers().length > 0`.

### What the tester experienced, step by step

1. She and the owner are both on channel A. The room exists; they talk. Rows are
   written to both inboxes and retained for thirty minutes.
2. She switches to another Twitch tab, **or** the owner navigates away.
3. The co-present set on A empties (or her own presence moves off A) →
   `sessionAvailable` becomes false → **the session tab disappears and the panel
   falls back to Friends, mid-conversation.**
4. The rows are still on the server and still in the client buffer. **There is
   simply no surface rendering them.**
5. When someone returns to A, the tab reappears and history re-fetches — so the
   messages "come back". Which is exactly the shape of *disappeared*, rather
   than *deleted*.

### Two further layers, in decreasing severity

**Permanent, and by design.** Anything said on channel A while her presence was
on channel B was never written for her (§7). Returning within thirty seconds
does not recover it, because there is nothing to recover. This is correct
security behaviour and confusing product behaviour, and it is the part that is
genuinely unrecoverable.

**Transient, 1–2 seconds.** Every channel change passes through
`sessionChannel() === null` (§5), which calls `roomChat.setChannel(null)` →
buffer cleared, no fetch — then the presence write lands and it re-fetches. A
glance during that window shows an empty room even when nothing else is wrong.
Rapid tab switching also produces one history fetch per switch.

### Against the brief's test matrix

Channel A, messages sent, switch to B, return to A:

| Return after | What SHOULD exist for her | What the UI actually shows |
| --- | --- | --- |
| **30 s** | her own messages, plus anything sent while she was present on A | **Nothing at all if no other friend is on A at that moment** — the session tab does not exist. If someone is there: all of it, after a ~1–2 s re-fetch. |
| **5 min** | same | same |
| **20 min** | same | same |
| **> 30 min** | nothing — swept server-side, pruned client-side | empty, **correctly** |

In every row, messages sent on A *while she was on B* are absent permanently and
correctly, and are not recoverable at any interval.

### Verdict against the brief's options

**C (room identity/lifecycle behaviour) and E (frontend state reset), with a
permanent slice of B (expected ephemeral retention).**

Explicitly **not**:

- **A — actual data loss.** No. Rows persist for the full thirty minutes.
- **D — subscription reset.** No. The inbox subscription is per user and
  survives channel changes (`src/background/roomMessages.ts:126-170`).
- **F — query/history bug.** No. `history()` is correct.

### TAB SWITCH versus STREAM NAVIGATION

**To the backend they are identical.** Both resolve to "the effective activity
channel changed", and presence carries one channel either way. There is no code
path that distinguishes them.

They differ only in **how fast** and **how many tabs report**:

- *Stream navigation* in a focused tab: `watchChannel` fires within ~400 ms; one
  tab reports.
- *Tab switch*: `visibilitychange` fires in **two** tabs, and the registry
  re-picks.

**The user experiences these as very different actions, and the product treats
them as the same event.** That asymmetry is itself worth knowing, and it is a
reason the disappearance felt arbitrary: switching tabs silently changed which
conversation existed.

### Recommendation — minimal, and it changes no semantics

Make `sessionAvailable` accept **either** co-presence **or** live messages on
that channel. That is a ~3-line change in `KickbackPanel.tsx`.

It changes **no** retention, **no** RLS, **no** fan-out, and **no** definition of
a room. It only keeps the door open on a conversation that already exists for as
long as that conversation exists.

**It does not fix the permanent layer** — messages sent while she was elsewhere
still never existed for her. That is a deliberate property of the security model
and changing it would require abandoning send-time materialisation. **Do not
change retention semantics as part of this.**

---

## 9. Root cause of the `ohjuliego` group participation bug (#9 in the brief's numbering; #3 here)

**Grade: UNRESOLVED — NEEDS EVIDENCE.**

Full analysis in §2. Summary of the epistemic position:

- **PROVEN ELIMINATION:** the entire server-side hypothesis space — RLS, RPC
  grants, membership creation, invite/accept transitions, SELECT-versus-INSERT
  divergence, 0022 block predicates, and the `list_group_messages` inner join on
  `public.users` — was tested by execution against the real migrations in real
  PostgreSQL, as each user, under RLS. Everything passes.
- **PROVEN by inspection:** errors are surfaced, not swallowed. The composer is
  never disabled by membership. `groupSync.setGroups` is correctly wired to the
  groups-state subscription.
- **STRONG HYPOTHESIS (a):** un-awaited `removeChannel` teardown plus a channel
  topic keyed by group **count** rather than content
  (`src/background/supabaseRealtime.ts:289`, `:356`) can hand back a dying
  channel with no bindings — producing a silent, error-free, permanent failure to
  receive, including of the user's own messages.
- **STRONG HYPOTHESIS (b):** a failed `listMembers` leaves the roster absent,
  after which every realtime message is dropped and triggers another refresh —
  a quiet livelock.
- **STRONG HYPOTHESIS (c):** she was looking at the non-clickable **Invitations**
  row rather than a joined group.

**No root cause is claimed.** The five specific pieces of evidence that would
close it are listed at the end of §2.

---

## 10. Large friend list — scaling assessment

### A. Backend / query / realtime — this is the wall

**Realtime presence is one binding per friend.**
`src/background/supabaseRealtime.ts:97-141` opens a **single channel** and
attaches a **separate `postgres_changes` listener per friend**, each filtered
`user_id=eq.<friendId>`:

```ts
const channel = supabase.channel(`${PRESENCE_PREFIX}:${friendIds.length}:${friendIds[0]}`)

for (const friendId of friendIds) {
  channel.on('postgres_changes',
    { event: '*', schema: 'public', table: 'presence', filter: `user_id=eq.${friendId}` },
    …)
}
```

This is **deliberate and correct**. The file documents why: it is what makes the
payloads safe to use directly instead of re-reading, including for DELETEs which
Supabase does not run RLS against — and it is what avoids the hosted
one-row-many-subscribers defect that broke reactions in 0019 and forced the 0020
fan-out. It is also unavoidably linear.

| Friends | `postgres_changes` bindings | Assessment |
| --- | --- | --- |
| **50** | 50 | Fine. Well inside limits. |
| **250** | 250 | **Exceeds Supabase's documented per-client cap on `postgres_changes` listeners** — 100 at the time of writing, and this figure **should be re-confirmed against current Supabase limits before any action is taken.** Expected failure: `CHANNEL_ERROR` → `socialSync`'s retry ladder spins → **presence silently stops updating** with no user-visible error. |
| **1 000** | 1 000 | Broken. Additionally O(friends) filter evaluations per WAL row on the realtime server. |

**Secondary defect in the same line.** The channel topic is
`` `${PRESENCE_PREFIX}:${friendIds.length}:${friendIds[0]}` `` — friend **count**
plus first id. Two different friend sets of equal size that share a first member
collide on one topic. Harmless at beta scale; latent at any other. The group
channel has the same shape (`:289`).

**`list_friends()` has no LIMIT** (`supabase/migrations/0003_*.sql`). It joins
`friendships → users → connected_accounts → presence` ordered by display name.
The payload at 1 000 rows is not itself a problem; the binding count is.

### B. Rendering performance

**`FriendsTab` re-filters the whole list once per section.**
`src/ui/components/FriendsTab.tsx:52-54`:

```ts
{SECTIONS.map((section) => {
  const people = friends.filter((friend) => bucketOf(friend, localActivity) === section.key)
```

`SECTIONS` has five entries, so that is **five full passes** over the friends
array on every render, with no `useMemo`, followed by one `PersonRow` per
friend. **No virtualization anywhere.** At 1 000 friends: 5 000 `bucketOf` calls
and 1 000 mounted components per render.

**But the message bus saturates first.** `broadcast()` is called from **15 sites**
in `src/background/index.ts` and is **not debounced or throttled** (verified: no
`setTimeout`/debounce around it). Each call builds a complete state snapshot via
`currentState()` (`:1000-1048`) — spreading all rosters, all channel names, all
channel metadata, all room messages, all group messages — and `postMessage`s it
to **every** open Twitch tab.

With 1 000 friends heartbeating every 45 s, that is roughly 22 full-state
serialisations per second, each cloned once per open tab. **The port bus is the
bottleneck well before React is.**

The panel additionally re-renders on a 15-second clock tick
(`src/ui/useKickbackState.ts:46-48`), which is correct — it is what makes a
friend whose heartbeat stopped fade to offline — but it multiplies any
per-render cost.

### C. UX

The brief is right that a 1 000-row flat list is not the answer, and **the
better answer already exists**: `src/core/socialGravity.ts` already clusters
friends by destination (`socialGravity()` at `:163`, `gravityOpportunities()` at
`:250`). The long-term Friends tab should be Gravity clusters first — "7
watching summit1g", "4 watching theburntpeanut" — with search and the flat list
beneath.

That is a product direction, not a scaling fix, and it should be driven by the
beta rather than by this report.

### What needs action

**Now: nothing.** Three testers. Building for 1 000 today is exactly the
speculative scale infrastructure the brief warns against.

**In order, when triggered:**

1. **Debounce `broadcast()`** (~10 lines). Helps at every scale, including
   three testers, and is worth taking whenever `index.ts` is next touched.
2. **Memoise the `FriendsTab` bucketing** into a single pass. Trivial.
3. **The realtime binding cap.** The only genuinely hard item. Requires either
   chunked channels (multiple `supabase.channel` instances) or a presence
   fan-out table with a single per-user subscription — which is the shape 0020
   and 0021 already established for reactions and room messages, so there is
   precedent and it would not be novel work.

**Watch for:** median friend count crossing roughly 40, or **any** tester
reporting presence that stops updating until they reload. The latter is the
binding cap announcing itself, and it is currently indistinguishable from "the
extension is broken" because we have no realtime-status telemetry (§17).

---

## 11. Large group chat — scaling assessment

Structurally far healthier than stream rooms, for one reason: **group messages
are one row per message**, not a fan-out per recipient.

| Dimension | Current bound | Assessment |
| --- | --- | --- |
| Message history (client) | `MESSAGE_WINDOW = 60` (`groups.ts:73`) | Fine — and the direct cause of #9. |
| Message history (server) | `list_group_messages` limit clamped to ≤ 200 (`0008_group_rpcs.sql:377`) | Fine. |
| Realtime | **one binding per group**, not per member (`supabaseRealtime.ts:291-299`) | Healthy. Scales with number of groups (few), not with people. |
| Membership listing | `list_group_members()` — **unbounded** | **First thing to bite.** A 200-member group ships 200 rows on every `refresh()` and renders 200 in "Where everyone is". |
| Write path | one INSERT, rate-limited 30/min (`send_group_message`) | Fine. |
| Message retention | forever, until group or account deletion | By design; documented in `docs/PRIVACY.md`. |
| Storage growth | linear in messages, not messages × members | Good. |

### The actual bottleneck is `groups.refresh()`

`src/background/groups.ts:195-210`:

```ts
for (const group of list) {
  const [memberResult, messageResult, inviteResult] = await Promise.all([…])
  …
}
```

The three calls per group are parallel, but **the loop over groups is serial**.
Ten groups = ten sequential round trips of three. The code says so honestly:
"Beta scale: a handful of groups, so loading each is fine."

This interacts badly with `onRawMessage` (`index.ts:373-376`), which calls
`refresh()` whenever it meets a sender not in the cached roster. Membership churn
in a busy group can trigger repeated full refreshes — and, per §2 hypothesis (b),
can livelock if `listMembers` is failing.

### Explicitly not recommended

**Do not introduce Redis, Kafka, or custom WebSocket infrastructure.** Nothing
measured here is within an order of magnitude of needing any of it. The current
design is appropriate for its scale and has clear headroom.

### Metrics that would tell us when to act

None of these is currently measured:

- p95 duration of `groups.refresh()`
- largest group's `member_count` (crossing ~50 is the signal for bounding
  `list_group_members`)
- `refresh()` calls per minute per client — a direct proxy for the livelock in
  §2(b)
- group message insert rate per group

---

## 12. Cross-tab panel-state recommendation

**Recommendation: option A — synchronise open/closed state across Twitch tabs.
Also synchronise position.**

### Why A

The panel is one thing, the way a chat window is one thing. Collapsing it in one
tab and finding it expanded in the next reads as the extension forgetting what
you told it. The complaint in the brief — "the experience may feel tab-local" —
is a direct consequence of state that is *stored* globally but *observed*
locally.

### Why it is nearly free

The state is already in `localStorage` (§4), which is already origin-scoped and
already shared across every `twitch.tv` tab. The `storage` event fires in **other
tabs of the same origin and not in the tab that wrote it** — which is precisely
the required semantics, with no background-worker involvement, no new message
type, and no new storage key.

Roughly ten lines in `KickbackPanel.tsx` for `kickback:collapsed`, and the same
treatment in `usePanelLayout.ts` for `kickback:layout` — so that dragging the
panel in one tab moves it in all of them, which is the same principle applied to
the same problem.

### Why not the others

- **B (every new tab defaults closed).** Discards a preference the user
  explicitly expressed. Strictly worse than today.
- **C (remember last global preference).** This is what exists now, and it is
  what generated the complaint.
- **D (per-tab with a global default).** More machinery than the problem
  deserves, and it makes "why is this one different" a question the user has to
  ask.

### One caveat worth accepting deliberately

With a `storage` listener, a panel can collapse or move under the user's cursor
in a background tab. That is the intended behaviour of a synchronised window,
but it is a genuine change and should be watched in the next beta round.

**Not implemented. Awaiting review.**

---

## 13. Firefox compatibility and effort — **MEDIUM**

Lightweight audit only, as instructed. **No port has been started and none
should be.**

### Complete `chrome.*` inventory

Produced by exhaustive search over `src/`:

| API | Uses | Firefox | Work required |
| --- | --- | --- | --- |
| `chrome.storage.local` | 12 | ✅ Supported | **None in practice.** Already behind Kickback's own `AsyncStorageArea` interface (`src/background/storage.ts:10-14`) — a single, clean injection point. |
| `chrome.runtime.Port` / `connect` / `onConnect` | 5 | ✅ | None. |
| `chrome.runtime.getURL` / `onInstalled` / `onStartup` | 3 | ✅ | None. |
| `chrome.alarms.create` / `onAlarm` | 2 | ✅ | None. |
| `chrome.tabs.create` | 1 | ✅ | None. Requires no permission on either browser. |
| `chrome.identity.launchWebAuthFlow` | 2 | ✅ Supported | **Different redirect origin — see cost 2.** |
| `chrome.identity.getRedirectURL` | 1 | ✅ Supported | Same. |
| `chrome.notifications.create` / `clear` | 2 | ⚠️ Partial | `buttons` is **not supported** in Firefox. Kickback's gathering notification uses `buttons: [{ title: 'Join them' }]` (`src/background/notifier.ts:107`). |
| `chrome.notifications.onButtonClicked` | 2 | ❌ **Does not exist** | Real conditional required (`src/background/notifier.ts:90`, wired at `src/background/index.ts:627`). |

### The three genuine costs

**1. `background.service_worker` is Chrome-only.**
`public/manifest.json` declares `"background": { "service_worker": "kickback-background.js" }`.
Firefox MV3 uses **event pages** — `background.scripts` with `"type": "module"`.
This needs two manifests. Mitigating factor: `scripts/package-beta.mjs` already
rewrites the manifest for `--store` mode, so the machinery exists.

**2. The OAuth redirect is a different origin.**
Firefox's `getRedirectURL()` returns `https://<uuid>.extensions.allizom.org/`,
not `https://<id>.chromiumapp.org/`. That requires:

- a `browser_specific_settings.gecko.id` in the Firefox manifest, and
- a **second entry in Supabase's redirect allow-list**.

Mitigating factor: **nothing in `src/` hardcodes an extension ID** — the redirect
comes from `chrome.identity.getRedirectURL()` at runtime, and
`scripts/extension-identity.mjs` is build tooling only. The code is already
ready; this is a dashboard action plus a manifest key.

**3. Notification buttons.**
Feature-detect `chrome.notifications.onButtonClicked` and fall back to a
body-click that performs the same JOIN. Small and self-contained.

### Would the WebExtension polyfill help?

**No — not worth adding.** `webextension-polyfill` earns its place when code
relies on `browser.*` promise semantics. Kickback already wraps `chrome.storage`
in its own promise-shaped interface and passes listeners in explicitly through
dependency injection (`notifier`, `storage`, every service). A handful of feature
detections is cheaper, clearer, and adds no bundle weight or supply-chain
surface.

### Not blockers

MV3 itself, shadow-DOM content scripts, `runtime.Port` messaging, the CSP
posture, the permission set (`identity`, `storage`, `alarms`, `notifications`),
and all three host permissions.

### Verdict

**MEDIUM.** A few days, dominated by packaging and OAuth plumbing rather than by
application code. There is no architectural obstacle.

**Chromium-first stands.** One tester's stated preference is a data point, not
evidence of demand, and `docs/ROADMAP.md` already sequences Firefox after
core-loop validation for good reasons that this beta did not overturn.

---

## 14. Exact fixes recommended NOW

Five, plus one optional. All isolated. **None touches schema, RLS, retention,
the fan-out model, or the thesis.** None is a feature.

| # | Fix | Files | Approx. size | Grade of underlying finding |
| --- | --- | --- | --- | --- |
| **1** | **Group chat autoscroll.** Key the effect on the **last message id**, not `messages.length`. Only follow when the user is already near the bottom. Add a "new messages" jump-to-bottom affordance for when they are not. Scroll the `.kb-chat-log` container directly rather than using `scrollIntoView` (which walks ancestors). Re-anchor on image load so late-loading emotes and avatars cannot push the view off the bottom. | `src/ui/components/Conversation.tsx` (~line 119) | ~40 lines | PROVEN ROOT CAUSE |
| **2** | **"You" everywhere.** Move the self-name substitution into `MessageList`, which already has `selfId`. Delete the self-branch from `StreamSession`'s `nameOf`. | `src/ui/components/Conversation.tsx`, `src/ui/components/StreamSession.tsx:107` | ~6 lines | PROVEN ROOT CAUSE |
| **3** | **Per-user chat colours.** Seed the existing `avatarTint(userId)` onto `.kb-msg-who`. Self keeps `--kb-here`. No database column, no new module, no new palette. | `src/ui/components/Conversation.tsx`, `src/ui/avatarTint.ts`, `src/ui/kickback.css:1469` | ~8 lines | Confirmed defect |
| **4** | **Keep the room open as long as its conversation.** `sessionAvailable` accepts co-presence **or** live messages on that channel. Changes no retention, no RLS, no fan-out. | `src/ui/KickbackPanel.tsx:236` | ~3 lines | PROVEN ROOT CAUSE |
| **5** | **Cross-tab panel state.** Add a `storage` event listener for `kickback:collapsed` and `kickback:layout`. | `src/ui/KickbackPanel.tsx`, `src/ui/layout/usePanelLayout.ts` | ~15 lines | PRODUCT RECOMMENDATION (option A) |
| **6 (optional)** | **Realtime teardown hardening.** `await` the `removeChannel` teardown before re-opening, and key channel topics by a hash of the id set rather than by `.length`. Safe on its own merits and removes the leading suspect for the P0. | `src/background/supabaseRealtime.ts:83, 106, 139, 217, 275, 289, 356`; `src/background/groupSync.ts` | ~20 lines | STRONG HYPOTHESIS (§2a) |

**Candidate, not recommended without a decision:** add `document.hasFocus()` to
the activity report and prefer focused-visible in `activity.ts` (§6). Small and
correct, but no tester reported it.

**That is one build, back in testers' hands quickly. It is deliberately not a
milestone.**

---

## 15. Items recommended for deferral

| Item | Why defer | Revisit when |
| --- | --- | --- |
| **Multi-stream PRIMARY/SECONDARY** | Schema change (`presence` holds one channel). Needs the product decision in §6, which needs beta behaviour. | After the "is a background tab watching?" question can be answered from data. |
| **Firefox port** | MEDIUM effort, no architectural blocker, no demand evidence. | After core-loop validation, per existing roadmap. |
| **Friend-list scale work** | No current problem at three testers. | Median friend count ~40, or any presence-stops-updating report. |
| **Group-chat scale work** | No current problem. Design is sound. | Largest group ~50 members. |
| **List virtualization** | Premature. | Alongside the Gravity-first Friends tab. |
| **Gravity-first Friends tab** | Right direction, but product work rather than a beta fix. | On beta evidence about how people actually scan the list. |
| **Any change to room retention semantics** | The 30-minute / 200-row bounds and send-time materialisation are working exactly as designed. #10 is a surface bug, not a retention bug. | Only with a deliberate product decision, never as a side effect of fixing #10. |
| **Analytics dashboard** | Already correctly deferred in `docs/ROADMAP.md`. Nothing here changes that. | Unchanged. |

---

## 16. Tests that should be added

### The structural gap comes first

`vitest.config.ts:13` sets `environment: 'node'`, and UI tests use
`renderToStaticMarkup`. **No React effect in this codebase has ever executed
inside a test.**

Uncovered by construction, not by oversight: the autoscroll effect, the
`UserCard` positioning effect (`useLayoutEffect`), combo formation and breakage
reporting, `markGroupRead`, and the panel's clock tick.

**Adding a jsdom project for effect-bearing components is the single
highest-value testing change available**, and it is what would have caught #9
before a tester did. It can be added as a second vitest project without
disturbing the existing node-environment suite or its 1712 passing tests.

### Specific tests

| For | Test | Kind | Status if written today |
| --- | --- | --- | --- |
| **#9** | Append messages past `MESSAGE_WINDOW` (60) and assert the scroll effect still fires. | jsdom (new) | **FAILS** — this is the regression test |
| **#9** | Scroll up, append a message, assert scroll position is unchanged and the jump-to-bottom affordance appears. | jsdom (new) | FAILS |
| **#9** | Assert `MESSAGE_WINDOW` and the autoscroll dependency cannot silently diverge — a guard so the same class of bug cannot recur if the cap changes. | node, cheap | n/a (new invariant) |
| **#10** | `sessionAvailable` is true with zero peers when live messages exist for the channel. | node, pure | FAILS |
| **#10** | Deterministic simulated tab switch A→B→A through `roomMessages` + `pushActivity` semantics: assert the buffer refills and the surface returns. **No browser needed.** | node | Would pass; guards the fix |
| **#1** | Extend `tests/extension/attention.test.ts` / a new `activity` suite: two visible tabs in different windows; a hidden tab self-navigating; last-tab-closed grace window; visible-beats-hidden; recency tie-break. | node, pure | Partially covered; gaps |
| **#2** | Assert `MessageList` renders "You" for `selfId` in **both** `GroupChat` and `StreamSession`. | existing `renderToStaticMarkup` harness | FAILS for group chat |
| **#4** | Assert two different user ids receive different colours, and the same id is stable across renders and across module instances. | node, pure | n/a (new) |
| **#7** | Assert a `storage` event flips collapsed state in a mounted panel. | jsdom (new) | n/a (new) |
| **#3** | Promote this session's PGlite probe into `tests/db/groups.test.ts`: the full participation path as a **non-owner, non-friend-of-the-other-member** group member. | PGlite (`tests/db/harness.ts`) | **PASSES** — a guard, not a repro |
| **#5** | Assert the presence binding count equals the friend count, so the linear relationship is explicit and its future change is deliberate. | node | Would pass; documents the wall |
| **#6** | Assert `groups.refresh()` tolerates a failed `listMembers` without entering the drop-and-refresh livelock. | node | Likely FAILS — see §2(b) |

### Multi-tab testing

Per the brief: these should be **deterministic simulations**, not browser
sessions. `createActivityRegistry` is a pure function over a tab map, and
`roomMessages` / `presenceReporter` are dependency-injected with an overridable
clock. Every multi-tab scenario in §5 is expressible as a unit test with no
browser at all. The existing CDP harness (`scripts/verify-test-lab.mjs`,
`scripts/verify-chat-wrapping.mjs`) should be reserved for what only a real
browser can answer — layout and genuine scroll geometry.

### Constraint honoured

**No existing assertion should be weakened to accommodate any of these.** Where
a test would fail today, that is recorded above as the point of the test.

---

## 17. Missing telemetry

**This is the most important item in the report.**

### The gap

`logError` (`src/background/index.ts:116-126`) writes to `console.error` /
`console.warn` and stops:

```ts
console.warn(`[Kickback] ${context} failed:`, error instanceof Error ? error.message : error)
```

Every service is wired to it — `onError: logError` appears at `:136`, `:141`,
`:169`, `:256`, `:285` and throughout. **An RPC refusal, a realtime
`CHANNEL_ERROR`, a failed history fetch, a swallowed send, a subscription that
silently died — none of it ever leaves the tester's machine.**

That is the direct and sufficient reason §2 is unresolved. It will be the reason
the next one is unresolved too.

The 33 registered analytics events cover behaviour thoroughly — sessions,
gravity impressions, JOIN, rooms, combos, groups, blocks, feedback — and cover
**failure not at all**.

### Recommended additions, in priority order

| Event | Properties | What it would have answered |
| --- | --- | --- |
| **`client_error`** | `{context, code}` — both from a fixed vocabulary | §2 directly. The context strings already exist and are already named (`roomMessages.history`, `groupSync.open`, `groups.refresh`, `presence.subscribe`). |
| **`realtime_status_changed`** | `{surface, status}` | Would have shown a silently dead group subscription immediately — hypothesis §2(a) becomes observable rather than inferred. |
| **`automatic_room_left`** | `{reason: 'no_peers' \| 'channel_changed' \| 'signed_out'}` | §8. `automatic_room_entered` is recorded and the exit is not, so the disappearing-surface bug was invisible in the data. |
| **`tab_count`** as a dimension on session events | small integer, bucketed | §1 and §5. We currently cannot distinguish a one-tab tester from a five-tab one, which is exactly the question multi-stream semantics turns on. |
| **`group_message_send_failed`** | `{code}` | Separates "she never sent" from "she sent and never saw" — the single most valuable bit for §2. |

### Privacy posture is preserved

None of the above records message bodies, user identities, friend codes, email
addresses, URLs, emote content, or browsing history. The existing analytics
writer already caps property values at 64 characters and discards unknown keys
server-side, which makes it **structurally impossible** to smuggle content
through these events even by mistake. All of it stays inside the commitments in
`docs/PRIVACY.md`.

### Owner action required — flagged, not done

Each new event name needs a row in `public.analytics_event_names`, so this is a
**migration (`0024`)** applied to hosted, and it would bump
`analytics_schema_version()` from 23 to 24.

**No migration has been written**, per this task's constraints. This is recorded
as a recommendation requiring explicit authorisation.

---

## 18. Proposed roadmap changes

**The learning rule in `docs/ROADMAP.md` holds and is not being bent.**
Everything recommended in §14 falls squarely inside the categories the
observation window already permits: P0 breakage, serious reliability bugs, and
extremely obvious UX blockers preventing normal use. **Nothing proposed is a
feature, and nothing is a reaction to an individual suggestion.**

### Entries to add

**Under ACTIVE — Private beta:**

- **First beta findings recorded.** Link this report. Note that Day 0 held: no
  analytics or hosted state was touched by the investigation.

**Under "Decided, and not to be re-opened without new evidence":**

- **Multi-stream presence — OPEN PRODUCT QUESTION, not a bug.** Record the
  current rule verbatim (visible beats hidden; recency breaks ties; `presence`
  holds exactly one channel) so it is not rediscovered by the next person to
  look. Record the containment decision: **if secondary streams are ever built,
  Gravity, JOIN, HERE, rooms and notifications stay on the primary only.**
- **Stream Room surface lifetime — DECIDED.** The room's *messages* live thirty
  minutes; the room's *surface* must not be shorter. Record this explicitly so
  the co-presence gate is not reinstated later as a "fix" for something else.
- **Firefox — AUDITED, MEDIUM, DEFERRED.** Record the two real costs (event
  pages instead of a service worker; a second OAuth redirect origin requiring a
  Supabase allow-list entry) so the estimate is not re-derived from scratch.

**Under "Known gaps, carried forward":**

| Gap | Impact |
| --- | --- |
| **No error telemetry of any kind** | The first real bug report could not be diagnosed. Every extension failure is `console.warn` only. |
| **No React effect has ever run in a test** | Produced a shipped P1 (#9) and will produce more. `environment: 'node'` + `renderToStaticMarkup` cannot execute effects. |
| **Realtime presence is one binding per friend** | Linear and unavoidable in the current design. Expected to break somewhere between 100 and 250 friends, silently. |
| **`broadcast()` is undebounced** | Every state change serialises the full snapshot to every tab. Fine at three testers; the first thing to bite at scale. |
| **Tab switch and stream navigation are indistinguishable to the backend** | The user experiences them as very different actions; presence treats them identically. |

**Under Analytics:**

- **Error and realtime-status telemetry — promote above the deferred analytics
  dashboard.** The dashboard remains correctly deferred; the ability to see a
  failure at all does not.

### One observation worth recording explicitly

`ohjuliego` is the **first tester who is not an owner account**, and the first
finding she produced was "I can see it but I can't use it." Whatever its
eventual cause turns out to be, that lands squarely on the cold-start gap the
roadmap already records — and it is a reminder that a successful beta validates
the core social loop, not the ability of an unfamiliar person to find their way
in.

---

## Appendix A — Constraints observed

| Constraint | Status |
| --- | --- |
| Do NOT implement anything | Observed. No product code changed. |
| Do NOT modify product code | Observed. `git status` clean apart from this report. |
| Do NOT make migrations | Observed. `0024` described in §17, not written. |
| Do NOT change hosted Supabase state or config | Observed. No hosted connection was made. |
| Do NOT publish anything | Observed. |
| Do NOT mutate hosted production / private-beta data | Observed. All database work was in ephemeral in-process PGlite. |
| Do NOT reset analytics | Observed. |
| Do NOT publish a new Chrome Web Store version | Observed. |
| Do NOT weaken existing assertions | Observed. No test was modified. |
| Preserve the product thesis | Observed. Nothing here alters Presence → Social Gravity → JOIN → Together. |
| Do not turn an unresolved hypothesis into a claimed root cause | Observed. §2 and §9 are graded UNRESOLVED and say so repeatedly. |

## Appendix B — Method

- **Static analysis** of `src/background/`, `src/ui/`, `src/core/`,
  `src/content/`, `src/platforms/twitch/` and all 23 migrations.
- **Execution against real PostgreSQL.** PGlite (`@electric-sql/pglite`) running
  `supabase/.generated/apply_all.sql` — every real migration in order — with a
  Supabase auth shim providing `auth.users` and `auth.uid()`, and impersonation
  via `set role authenticated` + `request.jwt.claim.sub`, matching
  `tests/db/harness.ts`. This is how §2's elimination was obtained.
- **Baseline regression run.** `npx vitest run` — 61 files, 1712 tests, all
  passing, before any investigation began.
- **Exhaustive API inventory** for §13, by pattern search over `src/`.

**All file and line references in this report were re-verified against the
working tree at the time of writing.**

## Appendix C — Line references, re-verified

| Reference | Subject |
| --- | --- |
| `src/ui/components/Conversation.tsx:119-122` | Autoscroll effect (#9 root cause) |
| `src/background/groups.ts:73` | `MESSAGE_WINDOW = 60` |
| `src/background/groups.ts:281-283` | `.slice(-MESSAGE_WINDOW)` — pins `.length` |
| `src/background/groups.ts:195-210` | Serial refresh loop; conditional roster assignment |
| `src/ui/KickbackPanel.tsx:236-237` | `sessionAvailable` (#10 root cause) |
| `src/ui/KickbackPanel.tsx:76`, `:88-104`, `:118` | `kickback:collapsed`, read once at mount |
| `src/ui/layout/usePanelLayout.ts:30` | `kickback:layout` |
| `src/ui/components/StreamSession.tsx:107-108`, `:215-221` | `nameOf` → "You" (#2) |
| `src/ui/kickback.css:1469-1477` | `.kb-msg-who` single accent colour (#4) |
| `src/ui/avatarTint.ts` | Existing deterministic 8-colour palette |
| `src/background/activity.ts:63-77` | The multi-tab pick rule |
| `src/background/presence.ts:70-73`, `:139` | Debounce / heartbeat / grace constants |
| `src/background/index.ts:709`, `:765-774` | `currentChannel()` vs `sessionChannel()` |
| `src/background/index.ts:806-820`, `:480-488` | `sessionPeers()`, `restoredSession()` |
| `src/background/index.ts:922-955` | `pushActivity()` |
| `src/background/index.ts:116-126` | `logError` — console only (§17) |
| `src/background/index.ts:1361-1402` | `handleRpc` — errors surfaced |
| `src/background/index.ts:1426-1436`, `:1570-1576` | Port as tab key |
| `src/background/supabaseRealtime.ts:106` | Presence channel topic keyed by count |
| `src/background/supabaseRealtime.ts:108-121` | One binding per friend (§10) |
| `src/background/supabaseRealtime.ts:289`, `:356` | Group channel topic + un-awaited teardown (§2a) |
| `src/background/roomMessages.ts:174-190` | `setChannel` clears buffer |
| `src/background/supabaseBackend.ts:685-702` | `history()` — correct |
| `src/core/roomMessages.ts:67-69` | `RETENTION_MS`, `MAX_MESSAGES` |
| `src/ui/components/FriendsTab.tsx:52-54` | Five filter passes, no virtualization |
| `src/ui/components/GroupsTab.tsx:496-525` | Non-clickable Invitations row (§2c) |
| `src/platforms/twitch/navigation.ts:40-67` | SPA navigation detection |
| `src/background/notifier.ts:107` | Notification `buttons` (Firefox gap) |
| `supabase/migrations/0001_schema.sql:109-122` | `presence` — one channel per user |
| `supabase/migrations/0007_groups.sql:78-89`, `:239-246`, `:270-277` | `is_group_member`, `users_select`, grants |
| `supabase/migrations/0008_group_rpcs.sql:126`, `:222`, `:300`, `:356` | Group RPCs |
| `supabase/migrations/0021_room_messages.sql:137-224` | `send_room_message` fan-out and sweep |
| `supabase/migrations/0022_blocks.sql:825-842` | `group_message_visible` and its policy |
| `vitest.config.ts:13` | `environment: 'node'` — no effects in tests |

---

*End of report.*
