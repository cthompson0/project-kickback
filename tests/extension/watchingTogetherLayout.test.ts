import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * Watching Together is as tall as the people in it.
 *
 * THE BETA REPORT THIS EXISTS FOR
 *
 *   "the watching together area seems really tall for just one other person -
 *    does it have a static height to show a set number of people?"
 *   "...there should at least be a visual cue separating the participant
 *    region from the chat below"
 *   "the dropdown/collapse arrow is small and difficult to see"
 *
 * It had no static height. It had `flex: 1 1 auto` - and so does chat - so the
 * two SPLIT the panel's free space while the roster also kept its own content
 * height as its basis. Measured in Chrome in a 520px session with two people:
 * the roster box was 236px around 46px of names, and chat got 202px and a
 * scrollbar.
 *
 * WHAT THIS FILE CAN AND CANNOT DO. jsdom has no layout engine, so the numbers
 * above came from real Chrome and cannot be reproduced here. What is asserted
 * instead is the SHAPE of the rules that produced them - which is the thing a
 * later edit would actually break.
 *
 * Measured after the change, same method, roster/chat in px:
 *
 *   people  panel  text     roster  chat
 *        2    520  default      53   387     (was 236 / 202)
 *        6    520  default     143   297     capped, scrolls internally
 *       30    520  default     143   297     still capped, never eats chat
 *       12    340  default     119   141     short panel, chat still bigger
 *       12    340  x-large     119   141     and at the largest text size
 */

const CSS = readFileSync(join(process.cwd(), 'src', 'ui', 'kickback.css'), 'utf8')
const SESSION = readFileSync(
  join(process.cwd(), 'src', 'ui', 'components', 'StreamSession.tsx'),
  'utf8',
)

/** The declarations of the rule whose selector is exactly this one. */
const rule = (selector: string) => {
  const at = CSS.indexOf(selector + ' {')
  expect(at, `${selector} should exist`).toBeGreaterThan(-1)
  return CSS.slice(at + selector.length, CSS.indexOf('}', at))
}

describe('the roster is sized by its contents, not by the space available', () => {
  it('does not grow into space that belongs to the conversation', () => {
    // The whole defect in one declaration. flex-grow must be 0.
    expect(rule('.kb-room-people')).toMatch(/flex:\s*0\s/)
  })

  it('still lets chat take the remaining height', () => {
    // Chat is the primary flexible region and has to stay the only one.
    expect(rule('.kb-chat-log')).toMatch(/flex:\s*1\s/)
  })

  it('grows only to a maximum, then scrolls inside itself', () => {
    const declarations = rule('.kb-room-people')
    expect(declarations).toMatch(/max-height:/)
    expect(declarations).toMatch(/overflow-y:\s*auto/)
    // min-height: 0 is what allows a flex item to scroll at all.
    expect(declarations).toMatch(/min-height:\s*0/)
  })

  it('caps by typography AND by panel height, not by a pixel count', () => {
    /*
     * Both halves are load-bearing, and each was arrived at by measuring.
     *
     * em alone: at Extra Large in a 340px panel the cap was 198px of a ~248px
     * budget, leaving chat 62px - the original complaint, reproduced by the
     * accessibility setting.
     *
     * A percentage alone would ignore the text size it is supposed to serve.
     *
     * A pixel constant would be "a hardcoded one-person screenshot", which is
     * the thing this was explicitly not allowed to become.
     */
    const cap = /max-height:\s*([^;]+);/.exec(rule('.kb-room-people'))
    expect(cap, 'the roster should declare a max-height').not.toBeNull()
    expect(cap![1], 'the cap should follow the text size').toMatch(/\dem/)
    expect(cap![1], 'the cap should follow the panel height').toMatch(/\d%/)
    expect(cap![1], 'a pixel cap would not follow either').not.toMatch(/\dpx/)
  })

  it('draws the boundary between presence and conversation', () => {
    expect(rule('.kb-room-people')).toMatch(/border-bottom:[^;]*var\(--kb-line\)/)
  })
})

describe('the disclosure chevron is a shape, not a rare code point', () => {
  it('draws a path rather than U+2303 / U+2304', () => {
    /*
     * ARROWHEAD and DOWN ARROWHEAD are absent from most UI font stacks, so
     * what actually rendered was whichever fallback the browser found, at
     * whatever weight it happened to carry. A path cannot fall back.
     */
    expect(SESSION).toContain('<ChevronIcon open={rosterOpen} />')
    expect(SESSION).not.toMatch(/[\u2303\u2304]/)
  })

  it('is drawn in the same colour as the label beside it', () => {
    // --kb-faint measured 3.56:1 against the panel, the bare floor for a
    // graphical control; --kb-dim is 6.88:1 and is what the label already uses.
    const declarations = rule('.kb-session-chevron')
    expect(declarations).toMatch(/color:\s*var\(--kb-dim\)/)
    expect(declarations).not.toMatch(/--kb-faint/)
  })

  it('no longer shrinks itself below the icon set it belongs to', () => {
    // It used to force font-size: 10px. The icon carries its own size now.
    expect(rule('.kb-session-chevron')).not.toMatch(/font-size/)
  })
})
