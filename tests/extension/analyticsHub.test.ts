import { describe, expect, it } from 'vitest'
import { createAnalyticsHub } from '../../src/background/analyticsHub'
import type { AnalyticsEvent } from '../../src/core/analytics'

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

  const hub = createAnalyticsHub({
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
    canSend: () => signedIn,
    now: () => clock,
  })

  // Deterministic ids, so the funnel can be asserted rather than eyeballed.
  const originalUuid = crypto.randomUUID
  crypto.randomUUID = (() => `00000000-0000-4000-8000-${String(++ids).padStart(12, '0')}`) as never

  return {
    hub,
    sent,
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
    /** Lets the hub's internal promise chain drain, then sends. */
    settle: async () => {
      for (let index = 0; index < 20; index += 1) await Promise.resolve()
      await hub.flush()
      for (let index = 0; index < 20; index += 1) await Promise.resolve()
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
