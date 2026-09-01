# Watchside — Feature inventory

*The authoritative living record of what exists, who can reach it, and how ready
it is for strangers. Audited at M4.5 (2026-09-01, `71ab6ef`).*

## Lifecycle vocabulary

| | Means |
| --- | --- |
| **PLANNED** | decided, not built |
| **IMPLEMENTED** | code exists on `main` |
| **USER-FACING** | a normal eligible user can **discover and use** it |
| **RELEASED** | present in a published/distributed build |
| **VERIFIED** | proven to work in the environment it was released to |

**The invariant:** a feature is not user-facing complete unless we can describe
how somebody encounters it. Code on `main` is not shipping.

## Release baseline

| Build | Chrome | Firefox |
| --- | --- | --- |
| Published | **0.6.0** (live) | none — 0.6.0 pending first AMO review |
| Submitted | 0.7.0 (owner-reported) | none |
| Development HEAD | 0.7.0 + M3D (unreleased) | same |

Everything marked RELEASED below means **0.6.0**, unless it says 0.7.0.
Anything added after the 0.7.0 package — all of M3D — is **IMPLEMENTED only**.

## Readiness key

`READY` · `M5 POLISH` · `M5 BLOCKER` · `POST-LAUNCH` · `EXPERIMENTAL` · `REMOVE`

---

## 1. Twitch sign-in

**Status:** VERIFIED (0.6.0) · **Readiness:** READY

Discovery: the panel's only control when signed out. Flow: *Continue with
Twitch* → Chrome `identity` / Firefox `identity` → Supabase PKCE → panel shows
identity. Visible whenever signed out. Empty state is the sign-in card itself.

Chrome + Firefox. Backend: Supabase Auth, `connected_accounts`, `users`.
Analytics: `authenticated_session_started`.

**Since 0.7.0 (unreleased):** the initial authorization also requests
`user:read:follows`. No released build does.

Tests: `followPermission`, `authService`, Firefox E2E `03-platform`.

## 2. Presence

**Status:** VERIFIED (0.6.0) · **Readiness:** READY

Discovery: automatic. Nothing to find — being on a Twitch tab publishes the
channel to friends, subject to the visibility setting. Multi-destination since
0.5.0: every open live stream is published, not just the focused one.

Limitations: heartbeat-based, so presence is stale-tolerant rather than instant;
a closed laptop shows as away only after the staleness window.

Backend: `presence`, `presence_destinations`. Analytics:
`friend_presence_impression`.

## 3. Social Gravity

**Status:** VERIFIED (0.6.0) · **Readiness:** M5 POLISH

Discovery: the Friends tab, above the friend list. Shows clusters of friends on
the same channel, ranked, with JOIN. **Empty until at least one friend is
watching**, which for a new user is indefinitely.

Flow: see a card → JOIN → Twitch opens on that channel → arrival is attributed.
Multi-destination aware. The "gathering" emphasis needs ≥2 friends on one
channel (`GRAVITY_THRESHOLD`), unreachable in a two-person beta.

**M5 polish:** a stranger has no way to learn what Social Gravity *is* — it
either shows cards or shows nothing, and nothing is the common case early.

Analytics: `gravity_cluster_impression`, `join_clicked`, `join_arrived`.
Tests: `socialGravity`, Firefox E2E `05-social`.

## 4. JOIN

**Status:** VERIFIED (0.6.0) · **Readiness:** READY

Discovery: on every friend row, user card, group cluster and Gravity card.
Flow: click → Twitch navigates → arrival matched to the click by attribution.
Clicking JOIN on the channel you are already on is recorded and navigates
nowhere, by design.

Analytics: `join_clicked` → `join_arrived` → `watching_together_*` /
`channel_dwell_ended`. Since 0.7.0+M3D (unreleased) it also drives the follow
baseline.

## 5. Friends and friend requests

**Status:** VERIFIED (0.6.0) · **Readiness:** M5 POLISH

Discovery: the **+** button beside the panel tabs → *Find friends*. Search by
Twitch username or friend code. Incoming requests appear at the top of the
Friends tab with accept/decline.

Flow: search → Add → they accept → both see each other. Your own friend code is
in the account panel, copyable.

**M5 polish:** the **+** is the only door to the entire growth loop, and it is a
small unlabelled icon. Everything in §6–§8 is behind it.

Empty state: *"Your Watchside is quiet. Your friends will show up here once you
add them."* with a **Find friends** button — good.

Analytics: `friend_search`, `friend_request_sent`, `friend_request_accepted`,
`friend_removed`.

## 6. Suggested friends (people you may know)

**Status:** IMPLEMENTED · RELEASED (0.6.0) · **not reliably USER-FACING**
**Readiness:** **M5 BLOCKER**

Discovery: **+** → *Find friends*, below the search box, only while the search
box is empty. Mutual-friend suggestions with a count, never names.

**Two problems, both discoverability rather than implementation:**

1. **It renders `null` when there are no suggestions** — no empty state. A user
   cannot tell the difference between "nothing to suggest" and "not a feature".
2. Suggestions come from friends-of-friends, so a user with **zero or one
   friend has none by construction** — it is invisible exactly when a new user
   most needs it.

Backend: `suggest_friends` RPC (0026). Analytics: exposure is **not** measured —
there is no impression event, so we cannot tell whether anybody has ever seen a
suggestion.

## 7. Invite links / referrals

**Status:** IMPLEMENTED · RELEASED (0.6.0) · **partially USER-FACING**
**Readiness:** **M5 BLOCKER**

Discovery: **+** → *Find friends* → *Invite a friend*, with a copyable link.
Flow: copy → share → recipient opens the landing page → installs → signs in →
referral attributed.

**Findings:**

- The link base is **`https://anoteros-labs.github.io/watchside/invite/`** —
  a GitHub Pages URL that M5 must migrate to `watchside.app/i/<code>` while
  keeping the old one working.
- `referral_succeeded` is **registered in the analytics contract and emitted by
  nothing**. The growth loop's success outcome is unmeasured.
- Referral state is surfaced only as a count next to the invite box.

Analytics present: `invite_link_shared`. Missing: acceptance, install handoff,
success.

## 8. Badges

**Status:** IMPLEMENTED · RELEASED (0.6.0) · **weakly USER-FACING**
**Readiness:** M5 POLISH

Discovery: account panel → badge shelf. Earned badges are shown; **unearned ones
are not**, so there is no way to learn what can be earned or how.

`badge_awarded` is **registered and emitted by nothing** — we cannot tell
whether badges have ever been awarded, or whether anybody looked.

Backend: `badges`, referral milestone logic (0026).

## 9. Stream Rooms (Automatic Together)

**Status:** VERIFIED (0.6.0) · **Readiness:** M5 POLISH

Discovery: a contextual tab labelled with the streamer's name, which appears
only while you are on a channel where somebody else is. Nothing is created or
joined — the room forms because two people are in the same place.

Includes: roster, ephemeral chat, reactions, combos. Messages are deleted after
30 minutes server-side.

**Overlap risk with Groups (§10)** is real: both present as a chat surface, and
nothing in the product explains why there are two.

Analytics: `automatic_room_entered` is emitted; **`automatic_room_opened` and
`automatic_room_left` are registered and emitted by nothing** — room lifecycle
is half-measured.

## 10. Groups

**Status:** VERIFIED (0.6.0) · **Readiness:** M5 POLISH

Discovery: the Groups tab. Create, invite by friend, accept, leave; group chat
and a presence summary of where members are watching.

Predates Social Gravity as the primary loop. It still earns its place —
durable circles are a different thing from an ephemeral room — but the product
never says so.

Analytics: `group_invite_sent`, `group_invite_accepted`, group chat events.

## 11. Chat, reactions and emotes

**Status:** VERIFIED (0.6.0) · **Readiness:** EXPERIMENTAL

Two surfaces: Stream Room chat (ephemeral, 30-minute retention) and group chat
(durable). Built-in Watchside emotes plus 7TV emotes for the channel. Reactions
and combo bursts.

**The open product question, unchanged:** *if Watchside chat disappeared
tomorrow, would users care?* That is empirical and the beta has not answered it.
Message bodies are never recorded, so the analytics can say how much chat
happens but never what it was.

## 12. Notifications

**Status:** VERIFIED (0.6.0) · **Readiness:** M5 POLISH

Discovery: a desktop notification when friends gather on a channel; the toggle
is in the account panel, on by default. Cooldowns prevent repeats.

Clicking one is a real JOIN through the same path as the button.

**M5 polish:** if the browser denies notification permission there is no
in-product explanation of why nothing arrives.

Analytics: `gathering_notification_shown`, `gathering_notification_clicked`.

## 13. Block and mute

**Status:** VERIFIED (0.6.0) · **Readiness:** READY

Block: server-enforced, removes the friendship, never disclosed to the other
person, undoable from the account panel. Mute: local to the device, nothing
sent, undoable from the account panel. Both list who is affected.

Analytics: that a block happened, with no identifiers of either party.

## 14. Presence visibility

**Status:** VERIFIED (0.6.0) · **Readiness:** READY

Account panel: Visible / Hide activity / Invisible. Server-enforced, not a
client filter.

## 15. Feedback

**Status:** VERIFIED (0.6.0) · **Readiness:** M5 POLISH

Discovery: account panel → Feedback. Four categories and a free-text box;
diagnostics (version, environment, browser, friend count, channel, realtime
health) are attached automatically.

**M5 polish:** there is no support URL or public contact route for somebody who
cannot open the panel at all.

## 16. Account and deletion

**Status:** VERIFIED (0.6.0) · **Readiness:** READY

Account panel: identity, friend code, visibility, notification toggle, muted and
blocked lists, reset layout, feedback, sign out, delete account, version.

Deletion requires typing your Twitch login, destroys the account server-side,
and is honest about what goes with it. Sign-out deletes nothing.

## 17. Twitch metadata enrichment

**Status:** VERIFIED (0.6.0) · **Readiness:** READY

Channel display names, live state and box art, fetched server-side and cached.
No viewer-specific data. Failure degrades to the raw login.

## 18. Panel layout

**Status:** VERIFIED (0.6.0) · **Readiness:** READY

Draggable, resizable, collapsible to a launcher with unread badges. Position
persists per device; *Reset layout* in the account panel.

## 19. Viewing-time analytics (dwell)

**Status:** IMPLEMENTED · **RELEASED only in 0.7.0** · **Readiness:** READY

Per-stream viewing duration, including background streams, with focused/background
split and an end reason. Disclosed in full in the privacy policy.

**No published build emits it.** Chrome 0.6.0 cannot; 0.7.0 can, if published.

## 20. M3D creator-discovery measurement

**Status:** IMPLEMENTED · **NOT RELEASED** · **Readiness:** M5 BLOCKER (release)

At an eligible socially initiated JOIN, whether the viewer already followed that
creator. Server-side, privacy-aware, deletion-aware, automatically testable.
See `docs/M3D-MEASUREMENT.md`.

**No released build contains any of it** — not the `user:read:follows` scope,
not the credential custody, not the trigger. Verified by extracting both Store
artifacts. **M3D therefore collects nothing from any real user, and will
continue to collect nothing until a build carrying the scope is published.**

## 21. Experiment arms

**Status:** IMPLEMENTED · RELEASED (0.7.0) · **Readiness:** POST-LAUNCH

Randomised assignment infrastructure exists and is recorded only when the
assignment is a real randomisation. In beta everybody is forced into one arm, so
no experiment is running.

## 22. Test Lab

**Status:** IMPLEMENTED · **development only** · **Readiness:** REMOVE from
public builds (already excluded)

A local harness for driving the panel through simulated states. Not part of the
extension package.

---

## Analytics coverage gaps

Features that exist with **no meaningful analytics**, and therefore cannot be
learned from:

| Gap | Consequence |
| --- | --- |
| `referral_succeeded` registered, never emitted | the growth loop's success is unmeasured |
| `badge_awarded` registered, never emitted | badge awards are unmeasured |
| `automatic_room_opened` / `_left` registered, never emitted | room lifecycle is half-measured |
| Suggested friends has no impression event | we cannot tell whether anybody has seen a suggestion |
| Invite acceptance / install handoff | the referral funnel has a hole in the middle |

## Readiness summary

| | Count |
| --- | --- |
| READY | 9 |
| M5 POLISH | 8 |
| M5 BLOCKER | 3 |
| EXPERIMENTAL | 1 |
| POST-LAUNCH | 1 |
| REMOVE / excluded | 1 |
