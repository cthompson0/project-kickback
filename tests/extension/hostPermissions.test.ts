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
      'https://cdn.7tv.app/*',
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

  it('fetches every host it holds a permission for, except the image CDN', () => {
    expect(isFetched('7tv.io'), '7tv.io is permitted but never fetched').toBe(true)

    /*
     * cdn.7tv.app is the odd one out, and this asserts it: nothing fetches it.
     * `core/emotes.ts` builds a URL, and an <img> in the content script's shadow
     * DOM loads it. See the control case below.
     */
    expect(isFetched('cdn.7tv.app'), 'cdn.7tv.app has become a fetch target').toBe(false)
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
  /** The same arithmetic Firefox does: host permissions plus content matches. */
  function domainsFor(hostPermissions: string[], matches: string[]): string[] {
    const hosts = new Set<string>()
    for (const pattern of [...hostPermissions, ...matches]) {
      hosts.add(new URL(pattern.replace('/*', '')).hostname)
    }
    return [...hosts].sort()
  }

  it('counts five domains today, and says which', () => {
    /*
     * Written down because the owner meets this dialog before anything else
     * Watchside says, and because "5 domains" is not obviously derivable from
     * a manifest with three host_permissions in it.
     */
    const domains = domainsFor(
      // The Firefox packager narrows the wildcard to the real project host.
      ['https://ezikxbbcwcxhkboeekkk.supabase.co/*', 'https://7tv.io/*', 'https://cdn.7tv.app/*'],
      CHROME_MANIFEST.content_scripts[0].matches,
    )
    expect(domains).toEqual([
      '7tv.io',
      'cdn.7tv.app',
      'ezikxbbcwcxhkboeekkk.supabase.co',
      'twitch.tv',
      'www.twitch.tv',
    ])
  })

  it('would count four without the image CDN, with the backend host still named', () => {
    /*
     * The honest limit of the cheap fix: dropping cdn.7tv.app removes an entry
     * nothing needs, and leaves the entry the owner was actually worried about.
     * Recorded so nobody mistakes the cleanup for a solution to that.
     */
    const domains = domainsFor(
      ['https://ezikxbbcwcxhkboeekkk.supabase.co/*', 'https://7tv.io/*'],
      CHROME_MANIFEST.content_scripts[0].matches,
    )
    expect(domains).toHaveLength(4)
    expect(domains).toContain('ezikxbbcwcxhkboeekkk.supabase.co')
  })
})
