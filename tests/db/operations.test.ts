import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { createTestDb } from './harness'
import type { TestDb, TestUser } from './harness'

/**
 * The operational gaps M6B closed, against real PostgreSQL.
 *
 * TWO THINGS, AND BOTH FAIL QUIETLY
 *
 * A missing rate budget does not break anything - it works perfectly, for the
 * spammer. And a view that does not exist does not fail either; it simply means
 * that during an incident somebody writes SQL from memory under pressure.
 *
 * Both directions are proved throughout: the budget must REFUSE the twenty-first
 * new request and must still ALLOW everything a real person does, which is the
 * half that would make this a bad fix if it were wrong.
 */

let db: TestDb
let alice: TestUser
let bob: TestUser
let carol: TestUser

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
})

const request = (from: TestUser, to: TestUser) =>
  db.as<{ send_friend_request: string }>(from, 'select public.send_friend_request($1)', [to.id])

/** Enough strangers to exhaust a budget against. */
async function strangers(count: number): Promise<TestUser[]> {
  const made: TestUser[] = []
  for (let i = 0; i < count; i += 1) {
    made.push(await db.createUser({ login: `stranger${i}`, displayName: `Stranger ${i}` }))
  }
  return made
}

describe('friend requests are budgeted', () => {
  it('lets an ordinary new user add people freely', async () => {
    /*
     * The half that matters most. A person who installs Watchside and adds
     * their friends must never meet this limit - blocking a genuine
     * enthusiastic new user costs far more than letting a spammer send twenty
     * rather than five.
     */
    const people = await strangers(15)
    for (const person of people) {
      const [{ send_friend_request: outcome }] = await request(alice, person)
      expect(outcome).toBe('requested')
    }
  })

  it('refuses once the hourly budget is spent', async () => {
    const people = await strangers(20)
    for (const person of people) await request(alice, person)

    const [oneMore] = await strangers(1)
    await expect(request(alice, oneMore)).rejects.toThrow(/too quickly/i)
  })

  it('budgets the person, not everybody', async () => {
    // Alice exhausting her budget must not stop Bob using the product.
    const people = await strangers(20)
    for (const person of people) await request(alice, person)

    const [{ send_friend_request: outcome }] = await request(bob, carol)
    expect(outcome).toBe('requested')
  })
})

describe('the budget charges for strangers contacted, not clicks', () => {
  it('does not charge for pressing Add again on a pending request', async () => {
    /*
     * An impatient second click must be free, or a user who does not see the
     * state change immediately spends their budget on one person.
     */
    await request(alice, bob)
    for (let i = 0; i < 30; i += 1) {
      const [{ send_friend_request: outcome }] = await request(alice, bob)
      expect(outcome).toBe('already_requested')
    }
    // And the budget is untouched: a fresh stranger still works.
    const [fresh] = await strangers(1)
    const [{ send_friend_request: outcome }] = await request(alice, fresh)
    expect(outcome).toBe('requested')
  })

  it('does not charge for accepting somebody who already asked', async () => {
    /*
     * Mutual intent resolves to a friendship rather than a request, and must
     * never be refused for budget reasons - it creates nothing in anybody's
     * inbox.
     */
    const people = await strangers(20)
    for (const person of people) await request(alice, person)

    // Bob asks Alice; Alice pressing Add is an acceptance, not a new request.
    await request(bob, alice)
    const [{ send_friend_request: outcome }] = await request(alice, bob)
    expect(outcome).toBe('friends')
  })

  it('does not charge for somebody who is already a friend', async () => {
    await request(alice, bob)
    await db.as(bob, 'select public.send_friend_request($1)', [alice.id])

    const people = await strangers(20)
    for (const person of people) await request(alice, person).catch(() => {})

    const [{ send_friend_request: outcome }] = await request(alice, bob)
    expect(outcome).toBe('already_friends')
  })
})

describe('everything else about friend requests is unchanged', () => {
  it.each([
    ['adding yourself', 'you cannot add yourself'],
  ])('still refuses %s', async (_label, message) => {
    await expect(
      db.as(alice, 'select public.send_friend_request($1)', [alice.id]),
    ).rejects.toThrow(new RegExp(message, 'i'))
  })

  it('still refuses a user that does not exist', async () => {
    await expect(
      db.as(alice, 'select public.send_friend_request($1)', [
        '00000000-0000-0000-0000-000000000000',
      ]),
    ).rejects.toThrow(/not found/i)
  })

  it('still refuses across a block, without saying which direction', async () => {
    await db.as(bob, 'select public.block_user($1)', [alice.id])
    await expect(request(alice, bob)).rejects.toThrow(/cannot add that user/i)
  })
})

// --------------------------------------------------------------- the views

describe('client failures are readable during an incident', () => {
  async function failure(user: TestUser, context: string, code: string): Promise<void> {
    await db.root(
      `insert into public.analytics_actors (user_id) values ($1) on conflict do nothing`,
      [user.id],
    )
    await db.root(
      `insert into public.analytics_events
         (actor_id, environment, event_name, occurred_at, properties)
       values ($1, 'production', 'client_error', now(), jsonb_build_object('context', $2::text, 'code', $3::text))`,
      [user.id, context, code],
    )
  }

  it('groups failures by context and code', async () => {
    await failure(alice, 'refresh', 'network')
    await failure(alice, 'refresh', 'network')
    await failure(bob, 'search', 'refused')

    const rows = await db.root<{ context: string; code: string; failures: number; actors: number }>(
      'select * from public.ops_client_failures_v order by context',
    )
    const refresh = rows.find((r) => r.context === 'refresh')
    expect(refresh?.failures).toBe(2)
    expect(refresh?.actors).toBe(1)
  })

  it('separates one unlucky person from an outage', async () => {
    /*
     * The distinction the view exists for. Ten failures from one person is a
     * bad connection; ten from ten people is an incident, and a raw count
     * cannot tell them apart.
     */
    for (let i = 0; i < 10; i += 1) await failure(alice, 'refresh', 'network')
    const [oneUnluckyPerson] = await db.root<{ failures: number; actors: number }>(
      `select * from public.ops_client_failures_v where context = 'refresh'`,
    )
    expect(oneUnluckyPerson.failures).toBe(10)
    expect(oneUnluckyPerson.actors).toBe(1)

    await failure(bob, 'refresh', 'network')
    await failure(carol, 'refresh', 'network')
    const [spreading] = await db.root<{ actors: number }>(
      `select * from public.ops_client_failures_v where context = 'refresh'`,
    )
    expect(spreading.actors).toBe(3)
  })

  it('excludes internal actors, who test failure paths on purpose', async () => {
    await db.root(
      `insert into public.analytics_actors (user_id, is_internal) values ($1, true)
         on conflict (user_id) do update set is_internal = true`,
      [alice.id],
    )
    await failure(alice, 'refresh', 'network')

    const rows = await db.root('select * from public.ops_client_failures_v')
    expect(rows).toHaveLength(0)
  })
})

describe('service health is answerable in one query', () => {
  async function event(user: TestUser, name: string, properties = {}): Promise<void> {
    await db.root(
      `insert into public.analytics_actors (user_id) values ($1) on conflict do nothing`,
      [user.id],
    )
    await db.root(
      `insert into public.analytics_events
         (actor_id, environment, event_name, occurred_at, properties)
       values ($1, 'production', $2::text, now(), $3::jsonb)`,
      [user.id, name, JSON.stringify(properties)],
    )
  }

  it('counts who was active, who authenticated and who joined', async () => {
    await event(alice, 'authenticated_session_started', { friend_count: 2, group_count: 0 })
    await event(alice, 'join_clicked')
    await event(bob, 'authenticated_session_started', { friend_count: 0, group_count: 0 })

    const [row] = await db.root<{
      active_actors: number
      authenticated_actors: number
      joining_actors: number
    }>('select * from public.ops_health_v')

    expect(row.active_actors).toBe(2)
    expect(row.authenticated_actors).toBe(2)
    expect(row.joining_actors).toBe(1)
  })

  it('separates a degraded surface from a person who cannot use Watchside', async () => {
    /*
     * `unauthenticated` and `network` mean the product is unusable. A metadata
     * fetch failing degrades one surface while everything else works, and
     * counting them the same way would make every minor outage look total.
     */
    await event(alice, 'client_error', { context: 'metadata.fetch', code: 'unknown' })
    await event(bob, 'client_error', { context: 'refresh', code: 'unauthenticated' })

    const [row] = await db.root<{ actors_with_any_failure: number; actors_blocked: number }>(
      'select * from public.ops_health_v',
    )
    expect(row.actors_with_any_failure).toBe(2)
    expect(row.actors_blocked).toBe(1)
  })

  it('encodes no thresholds, because there is no baseline to set them from', async () => {
    // The view reports counts and nothing else. A number written in today would
    // be a guess wearing an alert's clothing.
    const [row] = await db.root<{ definition: string }>(
      `select pg_get_viewdef('public.ops_health_v'::regclass, true) as definition`,
    )
    expect(String(row.definition)).not.toMatch(/>\s*\d+|<\s*\d+|threshold|alert/i)
  })
})
