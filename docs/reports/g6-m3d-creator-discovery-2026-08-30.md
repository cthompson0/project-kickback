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
| Expiry | Public-client refresh tokens expire in 30 days; **confidential clients do not expire** | Watchside's Twitch app is confidential (GoTrue exchanges with a secret), so a stored refresh token stays valid indefinitely — which is *more* dangerous, not less |
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
