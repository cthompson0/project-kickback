import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { beforeAll, describe, expect, it, vi } from 'vitest'
import { createTestLabClient } from '../../src/testlab/client'
import { assertTestLabBuild, sealNetwork } from '../../src/testlab/safety'
import { preset } from '../../src/testlab/presets'
import { opportunityKey } from '../../src/core/socialGravity'
import type { LabRecord } from '../../src/testlab/client'

/**
 * The Test Lab must not be able to reach anything hosted, and must not be able
 * to ship. Three independent guarantees, tested separately because each can
 * fail without the others noticing:
 *
 *   1. no lab code in the extension bundles;
 *   2. no Supabase anywhere in the lab's own import graph;
 *   3. no working network on the lab page, even if (1) and (2) are broken.
 */

const SRC = join(process.cwd(), 'src')
const DIST = join(process.cwd(), 'dist')

function sourcesUnder(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const path = join(dir, entry)
    if (statSync(path).isDirectory()) return sourcesUnder(path)
    return /\.tsx?$/.test(entry) ? [path] : []
  })
}

describe('the extension cannot contain the Test Lab', () => {
  it('is never imported by production source', () => {
    /*
     * The strongest of the three guarantees, and the cheapest to check: the
     * lab is a separate Vite app, so as long as nothing outside src/testlab
     * imports it, there is no path by which a build could include it - not
     * behind a flag, not in a dead branch, not as a string.
     */
    const offenders = sourcesUnder(SRC)
      .filter((path) => !path.includes(`${join('src', 'testlab')}`))
      .filter((path) => /from ['"][^'"]*testlab/.test(readFileSync(path, 'utf8')))

    expect(offenders).toEqual([])
  })

  it('refuses to initialise outside a Test Lab build', () => {
    expect(() => assertTestLabBuild('production')).toThrow(/development-only/)
    expect(() => assertTestLabBuild('demo')).toThrow(/development-only/)
    expect(() => assertTestLabBuild(undefined)).toThrow(/development-only/)
    expect(() => assertTestLabBuild('test_lab')).not.toThrow()
  })

  it('leaves no trace in the built extension', () => {
    if (!existsSync(DIST)) throw new Error('dist/ is missing - run `npm run build` first')

    const bundles = readdirSync(DIST)
      .filter((name) => name.endsWith('.js'))
      .map((name) => readFileSync(join(DIST, name), 'utf8'))

    expect(bundles.length).toBeGreaterThan(0)
    for (const bundle of bundles) {
      expect(bundle).not.toContain('Test Lab')
      expect(bundle).not.toContain('testlab')
      expect(bundle).not.toContain('lab-root')
      // The simulated roster, which only the lab knows about.
      expect(bundle).not.toContain('Bianca')
      expect(bundle).not.toContain('kickback-test-lab')
    }
  })

  it('never lets a shipped build arm the JOIN navigator', () => {
    // The one production seam the lab uses. Its body is behind a build-time
    // constant, so a production bundle folds it to an immediate return.
    const built = readFileSync(join(process.cwd(), 'dist', 'kickback-content.js'), 'utf8')
    expect(built).not.toContain('setJoinNavigator')
  })
})

describe('the Test Lab reaches nothing hosted', () => {
  it('imports no Supabase client, at any depth', () => {
    /*
     * `supabaseBackend` is imported for `toPresence` - a pure row mapper - so
     * "does it import that module" is the wrong question. This is the right
     * one: does anything the lab pulls in ever CONSTRUCT a client, or call an
     * RPC. Without a client there is no session, no URL and no key.
     */
    const labSources = sourcesUnder(join(SRC, 'testlab')).map((path) => readFileSync(path, 'utf8'))

    for (const source of labSources) {
      expect(source).not.toContain('createSupabaseClient')
      expect(source).not.toContain('createClient')
      expect(source).not.toContain('.rpc(')
      expect(source).not.toContain('VITE_SUPABASE')
    }
  })

  it('writes no presence anywhere - reportActivity is inert', async () => {
    const handle = createTestLabClient({ world: preset('two').build(), appVersion: 'test' })
    // The panel calls this; in the lab there is nowhere for it to go, and no
    // simulated person is ever written back to a server.
    expect(() => handle.client.reportActivity('lirik', true, 'LIRIK')).not.toThrow()
    expect(handle.client.getState().friends).toHaveLength(2)
  })

  it('blocks every outbound primitive on the page, loudly', () => {
    const attempts: string[] = []
    const original = {
      fetch: globalThis.fetch,
      xhr: (globalThis as Record<string, unknown>).XMLHttpRequest,
      ws: (globalThis as Record<string, unknown>).WebSocket,
    }

    try {
      sealNetwork((attempt) => attempts.push(`${attempt.api}:${attempt.target}`), 'http://localhost:5199')

      expect(() => globalThis.fetch('https://example.supabase.co/rest/v1/presence')).toThrow(
        /blocked fetch/,
      )
      const Xhr = (globalThis as Record<string, unknown>).XMLHttpRequest as new () => {
        open(method: string, url: string): void
      }
      expect(() => new Xhr().open('POST', 'https://example.supabase.co')).toThrow(/blocked/)
      const Socket = (globalThis as Record<string, unknown>).WebSocket as new (url: string) => void
      expect(() => new Socket('wss://example.supabase.co/realtime')).toThrow(/blocked/)

      // Silence is the failure mode that matters: a blocked call must be
      // visible, not swallowed.
      expect(attempts).toHaveLength(3)
      expect(attempts[0]).toContain('supabase')

      // The dev server that served the page is the one exemption. Without it
      // Vite could not serve a module or keep its reload socket, and a safety
      // measure that has to be switched off to get work done protects nothing.
      expect(() => new Socket('ws://localhost:5199/vite-hmr')).not.toThrow()
    } finally {
      globalThis.fetch = original.fetch
      ;(globalThis as Record<string, unknown>).XMLHttpRequest = original.xhr
      ;(globalThis as Record<string, unknown>).WebSocket = original.ws
    }
  })
})

describe('analytics is captured at the existing boundary', () => {
  /**
   * Let the hub's asynchronous bootstrap land.
   *
   * The analytics session is read from storage, which is a promise even when
   * the storage is in memory, so an event tracked on the very first tick is
   * still queued behind it. Production never notices - it flushes on a five
   * second timer - but a test that acts and flushes in the same tick would.
   */
  const settle = () => new Promise((resolve) => setTimeout(resolve, 20))

  const capture = async (act: (handle: ReturnType<typeof createTestLabClient>) => void) => {
    const handle = createTestLabClient({ world: preset('three').build(), appVersion: 'test' })
    await settle()
    act(handle)
    await settle()
    await handle.flush()
    return handle.records()
  }

  const named = (records: LabRecord[], name: string) => records.filter((r) => r.label === name)

  it('turns a real exposure report into a real impression', async () => {
    const records = await capture((handle) =>
      handle.client.reportExposure({
        friends: [],
        gatherings: [],
        gravity: [{ channel: 'lirik', friendCount: 3, rank: 1 }],
      }),
    )

    const [impression] = named(records, 'gravity_cluster_impression')
    expect(impression).toBeDefined()
    expect(impression.detail.friend_count).toBe(3)
    expect(impression.detail.rank).toBe(1)
    expect(impression.detail.channel).toBe('lirik')
  })

  it('derives the opportunity key in the worker, not the surface', async () => {
    // The panel never sends one. If a key appears, production minted it.
    const records = await capture((handle) =>
      handle.client.reportExposure({
        friends: [],
        gatherings: [],
        gravity: [{ channel: 'lirik', friendCount: 3, rank: 1 }],
      }),
    )

    const key = named(records, 'gravity_cluster_impression')[0]?.detail.opportunity_key
    expect(typeof key).toBe('string')
    expect(String(key)).toMatch(/^gravity:lirik:\d+$/)
  })

  it('records a JOIN through the real path, with the canonical destination', async () => {
    const records = await capture((handle) =>
      handle.client.recordJoin({
        channel: 'LIRIK',
        source: 'social_gravity',
        socialCount: 3,
        navigated: true,
      }),
    )

    const [join] = named(records, 'join_clicked')
    expect(join).toBeDefined()
    expect(join.detail.source).toBe('social_gravity')
    expect(join.detail.social_count).toBe(3)
    // Display casing never becomes identity, even through the lab.
    expect(join.detail.channel).toBe('lirik')
  })

  it('lets an impression and its JOIN agree on the opportunity', async () => {
    const handle = createTestLabClient({ world: preset('three').build(), appVersion: 'test' })
    handle.client.reportExposure({
      friends: [],
      gatherings: [],
      gravity: [{ channel: 'lirik', friendCount: 3, rank: 1 }],
    })
    handle.client.recordJoin({
      channel: 'lirik',
      source: 'social_gravity',
      socialCount: 3,
      navigated: true,
    })
    await settle()
    await handle.flush()

    const keys = handle
      .records()
      .filter((record) => record.detail.opportunity_key)
      .map((record) => record.detail.opportunity_key)

    expect(new Set(keys).size).toBe(1)
    expect(keys[0]).toBe(opportunityKey('lirik', Date.now()))
  })

  it('sends nothing anywhere - every event stops at the capture edge', async () => {
    const fetchSpy = vi.fn()
    const original = globalThis.fetch
    globalThis.fetch = fetchSpy as unknown as typeof fetch
    try {
      const handle = createTestLabClient({ world: preset('five').build(), appVersion: 'test' })
      await settle()
      handle.client.track('friend_removed')
      handle.client.reportExposure({
        friends: [],
        gatherings: [],
        gravity: [{ channel: 'lirik', friendCount: 5, rank: 1 }],
      })
      await handle.flush()

      expect(handle.records().length).toBeGreaterThan(0)
      expect(fetchSpy).not.toHaveBeenCalled()
    } finally {
      globalThis.fetch = original
    }
  })

  it('clears the log without clearing the analytics state behind it', async () => {
    const handle = createTestLabClient({ world: preset('two').build(), appVersion: 'test' })
    await settle()
    handle.client.track('friend_removed')
    await handle.flush()
    expect(handle.records().length).toBeGreaterThan(0)

    handle.clearRecords()
    expect(handle.records()).toEqual([])

    // The session did not restart just because the inspector was tidied.
    handle.client.track('friend_removed')
    await settle()
    await handle.flush()
    const restarts = handle.records().filter((r) => r.label === 'authenticated_session_started')
    expect(restarts).toHaveLength(0)
  })
})

describe('JOIN runs the production path to the navigation boundary', () => {
  /*
   * The lab intercepts the LAST statement of joinChannel and nothing else, so
   * the guard above it - "a JOIN to where you already are goes nowhere" - is
   * the shipped one. Anything weaker would mean the JOIN under test was not
   * the JOIN that ships.
   */
  const onChannel = (path: string) => {
    ;(globalThis as Record<string, unknown>).window = {
      location: { pathname: path, assign: () => {
        throw new Error('the Test Lab must never reach a real navigation')
      } },
    }
  }

  it('is inert in any build that is not the Test Lab', async () => {
    vi.stubEnv('VITE_KICKBACK_MODE', 'production')
    const { joinChannel, setJoinNavigator } = await import('../../src/platforms/twitch/join')

    const seen: string[] = []
    setJoinNavigator((url) => seen.push(url))
    onChannel('/')

    // The slot was refused, so this falls through to the real navigation -
    // which the fixture makes fatal rather than silent.
    expect(() => joinChannel('lirik')).toThrow(/never reach a real navigation/)
    expect(seen).toEqual([])
    vi.unstubAllEnvs()
  })

  it('hands the real destination to the lab, and navigates nothing', async () => {
    vi.stubEnv('VITE_KICKBACK_MODE', 'test_lab')
    const { joinChannel, setJoinNavigator } = await import('../../src/platforms/twitch/join')

    const seen: string[] = []
    setJoinNavigator((url) => seen.push(url))
    onChannel('/')

    expect(joinChannel('LIRIK')).toBe(true)
    expect(seen).toEqual(['https://www.twitch.tv/LIRIK'])

    setJoinNavigator(null)
    vi.unstubAllEnvs()
  })

  it('still refuses a JOIN to the channel already being watched', async () => {
    vi.stubEnv('VITE_KICKBACK_MODE', 'test_lab')
    const { joinChannel, setJoinNavigator } = await import('../../src/platforms/twitch/join')

    const seen: string[] = []
    setJoinNavigator((url) => seen.push(url))
    onChannel('/lirik')

    // The production guard, unchanged - and case-insensitive, as it always was.
    expect(joinChannel('LIRIK')).toBe(false)
    expect(seen).toEqual([])

    setJoinNavigator(null)
    vi.unstubAllEnvs()
  })
})

describe('panel actions stay local', () => {
  it('applies a friend removal to the world instead of a server', async () => {
    let latest = preset('two').build()
    const handle = createTestLabClient({
      world: latest,
      appVersion: 'test',
      onWorldChange: (next) => {
        latest = next
      },
    })

    await handle.client.removeFriend(latest.users[0].id)

    expect(latest.users[0].relationship).toBe('stranger')
    expect(handle.client.getState().friends).toHaveLength(1)
  })

  it('refuses group writes rather than pretending to do them', async () => {
    const handle = createTestLabClient({ world: preset('two').build(), appVersion: 'test' })
    await expect(handle.client.createGroup('Nope')).rejects.toThrow(/not simulated/)
  })
})

beforeAll(() => {
  // The lab is only ever built by its own Vite config; nothing here should be
  // able to observe a test_lab environment by accident.
  expect(process.env.VITE_KICKBACK_MODE).not.toBe('test_lab')
})
