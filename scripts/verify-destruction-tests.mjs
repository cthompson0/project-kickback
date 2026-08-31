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
