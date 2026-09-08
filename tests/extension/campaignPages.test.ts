import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { beforeAll, describe, expect, it } from 'vitest'
import { CODE_PATTERN, MEDIUMS, PROVIDERS, SOURCES } from '../../scripts/campaign-vocabulary.mjs'

/**
 * The acquisition surface of watchside.app: campaign pages, store tagging, and
 * the policy that keeps the site tracker-free.
 *
 * WHAT IS ACTUALLY AT RISK
 *
 * Not that a page renders. Five things, each of which fails silently and each
 * of which would waste real money:
 *
 *   * THE STORE LINK'S TAG. Untagged, the Chrome and AMO aggregate reports are
 *     the only midstream measurement in the whole funnel and they show nothing.
 *     A wrong tag is worse: it attributes one campaign's store traffic to
 *     another and nothing looks broken.
 *
 *   * `rel="noreferrer"`. Adding it looks like a security tidy-up and would
 *     silently destroy the store-side reporting, because the referrer is what
 *     the store attributes on. `noopener` is the one that closes the actual
 *     hole. They are different flags and only one of them is about safety.
 *
 *   * THE CAMPAIGN CODE IN THE CONTINUE LINK. It is the entire attribution
 *     chain. If it is wrong, absent, or reachable from the URL, the campaign
 *     measures nothing or measures somebody else.
 *
 *   * UTMs BECOMING AN INPUT. The whole design rests on the campaign code being
 *     authoritative and the query string being decoration. A code path that
 *     read a UTM back would make attribution forgeable by anybody with a URL bar.
 *
 *   * A THIRD-PARTY SCRIPT. The site's privacy claims are load-bearing marketing
 *     copy, on the page, twenty lines above the install button.
 */

const OUT = join('dist-site')
const SOURCE = join('docs', 'web', 'watchside-app')

const read = (...parts: string[]) => readFileSync(join(OUT, ...parts), 'utf8')

interface Campaign {
  code: string
  source: string
  provider?: string
  medium?: string
  content?: string
  term?: string
  label: string
}

const manifest = (): Campaign[] =>
  JSON.parse(readFileSync(join(SOURCE, 'campaigns.json'), 'utf8')).campaigns

beforeAll(() => {
  rmSync(OUT, { recursive: true, force: true })
  execFileSync(process.execPath, [join('scripts', 'build-site.mjs')], { stdio: 'pipe' })
}, 60_000)

// ------------------------------------------------------------ the manifest

describe('the campaign manifest is well formed', () => {
  it('names at least one campaign, so the rest of this suite is not vacuous', () => {
    expect(manifest().length).toBeGreaterThan(0)
  })

  it('uses only vocabulary the database will accept', () => {
    for (const campaign of manifest()) {
      expect(CODE_PATTERN.test(campaign.code), campaign.code).toBe(true)
      expect(SOURCES, campaign.code).toContain(campaign.source)
      if (campaign.provider) expect(PROVIDERS, campaign.code).toContain(campaign.provider)
      if (campaign.medium) expect(MEDIUMS, campaign.code).toContain(campaign.medium)
    }
  })

  /*
   * AMO truncates a UTM value at 40 characters. A value that arrives whole in
   * Chrome's report and cut in Firefox's is a value two reports disagree about,
   * and the disagreement would be discovered by nobody.
   */
  it('keeps every value that becomes a UTM inside 40 characters', () => {
    for (const campaign of manifest()) {
      for (const value of [campaign.code, campaign.provider, campaign.medium, campaign.content, campaign.term]) {
        if (value) expect(value.length, `${campaign.code}: ${value}`).toBeLessThanOrEqual(40)
      }
    }
  })
})

// ------------------------------------------------------- the campaign pages

describe('every campaign has a real page', () => {
  it('writes one file per campaign, so the route answers 200 rather than 404', () => {
    for (const campaign of manifest()) {
      expect(existsSync(join(OUT, 'c', campaign.code, 'index.html')), campaign.code).toBe(true)
    }
  })

  /*
   * The whole point of pre-rendering. A stripped 404 page was what paid traffic
   * used to land on, and buying clicks to it would have been buying clicks to
   * the worst page on the domain.
   */
  it('carries the full landing content, not the fallback page', () => {
    for (const campaign of manifest()) {
      const html = read('c', campaign.code, 'index.html')
      expect(html, campaign.code).toContain('See where your friends are')
      expect(html, campaign.code).toContain('img/presence.webp')
      expect(html, campaign.code).toContain('How it works')
      // Comparable in size to the root page, rather than to the 404.
      expect(html.length, campaign.code).toBeGreaterThan(read('404.html').length * 2)
    }
  })

  it('leaves no unresolved build placeholder anywhere', () => {
    for (const file of [
      ['index.html'],
      ['404.html'],
      ['support', 'index.html'],
      ...manifest().map((campaign) => ['c', campaign.code, 'index.html']),
    ]) {
      expect(read(...file), file.join('/')).not.toContain('{{')
    }
  })
})

// --------------------------------------------------------- the continue link

describe('the campaign code reaches Twitch', () => {
  it('points at twitch.tv carrying this campaign, and no other', () => {
    for (const campaign of manifest()) {
      const html = read('c', campaign.code, 'index.html')
      expect(html, campaign.code).toContain(
        `href="https://www.twitch.tv/?watchside_campaign=${campaign.code}"`,
      )
    }
  })

  /*
   * The continue block is rendered COMPLETE in the HTML rather than built by
   * script. Anybody blocking scripts still completes the journey - and the
   * people blocking scripts are exactly the people most likely to.
   */
  it('renders the continue step without needing JavaScript', () => {
    const html = read('c', manifest()[0].code, 'index.html')
    expect(html).toContain('id="continue-block"')
    expect(html).toContain('Continue to Twitch')
    /*
     * The BLOCK is not hidden. Asserting the whole page contains no "hidden"
     * would trip on every aria-hidden in the artwork - the assertion has to be
     * about the element, not about the word appearing somewhere.
     */
    const block = /<div class="([^"]*)" id="continue-block"[^>]*>/.exec(html)
    expect(block?.[1]).toBe('continue')
    expect(html).not.toMatch(/id="continue-block"[^>]*hidden/)
  })

  it('never appears on the ordinary landing page', () => {
    expect(read('index.html')).not.toContain('continue-block')
    expect(read('index.html')).not.toContain('watchside_campaign')
  })

  /*
   * The destination is baked at build time. Nothing at runtime reads the URL,
   * so there is nothing for a crafted link to redirect.
   */
  it('builds the destination from a literal, not from the address bar', () => {
    const script = codeOf(readFileSync(join(OUT, 'js', 'campaign.js'), 'utf8'))
    expect(script).not.toContain('location')
    expect(script).not.toContain('href =')
    expect(script).not.toContain('URLSearchParams')
  })
})

// ------------------------------------------------------------ store tagging

describe('store links carry the campaign, derived from the definition', () => {
  const hrefs = (html: string, host: string) =>
    [...html.matchAll(new RegExp(`href="(https://${host}[^"]*)"`, 'g'))].map((match) => match[1])

  it('tags both stores on a campaign page with that campaign', () => {
    for (const campaign of manifest()) {
      const html = read('c', campaign.code, 'index.html')
      for (const host of ['chromewebstore\\.google\\.com', 'addons\\.mozilla\\.org']) {
        const links = hrefs(html, host)
        expect(links.length, `${campaign.code} ${host}`).toBeGreaterThan(0)
        for (const link of links) {
          // Decoded, because the attribute is HTML-escaped.
          const url = new URL(link.replaceAll('&amp;', '&'))
          expect(url.searchParams.get('utm_source')).toBe(campaign.provider ?? campaign.source)
          expect(url.searchParams.get('utm_campaign')).toBe(campaign.code)
          if (campaign.medium) expect(url.searchParams.get('utm_medium')).toBe(campaign.medium)
          if (campaign.content) expect(url.searchParams.get('utm_content')).toBe(campaign.content)
        }
      }
    }
  })

  it('tags the ordinary landing page as site traffic, not as a campaign', () => {
    const html = read('index.html')
    for (const host of ['chromewebstore\\.google\\.com', 'addons\\.mozilla\\.org']) {
      for (const link of hrefs(html, host)) {
        const url = new URL(link.replaceAll('&amp;', '&'))
        expect(url.searchParams.get('utm_source')).toBe('watchside_site')
        expect(url.searchParams.get('utm_campaign')).toBe('site_landing')
        // Never a provider: nothing here was acquired by anybody.
        expect(PROVIDERS).not.toContain(url.searchParams.get('utm_source'))
      }
    }
  })

  it('escapes the ampersands, because these live in an HTML attribute', () => {
    const html = read('c', manifest()[0].code, 'index.html')
    expect(html).toContain('&amp;utm_campaign=')
    expect(html).not.toMatch(/href="https:\/\/chromewebstore[^"]*[^p;]&utm/)
  })
})

describe('store links open safely without destroying the measurement', () => {
  /*
   * The campaign page must survive the store visit: it holds the only link that
   * can hand the code to Twitch, and a same-tab navigation would take it away.
   */
  it('opens the store in a new tab from a campaign page', () => {
    for (const campaign of manifest()) {
      const html = read('c', campaign.code, 'index.html')
      const opens = html.split('target="_blank" rel="noopener"').length - 1
      expect(opens, campaign.code).toBe(4)
    }
  })

  /*
   * THE ONE A FUTURE TIDY-UP WOULD BREAK.
   *
   * `noreferrer` looks like it belongs beside `noopener` and would silently
   * destroy the store-side aggregate reporting, because the referrer is what
   * Chrome and AMO attribute on. `noopener` alone closes the window.opener
   * hole. Different flags; only one is about security.
   */
  it('never adds noreferrer, which would strip the referrer the stores need', () => {
    for (const campaign of manifest()) {
      expect(read('c', campaign.code, 'index.html'), campaign.code).not.toContain('noreferrer')
    }
    expect(read('index.html')).not.toContain('noreferrer')
  })

  it('leaves the ordinary landing page in the same tab', () => {
    expect(read('index.html')).not.toContain('target="_blank"')
  })
})

// ---------------------------------------------------------------- the policy

/** The policy itself, rather than any page that happens to discuss it. */
function policyOf(html: string): string {
  const match = /http-equiv="Content-Security-Policy"\s+content="([^"]*)"/.exec(html)
  if (!match) throw new Error('no Content-Security-Policy meta tag')
  return match[1]
}

/** A script with its comments removed, so a comment cannot answer for the code. */
function codeOf(script: string): string {
  return script.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
}

describe('the content security policy', () => {
  const PAGES = [
    ['index.html'],
    ['404.html'],
    ['support', 'index.html'],
    ['privacy', 'index.html'],
  ]

  it('is present on every page, including the one about privacy', () => {
    for (const file of [...PAGES, ['c', manifest()[0].code, 'index.html']]) {
      expect(read(...file), file.join('/')).toContain('http-equiv="Content-Security-Policy"')
    }
  })

  it('denies everything it does not name', () => {
    for (const file of PAGES) {
      expect(read(...file), file.join('/')).toContain("default-src 'none'")
    }
  })

  /*
   * The line that would have to be edited before any analytics could phone
   * home, which is the point of writing it.
   */
  it('permits no outbound connection of any kind', () => {
    for (const file of PAGES) {
      expect(read(...file), file.join('/')).toContain("connect-src 'none'")
    }
  })

  it('allows scripts only from this origin, and never inline', () => {
    for (const file of PAGES) {
      const html = read(...file)
      expect(html, file.join('/')).toMatch(/script-src '(self|none)'/)
      // 'unsafe-inline' in script-src would make the policy decorative.
      const csp = /content="([^"]*)"/.exec(
        /http-equiv="Content-Security-Policy"\s+content="([^"]*)"/.exec(html)?.[0] ?? '',
      )?.[1]
      expect(csp, file.join('/')).toBeTruthy()
      expect(csp!.split(';').find((part) => part.includes('script-src'))).not.toContain(
        'unsafe-inline',
      )
    }
  })

  /*
   * Directives that are IGNORED in a meta tag are deliberately absent rather
   * than written and useless. GitHub Pages cannot set response headers, so
   * frame-ancestors and report-uri have no mechanism here, and writing them
   * would imply a protection that does not exist.
   */
  it('omits the directives a meta tag cannot enforce', () => {
    /*
     * Checked against the POLICY, not against the page. The shell explains in a
     * comment why frame-ancestors is absent, and a substring check over the
     * whole document would fail on the very sentence that documents it - the
     * same trap the "no trackers" assertion next door already learned.
     */
    for (const file of PAGES) {
      const csp = policyOf(read(...file))
      expect(csp, file.join('/')).not.toContain('frame-ancestors')
      expect(csp, file.join('/')).not.toContain('report-uri')
    }
  })

  it('is satisfiable: every script the site ships is same-origin and a file', () => {
    for (const file of [...PAGES, ['c', manifest()[0].code, 'index.html']]) {
      const html = read(...file)
      for (const tag of html.match(/<script[^>]*>/g) ?? []) {
        expect(tag, file.join('/')).toMatch(/src="\/js\/[a-z]+\.js"/)
      }
      // No inline script bodies at all.
      expect(html, file.join('/')).not.toMatch(/<script[^>]*>\s*[^<\s]/)
    }
  })
})

// ------------------------------------------------------------- still no ads

describe('the site is still tracker-free', () => {
  const ALL = () => [
    ['index.html'],
    ['404.html'],
    ['support', 'index.html'],
    ['privacy', 'index.html'],
    ...manifest().map((campaign) => ['c', campaign.code, 'index.html']),
  ]

  it('installs no Reddit pixel', () => {
    for (const file of ALL()) {
      const html = read(...file)
      expect(html, file.join('/')).not.toContain('redditstatic')
      expect(html, file.join('/')).not.toContain('rdt(')
      expect(html, file.join('/')).not.toContain('rdt_cid')
    }
  })

  it('installs no third-party analytics of any kind', () => {
    for (const file of ALL()) {
      const html = read(...file)
      for (const forbidden of ['googletagmanager', 'gtag(', 'plausible', 'segment.com', 'fbq(']) {
        expect(html, `${file.join('/')}: ${forbidden}`).not.toContain(forbidden)
      }
    }
  })

  /*
   * Corrected from the assertion this replaces, which read `ssrc=` - a typo
   * that meant it matched nothing and would have let an external script
   * through unnoticed. Scoped to EXTERNAL scripts, since the site now ships
   * two same-origin files on purpose.
   */
  it('loads no script, style, image or frame from another origin', () => {
    for (const file of ALL()) {
      const html = read(...file)
      expect(html, file.join('/')).not.toMatch(/<script[^>]+src="https?:/)
      expect(html, file.join('/')).not.toMatch(/<link[^>]+href="https?:/)
      expect(html, file.join('/')).not.toMatch(/<(img|iframe|source|video|audio)[^>]+src="https?:/)
    }
  })

  it('sets no cookie and stores nothing, on any page or in any script', () => {
    const scripts = ['route.js', 'campaign.js'].map((name) =>
      codeOf(readFileSync(join(OUT, 'js', name), 'utf8')),
    )
    for (const text of [...ALL().map((file) => read(...file)), ...scripts]) {
      for (const forbidden of ['document.cookie', 'localStorage', 'sessionStorage', 'indexedDB']) {
        expect(text).not.toContain(forbidden)
      }
    }
  })

  /* No visitor measurement was introduced. There is nothing to send anywhere. */
  it('makes no network request from any script', () => {
    for (const name of ['route.js', 'campaign.js']) {
      const script = codeOf(readFileSync(join(OUT, 'js', name), 'utf8'))
      for (const forbidden of ['fetch(', 'XMLHttpRequest', 'sendBeacon', 'WebSocket', 'new Image']) {
        expect(script, `${name}: ${forbidden}`).not.toContain(forbidden)
      }
    }
  })
})

// -------------------------------------------------- campaigns are not invites

describe('acquisition and friend referral stay separate systems', () => {
  it('never emits an invite parameter from a campaign page', () => {
    for (const campaign of manifest()) {
      expect(read('c', campaign.code, 'index.html'), campaign.code).not.toContain('kickback_invite')
    }
  })

  it('keeps the two routes on different prefixes', () => {
    for (const campaign of manifest()) {
      expect(existsSync(join(OUT, 'i', campaign.code, 'index.html')), campaign.code).toBe(false)
    }
  })
})
