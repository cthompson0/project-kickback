import { INITIAL_STATE } from '../client/types'
import type {
  Friend,
  KickbackClient,
  KickbackState,
  PresenceVisibility,
  SearchResult,
  SendRequestOutcome,
} from '../client/types'
import { toPresence } from '../background/supabaseBackend'
import { mergePresence, stampFriends } from '../background/presenceIndex'
import { createAnalyticsHub } from '../background/analyticsHub'
import { createStoredValue, isJoinAttribution, isSessionRecord } from '../background/storedValue'
import { isPersistedLifecycle } from '../background/togetherStore'
import type { PersistedLifecycle } from '../background/togetherStore'
import type { SessionRecord } from '../background/analyticsSession'
import type { JoinAttribution } from '../background/joinAttribution'
import { createMemoryStorageArea } from '../background/storage'
import { createGatheringWatcher } from '../background/gatherings'
import { createNotifier } from '../background/notifier'
import { createAttentionService, friendRequestKey, gatheringKey } from '../background/attention'
import { findGatherings } from '../core/presence'
import { resolveChannelName } from '../core/channelNames'
import type { AnalyticsEvent } from '../core/analytics'
import type { Presence, User } from '../core/types'
import { isReaction, pruneReactions, withReaction } from '../core/together'
import {
  MAX_MESSAGE_LENGTH,
  pruneMessages,
  unreadCount,
  withMessage,
} from '../core/roomMessages'
import type { RoomMessage } from '../core/roomMessages'
import { withMuted, withoutMuted } from '../core/mute'
import { EMOTES } from '../core/emotes'
import type { Reaction, TogetherReaction } from '../core/together'
import {
  canonicalChannel,
  channelMetadata,
  channelNames,
  roomMembers,
  friendsOf,
  presenceRow,
  updateUser,
} from './world'
import type { SimUser, SimWorld } from './world'

/**
 * A KickbackClient backed by a simulated world instead of Supabase.
 *
 * WHAT IS REAL HERE
 *
 * Almost all of it. This file builds presence ROWS and then hands them to
 * production: `toPresence` maps them, `mergePresence` indexes them,
 * `stampFriends` attaches them. Analytics is the real `createAnalyticsHub`
 * with the real session, attribution, lifecycle and exposure machinery behind
 * it. Gatherings are the real `findGatherings` and `createGatheringWatcher`.
 * Notifications are the real `createNotifier`.
 *
 * WHAT IS SUBSTITUTED, AND WHERE
 *
 * Exactly three edges, each the last point before something leaves the
 * process:
 *
 *   1. the analytics BACKEND - captured instead of sent, so the inspector
 *      shows precisely what would have gone to Supabase, contract and all;
 *   2. the notification BACKEND - logged instead of shown, so no OS
 *      notification permission is needed to exercise the rules;
 *   3. storage - the in-memory area production's own tests use.
 *
 * Nothing above those edges is reimplemented, so a bug in clustering, ranking,
 * privacy, staleness, dedupe or attribution is reproducible here.
 */

export type LabRecordKind = 'analytics' | 'join' | 'notification' | 'blocked'

export interface LabRecord {
  seq: number
  at: number
  kind: LabRecordKind
  label: string
  detail: Record<string, unknown>
}

export interface TestLabHandle {
  client: KickbackClient
  /**
   * Make a simulated person react, as if it had arrived over realtime.
   *
   * The lab's only Together control. It does NOT reimplement the reaction
   * service - there is no subscription, no row policy, no rate limit and no
   * sweep here, because those belong to the service and a copy of them would
   * prove nothing about the original.
   */
  react(userId: string, reaction: Reaction, at?: number): void
  /** Make a simulated person say something, as if it had arrived over realtime. */
  say(userId: string, body: string, at?: number): void
  /** Replace the simulated world. The panel re-renders from production state. */
  setWorld(next: SimWorld): void
  getWorld(): SimWorld
  records(): LabRecord[]
  subscribeRecords(listener: (records: LabRecord[]) => void): () => void
  clearRecords(): void
  /** Push queued analytics through the real recorder to the capture edge. */
  flush(): Promise<void>
}

export interface TestLabDeps {
  world: SimWorld
  appVersion: string | null
  /**
   * Called when the world changes because the PANEL did something - removing a
   * friend, accepting a request. The lab surface owns the world, so it needs
   * telling rather than being asked.
   */
  onWorldChange?: (world: SimWorld) => void
}

const LAB_GROUPS_UNAVAILABLE =
  'Groups are not simulated in the Test Lab yet. See docs/TEST_LAB.md.'

function toUser(sim: SimUser): User {
  return {
    id: sim.id,
    username: sim.login,
    displayName: sim.displayName,
    avatarUrl: null,
  }
}

export function createTestLabClient(deps: TestLabDeps): TestLabHandle {
  let world = deps.world
  let state: KickbackState = INITIAL_STATE
  const listeners = new Set<(state: KickbackState) => void>()

  // --- the record log ------------------------------------------------------

  let records: LabRecord[] = []
  let seq = 0
  const recordListeners = new Set<(records: LabRecord[]) => void>()

  function log(kind: LabRecordKind, label: string, detail: Record<string, unknown>): void {
    records = [...records, { seq: seq++, at: Date.now(), kind, label, detail }].slice(-300)
    for (const listener of recordListeners) listener(records)
  }

  // --- time ----------------------------------------------------------------

  /*
   * The clock analytics sees.
   *
   * Presence does not use this: people age through `staleForMs`, so the real
   * 90-second staleness rule runs against the real clock. Analytics windows -
   * exposure, gathering cooldown, opportunity-key boundary - are minutes or
   * half-hours long, and production already accepts an injected `now` for
   * exactly this reason, so they are crossed by moving the offset.
   */
  const labNow = () => Date.now() + world.clockOffsetMs

  // --- analytics, captured at the send boundary ----------------------------

  const storage = createMemoryStorageArea()

  const analytics = createAnalyticsHub({
    backend: {
      async send(events: AnalyticsEvent[]): Promise<number> {
        for (const event of events) {
          log('analytics', event.event_name, {
            source: event.source ?? null,
            channel: event.destination_channel ?? null,
            ...(event.properties ?? {}),
          })
        }
        return events.length
      },
    },
    environment: 'development',
    appVersion: deps.appVersion,
    enabled: true,
    sessionStore: createStoredValue<SessionRecord>(
      storage,
      'kickback:analytics:session',
      isSessionRecord,
    ),
    attributionStore: createStoredValue<JoinAttribution>(
      storage,
      'kickback:analytics:join',
      isJoinAttribution,
    ),
    lifecycleStore: createStoredValue<PersistedLifecycle>(
      storage,
      'kickback:analytics:lifecycle',
      isPersistedLifecycle,
    ),
    canSend: () => true,
    selfId: () => world.observer.id,
    now: labNow,
    onError: (context, error) => log('blocked', `analytics error: ${context}`, { error: String(error) }),
  })

  // --- notifications, logged at the display boundary -----------------------

  const gatheringSizes = new Map<string, number>()

  const notifier = createNotifier({
    create: (id, options) =>
      log('notification', options.title, { id, message: options.message }),
    clear: () => {},
    onClicked: () => {},
    onButtonClicked: () => {},
    openUrl: (url) => log('join', 'notification opened', { url }),
    onOpen: (channel) => {
      analytics.track(
        'gathering_notification_clicked',
        { friend_count: gatheringSizes.get(channel) ?? 0 },
        { source: 'notification', channel },
      )
      analytics.recordJoin({
        channel,
        source: 'notification',
        socialCount: gatheringSizes.get(channel) ?? 0,
        navigated: true,
        alreadyOnTwitch: observerChannel() !== null,
        alreadyOnDestination: observerChannel() === channel,
      })
    },
    iconUrl: '',
  })

  const gatheringWatcher = createGatheringWatcher({
    now: labNow,
    onNotify: ({ channel, friendIds }) => {
      const names = friendIds
        .map((id) => state.friends.find((friend) => friend.user.id === id))
        .filter((friend) => friend !== undefined)
        .map((friend) => friend.user.displayName)

      analytics.track(
        'gathering_notification_shown',
        { friend_count: friendIds.length },
        { source: 'notification', channel },
      )
      notifier.notifyGathering({
        channel,
        names,
        channelName: resolveChannelName(channel, {
          people: state.friends.map((friend) => friend.user),
          seen: state.channelNames,
        }),
      })
    },
  })

  const attention = createAttentionService({ storage })

  // --- together reactions --------------------------------------------------

  /*
   * A local ephemeral buffer, fed at exactly the boundary production reads
   * from: KickbackState.togetherReactions. The panel cannot tell a simulated
   * reaction from one that came over realtime.
   */
  let reactions: TogetherReaction[] = []
  let reactionSeq = 0

  function react(userId: string, reaction: Reaction, at = Date.now()): void {
    const here = observerChannel()
    // Reactions only exist on the channel the viewer is on - the same rule
    // production follows, because that is the only channel it subscribes to.
    if (!here) return

    reactions = withReaction(pruneReactions(reactions, Date.now()), {
      id: `lab-${reactionSeq++}`,
      senderId: userId,
      channel: here,
      reaction,
      at,
    })
    publish()
  }

  // --- room conversation ---------------------------------------------------

  /*
   * The same treatment reactions get: a local buffer fed at exactly the
   * boundary production reads from, so the panel cannot tell a simulated
   * message from one that arrived over realtime.
   *
   * The lab holds no subscription, no RPC, no rate limit, no fan-out and no
   * sweep. Those belong to the server, and a copy of them here would prove
   * nothing about the original - which is why merge, split and retention are
   * tested against real Postgres in tests/db/roomMessages.test.ts instead.
   */
  let messages: RoomMessage[] = []
  let messageSeq = 0
  let sessionChannel: string | null = null
  let readAt: Record<string, number> = {}
  let mutedUserIds: string[] = []

  function say(userId: string, body: string, at = Date.now()): void {
    const here = observerChannel()
    // A conversation only exists on the channel the viewer is on - the same
    // rule production follows, because that is the only inbox it filters to.
    if (!here) return

    messages = withMessage(pruneMessages(messages, Date.now()), {
      id: `lab-msg-${messageSeq++}`,
      senderId: userId,
      channel: here,
      body,
      at,
    })
    publish()
  }

  // --- deriving state from the world --------------------------------------

  function observerChannel(): string | null {
    const channel = world.observer.channel
    return channel ? canonicalChannel(channel) : null
  }

  function build(world: SimWorld): KickbackState {
    const now = Date.now()

    /*
     * Rows in, production out.
     *
     * Every simulated person becomes a row exactly as the database would hold
     * it - already redacted, because the database redacts at write time - and
     * from here nothing is the Test Lab's opinion.
     */
    const presences: Presence[] = friendsOf(world).map((user) => toPresence(presenceRow(user, now)))
    const index = mergePresence({}, presences)

    const friends: Friend[] = stampFriends(
      friendsOf(world).map((user) => ({ user: toUser(user), presence: null })),
      index,
    )

    const requests = (direction: 'incoming' | 'outgoing') =>
      world.users
        .filter((user) =>
          direction === 'incoming'
            ? user.relationship === 'incoming_request'
            : user.relationship === 'outgoing_request',
        )
        .map((user) => ({
          requestId: `req-${user.id}`,
          direction,
          user: toUser(user),
          twitchLogin: user.login,
          createdAt: new Date(now - 60_000).toISOString(),
        }))

    return {
      ...INITIAL_STATE,
      status: 'signed_in',
      identity: {
        userId: world.observer.id,
        displayName: world.observer.displayName,
        avatarUrl: null,
        twitchLogin: world.observer.login,
        friendCode: 'KB-TEST-LAB',
        presenceVisibility: world.observer.visibility,
      },
      friends,
      incomingRequests: requests('incoming'),
      outgoingRequests: requests('outgoing'),
      channelNames: channelNames(world),
      // Handed over at the boundary production reads it from, so the panel
      // cannot tell a simulated record from a fetched one.
      channelMetadata: channelMetadata(world, now),
      togetherReactions: pruneReactions(reactions, now),
      // Computed by the lab because production computes it in SQL, which the
      // lab has no access to. Checked against that SQL by a test.
      roomMembers: roomMembers(world, now),
      /*
       * Direct friends presence already proves are here.
       *
       * Production derives this from the presence index rather than from the
       * membership RPC, and availability accepts it - so the lab has to supply
       * it or it would model a panel that still waits for the server.
       */
      roomPeers: friendsOf(world)
        .filter((user) => presenceRow(user, now).channel === observerChannel())
        .map((user) => user.id),
      roomMessages: pruneMessages(messages, now),
      roomUnread: unreadCount(
        messages,
        observerChannel(),
        readAt[observerChannel() ?? ''] ?? 0,
        world.observer.id,
        now,
      ),
      /*
       * The lab applies the same three conditions production does: same
       * destination, and a room that still exists on it. Eligibility is
       * already inside roomMembers, which will not form one for an offline
       * or unknown channel.
       */
      sessionChannel:
        sessionChannel && sessionChannel === observerChannel() &&
        roomMembers(world, now).length > 0
          ? sessionChannel
          : null,
      mutedUserIds,
      attention: attention.getState().items,
      unread: attention.getState().unread,
    }
  }

  function refreshAttention(): void {
    const gatherings = findGatherings(
      state.friends.flatMap((friend) => (friend.presence ? [friend.presence] : [])),
      observerChannel()
        ? { type: 'watching', platform: 'twitch', channel: observerChannel()! }
        : undefined,
    ).filter((gathering) => gathering.userIds.length >= 2)

    gatheringSizes.clear()
    for (const gathering of gatherings) gatheringSizes.set(gathering.channel, gathering.userIds.length)

    attention.setItems([
      ...state.incomingRequests.map((request) => ({
        key: friendRequestKey(request.requestId),
        kind: 'friend_request' as const,
        count: 1,
      })),
      ...gatherings.map((gathering) => ({
        key: gatheringKey(gathering.channel),
        kind: 'gathering' as const,
        count: gathering.userIds.length,
      })),
    ])

    gatheringWatcher.update(
      gatherings.map((gathering) => ({
        channel: gathering.channel,
        friendIds: gathering.userIds,
      })),
      observerChannel(),
    )
  }

  function publish(): void {
    state = build(world)
    refreshAttention()
    // Attention may have changed what is unread, so the published state is
    // rebuilt once more rather than being a frame behind.
    state = { ...state, attention: attention.getState().items, unread: attention.getState().unread }
    for (const listener of listeners) listener(state)

    analytics.noteActive()
    analytics.noteChannel(observerChannel())
    analytics.noteTogether({
      channel: observerChannel(),
      otherCount: state.friends.filter(
        (friend) =>
          friend.presence?.activity.type === 'watching' &&
          canonicalChannel(friend.presence.activity.channel) === observerChannel(),
      ).length,
    })
  }

  function mutate(next: SimWorld): void {
    world = next
    deps.onWorldChange?.(world)
    publish()
  }

  attention.subscribe(() => {
    state = { ...state, attention: attention.getState().items, unread: attention.getState().unread }
    for (const listener of listeners) listener(state)
  })

  analytics.noteSignedIn({ friendCount: friendsOf(world).length, groupCount: 0 })
  publish()

  // --- the client ----------------------------------------------------------

  const unavailable = async <T>(): Promise<T> => {
    throw new Error(LAB_GROUPS_UNAVAILABLE)
  }

  const client: KickbackClient = {
    getState: () => state,
    subscribe(listener) {
      listeners.add(listener)
      listener(state)
      return () => listeners.delete(listener)
    },
    signIn: () => {},
    signOut: () => {},
    retry: () => {},

    async searchUsers(query: string): Promise<SearchResult[]> {
      const needle = query.trim().toLowerCase()
      if (!needle) return []
      return world.users
        .filter(
          (user) =>
            user.login.includes(needle) || user.displayName.toLowerCase().includes(needle),
        )
        .map((user) => ({
          userId: user.id,
          displayName: user.displayName,
          avatarUrl: null,
          twitchLogin: user.login,
          relationship:
            user.relationship === 'friend'
              ? 'friend'
              : user.relationship === 'incoming_request'
                ? 'request_received'
                : user.relationship === 'outgoing_request'
                  ? 'request_sent'
                  : 'none',
          matchedBy: 'twitch_login',
        }))
    },

    async sendFriendRequest(userId: string): Promise<SendRequestOutcome> {
      mutate(updateUser(world, userId, { relationship: 'outgoing_request' }))
      return 'requested'
    },
    async respondToFriendRequest(requestId, accept) {
      const userId = requestId.replace(/^req-/, '')
      mutate(updateUser(world, userId, { relationship: accept ? 'friend' : 'stranger' }))
      return accept ? 'accepted' : 'declined'
    },
    async acceptFriendRequestFrom(userId: string) {
      mutate(updateUser(world, userId, { relationship: 'friend' }))
      return 'accepted' as const
    },
    async cancelFriendRequest(requestId: string) {
      mutate(updateUser(world, requestId.replace(/^req-/, ''), { relationship: 'stranger' }))
    },
    async removeFriend(userId: string) {
      mutate(updateUser(world, userId, { relationship: 'stranger' }))
    },
    async refreshFriends() {
      publish()
    },

    reportActivity: () => {},

    sendReaction(reaction) {
      /*
       * Into the same buffer a friend's reaction lands in.
       *
       * Production never draws the sender's own reaction optimistically - it
       * comes back through realtime like everyone else's - so the lab does the
       * same. One path, and no way for the lab to show something production
       * would not.
       */
      if (isReaction(reaction)) react(world.observer.id, reaction)
    },

    sendRoomMessage(body) {
      // Into the same buffer a friend's message lands in, for the same
      // reason: production never draws the sender's own copy optimistically.
      const text = body.trim()
      if (text.length > 0 && text.length <= MAX_MESSAGE_LENGTH) {
        say(world.observer.id, text)
      }
    },

    selectSession(channel) {
      const here = observerChannel()
      if (channel && channel.toLowerCase() === here) {
        sessionChannel = here
        readAt = { ...readAt, [here]: Date.now() }
      } else {
        sessionChannel = null
      }
      publish()
    },

    setUserMuted(userId, muted) {
      mutedUserIds = muted ? withMuted(mutedUserIds, userId) : withoutMuted(mutedUserIds, userId)
      publish()
    },
    async setPresenceVisibility(mode: PresenceVisibility) {
      mutate({ ...world, observer: { ...world.observer, visibility: mode } })
    },

    markSeen: (keys) => attention.markSeen(keys),
    markKindSeen: (kind) => attention.markKindSeen(kind),
    async setPreferences() {},

    createGroup: unavailable,
    renameGroup: unavailable,
    setGroupIcon: unavailable,
    deleteGroup: unavailable,
    inviteToGroup: unavailable,
    cancelGroupInvite: unavailable,
    respondToGroupInvite: unavailable,
    leaveGroup: unavailable,
    removeGroupMember: unavailable,
    sendGroupMessage: unavailable,
    markGroupRead: () => {},
    setGroupMuted: unavailable,
    async searchEmotes(query: string) {
      /*
       * The built-ins, filtered - which is what production falls back to when a
       * channel has no external emotes.
       *
       * It used to return nothing, and returning nothing is NOT the same as
       * having nothing: the picker treats an empty answer as a real result and
       * stops showing its own fallback, so the lab rendered a picker with no
       * emotes in it and the browser gate could not exercise the one path a
       * person actually uses to send one.
       */
      const term = query.trim().toLowerCase()
      const emotes = EMOTES.filter((emote) => !term || emote.name.includes(term))
      return emotes.length ? [{ title: 'Kickback', emotes }] : []
    },

    track: (name, properties, options) => analytics.track(name, properties, options),

    recordJoin(input) {
      /*
       * The same two facts the service worker adds.
       *
       * They are not the panel's to know - "is this person already on Twitch"
       * is a fact about every tab they have open - so they are supplied here,
       * at the same point in the pipeline, rather than by the surface that
       * benefits from the answer.
       */
      analytics.recordJoin({
        ...input,
        alreadyOnTwitch: observerChannel() !== null,
        alreadyOnDestination: observerChannel() === canonicalChannel(input.channel),
      })
    },

    reportExposure: (report) => analytics.noteExposure(report),
  }

  return {
    client,
    react,
    say,
    setWorld(next) {
      world = next
      publish()
    },
    getWorld: () => world,
    records: () => records,
    subscribeRecords(listener) {
      recordListeners.add(listener)
      listener(records)
      return () => recordListeners.delete(listener)
    },
    clearRecords() {
      records = []
      for (const listener of recordListeners) listener(records)
    },
    flush: () => analytics.flush(),
  }
}
