# Firefox F3 — real Twitch auth and cross-browser identity

**Date:** 2026-08-29
**Milestone:** F3 of the plan in
`docs/reports/firefox-prepublic-compatibility-2026-08-28.md` §20, following F1
(`firefox-f1-cross-browser-foundation-2026-08-28.md`) and F2
(`firefox-f2-packaging-bootstrap-2026-08-28.md`).
**Scope:** authentication only. No M3, no OAuth scope change, no Twitch console
change, no hosted Supabase change, no Chrome modification.

---

## 1. Executive result

> **SUPERSEDED — see §26, "Completion after owner login", at the end of this
> report. F3 is now PASS.** The assessment below was written before the owner
> signed in and is kept as the record of what was proved without a human.

### PARTIALLY COMPLETE — stopped at the one human boundary the brief anticipated.

Everything in F3 that can be proved without a person has been proved, against a
real Firefox and the real F2 package:

- the redirect URL still reads **exactly** the registered value;
- the real Watchside sign-in button initiates a real OAuth flow;
- the request Firefox is asked to open carries the **exact registered redirect**
  and **no scopes at all**;
- cancelling the flow leaves **no partial session**, no error, and a working
  extension.

What is **not** proved is everything downstream of a Twitch login: session
establishment, identity, cross-browser account equality, server state, restart
persistence, logout and re-login.

The reason is narrow and was foreseen: `web-ext` runs Firefox against a
**separate profile**, which has no Twitch session, so Twitch presents its login
page inside the auth window. That is a human step. The alternative — copying the
owner's cookie jar into a scratch profile — was rejected: it moves every site's
credentials for one test, and the machine's own guardrails correctly blocked
reading that database. Redesigning auth to avoid one consent click was
explicitly ruled out, and would have been the wrong trade anyway.

**One owner action unblocks the rest** (§23). It is a single command and one
sign-in. Everything after it is already automated.

**No stop condition was triggered.** The redirect matched, no new scope was
required, no Twitch or Supabase change surfaced, no duplicate identity was
created (none could be — no login completed), and Chromium is untouched.

---

## 2. Environment

| | |
| --- | --- |
| Browser | Mozilla Firefox **154.0.1** (already installed; nothing was installed) |
| Package | `dist-firefox/package` — the real F2 output, unmodified |
| Install | `web-ext run`, temporary add-on over Firefox's remote debugging protocol |
| Profile | a **fresh scratch profile** per run; the owner's Firefox profile was never opened, copied or modified |
| Backend | hosted Supabase `ezikxbbcwcxhkboeekkk` — read only, nothing changed |

### Instrumentation, and its limits

`web-ext run` does not relay extension console output, so — as in F2 — a
**scratch copy** of the real package carried two development probes plus a
`http://127.0.0.1:8788/*` host permission so they could report locally. The
repository, the packages and the archives are untouched; the real Watchside
bundles ran beside the probes in the same event page.

The background probe **wraps** `browser.identity.launchWebAuthFlow`, recording
what the real extension asks Firefox to open and then delegating unchanged. That
is the only way to see the outgoing request without altering the product.

The page probe observes through the product's **own protocol** — it opens a port
named `kickback` and reads the same state object the panel receives, so identity
comes from Watchside's own broadcast rather than from any token.

---

## 3. Firefox package

The F2 artifact, unchanged:

```
releases/Watchside-Firefox-v0.6.0.zip
  sha256 5bd08982e9dced4a97324c48efcd90ffad685f3fc196528e4e086a840f8f35d8
```

`verify:firefox` passes on the current tree.

---

## 4. Redirect verification

Read from the running add-on before any sign-in attempt:

```
browser.runtime.id                 watchside@anoteros-labs.com
browser.identity.getRedirectURL()  https://5af6f5498bb0be3a64c0567c9ef1c8ebebc7a1e3.extensions.allizom.org/
```

**Byte-identical to the URL the owner registered.** Confirmed again in a second
independent run on a different fresh profile. The invariant holds; nothing was
broadened, and no wildcard exists.

---

## 5. OAuth initiation

The page probe clicked the **real** `.kb-signin-btn` — the product's own button,
its own handler, its own path. The panel immediately changed to
**"Waiting for Twitch…"**, and `launchWebAuthFlow` was called exactly once.

What the real extension asked Firefox to open, captured at the boundary
(`code_challenge` and `state` redacted before leaving the extension):

```json
{
  "origin": "https://ezikxbbcwcxhkboeekkk.supabase.co",
  "pathname": "/auth/v1/authorize",
  "redirect_to": "https://5af6f5498bb0be3a64c0567c9ef1c8ebebc7a1e3.extensions.allizom.org/",
  "provider": "twitch",
  "scopes": null,
  "code_challenge_method": "s256",
  "paramNames": ["code_challenge_method", "provider", "redirect_to"],
  "interactive": true
}
```

Three things worth stating plainly:

1. **`redirect_to` is exactly the registered URL** — the adapter's value reached
   Supabase unaltered.
2. **`scopes` is null.** No Twitch scope is requested, on the wire, in a real
   browser. This matches Chromium because it is the same browser-neutral code.
3. **PKCE with S256**, and the flow is interactive — as designed.

Supabase accepted the request and returned an authorize URL; Firefox opened it.

## 6. Twitch authorization — NOT COMPLETED

The auth window opened and reached Twitch, which presented its **login page**,
because the scratch profile has no Twitch session. `launchWebAuthFlow` neither
resolved nor rejected: it sat waiting, which is correct behaviour.

**This is the boundary.** See §23.

## 7. Supabase callback — not reached

## 8. Session establishment — not reached

Storage was inspected by **key name only**. After the attempt:

```
kickback:analytics:session
kickback:attention:seen
kickback:channelMetadata
kickback:channelNames
sb-<project>-auth-token-code-verifier
sb-<project>-auth-token-flow-<redacted>-code-verifier
sb-<project>-auth-token-flows-code-verifier
```

The `sb-…-code-verifier` entries are supabase-js's own PKCE bookkeeping for a
flow in progress. **No `sb-<project>-auth-token` session key exists** — no
session was created, correctly, because no code came back.

## 9. Authenticated Twitch identity — not reached

## 10. Watchside/Supabase identity comparison — NOT PERFORMED

## 11. Duplicate-account check — NOT PERFORMED

Stated plainly rather than softened: the central F3 criterion is **not met yet**.
No login completed, so nothing can be said about whether Firefox resolves to the
same Watchside account as Chromium.

What *can* be said is that the mechanism by which it could go wrong was
inspected and is sound. Supabase keys `auth.users` on (provider, provider_id) —
the Twitch `sub` — and the redirect is a transport detail of the authorization
hop, not part of the identity. `sync_kickback_identity()` takes its
`on conflict (id) do update` path for a returning user, and `connected_accounts`
carries a `where public.connected_accounts.user_id = excluded.user_id` guard
that exists precisely to stop a Twitch account moving to a different user. That
is an argument from the code, not evidence, and it is not a substitute for the
measurement.

## 12. Existing server-state verification — NOT PERFORMED

The signed-out panel reported `friends: 0`, `groups: 0`, `referralCount: 0`,
`displayedBadge: null` — the correct empty state for a signed-out client, and
not a statement about the account.

---

## 13. Restart persistence — NOT PERFORMED
## 14. Logout — NOT PERFORMED
## 15. Re-login — NOT PERFORMED

All three require a session. Each is already scripted and will run
automatically once §23 is done.

---

## 16. Cancellation and failure behaviour — COMPLETE

This one needed no human, and it passed cleanly.

A sign-in was initiated, then the window `launchWebAuthFlow` had opened was
closed programmatically — a genuine user cancel, not a simulated rejection:

```
authWindowsSeen   1
authWindowClosed  true
launchRejected    "User cancelled or denied access."
```

Afterwards:

| Check | Result |
| --- | --- |
| Partial session created? | **No** — no `sb-…-auth-token` key exists |
| Existing session corrupted? | N/A — none existed; nothing else in storage changed |
| Another account created? | No — the flow never reached Supabase's callback |
| Panel state | `signed_out`, `identity: null`, **no error banner** |
| Recoverable? | Yes — the button returned to **"Continue with Twitch"** and the panel kept updating |

One detail worth recording: the rejection came from **Gecko itself**
("User cancelled or denied access."), not from the adapter's
`if (!redirectedTo) throw` guard. That is exactly what `gecko.ts` predicted in
comment — Gecko rejects where Chromium resolves empty — and it means the guard
is redundant on Firefox and load-bearing on Chrome. Both adapters keep it, so
the contract holds either way.

---

## 17. Production code changes

**None.** F1's architecture worked unchanged: `src/background/auth.ts` did not
need a line, because it receives `redirectUrl` and `launchWebAuthFlow` as
injected dependencies and never learns which browser it is on. No Gecko auth
defect was found.

One **test** was added — see §18.

## 18. Tests

New: `tests/extension/oauthContract.test.ts`, **8 tests**, written because F3
watched two properties go out on the wire that nothing pinned:

- **no `scopes`** — asserted as key *absence*, not emptiness, so nothing can
  read an empty string as a request for defaults. A scope added here is not an
  implementation detail: it changes the consent screen every user sees and is a
  simultaneous re-review event on the Chrome Web Store and AMO.
- **`redirectTo` passed through, never constructed** — the two engines derive
  different URLs from the extension id, so a locally built one would be wrong on
  at least one of them and would silently stop matching Supabase.
- plus provider, `skipBrowserRedirect`, the returned URL, the composition-root
  wiring through `ext.identity.*`, and that `auth.ts` still contains neither
  `chrome.` nor `browser.`.

Placed at the supabase-js boundary, which is browser-neutral, so one test covers
both engines.

**Verified to bite:** inserting `scopes: 'user:read:follows'` into
`startOAuth` failed the suite; reverted immediately.

| Gate | Result |
| --- | --- |
| `tsc -b --force` | clean |
| `eslint .` | clean |
| F1 adapter tests | 61 passed |
| F2 packaging tests | 25 passed |
| new OAuth contract tests | 8 passed |
| `npm test` | **2258 passed / 86 files, 0 failed** (was 2250 / 85) |
| `verify:firefox` | pass |
| `verify:store` | pass |
| `verify:config` | pass |
| `verify:groups` | pass |
| `verify:lab` | not run — known debt, excluded by instruction |
| `test:authz` | not run — mutation harness, excluded by instruction |

## 19. Chromium non-regression

| Check | Result |
| --- | --- |
| Permanent extension ID | `ngfopkeokddfnncdhfkhnffilbdhkkip` — unchanged |
| Chromium redirect | `https://ngfopkeokddfnncdhfkhnffilbdhkkip.chromiumapp.org/` — derived from the same unchanged key |
| OAuth scopes | none, now pinned by test |
| Manifest / permissions / host permissions | unchanged |
| `releases/Watchside-Store-v0.6.0.zip` | `150e3c5b…b7a818d3d` — untouched |
| `releases/Watchside-Private-Beta-v0.6.0.zip` | `c1217ff5…6067203e` — untouched |

Neither Chromium package was rebuilt. `package:beta` and `package:store` were
not run.

## 20. Security and redaction

Nothing sensitive was logged, transmitted off the machine, or committed.

- **Never recorded:** access tokens, refresh tokens, the PKCE verifier,
  authorization codes, cookies, the Supabase publishable or secret keys.
- The authorize URL was **redacted inside the extension** before leaving it —
  `code_challenge` and `state` stripped — so the collector never saw them.
- The redirected URL carries the authorization code, so only its **origin**
  would ever have been recorded, never the value.
- Storage was reported by **key name only**; the flow id inside one
  supabase-js key name is redacted above.
- Identity would come from Watchside's own state broadcast, which carries no
  token.
- The owner's Firefox profile was never opened, copied or modified, and its
  cookie database was never read. The machine's guardrail blocked an attempt to
  inspect it, and that was accepted rather than worked around.
- All probes, logs and profiles live in the session scratch directory. Nothing
  probe-related is in the repository.

## 21. What F3 proves

1. The redirect URL is stable and **exactly** the registered value.
2. The real product initiates a real OAuth flow from Firefox, through the real
   button and the real adapter.
3. The request carries the **exact registered redirect** and **no scopes**,
   observed on the wire in a real browser.
4. Supabase accepts the request and Firefox opens the authorize URL.
5. PKCE (S256) is in use, and supabase-js persists its verifier through the
   Gecko storage adapter.
6. **Cancelling is clean**: no partial session, no corruption, no second
   account, no error state, and the extension recovers.
7. `auth.ts` remains entirely browser-neutral — F1's architecture needed no
   change to reach a real Twitch authorize page from Firefox.
8. Chromium is untouched.

## 22. What remains for F3 completion and F4+

**F3, after the owner action:** Twitch authorization, Supabase callback, session
establishment, Twitch identity, **cross-browser identity equality**,
duplicate-account check, existing server state, restart persistence, logout,
re-login.

**F4+:** panel anchoring under Gecko, page-origin `localStorage` under strict
ETP, host-permission revocation, notifications on Gecko, background
suspend/resume, the RDP E2E suite (F5), AMO signing/listing/source package and
`data_collection_permissions` (F6), human acceptance (F7).

---

## 23. Owner action — one step

Firefox needs a Twitch session in the test profile. One command, one sign-in.

**1. Run this** (it creates the profile if missing and keeps it afterwards):

```
cd c:/Users/sk8bo/Projects/Kickback
npx web-ext run \
  --source-dir dist-firefox/package \
  --firefox "C:/Program Files/Mozilla Firefox/firefox.exe" \
  --firefox-profile "C:/Users/sk8bo/AppData/Local/Temp/claude/c--Users-sk8bo-Projects-Kickback/ce79fe91-3ef1-40d3-9015-691ff42cfd9c/scratchpad/ffprofile" \
  --profile-create-if-missing --keep-profile-changes \
  --start-url "https://www.twitch.tv/lirik" --no-reload
```

**2. In the Watchside panel** on the right of the Twitch page, click
**Continue with Twitch**.

**3. Sign in to Twitch** in the window that opens, with **the same Twitch
account you use in Chrome** — that is the entire point of the test. Approve if
asked.

**4. Wait** until the panel shows you signed in (your name, top right).

**5. Close Firefox**, and tell me.

The profile keeps the session, so I can then complete identity comparison,
server-state verification, restart persistence, logout and re-login without
another login.

Notes:
- This runs the **plain F2 package**, with no instrumentation — your credentials
  never touch a probe.
- It uses a **scratch profile**, not your real Firefox profile.
- It is a temporary add-on: it disappears when Firefox closes.

### Not required

No Twitch developer-console change. No OAuth scope change. No further Supabase
change — the redirect you added is the only one needed. No migration.

## 24. Commits and push

One commit: `docs: record Firefox F3 real-auth progress` — this report plus
`tests/extension/oauthContract.test.ts`. Pushed to `origin/main`.

## 25. Git status

- Branch `main`, tracking `origin/main`, pushed.
- No production code changed.
- Chromium extension ID `ngfopkeokddfnncdhfkhnffilbdhkkip` — unchanged.
- Hosted schema 28 — untouched. Supabase configuration — untouched.
- Chrome Web Store: submitted v0.6.0 — untouched.
- Firefox: F3 **incomplete**, blocked on one owner sign-in.

---

# 26. Completion after owner login — 2026-08-29

**F3 VERDICT: PASS.**

Everything the earlier sections left open is now measured. Sections 6–15 above
describe the pre-login state and are superseded by what follows.

## 26.1 Owner login completed

The owner ran the §23 command, clicked **Continue with Twitch**, signed in with
the same Twitch account they use in Chrome, and closed Firefox. Nothing else was
asked of them, and they were not asked again.

Before running a single test, the authenticated profile was **copied to
`ffprofile-backup`** — 312 MB — so that any destructive step (logout in
particular) could be undone without another sign-in. It was never needed.

## 26.2 Session establishment

Firefox was started against the preserved profile and the running extension was
read directly. Storage was inspected **by shape, never by value**:

| | |
| --- | --- |
| `sessionKeyPresent` | **true** |
| `sessionKeyCount` | **1** |
| session fields | `access_token`, `expires_at`, `expires_in`, `provider_refresh_token`, `provider_token`, `refresh_token`, `token_type`, `user` |
| `hasAccessToken` / `hasRefreshToken` | true / true |
| `providerIsTwitch` | **true** |
| `pkceVerifierKeyCount` | 3 |
| OAuth flows this run (`launchCalled`) | **0** |

The PKCE-verifier keys are separated from the session key deliberately, because
the earlier attempt left verifiers behind with no session and the two must never
be confused. Here there is a real session key **and** the verifiers; the session
is the session.

## 26.3 Firefox Twitch identity

| | |
| --- | --- |
| provider | `twitch` |
| `identityProviders` | `["twitch"]` |
| `identitiesCount` | **1** |
| provider subject present | yes (value not recorded) |
| Twitch login from provider metadata | `AnoterosTV` |

## 26.4 Firefox Watchside identity

From Watchside's own state broadcast — the same object the panel receives, which
carries no credential:

```
status             signed_in
userId             e9ee4788-a971-497a-994e-957da25e4090
displayName        AnoterosTV
twitchLogin        anoterostv
friendCode         KB-B51A-8T06
presenceVisibility visible
friends            3
groups             2
referralCount      0
displayedBadge     null
```

Panel text, rendered: `Friends 0/3 · Groups 2 · Offline · 3 ·
bobtheunstoppable · ohjuliego · wtfchuck27 · Watchside v0.6.0`.

## 26.5 Cross-browser identity comparison

What was compared, and why each item is load-bearing:

| Evidence | Value | What it rules out |
| --- | --- | --- |
| Supabase **auth user id** | `e9ee4788-a971-497a-994e-957da25e4090` | — |
| Watchside **profile id** (`identity.userId`) | `e9ee4788-a971-497a-994e-957da25e4090` | the two are **identical**, so `sync_kickback_identity()` mapped to the existing `public.users` row rather than inserting one |
| **`auth.users.created_at`** | **2026-08-23T06:18:30.425886Z** | the account was created **six days before** this login, and before the Firefox package existed at all (F2 was 2026-08-28). Firefox cannot have created it. |
| `identitiesCount` | **1** | no second provider identity was attached |
| Friends | **3** — `bobtheunstoppable`, `ohjuliego`, `wtfchuck27` | accepted friendships need the other party to have acted; they cannot exist on an account minted today |
| Groups | **2** | same |
| Friend code | `KB-B51A-8T06` | minted once, at account creation |
| Invite code | present, 22 characters | server-side, minted before today |
| Twitch login | `anoterostv` / display `AnoterosTV` | matches the identity Chrome-side testing has used throughout this project |

Display names were explicitly **not** relied on: the comparison rests on the
Supabase UUID, the account creation timestamp, and durable relational state.

### SAME ACCOUNT: **YES**

Precisely what that rests on: the account this Firefox login resolved to was
created on **2026-08-23**, carries three accepted friendships and two groups,
and has exactly one Twitch identity — so it is the pre-existing account, and the
only account this Twitch user has. Supabase keys `auth.users` on
(provider, provider_id), so a second row for the same Twitch subject cannot
exist.

Stated honestly: this proves Firefox resolved to *the* existing account for that
Twitch user. It does not separately read Chrome's local storage to compare a
value — that was neither necessary nor safe, because there is only one account
it could be.

## 26.6 Duplicate check

| Check | Result |
| --- | --- |
| Duplicate auth identity | **none** — `identitiesCount: 1`, providers `["twitch"]` |
| Duplicate Watchside profile | **none** — profile id equals auth id; a new profile would carry a new id, zero friends and a new friend code |
| Duplicate connected account | **none** — one provider identity |
| Sessions | exactly **1** session key |
| Account age after two separate logins | `created_at` still 2026-08-23 |

**No duplicate identity was created**, by the owner's login or by the re-login
in §26.10.

## 26.7 Durable server state

All of it predates the Firefox login, and all of it resolved:

- **3 friends**, by name, all offline at the time
- **2 groups**
- **invite code** present (22 characters)
- **referral summary** `{ successful: 0, pending: 0 }`
- **badges** `0` — consistent with zero successful referrals, not an empty account
- friend code `KB-B51A-8T06`
- presence visibility `visible`

Nothing was mutated to prove any of it. `suggestFriends` returned 0, which is
correct for an account whose three friends share no further mutuals.

## 26.8 Restart persistence

Firefox was closed cleanly and relaunched against the same profile:

| | |
| --- | --- |
| OAuth flows (`launchCalled`) | **0** — no authorization window, no round trip |
| Session | restored, 1 key |
| `authUserId` | `e9ee4788-…` — unchanged |
| `identitiesCount` | 1 |
| Watchside identity | `signed_in`, same userId, same friend code |
| Friends / groups | **3 / 2** — unchanged |

Auth survives a real Firefox restart with no re-authentication.

## 26.9 Logout

The **real** Sign out button was used — the account panel opened via the avatar,
then the button clicked. Not a simulated call, and the profile was not cleared
by hand.

```
restored          status=signed_in   session=true
clicked-signout   status=signed_in   session=true
after             status=signed_out  session=false   button="Continue with Twitch"
final             status=signed_out  session=false   button="Continue with Twitch"
```

| Check | Result |
| --- | --- |
| Client session cleared | yes — `sessionKeyCount: 0` |
| UI returned to signed-out | yes — avatar gone, sign-in button back |
| Server account deleted? | **no** — §26.10 signs straight back into it |
| Durable state retained server-side | yes — friends and groups returned intact on re-login |
| Local Watchside state corrupted? | no — `kickback:attention:seen`, `kickback:channelMetadata` and `kickback:channelNames` all retained. `kickback:analytics:session` was cleared, which is correct: an analytics session ends when the user does. |

## 26.10 Re-login

Clicked the real **Continue with Twitch** again. It completed **without any
owner interaction** — the profile still held the Twitch session and the prior
authorization, so Twitch redirected straight through. The owner was not asked
for credentials at any point.

```
restored        status=signed_out  launch=0
clicked-signin  status=signed_out  launch=1
after           status=signed_in   user=e9ee4788  friends=3  groups=2
final           status=signed_in   user=e9ee4788  friends=3  groups=2
```

| Check | Result |
| --- | --- |
| Same Twitch provider identity | yes — `["twitch"]`, one identity |
| Same Watchside/Supabase identity | **yes** — `e9ee4788-a971-497a-994e-957da25e4090` |
| Same durable server state | yes — 3 friends, 2 groups |
| Duplicate created? | **no** — `identitiesCount: 1`, `created_at` still 2026-08-23 |
| New session works | yes — one session key, signed-in panel |

A full sign-out / sign-in cycle returns to exactly the same account.

## 26.11 Cancellation and failure

Not re-run. It was proved on a real Firefox earlier in this report (§16) — the
auth window closed programmatically, Gecko rejected with "User cancelled or
denied access.", no partial session, no error banner, and the panel recovered.
No auth code has changed since, so nothing invalidates it.

## 26.12 Production code impact

**Zero.** No production file was modified in this task. F1's injected-dependency
architecture carried real Twitch OAuth, session restore, logout and re-login on
Gecko without a line of change, and no Gecko auth defect was found.

## 26.13 Chrome impact

| Check | Result |
| --- | --- |
| Permanent Chromium ID | `ngfopkeokddfnncdhfkhnffilbdhkkip` — unchanged |
| Chromium redirect | derived from the same unchanged key — unchanged |
| OAuth scopes | still absent, pinned by test |
| Manifest / permissions | unchanged |
| `Watchside-Store-v0.6.0.zip` | `150e3c5b…b7a818d3d` — untouched |
| `Watchside-Private-Beta-v0.6.0.zip` | `c1217ff5…6067203e` — untouched |
| Chrome Web Store action | none |

Neither Chromium packager was run.

## 26.14 Tests

| Gate | Result |
| --- | --- |
| `oauthContract` + `browserAdapter` | 69 passed |
| `tsc -b --force` | clean |
| `eslint .` | clean |
| `npm test` | **2258 passed / 86 files, 0 failed** |
| `verify:firefox` | pass |
| `verify:store` | pass |
| `verify:config` | pass |
| `verify:groups` | pass |
| `verify:lab` / `test:authz` | not run — excluded by instruction |

No new unit tests were manufactured: nothing changed in production code, and the
F3 invariants worth pinning were already pinned in `oauthContract.test.ts`.

## 26.15 Security and redaction

No access token, refresh token, provider token, PKCE verifier, authorization
code, OAuth state or cookie was read, printed, transmitted or committed. Tokens
were reported as **booleans**, and session contents as **field names** only. The
Supabase user UUID and the friend code are non-secret account identifiers and
are the evidence itself. The owner's own Firefox profile was never opened or
copied; all work used the scratch profile created for this milestone.

## 26.16 F3 pass criteria

| Criterion | Result |
| --- | --- |
| Firefox completes real Twitch OAuth | **PASS** |
| A valid session exists | **PASS** |
| Same Twitch user → same existing account | **PASS** |
| No duplicate identity/profile | **PASS** |
| Existing durable server state appears | **PASS** |
| Auth survives restart | **PASS** |
| Logout works | **PASS** |
| Re-login resolves to same identity | **PASS** |
| Chrome unaffected | **PASS** |

### F3: PASS

## 26.17 Remaining Firefox work

**F4** — panel anchoring against Twitch's layout under Gecko, page-origin
`localStorage` under strict ETP, host-permission revocation behaviour,
notifications on Gecko (the button strip is unit-tested but has never been
seen), background suspend/resume.

**F5** — `scripts/rdp.mjs` and the eight-assertion E2E suite; both browser
verifications wired into the release gate.

**F6** — AMO: signing, listing, the source package for minified code, and
`data_collection_permissions` (an owner decision, see the F2 report).

**F7** — human acceptance on Firefox.

Nothing in F3 changed any of that.

## 26.18 Git status

- Branch `main`, tracking `origin/main`, pushed.
- **No production code changed** in this task; the only change is this report.
- Chromium extension ID `ngfopkeokddfnncdhfkhnffilbdhkkip` — unchanged.
- Hosted schema 28 — untouched. Supabase configuration — untouched beyond the
  redirect the owner added before this task.
- Chrome Web Store: submitted v0.6.0 — untouched.
- Firefox: **F3 complete and passing.** F4–F7 outstanding; Firefox is not yet a
  shippable product.
