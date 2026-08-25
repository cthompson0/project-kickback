import { useEffect, useMemo, useState } from 'react'
import { ChannelLabel, ChannelNameProvider } from './ChannelNames'
import { AnalyticsProvider } from './Analytics'
import { describePresence } from '../core/personPresence'
import type { KickbackClient } from '../client/types'
import { useKickbackState } from './useKickbackState'
import { Avatar } from './components/Avatar'
import { FriendsTab } from './components/FriendsTab'
import { SocialGravity } from './components/SocialGravity'
import { StreamRoom } from './components/StreamRoom'
import { gravityOpportunities, socialGravity } from '../core/socialGravity'
import { resolveArm } from '../core/experiment'
import { FindFriends } from './components/FindFriends'
import { IncomingRequests } from './components/IncomingRequests'
import { GroupsTab } from './components/GroupsTab'
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
  /*
   * The Stream Room the viewer has walked into, by channel login.
   *
   * Held here rather than in the card, because the room is a VIEW: it takes
   * over the body the way a group conversation does, and Back returns to the
   * map with the card exactly as it was. The card is not unmounted while the
   * room is open, so HERE, its count and its people are still there on the way
   * back rather than rebuilt.
   */
  const [openRoomChannel, setOpenRoomChannel] = useState<string | null>(null)
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

  /*
   * The room is only open while the viewer is still on that channel.
   *
   * Derived rather than stored, so leaving the channel closes it without
   * anything having to notice: presence already moved, and a room for a stream
   * you walked away from is a room you are not in. Rooms also require a live
   * stream, so a stream ending closes it the same way, through the same
   * derivation - see roomMembers, which the worker empties.
   */
  const roomOpen =
    tab === 'friends' &&
    !finding &&
    openRoomChannel !== null &&
    openRoomChannel === view.channel &&
    view.roomMembers.length > 0

  // A conversation and a room are the two views worth the whole height budget.
  const chatOpen = (tab === 'groups' && openGroupId !== null && !finding) || roomOpen

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

  /*
   * Which arm this user is in.
   *
   * Everything outside production sees Gravity - a holdout across a handful of
   * beta testers measures nothing and costs the feature half the people who
   * are there to test it. Production splits deterministically by user id.
   * See core/experiment.ts; nothing here is a causal claim.
   */
  const arm = resolveArm({
    userId: view.identity?.userId ?? null,
    environment: import.meta.env.VITE_KICKBACK_ENV ?? 'development',
  })

  /**
   * The same map the Friends tab draws, for the exposure report.
   *
   * Derived from the same selector rather than re-clustered, so what analytics
   * calls an impression is exactly what was on screen. Recomputing it a second
   * way would be a second chance to disagree.
   */
  const gravityMap = useMemo(
    () =>
      socialGravity(
        view.friends.map((friend) => ({
          member: friend,
          presence: friend.presence,
          userId: friend.user.id,
        })),
        view.localActivity,
        undefined,
        view.identity?.userId ?? null,
        /*
         * What Twitch says about each destination.
         *
         * The selector applies the freshness rule, so a record old enough to
         * have stopped being evidence reports `unknown` - which ranks and
         * renders exactly as no metadata at all.
         */
        view.channelMetadata,
      ),
    [view.friends, view.localActivity, view.identity?.userId, view.channelMetadata],
  )

  /*
   * What social information is actually on screen.
   *
   * The panel reports the whole visible SET, and the worker decides what
   * counts as a new impression - see exposure.ts. Doing it that way is what
   * makes the number mean something: a realtime presence update re-renders
   * this list, and an impression per render would report fifty exposures for
   * one glance.
   *
   * Nothing is reported while the panel is collapsed. A launcher badge is a
   * notification, not an exposure: the user has not been shown who is where.
   */
  const visibleSocial = useMemo(() => {
    if (collapsed || view.status !== 'signed_in') {
      return { friends: [], gatherings: [], gravity: [] }
    }

    const viewer = view.channel
      ? ({ type: 'watching', platform: 'twitch', channel: view.channel } as const)
      : ({ type: 'browsing', platform: 'twitch' } as const)

    return {
      friends: view.friends.flatMap((friend) => {
        const presence = describePresence(friend.presence, viewer)
        if (presence.kind !== 'watching_with_you' && presence.kind !== 'watching_elsewhere') {
          return []
        }
        if (!presence.channel) return []
        return [{ userId: friend.user.id, channel: presence.channel, state: presence.kind }]
      }),
      /*
       * The gathering banner is gone, so nothing draws a gathering any more
       * and nothing may report one as shown. Social Gravity is the in-panel
       * representation now, and gravity_cluster_impression is what records it.
       */
      gatherings: [],
      /*
       * Every destination the map is actually showing, in rank order. Only
       * joinable ones: the channel the viewer is already on is not an
       * opportunity, and counting it would put rows that can never convert
       * into the conversion denominator.
       */
      gravity:
        arm === 'gravity'
          ? gravityOpportunities(gravityMap).map((section) => ({
              channel: section.channel,
              friendCount: section.count,
              rank: section.rank,
              /*
               * Whether the destination we showed was actually streaming.
               *
               * The one metadata field analytics carries. It answers "are we
               * sending people to streams that have ended", which is a
               * question about whether the map is worth acting on. Titles,
               * viewer counts, categories and avatars are deliberately not
               * here: none of them answers a question we have.
               */
              live: section.live,
            }))
          : [],
    }
  }, [collapsed, view.status, view.friends, view.channel, arm, gravityMap])

  useEffect(() => {
    client.reportExposure(visibleSocial)
  }, [client, visibleSocial])

  // Invitations plus conversations with something new in them.
  const groupAttentionCount =
    view.groupInvites.length +
    view.groups.filter(
      (group) =>
        (view.groupUnread[group.groupId] ?? 0) > 0 && !view.mutedGroupIds.includes(group.groupId),
    ).length

  const { status, identity, friends, friendsHere, onlineCount, channel, incomingRequests } = view

  /**
   * One context for every user card in the panel.
   *
   * Built here because this is the only place that knows all of it, and
   * threaded down rather than reassembled per surface - three call sites
   * computing "what is the viewer doing" three times is three chances for one
   * of them to forget, which is exactly how group chat came to offer a JOIN
   * to the stream the viewer was already watching.
   */
  const cardContext = useMemo(
    () => ({
      selfId: identity?.userId ?? null,
      viewerActivity: view.localActivity,
      friendIds: new Set(friends.map((friend) => friend.user.id)),
      outgoingRequestIds: new Set(view.outgoingRequests.map((request) => request.user.id)),
    }),
    [identity, view.localActivity, friends, view.outgoingRequests],
  )

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
    <ChannelNameProvider
      people={knownPeople}
      seen={view.channelNames}
      metadata={view.channelMetadata}
    >
    <AnalyticsProvider client={client}>
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

          {/*
            * The gathering banner used to live here.
            *
            * It said "N friends watching X" with a JOIN, which is exactly what
            * the top card of Social Gravity now says - so keeping both would
            * have shown one gathering twice and counted one exposure twice.
            * The map is the in-panel representation now.
            *
            * Notifications are untouched: gatherings.ts still decides when a
            * gathering is worth interrupting somebody for, with the same
            * threshold and cooldown, and gathering_notification_shown and
            * _clicked still fire. See docs/ANALYTICS.md for what this means
            * for gathering_impression.
            */}

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
            {roomOpen && openRoomChannel ? (
              /*
               * Arriving somewhere.
               *
               * Rendered instead of the map rather than inside it, which is the
               * whole correction: the previous version expanded a section of a
               * card and called that a room. Nothing is created by getting
               * here - membership is the connected component the server already
               * computes from presence - so Back is genuinely just going back.
               */
              <StreamRoom
                channel={openRoomChannel}
                members={view.roomMembers}
                friends={friends}
                reactions={view.togetherReactions}
                metadata={view.channelMetadata?.[openRoomChannel]}
                selfId={identity?.userId ?? null}
                client={client}
                cardContext={cardContext}
                onBack={() => setOpenRoomChannel(null)}
              />
            ) : finding ? (
              <FindFriends
                client={client}
                outgoingRequests={view.outgoingRequests}
                onBack={() => setFinding(false)}
              />
            ) : tab === 'groups' ? (
              <GroupsTab
                view={view}
                client={client}
                cardContext={cardContext}
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
                ) : arm === 'gravity' ? (
                  <SocialGravity
                    friends={friends}
                    localActivity={view.localActivity}
                    onRemove={removeFriend}
                    client={client}
                    cardContext={cardContext}
                    metadata={view.channelMetadata}
                    reactions={view.togetherReactions}
                    roomMembers={view.roomMembers}
                    onOpenRoom={setOpenRoomChannel}
                  />
                ) : (
                  /* The control arm keeps the flat list it always had. */
                  <FriendsTab
                    friends={friends}
                    localActivity={view.localActivity}
                    onRemove={removeFriend}
                    client={client}
                    cardContext={cardContext}
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
    </AnalyticsProvider>
    </ChannelNameProvider>
  )
}
