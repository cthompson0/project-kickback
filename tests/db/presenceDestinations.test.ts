import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { createTestDb } from './harness'
import type { TestDb, TestUser } from './harness'

/**
 * Multi-destination presence, against real PostgreSQL as a real
 * `authenticated` role.
 *
 * The properties worth protecting here are not the happy path - publishing
 * three channels is easy. They are:
 *
 *   * that the PARENT LIVENESS GATE cannot be bypassed. A crashed browser
 *     leaves destination rows behind whose own thirty-minute clock has barely
 *     started, and those rows must become invisible the moment the account
 *     goes stale at ninety seconds. This is the single most important
 *     assertion in the file;
 *   * that the cap of three is enforced by the SERVER, so a modified client
 *     cannot inflate its own Gravity;
 *   * that a v0.4.1 client, which knows nothing about any of this, stays
 *     visible and can still share a room.
 *
 * Time is moved by writing timestamps directly as the owner rather than by
 * waiting: these are real rows in a real database, and "ninety seconds ago" is
 * a value, not a delay.
 */

let db: TestDb
let alice: TestUser
let bob: TestUser
let carol: TestUser

/** Everything the server currently publishes for one account. */
async function published(user: TestUser): Promise<string[]> {
  const rows = await db.root<{ channel: string }>(
    'select channel from public.presence_destinations where user_id = $1 order by channel',
    [user.id],
  )
  return rows.map((row) => row.channel)
}

/** What a viewer can actually SEE, which is the question that matters. */
async function visibleTo(viewer: TestUser, subject: TestUser): Promise<string[]> {
  const rows = await db.as<{ channel: string }>(
    viewer,
    'select channel from public.list_friend_destinations() where user_id = $1 order by channel',
    [subject.id],
  )
  return rows.map((row) => row.channel)
}

async function befriend(a: TestUser, b: TestUser): Promise<void> {
  await db.as(a, 'select public.send_friend_request($1)', [b.id])
  const rows = await db.as<{ request_id: string }>(
    b,
    `select request_id from public.list_friend_requests() where direction = 'incoming'`,
  )
  await db.as(b, 'select public.respond_to_friend_request($1, true)', [rows[0].request_id])
}

/** Age the account's liveness row, as a crash or a sleeping laptop would. */
async function ageLiveness(user: TestUser, seconds: number): Promise<void> {
  await db.root(
    `update public.presence set last_seen_at = now() - make_interval(secs => $2) where user_id = $1`,
    [user.id, seconds],
  )
}

/** Age one destination, leaving the account perfectly live. */
async function ageDestination(user: TestUser, channel: string, minutes: number): Promise<void> {
  await db.root(
    `update public.presence_destinations
        set last_active_at = now() - make_interval(mins => $3)
      where user_id = $1 and channel = $2`,
    [user.id, channel, minutes],
  )
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
  carol = await db.createUser({ login: 'carol_tv', displayName: 'Carol' })
  await befriend(alice, bob)
})

// ------------------------------------------------------------- publishing

describe('publishing destinations', () => {
  it('publishes one', async () => {
    await db.as(alice, `select public.report_destinations(array['shroud'])`)
    expect(await published(alice)).toEqual(['shroud'])
  })

  it('publishes two', async () => {
    await db.as(alice, `select public.report_destinations(array['shroud','lirik'])`)
    expect(await published(alice)).toEqual(['lirik', 'shroud'])
  })

  it('publishes three', async () => {
    await db.as(alice, `select public.report_destinations(array['shroud','lirik','summit1g'])`)
    expect(await published(alice)).toEqual(['lirik', 'shroud', 'summit1g'])
  })

  /** The cap is the server's, not the client's. */
  it('keeps only the first three of four, and says so', async () => {
    const [row] = await db.as<{ report_destinations: number }>(
      alice,
      `select public.report_destinations(array['shroud','lirik','summit1g','gingy'])`,
    )
    expect(row.report_destinations).toBe(3)
    expect(await published(alice)).toEqual(['lirik', 'shroud', 'summit1g'])
  })

  /**
   * Duplicate browser tabs on one stream are one destination, and crucially
   * the de-duplication happens BEFORE the cap - otherwise two tabs on shroud
   * would silently cost somebody a third stream.
   */
  it('collapses duplicates before applying the cap', async () => {
    const [row] = await db.as<{ report_destinations: number }>(
      alice,
      `select public.report_destinations(array['shroud','shroud','lirik','summit1g'])`,
    )
    expect(row.report_destinations).toBe(3)
    expect(await published(alice)).toEqual(['lirik', 'shroud', 'summit1g'])
  })

  it('drops anything that is not a channel rather than failing the whole set', async () => {
    await db.as(alice, `select public.report_destinations(array['shroud','NOT A CHANNEL',''])`)
    expect(await published(alice)).toEqual(['shroud'])
  })

  it('replaces the set rather than accumulating it', async () => {
    await db.as(alice, `select public.report_destinations(array['shroud','lirik'])`)
    await db.as(alice, `select public.report_destinations(array['gingy'])`)
    expect(await published(alice)).toEqual(['gingy'])
  })

  it('keeps opened_at across a refresh, so tab order is stable', async () => {
    await db.as(alice, `select public.report_destinations(array['shroud'])`)
    const [first] = await db.root<{ opened_at: string }>(
      'select opened_at from public.presence_destinations where user_id = $1',
      [alice.id],
    )
    await db.as(alice, `select public.report_destinations(array['shroud','lirik'])`)
    const [again] = await db.root<{ opened_at: string }>(
      `select opened_at from public.presence_destinations where user_id = $1 and channel = 'shroud'`,
      [alice.id],
    )
    expect(again.opened_at).toEqual(first.opened_at)
  })

  it('maintains the legacy singleton for old clients', async () => {
    await db.as(alice, `select public.report_destinations(array['shroud','lirik'])`)
    const [row] = await db.root<{ channel: string; platform: string; status: string }>(
      'select channel, platform, status from public.presence where user_id = $1',
      [alice.id],
    )
    // The primary is the first one sent, which is the most recently active.
    expect(row.channel).toBe('shroud')
    expect(row.platform).toBe('twitch')
    expect(row.status).toBe('online')
  })

  it('refuses to let anyone publish for somebody else', async () => {
    // There is no parameter to try: every RPC takes its actor from auth.uid().
    // What is assertable is that Bob publishing affects only Bob.
    await db.as(bob, `select public.report_destinations(array['lirik'])`)
    expect(await published(alice)).toEqual([])
    expect(await published(bob)).toEqual(['lirik'])
  })
})

// --------------------------------------------------- the liveness gate

describe('the parent liveness gate', () => {
  it('shows a friend their destinations while the account is live', async () => {
    await db.as(alice, `select public.report_destinations(array['shroud','lirik'])`)
    expect(await visibleTo(bob, alice)).toEqual(['lirik', 'shroud'])
  })

  /**
   * THE ASSERTION THIS FILE EXISTS FOR.
   *
   * Chrome crashes. The rows survive with a last_active_at seconds old. Ninety
   * seconds later the account is stale, and every one of those destinations
   * must vanish - not because they expired, but because the account did.
   */
  it('hides every destination once the account goes stale, however fresh the rows', async () => {
    await db.as(alice, `select public.report_destinations(array['shroud','lirik'])`)
    await ageLiveness(alice, 120)

    // The rows are still there and still young.
    expect(await published(alice)).toEqual(['lirik', 'shroud'])
    const [fresh] = await db.root<{ n: number }>(
      `select count(*)::int as n from public.presence_destinations
        where user_id = $1 and last_active_at > now() - interval '30 minutes'`,
      [alice.id],
    )
    expect(fresh.n).toBe(2)

    // And nobody can see any of them.
    expect(await visibleTo(bob, alice)).toEqual([])
  })

  it('hides them from the raw table too, not only from the reader', async () => {
    await db.as(alice, `select public.report_destinations(array['shroud'])`)
    await ageLiveness(alice, 120)
    const rows = await db.as(
      bob,
      'select channel from public.presence_destinations where user_id = $1',
      [alice.id],
    )
    expect(rows).toHaveLength(0)
  })

  it('brings them back when the account is live again', async () => {
    await db.as(alice, `select public.report_destinations(array['shroud'])`)
    await ageLiveness(alice, 120)
    expect(await visibleTo(bob, alice)).toEqual([])

    await db.as(alice, 'select public.heartbeat()')
    expect(await visibleTo(bob, alice)).toEqual(['shroud'])
  })

  it('hides a destination that expires while the account stays live', async () => {
    await db.as(alice, `select public.report_destinations(array['shroud','lirik'])`)
    await ageDestination(alice, 'shroud', 31)

    expect(await visibleTo(bob, alice)).toEqual(['lirik'])
  })

  it('reports is_present_at false for a stale account', async () => {
    await db.as(alice, `select public.report_destinations(array['shroud'])`)
    const [live] = await db.root<{ ok: boolean }>(
      `select public.is_present_at($1, 'shroud') as ok`,
      [alice.id],
    )
    expect(live.ok).toBe(true)

    await ageLiveness(alice, 120)
    const [dead] = await db.root<{ ok: boolean }>(
      `select public.is_present_at($1, 'shroud') as ok`,
      [alice.id],
    )
    expect(dead.ok).toBe(false)
  })
})

// ------------------------------------------------------------ visibility

describe('who may see a destination', () => {
  it('shows nothing to a stranger', async () => {
    await db.as(alice, `select public.report_destinations(array['shroud'])`)
    expect(await visibleTo(carol, alice)).toEqual([])
  })

  it('lets a stranger read nothing from the raw table either', async () => {
    await db.as(alice, `select public.report_destinations(array['shroud'])`)
    const rows = await db.as(carol, 'select channel from public.presence_destinations')
    expect(rows).toHaveLength(0)
  })

  it('stops showing them once the friendship ends', async () => {
    await db.as(alice, `select public.report_destinations(array['shroud'])`)
    expect(await visibleTo(bob, alice)).toEqual(['shroud'])

    await db.as(alice, 'select public.remove_friend($1)', [bob.id])
    expect(await visibleTo(bob, alice)).toEqual([])
  })

  it('stops showing them across a block, in both directions', async () => {
    await db.as(alice, `select public.report_destinations(array['shroud'])`)
    await db.as(bob, `select public.report_destinations(array['lirik'])`)
    await db.as(bob, 'select public.block_user($1)', [alice.id])

    expect(await visibleTo(bob, alice)).toEqual([])
    expect(await visibleTo(alice, bob)).toEqual([])
  })

  it('is not a directory: the reader is seeded at the caller, never at a channel', async () => {
    await db.as(alice, `select public.report_destinations(array['shroud'])`)
    await db.as(carol, `select public.report_destinations(array['shroud'])`)
    // Bob is on shroud too, and is friends only with Alice.
    await db.as(bob, `select public.report_destinations(array['shroud'])`)

    const rows = await db.as<{ user_id: string }>(
      bob,
      'select user_id from public.list_friend_destinations()',
    )
    expect(rows.map((row) => row.user_id)).toEqual([alice.id])
  })

  it('excludes the caller from their own friend-destination read', async () => {
    await db.as(alice, `select public.report_destinations(array['shroud'])`)
    const rows = await db.as<{ user_id: string }>(
      alice,
      'select user_id from public.list_friend_destinations()',
    )
    expect(rows.map((row) => row.user_id)).not.toContain(alice.id)
  })
})

// ---------------------------------------------------------------- privacy

describe('privacy is applied at write time', () => {
  it('publishes nothing while hiding activity, but stays online', async () => {
    await db.as(alice, `select public.set_presence_visibility('hide_activity')`)
    await db.as(alice, `select public.report_destinations(array['shroud','lirik'])`)

    expect(await published(alice)).toEqual([])
    const [row] = await db.root<{ status: string; channel: string | null }>(
      'select status, channel from public.presence where user_id = $1',
      [alice.id],
    )
    expect(row.status).toBe('online')
    expect(row.channel).toBeNull()
  })

  it('publishes nothing and appears offline while invisible', async () => {
    await db.as(alice, `select public.set_presence_visibility('invisible')`)
    await db.as(alice, `select public.report_destinations(array['shroud'])`)

    expect(await published(alice)).toEqual([])
    const [row] = await db.root<{ status: string }>(
      'select status from public.presence where user_id = $1',
      [alice.id],
    )
    expect(row.status).toBe('offline')
  })

  it('drops previously published destinations when visibility tightens', async () => {
    await db.as(alice, `select public.report_destinations(array['shroud','lirik'])`)
    expect(await published(alice)).toHaveLength(2)

    await db.as(alice, `select public.set_presence_visibility('hide_activity')`)
    await db.as(alice, `select public.report_destinations(array['shroud','lirik'])`)
    expect(await published(alice)).toEqual([])
  })
})

// --------------------------------------------------------------- sign out

describe('signing out', () => {
  it('removes the destinations rather than relying on the gate alone', async () => {
    await db.as(alice, `select public.report_destinations(array['shroud','lirik'])`)
    await db.as(alice, 'select public.report_offline()')

    expect(await published(alice)).toEqual([])
    const [row] = await db.root<{ status: string; channel: string | null }>(
      'select status, channel from public.presence where user_id = $1',
      [alice.id],
    )
    expect(row.status).toBe('offline')
    expect(row.channel).toBeNull()
  })
})

// --------------------------------------------------- old-client compatibility

describe('a v0.4.1 client, which knows none of this', () => {
  it('gets a destination row from its singleton write', async () => {
    await db.as(alice, `select public.report_presence('twitch', 'shroud')`)
    expect(await published(alice)).toEqual(['shroud'])
  })

  it('is visible to a new client through the multi-destination reader', async () => {
    await db.as(alice, `select public.report_presence('twitch', 'shroud')`)
    expect(await visibleTo(bob, alice)).toEqual(['shroud'])
  })

  it('replaces its singleton on navigation rather than accumulating', async () => {
    await db.as(alice, `select public.report_presence('twitch', 'shroud')`)
    await db.as(alice, `select public.report_presence('twitch', 'lirik')`)
    expect(await published(alice)).toEqual(['lirik'])
  })

  it('clears its destination when it reports no channel', async () => {
    await db.as(alice, `select public.report_presence('twitch', 'shroud')`)
    await db.as(alice, `select public.report_presence(null, null)`)
    expect(await published(alice)).toEqual([])
  })

  /** list_friends is what an old client reads. It must keep working. */
  it('still sees friends through list_friends, with a single channel each', async () => {
    await db.as(bob, `select public.report_destinations(array['lirik','shroud'])`)
    const rows = await db.as<{ user_id: string; channel: string | null }>(
      alice,
      'select user_id, channel from public.list_friends()',
    )
    const bobRow = rows.find((row) => row.user_id === bob.id)
    // One channel, and it is the primary - which is what an old client can
    // render. It is not "wrong", it is a subset.
    expect(bobRow?.channel).toBe('lirik')
  })

  it('can share a room with a new client, in both directions', async () => {
    // Alice is an old client on shroud; Bob is a new client on shroud + lirik.
    await db.as(alice, `select public.report_presence('twitch', 'shroud')`)
    await db.as(bob, `select public.report_destinations(array['shroud','lirik'])`)

    const aliceSees = await db.as<{ user_id: string }>(
      alice,
      `select user_id from public.stream_room_members('shroud')`,
    )
    const bobSees = await db.as<{ user_id: string }>(
      bob,
      `select user_id from public.stream_room_members('shroud')`,
    )
    expect(aliceSees.map((row) => row.user_id)).toEqual([bob.id])
    expect(bobSees.map((row) => row.user_id)).toEqual([alice.id])
  })
})

// ------------------------------------------------------------ stream rooms

describe('rooms with multiple destinations', () => {
  beforeEach(async () => {
    await befriend(alice, carol)
  })

  it('puts a two-destination user in both rooms at once', async () => {
    await db.as(alice, `select public.report_destinations(array['shroud','lirik'])`)
    await db.as(bob, `select public.report_destinations(array['lirik'])`)
    await db.as(carol, `select public.report_destinations(array['shroud'])`)

    const shroud = await db.as<{ user_id: string }>(
      alice,
      `select user_id from public.stream_room_members('shroud')`,
    )
    const lirik = await db.as<{ user_id: string }>(
      alice,
      `select user_id from public.stream_room_members('lirik')`,
    )

    expect(shroud.map((row) => row.user_id)).toEqual([carol.id])
    expect(lirik.map((row) => row.user_id)).toEqual([bob.id])
  })

  it('lets a two-destination user send in both, without crossing them', async () => {
    await db.as(alice, `select public.report_destinations(array['shroud','lirik'])`)
    await db.as(bob, `select public.report_destinations(array['lirik'])`)
    await db.as(carol, `select public.report_destinations(array['shroud'])`)

    await db.as(alice, `select public.send_room_message('shroud', 'hello shroud')`)
    await db.as(alice, `select public.send_room_message('lirik', 'hello lirik')`)

    const carolSees = await db.as<{ channel: string; body: string }>(
      carol,
      'select channel, body from public.room_messages order by created_at',
    )
    const bobSees = await db.as<{ channel: string; body: string }>(
      bob,
      'select channel, body from public.room_messages order by created_at',
    )

    // Each recipient got exactly the room they are in, and nothing else.
    expect(carolSees.map((row) => row.body)).toEqual(['hello shroud'])
    expect(bobSees.map((row) => row.body)).toEqual(['hello lirik'])
  })

  it('keeps reactions channel-isolated in the same way', async () => {
    await db.as(alice, `select public.report_destinations(array['shroud','lirik'])`)
    await db.as(bob, `select public.report_destinations(array['lirik'])`)
    await db.as(carol, `select public.report_destinations(array['shroud'])`)

    await db.as(alice, `select public.send_together_reaction('shroud', 'fire')`)

    const carolSees = await db.as(carol, 'select channel from public.together_reactions')
    const bobSees = await db.as(bob, 'select channel from public.together_reactions')
    expect(carolSees).toHaveLength(1)
    expect(bobSees).toHaveLength(0)
  })

  it('refuses a send to a channel the sender has not published', async () => {
    await db.as(alice, `select public.report_destinations(array['shroud'])`)
    await expect(
      db.as(alice, `select public.send_room_message('lirik', 'let me in')`),
    ).rejects.toThrow(/not watching/)
  })

  it('refuses a send once the account has gone stale', async () => {
    await db.as(alice, `select public.report_destinations(array['shroud'])`)
    await ageLiveness(alice, 120)
    await expect(
      db.as(alice, `select public.send_room_message('shroud', 'still here?')`),
    ).rejects.toThrow(/not watching/)
  })

  it('empties a room whose members have gone stale', async () => {
    await db.as(alice, `select public.report_destinations(array['shroud'])`)
    await db.as(carol, `select public.report_destinations(array['shroud'])`)
    expect(
      await db.as(alice, `select user_id from public.stream_room_members('shroud')`),
    ).toHaveLength(1)

    await ageLiveness(carol, 120)
    expect(
      await db.as(alice, `select user_id from public.stream_room_members('shroud')`),
    ).toHaveLength(0)
  })

  it('keeps unrelated friend components apart on one channel', async () => {
    // Alice-Bob are friends; Carol is friends with Alice but we break that so
    // she forms her own component with a fresh account.
    const dave = await db.createUser({ login: 'dave_tv', displayName: 'Dave' })
    await db.as(alice, 'select public.remove_friend($1)', [carol.id])
    await befriend(carol, dave)

    for (const user of [alice, bob, carol, dave]) {
      await db.as(user, `select public.report_destinations(array['shroud'])`)
    }

    const aliceRoom = await db.as<{ user_id: string }>(
      alice,
      `select user_id from public.stream_room_members('shroud')`,
    )
    const carolRoom = await db.as<{ user_id: string }>(
      carol,
      `select user_id from public.stream_room_members('shroud')`,
    )

    expect(aliceRoom.map((row) => row.user_id)).toEqual([bob.id])
    expect(carolRoom.map((row) => row.user_id)).toEqual([dave.id])
  })
})
