# M6B — Production reliability and operations

**Date:** 2026-09-02
**Question:** if strangers are using Watchside and something breaks while the owner is asleep, can we know, understand, bound and recover?
**Schema:** 38 → **39**
**Preceded by:** M6A — stranger activation

---

## 1. Verdict

**★ GO.**

Watchside's operational posture was **substantially stronger than expected**,
and the audit spent most of its time confirming that rather than building.
Three things were genuinely missing; all three are small, all three are fixed.

**What was already there** — and would have taken a milestone to build:

- a closed failure vocabulary (`FailureContext` × `FailureCode`) with
  `client_error` emitted from **every** `logError` call since 0024;
- rate budgets on presence, group creation, group messages, room messages,
  reactions and feedback, through a shared `consume_rate_budget` helper;
- `verify:released`, which reads the actual shipped Store ZIPs and proves no
  migration has stranded them;
- analytics that is **structurally** fail-open — `track()` is synchronous,
  void-returning and queued;
- graceful Twitch degradation: metadata failure leaves presence, Gravity and
  JOIN untouched;
- human error messages with no infrastructure jargon (M5D).

**What was missing:**

| | |
| --- | --- |
| **P1** | `send_friend_request` had **no rate budget** — every other write surface adopted one; this never did |
| **P1** | `client_error` was collected since 0024 and **readable by nobody** — no view, so "is something broken right now" meant writing SQL during an incident |
| **P2** | The fail-open guarantee had **no test** — one refactor from being untrue |
| **P2** | No runbook |

**No new vendor is recommended.** No paid service, no error-tracking SaaS, no
uptime monitor. Everything M6B needed already existed in Supabase and in the
telemetry this project already collects.

---

## 2. The failure model, and what we would actually see

Abbreviated to what matters. The full domain list was walked; these are the ones
where the answer was interesting.

| Failure | User impact | Detectable? |
| --- | --- | --- |
| Backend unavailable | "Watchside is offline", retry offered, friends list empty rather than stale | **Yes** — `network` codes across contexts, `actors_blocked` rises |
| Twitch metadata down | Cards render un-enriched; social layer unaffected | Yes — `metadata.fetch` failures |
| Twitch page layout changes | **Panel missing entirely** | **Weakly** — the panel failing to mount produces little; this is the classic "user DMs us" case |
| Realtime disconnect | Stale presence; recovers | Yes — `realtime` code |
| RPC refused / RLS regression | One surface fails | Yes — `refused` code, per context |
| Rate limit biting a real user | An action refuses | Yes — `rate_limited`, and it is the **scale signal** |
| **Sign-in broken** | Cannot use Watchside at all | **NO — see §3** |
| Bad migration | Varies | Yes, if `verify:released` was run first |
| Bad extension release | Varies | Slowly, and rollback is days |
| `watchside.app` down | Nothing — no client resolves it | N/A |

---

## 3. The blind spot, stated rather than papered over

**A person who cannot sign in produces no telemetry at all.**

`analytics_events.actor_id` is the signed-in user, and the recorder's `canSend()`
drops everything until authentication completes. So broken sign-in shows up as
**absence** — a fall in `authenticated_actors` — never as errors. An extension
that fails to mount is invisible for the same reason.

**This is a deliberate privacy boundary, not an oversight.** Recording failures
from unidentified browsers means collecting from people who have not signed in
to anything, which is a materially different privacy posture and a
disclosure change. It is not worth taking on speculatively for a product that
has not yet been distributed with any of this instrumentation.

The mitigation is the one that costs nothing: **watch the shape of the
denominator, not just the errors.** `ops_health_v` reports
`authenticated_actors` per hour precisely so the failure that produces no errors
is still visible as a hole. That is written into the runbook as the first alert
to set once a baseline exists.

---

## 4. Health, defined

Two views, added in 0039, both built on evidence already being collected.

**`ops_health_v`** — one row per hour and environment: active actors,
authenticated actors, joining actors, actors with any failure, and
**`actors_blocked`** (an `unauthenticated` or `network` failure — the two that
mean the product is unusable rather than degraded).

**`ops_client_failures_v`** — failures per hour by context and code, with
**`failures` and `actors` reported separately**. That distinction is the whole
reason the view exists: ten failures from one person is somebody on a train; ten
from ten people is an incident, and a raw count cannot tell them apart. A
mutation lever removes the distinction and is caught.

Internal actors are excluded from both, as everywhere — the owner testing an
error path must not look like users hitting one.

**No thresholds are encoded**, and a test asserts that. There is no production
baseline, so any number written in today would be a guess wearing an alert's
clothing.

---

## 5. Friend-request abuse

`send_friend_request` had no budget. One authenticated account could send
unlimited requests to everybody search could find, each landing in a stranger's
Requests list. Blocking exists but is reactive — the victim must be spammed
first.

**Twenty new requests per hour**, through the same helper every other surface
uses, raising the same `53400` the client already maps to `rate_limited`.

**Where the check sits is the design.** After the "already friends / mutual
intent / already requested" resolutions, immediately before the INSERT — so:

- pressing Add again on a pending request is **free** (an impatient click must
  not cost budget);
- accepting somebody who already asked is **free** (it creates nothing in
  anybody's inbox);
- somebody who is already a friend is **free**;
- only a genuinely new request — the thing that reaches a stranger — costs.

The budget therefore counts *strangers contacted*, not buttons pressed. Two
mutation levers cover this: removing the budget, and moving it earlier so it
charges for clicks. Both caught.

**Twenty, not five.** Blocking a genuine enthusiastic new user costs far more
than letting a spammer send twenty rather than five, and a test asserts fifteen
consecutive adds succeed.

`claim_invite` and `bind_acquisition` need no budget: both are bounded by
construction at one row per actor, ever.

---

## 6. Analytics fails open — now proved

Watchside carries a lot of measurement, and none of it is worth a user being
unable to press JOIN.

The property was already true and **entirely untested**, which is one refactor
from untrue: the obvious "improvement" is `async track()` so a caller can await
delivery, and nothing would have objected.

`tests/extension/analyticsFailOpen.test.ts` (10 tests) proves `track()` does not
throw when the backend rejects, throws synchronously, receives an unknown event
name or malformed properties; that `flush()` **resolves** rather than rejects
under a permanently failing backend; that the queue is capped; and — reading the
source, not just the behaviour — that `track()` stays `void` and that no product
path awaits it.

That last one matters because `flush()` is awaited by the M3D JOIN trigger. If
it rejected on a backend failure, an analytics outage would become a JOIN that
throws — measurement breaking the thing it measures, at the least forgivable
moment. A mutation making `track()` async is caught.

**A hazard I introduced and then removed:** the first version of that suite used
a microtask-based timer so flushes fired immediately. Against a
permanently-failing backend the retry rescheduled into an infinite microtask
loop and hung the suite. The timer is now inert — every test calls `flush()`
explicitly, so a working timer bought nothing and cost that.

---

## 7. Version skew

**Sufficient as it stands. Nothing added.**

`verify:released` reads the actual shipped Chrome 0.7 and Firefox 0.6 packages
and proves every RPC they call still exists and is still granted, that their
Edge Functions are present, and that the analytics registry has only ever been
appended to. Re-run in M6B: **15/15 RPCs each, clean**.

0039 is the first migration to change a function body since that check existed,
which is exactly the case it was built for. `send_friend_request` keeps its
signature, its return values and every other behaviour; the only difference an
old client can observe is a `53400` it already knows how to render, because
every other write surface already raises it.

The standing rules — never remove an RPC, never narrow a grant, never delete an
event name — are written into the runbook where somebody will actually read
them before applying a migration.

---

## 8. Deployment and rollback, honestly

Recorded in `docs/OPERATIONS.md` rather than assumed:

- **Additive schema changes do not roll back**, and should not. A new table
  nothing reads is harmless; reverting is usually more dangerous.
- **A changed function body is the real risk**, because `create or replace`
  overwrites in place. Recovery is re-applying the previous definition from git.
- **There is no fast extension rollback.** Chrome and Firefox both require a new
  upload and a fresh review — days, not minutes — and users update on the
  browser's schedule. So the fastest lever for a bad client is almost always a
  **backend change that makes the bad client behave**, not a new release. That
  is worth knowing before it is needed rather than during.

---

## 9. Support triage

Three questions, and nothing else: **version** (bottom of the account panel),
**browser and roughly when**, and **whether sign-in works** — that last answer
splits the problem space in half.

Never ask for tokens, cookies, passwords, OAuth screenshots or message contents.
Nothing diagnosable is worth any of them, and the public support page already
says so.

With a rough time and a failing surface, `ops_client_failures_v` names the
context.

---

## 10. Privacy

**No new data collection.** Both views are built on `client_error`, collected
since 0024, whose payload is two closed vocabularies — a context name and a
coarse code. No URLs, no channels, no message contents, no identifiers beyond
the actor id already present on every analytics row.

**No privacy-disclosure change is required**, and none was made. The one thing
that *would* have required one — recording failures from unauthenticated
browsers — was considered and deliberately not done (§3).

---

## 11. Scale

No load testing has been done, so these are reasoned from write patterns rather
than measured, and are labelled as such in the runbook.

**~1,000 users:** presence writes and Realtime connections give first — presence
is the highest-frequency write in the product, one per heartbeat per active
user. Twitch metadata lookups follow, scaling with distinct channels rather than
with users.

**~10,000:** `analytics_events` row growth (every JOIN, impression and dwell
interval is a row), and Realtime fan-out on popular channels where many friends
share one room.

**The earliest honest signal is `rate_limited` appearing in
`ops_client_failures_v`** — a budget biting a real user means the product is
being used harder than it was shaped for.

---

## 12. Alerting

**None, deliberately, and that is the right answer today.** A threshold set
without a baseline either cries wolf until ignored or stays silent through the
incident it was written for.

When 0.8 is live and there is a week of data, two are worth setting, and both
read from views that exist now:

1. `authenticated_actors` dropping sharply hour-on-hour — the proxy for broken
   sign-in, which is the failure that produces no errors;
2. `actors_blocked` exceeding a meaningful share of `active_actors`.

Nothing needs building first. Only observing.

---

## 13. Findings by severity

| | Finding | State |
| --- | --- | --- |
| **P1** | `send_friend_request` unbudgeted — cheap social spam | **Fixed** (0039) |
| **P1** | `client_error` collected and unreadable | **Fixed** (0039, two views) |
| **P2** | Analytics fail-open untested | **Fixed** (10 tests, 1 lever) |
| **P2** | No incident runbook | **Fixed** (`docs/OPERATIONS.md`) |
| **P2** | Pre-auth failures unobservable | **Accepted**, documented, mitigated by watching the denominator (§3) |
| **P3** | Panel-mount failure after a Twitch layout change is weakly detectable | Accepted — the honest first signal is a support report |
| **P3** | No alert thresholds | Deferred until a baseline exists (§12) |

**No P0. No unresolved P1.**

---

## 14. Validation

| Gate | Result |
| --- | --- |
| deterministic suite | **3,069 passed / 125 files** |
| lint | clean |
| `npm run typecheck` (`tsc -b`) | clean |
| build | clean |
| `verify:firefox` | clean |
| `verify:released` | Chrome 0.7 and Firefox 0.6 uncompromised, 15/15 RPCs each |
| `test:destruction` | **92/92 detected** (5 new operations levers) |

New suites: `tests/db/operations.test.ts` (15, real PostgreSQL),
`tests/extension/analyticsFailOpen.test.ts` (10).

Known debt unchanged and not normalised. Automated browsers stayed quiet — no
capture run was needed, and the mute assertions still hold.

---

## 15. External state

**watchside.app** — checked once. Still no certificate;
`ERR_TLS_CERT_ALTNAME_INVALID`. GitHub still reports both hosts eligible. DNS
untouched.

**Chrome** — 0.7 live, 0.8 pending review. The submitted artifact is untouched
at `cb3af261…`.

**Firefox** — 0.6 awaiting first AMO review. Untouched.

**0039 is safe to apply while 0.8 is in review**, and that is the point of §7:
it is additive, `verify:released` passes against both shipped packages, and the
only observable difference is an error code every client already renders.

---

## 16. Recommendation

**M6B ★ GO.** Watchside can be operated by one person: a broad outage is visible
in one query, a user report is diagnosable from three safe questions, the
cheapest abuse path is bounded, measurement cannot break the product, and there
is a runbook that answers what to check first.

**No vendor, no spend, no new collection.**

The marketing gate stays closed, unchanged.
