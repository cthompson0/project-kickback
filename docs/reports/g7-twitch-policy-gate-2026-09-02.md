# G7 — Twitch legal / developer policy launch gate

**Date:** 2026-09-02
**Decision:** **B — CONDITIONALLY SATISFIED.** One real violation found and
fixed in the repository; one deployment remains as an owner action.
**Primary source obtained:** yes — the full DSA text, for the first time.

---

## 1. The headline

**G7 existed because nobody had ever read the contract.** The M3D/M3E policy
report said so in its own words:

> Because the agreement would not load, **clause text below comes from
> search-engine extraction of the primary source** … **This is not a substitute
> for a lawyer reading the page.** D7 closes when the owner (or counsel) opens
> `legal.twitch.com/legal/developer-agreement/` in a browser and confirms §5–§9.

That page is JS-rendered and returns only navigation to a fetcher — I reproduced
that across three URLs. **So I rendered it in a real browser and read it:
64,305 characters of contract text, last modified 04/12/2024.**

Everything below cites that text rather than a summary of it.

**One genuine violation was found**, and it is not one the earlier
search-extracted analysis could have seen.

---

## 2. Sources

| Source | URL | Date | How obtained |
| --- | --- | --- | --- |
| **Twitch Developer Services Agreement** | `legal.twitch.com/legal/developer-agreement/` | last modified **04/12/2024**, accessed 2026-09-02 | **Rendered in Chrome** — 64,305 chars including all four Schedules |
| Check User Subscription | `dev.twitch.tv/docs/api/reference` | 2026-09-02 | fetched (G5 pass) |
| Twitch Trademark Guidelines | `twitch.tv/p/legal/trademark/` — incorporated by DSA §I.4 | referenced, not separately fetched | see §9 |

Blogs, forums and third-party summaries were used for **nothing**.

---

## 3. Original G7 contract and provenance

From `m3b-twitch-economic-attribution-2026-08-30.md` §26.9:

> | **G7** | D7 legal read of the DSA complete | 🔴 **BLOCKING** for M3D/M3E-a |

Introduced by `m3d-m3e-policy-gates-2026-08-30.md`, which analysed four
sub-questions — D7.1 de-authorization, D7.2 account deletion, D7.3 tokens,
D7.4 data minimisation — at **MEDIUM to MEDIUM-HIGH confidence**, explicitly
labelled as not a substitute for reading the page.

### The M3D / G7 discrepancy — resolved

**Answer: C — G7's historical wording was overbroad, and B in part.**

G7 was written as *"the legal read is complete"*, which is a **process** gate,
not a compliance finding. It was recorded as blocking M3D because M3D was the
first Twitch-derived collection. M3D then shipped because the policy report's
own verdict was **"GO WITH DISCLOSURE CHANGE"** — the substantive analysis
passed; only the confirmation step stayed open.

**M3D itself is compliant** (§7). It does not require remediation. What was
genuinely unresolved was whether anyone had checked the contract — and now
somebody has.

**No history was rewritten.** The gate did what it was for: reading the actual
text found something four milestones of review had missed.

---

## 4. Classification — what Watchside is under the DSA

| Schedule | Applies? | Why — quoted |
| --- | --- | --- |
| **Body (I–VII)** | **YES** | Applies to all Program Materials use |
| **Schedule 1 — Twitch APIs** | **YES** | *"The terms of this Schedule apply if you use the Twitch APIs."* Watchside calls Helix |
| **Schedule 2 — Extensions** | **NO** | see below |
| Schedule 3 — Drops | NO | Watchside runs no Drops |
| Schedule 4 — box art | NO | uploads no artwork |

### Schedule 2 does NOT apply — recorded prominently

> *"The terms of this Schedule apply if you participate in **Twitch
> Extensions**."*
>
> *"the term 'Extension' means Your Services that are licensed, sold,
> distributed, or promoted **on the twitch.tv web application**, or its mobile,
> television, and console equivalents, **in connection with Twitch
> Extensions**."*

Watchside is distributed on the **Chrome Web Store and Firefox Add-ons**. It is
not licensed, sold, distributed or promoted on twitch.tv, and does not
participate in Twitch Extensions. Being a *browser* extension is irrelevant to
the capitalised term.

**Therefore none of these is required of Watchside:** Extension marketplace
review · broadcaster installation · the Extension iframe architecture · the
Extension Helper · Extension-specific moderation. Any future analysis that
applies Schedule-2 requirements to Watchside is wrong.

---

## 5. What Watchside actually does with Twitch

### Endpoints — complete inventory

| Endpoint | Purpose | Token | Scope | Stored? |
| --- | --- | --- | --- | --- |
| `id.twitch.tv/oauth2/token` | app token; credential refresh | app / refresh | — | token only, encrypted |
| `helix/users` | display name, profile image, user id | **app** | none | cache, §6 |
| `helix/streams` | live state, category, title, viewers | **app** | none | cache, §6 |
| `helix/channels/followed` | M3D `followed_at_join` | **user** | `user:read:follows` | one boolean |
| `helix/eventsub/subscriptions` | `user.authorization.revoke` | app | none | no |

**Scopes: `user:read:follows` only** (plus Supabase's own `user:read:email`).
Against Schedule 1 §A — *"You must only request access to the data and publishing
permissions necessary to implement Your Services' current features"* —
**COMPLIANT**, and enforced by eight tests that fail if a subscription scope is
added.

### Presence does not come from Twitch

**This is the factual anchor for Q7 and Q8, and it changes the analysis.**

The watched channel is parsed from `location.pathname` in the user's own browser
(`src/platforms/twitch/channels.ts`) — a string split against a reserved-path
list. **No Twitch API is involved.** Watchside observes the page its user is
already on, in their own browser, with their consent.

The Twitch API is used only to *decorate* that channel with a display name,
avatar and live state, server-side, with an **app** token — never a user token,
and never per-viewer.

---

## 6. **THE FINDING** — cached Twitch Content outlived its licence

**Schedule 1, Section C, verbatim:**

> *"Do not store copies of Twitch Content or Program Materials, unless you:
> (a) obtain prior written authorization from Twitch …; (b) control the rights
> associated with such content; or **(c) cache such information for only a
> twenty-four hour time period** without further sharing it with third
> parties."*

`public.twitch_metadata_cache` stores login, Twitch user id, display name,
profile image URL, live state, category and stream title — Twitch Content on any
reading.

Migration 0017 wrote `sweep_twitch_metadata_cache` and described it as:

> *"Called by the Edge Function opportunistically rather than on a schedule, so
> it needs no pg_cron and no extension."*

**Nothing ever called it.** The `twitch-metadata` Edge Function invokes only
`consume_metadata_budget`; there is no `pg_cron`; nothing else references the
function outside its own migration and a grant. **Rows have therefore
accumulated for the life of the project**, far beyond twenty-four hours.

It was invisible because the *serving* TTL is 2 minutes — the data is never
*used* when stale, so nothing ever looked wrong. But the clause governs
**storage**, not use.

**Meets the stop-ship standard**: a specific current provision, actual current
behaviour, a credible violation.

### Remediation — done in the repository

`writeCache` now calls the sweep opportunistically, exactly where 0017 intended,
inside a `try/catch` so housekeeping can never fail a caller's metadata request.
Four tests in `metadataSecurity.test.ts` hold it, including one asserting the
interval never exceeds the contractual twenty-four hours. All four fail if the
call is removed.

**The Edge Function must be redeployed for this to take effect in production.**
That is the one outstanding owner action. §12.

---

## 7. Policy questions

| # | Question | Verdict | Provision |
| --- | --- | --- | --- |
| 1 | Browser extension augmenting twitch.tv | **COMPLIANT** | Sch. 1 preamble — *"tools that use and interact with Twitch's applications, services, APIs, content, community, website"* |
| 2 | OAuth use | **COMPLIANT** | VI.E — approved flow, permissions disclosed |
| 3 | Scopes limited to current features | **COMPLIANT** | Sch. 1 §A |
| 4 | Storing Twitch identity | **COMPLIANT** | VI.B(a); VI.E — *"may not continue to associate a user ID with an end user if they un-authenticate"*, honoured by `purge_twitch_derived` + account deletion |
| 5 | Caching channel/stream metadata | **WAS NON-COMPLIANT — now remediated** | Sch. 1 §C — §6 above |
| 6 | Stale-data refresh duties | **COMPLIANT** | Sch. 1 §C — 2-minute serving TTL far exceeds *"commercially reasonable efforts to update cached results"* |
| 7 | Exposing viewing presence to friends | **COMPLIANT** | Presence is **not** Twitch API data (§5). VI.B(a) *"creating compelling benefits that improve the end user experience"*; VI.C bars sharing with **third parties** — a Watchside friend is an end user of Your Services, not a third party. Consent per Sch. 1 §A, plus the visibility control |
| 8 | Social Gravity / HERE | **COMPLIANT** | Watchside-derived aggregation over Watchside-owned presence. The only Twitch-derived part is the decorative channel metadata in §6 |
| 9 | JOIN | **COMPLIANT** | A navigation to twitch.tv. No API call, no interference with the player — Sch. 1 §D.1 untouched |
| 10 | M3D `followed_at_join` | **COMPLIANT** | Scope-appropriate (Sch. 1 §A); deleted on revocation (VI.F, Sch. 1 §C) by `purge_twitch_derived`; one boolean, not a follow list |
| 11 | Metadata caches | **remediated** | §6 |
| 12 | Avatars / profile images | **COMPLIANT** | Rendered from `static-cdn.jtvnw.net` by URL, not copied or re-hosted |
| 13 | Title / category / viewer count | **remediated** | Same cache; §6 |
| 14 | Attribution requirements | **COMPLIANT** | §I.4.ii permits Twitch Marks *"solely to attribute Twitch's offerings as the source"*. Watchside uses none |
| 15 | Implying affiliation | **COMPLIANT** | §9 |
| 16 | The name "Watchside" | **COMPLIANT** | Contains no Twitch mark |
| 17 | *"See where your friends are watching Twitch."* | **COMPLIANT** | Truthful nominative use; §9 |
| 18 | Twitch marks/assets | **COMPLIANT** | None used; §9 |
| 19 | Privacy policy contents | **COMPLIANT** | Sch. 1 §A — §10 |
| 20 | Terms of Service | **NOT REQUIRED BY TWITCH** | §11 |
| 21 | Deletion sufficiency | **COMPLIANT** | VI.F; Sch. 1 §C |
| 22 | Revocation deletions | **COMPLIANT** | `purge_twitch_derived` deletes credentials + observations |
| 23 | Twitch-requested deletion | **LIKELY COMPLIANT** | VI.F names *"Twitch's or the end user's request"*. The mechanism exists (service-role purge); no separate published channel is required by the text |
| 24 | Analytics on Twitch-derived data | **COMPLIANT** | VI.B(a). Channel names only; never sold, licensed or shared — VI.C |
| 25 | Acquisition attribution + Twitch identity | **COMPLIANT** | Campaign codes are Watchside-issued and carry nothing about the user; not a demographic cluster (Sch. 1 §B) |
| 26 | Friend suggestions | **COMPLIANT** | Derived from Watchside's own friendship graph. **Not Twitch social data** — Twitch exposes no viewer-to-viewer graph |
| 27 | Groups / messages / reactions | **COMPLIANT** | Watchside-owned user content; no Twitch obligation beyond ordinary privacy duties |
| 28 | 7TV | **NOT RELEVANT TO G7** | No Twitch provision reaches a third-party emote service. Not expanded |
| 29 | Rate limits at launch scale | **COMPLIANT** | Server-side app token, 2-minute cache, per-user budget on metadata |
| 30 | Overlapping Twitch social/discovery | **COMPLIANT** | Sch. 1 preamble invites tools that *"enrich, inform, enhance, and evolve functionality on Twitch"*. No non-compete exists in the text |

---

## 8. Retention matrix

| Data | Source | Stored | Retention | Twitch requirement | Compliant? |
| --- | --- | --- | --- | --- | --- |
| Channel metadata | **Twitch API** — raw Program Material | `twitch_metadata_cache` | served 2 min; **rows previously never swept** | Sch. 1 §C — 24 h | **fixed**, deploy pending |
| Twitch credential | Twitch OAuth | `twitch_credentials`, encrypted | until revoke / delete | VI.F | ✅ |
| `followed_at_join` | **Twitch API** | `creator_relationship_observations` | until revoke / delete | VI.F, Sch. 1 §C | ✅ |
| Twitch identity | OAuth | `users`, `connected_accounts` | until account deletion | VI.E | ✅ |
| **Presence** | **page URL — not Twitch API** | `presence` | overwritten; no history | not Twitch Data by source | ✅ |
| Channel name in analytics | derived | `analytics_events` | with account | VI.B(a) | ✅ |
| Friendships, groups, messages | **Watchside-owned** | own tables | until deleted | none | ✅ |

Three classes, three different obligations — raw Program Material (24 h),
Twitch-derived per-user fact (delete on revocation), Watchside-owned event
(no Twitch obligation). They are not interchangeable.

---

## 9. Trademark and presentation

Searched site, manifests, store metadata, README, UI copy and screenshots.

| Use | Verdict |
| --- | --- |
| The word "Twitch" in truthful sentences — *"See where your friends are watching Twitch"* | **Fine.** Nominative use naming the service Watchside works with. §I.4.ii restricts *Twitch Marks Twitch makes available to you*; it does not bar truthful reference |
| Twitch logo / Glitch | **Not used anywhere** |
| Twitch purple / trade dress | **Not copied.** Watchside's `#A855F7` is its own identity, established in the brand migration |
| Screenshots containing Twitch UI | Present on the site and in both listings — **unavoidable and honest** for a product that draws a panel on Twitch, and they carry the extension's own DEMO badge |
| Disclaimer | *"Watchside is not affiliated with, endorsed by, or sponsored by Twitch Interactive, Inc."* — present on the site footer, privacy policy and store listings |

**No claim of official status, partnership or endorsement found.** No remediation.

---

## 10. Privacy policy against Schedule 1 §A

> *"You must provide a publicly available and easily accessible privacy policy
> … that provides all disclosures required by applicable data protection laws,
> including without limitation, what data you are collecting and how you will
> use, display, share, store, and retain that data."*

`watchside.app/privacy` is public, linked from every page and from the extension.
The accuracy pass established that it names every data class, every third party
contacted, retention for each, and deletion routes. **COMPLIANT.**

Also satisfied: *"you must obtain consent for actions with your end users'
information"* (install + Twitch consent + visibility control), and *"make it
easy for people to contact you"* (§V) — `anoteros.dev@gmail.com` and
`watchside.app/support`.

**Watchside sets no cookies**, so Schedule 1 §A's cookie rules do not engage.

---

## 11. Launch documents

| Document | Status | Classification |
| --- | --- | --- |
| Privacy Policy | live | **REQUIRED BY TWITCH** — satisfied |
| Contact / support | live | **REQUIRED BY TWITCH** (§V) — satisfied |
| Data deletion instructions | in policy + in-product | **REQUIRED BY TWITCH** (VI.F) — satisfied |
| Twitch disclaimer | present | prudent; satisfied |
| **Terms of Service** | absent | **PRUDENT BUT NON-BLOCKING.** No DSA provision requires a developer ToS. Do not add one merely because SaaS products have them |

---

## 12. Decision: **B — CONDITIONALLY SATISFIED**

One violation, found against primary text, fixed in the repository. Everything
else compliant.

**Remaining owner action — one:**

```
supabase functions deploy twitch-metadata
```

Verify afterwards that the table stops growing:

```sql
select count(*) as rows,
       min(fetched_at) as oldest
  from public.twitch_metadata_cache;
-- after the next metadata fetch, `oldest` must be within 24 hours
```

Until that deploy, production continues storing cached Twitch Content beyond the
permitted window. The fix is committed; only the deployment is outstanding.

**Nothing else blocks v0.9 store submission** on Twitch-policy grounds.

**Before controlled public launch:** this deploy, Chrome v0.8 clearing review,
owner approval of v0.9 submissions. **G1** then follows from production data.

---

## 13. Verification

| Gate | Result |
| --- | --- |
| Full suite | **3,183 passed / 133 files** |
| Destruction mutations | **109 / 109** |
| lint, typecheck | clean |
| `verify:store` | clean |
| Privacy verification | 14 passed |
| Chrome v0.8 artifact | `cb3af261448280cb…` — untouched |
| New guards | 4, in `metadataSecurity.test.ts`; all fail without the sweep call |

**Nothing was submitted. Twitch was not contacted.** The DSA was read as a
public web page, which is what the gate asked for.
