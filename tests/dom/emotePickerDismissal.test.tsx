import { readFileSync } from 'node:fs'
import { act } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mount } from './harness'
import { Composer } from '../../src/ui/components/Conversation'
import type { KickbackClient } from '../../src/client/types'

/**
 * Reaching for the chat box puts the emote picker away.
 *
 * THE BETA REPORT THIS EXISTS FOR
 *
 *   "clicking into the chat box usually closes the emoji menu i feel like,
 *    having to specifically click the emoji button again felt odd"
 *
 * They are right about the convention, and the picker had no dismissal at all
 * except the toggle that opened it - so it stayed up over the conversation
 * while you typed underneath it.
 *
 * WHY THIS IS IN THE DOM PROJECT AND NOT THE NODE ONE
 *
 * The whole fix is a distinction between two ways the input can receive focus,
 * and only one of them is a real event. `renderToStaticMarkup` dispatches
 * nothing, so a node test could only assert that the word "onPointerDown"
 * appears in the file - which would pass just as happily if the handler closed
 * the wrong thing, or if `onPick` had been left focusing the input in a way
 * that slams the picker shut on the first emote.
 */

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true })
})
afterEach(() => {
  vi.useRealTimers()
})

function stub() {
  const sections = [
    {
      title: 'Watchside',
      emotes: [{ token: ':kbHype:', name: 'kbHype', url: null }],
    },
  ]
  return {
    searchEmotes: async () => sections,
    track: () => {},
  } as unknown as KickbackClient
}

async function open() {
  const view = mount(
    <Composer client={stub()} maxLength={280} placeholder="Say something" onSend={async () => {}} />,
  )
  await act(async () => {
    await Promise.resolve()
  })

  const toggle = view.container.querySelector('.kb-emote-toggle') as HTMLButtonElement
  await act(async () => {
    toggle.click()
    await Promise.resolve()
  })
  return { view, toggle }
}

const isOpen = (view: { container: HTMLElement }) =>
  view.container.querySelector('.kb-emote-toggle-open') !== null

describe('the picker opens and closes from the toggle', () => {
  it('is closed until asked for', async () => {
    const view = mount(
      <Composer
        client={stub()}
        maxLength={280}
        placeholder="Say something"
        onSend={async () => {}}
      />,
    )
    expect(isOpen(view)).toBe(false)
    view.unmount()
  })

  it('opens on the toggle', async () => {
    const { view } = await open()
    expect(isOpen(view)).toBe(true)
    view.unmount()
  })
})

describe('reaching for the composer dismisses the picker', () => {
  /** The exact reported gesture: click into the chat box. */
  it('closes when the input is pressed', async () => {
    const { view } = await open()
    const input = view.container.querySelector('.kb-composer-input') as HTMLInputElement

    await act(async () => {
      input.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }))
      await Promise.resolve()
    })

    expect(isOpen(view)).toBe(false)
    view.unmount()
  })

  it('closes on Escape, which is what a keyboard reaches for', async () => {
    const { view } = await open()
    const input = view.container.querySelector('.kb-composer-input') as HTMLInputElement

    await act(async () => {
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
      await Promise.resolve()
    })

    expect(isOpen(view)).toBe(false)
    view.unmount()
  })

  it('does not send the draft on the Escape that closes it', async () => {
    /*
     * Escape and Enter share one handler. Closing the picker must return
     * rather than fall through, or dismissing it would post whatever was
     * half-typed.
     */
    const sent: string[] = []
    const view = mount(
      <Composer
        client={stub()}
        maxLength={280}
        placeholder="Say something"
        onSend={async (body) => {
          sent.push(body)
        }}
      />,
    )
    await act(async () => {
      await Promise.resolve()
    })
    const toggle = view.container.querySelector('.kb-emote-toggle') as HTMLButtonElement
    const input = view.container.querySelector('.kb-composer-input') as HTMLInputElement
    await act(async () => {
      toggle.click()
      await Promise.resolve()
    })
    await act(async () => {
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
      await Promise.resolve()
    })

    expect(sent).toEqual([])
    view.unmount()
  })
})

describe('picking several emotes in a row still works', () => {
  /**
   * THE THING THE FIX MUST NOT BREAK, AND THE REASON IT IS pointerdown.
   *
   * `onPick` calls focus() on the input so typing continues where it left off.
   * Had the dismissal been hung on `focus`, the first emote would have closed
   * the picker - trading one annoyance for a worse one. A programmatic focus()
   * fires no pointer event, so the human closes it and we do not.
   */
  it('stays open after an emote is chosen', async () => {
    const { view } = await open()
    // The picker debounces its catalog fetch, so let the timer run before
    // looking for something to click.
    await act(async () => {
      vi.advanceTimersByTime(200)
      await Promise.resolve()
    })
    const emote = [...view.container.querySelectorAll('button')].find((button) =>
      (button.className ?? '').includes('kb-emote-btn'),
    )
    expect(emote, 'the picker should render a pickable emote').toBeTruthy()

    await act(async () => {
      emote!.click()
      await Promise.resolve()
    })

    expect(isOpen(view)).toBe(true)
    view.unmount()
  })

  it('hangs the dismissal on a pointer event, never on focus', () => {
    /*
     * A structural guard on the distinction itself. `onFocus` here would pass
     * every behavioural test above while breaking the multi-pick case, because
     * these tests click rather than tab.
     */
    const source = readFileSync('src/ui/components/Conversation.tsx', 'utf8')
    expect(source).toContain('onPointerDown={() => setPickerOpen(false)}')
    expect(source).not.toMatch(/onFocus=\{\(\) => setPickerOpen/)
  })
})
