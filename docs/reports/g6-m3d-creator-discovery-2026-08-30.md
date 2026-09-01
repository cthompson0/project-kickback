# G6 + M3D — Creator discovery measurement

**Date:** 2026-08-30
**Type:** IMPLEMENTATION checkpoint — **halted at a STOP condition before any code was written**
**Entering commit:** `ec8a28c` · Pages `152e4ac` · both trees clean
**Hosted analytics schema:** 31 (unchanged)

> **Nothing was implemented.** No OAuth change, no scope request, no provider
> token handling, no `following_at_join`, no `creator_relationship_observations`,
> no migration, no manifest change, no package, no release. The only repository
> change is this report and the roadmap line it justifies.

---

## 1. Executive verdict

## **STOP**

**M3D as specified cannot be built without persistent provider-token custody**,
which this brief forbids and names as an explicit STOP condition. The blocker is
not Twitch — Twitch's side is fine. It is **Supabase Auth**, and it is
structural.

The chain, each link verified against a current primary source:

1. `Get Followed Channels` requires **a user access token** with
   `user:read:follows`. *"Requires a user access token that includes the
   `user:read:follows` scope."* **No app-access-token path exists** (§4).
2. Supabase surfaces the Twitch `provider_token` **once, immediately after
   sign-in**, and *"Supabase Auth does not manage refreshing the provider token
   for the user"* (§3).
3. Watchside's sessions are long-lived and auto-refreshed on a `chrome.alarms`
   schedule. **A JOIN happens hours or days after sign-in**, by which time the
   provider token is long gone and cannot be re-obtained.
4. Supabase's own guidance for calling a provider API later is to *"use the
   provider refresh token to obtain a new provider token"* and to send it *"to a
   trusted and secure server you control."* **That is provider-token custody.**

There is no fifth option. Every alternative was evaluated and each either
requires custody, produces a **biased** denominator, or destroys the JOIN flow
(§13.3).

### The correction that matters

**My own earlier reports were wrong on this point, and the error is exactly the
kind that only surfaces at implementation.**

- M3B §26.3 stated the baseline check needs *"no token custody — token is in
  hand in-session."*
- The M3D/M3E policy report §7.3 repeated it: *"the check happens at the JOIN,
  in-session, while a provider token is already in hand."*

Both conflated **"inside the Supabase session"** (long-lived, refreshed
indefinitely) with **"the provider token is still present"** (emitted once, never
refreshed, discarded on the first token refresh). They are not the same thing,
and the difference is the whole feasibility of M3D.

I am recording this plainly rather than quietly re-scoping around it. The
"cheap, custody-free baseline" that made M3D look like the easy half of v0.8 was
not real.

### Two further findings

- **G6's third trigger has nothing to hook into.** Watchside has **no
  account-deletion surface at all** — no UI, no RPC, no migration function. The
  policy report's *"do not weaken existing account-deletion semantics"* has no
  referent: there are none to preserve beyond a foreign-key cascade that fires
  only if somebody deletes a row by hand (§9).
- **G6 itself should not be built yet, and that is a considered position rather
  than caution.** If the owner authorises custody, revocation must also destroy
  the custodied refresh token — a materially different G6 with a second deletion
  target and a token-shredding obligation. **Building G6 now would build the
  wrong G6** (§6.4).

### What is not blocked

Twitch's revocation signal is viable and was verified: `user.authorization.revoke`
is created with an **app access token** conditioned on `client_id` — no user
token, no scope (§5). And **no EventSub event reports scope reduction** distinct
from full revocation, confirming the policy report's caution (§8).

**Owner decision required before any M3D work resumes** (§36).

---

## 2. Starting state

| | |
|---|---|
| Watchside HEAD | `ec8a28c` |
| Pages HEAD | `152e4ac` |
| Working trees | clean |
| Version | `0.7.0` |
| Hosted analytics schema | **31** |
| Migration `0032` | free — **not used** |
| Chrome | v0.7.0 submitted; publication state not assumed |
| Firefox | v0.7 artifact prepared, **not submitted**; **v0.6 still in initial AMO review — untouched** |

Release-state discipline is unchanged: development HEAD ≠ release candidate ≠
packaged ≠ submitted ≠ published ≠ installed.

---

## 3. Existing auth and token architecture

Inspected before designing anything, as the brief requires.

### 3.1 What Watchside does today

| Fact | Evidence |
|---|---|
| OAuth via Supabase, **no scopes requested** | `supabaseBackend.ts:120` — no `scopes` key |
| PKCE flow; the extension holds no client secret | `createSupabaseClient`, `flowType: 'pkce'` |
| Sessions persisted to `chrome.storage.local` | `persistSession: true` + `createExtensionStorage` |
| Refresh driven by `chrome.alarms`, not by supabase-js | `autoRefreshToken: false` |
| **Nothing touches `provider_token`** | grep across `src/` and `supabase/`: **zero** hits |
| The session is narrowed at the boundary | `toSession()` returns `{ expiresAt }` only — everything else is discarded |
| `onAuthStateChange` is **not used** | grep: **zero** hits |

That last pair is the crux. `exchangeCodeForSession` returns a session object
that may carry `provider_token`, and Watchside **immediately discards everything
except the expiry**. The one-shot emission supabase-js documents is never
observed, by design.

### 3.2 What Supabase actually guarantees

**Source:** Supabase Auth — *Social Login*,
`https://supabase.com/docs/guides/auth/social-login`, checked 2026-08-30, page
loaded. **Confidence: HIGH.**

> **"Supabase Auth does not manage refreshing the provider token for the user."**

> **"Your application will need to use the provider refresh token to obtain a new
> provider token."**

> **"Provider tokens are intentionally not stored in your project's database."**

> If the token is needed outside the initial browser session, send it *"to a
> trusted and secure server you control."*

Corroborated by supabase-js's own source
(`@supabase/auth-js` `GoTrueClient.js`, JSDoc on `onAuthStateChange`):

> *"This callback will listen for the presence of `provider_token` and
> `provider_refresh_token` properties on the `session` object … The client
> library will emit these values **only once** immediately after the user signs
> in."*

And the refresh path carries no provider fields — verified by inspecting
`_saveSession` and the refresh routines: **no `provider_` reference anywhere in
the refresh path.**

### 3.3 The consequence

**At JOIN time there is no Twitch user token, and no way to obtain one without
custody.**

Watchside's session survives indefinitely via refresh. The Twitch provider token
does not survive the first refresh and is never reissued. A JOIN at 9pm on a
session established at 2pm has no token available, and asking Supabase for one
is not a thing that exists.

---

## 4. Twitch API verification — Get Followed Channels

**Source:** `dev.twitch.tv/docs/api/reference/#get-followed-channels`, checked
2026-08-30. **Confidence: HIGH** — extraction consistent with the M3B result and
with the scopes page.

| Property | Value |
|---|---|
| Authorization | *"Requires a user access token that includes the `user:read:follows` scope."* |
| Token type | **User access token only** |
| App-token path | **None** — confirmed again |
| Scope | `user:read:follows` |
| `user_id` | required — the authenticated user |
| `broadcaster_id` | **optional filter to a single channel** |
| Response when following | one entry: broadcaster id/login/name + follow timestamp |
| Response when not following | **empty `data` array** |

The `broadcaster_id`-filtered form is exactly the minimal query M3D wants: it
answers *"does this viewer follow this one creator"* **without ever retrieving
the follow list**. That design remains correct — it is simply unreachable
without a user token.

**Nothing about Twitch blocks M3D.** The endpoint, the filter and the scope are
all as designed.

---

## 5. Twitch EventSub verification — `user.authorization.revoke`

**Source:** `dev.twitch.tv/docs/eventsub/eventsub-reference/`, checked
2026-08-30.

| Property | Finding | Confidence |
|---|---|---|
| Event exists | ✅ `user.authorization.revoke` | High |
| Trigger | a user revokes authorization for your application | High |
| Condition | `client_id` — *"Your application's client id. The provided `client_id` must match the client id in the application access token."* | High |
| Token to subscribe | **application access token** | High |
| Scope to subscribe | none indicated | Medium |
| Payload fields | **not rendered** by the fetch | ⚠️ unverified |
| Companion | `user.authorization.grant` exists, same model | High |

**This is good news for G6 and it is worth stating clearly:** revocation
detection needs **only an app access token**, which Watchside already mints for
`twitch-metadata`. No user token, no custody, no polling. The mechanism the
policy report assumed is real.

**What remains unverified** is the exact payload — specifically whether it
carries `user_id`, which G6 needs in order to know *whose* observations to
delete. The reference page did not render payload tables. This is a
implementation-detail unknown, not a viability unknown (§35 U3).

---

## 6. G6 architecture

### 6.1 The boundary, unchanged and still correct

The hybrid split established in the policy report survives this checkpoint
intact, and §4's confirmation strengthens it:

| Layer | Twitch-derived? | Deleted on revocation |
|---|---|---|
| Gravity impression, JOIN, arrival, attribution, dwell, shared watch, experiment arm | ❌ Watchside's own observation | ❌ retained |
| `following_at_join` | ✅ from Get Followed Channels | ✅ deleted |

### 6.2 The design that was ready

Keys: `actor_id` (deletion + ownership, always `auth.uid()` server-side).
Triggers: Twitch revocation · scope reduction · account deletion. **Sign-out
deletes nothing.** Deletion idempotent, signature-verified, replay-guarded,
logged without relationship content.

### 6.3 Why it was not built

Two reasons, and the second is the stronger.

**First:** the brief sequences G6 *before* the first relationship write. With no
relationship write possible (§1), G6 protects nothing. An empty deletion path
whose behaviour nobody can exercise is a structure whose correctness cannot be
checked — the same argument I made against premature construction in the
M3A/M3C report §13.4, and it applies here with more force.

**Second, and decisive:**

### 6.4 If custody is authorised, G6 changes shape

Should the owner authorise provider-token custody, revocation acquires a
**second deletion target and a stricter obligation**:

| | G6 as designed (no custody) | G6 with custody |
|---|---|---|
| Delete on revoke | relationship observations | observations **+ the stored refresh token** |
| Failure mode if incomplete | stale relationship data | **a live credential retained after the user revoked it** |
| Storage security | ordinary row-level protection | encryption at rest, key management, access audit |
| Deletion urgency | "upon", per the DSA | immediate — it is a credential |
| Test surface | deletion correctness | deletion correctness **+ proof the token is unrecoverable** |

**Building the no-custody G6 now would build the wrong G6.** The token-bearing
version is not an extension of it; it is a different security posture with a
different threat model. That is why this checkpoint stops rather than delivering
half the boundary.

---

## 7. De-authorization semantics

Design, carried forward for whichever path the owner chooses.

| Trigger | Detection | Deletes |
|---|---|---|
| Twitch revocation | EventSub `user.authorization.revoke` (§5) | relationship observations for that actor (+ custodied token, if custody exists) |
| Scope reduction | **no direct signal** — see §8 | conservatively, the same |
| Watchside account deletion | **no path exists today** — see §9 | — |
| **Watchside sign-out** | — | ❌ **nothing** |

Sign-out is not de-authorization: the Twitch grant still stands, and deleting an
H2 baseline the user never asked to remove would be both wrong and
unrecoverable.

Delivery realities the design accounts for: duplicate delivery, retries,
out-of-order arrival, already-deleted rows, unknown user, forged requests
(Twitch signature verification), replay. **Deletion is idempotent** — a repeated
valid revoke succeeds harmlessly.

---

## 8. Scope-reduction semantics

**Verified: no EventSub event reports a reduction in granted scopes as distinct
from full revocation.** The reference documents only `user.authorization.grant`
and `user.authorization.revoke`.

This confirms the policy report's caution and means scope reduction must be
handled by inference, not notification:

1. **Detect at use.** A `401`/`403` from Get Followed Channels with an
   otherwise-valid token indicates the scope is gone → treat as revocation for
   the relationship data and stop observing.
2. **Detect at re-authorization.** Compare granted scopes against expected on
   each new grant.
3. **No invented event.** Twitch does not provide one and none will be
   simulated.

**Documented limitation:** between a silent scope reduction and the next
observation attempt, Watchside cannot know the scope is gone. The window is
bounded by the next JOIN, not by a timer. Recorded rather than papered over.

---

## 9. Account-deletion interaction

**Finding: Watchside has no account-deletion surface at all.**

Searched `src/ui/`, `src/client/` and every migration for a delete-account UI,
RPC or function: **none exists**.

What does exist: **24 tables** carry
`references public.users (id) on delete cascade`, including
`analytics_events.actor_id` (`0013_analytics.sql:178`). So *if* a `public.users`
row were deleted — by the owner, directly against the database — everything
cascades, including the analytics event log.

**Consequences:**

- The policy report's instruction *"do not weaken or broaden existing account
  deletion semantics"* has **no referent to preserve**. There are no
  product-level semantics; there is a foreign-key cascade and no way for a user
  to trigger it.
- G6's third trigger has **nothing to hook into**. A relationship-observation
  table would simply join the 24 cascading tables, which is correct and free —
  but it does not constitute an account-deletion *path*.
- **This is a real gap, and it is larger than G6.** A product approaching public
  launch with no way for a user to delete their account is a problem for GDPR/CCPA
  posture independent of anything Twitch requires. **Flagged for the owner
  (§36 O4)** and recommended as **M5** scope, not something to bolt on here.

---

## 10. Sign-out semantics

**Sign-out must delete nothing**, and the distinction is load-bearing:

| | Sign-out | De-authorization |
|---|---|---|
| What ends | the Supabase session | the Twitch grant |
| Twitch authorization | **still stands** | withdrawn |
| DSA trigger | ❌ none | ✅ triggered |
| Relationship observations | **retained** | deleted |

Conflating them would delete an H2 baseline on an ordinary session end — data
that cannot be reconstructed, in response to something the user did not ask for.

---

## 11. Relationship observation schema

Designed, **not created**. No migration was written; `0032` remains free.

The minimum, carried from the policy report §19 and unchanged by this
checkpoint:

| Column | Justification |
|---|---|
| `actor_id` | deletion key, ownership, join to the funnel |
| `broadcaster_login` | the creator; joins to `destination_channel` |
| `attribution_id` | ties the observation to the JOIN that occasioned it (nullable) |
| `observed_at` | ordering, window arithmetic, "at JOIN" vs later |
| `relationship_type` | `follow` — extensible, but **only `follow` collected** |
| `relationship_present` | **the datum**; nullable, so a failed check is *absent* not false |

Six columns. `relationship_present` nullable is the mechanism that keeps API
failure from becoming `false` (§13.4).

---

## 12. Minimal-data justification

Every rejected field, with the requirement it fails:

| Rejected | Claim it would serve | Verdict |
|---|---|---|
| raw API response | none | ❌ maximises deletion surface, minimises clarity |
| `followed_at` timestamp | the boolean answers the claim | ❌ more Twitch data for no additional claim |
| follow list / other creators | none — we ask about one creator | ❌ never fetch the list |
| creator metadata | already available elsewhere | ❌ duplication |
| provider access token | none | ❌ custody |
| provider refresh token | none *without custody* | ❌ **the STOP** |
| subscription state / tier / `is_gift` / gifter | **M3E-a, not this checkpoint** | ❌ out of scope |
| payment information | none, ever | ❌ |

---

## 13. M3D baseline timing — where it breaks

### 13.1 The requirement

The baseline must represent follow state **at the socially initiated JOIN**. The
brief is explicit that a later check cannot reconstruct it across
follow → unfollow → refollow, and that is right: `followed_at` reports only the
*current* follow's origin, so churn is invisible.

### 13.2 Why the requirement cannot be met

The check must happen within seconds of the JOIN. At that moment Watchside holds
no Twitch user token and cannot obtain one (§3.3).

### 13.3 Every alternative, evaluated

| Alternative | Verdict |
|---|---|
| **Use the token at JOIN, in-session** | ❌ **The token is not there.** This was the assumption in M3B §26.3 and it was wrong |
| **Check at sign-in instead** | ❌ Not baseline-at-JOIN — and the destination is unknown at sign-in, so it would require fetching the **follow list**, which §12 forbids |
| **Only capture when a fresh token happens to exist** | ❌ Coverage tiny and **biased**: JOINs shortly after sign-in differ systematically from later JOINs. A biased denominator is worse than none |
| **Hold the token in the extension for its ~4h life** | ❌ Custody, in the worst place. The policy report §7.4 requires the token *"never sent to the extension"* |
| **App access token** | ❌ No app path exists (§4) |
| **Re-authorize at JOIN** | ❌ A Twitch consent window mid-JOIN. Destroys the flow |
| **Server-side refresh-token custody** | ⚠️ **Works — and is exactly what the brief forbids.** This is M3E-b architecture |

**There is no custody-free path.** The STOP is genuine.

### 13.4 The rule that survives regardless

**API failure must never become `false`.** With `relationship_present` nullable,
a failed check writes nothing — the JOIN simply has no eligible observation and
falls out of the denominator (§21). This was designed and remains correct
whenever M3D proceeds.

---

## 14. Eligible JOIN population

Designed and unchanged: **only socially attributed JOINs**, identified by the
existing `attribution_id` / `opportunity_key` architecture. No parallel
attribution system, and **no follow lookup for arbitrary Twitch navigation** —
that constraint is what keeps the honest sentence *"Watchside checks your
relationship with the channel your friends are watching"* rather than
*"Watchside tracks who you follow."*

---

## 15. Repeat and idempotency semantics

Designed: **one observation per `attribution_id`**. A repeated JOIN inside the
same attribution reuses it; a **new** opportunity to the same creator is a new
observation with its own `observed_at`. Concurrent destinations each get their
own, keyed by creator. Failure does not write, so a retry is a first attempt.

This ties idempotency to existing attribution semantics rather than inventing a
cache — which is what keeps baseline timing accurate.

---

## 16. OAuth scope change

**No scope was requested, and no OAuth code was changed.**

When M3D proceeds it needs exactly **`user:read:follows`** — one scope, nothing
else. `user:read:subscriptions` is **not** requested here and is not present
anywhere in the tree.

The brief accepts a second consent event later if M3E-a is approved, and that
remains the right trade: D8's Mozilla ambiguity is more important than
consent-event count.

---

## 17. Existing-user authorization UX

Designed, not built. The transition matters and was thought through:

| Question | Intended answer |
|---|---|
| Existing v0.7 user upgrades to v0.8 | Keeps working. Their grant lacks `user:read:follows`; M3D is simply unavailable for them |
| When is the new authorization requested | At a natural moment tied to the account surface — **never mid-JOIN** |
| How is it explained | Plainly: *what* is checked, *when*, and that no follow list is downloaded (policy report §20.1) |
| If declined | Core Watchside continues unchanged. Measurement coverage is explicit, not coercive |
| Nagging | Asked **once**; a decline is remembered and not re-prompted per session |

---

## 18. Permission-denial behavior

**Core Watchside must continue to work without `user:read:follows`**, and the
architecture makes that structural rather than conditional: the follow check is
an *observation*, never a precondition for JOIN, presence, Gravity, dwell,
rooms, or anything a person can see. A user who declines loses one row in a
measurement table and nothing else.

---

## 19. Twitch token handling

**No token handling was implemented, and none exists in the tree.**

The standing rules, unchanged: no access-token vault, no refresh-token vault, no
token in analytics or relationship tables, never logged, never sent to the
extension, never exposed to another user.

**§3.3 is precisely the collision between those rules and the M3D requirement.**
Honouring them makes baseline-at-JOIN impossible; achieving baseline-at-JOIN
requires breaking them. That is the decision the owner now holds (§36 O1).

---

## 20. Analytics model

Designed, not created. Two views would answer the brief's four questions:

- eligible observation count per JOIN cohort;
- `following_at_join` true/false split;
- discovery percentage over the **retained eligible** population;
- joins to opportunity/Gravity exposure, arrival, dwell, repeat-creator viewing
  and experiment arm via existing keys.

**Not built**, because they would compute over a table that does not exist.

---

## 21. Relationship denominator semantics

The rule, recorded so it is not lost:

> **Denominator = socially initiated JOINs with a currently retained eligible
> follow-baseline observation.** Never "all JOINs."

A JOIN whose check failed, whose user lacked the scope, or whose observation was
later deleted **is not in the denominator**. Reporting discovery percentage over
all JOINs would silently treat missing observations as "already following",
which is both wrong and flattering — the worst combination.

---

## 22. Deletion and recomputation behavior

Conservative, per D7's unresolved aggregate question:

- Relationship metrics **recompute from currently retained observations**.
- A deleted observation **ceases to contribute**, automatically, because the
  views read the table rather than a frozen rollup.
- **No irreversible aggregate** preserves a deleted relationship fact.
- Watchside-owned metrics remain independently available and unaffected.

---

## 23. Security and RLS

Designed to the existing analytics model: least privilege; no cross-user reads;
no client writes; server-controlled insertion and deletion; ownership always
`auth.uid()`; views revoked from `anon` and `authenticated`.

**`verify:analytics` continues to prove analytical views are not
client-readable** — re-run this checkpoint and passing (§31).

---

## 24. Firefox classification

**Unchanged, and unchangeable by this checkpoint since nothing shipped.**

Declared categories remain exactly `authenticationInfo`, `browsingActivity`,
`personalCommunications`, `websiteActivity`. No `financialAndPaymentInfo`.
Firefox still collects **zero** `technicalAndInteraction`.

The policy report's verdict stands: `following_at_join` needs **no new
category** — a follow is a free, public relationship, not payment data.

---

## 25. Chrome Store implications

**No Store listing was touched.**

For a future v0.8 carrying M3D, the privacy-practices answers would need to
disclose that Watchside reads a relationship from a third-party account
(Twitch) — specifically under *"Personally identifiable information"* /
*"User activity"*, depending on Google's current phrasing at submission time.
The **permissions** and the extension ID are unaffected; M3D adds no host
permission and no manifest permission.

Since M3D is halted, **no Store-answer change is required for any release
currently contemplated.**

---

## 26. Privacy disclosure

**Not changed, and deliberately so.**

`docs/PRIVACY.md` and the published page describe what Watchside *does*. M3D
does nothing yet. Documenting a follow check that does not happen would be a
false disclosure in the other direction — the same error the M3C.1 checkpoint
caught when the page still claimed background tabs recorded nothing.

The M3C.1 dwell disclosure is **preserved unchanged** and was re-verified live
(§31).

The wording drafted in the policy report §20.1 remains ready for the release
that actually ships M3D.

---

## 27. Migration

**None written.** `0032` remains free. `0031` and all older migrations are
untouched.

---

## 28. Hosted state

**Untouched.** No migration was written or applied, no dry-run was needed and no
history was repaired, so the hosted marker necessarily remains **31** — the value
confirmed at the M3A/M3C checkpoint. `verify:analytics` was re-run here and
confirms the schema is intact and that **nothing in it is client-readable**; it
reports relation presence rather than the marker value, so 31 is carried by the
absence of any applied migration rather than by a fresh read (§31).

---

## 29. Deterministic test proofs

**None added** — there is no implementation to prove.

The thirty proofs the brief specifies remain the correct acceptance criteria for
whichever path the owner chooses. Nine of them (G6 items 1–10) are written
against a deletion path whose shape depends on the custody decision (§6.4), so
writing them now would encode the wrong contract.

The existing suite was re-run in full as a regression check (§31).

---

## 30. Mutation proofs

**None added**, for the same reason. The load-bearing invariants that would need
mutation coverage — *sign-out deletes nothing*, *API failure never becomes
false*, *deletion is idempotent*, *observations do not cross-contaminate* — are
all properties of code that does not exist.

The existing mutation harnesses were re-measured (§32).

---

## 31. Regression results

Nothing in the tree changed, and the suite confirms it.

| Gate | Result |
|---|---|
| `npm test` | ✅ **2,393 passed** (94 files) |
| `npm run lint` | ✅ clean |
| `npx tsc -b --force` | ✅ clean |
| `npm run build` | ✅ clean |
| `npm run verify:analytics` | ✅ 19 relations present (14 views), **none client-readable** |
| `npm run verify:store` | ✅ repository agrees with itself |
| `npm run verify:firefox` | ✅ repository agrees with itself |
| Live privacy page | ✅ M3C.1 dwell disclosure intact; no follow/subscription language |

---

## 32. Known-debt delta

| Harness | v0.7 baseline | Now | Delta |
|---|---|---|---|
| `test:analytics` | 18 / 87 | **18 / 87** | ✅ none |
| `test:presence` | 4 / 21 | **4 / 21** | ✅ none |
| `test:layout` | 5 / 23 | **5 / 23** | ✅ none |
| `verify:lab` | 11 failures | **11** | ✅ none |
| `test:authz` | 18 / 18, exit 0 | not re-run — no schema or authorization change | n/a |

**No baseline worsened.** No debt reopened.

---

## 33. v0.8 readiness

**v0.8 is not ready and its content is now an open question.**

| Intended v0.8 content | State |
|---|---|
| G6 deletion architecture | **blocked** on the custody decision (§6.4) |
| M3D `following_at_join` | **blocked** — STOP (§1) |
| M3E-a `subscribed_at_join` | **HOLD** — D8 unresolved, and unchanged by this checkpoint |
| One Twitch OAuth consent change | **not made** |

Version was **not** bumped. Nothing was packaged. Chrome v0.7 submission and
Firefox v0.6 review are independent and untouched.

---

## 34. M3E-a boundary

**Fully respected.** No `subscribed_at_join`, no `user:read:subscriptions`, no
subscription state, tier, `is_gift`, gifter identity or payment data anywhere in
the tree — verified by grep across `src/` and `supabase/`.

D8 remains unresolved. If Mozilla eventually requires `financialAndPaymentInfo`,
that is a separate product and release decision.

Note that the STOP in §1 **applies equally to M3E-a**: subscription state is
checked with `Check User Subscription`, which also requires a viewer user token.
**Any Twitch relationship baseline — follow or subscription — hits the same
custody wall.** That is worth knowing before the D8 answer arrives, because it
means D8 is no longer the only thing gating M3E-a.

---

## 35. Remaining unknowns

| # | Unknown | Impact | How it closes |
|---|---|---|---|
| **U1** | Whether Twitch returns a `provider_refresh_token` through Supabase's flow at all | If **not**, custody would not rescue M3D either — it would be infeasible outright, not merely gated | One sign-in with logging of key *presence* (never values) |
| **U2** | Whether Twitch's refresh token is single-use/rotating | Determines custody complexity if authorised | Twitch OAuth docs at implementation |
| **U3** | `user.authorization.revoke` payload fields — notably whether `user_id` is present | G6 needs to know *whose* data to delete | Reference page did not render; one subscription at implementation |
| **U4** | Whether Supabase Edge Functions can receive Twitch EventSub webhooks with signature verification | G6 transport | Straightforward, but unverified here |
| **U5** | D7 counsel read; D8 AMO answer | Both still open from the policy checkpoint | Owner actions |

**U1 is the one to close first.** It determines whether the owner's decision is
*"authorise custody or defer M3D"* or *"M3D is infeasible on this stack."*

---

## 36. Owner decisions

| # | Decision | Recommendation |
|---|---|---|
| **O1** | **Authorise server-side provider-refresh-token custody for M3D?** This is the whole gate. It means an encrypted token store, refresh against `id.twitch.tv`, and a G6 that shreds the token on revocation | ⚠️ **Genuine trade, and it is the owner's.** It is the only path to a correct, unbiased baseline — and it is exactly the M3E-b architecture previously deferred *indefinitely*. Deferring M3D is legitimate; building custody quietly is not |
| **O2** | If O1 is no: **defer M3D**, keep v0.8 as a non-relationship release, and revisit when the ladder needs L4 | ✅ Reasonable. Watchside's L1–L3 and L7–L8 evidence is unaffected and remains its strongest asset |
| **O3** | Close **U1** before deciding O1 | ✅ **Do this first.** One sign-in tells you whether O1 is even a live option |
| **O4** | 🆕 **Build a user-facing account-deletion path** (§9) | ✅ **Yes, as M5.** Independent of Twitch: a product approaching public launch with no delete-account route is a GDPR/CCPA gap |
| **O5** | Accept that **M3E-a hits the same custody wall** as M3D (§34) | ✅ Note it. D8 is no longer M3E-a's only gate |
| **O6** | Accept the **scope-reduction limitation** — no Twitch event; detected at use or at re-auth (§8) | ✅ Accept and document; nothing better exists |

---

## 37. Final recommendation

## **STOP**

Not because Twitch prevents it — Twitch's endpoint, scope and revocation signal
are all exactly as designed and were re-verified here. **Supabase does.** The
provider token is emitted once at sign-in, never refreshed, and gone long before
any JOIN. Supabase's own documentation says the way to call a provider API later
is to hold the refresh token on a server you control, and that is provider-token
custody — forbidden by this brief and named as a STOP condition.

I stopped before writing code rather than after, and did not build the
half-measures that were available:

- **not** a biased opportunistic baseline that would quietly poison the
  denominator;
- **not** a token cached in the extension, which the policy report explicitly
  forbids;
- **not** an empty G6 whose shape would change the moment custody is authorised
  (§6.4);
- **not** M3E-b architecture built under an M3D label.

The correction in §1 is the part I would most want read: **my own earlier
reports asserted this baseline needed no custody, and that was wrong.** They
conflated the Supabase session with the provider token. The error survived two
research checkpoints because nothing had yet tried to obtain a token at JOIN
time. It cost nothing beyond this checkpoint, because it was caught before the
first write rather than after a release — which is the argument for
implementation checkpoints reading the architecture before trusting the design.

**Nothing was released, packaged, submitted or disturbed.** Chrome v0.7 remains
submitted, Firefox v0.6 remains in review untouched, hosted schema remains 31,
and the working tree carries only this report and the roadmap line it justifies.

**Next step: close U1 (§35), then decide O1 (§36).**

---

# O3 — Twitch refresh-token feasibility check

**Date:** 2026-08-31
**Type:** NARROW INVESTIGATION checkpoint — one fact, proven against the real flow
**Outcome:** **A — REFRESH TOKEN AVAILABLE**

> This section **reverses the feasibility half** of the STOP recorded above, and
> **confirms its architectural half**. `provider_refresh_token` is real, non-null
> and delivered by the actual Watchside flow. M3D is therefore *technically*
> feasible — but only via server-side Twitch credential custody, exactly as §1
> concluded. The STOP stands as an **owner decision**, not as an impossibility.

---

## 38. Live-flow test method

The brief required proof against the actual Watchside flow rather than inference
from generic Supabase documentation. Three earlier verification paths were
rejected as insufficient or unsafe before landing on this one:

| Path considered | Why it was not used |
|---|---|
| Generic Supabase docs | Explicitly disallowed by the brief, and they do not describe Twitch specifically |
| Reading Chrome's `Local Extension Settings` | Blocked by the sandbox as credential-storage access. Not worked around. Also **inconclusive by design**: sessions refresh roughly hourly and refresh wipes the fields, so ABSENT would prove nothing |
| Inferring from GoTrue source alone | Strong, but still not the real flow — Twitch is configured per-project, and GoTrue emits the refresh token *conditionally* (§42) |

### What was actually done

A **temporary, shape-only diagnostic** was compiled into the extension, exercised
by one real Twitch sign-in performed by the owner, and then removed.

The diagnostic reported, for each key, exactly one of:

- `ABSENT (key not present)`
- `PRESENT but null/undefined`
- `PRESENT, non-null <type>, length=<n>`

**No credential material was printed, stored, transmitted or committed.** Length
is the only quantitative fact captured, which the brief permits as safe metadata.
This mirrors an idiom the codebase already uses — `index.ts:136` logs the
Supabase publishable-key *length* and never the key.

Probe points, all in the real auth path:

| Probe | Location | Question it answers |
|---|---|---|
| `exchangeCode` | `supabaseBackend.ts` → called from `auth.ts:226` | What the **sign-in exchange** returns |
| `getSession` | `supabaseBackend.ts` | What is **persisted at rest** |
| `refreshSession` | `supabaseBackend.ts` | What **survives a refresh** |
| build marker | `index.ts` worker start | Proof the diagnostic build was the one running |

The build marker earned its place. The first attempt produced **no output at
all**, and the log showed realtime connecting and presence writing immediately —
a *restored* session. Reloading an extension rehydrates from storage and never
runs the code exchange, so there was nothing for the probe to observe. The marker
made "wrong bundle loaded" and "no sign-in occurred" distinguishable on the
second attempt.

Flow confirmed as PKCE end to end: `readCallback` takes `code` from the query
string (`auth.ts:77`), and `auth.ts:226` passes it to `exchangeCodeForSession`.

**Environment:** production project, `mode: "production"`. One real
`authenticated_session_started` event was emitted as ordinary product behaviour;
the owner was told to expect it beforehand.

**Removal:** both source files were restored to `HEAD` with `git checkout`, and
removal was verified three ways — no `M3D-O3` in `src/`, `tests/`, `scripts/` or
`supabase/`; **0** occurrences in a freshly rebuilt bundle; `git status` showing
no source modification (§46).

---

## 39. `provider_token` — **PRESENT**

```
[M3D-O3] provider_token: PRESENT, non-null string, length=30
```

Present and non-null on the sign-in exchange. Length 30 is consistent with the
Twitch user-access-token shape in Twitch's own documented example.

---

## 40. `provider_refresh_token` — **PRESENT**

```
[M3D-O3] provider_refresh_token: PRESENT, non-null string, length=50
```

**This is the fact the checkpoint existed to establish.** Present, non-null, and
50 characters — consistent with the refresh token in Twitch's documented example
response.

Full session key set returned by `exchangeCodeForSession`:

```
access_token, expires_at, expires_in, provider_refresh_token,
provider_token, refresh_token, token_type, user
```

Both provider fields are delivered by the real Watchside Twitch + Supabase flow.
**The answer to O3 is yes.**

---

## 41. Survival across refresh — **NO** (and a correction)

### 41.1 It is persisted at rest — which §3.1 understated

A second probe on `getSession()`, after a worker reload, returned:

```
[M3D-O3] PERSISTED(getSession) provider_token: PRESENT, non-null string, length=30
[M3D-O3] PERSISTED(getSession) provider_refresh_token: PRESENT, non-null string, length=50
```

**Watchside is currently writing a live Twitch access token and a live Twitch
refresh token to `chrome.storage.local`.** Not deliberately — as a side effect of
`persistSession: true`. supabase-js's `_saveSession` shallow-copies the *entire*
session object and writes it; it does not strip provider fields.

This corrects a statement in §3.1 above. That table said *"Nothing touches
`provider_token`"* and *"the session is narrowed at the boundary — everything
else is discarded."* Both are true of **Watchside's application code**:
`toSession()` really does return only `{ expiresAt }`. But they gave the wrong
impression about **what is on disk**, because the storage write happens inside
supabase-js, below Watchside's boundary. The grep that returned zero hits was
evidence about Watchside's code, not about the storage layer — and I presented it
as though it settled both.

**This is a security finding independent of M3D** and is treated as such in §45.

### 41.2 It does not survive a refresh

**Answer: NO.** Stated precisely: this was **proven by code inspection at three
independent layers, not observed live** — the session did not reach expiry during
the checkpoint, and the honest choice was to prove the mechanism rather than have
the owner sit for an hour waiting for an alarm.

| Layer | Finding |
|---|---|
| `_refreshAccessToken` / `_callRefreshToken` | **Zero** `provider_` references; neither spreads or merges the prior session |
| Whole of `GoTrueClient.js` | **Every** occurrence of `provider_token` is inside JSDoc comments and examples. There is **no functional code** anywhere in auth-js that reads, merges, re-emits or preserves these fields |
| `_saveSession` | Writes `Object.assign({}, session)` — the refreshed session **wholesale replaces** the stored one |

A refreshed session object simply has no provider fields, and it overwrites the
stored blob that did. They are gone at the first refresh and are never reissued.

**What would close the residual gap:** reload the worker after the session's
first refresh and observe the `PERSISTED(getSession)` probe report `ABSENT`.
Given the library contains no code capable of preserving these fields, the
expected result is not in genuine doubt.

### 41.3 The practical window

| Moment | `provider_refresh_token` |
|---|---|
| Sign-in exchange | ✅ present |
| Persisted, before first refresh | ✅ present, **at rest on disk** |
| After first Supabase refresh | ❌ gone, permanently |

**§1's conclusion is unchanged, and now more precisely dated:** the token is
available in a window bounded by the first session refresh, not for the life of
the session. A JOIN occurring after that window has nothing to use. Capturing it
requires taking it **at sign-in**, deliberately — which is custody.

---

## 42. Primary-source explanation

Why the token exists at all, from the actual server code Watchside's project runs.

**Source:** `supabase/auth` (GoTrue), `internal/api/external.go`, checked
2026-08-31. **Confidence: HIGH** — this is the implementation, not documentation.

```go
providerAccessToken := data.token
providerRefreshToken := data.refreshToken
...
q.Set("provider_token", providerAccessToken)
if providerRefreshToken != "" {
    q.Set("provider_refresh_token", providerRefreshToken)
}
```

The emission is **conditional** — GoTrue's own comment says *"Because not all
providers give out a refresh token"*, citing RFC 6749 §5.1. So whether a refresh
token appears is decided entirely by what the provider returns. **This is exactly
why generic Supabase documentation could not have answered O3**, and why the
brief was right to demand the real flow.

**Source:** `supabase/auth`, `internal/api/provider/twitch.go`. Twitch is
configured against `https://id.twitch.tv/oauth2/authorize` and
`https://id.twitch.tv/oauth2/token`, with base scope `user:read:email` and
additional scopes appended. **No offline-access parameter is requested** — none
is needed.

**Source:** Twitch, *Getting OAuth Access Tokens* — Authorization Code Grant
Flow, checked 2026-08-31. The token response contains `access_token`,
`expires_in`, **`refresh_token`**, `scope`, `token_type`.

So Twitch returns a refresh token unconditionally on the authorization-code
grant, GoTrue passes it through because it is non-empty, and the live probe
confirms it arrives. The chain is complete and consistent at every link.

### 42.1 Rotation and refresh semantics — material for custody

**Source:** Twitch, *Refreshing Access Tokens*, checked 2026-08-31.

| Property | Finding | Consequence for custody |
|---|---|---|
| Rotation | *"Because refresh tokens may change, your app should safely store the new refresh token to use the next time."* | Storage must be **read-modify-write**, replacing the stored token on every refresh. A write that loses the rotated token silently orphans the grant |
| `client_secret` | Required unless the app is a Public client type | Refresh **cannot** happen in the extension. It must be server-side, where the secret already lives |
| Expiry | *"refresh tokens generated by a **Public** client type will expire **30 days** after they are generated … Most applications are set to the Confidential client type, of which the refresh tokens do not have an expiration time."* | Watchside's Twitch app is confidential, so a stored refresh token has **no expiration time**. It can still become invalid (§92), but time alone will not retire it — which is *more* dangerous, not less |
| Invalidation | *"Refresh tokens can become invalid if the user changes their password or disconnects your app."* | Refresh failure is a legitimate signal to delete, and is a second detection path for revocation alongside EventSub (§8) |
| Concurrency | One refresh token supports at most 50 concurrent access tokens | Fine at Watchside's scale; relevant only if refresh is parallelised |

Note also, from `supabase/auth` issue #1450 and `supabase/supabase` issue #21490
(both **closed without resolution**): under PKCE, refreshing a provider token
against the provider **requires the client secret**, because GoTrue performed the
original exchange as a confidential client. Third-party reports, so treated as
**corroboration only** — but they agree with Twitch's own documentation above,
which is the authority.

---

## 43. Architecture outcome

## **A — REFRESH TOKEN AVAILABLE**

> M3D is feasible on the current stack **if** the owner authorises secure
> server-side Twitch credential custody.

Stated exactly, so it is not over-read:

- ✅ A refreshable Twitch credential **is** delivered by the real flow.
- ✅ Watchside's backend already holds a Twitch client secret (it mints app
  access tokens for `twitch-metadata`), so it **can** perform the refresh.
- ❌ It is **not** durable on its own — it vanishes at the first session refresh.
- ❌ Therefore it must be **captured at sign-in and stored**, which is custody.

**B and C are excluded.** No auth-flow change is required and no replacement of
the Supabase provider-token model is needed — the credential is already there.
**D is excluded**: the fact was established directly, twice, against the real
flow.

**What has changed since §1:** M3D moves from *"blocked by architecture"* to
*"blocked by a policy decision the owner has not yet made."* That is a materially
better position, and it is the honest reading — but it is **not** approval to
build. The custody prohibition in the G6/M3D brief is untouched by this finding.

---

## 44. If A — the minimum future custody architecture

**Design only. Nothing here was implemented.** These are the requirements custody
would have to satisfy before a single token is stored.

| # | Requirement | Why |
|---|---|---|
| 1 | **Server-only encrypted storage.** Encrypted at rest with a key held outside the table; never in `analytics_events`, never in a relationship table | A Twitch credential is categorically different from an observation |
| 2 | **No client readback, ever.** No RPC, view, or column a client can select. RLS denying all client access, service-role writes only | The extension must never regain the token — §7.4 of the policy report |
| 3 | **Capture at sign-in only.** One deliberate hop at `exchangeCode`, straight to the backend. The token must **stop** being persisted to `chrome.storage.local` (§45) | The current at-rest copy is the largest avoidable exposure |
| 4 | **Rotation handling.** Every refresh replaces the stored token atomically; a failed write must not leave a stale token | Twitch rotates (§42.1); losing the rotation orphans the grant |
| 5 | **Access-token expiry handling.** Access tokens are short-lived and **never stored** — minted on demand, held in memory, discarded | Only the refresh token needs custody |
| 6 | **Twitch revocation deletes it.** EventSub `user.authorization.revoke` (§5) shreds token **and** observations, idempotently | Retaining a credential after revocation is the worst failure mode |
| 7 | **Account deletion deletes it.** Requires an account-deletion path to exist (§45) | Currently there is nothing to hang it on |
| 8 | **Scope loss deletes it.** A `401`/`403` on Get Followed Channels, or a refresh rejection, is treated as revocation | No scope-reduction event exists (§8) |
| 9 | **Redaction discipline.** Never logged, never in error messages, never in analytics, never in a report. Length-only diagnostics, as used here | The pattern this checkpoint followed is the pattern to keep |
| 10 | **Blast-radius isolation.** Separate table, separate key, minimal grants, so compromise of analytics does not yield credentials | Analytics is broadly readable by the owner; credentials must not be |
| 11 | **Deterministic security tests.** Proving: no client path reads it; revocation deletes it; deletion is idempotent; rotation replaces it; failure never writes a partial record; nothing is logged | These are the G6-with-custody proofs, and they do not exist yet |
| 12 | **Incident response.** A compromise means mass Twitch re-authorization and user notification — a materially heavier obligation than any Watchside data alone | Worth weighing **before** accepting custody, not after |

**Consequence for G6, restated:** §6.4 anticipated this and is confirmed. Custody
gives revocation a second target and turns incomplete deletion into *retention of
a live credential*. The token-bearing G6 remains a different security posture, not
an increment on the one designed in §6.2.

---

## 45. Account-deletion roadmap correction

Per the brief, `docs/ROADMAP.md` was updated **narrowly**.

**Change:** account deletion is no longer an M5 UX item. It is a **committed
pre-public hardening requirement, independent of M3D**, placed before public
launch.

**Reason, unchanged from §9:** Watchside holds user-owned persisted data across
24 user-scoped tables and offers **no user-triggerable deletion path** — no UI,
no RPC, no function. The only deletion that exists is a foreign-key cascade that
fires if someone deletes a `public.users` row by hand.

**This checkpoint strengthens the case rather than merely restating it.** §41.1
establishes that Watchside is *also* persisting live third-party credentials to
disk. A product that stores a user's Twitch access and refresh tokens, and offers
that user no way to delete their account, is in a worse position than §9
described — and that remains true whether or not custody is ever authorised.

**Not implemented here.** The brief forbids it and the correction is
documentation-only.

### 45.1 The separate, immediate finding

Independent of M3D and of account deletion, and arguably the most actionable
result of this checkpoint:

> **Watchside persists a live Twitch access token and refresh token to
> `chrome.storage.local` today, unintentionally, on every sign-in.**

It is a side effect of `persistSession: true`, it was never a deliberate product
decision, and it is invisible in Watchside's own source — which is precisely why
§3.1's grep-based reasoning missed it.

**If custody is declined (O1 = no), this should be actively stripped** rather
than left in place: the extension gains nothing from holding a credential it
never uses, and the token is confidential-client issued, so it does not
self-expire (§42.1).

**If custody is approved (O1 = yes), it must still be stripped from the extension
and moved server-side** — requirement 3 in §44.

Either way this wants fixing, which makes it the one item here that is **not**
gated on the custody decision. Flagged as **O7**.

---

## 46. Verification — no residue, no secrets

| Check | Result |
|---|---|
| `M3D-O3` in `src/`, `tests/`, `scripts/`, `supabase/` | ✅ **none** |
| `M3D-O3` in rebuilt bundle | ✅ **0** occurrences |
| Product code changed | ✅ **none** — both files restored to `HEAD` via `git checkout` |
| OAuth scopes changed | ✅ none — still no `scopes` key |
| Schema / migration | ✅ none — `0032` still free, hosted marker still 31 |
| Manifest / package / version | ✅ untouched, still `0.7.0` |
| Credential material in report, logs or commits | ✅ **none** — only PRESENT/ABSENT, type and length |
| Chrome v0.7 submission, Firefox v0.6 review | ✅ untouched |

Token **values** were never read by any tool at any point. The blocked attempt to
inspect Chrome's credential storage was abandoned rather than circumvented.

---

## 47. Owner decision now required

| # | Decision | Status |
|---|---|---|
| **O1** | **Authorise secure server-side Twitch credential custody for M3D?** | **Now a live, informed choice.** O3 is closed: the credential exists and the backend can refresh it. What remains is whether Watchside should hold Twitch credentials at all — §44 lists the twelve requirements that answer would commit you to, and item 12 (incident response) is the one most worth weighing first |
| **O2** | If O1 is no: defer M3D; v0.8 ships without relationship measurement | Unchanged and still legitimate. L1–L3 and L7–L8 evidence is unaffected |
| **O3** | ~~Establish whether a refreshable credential exists~~ | ✅ **CLOSED — outcome A** |
| **O4** | Account deletion as a committed pre-public hardening item | ✅ **Roadmap corrected.** Implementation still pending |
| **O5** | M3E-a hits the same custody wall as M3D | Unchanged — and now the wall is known to be surmountable, so D8 returns to being M3E-a's binding constraint |
| **O6** | Accept the scope-reduction limitation (§8) | Unchanged. §42.1 adds a second detection path: refresh rejection |
| **O7** | 🆕 **Stop persisting Twitch tokens to `chrome.storage.local`** (§45.1) | **Not gated on O1.** Wants fixing under either answer |

**Recommended order:** O7 first — it is small, independent of the custody
question, and reduces exposure that exists right now. Then O1, which is a policy
judgement rather than a technical one, and no longer needs any further
investigation to make.

---

# O7 — Client credential stripping + line-ending determinism

**Date:** 2026-08-31
**Type:** NARROW IMPLEMENTATION checkpoint
**Commit:** `6740af4`
**Outcome:** **O7 CLOSED.** Twitch credentials no longer reach the disk. Line
endings are pinned, and doing so retired 21 items of known debt that were never
real.

---

## 48. O7 — the exact cause

Signing in to Watchside returns a session carrying **four** tokens, and they
belong to two different parties:

| Token | Whose | What it does |
|---|---|---|
| `access_token` | **Supabase** | authenticates Watchside's own API calls |
| `refresh_token` | **Supabase** | keeps somebody signed in |
| `provider_token` | **Twitch** | nothing — Watchside has never used it |
| `provider_refresh_token` | **Twitch** | nothing — Watchside has never used it |

Watchside's application code discards the Twitch pair the instant it arrives:
`toSession()` returns `{ expiresAt }` and nothing else. Every product surface
downstream sees only an expiry.

**They reached `chrome.storage.local` anyway**, through a seam below Watchside's
own boundary:

1. `persistSession: true` tells supabase-js to persist the session.
2. `_saveSession` shallow-copies the **entire** session object — it has no
   concept of a provider field and strips nothing.
3. It serialises that whole object: `storage.setItem(key, JSON.stringify(data))`.
4. `createExtensionStorage.setItem` wrote **whatever string it was handed**.

So a live Twitch access token and a live Twitch refresh token were written to
disk on every sign-in, for a credential the product neither requested nor read.

### 48.1 Why it went unseen for so long

This is the part worth keeping, because a test was actively asserting the
opposite.

`bundle.test.ts` contained a check named *"reads no provider token in
Watchside's own code"*, which walked every `.ts`/`.tsx` file under `src/` and
asserted none contained the string `provider_token`. Its comment read:

> *"What matters is that we never touch it."*

**That test passed for the entire time the credential was being persisted.** It
was accurate and irrelevant at the same time: nothing in Watchside *was*
touching the token, and it was stored regardless, because the write happened
inside a dependency. §3.1 of this report repeated the same reasoning from the
same grep and reached the same false comfort.

A grep that finds nothing is evidence about **naming**, not about **behaviour**.
Only a real sign-in (§41.1) showed what was actually on disk.

---

## 49. The sanitisation boundary

**`createExtensionStorage` in `src/background/storage.ts`** — the single
`KeyValueStorage` adapter handed to `createSupabaseClient`.

This is the narrowest point that is also complete: it is the one seam every
supabase-js session write passes through, and it sits *before* the write rather
than after it. Requirement 10 of the brief — prevent persistence rather than
delete afterwards — is satisfied literally: **the credential is never written.**

Establishing that it really is the only writer took more than reading the
adapter, given §48.1:

| Question | Answer |
|---|---|
| Is a second Supabase storage configured? | No — `userStorage` is never set; the client takes exactly one `storage` |
| How many Supabase clients exist? | One, `index.ts:154`, constructed with the sanitising adapter |
| Does anything else write session data? | No. The raw `AsyncStorageArea` is also used by `attention.ts`, `groups.ts`, `preferences.ts` and a channel-name cache — none of which ever receive a session |
| Could a future file reintroduce it? | Only by changing a test that names the one permitted file (§52) |

### 49.1 Fields removed, fields retained

| Field | Persisted? |
|---|---|
| `provider_token` | ❌ **removed** |
| `provider_refresh_token` | ❌ **removed** |
| `access_token` | ✅ retained |
| `refresh_token` | ✅ retained |
| `expires_at`, `expires_in`, `token_type`, `user` | ✅ retained |

Exactly two keys are ever deleted, matched by exact name. The sanitiser walks
nested structures — supabase-js has changed its persisted shape before, and a
sanitiser pinned to one layout would fail silently and unobservably the next
time it changes — but it can never touch a Supabase token no matter how deep it
recurses, because it only ever removes those two names.

Anything that is not JSON passes through untouched; a value with nothing to
strip is returned **by identity**, so ordinary writes keep their exact bytes.

### 49.2 The direction that would have been worse

`refresh_token` and `provider_refresh_token` differ by a prefix. A substring or
regex sanitiser would take both and **sign every Watchside user out
permanently**. That failure is louder than the one being fixed but far more
damaging, so it is covered by its own test asserting the surviving Supabase
values, not merely the surviving key names.

### 49.3 Somebody who signed in before this shipped

Stripping on write does nothing about a credential already on disk. Reading is
the first opportunity to remove it, so `getItem` sanitises what it returns and
rewrites storage when the stored copy was dirty.

A failed purge is swallowed: a cleanup that cannot be written must never become
a failure to read the session, which would lock somebody out of Watchside over
housekeeping. The credential is then removed on the next write instead.

---

## 50. Authentication behaviour — unchanged

| Requirement | Result |
|---|---|
| Supabase auth persistence keeps working | ✅ `persistSession: true` untouched |
| Browser restart does not sign anybody out | ✅ the Supabase tokens are still written and restored |
| OAuth callback still works | ✅ untouched; PKCE `code` → `exchangeCodeForSession` |
| Sign-out still works | ✅ `removeItem` unchanged |
| Session refresh still works | ✅ a refreshed session round-trips **byte-identical** |
| Anything disabled to achieve this | ❌ **nothing** |

No Supabase option changed. `persistSession`, `autoRefreshToken`, `flowType` and
`detectSessionInUrl` are exactly as they were. The change is confined to what
the adapter writes.

---

## 51. Chrome and Firefox

**No divergence, and none was possible.** Chromium and Gecko each supply an
`AsyncStorageArea` (`chrome.storage.local` / `browser.storage.local`) with the
same three methods, and both are wrapped by the same `createExtensionStorage`.

The sanitiser therefore sits **above** the browser split, so neither platform can
opt out of it and no `IS_GECKO` branch was needed. Watchside's two genuine
product differences are untouched.

---

## 52. Deterministic proofs

`tests/extension/providerCredentialStripping.test.ts` — **16 tests**, covering
every proof the brief enumerated:

| # | Proof | Test |
|---|---|---|
| 1 | `provider_token` not persisted | strips it on the way in |
| 2 | `provider_refresh_token` not persisted | strips it on the way in |
| 3 | both stripped together | asserts the exact surviving object |
| 4 | Supabase fields intact | asserts surviving **values**, not just keys |
| 5 | sanitised session restores | round-trip through `getItem` |
| 6 | refresh still works | refreshed session byte-identical |
| 7 | sign-out still works | `removeItem` clears both views |
| 8 | sign-in path unaffected | full sign-in-shaped session persists and restores |
| 9 | no other persistent store holds one | `src/` walk: exactly one file may name a provider credential |
| 10 | Chrome/Firefox equivalent | identical output across two areas; boundary sits above the split |

Plus: nested/wrapped session shapes, non-JSON passthrough, byte-identity for
clean values, legacy purge on read, and a failed purge not breaking sign-in.

### 52.1 Mutation proof — 7/7 detected

A test that cannot fail on a broken sanitiser is worthless, so each mutation was
applied to `storage.ts` and the suite re-run:

| Mutation | Result |
|---|---|
| write the value unstripped (**the original bug**) | ✅ DETECTED |
| forget `provider_refresh_token` | ✅ DETECTED |
| forget `provider_token` | ✅ DETECTED |
| over-strip: take Supabase's `refresh_token` too | ✅ DETECTED |
| stop recursing (top-level keys only) | ✅ DETECTED |
| skip the legacy purge on read | ✅ DETECTED |
| let a failed purge break the session read | ✅ DETECTED |

Reintroducing the original defect fails deterministically.

### 52.2 The test that gave false assurance was rewritten, not deleted

`bundle.test.ts`'s *"reads no provider token"* check could not survive as
written: the fix must name `provider_token` in order to remove it.

It was **narrowed rather than weakened**. It now asserts that exactly one file in
`src/` names a provider credential, and that the file is
`background/storage.ts`. That is a stronger and more honest guarantee than the
original blanket grep, and it carries a comment recording that the original
passed throughout the period the credential was being stored.

The content-script rule — the page has no notion of a provider token at all — is
unchanged and still passing.

---

## 53. Real-flow verification

**Not re-run in this checkpoint, deliberately.**

The brief prefers deterministic proof to unsafe inspection, and the remaining
question a live sign-in would answer — *is the adapter really the only writer?* —
was settled deterministically in §49 instead: one client, one storage, no
`userStorage`, and no other consumer that ever receives a session.

A confirming real-flow check is available and safe whenever wanted: the same
shape-only diagnostic used in §38, reporting `PRESENT`/`ABSENT` and a length and
never a value. Expected result after this change:

| | |
|---|---|
| `provider_token` persisted | **NO** |
| `provider_refresh_token` persisted | **NO** |
| Supabase session persists | **YES** |

Recorded as expected-not-observed rather than claimed, because the distinction
between those two is what this whole section exists to make.

---

## 54. Line endings — root cause and policy

### 54.1 Root cause

Every tracked text file was **already LF in the index** — `git ls-files --eol`
reported `i/lf` for all 377 and `i/crlf` for none. Nothing about the repository's
stored content was inconsistent.

The inconsistency was in **checkout**. With `core.autocrlf=true` (the Windows
default, and set here) git rewrites files to CRLF on the way out. Several tests
assert on the source text of the modules they cover and match **across line
boundaries**; those matches fail against CRLF. The result was that a fresh
Windows clone failed four tests that pass everywhere else — a failure caused
entirely by the checkout, not by any change to the code.

The working tree had drifted into a mixture: 271 files LF, 100 CRLF, 6 mixed,
depending on which had last been rewritten by a tool.

### 54.2 Policy

`.gitattributes`:

```
* text=auto eol=lf
*.png binary
*.svg text eol=lf
```

`eol=lf` overrides `core.autocrlf` **for this repository**, so every clone gets
the same bytes regardless of a developer's global git configuration.

Chosen after checking what the repository actually needs, not by convention:

| Checked | Finding |
|---|---|
| Tracked line endings | 377/377 text files already LF in the index |
| Files that genuinely need CRLF | **none** — no `.bat`, `.cmd`, `.ps1`, `.sln` |
| Binaries needing explicit handling | 7 PNGs, already auto-detected; made explicit anyway |
| Existing conventions | no `.gitattributes`, no `.editorconfig` |

**No content was reformatted.** Because the index was already LF, this changes
what checkout produces and nothing else — `git diff --cached` over the whole
repository showed content changes in exactly the two files this checkpoint
edited.

### 54.3 The false-dirty files, resolved

The two files previously reported as modified with no content difference were an
index/worktree normalisation mismatch. `git add --renormalize .` refreshed the
index; 110 phantom entries disappeared and **no meaningless content change was
committed** to clear them.

---

## 55. Fresh-checkout proof

Not asserted — **executed**, in a disposable worktree created with
`core.autocrlf=true` forced on, then destroyed.

| Step | Result |
|---|---|
| `git -c core.autocrlf=true worktree add` | fresh checkout of `6740af4` |
| Line endings, **counted by byte** | `CRLF=0`, `bareLF=2631` — pure LF |
| The four previously-affected tests | ✅ **55 passed** |
| Presence mutation harness | ✅ **21/21 detected** |
| Full suite | ✅ **2,409 / 2,409 passed** |

One correction along the way, because it nearly produced a wrong conclusion: the
first line-ending measurement used `grep -c $'\r'`, which reported 2,631 CR
lines and appeared to show the fix had failed. That was the measurement being
wrong, not the fix — the pattern matched every line. Counting the actual bytes
showed `CRLF=0`. The lesson is the same one §48.1 records: check what the tool is
really telling you before believing the conclusion.

The five files that failed on the first full run were all reading build
artifacts absent from a bare checkout (`dist/`, `dist-demo/`,
`supabase/.generated/apply_all.sql`). After building them the suite was fully
green. None was line-ending related, and saying so required building them rather
than assuming.

---

## 56. Known-debt delta — 21 items retired, and they were never real

The line-ending fix had an effect well beyond the four failing tests.

| Harness | Before | After | Delta |
|---|---|---|---|
| `test:analytics` | 18 / 87 | **6 / 87** | ✅ −12 |
| `test:presence` | 4 / 21 | **0 / 21** | ✅ −4 |
| `test:layout` | 5 / 23 | **0 / 23** | ✅ −5 |
| `verify:lab` | 11 | **11** | ✅ unchanged |

**No test was changed to achieve this**, which is exactly why it needed
explaining rather than celebrating.

The mutation harnesses apply a mutation by string replacement, and when the
anchor is not found they print `SKIPPED … anchor no longer present` and count it
as an undetected mutation. Multi-line anchors could not match CRLF source, so
the mutation never applied and was recorded as a test failing to catch it.

Proven causally rather than inferred: converting `src/` back to CRLF and
re-running reproduced the failures as `SKIPPED … anchor no longer present`, and
restoring LF made all 21 detect again.

So a large part of the recorded known debt was **an artifact of Windows
checkout**, not weak tests.

Of the 6 analytics items that remain: **4 are stale anchors** in
`analyticsHub.ts` — genuinely out of date since that file was rewritten at
M3C.1 — and **2 are genuine undetected mutations**. Left alone as pre-existing
debt outside this checkpoint's scope, but now correctly attributed.

---

## 57. Deltas and status

| | |
|---|---|
| Twitch scopes | ✅ **unchanged** — still none requested |
| Schema / migration | ✅ **none** — `0032` still free, hosted marker 31 |
| Version | ✅ **0.7.0** unchanged, manifest unchanged |
| Release movement | ✅ none — nothing packaged, uploaded, tagged or submitted |
| Chrome v0.7 / Firefox v0.6 | ✅ untouched |
| `npm test` | ✅ **2,409 / 2,409** (2,393 baseline + 16 new) |
| lint / tsc / build | ✅ clean |
| `verify:store` / `verify:firefox` / `verify:analytics` | ✅ pass; nothing client-readable |

### 57.1 O1 — still open, still the same decision

Nothing here approves or forecloses server-side credential custody.

O7 was always the item **not gated on O1** (§45.1), and it is now closed under
either answer: if custody is declined the extension holds nothing it never used,
and if custody is approved requirement 3 of §44 — *capture at sign-in, straight
to the backend, and stop persisting client-side* — is now half-built, because the
client no longer retains anything.

Future capture remains possible and is not made harder: the sign-in result
returned by `exchangeCodeForSession` still carries both provider fields, exactly
as before. Only **persistence** changed. A deliberate O1 implementation would
take the credential from that result and hand it to a server-only boundary,
which this checkpoint has neither built nor blocked.

**O1 remains the owner's open decision**, with §44's twelve requirements
unchanged.

---

# O1 — Server-side Twitch credential lifecycle

**Date:** 2026-08-31
**Type:** ARCHITECTURE / SECURITY checkpoint — **design only, nothing implemented**
**Baseline:** `161e6d0` · 2,409/2,409 · schema 31 · `0032` free · v0.7.0

> No product code, Edge Function, migration, schema, secret, scope, manifest or
> package was created or changed. The only repository change is this report.

---

## 58. Executive architecture verdict

## **GO — with three binding conditions**

The design below stores a Twitch refresh credential server-side without
triggering any of the checkpoint's STOP conditions:

| STOP condition | Status |
|---|---|
| plaintext credentials stored | ❌ never — AES-256-GCM, key outside the database |
| clients gain credential read access | ❌ RLS on, zero policies, `service_role` only |
| another user's credential selectable by client input | ❌ actor is always `auth.uid()`; no id in any request |
| secure key management unavailable | ❌ Supabase Function secrets, already in use |
| safe refresh rotation undesignable | ❌ advisory lock + compare-and-swap (§68) |
| account deletion cannot destroy credentials | ❌ `auth.admin.deleteUser` → cascade (§72) |
| revocation cannot destroy credentials | ❌ signed EventSub → resolve → delete (§69) |
| requires weakening RLS | ❌ strengthens it — a new deny-all table |
| raw credentials above the server boundary | ❌ M3D receives a verdict, never a token (§80) |
| becomes a generalised OAuth platform | ❌ one provider, one purpose, one table |
| Chrome/Firefox divergence | ❌ none — no manifest change on either |
| major platform migration | ❌ nothing new; uses what already exists |

**The three conditions:**

1. **Atomicity is not negotiable (§86).** Capture, encryption, rotation,
   revocation, scope loss, relationship deletion, account deletion and
   credential destruction ship as **one milestone**. No production credential is
   written until the whole lifecycle passes its gates. The brief's hard
   principle is the correct one and the sequencing in §86 enforces it.
2. **U3 must close before implementation (§88).** The
   `user.authorization.revoke` payload still does not render in Twitch's docs
   after three attempts across two pages. Revocation depends on which identity
   field arrives. This is cheap to close with the Twitch CLI and must not be
   guessed.
3. **Owner must decide what account deletion does to analytics (§89, D-A).**
   `analytics_events.actor_id` cascades from `public.users`, so a
   user-triggered account deletion **destroys that user's entire measurement
   history** today. That is defensible, but it is a strategy decision, not an
   implementation detail, and it should be made deliberately rather than
   inherited from a foreign key written in `0013`.

**What makes this tractable is that almost nothing is new.** Watchside already
has an Edge Function holding `TWITCH_CLIENT_SECRET`, a service-role-only table
that clients cannot touch, a caller-authentication pattern where the actor is
`auth.uid()` and never a request parameter, and a Twitch-identity mapping with a
uniqueness constraint. The design below is mostly the assembly of existing
patterns, which is why it can be small.

---

## 59. Current auth and custody boundary

Inspected rather than assumed.

| Component | Actual state |
|---|---|
| Edge Functions | **one**: `supabase/functions/twitch-metadata` (312 lines) |
| Secrets | `Deno.env.get('TWITCH_CLIENT_ID' / 'TWITCH_CLIENT_SECRET' / 'SUPABASE_SERVICE_ROLE_KEY')`, set via `npx supabase secrets set` (documented in `docs/TWITCH_METADATA.md:92`) |
| Twitch app type | **confidential** — the function already mints app tokens with `client_credentials` + secret |
| Caller authentication | `createClient(SUPABASE_URL, ANON_KEY, { global: { headers: { authorization } } })` then an RPC whose actor is `auth.uid()` |
| Client-invisible table precedent | `twitch_metadata_cache`: RLS enabled, **zero policies**, `revoke all … from public, anon, authenticated`, `grant … to service_role` |
| Security-definer functions | 79, each with explicit `revoke`/`grant execute` |
| Twitch identity mapping | `connected_accounts (platform, platform_user_id) unique → user_id`, populated by the `auth.users` trigger in `0004` |
| Root of the user graph | `public.users.id references auth.users (id) on delete cascade` |
| User-owned tables | **21** with a `public.users` FK, all `on delete cascade` |
| Client credential retention | **none** — O7 (`6740af4`) |

The most valuable existing precedent is the comment already in
`twitch-metadata`:

> *"The actor is `auth.uid()` inside that function, so there is no id in the
> request for anyone to put someone else's into."*

That is the rule the whole credential boundary rests on, and it is already
established practice here rather than something this design invents.

---

## 60. Credential capture flow

```
  Twitch consent
        │
        ▼
  launchWebAuthFlow → code            (extension, unchanged)
        │
        ▼
  exchangeCodeForSession(code)        (supabase-js, unchanged)
        │  session in MEMORY carries provider_refresh_token
        ▼
  auth.ts signIn()  ──POST──►  Edge Function  twitch-credential
        │   Authorization: Bearer <Supabase access_token>
        │   body: { refresh_token }         ← no actor id, ever
        ▼
  reference dropped                    actor = auth.uid()  (from the JWT)
  O7 strips it from any                encrypt (AES-256-GCM, AAD = actor_id)
  persistence path anyway              upsert twitch_credentials
```

| Question the brief asked | Answer |
|---|---|
| Which component sees `provider_refresh_token`? | The service worker, in memory, inside `signIn()` — the same function that already receives it today |
| How does it reach the server? | HTTPS POST to a new Edge Function on the **already-granted** `*.supabase.co` origin |
| How is the actor authenticated? | The caller's Supabase JWT in the `Authorization` header, verified exactly as `twitch-metadata` does |
| How is identity bound to the credential? | `actor_id = auth.uid()`, server-derived. **The request body contains no identifier of any kind** |
| Should `provider_token` also be stored? | **Yes — encrypted, with its expiry**, and this is a considered reversal of the obvious answer (§60.1) |
| Is the refresh token alone sufficient? | Functionally yes; operationally no (§60.1) |
| New endpoint required? | Yes — one function, `twitch-credential` |
| Replay / duplicate capture | Upsert keyed on `actor_id`, guarded by a monotonic `version`. Capturing the same token twice is a no-op; a newer sign-in always wins |
| If server capture fails | Nothing is stored, the sign-in still succeeds, and M3D is simply unavailable for that actor until the next sign-in |
| If OAuth succeeds but custody fails | **Core Watchside is unaffected.** Presence, Gravity, rooms, dwell and every existing analytic continue |

### 60.1 Why the access token is stored too

The reflexive answer is "store only the refresh token, it is the minimum." That
is wrong here, and the reason is Twitch's rotation semantics.

Every refresh **rotates the refresh token** (§66). If the access token is not
retained, every single follow check requires a refresh, and therefore a
rotation. That means:

- a write to the credential row on every JOIN, with the contention and the
  lost-rotation risk of §68 on every one of them;
- many rotations per user per day, each an opportunity to lose the credential to
  a write failure after Twitch has already rotated it;
- pressure against Twitch's limit of 50 concurrent access tokens per refresh
  token.

Storing the access token with its expiry, encrypted in the same blob, means a
refresh happens **once per access-token lifetime per active user** — governed by
the `expires_in` Twitch returns, a few hours in practice — instead of once per
JOIN. The marginal exposure is one short-lived credential that is
already derivable from the long-lived one sitting beside it; the reduction in
rotation events is large. **Minimising the number of stored fields would here
increase the number of dangerous operations**, which is the wrong trade.

---

## 61. Client-memory lifetime

**O7 is untouched and remains authoritative.**

| Property | Design |
|---|---|
| Where the token exists client-side | One local variable inside `signIn()`, for the duration of one `await` |
| Durable client copy | **None.** Not `chrome.storage.local`, not `storage.session`, not a module-level cache |
| New browser-local storage location | **None introduced** |
| Persistence path if something leaks | Still sanitised — the O7 adapter strips both provider fields regardless (§49) |
| Guarantee | Belt and braces: the extension does not *try* to persist it, and could not if it did |

Concretely: the token is read from the `exchangeCodeForSession` result, passed
as an argument, and the reference goes out of scope when `signIn()` returns.
Deliberately **not** stored on the auth state object, and deliberately not
passed through the client port to the panel.

O7's test (`providerCredentialStripping.test.ts`) continues to prove the
persistence boundary independently of this flow, which is what makes the
"belt and braces" claim checkable rather than aspirational.

---

## 62. Server storage schema

One table. Every column justified, and two obvious ones deliberately rejected.

```
public.twitch_credentials
  actor_id        uuid primary key references public.users (id) on delete cascade
  secret          bytea       not null
  key_version     smallint    not null
  scopes          text[]      not null
  status          text        not null default 'active'
  version         bigint      not null default 1
  access_expires_at timestamptz
  created_at      timestamptz not null default now()
  updated_at      timestamptz not null default now()
```

| Column | Why it must exist |
|---|---|
| `actor_id` | Ownership, deletion key, and the cascade that makes account deletion correct. Primary key enforces **one credential per actor**, which is what makes capture idempotent |
| `secret` | The encrypted blob: `nonce ‖ ciphertext ‖ tag`, containing the refresh token, the access token and its expiry. One column rather than three because the nonce and tag are meaningless apart from the ciphertext |
| `key_version` | Rotation (§64). Without it, rotating the key means decrypting everything at once or losing everything |
| `scopes` | Scope-loss enforcement (§70). Twitch returns a `scope` array on every refresh, so this is maintained for free and lets M3D decide **without** performing a refresh |
| `status` | `active` / `needs_reauthorization`. The only way to represent "we hold a credential we no longer believe in" without deleting evidence that the user once authorised |
| `version` | Compare-and-swap for concurrent rotation (§68) |
| `access_expires_at` | Lets the function know whether a refresh is needed **without decrypting** — the cheap check comes before the expensive one |
| `created_at` / `updated_at` | Operational: age of credential, time since last successful refresh |

### 62.1 Rejected fields

| Rejected | Why |
|---|---|
| `twitch_user_id` | `connected_accounts` already maps `(platform, platform_user_id) → user_id` with a uniqueness constraint, is maintained by the `auth.users` trigger, and cascades identically. Duplicating it would create a second source of truth for identity that could disagree with the first. Revocation resolves through `connected_accounts` (§69) |
| `provider_token` as its own column | It lives inside `secret`. A plaintext column for a live access token would be exactly the defect O7 just closed |
| raw OAuth/API responses | Nothing needs them, and they maximise the deletion surface |
| `last_used_at` per check | Usage telemetry about an individual's viewing, stored beside their credential. Not needed for the lifecycle; §77 covers health without it |
| refresh history / audit of prior tokens | Retaining superseded credentials is the opposite of rotation |

---

## 63. Encryption architecture

**Application-layer AEAD inside the Edge Function. The database never holds the
key and never sees plaintext.**

| Property | Decision |
|---|---|
| Where encryption happens | Supabase Edge Function (Deno) — `crypto.subtle`, the platform's Web Crypto |
| Primitive | **AES-256-GCM**, 96-bit random nonce per write, 128-bit tag |
| Additional authenticated data | **`actor_id`** — ciphertext is cryptographically bound to its row |
| Key location | `Deno.env.get('TWITCH_CREDENTIAL_KEY_V<n>')`, a Supabase Function secret |
| Can Supabase DB administrators recover plaintext? | **No.** The key is never in Postgres, never in a migration, never in a view |
| Which runtime can decrypt | Only the Edge Function runtime holding the secret |
| Exposed to SQL or client code? | **Never.** There is no decrypt function in the database at all |
| Custom cryptography | **None.** One standard construction, no bespoke scheme |

### 63.1 Why not Supabase Vault

Vault was evaluated properly rather than dismissed, and it is the wrong tool
twice over.

**Source:** Supabase Docs — *Vault*, `supabase.com/docs/guides/database/vault`,
checked 2026-08-31.

1. **Wrong shape.** Vault stores *"system-level secrets like environment
   variables, API keys, and credentials used by database functions, triggers,
   and webhooks"* — project secrets, **not per-row application data**. A
   per-user Twitch credential is per-row application data.
2. **Wrong threat model.** Database superusers *can* read decrypted values
   through the `vault.decrypted_secrets` view, and the documentation's own
   mitigation is to *"protect access to this view with the appropriate SQL
   privilege settings"*. That makes plaintext recovery a matter of SQL
   privileges.

Application-layer encryption gives the stronger property Vault cannot: **a
complete database compromise yields ciphertext only.** For a credential that can
act on a user's Twitch account, that difference is the entire point.

`pgsodium` Transparent Column Encryption was also considered. Its status could
not be confirmed from the Vault page, and building the credential boundary on a
primitive whose support status is unclear would be a poor foundation — recorded
as U-4 (§88) rather than relied upon.

### 63.2 The AAD choice

Binding the ciphertext to `actor_id` means a row copied into another actor's row
**fails to decrypt** rather than silently succeeding. It converts a database
tampering attack into a clean authentication failure, and it costs nothing.

### 63.3 Plaintext never at rest

Plaintext exists only as a JavaScript value inside one function invocation. It
is never written to the database, never logged (§77), never returned to a
client (§65), and never included in an error message.

---

## 64. Key management

| Question | Answer |
|---|---|
| How is the production key configured? | `npx supabase secrets set TWITCH_CREDENTIAL_KEY_V1=<32 random bytes, base64>` — the mechanism already used for `TWITCH_CLIENT_SECRET` |
| How is it generated? | `crypto.getRandomValues(new Uint8Array(32))`, once, out of band. Never committed, never in `.env.example` |
| Local / dev / test | A **dev-only** key in the local function environment; unit tests use a fixed literal test key. The production key never leaves production, so a developer machine cannot decrypt production ciphertext even with a database dump |
| Rotation strategy | Additive. Set `…_KEY_V2`; new writes use `key_version = 2`; reads select the key by `key_version`. Existing rows re-encrypt **lazily on their next refresh**, so rotation needs no migration, no downtime and no bulk re-encryption job |
| Ciphertext versioning | `key_version` on the row (§62) |
| Retiring an old key | Only once no row references it. A cheap `select count(*) … where key_version = 1` answers that exactly |
| If the key is unavailable | **Fail closed** (§76). No decrypt, no write, no fallback to plaintext. M3D degrades; core Watchside is untouched |
| If the key is lost entirely | Every credential is unrecoverable. The recovery path is re-authorisation by users, and rows are marked `needs_reauthorization`. Documented because it is a real operational risk, not because it is likely |

**Deliberately not built:** automatic scheduled rotation, an HSM/KMS
integration, or envelope encryption with per-row data keys. Each is defensible
at a different scale; none earns its place for one credential type in one table.

---

## 65. Server access boundary

Exactly one component may decrypt: the Edge Function runtime.

### 65.1 Database posture

Following the `twitch_metadata_cache` precedent verbatim:

```sql
alter table public.twitch_credentials enable row level security;
revoke all on table public.twitch_credentials from public, anon, authenticated;
grant select, insert, update, delete on table public.twitch_credentials to service_role;
```

RLS enabled with **zero policies** means deny-all for every client role, and the
explicit `revoke` means a future accidental `grant` still cannot be reached
through RLS. `service_role` bypasses RLS, which is what lets the function work
and nothing else.

### 65.2 What clients can do

| Attempt | Result |
|---|---|
| `select * from twitch_credentials` | Denied — no grant, no policy |
| Read ciphertext | Denied — the row is unreachable, encrypted or not |
| Call a decrypt RPC | **No such function exists** in the database |
| Ask for another actor's credential | Impossible — no request carries an actor id |
| Ask the function for a token | The function has no route that returns one (§80) |
| Replay another user's JWT | Requires stealing that user's Supabase session, which is already the boundary for all their data |

### 65.3 Blast radius of a malicious client

A fully malicious extension, with a valid session for its **own** account, can:
capture a credential for itself (it already has one), and cause follow checks
for itself. It cannot read any credential, cannot decrypt, cannot name another
actor, and cannot obtain a Twitch token.

**The client is not trusted with the credential at any point after handoff**,
which is the property that makes the extension's compromise survivable.

---

## 66. Twitch refresh semantics

**Source:** Twitch, *Refreshing Access Tokens*,
`dev.twitch.tv/docs/authentication/refresh-tokens/`, checked 2026-08-31.
**Confidence: HIGH.**

| Property | Verified value |
|---|---|
| Endpoint | `POST https://id.twitch.tv/oauth2/token` |
| Body | `client_id`, `client_secret` (required — not a public client), `grant_type=refresh_token`, `refresh_token` (URL-encoded) |
| Response fields | `access_token`, `expires_in`, **`refresh_token`**, **`scope`** (array), `token_type` |
| Returns a replacement refresh token | **Yes** — the documented example shows a new one |
| Rotation guidance | *"Because refresh tokens may change, your app should safely store the new refresh token to use the next time."* |
| Old token invalidated? | **Not stated.** Ambiguous — designed around, not assumed (§67) |
| Access-token lifetime | **No fixed duration is guaranteed.** *"The lifetime of an access token depends on how you acquired the token. When you get a token, the `expires_in` field indicates how long, in seconds, the token is valid for."* Read `expires_in`; never hard-code a duration (§92) |
| Refresh-token expiry | Public-client refresh tokens expire after 30 days; **confidential-client refresh tokens have no expiration time**. Watchside is confidential. A stored credential therefore never lapses on its own, though it can still be *invalidated* (§92) — *more* dangerous, not less |
| Invalidation events | *"Refresh tokens can become invalid if the user changes their password or disconnects your app."* |
| Concurrency limit | One refresh token supports at most 50 concurrent access tokens |
| On failure | *"the application should re-prompt the end user for consent using the Authorization Code Grant flow"* |

Two consequences worth stating plainly. **The `scope` array on every refresh
response is the scope-loss detector** — no polling, no extra endpoint (§70). And
because confidential-client refresh tokens have **no expiration time**, deletion
is the only thing Watchside controls that ends custody. A user can still
invalidate one by changing their Twitch password or disconnecting the app (§92),
but nothing Watchside does — and no amount of elapsed time — will retire it.

---

## 67. Refresh-token rotation

Atomic rotation, designed around the ambiguity rather than through it.

```
  lock actor            pg_advisory_xact_lock(hashtextextended(actor_id))
  read row              version = N, key_version = K
  decrypt               (AAD = actor_id)
  access token fresh?   → use it, release, done          ← the common path
  POST id.twitch.tv/oauth2/token  grant_type=refresh_token
  encrypt new blob      (new nonce, current key version)
  UPDATE … SET secret=…, scopes=…, version=N+1, updated_at=now()
         WHERE actor_id=$1 AND version=$2                ← compare-and-swap
  commit / release
```

**Never two durable live refresh credentials.** The row holds exactly one
encrypted blob; the update replaces it in a single statement. There is no
history table and no "previous token" column, so a superseded credential has
nowhere to persist.

### 67.1 The dangerous window, handled honestly

The genuinely hazardous case is **Twitch rotates, then our write fails**. Twitch
has issued a new refresh token; we may no longer hold a usable one.

| Step | Behaviour |
|---|---|
| Write fails transiently | Retry the write, bounded, **with the token we already hold in memory**. This is the common recovery and it works |
| Retries exhausted | Set `status = 'needs_reauthorization'` in a separate minimal statement — the only write that must succeed |
| Even that fails | The next use decrypts, tries the old refresh token, and either succeeds (Twitch did not invalidate it) or fails and marks the row then |
| Net effect | Worst case is one user losing follow measurement until they re-authorise. **No Watchside functionality is lost, and no credential is left in an ambiguous state without being marked** |

Because Twitch does not document whether the old token dies immediately, the
design **tries the old token before declaring failure** rather than assuming
either answer. If it works, nothing was lost; if it does not, the row is marked
and the user can re-authorise.

---

## 68. Concurrency and race handling

The smallest strategy that is actually correct: **serialise per actor, and make
the write conditional.**

| Mechanism | Purpose |
|---|---|
| `pg_advisory_xact_lock(hashtextextended(actor_id, 0))` | Only one refresh per actor at a time. Transaction-scoped, so it releases on commit *or* crash — no orphaned locks |
| Compare-and-swap on `version` | A writer that somehow proceeded without the lock still cannot overwrite a newer credential |
| `access_expires_at` checked first | The overwhelmingly common path takes no lock contention because no refresh is needed |
| Statement timeout on the function's transaction | Bounds how long a Twitch network call can hold the lock |

| Scenario | Outcome |
|---|---|
| Two simultaneous JOINs, same actor | Second waits on the lock, then finds a fresh access token and performs no refresh at all |
| Multiple Twitch destinations at once | One refresh serves all of them |
| Two refresh attempts | Serialised; the second sees the first's result |
| Duplicate requests | Idempotent — a valid access token is reused |
| Stale worker with an old view | CAS rejects its write (`version` mismatch); it re-reads |
| Network timeout after Twitch succeeded | §67.1 — retry the write, then mark |
| DB write failure after rotation | §67.1 |
| Retry after ambiguous failure | Safe: try the stored token; on failure mark for re-authorisation |

Deliberately **not** built: a distributed lock service, a job queue, a
leader-elected refresher. An advisory lock and a version column are enough for
one row per user.

---

## 69. EventSub revocation architecture

One new Edge Function, `twitch-eventsub`, subscribed to
`user.authorization.revoke` with an **app access token** conditioned on
`client_id` (§5) — no user token, no scope.

### 69.1 Request handling

| Stage | Behaviour |
|---|---|
| Signature | Verify Twitch's HMAC-SHA256 over `message_id ‖ timestamp ‖ raw body` using the subscription secret, **before parsing anything**. Constant-time comparison |
| Timestamp | Reject anything older than 10 minutes |
| Replay | Dedupe on `Twitch-Eventsub-Message-Id` in a small table with a TTL sweep |
| Challenge | Answer `webhook_callback_verification` with the challenge |
| Unknown / unmapped user | 2xx and do nothing — never an error loop |

**A forged request cannot delete anything**, because deletion happens only after
signature verification succeeds.

### 69.2 Resolution and deletion

```
  revoke event → Twitch user id
        │  connected_accounts (platform='twitch', platform_user_id=…) → user_id
        ▼
  delete from twitch_credentials                    where actor_id = …
  delete from creator_relationship_observations      where actor_id = …
  ── and nothing else ──
```

| Deleted | Preserved |
|---|---|
| the encrypted Twitch credential | the Watchside account |
| Twitch-derived relationship observations | Gravity impressions, JOINs, arrivals, attribution, dwell, shared watch, experiment arm |

**Idempotent by construction**: both statements are `delete … where actor_id`,
so a duplicate valid delivery removes nothing further and still returns 2xx.

Revoking Twitch authorization must not destroy Watchside's own observations of
its own product. Those are not Twitch data (§6.1), and deleting them would
silently corrupt the experiment for reasons unrelated to the user's intent.

---

## 70. Scope-loss architecture

No EventSub event reports scope reduction separately from full revocation (§8),
and none is invented. Detection is at **use**, through two real signals:

| Signal | Meaning |
|---|---|
| `scope` array in the refresh response (§66) | Authoritative, and obtained on every refresh at no extra cost |
| `401`/`403` from Get Followed Channels with an otherwise-valid token | The scope went away between refreshes |

### 70.1 Behaviour when `user:read:follows` is gone

| Question | Answer |
|---|---|
| Delete follow-derived observations? | **Yes.** The user withdrew the permission those observations depend on |
| Retain the credential? | **No — delete it**, because `user:read:follows` is currently the *only* approved use. A credential with no approved purpose is pure liability |
| The general rule | Retain **only** while some approved capability still requires it. If M3E-a is ever approved, losing one scope would not necessarily delete a credential still needed for another |
| Does M3D stop? | Yes, immediately, for that actor |
| Re-authorisation eligible? | Yes — `status` is set so the account surface can offer it. Never mid-JOIN (§17) |

### 70.2 The window that cannot be closed

Between a silent scope reduction and the next refresh or check, Watchside cannot
know. The window is bounded by the next use, not by a timer. Recorded as a
limitation rather than papered over with a polling job that would cost more than
it is worth.

---

## 71. G6 deletion boundary

Unchanged from §6.1 and now buildable.

| Layer | Twitch-derived? | Deleted on revocation |
|---|---|---|
| Gravity impression, JOIN, arrival, attribution, dwell, shared watch, experiment arm | ❌ Watchside's own | ❌ retained |
| `following_at_join` observations | ✅ | ✅ deleted |
| Encrypted Twitch credential | ✅ | ✅ deleted |

Three triggers, three different scopes (§74). Deletion is idempotent everywhere.

§6.4 predicted that custody would give G6 a second deletion target and turn
incomplete deletion into *retention of a live credential*. That is exactly what
happened, and it is why G6 could not sensibly have been built before this
decision.

---

## 72. Account-deletion architecture

**The single correct root is `auth.users`.** `public.users.id references
auth.users (id) on delete cascade`, and 21 tables cascade from `public.users`.
So deleting the auth user deletes the graph.

### 72.1 Flow

```
  user confirms in the account surface
        │  (types their Twitch login to confirm — §72.3)
        ▼
  Edge Function  delete-account       Authorization: Bearer <Supabase JWT>
        │  actor = auth.uid()          ← never a body parameter
        ├─ 1. delete twitch_credentials              where actor_id   ← most sensitive first
        ├─ 2. delete creator_relationship_observations where actor_id
        ├─ 3. auth.admin.deleteUser(actor)            ← service role; cascades everything
        ▼
  client: signOut(), clear local storage, return to signed-out state
```

### 72.2 Properties

| Requirement | Design |
|---|---|
| Identity | `auth.uid()` from the verified JWT. A user can delete only themselves |
| Ordering | Credential **first**. If the process dies midway, the credential is already gone — the thing whose retention is worst |
| Idempotency | Every step is delete-if-exists; re-running is harmless |
| Partial failure | Retry-safe. Steps 1–2 completed do not need undoing; step 3 can be retried |
| If step 3 fails | The account still exists but holds no Twitch credential. The user is told deletion is incomplete and can retry — **never reported as success** |
| Client cleanup | `signOut()` and local storage clear, after the server confirms |
| Session invalidation | `auth.admin.deleteUser` invalidates the user's refresh tokens; any other device fails its next refresh and lands signed out |
| Accidental deletion | Typed confirmation + an explicit irreversible warning naming what is destroyed |
| Analytics | Cascades — see D-A (§89), the one genuine strategy decision here |

### 72.3 Confirmation

Deletion is irreversible and destroys the social graph the user built. The
confirmation should require typing their Twitch login — a deliberate,
non-accidental act — and must state plainly that friendships, groups, invites and
history are destroyed and cannot be restored.

---

## 73. Account-deletion blast radius

Derived by parsing every `create table` block in `supabase/migrations/`, not by
assuming the cascade graph was complete.

### 73.1 Destroyed by cascade — 21 tables

`analytics_actors` · `analytics_events` · `blocks` · `connected_accounts` ·
`feedback` · `friend_requests` · `friendships` · `group_invites` ·
`group_members` · `group_messages` · `groups` · `invite_codes` · `presence` ·
`presence_destinations` · `presence_rate` · `rate_limits` · `referrals` ·
`room_messages` · `together_reactions` · `user_badges` · `user_preferences`

All 29 foreign keys to `public.users` are `on delete cascade`. There are no
`set null`, `restrict` or `no action` rules to leave orphans.

### 73.2 Destroyed explicitly — 2 tables

`twitch_credentials` (new) and `creator_relationship_observations` (new). Both
would also cascade; both are deleted **explicitly first** so that a failure
partway through has already removed the credential.

### 73.3 Not user-owned — 5 tables, correctly untouched

| Table | Contents |
|---|---|
| `analytics_environments`, `analytics_event_names` | dimension/lookup rows |
| `badge_definitions` | catalogue |
| `twitch_metadata_cache` | **creator** metadata (channel names, avatars), not viewer data |
| `users` | the root itself, destroyed via the `auth.users` cascade |

### 73.4 Checked for, and absent

- **Embedded identities in analytics payloads.** The event vocabulary in
  `src/core/analytics.ts` contains no `user_id`-shaped property, so no event
  belonging to actor A carries actor B's identity. Deleting B leaves no dangling
  reference in A's rows. Worth checking rather than assuming, since cascade
  completeness and reference completeness are different things.
- **Non-cascading resources.** No storage buckets, no per-user files, no
  external per-user records.
- **`auth.users` metadata.** Destroyed by `deleteUser`, including
  `raw_user_meta_data` from Twitch.

### 73.5 What survives, and whether it should

| Survivor | Assessment |
|---|---|
| Rows in **other** users' tables that referenced the deleted user | They cascade — `friendships`, `group_members`, `blocks` all carry FKs on both sides |
| `twitch_metadata_cache` entries for creators they watched | Creator data, not user data. Correctly retained |
| Aggregate analytics already computed | **See D-A (§89)** — the views recompute from `analytics_events`, which cascades, so figures move retroactively |

---

## 74. Sign-out vs de-authorisation vs deletion

Three different events. Collapsing any two would be a bug.

| | **Sign-out** | **Twitch de-authorisation** | **Account deletion** |
|---|---|---|---|
| What the user did | ended a local session | withdrew Twitch's grant | asked to be erased |
| Twitch grant | **stands** | withdrawn | irrelevant — everything goes |
| Supabase session | ended | **stands** | destroyed |
| Twitch credential | ✅ **retained** | ❌ deleted | ❌ deleted |
| Relationship observations | ✅ retained | ❌ deleted | ❌ deleted |
| Watchside-owned analytics | ✅ retained | ✅ **retained** | ❌ deleted (D-A) |
| Watchside account | ✅ retained | ✅ retained | ❌ deleted |
| Server-side deletion | **none** | scoped | complete |

**Sign-out must delete nothing server-side.** Deleting an H2 baseline because
somebody closed a session would destroy unreconstructable data in response to an
action that signalled nothing about their intent.

---

## 75. Future relationship-observation boundary

`following_at_join` observations live in **their own table**, never as columns on
`analytics_events`, so they are separately deletable:

```
public.creator_relationship_observations
  actor_id             uuid    references public.users (id) on delete cascade
  broadcaster_login    text
  attribution_id       ...     nullable — the JOIN that occasioned it
  observed_at          timestamptz
  relationship_type    text    -- 'follow' only
  relationship_present boolean -- NULLABLE: a failed check is absent, not false
```

| Rule | Reason |
|---|---|
| Separate table | Revocation deletes these without touching Watchside's own analytics (§69.2) |
| `relationship_present` nullable | API failure never becomes `false` (§13.4) |
| Views compute **from the table** | Deleted observations stop contributing automatically |
| **No frozen aggregates** | An irreversible rollup would preserve a Twitch-derived fact after its deletion — precisely what G6 exists to prevent |
| Denominator | Socially initiated JOINs **with a currently retained eligible observation** — never "all JOINs" (§21) |

M3D is not implemented here. Only the boundary it will occupy is fixed.

---

## 76. Failure-mode matrix

| # | Failure | Class | Behaviour |
|---|---|---|---|
| 1 | Capture endpoint unavailable | **DEGRADE M3D ONLY** | Sign-in succeeds; no credential; retry next sign-in |
| 2 | Encryption unavailable / key missing | **FAIL CLOSED** | No write, no plaintext fallback. Alert |
| 3 | Database unavailable | **RETRY** | Bounded retry, then degrade |
| 4 | Malformed credential submitted | **FAIL CLOSED** | Reject; store nothing |
| 5 | Invalid / absent actor JWT | **FAIL CLOSED** | 401. Nothing stored |
| 6 | Duplicate capture | **RETRY-safe** | Upsert on `actor_id`; newest wins by `version` |
| 7 | Twitch refresh endpoint unavailable | **DEGRADE M3D ONLY** | No observation written; JOIN unaffected |
| 8 | Refresh rejected (revoked / password change) | **USER ACTION REQUIRED** | `status='needs_reauthorization'`; delete credential; offer re-auth |
| 9 | Scope missing | **DEGRADE M3D ONLY** | Delete observations + credential (§70) |
| 10 | Refresh rotation race | **RETRY** | Advisory lock; CAS rejects stale writes (§68) |
| 11 | Write fails after Twitch rotated | **RETRY → USER ACTION** | §67.1 |
| 12 | EventSub duplicate delivery | **harmless** | Idempotent deletes; 2xx |
| 13 | EventSub forged | **FAIL CLOSED** | Signature check precedes all parsing. Nothing deleted |
| 14 | EventSub for unknown user | **harmless** | 2xx, no-op |
| 15 | Deletion partially fails | **RETRY** | Credential deleted first; re-runnable |
| 16 | Account deletion retried | **RETRY-safe** | Every step delete-if-exists |
| 17 | Credential row missing | **harmless** | Treated as "no custody"; M3D unavailable |
| 18 | Relationship rows missing | **harmless** | Fall out of the denominator (§21) |
| 19 | Encryption key rotated | **transparent** | `key_version` selects the key; lazy re-encrypt |
| 20 | Old ciphertext, key retired | **FAIL CLOSED** | Cannot decrypt → mark `needs_reauthorization`. Never guess |
| 21 | Twitch API outage | **DEGRADE M3D ONLY** | No observation. **Never fabricate a relationship** |

**Nothing in this matrix degrades core Watchside.** Presence, Gravity, rooms,
dwell and existing analytics have no dependency on the credential subsystem —
which is the design property that makes accepting custody tolerable.

---

## 77. Operational observability

Enough to know the subsystem is unhealthy; never enough to leak a secret.

| Emitted | Shape |
|---|---|
| Operation outcome | `capture` / `refresh` / `revoke` / `delete` → ok \| failed |
| Error category | `key_unavailable`, `twitch_unreachable`, `twitch_rejected`, `scope_missing`, `db_unavailable`, `signature_invalid`, `rotation_conflict` |
| Credential presence | boolean — exists / absent |
| `key_version` | integer |
| Refresh occurred | boolean + duration bucket |
| Revocation processed | count |
| Deletion processed | count |
| Scope missing | count |
| Retry count | integer |

**Never logged:** access token · refresh token · plaintext · `Authorization`
header · ciphertext · any Twitch response body containing credentials.

Watchside already has the right idiom for this — `index.ts:136` logs the
Supabase key's *length* and never the key, and the O3 diagnostics reported
`PRESENT`/`ABSENT` and a length. Shape, never value.

Two signals worth alerting on: a **spike in `key_unavailable`** (the key is
misconfigured and everything is failing closed) and a **spike in
`rotation_conflict`** (the concurrency design is being exercised harder than
expected).

---

## 78. Deterministic security test plan

All 25 required proofs, with where each lives.

| # | Proof | Layer |
|---|---|---|
| 1 | authenticated actor hands off **only their own** credential | function + `tests/db` |
| 2 | unauthenticated actor cannot store one | function |
| 3 | client cannot read the credential row | `tests/db/authorization` |
| 4 | client cannot read ciphertext | `tests/db/authorization` |
| 5 | client cannot decrypt — **no decrypt function exists in SQL** | schema assertion |
| 6 | actor cannot use another actor's credential | function |
| 7 | plaintext never persists | round-trip: stored bytes ≠ plaintext, and contain no substring of it |
| 8 | logs contain no plaintext | capture log output; assert absence of the secret |
| 9 | refresh rotates correctly | fake Twitch: new token stored, old gone |
| 10 | stale concurrent refresh cannot overwrite newer | CAS rejects `version` mismatch |
| 11 | duplicate capture deterministic | upsert leaves exactly one row |
| 12 | Twitch revocation destroys the credential | signed event → row gone |
| 13 | revocation destroys relationship observations | rows gone |
| 14 | revocation **preserves** Watchside analytics | `analytics_events` untouched |
| 15 | duplicate revocation harmless | second delivery → 2xx, no change |
| 16 | forged EventSub cannot delete | bad signature → 403, nothing deleted |
| 17 | sign-out deletes nothing server-side | credential + observations survive |
| 18 | account deletion destroys the credential | row gone before auth deletion |
| 19 | account deletion satisfies the full contract | **all 21 cascade tables empty for that actor** |
| 20 | partial deletion safely retried | interrupt after step 1, re-run, converge |
| 21 | missing scope prevents M3D use | no observation written |
| 22 | API failure cannot fabricate relationship state | no row; **never `false`** |
| 23 | encryption-key failure fails closed | no write, no plaintext fallback |
| 24 | old ciphertext / key version per rotation design | v1 decrypts under v2 key set; retired key → fail closed |
| 25 | **O7 intact** — provider credentials never persist client-side | existing `providerCredentialStripping.test.ts`, unchanged |

Proof 19 is the one that most needs to be **generated from the schema** rather
than hand-listed: a hand-written list silently stops covering table 22 the day
one is added. It should enumerate every table with a `public.users` FK and
assert emptiness, so a new user-owned table joins the contract automatically.

---

## 79. Mutation plan

Load-bearing invariants, each with the mutation that must fail:

| Invariant | Mutation | Must |
|---|---|---|
| Actor is server-derived | take `actor_id` from the request body | FAIL |
| Credential never client-readable | `grant select … to authenticated` | FAIL |
| Plaintext never stored | store the token unencrypted | FAIL |
| AAD binds row to ciphertext | drop `actor_id` from AAD | FAIL |
| CAS prevents stale overwrite | drop `AND version = $2` | FAIL |
| Advisory lock serialises | remove the lock | FAIL |
| Signature precedes deletion | verify **after** parsing/deleting | FAIL |
| Revocation spares analytics | also delete `analytics_events` | FAIL |
| Sign-out deletes nothing | delete the credential on sign-out | FAIL |
| Deletion order | delete the auth user before the credential | FAIL |
| Failure ≠ false | write `relationship_present = false` on API error | FAIL |
| Key failure fails closed | fall back to plaintext | FAIL |
| O7 holds | write the value unstripped | FAIL (already proven 7/7, §52.1) |

A mutation that does **not** fail means the corresponding test is decorative —
the lesson from M3C.1, where four levers turned out to be ineffective and one
test was genuinely weak.

---

## 80. M3D server interface

Narrow, and it never returns a token.

```
POST /functions/v1/twitch-credential/relationship
  Authorization: Bearer <Supabase JWT>
  { broadcaster_login, attribution_id }

  → 200 { state: "recorded" }
  → 200 { state: "unavailable", reason: "no_credential"
                                       | "scope_missing"
                                       | "twitch_unavailable"
                                       | "needs_reauthorization" }
```

| Property | Design |
|---|---|
| Does M3D see a credential? | **No** — ever |
| Does the client learn the follow result? | **No.** The function performs the check *and writes the observation server-side*, returning only a status |
| Why not return the boolean? | The brief permits returning the result, but not returning it is strictly tighter: the relationship fact never crosses the server boundary at all, so a compromised extension learns nothing about the user's Twitch relationships that it did not already know |
| Actor | `auth.uid()`; `broadcaster_login` is the **only** caller-supplied input |
| Failure | An explicit `unavailable` state. **Never a fabricated relationship** |
| Where credential knowledge lives | Entirely below this interface |

Everything above this line — the measurement layer, the views, the analysis —
deals in observations. Only the function beneath it knows a credential exists.

---

## 81. Chrome impact

| Aspect | Change |
|---|---|
| `permissions` | **none** — `identity`, `storage`, `alarms`, `notifications` unchanged |
| `host_permissions` | **none** — `https://*.supabase.co/*` already granted; the new functions are routes on that origin |
| CSP | **none** |
| Manifest / extension ID | **none** |
| Privacy-practices answers | ⚠️ **yes** — see §83 |

No manifest change of any kind. The Store disclosure changes, not the technical
surface.

---

## 82. Firefox impact

| Aspect | Change |
|---|---|
| `data_collection_permissions` | **none required** |
| Declared categories | `authenticationInfo`, `browsingActivity`, `personalCommunications`, `websiteActivity` — unchanged |
| `technicalAndInteraction` | still **zero** on Firefox |
| Host permission | still the narrowed concrete Supabase origin the packager enforces |
| Manifest | **none** |

**`authenticationInfo` already covers this.** Storing a Twitch authorization
credential is authentication information, and the category is already declared
and already reviewed. Verified against `scripts/manifest.mjs:89`, not assumed.

`financialAndPaymentInfo` remains irrelevant: no subscription state, tier,
`is_gift`, gifter identity or payment data — that is M3E-a, still on HOLD.

---

## 83. Privacy implications

Store categories being unchanged does **not** mean disclosure is unchanged. The
substance changed: Watchside would hold a credential that can act on a user's
Twitch account, which it has never done.

The future disclosure must state plainly:

| Point | Substance |
|---|---|
| **What** | An encrypted Twitch authorization credential, stored on Watchside's server |
| **Why** | To check whether you already followed a creator at the moment friends led you there |
| **What is checked** | One creator at a time, at a socially initiated JOIN. **Never your follow list** |
| **What is stored** | Whether you followed that one creator at that moment — not who you follow generally |
| **Who can read it** | Nobody. Not other users, not the extension, not Watchside staff through the database — it is encrypted with a key the database does not hold |
| **Revocation** | Disconnect Watchside on Twitch and the credential and every follow observation are deleted |
| **Sign-out** | Deletes nothing — it is not a withdrawal of permission |
| **Account deletion** | Destroys everything, including the credential |
| **Not collected** | Subscriptions, tier, gifts, payment information |

The honest sentence remains *"Watchside checks your relationship with the
channel your friends are watching"* — not *"Watchside tracks who you follow"*
(§14). That distinction survives only because the design never fetches the list.

Public privacy pages are **not** updated in this checkpoint. They must be updated
in the same milestone that stores the first credential, not after.

---

## 84. Hosting and cost implications

### 84.1 Components added

| Component | Count |
|---|---|
| Edge Functions | **+3**: `twitch-credential` (capture + relationship), `twitch-eventsub` (revocation), `delete-account` |
| Tables | **+3**: `twitch_credentials`, `creator_relationship_observations`, EventSub message dedupe |
| Secrets | **+2**: `TWITCH_CREDENTIAL_KEY_V1`, EventSub subscription secret |
| EventSub subscriptions | **1**, app-token conditioned on `client_id` |
| Scheduled jobs | **1 trivial** — TTL sweep of the dedupe table. Nothing else needs a schedule |
| Migrations | ~2 (`0032`, `0033`) |

### 84.2 Request pattern

Per active user per day, roughly: 1 capture (at sign-in), ~6 refreshes at most
(4-hour access tokens — and only when actually used), and one relationship call
per socially attributed JOIN. Revocation and deletion are rare.

The dominant term is **socially attributed JOINs**, not users — and by design
that is a small fraction of sessions.

### 84.3 Order-of-magnitude cost

| MAU | Function invocations/month | Assessment |
|---|---|---|
| 1K | ~10⁵ | Free tier. Negligible |
| 10K | ~10⁶ | Comfortably small |
| 100K | ~10⁷ | Real but modest; Edge Function invocations are cheap per unit |
| 1M | ~10⁸ | Needs attention, but the credential subsystem is **not** the driver — realtime presence is |

### 84.4 What could become unexpectedly expensive

| Risk | Mitigation already in the design |
|---|---|
| Refreshing on every check | Access token cached with expiry (§60.1) — the single most important cost decision here |
| Lock contention at high concurrency | The expiry check precedes the lock, so the common path never contends |
| Dedupe table growth | TTL sweep; rows are tiny and short-lived |
| Relationship observations growing unboundedly | One row per attributed JOIN, not per JOIN — bounded by social activity |
| **EventSub retry storms** | A function that 5xxs makes Twitch retry. Always 2xx on unknown users, and never let an internal error become a retry loop |

Not optimised for 1M MAU, deliberately.

---

## 85. Migration and function inventory

**Nothing below was created.** This is the future inventory.

| Artifact | Contents |
|---|---|
| `0032_twitch_credentials.sql` | table; RLS enabled, **zero policies**; `revoke all from public, anon, authenticated`; `grant … to service_role`; no client-callable function |
| `0033_creator_relationships.sql` | observations table; same client posture; EventSub dedupe table; analysis views revoked from clients |
| `functions/twitch-credential/` | capture + refresh/rotation + relationship check + observation write |
| `functions/twitch-eventsub/` | signature verify, challenge, dedupe, revoke handling |
| `functions/delete-account/` | ordered deletion + `auth.admin.deleteUser` |
| Secrets | `TWITCH_CREDENTIAL_KEY_V1`, EventSub secret |

Schema marker moves 31 → 33. `0032` is currently free (verified).

---

## 86. Implementation sequencing

**One atomic milestone.** The brief's hard principle is right: there must never
be a production state holding a Twitch credential without the means to destroy
it correctly.

| Phase | Contents | Gate |
|---|---|---|
| **1. Destruction first** | `delete-account`; EventSub receiver with signature verification; deletion paths for credential + observations | Proofs 12–20 pass **against empty tables** |
| **2. Custody** | schema, encryption, key management, capture, refresh/rotation, concurrency | Proofs 1–11, 23–24 pass |
| **3. Boundary** | relationship interface, scope enforcement, observability | Proofs 21–22, 25 pass |
| **4. Gate** | full suite; mutation plan (§79); privacy disclosure updated; U3 closed | **All** gates green |
| **5. First production credential** | enable capture | Only now |
| **6. M3D** | `following_at_join` consuming §80 | Separate checkpoint |

**Deletion is built before custody, and tested before there is anything to
delete.** That inverts the intuitive order deliberately: an empty deletion path
is testable with fixtures, whereas a credential with no proven deletion path is
a liability from the moment it is written.

Account deletion (§72) can and should ship in phase 1 **even if O1 later
stalls** — it is a committed pre-public requirement independent of M3D, and it is
the phase that carries no credential risk at all.

---

## 87. Security risks

| # | Risk | Severity | Mitigation | Residual |
|---|---|---|---|---|
| 1 | Encryption key compromised **with** a DB dump | **Critical** | Key never in Postgres; separate systems must both fall | Real but requires two independent compromises |
| 2 | Service-role key leaks | **Critical** | Never in the extension; Function secrets only | Would expose ciphertext, **not plaintext** — the key is separate |
| 3 | Credential retained after revocation | High | Signature-verified EventSub; idempotent delete; refresh rejection as a second signal (§8) | Bounded by delivery; a missed webhook is caught at next refresh |
| 4 | Lost rotation orphans the grant | Medium | Retry, then try the old token, then mark (§67.1) | One user re-authorises |
| 5 | Forged EventSub deletes data | High | Verify before parsing; constant-time compare | Mitigated |
| 6 | Client escalates to another actor | **Critical** | No actor id in any request, anywhere | Structurally prevented |
| 7 | Plaintext in logs | High | Shape-only logging (§77); mutation-tested | Mitigated |
| 8 | Key lost entirely | Medium | Mass re-authorisation | Operational, documented |
| 9 | Confidential-client refresh tokens have no expiration time | Medium | Deletion is the only end Watchside controls; all three triggers delete (§74) | **Inherent to Twitch.** A user can still invalidate one (§92), but time will not clean up after us |
| 10 | Scope-loss window | Low | Detect at use (§70.2) | Accepted and documented |
| 11 | Scope creep into an OAuth platform | Medium | One provider, one purpose, one table; §62.1 rejections | Requires discipline at each future checkpoint |

Risk 9 deserves emphasis: because Watchside's Twitch app is confidential, a
stored refresh token is valid **forever** unless deleted. Every retention bug is
therefore permanent by default. That is the strongest argument for building
deletion first (§86).

---

## 88. Remaining unknowns

| # | Unknown | Impact | Closure |
|---|---|---|---|
| **U3** | `user.authorization.revoke` payload fields — is it `user_id`? | **Blocks implementation.** Revocation resolves through `connected_accounts.platform_user_id` and needs the right field | `twitch event trigger user.authorization.revoke` with the Twitch CLI, or one live subscription. Docs truncate before the payload table on both pages tried, three attempts |
| **U4** | `pgsodium` / TCE support status | Low — Vault is already excluded on shape and threat model (§63.1) | Only matters if the encryption approach is revisited |
| **U5** | Whether Twitch invalidates the **old** refresh token immediately on rotation | Low — designed around either answer (§67.1) | Observable during implementation |
| **U6** | EventSub delivery reliability in practice | Medium — determines how much the refresh-rejection fallback matters | Operational, post-launch |
| **U7** | D7 counsel read; D8 AMO answer | Unchanged from earlier checkpoints | Owner actions |

**U3 is the only one that blocks starting**, and it is cheap to close.

---

## 89. Owner decisions

| # | Decision | Recommendation |
|---|---|---|
| **D-A** | 🆕 **What does account deletion do to that user's analytics?** Today `analytics_events.actor_id` cascades, so deletion destroys their entire measurement history — including evidence already used in aggregate claims | ✅ **Accept the cascade.** It is the honest reading of "delete my account", and it is what the schema already promises. The alternative — severing `actor_id` to retain "anonymous" rows — retains behavioural data about someone who asked to be erased, and event-level viewing history is rarely anonymous in practice. If measurement loss ever becomes material, the fix is periodic **aggregate** counters that never held identity, not retained event rows |
| **D-B** | Approve the atomic sequencing in §86 — deletion before custody | ✅ Yes. Risk 9 makes retention bugs permanent |
| **D-C** | Approve application-layer AES-256-GCM over Supabase Vault (§63.1) | ✅ Yes. Vault is for system secrets and permits superuser decryption |
| **D-D** | Approve storing the **access token** alongside the refresh token (§60.1) | ✅ Yes — it converts a per-JOIN rotation into a per-4-hour one |
| **D-E** | Approve the tighter M3D interface that returns **no** relationship result to the client (§80) | ✅ Yes. Tighter than the brief requires, at no cost |
| **D-F** | Close **U3** before implementation begins | ✅ Required |
| **D-G** | Confirm account deletion ships in phase 1 even if O1 stalls | ✅ Yes — it is a committed pre-public requirement independent of M3D |

---

## 90. Final architecture recommendation

## **GO**

The design stores a Twitch refresh credential that Watchside can use, rotate,
and — most importantly — **destroy correctly on all three triggers**, without
triggering any STOP condition and without becoming an OAuth platform.

What makes it defensible is not the encryption, which is standard, but the
**boundaries**:

- the credential never returns to the client after handoff;
- no request anywhere names an actor, so no client can select another's
  credential;
- the database holds ciphertext and no key, so a full database compromise —
  including by an administrator — yields nothing usable;
- the measurement layer receives a verdict, never a token;
- core Watchside has **no dependency** on any of it, so every failure mode
  degrades measurement alone.

**Three conditions before implementation:** close U3 (§88), decide D-A (§89),
and hold to the atomic sequencing in §86 — deletion built and proven before the
first credential exists.

One honest note to close on. This checkpoint's design is only as good as its
assumptions about what the platform actually does, and the two most consequential
findings in this entire report — that Supabase drops provider tokens on refresh
(§41), and that the extension was persisting them anyway (§48) — were both
**invisible from Watchside's source** and both required running the real thing to
see. The deterministic tests in §78 will prove this design behaves as written.
They will not prove that the platform beneath it behaves as documented. Before
the first production credential is written, at least one real end-to-end
exercise — capture, refresh, revoke, delete — should be observed, shape-only, on
a real account.

---

# U3 — Twitch revocation payload, closed

**Date:** 2026-08-31
**Type:** NARROW VERIFICATION — docs only
**Scope:** U3 and one terminology correction. Nothing else reopened.

---

## 91. U3 — the revocation payload

**CLOSED by controlled observation**, after Twitch's own reference page truncated
before the payload table on every attempt (five fetches across three URLs).

### 91.1 How it was established

Twitch's hosted documentation could not be made to render the payload. Rather
than settle for a third-party summary, the payload was generated with
**Twitch's own CLI** — `twitchdev/twitch-cli` v1.1.24, the tool the checkpoint
brief explicitly sanctions — and delivered over a real HTTP request to a local
listener, so the headers were observed as delivered rather than as described.

| Source | Role |
|---|---|
| `twitch-cli` v1.1.24, `event trigger user.authorization.revoke` | **Primary** — controlled payload, Twitch-authored tooling |
| Same, forwarded with `-F` and `-s` to a local listener | **Primary** — headers as actually delivered |
| `dev.twitch.tv/docs/eventsub/handling-webhook-events` | **Authoritative** — header names and HMAC construction |
| `dev.twitch.tv/docs/eventsub/eventsub-reference` | **Authoritative** — condition and token type |
| `twitch-rs` typed bindings | **Corroboration only** — agrees exactly, including nullability |

A live end-to-end observation against production Twitch was considered and
rejected as disproportionate: it would require a publicly reachable receiver and
a real subscription — infrastructure this checkpoint forbids — plus the owner
revoking and restoring their own Twitch authorization.

### 91.2 The subscription

| Property | Value |
|---|---|
| Type | `user.authorization.revoke` |
| **Version** | **`"1"`** |
| Condition | `{ "client_id": "<your client id>" }` |
| Authorization to subscribe | **App access token**, whose client id must match the condition |
| Scope to subscribe | **none** |
| `cost` | `1` |

### 91.3 The delivered payload

Observed verbatim (identifiers are the CLI's synthetic values):

```json
{
  "subscription": {
    "id": "151e7814-743c-3fdb-b6a6-516ef257b1b9",
    "status": "enabled",
    "type": "user.authorization.revoke",
    "version": "1",
    "condition": { "client_id": "ab983656e44913b42c8b2cee5347da" },
    "transport": { "method": "webhook", "callback": "..." },
    "created_at": "2026-08-31T16:41:12.2205015Z",
    "cost": 1
  },
  "event": {
    "user_id": "19477018",
    "user_login": "testFromUser",
    "user_name": "testFromUser",
    "client_id": "ab983656e44913b42c8b2cee5347da"
  }
}
```

### 91.4 Identity fields, and which one Watchside uses

| Field | Type | Nullable | Use |
|---|---|---|---|
| **`event.user_id`** | string | **No** | ✅ **The field Watchside resolves on** |
| `event.user_login` | string | **Yes — null if the user no longer exists** | ❌ never for resolution |
| `event.user_name` | string | **Yes — null if the user no longer exists** | ❌ display only, and not even that |
| `event.client_id` | string | No | ✅ verify it matches Watchside's client id |

**Watchside resolves on `event.user_id` and nothing else.**

That is not a stylistic preference. `user_login` and `user_name` are null when the
Twitch account no longer exists — which is *precisely* one of the situations that
produces a revocation. A design keyed on the login would fail exactly when it
mattered most, and would fail silently: no error, just a lookup that finds
nothing and a credential that is never deleted. `user_id` is always present.

A login is also mutable on Twitch. `user_id` is not.

### 91.5 Mapping through `connected_accounts` — deterministic

```
event.user_id  ──►  connected_accounts.platform_user_id   (platform = 'twitch')
                    unique (platform, platform_user_id)
                    ──►  user_id  =  Watchside actor
```

| Question | Answer |
|---|---|
| Does the mapping exist today? | **Yes.** `connected_accounts` (`0001_schema.sql`) |
| Is it unique? | **Yes** — `unique (platform, platform_user_id)`, so at most one actor |
| Is it populated automatically? | **Yes** — the `auth.users` trigger in `0004_auth_bootstrap.sql` |
| Column type | `text`, 1–64 chars — Twitch delivers `user_id` as a **string**, which matches without coercion |
| Does it survive account deletion? | It cascades, so a deleted account resolves to nothing and the handler no-ops |
| Verdict | ✅ **Deterministic.** No new table, no new column, no migration for resolution |

The one case to handle explicitly is **no match** — an unknown or
already-deleted user. That must return 2xx and do nothing (§69.1), never an
error, or Twitch will retry a delivery that can never succeed.

### 91.6 Verification and replay fields — as delivered

Headers observed on the forwarded request (signature value redacted; only its
shape recorded):

| Header | Observed |
|---|---|
| `Twitch-Eventsub-Message-Id` | UUID — **the dedupe key** |
| `Twitch-Eventsub-Message-Timestamp` | RFC 3339, nanosecond precision — freshness check |
| `Twitch-Eventsub-Message-Signature` | `sha256=` + 64 hex (71 chars total) |
| `Twitch-Eventsub-Message-Type` | `notification` |
| `Twitch-Eventsub-Message-Retry` | `0` — **retry counter, not in the documented header list** |
| `Twitch-Eventsub-Subscription-Type` | `user.authorization.revoke` |
| `Twitch-Eventsub-Subscription-Version` | `1` |

HMAC construction, quoted from Twitch:

> *"Create an HMAC signature using your secret and a message that is the
> concatenation of the values in the Twitch-Eventsub-Message-Id header,
> Twitch-Eventsub-Message-Timestamp header, and the raw request body (the order
> is important.)"*

Two details the observation added that the documentation did not:

- **`Twitch-Eventsub-Message-Retry` exists** and is a retry counter. Duplicate
  deliveries are therefore *distinguishable* from genuinely new ones, though the
  design does not depend on it — `Message-Id` dedupe plus idempotent deletes
  already make retries harmless (§69.2), and `Message-Retry` is at most a useful
  observability signal (§77).
- **`Message-Type` distinguishes `notification` from
  `webhook_callback_verification` and `revocation`** on the same endpoint. Note
  the collision of vocabulary: a *`revocation`* message type means **Twitch is
  dropping the subscription** (e.g. `status: authorization_revoked`), which is a
  different thing from a `notification` carrying a
  `user.authorization.revoke` event. The receiver must branch on
  `Message-Type` first and must not treat a dropped subscription as a user
  revocation.

That last distinction is a genuine trap: both are called "revocation" in
Twitch's own vocabulary, they arrive at the same endpoint, and confusing them
would either delete a credential nobody revoked or ignore a subscription that
has silently stopped working.

### 91.7 Idempotency

| Property | Consequence |
|---|---|
| `Message-Id` is a UUID, stable across retries | Dedupe key for the replay table (§69.1) |
| Retries carry an incrementing `Message-Retry` | Duplicates are visible |
| Deletion is `delete … where actor_id` | A duplicate deletes nothing further |
| No match | 2xx, no-op |

Duplicate delivery is harmless by construction and needs no additional
mechanism beyond what §69 already specifies.

---

## 92. Token semantics — correction

The architecture report said **"confidential-client tokens never expire."** That
is imprecise in two ways, and both have been corrected in place (§42.1, §66,
§87 risk 9, §60.1).

**Source:** Twitch, *Refreshing Access Tokens*, re-checked 2026-08-31.

### 92.1 What was imprecise

| Claim as written | Why it was wrong | Precise statement |
|---|---|---|
| "**tokens** never expire" | Conflates access tokens with refresh tokens. **Access tokens absolutely expire** | Only *refresh* tokens are at issue |
| "never expire" | "No expiration time" is not "always valid" | They have no expiration time, **but can still be invalidated** |

### 92.2 The verified language

**Access tokens:**

> *"The lifetime of an access token depends on how you acquired the token. When
> you get a token, the `expires_in` field indicates how long, in seconds, the
> token is valid for."*

**No fixed lifetime is guaranteed.** The ≈4h figure previously used was read off
a documentation example, not a promise. The implementation must read `expires_in`
and store the derived expiry — which is what `access_expires_at` (§62) already
does. Hard-coding four hours would be a latent bug the day Twitch changes it.

**Refresh tokens:**

> *"Most refresh tokens do not expire, but refresh tokens generated by a
> **Public** client type will expire **30 days** after they are generated, which
> will invalidate the refresh token. Most applications are set to the
> Confidential client type, of which the refresh tokens do not have an
> expiration time."*

**Invalidation, which is separate from expiry:**

> *"Refresh tokens, like access tokens, can become invalid if the user changes
> their password or disconnects your app."*

### 92.3 Does this change the architecture?

**No — and it slightly strengthens the security argument.**

The design never relied on a fixed access-token lifetime: §62 stores
`access_expires_at`, and §67 refreshes when it has passed. The corrected
statement makes the reason explicit rather than incidental.

Risk 9 was that a stored refresh token is valid forever unless deleted, so every
retention bug is permanent. The precise version is the same conclusion with a
sharper edge:

> A confidential-client refresh token has **no expiration time**. It can be
> invalidated by the *user* — password change, or disconnecting the app — but
> **nothing Watchside does, and no amount of elapsed time, will retire it.**
> Deletion is the only end Watchside controls.

Which is exactly why deletion is built and proven before the first credential
exists (§86). No part of the approved custody design is invalidated.

---

## 93. Verdict

## **U3 CLOSED — architecture remains GO**

| Item | Result |
|---|---|
| EventSub type / version | `user.authorization.revoke` / **`1`** |
| Condition | `client_id` |
| Authorization to subscribe | app access token, no scope |
| Identity field Watchside uses | **`event.user_id`** — always present |
| Fields that can be null | `user_login`, `user_name` — when the account no longer exists |
| `connected_accounts` mapping | **deterministic**, unique, already populated, no migration |
| Replay protection | `Message-Id` dedupe + timestamp freshness |
| Signature | `sha256=` HMAC over id ‖ timestamp ‖ raw body |
| New trap found | `Message-Type: revocation` ≠ a `user.authorization.revoke` notification (§91.6) |
| Token semantics | corrected in place (§92) |
| **Architecture impact** | **NONE** |

All three conditions from §58 are now resolved or assigned: **U3 is closed**,
**D-A is decided (YES)**, and **atomic sequencing is approved (D-B)**.

The implementation blocker is lifted. The next checkpoint is phase 1 of §86 —
destruction paths first, proven against empty tables, before any credential
exists.

---

# Phase 1 — Destruction paths and account deletion

**Date:** 2026-08-31
**Type:** IMPLEMENTATION
**Entering:** `4c3f676` · 2,409/2,409 · hosted schema 31 · v0.7.0

---

## 94. Phase 1 verdict

## **GO**

The fire exits are built and proven while the building is empty. Every deletion
path a stored Twitch credential will ever need exists, is exercised by tests,
and survives mutation — and **no production path can write a credential**, which
is the invariant that makes shipping this half alone safe.

| Requirement | State |
|---|---|
| User-triggerable account deletion | ✅ endpoint, client path and UI |
| EventSub `user.authorization.revoke` receiver | ✅ signature-verified, replay-guarded |
| G6 deletion primitive | ✅ one shared function, three future call sites |
| Credential deletion | ✅ proven with synthetic ciphertext |
| Relationship-observation deletion | ✅ separately deletable |
| Analytics **preserved** on Twitch deauth | ✅ and mutation-proven |
| Analytics **destroyed** on account deletion | ✅ D-A, and mutation-proven |
| Idempotent / retry-safe | ✅ throughout |
| Production credential writers | **ZERO** |

Nothing in the brief's STOP list triggered. The two decisions worth flagging as
deliberate rather than incidental are in §110.4 (a group cannot outlive its
owner) and §121 (the public privacy page is **not** deployed in this phase).

---

## 95. Starting state

| | |
|---|---|
| HEAD | `4c3f676`, tree clean |
| Suite | 2,409 / 2,409 |
| Hosted schema marker | 31 |
| `0032` | free — verified again before use |
| Version | 0.7.0, unchanged |
| Known debt | analytics 6 (4 stale anchors, 2 genuine) · presence 0 · layout 0 · lab 11 |

---

## 96. Account-data blast-radius inventory

Derived by parsing every `create table` block and every foreign key in
`supabase/migrations/`, not by trusting the cascade graph.

### 96.1 Foreign keys to a user

| Target | Count | Delete rule |
|---|---|---|
| `public.users (id)` | **29** | `CASCADE` — all of them |
| `auth.users (id)` | 1 (`public.users.id`) | `CASCADE` |

**There is no `SET NULL`, `RESTRICT` or `NO ACTION` anywhere.** That was checked
explicitly, because one of them would leave an orphan that the cascade story
silently misses.

### 96.2 The 26 tables

**Destroyed by cascade — 21 user-owned:**

`analytics_actors` · `analytics_events` · `blocks` · `connected_accounts` ·
`feedback` · `friend_requests` · `friendships` · `group_invites` ·
`group_members` · `group_messages` · `groups` · `invite_codes` · `presence` ·
`presence_destinations` · `presence_rate` · `rate_limits` · `referrals` ·
`room_messages` · `together_reactions` · `user_badges` · `user_preferences`

**Destroyed explicitly, before the cascade — 2 new:**

`twitch_credentials` · `creator_relationship_observations`

**Not user-owned, correctly untouched — 5:**

| Table | Why it survives |
|---|---|
| `analytics_environments`, `analytics_event_names` | dimension rows |
| `badge_definitions` | catalogue |
| `twitch_metadata_cache` | **creator** metadata, not viewer data |
| `eventsub_messages` | delivery ids, no user column |

`public.users` itself is destroyed via the `auth.users` cascade, which is the
real root (§109).

### 96.3 Multi-actor tables — where deletion touches somebody else

Seven tables reference a user from more than one column, or scope a shared
object to one owner:

| Table | Columns | Effect on the other party |
|---|---|---|
| `friendships` | `user_id`, `friend_id` | the friendship disappears for both — correct; it cannot survive one side |
| `friend_requests` | `from_user`, `to_user` | pending requests vanish either way |
| `group_invites` | `from_user`, `to_user` | same |
| `blocks` | `blocker_id`, `blocked_id` | a block by or against the deleted user is removed |
| `referrals` | `inviter_id`, `invitee_id` | the referral record goes with either party |
| `room_messages` | `sender_id`, `recipient_id` | **their messages disappear from conversations others can still see** |
| `groups` | `owner_id` | **the whole group is destroyed for every member** |

The last two are unavoidable effects on shared records and are documented rather
than engineered around (§110.4).

### 96.4 Checked for and absent

- **No user identity embedded in analytics payloads.** The event vocabulary in
  `src/core/analytics.ts` contains no `user_id`-shaped property, so no event
  belonging to actor A carries actor B's identity, and deleting B leaves no
  dangling reference in A's rows.
- **No storage buckets, files or per-user object resources.**
- **No server-side state outside a simple foreign key.**

---

## 97. Destruction-first schema

`supabase/migrations/0032_destruction_paths.sql`. Three tables and three
functions, all server-only.

| Object | Purpose |
|---|---|
| `twitch_credentials` | the future credential row. **Empty. No writer exists** |
| `creator_relationship_observations` | future `following_at_join`. **Empty. No writer exists** |
| `eventsub_messages` | replay guard |
| `purge_twitch_derived(uuid)` | **the** shared G6 primitive (§100) |
| `actor_for_twitch_user(text)` | Twitch id → Watchside actor |
| `sweep_eventsub_messages(interval)` | housekeeping |

The credential table carries the columns the approved architecture specified —
`secret` (nonce ‖ ciphertext ‖ tag), `key_version`, `scopes`, `status`,
`version`, `access_expires_at`, timestamps — so the destruction path is proven
against the shape custody will actually use, not a placeholder.

`relationship_present` is **nullable**, which is the mechanism that keeps a
failed Twitch call from becoming "did not follow". Mutation-proven (§116).

---

## 98. Credential-table security

The `twitch_metadata_cache` precedent from `0017`, verbatim:

```sql
alter table public.twitch_credentials enable row level security;
revoke all on table public.twitch_credentials from public, anon, authenticated;
grant select, insert, update, delete on table public.twitch_credentials to service_role;
```

RLS enabled with **zero policies** is deny-all, and the explicit `revoke` means
a future accidental `GRANT` still cannot be reached through RLS. The test
harness deliberately reproduces Supabase's default of granting `anon`/
`authenticated` full DML on anything new in `public`, so these tests fail unless
the migration actively claws it back.

**Proven, for both `authenticated` and `anon`:** `SELECT`, `INSERT`, `UPDATE`
and `DELETE` all refuse with `permission denied` — including when a row exists,
so the answer is not merely "nothing to see".

One lever in the mutation plan is worth recording because it changed the design
of the test: a bare `GRANT SELECT` does **not** defeat RLS-with-no-policies, so
mutating only the grant proved nothing. The realistic failure — and what an
accidental "make it work" commit looks like — is a **permissive policy**, so
that is what the mutation adds (§116).

---

## 99. Relationship-observation security

Same posture: RLS on, zero policies, revoked from clients, granted to
`service_role`, plus an index on `actor_id` because every deletion is by actor.

**Not client-browseable, by its own subject.** A user cannot read their own
follow observations through the API — there is no product surface that needs it,
and the row exists for measurement rather than display.

Kept in a separate table from `analytics_events` precisely so a Twitch
deauthorization can delete it without touching Watchside's own observations
(§106). No aggregate table retains a deleted relationship fact; future views
compute from the table, so a deleted observation stops contributing
automatically.

---

## 100. The shared G6 deletion primitive

```sql
purge_twitch_derived(p_actor uuid) returns jsonb
```

Deletes the credential and the Twitch-derived observations for one actor, and
**nothing else**. Returns counts so callers can log that work happened without
logging what was in the rows.

**Three future call sites, one implementation:**

| Caller | Status |
|---|---|
| EventSub revocation receiver | ✅ built (§101) |
| Account deletion | ✅ built (§107) |
| Use-time scope-loss detector | ⏳ phase 2 — calls the same function (§112) |

One function rather than three copies is the point: three deletion paths that
each decide for themselves what "Twitch-derived" means will diverge, and the
divergence will be discovered by a row that outlived a revocation.

**Behaviours proven:** deletes the right actor's rows; **preserves** that
actor's analytics; leaves other actors untouched; idempotent (second call
returns zeros); harmless for an actor who never had anything; and a **null
actor is a no-op** rather than a delete-everything — which is what an
unresolved Twitch id produces.

---

## 101. EventSub receiver

`supabase/functions/twitch-eventsub/`, deployed **with `--no-verify-jwt`**:
Twitch has no Supabase JWT, so the HMAC signature *is* the authentication.

Pure decision logic lives in `verify.ts`, separate from I/O, so the two places
where a mistake silently deletes user data — the signature check and the
message-type branch — are provable offline rather than only in a deployed
function.

Order of operations, and it is deliberate:

```
  raw body read ONCE, before anything parses it
  → headers present?          → 403
  → timestamp fresh?          → 403      (before any HMAC work)
  → signature matches?        → 403      (nothing believed until here)
  → parse body
  → branch on Message-Type    (§102)
  → dedupe on Message-Id      (after verification, never before)
  → resolve actor, purge
```

Unknown actor, unknown message type and unsubscribed subscription type all
return **2xx and do nothing** — an error there would make Twitch retry a
delivery that can never succeed.

---

## 102. Message-Type branching

**The load-bearing distinction, and it came from the CLI rather than the docs.**

| Delivery | Meaning | Action |
|---|---|---|
| `Message-Type: notification` + subscription type `user.authorization.revoke` | a **user** revoked authorization | purge that actor |
| `Message-Type: revocation` | **Twitch** is dropping the subscription | **delete nothing** |
| `Message-Type: webhook_callback_verification` | setup handshake | echo the challenge |

Both of the first two are called "revocation" in Twitch's own vocabulary and
both arrive at the same URL. Reading the second as the first would delete
relationship data for whoever the body happened to name, because Watchside's own
subscription lapsed — destroying an H2 baseline for a reason that has nothing to
do with the user.

Branching happens **before** anything in the body is treated as an instruction.
Three tests cover it, including one where a `revocation` message carries a
complete event body — the case where a naive implementation reading the body
first would purge.

Mutation-proven: deleting the `subscription_dropped` branch is DETECTED.

---

## 103. Signature verification

**Source:** Twitch — *"Create an HMAC signature using your secret and a message
that is the concatenation of the values in the Twitch-Eventsub-Message-Id
header, Twitch-Eventsub-Message-Timestamp header, and the raw request body (the
order is important.)"*

| Property | Implementation |
|---|---|
| Signed material | `message_id ‖ timestamp ‖ raw_body` |
| Algorithm | HMAC-SHA256, compared against `sha256=<64 hex>` |
| Raw body | read once with `request.text()`, **never** parsed or re-serialised before verification |
| Comparison | constant-time — accumulate XOR over all characters, no early return |
| Secret | `TWITCH_EVENTSUB_SECRET`, a Function secret |

**Proven:** a genuine delivery is accepted; a wrong signature, a signature from
a different secret, missing headers, and a **body tampered with after signing**
are all rejected. That last one is the attack that matters — swapping in another
user's `user_id` in flight invalidates the signature, so nothing is deleted.

### 103.1 One test that had to change shape

The constant-time comparison produced the only **undetected** mutation in the
first run: replacing it with `a === b` passes every behavioural assertion,
because it is functionally identical. The difference is timing, and no assertion
about a return value can observe timing.

Rather than delete the lever or leave a decorative test, the test now also pins
the *shape* — XOR accumulation, no early return — which is the codebase's
existing idiom for properties that cannot be observed behaviourally. The
mutation is now DETECTED, and a future "simplification" back to `===` fails.

---

## 104. Replay and dedupe

| Mechanism | Behaviour |
|---|---|
| Timestamp freshness | ±10 minutes; an unparseable timestamp is **stale**, not "now" |
| `Message-Id` | primary key in `eventsub_messages`; a duplicate insert (`23505`) means already handled → 2xx `duplicate` |
| Ordering | dedupe happens **after** signature verification, so an unverified request cannot poison the table with an id that would suppress a later genuine delivery |
| Guard unavailable | fail closed (503). The purge is idempotent so deleting anyway would be safe, but "no cleanup without a recorded delivery" is the simpler invariant |
| Sweep | `sweep_eventsub_messages(interval)`, service-role only |

A stale delivery is rejected **before** the HMAC, so a replayed message never
reaches the comparison — and its signature is still perfectly valid, which is
exactly why the message id is recorded as well.

---

## 105. Twitch identity resolution

```
event.user_id  →  connected_accounts.platform_user_id  (platform = 'twitch')
                  unique (platform, platform_user_id)
               →  connected_accounts.user_id  =  Watchside actor
```

**`event.user_id` only.** `user_login` and `user_name` are never consulted, and
the tests prove resolution still works when both are null — which is the state
they arrive in when the Twitch account no longer exists, one of the very
situations that produces a revocation.

The mapping needed no new schema: `connected_accounts` already carries it,
already has the uniqueness constraint, and is already populated by the
`auth.users` trigger from `0004`. Its `platform_user_id` is `text`, and Twitch
delivers `user_id` as a string, so there is no coercion.

**Unresolved id:** `actor_for_twitch_user` returns null, the receiver answers
2xx and does nothing. There is no fallback to login or name matching, and the
purge treats a null actor as a no-op rather than as "all actors" — both proven.

---

## 106. Twitch deauthorization behaviour

| Deleted | Preserved |
|---|---|
| `twitch_credentials` row | the Watchside account |
| `creator_relationship_observations` rows | **`analytics_events` and `analytics_actors`** |
| | friendships, groups, messages, presence, invites, badges |

Proven end to end with two actors: purging Alice removes Alice's credential and
observations, **keeps Alice's analytics**, and leaves Bob's credential,
observations and analytics entirely untouched.

Revoking Twitch's grant is not a request to erase Watchside's own record of
Watchside. A purge that took the analytics would silently corrupt the experiment
for a reason unrelated to what the user did — which is why the mutation that
adds `delete from analytics_events` to the purge is in the plan, and is DETECTED.

---

## 107. Account-deletion server flow

`supabase/functions/delete-account/`.

```
POST { "confirm": "DELETE" }   Authorization: Bearer <Supabase JWT>
  → auth.getUser()                     actor from the token, validated
  → purge_twitch_derived(actor)        credential FIRST
  → auth.admin.deleteUser(actor)       cascades the whole graph
  → { status: "deleted" }
```

| Property | How |
|---|---|
| Self-only | actor from `auth.getUser()`, which validates the JWT against the auth server. **No id in the request** |
| Unauthenticated rejected | 401 before anything else |
| Deliberate | requires `confirm: "DELETE"`; a stray POST does nothing |
| Idempotent | every step is delete-if-exists |
| Partial failure | reported as `deletion_incomplete` with the stage, **never as success** |
| Service role | stays server-side; the client never sees it |

The client method takes **zero arguments** — asserted by a test — so there is
nothing for a compromised tab to put another account into, at any layer.

---

## 108. Account-deletion UX

In the account panel, beside Sign out, styled distinctly (`kb-danger-btn`)
because everything else in that card is reversible and this is not.

| Requirement | Implementation |
|---|---|
| Findable | account panel, next to Sign out |
| Clear warning | names what is destroyed and says it cannot be undone |
| Explicit confirmation | must type their **Twitch login**; the button stays disabled until it matches |
| Not one-click | first click only opens the confirmation — **proven**: the destructive control is absent from the initial render |
| Success / failure | failure sets an error and re-enables; the panel closes only on confirmed success |
| Session cleared | the worker clears local state after the server confirms |
| Nullable login | an account without a Twitch login gets `DELETE` as the phrase rather than an unfillable field |

Deliberately no other account-management features were added.

---

## 109. Account-deletion ordering

**Credential first, always.**

```
1. purge_twitch_derived(actor)     ← the worst thing to retain
2. auth.admin.deleteUser(actor)    ← cascades public.users → 21 tables
```

If the process dies between them, the live Twitch credential is **already
gone** and the account is in a state a retry completes. The reverse order would
orphan the credential behind a deleted account, where no later cleanup could
reach it — and Twitch's confidential-client refresh tokens have no expiration
time, so it would sit there indefinitely.

`auth.users` is the real root: `public.users.id references auth.users (id) on
delete cascade`, verified in the schema and proven by a test that deletes the
auth row and asserts the whole graph goes with it.

---

## 110. Analytics deletion semantics

### 110.1 What "that user's analytics history" is

`analytics_events` where `actor_id = <user>`, plus their `analytics_actors` row.
Both carry `on delete cascade` from `public.users`, so both are destroyed by the
account-deletion root. D-A satisfied.

### 110.2 Nobody else's is touched

`actor_id` is the only user column on `analytics_events`, and the event
vocabulary embeds no second user's identity (§96.4). Deleting Alice cannot
remove a row belonging to Bob — proven with both actors present.

### 110.3 The contract is generated, not hand-listed

The strongest test here asks the **catalogue** which tables carry a
`public.users` foreign key, then asserts every one of them is empty for the
deleted actor. A hand-written list stops covering table 22 the day somebody adds
one; this makes a new user-owned table join the deletion contract automatically,
and fail loudly if it does not.

### 110.4 Unavoidable effects on shared records

Two are worth stating plainly rather than burying:

- **A group cannot outlive its owner.** `groups.owner_id` cascades, so deleting
  an owner destroys the group for every member. That is the existing schema's
  semantics; changing it silently — reassigning ownership during a deletion —
  would be a product decision made inside a privacy feature, so it is documented
  and surfaced in the UI copy instead.
- **Messages disappear from conversations others can still see**, leaving gaps.

Both are now stated in the privacy policy (§121) so the user learns them before
confirming rather than afterwards.

---

## 111. Sign-out invariants

**Sign-out deletes nothing server-side, and never reaches a destruction path.**

| Proven | |
|---|---|
| `signOut` never calls `deleteAccount` | ✅ |
| The account survives sign-out | ✅ |
| No server-side deletion of credential or observations | ✅ (§115) |

The mutation "delete the credential on sign-out" is in the plan precisely
because that is the plausible mistake: both end a session from the user's point
of view, and only one is a withdrawal of anything.

---

## 112. Scope-loss future hook

**Not implemented**, because detecting scope loss requires a refresh — and
refreshing requires custody, which does not exist yet.

The *deletion* side is already built. When phase 2 adds the use-time detector,
it calls `purge_twitch_derived(actor)` — the same function the receiver and
account deletion already use. There is no second implementation to write and
none to keep in step.

**Future call site:** the credential subsystem, after a refresh whose `scope`
array no longer contains `user:read:follows`, or after a `401`/`403` from Get
Followed Channels.

---

## 113. Migration

`0032_destruction_paths.sql`. `0032` was re-verified free before use. No
historical migration was edited.

The schema marker moves **31 → 32**. `0032` takes ownership even though its
tables are not analytics tables, because the marker is the only signal for how
far the hosted schema has advanced, and the destruction paths are the one thing
where "did this actually apply?" must have an answer that does not depend on
reading a table clients cannot see. The bundle test's own comment anticipated
ownership moving; it was updated with that reasoning rather than flipped.

---

## 114. Hosted state

Applied through the established workflow, with every check the brief requires:

| Step | Result |
|---|---|
| SQL inspected | ✅ |
| DB suite | ✅ 390 → **423** passing |
| Bundle regenerated + migration test | ✅ |
| `supabase migration list` | local ≡ remote through 0031; **0032 the only gap** — no history problem, so no repair or baseline |
| `db push --dry-run` | **`0032_destruction_paths.sql` only** |
| Applied | ✅ |
| `migration list` after | local ≡ remote through **0032** |
| `verify:analytics` | ✅ passes; **nothing client-readable** |

**The three new tables were added to `verify:analytics`.** They are not
analytics, and they belong there anyway: the credential table's entire security
property is that no client can reach it, and the database suite only proves that
against an in-memory Postgres. Production now reports:

```
relation present  twitch_credentials
relation present  creator_relationship_observations
relation present  eventsub_messages
```

…all present, none client-readable.

---

## 115. Deterministic security tests

**+80 tests**, 2,409 → **2,489**.

| Suite | Count | Covers |
|---|---|---|
| `tests/db/destructionPaths.test.ts` | 33 | table posture, purge semantics, identity resolution, deletion contract, dedupe |
| `tests/extension/eventsubVerification.test.ts` | 24 | signature, replay, Message-Type branching, identity |
| `tests/extension/accountDeletion.test.ts` | 14 | deletion flow, sign-out invariant, **no-custody proof** |
| `tests/extension/accountDeletionUi.test.tsx` | 9 | findable, not one-click, honest failure |

All 40 enumerated proofs are covered. Mapping the less obvious ones:

| # | Proof | Where |
|---|---|---|
| 9 | unknown Twitch user_id cannot delete another actor | null actor is a no-op |
| 10 | nullable login/name do not matter | resolution with both null |
| 14 | replayed message id handled deterministically | dedupe primary key |
| 15 | `Message-Type: revocation` does no user cleanup | three tests |
| 20 | credential destroyed before broader deletion | call-order assertion |
| 26 | expected cascades execute | catalogue-generated contract (§110.3) |
| 29 | local session cleared after success | auth-service state |
| 30 | sign-out performs no server deletion | §111 |
| 36 | no real provider credential can be persisted | §118 |
| 40 | logs contain no plaintext | fixed-code logging only (§117) |

---

## 116. Mutation proofs

`npm run test:destruction` — **11 / 11 detected.**

| Mutation | Result |
|---|---|
| eventsub: accept any signature | ✅ DETECTED |
| eventsub: compare signatures with early exit | ✅ DETECTED *(after §103.1)* |
| eventsub: stop checking freshness | ✅ DETECTED |
| eventsub: treat a dropped subscription as a user revocation | ✅ DETECTED |
| eventsub: fall back from `user_id` to `user_login` | ✅ DETECTED |
| purge: also delete Watchside analytics on deauth | ✅ DETECTED |
| purge: delete every actor rather than the named one | ✅ DETECTED |
| purge: treat an unresolved actor as "all actors" | ✅ DETECTED |
| credentials: give clients a permissive read policy | ✅ DETECTED |
| observations: default `relationship_present` to false | ✅ DETECTED |
| o7: persist the session without stripping | ✅ DETECTED |

Two levers taught something rather than merely passing. The permissive-policy
one had to be rewritten because a bare `GRANT` does not defeat RLS-with-no-
policies (§98), and the constant-time one was genuinely undetectable until the
test pinned the implementation shape (§103.1).

---

## 117. O7 regression proof

**Intact.** `providerCredentialStripping.test.ts` unchanged and passing, and the
O7 mutation is still DETECTED.

| Assertion | Result |
|---|---|
| `provider_token` absent from persistent browser storage | ✅ |
| `provider_refresh_token` absent from persistent browser storage | ✅ |
| Supabase's own tokens untouched | ✅ |
| Exactly one source file names a provider credential, and it strips them | ✅ |
| Logs contain no plaintext | ✅ fixed codes only; both new functions log a code and counts, never an actor id, login, header or row content |

---

## 118. No-custody proof

**Release-blocking, and it is now a test rather than a claim.**

| Check | Result |
|---|---|
| Source files naming a provider credential | **exactly one** — `src/background/storage.ts`, which removes them |
| Edge Functions naming a provider credential | **none** |
| `insert into public.twitch_credentials` anywhere in SQL | **none** |
| `delete from public.twitch_credentials` | present — the destruction path |
| Twitch scopes requested | **none**; no `scopes:` key, no `user:read:follows`, no `user:read:subscriptions` |
| O7 stripping present | ✅ |

**Production credential writers: ZERO.**

These are written to fail loudly when custody is implemented deliberately, so
turning them off is a decision somebody makes at the custody gate rather than a
line that quietly stopped being true.

---

## 119. Chrome impact

**None.** Verified rather than assumed:

| Aspect | State |
|---|---|
| `permissions` | unchanged — `identity`, `storage`, `alarms`, `notifications` |
| `host_permissions` | unchanged — the new functions are routes on the already-granted `*.supabase.co` |
| CSP | unchanged |
| Manifest / extension id / version | **untouched** (`git diff` empty) |
| Privacy-practice answers | **will** need updating when a version carrying account deletion is submitted (§121) |

---

## 120. Firefox impact

**None.** Declared categories remain exactly `authenticationInfo`,
`browsingActivity`, `personalCommunications`, `websiteActivity` —
`scripts/manifest.mjs` untouched. `technicalAndInteraction` still zero.

Account deletion collects nothing; it removes. `verify:firefox` passes.

---

## 121. Privacy impact

`docs/PRIVACY.md` updated. It previously said deletion was by email, which is no
longer true.

It now says deletion is self-service in the account panel, that it asks for the
Twitch username because it cannot be undone, and enumerates what goes —
including **the two shared-record effects from §110.4**: groups you created are
deleted for everyone, and your messages leave gaps in conversations others can
still see. Somebody should learn that before confirming, not after.

It also states plainly that sign-out deletes nothing on the server.

**No claim is made that Watchside stores Twitch credentials, because it does
not.** The only token sentence in the policy refers to Watchside's own Supabase
session tokens, which is accurate.

### 121.1 The public page is deliberately NOT deployed

`docs/PRIVACY.md` tracks HEAD; the published page describes what people have
**installed**, and account deletion is not in v0.7. Publishing now would promise
a control that no installed build has.

`scripts/build-privacy-page.mjs` is a generator run at publish time, not a gate,
so the two are allowed to differ between a feature landing and its release.
**Regenerating and deploying the page is a release-gate action for the version
that ships account deletion** — the same atomicity the brief requires of
credential-custody disclosure. Recorded in §125 as a phase-2 obligation.

---

## 122. Regression results

| Gate | Result |
|---|---|
| `npm test` | ✅ **2,489 / 2,489** (99 files) |
| `tests/db` | ✅ 423 |
| `npm run lint` | ✅ clean |
| `npx tsc -b --force` | ✅ clean |
| `npm run build` | ✅ clean |
| `npm run verify:store` | ✅ |
| `npm run verify:firefox` | ✅ |
| `npm run verify:analytics` | ✅ new tables present, none client-readable |
| `npm run test:destruction` | ✅ 11/11 |

---

## 123. Known-debt delta

| Harness | Baseline | Now | Delta |
|---|---|---|---|
| `test:presence` | 0 / 21 | **0 / 21** | ✅ none |
| `test:layout` | 0 / 23 | **0 / 23** | ✅ none |
| `verify:lab` | 11 | **11** | ✅ none |
| `test:analytics` | 6 (4 stale anchors, 2 genuine) | **6** | ✅ none |

No baseline worsened and no unrelated debt was reopened. The four stale anchors
in `analyticsHub.ts` remain out of scope.

### 123.1 The analytics number took three runs to establish

Worth recording, because it nearly went into this report wrong and because the
cause can bite anybody.

The first reading was **11 / 87**, the second **9 / 87**. Both were false, and
the reason is that a mutation harness *edits source files on disk* and restores
them afterwards. An earlier run had been killed by a timeout mid-mutation, which
left two files — `analyticsHub.ts` and `togetherWatch.ts` — holding live
mutations that nobody put there:

```
- from_join: event.attributionId !== null      +  from_join: true
- lastSeenAt: lifecycleSeenAt                  +  lastSeenAt: now
- state.socialEndedAt = state.aloneSince       +  state.socialEndedAt = at
```

Every subsequent run then measured mutated source, and the anchors it was
looking for no longer matched — which is why the extra failures all appeared as
`SKIPPED … anchor no longer present` rather than as anything obviously wrong.

**Two consequences, and the second is the serious one.** A worsened debt number
was not real; and those three mutations were sitting in the working tree,
`git status` showed them as ordinary modifications, and they would have been
committed as product code. They were caught only because the debt figure did not
match and was chased rather than accepted.

Restoring both files to HEAD and re-running on clean source gives **6 / 87**,
identical to baseline. The reconciliation between the seven printed lines and
the count of six: four `SKIPPED` stale anchors plus three `UNDETECTED`, one of
which is flagged `optional` in the harness and counted separately.

**Operational rule this establishes:** never run two mutation harnesses at once,
and after any interrupted run, check `git status` for source files nobody
edited before trusting the result — or committing.

---

## 124. Remaining risks

| # | Risk | Severity | Position |
|---|---|---|---|
| 1 | EventSub subscription not yet created | Medium | The receiver exists; the subscription is a phase-2 deployment step. Until then no revocation is heard — and nothing is stored to lose |
| 2 | A dropped subscription silently stops revocation delivery | Medium | Logged loudly as `subscription_dropped`; needs an alert in phase 2 |
| 3 | Deployment not yet done | Low | Both functions are unlaunched. No credential exists, so nothing is unprotected |
| 4 | `groups` cascade destroys a group for its members | Low | Existing semantics, now disclosed |
| 5 | Real end-to-end EventSub never exercised | Medium | Deliberate. Belongs at the custody gate (§125) |
| 6 | Account deletion is irreversible with no grace period | Low | Typed confirmation is the guard; a soft-delete window would retain data the user asked to destroy |

---

## 125. Phase 2 readiness

**Ready.** Phase 2 (custody) may proceed, and inherits a working deletion path
for everything it will create.

Obligations that must land **with** the first credential writer, not after:

1. deploy `twitch-eventsub` (`--no-verify-jwt`) and `delete-account`;
2. create the EventSub subscription and set `TWITCH_EVENTSUB_SECRET`;
3. set `TWITCH_CREDENTIAL_KEY_V1`;
4. **a real shape-only end-to-end exercise** — capture, refresh, revoke, delete —
   on a real account, per §90;
5. request `user:read:follows` and update the authorization UX;
6. **regenerate and deploy the public privacy page**, including credential
   disclosure (§121.1);
7. update Chrome privacy-practice answers at submission.

Until (1)–(3) exist, no credential can be written even by mistake: there is no
writer, no key and no endpoint.

---

## 126. Final verdict

## **GO**

The destruction side is complete, proven, and mutation-tested while the tables
are empty — which was the whole argument for building it first. A credential
with no working deletion path is a liability from its first row; an empty
deletion path is merely untested until fixtures are pointed at it, and now they
have been.

Three things are worth carrying forward as findings rather than mechanics:

- **A bare `GRANT` does not defeat RLS-with-no-policies**, so the first
  credential-exposure mutation proved nothing. The realistic failure is a
  permissive policy, and that is now what the test defends against.
- **The constant-time comparison was undetectable behaviourally.** Replacing it
  with `===` passed every assertion. Pinning the implementation shape was the
  only honest fix, and it is the same idiom the experiment-salt test uses.
- **Deleting an account destroys a group for everyone in it.** That falls out of
  a foreign key written in `0007`, and it is the kind of thing a user should be
  told before they confirm rather than discover afterwards.

**Production credential writers: ZERO.** The invariant holds, and it is enforced
by tests that will fail loudly the moment phase 2 deliberately changes it.

---

# Phase 2 — Secure Twitch credential custody

**Date:** 2026-08-31
**Type:** IMPLEMENTATION
**Entering:** `d3d3af2` · 2,489/2,489 · hosted schema 32 · v0.7.0

---

## 127. Phase 2 verdict

## **GO**

Watchside now holds a Twitch credential, encrypted, server-side, and every way
of destroying it was live and proven before the first one was written.

| | |
|---|---|
| Production credential writer | **LIVE** — `twitch-credential`, capture at sign-in |
| Credentials stored | **1** (the owner's, from the real end-to-end exercise) |
| Stored form | AES-256-GCM ciphertext, 125 bytes, key version 1 |
| Plaintext anywhere at rest | **none** |
| Browser retention | **none** — O7 holds, observed in production |
| Destruction paths | deployed **before** the writer, EventSub subscription `enabled` |
| Twitch scopes | **unchanged** |
| Migration | **none needed** — `0032` already carried the schema |

The atomic safety rule held throughout: secrets, then destruction paths, then
the EventSub subscription verified `enabled`, and only then the writer.

**Two things this checkpoint found that no amount of unit testing would have.**
A latent 401 in `delete-account` that would have failed account deletion for
every user (§141), and an auth-library failure that took four of the owner's
sign-ins to isolate (§145.2). Both existed only in the real platform, which is
exactly what the required end-to-end exercise is for.

---

## 128. Starting state

`d3d3af2`, clean · 2,489 tests · schema 32 · `0032` applied · debt: analytics 6,
presence 0, layout 0, lab 11 · `twitch-eventsub` built but **not deployed** ·
production credential writers **zero**.

---

## 129. Credential capture implementation

`supabase/functions/twitch-credential/`, three actions on one endpoint:

| Action | Purpose |
|---|---|
| `capture` | validate, bind, encrypt, store |
| `status` | shape only — presence, key version, scope count, expiry |
| `ensure_fresh` | refresh if spent; returns a **state**, never a token |

Flow, unchanged from the approved design:

```
exchangeCodeForSession → provider tokens in worker memory
  → POST twitch-credential { action: 'capture', access_token, refresh_token }
     Authorization: the session's own access token, passed explicitly
  → actor = verified JWT   (never from the body)
  → validate at id.twitch.tv/oauth2/validate
  → bind: Twitch's answer must match this actor's connected identity
  → AES-256-GCM seal, AAD = actor_id
  → upsert on actor_id
```

The request carries **no identifier of any kind**. There is nothing in it for a
client to put somebody else's account into, at any layer.

`upsert` on the primary key means re-signing in replaces rather than
accumulates. Capture failure is silent and non-fatal: the person stays signed
in, everything visible works, and measurement is simply unavailable until their
next sign-in. **There is no retry loop**, deliberately — a retry loop is a
reason to keep a plaintext credential alive in memory.

---

## 130. Actor / Twitch identity binding

**A credential arriving from actor A is not assumed to be A's.**

```
POST id.twitch.tv/oauth2/validate  →  { client_id, user_id, login, scopes, expires_in }
        │
        ├─ client_id must equal Watchside's own          → else foreign_client
        └─ user_id → connected_accounts → must equal actor → else identity_mismatch
```

Twitch's answer is the only trustworthy one; the client asserting ownership is
not evidence. The decision is extracted into `decideCapture()` so it is provable
offline rather than only through a deployed function, and one case deserves
naming: **an unknown Twitch identity is a mismatch, not a pass.** The tempting
shape — "no conflict, so allow it" — would let anybody store any Twitch
credential under their own account.

Five deterministic tests cover it, including that a foreign `client_id` is
refused *before* identity is even considered.

---

## 131. Client-memory lifecycle

| Property | State |
|---|---|
| Where the tokens exist | one function's arguments, for the duration of one `await` |
| Durable client copy | **none** — not `chrome.storage.local`, not `storage.session`, not module state |
| New browser storage location | **none** |
| Logged | never — one fixed string on failure, no values, no lengths |
| Returned upward | never — `Promise<void>` |
| If O7 somehow leaked | the adapter still strips both fields from anything persisted |

Belt and braces: the extension does not try to keep them, and could not if it
did. **Observed in production** (§146).

---

## 132. Encryption implementation

`supabase/functions/twitch-credential/crypto.ts`.

| Property | Implementation |
|---|---|
| Primitive | **AES-256-GCM** via Web Crypto |
| Nonce | 96-bit, fresh from `crypto.getRandomValues` on every seal |
| AAD | **`actor_id`** — a row copied into another actor's row fails to open |
| Envelope | `[format:1][key_version:1][nonce:12][ciphertext‖tag]`, self-describing |
| Where | Edge Function runtime only |
| Postgres sees | ciphertext, and never the key |
| Client decrypt path | **none exists** |
| Custom cryptography | **none** |

Nonce reuse is catastrophic for GCM, so there is no code path that *chooses* a
nonce — the only one draws fresh randomness. Twenty-five seals in a test produce
twenty-five distinct nonces and twenty-five distinct ciphertexts for identical
input.

Every failure is fail-closed with a fixed code: wrong key, wrong actor, unknown
format, truncated envelope, flipped bit, flipped nonce, wrong key length, no key
at all. None yields a partial result.

---

## 133. Key management

| Question | Answer |
|---|---|
| Production key | `TWITCH_CREDENTIAL_KEY_V1`, a Supabase Function secret — **CONFIGURED** |
| Generated | 32 random bytes, base64, out of band, written to a temp env file and set from it. **Never printed, never committed** |
| In SQL or the client | never |
| Returned to anyone | never |
| Dev/test | fixed synthetic literals in the test file; production key never leaves production |
| Rotation | additive — set `…_V2`, new writes use it, old rows still open, lazy re-encrypt on next refresh |
| Unknown key version | **fail closed** (`key_unavailable`) |
| No key at all | **fail closed** — the function refuses to serve |

Rotation is proven deterministically with synthetic keys: a row sealed under v1
still opens once v2 exists, and a row sealed under v2 cannot be opened by a
runtime that only has v1. **No production rotation was performed** to test
architecture.

---

## 134. Credential schema

**No migration was needed.** `0032` already created the table with exactly the
columns custody uses, which is what building the destruction paths against the
real shape bought:

`actor_id` · `secret` · `key_version` · `scopes` · `status` · `version` ·
`access_expires_at` · `created_at` · `updated_at`

The ciphertext format version lives in the envelope's first byte rather than a
column, so the blob is self-describing and no schema change was required for it.

**Not stored:** raw OAuth response, Supabase JWT, authorization headers, Twitch
profile data, subscription state, follow state, API responses.

---

## 135. Access-token expiry semantics

**Nothing is hard-coded.** `access_expires_at` is derived from the `expires_in`
Twitch actually returns:

- on capture, from `/oauth2/validate`
- on refresh, from the token response

Twitch guarantees no fixed lifetime — *"the `expires_in` field indicates how
long, in seconds, the token is valid for"* — so a four-hour constant would be a
latent bug the day it changes. A test asserts the source contains no `14400` and
no `4 * 60 * 60`, and that two different `expires_in` values produce two
different expiries.

A missing or unparseable expiry is treated as **spent**, never as "probably
fine". The real captured row carries `access_expires_at` ≈ 4h out, which is
Twitch's number and not ours.

---

## 136. Twitch refresh implementation

`POST id.twitch.tv/oauth2/token`, `grant_type=refresh_token`, with
`client_id` + `client_secret` — server-only by necessity, since a confidential
client's secret can never be in an extension.

| Outcome | Handling |
|---|---|
| Success | new access + **replacement refresh** + scopes + expiry, re-sealed and stored |
| `400`/`401` | dead grant (password change, app disconnect) → `needs_reauthorization` |
| `5xx` / network | outage → degrade, retry later, credential untouched |
| Malformed / no replacement token | **refused** — a half-understood response is not a partial success |

The client never receives the stored access token, the stored refresh token, or
the replacement. `ensure_fresh` returns `fresh` / `refreshed` / `refreshing` /
`unavailable` and nothing else.

**Phase 2 has no `user:read:follows`,** and the absence of it is not treated as
a failure anywhere.

---

## 137. Refresh-token rotation

Twitch rotates. The replacement is sealed and written in **one** conditional
update, so the row holds exactly one credential at any moment — there is no
history table and no "previous token" column for a superseded credential to
survive in.

The dangerous case is Twitch rotating and our write failing. The row is then
marked `needs_reauthorization` in a separate minimal statement — the one write
that must land — rather than left silently holding a token that may no longer
work.

---

## 138. Concurrency — a deviation from the approved design, and why

**Approved:** `pg_advisory_xact_lock` per actor, plus compare-and-swap.
**Built:** compare-and-swap **claim**, no advisory lock.

The lock is not reachable from an Edge Function. PostgREST runs each statement
on a pooled connection, so a transaction-scoped lock taken in one call is not
held for the next call in the same logical operation — the Twitch round trip
sits between them.

The smallest thing that genuinely serialises is to **claim the work atomically**:

```
read row (version N)
  → UPDATE … SET version = N+1 WHERE actor_id = … AND version = N
       0 rows → somebody else is refreshing → stand down
       1 row  → we own this refresh
  → talk to Twitch
  → UPDATE … SET secret = … WHERE actor_id = … AND version = N+1
```

Exactly one caller reaches Twitch, so a second rotation from the same parent
token cannot happen; and the final write is conditioned on the claimed version,
so a stale generation cannot overwrite a newer one. This is the "smallest
equivalent that preserves the approved invariant" the brief allowed, and the
invariant it preserves is the one that mattered.

---

## 139. Scope handling

`scopes` is recorded from validation at capture and from the `scope` array on
every refresh, so it is maintained for free and a future follow check can decide
**without** performing a refresh.

The real captured credential reports `scope_count: 1` — the base
`user:read:email` GoTrue requests, and nothing more. **No new scope was
requested.** Scope-loss enforcement is Phase 3's use-time detector, which calls
the deletion primitive Phase 1 already built (§112).

---

## 140. G6 integration

Unchanged and now live. `purge_twitch_derived(actor)` is still the single
deletion primitive; custody added a real row for it to delete rather than a new
code path.

| Event | Effect |
|---|---|
| Twitch deauthorization | credential + Twitch-derived observations destroyed; **Watchside analytics preserved** |
| Account deletion | credential destroyed **first**, then everything |
| Sign-out | **nothing**, server-side |

Proven by 33 database tests and mutation-proven in both directions. The
EventSub receiver that invokes it is deployed and its subscription is `enabled`.

---

## 141. Account-deletion integration — and a latent bug this caught

Account deletion calls the same primitive first, then `auth.admin.deleteUser`.

**A real defect surfaced.** `delete-account`, shipped in Phase 1 and never
exercised end to end, called `getUser()` with no argument. That reads the
*client's own* session — and an Edge Function has none — so **account deletion
would have returned 401 for every user**. Its tests passed because they exercise
the auth state machine against a fake backend, which is the right thing for them
to test and cannot see this.

Fixed in both functions, and both redeployed. It is worth stating plainly that
this was found only because the brief required a real end-to-end exercise, and
that Phase 1's "GO" was issued with this sitting in it.

---

## 142. EventSub deployment

| Step | Result |
|---|---|
| `twitch-eventsub` deployed | ✅ `--no-verify-jwt` (Twitch has no Supabase JWT; the HMAC is the authentication) |
| `delete-account` deployed | ✅ |
| Subscription created | ✅ `user.authorization.revoke` v1, condition `client_id`, app access token |
| Verification challenge | ✅ **answered correctly in production** |
| Final status | ✅ **`enabled`** |
| Writer deployed | ✅ **last**, only after the above |

The subscription reaching `enabled` is itself a production proof of the
receiver: Twitch sent a signed `webhook_callback_verification` and would not
have enabled it unless the deployed code echoed the challenge correctly.

The Message-Type distinction is unchanged and still covered: a `notification` of
`user.authorization.revoke` purges an actor; a `revocation` message type means
Twitch dropped **our subscription** and touches no user data.

---

## 143. EventSub subscription state

Owner-invoked, not automatic:

| Action | Reports |
|---|---|
| `subscription_status` | total, ours, enabled, statuses, whether the callback matches |
| `ensure_subscription` | lists first, creates only if none is enabled |

Deliberately **not** self-healing. A receiver that recreates its own
subscription whenever it feels unhealthy is the uncontrolled creation loop the
architecture warned against; listing before creating is what keeps
`ensure_subscription` idempotent.

Gated by a **dedicated management secret** in its own header —
`TWITCH_EVENTSUB_ADMIN_TOKEN` — rather than the service-role key. That is least
privilege (proving "the owner sent this" is not the same as "the bearer may do
anything to the database"), and it does not depend on how the gateway treats
`Authorization`. The first attempt did depend on that, and silently failed.

---

## 144. Logging and redaction

Fixed codes only: `captured`, `refreshed`, `refresh_rejected`,
`refresh_claim_lost`, `rotation_write_failed`, `decrypt_failed`,
`capture_refused`, `unauthorized`, `purged`, `subscription_dropped`.

Never logged: access token · refresh token · plaintext · `Authorization` header ·
ciphertext · any Twitch response containing credentials · any actor id.

Counts and versions are logged; contents never are. The temporary diagnostics
used during the end-to-end exercise reported **shape only** — `PRESENT`/`ABSENT`,
a length, a three-character prefix, a segment count — and all of them were
removed (§156).

---

## 145. Real shape-only end-to-end exercise

### 145.1 What was established

| # | Proof | Result |
|---|---|---|
| 1 | Real OAuth completes | ✅ |
| 2 | `provider_token` exists transiently | ✅ **PRESENT (len 30)** |
| 3 | `provider_refresh_token` exists transiently | ✅ **PRESENT (len 50)** |
| 4 | Authenticated custody handoff succeeds | ✅ |
| 5 | Server binds to the correct Twitch identity | ✅ **implied by success** — capture cannot store a row unless validation and the binding both pass |
| 6 | Postgres holds a credential for the right actor | ✅ `has_credential: true`, `status: active`, `key_version: 1`, `version: 1` |
| 7 | Persisted values are ciphertext | ✅ §147 |
| 8 | Browser holds neither provider token | ✅ §146 |
| 9 | Supabase session still persisted | ✅ §146 |
| 10 | Trusted server can use the credential | ✅ §148 |
| 11 | Refresh exercised live | ⚠️ **not observed** — the access token was fresh, and manufacturing an expiry was out of scope |
| 12 | Destruction still capable of deleting it | ⚠️ **not exercised on this row** — proven deterministically instead |

No credential value was printed, recorded, or written anywhere.

### 145.2 It took four sign-ins, and it should have taken one

The handoff failed with `401 unauthorized` three times. Two hypotheses were
wrong:

1. *`functions.invoke` sends the anon key because the client's session has not
   settled.* Passing the session token explicitly was correct practice but did
   not fix it.
2. *`getUser()` needs the JWT explicitly.* Also correct — and a genuine latent
   bug in `delete-account` (§141) — but still not the cause.

The fourth attempt used a shape-only diagnostic instead of a hypothesis, and
answered it immediately:

```
presented_len: 1572, presented_prefix: "eyJ", presented_segments: 3
auth_error: "Unexpected token '<', \"<html>\r\n<h\"... is not valid JSON"
```

The JWT was arriving perfectly all along. **auth-js's own JWKS retrieval returns
an HTML error page on this project**, so verification never got a verdict and a
valid caller was rejected. A plain `fetch` of the same URL from the same runtime
returns JSON reliably — confirmed from inside the function — so the keys are now
fetched directly and handed to `getClaims(jwt, { jwks })`. The library still
performs the signature verification; only its broken key retrieval is bypassed.
No hand-rolled cryptography, and local verification is strictly stronger than a
server lookup.

**The lesson is the order.** The diagnostic cost one reload and produced a
definitive answer; the two hypotheses cost three of the owner's sign-ins and
produced none. When a failure is opaque, building the instrument comes before
guessing at the cause — and that is now recorded here rather than learned again.

---

## 146. Browser persistence proof

Observed on a real sign-in, in production:

```
persisted: provider_token=ABSENT
           provider_refresh_token=ABSENT
           supabase access_token=PRESENT
           supabase refresh_token=PRESENT
```

**O7 holds under custody.** The Twitch credentials are stripped from persistent
browser storage while Watchside's own session survives untouched — which is the
exact invariant, confirmed against the real platform rather than a fixture.

---

## 147. Database ciphertext proof

```
rows: 1
bytes: 125 · format_version: 1 · key_version: 1 · status: active
scope_count: 1 · longest_printable_run: 8
```

**The longest run of printable ASCII in the stored bytes is 8.** A stored
plaintext token would show a run of 30 or 50; AES-GCM output effectively never
does. The size corroborates it exactly: 2 header + 12 nonce + ~95 plaintext JSON
+ 16 GCM tag = 125.

The column holds ciphertext. That is the claim the entire design rests on, and
it is now checked against the database rather than inferred from the code.

---

## 148. Credential use and decrypt proof

`ensure_fresh` on the real row returned a live state rather than an error, which
means the trusted runtime read the row, selected the key by version, and opened
the envelope with `actor_id` as AAD. Decryption works in production.

The client received a **state**, not a token — as designed.

---

## 149. Post-test credential disposition

## **A — retained.**

Custody is now intentionally enabled; that was the point of Phase 2, and the
destruction paths that justify it are deployed and proven.

**Why not the safer-looking option.** Destroying the row while the writer is
live would be undone by the owner's next sign-in, so "destroyed" would be a
false assurance rather than a safer state. The row belongs to the owner, who
authorised custody, and it is the artefact that proves the boundary works.

**If dormancy is preferred**, the correct action is to undeploy
`twitch-credential` — not to delete the row. Deleting the row without removing
the writer changes nothing durable.

No test credential was left anywhere: the only row is the owner's own, created
by the real exercise, and every fixture in the repository is synthetic.

---

## 150. Privacy deployment

Deployed atomically with the live writer, as required.

`docs/PRIVACY.md` gains a table row and a section stating plainly: the
credential is stored **encrypted on the server**, removed from the browser
entirely, never sent to another user, never returned even to its owner, and
destroyed by Twitch disconnection or account deletion. Sign-out is explicitly
called out as **not** removing it.

It says the measurement it exists for **is not built**, and does not claim any
capability that does not exist.

One correction worth recording. The first draft said Watchside "does not read
your follow list, does not read your subscriptions" — which tripped an existing
test asserting the policy makes no claim about follows or subscriptions. That
test's comment is right: *"Describing collection we do not perform is as wrong
as the reverse."* Naming data types Watchside has nothing to do with invites the
reader to wonder why they were mentioned. The paragraph was rewritten rather
than the test weakened.

The public page was regenerated from the policy and is committed to the Pages
repository.

---

## 151. Chrome impact

**None.** No permission, host permission, CSP, manifest or version change. The
credential endpoint is a route on the already-granted Supabase origin.

Privacy-practice answers will need updating at the next submission, since the
substance changed even though the technical surface did not.

---

## 152. Firefox impact

**None.** Declared categories remain `authenticationInfo`, `browsingActivity`,
`personalCommunications`, `websiteActivity` — `scripts/manifest.mjs` untouched.
Storing a Twitch authorisation credential is authentication information, already
declared. `technicalAndInteraction` still zero.

---

## 153. Migration and hosted state

**No migration.** Hosted schema remains **32**, `0033` unused. `0032` already
carried the exact table custody needed — the benefit of having built the
destruction paths against the real shape rather than a placeholder.

---

## 154. Deterministic security tests

**+46 tests**, 2,489 → **2,535**.

`tests/extension/credentialCustody.test.ts` — 40 tests: round-trip; plaintext
never in the stored bytes; self-describing envelope; fresh nonce every seal;
distinct ciphertext for identical input; wrong actor, wrong key, wrong key
version, unknown format, truncated envelope, modified ciphertext, modified
nonce, wrong key length, no key — all fail closed; additive rotation; key ring
from environment; validation parsing and failure modes; refresh success,
rotation, dead grant, outage, malformed; client secret sent; expiry derived from
`expires_in`; no hard-coded lifetime; and five identity-binding cases including
that an unknown Twitch identity is refused rather than allowed.

Plus the updated custody guards (§156) and the Phase 1 suites, unchanged.

---

## 155. Mutation proofs

`npm run test:destruction` — **11 / 11 detected**, unchanged.

The O7 lever still fires, which is the one that matters most now that a real
credential exists: reintroducing the unstripped write is caught immediately.

---

## 156. Regression results

| Gate | Result |
|---|---|
| `npm test` | ✅ **2,535 / 2,535** (100 files) |
| lint / tsc / build | ✅ clean |
| `test:destruction` | ✅ 11/11 |
| Diagnostics removed | ✅ **0** `PHASE2-E2E` in source or bundle |
| Capture path present | ✅ in the built bundle |

The custody guards were widened **deliberately**, which is what they were built
for. Two files may now name a provider credential — `storage.ts`, which removes
them, and `supabaseBackend.ts`, which hands them off once — and a third would
still fail. New tests assert the handoff never persists, caches or logs them,
and does not retry.

One near-miss worth recording: reverting `supabaseBackend.ts` to remove the
diagnostics also removed the production capture code. It was caught by reading
the resulting file rather than trusting the revert, and restored clean.

---

## 157. Known-debt delta

| Harness | Baseline | Now | Delta |
|---|---|---|---|
| `test:presence` | 0 / 21 | **0 / 21** | ✅ none |
| `test:layout` | 0 / 23 | **0 / 23** | ✅ none |
| `test:destruction` | 11 / 11 | **11 / 11** | ✅ none |
| `test:analytics` | 6 | **6** | ✅ none — its levers touch `analyticsHub.ts` and `togetherWatch.ts`, neither of which this checkpoint changed |
| `verify:lab` | 11 | **11** | ✅ none |

Source verified clean of harness residue after every run, per the operational
rule from §123.1.

---

## 158. Operational components

| Component | State |
|---|---|
| `twitch-credential` | deployed, `verify_jwt=true` |
| `twitch-eventsub` | deployed, `verify_jwt=false` |
| `delete-account` | deployed, `verify_jwt=true` |
| `twitch-metadata` | unchanged |
| EventSub subscription | **enabled** |
| `TWITCH_CREDENTIAL_KEY_V1` | **CONFIGURED** |
| `TWITCH_EVENTSUB_SECRET` | **CONFIGURED** |
| `TWITCH_EVENTSUB_ADMIN_TOKEN` | **CONFIGURED** |
| Scheduled jobs | none |

No secret was printed, committed, or written into this report.

---

## 159. Remaining risks

| # | Risk | Position |
|---|---|---|
| 1 | **Refresh never exercised against real Twitch** | The highest-value gap. Deterministic coverage is thorough, but §145.2 is a reminder that the platform is where surprises live. It will exercise itself within hours of real use; watch `refreshed` / `refresh_failed` |
| 2 | auth-js JWKS retrieval is broken on this project | Worked around, not fixed upstream. If the workaround is ever removed, every authenticated function call 401s |
| 3 | Destruction not exercised on a real credential | Proven deterministically and the subscription is live; a real deauthorization was deliberately not forced on the owner |
| 4 | One credential exists in production | The owner's own, knowingly. Blast radius of one |
| 5 | Subscription could be dropped silently | Logged loudly; `subscription_status` reports it. No alerting yet |
| 6 | Chrome privacy answers not yet updated | Due at next submission, not now |

---

## 160. Phase 3 / M3D readiness

**Ready.** M3D consumes a working credential subsystem through the narrow
interface already designed (§80): `{ broadcaster_login, attribution_id }` →
`{ state }`, with the relationship fact written server-side and no token
crossing the boundary.

What Phase 3 must add: the `user:read:follows` scope and its authorization UX,
the use-time scope-loss detector calling the existing primitive, `following_at_join`
writing to the table `0032` already created, and the privacy page updated to say
the measurement is live.

---

## 161. Final verdict

## **GO**

The credential is encrypted with a key the database does not hold, bound to the
Twitch identity Twitch itself names, reachable only by one trusted runtime,
destroyed by three separate paths that were live before it existed, and absent
from the browser entirely — each of those observed in production rather than
asserted.

Two findings justify the exercise on their own. **Account deletion was broken
for every user** and had been since Phase 1, passing its tests the whole time
because they mock the boundary where the bug lived. And a working
platform-library call **is not a safe assumption**: auth-js's key retrieval
returns HTML here, which no unit test could have found.

The one thing I would do differently is the order of the last stretch. Four
sign-ins went into an opaque 401, and the diagnostic that answered it in a single
reload should have been built before the first hypothesis rather than after the
third. The instrument comes first when the failure is silent — that is the same
lesson §48.1 recorded about grepping for a credential and finding nothing, and I
did not apply it quickly enough here.

---

# Phase 3 — M3D, started and NOT completed

**Date:** 2026-08-31
**Type:** IMPLEMENTATION — **incomplete, stopped deliberately**

---

## 162. M3D verdict

## **NOT GO — M3D is not implemented**

What exists is the server-side measurement core, dormant and behaviour-neutral.
What does not exist is most of the checkpoint. This section says which is which,
because a report shaped like a finished checkpoint would misrepresent a build
that is roughly a sixth done.

### 162.1 What was built and proven

`supabase/functions/twitch-credential/twitch.ts` gains the M3D primitives, and
`tests/extension/followBaseline.test.ts` covers them with **16 tests**:

| Built | Proven |
|---|---|
| `followsBroadcaster()` — one viewer, one creator | follow → true; **empty array → a genuine false**; 401/403/500/network/malformed → *no* answer |
| `broadcasterIdFor()` — login → Twitch id | resolution, URL encoding, unknown login, expired token |
| `readinessFor()` — the four-state model | `ready` / `needs_follow_permission` / `needs_reauthorization` / `temporarily_unavailable` |
| `hasFollowsScope()` | exact-name match, not prefix or substring |

The two things most worth having early are done properly. **Twitch signals "not
following" with an empty array**, which looks identical to "nothing came back" —
every failure path returns `ok: false` and carries no `following` value at all,
so there is no shape in which a failure can be read as an answer. And the
**existing-user transition** is a distinct state: a credential that predates the
permission is `needs_follow_permission`, never `needs_reauthorization`, because
nothing about it is broken.

**Endpoint verified** against current Twitch documentation:
`GET helix/channels/followed?user_id=…&broadcaster_id=…`, scope
`user:read:follows`, `broadcaster_id` filtering to a single channel so the
viewer's follow list is never retrieved.

### 162.2 What was NOT built

- the OAuth scope change (`user:read:follows` is **still not requested**)
- the permission UX, decline/cancel handling, and anti-nag behaviour
- the `relationship` server action wiring these primitives to custody
- the eligible-JOIN trigger at `recordJoin`
- the observation write
- idempotency semantics tied to `attribution_id`
- migration `0033`, analytics views, coverage and discovery metrics
- the remaining ~34 of the 50 required proofs, and all mutation proofs
- privacy disclosure for M3D
- the real-flow verification

### 162.3 Why it stopped here

I ran out of room to do the rest at the standard Phases 1 and 2 were held to.
Continuing would have produced a large, thinly-tested change across OAuth, the
client, the database and the privacy policy — in a system that now holds real
credentials — and the last two checkpoints are the argument against that: Phase
2 found account deletion had been broken for every user since Phase 1, passing
its tests the whole time, because the tests mocked the boundary the bug lived in.
A rushed M3D is exactly how the next one of those gets shipped.

**Nothing here changes behaviour.** No scope is requested, no client path calls
the new code, nothing was deployed, and the running function does not reference
it. The suite is green at 2,551 and every Phase 1 and Phase 2 invariant is
untouched.

### 162.4 What the next session should do first

1. Wire the `relationship` action: readiness gate → `ensureFresh` → resolve
   broadcaster → `followsBroadcaster` → write observation → return
   `recorded` / `unavailable`. The primitives are ready; this is assembly.
2. Add the scope and the account-surface permission prompt, **after** the server
   can act on it — granting a permission nothing consumes is worse than not
   asking.
3. Trigger at `recordJoin` where an attribution is minted and `socialCount > 0`;
   that is the eligible population, and the attribution id is already the
   idempotency key.
4. Migration `0033` for the views, then the proofs, then privacy, then the
   owner's single OAuth interaction.

**M3E-a remains HOLD.** No subscription scope, state, or measurement exists
anywhere.

---

# M3D Slice B — the server relationship action

**Date:** 2026-08-31
**Type:** IMPLEMENTATION — narrow seam
**Entering:** `b817ee1` · 2,551/2,551 · hosted schema 32

---

## 163. Slice B verdict

## **GO** — for this slice only. M3D remains NOT GO.

The trusted server can now take an authenticated actor, a creator and an
attribution, decide whether a baseline may be recorded, ask Twitch, and write
one server-only observation — returning nothing but `recorded` or
`unavailable`.

**Nothing invokes it.** No scope is requested, no permission has been asked
for, no client path calls it, and the privacy policy still does not describe
follow measurement. That is enforced by a test, not by intention.

| | |
|---|---|
| Relationship action | implemented |
| Production client callers | **ZERO**, test-enforced |
| Twitch scope delta | **none** |
| Follow result exposed to client | **NO** |
| Migration | `0033`, applied |
| Hosted schema | 32 → **33** |
| Tests | 2,551 → **2,591** |
| Mutations | **20 / 20** |

No STOP condition triggered. The one that came closest — attribution binding —
turned out to be securely establishable (§167), which is the finding that made
the rest of the slice possible.

---

## 164. Starting state

`b817ee1`, clean · 2,551 tests · schema 32 · `0033` free · M3D primitives from
§162 present but unreferenced · no scope requested · no relationship writer.

---

## 165. Relationship action

`POST twitch-credential { action: 'relationship', broadcaster_login, attribution_id }`
→ `{ state: 'recorded' } | { state: 'unavailable', reason }`

Eight steps, in this order, and the order is the design:

1. **readiness** — can this actor measure at all?
2. **attribution binding** — is this JOIN theirs, aimed here, and recent?
3. **already answered?** — before Twitch is touched
4. **credential** — through the existing subsystem, never a second one
5. **decrypt** — in the function runtime only
6. **viewer identity** — from `connected_accounts`
7. **creator identity** — login → Twitch id
8. **ask, then write**

Steps 1–3 are all refusals that cost no Twitch call. A request that cannot
produce a legitimate baseline is rejected before anything external happens,
which keeps both the API budget and the failure surface small.

---

## 166. Authentication and actor binding

The actor comes from the verified JWT (`getClaims`, §145.2). The request body
carries `broadcaster_login` and `attribution_id` and **nothing else** — no
`actor_id`, no `user_id`, no Twitch viewer id, no credential reference.

A client cannot name whose credential is used, whose JOIN is quoted, or whose
row is written. Those all follow from one fact: the only identity in the whole
operation is derived server-side.

---

## 167. Attribution binding — the question this slice existed to answer

The brief listed "valid attribution cannot be securely bound to actor" as a STOP
condition. It can be, and the reason is worth recording.

When somebody clicks JOIN, the worker mints an attribution and the resulting
`join_clicked` event reaches `analytics_events` through `analytics_track` —
**whose actor is `auth.uid()` server-side**. So the JOIN record is not something
a client can forge on another person's behalf, and it already carries everything
a binding needs:

| From the JOIN event | Establishes |
|---|---|
| `actor_id` | whose JOIN it was |
| `attribution_id` | which JOIN |
| `destination_channel` | which creator it was aimed at |
| `occurred_at` | when |
| `properties.social_count` | whether it was socially initiated |

`join_context_for_attribution(actor, attribution)` reads it back, and is
**scoped to the actor in its own WHERE clause** rather than returning a row for
the caller to compare. A function that can only ever answer about the actor it
was asked about cannot be misused by a caller that forgets to check — a
different and better property than "the caller currently checks".

Four refusals, each with its own reason:

| Refusal | What it prevents |
|---|---|
| `unknown_attribution` | a random or stolen id — and "no such JOIN" and "somebody else's JOIN" are indistinguishable to the caller, deliberately |
| `destination_mismatch` | quoting a genuine JOIN of your own and naming any creator you like |
| `not_socially_initiated` | measuring outside the eligible population |
| `outside_baseline_window` | a lookup too late to still be "at the JOIN" |

The second is the forgery that would otherwise be invisible: every fabricated
row would look perfectly legitimate downstream.

---

## 168. Broadcaster binding

The creator is **not** taken on the caller's word. It must equal the
`destination_channel` recorded on that JOIN, and it is validated against Twitch's
own login grammar (`^[a-z0-9_]{1,25}$`) before it reaches a URL — so nothing that
is not a login can escape into a request path.

The follow endpoint takes a `broadcaster_id`, so the login is resolved through
Helix `users` with the viewer's own token. A login Twitch does not know is
`unknown_broadcaster` and writes nothing, rather than becoming an error to
store.

---

## 169. Observation schema

Unchanged from `0032`. No new table, no duplicate. `0033` adds only what a
writer needs:

- a **partial unique index** on `(actor_id, attribution_id) where attribution_id is not null`
- `join_context_for_attribution(uuid, uuid)`, service-role only

The index is partial because `attribution_id` is nullable and NULLs are not
equal to each other, so a plain unique index would not constrain them anyway.
Saying `where attribution_id is not null` states the intent rather than relying
on the reader knowing that.

---

## 170. Observation semantics

| Twitch said | Recorded |
|---|---|
| the broadcaster is in `data` | `relationship_present = true` |
| **`data` is empty** | `relationship_present = false` — a real observation |
| 401 / 403 / 5xx / network / malformed | **nothing at all** |
| permission missing | **nothing** |
| credential unavailable | **nothing** |
| attribution invalid | **nothing** |

The empty array is the whole subtlety: it looks exactly like "nothing came
back". Every failure path returns `ok: false` and carries no `following` value
in any shape, so there is no structure in which a timeout can be read as an
answer. Mutation-proven in **both** directions — failure becoming false, and a
genuine false being discarded as failure.

---

## 171. Idempotency

**One baseline per attributed JOIN**, enforced by the database rather than by
convention.

| Situation | Behaviour |
|---|---|
| duplicate request, same attribution | `recorded`, no second Twitch call, no second row |
| retry after the response was lost | same — the pre-check sees the existing row |
| concurrent duplicate | loses to the unique index; treated as success, because the baseline it wanted exists |
| retry after a failure *before* an answer | may measure again, if still inside the baseline window |
| a later independent JOIN to the same creator | **a new legitimate observation** |
| different actors, same attribution id | separate rows — the constraint is per actor, as the deletion key is |

Tied to the attribution identity, not to a creator/time cache. A time cache
would silently answer a new question with an old answer, which is the failure
this whole section exists to avoid.

---

## 172. Baseline timing contract

`BASELINE_WINDOW_MS = 120_000`.

Wider than the 90-second arrival window — enough for the arrival and a Twitch
round trip — and nowhere near enough for the answer to drift into "followed some
time later". Outside it, the request is **refused rather than recorded with a
caveat**, because a caveat in a column nobody reads becomes a false baseline in
every downstream number.

**The contract the future caller must respect:** fire at the JOIN, synchronously
with the click. No queue, no long backoff, no background sweep — each of those
would silently turn `following_at_join` into `following_some_time_later`, and
nothing downstream could ever detect it.

---

## 173. Credential subsystem integration

Consumed, not duplicated. The action calls the existing `readCredential`,
`readinessFor`, `ensureFresh` (which owns refresh, rotation and the CAS claim)
and `open`. **There is no second token reader or refresher anywhere.**

| Credential state | Result |
|---|---|
| absent | `needs_reauthorization`, no observation |
| `needs_reauthorization` | same |
| valid but no follow scope | **`needs_follow_permission`**, no observation |
| access token spent | refreshed through the approved path, then measured |
| refresh rejected | `needs_reauthorization` |
| decrypt fails | `temporarily_unavailable` |

The third row is the one that matters for the transition: an existing user's
credential is **not broken**, and saying so would be untrue.

---

## 174. Scope-loss behaviour

Two signals, both real:

- `scopes` recorded on the credential — checked before anything else
- `403` from the follow endpoint at use

Either produces `needs_follow_permission`, no observation, and core Watchside
untouched. No EventSub scope-loss event is invented, because none exists.

Deleting existing observations on scope loss is **deliberately not done in this
slice**: no observations can exist yet, and the cleanup primitive
(`purge_twitch_derived`) is already built for whichever policy the next slice
adopts. Doing it now would be writing a policy against an empty table.

---

## 175. G6 and deletion integration

Proven against rows written in the shape the real action writes.

| Event | Observations | Credential | Watchside analytics |
|---|---|---|---|
| Twitch deauthorization | ❌ deleted | ❌ deleted | ✅ **preserved** |
| Account deletion | ❌ deleted | ❌ deleted first | ❌ deleted (D-A) |
| Sign-out | ✅ kept | ✅ kept | ✅ kept |

The deauthorization test asserts the `join_clicked` event **survives** — the
JOIN is Watchside's own observation of its own product, and only the
Twitch-derived layer goes. No G6 logic was duplicated; the existing primitive
does the work.

---

## 176. Security boundary

| Property | State |
|---|---|
| Relationship table client-readable | ❌ `permission denied`, authenticated and anonymous, even with rows present |
| Client INSERT / UPDATE / DELETE | ❌ all refused |
| `join_context_for_attribution` client-callable | ❌ refused |
| Actor A measuring for actor B | ❌ impossible — no id in the request, lookup scoped to the actor |
| Raw credential above the boundary | ❌ never |
| Follow result above the boundary | ❌ never — one funnel, mutation-proven |
| Logs | fixed codes and a readiness/reason word; no token, no actor id, **no follow fact** |
| `verify:analytics` | ✅ passing |

---

## 177. Migration and hosted state

`0033_m3d_relationship.sql`. Verified free, `0032` untouched.

| Step | Result |
|---|---|
| DB suite | ✅ 423 → **442** |
| Bundle regenerated + migration test | ✅ marker ownership moved to `0033`, with the reason recorded in the test |
| local vs remote | `0033` the only gap |
| dry-run | **`0033` only** |
| applied | ✅ |
| after | local ≡ remote at **33** |
| `verify:analytics` | ✅ nothing client-readable |

**The function was deliberately not deployed.** It is not needed for this
slice's verification, and leaving production's surface unchanged is the smaller
action. The hosted schema being ahead of deployed code is harmless here: an
additive index and a function nobody calls.

---

## 178. Deterministic tests

**+40**, 2,551 → **2,591**.

| Suite | Count | Covers |
|---|---|---|
| `relationshipBinding.test.ts` | 21 | attribution, destination, social, window, response funnel, login validation, **no-caller proof** |
| `relationshipObservation.test.ts` (db) | 19 | the actor-scoped lookup, one-baseline-per-JOIN, G6, RLS |
| `followBaseline.test.ts` (§162) | 16 | the Twitch lookup and readiness, unchanged |

Of the brief's 35 enumerated proofs, the ones exercisable without a client
caller or a live token are covered. The remainder — those requiring an OAuth
scope, a permission prompt or a real JOIN — belong to the next slices and are
listed in §184 rather than claimed here.

---

## 179. Mutation proofs

`npm run test:destruction` — **20 / 20 detected** (was 11; nine added).

| New lever | Result |
|---|---|
| treat a failed lookup as not-following | ✅ DETECTED |
| treat an empty result as unavailable | ✅ DETECTED |
| collapse `needs_follow_permission` into `needs_reauthorization` | ✅ DETECTED |
| stop binding the creator to the attribution | ✅ DETECTED |
| drop the baseline window | ✅ DETECTED |
| measure JOINs nobody else was part of | ✅ DETECTED |
| **return the follow result to the client** | ✅ DETECTED |
| drop the one-baseline-per-JOIN constraint | ✅ DETECTED |
| stop scoping the attribution lookup to the actor | ✅ DETECTED |

The first two are deliberately a mirrored pair. It is not enough that failure
does not become false; a genuine false must also not be discarded as failure,
and only testing one direction would leave the other free to break.

---

## 180. No-production-caller proof

Test-enforced, not asserted:

- no file under `src/` contains `action: 'relationship'`
- `supabaseBackend.ts` requests no scope — no `scopes:` key, no
  `user:read:follows`, no `user:read:subscriptions`
- no Edge Function mentions `user:read:subscriptions`

Written to fail loudly when the JOIN trigger is added deliberately, so widening
it is a decision somebody makes at that gate. One narrowing was needed: the
first matcher caught the Test Lab's unrelated `relationship` field for simulated
friendships, so it now matches the invocation shape specifically.

**This matters because the scope is not requested and the privacy policy does
not describe follow measurement.** A single caller would begin collecting a
Twitch-derived fact about people who were never told.

---

## 181. Regression results

| Gate | Result |
|---|---|
| `npm test` | ✅ **2,591 / 2,591** (103 files) |
| `tests/db` | ✅ 442 |
| lint / tsc / build | ✅ clean |
| `test:destruction` | ✅ 20/20 |
| `verify:analytics` | ✅ |

---

## 182. Known-debt delta

| Harness | Baseline | Now | Delta |
|---|---|---|---|
| `test:presence` | 0 / 21 | **0 / 21** | ✅ none |
| `test:layout` | 0 / 23 | **0 / 23** | ✅ none |
| `test:destruction` | 11 / 11 | **20 / 20** | ✅ none (grew) |
| `test:analytics` | 6 | **6** | ✅ none — its levers touch `analyticsHub.ts` and `togetherWatch.ts`, untouched here |
| `verify:lab` | 11 | **11** | ✅ none |

Source verified clean of harness residue after every run.

---

## 183. Remaining risks

| # | Risk | Position |
|---|---|---|
| 1 | The action has never run against real Twitch | Deterministic coverage is thorough; Phase 2 is the reminder that platforms surprise you. First real exercise belongs to the slice that adds the scope |
| 2 | The 120s window is a judgement, not a measurement | Wider than arrival, far short of "later". Revisit if real JOINs show the request landing outside it |
| 3 | `join_clicked` must reach the server before the action is called | It is flushed synchronously at JOIN, but the trigger slice must confirm the ordering rather than assume it |
| 4 | Scope-loss cleanup policy undecided | Deliberate — no observations exist yet, and the primitive is ready |
| 5 | Hosted schema ahead of deployed code | Harmless: an additive index and an uncalled function |

---

## 184. Next slice readiness

**Ready.** The server can measure; nothing asks it to.

The next slice is the authorization transition, and it should come **before** the
JOIN trigger: granting a permission nothing consumes is a worse experience than
not asking, and a trigger with no permission would only ever record
`needs_follow_permission`.

In order:

1. request `user:read:follows`, and the account-surface prompt that explains it
2. the existing-user transition using the four readiness states already built
3. the JOIN trigger at `recordJoin`, where an attribution is minted and
   `socialCount > 0` — the eligible population, with the attribution id already
   the idempotency key
4. analytics views: coverage, discovery percentage, dwell and arm linkage
5. privacy disclosure, deployed **before** the first observation
6. the owner's single OAuth interaction

**M3E-a remains HOLD.** No subscription scope, state or measurement exists
anywhere, and a test asserts it.

---

# M3D Slice C — the Twitch authorization transition

**Date:** 2026-08-31
**Type:** IMPLEMENTATION — deterministic work complete, **owner OAuth outstanding**
**Entering:** `73bf8c4` · 2,591/2,591 · hosted schema 33

---

## 185. Slice C verdict

## **DETERMINISTIC WORK COMPLETE — NOT YET GO**

Everything that can be proven without a real Twitch consent screen is built and
proven. The one remaining step is the owner's single authorization, and Slice C
is not GO until that is observed (§207).

M3D as a whole remains NOT GO regardless: no JOIN trigger exists, no analytics
views exist, and no observation can be produced by ordinary use.

| | |
|---|---|
| Scope delta | **`user:read:follows`**, requested only on deliberate grant |
| Existing users | **`needs_follow_permission`** — not broken, not signed out |
| Permission UX | account panel, one control |
| Ordinary sign-in | **unchanged** — asks for no extra scope |
| Relationship action deployed | **YES**, dormant |
| Production relationship callers | **ZERO**, test-enforced |
| Production observations | **ZERO** |
| Tests | 2,591 → **2,615** |
| Mutations | 20 → **23 / 23** |

---

## 186. Starting state

`73bf8c4`, clean · hosted schema 33 · relationship action implemented and
undeployed · no scope requested · the owner's stored credential carries
`scope_count: 1` — the pre-M3D state this whole slice is about.

---

## 187. OAuth architecture

The existing Supabase/Twitch flow performs the upgrade; **no second auth
architecture was created**. `startOAuth` gained one optional argument:

```ts
startOAuth(redirectTo: string, scopes?: string)
```

Ordinary sign-in passes nothing and is byte-for-byte unchanged in behaviour.
The scope is supplied only by the deliberate grant path, which is what keeps
"optional" true rather than merely stated.

The upgraded credential reaches storage through the **existing Phase 2 custody
flow** — `exchangeCode` already hands provider tokens to `twitch-credential`,
so the scoped credential is validated, identity-bound, encrypted and upserted by
exactly the code that handles an ordinary sign-in. There is no second credential
writer, and a test asserts the grant path contains no capture logic of its own.

---

## 188. Scope delta

**Exactly one: `user:read:follows`.**

Proven by search across the final source: the only occurrence is the
`FOLLOWS_SCOPE` constant in `src/background/auth.ts`.
`user:read:subscriptions` appears **nowhere** in `src/` or `supabase/` — zero
files — and a test asserts it.

---

## 189. Existing-user transition

The load-bearing distinction, and it is preserved end to end.

| Situation | State | What the user is told |
|---|---|---|
| valid credential, no follow scope | **`needs_follow_permission`** | an optional thing they can turn on |
| no credential / dead credential | `needs_reauthorization` | nothing about optional permissions |
| unknown status | `temporarily_unavailable` | nothing |
| scope present | `ready` | nothing — no prompt at all |

Somebody who signed in before M3D existed is **not** pushed through
account-repair UX, is not signed out, and is not told anything is wrong —
because nothing is. Mutation-proven: collapsing `needs_follow_permission` into
`needs_reauthorization` is DETECTED.

---

## 190. Permission UX

One control, in the account panel, beside Sign out and Delete account.

It says what is checked (*"whether you already follow a creator when you join
them through a friend"*), why (*"whether friends actually help people discover
creators they did not already watch"*), and that it is **optional** —
*"Everything in Watchside works without it, and it never changes who you
follow."*

Tests assert the copy never contains "required", "must grant", "you need to" or
"in order to use", and never mentions subscriptions, purchases, payments or
Bits. Those are the claims that would be untrue or would read as coercion.

---

## 191. Discoverability

**Where:** the account panel — somewhere people go deliberately.
**When:** only when readiness is `needs_follow_permission`.
**Never:** on startup, on a Twitch page, in onboarding, in a toast, or anywhere
near a JOIN.

That placement is the whole nag policy. A control that only appears where
somebody chose to look cannot interrupt anything, which is why no
frequency-capping machinery was needed.

Tests assert `MeasurementPermission` is rendered from exactly one place, that
`KickbackPanel` does not render it directly, and that nothing schedules
`grantFollowPermission` on a timer or an alarm.

---

## 192. Decline and cancel behaviour

**Declining costs nothing.** This is why the grant path is deliberately *not*
`signIn()`: sign-in treats cancellation as "end up signed out", which is right
for somebody who has not signed in and completely wrong for somebody who has.

| Situation | Result |
|---|---|
| closes the Twitch window | still signed in, **no error shown** — nothing went wrong |
| Twitch will not start the flow | still signed in, error surfaced |
| flow returns without the scope | still signed in, still `needs_follow_permission` |
| any failure | credential untouched, no sign-out, no deletion, retry available |

Mutation-proven: signing the user out on cancellation is DETECTED.

---

## 193. Nag and dismissal policy

"Not now" sets `followPermissionDismissed` in preferences and **collapses the
explanation to a single line** — `Help measure discovery` — which still grants
when clicked.

It is a dismissal, not a refusal: nothing records it as a decision, nothing
re-prompts on its own, and the path to granting later never disappears. The
alternative — hiding the control entirely — would have made the permission
ungrantable after one dismissal.

---

## 194. Credential upgrade

Through the existing flow, unchanged:

```
OAuth (with scope) → transient provider tokens in worker memory
  → authenticated custody handoff → Twitch validation → actor binding
  → encrypted upsert → granted scopes recorded → browser stripped by O7
```

`upsert` on `actor_id` means the upgraded credential **replaces** the old one
rather than accumulating.

---

## 195. Identity binding

Unchanged and still enforced. The upgraded credential is validated at
`id.twitch.tv/oauth2/validate`, its `client_id` must be Watchside's, and the
Twitch identity it names must be the one already in `connected_accounts` for
that actor. A mismatch is refused and **nothing is stored** — so an upgrade
cannot be used to swap in a different Twitch account.

---

## 196. Custody-failure behaviour

If OAuth succeeds but custody fails, readiness simply does not become `ready`,
and the control stays offered. Specifically: nothing pretends M3D is ready, no
provider credential is persisted browser-side (O7 strips it regardless), core
authentication is untouched, and the same control retries.

---

## 197. Trusted scope truth

**Readiness comes from the server, never from the client.**

`status` now returns `readiness`, computed from the **stored credential's
recorded scope set**. After a grant, the client re-reads it rather than assuming
the redirect meant yes.

This matters because **Twitch will complete an OAuth flow having granted fewer
scopes than were asked for**. A client-side "permission granted" boolean would
be wrong exactly when a user unticked something, and M3D would then look
permanently broken for them with no way to tell why. Mutation-proven: believing
the redirect instead of asking the server is DETECTED.

---

## 198. Relationship-action deployment

**Deployed: YES. Dormant.**

Deployment was necessary this slice: `status` had to return `readiness`, and the
client reads it. The relationship action shipped in the same function and is
reachable, but:

- no client path calls it (test-enforced, §199)
- without the scope it can only answer `needs_follow_permission`
- deploying changes no collection semantics — nothing invokes it

---

## 199. No-observation proof

**Production relationship callers: ZERO. Production observations: ZERO.**

- no file under `src/` contains `action: 'relationship'`
- no JOIN trigger exists
- the credential table shows one row (the owner's, `scope_count: 1`) and the
  observation table has no writer

No synthetic observation was created in production, so none needed cleaning up.

---

## 200. O7 and browser persistence

**Unchanged and still mutation-proven.** The stripping boundary is untouched,
and its lever remains in the harness. The upgrade path introduces no new storage
location — the scoped credential travels the same in-memory route to the same
custody endpoint.

Real confirmation after a scoped OAuth belongs to §207.

---

## 201. G6 and account deletion

**Untouched.** No deletion semantics were modified. Twitch deauthorization still
destroys the credential and Twitch-derived observations while preserving
Watchside's analytics; account deletion still destroys the credential first;
sign-out still deletes nothing. All still covered by the existing suites and
mutation levers.

---

## 202. Chrome impact

**No manifest change.** Permissions, host permissions and CSP are untouched — a
Twitch OAuth scope is not a Chrome extension permission, and conflating the two
would be a category error.

For an eventual v0.8 submission the privacy-practice answers will need to
describe the optional follow check, but only once collection is live. Nothing to
change now.

---

## 203. Firefox classification

**No new category required.** Declared categories remain exactly
`authenticationInfo`, `browsingActivity`, `personalCommunications`,
`websiteActivity`; `technicalAndInteraction` and `financialAndPaymentInfo`
remain zero. `scripts/manifest.mjs` is untouched, and nothing was uploaded — the
pending v0.6 review is undisturbed.

---

## 204. Privacy status

**No public change, and that is the correct answer.**

The deployed policy already discloses that Watchside stores an encrypted Twitch
authorization credential server-side, why, and how it is destroyed. This slice
adds an *optional permission request* and **zero collection**, so nothing in the
live text becomes false.

The explanatory copy a user needs lives where the decision is made — in the
permission control itself. The public M3D collection disclosure belongs
atomically with the trigger and the first production observation, and claiming
`following_at_join` collection now would describe something that does not
happen.

---

## 205. Deterministic tests

**+24**, 2,591 → **2,615**. `tests/extension/followPermission.test.tsx`:

who is offered it (four readiness states) · what the copy says and refuses to
say · dismissal collapsing rather than vanishing · dismissal not recorded as
refusal · rendered from exactly one place · never scheduled · exactly one scope
asked · **OAuth success alone does not assert ready** · ready only when the
server says so · uses the existing custody path · cancel leaves the session
intact · no sign-out or credential deletion on decline · start-failure survivable
· retry works · **ordinary sign-in asks for no extra scope** · no subscriptions
scope anywhere.

---

## 206. Mutation proofs

`npm run test:destruction` — **23 / 23 detected** (was 20).

| New lever | Result |
|---|---|
| believe OAuth succeeded rather than asking the server | ✅ DETECTED |
| sign the user out when they decline the permission | ✅ DETECTED |
| request the follow scope on ordinary sign-in | ✅ DETECTED |

The third is the one that would be easiest to ship by accident and hardest to
notice: everything would keep working, and every user would silently be asked
for a measurement permission in order to sign in.

---

## 207. Real authorization flow — OUTSTANDING

**This is the remaining step, and it needs the owner.**

The owner's stored credential currently reports `scope_count: 1`, so they are in
`needs_follow_permission` — the exact state the transition exists for. That
makes them the right and only test subject.

**Minimal action required:**

1. `chrome://extensions` → **Reload** Watchside
2. Open the Watchside panel → **account** (the avatar/account control)
3. Find **"Help measure discovery"** / **"Allow on Twitch"**
4. Click it and complete the Twitch authorization
5. Say so here

No devtools, no tokens, no revocation, no storage editing.

**What will then be verified, automatically and shape-only:** OAuth completed ·
same Twitch identity still connected · custody handoff succeeded ·
`user:read:follows` present in the stored scope set · readiness `ready` ·
provider tokens absent from browser storage · Supabase session intact · core UI
working · **no observation created** · no JOIN trigger · no subscriptions scope.

Until that is observed, **Slice C is not GO** and this section is the reason.

---

## 208. Regression results

| Gate | Result |
|---|---|
| `npm test` | ✅ **2,615 / 2,615** (104 files) |
| lint / tsc / build | ✅ clean |
| `test:destruction` | ✅ 23/23 |
| Hosted schema | 33, unchanged — **no migration needed** |

---

## 209. Known-debt delta

| Harness | Baseline | Now | Delta |
|---|---|---|---|
| `test:presence` | 0 / 21 | **0 / 21** | ✅ none |
| `test:layout` | 0 / 23 | **0 / 23** | ✅ none |
| `test:destruction` | 20 / 20 | **23 / 23** | ✅ none (grew) |
| `test:analytics` | 6 | **6** | ✅ none — untouched files |
| `verify:lab` | 11 | **11** | ✅ none |

---

## 210. Remaining risks

| # | Risk | Position |
|---|---|---|
| 1 | The scoped OAuth has never run | §207. It is the whole outstanding item |
| 2 | Discoverability may be too quiet | Deliberate. One control in a panel people open on purpose. If coverage turns out too low to measure anything, that is a data-driven reason to revisit — not a reason to nag first |
| 3 | Twitch may grant partial scopes | Handled: readiness comes from the stored scope set, so a partial grant reads as `needs_follow_permission` and the control stays offered |
| 4 | Relationship action is deployed and reachable | Dormant: no caller, and without the scope it can only refuse |
| 5 | A future trigger could bypass the readiness gate | The action re-checks readiness itself, so the gate is not the caller's responsibility |

---

## 211. Next-slice readiness

Blocked on §207 only.

Once the owner's authorization is observed, the next slice is the **JOIN
trigger**: fire the relationship action at `recordJoin` where an attribution is
minted and `socialCount > 0`, respecting the 120-second baseline window, with
the attribution id already serving as the idempotency key.

That slice is also where the **public privacy disclosure must ship atomically**
with the first production observation, and where the no-caller test is turned
off deliberately rather than quietly.

**M3E-a remains HOLD.** No subscription scope, state or measurement exists, and
a test asserts it.

---

# SLICE C — PRODUCT CORRECTION

*Appended 2026-08-31, after human product review and before acceptance.
§185–§211 are left exactly as they were: they are the record of what was built
and why it was rejected, and overwriting them would erase the reason this
section exists.*

## 212. What was rejected

The Slice C implementation recorded in §185–§211 made the **account panel the
only place `user:read:follows` could be discovered or granted**. Every
deterministic gate passed. The mutation harness was green. The section that
mattered, §207, asked the owner to reload, open the account panel, find "Help
measure discovery", and click it.

The owner reloaded, used Watchside, and reported:

> "All i did was sign in. didnt see anything else"

That is the finding. A permission nobody encounters is not an optional
permission — it is an absent one, and no amount of green testing detects that,
because every test was written against the rejected model.

**The rejection is a PRODUCT rejection, not a defect report.** The code did what
it was designed to do. The design was built around the pre-M3D beta cohort — a
handful of accounts whose Twitch authorization predates this scope — and
mistook that cohort's migration path for the permanent product. It answered
"how do these few people upgrade" and never answered "what does a new user
experience", which is the question that governs every user Watchside will ever
have after M3D ships.

The steady state it implied was:

```
install → sign in → (some time later) → discover a setting → second OAuth
```

Two authorization trips, the second one dependent on somebody going looking for
a thing they have never heard of. That is not a defensible normal flow.

## 213. The approved model

```
NEW USER      install → Sign in with Twitch → one consent screen,
                        including user:read:follows → custody → ready

LEGACY USER   already signed in, credential predates the scope
                     → needs_follow_permission
                     → ONE prominent invitation on the main panel surface
                     → Continue with Twitch → existing custody → ready
                     → or "Not now", which ends the asking
```

The permission remains **optional from Watchside's side**, and that word is now
carrying its real meaning rather than a euphemism for "hidden":

* Twitch will complete an authorization having granted less than was asked for.
* When it does, sign-in still succeeds, Watchside still works completely,
  readiness resolves to `needs_follow_permission`, M3D stays unavailable, and
  **no relationship observation is fabricated**.
* What changed is only that Watchside now *asks*, once, where somebody is
  already deciding what to authorize.

Asking on the consent screen somebody was always going to see costs them
nothing and is more honest than a permission they must trip over later.

## 214. New-user OAuth — the scope construction

Scope construction is now a **value and a function**, not a string literal at a
call site, so it can be asserted rather than grepped:

`src/background/auth.ts`

```ts
export const FOLLOWS_SCOPE = 'user:read:follows'
export const REQUESTED_SCOPES: readonly string[] = [FOLLOWS_SCOPE]
export function scopeRequest(scopes: readonly string[] = REQUESTED_SCOPES): string {
  return scopes.join(' ')
}
```

Both authorizations call the same builder:

| Call site | Request |
| --- | --- |
| `signIn()` — every new user | `startOAuth(deps.redirectUrl, scopeRequest())` |
| `grantFollowPermission()` — legacy upgrade | `startOAuth(deps.redirectUrl, scopeRequest())` |

There is now **no** `startOAuth(deps.redirectUrl)` without a scope argument
anywhere in the file, and a test asserts that absence. One construction, two
call sites: a scope added for new users is *by construction* the same scope
offered to existing ones, and they cannot drift apart.

`user:read:email` is deliberately **not** in the list. It is Supabase's own
Twitch provider scope; restating it would make `REQUESTED_SCOPES` look like the
complete request when it is only Watchside's addition to it. A test asserts it
stays absent for that reason.

**Proven by construction, not by string search** (§221):

```
REQUESTED_SCOPES              deep-equals ['user:read:follows']
scopeRequest()                === 'user:read:follows'
scopeRequest()                does not contain 'subscriptions'
signIn() → backend.scopesAsked  deep-equals ['user:read:follows']
```

The last of those exercises the real `createAuthService` state machine through
a fake backend and asserts what the OAuth layer was actually handed — not what
the source file says.

## 215. The migration prompt

New file: `src/ui/components/MeasurementInvitation.tsx`.
Rendered in exactly one place: `src/ui/KickbackPanel.tsx`, at the top of the
signed-in panel body, above the "friends are here" banner and above the tabs.

**Where it is not:** not a modal, not a portal, not an overlay, not fixed
position, no z-index, no `useEffect`, no timer. It is ordinary flow content in
the panel body. That is not a stylistic preference — it is the mechanism by
which it *cannot* land between a JOIN click and arriving on Twitch, and a test
asserts each of those absences against both the component and its CSS block.

**Gating.** It renders for exactly one readiness value:

| Readiness | Invited | Why |
| --- | --- | --- |
| `needs_follow_permission` | **yes** | the migration cohort |
| `ready` | no | nothing to ask for |
| `needs_reauthorization` | no | genuinely broken; an optional-permission story sends them down entirely the wrong path |
| `temporarily_unavailable` | no | Watchside's problem, not theirs |
| `null` (could not ask) | no | unknown ≠ not permitted; a network blip must never manufacture a consent prompt |

The copy, in Watchside's voice:

> **Help measure creator discovery**
>
> When you join a creator through a friend, Watchside can check whether you
> already follow them. It is how we find out whether friends genuinely help
> people discover someone new.
>
> Optional. Everything in Watchside works without it, and it never changes who
> you follow.
>
> `[Continue with Twitch]` `[Not now]`

Tests assert the copy never contains "required", "must grant", "you need to",
"in order to use", or any of "subscription", "purchase", "payment", "bits".

## 216. Dismissal

"Not now" writes `followPermissionDismissed: true` through the existing
preferences service, which persists to `chrome.storage.local`. The invitation
then returns `null` — **not "less often", not "next session": it stops.**

Dismissal is a **dismissal, not a refusal**. Nothing records it as a decision
about the permission, nothing reports it to the server, and it does not close
any door. What it ends is Watchside's asking.

One flag governs both surfaces, so "not now" is answered once and honoured
everywhere: the main-surface invitation disappears entirely, and the account
panel's block collapses to its one-line form.

Anti-nag proof:

```
invitation(needs_follow_permission, dismissed=true)   renders ''
MeasurementInvitation.tsx contains no setTimeout / setInterval / useEffect
preferences.ts persists followPermissionDismissed, defaults false
```

## 217. The account fallback

`MeasurementPermission` in `AuthStates.tsx` **remains, unchanged in behaviour**,
and its doc comment has been rewritten to say what it now is:

* It is **not** the discovery mechanism. It was, and that was the error.
* It **is** the deliberate way back — stable precisely *because* the invitation
  never returns on its own. Somebody who said "not now" and later changed their
  mind needs somewhere to go that does not depend on being prompted again.

Status: **fallback / manual control surface. Retained.**

## 218. Twitch scope delta

| | |
| --- | --- |
| Scopes added, all authorizations | **`user:read:follows` — exactly one** |
| `user:read:subscriptions` | **absent** |
| Any write scope | absent |
| Shipped background bundle | `user:read:follows` ×1, `user:read:subscriptions` ×0 |
| Shipped content bundle | `user:read:subscriptions` ×0 |

The absence of a subscription scope is asserted across six source files, both
built bundles, and a dedicated mutation lever that adds it and must be caught.

## 219. What was preserved

This is a product-flow correction. Correct infrastructure was **not** rewritten:

* four-state readiness, and `needs_follow_permission ≠ needs_reauthorization`
* trusted server-side scope truth — the server, not the redirect, decides
* the Phase 2 custody path, unchanged; both authorizations end at the single
  `handOffTwitchCredential(supabase, data.session)` call site, and a test pins
  that there is exactly one
* O7 browser-persistence stripping, untouched
* decline/cancel safety — backing out never costs a session
* identity binding
* no JOIN interruption
* zero production relationship callers, zero production observations
* Chrome MV3 / Firefox MV3 parity (`verify:firefox` clean, reproducible build)

## 220. Temporary diagnostic

The `[SLICE-C] measurement readiness:` `console.info` was added to debug the
**rejected** acceptance flow. It has been **removed**. Verified absent from
source and from both shipped bundles:

```
grep -c 'SLICE-C'  dist/kickback-background.js   0
grep -c 'SLICE-C'  dist/kickback-content.js      0
```

No permanent operational reason to retain it: readiness is a state the account
panel and the invitation both render, so the console adds nothing a user or the
owner cannot already see.

## 221. Deterministic tests

Full suite: **104 files, 2,634 tests, 0 failures.**
`tests/extension/followPermission.test.tsx`: **43 tests**, rewritten around the
corrected model.

| # | Requirement | Where |
| --- | --- | --- |
| 1 | new initial OAuth requests `user:read:follows` | "asks Twitch for the measurement scope during the initial authorization" |
| 2 | new user granted → `ready` | "lands ready when Twitch grants it, with no second trip" |
| 3 | new user not granted → functional, `needs_follow_permission` | "still signs them in when Twitch grants less than was asked for" |
| 4 | legacy user resolves `needs_follow_permission` | "resolves to needs_follow_permission, not to broken" |
| 5 | legacy user sees the migration prompt | "is invited on the surface they are already looking at" |
| 6 | `ready` never prompted | "invites nobody who is already measured" |
| 7 | `needs_reauthorization` never prompted | "invites nobody whose authorization is actually broken" |
| 8 | "Not now" dismisses | "offers a way to decline that is not a dead end" |
| 9 | dismissal stops repeat prompting | "stops appearing once it has been waved away" + "nothing re-raises it on a schedule or a page change" |
| 10 | dismissal keeps the Account path | "keeps a one-line grant control in the account panel" |
| 11 | legacy user can grant later | "can grant it later, and the server is what says so" |
| 12 | legacy grant uses existing custody | "uses the existing custody path rather than a second writer" + "shares one handoff with the ordinary sign-in" |
| 13 | JOIN never interrupted | "is ordinary panel content, not an overlay that can catch a click", "renders in exactly one place, and it is not the JOIN path", "no JOIN surface asks for the permission" |
| 14 | `provider_token` absent from browser persistence | `providerCredentialStripping` suite + handoff pin |
| 15 | `provider_refresh_token` absent | same |
| 16 | Supabase session persists | "leaves the person signed in when they back out", "does not sign them out, and does not touch their credential" |
| 17 | zero production relationship callers | "nothing in the extension invokes the relationship action" |
| 18 | zero production observations | no caller exists to create one (17); confirmed against the database at acceptance |
| 19 | `user:read:follows` is the only delta | "asks for nothing beyond that one scope", "requests user:read:follows and nothing else, anywhere" |
| 20 | `user:read:subscriptions` absent | "never asks for a subscription scope anywhere in the source" + bundle grep |

## 222. Mutation proofs

`npm run test:destruction` — **26 of 26 detected** (was 23; four levers added,
one inverted lever removed).

Removed, because it encoded the rejected model:

* ~~`auth: request the follow scope on ordinary sign-in`~~ — this lever
  previously *proved* that ordinary sign-in did **not** request the scope. That
  is now the bug, not the guarantee.

Added:

| Lever | Caught by |
| --- | --- |
| `auth: drop the follow scope from the initial sign-in` | asks Twitch for the measurement scope during the initial authorization |
| `auth: widen the requested scope set` (adds `user:read:subscriptions`) | asks for nothing beyond that one scope |
| `invite: prompt somebody whose authorization is broken` | invites nobody whose authorization is actually broken |
| `invite: keep asking after "Not now"` | stops appearing once it has been waved away |

The two important new constructions — the new-user scope set and the
legacy-prompt gating — are therefore mutation-proven, not merely asserted.

## 223. Shipped-bundle evidence

```
dist/kickback-background.js   user:read:follows ×1   subscriptions ×0   SLICE-C ×0
dist/kickback-content.js      kb-invite ×24
                              "Help measure creator discovery" ×2
                              "Continue with Twitch" ×2   "Not now" ×2
                              subscriptions ×0   SLICE-C ×0
relationship action           ×0 in both bundles
```

`npm run verify:firefox`: clean; reproducible; no leaks; no secrets.
`npx eslint .`: clean. `tsc -b`: clean.

## 224. Production callers and observations

| | |
| --- | --- |
| Production relationship callers | **ZERO** — asserted across five source files |
| Production observations | **ZERO** — no caller exists to create one |
| JOIN trigger | not wired; still the next slice |

Nothing in this correction moves M3D closer to writing a row. It changes only
*who is asked for the permission, and where*.

## 225. Real acceptance — OUTSTANDING

The owner's account is exactly the legacy cohort, so the acceptance path is the
**migration** path, and it no longer requires hunting through settings.

**Owner action:**

1. `chrome://extensions` → **Reload** Watchside
2. Open Watchside on a Twitch page, as normal
3. The invitation appears at the top of the panel: **"Help measure creator
   discovery"**
4. Click **Continue with Twitch** and authorize
5. Return to Watchside

Then verified automatically, shape only, no credential values:

* same Twitch identity
* custody handoff succeeded
* stored trusted scopes contain `user:read:follows`
* readiness = `ready`
* `provider_token` browser persistence — absent
* `provider_refresh_token` browser persistence — absent
* Supabase session intact
* zero relationship observations
* zero production JOIN relationship callers

## 226. Corrected Slice C verdict

**NOT GO.**

Every deterministic gate passes and the product model is corrected, but Slice C
was never blocked on determinism — it was blocked on a real authorization
through the real flow, and the flow it must now be proven through is the
corrected one. §225 is the whole remaining item.

Recorded explicitly, because it is the most useful thing in this section: **the
original Account-only discoverability model was rejected during human product
review, before acceptance, on evidence a fully green test suite could not
produce.** The suite proved the control worked. The owner proved nobody would
ever find it. Both were true, and only one of them mattered.

---

# SLICE C — SCOPE REDUCTION

*Appended 2026-08-31, immediately after §212–§226. Those sections stand: they
are the record of a design that was built, reviewed, and then judged not worth
keeping. This section is the second half of that judgement.*

## 227. The decision

**The automatic legacy migration UX is intentionally removed.** Not deferred
pending a fix, not disabled behind a flag — deleted, along with the state it
carried and the tests that proved it.

**Reason: approximately three active pre-M3D beta users.**

§212–§226 corrected a real product error: `user:read:follows` had been reachable
only from the account panel, and the owner signed in and saw nothing. The
correction had two independent halves, and only one of them was load-bearing:

| Half | Serves | Verdict |
| --- | --- | --- |
| Request the scope in the initial OAuth | **every future user** | **kept — this is the product contract** |
| Prominent one-time invitation + dismissal | ~3 beta accounts, once | **removed** |

The second half was correct, tested, and mutation-proven. It was also a prompt
system — placement, gating across four readiness states, persisted dismissal, an
anti-nag guarantee, and a component whose non-interference with JOIN had to be
asserted in three separate ways — built to carry roughly three people across a
one-time threshold they can cross by clicking one button.

That is the overengineering. The migration is real; the machinery is not
proportionate to it. **The beta cohort will be asked to reauthorize once,
explicitly, by a human — which is what one does with three users.**

This is a deliberate trade recorded as such, not an unresolved defect: the
invitation was removed *because* the flow it fixed no longer needs fixing for
anybody but a cohort that only shrinks.

## 228. What was removed

| Removed | Why it existed |
| --- | --- |
| `src/ui/components/MeasurementInvitation.tsx` (deleted) | the automatic legacy prompt |
| its render site in `KickbackPanel.tsx` | placement on the main surface |
| `.kb-invite*` CSS block | styling for that prompt |
| `followPermissionDismissed` — `preferences.ts`, `client/types.ts`, both UI call sites, 6 test fixtures | dismissal memory, legacy-only |
| the "Not now" button in the account control | dismissal, legacy-only |
| the collapsed one-line account variant | what dismissal collapsed *to* |
| invitation and dismissal tests | proved the removed machinery |
| mutation levers `invite: prompt somebody whose authorization is broken`, `invite: keep asking after "Not now"` | guarded the removed machinery |
| `[SLICE-C]` console diagnostic | already removed in §220; re-verified absent |

A side effect worth recording: the new `.kb-invite` class **collided with the
pre-existing `.kb-invite` friend-invite-link styles** already in
`kickback.css`. Deleting the block resolved a real bug that the deterministic
suite did not catch, because no test rendered both surfaces together.

Asserted, not assumed. `MeasurementInvitation.tsx` is proven absent from disk,
and `followPermissionDismissed` is proven absent from four source files, by
tests that fail if either returns.

## 229. What was preserved

Everything the reduction was not about:

* **`user:read:follows` in the normal initial OAuth** — the product contract
* **`needs_follow_permission` as a truthful server readiness state** — never
  collapsed into `needs_reauthorization`, never inferred client-side, never
  allowed to mean "broken"
* Phase 2 secure credential custody — unchanged; both authorizations still end
  at the single `handOffTwitchCredential(supabase, data.session)` call site
* O7 browser-persistence stripping
* G6 deletion boundary
* identity binding
* trusted server-side scope truth — the server decides, never the redirect
* core Watchside works completely when the scope is unavailable
* **zero automatic relationship observations**
* **zero JOIN relationship callers**
* `user:read:subscriptions` absent · `user:read:emotes` absent
* Chrome MV3 / Firefox MV3 parity

## 230. Steady-state OAuth — the product contract

```
install → Sign in with Twitch → one consent screen (incl. user:read:follows)
        → secure custody → readiness = ready → use Watchside
```

Scope construction is a value and a builder, so it is asserted rather than
grepped:

```ts
export const FOLLOWS_SCOPE = 'user:read:follows'
export const REQUESTED_SCOPES: readonly string[] = [FOLLOWS_SCOPE]
export function scopeRequest(scopes = REQUESTED_SCOPES): string { return scopes.join(' ') }
```

Both `signIn()` and `grantFollowPermission()` call `scopeRequest()`; no bare
`startOAuth(deps.redirectUrl)` exists anywhere, and a test asserts that absence.
One construction, two call sites — they cannot drift.

**Optional keeps its meaning.** If Twitch returns without the scope: sign-in
succeeds, Watchside works completely, readiness resolves honestly to
`needs_follow_permission`, M3D stays unavailable, and **nothing is fabricated**.

`user:read:email` is deliberately absent from the list — it is Supabase's own
Twitch provider scope, not Watchside's to restate.

## 231. Beta reauthorization mechanism

The **existing account control**, and nothing new:

```
Watchside panel → account (avatar) → "Allow on Twitch" → Twitch OAuth → return
```

It renders for `needs_follow_permission` only, and for nobody else — a user who
is `ready`, `needs_reauthorization`, `temporarily_unavailable`, or whose
readiness could not be read sees nothing at all. For everyone who authorizes
after M3D it therefore renders nothing, ever.

Explicitly **not** designed as a product feature. It is an explicit one-time
beta migration procedure, and it is not the expected future-user flow.

Safety properties, all test-asserted:

* no sign-out first — `signOut` is never called
* no account deletion — `deleteAccount` is never called
* no manual storage or token manipulation
* the session survives; cancelling costs nothing and reports no error
* the upgraded credential goes through the **existing** custody path

## 232. Twitch scopes

| Scope | Status |
| --- | --- |
| `user:read:follows` | requested — initial OAuth and reauthorization alike |
| `user:read:email` | Supabase's provider scope, not restated by Watchside |
| `user:read:subscriptions` | **ABSENT** — 6 source files, both bundles, 1 mutation lever |
| `user:read:emotes` | **ABSENT** — 6 source files, both bundles |
| any write / moderation scope | absent |

## 233. Deterministic tests

Full suite: **104 files, 2,627 tests, 0 failures.**
`followPermission.test.tsx`: **36 tests** (was 43 — the invitation and dismissal
tests went with the machinery they proved).
`tsc -b` clean · `eslint` clean · `verify:firefox` clean and reproducible.

The proof the owner asked to survive every UX decision, exercised through the
real `createAuthService` state machine against a fake backend — asserting what
the OAuth layer was **handed**, not what a source file says:

> **"asks Twitch for the measurement scope during the initial authorization"**
> `signIn()` → `backend.scopesAsked` deep-equals `['user:read:follows']`,
> contains neither `subscriptions` nor `emotes`.

Plus, by construction:

```
REQUESTED_SCOPES  deep-equals ['user:read:follows']
scopeRequest()    === 'user:read:follows'
scopeRequest()    contains none of: subscriptions, emotes, moderat, edit, manage
```

Acceptance items 1–12 map to: the readiness assertions above (2, 3), the shared
custody-handoff pin (1, 4), the `providerCredentialStripping` suite plus the
storage-strip pin (5, 6), the never-signs-out test (7, 8), the no-caller test
(9, 10), and the scope sweep (11, 12) — with the runtime half of 1–9 confirmed
at real acceptance (§234).

## 234. Mutation proofs

`npm run test:destruction` — **25 of 25 detected** (was 26; two invitation
levers removed, one retargeted to the account control).

| Lever | Caught by |
| --- | --- |
| `auth: drop the follow scope from the initial sign-in` | asks Twitch for the measurement scope during the initial authorization |
| `auth: widen the requested scope set` (adds `user:read:subscriptions`) | asks for nothing beyond that one scope |
| `auth: believe OAuth succeeded rather than asking the server` | does not call itself ready just because OAuth came back |
| `auth: sign the user out when they decline the permission` | leaves the person signed in when they back out |
| `account: offer the permission to somebody whose authorization is broken` | is offered to nobody whose authorization is actually broken |
| `o7: persist the session without stripping` | strips both when a real sign-in carries both |

The two things that still matter — **the new-user scope set** and **the readiness
gate on the only remaining control** — remain mutation-proven.

## 235. Shipped-bundle evidence

```
dist/kickback-background.js   user:read:follows ×1
                              subscriptions ×0   emotes ×0   SLICE-C ×0
                              followPermissionDismissed ×0
dist/kickback-content.js      "Allow on Twitch" ×1   kb-permission ×5
                              kb-invite-title ×0   "Help measure creator discovery" ×0
                              subscriptions ×0   emotes ×0   SLICE-C ×0
                              followPermissionDismissed ×0
relationship action           ×0 in both bundles
```

## 236. Production callers and observations

| | |
| --- | --- |
| Production relationship callers | **ZERO** — asserted across five source files, ×0 in both bundles |
| Production observations | **ZERO** — no caller exists to create one |
| JOIN trigger | not wired |

Slice C changes who is asked for a permission. It does not move M3D one step
closer to writing a row.

## 237. Real acceptance — OUTSTANDING

The owner's account is pre-M3D, so this is the one-time beta reauthorization.

**Owner action:**

1. `chrome://extensions` → **Reload** Watchside
2. Open the Watchside panel → click your **avatar** (account)
3. Click **"Allow on Twitch"** and complete the Twitch authorization
4. Return to Watchside and say so

No settings hunting beyond the account panel, no devtools, no tokens, no
revocation, no sign-out, no deletion.

Then verified automatically, shape only, no credential values:

1. same Twitch identity remains connected
2. `user:read:follows` present in trusted stored scopes
3. readiness = `ready`
4. secure custody succeeded
5. `provider_token` absent from persistent browser storage
6. `provider_refresh_token` absent from persistent browser storage
7. Supabase session remains functional
8. Watchside remains functional
9. production relationship observations remain ZERO
10. production JOIN relationship callers remain ZERO
11. `user:read:subscriptions` remains absent
12. `user:read:emotes` remains absent

## 238. Slice C status

**NOT GO — pending the one-time real reauthorization (§237).**

Every deterministic gate passes. Slice C was never blocked on determinism; it
is blocked on one real Twitch authorization through the real flow, which is the
only thing that can prove custody, scope storage and readiness together.

**Slice C goes GO once §237 passes.** Nothing else is outstanding.

**Slice D is not started**, per instruction. The JOIN trigger, the M3D analytics
views, and the public privacy disclosure — which must ship atomically with the
first production observation — all remain ahead.

Recorded for the next person reading this file: **two UX designs were built and
removed here, and the deterministic proof that outlived both is a single
assertion about what the initial OAuth requests.** That is the part that was
always the product. The rest was a migration for three people.

---

# SLICE C — REAL ACCEPTANCE

*Appended 2026-08-31. §185–§238 stand unchanged.*

## 239. The consent screen that did not appear

The owner completed the OAuth round trip and was returned signed in **without
seeing a Twitch consent screen**.

That is expected, not a failure. Twitch shows a consent screen when an
authorization asks for something the user has not already granted to that
client. The owner granted `user:read:follows` during earlier Slice C testing, so
the request was already satisfied and Twitch returned immediately.

It is recorded here because the absence of a consent screen is exactly the kind
of observation that invites a wrong conclusion in both directions — "nothing
happened" or "it silently granted something". Neither is checkable from the
browser. **The only sound way to settle it is to read what the server actually
stores**, which is what §240 does, and it is the reason §197 made scope truth
server-side in the first place.

## 240. What production actually holds

Read through the owner-gated `credential_shape` action. Shape only: no token, no
byte of any envelope, no follow state.

```json
{
  "rows": 1,
  "observations": 0,
  "shapes": [{
    "bytes": 125,
    "format_version": 1,
    "key_version": 1,
    "status": "active",
    "scope_count": 2,
    "has_follows_scope": true,
    "unexpected_scopes": 0,
    "readiness": "ready",
    "created_at": "2026-08-31T19:33:16.905466+00:00",
    "updated_at": "2026-08-31T22:24:02.721+00:00",
    "longest_printable_run": 5
  }]
}
```

### Why the diagnostic had to be extended first

The previously deployed version returned `scope_count` and no more. At §199 that
count was **1**; it is now **2**. That is a genuine change and it is *not* proof:
two scopes could be any two.

Marking Slice C GO on "the count went up, and `user:read:follows` is the only
scope our source ever requests" would have been an **inference dressed as an
observation** — precisely the failure §197 exists to prevent. So
`credential_shape` was extended, owner-gated as before, to answer the question
directly.

Two design notes worth keeping:

* **`unexpected_scopes` is an allowlist count, not a denylist.** Checking for a
  named forbidden scope would have (a) put that scope string in the source,
  where a test rightly refuses to see it, and (b) only ever caught scopes
  somebody thought to name. Counting everything outside the two Watchside asks
  for catches any scope at all, including ones that do not exist yet. The test
  suite caught the first draft doing this the wrong way.
* **`observations` is counted with `head: true`** — PostgREST returns the count
  and no rows, so the diagnostic cannot return anybody's follow state even by
  accident. That column is the one thing the whole boundary exists to protect.

## 241. Acceptance conditions

| # | Condition | Result | How it was established |
| --- | --- | --- | --- |
| 1 | same Twitch identity remains connected | **PASS** | `rows: 1`, keyed by `actor_id` (primary key). `created_at` 19:33 UTC, `updated_at` 22:24 UTC — the **same row upgraded in place**, not replaced. Capture verifies the Twitch identity against the one already connected to the actor (§195); a mismatched credential could not have written this row. |
| 2 | trusted stored scopes contain `user:read:follows` | **PASS** | `has_follows_scope: true`, read from the stored credential |
| 3 | readiness | **`ready`** | server-computed by the same `readinessFor` the `status` action uses |
| 4 | secure credential custody succeeded | **PASS** | `format_version: 1`, `key_version: 1`, 125 bytes, `longest_printable_run: 5` — AES-256-GCM envelope, no plaintext run. `status: active`. |
| 5 | `provider_token` absent from persistent browser storage | **PASS (ATTRIBUTED)** | see §242 |
| 6 | `provider_refresh_token` absent from persistent browser storage | **PASS (ATTRIBUTED)** | see §242 |
| 7 | Supabase session remains functional | **PASS** | the owner returned signed in; no re-authentication was required |
| 8 | Watchside remains functional | **PASS** | owner-observed; realtime, presence and metadata all connected |
| 9 | production relationship observations remain ZERO | **PASS** | `observations: 0`, counted in production |
| 10 | production relationship callers remain ZERO | **PASS** | 0 occurrences of `action: 'relationship'` under `src/`; 0 in both shipped bundles; test-enforced |
| 11 | `user:read:subscriptions` absent | **PASS** | `unexpected_scopes: 0`; 0 in both bundles; 0 in source |
| 12 | `user:read:emotes` absent | **PASS** | `unexpected_scopes: 0`; 0 in both bundles; 0 in source |

Shipped bundles:

```
kickback-background.js   follows=1  subscriptions=0  emotes=0  relationship=0  SLICE-C=0
kickback-content.js      follows=0  subscriptions=0  emotes=0  relationship=0  SLICE-C=0
```

Deterministic gates at acceptance: **2,627 tests / 104 files, 0 failures**;
**25/25 mutations DETECTED**; `tsc -b` clean; `eslint` clean.

## 242. Items 5 and 6, stated honestly

`chrome.storage.local` is on the owner's machine and cannot be read from here.
By owner decision, these two are accepted on the **proven boundary** rather than
a fresh browser observation:

* `stripProviderCredentials` is the only writer of the Supabase session into
  storage, and it strips on **both** `setItem` and `getItem` — a session that
  somehow arrived dirty is rewritten clean on the next read
* its mutation lever, `o7: persist the session without stripping`, is
  **DETECTED**
* the owner completed this OAuth round trip on **this exact build**, so any
  regression would have written a credential to disk within the last hour

**This is ATTRIBUTED, not OBSERVED**, and it is labelled that way deliberately.
It is the same status §200 assigned it, and it is the one acceptance item on
this list that a database read cannot settle. A permanent in-worker self-check
that counts (never prints) provider-credential keys at startup would convert it
to OBSERVED, and remains available if it is ever wanted.

## 243. What was deployed

`supabase functions deploy twitch-credential`.

The change is confined to the **owner-gated** `credential_shape` branch, which
is reachable only with `TWITCH_EVENTSUB_ADMIN_TOKEN` and is checked before any
user path. No user-facing behaviour changed: `capture`, `status`, `ensure_fresh`
and `relationship` are untouched, and the relationship action remains dormant
with no caller.

This diagnostic is **retained, not temporary**. It is the only way to check the
claim the entire custody design rests on — that the column holds ciphertext and
nothing else — against production rather than against a reading of the code. It
returns counts, booleans, byte lengths and timestamps, and never a value.

Not to be confused with the `[SLICE-C]` console diagnostic, which was temporary,
served a rejected UX, and was removed at §220.

## 244. Slice C verdict

# GO

All twelve acceptance conditions pass. Ten are OBSERVED against production; two
(items 5 and 6) are ATTRIBUTED to a mutation-proven boundary by owner decision,
and are labelled as such above rather than rounded up.

What Slice C delivered, after two rejected UX designs:

* new authorizations request `user:read:follows` on the ordinary Twitch consent
  screen — the product contract
* `needs_follow_permission` is a truthful server-computed state, distinct from
  `needs_reauthorization`, never inferred client-side
* the pre-M3D beta cohort upgrades through one account control, using the
  existing Phase 2 custody path
* the owner's own credential is now `ready`, in place, with exactly the scopes
  Watchside asks for and nothing else

What Slice C deliberately did **not** deliver: any measurement. Zero relationship
callers, zero observations. M3D can now be built; it has not been.

## 245. Not started

**Slice D is not started**, per instruction.

Still ahead, and unchanged: the JOIN trigger at `recordJoin` (attribution
minted, `socialCount > 0`), the M3D analytics views, and the **public privacy
disclosure, which must ship atomically with the first production observation**.
The no-caller test is to be turned off deliberately at that point, and never
quietly.

---

# M3D SLICE D — the eligible JOIN trigger

*Appended 2026-08-31. §1–§245 stand unchanged.*

## 246. Slice D verdict

## **DETERMINISTIC WORK COMPLETE — NOT YET GO**

Every deterministic gate passes, the privacy disclosure is **live**, and the
production trigger is built, wired and shipped in the local build. What has not
happened is the one thing that matters: **a real socially attributed JOIN has
not yet been performed, so no production observation exists.** §259 is the whole
remaining item.

Production observations at the time of writing: **0**, read from production.

**M3D as a whole remains NOT GO.** Slice D establishes trustworthy raw baseline
collection. It publishes no metric and computes no rate; that is Slice E.

## 247. Accepted precondition

Slice C is **GO** at `2b71bd3`, on the production evidence recorded at §239–§244:
`has_follows_scope: true`, `readiness: ready`, credential upgraded in place,
observations 0, callers 0, custody intact, subscriptions and emotes absent.
Re-read at the start of this slice and unchanged.

Nothing in Slice C was reopened. No consent-screen behaviour, migration UX,
discoverability, additional scope, second account or reauthorization work was
touched.

## 248. Starting state

| | |
| --- | --- |
| commit | `2b71bd3` |
| hosted schema | 33 |
| production observations | 0 |
| production relationship callers | 0 |
| tests | 2,627 / 104 files |
| mutations | 25/25 |
| known debt | analytics 6 · presence 0 · layout 0 · lab 11 |

## 249. The canonical JOIN trigger

No second definition of a social JOIN was invented. The trigger consumes the
existing `join_clicked` + `attribution_id` model, and fires from exactly one
place: `recordJoin` in `analyticsHub.ts`, immediately after the canonical event
has been flushed.

Eligibility is a **pure function**, `decideMeasurement`, deliberately separated
from the code that acts on it so every refusal is testable and mutable in
isolation:

```ts
if (!navigated)                 return 'not_navigated'
if (!attributionId)             return 'no_attribution'
if (!(socialCount > 0))         return 'not_socially_initiated'
if (readiness !== 'ready')      return 'not_ready'
if (pendingEvents > 0)          return 'unacknowledged'
return { measure: true }
```

Five conditions in an order that makes each refusal mean one thing. Every one of
them is **final for that JOIN**: nothing schedules a retry and nothing backfills.

## 250. Actual event/action ordering

The ordering was traced through the real code rather than reasoned about.

```
CONTENT SCRIPT  click → joinChannel(channel)          ← the browser navigates HERE
                     → analytics.recordJoin(...)      ← one-way port message, nothing awaited
                       (the tab may be torn down at any point after this)

SERVICE WORKER  serial task:
                  await session.touch()
                  await attribution.click()           ← mints attribution_id
                  recorder.track(join_clicked)
                  await recorder.flush()              ← analytics_track RPC
                  decideMeasurement(...)              ← gate, including the ack check
                  void measureRelationship(...)       ← detached; the queue moves on

SERVER          relationship action re-verifies actor, attribution, destination,
                social count and window, independently.
```

Navigation happens in a **different context, before the worker is told anything**.
There is no expression anywhere in the click handler that a Twitch API call could
be inserted in front of.

## 251. Durable attribution acknowledgement

**This is the question Slice B deliberately left open, and it needed the actual
behaviour rather than an assumption.**

`await recorder.flush()` alone is **not** an acknowledgement. Reading
`analytics.ts`: `flush()` awaits `run()`, and `run()` **swallows** a failed send —
it re-queues the batch, sets a backoff and returns normally. It also returns
early when another send is already in flight or when `canSend()` is false. A
resolved `flush()` therefore says nothing about whether the write landed.

The positive signal is the **queue depth after the flush**. A batch that failed
is put back; a batch that succeeded is gone. So `recorder.pending() === 0` after
`flush()` is a real acknowledgement that the canonical `join_clicked` reached
`analytics_track`.

It is deliberately **conservative in the safe direction**:

| Situation | `pending()` | Behaviour |
| --- | --- | --- |
| write succeeded | 0 | measure |
| write failed, batch re-queued | > 0 | **skip** |
| another flush in flight, ours not sent | > 0 | **skip** |
| signed out, nothing sendable | > 0 | **skip** |
| batch split by `maxBatch`, ours may have gone | > 0 | **skip** (conservative) |
| event dropped before the queue | 0 | server refuses `unknown_attribution` |

Only the last row can reach the server without a JOIN behind it, and the server
independently refuses it. **Client acknowledgement and server verification are
two different checks, not one wearing two hats.**

None of the forbidden shortcuts were used: no sleep, no widened window, no
weakened binding, no trusted client identity, and navigation waits on nothing.

## 252. Non-blocking navigation

JOIN wins, structurally rather than by promise.

* `joinChannel(channel)` is called **first**, and its return value decides
  everything after it.
* The recording is a one-way port message. The click handler contains no
  `await`, no `.then(`, and no `async` — asserted against the source with
  comments stripped, since the comment explaining the rule would otherwise match
  it.
* The measurement is **detached from the hub's serial chain** (`void`, not
  `await`). This is not stylistic: held inside the chain, a Twitch round trip
  would sit in front of `noteChannel`, whose arrival timestamp is taken **when it
  is processed** — so every measured JOIN would report an inflated
  `join_arrived.elapsed_ms`. Measurement must not distort the product's own
  numbers any more than it distorts the product. Mutation-proven.
* A failed measurement produces no state change, no port message, no
  notification and no user-visible anything. It is reported to the error log and
  nowhere else.
* Tested: with the relationship action throwing outright, the JOIN is still
  recorded with its attribution, and the arrival still matches it.

## 253. Eligibility, readiness and the backfill prohibition

**Measured:** a JOIN that navigated, minted an attribution, had `socialCount > 0`,
resolved `ready`, and was acknowledged.

**Not measured, ever:** direct Twitch navigation, typing a channel, a Gravity
card that was shown but not clicked, ordinary presence, opening Watchside, a
refresh, an arrival without a canonical click, or a JOIN nobody else was part of.
Each is covered by its own test.

**Readiness gating.** Only `ready` permits. `needs_follow_permission`,
`needs_reauthorization`, `temporarily_unavailable` and `null` all skip — and skip
**identically**, with the same reason, so nothing downstream can distinguish "no
permission" from "we could not ask".

When a JOIN is skipped: the JOIN proceeds normally, no OAuth, no permission UI,
no user-facing error, and **no observation of any kind**.

**The backfill prohibition, tested end to end:** a JOIN skipped for
`needs_follow_permission`, then permission granted, then five minutes advanced —
still zero observations. A *new* JOIN is measured, because it is a new question.
If the permission arrives later, that says nothing about whether this viewer
followed this creator at *that* JOIN.

## 254. Relationship-action integration

Nothing was duplicated or forked. Credential loading, refresh, rotation, the
Twitch relationship call, login → broadcaster-id resolution, viewer identity,
actor binding, attribution binding, broadcaster binding, observation writing,
idempotency and readiness all remain in the Slice B action, untouched.

The production caller is one function, `recordRelationship`, and it sends
**exactly two fields**:

```
action: 'relationship'
broadcaster_login
attribution_id
```

No actor id, user id, viewer id, credential reference, scope list, token, or
follow state. The actor is read from the verified session's JWT server-side.
Asserted by shape (`Object.keys(...)` deep-equals the two names) and by content
(the serialised request contains none of the forbidden substrings), and
mutation-proven by adding an `actor_id`.

Exactly **one** production caller exists, in `supabaseBackend.ts`, and a test
pins that. Every additional invocation site would be another place the
eligibility gate could be bypassed.

## 255. Actor and broadcaster binding

Unweakened, and re-proven with the production caller present. The server still
requires the authenticated actor to own the referenced `join_clicked`, and
`join_context_for_attribution` remains scoped to the actor in its own WHERE
clause. `destination_mismatch` still refuses a genuine JOIN quoted against a
different creator.

**A correction worth recording.** The Slice B "release blocker" that asserted no
production caller existed read:

```js
/action:s*'relationship'/      // missing backslash
```

It matched the literal text `action:s*'relationship'` and **could never have
fired**. It was decorative for two slices. What actually held the line was a
plain substring check in `followPermission.test.tsx`. The regex is fixed, and is
now asserted to work — one test proves it matches a real invocation and does not
match the Test Lab's unrelated `relationship` field — rather than being assumed
to.

## 256. Client privacy boundary

The client never learns the answer, and now has nowhere to put one.

`recordRelationship` destructures **only** `{ error }`. The response body is
discarded: there is no variable holding it, no branch reading it, and no caller
that could do anything with it. If the server ever leaked a follow result, it
would arrive nowhere. Mutation-proven by making the client read `state`.

No file under `src/` contains `relationship_present`, `following_at_join` or
`followsBroadcaster` — asserted by walking the tree, not by naming files.

## 257. Idempotency and failure semantics

**Idempotency** is unchanged and remains the database's job: the partial unique
index on `(actor_id, attribution_id)`. A duplicate for the same attribution is
refused; a later independent JOIN to the same creator with a new attribution is
a legitimate new observation. No client-side deduplication was added — the
client does not know what exists, which is the correct amount for it to know.

**Failure semantics**, preserved and re-proven with the real caller wired:

| Twitch says | Recorded |
| --- | --- |
| success, `data` empty | `relationship_present = false` — **a valid observation** |
| success, `data` non-empty | `relationship_present = true` — a valid observation |
| timeout, network error, HTTP error, malformed body, missing scope, credential unavailable, refresh rejected, decrypt failure, unknown broadcaster, attribution/actor/destination mismatch, server error | **nothing at all** |

**Failure never collapses into "not following."** The column is nullable
precisely so an absent answer is absent rather than false, and the mutation that
turns a failed lookup into `false` is DETECTED.

## 258. The 120-second window — assessment

**Verdict: unchanged at 120 s, and explicitly PROVISIONAL pending telemetry.**

Actual latency on the path the server measures — from `join_clicked.occurred_at`
to the relationship request arriving:

| Step | Order of magnitude |
| --- | --- |
| port message to the worker | sub-millisecond |
| `session.touch()`, `attribution.click()` | extension storage, single-digit ms |
| `analytics_track` RPC | tens to low hundreds of ms |
| Edge Function invoke, including a cold start | up to a few hundred ms |
| **typical total** | **well under 2 s** |
| bad network, cold function | perhaps 10–15 s |

So 120 s is roughly **two orders of magnitude** of headroom over the expected
case.

The window also has to absorb **client/server clock skew**, which is a real
consumer of it: `occurred_at` comes from the browser's clock and the server
compares it against its own. The window is symmetric — a JOIN too far in the
future is refused as readily as one too far in the past — so skew in either
direction eats into the same budget. 120 s tolerates roughly two minutes of skew
before eligible JOINs start being refused, and a refusal is a *missing*
observation, never a wrong one.

**Replay / misattribution risk: low, and not what the window is protecting.** A
replay of the same attribution is idempotent at the database. A different
attribution requires a genuine `join_clicked` owned by the same authenticated
actor, aimed at the same creator. Narrowing the window would not meaningfully
change that; the window's real job is **semantic** — keeping the column's name
honest.

**No evidence justifies a change**, and it was deliberately not changed because
another number felt cleaner. It was not widened, and could not have been: the
ordering race was solved by acknowledgement, not by making the race unlikely.

What would settle it is the distribution of server-observed
`now − occurred_at` at relationship requests. That is telemetry, and telemetry
is Slice E.

## 259. Real JOIN acceptance — OUTSTANDING

**No production observation exists.** Nothing was fabricated and nothing was
simulated.

An eligible JOIN needs a friend visibly watching a channel. Eligibility is
`socialCount > 0`, which is satisfied by **any friend row**, not only a Gravity
cluster — `PersonRow` and `UserCard` pass `socialCount: 1`, and a Gravity card
passes the cluster size. So the cheapest legitimate social JOIN is:

> a second existing beta account signed in and watching any Twitch channel, and
> the owner clicking **JOIN** on that person in Watchside.

No new Twitch account, no OAuth, no weakening of the test, and no substituting
arbitrary creator navigation.

**Owner action, after reloading the extension:** click **JOIN** on a friend who
is showing as watching, and say when Twitch opens.

Then verified server-side, shape only:

- a real `join_clicked` exists, owned by the owner, with the right destination
- exactly one `creator_relationship_observation` for that attribution
- `relationship_present` is **NON-NULL** — and its value is **never printed**
- a repeat does not create a second observation
- no credential material anywhere
- the public privacy page is current

Terminal wording will be **relationship baseline recorded: YES/NO**, and nothing
about the owner's actual follow state.

## 260. Privacy disclosure

`docs/PRIVACY.md` now describes the collection in plain language, and the public
page was regenerated from it and **published**.

Added: a data-table row, and a section — *"The one check Watchside makes with
it"* — that states the question asked, when it is asked, when it is not, which
permission it needs, and how it ends. The paragraph that said *"nothing is read
from it and nothing is measured with it"* is gone.

**A pre-existing inaccuracy was found and fixed.** That paragraph also claimed
Watchside *"asks Twitch for no permission beyond the basic one you already
granted at sign-in"* — which Slice C made untrue when it added
`user:read:follows` to the initial authorization. No collection had begun, and
the public store build predates the scope, so nothing was collected undisclosed;
but the sentence was wrong from Slice C onward and is recorded here rather than
quietly corrected.

The disclosure deliberately **refuses the overclaims**: no reading of the follow
list, no later follows, no causal claim, no subscriptions, no purchases, no
Bits, no chat, no arbitrary browsing, no backfill. It states the deletion
asymmetry plainly — Twitch-derived answers go when the Twitch connection goes;
Watchside's own record of its own product does not.

Two drafting notes. A markdown blockquote rendered as a literal `&gt;` on the
published page, because the generator refuses constructs it does not recognise;
it was rewritten as a bold line rather than teaching the generator a construct
for one sentence. And the enumeration *"nothing about subscriptions, payments,
Bits, or emotes"* was **removed** — §150 established that naming data types
Watchside has nothing to do with invites the reader to wonder why they were
mentioned, and the existing test enforcing that was left standing.

Verified word-for-word: every word of the policy appears on the published page,
the only differences being ordered-list markers the generator renders as `<ol>`.

## 261. Privacy / collection deployment order

**Privacy went first, and this is checkable rather than remembered.**

| Order | Event | Status |
| --- | --- | --- |
| 1 | policy rewritten, page regenerated | done |
| 2 | page committed and pushed to Pages | `eec93be` |
| 3 | **live page fetched and confirmed to contain the disclosure** | confirmed |
| 4 | trigger committed here | after 3 |
| 5 | collection actually possible | only when the owner reloads (§259) |

There is no window in which collection could occur while the disclosure omitted
it: the extension is not uploaded to any store, so the only build that can
collect is the owner's local one, reloaded at step 5.

**The deterministic guard.** A test couples the two so neither can move without
the other: *if any file under `src/` invokes the relationship action, the policy
must contain both the question it asks and the permission it needs.* Removing
the disclosure while a caller exists fails. Adding a second caller before
writing about it fails. The mutation that deletes the disclosure line is
DETECTED.

## 262. G6, deauthorization and account deletion

Unchanged in behaviour, and now proven against a **fuller** Watchside-owned
trail than before — the deauthorization test previously asserted one surviving
event, which would have passed even if deauthorization had deleted the dwell and
invented something else.

| Event | Observations | Credential | Watchside analytics |
| --- | --- | --- | --- |
| Twitch deauthorization | **deleted** | **deleted** | **preserved** — `join_clicked`, `join_arrived`, `watching_together_ended`, `channel_dwell_ended`, each named individually |
| Account deletion | deleted | deleted first | deleted (D-A) |
| Sign-out | kept | kept | kept |

Two new mutation levers cover the asymmetry from both sides: one that stops
deleting the Twitch-derived observations, and one that also deletes the
Watchside-owned JOIN funnel. Both DETECTED.

**Scope loss.** Unchanged from §174 and deliberately so: the credential's
recorded `scopes`, and a `403` at use, each produce `needs_follow_permission`,
no observation, and no destruction. Transient Twitch errors, timeouts and
network failures are **never** interpreted as revocation — they produce no
observation and nothing else. No destructive scope-loss trigger was invented.
The narrow question of whether confirmed scope removal should delete existing
observations is not answered here, because it does not block collection: with
observations now possible it becomes a real policy decision, and it is recorded
as an open item (§268) rather than improvised.

## 263. Schema and migration status

**No migration was created. Hosted schema remains 33.**

The trigger required no schema change: `creator_relationship_observations`, the
partial unique index and `join_context_for_attribution` were all built in `0033`
for exactly this. No second relationship table exists, and no empty or
ceremonial migration was added.

## 264. Chrome impact

| | |
| --- | --- |
| permissions | `identity`, `storage`, `alarms`, `notifications` — **unchanged** |
| host permissions | `*.supabase.co`, `7tv.io`, `cdn.7tv.app` — **unchanged** |
| `api.twitch.tv` host permission | **not present, and not needed** |
| version | 0.7.0, **not bumped** |
| Store upload | **none** |
| packaging / release artefacts | **untouched** |

No new permission was needed because the relationship call goes to the Supabase
Edge Function, on a host the extension already had. Watchside talks to Twitch's
API only from the server, with a credential the browser never holds. Asserted
against `public/manifest.json`, including an explicit assertion that the Twitch
API host is absent.

## 265. Firefox impact

| | |
| --- | --- |
| data categories | `authenticationInfo`, `browsingActivity`, `personalCommunications`, `websiteActivity` — **exactly unchanged** |
| `technicalAndInteraction` | **NO** |
| `financialAndPaymentInfo` | **NO** |
| permissions | unchanged |
| upload | **none** — the pending v0.6 review is untouched |

`verify:firefox` is clean and the build reproducible. The follow baseline adds
no category: it is a fact about a JOIN destination, which is already
`browsingActivity`, and it is not an analytics event property at all — it lives
in its own table.

## 266. Deterministic tests

**2,661 passing / 105 files, 0 failures.** `tsc -b` clean, `eslint` clean.

New suite: `tests/extension/joinRelationshipTrigger.test.ts` — **30 tests**.

| # | Requirement | Covered by |
| --- | --- | --- |
| 1 | canonical socially attributed JOIN schedules M3D | schedules exactly one measurement, with the JOIN's own attribution |
| 2 | arbitrary Twitch navigation does not | ordinary Twitch navigation, arrival and presence |
| 3 | Gravity exposure without JOIN does not | a Gravity card that was shown but never joined |
| 4 | JOIN navigation is not blocked | navigates before recording, and awaits nothing in the click handler |
| 5 | join_clicked durable before the action depends on it | refuses when the JOIN write has not been acknowledged; a JOIN whose canonical event has not been accepted |
| 6 | correct attribution reaches the action | asserts equality with the canonical event's `attribution_id` |
| 7 | correct broadcaster reaches the action | same test |
| 8 | client sends no actor/user/viewer/credential id | sends only the creator and the attribution, and nothing else at all |
| 9 | ready permits | permits measurement when the server says ready |
| 10–12 | needs_follow_permission / needs_reauthorization / unavailable skip | skips every other state, without distinguishing between them |
| 13 | skipped measurement never blocks JOIN | any JOIN at all, when the permission was never granted |
| 14 | never backfilled | a JOIN that was skipped, even after permission arrives |
| 15 | duplicate attribution idempotent | `relationshipObservation` — refuses a second observation |
| 16 | later independent JOIN may observe again | `relationshipObservation` — allows a later independent opportunity |
| 17–20 | true / empty-is-false / failure / malformed | `followBaseline` + `relationshipObservation`, unchanged and re-run |
| 21–23 | attribution, broadcaster and actor mismatch | `relationshipBinding`, unchanged |
| 24–26 | no follow boolean, no raw response, no token/scope | discards the server response; has no follow state anywhere in the client |
| 27 | failure not user-facing | surfaces no measurement error to the user |
| 28 | failure does not prevent navigation | records the JOIN and survives the measurement failing outright |
| 29–30 | no OAuth, no permission UI in the JOIN path | never mentions measurement, permission or OAuth in the JOIN path |
| 31–32 | no subscription, no emote scope | the Twitch scope set is unchanged by any of this |
| 33–35 | deauth removes observations, keeps JOIN / dwell / shared-watch | `relationshipObservation`, extended to the full funnel |
| 36 | account deletion removes both | `relationshipObservation` |
| 37 | sign-out removes neither | `relationshipObservation` |
| 38 | Chrome permissions unchanged | adds no Chrome permission and no host permission |
| 39 | Firefox categories unchanged | `dwellDisclosure` + `verify:firefox` |
| 40 | disclosure matches live collection | describes the follow check it now performs, and nothing beyond it |
| 41 | collection cannot precede disclosure | a production relationship caller requires the policy to describe it |
| 42 | no historical backfill | a JOIN that was skipped, even after permission arrives |

## 267. Mutation proofs

`npm run test:destruction` — **34 of 34 DETECTED** (was 25; nine added).

| New lever | Caught by |
| --- | --- |
| `trigger: make the analytics queue wait for the Twitch round trip` | does not hold the analytics queue while it measures |
| `trigger: measure before the JOIN write is acknowledged` | refuses when the JOIN write has not been acknowledged |
| `trigger: measure without the permission the server confirmed` | skips every other state, without distinguishing between them |
| `trigger: measure JOINs nobody else was part of` | refuses a JOIN nobody else was part of |
| `trigger: read the relationship response in the client` | discards the server response rather than reading it |
| `trigger: send an actor id with the relationship request` | sends the two approved fields under the two approved names |
| `privacy: collect without disclosing the follow check` | a production relationship caller requires the policy to describe it |
| `g6: keep the Twitch-derived observations on deauthorization` | Twitch deauthorization deletes them and keeps Watchside analytics |
| `g6: also delete the Watchside-owned JOIN funnel on deauthorization` | keeps the dwell and shared-watch records specifically |

Existing levers for API-failure-becomes-false, empty-response-discarded,
duplicate attribution, and actor/broadcaster binding were re-run unchanged and
remain DETECTED with the production caller present.

The harness ran once, uninterrupted, and `git status` before and after listed
the same files. No mutation was left live.

## 268. Known-debt delta and unresolved risks

**Known debt is unchanged, and nothing was reclassified:**

| Harness | Before | After |
| --- | --- | --- |
| analytics | 6 | **6** |
| presence | 0 | **0** |
| layout | 0 | **0** |
| lab | 11 | **11** |

Unresolved, and none of them blocking:

1. **Confirmed scope removal does not delete existing observations.** Deliberate.
   Deauthorization does; a scope narrowed without a full deauthorization is a
   policy question that only became real now that observations can exist. Not
   improvised (§262).
2. **Acknowledgement is conservative, so some eligible JOINs will go
   unmeasured** — a batch split, a concurrent flush, or a slow network all skip.
   The bias is toward missing data rather than wrong data, but it is a bias, and
   whether it correlates with anything (bad networks, long sessions) is
   unmeasured.
3. **Clock skew consumes the baseline window** (§258). Fails closed; unquantified.
4. **The worker could be evicted mid-measurement.** The detached call keeps the
   worker alive through an in-flight fetch in practice, but MV3 guarantees
   nothing. Result: no observation. Honest, and invisible.
5. **No telemetry on any of the above**, by design — that is Slice E.

## 269. Slice E readiness

Not started, per instruction. Slice D publishes no metric, computes no rate, and
adds no view. The sentence *"X% of JOINs went to creators not already followed"*
is not calculable from anything shipped here and must not be until the
denominator's honesty — which items 2 and 3 above bear directly on — is
understood.

Slice E should begin with the coverage question, not the headline: of eligible
JOINs, how many produced an observation, and is what is missing missing at
random?

---

## 270. First real JOIN — NOT RECORDED, and why

**relationship baseline recorded: NO.**

The owner performed a real socially attributed JOIN. Twitch opened normally.
**Zero observations were written**, and nothing about the failure was visible
from outside.

### What production actually showed

The observation table was empty, which by itself has four indistinguishable
explanations. So the owner-gated diagnostic was extended to read recent
`join_clicked` rows — shape only, no channel, no ids — and the answer was
immediate:

```
occurred_at 2026-09-01T00:52:09.812Z  source=social_gravity
has_attribution=true  has_destination=true  social_count=1
eligible=true         observations=0
```

The canonical JOIN was **durable, attributed and eligible**. So this was not
"no JOIN", not an ineligible surface, and not a server refusal of a bad
attribution. It was a JOIN that the client silently declined to measure.

The shipped bundle was ruled out as a second cause: `measureRelationship`
appears in `dist/kickback-background.js`, built at 15:59 local, and the JOIN was
at 17:52 local. The owner was running the right build.

### The defect

**Mine, introduced in this slice.** The acknowledgement gate (§251) read
`recorder.pending()` after `flush()`. Reading `analytics.ts` again with that in
mind:

```ts
async function run() {
  if (sending || queue.length === 0) return   // ← returns early
  ...
}
async flush() { clearTimer(); await run() }
```

When a send is already in flight, `run()` returns immediately, `flush()`
resolves **with the caller's event still queued**, and `pending()` reads
non-zero. The gate then correctly concludes "not acknowledged" — about a write
that was merely waiting its turn.

At a JOIN that is not an edge case, it is the **normal** case: Social Gravity
impressions are always on the five-second flush timer, so a send is usually
open when the click lands. §251 called the gate "conservative"; it was in fact
conservative to the point of **almost never measuring anything**, while every
test passed and no error was raised anywhere.

Proven before changing anything, with a throwaway probe holding a send open:

```
PENDING AFTER FLUSH WHILE SENDING: 1
```

### The fix

Narrow, in `analytics.ts`:

* `run()` returns the **in-flight promise** instead of `undefined`, so a second
  caller awaits the same work rather than silently doing nothing.
* `flush()` makes **two passes**: the first awaits whatever was already sending,
  the second sends what the caller just queued.

The gate is unchanged and still conservative — it skips rather than guesses, and
the server still re-verifies independently. It can now actually succeed.

### Coverage

Regression test in `analyticsRecorder.test.ts`, where a send can be held open —
the faithful reproduction. New mutation lever `trigger: let flush return while an
earlier send is still in flight` restores the single pass and is **DETECTED**.

The hub-level test was **relabelled rather than left flattering**: it cannot
reproduce the overlap without driving the five-second timer, so it proves a JOIN
follows an impression correctly and says so, instead of claiming to defend a bug
it does not. A test that looks like proof it is not is worse than no test.

### Lesson worth keeping

The Slice D gate was mutation-proven, and the mutation proved the wrong thing:
that the gate *refuses* when unacknowledged. Nothing proved it ever *accepts*
under realistic timing. **A guard tested only in its refusing direction is a
guard that can silently refuse everything.**

### Status

Deterministic gates re-run green: 2,663 tests / 105 files, 35/35 mutations, lint
and `tsc` clean, known debt unchanged. Fix shipped in the local build.

**Slice D remains NOT GO.** One more real JOIN is required.

---

## 271. Second real JOIN — NOT RECORDED, and the actual reason

**relationship baseline recorded: NO.**

A second real socially attributed JOIN was performed at
`2026-09-01T02:21:21.569Z`. Twitch opened normally. Again **zero observations**.

### The real cause

**The account performing the JOINs holds no Twitch credential.**

```
2026-09-01T02:21:21Z  eligible=true  actor_has_credential=false  obs=0
2026-09-01T00:52:09Z  eligible=true  actor_has_credential=false  obs=0
2026-08-30T08:29:07Z  eligible=true  actor_has_credential=true   obs=0
```

There is exactly one row in `twitch_credentials`, and it belongs to a different
actor — one whose most recent JOIN is **42 hours old**, from before the trigger
existed. `analytics_events.actor_id` is `auth.uid()` and references
`public.users (id)`, the same id space as `twitch_credentials.actor_id`, so this
comparison is exact rather than suggestive.

With no credential, `readinessFor({ hasCredential: false })` is
`needs_reauthorization`, the client gate declines with `not_ready`, and **no
observation was ever possible**. Both acceptance JOINs were structurally
unmeasurable before any of the code under test ran.

The Slice C acceptance at §239–§244 verified a credential that is `ready` — and
that verification was correct. It was simply about a **different Watchside
account** than the one signed in where the JOINs were clicked. Nothing in Slice
C's evidence was wrong; it answered a question about the account it was asked
about.

### The path itself works

A read-only probe walked the same steps against the credentialed actor:

```json
{"step":"ok","twitch_path_works":true,
 "attribution_would_pass_now":false,
 "attribution_reason":"outside_baseline_window","join_age_ms":151001911}
```

Credential fresh, decrypt, viewer identity from `connected_accounts`, broadcaster
resolution through Helix, and the follow lookup itself **all succeeded against
real Twitch** — the first time that path has ever run outside a fake. The only
refusal is that this actor's newest JOIN is 42 hours old, which is exactly what
the baseline window is for.

The probe returns whether the lookup **succeeded**, never what it found.

### A correction to §270

§270 attributed the first failure to the `flush()` acknowledgement bug. **That
attribution was wrong.** The bug was real — proven directly, `PENDING AFTER
FLUSH WHILE SENDING: 1` — and fixing it was right; the two-pass flush and its
mutation lever stand. But it was not the cause of that failure, because that
JOIN's actor had no credential either and could never have been measured.

The mistake was a specific one worth naming: the credential's `updated_at`
moved to `02:21:11`, close to the JOIN, and only `capture` or `ensureFresh`
write that column — so it was read as proof that the relationship action had
run. It was not proof. It was a coincidence in time that fitted a hypothesis,
and it was treated as confirming it. **What actually settled the question was a
field that could only mean one thing** (`actor_has_credential`), not a timestamp
that could mean several. The write at `02:21:11` remains unexplained, and is
recorded as unexplained rather than given a plausible story.

### Why no test could have caught this

Nothing here is a code defect. Every gate was correct, every refusal honest, and
the client did exactly what it should when told `needs_reauthorization`: JOIN
normally, measure nothing, say nothing.

What was missing is that **"this account can be measured" was never checked
against the account actually being used**. Acceptance verified a credential and
verified a JOIN, and never verified they belonged to the same actor. The
diagnostic now reports `actor_has_credential` per JOIN precisely so that
question can never again be assumed.

### Status

Deterministic gates unchanged and green: 2,663 tests / 105 files, 35/35
mutations, `tsc` and `eslint` clean, known debt unchanged, schema 33, privacy
live.

**Slice D remains NOT GO.** It is blocked on a precondition, not a defect: the
account used for acceptance must hold a Twitch credential carrying
`user:read:follows`.

---

# SLICE D — AUTOMATED CREDENTIALED ACCEPTANCE

*Appended 2026-09-01. §1–§271 stand unchanged; corrections are appended, never
rewritten.*

## 272. Why this was needed

Two real human JOINs were spent, and neither produced a baseline. Both times the
JOIN itself was flawless and the discovery was setup state:

| Attempt | What was actually wrong | Could a JOIN have revealed it? |
| --- | --- | --- |
| §270 | mis-attributed to a flush bug | no |
| §271 | the account clicking JOIN held **no Twitch credential** | no — the product correctly says nothing |

The second is the important one. An actor with no credential resolves to
`needs_reauthorization`, the client declines, nothing is recorded, and **nothing
anywhere looks wrong** — which is right for a user and useless for acceptance.
No amount of code inspection would have found it. One server query answers it in
milliseconds.

**Manual JOINs were being used to discover state a query could have established
beforehand.** That is the failure corrected here, and it is a harness failure,
not a product one.

## 273. Automation feasibility — the infrastructure already existed

Inspecting `scripts/firefox-e2e/` before writing anything found that **the hard
parts were already built** by the F5 work:

| Capability | Status |
| --- | --- |
| two authenticated actors, isolated profiles | `seeds.local.json`, gitignored, A and B |
| disposable copies, never the seed itself | `createProfile({ seed })` |
| driving a real browser and real extension | `harness.mjs` — `launch` / `page` / `bg` |
| Actor B watching a channel, publishing presence | `05-social.mjs`, asserted against the server |
| Actor A seeing a Social Gravity card | asserted against the **rendered card** |
| **Actor A clicking the real JOIN button** | `agents.mjs` `join` — finds the named channel's card, clicks `button.kb-join` |
| arrival assertion | present |
| identifying which account each seed is | `identify-actors.mjs` |

Social presence and the JOIN click were **already automated**, against real
accounts, through the production control. Neither needed inventing.

**Verdict: automation is feasible, and nearly all of it already existed.** What
was missing was not browser automation. It was a precondition gate and
server-side observation assertions.

## 274. What was built

### `scripts/m3d-acceptance/preconditions.mjs`

A **pure function**, `decidePreconditions(snapshot)`, deliberately separate from
the code that acts on it so every failure shape is unit-testable and mutable.
Checked in order: actor known, credential exists, Twitch account connected,
readiness is `ready`, follow scope present, no unexpected scopes.

It **fails closed**. A snapshot missing a field, or carrying a truthy-but-wrong
value such as `'yes'`, refuses. A future server that drops a field stops the run
rather than sailing past it.

### `scripts/m3d-acceptance/run.mjs` — `npm run verify:m3d`

Layered as required: **ordinary `npm test` stays fakes-only** and this is
explicitly invoked. A test asserts that separation.

1. launch seeds A and B, identify both from the running extension
2. **ask the server about Actor A specifically**, and refuse before driving any
   further if the answer is not measurable
3. record that actor's observation baseline
4. B watches and publishes presence; A sees the card
5. **A clicks the real JOIN button**
6. assert navigation, and that click-to-arrival was well inside a Twitch round
   trip
7. poll for exactly one new observation, bound to a real JOIN of that actor,
   aimed at that creator, socially initiated, taken inside the window
8. replay the relationship action for the same attribution; assert it reports
   `recorded` and creates nothing

Nothing inserts an analytics row, mints an attribution, or fabricates an
observation — asserted by a test that forbids those strings in the harness.

### Server: per-actor diagnostics

`acceptance_preconditions` (keyed by `actor_id`) and `relationship_replay`, both
owner-gated. `observation_shape` is now scoped to an actor when asked — the
conflation of "the credential" with "the actor under test" is exactly what hid
§271, so scoping is the fix rather than a convenience.

**Idempotency is performed, not asserted.** `relationship_replay` goes through
the same `recordRelationship` the production caller uses.

## 275. Why the guard would have prevented both wasted JOINs

Proven, not claimed. Run against the current world:

```
  identity
  PRECONDITION NOT MET: seed profile A is not signed in to Watchside.
      Sign in once, by hand, in that profile: …
  NO JOIN WAS SPENT.

exit=3
```

And the server endpoint, asked about an actor that does not exist:

```json
{"actor_known":false,"has_credential":false,"has_follows_scope":false,
 "twitch_account_connected":false,"readiness":"needs_reauthorization",
 "observations_baseline":0}
```

Note that `readiness` alone reports `needs_reauthorization` for an actor that
does not exist at all — which is precisely why `actor_known` and
`has_credential` are checked separately rather than inferred from readiness.

A distinct exit code (**3**) separates "the run never started" from "the product
misbehaved", so nothing downstream can confuse them.

## 276. Human interaction budget

**Steady state: ZERO human actions per acceptance run.**

The one remaining human step is the **seed OAuth bootstrap**, which the brief
permits — and it is currently outstanding, because both seed sessions have
expired since 29 August:

```
Actor A  session key present but not signed in
Actor B  signed out
```

### Why this specific step is not automated

Not "manual testing is valuable" — two concrete limitations:

* Signing in requires completing **Twitch's own OAuth**, which means Twitch's
  login page and potentially a password and 2FA. Automating it would mean
  storing the owner's Twitch credentials somewhere a script can reach them —
  exactly what O7 and the whole custody design exist to avoid. **The automation
  would have to hold the secret the architecture is built never to hold.**
* The harness is deliberately built so it **never opens a seed profile**, only
  disposable copies, so a sign-in performed during a run is discarded by design.
  That property is what stops a run expiring or corrupting the seeds, and it is
  worth more than saving the bootstrap.

The bootstrap is therefore bounded and infrequent — once per profile, per
session lifetime — and everything after it is automated and repeatable.

**One thing it buys for free:** signing in now requests `user:read:follows` on
the ordinary consent screen (§230), so a freshly re-authenticated seed A gets a
credential **with the scope already on it**. The bootstrap and the credential
requirement are satisfied by the same action.

## 277. Real-data safety

* The harness prints `relationship baseline recorded: YES` and `actual follow
  state exposed: NO`, and nothing else about the answer.
* It asserts `answered === true` — that `relationship_present` is **not null** —
  and the diagnostic never returns the value, so the harness could not print it
  if it tried. A test checks the forbidden strings against the harness's
  `console.log` lines specifically rather than the whole file, so the guard that
  asserts the field is *absent* does not have to be deleted to satisfy it.
* The admin token is read from `WATCHSIDE_ADMIN_TOKEN`, never defaulted,
  committed or printed. The harness reads no Twitch token at all — the
  credential never leaves the server.
* No fake observations are created. The run produces exactly one real
  observation from one real JOIN, which is a legitimate product event rather
  than test litter, and G6/D7 semantics are untouched.

## 278. Regression coverage

`tests/extension/acceptancePreconditions.test.ts` — **16 tests**: every refusal,
the fail-closed behaviour, the ordering (preconditions before JOIN, read from the
source), that a failure stops rather than warns, that the run uses the real JOIN
control, that nothing secret is printed, and that it stays out of `npm test`.

The §270 in-flight analytics condition is retained in
`tests/extension/analyticsRecorder.test.ts` with its own lever.

Full suite: **2,679 tests / 106 files, 0 failures.** `tsc` and `eslint` clean.

## 279. Mutation proofs

`npm run test:destruction` — **37 of 37 DETECTED** (was 35).

| New lever | Caught by |
| --- | --- |
| `acceptance: begin a JOIN for an actor with no credential` | refuses an actor with no stored Twitch credential |
| `acceptance: treat any non-ready state as good enough` | refuses every non-ready state, and names which one |

The harness ran once, uninterrupted; `git status` before and after listed the
same files.

## 280. Deltas

| | |
| --- | --- |
| schema | **33** — unchanged, no migration |
| extension version | **0.7.0** — not bumped |
| Chrome permissions / host permissions | unchanged |
| Firefox data categories | `authenticationInfo`, `browsingActivity`, `personalCommunications`, `websiteActivity` — unchanged; technical NO, financial NO |
| production relationship callers | 1 |
| production observations | **0** |
| privacy disclosure | live and current |
| known debt | analytics 6 · presence 0 · layout 0 · lab 11 — unchanged |

The only production code touched is the owner-gated diagnostic branch of the
Edge Function. No user-facing behaviour changed.

## 281. Slice D verdict

**NOT GO**, blocked on one bounded human bootstrap.

Everything that can be automated now is: preconditions, presence, the JOIN, the
observation assertions and the idempotency proof. The single outstanding action
is signing the two seed profiles back in — after which `npm run verify:m3d`
completes acceptance with no human involvement, and is reusable for every future
M3D regression rather than being a Slice D one-off.

**No further manual JOINs will be requested.** If the seeds are re-authenticated
and the run still fails, it fails with a named precondition or a named
assertion, having spent nothing.
