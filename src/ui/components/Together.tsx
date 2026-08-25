import { useEffect, useState } from 'react'
import { COMBO_MIN_DISPLAY } from '../../core/combos'
import { roomActivity } from '../../core/together'
import type { TogetherReaction } from '../../core/together'
import { directCount } from '../../core/streamRoom'
import type { RoomMember } from '../../core/streamRoom'
import type { Friend } from '../../client/types'
import { EmoteImage } from './EmoteImage'
import { useAnalytics } from '../Analytics'

/**
 * The room, seen from outside it.
 *
 * WHAT THIS USED TO BE, AND WHY IT CHANGED
 *
 * It used to be the whole feature: five permanent reaction buttons, a live
 * strip, a roster, and a ROOM button that expanded the roster in place. Two
 * things were wrong with that, and neither was a bug.
 *
 * The buttons made the social map into a composer. Gravity's job is to answer
 * "where is everybody" at a glance, and five always-present controls in the
 * middle of that answer are a thing to operate rather than a thing to read.
 *
 * And ROOM was a disclosure triangle. Presence → Gravity → JOIN → Together
 * ends in arriving somewhere, and expanding a card is not arriving. The room
 * is a view now, so this is reduced to the two things a card outside it should
 * carry: what is happening in there, and the way in.
 *
 * WHAT LEAKS OUTWARD, AND WHAT DOES NOT
 *
 * The combo leaks. `😂 ×6` on the card is real activity from inside the room,
 * and it is enough on its own - a glance says something is happening right
 * now, which is the whole point. What does not leak is who: no names, no
 * "Sarah and Jake are reacting", no narration. Narration is a feed, and a feed
 * is something you read rather than something you notice.
 */

interface TogetherProps {
  /** Canonical lowercase login the viewer is on. */
  channel: string
  /** Everybody in the connected component, from the server. */
  members: readonly RoomMember[]
  /** Friends the panel already knows about, for combo attribution. */
  friends: readonly Friend[]
  reactions: readonly TogetherReaction[]
  selfId: string | null
  onOpen: () => void
}

export function Together({
  channel,
  members,
  friends,
  reactions,
  selfId,
  onOpen,
}: TogetherProps) {
  const analytics = useAnalytics()

  /*
   * Reactions age out on their own, so this needs a heartbeat: nothing else
   * re-renders the panel between presence updates, and a combo that stayed
   * until the next one would sit there for forty seconds claiming to be now.
   * Only while there is something to age - an idle card ticks nothing.
   */
  const [, setTick] = useState(0)
  useEffect(() => {
    if (reactions.length === 0) return
    const id = window.setInterval(() => setTick((value) => value + 1), 1_000)
    return () => window.clearInterval(id)
  }, [reactions.length])

  const byId = new Map(friends.map((friend) => [friend.user.id, friend]))
  const nameOf = (userId: string) =>
    userId === selfId ? 'You' : (byId.get(userId)?.user.displayName ?? 'Someone')

  // The clock lives inside roomActivity, so this stays a pure derivation - and
  // it is the SAME derivation the room itself draws from.
  const activity = roomActivity(reactions, channel, nameOf)

  /*
   * A combo is recorded once, when it reaches a size.
   *
   * Keyed on emote and count rather than counted per render: this re-renders
   * every second while a combo is on screen, and a naive count would report
   * one combo eight times as it faded.
   */
  const [recorded] = useState(() => new Set<string>())
  useEffect(() => {
    if (!activity || activity.count < COMBO_MIN_DISPLAY) return
    const key = `${activity.emote.id}:${activity.count}`
    if (recorded.has(key)) return
    recorded.add(key)
    analytics.track(
      'automatic_room_combo',
      { combo_size: activity.count, participant_count: members.length + 1 },
      { source: 'together', channel },
    )
  }, [activity, recorded, analytics, members.length, channel])

  return (
    <div className="kb-together">
      {/*
       * What is happening, and nothing when nothing is.
       *
       * The slot keeps its height whether or not it has something in it, so a
       * reaction landing does not shove the friends below it down the card -
       * these arrive while somebody is watching a stream, not while they are
       * looking at the panel.
       */}
      <div className="kb-together-live" aria-live="polite">
        {activity && (
          <span
            className="kb-together-burst"
            // Keyed so a new run mounts fresh and replays the entry animation
            // rather than silently swapping the artwork of the old one.
            key={`${activity.emote.id}:${activity.count}`}
          >
            <EmoteImage emote={activity.emote} size={16} />
            {activity.count >= COMBO_MIN_DISPLAY && (
              <span className="kb-together-count">×{activity.count}</span>
            )}
          </span>
        )}
      </div>

      <button
        type="button"
        className="kb-together-open"
        onClick={() => {
          analytics.track(
            'automatic_room_opened',
            {
              participant_count: members.length + 1,
              direct_friend_count: directCount(members),
            },
            { source: 'together', channel },
          )
          onOpen()
        }}
      >
        ROOM
      </button>
    </div>
  )
}
