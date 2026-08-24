import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { SocialGravity } from '../../src/ui/components/SocialGravity'
import { ChannelNameProvider } from '../../src/ui/ChannelNames'
import { REACTIONS, REACTION_TTL_MS } from '../../src/core/together'
import type { TogetherReaction } from '../../src/core/together'
import type { ChannelMetadata } from '../../src/core/twitchMetadata'
import type { Friend, KickbackClient } from '../../src/client/types'
import type { Activity, Presence } from '../../src/core/types'

/**
 * What Together looks like on the map.
 *
 * The whole UX claim is that Gravity and Together are two states of ONE
 * destination: you were looking at a card with a JOIN on it, you clicked, and
 * now the same card has your friends and something to do. Not a second card,
 * not a modal, not a room that had to be created.
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
  id: `r-${over.userId ?? 'jake'}-${over.at ?? Date.now()}`,
  userId: 'jake',
  channel: 'lirik',
  reaction: '😂',
  at: Date.now(),
  ...over,
})

const ON = (channel: string): Activity => ({ type: 'watching', platform: 'twitch', channel })
const IDLE: Activity = { type: 'idle' }

function render(
  friends: Friend[],
  local: Activity,
  reactions: TogetherReaction[] = [],
  metadata?: Record<string, ChannelMetadata>,
) {
  return renderToStaticMarkup(
    <ChannelNameProvider people={[]} seen={{}} metadata={metadata}>
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
        metadata={metadata}
        reactions={reactions}
      />
    </ChannelNameProvider>,
  )
}

const TWO_ON_LIRIK = [friend('jake', 'Jake', 'lirik'), friend('matt', 'Matt', 'lirik')]

describe('Gravity becomes Together, in place', () => {
  it('offers a JOIN and no reactions before the viewer arrives', () => {
    const html = render(TWO_ON_LIRIK, IDLE)
    expect(html).toContain('kb-join')
    expect(html).not.toContain('kb-together')
  })

  it('turns the same card into the Together surface on arrival', () => {
    const html = render(TWO_ON_LIRIK, ON('lirik'))

    // One card. Not a Gravity card AND a Together card.
    expect((html.match(/class="kb-gravity-card/g) ?? []).length).toBe(1)
    expect(html).toContain('kb-gravity-card-here')
    expect(html).toContain('2 friends watching with you')
    expect(html).toContain('kb-together')
    // Nowhere to go, so nothing offering to take you there.
    expect(html).not.toContain('kb-join')
    // And the people are still the people.
    expect(html).toContain('Jake')
    expect(html).toContain('Matt')
  })

  it('offers every reaction, and nothing else', () => {
    const html = render(TWO_ON_LIRIK, ON('lirik'))
    for (const value of REACTIONS) expect(html).toContain(`React ${value}`)
    expect((html.match(/kb-together-react/g) ?? []).length).toBe(REACTIONS.length)

    // No room ceremony of any kind.
    for (const forbidden of ['Create', 'Invite', 'Leave room', 'Room', 'Members']) {
      expect(html).not.toContain(forbidden)
    }
  })

  it('does not appear when the viewer is on a channel alone', () => {
    // A Together needs somebody to be together with. One person on a stream is
    // not a social context, and a reaction bar with nobody to see it is noise.
    const html = render([friend('jake', 'Jake', 'xqc')], ON('lirik'))
    expect(html).not.toContain('kb-together')
  })

  it('does not appear on a destination the viewer is not on', () => {
    const html = render(TWO_ON_LIRIK, ON('xqc'))
    expect(html).toContain('kb-join')
    expect(html).not.toContain('kb-together')
  })
})

describe('what reactions look like', () => {
  it('shows a single reaction without a counter', () => {
    const html = render(TWO_ON_LIRIK, ON('lirik'), [reaction({ userId: 'jake' })])
    expect(html).toContain('kb-together-burst')
    expect(html).not.toContain('kb-together-count')
  })

  it('shows a count once two different people agree', () => {
    const now = Date.now()
    const html = render(TWO_ON_LIRIK, ON('lirik'), [
      reaction({ userId: 'jake', at: now }),
      reaction({ userId: 'matt', at: now + 200 }),
    ])
    expect(html).toContain('kb-together-combo')
    expect(html).toContain('×2')
  })

  it('does not count one person pressing the same button', () => {
    const now = Date.now()
    const html = render(TWO_ON_LIRIK, ON('lirik'), [
      reaction({ userId: 'jake', at: now }),
      reaction({ userId: 'jake', at: now + 100 }),
      reaction({ userId: 'jake', at: now + 200 }),
    ])
    expect(html).not.toContain('kb-together-count')
  })

  it('renders nothing at all for reactions that have aged out', () => {
    const html = render(TWO_ON_LIRIK, ON('lirik'), [
      reaction({ at: Date.now() - REACTION_TTL_MS - 1 }),
    ])
    expect(html).toContain('kb-together')
    expect(html).not.toContain('kb-together-burst')
  })

  it('ignores a reaction from another channel', () => {
    const html = render(TWO_ON_LIRIK, ON('lirik'), [reaction({ channel: 'xqc' })])
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
    /*
     * Reactions arrive while somebody is watching a stream, not looking at the
     * panel. A surface that grew a line every time one landed would shove the
     * friends and the JOIN around underneath them.
     */
    expect(rule('.kb-together-bar')).toContain('min-height')
    expect(rule('.kb-together-live')).toContain('overflow: hidden')
    expect(rule('.kb-together-live')).not.toContain('flex-wrap: wrap')
  })

  it('keeps the buttons a fixed size and lets the stream shrink', () => {
    // Five buttons must fit at the 260px minimum; what is landing beside them
    // is the part that gives way.
    expect(rule('.kb-together-react')).toContain('flex: none')
    expect(rule('.kb-together-live')).toContain('min-width: 0')
  })

  it('renders nothing when there is nothing to render', () => {
    // No placeholder, no reserved space, no "no reactions yet".
    const html = render(TWO_ON_LIRIK, ON('lirik'))
    expect(html).not.toContain('kb-together-burst')
    expect(html).not.toMatch(/no reactions/i)
  })

  it('lets people turn the motion off', () => {
    expect(CSS).toContain('@media (prefers-reduced-motion: reduce)')
    const reduced = CSS.slice(CSS.indexOf('@media (prefers-reduced-motion: reduce)'))
    expect(reduced).toContain('.kb-together-burst')
  })

  it('does not cover the stream or shout', () => {
    // It lives inside the panel, like everything else. No fixed positioning,
    // no overlay, no full-screen emoji.
    const surface = rule('.kb-together')
    expect(surface).not.toContain('position: fixed')
    expect(surface).not.toContain('position: absolute')
  })
})

describe('Together survives everything failing around it', () => {
  it('works with no metadata at all', () => {
    const html = render(TWO_ON_LIRIK, ON('lirik'))
    expect(html).toContain('kb-together')
    expect(html).toContain('2 friends watching with you')
  })

  it('works when realtime delivered nothing', () => {
    // The reaction buffer being empty is indistinguishable from realtime being
    // down, and both are perfectly usable: who is here comes from presence.
    const html = render(TWO_ON_LIRIK, ON('lirik'), [])
    expect(html).toContain('kb-together-react')
    expect(html).toContain('Jake')
  })

  it('is enriched by metadata without depending on it', () => {
    const metadata: Record<string, ChannelMetadata> = {
      lirik: {
        login: 'lirik',
        userId: '1',
        displayName: 'LIRIK',
        profileImageUrl: null,
        live: 'live',
        gameName: 'Escape from Tarkov',
        title: 'grinding',
        viewerCount: 18_412,
        startedAt: null,
        fetchedAt: Date.now(),
      },
    }
    const html = render(TWO_ON_LIRIK, ON('lirik'), [], metadata)
    expect(html).toContain('LIRIK')
    expect(html).toContain('Escape from Tarkov')
    expect(html).toContain('kb-together')
  })
})
