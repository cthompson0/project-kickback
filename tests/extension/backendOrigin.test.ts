import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

import {
  SUPABASE_WILDCARD,
  backendOriginsIn,
  grantsOrigin,
  manifestFor,
} from '../../scripts/manifest.mjs'

/**
 * The backend origin is a build input, not a code change.
 *
 * WHY THIS EXISTS
 *
 * Firefox's install dialog names the backend host, and the raw project host
 * (`ezikxbbcwcxhkboeekkk.supabase.co`) is the entry that reads like a random
 * string to a stranger deciding whether to trust Watchside. The fix is a
 * Supabase custom domain, `api.watchside.app`.
 *
 * That migration is gated on things this repository cannot do - a paid add-on,
 * DNS, and a Twitch callback registration. What the repository CAN do is make
 * sure that when those land, pointing Watchside at the branded host is one
 * environment variable and not a scavenger hunt through the packaging scripts.
 *
 * It very nearly was a scavenger hunt. The packager and the verifier each
 * carried their OWN copy of a `[a-z0-9-]+.supabase.co` regex, and the Gecko
 * host permission is derived from whatever origin those regexes find in the
 * built bundle. Setting VITE_SUPABASE_URL to the branded host would have found
 * ZERO origins and failed the build - which is the safe direction, but only
 * after someone spent a while working out why.
 *
 * These tests pin the generalised behaviour, in both directions: the branded
 * host is recognised, and the pattern is still narrow enough that a bundle
 * naming two backends - or none - is a failure rather than a coin flip.
 */

const SOURCE = JSON.parse(readFileSync('public/manifest.json', 'utf8'))

type Manifest = {
  host_permissions: string[]
  content_scripts: { matches: string[] }[]
}

/** manifestFor is shared JS and returns Record<string, unknown>. */
const gecko = (origin: string) =>
  manifestFor('gecko', SOURCE, { supabaseOrigin: origin }) as unknown as Manifest

const PROJECT = 'https://ezikxbbcwcxhkboeekkk.supabase.co'
const BRANDED = 'https://api.watchside.app'

describe('finding the backend origin in a built bundle', () => {
  it('recognises the Supabase project host', () => {
    expect(backendOriginsIn(`x="${PROJECT}/rest/v1";`)).toEqual([PROJECT])
  })

  it('recognises the branded host, which is the whole point', () => {
    expect(backendOriginsIn(`x="${BRANDED}/rest/v1";`)).toEqual([BRANDED])
  })

  it('is narrow enough to ignore every other host the bundle names', () => {
    /*
     * The reason this is an enumerated list and not `https://[^"]+`. All four
     * of these appear in the real background bundle; none of them is the
     * backend, and granting one of them a host permission because a regex was
     * greedy would be a permission nobody asked for.
     */
    const decoys = [
      'https://7tv.io/v3/users/twitch/1',
      'https://cdn.7tv.app/emote/abc/2x.webp',
      'https://static-cdn.jtvnw.net/emoticons/v2/1/default/dark/2.0',
      'https://www.twitch.tv/somebody',
    ].join(' ')
    expect(backendOriginsIn(decoys)).toEqual([])
  })

  it('reports both when a bundle names two backends, so the caller can refuse', () => {
    /*
     * The safety property the packager depends on. A bundle talking to two
     * backends means the build and the manifest cannot both be right, and the
     * packager fails rather than guessing which one to grant.
     */
    expect(backendOriginsIn(`${PROJECT} and ${BRANDED}`)).toHaveLength(2)
    expect(backendOriginsIn('no backend here at all')).toHaveLength(0)
  })

  it('finds one origin however many times the bundle repeats it', () => {
    const repeated = `${PROJECT}/auth/v1 ${PROJECT}/rest/v1 ${PROJECT}/realtime/v1`
    expect(backendOriginsIn(repeated)).toEqual([PROJECT])
  })
})

describe('the Gecko manifest the branded host would produce', () => {
  it('grants the branded origin and nothing else new', () => {
    const manifest = gecko(BRANDED)
    expect(manifest.host_permissions).toEqual([`${BRANDED}/*`, 'https://7tv.io/*'])
  })

  it('leaves no trace of the wildcard, which grants every Supabase project', () => {
    const manifest = gecko(BRANDED)
    expect(JSON.stringify(manifest)).not.toContain(SUPABASE_WILDCARD)
    expect(JSON.stringify(manifest)).not.toContain('supabase.co')
  })

  it('asks for the four domains the install dialog will name', () => {
    /*
     * The target surface for the Firefox v0.8 submission, written down so the
     * dialog a stranger reads is a reviewed decision rather than a side effect.
     *
     * Same COUNT as today - removing cdn.7tv.app is what took it from five to
     * four. What changes here is that every entry is now a name a person can
     * read: the site it works on, the emote service they already see in chat,
     * and Watchside's own backend.
     */
    const manifest = gecko(BRANDED)
    const domains = [
      ...new Set(
        [...manifest.host_permissions, ...manifest.content_scripts[0].matches].map(
          (p) => new URL(p.replace('/*', '')).hostname,
        ),
      ),
    ].sort()
    expect(domains).toEqual(['7tv.io', 'api.watchside.app', 'twitch.tv', 'www.twitch.tv'])
  })

  it('changes only the backend entry, whichever origin it is given', () => {
    /*
     * The migration must not quietly move anything else. Everything that is not
     * the backend is identical between the two manifests.
     */
    const today = gecko(PROJECT)
    const after = gecko(BRANDED)

    const strip = (m: Manifest) => JSON.stringify({ ...m, host_permissions: null })
    expect(strip(after)).toEqual(strip(today))
    expect(after.host_permissions.slice(1)).toEqual(today.host_permissions.slice(1))
  })
})

describe('whether the Chromium manifest grants the backend it talks to', () => {
  /*
   * THE TRAP THIS CLOSES.
   *
   * Gecko derives its backend grant from the built bundle. Chromium declares
   * it statically, and `https://*.supabase.co/*` covered the project host by
   * accident of shape - so nothing ever had to check that the manifest and the
   * build agreed. Pointing VITE_SUPABASE_URL at the branded host breaks that
   * coincidence, and the Chrome packager would have shipped it happily.
   */
  const CHROME_HOSTS: string[] = SOURCE.host_permissions

  it('grants the Supabase project host today, through the wildcard', () => {
    expect(grantsOrigin(CHROME_HOSTS, PROJECT)).toBe(true)
  })

  it('does NOT grant the branded host, which is why the packager now checks', () => {
    /*
     * Not a bug - a fact about match patterns, recorded so the Chrome
     * migration is a manifest edit somebody made on purpose. When Chrome moves
     * to api.watchside.app, `public/manifest.json` must name it; until then
     * this staying false is correct.
     */
    expect(grantsOrigin(CHROME_HOSTS, BRANDED)).toBe(false)
  })

  it('matches a wildcard only against its own suffix', () => {
    const wildcard = [SUPABASE_WILDCARD]
    expect(grantsOrigin(wildcard, 'https://anything.supabase.co')).toBe(true)
    expect(grantsOrigin(wildcard, 'https://api.watchside.app')).toBe(false)

    /*
     * The suffix must be a real label boundary. Without the leading dot,
     * `evilsupabase.co` would satisfy a naive endsWith and a hostile host
     * would inherit the grant.
     */
    expect(grantsOrigin(wildcard, 'https://evilsupabase.co')).toBe(false)
  })

  it('matches an exact host exactly', () => {
    const exact = ['https://api.watchside.app/*']
    expect(grantsOrigin(exact, BRANDED)).toBe(true)
    expect(grantsOrigin(exact, 'https://evil.api.watchside.app')).toBe(false)
    expect(grantsOrigin(exact, PROJECT)).toBe(false)
  })

  it('grants nothing when nothing is declared', () => {
    expect(grantsOrigin([], BRANDED)).toBe(false)
  })
})
