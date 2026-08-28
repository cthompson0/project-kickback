import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { SocialGravity } from '../../src/ui/components/SocialGravity'
import { StreamSession } from '../../src/ui/components/StreamSession'
import { ChannelNameProvider } from '../../src/ui/ChannelNames'
import { createTestLabClient } from '../../src/testlab/client'
import { PRESETS, preset } from '../../src/testlab/presets'
import { channelMetadata, roomMembers } from '../../src/testlab/world'
import type { SimWorld } from '../../src/testlab/world'
import { MAX_HOPS } from '../../src/core/streamRoom'
import type { Activity } from '../../src/core/types'
import type { KickbackClient } from '../../src/client/types'

/**
 * The graphs two Twitch accounts cannot build.
 *
 * An automatic Stream Room is the connected component of the friendship graph
 * among people present on a destination, so proving it needs friendships
 * BETWEEN other people - which no amount of manual testing with two accounts
 * can produce. This is what the lab is for.
 *
 * The lab computes the component itself, which is the one place it duplicates
 * production. It has to: the real one is SQL inside Postgres. What keeps it
 * honest is the last describe block, which reads the SQL and asserts the two
 * agree on every rule that matters.
 */

const MIGRATION = readFileSync(
  join(process.cwd(), 'supabase', 'migrations', '0020_stream_rooms.sql'),
  'utf8',
)

const members = (world: SimWorld) => roomMembers(world, Date.now())
const ids = (world: SimWorld) => members(world).map((member) => member.userId)

function localActivity(world: SimWorld): Activity {
  return world.observer.channel
    ? { type: 'watching', platform: 'twitch', channel: world.observer.channel.toLowerCase() }
    : { type: 'idle' }
}

function draw(world: SimWorld): string {
  const handle = createTestLabClient({ world, appVersion: 'test' })
  const state = handle.client.getState()
  const local = localActivity(world)

  return renderToStaticMarkup(
    <ChannelNameProvider people={state.friends.map((f) => f.user)} seen={state.channelNames}>
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
        metadata={channelMetadata(world, Date.now())}
        reactions={state.togetherReactions}
        roomMessages={state.roomMessages}
        mutedUserIds={state.mutedUserIds}
      />
    </ChannelNameProvider>,
  )
}

/** The room itself, once the viewer has walked into it. */
function drawRoom(world: SimWorld): string {
  const handle = createTestLabClient({ world, appVersion: 'test' })
  const state = handle.client.getState()
  const local = localActivity(world)
  const channel = world.observer.channel!.toLowerCase()

  return renderToStaticMarkup(
    <ChannelNameProvider people={state.friends.map((f) => f.user)} seen={state.channelNames}>
      <StreamSession
        channel={channel}
        members={state.roomMembers[channel] ?? []}
        friends={state.friends}
        reactions={state.togetherReactions}
        messages={state.roomMessages}
        mutedUserIds={state.mutedUserIds}
        peers={state.roomPeers[channel] ?? []}
        metadata={channelMetadata(world, Date.now())[channel]}
        selfId={state.identity?.userId ?? null}
        client={handle.client as KickbackClient}
        cardContext={{
          selfId: state.identity?.userId ?? null,
          viewerActivity: local,
          friendIds: new Set(state.friends.map((f) => f.user.id)),
          outgoingRequestIds: new Set(),
        }}
      />
    </ChannelNameProvider>,
  )
}

// ------------------------------------------------------- the graph scenarios

describe('A ↔ B: the smallest room', () => {
  it('is the viewer and one direct friend', () => {
    const world = preset('room-ab').build()
    expect(members(world)).toEqual([{ userId: 'sim-b', hops: 1, viaUserId: null }])
  })
})

describe('A ↔ B ↔ C: a friend of a friend is in the room', () => {
  const world = preset('room-abc').build()

  it('includes somebody the viewer is not friends with', () => {
    /*
     * The correction this whole checkpoint exists for. Under the old
     * direct-friend rule C was invisible to A, and A, B and C each had a
     * different idea of who was "together".
     */
    expect(ids(world)).toEqual(['sim-b', 'sim-c'])
  })

  it('reports how far away they are, and who connects them', () => {
    const [direct, distant] = members(world)
    expect(direct).toEqual({ userId: 'sim-b', hops: 1, viaUserId: null })
    expect(distant.hops).toBe(2)
    expect(distant.viaUserId).toBe('sim-b')
  })

  it('offers nothing permanent on the card', () => {
    // The contextual streamer tab is the way in; the card carries the live
    // social signal and nothing else.
    const html = draw(world)
    expect(html).not.toContain('kb-together-open')
    expect(html).not.toContain('kb-room-person')
  })

  it('names the friend-of-friend once the viewer walks in', () => {
    /*
     * Sarah is Bianca's friend, not the viewer's. Presence never mentions her,
     * so everything the panel can say about her comes from room membership -
     * her name, and the one hop of context that makes it mean anything.
     */
    const html = drawRoom(world)
    // You, Bianca and the person reached through her.
    expect(html).toContain('WATCHING TOGETHER · 3')
    expect(html).toContain('Bianca')
    // The two-hop person has no presence, so the panel can only name them from
    // room membership - which it does, with a neutral mark rather than an
    // invented avatar. The "Friend of" line is behind the roster toggle.
    expect(html).toContain('kb-room-unknown')
  })
})

describe('A ↔ B ↔ C ↔ D: three hops, and no further', () => {
  const world = preset('room-abcd').build()

  it('reaches everybody on the chain', () => {
    expect(ids(world)).toEqual(['sim-b', 'sim-c', 'sim-d'])
  })

  it('stops at the hop limit', () => {
    const hops = members(world).map((member) => member.hops)
    expect(hops).toEqual([1, 2, 3])
    expect(Math.max(...hops)).toBeLessThanOrEqual(MAX_HOPS)
  })

  it('says nothing about who connects somebody three hops away', () => {
    // One hop of context makes a person legible. Two would be graph detail.
    expect(members(world)[2].viaUserId).toBeNull()
  })
})

describe('two disconnected clusters on one destination', () => {
  const world = preset('room-split-graphs').build()

  it('gives the viewer only their own', () => {
    /*
     * Channel is context; friendship is authorization. Dana and Eli are on the
     * same stream and know each other, and neither of them knows the viewer.
     */
    expect(ids(world)).toEqual(['sim-b'])
  })

  it('leaves the other cluster out of the panel entirely', () => {
    const html = draw(world)
    expect(html).toContain('1 friend watching with you')
    expect(html).not.toContain('Dana')
    expect(html).not.toContain('Eli')
  })
})

describe('the bridge leaves, and the room splits', () => {
  it('loses everybody who was only reachable through them', () => {
    /*
     * A ↔ B ↔ C ↔ D with B on another stream. C and D are still each other's
     * room; they are simply not the viewer's any more. No merge event, no
     * split event - recomputation is what a split IS.
     */
    const world = preset('room-bridge-gone').build()
    expect(members(world)).toEqual([])
  })

  it('draws no doorway at all once nobody is reachable', () => {
    const world = preset('room-bridge-gone').build()
    expect(draw(world)).not.toContain('kb-together')
  })
})

describe('a new friendship merges two clusters', () => {
  it('makes one room of everybody', () => {
    // The same two clusters as above, now bridged. Nothing was created; the
    // answer to the same question simply changed.
    const world = preset('room-merged').build()
    expect(ids(world)).toEqual(['sim-b', 'sim-d', 'sim-e'])
  })

  it('is a strict superset of the unmerged answer', () => {
    const before = ids(preset('room-split-graphs').build())
    const after = ids(preset('room-merged').build())
    for (const id of before) expect(after).toContain(id)
    expect(after.length).toBeGreaterThan(before.length)
  })
})

describe('an unrelated stranger on the same stream', () => {
  it('is not in the room', () => {
    const world = preset('room-stranger').build()
    expect(ids(world)).toEqual(['sim-b'])
  })

  it('never appears in the panel', () => {
    const world = preset('room-stranger').build()
    const stranger = world.users.find((user) => user.relationship === 'stranger')
    expect(stranger).toBeDefined()
    expect(draw(world)).not.toContain(stranger!.displayName)
  })
})

describe('contextual visibility ends when they leave', () => {
  it('drops a friend-of-friend who moved to another stream', () => {
    /*
     * The room grants contextual visibility, not presence visibility. The
     * moment C is not here, the viewer learns nothing further about them.
     */
    const world = preset('room-fof-left').build()
    // Bianca is still here and still a direct friend; only the person reached
    // THROUGH her has gone, and with them everything the viewer knew of them.
    expect(ids(world)).toEqual(['sim-b'])
    expect(members(world).every((member) => member.hops === 1)).toBe(true)
  })
})

describe('the bounds hold', () => {
  it('never walks past three hops, however long the chain', () => {
    const world = preset('room-ten').build()
    const hops = members(world).map((member) => member.hops)
    expect(Math.max(...hops)).toBe(MAX_HOPS)
    // Nine people in a chain, three reachable.
    expect(members(world)).toHaveLength(3)
  })

  it('drops somebody who went quiet, like everything else does', () => {
    const world: SimWorld = {
      ...preset('room-ab').build(),
      users: [{ ...preset('room-ab').build().users[0], staleForMs: 120_000 }],
    }
    expect(members(world)).toEqual([])
  })

  it('leaves somebody hiding their activity out of the walk', () => {
    // Presence is redacted at write time, so they have no channel to be on.
    const base = preset('room-ab').build()
    const world: SimWorld = {
      ...base,
      users: [{ ...base.users[0], visibility: 'hide_activity' }],
    }
    expect(members(world)).toEqual([])
  })

  it('is empty when the viewer is not on a channel', () => {
    const base = preset('room-ab').build()
    expect(roomMembers({ ...base, observer: { ...base.observer, channel: null } }, Date.now())).toEqual([])
  })
})

// ------------------------------------------------------------- reactions

describe('reactions in the lab', () => {
  it('shows one a friend sent', () => {
    const world = preset('room-ab').build()
    const handle = createTestLabClient({ world, appVersion: 'test' })
    handle.react(world.users[0].id, 'lol')
    expect(handle.client.getState().togetherReactions).toHaveLength(1)
  })

  it('is symmetric: the viewer sees their own by the same route', () => {
    /*
     * Production never draws the sender's own reaction optimistically - it
     * comes back through the same inbox as everyone else's - so the lab uses
     * the same buffer. One way for a reaction to appear.
     */
    const world = preset('room-ab').build()
    const handle = createTestLabClient({ world, appVersion: 'test' })

    handle.react(world.users[0].id, 'lol')
    handle.client.sendReaction('lol')

    const reactions = handle.client.getState().togetherReactions
    expect(reactions).toHaveLength(2)
    expect(new Set(reactions.map((entry) => entry.senderId)).size).toBe(2)
  })

  it('forms a combo when different people agree', () => {
    const world = preset('room-abc').build()
    const handle = createTestLabClient({ world, appVersion: 'test' })
    handle.react(world.users[0].id, 'lol')
    handle.client.sendReaction('lol')

    const state = handle.client.getState()
    const html = renderToStaticMarkup(
      <ChannelNameProvider people={[]} seen={{}}>
        <SocialGravity
          friends={state.friends}
          localActivity={localActivity(world)}
          client={handle.client as KickbackClient}
          cardContext={{
            selfId: state.identity?.userId ?? null,
            viewerActivity: localActivity(world),
            friendIds: new Set(),
            outgoingRequestIds: new Set(),
          }}
          metadata={channelMetadata(world, Date.now())}
          reactions={state.togetherReactions}
          roomMessages={state.roomMessages}
          mutedUserIds={state.mutedUserIds}
          />
      </ChannelNameProvider>,
    )
    // On the card's status line, beside LIVE - not on the left where it would
    // compete with the destination and the friends.
    expect(html).toContain('×2')
    expect((html.match(/kb-gravity-combo/g) ?? []).length).toBe(1)
  })

  it('shows the room the same combo the card outside is showing', () => {
    /*
     * One combo semantic model, asserted across the seam.
     *
     * Both surfaces call roomActivity, so walking in continues the run rather
     * than restarting or contradicting it.
     */
    const world = preset('room-abc').build()
    const handle = createTestLabClient({ world, appVersion: 'test' })
    handle.react(world.users[0].id, 'fire')
    handle.client.sendReaction('fire')

    const inside = renderToStaticMarkup(
      <ChannelNameProvider people={[]} seen={{}}>
        <StreamSession
          channel="lirik"
          members={handle.client.getState().roomMembers['lirik'] ?? []}
          friends={handle.client.getState().friends}
          reactions={handle.client.getState().togetherReactions}
          messages={handle.client.getState().roomMessages}
          mutedUserIds={handle.client.getState().mutedUserIds}
          peers={handle.client.getState().roomPeers['lirik'] ?? []}
          selfId={handle.client.getState().identity?.userId ?? null}
          client={handle.client as KickbackClient}
          cardContext={{
            selfId: handle.client.getState().identity?.userId ?? null,
            viewerActivity: localActivity(world),
            friendIds: new Set(),
            outgoingRequestIds: new Set(),
          }}
        />
      </ChannelNameProvider>,
    )
    expect(inside).toContain('×2')
    expect((inside.match(/class="kb-combo-active"/g) ?? []).length).toBe(1)
  })

  it('has no combo breaker to fire, because a room has no ordinary messages', () => {
    /*
     * Stated rather than left to be discovered.
     *
     * A breaker is an ordinary message interrupting a run, and a v1 room has
     * no text in it - so the rule is preserved in scanCombos and simply has
     * nothing to fire on. It is not missing, and nothing here should invent a
     * second way to end a run.
     */
    const world = preset('room-abc').build()
    const handle = createTestLabClient({ world, appVersion: 'test' })
    handle.react(world.users[0].id, 'lol')
    handle.client.sendReaction('lol')
    // A DIFFERENT emote starts its own run rather than breaking this one.
    handle.react(world.users[0].id, 'sad')

    const inside = renderToStaticMarkup(
      <ChannelNameProvider people={[]} seen={{}}>
        <StreamSession
          channel="lirik"
          members={handle.client.getState().roomMembers['lirik'] ?? []}
          friends={handle.client.getState().friends}
          reactions={handle.client.getState().togetherReactions}
          messages={handle.client.getState().roomMessages}
          mutedUserIds={handle.client.getState().mutedUserIds}
          peers={handle.client.getState().roomPeers['lirik'] ?? []}
          selfId={handle.client.getState().identity?.userId ?? null}
          client={handle.client as KickbackClient}
          cardContext={{
            selfId: handle.client.getState().identity?.userId ?? null,
            viewerActivity: localActivity(world),
            friendIds: new Set(),
            outgoingRequestIds: new Set(),
          }}
        />
      </ChannelNameProvider>,
    )
    /*
     * The trailing run is one person on 'sad', which is not a combo - so the
     * session shows nothing above the composer. A lone emote is a thing one
     * person did, and the conversation already carries it.
     */
    expect(inside).not.toContain('kb-combo-active')
    expect(inside).not.toMatch(/broke|breaker/i)
  })

  it('holds no reactions when the viewer is not on a channel', () => {
    const world = preset('two').build()
    const handle = createTestLabClient({ world, appVersion: 'test' })
    handle.react(world.users[0].id, 'lol')
    expect(handle.client.getState().togetherReactions).toEqual([])
  })
})

// ------------------------------------------------- rooms need a live stream

describe('a room does NOT require something to watch', () => {
  /*
   * The rule that was right once and then wrong.
   *
   * Requiring an authoritative LIVE status before a room could form fixed a
   * real bug - two people on an offline channel being reported as watching
   * together, with an open shared-watch interval behind it. It also meant a
   * stream ending ended the conversation happening around it, which is exactly
   * backwards: the stream stops and everybody is still sitting there, which is
   * when there is most to say.
   *
   * So live status decides the LABEL and the ANALYTICS, and people decide the
   * room. These are the same worlds as before, asserted the other way round.
   */

  it('forms on a channel whose stream has ended', () => {
    const world = preset('room-offline').build()
    expect(members(world)).toEqual([{ userId: 'sim-b', hops: 1, viaUserId: null }])
  })

  it('still says OFFLINE while the session carries on', () => {
    // The label is not hidden and never was; it simply no longer decides
    // whether people are allowed to talk.
    const html = draw(preset('room-offline').build())
    expect(html).toContain('1 friend watching with you')
    expect(html).toContain('Bianca')
    expect(html).toContain('OFFLINE')
  })

  it('forms even when Twitch has not answered', () => {
    /*
     * Uncertainty used to be treated as "not live" and therefore as "no room".
     * That made every session hostage to a metadata refresh - which is how a
     * viewer could see a friend on their HERE card and be offered nowhere to
     * go. Metadata now enriches; it does not gate.
     */
    expect(members(preset('room-unknown').build())).toHaveLength(1)
  })

  it('survives a live stream ending, with the people unchanged', () => {
    const live = preset('room-went-live').build()
    const ended: SimWorld = { ...live, metadata: { lirik: { live: 'offline', displayName: 'LIRIK' } } }

    expect(members(live)).toHaveLength(1)
    expect(members(ended)).toHaveLength(1)
    expect(draw(ended)).toContain('1 friend watching with you')
  })

  it('still ends when the PEOPLE go, which is the thing that matters', () => {
    // A session is people at a destination. Take the people away and there is
    // nothing left, whatever the broadcaster is doing.
    expect(members(preset('room-bridge-gone').build())).toEqual([])
  })
})

// -------------------------------------------- the lab agrees with the server

describe("the lab's component matches the SQL it stands in for", () => {
  /*
   * The lab computes membership because production computes it in Postgres,
   * which the lab has no access to. That is a duplicate, and this is what
   * keeps it from drifting: every rule is asserted on both sides.
   */

  it('walks the same number of hops', () => {
    expect(MIGRATION).toContain('w.hops < 3')
    expect(MAX_HOPS).toBe(3)
  })

  it('bounds the room the same way', () => {
    expect(MIGRATION).toContain('limit 50')
    const lab = readFileSync(join(process.cwd(), 'src', 'testlab', 'world.ts'), 'utf8')
    expect(lab).toContain('MAX_MEMBERS')
  })

  it('uses the same staleness window', () => {
    expect(MIGRATION).toContain(`interval '90 seconds'`)
    const lab = readFileSync(join(process.cwd(), 'src', 'testlab', 'world.ts'), 'utf8')
    expect(lab).toContain('90_000')
  })

  it('requires the viewer to be present on both sides', () => {
    expect(MIGRATION).toContain('The caller must actually be there')
    const lab = readFileSync(join(process.cwd(), 'src', 'testlab', 'world.ts'), 'utf8')
    expect(lab).toContain('if (!here) return []')
  })

  it('carries the connecting friend only at two hops on both sides', () => {
    expect(MIGRATION).toContain('case when w.hops = 0 then f.friend_id else w.via end')
    const lab = readFileSync(join(process.cwd(), 'src', 'testlab', 'world.ts'), 'utf8')
    expect(lab).toContain('hops === 2')
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
      expect(text, path).not.toContain('createStreamRoom')
      // stream_room_members is named in world.ts's own comment, explaining what
      // it stands in for - so what is asserted is that nothing CALLS it.
      expect(text, path).not.toContain('rpc(')
      expect(text, path).not.toContain('send_together_reaction')
      expect(text, path).not.toContain('send_room_message')
      expect(text, path).not.toContain('consume_rate_budget')
    }
  })

  it('keeps every preset deterministic', () => {
    for (const entry of PRESETS) expect(entry.build()).toEqual(entry.build())
  })
})
