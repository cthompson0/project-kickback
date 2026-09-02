# Watchside — Feature inventory

*The authoritative living record of what exists, who can reach it, and how ready
it is for strangers. Audited at M4.5 (2026-09-01, `71ab6ef`); growth surfaces
updated at M5A and public surfaces at M5B (2026-09-01).*

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
| Submitted | 0.7.0 (owner-reported) | **0.6.0 — awaiting first AMO review** |
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

**Changed in M5A.** When no friend is watching anything it now says so, and says
what will appear — a state that is different from having no friends and used to
look identical to it.

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

**Changed in M5A.** The button is labelled `+ Add` — M4.5 described it as
unlabelled, which was wrong; the real problem was that "Add" never said what.
The visible label stays short because four tabs must survive the 280px minimum
width, so it now carries `aria-label="Add friends"`, `title` and
`aria-expanded`, and the zero-friend state carries the discovery weight instead.

Empty state, rewritten in M5A: it now leads with what Watchside does — *"See
where your friends are watching."* — before asking for anything, then says what
it needs and offers **Find friends**.

Analytics: `friend_search`, `friend_request_sent`, `friend_request_accepted`,
`friend_removed`.

## 6. Suggested friends (people you may know)

**Status:** IMPLEMENTED · USER-FACING (main) · RELEASED (0.6.0, older behaviour)
**Readiness:** READY (main) · the released build still has the old behaviour

Discovery: **+** → *Find friends*, below the search box, only while the search
box is empty. Mutual-friend suggestions with a count, never names.

**Fixed in M5A.** It used to render `null` with nothing to suggest, so a user
who had deliberately opened find-friends could not tell whether the feature was
empty, broken or absent — and it is empty exactly when they are new, because
suggestions come from friends of friends. It now says so and points at search
and invite.

Backend: `suggest_friends` RPC (0026). Analytics: `friend_suggestion_impression`
is emitted **from the render**, once per open of the surface — M5A moved it off
the fetch, where every empty result was being counted as an impression of a
surface that draws nothing. M4.5 recorded this event as missing; it existed and
was measuring the wrong thing.

## 7. Invite links / referrals

**Status:** IMPLEMENTED · USER-FACING · RELEASED (0.6.0)
**Readiness:** M5 POLISH — the URL migration remains

Discovery: **+** → *Find friends* → *Invite a friend*, with a copyable link.
Flow: copy → share → recipient opens the landing page → installs → signs in →
referral attributed.

**Findings:**

- The canonical route **`watchside.app/i/<code>`** is built and tested in M5B;
  the domain is PREPARED, not live. The extension still generates the current
  Pages URL on purpose — switching before DNS resolves would produce dead links —
  and M5E flips the one constant. Both shapes are read, so old links keep working.
- `referral_succeeded` is **emitted in M5A**, from `settle_referral` — the one
  authoritative place the three-condition rule is decided, and already idempotent.
- Referral state is surfaced only as a count next to the invite box.

Analytics present: `invite_link_shared`. Missing: acceptance, install handoff,
success.

## 8. Badges

**Status:** IMPLEMENTED · USER-FACING (main) · RELEASED (0.6.0, older behaviour)
**Readiness:** READY (main)

Discovery: account panel → badge shelf. Earned badges and, since M5B, the ones
still to earn — read from `badge_definitions` rather than a client-side ladder.

The catalogue read was written, wired and shipped past a passing typecheck while
the worker never imported the function it calls. `requestCoverage` now asserts
that no handler calls an identifier the worker does not have; see the M5B report
§29 for why `tsc --noEmit` said nothing.

`badge_awarded` is **emitted in M5A**, from `award_badge` — the only place a
badge is ever granted — and only when a row is actually inserted, so a repeat
award emits nothing.

M5A also fixed the badge descriptions, which still said "Brought a friend to
Kickback." and are shown to users in the badge tooltip. They live in the
database, which is why the M4.5 source sweep concluded no human-facing Kickback
branding remained.

**Changed in M5B.** The shelf now shows what is still to earn, from
`badge_definitions` rather than a ladder hardcoded in the client. Locked
milestones render as dimmed non-buttons with "not earned yet" in the tooltip, so
the state is not carried by colour alone. No counter, no progress bar and no
"two more to go" — a visible ladder is not a quota.

Backend: `badges`, referral milestone logic (0026).

## 9. Stream Rooms (Automatic Together)

**Status:** VERIFIED (0.6.0) · **Readiness:** M5 POLISH

Discovery: a contextual tab labelled with the streamer's name, which appears
only while you are on a channel where somebody else is. Nothing is created or
joined — the room forms because two people are in the same place.

Includes: roster, ephemeral chat, reactions, combos. Messages are deleted after
30 minutes server-side.

**Addressed in M5B.** The Groups empty state now draws the distinction in one
sentence: a group stays put, and the tab that appears while you are watching
alongside somebody comes and goes with the stream and is never made by hand.

Analytics: `automatic_room_entered` is emitted; **`automatic_room_opened` and
`automatic_room_left` are registered and emitted by nothing** — room lifecycle
is half-measured.

## 10. Groups

**Status:** VERIFIED (0.6.0) · **Readiness:** M5 POLISH

Discovery: the Groups tab. Create, invite by friend, accept, leave; group chat
and a presence summary of where members are watching.

Predates Social Gravity as the primary loop, and still earns its place — durable
circles are a different thing from an ephemeral room. **M5B makes the product say
so**, in the Groups empty state.

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

**Clarified in M5B.** `notifications` is a **manifest** permission granted at
install — there is no runtime prompt, so there is no denial to recover from and
nothing to nag about. What can still stop a notification is the browser or the
operating system, which Watchside can neither see nor change. The toggle now says
so and links to Support, which explains where the other half lives.

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

**Fixed in M5B; published after GO.** A support route was already live but
covered only feedback and an email address. The replacement is **live** at
`anoteros-labs.github.io/watchside/support/`, published from
`docs/web/pages-watchside/`. It works whether or not the extension does, covering the panel not appearing, sign-in trouble, stale builds,
notifications and account deletion. The account panel links to it beside
Feedback — Feedback stays the better route while Watchside works, because it
attaches context automatically.

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

| Gap | Status |
| --- | --- |
| `referral_succeeded` | **closed in M5A** — emitted server-side from `settle_referral` |
| `badge_awarded` | **closed in M5A** — emitted from `award_badge`, once per award |
| Suggested-friend exposure | **corrected in M5A** — the event existed but fired at the fetch; it now fires at the render |
| `automatic_room_opened` / `_left` registered, never emitted | still open — room lifecycle is half-measured |
| Install handoff | not observable, and not claimed to be |

**Two of these were recorded wrongly at M4.5.** `friend_suggestion_impression`
and `invite_claimed` were described as missing; both existed. The impression was
measuring the wrong thing, which is worse than missing and was only visible by
reading the emitter.

## 23. Public web (watchside.app)

**Status:** IMPLEMENTED · **NOT LIVE** · **Readiness:** M5 POLISH (DNS remains)

Built in M5B: a root page, `/privacy` generated from `docs/PRIVACY.md`,
`/support`, and the canonical invite route `/i/<code>` — which works on a static
host because GitHub Pages answers unmatched paths with `404.html`.

No trackers, no cookies, no external requests of any kind. The root page offers
Chrome, which is genuinely published, and says plainly that Firefox is awaiting
Mozilla's review rather than implying it is available.

**Served by GitHub, not yet reachable at its own name.** The site is published
to `Anoteros-Labs/watchside-app`, a dedicated project Pages site with
`watchside.app` as its custom domain — repository, Pages and domain all
configured through the API. Content is verified correct by addressing a Pages
edge with a `Host: watchside.app` header.

**DNS is live and verified** — all nine records correct at public and
authoritative resolvers, no parking address surviving — and GitHub answers for
the name with bytes identical to the built tree.

**Waiting on the certificate, with nothing blocking it.** GitHub's own Pages
health check reports both `watchside.app` and `www.watchside.app` as
`is_valid: true`, `is_served_by_pages: true`, `caa_error: null` and
**`is_https_eligible: true`** — so issuance is queued rather than refused.
Enforcement is one API call once the certificate exists, needing no owner
action. Because `.app` is HSTS-preloaded, browsers refuse plain HTTP, so **the
domain is not usable until then** — it is not live.
The org site's Pages `cname` is still `null`, so every old URL keeps working
literally, unredirected.

The same sources also build against the **currently live** Pages subpath
(`npm run build:site:pages`), and the exact bytes now served are checked in at
`docs/web/pages-watchside/` with a test asserting they match that build — so the
Support link in a shipped build reaches a real page without waiting for a domain. That tree never carries a `CNAME`,
a `404.html` or an `/i/` route — asserted, because a `CNAME` there would rebind
the whole org site.

Tests: `publicRouting` (41). Build: `npm run build:site`, `npm run build:site:pages`.

## 24. Acquisition attribution (campaigns)

**Status:** IMPLEMENTED (main) · **NOT RELEASED**
**Readiness:** M5 BLOCKER — needs a distributed build to collect anything

How somebody came to Watchside, kept strictly apart from who invited them.
Campaign links are `watchside.app/c/<code>`; the code is the only payload, and
what a campaign *means* — its source, its associated creator — resolves
server-side from `acquisition_campaigns`, so a visitor cannot assert one.

First touch is immutable and is what every report joins on; last touch is kept
separately. The pre-auth touch is held in the extension's own storage for a
**7-day window** (PROVISIONAL) and discarded after that, so a stale click cannot
attribute an unrelated sign-in.

**Coverage limit, stated plainly:** link clicks, Store views and installs are
unobservable without cross-site tracking, which Watchside does not do. A touch
becomes a fact only when it binds to an authenticated account.

**Nothing is collected yet.** `watchside_campaign` is read by no released build,
so campaign measurement begins when a build carrying it ships — which is the
gate on meaningful marketing spend.

Schema 38. Views: `acquisition_actor_v`, `acquisition_campaign_v`,
`acquisition_downstream_v`. Tests: `acquisition` (43 db + 47 core), routing (13).
Minting: `npm run campaign`.

## Readiness summary

| | Count |
| --- | --- |
| READY | 12 |
| M5 POLISH | 7 |
| M5 BLOCKER | 2 |
| EXPERIMENTAL | 1 |
| POST-LAUNCH | 1 |
| REMOVE / excluded | 1 |
