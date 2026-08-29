import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { SocialGravity } from '../../src/ui/components/SocialGravity'
import { ChannelNameProvider } from '../../src/ui/ChannelNames'
import { socialGravity } from '../../src/core/socialGravity'
import { STALE_TOLERANCE_MS } from '../../src/core/twitchMetadata'
import type { ChannelMetadata } from '../../src/core/twitchMetadata'
import { avatarTint } from '../../src/ui/avatarTint'
import type { Friend, KickbackClient } from '../../src/client/types'
import type { Activity, Presence } from '../../src/core/types'

/**
 * Twitch metadata on the social map.
 *
 * Two rules are being defended, and they pull in opposite directions.
 *
 * The first is that metadata must MAKE THE CARD BETTER: authoritative casing,
 * an avatar, a category, whether the stream is even on.
 *
 * The second is that it must never make the card WORSE. Friend count still
 * decides the order. Viewer count and category decide nothing. And every
 * absence, failure and stale record has to land on the plain card that shipped
 * before any of this existed - because that card works, and a confidently
 * wrong one does not.
 */

const NOW = 1_700_000_000_000
const CSS = readFileSync('src/ui/kickback.css', 'utf8')

const friend = (id: string, name: string, channel: string | null): Friend => ({
  user: { id, username: id, displayName: name, avatarUrl: null, accentColor: '#ff8452' },
  presence: {
    userId: id,
    status: 'online',
    activity: channel
      ? { type: 'watching', platform: 'twitch', channel }
      : { type: 'browsing', platform: 'twitch' },
    since: NOW - 60_000,
    lastSeenAt: Date.now(),
  } as Presence,
})

const meta = (login: string, over: Partial<ChannelMetadata> = {}): ChannelMetadata => ({
  login,
  userId: '1',
  displayName: login.toUpperCase(),
  profileImageUrl: `https://static-cdn.jtvnw.net/jtv_user_pictures/${login}.png`,
  live: 'live',
  gameName: 'Escape from Tarkov',
  title: 'late night wipe grind',
  viewerCount: 18_412,
  startedAt: Date.now() - 60_000,
  fetchedAt: Date.now(),
  ...over,
})

const IDLE: Activity = { type: 'idle' }
const ON = (channel: string): Activity => ({ type: 'watching', platform: 'twitch', channel })

function stubClient(): KickbackClient {
  return {
    sendFriendRequest: async () => 'req',
    removeFriend: async () => {},
    track: () => {},
    recordJoin: () => {},
    reportExposure: () => {},
  } as unknown as KickbackClient
}

function render(
  friends: Friend[],
  metadata?: Record<string, ChannelMetadata>,
  local: Activity = IDLE,
) {
  return renderToStaticMarkup(
    <ChannelNameProvider people={[]} seen={{}} metadata={metadata}>
      <SocialGravity
        friends={friends}
        localActivity={local}
        client={stubClient()}
        cardContext={{
          selfId: 'me',
          viewerActivity: local,
          friendIds: new Set(friends.map((f) => f.user.id)),
          outgoingRequestIds: new Set(),
        }}
        metadata={metadata}
      />
    </ChannelNameProvider>,
  )
}

const THREE_ON_LIRIK = [
  friend('jake', 'Jake', 'lirik'),
  friend('matt', 'Matt', 'lirik'),
  friend('chris', 'Chris', 'lirik'),
]

describe('a live destination', () => {
  const html = render(THREE_ON_LIRIK, { lirik: meta('lirik') })

  it('says it is live, and what of', () => {
    expect(html).toContain('LIVE')
    expect(html).toContain('Escape from Tarkov')
    expect(html).toContain('late night wipe grind')
  })

  it('shows the viewer count compactly, and quietly', () => {
    expect(html).toContain('18K')
    // Context, not a headline: it must not be the friend count's size or
    // weight. The count keeps kb-gravity-count; viewers get their own class.
    expect(html).toContain('kb-gravity-viewers')
    const viewers = CSS.slice(CSS.indexOf('.kb-gravity-viewers {'))
    expect(viewers).toContain('var(--kb-faint)')
  })

  it('shows the creator avatar from Twitch', () => {
    // The slot is always there; with a picture it holds the picture. It reuses
    // the .kb-avatar box every other avatar in Watchside uses, so the image and
    // the monogram fallback occupy exactly the same geometry.
    expect(html).toContain('kb-gravity-avatar')
    expect(html).toMatch(/<img[^>]*class="kb-avatar-img"[^>]*src="https:\/\/static-cdn\.jtvnw\.net/)
    expect(html).toContain('loading="lazy"')
    // Decorative: the name is right beside it.
    expect(html).toContain('aria-hidden="true"')
  })

  it('still leads with the friends', () => {
    expect(html).toContain('LIRIK')
    expect(html).toMatch(/kb-gravity-count[^>]*>3\b/)
    for (const name of ['Jake', 'Matt', 'Chris']) expect(html).toContain(name)
    expect(html).toContain('kb-join')
    expect(html).toContain('🔥')
  })
})

describe('a destination whose stream has ended', () => {
  const html = render(THREE_ON_LIRIK, { lirik: meta('lirik', { live: 'offline' }) })

  it('says so plainly', () => {
    expect(html).toContain('OFFLINE')
    expect(html).toContain('kb-gravity-card-offline')
  })

  it('keeps the friends, the count and the JOIN', () => {
    /*
     * Presence is the authority on where people are. A destination that
     * vanished because Twitch said the stream ended would be a worse lie than
     * one marked OFFLINE - the friends really are there.
     */
    expect(html).toMatch(/kb-gravity-count[^>]*>3\b/)
    expect(html).toContain('Jake')
    expect(html).toContain('kb-join')
  })

  it('carries nothing from a stream that is not happening', () => {
    const withStream = render(THREE_ON_LIRIK, {
      lirik: meta('lirik', { live: 'offline', gameName: null, title: null, viewerCount: null }),
    })
    expect(withStream).not.toContain('Escape from Tarkov')
    expect(withStream).not.toContain('18K')
    expect(withStream).not.toContain('>LIVE<')
  })
})

describe('when nothing told us', () => {
  it('is a card in its own right, not a rich card with holes in it', () => {
    /*
     * The acceptance standard, and the reason this test changed shape.
     *
     * It used to assert that the plain card contained no avatar at all. That
     * was the wrong invariant: it meant the header had two geometries, so the
     * name started 28px further left without metadata and jumped sideways the
     * moment metadata arrived. Absence must reduce INFORMATION, not quality.
     *
     * What must still hold is that nothing CLAIMS anything: no badge, no
     * category, no title, no reserved blank row.
     */
    const plain = render(THREE_ON_LIRIK)
    const unknown = render(THREE_ON_LIRIK, {})

    // "no record" and "no metadata at all" are the same state.
    expect(plain).toBe(unknown)

    // Nothing invented.
    expect(plain).not.toContain('LIVE')
    expect(plain).not.toContain('OFFLINE')
    expect(plain).not.toContain('kb-gravity-stream')
    expect(plain).not.toContain('kb-gravity-title')
    expect(plain).not.toContain('static-cdn.jtvnw.net')

    // But the structure is whole: same avatar slot, same header, same count,
    // same JOIN, same people.
    expect(plain).toContain('kb-gravity-avatar')
    expect(plain).toMatch(/kb-gravity-count[^>]*>3\b/)
    expect(plain).toContain('kb-join')
    expect(plain).toContain('Jake')
  })

  it('keeps the header geometry identical when metadata arrives', () => {
    /*
     * Progressive enhancement, not reflow.
     *
     * Everything metadata adds appears BELOW the head. The head itself must
     * hold the same boxes in the same order and the same sizes whether or not
     * a record exists - otherwise the name jumps sideways the moment a request
     * comes back, which is what the always-present avatar slot exists to
     * prevent.
     */
    const head = (html: string) =>
      html.slice(html.indexOf('kb-gravity-head'), html.indexOf('</div><div class="kb-gravity'))

    /** The top-level boxes of the head, in order. */
    const boxes = (html: string) =>
      [...head(html).matchAll(/<(?:div|span|button)[^>]*class="([^"]+)"/g)].map((m) => m[1])

    const plain = render(THREE_ON_LIRIK)
    const rich = render(THREE_ON_LIRIK, { lirik: meta('lirik') })

    expect(boxes(rich)).toEqual(boxes(plain))

    // And the avatar box is the same size in both, so the name starts at the
    // same x whether the box holds a picture or a monogram.
    const size = (html: string) =>
      head(html).match(/kb-gravity-avatar"[^>]*style="([^"]*)"/)?.[1]
    expect(size(plain)).toContain('width:22px')
    expect(size(rich)).toBe(size(plain))
  })

  it('treats a record too old to be evidence the same way', () => {
    /*
     * A worker that slept for an hour must not show LIVE badges for streams
     * that ended while it was asleep. Past the tolerance the record stops
     * asserting anything about now - and lands on the plain card, NOT on
     * OFFLINE, because we no longer know.
     */
    const stale = render(THREE_ON_LIRIK, {
      lirik: meta('lirik', { fetchedAt: Date.now() - STALE_TOLERANCE_MS - 1 }),
    })
    expect(stale).not.toContain('LIVE')
    expect(stale).not.toContain('OFFLINE')
    expect(stale).toMatch(/kb-gravity-count[^>]*>3\b/)
  })
})

describe('metadata is not the discovery algorithm', () => {
  const fiftyViewers = meta('lirik', { viewerCount: 50 })
  const fiftyThousand = meta('xqc', {
    displayName: 'xQc',
    viewerCount: 50_000,
    gameName: 'Just Chatting',
  })

  it('lets five friends on a tiny stream beat one friend on a huge one', () => {
    const html = render(
      [
        ...THREE_ON_LIRIK,
        friend('dana', 'Dana', 'lirik'),
        friend('eli', 'Eli', 'lirik'),
        friend('sarah', 'Sarah', 'xqc'),
      ],
      { lirik: fiftyViewers, xqc: fiftyThousand },
    )

    expect(html.indexOf('LIRIK')).toBeLessThan(html.indexOf('xQc'))
  })

  it('does not reorder anything when only the metadata differs', () => {
    // The map with rich metadata and the map with none must agree about
    // order. Only live-state may move a card, and neither of these is offline.
    const order = (html: string) =>
      [...html.matchAll(/class="kb-gravity-channel kb-channel">([^<]+)</g)].map((m) => m[1])

    const friends = [...THREE_ON_LIRIK, friend('sarah', 'Sarah', 'xqc')]
    expect(order(render(friends, { lirik: fiftyViewers, xqc: fiftyThousand }))).toEqual([
      'LIRIK',
      'xQc',
    ])
    expect(order(render(friends))).toEqual(['lirik', 'xqc'])
  })
})

describe('an ended stream sinks, and only an ended stream', () => {
  const map = (metadata?: Record<string, ChannelMetadata>) =>
    socialGravity(
      [
        { member: 'a', userId: 'a', presence: friend('a', 'A', 'lirik').presence },
        { member: 'b', userId: 'b', presence: friend('b', 'B', 'lirik').presence },
        { member: 'c', userId: 'c', presence: friend('c', 'C', 'lirik').presence },
        { member: 'd', userId: 'd', presence: friend('d', 'D', 'xqc').presence },
      ],
      IDLE,
      Date.now(),
      'me',
      metadata,
    ).filter((section) => section.kind === 'destination')

  it('puts the bigger cluster first when nothing is known', () => {
    expect(map().map((s) => [s.channel, s.count])).toEqual([
      ['lirik', 3],
      ['xqc', 1],
    ])
  })

  it('sinks the ended one below the live one, however many friends it has', () => {
    const sections = map({
      lirik: meta('lirik', { live: 'offline' }),
      xqc: meta('xqc'),
    })
    expect(sections.map((s) => s.channel)).toEqual(['xqc', 'lirik'])
    // Ranks follow what is on screen, so the funnel joins on the right row.
    expect(sections.map((s) => s.rank)).toEqual([1, 2])
  })

  it('leaves an unknown destination exactly where it was', () => {
    /*
     * The important half. A metadata outage produces `unknown` for everything,
     * and if that demoted anything a backend blip would silently reorder the
     * whole map underneath somebody's cursor.
     */
    const sections = map({ xqc: meta('xqc') })
    expect(sections.map((s) => s.channel)).toEqual(['lirik', 'xqc'])
  })

  it('reports live state on the section, including for HERE', () => {
    const sections = socialGravity(
      [{ member: 'a', userId: 'a', presence: friend('a', 'A', 'lirik').presence }],
      ON('LIRIK'),
      Date.now(),
      'me',
      { lirik: meta('lirik', { live: 'offline' }) },
    )
    const here = sections.find((section) => section.kind === 'here')
    // The viewer deserves to know the stream they are watching has ended, even
    // though there is nowhere for them to go.
    expect(here?.live).toBe('offline')
  })
})

describe('authoritative casing', () => {
  it('outranks everything the browser learned', () => {
    // Nobody here has ever opened lvndmark and nobody is friends with them.
    // Only metadata can spell it.
    const html = render([friend('jake', 'Jake', 'lvndmark')], {
      lvndmark: meta('lvndmark', { displayName: 'LVNDMARK' }),
    })
    expect(html).toContain('LVNDMARK')
    expect(html).not.toContain('>lvndmark<')
  })

  it('beats a page title, because it is the account record itself', () => {
    const html = renderToStaticMarkup(
      <ChannelNameProvider
        people={[]}
        seen={{ lvndmark: 'Lvndmark' }}
        metadata={{ lvndmark: meta('lvndmark', { displayName: 'LVNDMARK' }) }}
      >
        <SocialGravity
          friends={[friend('jake', 'Jake', 'lvndmark')]}
          localActivity={IDLE}
          client={stubClient()}
          cardContext={{
            selfId: 'me',
            viewerActivity: IDLE,
            friendIds: new Set(['jake']),
            outgoingRequestIds: new Set(),
          }}
          metadata={{ lvndmark: meta('lvndmark', { displayName: 'LVNDMARK' }) }}
        />
      </ChannelNameProvider>,
    )
    expect(html).toContain('LVNDMARK')
    expect(html).not.toContain('Lvndmark')
  })

  it('never lets display text become identity', () => {
    // The cluster key, the JOIN target and the analytics destination stay the
    // lowercase login however authoritative the spelling is.
    const sections = socialGravity(
      [{ member: 'a', userId: 'a', presence: friend('a', 'A', 'LVNDMARK').presence }],
      IDLE,
      Date.now(),
      'me',
      { lvndmark: meta('lvndmark', { displayName: 'LVNDMARK' }) },
    )
    expect(sections[0].channel).toBe('lvndmark')
  })
})

describe('the card survives what a creator can put in it', () => {
  it('clamps a long title and a long category to one line each', () => {
    const html = render(THREE_ON_LIRIK, {
      lirik: meta('lirik', {
        gameName: 'Dungeons and Dragons Online: Stormreach Anniversary Edition',
        title: 'day 412 of asking chat to stop backseating '.repeat(3),
      }),
    })
    expect(html).toContain('kb-gravity-title')

    for (const selector of ['.kb-gravity-title {', '.kb-gravity-game {']) {
      const rule = CSS.slice(CSS.indexOf(selector), CSS.indexOf('}', CSS.indexOf(selector)))
      expect(rule).toContain('text-overflow: ellipsis')
      expect(rule).toContain('white-space: nowrap')
    }
  })

  it('keeps the badge and the count off the flexible half', () => {
    // At 260px a long category must not push LIVE or the viewer count out of
    // the card, so the category is the only thing allowed to shrink.
    const game = CSS.slice(CSS.indexOf('.kb-gravity-game {'), CSS.indexOf('}', CSS.indexOf('.kb-gravity-game {')))
    expect(game).toContain('min-width: 0')
    const status = CSS.slice(CSS.indexOf('.kb-gravity-status {'), CSS.indexOf('}', CSS.indexOf('.kb-gravity-status {')))
    expect(status).toContain('flex: none')
    const avatar = CSS.slice(CSS.indexOf('.kb-gravity-avatar {'), CSS.indexOf('}', CSS.indexOf('.kb-gravity-avatar {')))
    expect(avatar).toContain('flex: none')
  })

  it('falls back to a monogram rather than an empty hole', () => {
    const html = render(THREE_ON_LIRIK, { lirik: meta('lirik', { profileImageUrl: null }) })

    // The slot is still there and still 22px, so the header does not move.
    expect(html).toContain('kb-gravity-avatar')
    // But there is no image, and nothing pretending to be Twitch's.
    expect(html).not.toContain('kb-avatar-img')
    expect(html).not.toContain('static-cdn.jtvnw.net')
    // A tinted initial, the same treatment every other avatar falls back to.
    expect(html).toMatch(/kb-gravity-avatar[^>]*>L</)

    expect(html).toContain('LIRIK')
    expect(html).toMatch(/kb-gravity-count[^>]*>3\b/)
  })

  it('tints the destination from the channel, never from a friend', () => {
    /*
     * A friend's avatar and the channel's avatar sit inches apart on this
     * card. Seeding the destination from the login keeps them different
     * identities: promoting a friend's picture into the streamer slot would be
     * a lie about who is streaming.
     */
    const html = render(THREE_ON_LIRIK, { lirik: meta('lirik', { profileImageUrl: null }) })
    const destination = html.slice(html.indexOf('kb-gravity-avatar'))
    const tint = destination.match(/linear-gradient\(140deg, (#[0-9a-f]{6})/)?.[1]
    const friendTint = html.slice(html.indexOf('kb-person-btn')).match(/linear-gradient\(140deg, (#[0-9a-f]{6})/)?.[1]

    expect(tint).toBeDefined()
    expect(tint).toBe(avatarTint('lirik'))
    expect(friendTint).not.toBe(tint)
  })

  it('escapes a title rather than rendering it', () => {
    // Somebody else's free text, in a page we do not control.
    const html = render(THREE_ON_LIRIK, {
      lirik: meta('lirik', { title: '<img src=x onerror=alert(1)>' }),
    })
    expect(html).not.toContain('<img src=x')
    expect(html).toContain('&lt;img')
  })
})
