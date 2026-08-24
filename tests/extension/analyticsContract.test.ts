import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import {
  ANALYTICS_ENVIRONMENTS,
  ANALYTICS_EVENT_NAMES,
  EVENT_PROPERTIES,
  MAX_PROPERTIES,
  MAX_PROPERTY_VALUE_LENGTH,
  cleanProperties,
  buildEvent,
  normalizeChannel,
} from '../../src/core/analytics'

/**
 * The event contract is written down twice, and this is why that is safe.
 *
 * src/core/analytics.ts is what the extension sends. The migration is what the
 * database accepts, and it has to be independent - a modified extension can
 * send anything, so the server cannot trust the client's idea of the rules.
 *
 * Two copies of a contract is normally how a contract rots. These tests read
 * the SQL and assert the two agree, name for name and property for property,
 * so adding an event on one side and forgetting the other is a failing test
 * rather than an event that silently arrives with its properties stripped.
 */

const MIGRATION = readFileSync('supabase/migrations/0013_analytics.sql', 'utf8')

/**
 * Every migration that seeds the contract, in the order the bundle applies
 * them.
 *
 * The order is load-bearing rather than incidental. 0013 still lists the shape
 * watching_together_ended had before the effective-end fix, and resets it on
 * every bundle run; 0015 runs afterwards and upserts the current one. Reading
 * only the first file would test a contract the database never ends up with.
 */
const CONTRACT_MIGRATIONS = [
  'supabase/migrations/0013_analytics.sql',
  'supabase/migrations/0015_social_discovery.sql',
]

/** Pulls the seeded (name, allowed_properties) pairs out of the inserts. */
function contractFromSql(): Map<string, string[]> {
  const contract = new Map<string, string[]>()

  for (const file of CONTRACT_MIGRATIONS) {
    // Each row is ('name', 'description', array[...]) or array[]::text[].
    const rows = readFileSync(file, 'utf8').matchAll(
      /\('([a-z_]+)',\s*\n?\s*'(?:[^']|'')*',\s*\n?\s*array\[([^\]]*)\]/g,
    )

    for (const row of rows) {
      const [, name, body] = row
      const properties = [...body.matchAll(/'([a-z_]+)'/g)].map((match) => match[1])
      // Later migrations win, exactly as ON CONFLICT DO UPDATE does.
      contract.set(name, properties)
    }
  }

  return contract
}

describe('the event contract matches the database', () => {
  const sql = contractFromSql()

  it('found the seeded events at all', () => {
    // Guards the parser itself: a regex that matched nothing would make every
    // test below pass for the wrong reason.
    expect(sql.size).toBeGreaterThan(15)
    expect(sql.has('join_clicked')).toBe(true)
  })

  it('reads the LATER definition when a migration revises one', () => {
    // The specific thing the multi-file read exists for: 0013 seeds
    // watching_together_ended without the detection lag, 0015 adds it, and the
    // database ends up with 0015's shape.
    expect(sql.get('watching_together_ended')).toContain('detection_delay_ms')
    expect(sql.get('join_clicked')).toContain('opportunity_key')
  })

  it('registers exactly the events the client can emit', () => {
    expect([...sql.keys()].sort()).toEqual([...ANALYTICS_EVENT_NAMES].sort())
  })

  for (const name of ANALYTICS_EVENT_NAMES) {
    it(`allows the same properties for ${name}`, () => {
      expect(sql.get(name)?.sort()).toEqual([...EVENT_PROPERTIES[name]].sort())
    })
  }

  it('registers the same environments', () => {
    for (const environment of ANALYTICS_ENVIRONMENTS) {
      expect(MIGRATION).toContain(`('${environment}',`)
    }
  })

  it('applies the same value limits on both sides', () => {
    // The SQL caps a property string at 64 characters and a payload at 12 keys.
    expect(MIGRATION).toContain(`> ${MAX_PROPERTY_VALUE_LENGTH}`)
    expect(MIGRATION).toContain(`v_kept >= ${MAX_PROPERTIES}`)
  })
})

describe('properties are stripped to the contract', () => {
  it('keeps what the event declares', () => {
    expect(cleanProperties('join_clicked', { social_count: 4, navigated: true })).toEqual({
      social_count: 4,
      navigated: true,
    })
  })

  it('drops anything the event does not declare', () => {
    // The privacy rule, as a mechanism rather than a promise: there is no key
    // a message body could be sent under.
    const cleaned = cleanProperties('group_message_sent', {
      length_bucket: 'short',
      has_emote: false,
      body: 'hey are you watching this',
      query: 'nina',
      token: 'ya29.secret',
      email: 'someone@example.test',
    } as never)

    expect(cleaned).toEqual({ length_bucket: 'short', has_emote: false })
  })

  it('drops a long string even under an allowed key', () => {
    const long = 'x'.repeat(MAX_PROPERTY_VALUE_LENGTH + 1)
    expect(cleanProperties('friend_request_sent', { outcome: long })).toEqual({})
    expect(cleanProperties('friend_request_sent', { outcome: 'requested' })).toEqual({
      outcome: 'requested',
    })
  })

  it('drops objects and arrays, so a property is never a document', () => {
    const cleaned = cleanProperties('combo_formed', {
      count: { nested: 'thing' },
    } as never)
    expect(cleaned).toEqual({})
  })

  it('drops numbers that are not numbers', () => {
    expect(cleanProperties('combo_formed', { count: Number.NaN })).toEqual({})
    expect(cleanProperties('combo_formed', { count: Number.POSITIVE_INFINITY })).toEqual({})
    expect(cleanProperties('combo_formed', { count: 0 })).toEqual({ count: 0 })
  })
})

describe('destination channels', () => {
  it('normalises a Twitch login', () => {
    expect(normalizeChannel('LIRIK')).toBe('lirik')
    expect(normalizeChannel('  xQcOW  ')).toBe('xqcow')
  })

  it('refuses anything that is not one', () => {
    // A URL is exactly what must never end up here.
    expect(normalizeChannel('https://twitch.tv/lirik')).toBeNull()
    expect(normalizeChannel('lirik/videos?filter=archives')).toBeNull()
    expect(normalizeChannel('')).toBeNull()
    expect(normalizeChannel(null)).toBeNull()
    expect(normalizeChannel('a'.repeat(26))).toBeNull()
  })
})

describe('building an event', () => {
  const context = {
    environment: 'private_beta' as const,
    sessionId: 'session-1',
    appVersion: '0.5.0',
    now: 1_700_000_000_000,
  }

  it('carries the build and the environment on every event', () => {
    const event = buildEvent({ name: 'extension_session_started' }, context)
    expect(event?.app_version).toBe('0.5.0')
    expect(event?.environment).toBe('private_beta')
    expect(event?.session_id).toBe('session-1')
  })

  it('refuses an event name the contract does not know', () => {
    expect(buildEvent({ name: 'nonsense_event' as never }, context)).toBeNull()
  })

  it('lets a reconstructed event name its own session and time', () => {
    // The end of a session that expired while nothing was running belongs to
    // that session, not to the one now starting.
    const event = buildEvent(
      {
        name: 'extension_session_ended',
        properties: { duration_ms: 60_000, end_reason: 'idle' },
        sessionId: 'older-session',
        occurredAt: context.now - 60_000,
      },
      context,
    )
    expect(event?.session_id).toBe('older-session')
    expect(event?.occurred_at).toBe(new Date(context.now - 60_000).toISOString())
  })
})
