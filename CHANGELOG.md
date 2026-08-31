# Changelog

What changed in each Watchside release, written for the people using it.

Watchside is in a small private beta. Testers install it from the Chrome Web
Store, so a change is only in your hands once a new version has been published
there — the version in the account panel tells you which build you are running.

---

## 0.7.0 — Measuring whether any of this works

An unusual release: almost nothing about Watchside looks different. Your
friends, invites, badges, groups and Stream Rooms all behave exactly as before,
and there is nothing new to learn.

What changed is that Watchside can now tell whether it is doing its job.

### Watchside now records how long you watch

Until now Watchside recorded how long you watched **with a friend**. It now
also records how long you watched.

We are saying that plainly because it is a real change in what Watchside keeps.
The reason is simple: Watchside exists to bring people to streams together, and
we could not tell whether that worked. We could only see the part of your
viewing that happened to involve somebody else, which says nothing about how
much difference Watchside made.

For each stretch of viewing, Watchside records how long it lasted, which
channel, whether you got there by pressing JOIN, whether a friend was watching
with you at any point, and why it ended.

**If you have more than one stream open, each one is counted separately.** Two
streams open for an hour are two one-hour stretches, not one — that is how we
can tell how much Twitch viewing Watchside is part of. It is not a claim that
you sat there for two hours, and we do not describe it that way.

A stream still counts while its tab is in the background, on another monitor or
behind something else. Watchside also records how much of each stretch the
stream was the one in front of you, because "playing in the background" and
"the thing you were watching" are genuinely different.

**What is never recorded:** not the video, the title, the category or the
viewer count. Not other tabs — Watchside only ever looks at Twitch. Not
channels with no stream running. Not time Watchside could not observe: if your
computer sleeps, the stretch ends at the last moment we could actually see, and
the gap is never counted as viewing.

Only the stretches currently in progress are stored on your device, and each is
deleted the moment it ends. If you are not watching anything, there is nothing
about your viewing stored on your device at all.

The full explanation is in the [privacy
policy](https://anoteros-labs.github.io/watchside/privacy/).

### What Watchside still does not ask Twitch for

Nothing new. Signing in requests **exactly the same permissions as before** —
Watchside does not ask Twitch who you follow, who you subscribe to, or anything
about payments. You will not see a new permission screen because of this
release.

### On Firefox

Firefox continues to send **no** technical or interaction data at all — no
device information, no browser information, no crash or error reports. That is
unchanged, and this release adds no new kind of data collection to the Firefox
install prompt.

---

## 0.6.0 — Friends Beta

### Kickback is now Watchside

Same extension, same account, same friends — a new name and a new mark. There
is nothing to reinstall and nothing to sign back into: Chrome updates it in
place, and your friends, invites and badges come with it.

Invite links you have already shared keep working. New ones point at the
Watchside page, and the old address forwards there carrying your code, so a
link sitting in somebody's messages from last month still credits you.

Watchside is better with people in it. The rest of this release is about
getting them there.

### Finding people

- **People you may know** — friends of your friends, with how many friends you
  have in common. Add them without leaving the panel.
- Suggestions never name your mutual friends, only count them: who somebody
  else is friends with is their business, not something Watchside publishes.

### Inviting people

- **Invite a friend** — one link, yours, that keeps working. Copy it and send
  it however you like.
- Whoever joins through your link is credited to you automatically, once they
  sign in, become your friend, and actually start watching something.
- The panel tells you how many friends have joined through your link.

### Badges

- Bringing friends to Watchside earns permanent badges at 1, 5, 10, 15 and 25.
- Earned badges appear in your account panel, and you choose which one to show
  — or none at all.
- Watchside badges are Watchside's own. Nothing here is a Twitch badge, and
  nothing implies Twitch granted it.

### Social Gravity

- A destination with two or more friends now reads **"3 friends"** and carries
  an accent edge, so a gathering looks different from one person at a glance.
  A single friend is still a destination, still joinable, and still shows who
  is there.

---

## 0.5.0 — Multi-Destination Presence *(internal build, superseded by 0.6.0)*

> **Not on the Chrome Web Store.** This version exists only as a local
> unpacked build for owner smoke testing. The Store still carries **0.4.1**,
> and testers installed from the Store will not receive anything below until
> a build is actually published. The account panel reads `Watchside v0.5.0`,
> which is how you tell the two apart.

Presence stops being *the one channel you are on* and becomes *the streams you
have open*.

### Presence

- Watchside now publishes **every Twitch stream you have open**, not just the
  tab you happen to be looking at, up to **three at once**.
- Open a fourth stream and the longest-open destination drops out, so what
  friends see stays the three you most recently opened.
- Duplicate tabs on the same stream are one destination — opening a second tab
  on a stream you are already watching changes nothing.
- **Switching between your Twitch tabs publishes nothing.** Which tab you are
  looking at is yours; it never reaches the network, never reorders what
  friends see, and is not recorded anywhere.
- If your browser crashes or your laptop sleeps, every destination disappears
  with your presence rather than lingering.

### Social Gravity

- Friends now appear at **each** of the streams they have open, so a friend
  watching two things counts toward both gatherings.
- A friend in two places is one person in each — no fractional weighting, and
  nowhere to put one.

### Stream Rooms

- Each open stream now has **its own Stream Room**, resolved independently.
  Two streams means two rosters, and looking at one no longer discards the
  other.
- Messages and reactions are **isolated per channel** — one room's
  conversation cannot appear in another's.
- A room stays available while its conversation is still on screen, within the
  existing 30-minute retention window. This replaces the temporary
  availability rule shipped in 0.4.1 outright; there is no new lease and no
  new clock.

### Fixes

- Fixed the defect that made all of the above invisible: with several streams
  open, friends could only ever see one of them.

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
