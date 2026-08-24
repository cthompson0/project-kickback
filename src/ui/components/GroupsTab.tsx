import { useEffect, useMemo, useState } from 'react'
import type { Activity } from '../../core/types'
import { effectiveStatus, findGatherings, isHere } from '../../core/presence'
import { useChannelName } from '../ChannelNames'
import { GroupPresence } from './GroupPresence'
import { GroupIcon, GroupIconPicker } from './GroupIcon'
import type { Friend, GroupMember, KickbackClient, KickbackState } from '../../client/types'
import { Avatar } from './Avatar'
import { BackIcon } from './Icons'
import { JoinButton } from './JoinButton'
import { GroupChat } from './GroupChat'

/**
 * Groups: what your people are doing, and a place to talk about it.
 *
 * The list leads with activity rather than administration - a group should
 * read as somewhere alive before it reads as a thing you manage.
 */

interface GroupsTabProps {
  view: KickbackState & { localActivity: Activity }
  client: KickbackClient
  friends: Friend[]
  openGroupId: string | null
  onOpenGroup: (groupId: string | null) => void
}

/** What a group is up to, from its members' real presence. */
function useGroupActivity(members: GroupMember[], localActivity: Activity) {
  return useMemo(() => {
    const presences = members.flatMap((member) => (member.presence ? [member.presence] : []))
    const online = presences.filter((presence) => effectiveStatus(presence) === 'online')
    const here = presences.filter((presence) => isHere(presence, localActivity))
    const elsewhere = findGatherings(presences, localActivity)

    return {
      onlineCount: online.length,
      hereCount: here.length,
      gatherings: elsewhere.filter((gathering) => gathering.userIds.length >= 2),
      // A lone member watching something is still worth a line.
      solo: elsewhere.filter((gathering) => gathering.userIds.length === 1),
    }
  }, [members, localActivity])
}

function GroupActivityLine({
  members,
  localActivity,
}: {
  members: GroupMember[]
  localActivity: Activity
}) {
  const activity = useGroupActivity(members, localActivity)
  const channelName = useChannelName()

  if (activity.hereCount > 0) {
    return (
      <div className="kb-gathering kb-gathering-here">
        <span className="kb-gathering-text">
          {activity.hereCount === 1 ? '1 member is here' : `${activity.hereCount} members are here`}
        </span>
      </div>
    )
  }

  const [biggest] = activity.gatherings
  if (biggest) {
    return (
      <div className="kb-gathering">
        <span className="kb-gathering-text">
          🔥 {biggest.userIds.length} watching {channelName(biggest.channel)}
        </span>
        <span onClick={(event) => event.stopPropagation()}>
          <JoinButton channel={biggest.channel} source="group" label="JOIN THEM" />
        </span>
      </div>
    )
  }

  if (activity.onlineCount > 0) {
    return <div className="kb-group-meta-line">{activity.onlineCount} around</div>
  }
  return <div className="kb-group-meta-line">Nobody around</div>
}

function CreateGroup({ client, onDone }: { client: KickbackClient; onDone: () => void }) {
  const [name, setName] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  return (
    <div className="kb-create-group">
      <input
        className="kb-search"
        value={name}
        maxLength={40}
        placeholder="Group name"
        autoFocus
        onChange={(event) => setName(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Enter') void create()
        }}
      />
      {error && <div className="kb-inline-note">{error}</div>}
      <div className="kb-create-actions">
        <button type="button" className="kb-ghost-btn kb-ghost-btn-inline" onClick={onDone}>
          Cancel
        </button>
        <button
          type="button"
          className="kb-join"
          disabled={busy || name.trim().length === 0}
          onClick={() => void create()}
        >
          {busy ? '…' : 'CREATE'}
        </button>
      </div>
    </div>
  )

  async function create() {
    if (busy || name.trim().length === 0) return
    setBusy(true)
    setError(null)
    try {
      await client.createGroup(name.trim())
      onDone()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not create that group.')
    } finally {
      setBusy(false)
    }
  }
}

function GroupDetail({
  view,
  client,
  friends,
  groupId,
  onBack,
}: {
  view: GroupsTabProps['view']
  client: KickbackClient
  friends: Friend[]
  groupId: string
  onBack: () => void
}) {
  const group = view.groups.find((entry) => entry.groupId === groupId)
  const members = view.groupMembers[groupId] ?? []
  const messages = view.groupMessages[groupId] ?? []
  const muted = view.mutedGroupIds.includes(groupId)
  const [managing, setManaging] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [confirmDelete, setConfirmDelete] = useState(false)

  // Looking at a group is what marks it read.
  useEffect(() => {
    client.markGroupRead(groupId)
  }, [client, groupId, messages.length])

  // Passed to the user card so it offers Add friend to exactly the people it
  // applies to, and never to someone already connected. Computed above the
  // early return below, because hook order cannot depend on a branch.
  const friendIds = useMemo(() => new Set(friends.map((friend) => friend.user.id)), [friends])
  const outgoingRequestIds = useMemo(
    () => new Set(view.outgoingRequests.map((request) => request.user.id)),
    [view.outgoingRequests],
  )

  if (!group) {
    return (
      <div className="kb-quiet">
        <div className="kb-quiet-sub">That group is no longer available.</div>
        <button type="button" className="kb-ghost-btn" onClick={onBack}>
          Back
        </button>
      </div>
    )
  }

  const invitable = friends.filter(
    (friend) => !members.some((member) => member.user.id === friend.user.id),
  )
  /** Owners can remove anyone but themselves. */
  const removable = members.filter((member) => member.role !== 'owner')

  return (
    <>
      <div className="kb-detail-head">
        <button type="button" className="kb-back" onClick={onBack} title="Back to groups">
          <BackIcon />
        </button>
        <GroupIcon icon={group.icon} />
        <div className="kb-group-name">{group.name}</div>
        <button
          type="button"
          className="kb-add-btn"
          title={managing ? 'Back to chat' : 'Members and settings'}
          onClick={() => setManaging((open) => !open)}
        >
          {managing ? 'Chat' : `${group.memberCount}`}
        </button>
      </div>

      <GroupActivityLine members={members} localActivity={view.localActivity} />
      {error && <div className="kb-inline-note">{error}</div>}

      {managing ? (
        <>
          {group.isOwner && (
            <>
              <div className="kb-section-label">Group icon</div>
              <GroupIconPicker
                value={group.icon}
                onPick={(icon) => void act(() => client.setGroupIcon(groupId, icon))}
              />
            </>
          )}

          <div className="kb-section-label">Where everyone is</div>
          <GroupPresence
            members={members}
            localActivity={view.localActivity}
            client={client}
            friendIds={friendIds}
            outgoingRequestIds={outgoingRequestIds}
            selfId={view.identity?.userId ?? null}
          />

          {group.isOwner && removable.length > 0 && (
            <>
              <div className="kb-section-label">Remove a member</div>
              {removable.map((member) => (
                <div className="kb-row" key={member.user.id}>
                  <Avatar user={member.user} showDot={false} />
                  <div className="kb-row-main">
                    <div className="kb-row-name">{member.user.displayName}</div>
                  </div>
                  <button
                    type="button"
                    className="kb-row-action"
                    title={`Remove ${member.user.displayName}`}
                    onClick={() => void act(() => client.removeGroupMember(groupId, member.user.id))}
                  >
                    &times;
                  </button>
                </div>
              ))}
            </>
          )}

          {group.isOwner && invitable.length > 0 && (
            <>
              <div className="kb-section-label">Invite a friend</div>
              {invitable.map((friend) => (
                <div className="kb-row" key={friend.user.id}>
                  <Avatar user={friend.user} showDot={false} />
                  <div className="kb-row-main">
                    <div className="kb-row-name">{friend.user.displayName}</div>
                  </div>
                  <button
                    type="button"
                    className="kb-join"
                    onClick={() => void act(() => client.inviteToGroup(groupId, friend.user.id))}
                  >
                    INVITE
                  </button>
                </div>
              ))}
            </>
          )}

          <div className="kb-presence-picker">
            <button
              type="button"
              className="kb-toggle-row"
              onClick={() => void act(() => client.setGroupMuted(groupId, !muted))}
            >
              <span className="kb-account-label">Group notifications</span>
              <span className={`kb-toggle${muted ? '' : ' kb-toggle-on'}`} aria-hidden="true">
                <span className="kb-toggle-knob" />
              </span>
            </button>
            <div className="kb-presence-hint">
              {muted ? 'Muted - no unread badge' : 'Unread badge when messages arrive'}
            </div>
          </div>

          {group.isOwner ? (
            confirmDelete ? (
              <div className="kb-confirm kb-confirm-block">
                <button
                  type="button"
                  className="kb-confirm-yes"
                  onClick={() => void act(async () => {
                    await client.deleteGroup(groupId)
                    onBack()
                  })}
                >
                  Delete {group.name}
                </button>
                <button
                  type="button"
                  className="kb-confirm-no"
                  onClick={() => setConfirmDelete(false)}
                >
                  Cancel
                </button>
              </div>
            ) : (
              <button
                type="button"
                className="kb-ghost-btn"
                onClick={() => setConfirmDelete(true)}
              >
                Delete group
              </button>
            )
          ) : (
            <button
              type="button"
              className="kb-ghost-btn"
              onClick={() => void act(async () => {
                await client.leaveGroup(groupId)
                onBack()
              })}
            >
              Leave group
            </button>
          )}
        </>
      ) : (
        <GroupChat
          groupId={groupId}
          messages={messages}
          selfId={view.identity?.userId ?? null}
          client={client}
        />
      )}
    </>
  )

  async function act(run: () => Promise<unknown>) {
    setError(null)
    try {
      await run()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'That did not work.')
    }
  }
}

export function GroupsTab({ view, client, friends, openGroupId, onOpenGroup }: GroupsTabProps) {
  const [creating, setCreating] = useState(false)
  const [error, setError] = useState<string | null>(null)

  if (openGroupId) {
    return (
      <GroupDetail
        view={view}
        client={client}
        friends={friends}
        groupId={openGroupId}
        onBack={() => onOpenGroup(null)}
      />
    )
  }

  return (
    <>
      {error && <div className="kb-inline-note">{error}</div>}

      {view.groupInvites.length > 0 && (
        <>
          <div className="kb-section-label">Invitations · {view.groupInvites.length}</div>
          {view.groupInvites.map((invite) => (
            <div className="kb-row kb-row-request" key={invite.inviteId}>
              <div className="kb-group-emoji">👥</div>
              <div className="kb-row-main">
                <div className="kb-row-name">{invite.groupName}</div>
                <div className="kb-row-status">
                  <span className="kb-handle">{invite.fromName} invited you</span>
                </div>
              </div>
              <button
                type="button"
                className="kb-join"
                onClick={() =>
                  void respond(() => client.respondToGroupInvite(invite.inviteId, true))
                }
              >
                ACCEPT
              </button>
              <button
                type="button"
                className="kb-ghost-btn kb-ghost-btn-inline"
                onClick={() =>
                  void respond(() => client.respondToGroupInvite(invite.inviteId, false))
                }
              >
                Decline
              </button>
            </div>
          ))}
        </>
      )}

      {creating ? (
        <CreateGroup client={client} onDone={() => setCreating(false)} />
      ) : (
        <>
          {view.groups.length === 0 && view.groupInvites.length === 0 ? (
            <div className="kb-quiet">
              <div className="kb-quiet-title">No groups yet.</div>
              <div className="kb-quiet-sub">
                A group is somewhere your people gather, even the ones who don&rsquo;t know each
                other.
              </div>
              <button
                type="button"
                className="kb-signin-btn kb-find-btn"
                onClick={() => setCreating(true)}
              >
                Create a group
              </button>
            </div>
          ) : (
            <>
              {view.groups.map((group) => {
                const unread = view.groupUnread[group.groupId] ?? 0
                const muted = view.mutedGroupIds.includes(group.groupId)
                return (
                  <div
                    className="kb-group-card"
                    role="button"
                    tabIndex={0}
                    key={group.groupId}
                    onClick={() => onOpenGroup(group.groupId)}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter' || event.key === ' ') {
                        event.preventDefault()
                        onOpenGroup(group.groupId)
                      }
                    }}
                  >
                    <div className="kb-group-head">
                      <GroupIcon icon={group.icon} />
                      <div className="kb-group-name">{group.name}</div>
                      {unread > 0 && (
                        <span className={`kb-tab-badge${muted ? ' kb-badge-muted' : ''}`}>
                          {unread}
                        </span>
                      )}
                      <div className="kb-group-meta">{group.memberCount}</div>
                    </div>
                    <GroupActivityLine
                      members={view.groupMembers[group.groupId] ?? []}
                      localActivity={view.localActivity}
                    />
                  </div>
                )
              })}

              <button
                type="button"
                className="kb-ghost-btn kb-create-btn"
                onClick={() => setCreating(true)}
              >
                New group
              </button>
            </>
          )}
        </>
      )}
    </>
  )

  async function respond(run: () => Promise<unknown>) {
    setError(null)
    try {
      await run()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'That did not work.')
    }
  }
}
