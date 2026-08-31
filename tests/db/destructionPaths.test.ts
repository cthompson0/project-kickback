import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { createTestDb } from './harness'
import type { TestDb, TestUser } from './harness'

/**
 * The fire exits, tested while the building is empty.
 *
 * Watchside is going to hold a Twitch refresh credential. This suite proves the
 * ways of getting rid of one work BEFORE any exists, which is the whole point of
 * phase 1: a credential with no proven deletion path is a liability from its
 * first row, whereas an empty deletion path is merely untested until fixtures
 * are pointed at it.
 *
 * THE DISTINCTION THIS SUITE EXISTS TO DEFEND
 *
 * Twitch deauthorization and Watchside account deletion are NOT the same event,
 * and the difference is asymmetric in a way that is easy to get backwards:
 *
 *   deauth   → destroy the Twitch credential and Twitch-derived observations,
 *              and KEEP Watchside's own analytics
 *   deletion → destroy everything the user owns, analytics included
 *
 * Revoking a Twitch grant says nothing about wanting Watchside's own record of
 * Watchside destroyed. A purge that took the analytics too would silently
 * corrupt the experiment for a reason unrelated to what the user asked for.
 *
 * Every fixture credential here is synthetic bytes. No real Twitch token is
 * used, and no production code can write one (see the no-custody proof).
 */

let db: TestDb
let alice: TestUser
let bob: TestUser

/** Synthetic ciphertext-shaped bytes. Deliberately not a real token. */
const FAKE_SECRET = "'\\x0102030405060708090a0b0c0d0e0f10'::bytea"

async function giveCredential(user: TestUser): Promise<void> {
  await db.root(
    `insert into public.twitch_credentials (actor_id, secret, key_version, scopes)
     values ($1, ${FAKE_SECRET}, 1, array['user:read:follows'])`,
    [user.id],
  )
}

async function giveObservation(user: TestUser, login = 'lirik'): Promise<void> {
  await db.root(
    `insert into public.creator_relationship_observations
       (actor_id, broadcaster_login, relationship_present)
     values ($1, $2, true)`,
    [user.id, login],
  )
}

async function giveAnalytics(user: TestUser): Promise<void> {
  await db.root(
    `insert into public.analytics_actors (user_id) values ($1)
       on conflict (user_id) do nothing`,
    [user.id],
  )
  await db.root(
    `insert into public.analytics_events (actor_id, environment, event_name, occurred_at)
     values ($1, 'production', 'extension_session_started', now())`,
    [user.id],
  )
}

async function counts(user: TestUser): Promise<{
  credentials: number
  observations: number
  events: number
}> {
  const [row] = await db.root<{ c: string; o: string; e: string }>(
    `select
       (select count(*) from public.twitch_credentials where actor_id = $1) as c,
       (select count(*) from public.creator_relationship_observations where actor_id = $1) as o,
       (select count(*) from public.analytics_events where actor_id = $1) as e`,
    [user.id],
  )
  return { credentials: Number(row.c), observations: Number(row.o), events: Number(row.e) }
}

/** Run something the database must refuse, and return its complaint. */
async function refusal(run: () => Promise<unknown>): Promise<string> {
  try {
    await run()
  } catch (error) {
    return (error as Error).message
  }
  throw new Error('expected the database to refuse this, but it succeeded')
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
})

// ------------------------------------------------------------------ posture

describe('the credential table is invisible to clients', () => {
  /*
   * The harness deliberately reproduces Supabase's default of granting
   * anon/authenticated full DML on anything new in `public`. So these tests
   * fail unless the migration actively claws it back - which is the point.
   */
  for (const [name, sql] of [
    ['SELECT', 'select * from public.twitch_credentials'],
    ['INSERT', `insert into public.twitch_credentials (actor_id, secret, key_version)
                values (gen_random_uuid(), ${FAKE_SECRET}, 1)`],
    ['UPDATE', `update public.twitch_credentials set key_version = 99`],
    ['DELETE', 'delete from public.twitch_credentials'],
  ] as const) {
    it(`refuses ${name} from an authenticated client`, async () => {
      expect(await refusal(() => db.as(alice, sql))).toMatch(/permission denied/i)
    })

    it(`refuses ${name} from an anonymous client`, async () => {
      expect(await refusal(() => db.anon(sql))).toMatch(/permission denied/i)
    })
  }

  it('does not leak rows even when one exists', async () => {
    await giveCredential(alice)
    expect(await refusal(() => db.as(alice, 'select * from public.twitch_credentials'))).toMatch(
      /permission denied/i,
    )
  })
})

describe('relationship observations are server-only too', () => {
  it('cannot be browsed by their own subject', async () => {
    await giveObservation(alice)
    expect(
      await refusal(() => db.as(alice, 'select * from public.creator_relationship_observations')),
    ).toMatch(/permission denied/i)
  })

  it('cannot be written by a client', async () => {
    expect(
      await refusal(() =>
        db.as(
          alice,
          `insert into public.creator_relationship_observations (actor_id, broadcaster_login)
           values ($1, 'lirik')`,
          [alice.id],
        ),
      ),
    ).toMatch(/permission denied/i)
  })

  it('records a failed check as absent rather than false', async () => {
    await db.root(
      `insert into public.creator_relationship_observations (actor_id, broadcaster_login)
       values ($1, 'lirik')`,
      [alice.id],
    )
    const [row] = await db.root<{ relationship_present: boolean | null }>(
      'select relationship_present from public.creator_relationship_observations where actor_id = $1',
      [alice.id],
    )
    // Nullable is the mechanism that stops an API timeout becoming "did not follow".
    expect(row.relationship_present).toBeNull()
  })
})

describe('the deletion primitives are not client-callable', () => {
  it('refuses purge_twitch_derived from a client', async () => {
    expect(
      await refusal(() => db.as(alice, 'select public.purge_twitch_derived($1)', [bob.id])),
    ).toMatch(/permission denied/i)
  })

  it('refuses actor_for_twitch_user from a client', async () => {
    expect(
      await refusal(() => db.as(alice, `select public.actor_for_twitch_user('1337')`)),
    ).toMatch(/permission denied/i)
  })
})

// --------------------------------------------------------------- deauth path

describe('a Twitch deauthorization purge', () => {
  beforeEach(async () => {
    for (const user of [alice, bob]) {
      await giveCredential(user)
      await giveObservation(user)
      await giveAnalytics(user)
    }
  })

  it("destroys the actor's credential and observations", async () => {
    await db.root('select public.purge_twitch_derived($1)', [alice.id])
    const after = await counts(alice)
    expect(after.credentials).toBe(0)
    expect(after.observations).toBe(0)
  })

  /*
   * The asymmetry that matters. Revoking Twitch's grant is not a request to
   * erase Watchside's own observations of its own product.
   */
  it("PRESERVES the actor's Watchside analytics", async () => {
    await db.root('select public.purge_twitch_derived($1)', [alice.id])
    expect((await counts(alice)).events).toBe(1)
  })

  it('leaves the other actor completely untouched', async () => {
    await db.root('select public.purge_twitch_derived($1)', [alice.id])
    expect(await counts(bob)).toEqual({ credentials: 1, observations: 1, events: 1 })
  })

  it('is idempotent - a duplicate delivery deletes nothing further', async () => {
    const first = await db.root<{ purge_twitch_derived: Record<string, unknown> }>(
      'select public.purge_twitch_derived($1)',
      [alice.id],
    )
    const second = await db.root<{ purge_twitch_derived: Record<string, unknown> }>(
      'select public.purge_twitch_derived($1)',
      [alice.id],
    )
    expect(first[0].purge_twitch_derived).toMatchObject({ credentials: 1, observations: 1 })
    expect(second[0].purge_twitch_derived).toMatchObject({ credentials: 0, observations: 0 })
    expect(await counts(bob)).toEqual({ credentials: 1, observations: 1, events: 1 })
  })

  it('is harmless for an actor who never had anything', async () => {
    const clean = await db.createUser({ login: 'clean_tv' })
    const [row] = await db.root<{ purge_twitch_derived: Record<string, unknown> }>(
      'select public.purge_twitch_derived($1)',
      [clean.id],
    )
    expect(row.purge_twitch_derived).toMatchObject({ credentials: 0, observations: 0 })
  })

  /** An unresolved Twitch id must not become "delete something else". */
  it('does nothing at all for a null actor', async () => {
    const [row] = await db.root<{ purge_twitch_derived: Record<string, unknown> }>(
      'select public.purge_twitch_derived(null)',
    )
    expect(row.purge_twitch_derived).toMatchObject({ credentials: 0, observations: 0, actor: false })
    expect(await counts(alice)).toEqual({ credentials: 1, observations: 1, events: 1 })
    expect(await counts(bob)).toEqual({ credentials: 1, observations: 1, events: 1 })
  })
})

// ------------------------------------------------------------ identity mapping

describe('resolving a Twitch identity', () => {
  it('maps event.user_id through connected_accounts to the actor', async () => {
    const [row] = await db.root<{ platform_user_id: string }>(
      `select platform_user_id from public.connected_accounts
        where user_id = $1 and platform = 'twitch'`,
      [alice.id],
    )
    const [resolved] = await db.root<{ actor_for_twitch_user: string | null }>(
      'select public.actor_for_twitch_user($1)',
      [row.platform_user_id],
    )
    expect(resolved.actor_for_twitch_user).toBe(alice.id)
  })

  it('returns nothing for a Twitch id Watchside does not know', async () => {
    const [row] = await db.root<{ actor_for_twitch_user: string | null }>(
      `select public.actor_for_twitch_user('999999999')`,
    )
    expect(row.actor_for_twitch_user).toBeNull()
  })

  /*
   * user_login and user_name are null in the revoke payload when the Twitch
   * account no longer exists - one of the very situations that produces a
   * revocation. Resolution must not depend on them in any way.
   */
  it('does not depend on login or display name', async () => {
    await db.root(
      `update public.connected_accounts
          set platform_login = 'renamed_tv', platform_display_name = null
        where user_id = $1`,
      [alice.id],
    )
    const [row] = await db.root<{ platform_user_id: string }>(
      `select platform_user_id from public.connected_accounts where user_id = $1`,
      [alice.id],
    )
    const [resolved] = await db.root<{ actor_for_twitch_user: string | null }>(
      'select public.actor_for_twitch_user($1)',
      [row.platform_user_id],
    )
    expect(resolved.actor_for_twitch_user).toBe(alice.id)
  })

  it('maps at most one actor per Twitch identity', async () => {
    const [row] = await db.root<{ count: string }>(
      `select count(*) as count from pg_indexes
        where tablename = 'connected_accounts'
          and indexdef ilike '%platform%platform_user_id%'
          and indexdef ilike '%unique%'`,
    )
    expect(Number(row.count)).toBeGreaterThan(0)
  })
})

// ------------------------------------------------------------ account deletion

describe('account deletion destroys the whole contract', () => {
  beforeEach(async () => {
    for (const user of [alice, bob]) {
      await giveCredential(user)
      await giveObservation(user)
      await giveAnalytics(user)
    }
  })

  it('removes the credential, the observations AND the analytics', async () => {
    await db.root('select public.purge_twitch_derived($1)', [alice.id])
    await db.root('delete from public.users where id = $1', [alice.id])
    expect(await counts(alice)).toEqual({ credentials: 0, observations: 0, events: 0 })
  })

  it('removes the public user row', async () => {
    await db.root('delete from public.users where id = $1', [alice.id])
    const rows = await db.root('select 1 from public.users where id = $1', [alice.id])
    expect(rows).toHaveLength(0)
  })

  /*
   * The contract generated from the schema rather than hand-listed.
   *
   * A hand-written list silently stops covering table 22 the day somebody adds
   * one. This asks the catalogue which tables carry a users foreign key and
   * asserts every one of them is empty for the deleted actor, so a new
   * user-owned table joins the contract automatically.
   */
  it('leaves no row behind in ANY table that references a user', async () => {
    await db.root('select public.purge_twitch_derived($1)', [alice.id])
    await db.root('delete from public.users where id = $1', [alice.id])

    const columns = await db.root<{ table_name: string; column_name: string }>(
      `select c.relname as table_name, a.attname as column_name
         from pg_constraint k
         join pg_class c   on c.oid = k.conrelid
         join pg_class f   on f.oid = k.confrelid
         join pg_attribute a on a.attrelid = c.oid and a.attnum = any(k.conkey)
        where k.contype = 'f'
          and f.relname = 'users'
          and c.relnamespace = 'public'::regnamespace`,
    )
    expect(columns.length).toBeGreaterThan(20)

    const survivors: string[] = []
    for (const { table_name, column_name } of columns) {
      const [row] = await db.root<{ count: string }>(
        `select count(*) as count from public.${table_name} where ${column_name} = $1`,
        [alice.id],
      )
      if (Number(row.count) > 0) survivors.push(`${table_name}.${column_name}`)
    }
    expect(survivors).toEqual([])
  })

  it('leaves the other user entirely intact', async () => {
    await db.root('select public.purge_twitch_derived($1)', [alice.id])
    await db.root('delete from public.users where id = $1', [alice.id])
    expect(await counts(bob)).toEqual({ credentials: 1, observations: 1, events: 1 })
  })

  it('cascades from the auth user, which is the real deletion root', async () => {
    await db.root('delete from auth.users where id = $1', [alice.id])
    const rows = await db.root('select 1 from public.users where id = $1', [alice.id])
    expect(rows).toHaveLength(0)
    expect(await counts(alice)).toEqual({ credentials: 0, observations: 0, events: 0 })
  })

  it('cannot be performed by a client against another user', async () => {
    expect(await refusal(() => db.as(alice, 'delete from public.users where id = $1', [bob.id])))
      .toMatch(/permission denied|violates row-level security/i)
    const rows = await db.root('select 1 from public.users where id = $1', [bob.id])
    expect(rows).toHaveLength(1)
  })
})

// ------------------------------------------------------------------ dedupe

describe('the EventSub replay guard', () => {
  it('is server-only', async () => {
    expect(await refusal(() => db.as(alice, 'select * from public.eventsub_messages'))).toMatch(
      /permission denied/i,
    )
  })

  it('rejects a second insert of the same message id', async () => {
    await db.root(`insert into public.eventsub_messages (message_id) values ('msg-1')`)
    expect(
      await refusal(() =>
        db.root(`insert into public.eventsub_messages (message_id) values ('msg-1')`),
      ),
    ).toMatch(/duplicate key/i)
  })

  it('sweeps only what is older than the window', async () => {
    await db.root(
      `insert into public.eventsub_messages (message_id, received_at)
       values ('old', now() - interval '20 days'), ('new', now())`,
    )
    const [row] = await db.root<{ sweep_eventsub_messages: number }>(
      `select public.sweep_eventsub_messages(interval '10 days')`,
    )
    expect(row.sweep_eventsub_messages).toBe(1)
    const remaining = await db.root<{ message_id: string }>(
      'select message_id from public.eventsub_messages',
    )
    expect(remaining.map((r) => r.message_id)).toEqual(['new'])
  })
})
