import { readFileSync } from 'node:fs'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createStreamRoom } from '../../src/background/streamRoom'
import type { RoomMember } from '../../src/core/streamRoom'
import { comboStream, roomActivity } from '../../src/core/roomMessages'
import type { RoomMessage } from '../../src/core/roomMessages'
import { scanCombos } from '../../src/core/combos'
import { parseMessage, soleEmote } from '../../src/core/emotes'

/**
 * Arrival, departure, and the emote that was not an emote.
 *
 * Three findings from two-account testing, and two of them turned out to be
 * one bug:
 *
 *   * the person ALREADY watching did not get the session tab when a friend
 *     joined - only the person who navigated did, and only a Twitch refresh
 *     fixed it;
 *   * when that friend left, the tab lingered for most of a minute;
 *   * an emote chosen from the picker arrived in the room as plain text and
 *     contributed nothing to a combo.
 *
 * The first two are the same swallowed invalidation; see `ask()` in
 * background/streamRoom.ts. The third is one missing call.
 */

const CHANNEL = 'lirik'
const NOW = 1_700_000_000_000

const member = (userId: string): RoomMember => ({ userId, hops: 1, viaUserId: null })

const message = (over: Partial<RoomMessage> = {}): RoomMessage => ({
  id: `m-${over.senderId ?? 'jake'}-${over.at ?? NOW}`,
  senderId: 'jake',
  channel: CHANNEL,
  body: ':lol:',
  at: NOW,
  ...over,
})

/**
 * A room service over a server whose answer we control, one request at a time.
 *
 * `answer` is what the server currently believes; `settle` releases the
 * request that is in the air. Holding a request open is the whole point -
 * every one of these bugs happens in the window while one is unanswered.
 */
function harness() {
  let answer: RoomMember[] = []
  let pending: Array<() => void> = []
  let calls = 0
  const changes: RoomMember[][] = []

  const room = createStreamRoom({
    backend: {
      async members() {
        calls += 1
        const at = answer
        await new Promise<void>((resolve) => pending.push(resolve))
        return at.map((m) => ({ user_id: m.userId, hops: m.hops, via_user_id: m.viaUserId }))
      },
    },
    onChange: () => changes.push(room.snapshot()),
    now: () => Date.now(),
  })

  return {
    room,
    calls: () => calls,
    changes: () => changes,
    setAnswer(next: RoomMember[]) {
      answer = next
    },
    /** Let every request currently in the air return. */
    async settle() {
      const waiting = pending
      pending = []
      for (const resolve of waiting) resolve()
      await vi.advanceTimersByTimeAsync(0)
    },
  }
}

describe('a friend arriving while the viewer is already watching', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(NOW)
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('converges without a refresh, a timer, or another heartbeat', async () => {
    /*
     * THE BUG, end to end.
     *
     * Joining produces two presence events in quick succession - the friend
     * goes idle as their old tab closes, then appears on this channel. The
     * first invalidates and asks; the second arrives while that request is
     * still in the air.
     *
     * The request then lands with the answer from BEFORE the arrival. It used
     * to stamp that as fresh, and the room stayed empty for the full refresh
     * interval - which is why the person already watching saw "1 friend
     * watching with you" and no session tab.
     */
    const h = harness()

    // Alone, and resolved as such.
    h.room.want(CHANNEL)
    await h.settle()
    expect(h.room.snapshot()).toEqual([])

    // First event: something changed. Ask.
    h.room.invalidate()
    h.room.want(CHANNEL)
    const callsAfterFirst = h.calls()

    // Second event, while that request is unanswered. The friend is now here.
    h.room.invalidate()
    h.room.want(CHANNEL)
    h.setAnswer([member('friend')])

    // The first request answers with the pre-arrival room.
    await h.settle()
    // ...and, because it was invalidated in flight, asks again by itself.
    expect(h.calls()).toBeGreaterThan(callsAfterFirst)

    await h.settle()
    expect(h.room.snapshot()).toEqual([member('friend')])
  })

  it('tells the panel, so the tab can appear', async () => {
    // roomMembers reaching state is what sessionAvailable is derived from;
    // converging without announcing it would look identical to not converging.
    const h = harness()
    h.room.want(CHANNEL)
    await h.settle()

    h.room.invalidate()
    h.room.want(CHANNEL)
    h.room.invalidate()
    h.room.want(CHANNEL)
    h.setAnswer([member('friend')])
    await h.settle()
    await h.settle()

    expect(h.changes().at(-1)).toEqual([member('friend')])
  })

  it('converges on the simple case too, with one request', async () => {
    const h = harness()
    h.room.want(CHANNEL)
    await h.settle()

    h.setAnswer([member('friend')])
    h.room.invalidate()
    h.room.want(CHANNEL)
    await h.settle()

    expect(h.room.snapshot()).toEqual([member('friend')])
    expect(h.calls()).toBe(2)
  })
})

describe('a friend leaving', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(NOW)
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('empties the room promptly rather than at the refresh interval', async () => {
    /*
     * The same shape as arrival: navigating away is also two presence events -
     * off this channel, then onto the next one - so the departure was swallowed
     * exactly as the arrival was. It took most of a minute to show, which is
     * what "wait for the cache to expire" looks like.
     */
    const h = harness()
    h.setAnswer([member('friend')])
    h.room.want(CHANNEL)
    await h.settle()
    expect(h.room.snapshot()).toEqual([member('friend')])

    h.room.invalidate()
    h.room.want(CHANNEL)

    h.room.invalidate()
    h.room.want(CHANNEL)
    h.setAnswer([])

    await h.settle()
    await h.settle()

    expect(h.room.snapshot()).toEqual([])
  })

  it('does not wait for the refresh interval to notice', async () => {
    const h = harness()
    h.setAnswer([member('friend')])
    h.room.want(CHANNEL)
    await h.settle()

    h.setAnswer([])
    h.room.invalidate()
    h.room.want(CHANNEL)
    await h.settle()

    // No clock was advanced at all.
    expect(h.room.snapshot()).toEqual([])
  })
})

describe('what must NOT cause a request', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(NOW)
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('asks nothing on a heartbeat that changed nothing', async () => {
    /*
     * The reason invalidation is a separate call from `want`. A presence
     * heartbeat arrives every forty-five seconds per friend and changes
     * nothing about who is here; a query per beat per friend would be a
     * polling loop with extra steps.
     */
    const h = harness()
    h.room.want(CHANNEL)
    await h.settle()
    expect(h.calls()).toBe(1)

    for (let beat = 0; beat < 10; beat += 1) {
      h.room.want(CHANNEL)
      await h.settle()
    }
    expect(h.calls()).toBe(1)
  })

  it('asks once for a burst of invalidations, not once each', async () => {
    // Several events in the same instant are one change to converge on.
    const h = harness()
    h.room.want(CHANNEL)
    await h.settle()

    for (let i = 0; i < 5; i += 1) {
      h.room.invalidate()
      h.room.want(CHANNEL)
    }
    expect(h.calls()).toBe(2)
  })

  it('still ignores an answer for a channel the viewer has left', async () => {
    // The generation guard, unchanged by any of this: a slow answer for the
    // previous channel must not land on the new one.
    const h = harness()
    h.setAnswer([member('friend')])
    h.room.want(CHANNEL)

    h.setAnswer([])
    h.room.want('xqc')
    await h.settle()
    await h.settle()

    expect(h.room.channel()).toBe('xqc')
    expect(h.room.snapshot()).toEqual([])
  })
})

describe('the worker converges on the same events that redraw HERE', () => {
  const WORKER = readFileSync('src/background/index.ts', 'utf8')

  it('invalidates and re-asks when the co-present set changes', () => {
    expect(WORKER).toContain('const key = coPresenceKey(here)')
    expect(WORKER).toContain('if (key !== coPresence) {')
    expect(WORKER).toContain('room.invalidate()')
    expect(WORKER).toContain('room.want(here)')
  })

  it('does that from the presence path, which is what draws HERE', () => {
    const index = WORKER.slice(WORKER.indexOf('function indexPresence('))
    expect(index.slice(0, 1_800)).toContain('room.invalidate()')
  })

  it('adds no polling loop of its own', () => {
    expect(WORKER).not.toContain('setInterval')
  })
})

// ------------------------------------------------------------- the emote

describe('an emote chosen from the picker', () => {
  it('is stored as a token, not as the word the composer showed', () => {
    /*
     * THE THIRD BUG, and it was one missing call.
     *
     * The picker inserts a Kickback emote as its token but an EXTERNAL emote
     * as its bare name, so the composer reads the way Twitch chat does. Group
     * chat rewrites that to a stable token on the way out; the room did not,
     * so it stored the word. The word rendered as text, soleEmote() did not
     * recognise it, and it therefore contributed nothing to a combo - which is
     * also why the activity preview outside never lit up.
     */
    const WORKER = readFileSync('src/background/index.ts', 'utf8')
    const handler = WORKER.slice(WORKER.indexOf(`case 'roomMessage'`))
    expect(handler.slice(0, 1_200)).toContain('emoteCatalog.resolveOutgoing(typed)')

    // And the group path still does it, through the same call.
    expect(WORKER).toContain('const resolved = emoteCatalog.resolveOutgoing(String(body))')
  })

  it('renders as artwork rather than as its token', () => {
    const segments = parseMessage(':lol:')
    expect(segments).toHaveLength(1)
    expect(segments[0].type).toBe('emote')
  })

  it('qualifies as an emote-only message', () => {
    expect(soleEmote(':lol:')?.id).toBe('lol')
    expect(soleEmote('haha :lol:')).toBeNull()
  })
})

describe('one combo stream', () => {
  it('counts two people sending the same emote as a message', () => {
    const activity = roomActivity(
      [],
      [
        message({ id: 'a', senderId: 'jake', body: ':lol:', at: NOW }),
        message({ id: 'b', senderId: 'matt', body: ':lol:', at: NOW + 100 }),
      ],
      CHANNEL,
      (id) => id,
      NOW + 200,
    )
    expect(activity?.count).toBe(2)
    expect(activity?.emote.id).toBe('lol')
  })

  it('counts a reaction and an emote message as the same run', () => {
    const activity = roomActivity(
      [{ id: 'r', senderId: 'jake', channel: CHANNEL, reaction: 'lol', at: NOW }],
      [message({ id: 'm', senderId: 'matt', body: ':lol:', at: NOW + 100 })],
      CHANNEL,
      (id) => id,
      NOW + 200,
    )
    expect(activity?.count).toBe(2)
  })

  it('does not count ordinary text, and lets it break a run', () => {
    const { annotations } = scanCombos(
      comboStream(
        [],
        [
          message({ id: 'a', senderId: 'jake', body: ':lol:', at: NOW }),
          message({ id: 'b', senderId: 'matt', body: ':lol:', at: NOW + 10 }),
          message({ id: 'c', senderId: 'sara', body: ':lol:', at: NOW + 20 }),
          message({ id: 'd', senderId: 'jake', body: 'ok enough', at: NOW + 30 }),
        ],
        (id) => id,
      ),
    )
    expect(annotations.get('d')?.brokeCombo?.count).toBe(3)

    const activity = roomActivity(
      [],
      [
        message({ id: 'a', senderId: 'jake', body: ':lol:', at: NOW }),
        message({ id: 'd', senderId: 'matt', body: 'ok enough', at: NOW + 30 }),
      ],
      CHANNEL,
      (id) => id,
      NOW + 40,
    )
    expect(activity).toBeNull()
  })
})

describe('the session and the card agree about now', () => {
  const SESSION = readFileSync('src/ui/components/StreamSession.tsx', 'utf8')

  it('drives the combo bar from the activity window, not the whole log', () => {
    /*
     * Once a room keeps half an hour of conversation, the trailing run of the
     * LOG and the run of the last few seconds stop being the same thing. The
     * session showed a combo of four while the card outside showed two -
     * same engine, two clocks. Both read roomActivity now.
     */
    expect(SESSION).toContain('const active = activity && activity.count >= COMBO_MIN_DISPLAY')
    expect(SESSION).not.toContain('const { annotations, active }')
  })

  it('keeps the per-message badges on the full log, where they belong', () => {
    // A count beside an old message is history, and history does not expire
    // from the log just because the moment has passed.
    expect(SESSION).toContain('const { annotations } = useMemo(')
    expect(SESSION).toContain('annotations={annotations}')
  })

  it('ticks while there is anything to age, not only reactions', () => {
    /*
     * Once an emote from the picker became a MESSAGE rather than a reaction, a
     * room with a live combo and no reactions had nothing driving the clock -
     * so the preview formed and then never went away.
     *
     * The card's own clock lives in SocialGravity now, because that is where
     * the combo moved: onto the status line beside LIVE.
     */
    const CARD = readFileSync('src/ui/components/SocialGravity.tsx', 'utf8')
    for (const source of [SESSION, CARD]) {
      expect(source).toContain('const pulses =')
      expect(source).not.toContain('if (reactions.length === 0) return')
    }
  })
})

describe('a session outlives the broadcast', () => {
  const WORKER = readFileSync('src/background/index.ts', 'utf8')
  const PANEL = readFileSync('src/ui/KickbackPanel.tsx', 'utf8')

  it('makes availability presence, never live status', () => {
    /*
     * The rule that was right once and then wrong. Requiring a broadcast
     * before people could talk meant a stream ending ended the conversation
     * around it - and made every session hostage to a metadata refresh, which
     * is how a card could say "1 friend watching with you" and offer nowhere
     * to go.
     */
    const session = WORKER.slice(WORKER.indexOf('function sessionChannel()'))
    const body = session.slice(0, session.indexOf('\n}'))
    expect(body).not.toContain('canWatchLiveTogether')
    expect(body).not.toContain('metadata')
  })

  it('keeps live status for the label and the lifecycle only', () => {
    expect(WORKER).toContain('const channel = liveWatchChannel()')
    // The panel derives the tab from people, not from a broadcast.
    expect(PANEL).toContain('view.roomPeers.length > 0 || view.roomMembers.length > 0')
    expect(PANEL).not.toContain('canWatchLiveTogether')
  })

  it('does not wait for the server to rediscover a direct friend', () => {
    /*
     * Presence already proves a friend is here - it is the same evidence the
     * HERE card counts. The server stays authoritative for who is REACHED,
     * which is what actually needs authorizing.
     */
    expect(WORKER).toContain('function sessionPeers()')
    expect(WORKER).toContain('roomPeers: sessionPeers()')
    // And the client still invents no membership of its own.
    expect(WORKER).toContain('room.want(here)')
  })
})

describe('the quick-reaction strip is gone', () => {
  const SESSION = readFileSync('src/ui/components/StreamSession.tsx', 'utf8')
  const CSS = readFileSync('src/ui/kickback.css', 'utf8')

  it('renders no permanent row of five reaction buttons', () => {
    expect(SESSION).not.toContain('kb-session-react')
    expect(SESSION).not.toContain('REACTIONS.map')
    expect(CSS).not.toContain('.kb-session-react')
  })

  it('keeps the emote picker on the composer, which is the one way to send', () => {
    const COMPOSER = readFileSync('src/ui/components/Conversation.tsx', 'utf8')
    expect(COMPOSER).toContain('EmotePicker')
    expect(SESSION).toContain('<Composer')
  })

  it('keeps no lone emote above the composer either', () => {
    /*
     * An emote you sent appeared twice - once as your message, and again on
     * its own above the input. A single emote is a thing one person did and
     * the conversation already shows it; only a real combo earns a second
     * representation, and that is the bar above the composer.
     */
    expect(SESSION).not.toContain('kb-session-pulse')
    expect(SESSION).toContain('ActiveComboBar')
    expect(CSS).not.toContain('.kb-session-react')
  })
})
