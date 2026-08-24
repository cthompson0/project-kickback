import { useEffect, useState } from 'react'
import {
  REACTIONS,
  REACTION_TTL_MS,
  isCombo,
  liveReactions,
  reactionBursts,
} from '../../core/together'
import type { Reaction, TogetherReaction } from '../../core/together'
import { useAnalytics } from '../Analytics'

/**
 * Automatic Together, inside the card for the channel you are on.
 *
 * WHY IT IS NOT ITS OWN CARD
 *
 * Gravity and Together are two states of one destination, not two things. The
 * HERE card already says "LIRIK · 3 · you are here with these people"; this
 * adds the one thing it was missing, which is something to do about it. A
 * second card would mean the same gathering appearing twice on the map.
 *
 * WHAT IT DELIBERATELY IS NOT
 *
 * No room name, no member management, no ownership, no join or leave, no
 * unread count, no history, no text. You arrived at a stream your friends were
 * already watching, and Kickback noticed. Anything more would be asking people
 * to operate a system instead of watching television together.
 */

interface TogetherProps {
  /** Canonical lowercase login the viewer is on. */
  channel: string
  /** Friends here with them, from the same cluster the card already drew. */
  participantCount: number
  reactions: readonly TogetherReaction[]
  onReact: (reaction: Reaction) => void
}

export function Together({ channel, participantCount, reactions, onReact }: TogetherProps) {
  const analytics = useAnalytics()

  /*
   * Reactions age out on their own, so the surface needs a heartbeat of its
   * own - nothing else re-renders the panel between presence updates, and a
   * burst that stayed until the next one would linger for forty seconds.
   *
   * Only while there is something to age.
   */
  const [, setTick] = useState(0)
  useEffect(() => {
    if (reactions.length === 0) return
    const id = window.setInterval(() => setTick((value) => value + 1), 1_000)
    return () => window.clearInterval(id)
  }, [reactions.length])

  // The clock lives in liveReactions, so this stays a pure derivation; the
  // heartbeat above is what makes it run again as reactions age out.
  const bursts = reactionBursts(liveReactions(reactions, channel))

  /*
   * A combo is worth recording once, when it forms.
   *
   * Keyed on the burst's identity rather than counted per render, because this
   * component re-renders on a one-second heartbeat and a naive count would
   * report the same combo eight times as it faded.
   */
  const [recorded] = useState(() => new Set<string>())
  useEffect(() => {
    for (const burst of bursts) {
      if (!isCombo(burst)) continue
      const key = `${burst.reaction}:${burst.userIds.join(',')}`
      if (recorded.has(key)) continue
      recorded.add(key)
      analytics.track(
        'together_combo_formed',
        { combo_size: burst.count, participant_count: participantCount + 1 },
        { source: 'together', channel },
      )
    }
  }, [bursts, recorded, analytics, participantCount, channel])

  return (
    <div className="kb-together">
      <div className="kb-together-bar" role="group" aria-label="React">
        {REACTIONS.map((reaction) => (
          <button
            key={reaction}
            type="button"
            className="kb-together-react"
            title={`React ${reaction}`}
            onClick={() => onReact(reaction)}
          >
            {reaction}
          </button>
        ))}

        {/*
         * What everyone just sent, in the same row as the buttons.
         *
         * Beside them rather than above: the surface has to stay two lines
         * tall at 260px, and a reaction landing must not push the friends or
         * the JOIN around. An empty stream renders nothing at all, so the row
         * is the buttons and no reserved space.
         */}
        <div className="kb-together-live" aria-live="polite">
          {bursts.map((burst) => (
            <span
              key={`${burst.reaction}:${burst.at}`}
              className={`kb-together-burst${isCombo(burst) ? ' kb-together-combo' : ''}`}
              style={{ animationDuration: `${REACTION_TTL_MS}ms` }}
              title={isCombo(burst) ? `${burst.count} people` : undefined}
            >
              {burst.reaction}
              {isCombo(burst) && <span className="kb-together-count">×{burst.count}</span>}
            </span>
          ))}
        </div>
      </div>
    </div>
  )
}
