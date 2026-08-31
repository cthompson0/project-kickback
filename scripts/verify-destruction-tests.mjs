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
