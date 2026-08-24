import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { SocialGravity } from '../../src/ui/components/SocialGravity'
import { ChannelNameProvider } from '../../src/ui/ChannelNames'
import { createTestLabClient } from '../../src/testlab/client'
import { PRESETS, preset } from '../../src/testlab/presets'
import type { SimWorld } from '../../src/testlab/world'
import type { Activity } from '../../src/core/types'
import type { KickbackClient } from '../../src/client/types'

/**
 * Automatic Together in the Test Lab.
 *
 * The lab supplies reactions at the same boundary production reads them from -
 * `KickbackState.togetherReactions` - and does nothing else. It holds no
 * subscription, no row policy, no rate limit and no sweep, because those
 * belong to the service and a copy of them here would prove nothing about the
 * original.
 */

function localActivity(world: SimWorld): Activity {
  return world.observer.channel
    ? { type: 'watching', platform: 'twitch', channel: world.observer.channel.toLowerCase() }
    : { type: 'idle' }
}

function lab(world: SimWorld) {
  return createTestLabClient({ world, appVersion: 'test' })
}

function draw(handle: ReturnType<typeof lab>, world: SimWorld): string {
  const state = handle.client.getState()
  const local = localActivity(world)

  return renderToStaticMarkup(
    <ChannelNameProvider
      people={state.friends.map((f) => f.user)}
      seen={state.channelNames}
      metadata={state.channelMetadata}
    >
      <SocialGravity
        friends={state.friends}
        localActivity={local}
        client={handle.client as KickbackClient}
        cardContext={{
          selfId: state.identity?.userId ?? null,
          viewerActivity: local,
          friendIds: new Set(state.friends.map((f) => f.user.id)),
          outgoingRequestIds: new Set(),
        }}
        metadata={state.channelMetadata}
        reactions={state.togetherReactions}
      />
    </ChannelNameProvider>,
  )
}

describe('the lab can form a Together without a second Twitch account', () => {
  for (const [id, friends] of [
    ['together-1', 1],
    ['together-2', 2],
    ['together-5', 5],
    ['together-10', 10],
  ] as const) {
    it(`shows ${friends} friend${friends === 1 ? '' : 's'} watching with you`, () => {
      const world = preset(id).build()
      const html = draw(lab(world), world)

      expect(html).toContain('kb-gravity-card-here')
      expect(html).toContain(
        friends === 1 ? '1 friend watching with you' : `${friends} friends watching with you`,
      )
      expect(html).toContain('kb-together')
      expect(html).not.toContain('kb-join')
      // Everyone is named, once.
      const names = [...html.matchAll(/class="kb-cluster-name">([^<]+)</g)].map((m) => m[1])
      expect(new Set(names).size).toBe(friends)
    })
  }

  it('shows no Together when the viewer is somewhere their friends are not', () => {
    const world = preset('together-alone').build()
    const html = draw(lab(world), world)
    expect(html).not.toContain('kb-together')
    // The friends are still on the map, as destinations to go to.
    expect(html).toContain('kb-join')
  })
})

describe('arrival and departure need no messages', () => {
  it('adds somebody who moves onto the channel', () => {
    const world = preset('together-1').build()
    const handle = lab(world)
    expect(draw(handle, world)).toContain('1 friend watching with you')

    // A second friend arrives - by presence, not by being invited.
    const arrived: SimWorld = {
      ...world,
      users: [...world.users, { ...world.users[0], id: 'sim-c', displayName: 'Chuck' }],
    }
    handle.setWorld(arrived)
    const html = draw(handle, arrived)
    expect(html).toContain('2 friends watching with you')
    expect(html).toContain('Chuck')
  })

  it('removes somebody who leaves, and dissolves when the last one goes', () => {
    const world = preset('together-2').build()
    const handle = lab(world)

    const oneLeft: SimWorld = { ...world, users: [world.users[0]] }
    handle.setWorld(oneLeft)
    expect(draw(handle, oneLeft)).toContain('1 friend watching with you')

    const noneLeft: SimWorld = { ...world, users: [] }
    handle.setWorld(noneLeft)
    expect(draw(handle, noneLeft)).not.toContain('kb-together')
  })
})

describe('reactions in the lab', () => {
  it('shows one a friend sent', () => {
    const world = preset('together-2').build()
    const handle = lab(world)

    handle.react(world.users[0].id, '😂')
    expect(draw(handle, world)).toContain('kb-together-burst')
  })

  it('forms a combo when different people agree', () => {
    const world = preset('together-2').build()
    const handle = lab(world)

    handle.react(world.users[0].id, '😂')
    handle.react(world.users[1].id, '😂')

    const html = draw(handle, world)
    expect(html).toContain('kb-together-combo')
    expect(html).toContain('×2')
  })

  it('does not turn one person hammering a button into a combo', () => {
    const world = preset('together-2').build()
    const handle = lab(world)
    for (let i = 0; i < 5; i += 1) handle.react(world.users[0].id, '🔥')

    expect(draw(handle, world)).not.toContain('kb-together-count')
  })

  it('shows the viewer their own reaction the same way as everyone else’s', () => {
    // Production never draws it optimistically; it comes back through realtime.
    // The lab uses the same buffer, so there is one way for one to appear.
    const world = preset('together-2').build()
    const handle = lab(world)
    handle.client.sendReaction('👀')

    expect(draw(handle, world)).toContain('kb-together-burst')
  })

  it('holds no reactions when the viewer is not on a channel', () => {
    const world = preset('two').build()
    const handle = lab(world)
    handle.react(world.users[0].id, '😂')
    expect(handle.client.getState().togetherReactions).toEqual([])
  })
})

describe('competing social graphs on one channel', () => {
  it('shows only the viewer’s own friends', () => {
    /*
     * Four people on LIRIK: two of the viewer's friends and two strangers.
     * Channel is context; friendship is authorization. The strangers are on
     * the same stream and are not part of this.
     */
    const world = preset('together-graphs').build()
    const handle = lab(world)
    const html = draw(handle, world)

    expect(html).toContain('2 friends watching with you')

    const friends = world.users.filter((user) => user.relationship === 'friend')
    const strangers = world.users.filter((user) => user.relationship === 'stranger')
    expect(strangers.length).toBeGreaterThan(0)

    for (const person of friends) expect(html).toContain(person.displayName)
    for (const person of strangers) expect(html).not.toContain(person.displayName)
  })

  it('gives a stranger no presence at all, so nothing to react with', () => {
    // The lab produces presence only for friends, which is the same thing RLS
    // does on the server: a stranger's row never arrives.
    const world = preset('together-graphs').build()
    const state = lab(world).client.getState()
    const ids = new Set(state.friends.map((friend) => friend.user.id))
    for (const stranger of world.users.filter((u) => u.relationship === 'stranger')) {
      expect(ids.has(stranger.id)).toBe(false)
    }
  })
})

describe('privacy and staleness apply, unchanged', () => {
  it('leaves out a friend who is hiding, and one who is invisible', () => {
    const world = preset('together-privacy').build()
    const html = draw(lab(world), world)
    // Three friends on the channel; one visible.
    expect(html).toContain('1 friend watching with you')
  })

  it('loses a friend whose client went quiet', () => {
    const world = preset('together-stale').build()
    const html = draw(lab(world), world)
    expect(html).toContain('1 friend watching with you')
  })
})

describe('the lab still calls nothing', () => {
  function sourcesUnder(dir: string): string[] {
    return readdirSync(dir).flatMap((entry) => {
      const path = join(dir, entry)
      if (statSync(path).isDirectory()) return sourcesUnder(path)
      return /\.tsx?$/.test(entry) ? [path] : []
    })
  }

  const labSources = sourcesUnder(join(process.cwd(), 'src', 'testlab')).map((path) => ({
    path,
    text: readFileSync(path, 'utf8'),
  }))

  it('holds no subscription, no rate limit and no policy of its own', () => {
    for (const { path, text } of labSources) {
      expect(text, path).not.toContain('createTogetherReactions')
      expect(text, path).not.toContain('send_together_reaction')
      expect(text, path).not.toContain('together_reactions')
      expect(text, path).not.toContain('consume_rate_budget')
    }
  })

  it('keeps every preset deterministic', () => {
    for (const entry of PRESETS) expect(entry.build()).toEqual(entry.build())
  })
})
