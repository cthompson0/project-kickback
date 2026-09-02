import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { createTestDb } from './harness'
import type { TestDb, TestUser } from './harness'

/**
 * The activation funnel must count the people it failed.
 *
 * WHAT WENT WRONG BEFORE
 *
 * Watchside's social value is unreachable without at least one friend, and the
 * zero-friend state emitted nothing. Every activation rate was therefore
 * computed across users who had already escaped the cold start - a stranger who
 * installed, signed in, saw an empty panel and left was in no denominator at
 * all. Cold start could be total and activation could look healthy.
 *
 * Same shape as the M5C coverage finding: arithmetically correct, describing a
 * population selected by the thing being measured.
 *
 * THE ADVERSARIAL TEST IS THE POINT
 *
 * `a failed first edge cannot be excluded` is the one that matters. Everything
 * else here is scaffolding for it.
 */

let db: TestDb
let alice: TestUser
let bob: TestUser
let carol: TestUser
let dave: TestUser

interface FunnelRow {
  environment: string
  first_app_version: string | null
  authenticated_actors: number
  never_made_a_friend: number
  made_a_friend: number
  saw_a_friend_watching: number
  joined_socially: number
  returned: number
  friended_rate: string | null
  cold_start_rate: string | null
}

const funnel = () =>
  db.root<FunnelRow>('select * from public.activation_funnel_v order by first_app_version')

interface ActorRow {
  actor_id: string
  still_without_friends: boolean
  first_friendship_at: string | null
  first_social_join_at: string | null
}

const actors = () => db.root<ActorRow>('select * from public.activation_actor_v')

/** Sign somebody in, which is where the funnel starts. */
async function authenticate(user: TestUser, appVersion = '0.9.0'): Promise<void> {
  await db.root(
    'insert into public.analytics_actors (user_id) values ($1) on conflict (user_id) do nothing',
    [user.id],
  )
  await db.root(
    `insert into public.analytics_events (actor_id, environment, event_name, occurred_at, app_version)
     values ($1, 'private_beta', 'authenticated_session_started', now(), $2)`,
    [user.id, appVersion],
  )
}

/** Two people actually become friends, through the real RPCs. */
async function befriend(a: TestUser, b: TestUser): Promise<void> {
  await db.as(a, 'select public.send_friend_request($1)', [b.id])
  const [request] = await db.root<{ id: string }>(
    `select id from public.friend_requests
      where from_user = $1 and to_user = $2 and status = 'pending'`,
    [a.id, b.id],
  )
  await db.as(b, 'select public.respond_to_friend_request($1, true)', [request.id])
}

async function emit(user: TestUser, name: string, appVersion = '0.9.0'): Promise<void> {
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
  dave = await db.createUser({ login: 'dave', displayName: 'Dave' })
})

describe('the cold-start population is visible at last', () => {
  it('counts somebody who signed in and never made a friend', async () => {
    await authenticate(alice)

    const [row] = await funnel()
    expect(row.authenticated_actors).toBe(1)
    expect(row.never_made_a_friend).toBe(1)
    expect(row.made_a_friend).toBe(0)

    const [actor] = await actors()
    expect(actor.still_without_friends).toBe(true)
    expect(actor.first_friendship_at).toBeNull()
  })

  it('reads the friend graph, not telemetry', async () => {
    /*
     * The reason no client event was added. A friendship is a row; its absence
     * IS the cold-start state, so nobody can be missed by a browser closed in
     * disappointment thirty seconds after install, or by a client that never
     * got to flush.
     */
    await authenticate(alice)
    await authenticate(bob)
    await befriend(alice, bob)

    const rows = await actors()
    expect(rows.every((r) => r.still_without_friends === false)).toBe(true)
    expect(rows.every((r) => r.first_friendship_at !== null)).toBe(true)
  })

  it('reports the cold-start rate as the headline', async () => {
    await authenticate(alice)
    await authenticate(bob)
    await authenticate(carol)
    await authenticate(dave)
    // Only one pair connects; half the cohort never escapes.
    await befriend(alice, bob)

    const [row] = await funnel()
    expect(row.authenticated_actors).toBe(4)
    expect(row.never_made_a_friend).toBe(2)
    expect(Number(row.cold_start_rate)).toBeCloseTo(0.5, 3)
    expect(Number(row.friended_rate)).toBeCloseTo(0.5, 3)
  })
})

describe('a failed first edge cannot be excluded', () => {
  /**
   * THE ADVERSARIAL PROOF.
   *
   * Three users sign in. One makes a friend and goes all the way to a social
   * JOIN; two never make a friend and emit nothing further - which is exactly
   * what churning after an empty panel looks like.
   *
   * A funnel that divided each stage by the previous one would report a 100%
   * social-JOIN rate. This must report one in three.
   */
  it('divides every stage by everyone who signed in', async () => {
    await authenticate(alice)
    await authenticate(bob)
    await authenticate(carol)

    // Alice and Dave connect, so Alice escapes the cold start.
    await authenticate(dave)
    await befriend(alice, dave)
    await emit(alice, 'friend_presence_impression')
    await emit(alice, 'gravity_cluster_impression')

    // Bob and Carol do nothing more. They are the failure this test is about.
    const [row] = await funnel()

    expect(row.authenticated_actors).toBe(4)
    expect(row.never_made_a_friend).toBe(2)
    expect(row.saw_a_friend_watching).toBe(1)

    /*
     * One in four, not one in two. Conditioning on "users who made a friend"
     * would give 50% and would be describing a population chosen by the metric.
     */
    expect(row.saw_a_friend_watching / row.authenticated_actors).toBeCloseTo(0.25, 3)
  })

  it('keeps a churned user in the denominator forever', async () => {
    /*
     * The user who installs, signs in, sees nothing and never returns emits one
     * event in their life. They must still be counted - they are the entire
     * reason this view exists.
     */
    await authenticate(alice)
    await authenticate(bob)
    await authenticate(carol)

    const [row] = await funnel()
    expect(row.authenticated_actors).toBe(3)
    expect(row.never_made_a_friend).toBe(3)
    expect(row.joined_socially).toBe(0)
    expect(Number(row.cold_start_rate)).toBeCloseTo(1, 3)
  })

  it('does not require a second event to be counted', async () => {
    await authenticate(alice)
    const rows = await actors()
    expect(rows).toHaveLength(1)
    expect(rows[0].actor_id).toBe(alice.id)
  })
})

describe('the funnel obeys the rules every other view obeys', () => {
  it('excludes internal actors', async () => {
    await authenticate(alice)
    await db.root('update public.analytics_actors set is_internal = true where user_id = $1', [
      alice.id,
    ])
    expect(await funnel()).toHaveLength(0)
    expect(await actors()).toHaveLength(0)
  })

  it('suppresses rates below three actors, as NULL rather than zero', async () => {
    await authenticate(alice)
    await authenticate(bob)

    const [row] = await funnel()
    expect(row.authenticated_actors).toBe(2)
    expect(row.cold_start_rate).toBeNull()
    expect(row.friended_rate).toBeNull()
    // Counts are always shown; only the rates are suppressed.
    expect(row.never_made_a_friend).toBe(2)
  })

  it('separates builds, because a build bounds what its users could reach', async () => {
    await authenticate(alice, '0.8.0')
    await authenticate(bob, '0.9.0')

    const rows = await funnel()
    expect(rows.map((r) => r.first_app_version).sort()).toEqual(['0.8.0', '0.9.0'])
    expect(rows.every((r) => r.authenticated_actors === 1)).toBe(true)
  })

  it('ignores somebody who never authenticated', async () => {
    /*
     * Signing in is where the funnel starts. An actor with events but no
     * authentication is not somebody Watchside has failed to activate.
     */
    await db.root(
      'insert into public.analytics_actors (user_id) values ($1) on conflict (user_id) do nothing',
      [alice.id],
    )
    await emit(alice, 'extension_session_started')
    expect(await actors()).toHaveLength(0)
  })
})

describe('M3D and M5C semantics are borrowed, not redefined', () => {
  it('takes the social JOIN definition from M3D', async () => {
    /*
     * `m3d_social_joins_v` already encodes what social means - navigated, with
     * an attribution, with somebody else there. A second definition here would
     * drift, and the two would disagree about the most important step.
     */
    const [row] = await db.root<{ definition: string }>(
      `select pg_get_viewdef('public.activation_actor_v'::regclass) as definition`,
    )
    expect(row.definition).toContain('m3d_social_joins_v')
  })

  it('counts a real M3D social join for the actor who made it', async () => {
    await authenticate(alice)
    await db.root(
      `insert into public.analytics_events
         (actor_id, environment, event_name, occurred_at, app_version, attribution_id,
          destination_channel, properties)
       values ($1, 'private_beta', 'join_clicked', now(), '0.9.0', gen_random_uuid(),
               'somechannel', '{"navigated": true, "social_count": 2}'::jsonb)`,
      [alice.id],
    )

    const [actor] = await actors()
    expect(actor.first_social_join_at).not.toBeNull()

    const [row] = await funnel()
    expect(row.joined_socially).toBe(1)
  })

  it('does not count a solo JOIN as social', async () => {
    await authenticate(alice)
    await db.root(
      `insert into public.analytics_events
         (actor_id, environment, event_name, occurred_at, app_version, attribution_id,
          destination_channel, properties)
       values ($1, 'private_beta', 'join_clicked', now(), '0.9.0', gen_random_uuid(),
               'somechannel', '{"navigated": true, "social_count": 0}'::jsonb)`,
      [alice.id],
    )

    const [actor] = await actors()
    expect(actor.first_social_join_at).toBeNull()
  })

  it('leaves acquisition attribution alone', async () => {
    // Activation answers "did they reach value". Acquisition answers "how did
    // they arrive". Neither view may quietly become the other.
    const [row] = await db.root<{ definition: string }>(
      `select pg_get_viewdef('public.activation_funnel_v'::regclass) as definition`,
    )
    expect(row.definition).not.toContain('acquisition_attribution')
  })
})
