import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * The Store listing set is valid, complete and actually committed.
 *
 * WHY THIS IS WORTH A TEST
 *
 * A store listing is the one surface where being wrong is invisible from inside
 * the product: nothing fails, no user complains, and the only symptom is that
 * fewer people install. The failure modes are all quiet - a screenshot at the
 * wrong size that the dashboard silently rejects, a set that lost a file, an
 * image that stopped being committed because `*.png` is ignored by default.
 *
 * WHAT IT DOES NOT CHECK
 *
 * Whether the screenshots are any good. That is the one genuinely human part of
 * this milestone and it is answered from the contact sheet, not from here.
 */

const CURRENT = join('assets', 'store', 'current')

/** PNG dimensions from the IHDR chunk. */
function dimensions(file: string): { width: number; height: number } {
  const buffer = readFileSync(file)
  expect(buffer.toString('ascii', 1, 4), `${file} is not a PNG`).toBe('PNG')
  return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) }
}

/*
 * The order is the argument, so the order is asserted. A store visitor reads
 * the first screenshot and decides; the rest exist to make it credible.
 */
const SEQUENCE = [
  'store-01-presence.png',
  'store-02-gravity-join.png',
  'store-03-together.png',
  'store-04-find-friends.png',
]

describe('the Chrome listing set', () => {
  const dir = join(CURRENT, 'chrome')

  it('has every screenshot in the sequence', () => {
    for (const file of SEQUENCE) {
      expect(existsSync(join(dir, file)), `${file} is missing`).toBe(true)
    }
  })

  it('is within the five-screenshot limit', () => {
    // Chrome accepts at most five; more are silently dropped rather than
    // refused, which is the kind of thing nobody notices for a month.
    const shots = readdirSync(dir).filter((f) => f.startsWith('store-'))
    expect(shots.length).toBeLessThanOrEqual(5)
    expect(shots.length).toBeGreaterThanOrEqual(1)
  })

  it('is 1280x800 throughout, which is what the dashboard requires', () => {
    for (const file of SEQUENCE) {
      const dim = dimensions(join(dir, file))
      expect(dim, `${file}`).toEqual({ width: 1280, height: 800 })
    }
  })

  it('keeps the promo tile at 440x280', () => {
    expect(dimensions(join(dir, 'chrome-promo-440x280.png'))).toEqual({ width: 440, height: 280 })
  })
})

describe('the Firefox listing set', () => {
  const dir = join(CURRENT, 'firefox')

  it('tells the same story, because the product does not change between browsers', () => {
    for (const file of SEQUENCE) {
      expect(existsSync(join(dir, file)), `${file} is missing`).toBe(true)
      // Byte-identical rather than merely present: two drifting sets is two
      // things to keep in step, and nobody would notice when one stopped.
      expect(readFileSync(join(dir, file)).equals(readFileSync(join(CURRENT, 'chrome', file)))).toBe(
        true,
      )
    }
  })

  it('keeps the AMO header at 1400x560', () => {
    expect(dimensions(join(dir, 'amo-header-1400x560.png'))).toEqual({ width: 1400, height: 560 })
  })
})

describe('the set is actually committed', () => {
  it('survives the repository-wide *.png ignore', () => {
    /*
     * The real risk. `.gitignore` ignores every PNG by default, so an asset
     * that looks present on disk can be absent from the repository - and the
     * owner would discover that only when trying to re-upload after a listing
     * edit, with the originals gone.
     */
    const tracked = execFileSync('git', ['ls-files', CURRENT], { encoding: 'utf8' })
      .split('\n')
      .filter(Boolean)

    for (const file of SEQUENCE) {
      expect(tracked.some((t) => t.endsWith(`chrome/${file}`)), `${file} is not tracked`).toBe(true)
    }
    expect(tracked.some((t) => t.endsWith('contact-sheet.png'))).toBe(true)
    expect(tracked.some((t) => t.endsWith('SEQUENCE.md'))).toBe(true)
  })

  it('carries a contact sheet for visual acceptance', () => {
    const sheet = join(CURRENT, 'contact-sheet.png')
    expect(existsSync(sheet)).toBe(true)
    const dim = dimensions(sheet)
    // Wide enough to show two columns of 1280-wide shots side by side.
    expect(dim.width).toBeGreaterThanOrEqual(1400)
    expect(dim.height).toBeGreaterThan(dim.width * 0.5)
  })
})

describe('the sequence document matches the files', () => {
  it('names every screenshot, in order', () => {
    const doc = readFileSync(join(CURRENT, 'SEQUENCE.md'), 'utf8')
    let cursor = -1
    for (const file of SEQUENCE) {
      const at = doc.indexOf(file)
      expect(at, `${file} is not in SEQUENCE.md`).toBeGreaterThan(-1)
      expect(at, `${file} is out of order in SEQUENCE.md`).toBeGreaterThan(cursor)
      cursor = at
    }
  })

  it('gives each one a beat rather than a filename', () => {
    // A caption that just restates the filename is not a story.
    const doc = readFileSync(join(CURRENT, 'SEQUENCE.md'), 'utf8')
    for (const beat of [
      'See where your friends are watching',
      'Jump into the stream',
      'Watch together',
      'Find your Twitch friends',
    ]) {
      expect(doc).toContain(beat)
    }
  })
})

describe('nothing private or stale reached the listing', () => {
  it('names no stale brand anywhere in the asset documentation', () => {
    const doc = readFileSync(join(CURRENT, 'SEQUENCE.md'), 'utf8')
    expect(doc).not.toMatch(/kickback/i)
  })

  it('keeps every file within a sane upload size', () => {
    /*
     * Not a hard Store limit so much as a smell: a screenshot several megabytes
     * large is usually an accidental scale factor rather than a better picture.
     */
    for (const dir of ['chrome', 'firefox']) {
      for (const file of readdirSync(join(CURRENT, dir))) {
        const size = statSync(join(CURRENT, dir, file)).size
        expect(size, `${dir}/${file} is ${(size / 1024 / 1024).toFixed(1)} MB`).toBeLessThan(
          3 * 1024 * 1024,
        )
      }
    }
  })
})
