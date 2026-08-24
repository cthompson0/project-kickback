import { useMemo } from 'react'
import { clusterMembers } from '../../core/groupPresence'
import type { Activity } from '../../core/types'
import type { GroupMember } from '../../client/types'
import { JoinButton } from './JoinButton'
import { useChannelName } from '../ChannelNames'

/**
 * Where the group is, in two or three lines, above chat.
 *
 * The full clustered roster lives behind the member button, and that is the
 * right home for it - it is long, it includes everyone, and it is where you go
 * to manage people. But you should not have to know that button exists to
 * learn that three of your friends are on the same stream right now. That is
 * the whole product.
 *
 * So this is the same clustering, reduced to the part you can act on:
 *
 *   - only HERE and channel clusters. Nobody's absence is news, and rendering
 *     offline members above chat would be the roster all over again.
 *   - names as inline text rather than rows, so a cluster is one line.
 *   - capped, because chat needs the vertical space more than a fourth stream
 *     does.
 */

/** Above this the summary stops being a summary. */
const MAX_CLUSTERS = 3
/** Names beyond this become "+N", which is shorter and reads the same. */
const MAX_NAMES = 3

function names(members: GroupMember[]): string {
  const shown = members.slice(0, MAX_NAMES).map((member) => member.user.displayName)
  const rest = members.length - shown.length
  return rest > 0 ? `${shown.join(' · ')} +${rest}` : shown.join(' · ')
}

export function GroupActivitySummary({
  members,
  localActivity,
}: {
  members: GroupMember[]
  localActivity: Activity
}) {
  const channelName = useChannelName()

  const clusters = useMemo(
    () =>
      clusterMembers(
        members.map((member) => ({ member, presence: member.presence })),
        localActivity,
      )
        // Actionable only: somewhere you are, or somewhere you could go.
        .filter((cluster) => cluster.kind === 'here' || cluster.kind === 'channel')
        .slice(0, MAX_CLUSTERS),
    [members, localActivity],
  )

  if (clusters.length === 0) {
    // Saying "nobody is watching anything" every time would be noise; the
    // member button still has the full picture.
    return null
  }

  return (
    <div className="kb-summary">
      {clusters.map((cluster) => (
        <div
          className={`kb-summary-row${cluster.kind === 'here' ? ' kb-summary-row-here' : ''}`}
          key={`${cluster.kind}:${cluster.channel ?? ''}`}
        >
          <span className="kb-summary-where">
            {cluster.kind === 'here'
              ? 'Here with you'
              : channelName(cluster.channel ?? '')}
          </span>
          <span className="kb-summary-count">{cluster.members.length}</span>
          <span className="kb-summary-who">{names(cluster.members)}</span>
          {/* No JOIN on the HERE row: you are already there. */}
          {cluster.kind === 'channel' && cluster.channel && (
            <span onClick={(event) => event.stopPropagation()}>
              <JoinButton channel={cluster.channel} source="group" />
            </span>
          )}
        </div>
      ))}
    </div>
  )
}
