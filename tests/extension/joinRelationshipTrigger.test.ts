import { readFileSync, readdirSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { createAnalyticsHub, decideMeasurement } from '../../src/background/analyticsHub'
import type { AnalyticsEvent } from '../../src/core/analytics'
import type { MeasurementReadiness } from '../../src/client/types'

/**
 * The first production follow baseline: what earns one, and what JOIN must
 * never pay for it.
 *
 * THE PRODUCT INVARIANT, ABOVE EVERYTHING ELSE
 *
 * JOIN is the user's action. They clicked it because they want to watch Twitch.
 * Measurement is secondary and always loses: it may not delay navigation, block
 * it, replace it, make it look failed, surface an error, ask for a permission,
 * or make any part of getting to Twitch contingent on a Twitch API call.
 *
 * That invariant is structural rather than promised. The browser navigates in
 * the CONTENT SCRIPT, and the recording is a one-way port message posted after
 * it, to a service worker in a different context. By the time any of this code
 * runs, the user is already on their way. Nothing here could delay them if it
 * tried, and these tests pin the structure that makes that true.
 *
 * THE ORDERING QUESTION SLICE B LEFT OPEN
 *
 * Does the canonical `join_clicked` reach the trusted server before the
 * relationship action tries to bind its attribution? It does now, and not by
 * hoping: the trigger runs after `flush()` resolves AND only when the queue has
 * drained. The recorder re-queues a batch it failed to send, so an empty queue
 * is a positive acknowledgement that the write landed. No sleep, no widened
 * window, no weakened binding - and the server independently re-verifies the
 * attribution anyway, so the two checks are belt and braces rather than one
 * dressed as two.
 */

const READY: MeasurementReadiness = 'ready'

interface Measured {
  broadcasterLogin: string
  attributionId: string
}

function harness(
  options: {
    readiness?: MeasurementReadiness | null
    failMeasurement?: boolean
    /** Models the analytics backend being down when the JOIN is recorded. */
    failAnalytics?: boolean
    /**
     * Makes the FIRST send stay open across a tick.
     *
     * This is what a real JOIN looks like: Gravity impressions are already on
     * the flush timer, so the click arrives while a send is in flight. Without
     * it the harness resolves instantly and the overlap - the thing that broke
     * the first real acceptance - never happens.
     */
    slowFirstSend?: boolean
  } = {},
) {
  let clock = 1_700_000_000_000
  let ids = 0
  const sent: AnalyticsEvent[] = []
  const measured: Measured[] = []
  let readiness = options.readiness === undefined ? READY : options.readiness
  let failAnalytics = options.failAnalytics ?? false

  const cells: Record<string, unknown> = {}
  const cell = <T,>(key: string) => ({
    read: async () => (cells[key] ?? null) as T | null,
    write: async (value: T | null) => {
      cells[key] = value
    },
  })

  const hub = createAnalyticsHub({
    backend: {
      async send(events) {
        if (failAnalytics) throw new Error('analytics backend down')
        if (options.slowFirstSend && sent.length === 0) {
          await new Promise((resolve) => setTimeout(resolve, 5))
        }
        sent.push(...events)
        return events.length
      },
    },
    environment: 'private_beta',
    appVersion: '0.7.0',
    enabled: true,
    sessionStore: cell('session'),
    attributionStore: cell('join'),
    lifecycleStore: cell('lifecycle'),
    dwellStore: cell('dwell'),
    canSend: () => true,
    selfId: () => 'user-a',
    measurementReadiness: () => readiness,
    measureRelationship: async (input) => {
      if (options.failMeasurement) throw new Error('relationship action failed')
      measured.push(input)
    },
    now: () => clock,
  })

  const originalUuid = crypto.randomUUID
  crypto.randomUUID = (() => `00000000-0000-4000-8000-${String(++ids).padStart(12, '0')}`) as never

  return {
    hub,
    sent,
    measured,
    setReadiness: (value: MeasurementReadiness | null) => {
      readiness = value
    },
    setFailAnalytics: (value: boolean) => {
      failAnalytics = value
    },
    advance: (ms: number) => {
      clock += ms
    },
    restore: () => {
      crypto.randomUUID = originalUuid
    },
    settle: async () => {
      for (let index = 0; index < 6; index += 1) {
        await new Promise((resolve) => setTimeout(resolve, 0))
      }
      await hub.flush()
      for (let index = 0; index < 6; index += 1) {
        await new Promise((resolve) => setTimeout(resolve, 0))
      }
    },
  }
}

/** A canonical socially attributed JOIN, as Social Gravity produces one. */
const SOCIAL_JOIN = {
  channel: 'lirik',
  source: 'social_gravity' as const,
  socialCount: 3,
  navigated: true,
  alreadyOnTwitch: true,
  alreadyOnDestination: false,
}

// ------------------------------------------------------- the eligibility gate

describe('what counts as an eligible JOIN', () => {
  const base = {
    navigated: true,
    attributionId: 'a-1',
    socialCount: 2,
    readiness: READY,
    pendingEvents: 0,
  }

  it('accepts a socially attributed JOIN that navigated, when ready and acknowledged', () => {
    expect(decideMeasurement(base)).toEqual({ measure: true })
  })

  /**
   * A JOIN on the channel you are already watching is a real click that goes
   * nowhere. It mints no attribution, so there is nothing to bind a baseline to.
   */
  it('refuses a click that navigated nowhere', () => {
    expect(decideMeasurement({ ...base, navigated: false })).toEqual({
      measure: false,
      reason: 'not_navigated',
    })
  })

  /** The canonical social-JOIN identity. There is no second definition. */
  it('refuses a JOIN with no attribution', () => {
    expect(decideMeasurement({ ...base, attributionId: null })).toEqual({
      measure: false,
      reason: 'no_attribution',
    })
  })

  it('refuses a JOIN nobody else was part of', () => {
    expect(decideMeasurement({ ...base, socialCount: 0 })).toEqual({
      measure: false,
      reason: 'not_socially_initiated',
    })
    expect(decideMeasurement({ ...base, socialCount: Number.NaN })).toMatchObject({
      reason: 'not_socially_initiated',
    })
  })

  /**
   * THE ORDERING GUARANTEE.
   *
   * A queue that did not drain means the canonical join_clicked has not been
   * accepted, so the attribution the server would be asked to bind does not
   * exist yet. Refusing is the only honest answer; the alternative is asking
   * the server a question it must refuse.
   */
  it('refuses when the JOIN write has not been acknowledged', () => {
    expect(decideMeasurement({ ...base, pendingEvents: 1 })).toEqual({
      measure: false,
      reason: 'unacknowledged',
    })
  })
})

describe('readiness decides, and only "ready" permits', () => {
  const base = {
    navigated: true,
    attributionId: 'a-1',
    socialCount: 2,
    pendingEvents: 0,
  }

  it('permits measurement when the server says ready', () => {
    expect(decideMeasurement({ ...base, readiness: 'ready' })).toEqual({ measure: true })
  })

  it('skips every other state, without distinguishing between them', () => {
    for (const readiness of [
      'needs_follow_permission',
      'needs_reauthorization',
      'temporarily_unavailable',
      null,
    ] as const) {
      expect(decideMeasurement({ ...base, readiness }), `${readiness}`).toEqual({
        measure: false,
        reason: 'not_ready',
      })
    }
  })
})

// --------------------------------------------------------- the real hub path

describe('a canonical socially attributed JOIN', () => {
  it('schedules exactly one measurement, with the JOIN’s own attribution', async () => {
    const h = harness()
    h.hub.recordJoin(SOCIAL_JOIN)
    await h.settle()

    const clicked = h.sent.find((event) => event.event_name === 'join_clicked')
    expect(clicked).toBeDefined()
    expect(h.measured).toHaveLength(1)
    expect(h.measured[0].broadcasterLogin).toBe('lirik')
    // The SAME attribution the canonical event carries - not a second id, not
    // a regenerated one.
    expect(h.measured[0].attributionId).toBe(clicked!.attribution_id)
    h.restore()
  })

  it('sends only the creator and the attribution, and nothing else at all', async () => {
    const h = harness()
    h.hub.recordJoin(SOCIAL_JOIN)
    await h.settle()

    expect(Object.keys(h.measured[0]).sort()).toEqual(['attributionId', 'broadcasterLogin'])
    const text = JSON.stringify(h.measured[0])
    for (const forbidden of [
      'actor',
      'user_id',
      'userId',
      'viewer',
      'credential',
      'token',
      'scope',
      'relationship_present',
      'following',
    ]) {
      expect(text, forbidden).not.toContain(forbidden)
    }
    h.restore()
  })

  /**
   * The measurement is a consequence of the JOIN, never a precondition. The
   * canonical event is on the wire before the trigger is even considered.
   */
  it('records the canonical JOIN before it measures anything', async () => {
    const h = harness()
    h.hub.recordJoin(SOCIAL_JOIN)
    await h.settle()

    expect(h.sent.some((event) => event.event_name === 'join_clicked')).toBe(true)
    expect(h.measured).toHaveLength(1)
    h.restore()
  })
})

describe('what never gets measured', () => {
  it('a JOIN nobody else was part of', async () => {
    const h = harness()
    h.hub.recordJoin({ ...SOCIAL_JOIN, socialCount: 0, source: 'friend_row' })
    await h.settle()
    expect(h.sent.some((event) => event.event_name === 'join_clicked')).toBe(true)
    expect(h.measured).toHaveLength(0)
    h.restore()
  })

  it('a click on the channel already being watched', async () => {
    const h = harness()
    h.hub.recordJoin({ ...SOCIAL_JOIN, navigated: false, alreadyOnDestination: true })
    await h.settle()
    expect(h.measured).toHaveLength(0)
    h.restore()
  })

  /**
   * Arriving somewhere, or being seen somewhere, is not a JOIN. Only the
   * canonical click is, which is what keeps the honest sentence "Watchside
   * checks your relationship with the channel your friends are watching"
   * rather than "Watchside tracks who you follow".
   */
  it('ordinary Twitch navigation, arrival and presence', async () => {
    const h = harness()
    h.hub.noteActive()
    h.hub.noteChannel('someoneelse')
    h.hub.noteTogether({ channel: 'someoneelse', otherCount: 2 })
    await h.settle()
    expect(h.measured).toHaveLength(0)
    h.restore()
  })

  it('a Gravity card that was shown but never joined', async () => {
    const h = harness()
    h.hub.noteExposure({
      friends: [],
      gatherings: [],
      gravity: [{ channel: 'lirik', friendCount: 3, rank: 1, live: 'live' }],
    })
    await h.settle()
    expect(h.measured).toHaveLength(0)
    h.restore()
  })

  it('any JOIN at all, when the permission was never granted', async () => {
    for (const readiness of [
      'needs_follow_permission',
      'needs_reauthorization',
      'temporarily_unavailable',
      null,
    ] as const) {
      const h = harness({ readiness })
      h.hub.recordJoin(SOCIAL_JOIN)
      await h.settle()
      expect(h.sent.some((event) => event.event_name === 'join_clicked'), `${readiness}`).toBe(true)
      expect(h.measured, `${readiness}`).toHaveLength(0)
      h.restore()
    }
  })

  /**
   * THE BACKFILL PROHIBITION.
   *
   * If the permission arrives later, that says nothing about whether this
   * viewer followed this creator at THAT join. The opportunity was unavailable
   * and it does not come back.
   */
  it('a JOIN that was skipped, even after permission arrives', async () => {
    const h = harness({ readiness: 'needs_follow_permission' })
    h.hub.recordJoin(SOCIAL_JOIN)
    await h.settle()
    expect(h.measured).toHaveLength(0)

    // Permission granted five minutes later. Nothing revisits the old JOIN.
    h.setReadiness('ready')
    h.advance(5 * 60_000)
    await h.settle()
    expect(h.measured).toHaveLength(0)

    // A NEW JOIN is measured, because it is a new question.
    h.hub.recordJoin(SOCIAL_JOIN)
    await h.settle()
    expect(h.measured).toHaveLength(1)
    h.restore()
  })

  /**
   * A JOIN following a Gravity impression in the same worker life, which is the
   * ordinary real sequence - the card is seen, then clicked.
   *
   * This does NOT reproduce the bug that cost the first real acceptance: the
   * impression's flush is on a five-second timer that has not fired by the time
   * the JOIN arrives here, so no send is actually in flight. The faithful
   * reproduction, and the mutation lever for it, live in
   * analyticsRecorder.test.ts where a send can be held open. Said plainly
   * because a test that looks like it proves something it does not is worse
   * than no test at all.
   */
  it('measures a JOIN that follows a Gravity impression', async () => {
    const h = harness({ slowFirstSend: true })

    // An impression, and its scheduled flush under way, exactly as Gravity
    // produces before somebody clicks anything.
    h.hub.noteExposure({
      friends: [],
      gatherings: [],
      gravity: [{ channel: 'lirik', friendCount: 3, rank: 1, live: 'live' }],
    })
    h.hub.recordJoin(SOCIAL_JOIN)
    await h.settle()

    expect(h.sent.some((event) => event.event_name === 'join_clicked')).toBe(true)
    expect(h.measured).toHaveLength(1)
    h.restore()
  })

  /** The ordering guarantee, through the real hub rather than the pure gate. */
  it('a JOIN whose canonical event has not been accepted by the server', async () => {
    const h = harness({ failAnalytics: true })
    h.hub.recordJoin(SOCIAL_JOIN)
    await h.settle()

    expect(h.sent).toHaveLength(0)
    expect(h.measured).toHaveLength(0)
    h.restore()
  })
})

// ------------------------------------------------------------- JOIN must win

describe('JOIN must win', () => {
  /**
   * The structural proof, read from the button itself.
   *
   * `joinChannel` is called first and its result decides everything after it.
   * The recording is a fire-and-forget port message with nothing awaited, so
   * there is no expression anywhere in the click handler that a Twitch API call
   * could be inserted in front of.
   */
  it('navigates before recording, and awaits nothing in the click handler', () => {
    const source = readFileSync('src/ui/components/JoinButton.tsx', 'utf8')
    const handler = source.slice(
      source.indexOf('onClick={() => {'),
      source.indexOf('if (!navigated) setJoining(false)'),
    )

    expect(handler).toContain('const navigated = joinChannel(channel)')
    expect(handler.indexOf('joinChannel(channel)')).toBeLessThan(
      handler.indexOf('analytics.recordJoin'),
    )
    // Nothing to wait on: no await, no .then, no promise at all. Comments are
    // stripped first - the doc comment explains this rule and would match it.
    const code = handler.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '')
    expect(code).not.toContain('await')
    expect(code).not.toContain('.then(')
    expect(code).not.toContain('async')
  })

  it('never mentions measurement, permission or OAuth in the JOIN path', () => {
    for (const file of ['src/ui/components/JoinButton.tsx', 'src/platforms/twitch/join.ts']) {
      const source = readFileSync(file, 'utf8')
      for (const forbidden of [
        'grantFollowPermission',
        'measureRelationship',
        'relationship',
        'startOAuth',
        'MeasurementPermission',
        'user:read:follows',
      ]) {
        expect(source, `${file}: ${forbidden}`).not.toContain(forbidden)
      }
    }
  })

  /**
   * The trigger is detached from the hub's serial chain on purpose.
   *
   * Held inside it, a Twitch round trip would sit in front of `noteChannel`,
   * whose arrival timestamp is taken when it is processed - so every measured
   * JOIN would report an inflated `join_arrived.elapsed_ms`. Measurement must
   * not distort the product's own numbers.
   */
  it('does not hold the analytics queue while it measures', () => {
    const source = readFileSync('src/background/analyticsHub.ts', 'utf8')
    const section = source.slice(source.indexOf('M3D: the follow baseline'))
    expect(section).toContain('void deps')
    expect(section).not.toContain('await deps.measureRelationship')
  })

  it('records the JOIN and survives the measurement failing outright', async () => {
    const h = harness({ failMeasurement: true })
    h.hub.recordJoin(SOCIAL_JOIN)
    await h.settle()

    // The product's own record of the product is untouched.
    const clicked = h.sent.find((event) => event.event_name === 'join_clicked')
    expect(clicked).toBeDefined()
    expect(clicked!.attribution_id).toBeTruthy()
    h.restore()
  })

  it('still matches the arrival to the JOIN after a failed measurement', async () => {
    const h = harness({ failMeasurement: true })
    h.hub.recordJoin(SOCIAL_JOIN)
    await h.settle()

    h.advance(4_000)
    h.hub.noteChannel('lirik')
    await h.settle()

    const arrived = h.sent.find((event) => event.event_name === 'join_arrived')
    expect(arrived).toBeDefined()
    expect(arrived!.attribution_id).toBe(
      h.sent.find((event) => event.event_name === 'join_clicked')!.attribution_id,
    )
    h.restore()
  })

  /** Nothing about a failed baseline reaches a surface a person can see. */
  it('surfaces no measurement error to the user', () => {
    const hub = readFileSync('src/background/analyticsHub.ts', 'utf8')
    const section = hub.slice(
      hub.indexOf('M3D: the follow baseline'),
      hub.indexOf("}, 'analytics.recordJoin')"),
    )
    // Reported to the error log, and nowhere else. No state, no port message.
    expect(section).toContain("report('analytics.measureRelationship'")
    // No way out to a person: no state, no port message, no notification.
    for (const forbidden of ['setState', 'postMessage', 'broadcastState', 'notify', 'port.']) {
      expect(section, forbidden).not.toContain(forbidden)
    }
  })
})

// -------------------------------------------------------- the client boundary

describe('the client never learns the answer', () => {
  /**
   * THE INVARIANT THE WHOLE SERVER-SIDE BOUNDARY EXISTS FOR.
   *
   * The caller discards the response entirely. There is no variable holding it,
   * no branch reading it, and nowhere for a follow result to arrive even if the
   * server one day leaked one.
   */
  it('discards the server response rather than reading it', () => {
    const source = readFileSync('src/background/supabaseBackend.ts', 'utf8')
    const fn = source.slice(
      source.indexOf('export async function recordRelationship'),
      source.indexOf('// ============================================================= growth loop'),
    )
    expect(fn).toContain('const { error } =')
    expect(fn).not.toContain('data')
    expect(fn).not.toContain('state')
    expect(fn).not.toContain('recorded')
  })

  it('has no follow state anywhere in the client at all', () => {
    const walk = (dir: string, out: string[] = []): string[] => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const path = `${dir}/${entry.name}`
        if (entry.isDirectory()) walk(path, out)
        else if (/\.tsx?$/.test(entry.name)) out.push(path)
      }
      return out
    }
    const offenders = walk('src').filter((path) => {
      const source = readFileSync(path, 'utf8')
      return (
        source.includes('relationship_present') ||
        source.includes('following_at_join') ||
        source.includes('followsBroadcaster')
      )
    })
    expect(offenders).toEqual([])
  })

  it('sends the two approved fields under the two approved names', () => {
    const source = readFileSync('src/background/supabaseBackend.ts', 'utf8')
    const start = source.indexOf('export async function recordRelationship')
    const fn = source.slice(start, source.indexOf('\n}', start) + 2)
    expect(fn).toContain("action: 'relationship'")
    expect(fn).toContain('broadcaster_login: input.broadcasterLogin')
    expect(fn).toContain('attribution_id: input.attributionId')
    // Nothing identifying the actor. The server reads that from the JWT.
    expect(fn).not.toContain('actor_id')
    expect(fn).not.toContain('user_id')
  })
})

// ---------------------------------------------------------- scope discipline

describe('the Twitch scope set is unchanged by any of this', () => {
  it('asks for no subscription or emote scope anywhere', () => {
    for (const file of [
      'src/background/analyticsHub.ts',
      'src/background/supabaseBackend.ts',
      'src/background/index.ts',
      'src/background/auth.ts',
    ]) {
      const source = readFileSync(file, 'utf8')
      expect(source, file).not.toContain('user:read:subscriptions')
      expect(source, file).not.toContain('user:read:emotes')
    }
  })

  it('adds no Chrome permission and no host permission', () => {
    const manifest = JSON.parse(readFileSync('public/manifest.json', 'utf8')) as {
      permissions: string[]
      host_permissions?: string[]
    }
    expect(manifest.permissions.sort()).toEqual(
      ['alarms', 'identity', 'notifications', 'storage'].sort(),
    )
    /*
     * Unchanged, and it is worth saying why nothing was needed: the
     * relationship call goes to the Supabase Edge Function, on a host the
     * extension already had. Watchside talks to Twitch's API only from the
     * server, using a credential the browser never holds.
     */
    expect(manifest.host_permissions ?? []).toEqual([
      'https://*.supabase.co/*',
      'https://7tv.io/*',
      'https://cdn.7tv.app/*',
    ])
    expect(manifest.host_permissions ?? []).not.toContain('https://api.twitch.tv/*')
  })
})

// ------------------------------------------------- privacy before collection

describe('collection cannot precede disclosure', () => {
  /**
   * THE DEPLOYMENT GUARD.
   *
   * A production caller and an accurate policy are coupled here so neither can
   * ship without the other. If somebody removes the disclosure, the caller that
   * still exists fails this. If somebody adds a second caller before writing
   * about it, same. The coupling is the point - it is not checkable by reading
   * two files and remembering.
   */
  it('a production relationship caller requires the policy to describe it', () => {
    const walk = (dir: string, out: string[] = []): string[] => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const path = `${dir}/${entry.name}`
        if (entry.isDirectory()) walk(path, out)
        else if (/\.tsx?$/.test(entry.name)) out.push(path)
      }
      return out
    }
    const callers = walk('src').filter((path) =>
      /action:\s*'relationship'/.test(readFileSync(path, 'utf8')),
    )

    const policy = readFileSync('docs/PRIVACY.md', 'utf8')
    const discloses =
      policy.includes('Did this person already follow this creator?') &&
      policy.includes('user:read:follows')

    if (callers.length > 0) {
      expect(discloses, `${callers.length} caller(s) exist; the policy must describe them`).toBe(
        true,
      )
    }
  })

  /**
   * There is exactly ONE caller, and it is the one this slice added.
   *
   * Not a style rule: every additional invocation site is another place the
   * eligibility gate could be bypassed, and the gate is the only thing standing
   * between "the channel your friends are watching" and "who you follow".
   */
  it('has exactly one production caller, in the backend module', () => {
    const walk = (dir: string, out: string[] = []): string[] => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const path = `${dir}/${entry.name}`
        if (entry.isDirectory()) walk(path, out)
        else if (/\.tsx?$/.test(entry.name)) out.push(path)
      }
      return out
    }
    const callers = walk('src').filter((path) =>
      /action:\s*'relationship'/.test(readFileSync(path, 'utf8')),
    )
    expect(callers).toEqual(['src/background/supabaseBackend.ts'])
  })
})

// --------------------------------------------------- the coverage record

/**
 * The denominator, recorded at the JOIN.
 *
 * Without this, a JOIN with no baseline is ambiguous between never-eligible,
 * eligible-and-declined, and eligible-and-nothing-came-back. The observation
 * table cannot separate them, because absence is absence - so a percentage over
 * "JOINs" would have a denominator nobody could defend.
 */
describe('what M3D decided is recorded for every socially initiated JOIN', () => {
  const statusOf = (sent: AnalyticsEvent[]) =>
    sent.find((event) => event.event_name === 'join_measurement_status')

  it('records `attempted` when the client asks the server', async () => {
    const h = harness()
    h.hub.recordJoin(SOCIAL_JOIN)
    await h.settle()

    const status = statusOf(h.sent)
    expect(status).toBeDefined()
    expect(status!.properties.status).toBe('attempted')
    // Bound to the same JOIN, so coverage can be computed per attribution.
    expect(status!.attribution_id).toBe(
      h.sent.find((event) => event.event_name === 'join_clicked')!.attribution_id,
    )
    h.restore()
  })

  it('records `not_ready` when the actor cannot be measured', async () => {
    for (const readiness of [
      'needs_follow_permission',
      'needs_reauthorization',
      'temporarily_unavailable',
      null,
    ] as const) {
      const h = harness({ readiness })
      h.hub.recordJoin(SOCIAL_JOIN)
      await h.settle()
      expect(statusOf(h.sent)?.properties.status, `${readiness}`).toBe('not_ready')
      expect(h.measured).toHaveLength(0)
      h.restore()
    }
  })

  /**
   * Nothing is recorded for a JOIN outside the population. A status for a JOIN
   * nobody else was part of would invite counting it in a social denominator.
   */
  it('records nothing for a JOIN outside the measured population', async () => {
    const h = harness()
    h.hub.recordJoin({ ...SOCIAL_JOIN, socialCount: 0, source: 'friend_row' })
    await h.settle()
    expect(statusOf(h.sent)).toBeUndefined()
    h.restore()
  })

  it('records nothing for a click that navigated nowhere', async () => {
    const h = harness()
    h.hub.recordJoin({ ...SOCIAL_JOIN, navigated: false })
    await h.settle()
    expect(statusOf(h.sent)).toBeUndefined()
    h.restore()
  })

  /**
   * THE PROPERTY THAT MAKES IT SAFE TO KEEP AFTER DELETION.
   *
   * `attempted` is recorded before any answer is known, and the client never
   * learns one - so no value here can encode, or be used to rebuild, a
   * relationship that the Twitch lifecycle later deleted.
   */
  it('carries exactly one coarse status and nothing resembling an answer', async () => {
    const h = harness()
    h.hub.recordJoin(SOCIAL_JOIN)
    await h.settle()

    const status = statusOf(h.sent)!
    expect(Object.keys(status.properties)).toEqual(['status'])
    const text = JSON.stringify(status)
    for (const forbidden of ['following', 'relationship', 'true', 'followed']) {
      expect(text, forbidden).not.toContain(forbidden)
    }
    h.restore()
  })

  /** The status is the CLIENT's decision, and the contract says so. */
  it('is documented as a client decision rather than proof Twitch answered', () => {
    const contract = readFileSync('src/core/analytics.ts', 'utf8')
    const declaredAt = contract.indexOf('join_measurement_status: { status')
    expect(declaredAt).toBeGreaterThan(-1)

    // The doc comment immediately above the declaration.
    const doc = contract.slice(
      contract.lastIndexOf('/**', declaredAt),
      declaredAt,
    )
    // Wording is line-wrapped in the source, so the claim is matched in pieces.
    expect(doc).toContain('does NOT mean Twitch')
    expect(doc).toContain('CLIENT')
    expect(doc).toContain('asked the server')
  })
})

/**
 * Data minimisation, asserted rather than intended.
 *
 * The status event names no channel: the attribution already joins it to the
 * JOIN that records the destination, so carrying it here would store the same
 * fact twice for no analytic gain.
 */
describe('the coverage record carries the minimum that answers the question', () => {
  it('records no channel of its own', async () => {
    const h = harness()
    h.hub.recordJoin(SOCIAL_JOIN)
    await h.settle()

    const status = h.sent.find((event) => event.event_name === 'join_measurement_status')!
    expect(status.destination_channel).toBeNull()
    // The JOIN it describes still has it, and the attribution links them.
    const clicked = h.sent.find((event) => event.event_name === 'join_clicked')!
    expect(clicked.destination_channel).toBe('lirik')
    expect(status.attribution_id).toBe(clicked.attribution_id)
    h.restore()
  })
})
