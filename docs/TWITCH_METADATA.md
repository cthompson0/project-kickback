# Twitch Metadata Service

Public Twitch information about the channels Social Gravity is showing: who the
creator is, whether they are live, and what of.

```
extension (content script)   no network of its own
        ↓  port message
service worker               one cache for every tab; batching, dedupe, TTL
        ↓  supabase.functions.invoke, with the user's JWT
Edge Function                verified caller, validated logins, rate limited
        ↓                    Postgres cache (shared across isolates)
        ↓  app access token, in-isolate memory
Twitch Helix                 Get Users + Get Streams, batched ≤100
```

**Metadata is enrichment, never a dependency.** Every failure path ends at the
card that shipped before this existed.

---

## Why an app token, and not a user token

Verified against Twitch's current documentation before implementing:

| Fact | Consequence |
|---|---|
| `Get Streams` and `Get Users` both accept **an app access token or a user access token** | No per-user Twitch OAuth is needed for any of this |
| App access tokens **use no scopes** | Nothing to ask a user to consent to |
| Both endpoints accept **a maximum of 100** `user_login` / `id` values | One request covers every destination on a realistic map |
| App tokens come from **client credentials**, which needs the client secret | It must be server-side; a browser extension cannot hold one |
| `Get Users` returns `email` **only for a user access token** | With an app token there is no PII in the response at all |

So the earlier assumption — that metadata would have to wait for a Twitch
user-token broker — **was wrong**, and this checkpoint does not build one.

The two are genuinely different concerns and can coexist later:

| | This service | A future user-token broker |
|---|---|---|
| Credential | app token, from client credentials | user access + refresh token, per person |
| Scopes | none | `user:read:follows`, etc. |
| Data | public, identical for every viewer | viewer-specific |
| Storage | a shared cache of public data | per-user tokens, encrypted, revocable |
| Consent | none required | explicit, and revocable |

When the broker arrives it becomes a *second* function with its own secret
handling and its own table. Nothing here needs to change: this function would
keep serving public data with an app token, because using a user's token for
public data would tie a shared cache to one person's credential.

---

## Deployment

Three separate things. **None is done automatically.**

### 1. DATABASE MIGRATION REQUIRED

`supabase/migrations/0017_twitch_metadata.sql` — the cache table, its sweep
function, and one additional allowed property on
`gravity_cluster_impression`.

`supabase/migrations/0018_twitch_metadata_budget.sql` — **required**, and the
reason nothing worked on the first deploy. 0017's function called
`consume_rate_budget_n` directly; that is an internal helper which 0013 revokes
from `authenticated`, so every request failed with a permission error before
Twitch was ever contacted. 0018 adds `consume_metadata_budget`, a
SECURITY DEFINER wrapper that hard-codes the bucket, allowance and window and
IS granted to `authenticated`. It also states the service role's grants on the
cache table explicitly rather than relying on inherited defaults.

Same flow as every other migration; no CLI and no database password:

```bash
npm run db:bundle
```

Then **Supabase → SQL Editor → New query**, paste
`supabase/.generated/apply_all.sql`, run. Safe to run repeatedly.

### 2. SECRET CONFIGURATION REQUIRED

The Twitch **client secret** goes into Supabase's function secrets and nowhere
else. It must never be in `.env.local`, in the repository, or in any `VITE_`
variable — `VITE_` values are compiled into the browser bundle by definition.

```bash
npx supabase login
npx supabase link --project-ref YOUR-PROJECT-REF

npx supabase secrets set \
  TWITCH_CLIENT_ID=your-twitch-client-id \
  TWITCH_CLIENT_SECRET=your-twitch-client-secret
```

Both values come from **dev.twitch.tv → Your Console → Applications → your app**.
The client secret is shown once when generated; regenerate it there if lost.

`SUPABASE_URL`, `SUPABASE_ANON_KEY` and `SUPABASE_SERVICE_ROLE_KEY` are
injected into Edge Functions by Supabase automatically. Do not set them, and do
not put the service-role key anywhere else.

### 3. CODE DEPLOYMENT REQUIRED

```bash
npx supabase functions deploy twitch-metadata
```

**Deploy WITHOUT `--no-verify-jwt`.** JWT verification is what restricts the
endpoint to signed-in Kickback users, and it is on by default.

> **New prerequisite, stated plainly.** Until now this project deliberately
> avoided the Supabase CLI, because `supabase db push` needs the database
> password. Deploying a function does **not** — it uses your Supabase login and
> the project ref. The migration flow above is unchanged and still needs no CLI.
> If the function is never deployed, Kickback works exactly as it does today:
> every metadata call fails, and every card is the plain card.

---

## Caching, batching and TTLs

Two clocks, because the two halves of a record change at completely different
rates.

| What | TTL | Why |
|---|---|---|
| Live data (`LIVE_TTL_MS`) | **2 minutes** | Long enough that an hour with the panel open costs ~30 refreshes per destination instead of one per presence heartbeat; short enough that "LIVE" is not a lie for long after a stream ends. A viewer count two minutes out of date is invisible; a live state twenty minutes out of date is not. |
| Server cache row | **2 minutes** | The same window, so an isolate serving a cached row is serving one the extension would have accepted anyway. |
| Stale tolerance (`STALE_TOLERANCE_MS`) | **15 minutes** | How long a record may still be *shown* while a refresh is in flight. Past this its live half is downgraded to `unknown`. Refresh early, distrust late: the gap is what stops a slow request turning a live card plain. |
| Whole worker cache | **24 hours** | A worker waking after a day starts plain rather than showing yesterday's viewer counts while it refetches. |
| Cache row sweep | **1 day** | Rows nobody has asked about. Called opportunistically; no pg_cron. |

Identity (display name, avatar) is carried on the same record and therefore
refreshed on the same schedule. It is cheap — it rides along in the `Get Users`
call that has to happen anyway — and a stale display name is never *wrong*, so
the aggressive clock costs nothing.

**Batching and dedupe** happen in the worker:

- `want(channels)` is idempotent and safe to call on every render, heartbeat
  and broadcast. It fetches only what is missing or expired.
- Channels currently in flight are not requested again — the stampede guard for
  two tabs asking half a second apart.
- Requests are chunked at 100, the Helix limit.
- A failed fetch writes nothing and clears nothing: a channel we knew was live
  stays live until it ages into `unknown`.

---

## Live, offline, unknown

Three states, and the third is the whole point.

| State | Meaning | Card | Rank |
|---|---|---|---|
| `live` | Twitch says a stream is up | avatar, category, title, LIVE, viewers | unchanged |
| `offline` | Twitch **resolved the channel** and says no stream | dimmed, marked OFFLINE, friends and JOIN kept | **demoted below live and unknown** |
| `unknown` | nothing told us: no record, a failed fetch, a stale record, or a login Helix did not resolve | exactly today's plain card | unchanged |

**Why offline is demoted rather than filtered.** Presence is the authority on
where people are, and the friends really are on that channel. A destination
that vanished because a stream ended would be a worse lie than one marked
OFFLINE. But a JOIN that leads to an ended stream is not the thing that should
be at the top of the map, so it sinks.

**This is not ranking by Twitch data.** Viewer count, category and popularity
have no influence on order at all — a fifty-viewer stream with five friends
outranks a fifty-thousand-viewer stream with one, and always will. The only
thing metadata may do to the order is move an ended stream down.

**Why `unknown` ranks with `live`.** An outage, a cold cache and a channel
nobody has asked about yet all produce `unknown`. If that demoted anything, a
backend blip would silently reorder the whole map. With no metadata at all the
order is byte-for-byte what it was before metadata existed.

The partition is stable, so friend count still decides within each group and
the alphabetical tie-break still holds. Ranks are assigned **after** ordering,
so `rank: 1` is the top card on screen and the analytics funnel joins on the
row the user actually saw.

---

## Authoritative casing

`resolveChannelName` now has three sources, in order of **provenance**:

1. **Metadata** — Twitch's own `display_name` for the channel. The only source
   that can spell a channel this browser has never opened and nobody here is
   friends with.
2. **People Kickback knows** — a copy of that record, taken when someone signed
   in.
3. **Page titles** — a string parsed out of a `<title>`.

Each is a step further from the source, so each yields to the one above.

All three are still only **text**. The lowercase login stays canonical for
equality, clustering, JOIN, `destination_channel` and `opportunity_key`, and a
name that is a different word from the login is refused at every level — a
rename is not a spelling.

---

## Security

| Threat | Answer |
|---|---|
| Extension obtains the client secret | It is a function secret. No `VITE_` variable, no repository file, no bundle. Asserted by a test over every source file and every built bundle. |
| Extension obtains an app token | The token never leaves the isolate. It is not returned, not stored, not logged, and `KickbackState` has no field that could hold one. |
| SSRF via a channel name | Logins are validated against `^[a-z0-9_]{3,25}$` before they can be interpolated. There is no parameter that is a URL or a path. |
| Used as a general Twitch proxy | Three fixed URLs, all module constants. A test parses the source and asserts the list. |
| Unauthenticated use | Supabase verifies the JWT before the handler runs; the handler also refuses a request with no bearer header. |
| Actor forgery | The caller's id comes from their JWT. No user id is read from the body. |
| Abuse by a signed-in user | `consume_rate_budget_n('twitch_metadata', logins.length, 600, 5 min)` — charged per **login**, so batching cannot be used to pay once for a thousand. Over budget still returns cached data. |
| Unbounded work | ≤100 logins per request, ≤100 per Helix batch, 6-second timeout on every outbound call. |
| Malicious profile image URL | Host-checked against Twitch's CDN hosts, `https:` only, before it can reach an `src`. Failure renders no avatar. |
| Malicious stream title | Clamped to 140 characters and rendered as text by React. |
| Cache table read by a client | RLS enabled with **no policy**, plus `revoke all` from `anon` and `authenticated`. Only the service role touches it. |
| Retry storm | A 401 forces exactly one token refresh. 429 and 5xx are not retried at all — the cache covers them, and the honest answer to being rate limited is to ask for less. |

---

## Scale

The important property: **Twitch pressure scales with distinct destinations,
not with presence events.**

A presence heartbeat lands every 45 seconds and re-renders the panel. None of
that reaches Twitch. What reaches Twitch is one `Get Users` + `Get Streams`
pair per 100 distinct channels per 2-minute window, globally, because the cache
table is shared across isolates.

| Users | Distinct channels (est.) | Helix calls / min | Against the app-token budget |
|---|---|---|---|
| 10 | ~20 | ~1 | negligible |
| 1,000 | ~2,000 | ~20 | comfortable |
| 100,000 | ~50,000 | ~500 | **approaching the limit** |

Twitch's app-token bucket is 800 points per minute, and each of these calls is
one point. At 100k users the answer is to lengthen the live TTL (2 → 5 minutes
roughly halves the rate) and to request only channels currently on screen
rather than every friend's channel — both single-line changes here.

**Our own endpoint** is the other half, and it scales with *users*: roughly one
request per user per 2 minutes while the panel is open. At 100k concurrent that
is ~800 requests/second, which is when this stops being an Edge Function
answering from Postgres and starts wanting a real cache tier. That is a
deliberate later problem: nothing about the current shape prevents putting one
behind the same interface, and adding Redis now would be infrastructure bought
for a scale that does not exist.

---

## Diagnosing it

This feature failed silently for an entire checkpoint: the panel degrades
correctly by design, so "metadata is broken" and "no friends are watching
anything" produced the same screen. Three things now make the difference
visible.

### 1. The worker console

Development and private-beta builds print one line per request. Production
folds the whole path away.

```
[kickback:metadata] requested channels=1
[kickback:metadata] backend channels=1 backend=cache_miss
[kickback:metadata] stored channels=1
```

| Line | Meaning |
|---|---|
| `requested` | the worker wants channels and has called the backend |
| `fresh` | everything asked for is already cached; no call was made |
| `stored` | records came back and are now in state |
| `rejected` | the backend answered, but nothing survived the parser |
| `failed` | the call itself failed — offline, 401, 5xx, or not deployed |
| `backend=...` | codes the function reported about itself |

Backend codes: `budget_unavailable` (0018 not applied), `rate_limited`,
`twitch_credentials_missing` (secrets not set), `twitch_unavailable`,
`twitch_error`, `cache_unavailable`, `cache_hit`, `cache_miss`.

Only fixed codes and counts are ever printed — no tokens, no headers, no
channel names, no user ids.

### 2. Ask the backend directly

From the extension's service-worker console (**chrome://extensions → Kickback →
"service worker"**), in a development or beta build:

```js
await kickbackMetadata.check('lvndmark')   // what the deployed function returns
kickbackMetadata.snapshot()                // what the worker currently believes
```

It uses the session the worker already holds, so there is no token to paste and
none to leak; the result is the function's own response. Comparing the two
answers separates "the backend is broken" from "the panel is not showing what
the backend sent".

### 3. Supabase logs

**Supabase Dashboard → Edge Functions → `twitch-metadata` → Logs**, and
**Database → Logs → Postgres** for a permission error on an RPC.

## Failure behaviour

| Failure | What happens |
|---|---|
| Function not deployed | Every fetch rejects. Cards stay plain. Worker logs `failed`. |
| 0018 not applied | Budget check errors; the function serves cache only and reports `budget_unavailable`. It does **not** return 401 — that conflation is what hid the original bug. |
| Secrets not set | `twitch_credentials_missing`; cards stay plain. |
| Twitch 401 | One forced token refresh, then degrade to cache. |
| Twitch 429 / 5xx | No retry. Degrade to cache. |
| Twitch unreachable / timeout | Degrade to cache. |
| Malformed Twitch response | Parsed defensively; unreadable rows produce `unknown`. |
| One channel missing from a batch | That channel is `unknown`; the rest are unaffected. |
| Both Helix calls fail for a batch | Nothing is recorded — **not** a batch of `offline`. |
| Channel exists but is not streaming | `offline`. A fact, and shown as one. |
| Cache stale | Shown for up to 15 minutes, then downgraded to `unknown`. |
| Worker restart | Cache rehydrates from storage; records over a day old are dropped. |
| Image fails to load | `onError` removes it; nothing else moves. |
| Rate limit exceeded | Cached data only. The panel does not change. |

The worst case is the card that works today:

```
LIRIK · 3 friends
Jake · Matt · Chris
JOIN
```

---

## Testing

```
npx vitest run tests/extension/twitchMetadata.test.ts      # parsing, token, cache, batching
npx vitest run tests/extension/gravityMetadata.test.tsx    # the enriched card and ranking
npx vitest run tests/extension/metadataSecurity.test.ts    # secret, proxy shape, table grants
npm run test:lab                                           # Test Lab metadata states
npm run verify:lab                                         # all of it in a real browser
```

The Edge Function's Helix logic lives in `twitch.ts` with **no Deno APIs**, so
the ordinary vitest suite imports and tests it directly. `index.ts` is the thin
shell that supplies secrets, network and clock — deliberately as small as
possible, because Deno-only code cannot be covered by the checkpoint gate.

The `ChannelMetadata` shape is defined once, in `src/core/twitchMetadata.ts`,
and imported by the function as a **type-only** import — erased at build time,
so the deployed function carries no dependency on `src/`.
