import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { createTestDb } from './harness'
import type { TestDb, TestUser } from './harness'

/**
 * The growth loop, against real PostgreSQL as a real `authenticated` role.
 *
 * Three things are worth protecting here and the happy path is not one of them:
 *
 *   * the SOCIAL GRAPH must not leak. A suggestion is allowed to say "you have
 *     two friends in common"; it is not allowed to enumerate anybody's friends,
 *     route around a block, or surface somebody the caller could not otherwise
 *     see;
 *   * REFERRAL CREDIT must be impossible to duplicate. One row per invitee,
 *     ever, enforced by a primary key rather than by application care;
 *   * BADGES must be unforgeable. A client cannot award one, cannot award to
 *     somebody else, and cannot display one it has not earned.
 */

let db: TestDb
let alice: TestUser
let bob: TestUser
let carol: TestUser
let dave: TestUser

async function befriend(a: TestUser, b: TestUser): Promise<void> {
  await db.as(a, 'select public.send_friend_request($1)', [b.id])
  const rows = await db.as<{ request_id: string }>(
    b,
    `select request_id from public.list_friend_requests() where direction = 'incoming'`,
  )
  await db.as(b, 'select public.respond_to_friend_request($1, true)', [rows[0].request_id])
}

interface Suggestion {
  user_id: string
  display_name: string
  twitch_login: string | null
  mutual_count: number
}

const suggestionsFor = (viewer: TestUser) =>
  db.as<Suggestion>(viewer, 'select * from public.suggest_friends(20)')

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
  dave = await db.createUser({ login: 'dave_tv', displayName: 'Dave' })
})

// ================================================== mutual friend suggestions

describe('mutual friend suggestions', () => {
  /** Alice ↔ Bob, Bob ↔ Carol. Alice should be shown Carol. */
  it('suggests a friend of a friend', async () => {
    await befriend(alice, bob)
    await befriend(bob, carol)

    const rows = await suggestionsFor(alice)
    expect(rows.map((row) => row.user_id)).toEqual([carol.id])
    expect(Number(rows[0].mutual_count)).toBe(1)
  })

  it('counts several mutuals', async () => {
    await befriend(alice, bob)
    await befriend(alice, carol)
    await befriend(bob, dave)
    await befriend(carol, dave)

    const rows = await suggestionsFor(alice)
    expect(rows.map((row) => row.user_id)).toEqual([dave.id])
    expect(Number(rows[0].mutual_count)).toBe(2)
  })

  it('carries enough identity to be understandable', async () => {
    await befriend(alice, bob)
    await befriend(bob, carol)

    const [row] = await suggestionsFor(alice)
    expect(row.display_name).toBe('Carol')
    expect(row.twitch_login).toBe('carol_tv')
  })

  /**
   * Alice is a friend-of-a-friend of herself by construction - Bob's friend
   * list contains her - so the walk must exclude the caller explicitly.
   */
  it('never suggests the caller', async () => {
    await befriend(alice, bob)
    await befriend(bob, carol)
    const rows = await suggestionsFor(alice)
    expect(rows.map((row) => row.user_id)).not.toContain(alice.id)
    expect(rows.map((row) => row.user_id)).toEqual([carol.id])
  })

  it('never suggests an existing friend', async () => {
    await befriend(alice, bob)
    await befriend(bob, carol)
    await befriend(alice, carol)

    expect(await suggestionsFor(alice)).toEqual([])
  })

  it('is empty for somebody with no friends', async () => {
    expect(await suggestionsFor(alice)).toEqual([])
  })

  /** Two hops, and no further. Dave is three hops from Alice. */
  it('does not walk past friends-of-friends', async () => {
    await befriend(alice, bob)
    await befriend(bob, carol)
    await befriend(carol, dave)

    const rows = await suggestionsFor(alice)
    expect(rows.map((row) => row.user_id)).toEqual([carol.id])
  })

  /** Ordering must be stable, or the panel reshuffles under a cursor. */
  it('orders by mutual count, then display name', async () => {
    await befriend(alice, bob)
    await befriend(alice, carol)
    await befriend(bob, dave) // dave: 1 mutual
    await befriend(carol, dave) // dave: 2 mutuals
    const eve = await db.createUser({ login: 'eve_tv', displayName: 'Eve' })
    await befriend(bob, eve) // eve: 1 mutual

    const rows = await suggestionsFor(alice)
    expect(rows.map((row) => row.display_name)).toEqual(['Dave', 'Eve'])
  })

  // ------------------------------------------------------ blocks and privacy

  it('does not suggest somebody the caller blocked', async () => {
    await befriend(alice, bob)
    await befriend(bob, carol)
    await db.as(alice, 'select public.block_user($1)', [carol.id])

    expect(await suggestionsFor(alice)).toEqual([])
  })

  it('does not suggest somebody who blocked the caller', async () => {
    await befriend(alice, bob)
    await befriend(bob, carol)
    await db.as(carol, 'select public.block_user($1)', [alice.id])

    expect(await suggestionsFor(alice)).toEqual([])
  })

  it('does not suggest somebody with an outgoing request already open', async () => {
    await befriend(alice, bob)
    await befriend(bob, carol)
    await db.as(alice, 'select public.send_friend_request($1)', [carol.id])

    expect(await suggestionsFor(alice)).toEqual([])
  })

  it('does not suggest somebody with an incoming request already open', async () => {
    await befriend(alice, bob)
    await befriend(bob, carol)
    await db.as(carol, 'select public.send_friend_request($1)', [alice.id])

    expect(await suggestionsFor(alice)).toEqual([])
  })

  /**
   * The privacy decision, pinned. A suggestion says HOW MANY mutuals, never
   * WHO - naming them would publish a friendship neither party offered.
   */
  it('exposes a count and never a mutual friend’s identity', async () => {
    await befriend(alice, bob)
    await befriend(bob, carol)

    const rows = await db.as<Record<string, unknown>>(
      alice,
      'select * from public.suggest_friends(20)',
    )
    expect(Object.keys(rows[0]).sort()).toEqual([
      'avatar_url',
      'display_name',
      'mutual_count',
      'twitch_login',
      'user_id',
    ])
  })

  /** The caller cannot ask on somebody else's behalf: there is no parameter. */
  it('is seeded at the caller and takes no user parameter', async () => {
    await befriend(alice, bob)
    await befriend(bob, carol)
    // Carol has one friend (Bob) and one friend-of-friend (Alice).
    const rows = await suggestionsFor(carol)
    expect(rows.map((row) => row.user_id)).toEqual([alice.id])
  })

  it('can be added as a friend through the ordinary request path', async () => {
    await befriend(alice, bob)
    await befriend(bob, carol)

    const [suggestion] = await suggestionsFor(alice)
    await db.as(alice, 'select public.send_friend_request($1)', [suggestion.user_id])
    const requests = await db.as<{ direction: string }>(
      carol,
      'select direction from public.list_friend_requests()',
    )
    expect(requests.map((row) => row.direction)).toEqual(['incoming'])
  })
})

// ================================================================== invites

describe('invite codes', () => {
  const codeFor = async (user: TestUser) => {
    const [row] = await db.as<{ my_invite_code: string }>(
      user,
      'select public.my_invite_code()',
    )
    return row.my_invite_code
  }

  it('creates one on first use', async () => {
    const code = await codeFor(alice)
    expect(code).toMatch(/^[0-9ABCDEFGHJKMNPQRSTVWXYZ]{22}$/)
  })

  /** A link shared last week must keep working. */
  it('returns the same code every time', async () => {
    expect(await codeFor(alice)).toBe(await codeFor(alice))
  })

  it('gives different people different codes', async () => {
    expect(await codeFor(alice)).not.toBe(await codeFor(bob))
  })

  /** The code must not be derived from anything about the account. */
  it('does not contain the user id', async () => {
    const code = await codeFor(alice)
    expect(code).not.toContain(alice.id.slice(0, 8).toUpperCase())
  })

  it('is readable only by its owner', async () => {
    await codeFor(alice)
    const asBob = await db.as(bob, 'select * from public.invite_codes')
    expect(asBob).toEqual([])
  })

  it('cannot be written by a client', async () => {
    await expect(
      db.as(bob, `insert into public.invite_codes (user_id, code) values ($1, $2)`, [
        bob.id,
        '0123456789ABCDEFGHJKMN',
      ]),
    ).rejects.toThrow()
  })
})

// ================================================================ referrals

describe('claiming an invite', () => {
  const codeFor = async (user: TestUser) => {
    const [row] = await db.as<{ my_invite_code: string }>(user, 'select public.my_invite_code()')
    return row.my_invite_code
  }
  const claim = async (user: TestUser, code: string) => {
    const [row] = await db.as<{ claim_invite: string }>(user, 'select public.claim_invite($1)', [
      code,
    ])
    return row.claim_invite
  }

  it('attributes a valid code', async () => {
    expect(await claim(bob, await codeFor(alice))).toBe('attributed')
  })

  /** One row per invitee, ever. The anti-duplicate-credit rule. */
  it('refuses a second claim by the same account', async () => {
    await claim(bob, await codeFor(alice))
    expect(await claim(bob, await codeFor(carol))).toBe('already')

    const rows = await db.root<{ inviter_id: string }>(
      'select inviter_id from public.referrals where invitee_id = $1',
      [bob.id],
    )
    expect(rows).toHaveLength(1)
    expect(rows[0].inviter_id).toBe(alice.id)
  })

  it('refuses your own link', async () => {
    expect(await claim(alice, await codeFor(alice))).toBe('self')
  })

  it('refuses an unknown code', async () => {
    expect(await claim(bob, '0123456789ABCDEFGHJKMN')).toBe('unknown')
  })

  it('refuses a malformed code without touching the table', async () => {
    expect(await claim(bob, 'nope')).toBe('unknown')
    expect(await db.root('select 1 from public.referrals')).toEqual([])
  })

  /** A block is not routed around by an invite. */
  it('refuses when the pair is blocked', async () => {
    const code = await codeFor(alice)
    await db.as(alice, 'select public.block_user($1)', [bob.id])
    expect(await claim(bob, code)).toBe('blocked')
  })

  /** Possession of a code grants nothing at all. */
  it('creates no friendship and no visibility', async () => {
    await claim(bob, await codeFor(alice))

    const friends = await db.as(bob, 'select * from public.list_friends()')
    expect(friends).toEqual([])
    const [present] = await db.as<{ is_friend: boolean }>(bob, 'select public.is_friend($1)', [
      alice.id,
    ])
    expect(present.is_friend).toBe(false)
  })

  it('lets each party see their own referral row and no others', async () => {
    await claim(bob, await codeFor(alice))
    expect(await db.as(alice, 'select * from public.referrals')).toHaveLength(1)
    expect(await db.as(bob, 'select * from public.referrals')).toHaveLength(1)
    expect(await db.as(carol, 'select * from public.referrals')).toEqual([])
  })
})

// ================================================= the successful-referral rule

describe('what makes a referral successful', () => {
  const codeFor = async (user: TestUser) => {
    const [row] = await db.as<{ my_invite_code: string }>(user, 'select public.my_invite_code()')
    return row.my_invite_code
  }
  const claim = (user: TestUser, code: string) =>
    db.as(user, 'select public.claim_invite($1)', [code])
  const activate = (user: TestUser) =>
    db.as(user, `select public.report_destinations(array['lirik'])`)
  const state = async (invitee: TestUser) => {
    const [row] = await db.root<{
      friended_at: string | null
      activated_at: string | null
      succeeded_at: string | null
    }>('select friended_at, activated_at, succeeded_at from public.referrals where invitee_id = $1', [
      invitee.id,
    ])
    return row
  }
  const successful = async (inviter: TestUser) => {
    const [row] = await db.as<{ successful: number }>(
      inviter,
      'select successful from public.my_referral_summary()',
    )
    return Number(row.successful)
  }

  it('is not successful on attribution alone', async () => {
    await claim(bob, await codeFor(alice))
    expect((await state(bob)).succeeded_at).toBeNull()
    expect(await successful(alice)).toBe(0)
  })

  it('is not successful on friendship alone', async () => {
    await claim(bob, await codeFor(alice))
    await befriend(alice, bob)
    const row = await state(bob)
    expect(row.friended_at).not.toBeNull()
    expect(row.succeeded_at).toBeNull()
    expect(await successful(alice)).toBe(0)
  })

  it('is not successful on activation alone', async () => {
    await claim(bob, await codeFor(alice))
    await activate(bob)
    const row = await state(bob)
    expect(row.activated_at).not.toBeNull()
    expect(row.succeeded_at).toBeNull()
    expect(await successful(alice)).toBe(0)
  })

  it('succeeds once all three hold', async () => {
    await claim(bob, await codeFor(alice))
    await befriend(alice, bob)
    await activate(bob)
    expect((await state(bob)).succeeded_at).not.toBeNull()
    expect(await successful(alice)).toBe(1)
  })

  /** Order must not matter: activation first, then friendship. */
  it('succeeds when activation comes before the friendship', async () => {
    await claim(bob, await codeFor(alice))
    await activate(bob)
    await befriend(alice, bob)
    expect((await state(bob)).succeeded_at).not.toBeNull()
    expect(await successful(alice)).toBe(1)
  })

  /** And when the friendship existed before the code was claimed. */
  it('succeeds when the friendship predates the claim', async () => {
    await befriend(alice, bob)
    await activate(bob)
    await claim(bob, await codeFor(alice))
    expect((await state(bob)).succeeded_at).not.toBeNull()
    expect(await successful(alice)).toBe(1)
  })

  /** Reinstalling, re-reporting, refreshing: still exactly one credit. */
  it('cannot be credited twice', async () => {
    await claim(bob, await codeFor(alice))
    await befriend(alice, bob)
    await activate(bob)
    const first = (await state(bob)).succeeded_at

    for (let round = 0; round < 5; round += 1) await activate(bob)
    await db.as(bob, 'select public.claim_invite($1)', [await codeFor(alice)])

    expect((await state(bob)).succeeded_at).toEqual(first)
    expect(await successful(alice)).toBe(1)
  })

  /** Publishing nothing is not activation. */
  it('is not activated by an empty destination set', async () => {
    await claim(bob, await codeFor(alice))
    await befriend(alice, bob)
    await db.as(bob, `select public.report_destinations(array[]::text[])`)
    expect((await state(bob)).activated_at).toBeNull()
  })

  /** The legacy singleton path activates too - an old client still counts. */
  it('is activated by a v0.4.1 client publishing its one channel', async () => {
    await claim(bob, await codeFor(alice))
    await befriend(alice, bob)
    await db.as(bob, `select public.report_presence('twitch', 'lirik')`)
    expect((await state(bob)).succeeded_at).not.toBeNull()
  })

  it('counts several invitees separately', async () => {
    const code = await codeFor(alice)
    for (const invitee of [bob, carol, dave]) {
      await claim(invitee, code)
      await befriend(alice, invitee)
      await activate(invitee)
    }
    expect(await successful(alice)).toBe(3)
  })
})

// ================================================================== badges

describe('badges', () => {
  const codeFor = async (user: TestUser) => {
    const [row] = await db.as<{ my_invite_code: string }>(user, 'select public.my_invite_code()')
    return row.my_invite_code
  }
  const refer = async (inviter: TestUser, invitee: TestUser) => {
    await db.as(invitee, 'select public.claim_invite($1)', [await codeFor(inviter)])
    await befriend(inviter, invitee)
    await db.as(invitee, `select public.report_destinations(array['lirik'])`)
  }
  const badgesOf = async (user: TestUser) => {
    const rows = await db.as<{ badge_key: string }>(user, 'select badge_key from public.my_badges()')
    return rows.map((row) => row.badge_key).sort()
  }

  it('awards the first milestone on the first successful referral', async () => {
    await refer(alice, bob)
    expect(await badgesOf(alice)).toEqual(['referrer_1'])
  })

  it('awards nothing before the first success', async () => {
    await db.as(bob, 'select public.claim_invite($1)', [await codeFor(alice)])
    expect(await badgesOf(alice)).toEqual([])
  })

  /** Crossing several thresholds at once must award all of them. */
  it('awards every crossed threshold', async () => {
    const invitees: TestUser[] = []
    for (let index = 0; index < 5; index += 1) {
      invitees.push(await db.createUser({ login: `user${index}_tv`, displayName: `User ${index}` }))
    }
    for (const invitee of invitees) await refer(alice, invitee)

    expect(await badgesOf(alice)).toEqual(['referrer_1', 'referrer_5'])
  })

  it('is idempotent across repeated settles', async () => {
    await refer(alice, bob)
    await db.as(bob, `select public.report_destinations(array['lirik'])`)
    await db.as(bob, `select public.report_destinations(array['shroud'])`)

    const rows = await db.root('select 1 from public.user_badges where user_id = $1', [alice.id])
    expect(rows).toHaveLength(1)
  })

  it('is permanent once earned', async () => {
    await refer(alice, bob)
    await db.as(alice, 'select public.remove_friend($1)', [bob.id])
    expect(await badgesOf(alice)).toEqual(['referrer_1'])
  })

  // ---------------------------------------------------------- authorization

  it('cannot be awarded by a client', async () => {
    await expect(
      db.as(bob, `insert into public.user_badges (user_id, badge_key) values ($1, 'referrer_1')`, [
        bob.id,
      ]),
    ).rejects.toThrow()
  })

  it('cannot be awarded through the internal function', async () => {
    await expect(
      db.as(bob, `select public.award_badge($1, 'referrer_25', 'nope')`, [bob.id]),
    ).rejects.toThrow()
  })

  it('cannot display a badge it has not earned', async () => {
    await expect(
      db.as(bob, `select public.set_displayed_badge('referrer_25')`),
    ).rejects.toThrow(/not earned/)
  })

  it('can display one it has earned, and clear it again', async () => {
    await refer(alice, bob)
    await db.as(alice, `select public.set_displayed_badge('referrer_1')`)
    const shown = await db.as<{ badge_key: string; displayed: boolean }>(
      alice,
      'select badge_key, displayed from public.my_badges()',
    )
    expect(shown.find((row) => row.badge_key === 'referrer_1')?.displayed).toBe(true)

    await db.as(alice, 'select public.set_displayed_badge(null)')
    const cleared = await db.as<{ displayed: boolean }>(
      alice,
      'select displayed from public.my_badges()',
    )
    expect(cleared.every((row) => !row.displayed)).toBe(true)
  })

  /** Badges follow the social boundary: a stranger sees nothing. */
  it('is visible to a friend and not to a stranger', async () => {
    await refer(alice, bob)
    const asFriend = await db.as(bob, 'select * from public.user_badges where user_id = $1', [
      alice.id,
    ])
    expect(asFriend).toHaveLength(1)

    const asStranger = await db.as(carol, 'select * from public.user_badges where user_id = $1', [
      alice.id,
    ])
    expect(asStranger).toEqual([])
  })

  /** Definitions describe what exists, not who holds it. */
  it('lets anybody read the definitions', async () => {
    const rows = await db.as(carol, 'select * from public.badge_definitions')
    expect(rows.length).toBeGreaterThanOrEqual(5)
  })

  it('marks every referral badge as Watchside-issued, never Twitch', async () => {
    const rows = await db.as<{ issuer: string }>(
      carol,
      `select issuer from public.badge_definitions where key like 'referrer_%'`,
    )
    expect(rows.every((row) => row.issuer === 'kickback')).toBe(true)
  })
})
