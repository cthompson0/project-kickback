import { describe, expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { SocialGravity } from '../../src/ui/components/SocialGravity'
import { ChannelNameProvider } from '../../src/ui/ChannelNames'
import { getCurrentChannel } from '../../src/platforms/twitch/channels'
import { createTestLabClient } from '../../src/testlab/client'
import { person, preset } from '../../src/testlab/presets'
import { updateUser } from '../../src/testlab/world'
import type { SimUser, SimWorld } from '../../src/testlab/world'
import type { Activity } from '../../src/core/types'
import type { KickbackClient } from '../../src/client/types'

/**
 * The multi-user Gravity acceptance we could not do by hand.
 *
 * Every case here starts as SIMULATED PEOPLE and ends as MARKUP THE PANEL
 * PRODUCED. In between is production: the presence row is mapped by
 * `toPresence`, indexed by `mergePresence`, attached by `stampFriends`,
 * clustered by `socialGravity` and drawn by the real `SocialGravity`
 * component. Nothing in this file decides who is online, who clusters with
 * whom or what the card should say.
 *
 * That is the whole point. If the lab drew its own answer, five friends on one
 * channel would prove nothing about five friends on one channel.
 */

/**
 * The observer's channel, read the way production reads it.
 *
 * `useKickbackState` gets the local user's channel from `getCurrentChannel()`,
 * which parses `window.location.pathname` - and the lab puts it there. So the
 * test puts it there too, and calls the real parser, rather than asserting a
 * channel the panel was simply handed.
 */
function observerActivity(world: SimWorld): Activity {
  const path = world.observer.channel ? `/${world.observer.channel}` : '/'
  ;(globalThis as Record<string, unknown>).window = { location: { pathname: path } }
  const channel = getCurrentChannel()
  return channel ? { type: 'watching', platform: 'twitch', channel } : { type: 'idle' }
}

function lab(world: SimWorld) {
  const handle = createTestLabClient({ world, appVersion: 'test' })
  return handle
}

/** Render the production Gravity component from a simulated world. */
function render(world: SimWorld): string {
  const handle = lab(world)
  const state = handle.client.getState()
  const localActivity = observerActivity(world)

  return renderToStaticMarkup(
    <ChannelNameProvider people={state.friends.map((friend) => friend.user)} seen={state.channelNames}>
      <SocialGravity
        friends={state.friends}
        localActivity={localActivity}
        client={handle.client as KickbackClient}
        cardContext={{
          selfId: state.identity?.userId ?? null,
          viewerActivity: localActivity,
          friendIds: new Set(state.friends.map((friend) => friend.user.id)),
          outgoingRequestIds: new Set(),
        }}
      />
    </ChannelNameProvider>,
  )
}

const cards = (html: string) => (html.match(/class="kb-gravity-card/g) ?? []).length
/**
 * A gathering renders "3 friends" and a single friend renders "1", so the
 * number is read off the front of the content either way. The fact asserted is
 * the same one it always was: how many people this card says are there.
 */
const counts = (html: string) =>
  [...html.matchAll(/kb-gravity-count[^>]*>(\d+)/g)].map((match) => Number(match[1]))

describe('Gravity acceptance: one destination, N friends', () => {
  const sizes = [1, 2, 3, 5, 10]

  for (const size of sizes) {
    it(`draws ${size} friend${size === 1 ? '' : 's'} on LIRIK as one destination`, () => {
      const html = render(preset(
        size === 1 ? 'one' : size === 2 ? 'two' : size === 3 ? 'three' : size === 5 ? 'five' : 'ten',
      ).build())

      expect(cards(html)).toBe(1)
      expect(counts(html)).toEqual([size])
      expect(html).toContain('LIRIK')
    })

    it(`lists all ${size} without repeating anyone`, () => {
      const world = preset(
        size === 1 ? 'one' : size === 2 ? 'two' : size === 3 ? 'three' : size === 5 ? 'five' : 'ten',
      ).build()
      const html = render(world)

      const names = [...html.matchAll(/class="kb-cluster-name">([^<]+)</g)].map((m) => m[1])
      expect(names).toHaveLength(size)
      expect(new Set(names).size).toBe(size)
      for (const user of world.users) expect(names).toContain(user.displayName)
    })
  }

  it('earns the flame at two and keeps it, but never at one', () => {
    expect(render(preset('one').build())).not.toContain('🔥')
    for (const id of ['two', 'three', 'five', 'ten']) {
      expect(render(preset(id).build())).toContain('🔥')
    }
  })

  it('offers exactly one JOIN however many people are there', () => {
    for (const id of ['one', 'two', 'three', 'five', 'ten']) {
      const html = render(preset(id).build())
      expect((html.match(/class="kb-join/g) ?? []).length).toBe(1)
    }
  })

  it('keeps the ten-friend card wrappable rather than clipped', () => {
    // The narrow panel is 260px and ten avatars will not fit on one line.
    // The card must grow, not hide people - proven in CSS by gravityRender,
    // and here by all ten still being in the markup at all.
    const html = render(preset('ten').build())
    expect([...html.matchAll(/class="kb-cluster-name">/g)]).toHaveLength(10)
  })
})

describe('Gravity acceptance: ranking and movement', () => {
  it('puts the bigger gathering above the smaller one', () => {
    const html = render(preset('competing').build())
    expect(counts(html)).toEqual([3, 2])
    expect(html.indexOf('LIRIK')).toBeLessThan(html.indexOf('xQc'))
  })

  it('re-ranks when one person moves, without being told to', () => {
    const world = preset('competing').build()
    // Move one of LIRIK's three to xQc: 3/2 becomes 2/3.
    const moved = updateUser(world, world.users[2].id, { channel: 'xQc' })

    expect(counts(render(world))).toEqual([3, 2])
    const after = render(moved)
    expect(counts(after)).toEqual([3, 2])
    expect(after.indexOf('xQc')).toBeLessThan(after.indexOf('LIRIK'))
  })

  it('splits and re-forms a cluster', () => {
    const world = preset('two').build()
    const split = updateUser(world, world.users[1].id, { channel: 'xQc' })
    const reformed = updateUser(split, world.users[1].id, { channel: 'LIRIK' })

    expect(counts(render(world))).toEqual([2])
    expect(counts(render(split)).sort()).toEqual([1, 1])
    expect(cards(render(split))).toBe(2)
    expect(counts(render(reformed))).toEqual([2])
    expect(cards(render(reformed))).toBe(1)
  })
})

describe('Gravity acceptance: where the viewer already is', () => {
  it('becomes HERE with no JOIN, and does not count the viewer', () => {
    const html = render(preset('here').build())
    expect(html).toContain('kb-gravity-card-here')
    expect(html).toContain('HERE')
    expect(html).not.toContain('kb-join')
    expect(html).toContain('3 friends watching with you')
    expect(counts(html)).toEqual([3])
  })

  it('recognises the channel across casing, because the URL is canonical', () => {
    // The observer types LIRIK; production parses it to lirik; the friends'
    // rows say lirik. One channel, not two.
    const world = { ...preset('three').build() }
    const here: SimWorld = { ...world, observer: { ...world.observer, channel: 'LIRIK' } }
    expect(render(here)).toContain('HERE')
  })

  it('goes back to a joinable destination when the viewer leaves', () => {
    const world = preset('here').build()
    const left: SimWorld = { ...world, observer: { ...world.observer, channel: null } }
    const html = render(left)
    expect(html).not.toContain('HERE')
    expect(html).toContain('kb-join')
  })
})

describe('Gravity acceptance: privacy', () => {
  it('lets only the visible friend name the destination', () => {
    const html = render(preset('privacy').build())

    // One visible watcher on LIRIK: a destination of exactly one.
    expect(counts(html)).toEqual([1])
    expect(html).toContain('LIRIK')

    // The one hiding their activity is present but placeless.
    expect(html).toContain('Around on Twitch')
    // The invisible one reads as offline, which is the whole promise.
    expect(html).toContain('Offline')
  })

  it('puts each of the three where production says they belong', () => {
    const world = preset('privacy').build()
    const [visible, hiding, invisible] = world.users
    const html = render(world)

    const destination = html.slice(0, html.indexOf('Around on Twitch'))
    expect(destination).toContain(visible.displayName)
    expect(destination).not.toContain(hiding.displayName)
    expect(destination).not.toContain(invisible.displayName)
  })

  it('never leaks a hidden channel into the markup at all', () => {
    // Not "does not display it" - is not there. The row never carried it.
    const world: SimWorld = {
      ...preset('one').build(),
      users: [person(0, { activity: 'watching', channel: 'summit1g', visibility: 'hide_activity' })],
    }
    expect(render(world)).not.toContain('summit1g')
  })
})

describe('Gravity acceptance: casing and staleness', () => {
  it('clusters LVNDMARK with lvndmark and draws Twitch casing', () => {
    const html = render(preset('casing').build())
    expect(html).toContain('LVNDMARK')
    expect(html).not.toContain('>lvndmark<')
    // Two spellings, one cluster of two - plus the single xQc destination.
    expect(counts(html)).toEqual([2, 1])
  })

  it('drops a friend whose heartbeat stopped long enough ago', () => {
    const world = preset('stale').build()
    const html = render(world)
    // The 90-second staleness rule is production's, applied to a row whose
    // last_seen_at the lab simply stamped two minutes ago.
    expect(counts(html)).toEqual([1])
    expect(html).toContain('Offline')
  })
})

describe('the lab cannot quietly stop using production', () => {
  it('renders a destination from a world with no UI-shaped input at all', () => {
    // The world is people. If SocialGravity were bypassed, this simulated
    // person could not become a card, because nothing here builds one.
    const world: SimWorld = {
      ...preset('empty').build(),
      users: [person(0, { activity: 'watching', channel: 'shroud' }) as SimUser],
    }
    const html = render(world)
    expect(html).toContain('kb-gravity-card')
    expect(html).toContain('shroud')
  })

  it('says so honestly when there is nobody', () => {
    expect(render(preset('empty').build())).toContain('No friends yet.')
  })
})
