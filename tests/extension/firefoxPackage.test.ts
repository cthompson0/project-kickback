import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  DEMO_MARKERS,
  FORBIDDEN_CONTENT,
  FORBIDDEN_PATHS,
  RUNTIME_FILES,
  createScanner,
} from '../../scripts/package-shared.mjs'
import { GECKO_ID, GECKO_MIN_VERSION, manifestFor } from '../../scripts/manifest.mjs'
import { EXPECTED_EXTENSION_ID } from '../../scripts/extension-identity.mjs'

/**
 * The Firefox package, and the promise that it costs Chrome nothing.
 *
 * tests/extension/browserAdapter.test.ts already pins the manifest TRANSFORM.
 * What is left, and what this file covers, is the packaging around it: that the
 * safety net both engines rely on is genuinely one thing rather than two copies
 * that will drift, and that the artifact on disk - when there is one - is the
 * artifact the repository describes.
 *
 * The artifact tests skip when dist-firefox/ is absent, because `npm test` must
 * not require a packaging run. verify:firefox is the gate that insists.
 */

const PACKAGE = join('dist-firefox', 'package')
const built = existsSync(join(PACKAGE, 'manifest.json'))

// ============================================ one safety net, not two copies

describe('the packaging safety net is shared', () => {
  /**
   * The whole reason package-shared.mjs exists. Two copies of an allow-list
   * eventually disagree, and the copy that fell behind is the one that lets
   * something through.
   */
  it('is defined once, and package-beta.mjs imports it', () => {
    const beta = readFileSync('scripts/package-beta.mjs', 'utf8')
    const firefox = readFileSync('scripts/package-firefox.mjs', 'utf8')

    expect(beta).toContain("from './package-shared.mjs'")
    expect(firefox).toContain("from './package-shared.mjs'")

    // Neither packager may keep a private copy of the rules.
    for (const source of [beta, firefox]) {
      expect(source).not.toContain('const RUNTIME_FILES =')
      expect(source).not.toContain('const FORBIDDEN_PATHS =')
      expect(source).not.toContain('const FORBIDDEN_CONTENT =')
      expect(source).not.toContain('const DEMO_MARKERS =')
    }
  })

  it('still allows exactly the runtime files Chrome ships', () => {
    expect([...RUNTIME_FILES].sort()).toEqual([
      'icons/icon-128.png',
      'icons/icon-16.png',
      'icons/icon-32.png',
      'icons/icon-48.png',
      'kickback-background.js',
      'kickback-content.js',
      'manifest.json',
      'popup.html',
    ])
  })

  it('still refuses the paths that must never ship', () => {
    for (const forbidden of ['.env', '.pem', '.map', 'node_modules', 'src/', 'supabase/']) {
      expect(FORBIDDEN_PATHS).toContain(forbidden)
    }
  })

  it('still hunts for the same secrets and demo markers', () => {
    const labels = FORBIDDEN_CONTENT.map((rule) => rule.label)
    expect(labels).toContain('a Supabase secret key')
    expect(labels).toContain('the service-role role')
    expect(labels).toContain('a private key block')
    expect(DEMO_MARKERS).toContain('createDemoClient')
    expect(DEMO_MARKERS).toContain('mockPresenceService')
  })

  /** The scanners must report through the caller, not a shared global. */
  it('reports to whichever packager called it', () => {
    const mine: string[] = []
    const yours: string[] = []
    const a = createScanner((m: string) => mine.push(m))
    const b = createScanner((m: string) => yours.push(m))

    a.checkPaths(['src/secret.ts'], 'a')
    expect(mine).toHaveLength(1)
    expect(yours).toHaveLength(0)

    b.checkPaths(['node_modules/x'], 'b')
    expect(mine).toHaveLength(1)
    expect(yours).toHaveLength(1)
  })
})

// ================================================= what the packager promises

describe('the Firefox packager', () => {
  const SOURCE = readFileSync('scripts/package-firefox.mjs', 'utf8')

  it('derives its manifest rather than carrying one', () => {
    expect(SOURCE).toContain("manifestFor('gecko'")
    expect(existsSync('public/manifest.firefox.json')).toBe(false)
    expect(existsSync('manifest.firefox.json')).toBe(false)
  })

  /**
   * Firefox needs bundles built with WATCHSIDE_BROWSER=gecko. Building them
   * into dist/ would replace the Chromium output that the Chrome Web Store
   * package is made from.
   */
  it('builds into its own directory, never dist/', () => {
    expect(SOURCE).toContain("const DIST = 'dist-firefox'")
    expect(SOURCE).toContain("WATCHSIDE_BROWSER: 'gecko'")
    expect(SOURCE).toContain('WATCHSIDE_OUT_DIR: DIST')
  })

  /** A Firefox archive built from Chromium bundles installs and then fails silently. */
  it('refuses a package that is not built for Gecko', () => {
    expect(SOURCE).toContain('browser\\.storage\\.local\\.')
    expect(SOURCE).toContain('it was not built for Gecko')
  })

  it('writes Firefox-named artifacts and never a Chromium one', () => {
    expect(SOURCE).toContain('Watchside-Firefox-v${version}.zip')
    expect(SOURCE).toContain('Watchside-Firefox-Beta-v${version}.zip')
    expect(SOURCE).not.toContain('Watchside-Store-v')
    expect(SOURCE).not.toContain('Watchside-Private-Beta-v')
  })

  /** Flat, because every Firefox install path expects manifest.json at the root. */
  it('puts the manifest at the archive root', () => {
    expect(SOURCE).toContain('manifest.json must be at the ROOT of a Firefox package')
  })

  /**
   * Measured, not assumed. writeZip defaults to the wall clock, and with that
   * default two builds of identical source produced different archives - the
   * packaged FILES were byte-identical and only the container differed. AMO
   * wants a source submission a reviewer can rebuild and compare, so "same
   * source in, same bytes out" has to be literally true.
   */
  it('pins the archive timestamp so builds are reproducible', () => {
    expect(SOURCE).toContain('const DETERMINISTIC_DATE = new Date(1980, 0, 1, 0, 0, 0)')
    expect(SOURCE).toContain('{ date: DETERMINISTIC_DATE }')
  })

  /** Chrome's packager keeps its wall-clock default; F2 changed nothing there. */
  it('leaves the Chromium packager writing its own timestamps', () => {
    const beta = readFileSync('scripts/package-beta.mjs', 'utf8')
    expect(beta).not.toContain('DETERMINISTIC_DATE')
  })
})

// ================================================ the artifact, when it exists

describe.runIf(built)('the generated Firefox package', () => {
  const manifest = JSON.parse(readFileSync(join(PACKAGE, 'manifest.json'), 'utf8'))
  const source = JSON.parse(readFileSync('public/manifest.json', 'utf8'))
  const background = readFileSync(join(PACKAGE, 'kickback-background.js'), 'utf8')
  const content = readFileSync(join(PACKAGE, 'kickback-content.js'), 'utf8')

  it('is exactly what the transform produces', () => {
    expect(manifest).toEqual(manifestFor('gecko', source))
  })

  it('is Manifest V3', () => {
    expect(manifest.manifest_version).toBe(3)
  })

  it('carries the permanent Gecko id and minimum Firefox', () => {
    expect(manifest.browser_specific_settings.gecko.id).toBe(GECKO_ID)
    expect(manifest.browser_specific_settings.gecko.strict_min_version).toBe(GECKO_MIN_VERSION)
  })

  it('carries no Chromium identity', () => {
    expect(manifest.key).toBeUndefined()
    expect(JSON.stringify(manifest)).not.toContain(EXPECTED_EXTENSION_ID)
  })

  it('declares an event page, not a service worker', () => {
    expect(manifest.background).toEqual({ scripts: ['kickback-background.js'] })
  })

  it('asks for exactly what Chromium asks for', () => {
    expect(manifest.permissions).toEqual(source.permissions)
    expect(manifest.host_permissions).toEqual(source.host_permissions)
    expect(manifest.optional_permissions).toBeUndefined()
  })

  // ------------------------------------------------------------- bundles

  /**
   * The check the whole Firefox package exists to satisfy. Gecko's chrome.*
   * alias is callback-shaped, so a Chromium bundle in a Firefox package
   * installs cleanly and then resolves every storage read to undefined.
   */
  it('speaks browser.*, not chrome.*', () => {
    for (const namespace of ['storage', 'identity', 'notifications', 'alarms', 'tabs', 'runtime']) {
      expect(background).toContain(`browser.${namespace}.`)
      expect(background).not.toContain(`chrome.${namespace}.`)
    }
    expect(content).toContain('browser.runtime.connect')
    expect(content).not.toContain('chrome.runtime.')
  })

  it('keeps background-only APIs out of the content script', () => {
    for (const namespace of ['storage', 'identity', 'notifications', 'alarms', 'tabs']) {
      expect(content).not.toContain(`browser.${namespace}.`)
    }
  })

  it('is labelled as a private beta build', () => {
    expect(background).toContain('private_beta')
  })

  // --------------------------------------------------------------- leaks

  it('ships no source maps and no secrets', () => {
    const problems: string[] = []
    const { scanContents, checkPaths } = createScanner((m: string) => problems.push(m))
    const files = RUNTIME_FILES.filter((f) => existsSync(join(PACKAGE, f)))
    checkPaths(files, 'package')
    scanContents(PACKAGE, files, 'package')
    expect(problems).toEqual([])
  })

  it('ships every icon', () => {
    for (const size of [16, 32, 48, 128]) {
      expect(existsSync(join(PACKAGE, `icons/icon-${size}.png`))).toBe(true)
    }
  })
})

// ================================================== Chromium stays untouched

describe('packaging for Firefox costs Chromium nothing', () => {
  const source = JSON.parse(readFileSync('public/manifest.json', 'utf8'))

  it('leaves the canonical manifest a Chromium manifest', () => {
    expect(source.background).toEqual({ service_worker: 'kickback-background.js' })
    expect(typeof source.key).toBe('string')
    expect(source.browser_specific_settings).toBeUndefined()
  })

  it('leaves the permanent Chromium id resolvable', () => {
    expect(EXPECTED_EXTENSION_ID).toBe('ngfopkeokddfnncdhfkhnffilbdhkkip')
  })

  /** dist/ is Chromium's. Nothing in the Firefox path may write there. */
  it('never writes into dist/', () => {
    const firefox = readFileSync('scripts/package-firefox.mjs', 'utf8')
    expect(firefox).not.toMatch(/['"]dist['"]/)
  })

  /** The build defaults to Chromium, so a missing flag cannot ship the wrong engine. */
  it('defaults the build to Chromium', () => {
    for (const config of ['vite.config.ts', 'vite.background.config.ts']) {
      const text = readFileSync(config, 'utf8')
      expect(text).toContain("process.env.WATCHSIDE_BROWSER === 'gecko' ? 'gecko' : 'chromium'")
      expect(text).toContain("process.env.WATCHSIDE_OUT_DIR ?? 'dist'")
    }
  })
})
