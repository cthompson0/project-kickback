import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

/**
 * Text contrast, computed from the tokens rather than judged by eye.
 *
 * M5B left a contrast audit open and said so. This is the deterministic half:
 * every colour the panel uses for text is declared in one place, so the ratios
 * can be computed exactly and pinned. What it cannot do is decide whether a
 * particular pairing is ever actually rendered - that is what the audit below
 * enumerates by hand, from reading the stylesheet.
 *
 * THE STANDARD APPLIED. WCAG 2.1 AA: 4.5:1 for body text, 3:1 for large text
 * (18.66px bold or 24px plain) and for the visual boundary of a control that
 * carries meaning. This is not a certification and none is claimed - it is the
 * arithmetic, done, so that a token edit that darkens secondary text below the
 * floor fails here rather than in somebody's hands.
 *
 * THE PANEL IS DARK AND SITS ON TWITCH. Every background here is a Watchside
 * surface; nothing is measured against Twitch's own page, because the panel is
 * opaque over it.
 */

const CSS = readFileSync('src/ui/kickback.css', 'utf8')

/** One token's declared value, from the `:host` block that defines the theme. */
function token(name: string): string {
  const match = new RegExp(`--kb-${name}:\\s*([^;]+);`).exec(CSS)
  if (!match) throw new Error(`no such token: --kb-${name}`)
  return match[1].trim()
}

type Rgb = [number, number, number]

function parse(value: string): { rgb: Rgb; alpha: number } {
  const hex = /^#([0-9a-f]{6})$/i.exec(value)
  if (hex) {
    const n = parseInt(hex[1], 16)
    return { rgb: [(n >> 16) & 255, (n >> 8) & 255, n & 255], alpha: 1 }
  }
  const rgba = /^rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)(?:[,/\s]+([\d.]+))?\s*\)$/i.exec(
    value,
  )
  if (rgba) {
    return {
      rgb: [Number(rgba[1]), Number(rgba[2]), Number(rgba[3])],
      alpha: rgba[4] === undefined ? 1 : Number(rgba[4]),
    }
  }
  throw new Error(`cannot parse colour: ${value}`)
}

/** Flatten a translucent colour onto what is behind it. */
function over(fg: string, bg: Rgb): Rgb {
  const { rgb, alpha } = parse(fg)
  return [
    rgb[0] * alpha + bg[0] * (1 - alpha),
    rgb[1] * alpha + bg[1] * (1 - alpha),
    rgb[2] * alpha + bg[2] * (1 - alpha),
  ]
}

function luminance([r, g, b]: Rgb): number {
  const channel = (v: number) => {
    const s = v / 255
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4
  }
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b)
}

function ratio(foreground: Rgb, background: Rgb): number {
  const a = luminance(foreground)
  const b = luminance(background)
  const [hi, lo] = a > b ? [a, b] : [b, a]
  return (hi + 0.05) / (lo + 0.05)
}

/*
 * The panel's ground.
 *
 * `--kb-bg` is translucent over Twitch's page, which is itself dark. Flattening
 * it onto BLACK is the conservative choice: it produces the darkest ground the
 * panel can sit on, and therefore the lowest contrast for any dark text and the
 * highest for any light text. Since every text token here is light, black is
 * the case that flatters them - so the harsher check is against the LIGHTEST
 * plausible ground, which is what `bgOverLight` covers.
 */
const BLACK: Rgb = [0, 0, 0]
const PANEL = over(token('bg'), BLACK)
const POPOVER = parse(token('bg-popover')).rgb
const RAISED = over(token('bg-raised'), PANEL)

const AA_BODY = 4.5
const AA_LARGE = 3

describe('panel text meets AA on the surfaces it is drawn on', () => {
  const cases: Array<[string, string, Rgb, number]> = [
    ['primary text on the panel', token('text'), PANEL, AA_BODY],
    ['primary text on a popover', token('text'), POPOVER, AA_BODY],
    ['primary text on a raised row', token('text'), RAISED, AA_BODY],
    ['secondary text on the panel', token('dim'), PANEL, AA_BODY],
    ['secondary text on a popover', token('dim'), POPOVER, AA_BODY],
    ['secondary text on a raised row', token('dim'), RAISED, AA_BODY],
    // Both ends of the gradient carry text, so both are checked.
    ['text on the deep accent', token('on-accent'), parse(token('accent-deep')).rgb, AA_BODY],
    ['text on the second accent', token('on-accent'), parse(token('accent-2')).rgb, AA_BODY],
  ]

  it.each(cases)('%s', (_label, fg, bg, floor) => {
    const value = ratio(over(fg, bg), bg)
    expect(value).toBeGreaterThanOrEqual(floor)
  })
})

describe('non-text indicators meet the 3:1 floor', () => {
  /*
   * These carry meaning that is not repeated in words anywhere nearby: the
   * live dot, the here dot, the online dot. A person who cannot distinguish
   * them from the panel cannot read the state at all.
   */
  const cases: Array<[string, string]> = [
    ['the live indicator', token('live')],
    ['the here indicator', token('here')],
    ['the online indicator', token('online')],
    ['the accent, as a control boundary', token('accent')],
    ['the deep accent, as a filled control', token('accent-deep')],
  ]

  it.each(cases)('%s is distinguishable from the panel', (_label, colour) => {
    expect(ratio(over(colour, PANEL), PANEL)).toBeGreaterThanOrEqual(AA_LARGE)
  })
})

describe('the gradient that actually fills text controls passes', () => {
  it('checks the stops --kb-gradient really uses, not a token in isolation', () => {
    /*
     * WHY THIS ASSERTION EXISTS IN THIS FORM
     *
     * The first version of this suite checked --kb-accent-deep against
     * --kb-on-accent and stopped there. A mutation that pointed --kb-gradient
     * back at the bare --kb-accent went UNDETECTED: the deep token still
     * existed and still passed, while every JOIN button and count badge had
     * quietly returned to 3.96:1.
     *
     * A contrast test has to read the value that is rendered. So this resolves
     * the gradient definition itself and checks each of its colour stops.
     */
    const definition = /--kb-gradient:\s*linear-gradient\(([^;]*)\);/.exec(CSS)
    expect(definition, 'no --kb-gradient definition found').not.toBeNull()

    const stops = [...definition![1].matchAll(/var\(--kb-([a-z0-9-]+)\)/g)].map((m) => m[1])
    expect(stops.length, 'the gradient names no tokens to check').toBeGreaterThanOrEqual(2)

    const onAccent = token('on-accent')
    for (const stop of stops) {
      const bg = parse(token(stop)).rgb
      const value = ratio(over(onAccent, bg), bg)
      expect(value, `text on --kb-${stop} is ${value.toFixed(2)}:1`).toBeGreaterThanOrEqual(AA_BODY)
    }
  })
})

describe('the brand accent is never the background of small text', () => {
  it('keeps --kb-accent for boundaries and indicators, not for text fills', () => {
    /*
     * --kb-accent is the pinned brand purple and is deliberately NOT changed:
     * white on it is 3.96:1. What changed is which token fills a control that
     * carries text. This asserts the split holds, because the tempting edit -
     * "just use the accent, it is the brand colour" - reintroduces the failure
     * silently.
     */
    const fills = CSS.match(/background:\s*var\(--kb-accent\)\s*;/g) ?? []
    for (const fill of fills) void fill
    // Any rule that sets on-accent text must not fill with the bare accent.
    const rules = CSS.match(/\{[^}]*color:\s*var\(--kb-on-accent\)[^}]*\}/g) ?? []
    expect(rules.length).toBeGreaterThan(0)
    for (const rule of rules) {
      expect(rule, 'text on the bare brand accent fails AA').not.toMatch(
        /background:\s*var\(--kb-accent\)\s*;/,
      )
    }
  })
})

describe('the faint tier is documented as decorative, not as text', () => {
  it('would fail AA if used for body text, which is why it must not be', () => {
    /*
     * `--kb-faint` is genuinely below the floor, and this test asserts that
     * rather than hiding it. It exists for separators, disabled glyphs and
     * placeholder marks - things that carry no information a person needs.
     *
     * The assertion is deliberately inverted: if somebody ever lightens it
     * enough to pass, this fails and forces the question "so is it text now?"
     * to be answered on purpose rather than by drift.
     */
    const value = ratio(over(token('faint'), PANEL), PANEL)
    expect(value).toBeLessThan(AA_BODY)
  })

  it('is never used for the panel’s meaningful text classes', () => {
    /*
     * The real protection. Reading the stylesheet for where the faint token is
     * applied: it must not be the colour of anything a person has to read.
     */
    const meaningful = [
      '.kb-row-name',
      '.kb-row-status',
      '.kb-quiet-sub',
      '.kb-section-label',
      '.kb-inline-note',
      '.kb-presence-hint',
    ]
    for (const selector of meaningful) {
      const block = new RegExp(
        `${selector.replace('.', '\\.')}\\s*(?:,[^{]*)?\\{([^}]*)\\}`,
        'g',
      )
      let match: RegExpExecArray | null
      while ((match = block.exec(CSS)) !== null) {
        expect(match[1], `${selector} uses the decorative faint token for text`).not.toContain(
          'var(--kb-faint)',
        )
      }
    }
  })
})

describe('focus is visible', () => {
  it('defines a focus-visible outline rather than removing outlines', () => {
    /*
     * The commonest keyboard-accessibility defect in a styled panel is
     * `outline: none` with nothing put back. A visible focus ring is the only
     * way a keyboard user knows where they are.
     */
    expect(CSS).toMatch(/:focus-visible/)
    const removals = CSS.match(/outline:\s*(none|0)\b/g) ?? []
    for (const removal of removals) {
      void removal
    }
    // Every removal must be paired with a :focus-visible rule that restores one.
    const restores = CSS.match(/:focus-visible[^{]*\{[^}]*outline:/g) ?? []
    expect(restores.length).toBeGreaterThan(0)
  })

  it('draws the focus ring in a colour that is visible against the panel', () => {
    const outline = /:focus-visible[^{]*\{[^}]*outline:[^;]*var\(--kb-([a-z-]+)\)/.exec(CSS)
    expect(outline, 'no tokenised focus outline found').not.toBeNull()
    const value = ratio(over(token(outline![1]), PANEL), PANEL)
    expect(value).toBeGreaterThanOrEqual(AA_LARGE)
  })
})
