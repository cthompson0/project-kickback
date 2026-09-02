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
| `anoteros-labs.github.io/watchside/invite/` | **live** ¹ | unchanged; still the extension's link base |
| `anoteros-labs.github.io/watchside/support/` | **live, but thin** ¹ | **LIVE — replaced, see §37** |
| `anoteros-labs.github.io/watchside/` | 404 | **LIVE — new, see §37** |
| `watchside.app` | registered, nothing served | **DNS live, GitHub serving; awaiting certificate — see §39** |
| support email | `anoteros.dev@gmail.com` | unchanged, now published on a page |

¹ **Corrected after M5B GO.** Both rows originally read "not published", taken
from `docs/web/invite-landing/README.md`, which still says NOT DEPLOYED. Nobody
had asked the network. Both routes answer 200 and have for some time; the invite
page's script is byte-identical to the tested repository copy. See §36.

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
| `…github.io/watchside/support/` | **live contract** | shipped 0.7.0 clients | **yes — served, see §36** |
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

**CONFIGURED AND PROPAGATED** — *superseded by §39.* The owner made the Porkbun
change; all four `A`, all four `AAAA` and the `www` `CNAME` are correct at public
and authoritative resolvers, with no parking record surviving. The text below
described the state before that and is kept for the record.

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

**NOT VERIFIED. Optional.** *(§38 confirms the challenge value is not exposed by
the REST API — three endpoints tried, all 404. It remains a UI action.)*

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

**PROVISIONING** — *superseded by §39.* DNS is live and GitHub is serving the
domain; the certificate has not been issued yet after 34 minutes, with no `CAA`
record or other blocker found. No owner action: enforcement is one API call once
it exists.

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

**What was claimed here, and what is actually true.** This section originally
said nothing is served at `…github.io/watchside/support/` and that the account
panel's link 404s. **That was wrong** — the route answers 200. The claim came
from a repository README rather than from the network. See §36.

What is true is narrower and still worth fixing: the page that is live covers
feedback and an email address, and does not cover the panel failing to appear —
the one case where a page outside the extension is the only thing that can help.
The replacement above covers all six topics. It is owner action 1 in §34.

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
| ~~polish~~ | ~~Publish `docs/web/pages-watchside/`~~ — **published and live**; see §37 | done |
| polish | Flip `INVITE_LANDING_BASE` and the Support links to the domain | M5E, after §6–§8 pass |
| polish | Contrast audit and a screen-reader pass | M5 |
| ~~polish~~ | ~~Publish the invite landing page~~ — **already live**; see §36 | done |

The M5 blocker is unchanged and is not M5B's to solve: M3D ships in a build, and
no build was submitted here.

---

## 33. Store recommendation

**Chrome: WAIT. Firefox: WAIT.**

Chrome 0.7.0 is pending review. Submitting again now would replace a package
already in the queue with one carrying unrelated changes, restarting the clock on
a review that is partly through.

Firefox 0.6.0 **has** been submitted and is awaiting its first AMO review;
nothing is publicly released there yet. 0.7.0 was packaged and tested locally and
was **not** submitted. The site's copy — built and working, waiting on Mozilla's
review, nothing to install yet — is accurate for that state and needs no change.
It becomes false the moment AMO publishes, which is a reason to watch the review
rather than to submit anything now.

*(Corrected after M5B GO: the terminal summary said "never submitted", which was
wrong. Owner-confirmed external state is authoritative. See §36.)*

Neither recommendation is CHANGE: nothing in M5B breaks either package, and no
finding here would fail a review.

---

## 34. Manual owner actions

In order. The first needs nothing external and fixes a link in a shipped build.

**1 — ~~Publish the Support replacement~~. Done and live.** Published directly to
the Pages repository at `aa7a42a`; both routes verified 200 and byte-identical to
the artifact. See §37.

**2 — ~~Publish the invite landing page~~. Already live** — the route answers 200
and its script is byte-identical to the tested repository copy. Nothing to do.

**3 — ~~Decide the hosting shape~~. Done.** `Anoteros-Labs/watchside-app` exists,
serves `watchside.app`, and leaves the org site's `cname` `null`. See §38.

**4 — ~~DNS~~. Done by the owner and verified.** See §39.

**5 — ~~Domain verification~~. Optional**, and not required for the site to work.
§38 has the exact screen if wanted.

**6 — ~~HTTPS~~. Automatic** once DNS resolves; enforcement is one API call that
needs no owner action.

**7 — Confirm.** README §5. Only when those answer is the domain live, and only
then does M5E flip the constants.

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

**And:** M5B reported that a shipped build links to a page nobody serves. That
turned out to be wrong in the specific — the page is served — but right in the
general: nobody had checked, and the repository's own README still says NOT
DEPLOYED about a route that has been live for some time. §36 corrects it. That is the second time the gap was not in the code but in
something built and never published — the invite landing page has been
ready-to-copy since before M4.5. Both are one copy operation away from working,
and both have been silently broken for users the whole time.

**Next: M5E** for the constant flips, once §34 steps 4–7 pass. **M5D** remains
the blocker that matters, because M3D is still measuring nobody.

---

## 36. Post-GO operational cleanup

Appended after M5B ★ GO at `e9daa0e`. Narrow follow-up: publishability of the
Pages routes, and a correction to Firefox's external state. M5B itself is not
reopened.

### The publishing mechanism, and what it means

The Pages site is `Anoteros-Labs/anoteros-labs.github.io`. It is **not** this
repository (`cthompson0/project-kickback`), not a remote, not a submodule, and
not present in this workspace. There are no workflows in `.github/`, and this
repository's own Pages URL, `cthompson0.github.io/project-kickback/`, returns
404.

So **no, publication cannot be performed through repository changes.** Nothing
here can write to that repository. What a repository can do is make the copy
mechanical, reviewable and impossible to get wrong, and that is what was done.

### What was actually live — the correction that matters

M5B asserted both `/watchside/support/` and `/watchside/invite/` were
unpublished. That came from `docs/web/invite-landing/README.md`, which still
opens with **NOT DEPLOYED**. Nobody asked the network. Asking it:

| Route | HTTP |
| --- | --- |
| `…/watchside/privacy/` | 200 |
| `…/watchside/support/` | **200** |
| `…/watchside/invite/` | **200** |
| `…/watchside/` | **404** |
| `…/kickback/` | 404 |
| `anoteros-labs.github.io/` | 200 |

Two claims in M5B were wrong, and §3, §4, §17, §32 and §34 are corrected in
place. This is the second time in this project that a documented state was
believed over an observable one — the first cost two real Twitch JOINs. The
pattern is the same: a plausible written claim, never checked against the thing
it describes.

**Invite: live, functionally correct, visually stale.** The published page's
inline script is **byte-identical** to `docs/web/invite-landing/index.html`.
Referral semantics were never at risk: same 22-character alphabet, same `?c=`
read, same `twitch.tv/?kickback_invite=` hop.

The palette differs, and getting its direction right took being wrong first. My
initial reading was that the live page carried the current brand and the
repository copy was stale, so I synced the repository to the published bytes.
`brandAssets.test.ts` failed immediately: `#ff8a00`, `#6366f1` and `#0f172a` are
the **previous Kickback identity**, and the current Watchside brand is the purple
`#a855f7` / `#6d28d9` the repository already had. The sync was exactly backwards
and was reverted.

So the live invite page is **painted in the old identity**. Its behaviour is
right and its branding is a rename behind. That is a smaller problem than a
broken invite, and it is not urgent, but it is now a known one rather than an
invisible one.

**And the same defect was in M5B's own public site.** Every page built in M5B —
the root, support, the 404/invite landing — was painted `#ff8452`, another
accent from that buried identity. The brand test did not catch it because these
files did not exist when its surface list was written; a brand test protects the
surfaces it names and no others. The site is repainted to the current tokens, and
all six new web surfaces are added to that list. Removing the fix reintroduces
the failure, confirmed.

**Support: live, but thin.** The published page covers two things — feedback from
inside Watchside, and an email address. It does not cover the panel failing to
appear, which is the single case where a page outside the extension is the only
thing that can help, nor sign-in trouble, stale builds, notification delivery or
account deletion. The M5B page covers all six.

### What was prepared

`docs/web/pages-watchside/` holds the exact bytes to publish, following the
convention `docs/web/invite-landing/` already set — publishable files live in the
repository, so publishing is a copy and not a build.

```
index.html          ->  watchside/index.html
support/index.html  ->  watchside/support/index.html
```

**`index.html` is not optional.** `/watchside/` returns 404 today, and the support
page's back link and footer both point there. Publishing support alone would ship
a page whose own navigation is broken.

**`privacy/` is deliberately excluded.** A privacy page is already live at
`/watchside/privacy/`, generated from the same `docs/PRIVACY.md`. Overwriting a
live policy page as a side effect of publishing a support page is not a trade
worth making. `CNAME`, `404.html` and `/i/` remain excluded for the reasons in
§14.

Existing routes are preserved: nothing here touches `/watchside/privacy/`,
`/watchside/invite/` or `/kickback/…`, and no DNS change is made.

### The gate this needed

`tests/extension/pagesArtifact.test.ts` (8 tests) asserts the checked-in artifact
is byte-identical to `npm run build:site:pages`, that every internal link
resolves within the published set, that no privacy page is tracked in the
artifact, that it is the URL the account panel actually links to, and that the
support page still answers all six topics.

The invite landing page is the reason this gate exists. It sat checked in as
ready-to-copy while the published copy was rebranded, and nothing compared them,
because nothing could. **A checked-in artifact with no gate is a stale artifact
that looks current.** Both drift directions were re-introduced by hand to confirm
the test fails on each; it does.

### Firefox external state, corrected

The M5B terminal summary said "Firefox: WAIT (never submitted)". That was wrong.
Owner-confirmed and authoritative:

| | |
| --- | --- |
| Firefox 0.6.0 | **submitted, awaiting first AMO review** |
| Firefox 0.7.0 | packaged and tested locally, **not submitted** |
| Publicly released on Firefox | **nothing** |

Corrected in two places:

- **§33** of this report, which contained the only "never been submitted"
  sentence in the documentation set;
- **`docs/FEATURES.md`** release baseline, whose Submitted row read `none` for
  Firefox. Its Published row already read "0.6.0 pending first AMO review" and
  was correct.

Nothing else needed changing, and nothing was changed that was accurate when
written. In particular:

- the site's Firefox copy — *built and working, waiting on Mozilla's review,
  nothing to install yet* — is **accurate for the corrected state**, and the
  assertions in `publicRouting.test.ts` still hold;
- `docs/ROADMAP.md` deliberately says AMO state is "not assumed", which was the
  right posture and remains true;
- historical reports describing state at their own time were left alone.

Chrome is unchanged and correct: 0.6.0 published and live, 0.7.0 pending review.

**Recommendations stand: Chrome WAIT, Firefox WAIT for first AMO review.**
Neither package was uploaded.

### Validation

Content, documentation, one new test file, and a palette correction to static web
sources. No product source changed — `src/` is untouched — so the mutation suites
were not re-run. What was run:

| Gate | Result |
| --- | --- |
| `pagesArtifact` | 8 passed (both drift directions confirmed to fail it) |
| `brandAssets` | 14 passed, list extended to the six new web surfaces (confirmed to fail on a repaint) |
| `publicRouting` | 41 passed |
| `requestCoverage` | 4 passed |
| full suite | **2,868 passed / 115 files** |
| `npm run typecheck` (`tsc -b`) | clean |
| `npm run lint` | clean |

### The one remaining owner action

Copy the two files from `docs/web/pages-watchside/` into
`Anoteros-Labs/anoteros-labs.github.io` under `watchside/`:

```
index.html          ->  watchside/index.html
support/index.html  ->  watchside/support/index.html
```

Then:

```
curl -sI https://anoteros-labs.github.io/watchside/           # expect 200
curl -sI https://anoteros-labs.github.io/watchside/support/   # expect 200
```

No build step, no DNS change, nothing else.

The invite route needs nothing **functionally** — it is live and its logic is
byte-identical to the tested copy. Republishing
`docs/web/invite-landing/index.html` would additionally bring its branding up to
date, since the live copy still carries the pre-rename identity. That is
cosmetic, entirely optional, and deliberately not counted as the remaining
action.

---

## 37. The Pages artifact is published

Appended after §36. The Pages surfaces are **LIVE**, not prepared.

### The assumption that was wrong

§36 concluded that publication "cannot be performed through repository changes"
and handed the copy to the owner. The reasoning was sound as far as it went — the
Pages site is a different repository, not a remote here, no workflows — but it
stopped one question short. **Nobody checked whether the credentials already in
this environment could write to that repository.** They can.

The credential manager holds a GitHub credential with push access to
`Anoteros-Labs/anoteros-labs.github.io`. A clone succeeded, and a dry-run push
negotiated the update before anything was sent for real.

That is the same failure mode as §36 itself, one level up: a plausible
limitation, believed without being tested. §36 caught a stale claim about what
was published; it then made a fresh unchecked claim about what could be
published. Both were resolved by asking rather than reasoning.

### What was published

Pages repository `Anoteros-Labs/anoteros-labs.github.io`, branch `main`, commit
**`aa7a42a`**:

| Watchside source | Pages path | Change |
| --- | --- | --- |
| `docs/web/pages-watchside/index.html` | `watchside/index.html` | **added** — was 404 |
| `docs/web/pages-watchside/support/index.html` | `watchside/support/index.html` | **replaced** |

The diff contained those two paths and nothing else. `watchside/invite/`,
`watchside/privacy/`, `kickback/…`, the org root `index.html` and `.nojekyll`
were untouched. No `CNAME`, no `404.html`, no `/i/` — each would affect the whole
org site. No force push. No DNS change.

### Verification, after deployment

| Route | Before | After |
| --- | --- | --- |
| `/watchside/` | 404 | **200** |
| `/watchside/support/` | 200 (thin page) | **200 (replacement)** |
| `/watchside/invite/` | 200 | 200, byte-identical to before |
| `/watchside/privacy/` | 200 | 200, untouched |
| `/kickback/invite/` | 200 | 200, untouched |

The live bytes at both new routes are **identical to the checked-in artifact**,
so what is served is exactly what the repository's test gates. Every internal
link on the two pages resolves 200 following redirects — including
`/watchside/privacy`, which is the one link pointing at a page the artifact
deliberately does not carry.

**The invite page's inline script is unchanged by this push and still identical
to the tested repository copy.** Referral semantics were not touched, which was
the one thing that could not be allowed to move.

### What this changes for the product

The account panel's Support link is in a shipped 0.7.0 build. It now leads to a
page that covers the panel failing to appear — the case that page exists for —
rather than one offering feedback and an email address. That is a fix reaching
users who can already press it, not preparation for later.

### What is still not live

`watchside.app` is unchanged: no DNS, no verification, no HTTPS, nothing served.
§6–§8 and README §2–§5 stand exactly as written. The canonical domain remains
**PREPARED**, and the extension still generates the Pages invite link on purpose.

The live invite page is still painted in the pre-rename identity (§36). It was
deliberately not touched here: its behaviour is correct, and this task was not
the place to change a working referral surface for paint.

---

## 38. watchside.app — activation

Appended after §37. The canonical domain is **configured on GitHub and serving**;
it is **not yet reachable at its own name**, because DNS still points at the
registrar's parking page. That is the only thing left, and it is the one thing no
credential in this environment can do.

### Final hosting architecture

A **dedicated project Pages site**, `Anoteros-Labs/watchside-app`, serving
`watchside.app` from `main` at `/`.

M5B recommended this shape without proving it. It is now checked against what
GitHub actually reports:

| | Before | After |
| --- | --- | --- |
| `anoteros-labs.github.io` Pages `cname` | `null` | **`null`** — unchanged |
| `watchside-app` Pages `cname` | — | `watchside.app` |

The org site has **no** custom domain, which is what makes this safe. A `CNAME`
in the org site repository would have bound `anoteros-labs.github.io` itself to
`watchside.app` and begun redirecting every path under it — including
`/kickback/…` and the `/watchside/invite/` route that shipped 0.6.0 and 0.7.0
clients link to. A project site takes the domain for itself and leaves the org
site literally where it was. Verified after the change: all eight compatibility
routes still answer 200, unredirected, and the old invite page still carries a
code.

No paid hosting, no site builder, no backend, no analytics vendor, no pixels, no
cookies.

### What was automated

Everything except DNS. The stored git credential is an OAuth token for
`cthompson0` with `repo` scope and **admin** on the organisation, which turned
out to be enough for all of it:

| Step | How | Result |
| --- | --- | --- |
| create `Anoteros-Labs/watchside-app` | REST `POST /orgs/{org}/repos` | 201 |
| publish the built site | `git push` | `bf06092` |
| enable Pages from `main` `/` | REST `POST /repos/{…}/pages` | 201 |
| claim the custom domain | REST `PUT /repos/{…}/pages` | 204 |
| enforce HTTPS | REST `PUT /repos/{…}/pages` | **404 — "The certificate does not exist yet"** |

§36 concluded that publication needed the owner and was wrong; §37 said so. The
same question was asked properly this time, before assuming anything: the answer
was that a repository, a Pages site and a custom domain could all be configured
without the owner touching GitHub at all.

The published tree is generated output. Its sources are
`docs/web/watchside-app/` in this repository and it is produced by
`npm run build:site`; the repository's own commit message says so, because a
static site with no build marker invites someone to edit it in place and lose the
change on the next publish.

### GitHub configuration — confirmed by reading it back

```
Anoteros-Labs/watchside-app
  status   built
  source   main /
  cname    watchside.app
  https    not enforced — no certificate yet
```

### DNS — the boundary

**NOT CONFIGURED.** `watchside.app` resolves to `207.207.210.107` and
`207.207.210.229`, which are the registrar's parking addresses, and the zone is
otherwise empty: no `www`, no `TXT`, no `CAA`.

The provider is **Porkbun** (nameservers `*.ns.porkbun.com`). Whether it could be
automated was tested rather than assumed:

- no `PORKBUN_*` or other DNS-provider variables in the environment;
- no Porkbun configuration file in the profile;
- no DNS-provider entry among the stored Windows credentials;
- no authenticated DNS CLI installed.

So this genuinely stops here. The records are below, and the addresses were read
from GitHub's own `/meta` endpoint rather than recalled — all eight fall inside
the ranges GitHub currently publishes for Pages.

**First delete the two parking `A` records** (`207.207.210.107`,
`207.207.210.229`). Left in place, DNS would round-robin between the parking page
and GitHub, and the site would work about half the time — which is worse than not
working, because it looks intermittent rather than unconfigured.

| Type | Host | Value |
| --- | --- | --- |
| `A` | `@` | `185.199.108.153` |
| `A` | `@` | `185.199.109.153` |
| `A` | `@` | `185.199.110.153` |
| `A` | `@` | `185.199.111.153` |
| `AAAA` | `@` | `2606:50c0:8000::153` |
| `AAAA` | `@` | `2606:50c0:8001::153` |
| `AAAA` | `@` | `2606:50c0:8002::153` |
| `AAAA` | `@` | `2606:50c0:8003::153` |
| `CNAME` | `www` | `anoteros-labs.github.io` |

The `CNAME` target is the **organisation's** Pages host, not the repository —
that is how GitHub routes a project site's custom domain, and it is not a typo.

### HTTPS

**NOT PROVISIONED**, and blocked only on the above. GitHub's own answer when
asked to enforce it was *"The certificate does not exist yet"*. Once DNS
resolves, GitHub issues the certificate on its own; enforcement can then be
turned on through the same API call, which needs no owner action either.

### Domain ownership verification

**NOT CONFIGURED, and optional.** It prevents another repository claiming the
domain; nothing needs it to work.

The challenge value is **not exposed by the REST API** — three plausible
endpoints were tried and all returned 404. It exists only in the organisation's
Pages settings screen, which issues a `TXT` record named
`_github-pages-challenge-anoteros-labs`. Its value is generated by GitHub and
**cannot be written here without inventing it**, which would produce a record
that fails verification while looking like progress.

If the owner wants it: organisation settings → Pages → Add a domain → enter
`watchside.app`, add the `TXT` record it shows, press Verify.

### Canonical routing — verified against what is actually served

The domain does not resolve yet, so verification addressed a GitHub Pages edge
directly with `Host: watchside.app`. That proves GitHub's side end to end without
waiting for a registrar.

| Route | Status | Content |
| --- | --- | --- |
| `/` | 200 | byte-identical to `dist-site/index.html` |
| `/privacy` | 301 → `/privacy/` | 200 |
| `/support` | 301 → `/support/` | 200 |
| `/i/<code>` | 404 | byte-identical to `dist-site/404.html` |

**`/i/<code>` returning a 404 status is the design, not a defect.** A static host
has no router; GitHub serves `404.html` for unmatched paths, and that file reads
the code out of its own path. The page renders correctly and the handoff works.
Making it a 200 would need a page per code, which cannot exist, or a backend,
which is not worth having for this.

### Referral — proved against the served bytes

The served invite page's script was executed against ten cases:

| Case | Result |
| --- | --- |
| `/i/<CODE>` | → `twitch.tv/?kickback_invite=<CODE>` |
| trailing slash | same |
| lowercased | same, uppercased |
| legacy `?c=<CODE>` | same |
| both present | path wins |
| malformed | plain 404, no handoff |
| empty | plain 404 |
| smuggled absolute URL | plain 404 |
| path traversal | plain 404 |
| unrelated query params | code carried, **params not forwarded** |

Both shapes reach the **same** destination, the code is unchanged, and no input
produces a destination other than a literal `twitch.tv`. Existing codes are not
re-issued or re-encoded; the database is untouched. Settlement and self-referral
protections live in `0026` and were not modified, so there is no route to a
duplicate settlement or a self-referral regression from a URL change.

### Compatibility

Every previously live route still answers, unredirected:

`/watchside/`, `/watchside/support/`, `/watchside/privacy/`,
`/watchside/invite/`, `/kickback/invite/`, `/kickback/privacy/`,
`/kickback/support/`, and the org root — all 200. The old invite page still
carries a code.

Nothing was redirected. The brief allows redirecting compatibility URLs only for
a concrete proven benefit, and there is none: a redirect would add a hop for
shipped clients and could not make anything work that does not already.

### Source of truth

One set of sources, two build targets, so the canonical site and the
compatibility surface cannot drift apart:

```
docs/web/watchside-app/        sources — shell + pages
  npm run build:site        -> dist-site/    -> Anoteros-Labs/watchside-app  (watchside.app)
  npm run build:site:pages  -> dist-pages/   -> anoteros-labs.github.io/watchside/
docs/PRIVACY.md            -> both privacy pages, generated
docs/web/pages-watchside/      the subpath bytes, checked in and gated
```

`publicRouting.test.ts` builds from source and asserts the output;
`pagesArtifact.test.ts` asserts the checked-in subpath copy still matches its
build. The canonical tree is not checked in — it is pushed to a repository whose
commit message states it is generated and where its sources are.

### M5C seam

Unchanged and now demonstrated on the live surface: `/i/<code>` reads the code
and **nothing else**, and unrelated query parameters are provably not forwarded.
The whole query string stays free for M5C to define acquisition and campaign
attribution as separate concepts from friend referral. Nothing speculative was
added — no cookies, no fingerprinting, no pixels, no third-party requests.

### Store state on the canonical root

Owner-confirmed and unchanged by this task. Chrome 0.6.0 is published and the
root page links to that real listing; 0.7.0 is pending review. Firefox 0.6.0 is
submitted and awaiting its first AMO review, 0.7.0 was packaged locally and not
submitted, and nothing is publicly released there — so the page says a Firefox
version is built and waiting on Mozilla, with nothing to install yet, and carries
no `addons.mozilla.org` link anywhere. Asserted by `publicRouting.test.ts`.

### State

| | |
| --- | --- |
| CODE READY | ✓ |
| GITHUB CONFIGURED | ✓ repo, Pages, custom domain, serving verified by `Host` header |
| DNS CONFIGURED | ✗ — owner, Porkbun, records above |
| DNS PROPAGATED | ✗ |
| HTTPS PROVISIONED | ✗ — automatic once DNS resolves |
| PUBLIC LIVE | ✗ |

**The domain is not live**, and nothing here says otherwise. The extension still
generates the Pages invite link on purpose; M5E flips `INVITE_LANDING_BASE` and
the two Support links once the public HTTPS URLs answer.

---

## 39. DNS is live; HTTPS is provisioning

Appended after §38, once the owner had made the Porkbun change.

### DNS — propagated and correct

| Record | Expected | Public resolvers | Authoritative |
| --- | --- | --- | --- |
| `A @` | the four GitHub Pages addresses | all four | all four |
| `AAAA @` | the four GitHub Pages addresses | all four | — |
| `CNAME www` | `anoteros-labs.github.io` | correct | — |
| parking `A` | gone | gone | gone |

Checked against Cloudflare (`1.1.1.1`), Google (`8.8.8.8`) and Porkbun's own
authoritative nameserver. No parking address survives anywhere, so the
round-robin failure §38 warned about did not happen.

`www.watchside.app` resolves through the `CNAME` and **301s to the apex**, which
is what the `CNAME` file in the repository asks for.

### GitHub is serving the domain

```
$ curl -sI http://watchside.app/
HTTP/1.1 200 OK
Server: GitHub.com
```

Not merely resolving — GitHub is answering for the name. Every canonical route
was verified against the real domain, and the served bytes are **identical to the
built tree**:

| Route | Result |
| --- | --- |
| `/` | 200, identical to `dist-site/index.html` |
| `/privacy` | 301 → `/privacy/` → 200, identical |
| `/support` | 301 → `/support/` → 200, identical |
| `/i/<code>` | 404 status, identical to `dist-site/404.html` — the design (§38) |

The invite script was executed against the bytes the domain actually served, over
ten cases: canonical path, trailing slash, lowercase, legacy `?c=`, both shapes
at once, malformed, empty, a smuggled absolute URL, a path traversal, and
unrelated query parameters.

Both shapes reach the **same** `twitch.tv/?kickback_invite=<code>` with the code
unchanged. Every malformed input stays a plain 404 with no handoff. No input
produces a destination other than a literal `twitch.tv`. Unrelated query
parameters are carried nowhere, which keeps the M5C seam open.

### HTTPS — provisioning, and this is the blocker

**No certificate yet.** GitHub's Pages API reports `https_certificate: null`
after **34 minutes** of polling across three windows, and the TLS handshake
fails. Enforcement cannot be turned on until the certificate exists — the API
answers `404 The certificate does not exist yet`.

Nothing is blocking it that can be found:

- DNS is correct at authoritative and public resolvers;
- **no `CAA` record** exists on `watchside.app` or on the `.app` TLD, so nothing
  refuses the issuing authority;
- GitHub is serving the domain, so its own DNS check has passed;
- the custom domain was re-asserted through the API to re-trigger the check.

GitHub documents this as taking up to an hour, occasionally longer. It is
waiting, not failing, and **DNS was not touched again** — changing records now
would restart the very check that has to complete.

### Why "DNS live" is not "usable"

`.app` is an HSTS-preloaded TLD. Browsers refuse plain HTTP for it outright, so
the `200`s recorded above — real, and measured with `curl` — are **not reachable
from a browser**. Until the certificate is issued, `watchside.app` is
unreachable to an actual person.

That is the honest reading, and it is why this section does not claim the domain
is live. Everything that can be true before a certificate is true; the last step
is GitHub's and is not being waited on by anything in this repository.

### Compatibility — unaffected

All eight routes still answer 200, unredirected: `/watchside/`,
`/watchside/support/`, `/watchside/privacy/`, `/watchside/invite/`,
`/kickback/invite/`, `/kickback/privacy/`, `/kickback/support/`, and the org
root. The org site's Pages `cname` is still `null`.

### Store copy on the live domain

Served and verified on the domain itself: the root carries the real Chrome
listing and **zero** `addons.mozilla.org` links anywhere on the site. Firefox is
described as built and waiting on Mozilla's review with nothing to install —
accurate for 0.6.0 submitted and awaiting first review.

### State

| | |
| --- | --- |
| CODE READY | ✓ |
| GITHUB CONFIGURED | ✓ |
| DNS CONFIGURED | ✓ |
| DNS PROPAGATED | ✓ public and authoritative |
| HTTPS PROVISIONED | ✗ — GitHub, in progress, ~34 min elapsed |
| PUBLIC LIVE | ✗ — blocked only on the certificate |

### What happens next, and by whom

**No owner action.** The certificate is GitHub's to issue. When it exists,
enforcement is a single authenticated API call that needs no UI:

```
PUT /repos/Anoteros-Labs/watchside-app/pages   {"https_enforced": true}
```

Re-run the checks in `docs/web/watchside-app/README.md` after that. Only when
`https://watchside.app/` answers is the domain live — and only then does M5E flip
`INVITE_LANDING_BASE` and the two Support links.
