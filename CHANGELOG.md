# Changelog

What changed in each Kickback release, written for the people using it.

Kickback is in a small private beta. Testers install it from the Chrome Web
Store, so a change is only in your hands once a new version has been published
there — the version in the account panel tells you which build you are running.

---

## 0.4.1 — Friends Beta Patch 1

The first round of fixes from real beta use. Ten things came out of that
session; these are the ones that were ready.

### Chat

- Your own messages consistently display as **"You"** in Group Chat and Stream
  Rooms.
- Stable per-user username colors improve conversation readability.
- Chat follows new messages when you're already at the bottom.
- Scrolling up no longer forces you back to the newest message.
- A **"New messages ↓"** affordance lets you return to the bottom.
- Late-loading emotes and images should no longer disrupt normal bottom-follow
  behavior.

### Stream Rooms

- Recent Stream Room conversations no longer immediately disappear when another
  viewer leaves.
- Recent messages keep the room surface available during the existing 30-minute
  retention window.

> **Internal note, not a user-facing feature.**
> This is deliberately temporary lifecycle behavior.
> It keeps a readable conversation on screen for as long as
> its messages already live, and nothing longer — no new lease, no new clock.
> It is superseded by the multi-destination room lifecycle, which replaces the
> availability rule outright rather than extending it. Nothing here should be
> read as the finished design. See
> `docs/reports/multi-stream-room-architecture-2026-08-27.md`.

### Twitch tabs

- Kickback panel collapse/expand and layout state synchronize across Twitch
  tabs.

### Reliability

- Improved realtime subscription lifecycle handling.
- Added privacy-constrained diagnostics for client failures, realtime status
  changes, and failed group-message sends.
- **No message bodies, channel names, URLs, emails, or free-form exception text
  are included in this diagnostic telemetry.** Every value comes from a fixed
  vocabulary, and anything unrecognised is recorded as `unknown`.

### Settings

- The account panel now shows the version you are running, so "which build is
  this?" has an answer you can read off the screen.

### Testing

- Complete test collection restored.
- 68 test files / 1796 tests passing at the Patch 1 checkpoint.

---

## 0.4.0 — Initial Friends Beta

The first build handed to testers: presence, Social Gravity, JOIN, Stream
Rooms, groups and group chat, blocking, and in-product feedback.
