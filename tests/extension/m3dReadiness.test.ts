import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import {
  FORBIDDEN_CLAIMS,
  MIN_ACTORS,
  MIN_BASELINES,
  MIN_ELIGIBLE_FOR_COVERAGE,
  assessReadiness,
  permittedClaim,
} from '../../src/core/m3dReadiness'

/**
 * The gate between a query result and a sentence somebody says out loud.
 *
 * `m3d_relationship_v` returns a number, and a number in a query result is an
 * invitation. Every safeguard M3D has - the server-side boundary, the nullable
 * column, the retained-only denominator, the cohort suppression - lives on the
 * far side of "43% of social JOINs go to creators people did not already
 * follow", and none of them stops somebody writing that on a slide.
 *
 * So the four states are kept apart in code rather than in prose:
 *
 *   COLLECTION OPERATIONAL  the pipeline works
 *   COVERAGE OBSERVABLE     enough eligible JOINs for a rate to mean anything
 *   REPORTABLE              privacy gates pass
 *   INTERPRETABLE           we know whether the aggregate represents anything
 *
 * M3D closes on the first. The rest wait for production usage that does not
 * exist yet, and the most important gate is the one no query can close.
 */

const FULL = {
  socialJoins: 200,
  measurementEligible: 150,
  statusMissing: 0,
  retainedBaselines: 120,
  measuredActors: 40,
  reportable: true,
  missingnessReviewed: true,
  observedOutsideEligible: 0,
}

describe('the four states are not the same thing', () => {
  it('starts at collection operational, which is where M3D closes', () => {
    const readiness = assessReadiness({ ...FULL, measurementEligible: 1, retainedBaselines: 1 })
    expect(readiness.state).toBe('collection_operational')
    expect(readiness.mayPublishRelationshipShare).toBe(false)
  })

  it('reaches coverage observable once there are enough eligible JOINs', () => {
    const readiness = assessReadiness({
      ...FULL,
      retainedBaselines: 2,
      measuredActors: 1,
      reportable: false,
    })
    expect(readiness.state).toBe('coverage_observable')
    expect(readiness.mayPublishRelationshipShare).toBe(false)
  })

  it('reaches reportable only when the privacy floor is cleared', () => {
    const readiness = assessReadiness({ ...FULL, missingnessReviewed: false })
    expect(readiness.state).toBe('reportable')
    // Reportable is NOT permission to publish. It means the aggregate may be
    // looked at, not that it means anything.
    expect(readiness.mayPublishRelationshipShare).toBe(false)
  })

  it('reaches interpretable only when somebody has reviewed the missingness', () => {
    const readiness = assessReadiness(FULL)
    expect(readiness.state).toBe('interpretable')
    expect(readiness.mayPublishRelationshipShare).toBe(true)
  })
})

describe('every gate closes on its own', () => {
  it('refuses too few eligible JOINs to compute a rate', () => {
    const readiness = assessReadiness({ ...FULL, measurementEligible: MIN_ELIGIBLE_FOR_COVERAGE - 1 })
    expect(readiness.mayPublishRelationshipShare).toBe(false)
    expect(readiness.blockers.join(' ')).toContain('coverage not yet meaningful')
  })

  it('refuses too few retained baselines', () => {
    const readiness = assessReadiness({ ...FULL, retainedBaselines: MIN_BASELINES - 1 })
    expect(readiness.mayPublishRelationshipShare).toBe(false)
    expect(readiness.blockers.join(' ')).toContain('too few retained baselines')
  })

  it('refuses too few distinct actors, however many baselines', () => {
    const readiness = assessReadiness({
      ...FULL,
      retainedBaselines: 500,
      measuredActors: MIN_ACTORS - 1,
    })
    expect(readiness.mayPublishRelationshipShare).toBe(false)
    expect(readiness.blockers.join(' ')).toContain('too few measured actors')
  })

  it('refuses when the view itself is withholding the breakdown', () => {
    expect(assessReadiness({ ...FULL, reportable: false }).mayPublishRelationshipShare).toBe(false)
  })

  /**
   * The gate no query can close.
   *
   * Deliberately an input, because nothing can tell whether a human looked at
   * the comparison and thought about it. Computing it would make the most
   * important gate the easiest one to pass.
   */
  it('refuses until the measured-versus-unmeasured comparison has been reviewed', () => {
    const readiness = assessReadiness({ ...FULL, missingnessReviewed: false })
    expect(readiness.mayPublishRelationshipShare).toBe(false)
    expect(readiness.blockers.join(' ')).toContain('measured-versus-unmeasured')
  })

  /**
   * Baselines outside the eligible population mean the two populations have
   * drifted apart. A denominator nobody understands is worse than none.
   */
  it('refuses when baselines exist outside the eligible population', () => {
    const readiness = assessReadiness({ ...FULL, observedOutsideEligible: 1 })
    expect(readiness.mayPublishRelationshipShare).toBe(false)
    expect(readiness.blockers.join(' ')).toContain('outside the eligible population')
  })

  /** Fails closed on anything it does not recognise. */
  it('refuses an empty or missing snapshot', () => {
    expect(assessReadiness(null).mayPublishRelationshipShare).toBe(false)
    expect(assessReadiness({}).mayPublishRelationshipShare).toBe(false)
    expect(assessReadiness({}).state).toBe('collection_operational')
  })

  it('accepts only real numbers and real booleans', () => {
    expect(
      assessReadiness({ ...FULL, measuredActors: '40' as unknown as number })
        .mayPublishRelationshipShare,
    ).toBe(false)
    expect(
      assessReadiness({ ...FULL, missingnessReviewed: 1 as unknown as boolean })
        .mayPublishRelationshipShare,
    ).toBe(false)
  })
})

describe('the claim, when it is finally allowed', () => {
  it('says nothing at all while the gate is shut', () => {
    expect(permittedClaim(assessReadiness({ ...FULL, missingnessReviewed: false }), 0.43)).toBeNull()
    // And nothing when there is no share to quote.
    expect(permittedClaim(assessReadiness(FULL), null)).toBeNull()
  })

  /**
   * Every clause is load-bearing. "Socially initiated" is the population,
   * "currently retained" is the denominator, and "did not already follow" is a
   * baseline rather than a conversion.
   */
  it('names the population and the denominator, not just the number', () => {
    const claim = permittedClaim(assessReadiness(FULL), 0.43)!
    expect(claim).toContain('43.0%')
    expect(claim).toContain('socially initiated')
    expect(claim).toContain('currently retained follow-baseline observation')
    expect(claim).toContain('did not already follow')
  })

  /** The sentences M3D can never support, whatever the numbers say. */
  it('makes none of the claims the data cannot support', () => {
    const claim = permittedClaim(assessReadiness(FULL), 0.43)!.toLowerCase()
    for (const forbidden of FORBIDDEN_CLAIMS) {
      expect(claim, forbidden).not.toContain(forbidden)
    }
  })

  it('is generated rather than written by hand, so it cannot drift', () => {
    const source = readFileSync('src/core/m3dReadiness.ts', 'utf8')
    // Comments stripped: the doc explains the wording, which is not the same as
    // a second place producing it.
    const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '')
    // One place builds the sentence, and it is the same place that knows the
    // denominator.
    expect(code.match(/did not already follow/g)).toHaveLength(1)
  })
})

describe('the thresholds are honest about being provisional', () => {
  it('matches the suppression the database enforces', () => {
    // The gate must not be looser than the view it is gating.
    const migration = readFileSync('supabase/migrations/0035_m3d_small_cohort.sql', 'utf8')
    expect(migration).toContain(`count(*) >= ${MIN_BASELINES}`)
    expect(migration).toContain(`count(distinct actor_id) >= ${MIN_ACTORS}`)
  })

  it('says PROVISIONAL where it means provisional', () => {
    const source = readFileSync('src/core/m3dReadiness.ts', 'utf8')
    expect(source).toContain('PROVISIONAL')
    // And does not dress a chosen floor up as statistical certainty.
    expect(source).toContain('inventing\n * statistical certainty would be worse')
  })
})
