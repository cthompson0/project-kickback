/**
 * Asks the hosted Supabase project whether the analytics schema is really there.
 *
 *   npm run verify:analytics
 *
 * HOW TO READ ITS ANSWERS
 *
 * The same rule as verify:groups, and for the same reason - an earlier version
 * of that script called applied migrations "missing" because it read PostgREST
 * error codes as a single did-it-work boolean. They are not:
 *
 *   42501     permission denied   -> the object EXISTS, and the caller has no
 *                                    rights on it. For analytics that is the
 *                                    HEALTHY answer: nothing may read these
 *                                    tables, so being refused proves the
 *                                    revokes are in place.
 *   PGRST205  table not in schema -> the table is genuinely absent.
 *   PGRST202  no such function    -> no function of that NAME AND SHAPE.
 *                                    Getting the parameter names wrong looks
 *                                    identical, so the signatures below must
 *                                    match the migration exactly.
 *
 * WHAT IT CANNOT TELL YOU
 *
 * Two things, both by design. It cannot say whether anybody's events have
 * arrived - that is a SQL question, and docs/ANALYTICS.md has the query. And
 * it cannot read the event contract back, because analytics_event_names is
 * revoked from every client role like everything else here; whether an event
 * is registered is checked by the migration bundle tests instead, which apply
 * the real SQL to a real Postgres.
 *
 * This runs with the publishable key only. It never authenticates, never
 * writes an event, and never prints key material.
 */
import { existsSync, readFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'

const ENV_PATH = '.env.local'

/**
 * Must match supabase/migrations/0013 through 0024 exactly.
 *
 * 0024 adds three event NAMES and moves the version marker, and neither is a
 * new object this script can probe: the registry is revoked from every client
 * role, so whether an event is registered is checked by the migration bundle
 * tests against a real Postgres instead. The list below is therefore unchanged
 * by 0024 - only this range is.
 */
const TABLES = [
  'feedback',
  'analytics_events',
  'analytics_actors',
  'analytics_event_names',
  'analytics_environments',
]

const VIEWS = [
  'feedback_v',
  'analytics_reportable_events_v',
  'analytics_production_events_v',
  'analytics_sessions_v',
  'analytics_together_v',
  'analytics_join_funnel_v',
  'analytics_actor_days_v',
]

const FUNCTIONS = [
  // The one thing a client may call. Unauthenticated it must refuse - that is
  // the point - but it must EXIST.
  ['analytics_track', { p_events: [] }],
  // Internal. Revoked from every client role, so "permission denied" here is
  // the healthy answer and absence is the signal.
  ['analytics_clean_properties', { p_properties: {}, p_allowed: [] }],
  ['analytics_reset_environment', { p_environment: 'x', p_confirm: 'x' }],
  ['consume_rate_budget_n', { p_bucket: 'x', p_amount: 1, p_limit: 1, p_window: '00:05:00' }],
  /*
   * The marker 0016 leaves behind.
   *
   * Everything else 0015 and 0016 change is a contract row, a function body or
   * a view column, and all of those are invisible from here - so without this,
   * a database that had stopped at 0014 would report as fully healthy.
   */
  ['analytics_schema_version', {}],
  /*
   * Feedback, from 0023.
   *
   * Granted to authenticated and revoked from anon, so an anonymous probe gets
   * 42501 when it exists and PGRST202 when it does not - the same distinction
   * everything else here relies on. It is checked because a packaged build with
   * a Feedback button and no RPC behind it is exactly the kind of half-applied
   * schema this script exists to catch.
   */
  ['submit_feedback', { p_category: 'other', p_body: 'x', p_context: {} }],
]

function readEnv() {
  const env = {}
  for (const line of readFileSync(ENV_PATH, 'utf8').split(/\r?\n/)) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#') || !trimmed.includes('=')) continue
    const at = trimmed.indexOf('=')
    env[trimmed.slice(0, at).trim()] = trimmed.slice(at + 1).trim()
  }
  return env
}

async function codeOf(response) {
  const text = await response.text()
  try {
    return JSON.parse(text).code ?? null
  } catch {
    return null
  }
}

export async function verifyAnalyticsSchema({ quiet = false } = {}) {
  const log = (...parts) => {
    if (!quiet) console.log(...parts)
  }

  if (!existsSync(ENV_PATH)) {
    console.error(`${ENV_PATH} not found - cannot check the hosted project.`)
    return { ok: false, missing: ['(no configuration)'] }
  }

  const env = readEnv()
  const url = env.VITE_SUPABASE_URL
  const key = env.VITE_SUPABASE_PUBLISHABLE_KEY
  if (!url || !key) {
    console.error('VITE_SUPABASE_URL and VITE_SUPABASE_PUBLISHABLE_KEY must both be set.')
    return { ok: false, missing: ['(no configuration)'] }
  }

  const headers = { apikey: key, Authorization: `Bearer ${key}`, 'content-type': 'application/json' }
  const missing = []
  const exposed = []

  log('project      :', url)
  log('checking     : migrations 0013 - 0016 against the hosted database\n')

  for (const relation of [...TABLES, ...VIEWS]) {
    let code
    try {
      code = await codeOf(await fetch(`${url}/rest/v1/${relation}?select=*&limit=1`, { headers }))
    } catch (error) {
      console.error(`Could not reach the project: ${error.message}`)
      return { ok: false, missing: ['(unreachable)'] }
    }

    const present = code !== 'PGRST205'
    if (!present) missing.push(relation)

    /*
     * A readable analytics relation is a FAILURE, not a success.
     *
     * Everything here is revoked from anon and authenticated: an event log is
     * a record of when and where somebody was, which is the side channel the
     * presence privacy work was careful to close. If an anonymous read comes
     * back with rows instead of 42501, the revokes did not apply.
     */
    const readable = code === null
    if (present && readable) exposed.push(relation)

    const verdict = !present ? 'MISSING' : readable ? 'READABLE' : 'present'
    log(
      `  relation ${verdict.padEnd(8)} ${relation}` +
        (!present ? '  <-- not applied' : readable ? '  <-- must not be readable' : ''),
    )
  }

  for (const [name, args] of FUNCTIONS) {
    let code
    try {
      code = await codeOf(
        await fetch(`${url}/rest/v1/rpc/${name}`, {
          method: 'POST',
          headers,
          body: JSON.stringify(args),
        }),
      )
    } catch (error) {
      console.error(`Could not reach the project: ${error.message}`)
      return { ok: false, missing: ['(unreachable)'] }
    }
    const present = code !== 'PGRST202'
    log(`  function ${present ? 'present ' : 'MISSING '} ${name}${present ? '' : '  <-- not applied'}`)
    if (!present) missing.push(`function ${name}`)
  }

  const ok = missing.length === 0 && exposed.length === 0

  if (ok) {
    log('\nAnalytics schema is present, and nothing in it is readable by a client.')
    log('Whether events are actually arriving is a SQL question - see docs/ANALYTICS.md.')
  } else {
    if (missing.length > 0) {
      console.error(`\nNot applied: ${missing.join(', ')}`)
      console.error('Apply supabase/.generated/apply_all.sql in the Supabase SQL editor.')
    }
    if (exposed.length > 0) {
      console.error(`\nReadable by an anonymous client: ${exposed.join(', ')}`)
      console.error('The revokes in 0013/0014/0016 have not taken effect. Re-apply them.')
    }
  }

  return { ok, missing, exposed }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const result = await verifyAnalyticsSchema()
  process.exit(result.ok ? 0 : 1)
}
