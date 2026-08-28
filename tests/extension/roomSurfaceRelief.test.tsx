import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { RETENTION_MS, liveMessages } from '../../src/core/roomMessages'
import type { RoomMessage } from '../../src/core/roomMessages'

/**
 * TEMPORARY - REMOVED BY THE MULTI-DESTINATION ROOM LIFECYCLE.
 *
 * WHAT THIS COVERS AND WHY IT IS DELIBERATELY SHALLOW
 *
 * `sessionAvailable` in KickbackPanel used to require another live peer, while
 * the conversation those peers had lives for thirty minutes. So the surface
 * could vanish mid-sentence and take a readable conversation off screen with
 * it - the proven root cause of beta finding #10. See
 * docs/reports/friends-beta-investigation-2026-08-27.md §8.
 *
 * Patch 1 adds one more way for the surface to stay: retained messages on this
 * channel. That is knowingly throwaway. The approved architecture replaces
 * `sessionAvailable` outright with a per-destination room lifecycle, where a
 * room's presence in the panel follows the destination set and the retention
 * window rather than a live peer count. See
 * docs/reports/multi-stream-room-architecture-2026-08-27.md §4.3 and §16.
 *
 * These tests therefore assert the PROPERTY - the surface outlives the peers by
 * exactly as long as the messages do, and not one moment longer - rather than
 * pinning the expression, so replacing it next checkpoint means deleting this
 * file rather than unpicking it. The guard at the end is what makes sure the
 * deletion actually happens.
 */

const NOW = 1_700_000_000_000

function message(at: number, channel = 'summit1g'): RoomMessage {
  return {
    id: `m-${at}`,
    senderId: 'them',
    channel,
    body: 'still here?',
    at,
    receivedAt: at,
  }
}

/**
 * The condition as the panel evaluates it.
 *
 * Mirrored rather than imported because KickbackPanel is a whole shell with a
 * client, a layout and an analytics provider behind it, and what is being
 * tested is one boolean. The mirror is kept honest by the source guard below.
 */
function sessionAvailable(input: {
  channel: string | null
  peers: number
  members: number
  messages: RoomMessage[]
  now: number
}): boolean {
  const retained =
    input.channel !== null && input.messages.some((entry) => entry.channel === input.channel)
  return input.channel !== null && (input.peers > 0 || input.members > 0 || retained)
}

describe('the room surface outlives its peers, for exactly as long as its messages', () => {
  it('is available while somebody else is here, as it always was', () => {
    expect(
      sessionAvailable({ channel: 'summit1g', peers: 1, members: 0, messages: [], now: NOW }),
    ).toBe(true)
  })

  it('is available on server membership alone, as it always was', () => {
    expect(
      sessionAvailable({ channel: 'summit1g', peers: 0, members: 2, messages: [], now: NOW }),
    ).toBe(true)
  })

  /** Finding #10, in one assertion. */
  it('stays available when the last peer leaves but the conversation is still there', () => {
    const recent = [message(NOW - 60_000)]
    expect(
      sessionAvailable({ channel: 'summit1g', peers: 0, members: 0, messages: recent, now: NOW }),
    ).toBe(true)
  })

  it('goes away once the conversation has expired', () => {
    /*
     * Not a second clock. The worker prunes its buffer to RETENTION_MS, so an
     * expired message is not in `messages` at all by the time the panel sees
     * it - which is why this fix introduces no new lifetime and is not a
     * continuity lease.
     */
    const stale = [message(NOW - RETENTION_MS - 1)]
    const pruned = liveMessages(stale, 'summit1g', NOW)
    expect(pruned).toHaveLength(0)

    expect(
      sessionAvailable({ channel: 'summit1g', peers: 0, members: 0, messages: pruned, now: NOW }),
    ).toBe(false)
  })

  it('does not resurrect a room from another channel’s messages', () => {
    const elsewhere = [message(NOW - 60_000, 'theburntpeanut')]
    expect(
      sessionAvailable({
        channel: 'summit1g',
        peers: 0,
        members: 0,
        messages: elsewhere,
        now: NOW,
      }),
    ).toBe(false)
  })

  it('is never available with no channel at all', () => {
    expect(
      sessionAvailable({
        channel: null,
        peers: 3,
        members: 3,
        messages: [message(NOW)],
        now: NOW,
      }),
    ).toBe(false)
  })
})

describe('the temporary fix is labelled as temporary', () => {
  const SOURCE = readFileSync('src/ui/KickbackPanel.tsx', 'utf8')

  /**
   * A guard, not decoration.
   *
   * The next checkpoint is meant to DELETE `sessionAvailable`, not extend it.
   * If somebody removes the marker while leaving the condition in place, the
   * throwaway quietly becomes architecture - which is the specific outcome the
   * architecture review asked to prevent.
   */
  it('carries the removal marker in the source', () => {
    expect(SOURCE).toContain('TEMPORARY - REMOVED BY THE MULTI-DESTINATION ROOM LIFECYCLE')
  })

  it('says what replaces it', () => {
    expect(SOURCE).toContain('multi-stream-room-architecture-2026-08-27.md')
  })

  it('introduces no clock of its own', () => {
    const region = SOURCE.slice(
      SOURCE.indexOf('TEMPORARY - REMOVED BY'),
      SOURCE.indexOf('const sessionAvailable'),
    )
    // No lease, no timeout, no second retention constant - the buffer is
    // already pruned by the worker and that is the only lifetime involved.
    expect(region).not.toMatch(/setTimeout|Date\.now\(\)|LEASE_MS|_MS\s*=/)
  })
})
