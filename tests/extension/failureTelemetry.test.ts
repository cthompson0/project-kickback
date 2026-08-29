import { describe, expect, it } from 'vitest'
import {
  FAILURE_CODES,
  FAILURE_CONTEXTS,
  REALTIME_STATUSES,
  REALTIME_SURFACES,
  toFailureCode,
  toFailureContext,
} from '../../src/core/failures'
import { EVENT_PROPERTIES, cleanProperties } from '../../src/core/analytics'

/**
 * The one thing an error event must never do is carry the error.
 *
 * Watchside had no failure telemetry at all: every failure went to console.warn
 * and stopped there, which is why the first external bug report could not be
 * diagnosed. See docs/reports/friends-beta-investigation-2026-08-27.md §17.
 *
 * The reason it was safe to add is that nothing here is derived from an
 * exception message. A context is a member of a fixed list of call sites; a
 * code is a member of a fixed list of shapes. These tests are what keep that
 * true: the classifier is fed things that DO contain content, and the
 * assertion is that content never comes back out.
 */

describe('a failure context is a member of a fixed list', () => {
  it('passes through a call site we know', () => {
    expect(toFailureContext('groups.refresh')).toBe('groups.refresh')
  })

  it('reduces anything else to unknown', () => {
    expect(toFailureContext('something.new')).toBe('unknown')
    expect(toFailureContext(undefined)).toBe('unknown')
    expect(toFailureContext(42)).toBe('unknown')
  })

  it('never echoes a string that was not on the list', () => {
    const secret = 'user typed: my password is hunter2'
    expect(toFailureContext(secret)).toBe('unknown')
  })

  it('lists only short, dot-separated call sites', () => {
    for (const context of FAILURE_CONTEXTS) {
      expect(context).toMatch(/^[a-zA-Z.]+$/)
      expect(context.length).toBeLessThanOrEqual(32)
    }
  })
})

describe('a failure code is a shape, never a message', () => {
  const cases: Array<[unknown, string]> = [
    [{ code: '42501' }, 'refused'],
    [{ code: '53400' }, 'rate_limited'],
    [{ code: 'P0002' }, 'not_found'],
    [{ code: '22023' }, 'invalid'],
    [{ code: '28000' }, 'unauthenticated'],
    [new Error('kickback: you are not watching that'), 'refused'],
    [new Error('kickback: you are sending messages too quickly'), 'rate_limited'],
    [new Error('kickback: invitation not found'), 'not_found'],
    [new Error('kickback: not authenticated'), 'unauthenticated'],
    [new Error('Failed to fetch'), 'network'],
    [new Error('something nobody anticipated'), 'unknown'],
    [null, 'unknown'],
    [undefined, 'unknown'],
  ]

  for (const [error, expected] of cases) {
    it(`classifies ${JSON.stringify(String(expected))} correctly`, () => {
      expect(toFailureCode(error)).toBe(expected)
    })
  }

  it('always returns a member of the vocabulary', () => {
    const nasty = [
      new Error('user said: here is my email chuck@example.test'),
      new Error('https://twitch.tv/somestreamer?token=abc123'),
      new Error(JSON.stringify({ body: 'a private message' })),
      'a bare string with content in it',
      { message: 'object with a message' },
    ]
    for (const error of nasty) {
      expect(FAILURE_CODES).toContain(toFailureCode(error))
    }
  })

  /** The property that actually matters, stated as its own assertion. */
  it('never returns any part of the message it was given', () => {
    const message = 'SECRETVALUE-9f3a'
    const code = toFailureCode(new Error(`something failed: ${message}`))
    expect(code).not.toContain('SECRET')
    expect(code).toBe('unknown')
  })
})

describe('the diagnostic events cannot carry content', () => {
  it('declares only the two properties, for client_error', () => {
    expect(EVENT_PROPERTIES.client_error).toEqual(['context', 'code'])
  })

  it('declares only surface and status, for realtime_status_changed', () => {
    expect(EVENT_PROPERTIES.realtime_status_changed).toEqual(['surface', 'status'])
  })

  it('declares only a code, for group_message_send_failed', () => {
    expect(EVENT_PROPERTIES.group_message_send_failed).toEqual(['code'])
  })

  it('strips anything else somebody tries to attach', () => {
    const cleaned = cleanProperties('client_error', {
      context: 'groups.refresh',
      code: 'refused',
      // None of these are declared, so none of them survive.
      message: 'the raw exception text',
      body: 'a private message',
      url: 'https://twitch.tv/x',
      user_id: 'me-uuid',
    } as never)

    expect(cleaned).toEqual({ context: 'groups.refresh', code: 'refused' })
  })

  it('drops an over-long value even under a declared key', () => {
    const cleaned = cleanProperties('client_error', {
      context: 'a'.repeat(200),
      code: 'refused',
    } as never)
    expect(cleaned.context).toBeUndefined()
    expect(cleaned.code).toBe('refused')
  })

  it('keeps every vocabulary member inside the value length cap', () => {
    for (const value of [
      ...FAILURE_CONTEXTS,
      ...FAILURE_CODES,
      ...REALTIME_SURFACES,
      ...REALTIME_STATUSES,
    ]) {
      expect(value.length).toBeLessThanOrEqual(64)
    }
  })

  it('has no channel on client_error, so an error log is not a viewing record', () => {
    expect(EVENT_PROPERTIES.client_error).not.toContain('channel')
  })
})
