import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { RETENTION_MS, liveMessages } from '../../src/core/roomMessages'
import type { RoomMessage } from '../../src/core/roomMessages'

/**
 * The Stream Room lifecycle, now permanent.
 *
 * WHAT THIS FILE USED TO BE
 *
 * Patch 1 added one extra condition to `sessionAvailable` so that a readable
 * conversation did not vanish the moment the last peer left - beta finding
 * #10 - and labelled it TEMPORARY, to be removed by the multi-destination
 * room lifecycle. This file guarded that label, so the throwaway could not
 * quietly become architecture.
 *
 * 0025 Part 2 removed it, which is what the guard was waiting for. So the
 * assertions have inverted: the marker must now be GONE, and the lifecycle it
 * described must be the real one.
 *
 * The behavioural tests are unchanged in substance, because the BEHAVIOUR was
 * always the right behaviour - only its status changed. What is new is that
 * availability is evaluated per channel, so a viewer with two streams open has
 * two independent answers.
 */

const NOW = 1_700_000_000_000

function message(at: number, channel = 'summit1g'): RoomMessage {
  return { id: `m-${at}-${channel}`, senderId: 'them', channel, body: 'still here?', at, receivedAt: at }
}

/**
 * The condition as the panel evaluates it, for ONE channel.
 *
 * Mirrored rather than imported because KickbackPanel is a whole shell with a
 * client, a layout and an analytics provider behind it, and what is being
 * tested is one boolean. The mirror is kept honest by the source guards below.
 */
function sessionAvailable(input: {
  channel: string | null
  peers: Record<string, string[]>
  members: Record<string, unknown[]>
  messages: RoomMessage[]
}): boolean {
  const { channel } = input
  if (channel === null) return false
  const peers = input.peers[channel] ?? []
  const members = input.members[channel] ?? []
  const retained = input.messages.some((entry) => entry.channel === channel)
  return peers.length > 0 || members.length > 0 || retained
}

describe('a room is available on presence OR on its own conversation', () => {
  it('is available while somebody else is here', () => {
    expect(
      sessionAvailable({ channel: 'summit1g', peers: { summit1g: ['a'] }, members: {}, messages: [] }),
    ).toBe(true)
  })

  it('is available on server membership alone', () => {
    expect(
      sessionAvailable({ channel: 'summit1g', peers: {}, members: { summit1g: [{}, {}] }, messages: [] }),
    ).toBe(true)
  })

  /** Finding #10, now permanently fixed rather than temporarily relieved. */
  it('stays available when the last peer leaves but the conversation is still there', () => {
    expect(
      sessionAvailable({
        channel: 'summit1g',
        peers: {},
        members: {},
        messages: [message(NOW - 60_000)],
      }),
    ).toBe(true)
  })

  it('goes away once the conversation has expired', () => {
    /*
     * Not a second clock. The worker prunes its buffer to RETENTION_MS, so an
     * expired message is not in `messages` at all by the time the panel looks
     * - which is why this is not a lease and introduces no new lifetime.
     */
    const pruned = liveMessages([message(NOW - RETENTION_MS - 1)], 'summit1g', NOW)
    expect(pruned).toHaveLength(0)
    expect(sessionAvailable({ channel: 'summit1g', peers: {}, members: {}, messages: pruned })).toBe(
      false,
    )
  })

  it('does not resurrect a room from another channel’s messages', () => {
    expect(
      sessionAvailable({
        channel: 'summit1g',
        peers: {},
        members: {},
        messages: [message(NOW - 60_000, 'theburntpeanut')],
      }),
    ).toBe(false)
  })

  it('is never available with no channel at all', () => {
    expect(
      sessionAvailable({
        channel: null,
        peers: { summit1g: ['a'] },
        members: { summit1g: [{}] },
        messages: [message(NOW)],
      }),
    ).toBe(false)
  })
})

describe('availability is answered per destination', () => {
  /** The multi-room property: two streams, two independent answers. */
  it('gives two open streams two different answers', () => {
    const state = {
      peers: { summit1g: ['friend'] },
      members: {},
      messages: [message(NOW - 60_000, 'theburntpeanut')],
    }

    // One is live because somebody is there; the other because of its history.
    expect(sessionAvailable({ channel: 'summit1g', ...state })).toBe(true)
    expect(sessionAvailable({ channel: 'theburntpeanut', ...state })).toBe(true)
    // And a third the viewer has no room on is not available at all.
    expect(sessionAvailable({ channel: 'gingy', ...state })).toBe(false)
  })

  it('does not let one channel’s peers make another available', () => {
    expect(
      sessionAvailable({
        channel: 'theburntpeanut',
        peers: { summit1g: ['friend'] },
        members: { summit1g: [{}] },
        messages: [],
      }),
    ).toBe(false)
  })
})

describe('the temporary Patch 1 workaround is gone', () => {
  const PANEL = readFileSync('src/ui/KickbackPanel.tsx', 'utf8')

  /**
   * The inversion.
   *
   * This assertion used to require the marker. Requiring its ABSENCE is what
   * proves the throwaway was actually thrown away rather than relabelled, and
   * it is why the guard existed in the first place.
   */
  it('no longer carries the removal marker, because it has been removed', () => {
    expect(PANEL).not.toContain('TEMPORARY - REMOVED BY THE MULTI-DESTINATION ROOM LIFECYCLE')
    expect(PANEL).not.toContain('DO NOT BUILD ON THIS')
  })

  it('still introduces no clock of its own', () => {
    const region = PANEL.slice(
      PANEL.indexOf('THE ROOM LIFECYCLE'),
      PANEL.indexOf('const sessionAvailable'),
    )
    expect(region.length).toBeGreaterThan(0)
    // No lease, no timeout, no second retention constant - the buffer is
    // already pruned by the worker and that is the only lifetime involved.
    expect(region).not.toMatch(/setTimeout|Date\.now\(\)|LEASE_MS|_MS\s*=/)
  })

  it('reads its room from this tab’s own channel', () => {
    expect(PANEL).toContain("view.roomPeers[sessionChannel]")
    expect(PANEL).toContain('view.roomMembers[sessionChannel]')
    expect(PANEL).toContain('view.roomUnread[sessionChannel]')
  })
})
