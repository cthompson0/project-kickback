import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { createTestDb } from './harness'
import type { TestDb, TestUser } from './harness'

/**
 * Ephemeral Stream Room messages, against real Postgres.
 *
 * The interesting behaviour is all in the RPC, and none of it is visible from
 * the client: who a message reaches is decided once, server-side, at send time
 * - so the tests that matter are the ones that ask WHO GOT A ROW, and the ones
 * that ask what happens to those rows when the graph moves underneath them.
 *
 * Merge and split are the reason this model was chosen over a room record, and
 * they are the reason this file exists.
 */

/**
 * A single-quoted SQL literal.
 *
 * PGlite's extended protocol does not survive some parameterised calls into
 * SECURITY DEFINER functions here - it answers 08P01 rather than the error the
 * function raised, which would silently turn every refusal assertion below
 * green for the wrong reason. Inlining keeps the harness honest; the value
 * checks being asserted live in the SQL, not in this file.
 */
function lit(value: string): string {
  return `'${value.split("'").join("''")}'`
}

const CHANNEL = 'lirik'

let db: TestDb

/**
 * Everyone present and online on the channel, so a room can form.
 *
 * The channel is inlined rather than bound: PGlite's extended protocol does
 * not survive a parameterised call to a void-returning function, and
 * report_presence returns void. Validated first, so inlining stays a harness
 * detail rather than a habit - the production path is a bound RPC parameter,
 * and the SQL's own regex check is asserted separately below.
 */
async function arrive(user: TestUser, channel = CHANNEL): Promise<void> {
  if (!/^[a-z0-9_]+$/.test(channel)) throw new Error(`not a test channel: ${channel}`)
  await db.as(user, `select public.report_presence('twitch', '${channel}')`)
}

async function befriend(a: TestUser, b: TestUser): Promise<void> {
  await db.root(`select public.create_friendship(${lit(a.id)}::uuid, ${lit(b.id)}::uuid)`)
}


async function send(user: TestUser, body: string, channel = CHANNEL): Promise<number> {
  const rows = await db.as<{ sent: number }>(
    user,
    `select public.send_room_message(${lit(channel)}, ${lit(body)}) as sent`,
  )
  return Number(rows[0].sent)
}

/** One person's inbox for a channel, oldest first, as the client reads it. */
async function inbox(user: TestUser, channel = CHANNEL): Promise<string[]> {
  const rows = await db.as<{ body: string }>(
    user,
    `select body from public.room_messages
      where recipient_id = ${lit(user.id)} and channel = ${lit(channel)}
      order by created_at, id`,
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

beforeAll(async () => {
  db = await createTestDb()
}, 60_000)

afterAll(async () => {
  await db?.close()
})

beforeEach(async () => {
  await db.reset()
})

describe('who a message reaches', () => {
  it('reaches a direct friend and the sender, and nobody else', async () => {
    const alice = await db.createUser({ login: 'alice' })
    const bob = await db.createUser({ login: 'bob' })
    const stranger = await db.createUser({ login: 'stranger' })

    await befriend(alice, bob)
    await arrive(alice)
    await arrive(bob)
    await arrive(stranger)

    expect(await send(alice, 'holy shit')).toBe(2)
    expect(await inbox(bob)).toEqual(['holy shit'])
    expect(await inbox(alice)).toEqual(['holy shit'])
    // A stranger on the same stream is not in the room, so no row exists.
    expect(await inbox(stranger)).toEqual([])
  })

  it('works in both directions', async () => {
    // The one-direction reaction bug, asserted for text before it can happen.
    const alice = await db.createUser({ login: 'alice' })
    const bob = await db.createUser({ login: 'bob' })
    await befriend(alice, bob)
    await arrive(alice)
    await arrive(bob)

    await send(alice, 'from alice')
    await send(bob, 'from bob')

    expect(await inbox(alice)).toEqual(['from alice', 'from bob'])
    expect(await inbox(bob)).toEqual(['from alice', 'from bob'])
  })

  it('reaches a friend of a friend, who never had to know the sender', async () => {
    /*
     * The connected component, which is the whole product claim. Carol is
     * Bob's friend and not Alice's; she is in the room because the graph says
     * so, and she receives Alice's message because the server decided that at
     * send time.
     */
    const alice = await db.createUser({ login: 'alice' })
    const bob = await db.createUser({ login: 'bob' })
    const carol = await db.createUser({ login: 'carol' })
    await befriend(alice, bob)
    await befriend(bob, carol)
    for (const user of [alice, bob, carol]) await arrive(user)

    expect(await send(alice, 'hello everyone')).toBe(3)
    expect(await inbox(carol)).toEqual(['hello everyone'])
  })

  it('does not reach an unrelated cluster on the same channel', async () => {
    const alice = await db.createUser({ login: 'alice' })
    const bob = await db.createUser({ login: 'bob' })
    const dana = await db.createUser({ login: 'dana' })
    const eli = await db.createUser({ login: 'eli' })
    await befriend(alice, bob)
    await befriend(dana, eli)
    for (const user of [alice, bob, dana, eli]) await arrive(user)

    await send(alice, 'private to our cluster')
    expect(await inbox(dana)).toEqual([])
    expect(await inbox(eli)).toEqual([])
  })

  it('does not reach a friend who is watching something else', async () => {
    const alice = await db.createUser({ login: 'alice' })
    const bob = await db.createUser({ login: 'bob' })
    await befriend(alice, bob)
    await arrive(alice)
    await arrive(bob, 'xqc')

    expect(await send(alice, 'anyone here')).toBe(1)
    expect(await inbox(bob)).toEqual([])
  })
})

describe('split and merge', () => {
  it('stops future delivery once the bridge leaves', async () => {
    /*
     * A <-> B <-> C, then B goes. A and C are no longer one room, and A's next
     * message computes a component without C in it - so no row for C is ever
     * written. Nothing filters it; there is nothing to filter.
     */
    const alice = await db.createUser({ login: 'alice' })
    const bob = await db.createUser({ login: 'bob' })
    const carol = await db.createUser({ login: 'carol' })
    await befriend(alice, bob)
    await befriend(bob, carol)
    for (const user of [alice, bob, carol]) await arrive(user)

    await send(alice, 'before the split')
    await db.as(bob, `select public.report_offline()`)
    await send(alice, 'after the split')

    expect(await inbox(carol)).toEqual(['before the split'])
    expect(await inbox(alice)).toEqual(['before the split', 'after the split'])
  })

  it('leaves already-delivered messages alone after a split', async () => {
    // You cannot un-send. Deleting on split would also make a conversation
    // flicker every time presence wobbled.
    const alice = await db.createUser({ login: 'alice' })
    const bob = await db.createUser({ login: 'bob' })
    await befriend(alice, bob)
    await arrive(alice)
    await arrive(bob)

    await send(alice, 'said while together')
    await db.as(bob, `select public.report_offline()`)

    expect(await inbox(bob)).toEqual(['said while together'])
  })

  it('does not backfill history when two clusters merge', async () => {
    /*
     * THE reason this is a fan-out table and not a body table with a policy.
     *
     * Carol and Dana were not authorized when Alice spoke, so no row addressed
     * to them exists. It is not that a query excludes it - there is nothing
     * for a more permissive read to find.
     */
    const alice = await db.createUser({ login: 'alice' })
    const bob = await db.createUser({ login: 'bob' })
    const carol = await db.createUser({ login: 'carol' })
    const dana = await db.createUser({ login: 'dana' })
    await befriend(alice, bob)
    await befriend(carol, dana)
    for (const user of [alice, bob, carol, dana]) await arrive(user)

    await send(alice, 'said before the merge')
    expect(await inbox(carol)).toEqual([])

    // The bridge that merges them.
    await befriend(bob, carol)

    expect(await inbox(carol)).toEqual([])
    expect(await inbox(dana)).toEqual([])
  })

  it('delivers new messages across a merged component', async () => {
    const alice = await db.createUser({ login: 'alice' })
    const bob = await db.createUser({ login: 'bob' })
    const carol = await db.createUser({ login: 'carol' })
    const dana = await db.createUser({ login: 'dana' })
    await befriend(alice, bob)
    await befriend(carol, dana)
    for (const user of [alice, bob, carol, dana]) await arrive(user)

    await send(alice, 'said before the merge')
    await befriend(bob, carol)
    await send(alice, 'said after the merge')

    expect(await inbox(carol)).toEqual(['said after the merge'])
    expect(await inbox(dana)).toEqual(['said after the merge'])
    expect(await inbox(alice)).toEqual(['said before the merge', 'said after the merge'])
  })
})

describe('what the server refuses', () => {
  let alice: TestUser
  let bob: TestUser

  beforeEach(async () => {
    alice = await db.createUser({ login: 'alice' })
    bob = await db.createUser({ login: 'bob' })
    await befriend(alice, bob)
    await arrive(alice)
    await arrive(bob)
  })

  it('refuses a message from somebody not on the channel', async () => {
    const carol = await db.createUser({ login: 'carol' })
    expect(await refusal(() => send(carol, 'let me in'))).toMatch(/not watching/i)
  })

  it('refuses a message longer than 280 characters', async () => {
    expect(await refusal(() => send(alice, 'x'.repeat(281)))).toMatch(/too long/i)
    await expect(send(alice, 'x'.repeat(280))).resolves.toBe(2)
  })

  it('refuses an empty message', async () => {
    expect(await refusal(() => send(alice, '   '))).toMatch(/too long/i)
  })

  it('refuses a channel that is not one', async () => {
    expect(await refusal(() => send(alice, 'hi', 'not a channel!'))).toMatch(/not a channel/i)
  })

  it('rate limits, in its own bucket', async () => {
    for (let i = 0; i < 20; i += 1) await send(alice, `message ${i}`)
    expect(await refusal(() => send(alice, 'one too many'))).toMatch(/too quickly/i)

    /*
     * And reactions still work, which is the point of a separate bucket:
     * hammering one action must not silence another.
     */
    await expect(
      db.as(alice, `select public.send_together_reaction(${lit(CHANNEL)}, 'lol')`),
    ).resolves.toBeDefined()
  })

  it('cannot be called by an anonymous client', async () => {
    expect(
      await refusal(() => db.anon(`select public.send_room_message(${lit(CHANNEL)}, 'hi')`)),
    ).toMatch(/permission denied|not signed in|kickback/i)
  })

  it('has no writable path from a client', async () => {
    // Only the RPC writes. Otherwise a modified client could address a row to
    // anybody, which is the entire authorization model bypassed in one insert.
    expect(
      await refusal(() =>
        db.as(
          alice,
          `insert into public.room_messages (recipient_id, sender_id, channel, body)
           values (${lit(bob.id)}, ${lit(alice.id)}, ${lit(CHANNEL)}, 'forged')`,
        ),
      ),
    ).toMatch(/permission denied/i)
  })

  it('lets nobody read another person\'s inbox', async () => {
    await send(alice, 'for our eyes')
    const rows = await db.as<{ body: string }>(
      alice,
      `select body from public.room_messages where recipient_id = ${lit(bob.id)}`,
    )
    // RLS is recipient_id = auth.uid(), so asking for Bob's rows as Alice
    // returns nothing rather than erroring.
    expect(rows).toEqual([])
  })
})

describe('retention', () => {
  it('sweeps messages older than the window when the sender speaks again', async () => {
    const alice = await db.createUser({ login: 'alice' })
    const bob = await db.createUser({ login: 'bob' })
    await befriend(alice, bob)
    await arrive(alice)
    await arrive(bob)

    await send(alice, 'ancient')
    await db.root(
      `update public.room_messages set created_at = now() - interval '31 minutes'`,
    )
    await send(alice, 'current')

    // The sender sweeps their own inbox as they speak.
    expect(await inbox(alice)).toEqual(['current'])
  })

  it('caps one inbox at two hundred rows per channel', async () => {
    /*
     * The bound that makes a thirty-minute window safe to state. Retention
     * cost is messages x recipients, and a room holds up to fifty people, so
     * the clock alone does not bound a fast conversation.
     */
    const alice = await db.createUser({ login: 'alice' })
    await arrive(alice)

    // Straight into the table, so this is about the cap and not the rate limit.
    await db.root(
      `insert into public.room_messages (recipient_id, sender_id, channel, body, created_at)
       select ${lit(alice.id)}::uuid, ${lit(alice.id)}::uuid, ${lit(CHANNEL)}, 'filler ' || g,
              now() - (g || ' seconds')::interval
         from generate_series(1, 250) g`,
    )

    await send(alice, 'the one that triggers the sweep')

    const [{ count }] = await db.root<{ count: string }>(
      `select count(*) as count from public.room_messages
        where recipient_id = ${lit(alice.id)} and channel = ${lit(CHANNEL)}`,
    )
    expect(Number(count)).toBe(200)

    // And the newest survived, which is the half that matters.
    const kept = await inbox(alice)
    expect(kept[kept.length - 1]).toBe('the one that triggers the sweep')
  })

  it('does not sweep another channel', async () => {
    const alice = await db.createUser({ login: 'alice' })
    await arrive(alice)
    await send(alice, 'on lirik')

    await arrive(alice, 'xqc')
    await db.root(
      `update public.room_messages set created_at = now() - interval '31 minutes'
        where channel = 'lirik'`,
    )
    await send(alice, 'on xqc', 'xqc')

    // The sweep is scoped to the channel being written to, so a stale message
    // elsewhere survives until somebody speaks there.
    expect(await inbox(alice, 'lirik')).toEqual(['on lirik'])
  })
})
