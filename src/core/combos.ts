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
 * WHAT QUALIFIES
 *
 *   - A message qualifies if it is nothing but one emote (repeats of that
 *     same emote within the message are fine). Mixed text, or two different
 *     emotes, do not.
 *   - "Same emote" means same provider AND same stable id. Two emotes that
 *     merely share a name - Watchside's :lol: and a 7TV one called lol, say -
 *     are different emotes and do not extend one another's combo.
 *
 * WHO CAN EXTEND IT
 *
 * A combo is meant to show *people joining in*, not one person spamming. So a
 * qualifying message only extends the run when it comes from someone other
 * than the last person who contributed to it:
 *
 *     A A        -> 1. A's second message is ignored; it is not a combo.
 *     A B        -> 2
 *     A B A      -> 3   the same person may come back round
 *     A B A B    -> 4
 *     A A B      -> 2   A's repeat is skipped, B still joins in
 *
 * Note what this is *not*: contributors do not have to be globally unique.
 * Two people alternating forever is a perfectly good combo. The only rule is
 * that you cannot follow yourself.
 *
 * A repeat from the last contributor is *ignored*, not treated as a break -
 * it leaves the run exactly as it was. Spamming your own emote neither grows
 * a combo nor destroys one.
 *
 * HOW IT ENDS
 *
 *   - A run is worth showing at COMBO_MIN_DISPLAY. The counter is annotated
 *     on the run's latest contributing message, so it grows in place, and the
 *     run that is still open at the end of the list is also reported as the
 *     ACTIVE combo for the indicator above the composer.
 *   - A different emote closes the run and opens its own. It gets no breaker
 *     credit: joining in with a different emote is participation, not
 *     interruption.
 *   - An ordinary message closes the run. If the run had reached
 *     COMBO_BREAKER_THRESHOLD *and* the sender is not the last contributor,
 *     that message is credited with breaking it. You cannot break your own
 *     combo for the credit.
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
  /** Set on the last contributing message of a run of 2+: render "xN". */
  comboCount?: number
  comboEmote?: Emote
  /** Set on a message that ended a run that had reached the threshold. */
  brokeCombo?: {
    emote: Emote
    count: number
    by: string
  }
}

/** The run still open at the end of the list, if it is worth showing. */
export interface ActiveCombo {
  emote: Emote
  count: number
  /** Who may not extend it next. */
  lastUserId: string
}

export interface ComboScan {
  annotations: Map<string, ComboAnnotation>
  active: ActiveCombo | null
}

/**
 * Walks the messages once and reports both what to annotate and what is still
 * running.
 *
 * One pass rather than two, because the active combo is by definition the run
 * the annotation pass would end on - deriving it separately would be a second
 * chance to disagree with itself.
 */
export function scanCombos(messages: ComboMessage[]): ComboScan {
  const annotations = new Map<string, ComboAnnotation>()

  let runEmote: Emote | null = null
  let runCount = 0
  let runLastId: string | null = null
  /** The last person who actually contributed; the one who cannot go again. */
  let runLastUserId: string | null = null

  const closeRun = (breaker: ComboMessage | null) => {
    if (runEmote && runCount >= COMBO_MIN_DISPLAY && runLastId) {
      annotations.set(runLastId, {
        ...annotations.get(runLastId),
        comboCount: runCount,
        comboEmote: runEmote,
      })
    }
    if (
      breaker &&
      runEmote &&
      runCount >= COMBO_BREAKER_THRESHOLD &&
      // You cannot build a combo and then break it yourself for the credit.
      breaker.userId !== runLastUserId
    ) {
      annotations.set(breaker.id, {
        ...annotations.get(breaker.id),
        brokeCombo: { emote: runEmote, count: runCount, by: breaker.displayName },
      })
    }
    runEmote = null
    runCount = 0
    runLastId = null
    runLastUserId = null
  }

  for (const message of messages) {
    const emote = soleEmote(message.body)

    if (emote && runEmote && emoteKey(emote) === emoteKey(runEmote)) {
      if (message.userId === runLastUserId) {
        // Same person again: not a second voice, so it adds nothing. The run
        // survives untouched, waiting for somebody else.
        continue
      }
      runCount += 1
      runLastId = message.id
      runLastUserId = message.userId
      continue
    }

    // Anything else ends whatever was running. A different emote starts a new
    // run of its own and is not an interruption; ordinary text may be.
    closeRun(emote ? null : message)

    if (emote) {
      runEmote = emote
      runCount = 1
      runLastId = message.id
      runLastUserId = message.userId
    }
  }

  // A live combo at the end of the list still shows its counter, and is the
  // one the anchored indicator reports.
  const active: ActiveCombo | null =
    runEmote && runCount >= COMBO_MIN_DISPLAY && runLastUserId
      ? { emote: runEmote, count: runCount, lastUserId: runLastUserId }
      : null

  closeRun(null)

  return { annotations, active }
}

/**
 * Annotates messages with combo state.
 *
 * Returns a map keyed by message id so rendering stays a simple lookup and the
 * message list itself is never rewritten - history stays readable as history.
 */
export function annotateCombos(messages: ComboMessage[]): Map<string, ComboAnnotation> {
  return scanCombos(messages).annotations
}

/** The combo currently running, for the indicator anchored above the composer. */
export function activeCombo(messages: ComboMessage[]): ActiveCombo | null {
  return scanCombos(messages).active
}
