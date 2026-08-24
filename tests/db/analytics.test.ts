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

describe('the socially-attributed destination lifecycle', () => {
  const S = '11111111-1111-4111-8111-111111111111'
  const A = '22222222-2222-4222-8222-222222222222'
  const t0 = Date.now() - 2 * 60 * 60 * 1000
  const iso = (ms: number) => new Date(ms).toISOString()

  /**
   * The exact case two-account testing turned up: co-viewing ends ten minutes
   * in, is not noticed for forty, and the user stays on the destination the
   * whole time. The client sends the EFFECTIVE end as occurred_at and the lag
   * as a property, so the database has to accept a timestamp well in the past.
   */
  async function recordLifecycle(user: TestUser) {
    return track(user, [
      {
        event_name: 'join_clicked',
        environment: 'private_beta',
        session_id: S,
        attribution_id: A,
        occurred_at: iso(t0),
        source: 'friend_row',
        destination_channel: 'summit1g',
        properties: {
          social_count: 1,
          already_on_twitch: true,
          already_on_destination: false,
          navigated: true,
        },
      },
      {
        event_name: 'join_arrived',
        environment: 'private_beta',
        session_id: S,
        attribution_id: A,
        occurred_at: iso(t0 + 4_000),
        source: 'friend_row',
        destination_channel: 'summit1g',
        properties: { elapsed_ms: 4_000 },
      },
      {
        event_name: 'watching_together_started',
        environment: 'private_beta',
        session_id: S,
        attribution_id: A,
        occurred_at: iso(t0 + 5_000),
        destination_channel: 'summit1g',
        properties: { other_count: 1, from_join: true },
      },
      {
        event_name: 'watching_together_ended',
        environment: 'private_beta',
        session_id: S,
        attribution_id: A,
        // Ten minutes after it started - not when it was noticed.
        occurred_at: iso(t0 + 5_000 + 600_000),
        destination_channel: 'summit1g',
        properties: {
          other_count_peak: 1,
          duration_ms: 600_000,
          end_reason: 'alone_again',
          detection_delay_ms: 2_400_000,
        },
      },
      {
        event_name: 'post_social_retention_ended',
        environment: 'private_beta',
        session_id: S,
        attribution_id: A,
        occurred_at: iso(t0 + 5_000 + 600_000 + 2_400_000),
        destination_channel: 'summit1g',
        properties: { duration_ms: 2_400_000, from_join: true, end_reason: 'left_channel' },
      },
    ])
  }

  it('accepts the whole lifecycle, including a late-dated end', async () => {
    expect(await recordLifecycle(nina)).toBe(5)
  })

  it('reads back as one funnel row, joined on the attribution', async () => {
    await recordLifecycle(nina)

    const [row] = await db.root<Record<string, unknown>>(
      `select source, destination_channel, social_count, arrival_elapsed_ms,
              together_duration::text        as together_duration,
              together_detection_delay::text as detection_delay,
              together_end_reason,
              post_social_retained,
              post_social_duration::text     as post_social_duration,
              destination_left_at is not null as has_left
         from public.analytics_join_funnel_v`,
    )

    expect(row).toMatchObject({
      source: 'friend_row',
      destination_channel: 'summit1g',
      social_count: 1,
      arrival_elapsed_ms: 4000,
      // Ten minutes together; forty minutes late finding out; forty staying on.
      together_duration: '00:10:00',
      detection_delay: '00:40:00',
      together_end_reason: 'alone_again',
      post_social_retained: true,
      post_social_duration: '00:40:00',
      has_left: true,
    })
  })

  it('separates when co-viewing ended from when we noticed', async () => {
    await recordLifecycle(nina)
    const [row] = await db.root<{ ended: string; detected: string; ok: boolean }>(
      `select effective_ended_at::text as ended,
              detected_at::text        as detected,
              detected_at > effective_ended_at as ok
         from public.analytics_together_v`,
    )
    expect(row.ok).toBe(true)
    expect(row.ended).not.toBe(row.detected)
  })

  it('reports no retention when the user left first', async () => {
    await track(nina, [
      {
        event_name: 'watching_together_started',
        environment: 'private_beta',
        session_id: S,
        occurred_at: iso(t0),
        destination_channel: 'lirik',
        properties: { other_count: 2, from_join: false },
      },
      {
        event_name: 'watching_together_ended',
        environment: 'private_beta',
        session_id: S,
        occurred_at: iso(t0 + 300_000),
        destination_channel: 'lirik',
        properties: {
          other_count_peak: 2,
          duration_ms: 300_000,
          end_reason: 'left_channel',
          detection_delay_ms: 0,
        },
      },
    ])

    const [row] = await db.root<{ retained: boolean; gone: string | null }>(
      `select post_social_retained as retained, destination_left_at::text as gone
         from public.analytics_together_v`,
    )
    expect(row.retained).toBe(false)
    expect(row.gone).toBeNull()
  })

  it('records organic co-viewing with no JOIN credit', async () => {
    await track(nina, [
      {
        event_name: 'watching_together_started',
        environment: 'private_beta',
        session_id: S,
        occurred_at: iso(t0),
        destination_channel: 'lirik',
        properties: { other_count: 1, from_join: false },
      },
      {
        event_name: 'post_social_retention_ended',
        environment: 'private_beta',
        session_id: S,
        occurred_at: iso(t0 + 600_000),
        destination_channel: 'lirik',
        properties: { duration_ms: 600_000, from_join: false, end_reason: 'left_channel' },
      },
    ])

    // The interval is a fact and is stored; the funnel is about JOINs and
    // must not claim it.
    const [row] = await db.root<{ from_join: boolean; attribution: string | null }>(
      `select (properties ->> 'from_join')::boolean as from_join, attribution_id as attribution
         from public.analytics_events where event_name = 'post_social_retention_ended'`,
    )
    expect(row.from_join).toBe(false)
    expect(row.attribution).toBeNull()
    expect(await db.root('select * from public.analytics_join_funnel_v')).toHaveLength(0)
  })
})

describe('the reserved cluster identity', () => {
  it('round-trips on a join, so Social Gravity needs no contract change', async () => {
    // Nothing emits this yet. Proving the path works now is what stops the
    // next checkpoint discovering that it does not.
    await track(nina, [
      {
        event_name: 'join_clicked',
        environment: 'private_beta',
        occurred_at: NOW(),
        source: 'social_gravity',
        destination_channel: 'xqc',
        attribution_id: '33333333-3333-4333-8333-333333333333',
        properties: { social_count: 3, navigated: true, opportunity_key: 'gravity:xqc:7' },
      },
    ])

    const [row] = await db.root<{ key: string; count: number }>(
      `select opportunity_key as key, social_count as count from public.analytics_join_funnel_v`,
    )
    // The cluster is identified as a cluster, and by its size - never by one
    // arbitrarily chosen member of it.
    expect(row.key).toBe('gravity:xqc:7')
    expect(row.count).toBe(3)
  })

  it('is still stripped from an event that does not declare it', async () => {
    await track(nina, [
      event({ event_name: 'group_created', properties: { opportunity_key: 'nope' } }),
    ])
    const [row] = await db.root<{ properties: Record<string, unknown> }>(
      `select properties from public.analytics_events where event_name = 'group_created'`,
    )
    expect(row.properties).toEqual({})
  })
})

describe('how far the client clock is trusted', () => {
  it('accepts an event dated well in the past, because late detection is real', async () => {
    // A shared watch that ended when the friends left is emitted when the user
    // finally moves, which can be hours. Refusing those would throw away the
    // measurement this all exists for.
    const sixHoursAgo = new Date(Date.now() - 6 * 60 * 60 * 1000).toISOString()
    await track(nina, [event({ occurred_at: sixHoursAgo })])

    const [row] = await db.root<{ kept: boolean }>(
      `select occurred_at < now() - interval '5 hours' as kept from public.analytics_events`,
    )
    expect(row.kept).toBe(true)
  })

  it('refuses an event dated in the future', async () => {
    // Nothing that has already happened happens later than now, so the only
    // thing a future timestamp can be is a wrong clock or a hostile one.
    const tomorrow = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString()
    await track(nina, [event({ occurred_at: tomorrow })])

    const [row] = await db.root<{ clamped: boolean }>(
      `select occurred_at <= now() + interval '1 minute' as clamped from public.analytics_events`,
    )
    expect(row.clamped).toBe(true)
  })

  it('tolerates a clock that is only a little fast', async () => {
    const soon = new Date(Date.now() + 60 * 1000).toISOString()
    await track(nina, [event({ occurred_at: soon })])

    const [row] = await db.root<{ kept: boolean }>(
      `select occurred_at > now() + interval '30 seconds' as kept from public.analytics_events`,
    )
    expect(row.kept).toBe(true)
  })

  it('always records when it actually arrived, whatever the client said', async () => {
    await track(nina, [event({ occurred_at: new Date(Date.now() - 60 * 60 * 1000).toISOString() })])
    const [row] = await db.root<{ recent: boolean }>(
      `select received_at > now() - interval '1 minute' as recent from public.analytics_events`,
    )
    expect(row.recent).toBe(true)
  })
})

describe('an interval closed because the worker was evicted', () => {
  it('stores its reason without any contract change', async () => {
    /*
     * "observation_lost" is a property VALUE, not a key.
     *
     * The contract constrains which keys an event may carry, never what they
     * may say - so adding a reason needs no migration at all. Asserted rather
     * than assumed, because "no migration required" is exactly the kind of
     * claim that is comfortable to believe and cheap to check.
     */
    await track(nina, [
      event({
        event_name: 'watching_together_ended',
        destination_channel: 'summit1g',
        properties: {
          other_count_peak: 2,
          duration_ms: 600_000,
          end_reason: 'observation_lost',
          detection_delay_ms: 3 * 60 * 60 * 1000,
        },
      }),
      event({
        event_name: 'post_social_retention_ended',
        destination_channel: 'summit1g',
        properties: { duration_ms: 0, from_join: true, end_reason: 'observation_lost' },
      }),
    ])

    const rows = await db.root<{ reason: string }>(
      `select properties ->> 'end_reason' as reason
         from public.analytics_events
        where event_name in ('watching_together_ended', 'post_social_retention_ended')
        order by event_name`,
    )
    expect(rows.map((row) => row.reason)).toEqual(['observation_lost', 'observation_lost'])
  })

  it('is visible in the reporting views as what it is', async () => {
    const t0 = Date.now() - 60 * 60 * 1000
    const iso = (ms: number) => new Date(ms).toISOString()
    const session = '44444444-4444-4444-8444-444444444444'

    await track(nina, [
      {
        event_name: 'watching_together_started',
        environment: 'private_beta',
        session_id: session,
        occurred_at: iso(t0),
        destination_channel: 'summit1g',
        properties: { other_count: 2, from_join: false },
      },
      {
        event_name: 'watching_together_ended',
        environment: 'private_beta',
        session_id: session,
        // Dated to the last moment we could vouch for, ten minutes in - not to
        // the three-hours-later moment we noticed.
        occurred_at: iso(t0 + 600_000),
        destination_channel: 'summit1g',
        properties: {
          other_count_peak: 2,
          duration_ms: 600_000,
          end_reason: 'observation_lost',
          detection_delay_ms: 3 * 60 * 60 * 1000,
        },
      },
    ])

    const [row] = await db.root<{
      reason: string
      duration: string
      delay: string
      retained: boolean
    }>(
      `select end_reason as reason, duration::text as duration,
              detection_delay::text as delay, post_social_retained as retained
         from public.analytics_together_v`,
    )

    expect(row.reason).toBe('observation_lost')
    // Ten minutes of measured co-viewing, three hours of not knowing.
    expect(row.duration).toBe('00:10:00')
    expect(row.delay).toBe('03:00:00')
    expect(row.retained).toBe(false)
  })
})
