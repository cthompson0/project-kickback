import { describe, expect, it } from 'vitest'
import {
  ARRIVAL_WINDOW_MS,
  TOGETHER_WINDOW_MS,
  createJoinAttribution,
} from '../../src/background/joinAttribution'
import type { JoinAttribution } from '../../src/background/joinAttribution'

/**
 * Attribution is what turns four separate events into one funnel, so the
 * interesting cases are all the ways a JOIN does NOT go to plan: the
 * navigation fails, the user changes their mind, they click five times, the
 * worker dies in between, or they were already there.
 */

function harness(startAt = 1_700_000_000_000) {
  let clock = startAt
  let ids = 0
  const cell: { value: JoinAttribution | null } = { value: null }

  const make = () =>
    createJoinAttribution({
      store: {
        read: async () => cell.value,
        write: async (value) => {
          cell.value = value
        },
      },
      now: () => clock,
      newId: () => `attr-${++ids}`,
    })

  return {
    make,
    /** A fresh tracker over the same storage - what a worker restart is. */
    restart: make,
    advance: (ms: number) => {
      clock += ms
    },
    stored: () => cell.value,
  }
}

describe('the happy path', () => {
  it('mints an attribution on the click and answers it on arrival', async () => {
    const h = harness()
    const tracker = h.make()

    const click = await tracker.click({
      channel: 'lirik',
      source: 'gathering',
      sessionId: 'session-1',
    })
    expect(click.state).toBe('pending')

    h.advance(4_000)
    const arrived = await tracker.arrive('lirik')

    expect(arrived?.id).toBe(click.id)
    expect(arrived?.state).toBe('arrived')
    expect(arrived!.arrivedAt! - arrived!.clickedAt).toBe(4_000)
  })

  it('survives the worker being killed between the click and the arrival', async () => {
    const h = harness()
    await h.make().click({ channel: 'lirik', source: 'gathering', sessionId: 's' })

    h.advance(20_000)
    // A different instance entirely: the navigation killed the old worker.
    const arrived = await h.restart().arrive('lirik')

    expect(arrived?.id).toBe('attr-1')
  })

  it('stays attributable to a shared watch that begins a little later', async () => {
    const h = harness()
    const tracker = h.make()
    await tracker.click({ channel: 'lirik', source: 'gathering', sessionId: 's' })
    await tracker.arrive('lirik')

    h.advance(3 * 60 * 1000)
    expect((await tracker.forTogether('lirik'))?.id).toBe('attr-1')
  })
})

describe('when a JOIN does not go to plan', () => {
  it('expires a click that never arrives', async () => {
    const h = harness()
    const tracker = h.make()
    await tracker.click({ channel: 'lirik', source: 'friend_row', sessionId: 's' })

    h.advance(ARRIVAL_WINDOW_MS + 1)
    expect(await tracker.arrive('lirik')).toBeNull()
    // And is cleared, so it cannot be resurrected by a coincidence later.
    expect(h.stored()).toBeNull()
  })

  it('does not claim an arrival somewhere else', async () => {
    const h = harness()
    const tracker = h.make()
    await tracker.click({ channel: 'lirik', source: 'friend_row', sessionId: 's' })

    expect(await tracker.arrive('xqc')).toBeNull()
    // Still pending: the user may be passing through on the way there.
    expect(h.stored()?.state).toBe('pending')

    expect((await tracker.arrive('lirik'))?.id).toBe('attr-1')
  })

  it('does not claim an arrival at nothing', async () => {
    const h = harness()
    const tracker = h.make()
    await tracker.click({ channel: 'lirik', source: 'friend_row', sessionId: 's' })
    // Navigated to the Twitch home page rather than a channel.
    expect(await tracker.arrive(null)).toBeNull()
  })

  it('treats five rapid clicks as one intention', async () => {
    const h = harness()
    const tracker = h.make()

    for (let index = 0; index < 5; index += 1) {
      await tracker.click({ channel: 'lirik', source: 'friend_row', sessionId: 's' })
    }

    const arrived = await tracker.arrive('lirik')
    // The last click is the one that counts, and there is exactly one.
    expect(arrived?.id).toBe('attr-5')
    expect(await tracker.arrive('lirik')).toBeNull()
  })

  it('abandons the first when a second JOIN goes somewhere else', async () => {
    const h = harness()
    const tracker = h.make()

    await tracker.click({ channel: 'lirik', source: 'friend_row', sessionId: 's' })
    await tracker.click({ channel: 'xqc', source: 'gathering', sessionId: 's' })

    // They are going to the second place. Crediting the first would be a lie.
    expect(await tracker.arrive('lirik')).toBeNull()
    expect((await tracker.arrive('xqc'))?.source).toBe('gathering')
  })

  it('answers an arrival only once', async () => {
    const h = harness()
    const tracker = h.make()
    await tracker.click({ channel: 'lirik', source: 'friend_row', sessionId: 's' })

    expect(await tracker.arrive('lirik')).not.toBeNull()
    // Navigating away and back is not a second arrival for the same click.
    expect(await tracker.arrive('lirik')).toBeNull()
  })
})

describe('attribution does not last forever', () => {
  it('stops crediting a shared watch once the window has passed', async () => {
    const h = harness()
    const tracker = h.make()
    await tracker.click({ channel: 'lirik', source: 'gathering', sessionId: 's' })
    await tracker.arrive('lirik')

    h.advance(TOGETHER_WINDOW_MS + 1)
    expect(await tracker.forTogether('lirik')).toBeNull()
    expect(h.stored()).toBeNull()
  })

  it('credits only the channel it was for', async () => {
    const h = harness()
    const tracker = h.make()
    await tracker.click({ channel: 'lirik', source: 'gathering', sessionId: 's' })
    await tracker.arrive('lirik')

    expect(await tracker.forTogether('xqc')).toBeNull()
  })

  it('credits nothing while the click is still pending', async () => {
    const h = harness()
    const tracker = h.make()
    await tracker.click({ channel: 'lirik', source: 'gathering', sessionId: 's' })

    // A shared watch that starts before the arrival is a coincidence, not the
    // click's outcome.
    expect(await tracker.forTogether('lirik')).toBeNull()
  })

  it('clears on demand, for sign-out', async () => {
    const h = harness()
    const tracker = h.make()
    await tracker.click({ channel: 'lirik', source: 'gathering', sessionId: 's' })
    await tracker.clear()
    expect(h.stored()).toBeNull()
  })
})
