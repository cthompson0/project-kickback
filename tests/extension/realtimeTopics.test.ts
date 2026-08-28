import { describe, expect, it } from 'vitest'
import { createTopicGate, setFingerprint, topicFor } from '../../src/background/realtimeTopics'

/**
 * Naming a channel, and not colliding with the previous one.
 *
 * Both properties below were broken in ways nothing could observe. Topics were
 * spelled with the SIZE of the id set - `presence:<count>:<first>` and
 * `groups:<user>:<count>` - so two different sets of the same size shared a
 * name, and supabase-js keys its channel registry by name. Teardown was fired
 * and forgotten, so a re-subscribe could be handed the instance that was still
 * unsubscribing, with its bindings already gone. Either one produces a channel
 * that is open, silent, and reports no error at all.
 *
 * See docs/reports/multi-stream-room-architecture-2026-08-27.md §10.5.
 *
 * NOTE ON SCOPE. This is hardening on its own merits. It is not evidence about
 * the unresolved group participation incident, and nothing here should be read
 * as fixing it.
 */

describe('a topic names the set, not its size', () => {
  it('gives equal-sized but different sets different names', () => {
    const a = topicFor('kickback-presence', 'friends', ['u1', 'u2', 'u3'])
    const b = topicFor('kickback-presence', 'friends', ['u1', 'u2', 'u4'])
    expect(a).not.toBe(b)
  })

  /** The exact shape that used to collide: same size, same first element. */
  it('separates sets that share a first member', () => {
    const a = topicFor('kickback-presence', 'friends', ['aaa', 'bbb'])
    const b = topicFor('kickback-presence', 'friends', ['aaa', 'ccc'])
    expect(a).not.toBe(b)
  })

  it('gives the same set the same name regardless of order', () => {
    expect(setFingerprint(['u3', 'u1', 'u2'])).toBe(setFingerprint(['u1', 'u2', 'u3']))
  })

  it('treats a duplicate as the same set, so a doubled id is not a new channel', () => {
    expect(setFingerprint(['u1', 'u1', 'u2'])).toBe(setFingerprint(['u1', 'u2']))
  })

  it('separates the empty set from a populated one', () => {
    expect(setFingerprint([])).not.toBe(setFingerprint(['u1']))
  })

  it('separates one group from another, which is the group-channel case', () => {
    const a = topicFor('kickback-groups', 'me', ['g1'])
    const b = topicFor('kickback-groups', 'me', ['g2'])
    expect(a).not.toBe(b)
  })

  it('keeps the user in the name, so two accounts never share a topic', () => {
    expect(topicFor('kickback-groups', 'me', ['g1'])).not.toBe(
      topicFor('kickback-groups', 'you', ['g1']),
    )
  })

  it('spreads across a realistic set without collapsing', () => {
    const names = new Set(
      Array.from({ length: 500 }, (_, index) =>
        setFingerprint([`user-${index}`, `user-${index + 1}`]),
      ),
    )
    // Not a claim of perfection - it is a 32-bit hash - but a claim that it is
    // actually hashing rather than returning the length.
    expect(names.size).toBeGreaterThan(490)
  })

  it('produces a name with the count in it, so a log is readable', () => {
    expect(topicFor('p', 'u', ['a', 'b', 'c'])).toMatch(/^p:u:3-[0-9a-f]{8}$/)
  })
})

describe('the topic gate serialises teardown', () => {
  it('waits for a pending teardown of the same topic', async () => {
    const gate = createTopicGate()
    const order: string[] = []

    let release = () => {}
    const teardown = new Promise<void>((resolve) => {
      release = () => {
        order.push('closed')
        resolve()
      }
    })

    void gate.leave('topic', teardown)

    const opened = gate.enter('topic', async () => {
      order.push('opened')
      return 'channel'
    })

    // Nothing has opened yet: the close is still in flight.
    await Promise.resolve()
    expect(order).toEqual([])

    release()
    await expect(opened).resolves.toBe('channel')
    expect(order).toEqual(['closed', 'opened'])
  })

  it('does not make one topic wait for another', async () => {
    const gate = createTopicGate()
    void gate.leave('slow', new Promise<void>(() => {}))

    // A different topic is unaffected, which is why this is per topic rather
    // than a single lock over the whole client.
    await expect(gate.enter('fast', async () => 'ok')).resolves.toBe('ok')
  })

  it('opens anyway when a teardown fails', async () => {
    const gate = createTopicGate()
    void gate.leave('topic', Promise.reject(new Error('socket gone')))

    // A close that throws must not strand the subscription forever: getting a
    // live channel back is the entire point.
    await expect(gate.enter('topic', async () => 'ok')).resolves.toBe('ok')
  })

  it('waits for every pending teardown, not only the last', async () => {
    const gate = createTopicGate()
    const done: string[] = []

    let releaseA = () => {}
    let releaseB = () => {}
    const a = new Promise<void>((resolve) => {
      releaseA = () => {
        done.push('a')
        resolve()
      }
    })
    const b = new Promise<void>((resolve) => {
      releaseB = () => {
        done.push('b')
        resolve()
      }
    })

    void gate.leave('topic', a)
    void gate.leave('topic', b)

    const opened = gate.enter('topic', async () => {
      done.push('open')
      return true
    })

    releaseB()
    await Promise.resolve()
    expect(done).not.toContain('open')

    releaseA()
    await expect(opened).resolves.toBe(true)
    expect(done[done.length - 1]).toBe('open')
  })

  it('forgets a topic once it is settled, so the map cannot grow forever', async () => {
    const gate = createTopicGate()
    await gate.leave('topic', Promise.resolve())
    await gate.enter('topic', async () => null)
    // Allow the clean-up continuation to run.
    await Promise.resolve()
    expect(gate.pending()).toBe(0)
  })
})
