# Invite landing page — implementation package

**Status: LIVE** at `https://anoteros-labs.github.io/watchside/invite/`, which is
the base `INVITE_LANDING_BASE` generates. The invite flow works end to end.

This file is the source of record for the published page, and it is checked in
because the Pages repository — `Anoteros-Labs/anoteros-labs.github.io` — is not
this repository and is not present in this workspace.

**This header said NOT DEPLOYED for a long time after it was.** M5B believed it
and reported the route as unpublished; the network says 200, and the published
page's inline script is byte-identical to the one below. The lesson is in the
next paragraph.

**The published copy is a rename behind.** It is still painted in the old
Kickback identity — `#ff8a00`, `#6366f1`, `#0f172a` — while this file carries the
current Watchside purple. Behaviour is identical; only the paint differs.
Republishing this file fixes that. It is cosmetic and not urgent.

`tests/extension/pagesArtifact.test.ts` holds the referral contract, and
`brandAssets.test.ts` keeps this file on the current identity.

---

## What to do

Copy `index.html` from this directory into the Pages repository so it is served
at:

```
https://anoteros-labs.github.io/watchside/invite
```

Either path works:

- `watchside/invite/index.html` — preferred, gives the clean URL above;
- `watchside/invite.html` — also fine; GitHub Pages serves it at
  `…/watchside/invite.html`, in which case update `INVITE_LANDING_BASE` in
  `src/core/invites.ts` to match. **Do not guess — the two must agree.**

The page is self-contained: one file, no build step, no dependencies, no
external fonts, no analytics.

### One value to check before publishing

`STORE_URL` in the inline script currently points at

```
https://chromewebstore.google.com/detail/ngfopkeokddfnncdhfkhnffilbdhkkip
```

That is built from the permanent extension ID and is correct in form. If the
live listing URL includes a slug (`…/detail/kickback-beta/ngfop…`), use the real
one from the Developer Dashboard.

The privacy link is relative (`../privacy.html`) and assumes the existing
Watchside privacy page sits one level up. Adjust if the Pages layout differs.

---

## The contract this page implements

| Hop | URL | Who reads it |
| --- | --- | --- |
| 1 | `https://anoteros-labs.github.io/watchside/invite?c=CODE` | **this page** |
| 2 | `https://www.twitch.tv/?kickback_invite=CODE` | Watchside's existing content script |

**Why two hops.** A content script on the landing page would require a new host
permission — Chrome presents that to the user as *"read your data on that
site"* — for the sake of one string. Sending people onward to Twitch instead
means the code is read where Watchside already runs. No new permission, no
clipboard instructions, and the recipient lands somewhere sensible at each step.

`src/core/invites.ts` is the single source of truth for both parameter names,
the alphabet and the length. `codeFromUrl` accepts `c` and `kickback_invite`, so
one function answers for both hops.

### Code format

22 characters from `0123456789ABCDEFGHJKMNPQRSTVWXYZ` — the same alphabet
friend codes use, with `I`, `L`, `O` and `U` omitted so a code read aloud cannot
become a different valid code. Regex:

```
/^[0-9ABCDEFGHJKMNPQRSTVWXYZ]{22}$/
```

---

## Behaviour

| Case | Behaviour |
| --- | --- |
| Valid code | Headline becomes **"A friend invited you to Watchside"**; Continue points at Twitch carrying the code. |
| Missing or malformed code | **Not an error page.** Generic Watchside copy; Continue points at plain Twitch. They arrive unattributed, which costs them nothing. |
| Already installed | Not detectable without a new permission, so the page does not try. The flow is identical either way: pressing Continue lands on Twitch and the content script picks the code up. |
| Narrow screen | Single column, reduced padding under 420px. The card becomes the page. |
| No JavaScript | The static copy and both buttons still render; Continue goes to plain Twitch. The invite is simply not attributed. |

### Privacy

- Nothing is stored — no cookies, no `localStorage`, no `sessionStorage`.
- Nothing is sent anywhere. No analytics, no pixels, no third-party requests.
- `<meta name="referrer" content="no-referrer">`, so the code never travels in a
  `Referer` header to Twitch or the Store.
- The code is not a credential. Possession lets a signed-in account say who
  invited them and nothing else — no friendship, no visibility, no way around a
  block. See `supabase/migrations/0026_growth_loop.sql`.
- **The inviter is not named.** Doing so would need a public lookup from code to
  identity, which is a new unauthenticated surface exposing who invited whom.
  The brief permits showing the inviter only if it were already safely
  available; it is not, and creating it would weaken the model for a line of
  copy.

---

## How attribution survives the whole journey

```
inviter presses Copy invite link          my_invite_code()  → durable code
        ↓  shares the link
recipient opens the landing page          this page, ?c=CODE
        ↓  Install Watchside
recipient installs from the Store         no code involved
        ↓  Continue with Twitch
recipient lands on twitch.tv/?kickback_invite=CODE
        ↓  content script reads it        core/invites.ts codeFromUrl()
worker holds it, unclaimed                session memory only
        ↓  recipient signs in with Twitch
worker claims it                          claim_invite(code) → 'attributed'
        ↓  they become friends
        ↓  they open any stream           apply_destinations() stamps activation
referral succeeds                         settle_referral() → badge
```

The code is held **in worker memory only** — never persisted. An unclaimed code
is worth nothing, and storing somebody else's identifier for no benefit would be
the wrong trade. The cost is that a browser restart between landing and sign-in
loses it; the recipient can re-open the link, and the ordering above is the
common one anyway because sign-in happens on Twitch, right where the code was
picked up.

---

## Verifying it once published

1. Open `https://anoteros-labs.github.io/watchside/invite?c=<a real code>` — the
   headline should read **"A friend invited you to Watchside"**.
2. Press **Continue with Twitch** — the URL should become
   `https://www.twitch.tv/?kickback_invite=<code>`.
3. With Watchside installed and signed in on that browser, the code is claimed
   silently. Nothing visible happens, which is correct.
4. Open the same URL with `?c=nonsense` — generic copy, no error, Continue goes
   to plain Twitch.
