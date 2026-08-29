import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { createTestDb } from './harness'
import type { TestDb, TestUser } from './harness'

/**
 * Who may learn which badge somebody chose to show.
 *
 * The whole risk in this projection is that it becomes a public profile
 * directory by accident. It returns one fact - who is displaying which badge -
 * and the only interesting questions are who can read it and what else leaks
 * out beside it. Both are tested here against real PostgreSQL as a real
 * `authenticated` role.
 */

let db: TestDb
let alice: TestUser
let bob: TestUser
let carol: TestUser

async function befriend(a: TestUser, b: TestUser): Promise<void> {
  await db.as(a, 'select public.send_friend_request($1)', [b.id])
  const rows = await db.as<{ request_id: string }>(
    b,
    `select request_id from public.list_friend_requests() where direction = 'incoming'`,
  )
  await db.as(b, 'select public.respond_to_friend_request($1, true)', [rows[0].request_id])
}

/** Give somebody a badge the way the product does: an actual referral. */
async function earnBadge(inviter: TestUser, invitee: TestUser): Promise<void> {
  const [row] = await db.as<{ my_invite_code: string }>(
    inviter,
    'select public.my_invite_code()',
  )
  await db.as(invitee, 'select public.claim_invite($1)', [row.my_invite_code])
  await befriend(inviter, invitee)
  await db.as(invitee, `select public.report_destinations(array['lirik'])`)
}

interface Displayed {
  user_id: string
  badge_key: string
  name: string
  icon: string
  issuer: string
}

const seenBy = (viewer: TestUser) =>
  db.as<Displayed>(viewer, 'select * from public.list_displayed_badges()')

beforeAll(async () => {
  db = await createTestDb()
}, 90_000)

afterAll(async () => {
  await db.close()
})

beforeEach(async () => {
  await db.reset()
  alice = await db.createUser({ login: 'alice_tv', displayName: 'Alice' })
  bob = await db.createUser({ login: 'bob_tv', displayName: 'Bob' })
  carol = await db.createUser({ login: 'carol_tv', displayName: 'Carol' })
})

// ------------------------------------------------------------- who may read

describe('who can see a displayed badge', () => {
  /** Alice refers Bob, earns referrer_1, and shows it. They are now friends. */
  async function aliceShowsHerBadge(): Promise<void> {
    await earnBadge(alice, bob)
    await db.as(alice, `select public.set_displayed_badge('referrer_1')`)
  }

  it('lets the owner see their own', async () => {
    await aliceShowsHerBadge()
    const rows = await seenBy(alice)
    expect(rows.map((row) => row.user_id)).toContain(alice.id)
    expect(rows.find((row) => row.user_id === alice.id)?.badge_key).toBe('referrer_1')
  })

  it('lets an accepted friend see it', async () => {
    await aliceShowsHerBadge()
    const rows = await seenBy(bob)
    expect(rows.find((row) => row.user_id === alice.id)?.badge_key).toBe('referrer_1')
  })

  it('does not let an unrelated user see it', async () => {
    await aliceShowsHerBadge()
    const rows = await seenBy(carol)
    expect(rows.map((row) => row.user_id)).not.toContain(alice.id)
  })

  /** A block removes a badge for the same reason it removes presence. */
  it('does not let somebody the owner blocked see it', async () => {
    await aliceShowsHerBadge()
    await db.as(alice, 'select public.block_user($1)', [bob.id])
    const rows = await seenBy(bob)
    expect(rows.map((row) => row.user_id)).not.toContain(alice.id)
  })

  it('does not let somebody who blocked the owner see it', async () => {
    await aliceShowsHerBadge()
    await db.as(bob, 'select public.block_user($1)', [alice.id])
    const rows = await seenBy(bob)
    expect(rows.map((row) => row.user_id)).not.toContain(alice.id)
  })

  /** There is no user parameter, so nobody can ask about an arbitrary account. */
  it('takes no user parameter at all', async () => {
    await aliceShowsHerBadge()
    await expect(
      db.as(carol, 'select * from public.list_displayed_badges($1)', [alice.id]),
    ).rejects.toThrow()
  })
})

// ------------------------------------------------------- what it returns

describe('what a displayed badge projection contains', () => {
  it('returns nothing when no badge is selected', async () => {
    await earnBadge(alice, bob)
    // Earned, never equipped.
    expect(await seenBy(bob)).toEqual([])
  })

  it('disappears the moment display is disabled', async () => {
    await earnBadge(alice, bob)
    await db.as(alice, `select public.set_displayed_badge('referrer_1')`)
    expect((await seenBy(bob)).map((row) => row.user_id)).toContain(alice.id)

    await db.as(alice, 'select public.set_displayed_badge(null)')
    expect((await seenBy(bob)).map((row) => row.user_id)).not.toContain(alice.id)
  })

  /**
   * The join to user_badges is the ownership check. A preference naming a badge
   * that is not held produces no row, even if it were set behind the RPC's back.
   */
  it('cannot surface a badge that is not owned', async () => {
    await befriend(alice, bob)
    // Set directly as the owner, bypassing set_displayed_badge's own refusal.
    await db.root(
      `update public.user_preferences set displayed_badge_key = 'referrer_25' where user_id = $1`,
      [alice.id],
    )
    expect(await seenBy(bob)).toEqual([])
  })

  it('refuses to equip an unearned badge through the RPC', async () => {
    await befriend(alice, bob)
    await expect(
      db.as(alice, `select public.set_displayed_badge('referrer_25')`),
    ).rejects.toThrow(/not earned/)
  })

  /** Exactly the fields the chip needs, and not one more. */
  it('exposes no other preference field', async () => {
    await earnBadge(alice, bob)
    await db.as(alice, `select public.set_displayed_badge('referrer_1')`)

    const rows = await db.as<Record<string, unknown>>(
      bob,
      'select * from public.list_displayed_badges()',
    )
    expect(Object.keys(rows[0]).sort()).toEqual([
      'badge_key',
      'icon',
      'issuer',
      'name',
      'user_id',
    ])
  })

  it('leaks no presence visibility preference', async () => {
    await earnBadge(alice, bob)
    await db.as(alice, `select public.set_presence_visibility('invisible')`)
    await db.as(alice, `select public.set_displayed_badge('referrer_1')`)

    const rows = await db.as<Record<string, unknown>>(
      bob,
      'select * from public.list_displayed_badges()',
    )
    for (const row of rows) {
      expect(Object.keys(row)).not.toContain('presence_visibility')
    }
  })

  /** user_preferences itself stays self-only. The projection did not widen it. */
  it('does not make user_preferences readable', async () => {
    await earnBadge(alice, bob)
    await db.as(alice, `select public.set_displayed_badge('referrer_1')`)

    const rows = await db.as(bob, 'select * from public.user_preferences where user_id = $1', [
      alice.id,
    ])
    expect(rows).toEqual([])
  })

  it('says the badge is Kickback-issued', async () => {
    await earnBadge(alice, bob)
    await db.as(alice, `select public.set_displayed_badge('referrer_1')`)
    const [row] = await seenBy(bob)
    expect(row.issuer).toBe('kickback')
    expect(row.name).toBe('Connector')
    expect(row.icon).toBe('🔗')
  })

  it('returns at most one row per person', async () => {
    // Five referrals earns two badges; only the chosen one is projected.
    for (let index = 0; index < 5; index += 1) {
      const invitee = await db.createUser({
        login: `user${index}_tv`,
        displayName: `User ${index}`,
      })
      await earnBadge(alice, invitee)
    }
    await db.as(alice, `select public.set_displayed_badge('referrer_5')`)

    const rows = (await seenBy(alice)).filter((row) => row.user_id === alice.id)
    expect(rows).toHaveLength(1)
    expect(rows[0].badge_key).toBe('referrer_5')
  })
})
