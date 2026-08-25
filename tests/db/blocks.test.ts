import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { createTestDb } from './harness'
import type { TestDb, TestUser } from './harness'

/**
 * Block, against real Postgres.
 *
 * This is a security checkpoint, so almost nothing here is about what the panel
 * draws. What is asserted is that the server refuses - through every path that
 * could otherwise re-establish a connection the block was meant to sever, and
 * without telling the blocked person which of the two of them did it.
 *
 * The hardest requirement is the graph one. A Stream Room is the connected
 * component of the friendship graph walked up to three hops, so a blocked
 * person must be excluded from being TRAVERSED THROUGH and not merely from the
 * result: filtering final rows would still deliver somebody reachable only via
 * a person the caller refused to be connected to.
 */

const CHANNEL = 'lirik'

let db: TestDb

/** A single-quoted SQL literal; see tests/db/roomMessages.test.ts for why. */
function lit(value: string): string {
  return `'${value.split("'").join("''")}'`
}

async function arrive(user: TestUser, channel = CHANNEL): Promise<void> {
  if (!/^[a-z0-9_]+$/.test(channel)) throw new Error(`not a test channel: ${channel}`)
  await db.as(user, `select public.report_presence('twitch', '${channel}')`)
}

async function befriend(a: TestUser, b: TestUser): Promise<void> {
  await db.root(`select public.create_friendship(${lit(a.id)}::uuid, ${lit(b.id)}::uuid)`)
}

async function block(actor: TestUser, target: TestUser): Promise<void> {
  await db.as(actor, `select public.block_user(${lit(target.id)}::uuid)`)
}

async function unblock(actor: TestUser, target: TestUser): Promise<void> {
  await db.as(actor, `select public.unblock_user(${lit(target.id)}::uuid)`)
}

async function friends(user: TestUser): Promise<string[]> {
  const rows = await db.root<{ friend_id: string }>(
    `select friend_id from public.friendships where user_id = ${lit(user.id)}`,
  )
  return rows.map((row) => row.friend_id).sort()
}

/** The caller's own room, as the server computes it. */
async function room(user: TestUser, channel = CHANNEL): Promise<string[]> {
  const rows = await db.as<{ user_id: string }>(
    user,
    `select user_id from public.stream_room_members(${lit(channel)})`,
  )
  return rows.map((row) => row.user_id).sort()
}

async function say(user: TestUser, body: string, channel = CHANNEL): Promise<void> {
  await db.as(user, `select public.send_room_message(${lit(channel)}, ${lit(body)})`)
}

async function inbox(user: TestUser): Promise<string[]> {
  const rows = await db.as<{ body: string }>(
    user,
    `select body from public.room_messages where recipient_id = ${lit(user.id)}
      order by created_at, id`,
  )
  return rows.map((row) => row.body)
}

async function react(user: TestUser, channel = CHANNEL): Promise<void> {
  await db.as(user, `select public.send_together_reaction(${lit(channel)}, 'lol')`)
}

async function reactionsFor(user: TestUser): Promise<string[]> {
  const rows = await db.as<{ sender_id: string }>(
    user,
    `select sender_id from public.together_reactions where recipient_id = ${lit(user.id)}`,
  )
  return rows.map((row) => row.sender_id).sort()
}

async function makeGroup(owner: TestUser, name: string): Promise<string> {
  const [row] = await db.as<{ create_group: string }>(
    owner,
    `select public.create_group(${lit(name)})`,
  )
  return row.create_group
}

/** Puts somebody in a group directly, so a test can set up a pair that a
 *  block is not allowed to have created in the first place. */
async function joinGroup(groupId: string, user: TestUser): Promise<void> {
  await db.root(
    `insert into public.group_members (group_id, user_id)
     values (${lit(groupId)}::uuid, ${lit(user.id)}::uuid)
     on conflict do nothing`,
  )
}

async function groupSay(user: TestUser, groupId: string, body: string): Promise<void> {
  await db.as(user, `select public.send_group_message(${lit(groupId)}::uuid, ${lit(body)})`)
}

async function groupChat(user: TestUser, groupId: string): Promise<string[]> {
  const rows = await db.as<{ body: string }>(
    user,
    `select body from public.list_group_messages(${lit(groupId)}::uuid)`,
  )
  return rows.map((row) => row.body)
}

async function refusal(run: () => Promise<unknown>): Promise<string> {
  try {
    await run()
    return ''
  } catch (error) {
    return (error as Error).message
  }
}

let alice: TestUser
let bob: TestUser
let carol: TestUser
let dave: TestUser

beforeAll(async () => {
  db = await createTestDb()
}, 60_000)

afterAll(async () => {
  await db?.close()
})

beforeEach(async () => {
  await db.reset()
  await db.root(`truncate public.blocks, public.room_messages, public.together_reactions,
                 public.rate_limits`)
  alice = await db.createUser({ login: 'alice' })
  bob = await db.createUser({ login: 'bob' })
  carol = await db.createUser({ login: 'carol' })
  dave = await db.createUser({ login: 'dave' })
})

// ------------------------------------------------------------- the pair

describe('blocking an existing friend', () => {
  beforeEach(async () => {
    await befriend(alice, bob)
  })

  it('destroys the friendship, both mirrored rows', async () => {
    await block(alice, bob)
    expect(await friends(alice)).toEqual([])
    expect(await friends(bob)).toEqual([])
  })

  it('cancels a pending request in either direction', async () => {
    const carl = await db.createUser({ login: 'carl' })
    await db.as(alice, `select public.send_friend_request(${lit(carl.id)}::uuid)`)
    await block(alice, carl)

    const rows = await db.root<{ status: string }>(
      `select status from public.friend_requests
        where from_user = ${lit(alice.id)} and to_user = ${lit(carl.id)}`,
    )
    expect(rows.map((row) => row.status)).toEqual(['cancelled'])
  })

  it('hides presence in both directions', async () => {
    /*
     * The privacy boundary, and it holds through the policy rather than
     * through a filter: is_friend refuses a blocked pair, and presence_select
     * is written in terms of is_friend.
     */
    await arrive(alice)
    await arrive(bob)
    expect(
      await db.as(alice, `select user_id from public.presence where user_id = ${lit(bob.id)}`),
    ).toHaveLength(1)

    await block(alice, bob)

    expect(
      await db.as(alice, `select user_id from public.presence where user_id = ${lit(bob.id)}`),
    ).toEqual([])
    // And symmetrically, without bob having blocked anybody.
    expect(
      await db.as(bob, `select user_id from public.presence where user_id = ${lit(alice.id)}`),
    ).toEqual([])
  })

  it('refuses a new friend request in either direction', async () => {
    await block(alice, bob)
    expect(await refusal(() =>
      db.as(alice, `select public.send_friend_request(${lit(bob.id)}::uuid)`),
    )).toMatch(/cannot add that user/i)
    // The blocked party is refused identically, and told nothing about why.
    const blocked = await refusal(() =>
      db.as(bob, `select public.send_friend_request(${lit(alice.id)}::uuid)`),
    )
    expect(blocked).toMatch(/cannot add that user/i)
    expect(blocked).not.toMatch(/block/i)
  })

  it('refuses a stale request that was already in flight', async () => {
    /*
     * block_user cancels pending requests, so this should be unreachable. It is
     * asserted anyway because "should be unreachable" is not a security
     * property: accepting is the one operation that can recreate a friendship,
     * so it re-checks.
     */
    const carl = await db.createUser({ login: 'carl' })
    await db.as(carl, `select public.send_friend_request(${lit(alice.id)}::uuid)`)
    const [request] = await db.root<{ id: string }>(
      `select id from public.friend_requests
        where from_user = ${lit(carl.id)} and to_user = ${lit(alice.id)}`,
    )

    // Resurrect it, the way no code path is supposed to.
    await block(alice, carl)
    await db.root(
      `update public.friend_requests set status = 'pending', responded_at = null
        where id = ${lit(request.id)}`,
    )

    expect(await refusal(() =>
      db.as(alice, `select public.respond_to_friend_request(${lit(request.id)}::uuid, true)`),
    )).toMatch(/cannot add that user/i)
    // Carl is not a friend. Bob still is - he was never part of this.
    expect(await friends(alice)).not.toContain(carl.id)
  })

  it('lets the request be declined, which needs no friendship', async () => {
    const carl = await db.createUser({ login: 'carl' })
    await db.as(carl, `select public.send_friend_request(${lit(alice.id)}::uuid)`)
    const [request] = await db.root<{ id: string }>(
      `select id from public.friend_requests
        where from_user = ${lit(carl.id)} and to_user = ${lit(alice.id)}`,
    )
    await db.as(alice, `select public.respond_to_friend_request(${lit(request.id)}::uuid, false)`)
    expect(await friends(alice)).not.toContain(carl.id)
  })
})

describe('unblocking', () => {
  it('removes the block and nothing else', async () => {
    await befriend(alice, bob)
    await block(alice, bob)
    await unblock(alice, bob)

    const rows = await db.as(alice, `select blocked_id from public.blocks`)
    expect(rows).toEqual([])

    // Friendship is NOT recreated, and neither is the request.
    expect(await friends(alice)).toEqual([])
    expect(await friends(bob)).toEqual([])
  })

  it('lets them become friends again the ordinary way', async () => {
    await befriend(alice, bob)
    await block(alice, bob)
    await unblock(alice, bob)

    await db.as(alice, `select public.send_friend_request(${lit(bob.id)}::uuid)`)
    const [request] = await db.root<{ id: string }>(
      `select id from public.friend_requests
        where from_user = ${lit(alice.id)} and to_user = ${lit(bob.id)} and status = 'pending'`,
    )
    await db.as(bob, `select public.respond_to_friend_request(${lit(request.id)}::uuid, true)`)

    expect(await friends(alice)).toEqual([bob.id])
  })

  it('does not undo somebody else\'s block', async () => {
    // Both blocked each other; one relenting must not speak for the other.
    await block(alice, bob)
    await block(bob, alice)
    await unblock(alice, bob)

    expect(await refusal(() =>
      db.as(alice, `select public.send_friend_request(${lit(bob.id)}::uuid)`),
    )).toMatch(/cannot add that user/i)
  })
})

// ----------------------------------------------------------- the graph

describe('the walk stops at a block', () => {
  beforeEach(async () => {
    await befriend(alice, bob)
    await befriend(bob, carol)
    await befriend(carol, dave)
    for (const user of [alice, bob, carol, dave]) await arrive(user)
  })

  it('reaches the whole chain when nobody has blocked anybody', async () => {
    expect(await room(alice)).toEqual([bob.id, carol.id, dave.id].sort())
  })

  it('cannot traverse THROUGH somebody it blocked', async () => {
    /*
     * THE REQUIREMENT. A blocks B, and B was the only way to reach C and D.
     *
     * Filtering the final rows would have left C and D in A's room, reachable
     * only through the person A refused to be connected to. The predicate sits
     * on the join, so the walk simply stops.
     */
    await block(alice, bob)
    expect(await room(alice)).toEqual([])
  })

  it('stops at the same place when THEY did the blocking', async () => {
    // Direction of the row must not matter to connectivity.
    await block(bob, alice)
    expect(await room(alice)).toEqual([])
    expect(await room(bob)).toEqual([carol.id, dave.id].sort())
  })

  it('excludes a blocked person further along the chain', async () => {
    await block(alice, carol)
    // B is still a friend and still reachable; C is refused, and D was only
    // reachable through C.
    expect(await room(alice)).toEqual([bob.id])
    expect(await room(carol)).toEqual([bob.id, dave.id].sort())
  })

  it('leaves the uninvolved person connected to both', async () => {
    /*
     * The documented asymmetry. B blocked nobody and has no reason to lose
     * either of them - and this is safe because DELIVERY is checked pairwise
     * against the sender, so B knowing both never carries anything across.
     */
    await block(alice, carol)
    expect(await room(bob)).toEqual([alice.id, carol.id, dave.id].sort())
  })

  it('removes a blocked direct friend from the room outright', async () => {
    await block(alice, bob)
    expect(await room(bob)).toEqual([carol.id, dave.id].sort())
    expect(await room(alice)).not.toContain(bob.id)
  })
})

// -------------------------------------------------------- what crosses

describe('what a block stops crossing', () => {
  beforeEach(async () => {
    await befriend(alice, bob)
    await befriend(bob, carol)
    for (const user of [alice, bob, carol]) await arrive(user)
  })

  it('keeps a message from reaching a blocked person', async () => {
    await block(alice, carol)

    await say(alice, 'from alice')
    expect(await inbox(alice)).toEqual(['from alice'])
    expect(await inbox(bob)).toEqual(['from alice'])
    expect(await inbox(carol)).toEqual([])
  })

  it('keeps their message from reaching back', async () => {
    await block(alice, carol)

    await say(carol, 'from carol')
    expect(await inbox(carol)).toEqual(['from carol'])
    expect(await inbox(bob)).toEqual(['from carol'])
    expect(await inbox(alice)).toEqual([])
  })

  it('lets the uninvolved person still reach both', async () => {
    /*
     * Explicitly documented, and correct: B blocked nobody. What matters is
     * that this does not become a channel between A and C, and the two tests
     * above are what prove it.
     */
    await block(alice, carol)

    await say(bob, 'from bob')
    expect(await inbox(alice)).toEqual(['from bob'])
    expect(await inbox(carol)).toEqual(['from bob'])
  })

  it('stops messages between a blocked direct pair', async () => {
    await block(alice, bob)

    await say(alice, 'from alice')
    // The sender always keeps a copy; what must not happen is it reaching them.
    expect(await inbox(alice)).toEqual(['from alice'])
    expect(await inbox(bob)).toEqual([])

    await say(bob, 'from bob')
    expect(await inbox(bob)).toEqual(['from bob'])
    expect(await inbox(alice)).not.toContain('from bob')
  })

  it('keeps reactions from crossing, so they cannot reach a combo', async () => {
    /*
     * The recipient set, not the renderer. A client-side filter would leave
     * the count wrong for anybody running a modified panel - and the combo
     * engine counts what arrives.
     */
    await block(alice, carol)

    await react(carol)
    expect(await reactionsFor(carol)).toEqual([carol.id])
    expect(await reactionsFor(bob)).toEqual([carol.id])
    expect(await reactionsFor(alice)).toEqual([])
  })
})

// ------------------------------------------------------------ security

describe('what a client cannot do', () => {
  it('cannot read a block it did not create', async () => {
    await block(alice, bob)
    // Not even the person it is about: "who has blocked me" is not a question
    // Kickback answers.
    expect(await db.as(bob, `select blocker_id from public.blocks`)).toEqual([])
    expect(await db.as(carol, `select blocker_id from public.blocks`)).toEqual([])
    expect(await db.as(alice, `select blocker_id from public.blocks`)).toHaveLength(1)
  })

  it('cannot write a block row directly', async () => {
    expect(await refusal(() =>
      db.as(
        alice,
        `insert into public.blocks (blocker_id, blocked_id)
         values (${lit(bob.id)}, ${lit(carol.id)})`,
      ),
    )).toMatch(/permission denied/i)
  })

  it('cannot delete somebody else\'s block', async () => {
    await block(alice, bob)
    expect(await refusal(() =>
      db.as(bob, `delete from public.blocks where blocker_id = ${lit(alice.id)}`),
    )).toMatch(/permission denied/i)

    expect(await db.as(alice, `select blocker_id from public.blocks`)).toHaveLength(1)
  })

  it('cannot ask whether an arbitrary pair is blocked', async () => {
    /*
     * blocked_pair is not granted to clients. A client that could call it could
     * ask about any two people and learn exactly what the policy declines to
     * say.
     */
    await block(alice, bob)
    expect(await refusal(() =>
      db.as(carol, `select public.blocked_pair(${lit(alice.id)}::uuid, ${lit(bob.id)}::uuid)`),
    )).toMatch(/permission denied/i)
  })

  it('cannot block on somebody else\'s behalf', async () => {
    // The actor comes from require_actor(); there is no parameter to spoof.
    await db.as(carol, `select public.block_user(${lit(bob.id)}::uuid)`)
    const rows = await db.root<{ blocker_id: string }>(`select blocker_id from public.blocks`)
    expect(rows.map((row) => row.blocker_id)).toEqual([carol.id])
  })

  it('cannot block itself', async () => {
    expect(await refusal(() =>
      db.as(alice, `select public.block_user(${lit(alice.id)}::uuid)`),
    )).toMatch(/cannot block yourself/i)
  })

  it('is idempotent, so a double press is not an error', async () => {
    await block(alice, bob)
    await block(alice, bob)
    expect(await db.as(alice, `select blocked_id from public.blocks`)).toHaveLength(1)
  })
})

describe('discovery says as little as possible', () => {
  it('tells the blocker, and only the blocker', async () => {
    await block(alice, bob)

    const [seenByAlice] = await db.as<{ relationship: string }>(
      alice,
      `select relationship from public.search_users('bob')`,
    )
    expect(seenByAlice.relationship).toBe('blocked')

    /*
     * And the blocked person sees an ordinary result. Their Add button will be
     * refused by the server, and that refusal is deliberately indistinguishable
     * from any other failure - a search result announcing "this person blocked
     * you" is the one thing this feature exists not to say.
     */
    const [seenByBob] = await db.as<{ relationship: string }>(
      bob,
      `select relationship from public.search_users('alice')`,
    )
    expect(seenByBob.relationship).toBe('none')
  })

  it('lists the caller\'s own blocks, with enough to name them', async () => {
    await block(alice, bob)
    const rows = await db.as<{ user_id: string; twitch_login: string }>(
      alice,
      `select user_id, twitch_login from public.list_blocked_users()`,
    )
    expect(rows.map((row) => row.user_id)).toEqual([bob.id])
    expect(rows[0].twitch_login).toBe('bob')
  })

  it('lists nothing for somebody who has blocked nobody', async () => {
    await block(alice, bob)
    expect(await db.as(bob, `select user_id from public.list_blocked_users()`)).toEqual([])
  })
})

// ---------------------------------------------------------------- groups
//
// Groups are the one place two people can be socially connected without a
// friendship, so they are the one place a friendship-shaped block could quietly
// fail to hold. Membership itself is left alone - what co-membership GRANTS is
// what stops at a block.

describe('a block holds inside a shared group', () => {
  it('stops group co-membership from granting presence', async () => {
    const group = await makeGroup(alice, 'sunday')
    await joinGroup(group, bob)
    await arrive(bob)

    // Co-membership alone is enough, before the block.
    expect(
      await db.as(alice, `select user_id from public.presence where user_id = ${lit(bob.id)}`),
    ).toHaveLength(1)

    await block(alice, bob)

    expect(
      await db.as(alice, `select user_id from public.presence where user_id = ${lit(bob.id)}`),
    ).toEqual([])

    // And the person who was blocked loses it too, without being told why.
    await arrive(alice)
    expect(
      await db.as(bob, `select user_id from public.presence where user_id = ${lit(alice.id)}`),
    ).toEqual([])
  })

  it('keeps group chat from crossing, in both directions', async () => {
    const group = await makeGroup(alice, 'sunday')
    await joinGroup(group, bob)
    await joinGroup(group, carol)

    await block(alice, bob)

    await groupSay(alice, group, 'from alice')
    await groupSay(bob, group, 'from bob')
    await groupSay(carol, group, 'from carol')

    // Neither of the pair receives the other. Both still receive everyone else,
    // and the group carries on unchanged for the people not involved.
    expect(await groupChat(alice, group)).toEqual(['from alice', 'from carol'])
    expect(await groupChat(bob, group)).toEqual(['from bob', 'from carol'])
    expect(await groupChat(carol, group)).toEqual(['from alice', 'from bob', 'from carol'])
  })

  it('holds on the table itself, not only in the reader', async () => {
    /*
     * Group chat also arrives over realtime, which applies the raw row rather
     * than calling list_group_messages. A filter that lived only in the reader
     * would hold on reload and fail live, so the check is asserted where
     * realtime enforces it: the select policy.
     */
    const group = await makeGroup(alice, 'sunday')
    await joinGroup(group, bob)
    await block(alice, bob)
    await groupSay(bob, group, 'from bob')

    expect(
      await db.as(alice, `select body from public.group_messages where group_id = ${lit(group)}`),
    ).toEqual([])
  })

  it('leaves membership alone', async () => {
    const group = await makeGroup(alice, 'sunday')
    await joinGroup(group, bob)
    await block(alice, bob)

    // Nobody is removed. A block rearranges what the group grants; it does not
    // quietly delete somebody from a named space they chose to join.
    const rows = await db.root<{ user_id: string }>(
      `select user_id from public.group_members where group_id = ${lit(group)}`,
    )
    expect(rows.map((row) => row.user_id).sort()).toEqual([alice.id, bob.id].sort())
  })

  it('refuses an invitation that would route around the block', async () => {
    await block(alice, bob)

    const fromBlocker = await refusal(async () => {
      const group = await makeGroup(alice, 'sunday')
      await db.as(alice, `select public.invite_to_group(${lit(group)}::uuid, ${lit(bob.id)}::uuid)`)
    })
    const fromBlocked = await refusal(async () => {
      const group = await makeGroup(bob, 'other')
      await db.as(bob, `select public.invite_to_group(${lit(group)}::uuid, ${lit(alice.id)}::uuid)`)
    })

    expect(fromBlocker).toContain('cannot invite that user')
    // Identical wording, so the refusal cannot be used to work out who blocked
    // whom.
    expect(fromBlocked).toBe(fromBlocker)
  })

  it('restores what the group grants when the block is lifted', async () => {
    const group = await makeGroup(alice, 'sunday')
    await joinGroup(group, bob)
    await block(alice, bob)
    await unblock(alice, bob)

    await arrive(bob)
    expect(
      await db.as(alice, `select user_id from public.presence where user_id = ${lit(bob.id)}`),
    ).toHaveLength(1)

    await groupSay(bob, group, 'from bob')
    expect(await groupChat(alice, group)).toEqual(['from bob'])
  })
})
