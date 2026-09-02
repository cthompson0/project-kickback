# watchside.app — production polish

**Date:** 2026-09-02
**Commit:** `af8086c3c766a86bf30b88bd2b412eafe74903f1`
**Deployed:** yes — both surfaces, verified live over HTTPS

---

## 1. What was there, and the thing worth noticing

The page worked. It was one 46rem column of text with a single Chrome button,
and it said two things that had stopped being true:

> Watchside is in a small private beta. A Firefox version is built and working,
> and is **waiting on Mozilla's review** — there is nothing to install there yet.

Mozilla published Watchside. The listing has been serving an approved build.

**The part worth noticing is why that survived the release.**
`publicRouting.test.ts` contained a test called *"does not offer Firefox, which
is not"*, asserting `addons.mozilla.org` appeared nowhere and that the page still
said `waiting on Mozilla`. It was correct when written — linking a listing that
did not exist would have been worse — but nothing tied it to the fact it
depended on, so **the guard kept a true statement out of the page and held a
false one in.** That is now inverted, and a second test refuses release-process
prose entirely (§6).

The page also drew its own logo: a circle with a dot, not the Watchside mark.

---

## 2. Store URLs — established, not assumed

No AMO URL existed anywhere in the repository, so I asked Mozilla's API rather
than guessing a slug:

| | |
| --- | --- |
| **Chrome** | `https://chromewebstore.google.com/detail/ngfopkeokddfnncdhfkhnffilbdhkkip` |
| **Firefox** | `https://addons.mozilla.org/firefox/addon/watchside/` |

AMO reports slug `watchside`, guid `watchside@anoteros-labs.com`, status
**public**, currently serving **0.6.0** — exactly the situation the brief
described: the approved version stays installable while 0.8 is in review.

**The locale-less AMO path is deliberate.** AMO's own `url` field is the
`/en-US/` form; the path without a locale redirects each visitor to their own
language, and hard-coding `/en-US/` would send everyone to English. Both were
fetched and return 200.

---

## 3. Page structure

1. **Nav** — real mark, wordmark, Privacy / Support
2. **Hero** — *"See where your friends are watching Twitch."* with `watching
   Twitch` in the brand purple, one-sentence explanation, **Add to Chrome** +
   **Add to Firefox**, then `Free · Chrome & Firefox · Signs in with your Twitch
   account`
3. **Product visual** — the full-width presence screenshot, captioned
4. **Core loop** — three steps: *See where your friends are → Notice when people
   gather → Jump in with them*
5. **Social gravity** — *"Twitch is better when you know where your people are."*
   with two alternating screenshot rows: **Someone is already here**, **Watch it
   together**
6. **Privacy** — four claims, each traceable to `docs/PRIVACY.md`
7. **Final CTA** — *"Go find your people."*, both stores again
8. **Footer** — Privacy / Support / Contact, and the Twitch disclaimer

---

## 4. Assets — all real, none invented

| Asset | Source |
| --- | --- |
| Mark | `assets/brand/watchside-mark.svg`, inlined verbatim |
| Favicon | the same geometry as an inline `data:` SVG — no extra request |
| `presence.webp` | `assets/store/current/chrome/store-01-presence.png` |
| `join.webp` | `store-02-gravity-join.png` |
| `together.webp` | `store-03-together.png` |

These are the Store captures: the real extension on real Twitch, **including the
extension's own `DEMO` badge and `demo mode — mock data` footer**, left in. The
page is allowed to make the product look good; it is not allowed to make it look
like something it is not.

**`store-04-find-friends.png` was deliberately excluded.** Its invite field reads
`https://anoteros-labs.github.io/watchside/invite/?c=…` — a watchside.app page
showing a github.io URL would undermine the exact thing this milestone is for.

**1537 KB of PNG became 273 KB of WebP** (78–85% smaller) via
`scripts/site-images.mjs`, which drives the Chrome that `scripts/cdp.mjs` already
requires. No image dependency was added to a repository that has none. Output is
committed, so `npm run build:site` still needs no browser and no network.

**Total page weight: 381 KB**, of which 29 KB is HTML. No external fonts, no
JavaScript on the landing page, no third-party requests of any kind.

---

## 5. The invite page, which nobody asked about

`404.html` is what `/i/<code>` resolves to — **where every invite link lands, and
the first thing a friend of a user ever sees.** It offered Chrome alone, so half
of them arrived at a page telling them to install something they could not. It
also used the placeholder circle logo.

Both fixed. This is the acquisition surface M5C exists to measure, so a dead end
there is worth more than a cosmetic fix on the home page.

---

## 6. Tests changed, and why

| Test | Change |
| --- | --- |
| *"does not offer Firefox, which is not"* | **Inverted** — now asserts both stores are offered |
| *"serves a root page"* | Asserts the **rendered `<h1>` text**, since the headline is split across an `<em>` for the colour |
| *"does not narrate its own release process"* | **New** — refuses `waiting on mozilla`, `in review`, `coming soon`, `private beta`, … |
| *"offers both stores in both places"* | **New**, and see below |
| *"loads nothing from anywhere else"* | Allows the SVG **xmlns** (a namespace, never fetched) and the AMO link |
| *"offers both browsers, because this is where invites land"* | **New**, for `404.html` |

**One of my own tests was too weak and the mutation harness caught it.** The
destruction lever that removes the hero's Firefox button survived, because
`toContain` was satisfied by the *closing* CTA alone — so deleting the button
most visitors actually see would have left the suite green. The test now counts:
exactly two Chrome CTAs and two Firefox CTAs.

The stale lever *"site: advertise Firefox as available"* was inverted to
*"site: drop the Firefox install link"*, and a second lever now tries to
reintroduce review-status prose.

---

## 7. Verification

**Responsive** — rendered in Chrome at five widths, measuring rather than
eyeballing:

| Width | Document | Horizontal overflow | Images |
| --- | --- | --- | --- |
| 1440 | 4097 px | none | 3/3 |
| 1024 | 4077 px | none | 3/3 |
| 768 | 4756 px | none | 3/3 |
| 390 | 4669 px | none | 3/3 |
| 320 | 4981 px | none | 3/3 |

**Accessibility**

- every image has alt text describing what is actually in it
- every image declares `width`/`height` — no layout shift
- exactly one `h1`; heading order `h1 h2 h3×5 h2 h2`, no skipped levels
- all 12 links have accessible names; `lang`, viewport and `theme-color` set
- a keyboard skip-link to the install CTAs
- `prefers-reduced-motion` honoured
- **contrast measured, not assumed** — one real failure found and fixed: the
  footer disclaimer was `#6f6f7d` at **3.97:1**, under AA for its size. Now
  `#8a8a99` at **5.78:1**. Everything else was already AA (dim text 7.24:1, body
  18.05:1, accent on background 4.97:1, primary button label 5.38:1).

**Links** — all internal routes resolve; both store URLs fetched live (200);
Privacy and Support verified on the live domain.

**Not stale** — no `kickback`, no `waiting on Mozilla`, no `private beta`, no
`coming soon` anywhere in the built page.

**Other pages unaffected** — Privacy, Support and 404 render with no landing CSS
leaked and no overflow. The invite route still works: a valid code renders *"A
friend invited you to Watchside"*, an unknown path renders *"Page not found"*.

**Build and test**

| Gate | Result |
| --- | --- |
| Full suite | **3,094 passed / 127 files** |
| Destruction mutations | **97 / 97 detected** |
| `npm run lint` | clean |
| `npm run typecheck` (`tsc -b`) | clean |
| `npm run build:site` / `build:site:pages` | clean |
| `npm run build` (extension) | clean, unchanged |

---

## 8. Deployment

Both surfaces published and then **verified by fetching them**, not assumed:

| Surface | Repo | Commit |
| --- | --- | --- |
| `watchside.app` | `Anoteros-Labs/watchside-app` | `770affc` |
| `/watchside/` subpath | `Anoteros-Labs/anoteros-labs.github.io` | `b58d954` |

The subpath copy is what shipped extensions link their Support page to, so its
images ship with it — otherwise `/watchside/` would have served a landing page
with three broken pictures. `build-site.mjs` now rewrites `src` as well as
`href`, without which the subpath build would have emitted `/img/…` and 404'd.
`watchside/privacy/` was deliberately not overwritten.

**HTTPS now works.** At the start of this session `watchside.app` served
GitHub's default `*.github.io` certificate; it now presents
`CN=watchside.app, SAN=watchside.app, www.watchside.app`, and HTTP 301s to
HTTPS. Verified live: apex, `www`, `/support`, `/privacy` and all three images
all 200 over TLS, with two Firefox CTAs on the home page.

---

## 9. Owner action

**One thing, and it is not the landing page.**

`docs/PRIVACY.md` — linked from every page and now inaccurate in four places:

| Line | Says | Reality |
| --- | --- | --- |
| 5 | `Applies to: … private beta (v0.4.x)` | public on two stores at v0.8 |
| 20 | *"currently in a small private beta"* | published |
| 343 | lists `https://cdn.7tv.app/*` as a host permission | removed before Firefox v0.8 |
| 427 | *"This is a private beta"* | published |

**I did not edit it.** It is the one page on the site that is a legal document,
its scope line and "Last updated" date are load-bearing in a way marketing copy
is not, and the `cdn.7tv.app` line means it needs a real pass rather than a
find-and-replace during a landing-page milestone. It deserves its own short
piece of work.

Nothing else is blocked. Both stores are live, both CTAs point at them, the
domain serves over HTTPS, and the site is deployed.
