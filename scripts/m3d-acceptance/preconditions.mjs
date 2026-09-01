/**
 * What must be true before an acceptance run is allowed to spend a JOIN.
 *
 * WHY THIS EXISTS AS ITS OWN FUNCTION
 *
 * Two real human JOINs were spent discovering setup state. Both times the JOIN
 * itself was perfect - socially attributed, navigated, durably recorded - and
 * both times no baseline could ever have been written, because the account
 * clicking JOIN held no Twitch credential. Nothing in the product was wrong.
 * What was missing was anybody checking, before the JOIN, that the actor under
 * test could be measured at all.
 *
 * So the check is a pure function over a server-reported snapshot, separate
 * from the code that acts on it: it can be unit-tested against every failure
 * shape, and mutated to prove the harness genuinely refuses rather than
 * merely printing a warning on its way past.
 *
 * THE RULE IT ENFORCES
 *
 * A JOIN is spent ONLY when the answer would mean something. Any other state -
 * no credential, a broken authorization, a missing permission, an unknown
 * actor - fails BEFORE the browser is driven, and names the exact thing that
 * is missing.
 */

/** Every reason an acceptance run may refuse to begin, in the order checked. */
export const PRECONDITION_REASONS = [
  'actor_unknown',
  'no_credential',
  'twitch_account_not_connected',
  'needs_reauthorization',
  'needs_follow_permission',
  'not_ready',
  'unexpected_scopes',
]

/**
 * @param {object} snapshot server-reported facts about the actor under test
 * @returns {{ok: true} | {ok: false, reason: string, detail?: string}}
 */
export function decidePreconditions(snapshot) {
  if (!snapshot || snapshot.actor_known !== true) {
    return { ok: false, reason: 'actor_unknown' }
  }

  /*
   * The one that would have saved both wasted JOINs.
   *
   * An actor with no credential row cannot be measured by any code path, and
   * the product correctly says nothing about it - so the failure is invisible
   * from the browser and only a server query can see it.
   */
  if (snapshot.has_credential !== true) {
    return { ok: false, reason: 'no_credential' }
  }

  // The follow lookup needs the viewer's Twitch id, and it comes from here.
  // A credential can exist, refresh and report ready without this.
  if (snapshot.twitch_account_connected !== true) {
    return { ok: false, reason: 'twitch_account_not_connected' }
  }

  /*
   * Readiness is the server's own word, not a reconstruction. Each non-ready
   * state is reported as itself: "needs the permission" and "authorization is
   * broken" need completely different fixes, and collapsing them would send
   * somebody down the wrong one.
   */
  if (snapshot.readiness !== 'ready') {
    const named = ['needs_reauthorization', 'needs_follow_permission'].includes(snapshot.readiness)
    return {
      ok: false,
      reason: named ? snapshot.readiness : 'not_ready',
      detail: String(snapshot.readiness),
    }
  }

  // Ready implies the scope, but assert it rather than infer it: this is the
  // permission the whole measurement rests on.
  if (snapshot.has_follows_scope !== true) {
    return { ok: false, reason: 'needs_follow_permission' }
  }

  /*
   * Refuses to measure through a credential carrying more than Watchside asks
   * for. Not a security control - the server decides what it reads - but an
   * acceptance run is exactly where an unnoticed scope widening should stop
   * being invisible.
   */
  if (Number(snapshot.unexpected_scopes ?? 0) > 0) {
    return { ok: false, reason: 'unexpected_scopes', detail: String(snapshot.unexpected_scopes) }
  }

  return { ok: true }
}

/**
 * The social preconditions: are these the right two accounts, and are they
 * actually connected?
 *
 * Separate from the credential check because they fail for entirely different
 * reasons and have entirely different fixes. A credential problem is fixed by
 * signing in; a friendship problem is fixed in the product, by two people.
 *
 * WHY FRIENDSHIP IS A PRECONDITION AND NOT AN ASSERTION
 *
 * Without it, a run whose actors are not friends waits sixty seconds for a
 * Social Gravity card that can never appear, then reports a timeout - which
 * reads like a flaky harness and says nothing about the actual cause. It is
 * knowable before the browsers are even driven to their channels, so it is
 * checked there.
 *
 * The friendship is VERIFIED, never created. These are real accounts with real
 * social state; a harness that could create the relationship it depends on
 * would be testing itself.
 *
 * @param {object} input
 * @param {{userId?: string, twitchLogin?: string, friendLogins?: string[]}} input.actorA
 * @param {{userId?: string, twitchLogin?: string}} input.actorB
 * @param {{a?: string|null, b?: string|null}} [input.expected] optional pinned logins
 */
export function decideSocialPreconditions({ actorA, actorB, expected = {} }) {
  if (!actorA?.userId) return { ok: false, reason: 'actor_a_signed_out' }
  if (!actorB?.userId) return { ok: false, reason: 'actor_b_signed_out' }

  /*
   * Two accounts, not one profile copied twice. A run where both seeds resolve
   * to the same account would show a card for a channel the actor is already
   * on, and prove nothing about social discovery.
   */
  if (actorA.userId === actorB.userId) {
    return { ok: false, reason: 'actors_identical', detail: actorA.twitchLogin }
  }

  /*
   * Optional pinning. When the expected logins are configured, a seed that has
   * been re-authenticated as somebody else is caught here rather than by a
   * confusing failure later - or worse, by silently measuring the wrong actor,
   * which is exactly the confusion that cost two human JOINs.
   */
  const lower = (value) => (typeof value === 'string' ? value.toLowerCase() : null)
  if (expected.a && lower(actorA.twitchLogin) !== lower(expected.a)) {
    return { ok: false, reason: 'actor_a_unexpected', detail: `@${actorA.twitchLogin}` }
  }
  if (expected.b && lower(actorB.twitchLogin) !== lower(expected.b)) {
    return { ok: false, reason: 'actor_b_unexpected', detail: `@${actorB.twitchLogin}` }
  }

  const friends = (actorA.friendLogins ?? []).map((login) => lower(login))
  if (!friends.includes(lower(actorB.twitchLogin))) {
    return {
      ok: false,
      reason: 'not_friends',
      detail: `A's friends: ${friends.length ? friends.join(', ') : 'none'}`,
    }
  }

  return { ok: true }
}

/** Human-readable, and specific enough to act on without a second run. */
export function explain(decision, actorLabel) {
  if (decision.ok) return `${actorLabel} is ready to measure`
  const detail = decision.detail ? ` (${decision.detail})` : ''
  switch (decision.reason) {
    case 'actor_a_signed_out':
      return 'seed profile A is not signed in to Watchside'
    case 'actor_b_signed_out':
      return 'seed profile B is not signed in to Watchside'
    case 'actors_identical':
      return `both seeds resolve to the same account${detail}; two distinct accounts are required`
    case 'actor_a_unexpected':
      return `seed A is signed in as an account other than the expected one${detail}`
    case 'actor_b_unexpected':
      return `seed B is signed in as an account other than the expected one${detail}`
    case 'not_friends':
      return `the two actors are not Watchside friends, so no Social Gravity card can appear${detail}. Add the friendship in the product - the harness verifies it and never creates it.`
    case 'actor_unknown':
      return `${actorLabel}: the server does not know this actor id`
    case 'no_credential':
      return `${actorLabel}: no Twitch credential is stored for this account. It must sign in to Watchside again - the initial OAuth now requests user:read:follows and stores a credential.`
    case 'twitch_account_not_connected':
      return `${actorLabel}: no connected Twitch account, so the viewer id the follow lookup needs is missing`
    case 'needs_reauthorization':
      return `${actorLabel}: the stored authorization is broken; this account must sign in again`
    case 'needs_follow_permission':
      return `${actorLabel}: the credential predates user:read:follows; grant it from the account panel`
    case 'unexpected_scopes':
      return `${actorLabel}: the credential carries scopes Watchside does not request${detail}`
    default:
      return `${actorLabel}: not ready${detail}`
  }
}
