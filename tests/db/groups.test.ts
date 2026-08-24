import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { createTestDb } from './harness'
import type { TestDb, TestUser } from './harness'

/**
 * Group authorization, against real PostgreSQL as a real `authenticated` role.
 *
 * The properties worth protecting here are less obvious than the friendship
 * ones. Group membership deliberately grants presence visibility between
 * people who are not friends, so the tests have to prove that the grant is
 * exactly as wide as intended and no wider - and that it disappears the
 * instant somebody leaves.
 */

let db: TestDb
let alice: TestUser
let bob: TestUser
let mallory: TestUser

async function refusal(run: () => Promise<unknown>): Promise<string> {
  try {
    await run()
  } catch (error) {
    return (error as Error).message
  }
  throw new Error('expected the database to refuse this, but it succeeded')
}

async function befriend(a: TestUser, b: TestUser): Promise<void> {
  await db.as(a, 'select public.send_friend_request($1)', [b.id])
  const rows = await db.as<{ request_id: string }>(
    b,
    `select request_id from public.list_friend_requests() where direction = 'incoming'`,
  )
  await db.as(b, 'select public.respond_to_friend_request($1, true)', [rows[0].request_id])
}

async function makeGroup(owner: TestUser, name = 'The Boys'): Promise<string> {
  const [row] = await db.as<{ create_group: string }>(owner, 'select public.create_group($1)', [
    name,
  ])
  return row.create_group
}

async function addToGroup(owner: TestUser, group: string, target: TestUser): Promise<void> {
  await db.as(owner, 'select public.invite_to_group($1, $2)', [group, target.id])
  const [invite] = await db.as<{ invite_id: string }>(
    target,
    'select invite_id from public.list_group_invites()',
  )
  await db.as(target, 'select public.respond_to_group_invite($1, true)', [invite.invite_id])
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
  mallory = await db.createUser({ login: 'mallory', displayName: 'Mallory' })
})

// ------------------------------------------------- creation and membership

describe('group creation and membership', () => {
  it('creates a group with its owner already a member', async () => {
    await makeGroup(alice)
    const [row] = await db.as<{ name: string; is_owner: boolean; member_count: number }>(
      alice,
      'select * from public.list_groups()',
    )
    expect(row).toMatchObject({ name: 'The Boys', is_owner: true, member_count: 1 })
  })

  it('rejects an empty or oversized name', async () => {
    expect(await refusal(() => db.as(alice, 'select public.create_group($1)', ['   ']))).toMatch(
      /1-40 characters/i,
    )
    expect(
      await refusal(() => db.as(alice, 'select public.create_group($1)', ['x'.repeat(41)])),
    ).toMatch(/1-40 characters/i)
  })

  it('hides a group entirely from someone with no connection to it', async () => {
    await makeGroup(alice)
    expect(await db.as(mallory, 'select * from public.groups')).toHaveLength(0)
    expect(await db.as(mallory, 'select * from public.list_groups()')).toHaveLength(0)
  })

  it('lets an invitee read the name to decide, but not the member list', async () => {
    const group = await makeGroup(alice)
    await db.as(alice, 'select public.invite_to_group($1, $2)', [group, bob.id])

    expect(await db.as(bob, 'select name from public.groups where id = $1', [group])).toHaveLength(1)
    expect(
      await db.as(bob, 'select * from public.group_members where group_id = $1', [group]),
    ).toHaveLength(0)
  })

  it('adds the invitee on acceptance', async () => {
    const group = await makeGroup(alice)
    await addToGroup(alice, group, bob)

    const members = await db.as<{ display_name: string }>(
      alice,
      'select display_name from public.list_group_members($1)',
      [group],
    )
    expect(members.map((m) => m.display_name).sort()).toEqual(['Alice', 'Bob'])
  })

  it('does nothing on decline', async () => {
    const group = await makeGroup(alice)
    await db.as(alice, 'select public.invite_to_group($1, $2)', [group, bob.id])
    const [invite] = await db.as<{ invite_id: string }>(
      bob,
      'select invite_id from public.list_group_invites()',
    )
    await db.as(bob, 'select public.respond_to_group_invite($1, false)', [invite.invite_id])

    expect(await db.as(bob, 'select * from public.list_groups()')).toHaveLength(0)
  })

  it('refuses to let anyone but the owner invite', async () => {
    const group = await makeGroup(alice)
    await addToGroup(alice, group, bob)

    expect(
      await refusal(() => db.as(bob, 'select public.invite_to_group($1, $2)', [group, mallory.id])),
    ).toMatch(/only the group owner/i)
  })

  it('refuses to let a stranger accept an invitation addressed to someone else', async () => {
    const group = await makeGroup(alice)
    await db.as(alice, 'select public.invite_to_group($1, $2)', [group, bob.id])
    const [invite] = await db.root<{ id: string }>('select id from public.group_invites')

    expect(
      await refusal(() =>
        db.as(mallory, 'select public.respond_to_group_invite($1, true)', [invite.id]),
      ),
    ).toMatch(/not found/i)
  })

  it('collapses a duplicate invitation', async () => {
    const group = await makeGroup(alice)
    await db.as(alice, 'select public.invite_to_group($1, $2)', [group, bob.id])
    const [second] = await db.as<{ invite_to_group: string }>(
      alice,
      'select public.invite_to_group($1, $2)',
      [group, bob.id],
    )
    expect(second.invite_to_group).toBe('already_invited')

    const [{ count }] = await db.root<{ count: number }>(
      `select count(*)::int as count from public.group_invites where status = 'pending'`,
    )
    expect(count).toBe(1)
  })

  it('reports an existing member rather than inviting again', async () => {
    const group = await makeGroup(alice)
    await addToGroup(alice, group, bob)
    const [again] = await db.as<{ invite_to_group: string }>(
      alice,
      'select public.invite_to_group($1, $2)',
      [group, bob.id],
    )
    expect(again.invite_to_group).toBe('already_member')
  })
})

// ------------------------------------------------ membership != friendship

describe('group membership is not friendship', () => {
  it('lets two strangers share a group without becoming friends', async () => {
    // Alice is friends with both; Bob and Mallory have never met.
    await befriend(alice, bob)
    await befriend(alice, mallory)

    const group = await makeGroup(alice)
    await addToGroup(alice, group, bob)
    await addToGroup(alice, group, mallory)

    expect(await db.as(alice, 'select * from public.list_group_members($1)', [group])).toHaveLength(
      3,
    )

    const [{ count }] = await db.root<{ count: number }>(
      `select count(*)::int as count from public.friendships
       where (user_id = $1 and friend_id = $2) or (user_id = $2 and friend_id = $1)`,
      [bob.id, mallory.id],
    )
    expect(count).toBe(0)

    const bobFriends = await db.as<{ display_name: string }>(
      bob,
      'select display_name from public.list_friends()',
    )
    expect(bobFriends.map((f) => f.display_name)).toEqual(['Alice'])
  })
})

// ------------------------------------------------------ group-scoped presence

describe('group-scoped presence', () => {
  it('lets group members see each other despite not being friends', async () => {
    const group = await makeGroup(alice)
    await addToGroup(alice, group, bob)
    await addToGroup(alice, group, mallory)
    await db.as(mallory, `select public.report_presence('twitch', 'lirik')`)

    const [row] = await db.as<{ channel: string }>(
      bob,
      'select channel from public.presence where user_id = $1',
      [mallory.id],
    )
    expect(row.channel).toBe('lirik')
  })

  it('revokes that visibility the moment someone leaves', async () => {
    const group = await makeGroup(alice)
    await addToGroup(alice, group, bob)
    await addToGroup(alice, group, mallory)
    await db.as(mallory, `select public.report_presence('twitch', 'lirik')`)

    await db.as(mallory, 'select public.leave_group($1)', [group])

    expect(
      await db.as(bob, 'select * from public.presence where user_id = $1', [mallory.id]),
    ).toHaveLength(0)
  })

  it('revokes it when the owner removes someone', async () => {
    const group = await makeGroup(alice)
    await addToGroup(alice, group, bob)
    await addToGroup(alice, group, mallory)
    await db.as(mallory, `select public.report_presence('twitch', 'lirik')`)

    await db.as(alice, 'select public.remove_group_member($1, $2)', [group, mallory.id])

    expect(
      await db.as(bob, 'select * from public.presence where user_id = $1', [mallory.id]),
    ).toHaveLength(0)
  })

  it('still hides an invisible member from their own group', async () => {
    const group = await makeGroup(alice)
    await addToGroup(alice, group, bob)
    await db.as(bob, `select public.set_presence_visibility('invisible')`)
    await db.as(bob, `select public.report_presence('twitch', 'lirik')`)

    const [row] = await db.as<{ status: string; channel: string | null }>(
      alice,
      'select status, channel from public.presence where user_id = $1',
      [bob.id],
    )
    expect(row).toMatchObject({ status: 'offline', channel: null })
  })

  it('still redacts the channel of a member hiding their activity', async () => {
    const group = await makeGroup(alice)
    await addToGroup(alice, group, bob)
    await db.as(bob, `select public.set_presence_visibility('hide_activity')`)
    await db.as(bob, `select public.report_presence('twitch', 'lirik')`)

    const [row] = await db.as<{ status: string; channel: string | null }>(
      alice,
      'select status, channel from public.presence where user_id = $1',
      [bob.id],
    )
    expect(row.status).toBe('online')
    expect(row.channel).toBeNull()
  })

  it('never reveals a group member privacy setting', async () => {
    const group = await makeGroup(alice)
    await addToGroup(alice, group, bob)
    await db.as(bob, `select public.set_presence_visibility('invisible')`)

    expect(
      await db.as(alice, 'select * from public.user_preferences where user_id = $1', [bob.id]),
    ).toHaveLength(0)
  })

  it('does not grant presence to somebody merely invited', async () => {
    const group = await makeGroup(alice)
    await db.as(alice, 'select public.invite_to_group($1, $2)', [group, bob.id])
    await db.as(alice, `select public.report_presence('twitch', 'lirik')`)

    expect(
      await db.as(bob, 'select * from public.presence where user_id = $1', [alice.id]),
    ).toHaveLength(0)
  })
})

// ------------------------------------------------------------------- chat

describe('group chat authorization', () => {
  it('lets a member send and read', async () => {
    const group = await makeGroup(alice)
    await addToGroup(alice, group, bob)
    await db.as(bob, 'select public.send_group_message($1, $2)', [group, 'this guy is cooked'])

    const messages = await db.as<{ body: string; display_name: string }>(
      alice,
      'select body, display_name from public.list_group_messages($1)',
      [group],
    )
    expect(messages).toHaveLength(1)
    expect(messages[0]).toMatchObject({ body: 'this guy is cooked', display_name: 'Bob' })
  })

  it('shows a non-member nothing at all', async () => {
    const group = await makeGroup(alice)
    await db.as(alice, 'select public.send_group_message($1, $2)', [group, 'secret'])

    expect(await db.as(mallory, 'select * from public.group_messages')).toHaveLength(0)
    expect(
      await db.as(mallory, 'select * from public.list_group_messages($1)', [group]),
    ).toHaveLength(0)
  })

  it('refuses to let a non-member send', async () => {
    const group = await makeGroup(alice)
    expect(
      await refusal(() =>
        db.as(mallory, 'select public.send_group_message($1, $2)', [group, 'hello']),
      ),
    ).toMatch(/not in this group/i)
  })

  it('grants nothing on an invitation alone', async () => {
    const group = await makeGroup(alice)
    await db.as(alice, 'select public.send_group_message($1, $2)', [group, 'members only'])
    await db.as(alice, 'select public.invite_to_group($1, $2)', [group, bob.id])

    expect(await db.as(bob, 'select * from public.group_messages')).toHaveLength(0)
    expect(
      await refusal(() => db.as(bob, 'select public.send_group_message($1, $2)', [group, 'hi'])),
    ).toMatch(/not in this group/i)
  })

  it('cuts a removed member off from history and from sending', async () => {
    const group = await makeGroup(alice)
    await addToGroup(alice, group, bob)
    await db.as(alice, 'select public.send_group_message($1, $2)', [group, 'before'])
    expect(await db.as(bob, 'select * from public.group_messages')).toHaveLength(1)

    await db.as(alice, 'select public.remove_group_member($1, $2)', [group, bob.id])
    await db.as(alice, 'select public.send_group_message($1, $2)', [group, 'after'])

    expect(await db.as(bob, 'select * from public.group_messages')).toHaveLength(0)
    expect(
      await refusal(() => db.as(bob, 'select public.send_group_message($1, $2)', [group, 'wait'])),
    ).toMatch(/not in this group/i)
  })

  it('cuts off somebody who leaves', async () => {
    const group = await makeGroup(alice)
    await addToGroup(alice, group, bob)
    await db.as(alice, 'select public.send_group_message($1, $2)', [group, 'hello'])

    await db.as(bob, 'select public.leave_group($1)', [group])

    expect(await db.as(bob, 'select * from public.group_messages')).toHaveLength(0)
  })

  it('refuses direct writes to messages and membership', async () => {
    const group = await makeGroup(alice)
    expect(
      await refusal(() =>
        db.as(
          mallory,
          'insert into public.group_messages (group_id, user_id, body) values ($1, $2, $3)',
          [group, alice.id, 'forged'],
        ),
      ),
    ).toMatch(/permission denied/i)

    expect(
      await refusal(() =>
        db.as(mallory, 'insert into public.group_members (group_id, user_id) values ($1, $2)', [
          group,
          mallory.id,
        ]),
      ),
    ).toMatch(/permission denied/i)
  })

  it('rejects empty and oversized messages', async () => {
    const group = await makeGroup(alice)
    expect(
      await refusal(() => db.as(alice, 'select public.send_group_message($1, $2)', [group, '   '])),
    ).toMatch(/empty/i)
    expect(
      await refusal(() =>
        db.as(alice, 'select public.send_group_message($1, $2)', [group, 'x'.repeat(501)]),
      ),
    ).toMatch(/too long/i)
  })

  it('stores markup as literal text rather than interpreting it', async () => {
    const group = await makeGroup(alice)
    const payload = '<script>alert(1)</script>'
    await db.as(alice, 'select public.send_group_message($1, $2)', [group, payload])

    const [message] = await db.as<{ body: string }>(
      alice,
      'select body from public.list_group_messages($1)',
      [group],
    )
    expect(message.body).toBe(payload)
  })

  it('throttles a client spamming messages', async () => {
    const group = await makeGroup(alice)
    let refused = ''
    for (let i = 0; i < 100; i++) {
      try {
        await db.as(alice, 'select public.send_group_message($1, $2)', [group, `msg ${i}`])
      } catch (error) {
        refused = (error as Error).message
        break
      }
    }
    expect(refused).toMatch(/too quickly/i)
  })

  it('keeps the rate counters unreadable', async () => {
    expect(await refusal(() => db.as(alice, 'select * from public.rate_limits'))).toMatch(
      /permission denied/i,
    )
  })

  it('returns history oldest first', async () => {
    const group = await makeGroup(alice)
    for (const body of ['one', 'two', 'three']) {
      await db.as(alice, 'select public.send_group_message($1, $2)', [group, body])
    }
    const messages = await db.as<{ body: string }>(
      alice,
      'select body from public.list_group_messages($1)',
      [group],
    )
    expect(messages.map((m) => m.body)).toEqual(['one', 'two', 'three'])
  })
})

// --------------------------------------------------------- administration

describe('group administration', () => {
  it('lets the owner rename', async () => {
    const group = await makeGroup(alice)
    await db.as(alice, 'select public.rename_group($1, $2)', [group, 'The Lads'])
    const [row] = await db.as<{ name: string }>(alice, 'select * from public.list_groups()')
    expect(row.name).toBe('The Lads')
  })

  it('refuses a rename by a member or a stranger', async () => {
    const group = await makeGroup(alice)
    await addToGroup(alice, group, bob)

    expect(
      await refusal(() => db.as(bob, 'select public.rename_group($1, $2)', [group, 'Mine Now'])),
    ).toMatch(/only the group owner/i)
    expect(
      await refusal(() => db.as(mallory, 'select public.rename_group($1, $2)', [group, 'Mine'])),
    ).toMatch(/only the group owner/i)
  })

  it('lets the owner set and clear a group icon', async () => {
    const group = await makeGroup(alice)

    await db.as(alice, 'select public.set_group_icon($1, $2)', [group, '🎮'])
    const [chosen] = await db.as<{ icon: string | null }>(alice, 'select * from public.list_groups()')
    expect(chosen.icon).toBe('🎮')

    // Clearing is a legitimate choice, not an error: icons are optional.
    await db.as(alice, 'select public.set_group_icon($1, $2)', [group, null])
    const [cleared] = await db.as<{ icon: string | null }>(alice, 'select * from public.list_groups()')
    expect(cleared.icon).toBeNull()
  })

  it('starts a group with no icon unless one was chosen', async () => {
    // Every group that existed before icons did must keep working untouched.
    const group = await makeGroup(alice)
    const [row] = await db.as<{ group_id: string; icon: string | null }>(
      alice,
      'select * from public.list_groups()',
    )
    expect(row.group_id).toBe(group)
    expect(row.icon).toBeNull()
  })

  it('refuses an icon change by a member or a stranger', async () => {
    // Same authorization boundary as renaming: a non-owner is told the group
    // does not exist rather than that they lack permission.
    const group = await makeGroup(alice)
    await addToGroup(alice, group, bob)

    expect(
      await refusal(() => db.as(bob, 'select public.set_group_icon($1, $2)', [group, '💀'])),
    ).toMatch(/not found/i)
    expect(
      await refusal(() =>
        db.as(mallory, 'select public.set_group_icon($1, $2)', [group, '💀']),
      ),
    ).toMatch(/not found/i)

    const [row] = await db.as<{ icon: string | null }>(alice, 'select * from public.list_groups()')
    expect(row.icon).toBeNull()
  })

  it('refuses an icon long enough to be a second name', async () => {
    const group = await makeGroup(alice)
    expect(
      await refusal(() =>
        db.as(alice, 'select public.set_group_icon($1, $2)', [group, 'x'.repeat(40)]),
      ),
    ).toMatch(/too long/i)
  })

  it('lets the owner delete, taking members and messages with it', async () => {
    const group = await makeGroup(alice)
    await addToGroup(alice, group, bob)
    await db.as(bob, 'select public.send_group_message($1, $2)', [group, 'hi'])

    await db.as(alice, 'select public.delete_group($1)', [group])

    expect(await db.as(bob, 'select * from public.list_groups()')).toHaveLength(0)
    const [{ count }] = await db.root<{ count: number }>(
      'select count(*)::int as count from public.group_messages',
    )
    expect(count).toBe(0)
  })

  it('refuses a delete or removal by a member', async () => {
    const group = await makeGroup(alice)
    await addToGroup(alice, group, bob)
    await addToGroup(alice, group, mallory)

    expect(await refusal(() => db.as(bob, 'select public.delete_group($1)', [group]))).toMatch(
      /only the group owner/i,
    )
    expect(
      await refusal(() =>
        db.as(bob, 'select public.remove_group_member($1, $2)', [group, mallory.id]),
      ),
    ).toMatch(/only the group owner/i)
  })

  it('keeps the owner from leaving their own group', async () => {
    const group = await makeGroup(alice)
    expect(await refusal(() => db.as(alice, 'select public.leave_group($1)', [group]))).toMatch(
      /delete the group instead/i,
    )
  })

  it('cancels a live invitation when that person is removed', async () => {
    const group = await makeGroup(alice)
    await addToGroup(alice, group, bob)
    await db.as(alice, 'select public.remove_group_member($1, $2)', [group, bob.id])

    expect(await db.as(bob, 'select * from public.list_group_invites()')).toHaveLength(0)
  })
})
