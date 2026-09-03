import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { humanMessage } from '../core/errors'
import { VIOLET as BRAND_ACCENT } from '../../assets/brand/geometry.mjs'
import { ChannelLabel, ChannelNameProvider, useChannelName } from './ChannelNames'
import { AnalyticsProvider, useAnalytics } from './Analytics'
import { describePresence } from '../core/personPresence'
import type { KickbackClient } from '../client/types'
import type { RoomMember } from '../core/streamRoom'
import type { RoomOpenedFrom } from '../core/analytics'
import { useKickbackState } from './useKickbackState'
import { Avatar } from './components/Avatar'
import { AVATAR_SIZE } from './avatarSizes'
import { FriendsTab } from './components/FriendsTab'
import { SocialGravity } from './components/SocialGravity'
import { StreamSession } from './components/StreamSession'
import { gravityModel, gravityOpportunities } from '../core/socialGravity'
import { resolveArm } from '../core/experiment'
import { FindFriends } from './components/FindFriends'
import { IncomingRequests } from './components/IncomingRequests'
import { GroupsTab } from './components/GroupsTab'
import { WatchsideMark, MinimizeIcon } from './components/Icons'
import { usePanelLayout } from './layout/usePanelLayout'
import { useLayoutHint } from './layout/useLayoutHint'
import { useStorageSync } from './useStorageSync'
import { readTextSize, scaleFor, TEXT_SIZE_KEY, parseTextSize, writeTextSize } from './textSize'
import type { TextSize } from './textSize'
import {
  AccountCard,
  FeedbackForm,
  EmptyFriends,
  ErrorState,
  LoadingState,
  SignInCard,
} from './components/AuthStates'

/**
 * Friends, the contextual session, Groups.
 *
 * 'session' only exists while there is one - see `sessionAvailable` - and
 * selecting it is never automatic. A tab appearing must not move somebody's
 * feet.
 */
type Tab = 'friends' | 'groups' | 'session'

/**
 * The contextual streamer tab.
 *
 * A component rather than markup inline in the panel, for the reason
 * ChannelLabel exists: the shell RENDERS the ChannelNameProvider and
 * therefore cannot consume it, so calling useChannelName() up there returns
 * the identity fallback and the tab reads "lirik" where Twitch says "LIRIK".
 * Down here it is inside the provider and gets the authoritative casing -
 * for the label and, just as importantly, for the title that carries the
 * full name when the label is truncated.
 */
function SessionTab({
  channel,
  active,
  unread,
  onSelect,
}: {
  channel: string
  active: boolean
  unread: number
  onSelect: () => void
}) {
  const name = useChannelName()(channel)

  return (
    <button
      type="button"
      className={`kb-tab kb-tab-session${active ? ' kb-tab-active' : ''}`}
      title={name}
      aria-pressed={active}
      onClick={onSelect}
    >
      <span className="kb-tab-streamer">{name}</span>
      {unread > 0 && !active && (
        <span className="kb-tab-badge">{unread > 9 ? '9+' : unread}</span>
      )}
    </button>
  )
}

const COLLAPSED_KEY = 'kickback:collapsed'

/**
 * Stable empties, so a channel with no room yet does not hand a fresh array to
 * a memo on every render.
 */
const EMPTY_IDS: string[] = []
const EMPTY_MEMBERS: RoomMember[] = []

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

/**
 * The Stream Room was actually opened, and by which route.
 *
 * WHY THIS EXISTS AT ALL. `automatic_room_entered` says the contextual tab
 * BECAME AVAILABLE - it fires whether or not anybody looks. The whole
 * navigation bet behind Stream Rooms is that a tab named after the streamer
 * gets opened on its own, and nothing measured whether that ever happened. For
 * a feature whose open question is "would anybody miss this", that was the one
 * number worth having.
 *
 * Emitted on the transition into open, once per opening, deliberately not on
 * every render while it stays open - a room somebody leaves running is one
 * opening, which is what a person would count.
 */
function RoomOpenedProbe({
  open,
  channel,
  participantCount,
  directFriendCount,
  openedFromRef,
}: {
  open: boolean
  channel: string | null
  participantCount: number
  directFriendCount: number
  /*
   * The ref itself rather than its value, because the route is read at the
   * moment of opening and reading a ref during render is both a lint error and
   * a real one - the render that shows the room is not necessarily the render
   * on which the route was chosen.
   */
  openedFromRef: { current: RoomOpenedFrom }
}) {
  const analytics = useAnalytics()
  const reported = useRef<string | null>(null)

  useEffect(() => {
    if (!open || !channel) {
      // Closing arms the next opening, so returning to the same room counts
      // again. Without this, a person who opened it twice would look like one.
      reported.current = null
      return
    }
    if (reported.current === channel) return
    reported.current = channel

    analytics.track(
      'automatic_room_opened',
      {
        participant_count: participantCount,
        direct_friend_count: directFriendCount,
        opened_from: openedFromRef.current,
      },
      { source: 'together', channel },
    )
  }, [open, channel, participantCount, directFriendCount, openedFromRef, analytics])

  return null
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
  /*
   * Another Twitch tab opened or closed the panel.
   *
   * The value has always been shared - localStorage is origin-scoped - but it
   * was only ever READ once, in the initialiser above, so a new tab inherited
   * it and an already-open tab never moved. Listening is the whole fix; see
   * useStorageSync.ts for why this cannot echo.
   */
  const applyRemoteCollapsed = useCallback((value: string | null) => {
    setCollapsed(value === '1')
  }, [])
  useStorageSync(COLLAPSED_KEY, applyRemoteCollapsed)

  /*
   * The text-size preference.
   *
   * Read synchronously, for the same reason the collapsed flag above is:
   * arriving a frame late would mean every page load draws at the default
   * size and then visibly reflows to the size the user actually chose.
   */
  const [textSize, setTextSize] = useState<TextSize>(readTextSize)
  const applyRemoteTextSize = useCallback((value: string | null) => {
    setTextSize(parseTextSize(value))
  }, [])
  useStorageSync(TEXT_SIZE_KEY, applyRemoteTextSize)
  const chooseTextSize = useCallback((size: TextSize) => {
    setTextSize(size)
    writeTextSize(size)
  }, [])

  const [accountOpen, setAccountOpen] = useState(false)
  /** The feedback form, which is a sub-view of the account panel. */
  const [feedbackOpen, setFeedbackOpen] = useState(false)
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
  /**
   * Which tab the viewer has chosen, or null for "has not chosen yet".
   *
   * Their INTENT, never the answer. The session tab can stop existing under
   * them, so the resolved `tab` below is derived - storing the resolved value
   * would leave a frame where the panel is showing a room nobody is in.
   *
   * Null is what makes a Twitch refresh land back where they were: before any
   * click, the worker's remembered selection decides, and the moment they
   * choose anything - including Friends - their choice wins for good.
   */
  const [requestedTab, setRequestedTab] = useState<Tab | null>(null)
  const [actionError, setActionError] = useState<string | null>(null)

  const {
    layout,
    gesturing,
    sized,
    onDragStart,
    onLauncherDragStart,
    wasDragged,
    onResizeStart,
    reset,
  } = usePanelLayout({
    collapsed,
    topOffset,
    reservedRight,
  })

  const hint = useLayoutHint()

  /*
   * Escape closes the account panel.
   *
   * Registered in the bubble phase while the UserCard listens in capture, so an
   * open card gets first refusal and marks the event handled. Innermost thing
   * wins, which is what a person pressing Escape means by it.
   */
  useEffect(() => {
    if (!accountOpen) return
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented) return
      // Innermost first, here too: Escape out of the feedback form returns to
      // the account panel rather than closing both and losing where you were.
      if (feedbackOpen) setFeedbackOpen(false)
      else setAccountOpen(false)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [accountOpen, feedbackOpen])

  /**
   * Choose a tab, and tell the worker when that choice is a session.
   *
   * The worker is what remembers it across a Twitch refresh, and what marks
   * the conversation read - both of which have to outlive this component,
   * because the panel is torn down on every navigation.
   */
  /*
   * Which way into the Stream Room was used, for the one event that answers
   * whether the contextual tab earns its place. A ref rather than state: it
   * feeds an effect and must never itself cause a render.
   */
  const openedFrom = useRef<RoomOpenedFrom>('restored')

  const chooseTab = (next: Tab) => {
    setRequestedTab(next)
    setFinding(false)
    // How the session was reached, for automatic_room_opened. A choice made
    // here is 'tab'; a session resolved with no choice at all is 'restored'.
    if (next === 'session') openedFrom.current = 'tab'
    if (next === 'session' && sessionChannel) client.selectSession(sessionChannel)
    // Leaving is remembered as leaving, so a refresh does not put them back.
    else if (tab === 'session') client.selectSession(null)
  }

  // Starting a gesture retires the hint: they have found it.
  const beginDrag = (event: React.PointerEvent) => {
    hint.dismiss()
    onDragStart(event)
  }
  const beginResize = (edge: Parameters<typeof onResizeStart>[0]) => (event: React.PointerEvent) => {
    hint.dismiss()
    onResizeStart(edge)(event)
  }
  const beginLauncherDrag = (event: React.PointerEvent) => {
    hint.dismiss()
    onLauncherDragStart(event)
  }

  /*
   * Is there a session to be in?
   *
   * The server's membership answers it, which already implies the stream is
   * live and that we are on it - stream_room_members refuses otherwise. So
   * this is one condition rather than four that could disagree.
   */
  const sessionChannel = view.channel
  /*
   * Either kind of evidence, and that is the arrival fix.
   *
   * roomPeers is authenticated presence - the same evidence the HERE card
   * draws "1 friend watching with you" from - and roomMembers is the server,
   * which is what adds anybody reached THROUGH a friend. Requiring only the
   * second meant the tab waited on a graph query to rediscover a friend the
   * client could already see, and that round trip is where every arrival
   * failure happened.
   *
   * Nothing about who RECEIVES a message changes: that is still decided
   * server-side, in send_room_message.
   */
  /*
   * THIS TAB'S ROOM.
   *
   * `sessionChannel` is `view.channel` - what THIS content script reads from
   * its own URL - so two Twitch tabs render two different rooms from the same
   * broadcast without either knowing the other exists. That is the whole of
   * the multi-room UI: the room you get is the room you are looking at.
   *
   * The worker now broadcasts every room it holds, keyed by channel, so
   * selecting this tab's entry cannot disturb another tab's.
   */
  const roomPeers = (sessionChannel && view.roomPeers[sessionChannel]) || EMPTY_IDS
  const roomMembers = (sessionChannel && view.roomMembers[sessionChannel]) || EMPTY_MEMBERS
  const roomUnread = (sessionChannel && view.roomUnread[sessionChannel]) || 0

  /*
   * THE ROOM LIFECYCLE, which supersedes the Patch 1 workaround.
   *
   * A room is available while somebody else is here, OR while its conversation
   * still exists. The second condition is what stops a readable conversation
   * vanishing mid-sentence when the last peer leaves - beta finding #10, and
   * the reason the temporary fix existed at all.
   *
   * It introduces NO new clock and NO new lifetime. The worker prunes its
   * buffer to RETENTION_MS, so an expired message is not in `roomMessages` by
   * the time this reads it: when the last message ages out, the surface goes
   * on its own. That is why this is not a lease.
   *
   * Nothing about who RECEIVES a message changes: that is still decided
   * server-side at send time, in send_room_message.
   */
  const retainedHere =
    sessionChannel !== null &&
    view.roomMessages.some((message) => message.channel === sessionChannel)

  const sessionAvailable =
    sessionChannel !== null && (roomPeers.length > 0 || roomMembers.length > 0 || retainedHere)

  /*
   * The tab actually shown.
   *
   * Two resolutions in one expression, and neither is stored:
   *
   *   * no choice yet, and the worker remembered a session that is still real
   *     -> open it. That is refresh continuity, and it needs no effect;
   *   * a session was chosen and has stopped existing -> Friends. Falling back
   *     rather than clearing the request means the viewer is not permanently
   *     ejected by a friend blinking out for a heartbeat.
   */
  const restorable = view.sessionChannel !== null && sessionAvailable
  const tab: Tab =
    requestedTab === null
      ? restorable
        ? 'session'
        : 'friends'
      : requestedTab === 'session' && !sessionAvailable
        ? 'friends'
        : requestedTab
  const sessionOpen = tab === 'session' && !finding && sessionAvailable

  // A conversation and a session are the two views worth the whole height.
  const chatOpen = (tab === 'groups' && openGroupId !== null && !finding) || sessionOpen

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
   * Looking at the conversation is what makes it read.
   *
   * Re-run as messages arrive while the tab is open, so unread does not
   * start climbing behind a session somebody is actually watching.
   */
  useEffect(() => {
    if (collapsed || !sessionOpen || !sessionChannel) return
    client.selectSession(sessionChannel)
  }, [collapsed, sessionOpen, sessionChannel, view.roomMessages.length, client])

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
      /*
       * THE canonical model, and the same call SocialGravity makes.
       *
       * Not a second derivation for analytics: the exposure report below is a
       * PROJECTION of this, through gravityOpportunities. That is the whole
       * point - "analytics said three impressions, the screen showed one" is
       * unreachable when there is one answer to what the map contains.
       */
      gravityModel({
        friends: view.friends.map((friend) => ({
          member: friend,
          presence: friend.presence,
          userId: friend.user.id,
        })),
        destinations: view.friendDestinations,
        localActivity: view.localActivity,
        selfId: view.identity?.userId ?? null,
        metadata: view.channelMetadata,
      }),
    [
      view.friends,
      view.friendDestinations,
      view.localActivity,
      view.identity?.userId,
      view.channelMetadata,
    ],
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
      mutedUserIds: view.mutedUserIds,
      blockedUserIds: new Set(view.blockedUsers.map((entry) => entry.user.id)),
    }),
    [
      identity,
      view.localActivity,
      friends,
      view.outgoingRequests,
      view.mutedUserIds,
      view.blockedUsers,
    ],
  )

  const signedIn = status === 'signed_in'

  async function removeFriend(userId: string) {
    setActionError(null)
    try {
      await client.removeFriend(userId)
    } catch (cause) {
      setActionError(humanMessage(cause, 'Could not remove that friend.'))
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
        accentColor: BRAND_ACCENT,
      })
    }
    return people
  }, [friends, view.groupMembers, identity])

  const position = {
    // One number reaches all 108 font-sizes in the sheet; see textSize.ts.
    '--kb-text-scale': String(scaleFor(textSize)),
    '--kb-x': `${layout.x}px`,
    '--kb-y': `${layout.y}px`,
    '--kb-w': `${layout.width}px`,
    '--kb-h': `${layout.height}px`,
  } as React.CSSProperties

  /**
   * What the collapsed launcher is, in words.
   *
   * Ordered the way the badges are, so the title always describes whichever
   * one is actually drawn - waiting items win, then presence, then neither.
   * "Waiting" rather than "unread": these are requests and gatherings, and
   * calling them unread would reintroduce the notification reading that the
   * numeral was removed for.
   */
  const launcherTitle =
    view.unread.length > 0
      ? `Open Watchside · ${view.unread.length} waiting`
      : friendsHere.length > 0
        ? `Open Watchside · ${friendsHere.length} ${
            friendsHere.length === 1 ? 'friend' : 'friends'
          } here`
        : 'Open Watchside'

  if (collapsed) {
    return (
      <button
        type="button"
        className="kb-launcher"
        style={position}
        /*
         * The dot says "somebody is here"; this says who and how many.
         *
         * Dropping the numeral must not drop the information, and a title is
         * where it belongs: available on hover and to a screen reader, absent
         * from the visual language that caused the confusion. It is also the
         * accessible name of this button, which previously said only "Open
         * Watchside" no matter what the badge was showing.
         */
        title={launcherTitle}
        onPointerDown={beginLauncherDrag}
        // A click always follows a press, so without this every drag would also
        // open the panel - and moving Watchside out of the way would be the one
        // gesture that puts it back in the way.
        onClick={() => {
          if (wasDragged()) return
          setCollapsed(false)
        }}
      >
        <WatchsideMark size={24} />
        {/*
          * A NUMBER MEANS "THINGS ARE WAITING FOR YOU". NOTHING ELSE.
          *
          * Unseen and actionable only: a friend request, a gathering forming.
          * A friend changing channel is not news.
          *
          * This half was always right. The other half was not, and a beta user
          * read the launcher exactly the way the convention told them to:
          *
          *   "the number badge made me think i had 2 notifications"
          *
          * A small numeric bubble in a top navigation bar means unread items -
          * that is what every other control up there means by it, Twitch's
          * included. Friend presence was borrowing that language to say
          * something passive, so the count is now a dot: still "people are
          * here", no longer "two things need you". The number itself is not
          * lost, it is one click away, attached to the names it refers to.
          */}
        {view.unread.length > 0 && (
          <span className="kb-launcher-badge kb-launcher-badge-request">
            {view.unread.length}
          </span>
        )}
        {view.unread.length === 0 && friendsHere.length > 0 && (
          <span className="kb-launcher-here" aria-hidden="true" />
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
      {/*
        * Room lifecycle, emitted from inside the provider because that is the
        * only place useAnalytics() resolves - the provider wraps what the panel
        * returns rather than the panel itself.
        */}
      <RoomOpenedProbe
        open={sessionOpen}
        channel={sessionChannel}
        participantCount={Math.max(roomPeers.length, roomMembers.length) + 1}
        directFriendCount={roomMembers.length}
        openedFromRef={openedFrom}
      />
    <div
      // A height the user chose is what the panel is, not a ceiling: otherwise
      // the panel springs back to content height the moment they let go, and
      // the resize looks like it did not take. Before anyone resizes it stays
      // content-sized so a short friends list is not a tall empty box.
      className={`kb-panel${sized || chatOpen || gesturing ? ' kb-panel-filled' : ''}`}
      style={position}
      /*
       * A landmark with a name, rather than an anonymous div.
       *
       * Watchside sits inside Twitch's own page, so a screen-reader user
       * arriving at it has no context at all for what this region is - it is
       * simply more content on twitch.tv. `complementary` is the honest role
       * (supporting content beside the main thing) and the label is what makes
       * it navigable: assistive technology can jump between landmarks, and an
       * unnamed one is a stop that tells you nothing.
       */
      role="complementary"
      aria-label="Watchside"
    >
      <div className="kb-header" onPointerDown={beginDrag}>
        <WatchsideMark size={24} />
        <span className="kb-wordmark">watchside</span>
        {IS_DEMO && view.demo && <span className="kb-demo-badge">DEMO</span>}
        <span className="kb-header-spacer" />

        {signedIn && identity && (
          <button
            type="button"
            className="kb-avatar-btn"
            title={`Signed in as ${identity.displayName}`}
            onClick={() => {
              setAccountOpen((open) => !open)
              setFeedbackOpen(false)
            }}
          >
            <Avatar
              user={{
                id: identity.userId,
                username: identity.twitchLogin ?? identity.displayName,
                displayName: identity.displayName,
                avatarUrl: identity.avatarUrl,
                accentColor: BRAND_ACCENT,
              }}
              size={AVATAR_SIZE.person}
              showDot={false}
            />
          </button>
        )}

        <button
          type="button"
          className="kb-icon-btn"
          title="Minimize Watchside"
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

      {signedIn && identity && accountOpen && feedbackOpen && (
        <FeedbackForm
          onBack={() => setFeedbackOpen(false)}
          onSubmit={(category, body) =>
            client.submitFeedback({
              category,
              body,
              /*
               * Where they were, not where the form is.
               *
               * Everybody who sends feedback is technically "in the account
               * panel" - that is the only way in. What is worth knowing is what
               * they were looking at before they went looking for this.
               */
              surface: finding ? 'find' : tab,
              collapsed,
            })
          }
        />
      )}

      {signedIn && identity && accountOpen && !feedbackOpen && (
        <AccountCard
          client={client}
          onFeedback={() => setFeedbackOpen(true)}
          identity={identity}
          onSignOut={() => {
            setAccountOpen(false)
            client.signOut()
          }}
          measurementReadiness={view.measurementReadiness}
          onDeleted={() => {
            // The worker has already cleared the session and broadcast the
            // signed-out state; this just closes the card behind it.
            setAccountOpen(false)
            setFeedbackOpen(false)
          }}
          preferences={view.preferences}
          onPreferencesChange={(patch) => {
            setActionError(null)
            client.setPreferences(patch).catch((cause: unknown) => {
              setActionError(
                humanMessage(cause, 'Could not save that setting.'),
              )
            })
          }}
          onResetLayout={reset}
          textSize={textSize}
          onTextSizeChange={chooseTextSize}
          mutedUserIds={view.mutedUserIds}
          knownPeople={knownPeople}
          onUnmute={(userId) => client.setUserMuted(userId, false)}
          blocked={view.blockedUsers}
          onClose={() => {
            setAccountOpen(false)
            setFeedbackOpen(false)
          }}
          onUnblock={(userId) => {
            setActionError(null)
            client.unblockUser(userId).catch((cause: unknown) => {
              setActionError(humanMessage(cause, 'Could not unblock.'))
            })
          }}
          onVisibilityChange={(mode) => {
            setActionError(null)
            client.setPresenceVisibility(mode).catch((cause: unknown) => {
              setActionError(
                humanMessage(cause, 'Could not change your presence setting.'),
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
                  <Avatar key={friend.user.id} user={friend.user} size={AVATAR_SIZE.stack} showDot={false} />
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
              /*
               * Which tab is current is drawn with colour and weight, which is
               * the whole of the signal for anybody who cannot see it.
               * aria-pressed rather than aria-selected because these are
               * buttons in a plain container, not an ARIA tablist - claiming
               * the tablist role would promise arrow-key navigation between
               * them that the panel does not implement, and a half-kept
               * promise is worse than none.
               */
              aria-pressed={tab === 'friends' && !finding}
              onClick={() => chooseTab('friends')}
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
            {/*
              * The contextual streamer tab.
              *
              * Between Friends and Groups because that is what it is between:
              * the radar on one side, the durable circles on the other, and
              * the thing happening right now in the middle. Labelled with the
              * streamer and nothing else - a noun like "Room" would make it a
              * feature name, and the name of who you are watching is already
              * the most specific thing anybody could say about it.
              *
              * Truncation is CSS, so the full name survives in the title and
              * inside the tab; slicing the string would lose it in both.
              */}
            {sessionAvailable && sessionChannel && (
              <SessionTab
                channel={sessionChannel}
                active={tab === 'session' && !finding}
                unread={roomUnread}
                onSelect={() => chooseTab('session')}
              />
            )}
            <button
              type="button"
              className={`kb-tab${tab === 'groups' && !finding ? ' kb-tab-active' : ''}`}
              aria-pressed={tab === 'groups' && !finding}
              onClick={() => chooseTab('groups')}
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
              /*
               * "Add" alone does not say what, and this is the only permanent
               * door to search, suggestions and invites. The visible label stays
               * short because the tab row has to survive four tabs at the 280px
               * minimum width - so the full name lives in the accessible name
               * and the tooltip, and the states below carry the discovery.
               */
              title="Add friends"
              aria-label="Add friends"
              aria-expanded={finding}
              onClick={() => setFinding((open) => !open)}
            >
              + Add
            </button>
          </div>

          <div className={`kb-body${chatOpen ? ' kb-body-chat' : ''}`}>
            {sessionOpen && sessionChannel ? (
              /*
               * The session, beside Friends rather than on top of it.
               *
               * There is no Back button: the tabs are the way out, which is
               * the whole point of moving it here. Nothing is created by
               * arriving - membership is the connected component the server
               * already computes from presence.
               */
              <StreamSession
                badges={view.socialBadges}
                channel={sessionChannel}
                members={roomMembers}
                friends={friends}
                reactions={view.togetherReactions}
                messages={view.roomMessages}
                mutedUserIds={view.mutedUserIds}
                peers={roomPeers}
                metadata={view.channelMetadata?.[sessionChannel]}
                selfId={identity?.userId ?? null}
                client={client}
                cardContext={cardContext}
              />
            ) : finding ? (
              <FindFriends
                client={client}
                outgoingRequests={view.outgoingRequests}
                friends={view.friends}
                referralCount={view.referralCount}
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
                    destinations={view.friendDestinations}
                    pendingChannels={view.channelMetadataPending}
                    localActivity={view.localActivity}
                    onRemove={removeFriend}
                    client={client}
                    cardContext={cardContext}
                    metadata={view.channelMetadata}
                    reactions={view.togetherReactions}
                    roomMessages={view.roomMessages}
                    mutedUserIds={view.mutedUserIds}
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
          <span>Watchside</span>
          <span className="kb-footer-dot" />
          <span title="Watchside version">
            {IS_DEMO && view.demo ? 'demo mode — mock data' : `v${__KICKBACK_VERSION__}`}
          </span>
        </div>
      )}

      {/*
        * All four sides and all four corners.
        *
        * It used to be the bottom edge and the two bottom corners. A tester
        * tried the top, nothing happened, and they reported that Watchside was
        * not resizable - so the missing directions did not read as "fewer
        * handles", they read as "no feature". West and east were already
        * implemented in resizeTo and had simply never been given a grip.
        *
        * The north strip deliberately overlaps the header, which is the drag
        * handle, and wins on z-index. That overlap is the fix for the second
        * half of the same report: the top edge answered a resize gesture with
        * a grab cursor, telling the tester "you can move this" at exactly the
        * moment they were trying to resize it. The strip is 6px, so the rest
        * of the header still drags, and the buttons inside it are untouched.
        */}
      <div className="kb-resize kb-resize-n" onPointerDown={beginResize('n')} />
      <div className="kb-resize kb-resize-s" onPointerDown={beginResize('s')} />
      <div className="kb-resize kb-resize-w" onPointerDown={beginResize('w')} />
      <div className="kb-resize kb-resize-e" onPointerDown={beginResize('e')} />
      <div className="kb-resize kb-resize-nw" onPointerDown={beginResize('nw')} />
      <div className="kb-resize kb-resize-ne" onPointerDown={beginResize('ne')} />
      <div className="kb-resize kb-resize-sw" onPointerDown={beginResize('sw')} />
      <div className="kb-resize kb-resize-se" onPointerDown={beginResize('se')} />
    </div>
    </AnalyticsProvider>
    </ChannelNameProvider>
  )
}
