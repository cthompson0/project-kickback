import { beforeEach, describe, expect, it } from 'vitest'
import { MessageList } from '../../src/ui/components/Conversation'
import type { DisplayMessage } from '../../src/ui/components/Conversation'
import type { ComboAnnotation } from '../../src/core/combos'
import type { KickbackClient } from '../../src/client/types'
import { click, fire, flush, giveGeometry, giveGrowingGeometry, mount } from './harness'

/**
 * The autoscroll regression, in the environment that can actually see it.
 *
 * THIS IS THE TEST THAT WAS MISSING
 *
 * The shipped defect was an effect that stopped re-running: the group buffer is
 * capped at 60 messages, the effect depended on `messages.length`, and once the
 * cap was reached its only dependency never changed again. Autoscroll did not
 * degrade - it switched off, permanently, for every conversation past sixty
 * messages.
 *
 * Nothing in the node suite could catch it. Those tests render with
 * `renderToStaticMarkup`, which never runs an effect at all, so 1712 passing
 * tests were compatible with autoscroll being completely broken. See
 * docs/reports/friends-beta-investigation-2026-08-27.md §3.
 *
 * These assertions read `scrollTop` against geometry that grows with the rows
 * in the DOM, rather than asking whether `scrollIntoView` was called. A test
 * that only checks "the browser API fired" is exactly the test that passes
 * while the feature is broken.
 */

const NO_ANNOTATIONS = new Map<string, ComboAnnotation>()
const ROW = 20
const VIEWPORT = 200

function stubClient(): KickbackClient {
  return {
    sendFriendRequest: async () => 'req',
    removeFriend: async () => {},
    searchEmotes: async () => [],
    sendGroupMessage: async () => {},
  } as unknown as KickbackClient
}

const CONTEXT = { localActivity: { type: 'idle' as const }, mutedUserIds: [] as string[] }

function messages(count: number, from = 0): DisplayMessage[] {
  return Array.from({ length: count }, (_, index) => ({
    id: `m${from + index}`,
    userId: 'them',
    displayName: 'Matt',
    avatarUrl: null,
    body: `message ${from + index}`,
  }))
}

function list(items: DisplayMessage[]) {
  return (
    <MessageList
      messages={items}
      annotations={NO_ANNOTATIONS}
      selfId="me"
      client={stubClient()}
      cardContext={CONTEXT as never}
      empty="nothing yet"
    />
  )
}

/**
 * Mount, and give the log geometry that follows its own content.
 *
 * The height has to be derived rather than assigned: React commits the DOM and
 * runs effects inside one `act`, so a test cannot set a new height in between,
 * and a fixed one would measure the log as it was before the message arrived.
 */
function open(count: number) {
  const view = mount(list(messages(count)))
  const element = view.container.querySelector('.kb-chat-log')
  if (!(element instanceof HTMLElement)) throw new Error('no .kb-chat-log rendered')
  const geometry = giveGrowingGeometry(element, {
    rowSelector: '.kb-msg',
    rowHeight: ROW,
    clientHeight: VIEWPORT,
  })
  // The mount effect ran against a height of zero; settle it against the real
  // one so every test starts genuinely at the bottom.
  element.scrollTop = element.scrollHeight
  return { view, log: element, geometry }
}

describe('the chat log follows new messages', () => {
  beforeEach(() => {
    document.body.innerHTML = ''
  })

  it('scrolls to the bottom when a message arrives', () => {
    const { view, log } = open(20)

    view.render(list(messages(21)))
    flush()

    expect(log.scrollHeight).toBe(21 * ROW)
    expect(log.scrollTop).toBe(log.scrollHeight)
    view.unmount()
  })

  /**
   * THE REGRESSION. Fails against the old implementation, and is the reason
   * this file exists.
   *
   * Past the cap the array length is constant, so an effect keyed on
   * `messages.length` never fires again. Keyed on the newest message's
   * identity, it fires on every arrival forever.
   */
  it('keeps following after the buffer stops growing', () => {
    const CAP = 60
    const { view, log } = open(CAP)

    // The buffer is full: every arrival drops the oldest and appends a new
    // one, exactly as background/groups.ts does with slice(-MESSAGE_WINDOW).
    for (let round = 1; round <= 5; round++) {
      const next = messages(CAP, round)
      expect(next).toHaveLength(CAP)
      // Nudged away from the bottom, so only the effect can put it back. The
      // content height is unchanged - only the identities moved - which is
      // exactly the case the old dependency array could not see.
      log.scrollTop = 0
      view.render(list(next))
      flush()
      expect(log.scrollHeight).toBe(CAP * ROW)
      expect(log.scrollTop).toBe(log.scrollHeight)
    }

    view.unmount()
  })

  it('does not yank somebody who has scrolled up', () => {
    const { view, log } = open(40)

    log.scrollTop = 100
    fire(log, new Event('scroll'))
    flush()

    view.render(list(messages(41)))
    flush()

    expect(log.scrollTop).toBe(100)
    view.unmount()
  })

  it('offers a way back, and following resumes when it is taken', () => {
    const { view, log } = open(40)

    expect(view.container.querySelector('.kb-chat-jump')).toBeNull()

    log.scrollTop = 100
    fire(log, new Event('scroll'))
    flush()
    // Scrolled up, but nothing new has happened yet.
    expect(view.container.querySelector('.kb-chat-jump')).toBeNull()

    view.render(list(messages(41)))
    flush()

    const jump = view.container.querySelector('.kb-chat-jump')
    expect(jump).not.toBeNull()
    expect(jump?.textContent).toContain('New messages')

    click(jump as HTMLButtonElement)
    flush()

    expect(log.scrollTop).toBe(log.scrollHeight)
    expect(view.container.querySelector('.kb-chat-jump')).toBeNull()
    view.unmount()
  })

  it('counts as being at the bottom when it is within a line of it', () => {
    const { view, log } = open(40)

    // Twenty pixels short: a rounding artefact, not a decision to read back
    // through the conversation.
    log.scrollTop = log.scrollHeight - log.clientHeight - 20
    fire(log, new Event('scroll'))
    flush()

    view.render(list(messages(41)))
    flush()

    expect(log.scrollTop).toBe(log.scrollHeight)
    view.unmount()
  })

  /**
   * Emotes and avatars resolve after the arrival effect has already run and
   * make the log taller. Without this a follower ends up short of the bottom
   * every time a message contains a picture - which is most of them.
   */
  it('re-anchors when a late image finishes loading', () => {
    const { view, log, geometry } = open(20)
    expect(log.scrollTop).toBe(log.scrollHeight)

    // The image lands and the content grows underneath the viewport.
    geometry.extra(140)
    expect(log.scrollTop).not.toBe(log.scrollHeight)

    const image = document.createElement('img')
    log.appendChild(image)
    // `load` does not bubble, so the component listens in the capture phase.
    fire(image, new Event('load'))

    expect(log.scrollTop).toBe(log.scrollHeight)
    view.unmount()
  })

  it('leaves a late image alone when the reader has scrolled up', () => {
    const { view, log, geometry } = open(20)

    log.scrollTop = 40
    fire(log, new Event('scroll'))
    flush()

    geometry.extra(140)
    const image = document.createElement('img')
    log.appendChild(image)
    fire(image, new Event('load'))

    expect(log.scrollTop).toBe(40)
    view.unmount()
  })

  it('scrolls its own container and never an ancestor', () => {
    const { view, log } = open(20)

    // Something outside the panel that a scrollIntoView ancestor-walk would
    // have moved. This is what used to be able to scroll Twitch's own page.
    const outer = view.container
    giveGeometry(outer, { scrollHeight: 5_000, clientHeight: 100 })
    outer.scrollTop = 42

    view.render(list(messages(21)))
    flush()

    expect(log.scrollTop).toBe(log.scrollHeight)
    expect(outer.scrollTop).toBe(42)
    view.unmount()
  })
})
