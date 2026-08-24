import { describe, expect, it } from 'vitest'
import { annotateCombos, activeCombo, scanCombos } from '../../src/core/combos'
import type { ComboMessage } from '../../src/core/combos'
import { emoteKey, externalEmoteUrl, externalToken } from '../../src/core/emotes'
import type { Emote } from '../../src/core/emotes'

/**
 * The contributor rule, introduced in 2C.1.
 *
 * A Kickback combo is a claim about *people*, not about message count: it says
 * several of your friends are chanting the same thing. That only holds if one
 * person cannot produce one on their own, which is what every test here is
 * really checking.
 *
 * The rule is local, not global: you may not follow yourself, but two people
 * alternating forever is a perfectly good combo.
 */

let nextId = 0
const say = (displayName: string, body: string): ComboMessage => ({
  id: `m${++nextId}`,
  // One user id per display name, so "the same person" means what it looks like.
  userId: `u-${displayName.toLowerCase()}`,
  displayName,
  body,
})

/** Counter shown on the run's latest contributing message. */
const countAt = (messages: ComboMessage[], index: number) =>
  annotateCombos(messages).get(messages[index].id)?.comboCount

/** Highest counter anywhere in the conversation. */
const peak = (messages: ComboMessage[]) => {
  const counts = [...annotateCombos(messages).values()]
    .map((annotation) => annotation.comboCount)
    .filter((count): count is number => count !== undefined)
  return counts.length ? Math.max(...counts) : undefined
}

const OMEGALUL = '01F00Z3A9G0007E4VV006YKSK9'
const SEVENTV_LOL = '01FCXYZABC000255V6CN6XXXX0'

const sevenTv = (id: string, name: string): Emote => ({
  provider: '7tv',
  id,
  name,
  animated: false,
  url: externalEmoteUrl('7tv', id),
})

const OMEGA = externalToken(sevenTv(OMEGALUL, 'OMEGALUL'))

// ------------------------------------------------------- the sequences

describe('who may extend a combo', () => {
  it('A A - one person alone is not a combo', () => {
    expect(peak([say('A', ':lol:'), say('A', ':lol:')])).toBeUndefined()
  })

  it('A B - two people are', () => {
    const messages = [say('A', ':lol:'), say('B', ':lol:')]
    expect(countAt(messages, 1)).toBe(2)
  })

  it('A B A - the same person may come back round', () => {
    const messages = [say('A', ':lol:'), say('B', ':lol:'), say('A', ':lol:')]
    expect(countAt(messages, 2)).toBe(3)
  })

  it('A B A B - alternating indefinitely is fine', () => {
    const messages = [
      say('A', ':lol:'),
      say('B', ':lol:'),
      say('A', ':lol:'),
      say('B', ':lol:'),
    ]
    expect(countAt(messages, 3)).toBe(4)
    // Contributors are not required to be globally unique - only to differ
    // from whoever went immediately before.
    expect(new Set(messages.map((m) => m.userId)).size).toBe(2)
  })

  it('A A B - a self-repeat is skipped, and the next person still joins in', () => {
    // Documented choice: the repeat is ignored rather than treated as a break,
    // so B is the second *voice* and the combo reads x2. Spamming your own
    // emote neither builds a combo nor destroys one.
    const messages = [say('A', ':lol:'), say('A', ':lol:'), say('B', ':lol:')]
    expect(countAt(messages, 2)).toBe(2)
    expect(countAt(messages, 1)).toBeUndefined()
  })

  it('A A A A B - any number of self-repeats still counts as one voice', () => {
    const messages = [
      say('A', ':lol:'),
      say('A', ':lol:'),
      say('A', ':lol:'),
      say('A', ':lol:'),
      say('B', ':lol:'),
    ]
    expect(peak(messages)).toBe(2)
  })

  it('A B B A - a repeat mid-combo does not reset it', () => {
    const messages = [
      say('A', ':lol:'),
      say('B', ':lol:'),
      say('B', ':lol:'),
      say('A', ':lol:'),
    ]
    expect(countAt(messages, 3)).toBe(3)
  })

  it('counts three different people as three', () => {
    const messages = [say('A', ':lol:'), say('B', ':lol:'), say('C', ':lol:')]
    expect(countAt(messages, 2)).toBe(3)
  })

  it('never annotates a self-repeat as the latest contributing message', () => {
    // The counter must sit on the message that actually contributed, or the
    // number appears next to a message that did nothing.
    const messages = [say('A', ':lol:'), say('B', ':lol:'), say('B', ':lol:')]
    const annotations = annotateCombos(messages)
    expect(annotations.get(messages[1].id)?.comboCount).toBe(2)
    expect(annotations.get(messages[2].id)?.comboCount).toBeUndefined()
  })
})

// -------------------------------------------------------- active combo

describe('the active combo', () => {
  it('reports the run still open at the end', () => {
    const messages = [say('A', ':lol:'), say('B', ':lol:'), say('A', ':lol:')]
    expect(activeCombo(messages)).toMatchObject({ count: 3, lastUserId: 'u-a' })
  })

  it('names the emote so the indicator can draw it', () => {
    const active = activeCombo([say('A', ':pog:'), say('B', ':pog:')])
    expect(active?.emote.name).toBe('pog')
    expect(emoteKey(active!.emote)).toBe('kickback:pog')
  })

  it('is nothing when the last message is ordinary text', () => {
    const messages = [say('A', ':lol:'), say('B', ':lol:'), say('C', 'anyway')]
    expect(activeCombo(messages)).toBeNull()
  })

  it('is nothing for a run of one', () => {
    expect(activeCombo([say('A', ':lol:')])).toBeNull()
    // Including a run of one padded out by its own author.
    expect(activeCombo([say('A', ':lol:'), say('A', ':lol:')])).toBeNull()
  })

  it('is nothing for an empty conversation', () => {
    expect(activeCombo([])).toBeNull()
  })

  it('follows a switch to a different emote', () => {
    const messages = [
      say('A', ':lol:'),
      say('B', ':lol:'),
      say('C', ':pog:'),
      say('D', ':pog:'),
    ]
    expect(activeCombo(messages)?.emote.name).toBe('pog')
    expect(activeCombo(messages)?.count).toBe(2)
  })

  it('grows in place as the chant continues', () => {
    const messages = [say('A', ':lol:'), say('B', ':lol:')]
    expect(activeCombo(messages)?.count).toBe(2)
    messages.push(say('A', ':lol:'))
    expect(activeCombo(messages)?.count).toBe(3)
    // Same emote identity throughout: the indicator updates rather than being
    // replaced by a different one.
    expect(emoteKey(activeCombo(messages)!.emote)).toBe('kickback:lol')
  })

  it('names who may not extend it next', () => {
    const messages = [say('A', ':lol:'), say('B', ':lol:')]
    expect(activeCombo(messages)?.lastUserId).toBe('u-b')
    // And a repeat from that person leaves it exactly as it was.
    messages.push(say('B', ':lol:'))
    expect(activeCombo(messages)).toMatchObject({ count: 2, lastUserId: 'u-b' })
  })

  it('agrees with the annotation pass', () => {
    // Both come from one walk of the list, so they cannot disagree - but that
    // is the property worth pinning down.
    const messages = [say('A', ':lol:'), say('B', ':lol:'), say('A', ':lol:')]
    const { annotations, active } = scanCombos(messages)
    expect(annotations.get(messages[2].id)?.comboCount).toBe(active?.count)
  })
})

// ------------------------------------------------------------- breaker

describe('who may break a combo', () => {
  const run = () => [say('A', ':lol:'), say('B', ':lol:'), say('A', ':lol:')]

  it('credits a different person who interrupts with text', () => {
    const messages = [...run(), say('B', 'ok stop')]
    expect(annotateCombos(messages).get(messages[3].id)?.brokeCombo).toMatchObject({
      by: 'B',
      count: 3,
    })
  })

  it('gives no credit to the last contributor', () => {
    // A built the combo up to 3; A cannot then break it for the applause.
    const messages = [...run(), say('A', 'ok im done')]
    expect(annotateCombos(messages).get(messages[3].id)?.brokeCombo).toBeUndefined()
  })

  it('still ends the combo even when nobody is credited', () => {
    const messages = [...run(), say('A', 'ok im done')]
    expect(activeCombo(messages)).toBeNull()
  })

  it('credits an uninvolved bystander', () => {
    const messages = [...run(), say('Z', 'what is happening')]
    expect(annotateCombos(messages).get(messages[3].id)?.brokeCombo?.by).toBe('Z')
  })

  it('gives no credit below the threshold', () => {
    const messages = [say('A', ':lol:'), say('B', ':lol:'), say('C', 'nope')]
    expect(annotateCombos(messages).get(messages[2].id)?.brokeCombo).toBeUndefined()
  })

  it('gives no credit for joining in with a different emote', () => {
    // The final rule, re-confirmed in 2C.1: switching chants is participation,
    // not interruption. Only ordinary text breaks a combo.
    const messages = [...run(), say('Z', ':pog:')]
    expect(annotateCombos(messages).get(messages[3].id)?.brokeCombo).toBeUndefined()
  })

  it('reports the emote and count that were broken', () => {
    const messages = [...run(), say('Z', 'stop')]
    const broke = annotateCombos(messages).get(messages[3].id)?.brokeCombo
    expect(broke?.count).toBe(3)
    expect(broke?.emote.name).toBe('lol')
  })

  it('cannot be earned by padding a combo out alone', () => {
    // A alone can never reach the threshold, so there is nothing to break.
    const messages = [
      say('A', ':lol:'),
      say('A', ':lol:'),
      say('A', ':lol:'),
      say('B', 'ok'),
    ]
    expect(annotateCombos(messages).get(messages[3].id)?.brokeCombo).toBeUndefined()
  })
})

// -------------------------------------------------------- determinism

describe('every client computes the same answer', () => {
  const conversation = (): ComboMessage[] => [
    say('A', 'here we go'),
    say('A', ':lol:'),
    say('B', ':lol:'),
    say('C', ':lol:'),
    say('C', ':lol:'),
    say('A', ':lol:'),
    say('D', 'lmao stop'),
    say('B', OMEGA),
    say('C', OMEGA),
  ]

  it('replays history to the same result', () => {
    const messages = conversation()
    const first = scanCombos(messages)
    const second = scanCombos(messages)
    expect([...first.annotations.entries()]).toEqual([...second.annotations.entries()])
    expect(first.active).toEqual(second.active)
  })

  it('reaches the same state whether streamed or replayed at once', () => {
    // A reconnect replays history; a live client saw it arrive one at a time.
    // They must not end up disagreeing about the number on screen.
    const messages = conversation()
    let streamed = scanCombos([])
    for (let index = 1; index <= messages.length; index += 1) {
      streamed = scanCombos(messages.slice(0, index))
    }
    const replayed = scanCombos(messages)
    expect([...streamed.annotations.entries()]).toEqual([...replayed.annotations.entries()])
    expect(streamed.active).toEqual(replayed.active)
  })

  it('needs no stored state to know a combo is running', () => {
    const messages = conversation()
    expect(scanCombos(messages).active).toMatchObject({ count: 2, lastUserId: 'u-c' })
  })

  it('gives a late joiner the same active combo', () => {
    // Someone who opened chat after the breaker sees the same live chant.
    const messages = conversation()
    const late = scanCombos(messages.slice(7))
    expect(late.active).toMatchObject({ count: 2 })
    expect(late.active?.emote.id).toBe(OMEGALUL)
  })
})

// ----------------------------------------------------------- providers

describe('7TV combos follow the same rules', () => {
  it('will not let one person carry a 7TV combo', () => {
    expect(peak([say('A', OMEGA), say('A', OMEGA), say('A', OMEGA)])).toBeUndefined()
  })

  it('counts alternating people', () => {
    const messages = [say('A', OMEGA), say('B', OMEGA), say('A', OMEGA)]
    expect(countAt(messages, 2)).toBe(3)
    expect(activeCombo(messages)?.emote.provider).toBe('7tv')
  })

  it('skips a self-repeat and keeps going', () => {
    const messages = [say('A', OMEGA), say('A', OMEGA), say('B', OMEGA)]
    expect(countAt(messages, 2)).toBe(2)
  })

  it('refuses breaker credit to the last 7TV contributor', () => {
    const messages = [say('A', OMEGA), say('B', OMEGA), say('A', OMEGA), say('A', 'done')]
    expect(annotateCombos(messages).get(messages[3].id)?.brokeCombo).toBeUndefined()
  })

  it('does not combo two emotes that merely share a name', () => {
    // Kickback's :lol: and a 7TV emote called lol are different emotes, so
    // different people chanting them is not one combo.
    const theirs = externalToken(sevenTv(SEVENTV_LOL, 'lol'))
    const messages = [say('A', ':lol:'), say('B', theirs), say('C', ':lol:')]
    expect(peak(messages)).toBeUndefined()
    expect(activeCombo(messages)).toBeNull()
  })

  it('combos a 7TV emote with itself across a rename', () => {
    const before = `[[7tv|${OMEGALUL}|OMEGALUL]]`
    const after = `[[7tv|${OMEGALUL}|OMEGALULiguess]]`
    const messages = [say('A', before), say('B', after)]
    expect(countAt(messages, 1)).toBe(2)
  })
})
