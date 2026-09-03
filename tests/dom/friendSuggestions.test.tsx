import { readFileSync } from 'node:fs'
import { act } from 'react'
import { describe, expect, it, vi } from 'vitest'
import { mount } from './harness'
import { FriendSuggestions } from '../../src/ui/components/GrowFriends'
import type { KickbackClient } from '../../src/client/types'

/**
 * The suggestion list, actually mounted.
 *
 * WHY THIS IS IN THE DOM PROJECT
 *
 * Everything here depends on effects running: the list fetches in one, and the
 * impression is emitted in another. `renderToStaticMarkup` cannot run either,
 * so a node-project test of this component can only read the source - and a
 * source assertion passes happily while the component returns null two lines
 * earlier, which is precisely the regression being guarded against.
 *
 * That was not hypothetical. The first version of these assertions lived in the
 * node project, and the mutation that restores the silent-null behaviour walked
 * straight past them.
 *
 * WHAT IS BEING DEFENDED
 *
 *   1. an empty result explains itself instead of disappearing
 *   2. a non-empty result draws the people
 *   3. the impression means "somebody could see this", not "we asked"
 */

interface Tracked {
  name: string
  properties: Record<string, unknown>
}

function stub(rows: unknown[]) {
  const tracked: Tracked[] = []
  const client = {
    suggestFriends: async () => rows,
    sendFriendRequest: async () => 'requested',
    track: (name: string, properties: Record<string, unknown>) => {
      tracked.push({ name, properties })
    },
  } as unknown as KickbackClient
  return { client, tracked }
}

const person = (id: string, name: string, mutualCount: number) => ({
  userId: id,
  displayName: name,
  avatarUrl: null,
  twitchLogin: name.toLowerCase(),
  mutualCount,
})

/** A friend, in the shape the worker broadcasts. */
const friendOf = (id: string) =>
  ({ user: { id, username: id, displayName: id, avatarUrl: null } }) as never

/** An outgoing request, in the shape the worker broadcasts. */
const requestTo = (id: string) =>
  ({ requestId: 'r-' + id, user: { id, username: id, displayName: id, avatarUrl: null } }) as never

/**
 * Mount and let the fetch effect settle.
 *
 * `friends` and `outgoing` are the authoritative relationship state the worker
 * broadcasts. Suggestion rows derive their button from them rather than from a
 * local map, which is what makes a cancel performed anywhere show up here.
 */
async function show(rows: unknown[], friends: never[] = [], outgoing: never[] = []) {
  const { client, tracked } = stub(rows)
  const view = mount(
    <FriendSuggestions client={client} friends={friends} outgoingRequests={outgoing} />,
  )
  await act(async () => {
    await Promise.resolve()
  })
  return { view, tracked, client }
}

describe('an empty suggestion list explains itself', () => {
  /**
   * THE REGRESSION THIS EXISTS FOR.
   *
   * It used to return null, so somebody who had deliberately opened
   * find-friends could not tell whether the feature was empty, broken or
   * absent - and it is empty exactly when they are new, because suggestions
   * come from friends of friends and a new account has neither.
   */
  it('says why there is nobody to suggest', async () => {
    const { view } = await show([])
    const text = view.container.textContent ?? ''

    expect(text).toContain('Nobody to suggest yet')
    expect(text).toContain('People you may know')
    // And points at the two things that work from a standing start.
    expect(text).toContain('Search')
    expect(text).toContain('invite')
    view.unmount()
  })

  it('renders something rather than nothing', async () => {
    const { view } = await show([])
    expect(view.container.innerHTML.length).toBeGreaterThan(0)
    view.unmount()
  })

  /** An empty list is not an impression: nothing was shown to have an opinion about. */
  it('records no impression', async () => {
    const { view, tracked } = await show([])
    expect(tracked.filter((event) => event.name === 'friend_suggestion_impression')).toHaveLength(0)
    view.unmount()
  })
})

describe('a real suggestion list draws the people', () => {
  it('shows names and mutual counts', async () => {
    const { view } = await show([person('u1', 'Casey', 2), person('u2', 'Robin', 1)])
    const text = view.container.textContent ?? ''

    expect(text).toContain('Casey')
    expect(text).toContain('Robin')
    expect(text).toContain('2 mutual friends')
    expect(text).toContain('1 mutual friend')
    expect(text).not.toContain('Nobody to suggest yet')
    view.unmount()
  })

  /** Never the names of the mutuals - that would publish a friendship. */
  it('says how many friends are in common, never which', async () => {
    const { view } = await show([person('u1', 'Casey', 3)])
    const text = view.container.textContent ?? ''
    expect(text).toContain('3 mutual friends')
    expect(text).not.toContain('Robin')
    view.unmount()
  })

  it('offers a way to add each of them', async () => {
    const { view } = await show([person('u1', 'Casey', 2)])
    const buttons = [...view.container.querySelectorAll('button')]
    expect(buttons.some((button) => button.textContent === 'ADD')).toBe(true)
    view.unmount()
  })
})

describe('the impression means somebody could see it', () => {
  it('is recorded once when the list actually draws', async () => {
    const { view, tracked } = await show([person('u1', 'Casey', 2)])
    const impressions = tracked.filter(
      (event) => event.name === 'friend_suggestion_impression',
    )
    expect(impressions).toHaveLength(1)
    expect(impressions[0].properties.suggestion_count).toBe(1)
    view.unmount()
  })

  /**
   * A re-render is not a second impression.
   *
   * Re-rendering with the SAME client proves little - the effect's dependency
   * array already stops it re-running. The case the guard actually exists for
   * is a re-render carrying a NEW client reference, which re-runs the fetch and
   * re-sets the state, and which the panel can produce at any time. Without the
   * ref that is a second impression for one open of the surface.
   */
  it('is not recorded again when the parent re-renders with a fresh client', async () => {
    const tracked: Tracked[] = []
    const track = (name: string, properties: Record<string, unknown>) => {
      tracked.push({ name, properties })
    }
    const fresh = () =>
      ({
        suggestFriends: async () => [person('u1', 'Casey', 2)],
        sendFriendRequest: async () => 'requested',
        track,
      }) as unknown as KickbackClient

    const view = mount(<FriendSuggestions client={fresh()} friends={[]} outgoingRequests={[]} />)
    await act(async () => {
      await Promise.resolve()
    })

    for (let i = 0; i < 5; i += 1) {
      view.render(<FriendSuggestions client={fresh()} friends={[]} outgoingRequests={[]} />)
      await act(async () => {
        await Promise.resolve()
      })
    }

    expect(tracked.filter((event) => event.name === 'friend_suggestion_impression')).toHaveLength(1)
    view.unmount()
  })

  it('carries a count and a bucket, and nothing about who', async () => {
    const { view, tracked } = await show([person('u1', 'Casey', 2)])
    const impression = tracked.find((event) => event.name === 'friend_suggestion_impression')!
    expect(Object.keys(impression.properties).sort()).toEqual([
      'suggestion_count',
      'top_mutual_bucket',
    ])
    const text = JSON.stringify(impression.properties)
    expect(text).not.toContain('Casey')
    expect(text).not.toContain('u1')
    view.unmount()
  })

  /** A failed fetch is not an impression either. */
  it('records nothing when the fetch fails', async () => {
    const tracked: Tracked[] = []
    const client = {
      suggestFriends: async () => {
        throw new Error('down')
      },
      sendFriendRequest: async () => 'requested',
      track: (name: string, properties: Record<string, unknown>) => {
        tracked.push({ name, properties })
      },
    } as unknown as KickbackClient

    const view = mount(<FriendSuggestions client={client} friends={[]} outgoingRequests={[]} />)
    await act(async () => {
      await Promise.resolve()
    })

    expect(tracked.filter((event) => event.name === 'friend_suggestion_impression')).toHaveLength(0)
    // And it degrades to the empty state rather than to nothing at all.
    expect(view.container.textContent).toContain('Nobody to suggest yet')
    view.unmount()
  })
})

describe('adding somebody from a suggestion still works', () => {
  it('sends the request and reports it', async () => {
    const sent: string[] = []
    const tracked: Tracked[] = []
    const client = {
      suggestFriends: async () => [person('u1', 'Casey', 2)],
      sendFriendRequest: async (userId: string) => {
        sent.push(userId)
        return 'requested'
      },
      track: (name: string, properties: Record<string, unknown>) => {
        tracked.push({ name, properties })
      },
    } as unknown as KickbackClient

    const view = mount(<FriendSuggestions client={client} friends={[]} outgoingRequests={[]} />)
    await act(async () => {
      await Promise.resolve()
    })

    const add = [...view.container.querySelectorAll('button')].find(
      (button) => button.textContent === 'ADD',
    )!
    await act(async () => {
      add.click()
      await Promise.resolve()
    })

    expect(sent).toEqual(['u1'])
    expect(tracked.map((event) => event.name)).toContain('friend_suggestion_add_clicked')
    expect(tracked.map((event) => event.name)).toContain('friend_suggestion_request_created')

    /*
     * The LABEL is deliberately not asserted here any more.
     *
     * It used to read "Requested" from a local map written on click. That map
     * was the defect - it could never say "Add" again without a remount. The
     * row now follows the worker's outgoing-request list, which this stub does
     * not simulate, so the label belongs to the props-driven tests below. What
     * this test owns is that pressing Add really sends the request and records
     * the funnel events.
     */
    view.unmount()
  })
})

// Keep vitest's unused-import check honest about `vi` if it is ever needed.
void vi

describe('a suggestion row follows authoritative relationship state', () => {
  /**
   * THE BETA REPORT THIS EXISTS FOR.
   *
   *   "add friend request, cancel it, have to leave page entirely to get the
   *    Add button back, small QOL the 'people you may know' could refresh on
   *    such actions"
   *
   * The row used to read from a local `added` map, written on Add and never
   * cleared - so "Requested" survived until the component unmounted, which is
   * literally what leaving the page does. It now derives from the friends and
   * outgoing-request lists the worker broadcasts, so a cancel performed
   * anywhere is reflected here.
   */

  it('offers Add when there is no relationship', async () => {
    const { view } = await show([person('u1', 'Casey', 2)])
    expect(view.container.textContent).toContain('ADD')
    view.unmount()
  })

  it('says Requested while a request is outstanding', async () => {
    const { view } = await show([person('u1', 'Casey', 2)], [], [requestTo('u1')])
    expect(view.container.textContent).toContain('Requested')
    expect(view.container.textContent).not.toContain('ADD')
    view.unmount()
  })

  it('RETURNS TO ADD when the request is cancelled, without remounting', async () => {
    /*
     * The exact reported defect. The component is re-rendered with the new
     * props - which is what a worker broadcast does - and never unmounted.
     */
    const { client, view } = await show([person('u1', 'Casey', 2)], [], [requestTo('u1')])
    expect(view.container.textContent).toContain('Requested')

    view.render(
      <FriendSuggestions client={client} friends={[]} outgoingRequests={[]} />,
    )
    await act(async () => {
      await Promise.resolve()
    })

    expect(view.container.textContent).toContain('ADD')
    expect(view.container.textContent).not.toContain('Requested')
    view.unmount()
  })

  it('says Friends once the friendship exists', async () => {
    const { view } = await show([person('u1', 'Casey', 2)], [friendOf('u1')], [])
    expect(view.container.textContent).toContain('Friends')
    expect(view.container.textContent).not.toContain('ADD')
    view.unmount()
  })

  it('keeps no local record that could contradict the worker', () => {
    /*
     * A structural guard on the root cause rather than the symptom. If a
     * local map comes back, a row can disagree with the server again.
     */
    const source = readFileSync('src/ui/components/GrowFriends.tsx', 'utf8')
    expect(source).not.toMatch(/setAdded|const \[added/)
  })
})
