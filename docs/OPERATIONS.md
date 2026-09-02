# Operations

What to do when Watchside is broken and you are the only person awake.

Written to be useful at 2am, which means short, ordered, and honest about what
is genuinely unknown.

---

## First: is it actually us?

Watchside sits on top of three things it does not control. Rule them out before
touching anything, in this order — it takes about two minutes.

| Check | How | If it fails |
| --- | --- | --- |
| **Twitch** | Open `twitch.tv` in a normal browser, signed out | Twitch is down. Watchside will look broken and there is nothing to fix. Wait. |
| **Supabase** | The Supabase dashboard → project health | Backend outage. See *Backend down* below. |
| **The public pages** | `curl -sI https://anoteros-labs.github.io/watchside/support/` | Should be 200. If not, GitHub Pages — the extension still works; only support/privacy links are affected. |
| **watchside.app** | `curl -sI https://watchside.app/` | Expected to fail until the certificate issues. **Not an incident.** Nothing in the extension resolves it. |
| **Watchside itself** | `npm run verify:released` and the queries below | See *Triage* |

**The most common cause of "Watchside is broken" is Twitch changing their page
layout.** The panel anchors to Twitch's DOM. If the panel is missing but
everything else is healthy, suspect that first.

---

## Triage: how bad is it?

Two views, added in 0039. Run them as the owner in the Supabase SQL editor.

```sql
-- Is anything failing, for how many people, right now?
select * from public.ops_health_v
 where hour > now() - interval '6 hours'
 order by hour desc;
```

`actors_blocked` is the number that matters: people who hit an `unauthenticated`
or `network` failure and therefore could not use Watchside at all. Everything
else is a degraded surface rather than an outage.

```sql
-- What exactly is failing?
select * from public.ops_client_failures_v
 where hour > now() - interval '6 hours'
 order by failures desc
 limit 20;
```

**Read `actors`, not `failures`.** Ten failures from one person is somebody on a
train. Ten failures from ten people is an incident. A raw count cannot tell them
apart, which is why the view reports both.

### Estimating impact

`ops_health_v.active_actors` is your denominator for the hour. There is no
baseline yet — the product has not been publicly distributed with this
instrumentation — so compare against the preceding hours in the same query
rather than against a remembered number.

### The blind spot, stated plainly

**A person who cannot sign in produces no telemetry at all.** Analytics events
require an authenticated actor (`analytics_events.actor_id` is the signed-in
user), and the recorder drops events until sign-in completes. So:

- broken sign-in shows up as **absence** — a drop in `authenticated_actors` —
  not as errors;
- an extension that fails to load at all is invisible;
- the first signal for those is often a support email.

This is a deliberate privacy boundary, not an oversight: recording failures from
unidentified browsers means collecting from people who have not signed in to
anything. If it becomes a real operational problem, it is a decision to take
knowingly, with a privacy-disclosure change.

---

## Backend down

**Symptoms:** `actors_blocked` climbing, `network` codes across many contexts,
or the Supabase dashboard showing the outage directly.

**What users see:** "Watchside is offline", a human message, and a *Try again*
button. Their friends list is empty rather than wrong — the client refuses to
show stale friends when it cannot confirm them.

**What to do:**

1. Confirm in the Supabase dashboard. If it is Supabase's incident, there is
   nothing to deploy.
2. Do **not** ship an extension release to "fix" it. The client already degrades
   correctly and a Store release takes days.
3. When it returns, clients recover on their own: the session refreshes on an
   alarm and the panel retries.

**Do not** revoke keys, rotate configuration or re-run migrations during an
outage. Every one of those makes recovery slower and none of them is the cause.

---

## A bad migration

Migrations are **additive by policy**, which shapes what rollback means.

- **Additive changes do not roll back.** A new table or column that nothing
  reads is harmless; leave it. Reverting is usually more dangerous than the
  thing you are reverting.
- **A changed function body is the real risk.** `create or replace function`
  overwrites in place, so recovery is to re-apply the previous definition from
  the previous migration file. Find it in git and run it.
- **`verify:released` before, not after.** `npm run verify:released` reads the
  actual shipped Store ZIPs and proves every RPC they call still exists and is
  still granted. Run it before applying anything to production.

**The rule that keeps old clients alive:** never remove an RPC, never narrow a
grant, never delete an analytics event name. Chrome 0.7 is live, 0.8 is in
review, Firefox 0.6 is in review, and `main` is ahead of all three. That skew is
normal here and is exactly why the rule exists.

---

## A bad extension release

**There is no fast rollback.** Be honest about this before shipping.

- Chrome: a new version must be uploaded and **reviewed again**. Days, not
  minutes. Reverting means submitting the previous build with a higher version
  number.
- Firefox: same, plus AMO review.
- Users update on the browser's schedule, not yours. Some will be on the bad
  version for a while regardless.

**So mitigation is server-side.** If a client release is bad, the fastest
lever is almost always a backend change that makes the bad client behave — not
a new release.

**Before every Store submission:** `npm run verify:candidate` (the package
contains what you think), `npm run verify:store`, `npm run verify:firefox`.

---

## Twitch degradation

Twitch failing does not take Watchside with it, by design:

- **Metadata unavailable** — cards render un-enriched. Presence, Gravity and
  JOIN keep working.
- **Helix errors or rate limits** — the metadata service backs off; the social
  layer is unaffected because it does not depend on Helix.
- **A revoked authorization** — that user's follow measurement stops. Nothing
  else about their account changes, and they are not signed out.

**Watchside does not retry Twitch aggressively.** If you are ever tempted to
"just retry harder" during a Twitch incident, do not: it converts their outage
into our rate limit.

---

## Abuse

Every write surface is budgeted through `consume_rate_budget`: presence, group
creation, group and room messages, reactions, feedback, and — since 0039 —
friend requests (20 new requests per hour, charged only for genuinely new ones).

**If somebody is abusing something:**

1. Find them: `select * from public.rate_limits order by writes desc limit 20;`
2. Blocking is a user-level tool and works today; there is no admin ban switch,
   deliberately.
3. Tightening a budget is a migration, and it is a safe one — it changes a
   number in one function.

---

## Supporting one user

Ask for these three, and nothing else:

1. **The Watchside version** — bottom of the account panel.
2. **Which browser**, and roughly when it happened.
3. **Whether sign-in works** — that single answer splits the whole problem
   space in half.

**Never ask for** tokens, cookies, passwords, screenshots of OAuth screens, or
message contents. Nothing you can diagnose is worth any of them, and the support
page says so too.

With a rough time and the failing surface, `ops_client_failures_v` will usually
name the context.

---

## When to tell users

- **Backend outage over an hour**, or anything affecting sign-in: say something.
  The support page is the place; it works when the extension does not.
- **A degraded surface** (metadata, room history): usually not worth a notice.
- **Anything touching data or privacy:** say something immediately, whatever the
  size.

## When to pause marketing

The marketing gate is currently **closed** anyway. Once it opens, pause on:

- sign-in failing for anybody,
- the backend being unavailable,
- `watchside.app` or the campaign route being down — the campaign links point
  there, so spending on traffic to a dead route is spending on nothing.

---

## Recording what happened

One paragraph in `docs/reports/`, named for the date. What broke, how you found
out, what you did, and — the part that is actually worth writing — **what would
have told you sooner**. That last line is what turns an incident into a check.

---

## Scale: what hurts first

No load testing has been done, so these are reasoned from the write patterns
rather than measured. Ordered by what gives first.

| At roughly | First strain | The signal |
| --- | --- | --- |
| **~1,000 users** | Presence writes and Realtime connections — presence is the highest-frequency write in the product, one per heartbeat per active user | Realtime connection count in the Supabase dashboard; `rate_limited` codes appearing in `ops_client_failures_v` |
| | Twitch metadata lookups, which scale with distinct channels being watched, not with users | `metadata.fetch` failures rising |
| **~10,000 users** | `analytics_events` row growth — every JOIN, impression and dwell interval is a row | Table size in the dashboard; query times on the reporting views |
| | Realtime fan-out on popular channels, where many friends share one room | Room message latency; `realtime` failure codes |

**Watch `rate_limited` in `ops_client_failures_v`.** It is the earliest honest
signal that the product is being used harder than it was shaped for — a budget
biting a real user means the shape needs revisiting, not that the user was
wrong.

---

## Alerting

**There is none, deliberately, and that is the right answer today.**

Thresholds set without a baseline are guesses, and a guessed alert either cries
wolf until it is ignored or stays silent through the incident it was written
for. There is no production baseline because the instrumentation has not been
distributed yet.

**When 0.8 is live and there is a week of data**, the two worth setting are:

1. `ops_health_v.authenticated_actors` dropping sharply hour-on-hour — the
   proxy for broken sign-in, which is the failure that produces no errors.
2. `ops_health_v.actors_blocked` exceeding a meaningful share of
   `active_actors`.

Both come from views that exist now. Nothing needs building first — only
observing.
