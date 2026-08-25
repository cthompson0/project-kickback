import { useEffect, useState } from 'react'
import { REACTIONS, liveReactions, reactionEmote, reactionMessages } from '../../core/together'
import type { Reaction, TogetherReaction } from '../../core/together'
import { scanCombos } from '../../core/combos'
import { directCount, sortMembers } from '../../core/streamRoom'
import type { RoomMember } from '../../core/streamRoom'
import type { Friend } from '../../client/types'
import type { UserCardContext } from './UserCard'
import type { KickbackClient } from '../../client/types'
import { EmoteImage } from './EmoteImage'
import { Avatar } from './Avatar'
import { UserCard } from './UserCard'
import { useAnalytics } from '../Analytics'

/**
 * The automatic Stream Room, inside the card for the channel you are on.
 *
 * TWO SURFACES, ONE EVENT STREAM
 *
 * The quick strip is always there: five buttons and whatever just landed.
 * OPEN ROOM expands the people, which is the part that needs space - because
 * the room is the connected social component, so it can contain somebody you
 * have never met who arrived through a friend.
 *
 * Both surfaces send the same event and read the same buffer, and both count
 * it with `scanCombos` - the combo engine Kickback already had. A reaction is
 * one of Kickback's own emotes, so there is nothing here that knows how to
 * count a combo; it asks the thing that already did.
 *
 * WHY THE COMBO IS ONE BADGE AND NOT A ROW OF EMOJI
 *
 * The first version rendered every burst side by side, which is the stacking
 * that was reported. `scanCombos` annotates the run's latest contribution with
 * a count, so a combo grows IN PLACE - one symbol, one number - exactly as it
 * does in group chat.
 */

interface TogetherProps {
  /** Canonical lowercase login the viewer is on. */
  channel: string
  /** Everybody in the connected component, from the server. */
  members: readonly RoomMember[]
  /** Friends the panel already knows about, for names and avatars. */
  friends: readonly Friend[]
  reactions: readonly TogetherReaction[]
  selfId: string | null
  client: KickbackClient
  cardContext: UserCardContext
  onReact: (reaction: Reaction) => void
}

export function Together({
  channel,
  members,
  friends,
  reactions,
  selfId,
  client,
  cardContext,
  onReact,
}: TogetherProps) {
  const analytics = useAnalytics()
  const [open, setOpen] = useState(false)
  const [openCardId, setOpenCardId] = useState<string | null>(null)

  /*
   * Reactions age out on their own, so the surface needs a heartbeat: nothing
   * else re-renders the panel between presence updates, and a combo that
   * stayed until the next one would linger for forty seconds. Only while
   * there is something to age.
   */
  const [, setTick] = useState(0)
  useEffect(() => {
    if (reactions.length === 0) return
    const id = window.setInterval(() => setTick((value) => value + 1), 1_000)
    return () => window.clearInterval(id)
  }, [reactions.length])

  /** Everyone the panel can name, including people met through a friend. */
  const byId = new Map(friends.map((friend) => [friend.user.id, friend]))
  const nameOf = (userId: string) =>
    userId === selfId ? 'You' : (byId.get(userId)?.user.displayName ?? 'Someone')

  // The clock lives in liveReactions, so this stays a pure derivation.
  const live = liveReactions(reactions, channel)
  const { annotations } = scanCombos(reactionMessages(live, nameOf))

  /*
   * What to draw: ONE thing per run.
   *
   * `scanCombos` annotates only the LAST contribution of a run, because in a
   * chat the earlier ones are still their own messages sitting above it. Here
   * they are not - a run is a single badge - so the contributors behind each
   * annotation are folded into it. Drawing them as well is precisely the
   * emoji-stacking that was reported.
   *
   * The run is reconstructed from the engine's own count rather than by
   * re-deciding its rules: walk back from the annotated entry over the same
   * reaction until `count` distinct people have been collected.
   */
  const covered = new Set<string>()
  live.forEach((entry, index) => {
    const count = annotations.get(entry.id)?.comboCount
    if (!count) return

    covered.add(entry.id)
    const speakers = new Set<string>([entry.senderId])
    for (let back = index - 1; back >= 0 && speakers.size < count; back -= 1) {
      const earlier = live[back]
      if (earlier.reaction !== entry.reaction) break
      covered.add(earlier.id)
      speakers.add(earlier.senderId)
    }
  })

  const badges = live.filter((entry) => annotations.get(entry.id)?.comboCount)
  const singles = live.filter((entry) => !covered.has(entry.id))

  /*
   * A combo is recorded once, when it forms.
   *
   * Keyed on the run rather than counted per render: this component re-renders
   * on a one-second heartbeat, and a naive count would report the same combo
   * eight times as it faded.
   */
  const [recorded] = useState(() => new Set<string>())
  useEffect(() => {
    for (const entry of badges) {
      const count = annotations.get(entry.id)?.comboCount
      if (!count) continue
      const key = `${entry.id}:${count}`
      if (recorded.has(key)) continue
      recorded.add(key)
      analytics.track(
        'automatic_room_combo',
        { combo_size: count, participant_count: members.length + 1 },
        { source: 'together', channel },
      )
    }
  }, [badges, annotations, recorded, analytics, members.length, channel])

  const ordered = sortMembers(members)

  return (
    <div className="kb-together">
      <div className="kb-together-bar" role="group" aria-label="React">
        {REACTIONS.map((reaction) => (
          <button
            key={reaction}
            type="button"
            className="kb-together-react"
            title={`React ${reactionEmote(reaction).label}`}
            onClick={() => onReact(reaction)}
          >
            <EmoteImage emote={reactionEmote(reaction)} size={17} />
          </button>
        ))}

        {/*
         * What just happened, beside the buttons rather than above them: the
         * row must not change height when a reaction lands, because they
         * arrive while somebody is watching a stream, not looking at the panel.
         */}
        <div className="kb-together-live" aria-live="polite">
          {singles.map((entry) => (
            <span key={entry.id} className="kb-together-burst">
              <EmoteImage emote={reactionEmote(entry.reaction)} size={16} />
            </span>
          ))}
          {badges.map((entry) => (
            <span key={entry.id} className="kb-together-burst kb-together-combo">
              <EmoteImage emote={reactionEmote(entry.reaction)} size={16} />
              <span className="kb-together-count">×{annotations.get(entry.id)?.comboCount}</span>
            </span>
          ))}
        </div>

        <button
          type="button"
          className="kb-together-open"
          aria-expanded={open}
          onClick={() => {
            const next = !open
            setOpen(next)
            if (next) {
              analytics.track(
                'automatic_room_opened',
                {
                  participant_count: members.length + 1,
                  direct_friend_count: directCount(members),
                },
                { source: 'together', channel },
              )
            }
          }}
        >
          {open ? 'CLOSE' : 'ROOM'}
        </button>
      </div>

      {/*
       * The people.
       *
       * Only when asked for: the room can hold somebody two hops away, and a
       * list of names nobody opened would take space from the destination
       * without answering a question anybody had.
       */}
      {open && (
        <div className="kb-room">
          {ordered.map((member) => {
            const friend = byId.get(member.userId)
            const via = member.viaUserId ? byId.get(member.viaUserId) : undefined

            return (
              <div className="kb-room-person" key={member.userId}>
                <button
                  type="button"
                  className="kb-person-btn"
                  title={`About ${nameOf(member.userId)}`}
                  onClick={() =>
                    setOpenCardId((current) =>
                      current === member.userId ? null : member.userId,
                    )
                  }
                >
                  {friend ? (
                    <Avatar user={friend.user} size={20} showDot={false} />
                  ) : (
                    <span className="kb-room-unknown" aria-hidden="true">
                      ?
                    </span>
                  )}
                  <span className="kb-cluster-name">{nameOf(member.userId)}</span>
                </button>

                {/*
                 * One hop of context, and no more.
                 *
                 * "Friend of Jake" is what turns a stranger in your panel into
                 * somebody who arrived through a person you trust. Beyond that
                 * the server does not tell us, deliberately - "friend of a
                 * friend of Jake" is graph detail nobody needs.
                 */}
                {member.hops === 2 && via && (
                  <span className="kb-room-via">Friend of {via.user.displayName}</span>
                )}

                {friend && openCardId === member.userId && (
                  <UserCard
                    user={friend.user}
                    presence={friend.presence}
                    client={client}
                    context={cardContext}
                    onClose={() => setOpenCardId(null)}
                  />
                )}
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}
