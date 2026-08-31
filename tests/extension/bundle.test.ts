import { createHash } from 'node:crypto'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join, sep } from 'node:path'
import { beforeAll, describe, expect, it } from 'vitest'

/**
 * Inspects the shipped artifact rather than the source.
 *
 * Two questions only the built bundle can answer: does a production build
 * really contain no mock people, and does it really contain no secrets?
 */

const DIST = join(process.cwd(), 'dist')
const CONTENT = join(DIST, 'kickback-content.js')
const BACKGROUND = join(DIST, 'kickback-background.js')
const MANIFEST = join(DIST, 'manifest.json')
const SRC = join(process.cwd(), 'src')

let content = ''
let background = ''
let manifest: Record<string, unknown> = {}

beforeAll(() => {
  if (!existsSync(CONTENT) || !existsSync(BACKGROUND)) {
    throw new Error('dist/ is missing or stale - run `npm run build` before the test suite')
  }
  content = readFileSync(CONTENT, 'utf8')
  background = readFileSync(BACKGROUND, 'utf8')
  manifest = JSON.parse(readFileSync(MANIFEST, 'utf8'))
})

describe('production bundle contains no simulated social data', () => {
  const DEMO_MARKERS = [
    'Sarah',
    'Jake',
    'Matt',
    'Nina',
    'Dave',
    'Kenji',
    'The Boys',
    'Late Night Crew',
    'jakethesnake',
    'DEMO_FOLLOWER',
    'MockPresenceService',
    'ROAM_CHANNELS',
  ]

  it.each(DEMO_MARKERS)('has no trace of %s', (marker) => {
    expect(content).not.toContain(marker)
    expect(background).not.toContain(marker)
  })

  it('carries no demo wording, not even unreachable', () => {
    // Gated behind a build-time constant, so the bundler drops the strings.
    // A production artifact should not merely never show demo wording.
    expect(content).not.toContain('demo mode')
    expect(content).not.toContain('DEMO')
  })

  it('does not ship the mock module at all', () => {
    expect(content).not.toMatch(/mockPresenceService/)
    expect(content).not.toMatch(/createDemoClient/)
  })
})

describe('no redirect-to-Friends workaround survives', () => {
  // The shipped panel must never again show an ACCEPT control that only tells
  // the user to go and do it somewhere else.
  it('ships no "open the Friends tab" instruction', () => {
    expect(content.toLowerCase()).not.toContain('open the friends tab')
  })
})

describe('production bundle contains no secrets', () => {
  const FORBIDDEN = [
    'service_role',
    'client_secret',
    'BEGIN PRIVATE KEY',
    'BEGIN RSA PRIVATE KEY',
    'postgres://',
    'postgresql://',
    'supabase_admin',
    // A Supabase secret key would start with this prefix.
    'sb_secret_2',
  ]

  it.each(FORBIDDEN)('does not contain %s', (needle) => {
    expect(content).not.toContain(needle)
    expect(background).not.toContain(needle)
  })

  it('carries no JWT-shaped literal', () => {
    // A service-role key is a JWT; a publishable key is not.
    const jwtLiteral = /eyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\./
    expect(jwtLiteral.test(content)).toBe(false)
    expect(jwtLiteral.test(background)).toBe(false)
  })
})

/** Reads a key out of .env.local without pulling in a dotenv dependency. */
function readEnvLocal(name: string): string | null {
  const envPath = join(process.cwd(), '.env.local')
  if (!existsSync(envPath)) return null
  for (const line of readFileSync(envPath, 'utf8').split(/\r?\n/)) {
    const trimmed = line.trim()
    if (trimmed.startsWith('#') || !trimmed.includes('=')) continue
    const separator = trimmed.indexOf('=')
    if (trimmed.slice(0, separator).trim() === name) return trimmed.slice(separator + 1).trim()
  }
  return null
}

describe('public configuration is where it should be', () => {
  it('keeps the publishable key out of the content script', () => {
    // The Twitch tab never talks to Supabase, so it needs no credentials.
    expect(content).not.toContain('sb_publishable_')
  })

  it('ships the publishable key in the service worker, by design', () => {
    expect(background).toContain('sb_publishable_')
    expect(background).toContain('.supabase.co')
  })

  /**
   * Detects a stale dist/ - a bundle built before the last edit to .env.local.
   *
   * It deliberately does NOT claim to detect a *wrong* key: if .env.local and
   * the bundle agree on a bad value, they still agree. Only Supabase can say
   * whether a key is real, which is what `npm run verify:config` is for.
   *
   * The comparison is on the whole literal rather than a substring, because a
   * key that is one character short still contains every prefix of itself.
   */
  it('bundles exactly the key currently configured in .env.local', () => {
    const configured = readEnvLocal('VITE_SUPABASE_PUBLISHABLE_KEY')
    if (!configured) {
      throw new Error('.env.local is missing - copy .env.example and fill it in before testing')
    }

    const bundled = background.match(/sb_publishable_[A-Za-z0-9_-]+/g) ?? []
    expect(bundled.length).toBeGreaterThan(0)

    for (const literal of new Set(bundled)) {
      expect(literal).toBe(configured)
      expect(literal.length).toBe(configured.length)
    }
  })

  it('points at the Supabase project configured in .env.local', () => {
    const configuredUrl = readEnvLocal('VITE_SUPABASE_URL')
    if (!configuredUrl) {
      throw new Error('.env.local is missing VITE_SUPABASE_URL')
    }
    expect(background).toContain(configuredUrl)
  })
})

describe('manifest', () => {
  it('pins the extension identity so the OAuth redirect URL is stable', () => {
    expect(typeof manifest.key).toBe('string')
    expect((manifest.key as string).length).toBeGreaterThan(300)
  })

  it('requests only the permissions it actually uses', () => {
    // notifications was added in Phase 2A for gathering alerts. No 'tabs':
    // chrome.tabs.create does not require it, and reading tab data would.
    expect(manifest.permissions).toEqual(['identity', 'storage', 'alarms', 'notifications'])
  })

  it('registers the service worker and the Twitch content script', () => {
    expect(manifest.background).toEqual({ service_worker: 'kickback-background.js' })
    const scripts = manifest.content_scripts as Array<{ js: string[]; matches: string[] }>
    expect(scripts[0].js).toEqual(['kickback-content.js'])
    expect(scripts[0].matches).toContain('https://www.twitch.tv/*')
  })

  it('requests host access only for Supabase and 7TV', () => {
    // 7TV was added in Phase 2B.1. Note what is NOT here: api.twitch.tv. Every
    // Twitch emote endpoint needs an OAuth token we have no safe way to hold,
    // so we do not ask for access we cannot use.
    expect(manifest.host_permissions).toEqual([
      'https://*.supabase.co/*',
      'https://7tv.io/*',
      'https://cdn.7tv.app/*',
    ])
  })
})

describe('the shipped identity and version', () => {
  /*
   * Kept as a literal rather than imported from scripts/extension-identity.mjs:
   * a test that reads its expectation from the thing under test proves nothing.
   * `npm run verify:store` scans every .ts and .md file for an ID that is not
   * ours, so a rotation cannot leave this one behind.
   */
  const EXPECTED_ID = 'ngfopkeokddfnncdhfkhnffilbdhkkip'

  /** Chrome derives an ID from the first 128 bits of SHA-256 over the key. */
  function extensionIdFromKey(base64Key: string): string {
    const hash = createHash('sha256').update(Buffer.from(base64Key, 'base64')).digest('hex')
    return [...hash.slice(0, 32)].map((c) => String.fromCharCode(parseInt(c, 16) + 97)).join('')
  }

  it('pins the extension ID the OAuth allow-list was configured for', () => {
    // If this ever changes, every tester's sign-in breaks with a redirect
    // mismatch, and the fix is a dashboard change rather than a code change.
    expect(extensionIdFromKey(manifest.key as string)).toBe(EXPECTED_ID)
  })

  it('agrees with package.json about the version', () => {
    const pkg = JSON.parse(readFileSync(join(process.cwd(), 'package.json'), 'utf8'))
    expect(manifest.version).toBe(pkg.version)
    expect(manifest.version).toMatch(/^\d+\.\d+\.\d+$/)
  })

  it('ships the version where a tester can read it back to me', () => {
    expect(content).toContain(manifest.version)
  })
})

describe('user-facing wording', () => {
  it('ships Profile rather than the older, wordier label', () => {
    // The action just opens somebody's Twitch profile; "View on Twitch" said
    // the same thing at three times the length.
    expect(content).toContain('Profile')
    expect(content).not.toContain('View on Twitch')
  })

  it('still ships JOIN, which means something else entirely', () => {
    expect(content).toContain('JOIN')
  })
})

describe('Watchside does not modify Twitch', () => {
  const CONTENT_SOURCE = () =>
    readdirSync(join(SRC, 'content'), { recursive: true, encoding: 'utf8' })
      .filter((entry) => entry.endsWith('.ts') || entry.endsWith('.tsx'))
      .map((entry) => readFileSync(join(SRC, 'content', entry), 'utf8'))
      .join('\n')

  it('appends exactly one host element and removes nothing', () => {
    const source = CONTENT_SOURCE()
    // The only mutation Watchside performs on the page is appending its own
    // host to <body>. Everything it renders lives inside that host's shadow
    // root, so no Twitch node is moved, wrapped, restyled or removed.
    expect(source).toContain('document.body.appendChild(host)')
    for (const destructive of ['removeChild', 'replaceChild', 'replaceWith', 'insertBefore']) {
      expect(source).not.toContain(destructive)
    }
  })

  it('never writes markup into the page', () => {
    const source = CONTENT_SOURCE()
    for (const forbidden of ['innerHTML', 'outerHTML', 'insertAdjacentHTML', 'document.write']) {
      expect(source).not.toContain(forbidden)
    }
  })

  it("does not attach itself inside Twitch's own layout", () => {
    const source = CONTENT_SOURCE()
    // Docking into the chat rail was investigated and deliberately not done;
    // this is the assertion that says so out loud.
    for (const selector of ['right-column', 'chat-room', 'channel-root', 'twilight-']) {
      expect(source).not.toContain(selector)
    }
  })

  it('lets pointer events through everywhere except the panel', () => {
    // The host covers the whole viewport, so if it accepted pointer events it
    // would swallow every click on Twitch.
    expect(content).toContain('pointer-events:none')
  })
})

describe('emote providers are reached only from the worker', () => {
  it('does not call 7TV from the Twitch page', () => {
    // Fetching from the content script would run on twitch.tv's origin and put
    // provider traffic inside the page. All of it belongs to the worker.
    expect(content).not.toContain('7tv.io')
    expect(background).toContain('7tv.io')
  })

  it('lets the page render provider images but never fetch from the provider', () => {
    // The CDN host appears in the content script only as a derived <img> src.
    expect(content).toContain('cdn.7tv.app/emote/')
  })

  it('never puts a Twitch provider token inside the Twitch page', () => {
    // The strongest form of the rule: the content script has no notion of a
    // provider token at all, so there is nothing for the page to reach.
    for (const needle of ['provider_token', 'provider_refresh_token', 'api.twitch.tv']) {
      expect(content).not.toContain(needle)
    }
  })

  it('makes no Twitch API calls from anywhere', () => {
    // Every Twitch emote endpoint requires an OAuth token that would require
    // the client secret to obtain and refresh. We do not call them at all.
    expect(background).not.toContain('api.twitch.tv')
    expect(background).not.toContain('Client-Id')
  })

  it('names a provider token in exactly one place, and only to delete it', () => {
    // This used to assert that NO file mentioned provider_token, reasoning that
    // "we never touch it". It passed for the entire time Watchside was writing a
    // live Twitch access token and refresh token to chrome.storage.local.
    //
    // Nothing here was touching the credential, and it was persisted anyway:
    // supabase-js serialises the whole session object, and the storage adapter
    // wrote whatever string it was handed. The credential reached the disk
    // without a single Watchside file naming it, so a grep that found nothing
    // was never evidence that it was not being stored. Only a real sign-in
    // showed it.
    //
    // The rule is now narrower and actually checkable: exactly one file may name
    // a provider credential, and its job is to remove it before anything is
    // written. What that file has to DO is pinned by
    // providerCredentialStripping.test.ts.
    const entries = readdirSync(SRC, { recursive: true, encoding: 'utf8' }).filter(
      (entry) => entry.endsWith('.ts') || entry.endsWith('.tsx'),
    )
    expect(entries.length).toBeGreaterThan(10)

    const naming = entries
      .filter((entry) => readFileSync(join(SRC, entry), 'utf8').includes('provider_token'))
      .map((entry) => entry.split(sep).join('/'))

    expect(naming).toEqual(['background/storage.ts'])
  })
})

/**
 * Analytics is compiled out of the demo build.
 *
 * Not merely configured off. The demo client's track/recordJoin/reportExposure
 * do nothing, the demo build never runs the service worker at all, and the
 * environment constant folds so the recorder is never constructed. This
 * inspects the artifact rather than trusting any of that.
 */
describe('the demo build sends no analytics', () => {
  const DEMO_DIST = join(process.cwd(), 'dist-demo')

  it('has no analytics RPC in the demo bundle', () => {
    if (!existsSync(join(DEMO_DIST, 'kickback-content.js'))) {
      throw new Error('dist-demo/ is missing or stale - run `npm run build:demo`')
    }
    const demoContent = readFileSync(join(DEMO_DIST, 'kickback-content.js'), 'utf8')
    // The content script is the whole of the demo build's Watchside: the worker
    // is never connected to, so nothing can reach the network from here.
    expect(demoContent).not.toContain('analytics_track')
  })

  it('names the analytics RPC exactly once in production, in the worker', () => {
    // The content script must never call it directly: the worker owns the
    // session, and a tab that could write analytics could write them as
    // whatever it liked.
    expect(content).not.toContain('analytics_track')
    expect(background).toContain('analytics_track')
  })
})

describe('the production bundle collects nothing it should not', () => {
  it('sends no property key outside the contract', () => {
    // The keys that would be a privacy failure if they ever appeared in an
    // analytics payload. `body` and `email` are common enough words that this
    // checks the analytics property vocabulary specifically.
    const forbidden = ['message_body', 'chat_body', 'access_token', 'refresh_token', 'friend_code']
    for (const key of forbidden) {
      expect(background).not.toContain(`"${key}"`)
    }
  })

  it('carries the version, so a tester on an old ZIP is identifiable', () => {
    const version = String((manifest as { version: string }).version)
    expect(background).toContain(version)
  })
})

/**
 * The worker-console diagnostics are actually in the shipped worker.
 *
 * This exists because a report once told the owner to run a command that
 * produced `ReferenceError: kickbackDestinations is not defined` - the build
 * they had loaded predated it. A diagnostic that is not in the artifact is
 * worse than none, because it costs a debugging session to discover.
 *
 * Asserted as a TOP-LEVEL assignment to globalThis, which is what makes the
 * command callable the moment the service worker starts, from the DevTools
 * console opened via chrome://extensions → Watchside → "service worker".
 */
describe('the worker console diagnostics ship', () => {
  const attached = (name: string) => background.includes(`globalThis.${name}=`)

  it('attaches the publisher diagnostic', () => {
    expect(attached('kickbackDestinations')).toBe(true)
  })

  it('attaches the observer diagnostic', () => {
    expect(attached('kickbackGravity')).toBe(true)
  })

  it('still attaches the ones that were already there', () => {
    expect(attached('kickbackMetadata')).toBe(true)
    expect(attached('kickbackSession')).toBe(true)
  })
})
