# M5B — Public surface + product comprehension

**Date:** 2026-09-01
**Branch:** main
**Schema:** 37 (unchanged by M5B)
**Preceded by:** M5A — growth + zero-friend product loop

---

## 1. Executive verdict

**★ GO, repository-level.**

Watchside now has a public surface: a root page, a privacy page generated from
the policy, a support page that works when the extension does not, and a
canonical invite route `/i/<code>` that functions on a static host. Inside the
product, four things that were true but unsaid are now said — what badges exist
beyond the ones you have, where the other half of a notification permission
lives, what a Group is as distinct from the tab that appears while you watch,
and where to get help when the panel will not open.

Two distinctions matter more than any of it.

**PREPARED is not LIVE.** `watchside.app` does not resolve. Nothing in this
milestone asserts that it does, no code points at it, and the tests are written
so they cannot accidentally start claiming it. What is finished is the tree that
will be served, and the exact external steps to serve it.

**The referral identity did not change.** `/i/<code>` and `?c=<code>` are two
carriers of one thing, and both end where they always did. A URL migration that
quietly became a referral redefinition would have been the expensive failure
available here, and §12–§13 are the proof it did not happen.

Three defects were found and fixed during the milestone, all by gates rather
than by reading:

- a shipped build links to a Support page at a URL nothing serves (§17, §34) —
  the fix needs no domain and can be published today;
- **the badge catalogue would have thrown on first use in production**: the
  worker called a function it never imported (§29);
- the Test Lab client did not implement the new method, which crashed the whole
  panel there and produced sixteen unrelated-looking failures (§29).

The second is the one that matters, and §29 explains why it survived a passing
typecheck.

---

## 2. Starting state

M5A closed with the cold-start loop repaired: suggestions explain themselves
when empty, the friends-idle state says the map is quiet rather than nagging,
and the suggestion impression is recorded where the surface is drawn rather than
where the data is fetched.

What M4.5 had flagged and M5A did not touch:

| Gap | Left by |
| --- | --- |
| No public site; the domain is registered and unused | M4.5 §12 |
| Invite links point at a GitHub Pages URL | M4.5 §12 |
| No support route for somebody who cannot open the panel | M4.5 §7 |
| Badge shelf shows only earned badges — the ladder is invisible | M4.5 §9 |
| Notification denial has no in-product explanation | M4.5 §8 |
| Groups and the stream tab are never distinguished | M4.5 §10 |

Six gaps. All six are addressed here; one of them (the public site) is addressed
as far as a repository can address it.

---

## 3. Public-surface audit

Everything Watchside currently exposes to somebody who is not running it:

| Surface | State before M5B | State after |
| --- | --- | --- |
| Chrome Web Store listing | live, 0.6.0 | unchanged |
| AMO listing | not published | unchanged |
| `anoteros-labs.github.io/watchside/privacy/` | live | unchanged |
| `anoteros-labs.github.io/watchside/invite/` | **not published** | unchanged; still the extension's link base |
| `anoteros-labs.github.io/watchside/support/` | **not published** | **built, ready to publish, no DNS needed** |
| `watchside.app` | registered, nothing served | **built, PREPARED** |
| support email | `anoteros.dev@gmail.com` | unchanged, now published on a page |

The honest summary of the "before" column: the only public thing Watchside had
that a person could read was a privacy policy. Every other route either did not
exist or was documented as ready-to-copy and never copied.

---

## 4. URL inventory / classification

| URL | Class | Who reads it | Must keep working |
| --- | --- | --- | --- |
| `watchside.app/` | canonical, PREPARED | people | — |
| `watchside.app/privacy` | canonical, PREPARED | people, store reviewers | — |
| `watchside.app/support` | canonical, PREPARED | people | — |
| `watchside.app/i/<code>` | canonical, PREPARED | people, then the extension | — |
| `…github.io/watchside/invite/?c=<code>` | **live contract** | shipped 0.6.0 + 0.7.0 clients | **yes** |
| `…github.io/watchside/privacy/` | **live contract** | store listings, shipped clients | **yes** |
| `…github.io/watchside/support/` | **live contract** | shipped 0.7.0 clients | **yes — and not yet served** |
| `…github.io/kickback/…` | legacy | old links, old listings | **yes** |
| `twitch.tv/?kickback_invite=<code>` | internal hop | the content script | **yes** |

The three rows marked "live contract" are the ones a released build already
depends on. Nothing in M5B changes any of them.

---

## 5. watchside.app architecture

Static, on GitHub Pages, no server and no build infrastructure beyond a script.

```
docs/web/watchside-app/
  shell.html            head, styles, footer — one place for a page's chrome
  pages/index.html      root
  pages/support.html    support
  pages/404.html        404 AND the invite landing
scripts/build-site.mjs  -> dist-site/  (gitignored)
```

**The invite route is the 404 page, deliberately.** A static host has no router.
GitHub Pages answers any unmatched path with `404.html`, so that file reads the
code out of `location.pathname` itself. This is the entire mechanism that lets
`/i/<code>` exist without a backend. It is also why the page has to be careful
about which of its two jobs it is doing: anything that is not a valid code stays
a plain 404, which is the correct answer for a mistyped URL and a harmless one
for a truncated invite.

`/i/index.html` is the same page written a second time, so the bare route
resolves rather than falling through to a 404 that then has nothing to read.

**Why a build rather than checked-in HTML.** The privacy page was already
generated from `docs/PRIVACY.md` — that is what stops the policy and the
published page from drifting. Once one page is generated the others may as well
share a shell, so a footer or a meta tag is changed in one place.

**A second target.** `npm run build:site:pages` emits `dist-pages/` with every
root-absolute link rewritten to `/watchside/`, for the Pages subpath that is
live today. It deliberately omits `CNAME`, `404.html` and `/i/` — see §14.

---

## 6. DNS status

**NOT CONFIGURED. NOT LIVE.**

`watchside.app` is registered and does not resolve to any Pages host. No DNS
record has been created, and none can be created from this repository.

The records required are written out exactly in
`docs/web/watchside-app/README.md` §2 — four `A` records, four `AAAA` records,
and a `CNAME` for `www`. They are GitHub's published Pages addresses, and the
README says to check them against GitHub's current documentation before entering
them, because those addresses have changed before and a stale `A` record is a
site that does not resolve.

No part of this report, the code, or the tests claims DNS is configured.

---

## 7. Domain ownership verification status

**NOT VERIFIED. Optional.**

GitHub can verify domain ownership so that no other repository can claim the
domain. It is done in organisation settings, and it issues a `TXT` record whose
value **GitHub generates**.

That value is not in this repository and could not be. Inventing one would
produce a record that fails verification while looking like progress, so the
README names the screen it comes from and stops there.

Verification is not required for the site to work, and can be done before or
after the `CNAME`.

---

## 8. HTTPS status

**NOT ACTIVE.**

GitHub Pages provisions a certificate itself once DNS resolves; nothing is
bought, and no configuration exists in this repository. The **Enforce HTTPS**
checkbox stays disabled until that certificate exists, which can take up to an
hour after propagation.

The domain is not live until all four checks in README §5 answer. Until then,
`watchside.app` is a prepared tree and a registered name.

---

## 9. Root-page implementation

`watchside.app/` answers the question a person arriving from a store listing or
an invite actually has: what is this, and what happens if I install it.

It says what Watchside does in one sentence, then how it works in three steps
(add friends → they appear when they start watching → press JOIN and you are on
that stream), then that it sits beside Twitch and does not replace Twitch chat
or change how you watch. Then the install path, then a short data section that
links to the policy rather than paraphrasing it.

No screenshots (none exist that would not be staged), no testimonials, no
metrics, no waitlist, no email capture. The footer carries the Twitch
non-affiliation line the store listing already carries.

---

## 10. Chrome install path

One button, pointing at the real listing:

```
https://chromewebstore.google.com/detail/ngfopkeokddfnncdhfkhnffilbdhkkip
```

Built from the permanent extension ID, which is the form that survives a listing
slug change. The same URL appears on the invite landing page, so a person
arriving by invite and a person arriving at the root take the same path.

Chrome is described as **a small private beta**, because that is what it is.

---

## 11. Firefox availability handling

**Firefox is not presented as available.** The copy is:

> A Firefox version is built and working, and is waiting on Mozilla's review
> before it can be listed — there is nothing to install there yet.

Three claims, each true: it exists, it is not listed, there is nothing to
install. No AMO link, no "coming soon" button that goes nowhere, no email
capture against a future release.

`publicRouting.test.ts` asserts both halves — that no `addons.mozilla.org` link
appears anywhere in the built site, and that the availability sentence does not
present Firefox as installable. When AMO publishes, the test is what tells you
which copy has to change.

---

## 12. Canonical referral route

`watchside.app/i/<code>` → `twitch.tv/?kickback_invite=<code>`.

The second hop is the one that already existed. The content script has always
read `kickback_invite` from a Twitch URL, and that is untouched, so the new route
adds a carrier and changes no destination.

**Why the hop through Twitch at all.** A content script on the landing page would
need a host permission, which the browser presents to the user as "read your
data on that site" — for one string. Sending people onward to Twitch means the
code is read where Watchside already runs, and no new permission is requested.

What the page does with a code:

| Input | Behaviour |
| --- | --- |
| valid code in the path | invite copy, Continue carries the code to Twitch |
| valid code lowercased | uppercased, then as above |
| valid code with trailing slash | as above |
| valid code in `?c=` | as above |
| both present | **the path wins**, rather than guessing |
| malformed, empty, undecodable | plain 404; nothing is claimed |

The alphabet is unchanged: 22 characters from `0123456789ABCDEFGHJKMNPQRSTVWXYZ`,
with `I`, `L`, `O` and `U` omitted so a code read aloud cannot become a different
valid code.

---

## 13. Referral compatibility

**Every existing referral link keeps working, and existing codes stay valid.**

Codes are not re-issued, re-encoded or namespaced. `my_invite_code()` returns
what it always returned. The database is untouched by M5B.

Two changes were needed to make the canonical shape survive a round trip:

1. **The landing page reads both shapes.** `?c=` is what every link shared before
   today carries, and those links live in messages and browser histories that
   nobody can edit.

2. **`normalizeInviteCode()` learned to read a path.** A person who pastes a
   whole `watchside.app/i/<code>` link into the code box would otherwise have
   found the canonical link was the one shape the product could not read back.
   `codeFromPath()` is deliberately **not** folded into `codeFromUrl()`: that
   function runs on twitch.tv against whatever path the viewer is on, and a
   channel name is a path segment too. Matching one against the code alphabet is
   vanishingly unlikely, but it is not a risk worth taking for no gain.

`publicRouting.test.ts` proves both shapes produce the **same** destination —
not merely that each produces a valid one.

---

## 14. Legacy Pages compatibility

**Untouched, and deliberately so.**

`INVITE_LANDING_BASE` still generates `…github.io/watchside/invite/?c=<code>`.
Switching it before the domain resolves would mean every invite copied in the
meantime pointed at nothing — the failure would land on the recipient, who has
no way to understand it. M5E flips the constant once README §5 passes.

`publicRouting.test.ts` pins which base is active, so the switch cannot happen as
a side effect of an unrelated edit.

The subpath build (`dist-pages/`) exists so the org Pages site can serve Support
without waiting for a domain, and it is constrained in three ways that are each
asserted:

- **no `CNAME`** — one there would rebind the entire org site to
  `watchside.app`, taking `/kickback/` with it;
- **no `404.html`** — that would put a Watchside 404 on an org-wide site;
- **no `/i/`** — the route reads its own path and cannot work from a subpath,
  because Pages serves the 404 from the domain root.

A first attempt at the CNAME guard silently failed to apply, and the tree was
built carrying a `CNAME` that would have rebound the org domain on publish. The
test written alongside it caught that before anything was published. It is worth
saying plainly, because the guard "obviously" worked when read.

---

## 15. Legacy Kickback compatibility

`…github.io/kickback/…` paths are not touched, moved or redirected. The
recommended hosting choice in README §1 — a separate repository for
`watchside.app` rather than a `CNAME` on the org site — is chosen partly for
this: it leaves every legacy path exactly where it is, with no redirect hop and
no possibility of a loop.

The `kickback_invite` parameter name is likewise unchanged. It is a wire
identifier read by shipped clients, and renaming it would break attribution for
every installed build to save a word nobody sees. M4.5 recorded the same
reasoning for the storage keys and the `kickback` badge issuer.

The one place "Kickback" was still shown to a person — badge descriptions, which
live in the database rather than the source, which is why M4.5 missed them —
was corrected in migration 0037.

---

## 16. M5C routing seam

M5C wants acquisition and campaign attribution. Those are **different questions**
from friend referral:

| | Question | State |
| --- | --- | --- |
| acquisition | how did this install arrive | not built |
| friend referral | which Watchside user invited them | **built, durable, in production** |
| creator / campaign | which creator or campaign drove it | not built |

The seam M5B leaves is a negative one, and that is the useful kind: `404.html`
reads the code and **nothing else**. It does not consume, rewrite, forward or
store any other query parameter. The whole query string is therefore free for
M5C to define without touching the referral path or redoing this routing.

**These must not be folded into one `referrer` field.** They answer different
questions, they have different retention consequences, and one of them already
carries production data.

---

## 17. Support page

`watchside.app/support` — and, today, `…github.io/watchside/support/`.

Its first line states its own purpose: it works whether or not Watchside is
running, which is the point of it. Everything on it is a thing a person can do
without the panel:

- **the panel does not appear** — only runs on twitch.tv; reload a tab opened
  before install; check the extension is enabled; the minimised mark is top-left;
- **sign-in is not working** — it opens a separate window, pop-up blockers
  suppress it, closing it early saves nothing, server errors are usually
  temporary;
- **looks out of date** — where the version is shown, and that browsers update
  extensions on their own schedule;
- **notifications not arriving** — the permission belongs to the browser, a
  refusal cannot be re-asked from inside Watchside, and both switches must be on;
- **privacy and deleting your account** — where the control is, that it asks you
  to type your Twitch username because it cannot be undone, and that
  disconnecting, signing out and deleting are three different things;
- **get in touch** — the email, and a note that the in-product Feedback form is
  faster when it is available because it attaches context for you.

**The defect found here.** The account panel links to
`…github.io/watchside/support/`, and nothing is served at that path. A shipped
build would offer a Support link that 404s — worse than no link, because it is
offered exactly when something is already wrong.

The fix needs no domain: `npm run build:site:pages` produces the tree, and
copying `dist-pages/support/` into the existing Pages repository makes the link
work as soon as Pages rebuilds. It is owner action 1 in §34, ahead of anything
about DNS.

---

## 18. Support discoverability

A `Support` link sits in the account panel beside `Feedback`, as an external
link rather than another panel view — because the page's whole value is that it
survives the panel being broken.

Feedback stays the primary route while Watchside is working: it attaches the
version and diagnostic context automatically, which makes it strictly better for
anybody who can reach it. The support page says so.

A second, narrower entry point sits under the notifications toggle — "Your
browser has to allow them too. **If none arrive**" — which lands on the same
page. Somebody whose notifications are silent is unlikely to think of a general
support page, so the link is offered where the confusion is.

---

## 19. Privacy page

Generated from `docs/PRIVACY.md` by the same script the currently published page
already uses, so the policy and the page cannot say different things. The
generator refuses markdown constructs it does not recognise, and the caller
compares every word of the policy against every word of the page.

The policy itself is unchanged by M5B. Nothing in this milestone collects,
stores or transmits anything new — see §25.

Both build targets emit it, rebased correctly for their root.

---

## 20. Badge progression

The shelf now shows what exists, not only what has been earned.

`badgeCatalog()` reads `badge_definitions`, which has been readable by any
signed-in account since 0026 — knowing a badge *exists* reveals nothing about
anybody. That is what makes this possible without a second source of truth and
without shipping the ladder in the client, where it would drift from the
database that awards it.

Locked milestones render **dimmed, and not as buttons**. There is nothing to
press, and a disabled button invites the press anyway. "Locked" is carried by the
word *not earned yet* in the tooltip and by the *Still to earn* heading — never
by colour alone.

**What was deliberately not built:** no progress bar, no counter, no "2 more to
go", no streak, no comparison to other people, no notification when somebody
gets close. The ladder is visible; turning it into a target is how a badge shelf
becomes pressure to spam invitations at people who did not ask.

An account with nothing earned and nothing to earn still renders no badge
section at all.

---

## 21. Notification-permission UX

The audit expected a permission-denied recovery flow. Reading the manifest, that
flow cannot exist.

`notifications` is a **manifest** permission, granted at install. There is no
runtime prompt, so there is no denial for Watchside to detect and nothing to
re-request. What can still stop a notification is the browser's own settings or
the operating system's — neither of which the extension can see or change.

So the honest fix is not a recovery flow but a correction of what the toggle
implies. Under it, when it is on:

> Your browser has to allow them too. **If none arrive** →

Two facts and a route. The toggle is Watchside's preference; delivery is the
browser's decision; the support page explains where the other half lives.

**No nagging.** Nothing re-prompts, nothing re-checks on an interval, nothing
appears when the toggle is off. The line is present only where somebody has
already said they want notifications, which is the only state where its absence
would be confusing.

Chrome and Firefox behave identically here, because the permission model is the
same one in both.

---

## 22. Rooms vs Groups comprehension

Two surfaces where people talk, and nothing said which was which. A new user
could reasonably conclude a group must be created before joining anybody —
exactly backwards from how watching together works.

The Groups empty state now draws the line in one sentence:

> It stays put. The tab that appears while you're watching alongside someone is
> different — that one comes and goes with the stream, and you never make it.

Three distinctions in one sentence: **persistence** (stays put vs comes and
goes), **origin** (you make one, the other appears), and **lifetime** (yours vs
the stream's). It is placed in the empty state because that is where somebody is
deciding whether they need a group at all.

No new setting, no tour, no tooltip, and no renaming of either concept —
renaming would break the shipped clients' vocabulary to solve a sentence-shaped
problem.

---

## 23. Accessibility

**The site.** Semantic headings in order; `lang="en"`; a `role="img"` and label
on the mark; visible `:focus-visible` outlines on every link; a single-column
layout at 640px with reduced padding; body text at 16px/1.65; no text baked into
images; the whole site works with JavaScript disabled except the invite
personalisation, which degrades to a plain page and a Twitch link.

**The extension.** Locked badges are `<span>`s, not disabled buttons, so nothing
focusable exists that cannot be acted on; the icon is `aria-hidden` with the name
adjacent as text; the locked state is in the tooltip text, not conveyed by colour
alone. The Support link is an `<a>` with `rel="noreferrer noopener"` and reads as
a link to assistive technology rather than as a button that navigates away.

**Not done:** no contrast audit against WCAG ratios has been run, and no screen
reader has been tested with. The dimmed locked-badge colour is the most likely
failure. Recorded as M5 polish rather than claimed.

---

## 24. Security review

**Open redirect: not possible.** The only destination the invite page can build
is a literal `https://www.twitch.tv/?kickback_invite=` with an
`encodeURIComponent`'d code appended. No destination is read from the URL, no
`location.assign` runs, and the code is validated against the 22-character
alphabet before anything is shown. An absolute URL smuggled into the code fails
the pattern and the page stays a plain 404. Four tests assert this from four
directions, including the smuggled-URL case.

**No redirect at all**, in fact — the page renders and offers a link. There is no
automatic navigation to hijack.

**No external requests.** No scripts, no stylesheets, no fonts, no images from
anywhere. Everything each page needs is in that page. Asserted by a test that
scans the built HTML for any external `src` or `href` that is not the store
listing, the mailto, or an internal path.

**No storage.** No cookies, no `localStorage`, no `sessionStorage`, no
`IndexedDB`. Asserted.

**The invite code is not a credential.** Possession lets a signed-in account say
who invited them and nothing else — no friendship, no visibility, no route
around a block. That property is enforced in 0026 and unchanged.

**No new attack surface in the extension.** `badgeCatalog()` reads a table that
was already granted to `authenticated` with a read policy, and returns no
user-identifying data. No new permission, no new host, no new message type that
carries anything sensitive.

---

## 25. Privacy review

**Nothing new is collected.** No analytics event was added by M5B. The public
site measures nothing: no analytics product, no pixels, no fingerprinting, no
cross-site tracking, no cookies, no logs beyond whatever GitHub keeps for any
Pages request, which Watchside neither controls nor reads.

The shell carries a comment saying so, because "the domain exists, so we should
measure visitors" is the default that has to be actively refused.

**The invite code never reaches a third party.** The landing page sends nothing
anywhere; the code travels only in a link the person chooses to follow.

**The badge catalogue reveals nobody.** It lists badges that exist, not badges
anybody holds. The earned list was already scoped to the signed-in account.

**The policy stays accurate.** M5B adds no data flow the policy would need to
describe, which is why `docs/PRIVACY.md` is unchanged and why the generated page
still matches it word for word.

---

## 26. Backend / schema impact

**None.** Schema stays at **37**. No migration was added, no function changed, no
grant or policy altered.

`badgeCatalog()` is a read against `badge_definitions` using the `select` grant
and read policy created in 0026.

One ordering property worth recording: 0026's seed carries
`on conflict (key) do update set description = excluded.description`, and 0037
rewrites those descriptions from "Kickback" to "Watchside". Migrations run once,
in order, so this is correct as it stands — but re-running 0026 against a live
database would silently undo 0037.

---

## 27. Chrome compatibility

**Compatible.** No manifest change, no permission change, no new host.

The Support link opens a new tab from a content-script-rendered panel, which is a
plain anchor and needs nothing. The badge catalogue is one more Supabase read
over the existing client.

Released 0.6.0 and the pending 0.7.0 are unaffected by the site: nothing in
either build resolves `watchside.app`.

---

## 28. Firefox compatibility

**Compatible**, on the same grounds — every change is shared UI code or a
Supabase read, with nothing touching the areas where the two browsers differ
(the event page's lifecycle, the OAuth redirect surface, notification
scheduling).

`verify:firefox` passes. The site's Firefox copy is the only Firefox-specific
thing M5B introduces, and §11 covers it.

---

## 29. Deterministic tests

**2,860 passing across 114 files.** Lint clean, `tsc -b` clean, build clean,
`verify:firefox` clean.

New in M5B:

| File | Tests | Covers |
| --- | --- | --- |
| `tests/extension/publicRouting.test.ts` | 41 | routes, referral survival, open-redirect refusal, availability honesty, no external loads, no storage, the subpath build |
| `tests/dom/productComprehension.test.tsx` | 14 | locked badges, notification honesty line, Groups distinction, Support discoverability |
| `tests/extension/requestCoverage.test.ts` | 4 | every RPC has a worker handler, an implementation in all three clients, and calls nothing unimported |

### The typecheck that checked nothing

`badgeCatalog` was added to the RPC union, to the port client and to the
worker's handler map — and the worker never imported the function that handler
calls. In production that is a `ReferenceError` the first time a real panel opens
a badge shelf. The feature would have looked finished and worked nowhere.

It survived because `npx tsc --noEmit` **checks nothing in this repository**. The
root `tsconfig.json` is solution-style: `files: []` and three project references.
A bare `--noEmit` against it compiles the empty root project and exits 0. Only
`tsc -b` follows the references, and it reports both errors immediately.

Two fixes, because one of them is not enough:

- `npm run typecheck` now exists and runs `tsc -b`. The command that looks right
  now is right.
- `requestCoverage.test.ts` asserts the same three properties from the test
  suite, so it holds for anybody who runs `npm test` and nothing else. Both
  defects were re-introduced one at a time to confirm it fails on each; it does.

The second defect is the same root cause seen from the other side. `KickbackClient`
has three implementations — the port client, the demo client and the Test Lab
client — and the Test Lab one was not updated. The panel crashed at render there,
which surfaced as **sixteen Test Lab failures that looked like sixteen unrelated
regressions** in Gravity counts, feedback, minimize and drag. The lab harness went
from its known 11 failures to 27, and comparing against a stashed tree was what
identified it as one cause rather than a collapse.

`publicRouting` builds the site from source in `beforeAll` and asserts against

It builds the site from source in `beforeAll` and asserts against
the **built output**, not the templates — so a build script that stops emitting a
route fails, not just a template that stops containing a string.

The comprehension tests live in `tests/dom/` rather than `tests/node/` because
they mount components and run effects. The `node` project renders to static
markup and cannot run an effect; a test written there would pass while the
component returned `null`, which is a mistake this project has made before and
which the mutation harness caught.

---

## 30. Mutation proofs

**65/65 detected.** Run serially, never concurrently.

Levers added in M5B, each removing a specific guarantee and each caught:

| Lever | Caught by |
| --- | --- |
| stop reading the code from `/i/<code>` | carries the code from the canonical route |
| stop reading the old `?c=` shape | still carries the code from the old shape |
| accept a code that fails the pattern | leaves the page as a plain 404 |
| take the destination from the URL | never reads a destination out of the URL |
| point the extension at the unresolved domain | still generates the currently-live link |
| advertise Firefox as available | does not offer Firefox, which is not published |
| hide locked badges again | shows what is still to earn |
| make locked badges pressable | renders them as spans, not buttons |
| drop the notification honesty line | says the browser has to allow them too |
| drop the Groups distinction | distinguishes a group from the stream tab |
| remove the Support link | offers a route that works without the panel |

| Harness | Result |
| --- | --- |
| `test:destruction` | **65/65 detected** |
| `test:analytics` | 6 of 87 undetected — known debt, unchanged |
| `test:presence` | 21/21 detected |
| `test:layout` | 23/23 detected |
| `verify:lab` | 11 failures — known debt, unchanged (see §29 for the 27 that were not) |

Every harness was re-run after the fixes in §29, not before them.

---

## 31. docs/FEATURES.md changes

| Feature | Before | After |
| --- | --- | --- |
| Badges | M5 POLISH — earned only | **READY** (main) — ladder visible |
| Support | M5 POLISH — no public route | **READY** — page built and linked |
| Notifications | M5 POLISH — no denial explanation | **READY** — corrected to what the model actually is |
| Groups | M5 POLISH — overlap with Rooms unexplained | **READY** — distinction stated |
| Invites/Referrals | note: M5 must migrate the link base | note: canonical route built, domain PREPARED, M5E flips the constant |
| **Public web (§23)** | did not exist | **new entry** — IMPLEMENTED, NOT LIVE, M5 POLISH pending DNS |

Counts: **READY 12 · M5 POLISH 7 · M5 BLOCKER 1 · EXPERIMENTAL 1 · POST-LAUNCH 1**.

Nothing became RELEASED, because main changed and nothing was submitted.

---

## 32. Remaining M5 work

| | Item | Owner |
| --- | --- | --- |
| **blocker** | Neither released build contains M3D, so it collects nothing from real users | M5D or a release |
| polish | DNS, verification, HTTPS for `watchside.app` | owner, external |
| polish | Publish `dist-pages/support/` so the shipped Support link resolves | owner, external, **no DNS needed** |
| polish | Flip `INVITE_LANDING_BASE` and the Support links to the domain | M5E, after §6–§8 pass |
| polish | Contrast audit and a screen-reader pass | M5 |
| polish | Publish the invite landing page — still not deployed since M4.5 | owner, external |

The M5 blocker is unchanged and is not M5B's to solve: M3D ships in a build, and
no build was submitted here.

---

## 33. Store recommendation

**Chrome: WAIT. Firefox: WAIT.**

Chrome 0.7.0 is pending review. Submitting again now would replace a package
already in the queue with one carrying unrelated changes, restarting the clock on
a review that is partly through.

Firefox has never been submitted, and the site now states publicly that it is
waiting on Mozilla — a claim that becomes false the moment it is published, which
is a reason to sequence the two together rather than a reason to rush.

Neither recommendation is CHANGE: nothing in M5B breaks either package, and no
finding here would fail a review.

---

## 34. Manual owner actions

In order. The first needs nothing external and fixes a link in a shipped build.

**1 — Publish Support (no DNS, do this first).**

```
npm run build:site:pages
```

Copy `dist-pages/support/` into the existing Pages repository at
`watchside/support/`. The account panel's Support link starts working as soon as
Pages rebuilds. `dist-pages/index.html` and `dist-pages/privacy/` are also built
and correctly rebased — copy them only if you want to replace what is at those
paths today.

**2 — Publish the invite landing page**, still outstanding from M4.5.
`docs/web/invite-landing/index.html` → `watchside/invite/index.html`. Until this
exists, every invite link a user copies leads to a 404.

**3 — Decide the hosting shape for the domain.** README §1. The recommendation
is a separate repository, because a `CNAME` on the org Pages repo would rebind
`anoteros-labs.github.io` entirely, taking `/kickback/` with it.

**4 — DNS.** README §2. Four `A`, four `AAAA`, one `CNAME` for `www`. Check the
addresses against GitHub's current documentation first.

**5 — Domain verification.** README §3. The `TXT` value comes from GitHub's own
screen; it is not in this repository and cannot be.

**6 — HTTPS.** README §4. Tick Enforce HTTPS once DNS resolves.

**7 — Confirm.** README §5, four checks. Only when all four answer is the domain
live, and only then does M5E flip the constants.

---

## 35. M5B verdict

**★ GO — repository-level.**

| Acceptance criterion | |
| --- | --- |
| watchside.app architecture correctly prepared | ✓ |
| canonical URL structure established | ✓ |
| existing referral links remain functional | ✓ |
| referral codes survive canonicalization | ✓ |
| privacy route works | ✓ |
| support route works independently of the extension | ✓ built; publish is owner action 1 |
| support discoverable from the extension | ✓ |
| Firefox not falsely advertised | ✓ |
| badges communicate progression without dark patterns | ✓ |
| notification permission states understandable | ✓ |
| Rooms vs Groups understandable | ✓ |
| no new privacy problem | ✓ nothing new is collected |
| no redirect/security defect | ✓ |
| released-client compatibility holds | ✓ |
| deterministic gates pass | ✓ 2,860 / 114 |
| mutation gates pass | ✓ 65/65 |
| docs/FEATURES.md updated | ✓ |
| external owner actions precisely documented | ✓ §34 |

**The domain is PREPARED. It is not LIVE**, and no code, test or claim in this
milestone says otherwise.

Two things worth carrying forward.

**A gate nobody ran was a gate nobody had.** `tsc --noEmit` against a
solution-style tsconfig is a no-op that exits 0, and it hid a production defect
through an entire milestone's worth of work. The lesson is not "run the build" —
it is that a check which cannot fail is worse than no check, because it is
counted as passing. `npm run typecheck` and `requestCoverage.test.ts` now make
it fail properly, in two independent ways.

**And:** M5B found that a shipped build links to a page nobody serves. That is the second time the gap was not in the code but in
something built and never published — the invite landing page has been
ready-to-copy since before M4.5. Both are one copy operation away from working,
and both have been silently broken for users the whole time.

**Next: M5E** for the constant flips, once §34 steps 4–7 pass. **M5D** remains
the blocker that matters, because M3D is still measuring nobody.
