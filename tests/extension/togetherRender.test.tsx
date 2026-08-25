import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { SocialGravity } from '../../src/ui/components/SocialGravity'
import { StreamSession } from '../../src/ui/components/StreamSession'
import { ChannelNameProvider } from '../../src/ui/ChannelNames'
import { ACTIVITY_TTL_MS } from '../../src/core/together'
import type { TogetherReaction } from '../../src/core/together'
import { MAX_MESSAGE_LENGTH } from '../../src/core/roomMessages'
import type { RoomMessage } from '../../src/core/roomMessages'
import type { RoomMember } from '../../src/core/streamRoom'
import type { Friend, KickbackClient } from '../../src/client/types'
import type { Activity, Presence } from '../../src/core/types'

/**
 * The card outside the session, and the session itself.
 *
 * WHAT THIS FILE HAS BEEN REWRITTEN FOR, TWICE
 *
 * First the Gravity card carried five reaction buttons and a roster, and the
 * room was a disclosure triangle. Then the room became a view that REPLACED
 * the Friends map - which fixed the triangle and cost the social radar, and
 * left a room containing a list of names and nothing to do.
 *
 * Now the session is a tab beside Friends, and the reason it exists is the
 * conversation in it. The card outside carries what a card outside should: the
 * fact that something is happening, whether anything is waiting, and the way
 * in. These tests assert that split, and in particular assert the ABSENCE of
 * both older shapes, because either is what a well-meaning change would
 * reintroduce.
 */

const NOW = 1_700_000_000_000
const CSS = readFileSync('src/ui/kickback.css', 'utf8')

const friend = (id: string, name: string, channel: string): Friend => ({
  user: { id, username: id, displayName: name, avatarUrl: null, accentColor: '#ff8452' },
  presence: {
    userId: id,
    status: 'online',
    activity: { type: 'watching', platform: 'twitch', channel },
    since: NOW - 60_000,
    lastSeenAt: Date.now(),
  } as Presence,
})

const reaction = (over: Partial<TogetherReaction> = {}): TogetherReaction => ({
  id: `r-${over.senderId ?? 'jake'}-${over.at ?? Date.now()}`,
  senderId: 'jake',
  channel: 'lirik',
  reaction: 'lol',
  at: Date.now(),
  receivedAt: over.at ?? Date.now(),
  ...over,
})

const message = (over: Partial<RoomMessage> = {}): RoomMessage => ({
  id: `m-${over.senderId ?? 'jake'}-${over.at ?? Date.now()}`,
  senderId: 'jake',
  channel: 'lirik',
  body: 'holy shit',
  at: Date.now(),
  receivedAt: over.at ?? Date.now(),
  ...over,
})

const member = (userId: string, hops = 1, viaUserId: string | null = null): RoomMember => ({
  userId,
  hops,
  viaUserId,
})

const ON = (channel: string): Activity => ({ type: 'watching', platform: 'twitch', channel })
const IDLE: Activity = { type: 'idle' }

const CLIENT = {
  sendReaction: () => {},
  sendRoomMessage: () => {},
  selectSession: () => {},
  setUserMuted: () => {},
} as unknown as KickbackClient

/**
 * The map, as the Friends tab draws it.
 *
 * No membership and no unread: the card depends on neither any more. What is
 * in the room decides the contextual TAB, which these cases do not render, and
 * unread is drawn by that tab.
 */
function render(
  friends: Friend[],
  local: Activity,
  reactions: TogetherReaction[] = [],
  messages: RoomMessage[] = [],
) {
  return renderToStaticMarkup(
    <ChannelNameProvider people={[]} seen={{}}>
      <SocialGravity
        friends={friends}
        localActivity={local}
        client={CLIENT}
        cardContext={{
          selfId: 'me',
          viewerActivity: local,
          friendIds: new Set(friends.map((f) => f.user.id)),
          outgoingRequestIds: new Set(),
        }}
        reactions={reactions}
        roomMessages={messages}
        mutedUserIds={[]}
        onOpenRoom={() => {}}
      />
    </ChannelNameProvider>,
  )
}

/** The session, as the panel draws it once the tab is selected. */
function renderSession(
  friends: Friend[],
  roomMembers: RoomMember[],
  messages: RoomMessage[] = [],
  reactions: TogetherReaction[] = [],
  mutedUserIds: string[] = [],
) {
  return renderToStaticMarkup(
    <ChannelNameProvider people={[]} seen={{}}>
      <StreamSession
        channel="lirik"
        members={roomMembers}
        friends={friends}
        reactions={reactions}
        messages={messages}
        mutedUserIds={mutedUserIds}
        peers={roomMembers.map((member) => member.userId)}
        selfId="me"
        client={CLIENT}
        cardContext={{
          selfId: 'me',
          viewerActivity: ON('lirik'),
          friendIds: new Set(friends.map((f) => f.user.id)),
          outgoingRequestIds: new Set(),
        }}
      />
    </ChannelNameProvider>,
  )
}

const TWO_ON_LIRIK = [friend('jake', 'Jake', 'lirik'), friend('matt', 'Matt', 'lirik')]

describe('the card outside the session', () => {
  it('offers a JOIN and no doorway before the viewer arrives', () => {
    const html = render(TWO_ON_LIRIK, IDLE)
    expect(html).toContain('kb-join')
    expect(html).not.toContain('kb-together')
  })

  it('carries no permanent way into the session', () => {
    /*
     * The ROOM button is gone. It was a second, always-present doorway beside
     * the contextual streamer tab, and it carried a duplicate unread badge -
     * so one waiting message was announced twice in the same panel.
     */
    const html = render(TWO_ON_LIRIK, ON('lirik'))

    expect((html.match(/class="kb-gravity-card/g) ?? []).length).toBe(1)
    expect(html).toContain('kb-gravity-card-here')
    expect(html).toContain('2 friends watching with you')
    expect(html).not.toContain('kb-together-open')
    expect(html).not.toContain('ROOM')
    expect(html).not.toContain('kb-together-unread')
    expect(html).not.toContain('kb-join')
  })

  it('has no reaction buttons and no composer on it', () => {
    /*
     * The first correction, still asserted: five permanent controls in the
     * middle of the social map made it a thing to operate rather than a thing
     * to read. Everything you can DO is inside.
     */
    const html = render(TWO_ON_LIRIK, ON('lirik'))
    expect(html).not.toContain('kb-together-react')
    expect(html).not.toContain('kb-session-react')
    expect(html).not.toContain('kb-composer')
  })

  it('does not list the people in the room', () => {
    const html = render(TWO_ON_LIRIK, ON('lirik'))
    expect(html).not.toContain('kb-room-person')
    expect(html).not.toContain('Friend of')
  })

  it('offers no doorway when the server found no room', () => {
    /*
     * The condition is the SERVER's membership, not the HERE count. Presence
     * still draws the card and still says who is here; it just does not
     * manufacture a door to somewhere that does not exist.
     */
    const html = render(TWO_ON_LIRIK, ON('lirik'))
    expect(html).toContain('2 friends watching with you')
    expect(html).not.toContain('kb-together-open')
  })

  it('does not appear on a destination the viewer is not on', () => {
    const html = render(TWO_ON_LIRIK, ON('xqc'))
    expect(html).toContain('kb-join')
    expect(html).not.toContain('kb-together')
  })
})

describe('the activity preview', () => {
  it('shows NOTHING for a single emote', () => {
    /*
     * Combos only, and this is the correction.
     *
     * One person sending an emote is a thing that belongs in the conversation;
     * the card outside is for noticing that several people are agreeing at
     * once. The threshold is the combo engine's own - there is no second
     * opinion here about what counts.
     */
    const html = render(TWO_ON_LIRIK, ON('lirik'), [reaction({ senderId: 'jake' })])
    expect(html).not.toContain('kb-gravity-combo')
    expect(html).not.toContain('kb-together-count')
  })

  it('counts two different people in place, as one badge', () => {
    const now = Date.now()
    const html = render(
      TWO_ON_LIRIK,
      ON('lirik'),
      [reaction({ senderId: 'jake', at: now }), reaction({ senderId: 'matt', at: now + 200 })],
    )
    expect((html.match(/kb-gravity-combo/g) ?? []).length).toBe(1)
    expect(html).toContain('×2')
    // A combo means something is happening; the useful thing to offer beside
    // it is a way to join it.
    expect(html).toContain('Join Room')
  })

  it('counts an emote-only message alongside a reaction', () => {
    /*
     * ONE combo stream. A reaction is an emote and an emote-only message is
     * the same emote sent the slow way, so they collide on the same run - and
     * the card outside has to agree with the session about the number.
     */
    const now = Date.now()
    const html = render(
      TWO_ON_LIRIK,
      ON('lirik'),
      [reaction({ senderId: 'jake', reaction: 'lol', at: now })],
      [message({ senderId: 'matt', body: ':lol:', at: now + 100 })],
    )
    expect(html).toContain('×2')
  })

  it('never leaks text, however loud the conversation', () => {
    const now = Date.now()
    const html = render(
      TWO_ON_LIRIK,
      ON('lirik'),
      [],
      [message({ senderId: 'jake', body: 'a secret only the room should see', at: now })],
    )
    expect(html).not.toContain('secret')
    expect(html).not.toContain('kb-msg')
  })

  it('shows nothing at all when the trailing entry is text', () => {
    // Text does not contribute to a combo; it CLOSES one. So a sentence
    // arriving means nothing is currently happening worth a symbol.
    const now = Date.now()
    const html = render(
      TWO_ON_LIRIK,
      ON('lirik'),
      [reaction({ senderId: 'jake', at: now })],
      [message({ senderId: 'matt', body: 'what happened', at: now + 100 })],
    )
    expect(html).not.toContain('kb-together-burst')
  })

  it('does not count one person pressing the same button', () => {
    const now = Date.now()
    const html = render(
      TWO_ON_LIRIK,
      ON('lirik'),
      [
        reaction({ senderId: 'jake', at: now }),
        reaction({ senderId: 'jake', at: now + 100 }),
        reaction({ senderId: 'jake', at: now + 200 }),
      ],
    )
    expect(html).not.toContain('kb-together-count')
  })

  it('vanishes completely once the activity has aged out', () => {
    /*
     * Ephemeral means gone. No timestamp, no "recently", no last-known combo
     * kept to stop the row changing height - the row holds its own height.
     */
    const html = render(
      TWO_ON_LIRIK,
      ON('lirik'),
      [
        reaction({ senderId: 'jake', at: Date.now() - ACTIVITY_TTL_MS - 1 }),
        reaction({ senderId: 'matt', at: Date.now() - ACTIVITY_TTL_MS - 1 }),
      ],
    )
    expect(html).not.toContain('kb-gravity-combo')
    expect(html).not.toContain('Join Room')
    expect(html).not.toContain('×2')
  })

  it('ignores a reaction from another channel', () => {
    const html = render(TWO_ON_LIRIK, ON('lirik'), [reaction({ channel: 'xqc' })])
    expect(html).not.toContain('kb-together-burst')
  })

  it('never says who reacted', () => {
    const now = Date.now()
    const html = render(
      [friend('jake', 'Jake', 'lirik')],
      ON('lirik'),
      [reaction({ senderId: 'jake', at: now }), reaction({ senderId: 'sarah', at: now + 100 })],
    )
    const preview = html.slice(html.indexOf('kb-together'))
    expect(preview).toContain('×2')
    expect(preview).not.toContain('Sarah')
    expect(preview).not.toMatch(/reacting|reacted|just now|ago/i)
  })
})

describe('unread belongs to the tab, not the card', () => {
  it('never draws a count on the card, however much is waiting', () => {
    /*
     * One waiting message, one badge. It used to be announced twice: on the
     * contextual streamer tab AND on a ROOM button beside it.
     *
     * The two are different facts and only one of them is content: unread is
     * something waiting for you, and the card's combo is something happening
     * right now. Keeping them on separate surfaces is what keeps them legible.
     */
    const html = render(TWO_ON_LIRIK, ON('lirik'))
    expect(html).not.toContain('kb-together-unread')
    expect(html).not.toContain('>7<')
  })
})

describe('inside the session', () => {
  it('leads with the destination and who is here', () => {
    const html = renderSession(TWO_ON_LIRIK, [member('jake'), member('matt')])
    expect(html).toContain('kb-session-head')
    expect(html).toContain('WATCHING TOGETHER')
    expect(html).toContain('3')
  })

  it('has no back button, because the tabs are the way out', () => {
    const html = renderSession(TWO_ON_LIRIK, [member('jake')])
    expect(html).not.toContain('kb-back')
  })

  it('keeps the people compact until asked', () => {
    /*
     * The second correction. The room used to spend a third of the panel on a
     * list answering a question you ask once; the conversation is what people
     * came for.
     */
    const html = renderSession(TWO_ON_LIRIK, [member('jake'), member('matt')])
    expect(html).toContain('kb-avatar-stack')
    expect(html).toContain('aria-expanded="false"')
    expect(html).not.toContain('kb-room-person')
  })

  it('is where the conversation is', () => {
    const html = renderSession(
      TWO_ON_LIRIK,
      [member('jake')],
      [message({ senderId: 'jake', body: 'holy shit' })],
    )
    expect(html).toContain('kb-chat-log')
    expect(html).toContain('holy shit')
    expect(html).toContain('Jake')
    expect(html).toContain('kb-composer')
  })

  it('caps the composer at the room limit, not the group one', () => {
    const html = renderSession(TWO_ON_LIRIK, [member('jake')])
    expect(html).toContain(`maxLength="${MAX_MESSAGE_LENGTH}"`)
    expect(html).not.toContain('maxLength="500"')
  })

  it('has one way to send an emote, and it is the picker', () => {
    /*
     * There used to be a permanent row of five reaction buttons above the
     * input, stacked on top of the emote picker attached to the composer. Two
     * emoji surfaces, and the strip was the weaker one: five emotes where the
     * picker offers every emote the channel has, costing a row of height that
     * belongs to the conversation.
     */
    const html = renderSession(TWO_ON_LIRIK, [member('jake')])
    expect(html).not.toContain('kb-session-react')
    expect(html).toContain('kb-emote-toggle')
    expect(html).toContain('kb-composer')
    for (const forbidden of ['😂', '❤️', '🔥', '😭', '👀']) {
      expect(html).not.toContain(forbidden)
    }
  })

  it('renders a message as text, never as markup', () => {
    const html = renderSession(
      TWO_ON_LIRIK,
      [member('jake')],
      [message({ senderId: 'jake', body: '<img src=x onerror=alert(1)>' })],
    )
    expect(html).not.toContain('<img src=x')
    expect(html).toContain('&lt;img')
  })

  it('shows the same combo the card outside was showing', () => {
    const now = Date.now()
    const reactions = [
      reaction({ senderId: 'jake', at: now }),
      reaction({ senderId: 'matt', at: now + 200 }),
    ]
    const outside = render(TWO_ON_LIRIK, ON('lirik'), reactions)
    const inside = renderSession(TWO_ON_LIRIK, [member('jake'), member('matt')], [], reactions)

    expect(outside).toContain('×2')
    expect(inside).toContain('×2')
  })

  it('lets an ordinary message break a combo', () => {
    /*
     * The rule scanCombos has always had and that a room has never been able
     * to fire, because a room had no text in it. It does now, unchanged and
     * unduplicated.
     */
    const now = Date.now()
    const html = renderSession(
      [friend('jake', 'Jake', 'lirik'), friend('matt', 'Matt', 'lirik'), friend('sara', 'Sara', 'lirik')],
      [member('jake'), member('matt'), member('sara')],
      [
        message({ id: 'a', senderId: 'jake', body: ':lol:', at: now }),
        message({ id: 'b', senderId: 'matt', body: ':lol:', at: now + 10 }),
        message({ id: 'c', senderId: 'sara', body: ':lol:', at: now + 20 }),
        message({ id: 'd', senderId: 'jake', body: 'ok that is enough', at: now + 30 }),
      ],
    )
    expect(html).toContain('COMBO BROKEN BY')
  })

  it('hides a muted person entirely, including from the count', () => {
    /*
     * Filtered before the combo engine rather than after it, which is what
     * makes their contribution disappear from the NUMBER rather than just
     * from the list.
     */
    const now = Date.now()
    const heard = renderSession(
      TWO_ON_LIRIK,
      [member('jake'), member('matt')],
      [
        message({ id: 'a', senderId: 'jake', body: ':lol:', at: now }),
        message({ id: 'b', senderId: 'matt', body: ':lol:', at: now + 10 }),
      ],
    )
    expect(heard).toContain('×2')

    const muted = renderSession(
      TWO_ON_LIRIK,
      [member('jake'), member('matt')],
      [
        message({ id: 'a', senderId: 'jake', body: ':lol:', at: now }),
        message({ id: 'b', senderId: 'matt', body: 'this is noise', at: now + 10 }),
      ],
      [],
      ['matt'],
    )
    expect(muted).not.toContain('this is noise')
  })

  it('names somebody two hops away through the friend who connects them', () => {
    const html = renderSession([friend('jake', 'Jake', 'lirik')], [
      member('jake'),
      member('sarah', 2, 'jake'),
    ])
    // Compact by default, so the context lives behind the roster toggle - but
    // the count still includes them, because they are in the room.
    expect(html).toContain('WATCHING TOGETHER · 3')
    expect(html).toContain('kb-room-unknown')
  })

  it('has no ceremony', () => {
    const html = renderSession(TWO_ON_LIRIK, [member('jake')])
    for (const forbidden of ['Create', 'Invite', 'Leave room', 'Room name', 'Join room']) {
      expect(html).not.toContain(forbidden)
    }
  })
})

describe('the surfaces stay small', () => {
  const rule = (selector: string) => {
    const at = CSS.indexOf(`${selector} {`)
    if (at < 0) throw new Error(`no rule for ${selector}`)
    return CSS.slice(at, CSS.indexOf('}', at))
  }

  it('is one row that cannot change height when a reaction lands', () => {
    expect(rule('.kb-together')).toContain('min-height')
    expect(rule('.kb-together-live')).toContain('overflow: hidden')
    expect(rule('.kb-together-live')).not.toContain('flex-wrap: wrap')
  })

  it('keeps the doorway fixed and lets the preview shrink', () => {
    expect(rule('.kb-together-open')).toContain('flex: none')
    expect(rule('.kb-together-live')).toContain('min-width: 0')
  })

  it('truncates a long streamer name instead of breaking the tab row', () => {
    // CSS, not string slicing: the full name has to survive in the title and
    // inside the tab, and slicing would lose it in both.
    expect(rule('.kb-tab-streamer')).toContain('text-overflow: ellipsis')
    expect(rule('.kb-tab-streamer')).toContain('max-width')
    expect(rule('.kb-tab-session')).toContain('min-width: 0')
  })

  it('holds the activity lane open so the composer cannot jump', () => {
    // Empty most of the time, and a lane that collapsed when empty would move
    // the input every time somebody sent an emote.
    expect(rule('.kb-session-activity')).toContain('min-height')
  })

  it('paints LIVE red, and only LIVE', () => {
    expect(rule('.kb-live-dot')).toContain('background: var(--kb-live)')
    expect(CSS).toContain('--kb-live: #e91916')
  })

  it('lets people turn the motion off', () => {
    const reduced = CSS.slice(CSS.indexOf('@media (prefers-reduced-motion: reduce)'))
    expect(reduced).toContain('.kb-together-burst')
    expect(reduced).toContain('.kb-session-pulse')
  })

  it('does not cover the stream', () => {
    const surface = rule('.kb-together')
    expect(surface).not.toContain('position: fixed')
    expect(surface).not.toContain('position: absolute')
  })
})

describe('the session survives everything failing around it', () => {
  it('draws the card unchanged when no membership answer arrived', () => {
    const html = render(TWO_ON_LIRIK, ON('lirik'))
    expect(html).toContain('2 friends watching with you')
    expect(html).toContain('Jake')
  })

  it('opens with nothing said yet', () => {
    const html = renderSession(TWO_ON_LIRIK, [member('jake')])
    expect(html).toContain('Nobody has said anything yet.')
    expect(html).toContain('kb-composer')
  })

  it('draws a session with no metadata at all', () => {
    const html = renderSession(TWO_ON_LIRIK, [member('jake')])
    expect(html).toContain('WATCHING TOGETHER')
    expect(html).not.toContain('LIVE')
  })
})
