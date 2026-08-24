import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { createTestDb } from './harness'
import type { TestDb, TestUser } from './harness'

/**
 * Authorization suite. Every test runs as a real `authenticated` Postgres role
 * with a JWT subject claim, so what is being tested is the database's own
 * enforcement, not application code that could be bypassed by a modified client.
 */

let db: TestDb
let alice: TestUser
let bob: TestUser
let mallory: TestUser

/** Run something we expect the database to refuse, and return the message. */
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

// ---------------------------------------------------------------- bootstrap

describe('identity bootstrap', () => {
  it('creates a complete Kickback profile from a Twitch signup', async () => {
    const [profile] = await db.as<{
      display_name: string
      twitch_login: string
      friend_code: string
      presence_visibility: string
    }>(alice, 'select * from public.me()')

    expect(profile.display_name).toBe('Alice')
    expect(profile.twitch_login).toBe('alice_tv')
    expect(profile.friend_code).toMatch(/^KB-[0-9ABCDEFGHJKMNPQRSTVWXYZ]{4}-[0-9ABCDEFGHJKMNPQRSTVWXYZ]{4}$/)
    expect(profile.presence_visibility).toBe('visible')

    const [presence] = await db.as<{ status: string }>(
      alice,
      'select status from public.presence where user_id = $1',
      [alice.id],
    )
    expect(presence.status).toBe('offline')
  })

  it("keeps Twitch's capitalisation, from the claim that actually carries it", async () => {
    /*
     * The bug this pins down. Supabase's Twitch provider sets
     *
     *   name / full_name -> user.Login        (anoterostv)
     *   nickname / slug  -> user.DisplayName  (AnoterosTV)
     *
     * and 0004 read `name` first, so every display_name in every database was
     * the lowercase login. The fixture had the two the other way round, which
     * is exactly why this suite passed while production was wrong.
     */
    const user = await db.createUser({ login: 'anoterostv', displayName: 'AnoterosTV' })

    const [profile] = await db.as<{ display_name: string; twitch_login: string }>(
      user,
      'select * from public.me()',
    )

    expect(profile.display_name).toBe('AnoterosTV')
    // Identity is untouched: the login stays canonical and lowercase.
    expect(profile.twitch_login).toBe('anoterostv')
  })

  it('never invents capitalisation when Twitch sends none', async () => {
    const user = await db.createUser({ login: 'plainname', displayName: 'plainname' })
    const [profile] = await db.as<{ display_name: string }>(user, 'select * from public.me()')
    // Not "Plainname". A name nobody chose is worse than a plain one.
    expect(profile.display_name).toBe('plainname')
  })

  it('corrects a profile that was stored lowercase before the fix', async () => {
    // The state every existing account is in. The correction runs from
    // metadata the database already holds, so nobody signs out and no
    // friendship or group is touched.
    const user = await db.createUser({ login: 'legacytv', displayName: 'LegacyTV' })

    await db.root('update public.users set display_name = $1 where id = $2', [
      'legacytv',
      user.id,
    ])
    await db.root('update public.connected_accounts set platform_display_name = $1 where user_id = $2', [
      'legacytv',
      user.id,
    ])

    // Exactly what migration 0011's backfill does.
    await db.root(`
      update public.users u
      set display_name = left(v.fixed, 60)
      from (
        select a.id,
               public.display_name_from_meta(
                 coalesce(a.raw_user_meta_data, '{}'::jsonb),
                 public.login_from_meta(coalesce(a.raw_user_meta_data, '{}'::jsonb))
               ) as fixed
        from auth.users a
      ) v
      where u.id = v.id and v.fixed is not null and u.display_name is distinct from left(v.fixed, 60)
    `)

    const [profile] = await db.as<{ display_name: string; twitch_login: string }>(
      user,
      'select * from public.me()',
    )
    expect(profile.display_name).toBe('LegacyTV')
    expect(profile.twitch_login).toBe('legacytv')
  })

  it('falls back to the login itself, unaltered, when no name claim arrives', async () => {
    // The last resort in the chain. A provider that sends only a username
    // must not have a capitalisation invented for it - "Sparse" is a name
    // nobody chose.
    const user = await db.createUser({
      login: 'sparsemeta',
      rawMeta: { sub: 'twitch-sparsemeta', user_name: 'sparsemeta' },
    })
    const [profile] = await db.as<{ display_name: string }>(user, 'select * from public.me()')
    expect(profile.display_name).toBe('sparsemeta')
  })

  it('reads the display name out of provider metadata', async () => {
    const meta = { nickname: 'AnoterosTV', name: 'anoterostv', full_name: 'anoterostv' }
    const [row] = await db.root<{ display: string; login: string }>(
      `select public.display_name_from_meta($1::jsonb, public.login_from_meta($1::jsonb)) as display,
              public.login_from_meta($1::jsonb) as login`,
      [JSON.stringify(meta)],
    )
    expect(row).toEqual({ display: 'AnoterosTV', login: 'anoterostv' })
  })

  it('never copies the Twitch email into Kickback data', async () => {
    const [auth] = await db.root<{ email: string }>(
      'select email from auth.users where id = $1',
      [alice.id],
    )
    expect(auth.email).toBe('alice_tv@example.test')

    // Nothing in the public schema holds it.
    const [{ hits }] = await db.root<{ hits: number }>(
      `select count(*)::int as hits
       from public.users u
       full join public.connected_accounts c on true
       where u.display_name like '%@%'
          or c.platform_login like '%@%'
          or c.platform_display_name like '%@%'`,
    )
    expect(hits).toBe(0)
  })

  it('still produces a usable profile when the provider sends no metadata', async () => {
    const ghost = await db.createUser({ login: 'ghost', rawMeta: {} })
    const [profile] = await db.as<{ display_name: string; twitch_login: string | null }>(
      ghost,
      'select * from public.me()',
    )
    expect(profile.display_name).toBe('Kickback user')
    expect(profile.twitch_login).toBeNull()
  })

  it('issues a distinct friend code per user', async () => {
    const [{ distinct, total }] = await db.root<{ distinct: number; total: number }>(
      'select count(distinct friend_code)::int as distinct, count(*)::int as total from public.users',
    )
    expect(distinct).toBe(total)
    expect(total).toBe(3)
  })
})

// --------------------------------------------------------- unauthenticated

describe('unauthenticated access', () => {
  it('cannot read any Kickback table', async () => {
    expect(await refusal(() => db.anon('select * from public.users'))).toMatch(/permission denied/i)
    expect(await refusal(() => db.anon('select * from public.presence'))).toMatch(/permission denied/i)
    expect(await refusal(() => db.anon('select * from public.friendships'))).toMatch(/permission denied/i)
  })

  it('cannot call any Kickback RPC', async () => {
    expect(await refusal(() => db.anon('select public.search_users($1)', ['alice']))).toMatch(
      /permission denied/i,
    )
    expect(await refusal(() => db.anon('select public.list_friends()'))).toMatch(/permission denied/i)
  })

  it('is not helped by forging a subject claim without the authenticated role', async () => {
    // The claim alone is worthless: role and claim both come from a signed JWT.
    const message = await refusal(async () => {
      await db.root(`select set_config('request.jwt.claim.sub', '${alice.id}', false)`)
      return db.anon('select * from public.presence')
    })
    expect(message).toMatch(/permission denied/i)
  })
})

// ------------------------------------------------------------ direct writes

describe('direct table writes are impossible', () => {
  it('refuses to let a user modify their own presence row directly', async () => {
    const message = await refusal(() =>
      db.as(alice, `update public.presence set status = 'online' where user_id = $1`, [alice.id]),
    )
    expect(message).toMatch(/permission denied/i)
  })

  it("refuses to let a user modify someone else's presence row", async () => {
    await db.as(bob, `select public.report_presence('twitch', 'lirik')`)
    const message = await refusal(() =>
      db.as(mallory, `update public.presence set channel = 'evil' where user_id = $1`, [bob.id]),
    )
    expect(message).toMatch(/permission denied/i)

    // And Bob's row is untouched.
    await befriend(alice, bob)
    const [row] = await db.as<{ channel: string }>(
      alice,
      'select channel from public.presence where user_id = $1',
      [bob.id],
    )
    expect(row.channel).toBe('lirik')
  })

  it('refuses hand-written friendships', async () => {
    const message = await refusal(() =>
      db.as(mallory, 'insert into public.friendships (user_id, friend_id) values ($1, $2)', [
        mallory.id,
        alice.id,
      ]),
    )
    expect(message).toMatch(/permission denied/i)
  })

  it('refuses hand-written friend requests and preference changes', async () => {
    expect(
      await refusal(() =>
        db.as(mallory, 'insert into public.friend_requests (from_user, to_user) values ($1, $2)', [
          alice.id,
          mallory.id,
        ]),
      ),
    ).toMatch(/permission denied/i)

    expect(
      await refusal(() =>
        db.as(mallory, `update public.user_preferences set presence_visibility = 'invisible'`),
      ),
    ).toMatch(/permission denied/i)
  })
})

// ------------------------------------------------------------ actor forging

describe('actor identity cannot be forged', () => {
  it('writes presence for the caller, never for a supplied id', async () => {
    await db.as(bob, `select public.report_presence('twitch', 'shroud')`)

    const [bobRow] = await db.root<{ channel: string }>(
      'select channel from public.presence where user_id = $1',
      [bob.id],
    )
    const [aliceRow] = await db.root<{ channel: string | null }>(
      'select channel from public.presence where user_id = $1',
      [alice.id],
    )

    expect(bobRow.channel).toBe('shroud')
    expect(aliceRow.channel).toBeNull()
  })

  it('exposes no RPC that accepts an actor id', async () => {
    const args = await db.root<{ proname: string; args: string }>(
      `select p.proname, pg_get_function_arguments(p.oid) as args
       from pg_proc p
       join pg_namespace n on n.oid = p.pronamespace
       where n.nspname = 'public'
         and has_function_privilege('authenticated', p.oid, 'execute')
       order by p.proname`,
    )
    for (const fn of args) {
      expect(fn.args).not.toMatch(/actor|p_user_id|p_self|p_me\b/i)
    }
    // Sanity: the introspection actually found our API surface.
    expect(args.map((fn) => fn.proname)).toContain('report_presence')
  })
})

// ---------------------------------------------------------------- presence

describe('presence visibility', () => {
  it('hides presence from non-friends entirely', async () => {
    await db.as(bob, `select public.report_presence('twitch', 'lirik')`)
    const rows = await db.as(mallory, 'select * from public.presence where user_id = $1', [bob.id])
    expect(rows).toHaveLength(0)
  })

  it('shows status and channel to friends', async () => {
    await befriend(alice, bob)
    await db.as(bob, `select public.report_presence('twitch', 'lirik')`)

    const [row] = await db.as<{ status: string; platform: string; channel: string }>(
      alice,
      'select status, platform, channel from public.presence where user_id = $1',
      [bob.id],
    )
    expect(row).toMatchObject({ status: 'online', platform: 'twitch', channel: 'lirik' })
  })

  it('hide_activity shows online but never the channel', async () => {
    await befriend(alice, bob)
    await db.as(bob, `select public.set_presence_visibility('hide_activity')`)
    await db.as(bob, `select public.report_presence('twitch', 'lirik')`)

    const [row] = await db.as<{ status: string; channel: string | null }>(
      alice,
      'select status, channel from public.presence where user_id = $1',
      [bob.id],
    )
    expect(row.status).toBe('online')
    expect(row.channel).toBeNull()

    // The channel is not merely filtered on read - it was never stored.
    const [stored] = await db.root<{ channel: string | null }>(
      'select channel from public.presence where user_id = $1',
      [bob.id],
    )
    expect(stored.channel).toBeNull()
  })

  it('invisible looks exactly like being offline', async () => {
    await befriend(alice, bob)
    await db.as(bob, `select public.set_presence_visibility('invisible')`)
    await db.as(bob, `select public.report_presence('twitch', 'lirik')`)

    const [row] = await db.as<{ status: string; platform: string | null; channel: string | null }>(
      alice,
      'select status, platform, channel from public.presence where user_id = $1',
      [bob.id],
    )
    expect(row).toMatchObject({ status: 'offline', platform: null, channel: null })
  })

  it('does not leak an invisible user through a ticking last_seen_at', async () => {
    await befriend(alice, bob)
    await db.as(bob, `select public.set_presence_visibility('invisible')`)
    await db.as(bob, `select public.report_presence('twitch', 'lirik')`)

    const [first] = await db.as<{ last_seen_at: string; updated_at: string }>(
      alice,
      'select last_seen_at, updated_at from public.presence where user_id = $1',
      [bob.id],
    )

    // Several heartbeats later, an observer must see no movement at all.
    await db.as(bob, `select public.report_presence('twitch', 'shroud')`)
    await db.as(bob, `select public.heartbeat()`)
    await db.as(bob, `select public.report_presence('twitch', 'lirik')`)

    const [second] = await db.as<{ last_seen_at: string; updated_at: string }>(
      alice,
      'select last_seen_at, updated_at from public.presence where user_id = $1',
      [bob.id],
    )
    expect(second.last_seen_at).toEqual(first.last_seen_at)
    expect(second.updated_at).toEqual(first.updated_at)
  })

  it('applies a privacy change immediately, not at the next heartbeat', async () => {
    await befriend(alice, bob)
    await db.as(bob, `select public.report_presence('twitch', 'lirik')`)
    await db.as(bob, `select public.set_presence_visibility('invisible')`)

    const [row] = await db.as<{ status: string; channel: string | null }>(
      alice,
      'select status, channel from public.presence where user_id = $1',
      [bob.id],
    )
    expect(row).toMatchObject({ status: 'offline', channel: null })
  })

  it("keeps a user's own privacy setting private", async () => {
    await befriend(alice, bob)
    await db.as(bob, `select public.set_presence_visibility('invisible')`)

    const rows = await db.as(alice, 'select * from public.user_preferences where user_id = $1', [
      bob.id,
    ])
    expect(rows).toHaveLength(0)
  })

  it('rejects malformed activity', async () => {
    expect(
      await refusal(() => db.as(alice, `select public.report_presence('twitch', 'not a channel!')`)),
    ).toMatch(/invalid channel/i)

    expect(
      await refusal(() => db.as(alice, `select public.report_presence('youtube', 'someone')`)),
    ).toMatch(/unsupported platform/i)

    expect(
      await refusal(() => db.as(alice, `select public.set_presence_visibility('ghost')`)),
    ).toMatch(/invalid presence visibility/i)
  })

  it('normalises channel casing so HERE comparisons are reliable', async () => {
    await befriend(alice, bob)
    await db.as(bob, `select public.report_presence('twitch', 'LIRIK')`)
    const [row] = await db.as<{ channel: string }>(
      alice,
      'select channel from public.presence where user_id = $1',
      [bob.id],
    )
    expect(row.channel).toBe('lirik')
  })
})

// --------------------------------------------------------- friend requests

describe('friend requests', () => {
  it('refuses self-friending', async () => {
    expect(
      await refusal(() => db.as(alice, 'select public.send_friend_request($1)', [alice.id])),
    ).toMatch(/cannot add yourself/i)
  })

  it('refuses a request to a user that does not exist', async () => {
    expect(
      await refusal(() =>
        db.as(alice, 'select public.send_friend_request($1)', [
          '00000000-0000-4000-8000-999999999999',
        ]),
      ),
    ).toMatch(/user not found/i)
  })

  it('collapses a duplicate request instead of creating a second one', async () => {
    const [first] = await db.as<{ send_friend_request: string }>(
      alice,
      'select public.send_friend_request($1)',
      [bob.id],
    )
    const [second] = await db.as<{ send_friend_request: string }>(
      alice,
      'select public.send_friend_request($1)',
      [bob.id],
    )

    expect(first.send_friend_request).toBe('requested')
    expect(second.send_friend_request).toBe('already_requested')

    const [{ count }] = await db.root<{ count: number }>(
      `select count(*)::int as count from public.friend_requests where status = 'pending'`,
    )
    expect(count).toBe(1)
  })

  it('auto-accepts a reciprocal request into a single friendship', async () => {
    await db.as(alice, 'select public.send_friend_request($1)', [bob.id])
    const [result] = await db.as<{ send_friend_request: string }>(
      bob,
      'select public.send_friend_request($1)',
      [alice.id],
    )
    expect(result.send_friend_request).toBe('friends')

    const [{ pending }] = await db.root<{ pending: number }>(
      `select count(*)::int as pending from public.friend_requests where status = 'pending'`,
    )
    const [{ accepted }] = await db.root<{ accepted: number }>(
      `select count(*)::int as accepted from public.friend_requests where status = 'accepted'`,
    )
    const [{ rows }] = await db.root<{ rows: number }>(
      'select count(*)::int as rows from public.friendships',
    )

    expect(pending).toBe(0)
    expect(accepted).toBe(1)
    expect(rows).toBe(2) // exactly the mirrored pair, no duplicates
  })

  it('lets the recipient accept, creating the mirrored pair atomically', async () => {
    await db.as(alice, 'select public.send_friend_request($1)', [bob.id])
    const [request] = await db.as<{ request_id: string }>(
      bob,
      `select request_id from public.list_friend_requests() where direction = 'incoming'`,
    )
    const [result] = await db.as<{ respond_to_friend_request: string }>(
      bob,
      'select public.respond_to_friend_request($1, true)',
      [request.request_id],
    )
    expect(result.respond_to_friend_request).toBe('accepted')

    const pairs = await db.root<{ user_id: string; friend_id: string }>(
      'select user_id, friend_id from public.friendships order by user_id',
    )
    expect(pairs).toHaveLength(2)
    expect(new Set(pairs.map((p) => `${p.user_id}->${p.friend_id}`))).toEqual(
      new Set([`${alice.id}->${bob.id}`, `${bob.id}->${alice.id}`]),
    )
  })

  it("refuses to let a third party accept someone else's request", async () => {
    await db.as(alice, 'select public.send_friend_request($1)', [bob.id])
    const [request] = await db.root<{ id: string }>('select id from public.friend_requests')

    const message = await refusal(() =>
      db.as(mallory, 'select public.respond_to_friend_request($1, true)', [request.id]),
    )
    expect(message).toMatch(/not found/i)

    const [{ rows }] = await db.root<{ rows: number }>(
      'select count(*)::int as rows from public.friendships',
    )
    expect(rows).toBe(0)
  })

  it('refuses to let the sender accept their own request', async () => {
    await db.as(alice, 'select public.send_friend_request($1)', [bob.id])
    const [request] = await db.root<{ id: string }>('select id from public.friend_requests')

    expect(
      await refusal(() =>
        db.as(alice, 'select public.respond_to_friend_request($1, true)', [request.id]),
      ),
    ).toMatch(/not found/i)
  })

  it('supports declining, and does not create a friendship', async () => {
    await db.as(alice, 'select public.send_friend_request($1)', [bob.id])
    const [request] = await db.as<{ request_id: string }>(
      bob,
      `select request_id from public.list_friend_requests() where direction = 'incoming'`,
    )
    const [result] = await db.as<{ respond_to_friend_request: string }>(
      bob,
      'select public.respond_to_friend_request($1, false)',
      [request.request_id],
    )

    expect(result.respond_to_friend_request).toBe('declined')
    const [{ rows }] = await db.root<{ rows: number }>(
      'select count(*)::int as rows from public.friendships',
    )
    expect(rows).toBe(0)
  })

  it('refuses to resolve the same request twice', async () => {
    await db.as(alice, 'select public.send_friend_request($1)', [bob.id])
    const [request] = await db.as<{ request_id: string }>(
      bob,
      `select request_id from public.list_friend_requests() where direction = 'incoming'`,
    )
    await db.as(bob, 'select public.respond_to_friend_request($1, true)', [request.request_id])

    expect(
      await refusal(() =>
        db.as(bob, 'select public.respond_to_friend_request($1, false)', [request.request_id]),
      ),
    ).toMatch(/already resolved/i)
  })

  it('lets only the sender cancel a request', async () => {
    await db.as(alice, 'select public.send_friend_request($1)', [bob.id])
    const [request] = await db.root<{ id: string }>('select id from public.friend_requests')

    expect(
      await refusal(() => db.as(bob, 'select public.cancel_friend_request($1)', [request.id])),
    ).toMatch(/not found/i)

    const [result] = await db.as<{ cancel_friend_request: string }>(
      alice,
      'select public.cancel_friend_request($1)',
      [request.id],
    )
    expect(result.cancel_friend_request).toBe('cancelled')
  })

  it('cannot produce a duplicate friendship', async () => {
    await befriend(alice, bob)
    const [again] = await db.as<{ send_friend_request: string }>(
      alice,
      'select public.send_friend_request($1)',
      [bob.id],
    )
    const [reverse] = await db.as<{ send_friend_request: string }>(
      bob,
      'select public.send_friend_request($1)',
      [alice.id],
    )

    expect(again.send_friend_request).toBe('already_friends')
    expect(reverse.send_friend_request).toBe('already_friends')

    const [{ rows }] = await db.root<{ rows: number }>(
      'select count(*)::int as rows from public.friendships',
    )
    expect(rows).toBe(2)
  })

  it('lets a pending request counterpart see each other, but not strangers', async () => {
    await db.as(alice, 'select public.send_friend_request($1)', [bob.id])

    const visible = await db.as(bob, 'select display_name from public.users where id = $1', [alice.id])
    expect(visible).toHaveLength(1)

    const hidden = await db.as(mallory, 'select display_name from public.users where id = $1', [
      alice.id,
    ])
    expect(hidden).toHaveLength(0)
  })
})

// ------------------------------------------------------------ friend removal

describe('friend removal', () => {
  it('removes both directions and revokes presence visibility', async () => {
    await befriend(alice, bob)
    await db.as(bob, `select public.report_presence('twitch', 'lirik')`)

    const [removed] = await db.as<{ remove_friend: boolean }>(
      alice,
      'select public.remove_friend($1)',
      [bob.id],
    )
    expect(removed.remove_friend).toBe(true)

    const [{ rows }] = await db.root<{ rows: number }>(
      'select count(*)::int as rows from public.friendships',
    )
    expect(rows).toBe(0)

    // Neither side can see the other any more.
    expect(await db.as(alice, 'select * from public.presence where user_id = $1', [bob.id])).toHaveLength(0)
    expect(await db.as(bob, 'select * from public.presence where user_id = $1', [alice.id])).toHaveLength(0)
    expect(await db.as(bob, 'select * from public.list_friends()')).toHaveLength(0)
  })

  it('allows re-adding after removal', async () => {
    await befriend(alice, bob)
    await db.as(alice, 'select public.remove_friend($1)', [bob.id])

    const [result] = await db.as<{ send_friend_request: string }>(
      alice,
      'select public.send_friend_request($1)',
      [bob.id],
    )
    expect(result.send_friend_request).toBe('requested')
  })

  it('reports false when there was no friendship to remove', async () => {
    const [result] = await db.as<{ remove_friend: boolean }>(
      alice,
      'select public.remove_friend($1)',
      [mallory.id],
    )
    expect(result.remove_friend).toBe(false)
  })
})

// ------------------------------------------------------------------ search

describe('user search', () => {
  it('finds Kickback users by Twitch login prefix', async () => {
    const rows = await db.as<{ twitch_login: string; relationship: string; matched_by: string }>(
      alice,
      'select * from public.search_users($1)',
      ['bob'],
    )
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      twitch_login: 'bob_tv',
      relationship: 'none',
      matched_by: 'twitch_login',
    })
  })

  it('reports the relationship so the UI can show the right action', async () => {
    await db.as(alice, 'select public.send_friend_request($1)', [bob.id])

    const [fromAlice] = await db.as<{ relationship: string }>(
      alice,
      'select * from public.search_users($1)',
      ['bob_tv'],
    )
    const [fromBob] = await db.as<{ relationship: string }>(
      bob,
      'select * from public.search_users($1)',
      ['alice'],
    )
    const [self] = await db.as<{ relationship: string }>(
      alice,
      'select * from public.search_users($1)',
      ['alice_tv'],
    )

    expect(fromAlice.relationship).toBe('request_sent')
    expect(fromBob.relationship).toBe('request_received')
    expect(self.relationship).toBe('self')
  })

  it('finds a user by exact friend code', async () => {
    const [bobProfile] = await db.as<{ friend_code: string }>(bob, 'select * from public.me()')
    const rows = await db.as<{ user_id: string; matched_by: string }>(
      alice,
      'select * from public.search_users($1)',
      [bobProfile.friend_code],
    )
    expect(rows).toHaveLength(1)
    expect(rows[0].user_id).toBe(bob.id)
    expect(rows[0].matched_by).toBe('friend_code')
  })

  it("never returns another user's friend code", async () => {
    const columns = await db.root<{ column_name: string }>(
      `select unnest(string_to_array(pg_get_function_result(p.oid), ',')) as column_name
       from pg_proc p join pg_namespace n on n.oid = p.pronamespace
       where n.nspname = 'public' and p.proname = 'search_users'`,
    )
    expect(columns.map((c) => c.column_name).join(' ')).not.toMatch(/friend_code/)
  })

  it('does not treat an underscore in the query as a wildcard', async () => {
    await db.createUser({ login: 'axbcd', displayName: 'Decoy' })
    const rows = await db.as(alice, 'select * from public.search_users($1)', ['a_b'])
    expect(rows).toHaveLength(0)
  })

  it('returns nothing for a Twitch name that has never joined Kickback', async () => {
    const rows = await db.as(alice, 'select * from public.search_users($1)', ['shroud'])
    expect(rows).toHaveLength(0)
  })

  it('ignores queries that are too short to be meaningful', async () => {
    expect(await db.as(alice, 'select * from public.search_users($1)', ['a'])).toHaveLength(0)
  })
})

// ------------------------------------------------------------------- reads

describe('friend list projection', () => {
  it('returns a friend with their current activity', async () => {
    await befriend(alice, bob)
    await db.as(bob, `select public.report_presence('twitch', 'lirik')`)

    const rows = await db.as<{
      user_id: string
      display_name: string
      twitch_login: string
      status: string
      channel: string
    }>(alice, 'select * from public.list_friends()')

    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      user_id: bob.id,
      display_name: 'Bob',
      twitch_login: 'bob_tv',
      status: 'online',
      channel: 'lirik',
    })
  })

  it('reports a friend who has never reported presence as offline', async () => {
    await befriend(alice, bob)
    const [row] = await db.as<{ status: string; channel: string | null }>(
      alice,
      'select * from public.list_friends()',
    )
    expect(row).toMatchObject({ status: 'offline', channel: null })
  })

  it('shows incoming and outgoing requests to the right people only', async () => {
    await db.as(alice, 'select public.send_friend_request($1)', [bob.id])

    const [outgoing] = await db.as<{ direction: string; display_name: string }>(
      alice,
      'select * from public.list_friend_requests()',
    )
    const [incoming] = await db.as<{ direction: string; display_name: string }>(
      bob,
      'select * from public.list_friend_requests()',
    )
    const none = await db.as(mallory, 'select * from public.list_friend_requests()')

    expect(outgoing).toMatchObject({ direction: 'outgoing', display_name: 'Bob' })
    expect(incoming).toMatchObject({ direction: 'incoming', display_name: 'Alice' })
    expect(none).toHaveLength(0)
  })
})

// ------------------------------------------------------ presence rate guard

describe('presence write rate guard', () => {
  it('allows a realistic amount of navigating and heartbeating', async () => {
    // A busy session: a channel change plus a heartbeat every few seconds.
    for (let i = 0; i < 60; i++) {
      await db.as(alice, `select public.report_presence('twitch', $1)`, [`chan${i}`])
    }
    const [row] = await db.as<{ channel: string }>(
      alice,
      'select channel from public.presence where user_id = $1',
      [alice.id],
    )
    expect(row.channel).toBe('chan59')
  })

  it('refuses a client hammering report_presence', async () => {
    let refusal = ''
    for (let i = 0; i < 200; i++) {
      try {
        await db.as(alice, `select public.report_presence('twitch', 'lirik')`)
      } catch (error) {
        refusal = (error as Error).message
        break
      }
    }
    expect(refusal).toMatch(/rate limit/i)
  })

  it('counts heartbeats against the same budget', async () => {
    let refusal = ''
    for (let i = 0; i < 200; i++) {
      try {
        await db.as(alice, `select public.heartbeat()`)
      } catch (error) {
        refusal = (error as Error).message
        break
      }
    }
    expect(refusal).toMatch(/rate limit/i)
  })

  it('lets a different user through while one is throttled', async () => {
    for (let i = 0; i < 200; i++) {
      try {
        await db.as(alice, `select public.report_presence('twitch', 'lirik')`)
      } catch {
        break
      }
    }
    // Bob is unaffected: the budget is per user.
    await db.as(bob, `select public.report_presence('twitch', 'shroud')`)
    const [row] = await db.as<{ channel: string }>(
      bob,
      'select channel from public.presence where user_id = $1',
      [bob.id],
    )
    expect(row.channel).toBe('shroud')
  })

  it('recovers once the window rolls over', async () => {
    for (let i = 0; i < 200; i++) {
      try {
        await db.as(alice, `select public.report_presence('twitch', 'lirik')`)
      } catch {
        break
      }
    }
    // Pretend a minute passed rather than waiting for one.
    await db.root(
      `update public.presence_rate set window_started_at = now() - interval '2 minutes'
       where user_id = $1`,
      [alice.id],
    )

    await db.as(alice, `select public.report_presence('twitch', 'shroud')`)
    const [row] = await db.as<{ channel: string }>(
      alice,
      'select channel from public.presence where user_id = $1',
      [alice.id],
    )
    expect(row.channel).toBe('shroud')
  })

  it('keeps the counter table unreadable, so it cannot leak activity', async () => {
    // If a friend could read this, an invisible user's counter ticking upward
    // would tell them the user is active - the exact side channel the
    // invisible mode exists to prevent.
    await befriend(alice, bob)
    await db.as(alice, `select public.report_presence('twitch', 'lirik')`)

    expect(await refusal(() => db.as(bob, 'select * from public.presence_rate'))).toMatch(
      /permission denied/i,
    )
    // Not even the owner can read their own counter.
    expect(await refusal(() => db.as(alice, 'select * from public.presence_rate'))).toMatch(
      /permission denied/i,
    )
  })

  it('does not let a client call the budget function directly', async () => {
    expect(await refusal(() => db.as(alice, 'select public.consume_presence_budget()'))).toMatch(
      /permission denied/i,
    )
  })

  it('still hides an invisible user despite the counter advancing', async () => {
    await befriend(alice, bob)
    await db.as(bob, `select public.set_presence_visibility('invisible')`)
    await db.as(bob, `select public.report_presence('twitch', 'lirik')`)

    const [first] = await db.as<{ last_seen_at: string }>(
      alice,
      'select last_seen_at from public.presence where user_id = $1',
      [bob.id],
    )
    for (let i = 0; i < 5; i++) {
      await db.as(bob, `select public.report_presence('twitch', 'shroud')`)
    }
    const [second] = await db.as<{ last_seen_at: string; status: string }>(
      alice,
      'select last_seen_at, status from public.presence where user_id = $1',
      [bob.id],
    )

    expect(second.status).toBe('offline')
    expect(second.last_seen_at).toEqual(first.last_seen_at)
  })
})
