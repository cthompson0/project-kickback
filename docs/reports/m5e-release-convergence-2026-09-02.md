# M5E — Release convergence and distributed-measurement acceptance

**Date:** 2026-09-02
**Branch:** main
**Candidate:** **v0.8.0**
**Schema:** 38 (unchanged)
**Preceded by:** M5D — public product closure

---

## 1. Executive verdict

**★ GO for the candidate. Chrome: PULL THE TRIGGER. Firefox: KEEP WAITING.**

The converged v0.8.0 release candidate is built, verified to carry M3D + M5A +
M5B + M5C + M5D, and proven not to strand the builds people are running today.
Every deterministic gate passes.

Two things did **not** happen, and both are honest limits rather than failures:

**The live acceptance runs could not be executed here.** `verify:m3d` needs
`WATCHSIDE_ADMIN_TOKEN` — an owner-only diagnostic secret deliberately kept out
of the repository — and `scripts/firefox-e2e/seeds.json`, the canonical seed
browser profiles. Neither is present in this environment. The harness refused to
start rather than degrade, which is exactly what it was built to do. §5 says
precisely what it would take.

**watchside.app still has no certificate**, hours past GitHub's documented
window and with GitHub itself reporting both hosts `is_valid: true`,
`caa_error: null`, `is_https_eligible: true`. Issuance is queued, not refused. I
requested a fresh Pages build; it changed nothing. **DNS was not touched.**

The important consequence is narrower than it looks: **the candidate does not
depend on the domain.** M5B deliberately left `INVITE_LANDING_BASE` pointing at
the live Pages route, and the extension never resolves `watchside.app` at all.
So the URL flip does not happen in this release, and it does not need to.

The one thing TLS does gate is M5C's live path, and that turns out to be sharper
than previously recorded — see §6.

---

## 2. The frozen source state

No tags exist in this repository. `releases/` is gitignored with the comment
*"a release is reproducible from a tag plus the script"* — an intent that was
never carried out. The brief says not to invent a tag convention without
inspecting existing history; history has none, so **no tag was invented**. The
candidate is identified by its commit and by artifact hashes instead, which is
the traceability that actually matters.

**Version 0.8.0.** History runs 0.4.0 → 0.4.1 → 0.5.0 → 0.6.0 → 0.7.0: minor
bumps per feature release, patch for a fix. This release carries M3D and four
milestones of product work, so it is a minor bump. `package.json` and
`public/manifest.json` both moved, and `releaseVersion.test.tsx` already
enforced that they agree and that the changelog has a matching entry.

---

## 3. watchside.app

**Still provisioning. Not usable.**

| | |
| --- | --- |
| DNS | correct at public and authoritative resolvers |
| `watchside.app` | `is_valid: true`, `is_served_by_pages: true`, `caa_error: null`, **`is_https_eligible: true`** |
| `www.watchside.app` | same |
| certificate | **none**, after a fresh Pages build was requested |
| `https://watchside.app/` | `ERR_TLS_CERT_ALTNAME_INVALID` |

That error is a small change from M5D's outright handshake failure: a
certificate is now being presented at those addresses, but it is GitHub's own —
none has been issued for this domain. Nothing in the configuration is wrong, and
nothing here can make GitHub issue faster.

**Compatibility routes are unaffected and still 200:** `/watchside/`,
`/watchside/support/`, `/watchside/invite/`, `/watchside/privacy/`,
`/kickback/invite/`.

**No URL flip.** The production constants stay on the Pages URLs, which is what
M5B planned for exactly this case. Shipping a build that pointed at an unusable
`.app` domain would have been the one genuinely unsafe thing available here —
`.app` is HSTS-preloaded, so a browser refuses plain HTTP and every invite would
be dead.

---

## 4. What the candidate contains

`npm run verify:candidate` unpacks the built packages and asserts the presence of
thirteen load-bearing string markers and the absence of five forbidden ones.

The reason this exists at all is the defining fact of the last three milestones:
**M3D was finished before 0.7.0 shipped and 0.7.0 does not contain it.** "It is
on main" and "it is in the build" are different claims and only one of them
reaches a user. Nothing had ever checked the artifact.

| System | Verified in both packages |
| --- | --- |
| M3D | `user:read:follows`, `twitch-credential`, `join_measurement_status`, `grantFollowPermission` |
| M5A | `friend_suggestion_impression`, `referral_succeeded` |
| M5B | `watchside/support` |
| M5C | `watchside_campaign`, `bind_acquisition`, `watchside:campaignTouch` |
| M5D | `automatic_room_opened`, `complementary` |
| compat | `kickback_invite` |

Absent, as required: `user:read:subscriptions`, `user:read:emotes`,
`SUPABASE_SERVICE_ROLE`, `service_role`, `sourceMappingURL`.

String presence is coarse and it is the right coarseness: minification renames
identifiers but never string literals, so a scope, a wire parameter, an RPC name
or a storage key survives the bundler exactly. It cannot prove the surrounding
code is correct — that is what 3,016 tests are for — but it is the only thing
that can prove the code *shipped*.

A first version of this check looked for `record_relationship` and reported M3D
absent from a package that contains it. M3D's measurement goes through the
`twitch-credential` Edge Function, not an RPC. Every marker above was verified
to exist in source before being asserted against the artifact.

---

## 5. M3D — what was proven, and what was not

**Not run. The harness refused to start, correctly.**

```
$ npm run verify:m3d
WATCHSIDE_ADMIN_TOKEN is not set.
```

It needs two owner-held things, neither of which is a repository artifact and
neither of which should be:

1. **`WATCHSIDE_ADMIN_TOKEN`** — the owner-only diagnostic token
   (`TWITCH_EVENTSUB_ADMIN_TOKEN` in Supabase Function secrets).
2. **`scripts/firefox-e2e/seeds.json`** — the two canonical seed browser
   profiles, bootstrapped by the owner during M3D Slice D.

Supabase URL and publishable key are present in `.env.local`; only these two are
missing.

**This is not the harness failing; it is the harness working.** It was built
after two real human JOINs were spent discovering setup state, and exit code 2
means *precondition not met, nothing spent*. Degrading to a partial run would
have produced exactly the false confidence it exists to prevent.

**What IS proven about M3D in this candidate:**

- the scope policy: `user:read:follows` present, both held scopes absent from
  the packaged bundle;
- credential custody: `stripProviderCredentials` is in the storage path, so
  provider tokens are removed from browser storage on read as well as write;
- the measurement machinery ships (§4);
- the whole server half, against real Postgres, in the existing DB suites.

**What is NOT proven:** that a real JOIN by a real credentialed account, from
this build, produces a follow observation. That requires the two items above and
is the single largest gap in this milestone. It is stated plainly rather than
inferred from the development acceptance that passed in M3D.

---

## 6. M5C — and a sharper limit than previously recorded

Same shape: the DB half is proven against real Postgres (43 tests), the client
half by unit tests and by presence in the candidate, and the live browser
round-trip needs the same owner-held prerequisites.

**But M5C has a second gate that M5D under-stated.**

Campaign links exist at `watchside.app/c/<code>` and **nowhere else**. The
subpath build deliberately excludes `/c/` for the same reason it excludes `/i/`
and `404.html`: those routes are served by the 404 handler, which only works
from a domain root. Confirmed —
`anoteros-labs.github.io/watchside/c/test-code` returns 404.

So **M5C cannot capture anything until watchside.app serves HTTPS**, even from a
fully distributed build. There is no campaign link to publish.

That is not an argument against shipping. The client half has to be in a
distributed build *before* the first campaign link is ever published, or the
first campaign measures nothing — which is precisely the mistake M3D made. **The
right order is: ship the client, then get TLS, then mint campaigns.** This
release does the first, and does not need to wait for the third.

The M5C coverage limitation is unchanged and was not "fixed": click → Store view
→ install remains unobservable without cross-site tracking, and none was added.
No pixels, no fingerprinting, no third-party analytics.

---

## 7. Released-client compatibility

**Proven against the actual shipped ZIPs**, not against source, by a new
`npm run verify:released`.

Six migrations have landed since 0.7.0 shipped — 0033 through 0038 — while
Chrome 0.7 has been live and Firefox 0.6 has been queued at AMO. Additive-only
was argued in every migration header and checked by nobody.

| | Chrome 0.7.0 (live) | Firefox 0.6.0 (queued) |
| --- | --- | --- |
| RPCs it calls, still defined | **15/15** | **15/15** |
| still granted to `authenticated` | ✓ | ✓ |
| Edge Functions still present | 1/1 | 1/1 |
| analytics registry append-only | ✓ 61 names, none removed | ✓ |

Source tells you what HEAD calls; only the artifact tells you what a person on
0.7 calls, and those diverge the moment a call site is deleted.

Two findings during construction were **my own false positives**, and both are
recorded because the fix matters more than the finding:

- `stream_room_members` reported missing — the detector required
  `create or replace function` and 0020 declares it as `create function`.
- Four "unregistered event names" — `post_social_ended`, `session_ended`,
  `stream_ended`, `request_sent` — are internal discriminators and enum members,
  not events. Minified bundles cannot be read by guessing which quoted strings
  are event names.

The analytics check was rewritten to assert the property that actually matters:
**the event registry is only ever appended to.** `analytics_track` skips unknown
names rather than rejecting the batch, so a deletion would not break an old
client — it would silently stop recording, and the gap would surface weeks later
as a funnel that thinned for no reason. If nothing is ever removed, every name
any released client emits is still registered by construction.

---

## 8. Packaging

| Artifact | SHA-256 |
| --- | --- |
| `Watchside-Store-v0.8.0.zip` | `cb3af261448280cb33866a4b466fa186dd2bdc691db31e0116766e5ee15e19a0` |
| `Watchside-AMO-Candidate-v0.8.0.zip` | `acef1c34e629c30a2cf8c2fc188766f15c2826565ac1f272b94594d47decda9c` |
| `Watchside-AMO-Source-v0.8.0.zip` | `580f33ea52255411fa5d1d2f8ff3be7aeebeb372a1f3d5b76e23f61391885da0` |
| `Watchside-Firefox-v0.8.0.zip` (dev) | `acef1c34e629c30a2cf8c2fc188766f15c2826565ac1f272b94594d47decda9c` |

No prior artifact was overwritten; `releases/` retains every previous version.
The Firefox development package and the AMO candidate share a hash, which is the
byte-reproducibility requirement holding: two builds of the same source produce
identical archives.

`verify:store`, `verify:firefox` and `verify:candidate` all pass. The source
archive documents the candidate it was built from, by hash.

**One stale-branding defect found and fixed here.** The private-beta tester
README embedded in `Watchside-Private-Beta-v*.zip` still opened with
`KICKBACK - PRIVATE BETA`. M5D's branding scan covered `src/`, `public/` and
`docs/web/` but not `scripts/`, and this string is generated at package time.
It is human-facing and shipped in an artifact, so it was a real defect.

---

## 9. OAuth scopes

Locked policy, verified against the packaged bundle rather than the source:

- `user:read:follows` — **present**
- `user:read:subscriptions` — **absent**
- `user:read:emotes` — **absent**

The only occurrence of a held scope anywhere in the tree is inside a mutation
lever, which exists to prove that adding one would be caught. `REQUESTED_SCOPES`
is a single list feeding both first-time sign-in and the retro-fit grant path, so
the two cannot drift.

---

## 10. Privacy and Store disclosure

`docs/PRIVACY.md` is accurate for the candidate and was last changed in M5C, in
the same commit that added the collection it describes. It covers viewing time,
the Twitch authorisation, the one check made at a social JOIN, and campaign
attribution in plain language, plus an explicit denial of third-party analytics.

**Disclosure changes the next submission needs** — owner actions on the Store
forms, not repository work:

| Store | Change | Why |
| --- | --- | --- |
| Chrome | Confirm the permission justification covers `user:read:follows` | First release where 0.7's live listing does not describe it. M3D is new to users. |
| Chrome | Data-use disclosure: "website activity" already declared; **no new category** | Acquisition attribution is a Watchside-issued campaign code, not personal data or web history. |
| Firefox | No change | 0.6 is queued and 0.8 would supersede it; the data-collection answers already cover website activity, and Firefox collects no technical/interaction data. |

**No under-disclosure and no over-disclosure.** Nothing collects a new category;
what changed is that a scope the live listing never mentioned is now exercised.

---

## 11. Measurement readiness

The four states kept distinct, as required:

| System | State |
| --- | --- |
| Viewing-time dwell | **DISTRIBUTED** (0.7.0) · OBSERVED IN PRODUCTION |
| Gravity / JOIN / arrival / referral outcomes | **DISTRIBUTED** · OBSERVED IN PRODUCTION |
| Room open (M5D) | ACCEPTED IN RC · not distributed |
| **M3D** creator-follow baseline | **IMPLEMENTED**, in RC · **live acceptance NOT run** (§5) |
| **M5C** acquisition attribution | **IMPLEMENTED**, in RC · not distributed · **and domain-gated** (§6) |

**Neither M3D nor M5C has production data, and passing acceptance tests would
not make that true.** What this release does is put both where they can begin.

---

## 12. Public-product regressions

The M5D fixes are present in the candidate and covered: `humanMessage` on
eighteen surfaces with a source scan preventing regression, the `complementary`
landmark, tab state, the contrast fixes and the deep accent behind text, the
zero-friend and idle states, the support route, badges, the Groups distinction,
notification semantics, and `automatic_room_opened`.

---

## 13. Tests and gates

| Gate | Result |
| --- | --- |
| deterministic suite | **3,016 passed / 120 files** |
| lint | clean |
| `npm run typecheck` (`tsc -b`) | clean |
| production build | clean |
| `verify:store` | clean |
| `verify:firefox` | clean, reproducible |
| `verify:candidate` | **new** — both packages carry M3D + M5A–M5D |
| `verify:released` | **new** — Chrome 0.7 and Firefox 0.6 uncompromised |
| `verify:m3d` | **not run** — owner credentials absent (§5) |
| mutations | not re-run — **no covered source semantics changed in M5E** |

M5E changed `package.json`, `public/manifest.json`, `CHANGELOG.md`,
`scripts/package-beta.mjs` (the tester README), two test output directories, and
added two verification scripts. No `src/` file changed, so the 85 destruction
levers cover exactly what they covered at M5D.

**One real defect fixed in the test suite.** `publicRouting.test.ts` and
`pagesArtifact.test.ts` both built into `dist-pages`, and vitest runs them in
parallel workers — so they raced on one directory and the loser saw a
half-deleted tree. Intermittent since M5B, and it surfaced here. Each now builds
into its own directory. A build target is not a shared resource.

Known debt unchanged and re-accepted: analytics 6/87 undetected, lab 11.

---

## 14. Store decisions

External state is owner-confirmed: **Chrome 0.7 live with nothing pending;
Firefox 0.6 awaiting its first AMO review; Firefox 0.7 packaged, not submitted.**

### Chrome — PULL THE TRIGGER

The argument that held through M5B, M5C and M5D was "there is a pending review to
protect". There is not any more, and the reasons to move are now stronger than
the reasons to wait:

- **0.7 users see raw error text today.** M5D found eighteen surfaces showing
  `TypeError: Failed to fetch` and worse. That is the closest thing to a
  user-facing defect in the product, and it is fixed only in 0.8.
- **M3D cannot begin until it is distributed.** It has been finished and
  measuring nobody since before 0.7 shipped. Every week it stays undistributed
  is a week of creator-discovery evidence not collected.
- **M5C must precede the first campaign link**, or the first campaign measures
  nothing.
- The accessibility and contrast fixes are real and affect people who cannot
  read low-contrast text today.

**The caveat, stated rather than buried:** M3D's live acceptance has not been
run from this candidate (§5). The scope, custody and machinery are verified to
ship; what is unverified is one real end-to-end JOIN. If the owner wants that
before submission, it is one command away once the token and seeds are supplied,
and §16 says exactly how. **My recommendation is to run it first if it is cheap,
and to submit regardless if it is not** — because the failure mode of shipping
unverified M3D is "the measurement does not work and we find out", while the
failure mode of not shipping is "nothing is measured at all, indefinitely",
which is the situation we have been in for three milestones.

### Firefox — KEEP WAITING

Unchanged, and easy. 0.6 is still awaiting its **first** review, which is the
slowest and most scrutinised an add-on ever gets. Replacing it now resets that
queue position, and nothing publicly released on Firefox is affected because
nothing is publicly released on Firefox.

The 0.8.0 AMO candidate and its source archive are built and verified, so if
Mozilla acts on 0.6 — approval or rejection — the replacement is ready the same
day. **Reassess the moment 0.6's state changes.**

---

## 15. Marketing gate

**WAITING FOR DISTRIBUTION**, and now with a second condition.

Even after 0.8.0 is live, campaign spend needs:

1. the build actually installed and running, and
2. **watchside.app serving HTTPS**, because campaign links exist nowhere else
   (§6), and
3. one production sanity check that a real touch binds.

Organic beta activity continues unaffected.

---

## 16. Remaining blockers and owner actions

| | Item | Who |
| --- | --- | --- |
| 1 | **Chrome submission** — upload `Watchside-Store-v0.8.0.zip` | owner |
| 2 | **M3D live acceptance** — set `WATCHSIDE_ADMIN_TOKEN` and restore `scripts/firefox-e2e/seeds.json`, then `npm run verify:m3d` | owner supplies; automated after that |
| 3 | **watchside.app TLS** — GitHub's to issue; nothing to do, do not touch DNS | external |
| 4 | Chrome listing: confirm the `user:read:follows` justification (§10) | owner |
| 5 | Store screenshots and promo tile | owner, Store Assets step |

Item 2 is a credential hand-off, not manual QA: no human generates a JOIN, the
harness does.

**Store assets** were inspected and are not objectively misleading — the panel's
structure, tabs and primary flow are unchanged; what changed is contrast, copy
and semantics. They remain the next dedicated step rather than an M5E blocker.

**Screen-reader acceptance** (M5D's one human item) is **not release-blocking**.
Everything decidable by machine is decided and regression-covered: names, labels,
focus order, exposed state, landmark, contrast ratios. What a person adds is
whether the announcements read sensibly in sequence — a quality judgement, and
appropriate as a public-beta follow-up rather than a gate on a build that fixes
real accessibility defects present in the live version.

---

## 17. Verdict

**★ GO** for the candidate, with the M3D live-acceptance gap named rather than
papered over.

The thing worth carrying forward: **M5E's most valuable output is not the
package, it is the two verification scripts.** `verify:candidate` and
`verify:released` close the exact hole that made the last three milestones
necessary — nobody had ever checked what the artifact contained, or whether the
backend had drifted away from the artifact people were running. Both questions
had confident answers in prose and no answer in evidence.

**Next:** Chrome submission, then Store Assets. Not M6.
