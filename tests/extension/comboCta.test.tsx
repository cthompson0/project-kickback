import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { SocialGravity } from '../../src/ui/components/SocialGravity'
import { StreamSession } from '../../src/ui/components/StreamSession'
import { ChannelNameProvider } from '../../src/ui/ChannelNames'
import { ACTIVITY_TTL_MS } from '../../src/core/together'
import type { TogetherReaction } from '../../src/core/together'
import type { RoomMessage } from '../../src/core/roomMessages'
import type { RoomMember } from '../../src/core/streamRoom'
import type { ChannelMetadata } from '../../src/core/twitchMetadata'
import type { Friend, KickbackClient } from '../../src/client/types'
import type { Activity, Presence } from '../../src/core/types'

/**
 * One doorway, and one signal.
 *
 * The contextual streamer tab is the ONLY way into a session: it exists while
 * the session does, owns the unread count, and is there whether or not
 * anything is happening.
 *
 * The card's combo is not a second doorway. It is a signal - several people
 * agreeing at once, for about eight seconds - and it says everything it needs
 * to by existing. Two earlier versions of this card disagreed: a permanent
 * ROOM button with its own unread badge, which announced one waiting message
 * twice in the same panel; and then a "Join Room →" invitation on the combo
 * itself, which in real use cost more attention than the signal it was
 * attached to. Both are asserted gone.
 */

const CHANNEL = 'lirik'

const friend = (id: string, name: string): Friend => ({
  user: { id, username: id, displayName: name, avatarUrl: null, accentColor: '#ff8452' },
  presence: {
    userId: id,
    status: 'online',
    activity: { type: 'watching', platform: 'twitch', channel: CHANNEL },
    since: Date.now() - 60_000,
    lastSeenAt: Date.now(),
  } as Presence,
})

const WATCHING: Activity = { type: 'watching', platform: 'twitch', channel: CHANNEL }
const JAKE = friend('jake', 'Jake')

const liveNow = (live: 'live' | 'offline' = 'live'): Record<string, ChannelMetadata> => ({
  [CHANNEL]: {
    login: CHANNEL,
    userId: null,
    displayName: 'LIRIK',
    profileImageUrl: null,
    live,
    gameName: null,
    title: null,
    viewerCount: 41_000,
    startedAt: null,
    fetchedAt: Date.now(),
  },
})

const emote = (senderId: string, at: number): TogetherReaction => ({
  id: `r-${senderId}-${at}`,
  senderId,
  channel: CHANNEL,
  reaction: 'lol',
  at,
  receivedAt: at,
})

const member = (userId: string): RoomMember => ({ userId, hops: 1, viaUserId: null })

const CLIENT = {
  sendReaction: () => {},
  sendRoomMessage: () => {},
  selectSession: () => {},
  setUserMuted: () => {},
} as unknown as KickbackClient

function card(
  reactions: TogetherReaction[] = [],
  messages: RoomMessage[] = [],
  live: 'live' | 'offline' = 'live',
) {
  return renderToStaticMarkup(
    <ChannelNameProvider people={[]} seen={{}}>
      <SocialGravity
        friends={[JAKE]}
        localActivity={WATCHING}
        client={CLIENT}
        cardContext={{
          selfId: 'me',
          viewerActivity: WATCHING,
          friendIds: new Set(['jake']),
          outgoingRequestIds: new Set(),
        }}
        metadata={liveNow(live)}
        reactions={reactions}
        roomMessages={messages}
        mutedUserIds={[]}
      />
    </ChannelNameProvider>,
  )
}

function session(members: RoomMember[], peers: string[], messages: RoomMessage[] = []) {
  return renderToStaticMarkup(
    <ChannelNameProvider people={[]} seen={{}}>
      <StreamSession
        channel={CHANNEL}
        members={members}
        friends={[JAKE]}
        reactions={[]}
        messages={messages}
        mutedUserIds={[]}
        peers={peers}
        selfId="me"
        client={CLIENT}
        cardContext={{
          selfId: 'me',
          viewerActivity: WATCHING,
          friendIds: new Set(['jake']),
          outgoingRequestIds: new Set(),
        }}
      />
    </ChannelNameProvider>,
  )
}

describe('A — a single emote stays in the conversation', () => {
  it('puts nothing at all on the card', () => {
    const at = Date.now()
    const html = card([emote('jake', at)])

    expect(html).not.toContain('kb-gravity-combo')
    expect(html).not.toContain('Join Room')
    expect(html).not.toContain('×1')
    expect(html).not.toContain('kb-together-open')
  })

  it('does not count one person twice into a combo', () => {
    const at = Date.now()
    const html = card([emote('jake', at), emote('jake', at + 100)])
    expect(html).not.toContain('Join Room')
  })
})

describe('B — a real combo shows the emote and the count, and nothing else', () => {
  it('draws exactly that', () => {
    const at = Date.now()
    const html = card([emote('jake', at), emote('me', at + 100)])

    expect(html).toContain('kb-gravity-combo')
    expect(html).toContain('×2')
    expect(html).not.toContain('Join Room')
    expect(html).not.toContain('ROOM')
  })

  it('sits on its own line under the status, never among the friends', () => {
    /*
     * Semantic ownership rather than pixels. The left half of the card is
     * identity and social information and must not move, so the combo lives in
     * the status column - and on its own line, because that row already
     * carries a category, a badge and a viewer count at the narrowest panel.
     */
    const at = Date.now()
    const html = card([emote('jake', at), emote('me', at + 100)])

    const rightColumn = html.slice(
      html.indexOf('kb-gravity-stream'),
      html.indexOf('kb-gravity-with-you'),
    )
    expect(rightColumn).toContain('kb-gravity-activity')
    expect(rightColumn).toContain('kb-gravity-combo')
    // Under the status, not inside it.
    expect(html.indexOf('kb-gravity-activity')).toBeGreaterThan(
      html.indexOf('kb-gravity-status'),
    )

    const people = html.slice(html.indexOf('kb-gravity-people'))
    expect(people).not.toContain('kb-gravity-combo')
  })

  it('is not a control, and does not become one', () => {
    /*
     * The correction. It briefly carried a "Join Room →" button; real use
     * showed the invitation was more visually expensive than the signal. The
     * combo alone already says something is happening, and the streamer tab is
     * always there.
     */
    const at = Date.now()
    const html = card([emote('jake', at), emote('me', at + 100)])

    expect(html).not.toMatch(/<button[^>]*class="kb-gravity-combo"/)
    expect(html).not.toMatch(/<a[^>]*class="kb-gravity-combo"/)
    expect(html).toMatch(/<span[^>]*class="kb-gravity-combo"/)
  })
})

describe('C — the count grows with the combo', () => {
  it('follows the canonical engine rather than counting again', () => {
    const at = Date.now()
    const two = card([emote('jake', at), emote('me', at + 100)])
    const three = card([emote('jake', at), emote('me', at + 100), emote('sara', at + 200)])

    expect(two).toContain('×2')
    expect(three).toContain('×3')
  })
})

describe('D — it leaves when the moment does', () => {
  it('disappears completely, emote and count together', () => {
    const stale = Date.now() - ACTIVITY_TTL_MS - 1_000
    const html = card([emote('jake', stale), emote('me', stale + 100)])

    expect(html).not.toContain('kb-gravity-combo')
    expect(html).not.toContain('Join Room')
    expect(html).not.toContain('×2')
    // And the card itself is untouched: the session still exists.
    expect(html).toContain('1 friend watching with you')
  })
})

describe('E — the card is not a way into anything', () => {
  it('offers no session control, of any kind', () => {
    const at = Date.now()
    const html = card([emote('jake', at), emote('me', at + 100)])

    expect(html).not.toContain('Join Room')
    expect(html).not.toContain('kb-together-open')
    expect(html).not.toContain('kb-gravity-cta')
  })

  it('does not ask the panel to open anything', () => {
    /*
     * The card stopped taking a callback at all, which is the strongest form
     * of "it cannot open a session": there is nothing to call.
     */
    const source = readFileSync('src/ui/components/SocialGravity.tsx', 'utf8')
    expect(source).not.toContain('onOpenRoom')
    expect(source).not.toContain('window.location')
    expect(source).not.toContain('channelUrl')
  })

  it('leaves the streamer tab as the only doorway', () => {
    const panel = readFileSync('src/ui/KickbackPanel.tsx', 'utf8')
    expect(panel).toContain('<SessionTab')
    expect(panel).toContain(`chooseTab('session')`)
  })

  it('keeps JOIN and the user card working elsewhere on the map', () => {
    // Nothing here touched the destination affordances the map has always had.
    const source = readFileSync('src/ui/components/SocialGravity.tsx', 'utf8')
    expect(source).toContain('JoinButton')
    expect(source).toContain('UserCard')
  })
})

describe('F — unread belongs to the tab', () => {
  it('never appears on the card', () => {
    const at = Date.now()
    const html = card([emote('jake', at), emote('me', at + 100)])
    expect(html).not.toContain('kb-together-unread')
    expect(html).not.toContain('kb-tab-badge')
  })

  it('is drawn by the tab, from the worker\'s own count', () => {
    const panel = readFileSync('src/ui/KickbackPanel.tsx', 'utf8')
    expect(panel).toContain('unread={view.roomUnread}')
    expect(panel).toContain('kb-tab-badge')
  })
})

describe('G — WATCHING TOGETHER counts everybody', () => {
  it('says 2 for the viewer and one other person', () => {
    // Gravity counts other people - "1 friend watching with you". The session
    // counts everybody in it, which is the number that includes you.
    expect(session([member('jake')], ['jake'])).toContain('WATCHING TOGETHER · 2')
  })

  it('counts a friend presence knows about before the server answers', () => {
    /*
     * The union, because either source can be ahead. A session can exist on
     * presence alone while the graph query is still in the air, and counting
     * only the server's answer showed "· 1" to somebody demonstrably not alone.
     */
    expect(session([], ['jake'])).toContain('WATCHING TOGETHER · 2')
  })

  it('counts somebody reached through a friend, whom presence cannot see', () => {
    expect(session([member('jake'), member('sara')], ['jake'])).toContain(
      'WATCHING TOGETHER · 3',
    )
  })
})

describe('H — offline changes the label, not the activity', () => {
  it('still shows the combo on a channel that has stopped streaming', () => {
    /*
     * A combo is social-session activity, not evidence of live viewing. The
     * shared-watch analytics lifecycle is what live status gates, and it is
     * nowhere near this card.
     */
    const at = Date.now()
    const html = card([emote('jake', at), emote('me', at + 100)], [], 'offline')

    expect(html).toContain('OFFLINE')
    expect(html).toContain('kb-gravity-combo')
    expect(html).not.toContain('Join Room')
    expect(html).not.toContain('kb-live-dot')
  })
})

describe('one combo state, two surfaces', () => {
  it('derives the card from roomActivity, never from its own scan', () => {
    const source = readFileSync('src/ui/components/SocialGravity.tsx', 'utf8')
    expect(source).toContain('roomActivity(')
    expect(source).toContain('COMBO_MIN_DISPLAY')
    expect(source).not.toContain('scanCombos')
    expect(source).not.toContain('activeCombo')
  })

  it('measures recency on the viewer\'s clock, not the server\'s', () => {
    /*
     * THE BUG THIS CHECKPOINT FIXED.
     *
     * `at` is the server's created_at and the window was eight seconds wide.
     * Two unsynchronised clocks a few seconds apart meant the window was
     * always empty - so the session's per-message badge still showed x2 while
     * every window-based surface silently showed nothing.
     */
    const stream = readFileSync('src/core/roomMessages.ts', 'utf8')
    expect(stream).toContain('now - entry.receivedAt < ACTIVITY_TTL_MS')
    expect(stream).not.toContain('now - entry.at < ACTIVITY_TTL_MS')

    const together = readFileSync('src/core/together.ts', 'utf8')
    expect(together).toContain('now - entry.receivedAt < ttl')
  })

  it('does not treat history as something that just happened', () => {
    // A refresh must not flash somebody else's old combo.
    const stream = readFileSync('src/core/roomMessages.ts', 'utf8')
    expect(stream).toContain('parseRoomMessage(row, 0)')
  })
})

describe('the card asks for nothing extra', () => {
  it('adds no request, timer or subscription of its own', () => {
    const source = readFileSync('src/ui/components/SocialGravity.tsx', 'utf8')
    expect(source).not.toContain('client.')
    expect(source).not.toContain('fetch(')
    // One interval, and only to age the combo out - the same clock the session
    // has, for the same reason.
    expect((source.match(/setInterval/g) ?? []).length).toBe(1)
  })
})
