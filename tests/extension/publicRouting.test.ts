import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { beforeAll, describe, expect, it } from 'vitest'
import { INVITE_LANDING_BASE, inviteLinkFor, normalizeInviteCode } from '../../src/core/invites'

/**
 * The public routing contract for watchside.app.
 *
 * WHAT THIS CAN AND CANNOT PROVE
 *
 * It proves the ROUTING: that the built site answers the canonical paths, that
 * an invite code survives the new URL shape, and that nothing here can be turned
 * into an open redirect. It cannot prove DNS, a certificate, or that anybody can
 * reach the domain - those are external, and the report keeps PREPARED and LIVE
 * apart for exactly that reason.
 *
 * THE INVARIANT THAT MATTERS MOST
 *
 * Changing the public URL shape must not change the referral identity. The code
 * is the identity; `/i/<code>` and `?c=<code>` are two ways of carrying it, and
 * both must end at the same `twitch.tv/?kickback_invite=<code>` the extension
 * has always read.
 */

const OUT = join('dist-site')

/** The site's invite logic, exercised the way a browser would. */
function resolveInvite(url: string): string | null {
  const source = readFileSync(join(OUT, '404.html'), 'utf8')
  const script = source.slice(source.indexOf('(function () {'), source.lastIndexOf('})()') + 4)

  const parsed = new URL(url)
  const elements: Record<string, Record<string, unknown>> = {}
  const element = (id: string) => {
    elements[id] ??= { textContent: '', hidden: true, attributes: {} as Record<string, string> }
    return {
      set textContent(value: string) {
        elements[id].textContent = value
      },
      set hidden(value: boolean) {
        elements[id].hidden = value
      },
      setAttribute(name: string, value: string) {
        ;(elements[id].attributes as Record<string, string>)[name] = value
      },
    }
  }

  const sandbox = {
    window: { location: { pathname: parsed.pathname, search: parsed.search } },
    document: { getElementById: element },
    URLSearchParams,
    decodeURIComponent,
    encodeURIComponent,
  }

  new Function('window', 'document', 'URLSearchParams', 'decodeURIComponent', 'encodeURIComponent', script)(
    sandbox.window,
    sandbox.document,
    URLSearchParams,
    decodeURIComponent,
    encodeURIComponent,
  )

  const href = (elements.continue?.attributes as Record<string, string> | undefined)?.href
  return href ?? null
}

const CODE = 'ABCDEFGHJKMNPQRSTVWXYZ'.slice(0, 22)

beforeAll(() => {
  rmSync(OUT, { recursive: true, force: true })
  execFileSync(process.execPath, [join('scripts', 'build-site.mjs')], { stdio: 'pipe' })
}, 60_000)

describe('the canonical routes exist', () => {
  it('serves a root page that makes the promise', () => {
    expect(existsSync(join(OUT, 'index.html'))).toBe(true)
    const html = readFileSync(join(OUT, 'index.html'), 'utf8')

    /*
     * Checked as rendered TEXT rather than as a raw substring.
     *
     * The headline sets `watching Twitch` in the brand purple, so in the source
     * the sentence is split across an <em> and no single string in the file
     * contains it. What matters is what a visitor reads, which is what this
     * now asserts - and it keeps working the next time the headline is styled
     * differently.
     */
    const heading = /<h1[^>]*>([\s\S]*?)<\/h1>/.exec(html)?.[1] ?? ''
    const text = heading.replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim()
    expect(text).toBe('See where your friends are watching Twitch.')
  })

  it('serves privacy and support', () => {
    expect(existsSync(join(OUT, 'privacy', 'index.html'))).toBe(true)
    expect(existsSync(join(OUT, 'support', 'index.html'))).toBe(true)
  })

  /**
   * A static host has no router. GitHub Pages answers any unmatched path with
   * 404.html, which is the entire mechanism behind `/i/<code>`.
   */
  it('answers unmatched paths, which is how /i/<code> works at all', () => {
    expect(existsSync(join(OUT, '404.html'))).toBe(true)
    expect(existsSync(join(OUT, 'i', 'index.html'))).toBe(true)
  })

  it('claims the domain', () => {
    expect(readFileSync(join(OUT, 'CNAME'), 'utf8').trim()).toBe('watchside.app')
  })
})

describe('a referral code survives the canonical route', () => {
  it('carries the code from /i/<code> to Twitch', () => {
    expect(resolveInvite(`https://watchside.app/i/${CODE}`)).toBe(
      `https://www.twitch.tv/?kickback_invite=${CODE}`,
    )
  })

  it('accepts a trailing slash', () => {
    expect(resolveInvite(`https://watchside.app/i/${CODE}/`)).toBe(
      `https://www.twitch.tv/?kickback_invite=${CODE}`,
    )
  })

  it('uppercases a lowercased code, as the old page did', () => {
    expect(resolveInvite(`https://watchside.app/i/${CODE.toLowerCase()}`)).toBe(
      `https://www.twitch.tv/?kickback_invite=${CODE}`,
    )
  })

  /**
   * THE COMPATIBILITY GUARANTEE.
   *
   * Every link shared before today carries `?c=`. Those live in messages,
   * clipboards and browser histories, and they must keep working.
   */
  it('still carries the code from the old ?c= shape', () => {
    expect(resolveInvite(`https://watchside.app/anything?c=${CODE}`)).toBe(
      `https://www.twitch.tv/?kickback_invite=${CODE}`,
    )
  })

  it('prefers the path when both are present, rather than guessing', () => {
    const other = '0123456789ABCDEFGHJKMN'
    expect(resolveInvite(`https://watchside.app/i/${CODE}?c=${other}`)).toBe(
      `https://www.twitch.tv/?kickback_invite=${CODE}`,
    )
  })

  /** The referral identity is the code, and the URL shape does not touch it. */
  it('produces the same destination from both shapes', () => {
    expect(resolveInvite(`https://watchside.app/i/${CODE}`)).toBe(
      resolveInvite(`https://watchside.app/invite/?c=${CODE}`),
    )
  })
})

describe('a bad code fails safely', () => {
  const bad = [
    'https://watchside.app/i/',
    'https://watchside.app/i/TOOSHORT',
    'https://watchside.app/i/ABCDEFGHJKMNPQRSTVWXYZEXTRA',
    // I, L, O and U are excluded from the alphabet on purpose.
    'https://watchside.app/i/IIIIIIIIIIIIIIIIIIIIII',
    'https://watchside.app/i/../../etc/passwd',
    'https://watchside.app/i/%2E%2E%2F',
    'https://watchside.app/not-a-route',
    'https://watchside.app/?c=nonsense',
  ]

  for (const url of bad) {
    it(`leaves the page as a plain 404 for ${url}`, () => {
      expect(resolveInvite(url)).toBeNull()
    })
  }

  /** A malformed percent-escape must not throw and take the page with it. */
  it('survives an undecodable code', () => {
    expect(resolveInvite('https://watchside.app/i/%E0%A4%A')).toBeNull()
  })
})

describe('nothing here can redirect anywhere else', () => {
  /**
   * THE OPEN-REDIRECT CHECK.
   *
   * The page builds exactly one link, and its host is a literal. No part of the
   * URL can become a destination, so there is no input that turns this into a
   * redirector for somebody else's site.
   */
  it('builds only twitch.tv destinations, all of them from literals', () => {
    const source = readFileSync(join(OUT, '404.html'), 'utf8')
    const script = source.slice(source.indexOf('(function () {'))

    /*
     * TWO destinations since the campaign route landed, one per arrival kind.
     * The count is asserted rather than left open: a third would mean a route
     * was added without anybody revisiting this check, which is exactly when
     * an open redirect gets in.
     */
    expect(script).toContain("'https://www.twitch.tv/?kickback_invite='")
    expect(script).toContain("'https://www.twitch.tv/?watchside_campaign='")

    const hrefWrites = script.match(/setAttribute\(\s*\n?\s*'href',[^)]*/g) ?? []
    expect(hrefWrites).toHaveLength(2)
    // Every one of them starts from a literal twitch.tv string.
    for (const write of hrefWrites) {
      expect(write).toContain("'https://www.twitch.tv/?")
    }
  })

  it('never reads a destination out of the URL', () => {
    const source = readFileSync(join(OUT, '404.html'), 'utf8')
    for (const forbidden of ['location.href =', 'location.replace', 'location.assign', 'window.open']) {
      expect(source, forbidden).not.toContain(forbidden)
    }
  })

  it('refuses an absolute URL smuggled into the code', () => {
    expect(resolveInvite('https://watchside.app/i/https%3A%2F%2Fevil.example')).toBeNull()
    expect(resolveInvite('https://watchside.app/?c=https://evil.example')).toBeNull()
  })

  /** Static pages, so a redirect loop is not constructible in the first place. */
  it('performs no redirect at all', () => {
    for (const file of ['index.html', '404.html', join('support', 'index.html')]) {
      const html = readFileSync(join(OUT, file), 'utf8')
      expect(html, file).not.toContain('http-equiv="refresh"')
    }
  })
})

describe('the extension side is unchanged until the domain is live', () => {
  /**
   * The link the extension generates still points at the live Pages host.
   *
   * Switching it before DNS resolves would mean every invite copied in the
   * meantime pointed at nothing. The canonical base is declared beside it so
   * the switch is one line, and M5E makes it when the domain actually answers.
   */
  it('still generates the currently-live link', () => {
    expect(INVITE_LANDING_BASE).toBe('https://anoteros-labs.github.io/watchside/invite/')
    expect(inviteLinkFor(CODE)).toBe(`${INVITE_LANDING_BASE}?c=${CODE}`)
  })

  it('validates codes exactly as it always has', () => {
    expect(normalizeInviteCode(CODE.toLowerCase())).toBe(CODE)
    expect(normalizeInviteCode('nope')).toBeNull()
    expect(normalizeInviteCode('')).toBeNull()
  })

  /**
   * People paste whole links - the worker says so where it calls this - and the
   * canonical link puts the code in the PATH. Without this the canonical shape
   * would be the one link Watchside could not read back.
   */
  it('reads a code pasted as a canonical /i/ link', () => {
    expect(normalizeInviteCode(`https://watchside.app/i/${CODE}`)).toBe(CODE)
    expect(normalizeInviteCode(`https://watchside.app/i/${CODE}/`)).toBe(CODE)
    expect(normalizeInviteCode(`  https://watchside.app/i/${CODE.toLowerCase()}  `)).toBe(CODE)
  })

  it('still reads a code pasted as an old ?c= link', () => {
    expect(normalizeInviteCode(`https://anoteros-labs.github.io/watchside/invite/?c=${CODE}`)).toBe(
      CODE,
    )
  })

  it('reads nothing from a link that carries no code', () => {
    expect(normalizeInviteCode('https://watchside.app/i/')).toBeNull()
    expect(normalizeInviteCode('https://watchside.app/support')).toBeNull()
    expect(normalizeInviteCode('https://example.com/?c=nope')).toBeNull()
  })
})

// ------------------------------------------------ what the site may claim

describe('the public page tells the truth about availability', () => {
  const root = () => readFileSync(join(OUT, 'index.html'), 'utf8')

  /**
   * BOTH STORES ARE LIVE NOW, and this test used to assert the opposite.
   *
   * It was correct when it was written: Firefox had never been published, so
   * offering it would have sent people to a listing that did not exist, and the
   * test pinned that. Mozilla has since reviewed and published Watchside - the
   * AMO listing serves an approved build at
   * `addons.mozilla.org/firefox/addon/watchside/` - so the assertion had become
   * a guard holding a true statement out of the page.
   *
   * The locale-less AMO path is deliberate: AMO redirects it to the visitor's
   * own locale, and hard-coding `/en-US/` would send everyone to English.
   */
  it('offers Chrome, which is published', () => {
    expect(root()).toContain('Add to Chrome')
    expect(root()).toContain('chromewebstore.google.com')
  })

  it('offers Firefox, which is published too', () => {
    const html = root()
    expect(html).toContain('Add to Firefox')
    expect(html).toContain('addons.mozilla.org/firefox/addon/watchside/')
  })

  /**
   * Both CTAs, counted rather than merely present.
   *
   * `toContain` was satisfied by either one alone, so removing the Firefox
   * button from the hero - the version most visitors ever see - left the suite
   * green because the closing CTA still had one. The page offers each store
   * twice on purpose: once at the top, once at the end.
   */
  it('offers both stores in both places', () => {
    const html = root()
    const count = (needle: string) => html.split(needle).length - 1
    expect(count('addons.mozilla.org/firefox/addon/watchside/'), 'Firefox CTAs').toBe(2)
    expect(count('chromewebstore.google.com/detail/'), 'Chrome CTAs').toBe(2)
  })

  /**
   * Review state is not the visitor's business.
   *
   * Both stores always have an approved version installable while the next one
   * is in review, so a CTA pointed at the listing is always right - and prose
   * about what is pending goes stale the moment a reviewer clicks approve. The
   * page said "waiting on Mozilla" for weeks after it stopped being true.
   */
  it('does not narrate its own release process', () => {
    const html = root().toLowerCase()
    for (const stale of [
      'waiting on mozilla',
      'awaiting review',
      'in review',
      'coming soon',
      'private beta',
      'not yet available',
    ]) {
      expect(html, stale).not.toContain(stale)
    }
  })

  /** Claims we have no evidence for, in a product built to measure them. */
  it('claims nothing about outcomes we have not measured', () => {
    const html = root().toLowerCase()
    for (const forbidden of [
      'watch time',
      'increases',
      'improves discovery',
      'thousands',
      'trusted by',
      'engagement',
      'proven',
    ]) {
      expect(html, forbidden).not.toContain(forbidden)
    }
  })

  it('links privacy and support from every page', () => {
    for (const file of ['index.html', '404.html', join('support', 'index.html')]) {
      const html = readFileSync(join(OUT, file), 'utf8')
      expect(html, file).toContain('href="/privacy"')
    }
    expect(root()).toContain('href="/support"')
  })

  /**
   * No trackers, because a domain existing is not a reason to start measuring
   * visitors. Checked as "nothing is LOADED from elsewhere" rather than by
   * banning the word - the pages say in a comment that they run no analytics,
   * and a substring check would fail on the very sentence that promises it.
   */
  it('loads nothing from anywhere else', () => {
    for (const file of ['index.html', '404.html', join('support', 'index.html')]) {
      const html = readFileSync(join(OUT, file), 'utf8')
      // No external script, stylesheet, image, font or frame of any kind.
      expect(html, file).not.toMatch(/<script[^>]+ssrc=/)
      expect(html, file).not.toMatch(/<link[^>]+href="https?:/)
      expect(html, file).not.toMatch(/<(img|iframe|source|video|audio)[^>]+src="https?:/)
      // Every asset is inline, so there is nothing for a third party to see.
      expect(html, file).not.toContain('googletagmanager')
      expect(html, file).not.toContain('plausible')
      expect(html, file).not.toContain('gtag(')
    }
  })

  it('sets no cookies and stores nothing', () => {
    for (const file of ['index.html', '404.html', join('support', 'index.html')]) {
      const html = readFileSync(join(OUT, file), 'utf8')
      for (const forbidden of ['document.cookie', 'localStorage', 'sessionStorage', 'indexedDB']) {
        expect(html, `${file}: ${forbidden}`).not.toContain(forbidden)
      }
    }
  })

  it('gives support a route that needs no extension', () => {
    const html = readFileSync(join(OUT, 'support', 'index.html'), 'utf8')
    expect(html).toContain('anoteros.dev@gmail.com')
    expect(html).toContain('The panel does not appear on Twitch')
    expect(html).toContain('whether or not Watchside is running')
  })
})

/**
 * The build that can be published TODAY.
 *
 * A shipped build links to Support, and watchside.app does not resolve yet. So
 * the same sources build against the Pages subpath that is already live, and
 * these are the things that must hold about that tree: it leads where the
 * extension points, and it does not touch anything that is not Watchside's.
 */
describe('the subpath build serves the link a shipped extension already carries', () => {
  /*
   * Its own output directory, not the shared `dist-pages`.
   *
   * pagesArtifact.test.ts builds the same tree, and vitest runs these two files
   * in parallel workers - so they raced on one directory, and the loser saw a
   * half-deleted tree and failed to build. Intermittent, and it took until M5E
   * to surface. A build target is not a shared resource.
   */
  const PAGES_OUT = join('dist-pages-routing')
  const SUPPORT_URL = 'https://anoteros-labs.github.io/watchside/support/'

  beforeAll(() => {
    rmSync(PAGES_OUT, { recursive: true, force: true })
    execFileSync(process.execPath, [join('scripts', 'build-site.mjs'), PAGES_OUT, '/watchside/'], {
      stdio: 'pipe',
    })
  }, 60_000)

  it('emits a file at exactly the path the account panel links to', () => {
    const path = new URL(SUPPORT_URL).pathname.replace(/^\/watchside\//, '').replace(/\/$/, '')
    expect(existsSync(join(PAGES_OUT, path, 'index.html'))).toBe(true)
  })

  it('is the Support URL the extension actually uses', () => {
    // Read from source rather than restating it: a link edited in the panel and
    // not here would otherwise pass while pointing at a 404.
    const panel = readFileSync(join('src', 'ui', 'components', 'AuthStates.tsx'), 'utf8')
    const links = panel.match(/https:\/\/anoteros-labs\.github\.io\/watchside\/support\/?/g) ?? []
    expect(links.length).toBeGreaterThan(0)
    for (const link of links) expect(SUPPORT_URL).toContain(link)
  })

  it('rewrites its own links to the subpath, so none of them 404', () => {
    for (const page of ['index.html', join('support', 'index.html')]) {
      const html = readFileSync(join(PAGES_OUT, page), 'utf8')
      const internal = (html.match(/href="\/[^"]*"/g) ?? []).filter(
        (href) => !href.startsWith('href="//'),
      )
      expect(internal.length).toBeGreaterThan(0)
      for (const href of internal) expect(href).toMatch(/^href="\/watchside\//)
    }
  })

  it('never writes a CNAME, which would rebind the whole org site', () => {
    // A CNAME at the org Pages root would take anoteros-labs.github.io with it,
    // including /kickback/. It belongs only to the tree that owns the domain.
    expect(existsSync(join(PAGES_OUT, 'CNAME'))).toBe(false)
    expect(existsSync(join(OUT, 'CNAME'))).toBe(true)
  })

  it('claims no 404 handler or invite route it cannot honour', () => {
    // Both only work from a domain root. Publishing them into a subpath would
    // put a Watchside 404 on somebody else's site and an /i/ route that cannot
    // read its own path.
    expect(existsSync(join(PAGES_OUT, '404.html'))).toBe(false)
    expect(existsSync(join(PAGES_OUT, 'i'))).toBe(false)
  })

  it('still generates the privacy page from the policy, at the subpath', () => {
    const html = readFileSync(join(PAGES_OUT, 'privacy', 'index.html'), 'utf8')
    expect(html).toContain('/watchside/')
    expect(html).not.toContain('href="/privacy"')
  })
})

/**
 * The campaign route, which shares a file with the invite route and must never
 * share a meaning with it.
 *
 * `/i/<code>` says a friend invited you. `/c/<code>` says a campaign brought
 * you. Both are served by 404.html because a static host has no router, so the
 * one file has to decide which of two facts it is looking at - and getting that
 * wrong would not raise an error, it would silently record the wrong kind of
 * arrival.
 */
describe('the campaign route is separate from the referral route', () => {
  const CAMPAIGN = 'lirik-oct'

  /** The site's own script, run the way a browser would, for a campaign URL. */
  function resolveCampaign(url: string): { href: string | null; headline: string } {
    const source = readFileSync(join(OUT, '404.html'), 'utf8')
    const script = source.slice(source.indexOf('(function () {'), source.lastIndexOf('})()') + 4)
    const parsed = new URL(url)
    const captured: Record<string, { href?: string; text?: string }> = {}
    const element = (id: string) => {
      captured[id] ??= {}
      return {
        set textContent(value: string) {
          captured[id].text = value
        },
        set hidden(_value: boolean) {},
        setAttribute(name: string, value: string) {
          if (name === 'href') captured[id].href = value
        },
      }
    }
    new Function(
      'window',
      'document',
      'URLSearchParams',
      'decodeURIComponent',
      'encodeURIComponent',
      script,
    )(
      { location: { pathname: parsed.pathname, search: parsed.search } },
      { getElementById: element },
      URLSearchParams,
      decodeURIComponent,
      encodeURIComponent,
    )
    return { href: captured.continue?.href ?? null, headline: captured.headline?.text ?? '' }
  }

  it('serves a bare /c/ rather than falling through', () => {
    expect(existsSync(join(OUT, 'c', 'index.html'))).toBe(true)
  })

  it('carries a campaign code to Twitch under its own parameter', () => {
    expect(resolveCampaign(`https://watchside.app/c/${CAMPAIGN}`).href).toBe(
      `https://www.twitch.tv/?watchside_campaign=${CAMPAIGN}`,
    )
  })

  it('accepts a trailing slash and any capitalisation', () => {
    for (const url of [
      `https://watchside.app/c/${CAMPAIGN}/`,
      `https://watchside.app/c/${CAMPAIGN.toUpperCase()}`,
    ]) {
      expect(resolveCampaign(url).href).toBe(
        `https://www.twitch.tv/?watchside_campaign=${CAMPAIGN}`,
      )
    }
  })

  it('never sets the referral parameter on a campaign arrival', () => {
    // The failure this prevents is silent: a campaign visitor recorded as
    // having been invited by somebody, which is not true and cannot be undone.
    expect(resolveCampaign(`https://watchside.app/c/${CAMPAIGN}`).href).not.toContain(
      'kickback_invite',
    )
  })

  it('never sets the campaign parameter on a referral arrival', () => {
    expect(resolveInvite(`https://watchside.app/i/${CODE}`)).not.toContain('watchside_campaign')
  })

  it('does not tell a campaign visitor that a friend invited them', () => {
    // They were not invited by anybody they know, and saying so on the first
    // screen would be a small lie in the one place it is most visible.
    const { headline } = resolveCampaign(`https://watchside.app/c/${CAMPAIGN}`)
    expect(headline.toLowerCase()).not.toContain('friend invited you')
    expect(headline.length).toBeGreaterThan(0)
  })

  it.each([
    ['a malformed code', 'https://watchside.app/c/NOT A CODE'],
    ['a traversal', 'https://watchside.app/c/..%2F..%2Fevil'],
    ['a smuggled absolute URL', 'https://watchside.app/c/https%3A%2F%2Fevil.example.com'],
    ['the bare route', 'https://watchside.app/c/'],
  ])('leaves the page a plain 404 for %s', (_label, url) => {
    expect(resolveCampaign(url).href).toBeNull()
  })

  it('ignores a source somebody appended to the URL', () => {
    /*
     * The whole reason a campaign link carries a code and nothing else. A
     * visitor writing `?source=official_twitch_partnership` changes nothing,
     * because there is no source in the URL for anything to read.
     */
    const forged = resolveCampaign(
      `https://watchside.app/c/${CAMPAIGN}?source=official_twitch_partnership&utm_medium=paid`,
    )
    expect(forged.href).toBe(`https://www.twitch.tv/?watchside_campaign=${CAMPAIGN}`)
    expect(forged.href).not.toContain('source=official')
    expect(forged.href).not.toContain('utm_')
  })

  it('still loads nothing from anywhere else', () => {
    /*
     * The campaign route added script; it must not have added a request.
     *
     * `www.w3.org/2000/svg` is allowed because it is an XML namespace, not an
     * address. It appears in the inline favicon, where a standalone SVG will not
     * parse without it, and no browser has ever fetched an xmlns. Everything
     * else on this list is a link a person can click, not something the page
     * loads by itself.
     */
    const html = readFileSync(join(OUT, '404.html'), 'utf8')
    expect(html).not.toMatch(
      /https?:\/\/(?!www\.twitch\.tv|chromewebstore|addons\.mozilla\.org|www\.w3\.org\/2000\/svg)/,
    )
  })

  /**
   * An invite that lands a Firefox user on a Chrome-only page is a dead end.
   *
   * This is where invite links resolve, so it is the first thing a friend of a
   * user sees. It offered Chrome alone for as long as that was the only store
   * Watchside was in; both are live now, and both belong here.
   */
  it('offers both browsers, because this is where invites land', () => {
    const html = readFileSync(join(OUT, '404.html'), 'utf8')
    expect(html).toContain('chromewebstore.google.com')
    expect(html).toContain('addons.mozilla.org/firefox/addon/watchside/')
  })
})
