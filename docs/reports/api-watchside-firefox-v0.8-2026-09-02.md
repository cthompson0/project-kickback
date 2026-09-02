# api.watchside.app + Firefox v0.8 release preparation

**Date:** 2026-09-02
**Scope:** the branded backend host, the `cdn.7tv.app` cleanup, and everything
that had to be true before either could reach a user
**Outcome:** the hard gate **passes**, and the work **stops at an owner
boundary** with four things only the owner can do

---

## 1. Verdict

**The Phase 1 hard gate passes: activating `api.watchside.app` does not break
Chrome 0.7 (live), Chrome 0.8 (submitted) or Firefox 0.6 (live) — provided one
step happens first, and it is not the step that looks most important.**

Supabase keeps serving the original project host after activation. The exception
is OAuth, and it is a sharp one: **after activation, Supabase advertises the
custom domain as the Twitch callback for every client, including the ones
already in the stores.** If that callback is not registered at Twitch *before*
activation, sign-in fails everywhere at once — not just for new builds.

So the ordering is the gate, not a nicety. §2.

**What could be finished, was.** The Firefox install dialog now names **four
domains instead of five**, and the packaging tooling now accepts a branded
backend, which it previously could not — the build would have failed with a
misleading error. §8.

**What is blocked**, and why this stops here: the custom domain needs a paid
add-on, a DNS record, a Twitch console change and a Supabase activation. This
environment has **no Supabase credentials of any kind** (§5), so all four are
owner actions. The exact list is §10.

**Do not submit the current Firefox v0.8 artifact.**
`Watchside-AMO-Candidate-v0.8.0.zip` (`acef1c34…`) predates today's permission
change and no longer matches source. §9.

---

## 2. Phase 1 — the hard gate, answered

**The question:** does activating a Supabase custom domain break clients that
are already in users' browsers and cannot be updated in step with it?

**The answer:** no, with one ordering condition.

Supabase's custom-domain guide is explicit:

> The Supabase project domain **continues to work** and serve requests so you do
> not need to rush to change client code URLs.

| Subsystem | Old origin after activation |
| --- | --- |
| REST / RPC | keeps working |
| Realtime (WebSocket) | keeps working |
| Edge Functions | keeps working |
| Auth token refresh / code exchange | keeps working |
| **OAuth authorize + callback** | **moves to the custom domain — see below** |

### The sharp edge

Two Supabase pages say this differently, and the difference is the whole
finding. The guide says:

> OAuth flows will advertise the custom domain as a callback URL.

The CLI reference says it more starkly:

> third-party auth providers will cease functioning on the Supabase-provisioned
> subdomain once activated.

Reconciled: **REST, Realtime and Functions keep serving the old origin; OAuth
does not.** Once the custom domain is live, a sign-in started by *any* client —
including Firefox 0.6 and the submitted Chrome 0.8 — causes Supabase to send
Twitch `redirect_uri=https://api.watchside.app/auth/v1/callback`, whichever
origin that client started from.

Twitch rejects a `redirect_uri` it does not recognise. So:

- **Register the callback at Twitch first → nothing breaks.** Old clients keep
  working; the leg they never see just runs on a different host.
- **Activate first → every sign-in in every published client fails**, until the
  Twitch console is updated. Existing sessions survive on their refresh tokens,
  so it would present as "new users and re-authenticating users cannot sign in",
  which is the slowest kind of outage to notice.

**This is the entire reason the gate exists, and it is an ordering constraint
rather than a compatibility problem.** The order is in §10.

The guide's own instruction agrees — add the custom-domain callback

> **in addition to** the Supabase project URL

so both are registered and nothing has to be removed. Nothing needs to be
withdrawn from Twitch, now or later.

---

## 3. Phase 2 — the callback chain, before and after

**Today**

```
extension  -> launchWebAuthFlow
           -> <ref>.supabase.co/auth/v1/authorize?provider=twitch
           -> Twitch consent
           -> <ref>.supabase.co/auth/v1/callback
           -> redirect to the extension's own redirect URL
           -> code exchange at <ref>.supabase.co
```

**After activation** the first, third and (for new builds) fifth steps move to
`api.watchside.app`. Two things notably do **not** change:

- **The extension's redirect URL.** It derives from the extension/add-on id, not
  from the backend host, and is registered in Supabase's allowed redirect list —
  which the custom domain does not touch. This is what makes the migration safe
  for published clients.
- **The Twitch client id and secret.** Unchanged.

**One Twitch Developer Console change is required**, and it is purely additive:

| | |
| --- | --- |
| Add | `https://api.watchside.app/auth/v1/callback` |
| Keep | `https://ezikxbbcwcxhkboeekkk.supabase.co/auth/v1/callback` |

Keeping the old entry costs nothing and is the rollback path: if activation has
to be reversed, OAuth returns to the old callback and finds it still registered.

---

## 4. Phase 3 — every place the backend origin is represented

| | Where | Class | What migration needs |
| --- | --- | --- | --- |
| **A** | `.env.local` → `VITE_SUPABASE_URL` | **the only real input** | one line |
| **B** | `dist/kickback-background.js` | derived from A at build | rebuild |
| **C** | Gecko `host_permissions` | **derived from B** | nothing — automatic |
| **D** | Chromium `host_permissions` in `public/manifest.json` | **static wildcard** | **a manual edit — §7** |
| **E** | `package-firefox.mjs`, `verify-firefox.mjs` | tooling | **fixed today** — §8 |
| **F** | `README.md`, `docs/PRIVACY.md`, checkpoint docs | prose | update at migration |
| **G** | Supabase allowed redirect URLs, Twitch callback | **server-side** | owner — §10 |
| **H** | Test fixtures (`example.supabase.co`, `project.supabase.co`) | fake hosts | nothing |

**The important row is D**, and it was not obvious. §7.

`docs/PRIVACY.md` currently says the backend is "hosted on Supabase
(`*.supabase.co`)". That stays true of the hosting and stops being true of the
hostname, so it needs one sentence at migration time — flagged, not changed,
because changing it before the domain exists would make it wrong today.

---

## 5. Phase 4 — STOP: no Supabase access, and a purchase boundary

```
Supabase CLI              not installed (no global binary, no local bin)
SUPABASE_ACCESS_TOKEN     unset
SUPABASE_SERVICE_ROLE_KEY unset
SUPABASE_DB_PASSWORD      unset
.env.local                VITE_SUPABASE_URL, VITE_SUPABASE_PUBLISHABLE_KEY,
                          VITE_KICKBACK_MODE      (publishable key only)
supabase/.temp            a stale link record: ref ezikxbbcwcxhkboeekkk
```

`supabase/.temp/linked-project.json` is left over from a CLI session that is not
reproducible here — there is no CLI and no token. So I could not read the plan,
could not enable the add-on, and could not run `supabase domains create`.

**Cost, from Supabase's own usage documentation:** the Custom Domain add-on is

> $0.0137 per hour ($10 per month)

and requires a project on a paid plan.

**I did not purchase, provision, upgrade or change anything.** Whether the
project is already on a paid plan is not observable from here; if it is, the
add-on is the only new charge.

---

## 6. Phase 5 — the exact DNS, and the state it starts from

Probed today:

```
watchside.app        A     185.199.108-111.153   (GitHub Pages)
www.watchside.app    CNAME anoteros-labs.github.io
api.watchside.app    NXDOMAIN          <- nothing exists; nothing to disturb
```

`api.watchside.app` is unused, so the record is purely additive and **cannot
affect the apex or `www`.**

**Record 1 — add before activation:**

| Type | Host | Value |
| --- | --- | --- |
| `CNAME` | `api` | `ezikxbbcwcxhkboeekkk.supabase.co` |

**Record 2 — TXT verification.** Supabase issues an `_acme-challenge` value
during `domains create`; it cannot be pre-computed, so it is step 3 of §10
rather than something written here. It is added at `_acme-challenge.api`.

---

## 7. The Chrome trap — a real finding, closed

**Chrome's manifest grants the backend statically. Nothing checked it, because
until now nothing had to.**

`public/manifest.json` declares `https://*.supabase.co/*`. That covered the
project host *by accident of shape* — any Supabase subdomain matches it. It does
**not** match `api.watchside.app`.

Firefox is safe here: its packager derives the grant from the origin the built
bundle actually names, so the manifest and the build cannot disagree. **The
Chrome packager had no such check.** A Chrome build pointed at the branded
backend would have produced a package granting a host it never talks to and
omitting the only host it does — and whether that breaks depends on Supabase's
CORS headers, which is not a thing to discover from a user.

`scripts/package-beta.mjs` now performs the same check Firefox always did, using
a shared `grantsOrigin`. Deliberately no regex: this decides what the extension
may reach, and a pattern that silently over-matches is worse than no check.

`grantsOrigin` also refuses `evilsupabase.co` against `*.supabase.co` — the
suffix must fall on a label boundary. That is tested, because a naive `endsWith`
would have handed a hostile host the grant.

**This is why Chrome's migration (locked decision 6) is a manifest edit somebody
makes on purpose, not a config flip.** It now fails loudly at package time
rather than quietly at a user's browser.

---

## 8. Phase 10–11 — what actually shipped into the repository

**`cdn.7tv.app` removed.** The evidence was established in the previous
investigation: `core/emotes.ts` only *builds* the URL and an `<img>` loads it,
and the control case (`static-cdn.jtvnw.net`, never permitted, working in the
Mozilla-signed 0.6.0) has now spent a full review cycle in production.

**The Firefox permission surface, verified from the built package:**

| Before | After |
| --- | --- |
| `ezikxbbcwcxhkboeekkk.supabase.co` | `ezikxbbcwcxhkboeekkk.supabase.co` |
| `7tv.io` | `7tv.io` |
| `cdn.7tv.app` | — |
| `www.twitch.tv` | `www.twitch.tv` |
| `twitch.tv` | `twitch.tv` |
| **5 domains** | **4 domains** |

The target surface — `api.watchside.app / 7tv.io / www.twitch.tv / twitch.tv` —
is **four domains, all legible**. The count does not improve again; the
legibility does, and that was always the point. Both states are pinned in
`tests/extension/hostPermissions.test.ts` so nobody mistakes one for the other.

**The tooling now accepts a branded backend, and previously could not.** The
packager and the verifier each carried their **own copy** of a
`[a-z0-9-]+\.supabase\.co` regex. Setting `VITE_SUPABASE_URL` to the branded
host would have matched **zero** origins and failed the build — the safe
direction, but with an error naming Supabase while the actual cause was a
hostname nobody had told the tooling about.

Both now call one shared `backendOriginsIn`, which enumerates the two shapes
that can legitimately be our backend. It is narrow on purpose: `7tv.io`,
`cdn.7tv.app`, `static-cdn.jtvnw.net` and `www.twitch.tv` all appear in the real
bundle, and a greedy pattern would have granted one of them a host permission.

**Activation day is now one environment variable.**

---

## 9. Phase 12–13 — why no submission artifact was built

**`Watchside-AMO-Candidate-v0.8.0.zip` (`acef1c34…`) must not be submitted.** It
was built before today's change and still carries `cdn.7tv.app`.

I did not rebuild it, because the locked decision is that Firefox v0.8 ships
with **both** the permission cleanup and the branded backend, and the backend
half is blocked. Building a submission candidate with one of the two would
either waste the review cycle or quietly ship a decision nobody made.

The development package was rebuilt and verified, which is what proves the
4-domain surface. **Every frozen artifact is byte-identical to before:**

| | |
| --- | --- |
| Chrome v0.8 (submitted) | `cb3af261448280cb…` **unchanged** |
| AMO candidate v0.8.0 | `acef1c34e629c30a…` **unchanged** |
| AMO source v0.8.0 | `580f33ea52255411…` **unchanged** |

---

## 10. The owner checklist — in this order

**The order matters. Step 5 before step 4 breaks sign-in for every published
client.**

1. **Supabase → Project Settings → General → Custom Domains.** Confirm the
   project is on a paid plan; enable the **Custom Domain add-on ($10/month)**.
2. **DNS (watchside.app):** add `CNAME` — host `api`, value
   `ezikxbbcwcxhkboeekkk.supabase.co`. Change nothing else.
3. **Supabase:** start custom-domain setup for `api.watchside.app`, take the
   `_acme-challenge` TXT value it gives you, add it at DNS as host
   `_acme-challenge.api`, then re-verify.
4. **Twitch Developer Console:** **ADD** redirect URL
   `https://api.watchside.app/auth/v1/callback`. **Keep the existing
   `…supabase.co/auth/v1/callback` entry.** ← *must be done before step 5*
5. **Supabase:** activate the custom domain.
6. **Tell me it is live.** I will switch `VITE_SUPABASE_URL`, rebuild, verify the
   4-domain surface, prove Chrome 0.7 / Chrome 0.8 / Firefox 0.6 still work
   against the old origin, and build the Firefox v0.8 submission artifacts.

**Optional, and it removes steps 3 and 5 from your plate:** running
`npx supabase login` once in a terminal establishes a CLI session on this
machine. I would then be able to run the `domains create` / `reverify` /
`activate` sequence myself. Nothing needs to be pasted into this chat, and I
never see the token. Steps 1, 2 and 4 remain yours regardless — they are
billing, DNS and Twitch.

---

## 11. Phase 14 — migration 0039 is still not applied

Not applied, and not applicable from here: production DB access needs the
service-role key or the CLI, and §5 shows neither exists in this environment.

`ops_health_v` and `ops_client_failures_v` therefore do not exist in production
yet, which means the operational visibility M6B built is still unavailable
during an incident. 0039 is additive and the previous report established it is
safe for all three published clients; it wants the same credential as step 6
above, so it is cheapest to do in the same pass.

---

## 12. Phase 15 — the apex certificate, checked once

**`watchside.app` still has no certificate of its own, and now the reason is
known.**

```
watchside.app      TLS  ERR_TLS_CERT_ALTNAME_INVALID
                   cert CN=*.github.io  (GitHub's default)
                   http 200            <- the site is being served
www.watchside.app  http 301 -> http://watchside.app/
```

GitHub is serving the site and redirecting `www` to the apex, which means the
custom domain **is** configured on the Pages repository. What has not happened
is Let's Encrypt issuance — so every visitor to `https://watchside.app` gets a
certificate warning while `http://` works fine.

The usual cause is that certificate provisioning stalled, and the usual remedy
is to remove and re-add the custom domain in the Pages repository settings to
retrigger it, then enable **Enforce HTTPS** once the certificate appears.

**I did not touch it.** The brief put the apex and `www` out of scope, and this
is independent of `api.watchside.app` — which gets its certificate from
Supabase, not from GitHub, and is unaffected either way.

---

## 13. Validation

| Gate | Result |
| --- | --- |
| Full suite | **3,091 passed / 127 files** (was 3,076 / 126) |
| Destruction mutations | **96 / 96 detected** (was 92 / 92) |
| `npm run lint` | clean |
| `npm run typecheck` (`tsc -b`) | clean |
| `npm run verify:firefox` | clean — backend grant narrowed, 4 domains |
| `npx web-ext lint` | **0 errors**, 3 known warnings |
| Frozen artifacts | Chrome `cb3af261…`, AMO `acef1c34…`, source `580f33ea…` — unchanged |

**New tests:** `tests/extension/backendOrigin.test.ts` (14) —
`backendOriginsIn` recognising both backend shapes and ignoring the four decoy
hosts in the real bundle, the branded Gecko manifest, and `grantsOrigin`
including the label-boundary case. `hostPermissions.test.ts` 7 → 8.

**New destruction levers (4):** narrow the backend pattern so the branded host
is invisible; widen it until any host matches; re-add a host permission nothing
fetches; let the Chrome manifest stop covering its own backend.

**Not done, and owner-blocked:** custom-domain purchase and activation, DNS,
the Twitch callback, migration 0039, and the Firefox v0.8 submission artifacts.
