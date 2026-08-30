import { globSync, readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { AVATAR_SIZE } from '../../src/ui/avatarSizes'

/**
 * The avatar size system, pinned.
 *
 * WHAT THIS PROTECTS
 *
 * Avatars used to be sized at the call site: 18 in one stack, 20 in another,
 * 22 for the header and for a hand-rolled channel avatar, 30 for rows. Most of
 * those differences were nobody's decision - they were the number whoever
 * wrote the component happened to pick - and they read as inconsistency.
 *
 * Two properties keep that from coming back. Sizes come from the scale rather
 * than from literals, and every step of the scale is a multiple of 4 so a
 * circle's diameter lands on whole device pixels at every display scale
 * Windows offers.
 */

/** Every scale factor Windows exposes in Display settings. */
const WINDOWS_SCALES = [1, 1.25, 1.5, 1.75, 2, 2.25, 2.5, 3]

describe('the avatar scale', () => {
  it('has one step per level of prominence, largest first', () => {
    expect(AVATAR_SIZE.row).toBeGreaterThan(AVATAR_SIZE.person)
    expect(AVATAR_SIZE.person).toBeGreaterThan(AVATAR_SIZE.stack)
  })

  /**
   * The reason the numbers are what they are. A circle can only rasterise
   * symmetrically when both of its edges sit on a device pixel, which means the
   * diameter has to be a whole number of them. Multiples of 4 are the only
   * integers that survive every scale factor - 30 became 37.5 device pixels at
   * 125%, which is exactly the case this rules out.
   */
  it('lands on whole device pixels at every Windows display scale', () => {
    for (const [name, size] of Object.entries(AVATAR_SIZE)) {
      for (const scale of WINDOWS_SCALES) {
        expect(
          Number.isInteger(size * scale),
          `${name} (${size}px) is ${size * scale} device px at ${scale * 100}%`,
        ).toBe(true)
      }
    }
  })

  /** Which is the same as saying they are multiples of four. */
  it('is a four-pixel grid', () => {
    for (const size of Object.values(AVATAR_SIZE)) expect(size % 4).toBe(0)
  })
})

describe('components size avatars from the scale', () => {
  const sources = globSync('src/ui/**/*.tsx').map((path) => ({
    path,
    text: readFileSync(path, 'utf8'),
  }))

  it('found the components to check', () => {
    expect(sources.length).toBeGreaterThan(10)
  })

  /**
   * A numeric literal in a `size=` prop on an Avatar is the exact habit that
   * produced the drift. The scale is a named import; use it.
   */
  it('passes no numeric literal to an Avatar size', () => {
    for (const { path, text } of sources) {
      const literals = [...text.matchAll(/<Avatar[^>]*?\ssize=\{(\d+)\}/gs)].map((m) => m[1])
      expect(literals, `${path} sizes an Avatar with a literal`).toEqual([])
    }
  })

  /**
   * SocialGravity draws a channel's avatar by hand rather than through Avatar,
   * because a channel is not a User. It still has to agree with the people
   * beside it, so it reads the same scale.
   */
  it('sizes the hand-rolled channel avatar from the scale too', () => {
    const gravity = readFileSync('src/ui/components/SocialGravity.tsx', 'utf8')
    expect(gravity).toContain("from '../avatarSizes'")
    const head = gravity.slice(gravity.indexOf('kb-gravity-avatar'))
    expect(head.slice(0, 600)).not.toMatch(/width: \d+,/)
  })
})
