import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { createTestDb } from './harness'
import type { TestDb, TestUser } from './harness'

/**
 * The first beta group, rebuilt exactly, and every step of participation run
 * as every member.
 *
 * WHY THIS EXISTS, AND WHAT IT DOES NOT PROVE
 *
 * An external tester could see a group and could not participate in it. The
 * investigation eliminated the entire server-side hypothesis space by
 * executing this topology against the real migrations as each user under real
 * RLS: membership, invite/accept, list, roster, send, read, and the difference
 * between SELECT and INSERT authority. Everything passed, which moved the
 * search to the client - where it remains open.
 *
 * See docs/reports/friends-beta-investigation-2026-08-27.md §2 and §9.
 *
 * So this file is a GUARD, not a reproduction. It passes today. Its job is to
 * keep the elimination true: if a later change to RLS, to the block predicates,
 * or to any group RPC would make a legitimate member unable to take part, this
 * fails and the incident's status has to be reopened with evidence rather than
 * re-argued from memory.
 *
 * WHAT MAKES THE TOPOLOGY SPECIFIC
 *
 * The owner is friends with both testers; the two testers are NOT friends with
 * each other. That is the case where seeing another member's `public.users`
 * row depends on `shares_group_with` rather than on `is_friend` - and
 * `list_group_messages` inner-joins `public.users`, so a member who could not
 * see a sender would silently lose that sender's messages with no error at all.
 * A topology where everybody is friends would not test that.
 */

let db: TestDb
/** The group owner. Friends with both testers. */
let owner: TestUser
/** A tester. Friends with the owner only. */
let testerA: TestUser
/** The other tester. Friends with the owner only. Not a friend of testerA. */
let testerB: TestUser

async function befriend(a: TestUser, b: TestUser): Promise<void> {
  await db.as(a, 'select public.send_friend_request($1)', [b.id])
  const rows = await db.as<{ request_id: string }>(
    b,
    `select request_id from public.list_friend_requests() where direction = 'incoming'`,
  )
  await db.as(b, 'select public.respond_to_friend_request($1, true)', [rows[0].request_id])
}

async function invite(group: string, target: TestUser): Promise<void> {
  await db.as(owner, 'select public.invite_to_group($1, $2)', [group, target.id])
  const [row] = await db.as<{ invite_id: string }>(
    target,
    'select invite_id from public.list_group_invites()',
  )
  await db.as(target, 'select public.respond_to_group_invite($1, true)', [row.invite_id])
}

beforeAll(async () => {
  db = await createTestDb()
}, 60_000)

afterAll(async () => {
  await db.close()
})

beforeEach(async () => {
  await db.reset()
  owner = await db.createUser({ login: 'anoterostv', displayName: 'AnoterosTV' })
  testerA = await db.createUser({ login: 'wtfchuck27', displayName: 'wtfchuck27' })
  testerB = await db.createUser({ login: 'ohjuliego', displayName: 'ohjuliego' })
  await befriend(owner, testerA)
  await befriend(owner, testerB)
})

/** Builds the group and returns its id, with both testers accepted in. */
async function betaGroup(): Promise<string> {
  const [row] = await db.as<{ create_group: string }>(owner, 'select public.create_group($1)', [
    'Kickback Beta',
  ])
  await invite(row.create_group, testerA)
  await invite(row.create_group, testerB)
  return row.create_group
}

describe('the beta group topology', () => {
  it('leaves the two testers as non-friends, which is the case being tested', async () => {
    await betaGroup()
    const [{ is_friend: friends }] = await db.as<{ is_friend: boolean }>(
      testerA,
      'select public.is_friend($1)',
      [testerB.id],
    )
    expect(friends).toBe(false)
  })

  it('gives every member the group, with the full member count', async () => {
    const group = await betaGroup()
    for (const who of [owner, testerA, testerB]) {
      const rows = await db.as<{ group_id: string; member_count: number }>(
        who,
        'select group_id, member_count from public.list_groups()',
      )
      expect(rows).toHaveLength(1)
      expect(rows[0].group_id).toBe(group)
      expect(rows[0].member_count).toBe(3)
    }
  })

  it('gives every member the whole roster', async () => {
    const group = await betaGroup()
    for (const who of [owner, testerA, testerB]) {
      const rows = await db.as(who, 'select * from public.list_group_members($1)', [group])
      expect(rows).toHaveLength(3)
    }
  })

  it('reports every member as a member', async () => {
    const group = await betaGroup()
    for (const who of [owner, testerA, testerB]) {
      const [row] = await db.as<{ is_group_member: boolean }>(
        who,
        'select public.is_group_member($1)',
        [group],
      )
      expect(row.is_group_member).toBe(true)
    }
  })

  it('lets every member send', async () => {
    const group = await betaGroup()
    for (const who of [owner, testerA, testerB]) {
      const [row] = await db.as<{ send_group_message: string }>(
        who,
        'select public.send_group_message($1, $2)',
        [group, `hello from ${who.login}`],
      )
      expect(row.send_group_message).toBeTruthy()
    }
  })

  /** The participation question, asked of the reader every client uses. */
  it('lets every member read everything that was said', async () => {
    const group = await betaGroup()
    for (const who of [owner, testerA, testerB]) {
      await db.as(who, 'select public.send_group_message($1, $2)', [group, `from ${who.login}`])
    }

    for (const who of [owner, testerA, testerB]) {
      const rows = await db.as<{ body: string; display_name: string }>(
        who,
        'select body, display_name from public.list_group_messages($1, 100)',
        [group],
      )
      expect(rows).toHaveLength(3)
      expect(rows.map((row) => row.display_name).sort()).toEqual([
        'AnoterosTV',
        'ohjuliego',
        'wtfchuck27',
      ])
    }
  })

  /**
   * Realtime delivers the raw row, so the POLICY has to hold on its own -
   * `list_group_messages` is not the only delivery path, and a filter that
   * lived only in the reader would hold on reload and fail live.
   */
  it('lets every member read the raw table under RLS, not only through the RPC', async () => {
    const group = await betaGroup()
    for (const who of [owner, testerA, testerB]) {
      await db.as(who, 'select public.send_group_message($1, $2)', [group, `from ${who.login}`])
    }

    for (const who of [owner, testerA, testerB]) {
      const rows = await db.as<{ n: number }>(
        who,
        'select count(*)::int as n from public.group_messages where group_id = $1',
        [group],
      )
      expect(rows[0].n).toBe(3)
    }
  })

  /**
   * The inner join in list_group_messages would silently drop a sender whose
   * user row the reader cannot see. Two members who are not friends have to be
   * visible to each other through shares_group_with, or a message vanishes
   * with no error - which is precisely the reported symptom.
   */
  it('lets non-friend members see each other, which is what keeps messages visible', async () => {
    await betaGroup()
    for (const [who, other] of [
      [testerA, testerB],
      [testerB, testerA],
    ] as const) {
      const [seen] = await db.as<{ n: number }>(
        who,
        'select count(*)::int as n from public.users where id = $1',
        [other.id],
      )
      expect(seen.n).toBe(1)

      const [shares] = await db.as<{ shares_group_with: boolean }>(
        who,
        'select public.shares_group_with($1)',
        [other.id],
      )
      expect(shares.shares_group_with).toBe(true)
    }
  })

  it('ends read and write authority together when a member leaves', async () => {
    const group = await betaGroup()
    await db.as(owner, 'select public.send_group_message($1, $2)', [group, 'before'])
    await db.as(testerB, 'select public.leave_group($1)', [group])

    const groups = await db.as(testerB, 'select group_id from public.list_groups()')
    expect(groups).toHaveLength(0)

    const [rows] = await db.as<{ n: number }>(
      testerB,
      'select count(*)::int as n from public.group_messages where group_id = $1',
      [group],
    )
    expect(rows.n).toBe(0)

    await expect(
      db.as(testerB, 'select public.send_group_message($1, $2)', [group, 'after']),
    ).rejects.toThrow(/not in this group/)
  })

  it('still refuses a stranger everything', async () => {
    const group = await betaGroup()
    const stranger = await db.createUser({ login: 'stranger', displayName: 'Stranger' })

    expect(await db.as(stranger, 'select group_id from public.list_groups()')).toHaveLength(0)
    expect(
      await db.as(
        stranger,
        'select count(*)::int as n from public.group_messages where group_id = $1',
        [group],
      ),
    ).toEqual([{ n: 0 }])
    await expect(
      db.as(stranger, 'select public.send_group_message($1, $2)', [group, 'let me in']),
    ).rejects.toThrow()
  })
})
