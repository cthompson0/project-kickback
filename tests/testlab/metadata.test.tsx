import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { SocialGravity } from '../../src/ui/components/SocialGravity'
import { ChannelNameProvider } from '../../src/ui/ChannelNames'
import { createTestLabClient } from '../../src/testlab/client'
import { PRESETS, preset } from '../../src/testlab/presets'
import { channelMetadata } from '../../src/testlab/world'
import type { SimWorld } from '../../src/testlab/world'
import type { Activity } from '../../src/core/types'
import type { KickbackClient } from '../../src/client/types'

/**
 * Metadata states in the Test Lab.
 *
 * The lab supplies metadata at exactly the boundary production reads it from -
 * `KickbackState.channelMetadata` - and does nothing else. It has no token, no
 * Helix parsing, no cache and no batching, because those belong to the service
 * and a copy of them would prove nothing about the original.
 *
 * What these tests defend is that the lab can reach every UI state, and that
 * it still cannot reach the network.
 */

function localActivity(world: SimWorld): Activity {
  return world.observer.channel
    ? { type: 'watching', platform: 'twitch', channel: world.observer.channel.toLowerCase() }
    : { type: 'idle' }
}

function render(world: SimWorld): string {
  const handle = createTestLabClient({ world, appVersion: 'test' })
  const state = handle.client.getState()
  const local = localActivity(world)

  return renderToStaticMarkup(
    <ChannelNameProvider
      people={state.friends.map((friend) => friend.user)}
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
          friendIds: new Set(state.friends.map((friend) => friend.user.id)),
          outgoingRequestIds: new Set(),
        }}
        metadata={state.channelMetadata}
      />
    </ChannelNameProvider>,
  )
}

const channels = (html: string) =>
  [...html.matchAll(/class="kb-gravity-channel kb-channel">([^<]+)</g)].map((m) => m[1])

describe('the lab reaches every metadata state', () => {
  it('draws a live creator in full', () => {
    const html = render(preset('meta-live').build())
    expect(html).toContain('LIRIK')
    expect(html).toContain('LIVE')
    expect(html).toContain('Escape from Tarkov')
    expect(html).toContain('late night wipe grind')
    expect(html).toContain('18K')
    expect(html).toContain('kb-gravity-avatar')
    // And still leads with the friends.
    expect(html).toMatch(/kb-gravity-count[^>]*>3</)
  })

  it('marks an ended stream and sinks it below a live one', () => {
    const html = render(preset('meta-offline').build())
    expect(html).toContain('OFFLINE')
    expect(html).toContain('kb-gravity-card-offline')
    // xQc has one friend, LIRIK has three - and xQc is still first, because
    // LIRIK has stopped streaming.
    expect(channels(html)).toEqual(['xQc', 'LIRIK'])
  })

  it('makes an unavailable answer look exactly like no answer', () => {
    /*
     * A backend outage, a cold cache and a channel nobody has asked about are
     * one state as far as the panel is concerned, and the lab must not be able
     * to invent a fourth that production cannot produce.
     */
    const unavailable = render(preset('meta-unavailable').build())
    const nothing = render(preset('three').build())
    expect(unavailable).toBe(nothing)
    expect(unavailable).not.toContain('OFFLINE')
    expect(unavailable).not.toContain('LIVE')
  })

  it('demotes only the ended one, never the unknown one', () => {
    // LIRIK 4 offline, xQc 2 live, shroud 1 with no metadata at all.
    const html = render(preset('meta-mixed').build())
    expect(channels(html)).toEqual(['xQc', 'shroud', 'LIRIK'])
  })

  it('spells a channel nobody here has ever opened', () => {
    // No friend is LVNDMARK and no page title was read. Only metadata can do
    // this, which is what makes it the authoritative source.
    const html = render(preset('meta-casing').build())
    expect(html).toContain('LVNDMARK')
    expect(html).not.toContain('>lvndmark<')
  })

  it('survives a long title and a long category', () => {
    const html = render(preset('meta-long').build())
    expect(html).toContain('kb-gravity-title')
    // Still one card, still a JOIN, still the count.
    expect((html.match(/class="kb-gravity-card/g) ?? []).length).toBe(1)
    expect(html).toContain('kb-join')
  })

  it('drops the avatar rather than the card', () => {
    const html = render(preset('meta-no-avatar').build())
    // LIRIK has no image at all; xQc has one that will fail to load, which is
    // an onError path the markup cannot show - so what is asserted here is
    // that neither breaks the head.
    expect(html).toContain('LIRIK')
    expect(html).toContain('xQc')
    expect(html).toMatch(/kb-gravity-count[^>]*>2</)
  })

  it('tells the viewer the stream they are on has ended', () => {
    const html = render(preset('meta-here').build())
    expect(html).toContain('kb-gravity-card-here')
    expect(html).toContain('OFFLINE')
    expect(html).toContain('3 friends watching with you')
    // Still nowhere to go.
    expect(html).not.toContain('kb-join')
  })
})

describe('the simulated metadata is production-shaped', () => {
  const NOW = 1_700_000_000_000

  it('refuses a display name that is a different word', () => {
    const world: SimWorld = {
      ...preset('one').build(),
      metadata: { lirik: { live: 'live', displayName: 'SomebodyElse' } },
    }
    expect(channelMetadata(world, NOW).lirik.displayName).toBeNull()
  })

  it('carries nothing from a stream that is not happening', () => {
    const world: SimWorld = {
      ...preset('one').build(),
      metadata: {
        lirik: { live: 'offline', gameName: 'Tarkov', title: 'x', viewerCount: 100 },
      },
    }
    const record = channelMetadata(world, NOW).lirik
    expect(record.gameName).toBeNull()
    expect(record.title).toBeNull()
    expect(record.viewerCount).toBeNull()
  })

  it('models unavailable as absence, because that is what production has', () => {
    const world: SimWorld = {
      ...preset('one').build(),
      metadata: { lirik: { live: 'unavailable' } },
    }
    expect(channelMetadata(world, NOW)).toEqual({})
  })

  it('stamps records as current, so the freshness rule believes them', () => {
    const world: SimWorld = {
      ...preset('one').build(),
      metadata: { lirik: { live: 'live' } },
    }
    expect(channelMetadata(world, NOW).lirik.fetchedAt).toBe(NOW)
  })

  it('keeps every preset deterministic', () => {
    for (const entry of PRESETS) expect(entry.build()).toEqual(entry.build())
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

  it('never mentions Twitch or the metadata service', () => {
    for (const { path, text } of labSources) {
      expect(text, path).not.toContain('api.twitch.tv')
      expect(text, path).not.toContain('id.twitch.tv')
      expect(text, path).not.toContain('createMetadataService')
      expect(text, path).not.toContain('twitch-metadata')
    }
  })

  it('uses a data URI for the stand-in avatar, so there is no request', () => {
    // A real CDN URL would simply fail to load in a lab with no network,
    // leaving the avatar slot untested. A data: URI is not a request at all.
    const world = preset('meta-live').build()
    const record = channelMetadata(world, 1_700_000_000_000).lirik
    expect(record.profileImageUrl?.startsWith('data:image/svg+xml,')).toBe(true)
  })

  it('produces no metadata without being told to', () => {
    // Every preset that does not set metadata must produce none, so the plain
    // card stays the default the lab opens on.
    for (const entry of PRESETS) {
      const world = entry.build()
      if (world.metadata) continue
      expect(channelMetadata(world, 1_700_000_000_000)).toEqual({})
    }
  })
})
