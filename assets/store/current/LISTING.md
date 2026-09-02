# Store listing copy — paste-ready

The recorded copy in `docs/checkpoints/chrome-web-store-private-beta-readiness.md`
is the **Kickback-era** text: it names the old product throughout and predates
suggested friends, the invite link and the support page. The listing *name* was
updated to "Watchside BETA"; the body copy is stale.

This is the replacement. Same positioning, current brand, current product.

Permission justifications and privacy declarations are **not** here — they live
in `docs/reports/chrome-v0.8.0-submission-handoff-2026-09-02.md` §2–§3, so there
is one source of truth for them rather than two that drift.

---

## Item name

```
Watchside BETA
```

Unchanged. 14 characters, well under the 75 limit.

## Short description

132-character limit. This is 107.

```
See where your Twitch friends are watching and jump into the stream with them. A small panel beside Twitch.
```

Every clause is the product: where friends are, jumping in, and the fact that it
is a panel rather than a replacement for Twitch. No adjectives that cannot be
checked.

## Detailed description

```
Watchside shows you which of your friends are watching Twitch right now, what
they're watching, and lets you join them in one click.

It adds a small panel beside Twitch — drag it where you like, or minimise it to
a button. Nothing else about Twitch changes.

WHAT IT DOES

• See which friends are online and which channels they're on.
• When several friends end up on the same stream, Watchside groups them, so you
  can see where everyone is rather than reading a list.
• JOIN takes you straight there.
• Friends already on the stream you're watching show up as HERE.
• Once you're watching the same thing, a small session appears beside your
  friends list with quick emote reactions and a short-lived chat.
• Groups, for the people you watch with regularly.
• Mute anyone locally, or block them outright.

GETTING STARTED

Watchside is worth more with a few friends on it, so it helps you find them:
suggestions come from people your friends already know, shown as a number of
mutual friends and never as a list of names. There's also one durable invite
link you can send to anybody.

HOW IT WORKS

Sign in with Twitch. Watchside never sees your password — sign-in goes through
Twitch's own page — and the extension contains no secret keys.

Watchside runs on twitch.tv and nowhere else. It cannot see any other site you
visit, and does not ask for permission to.

Add friends by Twitch username or by sharing a Watchside friend code. You only
see people who have added you back.

IF SOMETHING GOES WRONG

There's a Feedback button in the account panel, and a support page that works
even when the panel doesn't:
https://anoteros-labs.github.io/watchside/support/

BETA

This is an early build being tested by a small group. Things will change, and
the Feedback button is the fastest way to tell us something is wrong.

Watchside is not affiliated with or endorsed by Twitch Interactive, Inc.
```

**What changed from the Kickback text, and why**

- The name, throughout.
- **GETTING STARTED is new.** The single most common first experience is an
  empty panel, and the old copy never said what to do about it. Suggested
  friends and the invite link are the answer and were invisible in the listing.
- **IF SOMETHING GOES WRONG is new**, pointing at the support page that now
  exists and works when the extension does not.
- The grouping bullet now says *why* it groups — "so you can see where everyone
  is rather than reading a list" — because that is the actual product idea, and
  the old wording described the mechanism without the point of it.

**What deliberately did not change**

- No mention of measurement, campaigns, follows or anything analytics-shaped.
  None of it is a user-facing feature and describing it here would be marketing
  a thing nobody installs for. It belongs in the privacy policy, where it is.
- No user counts, ratings, testimonials or creator names. There are none to
  report and inventing them is the one thing a store listing must never do.
- The Twitch non-affiliation line stays last, verbatim.

## Single purpose statement

```
Watchside's single purpose is to show a Twitch viewer which of their Watchside
friends are currently watching Twitch and what they are watching, and to let
them navigate to the same channel. Every feature — the friends list, the
grouping of friends by channel, the JOIN button, presence, groups, friend
suggestions, invite links, and the short-lived session chat that appears when
friends watch the same stream — exists to support that one purpose. Watchside
runs only on twitch.tv.
```

Unchanged in substance; renamed, and the two surfaces added since (suggestions
and invites) are named so the enumeration stays complete. An incomplete
single-purpose list is worse than a long one, because a reviewer who finds a
feature it does not cover has found an inconsistency.

## URLs

| Field | Value |
| --- | --- |
| Support URL | `https://anoteros-labs.github.io/watchside/support/` |
| Privacy policy | `https://anoteros-labs.github.io/watchside/privacy/` |
| Homepage | leave blank until `watchside.app` serves HTTPS |

**Not `watchside.app` yet.** The domain has no certificate, and `.app` is
HSTS-preloaded, so a browser refuses plain HTTP — a homepage URL pointing there
today is a dead link in a public listing. The two live Pages URLs above are what
the extension itself links to and are the correct answers until TLS lands.
