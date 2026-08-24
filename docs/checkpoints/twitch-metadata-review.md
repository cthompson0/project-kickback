# Twitch Metadata Service — Checkpoint Review

Commit `4fd878a` — `feat: add Twitch metadata service`. Pushed to `main`.

Reference documentation: **`docs/TWITCH_METADATA.md`** (architecture, TTLs,
deployment, security, scale, failure matrix).

---

## 1. Architecture audit — what I found before writing anything

| Question | Answer |
|---|---|
| Edge Functions in use? | **No.** `supabase/functions/` did not exist and there is no `config.toml`. |
| How is SQL applied? | `npm run db:bundle` → paste into the SQL editor. The README says the CLI is *deliberately* not required, because `supabase db push` needs the database password. |
| Existing caching utilities? | Yes — `createEmoteCatalog` is a worker-side TTL cache over an injected HTTP client. Reused as the pattern. |
| How coupled is the worker to `chrome.*`? | Barely. All 24 `chrome.` references are in `index.ts`; every service is `createX(deps)`. |
| Secrets handling | `.env.example` carries only `VITE_` values and explicitly warns against putting the Twitch secret or service-role key anywhere in the repo. |
| Host permissions | `https://*.supabase.co/*` already covers `/functions/v1/*`. **No manifest change needed.** |
| Channel-name resolver | `resolveChannelName`, two sources, already documented as having a slot for authoritative metadata. |

**No blocker found.** The preferred architecture is achievable as specified.

**One new prerequisite, flagged rather than absorbed:** deploying an Edge
Function needs the Supabase CLI (`supabase login` + `link` + `functions
deploy`). That does *not* need the database password, so the constraint the
README actually stated is intact, and the migration flow is unchanged. If the
function is never deployed, Kickback behaves exactly as it does today.

### The shape

```
content script (React)     no network, no fetch effects, no per-card requests
        ↓  port message
service worker             one cache for every tab: TTL, batching, dedupe
        ↓  supabase.functions.invoke, with the user's JWT
Edge Function              JWT-verified caller, validated logins, rate limited
        ↓                  Postgres cache, shared across isolates
        ↓  app access token, in-isolate memory
Twitch Helix               Get Users + Get Streams, batched ≤100
```

---

## 2. Why app-token, not user-token

Verified against current Twitch documentation before implementing, because the
brief asked me not to assume the earlier conclusion still held:

- **Get Streams** — "Requires an app access token or user access token"; "You
  may specify a maximum of 100 IDs".
- **Get Users** — same authorization; same 100 limit. `email` is returned
  **only** for a user access token, so an app token yields no PII at all.
- **Client credentials** — `POST https://id.twitch.tv/oauth2/token` with
  `client_id`, `client_secret`, `grant_type=client_credentials`. App tokens
  **use no scopes** and have **no refresh token**; when one expires you request
  another.

So the earlier conclusion — that metadata had to wait for a user-token broker —
**was wrong**. No Twitch OAuth scopes, no provider-token storage, no forced
reauthorization, and nothing for a user to consent to.

**Coexistence with a future broker.** They are different concerns and should
stay separate services: this one holds an app credential for public data shared
by every viewer and cached globally; a broker would hold per-user refresh
tokens, scopes, revocation and consent. Using a user's token for public data
would tie a shared cache to one person's credential. When the broker arrives it
is a second function with its own secret and its own table, and nothing here
changes.

---

## 3. Gravity UX

```
[avatar] 🔥 LIRIK              3   [JOIN]
         Escape from Tarkov     ● LIVE  18K
         late night wipe grind - !discord
         Jake · Matt · Chris
```

- **Avatar** 22px, `flex: none`, lazy, decorative (`aria-hidden`), removed
  entirely by `onError`.
- **Stream line** — category takes the flexible half and ellipsises; the badge
  and viewer count are `flex: none` at the end so a long category can never
  push them out at 260px.
- **Title** — one line, ellipsised, full text on hover.
- **Viewer count** — `--kb-faint`, 10.5px, tabular numerals. Deliberately the
  smallest, dimmest thing on the card.
- **Offline** — card dimmed to 0.72 and marked `OFFLINE` in `--kb-faint`.
  Stated, not shouted: the viewer's friends are still there and nothing is
  broken.

Every row is **optional and absent by default**, so a card with no metadata is
byte-identical to the card that shipped before this checkpoint — asserted by a
test that compares the two rendered strings directly.

Friend count keeps `kb-gravity-count` at its existing size and weight; the
flame, the JOIN, HERE and the people row are untouched.

`formatViewers` is hand-rolled rather than `Intl` compact notation: two people
looking at the same stream must not see different numbers.

---

## 4. Live / offline semantics

Three states. The third is the whole design.

| State | Meaning | Card | Rank |
|---|---|---|---|
| `live` | Twitch says a stream is up | full enrichment | unchanged |
| `offline` | Twitch **resolved the channel** and reports no stream | dimmed, `OFFLINE`, friends + count + JOIN kept | **demoted below live and unknown** |
| `unknown` | nothing told us — no record, failed fetch, stale record, or a login Helix did not resolve | today's plain card | unchanged |

**Demoted, not filtered.** Presence is the authority on where people are, and
the friends really are on that channel. A destination that vanished would be a
worse lie than one marked OFFLINE. But a JOIN that leads to an ended stream
should not head the map, so it sinks.

**This is not ranking by Twitch data.** Viewer count, category and popularity
influence order not at all — a test renders five friends on a 50-viewer stream
against one friend on a 50,000-viewer stream and asserts the small one wins.
The only thing metadata may do to order is move an ended stream down.

**`unknown` ranks with `live`, deliberately.** An outage, a cold cache and a
channel nobody has asked about yet all produce `unknown`; if that demoted
anything, a backend blip would silently reorder the map under someone's cursor.
With no metadata at all the order is byte-for-byte what it was before.

**Staleness is a separate, earlier gate.** `liveStateOf` downgrades any record
older than 15 minutes to `unknown` — so a worker that slept for an hour shows
plain cards, not confident `LIVE` badges for streams that ended while it was
asleep, and not `OFFLINE` either, because we no longer know.

Implementation detail worth recording: the partition is **stable**, so friend
count still decides within each group and the alphabetical tie-break still
holds; and ranks are assigned **after** ordering, so `rank: 1` is the top card
on screen and the analytics funnel joins on the row the user actually saw.

---

## 5. Cache and batching

| What | TTL | Reasoning |
|---|---|---|
| Live data | **2 min** | An hour with the panel open costs ~30 refreshes per destination instead of one per 45-second heartbeat. A viewer count 2 minutes stale is invisible; a live state 20 minutes stale is not. |
| Server cache row | **2 min** | Same window, so a cached row is one the extension would have accepted anyway. |
| Stale tolerance | **15 min** | How long a record may still be *shown* while a refresh is in flight. Refresh early, distrust late — the gap stops a slow request turning a live card plain. |
| Worker cache lifetime | **24 h** | A worker waking after a day starts plain rather than showing yesterday's counts. |
| Cache row sweep | **1 day** | Opportunistic; no pg_cron, no extension. |

Identity (name, avatar) rides along in the `Get Users` call that has to happen
anyway, so it needs no second clock — and a stale display name is never *wrong*.

**Batching / dedupe / stampede**, all in the worker:

- `want(channels)` is idempotent — safe on every render, heartbeat and
  broadcast — and fetches only what is missing or expired.
- Channels already in flight are excluded, so two tabs asking half a second
  apart make one request.
- Chunked at 100, the Helix limit, on both sides.
- Logins are canonicalised and de-duplicated before anything is requested.
- **A failed fetch writes nothing and clears nothing.** A channel we knew was
  live stays live until it ages into `unknown`. Failure degrades toward "we do
  not know", never toward a wrong answer.

**Scale.** Twitch pressure scales with *distinct destinations*; our own
endpoint scales with *users*.

| Users | Distinct channels | Helix calls/min | Note |
|---|---|---|---|
| 10 | ~20 | ~1 | negligible |
| 1,000 | ~2,000 | ~20 | comfortable |
| 100,000 | ~50,000 | ~500 | approaching the 800/min app-token budget |

At 100k the fixes are one-liners (live TTL 2 → 5 min; request only on-screen
channels). Our endpoint at 100k concurrent is ~800 req/s, which is when a real
cache tier is warranted — deliberately not bought now.

---

## 6. Test Lab

Extended only enough to reach the UI states. It **calls nothing**.

Metadata is supplied at exactly the boundary production reads it from —
`KickbackState.channelMetadata`. The lab has **no token, no Helix parsing, no
cache and no batching**, because those belong to the service and a copy would
prove nothing about the original. A test asserts no lab source mentions
`api.twitch.tv`, `id.twitch.tv`, `createMetadataService` or `twitch-metadata`.

Per-destination controls: live / offline / unavailable, avatar
(present / missing / broken), category. Eight new presets: Live creator,
Offline creator, Metadata unavailable, Long title + category, Missing avatar,
Mixed live/offline, Authoritative casing, HERE with the stream ended.

Two decisions worth recording:

- **`unavailable` is modelled as absence, not as a state.** A backend outage, a
  cold cache and a channel nobody asked about all reach the panel as "no
  record". A lab that distinguished them would be inventing a state production
  cannot produce — so "loading" and "error" are one preset, and a test asserts
  its rendered output is byte-identical to no metadata at all.
- **The stand-in avatar is an inline `data:` URI.** A real CDN URL would simply
  fail to load in a lab with no network, leaving the avatar slot untested. A
  `data:` URI is not a request, so the network seal is untouched. The real host
  check is tested separately against actual URLs.

---

## 7. Security

| Threat | Answer |
|---|---|
| Extension obtains the client secret | Function secret only. Tests scan every source file *and* every built bundle for `client_secret`, `client_credentials`, `id.twitch.tv`, `api.twitch.tv`. |
| Extension obtains an app token | Never returned, stored or logged. `KickbackState` has no field that could hold one (asserted). |
| SSRF via a channel name | `^[a-z0-9_]{3,25}$` before any interpolation, on both sides. Tested against `https://evil.example`, `../../admin`, `http://169.254.169.254/latest`. |
| General Twitch proxy | Three fixed URLs, all module constants. A test parses the function source and asserts the exact list. |
| Unauthenticated use | JWT verified by Supabase before the handler; the handler also refuses a missing bearer header. Deploy **without** `--no-verify-jwt`. |
| Actor forgery | Caller id comes from the JWT. No user id is read from the body (asserted). |
| Abuse by a signed-in user | `consume_rate_budget_n('twitch_metadata', logins.length, 600, 5 min)` — charged **per login**, so batching cannot pay once for a thousand. Over budget still returns cached data. |
| Unbounded work | ≤100 logins per request, ≤100 per Helix batch, 6s timeout on every outbound call. |
| Malicious image URL | `https:` + Twitch CDN host only, before it can reach a `src`. Tested against `javascript:`, `data:`, and `static-cdn.jtvnw.net.evil.example`. |
| Malicious stream title | Clamped to 140 chars; React escapes it (tested with `<img src=x onerror=...>`). |
| Cache table read by a client | RLS enabled with **no policy**, plus `revoke all` from `anon`/`authenticated`. Tested that no `create policy` exists. |
| Retry storm | 401 forces exactly one refresh; 429/5xx are not retried. No `while (true)` (asserted). |
| Token at rest | Held in isolate memory, not Postgres — a bearer token in the database is a credential at rest bought to save one request per cold start. Asserted the migration mentions no token. |

---

## 8. DEPLOYMENT REQUIRED

**Not applied. Nothing hosted was touched.**

```bash
npx supabase login
npx supabase link --project-ref YOUR-PROJECT-REF

npx supabase secrets set \
  TWITCH_CLIENT_ID=your-twitch-client-id \
  TWITCH_CLIENT_SECRET=your-twitch-client-secret

npx supabase functions deploy twitch-metadata
```

- Both values come from **dev.twitch.tv → Your Console → Applications**.
- The client secret must go **only** here. Never `.env.local`, never a `VITE_`
  variable (those are compiled into the browser bundle by definition).
- `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY` are injected
  by Supabase automatically. Do not set them.
- **Deploy without `--no-verify-jwt`.**

---

## 9. MIGRATION REQUIRED

`supabase/migrations/0017_twitch_metadata.sql`, applied the existing way:

```bash
npm run db:bundle
```
→ Supabase → SQL Editor → New query → paste `supabase/.generated/apply_all.sql`
→ Run. Idempotent, safe to run repeatedly. **No CLI, no database password.**

It contains:
1. `twitch_metadata_cache` — RLS on, no policy, all client privileges revoked.
2. `sweep_twitch_metadata_cache(interval)` — revoked from clients.
3. **The analytics change:** one additional allowed property,
   `destination_live`, on `gravity_cluster_impression`, via `on conflict do
   update`. Purely additive — events already recorded keep their meaning, and
   an older client that does not send it is unaffected.

`destination_live` is **omitted** when nothing told us, rather than sent as
`"unknown"`: an absent property reads as absent in every query, whereas a
literal would have to be excluded by hand in each one and eventually would not
be. It is the only Twitch field recorded anywhere — no titles, viewer counts,
categories or image URLs.

While fixing the contract test I replaced its hardcoded migration list with a
directory read in filename order, the same thing the bundle does. The old list
had to be edited whenever a migration revised the contract, and the failure
mode of forgetting was the test passing against a contract the database does
not have.

---

## 10. Verification

Checkpoint policy. Nothing near the 5-minute limit.

| Command | Result | Time |
|---|---|---|
| Metadata + Gravity + analytics + presence + Test Lab + bundle (22 files, 589 tests) | pass | **5 s** |
| `npx tsc -b --force` | pass | 4 s |
| `npm run lint` | pass | 5 s |
| `npm run build` | pass | 5 s |
| `npm run verify:lab` (real Chrome, full drive-through) | pass | 9 s |

No mutation testing. No unrelated emote/combo/group suites.

**155 new tests.** Coverage by the brief's list:

- **Auth/token** — reuse until near expiry, margin, refresh, malformed
  response, no-lifetime fallback, secret never bundled, one bounded 401 retry.
- **Batching** — 1, many, >100 chunking, duplicates, casing, invalid dropped,
  empty request makes no call.
- **Cache** — hit, miss, expiry, stale fallback, no stampede under concurrent
  wants, hydrate warm/drop cold, reset on sign-out.
- **Twitch data** — display name, avatar, live, offline, unresolved-as-unknown,
  category, title, viewer count, missing fields, `type: ""`, rename refused.
- **UI** — live, offline, unavailable, stale, missing avatar, long title, long
  category, HERE with stream ended, narrow panel, 1/2/3/5/10 friends, casing.
- **Privacy/security** — no secret, no token in state or bundle, no generic
  proxy, invalid channel rejected, lab performs no network call.

`verify:lab` additionally measures `scrollWidth > clientWidth` on the card at
260px with the longest title and category — an overflow question that only a
layout engine can answer.

**What the gate cannot cover:** the Edge Function's `index.ts` is Deno and is
not typechecked or linted here. That is exactly why its Helix logic lives in
`twitch.ts` with no Deno APIs — the ordinary vitest suite imports and tests it
directly, and `index.ts` is kept as thin as possible. Its correctness is
confirmed by deploying it.

Two self-inflicted test bugs found and fixed during the run: an assertion that
scanned source text for `Intl.NumberFormat` and `scope` was tripped by my own
explanatory comments (replaced with a field-declaration parse, and one removed
as redundant); and a fixture that derived a display name by uppercasing, which
made `xqc` into `XQC`.

---

## 11. Git

32 files, +3,767 / −53. One clean commit, pushed, no force push.

```
4fd878a feat: add Twitch metadata service
b9980a1..4fd878a  main -> main
```

The first push attempt failed with a connection reset; the retry succeeded.

Full staged diff reviewed. Secret scan matched only: environment variable
*names* read via `Deno.env.get`, the documentation placeholder
`your-twitch-client-secret`, and test assertions about those names — no values.
No `.env.local`, no tokens, no service-role credentials, no browser profiles,
no analytics dumps, no build artifacts. `supabase/.temp/` (CLI scratch created
by the version check during the audit) was inspected, found to contain only
`v2.115.0`, deleted and gitignored.

---

## 12. Recommendation for Stream Rooms

Not started. Three things this checkpoint leaves in place for it:

1. **The metadata boundary is already the right one.** A Stream Room is
   anchored to a destination, and a destination is now `{ login, displayName,
   live, game, title, viewers }` keyed by canonical login. A room can carry the
   login and render the same enrichment with no new fetching — `channelMetadata`
   is already in `KickbackState` and already shared by every tab.

2. **Use `live` for room lifecycle, and use all three states.** A room whose
   stream has ended is the natural moment to prompt "everyone move to X?" —
   and the `unknown` state is exactly what stops a metadata blip from
   dissolving a room. Whatever the rule ends up being, it must treat
   "we do not know" as a reason to do nothing, the way ranking does here.

3. **Do not let a room become a metadata subscriber.** The temptation will be
   per-room polling for viewer counts. Requests must keep scaling with distinct
   destinations; a room should read from the same worker cache as everything
   else, and if rooms need a faster live-state clock than 2 minutes, change the
   TTL rather than adding a second fetch path.

One thing to decide before starting: whether a room's identity is the channel
(so a room survives a stream ending and restarting) or the stream id (so it
does not). Twitch's `stream.id` is available and deliberately not modelled yet —
that is a Stream Rooms decision, not a metadata one.

Also still deferred, unchanged: the **Twitch user-token capability**
(`user:read:follows`, follow conversion, user-entitled data, provider-token
storage). Section 2 above records how it would coexist.
