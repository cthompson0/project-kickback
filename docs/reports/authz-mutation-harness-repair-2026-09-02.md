# Repairing the authorization mutation harness

**Date:** 2026-09-02
**Base:** `2dc0a93` (end of the v0.9 beta-feedback pass)
**Head:** `1c1ef73`
**Scope:** security-test infrastructure only. No migration, no production
authorization change, no runtime change.

`npm run test:authz` now reports **18/18 detected, exit 0**, from a baseline it
verified was green before grading anything.

---

## 1. Root cause of each class of harness defect

### Class A — six levers were editing dead SQL

`verify-authorization-tests.mjs` weakens one safeguard at a time by
string-replacing an anchor in a migration file. Migrations are applied in order
and later ones `create or replace` earlier definitions, so **the file a lever
edits is not necessarily the file that decides the behaviour.**

Six anchors had drifted onto superseded definitions:

| lever | anchored in | actually decided by |
|---|---|---|
| drop the recipient check when responding | `0003_rpcs.sql` | `0022_blocks.sql` |
| let timestamps move while invisible | `0006_presence_rate_limit.sql` | `0025_presence_destinations.sql` |
| stop escaping LIKE wildcards | `0003_rpcs.sql` | `0041_search_rate_budget.sql` |
| remove the write rate guard | `0006_presence_rate_limit.sql` | `0025_presence_destinations.sql` |
| drop the self-friending guard | `0003_rpcs.sql` | `0039_operations.sql` |
| open chat to non-members | `0007_groups.sql` | `0022_blocks.sql` |

The anchor text still existed in the old file, so the runner's only sanity check
— `original.includes(mutation.from)` — passed. The mutation changed a file,
changed nothing about the schema, the suite stayed green, and the runner
reported *"suite stayed green — this regression would ship"*. It was pointing at
a test that was fine, about a hole that did not exist.

**The detail that makes the mechanical fix necessary:** two of those six already
carried a hand-written comment saying they must target the live definition —
*"0006 redefines report_presence, so this must target the live definition,
mutating the superseded copy in 0003 proves nothing."* That comment was correct
when it was written and had itself gone stale, because 0025 then redefined
`report_presence` again. Prose cannot keep up with migrations; only something
executable can.

### Class B — detection was inferred from human-readable output

```js
execFileSync('npx', ['vitest', 'run', '--reporter=verbose'], …)
const caught = failed && output.includes(mutation.expect)
```

`--reporter=verbose` prints the name of **every** test it runs, passing ones
included. So `output.includes(mutation.expect)` was true whenever the file
containing that test merely executed, and the condition collapsed to
**`failed`** — did the suite exit nonzero, for any reason at all.

Consequence: any unrelated failure credits every lever simultaneously. This is
not hypothetical. A baseline run taken in a `git worktree` at `a5cf0fd` had no
`dist/`, so 29 unrelated tests failed — and the harness reported a perfect
**14/14 detected**. That number was very nearly accepted as evidence that a UI
pass had broken database authorization.

Both defects are the same underlying mistake: trusting a proxy instead of the
thing itself. One trusted "the anchor text is present" as a proxy for "this
weakens the schema". The other trusted "the name appears in the log" as a proxy
for "that assertion failed".

---

## 2. Which levers changed, and why

**Four repointed to the migration that survives**, keeping the same weakening
and the same expected assertion:

- *recipient check* → `0022_blocks.sql`. 0022 rewrote
  `respond_to_friend_request` to re-check blocks.
- *LIKE escaping* → `0041_search_rate_budget.sql`. `search_users` was rewritten
  by 0022 for blocks and again by 0041 for the rate budget; 0041 holds the live
  `v_prefix` build.
- *self-friending* → `0039_operations.sql`. Redefined by 0022, then 0039.
- *group chat policy* → `0022_blocks.sql`, which drops and recreates
  `group_messages_select`. Note the live policy is **stronger** than the one the
  lever used to target: `using (group_message_visible(group_id, user_id))` —
  membership *and* not blocked — where 0007 had `using (is_group_member(...))`.
  The lever now weakens the real thing.

**Two repointed to `0025_presence_destinations.sql`** — *invisible timestamps*
and *the write rate guard* — with **lengthened anchors**, because 0025 contains
two functions that redact presence with byte-identical SQL:

- the invisible-branch anchor now ends `return;`, which distinguishes
  `report_presence` from `report_destinations`'s `return 0;`;
- the rate-guard anchor now includes the preceding `end if;`.

**Nothing was removed, weakened, or reduced in scope.** All 18 levers remain,
each weakening the same protection it always claimed to.

**The other 12 were verified, not assumed.** Because detection had been
unreliable, a `DETECTED` verdict was no evidence a lever was sound — it could
equally have been a stale lever riding an unrelated failure. All 18 were
classified empirically against the schema fingerprint before any edit: 12
effective, 6 no-ops, none ambiguous, none failing to apply. That matched the
hand analysis exactly.

---

## 3. How detection works now

Three gates, in order, each answering a different question.

**Pre-flight: the baseline must be green.** The suite is run once, unmutated,
before anything is graded. If any test is already failing the runner prints
`REFUSING TO RUN`, lists the offending tests, and exits 1. Every verdict it
produces is "did the expected assertion fail", which means nothing while
something else is failing too. This is the guard that the `a5cf0fd` worktree
needed.

**Per lever, question 1 — does this reach the schema?**
`scripts/schema-fingerprint.mjs` builds the schema from a migrations directory
using the same shim and the same file order as `tests/db/harness.ts`, then
describes its authorization surface:

- every `public` function, by `pg_get_functiondef`, with its SECURITY DEFINER
  flag, volatility and `search_path`;
- every row-level policy, by table, command, roles, `qual` and `with_check`;
- RLS enabled/forced per relation;
- table and column privileges for `anon`, `authenticated`, `PUBLIC`;
- EXECUTE privileges for `anon` and `authenticated`.

Every probe is explicitly ordered, and the result is hashed per section and
overall. If the mutated fingerprint equals the baseline, the mutation changed
nothing anywhere and is reported **`INEFFECTIVE`** — a broken lever, not a
missing test. Keeping those two verdicts apart is the point: the old harness
conflated them and sent the reader to the wrong file.

**Per lever, question 2 — did the right assertion fail?** The suite runs with
`--reporter=json --outputFile=…`; the runner walks `testResults[].
assertionResults[]`, collects the titles of assertions whose `status` is
`failed`, and requires that one of them contains the lever's `expect` string.
Nothing is parsed out of human-readable output.

**Anchors must match exactly once.** Zero matches is `BROKEN ANCHOR`; two or
more is refused with *"narrow it"*. `String.replace` takes the first match, so
an ambiguous anchor silently mutates whichever occurrence comes first — which,
in 0025, is the wrong function.

Each `DETECTED` line now records both halves of the proof:

```
DETECTED       requests: drop the self-friending guard
               caught by "refuses self-friending" (changed functions)
```

---

## 4. Evidence that a false positive is prevented

**Demonstrated end to end.** A single unrelated failing test was added
(`bundles the manifest into dist/`, standing in for the missing-`dist/`
scenario) and the gate re-run:

```
Baseline: building the schema and running the suite unmutated...
REFUSING TO RUN: the suite is already red before any mutation.
  - bundles the manifest into dist/
EXIT=1
```

The old harness, in that exact state, reported **18/18 and exit 0**. The
temporary test was then removed.

**Guarded permanently** by `tests/extension/authzHarness.test.ts`, 28 tests that
run on every `npm test`:

| property | how |
|---|---|
| an unrelated failure cannot green-wash a lever | the detection predicate is exercised on a report where the expected test **passed** and two others failed → not detected. The same fixture asserts the *old* rule would have said yes: `expect(JSON.stringify(report)).toContain('refuses self-friending')` |
| a lever counts only on its own assertion | a report where the expected assertion failed → detected |
| a mutation breaking several tests still counts | expected assertion among several failures → detected |
| near-miss names do not count | a **passing** test titled `refuses self-friending twice` → not detected |
| a no-op mutation cannot count as detected | the real stale edit — removing the self-friending guard from `0003` — produces an identical fingerprint and empty `changedSections` |
| a real weakening is detected | the same guard removed from `0039` changes the `functions` section and the overall digest |
| **every shipped lever changes the schema it claims to weaken** | all 18 applied and fingerprinted; `ineffective` must be `[]` |
| anchors resolve to exactly one place | per-lever, all 18 |
| levers name migrations that exist | checked against the directory |
| the refusal and the JSON reporter are still wired in | source assertions, with comments stripped first so the quoted anti-patterns do not self-match |

The whole-lever effectiveness test rebuilds the schema 19 times and is the
slowest test in the repository. It lives in `npm test` rather than only in the
gate on purpose: the gate is easy to skip locally, and this is the check that
stops Class A recurring the next time a migration supersedes an older
definition.

---

## 5. Final gate results

| gate | result |
|---|---|
| `npm run test:authz` | **18/18 detected, exit 0**, from a verified-green baseline (3,294 tests, schema `344c21dc1589`) |
| `tests/db/authorizationSurface` | **10/10** |
| `tests/extension/authzHarness` | **28/28** (new) |
| `npm test` | **3,294 passing, 138 files, 0 failing** |
| `npm run typecheck` | clean |
| `npm run lint` | clean |
| `npm run test:destruction` | **all 109 mutations detected, exit 0** |
| `npm run build` | ok |
| `npm run verify:store` | pass |
| `npm run verify:firefox` | pass, reproducible |
| `npm run verify:candidate` | pass — 13 markers, 0 forbidden |
| `npx web-ext lint` | **0 errors**, 3 warnings — the same three the public v0.8 has |

Test count moved 3,266 → 3,294: the 28 harness tests.

---

## 6. Commit

```
1c1ef73  fix(security): the authorization gate was grading the wrong thing, twice
```

Files: `scripts/verify-authorization-tests.mjs` (levers repointed, detection
rewritten), `scripts/schema-fingerprint.mjs` (new),
`tests/extension/authzHarness.test.ts` (new), `tests/db/supabaseShim.mjs` +
`.d.mts` (new — the Supabase shim extracted so the fingerprint tool and the test
harness cannot drift), `tests/db/harness.ts` (imports the shared shim).

Nothing under `src/` and nothing under `supabase/` changed.

---

## 7. Fresh v0.9.0 RC artifacts

The `7b47914` artifacts are superseded.

| artifact | bytes | SHA-256 |
|---|---:|---|
| `Watchside-Store-v0.9.0.zip` | 187,557 | `05a5974037316857eedb1aec5afd25832a803a678114f684f7a10a7ab414de67` |
| `Watchside-Private-Beta-v0.9.0.zip` | 189,407 | `7cf89694aa0b514d6ad36f1a8e996c1a51822749654460fea03b8dfd01762a2e` |
| `Watchside-AMO-Candidate-v0.9.0.zip` | 187,570 | `407bb52cb8816be9aebcd9953271dae139c5bcc8a94edd0ce8528527bbb4c41c` |
| `Watchside-AMO-Source-v0.9.0.zip` | 1,276,245 | `717a5be64a7945947e7fa2e366bb61feccb35b19efe2fe7d70f7d2f12ff19444` |

**The AMO candidate hash is byte-identical to the `7b47914` build**, and that is
not a coincidence worth glossing over — it is the proof that this work did not
touch the shipped extension. `package-firefox.mjs` pins a deterministic date, so
identical input gives an identical archive.

**A note on the other two, so nobody reads their new hashes as a code change.**
`package-beta.mjs` stamps `new Date()` into the ZIP entries, so the Store and
Private Beta archives hash differently on **every** build. Verified directly:
two consecutive builds from identical source produced `bbb0b14c…` and
`50de3429…`. Their byte sizes are unchanged from the previous build. The AMO
source archive legitimately grew — it carries the repository, which now has four
more files.

Minor, out of scope, worth recording: two of the four release artifacts are not
reproducible. Pinning the same deterministic date in `package-beta.mjs` would
fix it.

---

## 8. Schema version

**43.** Unchanged. 43 migration files, `git status supabase/` empty.

Stronger than a file count: the schema fingerprint taken after this work,
`344c21dc1589476a8a627ee5a99051ec587d4ae784090647f7e0cbb45d8e5e24`, is identical
to the one taken before it. Every function body, policy expression, RLS flag,
grant and EXECUTE privilege is byte-for-byte what it was. Migration 0043's
protections are intact by the same evidence, and `authorizationSurface` remains
10/10.

---

## 9. v0.8 artifacts

Untouched, verified with `sha256sum -c` against hashes recorded before any build
in this session:

```
Watchside-AMO-Candidate-v0.8.0.zip: OK
Watchside-AMO-Source-v0.8.0.zip:    OK
Watchside-Firefox-v0.8.0.zip:       OK
Watchside-Store-v0.8.0.zip:         OK
```

---

## 10. Recommendation

### PUSH

Ten commits: the nine from the beta-feedback and accessibility pass, plus
`1c1ef73`.

The reason the previous report stopped short of this is now resolved. That
report recommended fixing the harness *before* anything shipped, on the grounds
that a red security gate should not be walked past — and the gate is now green
for the right reason rather than by being quieted. The distinction matters, so
to state it plainly: no assertion was weakened, no lever was removed, no
migration was written, and the schema the tests run against is provably
identical to before. What changed is that the harness now measures what it
claims to measure, and refuses to answer when it cannot.

Two things remain owner-gated and are unchanged by this work:

1. **Deploy the `twitch-metadata` edge function.** Committed, not deployed. It
   calls `sweep_twitch_metadata_cache`, which is what satisfies the DSA's
   24-hour cache limit. This is the G7 item.
2. **Submitting v0.9.0 to Chrome and Firefox.** Not done, and not implied by
   this recommendation.

One thing found along the way and deliberately not fixed: the Store and Private
Beta archives are not reproducible (§7). It is cosmetic next to everything above
and did not belong in a security-infrastructure commit.
