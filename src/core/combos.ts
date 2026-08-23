import { emoteKey, soleEmote } from './emotes'
import type { Emote } from './emotes'

/**
 * Emote combos, derived entirely from ordered messages.
 *
 * Nothing about a combo is stored. Given the same messages in the same order,
 * every client computes the same answer - which is what makes reconnects,
 * history replay, and someone opening chat halfway through a combo all agree
 * without a shared counter to drift out of sync.
 *
 * The rules:
 *
 *   - A message qualifies if it is nothing but one emote (repeats of that
 *     same emote are fine). Mixed text or two different emotes do not.
 *   - "Same emote" means same provider AND same stable id. Two emotes that
 *     merely share a name - Kickback's :lol: and a 7TV one called lol, say -
 *     are different emotes and do not extend one another's combo.
 *   - Consecutive qualifying messages with the same emote extend the run.
 *   - The same person may extend a combo. For a small friend group, one
 *     person spamming the chant is part of the joke rather than cheating.
 *   - A run is worth showing at 2. The counter is annotated on the run's
 *     latest message, so it grows in place as the chant continues.
 *   - Once a run reaches BREAKER_THRESHOLD, the next non-qualifying message
 *     breaks it, and that message is credited with the break.
 */

export const COMBO_MIN_DISPLAY = 2
/** Below this, a broken combo is not worth celebrating. */
export const COMBO_BREAKER_THRESHOLD = 3

export interface ComboMessage {
  id: string
  userId: string
  displayName: string
  body: string
}

export interface ComboAnnotation {
  /** Set on the last message of a run of 2+: render "xN". */
  comboCount?: number
  comboEmote?: Emote
  /** Set on a message that ended a run that had reached the threshold. */
  brokeCombo?: {
    emote: Emote
    count: number
    by: string
  }
}

/**
 * Annotates messages with combo state.
 *
 * Returns a map keyed by message id so rendering stays a simple lookup and the
 * message list itself is never rewritten - history stays readable as history.
 */
export function annotateCombos(messages: ComboMessage[]): Map<string, ComboAnnotation> {
  const annotations = new Map<string, ComboAnnotation>()

  let runEmote: Emote | null = null
  let runCount = 0
  let runLastId: string | null = null

  const closeRun = (breaker: ComboMessage | null) => {
    if (runEmote && runCount >= COMBO_MIN_DISPLAY && runLastId) {
      annotations.set(runLastId, {
        ...annotations.get(runLastId),
        comboCount: runCount,
        comboEmote: runEmote,
      })
    }
    if (breaker && runEmote && runCount >= COMBO_BREAKER_THRESHOLD) {
      annotations.set(breaker.id, {
        ...annotations.get(breaker.id),
        brokeCombo: { emote: runEmote, count: runCount, by: breaker.displayName },
      })
    }
    runEmote = null
    runCount = 0
    runLastId = null
  }

  for (const message of messages) {
    const emote = soleEmote(message.body)

    if (emote && runEmote && emoteKey(emote) === emoteKey(runEmote)) {
      runCount += 1
      runLastId = message.id
      continue
    }

    // Anything else ends whatever was running. A different emote starts a new
    // run of its own; ordinary text starts nothing.
    closeRun(emote ? null : message)

    if (emote) {
      runEmote = emote
      runCount = 1
      runLastId = message.id
    }
  }

  // A live combo at the end of the list still shows its counter.
  closeRun(null)

  return annotations
}
