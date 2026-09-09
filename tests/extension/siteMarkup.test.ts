import { execFileSync } from 'node:child_process'
import { readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { beforeAll, describe, expect, it } from 'vitest'

/**
 * The generated site is well-formed HTML, and its CSS is CSS.
 *
 * WHY THIS EXISTS
 *
 * watchside.app shipped with forty-nine lines of stylesheet printed at the top
 * of the homepage as visible body text - the campaign `.continue` rules, the
 * comment above them included, rendered to every visitor as literal characters.
 *
 * The cause was not CSS and not the template. `landing.css` is not a stylesheet
 * despite the extension: it is an HTML fragment that carries its own <style>
 * element, because the build drops it into the shell's head verbatim. New rules
 * were appended to the END of that file, which put them after `</style>`, which
 * put them in the document body. Every rule still parsed; nothing threw; the
 * build succeeded; the page was wrong.
 *
 * That is the shape of the risk worth testing. A stylesheet that breaks out of
 * its element produces no error anywhere in the toolchain - not in the build,
 * not in the browser, not in a smoke test that only asks whether the page has a
 * 200 and a title. The only thing that notices is a person looking at it.
 *
 * So this asserts the property directly: strip the elements whose contents are
 * not shown to a reader, and whatever is left must not look like CSS.
 */

/*
 * Its own output tree.
 *
 * campaignPages.test.ts and publicRouting.test.ts each build the same site in a
 * parallel worker, and sharing one directory raced them into an intermittent
 * EPIPE on Windows. Third build, third directory.
 */
const OUT = join('dist-site-markup')

const read = (...parts: string[]) => readFileSync(join(OUT, ...parts), 'utf8')

/** A campaign that exists in the committed registry. */
const CAMPAIGN = 'reddit-launch-a'

/**
 * What a reader actually sees.
 *
 * Everything whose content is instructions to the browser rather than words on
 * the page comes out - style and script elements, comments, and the tags
 * themselves. What remains is the text a visitor reads, which is the only place
 * the bug was ever visible.
 */
function visibleText(html: string): string {
  return html
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, ' ')
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<[^>]+>/g, ' ')
}

/** The shapes that mean "this is stylesheet source, not prose". */
const CSS_SIGNATURES: Array<[string, RegExp]> = [
  ['a CSS block comment', /\/\*[\s\S]*?\*\//],
  ['an at-rule', /@(media|supports|keyframes|font-face)\b/],
  ['a declaration', /[a-z-]+\s*:\s*[^;{}]+;/],
  ['a rule with a selector and a brace', /(^|\s)[.#][a-z][\w-]*\s*\{/i],
  ['a custom property', /--[a-z][\w-]*\s*:/i],
]

describe('the generated site renders no stylesheet as text', () => {
  beforeAll(() => {
    rmSync(OUT, { recursive: true, force: true })
    execFileSync(process.execPath, [join('scripts', 'build-site.mjs'), OUT], { stdio: 'pipe' })
  }, 60_000)

  const pages: Array<[string, string[]]> = [
    ['/', ['index.html']],
    [`/c/${CAMPAIGN}/`, ['c', CAMPAIGN, 'index.html']],
  ]

  for (const [label, parts] of pages) {
    describe(label, () => {
      it.each(CSS_SIGNATURES)('shows no %s to the reader', (_what, pattern) => {
        const text = visibleText(read(...parts))
        const found = pattern.exec(text)
        expect(
          found,
          found ? `stylesheet source is visible on ${label}: ${found[0].slice(0, 120)}` : '',
        ).toBeNull()
      })

      it('leaves no unsubstituted template placeholder', () => {
        // The same class of bug, one step earlier: a page that ships {{BODY}}
        // is also showing the reader something meant for the build.
        expect(visibleText(read(...parts))).not.toMatch(/\{\{[A-Z_]+\}\}/)
      })

      it('closes every style element it opens', () => {
        // Comments first: the shell's own documentation talks about its <style>
        // block, and prose about a tag is not a tag.
        const html = read(...parts).replace(/<!--[\s\S]*?-->/g, ' ')
        const open = html.match(/<style\b/gi)?.length ?? 0
        const close = html.match(/<\/style>/gi)?.length ?? 0
        expect(open, 'the page has at least one stylesheet').toBeGreaterThan(0)
        expect(close, 'every <style> is closed').toBe(open)
      })

      it('keeps the campaign continue rules inside a stylesheet', () => {
        /*
         * The styling has to SURVIVE the fix, not just stop leaking. Deleting
         * the rules would satisfy every assertion above and would silently
         * unstyle the post-install step that the whole campaign depends on.
         */
        const html = read(...parts)
        const styles = [...html.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style>/gi)]
          .map((match) => match[1])
          .join('\n')
        expect(styles).toMatch(/\.continue\s*\{/)
        expect(styles).toMatch(/\.continue-live\s*\{/)
      })
    })
  }

  describe(`/c/${CAMPAIGN}/ is still a complete campaign page`, () => {
    it('is a whole document', () => {
      const html = read('c', CAMPAIGN, 'index.html')
      expect(html.startsWith('<!doctype html>')).toBe(true)
      expect(html.trimEnd().endsWith('</html>')).toBe(true)
      expect(html).toContain('<body')
    })

    it('still renders the continue block, with its code, without script', () => {
      const html = read('c', CAMPAIGN, 'index.html')
      expect(html).toContain('id="continue-block"')
      expect(html).toContain(`watchside_campaign=${CAMPAIGN}`)
    })

    it('does not put the continue block on the homepage', () => {
      // It is campaign-only. A continue link on `/` would offer a handoff that
      // has no campaign to hand off.
      expect(read('index.html')).not.toContain('id="continue-block"')
    })
  })

  describe('security expectations are unchanged', () => {
    const policyOf = (html: string) =>
      /<meta[^>]+http-equiv="Content-Security-Policy"[^>]+content="([^"]+)"/i.exec(html)?.[1] ?? ''

    it.each([['index.html'], [join('c', CAMPAIGN, 'index.html')]])(
      '%s keeps the strict policy',
      (file) => {
        const policy = policyOf(read(file))
        expect(policy).toContain("default-src 'none'")
        expect(policy).toContain("script-src 'self'")
        expect(policy).toContain("connect-src 'none'")
      },
    )

    it('ships no inline script, so script-src self still holds', () => {
      for (const parts of [['index.html'], ['c', CAMPAIGN, 'index.html']]) {
        const inline = [...read(...parts).matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)]
        for (const [, attrs, body] of inline) {
          expect(attrs, 'every script is external').toMatch(/\ssrc=/)
          expect(body.trim(), 'no inline script body').toBe('')
        }
      }
    })
  })
})
