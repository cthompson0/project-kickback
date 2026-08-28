import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { createTestDb } from './harness'
import type { TestDb, TestUser } from './harness'

/**
 * The multi-destination smoke failure, at the layer where it actually
 * destroyed data.
 *
 * The manual report was that a viewer with two Twitch tabs open was only ever
 * seen at one of them. tests/db/presenceDestinations.test.ts already proves
 * that publishing a set works, so the interesting question is not what
 * report_destinations does - it is what happens when the OTHER entry point is
 * used immediately afterwards.
 *
 * report_presence is a v0.4.1 client saying "I am on exactly this one
 * channel", and 0025's shim honours that literally: it mirrors the singleton
 * into the destination table, which means deleting everything else. That is
 * correct for an old client and catastrophic for a new one, and the old client
 * behaviour is the one that must not change. So these tests pin BOTH halves:
 * the destructive interaction is real and stays real, and the new client's
 * write path does not contain it.
 *
 * Nothing here is a proposed schema change. Every assertion is about 0025
 * exactly as the owner applied it.
 */

let db: TestDb
let alice: TestUser
let bob: TestUser

/** Everything the server currently publishes for one account. */
async function published(user: TestUser): Promise<string[]> {
  const rows = await db.root<{ channel: string }>(
    'select channel from public.presence_destinations where user_id = $1 order by channel',
    [user.id],
  )
  return rows.map((row) => row.channel)
}

/** What a friend can actually see, which is the question the owner asked. */
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
  await befriend(alice, bob)
})

// ------------------------------------------------- the collapse, reproduced

describe('a singleton write collapses a published set', () => {
  /**
   * The exact question in the brief, answered by execution.
   *
   * report_destinations writes [A, B]; report_presence then writes A. What
   * rows remain? One. This is the whole defect, four lines long.
   */
  it('leaves only the singleton when report_presence follows report_destinations', async () => {
    await db.as(alice, `select public.report_destinations(array['shroud','lirik'])`)
    expect(await published(alice)).toEqual(['lirik', 'shroud'])

    await db.as(alice, `select public.report_presence('twitch', 'shroud')`)

    expect(await published(alice)).toEqual(['shroud'])
  })

  /** And the friend sees the collapse, not just the table. */
  it('is visible to the friend as a single destination', async () => {
    await db.as(alice, `select public.report_destinations(array['shroud','lirik'])`)
    expect(await visibleTo(bob, alice)).toEqual(['lirik', 'shroud'])

    await db.as(alice, `select public.report_presence('twitch', 'shroud')`)

    expect(await visibleTo(bob, alice)).toEqual(['shroud'])
  })

  /**
   * It does not matter which channel the singleton names - the surviving row
   * is whatever report_presence said, and everything else goes.
   */
  it('keeps whichever channel the singleton names, and only that one', async () => {
    await db.as(alice, `select public.report_destinations(array['shroud','lirik','summit1g'])`)
    await db.as(alice, `select public.report_presence('twitch', 'lirik')`)
    expect(await published(alice)).toEqual(['lirik'])
  })

  /**
   * The worst shape of it: the visible tab is on twitch.tv itself rather than
   * a channel, so the singleton write names no channel at all - and takes
   * every open stream with it. Nothing about the streams changed.
   */
  it('erases every destination when the singleton names no channel', async () => {
    await db.as(alice, `select public.report_destinations(array['shroud','lirik'])`)
    await db.as(alice, `select public.report_presence('twitch', null)`)
    expect(await published(alice)).toEqual([])
    expect(await visibleTo(bob, alice)).toEqual([])
  })

  /**
   * And it does not repair itself. Re-stating the same set is a no-op from the
   * client's point of view - it believes it already published it - so the
   * collapsed state is where things stay.
   */
  it('stays collapsed until the set genuinely changes', async () => {
    await db.as(alice, `select public.report_destinations(array['shroud','lirik'])`)
    await db.as(alice, `select public.report_presence('twitch', 'shroud')`)
    // Time passes; the heartbeat runs; nothing about it touches destinations.
    await db.as(alice, 'select public.heartbeat()')
    await db.as(alice, 'select public.heartbeat()')
    expect(await published(alice)).toEqual(['shroud'])
  })
})

// ------------------------------------------------- the fixed write contract

describe('the write path the fixed client uses', () => {
  /** One entry point, repeated. This is all the new client ever does. */
  it('keeps both destinations across repeated set writes', async () => {
    await db.as(alice, `select public.report_destinations(array['shroud','lirik'])`)
    await db.as(alice, `select public.report_destinations(array['shroud','lirik'])`)
    await db.as(alice, `select public.report_destinations(array['shroud','lirik'])`)
    expect(await published(alice)).toEqual(['lirik', 'shroud'])
    expect(await visibleTo(bob, alice)).toEqual(['lirik', 'shroud'])
  })

  /**
   * The periodic refresh, which is the other half of "observed as one".
   *
   * A destination is only active for thirty minutes. Nothing but a destination
   * write moves that clock - the heartbeat moves presence.last_seen_at and
   * stops there - so a viewer who simply watches would fall out of the set
   * they published. Re-stating it is what keeps them in.
   */
  it('re-stating the set revives destinations that were about to expire', async () => {
    await db.as(alice, `select public.report_destinations(array['shroud','lirik'])`)
    await db.root(
      `update public.presence_destinations
          set last_active_at = now() - interval '29 minutes'
        where user_id = $1`,
      [alice.id],
    )
    expect(await visibleTo(bob, alice)).toEqual(['lirik', 'shroud'])

    await db.as(alice, `select public.report_destinations(array['shroud','lirik'])`)
    await db.root(
      `update public.presence_destinations
          set last_active_at = last_active_at - interval '29 minutes'
        where user_id = $1`,
      [alice.id],
    )
    // Still inside the window because the refresh reset the clock.
    expect(await visibleTo(bob, alice)).toEqual(['lirik', 'shroud'])
  })

  /**
   * Without the refresh this is what the owner would have seen half an hour
   * into a session: the same collapse, arriving slowly. presence.channel keeps
   * the primary alive through the legacy branch of is_present_at, so it looks
   * exactly like the original bug rather than like an outage.
   */
  it('collapses to the legacy primary once the rows age out', async () => {
    await db.as(alice, `select public.report_destinations(array['shroud','lirik'])`)
    await db.root(
      `update public.presence_destinations
          set last_active_at = now() - interval '31 minutes'
        where user_id = $1`,
      [alice.id],
    )

    expect(await visibleTo(bob, alice)).toEqual([])
    // And the account is still perfectly live, on its primary channel only.
    const [row] = await db.root<{ channel: string }>(
      'select channel from public.presence where user_id = $1',
      [alice.id],
    )
    expect(row.channel).toBe('shroud')
    const [present] = await db.as<{ is_present_at: boolean }>(
      bob,
      `select public.is_present_at($1, 'lirik')`,
      [alice.id],
    )
    expect(present.is_present_at).toBe(false)
  })

  /** The set write maintains the legacy row itself, so nothing else has to. */
  it('maintains the legacy presence row without a second call', async () => {
    await db.as(alice, `select public.report_destinations(array['shroud','lirik'])`)
    const [row] = await db.root<{ status: string; platform: string; channel: string }>(
      'select status, platform, channel from public.presence where user_id = $1',
      [alice.id],
    )
    expect(row.status).toBe('online')
    expect(row.platform).toBe('twitch')
    // Position one of what the client sent: its most recently opened stream.
    expect(row.channel).toBe('shroud')
  })
})

// --------------------------------------------------- old clients, untouched

describe('a v0.4.1 client is unaffected', () => {
  /**
   * The reason report_presence must keep collapsing: for the client that
   * actually sends it, the singleton IS the whole truth.
   */
  it('publishes its one channel and is seen at it', async () => {
    await db.as(alice, `select public.report_presence('twitch', 'shroud')`)
    expect(await published(alice)).toEqual(['shroud'])
    expect(await visibleTo(bob, alice)).toEqual(['shroud'])
  })

  it('moves its one channel without leaving the old one behind', async () => {
    await db.as(alice, `select public.report_presence('twitch', 'shroud')`)
    await db.as(alice, `select public.report_presence('twitch', 'lirik')`)
    expect(await published(alice)).toEqual(['lirik'])
  })

  /** And it can still see, and be seen by, a multi-destination client. */
  it('sees a new client at every one of its destinations', async () => {
    await db.as(bob, `select public.report_destinations(array['shroud','lirik'])`)
    expect(await visibleTo(alice, bob)).toEqual(['lirik', 'shroud'])

    const [present] = await db.as<{ is_present_at: boolean }>(
      alice,
      `select public.is_present_at($1, 'lirik')`,
      [bob.id],
    )
    expect(present.is_present_at).toBe(true)
  })

  it('shares a room with a new client on the new client’s second stream', async () => {
    await db.as(bob, `select public.report_destinations(array['shroud','lirik'])`)
    await db.as(alice, `select public.report_presence('twitch', 'lirik')`)

    const rows = await db.as<{ user_id: string }>(
      alice,
      `select user_id from public.stream_room_members('lirik')`,
    )
    expect(rows.map((row) => row.user_id)).toEqual([bob.id])
  })
})

// -------------------------------------------------------- the owner's SQL

/**
 * The diagnostic queries printed in the smoke-failure report, executed.
 *
 * They exist so a manual retest can tell a WRITE failure from a READ or UI
 * failure without guessing, which means they have to actually run against this
 * schema - table names, column names and all. Running them here is what stops
 * the report shipping SQL that was only ever read.
 */
describe('the hosted diagnostic queries', () => {
  const LOOKUP = `
    select ca.platform_login,
           p.status,
           p.channel as legacy_primary,
           (p.status = 'online' and p.last_seen_at > now() - interval '90 seconds')
             as parent_live,
           (select count(*) from public.presence_destinations d
             where d.user_id = ca.user_id) as destinations_total,
           (select count(*) from public.presence_destinations d
             where d.user_id = ca.user_id
               and d.last_active_at > now() - interval '30 minutes')
             as destinations_active
      from public.connected_accounts ca
      left join public.presence p on p.user_id = ca.user_id
     where ca.platform = 'twitch'
       and ca.platform_login = lower($1)
  `

  const ROWS = `
    select d.channel,
           d.opened_at,
           d.last_active_at,
           now() - d.last_active_at as destination_age,
           d.last_active_at > now() - interval '30 minutes' as destination_active,
           public.is_present_at(d.user_id, d.channel) as visible_to_a_friend
      from public.connected_accounts ca
      join public.presence_destinations d on d.user_id = ca.user_id
     where ca.platform = 'twitch'
       and ca.platform_login = lower($1)
     order by d.last_active_at desc, d.channel
  `

  it('summarises the account in one row', async () => {
    await db.as(alice, `select public.report_destinations(array['shroud','lirik'])`)
    const [row] = await db.root<{
      platform_login: string
      status: string
      legacy_primary: string
      parent_live: boolean
      destinations_total: string
      destinations_active: string
    }>(LOOKUP, ['Alice_TV'])

    expect(row.platform_login).toBe('alice_tv')
    expect(row.parent_live).toBe(true)
    expect(row.legacy_primary).toBe('shroud')
    expect(Number(row.destinations_total)).toBe(2)
    expect(Number(row.destinations_active)).toBe(2)
  })

  it('lists every destination with whether a friend could see it', async () => {
    await db.as(alice, `select public.report_destinations(array['shroud','lirik'])`)
    const rows = await db.root<{ channel: string; visible_to_a_friend: boolean }>(ROWS, [
      'alice_tv',
    ])
    expect(rows.map((row) => row.channel).sort()).toEqual(['lirik', 'shroud'])
    expect(rows.every((row) => row.visible_to_a_friend)).toBe(true)
  })

  /** The whole point: it separates a write failure from a read failure. */
  it('shows a collapsed write as one row rather than as an invisible one', async () => {
    await db.as(alice, `select public.report_destinations(array['shroud','lirik'])`)
    await db.as(alice, `select public.report_presence('twitch', 'shroud')`)
    const rows = await db.root<{ channel: string }>(ROWS, ['alice_tv'])
    expect(rows.map((row) => row.channel)).toEqual(['shroud'])
  })

  /** And an aged-out set as rows that exist but are not active. */
  it('shows an expired set as present but inactive', async () => {
    await db.as(alice, `select public.report_destinations(array['shroud','lirik'])`)
    await db.root(
      `update public.presence_destinations
          set last_active_at = now() - interval '31 minutes'
        where user_id = $1`,
      [alice.id],
    )
    const rows = await db.root<{ destination_active: boolean; visible_to_a_friend: boolean }>(
      ROWS,
      ['alice_tv'],
    )
    expect(rows).toHaveLength(2)
    expect(rows.every((row) => row.destination_active)).toBe(false)
    expect(rows.every((row) => row.visible_to_a_friend)).toBe(false)
  })

  it('returns nothing for a login that is not connected', async () => {
    const rows = await db.root(LOOKUP, ['nobody_at_all'])
    expect(rows).toEqual([])
  })
})
