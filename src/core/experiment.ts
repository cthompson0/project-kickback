/**
 * Which arm of an experiment a user is in.
 *
 * Social Gravity will eventually need a causal answer - does showing the map
 * beat showing a list - and that needs a holdout, because comparing people who
 * used Gravity to people who did not is comparing two kinds of people. The
 * groundwork has to exist before the data does, or the first public experiment
 * produces numbers nobody can defend.
 *
 * DERIVED, NOT STORED
 *
 * The assignment is a hash of the user id. That makes it stable forever, equal
 * on every device, unaffected by clearing storage, and needs no table, no
 * migration and no synchronisation. A stored assignment would be one more
 * thing that can drift between machines, and drift in an experiment arm is
 * indistinguishable from the effect being measured.
 *
 * BETA IS NOT AN EXPERIMENT
 *
 * With a handful of testers a holdout would be statistically worthless and
 * genuinely annoying - half the friends group could not see the feature they
 * are there to test. So the private beta forces everyone into `gravity` while
 * keeping the machinery real. Nothing about that is a causal claim, and
 * nothing derived from beta usage may be presented as one.
 */

export type ExperimentArm = 'flat' | 'gravity'

/**
 * FNV-1a, 32-bit.
 *
 * Chosen because it is short, dependency-free and deterministic across every
 * environment we run in. It is not a security primitive and nothing here needs
 * one: the only requirement is that the same id always lands in the same arm
 * and that ids spread evenly.
 */
function hash32(value: string): number {
  let h = 0x811c9dc5
  for (let index = 0; index < value.length; index += 1) {
    h ^= value.charCodeAt(index)
    h = Math.imul(h, 0x01000193)
  }
  return h >>> 0
}

/**
 * Salted per experiment.
 *
 * So that a user who happens to land in the control arm here is not
 * systematically in the control arm of every future experiment too, which
 * would quietly turn independent tests into one correlated one.
 */
const SALT = 'kickback:social-gravity:v1'

export interface ArmInput {
  /** Null while auth is still resolving. */
  userId: string | null
  /** Which build this is. Only production randomises. */
  environment: 'development' | 'private_beta' | 'production'
  /** For local testing. Never set from anything a user controls. */
  override?: ExperimentArm | null
}

/**
 * Which arm to render.
 *
 * Everything except a production build gets Gravity: development because you
 * cannot work on a feature you cannot see, private beta because a holdout
 * across five people measures nothing and costs the feature half its testers.
 *
 * Production splits deterministically, 50/50, by user id.
 */
export function resolveArm({ userId, environment, override }: ArmInput): ExperimentArm {
  if (override) return override
  if (environment !== 'production') return 'gravity'
  // Nobody to hash yet. Show the feature rather than the control: a signed-out
  // panel has no friends to cluster, so the choice is not observable anyway.
  if (!userId) return 'gravity'
  return hash32(`${SALT}:${userId}`) % 2 === 0 ? 'flat' : 'gravity'
}

/**
 * True when the arm assignment is a real randomisation rather than a forced
 * value.
 *
 * Analytics should only ever describe an arm as an experiment when this is
 * true. Recording "arm: gravity" for a beta where everyone is gravity is not
 * an experiment result, it is a constant, and labelling it as the former is
 * how a fake causal claim gets into a deck.
 */
export function isRandomisedArm(environment: ArmInput['environment']): boolean {
  return environment === 'production'
}
