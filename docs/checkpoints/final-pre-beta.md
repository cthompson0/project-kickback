# FINAL PRE-BETA

**Date:** 2026-08-25
**Migration:** `0023_feedback.sql` — **NOT YET APPLIED TO HOSTED**
**Status:** implemented and verified; **not distribution-ready until 0023 is applied**
**Follows:** [private-beta-readiness.md](private-beta-readiness.md)
**Roadmap:** [../ROADMAP.md](../ROADMAP.md)

---

## Feedback implementation

Analytics say what people did. This is the only place they can say why.

**Entry point.** A `Feedback` button in the account panel, beside Reset layout
and Sign out. Deliberately not on Social Gravity and not in the tab row: it is a
secondary action people reach for occasionally, and a permanent button on the
main surface would take space from the thing the product is for. The account
panel is where the other *about Kickback rather than about your friends*
controls already live. A test asserts the string appears in no other component.

**The form**, opening as a sub-view of the account panel:

```
←  Feedback
   [ Bug ] [ Confusing ] [ Idea ] [ Other ]
   ┌────────────────────────────────────┐
   │ What happened?                     │
   └────────────────────────────────────┘
   [ Send ]  Cancel
```

Four categories, one text box, two buttons. Nothing else is asked for — no
title, no severity, no browser, no URL, no reproduction steps, no email, no
username. All of that is either derivable by the service worker or not worth the
friction, and a test asserts none of those words appear in the rendered form.

**Length limit: 2000 characters.** Enough for a paragraph and a rough repro,
short enough that the column is bounded. Enforced in three places that a test
holds in agreement — `maxLength` on the textarea, a guard in the RPC, and a
`check` constraint on the column. A disagreement between them would mean either
a silent truncation or a rejection the user could not see coming.

**States.** `idle → sending → sent`, plus failure.

- **Sending** disables Send and shows `Sending…`. One at a time, because a slow
  network plus an impatient second press is two identical reports.
- **Sent** is small: *"Thanks — feedback sent."* and a `Send something else`
  link. Not a modal, nothing to dismiss.
- **Failure** shows an inline note and **keeps every character typed**. The
  moment somebody is most likely to be writing three paragraphs is the moment
  something is broken — which is the moment the request is most likely to fail.
  Losing their text there would lose the report. The body is cleared only after
  the await resolves, never in the catch, and a test pins that ordering.

**Keyboard and nesting.** Escape unwinds exactly one layer: out of the form
returns to the account panel; a second Escape closes the panel. Same
*innermost-wins* rule the UserCard already follows, and asserted in a real
browser rather than by reading source. The account panel's `×` still closes the
whole thing and resets the sub-view, so reopening starts clean.

## Privacy model

**The client sends what somebody typed. The worker says where they were.**

| Field | Source | Why |
| --- | --- | --- |
| `category`, `body` | client | it is what the user wrote |
| `surface`, `collapsed` | client | only the panel knows which tab was open |
| `app_version`, `environment` | **worker** | build facts |
| `browser` | **worker** | brand + major version only |
| `channel`, `on_channel` | **worker** | *"my friend didn't appear"* is unanswerable without where |
| `friend_count` | **worker** | a count, never a roster |
| `session_available` | **worker** | whether a session existed at the time |
| `social_sync`, `presence_sync` | **worker** | realtime health |

The split is not tidiness. A client that assembled its own diagnostics could
report a healthy connection while sitting on a broken one, which is the opposite
of what a diagnostic is for.

**The browser string is brand and major version only** — `Chrome 141`. The full
user-agent is a fingerprinting surface and answers nothing extra: the short form
already tells you whether two testers are on the same thing.

**The server whitelists it again anyway.** `submit_feedback` rebuilds the context
key by key with `jsonb_build_object` and bounds every value, so a future client
that starts attaching something it should not writes nothing rather than writing
it. A DB test submits a payload containing a JWT-shaped token, a provider token,
message bodies, a friend list, a muted list, a blocked list and half-typed
composer text, and asserts the stored context contains **only** the one
whitelisted key that was also present.

**Never attached:** auth tokens, provider tokens, cookies, message bodies, chat
history, composer contents, secrets, storage dumps, friend identities, blocked
identities, muted identities. Asserted as a list against the worker's source.

**Analytics gets the category and nothing else.** `feedback_submitted` with one
allowed property. `analytics_events` is built on the promise that it cannot
contain free text — 64-character values, unknown keys stripped on both sides of
the wire. Feedback is the one thing in Kickback that *is* free text, so it goes
to its own table and analytics learns only that it happened.

## Feedback inspection

Boring and reproducible, in the Supabase SQL editor. No admin UI.

```sql
select created_at, category, body, display_name,
       app_version, environment, browser, surface, channel,
       friend_count, session_available, social_sync, presence_sync
from public.feedback_v
order by created_at desc;
```

Documented in [BETA_ANALYSIS.md §9a](../BETA_ANALYSIS.md), together with a
category breakdown and a cross-check against the analytics counter.

`feedback_v` is revoked from every client role. **There is no in-product read
path — not even for the person who wrote it.** A submission is a message to us,
not a document you own, and a read path returning your own rows would be one
policy change away from returning everybody's.

## Migration

`0023_feedback.sql` — **not yet applied to hosted.**

```sql
create table public.feedback (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null references public.users (id) on delete cascade,
  category   text not null check (category in ('bug','confusing','idea','other')),
  body       text not null check (char_length(body) between 1 and 2000),
  context    jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
```

- **RLS enabled with no permissive policy**, which denies everything. The only
  writer is the `SECURITY DEFINER` RPC, which bypasses RLS as its owner.
- **No UPDATE, no DELETE for anybody.** Feedback is a thing somebody said at a
  moment; editing it afterwards would make it evidence of nothing.
- **Actor is `auth.uid()`**, never a parameter — submitting on somebody else's
  behalf is impossible rather than discouraged.
- **Rate limited** to 5 per 5 minutes per person, through the existing
  `consume_rate_budget`. Generous enough that nobody hits it while reporting
  things; tight enough that a stuck retry loop cannot fill the table. Per person,
  so one noisy tester cannot silence the cohort.
- `analytics_schema_version()` moves to **23** — the newest analytics-touching
  migration owns the marker, because everything else these files change is
  revoked from clients and therefore invisible to `verify:analytics`.
- Transactional, idempotent, `drop function` / `drop view` before recreate,
  grants explicit. Verified applying to an empty database, twice, three times,
  and **on top of a database stopped at 0022**.

## Package

**No archive was produced, and that is the packager working.** Run against the
real project it stops before it builds anything:

```
== Verifying the hosted analytics and feedback schema
  function MISSING  submit_feedback  <-- not applied

Not applied: feedback, feedback_v, function submit_feedback
Apply supabase/.generated/apply_all.sql in the Supabase SQL editor.

Refusing to package: telemetry or feedback would be broken for testers.
```

That check is new here. The packager already verified the Supabase key and the
group backend; it did **not** verify analytics, so before this checkpoint it
would happily have shipped a Feedback button with no RPC behind it. It now runs
`verifyAnalyticsSchema()` as a preflight, and `verify:analytics` knows about
`feedback`, `feedback_v` and `submit_feedback`.

The same run confirms hosted really is applied through 0022 — every relation and
function from 0013–0016 reported present, and only the three 0023 objects are
missing.

Everything else the packager checks was already passing at the previous
checkpoint and is unchanged: private_beta environment forced at the build call,
extension ID recomputed from the pinned key against the OAuth allow-list, a file
**allow-list** rather than a deny-list, secret and demo-marker scanning of both
the staging directory and the finished archive, and a content-script-scoped rule
that no provider token or direct Twitch API call reaches the page.

**Exact filename, size and SHA-256 cannot be reported yet** — there is no
archive until 0023 is applied. The artifact will be
`releases/Kickback-Private-Beta-v0.4.0.zip`.

## Tester install process

From `README-TESTERS.txt`, which ships inside the archive:

1. Extract the ZIP somewhere permanent — Documents or Desktop, **not** Downloads.
2. Open Chrome, go to `chrome://extensions`.
3. Turn on **Developer mode** (top right).
4. Click **Load unpacked**.
5. Select the extracted **Kickback** folder — the one holding the README.
6. Open Twitch.
7. Click **Continue with Twitch** in the Kickback panel.

Kickback appears on the right-hand side of Twitch. Drag it by its header, resize
from the bottom corners, minimise with the button top-right — and now drag the
minimised `K` too.

**Reviewed once more against a reader who has never used Developer mode.** It
explains what to click and in what order, never why. No implementation
internals, no repository, no npm, no Supabase, no DevTools.

## Tester update process

Unchanged, and correct for this cohort.

**What you send:** the new ZIP.

**What they do:**

1. Extract the new ZIP.
2. Copy its files into the **same folder** they installed from, replacing the
   old ones.
3. `chrome://extensions` → the reload arrow on Kickback.
4. Refresh the Twitch tab.

The README says why the folder path matters: Chrome treats a folder in a new
location as a different install, which means signing in again and setting the
panel up again. **Same folder = they stay signed in.**

Not solved here, and deliberately: automatic updates. That means an unlisted
Chrome Web Store listing, which costs a review round-trip and removes the
ability to push a fix in ten minutes. Revisit at ~20 testers.

## Automated verification

| Gate | Result |
| --- | --- |
| `tests/db` | 257 passed (7 files) |
| `tests/extension` + `tests/core` | 1334 passed (49 files) |
| `npm run test:lab` | 121 passed |
| `npm run verify:lab` (real browser, CDP) | **12 scenarios** — 1 new |
| `npm run typecheck` | clean |
| `npm run lint` | clean |
| `npm run build` | clean |

New coverage:

- `tests/db/feedback.test.ts` — 16 tests: storage, the four categories and
  nothing else, empty and over-length refusals, whitespace-only refusal,
  trimming, the per-person rate limit, the context whitelist keeping what it
  should and dropping a payload of tokens and rosters, per-key bounds, and six
  refusals covering read, write, update, delete and impersonation.
- `tests/db/bundle.test.ts` — 0022 → 0023 upgrade, and grants asserted directly
  rather than trusting that a missing policy stays missing.
- `tests/extension/feedbackUi.test.tsx` — 16 tests: the form asks for nothing it
  could find out itself, the length limit agrees with the SQL, failure keeps the
  text, no double submit, the entry point exists in exactly one place, analytics
  carries only the category, and the worker's context block contains none of a
  named list of forbidden things.
- `scripts/verify-test-lab.mjs` — a real-browser scenario: open the account
  panel, open Feedback, assert the four categories and a disabled Send, type,
  assert Send enables, send, assert the sent state, then Escape twice and assert
  it unwound one layer at a time.

Mutation universe not run. `test:analytics` not run. Nothing exceeded five
minutes.

## Manual smoke test

Short, on the packaged build, once 0023 is applied. Two accounts.

1. **Install** the ZIP fresh → panel appears on Twitch.
2. **Continue with Twitch** → signed in, your name in the account panel.
3. **Account panel** → opens from the avatar, `×` closes it, Escape closes it.
4. **Feedback** → opens, pick a category, type, Send → *"Thanks — feedback
   sent."* Then check the row arrived: `select * from public.feedback_v;`
5. **Friends** → `+ Add`, search the other account by Twitch username, request,
   accept on the other side.
6. **Presence** → put the other account on a channel; it appears.
7. **Gravity** → the destination card shows with the friend count.
8. **JOIN** → click it; the tab navigates to the channel.
9. **Arrival** → `select source, arrived_at from public.analytics_join_funnel_v
   order by clicked_at desc limit 5;` shows the arrival.
10. **Session** → both on the same channel; the streamer tab appears; send a
    message and an emote; the other account receives them.
11. **Block / Unblock** → block from the user card, confirm they vanish both
    ways; unblock, confirm they do not come back as a friend.
12. **Mute / Unmute** → mute from the card, unmute from the account panel.
13. **Launcher** → minimise, drag the `K` somewhere else, click it → opens where
    you left it.
14. **User card** → open one over a busy Gravity card → fully opaque, nothing
    behind it readable.

## Roadmap updates

[ROADMAP.md](../ROADMAP.md) created, recording the post-audit sequencing.
Headlines:

- **Feedback** — shipped, and treated as a durable capability rather than beta
  scaffolding.
- **Social Gravity / pre-JOIN signal** — already implemented; future work is
  *optimisation*, not construction.
- **Cold start** — not solved, knowingly. A successful beta validates the core
  social loop, **not** organic acquisition.
- **Invites** — defer during hand distribution; P0 the day Kickback is listed.
- **Suggested Friends** — defer; revisit on density evidence.
- **Analytics dashboard** — defer; SQL-first is the active strategy.
- **Combo signal** — corrected: combos are drawn only on HERE, which is never a
  JOIN opportunity, so current combo analytics **cannot** measure JOIN lift.
  Preserved as a future experiment.
- **Rooms** — do not assume success requires them; discovery value and
  communication value stay analytically separate.
- **Twitch-native rail** — audited, deferred; floating stays first-class.
- **Browsers** — Chromium-first; Firefox after core-loop validation.
- **Multi-platform** — after Twitch validation, and behind a platform
  abstraction audit; prototype one platform before generalising.
- **Monetisation** — not during the beta. Recorded explicitly: *donations are
  not the monetisation thesis.*

**The learning rule** is recorded prominently: once the cohort begins, normal
feature development stops. Only P0 breakage, serious reliability bugs, safety or
privacy issues, and obvious blockers. Collect, observe, analyse — do not build
each suggestion as it arrives.

## Deferred work

Everything in the roadmap's *Decided* section, plus the gaps carried forward
from the readiness audit: exposure→JOIN is a time window rather than a minted
id, there is no holdout during beta, no generic Twitch watch time, and
**Incremental Social Watch Hours does not exist**.

## Final distribution status

**NOT YET DISTRIBUTABLE.** One step remains, and it is not a code step.

`0023_feedback.sql` must be applied to hosted. Until it is, the Feedback button
calls an RPC that does not exist and fails visibly — the correct failure mode,
and not something to discover through a tester.

**Deployment:**

1. Open the Supabase SQL editor for the Kickback project.
2. Paste and run the whole of `supabase/migrations/0023_feedback.sql`.
   It is transactional and idempotent; running it twice is safe.
   *(Equivalently, re-run `supabase/.generated/apply_all.sql`, which now bundles
   all 23 migrations and is also safe to re-run.)*
3. Confirm:

   ```sql
   select public.analytics_schema_version();   -- expect 23
   select count(*) from public.feedback;       -- expect 0
   ```

4. Then run `npm run package:beta` — it will refuse if hosted is not healthy —
   and hand out the archive it writes to `releases/`.

Everything else is done: the code is verified, the tests pass, the packaging
machinery is in place and already refuses to ship a broken artifact, the
installation and update instructions are written, and the roadmap records what
was decided and why.
