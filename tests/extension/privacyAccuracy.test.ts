import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

import { EVENT_DATA_CATEGORY } from '../../src/core/analytics'
import { GECKO_DATA_COLLECTION } from '../../scripts/manifest.mjs'

/**
 * The privacy policy, held against the software it describes.
 *
 * WHY THIS EXISTS
 *
 * `docs/PRIVACY.md` is generated straight onto watchside.app/privacy, so it is
 * the public, legal-facing description of what Watchside does. It had drifted:
 * it still described a "private beta (v0.4.x)" months after Watchside was
 * published on two stores, still said the Chrome host permission "will be
 * narrowed at its next release" after a release that did not narrow it, and
 * described the extension in Chrome-only language after Firefox shipped.
 *
 * None of that was caught by anything, because prose has no compiler.
 *
 * WHAT THESE TESTS ARE, AND ARE NOT
 *
 * They are not a proof that the policy is true - no test can be that. They pin
 * the handful of facts that (a) went stale before, or (b) would make the policy
 * actively misleading if the code changed underneath it. The most important one
 * is `disclosesEveryHostItContacts`: it derives the host list from the SOURCE,
 * so a new third party cannot be contacted without the policy naming it.
 *
 * Deliberately NOT pinned: version numbers, dates, or any wording that a normal
 * edit for clarity should be free to change. A test that fails when somebody
 * improves a sentence teaches people to delete tests.
 */

const POLICY = readFileSync('docs/PRIVACY.md', 'utf8')
const CHROME_MANIFEST = JSON.parse(readFileSync('public/manifest.json', 'utf8'))

/** Every source file, so "what does this actually contact" is answerable. */
function sourceFiles(dir: string): string[] {
  const out: string[] = []
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry)
    if (statSync(path).isDirectory()) out.push(...sourceFiles(path))
    else if (/\.tsx?$/.test(entry)) out.push(path)
  }
  return out
}

const SOURCE = sourceFiles('src')
  .map((file) => readFileSync(file, 'utf8'))
  .join('\n')

describe('the policy describes a product that exists', () => {
  /**
   * The exact framing that went stale, and how it went stale: it named a
   * release channel and a version, both of which stopped being true without
   * anybody editing the sentence.
   */
  it('does not describe Watchside as an unreleased private beta', () => {
    const text = POLICY.toLowerCase()
    for (const stale of ['private beta', 'beta tester', 'not yet available', 'coming soon']) {
      expect(text, stale).not.toContain(stale)
    }
  })

  it('carries no version number that a release would falsify', () => {
    /*
     * `v0.4.x` in the "Applies to" line is what this is about. A policy that
     * names a version is wrong the moment the next one ships, and the fix is
     * not to update it every release - it is not to say it.
     */
    expect(POLICY).not.toMatch(/v\d+\.\d+\.[x\d]/)
  })

  it('uses the current product name throughout', () => {
    // `kickback:` storage keys and CSS prefixes survive in the CODE for
    // compatibility, deliberately. They have no business in the public policy.
    expect(POLICY).not.toMatch(/\bKickback\b/)
  })

  it('is not written as though Chrome were the only browser', () => {
    /*
     * Firefox is published and approved. The policy described `chrome.storage`,
     * "Chrome's identity API" and a "background service worker" - the last of
     * which Firefox does not even have, since Gecko MV3 uses an event page.
     */
    expect(POLICY).not.toMatch(/Chrome's `?identity`? API/)
    expect(POLICY).not.toMatch(/background service worker/)
    expect(POLICY).toContain('browser.storage.local')
  })
})

describe('every host the extension contacts is disclosed', () => {
  /**
   * THE DURABLE ONE.
   *
   * Derived from source rather than listed here, so adding a fetch or an image
   * from a new third party fails this test until the policy names it. That is
   * the failure mode worth automating: a privacy policy is wrong in the way
   * that matters when the software quietly starts talking to somebody new.
   */
  const hosts = [
    ...new Set(
      [...SOURCE.matchAll(/https:\/\/([a-z0-9][a-z0-9.-]*\.[a-z]{2,})/g)].map((m) => m[1]),
    ),
  ]

  /*
   * Watchside's own surfaces are not third parties, and the Supabase project
   * host is referenced through an environment variable rather than a literal,
   * so it never appears here anyway.
   */
  const OURS = new Set(['watchside.app', 'anoteros-labs.github.io', 'www.twitch.tv'])
  const thirdParties = hosts.filter((h) => !OURS.has(h))

  it('finds the third-party hosts in the source at all', () => {
    // A guard on the guard: if the regex stops matching, the test below would
    // pass vacuously and prove nothing.
    expect(thirdParties.length).toBeGreaterThan(0)
    expect(thirdParties).toContain('7tv.io')
  })

  it('names every one of them in the policy', () => {
    const undisclosed = thirdParties.filter((host) => !POLICY.includes(host))
    expect(
      undisclosed,
      `contacted by the extension but not disclosed in the policy: ${undisclosed.join(', ')}`,
    ).toEqual([])
  })
})

describe('what the policy says about permissions matches the manifest', () => {
  it('explains every permission the extension asks for', () => {
    for (const permission of CHROME_MANIFEST.permissions as string[]) {
      expect(POLICY, `the ${permission} permission is undeclared in the policy`).toContain(
        `\`${permission}\``,
      )
    }
  })

  it('explains every permission it asks for and no more', () => {
    /*
     * The other direction. A permission described in the policy but absent from
     * the manifest is a promise about software that does not exist - which is
     * how `cdn.7tv.app` came to be listed as a host permission after it had
     * been removed.
     */
    const declared = JSON.stringify(CHROME_MANIFEST.host_permissions)
    const claimsHostPermission = (host: string) =>
      new RegExp(`\\*\\*\`https://${host.replace(/\./g, '\\.')}`).test(POLICY)

    expect(claimsHostPermission('7tv.io/\\*'), '7tv.io').toBe(declared.includes('7tv.io'))
    // cdn.7tv.app is still CONTACTED (images), and still disclosed above - but
    // it is no longer a host permission, so it must not be presented as one.
    expect(claimsHostPermission('cdn.7tv.app/\\*')).toBe(false)
  })

  it('does not promise a change to a future release', () => {
    /*
     * The policy said the Chrome wildcard "will be narrowed to match at its
     * next release". The next release shipped without narrowing it. A policy
     * should describe what is, not commit to a roadmap it does not control.
     */
    expect(POLICY).not.toMatch(/will be narrowed|at its next release|in a future release/)
  })
})

describe('the Firefox disclosures agree with what the add-on declares', () => {
  /** Mozilla shows these at install; the policy has a row for each. */
  const FIREFOX_WORDING: Record<string, string> = {
    authenticationInfo: 'Authentication information',
    browsingActivity: 'Browsing activity',
    personalCommunications: 'Personal communications',
    websiteActivity: 'Website activity',
  }

  it('explains each declared category in the policy', () => {
    for (const category of GECKO_DATA_COLLECTION.required) {
      expect(POLICY, `${category} is declared to Mozilla but not explained`).toContain(
        FIREFOX_WORDING[category],
      )
    }
  })

  it('declares no optional data collection, as the policy says', () => {
    expect(GECKO_DATA_COLLECTION.optional).toBeUndefined()
    expect(POLICY).toContain('Technical and interaction data: Firefox collects none')
  })

  it('still has exactly the three diagnostic signals the policy describes', () => {
    /*
     * The policy commits to a number - "three diagnostic signals" - and names
     * them. A fourth would make that sentence false on a page Mozilla reviewed.
     */
    const technical = Object.entries(EVENT_DATA_CATEGORY)
      .filter(([, category]) => category === 'technicalAndInteraction')
      .map(([name]) => name)

    expect(technical.sort()).toEqual([
      'client_error',
      'group_message_send_failed',
      'realtime_status_changed',
    ])
    expect(POLICY).toContain('three diagnostic signals')
  })
})

describe('the claims that would be worst to get wrong', () => {
  it('does not claim an IP address is never received', () => {
    /*
     * Watchside stores no IP - verified separately, there is no such column -
     * but every HTTP request reveals one to the server answering it, and a
     * policy implying otherwise would be false in a way readers cannot check.
     * The policy names this rather than leaving the two-places list to imply it.
     */
    expect(POLICY).toContain('IP address')
    expect(POLICY).toMatch(/does not store your IP address/i)
  })

  it('keeps the emote CDN disclosed even though its permission is gone', () => {
    /*
     * The trap this milestone was warned about: removing a host PERMISSION does
     * not stop the host being contacted. cdn.7tv.app is still fetched by every
     * emote <img> in the panel, so it stays in the disclosure list.
     */
    expect(SOURCE).toContain('cdn.7tv.app/emote/')
    expect(POLICY).toContain('cdn.7tv.app')
  })
})
