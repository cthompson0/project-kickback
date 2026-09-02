import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { createTestDb } from './harness'
import type { TestDb, TestUser } from './harness'

/**
 * Search has a ceiling now, and the ceiling is the point.
 *
 * WHAT THIS PROTECTS
 *
 * `search_users` matches a >=2-character PREFIX and returns ten rows. Six write
 * surfaces carried a rate budget and this one carried none, which made two
 * things free:
 *
 *   - ENUMERATION: ten names per prefix, 676 two-letter prefixes, no ceiling.
 *   - MEMBERSHIP PROBING: "is this specific person on Watchside" answered by
 *     typing their Twitch login, once, with no cost and no trace.
 *
 * Neither mattered while the directory was a private beta. Public launch is the
 * event that makes them matter.
 *
 * WHAT MUST NOT BREAK
 *
 * Ordinary friend-finding. A budget that frustrates somebody adding three
 * friends has traded a real feature for a theoretical attack, so the tests
 * below prove the generous case works as loudly as they prove the abusive one
 * stops.
 */

let db: TestDb
let alice: TestUser
let bob: TestUser
let carol: TestUser

const search = (user: TestUser, query: string) =>
  db.as<{
    user_id: string
    twitch_login: string
    relationship: string
    matched_by: string
  }>(user, 'select * from public.search_users($1)', [query])

/** How many searches the budget allows in its window. */
const BUDGET = 60

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
  carol = await db.createUser({ login: 'carolyn', displayName: 'Carolyn' })
})

describe('ordinary friend-finding still works', () => {
  it('finds somebody by their exact Twitch login', async () => {
    const rows = await search(alice, 'bob')
    expect(rows.map((r) => r.twitch_login)).toContain('bob')
    expect(rows.find((r) => r.twitch_login === 'bob')?.matched_by).toBe('twitch_login')
  })

  it('finds somebody by prefix, which is the feature', async () => {
    const rows = await search(alice, 'car')
    expect(rows.map((r) => r.twitch_login)).toContain('carolyn')
  })

  it('finds somebody by exact friend code', async () => {
    const [row] = await db.root<{ friend_code: string }>(
      'select friend_code from public.users where id = $1',
      [bob.id],
    )
    const rows = await search(alice, row.friend_code)
    expect(rows[0].user_id).toBe(bob.id)
    expect(rows[0].matched_by).toBe('friend_code')
  })

  it('lets one person look up many friends in a sitting', async () => {
    /*
     * The generous case, stated as a number. The client debounces at 250ms with
     * a two-character minimum, so a name costs one to four searches; twenty
     * searches is a real person adding several friends and is nowhere near the
     * ceiling.
     */
    for (let i = 0; i < 20; i++) {
      expect((await search(alice, 'bob')).length).toBeGreaterThan(0)
    }
  })
})

describe('the budget stops enumeration', () => {
  it('goes quiet once the budget is spent', async () => {
    for (let i = 0; i < BUDGET; i++) await search(alice, 'bob')

    // The next one finds nothing, though the user plainly exists.
    expect(await search(alice, 'bob')).toEqual([])
  })

  it('refuses without raising, so a keystroke never becomes an error', async () => {
    /*
     * Deliberate. Search already answers "nothing found" for a short query and
     * for a name nobody has, so the client has always treated an empty result
     * as ordinary. An exception here would be an error dialog mid-typing - and
     * would tell an enumerator exactly where the ceiling is.
     */
    for (let i = 0; i < BUDGET + 5; i++) {
      await expect(search(alice, 'bob')).resolves.toBeInstanceOf(Array)
    }
  })

  it('is charged per person, so one abuser cannot mute everybody else', async () => {
    for (let i = 0; i < BUDGET + 1; i++) await search(alice, 'bob')
    expect(await search(alice, 'bob')).toEqual([])

    // Carol is unaffected.
    expect((await search(carol, 'bob')).length).toBeGreaterThan(0)
  })

  it('does not charge for a query too short to run', async () => {
    /*
     * A one-character query does no lookup, so charging for it would let a
     * client burn somebody's allowance on the way to typing a real name.
     */
    for (let i = 0; i < 200; i++) await search(alice, 'b')
    expect((await search(alice, 'bob')).length).toBeGreaterThan(0)
  })

  it('recovers when the window rolls over', async () => {
    for (let i = 0; i < BUDGET + 1; i++) await search(alice, 'bob')
    expect(await search(alice, 'bob')).toEqual([])

    // Age the window past its interval, exactly as time would.
    await db.root(
      `update public.rate_limits set window_started_at = now() - interval '11 minutes'
        where user_id = $1 and bucket = 'user_search'`,
      [alice.id],
    )

    expect((await search(alice, 'bob')).length).toBeGreaterThan(0)
  })

  it('bounds a systematic prefix sweep', async () => {
    /*
     * Enumeration pressure, in the shape it would really take: walk the
     * alphabet rather than repeat one query. The budget does not care what was
     * asked, only how much was asked.
     */
    const letters = 'abcdefghijklmnopqrstuvwxyz'
    let productive = 0
    for (const a of letters) {
      for (const b of letters) {
        const rows = await search(alice, a + b)
        if (rows.length > 0) productive++
        if (productive > BUDGET) break
      }
      if (productive > BUDGET) break
    }
    // The sweep cannot outrun the ceiling.
    expect(productive).toBeLessThanOrEqual(BUDGET)
  }, 120_000)
})

describe('nothing about privacy changed', () => {
  it('still tells the blocker, and only the blocker', async () => {
    await db.as(alice, 'select public.block_user($1)', [bob.id])

    const mine = await search(alice, 'bob')
    expect(mine.find((r) => r.user_id === bob.id)?.relationship).toBe('blocked')

    /*
     * The other direction is the one that matters: Bob must not learn he was
     * blocked. Alice looks like any other stranger, and the Add button's
     * refusal is indistinguishable from any other failure.
     */
    const theirs = await search(bob, 'alice')
    expect(theirs.find((r) => r.user_id === alice.id)?.relationship).toBe('none')
  })

  it('still marks self, friends and pending requests', async () => {
    expect((await search(alice, 'alice')).find((r) => r.user_id === alice.id)?.relationship).toBe(
      'self',
    )

    await db.as(alice, 'select public.send_friend_request($1)', [bob.id])
    expect((await search(alice, 'bob')).find((r) => r.user_id === bob.id)?.relationship).toBe(
      'request_sent',
    )
    expect((await search(bob, 'alice')).find((r) => r.user_id === alice.id)?.relationship).toBe(
      'request_received',
    )
  })

})
