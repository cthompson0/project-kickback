import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { createTestDb } from './harness'
import type { TestDb, TestUser } from './harness'

/**
 * The database half of the follow baseline.
 *
 * Two things live here that cannot live in the function: the lookup that makes
 * an attribution id checkable, and the constraint that makes a baseline
 * answerable only once.
 *
 * The lookup is scoped to the actor in its own WHERE clause rather than
 * returning a row for the caller to compare. A function that can only ever
 * answer about the actor it was asked about cannot be misused by a caller that
 * forgets to check - which is a different and better property than "the caller
 * currently checks".
 */

let db: TestDb
let alice: TestUser
let bob: TestUser

const ATTRIBUTION_A = '11111111-1111-4111-8111-111111111111'
const ATTRIBUTION_B = '22222222-2222-4222-8222-222222222222'

async function joinClicked(
  user: TestUser,
  attributionId: string,
  channel: string,
  socialCount: number,
  occurredAt = 'now()',
): Promise<void> {
  await db.root(
    `insert into public.analytics_actors (user_id) values ($1) on conflict (user_id) do nothing`,
    [user.id],
  )
  await db.root(
    `insert into public.analytics_events
       (actor_id, environment, event_name, occurred_at, destination_channel, attribution_id, properties)
     values ($1, 'production', 'join_clicked', ${occurredAt}, $2, $3, jsonb_build_object('social_count', $4::int))`,
    [user.id, channel, attributionId, socialCount],
  )
}

async function observe(user: TestUser, attributionId: string, present: boolean, login = 'lirik') {
  return db.root(
    `insert into public.creator_relationship_observations
       (actor_id, broadcaster_login, attribution_id, relationship_present)
     values ($1, $2, $3, $4)`,
    [user.id, login, attributionId, present],
  )
}

async function refusal(run: () => Promise<unknown>): Promise<string> {
  try {
    await run()
  } catch (error) {
    return (error as Error).message
  }
  throw new Error('expected the database to refuse this, but it succeeded')
}

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

describe('an attribution can be checked against the actor who made it', () => {
  it('returns the JOIN context for the actor who clicked', async () => {
    await joinClicked(alice, ATTRIBUTION_A, 'lirik', 3)

    const rows = await db.root<{
      destination_channel: string
      social_count: number
    }>('select * from public.join_context_for_attribution($1, $2)', [alice.id, ATTRIBUTION_A])

    expect(rows).toHaveLength(1)
    expect(rows[0].destination_channel).toBe('lirik')
    expect(Number(rows[0].social_count)).toBe(3)
  })

  /**
   * The binding that stops one person writing baselines against another's JOIN.
   *
   * Alice's attribution is real, and Bob asking about it gets nothing at all -
   * not a row he must remember to reject.
   */
  it('returns nothing when a different actor asks about it', async () => {
    await joinClicked(alice, ATTRIBUTION_A, 'lirik', 3)

    const rows = await db.root('select * from public.join_context_for_attribution($1, $2)', [
      bob.id,
      ATTRIBUTION_A,
    ])
    expect(rows).toHaveLength(0)
  })

  it('returns nothing for an attribution nobody minted', async () => {
    const rows = await db.root('select * from public.join_context_for_attribution($1, $2)', [
      alice.id,
      ATTRIBUTION_B,
    ])
    expect(rows).toHaveLength(0)
  })

  /** Only a JOIN counts. An arrival or a dwell event is not a click. */
  it('ignores events that are not join_clicked', async () => {
    await db.root(
      `insert into public.analytics_actors (user_id) values ($1) on conflict do nothing`,
      [alice.id],
    )
    await db.root(
      `insert into public.analytics_events
         (actor_id, environment, event_name, occurred_at, destination_channel, attribution_id)
       values ($1, 'production', 'join_arrived', now(), 'lirik', $2)`,
      [alice.id, ATTRIBUTION_A],
    )

    const rows = await db.root('select * from public.join_context_for_attribution($1, $2)', [
      alice.id,
      ATTRIBUTION_A,
    ])
    expect(rows).toHaveLength(0)
  })

  /** A missing social count must read as zero, never as "there were friends". */
  it('reports a missing social count as zero', async () => {
    await db.root(
      `insert into public.analytics_actors (user_id) values ($1) on conflict do nothing`,
      [alice.id],
    )
    await db.root(
      `insert into public.analytics_events
         (actor_id, environment, event_name, occurred_at, destination_channel, attribution_id)
       values ($1, 'production', 'join_clicked', now(), 'lirik', $2)`,
      [alice.id, ATTRIBUTION_A],
    )

    const rows = await db.root<{ social_count: number }>(
      'select * from public.join_context_for_attribution($1, $2)',
      [alice.id, ATTRIBUTION_A],
    )
    expect(Number(rows[0].social_count)).toBe(0)
  })

  it('is not callable by a client', async () => {
    expect(
      await refusal(() =>
        db.as(alice, 'select * from public.join_context_for_attribution($1, $2)', [
          bob.id,
          ATTRIBUTION_A,
        ]),
      ),
    ).toMatch(/permission denied/i)
  })
})

describe('one baseline per attributed JOIN', () => {
  /**
   * The retry this defends against is ordinary, not exotic: the caller fires as
   * a tab is being torn down. Two rows would not merely be untidy - they could
   * disagree, because they would be two questions asked at two moments.
   */
  it('refuses a second observation for the same attribution', async () => {
    await observe(alice, ATTRIBUTION_A, true)
    expect(await refusal(() => observe(alice, ATTRIBUTION_A, false))).toMatch(/duplicate key/i)

    const rows = await db.root('select * from public.creator_relationship_observations')
    expect(rows).toHaveLength(1)
  })

  it('allows a later independent opportunity to the same creator', async () => {
    await observe(alice, ATTRIBUTION_A, false)
    await observe(alice, ATTRIBUTION_B, true)

    const rows = await db.root('select * from public.creator_relationship_observations')
    expect(rows).toHaveLength(2)
  })

  it('keeps actors isolated', async () => {
    await observe(alice, ATTRIBUTION_A, true)
    // The same attribution id under a different actor is a different row; the
    // constraint is per actor, which is what the deletion key is too.
    await observe(bob, ATTRIBUTION_A, false)

    const rows = await db.root('select * from public.creator_relationship_observations')
    expect(rows).toHaveLength(2)
  })

  it('still records a failed check as absent rather than false', async () => {
    await db.root(
      `insert into public.creator_relationship_observations (actor_id, broadcaster_login, attribution_id)
       values ($1, 'lirik', $2)`,
      [alice.id, ATTRIBUTION_A],
    )
    const [row] = await db.root<{ relationship_present: boolean | null }>(
      'select relationship_present from public.creator_relationship_observations',
    )
    expect(row.relationship_present).toBeNull()
  })
})

describe('M3D rows obey the destruction paths that already existed', () => {
  /**
   * The full Watchside-owned trail behind one JOIN, not just the click.
   *
   * Slice D makes real observations possible, so "Twitch deauthorization keeps
   * Watchside analytics" stops being a claim about one row and becomes a claim
   * about the whole funnel a JOIN produces. Each of these is Watchside's own
   * record of its own product, and none of it is Twitch-derived.
   */
  const WATCHSIDE_OWNED = [
    'join_clicked',
    'join_arrived',
    'watching_together_ended',
    'channel_dwell_ended',
  ]

  beforeEach(async () => {
    for (const user of [alice, bob]) {
      await joinClicked(user, ATTRIBUTION_A, 'lirik', 2)
      await observe(user, ATTRIBUTION_A, true)
      for (const name of WATCHSIDE_OWNED.slice(1)) {
        await db.root(
          `insert into public.analytics_events
             (actor_id, environment, event_name, occurred_at, destination_channel, attribution_id, properties)
           values ($1, 'production', $2, now(), 'lirik', $3, '{}'::jsonb)`,
          [user.id, name, ATTRIBUTION_A],
        )
      }
    }
  })

  it('Twitch deauthorization deletes them and keeps Watchside analytics', async () => {
    await db.root('select public.purge_twitch_derived($1)', [alice.id])

    const [counts] = await db.root<{ obs: string; events: string }>(
      `select
         (select count(*) from public.creator_relationship_observations where actor_id = $1) as obs,
         (select count(*) from public.analytics_events where actor_id = $1) as events`,
      [alice.id],
    )
    expect(Number(counts.obs)).toBe(0)
    // The whole Watchside-owned funnel survives, not merely the click.
    expect(Number(counts.events)).toBe(WATCHSIDE_OWNED.length)
  })

  /**
   * Named individually, because "the count is unchanged" would still pass if
   * deauthorization deleted the dwell and invented something else.
   */
  it('keeps the dwell and shared-watch records specifically', async () => {
    await db.root('select public.purge_twitch_derived($1)', [alice.id])

    const rows = await db.root<{ event_name: string }>(
      'select event_name from public.analytics_events where actor_id = $1 order by event_name',
      [alice.id],
    )
    expect(rows.map((row) => row.event_name).sort()).toEqual([...WATCHSIDE_OWNED].sort())
  })

  it('leaves the other actor untouched', async () => {
    await db.root('select public.purge_twitch_derived($1)', [alice.id])
    const [row] = await db.root<{ count: string }>(
      'select count(*) as count from public.creator_relationship_observations where actor_id = $1',
      [bob.id],
    )
    expect(Number(row.count)).toBe(1)
  })

  it('account deletion removes the observation and the analytics', async () => {
    await db.root('select public.purge_twitch_derived($1)', [alice.id])
    await db.root('delete from public.users where id = $1', [alice.id])

    const [counts] = await db.root<{ obs: string; events: string }>(
      `select
         (select count(*) from public.creator_relationship_observations where actor_id = $1) as obs,
         (select count(*) from public.analytics_events where actor_id = $1) as events`,
      [alice.id],
    )
    expect(Number(counts.obs)).toBe(0)
    expect(Number(counts.events)).toBe(0)
  })

  it('sign-out is not modelled here because it deletes nothing at all', async () => {
    // No server call happens on sign-out; the rows simply persist.
    const [row] = await db.root<{ count: string }>(
      'select count(*) as count from public.creator_relationship_observations',
    )
    expect(Number(row.count)).toBe(2)
  })
})

describe('the observation table is still server-only', () => {
  for (const [name, sql] of [
    ['SELECT', 'select * from public.creator_relationship_observations'],
    ['INSERT', `insert into public.creator_relationship_observations (actor_id, broadcaster_login) values (gen_random_uuid(), 'lirik')`],
    ['UPDATE', 'update public.creator_relationship_observations set relationship_present = true'],
    ['DELETE', 'delete from public.creator_relationship_observations'],
  ] as const) {
    it(`refuses ${name} from an authenticated client`, async () => {
      expect(await refusal(() => db.as(alice, sql))).toMatch(/permission denied/i)
    })
  }

  it('refuses an anonymous read even when rows exist', async () => {
    await observe(alice, ATTRIBUTION_A, true)
    expect(
      await refusal(() => db.anon('select * from public.creator_relationship_observations')),
    ).toMatch(/permission denied/i)
  })
})
