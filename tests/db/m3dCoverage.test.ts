import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { createTestDb } from './harness'
import type { TestDb, TestUser } from './harness'

/**
 * Whether M3D's numbers can be believed.
 *
 * Slice D proved Watchside CAN obtain a follow baseline. This is the harder
 * question: given a pile of JOINs and a pile of observations, what may honestly
 * be divided by what.
 *
 * THE MISTAKE THESE TESTS EXIST TO PREVENT
 *
 * Computing "how many JOINs went to creators the viewer did not already follow"
 * over ALL JOINs. Every JOIN we could not measure would silently become a
 * "did not follow", and the number would be wrong in the flattering direction -
 * bigger, and impossible to detect from the outside.
 *
 * So two questions are kept apart, with two different denominators:
 *
 *   COVERAGE      observed baselines / JOINs we judged measurable
 *   RELATIONSHIP  not-followed / baselines we CURRENTLY RETAIN
 *
 * The second denominator is the smallest defensible one on purpose. It shrinks
 * when Twitch-derived data is deleted, which means historical percentages move.
 * That is correct: the alternative is reporting a relationship we are no longer
 * allowed to hold.
 */

let db: TestDb
let alice: TestUser
let bob: TestUser

const ATTR = (n: number) => `${String(n).repeat(8)}-${String(n).repeat(4)}-4${String(n).repeat(3)}-8${String(n).repeat(3)}-${String(n).repeat(12)}`

async function actor(user: TestUser): Promise<void> {
  await db.root(
    'insert into public.analytics_actors (user_id) values ($1) on conflict (user_id) do nothing',
    [user.id],
  )
}

async function joinClicked(
  user: TestUser,
  attribution: string,
  channel: string,
  socialCount: number,
  navigated = true,
): Promise<void> {
  await actor(user)
  await db.root(
    `insert into public.analytics_events
       (actor_id, environment, event_name, occurred_at, destination_channel, attribution_id, properties)
     values ($1, 'production', 'join_clicked', now(), $2, $3,
             jsonb_build_object('social_count', $4::int, 'navigated', $5::boolean))`,
    [user.id, channel, attribution, socialCount, navigated],
  )
}

async function measurementStatus(
  user: TestUser,
  attribution: string,
  status: string,
): Promise<void> {
  await db.root(
    `insert into public.analytics_events
       (actor_id, environment, event_name, occurred_at, attribution_id, properties)
     values ($1, 'production', 'join_measurement_status', now(), $2,
             jsonb_build_object('status', $3::text))`,
    [user.id, attribution, status],
  )
}

async function observe(
  user: TestUser,
  attribution: string,
  present: boolean | null,
  login = 'lirik',
): Promise<void> {
  await db.root(
    `insert into public.creator_relationship_observations
       (actor_id, broadcaster_login, attribution_id, relationship_present)
     values ($1, $2, $3, $4)`,
    [user.id, login, attribution, present],
  )
}

const coverage = async () =>
  (
    await db.root<{
      social_joins: string
      measurement_eligible: string
      observed_baselines: string
      skipped_not_ready: string
      skipped_unacknowledged: string
      status_missing: string
      coverage_rate: string | null
    }>('select * from public.m3d_coverage_v')
  )[0]

const relationship = async () =>
  (
    await db.root<{
      retained_baselines: string
      measured_actors: string
      followed_at_baseline: string | null
      not_followed_at_baseline: string | null
      not_followed_share: string | null
      reportable: boolean
    }>('select * from public.m3d_relationship_v')
  )[0]

beforeAll(async () => {
  db = await createTestDb()
}, 60_000)

afterAll(async () => {
  await db.close()
})

beforeEach(async () => {
  await db.reset()
  alice = await db.createUser({ login: 'alice_tv', displayName: 'Alice' })
  bob = await db.createUser({ login: 'bob_tv', displayName: 'Bob' })
})

// ------------------------------------------------------ population A

describe('the socially initiated JOIN population', () => {
  it('counts a navigated, attributed JOIN with somebody else there', async () => {
    await joinClicked(alice, ATTR(1), 'lirik', 2)
    await measurementStatus(alice, ATTR(1), 'attempted')
    expect(Number((await coverage()).social_joins)).toBe(1)
  })

  /** A JOIN nobody else was part of is a real JOIN, outside this population. */
  it('excludes a JOIN nobody else was part of', async () => {
    await joinClicked(alice, ATTR(1), 'lirik', 0)
    expect(await coverage()).toBeUndefined()
  })

  it('excludes a click that navigated nowhere', async () => {
    await joinClicked(alice, ATTR(1), 'lirik', 2, false)
    expect(await coverage()).toBeUndefined()
  })

  /** Arrivals, dwell and ordinary browsing are not JOINs. */
  it('excludes events that are not join_clicked', async () => {
    await actor(alice)
    await db.root(
      `insert into public.analytics_events
         (actor_id, environment, event_name, occurred_at, destination_channel, attribution_id)
       values ($1, 'production', 'join_arrived', now(), 'lirik', $2)`,
      [alice.id, ATTR(1)],
    )
    expect(await coverage()).toBeUndefined()
  })

  /** Internal accounts never reach a reportable number. */
  it('excludes internal actors', async () => {
    await joinClicked(alice, ATTR(1), 'lirik', 2)
    await measurementStatus(alice, ATTR(1), 'attempted')
    await db.root('update public.analytics_actors set is_internal = true where user_id = $1', [
      alice.id,
    ])
    expect(await coverage()).toBeUndefined()
  })
})

// ------------------------------------------------------ population B

describe('measurement eligibility is defined by the decision, not the outcome', () => {
  /**
   * THE TAUTOLOGY THIS AVOIDS.
   *
   * If "eligible" meant "has an observation", coverage would always be 100% and
   * the metric would answer nothing. Eligibility is what the client decided at
   * the JOIN; the observation is what came of it.
   */
  it('counts an eligible JOIN that produced no observation', async () => {
    await joinClicked(alice, ATTR(1), 'lirik', 2)
    await measurementStatus(alice, ATTR(1), 'attempted')

    const row = await coverage()
    expect(Number(row.measurement_eligible)).toBe(1)
    expect(Number(row.observed_baselines)).toBe(0)
    expect(row.coverage_rate).toBe('0.0000')
  })

  it('does not count a JOIN the client declined to measure', async () => {
    await joinClicked(alice, ATTR(1), 'lirik', 2)
    await measurementStatus(alice, ATTR(1), 'not_ready')

    const row = await coverage()
    expect(Number(row.social_joins)).toBe(1)
    expect(Number(row.measurement_eligible)).toBe(0)
    expect(Number(row.skipped_not_ready)).toBe(1)
  })

  it('separates the reasons a JOIN was skipped', async () => {
    await joinClicked(alice, ATTR(1), 'lirik', 2)
    await measurementStatus(alice, ATTR(1), 'not_ready')
    await joinClicked(alice, ATTR(2), 'lirik', 2)
    await measurementStatus(alice, ATTR(2), 'unacknowledged')

    const row = await coverage()
    expect(Number(row.skipped_not_ready)).toBe(1)
    expect(Number(row.skipped_unacknowledged)).toBe(1)
    expect(Number(row.measurement_eligible)).toBe(0)
  })

  /**
   * A JOIN from before the coverage event shipped. It is honestly UNKNOWN, and
   * is reported as its own number rather than being folded into either
   * "eligible" or "skipped" - inventing a status for history is exactly the
   * fabrication this slice exists to avoid.
   */
  it('reports a JOIN with no status as unknown, not as eligible or skipped', async () => {
    await joinClicked(alice, ATTR(1), 'lirik', 2)

    const row = await coverage()
    expect(Number(row.social_joins)).toBe(1)
    expect(Number(row.status_missing)).toBe(1)
    expect(Number(row.measurement_eligible)).toBe(0)
    expect(Number(row.skipped_not_ready)).toBe(0)
    expect(Number(row.skipped_unacknowledged)).toBe(0)
  })

  it('gives no coverage rate at all when nothing was eligible', async () => {
    await joinClicked(alice, ATTR(1), 'lirik', 2)
    await measurementStatus(alice, ATTR(1), 'not_ready')
    // NULL, not 0. "We measured none of them" and "there was nothing to
    // measure" must not look alike.
    expect((await coverage()).coverage_rate).toBeNull()
  })

  it('computes coverage as observed over eligible', async () => {
    for (const n of [1, 2, 3, 4]) {
      await joinClicked(alice, ATTR(n), 'lirik', 2)
      await measurementStatus(alice, ATTR(n), 'attempted')
    }
    await observe(alice, ATTR(1), true)
    await observe(alice, ATTR(2), false)

    const row = await coverage()
    expect(Number(row.measurement_eligible)).toBe(4)
    expect(Number(row.observed_baselines)).toBe(2)
    expect(row.coverage_rate).toBe('0.5000')
  })
})

// -------------------------------------------------- the relationship metric

describe('the relationship result, over retained baselines only', () => {
  /**
   * A cohort big enough to be an aggregate.
   *
   * The suppression threshold is not incidental to these tests - it is the
   * reason they have to build a population rather than assert against one row.
   * At n=1 the share IS somebody's follow state, so there is no way to test the
   * arithmetic honestly except above the threshold.
   */
  const CO = ['alice_tv', 'bob_tv', 'carol_tv', 'dan_tv']

  async function cohort(outcomes: (boolean | null)[]): Promise<TestUser[]> {
    const people: TestUser[] = [alice, bob]
    people.push(await db.createUser({ login: CO[2], displayName: 'Carol' }))
    people.push(await db.createUser({ login: CO[3], displayName: 'Dan' }))

    for (let i = 0; i < outcomes.length; i += 1) {
      const person = people[i % people.length]
      const unique = `cccccccc-1111-4111-8111-${String(i).padStart(12, '0')}`
      await joinClicked(person, unique, 'lirik', 2)
      await measurementStatus(person, unique, 'attempted')
      await observe(person, unique, outcomes[i])
    }
    return people
  }

  /** Below the threshold nothing is broken - it is withheld, and says so. */
  it('withholds the breakdown when the aggregate is one person', async () => {
    await joinClicked(alice, ATTR(1), 'lirik', 2)
    await measurementStatus(alice, ATTR(1), 'attempted')
    await observe(alice, ATTR(1), true)

    const row = await relationship()
    expect(Number(row.retained_baselines)).toBe(1)
    expect(row.reportable).toBe(false)
    // NULL, not 0. A zero would read as "nobody followed them", which is a claim.
    expect(row.followed_at_baseline).toBeNull()
    expect(row.not_followed_at_baseline).toBeNull()
    expect(row.not_followed_share).toBeNull()
  })

  it('withholds it for many baselines from too few people', async () => {
    for (let i = 0; i < 12; i += 1) {
      const attribution = `bbbbbbbb-1111-4111-8111-${String(i).padStart(12, '0')}`
      await joinClicked(alice, attribution, 'lirik', 2)
      await measurementStatus(alice, attribution, 'attempted')
      await observe(alice, attribution, i % 2 === 0)
    }
    const row = await relationship()
    expect(Number(row.retained_baselines)).toBe(12)
    expect(Number(row.measured_actors)).toBe(1)
    expect(row.reportable).toBe(false)
    expect(row.not_followed_share).toBeNull()
  })

  it('puts true in followed and false in not-followed, once it is an aggregate', async () => {
    // 12 baselines across 4 actors: 8 followed, 4 not.
    await cohort([true, true, false, true, true, false, true, true, false, true, true, false])

    const row = await relationship()
    expect(row.reportable).toBe(true)
    expect(Number(row.retained_baselines)).toBe(12)
    expect(Number(row.followed_at_baseline)).toBe(8)
    expect(Number(row.not_followed_at_baseline)).toBe(4)
    expect(row.not_followed_share).toBe('0.3333')
  })

  /**
   * THE INVARIANT THE WHOLE NULLABLE COLUMN EXISTS FOR.
   *
   * A row written without an answer is a failed check. It is not a "did not
   * follow", it is not a "followed", and it is not in the denominator.
   */
  it('counts a null baseline in neither bucket, and not in the denominator', async () => {
    // 12 answered, plus 3 that failed. The denominator must stay 12.
    await cohort([
      true, true, false, true, true, false, true, true, false, true, true, false,
      null, null, null,
    ])

    const row = await relationship()
    expect(Number(row.retained_baselines)).toBe(12)
    expect(Number(row.followed_at_baseline)).toBe(8)
    expect(Number(row.not_followed_at_baseline)).toBe(4)
    expect(row.not_followed_share).toBe('0.3333')
  })

  /**
   * The denominator, stated as what it must NOT be: all social JOINs, or all
   * eligible JOINs. Both would silently turn "could not measure" into "did not
   * follow".
   */
  it('divides by retained baselines, not by JOINs', async () => {
    await cohort([true, true, false, true, true, false, true, true, false, true, true, false])
    // Four more eligible JOINs that produced nothing at all.
    for (let i = 0; i < 4; i += 1) {
      const attribution = `aaaaaaaa-bbbb-4ccc-8ddd-${String(i).repeat(12)}`
      await joinClicked(alice, attribution, 'lirik', 2)
      await measurementStatus(alice, attribution, 'attempted')
    }

    const cov = await coverage()
    const rel = await relationship()
    expect(Number(cov.social_joins)).toBe(16)
    expect(Number(cov.measurement_eligible)).toBe(16)
    // 4/12, not 4/16.
    expect(Number(rel.retained_baselines)).toBe(12)
    expect(rel.not_followed_share).toBe('0.3333')
  })

  it('gives nothing at all when nothing is retained', async () => {
    expect(await relationship()).toBeUndefined()
  })

  it('lets a later independent JOIN contribute its own baseline', async () => {
    await joinClicked(alice, ATTR(1), 'lirik', 2)
    await measurementStatus(alice, ATTR(1), 'attempted')
    await observe(alice, ATTR(1), true)
    await joinClicked(alice, ATTR(2), 'lirik', 2)
    await measurementStatus(alice, ATTR(2), 'attempted')
    await observe(alice, ATTR(2), false)
    expect(Number((await relationship()).retained_baselines)).toBe(2)
  })

  /** One baseline per attributed JOIN is a database constraint, not a convention. */
  it('cannot double count a duplicate observation', async () => {
    await joinClicked(alice, ATTR(1), 'lirik', 2)
    await observe(alice, ATTR(1), true)
    await expect(observe(alice, ATTR(1), false)).rejects.toThrow(/duplicate key/i)
    expect(Number((await relationship()).retained_baselines)).toBe(1)
  })

  /** An observation whose attribution belongs to no JOIN joins to nothing. */
  it('excludes an observation with no social JOIN behind it', async () => {
    await observe(alice, ATTR(9), true)
    expect(await relationship()).toBeUndefined()
  })

  it('excludes an observation recorded against another actor’s attribution', async () => {
    await joinClicked(alice, ATTR(1), 'lirik', 2)
    await observe(bob, ATTR(1), true)
    // Alice's JOIN, Bob's observation: the join is per actor AND attribution.
    expect(await relationship()).toBeUndefined()
  })
})

// --------------------------------------------------- deletion recomputation

describe('deletion changes the numbers, and that is correct', () => {
  beforeEach(async () => {
    for (const n of [1, 2]) {
      await joinClicked(alice, ATTR(n), 'lirik', 2)
      await measurementStatus(alice, ATTR(n), 'attempted')
    }
    await observe(alice, ATTR(1), true)
    await observe(alice, ATTR(2), false)
  })

  /**
   * A historical percentage moving after a required deletion is more honest
   * than a percentage computed from a relationship we are no longer allowed to
   * hold.
   */
  it('drops a deauthorized actor out of the relationship metric entirely', async () => {
    expect(Number((await relationship()).retained_baselines)).toBe(2)

    await db.root('select public.purge_twitch_derived($1)', [alice.id])

    expect(await relationship()).toBeUndefined()
  })

  it('keeps the social JOINs after deauthorization', async () => {
    await db.root('select public.purge_twitch_derived($1)', [alice.id])
    const row = await coverage()
    // The JOINs are Watchside's own record of its own product and remain.
    expect(Number(row.social_joins)).toBe(2)
    expect(Number(row.measurement_eligible)).toBe(2)
    // But nothing is observed any more, so coverage honestly falls to zero.
    expect(Number(row.observed_baselines)).toBe(0)
    expect(row.coverage_rate).toBe('0.0000')
  })

  it('keeps the coverage status, which never held a relationship', async () => {
    await db.root('select public.purge_twitch_derived($1)', [alice.id])
    const [row] = await db.root<{ count: string }>(
      `select count(*) as count from public.analytics_events
       where actor_id = $1 and event_name = 'join_measurement_status'`,
      [alice.id],
    )
    expect(Number(row.count)).toBe(2)
  })

  /**
   * THE RECONSTRUCTION TEST.
   *
   * After deletion, nothing retained may reveal what the follow answer was.
   * The status event says only that Watchside asked.
   */
  it('leaves nothing behind from which the deleted answer could be rebuilt', async () => {
    await db.root('select public.purge_twitch_derived($1)', [alice.id])
    const rows = await db.root<{ properties: Record<string, unknown> }>(
      `select properties from public.analytics_events
       where actor_id = $1 and event_name = 'join_measurement_status'`,
      [alice.id],
    )
    for (const row of rows) {
      expect(JSON.stringify(row.properties)).toBe('{"status":"attempted"}')
    }
  })
})

// ------------------------------------------------ confirmed scope removal

describe('confirmed removal of the follow scope', () => {
  beforeEach(async () => {
    await joinClicked(alice, ATTR(1), 'lirik', 2)
    await measurementStatus(alice, ATTR(1), 'attempted')
    await observe(alice, ATTR(1), true)
    await db.root(
      `insert into public.twitch_credentials (actor_id, secret, key_version, scopes, status)
       values ($1, '\\x01', 1, array['user:read:email'], 'active')`,
      [alice.id],
    )
  })

  it('deletes the Twitch-derived baselines', async () => {
    await db.root('select public.purge_creator_relationships($1)', [alice.id])
    const [row] = await db.root<{ count: string }>(
      'select count(*) as count from public.creator_relationship_observations where actor_id = $1',
      [alice.id],
    )
    expect(Number(row.count)).toBe(0)
  })

  /**
   * Losing a scope is NOT losing authorization. Destroying the credential would
   * report the person as broken and push them through a repair flow for a
   * permission they simply withdrew.
   */
  it('leaves the credential in place', async () => {
    await db.root('select public.purge_creator_relationships($1)', [alice.id])
    const [row] = await db.root<{ count: string }>(
      'select count(*) as count from public.twitch_credentials where actor_id = $1',
      [alice.id],
    )
    expect(Number(row.count)).toBe(1)
  })

  it('preserves every Watchside-owned analytics event', async () => {
    await db.root('select public.purge_creator_relationships($1)', [alice.id])
    const [row] = await db.root<{ count: string }>(
      'select count(*) as count from public.analytics_events where actor_id = $1',
      [alice.id],
    )
    expect(Number(row.count)).toBe(2)
  })

  it('touches nobody else', async () => {
    await joinClicked(bob, ATTR(2), 'lirik', 2)
    await observe(bob, ATTR(2), true)
    await db.root('select public.purge_creator_relationships($1)', [alice.id])
    const [row] = await db.root<{ count: string }>(
      'select count(*) as count from public.creator_relationship_observations where actor_id = $1',
      [bob.id],
    )
    expect(Number(row.count)).toBe(1)
  })

  it('does nothing at all for a null actor', async () => {
    await db.root('select public.purge_creator_relationships(null)')
    const [row] = await db.root<{ count: string }>(
      'select count(*) as count from public.creator_relationship_observations',
    )
    expect(Number(row.count)).toBe(1)
  })

  it('is idempotent', async () => {
    await db.root('select public.purge_creator_relationships($1)', [alice.id])
    await db.root('select public.purge_creator_relationships($1)', [alice.id])
    const [row] = await db.root<{ count: string }>(
      'select count(*) as count from public.creator_relationship_observations',
    )
    expect(Number(row.count)).toBe(0)
  })
})

// ------------------------------------------------------------- access

describe('none of this is reachable by a client', () => {
  const refusal = async (run: () => Promise<unknown>): Promise<string> => {
    try {
      await run()
    } catch (error) {
      return (error as Error).message
    }
    throw new Error('expected the database to refuse this, but it succeeded')
  }

  for (const view of [
    'm3d_social_joins_v',
    'm3d_measurement_v',
    'm3d_observations_v',
    'm3d_coverage_v',
    'm3d_relationship_v',
  ]) {
    it(`refuses ${view} to an authenticated client`, async () => {
      expect(await refusal(() => db.as(alice, `select * from public.${view}`))).toMatch(
        /permission denied/i,
      )
    })
  }

  it('refuses the scope-loss deletion to an authenticated client', async () => {
    expect(
      await refusal(() => db.as(alice, 'select public.purge_creator_relationships($1)', [bob.id])),
    ).toMatch(/permission denied/i)
  })
})

/**
 * Why deletion recomputation needs no mutation lever.
 *
 * The metrics recompute after a deletion because they are VIEWS over live
 * tables - there is no cached copy that could go stale, so the property is
 * structural rather than conditional. The way it could be lost is somebody
 * later materializing one for speed, which would silently keep counting rows
 * the Twitch lifecycle has deleted. That is what this pins.
 */
describe('the metrics are computed, never stored', () => {
  it('every M3D reporting surface is an ordinary view', async () => {
    const rows = await db.root<{ relname: string; relkind: string }>(
      `select c.relname, c.relkind
       from pg_class c
       join pg_namespace n on n.oid = c.relnamespace
       where n.nspname = 'public' and c.relname like 'm3d' || chr(95) || '%'
       order by c.relname`,
    )
    expect(rows.length).toBe(5)
    for (const row of rows) {
      // 'v' is a view. 'm' would be materialized - a cached answer that can
      // outlive the data it came from.
      expect(row.relkind, row.relname).toBe('v')
    }
  })
})
