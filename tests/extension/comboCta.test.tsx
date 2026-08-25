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
 * The two doorways, and why they are not redundant.
 *
 * The contextual streamer tab is the PERSISTENT way in: it exists while the
 * session does, owns the unread count, and is there whether or not anything is
 * happening. The card's combo is the EPHEMERAL one - something is going on
 * right now, jump into it - so it exists only while the combo does and carries
 * no unread of its own.
 *
 * The card used to also carry a permanent ROOM button with its own unread
 * badge, which announced one waiting message twice in the same panel.
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
  onOpenRoom: (channel: string) => void = () => {},
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
        onOpenRoom={onOpenRoom}
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

describe('B — a real combo offers the way in', () => {
  it('draws the emote, the count and the invitation', () => {
    const at = Date.now()
    const html = card([emote('jake', at), emote('me', at + 100)])

    expect(html).toContain('kb-gravity-combo')
    expect(html).toContain('×2')
    expect(html).toContain('Join Room')
  })

  it('puts them in the status region, never among the friends', () => {
    /*
     * Semantic ownership rather than pixels: the left half of the card is
     * identity and social information and must not move, so the combo lives
     * with the other ephemeral numbers on the right.
     */
    const at = Date.now()
    const html = card([emote('jake', at), emote('me', at + 100)])

    const status = html.slice(
      html.indexOf('kb-gravity-status'),
      html.indexOf('kb-gravity-with-you'),
    )
    expect(status).toContain('kb-gravity-combo')
    expect(status).toContain('Join Room')

    const people = html.slice(html.indexOf('kb-gravity-people'))
    expect(people).not.toContain('kb-gravity-combo')
    expect(people).not.toContain('Join Room')
  })

  it('is a real control, not a decorated label', () => {
    const at = Date.now()
    const html = card([emote('jake', at), emote('me', at + 100)])
    expect(html).toMatch(/<button[^>]*class="kb-gravity-combo"/)
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
  it('takes the whole CTA with it, not just the count', () => {
    const stale = Date.now() - ACTIVITY_TTL_MS - 1_000
    const html = card([emote('jake', stale), emote('me', stale + 100)])

    expect(html).not.toContain('kb-gravity-combo')
    expect(html).not.toContain('Join Room')
    expect(html).not.toContain('×2')
    // And the card itself is untouched: the session still exists.
    expect(html).toContain('1 friend watching with you')
  })
})

describe('E — Join Room selects the session that already exists', () => {
  it('asks the panel for the channel it is on, and nothing else', () => {
    /*
     * No Twitch navigation, no second room, no membership change - the panel
     * selects a tab. Asserted through the callback rather than by clicking,
     * because what matters is what it asks for.
     */
    const at = Date.now()
    const asked: string[] = []
    card([emote('jake', at), emote('me', at + 100)], [], 'live', (channel) => asked.push(channel))

    // Rendering asks for nothing; the callback is only invoked on click.
    expect(asked).toEqual([])

    const source = readFileSync('src/ui/components/SocialGravity.tsx', 'utf8')
    const cta = source.slice(source.indexOf('className="kb-gravity-combo"'))
    expect(cta.slice(0, 400)).toContain('onOpenRoom(section.channel!)')
    expect(source).not.toContain('window.location')
    expect(source).not.toContain('channelUrl')
  })

  it('is wired to the same tab selection the streamer tab uses', () => {
    const panel = readFileSync('src/ui/KickbackPanel.tsx', 'utf8')
    expect(panel).toContain(`onOpenRoom={() => chooseTab('session')}`)
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
  it('still offers the combo CTA on a channel that has stopped streaming', () => {
    /*
     * A combo is social-session activity, not evidence of live viewing. The
     * shared-watch analytics lifecycle is what live status gates, and it is
     * nowhere near this card.
     */
    const at = Date.now()
    const html = card([emote('jake', at), emote('me', at + 100)], [], 'offline')

    expect(html).toContain('OFFLINE')
    expect(html).toContain('kb-gravity-combo')
    expect(html).toContain('Join Room')
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
