import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * Every host permission is there because something needs it.
 *
 * WHY THIS EXISTS
 *
 * Firefox shows required host permissions at install time as "Access your data
 * for sites in N domains", and lists them. That dialog is the first thing a
 * stranger sees about Watchside, before any of our own copy - so each entry
 * costs trust, and an entry nothing uses costs trust for nothing.
 *
 * THE DISTINCTION THIS FILE PINS
 *
 * A host needs a permission when the extension FETCHES it. A host does NOT need
 * one when the extension merely builds a URL and lets an `<img>` load it - image
 * loads are governed by the page's CSP, not by extension host permissions.
 *
 * The control case is in production and was approved by Mozilla:
 * `static-cdn.jtvnw.net` carries Twitch avatars and emotes, is used exactly this
 * way, has NO host permission, and renders fine in the signed 0.6.0 that AMO
 * distributes today.
 *
 * These tests keep that distinction true, in both directions: a fetched host
 * must be permitted, and an image-only host must not accumulate a permission
 * nobody needs.
 */

const CHROME_MANIFEST = JSON.parse(readFileSync('public/manifest.json', 'utf8'))

/** Every source file, so "is this host fetched anywhere" is answerable. */
function sourceFiles(dir: string): string[] {
  const out: string[] = []
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry)
    if (statSync(path).isDirectory()) out.push(...sourceFiles(path))
    else if (/\.tsx?$/.test(entry)) out.push(path)
  }
  return out
}

const SOURCES = sourceFiles('src').map((file) => ({ file, text: readFileSync(file, 'utf8') }))

/**
 * Whether a host is ever handed to fetch(), rather than only composed into a
 * string. Deliberately generous about what counts as a fetch: a false positive
 * here keeps a permission, which is the safe direction.
 */
function isFetched(host: string): boolean {
  return SOURCES.some(({ text }) => {
    if (!text.includes(host)) return false
    // The constant that names the host, and whether it feeds a request.
    const declares = new RegExp(`['\`"]https://${host.replace('.', '\\.')}`)
    if (!declares.test(text)) return false
    return /\bfetch\s*\(|\bSEVENTV_API\b|createClient\s*\(/.test(text)
  })
}

describe('the hosts Watchside asks permission for', () => {
  it('declares exactly the ones it means to', () => {
    // Pinned so that adding one is a deliberate, visible act rather than a
    // line that slid into a manifest.
    expect(CHROME_MANIFEST.host_permissions).toEqual([
      'https://*.supabase.co/*',
      'https://7tv.io/*',
    ])
  })

  it('injects into Twitch and nowhere else', () => {
    /*
     * These are why the dialog says FIVE domains rather than three: Firefox
     * counts content-script matches as host access too. Both patterns are
     * needed - twitch.tv does not match www.twitch.tv, and people arrive at
     * both.
     */
    expect(CHROME_MANIFEST.content_scripts).toHaveLength(1)
    expect(CHROME_MANIFEST.content_scripts[0].matches).toEqual([
      'https://www.twitch.tv/*',
      'https://twitch.tv/*',
    ])
  })

  it('fetches every host it holds a permission for', () => {
    expect(isFetched('7tv.io'), '7tv.io is permitted but never fetched').toBe(true)
  })

  it('does not hold a permission for the 7TV image CDN, and must not regain one', () => {
    /*
     * REMOVED before the v0.8 Firefox submission. `core/emotes.ts` builds a
     * `https://cdn.7tv.app/emote/...webp` URL and an <img> in the content
     * script's shadow DOM loads it - and image loads are governed by the page's
     * CSP, not by extension host permissions. The control case below is the
     * evidence.
     *
     * Both halves matter. If something ever starts FETCHING this host, the
     * first assertion fails and whoever wrote that fetch is told to declare
     * the permission rather than watch requests fail at a user's browser.
     */
    expect(isFetched('cdn.7tv.app'), 'cdn.7tv.app is fetched but no longer permitted').toBe(
      false,
    )
    expect(JSON.stringify(CHROME_MANIFEST.host_permissions)).not.toContain('cdn.7tv.app')
  })
})

describe('the control case: image hosts need no permission', () => {
  it('uses the Twitch CDN exactly as it uses the 7TV CDN', () => {
    const emotes = readFileSync('src/core/emotes.ts', 'utf8')
    expect(emotes).toContain('cdn.7tv.app/emote/')
    expect(emotes).toContain('static-cdn.jtvnw.net/emoticons/')
  })

  it('holds no permission for the Twitch CDN, and needs none', () => {
    /*
     * THE EVIDENCE. This host carries every Twitch emote and avatar Watchside
     * renders, has never been in host_permissions, and works in the Mozilla-
     * approved 0.6.0 on AMO right now. Whatever is true for it is true for
     * cdn.7tv.app, which is used identically.
     */
    const declared = JSON.stringify(CHROME_MANIFEST.host_permissions)
    expect(declared).not.toContain('jtvnw')
    expect(declared).not.toContain('twitchcdn')
    expect(isFetched('static-cdn.jtvnw.net')).toBe(false)
  })
})

describe('what the Firefox install dialog will say', () => {
  /** What the Gecko packager substitutes for the wildcard today. */
  const PROJECT_BACKEND = 'https://ezikxbbcwcxhkboeekkk.supabase.co/*'
  /** And what it will substitute once the custom domain is activated. */
  const BRANDED_BACKEND = 'https://api.watchside.app/*'
  const MATCHES = CHROME_MANIFEST.content_scripts[0].matches

  /** The same arithmetic Firefox does: host permissions plus content matches. */
  function domainsFor(hostPermissions: string[], matches: string[]): string[] {
    const hosts = new Set<string>()
    for (const pattern of [...hostPermissions, ...matches]) {
      hosts.add(new URL(pattern.replace('/*', '')).hostname)
    }
    return [...hosts].sort()
  }

  it('names four domains, and says which', () => {
    /*
     * Written down because a stranger meets this dialog before anything else
     * Watchside says, and because the count is not derivable from a manifest
     * with two host_permissions in it - Firefox counts content-script matches
     * as host access too.
     *
     * It said FIVE until v0.8. `cdn.7tv.app` was removed once the control case
     * below had spent a full review cycle in production proving it unnecessary.
     */
    const domains = domainsFor(
      // The Firefox packager narrows the wildcard to the real backend origin.
      [PROJECT_BACKEND, 'https://7tv.io/*'],
      CHROME_MANIFEST.content_scripts[0].matches,
    )
    expect(domains).toEqual([
      '7tv.io',
      'ezikxbbcwcxhkboeekkk.supabase.co',
      'twitch.tv',
      'www.twitch.tv',
    ])
  })

  it('still names a raw project host, which is what the branded backend changes', () => {
    /*
     * THE HONEST LIMIT OF THE CLEANUP, kept in the suite so nobody mistakes
     * four-instead-of-five for a fix to the thing the owner actually raised.
     *
     * Removing the image CDN dropped an entry nothing needed. The entry that
     * reads like a random string is the backend, and only pointing the build at
     * `api.watchside.app` changes it. That is one env var - VITE_SUPABASE_URL -
     * because the packager derives this grant from whatever origin the bundle
     * talks to. This asserts both halves: where we are, and what moves.
     */
    const today = domainsFor([PROJECT_BACKEND, 'https://7tv.io/*'], MATCHES)
    expect(today).toContain('ezikxbbcwcxhkboeekkk.supabase.co')

    const branded = domainsFor([BRANDED_BACKEND, 'https://7tv.io/*'], MATCHES)
    expect(branded).toEqual(['7tv.io', 'api.watchside.app', 'twitch.tv', 'www.twitch.tv'])

    // The count does not improve. The legibility does, and that was the point.
    expect(branded).toHaveLength(today.length)
  })
})
