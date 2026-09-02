# watchside.app — the public site

Source for the canonical public surface. Built with `npm run build:site` into
`dist-site/`, which is gitignored, and pushed to `Anoteros-Labs/watchside-app` —
the Pages site that serves `watchside.app`.

**This directory is the source of truth for both public surfaces.** The same
sources build the canonical site and, via `npm run build:site:pages`, the
compatibility tree under `anoteros-labs.github.io/watchside/`. Edit here, never
in a published repository: the next build overwrites anything changed there.

```
/                index.html      what Watchside is, and how to get it
/privacy         generated from docs/PRIVACY.md
/support         works whether or not the extension does
/i/<code>        404.html        the canonical invite route
CNAME            watchside.app
.nojekyll
```

## Why `/i/<code>` is the 404 page

A static host has no router. GitHub Pages answers **any** path it does not
recognise with `404.html`, so that file reads the code out of `location.pathname`
itself. It is the whole reason the canonical route can exist without a server,
and it is why `404.html` is both the not-found page and the invite landing —
anything that is not a valid code simply stays a 404.

`/i/index.html` is the same page again, so the bare route resolves rather than
falling through.

## What must not change

**The referral identity is the code.** `/i/<code>` and the older `?c=<code>` are
two ways of carrying the same thing, and both end at
`twitch.tv/?kickback_invite=<code>`, where the extension's content script has
always read it. A new URL shape must never become a new referral concept.

Old links live in messages, clipboards and browser histories. `404.html` reads
both shapes for that reason, and `tests/extension/publicRouting.test.ts` proves
it.

## The Pages surfaces are published

`/watchside/` and `/watchside/support/` are **live** on the existing Pages site,
published from `docs/web/pages-watchside/` at Pages commit `aa7a42a`. Nothing
here is waiting on the domain.

The support page a shipped build links to now covers the panel failing to appear,
sign-in trouble, stale builds, notifications and account deletion — it previously
covered feedback and an email address. `/watchside/` was a 404 and is now
Watchside's home on that site.

To change either page: edit the sources here, run `npm run build:site:pages`,
copy the two files into `docs/web/pages-watchside/` (a test asserts they match),
then publish them to `Anoteros-Labs/anoteros-labs.github.io` under `watchside/`.
Credentials in this environment have push access to that repository.

`privacy/` is deliberately not part of the artifact: one is already live from the
same policy. The subpath build never writes a `CNAME`, a `404.html` or an `/i/`
route — a `CNAME` there would rebind the entire org site, and the other two only
work from a domain root. `publicRouting.test.ts` asserts all three absences.

## Where it is published

`Anoteros-Labs/watchside-app` — a dedicated project Pages site serving
`watchside.app` from `main` at `/`. Publish by pushing the contents of
`dist-site/` to that repository's root.

**Not the org site repository.** A `CNAME` in `anoteros-labs.github.io` would
bind that whole site to `watchside.app` and redirect every path under it,
including `/kickback/…` and the `/watchside/invite/` route shipped clients link
to. A project site takes the domain for itself and leaves the org site exactly
where it is — its Pages `cname` is still `null`, and all eight compatibility
routes still answer 200 unredirected.

GitHub's side is already configured: the repository exists, Pages is enabled from
`main` `/`, and the custom domain is claimed. All of it was done through the REST
API with the credential already in this environment; none of it needs the GitHub
UI.

## DNS — done

The owner made the Porkbun change and it is verified: all four `A` records, all
four `AAAA` records and the `www` `CNAME` are correct at public resolvers
(`1.1.1.1`, `8.8.8.8`) and at Porkbun's authoritative nameserver. No parking
address survives, so nothing round-robins. `www` 301s to the apex.

GitHub answers for the name — `curl -sI http://watchside.app/` returns
`200` with `Server: GitHub.com` — and every route serves bytes identical to the
built tree.

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

## HTTPS — the last step, and it is GitHub's

**Not yet issued.** The Pages API reported no certificate after 34 minutes of
polling, and the TLS handshake fails. Nothing blocking could be found: DNS is
correct, GitHub is serving the domain, and there is no `CAA` record on
`watchside.app` or on the `.app` TLD. GitHub documents up to an hour.

**Do not change DNS to hurry it.** Editing records now restarts the check that
has to finish.

**`.app` is HSTS-preloaded**, so browsers refuse plain HTTP for it. The HTTP
`200`s above are real and measurable with `curl`, but until the certificate
exists the domain is unreachable in a browser. DNS being live is not the same as
the site being usable.

When the certificate exists, enforcement needs no UI:

```
PUT /repos/Anoteros-Labs/watchside-app/pages   {"https_enforced": true}
```

## Domain verification — optional

Stops another repository claiming the domain. Nothing needs it to work.

The challenge value is **not exposed by the REST API** (three endpoints tried,
all 404), so this one really is a UI action: organisation settings → Pages → Add
a domain → `watchside.app` → add the `TXT` record it shows → Verify. The value is
generated by GitHub and cannot be written here without inventing it.

## Confirm

```
curl -sI https://watchside.app/            # 200
curl -sI https://watchside.app/privacy     # 301 -> /privacy/ -> 200
curl -sI https://watchside.app/support     # 301 -> /support/ -> 200
curl -s  https://watchside.app/i/<a-real-code> | grep kickback_invite
```

`/i/<code>` answers with a **404 status** and the invite page. That is the design:
a static host has no router, so GitHub serves `404.html` and that file reads the
code out of its own path. The page renders and the handoff works.

Until those answer, the domain is **prepared, not live** — and nothing in the
extension points at it yet.

## The extension still points at the old URL, on purpose

`INVITE_LANDING_BASE` in `src/core/invites.ts` is unchanged. Switching it before
the domain resolves would mean every invite copied in the meantime pointed at
nothing.

**M5E flips it**, once the checks above pass. It is one constant, and
`publicRouting.test.ts` pins which one is active so the switch cannot happen by
accident. The same milestone moves the two Support links in
`src/ui/components/AuthStates.tsx` from the Pages subpath to `/support`.

## The M5C seam

M5C adds acquisition and campaign attribution, which are **different things**
from friend referral:

| | Question |
| --- | --- |
| acquisition | how did this install arrive |
| friend referral | which Watchside user invited them — **exists today** |
| creator/campaign | which creator or campaign drove it |

`404.html` reads the code and nothing else. It does not consume, rewrite or
forward other query parameters, which leaves the whole query string free for M5C
to define — without needing to touch the referral path or re-do this routing.

**Do not fold these into one `referrer` field.** They answer different questions
and one of them is already durable.
