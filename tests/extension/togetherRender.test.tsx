import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { SocialGravity } from '../../src/ui/components/SocialGravity'
import { ChannelNameProvider } from '../../src/ui/ChannelNames'
import { REACTIONS, REACTION_TTL_MS } from '../../src/core/together'
import type { TogetherReaction } from '../../src/core/together'
import type { RoomMember } from '../../src/core/streamRoom'
import type { Friend, KickbackClient } from '../../src/client/types'
import type { Activity, Presence } from '../../src/core/types'

/**
 * What an automatic Stream Room looks like on the map.
 *
 * Gravity and the room are two states of ONE destination: you were looking at
 * a card with a JOIN on it, you clicked, and now the same card has your
 * friends, a reaction strip and a way to see who else is here. Not a second
 * card, not a modal, not a room that had to be created.
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
        client={{ sendReaction: () => {} } as unknown as KickbackClient}
        cardContext={{
          selfId: 'me',
          viewerActivity: local,
          friendIds: new Set(friends.map((f) => f.user.id)),
          outgoingRequestIds: new Set(),
        }}
        reactions={reactions}
        roomMembers={roomMembers}
      />
    </ChannelNameProvider>,
  )
}

const TWO_ON_LIRIK = [friend('jake', 'Jake', 'lirik'), friend('matt', 'Matt', 'lirik')]

describe('Gravity becomes a room, in place', () => {
  it('offers a JOIN and no room before the viewer arrives', () => {
    const html = render(TWO_ON_LIRIK, IDLE)
    expect(html).toContain('kb-join')
    expect(html).not.toContain('kb-together')
  })

  it('turns the same card into the room on arrival', () => {
    const html = render(TWO_ON_LIRIK, ON('lirik'), [], [member('jake'), member('matt')])

    expect((html.match(/class="kb-gravity-card/g) ?? []).length).toBe(1)
    expect(html).toContain('kb-gravity-card-here')
    expect(html).toContain('2 friends watching with you')
    expect(html).toContain('kb-together')
    expect(html).not.toContain('kb-join')
    expect(html).toContain('Jake')
  })

  it('offers every reaction as Kickback artwork, not a glyph', () => {
    const html = render(TWO_ON_LIRIK, ON('lirik'), [], [member('jake')])
    expect((html.match(/kb-together-react/g) ?? []).length).toBe(REACTIONS.length)
    // The same inline SVG group chat draws. No unicode palette anywhere.
    expect(html).toContain('kb-emote')
    for (const forbidden of ['😂', '❤️', '🔥', '😭', '👀']) {
      expect(html).not.toContain(forbidden)
    }
  })

  it('shows no room ceremony of any kind', () => {
    const html = render(TWO_ON_LIRIK, ON('lirik'), [], [member('jake')])
    for (const forbidden of ['Create', 'Invite', 'Leave room', 'Members', 'Room name']) {
      expect(html).not.toContain(forbidden)
    }
  })

  it('does not appear on a destination the viewer is not on', () => {
    const html = render(TWO_ON_LIRIK, ON('xqc'), [], [member('jake')])
    expect(html).toContain('kb-join')
    expect(html).not.toContain('kb-together')
  })
})

describe('the room roster', () => {
  it('is closed until asked for', () => {
    // The reactions are what you reach for; the roster is what you check.
    const html = render(TWO_ON_LIRIK, ON('lirik'), [], [member('jake')])
    expect(html).toContain('kb-together-open')
    expect(html).not.toContain('kb-room-person')
  })

  it('names somebody two hops away, through the friend who connects them', () => {
    /*
     * The whole point of a connected component: Sarah is Jake's friend, not
     * the viewer's, and presence tells the viewer nothing about her. She is in
     * the room because the server said so, and she is legible because it also
     * said who connects them.
     *
     * Note what this case CANNOT be: a two-hop person with no direct friend
     * present. The walk only steps through people who are here, so reaching
     * Sarah requires Jake to be here too - which is asserted below.
     */
    const html = render(
      [friend('jake', 'Jake', 'lirik')],
      ON('lirik'),
      [],
      [member('jake'), member('sarah', 2, 'jake')],
    )
    expect(html).toContain('kb-together')
    expect(html).toContain('kb-together-open')
  })

  it('cannot contain a distant person without the friend who connects them', () => {
    // Not a rendering rule - a property of the walk. Stated here because the
    // roster's "Friend of Jake" line depends on Jake being someone we can name.
    const html = render([], ON('lirik'), [], [member('sarah', 2, 'jake')])
    // No friends at all means no social map to put a room on.
    expect(html).toContain('No friends yet.')
  })
})

describe('what reactions look like', () => {
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
    expect(html).toContain('kb-together-combo')
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

  it('renders nothing for reactions that aged out', () => {
    const html = render(
      TWO_ON_LIRIK,
      ON('lirik'),
      [reaction({ at: Date.now() - REACTION_TTL_MS - 1 })],
      [member('jake')],
    )
    expect(html).toContain('kb-together')
    expect(html).not.toContain('kb-together-burst')
  })

  it('ignores a reaction from another channel', () => {
    const html = render(TWO_ON_LIRIK, ON('lirik'), [reaction({ channel: 'xqc' })], [member('jake')])
    expect(html).not.toContain('kb-together-burst')
  })
})

describe('the surface stays small', () => {
  const rule = (selector: string) => {
    const at = CSS.indexOf(`${selector} {`)
    if (at < 0) throw new Error(`no rule for ${selector}`)
    return CSS.slice(at, CSS.indexOf('}', at))
  }

  it('is one row that cannot change height when a reaction lands', () => {
    expect(rule('.kb-together-bar')).toContain('min-height')
    expect(rule('.kb-together-live')).toContain('overflow: hidden')
    expect(rule('.kb-together-live')).not.toContain('flex-wrap: wrap')
  })

  it('keeps the buttons and the ROOM control fixed, and lets the stream shrink', () => {
    expect(rule('.kb-together-react')).toContain('flex: none')
    expect(rule('.kb-together-open')).toContain('flex: none')
    expect(rule('.kb-together-live')).toContain('min-width: 0')
  })

  it('renders nothing when there is nothing to render', () => {
    const html = render(TWO_ON_LIRIK, ON('lirik'), [], [member('jake')])
    expect(html).not.toContain('kb-together-burst')
    expect(html).not.toMatch(/no reactions/i)
  })

  it('lets people turn the motion off', () => {
    const reduced = CSS.slice(CSS.indexOf('@media (prefers-reduced-motion: reduce)'))
    expect(reduced).toContain('.kb-together-burst')
  })

  it('does not cover the stream', () => {
    const surface = rule('.kb-together')
    expect(surface).not.toContain('position: fixed')
    expect(surface).not.toContain('position: absolute')
  })
})

describe('the room survives everything failing around it', () => {
  it('works with no membership answer at all', () => {
    // Presence still says who is here. The roster is the part that is missing.
    const html = render(TWO_ON_LIRIK, ON('lirik'), [], [])
    expect(html).toContain('kb-together')
    expect(html).toContain('2 friends watching with you')
  })

  it('works when realtime delivered nothing', () => {
    const html = render(TWO_ON_LIRIK, ON('lirik'), [], [member('jake')])
    expect(html).toContain('kb-together-react')
    expect(html).toContain('Jake')
  })
})
