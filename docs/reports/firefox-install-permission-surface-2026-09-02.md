# Firefox install permission surface — investigation before v0.8

**Date:** 2026-09-02
**Trigger:** the owner installed Firefox 0.6 and read the permission dialog
**Also contains:** F7 — acceptance of the Mozilla-signed, publicly distributed artifact

---

## 1. Verdict

**Recommendation: B — one small permission cleanup, then submit v0.8.**
Remove `cdn.7tv.app`, which nothing fetches. Keep everything else.

**But the honest headline is that the cleanup does not solve the owner's actual
concern.** The dialog goes from five domains to four, and the raw Supabase
hostname — the entry that looks untrustworthy — is still there.

The thing that *would* solve it is a branded backend host
(`api.watchside.app`), and this investigation turned up a timing argument that
matters more than the cosmetics: **changing the backend host is a one-way door
that gets more expensive every day Firefox 0.6 stays public.** §7.

**F7 passes.** The signed artifact Mozilla distributes is byte-identical to our
candidate in every executable and asset file.

---

## 2. What the owner saw, and where all five domains come from

> Required permissions: **"Access your data for sites in 5 domains"**

The manifest declares only **three** host permissions. The other two come from
somewhere else, which is why the count is not obviously derivable:

| Domain | Manifest field | Why |
| --- | --- | --- |
| `ezikxbbcwcxhkboeekkk.supabase.co` | `host_permissions` | The backend — auth, REST/RPC, Realtime, Edge Functions |
| `7tv.io` | `host_permissions` | `sevenTv.ts` fetches emote metadata |
| `cdn.7tv.app` | `host_permissions` | **Nothing fetches it** — §5 |
| `www.twitch.tv` | `content_scripts[0].matches` | The panel is injected here |
| `twitch.tv` | `content_scripts[0].matches` | Same, without the `www` |

**Firefox counts content-script matches as host access**, because that is what
they are: a script running with access to those pages' data. AMO's own API
confirms the framing — it reports the two Twitch patterns inside `permissions`,
alongside `identity` and `storage`, rather than under `host_permissions`.

The raw Supabase hostname appears because `scripts/manifest.mjs` **narrows** the
Chromium wildcard `https://*.supabase.co/*` to our specific project origin for
Gecko. That narrowing is correct and was deliberate: the wildcard grants every
Supabase project on the internet. The unfortunate side effect is that the
specific-and-honest version is the one that reads like a random string.

---

## 3. Firefox permission semantics, and the asymmetry that governs everything

Firefox describes host permissions as *"access your data for sites in N
domains"* rather than as network access because that is the capability being
granted: a host permission lets the extension read and write those origins'
data, not merely reach them.

**The rule that decides this investigation** is not about the wording. It is
that required permissions are **asymmetric across updates**:

- **Removing** a required permission in an update is silent and free.
- **Adding** one — or changing a host to a *different* host, which is an add
  plus a remove — makes Firefox **disable the extension until the user
  re-approves it**.

So every option here has to be judged by what happens if it is wrong, not only
by what happens if it is right.

---

## 4. Supabase — required, and not worth touching

**Necessary. Keep it.**

Every network call Watchside makes to its backend originates in the **background
script**; the content script never fetches at all (verified — there is no
`fetch(` anywhere under `src/content` or `src/ui`). One origin covers all of it,
because supabase-js derives auth, REST, Realtime and Functions from the single
project URL.

Could a background `fetch()` reach Supabase without the permission, on CORS
alone? **Possibly** — Supabase serves permissive CORS, and WebSockets are not
subject to CORS at all. I did not prove it either way, and I am not going to
recommend acting on it, because of §3:

- if the permission is removed and the reasoning is wrong, **every Firefox user's
  extension breaks completely** — auth, friends, presence, all of it;
- putting it back **disables the extension for all of them until they
  re-consent**;
- the gain would be one line in a dialog.

That is a catastrophic downside against a cosmetic upside. **The experiment is
not worth running**, because no result would change the recommendation: even a
green lab test leaves us depending on a third party's CORS configuration, which
they can change without telling us, for something we cannot cheaply undo.

The in-repo control case (§5) proves *image* loads need no permission. It proves
nothing about fetch, and I am not going to stretch it into an argument it does
not support.

---

## 5. 7TV — one of the two is removable, with evidence

| | |
| --- | --- |
| **`7tv.io`** | **Keep.** `sevenTv.ts` genuinely `fetch()`es emote metadata from it. |
| **`cdn.7tv.app`** | **Remove.** Nothing fetches it. |

`core/emotes.ts` only *builds* a `https://cdn.7tv.app/emote/…webp` string; the
image is loaded by an `<img>` in the content script's shadow DOM. Image loads are
governed by the page's CSP, not by extension host permissions.

**The control case is in production and Mozilla-approved.**
`static-cdn.jtvnw.net` carries every Twitch emote and avatar Watchside renders,
is used in exactly the same way — a URL built in `core/emotes.ts`, rendered as an
`<img>` — has **never** been in `host_permissions`, and works today in the signed
0.6.0 that AMO is distributing. Whatever is true for it is true for
`cdn.7tv.app`.

This was already identified as a P2 candidate before the Chrome beta and
deferred because it could not be verified then. The control case has since spent
a full review cycle in production.

**Failure mode if the reasoning is still wrong:** 7TV emotes stop rendering in
chat. Bounded, cosmetic, and recoverable — and recoverable *cheaply*, because
`cdn.7tv.app` would be re-added while the installed base is still small.

`tests/extension/hostPermissions.test.ts` (7 tests) now pins the distinction in
both directions: a fetched host must be permitted, and `cdn.7tv.app` must not
become a fetch target.

---

## 6. Twitch — both entries necessary

**Keep both.** `https://twitch.tv/*` does not match `https://www.twitch.tv/*`;
match patterns are exact about the host. People arrive at both, and dropping
either means the panel silently fails to appear for some of them — which M6A
established is an activation failure, not a cosmetic one.

This is also the *least* alarming part of the dialog. An extension whose entire
purpose is a panel on Twitch asking for access to Twitch is the one entry a
stranger reads and immediately understands.

---

## 7. `api.watchside.app` — feasible, and the timing is the real argument

Supabase supports custom domains, which would make the dialog read
`api.watchside.app` instead of a random-looking project host. That is a genuine
fix for the actual concern rather than a reduction in count.

**What it requires** (investigation only — nothing was purchased, provisioned or
changed):

- a **paid Supabase plan plus the custom-domain add-on** — an owner spend
  decision, and the reason this stops here;
- DNS records on `watchside.app`, which currently has no working certificate of
  its own;
- one URL change in the extension config; supabase-js derives auth, REST,
  Realtime and Functions from it, so REST, WebSocket and Edge Functions all
  follow the single value;
- **a new required host permission for Firefox**, per §3.

**The timing argument, which is the finding worth acting on.**

Changing the backend host means Firefox sees a host permission it has not been
granted, and **disables Watchside for every existing Firefox user until they
re-approve**. That cost scales directly with the installed base.

Firefox 0.6 went public days ago. **The installed base is the smallest it will
ever be.** If this is ever going to be done, the cheapest possible moment is now
or at the next release — and it gets monotonically more expensive from here.

That is a genuine product decision with a genuine deadline, and it is the
owner's, not mine. It is not a reason to hold v0.8: 0.8 can ship with the
current host and the domain change can follow, at a cost that is still small
next release and large in six months.

---

## 8. Other ways to improve the dialog

**Optional permissions** — Firefox supports `optional_host_permissions`, moving
the ask from install time to a runtime prompt. **Not recommended.** Watchside
cannot function at all without its backend, so the prompt would fire
immediately after install, in the middle of the first-run flow M6A just spent a
milestone making coherent. A surprising runtime prompt during activation is
worse than an expected install-time one, and the AMO listing description can
explain the install dialog in a way no runtime prompt can.

**The listing is the real lever, and it is free.** The AMO description can say
what each domain is for. That costs nothing, risks nothing, needs no review
cycle beyond the one v0.8 already needs, and directly addresses "an unexplained
random hostname". Suggested text is in §11.

---

## 9. F7 — the signed artifact, accepted

Firefox 0.6.0 is **public on AMO**, confirmed through Mozilla's own API rather
than inferred.

| | |
| --- | --- |
| Downloaded | `watchside-0.6.0.xpi`, 191,310 bytes |
| SHA-256 | `de845dbfbeb7edee1fb383668f8724019743020e7ecca1f886bcd780f80e95ab` |
| Matches AMO's published hash | **yes** |

Compared against our candidates, the signed artifact corresponds to
**`Watchside-AMO-Candidate-v0.6.0-r2.zip`**, and is byte-identical in every file
that matters:

| File | |
| --- | --- |
| `kickback-background.js` | **identical** |
| `kickback-content.js` | **identical** |
| `popup.html` | **identical** |
| all four icons | **identical** |
| `manifest.json` | differs by **one trailing newline** (1418 vs 1419 bytes) — Mozilla's pipeline re-serialised it |

Mozilla added only `META-INF/` — the COSE and RSA signatures. **No code was
modified.** What users are running is what we built.

The signed manifest also confirms the shipped declaration matches our source:
the three host permissions, the two Twitch matches, the gecko id, and the four
`data_collection_permissions` (`authenticationInfo`, `browsingActivity`,
`personalCommunications`, `websiteActivity`).

**F7 ★ GO.**

---

## 10. Recommendation

**B — small cleanup, then submit v0.8.**

1. Drop `cdn.7tv.app` from `host_permissions`. Evidence in §5; failure mode is
   bounded and cheaply reversible.
2. Keep Supabase, `7tv.io` and both Twitch patterns.
3. Explain the domains in the AMO listing description (§11) — free, and it
   addresses the actual complaint better than removing an entry does.
4. Put `api.watchside.app` in front of the owner as a **timed** decision (§7),
   separate from v0.8.

**Not C (hold for a branded domain).** Holding v0.8 would delay the release that
finally distributes M3D and M5C — the two measurement systems that have observed
nobody for three milestones — for a change that needs a spend decision and DNS
that is not yet working.

**Not A (submit as-is).** `cdn.7tv.app` is a permission nothing uses, sitting in
the first thing a stranger reads about Watchside. It costs one line to remove.

**I have not changed the v0.8 candidate.** The brief asked for the decision
first, and the frozen Firefox artifacts are untouched.

---

## 11. Exact next action

**Owner decides two things:**

1. **Approve the `cdn.7tv.app` removal?** If yes, it is one line in
   `public/manifest.json`, then rebuild the Firefox candidate and re-run
   `verify:firefox`. Chrome's manifest can keep the entry until Chrome's next
   submission — narrowing Chrome now would mean a new Chrome review for a
   cosmetic gain, and 0.8 is already in that queue.
2. **`api.watchside.app` — now, next release, or never?** §7. The cost only
   goes up.

**Suggested AMO description addition**, if the listing is being edited anyway:

> Watchside needs access to four things: **twitch.tv** and **www.twitch.tv**,
> where it draws its panel; **7tv.io**, to show the same emotes you already see
> in chat; and its own backend, which stores your friends list and presence.

Naming the backend as "its own backend" is what turns an unexplained hostname
into an explained one — the dialog cannot say that, but the listing right above
it can.

---

## 12. Validation

| Gate | Result |
| --- | --- |
| `tests/extension/hostPermissions.test.ts` | **7 passed** (new) |
| full suite | 3,076 passed / 126 files |
| lint, `tsc -b` | clean |
| `verify:firefox` | clean |
| signed-artifact hash | matches AMO's published hash |

The experimental 4-domain package was built into a scratch directory and linted;
**no release artifact was rebuilt, overwritten or modified.** Chrome v0.8
remains `cb3af261…`.
