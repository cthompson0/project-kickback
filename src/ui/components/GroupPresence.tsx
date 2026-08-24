import { useMemo, useState } from 'react'
import { clusterMembers } from '../../core/groupPresence'
import type { MemberCluster } from '../../core/groupPresence'
import type { Activity } from '../../core/types'
import type { GroupMember, KickbackClient } from '../../client/types'
import { Avatar } from './Avatar'
import { JoinButton } from './JoinButton'
import { UserCard } from './UserCard'
import type { UserCardContext } from './UserCard'
import { useChannelName } from '../ChannelNames'

/**
 * Who is in this group and where they are.
 *
 * Organised by what people are doing rather than by name, because that is the
 * question a group exists to answer. Everyone under one heading is together,
 * so "two of us are on the same stream" is something you see rather than
 * something you work out by reading two rows and noticing they match.
 *
 * The roster stays complete - offline members are still listed, at the bottom -
 * so the group remains a circle you can look at, not just a list of who
 * happens to be online.
 */

function ClusterHeading({
  cluster,
  channelName,
}: {
  cluster: MemberCluster<GroupMember>
  channelName: (channel: string) => string
}) {
  const count = cluster.members.length

  if (cluster.kind === 'here') {
    return (
      <div className="kb-cluster-head kb-cluster-head-here">
        <span className="kb-cluster-title">
          Watching with you{cluster.channel ? ` on ${channelName(cluster.channel)}` : ''}
        </span>
        <span className="kb-cluster-count">{count}</span>
      </div>
    )
  }

  if (cluster.kind === 'channel' && cluster.channel) {
    return (
      <div className="kb-cluster-head">
        <span className="kb-cluster-title kb-channel">{channelName(cluster.channel)}</span>
        <span className="kb-cluster-count">{count}</span>
        <span className="kb-header-spacer" />
        {/* JOIN belongs on the cluster, not on each person: you are going to
            the channel, and everyone under this heading is already there. */}
        <JoinButton channel={cluster.channel} source="group" />
      </div>
    )
  }

  return (
    <div className="kb-cluster-head kb-cluster-head-quiet">
      <span className="kb-cluster-title">
        {cluster.kind === 'browsing' ? 'Around on Twitch' : 'Offline'}
      </span>
      <span className="kb-cluster-count">{count}</span>
    </div>
  )
}

export function GroupPresence({
  members,
  localActivity,
  client,
  cardContext,
}: {
  members: GroupMember[]
  localActivity: Activity
  client: KickbackClient
  /** One coherent context, shared with every other card in the panel. */
  cardContext: UserCardContext
}) {
  const [openCardId, setOpenCardId] = useState<string | null>(null)
  const channelName = useChannelName()

  const clusters = useMemo(
    () =>
      clusterMembers(
        members.map((member) => ({
          member,
          presence: member.presence,
          userId: member.user.id,
        })),
        localActivity,
        // Left to the function's own default: reading the clock during render
        // is impure, and the value is only used to age presence out.
        undefined,
        // "Where is everyone else": the viewer is never one of them.
        cardContext.selfId,
      ),
    [members, localActivity, cardContext.selfId],
  )

  return (
    <div className="kb-clusters">
      {clusters.map((cluster) => (
        <div className="kb-cluster" key={`${cluster.kind}:${cluster.channel ?? ''}`}>
          <ClusterHeading cluster={cluster} channelName={channelName} />

          {cluster.members.map((member) => (
            <div className="kb-cluster-row" key={member.user.id}>
              <button
                type="button"
                className="kb-person-btn"
                title={`About ${member.user.displayName}`}
                onClick={() =>
                  setOpenCardId((open) => (open === member.user.id ? null : member.user.id))
                }
              >
                <Avatar user={member.user} size={20} showDot={false} />
                <span className="kb-cluster-name">{member.user.displayName}</span>
                {member.role === 'owner' && <span className="kb-role">owner</span>}
              </button>

              {openCardId === member.user.id && (
                <UserCard
                  user={member.user}
                  presence={member.presence}
                  client={client}
                  context={cardContext}
                  onClose={() => setOpenCardId(null)}
                />
              )}
            </div>
          ))}
        </div>
      ))}
    </div>
  )
}
