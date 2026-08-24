import { describe, expect, it } from 'vitest'
import { createAnalyticsHub } from '../../src/background/analyticsHub'
import type { AnalyticsEvent } from '../../src/core/analytics'
import { OPPORTUNITY_WINDOW_MS, opportunityKey } from '../../src/core/socialGravity'

/**
 * The hub, end to end: a JOIN clicked on a gathering, arriving, and turning
 * into a shared watch - joined up by one attribution id, which is the thing
 * the whole Social Gravity comparison will be read from.
 *
 * Also the privacy guarantees, asserted against everything that actually
 * reaches the wire rather than against any one function's intentions.
 */

function harness(options: { enabled?: boolean; environment?: 'private_beta' | 'production' } = {}) {
  let clock = 1_700_000_000_000
  let ids = 0
  const sent: AnalyticsEvent[] = []
  let signedIn = true
  let failing = false

  const cells: Record<string, unknown> = {}
  const cell = <T,>(key: string) => ({
    read: async () => (cells[key] ?? null) as T | null,
    write: async (value: T | null) => {
      cells[key] = value
    },
  })

  let selfId: string | null = 'user-a'

  const build = () =>
    createAnalyticsHub({
      backend: {
        async send(events) {
          if (failing) throw new Error('backend down')
          sent.push(...events)
          return events.length
        },
      },
      environment: options.environment ?? 'private_beta',
      appVersion: '0.5.0',
      enabled: options.enabled ?? true,
      sessionStore: cell('session'),
      attributionStore: cell('join'),
      lifecycleStore: cell('lifecycle'),
      canSend: () => signedIn,
      selfId: () => selfId,
      now: () => clock,
    })

  /*
   * A mutable reference, because a worker restart is modelled by building a
   * SECOND hub over the same storage and throwing the first away. Nothing else
   * reproduces the thing being tested: the state machine starts empty and
   * everything it is supposed to remember has to come back out of storage.
   */
  let hub = build()

  // Deterministic ids, so the funnel can be asserted rather than eyeballed.
  const originalUuid = crypto.randomUUID
  crypto.randomUUID = (() => `00000000-0000-4000-8000-${String(++ids).padStart(12, '0')}`) as never

  return {
    get hub() {
      return hub
    },
    sent,
    /** What Chrome evicting the service worker actually does to us. */
    restartWorker: () => {
      hub = build()
    },
    setSelfId: (value: string | null) => {
      selfId = value
    },
    /**
     * Time passing while the worker is alive and the user is watching.
     *
     * Models the presence heartbeat, which calls through to noteTogether every
     * 45 seconds - the signal that keeps the stored interval's last-seen
     * timestamp fresh. Advancing the clock without it would model the worker
     * being dead, which is a different test.
     */
    keepAlive: async (totalMs: number, channel: string | null, otherCount: number) => {
      const beat = 45_000
      /*
       * Each beat is awaited before the next.
       *
       * noteTogether is queued on the hub's serial chain, so advancing the
       * clock N times and then draining once would run every queued tick
       * against the FINAL clock - one big jump wearing the costume of N ticks,
       * which is precisely the thing the staleness check is meant to catch.
       */
      for (let elapsed = 0; elapsed < totalMs; elapsed += beat) {
        clock += Math.min(beat, totalMs - elapsed)
        hub.noteTogether({ channel, otherCount })
        for (let turn = 0; turn < 4; turn += 1) {
          await new Promise((resolve) => setTimeout(resolve, 0))
        }
      }
      await hub.flush()
      for (let index = 0; index < 5; index += 1) {
        await new Promise((resolve) => setTimeout(resolve, 0))
      }
    },
    restore: () => {
      crypto.randomUUID = originalUuid
    },
    advance: (ms: number) => {
      clock += ms
    },
    setSignedIn: (value: boolean) => {
      signedIn = value
    },
    setFailing: (value: boolean) => {
      failing = value
    },
    /** What the hub has written to extension storage. */
    storage: () => cells,
    /**
     * Lets the hub's internal promise chain drain, then sends.
     *
     * Macrotasks rather than a fixed number of microtasks: the chain grew when
     * the lifecycle work was added, and counting ticks quietly stopped being
     * enough - the later calls simply had not run yet, so the test saw an empty
     * result and blamed the code.
     */
    settle: async () => {
      for (let index = 0; index < 5; index += 1) {
        await new Promise((resolve) => setTimeout(resolve, 0))
      }
      await hub.flush()
      for (let index = 0; index < 5; index += 1) {
        await new Promise((resolve) => setTimeout(resolve, 0))
      }
    },
    named: (name: string) => sent.filter((event) => event.event_name === name),
  }
}

describe('the JOIN funnel joins up', () => {
  it('carries one attribution from click to arrival to shared watch', async () => {
    const h = harness()
    try {
      h.hub.noteActive()
      await h.settle()

      h.hub.recordJoin({
        channel: 'LIRIK',
        source: 'gathering',
        socialCount: 6,
        navigated: true,
        alreadyOnTwitch: true,
        alreadyOnDestination: false,
      })
      await h.settle()

      h.advance(4_000)
      h.hub.noteChannel('lirik')
      await h.settle()

      h.hub.noteTogether({ channel: 'lirik', otherCount: 6 })
      await h.settle()

      const [clicked] = h.named('join_clicked')
      const [arrived] = h.named('join_arrived')
      const [together] = h.named('watching_together_started')

      expect(clicked.attribution_id).toBeTruthy()
      expect(arrived.attribution_id).toBe(clicked.attribution_id)
      expect(together.attribution_id).toBe(clicked.attribution_id)

      // Everything the funnel needs, in the columns it needs them in.
      expect(clicked.source).toBe('gathering')
      expect(clicked.destination_channel).toBe('lirik')
      expect(clicked.properties).toMatchObject({
        social_count: 6,
        already_on_twitch: true,
        already_on_destination: false,
        navigated: true,
      })
      expect(arrived.properties.elapsed_ms).toBe(4_000)
      expect(together.properties).toMatchObject({ other_count: 6, from_join: true })
    } finally {
      h.restore()
    }
  })

  it('records a click that goes nowhere without pretending an arrival is coming', async () => {
    const h = harness()
    try {
      h.hub.noteActive()
      h.hub.recordJoin({
        channel: 'lirik',
        source: 'friend_row',
        socialCount: 1,
        navigated: false,
        alreadyOnTwitch: true,
        alreadyOnDestination: true,
      })
      await h.settle()

      const [clicked] = h.named('join_clicked')
      expect(clicked.properties.navigated).toBe(false)
      // No attribution: there is no arrival coming, and a pending record could
      // later be answered by an unrelated navigation back here.
      expect(clicked.attribution_id).toBeNull()

      h.hub.noteChannel('lirik')
      await h.settle()
      expect(h.named('join_arrived')).toHaveLength(0)
    } finally {
      h.restore()
    }
  })

  it('does not credit an unrelated arrival to a JOIN', async () => {
    const h = harness()
    try {
      h.hub.noteActive()
      await h.settle()
      // Ordinary browsing, with no JOIN behind it.
      h.hub.noteChannel('xqc')
      await h.settle()
      expect(h.named('join_arrived')).toHaveLength(0)
    } finally {
      h.restore()
    }
  })

  it('reports a shared watch that nothing led to as such', async () => {
    const h = harness()
    try {
      h.hub.noteActive()
      h.hub.noteTogether({ channel: 'lirik', otherCount: 2 })
      await h.settle()

      const [started] = h.named('watching_together_started')
      expect(started.properties.from_join).toBe(false)
    } finally {
      h.restore()
    }
  })
})

describe('the destination lifecycle reaches the wire intact', () => {
  it('dates the end of co-viewing to when it happened, not when it was noticed', async () => {
    const h = harness()
    try {
      h.hub.noteActive()
      h.hub.recordJoin({
        channel: 'summit1g',
        source: 'friend_row',
        socialCount: 1,
        navigated: true,
        alreadyOnTwitch: true,
        alreadyOnDestination: false,
      })
      h.hub.noteChannel('summit1g')
      h.hub.noteTogether({ channel: 'summit1g', otherCount: 1 })
      await h.settle()

      // Ten minutes of watching together, heartbeat ticking as it does.
      await h.keepAlive(10 * 60 * 1000, 'summit1g', 1)
      const friendLeftAt = 1_700_000_000_000 + 10 * 60 * 1000

      // The friend leaves. Nothing is emitted yet - the grace is running.
      h.hub.noteTogether({ channel: 'summit1g', otherCount: 0 })
      await h.settle()
      expect(h.named('watching_together_ended')).toHaveLength(0)

      // Three more minutes of ticks. The grace expires on the third.
      await h.keepAlive(3 * 60 * 1000, 'summit1g', 0)

      const [end] = h.named('watching_together_ended')
      // The whole point: occurred_at is the effective end, not the tick that
      // confirmed it.
      expect(Date.parse(end.occurred_at)).toBe(friendLeftAt)
      expect(end.properties.duration_ms).toBe(10 * 60 * 1000)
      expect(end.properties.end_reason).toBe('alone_again')
      /*
       * The lag is kept as its own fact. It is now BOUNDED at the grace plus
       * one heartbeat: 120s of deliberate hysteresis, confirmed on the tick at
       * +135s. Before the staleness recheck this could be arbitrarily large.
       */
      expect(end.properties.detection_delay_ms).toBe(135_000)

      // Twenty more minutes alone, then they leave.
      await h.keepAlive(20 * 60 * 1000, 'summit1g', 0)
      h.hub.noteTogether({ channel: null, otherCount: 0 })
      await h.settle()

      const [post] = h.named('post_social_retention_ended')
      expect(post.properties.duration_ms).toBe(23 * 60 * 1000)
      expect(post.properties.from_join).toBe(true)
      expect(post.destination_channel).toBe('summit1g')
      // The same attribution as the click, so the funnel joins straight up.
      expect(post.attribution_id).toBe(h.named('join_clicked')[0].attribution_id)
    } finally {
      h.restore()
    }
  })

  it('records no detection lag when the end is seen immediately', async () => {
    const h = harness()
    try {
      h.hub.noteActive()
      h.hub.noteTogether({ channel: 'summit1g', otherCount: 1 })
      await h.settle()

      h.advance(5 * 60 * 1000)
      h.hub.noteTogether({ channel: null, otherCount: 0 })
      await h.settle()

      const [end] = h.named('watching_together_ended')
      expect(end.properties.detection_delay_ms).toBe(0)
      expect(end.properties.end_reason).toBe('left_channel')
      expect(h.named('post_social_retention_ended')).toHaveLength(0)
    } finally {
      h.restore()
    }
  })

  it('claims no JOIN credit for organic co-viewing', async () => {
    const h = harness()
    try {
      h.hub.noteActive()
      // No JOIN at all: they happened to be watching the same thing.
      h.hub.noteTogether({ channel: 'summit1g', otherCount: 1 })
      await h.settle()

      await h.keepAlive(10 * 60 * 1000, 'summit1g', 1)
      h.hub.noteTogether({ channel: 'summit1g', otherCount: 0 })
      await h.settle()

      await h.keepAlive(10 * 60 * 1000, 'summit1g', 0)
      h.hub.noteTogether({ channel: null, otherCount: 0 })
      await h.settle()

      const [start] = h.named('watching_together_started')
      const [end] = h.named('watching_together_ended')
      const [post] = h.named('post_social_retention_ended')

      // The intervals are still measured - they are facts about what happened.
      expect(end.properties.duration_ms).toBe(10 * 60 * 1000)
      expect(post.properties.duration_ms).toBe(10 * 60 * 1000)
      // The credit is not. Nothing here was brought about by a JOIN.
      expect(start.properties.from_join).toBe(false)
      expect(post.properties.from_join).toBe(false)
      expect(start.attribution_id).toBeNull()
      expect(post.attribution_id).toBeNull()
    } finally {
      h.restore()
    }
  })

  it('does not collapse a cluster of friends to one of them', async () => {
    const h = harness()
    try {
      h.hub.noteActive()
      h.hub.recordJoin({
        channel: 'xqc',
        source: 'gathering',
        socialCount: 3,
        navigated: true,
        alreadyOnTwitch: true,
        alreadyOnDestination: false,
      })
      h.hub.noteChannel('xqc')
      h.hub.noteTogether({ channel: 'xqc', otherCount: 3 })
      await h.settle()

      // One click, one arrival, one shared watch - carrying the size of the
      // opportunity, not the identity of an arbitrarily chosen member of it.
      expect(h.named('join_clicked')).toHaveLength(1)
      expect(h.named('watching_together_started')).toHaveLength(1)
      expect(h.named('join_clicked')[0].properties.social_count).toBe(3)
      expect(h.named('watching_together_started')[0].properties.other_count).toBe(3)

      const wire = JSON.stringify(h.sent)
      // No friend ids anywhere: the social context gets the credit.
      expect(wire).not.toContain('user_id')
      expect(wire).not.toContain('friend_id')
    } finally {
      h.restore()
    }
  })
})

describe('sessions', () => {
  it('opens one and puts every event in it', async () => {
    const h = harness()
    try {
      h.hub.noteActive()
      h.hub.track('group_created')
      await h.settle()

      const [started] = h.named('extension_session_started')
      const [created] = h.named('group_created')
      expect(started.session_id).toBeTruthy()
      expect(created.session_id).toBe(started.session_id)
    } finally {
      h.restore()
    }
  })

  it('starts a second session only after the idle window', async () => {
    const h = harness()
    try {
      h.hub.noteActive()
      await h.settle()
      h.advance(10 * 60 * 1000)
      h.hub.noteActive()
      await h.settle()
      expect(h.named('extension_session_started')).toHaveLength(1)

      h.advance(31 * 60 * 1000)
      h.hub.noteActive()
      await h.settle()

      expect(h.named('extension_session_started')).toHaveLength(2)

      /*
       * The one that expired is closed, dated to when it STOPPED - not to when
       * it was noticed. Otherwise an overnight gap reads as a session that ran
       * until morning, and every average session length is nonsense.
       */
      const [ended] = h.named('extension_session_ended')
      const [firstStart] = h.named('extension_session_started')
      expect(ended.session_id).toBe(firstStart.session_id)
      expect(ended.properties.end_reason).toBe('idle')
      // It was active for the ten minutes between the two touches, then quiet.
      expect(ended.properties.duration_ms).toBe(10 * 60 * 1000)
      expect(Date.parse(ended.occurred_at)).toBe(
        Date.parse(firstStart.occurred_at) + 10 * 60 * 1000,
      )
    } finally {
      h.restore()
    }
  })

  it('closes the session and drops unsent events on sign-out', async () => {
    const h = harness()
    try {
      h.hub.noteActive()
      h.hub.noteTogether({ channel: 'lirik', otherCount: 1 })
      await h.settle()

      h.hub.noteSignedOut()
      await h.settle()

      expect(h.named('watching_together_ended')[0].properties.end_reason).toBe('session_ended')
      expect(h.named('extension_session_ended')[0].properties.end_reason).toBe('signed_out')
    } finally {
      h.restore()
    }
  })

  it('never sends the previous account events under the next account', async () => {
    const h = harness()
    try {
      h.hub.noteActive()
      h.hub.track('group_created')

      // The backend is down, so nothing gets out before the sign-out.
      h.setFailing(true)
      h.hub.noteSignedOut()
      await h.settle()
      expect(h.sent).toHaveLength(0)

      // Somebody else signs in and the backend recovers. What was queued for
      // the previous account must be gone, not delivered as theirs.
      h.setFailing(false)
      h.hub.noteSignedIn({ friendCount: 0, groupCount: 0 })
      await h.settle()

      expect(h.named('group_created')).toHaveLength(0)
      expect(h.named('extension_session_ended')).toHaveLength(0)
    } finally {
      h.restore()
    }
  })

  it('holds events until there is a signed-in actor, rather than losing them', async () => {
    const h = harness()
    try {
      h.setSignedIn(false)
      h.hub.noteActive()
      await h.settle()
      expect(h.sent).toHaveLength(0)

      h.setSignedIn(true)
      h.hub.noteSignedIn({ friendCount: 3, groupCount: 1 })
      await h.settle()

      expect(h.named('extension_session_started')).toHaveLength(1)
      expect(h.named('authenticated_session_started')[0].properties).toMatchObject({
        friend_count: 3,
        group_count: 1,
      })
    } finally {
      h.restore()
    }
  })
})

describe('impressions', () => {
  it('emits one per visible thing, then stays quiet', async () => {
    const h = harness()
    try {
      h.hub.noteActive()
      const report = {
        friends: [{ userId: 'nina', channel: 'lirik', state: 'watching_elsewhere' as const }],
        gatherings: [{ channel: 'xqc', friendCount: 4, rank: 1 }],
        gravity: [],
      }

      h.hub.noteExposure(report)
      h.hub.noteExposure(report)
      h.hub.noteExposure(report)
      await h.settle()

      expect(h.named('friend_presence_impression')).toHaveLength(1)
      expect(h.named('gathering_impression')).toHaveLength(1)
      expect(h.named('gathering_impression')[0].properties).toMatchObject({
        friend_count: 4,
        rank: 1,
      })
      expect(h.named('friend_presence_impression')[0].destination_channel).toBe('lirik')
    } finally {
      h.restore()
    }
  })

  it('ignores anything that is not a channel', async () => {
    const h = harness()
    try {
      h.hub.noteActive()
      h.hub.noteExposure({
        friends: [
          { userId: 'nina', channel: 'https://twitch.tv/lirik', state: 'watching_elsewhere' },
        ],
        gatherings: [],
        gravity: [],
      })
      await h.settle()
      expect(h.named('friend_presence_impression')).toHaveLength(0)
    } finally {
      h.restore()
    }
  })
})

describe('the environment travels with every event', () => {
  it('marks private beta events as such', async () => {
    const h = harness({ environment: 'private_beta' })
    try {
      h.hub.noteActive()
      h.hub.track('group_created')
      await h.settle()
      expect(h.sent.every((event) => event.environment === 'private_beta')).toBe(true)
      expect(h.sent.every((event) => event.app_version === '0.5.0')).toBe(true)
    } finally {
      h.restore()
    }
  })

  it('marks production events as production', async () => {
    const h = harness({ environment: 'production' })
    try {
      h.hub.noteActive()
      await h.settle()
      expect(h.sent.every((event) => event.environment === 'production')).toBe(true)
    } finally {
      h.restore()
    }
  })
})

describe('a disabled hub', () => {
  it('does nothing at all', async () => {
    const h = harness({ enabled: false })
    try {
      h.hub.noteActive()
      h.hub.noteSignedIn({ friendCount: 1, groupCount: 1 })
      h.hub.track('group_created')
      h.hub.recordJoin({
        channel: 'lirik',
        source: 'friend_row',
        socialCount: 1,
        navigated: true,
        alreadyOnTwitch: true,
        alreadyOnDestination: false,
      })
      h.hub.noteChannel('lirik')
      h.hub.noteTogether({ channel: 'lirik', otherCount: 2 })
      h.hub.noteExposure({
        friends: [{ userId: 'nina', channel: 'lirik', state: 'watching_with_you' }],
        gatherings: [{ channel: 'lirik', friendCount: 2, rank: 1 }],
        gravity: [],
      })
      await h.settle()

      expect(h.sent).toHaveLength(0)
    } finally {
      h.restore()
    }
  })

  it('opens no session and writes nothing to storage', async () => {
    const h = harness({ enabled: false })
    try {
      h.hub.noteActive()
      h.hub.recordJoin({
        channel: 'lirik',
        source: 'friend_row',
        socialCount: 1,
        navigated: true,
        alreadyOnTwitch: true,
        alreadyOnDestination: false,
      })
      h.hub.noteChannel('lirik')
      await h.settle()

      /*
       * Not merely "sends nothing" - does nothing.
       *
       * The recorder refuses to send when disabled, so a hub that ignored its
       * own switch would still pass that test while opening sessions and
       * writing attributions into the demo build's storage.
       */
      expect(h.storage()).toEqual({})
    } finally {
      h.restore()
    }
  })
})

describe('what never reaches the wire', () => {
  it('carries no message content, tokens, emails or URLs', async () => {
    const h = harness()
    try {
      h.hub.noteActive()
      h.hub.track('group_message_sent', { length_bucket: 'medium', has_emote: true })
      // Even if a call site tried, there is no key for it.
      h.hub.track('group_message_sent', {
        body: 'hey are you watching this',
        token: 'ya29.a0secret',
        email: 'someone@example.test',
        url: 'https://twitch.tv/lirik/videos',
      } as never)
      h.hub.recordJoin({
        channel: 'lirik',
        source: 'friend_row',
        socialCount: 1,
        navigated: true,
        alreadyOnTwitch: false,
        alreadyOnDestination: false,
      })
      await h.settle()

      const wire = JSON.stringify(h.sent)
      for (const forbidden of [
        'hey are you watching this',
        'ya29.a0secret',
        'someone@example.test',
        'https://',
        'twitch.tv',
      ]) {
        expect(wire).not.toContain(forbidden)
      }
    } finally {
      h.restore()
    }
  })

  it('records shape rather than content for a message', async () => {
    const h = harness()
    try {
      h.hub.noteActive()
      h.hub.track('group_message_sent', { length_bucket: 'short', has_emote: false })
      await h.settle()
      expect(h.named('group_message_sent')[0].properties).toEqual({
        length_bucket: 'short',
        has_emote: false,
      })
    } finally {
      h.restore()
    }
  })

  it('never carries an actor id, because the client does not get to claim one', async () => {
    const h = harness()
    try {
      h.hub.noteActive()
      h.hub.track('group_created')
      await h.settle()
      for (const event of h.sent) {
        expect(Object.keys(event)).not.toContain('actor_id')
        expect(Object.keys(event)).not.toContain('user_id')
      }
    } finally {
      h.restore()
    }
  })
})

/**
 * Surviving the service worker being evicted.
 *
 * The tracker is a state machine in a closure and an MV3 worker is thrown away
 * whenever Chrome feels like it. A shared watch runs for however long people
 * watch together and the retention after it for however long somebody stays
 * on - both routinely longer than a worker lives. When the worker died
 * mid-interval the end was never emitted, and if the user was still watching
 * with somebody a second START was, counting one evening as two.
 *
 * Every test here models a restart the only way that proves anything: by
 * building a SECOND hub over the same storage and throwing the first away, so
 * the state machine really does begin empty and everything it is supposed to
 * remember has to come back out of storage.
 */
describe('surviving a worker restart', () => {
  const MINUTE = 60 * 1000

  it('resumes a shared watch that is still going', async () => {
    const h = harness()
    try {
      h.hub.noteActive()
      h.hub.noteTogether({ channel: 'summit1g', otherCount: 1 })
      await h.settle()
      expect(h.named('watching_together_started')).toHaveLength(1)

      // Ten minutes of watching, with the heartbeat ticking as it does while
      // the worker is alive.
      await h.keepAlive(10 * MINUTE, 'summit1g', 1)

      // Then Chrome throws the worker away, and a moment later it is back.
      h.advance(3_000)
      h.restartWorker()
      h.hub.noteTogether({ channel: 'summit1g', otherCount: 1 })
      await h.settle()

      // The interval continued. A second start would have counted one evening
      // as two, which is the bug this exists for.
      expect(h.named('watching_together_started')).toHaveLength(1)
      expect(h.named('watching_together_ended')).toHaveLength(0)

      await h.keepAlive(10 * MINUTE, 'summit1g', 1)
      h.hub.noteTogether({ channel: null, otherCount: 0 })
      await h.settle()

      const [end] = h.named('watching_together_ended')
      // Twenty minutes and change, measured from the original start rather
      // than from the restart.
      expect(end.properties.duration_ms).toBe(20 * MINUTE + 3_000)
      expect(end.properties.end_reason).toBe('left_channel')
    } finally {
      h.restore()
    }
  })

  it('carries post-social retention through a restart', async () => {
    const h = harness()
    try {
      // A JOIN brings the user to summit1g, where somebody already is.
      h.hub.noteActive()
      h.hub.recordJoin({
        channel: 'summit1g',
        source: 'friend_row',
        socialCount: 1,
        navigated: true,
        alreadyOnTwitch: true,
        alreadyOnDestination: false,
      })
      h.hub.noteChannel('summit1g')
      h.hub.noteTogether({ channel: 'summit1g', otherCount: 1 })
      await h.settle()
      const attribution = h.named('join_clicked')[0].attribution_id
      const startedAt = 1_700_000_000_000

      // The friend leaves after ten minutes and the grace expires, so the
      // retention interval is open when the worker dies.
      await h.keepAlive(10 * MINUTE, 'summit1g', 1)
      const friendLeftAt = startedAt + 10 * MINUTE
      h.hub.noteTogether({ channel: 'summit1g', otherCount: 0 })
      await h.settle()
      await h.keepAlive(3 * MINUTE, 'summit1g', 0)
      expect(h.named('watching_together_ended')).toHaveLength(1)
      expect(h.named('post_social_retention_ended')).toHaveLength(0)

      // Chrome throws the worker away, and a moment later it is back.
      h.advance(3_000)
      h.restartWorker()

      // Still watching on alone; the new worker picks the interval back up.
      h.hub.noteTogether({ channel: 'summit1g', otherCount: 0 })
      await h.settle()
      expect(h.named('post_social_retention_ended')).toHaveLength(0)

      // Twenty more minutes alone, then they leave.
      await h.keepAlive(20 * MINUTE, 'summit1g', 0)
      h.hub.noteTogether({ channel: null, otherCount: 0 })
      await h.settle()

      const post = h.named('post_social_retention_ended')
      expect(post).toHaveLength(1)
      // Measured from when the friend actually left, across the restart:
      // three minutes of grace ticks, three seconds of worker death, twenty
      // minutes alone.
      expect(post[0].properties.duration_ms).toBe(23 * MINUTE + 3_000)
      expect(post[0].properties.end_reason).toBe('left_channel')
      // destination_left_at, and the JOIN that is still responsible for it.
      expect(Date.parse(post[0].occurred_at)).toBe(friendLeftAt + 23 * MINUTE + 3_000)
      expect(post[0].attribution_id).toBe(attribution)
      expect(post[0].properties.from_join).toBe(true)
    } finally {
      h.restore()
    }
  })

  it('resumes mid-grace without ending the shared watch', async () => {
    const h = harness()
    try {
      h.hub.noteActive()
      h.hub.noteTogether({ channel: 'summit1g', otherCount: 1 })
      await h.settle()

      await h.keepAlive(10 * MINUTE, 'summit1g', 1)
      // The co-viewer drops off; the two-minute grace starts.
      h.hub.noteTogether({ channel: 'summit1g', otherCount: 0 })
      await h.settle()
      const droppedAt = 1_700_000_000_000 + 10 * MINUTE

      h.advance(30_000)
      h.restartWorker()

      // They come back inside the grace: a flap, not a departure.
      h.hub.noteTogether({ channel: 'summit1g', otherCount: 1 })
      await h.settle()
      expect(h.named('watching_together_ended')).toHaveLength(0)

      await h.keepAlive(10 * MINUTE, 'summit1g', 1)
      h.hub.noteTogether({ channel: null, otherCount: 0 })
      await h.settle()

      const [end] = h.named('watching_together_ended')
      // The whole stretch counts, flap and restart included.
      expect(end.properties.duration_ms).toBe(20 * MINUTE + 30_000)
      expect(Date.parse(end.occurred_at)).toBeGreaterThan(droppedAt)
    } finally {
      h.restore()
    }
  })

  it('keeps the effective end when the restart lands between end and detection', async () => {
    const h = harness()
    try {
      h.hub.noteActive()
      h.hub.noteTogether({ channel: 'summit1g', otherCount: 1 })
      await h.settle()
      const startedAt = 1_700_000_000_000

      // The co-viewer goes. The grace has not expired, so nothing is emitted -
      // the pending end lives only in the interval's aloneSince.
      await h.keepAlive(10 * MINUTE, 'summit1g', 1)
      h.hub.noteTogether({ channel: 'summit1g', otherCount: 0 })
      await h.settle()
      expect(h.named('watching_together_ended')).toHaveLength(0)

      // The worker dies a minute into the grace, and is back thirty seconds
      // later - so the grace expires on the far side of the restart.
      h.advance(60_000)
      h.restartWorker()
      h.advance(90_000)

      h.hub.noteTogether({ channel: 'summit1g', otherCount: 0 })
      await h.settle()

      const [end] = h.named('watching_together_ended')
      /*
       * Ten minutes, dated to when the co-viewer actually went - even though
       * the worker that saw them go no longer exists and the grace expired
       * under a different one. The pending end travelled through storage in
       * the interval's aloneSince.
       */
      expect(end.properties.duration_ms).toBe(10 * MINUTE)
      expect(Date.parse(end.occurred_at)).toBe(startedAt + 10 * MINUTE)
      expect(end.properties.end_reason).toBe('alone_again')
      expect(end.properties.detection_delay_ms).toBe(150_000)
    } finally {
      h.restore()
    }
  })

  it('keeps a JOIN attributable when the restart happens before anyone is there', async () => {
    const h = harness()
    try {
      h.hub.noteActive()
      h.hub.recordJoin({
        channel: 'summit1g',
        source: 'gathering',
        socialCount: 3,
        navigated: true,
        alreadyOnTwitch: true,
        alreadyOnDestination: false,
      })
      h.hub.noteChannel('summit1g')
      await h.settle()
      const attribution = h.named('join_clicked')[0].attribution_id
      expect(h.named('join_arrived')).toHaveLength(1)

      // No shared watch yet - presence has not caught up. Then the worker dies.
      h.advance(30_000)
      h.restartWorker()

      h.hub.noteTogether({ channel: 'summit1g', otherCount: 3 })
      await h.settle()

      const [started] = h.named('watching_together_started')
      // The attribution survives in its own store, so the shared watch is
      // still that JOIN's outcome.
      expect(started.attribution_id).toBe(attribution)
      expect(started.properties.from_join).toBe(true)
    } finally {
      h.restore()
    }
  })

  it('closes a stale interval at the last moment it could vouch for', async () => {
    const h = harness()
    try {
      h.hub.noteActive()
      h.hub.noteTogether({ channel: 'summit1g', otherCount: 2 })
      await h.settle()
      const startedAt = 1_700_000_000_000

      /*
       * Nine minutes of watching together, then the laptop lid is shut.
       *
       * Nine rather than ten so the run divides evenly into 45s heartbeats.
       * The storage write is throttled to 30s, so a total that leaves a short
       * final beat would skip its write and the stored last-seen would trail
       * the real one - conservative, but not a round number to assert on.
       */
      await h.keepAlive(9 * MINUTE, 'summit1g', 2)
      const lastSeenAt = startedAt + 9 * MINUTE

      // Three hours later the machine wakes and the tab is still open.
      h.advance(3 * 60 * MINUTE)
      h.restartWorker()
      h.hub.noteTogether({ channel: 'summit1g', otherCount: 2 })
      await h.settle()

      const ends = h.named('watching_together_ended')
      expect(ends).toHaveLength(1)
      /*
       * Ten minutes, not three hours and ten. We have no idea what happened
       * while nothing was running, so the interval is closed at the last
       * moment we could vouch for and labelled as what it is.
       */
      expect(ends[0].properties.duration_ms).toBe(9 * MINUTE)
      expect(Date.parse(ends[0].occurred_at)).toBe(lastSeenAt)
      expect(ends[0].properties.end_reason).toBe('observation_lost')

      // And the world we woke up to starts a fresh interval of its own.
      expect(h.named('watching_together_started')).toHaveLength(2)
    } finally {
      h.restore()
    }
  })

  it('closes an interval whose channel changed while nothing was running', async () => {
    const h = harness()
    try {
      h.hub.noteActive()
      h.hub.noteTogether({ channel: 'summit1g', otherCount: 1 })
      await h.settle()
      const startedAt = 1_700_000_000_000

      await h.keepAlive(9 * MINUTE, 'summit1g', 1)

      h.advance(MINUTE)
      h.restartWorker()
      // They are on a different channel now.
      h.hub.noteTogether({ channel: 'lirik', otherCount: 0 })
      await h.settle()

      const [end] = h.named('watching_together_ended')
      // They did leave; we simply did not see when, so it ends at the last
      // moment we could vouch for and the gap is reported as detection lag.
      expect(end.properties.end_reason).toBe('left_channel')
      expect(end.properties.duration_ms).toBe(9 * MINUTE)
      expect(Date.parse(end.occurred_at)).toBe(startedAt + 9 * MINUTE)
      expect(end.properties.detection_delay_ms).toBe(MINUTE)
    } finally {
      h.restore()
    }
  })

  it('does not double-emit across several restarts', async () => {
    const h = harness()
    try {
      h.hub.noteActive()
      h.hub.noteTogether({ channel: 'summit1g', otherCount: 1 })
      await h.settle()

      for (let round = 0; round < 5; round += 1) {
        h.advance(2 * MINUTE)
        h.restartWorker()
        h.hub.noteTogether({ channel: 'summit1g', otherCount: 1 })
        await h.settle()
      }

      expect(h.named('watching_together_started')).toHaveLength(1)
      expect(h.named('watching_together_ended')).toHaveLength(0)

      h.advance(MINUTE)
      h.hub.noteTogether({ channel: null, otherCount: 0 })
      await h.settle()
      expect(h.named('watching_together_ended')).toHaveLength(1)
      expect(h.named('watching_together_started')).toHaveLength(1)
    } finally {
      h.restore()
    }
  })

  it('pins the interval to the session it began in', async () => {
    const h = harness()
    try {
      h.hub.noteActive()
      h.hub.noteTogether({ channel: 'summit1g', otherCount: 1 })
      await h.settle()
      const startedSession = h.named('watching_together_started')[0].session_id

      // Long enough that the analytics session itself has expired, so the
      // worker that wakes up opens a new one.
      h.advance(3 * 60 * MINUTE)
      h.restartWorker()
      h.hub.noteActive()
      h.hub.noteTogether({ channel: 'summit1g', otherCount: 1 })
      await h.settle()

      const [end] = h.named('watching_together_ended')
      /*
       * The end carries the session the interval STARTED in.
       *
       * The reporting views pair a start with its end on actor, session and
       * channel. An end filed under the new session would pair with nothing,
       * turning one shared watch into an unfinished start plus an orphan end.
       */
      expect(end.session_id).toBe(startedSession)
      expect(h.named('extension_session_started').length).toBeGreaterThan(1)
    } finally {
      h.restore()
    }
  })
})

describe('the stored interval and other accounts', () => {
  const MINUTE = 60 * 1000

  it('never emits one account interval under the next', async () => {
    const h = harness()
    try {
      h.hub.noteActive()
      h.hub.noteTogether({ channel: 'summit1g', otherCount: 1 })
      await h.settle()
      const before = h.sent.length

      // A different person signs in on the same machine, and the worker has
      // been restarted in between.
      h.advance(MINUTE)
      h.restartWorker()
      h.setSelfId('user-b')
      h.hub.noteTogether({ channel: 'summit1g', otherCount: 1 })
      await h.settle()

      /*
       * User A's interval is dropped rather than ended.
       *
       * The actor on every event is auth.uid() server-side, so emitting the
       * end now would file A's viewing under B's name. Losing the interval is
       * the correct trade.
       */
      const ends = h.sent.slice(before).filter((e) => e.event_name === 'watching_together_ended')
      expect(ends).toHaveLength(0)
      // B gets a clean start of their own.
      expect(h.named('watching_together_started')).toHaveLength(2)
    } finally {
      h.restore()
    }
  })

  it('clears the stored interval on sign-out', async () => {
    const h = harness()
    try {
      h.hub.noteActive()
      h.hub.noteTogether({ channel: 'summit1g', otherCount: 1 })
      await h.settle()
      expect(h.storage().lifecycle).toBeTruthy()

      h.advance(5 * MINUTE)
      h.hub.noteSignedOut()
      await h.settle()

      // Ended properly, and nothing left behind for the next account to find.
      expect(h.named('watching_together_ended')).toHaveLength(1)
      expect(h.storage().lifecycle ?? null).toBeNull()
    } finally {
      h.restore()
    }
  })

  it('ends an interval a restarted worker never saw, on sign-out', async () => {
    const h = harness()
    try {
      h.hub.noteActive()
      h.hub.noteTogether({ channel: 'summit1g', otherCount: 1 })
      await h.settle()
      const startedAt = 1_700_000_000_000

      // The worker restarts and the user signs out before any presence
      // arrives, so this worker has never seen the interval in memory.
      h.advance(2 * MINUTE)
      h.restartWorker()
      h.hub.noteSignedOut()
      await h.settle()

      const [end] = h.named('watching_together_ended')
      expect(end).toBeDefined()
      // Closed at the last moment we could vouch for, not at the sign-out.
      expect(Date.parse(end.occurred_at)).toBe(startedAt)
      expect(h.storage().lifecycle ?? null).toBeNull()
    } finally {
      h.restore()
    }
  })

  it('stores nothing once the interval is over', async () => {
    const h = harness()
    try {
      h.hub.noteActive()
      h.hub.noteTogether({ channel: 'summit1g', otherCount: 1 })
      await h.settle()
      expect(h.storage().lifecycle).toBeTruthy()

      h.advance(5 * MINUTE)
      h.hub.noteTogether({ channel: null, otherCount: 0 })
      await h.settle()

      // Nothing about what anybody watched is left lying around.
      expect(h.storage().lifecycle ?? null).toBeNull()
    } finally {
      h.restore()
    }
  })

  it('fails closed on a corrupt stored interval', async () => {
    const h = harness()
    try {
      h.hub.noteActive()
      h.hub.noteTogether({ channel: 'summit1g', otherCount: 1 })
      await h.settle()
      const before = h.sent.length

      // Whatever wrote this, it is not something this version understands.
      h.storage().lifecycle = { userId: 'user-a', state: { channel: 42 }, lastSeenAt: 'soon' }

      h.advance(MINUTE)
      h.restartWorker()
      h.hub.noteTogether({ channel: 'summit1g', otherCount: 1 })
      await h.settle()

      // No interval resumed, no end invented from a shape we cannot read.
      const ends = h.sent.slice(before).filter((e) => e.event_name === 'watching_together_ended')
      expect(ends).toHaveLength(0)
      expect(h.named('watching_together_started')).toHaveLength(2)
    } finally {
      h.restore()
    }
  })

  it('stores nothing while there is nobody to store it for', async () => {
    const h = harness()
    try {
      // Signed out, so there is no actor. The interval is still tracked in
      // memory - it may become attributable once somebody signs in - but
      // nothing about anyone's viewing is written down with no owner on it.
      h.setSelfId(null)
      h.hub.noteActive()
      h.hub.noteTogether({ channel: 'summit1g', otherCount: 2 })
      await h.settle()

      expect(h.storage().lifecycle ?? null).toBeNull()
    } finally {
      h.restore()
    }
  })

  it('stores nothing at all when analytics is disabled', async () => {
    const h = harness({ enabled: false })
    try {
      h.hub.noteActive()
      h.hub.noteTogether({ channel: 'summit1g', otherCount: 2 })
      await h.settle()
      expect(h.storage()).toEqual({})
    } finally {
      h.restore()
    }
  })
})

/**
 * Sleep, suspend, and any other gap a LIVING worker can wake up from.
 *
 * THE CASE THIS EXISTS FOR
 *
 * The restore-from-storage reconciliation runs once per worker life, which is
 * exactly right for a worker that DIED: it comes back, reads storage, and
 * decides whether the world still looks the way it left it. But an OS suspend
 * freezes a worker without killing it. Such a worker wakes with its state
 * intact and no reason to doubt any of it, so before this the interval simply
 * carried on and the whole sleep was reported as time spent watching together.
 *
 * That was the only place in the system that could INVENT viewing time rather
 * than merely lose some, which is the wrong direction to be wrong in.
 *
 * A frozen worker and a restarted one must now give the same answer, and these
 * tests run the same scenarios down both paths to prove it.
 */
describe('a gap while the worker was alive', () => {
  const MINUTE = 60 * 1000

  it('closes a shared watch at the last moment it could vouch for', async () => {
    const h = harness()
    try {
      h.hub.noteActive()
      h.hub.noteTogether({ channel: 'summit1g', otherCount: 2 })
      await h.settle()
      const startedAt = 1_700_000_000_000

      // Nine minutes of real watching, heartbeat ticking.
      await h.keepAlive(9 * MINUTE, 'summit1g', 2)
      const lastSeenAt = startedAt + 9 * MINUTE

      /*
       * The machine sleeps for three hours. No worker restart - this hub
       * instance survives, so nothing reads storage and nothing reconciles
       * unless the tick itself doubts what it is holding.
       */
      h.advance(3 * 60 * MINUTE)
      h.hub.noteTogether({ channel: 'summit1g', otherCount: 2 })
      await h.settle()

      const ends = h.named('watching_together_ended')
      expect(ends).toHaveLength(1)
      // Nine minutes, not three hours and nine.
      expect(ends[0].properties.duration_ms).toBe(9 * MINUTE)
      expect(Date.parse(ends[0].occurred_at)).toBe(lastSeenAt)
      expect(ends[0].properties.end_reason).toBe('observation_lost')
      // The sleep is excluded, not redistributed somewhere else.
      expect(ends[0].properties.detection_delay_ms).toBe(3 * 60 * MINUTE)

      // And the world we woke up to starts a fresh interval of its own.
      expect(h.named('watching_together_started')).toHaveLength(2)
    } finally {
      h.restore()
    }
  })

  it('gives the same answer whether the worker survived or not', async () => {
    /*
     * The whole point of the fix. A three-hour gap must be read identically
     * whether Chrome happened to keep the worker across the suspend or not -
     * otherwise correctness depends on unspecified browser behaviour.
     */
    const run = async (killWorker: boolean) => {
      const h = harness()
      try {
        h.hub.noteActive()
        h.hub.noteTogether({ channel: 'summit1g', otherCount: 2 })
        await h.settle()
        await h.keepAlive(9 * MINUTE, 'summit1g', 2)

        h.advance(3 * 60 * MINUTE)
        if (killWorker) h.restartWorker()
        h.hub.noteTogether({ channel: 'summit1g', otherCount: 2 })
        await h.settle()

        const [end] = h.named('watching_together_ended')
        return {
          duration: end.properties.duration_ms,
          occurred: end.occurred_at,
          reason: end.properties.end_reason,
          starts: h.named('watching_together_started').length,
        }
      } finally {
        h.restore()
      }
    }

    expect(await run(false)).toEqual(await run(true))
  })

  it('does not credit a sleep as post-social retention', async () => {
    const h = harness()
    try {
      h.hub.noteActive()
      h.hub.recordJoin({
        channel: 'summit1g',
        source: 'friend_row',
        socialCount: 1,
        navigated: true,
        alreadyOnTwitch: true,
        alreadyOnDestination: false,
      })
      h.hub.noteChannel('summit1g')
      h.hub.noteTogether({ channel: 'summit1g', otherCount: 1 })
      await h.settle()
      const startedAt = 1_700_000_000_000

      // The friend leaves at nine minutes; the grace expires over the next few
      // ticks, so a retention interval is open when the machine sleeps.
      await h.keepAlive(9 * MINUTE, 'summit1g', 1)
      const friendLeftAt = startedAt + 9 * MINUTE
      h.hub.noteTogether({ channel: 'summit1g', otherCount: 0 })
      await h.settle()
      await h.keepAlive(3 * MINUTE, 'summit1g', 0)
      expect(h.named('watching_together_ended')).toHaveLength(1)

      // Three hours of sleep, worker intact, then a tick.
      h.advance(3 * 60 * MINUTE)
      h.hub.noteTogether({ channel: 'summit1g', otherCount: 0 })
      await h.settle()

      const [post] = h.named('post_social_retention_ended')
      expect(post).toBeDefined()
      /*
       * Three minutes of watching on alone - the ticks between the friend
       * leaving and the sleep - and not one second of the sleep itself.
       */
      expect(post.properties.duration_ms).toBe(3 * MINUTE)
      expect(post.properties.end_reason).toBe('observation_lost')
      expect(Date.parse(post.occurred_at)).toBe(friendLeftAt + 3 * MINUTE)
      // The shared watch it followed is untouched and still attributed.
      expect(h.named('watching_together_ended')[0].properties.duration_ms).toBe(9 * MINUTE)
      expect(post.attribution_id).toBe(h.named('join_clicked')[0].attribution_id)
    } finally {
      h.restore()
    }
  })

  it('leaves a short gap alone', async () => {
    const h = harness()
    try {
      h.hub.noteActive()
      h.hub.noteTogether({ channel: 'summit1g', otherCount: 1 })
      await h.settle()

      await h.keepAlive(9 * MINUTE, 'summit1g', 1)

      // Two minutes: inside the resume window, so this is an ordinary quiet
      // stretch rather than a gap we cannot account for.
      h.advance(2 * MINUTE)
      h.hub.noteTogether({ channel: 'summit1g', otherCount: 1 })
      await h.settle()

      expect(h.named('watching_together_ended')).toHaveLength(0)
      expect(h.named('watching_together_started')).toHaveLength(1)

      await h.keepAlive(MINUTE, 'summit1g', 1)
      h.hub.noteTogether({ channel: null, otherCount: 0 })
      await h.settle()

      const [end] = h.named('watching_together_ended')
      // The quiet two minutes still count: the worker was there for them.
      expect(end.properties.duration_ms).toBe(12 * MINUTE)
      expect(end.properties.end_reason).toBe('left_channel')
    } finally {
      h.restore()
    }
  })

  it('emits one end however many ticks follow the gap', async () => {
    const h = harness()
    try {
      h.hub.noteActive()
      h.hub.noteTogether({ channel: 'summit1g', otherCount: 2 })
      await h.settle()
      await h.keepAlive(9 * MINUTE, 'summit1g', 2)

      h.advance(3 * 60 * MINUTE)

      // Ten ticks in a row after the sleep. The first closes the old interval
      // and opens a new one; the rest must do nothing at all.
      for (let tick = 0; tick < 10; tick += 1) {
        h.advance(45_000)
        h.hub.noteTogether({ channel: 'summit1g', otherCount: 2 })
        await h.settle()
      }

      expect(h.named('watching_together_ended')).toHaveLength(1)
      expect(h.named('watching_together_started')).toHaveLength(2)
    } finally {
      h.restore()
    }
  })

  it('does not credit a sleep when the user signs out on waking', async () => {
    const h = harness()
    try {
      h.hub.noteActive()
      h.hub.noteTogether({ channel: 'summit1g', otherCount: 1 })
      await h.settle()
      await h.keepAlive(9 * MINUTE, 'summit1g', 1)
      const lastSeenAt = 1_700_000_000_000 + 9 * MINUTE

      h.advance(3 * 60 * MINUTE)
      h.hub.noteSignedOut()
      await h.settle()

      const [end] = h.named('watching_together_ended')
      // stop() would have closed this at now(). The staleness check runs
      // first, so signing out after a sleep is no more generous than a tick.
      expect(end.properties.duration_ms).toBe(9 * MINUTE)
      expect(Date.parse(end.occurred_at)).toBe(lastSeenAt)
      expect(end.properties.end_reason).toBe('observation_lost')
      expect(h.storage().lifecycle ?? null).toBeNull()
    } finally {
      h.restore()
    }
  })
})

/**
 * Social Gravity on the wire.
 *
 * The funnel this has to support is impression -> join_clicked -> join_arrived
 * -> watching_together_started -> post-social retention, joined up well enough
 * to answer two separate questions: does the map persuade people to move, and
 * do those moves become anything. Collapsing them into one number would hide
 * exactly the case that matters - a JOIN that goes nowhere.
 */
describe('social gravity analytics', () => {
  const gravityReport = (
    clusters: Array<{ channel: string; friendCount: number; rank: number }>,
  ) => ({ friends: [], gatherings: [], gravity: clusters })

  it('reports a cluster once per exposure window, not once per render', async () => {
    const h = harness()
    try {
      h.hub.noteActive()
      const report = gravityReport([{ channel: 'lirik', friendCount: 3, rank: 1 }])

      // A presence heartbeat re-renders the map. That is one glance.
      for (let render = 0; render < 20; render += 1) h.hub.noteExposure(report)
      await h.settle()

      const impressions = h.named('gravity_cluster_impression')
      expect(impressions).toHaveLength(1)
      expect(impressions[0].destination_channel).toBe('lirik')
      expect(impressions[0].source).toBe('social_gravity')
      expect(impressions[0].properties).toMatchObject({
        friend_count: 3,
        rank: 1,
        visible_clusters: 1,
      })
      expect(impressions[0].properties.opportunity_key).toBe(
        opportunityKey('lirik', 1_700_000_000_000),
      )
    } finally {
      h.restore()
    }
  })

  it('reports each visible destination, with its rank', async () => {
    const h = harness()
    try {
      h.hub.noteActive()
      h.hub.noteExposure(
        gravityReport([
          { channel: 'lirik', friendCount: 3, rank: 1 },
          { channel: 'xqc', friendCount: 1, rank: 2 },
        ]),
      )
      await h.settle()

      const impressions = h.named('gravity_cluster_impression')
      expect(impressions).toHaveLength(2)
      expect(impressions.map((event) => event.destination_channel)).toEqual(['lirik', 'xqc'])
      expect(impressions.map((event) => event.properties.rank)).toEqual([1, 2])
      // Both know how much competition they had.
      expect(impressions.every((event) => event.properties.visible_clusters === 2)).toBe(true)
    } finally {
      h.restore()
    }
  })

  it('does not mint a new opportunity for a brief flap', async () => {
    const h = harness()
    try {
      h.hub.noteActive()
      const report = gravityReport([{ channel: 'lirik', friendCount: 2, rank: 1 }])
      h.hub.noteExposure(report)
      await h.settle()

      // A friend flickers out and comes back inside the absence window.
      h.hub.noteExposure({ friends: [], gatherings: [], gravity: [] })
      h.advance(30_000)
      h.hub.noteExposure(report)
      await h.settle()

      // One impression, and the opportunity it named is unchanged.
      expect(h.named('gravity_cluster_impression')).toHaveLength(1)
      expect(opportunityKey('lirik', 1_700_000_000_000 + 30_000)).toBe(
        opportunityKey('lirik', 1_700_000_000_000),
      )
    } finally {
      h.restore()
    }
  })

  it('treats a gathering that reforms much later as a new opportunity', async () => {
    const h = harness()
    try {
      h.hub.noteActive()
      const report = gravityReport([{ channel: 'lirik', friendCount: 2, rank: 1 }])
      h.hub.noteExposure(report)
      await h.settle()
      const first = h.named('gravity_cluster_impression')[0].properties.opportunity_key

      // Gone for the evening, back much later.
      h.hub.noteExposure({ friends: [], gatherings: [], gravity: [] })
      h.advance(OPPORTUNITY_WINDOW_MS + 60_000)
      h.hub.noteExposure(report)
      await h.settle()

      const impressions = h.named('gravity_cluster_impression')
      expect(impressions).toHaveLength(2)
      expect(impressions[1].properties.opportunity_key).not.toBe(first)
    } finally {
      h.restore()
    }
  })

  it('carries the same opportunity from the impression to the JOIN', async () => {
    const h = harness()
    try {
      h.hub.noteActive()
      h.hub.noteExposure(gravityReport([{ channel: 'lirik', friendCount: 3, rank: 1 }]))
      await h.settle()

      h.hub.recordJoin({
        channel: 'lirik',
        source: 'social_gravity',
        socialCount: 3,
        navigated: true,
        alreadyOnTwitch: true,
        alreadyOnDestination: false,
      })
      await h.settle()

      const [impression] = h.named('gravity_cluster_impression')
      const [clicked] = h.named('join_clicked')

      // The join to the impression, for conversion by opportunity.
      expect(clicked.properties.opportunity_key).toBe(impression.properties.opportunity_key)
      expect(clicked.source).toBe('social_gravity')
      expect(clicked.properties.social_count).toBe(3)
    } finally {
      h.restore()
    }
  })

  it('keeps the whole funnel on one attribution', async () => {
    const h = harness()
    try {
      h.hub.noteActive()
      h.hub.noteExposure(gravityReport([{ channel: 'lirik', friendCount: 3, rank: 1 }]))
      h.hub.recordJoin({
        channel: 'lirik',
        source: 'social_gravity',
        socialCount: 3,
        navigated: true,
        alreadyOnTwitch: true,
        alreadyOnDestination: false,
      })
      h.hub.noteChannel('lirik')
      h.hub.noteTogether({ channel: 'lirik', otherCount: 3 })
      await h.settle()

      const attribution = h.named('join_clicked')[0].attribution_id
      expect(attribution).toBeTruthy()
      expect(h.named('join_arrived')[0].attribution_id).toBe(attribution)
      // The outcome half of the funnel: did the move become anything.
      expect(h.named('watching_together_started')[0].attribution_id).toBe(attribution)
      expect(h.named('watching_together_started')[0].properties.from_join).toBe(true)
    } finally {
      h.restore()
    }
  })

  it('names no friend anywhere on the wire', async () => {
    const h = harness()
    try {
      h.hub.noteActive()
      h.hub.noteExposure(gravityReport([{ channel: 'lirik', friendCount: 3, rank: 1 }]))
      h.hub.recordJoin({
        channel: 'lirik',
        source: 'social_gravity',
        socialCount: 3,
        navigated: true,
        alreadyOnTwitch: true,
        alreadyOnDestination: false,
      })
      await h.settle()

      /*
       * The social context gets the credit, never a person. A cluster is a
       * thing several people act on, and picking one of them to name would be
       * both wrong and a privacy regression.
       */
      const wire = JSON.stringify(h.sent)
      for (const forbidden of ['jake', 'matt', 'chris', 'user_id', 'friend_id', 'userId']) {
        expect(wire).not.toContain(forbidden)
      }
    } finally {
      h.restore()
    }
  })

  it('gives a friend-row JOIN no opportunity key', async () => {
    const h = harness()
    try {
      h.hub.noteActive()
      h.hub.recordJoin({
        channel: 'lirik',
        source: 'friend_row',
        socialCount: 1,
        navigated: true,
        alreadyOnTwitch: true,
        alreadyOnDestination: false,
      })
      await h.settle()

      // One person is not an opportunity several viewers can act on.
      expect(h.named('join_clicked')[0].properties.opportunity_key).toBeUndefined()
    } finally {
      h.restore()
    }
  })
})
