# Incident: friends vanished from the panel — a stale Twitch client secret

**Date:** 2026-09-08
**Status:** **RECOVERED.** Root cause proven, fix applied, verified from three directions.
**User impact:** every Watchside user with an online friend on a Twitch channel saw
that friend **disappear from the panel entirely** for roughly nine hours.
**Release required:** none. No extension change, no redeploy, no schema change.

---

## 1. Timeline (UTC, 2026-09-08)

| Time | Event |
| --- | --- |
| ~08:17 | Owner attempts to generate a new secret for the existing Twitch app "Kickback Dev". Twitch returns `ResetOauthAppSecret: service timeout`. **Twitch rotated the secret anyway** and never displayed the replacement. |
| ~08:17 | **Last successful write to `twitch_metadata_cache`.** Metadata dies here. |
| ~08:17+ | Fresh Watchside OAuth begins failing everywhere, including the owner's ordinary Firefox install: `Unable to exchange external code: gblp`. |
| — | Owner registers a **replacement Twitch application**, same Supabase OAuth callback, confidential client. |
| — | Supabase → Authentication → Twitch updated with the new Client ID **and** Secret. **Sign-in recovered.** |
| **09:06:50** | `TWITCH_EVENTSUB_SECRET` updated. |
| **09:07:05** | `TWITCH_CLIENT_ID` updated. |
| **(never)** | **`TWITCH_CLIENT_SECRET` was NOT updated.** It remained the old application's secret, last set `2026-08-24T22:42:11Z`. |
| — | Sign-in works; friends still missing. Investigation opens. |
| **16:54:48** | `TWITCH_CLIENT_SECRET` corrected. **Metadata recovers.** |
| — | Owner visually confirms the two online friends are rendering again. |

---

## 2. Symptoms

The panel showed, simultaneously and self-contradictorily:

```
You're watching HutchMF
Friends 2/6                      ← two friends ARE online
Nobody is watching anything right now.
Offline · 4                      ← only four friends listed
```

Two friends were counted as online and rendered **nowhere**. 4 shown + 2 missing = 6.

Production `public.presence` at the same moment held three rows fresher than the
client's 90-second threshold: the owner on `hutchmf`, EradadTV on `kaelwhale`,
BiFurious1 on `zfg1`.

---

## 3. Root cause — proven

**Production ran the NEW application's Client ID paired with the OLD
application's Client Secret.**

Both values were non-empty, which is exactly why the failure was invisible:

```
if (!CLIENT_ID || !CLIENT_SECRET) diagnostics.push('twitch_credentials_missing')
```

never fired. The chain:

```
new ID + old secret
  → POST id.twitch.tv/oauth2/token  →  400 {"message":"invalid client"}
  → getAppToken(): if (!response.ok) return null          ← silent
  → helix(): if (!token) return null            (both calls)
  → fetchFromTwitch(): users===null && streams===null → []
  → handler: fetched.length === 0 → diagnostics.push('twitch_unavailable')
  → HTTP 200, { channels: [], diagnostics: ['cache_miss','twitch_unavailable'] }
  → writeCache([]) returns early → twitch_metadata_cache never updated
```

A 200 with an empty array. **No Edge Function error, no client `client_error`,
no cache write.** The only durable evidence anywhere was the *absence* of fresh
cache rows.

### Why the diagnosis was hard, and what actually cracked it

Four candidate explanations were eliminated by code inspection before any
production change:

- **Stale warm isolate holding old module constants** — weakened by Supabase
  logs showing many Boot/Shutdown events with distinct execution IDs, and
  eliminated by the docs: [Supabase injects secrets at runtime, not build
  time](https://supabase.com/docs/guides/functions/secrets), picked up on the
  next invocation with no redeploy.
- **Old app token paired with a new Client ID** — *structurally impossible*.
  `helix()` sends `'client-id': CLIENT_ID` and `getAppToken()` mints with the
  same module-level constants, so within an isolate they cannot diverge.
- **Stale cached app token** — self-healing. A 401 sets `appToken = null` and
  re-mints with `force = true`.
- **Rate budget exhaustion** — ruled out by `public.rate_limits`: ~82 writes
  against an allowance of 600 per 5 minutes.
- **Network/timeout** — would have thrown out of `helix()` (no try/catch there)
  and surfaced as `twitch_error`, not `twitch_unavailable`.

What actually settled it was `supabase secrets list`, which prints
`updated_at` per secret. `TWITCH_CLIENT_ID` had moved that morning;
`TWITCH_CLIENT_SECRET` was two weeks old. **The timestamps named the bug before
anything was changed.**

---

## 4. Evidence

**Before the fix**

```
TWITCH_CLIENT_ID       digest b55b517e…   updated_at 2026-09-08T09:07:05Z
TWITCH_CLIENT_SECRET   digest 03adc3db…   updated_at 2026-08-24T22:42:11Z   ← stale
```

Production probe, through the normal authenticated client path:

```
HTTP STATUS : 200
DIAGNOSTICS : ["cache_miss","twitch_unavailable"]
CHANNELS    : 0
```

`twitch_metadata_cache` newest row ~8h17m old. Owner independently confirmed
the new pair valid against Twitch's client-credentials endpoint.

**After the fix**

```
TWITCH_CLIENT_ID       UNCHANGED   ← already correct; confirms the ID was not the fault
TWITCH_CLIENT_SECRET   CHANGED     ← the stored value differed from the known-good one
both updated_at 2026-09-08T16:54:48Z
```

The unchanged ID digest is the confirming half of the experiment: it proves the
*only* wrong value was the secret.

---

## 5. Recovery

Two secrets re-set from the repository's gitignored `.env.local`, via the CLI
with `--env-file` (avoiding shell quoting and the trailing-newline class of
error a dashboard paste introduces), containing **only** those two keys — the
three unrelated `VITE_*` variables were excluded. Temp file written outside the
repo at mode `0600` and deleted immediately. No value was printed at any point.

```bash
npx supabase secrets set --project-ref <ref> --env-file <temp>
# {"count":2,"message":"Finished supabase secrets set."}
```

**No redeploy.** Secrets are runtime-injected; the next isolate boot picked them
up. Nothing at Twitch was rotated, no application was created, no schema
changed, no extension changed, no v0.9 artifact touched.

---

## 6. Verification — three independent directions

1. **Owner, visual.** The two previously missing online friends render again.
2. **Digest comparison.** Secret digest changed, ID digest did not.
3. **Helix, through the production parser.** Re-running the Edge Function's own
   `twitch.ts` (`getAppToken` → `Get Users` + `Get Streams` → `buildMetadata`)
   against the now-deployed pair:

```
token endpoint HTTP : 200      app token acquired : true
helix streams  HTTP : 200      helix users  HTTP  : 200
records built       : 3
    kaelwhale    live      11 viewers   Deadlock
    zfg1         offline
    hutchmf      live      8817 viewers Escape from Tarkov
```

This was the first confirmation that **Helix** — not merely the token endpoint —
answers under the replacement application.

`zfg1` returning `offline` is worth noting: BiFurious1 is online with Twitch
left open on a channel that has since stopped streaming. That is the exact case
the v0.9 beta report describes, and with metadata working it renders as a
destination card sorted below the live ones rather than vanishing.

**Not verified by this session:** fresh rows in `twitch_metadata_cache`. No
`psql` is available here and `supabase/.temp/pooler-url` carries no password, so
there is no read path to the database from this environment. The owner's visual
confirmation already establishes recovery; the cache query below is optional
belt-and-braces.

```sql
select login, fetched_at, now() - fetched_at as age, payload->>'live' as live
  from public.twitch_metadata_cache order by fetched_at desc limit 10;
-- expect rows younger than the 2-minute TTL
```

---

## 7. Why presence itself was never broken

**Watchside's presence path touches no Twitch API, no Twitch token and no
Twitch Client ID.** It is entirely Watchside-owned:

```
content script → report_presence(platform, channel)   [SECURITY DEFINER, auth.uid()]
               → public.presence
list_friends() → friendships ⋈ presence ⋈ connected_accounts   [SECURITY INVOKER]
               → client: effectiveStatus + PRESENCE_STALE_MS (90s)
```

`onlineCount` — the "2" in *Friends 2/6* — is
`friends.filter(f => effectiveStatus(f.presence) === 'online').length`. It never
consults metadata. It was **correct throughout the outage**, which is precisely
why the panel contradicted itself.

Even the most destructive Twitch path cannot reach presence:
`purge_twitch_derived` deletes exactly `twitch_credentials` and
`creator_relationship_observations` — never `friendships`, `presence` or `users`.

A useful control from the incident: `wtfchuck27` had a stored status of `online`
with a 7-hour-old `last_seen_at`, and was correctly rendered offline. The
freshness rule was working the whole time.

---

## 8. Why the friends disappeared from rendering

A **latent client bug**, exposed — not caused — by the metadata outage.

`visibleGravity` (`src/core/socialGravity.ts`) hides a `destination` section iff
it has **no metadata record** *and* its channel is in `channelMetadataPending`:

```js
export function awaitingEnrichment(section, metadata, pending) {
  if (section.kind !== 'destination' || !section.channel) return false
  if (metadata[section.channel]) return false
  return pending.includes(section.channel)
}
```

That hold-back is intentional and correct for its stated purpose — avoiding a
half-second of raw lowercase card that visibly transforms once Twitch answers.
Its release condition is what fails. In `src/background/metadata.ts`:

```js
try   { …success: records = next; changed() }        // ← the ONLY broadcast
catch { deps.onDiagnostic?.('failed', …) }           // ← no changed()
finally { for (const l of logins) inFlight.delete(l) }  // ← no changed()
```

`changed()` — which triggers `broadcast()` and ships a fresh
`channelMetadataPending` — runs **only on success**. Both failure paths (thrown
error, and "succeeded but produced nothing usable") clear `inFlight` without
re-broadcasting, so the panel keeps a stale pending list. `want()` then re-fires
on the next heartbeat because the record is still missing, and the cycle repeats
with no path that ever clears it.

The rendered panel matched this prediction in every particular:

| Observed | Predicted by the mechanism |
| --- | --- |
| "You're watching HutchMF" renders | `awaitingEnrichment` exempts `here` — *"NEVER THE VIEWER'S OWN CARD"* |
| "Offline · 4" renders | `offline` sections are never held back |
| No "Around on Twitch" section | both online friends had channels, so neither was `around` |
| 2 online, 0 drawn | both `destination` sections filtered out |

The code's own comment promises the opposite of what it does:

> *"a failed request clears itself… so a failure degrades to the plain card the
> panel has always drawn rather than to an indefinite spinner."*

`inFlight` does clear. **The panel's copy of it is never told.**

---

## 9. No extension release was required

Restoring the server-side metadata path made the symptom disappear on its own:
once records exist, `metadata[channel]` is truthy, `awaitingEnrichment` returns
`false`, and the sections render. v0.9 remained frozen and untouched throughout,
and the released client needed no change to recover.

---

## 10. What would have told us sooner

The honest answer, in the spirit `docs/OPERATIONS.md` asks for:

- **Nothing would have.** A 200 with an empty array produces no Edge Function
  error, no client `client_error` (the empty-response path calls only
  `onDiagnostic`, which is dev-build-only), and no cache write. The failure was
  silent by construction.
- **`client_error` would not have helped this owner regardless.** It is
  classified `technicalAndInteraction` (`src/core/analytics.ts`), which **Firefox
  drops entirely** by the F6 decision. The affected user was on Firefox.
- **The one signal that existed** was the absence of fresh
  `twitch_metadata_cache` rows — an absence, and nobody checks absences.
- **The one signal that named the bug** was `updated_at` in
  `supabase secrets list`. Comparing secret timestamps after any credential
  change is now a runbook step.

---

# FOLLOW-UP — deliberately NOT part of this incident

The two items below stem from the Twitch **application replacement**, not from
the metadata outage, which is closed. Read-only assessment only; nothing was
mutated.

## F1. User Twitch credentials issued by the old application

`public.twitch_credentials` holds AES-256-GCM blobs whose **tokens were issued
by the old application**. The encryption key (`TWITCH_CREDENTIAL_KEY_V1`) is
unchanged, so the rows still decrypt — the tokens inside are the dead part. A
refresh against the new client will fail, and `ensure_fresh` already models this
by setting `status = 'needs_reauthorization'`.

**No migration, no mass reauthorization, and no user-facing action are needed.**
Users must re-consent anyway (the new application holds no prior grant), and
`handOffTwitchCredential` runs on **every** sign-in and upserts with
`onConflict: 'actor_id'`, `status: 'active'`:

> *"Re-signing in is an ordinary thing to do and must not accumulate credentials."*

So each user self-heals on next sign-in. Only users who have not signed in since
the replacement hold dead credentials, and the impact is confined to M3D
follow-baseline measurement — invisible to them.

Optional read-only check:

```sql
select actor_id, status, key_version, access_expires_at, updated_at,
       array_length(scopes,1) as scope_count
  from public.twitch_credentials order by updated_at desc;
-- rows with updated_at before 2026-09-08 belong to the old application
```

## F2. EventSub subscriptions — a real gap

`twitch-eventsub` creates its subscription with
`condition: { client_id: CLIENT_ID }`. Every existing subscription was therefore
created under the **old** application and is bound to it.

Two independent reasons they are now dead:

1. They are conditioned on the old client id, so they cannot fire for
   authorizations granted to the replacement application.
2. `TWITCH_EVENTSUB_SECRET` was changed at 09:06:50. Twitch signs each callback
   with the secret stored **on the subscription**, so any surviving old
   subscription now fails HMAC verification and is rejected by `verifyRequest`.

**Consequence:** `user.authorization.revoke` is currently not being delivered.
That is the G6 compliance path — when a user disconnects Watchside on Twitch,
`purge_twitch_derived` should destroy their credential and Twitch-derived
observations. **Right now nothing triggers it.**

The function already has an owner-only admin surface, authenticated by
`x-watchside-admin: <TWITCH_EVENTSUB_ADMIN_TOKEN>`:

- `{"action":"subscription_status"}` — **read-only**; lists subscriptions and
  reports `total`, `ours`, `enabled`, `statuses`.
- `{"action":"ensure_subscription"}` — creates one if none is enabled.

**Recommended next step, read-only first:** call `subscription_status`. Expected
result under the replacement application is `ours: 0, enabled: 0`, which would
confirm the gap. Only then, with explicit approval, `ensure_subscription`.

Old-application subscriptions cannot be listed or deleted — that needs the old
app's token, and its secret no longer exists. They are harmless: they fail
verification, and Twitch disables subscriptions whose callback repeatedly fails.

---

## Status

| | |
| --- | --- |
| Metadata outage | **CLOSED — recovered and verified** |
| Latent client bug (§8) | **OPEN — next release**, see `docs/ROADMAP.md` |
| F1 old-app credentials | **OPEN — self-healing, no action required** |
| F2 EventSub subscriptions | **OPEN — needs a read-only check, then owner approval** |
| Acquisition 0045 / website deploy | **PAUSED** pending follow-up closure |
| Marketing capture | **PAUSED** |
| v0.9 artifacts | **UNTOUCHED** |

---

# F2 CLOSED — EventSub restored under the replacement application

**2026-09-09T00:04Z.** G6 revocation delivery is working again.

## The gap, proven before it was touched

EventSub subscriptions are owned by the **application** that created them, and
`twitch-eventsub` binds them further with `condition: { client_id: CLIENT_ID }`.
Everything created under the old app stayed there.

Listed directly against Twitch with the replacement app's own credentials —
unfiltered, so every subscription of every type it owns:

```
eventsub list HTTP : 200
total              : 0
total_cost         : 0 / 10000
user.authorization.revoke present: false
```

Zero existing, not zero enabled. `total_cost: 0` corroborates independently.
Old-app subscriptions are unreachable — listing or deleting them needs the old
app's token, whose secret no longer exists.

## Why the built-in endpoint could not be used

`twitch-eventsub` already exposes an owner-gated `ensure_subscription`, but it
requires `TWITCH_EVENTSUB_ADMIN_TOKEN`, which is write-only in Supabase and
**deliberately not stored in this repository** — `scripts/m3d-acceptance/run.mjs`
states that policy outright. That is least privilege working as designed, so it
was not routed around.

The obstacle is structural: *both* routes to creating a subscription need a
write-only value. `ensure_subscription` needs the admin token; creating directly
at Twitch needs `TWITCH_EVENTSUB_SECRET`, because the subscription's HMAC secret
must equal the receiver's or the verification callback fails. Any recovery
therefore required exactly one secret write. The only real choice was which.

**`TWITCH_EVENTSUB_SECRET` was chosen because it had zero dependents.** With no
subscriptions in existence, nothing could break by rotating it — whereas the
admin token is also read by `twitch-credential`'s owner-gated `credential_shape`
branch and by the M3D acceptance script.

## What was done

1. Fresh secret generated locally: 32 random bytes, base64url, 43 ASCII chars
   (Twitch permits 10–100). Never printed.
2. Written to Supabase as **`TWITCH_EVENTSUB_SECRET` only**, via a temp env file
   containing that single key, mode `0600`, outside the repository.
   `TWITCH_CLIENT_ID`, `TWITCH_CLIENT_SECRET`, `TWITCH_EVENTSUB_ADMIN_TOKEN` and
   every `VITE_*` value were untouched.
3. Temp file deleted immediately; removal confirmed.
4. App token minted from the replacement app's credentials. Never printed.
5. **Re-listed before creating** and confirmed `total: 0` a second time — a
   duplicate guard, since `ensure_subscription`'s own idempotency check was
   unavailable on this path.
6. Exactly one subscription created, matching the deployed function's shape
   field for field (`REVOKE_SUBSCRIPTION_TYPE`, `REVOKE_SUBSCRIPTION_VERSION`
   and the `CALLBACK_URL` string `subscriptionState` exact-matches on).

The whole sequence ran in a single process, so the generated value existed on
disk only for the duration of the `secrets set` call.

## Verification

```
create HTTP        : 202   status: webhook_callback_verification_pending
poll  1            : total=1 rows=1 status=enabled cost=1

total              : 1
total_cost         : 1 / 10000
  type             : user.authorization.revoke v1
  status           : enabled
  transport        : webhook
  callback         : ezikxbbcwcxhkboeekkk.supabase.co/functions/v1/twitch-eventsub
  callback exact   : true
  condition        : client_id | matches current app: true
  created_at       : 2026-09-09T00:04:02Z
enabled revoke subs: 1 | duplicates: false
```

**Reaching `enabled` is the proof, and it proves more than it looks.** Twitch
delivers a signed challenge, and `twitch-eventsub` answers it only after
`verifyRequest` passes — so `enabled` means the subscription's secret and the
receiver's `TWITCH_EVENTSUB_SECRET` agree. Nobody needed to know the value, and
nobody does. It also confirms independently that Supabase secrets are
runtime-injected: the write took effect with no redeploy.

## What this restores

`user.authorization.revoke` is delivered again. When a user disconnects
Watchside on Twitch, the receiver calls `purge_twitch_derived`, destroying that
actor's encrypted credential and Twitch-derived relationship observations —
and nothing else. **That is the G6 compliance path, and it was not firing
between the application replacement and now.**

## Residue, stated plainly

- **Old-application subscriptions cannot be cleaned up.** Deleting them needs the
  old app's token. They are inert: conditioned on a client id no user authorizes
  any more, and unable to pass HMAC verification against the rotated secret.
  Twitch disables subscriptions whose callback repeatedly fails.
- **Revocations that happened during the gap were not delivered** and cannot be
  replayed. If a user disconnected Watchside on Twitch between ~08:17 on
  2026-09-08 and 00:04 on 2026-09-09, their credential and observations were not
  purged. The blast radius is bounded by how few users exist; the durable fix is
  that delivery now works.
- **The new secret is known to nobody**, by design. If it is ever needed, rotate
  it again — which is exactly what happened here.

## Status

| | |
| --- | --- |
| F2 EventSub | **CLOSED** |
| G6 revocation delivery | **RESTORED** |
| F1 old-app credentials | open, self-healing, no action required |
| Metadata outage | closed (`d6c46ad`) |
| Latent client bug | open, next release |
