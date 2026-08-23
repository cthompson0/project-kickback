import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
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

  it('does not ship the mock module at all', () => {
    expect(content).not.toMatch(/mockPresenceService/)
    expect(content).not.toMatch(/createDemoClient/)
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

describe('public configuration is where it should be', () => {
  it('keeps the publishable key out of the content script', () => {
    // The Twitch tab never talks to Supabase, so it needs no credentials.
    expect(content).not.toContain('sb_publishable_')
  })

  it('ships the publishable key in the service worker, by design', () => {
    expect(background).toContain('sb_publishable_')
    expect(background).toContain('.supabase.co')
  })
})

describe('manifest', () => {
  it('pins the extension identity so the OAuth redirect URL is stable', () => {
    expect(typeof manifest.key).toBe('string')
    expect((manifest.key as string).length).toBeGreaterThan(300)
  })

  it('requests only the permissions authentication needs', () => {
    expect(manifest.permissions).toEqual(['identity', 'storage', 'alarms'])
  })

  it('registers the service worker and the Twitch content script', () => {
    expect(manifest.background).toEqual({ service_worker: 'kickback-background.js' })
    const scripts = manifest.content_scripts as Array<{ js: string[]; matches: string[] }>
    expect(scripts[0].js).toEqual(['kickback-content.js'])
    expect(scripts[0].matches).toContain('https://www.twitch.tv/*')
  })

  it('does not request host access beyond Supabase', () => {
    expect(manifest.host_permissions).toEqual(['https://*.supabase.co/*'])
  })
})
