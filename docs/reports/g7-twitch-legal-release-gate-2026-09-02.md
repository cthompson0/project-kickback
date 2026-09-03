# G7 — Twitch legal / developer policy release gate

**Date:** 2026-09-02
**Scope:** audit only. No runtime code, scopes, permissions, schema, privacy
copy, website copy or store copy was changed. Nothing was deployed, pushed or
submitted.
**Repository state audited:** `88c2197`, schema 43.

---

## 1. Executive verdict

# B — G7 CONDITIONALLY SATISFIED

**One concrete, release-blocking remediation.** It requires no code: the code is
already written and committed.

> **Deploy the `twitch-metadata` edge function.** Its cache sweep was added in
> `a5cf0fd` and has never been deployed, so production has been retaining copies
> of Twitch Content beyond the twenty-four hours Schedule 1 §C permits — for as
> long as the project has existed.

Everything else audited clean. Two narrow ambiguities are recorded for explicit
owner acceptance in §18; **neither is a blocker** and neither has an obvious
technical remediation.

**Nothing about the v0.9 product** — its architecture, its scopes, its DOM
footprint, its branding, its analytics — was found to conflict with any Twitch
provision. The single breach predates v0.9 and is unrelated to it.

---

## 2. Original G7 provenance

**Recovered, not redefined.** G7 comes from the M3B gate table
(`docs/reports/m3b-twitch-economic-attribution-2026-08-30.md:1691`):

> | **G7** | D7 legal read of the DSA complete | 🔴 **BLOCKING** for M3D/M3E-a |

**D7** is the underlying decision (`m3b…:1010`), and it is narrower and more
specific than "read the DSA":

> | **D7** | Commission a **legal read of the Twitch DSA** (24-hour caching;
> deletion on revocation; whether a derived boolean is "Twitch Data") | M3D,
> M3E | ✅ **Yes** before either. **I could not verify verbatim text (§16).** |

**What evidence was originally expected.** Three specific answers, from the
primary text. G7 existed *because the primary text could not be obtained* —
`legal.twitch.com` is JS-rendered and returns only navigation to a fetcher. The
M3B report was explicit that its clause text came from search-engine extraction
and was "not a substitute for a lawyer reading the page."

**I reproduced that blocker independently** before working around it: a plain
fetch of the DSA returned navigation, footer links, and a leaked Hugo source
path — no contract text. I then rendered it in Chrome and read **64,555
characters**, all four Schedules included.

**Did later changes alter G7's scope?** Yes, in one direction: G7 was recorded
as *blocking for M3D/M3E-a*, and **M3D shipped while G7 was open** — an
inconsistency already flagged in the G5 report (`g5-…:419`). M3E-a
(subscriptions) was never built, so half of G7's original subject matter is
moot. What remains live is M3D's follow-state, which §7 audits, plus the
whole-product questions this pass adds.

The prior G7 pass (`g7-twitch-policy-gate-2026-09-02.md`) reached "B" and fixed
the sweep in the repository. **This audit re-derived every conclusion from the
current text and current code rather than inheriting it**, and reaches the same
verdict for the same reason — because the fix is still not deployed.

---

## 3. Watchside / Twitch architecture

| Surface | What actually happens | File |
| --- | --- | --- |
| **Auth** | Supabase-brokered Twitch OAuth. Scopes: `user:read:follows` (ours) + `user:read:email` (Supabase's provider requests it for itself) | `src/background/auth.ts:76` |
| **Token custody** | `provider_token` / `provider_refresh_token` are **deleted from browser storage** on write; custody is server-side and encrypted | `src/background/storage.ts:36` |
| **Twitch API** | **All** calls are server-side in Supabase edge functions. None from the client | `supabase/functions/*` |
| **Endpoints** | `id.twitch.tv/oauth2/token`, `/validate`; `helix/users`, `helix/streams`, `helix/channels/followed`, `helix/eventsub/subscriptions` — all documented | — |
| **Presence** | `parseChannelFromPath(window.location.pathname)` — the user's own address bar, in their own browser | `src/platforms/twitch/channels.ts:62` |
| **JOIN** | `window.location.assign('https://www.twitch.tv/<channel>')` — an ordinary navigation | `src/platforms/twitch/join.ts:39` |
| **Watch Together / chat** | Watchside-native over Supabase. **Twitch chat is never read, proxied, stored or written** — verified by search | — |
| **Injection** | One `<div>` appended to `document.body`; `position:fixed; inset:0; pointer-events:none`, open shadow root. **The only write to Twitch's DOM** | `src/content/index.tsx:70` |
| **Fullscreen** | Host hidden on `fullscreenchange` | `src/content/index.tsx:196` |
| **7TV** | `7tv.io/v3` for emotes. Receives a **channel login from the URL**; 7TV's own GraphQL resolves it to an id | `src/background/sevenTv.ts:144` |

Twitch's DOM is **read** in exactly three advisory places — `<nav>` bottom and
chat-rail width (default panel placement only), and `<title>`/URL (SPA
navigation). No Twitch Content is extracted from the page.

---

## 4. Applicable agreements

| Document | URL | Date | Obtained |
| --- | --- | --- | --- |
| **Twitch Developer Services Agreement** | `legal.twitch.com/legal/developer-agreement/` | **Last modified 12/04/2024** | Rendered in Chrome, 64,555 chars, 2026-09-02 |
| **Twitch Terms of Service** (DSA §II.4) | `twitch.tv/p/legal/terms-of-service/` → `legal.twitch.com` | **Last modified 08/12/2026** | Rendered in Chrome, 56,114 chars |
| **Twitch Trademark Guidelines** (DSA §II.4) | `legal.twitch.com/legal/trademark/` | **Last modified 07/11/2018** | Rendered in Chrome, 7,304 chars |
| **Twitch Community Guidelines** (DSA §II.4) | `twitch.tv/p/legal/community-guidelines/` | — | Incorporated; no Watchside behaviour engages it (Watchside hosts no public content) |

The DSA is **unchanged** since the prior pass. The **ToS is recent
(08/12/2026)** and was read fresh for this audit.

No blog, forum, Stack Overflow answer or third-party summary was used for any
conclusion.

---

## 5. Twitch Extension vs browser extension — the applicability question

**Decided from each Schedule's own scope clause, quoted verbatim.**

| | Scope clause | Applies? |
| --- | --- | --- |
| **Schedule 1** | "The terms of this Schedule apply **if you use the Twitch APIs**." | **APPLIES.** Watchside calls Helix. |
| **Schedule 2** | "The terms of this Schedule apply **if you participate in Twitch Extensions**." … "'Extension' means Your Services that are **licensed, sold, distributed, or promoted on the twitch.tv web application**, or its mobile, television, and console equivalents, **in connection with Twitch Extensions**." | **DOES NOT APPLY.** Watchside is distributed through the Chrome Web Store and AMO, is not on twitch.tv, and does not participate in Twitch Extensions. |
| **Schedule 3** | "…if you participate in or use the Drops Program" | **DOES NOT APPLY.** |
| **Schedule 4** | "…if you upload any box art or equivalent packaging or artwork" | **DOES NOT APPLY.** |

**This matters concretely, and not only as a label.** The most ad-specific
prohibition in the entire agreement —

> "Do not modify, replace, interfere with, limit, block, cover, or obscure: (a)
> the functionality of embeddable experiences, **including advertisements within
> the player**" — Schedule 1 §D.1

— is scoped to **embeddable experiences**, i.e. Twitch embeds you place in your
own surface. Watchside embeds nothing; JOIN is a browser navigation to Twitch's
own page, where Twitch serves its own player and its own ads. §D.1 therefore
does not reach the floating panel. §13 addresses the panel on its own terms
rather than borrowing this clause.

Likewise **Schedule 1 §D.2 (Chat)** governs use of Twitch's chat. Watchside's
chat is entirely its own and never touches Twitch's — so §D.2 does not apply,
and its retention and opt-out requirements are not triggered.

The main body (§I–XIII), including **§VI Data Policy**, applies regardless of
Schedule.

---

## 6. OAuth / scope audit

**Requested:** `user:read:follows`, and nothing else
(`REQUESTED_SCOPES`, `auth.ts:76`). Supabase's Twitch provider separately
requests `user:read:email` for itself.

**Not requested, anywhere in the repository:** `user:read:subscriptions`,
`channel:*`, `moderator:*`, or any write scope. A repository-wide scope grep
returns only the two above.

| Provision | Verdict |
| --- | --- |
| Sch. 1 §A "only request access to the data and publishing permissions necessary … Do not request … even if such data or permissions **might benefit Your Services' anticipated future services**" | **COMPLIANT.** One scope, one feature. The source comment names the rule the scope set enforces: "Anything about subscriptions, purchases or writing to somebody's account" must never be added. |
| §VI.E "use only authentication flows that are set forth in the relevant Program Materials" | **COMPLIANT.** Standard Twitch OAuth via Supabase. |
| §IV.B "Keys … Keep them secret" | **COMPLIANT.** `TWITCH_CLIENT_SECRET` is an edge-function environment variable; it never reaches the client. |
| §IV.D security measures | **EXCEEDED.** Provider tokens are stripped from `chrome.storage.local` on write and held encrypted server-side. |

**Failure modes specifically checked and absent:** no user token used where an
app token belongs (metadata uses `client_credentials`); no app token used where
a user token is required (follow lookup uses the decrypted user token); no token
in any log statement.

---

## 7. API endpoint and data-use audit

| Endpoint | Credential | Purpose | Cached | Persisted |
| --- | --- | --- | --- | --- |
| `helix/users`, `helix/streams` | **App token** | Channel display name, avatar, live state, title, category, viewers | 2 min serving TTL; **1-day retention sweep** | `twitch_metadata_cache` |
| `helix/channels/followed?user_id&broadcaster_id` | **User token** + `user:read:follows` | One boolean, one broadcaster | no | `creator_relationship_observations` (boolean only) |
| `id.twitch.tv/oauth2/token`, `/validate` | Client credentials / refresh | Token lifecycle | no | encrypted `twitch_credentials` |
| `helix/eventsub/subscriptions` | App token | Subscribe to `user.authorization.revoke` | no | no |

All documented Helix endpoints. **No undocumented or internal Twitch API is
used, and twitch.tv is never scraped for data** — satisfying §XI.I ("You will
not access undocumented Program Materials … will only access Program Materials
documented on the Twitch Developer Site") and ToS §xi.

---

## 8. Presence audit

**Presence is not Twitch API data.** It is derived from
`window.location.pathname` in the user's own browser
(`channels.ts:62`) and reduced to `{ status, platform, channel }`.

- Twitch is never asked where anybody is.
- No Twitch API call participates in producing presence.
- Visibility is user-controlled — Visible / Hide activity / Invisible — and
  enforced **server-side at write time** (`report_presence`, migration 0025),
  not filtered on read.
- Invisible deliberately does not tick `last_seen_at` when the row is already
  blank, so a friend cannot infer "online but hiding".

This satisfies Sch. 1 §A's "You must follow end user controls, consent, and
permissions when deciding whether to store an end user's data."

The one place presence touches the DSA's language is §VI.C's phrase "any data
you collect about Twitch's end users **or their browser or mobile app
activity**". That is addressed as an ambiguity in §18 — it is not a finding of
non-compliance.

---

## 9. Social Gravity audit

**Verified from code, not from intent.** `gravityModel`
(`src/core/socialGravity.ts`) orders sections by:

1. section kind — `here`, `destination`, `around`, `offline`;
2. within destinations only, an ended stream sinks below a live one;
3. ties keep `clusterMembers`' order, which is **friend count**, then
   alphabetical.

`viewerCount`, `gameName` and `title` appear in that file **only inside a
comment**. They reach no sort, no rank, no filter. A grep for them against the
ordering path returns nothing.

So: **friends gathering is the signal; Twitch metadata enriches the card and
cannot define or rank it.** The single metadata input to order is the binary
live/ended state, which is "declining to put a JOIN that leads nowhere at the
top" rather than ranking by Twitch data.

**Legal analysis.** No Twitch provision prohibits recommendation as such. The
two that could bite:

- Sch. 1 §B "Creating demographic clusters for the purpose of contacting or
  targeting Twitch's end users" — **DOES NOT APPLY.** The clusters are the
  viewer's own accepted friends grouped by channel, shown only to that viewer,
  for navigation. They are not demographic, and nobody is contacted or targeted.
- Sch. 1 §B "Selling, licensing, or otherwise distributing any metadata or
  social content … to anybody" — **DOES NOT APPLY.** Nothing is sold, licensed
  or distributed; metadata is displayed to the end user who requested it, which
  is the ordinary function of an API client.

---

## 10. JOIN / Watch Together audit

**JOIN** is `window.location.assign(channelUrl(channel))` — a plain browser
navigation. Watchside does **not** embed, proxy, rebroadcast, transcode,
intermediate or wrap Twitch video. The user arrives on twitch.tv, in Twitch's
player, with Twitch's ads and Twitch's chat.

Consequences:
- Sch. 1 §D.1 (embeddable experiences, and its ad-obscuring prohibition) —
  **DOES NOT APPLY**; there is no embed.
- ToS §222 "Twitch has the exclusive right to … sell, serve, and display
  advertisements" — **COMPLIANT**; Watchside serves no advertising of any kind.

**Watch Together / chat** is Watchside-native, carried over Supabase Realtime.
Twitch chat is never read, proxied, modified or stored — verified by searching
the content script and platform layer for any chat selector or IRC client;
there are none. Sch. 1 §D.2 is therefore not engaged.

**7TV** receives a channel login taken from the URL and returns emote sets. It
receives **no Twitch API data**: the login→id resolution is performed by 7TV's
own GraphQL (`sevenTv.ts:30`, `:112`), not by our Helix calls. §VI.C's
third-party sharing prohibition is not engaged.

---

## 11. M3D follow-state audit

| Question | Answer |
| --- | --- |
| Endpoint | `GET helix/channels/followed?user_id=<viewer>&broadcaster_id=<creator>` |
| Scope | `user:read:follows` — the only scope Watchside requests |
| Credential | The **user's own** token, decrypted server-side per call |
| Breadth | Scoped to **one broadcaster**. The follow *list* is never retrieved |
| Stored | A boolean plus `broadcaster_login`, `observed_at`, `attribution_id` — `creator_relationship_observations`, migration 0032:108 |
| Retention | Until Twitch revocation or account deletion |
| Deletion | `purge_twitch_derived(actor)` deletes credentials **and** observations; called by the eventsub handler on `user.authorization.revoke` (`twitch-eventsub/index.ts:307`) and by `delete-account` (`:114`) |
| Inference | None. It records a **baseline relationship at JOIN**. No causal claim, no conversion attribution |
| Subscriptions | **Not collected.** No `user:read:subscriptions` scope exists anywhere in the repository |
| Disclosure | `docs/PRIVACY.md:82` and `:157` — named, with its deletion trigger |

**D7's third question — is a derived boolean "Twitch Data"? — is answered YES,
by the definition itself:**

> "**§VI.A.** This Section VI sets forth Twitch policy with respect to your use
> and disclosure of data collected from your Extensions or Drops, or from the
> Twitch API …, **including any insights derived from that data** or in
> combination with other data to which you have access ("**Twitch Data**")."

So `following_at_join` **is** Twitch Data, and:

- **§VI.F / Sch. 1 §C ¶2 deletion on revocation — APPLIES, and is implemented.**
- **§VI.C no third-party sharing — APPLIES, and is honoured**: the boolean is
  never shown to anyone, including the user's friends; only aggregates are used.
- **The 24-hour cache cap does NOT apply to it.** That cap is written against
  "copies of **Twitch Content or Program Materials**" (Sch. 1 §C), a narrower
  term than "Twitch Data". A derived boolean is an insight, not a copy.

That distinction is the substantive legal output of this gate, and it is what
makes M3D lawful while the metadata cache is not.

**Verdict: COMPLIANT.**

---

## 12. DOM / UI injection audit

**One write to Twitch's DOM, ever:** `document.body.appendChild(host)`.

The host is `position:fixed; inset:0; overflow:visible; **pointer-events:none**;
z-index:2147483000`, carrying an **open shadow root**. Only the panel inside it
takes pointer events, so every Twitch control outside the panel's own rectangle
remains clickable. All styling is inside the shadow root and namespaced `kb-`.

Watchside does **not** remove, replace, restyle, reorder, or hide any Twitch
element. It does not touch the player, chat, recommendations, monetization
surfaces, or tracking. A `MutationObserver` watches only `<title>` and its own
host's connectedness — never Twitch's layout.

| Provision | Verdict |
| --- | --- |
| ToS §108(c) "modifying or otherwise making any derivative uses of the Twitch Services" | **AMBIGUOUS on a literal reading, compliant on a purposive one.** See §18. |
| ToS §178(vi) circumventing security/limitation features | **COMPLIANT** — none touched |
| ToS §184(ix) interfering with operation or others' enjoyment | **COMPLIANT** — affects only the installing user's own view |
| ToS §188(xi) robots/scrapers/crawlers | **COMPLIANT** — no automated access; the user navigates, the script reads its own tab's URL |
| ToS §192(xiii) disrupting the service | **COMPLIANT** |
| DSA §II.3 "not interfere with, modify, disrupt or disable features … of the Program Materials" | **COMPLIANT** — Program Materials are the APIs/SDKs, which are used as documented |

---

## 13. Advertising / interference audit

**Watchside serves no advertising, contains no ad network, and has no ad-related
code.** ToS §222 is satisfied.

**Does the panel obscure Twitch ads?** Assessed honestly rather than dismissed:

- The panel floats over the page and **the user can drag it anywhere**,
  including over the player, where it could overlap a video ad.
- But: default placement deliberately clears the top nav and steps aside from
  the chat rail (`anchor.ts`, `chatRail.ts`); the panel hides itself entirely in
  fullscreen; it can be collapsed to a 42px launcher; and **nothing in Watchside
  detects, targets, blocks, skips, mutes, or counts ads.** No ad is prevented
  from loading, playing, or being measured.
- The DSA's ad-obscuring prohibition (Sch. 1 §D.1) is **embed-scoped** and does
  not reach a browser overlay (§5).

**Verdict: COMPLIANT.** The residual is that a user may voluntarily position a
window over their own video. That is a property of every floating window in
every operating system, is under the user's control, and is not ad
circumvention. **No remediation proposed** — changing behaviour here would be
exactly the speculative compliance work this audit was told not to do.

---

## 14. Branding / trademark audit

Trademark Guidelines govern "**Twitch Brand Assets**"; the DSA defines "Twitch
Marks" as brand indicia "**that Twitch makes available to you**".

| Check | Finding |
| --- | --- |
| Twitch logo / Glitch used? | **No.** No Twitch mark exists in `assets/brand/` |
| "Twitch" in product name? | **No.** "Watchside" |
| "Twitch" in domain? | **No.** `watchside.app` |
| Brand colour | Deliberately **not** Twitch purple — `geometry.mjs:33`: "NOT Twitch's logo, and deliberately NOT Twitch purple (#9146FF)" |
| Guidelines line 40/101 — no Brand Assets in domain, app, business, product or service names | **COMPLIANT** |
| Guidelines line 44 — no use suggesting affiliation/partnership/endorsement | **COMPLIANT** |
| Disclaimers | Present on **all three** public surfaces: `watchside.app` ("not affiliated with Twitch Interactive, Inc."), the store listing ("not affiliated with or endorsed by"), and the privacy policy (plus explicit trademark attribution) |

Uses of "Twitch" are descriptive and nominative — "See where your friends are
watching on Twitch", "The social layer for Twitch". These identify the platform
Watchside works with, use no Twitch imagery, and are accompanied by disclaimers.
That is textbook referential use and is not restricted by the Guidelines, which
regulate Brand Assets.

**No disclaimer is contractually required** by the text; Watchside carries them
anyway, which lowers confusion risk further. **No remediation.**

---

## 15. Data retention / deletion / privacy audit

| Obligation | Implementation | Verdict |
| --- | --- | --- |
| §VI.F / Sch. 1 §C — delete end-user data on **revocation** | Twitch EventSub `user.authorization.revoke` → `purge_twitch_derived` | **IMPLEMENTED** |
| …on **user request** | `delete-account` edge function → `purge_twitch_derived` → `auth.admin.deleteUser` | **IMPLEMENTED** |
| Sch. 1 §C(c) — **24-hour cache cap** on Twitch Content | `sweep_twitch_metadata_cache('1 day')` written, committed, **NOT DEPLOYED** | **✗ BREACH — §19** |
| Sch. 1 §C — "update cached results … delete when Twitch reports them as deleted or expired" | 2-minute serving TTL; stale rows never served | **COMPLIANT** |
| Sch. 1 §C — "Re-syndication and re-distribution … is prohibited" | Metadata is served only to authenticated Watchside users who requested those channels, under a per-user budget. Not redistribution to third parties | **COMPLIANT** |
| Sch. 1 §A — public, accessible privacy policy stating what is collected, used, shared, stored, retained | `docs/PRIVACY.md`, live at `watchside.app/privacy` | **COMPLIANT** |
| §VI.C — no sale/licence/monetization/third-party sharing of Twitch Data | Nothing sold or shared; no ad network, no data broker; 7TV receives no Twitch API data | **COMPLIANT** (see §18 for the friend-visibility reading) |
| §VI.D — store securely, only as long as needed | Tokens encrypted server-side and absent from the browser | **COMPLIANT** |
| §VI.B — permitted purposes | Product function and product measurement fall under (a) "creating compelling benefits that improve the end user experience" | **COMPLIANT** |

The privacy policy specifically discloses Twitch identity, the Twitch
authorisation credential, presence-and-channel, and the follow-state boolean,
each with its sharing and retention rule — `PRIVACY.md:66, 69, 72, 82, 143,
157`.

---

## 16. Rate limit / caching / API hygiene

| Check | Finding |
| --- | --- |
| Batching | Helix-sized batches (`chunk(logins, HELIX_BATCH_LIMIT)`) |
| Caching | 2-minute serving TTL; a cache hit makes no Twitch call |
| Per-caller budget | `consume_metadata_budget` — 600 logins / 5 minutes, clamped `least(greatest(amount,0),100)` per call (migration 0018) |
| 429 handling | **Not retried.** Deliberate — the cache absorbs it |
| 5xx handling | Not retried |
| 401 handling | One bounded retry after app-token refresh |
| Undocumented endpoints | **None** |
| Scraping | **None** |

§IV.C prohibits attempting to "exceed or circumvent" rate limits. Not retrying a
429 is the correct behaviour and the opposite of circumvention. **COMPLIANT.**

---

## 17. Feature-by-feature compliance matrix

| # | Feature | Provision(s) | Verdict |
|---|---|---|---|
| 1 | Twitch OAuth | Sch.1 §A; §VI.E | Compliant |
| 2 | Twitch login identity | §VI.A/F | Compliant (see §18b) |
| 3 | Stored provider tokens | §IV.B/D | Compliant — exceeds requirement |
| 4 | Metadata API requests | Sch.1; §IV.C | Compliant |
| 5 | **Cache/retention of metadata** | **Sch.1 §C(c)** | **✗ BREACH — undeployed sweep** |
| 6 | Friend presence / current channel | Sch.1 §A; §VI.C | Compliant (see §18a) |
| 7 | Sharing presence with friends | §VI.C | Compliant (see §18a) |
| 8 | Social Gravity aggregation | Sch.1 §B | Compliant |
| 9 | JOIN navigation | ToS §222; Sch.1 §D.1 | Compliant |
| 10 | Watch Together | Sch.1 §D.2 | Not applicable |
| 11 | Watchside-native chat | Sch.1 §D.2 | Not applicable — Twitch chat untouched |
| 12 | Twitch display names | Sch.1 §C | Compliant (inside the cache; see #5) |
| 13 | Twitch avatars | Sch.1 §C | Compliant (URL only; see #5) |
| 14 | Title/category/live/viewers | Sch.1 §C | Compliant (see #5) |
| 15 | M3D follow-state | §VI.A/C/F; Sch.1 §A | Compliant |
| 16 | Acquisition analytics | §VI.B(a) | Compliant |
| 17 | Dwell / watch-together analytics | §VI.B(a) | Compliant |
| 18 | Mutual Friend Suggestions | Sch.1 §B | Compliant — friends-of-friends, no Twitch data |
| 19 | Blocking / privacy | Sch.1 §A | Compliant |
| 20 | Account & token deletion | §VI.F | Compliant |
| 21 | 7TV emotes | §VI.C | Compliant — no Twitch data leaves |
| 22 | Twitch DOM injection | ToS §108(c) | Compliant (see §18c) |
| 23 | Floating panel | ToS §184/192 | Compliant |
| 24 | Toolbar/nav injection | — | **N/A — none exists.** The launcher is Watchside's own floating button, not an injection into Twitch's nav |
| 25 | Theater / fullscreen | ToS §184(ix) | Compliant — hides in fullscreen |
| 26 | Modification of Twitch content | ToS §108(c) | Compliant — nothing modified |
| 27 | Obscuring Twitch ads | ToS §222; Sch.1 §D.1 | Compliant — §13 |
| 28 | Trademarks / naming | Trademark Guidelines | Compliant |
| 29 | "See where your friends are watching Twitch." | Trademark Guidelines | Compliant — nominative, disclaimed |
| 30 | twitch-metadata edge function | Sch.1 §C(c) | **✗ See #5** |
| 31 | Distribution outside Twitch's marketplace | Sch. 2 scope | Compliant — Sch. 2 does not apply |

---

## 18. Ambiguities for explicit owner decision

**None is a blocker. None has an obvious technical remediation. All three are
recorded so the owner accepts them knowingly rather than by omission.**

### (a) §VI.C's literal breadth vs friend-visible presence

> "Twitch Data, including any data you collect about Twitch's end users **or
> their browser or mobile app activity**, or insights derived from that data,
> may not be … made available to, or otherwise shared with, any affiliates or
> **third parties for any purpose** without Twitch's prior written permission."

Presence is browser-activity data, and Watchside shows it to the user's accepted
friends. Read literally, friends could be called "third parties".

**Why I do not read it as a violation:** the surrounding enumeration is
commercial (sold, licensed, monetized, distributed for commercial purposes, data
brokers, advertising networks); §VI.B(a) expressly permits use for "creating
compelling benefits that improve the end user experience"; the data subject is
the sharer, who chose to share and controls visibility with a three-way setting
enforced server-side. A social feature the user opts into is the paradigm case
of (a), not of (c).

**Owner action:** accept and record. No code change is proposed; removing
friend-visible presence would remove the product.

### (b) Twitch identity retained after revocation

`purge_twitch_derived` deletes the credential and the follow-state observations.
It leaves `connected_accounts` — Twitch user id, login, display name, avatar URL
— because that row is the user's Watchside account identity and their social
graph hangs off it.

Sch. 1 §C ¶2 says delete "all data of an end user collected through the Twitch
APIs upon … revocation". A strict reading reaches the identity row. §VI.E's last
sentence ("You may not continue to associate a user ID with an end user if they
un-authenticate from your App") points the same way — though that paragraph
opens "With respect to Extensions or Drops", so its scope is itself unclear.

**Countervailing:** revocation is not account deletion; the user has not asked
to leave. Deleting the identity would orphan their friends and their groups
silently. Account deletion — which *is* the user asking — does remove
everything. The privacy policy already describes both behaviours accurately and
distinctly (`PRIVACY.md:66` vs `:69`/`:82`).

**Owner action:** a genuine question for counsel if one is engaged. Options are
(i) accept as-is, (ii) anonymise the identity on revoke while keeping the
account, (iii) treat revoke as deletion. **Not release-blocking** — it is a
narrow reading question on a path that already deletes the sensitive material
(credential and follow-state).

### (c) ToS §108(c) "modifying … the Twitch Services"

Any browser extension that renders over twitch.tv arguably "modifies" it on a
literal reading. Watchside is at the extreme conservative end — one appended
element, pointer-events transparent, shadow-isolated, nothing of Twitch's
altered or hidden, self-hiding in fullscreen — and §108 is a licence limitation
addressed to users of the Twitch Services rather than a prohibition on
client-side overlays. Long-standing tolerance of the category (7TV, BTTV, FFZ,
which modify far more aggressively) is evidence of practice, not permission, and
is recorded as such rather than relied upon.

**Owner action:** accept as inherent to the product category.

---

## 19. Minimum remediation

**Exactly one item. It is release-blocking.**

### R1 — Deploy the `twitch-metadata` edge function

| | |
| --- | --- |
| **Which provision** | Schedule 1 §C: "Do not store copies of Twitch Content or Program Materials, unless you … (c) **cache such information for only a twenty-four hour time period** without further sharing it with third parties." |
| **What is wrong** | `twitch_metadata_cache` holds Twitch Content — display names, avatar URLs, live state, categories, stream titles, viewer counts. `sweep_twitch_metadata_cache` exists in migration **0017** and is therefore live in the database, but **nothing in the deployed function calls it**. The call was added in `a5cf0fd` and has never been deployed. Rows have accumulated for the life of the project. |
| **Release-blocking?** | **Yes.** It is a continuing breach of an express clause. It does not originate in v0.9, but shipping v0.9 would be shipping into a known breach. |
| **Code change required?** | **No.** Already written and committed (`supabase/functions/twitch-metadata/index.ts:231`). |
| **Store copy change?** | No. |
| **Privacy copy change?** | No — the policy does not promise a retention period this contradicts. |
| **Owner acknowledgement enough?** | No. This one needs the deploy. |
| **Counsel needed?** | No. The clause is unambiguous and the remediation is already built. |
| **Command** | `supabase functions deploy twitch-metadata` (owner-authenticated; explicitly **not** performed in this audit) |
| **Verification after deploy** | Owner-run, read-only: `select count(*), min(fetched_at) from public.twitch_metadata_cache;` — after one metadata request, `min(fetched_at)` should be within 24 hours. |

**I could not verify production row ages myself.** The only credential in this
environment is the anon publishable key, which cannot read that table. The
undeployed state is established from repository evidence — the call's commit
(`a5cf0fd`), the absence of any later deployment, and the owner's own statement
that no deployment is authorised.

---

## 20. Final decision

# B — G7 CONDITIONALLY SATISFIED

**Remediation checklist — finite and complete:**

- [ ] **R1** — deploy `twitch-metadata` (§19). Release-blocking.
- [ ] Record owner acceptance of §18(a) friend-visible presence.
- [ ] Record owner acceptance or counsel referral of §18(b) identity retention
      on revocation.
- [ ] Record owner acceptance of §18(c) overlay-as-modification.

The three acceptances are bookkeeping — a decision on the record, not work.

**D7's three original questions are now answered from the primary text:**

1. **24-hour caching** — confirmed verbatim, Sch. 1 §C(c). Watchside is in
   breach until R1 ships.
2. **Deletion on revocation** — confirmed verbatim, Sch. 1 §C ¶2 and §VI.F.
   Implemented, on both the revocation and the deletion path.
3. **Is a derived boolean "Twitch Data"?** — **Yes**, §VI.A ("including any
   insights derived from that data"). It therefore inherits the deletion and
   no-sharing duties, which Watchside honours, but **not** the 24-hour cap,
   which is written against *copies of Twitch Content*.

**G7 may be closed the moment R1 is deployed and the three acceptances are
recorded.** No other Twitch-policy work stands between Watchside and a v0.9
submission.

---

## 21. Sources

| # | Document | URL | Date | How obtained | Relied upon for |
| --- | --- | --- | --- | --- | --- |
| 1 | Twitch Developer Services Agreement | `https://legal.twitch.com/legal/developer-agreement/` | Last modified **12/04/2024**; accessed 2026-09-02 | Rendered in Chrome (64,555 chars). A plain fetch returns navigation only — reproduced. | §II.3, §II.4, §IV.A–E, §VI.A–H, §XI.I, Sch. 1 §A/§B/§C/§D, Sch. 2–4 scope clauses |
| 2 | Twitch Terms of Service | `https://www.twitch.tv/p/legal/terms-of-service/` → `legal.twitch.com` (302) | Last modified **08/12/2026**; accessed 2026-09-02 | Rendered in Chrome (56,114 chars) | §108, §172–196 prohibited conduct, §219–222 Advertisements |
| 3 | Twitch Trademark Guidelines | `https://legal.twitch.com/legal/trademark/` | Last modified **07/11/2018**; accessed 2026-09-02 | Rendered in Chrome (7,304 chars) | Brand Asset rules; domain/product naming; affiliation |
| 4 | Twitch Community Guidelines | `https://www.twitch.tv/p/legal/community-guidelines/` | — | Incorporated by DSA §II.4; not separately relied upon | No Watchside behaviour engages it |
| 5 | Twitch API reference (`channels/followed`) | `https://dev.twitch.tv/docs/api/reference` | accessed during the G5 pass | Fetched | M3D endpoint and scope |

No blog, forum, Reddit thread, Stack Overflow answer, cached copy or third-party
summary was relied upon for any conclusion in this report.

---

*Audit pass (2026-09-02), as originally written: audit only. No runtime code,
OAuth scope, browser permission, schema, migration, privacy text, website text
or store text was modified. Nothing was deployed, pushed, or submitted. The only
file added by that pass was this report.*

---
---

# ADDENDUM — remediation and closure

**Date:** 2026-09-03
**Pass:** narrow remediation. The audit above is unchanged; nothing in it has
been rewritten or removed.

## A1. Status transition

| | |
| --- | --- |
| **Verdict at audit (2026-09-02)** | **B — CONDITIONALLY SATISFIED** |
| **R1 deployment** | ✅ **DONE** — 2026-09-03T07:38:00Z |
| **R1 production data verification** | ⏳ **OUTSTANDING — requires one owner-run read-only query (§A5)** |
| **Owner acceptances 1–3** | ✅ **RECORDED — §A6** |
| **Status now** | **B — remediation deployed; closure pending exactly one owner query** |

**G7 has deliberately not been moved to A.** The deployment blocker is closed and
proven closed. What is not yet proven is the *production data state* — that no
cached row is older than 24 hours — and the credentials in this environment
cannot read that table (§A5). This report's whole method was to verify rather
than assume; declaring A on an unverified data state would abandon that standard
at the last step. §A5 contains the single query that closes it.

## A2. Pre-deploy verification

| Check | Result |
| --- | --- |
| Working tree clean (only this report untracked) | ✅ |
| `HEAD` == `origin/main` | ✅ `88c2197` |
| Function source identical to `HEAD` | ✅ |
| OAuth scopes unchanged | ✅ `user:read:follows` only |
| Manifest permissions / host permissions unchanged | ✅ |
| Migrations unchanged | ✅ |
| Schema version | ✅ **43** |
| Extension `src/` unchanged | ✅ |
| Project ref matches the extension's configured host | ✅ `ezikxbbcwcxhkboeekkk` — matched against `.env.local` **and** the built `dist/kickback-background.js` |

**The deployed-vs-committed diff, taken against production itself.** The
previously deployed source was downloaded from Supabase and byte-compared with
the committed source. The entire difference is **30 lines**:

1. two comment lines, `Kickback` → `Watchside` (the rebrand, commit `6a23f91`);
2. the 26-line reviewed sweep block — comment plus
   `try { await admin.rpc('sweep_twitch_metadata_cache', { p_older_than: '1 day' }) } catch {}`.

No new endpoint, no new secret, no auth change, no change to the metadata path
itself. The intended diff is exactly the already-reviewed committed behaviour.

> **One incident worth recording.** `supabase functions download` writes into the
> working tree — it overwrote `supabase/functions/twitch-metadata/index.ts` with
> the *old deployed* version, silently removing the sweep. Caught immediately by
> `git status`; the file was preserved as evidence and the committed version
> restored with `git checkout` before deploying. Had that gone unnoticed, the
> deploy would have re-shipped the very version being remediated.

## A3. Deployment

```
npx supabase functions deploy twitch-metadata --project-ref ezikxbbcwcxhkboeekkk
```

Deployed **without** `--no-verify-jwt`, per `docs/TWITCH_METADATA.md:109` — JWT
verification is what restricts the endpoint to signed-in Watchside users.

| | Before | After |
| --- | --- | --- |
| `twitch-metadata` | v4, updated **2026-08-24T23:12:37Z** | **v5**, updated **2026-09-03T07:38:00Z** |
| `verify_jwt` | `true` | **`true`** — preserved |
| `twitch-eventsub` | v4 | v4 — untouched |
| `delete-account` | v4 | v4 — untouched |
| `twitch-credential` | v20 | v20 — untouched |

The v4 timestamp (2026-08-24) predates the sweep's commit (`a5cf0fd`,
2026-09-02), which independently confirms the audit's finding that the deployed
function could not have contained it.

No `db push`, no migration, no secret change, no other function deployed.

## A4. Post-deploy verification performed

| Check | Result |
| --- | --- |
| Deployed version | ✅ **v5**, `ACTIVE` |
| **Deployed source == committed source** | ✅ **byte-identical** — re-downloaded from production and diffed |
| Deployed source contains the sweep | ✅ |
| Function operational | ✅ `POST /functions/v1/twitch-metadata` without a JWT → **HTTP 401**: up, and enforcing auth |
| Only one function changed | ✅ other three unchanged in version and timestamp |
| Working tree after deploy | ✅ clean |

**Scope of the cleanup, from the RPC's own body** (migration `0017:78`):

```sql
delete from public.twitch_metadata_cache
 where fetched_at < now() - p_older_than;
```

A single `DELETE` against a single table, bounded by one timestamp predicate. It
cannot reach any other Watchside data. The function is `security definer` with a
pinned `search_path`, and is `revoke all ... from public, anon, authenticated` —
only the service role the edge function uses can execute it.

## A5. OUTSTANDING — the one owner query

`public.twitch_metadata_cache` has RLS enabled and **all privileges revoked from
`public`, `anon` and `authenticated`** (migration `0017:56–58`). The only
credential in this environment is the anon publishable key, so the table is
unreadable here — correctly so. There is no service-role key or database
password available, and this CLI build has no `functions logs` subcommand.

**Run this read-only query** (Supabase dashboard → SQL editor). It changes
nothing:

```sql
-- Retention state of the Twitch Content cache.
select
  count(*)                                                          as rows_cached,
  min(fetched_at)                                                   as oldest,
  max(fetched_at)                                                   as newest,
  count(*) filter (where fetched_at < now() - interval '24 hours')  as older_than_24h
from public.twitch_metadata_cache;
```

**Pass criterion: `older_than_24h = 0`.**

**Sequencing matters.** The sweep is opportunistic — it runs on the *write* path,
when a cache miss causes a Twitch fetch and upsert. If the query is run before
any metadata write has occurred on v5, old rows may still be present and that is
expected, not a failure. So:

1. run the query and note `older_than_24h` (the "before" figure);
2. cause one metadata write — open Twitch with Watchside signed in, on a channel
   not already freshly cached; any beta user's ordinary browsing does this;
3. run it again. `older_than_24h` should be **0**.

To confirm nothing unrelated was touched, run this before and after — only the
first row should change:

```sql
select 'twitch_metadata_cache'             as tbl, count(*) from public.twitch_metadata_cache
union all
select 'creator_relationship_observations',      count(*) from public.creator_relationship_observations
union all
select 'twitch_credentials',                     count(*) from public.twitch_credentials;
```

**When `older_than_24h = 0` is observed, G7 becomes A — SATISFIED**, and this
addendum's §A1 table should be updated to record it with the date and the
figures.

## A6. Owner risk acceptances

**Recorded as owner risk acceptances. No attorney has reviewed them, and nothing
here should be read as legal advice or counsel approval.**

### Acceptance 1 — friend-visible presence (DSA §VI.C)

Watchside accepts the residual interpretive risk around §VI.C. Presence is
derived locally from the user's own browser (`window.location.pathname`) rather
than obtained from the Twitch API, and sharing is intentionally limited to the
user's own Watchside social relationships under a user-controlled visibility
setting enforced server-side. The owner accepts the audit's interpretation
(§18a) that this consented, friend-visible presence model is compatible with the
applicable agreement, while acknowledging the clause's broad wording.

### Acceptance 2 — Twitch identity after revocation (Schedule 1 §C)

Watchside accepts the residual interpretive risk around the deletion-on-
revocation language. On revocation, Watchside deletes the credential and the
Twitch-derived analytic state (`purge_twitch_derived` — `twitch_credentials` and
`creator_relationship_observations`), while retaining the connected-account
identity linkage necessary to represent the user's Watchside account
relationship. The owner accepts this interpretation while acknowledging that
"all data" could be read more broadly.

**The existing deletion behaviour is unchanged and was not weakened by this
pass.**

### Acceptance 3 — browser overlay (Twitch ToS §108(c))

Watchside accepts the residual interpretive risk around §108(c). Watchside is a
non-destructive browser overlay: isolated UI in a shadow root, no Twitch content
replacement, no ad blocking or skipping, no player modification, no Twitch chat
scraping or proxying, hides itself in fullscreen, and does not obscure Twitch
monetization. The owner accepts the residual platform and legal risk inherent in
this architecture.

## A7. Residual non-blocking risks

1. **Opportunistic sweeping has a quiet-period edge case.** The sweep fires on
   the write path, so under sustained zero metadata traffic a row could outlive
   24 hours until the next write. With live beta traffic this is continuous, and
   nothing stale is ever *served* (the serving TTL is 2 minutes) — but the
   storage duration is what Schedule 1 §C speaks to. A scheduled sweep
   (`pg_cron`) would close it definitively. **Not implemented here: it is new
   behaviour and outside this pass's scope.** Noted for the owner's judgement.
2. The three accepted interpretive risks in §A6, which do not expire.
3. Ordinary platform dependency (§11 of the audit) — not a compliance matter.
