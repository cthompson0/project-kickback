/**
 * Whether the M3D relationship figure may be said out loud.
 *
 * WHY THIS IS CODE AND NOT A PARAGRAPH
 *
 * `m3d_relationship_v` returns a number. A number in a query result is an
 * invitation, and the distance between "the view returned 43%" and "43% of
 * social JOINs go to creators people did not already follow" is one slide. Every
 * safeguard in M3D lives on the far side of that sentence, so the sentence needs
 * a gate of its own that somebody has to deliberately open.
 *
 * THE FOUR STATES, WHICH ARE NOT THE SAME THING
 *
 *   COLLECTION OPERATIONAL  the pipeline works end to end
 *   COVERAGE OBSERVABLE     enough post-instrumentation JOINs to compute coverage
 *   REPORTABLE              privacy gates pass, so an aggregate may be shown
 *   INTERPRETABLE           we know whether the aggregate represents anything
 *
 * M3D closing requires only the first. The other three depend on production
 * usage that does not exist yet, and conflating them is exactly how a
 * measurement programme produces a confident wrong answer.
 *
 * This module is pure and has no database access: it judges a snapshot somebody
 * else fetched. That keeps it testable against every shape, including the ones
 * production has not reached.
 */

/** Minimum retained baselines before an aggregate may be shown. PROVISIONAL. */
export const MIN_BASELINES = 10

/**
 * Minimum distinct actors. PROVISIONAL.
 *
 * Beside the baseline count rather than instead of it: ten baselines from one
 * person is still one person's viewing, and a count alone cannot tell.
 */
export const MIN_ACTORS = 3

/**
 * Minimum eligible JOINs before a coverage rate means anything.
 *
 * PROVISIONAL, and deliberately not derived from a power calculation - inventing
 * statistical certainty would be worse than admitting there is none. It is a
 * floor below which the rate is obviously noise, nothing more.
 */
export const MIN_ELIGIBLE_FOR_COVERAGE = 30

export type M3dState =
  | 'collection_operational'
  | 'coverage_observable'
  | 'reportable'
  | 'interpretable'

/** Everything the gate judges. Counts and flags only - never a follow result. */
export interface M3dSnapshot {
  /** Population A. */
  socialJoins: number
  /** Population B - the client-reported eligible decision. */
  measurementEligible: number
  /** JOINs predating the coverage instrumentation. */
  statusMissing: number
  /** Population C, currently retained. */
  retainedBaselines: number
  /** Distinct actors behind population C. */
  measuredActors: number
  /** Whether the view itself is willing to publish a breakdown. */
  reportable: boolean
  /**
   * Whether somebody has actually run and reviewed the measured-versus-
   * unmeasured comparison for this window.
   *
   * Deliberately an input rather than something computed. No query can tell
   * whether a human looked at the result and thought about it, and pretending
   * otherwise would make the most important gate the easiest one to pass.
   */
  missingnessReviewed: boolean
  /** Baselines attached to JOINs that were never judged measurable. */
  observedOutsideEligible: number
}

export interface M3dReadiness {
  state: M3dState
  /** Every gate that is not yet satisfied, in the order they must be met. */
  blockers: string[]
  /** True only when a relationship percentage may be quoted externally. */
  mayPublishRelationshipShare: boolean
}

/**
 * Judges a snapshot against the four states.
 *
 * Fails closed at every step: an unrecognised or missing field leaves the gate
 * shut, because the cost of a wrongly-open gate is a public claim that cannot be
 * taken back.
 */
export function assessReadiness(snapshot: Partial<M3dSnapshot> | null): M3dReadiness {
  const s = snapshot ?? {}
  const count = (value: unknown) => (typeof value === 'number' && Number.isFinite(value) ? value : 0)

  const blockers: string[] = []

  const eligible = count(s.measurementEligible)
  const retained = count(s.retainedBaselines)
  const actors = count(s.measuredActors)

  /*
   * COVERAGE OBSERVABLE. Enough post-instrumentation JOINs that a rate is not
   * noise. `status_missing` JOINs do not help: they are exactly the ones whose
   * eligibility is unknown.
   */
  if (eligible < MIN_ELIGIBLE_FOR_COVERAGE) {
    blockers.push(
      `coverage not yet meaningful: ${eligible} eligible JOINs, need ${MIN_ELIGIBLE_FOR_COVERAGE}`,
    )
  }

  // REPORTABLE. The privacy floor, and the view's own judgement of it.
  if (retained < MIN_BASELINES) {
    blockers.push(`too few retained baselines: ${retained}, need ${MIN_BASELINES}`)
  }
  if (actors < MIN_ACTORS) {
    blockers.push(`too few measured actors: ${actors}, need ${MIN_ACTORS}`)
  }
  if (s.reportable !== true) {
    blockers.push('the relationship view is withholding its breakdown')
  }

  /*
   * A non-zero count here means baselines exist for JOINs never judged
   * measurable. Today that is pre-instrumentation history; later it would mean
   * the populations have drifted apart, and a denominator nobody understands is
   * worse than no denominator.
   */
  if (count(s.observedOutsideEligible) > 0) {
    blockers.push(
      `${count(s.observedOutsideEligible)} baselines belong to JOINs outside the eligible population`,
    )
  }

  // INTERPRETABLE. The one gate no query can close.
  if (s.missingnessReviewed !== true) {
    blockers.push('measured-versus-unmeasured comparison has not been run and reviewed')
  }

  const coverageObservable = eligible >= MIN_ELIGIBLE_FOR_COVERAGE
  const reportable =
    coverageObservable && retained >= MIN_BASELINES && actors >= MIN_ACTORS && s.reportable === true
  const interpretable =
    reportable && s.missingnessReviewed === true && count(s.observedOutsideEligible) === 0

  const state: M3dState = interpretable
    ? 'interpretable'
    : reportable
      ? 'reportable'
      : coverageObservable
        ? 'coverage_observable'
        : 'collection_operational'

  return { state, blockers, mayPublishRelationshipShare: interpretable }
}

/**
 * The only sentence the data supports, and only once the gate is open.
 *
 * Returned rather than written by hand at the call site, so the wording cannot
 * drift away from the denominator it describes. Every clause is load-bearing:
 * "socially initiated" is the population, "currently retained" is the
 * denominator, and "did not already follow" is a baseline rather than a
 * conversion.
 */
export function permittedClaim(readiness: M3dReadiness, share: number | null): string | null {
  if (!readiness.mayPublishRelationshipShare || share === null) return null
  const percent = (share * 100).toFixed(1)
  return (
    `${percent}% of socially initiated Watchside JOINs with a currently retained ` +
    `follow-baseline observation went to creators the viewer did not already follow.`
  )
}

/**
 * Claims M3D can never support, whatever the numbers say.
 *
 * Kept as data so a test can assert none of them appear in the permitted
 * wording, rather than as a list in a document nobody re-reads.
 */
export const FORBIDDEN_CLAIMS: readonly string[] = [
  'caused',
  'converted',
  'conversion',
  'incremental',
  'lift',
  'drove them to follow',
  'new followers',
  'revenue',
  'subscription',
  'retention',
]
