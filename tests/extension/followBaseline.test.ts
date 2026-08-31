import { describe, expect, it } from 'vitest'
import {
  FOLLOWS_SCOPE,
  broadcasterIdFor,
  followsBroadcaster,
  hasFollowsScope,
  readinessFor,
} from '../../supabase/functions/twitch-credential/twitch'

/**
 * The follow baseline, and the distinction the whole measurement rests on.
 *
 * M3D asks Twitch one question about one creator: did this viewer already
 * follow them at the moment friends led them there? Three answers are possible
 * and only two of them are observations:
 *
 *   following        -> relationship_present = true
 *   not following    -> relationship_present = false      (a REAL observation)
 *   could not ask    -> NO observation at all
 *
 * Twitch signals "not following" with an EMPTY array, which looks exactly like
 * "nothing came back". Confusing the two would turn every timeout into a
 * confident claim that somebody had not followed a creator - and that claim
 * would then be indistinguishable from a genuine discovery in every downstream
 * number.
 */

const respond = (status: number, body: unknown, capture?: (url: string) => void): typeof fetch =>
  ((url: string) => {
    capture?.(String(url))
    return Promise.resolve({
      status,
      ok: status >= 200 && status < 300,
      json: () => Promise.resolve(body),
    } as unknown as Response)
  }) as unknown as typeof fetch

describe('asking whether one viewer follows one creator', () => {
  it('reads a follow as true', async () => {
    const result = await followsBroadcaster('111', '222', 'tok', 'cid', respond(200, {
      data: [{ broadcaster_id: '222', broadcaster_login: 'lirik', followed_at: '2024-01-01' }],
    }))
    expect(result).toEqual({ ok: true, following: true })
  })

  /** The load-bearing case: empty data is an ANSWER, not a failure. */
  it('reads an empty array as a genuine "not following"', async () => {
    const result = await followsBroadcaster('111', '222', 'tok', 'cid', respond(200, { data: [] }))
    expect(result).toEqual({ ok: true, following: false })
  })

  it('asks about exactly one creator, never the whole list', async () => {
    let asked = ''
    await followsBroadcaster('111', '222', 'tok', 'cid', respond(200, { data: [] }, (u) => (asked = u)))

    expect(asked).toContain('user_id=111')
    expect(asked).toContain('broadcaster_id=222')
    // Without broadcaster_id this endpoint returns the viewer's entire follow
    // list, which Watchside must never retrieve.
    expect(asked).toMatch(/broadcaster_id=/)
  })

  it('treats an expired or unscoped token as unavailable, never as false', async () => {
    expect(await followsBroadcaster('1', '2', 't', 'c', respond(401, {}))).toEqual({
      ok: false,
      reason: 'invalid_token',
    })
    expect(await followsBroadcaster('1', '2', 't', 'c', respond(403, {}))).toEqual({
      ok: false,
      reason: 'scope_missing',
    })
  })

  it('treats an outage as unavailable, never as false', async () => {
    expect(await followsBroadcaster('1', '2', 't', 'c', respond(500, {}))).toEqual({
      ok: false,
      reason: 'twitch_unavailable',
    })
    const boom = (() => Promise.reject(new Error('offline'))) as unknown as typeof fetch
    expect(await followsBroadcaster('1', '2', 't', 'c', boom)).toEqual({
      ok: false,
      reason: 'twitch_unavailable',
    })
  })

  it('treats a malformed response as unavailable, never as false', async () => {
    expect(await followsBroadcaster('1', '2', 't', 'c', respond(200, {}))).toEqual({
      ok: false,
      reason: 'twitch_unavailable',
    })
    expect(await followsBroadcaster('1', '2', 't', 'c', respond(200, { data: 'nope' }))).toEqual({
      ok: false,
      reason: 'twitch_unavailable',
    })
  })

  /**
   * Every failure mode returns `ok: false`, and none of them carries a
   * `following` value. There is no shape in which a failure can be mistaken
   * for an answer.
   */
  it('never returns a following value on any failure path', async () => {
    for (const impl of [respond(401, {}), respond(403, {}), respond(500, {}), respond(200, {})]) {
      const result = await followsBroadcaster('1', '2', 't', 'c', impl)
      expect(result.ok).toBe(false)
      expect(result).not.toHaveProperty('following')
    }
  })
})

describe('resolving a creator login to an id', () => {
  it('returns the id Twitch reports', async () => {
    const result = await broadcasterIdFor('lirik', 'tok', 'cid', respond(200, { data: [{ id: '23161357' }] }))
    expect(result).toEqual({ ok: true, id: '23161357' })
  })

  it('encodes the login rather than pasting it into the URL', async () => {
    let asked = ''
    await broadcasterIdFor('odd name', 'tok', 'cid', respond(200, { data: [{ id: '1' }] }, (u) => (asked = u)))
    expect(asked).toContain('login=odd%20name')
    expect(asked).not.toContain('login=odd name')
  })

  it('treats a login Twitch does not know as unknown, not as an error to store', async () => {
    expect(await broadcasterIdFor('ghost', 't', 'c', respond(200, { data: [] }))).toEqual({
      ok: false,
      reason: 'unknown_broadcaster',
    })
  })

  it('distinguishes an expired token from an unknown creator', async () => {
    expect(await broadcasterIdFor('lirik', 't', 'c', respond(401, {}))).toEqual({
      ok: false,
      reason: 'invalid_token',
    })
  })
})

describe('what M3D can do for an actor right now', () => {
  const base = { hasCredential: true, status: 'active', scopes: [FOLLOWS_SCOPE] }

  it('is ready when the credential is active and carries the scope', () => {
    expect(readinessFor(base)).toBe('ready')
  })

  /**
   * THE TRANSITION THAT MATTERS.
   *
   * Everybody who signed in before M3D existed has a perfectly good credential
   * that simply predates this permission. Calling that "needs reauthorization"
   * would tell them something untrue - nothing is broken - and would lose the
   * distinction the account surface needs in order to ask the right question.
   */
  it('distinguishes "never granted the follow permission" from "broken"', () => {
    expect(readinessFor({ ...base, scopes: ['user:read:email'] })).toBe('needs_follow_permission')
    expect(readinessFor({ ...base, scopes: [] })).toBe('needs_follow_permission')

    expect(readinessFor({ ...base, status: 'needs_reauthorization' })).toBe('needs_reauthorization')
    expect(readinessFor({ ...base, hasCredential: false })).toBe('needs_reauthorization')
  })

  it('does not collapse an unknown status into either', () => {
    expect(readinessFor({ ...base, status: 'something_new' })).toBe('temporarily_unavailable')
  })

  it('recognises the scope by its exact name', () => {
    expect(hasFollowsScope(['user:read:follows'])).toBe(true)
    expect(hasFollowsScope(['user:read:email'])).toBe(false)
    expect(hasFollowsScope([])).toBe(false)
    // Not a prefix or substring match.
    expect(hasFollowsScope(['user:read:follows:extra'])).toBe(false)
  })

  it('asks for follows and nothing else', () => {
    expect(FOLLOWS_SCOPE).toBe('user:read:follows')
    expect(FOLLOWS_SCOPE).not.toContain('subscriptions')
  })
})
