/**
 * Mutation check for the destruction paths.
 *
 * Phase 1 builds the ways of destroying a Twitch credential before any exists.
 * The risk with proving a deletion path against empty tables is that the proof
 * is vacuous - tests that pass because nothing happened, rather than because
 * the right thing happened.
 *
 * So each mutation below breaks one load-bearing guarantee and the suite must
 * notice. The interesting ones are the asymmetries: a Twitch deauthorization
 * must NOT take Watchside's analytics, account deletion MUST, and a dropped
 * EventSub subscription must delete nothing at all.
 *
 *   npm run test:destruction
 */
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { execFileSync } from 'node:child_process'
import { pathToFileURL } from 'node:url'

const VERIFY = 'supabase/functions/twitch-eventsub/verify.ts'
const RELATIONSHIP = 'supabase/functions/twitch-credential/relationship.ts'
const M3D_TWITCH = 'supabase/functions/twitch-credential/twitch.ts'
const M3D_MIGRATION = 'supabase/migrations/0033_m3d_relationship.sql'
const BINDING_SUITE = 'tests/extension/relationshipBinding.test.ts'
const BASELINE_SUITE = 'tests/extension/followBaseline.test.ts'
const M3D_DB_SUITE = 'tests/db/relationshipObservation.test.ts'
const AUTH = 'src/background/auth.ts'
const ACCOUNT_UI = 'src/ui/components/AuthStates.tsx'
const PERMISSION_SUITE = 'tests/extension/followPermission.test.tsx'
const MIGRATION = 'supabase/migrations/0032_destruction_paths.sql'
const STORAGE = 'src/background/storage.ts'

const HUB = 'src/background/analyticsHub.ts'
const RECORDER = 'src/background/analytics.ts'
const RECORDER_SUITE = 'tests/extension/analyticsRecorder.test.ts'
const BACKEND = 'src/background/supabaseBackend.ts'
const TRIGGER_SUITE = 'tests/extension/joinRelationshipTrigger.test.ts'
const PRIVACY = 'docs/PRIVACY.md'
const PRECONDITIONS = 'scripts/m3d-acceptance/preconditions.mjs'
const PRECONDITION_SUITE = 'tests/extension/acceptancePreconditions.test.ts'
const COVERAGE_MIGRATION = 'supabase/migrations/0034_m3d_coverage.sql'
const COHORT_MIGRATION = 'supabase/migrations/0035_m3d_small_cohort.sql'
const NUMERATOR_MIGRATION = 'supabase/migrations/0036_m3d_coverage_numerator.sql'
const COVERAGE_SUITE = 'tests/db/m3dCoverage.test.ts'
const GROWTH_MIGRATION = 'supabase/migrations/0037_growth_outcome_events.sql'
const GROWTH_SUITE = 'tests/db/growthOutcomes.test.ts'
const GROW_UI = 'src/ui/components/GrowFriends.tsx'
const AUTH_UI = 'src/ui/components/AuthStates.tsx'
const GRAVITY_UI = 'src/ui/components/SocialGravity.tsx'
const ZERO_SUITE = 'tests/extension/zeroFriendLoop.test.tsx'
const SUGGEST_SUITE = 'tests/dom/friendSuggestions.test.tsx'
const SITE_404 = 'docs/web/watchside-app/pages/404.html'
const SITE_ROOT = 'docs/web/watchside-app/pages/index.html'
const ROUTING_SUITE = 'tests/extension/publicRouting.test.ts'
const INVITES = 'src/core/invites.ts'
const SHELF = 'src/ui/components/BadgeShelf.tsx'
const COMPREHENSION_SUITE = 'tests/dom/productComprehension.test.tsx'
const ACQUISITION = 'src/core/acquisition.ts'
const ACQ_MIGRATION = 'supabase/migrations/0038_acquisition_attribution.sql'
const ACQ_SUITE = 'tests/extension/acquisition.test.ts'
const ACQ_DB_SUITE = 'tests/db/acquisition.test.ts'

const EVENTSUB_SUITE = 'tests/extension/eventsubVerification.test.ts'
const DB_SUITE = 'tests/db/destructionPaths.test.ts'
const O7_SUITE = 'tests/extension/providerCredentialStripping.test.ts'

const REPORT = join(tmpdir(), 'watchside-destruction-mutations.json')

const MUTATIONS = [
  // ------------------------------------------------------------ EventSub
  {
    // A forged request becomes acceptable. This is the whole authentication
    // story for the receiver: without it, anyone who knows the URL can delete.
    name: 'eventsub: accept any signature',
    file: VERIFY,
    suite: EVENTSUB_SUITE,
    from: '  if (!timingSafeEqual(expected, signature)) {',
    to: '  if (false) {',
    expect: 'rejects a wrong signature',
  },
  {
    // Comparison that short-circuits on the first wrong character.
    name: 'eventsub: compare signatures with early exit',
    file: VERIFY,
    suite: EVENTSUB_SUITE,
    from: `  if (a.length !== b.length) return false
  let mismatch = 0
  for (let i = 0; i < a.length; i += 1) mismatch |= a.charCodeAt(i) ^ b.charCodeAt(i)
  return mismatch === 0`,
    to: '  return a === b',
    expect: 'compares without revealing how much of the signature was right',
  },
  {
    // Replay: an old delivery, still validly signed, becomes acceptable.
    name: 'eventsub: stop checking freshness',
    file: VERIFY,
    suite: EVENTSUB_SUITE,
    from: '  if (!isFresh(timestamp, input.now)) {',
    to: '  if (false) {',
    expect: 'rejects a delivery older than the tolerance',
  },
  {
    // THE TRAP. Twitch dropping our subscription gets treated as a user
    // revoking authorization, so an expired subscription deletes user data.
    name: 'eventsub: treat a dropped subscription as a user revocation',
    file: VERIFY,
    suite: EVENTSUB_SUITE,
    from: `  if (messageType === MESSAGE_TYPE.revocation) {
    return { kind: 'subscription_dropped' }
  }`,
    to: '',
    expect: 'NEVER purges on a Message-Type of revocation',
  },
  {
    // Identity falls back to the login, which is null exactly when an account
    // was deleted - one of the situations that produces a revocation.
    name: 'eventsub: fall back from user_id to user_login',
    file: VERIFY,
    suite: EVENTSUB_SUITE,
    from: `  const twitchUserId = event.user_id`,
    to: `  const twitchUserId = event.user_id ?? event.user_login`,
    expect: 'refuses to act when user_id is missing, rather than guessing from the login',
  },

  // ------------------------------------------------------------ deletion
  {
    // The asymmetry, broken: a Twitch deauthorization also destroys
    // Watchside's own analytics.
    name: 'purge: also delete Watchside analytics on Twitch deauth',
    file: MIGRATION,
    suite: DB_SUITE,
    from: `  delete from public.creator_relationship_observations where actor_id = p_actor;
  get diagnostics v_observations = row_count;`,
    to: `  delete from public.creator_relationship_observations where actor_id = p_actor;
  get diagnostics v_observations = row_count;
  delete from public.analytics_events where actor_id = p_actor;`,
    expect: 'PRESERVES the actor',
  },
  {
    // Cross-user deletion: the purge ignores which actor it was asked about.
    name: 'purge: delete every actor rather than the named one',
    file: MIGRATION,
    suite: DB_SUITE,
    from: '  delete from public.twitch_credentials where actor_id = p_actor;',
    to: '  delete from public.twitch_credentials where true;',
    expect: 'leaves the other actor completely untouched',
  },
  {
    // A null actor - an unresolved Twitch id - becomes a delete-everything.
    name: 'purge: treat an unresolved actor as "all actors"',
    file: MIGRATION,
    suite: DB_SUITE,
    from: `  if p_actor is null then
    return jsonb_build_object('credentials', 0, 'observations', 0, 'actor', false);
  end if;`,
    to: '',
    expect: 'does nothing at all for a null actor',
  },
  {
    // The credential table becomes client-readable. A bare GRANT is not enough
    // to defeat RLS-with-no-policies, so this adds the permissive policy too -
    // which is what an accidental "make it work" change actually looks like.
    name: 'credentials: give clients a permissive read policy',
    file: MIGRATION,
    suite: DB_SUITE,
    from: 'grant select, insert, update, delete on table public.twitch_credentials to service_role;',
    to: `grant select, insert, update, delete on table public.twitch_credentials to service_role;
grant select on table public.twitch_credentials to authenticated;
create policy twitch_credentials_read on public.twitch_credentials
  for select to authenticated using (true);`,
    expect: 'refuses SELECT from an authenticated client',
  },
  {
    // A failed follow check would become "did not follow" instead of "unknown".
    name: 'observations: default relationship_present to false',
    file: MIGRATION,
    suite: DB_SUITE,
    from: '  relationship_present boolean\n',
    to: '  relationship_present boolean not null default false\n',
    expect: 'records a failed check as absent rather than false',
  },

  // ------------------------------------------------------------------ M3D
  {
    // The failure that would poison every downstream number: a Twitch outage
    // recorded as "did not follow".
    name: 'm3d: treat a failed lookup as not-following',
    file: M3D_TWITCH,
    suite: BASELINE_SUITE,
    from: `  if (!Array.isArray(body.data)) return { ok: false, reason: 'twitch_unavailable' }
  return { ok: true, following: body.data.length > 0 }`,
    to: `  return { ok: true, following: Array.isArray(body.data) && body.data.length > 0 }`,
    expect: 'treats a malformed response as unavailable, never as false',
  },
  {
    // The mirror image: a real "not following" thrown away as an error.
    name: 'm3d: treat an empty result as unavailable',
    file: M3D_TWITCH,
    suite: BASELINE_SUITE,
    from: `  return { ok: true, following: body.data.length > 0 }`,
    to: `  if (body.data.length === 0) return { ok: false, reason: 'twitch_unavailable' }
  return { ok: true, following: true }`,
    expect: 'reads an empty array as a genuine "not following"',
  },
  {
    // An existing user whose credential predates the permission gets told they
    // are broken, which is untrue and loses the state the UX needs.
    name: 'm3d: collapse needs_follow_permission into needs_reauthorization',
    file: M3D_TWITCH,
    suite: BASELINE_SUITE,
    from: `  if (!hasFollowsScope(input.scopes)) return 'needs_follow_permission'`,
    to: `  if (!hasFollowsScope(input.scopes)) return 'needs_reauthorization'`,
    expect: 'distinguishes "never granted the follow permission" from "broken"',
  },
  {
    // The forgery: quote a real JOIN of your own, name any creator you like.
    name: 'm3d: stop binding the creator to the attribution',
    file: RELATIONSHIP,
    suite: BINDING_SUITE,
    from: `  if (join.destinationChannel !== broadcasterLogin) {
    return { ok: false, reason: 'destination_mismatch' }
  }`,
    to: '',
    expect: 'refuses a creator the JOIN was not aimed at',
  },
  {
    // Silently turns following_at_join into following_some_time_later.
    name: 'm3d: drop the baseline window',
    file: RELATIONSHIP,
    suite: BINDING_SUITE,
    from: `  if (now - clickedAt > windowMs || clickedAt - now > windowMs) {
    return { ok: false, reason: 'outside_baseline_window' }
  }`,
    to: '',
    expect: 'refuses a JOIN too old to still be the baseline',
  },
  {
    name: 'm3d: measure JOINs nobody else was part of',
    file: RELATIONSHIP,
    suite: BINDING_SUITE,
    from: `  if (!(join.socialCount > 0)) return { ok: false, reason: 'not_socially_initiated' }`,
    to: '',
    expect: 'refuses a JOIN nobody else was part of',
  },
  {
    // The boundary this whole action exists for.
    name: 'm3d: return the follow result to the client',
    file: RELATIONSHIP,
    suite: BINDING_SUITE,
    from: `  return result.state === 'recorded'
    ? { state: 'recorded' }
    : { state: 'unavailable', reason: result.reason }`,
    to: `  return result.state === 'recorded'
    ? { state: 'recorded', following: true }
    : { state: 'unavailable', reason: result.reason }`,
    expect: 'carries no relationship field in any shape',
  },
  {
    // A retry could then record a second, possibly contradictory, answer.
    name: 'm3d: drop the one-baseline-per-JOIN constraint',
    file: M3D_MIGRATION,
    suite: M3D_DB_SUITE,
    from: `create unique index if not exists creator_relationship_observations_attribution_uq`,
    to: `create index if not exists creator_relationship_observations_attribution_uq`,
    expect: 'refuses a second observation for the same attribution',
  },
  {
    // One person could then write baselines against another person's JOIN.
    name: 'm3d: stop scoping the attribution lookup to the actor',
    file: M3D_MIGRATION,
    suite: M3D_DB_SUITE,
    from: `  where e.actor_id = p_actor
    and e.attribution_id = p_attribution`,
    to: `  where e.attribution_id = p_attribution`,
    expect: 'returns nothing when a different actor asks about it',
  },

  // ----------------------------------------------------- authorization
  {
    // Trusts the redirect. Twitch will complete a flow having granted less
    // than was asked for, so this would report READY for somebody who granted
    // nothing - and M3D would then look permanently broken for them.
    name: 'auth: believe OAuth succeeded rather than asking the server',
    file: AUTH,
    suite: PERMISSION_SUITE,
    from: `      await refreshMeasurementReadiness()
      const granted = state.measurementReadiness === 'ready'`,
    to: `      const granted = true`,
    expect: 'does not call itself ready just because OAuth came back',
  },
  {
    // Backing out of an OPTIONAL permission costs somebody their session.
    name: 'auth: sign the user out when they decline the permission',
    file: AUTH,
    suite: PERMISSION_SUITE,
    from: `        if (isUserCancellation(error)) return { ok: false, error: null }`,
    to: `        if (isUserCancellation(error)) {
          setState({ status: 'signed_out', identity: null, friends: [] })
          return { ok: false, error: null }
        }`,
    expect: 'leaves the person signed in when they back out',
  },
  {
    // The correction, inverted. Dropping the scope from the initial
    // authorization is what created the rejected product: every new user would
    // sign in without it and then have to discover a second Twitch trip
    // somewhere in their settings.
    name: 'auth: drop the follow scope from the initial sign-in',
    file: AUTH,
    suite: PERMISSION_SUITE,
    from: `      const started = await deps.backend.startOAuth(deps.redirectUrl, scopeRequest())
      if (started.error || !started.value) {
        fail('startOAuth', 'Watchside could not start the Twitch sign-in.', started.error)`,
    to: `      const started = await deps.backend.startOAuth(deps.redirectUrl)
      if (started.error || !started.value) {
        fail('startOAuth', 'Watchside could not start the Twitch sign-in.', started.error)`,
    expect: 'asks Twitch for the measurement scope during the initial authorization',
  },
  {
    // Watchside asks for something it has no business holding. The scope set is
    // the enforceable statement of what Watchside can do to somebody's Twitch
    // account, so widening it must never be a quiet edit.
    name: 'auth: widen the requested scope set',
    file: AUTH,
    suite: PERMISSION_SUITE,
    from: `export const REQUESTED_SCOPES: readonly string[] = [FOLLOWS_SCOPE]`,
    to: `export const REQUESTED_SCOPES: readonly string[] = [FOLLOWS_SCOPE, 'user:read:subscriptions']`,
    expect: 'asks for nothing beyond that one scope',
  },

  {
    // The readiness gate loosens, and people whose authorization is genuinely
    // BROKEN get told an optional-permission story instead of the one thing
    // that would help them. Failing closed here is the whole reason this state
    // machine has four values rather than a boolean.
    name: 'account: offer the permission to somebody whose authorization is broken',
    file: ACCOUNT_UI,
    suite: PERMISSION_SUITE,
    from: `  if (readiness !== 'needs_follow_permission') return null`,
    to: `  if (readiness === 'ready') return null`,
    expect: 'is offered to nobody whose authorization is actually broken',
  },

  // ------------------------ G6, now that real observations can exist (D)
  {
    // Deauthorization leaves the Twitch-derived observations behind. Before
    // Slice D this deleted nothing because nothing existed; now it is the
    // difference between a promise kept and a promise printed.
    name: 'g6: keep the Twitch-derived observations on deauthorization',
    file: MIGRATION,
    suite: M3D_DB_SUITE,
    from: `  delete from public.creator_relationship_observations where actor_id = p_actor;`,
    to: `  -- deletion removed`,
    expect: 'Twitch deauthorization deletes them and keeps Watchside analytics',
  },
  {
    // Deauthorization takes Watchside's own record of its own product with it.
    // The asymmetry is the promise: the Twitch-derived layer goes, the JOIN,
    // the arrival, the shared watch and the dwell stay.
    name: 'g6: also delete the Watchside-owned JOIN funnel on deauthorization',
    file: MIGRATION,
    suite: M3D_DB_SUITE,
    from: `  delete from public.creator_relationship_observations where actor_id = p_actor;
  get diagnostics v_observations = row_count;`,
    to: `  delete from public.creator_relationship_observations where actor_id = p_actor;
  get diagnostics v_observations = row_count;
  delete from public.analytics_events where actor_id = p_actor;`,
    expect: 'keeps the dwell and shared-watch records specifically',
  },

  // ------------------------------------------ the production JOIN trigger
  {
    // JOIN waits for the relationship result. Held inside the serial chain, a
    // Twitch round trip sits in front of the arrival - so every measured JOIN
    // reports an inflated join_arrived.elapsed_ms, and the measurement quietly
    // corrupts the product's own numbers.
    name: 'trigger: make the analytics queue wait for the Twitch round trip',
    file: HUB,
    suite: TRIGGER_SUITE,
    from: `        void deps
          .measureRelationship({ broadcasterLogin: channel, attributionId: minted!.id })`,
    to: `        await deps
          .measureRelationship({ broadcasterLogin: channel, attributionId: minted!.id })`,
    expect: 'does not hold the analytics queue while it measures',
  },
  {
    // THE BUG THAT COST THE FIRST REAL ACCEPTANCE, restored.
    //
    // One pass instead of two: flush() returns with the caller's event still
    // queued whenever a send was already in flight, which at a JOIN is the
    // ordinary state of the world. Eligible JOINs then measure nothing, and
    // nothing anywhere looks wrong.
    name: 'trigger: let flush return while an earlier send is still in flight',
    file: RECORDER,
    suite: RECORDER_SUITE,
    from: `      await run()
      await run()`,
    to: `      await run()`,
    expect: 'drains an event queued while an earlier batch is still sending',
  },
  {
    // The ordering guarantee Slice B left open. Measuring before the canonical
    // join_clicked is acknowledged asks the server to bind an attribution whose
    // JOIN has not arrived.
    name: 'trigger: measure before the JOIN write is acknowledged',
    file: HUB,
    suite: TRIGGER_SUITE,
    from: `  if (input.pendingEvents > 0) return { measure: false, reason: 'unacknowledged' }`,
    to: `  if (false) return { measure: false, reason: 'unacknowledged' }`,
    expect: 'refuses when the JOIN write has not been acknowledged',
  },
  {
    // A non-ready state measures anyway. Everything downstream of this is a
    // fabricated baseline for somebody who never granted the permission.
    name: 'trigger: measure without the permission the server confirmed',
    file: HUB,
    suite: TRIGGER_SUITE,
    from: `  if (input.readiness !== 'ready') return { measure: false, reason: 'not_ready' }`,
    to: `  if (input.readiness === 'needs_reauthorization') return { measure: false, reason: 'not_ready' }`,
    expect: 'skips every other state, without distinguishing between them',
  },
  {
    // Arbitrary Twitch navigation becomes eligible. This is the single change
    // that would turn "the channel your friends are watching" into "who you
    // follow" - the exact claim the privacy policy refuses to make.
    name: 'trigger: measure JOINs nobody else was part of',
    file: HUB,
    suite: TRIGGER_SUITE,
    from: `  if (!(input.socialCount > 0)) return { measure: false, reason: 'not_socially_initiated' }`,
    to: `  if (input.socialCount < 0) return { measure: false, reason: 'not_socially_initiated' }`,
    expect: 'refuses a JOIN nobody else was part of',
  },
  {
    // The client starts reading the server's answer. Today there is nowhere for
    // a follow result to arrive; this builds the somewhere.
    name: 'trigger: read the relationship response in the client',
    file: BACKEND,
    suite: TRIGGER_SUITE,
    from: `  const { error } = await supabase.functions.invoke('twitch-credential', {
    body: {
      action: 'relationship',`,
    to: `  const { data, error } = await supabase.functions.invoke('twitch-credential', {
    body: {
      action: 'relationship',
      state: (data as { state?: string } | null)?.state,`,
    expect: 'discards the server response rather than reading it',
  },
  {
    // The client names the actor. The server would still read the JWT, but the
    // shape is the thing: an actor field in this body is an invitation to trust
    // it, and the whole binding rests on never having one.
    name: 'trigger: send an actor id with the relationship request',
    file: BACKEND,
    suite: TRIGGER_SUITE,
    from: `      attribution_id: input.attributionId,`,
    to: `      attribution_id: input.attributionId,
      actor_id: 'self',`,
    expect: 'sends the two approved fields under the two approved names',
  },
  {
    // Collection without disclosure. The caller stays; the policy stops
    // describing it. This is the ordering the whole gate exists to enforce.
    name: 'privacy: collect without disclosing the follow check',
    file: PRIVACY,
    suite: TRIGGER_SUITE,
    from: `**Did this person already follow this creator?**`,
    to: `> (nothing is asked)`,
    expect: 'a production relationship caller requires the policy to describe it',
  },

  // -------------------------------------------- M3D coverage and denominators
  {
    // THE FLATTERING BUG. Every JOIN we could not measure silently becomes a
    // "did not follow", the headline gets bigger, and nothing outside the
    // database could ever tell.
    name: 'coverage: treat a missing follow answer as "did not follow"',
    file: COVERAGE_MIGRATION,
    suite: COVERAGE_SUITE,
    from: `  and o.attribution_id is not null
  and o.relationship_present is not null;`,
    to: `  and o.attribution_id is not null;`,
    expect: 'counts a null baseline in neither bucket, and not in the denominator',
  },
  {
    // The relationship share divided by every social JOIN rather than by the
    // baselines actually retained. Same flattering direction, different route.
    name: 'coverage: divide the relationship share by all social JOINs',
    file: COHORT_MIGRATION,
    suite: COVERAGE_SUITE,
    from: `       then round(count(*) filter (where not relationship_present)::numeric / count(*), 4) end`,
    to: `       then round(count(*) filter (where not relationship_present)::numeric /
         (select greatest(count(*), 1) from public.m3d_social_joins_v), 4) end`,
    expect: 'divides by retained baselines, not by JOINs',
  },
  {
    // followed and not-followed swapped. The number stays plausible and means
    // the opposite of what it says.
    name: 'coverage: invert the followed / not-followed buckets',
    file: COHORT_MIGRATION,
    suite: COVERAGE_SUITE,
    from: `       then count(*) filter (where relationship_present) end
                                                        as followed_at_baseline,`,
    to: `       then count(*) filter (where not relationship_present) end
                                                        as followed_at_baseline,`,
    expect: 'puts true in followed and false in not-followed, once it is an aggregate',
  },
  {
    // Eligibility defined by the outcome instead of the decision, which makes
    // coverage tautologically 100% and the metric meaningless.
    name: 'coverage: define eligibility as "has an observation"',
    file: COVERAGE_MIGRATION,
    suite: COVERAGE_SUITE,
    from: `  (s.properties ->> 'status') = 'attempted' as measurement_eligible`,
    to: `  (s.properties ->> 'status') is not null as measurement_eligible`,
    expect: 'does not count a JOIN the client declined to measure',
  },
  {
    // A zero where the truth is "there was nothing to measure". The two must
    // not look alike in a chart.
    name: 'coverage: report 0% when nothing was eligible',
    file: NUMERATOR_MIGRATION,
    suite: COVERAGE_SUITE,
    from: `    when count(*) filter (where m.measurement_eligible) = 0 then null`,
    to: `    when count(*) filter (where m.measurement_eligible) = 0 then 0`,
    expect: 'gives no coverage rate at all when nothing was eligible',
  },
  {
    // The private analytics views become readable by any signed-in client.
    name: 'coverage: grant the relationship views to authenticated users',
    file: COHORT_MIGRATION,
    suite: COVERAGE_SUITE,
    from: `grant select on public.m3d_relationship_v to service_role;`,
    to: `grant select on public.m3d_relationship_v to service_role;
grant select on public.m3d_relationship_v to authenticated;`,
    expect: 'refuses m3d_relationship_v to an authenticated client',
  },
  {
    // Confirmed scope loss stops deleting the Twitch-derived baselines.
    name: 'coverage: keep the baselines after confirmed scope removal',
    file: COVERAGE_MIGRATION,
    suite: COVERAGE_SUITE,
    from: `  delete from public.creator_relationship_observations where actor_id = p_actor;
  get diagnostics v_observations = row_count;`,
    to: `  v_observations := 0;`,
    expect: 'deletes the Twitch-derived baselines',
  },
  {
    // Scope loss destroys the credential too, reporting somebody as broken for
    // a permission they simply withdrew.
    name: 'coverage: destroy the credential on confirmed scope removal',
    file: COVERAGE_MIGRATION,
    suite: COVERAGE_SUITE,
    from: `  delete from public.creator_relationship_observations where actor_id = p_actor;
  get diagnostics v_observations = row_count;

  -- Idempotent`,
    to: `  delete from public.creator_relationship_observations where actor_id = p_actor;
  get diagnostics v_observations = row_count;
  delete from public.twitch_credentials where actor_id = p_actor;

  -- Idempotent`,
    expect: 'leaves the credential in place',
  },

  {
    // THE LEAK 0035 EXISTS TO CLOSE. With one retained baseline the share IS
    // that person's follow state, printed as a percentage - and everything M3D
    // does to keep the answer server-side is undone by a reporting view.
    name: 'coverage: publish the share for a cohort of one',
    file: COHORT_MIGRATION,
    suite: COVERAGE_SUITE,
    from: `  case when count(*) >= 10 and count(distinct actor_id) >= 3
       then round(count(*) filter (where not relationship_present)::numeric / count(*), 4) end`,
    to: `  round(count(*) filter (where not relationship_present)::numeric / count(*), 4)`,
    expect: 'withholds the breakdown when the aggregate is one person',
  },

  {
    // THE DEFECT SLICE F FOUND. The numerator counts observations from JOINs
    // the denominator excludes, so coverage borrows evidence from a population
    // it is not measuring - and can exceed 100%.
    name: 'coverage: count observations from outside the eligible population',
    file: NUMERATOR_MIGRATION,
    suite: COVERAGE_SUITE,
    from: `  count(o.attribution_id) filter (where m.measurement_eligible)
                                                      as observed_baselines,`,
    to: `  count(o.attribution_id)                             as observed_baselines,`,
    expect: 'counts only observations belonging to eligible JOINs',
  },

  // ------------------------------------- the public surface (M5B)
  {
    // The canonical route stops carrying the code, so every /i/<code> link
    // silently becomes an unattributed install and the inviter loses credit.
    name: 'site: drop the code from the canonical /i/ route',
    file: SITE_404,
    suite: ROUTING_SUITE,
    from: "            var match = /^\\/i\\/([^/?#]+)\\/?$/.exec(path)",
    to: '            var match = null',
    expect: 'carries the code from /i/<code> to Twitch',
  },
  {
    // The old ?c= shape stops working, breaking every link already shared in
    // messages, clipboards and browser histories.
    name: 'site: drop compatibility with the old ?c= links',
    file: SITE_404,
    suite: ROUTING_SUITE,
    from: "            var query = new URLSearchParams(window.location.search).get('c') || ''",
    to: "            var query = ''",
    expect: 'still carries the code from the old ?c= shape',
  },
  {
    // Validation goes, so any path segment becomes a "code" - including one
    // carrying somebody else's URL.
    name: 'site: accept any code shape at all',
    file: SITE_404,
    suite: ROUTING_SUITE,
    from: '          if (!CODE_PATTERN.test(code)) {',
    to: '          if (false) {',
    expect: 'refuses an absolute URL smuggled into the code',
  },
  {
    // Firefox presented as available, sending people to a listing that does
    // not exist because Mozilla has never published it.
    name: 'site: advertise Firefox as available',
    file: SITE_ROOT,
    suite: ROUTING_SUITE,
    from: '        Watchside is in a small private beta. A Firefox version is built and',
    to: '        <a href="https://addons.mozilla.org/">Add to Firefox</a>. Also built and',
    expect: 'does not offer Firefox, which is not',
  },
  {
    // A pasted canonical link stops being recognised, so the one shape the
    // product now hands people is the one it cannot read back.
    name: 'invites: stop reading a code from a pasted /i/ link',
    file: INVITES,
    suite: ROUTING_SUITE,
    from: '  const fromUrl = looksLikeUrl ? (codeFromUrl(trimmed) ?? codeFromPath(trimmed)) : null',
    to: '  const fromUrl = looksLikeUrl ? codeFromUrl(trimmed) : null',
    expect: 'reads a code pasted as a canonical /i/ link',
  },

  // ------------------------------- product comprehension (M5B)
  {
    // Locked milestones disappear again, so nobody can learn what exists or
    // how it is earned - the M4.5 finding, restored.
    name: 'badges: hide everything not yet earned',
    file: SHELF,
    suite: COMPREHENSION_SUITE,
    from: '  const locked = (catalog ?? []).filter((badge) => !earned.has(badge.key))',
    to: '  const locked: BadgeDefinition[] = []',
    expect: 'shows the ladder to somebody who has earned nothing',
  },
  {
    // "Not earned yet" stops being said in words, leaving the state carried by
    // opacity alone.
    name: 'badges: convey locked state by colour alone',
    file: SHELF,
    suite: COMPREHENSION_SUITE,
    from: 'title={`${badge.name} (not earned yet) — ${badge.description}`}',
    to: 'title={badge.name}',
    expect: 'says "not earned yet" in words, not only in grey',
  },

  // --------------------------------------------- the growth loop (M5A)
  {
    // referral_succeeded fires on attribution rather than on the three-condition
    // rule. Every link click becomes a "successful referral" and the growth
    // number becomes meaningless in the flattering direction.
    name: 'growth: credit a referral for attribution alone',
    file: GROWTH_MIGRATION,
    suite: GROWTH_SUITE,
    from: `  if v_row.friended_at is null or v_row.activated_at is null then
    return;
  end if;`,
    to: '',
    expect: 'emits nothing for attribution alone',
  },
  {
    // The single-stamp guard goes, so a retry credits the same referral twice.
    name: 'growth: lose referral idempotency',
    file: GROWTH_MIGRATION,
    suite: GROWTH_SUITE,
    from: `  if not found or v_row.succeeded_at is not null then
    return;
  end if;`,
    to: `  if not found then
    return;
  end if;
  if v_row.succeeded_at is not null then
    perform public.analytics_emit_server(v_row.inviter_id, 'referral_succeeded');
    return;
  end if;`,
    expect: 'emits exactly once however many times settlement runs',
  },
  {
    // A badge award that already happened emits again, so badges inflate on
    // every pass of the awarding path.
    name: 'growth: emit a badge event for a repeat award',
    file: GROWTH_MIGRATION,
    suite: GROWTH_SUITE,
    from: '  if v_awarded then',
    to: '  if true then',
    expect: 'emits nothing on a repeat award',
  },
  {
    // The server emitter becomes callable by anybody, so a client can forge
    // its own referral credit.
    name: 'growth: let clients emit server-authoritative events',
    file: GROWTH_MIGRATION,
    suite: GROWTH_SUITE,
    from: `revoke all on function public.analytics_emit_server(uuid, text, jsonb)
  from public, anon, authenticated;`,
    to: `grant execute on function public.analytics_emit_server(uuid, text, jsonb)
  to authenticated;`,
    expect: 'is not callable by a client',
  },
  {
    // THE M4.5 FINDING, RESTORED. Suggestions render nothing when empty, so a
    // user who deliberately opened find-friends cannot tell whether the feature
    // is empty, broken or absent.
    name: 'growth: let suggestions vanish silently when empty',
    file: GROW_UI,
    suite: SUGGEST_SUITE,
    from: '  if (suggestions.length === 0) {',
    to: `  if (suggestions.length === 0) return null
  if (false) {`,
    expect: 'says why there is nobody to suggest',
  },
  {
    // The impression goes back to the fetch, counting "we asked the server" as
    // "somebody saw suggestions" - including every empty result.
    name: 'growth: emit the suggestion impression from the fetch',
    file: GROW_UI,
    suite: SUGGEST_SUITE,
    from: '    if (!suggestions || suggestions.length === 0) return',
    to: '    if (!suggestions) return',
    expect: 'records no impression',
  },
  {
    // A re-render emits a second impression, so the funnel's first step inflates
    // with every parent update.
    name: 'growth: let a re-render emit a second impression',
    file: GROW_UI,
    suite: SUGGEST_SUITE,
    from: '    if (seen.current) return',
    to: '    if (false) return',
    expect: 'is not recorded again when the parent re-renders with a fresh client',
  },
  {
    // The zero-friend state stops explaining the product and goes back to
    // reporting that the panel is empty.
    name: 'growth: drop the zero-friend explanation',
    file: AUTH_UI,
    suite: ZERO_SUITE,
    from: '      <div className="kb-quiet-title">See where your friends are watching.</div>',
    to: '      <div className="kb-quiet-title">Your Watchside is quiet.</div>',
    expect: 'explains the product, not just that the panel is empty',
  },
  {
    // Friends-but-idle collapses back into looking identical to having no
    // friends at all, which tells a new user the opposite of the truth.
    name: 'growth: collapse the friends-idle state into silence',
    file: GRAVITY_UI,
    suite: ZERO_SUITE,
    from: '      {!anybodyWatching && (',
    to: '      {false && (',
    expect: 'says the map is quiet rather than asking for friends again',
  },
  {
    // The idle caption never goes away, so it sits above live cards as noise.
    name: 'growth: show the idle caption even when friends are watching',
    file: GRAVITY_UI,
    suite: ZERO_SUITE,
    from: `  const anybodyWatching = drawn.some(
    (section) => section.kind === 'here' || section.kind === 'destination',
  )`,
    to: '  const anybodyWatching = false',
    expect: 'drops the idle explanation once a friend is on a channel',
  },
  {
    // The only permanent door to friend growth loses its accessible name.
    name: 'growth: make the friend-growth button nameless again',
    file: 'src/ui/KickbackPanel.tsx',
    suite: ZERO_SUITE,
    from: '              aria-label="Add friends"',
    to: '',
    expect: 'names itself for anybody who cannot see the icon',
  },

  // ------------------------------------ the acceptance precondition guard
  {
    // THE GUARD THAT DID NOT EXIST, REMOVED AGAIN.
    //
    // Without it an acceptance run spends a real human JOIN on an account that
    // holds no credential, measures nothing, and reports a mystery. That is not
    // hypothetical - it happened twice before this check was written.
    name: 'acceptance: begin a JOIN for an actor with no credential',
    file: PRECONDITIONS,
    suite: PRECONDITION_SUITE,
    from: `  if (snapshot.has_credential !== true) {
    return { ok: false, reason: 'no_credential' }
  }`,
    to: '',
    expect: 'refuses an actor with no stored Twitch credential',
  },
  {
    // The guard stops failing closed: an unrecognised or missing readiness
    // sails past instead of stopping the run.
    name: 'acceptance: treat any non-ready state as good enough',
    file: PRECONDITIONS,
    suite: PRECONDITION_SUITE,
    from: "  if (snapshot.readiness !== 'ready') {",
    to: "  if (snapshot.readiness === 'needs_reauthorization') {",
    expect: 'refuses every non-ready state, and names which one',
  },

  // ------------------------------------------------------------------- O7
  {
    // The credential reaches the disk again.
    name: 'o7: persist the session without stripping',
    file: STORAGE,
    suite: O7_SUITE,
    from: 'await area.set({ [key]: stripProviderCredentials(value) })',
    to: 'await area.set({ [key]: value })',
    expect: 'strips both when a real sign-in carries both',
  },
  // ---------------------------------------------------------- M5C acquisition
  //
  // The attribution semantics that are worth a mutation are the ones whose
  // failure is INVISIBLE: the row still exists, the number still renders, and
  // only the meaning is wrong. Cosmetic campaign copy is not mutated.
  {
    // First touch becomes overwriteable, so the last link clicked wins. Every
    // report then agrees that whichever campaign was posted most recently
    // performs best, which is the classic way this analysis goes wrong.
    name: 'acquisition: let a later touch overwrite where somebody came from',
    file: ACQ_MIGRATION,
    suite: ACQ_DB_SUITE,
    from: `  if new.first_campaign_code is distinct from old.first_campaign_code
     or new.first_touch_at is distinct from old.first_touch_at then`,
    to: '  if false then',
    expect: 'refuses an UPDATE that would rewrite the origin',
  },
  {
    // The client-side rule that decides which pre-auth touch survives. Without
    // it the newest touch wins before the server ever sees one, so the server's
    // immutable column faithfully records the wrong campaign.
    name: 'acquisition: prefer the newest pre-auth touch over the first',
    file: ACQUISITION,
    suite: ACQ_SUITE,
    from: '  if (!isWithinAttributionWindow(held.capturedAt, now)) return arriving\n  return held',
    to: '  return arriving',
    expect: 'keeps the first one when a second arrives inside the window',
  },
  {
    // An expired touch binds anyway. A code left in storage for two months
    // would attribute a completely unrelated later sign-in to a campaign that
    // had nothing to do with it.
    name: 'acquisition: bind a touch that has aged out of the window',
    file: ACQUISITION,
    suite: ACQ_SUITE,
    from: '  return isWithinAttributionWindow(held.capturedAt, now)\n}',
    to: '  return true\n}',
    expect: 'refuses an expired touch',
  },
  {
    // The boundary moves. Chosen because a window that quietly widened would
    // never fail anything else - it would simply attribute more, and look like
    // the campaigns got better.
    name: 'acquisition: widen the attribution window to thirty days',
    file: ACQUISITION,
    suite: ACQ_SUITE,
    from: 'export const ATTRIBUTION_WINDOW_MS = 7 * 24 * 60 * 60 * 1000',
    to: 'export const ATTRIBUTION_WINDOW_MS = 30 * 24 * 60 * 60 * 1000',
    expect: 'is seven days, deliberately and not by accident',
  },
  {
    // Storage stops being treated as untrusted input, so a hand-edited or
    // older-build value becomes an attribution.
    name: 'acquisition: trust whatever code is sitting in storage',
    file: ACQUISITION,
    suite: ACQ_SUITE,
    from: '  if (!isCampaignCode(held.code)) return false',
    to: '',
    expect: 'refuses a malformed code that reached storage somehow',
  },
  {
    // An unresolvable campaign starts writing a row. This is how arbitrary
    // client-supplied text ends up in a table that is later read as if the
    // server had agreed to it.
    name: 'acquisition: accept a campaign the registry has never heard of',
    file: ACQ_MIGRATION,
    suite: ACQ_DB_SUITE,
    from: "  if v_source is null then\n    return 'unknown';\n  end if;",
    to: "  if v_source is null then\n    v_source := 'other';\n  end if;",
    expect: 'refuses a campaign that does not exist, and writes nothing at all',
  },
  {
    // A retired campaign keeps accepting new attribution, so disabling a bad
    // link does nothing at all.
    name: 'acquisition: keep binding to a campaign that was retired',
    file: ACQ_MIGRATION,
    suite: ACQ_DB_SUITE,
    from: "  if not v_active then\n    return 'inactive';\n  end if;",
    to: '  if false then\n    return \'inactive\';\n  end if;',
    expect: 'refuses an inactive campaign without destroying its history',
  },
  {
    // A campaign's source becomes editable. Historical `acquisition_attributed`
    // events carry source, so editing one row would silently rewrite what every
    // past event meant - and nothing would look wrong.
    name: 'acquisition: let a campaign’s source be edited after the fact',
    file: ACQ_MIGRATION,
    suite: ACQ_DB_SUITE,
    from: '  if new.source is distinct from old.source then',
    to: '  if false then',
    expect: 'will not let a campaign’s source change under its history',
  },
  {
    // Internal actors stop being excluded. The owner and the test accounts
    // click their own campaign links constantly; a campaign that looks like it
    // acquired four people when three were us is worse than no number.
    name: 'acquisition: count internal actors in campaign metrics',
    file: ACQ_MIGRATION,
    suite: ACQ_DB_SUITE,
    from: '  join public.analytics_actors aa on aa.user_id = a.actor_id\n  where not aa.is_internal',
    to: '  join public.analytics_actors aa on aa.user_id = a.actor_id\n  where true',
    expect: 'excludes internal actors, who click their own links constantly',
  },
  {
    // Small-cohort suppression disappears, so a two-person campaign reports a
    // 50% rate that is really one individual's behaviour with a percent sign.
    name: 'acquisition: report rates for a cohort of two',
    file: ACQ_MIGRATION,
    suite: ACQ_DB_SUITE,
    from: '  case when x.acquired_actors >= 3\n       then round(x.connected_actors::numeric / x.acquired_actors, 3) end',
    to: '  round(x.connected_actors::numeric / x.acquired_actors, 3)',
    expect: 'suppresses rates below the threshold, as NULL rather than zero',
  },
  {
    // The invitee gets stamped with the inviter's campaign. This is the
    // recursive-attribution mistake: Bob did not come from Alice's streamer
    // campaign, he came from Alice.
    name: 'acquisition: attribute an invitee to the inviter’s campaign',
    file: ACQ_MIGRATION,
    suite: ACQ_DB_SUITE,
    from: 'left join public.acquisition_attribution b on b.actor_id = r.invitee_id',
    to: 'left join public.acquisition_attribution b on b.actor_id = a.actor_id',
    expect: 'links a campaign to the people its acquired user brought',
  },
  {
    // The campaign route starts writing the referral parameter, so a campaign
    // visitor is recorded as having been invited by somebody. Silent, and not
    // undoable.
    name: 'acquisition: send a campaign arrival as a friend referral',
    file: SITE_404,
    suite: ROUTING_SUITE,
    from: "'https://www.twitch.tv/?watchside_campaign=' + encodeURIComponent(campaign),",
    to: "'https://www.twitch.tv/?kickback_invite=' + encodeURIComponent(campaign),",
    expect: 'never sets the referral parameter on a campaign arrival',
  },
  {
    // The campaign route stops requiring its own prefix and takes any trailing
    // segment, attributing people to campaigns off channel names.
    name: 'acquisition: read a campaign code from any trailing path segment',
    file: ACQUISITION,
    suite: ACQ_SUITE,
    from: "  const match = /\\/c\\/([^/?#]+)\\/?$/.exec(withoutQuery)",
    to: "  const match = /\\/([^/?#]+)\\/?$/.exec(withoutQuery)",
    expect: 'refuses a trailing segment that is not under /c/',
  },
]

function runSuite(suite) {
  rmSync(REPORT, { force: true })

  let crashOutput = null
  try {
    execFileSync('npx', ['vitest', 'run', suite, '--reporter=json', `--outputFile=${REPORT}`], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: process.platform === 'win32',
    })
  } catch (error) {
    crashOutput = `${error.stdout ?? ''}${error.stderr ?? ''}`
  }

  if (!existsSync(REPORT)) return { failures: [], crashed: crashOutput ?? 'no report written' }

  const report = JSON.parse(readFileSync(REPORT, 'utf8'))
  const failures = []
  for (const file of report.testResults ?? []) {
    for (const assertion of file.assertionResults ?? []) {
      if (assertion.status === 'failed') failures.push(assertion.title)
    }
  }
  if (failures.length === 0 && (report.numTotalTests ?? 0) === 0) {
    return { failures: [], crashed: crashOutput ?? 'suite ran no tests' }
  }
  return { failures, crashed: null }
}

let failed = 0

for (const mutation of MUTATIONS) {
  const original = readFileSync(mutation.file, 'utf8')

  if (!original.includes(mutation.from)) {
    console.log(`SKIPPED  ${mutation.name}`)
    console.log(`         anchor no longer present in ${mutation.file} - update this check`)
    failed += 1
    continue
  }

  writeFileSync(mutation.file, original.replace(mutation.from, () => mutation.to))
  let result
  try {
    result = runSuite(mutation.suite)
  } finally {
    writeFileSync(mutation.file, original)
  }

  if (result.crashed) {
    console.log(`INCONCLUSIVE ${mutation.name}`)
    console.log(`         the mutated source did not run: ${result.crashed.slice(0, 160)}`)
    failed += 1
    continue
  }

  if (result.failures.some((name) => name.includes(mutation.expect))) {
    console.log(`DETECTED ${mutation.name}`)
    console.log(`         caught by: ${mutation.expect}`)
  } else if (result.failures.length > 0) {
    console.log(`MISATTRIBUTED ${mutation.name}`)
    console.log(`         expected: ${mutation.expect}`)
    console.log(`         actual:   ${result.failures.slice(0, 4).join(', ')}`)
    failed += 1
  } else {
    console.log(`UNDETECTED ${mutation.name}`)
    console.log('         no test noticed - the suite does not defend this')
    failed += 1
  }
}

console.log(
  failed === 0
    ? `\nAll ${MUTATIONS.length} destruction mutations detected.`
    : `\n${failed} of ${MUTATIONS.length} mutations were not properly detected.`,
)

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exit(failed === 0 ? 0 : 1)
}
