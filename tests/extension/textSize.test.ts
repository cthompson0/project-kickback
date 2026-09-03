import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  DEFAULT_TEXT_SIZE,
  TEXT_SIZES,
  parseTextSize,
  readTextSize,
  scaleFor,
  writeTextSize,
} from '../../src/ui/textSize'

/**
 * The text-size preference.
 *
 * WHAT IT IS FOR: "Watchside should offer font-size options / basic
 * accessibility controls." One number reaches every font-size in the sheet,
 * and reaches nothing else.
 *
 * The layout consequences of the setting were measured in real Chrome rather
 * than asserted here - jsdom has no layout engine - across ten surfaces, three
 * sizes and panels from 280x340 to 560x720. Two defects came out of that and
 * are guarded below by the rules that fixed them.
 */

const CSS = readFileSync(join(process.cwd(), 'src', 'ui', 'kickback.css'), 'utf8')

describe('the scale is one number, and it reaches every font-size', () => {
  it('leaves no unscaled font-size anywhere in the sheet', () => {
    /*
     * THE POINT OF THE WHOLE DESIGN. A single font-size left as a bare px
     * value is a surface that silently ignores the setting, and it would be
     * invisible until somebody who needs the setting opened that surface.
     */
    const bare = CSS.match(/font-size:\s*\d+(\.\d+)?px/g) ?? []
    expect(bare, `unscaled: ${bare.join(', ')}`).toEqual([])
  })

  it('scales a lot of declarations from one token', () => {
    const scaled = CSS.match(/font-size:\s*calc\([\d.]+px \* var\(--kb-text-scale, 1\)\)/g) ?? []
    expect(scaled.length).toBeGreaterThan(100)
  })

  it('listens on the same storage key it writes', () => {
    const panel = readFileSync(join(process.cwd(), 'src', 'ui', 'KickbackPanel.tsx'), 'utf8')
    // A mismatch here would not fail anywhere else: the write would land,
    // the panel would look right, and only another open tab would be wrong.
    expect(panel).toContain('useStorageSync(TEXT_SIZE_KEY')
    expect(panel).toContain('readTextSize')
  })

  it('defines the token so the sheet stands on its own', () => {
    expect(CSS).toMatch(/--kb-text-scale:\s*1;/)
  })

  it('scales text and NOTHING else', () => {
    /*
     * The line between this and `zoom`. Padding, gaps, icon boxes, radii and
     * the panel's own geometry must not follow the text - a person who needs
     * bigger type has the same screen they had before, and a panel that grows
     * to match has helped them with nothing.
     */
    const scaled = [...CSS.matchAll(/([a-z-]+):\s*calc\([^;]*--kb-text-scale[^;]*\);/g)]
    const properties = [...new Set(scaled.map((m) => m[1]))]
    expect(properties).toEqual(['font-size'])
  })
})

describe('the preference survives anything that could be in storage', () => {
  const original = globalThis.window

  beforeEach(() => {
    const store: Record<string, string> = {}
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ;(globalThis as any).window = {
      localStorage: {
        getItem: (k: string) => store[k] ?? null,
        setItem: (k: string, v: string) => {
          store[k] = v
        },
      },
    }
  })
  afterEach(() => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ;(globalThis as any).window = original
  })

  it('round-trips every size it offers', () => {
    for (const entry of TEXT_SIZES) {
      writeTextSize(entry.id)
      expect(readTextSize()).toBe(entry.id)
    }
  })

  it('falls back rather than rendering at an unknown size', () => {
    // This is read during the FIRST PAINT. A bad value - an older build, a
    // hand-edited key, a half-written write - must not stop the panel drawing.
    for (const bad of [null, '', 'huge', '1.4', '{}', 'DEFAULT', 'null']) {
      expect(parseTextSize(bad)).toBe(DEFAULT_TEXT_SIZE)
    }
  })

  it('never yields a scale that would collapse or explode the panel', () => {
    for (const entry of TEXT_SIZES) {
      expect(scaleFor(entry.id)).toBeGreaterThanOrEqual(1)
      expect(scaleFor(entry.id)).toBeLessThanOrEqual(1.5)
    }
    // Including for a value that is not a size at all.
    expect(scaleFor('nonsense' as never)).toBe(1)
  })

  it('survives storage being unavailable entirely', () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ;(globalThis as any).window = {
      localStorage: {
        getItem: () => {
          throw new Error('denied')
        },
        setItem: () => {
          throw new Error('denied')
        },
      },
    }
    expect(readTextSize()).toBe(DEFAULT_TEXT_SIZE)
    expect(() => writeTextSize('xlarge')).not.toThrow()
  })

  it('starts at the default, so nobody is opted in to a change', () => {
    expect(readTextSize()).toBe(DEFAULT_TEXT_SIZE)
    expect(scaleFor(DEFAULT_TEXT_SIZE)).toBe(1)
  })
})

describe('what larger text broke, and the rules that hold it', () => {
  const rule = (selector: string) => {
    const at = CSS.indexOf(selector + ' {')
    expect(at, `${selector} should exist`).toBeGreaterThan(-1)
    return CSS.slice(at + selector.length, CSS.indexOf('}', at))
  }

  it('never lets the streamer tab shrink to an unhittable sliver', () => {
    /*
     * MEASURED. At 280px with Extra Large text the tab row came to 221px of
     * chrome, and the streamer tab absorbed the shortfall: 4px wide, still in
     * the tab order, still carrying a click handler, and impossible to see or
     * hit. A floor turns that into the failure the tab was built for - it
     * ellipses instead.
     */
    const declarations = rule('.kb-tab-session')
    const min = /min-width:\s*([^;]+);/.exec(declarations)
    expect(min, 'the streamer tab needs a floor').not.toBeNull()
    expect(min![1].trim()).not.toBe('0')
    // In em, so the floor grows with the text that is squeezing it.
    expect(min![1]).toMatch(/em/)
  })

  it('lets the tab row wrap rather than push a control off the panel', () => {
    // With the floor in place the row genuinely does not fit at 280 + Extra
    // Large, and Add was overflowing 19px past the edge. Wrapping costs one
    // row of height in that corner only; raising MIN_WIDTH would have charged
    // every panel for a setting most people never turn on.
    expect(rule('.kb-tabs')).toMatch(/flex-wrap:\s*wrap/)
  })

  it('keeps the emote picker a picker when it gives way', () => {
    /*
     * MEASURED. At Extra Large in a 400px panel the picker shrank to 12px
     * around 51px of content, at every width - opened deliberately, drawn as
     * an empty sliver. It still yields before the composer; it just stops
     * yielding past the point where it is still a thing.
     */
    const min = /min-height:\s*([^;]+);/.exec(rule('.kb-emote-picker'))
    expect(min, 'the picker needs a floor').not.toBeNull()
    expect(min![1].trim()).not.toBe('0')
    expect(min![1]).toMatch(/em/)
  })

  it('does not grow the gaps along with the text', () => {
    // Spacing that scales with type spends the width it is trying to save.
    expect(rule('.kb-tabs')).not.toMatch(/gap:[^;]*--kb-text-scale/)
  })
})
