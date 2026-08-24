import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { SocialGravity } from '../../src/ui/components/SocialGravity'
import { ChannelNameProvider } from '../../src/ui/ChannelNames'
import type { Friend, KickbackClient } from '../../src/client/types'
import type { Activity, Presence } from '../../src/core/types'

/**
 * What the map actually renders.
 *
 * The selector tests prove the clustering; these prove the panel says what the
 * clustering found - that a gathering reads as a gathering, that the channel
 * you are already on offers nowhere to go, and that making the map the default
 * view did not quietly cost anybody their friend management.
 */

const NOW = 1_700_000_000_000
const CSS = readFileSync('src/ui/kickback.css', 'utf8')

const friend = (id: string, name: string, presence: Presence | null): Friend => ({
  user: { id, username: id, displayName: name, avatarUrl: null, accentColor: '#ff8452' },
  presence,
})

const watching = (userId: string, channel: string): Presence => ({
  userId,
  status: 'online',
  activity: { type: 'watching', platform: 'twitch', channel },
  since: NOW - 60_000,
  lastSeenAt: Date.now(),
})

const browsing = (userId: string): Presence => ({
  userId,
  status: 'online',
  activity: { type: 'browsing', platform: 'twitch' },
  since: NOW,
  lastSeenAt: Date.now(),
})

const offline = (userId: string): Presence => ({
  userId,
  status: 'offline',
  activity: { type: 'idle' },
  since: NOW,
  lastSeenAt: NOW,
})

const ON = (channel: string): Activity => ({ type: 'watching', platform: 'twitch', channel })
const IDLE: Activity = { type: 'idle' }

function stubClient(): KickbackClient {
  return {
    sendFriendRequest: async () => 'req',
    removeFriend: async () => {},
    track: () => {},
    recordJoin: () => {},
    reportExposure: () => {},
  } as unknown as KickbackClient
}

function render(friends: Friend[], local: Activity = IDLE, onRemove?: (id: string) => void) {
  return renderToStaticMarkup(
    <ChannelNameProvider people={[]} seen={{ lirik: 'LIRIK', xqc: 'xQc' }}>
      <SocialGravity
        friends={friends}
        localActivity={local}
        onRemove={onRemove}
        client={stubClient()}
        cardContext={{
          selfId: 'me',
          viewerActivity: local,
          friendIds: new Set(friends.map((f) => f.user.id)),
          outgoingRequestIds: new Set(),
        }}
      />
    </ChannelNameProvider>,
  )
}

describe('a gathering', () => {
  const gathering = [
    friend('jake', 'Jake', watching('jake', 'lirik')),
    friend('matt', 'Matt', watching('matt', 'lirik')),
    friend('chris', 'Chris', watching('chris', 'lirik')),
  ]

  it('reads as one destination, not three rows', () => {
    const html = render(gathering)
    // One card, not one per person. Matched on the opening attribute so the
    // modifier class does not count as a second card.
    expect(html.match(/class="kb-gravity-card/g) ?? []).toHaveLength(1)
    expect(html).toContain('LIRIK')
  })

  it('shows every friend by name', () => {
    // The destination is the subject, but the people are why it matters.
    const html = render(gathering)
    for (const name of ['Jake', 'Matt', 'Chris']) expect(html).toContain(name)
  })

  it('carries the flame and the heavier treatment at two friends', () => {
    expect(render(gathering)).toContain('kb-gravity-card-strong')
    expect(render(gathering)).toContain('🔥')
  })

  it('offers a JOIN that goes through the social gravity source', () => {
    const html = render(gathering)
    expect(html).toContain('kb-join')
    // Not a new pipeline: the same JoinButton every other surface uses.
    expect(html).toContain('Watch LIRIK on Twitch')
  })

  it('says how many people are there', () => {
    expect(render(gathering)).toMatch(/kb-gravity-count[^>]*>3</)
  })
})

describe('a single friend on a stream', () => {
  const solo = [friend('sarah', 'Sarah', watching('sarah', 'xqc'))]

  it('is still a destination worth showing', () => {
    const html = render(solo)
    expect(html).toContain('kb-gravity-card')
    expect(html).toContain('xQc')
    expect(html).toContain('Sarah')
    // And still somewhere you can go.
    expect(html).toContain('kb-join')
  })

  it('does not get the gathering treatment', () => {
    // One friend is discovery, not gravity. What changes with size is
    // emphasis, not existence.
    const html = render(solo)
    expect(html).not.toContain('kb-gravity-card-strong')
    expect(html).not.toContain('🔥')
  })
})

describe('the channel the viewer is already on', () => {
  const here = [
    friend('jake', 'Jake', watching('jake', 'lirik')),
    friend('matt', 'Matt', watching('matt', 'lirik')),
  ]

  it('offers no JOIN, because there is nowhere to go', () => {
    const html = render(here, ON('lirik'))
    expect(html).toContain('kb-gravity-card-here')
    expect(html).not.toContain('kb-join')
    expect(html).toContain('HERE')
  })

  it('counts the other people, never the viewer', () => {
    // A + Jake + Matt on Lirik: A is watching with TWO friends, not three.
    const html = render(here, ON('lirik'))
    expect(html).toContain('2 friends watching with you')
    expect(html).not.toContain('3 friends watching with you')
  })

  it('says it in the singular for one friend', () => {
    const html = render([friend('jake', 'Jake', watching('jake', 'lirik'))], ON('lirik'))
    expect(html).toContain('1 friend watching with you')
  })
})

describe('friend management stays reachable', () => {
  const mixed = [
    friend('jake', 'Jake', watching('jake', 'lirik')),
    friend('dave', 'Dave', browsing('dave')),
    friend('nina', 'Nina', offline('nina')),
  ]

  it('keeps the quiet sections as ordinary rows', () => {
    /*
     * Around and Offline keep PersonRow, so they keep the status line and the
     * card exactly as the flat list had them. Making the map the default view
     * must not quietly change what those people look like.
     */
    const html = render(mixed, IDLE, () => {})
    expect(html).toContain('Around on Twitch')
    expect(html).toContain('Offline')
    expect(html).toContain('kb-row-status')
    expect(html).toContain('title="About Dave"')
    expect(html).toContain('title="About Nina"')
  })

  it('routes removal through the user card, as it already did', () => {
    /*
     * PersonRow only ever offered an inline remove for friends Kickback has NO
     * presence for; anyone online was removed from their card. That predates
     * Gravity and is unchanged - worth pinning so a later refactor does not
     * assume the inline control was there and quietly drop the card path.
     */
    const html = render([friend('pat', 'Pat', null)], IDLE, () => {})
    expect(html).toContain('Remove Pat from your friends')

    const online = render(mixed, IDLE, () => {})
    expect(online).not.toContain('Remove Dave from your friends')
    // But their identity still opens the card that can.
    expect(online).toContain('title="About Dave"')
  })

  it('makes every identity on the map open its user card', () => {
    const html = render(mixed)
    // The friend inside a destination card is a control, not just a label.
    expect(html).toContain('title="About Jake"')
    expect(html).toContain('kb-person-btn')
  })

  it('says something useful when there is nobody yet', () => {
    expect(render([])).toContain('No friends yet.')
  })
})

describe('the map at the narrowest panel', () => {
  it('never lets a long channel name push JOIN off the card', () => {
    /*
     * The panel goes down to 260px and a Twitch login can be 25 characters.
     * The name is the flexible part; the count and the JOIN are not.
     */
    const rule = CSS.slice(CSS.indexOf('.kb-gravity-channel {'))
    expect(rule).toContain('text-overflow: ellipsis')
    expect(rule).toContain('min-width: 0')

    const count = CSS.slice(CSS.indexOf('.kb-gravity-count {'))
    expect(count).toContain('flex: none')
  })

  it('wraps a large gathering rather than hiding people behind a scroller', () => {
    const people = CSS.slice(CSS.indexOf('.kb-gravity-people {'))
    expect(people).toContain('flex-wrap: wrap')
  })

  it('anchors a user card to the person it belongs to', () => {
    const person = CSS.slice(CSS.indexOf('.kb-gravity-person {'))
    expect(person).toContain('position: relative')
  })
})

describe('the ordering the panel draws', () => {
  it('puts the biggest gathering above a smaller one', () => {
    const html = render([
      friend('sarah', 'Sarah', watching('sarah', 'xqc')),
      friend('jake', 'Jake', watching('jake', 'lirik')),
      friend('matt', 'Matt', watching('matt', 'lirik')),
    ])
    expect(html.indexOf('LIRIK')).toBeLessThan(html.indexOf('xQc'))
  })

  it('puts where you already are above everything', () => {
    const html = render(
      [
        friend('jake', 'Jake', watching('jake', 'lirik')),
        friend('matt', 'Matt', watching('matt', 'lirik')),
        friend('chris', 'Chris', watching('chris', 'lirik')),
        friend('sarah', 'Sarah', watching('sarah', 'xqc')),
      ],
      ON('xqc'),
    )
    // Even though Lirik has three people and here has one.
    expect(html.indexOf('xQc')).toBeLessThan(html.indexOf('LIRIK'))
  })

  it('keeps the quiet sections at the bottom', () => {
    const html = render([
      friend('nina', 'Nina', offline('nina')),
      friend('dave', 'Dave', browsing('dave')),
      friend('jake', 'Jake', watching('jake', 'lirik')),
    ])
    expect(html.indexOf('LIRIK')).toBeLessThan(html.indexOf('Around on Twitch'))
    expect(html.indexOf('Around on Twitch')).toBeLessThan(html.indexOf('Offline'))
  })
})
