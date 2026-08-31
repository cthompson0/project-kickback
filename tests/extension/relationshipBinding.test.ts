import { readFileSync, readdirSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import {
  BASELINE_WINDOW_MS,
  normalizeLogin,
  toClientResponse,
  validateAttribution,
} from '../../supabase/functions/twitch-credential/relationship'

/**
 * What earns the right to write a follow baseline.
 *
 * The relationship action is the one place a client can cause a Twitch-derived
 * fact about a person to be stored. Everything a client says in that request is
 * a claim, and each rule here turns one of those claims into something the
 * server checked for itself.
 *
 * The attribution id is checkable because `join_clicked` reaches
 * `analytics_events` through `analytics_track`, whose actor is `auth.uid()`
 * server-side. So the JOIN record cannot be forged on somebody else's behalf,
 * and the lookup that reads it is scoped to the authenticated actor in its
 * WHERE clause - a caller that forgets to compare actors still cannot see
 * anybody else's JOIN.
 */

const NOW = Date.parse('2026-08-31T12:00:00.000Z')
const AT = (offsetMs: number) => new Date(NOW - offsetMs).toISOString()

const join = (over: Partial<Parameters<typeof validateAttribution>[0]['join'] & object> = {}) => ({
  actorId: 'actor-1',
  destinationChannel: 'lirik',
  occurredAt: AT(5_000),
  socialCount: 2,
  ...over,
})

const check = (over: Record<string, unknown> = {}) =>
  validateAttribution({
    join: join(),
    broadcasterLogin: 'lirik',
    now: NOW,
    ...over,
  })

describe('an attribution has to be real, and the actor’s', () => {
  it('accepts a recent socially initiated JOIN to the named creator', () => {
    expect(check()).toEqual({ ok: true })
  })

  /**
   * A random or stolen attribution id finds no JOIN.
   *
   * The lookup is scoped to the authenticated actor, so "no such attribution"
   * and "somebody else's attribution" arrive here identically - and both refuse.
   * That is deliberate: a caller must not be able to tell the difference, and
   * neither may write a row.
   */
  it('refuses an attribution with no JOIN behind it', () => {
    expect(check({ join: null })).toEqual({ ok: false, reason: 'unknown_attribution' })
  })
})

describe('the creator is bound to the JOIN, not supplied beside it', () => {
  /**
   * The forgery this stops.
   *
   * Without it, somebody could quote a genuine JOIN of their own and name any
   * creator they liked - manufacturing follow baselines for channels they never
   * visited, all of which would look perfectly legitimate downstream.
   */
  it('refuses a creator the JOIN was not aimed at', () => {
    expect(check({ broadcasterLogin: 'someone_else' })).toEqual({
      ok: false,
      reason: 'destination_mismatch',
    })
  })

  it('refuses when the JOIN recorded no destination at all', () => {
    expect(check({ join: join({ destinationChannel: null }) })).toEqual({
      ok: false,
      reason: 'destination_mismatch',
    })
  })

  it('compares logins exactly, not loosely', () => {
    expect(check({ join: join({ destinationChannel: 'LIRIK' }) })).toMatchObject({ ok: false })
    expect(check({ join: join({ destinationChannel: 'lirik2' }) })).toMatchObject({ ok: false })
  })
})

describe('only socially initiated JOINs are in the population', () => {
  it('refuses a JOIN nobody else was part of', () => {
    expect(check({ join: join({ socialCount: 0 }) })).toEqual({
      ok: false,
      reason: 'not_socially_initiated',
    })
  })

  /** Missing context must not read as "there were friends there". */
  it('refuses when the social count is missing or nonsense', () => {
    expect(check({ join: join({ socialCount: Number.NaN }) })).toMatchObject({
      ok: false,
      reason: 'not_socially_initiated',
    })
    expect(check({ join: join({ socialCount: -1 }) })).toMatchObject({
      ok: false,
      reason: 'not_socially_initiated',
    })
  })
})

describe('the baseline window is what keeps this "at the JOIN"', () => {
  it('accepts a JOIN from moments ago', () => {
    expect(check({ join: join({ occurredAt: AT(1_000) }) })).toEqual({ ok: true })
    expect(check({ join: join({ occurredAt: AT(BASELINE_WINDOW_MS - 1_000) }) })).toEqual({
      ok: true,
    })
  })

  /**
   * The failure this prevents is silent and permanent: a delayed lookup would
   * record follow state at some later moment under a column called
   * following_at_join, and nothing downstream could ever tell.
   */
  it('refuses a JOIN too old to still be the baseline', () => {
    expect(check({ join: join({ occurredAt: AT(BASELINE_WINDOW_MS + 1_000) }) })).toEqual({
      ok: false,
      reason: 'outside_baseline_window',
    })
    expect(check({ join: join({ occurredAt: AT(60 * 60 * 1000) }) })).toMatchObject({
      ok: false,
      reason: 'outside_baseline_window',
    })
  })

  it('refuses a JOIN implausibly in the future', () => {
    expect(check({ join: join({ occurredAt: AT(-(BASELINE_WINDOW_MS + 1_000)) }) })).toMatchObject({
      ok: false,
      reason: 'outside_baseline_window',
    })
  })

  it('refuses an unparseable timestamp rather than assuming now', () => {
    expect(check({ join: join({ occurredAt: 'whenever' }) })).toEqual({
      ok: false,
      reason: 'outside_baseline_window',
    })
  })

  it('states a window tight enough to mean what the column says', () => {
    // Wider than the 90s arrival window, nowhere near "some time later".
    expect(BASELINE_WINDOW_MS).toBeGreaterThan(90_000)
    expect(BASELINE_WINDOW_MS).toBeLessThanOrEqual(5 * 60 * 1000)
  })
})

describe('the follow result never crosses the boundary', () => {
  /**
   * THE INVARIANT THIS WHOLE ACTION EXISTS TO PROTECT.
   *
   * A caller that could tell "recorded true" from "recorded false" would have
   * the follow result, and the server-side boundary would be decorative.
   * Everything the action returns goes through this one funnel, so the property
   * is checkable in one place.
   */
  it('says only that a baseline exists', () => {
    expect(toClientResponse({ state: 'recorded' })).toEqual({ state: 'recorded' })
  })

  it('carries no relationship field in any shape', () => {
    const responses = [
      toClientResponse({ state: 'recorded' }),
      toClientResponse({ state: 'unavailable', reason: 'needs_follow_permission' }),
      toClientResponse({ state: 'unavailable', reason: 'twitch_unavailable' }),
    ]
    for (const response of responses) {
      const text = JSON.stringify(response)
      expect(response).not.toHaveProperty('following')
      expect(response).not.toHaveProperty('relationship_present')
      expect(text).not.toContain('following')
      expect(text).not.toContain('true')
      expect(text).not.toContain('false')
    }
  })

  it('never returns a token or ciphertext', () => {
    const text = JSON.stringify(toClientResponse({ state: 'unavailable', reason: 'temporarily_unavailable' }))
    for (const forbidden of ['access', 'refresh', 'secret', 'token']) {
      expect(text).not.toContain(forbidden)
    }
  })

  /**
   * The reasons describe WATCHSIDE's state, never the user's Twitch
   * relationships - so no reason string can leak the answer by implication.
   */
  it('gives reasons about Watchside, not about the viewer', () => {
    const source = readFileSync('supabase/functions/twitch-credential/relationship.ts', 'utf8')
    const union = source.slice(
      source.indexOf('export type RelationshipReason'),
      source.indexOf('export type RelationshipResult'),
    )
    expect(union).not.toContain('following')
    expect(union).not.toContain('follows')
    expect(union).toContain('needs_follow_permission')
  })
})

describe('a creator login is validated before it is used', () => {
  it('accepts and lowercases a real login', () => {
    expect(normalizeLogin('LIRIK')).toBe('lirik')
    expect(normalizeLogin('  lirik  ')).toBe('lirik')
    expect(normalizeLogin('a_b_9')).toBe('a_b_9')
  })

  /** Nothing that is not a Twitch login reaches a URL. */
  it('refuses anything that is not a login', () => {
    for (const bad of ['', 'has space', 'sym!bol', 'a'.repeat(26), '../etc', 'a/b', null, 42]) {
      expect(normalizeLogin(bad as unknown)).toBeNull()
    }
  })
})

describe('nothing in the product calls this yet', () => {
  const walk = (dir: string, out: string[] = []): string[] => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = `${dir}/${entry.name}`
      if (entry.isDirectory()) walk(path, out)
      else if (/\.tsx?$/.test(entry.name)) out.push(path)
    }
    return out
  }

  /**
   * THE SLICE B RELEASE BLOCKER, RELEASED DELIBERATELY IN SLICE D.
   *
   * This used to assert there was NO caller, because the scope was not
   * requested, no permission had been asked for, and the privacy policy did not
   * describe follow measurement. All three are now true in the other direction,
   * so the gate opens - and it opens to exactly one caller, not to "any".
   *
   * Every additional invocation site would be another place the eligibility
   * gate could be bypassed, and that gate is the only thing standing between
   * "the channel your friends are watching" and "who you follow".
   *
   * A CORRECTION WORTH RECORDING. The Slice B version of this test read
   * `/action:s*'relationship'/` - a missing backslash, so it matched the
   * literal text `action:s*'relationship'` and could never have fired. It was
   * decorative for two slices. What actually held the line was a plain
   * substring check in followPermission.test.tsx. The regex is fixed here, and
   * is now asserted to work rather than assumed to.
   */
  const CALLER = /action:\s*'relationship'/

  it('matches a real invocation, so this gate can actually fire', () => {
    // The bug that made this test decorative for two slices.
    expect(CALLER.test("body: { action: 'relationship', broadcaster_login: x }")).toBe(true)
    // The Test Lab has an unrelated 'relationship' field for simulated
    // friendships, which is not this and must not be caught.
    expect(CALLER.test("const relationship = { relationship: 'friend' }")).toBe(false)
  })

  it('has exactly one production path invoking the relationship action', () => {
    const callers = walk('src').filter((path) => CALLER.test(readFileSync(path, 'utf8')))
    expect(callers).toEqual(['src/background/supabaseBackend.ts'])
  })

  it('requests no Twitch scope from the backend module', () => {
    // Scope construction lives in auth.ts and nowhere else. This module carries
    // whatever it is handed and decides nothing.
    const source = readFileSync('src/background/supabaseBackend.ts', 'utf8')
    expect(source).not.toContain('user:read:follows')
    expect(source).not.toContain('user:read:subscriptions')
    expect(source).not.toContain('user:read:emotes')
  })

  it('mentions no subscription scope anywhere in the server code', () => {
    const offenders = walk('supabase/functions').filter((path) =>
      readFileSync(path, 'utf8').includes('user:read:subscriptions'),
    )
    expect(offenders).toEqual([])
  })
})
