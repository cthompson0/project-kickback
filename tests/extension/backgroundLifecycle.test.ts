import { existsSync, readFileSync } from 'node:fs'
import vm from 'node:vm'
import { describe, expect, it } from 'vitest'

/**
 * WS-F4-01: a fresh background evaluation must rebuild its local state.
 *
 * THE DEFECT THIS EXISTS FOR
 *
 * `src/background/index.ts` opened `runtime.onStartup(() => {` and, because a
 * later edit lost the closing brace, five `hydrate()` calls and the whole
 * diagnostics block were swallowed by the callback. `onStartup` fires only when
 * the BROWSER starts - never when an MV3 worker is revived, and never at all
 * for a temporarily-installed Firefox add-on. So a revived worker began with a
 * cold mute list, cold read watermarks and cold caches, and stayed that way.
 *
 * It survived since the first commit because nothing could see it: the worker
 * cannot be imported (it touches `chrome` at module scope), so no unit test
 * reached it, and the product still mostly worked because the server is the
 * source of truth for everything except those local caches.
 *
 * WHAT IS PROTECTED
 *
 *   fresh evaluation           -> local state hydrates, WITHOUT onStartup
 *   runtime.onStartup fires    -> startup work happens, and does not re-run
 *                                 or gate the normal initialisation
 *
 * TWO LAYERS, ON PURPOSE
 *
 * The behavioural test runs the REAL built bundle in a sandbox and watches
 * which storage keys it asks for - that is the invariant itself, and it fails
 * against the pre-fix bundle. It needs `dist/`, so it skips when the project
 * has not been built.
 *
 * The structural test parses the source and measures brace depth, so the
 * invariant is still guarded on a bare checkout. It is not a string match: a
 * `hydrate()` call nested anywhere inside any callback fails it, whatever the
 * callback is called.
 */

// ------------------------------------------------------------ the sandbox

const BUNDLE = 'dist/kickback-background.js'
const built = existsSync(BUNDLE)

const HYDRATION_KEYS = [
  'kickback:preferences',
  'kickback:attention:seen',
  'kickback:channelMetadata',
  'kickback:sessionTab',
  'kickback:mutedUsers',
  'kickback:groups:seen',
]

/**
 * Run the real background bundle against a fake browser.
 *
 * Deliberately hand-built rather than mocked: what the worker is allowed to
 * touch at evaluation time is exactly what this object offers, so a new
 * dependency appearing at startup fails loudly here instead of silently
 * working in one browser.
 */
function evaluateWorker() {
  const storageGets: unknown[] = []
  const listeners = new Map<string, (...args: unknown[]) => unknown>()
  const noop = () => {}
  const event = (name: string) => ({
    addListener: (fn: (...args: unknown[]) => unknown) => listeners.set(name, fn),
    removeListener: noop,
    hasListener: () => false,
  })

  const chrome = {
    storage: {
      local: {
        get: (keys: unknown) => {
          storageGets.push(keys)
          return Promise.resolve({})
        },
        set: () => Promise.resolve(),
        remove: () => Promise.resolve(),
      },
    },
    identity: {
      getRedirectURL: () => 'https://extension-id.chromiumapp.org/',
      launchWebAuthFlow: () => Promise.resolve(''),
    },
    notifications: {
      create: noop,
      clear: noop,
      onClicked: event('notifications.onClicked'),
      onButtonClicked: event('notifications.onButtonClicked'),
    },
    runtime: {
      getURL: (path: string) => `chrome-extension://extension-id/${path}`,
      connect: () => ({
        name: 'kickback',
        postMessage: noop,
        disconnect: noop,
        onMessage: event('port.onMessage'),
        onDisconnect: event('port.onDisconnect'),
      }),
      onConnect: event('runtime.onConnect'),
      onStartup: event('runtime.onStartup'),
      onInstalled: event('runtime.onInstalled'),
    },
    alarms: { create: noop, onAlarm: event('alarms.onAlarm') },
    tabs: { create: noop },
  }

  const sandbox: Record<string, unknown> = {
    chrome,
    console: { log: noop, info: noop, warn: noop, error: noop, debug: noop },
    fetch: () =>
      Promise.resolve({
        ok: true,
        status: 200,
        json: () => Promise.resolve({}),
        text: () => Promise.resolve(''),
      }),
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    crypto: globalThis.crypto,
    TextEncoder,
    TextDecoder,
    URL,
    URLSearchParams,
    AbortController,
    Response,
    Request,
    Headers,
    performance,
    navigator: { onLine: true, userAgent: 'vitest' },
    location: { href: 'chrome-extension://extension-id/' },
    // Supabase realtime constructs one lazily; it must exist, not connect.
    WebSocket: class {
      addListener = noop
      addEventListener = noop
      close = noop
      send = noop
    },
  }
  sandbox.globalThis = sandbox
  sandbox.self = sandbox
  sandbox.window = sandbox

  vm.createContext(sandbox)
  vm.runInContext(readFileSync(BUNDLE, 'utf8'), sandbox, { timeout: 20_000 })

  const asked = (key: string) =>
    storageGets.some((entry) =>
      Array.isArray(entry) ? entry.includes(key) : entry === key,
    )

  return { storageGets, listeners, sandbox, asked }
}

// =========================================== the invariant, behaviourally

describe.runIf(built)('a fresh background evaluation rebuilds its local state', () => {
  /**
   * The heart of it. Every one of these keys was NOT read at evaluation before
   * the fix - only the auth session and the channel-name cache were - so this
   * assertion fails against the pre-fix bundle.
   */
  it('hydrates every local cache without runtime.onStartup ever firing', () => {
    const { asked, listeners } = evaluateWorker()

    // Nothing fired the event. This is a plain module evaluation, which is
    // exactly what a revived worker performs.
    expect(listeners.has('runtime.onStartup')).toBe(true)

    for (const key of HYDRATION_KEYS) {
      expect(asked(key), `${key} was never read at evaluation`).toBe(true)
    }
  })

  it('reads the auth session at evaluation, so a revival can restore it', () => {
    const { storageGets } = evaluateWorker()
    const flat = storageGets.flatMap((entry) => (Array.isArray(entry) ? entry : [entry]))
    expect(flat.some((key) => typeof key === 'string' && /^sb-.*-auth-token$/.test(key))).toBe(
      true,
    )
  })

  /**
   * The other half of the invariant: startup work still happens, and does not
   * duplicate the initialisation that evaluation already did.
   */
  it('leaves runtime.onStartup doing startup work only', async () => {
    const { listeners, storageGets, asked } = evaluateWorker()
    expect(asked('kickback:preferences')).toBe(true)

    const before = storageGets.length
    const onStartup = listeners.get('runtime.onStartup')
    expect(onStartup).toBeTypeOf('function')

    onStartup?.()
    await Promise.resolve()

    const added = storageGets
      .slice(before)
      .flatMap((entry) => (Array.isArray(entry) ? entry : [entry]))

    // It may re-read the session - auth.initialize() is what it holds. It must
    // not re-run the cache hydration, which evaluation already did.
    for (const key of HYDRATION_KEYS) {
      expect(added, `onStartup re-hydrated ${key}`).not.toContain(key)
    }
  })

  it('still registers every listener a revived worker needs', () => {
    const { listeners } = evaluateWorker()
    for (const name of [
      'runtime.onConnect',
      'runtime.onStartup',
      'runtime.onInstalled',
      'alarms.onAlarm',
      'notifications.onClicked',
      'notifications.onButtonClicked',
    ]) {
      expect(listeners.has(name), `${name} was not registered`).toBe(true)
    }
  })

  /**
   * The diagnostics were the symptom that exposed WS-F4-01: they are assigned
   * in the same block, so they were unreachable on any browser that had not
   * been restarted since install. A console helper nobody can call is worse
   * than none, because it is believed to exist.
   */
  it('attaches the worker diagnostics at evaluation', () => {
    const { sandbox } = evaluateWorker()
    for (const name of ['kickbackDestinations', 'kickbackGravity', 'kickbackMetadata']) {
      expect(typeof sandbox[name], `${name} is not attached`).toBe('object')
    }
  })

  it('registers exactly one alarm and one connect listener', () => {
    const { listeners } = evaluateWorker()
    // A Map cannot hold duplicates, so this guards the shape rather than the
    // count - the real risk a lifecycle change carries is registering a
    // listener inside a callback that can fire more than once.
    expect(listeners.size).toBeGreaterThanOrEqual(6)
  })
})

// ============================================ the invariant, structurally

describe('the worker hydrates at module scope', () => {
  const SOURCE = readFileSync('src/background/index.ts', 'utf8')

  /**
   * Brace depth, computed properly - strings, template literals, and both
   * comment forms are skipped, so a brace inside a string cannot fool it.
   *
   * Returns the nesting depth at the START of each line.
   */
  function depths(source: string): number[] {
    const lines = source.split(/\r?\n/)
    const out: number[] = []
    let depth = 0
    let inBlockComment = false
    let inString: string | null = null

    for (const line of lines) {
      out.push(depth)
      for (let i = 0; i < line.length; i += 1) {
        const c = line[i]
        const next = line[i + 1]

        if (inBlockComment) {
          if (c === '*' && next === '/') {
            inBlockComment = false
            i += 1
          }
          continue
        }
        if (inString) {
          if (c === '\\') i += 1
          else if (c === inString) inString = null
          continue
        }
        if (c === '/' && next === '*') {
          inBlockComment = true
          i += 1
          continue
        }
        if (c === '/' && next === '/') break
        if (c === '"' || c === "'" || c === '`') {
          inString = c
          continue
        }
        if (c === '{' || c === '(' || c === '[') depth += 1
        if (c === '}' || c === ')' || c === ']') depth -= 1
      }
    }
    return out
  }

  const lines = SOURCE.split(/\r?\n/)
  const depth = depths(SOURCE)

  it('balances its braces, so the measurement below means something', () => {
    expect(depth[depth.length - 1]).toBe(0)
  })

  /**
   * The defect in one assertion. Before the fix these sat at depth 1, inside
   * the onStartup callback.
   */
  it.each([
    'preferences.hydrate()',
    'attention.hydrate()',
    'metadata.hydrate()',
    'sessionTab.hydrate()',
    'groups.hydrate()',
  ])('calls %s at module scope, not inside a callback', (call) => {
    const index = lines.findIndex((line) => line.includes(call) && !line.trim().startsWith('*'))
    expect(index, `${call} not found`).toBeGreaterThan(-1)
    expect(depth[index], `${call} is nested ${depth[index]} deep`).toBe(0)
  })

  it('attaches the diagnostics at module scope', () => {
    const index = lines.findIndex((line) => line.includes('if (METADATA_DIAGNOSTICS) {'))
    expect(index).toBeGreaterThan(-1)
    expect(depth[index]).toBe(0)
  })

  /**
   * The startup hook keeps only what belongs to browser startup. Anything else
   * appearing between its braces is the same mistake happening again.
   */
  it('keeps runtime.onStartup down to startup work', () => {
    const open = lines.findIndex((line) => line.includes('ext.runtime.onStartup(() => {'))
    expect(open).toBeGreaterThan(-1)

    // The first line whose starting depth is back to the opener's. The line
    // before it is the `})` that closes the callback, so the body stops there.
    let close = open + 1
    while (close < lines.length && depth[close] > depth[open]) close += 1

    const body = lines
      .slice(open + 1, close - 1)
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith('//') && !line.startsWith('*'))

    expect(body).toEqual(['void auth.initialize()'])
  })

  it('initialises auth at module scope too, so a revival restores the session', () => {
    const moduleLevel = lines
      .map((line, i) => ({ line: line.trim(), d: depth[i] }))
      .filter((entry) => entry.d === 0 && entry.line === 'void auth.initialize()')
    expect(moduleLevel.length).toBe(1)
  })
})
