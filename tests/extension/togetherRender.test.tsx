import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { SocialGravity } from '../../src/ui/components/SocialGravity'
import { StreamRoom } from '../../src/ui/components/StreamRoom'
import { ChannelNameProvider } from '../../src/ui/ChannelNames'
import { REACTIONS, REACTION_TTL_MS } from '../../src/core/together'
import type { TogetherReaction } from '../../src/core/together'
import type { RoomMember } from '../../src/core/streamRoom'
import type { Friend, KickbackClient } from '../../src/client/types'
import type { Activity, Presence } from '../../src/core/types'

/**
 * What an automatic Stream Room looks like, outside it and inside it.
 *
 * THE UX THIS FILE WAS REWRITTEN FOR
 *
 * The first version put five permanent reaction buttons and a roster on the
 * Gravity card, behind a ROOM button that expanded them in place. It passed
 * its tests and it was the wrong product: the map became a composer, and
 * "entering a room" was a disclosure triangle.
 *
 * So the card outside now carries two things - what is happening in there, and
 * the way in - and the room is a view you arrive in and come back from. These
 * tests assert that split, and in particular assert the ABSENCE of what used
 * to be on the card, because the old shape is exactly what a well-meaning
 * change would put back.
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
  ...over,
})

const member = (userId: string, hops = 1, viaUserId: string | null = null): RoomMember => ({
  userId,
  hops,
  viaUserId,
})

const ON = (channel: string): Activity => ({ type: 'watching', platform: 'twitch', channel })
const IDLE: Activity = { type: 'idle' }

const CLIENT = { sendReaction: () => {} } as unknown as KickbackClient

/** The map, as the Friends tab draws it. */
function render(
  friends: Friend[],
  local: Activity,
  reactions: TogetherReaction[] = [],
  roomMembers: RoomMember[] = [],
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
        roomMembers={roomMembers}
        onOpenRoom={() => {}}
      />
    </ChannelNameProvider>,
  )
}

/** The room, as the panel draws it once you have walked in. */
function renderRoom(
  friends: Friend[],
  roomMembers: RoomMember[],
  reactions: TogetherReaction[] = [],
) {
  return renderToStaticMarkup(
    <ChannelNameProvider people={[]} seen={{}}>
      <StreamRoom
        channel="lirik"
        members={roomMembers}
        friends={friends}
        reactions={reactions}
        selfId="me"
        client={CLIENT}
        cardContext={{
          selfId: 'me',
          viewerActivity: ON('lirik'),
          friendIds: new Set(friends.map((f) => f.user.id)),
          outgoingRequestIds: new Set(),
        }}
        onBack={() => {}}
      />
    </ChannelNameProvider>,
  )
}

const TWO_ON_LIRIK = [friend('jake', 'Jake', 'lirik'), friend('matt', 'Matt', 'lirik')]

describe('the card outside the room', () => {
  it('offers a JOIN and no doorway before the viewer arrives', () => {
    const html = render(TWO_ON_LIRIK, IDLE)
    expect(html).toContain('kb-join')
    expect(html).not.toContain('kb-together')
  })

  it('grows a doorway on the card the viewer is standing in', () => {
    const html = render(TWO_ON_LIRIK, ON('lirik'), [], [member('jake'), member('matt')])

    expect((html.match(/class="kb-gravity-card/g) ?? []).length).toBe(1)
    expect(html).toContain('kb-gravity-card-here')
    expect(html).toContain('2 friends watching with you')
    expect(html).toContain('kb-together-open')
    expect(html).toContain('ROOM')
    expect(html).not.toContain('kb-join')
  })

  it('has no reaction buttons on it', () => {
    /*
     * The correction, asserted directly.
     *
     * Five permanent controls in the middle of the social map made it a thing
     * to operate rather than a thing to read. Reacting happens inside.
     */
    const html = render(TWO_ON_LIRIK, ON('lirik'), [], [member('jake')])
    expect(html).not.toContain('kb-together-react')
    expect(html).not.toContain('kb-room-react')
  })

  it('does not list the people in the room', () => {
    // The roster is what you go in for. On the card it is noise, and for a
    // two-hop member it would name somebody the card never explains.
    const html = render(TWO_ON_LIRIK, ON('lirik'), [], [member('jake'), member('sarah', 2, 'jake')])
    expect(html).not.toContain('kb-room-person')
    expect(html).not.toContain('Friend of')
  })

  it('is not a toggle: there is no CLOSE state', () => {
    const html = render(TWO_ON_LIRIK, ON('lirik'), [], [member('jake')])
    expect(html).not.toContain('CLOSE')
    expect(html).not.toContain('aria-expanded')
  })

  it('offers no doorway when the server found no room', () => {
    /*
     * The condition is the SERVER's membership, not the HERE count.
     *
     * They used to be or-ed, so a card could offer a room nobody was in - the
     * count comes from presence the client already has, while membership comes
     * from a query that also requires a live stream. Presence still draws the
     * card and still says who is here; it just does not manufacture a door.
     */
    const html = render(TWO_ON_LIRIK, ON('lirik'), [], [])
    expect(html).toContain('2 friends watching with you')
    expect(html).not.toContain('kb-together-open')
  })

  it('does not appear on a destination the viewer is not on', () => {
    const html = render(TWO_ON_LIRIK, ON('xqc'), [], [member('jake')])
    expect(html).toContain('kb-join')
    expect(html).not.toContain('kb-together')
  })
})

describe('the activity preview', () => {
  it('shows a single reaction with no counter', () => {
    const html = render(TWO_ON_LIRIK, ON('lirik'), [reaction({ senderId: 'jake' })], [member('jake')])
    expect(html).toContain('kb-together-burst')
    expect(html).not.toContain('kb-together-count')
  })

  it('counts two different people in place, as one badge', () => {
    /*
     * The stacking bug, asserted away: one badge with a number, not two emoji
     * side by side. This is what `scanCombos` produces, and it is the same
     * shape group chat has always drawn.
     */
    const now = Date.now()
    const html = render(
      TWO_ON_LIRIK,
      ON('lirik'),
      [reaction({ senderId: 'jake', at: now }), reaction({ senderId: 'matt', at: now + 200 })],
      [member('jake'), member('matt')],
    )
    expect((html.match(/kb-together-burst/g) ?? []).length).toBe(1)
    expect(html).toContain('×2')
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
      [member('jake')],
    )
    expect(html).not.toContain('kb-together-count')
  })

  it('vanishes completely once the reactions have aged out', () => {
    /*
     * Ephemeral means gone, not faded to a stub.
     *
     * No timestamp, no "recently", no last-known combo kept to stop the row
     * changing height - the row holds its own height, so there is nothing to
     * preserve state for. If it is on screen, it is happening.
     */
    const html = render(
      TWO_ON_LIRIK,
      ON('lirik'),
      [
        reaction({ senderId: 'jake', at: Date.now() - REACTION_TTL_MS - 1 }),
        reaction({ senderId: 'matt', at: Date.now() - REACTION_TTL_MS - 1 }),
      ],
      [member('jake'), member('matt')],
    )
    expect(html).toContain('kb-together-open')
    expect(html).not.toContain('kb-together-burst')
    expect(html).not.toContain('×2')
  })

  it('ignores a reaction from another channel', () => {
    const html = render(TWO_ON_LIRIK, ON('lirik'), [reaction({ channel: 'xqc' })], [member('jake')])
    expect(html).not.toContain('kb-together-burst')
  })

  it('never says who reacted', () => {
    /*
     * The combo is the whole message.
     *
     * "Sarah + Jake are reacting" is narration - something to read rather than
     * something to notice - and on a card that can carry a two-hop room it
     * would put a name outside the surface that explains it.
     */
    const now = Date.now()
    const html = render(
      [friend('jake', 'Jake', 'lirik')],
      ON('lirik'),
      [reaction({ senderId: 'jake', at: now }), reaction({ senderId: 'sarah', at: now + 100 })],
      [member('jake'), member('sarah', 2, 'jake')],
    )
    const preview = html.slice(html.indexOf('kb-together'))
    expect(preview).toContain('×2')
    expect(preview).not.toContain('Sarah')
    expect(preview).not.toMatch(/reacting|reacted|just now|ago/i)
  })
})

describe('inside the room', () => {
  it('is somewhere you came from, with a way back', () => {
    const html = renderRoom(TWO_ON_LIRIK, [member('jake'), member('matt')])
    expect(html).toContain('kb-detail-head')
    expect(html).toContain('kb-back')
    expect(html).toContain('Back to friends')
  })

  it('says how many people are watching together, counting the viewer', () => {
    const html = renderRoom(TWO_ON_LIRIK, [member('jake'), member('matt')])
    expect(html).toContain('WATCHING TOGETHER')
    expect(html).toContain('3')
  })

  it('lists the participants, and the viewer', () => {
    const html = renderRoom(TWO_ON_LIRIK, [member('jake'), member('matt')])
    expect(html).toContain('Jake')
    expect(html).toContain('Matt')
    expect(html).toContain('You')
  })

  it('names somebody two hops away through the friend who connects them', () => {
    /*
     * The whole point of a connected component: Sarah is Jake's friend, not
     * the viewer's, and presence tells the viewer nothing about her. She is in
     * the room because the server said so, and she is legible because it also
     * said who connects them.
     */
    const html = renderRoom(
      [friend('jake', 'Jake', 'lirik')],
      [member('jake'), member('sarah', 2, 'jake')],
    )
    expect(html).toContain('Friend of Jake')
    expect(html).toContain('kb-room-unknown')
    expect(html).toContain('Some people here arrived through a friend.')
  })

  it('is where the reactions are', () => {
    const html = renderRoom(TWO_ON_LIRIK, [member('jake')])
    expect((html.match(/kb-room-react-btn/g) ?? []).length).toBe(REACTIONS.length)
    // The same inline SVG group chat draws. No unicode palette anywhere.
    expect(html).toContain('kb-emote')
    for (const forbidden of ['😂', '❤️', '🔥', '😭', '👀']) {
      expect(html).not.toContain(forbidden)
    }
  })

  it('shows the same combo the card outside was showing', () => {
    /*
     * One combo semantic model.
     *
     * Both surfaces call roomActivity, so walking in continues what the
     * preview was showing rather than offering a second opinion about the same
     * eight seconds.
     */
    const now = Date.now()
    const reactions = [
      reaction({ senderId: 'jake', at: now }),
      reaction({ senderId: 'matt', at: now + 200 }),
    ]
    const outside = render(TWO_ON_LIRIK, ON('lirik'), reactions, [member('jake'), member('matt')])
    const inside = renderRoom(TWO_ON_LIRIK, [member('jake'), member('matt')], reactions)

    expect(outside).toContain('×2')
    expect(inside).toContain('×2')
  })

  it('has no ceremony, and no chat', () => {
    const html = renderRoom(TWO_ON_LIRIK, [member('jake')])
    for (const forbidden of [
      'Create',
      'Invite',
      'Leave room',
      'Room name',
      'Join room',
      'Send',
      'Message',
    ]) {
      expect(html).not.toContain(forbidden)
    }
    expect(html).not.toContain('<textarea')
    expect(html).not.toContain('<input')
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

  it('holds the room activity lane open so the buttons cannot jump', () => {
    expect(rule('.kb-room-activity')).toContain('min-height')
  })

  it('renders nothing when there is nothing to render', () => {
    const html = render(TWO_ON_LIRIK, ON('lirik'), [], [member('jake')])
    expect(html).not.toContain('kb-together-burst')
    expect(html).not.toMatch(/no reactions/i)
  })

  it('lets people turn the motion off', () => {
    const reduced = CSS.slice(CSS.indexOf('@media (prefers-reduced-motion: reduce)'))
    expect(reduced).toContain('.kb-together-burst')
    expect(reduced).toContain('.kb-room-combo')
  })

  it('does not cover the stream', () => {
    const surface = rule('.kb-together')
    expect(surface).not.toContain('position: fixed')
    expect(surface).not.toContain('position: absolute')
  })
})

describe('the room survives everything failing around it', () => {
  it('draws the card unchanged when no membership answer arrived', () => {
    // Presence still says who is here. The door is the part that is missing.
    const html = render(TWO_ON_LIRIK, ON('lirik'), [], [])
    expect(html).toContain('2 friends watching with you')
    expect(html).toContain('Jake')
  })

  it('opens a room when realtime delivered nothing', () => {
    const html = renderRoom(TWO_ON_LIRIK, [member('jake')])
    expect(html).toContain('Jake')
    expect(html).toContain('kb-room-react-btn')
    expect(html).not.toContain('kb-room-combo')
  })

  it('draws a room with no metadata at all', () => {
    const html = renderRoom(TWO_ON_LIRIK, [member('jake')])
    expect(html).toContain('WATCHING TOGETHER')
    expect(html).not.toContain('LIVE')
  })
})
