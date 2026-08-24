import { describe, expect, it } from 'vitest'
import { EMOTES, isEmoteOnly, parseMessage, soleEmote } from '../../src/core/emotes'
import {
  COMBO_BREAKER_THRESHOLD,
  COMBO_MIN_DISPLAY,
  annotateCombos,
} from '../../src/core/combos'
import type { ComboMessage } from '../../src/core/combos'

/**
 * Emotes and combos. Both are pure functions of a message list, which is the
 * whole design: reconnects, history replay and a late joiner all derive the
 * same combo without a shared counter to drift.
 */

let nextId = 0
const say = (displayName: string, body: string): ComboMessage => ({
  id: `m${++nextId}`,
  userId: `u-${displayName.toLowerCase()}`,
  displayName,
  body,
})

// ------------------------------------------------------------------ emotes

describe('emote parsing', () => {
  it('leaves plain text alone', () => {
    expect(parseMessage('this guy is cooked')).toEqual([
      { type: 'text', text: 'this guy is cooked' },
    ])
  })

  it('recognises a known token', () => {
    const segments = parseMessage(':lol:')
    expect(segments).toHaveLength(1)
    expect(segments[0]).toMatchObject({ type: 'emote' })
  })

  it('splits text around emotes', () => {
    const segments = parseMessage('what :lol: even')
    expect(segments.map((segment) => segment.type)).toEqual(['text', 'emote', 'text'])
  })

  it('leaves an unknown token as text, inventing nothing', () => {
    expect(parseMessage(':definitelynotanemote:')).toEqual([
      { type: 'text', text: ':definitelynotanemote:' },
    ])
  })

  it('treats markup as ordinary text', () => {
    // Rendering is React text nodes, so this can never become markup - but the
    // parser must not treat it as anything special either.
    const segments = parseMessage('<script>alert(1)</script>')
    expect(segments).toEqual([{ type: 'text', text: '<script>alert(1)</script>' }])
  })

  it('exposes a small, fixed set', () => {
    expect(EMOTES.length).toBeGreaterThan(4)
    expect(EMOTES.length).toBeLessThan(20)
    expect(new Set(EMOTES.map((emote) => emote.token)).size).toBe(EMOTES.length)
  })

  it('every emote token parses back to itself', () => {
    for (const emote of EMOTES) {
      expect(parseMessage(emote.token)).toEqual([{ type: 'emote', emote }])
    }
  })
})

describe('emote-only messages', () => {
  it('recognises a single emote', () => {
    expect(isEmoteOnly(':pog:')).toBe(true)
  })

  it('recognises several emotes with spaces', () => {
    expect(isEmoteOnly(':pog: :pog:')).toBe(true)
  })

  it('rejects a message with words in it', () => {
    expect(isEmoteOnly(':pog: nice')).toBe(false)
  })

  it('rejects plain text and empty input', () => {
    expect(isEmoteOnly('hello')).toBe(false)
    expect(isEmoteOnly('')).toBe(false)
  })
})

describe('what qualifies for a combo', () => {
  it('accepts one emote alone', () => {
    expect(soleEmote(':lol:')?.id).toBe('lol')
  })

  it('accepts the same emote repeated', () => {
    expect(soleEmote(':lol: :lol:')?.id).toBe('lol')
  })

  it('rejects two different emotes', () => {
    expect(soleEmote(':lol: :pog:')).toBeNull()
  })

  it('rejects an emote with words', () => {
    expect(soleEmote(':lol: yeah')).toBeNull()
  })

  it('rejects plain text', () => {
    expect(soleEmote('hello')).toBeNull()
  })

  it('ignores surrounding whitespace', () => {
    expect(soleEmote('   :lol:   ')?.id).toBe('lol')
  })
})

// ------------------------------------------------------------------ combos

describe('combo formation', () => {
  it('says nothing about a lone emote', () => {
    const messages = [say('Jake', ':lol:')]
    expect(annotateCombos(messages).get(messages[0].id)?.comboCount).toBeUndefined()
  })

  it('starts at two', () => {
    const messages = [say('Jake', ':lol:'), say('Matt', ':lol:')]
    const annotations = annotateCombos(messages)

    expect(annotations.get(messages[1].id)?.comboCount).toBe(COMBO_MIN_DISPLAY)
    // The counter lives on the latest message of the run, not on every one.
    expect(annotations.get(messages[0].id)?.comboCount).toBeUndefined()
  })

  it('grows as the chant continues', () => {
    const messages = [
      say('Jake', ':lol:'),
      say('Matt', ':lol:'),
      say('Sarah', ':lol:'),
      say('Chris', ':lol:'),
    ]
    expect(annotateCombos(messages).get(messages[3].id)?.comboCount).toBe(4)
  })

  it('refuses to let one person carry a combo alone', () => {
    // Reversed in 2C.1. A combo is meant to show people joining in, so no
    // amount of spamming your own emote manufactures one.
    const messages = [say('Jake', ':lol:'), say('Jake', ':lol:'), say('Jake', ':lol:')]
    const annotations = annotateCombos(messages)
    for (const message of messages) {
      expect(annotations.get(message.id)?.comboCount).toBeUndefined()
    }
  })

  it('names the emote being chanted', () => {
    const messages = [say('Jake', ':pog:'), say('Matt', ':pog:')]
    expect(annotateCombos(messages).get(messages[1].id)?.comboEmote?.id).toBe('pog')
  })

  it('handles several combos in one conversation', () => {
    const messages = [
      say('Jake', ':lol:'),
      say('Matt', ':lol:'),
      say('Sarah', 'ok'),
      say('Jake', ':pog:'),
      say('Matt', ':pog:'),
    ]
    const annotations = annotateCombos(messages)
    expect(annotations.get(messages[1].id)?.comboCount).toBe(2)
    expect(annotations.get(messages[4].id)?.comboCount).toBe(2)
  })
})

describe('what breaks a combo', () => {
  it('ordinary text ends it', () => {
    const messages = [say('Jake', ':lol:'), say('Matt', ':lol:'), say('Chris', 'shut up')]
    const annotations = annotateCombos(messages)

    expect(annotations.get(messages[1].id)?.comboCount).toBe(2)
    expect(annotations.get(messages[2].id)?.comboCount).toBeUndefined()
  })

  it('a different emote ends it and starts its own run', () => {
    const messages = [
      say('Jake', ':lol:'),
      say('Matt', ':lol:'),
      say('Sarah', ':pog:'),
      say('Chris', ':pog:'),
    ]
    const annotations = annotateCombos(messages)

    expect(annotations.get(messages[1].id)?.comboCount).toBe(2)
    expect(annotations.get(messages[3].id)?.comboCount).toBe(2)
    expect(annotations.get(messages[3].id)?.comboEmote?.id).toBe('pog')
  })

  it('a two-emote message ends it', () => {
    const messages = [
      say('Jake', ':lol:'),
      say('Matt', ':lol:'),
      say('Sarah', ':lol: :pog:'),
    ]
    const annotations = annotateCombos(messages)
    expect(annotations.get(messages[1].id)?.comboCount).toBe(2)
    expect(annotations.get(messages[2].id)?.comboCount).toBeUndefined()
  })
})

describe('the combo breaker', () => {
  it('credits whoever broke a combo worth breaking', () => {
    const messages = [
      say('Jake', ':lol:'),
      say('Matt', ':lol:'),
      say('Sarah', ':lol:'),
      say('Chris', 'nah'),
    ]
    const broke = annotateCombos(messages).get(messages[3].id)?.brokeCombo

    expect(broke).toMatchObject({ count: 3, by: 'Chris' })
    expect(broke?.emote.id).toBe('lol')
  })

  it('stays quiet for a combo that never got going', () => {
    // Two is a coincidence, not an achievement.
    const messages = [say('Jake', ':lol:'), say('Matt', ':lol:'), say('Chris', 'nah')]
    expect(annotateCombos(messages).get(messages[2].id)?.brokeCombo).toBeUndefined()
    expect(COMBO_BREAKER_THRESHOLD).toBe(3)
  })

  it('celebrates a long combo being broken', () => {
    const messages = [
      say('Jake', ':fire:'),
      say('Matt', ':fire:'),
      say('Sarah', ':fire:'),
      say('Nina', ':fire:'),
      say('Omar', ':fire:'),
      say('Chris', 'shut up'),
    ]
    expect(annotateCombos(messages).get(messages[5].id)?.brokeCombo?.count).toBe(5)
  })

  it('does not treat a different emote as a break', () => {
    // Switching chants is a new combo, not a heroic interruption.
    const messages = [
      say('Jake', ':lol:'),
      say('Matt', ':lol:'),
      say('Sarah', ':lol:'),
      say('Chris', ':pog:'),
    ]
    expect(annotateCombos(messages).get(messages[3].id)?.brokeCombo).toBeUndefined()
  })

  it('refuses to let the last contributor break their own combo', () => {
    // Reversed in 2C.1. Otherwise the cheapest way to be credited with a
    // COMBO BROKEN BY is to build the combo yourself and then stop.
    const messages = [
      say('Jake', ':lol:'),
      say('Matt', ':lol:'),
      say('Jake', ':lol:'),
      say('Jake', 'ok im done'),
    ]
    expect(annotateCombos(messages).get(messages[3].id)?.brokeCombo).toBeUndefined()
  })
})

describe('combos are derived, so everyone agrees', () => {
  const conversation = () => [
    say('Jake', 'yo'),
    say('Matt', ':lol:'),
    say('Sarah', ':lol:'),
    say('Nina', ':lol:'),
    say('Chris', 'nah'),
  ]

  it('gives the same answer twice', () => {
    const messages = conversation()
    const first = annotateCombos(messages)
    const second = annotateCombos(messages)

    expect([...second.entries()]).toEqual([...first.entries()])
  })

  it('gives the same answer when history is replayed after a reconnect', () => {
    const messages = conversation()

    // Delivered one at a time, as realtime would.
    let streamed = new Map<string, unknown>()
    for (let i = 1; i <= messages.length; i++) {
      streamed = annotateCombos(messages.slice(0, i)) as Map<string, unknown>
    }

    expect([...streamed.entries()]).toEqual([...annotateCombos(messages).entries()])
  })

  it('reads a combo correctly when only part of the history is loaded', () => {
    // Opening chat mid-combo sees a smaller count, not a wrong one.
    const messages = conversation()
    const partial = annotateCombos(messages.slice(2))

    expect(partial.get(messages[3].id)?.comboCount).toBe(2)
    expect(partial.get(messages[4].id)?.brokeCombo).toBeUndefined()
  })

  it('cannot be faked with markup or lookalike text', () => {
    const messages = [
      say('Jake', ':lol:'),
      say('Matt', ':lol:'),
      say('Mallory', '<b>:lol: x99</b>'),
    ]
    const annotations = annotateCombos(messages)

    // The forged message is ordinary text: it breaks the run, it does not join
    // it, and it certainly does not set the counter.
    expect(annotations.get(messages[2].id)?.comboCount).toBeUndefined()
    expect(annotations.get(messages[1].id)?.comboCount).toBe(2)
  })

  it('handles an empty conversation', () => {
    expect(annotateCombos([]).size).toBe(0)
  })
})
