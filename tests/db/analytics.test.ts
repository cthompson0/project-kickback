import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { createTestDb } from './harness'
import type { TestDb, TestUser } from './harness'

/**
 * Analytics, enforced by the database rather than by the extension.
 *
 * Everything here runs as a real `authenticated` role with a JWT subject
 * claim, exactly as PostgREST does, because every rule this file checks is one
 * a modified client would otherwise be able to walk straight through:
 *
 *   - it cannot record events as somebody else;
 *   - it cannot read anybody's events, including its own;
 *   - it cannot invent an event name or an environment;
 *   - it cannot smuggle a message body in as a property;
 *   - it cannot flood the table;
 *   - and it cannot reach the reset function at all.
 */

let db: TestDb
let nina: TestUser
let matt: TestUser

const NOW = () => new Date().toISOString()

async function refusal(run: () => Promise<unknown>): Promise<string> {
  try {
    await run()
  } catch (error) {
    return (error as Error).message
  }
  throw new Error('expected the database to refuse this, but it succeeded')
}

/** Sends a batch the way the extension does, and reports how many were kept. */
async function track(user: TestUser, events: unknown[]): Promise<number> {
  const rows = await db.as<{ analytics_track: number }>(
    user,
    'select public.analytics_track($1::jsonb)',
    [JSON.stringify(events)],
  )
  return rows[0].analytics_track
}

const event = (overrides: Record<string, unknown> = {}) => ({
  event_name: 'extension_session_started',
  environment: 'private_beta',
  occurred_at: NOW(),
  session_id: '11111111-1111-4111-8111-111111111111',
  app_version: '0.5.0',
  properties: {},
  ...overrides,
})

beforeAll(async () => {
  db = await createTestDb()
}, 60_000)

afterAll(async () => {
  await db.close()
})

beforeEach(async () => {
  await db.reset()
  await db.root('delete from public.analytics_events')
  await db.root('delete from public.analytics_actors')
  await db.root('delete from public.rate_limits')
  nina = await db.createUser({ login: 'nina', displayName: 'Nina' })
  matt = await db.createUser({ login: 'matt', displayName: 'Matt' })
})

describe('the actor comes from the session, never from the client', () => {
  it('records events against the caller', async () => {
    expect(await track(nina, [event()])).toBe(1)

    const rows = await db.root<{ actor_id: string }>('select actor_id from public.analytics_events')
    expect(rows).toHaveLength(1)
    expect(rows[0].actor_id).toBe(nina.id)
  })

  it('ignores an actor the client tries to supply', async () => {
    // The whole point: a modified extension claiming to be somebody else.
    await track(nina, [event({ actor_id: matt.id, user_id: matt.id })])

    const rows = await db.root<{ actor_id: string }>('select actor_id from public.analytics_events')
    expect(rows[0].actor_id).toBe(nina.id)
    expect(rows[0].actor_id).not.toBe(matt.id)
  })

  it('refuses an unauthenticated caller entirely', async () => {
    const message = await refusal(() =>
      db.anon('select public.analytics_track($1::jsonb)', [JSON.stringify([event()])]),
    )
    expect(message).toMatch(/not authenticated|permission denied/i)
  })
})

describe('nobody reads analytics through the API', () => {
  it('refuses a direct read of the events table', async () => {
    await track(nina, [event()])
    // Not even her own. An event log is a record of when and where somebody
    // was, which is precisely the side channel presence privacy closes.
    expect(await refusal(() => db.as(nina, 'select * from public.analytics_events'))).toMatch(
      /permission denied/i,
    )
  })

  it('refuses reads of the actors, contract and environment tables', async () => {
    for (const table of [
      'analytics_actors',
      'analytics_event_names',
      'analytics_environments',
    ]) {
      expect(await refusal(() => db.as(nina, `select * from public.${table}`))).toMatch(
        /permission denied/i,
      )
    }
  })

  it('refuses reads of the reporting views', async () => {
    for (const view of [
      'analytics_reportable_events_v',
      'analytics_production_events_v',
      'analytics_sessions_v',
      'analytics_together_v',
      'analytics_join_funnel_v',
      'analytics_actor_days_v',
    ]) {
      expect(await refusal(() => db.as(nina, `select * from public.${view}`))).toMatch(
        /permission denied/i,
      )
    }
  })

  it('refuses writes that go around the RPC', async () => {
    expect(
      await refusal(() =>
        db.as(nina, `insert into public.analytics_events (actor_id, environment, event_name, occurred_at)
                     values ($1, 'production', 'group_created', now())`, [matt.id]),
      ),
    ).toMatch(/permission denied/i)
  })
})

describe('invalid events are dropped, not stored and not fatal', () => {
  it('drops an event name that is not registered', async () => {
    expect(await track(nina, [event({ event_name: 'exfiltrate_everything' })])).toBe(0)
  })

  it('drops an environment that is not registered', async () => {
    expect(await track(nina, [event({ environment: 'production_lol' })])).toBe(0)
  })

  it('keeps the good events in a batch that also contains bad ones', async () => {
    // A batch is best-effort: one bad event must not lose the others.
    const kept = await track(nina, [
      event(),
      event({ event_name: 'nonsense' }),
      event({ event_name: 'group_created' }),
      event({ environment: 'nope' }),
    ])
    expect(kept).toBe(2)
  })

  it('is not something a client can crash', async () => {
    expect(await track(nina, [])).toBe(0)
    const rows = await db.as<{ analytics_track: number }>(
      nina,
      `select public.analytics_track('"not an array"'::jsonb)`,
    )
    expect(rows[0].analytics_track).toBe(0)
  })
})

describe('the property contract is enforced server-side', () => {
  it('strips a key the event does not declare', async () => {
    await track(nina, [
      event({
        event_name: 'group_message_sent',
        properties: {
          length_bucket: 'short',
          has_emote: false,
          body: 'hey are you watching this',
          token: 'ya29.a0secret',
        },
      }),
    ])

    const [row] = await db.root<{ properties: Record<string, unknown> }>(
      'select properties from public.analytics_events',
    )
    expect(row.properties).toEqual({ length_bucket: 'short', has_emote: false })
  })

  it('strips a long string even under a declared key', async () => {
    await track(nina, [
      event({ event_name: 'friend_request_sent', properties: { outcome: 'x'.repeat(65) } }),
    ])
    const [row] = await db.root<{ properties: Record<string, unknown> }>(
      'select properties from public.analytics_events',
    )
    expect(row.properties).toEqual({})
  })

  it('strips nested objects and arrays', async () => {
    await track(nina, [
      event({ event_name: 'combo_formed', properties: { count: { sneaky: 'payload' } } }),
    ])
    const [row] = await db.root<{ properties: Record<string, unknown> }>(
      'select properties from public.analytics_events',
    )
    expect(row.properties).toEqual({})
  })
})

describe('destination channels', () => {
  it('normalises a login', async () => {
    await track(nina, [event({ event_name: 'join_arrived', destination_channel: 'LIRIK' })])
    const [row] = await db.root<{ destination_channel: string }>(
      'select destination_channel from public.analytics_events',
    )
    expect(row.destination_channel).toBe('lirik')
  })

  it('refuses anything that is not one, rather than storing it', async () => {
    // A URL is exactly what must never end up in this column.
    await track(nina, [
      event({ event_name: 'join_arrived', destination_channel: 'https://twitch.tv/lirik/videos' }),
    ])
    const [row] = await db.root<{ destination_channel: string | null }>(
      'select destination_channel from public.analytics_events',
    )
    expect(row.destination_channel).toBeNull()
  })
})

describe('client clocks are not trusted', () => {
  it('replaces a wildly wrong timestamp with the server clock', async () => {
    await track(nina, [event({ occurred_at: '2077-01-01T00:00:00Z' })])
    const [row] = await db.root<{ ok: boolean }>(
      `select occurred_at < now() + interval '1 minute' as ok from public.analytics_events`,
    )
    expect(row.ok).toBe(true)
  })

  it('keeps received_at as the truth regardless', async () => {
    await track(nina, [event({ occurred_at: 'not a timestamp' })])
    const [row] = await db.root<{ received: string }>(
      'select received_at::text as received from public.analytics_events',
    )
    expect(row.received).toBeTruthy()
  })
})

describe('the rate guard', () => {
  it('lets ordinary use through', async () => {
    // Far more than a heavy real session produces in five minutes.
    for (let batch = 0; batch < 4; batch += 1) {
      expect(await track(nina, Array.from({ length: 25 }, () => event()))).toBe(25)
    }
  })

  it('counts events rather than calls, so batching cannot cheat it', async () => {
    // 13 x 50 = 650, past the 600 budget.
    let kept = 0
    for (let batch = 0; batch < 13; batch += 1) {
      kept += await track(nina, Array.from({ length: 50 }, () => event()))
    }
    expect(kept).toBeLessThanOrEqual(600)
  })

  it('caps a single batch, so one call cannot be a bulk import', async () => {
    expect(await track(nina, Array.from({ length: 300 }, () => event()))).toBe(50)
  })

  it('is per person, not global', async () => {
    for (let batch = 0; batch < 13; batch += 1) {
      await track(nina, Array.from({ length: 50 }, () => event()))
    }
    // Nina flooding must not stop Matt being measured.
    expect(await track(matt, [event()])).toBe(1)
  })
})

describe('actors', () => {
  it('records a first sighting and the environments seen', async () => {
    await track(nina, [event({ environment: 'private_beta' })])
    await track(nina, [event({ environment: 'production' })])

    const [row] = await db.root<{ environments: string[]; is_internal: boolean }>(
      'select environments, is_internal from public.analytics_actors',
    )
    expect([...row.environments].sort()).toEqual(['private_beta', 'production'])
    // Internal is set by hand in SQL; a client cannot un-mark itself.
    expect(row.is_internal).toBe(false)
  })

  it('excludes internal accounts from the reporting views', async () => {
    await track(nina, [event({ environment: 'production' })])
    await track(matt, [event({ environment: 'production' })])
    await db.root('update public.analytics_actors set is_internal = true where user_id = $1', [
      nina.id,
    ])

    const rows = await db.root<{ actor_id: string }>(
      'select actor_id from public.analytics_production_events_v',
    )
    expect(rows.map((row) => row.actor_id)).toEqual([matt.id])
  })

  it('keeps beta events out of the production view', async () => {
    await track(nina, [event({ environment: 'private_beta' })])
    expect(await db.root('select * from public.analytics_production_events_v')).toHaveLength(0)
    expect(await db.root('select * from public.analytics_reportable_events_v')).toHaveLength(1)
  })
})

describe('resetting an environment before public launch', () => {
  beforeEach(async () => {
    await track(nina, [event({ environment: 'private_beta' })])
    await track(matt, [event({ environment: 'production' })])
  })

  it('is unreachable from a client', async () => {
    expect(
      await refusal(() =>
        db.as(nina, `select * from public.analytics_reset_environment('private_beta', 'RESET private_beta')`),
      ),
    ).toMatch(/permission denied/i)
  })

  it('is not executable by a client at all', async () => {
    /*
     * Asserted as a privilege rather than only as an outcome.
     *
     * The function is not SECURITY DEFINER, so a client that reached it would
     * be refused by the delete anyway - which means the refusal above passes
     * whether or not the revoke is there. This is the test that actually holds
     * the revoke in place.
     */
    const [row] = await db.root<{ has: boolean }>(
      `select has_function_privilege(
                'authenticated',
                'public.analytics_reset_environment(text, text)',
                'execute') as has`,
    )
    expect(row.has).toBe(false)
  })

  it('refuses without the confirmation phrase', async () => {
    expect(
      await refusal(() =>
        db.root(`select * from public.analytics_reset_environment('private_beta', 'yes')`),
      ),
    ).toMatch(/confirmation phrase/i)
  })

  it('refuses an environment that does not exist', async () => {
    expect(
      await refusal(() =>
        db.root(`select * from public.analytics_reset_environment('staging', 'RESET staging')`),
      ),
    ).toMatch(/unknown analytics environment/i)
  })

  it('needs a second, louder phrase for production', async () => {
    expect(
      await refusal(() =>
        db.root(`select * from public.analytics_reset_environment('production', 'RESET production')`),
      ),
    ).toMatch(/I AM SURE/)
  })

  it('clears only the environment it was asked to clear', async () => {
    const [result] = await db.root<{ deleted_events: string }>(
      `select * from public.analytics_reset_environment('private_beta', 'RESET private_beta')`,
    )
    expect(Number(result.deleted_events)).toBe(1)

    const remaining = await db.root<{ environment: string }>(
      'select environment from public.analytics_events',
    )
    expect(remaining.map((row) => row.environment)).toEqual(['production'])
  })

  it('touches no product data at all', async () => {
    await db.as(nina, 'select public.send_friend_request($1)', [matt.id])
    const before = await db.root('select * from public.friend_requests')
    await db.as(nina, 'select public.report_presence($1, $2)', ['twitch', 'lirik'])

    await db.root(`select * from public.analytics_reset_environment('private_beta', 'RESET private_beta')`)

    expect(await db.root('select * from public.friend_requests')).toHaveLength(before.length)
    expect(await db.root('select * from public.users')).toHaveLength(2)
  })
})

describe('analytics is a separate island from product data', () => {
  it('has no foreign key pointing into it from any product table', async () => {
    const rows = await db.root<{ name: string }>(
      `select c.conname as name
         from pg_constraint c
         join pg_class referenced on referenced.oid = c.confrelid
         join pg_class referencing on referencing.oid = c.conrelid
        where c.contype = 'f'
          and referenced.relname like 'analytics%'
          -- Analytics referring to its own lookup tables is the contract, not
          -- coupling. What must not exist is product data depending on it.
          and referencing.relname not like 'analytics%'`,
    )
    expect(rows).toEqual([])
  })

  it('is reachable only through the one RPC', async () => {
    const rows = await db.root<{ has: boolean }>(
      `select has_table_privilege('authenticated', 'public.analytics_events', 'select') as has`,
    )
    expect(rows[0].has).toBe(false)
  })
})
