import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createChromiumApi } from '../../src/platforms/browser/chromium'
import { createGeckoApi } from '../../src/platforms/browser/gecko'
import {
  GECKO_DATA_COLLECTION,
  GECKO_ID,
  GECKO_MIN_VERSION,
  manifestFor,
} from '../../scripts/manifest.mjs'
import type { BrowserExtensionApi, ExtensionNotificationOptions } from '../../src/platforms/browser/types'

/**
 * The browser boundary.
 *
 * Watchside has to run on two engines that agree about almost everything and
 * disagree about a few things that matter. This file is where those few things
 * are pinned, because they are exactly the differences that unit tests
 * elsewhere cannot see: the product code below the adapter never learns which
 * browser it is on, which is the point of the adapter and also the reason
 * nothing else here can catch a mistake in it.
 *
 * Three questions, and nothing else:
 *
 *   1. does each adapter delegate to its own engine, unchanged?
 *   2. do they differ ONLY where the investigation said they must?
 *   3. does the Chromium manifest survive the introduction of a Firefox one?
 */

// ------------------------------------------------------------------ harness

/**
 * A recording stand-in for an engine global.
 *
 * Built by hand rather than with a mocking library so the SHAPE of what each
 * engine is expected to expose is written down here in full. If an adapter
 * reaches for something outside this, the test fails by throwing rather than
 * by silently recording nothing.
 */
function fakeEngine() {
  const calls: Array<[string, ...unknown[]]> = []
  const record =
    (name: string, result?: unknown) =>
    (...args: unknown[]) => {
      calls.push([name, ...args])
      return result
    }

  return {
    calls,
    api: {
      storage: {
        local: {
          get: record('storage.get', Promise.resolve({ k: 'v' })),
          set: record('storage.set', Promise.resolve()),
          remove: record('storage.remove', Promise.resolve()),
        },
      },
      identity: {
        getRedirectURL: record('identity.getRedirectURL', 'https://redirect.example/'),
        launchWebAuthFlow: record(
          'identity.launchWebAuthFlow',
          Promise.resolve('https://redirect.example/#token'),
        ),
      },
      notifications: {
        create: record('notifications.create', Promise.resolve('id')),
        clear: record('notifications.clear', Promise.resolve(true)),
        onClicked: { addListener: record('notifications.onClicked') },
        onButtonClicked: { addListener: record('notifications.onButtonClicked') },
      },
      runtime: {
        getURL: record('runtime.getURL', 'chrome-extension://x/icons/icon-128.png'),
        connect: record('runtime.connect', { name: 'watchside' }),
        onConnect: { addListener: record('runtime.onConnect') },
        onStartup: { addListener: record('runtime.onStartup') },
        onInstalled: { addListener: record('runtime.onInstalled') },
      },
      alarms: {
        create: record('alarms.create'),
        onAlarm: { addListener: record('alarms.onAlarm') },
      },
      tabs: { create: record('tabs.create', Promise.resolve({})) },
    },
  }
}

const NOTIFICATION: ExtensionNotificationOptions = {
  type: 'basic',
  iconUrl: 'icons/icon-128.png',
  title: 'Alice and Bob on Twitch',
  message: 'Watching LIRIK',
  buttons: [{ title: 'Join them' }],
}

type Engine = ReturnType<typeof fakeEngine>

let engine: Engine

beforeEach(() => {
  engine = fakeEngine()
})

afterEach(() => {
  Reflect.deleteProperty(globalThis, 'chrome')
  Reflect.deleteProperty(globalThis, 'browser')
  vi.restoreAllMocks()
})

function withChromium(): BrowserExtensionApi {
  ;(globalThis as Record<string, unknown>).chrome = engine.api
  return createChromiumApi()
}

function withGecko(): BrowserExtensionApi {
  ;(globalThis as Record<string, unknown>).browser = engine.api
  return createGeckoApi()
}

const named = (name: string) => engine.calls.filter(([call]) => call === name)

// ============================================================== the contract
//
// Both adapters answer the same interface. These run against each in turn, so
// a member added to one engine and forgotten on the other is a failure rather
// than a surprise in a browser.

describe.each([
  ['chromium', withChromium],
  ['gecko', withGecko],
])('%s adapter', (_engineName, build) => {
  it('exposes every namespace the product uses', () => {
    const api = build()
    expect(Object.keys(api).sort()).toEqual([
      'alarms',
      'identity',
      'notifications',
      'runtime',
      'storage',
      'tabs',
    ])
  })

  // ------------------------------------------------------------- storage

  it('delegates storage to its own engine', async () => {
    const api = build()

    await api.storage.get('kickback:preferences')
    await api.storage.set({ 'kickback:preferences': { theme: 'dark' } })
    await api.storage.remove('kickback:preferences')

    expect(named('storage.get')[0]).toEqual(['storage.get', 'kickback:preferences'])
    expect(named('storage.set')[0]).toEqual([
      'storage.set',
      { 'kickback:preferences': { theme: 'dark' } },
    ])
    expect(named('storage.remove')[0]).toEqual(['storage.remove', 'kickback:preferences'])
  })

  /**
   * The reason the adapter exists at all: storage must be awaitable. A
   * callback-shaped namespace returns undefined here, and `undefined` is what
   * a caller would then await - silently, forever getting nothing.
   */
  it('returns a promise from storage rather than undefined', async () => {
    const api = build()
    const pending = api.storage.get('k')
    expect(pending).toBeInstanceOf(Promise)
    await expect(pending).resolves.toEqual({ k: 'v' })
  })

  it('preserves the internal key vocabulary verbatim', async () => {
    // The kickback: prefix is a compatibility contract, not branding. An
    // adapter that normalised or namespaced keys would strand every existing
    // install's preferences, mutes and read positions.
    const api = build()
    await api.storage.get('kickback:sessionTab')
    expect(named('storage.get')[0][1]).toBe('kickback:sessionTab')
  })

  // ------------------------------------------------------------ identity

  it('delegates identity to its own engine', async () => {
    const api = build()

    expect(api.identity.getRedirectURL()).toBe('https://redirect.example/')
    await expect(api.identity.launchWebAuthFlow('https://twitch.example/authorize')).resolves.toBe(
      'https://redirect.example/#token',
    )

    expect(named('identity.getRedirectURL')).toHaveLength(1)
    expect(named('identity.launchWebAuthFlow')[0][1]).toEqual({
      url: 'https://twitch.example/authorize',
      interactive: true,
    })
  })

  /**
   * The redirect URL is never constructed by Watchside, only asked for. Both
   * engines derive it from the extension id, and they derive DIFFERENT URLs -
   * so a hand-built one would be wrong on at least one engine and would drift
   * from whatever is registered with Supabase.
   */
  it('asks the engine for the redirect URL rather than building one', () => {
    const api = build()
    api.identity.getRedirectURL()
    expect(named('identity.getRedirectURL')).toHaveLength(1)
  })

  it('rejects when the sign-in window closes without a result', async () => {
    ;(engine.api.identity.launchWebAuthFlow as unknown as () => unknown) = () =>
      Promise.resolve('')
    const api = build()
    await expect(api.identity.launchWebAuthFlow('https://twitch.example/')).rejects.toThrow(
      'Sign-in window closed',
    )
  })

  // ------------------------------------------------------------- runtime

  it('delegates runtime to its own engine', () => {
    const api = build()

    expect(api.runtime.getURL('icons/icon-128.png')).toBe(
      'chrome-extension://x/icons/icon-128.png',
    )
    api.runtime.connect('watchside')
    api.runtime.onConnect(() => {})
    api.runtime.onStartup(() => {})
    api.runtime.onInstalled(() => {})

    expect(named('runtime.connect')[0][1]).toEqual({ name: 'watchside' })
    expect(named('runtime.onConnect')).toHaveLength(1)
    expect(named('runtime.onStartup')).toHaveLength(1)
    expect(named('runtime.onInstalled')).toHaveLength(1)
  })

  /**
   * The port object IS the tab key - the background stores ports in a Set and
   * names them through a WeakMap, which is how Watchside tracks tabs without
   * the `tabs` permission. An adapter that wrapped the port would put a new
   * object between that invariant and the truth.
   */
  it('hands back the engine port itself, not a wrapper', () => {
    const api = build()
    const fromAdapter = api.runtime.connect('watchside')
    const fromEngine = engine.api.runtime.connect('watchside')
    expect(fromAdapter).toBe(fromEngine)
  })

  /** Same reason: the object the background stores must be the engine's own. */
  it('hands the engine port straight to an onConnect handler', () => {
    const api = build()
    const seen: unknown[] = []
    api.runtime.onConnect((port) => seen.push(port))

    const registered = named('runtime.onConnect')[0][1] as (port: unknown) => void
    const enginePort = { name: 'watchside' }
    registered(enginePort)

    expect(seen).toHaveLength(1)
    expect(seen[0]).toBe(enginePort)
  })

  // -------------------------------------------------------------- alarms

  it('delegates alarms and passes only the alarm name onward', () => {
    const api = build()
    api.alarms.create('kickback:refresh-session', { periodInMinutes: 30 })

    const seen: string[] = []
    api.alarms.onAlarm((name) => seen.push(name))

    expect(named('alarms.create')[0]).toEqual([
      'alarms.create',
      'kickback:refresh-session',
      { periodInMinutes: 30 },
    ])

    // Fire the listener the adapter registered, as the engine would.
    const listener = named('alarms.onAlarm')[0][1] as (alarm: { name: string }) => void
    listener({ name: 'kickback:refresh-session' })
    expect(seen).toEqual(['kickback:refresh-session'])
  })

  // ---------------------------------------------------------------- tabs

  it('opens a tab by URL', () => {
    const api = build()
    api.tabs.create('https://www.twitch.tv/lirik')
    expect(named('tabs.create')[0][1]).toEqual({ url: 'https://www.twitch.tv/lirik' })
  })

  // ------------------------------------------------------- notifications

  it('passes the id, title and message through unchanged', () => {
    const api = build()
    api.notifications.create('kickback:gathering:lirik', NOTIFICATION)

    const [, id, options] = named('notifications.create')[0] as [
      string,
      string,
      Record<string, unknown>,
    ]
    expect(id).toBe('kickback:gathering:lirik')
    expect(options.type).toBe('basic')
    expect(options.title).toBe('Alice and Bob on Twitch')
    expect(options.message).toBe('Watching LIRIK')
    expect(options.iconUrl).toBe('icons/icon-128.png')
  })

  it('clears a notification by id', () => {
    const api = build()
    api.notifications.clear('kickback:gathering:lirik')
    expect(named('notifications.clear')[0][1]).toBe('kickback:gathering:lirik')
  })

  it('registers a click handler', () => {
    const api = build()
    api.notifications.onClicked(() => {})
    expect(named('notifications.onClicked')).toHaveLength(1)
  })

  /** Total contract: accepting the handler must never throw on either engine. */
  it('accepts a button handler without throwing', () => {
    const api = build()
    expect(() => api.notifications.onButtonClicked(() => {})).not.toThrow()
  })
})

// ================================================ where the engines diverge
//
// Everything above proves the two adapters agree. This is the short list of
// places they must NOT - and it is short on purpose.

describe('the engines differ only where they must', () => {
  it('keeps notification buttons on Chromium', () => {
    const api = withChromium()
    api.notifications.create('kickback:gathering:lirik', NOTIFICATION)

    const options = named('notifications.create')[0][2] as Record<string, unknown>
    expect(options.buttons).toEqual([{ title: 'Join them' }])
  })

  /**
   * Firefox supports only type, title, message and iconUrl. It does not ignore
   * the extras - `buttons` fails schema validation and the whole notification
   * is lost - so this is the difference between a notification and none.
   */
  it('strips notification buttons on Gecko', () => {
    const api = withGecko()
    api.notifications.create('kickback:gathering:lirik', NOTIFICATION)

    const options = named('notifications.create')[0][2] as Record<string, unknown>
    expect(options).not.toHaveProperty('buttons')
    expect(Object.keys(options).sort()).toEqual(['iconUrl', 'message', 'title', 'type'])
  })

  /**
   * Built by naming the survivors rather than deleting the extras, so a field
   * added to the options type later cannot reach Firefox by being forgotten.
   */
  it('sends Gecko nothing beyond the four fields it supports', () => {
    const api = withGecko()
    api.notifications.create('id', {
      ...NOTIFICATION,
      silent: true,
    } as ExtensionNotificationOptions)

    const options = named('notifications.create')[0][2] as Record<string, unknown>
    expect(Object.keys(options).sort()).toEqual(['iconUrl', 'message', 'title', 'type'])
  })

  it('never delivers a button click on Gecko', () => {
    const api = withGecko()
    let fired = 0
    api.notifications.onButtonClicked(() => {
      fired += 1
    })
    // Nothing is registered with the engine, so nothing can ever call it.
    expect(named('notifications.onButtonClicked')).toHaveLength(0)
    expect(fired).toBe(0)
  })

  it('registers a real button listener on Chromium', () => {
    const api = withChromium()
    api.notifications.onButtonClicked(() => {})
    expect(named('notifications.onButtonClicked')).toHaveLength(1)
  })

  it('reads the Chromium namespace, never the Gecko one', () => {
    withChromium()
    expect((globalThis as Record<string, unknown>).browser).toBeUndefined()
  })

  it('reads the Gecko namespace, never the Chromium one', () => {
    withGecko()
    expect((globalThis as Record<string, unknown>).chrome).toBeUndefined()
  })
})

// ================================================== the manifest transform

describe('the manifest transform', () => {
  const SOURCE = JSON.parse(readFileSync('public/manifest.json', 'utf8'))

  // ------------------------------------------------ Chromium is untouched

  describe('leaves Chromium exactly as it was', () => {
    it('returns the source manifest unchanged', () => {
      expect(manifestFor('chromium', SOURCE)).toEqual(SOURCE)
    })

    it('does not mutate the source it was given', () => {
      const before = JSON.stringify(SOURCE)
      manifestFor('gecko', SOURCE)
      expect(JSON.stringify(SOURCE)).toBe(before)
    })

    /**
     * The permanent Chrome Web Store identity. This is the one value in the
     * repository that cannot change without orphaning every existing install.
     */
    it('keeps the permanent Chromium extension id', () => {
      expect(SOURCE.key).toMatch(/^MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8A/)
      expect(manifestFor('chromium', SOURCE).key).toBe(SOURCE.key)
    })

    it('keeps the service worker background', () => {
      expect(manifestFor('chromium', SOURCE).background).toEqual({
        service_worker: 'kickback-background.js',
      })
    })

    it('adds no Gecko settings', () => {
      expect(manifestFor('chromium', SOURCE)).not.toHaveProperty('browser_specific_settings')
    })
  })

  // ------------------------------------------- permissions are never moved

  describe('never changes what is asked of the user', () => {
    const PERMISSIONS = ['identity', 'storage', 'alarms', 'notifications']
    const HOSTS = [
      'https://*.supabase.co/*',
      'https://7tv.io/*',
    ]

    it('pins the Chromium permissions', () => {
      expect(SOURCE.permissions).toEqual(PERMISSIONS)
      expect(manifestFor('chromium', SOURCE).permissions).toEqual(PERMISSIONS)
    })

    it('pins the Chromium host permissions', () => {
      expect(SOURCE.host_permissions).toEqual(HOSTS)
      expect(manifestFor('chromium', SOURCE).host_permissions).toEqual(HOSTS)
    })

    /**
     * A second engine is not a reason to ask for more. If Firefox ever needs a
     * permission Chrome does not, that is a product decision with a review
     * consequence - not something a transform does quietly.
     */
    it('asks Firefox for exactly the same permissions', () => {
      const gecko = manifestFor('gecko', SOURCE)
      expect(gecko.permissions).toEqual(PERMISSIONS)
      expect(gecko.host_permissions).toEqual(HOSTS)
    })

    it('injects the panel into the same places', () => {
      expect(manifestFor('gecko', SOURCE).content_scripts).toEqual(SOURCE.content_scripts)
    })
  })

  // ------------------------------------------------- the Gecko difference

  describe('adds only the intended Gecko differences', () => {
    const gecko = () => manifestFor('gecko', SOURCE)

    it('drops the Chromium key, which means nothing to Firefox', () => {
      expect(gecko()).not.toHaveProperty('key')
    })

    /** Firefox runs an event page; background.service_worker is not implemented. */
    it('replaces the service worker with an event page', () => {
      expect(gecko().background).toEqual({ scripts: ['kickback-background.js'] })
    })

    it('runs the same background script, not a Firefox variant', () => {
      expect((gecko().background as { scripts: string[] }).scripts[0]).toBe(
        (SOURCE.background as { service_worker: string }).service_worker,
      )
    })

    /**
     * The Gecko redirect URL is derived from this id, so a change here moves
     * the OAuth redirect underneath whatever Supabase has been told to accept.
     */
    it('pins the permanent Gecko id', () => {
      expect(GECKO_ID).toBe('watchside@anoteros-labs.com')
      expect(gecko().browser_specific_settings).toEqual({
        gecko: {
          id: GECKO_ID,
          strict_min_version: GECKO_MIN_VERSION,
          data_collection_permissions: GECKO_DATA_COLLECTION,
        },
      })
    })

    /*
     * The floor moved from 128 to 140 in F6, and both numbers had the same
     * reason: the CURRENT ESR. Firefox 128 ESR went out of support on
     * 16 September 2025, so it had stopped being the conservative choice and
     * become a dead one. 140 is also where `data_collection_permissions` was
     * introduced - below it the disclosure above exists in the manifest and is
     * never shown to anybody at install.
     */
    it('will not install below the current Firefox ESR', () => {
      expect(GECKO_MIN_VERSION).toBe('140.0')
      // 140 for the consent UI; still comfortably above 127, where MV3 host
      // permissions began being granted at install rather than by opt-in.
      expect(Number.parseInt(GECKO_MIN_VERSION, 10)).toBeGreaterThanOrEqual(140)
    })

    it('stays Manifest V3', () => {
      expect(gecko().manifest_version).toBe(3)
    })

    it('keeps the name, version, icons and action identical', () => {
      const g = gecko()
      expect(g.name).toBe(SOURCE.name)
      expect(g.version).toBe(SOURCE.version)
      expect(g.icons).toEqual(SOURCE.icons)
      expect(g.action).toEqual(SOURCE.action)
    })

    /** Exactly three keys move. Anything else is an accident. */
    it('changes nothing else', () => {
      const g = gecko()
      const changed = new Set(['key', 'background', 'browser_specific_settings'])
      for (const key of Object.keys(SOURCE)) {
        if (changed.has(key)) continue
        expect(g[key]).toEqual(SOURCE[key])
      }
      for (const key of Object.keys(g)) {
        if (changed.has(key)) continue
        expect(Object.hasOwn(SOURCE, key)).toBe(true)
      }
    })
  })

  it('refuses a target it does not know', () => {
    expect(() => manifestFor('safari', SOURCE)).toThrow(/Unknown browser target/)
  })
})

// ============================================ what actually reaches a bundle
//
// Everything above tests source. This tests the artefact, because the claim
// being made - that neither package ships the other engine's adapter, and that
// the content script does not carry background-only APIs - is a claim about
// what the bundler did, not about what the source says.

describe('the built Chromium bundles', () => {
  const DIST = 'dist'
  const CONTENT = join(DIST, 'kickback-content.js')
  const BACKGROUND = join(DIST, 'kickback-background.js')
  const built = existsSync(CONTENT) && existsSync(BACKGROUND)

  const read = (path: string) => readFileSync(path, 'utf8')

  it.runIf(built)('ship no Gecko adapter at all', () => {
    for (const path of [CONTENT, BACKGROUND]) {
      // `browser.*` member access cannot be renamed by a minifier, so its
      // absence is real rather than cosmetic.
      expect(read(path)).not.toMatch(
        /browser\.(storage|identity|notifications|alarms|tabs|runtime)\./,
      )
    }
  })

  /**
   * The content script opens a port and nothing else. It has no business
   * carrying identity, notifications, alarms, tabs or storage code, and before
   * the namespaces were exported separately it did.
   */
  it.runIf(built)('keep background-only APIs out of the content script', () => {
    const content = read(CONTENT)
    for (const namespace of ['storage', 'identity', 'notifications', 'alarms', 'tabs']) {
      expect(content).not.toContain(`chrome.${namespace}.`)
    }
  })

  it.runIf(built)('still reach every API the background needs', () => {
    const background = read(BACKGROUND)
    for (const call of [
      'chrome.storage.local.get',
      'chrome.storage.local.set',
      'chrome.storage.local.remove',
      'chrome.identity.getRedirectURL',
      'chrome.identity.launchWebAuthFlow',
      'chrome.notifications.create',
      'chrome.notifications.onClicked.addListener',
      'chrome.notifications.onButtonClicked.addListener',
      'chrome.runtime.onConnect.addListener',
      'chrome.alarms.create',
      'chrome.tabs.create',
    ]) {
      expect(background).toContain(call)
    }
  })

  it.runIf(built)('still open the port from the content script', () => {
    expect(read(CONTENT)).toContain('chrome.runtime.connect')
  })
})
