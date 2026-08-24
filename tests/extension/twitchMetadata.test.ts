import { describe, expect, it, vi } from 'vitest'
import {
  HELIX_BATCH_LIMIT,
  LIVE_TTL_MS,
  STALE_TOLERANCE_MS,
  chunk,
  formatViewers,
  isTwitchImageUrl,
  isValidLogin,
  liveStateOf,
  needsRefresh,
  normalizeLogins,
  parseChannelMetadata,
  parseMetadataResponse,
} from '../../src/core/twitchMetadata'
import type { ChannelMetadata } from '../../src/core/twitchMetadata'
import { createMetadataService } from '../../src/background/metadata'
import {
  MAX_LOGINS_PER_REQUEST,
  buildMetadata,
  helixQuery,
  parseAppToken,
  parseStreams,
  parseUsers,
  tokenIsUsable,
  normalizeLogins as serverNormalizeLogins,
} from '../../supabase/functions/twitch-metadata/twitch'

/**
 * The metadata subsystem.
 *
 * Two halves, tested together because they are one contract: the Edge
 * Function's pure Helix logic (which vitest can import because that file
 * deliberately contains no Deno APIs) and the extension's own parsing, cache
 * and batching.
 *
 * The thread running through all of it: metadata is ENRICHMENT. Every failure
 * has to end somewhere that renders as today's plain card, and no failure may
 * ever end somewhere that renders as a confident wrong answer.
 */

const NOW = 1_700_000_000_000

const helixUser = (login: string, name = login.toUpperCase()) => ({
  id: '1234',
  login,
  display_name: name,
  profile_image_url: `https://static-cdn.jtvnw.net/jtv_user_pictures/${login}.png`,
})

const helixStream = (login: string, over: Record<string, unknown> = {}) => ({
  user_login: login,
  type: 'live',
  game_name: 'Escape from Tarkov',
  title: 'late night wipe grind',
  viewer_count: 18_412,
  started_at: '2023-11-14T22:13:20.000Z',
  ...over,
})

// ------------------------------------------------------------------ logins

describe('a channel is input, not data', () => {
  it('accepts only what Twitch calls a login', () => {
    for (const good of ['lirik', 'xqc', 'lvndmark', 'summit1g', 'a_b_9']) {
      expect(isValidLogin(good)).toBe(true)
    }
    for (const bad of ['', 'ab', 'x'.repeat(26), 'has space', 'semi;colon', '../etc', 'LIRIK']) {
      expect(isValidLogin(bad)).toBe(false)
    }
  })

  it('is the gate that stops a string becoming a request', () => {
    /*
     * Channels reach us from presence rows, which came from a URL path, which
     * came from somebody's browser. Anything that is not exactly a login is
     * dropped before it can be interpolated into a Helix query.
     */
    expect(normalizeLogins(['lirik', 'https://evil.example/x', '../../admin', null, 7])).toEqual([
      'lirik',
    ])
    expect(serverNormalizeLogins(['lirik', 'http://169.254.169.254/latest'])).toEqual(['lirik'])
  })

  it('canonicalises and de-duplicates', () => {
    expect(normalizeLogins(['LIRIK', 'lirik', ' Lirik '])).toEqual(['lirik'])
    expect(serverNormalizeLogins(['LIRIK', 'lirik'])).toEqual(['lirik'])
  })

  it('bounds how much one request may ask for', () => {
    const many = Array.from({ length: 500 }, (_, index) => `user${index}`)
    expect(serverNormalizeLogins(many).length).toBe(MAX_LOGINS_PER_REQUEST)
  })

  it('splits a large set into Helix-sized batches', () => {
    const many = Array.from({ length: 250 }, (_, index) => `user${index}`)
    const batches = chunk(many, HELIX_BATCH_LIMIT)
    expect(batches.map((batch) => batch.length)).toEqual([100, 100, 50])
    expect(batches.flat()).toEqual(many)
  })

  it('sends a batch as repeated params, which is how Helix takes one', () => {
    expect(helixQuery('user_login', ['lirik', 'xqc'])).toBe('user_login=lirik&user_login=xqc')
  })
})

// ------------------------------------------------------------- the app token

describe('the app access token', () => {
  it('is reused until it is nearly expired', () => {
    const token = { accessToken: 'abcdefgh', expiresAt: NOW + 60 * 60_000 }
    expect(tokenIsUsable(token, NOW)).toBe(true)
    // Inside the margin: replaced early rather than being the request that
    // discovers it died mid-flight.
    expect(tokenIsUsable(token, NOW + 60 * 60_000 - 60_000)).toBe(false)
    expect(tokenIsUsable(null, NOW)).toBe(false)
  })

  it('reads a client-credentials response', () => {
    const token = parseAppToken({ access_token: 'a'.repeat(30), expires_in: 5_184_000 }, NOW)
    expect(token?.accessToken).toBe('a'.repeat(30))
    expect(token?.expiresAt).toBe(NOW + 5_184_000_000)
  })

  it('treats a lifetime-less token as short-lived rather than eternal', () => {
    const token = parseAppToken({ access_token: 'a'.repeat(30) }, NOW)
    expect(token?.expiresAt).toBe(NOW + 60 * 60_000)
  })

  it('refuses a response that is not a token', () => {
    expect(parseAppToken(null, NOW)).toBeNull()
    expect(parseAppToken({}, NOW)).toBeNull()
    expect(parseAppToken({ access_token: 'short' }, NOW)).toBeNull()
    expect(parseAppToken({ access_token: 42 }, NOW)).toBeNull()
  })
})

// ------------------------------------------------------------ helix parsing

describe('reading what Twitch sent back', () => {
  it('builds a live record from a user and a stream', () => {
    const [record] = buildMetadata(
      ['lirik'],
      parseUsers({ data: [helixUser('lirik', 'LIRIK')] }),
      parseStreams({ data: [helixStream('lirik')] }),
      NOW,
    )

    expect(record.live).toBe('live')
    expect(record.displayName).toBe('LIRIK')
    expect(record.gameName).toBe('Escape from Tarkov')
    expect(record.title).toBe('late night wipe grind')
    expect(record.viewerCount).toBe(18_412)
    expect(record.userId).toBe('1234')
    expect(record.startedAt).toBe(Date.parse('2023-11-14T22:13:20.000Z'))
  })

  it('calls a resolved channel with no stream offline', () => {
    const [record] = buildMetadata(
      ['lirik'],
      parseUsers({ data: [helixUser('lirik')] }),
      parseStreams({ data: [] }),
      NOW,
    )
    expect(record.live).toBe('offline')
    // Nothing about a stream that is not happening.
    expect(record.gameName).toBeNull()
    expect(record.title).toBeNull()
    expect(record.viewerCount).toBeNull()
  })

  it('calls a channel Twitch did not resolve unknown, never offline', () => {
    /*
     * The distinction the whole feature rests on. A channel that does not
     * exist and a channel that is not streaming are different answers, and
     * only one of them may be rendered as a fact.
     */
    const [record] = buildMetadata(['nosuchuser'], new Map(), new Map(), NOW)
    expect(record.live).toBe('unknown')
  })

  it('produces a record for every login asked about, in order', () => {
    // Keyed on what was requested, so a channel missing from either batch
    // still gets a record - it just says less.
    const records = buildMetadata(
      ['lirik', 'xqc', 'shroud'],
      parseUsers({ data: [helixUser('lirik'), helixUser('shroud')] }),
      parseStreams({ data: [helixStream('lirik')] }),
      NOW,
    )
    expect(records.map((r) => r.login)).toEqual(['lirik', 'xqc', 'shroud'])
    expect(records.map((r) => r.live)).toEqual(['live', 'unknown', 'offline'])
  })

  it('ignores a stream row that does not positively say it is live', () => {
    const streams = parseStreams({
      data: [helixStream('lirik', { type: '' }), helixStream('xqc', { type: 'live' })],
    })
    expect(streams.has('lirik')).toBe(false)
    expect(streams.has('xqc')).toBe(true)
  })

  it('survives malformed responses without throwing', () => {
    for (const junk of [null, undefined, {}, { data: null }, { data: 'nope' }, []]) {
      expect(parseUsers(junk).size).toBe(0)
      expect(parseStreams(junk).size).toBe(0)
    }
    expect(buildMetadata(['lirik'], parseUsers(null), parseStreams(null), NOW)[0].live).toBe(
      'unknown',
    )
  })

  it('refuses a display name that is a different word', () => {
    // Casing is a spelling. Anything else is a rename, and identity never
    // comes from display text.
    const [record] = buildMetadata(
      ['lirik'],
      parseUsers({ data: [helixUser('lirik', 'SomebodyElse')] }),
      new Map(),
      NOW,
    )
    expect(record.displayName).toBeNull()
  })

  it('clamps a title that is payload rather than information', () => {
    const [record] = buildMetadata(
      ['lirik'],
      parseUsers({ data: [helixUser('lirik')] }),
      parseStreams({ data: [helixStream('lirik', { title: 'x'.repeat(500) })] }),
      NOW,
    )
    expect(record.title?.length).toBeLessThanOrEqual(140)
  })
})

// ---------------------------------------------------------- client parsing

describe('what the extension is willing to believe', () => {
  const record = (over: Record<string, unknown> = {}) => ({
    login: 'lirik',
    userId: '1234',
    displayName: 'LIRIK',
    profileImageUrl: 'https://static-cdn.jtvnw.net/jtv_user_pictures/lirik.png',
    live: 'live',
    gameName: 'Escape from Tarkov',
    title: 'grinding',
    viewerCount: 18_412,
    startedAt: NOW - 60_000,
    fetchedAt: NOW,
    ...over,
  })

  it('accepts a well-formed record', () => {
    const parsed = parseChannelMetadata(record(), NOW)
    expect(parsed?.login).toBe('lirik')
    expect(parsed?.live).toBe('live')
    expect(parsed?.viewerCount).toBe(18_412)
  })

  it('drops a record whose login is not a login', () => {
    expect(parseChannelMetadata(record({ login: 'not a login' }), NOW)).toBeNull()
    expect(parseChannelMetadata(null, NOW)).toBeNull()
    expect(parseChannelMetadata('lirik', NOW)).toBeNull()
  })

  it('only lets a Twitch CDN URL into an image tag', () => {
    /*
     * It arrives through our own server, but it originated at a third party.
     * "It came back from an API we called" is not the same as "it is safe to
     * put in a src attribute".
     */
    expect(isTwitchImageUrl('https://static-cdn.jtvnw.net/x.png')).toBe(true)
    expect(isTwitchImageUrl('http://static-cdn.jtvnw.net/x.png')).toBe(false)
    expect(isTwitchImageUrl('https://evil.example/x.png')).toBe(false)
    expect(isTwitchImageUrl('javascript:alert(1)')).toBe(false)
    expect(isTwitchImageUrl('data:image/svg+xml,<svg onload=alert(1)>')).toBe(false)
    expect(isTwitchImageUrl('https://static-cdn.jtvnw.net.evil.example/x.png')).toBe(false)

    expect(parseChannelMetadata(record({ profileImageUrl: 'https://evil.example/x' }), NOW)
      ?.profileImageUrl).toBeNull()
  })

  it('will not carry stream fields on a channel that is not live', () => {
    // Otherwise a card could say "Escape from Tarkov · 18K" with the LIVE
    // badge removed, which is worse than saying nothing.
    const parsed = parseChannelMetadata(record({ live: 'offline' }), NOW)
    expect(parsed?.gameName).toBeNull()
    expect(parsed?.title).toBeNull()
    expect(parsed?.viewerCount).toBeNull()
    expect(parsed?.startedAt).toBeNull()
  })

  it('treats an unrecognised live value as unknown', () => {
    expect(parseChannelMetadata(record({ live: 'maybe' }), NOW)?.live).toBe('unknown')
  })

  it('reads a whole response, skipping the entries it cannot use', () => {
    const parsed = parseMetadataResponse(
      { channels: [record(), { login: 'nope nope' }, null, record({ login: 'xqc', displayName: null })] },
      NOW,
    )
    expect(parsed.map((entry) => entry.login)).toEqual(['lirik', 'xqc'])
    expect(parseMetadataResponse(null, NOW)).toEqual([])
    expect(parseMetadataResponse({ channels: 'nope' }, NOW)).toEqual([])
  })
})

// ------------------------------------------------------------- freshness

describe('how long an answer is still an answer', () => {
  const live = (fetchedAt: number): ChannelMetadata => ({
    login: 'lirik',
    userId: null,
    displayName: 'LIRIK',
    profileImageUrl: null,
    live: 'live',
    gameName: null,
    title: null,
    viewerCount: null,
    startedAt: null,
    fetchedAt,
  })

  it('believes a recent record', () => {
    expect(liveStateOf(live(NOW), NOW)).toBe('live')
    expect(liveStateOf(live(NOW - 60_000), NOW)).toBe('live')
  })

  it('stops believing one that is too old, without calling it offline', () => {
    /*
     * The failure mode this prevents: a worker that slept for an hour showing
     * LIVE badges for streams that ended while it was asleep. Past the
     * tolerance the record stops being evidence about now - which renders as
     * the plain card, not as OFFLINE.
     */
    expect(liveStateOf(live(NOW - STALE_TOLERANCE_MS - 1), NOW)).toBe('unknown')
  })

  it('says unknown when there is nothing at all', () => {
    expect(liveStateOf(undefined, NOW)).toBe('unknown')
  })

  it('refetches on the live TTL, long before it stops believing', () => {
    // Refresh early, distrust late: the gap between the two is what keeps a
    // slow request from turning a live card into a plain one.
    expect(needsRefresh(live(NOW), NOW)).toBe(false)
    expect(needsRefresh(live(NOW - LIVE_TTL_MS), NOW)).toBe(true)
    expect(needsRefresh(undefined, NOW)).toBe(true)
    expect(LIVE_TTL_MS).toBeLessThan(STALE_TOLERANCE_MS)
  })
})

describe('viewer counts are context, so they are compact', () => {
  it('formats the way a viewer expects', () => {
    expect(formatViewers(0)).toBe('0')
    expect(formatViewers(999)).toBe('999')
    expect(formatViewers(1_000)).toBe('1.0K')
    expect(formatViewers(18_412)).toBe('18K')
    expect(formatViewers(9_940)).toBe('9.9K')
    expect(formatViewers(1_240_000)).toBe('1.2M')
  })
})

// ----------------------------------------------------- the worker service

describe('the worker fetches once for everybody', () => {
  const record = (login: string, over: Partial<ChannelMetadata> = {}) => ({
    login,
    userId: null,
    displayName: login.toUpperCase(),
    profileImageUrl: null,
    live: 'live',
    gameName: null,
    title: null,
    viewerCount: null,
    startedAt: null,
    fetchedAt: NOW,
    ...over,
  })

  const service = (
    fetchImpl: (logins: string[]) => Promise<unknown>,
    now: () => number = () => NOW,
  ) => {
    const calls: string[][] = []
    const handle = createMetadataService({
      fetcher: {
        fetch: (logins) => {
          calls.push(logins)
          return fetchImpl(logins)
        },
      },
      now,
    })
    return { handle, calls }
  }

  const settle = () => new Promise((resolve) => setTimeout(resolve, 0))

  it('asks once for a batch rather than once per channel', async () => {
    const { handle, calls } = service(async (logins) => ({
      channels: logins.map((login) => record(login)),
    }))

    handle.want(['lirik', 'xqc', 'shroud'])
    await settle()

    expect(calls).toEqual([['lirik', 'xqc', 'shroud']])
    expect(Object.keys(handle.snapshot()).sort()).toEqual(['lirik', 'shroud', 'xqc'])
  })

  it('does not ask again while the answer is still fresh', async () => {
    const { handle, calls } = service(async (logins) => ({
      channels: logins.map((login) => record(login)),
    }))

    handle.want(['lirik'])
    await settle()
    // A presence heartbeat, a re-render, another tab: all of it is free.
    for (let i = 0; i < 20; i += 1) handle.want(['lirik'])
    await settle()

    expect(calls).toHaveLength(1)
  })

  it('asks again once the live TTL has passed', async () => {
    let clock = NOW
    const { handle, calls } = service(
      async (logins) => ({ channels: logins.map((login) => record(login, { fetchedAt: clock })) }),
      () => clock,
    )

    handle.want(['lirik'])
    await settle()
    clock += LIVE_TTL_MS
    handle.want(['lirik'])
    await settle()

    expect(calls).toHaveLength(2)
  })

  it('does not stampede when the same channel is wanted mid-flight', async () => {
    /*
     * Two tabs half a second apart, or one tab that re-rendered. Without the
     * in-flight set this is two requests for the same thing, and at ten tabs
     * it is ten.
     */
    let release: (value: unknown) => void = () => {}
    const gate = new Promise((resolve) => {
      release = resolve
    })

    const { handle, calls } = service(async (logins) => {
      await gate
      return { channels: logins.map((login) => record(login)) }
    })

    handle.want(['lirik'])
    handle.want(['lirik'])
    handle.want(['lirik', 'xqc'])
    expect(handle.pending()).toBeGreaterThan(0)

    release(null)
    await settle()
    await settle()

    // lirik was asked for once; xqc joined a second batch because it was new.
    expect(calls.flat().filter((login) => login === 'lirik')).toHaveLength(1)
  })

  it('chunks beyond what one request may carry', async () => {
    const { handle, calls } = service(async (logins) => ({
      channels: logins.map((login) => record(login)),
    }))

    handle.want(Array.from({ length: 250 }, (_, index) => `user${index}`))
    await settle()

    expect(calls.map((call) => call.length)).toEqual([100, 100, 50])
  })

  it('keeps what it had when a fetch fails', async () => {
    let fail = false
    let clock = NOW
    const { handle } = service(
      async (logins) => {
        if (fail) throw new Error('backend down')
        return { channels: logins.map((login) => record(login)) }
      },
      () => clock,
    )

    handle.want(['lirik'])
    await settle()
    expect(handle.snapshot().lirik.live).toBe('live')

    fail = true
    clock += LIVE_TTL_MS
    handle.want(['lirik'])
    await settle()

    /*
     * Still live, still there. A failed refresh must never turn a channel we
     * knew was live into one we claim is offline - it ages out into `unknown`
     * on its own, which renders as the plain card.
     */
    expect(handle.snapshot().lirik.live).toBe('live')
    expect(liveStateOf(handle.snapshot().lirik, clock + STALE_TOLERANCE_MS + 1)).toBe('unknown')
  })

  it('ignores a malformed response rather than storing it', async () => {
    const { handle } = service(async () => ({ channels: [{ login: 'not a login' }] }))
    handle.want(['lirik'])
    await settle()
    expect(handle.snapshot()).toEqual({})
  })

  it('drops invalid channels before asking about them', async () => {
    const { handle, calls } = service(async (logins) => ({
      channels: logins.map((login) => record(login)),
    }))

    handle.want(['LIRIK', 'lirik', 'https://evil.example', ''])
    await settle()

    expect(calls).toEqual([['lirik']])
  })

  it('asks for nothing when there is nothing to ask about', async () => {
    const { handle, calls } = service(async () => ({ channels: [] }))
    handle.want([])
    handle.want(['..'])
    await settle()
    expect(calls).toEqual([])
  })

  it('restores a warm cache but not a cold one', async () => {
    const stored = { lirik: record('lirik'), xqc: record('xqc', { fetchedAt: NOW - 48 * 60 * 60_000 }) }
    const handle = createMetadataService({
      fetcher: { fetch: async () => ({ channels: [] }) },
      load: async () => stored,
      now: () => NOW,
    })

    await handle.hydrate()

    // A day-old record would be shown for the moment before the refresh
    // lands, and being briefly wrong is worse than being briefly plain.
    expect(Object.keys(handle.snapshot())).toEqual(['lirik'])
  })

  it('forgets everything on sign-out', async () => {
    const saved: unknown[] = []
    const handle = createMetadataService({
      fetcher: { fetch: async () => ({ channels: [] }) },
      save: (records: Record<string, ChannelMetadata>) => saved.push(records),
      now: () => NOW,
    })

    handle.reset()
    expect(handle.snapshot()).toEqual({})
    expect(saved.at(-1)).toEqual({})
  })

  it('never reaches the network by itself', async () => {
    // Everything outbound goes through the injected fetcher, which in
    // production is the Supabase function call. Nothing here opens a socket.
    const spy = vi.fn()
    const original = globalThis.fetch
    globalThis.fetch = spy as unknown as typeof fetch
    try {
      const { handle } = service(async (logins) => ({
        channels: logins.map((login) => record(login)),
      }))
      handle.want(['lirik'])
      await settle()
      expect(spy).not.toHaveBeenCalled()
    } finally {
      globalThis.fetch = original
    }
  })
})
