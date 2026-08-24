import { useEffect, useMemo, useState } from 'react'
import type { Activity } from '../../core/types'
import { effectiveStatus, findGatherings, isHere } from '../../core/presence'
import { useChannelName } from '../ChannelNames'
import { GroupPresence } from './GroupPresence'
import { GroupIcon, GroupIconPicker } from './GroupIcon'
import { GroupActivitySummary } from './GroupActivitySummary'
import type { UserCardContext } from './UserCard'
import type { Friend, GroupMember, KickbackClient, KickbackState } from '../../client/types'
import { Avatar } from './Avatar'
import { BackIcon } from './Icons'
import { JoinButton } from './JoinButton'
import { GroupChat } from './GroupChat'
import { useAnalytics } from '../Analytics'

/**
 * Groups: what your people are doing, and a place to talk about it.
 *
 * The list leads with activity rather than administration - a group should
 * read as somewhere alive before it reads as a thing you manage.
 */

/** Stable empty roster; see the note where it is used. */
const NO_MEMBERS: GroupMember[] = []

interface GroupsTabProps {
  view: KickbackState & { localActivity: Activity }
  client: KickbackClient
  /** The one card context, built by the panel and shared by every surface. */
  cardContext: UserCardContext
  friends: Friend[]
  openGroupId: string | null
  onOpenGroup: (groupId: string | null) => void
}

/**
 * What a group is up to, from its members' real presence.
 *
 * Everything here answers "how many OTHER people", so the viewer is dropped
 * before anything is counted. Counting yourself made a group of one look like
 * company.
 */
function useGroupActivity(
  members: GroupMember[],
  localActivity: Activity,
  selfId: string | null,
) {
  return useMemo(() => {
    const presences = members
      .filter((member) => member.user.id !== selfId)
      .flatMap((member) => (member.presence ? [member.presence] : []))
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
  }, [members, localActivity, selfId])
}

function GroupActivityLine({
  members,
  localActivity,
  selfId,
}: {
  members: GroupMember[]
  localActivity: Activity
  selfId: string | null
}) {
  const activity = useGroupActivity(members, localActivity, selfId)
  const channelName = useChannelName()

  if (activity.hereCount > 0) {
    return (
      <div className="kb-gathering kb-gathering-here">
        <span className="kb-gathering-text">
          {activity.hereCount === 1
            ? '1 member is watching with you'
            : `${activity.hereCount} members are watching with you`}
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
          <JoinButton
            channel={biggest.channel}
            source="group"
            label="JOIN THEM"
            socialCount={biggest.userIds.length}
          />
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
  cardContext,
  onBack,
}: {
  view: GroupsTabProps['view']
  client: KickbackClient
  friends: Friend[]
  groupId: string
  cardContext: UserCardContext
  onBack: () => void
}) {
  const group = view.groups.find((entry) => entry.groupId === groupId)
  // Stable identity when the group has no roster yet, so the memos below are
  // not invalidated by a fresh [] on every render.
  const members = view.groupMembers[groupId] ?? NO_MEMBERS
  const messages = view.groupMessages[groupId] ?? []
  const muted = view.mutedGroupIds.includes(groupId)
  const [managing, setManaging] = useState(false)
  /** Which invite is in flight, so the button cannot be double-fired. */
  const [inviting, setInviting] = useState<string | null>(null)
  /** Which pending invite is being withdrawn, awaiting confirmation. */
  const [cancelling, setCancelling] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [confirmDelete, setConfirmDelete] = useState(false)


  // Looking at a group is what marks it read.
  useEffect(() => {
    client.markGroupRead(groupId)
  }, [client, groupId, messages.length])


  // Invite state only. Card context comes from the panel, so it is not
  // rebuilt here - one place assembles it, every surface reads it. Computed
  // above the early return below, because hook order cannot depend on a
  // branch.
  const memberIds = useMemo(() => new Set(members.map((member) => member.user.id)), [members])
  const pendingIds = useMemo(
    () => new Set(view.groupSentInvites[groupId] ?? []),
    [view.groupSentInvites, groupId],
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

  /**
   * Every friend, with where they stand relative to this group.
   *
   * Members used to be filtered out entirely, so "why isn't Matt in this
   * list" had no answer on screen. Showing them as MEMBER says it plainly,
   * and the state comes from the server rather than from remembering a click,
   * so it survives a reload.
   */
  const inviteRows = friends.map((friend) => ({
    friend,
    state: memberIds.has(friend.user.id)
      ? ('member' as const)
      : pendingIds.has(friend.user.id)
        ? ('pending' as const)
        : ('none' as const),
  }))
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

      <GroupActivityLine
        members={members}
        localActivity={view.localActivity}
        selfId={view.identity?.userId ?? null}
      />
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
            cardContext={cardContext}
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

          {group.isOwner && inviteRows.length > 0 && (
            <>
              <div className="kb-section-label">Invite a friend</div>
              {inviteRows.map(({ friend, state }) => (
                <div className="kb-row" key={friend.user.id}>
                  <Avatar user={friend.user} showDot={false} />
                  <div className="kb-row-main">
                    <div className="kb-row-name">{friend.user.displayName}</div>
                  </div>
                  {state === 'none' ? (
                    <button
                      type="button"
                      className="kb-join"
                      disabled={inviting === friend.user.id}
                      onClick={() => {
                        setInviting(friend.user.id)
                        void act(
                          () => client.inviteToGroup(groupId, friend.user.id),
                          () => setInviting(null),
                        )
                      }}
                    >
                      {inviting === friend.user.id ? '…' : 'INVITE'}
                    </button>
                  ) : state === 'member' ? (
                    // Nothing to do: a control that looks pressable but is not
                    // would be worse than a label.
                    <span className="kb-relation kb-relation-member">MEMBER</span>
                  ) : cancelling === friend.user.id ? (
                    // One deliberate confirmation, so PENDING is never
                    // withdrawn by a stray click.
                    <span className="kb-relation-confirm">
                      <button
                        type="button"
                        className="kb-ghost-btn kb-ghost-btn-inline kb-confirm-yes"
                        onClick={() =>
                          void act(
                            () => client.cancelGroupInvite(groupId, friend.user.id),
                            () => setCancelling(null),
                          )
                        }
                      >
                        Cancel invite
                      </button>
                      <button
                        type="button"
                        className="kb-ghost-btn kb-ghost-btn-inline"
                        onClick={() => setCancelling(null)}
                      >
                        Keep
                      </button>
                    </span>
                  ) : (
                    <button
                      type="button"
                      className="kb-relation kb-relation-pending kb-relation-btn"
                      title={`Cancel the invitation to ${friend.user.displayName}`}
                      onClick={() => setCancelling(friend.user.id)}
                    >
                      PENDING
                    </button>
                  )}
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
        <>
          {/* Where the group is, above chat, without the whole roster. */}
          <GroupActivitySummary
            members={members}
            localActivity={view.localActivity}
            selfId={view.identity?.userId ?? null}
          />
          <GroupChat
            groupId={groupId}
            messages={messages}
            selfId={view.identity?.userId ?? null}
            client={client}
            members={members}
            cardContext={cardContext}
          />
        </>
      )}
    </>
  )

  async function act(run: () => Promise<unknown>, always?: () => void) {
    setError(null)
    try {
      await run()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'That did not work.')
    } finally {
      always?.()
    }
  }
}

export function GroupsTab({
  view,
  client,
  friends,
  cardContext,
  openGroupId,
  onOpenGroup,
}: GroupsTabProps) {
  const [creating, setCreating] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const analytics = useAnalytics()

  if (openGroupId) {
    return (
      <GroupDetail
        view={view}
        client={client}
        friends={friends}
        groupId={openGroupId}
        cardContext={cardContext}
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
                /*
                 * Recorded here rather than in an effect inside the open group.
                 *
                 * Opening is something the user DID, and this is where they did
                 * it. An effect over there would re-run on every arriving
                 * message, turning one busy conversation into a stream of
                 * "opened" events - and the roster size it wants is right here.
                 */
                const open = () => {
                  analytics.track(
                    'group_opened',
                    { member_count: group.memberCount },
                    { source: 'group' },
                  )
                  onOpenGroup(group.groupId)
                }
                return (
                  <div
                    className="kb-group-card"
                    role="button"
                    tabIndex={0}
                    key={group.groupId}
                    onClick={open}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter' || event.key === ' ') {
                        event.preventDefault()
                        open()
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
                      selfId={view.identity?.userId ?? null}
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
