import { directCount } from '../../core/streamRoom'
import type { RoomMember } from '../../core/streamRoom'
import { useAnalytics } from '../Analytics'

/**
 * The way into the session, on the card for the channel the viewer is on.
 *
 * WHAT THIS HAS STOPPED BEING
 *
 * It was five permanent reaction buttons and a roster; then a doorway plus
 * an activity preview. The preview has moved to the card's own status line,
 * beside LIVE and the viewer count, where ephemeral social activity belongs -
 * on the left it competed with the destination and the friends for the eye,
 * and pushed them around every time somebody sent an emote.
 *
 * So this is now exactly two things: whether anything is waiting, and the
 * way in. No names, no narration, no composer.
 */

interface TogetherProps {
  /** Canonical lowercase login the viewer is on. */
  channel: string
  /** Everybody the SERVER put in the room, including friends of friends. */
  members: readonly RoomMember[]
  /** Direct friends presence already proves are here. */
  peers: number
  /** Messages waiting, so the doorway can say there is something to read. */
  unread: number
  onOpen: () => void
}

export function Together({ channel, members, peers, unread, onOpen }: TogetherProps) {
  const analytics = useAnalytics()

  return (
    <div className="kb-together">
      <button
        type="button"
        className="kb-together-open"
        onClick={() => {
          analytics.track(
            'automatic_room_opened',
            {
              // Whichever source knows about more people. Presence sees
              // direct friends first; the server sees the whole component.
              participant_count: Math.max(members.length, peers) + 1,
              direct_friend_count: Math.max(directCount(members), peers),
              opened_from: 'here_card',
            },
            { source: 'together', channel },
          )
          onOpen()
        }}
      >
        ROOM
        {/*
         * Something waiting, said as quietly as possible.
         *
         * Unread is "somebody said something to me". The combo on the status
         * line is "something is happening right now" and is gone in eight
         * seconds - two different facts, deliberately in two places.
         */}
        {unread > 0 && <span className="kb-together-unread">{unread > 9 ? '9+' : unread}</span>}
      </button>
    </div>
  )
}
