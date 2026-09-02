import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { createTestDb } from './harness'
import type { TestDb, TestUser } from './harness'

/**
 * Acquisition attribution, against real PostgreSQL as a real `authenticated`
 * role.
 *
 * WHAT IS ACTUALLY AT RISK HERE
 *
 * Not the happy path. Four things, each of which fails silently and each of
 * which would make every future campaign number wrong in a way nobody could
 * detect from the outside:
 *
 *   * FIRST TOUCH MUST BE IMMUTABLE. "How did this user originally come to
 *     Watchside" is the one question the whole milestone exists to answer, and
 *     an overwrite is invisible - the row still looks perfectly well-formed.
 *   * CAMPAIGN METADATA MUST BE AUTHORITATIVE. A client offers a code. If it
 *     could offer a source, anybody could write themselves an official-looking
 *     acquisition.
 *   * FRIEND REFERRAL MUST BE UNTOUCHED. It is durable, in production, and a
 *     different question. The two must coexist without either overwriting the
 *     other.
 *   * DELETION MUST REACH IT. A user-level acquisition record that survives
 *     account deletion is exactly the kind of thing that gets discovered by
 *     somebody else.
 *
 * Both directions are proved throughout: valid input SUCCEEDS as well as
 * invalid input refusing. A gate that only ever refuses is a gate that might be
 * refusing everything.
 */

let db: TestDb
let alice: TestUser
let bob: TestUser
let carol: TestUser

const bind = (user: TestUser, code: string) =>
  db.as<{ bind_acquisition: string }>(user, 'select public.bind_acquisition($1)', [code])

const outcomeOf = async (user: TestUser, code: string): Promise<string> =>
  (await bind(user, code))[0].bind_acquisition

const attributionOf = (user: TestUser) =>
  db.root<{
    first_campaign_code: string
    last_campaign_code: string
    touch_count: number
    first_touch_at: string
    last_touch_at: string
  }>('select * from public.acquisition_attribution where actor_id = $1', [user.id])

async function seedCampaigns(): Promise<void> {
  await db.root(
    `insert into public.acquisition_campaigns (code, source, creator_key, label, active) values
       ('tiktok-launch', 'tiktok',  null,    'TikTok launch',       true),
       ('lirik-oct',     'creator', 'lirik', 'LIRIK October',       true),
       ('x-thread',      'x',       null,    'X launch thread',     true),
       ('retired-one',   'other',   null,    'A campaign we closed', false)`,
  )
}

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
  carol = await db.createUser({ login: 'carol', displayName: 'Carol' })
  await seedCampaigns()
})

// ---------------------------------------------------------------- resolution

describe('a campaign code resolves against the registry, or does not resolve', () => {
  it('binds a real, active campaign', async () => {
    expect(await outcomeOf(alice, 'tiktok-launch')).toBe('first')

    const [row] = await attributionOf(alice)
    expect(row.first_campaign_code).toBe('tiktok-launch')
    expect(row.last_campaign_code).toBe('tiktok-launch')
    expect(row.touch_count).toBe(1)
  })

  it('refuses a campaign that does not exist, and writes nothing at all', async () => {
    expect(await outcomeOf(alice, 'no-such-campaign')).toBe('unknown')
    // Not a row with a null campaign, not a row recording the offered string.
    // Storing unresolvable input is how arbitrary client text ends up in a
    // table later read as authoritative.
    expect(await attributionOf(alice)).toHaveLength(0)
  })

  it('refuses an inactive campaign without destroying its history', async () => {
    expect(await outcomeOf(alice, 'retired-one')).toBe('inactive')
    expect(await attributionOf(alice)).toHaveLength(0)

    // The definition survives, which is the entire difference between
    // disabling a bad link and deleting the past.
    const [campaign] = await db.root<{ code: string }>(
      `select code from public.acquisition_campaigns where code = 'retired-one'`,
    )
    expect(campaign.code).toBe('retired-one')
  })

  it('keeps attribution that was made before a campaign was deactivated', async () => {
    expect(await outcomeOf(alice, 'tiktok-launch')).toBe('first')
    await db.root(
      `update public.acquisition_campaigns set active = false where code = 'tiktok-launch'`,
    )

    const [row] = await attributionOf(alice)
    expect(row.first_campaign_code).toBe('tiktok-launch')
    // And a NEW actor can no longer bind to it.
    expect(await outcomeOf(bob, 'tiktok-launch')).toBe('inactive')
  })

  it.each([
    ['empty', ''],
    ['whitespace', '   '],
    ['uppercase-only rubbish', 'NOT A CODE'],
    ['a path traversal', '../../etc/passwd'],
    ['an absolute URL', 'https://evil.example.com'],
    ['SQL-shaped', "'; drop table public.users; --"],
    ['too long', 'a'.repeat(64)],
    ['a leading hyphen', '-leading'],
    ['a trailing hyphen', 'trailing-'],
  ])('refuses %s', async (_label, code) => {
    expect(await outcomeOf(alice, code)).toBe('unknown')
    expect(await attributionOf(alice)).toHaveLength(0)
  })

  it('accepts a code however it was capitalised on the way in', async () => {
    // Codes get retyped off a stream overlay. Refusing case would be pedantry.
    expect(await outcomeOf(alice, '  LIRIK-OCT  ')).toBe('first')
    const [row] = await attributionOf(alice)
    expect(row.first_campaign_code).toBe('lirik-oct')
  })
})

// -------------------------------------------------------- first / last touch

describe('first touch is the origin and never moves', () => {
  it('keeps the first campaign when a different one is bound later', async () => {
    expect(await outcomeOf(alice, 'lirik-oct')).toBe('first')
    expect(await outcomeOf(alice, 'tiktok-launch')).toBe('repeat')

    const [row] = await attributionOf(alice)
    expect(row.first_campaign_code).toBe('lirik-oct')
    expect(row.last_campaign_code).toBe('tiktok-launch')
    expect(row.touch_count).toBe(2)
  })

  it('counts a repeat of the SAME campaign without duplicating anything', async () => {
    await bind(alice, 'tiktok-launch')
    expect(await outcomeOf(alice, 'tiktok-launch')).toBe('repeat')

    const rows = await attributionOf(alice)
    expect(rows).toHaveLength(1)
    expect(rows[0].touch_count).toBe(2)
    expect(rows[0].first_campaign_code).toBe('tiktok-launch')
  })

  it('moves last_touch_at forward while first_touch_at stays put', async () => {
    await bind(alice, 'lirik-oct')
    const [before] = await attributionOf(alice)
    await db.root(`select pg_sleep(0.01)`)
    await bind(alice, 'x-thread')
    const [after] = await attributionOf(alice)

    expect(new Date(after.first_touch_at as unknown as string).getTime()).toBe(
      new Date(before.first_touch_at as unknown as string).getTime(),
    )
    expect(new Date(after.last_touch_at as unknown as string).getTime()).toBeGreaterThanOrEqual(
      new Date(before.last_touch_at as unknown as string).getTime(),
    )
  })

  it('refuses an UPDATE that would rewrite the origin, even from the owner', async () => {
    await bind(alice, 'lirik-oct')
    /*
     * The trigger is the real protection. A forgotten WHERE clause or a future
     * "refresh the attribution" helper would otherwise rewrite where every user
     * it touched came from, and the rows would still look perfectly valid.
     */
    await expect(
      db.root(
        `update public.acquisition_attribution set first_campaign_code = 'tiktok-launch'
          where actor_id = $1`,
        [alice.id],
      ),
    ).rejects.toThrow(/immutable/i)
  })
})

// -------------------------------------------------------- authority of source

describe('campaign metadata is the server’s, not the caller’s', () => {
  it('takes only a code - there is no parameter for a source', async () => {
    /*
     * The strongest possible form of "the client cannot assert this": not a
     * validated parameter, but no parameter at all.
     */
    const [fn] = await db.root<{ args: string }>(
      `select pg_get_function_identity_arguments(p.oid) as args
         from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'public' and p.proname = 'bind_acquisition'`,
    )
    expect(fn.args).toBe('p_code text')
  })

  it('resolves source from the registry, so a caller cannot choose one', async () => {
    await bind(alice, 'lirik-oct')
    const [row] = await db.root<{ first_source: string; first_creator_key: string }>(
      'select first_source, first_creator_key from public.acquisition_actor_v where actor_id = $1',
      [alice.id],
    )
    expect(row.first_source).toBe('creator')
    expect(row.first_creator_key).toBe('lirik')
  })

  it('will not let a campaign’s source change under its history', async () => {
    // The event stream carries `source` so funnels need no join. That is only
    // safe while a code's source cannot be edited afterwards.
    await expect(
      db.root(`update public.acquisition_campaigns set source = 'press' where code = 'lirik-oct'`),
    ).rejects.toThrow(/immutable/i)
    await expect(
      db.root(
        `update public.acquisition_campaigns set creator_key = 'someone-else' where code = 'lirik-oct'`,
      ),
    ).rejects.toThrow(/immutable/i)
  })

  it('DOES let the human label change, because links must survive a rename', async () => {
    await db.root(
      `update public.acquisition_campaigns set label = 'LIRIK October (renamed)' where code = 'lirik-oct'`,
    )
    // The identity is the code, so every link already in a stream panel, a
    // YouTube description or a screenshot still resolves.
    expect(await outcomeOf(alice, 'lirik-oct')).toBe('first')
  })

  it('hides the registry from clients entirely', async () => {
    await expect(
      db.as(alice, 'select * from public.acquisition_campaigns'),
    ).rejects.toThrow()
  })

  it('lets a person read their own attribution and nobody else’s', async () => {
    await bind(alice, 'tiktok-launch')
    await bind(bob, 'lirik-oct')

    const own = await db.as<{ first_campaign_code: string }>(
      alice,
      'select * from public.my_acquisition()',
    )
    expect(own).toHaveLength(1)
    expect(own[0].first_campaign_code).toBe('tiktok-launch')

    const others = await db.as(
      alice,
      'select * from public.acquisition_attribution where actor_id = $1',
      [bob.id],
    )
    expect(others).toHaveLength(0)
  })
})

// ----------------------------------------------------- friend-referral seams

describe('acquisition and friend referral are independent', () => {
  async function referBobToAlice(): Promise<void> {
    const [{ my_invite_code: code }] = await db.as<{ my_invite_code: string }>(
      alice,
      'select public.my_invite_code()',
    )
    const [{ claim_invite: outcome }] = await db.as<{ claim_invite: string }>(
      bob,
      'select public.claim_invite($1)',
      [code],
    )
    expect(outcome).toBe('attributed')
  }

  it('lets an acquired user also be referred, with both facts intact', async () => {
    await bind(bob, 'tiktok-launch')
    await referBobToAlice()

    const [acq] = await attributionOf(bob)
    expect(acq.first_campaign_code).toBe('tiktok-launch')

    const [ref] = await db.root<{ inviter_id: string }>(
      'select inviter_id from public.referrals where invitee_id = $1',
      [bob.id],
    )
    expect(ref.inviter_id).toBe(alice.id)
  })

  it('does not let a referral overwrite acquisition, in either order', async () => {
    await referBobToAlice()
    expect(await outcomeOf(bob, 'x-thread')).toBe('first')

    const [acq] = await attributionOf(bob)
    expect(acq.first_campaign_code).toBe('x-thread')
    const [ref] = await db.root<{ inviter_id: string }>(
      'select inviter_id from public.referrals where invitee_id = $1',
      [bob.id],
    )
    expect(ref.inviter_id).toBe(alice.id)
  })

  it('leaves a referred user with NO acquisition when none was offered', async () => {
    await referBobToAlice()
    // Bob is not "from" Alice's campaign. He is downstream of her, which is a
    // join, not a value copied into his row.
    expect(await attributionOf(bob)).toHaveLength(0)
  })

  it('keeps self-referral refused exactly as before', async () => {
    await bind(alice, 'lirik-oct')
    const [{ my_invite_code: code }] = await db.as<{ my_invite_code: string }>(
      alice,
      'select public.my_invite_code()',
    )
    const [{ claim_invite: outcome }] = await db.as<{ claim_invite: string }>(
      alice,
      'select public.claim_invite($1)',
      [code],
    )
    expect(outcome).toBe('self')
  })
})

// -------------------------------------------------------- downstream lineage

describe('downstream lineage is reconstructable without being copied', () => {
  it('links a campaign to the people its acquired user brought', async () => {
    await bind(alice, 'lirik-oct')
    const [{ my_invite_code: code }] = await db.as<{ my_invite_code: string }>(
      alice,
      'select public.my_invite_code()',
    )
    await db.as(bob, 'select public.claim_invite($1)', [code])

    const rows = await db.root<{
      campaign_code: string
      invitee_id: string
      invitee_own_campaign_code: string | null
    }>('select * from public.acquisition_downstream_v where inviter_id = $1', [alice.id])

    expect(rows).toHaveLength(1)
    expect(rows[0].campaign_code).toBe('lirik-oct')
    expect(rows[0].invitee_id).toBe(bob.id)
    // Bob's OWN acquisition is null and must stay null.
    expect(rows[0].invitee_own_campaign_code).toBeNull()
  })

  it('does not attribute the invitee to the inviter’s campaign', async () => {
    await bind(alice, 'lirik-oct')
    const [{ my_invite_code: code }] = await db.as<{ my_invite_code: string }>(
      alice,
      'select public.my_invite_code()',
    )
    await db.as(bob, 'select public.claim_invite($1)', [code])

    const rows = await db.root(
      `select * from public.acquisition_actor_v where actor_id = $1 and first_campaign_code = 'lirik-oct'`,
      [bob.id],
    )
    expect(rows).toHaveLength(0)
  })
})

// ------------------------------------------------------------------ deletion

describe('deletion', () => {
  it('removes the user’s acquisition with their account', async () => {
    await bind(alice, 'tiktok-launch')
    expect(await attributionOf(alice)).toHaveLength(1)

    await db.root('delete from public.users where id = $1', [alice.id])
    expect(await attributionOf(alice)).toHaveLength(0)
  })

  it('keeps the campaign definition, which is not user data', async () => {
    await bind(alice, 'tiktok-launch')
    await db.root('delete from public.users where id = $1', [alice.id])

    const rows = await db.root(
      `select code from public.acquisition_campaigns where code = 'tiktok-launch'`,
    )
    expect(rows).toHaveLength(1)
  })

  it('removes their acquisition events too, as analytics deletion already promised', async () => {
    await bind(alice, 'tiktok-launch')
    const before = await db.root(
      `select id from public.analytics_events where actor_id = $1 and event_name = 'acquisition_attributed'`,
      [alice.id],
    )
    expect(before.length).toBeGreaterThan(0)

    await db.root('delete from public.users where id = $1', [alice.id])
    const after = await db.root(
      `select id from public.analytics_events where actor_id = $1`,
      [alice.id],
    )
    expect(after).toHaveLength(0)
  })
})

// ------------------------------------------------------------- the event

describe('the analytics event is emitted by the server, once per bind', () => {
  const eventsFor = (user: TestUser) =>
    db.root<{ properties: { source?: string; touch?: string } }>(
      `select properties from public.analytics_events
        where actor_id = $1 and event_name = 'acquisition_attributed'
        order by occurred_at`,
      [user.id],
    )

  it('records the first touch with its resolved source', async () => {
    await bind(alice, 'lirik-oct')
    const rows = await eventsFor(alice)
    expect(rows).toHaveLength(1)
    expect(rows[0].properties.source).toBe('creator')
    expect(rows[0].properties.touch).toBe('first')
  })

  it('distinguishes a repeat from the arrival that defined the account', async () => {
    await bind(alice, 'lirik-oct')
    await bind(alice, 'tiktok-launch')
    const rows = await eventsFor(alice)
    expect(rows.map((r) => r.properties.touch)).toEqual(['first', 'repeat'])
    expect(rows.map((r) => r.properties.source)).toEqual(['creator', 'tiktok'])
  })

  it('emits nothing for an unknown or inactive campaign', async () => {
    await bind(alice, 'no-such-campaign')
    await bind(alice, 'retired-one')
    expect(await eventsFor(alice)).toHaveLength(0)
  })

  it('never carries the campaign code, which lives on the durable row', async () => {
    await bind(alice, 'lirik-oct')
    const rows = await eventsFor(alice)
    expect(JSON.stringify(rows[0].properties)).not.toContain('lirik-oct')
  })
})

// --------------------------------------------------------- reportable metrics

describe('reportable metrics', () => {
  async function makeInternal(user: TestUser): Promise<void> {
    await db.root(
      `insert into public.analytics_actors (user_id, is_internal) values ($1, true)
         on conflict (user_id) do update set is_internal = true`,
      [user.id],
    )
  }

  it('counts an ordinary acquired actor', async () => {
    await bind(alice, 'tiktok-launch')
    const [row] = await db.root<{ acquired_actors: number; rates_reportable: boolean }>(
      `select * from public.acquisition_campaign_v where campaign_code = 'tiktok-launch'`,
    )
    expect(row.acquired_actors).toBe(1)
  })

  it('excludes internal actors, who click their own links constantly', async () => {
    await makeInternal(alice)
    await bind(alice, 'tiktok-launch')
    await bind(bob, 'tiktok-launch')

    const [row] = await db.root<{ acquired_actors: number }>(
      `select * from public.acquisition_campaign_v where campaign_code = 'tiktok-launch'`,
    )
    expect(row.acquired_actors).toBe(1)
  })

  it('does not let internal actors satisfy the small-cohort threshold', async () => {
    await makeInternal(alice)
    await makeInternal(bob)
    await bind(alice, 'tiktok-launch')
    await bind(bob, 'tiktok-launch')
    await bind(carol, 'tiktok-launch')

    const [row] = await db.root<{ acquired_actors: number; rates_reportable: boolean }>(
      `select * from public.acquisition_campaign_v where campaign_code = 'tiktok-launch'`,
    )
    expect(row.acquired_actors).toBe(1)
    expect(row.rates_reportable).toBe(false)
  })

  it('suppresses rates below the threshold, as NULL rather than zero', async () => {
    await bind(alice, 'tiktok-launch')
    await bind(bob, 'tiktok-launch')

    const [row] = await db.root<{
      acquired_actors: number
      connected_share: number | null
      rates_reportable: boolean
    }>(`select * from public.acquisition_campaign_v where campaign_code = 'tiktok-launch'`)

    expect(row.acquired_actors).toBe(2)
    expect(row.rates_reportable).toBe(false)
    // NULL, not 0: an absent rate must never read as a bad one.
    expect(row.connected_share).toBeNull()
  })

  it('reports rates once the cohort is big enough', async () => {
    for (const user of [alice, bob, carol]) await bind(user, 'tiktok-launch')

    const [row] = await db.root<{
      acquired_actors: number
      connected_share: string | null
      rates_reportable: boolean
    }>(`select * from public.acquisition_campaign_v where campaign_code = 'tiktok-launch'`)

    expect(row.acquired_actors).toBe(3)
    expect(row.rates_reportable).toBe(true)
    expect(row.connected_share).not.toBeNull()
  })

  it('shows a campaign nobody has bound as absent rather than as zeroes', async () => {
    const rows = await db.root(
      `select * from public.acquisition_campaign_v where campaign_code = 'x-thread'`,
    )
    // No fabricated cohort. A campaign with no data has no row.
    expect(rows).toHaveLength(0)
  })
})
