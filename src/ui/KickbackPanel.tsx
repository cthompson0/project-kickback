import { useEffect, useMemo, useState } from 'react'
import { ChannelLabel, ChannelNameProvider } from './ChannelNames'
import type { KickbackClient } from '../client/types'
import { useKickbackState } from './useKickbackState'
import { Avatar } from './components/Avatar'
import { FriendsTab } from './components/FriendsTab'
import { FindFriends } from './components/FindFriends'
import { IncomingRequests } from './components/IncomingRequests'
import { GroupsTab } from './components/GroupsTab'
import { JoinButton } from './components/JoinButton'
import { KickbackMark, MinimizeIcon } from './components/Icons'
import { usePanelLayout } from './layout/usePanelLayout'
import { useLayoutHint } from './layout/useLayoutHint'
import {
  AccountCard,
  EmptyFriends,
  ErrorState,
  LoadingState,
  SignInCard,
} from './components/AuthStates'

type Tab = 'friends' | 'groups'

const COLLAPSED_KEY = 'kickback:collapsed'

/**
 * Build-time constant, so a production build folds this to false and the
 * bundler drops the demo-only markup entirely - including its strings. A
 * production artifact should not merely never *show* demo wording; it should
 * not contain it.
 */
const IS_DEMO = import.meta.env.VITE_KICKBACK_MODE === 'demo'

/**
 * Panel open/closed survives navigation. Reading it synchronously (rather than
 * from chrome.storage) means the panel renders in the right state on the very
 * first frame after a page load, so navigating feels continuous.
 */
function readCollapsed(): boolean {
  try {
    return window.localStorage.getItem(COLLAPSED_KEY) === '1'
  } catch {
    return false
  }
}

function writeCollapsed(collapsed: boolean): void {
  try {
    window.localStorage.setItem(COLLAPSED_KEY, collapsed ? '1' : '0')
  } catch {
    // Storage can be unavailable; the panel just forgets its state.
  }
}

export function KickbackPanel({
  client,
  topOffset = 58,
  reservedRight = 0,
}: {
  client: KickbackClient
  /** Bottom of Twitch's top nav, so the default placement clears it. */
  topOffset?: number
  /** Width of Twitch's chat rail, so the default placement avoids it. */
  reservedRight?: number
}) {
  const view = useKickbackState(client)
  const [collapsed, setCollapsed] = useState(readCollapsed)
  const [tab, setTab] = useState<Tab>('friends')
  const [accountOpen, setAccountOpen] = useState(false)
  const [finding, setFinding] = useState(false)
  const [openGroupId, setOpenGroupId] = useState<string | null>(null)
  const [actionError, setActionError] = useState<string | null>(null)

  const { layout, gesturing, sized, onDragStart, onResizeStart, reset } = usePanelLayout({
    collapsed,
    topOffset,
    reservedRight,
  })

  const hint = useLayoutHint()

  // Starting a gesture retires the hint: they have found it.
  const beginDrag = (event: React.PointerEvent) => {
    hint.dismiss()
    onDragStart(event)
  }
  const beginResize = (edge: Parameters<typeof onResizeStart>[0]) => (event: React.PointerEvent) => {
    hint.dismiss()
    onResizeStart(edge)(event)
  }

  // A conversation is the one view worth filling the whole height budget with.
  const chatOpen = tab === 'groups' && openGroupId !== null && !finding

  useEffect(() => writeCollapsed(collapsed), [collapsed])

  // Seen semantics: expanding the panel shows any gathering, and the Friends
  // tab shows incoming requests. Looking at a thing is what clears it.
  useEffect(() => {
    if (collapsed || view.status !== 'signed_in') return
    client.markKindSeen('gathering')
  }, [collapsed, view.status, view.attention, client])

  useEffect(() => {
    if (collapsed || finding || tab !== 'friends' || view.status !== 'signed_in') return
    client.markKindSeen('friend_request')
  }, [collapsed, finding, tab, view.status, view.attention, client])

  useEffect(() => {
    if (collapsed || finding || tab !== 'groups' || view.status !== 'signed_in') return
    client.markKindSeen('group_invite')
  }, [collapsed, finding, tab, view.status, view.attention, client])

  // Invitations plus conversations with something new in them.
  const groupAttentionCount =
    view.groupInvites.length +
    view.groups.filter(
      (group) =>
        (view.groupUnread[group.groupId] ?? 0) > 0 && !view.mutedGroupIds.includes(group.groupId),
    ).length

  const { status, identity, friends, friendsHere, onlineCount, channel, incomingRequests } = view
  const signedIn = status === 'signed_in'

  async function removeFriend(userId: string) {
    setActionError(null)
    try {
      await client.removeFriend(userId)
    } catch (cause) {
      setActionError(cause instanceof Error ? cause.message : 'Could not remove that friend.')
    }
  }

  const knownPeople = useMemo(() => {
    const people = friends.map((friend) => friend.user)
    for (const roster of Object.values(view.groupMembers)) {
      for (const member of roster) people.push(member.user)
    }
    if (identity?.twitchLogin) {
      people.push({
        id: identity.userId,
        username: identity.twitchLogin,
        displayName: identity.displayName,
        avatarUrl: identity.avatarUrl,
        accentColor: '#ff8452',
      })
    }
    return people
  }, [friends, view.groupMembers, identity])

  const position = {
    '--kb-x': `${layout.x}px`,
    '--kb-y': `${layout.y}px`,
    '--kb-w': `${layout.width}px`,
    '--kb-h': `${layout.height}px`,
  } as React.CSSProperties

  if (collapsed) {
    return (
      <button
        type="button"
        className="kb-launcher"
        style={position}
        title="Open Kickback"
        onClick={() => setCollapsed(false)}
      >
        <KickbackMark size={22} />
        {/* Unseen, actionable things only. A friend changing channel is not
            news; a friend request or a gathering forming is. */}
        {view.unread.length > 0 && (
          <span className="kb-launcher-badge kb-launcher-badge-request">
            {view.unread.length}
          </span>
        )}
        {view.unread.length === 0 && friendsHere.length > 0 && (
          <span className="kb-launcher-badge">{friendsHere.length}</span>
        )}
      </button>
    )
  }

  return (
    // One resolver for the whole panel, so a channel is spelled the same way
    // in the activity line, a friend row and a group cluster.
    <ChannelNameProvider people={knownPeople} seen={view.channelNames}>
    <div
      // A height the user chose is what the panel is, not a ceiling: otherwise
      // the panel springs back to content height the moment they let go, and
      // the resize looks like it did not take. Before anyone resizes it stays
      // content-sized so a short friends list is not a tall empty box.
      className={`kb-panel${sized || chatOpen || gesturing ? ' kb-panel-filled' : ''}`}
      style={position}
    >
      <div className="kb-header" onPointerDown={beginDrag}>
        <KickbackMark />
        <span className="kb-wordmark">kickback</span>
        {IS_DEMO && view.demo && <span className="kb-demo-badge">DEMO</span>}
        <span className="kb-header-spacer" />

        {signedIn && identity && (
          <button
            type="button"
            className="kb-avatar-btn"
            title={`Signed in as ${identity.displayName}`}
            onClick={() => setAccountOpen((open) => !open)}
          >
            <Avatar
              user={{
                id: identity.userId,
                username: identity.twitchLogin ?? identity.displayName,
                displayName: identity.displayName,
                avatarUrl: identity.avatarUrl,
                accentColor: '#ff8452',
              }}
              size={22}
              showDot={false}
            />
          </button>
        )}

        <button
          type="button"
          className="kb-icon-btn"
          title="Minimize Kickback"
          onClick={() => setCollapsed(true)}
        >
          <MinimizeIcon />
        </button>
      </div>

      {/* Local Twitch activity is read from the page, so it works signed out. */}
      <div className="kb-now">
        <span className="kb-now-label">{channel ? "You're watching" : 'Right now'}</span>
        {channel ? (
          <span className="kb-now-value">
            <span className="kb-live-dot" />
            <ChannelLabel channel={channel} />
          </span>
        ) : (
          <span className="kb-now-idle">Browsing Twitch</span>
        )}
      </div>

      {signedIn && identity && accountOpen && (
        <AccountCard
          identity={identity}
          onSignOut={() => {
            setAccountOpen(false)
            client.signOut()
          }}
          preferences={view.preferences}
          onPreferencesChange={(patch) => {
            setActionError(null)
            client.setPreferences(patch).catch((cause: unknown) => {
              setActionError(
                cause instanceof Error ? cause.message : 'Could not save that setting.',
              )
            })
          }}
          onResetLayout={reset}
          onVisibilityChange={(mode) => {
            setActionError(null)
            client.setPresenceVisibility(mode).catch((cause: unknown) => {
              setActionError(
                cause instanceof Error ? cause.message : 'Could not change your presence setting.',
              )
            })
          }}
        />
      )}

      {status === 'loading' && <LoadingState />}

      {status === 'error' && (
        <ErrorState message={view.error ?? 'Something went wrong.'} onRetry={() => client.retry()} />
      )}

      {status === 'signed_out' && (
        <>
          {view.error && <div className="kb-inline-note">{view.error}</div>}
          <SignInCard onSignIn={() => client.signIn()} busy={view.signingIn} />
        </>
      )}

      {signedIn && (
        <>
          {friendsHere.length > 0 && (
            <div className="kb-here-banner">
              <div className="kb-avatar-stack">
                {friendsHere.slice(0, 4).map((friend) => (
                  <Avatar key={friend.user.id} user={friend.user} size={20} showDot={false} />
                ))}
              </div>
              <span className="kb-here-banner-text">
                {friendsHere.length === 1
                  ? `${friendsHere[0].user.displayName} is here`
                  : `${friendsHere.length} friends are here`}
              </span>
            </div>
          )}

          {/* Friends clustered somewhere else - the "everyone is over there"
              signal from Phase 0, now backed by real presence. */}
          {view.gatherings.slice(0, 1).map((gathering) => (
            <div className="kb-gathering kb-gathering-banner" key={gathering.channel}>
              <span className="kb-gathering-text">
                🔥 {gathering.userIds.length} friends watching{' '}
                <ChannelLabel channel={gathering.channel} />
              </span>
              <JoinButton channel={gathering.channel} source="gathering" />
            </div>
          ))}

          <div className="kb-tabs">
            <button
              type="button"
              className={`kb-tab${tab === 'friends' && !finding ? ' kb-tab-active' : ''}`}
              onClick={() => {
                setTab('friends')
                setFinding(false)
              }}
            >
              Friends
              {friends.length > 0 && (
                <span className="kb-tab-count">
                  {view.hasPresence ? `${onlineCount}/${friends.length}` : friends.length}
                </span>
              )}
              {incomingRequests.length > 0 && (
                <span className="kb-tab-badge">{incomingRequests.length}</span>
              )}
            </button>
            <button
              type="button"
              className={`kb-tab${tab === 'groups' && !finding ? ' kb-tab-active' : ''}`}
              onClick={() => {
                setTab('groups')
                setFinding(false)
              }}
            >
              Groups
              {view.groups.length > 0 && <span className="kb-tab-count">{view.groups.length}</span>}
              {groupAttentionCount > 0 && (
                <span className="kb-tab-badge">{groupAttentionCount}</span>
              )}
            </button>
            <span className="kb-header-spacer" />
            <button
              type="button"
              className={`kb-add-btn${finding ? ' kb-add-btn-active' : ''}`}
              title="Find friends"
              onClick={() => setFinding((open) => !open)}
            >
              + Add
            </button>
          </div>

          <div className={`kb-body${chatOpen ? ' kb-body-chat' : ''}`}>
            {finding ? (
              <FindFriends
                client={client}
                outgoingRequests={view.outgoingRequests}
                onBack={() => setFinding(false)}
              />
            ) : tab === 'groups' ? (
              <GroupsTab
                view={view}
                client={client}
                friends={friends}
                openGroupId={openGroupId}
                onOpenGroup={setOpenGroupId}
              />
            ) : (
              <>
                {actionError && <div className="kb-inline-note">{actionError}</div>}
                {view.friendsError && <div className="kb-inline-note">{view.friendsError}</div>}

                <IncomingRequests
                  requests={incomingRequests}
                  client={client}
                  onError={setActionError}
                />

                {friends.length === 0 ? (
                  incomingRequests.length === 0 && (
                    <EmptyFriends
                      loading={view.friendsLoading}
                      onFindFriends={() => setFinding(true)}
                    />
                  )
                ) : (
                  <FriendsTab
                    friends={friends}
                    localActivity={view.localActivity}
                    onRemove={removeFriend}
                  />
                )}
              </>
            )}
          </div>
        </>
      )}

      {hint.visible ? (
        <div className="kb-footer kb-hint">
          <span className="kb-hint-text">Drag header · Resize corners</span>
          <button
            type="button"
            className="kb-hint-close"
            title="Got it"
            aria-label="Dismiss hint"
            onClick={hint.dismiss}
          >
            ×
          </button>
        </div>
      ) : (
        <div className="kb-footer">
          <span>Kickback</span>
          <span className="kb-footer-dot" />
          <span title="Kickback version">
            {IS_DEMO && view.demo ? 'demo mode — mock data' : `v${__KICKBACK_VERSION__}`}
          </span>
        </div>
      )}

      {/* Grips on both bottom corners, because the panel can be parked on
          either side of the window and only one of them is natural there. */}
      <div className="kb-resize kb-resize-sw" onPointerDown={beginResize('sw')} />
      <div className="kb-resize kb-resize-s" onPointerDown={beginResize('s')} />
      <div className="kb-resize kb-resize-se" onPointerDown={beginResize('se')} />
    </div>
    </ChannelNameProvider>
  )
}
