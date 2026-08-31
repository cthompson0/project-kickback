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
