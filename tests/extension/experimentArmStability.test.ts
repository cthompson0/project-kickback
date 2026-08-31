import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { resolveArm, isRandomisedArm } from '../../src/core/experiment'

/**
 * The experiment arm must never move under an existing user.
 *
 * WHAT THIS PROTECTS
 *
 * Arm assignment is derived, not stored: a salted FNV-1a hash of the user id.
 * That is what makes it stable across devices and survive a cleared profile -
 * and it is also what makes it fragile in one specific way. Change the salt, or
 * change the hash, and EVERY existing user silently lands in a different arm.
 *
 * Nothing would fail. No test would go red, no error would surface, and the
 * numbers would keep arriving. The damage is only visible much later, as an
 * experiment whose two arms are contaminated by people who used to be in the
 * other one - and by then the affected data cannot be repaired, because nothing
 * recorded which arm a user was in before the change.
 *
 * The existing coverage in socialGravity.test.ts asserts the BEHAVIOUR:
 * deterministic, production-only, roughly even, override honoured. All of that
 * stays true under a different salt. So it cannot catch this.
 *
 * These tests pin the ANSWERS instead. They are golden values, and that is
 * deliberate: a golden test is the right shape when the property being defended
 * is "this must produce exactly what it produced yesterday".
 *
 * IF THIS TEST FAILS, DO NOT UPDATE THE EXPECTED VALUES.
 *
 * A failure here means live users have been re-randomised. The correct response
 * is to restore the salt and the hash, not to re-bless the output. The only
 * legitimate way to change either is a NEW experiment with a NEW salt constant
 * alongside the old one, so existing assignments are untouched.
 */

const SOURCE = readFileSync('src/core/experiment.ts', 'utf8')

describe('the experiment salt', () => {
  /**
   * Pinned as a literal, and deliberately not imported.
   *
   * SALT is module-private, which is correct - nothing should be able to read
   * or set it. Reading the source is therefore the only way to assert on it,
   * and it also catches the case an imported constant would not: somebody
   * renaming the product and "tidying" the string.
   */
  it('is exactly the value every existing assignment was derived from', () => {
    expect(SOURCE).toContain(`const SALT = 'kickback:social-gravity:v1'`)
  })

  /**
   * The name is Kickback-era and stays that way.
   *
   * M4.5 will audit legacy identifiers, and this one must survive that audit:
   * it is not branding, it is the input to a hash that thousands of assignments
   * already depend on. Renaming it to say "watchside" would be a cosmetic
   * change with the same effect as sabotage.
   */
  it('is not renamed for the Watchside rebrand', () => {
    expect(SOURCE).not.toContain(`'watchside:social-gravity`)
    expect(SOURCE).toMatch(/const SALT = 'kickback:/)
  })

  /** The hash itself is part of the contract, for the same reason. */
  it('is combined with the id by the same FNV-1a constants', () => {
    expect(SOURCE).toContain('0x811c9dc5')
    expect(SOURCE).toContain('0x01000193')
    expect(SOURCE).toContain('`${SALT}:${userId}`')
  })
})

describe('production arm assignments are frozen', () => {
  /**
   * Golden values, captured at v0.7.0.
   *
   * Any change to the salt, the hash, the concatenation order or the
   * even/odd rule moves at least one of these.
   */
  const FROZEN: ReadonlyArray<readonly [string, 'flat' | 'gravity']> = [
    ['user-a', 'flat'],
    ['user-b', 'gravity'],
    ['user-c', 'flat'],
    ['user-d', 'gravity'],
    ['user-e', 'flat'],
    ['00000000-0000-4000-8000-000000000001', 'flat'],
    ['watchside-tester-1', 'gravity'],
  ]

  for (const [userId, arm] of FROZEN) {
    it(`puts ${userId} in ${arm}`, () => {
      expect(resolveArm({ userId, environment: 'production' })).toBe(arm)
    })
  }

  /** Both arms are represented, so a stuck-constant bug cannot pass. */
  it('covers both arms', () => {
    const arms = new Set(FROZEN.map(([, arm]) => arm))
    expect([...arms].sort()).toEqual(['flat', 'gravity'])
  })
})

describe('the production-only rule is part of the same contract', () => {
  /**
   * Restated here rather than left only in socialGravity.test.ts.
   *
   * A release checkpoint asks one question of this file - "can we ship without
   * moving anybody?" - and the answer needs the forcing rule beside the frozen
   * values, because a change to either would move people.
   */
  it('forces every non-production build into gravity', () => {
    for (const environment of ['development', 'private_beta'] as const) {
      for (const [userId] of [['user-a'], ['user-b'], ['user-c']] as const) {
        expect(resolveArm({ userId, environment })).toBe('gravity')
      }
      expect(isRandomisedArm(environment)).toBe(false)
    }
    expect(isRandomisedArm('production')).toBe(true)
  })

  /** A signed-out client has nobody to hash, and must not crash or randomise. */
  it('shows the feature when there is no user id yet', () => {
    expect(resolveArm({ userId: null, environment: 'production' })).toBe('gravity')
  })
})
