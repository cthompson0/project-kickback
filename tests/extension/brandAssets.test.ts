import { existsSync, readFileSync, statSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import {
  BRAND_SIZES,
  EXTENSION_SIZES,
  ICON_SIZES,
  MARK,
  SMALL_UP_TO,
  VIOLET,
  iconPath,
  markSvg,
  variantFor,
} from '../../assets/brand/geometry.mjs'

/**
 * The brand, pinned.
 *
 * WHAT THIS PROTECTS
 *
 * The mark used to exist twice - once as an SVG file, once hand-copied into a
 * React component - with a comment asking whoever edited one to remember the
 * other. Nothing failed when somebody forgot. Now there is a single geometry
 * module and everything derives from it, and these tests are what keep that
 * true: they fail if a second definition appears, if an expected icon size goes
 * missing, or if the Twitch brand colour turns up in ours.
 *
 * They deliberately do NOT re-render anything. `npm run verify:brand` does that
 * - it drives a real browser and compares bytes, which is the right check and
 * the wrong thing to put in a unit suite.
 */

/**
 * Source with comments removed.
 *
 * A colour named in prose - "deliberately NOT #9146FF" - is documentation, and
 * a colour in a declaration is a decision. These tests care about the second,
 * so the first is taken out before matching. Block comments, line comments and
 * HTML comments, which covers every surface in the list.
 */
function withoutComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/^\s*\/\/.*$/gm, ' ')
}

describe('the canonical mark has one definition', () => {
  /**
   * The component must not restate the geometry. It maps over MARK instead, so
   * a path string appearing in the TSX means the duplication has come back.
   */
  it('is not re-typed inside the React component', () => {
    const component = readFileSync('src/ui/components/Icons.tsx', 'utf8')

    expect(component).toContain("from '../../../assets/brand/geometry.mjs'")
    expect(component).toContain('MARK[variantFor(size)]')

    // Every path in the geometry, absent from the component.
    const paths = [...MARK.full.strokes, ...MARK.small.strokes, ...MARK.small.fills]
    expect(paths.length).toBeGreaterThan(3)
    for (const { id, d } of paths) {
      expect(component, `${id} is duplicated in Icons.tsx`).not.toContain(d)
    }
  })

  it('generates the committed SVGs from that one definition', () => {
    const files: Array<[string, string]> = [
      ['assets/brand/watchside-mark.svg', markSvg('full')],
      ['assets/brand/watchside-mark-small.svg', markSvg('small')],
      ['assets/brand/watchside-mark-bare.svg', markSvg('full', { ground: false })],
    ]
    for (const [path, expected] of files) {
      expect(existsSync(path), path).toBe(true)
      expect(readFileSync(path, 'utf8').trim(), path).toBe(expected)
    }
  })
})

describe('every expected icon exists', () => {
  it('covers all seven sizes', () => {
    expect(ICON_SIZES).toEqual([16, 32, 48, 64, 128, 512, 1024])
  })

  it('writes extension icons and brand icons to different trees', () => {
    // The manifests name these four; anything else is brand-only and must not
    // land in the shipped package, which is allow-listed by RUNTIME_FILES.
    expect(EXTENSION_SIZES).toEqual([16, 32, 48, 128])
    expect(BRAND_SIZES).toEqual([64, 512, 1024])
    for (const size of EXTENSION_SIZES) expect(iconPath(size)).toBe(`public/icons/icon-${size}.png`)
    for (const size of BRAND_SIZES) {
      expect(iconPath(size)).toBe(`assets/brand/icons/icon-${size}.png`)
    }
  })

  it('has a non-empty file on disk for each', () => {
    for (const size of ICON_SIZES) {
      const path = iconPath(size)
      expect(existsSync(path), `${path} is missing - run npm run brand`).toBe(true)
      // A PNG that renders to nothing is still a file; a size floor catches the
      // empty-capture failure that a mere existence check would pass.
      expect(statSync(path).size, path).toBeGreaterThan(200)
    }
  })

  it('matches what the Chromium manifest asks for', () => {
    const manifest = JSON.parse(readFileSync('public/manifest.json', 'utf8'))
    const declared = Object.keys(manifest.icons).map(Number).sort((a, b) => a - b)
    expect(declared).toEqual(EXTENSION_SIZES)
    for (const [size, path] of Object.entries(manifest.icons)) {
      expect(path).toBe(`icons/icon-${size}.png`)
    }
    expect(manifest.action.default_icon).toEqual(manifest.icons)
  })
})

describe('the size bands were chosen by measurement', () => {
  /**
   * 16 gets the solid silhouette, everything above gets the face. Both variants
   * were rasterised and compared pixel by pixel before this line was written;
   * see SMALL_UP_TO in the geometry module.
   */
  it('draws 16 from the small mark and 32 up from the full one', () => {
    expect(SMALL_UP_TO).toBe(16)
    expect(variantFor(16)).toBe('small')
    expect(variantFor(32)).toBe('full')
    expect(variantFor(1024)).toBe('full')
  })

  it('keeps the small variant simpler than the full one', () => {
    // The whole reason it exists: fewer marks, no eyes, heavier strokes.
    expect(MARK.small.circles).toHaveLength(0)
    expect(MARK.full.circles).toHaveLength(2)
    const smallStroke = MARK.small.strokes[0].width
    const fullStroke = MARK.full.strokes[0].width
    expect(smallStroke).toBeGreaterThan(fullStroke)
  })
})

describe('the accent is ours, not Twitch’s', () => {
  /**
   * #9146FF is Twitch's registered brand purple. Watchside is the social layer
   * FOR Twitch rather than a Twitch product, and wearing their colour says the
   * opposite - as well as being a trademark exposure on two store reviews.
   */
  it('never uses Twitch purple on a rendering surface', () => {
    expect(VIOLET.toLowerCase()).toBe('#a855f7')

    /*
     * Checked with COMMENTS STRIPPED, which is the difference between asserting
     * on a value and asserting on a word.
     *
     * Both the stylesheet and the geometry module name #9146FF in prose, saying
     * why the accent is deliberately not that. A first pass of this test failed
     * on exactly those two comments - on the documentation of the decision it
     * exists to protect. What matters is that the colour is never USED.
     */
    const surfaces = [
      'assets/brand/geometry.mjs',
      'assets/brand/tokens.mjs',
      'src/ui/kickback.css',
      'public/popup.html',
      'src/testlab/testlab.css',
      'docs/web/invite-landing/index.html',
      'scripts/build-privacy-page.mjs',
      'public/manifest.json',
    ]
    for (const path of surfaces) {
      expect(withoutComments(readFileSync(path, 'utf8')).toLowerCase(), path).not.toContain('9146ff')
    }
  })

  /** And the reasoning is written down where the colour is chosen. */
  it('records why, next to the value', () => {
    const geometry = readFileSync('assets/brand/geometry.mjs', 'utf8')
    expect(geometry).toContain('9146FF')
    expect(geometry.toLowerCase()).toContain('twitch')
  })

  it('left no trace of the previous orange and indigo identity', () => {
    const surfaces = [
      'src/ui/kickback.css',
      'public/popup.html',
      'src/testlab/testlab.css',
      'docs/web/invite-landing/index.html',
      'scripts/build-privacy-page.mjs',
      /*
       * The public site, added after M5B.
       *
       * It shipped painted in #ff8452 - an accent from the identity this test
       * exists to keep buried - and nothing caught it, because these files did
       * not exist when the list was written. A brand test protects the surfaces
       * it names and no others, so a new surface is a new entry or it is not
       * protected at all.
       */
      'docs/web/watchside-app/shell.html',
      'docs/web/watchside-app/pages/index.html',
      'docs/web/watchside-app/pages/support.html',
      'docs/web/watchside-app/pages/404.html',
      'docs/web/pages-watchside/index.html',
      'docs/web/pages-watchside/support/index.html',
    ]
    // The old accents, their gradient partner, and the navy icon ground.
    for (const stale of ['#ff8a00', '#6366f1', '#0f172a', '#ff8452']) {
      for (const path of surfaces) {
        expect(readFileSync(path, 'utf8').toLowerCase(), `${stale} in ${path}`).not.toContain(stale)
      }
    }
  })
})

describe('the panel token system', () => {
  const css = readFileSync('src/ui/kickback.css', 'utf8')

  it('defines the brand as tokens, including the alpha channel form', () => {
    for (const token of [
      '--kb-accent: #a855f7',
      '--kb-accent-2: #6d28d9',
      '--kb-accent-rgb: 168, 85, 247',
      '--kb-gradient:',
      '--kb-glow:',
      '--kb-radius-lg:',
      '--kb-on-accent:',
    ]) {
      expect(css, token).toContain(token)
    }
  })

  /**
   * One gradient and one glow, or "restrained" is unenforceable. Every gradient
   * in the sheet points at the token rather than restating the two colours.
   */
  it('keeps exactly one gradient definition and one glow', () => {
    /*
     * Exactly one gradient is built from the BRAND ACCENTS, and it is the
     * token's own definition - every accent gradient in the sheet points at
     * the token rather than restating the colours.
     *
     * Matched by the token name rather than by which accents compose it. The
     * previous form looked for `--kb-accent)` specifically, so it broke when
     * the definition changed which tokens it uses - which it did, when the
     * light end was deepened to clear the AA contrast floor for text sitting
     * on it (see contrast.test.ts). The rule being protected is "one accent
     * gradient", not "these two colours".
     *
     * The other two gradients are the here-tint and the combo wash. The combo
     * one does reference the accent, but as rgba(var(--kb-accent-rgb), …) - a
     * translucent tint rather than a solid accent stop, so it is not a second
     * brand gradient and is deliberately not counted.
     */
    const SOLID_ACCENT = /var\(--kb-accent(?:-deep|-2)?\)/
    const accentGradients = (css.match(/linear-gradient\([^;]*/g) ?? []).filter((g) =>
      SOLID_ACCENT.test(g),
    )
    expect(accentGradients).toHaveLength(1)
    expect(css).toMatch(/--kb-gradient:\s*linear-gradient\(/)

    const glowDefinitions = css.match(/--kb-glow:/g) ?? []
    expect(glowDefinitions).toHaveLength(1)
  })

  it('has no hard-coded rgba() copies of the accent left', () => {
    // The accent used to appear at fourteen different alphas as literals.
    expect(css).not.toMatch(/rgba\(255, ?132, ?82/)
    expect(css).toMatch(/rgba\(var\(--kb-accent-rgb\)/)
  })
})
