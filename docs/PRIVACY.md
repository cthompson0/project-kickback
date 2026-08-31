# Watchside — Privacy Policy

**Last updated:** 25 August 2026

**Applies to:** Watchside browser extension, private beta (v0.4.x)

Watchside shows you which of your friends are watching Twitch, and lets you join
them. This policy describes exactly what it handles, where that goes, and what
it never touches. It describes the software as it is actually built, not as a
category of software generally behaves.

**Watchside does not sell your data, share it with third parties, or use it for
advertising of any kind.** There is no advertising in Watchside and no
advertising or analytics SDK in it.

---

## Who runs it

Watchside is an independent project, currently in a small private beta. Contact:
**anoteros.dev@gmail.com** — the same address for privacy questions,
support, and data deletion requests.

## Where your data goes

Two places, and nowhere else:

1. **Your own browser**, using Chrome's `storage` permission (`chrome.storage.local`).
2. **Watchside's backend**, hosted on Supabase (`*.supabase.co`).

Watchside also reads **public emote metadata** from 7TV (`7tv.io`) and displays
emote images from `cdn.7tv.app`, so that chat shows the emotes you already see
on Twitch. These requests carry **the channel name**, so that channel's emote set can be
looked up, and nothing else. **No information about you is sent to 7TV** — not
your identity, not who your friends are, not what you type.

## What Watchside handles

| What | Stored on your device | Sent to our backend | Visible to other users | Used for analytics | Retention |
| --- | --- | --- | --- | --- | --- |
| **Twitch identity** (your Twitch user id, login, display name, avatar URL) | session only | yes | your display name, avatar and Twitch username are visible to your friends and to people in your groups | no | until you ask us to delete your account |
| **Watchside account** (user id, friend code) | session only | yes | friend code only if you share it | no (ids are never event properties) | same |
| **Sign-in session** (Supabase access/refresh tokens) | **yes** | — | never | never | until sign-out or expiry |
| **Friendships, friend requests** | no | yes | to the people involved | counts only | until removed, or account deleted |
| **Groups and membership** | no | yes | to group members | counts only | until you leave, or the group is deleted |
| **Presence** (online, and the Twitch channel you are watching) | no | yes | to friends, and to people you share a group with — subject to your visibility setting | no channel identity beyond the destination of a JOIN | rows are transient and overwritten; nothing historical is kept |
| **Stream-session messages** (the ephemeral chat on a channel you are watching) | in memory while the panel is open | yes | to the people the server authorised at the moment you sent it | **never** — no message body, ever | **deleted after 30 minutes**, and capped in count |
| **Group messages** (the chat inside a group you created or joined) | in memory while the panel is open | yes | to the other members of that group | **never** — only a length bucket and whether it contained an emote | kept until the group is deleted or your account is deleted |
| **Reactions and emotes you send** | in memory | yes | to the same people | that a reaction happened, and how many — **never which emote** | about a minute; the server sweeps them |
| **Mute** | **yes, only on your device** | **never** | no | no | until you unmute |
| **Block** | no | yes | never — the other person is never told | that a block happened, with **no identifiers of either party** | until you unblock |
| **Panel position and size** | **yes** | never | no | no | until you reset the layout |
| **How long you had each live stream open** | the streams open right now, and nothing else | yes | never | yes — see "Viewing time" below | each stretch is deleted from your device when it ends; the recorded length is kept as analytics |
| **Analytics** | a session id | yes | never | — | see below |
| **JOIN attribution** | a random id, for minutes | yes | never | yes, that is its purpose | the id is dropped after the window closes |
| **Feedback you send** | no | yes | never | only the category | kept until it has been acted on |
| **Diagnostics attached to feedback** | no | yes | never | no | with the feedback |

### Two kinds of chat, with two different lifetimes

The **stream session** that appears when you and your friends are watching the
same thing is deliberately temporary: it is swept after thirty minutes and is
not a history you can scroll back through.

**Group chat is not.** A group is a place you made on purpose, so its messages
stay until the group is deleted or your account is. If you want a conversation
that disappears, use the stream session; if you want one that lasts, use a
group.

### Your visibility setting

The account panel lets you choose whether friends see your activity, see only
that you are online, or see nothing at all. **This is applied when your presence
is written, not when somebody reads it** — if you have chosen to hide your
activity, the channel is never stored, so there is nothing for anyone to read.

## Analytics, specifically

Watchside records how the product is used so we can tell whether it works. It is
built so that it *cannot* carry personal content:

- Every property is a small fact — a count, a bucket, a true/false, or a short
  word from a fixed list. **Values are capped at 64 characters and unknown keys
  are discarded by the server**, so there is no way to attach a message, a
  search term, a URL, an email address or a token even by mistake.
- **Never recorded:** message bodies — from either the stream session or from
  group chat — which emote you used, what you searched for, your friends'
  identities, who you blocked or muted, email addresses, friend codes, browsing
  history, or any Twitch or Supabase token.
- **Twitch channel names are recorded** for social events — a friend's activity
  being shown to you, a JOIN, a shared watch. This is how we can tell whether
  Watchside actually sends people anywhere. It is a channel, not a URL, and only
  for channels Watchside itself surfaced or you acted on. **Watchside does not
  record your browsing generally, on Twitch or anywhere else.**
- **Watchside records how long you watch a Twitch channel.** This is described
  in full under "Viewing time" below.
- **On Firefox, diagnostic events are not recorded at all.** See "Technical and
  interaction data" below.
- Events are labelled with the build they came from, so beta data can be
  deleted separately from anything else.

### Viewing time

**Watchside records how long you watch a live Twitch channel.** When you are
watching a channel, Watchside measures that stretch of time and records its
length, together with the channel name.

We are stating that plainly because it is a real change in what Watchside
keeps. Until now Watchside recorded how long you watched *with a friend*; it
now also records how long you watched.

**Why.** Watchside's purpose is to bring people to streams together. We cannot
tell whether that works without knowing whether it leads to people actually
watching — and whether they come back to a streamer they met through Watchside.
Without this, we can only measure the part of your viewing that happened to
involve a friend, which tells us nothing about how much difference Watchside
made.

**If you have more than one stream open, each one is counted separately.**
Two streams open for an hour are recorded as two one-hour stretches, not one.
That is how we can tell how much Twitch viewing Watchside is part of; it is not
a claim that you were sitting there for two hours, and we do not describe it
that way.

A stream still counts while its tab is in the background — on another monitor,
or behind something else. We also record how much of each stretch the stream
was the one you had in front of you, because "playing in the background" and
"the thing you were watching" are genuinely different and we would rather not
confuse them.

**What is recorded for each stretch of viewing:**

- how long it lasted
- how much of that time it was the stream in front of you
- which channel
- whether you got there by pressing JOIN in Watchside
- whether a friend was watching with you at any point during it
- why it ended — you closed or left the stream, the stream ended, you signed
  out, or Watchside stopped being able to observe

**What is not recorded:**

- **Not the video, the title, the category, the viewer count, or anything else
  about the stream.** The channel name and a duration are the whole of it.
- **Not what you watch generally.** Only channels on Twitch, and only while
  Watchside is running and you are signed in.
- **Not other tabs.** Watchside only ever looks at Twitch. A stream counts
  whether or not it is in front of you, but nothing else you have open is seen
  at all.
- **Not offline channels.** Sitting on a channel with no stream running records
  no viewing time.
- **Not time we did not observe.** If your computer sleeps or the browser stops
  Watchside in the background, the interval is closed at the last moment we
  could actually see, and the gap is never counted as viewing.

**What is stored on your device:** only the stretches of viewing currently in
progress — one per stream you have open — and each is deleted as soon as it
ends. If you are not watching anything, there is nothing about your viewing
stored on your device at all.

**This is not shared with anyone.** It is not visible to your friends, it is
never sold or shared with third parties, and it is not used for advertising.

## Feedback, specifically

If you send feedback from the account panel, we receive **what you wrote**, plus
a small set of diagnostics assembled by the extension: the Watchside version, the
build, which Watchside
tab was open, the Twitch channel you were on, how many friends you have, whether
a stream session existed, and whether the realtime connection was healthy. On
Chrome it also includes your browser name and major version (e.g. "Chrome 141");
**on Firefox that field is omitted**, because it is browser information and
Watchside collects none of that on Firefox.

That is the complete list, and it is enforced by the server, which rebuilds it
field by field and discards anything else. **Feedback never carries tokens,
cookies, message contents, what you were typing, or the identities of your
friends.** We can see who sent it, so that we can follow up.

## What Watchside never does

- **No advertising, ever**, and no use or transfer of your data for
  personalised, retargeted or interest-based advertising.
- **No selling or sharing** of personal data with third parties.
- **No reading of web pages.** Watchside runs on `twitch.tv` only, and only to
  place its own panel and read which channel the page is showing. It does not
  read Twitch chat, scrape the page, or touch any other site.
- **No credential handling.** Sign-in goes through Twitch's own OAuth page via
  Chrome's `identity` API. Watchside never sees your Twitch password, and the
  extension contains no client secret.
- **No Twitch access token in the page.** Provider tokens stay in the extension's
  background service worker and are never given to the content script — the part
  that runs alongside Twitch's own code.
- **No remote code.** Everything Watchside executes ships inside the extension
  package. Nothing is downloaded and run.
- **No use or transfer of your data to determine creditworthiness, or for
  lending purposes.**
- **No use or transfer of your data for any purpose unrelated to Watchside's
  single purpose** — showing you which friends are watching Twitch, and letting
  you join them.

## Permissions, and why

- **`identity`** — to sign you in with Twitch.
- **`storage`** — to keep your session, panel position and mute list on your
  device.
- **`alarms`** — to refresh your sign-in session periodically. A Chrome
  extension service worker is shut down when idle, so this is the only way to
  schedule that.
- **`notifications`** — for the optional desktop alert when several friends
  gather on one channel. You can turn it off in the account panel.
- **Watchside's own backend** — sign-in, presence, friends, groups and rooms.
  The Firefox add-on grants exactly one origin, our own Supabase project. The
  Chrome extension currently grants `https://*.supabase.co/*`; it reaches only
  the same single project, and will be narrowed to match at its next release.
- **`https://7tv.io/*`, `https://cdn.7tv.app/*`** — public emote metadata and
  images. The request carries the **channel name**, so that channel's emote set
  can be looked up, and nothing that identifies you: no account, no user id, no
  token, and no cookie of ours.

Watchside requests **no access to sites other than Twitch**, and cannot read any
other page you visit.

## What Firefox tells you at install

Firefox asks for consent to data collection in its own words, from what the
add-on declares in its manifest. Watchside declares four things, and they map to
the table above:

| Firefox says | What that is here |
| --- | --- |
| Authentication information | signing in with Twitch, and the Watchside account it creates |
| Browsing activity | the Twitch channel you are watching — the whole point of the product |
| Personal communications | stream-session messages, reactions, and feedback you write |
| Website activity | JOINs, and which surface you clicked one from |

Watchside does **not** declare *personally identifying information*: no email
address, phone number, postal address, demographics or biometrics is collected
anywhere. Your Twitch handle, display name and avatar are your own public Twitch
profile, and they are covered by *authentication information*.

### Technical and interaction data: Firefox collects none

Firefox has a fifth category, *technical and interaction data* — device and
browser information, and crash and error reports. Mozilla only allows it as an
**optional** permission, which would mean asking you a second question at
install.

**We would rather not collect it than ask.** On Firefox, Watchside sends no
error reports at all: three diagnostic signals that the Chrome extension does
record — a caught error, a realtime connection changing state, and a group
message being refused — are dropped inside the extension and never reach our
server. They are not queued, not retried, and not sent later.

So there is **no consent prompt and no analytics switch** in Watchside for
Firefox, because there is nothing to consent to or switch off. Everything else
on this page still applies: the data listed above is what the add-on needs to do
what it does, and Firefox asks you about it once, at install.

Watchside collects no device information on any browser, and no browser
information on Firefox.

On **Chrome**, those three diagnostic signals are still recorded. They carry a
call site and an error code from fixed lists — never a message, a URL, an
exception text or a stack trace — exactly as the analytics section describes.

## Your choices

- **Hide your activity or go invisible** — account panel, at any time.
- **Mute somebody** — local to your device; nothing is sent.
- **Block somebody** — removes the friendship, stops all Watchside contact
  between you, and is never disclosed to them.
- **Sign out** — clears the session from your device.
- **Delete your account** — email **anoteros.dev@gmail.com**. Deleting your
  account removes your profile, friendships, requests, group memberships,
  presence, blocks and feedback. Analytics events are not tied to your name and
  are removed with your actor record.
- **Uninstall** — removes everything Watchside stored on your device. Data on the
  backend is removed on request as above.

## Children

Watchside is not directed at children and follows Twitch's own minimum age
requirements. Do not use Watchside if you are not permitted to use Twitch.

## Changes

This is a private beta and the product is changing. Material changes to this
policy will be reflected here, with the date at the top updated, and told to
beta testers directly.

---

*Watchside is not affiliated with, endorsed by, or sponsored by Twitch
Interactive, Inc. or 7TV. "Twitch" is a trademark of Twitch Interactive, Inc.*
