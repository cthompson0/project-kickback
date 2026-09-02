import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { createTestDb } from './harness'
import type { TestDb, TestUser } from './harness'

/**
 * The denominator M5C shipped without, and the refusals it never recorded.
 *
 * WHAT WENT WRONG, AND WHY NO TEST CAUGHT IT
 *
 * M5C's three views all start from `acquisition_attribution`, so every number
 * they produce is conditioned on attribution existing - and nothing reported
 * how often it does. `acquisition_campaign_v` reads identically whether
 * campaigns brought most of Watchside's users or almost none of them: the rows
 * are well-formed, the rates are arithmetically correct, the small-cohort
 * suppression works, and the picture can still be completely unrepresentative.
 *
 * That is not a bug any single-view test can see. It is a missing denominator,
 * and it is only visible by asking a question none of the views could answer.
 *
 * Separately, `bind_acquisition` had four outcomes and recorded two. A campaign
 * link resolving to no registry row was discarded in silence, making a broken
 * campaign and an unclicked one produce identical data.
 *
 * These tests hold both halves: coverage is reported against the real
 * population, and a refused touch leaves a trace.
 */

let db: TestDb
let alice: TestUser
let bob: TestUser
let carol: TestUser

const bind = async (user: TestUser, code: string): Promise<string> =>
  (
    await db.as<{ bind_acquisition: string }>(user, 'select public.bind_acquisition($1)', [code])
  )[0].bind_acquisition

interface CoverageRow {
  environment: string
  first_app_version: string | null
  actors: number
  attributed_actors: number
  unattributed_actors: number
  attribution_rate: string | null
}

const coverage = () =>
  db.root<CoverageRow>('select * from public.acquisition_coverage_v order by first_app_version')

interface OutcomeRow {
  outcome: string
  attributed: boolean
  touches: number
  actors: number
}

const outcomes = () =>
  db.root<OutcomeRow>(
    'select outcome, attributed, sum(touches)::int as touches, sum(actors)::int as actors ' +
      'from public.acquisition_touch_outcomes_v group by outcome, attributed order by outcome',
  )

/**
 * An event from a real build.
 *
 * The actor row is created alongside it because `analytics_reportable_events_v`
 * joins `analytics_actors` to exclude internal accounts - an event whose actor
 * has no row is invisible to every reporting view, which is correct in
 * production and merely inconvenient here.
 */
async function emit(user: TestUser, name: string, appVersion: string): Promise<void> {
  await db.root(
    'insert into public.analytics_actors (user_id) values ($1) on conflict (user_id) do nothing',
    [user.id],
  )
  await db.root(
    `insert into public.analytics_events (actor_id, environment, event_name, occurred_at, app_version)
     values ($1, 'private_beta', $2, now(), $3)`,
    [user.id, name, appVersion],
  )
}

beforeAll(async () => {
  db = await createTestDb()
}, 90_000)

afterAll(async () => {
  await db.close()
})

beforeEach(async () => {
  await db.reset()
  alice = await db.createUser({ login: 'alice', displayName: 'Alice' })
  bob = await db.createUser({ login: 'bob', displayName: 'Bob' })
  carol = await db.createUser({ login: 'carol', displayName: 'Carol' })
  await db.root(
    `insert into public.acquisition_campaigns (code, source, creator_key, label, active) values
       ('tiktok-launch', 'tiktok', null, 'TikTok launch', true),
       ('retired-one',   'other',  null, 'Closed',        false)`,
  )
})

describe('coverage counts the whole population, not just the attributed part', () => {
  it('counts an unattributed actor, who no other view can see', async () => {
    await emit(alice, 'authenticated_session_started', '0.8.0')

    // The population view sees her...
    const [row] = await coverage()
    expect(row.actors).toBe(1)
    expect(row.attributed_actors).toBe(0)
    expect(row.unattributed_actors).toBe(1)

    // ...and the campaign views, correctly, do not.
    const campaigns = await db.root('select * from public.acquisition_campaign_v')
    expect(campaigns).toHaveLength(0)
  })

  it('reports the rate against arrivals, never against attributions', async () => {
    /*
     * THE TAUTOLOGY THIS EXISTS TO PREVENT. Three actors arrive, one carries a
     * campaign. Coverage is 1/3. A denominator drawn from the attribution table
     * would say 1/1 and look like total success.
     */
    for (const user of [alice, bob, carol]) {
      await emit(user, 'authenticated_session_started', '0.8.0')
    }
    expect(await bind(alice, 'tiktok-launch')).toBe('first')

    const [row] = await coverage()
    expect(row.actors).toBe(3)
    expect(row.attributed_actors).toBe(1)
    expect(Number(row.attribution_rate)).toBeCloseTo(0.3333, 3)
  })

  it('separates builds, so pre-instrumentation accounts do not depress the rate', async () => {
    /*
     * The dated confound. An account first seen on a build with no acquisition
     * code CANNOT be attributed and there is no backfill, so folding it in
     * would make a working campaign look like it was missing most of its
     * arrivals. Split by the build each actor was first seen on.
     */
    await emit(alice, 'authenticated_session_started', '0.7.0')
    await emit(bob, 'authenticated_session_started', '0.8.0')
    await emit(carol, 'authenticated_session_started', '0.8.0')
    expect(await bind(bob, 'tiktok-launch')).toBe('first')

    const rows = await coverage()
    const old = rows.find((r) => r.first_app_version === '0.7.0')
    const now = rows.find((r) => r.first_app_version === '0.8.0')

    expect(old?.actors).toBe(1)
    expect(old?.attributed_actors).toBe(0)
    expect(now?.actors).toBe(2)
    expect(now?.attributed_actors).toBe(1)
  })

  it('takes the first build chronologically, not the lexically smallest', async () => {
    /*
     * `min(app_version)` on text would call 0.10.0 older than 0.9.0. The view
     * orders by time instead, and this is the case that tells them apart.
     */
    await db.root(
      'insert into public.analytics_actors (user_id) values ($1) on conflict (user_id) do nothing',
      [alice.id],
    )
    await db.root(
      `insert into public.analytics_events (actor_id, environment, event_name, occurred_at, app_version)
       values ($1, 'private_beta', 'authenticated_session_started', now() - interval '2 days', '0.9.0'),
              ($1, 'private_beta', 'join_clicked',                  now(),                     '0.10.0')`,
      [alice.id],
    )

    const [row] = await coverage()
    expect(row.first_app_version).toBe('0.9.0')
  })

  it('suppresses the rate below three actors, as NULL rather than zero', async () => {
    /*
     * A rate over two people is that person's behaviour wearing a percentage
     * sign. NULL and 0 must not look alike: one means "not enough people to
     * say", the other means "nobody".
     */
    await emit(alice, 'authenticated_session_started', '0.8.0')
    await emit(bob, 'authenticated_session_started', '0.8.0')

    const [row] = await coverage()
    expect(row.actors).toBe(2)
    expect(row.attribution_rate).toBeNull()
  })

  it('excludes internal actors, as every reporting surface does', async () => {
    await emit(alice, 'authenticated_session_started', '0.8.0')
    await db.root('update public.analytics_actors set is_internal = true where user_id = $1', [
      alice.id,
    ])
    expect(await coverage()).toHaveLength(0)
  })
})

describe('a refused touch leaves a trace', () => {
  it('records a code matching no campaign', async () => {
    /*
     * The blind spot. Before this, an unknown code returned to the caller and
     * wrote nothing - so a mistyped or retired link in the wild was
     * indistinguishable from nobody having clicked it.
     */
    expect(await bind(alice, 'no-such-campaign')).toBe('unknown')

    const rows = await outcomes()
    const unknown = rows.find((r) => r.outcome === 'unknown')
    expect(unknown?.touches).toBe(1)
    expect(unknown?.attributed).toBe(false)
  })

  it('records a real campaign that has been switched off', async () => {
    expect(await bind(alice, 'retired-one')).toBe('inactive')
    expect((await outcomes()).find((r) => r.outcome === 'inactive')?.touches).toBe(1)
  })

  it('records a malformed code without storing the string offered', async () => {
    expect(await bind(alice, 'NOT A VALID CODE!!')).toBe('unknown')

    expect((await outcomes()).find((r) => r.outcome === 'unknown')?.touches).toBe(1)
    // The rejection is counted; the text a client sent is not kept anywhere.
    const events = await db.root<{ properties: Record<string, unknown> }>(
      "select properties from public.analytics_events where event_name = 'acquisition_touch_rejected'",
    )
    expect(JSON.stringify(events)).not.toContain('NOT A VALID CODE')
    expect(events[0].properties).toEqual({ reason: 'unknown' })
  })

  it('carries no campaign code, so identity stays on the durable row', async () => {
    await bind(alice, 'retired-one')
    const events = await db.root<{ properties: Record<string, unknown> }>(
      "select properties from public.analytics_events where event_name = 'acquisition_touch_rejected'",
    )
    expect(JSON.stringify(events)).not.toContain('retired-one')
  })

  it('counts accepted and refused touches side by side', async () => {
    await bind(alice, 'tiktok-launch') // first
    await bind(alice, 'tiktok-launch') // repeat
    await bind(bob, 'nope-not-real') // unknown
    await bind(carol, 'retired-one') // inactive

    const byOutcome = Object.fromEntries((await outcomes()).map((r) => [r.outcome, r.touches]))
    expect(byOutcome).toEqual({ first: 1, repeat: 1, unknown: 1, inactive: 1 })
  })

  it('still returns exactly what every released client expects', async () => {
    /*
     * The four strings are the contract `core/acquisition.ts` maps. Recording
     * the refusals must not have changed any of them - Firefox 0.8 is public
     * and calls this function today.
     */
    expect(await bind(alice, 'tiktok-launch')).toBe('first')
    expect(await bind(alice, 'tiktok-launch')).toBe('repeat')
    expect(await bind(bob, 'nope-not-real')).toBe('unknown')
    expect(await bind(carol, 'retired-one')).toBe('inactive')
  })

  it('does not create an attribution row for a refused touch', async () => {
    await bind(alice, 'nope-not-real')
    await bind(bob, 'retired-one')
    const rows = await db.root('select * from public.acquisition_attribution')
    expect(rows).toHaveLength(0)
  })
})

describe('what the views deliberately refuse to say', () => {
  it('offers no "direct" column anywhere', async () => {
    /*
     * Watchside cannot tell somebody who typed the Store URL from somebody who
     * followed a campaign link whose touch expired. Both are unattributed.
     * Naming either of them "direct" would invent a fact about people, so the
     * column does not exist for a dashboard to pick up by mistake.
     */
    const columns = await db.root<{ column_name: string }>(
      `select column_name from information_schema.columns
        where table_name in ('acquisition_coverage_v', 'acquisition_touch_outcomes_v')`,
    )
    const names = columns.map((c) => c.column_name.toLowerCase())
    expect(names.length).toBeGreaterThan(0)
    expect(names.some((n) => n.includes('direct'))).toBe(false)
    expect(names.some((n) => n.includes('organic'))).toBe(false)
  })

  it('reports the schema version the migration set', async () => {
    const [row] = await db.root<{ analytics_schema_version: number }>(
      'select public.analytics_schema_version()',
    )
    expect(row.analytics_schema_version).toBe(40)
  })
})
