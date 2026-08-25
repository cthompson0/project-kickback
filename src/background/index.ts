import { createAuthService } from './auth'
import { createFriendsService } from './friends'
import { createSocialSync } from './socialSync'
import { createPresenceSync } from './presenceSync'
import {
  clearPresence as clearIndexed,
  forgetPresence,
  mergePresence,
  setPresence,
  stampFriends,
  stampMembers,
  watchedUserIds,
} from './presenceIndex'
import type { PresenceIndex } from './presenceIndex'
import { createPresenceReporter } from './presence'
import { createActivityRegistry } from './activity'
import { createGatheringWatcher } from './gatherings'
import { resolveChannelName } from '../core/channelNames'
import {
  createAttentionService,
  friendRequestKey,
  gatheringKey,
  groupInviteKey,
  groupUnreadKey,
} from './attention'
import { createGroupsService } from './groups'
import { createGroupSync } from './groupSync'
import { createEmoteCatalog } from './emoteCatalog'
import { createSevenTvClient } from './sevenTv'
import { createPreferences } from './preferences'
import { createAnalyticsHub } from './analyticsHub'
import { createMetadataService } from './metadata'
import { createTogetherReactions } from './togetherReactions'
import { createStreamRoom } from './streamRoom'
import { directCount } from '../core/streamRoom'
import { isReaction } from '../core/together'
import { canWatchTogether } from '../core/socialViewing'
import { createStoredValue, isJoinAttribution, isSessionRecord } from './storedValue'
import { isPersistedLifecycle } from './togetherStore'
import type { PersistedLifecycle } from './togetherStore'
import type { SessionRecord } from './analyticsSession'
import type { JoinAttribution } from './joinAttribution'
import { describePresence } from '../core/personPresence'
import type { AnalyticsEnvironment } from '../core/analytics'
import { isAnalyticsEventName } from '../core/analytics'
import { createNotifier } from './notifier'
import { findGatherings } from '../core/presence'
import { parseMessage } from '../core/emotes'
import { lengthBucket } from '../core/analytics'
import type { Activity } from '../core/types'
import {
  createSupabaseGroupChannel,
  createSupabasePresenceChannel,
  createSupabaseSocialChannel,
  createSupabaseTogetherChannel,
} from './supabaseRealtime'
import {
  createSupabaseAnalyticsBackend,
  createSupabaseMetadataBackend,
  createSupabaseRoomBackend,
  createSupabaseTogetherBackend,
  createSupabaseBackend,
  createSupabaseClient,
  createSupabaseFriendsBackend,
  createSupabaseGroupsBackend,
  createSupabasePresenceBackend,
  setPresenceVisibility,
} from './supabaseBackend'
import { createExtensionStorage } from './storage'
import { PORT_NAME } from '../client/messages'
import type { ClientMessage, RpcMethod, WorkerMessage } from '../client/messages'
import type { KickbackState } from '../client/types'
import { INITIAL_STATE } from '../client/types'

/**
 * Kickback's service worker: the one place that holds a session and talks to
 * Supabase. Twitch tabs connect over a port and receive state; they never see a
 * token, and they never call the database themselves.
 *
 * MV3 workers are killed after ~30s idle, so nothing here may live only in
 * memory. The session is in chrome.storage.local, and an alarm brings the
 * worker back to refresh it.
 */

const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL
const SUPABASE_PUBLISHABLE_KEY = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY

const REFRESH_ALARM = 'kickback:refresh-session'
const REFRESH_PERIOD_MINUTES = 30

const storage = createExtensionStorage({
  get: (keys) => chrome.storage.local.get(keys),
  set: (items) => chrome.storage.local.set(items),
  remove: (keys) => chrome.storage.local.remove(keys),
})

// Startup diagnostic. Logs which project the worker is pointed at and how long
// the key is - never the key itself. A truncated key is otherwise invisible:
// it fails much later, as "Invalid API key" from the code exchange.
console.info(
  '[Kickback] worker starting',
  JSON.stringify({
    supabaseUrl: SUPABASE_URL,
    publishableKeyLength: SUPABASE_PUBLISHABLE_KEY?.length ?? 0,
    mode: import.meta.env.VITE_KICKBACK_MODE ?? 'production',
  }),
)

if (!SUPABASE_URL || !SUPABASE_PUBLISHABLE_KEY) {
  console.error(
    '[Kickback] missing Supabase configuration - copy .env.example to .env.local and rebuild',
  )
}

const supabase = createSupabaseClient(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY, storage)

const logError = (context: string, error: unknown) => {
  // Never log the error object itself - Supabase errors can quote the request.
  console.warn(`[Kickback] ${context} failed:`, error instanceof Error ? error.message : error)
}

const auth = createAuthService({
  backend: createSupabaseBackend(supabase),
  launchWebAuthFlow: (url) =>
    chrome.identity.launchWebAuthFlow({ url, interactive: true }).then((redirectedTo) => {
      if (!redirectedTo) throw new Error('Sign-in window closed')
      return redirectedTo
    }),
  redirectUrl: chrome.identity.getRedirectURL(),
  onError: logError,
})

const friends = createFriendsService({
  backend: createSupabaseFriendsBackend(supabase),
  onError: logError,
})

/**
 * Keeps friendships and friend requests current without polling. It carries no
 * data: an event only means "re-read", and the re-read goes through the same
 * authorized RPCs as everything else.
 *
 * This is social-graph sync only. Presence is Checkpoint 5.
 */
const socialSync = createSocialSync({
  channel: createSupabaseSocialChannel(supabase),
  onInvalidate: () => void friends.refresh(),
  onStatusChange: (status) => console.info('[Kickback] social sync', status),
  onError: logError,
})

/**
 * The one presence per person that every surface reads.
 *
 * See presenceIndex.ts: friends and group members used to keep separate
 * copies, and only the friends copy was ever updated, so the same person could
 * be "watching Lirik" in one view and "offline" in another.
 */
let presenceIndex: PresenceIndex = {}

/**
 * Who was last seen on the viewer's own channel, as a comparable string.
 *
 * Not a count: two people swapping places keeps the count and changes the
 * room. Sorted ids, so the same set in a different order is the same set.
 */
function coPresenceKey(channel: string | null): string {
  if (!channel) return ''
  const viewer: Activity = { type: 'watching', platform: 'twitch', channel }
  const selfId = authState.identity?.userId ?? null

  const here: string[] = []
  for (const [userId, presence] of Object.entries(presenceIndex)) {
    if (userId === selfId) continue
    if (describePresence(presence, viewer).kind === 'watching_with_you') here.push(userId)
  }
  return here.sort().join(',')
}

let coPresence = ''

function indexPresence(next: PresenceIndex): void {
  if (next === presenceIndex) return
  presenceIndex = next
  // Somebody arriving on or leaving the channel this user is watching is
  // exactly what starts and ends a shared watch, so it is re-evaluated here
  // rather than only when the local user navigates.
  updateTogether()

  /*
   * And it is also the only thing that changes who is in the room.
   *
   * Membership is cached for two heartbeats, which is right for an answer
   * that rarely differs - but nothing was re-asking, because presence updates
   * do not run pushActivity. A friend arriving was therefore invisible to the
   * room until the viewer navigated, hid the tab, or half an hour passed.
   *
   * Keyed on WHO is here rather than on every presence tick, so this is one
   * query per actual arrival or departure, not one per heartbeat per friend.
   */
  const here = socialChannel()
  const key = coPresenceKey(here)
  if (key !== coPresence) {
    coPresence = key
    room.invalidate()
  }
  room.want(here)

  broadcast()
}

/**
 * Everyone's presence. Payloads are applied straight to state - see
 * presenceSync.ts for why that is safe here but not for the social graph.
 */
const presenceSync = createPresenceSync({
  channel: createSupabasePresenceChannel(supabase),
  onPresence: (presence) => {
    // Both: the friends service owns the Friends tab's own bookkeeping, and
    // the index is what every other surface reads.
    friends.applyPresence(presence)
    indexPresence(setPresence(presenceIndex, presence))
  },
  onPresenceGone: (userId) => {
    friends.clearPresence(userId)
    indexPresence(clearIndexed(presenceIndex, userId, Date.now()))
  },
  // A reconnect may have missed changes; re-read once rather than assume.
  onResync: () => {
    void friends.refresh()
    // Group rosters carry presence too, and a reconnect may have missed
    // changes to people we only know through a group.
    void groups.refresh()
  },
  onStatusChange: (status) => console.info('[Kickback] presence sync', status),
  onError: logError,
})

/** Our own presence: what this browser is watching, and that it still is. */
const presenceReporter = createPresenceReporter({
  backend: createSupabasePresenceBackend(supabase),
  /*
   * The heartbeat doubles as analytics' liveness signal.
   *
   * An open shared watch is persisted so it survives the worker being evicted,
   * and on the way back it has to decide whether the gap was a restart or a
   * closed laptop. Its evidence is when we last confirmed the user was on the
   * channel - and without this, that was only refreshed when somebody's
   * presence CHANGED, so a quiet ten minutes looked identical to being away.
   *
   * It also means the two-minute "everyone left" grace now expires on its own
   * rather than waiting for the user to move: this is the periodic tick the
   * shared-watch machine never had.
   */
  onHeartbeat: () => updateTogether(),
  /*
   * Our own presence row now exists, which is a precondition for the room
   * query - so this is the moment to ask. Without it the debounce would leave
   * the first eligible page load with nothing to re-trigger on.
   *
   * `pushActivity` re-enters `setActivity`, which returns immediately when
   * the desired and reported activity already agree - which, here, they do.
   */
  onReported: () => pushActivity(),
  onError: logError,
})

/** Which Twitch tab counts as "what the user is doing". See activity.ts. */
const tabActivity = createActivityRegistry()

/**
 * Emotes available to the composer. Follows the channel the user is watching,
 * so 7TV context changes with SPA navigation and no reload.
 */
const emoteCatalog = createEmoteCatalog({
  client: createSevenTvClient(fetch, logError),
  onError: logError,
})

const storageArea = {
  get: (keys: string | string[]) => chrome.storage.local.get(keys),
  set: (items: Record<string, unknown>) => chrome.storage.local.set(items),
  remove: (keys: string | string[]) => chrome.storage.local.remove(keys),
}

const preferences = createPreferences(storageArea, logError)

// ---------------------------------------------------------------- analytics
//
// Which cohort this build's numbers belong to. A build-time constant, so the
// demo bundle folds `ANALYTICS_ENABLED` to false and drops the whole path.
//
// The demo build never sends: it has no backend, no session and no signed-in
// user, and saying so here rather than relying on any of those means there is
// one obvious place to read the answer off.
const ANALYTICS_ENVIRONMENT: AnalyticsEnvironment =
  import.meta.env.VITE_KICKBACK_ENV ?? 'development'
const ANALYTICS_ENABLED = import.meta.env.VITE_KICKBACK_MODE !== 'demo'

const analytics = createAnalyticsHub({
  backend: createSupabaseAnalyticsBackend(supabase),
  environment: ANALYTICS_ENVIRONMENT,
  appVersion: __KICKBACK_VERSION__,
  enabled: ANALYTICS_ENABLED,
  sessionStore: createStoredValue<SessionRecord>(
    storageArea,
    'kickback:analytics:session',
    isSessionRecord,
  ),
  attributionStore: createStoredValue<JoinAttribution>(
    storageArea,
    'kickback:analytics:join',
    isJoinAttribution,
  ),
  /*
   * The open shared watch, so an evicted worker does not take it with it.
   *
   * These intervals run for hours - longer than a worker lives - and the long
   * ones are exactly the ones the Social Gravity comparison will rest on.
   */
  lifecycleStore: createStoredValue<PersistedLifecycle>(
    storageArea,
    'kickback:analytics:lifecycle',
    isPersistedLifecycle,
  ),
  // No actor, no events sent. They queue rather than being thrown away, so a
  // session that starts before auth resolves is not lost.
  canSend: () => authState.status === 'signed_in',
  // Who a stored interval must belong to before it may be resumed or ended.
  selfId: () => authState.identity?.userId ?? null,
  onError: logError,
})

const groups = createGroupsService({
  backend: createSupabaseGroupsBackend(supabase),
  storage: storageArea,
  selfId: () => authState.identity?.userId ?? null,
  onError: logError,
})

/**
 * Live chat and membership. Messages are applied directly; membership changes
 * only invalidate, because they are rare and the group list is cheap.
 */
const groupSync = createGroupSync({
  channel: createSupabaseGroupChannel(supabase),
  onRawMessage: (raw) => {
    // The realtime row has no display name. Resolve it from the members we
    // already hold rather than inventing one; an unknown sender means our
    // member list is stale, so re-read instead of guessing.
    const members = groups.getState().members[raw.groupId] ?? []
    const sender = members.find((member) => member.user.id === raw.userId)
    if (!sender) {
      void groups.refresh()
      return
    }
    groups.applyMessage({
      id: raw.id,
      groupId: raw.groupId,
      userId: raw.userId,
      displayName: sender.user.displayName,
      avatarUrl: sender.user.avatarUrl ?? null,
      body: raw.body,
      createdAt: raw.createdAt,
    })
  },
  onMembershipChanged: () => void groups.refresh(),
  onResync: () => void groups.refresh(),
  onStatusChange: (status) => console.info('[Kickback] group sync', status),
  onError: logError,
})
/**
 * Automatic Together: reactions for whoever the viewer is watching with.
 *
 * No room, no membership, no lifecycle. Who is here is derived from presence
 * by the panel, from the same `here` cluster Social Gravity already draws;
 * this only carries the one thing presence cannot.
 *
 * Deliberately not persisted across worker restarts. A reaction is eight
 * seconds of "did you see that" - restoring a stale one after a wake-up would
 * show somebody laughing at a moment that has passed.
 */
const room = createStreamRoom({
  backend: createSupabaseRoomBackend(supabase),
  onChange: () => broadcast(),
  onError: logError,
})

const together = createTogetherReactions({
  channel: createSupabaseTogetherChannel(supabase),
  backend: createSupabaseTogetherBackend(supabase),
  onChange: () => broadcast(),
  onReaction: (reaction, mine) => {
    /*
     * One event for both directions, with a property saying which.
     *
     * Sent and received are the same interaction seen from two sides, and the
     * viewer's own reaction arrives back through the same realtime path as
     * everyone else's - so recording it here, once, is the only way the two
     * cannot disagree about how many there were.
     */
    analytics.track(
      'automatic_room_reaction',
      { participant_count: roomSize(), direction: mine ? 'sent' : 'received' },
      { source: 'together', channel: reaction.channel },
    )
  },
  onError: logError,
})

/** Everyone in the room, including the viewer. Zero when there is no room. */
function roomSize(): number {
  const members = room.snapshot().length
  return members === 0 ? 0 : members + 1
}

/**
 * The channel a Together has already been reported for.
 *
 * One event per gathering, not one per presence tick. Recorded on the
 * TRANSITION into being with somebody - which is the moment the question
 * "does JOIN lead to Together" is actually about - and cleared when the
 * viewer leaves or ends up alone, so returning later counts again.
 *
 * Deliberately not a lifecycle. watching_together_started / _ended already
 * measure the interval, and measuring it twice would be two chances to
 * disagree; this only says the surface appeared.
 */
let togetherShownFor: string | null = null

function noteTogetherSurface(): void {
  // socialChannel(), not currentChannel(): an empty member list would already
  // stop this, because rooms are only fetched for an eligible channel - but
  // one that says which question it is asking cannot drift away from the
  // answer later.
  const here = socialChannel()
  const members = room.snapshot()

  if (!here || members.length === 0) {
    togetherShownFor = null
    return
  }
  if (togetherShownFor === here) return

  togetherShownFor = here
  analytics.track(
    'automatic_room_entered',
    {
      participant_count: members.length + 1,
      // The question the connected-component model exists to answer: is
      // friend-of-friend exposure actually happening, or is every room just
      // the viewer's own friends?
      direct_friend_count: directCount(members),
    },
    { source: 'together', channel: here },
  )
}

const attention = createAttentionService({ storage: storageArea, onError: logError })

/**
 * Public Twitch metadata for the destinations the map is showing.
 *
 * One cache for every tab, in the one place that already owns shared state.
 * It is asked for channels on every broadcast and fetches only what is missing
 * or expired, so requests scale with DISTINCT DESTINATIONS rather than with
 * presence heartbeats - see metadata.ts.
 *
 * Nothing here can fail in a way a user sees. A metadata outage means the map
 * renders exactly as it did before this existed.
 */
/*
 * Verbose metadata logging, off in production.
 *
 * A build-time constant, so a production bundle folds the whole diagnostic
 * path away rather than merely declining to print it.
 */
const METADATA_DIAGNOSTICS =
  (import.meta.env.VITE_KICKBACK_ENV ?? 'development') !== 'production'

const METADATA_KEY = 'kickback:channelMetadata'

const metadataBackend = createSupabaseMetadataBackend(supabase)

const metadata = createMetadataService({
  fetcher: metadataBackend,
  load: async () => {
    const stored = await storageArea.get(METADATA_KEY)
    const value = stored?.[METADATA_KEY]
    return value && typeof value === 'object' ? (value as Record<string, unknown>) : null
  },
  save: (records) => {
    void storageArea.set({ [METADATA_KEY]: records })
  },
  /*
   * Metadata arriving is a state change, and now also an ELIGIBILITY change.
   *
   * This is the whole of the LIVE -> OFFLINE and OFFLINE -> LIVE path, and it
   * needs no new timer: the service already refetches any record older than
   * LIVE_TTL_MS, and refreshAttention asks for the viewer's own channel on
   * every presence heartbeat. So a stream ending closes the room, the reaction
   * subscription and the analytics interval within about two minutes, and a
   * stream starting opens them on the same schedule - through pushActivity and
   * updateTogether, which are the only places that decide either.
   */
  onChange: () => {
    pushActivity()
    updateTogether()
    broadcast()
  },
  /*
   * Say what happened - in development and beta only.
   *
   * The first deployed version of this feature failed at every single request
   * and nothing looked wrong, because the panel degrades correctly by design:
   * "metadata is broken" and "no friends are watching anything" produced the
   * same screen. Finding that cost a whole checkpoint.
   *
   * Codes and counts. No tokens, no headers, no channel names and no user ids
   * - a worker console is not a place to put anything that identifies anyone.
   */
  onDiagnostic: METADATA_DIAGNOSTICS
    ? (diagnostic, detail) => {
        const backend = detail.codes?.length ? ' backend=' + detail.codes.join(',') : ''
        console.info(
          '[kickback:metadata] ' + diagnostic + ' channels=' + detail.channels + backend,
        )
      }
    : undefined,
  onError: logError,
})

const notifier = createNotifier({
  create: (id, options) => chrome.notifications.create(id, options),
  clear: (id) => chrome.notifications.clear(id),
  onClicked: (handler) => chrome.notifications.onClicked.addListener(handler),
  onButtonClicked: (handler) => chrome.notifications.onButtonClicked.addListener(handler),
  openUrl: (url) => void chrome.tabs.create({ url }),
  // Clicking a gathering notification IS a JOIN, from the notification
  // surface - so it goes through the same path a JOIN button does rather than
  // becoming a second, parallel notion of joining.
  onOpen: (channel) => {
    analytics.track('gathering_notification_clicked', {
      friend_count: gatheringSizes.get(channel) ?? 0,
    }, { source: 'notification', channel })
    analytics.recordJoin({
      channel,
      source: 'notification',
      socialCount: gatheringSizes.get(channel) ?? 0,
      navigated: true,
      alreadyOnTwitch: tabActivity.hasTabs(),
      alreadyOnDestination: currentChannel() === channel,
    })
  },
  iconUrl: chrome.runtime.getURL('icons/icon-128.png'),
})

/**
 * How big each live gathering is, so a notification event can say so.
 *
 * Kept here rather than passed through the notifier: the notifier's job is to
 * decide what to show, and it has no business carrying analytics payloads
 * around for something that happens minutes later.
 */
const gatheringSizes = new Map<string, number>()

/**
 * Decides when a gathering deserves an interruption. All the anti-spam rules
 * live in gatherings.ts; this only supplies the world and draws the result.
 */
const gatheringWatcher = createGatheringWatcher({
  onNotify: ({ channel, friendIds }) => {
    if (!preferences.get().gatheringNotifications) return
    const names = friendIds
      .map((id) => friendsState.friends.find((friend) => friend.user.id === id))
      .filter((friend) => friend !== undefined)
      .map((friend) => friend.user.displayName)
    // Friends are the best source of a channel's real casing: a channel is a
    // Twitch user, so if one of them IS this channel, their name is its name.
    analytics.track(
      'gathering_notification_shown',
      { friend_count: friendIds.length },
      { source: 'notification', channel },
    )
    notifier.notifyGathering({
      channel,
      names,
      channelName: resolveChannelName(channel, {
        people: friendsState.friends.map((friend) => friend.user),
        seen: channelNames,
      }),
    })
  },
})

function currentChannel(): string | null {
  const activity: Activity = tabActivity.effective()
  return activity.type === 'watching' ? activity.channel : null
}

/**
 * Recomputes what is worth noticing, and lets the watcher decide whether any
 * of it warrants a desktop notification.
 */
/**
 * Ask for metadata about every destination currently on the map.
 *
 * Called wherever attention is recomputed - which is exactly when the set of
 * destinations can have changed - rather than on a timer or from the
 * broadcast. `want` is idempotent and fetches only what is missing or
 * expired, so calling it more often than necessary costs a set intersection
 * and nothing else.
 *
 * The viewer's own channel is included: the HERE card should be able to say
 * that the stream they are watching has ended.
 */
function wantMetadata(): void {
  const channels = friendsState.friends.flatMap((friend) => {
    const activity = friend.presence?.activity
    return activity?.type === 'watching' ? [activity.channel] : []
  })

  const here = currentChannel()
  if (here) channels.push(here)

  metadata.want(channels)
}

/**
 * The channel the viewer is WATCHING WITH PEOPLE, as opposed to standing on.
 *
 * THE OFFLINE BUG, IN ONE FUNCTION
 *
 * Two accounts sat on twitch.tv/lirik with no stream running and Kickback said
 * they were watching together. Every layer was behaving correctly: presence
 * reported the page, the HERE cluster formed from presence, the room formed
 * from presence, and the shared-watch analytics lifecycle opened from presence.
 * The mistake was upstream of all of them - being ON a channel page was taken
 * as watching a stream, and no layer ever asked whether there was one.
 *
 * So there is now one question and one place that answers it, and everything
 * that means "together" reads THIS rather than currentChannel(): the reaction
 * inbox filter, the room query, the surface event, and the analytics
 * lifecycle. Presence itself is untouched - the Friends list still says a
 * friend is on an offline channel, because they are, and the Gravity card
 * still says OFFLINE rather than hiding the destination. What changes is only
 * whether a social space forms on top of it.
 *
 * Unknown metadata is not eligible. See core/socialViewing.ts for why that
 * costs a false negative on purpose.
 */
function socialChannel(): string | null {
  if (authState.status !== 'signed_in') return null
  const here = currentChannel()
  if (!canWatchTogether(here, metadata.snapshot())) return null

  /*
   * And we must already be visibly there.
   *
   * `stream_room_members` refuses unless the caller's own presence row says
   * they are on the channel, which is what stops it being an oracle for "who
   * is watching X". The client has to respect the same precondition, because
   * asking too early does not fail - it returns an empty room, and an empty
   * room is cached exactly as a real one is.
   *
   * That is what the real-browser bug was. Presence writes are debounced by a
   * second; metadata often resolves from the hydrated cache in the same tick
   * as the first activity report. So the membership query fired while our own
   * presence row did not yet exist, came back empty, and stayed empty - on
   * both accounts, every page load, symmetrically.
   *
   * `lastReported()` is the write, not the intent, so this is true only once
   * the row is really there. See presence.ts.
   */
  const reported = presenceReporter.lastReported()
  if (reported?.type !== 'watching' || reported.channel !== here) return null

  return here
}

function refreshAttention(): void {
  wantMetadata()
  // Runs wherever presence, friends or the current tab changed - which is
  // exactly when a Together can form or dissolve.
  noteTogetherSurface()

  const gatherings = findGatherings(
    friendsState.friends.flatMap((friend) => (friend.presence ? [friend.presence] : [])),
    // Friends on our own channel are HERE, not a place to be told to go.
    currentChannel() ? { type: 'watching', platform: 'twitch', channel: currentChannel()! } : undefined,
  ).filter((gathering) => gathering.userIds.length >= 2)

  attention.setItems([
    ...friendsState.incomingRequests.map((request) => ({
      key: friendRequestKey(request.requestId),
      kind: 'friend_request' as const,
      count: 1,
    })),
    ...groupsState.invites.map((invite) => ({
      key: groupInviteKey(invite.inviteId),
      kind: 'group_invite' as const,
      count: 1,
    })),
    // Muted groups still show a count in their own row; they just do not
    // contribute to the launcher badge.
    ...Object.entries(groupsState.groupUnread)
      .filter(([groupId, count]) => count > 0 && !groupsState.mutedGroupIds.includes(groupId))
      .map(([groupId, count]) => ({
        key: groupUnreadKey(groupId),
        kind: 'group_unread' as const,
        count,
      })),
    ...gatherings.map((gathering) => ({
      key: gatheringKey(gathering.channel),
      kind: 'gathering' as const,
      count: gathering.userIds.length,
    })),
  ])

  gatheringSizes.clear()
  for (const gathering of gatherings) {
    gatheringSizes.set(gathering.channel, gathering.userIds.length)
  }

  gatheringWatcher.update(
    gatherings.map((gathering) => ({
      channel: gathering.channel,
      friendIds: gathering.userIds,
    })),
    currentChannel(),
  )
}

/**
 * Twitch's own capitalisation for channels this browser has opened.
 *
 * Presentation only - every lookup, comparison and URL still uses the
 * lowercase login. Kept so a friend watching a channel you have also visited
 * is shown as "AnoterosTV" rather than the login, without asking Twitch's API
 * for something the page already told us.
 */
const CHANNEL_NAMES_KEY = 'kickback:channelNames'
/** Enough for anyone's rotation; oldest entries fall off first. */
const MAX_CHANNEL_NAMES = 300

let channelNames: Record<string, string> = {}

function rememberChannelName(channel: string, name: string): void {
  const login = channel.toLowerCase()
  // Only a different spelling of the same word; never a rename.
  if (name.toLowerCase() !== login) return
  if (channelNames[login] === name) return

  const entries = Object.entries(channelNames).filter(([key]) => key !== login)
  entries.push([login, name])
  channelNames = Object.fromEntries(entries.slice(-MAX_CHANNEL_NAMES))

  void chrome.storage.local.set({ [CHANNEL_NAMES_KEY]: channelNames })
  broadcast()
}

async function loadChannelNames(): Promise<void> {
  try {
    const stored = await chrome.storage.local.get(CHANNEL_NAMES_KEY)
    const value = stored?.[CHANNEL_NAMES_KEY]
    if (value && typeof value === 'object') {
      channelNames = Object.fromEntries(
        Object.entries(value as Record<string, unknown>).filter(
          ([key, name]) => typeof name === 'string' && name.toLowerCase() === key,
        ) as Array<[string, string]>,
      )
      broadcast()
    }
  } catch (error) {
    logError('loadChannelNames', error)
  }
}

void loadChannelNames()

function pushActivity(): void {
  // The emote catalog follows the channel even when signed out - it costs
  // nothing and means the picker is warm by the time chat is opened.
  emoteCatalog.setChannel(currentChannel())

  /*
   * A tab reporting activity is the definition of the Kickback session being
   * alive, so this is where it is kept alive - before the signed-in check,
   * because a session that starts while auth is still resolving is still that
   * session. Events queue until there is an actor to attribute them to.
   */
  if (tabActivity.hasTabs()) analytics.noteActive()
  analytics.noteChannel(currentChannel())

  /*
   * Follow the viewer, and only the viewer.
   *
   * The inbox subscription is per USER and lives as long as the session; what
   * changes here is only which channel's reactions are worth showing, and
   * which room to ask about. Driven from the same effective activity presence
   * reports, so multi-tab behaviour is inherited rather than re-derived.
   */
  const here = socialChannel()
  together.setChannel(here)
  room.want(here)

  if (authState.status !== 'signed_in') return
  presenceReporter.setActivity(tabActivity.effective())
  // Moving channels changes what counts as "somewhere else".
  refreshAttention()
  updateTogether()
}

/**
 * How many people visible to this user are on the same channel they are.
 *
 * Read from the one presence index every surface reads, through the same
 * selector the UI uses - so "Watching with you" on screen and
 * watching_together in analytics can never mean two different things.
 */
function coWatcherCount(channel: string | null): number {
  if (!channel) return 0
  const viewer: Activity = { type: 'watching', platform: 'twitch', channel }
  const selfId = authState.identity?.userId ?? null

  let count = 0
  for (const [userId, presence] of Object.entries(presenceIndex)) {
    if (userId === selfId) continue
    if (describePresence(presence, viewer).kind === 'watching_with_you') count += 1
  }
  return count
}

function updateTogether(): void {
  if (authState.status !== 'signed_in') return
  /*
   * The lifecycle measures SOCIAL VIEWING, not co-location.
   *
   * Passing socialChannel() rather than currentChannel() is what stops
   * watching_together_started firing for two people on a channel with no
   * stream on it - and passing the same value to the count keeps the two
   * halves of that claim from disagreeing. A channel that stops being eligible
   * arrives here as null, which is exactly what leaving it looks like, so the
   * open interval ends through the path that already existed.
   */
  const channel = socialChannel()
  analytics.noteTogether({ channel, otherCount: coWatcherCount(channel) })
}

// ------------------------------------------------------------------- state

let authState = auth.getState()
let friendsState = friends.getState()
let groupsState = groups.getState()

const ports = new Set<chrome.runtime.Port>()

/**
 * One state object out of two services. Friends come last so their real data
 * wins, but they are cleared whenever auth is not healthy - so a signed-out or
 * erroring panel can never still be showing a friends list.
 */
function currentState(): KickbackState {
  const attentionState = attention.getState()
  return {
    ...INITIAL_STATE,
    ...authState,
    ...friendsState,
    // One presence per person, stamped onto every projection of it. Two
    // surfaces cannot disagree because there is only one value.
    friends: stampFriends(friendsState.friends, presenceIndex),
    attention: attentionState.items,
    unread: attentionState.unread,
    preferences: preferences.get(),
    groups: groupsState.groups,
    groupInvites: groupsState.invites,
    groupSentInvites: groupsState.sentInvites,
    groupMembers: stampMembers(groupsState.members, presenceIndex),
    groupMessages: groupsState.messages,
    groupUnread: groupsState.groupUnread,
    mutedGroupIds: groupsState.mutedGroupIds,
    groupsLoading: groupsState.groupsLoading,
    groupsError: groupsState.groupsError,
    channelNames: { ...channelNames },
    channelMetadata: { ...metadata.snapshot() },
    togetherReactions: together.snapshot(),
    roomMembers: room.snapshot(),
  }
}

function broadcast(): void {
  const message: WorkerMessage = { type: 'state', state: currentState() }
  for (const port of ports) {
    try {
      port.postMessage(message)
    } catch {
      ports.delete(port)
    }
  }
}

let lastStatus = authState.status

auth.subscribe((next) => {
  authState = next

  if (next.status === 'signed_in' && next.identity) {
    // Only load on the transition, not on every unrelated auth update.
    if (lastStatus !== 'signed_in') {
      void friends.refresh()
      void groups.refresh()
      // Whatever tabs are already open should start counting immediately -
      // this is what makes a worker restart recover without a page reload.
      pushActivity()
      // Counts are read once the lists arrive; refresh() is already running.
      analytics.noteSignedIn({
        friendCount: friendsState.friends.length,
        groupCount: groupsState.groups.length,
      })
    }
    // start() is idempotent for the same user and swaps cleanly for a new one.
    socialSync.start(next.identity.userId)
    /*
     * The reaction inbox, for as long as the session lasts.
     *
     * Per USER rather than per channel - which is what gives every row exactly
     * one interested subscriber and is the whole of the one-way reaction fix.
     * Idempotent for the same id, so this is safe on every auth update.
     */
    together.setUser(next.identity.userId)
  } else {
    socialSync.stop()
    presenceSync.stop()
    presenceReporter.stop()
    friends.clear()
    groups.clear()
    groupSync.stop()
    attention.clear()
    gatheringWatcher.reset()
    together.reset()
    room.reset()
    /*
     * Public data, but still dropped on sign-out.
     *
     * Nothing in it is private - it is what Twitch shows anybody - but it is a
     * record of which channels this account's friends were on, and leaving it
     * for whoever signs in next would be a small, avoidable leak of the
     * previous account's social graph.
     */
    metadata.reset()
    // Only on the transition: a repeated signed_out update must not emit a
    // session end for a session that was already closed.
    if (lastStatus === 'signed_in') analytics.noteSignedOut()
  }

  lastStatus = next.status
  broadcast()
})

groups.subscribe((next) => {
  groupsState = next
  // A roster snapshot carries presence for people we may know only through
  // this group - fold it in before anything renders.
  presenceIndex = mergePresence(
    presenceIndex,
    Object.values(next.members).flatMap((roster) => roster.map((member) => member.presence)),
  )
  watchPresence()
  if (authState.status === 'signed_in' && authState.identity) {
    groupSync.setGroups(
      authState.identity.userId,
      next.groups.map((group) => group.groupId),
    )
    refreshAttention()
    updateTogether()
  }
  broadcast()
})

friends.subscribe((next) => {
  friendsState = next
  presenceIndex = mergePresence(
    presenceIndex,
    next.friends.map((friend) => friend.presence),
  )
  if (authState.status === 'signed_in') {
    refreshAttention()
    updateTogether()
  }
  watchPresence()
  broadcast()
})

/**
 * Subscribe to exactly the people we can currently see: friends, plus anyone
 * we share a group with.
 *
 * The group half is the part that was missing. The channel filtered on friend
 * ids, so a non-friend group member's updates never arrived at all - no amount
 * of fixing the client-side plumbing would have helped while the server was
 * never asked for them.
 */
function watchPresence(): void {
  if (authState.status !== 'signed_in') return
  const watched = watchedUserIds(
    friendsState.friends,
    groupsState.members,
    authState.identity?.userId ?? null,
  )
  // People we can no longer see stop being tracked, so a removed group member
  // does not leave a frozen presence behind.
  presenceIndex = forgetPresence(
    presenceIndex,
    Object.keys(presenceIndex).filter(
      (userId) => userId !== authState.identity?.userId && !watched.includes(userId),
    ),
  )
  presenceSync.setFriends(watched)
}

attention.subscribe(() => broadcast())
preferences.subscribe(() => broadcast())

// --------------------------------------------------------------------- rpc

const RPC_HANDLERS: Record<RpcMethod, (args: unknown[]) => Promise<unknown>> = {
  searchUsers: async ([query]) => {
    const results = await friends.search(String(query ?? ''))
    // The query itself is never recorded - only whether it found anybody, and
    // by which of the two ways of finding someone.
    analytics.track('friend_search', {
      result_count: results.length,
      matched_by: results[0]?.matchedBy ?? 'none',
    })
    return results
  },
  sendFriendRequest: async ([userId]) => {
    const outcome = await friends.sendRequest(String(userId))
    analytics.track('friend_request_sent', { outcome })
    return outcome
  },
  respondToFriendRequest: async ([requestId, accept]) => {
    const outcome = await friends.respond(String(requestId), accept === true)
    if (outcome === 'accepted') {
      analytics.track('friend_request_accepted', { direction: 'incoming' })
    }
    return outcome
  },
  acceptFriendRequestFrom: async ([userId]) => {
    const outcome = await friends.acceptFrom(String(userId))
    analytics.track('friend_request_accepted', { direction: 'incoming' })
    return outcome
  },
  cancelFriendRequest: ([requestId]) => friends.cancel(String(requestId)),
  removeFriend: async ([userId]) => {
    await friends.remove(String(userId))
    analytics.track('friend_removed')
  },
  refreshFriends: () => friends.refresh(),
  createGroup: async ([name, icon]) => {
    const groupId = await groups.createGroup(String(name), typeof icon === 'string' ? icon : null)
    analytics.track('group_created')
    return groupId
  },
  setGroupIcon: ([groupId, icon]) =>
    groups.setGroupIcon(String(groupId), typeof icon === 'string' ? icon : null),
  renameGroup: ([groupId, name]) => groups.renameGroup(String(groupId), String(name)),
  deleteGroup: ([groupId]) => groups.deleteGroup(String(groupId)),
  inviteToGroup: async ([groupId, userId]) => {
    const result = await groups.invite(String(groupId), String(userId))
    analytics.track(
      'group_invite_sent',
      { member_count: groupsState.members[String(groupId)]?.length ?? 0 },
      { source: 'group' },
    )
    return result
  },
  cancelGroupInvite: ([groupId, userId]) =>
    groups.cancelInvite(String(groupId), String(userId)),
  respondToGroupInvite: async ([inviteId, accept]) => {
    const groupId = await groups.respondToInvite(String(inviteId), accept === true)
    if (accept === true) {
      analytics.track(
        'group_invite_accepted',
        { member_count: groupsState.members[groupId]?.length ?? 0 },
        { source: 'group' },
      )
    }
    return groupId
  },
  leaveGroup: ([groupId]) => groups.leaveGroup(String(groupId)),
  removeGroupMember: ([groupId, userId]) =>
    groups.removeMember(String(groupId), String(userId)),
  sendGroupMessage: async ([groupId, body]) => {
    // Bare emote names become stable provider+id tokens here, once, so the
    // message records exactly which emote was meant.
    const resolved = emoteCatalog.resolveOutgoing(String(body))
    await groups.sendMessage(String(groupId), resolved)
    /*
     * Shape, never content. The bucket and the flag are computed here and the
     * message itself is discarded - there is no property key a body could go
     * in, and nothing downstream ever sees one.
     */
    analytics.track(
      'group_message_sent',
      {
        length_bucket: lengthBucket(resolved.length),
        // Whether there was an emote, never which one - asked through the same
        // parser chat renders with, so the two cannot disagree.
        has_emote: parseMessage(resolved).some((segment) => segment.type === 'emote'),
      },
      { source: 'group' },
    )
  },
  searchEmotes: ([query]) => Promise.resolve(emoteCatalog.search(String(query ?? ''))),
  setGroupMuted: ([groupId, muted]) => groups.setMuted(String(groupId), muted === true),
  setPreferences: async ([patch]) =>
    preferences.set((patch ?? {}) as Parameters<typeof preferences.set>[0]),
  setPresenceVisibility: async ([mode]) => {
    const result = await setPresenceVisibility(supabase, String(mode))
    if (result.error) throw new Error('Could not change your presence setting.')
    // The stored setting changed, so re-report under the new rule and re-read
    // identity, which carries the setting the panel displays.
    presenceReporter.stop()
    pushActivity()
    await auth.reloadIdentity()
    return result.value
  },
}

async function handleRpc(port: chrome.runtime.Port, message: ClientMessage): Promise<void> {
  if (message.type !== 'rpc') return

  const handler = RPC_HANDLERS[message.method]
  const reply = (result: WorkerMessage) => {
    try {
      port.postMessage(result)
    } catch {
      ports.delete(port)
    }
  }

  if (!handler) {
    reply({ type: 'rpcResult', callId: message.callId, ok: false, error: 'Unknown request' })
    return
  }

  // Friend operations require a live session; refreshing first means a request
  // made just after the token expired succeeds instead of failing confusingly.
  const signedIn = await auth.ensureFreshSession()
  if (!signedIn) {
    reply({
      type: 'rpcResult',
      callId: message.callId,
      ok: false,
      error: 'Your Kickback session ended. Sign in again.',
    })
    return
  }

  try {
    const value = await handler(message.args)
    reply({ type: 'rpcResult', callId: message.callId, ok: true, value: value ?? null })
  } catch (error) {
    reply({
      type: 'rpcResult',
      callId: message.callId,
      ok: false,
      error: error instanceof Error ? error.message : 'Something went wrong',
    })
  }
}

// -------------------------------------------------------------------- tabs

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== PORT_NAME) return

  ports.add(port)
  port.postMessage({ type: 'state', state: currentState() } satisfies WorkerMessage)

  port.onMessage.addListener((raw: ClientMessage) => {
    switch (raw?.type) {
      case 'hello':
        port.postMessage({ type: 'state', state: currentState() } satisfies WorkerMessage)
        break
      case 'signIn':
        void auth.signIn()
        break
      case 'signOut':
        void auth.signOut()
        break
      case 'retry':
        void auth.retry()
        break
      case 'activity': {
        const channel = typeof raw.channel === 'string' ? raw.channel : null
        tabActivity.update(port, {
          channel,
          visible: raw.visible === true,
          updatedAt: Date.now(),
        })
        if (channel && typeof raw.channelName === 'string') {
          rememberChannelName(channel, raw.channelName)
        }
        pushActivity()
      }
        break
      case 'reaction':
        /*
         * Validated here as well as in SQL.
         *
         * The database is the authority - it checks against the same fixed
         * list - but a tab is not a trusted caller, and there is no reason to
         * spend a round trip discovering that.
         */
        // Recorded when it is DELIVERED, not when it is asked for - see the
        // onReaction handler. A send that fails should not appear as an
        // interaction that happened.
        if (isReaction(raw.reaction)) together.send(raw.reaction)
        break
      case 'seen':
        if (Array.isArray(raw.keys)) attention.markSeen(raw.keys)
        else if (raw.kind) attention.markKindSeen(raw.kind)
        break
      case 'groupRead':
        if (typeof raw.groupId === 'string') {
          groups.markGroupRead(raw.groupId)
          attention.markSeen([groupUnreadKey(raw.groupId)])
        }
        break
      /*
       * ------------------------------------------------------- analytics
       *
       * All three are one-way and none of them replies. A tab that reports an
       * impression or a JOIN is telling the worker something, not asking for
       * anything, and nothing it does may depend on the answer.
       */
      case 'analytics':
        if (isAnalyticsEventName(raw.name)) {
          analytics.track(raw.name, raw.properties as never, {
            source: raw.source,
            channel: raw.channel ?? null,
          })
        }
        break
      case 'join':
        if (typeof raw.channel === 'string') {
          analytics.recordJoin({
            channel: raw.channel,
            source: raw.source,
            socialCount: Number.isFinite(raw.socialCount) ? raw.socialCount : 0,
            navigated: raw.navigated === true,
            /*
             * Both of these are the WORKER'S to know, not the tab's.
             *
             * "Was this person already on Twitch" is a fact about every tab
             * they have open, which no single content script can see - and it
             * is one of the facts the incremental-session question later
             * depends on, so it must not be a guess made by the surface that
             * benefits from the answer.
             */
            alreadyOnTwitch: tabActivity.hasTabs(),
            alreadyOnDestination:
              currentChannel()?.toLowerCase() === raw.channel.trim().toLowerCase(),
          })
        }
        break
      case 'exposure':
        analytics.noteExposure({
          friends: Array.isArray(raw.friends) ? raw.friends : [],
          gatherings: Array.isArray(raw.gatherings) ? raw.gatherings : [],
          // Defaulted rather than required: a tab still running a previous
          // build reports no gravity, and must not break the handler.
          gravity: Array.isArray(raw.gravity) ? raw.gravity : [],
        })
        break
      case 'rpc':
        void handleRpc(port, raw)
        break
    }
  })

  port.onDisconnect.addListener(() => {
    ports.delete(port)
    // A closed tab stops contributing. If it was the last one, the reporter's
    // grace period decides whether this was a navigation or a real departure.
    tabActivity.remove(port)
    pushActivity()
  })
})

// -------------------------------------------------------------- lifecycle

chrome.alarms.create(REFRESH_ALARM, { periodInMinutes: REFRESH_PERIOD_MINUTES })

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name !== REFRESH_ALARM) return
  void auth.ensureFreshSession()
  // Safety net, not a polling strategy: if the socket died quietly, this puts
  // the friends list right within the half hour rather than never.
  if (authState.status === 'signed_in') void friends.refresh()
})

chrome.runtime.onStartup.addListener(() => {
  void preferences.hydrate()
void attention.hydrate()
// A worker that has just woken should not start from a cold metadata cache;
// a day-old record is dropped on the way in rather than shown.
void metadata.hydrate()

/*
 * A way to ask the deployed backend a direct question, from the worker console.
 *
 *     await kickbackMetadata.check('lvndmark')
 *
 * Development and beta only, and it exists because the alternative is
 * inferring backend health from whether some React card looks right. It uses
 * the session this worker already holds, so there is no token to paste and
 * none to leak: the answer is the function's own response, which contains
 * channel metadata and diagnostic CODES and nothing else.
 *
 * `snapshot()` shows what the worker currently believes, so "the backend
 * answered" and "the panel is showing it" can be told apart.
 */
if (METADATA_DIAGNOSTICS) {
  ;(globalThis as unknown as Record<string, unknown>).kickbackMetadata = {
    async check(...channels: string[]) {
      const logins = channels.length > 0 ? channels : ['lvndmark']
      try {
        return await metadataBackend.fetch(logins.map((channel) => channel.toLowerCase()))
      } catch (error) {
        // The message, not the error - a rejected fetch can carry a request
        // object, and a request object carries headers.
        return { error: error instanceof Error ? error.message : 'request failed' }
      }
    },
    snapshot: () => metadata.snapshot(),
  }
}
void groups.hydrate()
void auth.initialize()
})

chrome.runtime.onInstalled.addListener(() => {
  void auth.initialize()
})

// The worker is also revived by a tab connecting or an alarm firing, and each
// revival re-runs this module - so initialising here covers every wake-up.
void auth.initialize()
