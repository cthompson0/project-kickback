# M3D / M3E-a — Policy gates (D7, D8) and roadmap sync

**Date:** 2026-08-30
**Type:** NARROW RESEARCH / POLICY / DOCUMENTATION checkpoint
**Watchside HEAD at start:** `79ac2e4` · **Pages HEAD:** `152e4ac` · both trees clean
**Hosted analytics schema version:** 31
**Predecessors:** `m3b-twitch-economic-attribution-2026-08-30.md` (incl. §26 / M3B.1),
`m3a-m3c-measurement-foundation-2026-08-30.md` (incl. §33 / M3C.1)

> **Nothing was implemented.** No OAuth change, no scope request, no provider
> token, no `following_at_join`, no `subscribed_at_join`, no
> `creator_relationship_observations`, no migration, no schema change, no
> manifest change, no package, no Store artifact, no DNS. Documentation only.

---

## 1. Executive verdict

## **GO WITH DISCLOSURE CHANGE**

D7 is **substantively answered** and does not block the thesis. D8 is
**genuinely unresolved by documentation and cannot be closed without asking
AMO** — Mozilla publishes a category definition but **no guidance at all** on
how to choose between categories or what to do when unsure.

Five findings matter more than the rest:

- **🚩 The change-of-control clause reaches aggregates.** The DSA requires
  Twitch's **prior written permission** before an acquirer may process Twitch
  Data — *"including any insights or aggregated information derived from such
  data"*. Aggregation does **not** exempt a metric derived from Twitch API data.
  Flagged prominently per the brief (§9, §10).
- **…and the hybrid architecture is what contains the damage.** Watchside's
  strategic core — L1 exposure, L2 arrival, **L3 observed stream dwell**, L7
  repeat viewing, L8 randomised lift — is **not** derived from the Twitch API.
  It is Watchside observing its own UI and its own tabs. Only L4/L5/L6 are
  Twitch-derived. The split we adopted for *deletion* turns out to also be the
  thing that keeps most of the evidence outside the change-of-control
  restriction. That is a stronger reason for it than the one we had (§11).
- **De-authorization is automatically detectable.** EventSub
  `user.authorization.revoke` fires for your own `client_id` and, per the
  subscription-types page, requires **no scope**. G6 does not have to be a
  polling reconciliation job (§18).
- **`subscribed_at_join` does not meet Mozilla's literal definition of
  `financialAndPaymentInfo`** — *"credit card numbers, transactions, credit
  ratings, financial statements, or payment history"*. A point-in-time boolean
  names no amount, no instrument, no date and no history, and is true for
  **gifted** and **Prime** subscriptions where the viewer paid nothing. But
  Twitch's own DSA characterises subscription data as *"data about purchases
  that end users make"*, and that tension is exactly what documentation cannot
  resolve. **Ask AMO** (§15).
- **Over-declaring is not the safe default here.** A Firefox prompt naming
  financial and payment information, for a product that stores one boolean about
  a streamer relationship, tells users something untrue in the other direction.
  "Conservative" is not automatically "declare more" when the declaration itself
  misinforms (§15.4).

**The release sequence is unchanged**, with one conditional:

- **v0.7** — M3A arm + M3C.1 dwell. **No Twitch consent change.** ✅ unaffected.
- **v0.8** — G6 + M3D + M3E-a, **one** OAuth change, **no token vault**.
  ✅ confirmed feasible, **conditional on D8's answer** for the M3E-a half.

**One honest limitation, stated up front:** `legal.twitch.com` remains
JavaScript-rendered and **the agreement page could not be loaded directly** on
this attempt either. Every DSA clause below is quoted from search-engine
extraction *of that primary source*. Clause substance was corroborated across
multiple independent queries, but **I did not read the document**. Confidence is
recorded per finding, and a lawyer reading the actual page remains D7's proper
closure (§28).

---

## 2. Current architecture and release state

| | |
|---|---|
| Watchside HEAD | `79ac2e4` |
| Pages HEAD | `152e4ac` |
| Hosted analytics schema | **31** |
| Chrome | v0.6.0 **LIVE** |
| Firefox | v0.6.0 **submitted to AMO, awaiting review — untouched** |
| `main` | ahead of both Store builds |
| v0.7 | **not created, packaged, submitted or released** |

**Measurement state:** M3A deployed server-side. M3C.1 observed per-stream dwell
implemented and accepted. **Zero production `channel_dwell_ended` rows exist.**
No mixed focused-only cohort exists, and none can — focused-only was rejected
before any production data existed.

**Canonical dwell definition (M3C.1):** how long Watchside had defensible
continuing evidence that one eligible live Twitch stream was open and observed —
per stream, not gated on focus, not human attention. Unit:
**stream-milliseconds**. Concurrent streams legitimately sum;
`focused_duration_ms + background_duration_ms = duration_ms`.

**Twitch surface today:** OAuth with **no scopes**; channel metadata via an
**app access token** (no scopes, no refresh token); the extension never sees a
provider token.

---

## 3. Intended M3D / M3E-a data

For a **socially attributed** creator visit only — never ordinary browsing:

| Field | Meaning | H-class |
|---|---|---|
| `following_at_join` | did the viewer already follow this creator | H1 → H0 if recorded |
| `subscribed_at_join` | did the viewer already have a subscription relationship | **H2 — irrecoverable** |

**Deliberately NOT collected:** subscription tier · `is_gift` · gifter identity
(`gifter_login` / `gifter_name`, which §26.1.5 flagged may be present in the
response) · raw API payloads · provider access tokens · provider refresh tokens ·
Bits/Cheers · amounts · payment information · purchase history.

**Nothing in this research changes that list.** §19 re-tests every proposed
column against a required claim, and the subscription baseline **remains one
boolean** — §15.3 finds no evidence that a boolean is insufficient, and §13
finds the extra fields would push it *toward* the financial category rather than
away from it.

M3E-b (token custody, scheduled polling) **remains deferred indefinitely**.

---

## 4. Twitch policy sources

| Source | Detail |
|---|---|
| **Organisation** | Twitch Interactive, Inc. |
| **Document** | Twitch Developer Services Agreement ("DSA") |
| **URLs** | `https://legal.twitch.com/legal/developer-agreement/` · `https://www.twitch.tv/p/en/legal/developer-agreement/` (302 → the former) |
| **Version indicated** | most recent update **4 December 2024** (per search metadata) |
| **Date checked** | 2026-08-30 |
| **Direct load** | ❌ **FAILED** — JS-rendered; the fetched body contains only navigation plus the build path `legal-hugo/content/en/legal/developer-agreement.md`. `…/index.xml` returns 404. |

Also consulted, and these **did** load:

| Source | URL | Result |
|---|---|---|
| Revoking Access Tokens | `dev.twitch.tv/docs/authentication/revoke-tokens` | ✅ loaded — mechanics only |
| EventSub subscription types | `dev.twitch.tv/docs/eventsub/eventsub-subscription-types/` | ✅ loaded — `user.authorization.grant` / `.revoke` confirmed to exist |
| Revised DSA announcement (staff `jbulava`, 2023-11-01) | `discuss.dev.twitch.com/t/revised-developer-services-agreement/49985` | ✅ loaded — no clause text |

### 4.1 Method, and its limits — read this before relying on §5–§11

Because the agreement would not load, **clause text below comes from
search-engine extraction of the primary source**, run as several independent
targeted queries. Where the same clause surfaced consistently across queries I
record **MEDIUM-HIGH** confidence; where it surfaced once, **MEDIUM**.

**No third-party source establishes any legal conclusion here.** Client
libraries were used in M3B for API *mechanics* only, and none is cited in this
section.

**This is not a substitute for a lawyer reading the page.** D7 closes when the
owner (or counsel) opens `legal.twitch.com/legal/developer-agreement/` in a
browser and confirms §5–§9. Everything below is written so that confirmation is
a checklist rather than a re-investigation.

---

## 5. De-authorization obligations (D7.1)

### 5.1 The clause

> *"You must delete all data of an end user collected through the Twitch APIs
> upon termination of this Agreement, revocation, or reduction in scope of end
> user authorization, or upon Twitch's or the end user's request, and cause any
> affiliates or third parties with whom you have shared copies with Twitch's
> prior written permission to do the same."*

**Confidence: MEDIUM-HIGH** — surfaced consistently across two independent
queries and matches the M3B §16 summary obtained a day earlier by a different
query.

### 5.2 What it means for Watchside

The trigger set is broader than "the user pressed disconnect". It is:
**termination · revocation · reduction in scope · Twitch's request · the end
user's request.**

The obligation attaches to **"data of an end user collected through the Twitch
APIs"**. That phrase is the load-bearing one, and it draws the line the hybrid
architecture already draws:

| Data | Collected through the Twitch APIs? | Must be deleted on revocation |
|---|---|---|
| `following_at_join` | **Yes** — derived from Get Followed Channels | ✅ **yes** |
| `subscribed_at_join` | **Yes** — derived from Check User Subscription | ✅ **yes** |
| `gravity_cluster_impression`, `join_clicked`, `join_arrived` | **No** — Watchside observing its own UI | ❌ no |
| `channel_dwell_ended` | **No** — Watchside observing its own tabs | ❌ no |
| `watching_together_*`, `post_social_retention_ended` | **No** — derived from Watchside presence | ❌ no |
| `destination_channel` on those events | **No** — read from the URL by our own content script | ❌ no |
| Channel metadata (title/live/avatar) from the Edge Function | **Yes**, but via an **app token**, and it is about a *channel*, not an end user | see §5.4 |

**This is the whole architectural argument, and it is now grounded in clause
language rather than inference.** Watchside's own event log is not Twitch API
data and does not fall inside the deletion trigger.

### 5.3 Sign-out is NOT de-authorization

They are different events and the brief is right to insist on the distinction:

| Event | What it is | Deletion obligation |
|---|---|---|
| **Watchside sign-out** | ends the Supabase session. The Twitch authorization **still stands** — the user has not disconnected anything | ❌ **none.** Nothing in the clause is triggered |
| **Twitch de-authorization** | the user disconnects Watchside in Twitch account settings, or the token is revoked | ✅ **triggered** |
| **Scope reduction** | the user re-authorizes with fewer scopes | ✅ **triggered** — explicitly named |

Treating sign-out as de-authorization would delete data the user never asked to
delete, and would destroy a baseline that is H2 and unrecoverable. **G6 must not
conflate them** (§18).

### 5.4 How quickly — **AMBIGUOUS**

The clause says **"upon"**. No numeric deadline surfaced, and none appears in
any extraction. Treat as *promptly*, not as a defined SLA.

**Recommendation:** design G6 to delete within one detection cycle and record
the timestamp, so the answer to "how quickly" is a measured fact rather than a
claim. Do not invent an SLA in the privacy policy that the DSA does not require.

### 5.5 Does previously fetched follow / subscription state need deleting? — **YES**

Both are "data of an end user collected through the Twitch APIs". There is no
carve-out for derived or minimised forms in any language obtained.

**Note the direction of the risk:** storing a *boolean derived from* the
response is unquestionably better for minimisation, but it does **not** move the
data outside the deletion obligation. Minimisation reduces exposure; it does not
change classification.

### 5.6 May Watchside-owned events remain? — **YES**

They are not Twitch API data (§5.2). This is the single most important
consequence of the hybrid split.

### 5.7 May aggregates remain? — **AMBIGUOUS, and this is the honest answer**

No obtained language addresses whether an aggregate computed *before* deletion
survives it, and **Twitch does not define "aggregated" or "de-identified"
anywhere I could reach.**

Two clauses pull in opposite directions:

- the deletion clause says *"all data of an end user"* — an aggregate over many
  users is arguably no longer data **of an end user**;
- the change-of-control clause (§9) explicitly reaches *"insights or aggregated
  information derived from such data"* — which shows Twitch **does**
  contemplate aggregates as a governed category in at least one place.

That second clause is the reason I will not record "aggregates may remain" as a
finding. **MARKED AMBIGUOUS. Owner/counsel decision (§29 O3).**

**Conservative design position pending that answer:** treat aggregates derived
from Twitch-derived observations as governed; keep them **recomputable** from
Watchside-owned data wherever possible, so that if the answer is unfavourable
the loss is a recomputation rather than a hole (§18.7).

---

## 6. Account-deletion obligations (D7.2)

When a user deletes their **Watchside** account, the DSA trigger reached is
*"upon … the end user's request"* — a deletion request is such a request.

| Must disappear | Why |
|---|---|
| every `creator_relationship_observations` row for that actor | Twitch API-derived data of that end user |
| the Twitch-derived identity linkage (`provider_id` in auth metadata) | collected through Twitch OAuth |

| May remain | Why |
|---|---|
| Watchside-owned analytics events | not Twitch API data — but see below |
| aggregates already computed | ⚠️ same ambiguity as §5.7 |

**A separate obligation already applies and is not a DSA matter:**
`analytics_events.actor_id` is a foreign key to `public.users` with
**`on delete cascade`** (`0013_analytics.sql`). So deleting the Watchside account
**already** removes that user's analytics rows today. That is Watchside's own
design, predates this work, and is stricter than the DSA requires.

**Consequence worth stating plainly:** account deletion is *already* more
destructive than de-authorization needs to be. G6 must therefore be a
**narrower** path than account deletion, not a reuse of it — de-authorization
must delete Twitch-derived observations **without** cascading the Watchside
event log, because the user has not asked to leave (§18.4).

---

## 7. Token obligations (D7.3)

### 7.1 Mechanics — confirmed from primary documentation

`POST https://id.twitch.tv/oauth2/revoke` with `client_id` and `token`. HTTP 200
on success; 400 invalid token; 404 invalid client id.
Source: `dev.twitch.tv/docs/authentication/revoke-tokens`, checked 2026-08-30.
**Confidence: HIGH** — the page loaded and rendered.

### 7.2 What the page does *not* say

It does **not** address user-initiated disconnection from Twitch account
settings, does not mention notification of the app, and does not mention any
webhook. That gap is filled by EventSub (§18.5), not by this page.

### 7.3 Can baseline-at-JOIN remain token-custody-free? — **YES**

Nothing found requires persisting a provider token. The M3B §26.3 mechanism is
unchanged and unchallenged:

- the check happens **at the JOIN**, in-session, while a provider token is
  already in hand;
- conversion is measured **opportunistically at a later sign-in**, which hands
  us a fresh token for free;
- no vault, no refresh loop, no scheduled job.

**No STOP.** The condition in the brief — *"if policy/API mechanics require
token custody merely to capture baseline state, STOP"* — is **not met**.

### 7.4 A storage obligation we should honour anyway

Supabase returns `provider_token` in the session at sign-in and does not persist
it (M3B §5.3d). Watchside will need to *read* it briefly to make the check.
**Design rule for M3D/M3E-a:** the token is used within the request that
receives it and is never written to storage, never sent to the extension, and
never logged. That is already the intended design; it is recorded here as a
requirement rather than a preference.

---

## 8. Data minimisation and permitted use (D7.4)

### 8.1 The permitted-use clause

> Twitch Data may not be used for purposes other than: *"(a) creating compelling
> benefits that improve the end user experience; (b) sending administrative
> communications; (c) sending periodic promotional communications to end users;
> (d) as necessary to process transactions; and (e) for limited purposes with
> end user permission."*

**Confidence: MEDIUM** — surfaced on one query.

### 8.2 Where Watchside's intended use lands

This is a **closed list**, which is stricter than a general reasonableness test,
and it deserves a careful reading rather than an optimistic one.

| Intended use | Fits? | Reasoning |
|---|---|---|
| Measuring whether Watchside produces creator discovery, so the product can be improved | **(a)**, plausibly | The measurement exists to make the social layer better at what it claims to do. This is the ordinary reading of product analytics. |
| Measuring relationship formation and attributed viewing | **(a)** | Same |
| Combining Watchside-owned events with Twitch-derived relationship state | **(a)** | The combination *is* the measurement |
| **Strategic / partnership evaluation** | ⚠️ **not squarely in (a)–(e)** | Improving the end-user experience is not the same purpose as demonstrating value to a platform. See below. |

**⚠️ This is a real tension and I am not going to paper over it.** The closed
list does not obviously accommodate "evidence for a partnership or acquisition
conversation" as a *purpose for collecting Twitch Data*. Two things reduce it,
neither of which fully resolves it:

1. **The collection purpose and the later use are separable.** The data is
   collected to measure and improve the product — (a). That a *by-product* of
   good measurement is a defensible story for a partner is not obviously a
   separate collection purpose.
2. **(e) exists**: *"for limited purposes with end user permission"*. The OAuth
   consent screen plus a plain privacy-policy statement is exactly an end-user
   permission mechanism, and §8.3 shows Twitch requires consent for this data
   class anyway.

**Recorded as an interpretation, not as policy.** Flagged for counsel (§29 O2).

### 8.3 Consent is explicitly required for this data class

> Developers *"must obtain consent for actions with end users' information or end
> users' devices, including without limitation access to **subscriber and
> follower information**."*

**Confidence: MEDIUM.** Directly on point — it names the two data classes M3D
and M3E-a want. The Twitch OAuth consent screen naming `user:read:follows` and
`user:read:subscriptions` is that consent, and the privacy-policy update (§20)
is its documentation.

### 8.4 Privacy policy is mandatory

> Developers *"must provide a publicly available and easily accessible privacy
> policy or notice that provides all disclosures required by applicable data
> protection laws, including without limitation, what data they are collecting
> and how they will use, display, share, store, and retain that data."*

**Confidence: MEDIUM-HIGH.** Watchside already satisfies this — published,
rendered from `docs/PRIVACY.md`, currently at
`anoteros-labs.github.io/watchside/privacy/`, moving to `watchside.app/privacy`
(§27). **Retention and deletion must be added for M3D/M3E-a** (§20).

### 8.5 The 24-hour cache clause — narrower than M3B assumed

> Developers cannot store copies of **Twitch Content and Program Materials**
> unless they *"obtain authorization … control the rights associated with such
> content, or cache such information for only a twenty-four hour time period
> without further sharing it with third parties."*

**Correction to M3B §16 and §5.4**, which listed this alongside the deletion
obligation as though it governed relationship data. It does not: on the language
obtained it governs **Twitch Content** (streams, VODs, assets) and **Program
Materials** (SDKs, docs) — not "Twitch Data" about an end user, which is
governed by the deletion clause in §5.

**Consequence:** there is **no 24-hour expiry** on `following_at_join` /
`subscribed_at_join`. They are governed by delete-on-revocation, not by a cache
window. **Confidence: MEDIUM** — this rests on the clause naming those two
defined terms, and defined terms are exactly what a JS-rendered page prevents me
from verifying. **Flagged for counsel** (§29 O2).

---

## 9. Sharing, sale, transfer and acquisition (D7.5)

### 9.1 The prohibitions

> *"Selling, licensing, or otherwise distributing any metadata or social
> content, or authorizing access to any metadata or social content, directly or
> indirectly (e.g., through multiple tiers of distribution), to anybody —
> **including data about purchases that end users make on the Twitch
> Services**."*

> Prohibited: *"transferring profile content or end user data to any advertising
> network, data broker, or other advertising or monetization-related service…"*

**Confidence: MEDIUM-HIGH** — surfaced consistently.

**Watchside is not a data broker and does not sell data.** Both prohibitions are
comfortably clear of the intended product. Note however the parenthetical:
Twitch expressly treats **subscription data as purchase data** — relevant to §15.

### 9.2 🚩 Change of control — the finding to read twice

> *"In the event you are registered as an individual developer and become
> employed by a third party, or the entity you represent undergoes a corporate
> change in control through merger, acquisition, or otherwise, you must obtain
> Twitch's prior written permission before your new employer or the surviving
> entity may collect, store, use, disclose, or otherwise process the Twitch Data
> described in the agreement, **including any insights or aggregated information
> derived from such data or user-related data**."*

**Confidence: MEDIUM-HIGH.**

**Aggregation is not an exit.** This is the clause that most directly touches the
strategic thesis, and it says so explicitly.

| Scenario | Effect |
|---|---|
| **Acquisition by Twitch / Amazon** | Twitch is the permission-granter. **No obstacle** — the primary thesis is unaffected. |
| **Acquisition by a third party** | The acquirer needs **Twitch's prior written permission** before processing Twitch Data *or aggregates derived from it*. |
| **Fundraising diligence (no change of control)** | Clause not triggered — it is scoped to change of control / new employer. Ordinary sharing rules still apply. |
| **Partnership discussions with Twitch** | Twitch is the counterparty. Not a third-party transfer. |

**It is a condition, not a prohibition.** That distinction is why this is a
prominent flag rather than a STOP.

---

## 10. Aggregate analytics and diligence implications

### 10.1 The distinction the brief asked for

| | Verdict |
|---|---|
| **A — selling/licensing Twitch-derived user data** | ❌ **Clearly prohibited** (§9.1). Watchside does not do this and must never. |
| **B — presenting aggregated product metrics** | ✅ **Not prohibited by any language obtained** — but see §10.3 |

Example B statements, and how each fares:

| Statement | Twitch-derived? | Assessment |
|---|---|---|
| *"Watchside-attributed creator discoveries generated Z observed stream-hours."* | **No** — dwell + attribution are Watchside-owned | ✅ **outside the restriction entirely** |
| *"X% of socially initiated creator visits were to creators the viewer did not already follow."* | **Yes** — the denominator's qualifier is `following_at_join` | ⚠️ derived from Twitch Data; §9.2 applies at change of control |
| *"Y% of socially initiated non-subscriber visits later showed a subscription relationship."* | **Yes** | ⚠️ same |

### 10.2 The strategic consequence, stated plainly

**Most of Watchside's evidence is untouched.** L1, L2, **L3 (observed stream
dwell)**, L7 and L8 are Watchside's own observations. They can be presented,
transferred and processed without any Twitch permission, because they are not
Twitch Data.

**The Twitch-derived layer (L4/L5/L6) is the constrained one**, and only for a
third-party acquirer.

This does **not** materially undermine the thesis, because the thesis was
already reframed in M3B §26.6: Watchside proves the **upstream causal link**;
Twitch evaluates downstream economics with its own internal data. That upstream
claim — incremental viewing, discovery, repeat engagement — rests mainly on
data Twitch's terms do not govern.

### 10.3 The residue, honestly

Whether stating a **percentage** in a deck is "disclosing Twitch Data" is
**AMBIGUOUS**. A percentage over a cohort is not obviously "data of an end
user"; but §9.2 shows Twitch contemplates *insights and aggregates* as governed
in the change-of-control context, so the safe reading is not free.

**Not a STOP**, for three reasons: it is a permission requirement rather than a
ban; Twitch is the counterparty in the primary scenario; and the majority of the
evidence is outside the restriction. **Owner/counsel decision O2/O3.**

---

## 11. Hybrid architecture — policy assessment

**The planned separation is appropriate, and D7 strengthens the case for it.**

| Layer | Twitch-governed? | Deletion on de-auth | Change-of-control clause |
|---|---|---|---|
| Watchside-owned immutable events — exposure, JOIN, arrival, dwell, shared watch, `attribution_id` | ❌ no | ❌ survives | ❌ not reached |
| Twitch-derived relationship observations — `following_at_join`, `subscribed_at_join` | ✅ yes | ✅ deleted | ✅ reached |
| Derived analytical views / aggregates | ⚠️ depends on inputs | recompute or purge | ⚠️ reached where inputs are Twitch-derived |

**Three properties the split buys, only one of which we originally claimed:**

1. **Deletion without collateral damage** (the original reason) — purge one
   table; the funnel survives.
2. **Change-of-control containment** (new) — the majority of strategic evidence
   is not Twitch Data and is not reached by §9.2.
3. **Honest provenance** — every number can be labelled as Watchside-observed or
   Twitch-derived, which is exactly what a diligence process will ask.

**Views are the one place to be careful.** A view that mixes both inherits the
stricter treatment. **Design rule:** keep views that mix layers *derivable*, and
keep at least one purely Watchside-owned view for every headline claim, so a
purge degrades the claim's precision rather than deleting it (§18.7).

**Uncertainty, recorded:** §5.7's aggregate question is unresolved, so whether
a pre-computed aggregate survives a purge is not settled. The design above is
chosen so that the answer changes a recomputation cost, not the availability of
the claim.

---

## 12. Mozilla source material

| Source | Detail |
|---|---|
| **Organisation** | Mozilla |
| **Document** | *Firefox built-in consent for data collection and transmission* |
| **URL** | `https://extensionworkshop.com/documentation/develop/firefox-builtin-data-consent/` |
| **Date checked** | 2026-08-30 · **loaded successfully** |
| **Confidence** | **HIGH** — category definitions quoted verbatim below |

| Source | Detail |
|---|---|
| **Document** | *Announcing data collection consent changes for new Firefox extensions* |
| **URL** | `https://blog.mozilla.org/addons/2025/10/23/data-collection-consent-changes-for-new-firefox-extensions/` |
| **Date checked** | 2026-08-30 · loaded |
| **Key facts** | Effective **3 November 2025**; applies to **new extensions only**, *"and not new versions of existing extensions"*; a missing-but-required declaration blocks signing. **No guidance on category choice.** |

| Source | Result |
|---|---|
| `support.mozilla.org/en-US/kb/extension-data-collection` | ❌ **failed to load** — returned a site error page. The user-facing wording for each category could not be confirmed, which matters to §15.4. |

---

## 13. `financialAndPaymentInfo` — the definition

Mozilla's own words, verbatim:

> **`financialAndPaymentInfo`** — *"credit card numbers, transactions, credit
> ratings, financial statements, or payment history"*

Required-only; **the user cannot refuse it**.

For contrast, the two categories Watchside already declares that are nearest to
a relationship fact:

> **`websiteActivity`** — *"interactions and mouse and keyboard activity, such as
> scrolling, clicking, typing, and actions, such as saving and downloading"*

> **`browsingActivity`** — *"Information about the websites users visit, such as
> specific URLs, domains, or categories of pages users view"*

And the special rule that constrains everything: **`technicalAndInteraction`**
*"must be optional only"* — the F6 boundary is a Mozilla structural rule, not
merely a Watchside choice.

### 13.1 The brief's A–F ladder, against that definition

| | Item | In `financialAndPaymentInfo`? |
|---|---|---|
| **A** | payment details — card, bank, billing | ✅ **yes** — "credit card numbers" |
| **B** | transaction / payment history | ✅ **yes** — named explicitly |
| **C** | **boolean subscription relationship** | ❓ **not named.** No amount, no instrument, no date, no history |
| **D** | subscription tier | ⚠️ closer — a tier implies a price point |
| **E** | gifted-subscription status | ⚠️ closer — speaks to how a purchase was made |
| **F** | gifter identity | ⚠️ closer, **and a third party's data** |

**Watchside intends only C.** D–F are excluded — and §13.1 shows *why* that
exclusion is more than minimalism: **each of D, E and F moves the datum toward
the financial category.** Collecting them would strengthen the argument for a
declaration we are trying to determine we do not need.

---

## 14. `following_at_join` classification (D8.2)

**Verdict: NO new category required. Confidence: HIGH.**

A follow is a public, free relationship to a channel. It is not payment
(§13), not communications, not PII beyond the user's own account, and not
device or browser data.

| Category | Applies? |
|---|---|
| `websiteActivity` — *"actions, such as saving and downloading"* | ✅ following a channel is such an action. **Already declared REQUIRED.** |
| `browsingActivity` — websites visited | ✅ the observation is bound to a channel the viewer visited. **Already declared.** |
| `financialAndPaymentInfo` | ❌ no payment element of any kind |
| `technicalAndInteraction` | ❌ not a report about our software |

**Watchside's declared set is unchanged:** `authenticationInfo`,
`browsingActivity`, `personalCommunications`, `websiteActivity`.
**`scripts/manifest.mjs` needs no edit for M3D.** The F6 zero-`technicalAndInteraction`
boundary is untouched.

---

## 15. `subscribed_at_join` classification (D8.3)

### 15.1 The explicit answer

> **3 — GENUINELY UNRESOLVED, and it cannot be resolved from documentation.**

Mozilla publishes the category definition (§13) and, per §12, **no guidance
whatsoever** on choosing between categories or on what to do when unsure. There
is no worked example, no boundary discussion, and no stated preference for
over-declaring.

### 15.2 The strongest reading of the definition — it does **not** cover C

The category names *"credit card numbers, transactions, credit ratings,
financial statements, or payment history"*. A point-in-time boolean:

- names **no amount**, **no payment instrument**, **no date**, **no history**;
- is **not a transaction record** — it is a relationship state;
- is **true for gifted subscriptions**, where a third party paid;
- is **true for Prime subscriptions**, where nothing was paid incrementally —
  and Twitch's own API cannot distinguish Prime from paid tier 1 (M3B §26.2).

That last pair is the strongest point available: **a `true` value does not
establish that the user paid anything.** A datum that cannot establish a payment
is a poor fit for a category about payment history.

### 15.3 The strongest reading against — and it is not weak

- Twitch's own DSA calls this class *"data about purchases that end users make
  on the Twitch Services"* (§9.1). If the data's own source characterises it as
  purchase data, a reviewer may reasonably follow that.
- Ordinary usage: "subscription" implies a recurring payment.
- Mozilla's category list is short and coarse; a reviewer may map anything
  purchase-adjacent onto it rather than leave it undeclared.

**Is a boolean insufficient, requiring more fields?** No. Nothing in this
research suggests the claim in M3B §26.3 needs tier, `is_gift` or gifter
identity. **The subscription baseline remains one boolean** — and §13.1 shows
adding fields would make the classification *worse*, not better.

### 15.4 Why "just declare it" is not automatically the conservative choice

The brief says correct disclosure beats minimising the permission list, and I
agree. But **over-declaring is a disclosure error too.**

If Watchside declares `financialAndPaymentInfo`, Firefox tells every user —
required, unrefusable, and shown on update — that Watchside collects financial
and payment information. Watchside would be collecting **one boolean about
whether you subscribe to a streamer**. A user reading that prompt would
reasonably conclude Watchside can see their card or purchase history. It cannot,
and never will.

**I could not confirm the exact user-facing string** — the Mozilla support page
failed to load (§12) — which is precisely why this is an ask-AMO question and
not a judgement call to make unilaterally.

### 15.5 Consequences if it IS required

| Question | Answer |
|---|---|
| Required or optional? | **Required-only.** Mozilla lists it among categories that cannot be optional |
| Can the user refuse? | **No** |
| Manifest change? | **Yes** — `GECKO_DATA_COLLECTION.required` gains a fifth entry |
| Install prompt? | Shows all required types |
| Update prompt? | *"Firefox only shows the added required data permissions"* — so **every existing user sees the new line on update** |
| Runtime consent? | **No** — required categories are consented at install/update, not at runtime |
| AMO review? | Declaration is checked for presence; a wrong/missing declaration blocks signing |
| Does "subscription to a creator" vs "subscription to Watchside" matter? | **Should**, and it is exactly the distinction to put to AMO. Watchside has no paid tier and takes no payment; the boolean is about a *third-party* relationship on Twitch |

### 15.6 Recommendation

1. **Ask AMO before M3E-a.** Owner action; this is what D8 always was. §29 O5
   carries the exact question to send.
2. **If AMO says required** → declare it, accept the update prompt, ship M3E-a
   with M3D at v0.8. A disclosure the reviewer expects is worth the prompt.
3. **If AMO says not required** → ship with the existing four categories.
4. **If AMO does not answer before v0.8 is otherwise ready** → **ship M3D alone**
   and hold M3E-a. Do **not** guess a financial declaration, and do **not**
   request `user:read:subscriptions` while not using it.

Point 4 costs a second consent change later. That is a real cost, and it is the
right one to pay: the alternative is either a possibly-wrong disclosure or
indefinitely losing an H2 baseline.

---

## 16. AMO manifest and review implications (D8.4)

**The pending Firefox v0.6.0 submission is untouched, and must remain so.**
Nothing in this checkpoint modifies its artifact, replaces it, submits a new
version, changes its listing, or alters its privacy declarations.

**Every D8 consequence applies to future releases only** — v0.7 at the earliest
for the dwell disclosure already shipped in `docs/PRIVACY.md`, and v0.8 for any
category change.

One timing note worth recording: Mozilla's requirement applies to **new
extensions**, not to new versions of existing ones (§12). Watchside's first AMO
submission already declares `data_collection_permissions`, so Watchside is
inside the regime and stays there. Adding a category later is a manifest change
on an existing extension, and the update-prompt behaviour in §15.5 is what
governs.

---

## 17. Scope-minimisation result

**Confirmed: exactly two scopes, and no more.**

| Scope | Endpoint | Why it is the minimum |
|---|---|---|
| `user:read:follows` | Get Followed Channels (`broadcaster_id`-filtered) | The filtered form answers "does this viewer follow this one creator" without ever retrieving the follow **list** |
| `user:read:subscriptions` | Check User Subscription | No app-token path exists (D9, closed) |

**Nothing else is needed, and nothing else should be requested.**
`user:read:moderated_channels`, `user:read:emotes`, `user:read:chat` were all
rejected in M3B §10/§15 and nothing here revisits that.

**Should both be requested simultaneously? — Yes, subject to §15.6.**

- One consent screen change instead of two; the trust budget is spent once.
- Both serve one coherent, explainable purpose: *did a socially discovered
  creator become one you follow or subscribe to?*
- Requesting a scope you do not yet use would be the wrong kind of
  minimisation — which is why §15.6 point 4 splits the *release* rather than
  requesting a scope early.

**Do not request scopes at install.** They are requested at the OAuth
authorization step, where the user is already choosing to connect Twitch.

---

## 18. G6 — deletion path design (DESIGN ONLY)

Not implemented. This is the minimum design D7 implies.

### 18.1 Keys and ownership

| | |
|---|---|
| **Deletion key** | `actor_id` — the Watchside user |
| **Ownership key** | same; `actor_id` is `auth.uid()` server-side, never client-supplied |
| **Scope of deletion** | every row in the Twitch-derived table for that actor |

### 18.2 Triggers — three, deliberately not two

| Trigger | Detection | Deletes |
|---|---|---|
| **Twitch de-authorization / revocation** | EventSub `user.authorization.revoke` (§18.5) | all Twitch-derived observations for that actor |
| **Scope reduction** | re-authorization observed with fewer scopes | observations belonging to the removed scope |
| **Watchside account deletion** | existing account-deletion path | Twitch-derived observations **and**, already today, the analytics events via `on delete cascade` |
| **Watchside sign-out** | — | ❌ **nothing.** Sign-out is not de-authorization (§5.3) |

### 18.3 What is deleted, and what is not

| Deleted | Retained |
|---|---|
| `creator_relationship_observations` rows for that actor | `gravity_cluster_impression`, `join_clicked`, `join_arrived` |
| any cached Twitch relationship state | `channel_dwell_ended`, `watching_together_*`, `post_social_retention_ended` |
| | `attribution_id` linkage |

### 18.4 The rule that keeps de-auth from over-deleting

De-authorization must **not** reuse the account-deletion path. Account deletion
cascades the analytics events (§6); de-authorization must not, because the user
has not asked to leave the product — they have asked Twitch to stop sharing.
Conflating them would destroy Watchside-owned measurement the DSA never reached.

### 18.5 Automatic de-auth detection — available

EventSub **`user.authorization.revoke`** exists and fires when a user revokes
authorization for **your `client_id`**. The subscription-types page lists **no
scope requirement**, consistent with it being created with an **app access
token** — which Watchside already mints for `twitch-metadata`.

Confirmed: the type exists and what it notifies about.
**Not confirmed:** exact payload fields and the token type required to create
the subscription — the page did not render those details. **Settle with one call
at implementation**, alongside the two API confirmations M3B §26.10 already
queued.

### 18.6 If automatic detection is unavailable

Fallback, in order:

1. **Detect at next use.** A 401 from Helix with the stored provider token means
   the authorization is gone → delete.
2. **Detect at next sign-in.** Compare granted scopes against expected.
3. **Bounded retention as a floor.** If neither fires, Twitch-derived
   observations expire on a fixed schedule regardless. This is a safety net, not
   the mechanism — but it means the worst case is bounded rather than open.

### 18.7 What the views do afterwards

- Views mixing layers return **fewer qualified rows** — the JOIN still exists,
  the relationship qualifier is gone.
- Pre-computed aggregates: **AMBIGUOUS** (§5.7). Design rule — keep aggregates
  **recomputable** from Watchside-owned data so an unfavourable answer costs a
  recomputation, not a claim.
- **Every headline claim should have a purely Watchside-owned form.** *"Watchside
  produced N attributed stream-hours"* survives any purge; *"…to creators they
  did not already follow"* degrades. Knowing which is which in advance is the
  point.

### 18.8 How deletion is proved — deterministically

1. **Round-trip test** — write observations for two actors, delete one, assert
   zero rows for them and unchanged rows for the other.
2. **Blast-radius test** — assert the Watchside event count for the deleted
   actor is **unchanged** (this is what catches an over-broad delete).
3. **View test** — assert the funnel still returns that actor's JOINs with the
   relationship qualifier now null.
4. **Contract test** — assert no Twitch-derived column exists on
   `analytics_events`, so a future edit cannot smuggle one in where deletion
   cannot reach it.
5. **Trigger-isolation test** — assert sign-out deletes nothing.

Tests 2 and 5 are the load-bearing ones: they encode the two mistakes this
design exists to prevent.

---

## 19. Minimal relationship-observation schema

Every column justified against a required claim, per the brief. Columns that
failed are listed with the reason.

### 19.1 Proposed minimum

| Column | Required by | Verdict |
|---|---|---|
| `actor_id` | deletion key; ownership; the join to the funnel | ✅ **keep** |
| `broadcaster_login` | identifies the creator; joins to `destination_channel` | ✅ **keep** |
| `attribution_id` | ties the observation to the JOIN that occasioned it | ✅ **keep**, nullable |
| `observed_at` | ordering; window arithmetic; "at JOIN" vs "later" | ✅ **keep** |
| `relationship_type` | `follow` \| `subscription` — one table, two facts | ✅ **keep** |
| `relationship_present` | **the datum itself** | ✅ **keep** |

Six columns. `relationship_present` should be **nullable**, so a failed check
(expired token, 429, network) is *absent* rather than false — the same
third-state discipline `destination_live` already uses.

### 19.2 Rejected

| Column | Claim it would serve | Verdict |
|---|---|---|
| `tier` | none committed | ❌ **reject** — and §13.1: it moves us toward the financial category |
| `is_gift` | none defensible without a timestamp or gifter | ❌ **reject** |
| `gifter_login` / `gifter_name` / `gifter_id` | none | ❌ **reject** — a third party who never consented |
| raw API response | none | ❌ **reject** — maximises deletion surface, minimises clarity |
| `provider_access_token` / `provider_refresh_token` | none — no custody (§7.3) | ❌ **reject** |
| `followed_at` (raw timestamp) | the boolean answers the claim | ❌ **reject** — M3B §15 |
| viewer's Twitch numeric id | derivable server-side at call time | ❌ **reject** — a durable Twitch identifier for nothing |
| `environment` | ⚠️ arguable | ⚠️ **defer** — decide at implementation; the joined event already carries it |

### 19.3 The separation that matters

This table is **physically separate** from `analytics_events`, which stays
append-only and purely Watchside-owned. A contract test should assert no
Twitch-derived column ever appears on `analytics_events` (§18.8 test 4) — the
whole architecture rests on that table remaining outside the DSA's reach.

---

## 20. Proposed future disclosure and authorization wording

**Not implemented — drafted for later review.**

### 20.1 The OAuth moment

The Twitch consent screen names the scopes in Twitch's words. What Watchside
controls is the explanation shown beside it:

> **Watchside would like to check your relationship with the streamers your
> friends are watching.**
>
> When you press JOIN, Watchside asks Twitch two questions about that streamer
> and stores two yes/no answers:
>
> - do you already **follow** them?
> - do you already **subscribe** to them?
>
> That is how we can tell whether Watchside actually introduces you to someone
> new, rather than sending you back to a streamer you already knew about.
>
> **We never see your card, your payments, or what you spend.** We do not
> download your list of follows or subscriptions — we ask about one streamer at
> a time, only when your friends are there. Disconnect Watchside in your Twitch
> settings and we delete both answers.

**Not "for analytics."** It says which two questions, when they are asked, what
is stored, what is not, and how to make it stop.

### 20.2 The privacy policy

`docs/PRIVACY.md` would gain a section covering: the two questions; that they
are asked only on a socially attributed JOIN; that one boolean each is stored;
that tier, gift status, gifter identity and payment data are **never** collected;
that no Twitch token is stored; retention; and that **de-authorizing Watchside
on Twitch deletes both**, while signing out does not.

The existing disclosure guard (`tests/extension/dwellDisclosure.test.ts`)
currently asserts the policy makes **no** claim about follows or subscriptions.
That assertion is correct today and must be **deliberately inverted** when
M3D/M3E-a ships — a failing test as the acknowledgement, exactly as designed.

---

## 21. v0.7 implications

**None. v0.7 is unaffected by both gates.**

| | |
|---|---|
| Contents | experiment-arm instrumentation · corrected observed per-stream dwell · focused/background diagnostic · repeat-creator measurement foundation |
| Twitch OAuth | ❌ **no change** |
| Firefox categories | ❌ **no change** |
| Privacy policy | ✅ already updated and published for dwell |
| Blocked by D7/D8? | ❌ **no** |

**v0.7 can proceed the moment the release work is done.** Neither policy gate
touches it.

---

## 22. v0.8 implications

**Feasible as planned, with the M3E-a half conditional on D8.**

| | |
|---|---|
| Contents | G6 deletion architecture · `following_at_join` · `subscribed_at_join` |
| Twitch OAuth | ✅ **ONE** change: `user:read:follows` + `user:read:subscriptions` |
| Token vault | ❌ **none** — confirmed unnecessary (§7.3) |
| Firefox categories | ⚠️ unchanged for M3D; **open for M3E-a** pending AMO (§15) |
| Privacy policy | ✅ required, both repos |
| Chrome disclosure | ✅ required |
| Gates | **G6 must land before the first Twitch-derived write** |

**Ordering inside v0.8 is not free:** G6 first, then the writes. A deletion path
built after data exists is a migration; built before, it is a table definition.

**Fallback if D8 is unanswered** (§15.6 point 4): ship M3D alone, hold M3E-a,
accept a second consent change later. Recorded as the owner's call (O6).

---

## 23. Updated public-launch roadmap

```
M3C.1 accepted ✅
      │
      ├── D7 (counsel confirms §5–§9)      ── in parallel ──┐
      ├── D8 (ask AMO — §29 O5)            ── in parallel ──┤
      │                                                     │
      ▼                                                     │
    v0.7  M3A arm + M3C.1 dwell            NO consent change│
      │   (not blocked by either gate)                      │
      ▼                                                     ▼
    v0.8  G6 → M3D → M3E-a                 ONE consent change
      │   (M3E-a conditional on D8)        NO token vault
      ▼
   M4.5  architecture / legacy audit + docs/FEATURES.md
      ▼
    M5   public product pack + watchside.app migration
      ▼
  Store Assets
      ▼
    M6   public release candidate
      ▼
    M7   PUBLIC LAUNCH        gated by M3B §26.9 (G1–G9)

  F7  Firefox signed-build acceptance — INDEPENDENT, whenever
      Mozilla approves the pending v0.6 submission
```

**Both invariants retained:**

> **NO MEANINGFUL PUBLIC GROWTH WHILE A HIGH-STRATEGIC-VALUE H2 MEASUREMENT
> WITH REASONABLE COLLECTION COST IS KNOWINGLY MISSING.**

> **MEASURE OBSERVABLE TWITCH CONSUMPTION FAITHFULLY; PRESERVE DIMENSIONS FOR
> STRICTER ANALYSIS LATER; BE CONSERVATIVE IN CLAIMS RATHER THAN DESTRUCTIVE IN
> COLLECTION.**

---

## 24. M4.5 — architecture, legacy and feature audit

**Committed pre-M5 milestone. Not started.** Purpose: enter public-product
hardening with a coherent codebase and an authoritative account of what
Watchside exposes to users.

### 24.1 Grounded scope — measured, not guessed

A first-pass inventory at `79ac2e4`:

| Area | Files mentioning `kickback` |
|---|---|
| `src/` | 47 |
| `tests/` | 55 |
| `docs/` | 53 |
| `supabase/migrations/` | 26 |
| `scripts/` | 23 |
| `public/`, `assets/` | 1 each |

Other measurements: **303** distinct `kb-` CSS classes · **2**
TODO/FIXME/HACK markers across `src`, `tests`, `scripts` — the codebase is not
carrying a large marker backlog.

### 24.2 Compatibility-sensitive — DO NOT rename casually

The audit must prove each remaining reference is *intentionally* held or
*scheduled*. These are held, and each has a concrete reason:

| Identifier | Why renaming is not free |
|---|---|
| `kickback:*` storage keys (`:analytics:session`, `:analytics:join`, `:analytics:lifecycle`, `:analytics:dwell`, `:layout`, `:collapsed`, `:channel`, `:groups:*`, `:attention:seen`, `:gathering:*`) | Renaming **orphans live state** on every installed client — open dwell intervals, sessions, attributions, panel layout |
| `SALT = 'kickback:social-gravity:v1'` (`src/core/experiment.ts`) | ⚠️ **Changing it re-randomises every user's experiment arm** and destroys longitudinal comparability. Effectively immutable |
| `KB-` friend-code prefix | Enforced by a **DB `CHECK` constraint** (`0001_schema.sql`); existing codes are shared with real people |
| `kickback-host` shadow-root id, `kb-` CSS | Renaming is a full-surface CSS migration with visual-regression risk for zero user benefit |
| `kickback-background.js`, `kickback-content` | Named in both manifests; changing them is a packaging change |
| Migration comments `0001`–`0027` | History. `0028` already recorded that rewriting them would falsify the record |
| `badge_definitions.issuer = 'kickback'` | A data value distinguishing our badges from Twitch's; carried to the client and compared, never rendered |

### 24.3 Classification framework

**KEEP** (compatibility/history) · **REMOVE** · **CONSOLIDATE** · **RENAME**
(user-visible only) · **DEFER**

### 24.4 Audit targets

Legacy branding in user-visible strings · stale brand assets · old URLs (→ §27) ·
**superseded single-destination assumptions** · superseded Gravity and Stream
Room paths · duplicate presence/cache/invalidation architecture · stale analytics
assumptions · **abandoned focused-only dwell assumptions** (M3C.1 removed
`switched_channel`; the audit must confirm no residue in docs, comments or
fixtures) · Chromium/Firefox adapter leakage beyond the two sanctioned
`IS_GECKO` decisions · obsolete beta flags and scaffolding · dead code, files,
scripts, assets · unused dependencies · the 2 TODO/FIXME markers · stale tests
and fixtures.

**Exit criterion:** every remaining `Kickback` reference is provably either
compatibility/history-sensitive **or** scheduled for removal/rename, with the
reason recorded.

---

## 25. M4.5 — `docs/FEATURES.md` requirement

**`docs/FEATURES.md` does not exist.** M4.5 must create and thereafter maintain
it as the authoritative user-facing feature inventory and how-to.

**Per feature:** name · product purpose · implementation status · first release
version · currently released platforms · **exact UI entry point** · literal user
flow · visibility conditions · empty state · backend dependency · relevant
analytics · known UX limitation.

**Lifecycle states:** `PLANNED` · `IMPLEMENTED` · `USER-FACING` · `RELEASED` ·
`VERIFIED`.

> **Nothing is "shipped" because backend infrastructure exists.**

**Must audit at minimum:** Twitch authentication · Friends · Friend Requests ·
Suggested Friends / mutual friends · Invite Friends · referral attribution ·
referral milestones · referral badges · presence · multi-destination presence ·
Social Gravity · JOIN · Stream Rooms · room chat · emotes · reactions · combos ·
Groups · group chat · notifications · blocking · muting · privacy controls ·
feedback · Twitch metadata · analytics-visible product behaviour · Chrome
support · Firefox support.

**Discoverability verdict required** for Suggested Friends, referrals and
badges: `DISCOVERABLE` · `DISCOVERABLE BUT WEAK` · `CONDITIONAL / INVISIBLE WHEN
EMPTY` · `BURIED` · `INFRASTRUCTURE ONLY` · `BROKEN / UNREACHABLE`.

These three are singled out for a reason worth stating: all have **substantial
server-side implementation** (`0026_growth_loop.sql` — suggestions, invites,
referrals with a four-condition success rule, badges) and their user-facing
surface has never been audited against it. Infrastructure existing is exactly
the failure mode this inventory exists to catch.

### 25.1 The roadmap sync found a live instance of exactly this

Synchronising `docs/ROADMAP.md` (§23) surfaced two entries that had gone stale
in the strongest possible way:

| Entry said | Reality at `79ac2e4` |
|---|---|
| *"Suggested Friends — **DEFER**. **Not implemented, verified against the repository.**"* | `suggest_friends()` exists in `0026_growth_loop.sql`, is wired through `src/background/index.ts`, surfaces as `FriendSuggestions` in `src/ui/components/GrowFriends.tsx`, and emits three analytics events |
| *"Invites — **DEFER**… there is no such way while installation is a ZIP. Revisit the day Watchside is listed."* | Chrome v0.6.0 is listed. `invite_codes`, `claim_invite`, referral attribution, three events, an invite landing page and `InviteFriends` all exist |

Both were corrected in this checkpoint. **Neither is a code defect — both
features work.** The defect is that the authoritative planning document asserted
one of them was unbuilt while it was shipping in production.

That is not a hypothetical argument for `docs/FEATURES.md`; it is a measured
one. A planning document drifts because nothing checks it. **The inventory is
the check**, and the discoverability verdict is what stops "it exists" being
mistaken for "users can find it" — which, for these two features, remains
genuinely unknown.

**Permanent documentation invariant:**

> A feature is not user-facing complete unless we can explain where a user
> encounters it and how they use it.

---

## 26. M5 — public product requirements

M5 now explicitly includes: new-user onboarding · **zero-friend experience** ·
Suggested Friends discoverability · Invite Friends discoverability · referral UX
· badge/milestone discoverability · empty states · failure and recovery states ·
privacy/trust presentation · **branded public-domain migration** (§27) · full
referral-flow acceptance.

The zero-friend experience and the three discoverability items are the same
concern from two directions: a social product whose social features are
invisible until you already have friends has a cold-start problem no amount of
measurement will fix. **M4.5's inventory (§25) is the input to M5's design**,
which is why it is sequenced first.

---

## 27. `watchside.app` migration requirement

**Locked product decision: `watchside.app` is the canonical public Watchside
domain.** The owner has reserved it.

**Nothing was configured, purchased, migrated or DNS-changed in this
checkpoint**, per the brief.

**Target public URLs:**

```
https://watchside.app/
https://watchside.app/i/<referral-code>
https://watchside.app/privacy
https://watchside.app/support
```

**Backward compatibility is mandatory:** existing
`https://anoteros-labs.github.io/watchside/…` URLs **must keep working** —
they are in a published privacy policy, in both Store listings, and in invite
links already shared with real beta testers. Current GitHub Pages hosting may
remain underneath the custom domain.

**M5 migration checklist:** GitHub Pages custom-domain configuration · domain
ownership verification · DNS · HTTPS · canonical URLs · **referral-link
generation switched to the branded form** · old-link compatibility ·
**invite → install → auth → referral attribution verified end to end on the new
domain** · Chrome listing URLs · Firefox listing URLs.

The current long GitHub Pages referral URLs are **accepted beta-era
compatibility URLs**, not the intended public presentation.

**Store assets remain deferred** until M3/M5 product and UI work settles, and
must then use branded `watchside.app` URLs, intentional seeded/demo states,
two-actor E2E capture where practical, no stale Kickback branding, and one
consistent product story across Chrome and AMO. **Do not refresh Store
screenshots now.**

---

## 28. Remaining unknowns

| # | Unknown | Impact | How it closes |
|---|---|---|---|
| **U1** | **The DSA was never read directly.** `legal.twitch.com` is JS-rendered; all clause text is search extraction of the primary source | Confidence ceiling on §5–§9 | Owner/counsel opens the page and confirms §5–§9 as a checklist |
| **U2** | Deletion **deadline** — "upon" is undefined | G6 timing claim | Counsel; design to a measured cycle meanwhile (§5.4) |
| **U3** | Whether **aggregates survive** deletion; "aggregated"/"de-identified" undefined by Twitch | Whether pre-computed metrics persist | Counsel (§5.7). Mitigated by keeping aggregates recomputable |
| **U4** | Whether **strategic evaluation** fits the closed permitted-use list (a)–(e) | Framing of the thesis | Counsel (§8.2) |
| **U5** | Whether the **24-hour clause** truly excludes relationship data — rests on defined terms I could not verify | Retention model | Counsel (§8.5) |
| **U6** | **`financialAndPaymentInfo` for a relationship boolean** | M3E-a's manifest and update prompt | **Ask AMO** (§29 O5) |
| **U7** | Mozilla's **user-facing string** for that category | Whether declaring it would over-disclose | Support page failed to load; ask AMO in the same message |
| **U8** | `user.authorization.revoke` **payload and token type** | G6 implementation detail, not viability | One live call at implementation |
| **U9** | Whether `gifter_login`/`gifter_name` are returned (M3B §26.1.5) | Sensitivity of the response we receive | Same live call. **We store neither regardless** |

**U1 is the honest headline.** Everything in §5–§9 is stated at MEDIUM to
MEDIUM-HIGH confidence and written so counsel can confirm rather than repeat it.

---

## 29. Owner decisions required

| # | Decision | Recommendation |
|---|---|---|
| **O1** | Commission the **D7 legal read** — counsel opens the DSA and confirms §5–§9 | ✅ **Yes.** This is D7's proper closure; my work makes it a checklist |
| **O2** | Accept the **permitted-use** (§8.2) and **24-hour** (§8.5) interpretations, or have counsel rule | ✅ Include in O1 |
| **O3** | Rule on whether **aggregates survive deletion** (§5.7) | ✅ Include in O1. Design already hedges |
| **O4** | 🚩 Accept the **change-of-control** constraint: a non-Twitch acquirer needs Twitch's prior written permission to process Twitch Data **or aggregates derived from it** (§9.2) | ✅ **Accept, and note the mitigation** — most strategic evidence is not Twitch Data |
| **O5** | **Ask AMO** whether a boolean "is this user subscribed to this third-party creator" requires `financialAndPaymentInfo` | ✅ **Yes — the long pole.** Send §15's framing: one boolean, no amount/instrument/date/history, true for gifted and Prime, about a third-party creator, no Watchside payment |
| **O6** | If D8 is unanswered when v0.8 is ready: **ship M3D alone** and hold M3E-a, accepting a second consent change later | ✅ **Yes** — better than guessing a disclosure or losing an H2 baseline |
| **O7** | Confirm **sign-out deletes nothing**; only de-authorization, scope reduction and account deletion do (§5.3, §18.2) | ✅ **Yes** |
| **O8** | Confirm the **subscription baseline stays one boolean** — no tier, no `is_gift`, no gifter | ✅ **Yes.** §13.1: each addition worsens the Mozilla classification |
| **O9** | Confirm **G6 lands before** the first Twitch-derived write | ✅ **Yes — blocking** |
| **O10** | Approve **M4.5** (audit + `FEATURES.md`) as a committed pre-M5 milestone | ✅ **Yes** — recorded in the roadmap |
| **O11** | Approve `watchside.app` as canonical, migrated in **M5**, with GitHub Pages URLs kept working | ✅ **Yes** |

---

## 30. Final recommendation

## **GO WITH DISCLOSURE CHANGE**

**M3D — GO.** `following_at_join` needs one scope, no token custody, **no
Firefox category change**, and a privacy-policy update. Nothing found blocks it.

**M3E-a — GO, conditional on D8.** `subscribed_at_join` needs the second scope,
no token custody, a privacy-policy update, and **an unresolved Firefox category
question that only AMO can answer**. The baseline stays one boolean.

**Both require a disclosure change** — privacy policy in both repositories, a
Chrome disclosure update, and a Twitch consent screen naming two scopes. Hence
*GO WITH DISCLOSURE CHANGE* rather than plain GO.

**The expected release sequence is unchanged:**

| Release | Contents | Consent | Verdict |
|---|---|---|---|
| **v0.7** | M3A arm + M3C.1 dwell | **no Twitch consent change** | ✅ **confirmed, unblocked** |
| **v0.8** | G6 → M3D → M3E-a | **ONE** OAuth change, **no token vault** | ✅ **confirmed feasible**, M3E-a conditional on D8 |

**No STOP condition was met.** For completeness, against the brief's list:
Twitch does not prohibit the intended measurement; deletion semantics are
*compatible* with the hybrid architecture and in fact justify it; aggregate
retention is ambiguous but hedged; the change-of-control clause is a permission
requirement, not a bar; Mozilla's classification is unresolved but has a defined
resolution path and a defined fallback; no additional scopes are required; token
custody is not required for baseline; the pending Firefox v0.6 submission is
untouched; and no product, schema, OAuth or package change was needed.

**Two things deserve to outlive this report:**

1. **🚩 Aggregation is not an exit from Twitch's terms.** The change-of-control
   clause reaches *"insights or aggregated information derived from such data"*.
   Any future plan that assumes "we'll just aggregate it" is wrong.
2. **The hybrid split is load-bearing twice over.** It was adopted for deletion.
   It turns out to also be what keeps L1, L2, L3, L7 and L8 — the majority of
   Watchside's strategic evidence — outside Twitch's data terms entirely,
   because those measurements are Watchside observing its own product rather
   than reading Twitch's API. **That is the strongest argument yet for keeping
   Twitch-derived data minimal, separable, and small.**
