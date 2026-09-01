import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
// @ts-expect-error - plain ESM harness module, deliberately not TypeScript
import { decidePreconditions, decideSocialPreconditions, explain } from '../../scripts/m3d-acceptance/preconditions.mjs'

/**
 * The guard that would have saved two human JOINs.
 *
 * WHAT HAPPENED
 *
 * Twice, a real socially attributed JOIN was performed by hand to accept Slice
 * D. Both times the JOIN was perfect - navigated, attributed, socially
 * initiated, durably recorded - and both times no baseline could possibly be
 * written, because the account clicking JOIN held no Twitch credential. The
 * product behaved correctly and said nothing, which is exactly right for a
 * user and exactly useless for an acceptance run.
 *
 * The missing check was never in the product. It was that nobody proved, before
 * spending the JOIN, that the actor under test could be measured at all.
 *
 * So these tests are about a HARNESS refusing to start, and the property they
 * defend is unusual: the harness must FAIL where a user-facing surface would
 * politely carry on.
 */

const READY = {
  actor_known: true,
  has_credential: true,
  twitch_account_connected: true,
  readiness: 'ready',
  has_follows_scope: true,
  unexpected_scopes: 0,
  observations_baseline: 0,
}

describe('an acceptance run may only spend a JOIN that could mean something', () => {
  it('proceeds when the actor is genuinely measurable', () => {
    expect(decidePreconditions(READY)).toEqual({ ok: true })
  })

  /**
   * THE EXACT FAILURE THAT WASTED TWO JOINS.
   *
   * An actor with no credential row. Readiness resolves to
   * needs_reauthorization, the client declines, nothing is recorded, and
   * nothing anywhere looks wrong.
   */
  it('refuses an actor with no stored Twitch credential', () => {
    expect(decidePreconditions({ ...READY, has_credential: false })).toEqual({
      ok: false,
      reason: 'no_credential',
    })
  })

  it('refuses every non-ready state, and names which one', () => {
    expect(decidePreconditions({ ...READY, readiness: 'needs_reauthorization' })).toMatchObject({
      ok: false,
      reason: 'needs_reauthorization',
    })
    expect(decidePreconditions({ ...READY, readiness: 'needs_follow_permission' })).toMatchObject({
      ok: false,
      reason: 'needs_follow_permission',
    })
    expect(decidePreconditions({ ...READY, readiness: 'temporarily_unavailable' })).toMatchObject({
      ok: false,
      reason: 'not_ready',
    })
    expect(decidePreconditions({ ...READY, readiness: null })).toMatchObject({
      ok: false,
      reason: 'not_ready',
    })
  })

  /**
   * The viewer's Twitch id comes from `connected_accounts`, read at exactly one
   * place in the whole function. A credential can exist, refresh and report
   * ready while this is absent - so it is checked separately rather than
   * assumed from readiness.
   */
  it('refuses an actor with no connected Twitch account', () => {
    expect(decidePreconditions({ ...READY, twitch_account_connected: false })).toEqual({
      ok: false,
      reason: 'twitch_account_not_connected',
    })
  })

  it('refuses an actor the server does not know', () => {
    expect(decidePreconditions({ ...READY, actor_known: false })).toEqual({
      ok: false,
      reason: 'actor_unknown',
    })
    expect(decidePreconditions(null)).toEqual({ ok: false, reason: 'actor_unknown' })
    expect(decidePreconditions(undefined)).toEqual({ ok: false, reason: 'actor_unknown' })
  })

  /** Ready implies the scope, but the permission everything rests on is asserted. */
  it('refuses a ready-looking actor whose credential lacks the follow scope', () => {
    expect(decidePreconditions({ ...READY, has_follows_scope: false })).toEqual({
      ok: false,
      reason: 'needs_follow_permission',
    })
  })

  it('refuses a credential carrying scopes Watchside never asks for', () => {
    expect(decidePreconditions({ ...READY, unexpected_scopes: 1 })).toMatchObject({
      ok: false,
      reason: 'unexpected_scopes',
    })
  })

  /**
   * Fails CLOSED on anything unrecognised. A snapshot from a future server that
   * omits a field must stop the run, not sail past it - the whole point is that
   * silence has already cost two JOINs.
   */
  it('refuses a snapshot missing the facts it needs', () => {
    expect(decidePreconditions({}).ok).toBe(false)
    expect(decidePreconditions({ actor_known: true }).ok).toBe(false)
    expect(decidePreconditions({ actor_known: true, has_credential: true }).ok).toBe(false)
  })

  /** A truthy-but-wrong value must not read as yes. */
  it('accepts only real booleans, not anything truthy', () => {
    expect(decidePreconditions({ ...READY, has_credential: 'yes' }).ok).toBe(false)
    expect(decidePreconditions({ ...READY, twitch_account_connected: 1 }).ok).toBe(false)
  })
})

describe('a refusal says what to do about it', () => {
  it('names the fix for a missing credential rather than the symptom', () => {
    const message = explain(decidePreconditions({ ...READY, has_credential: false }), 'Actor A')
    expect(message).toContain('sign in')
    expect(message).toContain('user:read:follows')
  })

  it('distinguishes a broken authorization from a missing permission', () => {
    const broken = explain(
      decidePreconditions({ ...READY, readiness: 'needs_reauthorization' }),
      'Actor A',
    )
    const missing = explain(
      decidePreconditions({ ...READY, readiness: 'needs_follow_permission' }),
      'Actor A',
    )
    // Different fixes. Collapsing them sends somebody down the wrong path.
    expect(broken).not.toEqual(missing)
    expect(broken).toContain('sign in again')
    expect(missing).toContain('account panel')
  })
})

describe('the harness refuses before it drives a browser', () => {
  const RUN = readFileSync('scripts/m3d-acceptance/run.mjs', 'utf8')

  /**
   * Ordering, read from the source, because it is the entire point: a
   * precondition checked after the JOIN is a post-mortem, not a guard.
   */
  it('checks preconditions before it clicks JOIN', () => {
    const preconditionAt = RUN.indexOf("action: 'acceptance_preconditions'")
    const joinAt = RUN.indexOf("'join', { channel: card.channel }")
    expect(preconditionAt).toBeGreaterThan(-1)
    expect(joinAt).toBeGreaterThan(-1)
    expect(preconditionAt).toBeLessThan(joinAt)
  })

  it('stops the run outright rather than warning and continuing', () => {
    const block = RUN.slice(RUN.indexOf('if (!decision.ok)'), RUN.indexOf('assert(\'Actor A holds'))
    expect(block).toContain('NO JOIN WAS SPENT')
    expect(block).toContain('return 3')
  })

  it('exercises the real JOIN control rather than inserting an event', () => {
    expect(RUN).toContain("'join', { channel: card.channel }")
    // Nothing here writes analytics, mints an attribution, or inserts a row.
    for (const forbidden of ['analytics_track', 'insert(', 'join_clicked', 'attribution.click']) {
      expect(RUN, forbidden).not.toContain(forbidden)
    }
  })

  /** No credential, no token, no follow state may reach output or the repo. */
  it('never prints the follow answer, and holds no secret', () => {
    expect(RUN).toContain('relationship baseline recorded: YES')
    expect(RUN).toContain('actual follow state exposed:    NO')

    /*
     * Checked against what is PRINTED, not against the whole file.
     *
     * The harness does mention `relationship_present` - in an assertion that
     * the field is absent from a response, which is the opposite of leaking it.
     * A blunt whole-file match would have to be satisfied by deleting that
     * guard, so the test looks at the output lines instead.
     */
    const printed = (RUN.match(/console\.log\([^\n]*\)/g) ?? []).join('\n')
    for (const forbidden of [
      'relationship_present',
      'following',
      'answered',
      'access_token',
      'refresh_token',
      'adminToken',
    ]) {
      expect(printed, forbidden).not.toContain(forbidden)
    }

    // And no secret is read from, or written to, the repository.
    expect(RUN).not.toContain('service_role')
    expect(RUN).not.toContain('SERVICE_ROLE')
    // The admin token comes from the environment and is never defaulted.
    expect(RUN).toContain("env('WATCHSIDE_ADMIN_TOKEN')")
  })

  it('is not part of ordinary CI', () => {
    const pkg = JSON.parse(readFileSync('package.json', 'utf8')) as {
      scripts: Record<string, string>
    }
    expect(pkg.scripts['verify:m3d']).toContain('m3d-acceptance')
    // `npm test` stays fakes-only.
    expect(pkg.scripts.test).not.toContain('m3d-acceptance')
  })
})

// ------------------------------------------------------- the social half

/**
 * The gap this closes.
 *
 * A run whose actors are not friends can never produce a Social Gravity card,
 * so it waited sixty seconds and reported a timeout - which reads like a flaky
 * harness and says nothing about the cause. It is knowable before either
 * browser is driven anywhere, so it is checked there.
 *
 * The friendship is VERIFIED, never created. A harness that could create the
 * relationship it depends on would be testing itself.
 */
describe('the actors must be the right two, and actually connected', () => {
  const A = { userId: 'a', twitchLogin: 'actor_a', friendLogins: ['actor_b'] }
  const B = { userId: 'b', twitchLogin: 'actor_b' }

  it('accepts two distinct signed-in accounts that are already friends', () => {
    expect(decideSocialPreconditions({ actorA: A, actorB: B })).toEqual({ ok: true })
  })

  it('refuses when either seed is signed out', () => {
    expect(decideSocialPreconditions({ actorA: {}, actorB: B })).toEqual({
      ok: false,
      reason: 'actor_a_signed_out',
    })
    expect(decideSocialPreconditions({ actorA: A, actorB: {} })).toEqual({
      ok: false,
      reason: 'actor_b_signed_out',
    })
  })

  /** One account twice proves nothing about social discovery. */
  it('refuses when both seeds resolve to the same account', () => {
    expect(decideSocialPreconditions({ actorA: A, actorB: { ...B, userId: 'a' } })).toMatchObject({
      ok: false,
      reason: 'actors_identical',
    })
  })

  it('refuses actors who are not Watchside friends', () => {
    expect(
      decideSocialPreconditions({ actorA: { ...A, friendLogins: [] }, actorB: B }),
    ).toMatchObject({ ok: false, reason: 'not_friends' })
    expect(
      decideSocialPreconditions({ actorA: { ...A, friendLogins: ['someone_else'] }, actorB: B }),
    ).toMatchObject({ ok: false, reason: 'not_friends' })
  })

  it('compares logins case-insensitively, as Twitch does', () => {
    expect(
      decideSocialPreconditions({
        actorA: { ...A, friendLogins: ['ACTOR_B'] },
        actorB: { ...B, twitchLogin: 'Actor_B' },
      }),
    ).toEqual({ ok: true })
  })

  /**
   * Pinning catches a seed re-authenticated as somebody else - which would
   * otherwise measure the wrong actor silently, the exact confusion that cost
   * two human JOINs.
   */
  it('refuses a seed signed in as an unexpected account when pinned', () => {
    expect(
      decideSocialPreconditions({ actorA: A, actorB: B, expected: { a: 'someone_else' } }),
    ).toMatchObject({ ok: false, reason: 'actor_a_unexpected' })
    expect(
      decideSocialPreconditions({ actorA: A, actorB: B, expected: { b: 'someone_else' } }),
    ).toMatchObject({ ok: false, reason: 'actor_b_unexpected' })
  })

  it('is optional, so an unpinned run still checks everything else', () => {
    expect(decideSocialPreconditions({ actorA: A, actorB: B, expected: {} })).toEqual({ ok: true })
  })

  it('explains a missing friendship as a product action, not a harness one', () => {
    const message = explain(
      decideSocialPreconditions({ actorA: { ...A, friendLogins: [] }, actorB: B }),
      'social',
    )
    expect(message).toContain('not Watchside friends')
    expect(message).toContain('never creates it')
  })

  it('is checked before the JOIN, in the harness', () => {
    const run = readFileSync('scripts/m3d-acceptance/run.mjs', 'utf8')
    const socialAt = run.indexOf('decideSocialPreconditions({')
    const joinAt = run.indexOf("'join', { channel: card.channel }")
    expect(socialAt).toBeGreaterThan(-1)
    expect(socialAt).toBeLessThan(joinAt)
    // And it stops the run rather than logging a warning.
    expect(run).toContain('if (!social.ok) throw new PreconditionError')
  })
})
