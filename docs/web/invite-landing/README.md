# Invite landing page — implementation package

**Status: NOT DEPLOYED.** This is a complete, ready-to-copy implementation for
the Anoteros Labs GitHub Pages repository, which is **not present in this
workspace**. Nothing here is live.

The extension and backend halves of the invite flow are complete and shipped.
**The only thing preventing invite links from working end to end is that this
page has not been published.**

---

## What to do

Copy `index.html` from this directory into the Pages repository so it is served
at:

```
https://anoteroslabs.github.io/kickback/invite
```

Either path works:

- `kickback/invite/index.html` — preferred, gives the clean URL above;
- `kickback/invite.html` — also fine; GitHub Pages serves it at
  `…/kickback/invite.html`, in which case update `INVITE_LANDING_BASE` in
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
Kickback privacy page sits one level up. Adjust if the Pages layout differs.

---

## The contract this page implements

| Hop | URL | Who reads it |
| --- | --- | --- |
| 1 | `https://anoteroslabs.github.io/kickback/invite?c=CODE` | **this page** |
| 2 | `https://www.twitch.tv/?kickback_invite=CODE` | Kickback's existing content script |

**Why two hops.** A content script on the landing page would require a new host
permission — Chrome presents that to the user as *"read your data on that
site"* — for the sake of one string. Sending people onward to Twitch instead
means the code is read where Kickback already runs. No new permission, no
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
| Valid code | Headline becomes **"A friend invited you to Kickback"**; Continue points at Twitch carrying the code. |
| Missing or malformed code | **Not an error page.** Generic Kickback copy; Continue points at plain Twitch. They arrive unattributed, which costs them nothing. |
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
        ↓  Install Kickback
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

1. Open `https://anoteroslabs.github.io/kickback/invite?c=<a real code>` — the
   headline should read **"A friend invited you to Kickback"**.
2. Press **Continue with Twitch** — the URL should become
   `https://www.twitch.tv/?kickback_invite=<code>`.
3. With Kickback installed and signed in on that browser, the code is claimed
   silently. Nothing visible happens, which is correct.
4. Open the same URL with `?c=nonsense` — generic copy, no error, Continue goes
   to plain Twitch.
