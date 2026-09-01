import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { createTestDb } from './harness'
import type { TestDb, TestUser } from './harness'

/**
 * Whether the growth loop can be evaluated at all.
 *
 * `referral_succeeded` and `badge_awarded` sat in the analytics contract, on
 * both sides, emitted by nothing, since 0026. So Watchside could tell you how
 * many invite links had been copied and nothing whatsoever about whether one had
 * ever worked - in a product whose entire thesis is that the social graph drives
 * discovery.
 *
 * THE M3D LESSON, APPLIED
 *
 * A gate proven only in its refusing direction is a gate that can silently
 * refuse everything. So every rule below is tested twice: that the invalid case
 * emits nothing, AND that the valid case actually emits. The second half is the
 * one that would have caught M3D's flush bug.
 *
 * The success rule is 0026's and is not restated here: attributed, then
 * friended, then activated. This tests that the EVENT follows the rule, never
 * that the rule is what it should be.
 */

let db: TestDb
let inviter: TestUser
let invitee: TestUser
let bystander: TestUser

const events = async (name: string, actor?: TestUser) =>
  db.root<{ actor_id: string; properties: Record<string, unknown>; session_id: string | null }>(
    `select actor_id, properties, session_id from public.analytics_events
      where event_name = $1 ${actor ? 'and actor_id = $2' : ''}`,
    actor ? [name, actor.id] : [name],
  )

/** The three conditions, applied through the real functions. */
async function attribute(from: TestUser, to: TestUser): Promise<string> {
  const [row] = await db.as<{ code: string }>(from, 'select public.my_invite_code() as code')
  const [claim] = await db.as<{ outcome: string }>(
    to,
    'select public.claim_invite($1) as outcome',
    [row.code],
  )
  return claim.outcome
}

async function befriend(a: TestUser, b: TestUser): Promise<void> {
  await db.root('select public.create_friendship($1, $2)', [a.id, b.id])
}

async function activate(user: TestUser): Promise<void> {
  await db.root('select public.apply_destinations($1, $2)', [user.id, ['lirik']])
}

beforeAll(async () => {
  db = await createTestDb()
}, 60_000)

afterAll(async () => {
  await db.close()
})

beforeEach(async () => {
  await db.reset()
  inviter = await db.createUser({ login: 'inviter_tv', displayName: 'Inviter' })
  invitee = await db.createUser({ login: 'invitee_tv', displayName: 'Invitee' })
  bystander = await db.createUser({ login: 'bystander_tv', displayName: 'Bystander' })
})

describe('referral_succeeded follows the rule, in both directions', () => {
  /**
   * THE SUCCESS PATH.
   *
   * Not "the guard refuses" - that a complete, genuine referral actually emits.
   */
  it('emits once when all three conditions are met', async () => {
    expect(await attribute(inviter, invitee)).toBe('attributed')
    await befriend(inviter, invitee)
    await activate(invitee)
    await db.root('select public.settle_referral($1)', [invitee.id])

    const rows = await events('referral_succeeded')
    expect(rows).toHaveLength(1)
    // The INVITER's event: theirs is the count that moves.
    expect(rows[0].actor_id).toBe(inviter.id)
    // A server decision, not something somebody did in a session.
    expect(rows[0].session_id).toBeNull()
  })

  it('emits nothing for attribution alone', async () => {
    await attribute(inviter, invitee)
    await db.root('select public.settle_referral($1)', [invitee.id])
    expect(await events('referral_succeeded')).toHaveLength(0)
  })

  /** Signing in and stopping is not a referral. */
  it('emits nothing when they never became friends', async () => {
    await attribute(inviter, invitee)
    await activate(invitee)
    await db.root('select public.settle_referral($1)', [invitee.id])
    expect(await events('referral_succeeded')).toHaveLength(0)
  })

  it('emits nothing when they never used the product', async () => {
    await attribute(inviter, invitee)
    await befriend(inviter, invitee)
    await db.root('select public.settle_referral($1)', [invitee.id])
    expect(await events('referral_succeeded')).toHaveLength(0)
  })

  /**
   * The anti-duplicate-credit rule, at the event layer. `succeeded_at` is
   * stamped once and the emission sits inside that same guard.
   */
  it('emits exactly once however many times settlement runs', async () => {
    await attribute(inviter, invitee)
    await befriend(inviter, invitee)
    await activate(invitee)
    for (let i = 0; i < 5; i += 1) {
      await db.root('select public.settle_referral($1)', [invitee.id])
    }
    expect(await events('referral_succeeded')).toHaveLength(1)
  })

  it('cannot be earned by referring yourself', async () => {
    const [row] = await db.as<{ code: string }>(inviter, 'select public.my_invite_code() as code')
    expect((await db.as(inviter, 'select public.claim_invite($1) as outcome', [row.code]))[0].outcome).toBe(
      'self',
    )
    await db.root('select public.settle_referral($1)', [inviter.id])
    expect(await events('referral_succeeded')).toHaveLength(0)
  })

  it('cannot be earned from an unknown code', async () => {
    expect(
      (await db.as(invitee, 'select public.claim_invite($1) as outcome', ['0000000000000000000000']))[0]
        .outcome,
    ).toBe('unknown')
    await befriend(inviter, invitee)
    await activate(invitee)
    await db.root('select public.settle_referral($1)', [invitee.id])
    expect(await events('referral_succeeded')).toHaveLength(0)
  })

  /** A second claim cannot move credit to somebody else. */
  it('credits only the first inviter', async () => {
    await attribute(inviter, invitee)
    expect(await attribute(bystander, invitee)).toBe('already')
    await befriend(inviter, invitee)
    await activate(invitee)
    await db.root('select public.settle_referral($1)', [invitee.id])

    const rows = await events('referral_succeeded')
    expect(rows).toHaveLength(1)
    expect(rows[0].actor_id).toBe(inviter.id)
  })

  /** Friendship with somebody else is not the intended connection. */
  it('is not satisfied by befriending a third party', async () => {
    await attribute(inviter, invitee)
    await befriend(bystander, invitee)
    await activate(invitee)
    await db.root('select public.settle_referral($1)', [invitee.id])
    expect(await events('referral_succeeded')).toHaveLength(0)
  })
})

describe('badge_awarded follows the award, in both directions', () => {
  it('emits when a badge is genuinely awarded', async () => {
    await db.root('select public.award_badge($1, $2, $3)', [
      inviter.id,
      'referrer_1',
      'test',
    ])
    const rows = await events('badge_awarded', inviter)
    expect(rows).toHaveLength(1)
    expect(rows[0].properties.badge_key).toBe('referrer_1')
  })

  /** A repeat award is a no-op, so it cannot be counted twice. */
  it('emits nothing on a repeat award', async () => {
    for (let i = 0; i < 3; i += 1) {
      await db.root('select public.award_badge($1, $2, $3)', [inviter.id, 'referrer_1', 'test'])
    }
    expect(await events('badge_awarded', inviter)).toHaveLength(1)
  })

  /** The end-to-end path: a real referral awards a real badge and says so. */
  it('emits alongside a completed referral', async () => {
    await attribute(inviter, invitee)
    await befriend(inviter, invitee)
    await activate(invitee)
    await db.root('select public.settle_referral($1)', [invitee.id])

    const badges = await events('badge_awarded', inviter)
    expect(badges.length).toBeGreaterThan(0)
    expect(await events('referral_succeeded', inviter)).toHaveLength(1)
  })
})

describe('the server emitter is a server thing', () => {
  it('is not callable by a client', async () => {
    let message = ''
    try {
      await db.as(invitee, "select public.analytics_emit_server($1, 'referral_succeeded')", [
        invitee.id,
      ])
    } catch (error) {
      message = (error as Error).message
    }
    expect(message).toMatch(/permission denied/i)
  })

  /** An event name outside the contract is refused, exactly as for a client. */
  it('refuses an event the contract does not know', async () => {
    await db.root("select public.analytics_emit_server($1, 'not_a_real_event')", [inviter.id])
    expect(await events('not_a_real_event')).toHaveLength(0)
  })

  it('does nothing for a null actor', async () => {
    await db.root("select public.analytics_emit_server(null, 'referral_succeeded')")
    expect(await events('referral_succeeded')).toHaveLength(0)
  })

  /**
   * The environment follows the actor rather than being invented. An event in
   * the wrong bucket is worse than a missing one, because every number is read
   * per environment.
   */
  it('records the environment the actor has actually been using', async () => {
    await db.root(
      'insert into public.analytics_actors (user_id) values ($1) on conflict do nothing',
      [inviter.id],
    )
    await db.root(
      `insert into public.analytics_events (actor_id, environment, event_name, occurred_at)
       values ($1, 'private_beta', 'extension_session_started', now())`,
      [inviter.id],
    )
    await db.root("select public.analytics_emit_server($1, 'referral_succeeded')", [inviter.id])

    const [row] = await db.root<{ environment: string }>(
      "select environment from public.analytics_events where event_name = 'referral_succeeded'",
    )
    expect(row.environment).toBe('private_beta')
  })

  it('falls back to production for an actor with no history', async () => {
    await db.root("select public.analytics_emit_server($1, 'referral_succeeded')", [inviter.id])
    const [row] = await db.root<{ environment: string }>(
      "select environment from public.analytics_events where event_name = 'referral_succeeded'",
    )
    expect(row.environment).toBe('production')
  })

  /** No names, no logins, no readable graph detail. */
  it('records no human-readable identity in the event', async () => {
    await attribute(inviter, invitee)
    await befriend(inviter, invitee)
    await activate(invitee)
    await db.root('select public.settle_referral($1)', [invitee.id])

    const rows = await events('referral_succeeded')
    const text = JSON.stringify(rows[0].properties)
    expect(text).toBe('{}')
    for (const forbidden of ['inviter_tv', 'invitee_tv', 'Inviter', 'Invitee']) {
      expect(text, forbidden).not.toContain(forbidden)
    }
  })
})
