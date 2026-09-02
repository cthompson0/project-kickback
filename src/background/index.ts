import { IS_GECKO, ext } from '../platforms/browser'
import type { ExtensionPort } from '../platforms/browser'
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
import type { PresenceBackend } from './presence'
import { createActivityRegistry } from './activity'
import { createFriendDestinations } from './friendDestinations'
import {
  openSessionChannels,
  peersOnChannel,
  restoredSessionChannel,
  sessionChannelOf,
  unreadByChannel,
} from './sessionState'
import { needsRefresh } from '../core/twitchMetadata'
import { normalizeInviteCode } from '../core/invites'
import type { DisplayedBadge, EarnedBadge } from './supabaseBackend'
// The same selector and the same expansion the panel renders from, so the
// diagnostic below cannot report a map the UI does not draw.
import {
  GRAVITY_THRESHOLD,
  gravityChannels,
  gravityModel,
  isGravity,
} from '../core/socialGravity'
import type { DestinationsByUser } from '../core/socialGravity'
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
import { createRoomMessages } from './roomMessages'
import { createSessionTab } from './sessionTab'
import { MAX_MESSAGE_LENGTH } from '../core/roomMessages'
import { isEmoteOnly } from '../core/emotes'
import { directCount } from '../core/streamRoom'
import { isReaction } from '../core/together'
import { canWatchLiveTogether, watchTogetherState } from '../core/socialViewing'
import { createStoredValue, isJoinAttribution, isSessionRecord } from './storedValue'
import { isPersistedLifecycle } from './togetherStore'
import type { PersistedLifecycle } from './togetherStore'
import { isPersistedDwell } from './channelDwell'
import type { DwellStream, PersistedDwell } from './channelDwell'
import { resolveArm } from '../core/experiment'
import type { SessionRecord } from './analyticsSession'
import type { JoinAttribution } from './joinAttribution'
import { describePresence } from '../core/personPresence'
import type { AnalyticsEnvironment } from '../core/analytics'
import { isAnalyticsEventName } from '../core/analytics'
import { createNotifier } from './notifier'
import { toFailureCode, toFailureContext } from '../core/failures'
import type { RealtimeStatus, RealtimeSurface } from '../core/failures'
import { findGatherings } from '../core/presence'
import { parseMessage } from '../core/emotes'
import { destinationBucket, lengthBucket } from '../core/analytics'
import type { Activity } from '../core/types'
import {
  createSupabaseGroupChannel,
  createSupabasePresenceChannel,
  createSupabaseSocialChannel,
  createSupabaseTogetherChannel,
  createSupabaseRoomMessageChannel,
} from './supabaseRealtime'
import {
  createSupabaseAnalyticsBackend,
  recordRelationship,
  createSupabaseMetadataBackend,
  createSupabaseRoomBackend,
  createSupabaseRoomMessageBackend,
  createSupabaseTogetherBackend,
  createSupabaseBackend,
  createSupabaseClient,
  createSupabaseFriendsBackend,
  createSupabaseGroupsBackend,
  createSupabasePresenceBackend,
  listFriendDestinations,
  listDisplayedBadges,
  claimInvite,
  badgeCatalog,
  myBadges,
  myInviteCode,
  myReferralSummary,
  setDisplayedBadge,
  suggestFriends,
  setPresenceVisibility,
} from './supabaseBackend'
import { createExtensionStorage } from './storage'
import { PORT_NAME } from '../client/messages'
import type { ClientMessage, RpcMethod, WorkerMessage } from '../client/messages'
import type { KickbackState } from '../client/types'
import { INITIAL_STATE } from '../client/types'

/**
 * Watchside's service worker: the one place that holds a session and talks to
 * Supabase. Twitch tabs connect over a port and receive state; they never see a
 * token, and they never call the database themselves.
 *
 * MV3 workers are killed after ~30s idle, so nothing here may live only in
 * memory. The session is in extension storage, and an alarm brings the
 * worker back to refresh it.
 */

const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL
const SUPABASE_PUBLISHABLE_KEY = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY

const REFRESH_ALARM = 'kickback:refresh-session'
const REFRESH_PERIOD_MINUTES = 30

const storage = createExtensionStorage(ext.storage)

// Startup diagnostic. Logs which project the worker is pointed at and how long
// the key is - never the key itself. A truncated key is otherwise invisible:
// it fails much later, as "Invalid API key" from the code exchange.
console.info(
  '[Watchside] worker starting',
  JSON.stringify({
    supabaseUrl: SUPABASE_URL,
    publishableKeyLength: SUPABASE_PUBLISHABLE_KEY?.length ?? 0,
    mode: import.meta.env.VITE_KICKBACK_MODE ?? 'production',
  }),
)

if (!SUPABASE_URL || !SUPABASE_PUBLISHABLE_KEY) {
  console.error(
    '[Watchside] missing Supabase configuration - copy .env.example to .env.local and rebuild',
  )
}

const supabase = createSupabaseClient(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY, storage)

/**
 * Reports a failure to analytics.
 *
 * A late binding rather than a direct call, because `logError` is wired into
 * every service that is constructed BEFORE the analytics hub exists - and a
 * failure during construction is exactly the kind worth keeping. Until the hub
 * is built this is a no-op; afterwards every call site already points here.
 */
let reportFailure: ((context: string, error: unknown) => void) | null = null

const logError = (context: string, error: unknown) => {
  // Never log the error object itself - Supabase errors can quote the request.
  console.warn(`[Watchside] ${context} failed:`, error instanceof Error ? error.message : error)
  /*
   * And now it leaves the machine, as a call site and a shape - never a
   * message. See core/failures.ts for why that distinction is the whole design.
   *
   * Analytics' own failures are excluded, and not merely to avoid noise: an
   * analytics flush that fails would record an event, which would need
   * flushing, which would fail.
   */
  if (context.startsWith('analytics.')) return
  reportFailure?.(context, error)
}

/** Last status seen per surface, so only genuine transitions are recorded. */
const realtimeStatus = new Map<RealtimeSurface, RealtimeStatus>()

/**
 * A realtime subscription changed state.
 *
 * Transitions only. A channel that reconnects every thirty seconds is a
 * different story from one that connected once, and recording every repeat of
 * the same status would bury the difference.
 */
function noteRealtime(surface: RealtimeSurface, status: 'connected' | 'error'): void {
  const previous = realtimeStatus.get(surface)
  // Coming back after a failure is its own answer, not another 'connected'.
  const next: RealtimeStatus =
    status === 'connected' && previous === 'error' ? 'reconnected' : status
  if (previous === next) return
  realtimeStatus.set(surface, next)
  console.info(`[Watchside] ${surface} realtime`, next)
  analytics.track('realtime_status_changed', { surface, status: next })
}

const auth = createAuthService({
  backend: createSupabaseBackend(supabase),
  launchWebAuthFlow: (url) => ext.identity.launchWebAuthFlow(url),
  redirectUrl: ext.identity.getRedirectURL(),
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
  onInvalidate: () => {
    void friends.refresh()
    /*
     * The room walk depends on the social graph too, so it re-asks here.
     *
     * Membership is otherwise only re-asked when somebody arrives on or leaves
     * this channel, and a block is neither. Worse, the person a block removes
     * may be a bridge the viewer has never seen: A reaches C only through B,
     * so when A blocks B nothing about C's presence changes for A - C was
     * never visible to A in the first place. Without this the stale membership
     * would stand until the refresh interval happened to lapse.
     */
    room.invalidate()
    room.want(sessionChannels())
  },
  onStatusChange: (status) => {
    if (status === 'connected' || status === 'error') noteRealtime('social', status)
  },
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

/**
 * The ONE way `presenceIndex` is allowed to change.
 *
 * WS-F5-01 LIVED IN THE GAP THIS CLOSES.
 *
 * Who is here with the viewer decides what the room contains, and the room is
 * the only surface that cannot work that out for itself: it is a server answer,
 * cached for two heartbeats, and nothing else would ever re-ask it. So the
 * co-presence comparison below has to run whenever the index changes.
 *
 * It used to live inside `indexPresence`, which is only the REALTIME path.
 * Three other places assigned `presenceIndex` directly - the friends
 * subscription, the groups subscription, and `watchPresence` - and none of them
 * ran the comparison. An arrival that reached the client through the friends
 * service therefore updated every presence-derived surface while the room was
 * never invalidated: measured in the two-actor E2E as a HERE card lighting up
 * in 2.3 seconds beside a roster that stayed empty for 122s, 132s and >150s,
 * until the ninety-second cache happened to lapse.
 *
 * Note what this is NOT: the protection in `ask()` guards an invalidation that
 * races a request already in the air. It presumes an invalidation happens at
 * all. Here none did, so a downstream guard could never have helped - which is
 * why the existing fix, and its comment describing this exact symptom, did not
 * cover this path.
 *
 * Making the assignment and its consequence the same statement is what stops a
 * fourth writer reintroducing it. `presenceIndexAssignments` in
 * tests/extension/roomInvalidation.test.ts fails if one ever does.
 *
 * Returns whether anything actually changed, so callers can skip work.
 */
function setPresenceIndex(next: PresenceIndex): boolean {
  if (next === presenceIndex) return false
  presenceIndex = next

  /*
   * Keyed on WHO is here rather than on every presence tick, so this is one
   * query per actual arrival or departure, not one per heartbeat per friend.
   */
  const key = coPresenceKey(sessionChannel())
  if (key !== coPresence) {
    coPresence = key
    room.invalidate()
  }
  room.want(sessionChannels())
  return true
}

function indexPresence(next: PresenceIndex): void {
  if (!setPresenceIndex(next)) return
  // Somebody arriving on or leaving the channel this user is watching is
  // exactly what starts and ends a shared watch, so it is re-evaluated here
  // rather than only when the local user navigates.
  updateTogether()
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
    /*
     * A presence event means their destinations may have moved too - the
     * destination write updates presence.last_seen_at in the same RPC, so this
     * is the signal.
     *
     * Coalesced by a second rather than fired per event: a heartbeat from
     * every friend every 45s would otherwise be a query per beat.
     */
    scheduleDestinationsRefresh()
  },
  onPresenceGone: (userId) => {
    friends.clearPresence(userId)
    indexPresence(clearIndexed(presenceIndex, userId, Date.now()))
  },
  // A reconnect may have missed changes; re-read once rather than assume.
  onResync: () => {
    void friends.refresh()
    refreshFriendDestinations()
    // Group rosters carry presence too, and a reconnect may have missed
    // changes to people we only know through a group.
    void groups.refresh()
  },
  onStatusChange: (status) => {
    if (status === 'connected' || status === 'error') noteRealtime('presence', status)
  },
  onError: logError,
})

/*
 * Verbose diagnostics, off in production.
 *
 * A build-time constant, so a production bundle folds the whole diagnostic
 * path away rather than merely declining to print it.
 */
const DIAGNOSTICS = (import.meta.env.VITE_KICKBACK_ENV ?? 'development') !== 'production'

/** One presence write, as it went out. */
interface PresenceWrite {
  at: string
  call: 'report_destinations' | 'report_presence' | 'report_offline'
  /** The exact array handed to the RPC. Null where the call takes none. */
  payload: string[] | null
}

/**
 * The last few presence writes, oldest first.
 *
 * Development only, and it exists because of a specific failure: the hosted
 * table said one destination while every test said three, and there was no way
 * from inside the browser to tell whether the payload was wrong or the write
 * was. This answers that in one line.
 *
 * Channel names appear here. That is deliberate and it is confined to a
 * development console - nothing here reaches analytics or failure telemetry,
 * which take a fixed vocabulary and never a channel.
 */
const presenceWrites: PresenceWrite[] = []
const PRESENCE_WRITE_LOG = 40

function notePresenceWrite(call: PresenceWrite['call'], payload: string[] | null): void {
  const entry: PresenceWrite = { at: new Date().toISOString(), call, payload }
  presenceWrites.push(entry)
  if (presenceWrites.length > PRESENCE_WRITE_LOG) presenceWrites.shift()
  console.info('[Watchside] presence write', entry.at, call, payload ?? '')
}

/**
 * Records what actually goes to the server, without changing what is sent.
 *
 * A pass-through in production, and literally the same object - so the thing
 * being observed is the thing that ships.
 */
function watchPresenceWrites(backend: PresenceBackend): PresenceBackend {
  if (!DIAGNOSTICS) return backend
  return {
    reportPresence(platform, channel) {
      notePresenceWrite('report_presence', channel ? [channel] : [])
      return backend.reportPresence(platform, channel)
    },
    reportDestinations(channels) {
      notePresenceWrite('report_destinations', [...channels])
      return backend.reportDestinations(channels)
    },
    // Not recorded: it carries nothing and would drown the other three.
    heartbeat: () => backend.heartbeat(),
    reportOffline() {
      notePresenceWrite('report_offline', null)
      return backend.reportOffline()
    },
  }
}

/** Our own presence: what this browser is watching, and that it still is. */
const presenceReporter = createPresenceReporter({
  backend: watchPresenceWrites(createSupabasePresenceBackend(supabase)),
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
  /*
   * Recorded on the WRITE, with what the server kept.
   *
   * The published count can be smaller than the requested one when the cap of
   * three bit, and that difference is the entire question this event exists to
   * answer - so it is read back from the server rather than assumed from what
   * was sent.
   *
   * The channels themselves are never here. A bucket answers "is three
   * enough"; a list would be a viewing record.
   */
  onDestinations: ({ requested, published }) => {
    analytics.track('destinations_published', {
      count_bucket: destinationBucket(published),
      at_max: requested > published || published >= 3,
    })
  },
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

const storageArea = ext.storage

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
  /*
   * Firefox collects no technicalAndInteraction data. See the F6 report.
   *
   * Mozilla allows that family only behind an OPTIONAL permission, and an
   * optional permission is a second consent prompt plus a setting to honour.
   * Watchside would rather not collect the data than ask for it, so on Gecko
   * the diagnostic events are dropped at the recorder and never queued.
   *
   * This is the ONLY engine-dependent product decision in the worker, and it is
   * expressed once, here, rather than as a browser check anywhere near a call
   * site. Chromium is unaffected: the flag is true and nothing changes.
   */
  collectTechnical: !IS_GECKO,
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
  /*
   * The open dwell interval, for the same reason and under the same rules.
   *
   * A separate key rather than a field on the one above: the two intervals
   * begin and end at different moments, so a single stored value would have to
   * claim one "last moment we could vouch for" answer covering both, and would
   * be wrong about one of them.
   */
  dwellStore: createStoredValue<PersistedDwell>(
    storageArea,
    'kickback:analytics:dwell',
    isPersistedDwell,
  ),
  // No actor, no events sent. They queue rather than being thrown away, so a
  // session that starts before auth resolves is not lost.
  canSend: () => authState.status === 'signed_in',
  // Who a stored interval must belong to before it may be resumed or ended.
  selfId: () => authState.identity?.userId ?? null,
  /*
   * M3D. What the SERVER last said about measuring this actor.
   *
   * Read at each JOIN rather than captured once: a credential can be revoked on
   * Twitch between one JOIN and the next, and `null` - "we could not ask" - must
   * behave as not-ready rather than as permission.
   */
  measurementReadiness: () => authState.measurementReadiness,
  measureRelationship: (input) => recordRelationship(supabase, input),
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
  onStatusChange: (status) => {
    if (status === 'connected' || status === 'error') noteRealtime('group', status)
  },
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
  onStatus: (status) => noteRealtime('together', status),
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
      { participant_count: roomSize(reaction.channel), direction: mine ? 'sent' : 'received' },
      { source: 'together', channel: reaction.channel },
    )
  },
  onError: logError,
})

/**
 * The conversation, and what the panel remembers about the session tab.
 *
 * Both hang off the same eligible channel the room does, so there is still
 * exactly one question - socialChannel() - deciding whether any of this
 * exists. Nothing here decides who may see what; that was settled when the
 * server wrote the row.
 */
const roomChat = createRoomMessages({
  onStatus: (status) => noteRealtime('room', status),
  channel: createSupabaseRoomMessageChannel(supabase),
  backend: createSupabaseRoomMessageBackend(supabase),
  onChange: () => broadcast(),
  onMessage: (message, mine) => {
    if (!mine) return
    /*
     * Recorded on the SENDER's own copy arriving, not on the send call.
     *
     * The self-row is the one signal that the server accepted it, so this
     * cannot count a message the room never got. Length bucket and an emote
     * flag only - the body answers no question we have.
     */
    analytics.track(
      'automatic_room_message_sent',
      {
        length_bucket: lengthBucket(message.body.length),
        has_emote: isEmoteOnly(message.body) || parseMessage(message.body).some((segment) => segment.type === 'emote'),
        participant_count: roomSize(message.channel),
      },
      { source: 'together', channel: message.channel },
    )
  },
  onError: logError,
})

const sessionTab = createSessionTab({
  storage: storageArea,
  onChange: () => broadcast(),
  onError: logError,
})

/**
 * The session the viewer intentionally opened, if it is still real.
 *
 * Three conditions, all checked against live state rather than trusted from
 * storage: the same canonical destination, still eligible (which is what
 * makes "still live" true), and a room that still has somebody in it. A
 * remembered selection can therefore never reopen an unrelated streamer's
 * room - the worst it can do is be ignored.
 */
function restoredSession(): string | null {
  const remembered = sessionTab.selected()
  if (!remembered) return null
  return restoredSessionChannel({
    remembered,
    here: sessionChannel(),
    members: room.snapshot(remembered),
    peers: peersOn(remembered),
    messages: roomChat.snapshot(),
  })
}

/**
 * Messages waiting, per destination.
 *
 * Keyed by channel because unread is a fact about a conversation, and a viewer
 * with two rooms open has two of them. `sessionTab.readAt` was already per
 * channel; this is what finally uses it that way.
 *
 * Computed over every channel that has retained messages rather than only the
 * open ones, so a room kept alive by its conversation still shows a count.
 */
function roomUnreadMap(): Record<string, number> {
  return unreadByChannel({
    messages: roomChat.snapshot(),
    open: sessionChannels(),
    readAt: (channel) => sessionTab.readAt(channel),
    selfId: authState.identity?.userId ?? null,
  })
}

/** Everyone in one room, including the viewer. Zero when there is no room. */
function roomSize(channel: string | null): number {
  const members = room.snapshot(channel).length
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
  // The session rule, not the live one: a room that exists on an offline
  // channel is still a room somebody arrived in.
  const here = sessionChannel()
  const members = room.snapshot(here)
  const peers = here ? peersOn(here) : []

  if (!here || (members.length === 0 && peers.length === 0)) {
    togetherShownFor = null
    return
  }
  if (togetherShownFor === here) return

  togetherShownFor = here
  analytics.track(
    'automatic_room_entered',
    {
      participant_count: Math.max(members.length, peers.length) + 1,
      // The question the connected-component model exists to answer: is
      // friend-of-friend exposure actually happening, or is every room just
      // the viewer's own friends?
      direct_friend_count: directCount(members),
    },
    { source: 'together', channel: here },
  )
}

const attention = createAttentionService({ storage: storageArea, onError: logError })

/*
 * Every friend's active destinations, keyed by user id.
 *
 * Re-read rather than derived from presence, because presence carries one
 * channel and this is the set. It is refreshed on the same signals the friend
 * list is - a social change, a presence event, a reconnect - and coalesced, so
 * a room full of people heartbeating does not turn into a query per beat.
 *
 * A read that fails leaves the previous answer in place. Losing the map would
 * make every friend look like they were nowhere, which is worse than showing a
 * slightly old set for a few seconds.
 */
const friendDestinationsStore = createFriendDestinations({
  fetch: () => listFriendDestinations(supabase),
  /*
   * THE MISSING TRIGGER.
   *
   * A changed destination set is not only something to draw - it is something
   * to ASK TWITCH ABOUT. Two channels that were not on the map a moment ago
   * have no metadata, and nothing else in the worker is watching for that.
   *
   * Before this, the order was reliably wrong. A friend opening a second
   * stream produces a presence event, which fires `refreshAttention` -> `
   * wantMetadata` immediately, using the destination set as it was A SECOND
   * BEFORE THE NEW ONE ARRIVED. The destinations then landed on the coalesced
   * read, the panel drew three cards, and nobody asked about the two new
   * channels until the friend's NEXT heartbeat forty-five seconds later.
   * Delayed, partial, and cured by a refresh - which is exactly what was
   * reported.
   *
   * Enrichment first, then the broadcast: `want` is synchronous and only
   * starts requests, so this costs nothing and keeps the two in one place.
   */
  onChange: () => {
    wantMetadata()
    broadcast()
  },
  onError: logError,
})

/** The set itself, for everything that only needs to read it. */
/**
 * The invite code this browser saw before it had an account to attribute it to.
 *
 * A recipient clicks a link, installs, and only then signs in - so the code
 * arrives from a Twitch URL long before there is an actor. It is held here and
 * claimed the moment authentication completes. Kept in session memory only: an
 * unclaimed code is worth nothing, and persisting it would mean storing
 * somebody else's identifier for no benefit.
 */
let pendingInviteCode: string | null = null
let inviteLinkAnnounced = false
let displayedBadge: EarnedBadge | null = null
let referralCount = 0
/**
 * Which badge each visible person is showing.
 *
 * Read rather than pushed, on the same schedule as the badge shelf: badges
 * change on the order of days, so a broadcast carrying a stale one is worse
 * than one carrying none.
 */
let socialBadges: Readonly<Record<string, DisplayedBadge>> = {}

/**
 * Claim a code, and record what the server said.
 *
 * Every outcome is ordinary -  is the anti-duplicate-credit rule
 * working, not a failure - so none of them raises. The code is normalised
 * first, because people paste whole links and lower case.
 */
async function claimPendingInvite(raw: string): Promise<string> {
  const code = normalizeInviteCode(raw)
  if (!code) {
    analytics.track('invite_claimed', { outcome: 'unknown' })
    return 'unknown'
  }
  if (authState.status !== 'signed_in') {
    // Nothing to attribute to yet. Hold it for the sign-in.
    pendingInviteCode = code
    return 'pending'
  }

  const result = await claimInvite(supabase, code)
  if (result.error) {
    logError('invite.claim', result.error)
    return 'unknown'
  }
  const outcome = result.value ?? 'unknown'
  analytics.track('invite_claimed', {
    outcome: outcome as 'attributed' | 'already' | 'self' | 'blocked' | 'unknown',
  })
  if (outcome === 'attributed') pendingInviteCode = null
  void refreshBadges()
  return outcome
}

/** Whatever was waiting for an account, now that there is one. */
function claimInviteAfterSignIn(): void {
  if (!pendingInviteCode) return
  const code = pendingInviteCode
  pendingInviteCode = null
  void claimPendingInvite(code)
}

/**
 * The badge the user chose to show, and how many referrals have landed.
 *
 * Read rather than pushed: both change rarely, and a broadcast carrying stale
 * values is worse than one carrying none. Refreshed on sign-in, after a claim,
 * and whenever the user changes their selection.
 */
async function refreshBadges(): Promise<void> {
  if (authState.status !== 'signed_in') return

  const [badgeResult, summary] = await Promise.all([
    myBadges(supabase),
    myReferralSummary(supabase),
  ])

  const badges = badgeResult.value ?? []
  const nextBadge = badges.find((badge) => badge.displayed) ?? null
  const nextCount = summary.value?.successful ?? 0

  /*
   * And what everybody else is showing.
   *
   * Failure is silence rather than an error: against a database without 0027
   * this returns nothing, and the panel draws the badges it drew before the
   * projection existed - which is none.
   */
  const social = await listDisplayedBadges(supabase)
  const nextSocial = social.value ?? {}

  const sameSocial = JSON.stringify(nextSocial) === JSON.stringify(socialBadges)
  if (nextBadge?.key === displayedBadge?.key && nextCount === referralCount && sameSocial) return
  displayedBadge = nextBadge
  referralCount = nextCount
  socialBadges = nextSocial
  broadcast()
}

function friendDestinationsSnapshot(): DestinationsByUser {
  return friendDestinationsStore.snapshot()
}

function refreshFriendDestinations(): void {
  if (authState.status !== 'signed_in') return
  friendDestinationsStore.refresh()
}

function scheduleDestinationsRefresh(): void {
  if (authState.status !== 'signed_in') return
  friendDestinationsStore.schedule()
}

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
const METADATA_DIAGNOSTICS = DIAGNOSTICS

const METADATA_KEY = 'kickback:channelMetadata'

const metadataBackend = createSupabaseMetadataBackend(supabase)

/*
 * The hub exists now, so failures can be reported rather than only logged.
 * Everything constructed above already calls logError; this is what makes
 * those calls do something.
 */
reportFailure = (context, error) => {
  analytics.track('client_error', {
    context: toFailureContext(context),
    code: toFailureCode(error),
  })
}

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
  create: (id, options) => ext.notifications.create(id, options),
  clear: (id) => ext.notifications.clear(id),
  onClicked: (handler) => ext.notifications.onClicked(handler),
  onButtonClicked: (handler) => ext.notifications.onButtonClicked(handler),
  openUrl: (url) => ext.tabs.create(url),
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
  iconUrl: ext.runtime.getURL('icons/icon-128.png'),
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

/**
 * Which browser this is, to about the precision a bug report needs.
 *
 * Brand and major version only. The full user-agent string is a fingerprinting
 * surface and answers nothing extra: "Chrome 141" is enough to know whether two
 * testers are on the same thing, and "Chrome 141.0.7390.55 on Windows NT 10.0;
 * Win64; x64" is enough to tell them apart from each other.
 */
function browserName(): string {
  const brands = (navigator as Navigator & {
    userAgentData?: { brands?: Array<{ brand: string; version: string }> }
  }).userAgentData?.brands

  // The first brand that is not one of Chromium's deliberate decoys.
  const real = brands?.find(
    (entry) => !/not.a.brand/i.test(entry.brand) && entry.brand !== 'Chromium',
  )
  if (real) return `${real.brand} ${real.version}`.slice(0, 64)

  const match = /(Edg|OPR|Brave|Chrome|Firefox|Safari)\/(\d+)/.exec(navigator.userAgent ?? '')
  return match ? `${match[1]} ${match[2]}` : 'unknown'
}

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
  /*
   * Derived from the SAME expansion the map is built from.
   *
   * This used to enumerate `presence.channel` alone - the legacy singular
   * primary - which was correct until a friend could be at three destinations
   * at once. Then exactly one of the three had metadata fetched for it, and
   * the other two rendered as bare lowercase logins with no live badge, no
   * category, no viewer count, no title and no avatar. The data was all there;
   * nobody had asked Twitch about it.
   *
   * Asking gravityChannels rather than re-deriving the set here is the fix and
   * also the point: enrichment and presentation now describe the same world by
   * construction, so a future change to what the map shows cannot silently
   * leave the enrichment behind.
   */
  const channels = gravityChannels(
    stampFriends(friendsState.friends, presenceIndex).map((friend) => ({
      member: friend,
      presence: friend.presence,
      userId: friend.user.id,
    })),
    friendDestinationsSnapshot(),
  )

  /*
   * EVERY destination the viewer has open, not just the focused one.
   *
   * This used to push currentChannel() alone, which was right when dwell only
   * measured the focused tab. Under per-stream dwell a background stream whose
   * metadata was never fetched reads as `unknown`, `unknown` is not live, and
   * the interval would never open - so the measurement would quietly collapse
   * back to focused-only without anything looking broken.
   *
   * The cost is at most two extra logins per refresh against a budget of 600
   * per five minutes, batched, and `want` is idempotent and TTL-guarded.
   */
  for (const open of tabActivity.destinations()) channels.push(open)

  metadata.want(channels)
}

/**
 * The destination the viewer is socially PRESENT at.
 *
 * WHAT THIS DELIBERATELY NO LONGER ASKS
 *
 * Whether the broadcaster is live. It used to, and that was too broad: it made
 * a stream ending end the conversation happening around it, which is precisely
 * backwards - the stream ends and everybody is still sitting there. It also
 * made every session hostage to a metadata refresh, so a viewer who had been
 * on a channel for a while could have a friend arrive, see them on the HERE
 * card, and get no session at all because the live record had gone stale.
 *
 * A session needs somewhere to be. Live status is a fact ABOUT that somewhere,
 * shown on the card and required by analytics - see liveWatchChannel().
 *
 * WHAT IT STILL ASKS
 *
 * That we are signed in, and that our own presence row already says we are
 * here. `stream_room_members` refuses unless the caller's presence puts them
 * on the channel, and asking before that is true returns an empty room that is
 * then cached - which is the bug that made a page load resolve to nothing.
 *
 * The question is asked of the PUBLISHED DESTINATION SET, because that is now
 * literally what the server holds for us and exactly what `is_present_at`
 * consults. Asking `lastReported()` instead - the single activity of the last
 * write - was right when presence was one channel, but under multi-destination
 * it says no for every stream except the most recently written one: switching
 * to a second open tab publishes nothing (correctly - focus is not a network
 * event), so that tab would never see its own room.
 */
function sessionChannel(): string | null {
  if (authState.status !== 'signed_in') return null
  return sessionChannelOf(currentChannel(), presenceReporter.lastDestinations())
}

/**
 * Every destination the viewer has open AND has successfully published.
 *
 * The multi-destination counterpart of sessionChannel, and it applies the same
 * rule for the same reason: a channel is only a room once the WRITE has landed.
 * `stream_room_members` refuses unless the caller's own presence puts them
 * there, so asking before that is true returns a correct, empty and
 * permanently cached answer - the bug that once made a page load resolve to
 * nothing.
 *
 * `lastDestinations()` is what the server acknowledged, not what the tabs
 * currently show, which is exactly the distinction that matters here.
 */
function sessionChannels(): string[] {
  if (authState.status !== 'signed_in') return []
  return openSessionChannels(tabActivity.destinations(), presenceReporter.lastDestinations())
}

/**
 * The destination the viewer is co-viewing a LIVE broadcast at.
 *
 * The narrower rule, and the only consumer is the shared-watch analytics
 * lifecycle. Nothing a person can see hangs off it: if metadata is stale or
 * missing, a duration is conservative, and nobody loses a conversation.
 *
 * Kept as a separate function rather than a parameter so that a future call
 * site has to choose a name, and the name says which question it is asking.
 */
function liveWatchChannel(): string | null {
  const here = sessionChannel()
  return canWatchLiveTogether(here, metadata.snapshot()) ? here : null
}

/**
 * Direct friends whose presence puts them here with the viewer, right now.
 *
 * THIS IS WHAT MAKES A SESSION AVAILABLE, AND WHY IT IS NOT THE RPC.
 *
 * Authenticated realtime presence already proves that a friend is on this
 * destination - it is the same evidence the HERE card draws "1 friend watching
 * with you" from. Waiting for `stream_room_members` to rediscover that costs a
 * round trip, and every one of the arrival failures happened inside it.
 *
 * The server remains authoritative for everything that MATTERS: who receives a
 * message, who receives a reaction, and which friends-of-friends are in the
 * component. The client never invents membership - it only declines to
 * pretend it does not already know about a direct friend it can see.
 */
function peersOn(here: string): string[] {
  return peersOnChannel({
    channel: here,
    presence: presenceIndex,
    friendIds: new Set(friendsState.friends.map((friend) => friend.user.id)),
    selfId: authState.identity?.userId ?? null,
  })
}

/**
 * Co-present friends on every open destination, keyed by channel.
 *
 * Per channel because a person watching two streams has two different sets of
 * people with them, and merging them would put somebody from one room into the
 * other's count.
 */
function sessionPeerMap(): Record<string, string[]> {
  const out: Record<string, string[]> = {}
  for (const channel of sessionChannels()) out[channel] = peersOn(channel)
  return out
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

  void ext.storage.set({ [CHANNEL_NAMES_KEY]: channelNames })
  broadcast()
}

async function loadChannelNames(): Promise<void> {
  try {
    const stored = await ext.storage.get(CHANNEL_NAMES_KEY)
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
   * A tab reporting activity is the definition of the Watchside session being
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
  /*
   * Every open destination, not one of them.
   *
   * This is the whole of the multi-room change in the worker: the three
   * contextual stores now follow a SET, so a viewer with two streams open
   * keeps two rosters, two conversations and two reaction streams, and looking
   * at one does not destroy the other.
   */
  const open = sessionChannels()
  together.setChannels(open)
  room.want(open)
  // The conversations follow the same set, and re-fetch on the same call: a
  // page refresh reaches here, and the messages have to come back with it
  // rather than starting empty.
  roomChat.setChannels(open)

  if (authState.status !== 'signed_in') return
  presenceReporter.setActivity(tabActivity.effective())
  /*
   * And the whole set, which is what other people actually see now.
   *
   * Separate from setActivity because they answer different questions:
   * `effective()` is the LOCAL primary, used for HERE and for attribution, and
   * never leaves this machine as a field. `destinations()` is what is
   * published. The reporter skips the write when the set is unchanged, so
   * switching between two already-open Twitch tabs produces no traffic at all.
   */
  presenceReporter.setDestinations(tabActivity.destinations())
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

/**
 * Every destination the viewer has open that Watchside can still vouch for.
 *
 * Open AND published: `sessionChannels()` is the intersection of the tabs that
 * exist with the destinations the server acknowledged, which is the strongest
 * evidence we already hold that a stream is genuinely there. Nothing is polled
 * for dwell's benefit.
 */
function observedStreams(): { streams: DwellStream[]; openChannels: string[] } {
  const openChannels = sessionChannels()
  const snapshot = metadata.snapshot()
  const focused = currentChannel()

  /*
   * Live-eligible only, using the SAME rule the shared watch uses, asked of
   * each destination in turn. `unknown` is not live, so a cold cache
   * under-counts rather than inventing viewing.
   *
   * `social` is filled in by the hub from the shared-watch lifecycle's own
   * state; a friend count here would let a background stream claim shared
   * viewing the shared watch never opened.
   */
  const streams = openChannels
    .filter((channel) => canWatchLiveTogether(channel, snapshot))
    .map((channel) => ({ channel, focused: channel === focused, social: false }))

  return { streams, openChannels }
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
  /*
   * The LIVE rule, and the only place it is asked.
   *
   * A session on an offline channel is real and keeps working; it simply does
   * not accrue shared WATCH time, because there is nothing being watched. A
   * null channel here is exactly what leaving looks like, so an open interval
   * closes through the path that already existed.
   */
  const channel = liveWatchChannel()
  const observed = observedStreams()
  analytics.noteTogether({
    channel,
    otherCount: coWatcherCount(channel),
    /*
     * Dwell rides the same call as the shared watch so both are computed from
     * one metadata snapshot in one tick. Two calls would be two chances for a
     * shared watch and the dwell interval containing it to disagree.
     */
    streams: observed.streams,
    openChannels: observed.openChannels,
  })
}

// ------------------------------------------------------------------- state

let authState = auth.getState()
let friendsState = friends.getState()
let groupsState = groups.getState()

const ports = new Set<ExtensionPort>()

/**
 * A stable name per port, so diagnostics can say "tab2" rather than printing
 * an object. A WeakMap, so a closed tab is not kept alive by being named.
 */
const portLabels = new WeakMap<object, string>()
let nextPortLabel = 1

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
    // Which of those are still on their way. See KickbackState.
    channelMetadataPending: metadata.inFlightChannels(),
    togetherReactions: together.snapshot(),
    roomMembers: room.rosters(),
    roomPeers: sessionPeerMap(),
    roomMessages: roomChat.snapshot(),
    roomUnread: roomUnreadMap(),
    sessionChannel: restoredSession(),
    mutedUserIds: sessionTab.muted(),
    blockedUsers: friendsState.blocked,
    friendDestinations: { ...friendDestinationsSnapshot() },
    displayedBadge,
    referralCount,
    socialBadges: { ...socialBadges },
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
        /*
         * Resolved here, RECORDED only if it is a real randomisation.
         *
         * The gate is in the hub rather than at this call site, so passing an
         * arm from a beta build cannot leak one into the data - see
         * noteSignedIn. This side simply answers "which arm is this user in",
         * which is the same question the panel asks to decide what to render.
         */
        experimentArm: resolveArm({
          userId: next.identity.userId,
          environment: ANALYTICS_ENVIRONMENT,
        }),
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
    roomChat.setUser(next.identity.userId)
    /*
     * Whatever an invite link left here before there was an account.
     *
     * The recipient clicks a link, installs, and only THEN signs in, so the
     * code always arrives before the actor does. This is the moment it can be
     * attributed - and it is idempotent server-side, so a repeated auth update
     * costs one no-op call.
     */
    claimInviteAfterSignIn()
    void refreshBadges()
  } else {
    socialSync.stop()
    presenceSync.stop()
    presenceReporter.stop()
    friends.clear()
    groups.clear()
    groupSync.stop()
    attention.clear()
    gatheringWatcher.reset()
    displayedBadge = null
    referralCount = 0
    socialBadges = {}
    inviteLinkAnnounced = false
    together.reset()
    roomChat.reset()
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
  setPresenceIndex(
    mergePresence(
      presenceIndex,
      Object.values(next.members).flatMap((roster) => roster.map((member) => member.presence)),
    ),
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
  setPresenceIndex(
    mergePresence(
      presenceIndex,
      next.friends.map((friend) => friend.presence),
    ),
  )
  if (authState.status === 'signed_in') {
    // Somebody was added, removed or blocked: who we may see destinations for
    // has changed, so the map is re-read rather than aged.
    scheduleDestinationsRefresh()
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
  setPresenceIndex(
    forgetPresence(
      presenceIndex,
      Object.keys(presenceIndex).filter(
        (userId) => userId !== authState.identity?.userId && !watched.includes(userId),
      ),
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
  blockUser: async ([userId]) => {
    await friends.block(String(userId))
    /*
     * That it happened, and nothing about who.
     *
     * A user id, a login or a display name would each turn analytics into a
     * record of who dislikes whom - far more sensitive than anything else
     * Watchside keeps, and it answers no question we have. Whether people need
     * this feature at all is answered by a bare count.
     */
    analytics.track('user_blocked')
  },
  unblockUser: async ([userId]) => {
    await friends.unblock(String(userId))
    analytics.track('user_unblocked')
  },

  /*
   * Feedback: the client sends what somebody typed, the worker says where they
   * were.
   *
   * Split that way on purpose. The panel knows which tab was open and whether
   * it was collapsed, and nothing else here; version, environment, browser,
   * friend count, whether a session existed and whether realtime was healthy
   * are all facts the WORKER holds. Letting the panel assemble them would mean
   * a modified extension could report a healthy connection while sitting on a
   * broken one, which is the opposite of what a diagnostic is for.
   *
   * The server whitelists the result again anyway - see 0023.
   */
  submitFeedback: async ([raw]) => {
    const input = (raw ?? {}) as {
      category?: unknown
      body?: unknown
      surface?: unknown
      collapsed?: unknown
    }
    const category = String(input.category ?? 'other')
    const body = String(input.body ?? '')
    const channel = currentChannel()

    await friends.sendFeedback({
      category,
      body,
      context: {
        app_version: __KICKBACK_VERSION__,
        environment: ANALYTICS_ENVIRONMENT,
        /*
         * The browser string is omitted on Firefox, and this is the only place
         * outside analytics where that decision reaches.
         *
         * `browserName()` reads the user agent, which is "device and browser
         * info" - the first thing Mozilla lists under technicalAndInteraction,
         * the category Watchside does not collect on Firefox. It arrives here
         * attached to a support message somebody chose to send, which is a
         * softer case than telemetry, but the promise was categorical and this
         * is what keeping it looks like.
         *
         * The field is dropped rather than faked: `submit_feedback` runs its
         * context through `jsonb_strip_nulls`, so an absent key is simply
         * absent. Everything else the owner needs to answer a report - version,
         * environment, channel, friend count, sync health - is unchanged, so
         * feedback from Firefox is still answerable.
         */
        ...(IS_GECKO ? {} : { browser: browserName() }),
        surface: String(input.surface ?? 'friends'),
        collapsed: input.collapsed === true,
        /*
         * The channel, because "my friend did not appear" is unanswerable
         * without knowing where. One login, at one moment, attached to
         * something the user chose to send - not a browsing history.
         */
        channel,
        on_channel: channel !== null,
        friend_count: friendsState.friends.length,
        session_available: room.channels().length > 0,
        social_sync: socialSync.getStatus(),
        presence_sync: presenceSync.getStatus(),
      },
    })

    // The category, and nothing else. What they wrote is in public.feedback.
    analytics.track('feedback_submitted', {
      category: category as 'bug' | 'confusing' | 'idea' | 'other',
    })
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
  /*
   * Irreversible, and it takes no arguments on purpose.
   *
   * There is no user id to pass, here or anywhere further down. The server
   * reads the actor from the JWT, so a tab cannot ask for anybody else's
   * account to be deleted even if it wanted to.
   */
  deleteAccount: () => auth.deleteAccount(),
  /*
   * Optional, and deliberately user-initiated.
   *
   * Nothing schedules this. It runs when somebody chooses it in the account
   * panel, which is the only place it is offered.
   */
  grantFollowPermission: () => auth.grantFollowPermission(),
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
    try {
      await groups.sendMessage(String(groupId), resolved)
    } catch (error) {
      /*
       * Recorded, then rethrown unchanged.
       *
       * The composer still shows the user the real message; this only adds the
       * SHAPE of the refusal to analytics, which is what separates "she sent
       * and never saw it" from "she never sent at all" - the question the first
       * external bug report could not answer. The body is not here.
       */
      analytics.track('group_message_send_failed', { code: toFailureCode(error) }, {
        source: 'group',
      })
      throw error
    }
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

  // ------------------------------------------------------------ growth loop

  suggestFriends: async () => {
    const result = await suggestFriends(supabase)
    if (result.error) {
      logError('friends.suggest', result.error)
      return []
    }
    /*
     * No impression is recorded here, deliberately.
     *
     * This is the FETCH. An impression recorded at the fetch means "we asked
     * the server", which is a different fact from "somebody could see it" - and
     * the two came apart badly: the suggestion list renders nothing at all when
     * it is empty, so every empty fetch was being counted as an impression of a
     * surface that did not exist. The funnel's first step was measuring the
     * wrong thing, in the direction that flatters it.
     *
     * The component emits it when it actually draws something. See
     * FriendSuggestions in GrowFriends.tsx.
     */
    return result.value ?? []
  },

  inviteCode: async () => {
    const result = await myInviteCode(supabase)
    if (result.error || !result.value) {
      logError('invite.code', result.error ?? 'no code')
      throw new Error('Could not create an invite link. Try again.')
    }
    if (!inviteLinkAnnounced) {
      inviteLinkAnnounced = true
      analytics.track('invite_link_created', {})
    }
    return result.value
  },

  claimInvite: async ([code]) => {
    const outcome = await claimPendingInvite(String(code ?? ''))
    return outcome
  },

  referralSummary: async () => {
    const result = await myReferralSummary(supabase)
    if (result.error) logError('invite.summary', result.error)
    return result.value ?? { successful: 0, pending: 0 }
  },

  badges: async () => {
    const result = await myBadges(supabase)
    if (result.error) logError('badges.list', result.error)
    return result.value ?? []
  },

  badgeCatalog: async () => {
    const result = await badgeCatalog(supabase)
    if (result.error) logError('badges.catalog', result.error)
    return result.value ?? []
  },

  setDisplayedBadge: async ([key]) => {
    const next = key === null || key === undefined ? null : String(key)
    const result = await setDisplayedBadge(supabase, next)
    if (result.error) {
      logError('badges.display', result.error)
      throw new Error('Could not update your badge.')
    }
    if (next) analytics.track('badge_displayed', { badge_key: next })
    await refreshBadges()
    return result.value
  },
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

async function handleRpc(port: ExtensionPort, message: ClientMessage): Promise<void> {
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
      error: 'Your Watchside session ended. Sign in again.',
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

ext.runtime.onConnect((port) => {
  if (port.name !== PORT_NAME) return

  ports.add(port)
  portLabels.set(port, `tab${nextPortLabel++}`)
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
      case 'invite': {
        /*
         * A code seen in a Twitch URL, from the landing page's continue link.
         *
         * One-way and unauthenticated by design: it may arrive long before
         * sign-in, and holding it is the only sensible thing to do with it.
         * Possession grants nothing - see src/core/invites.ts.
         */
        if (typeof raw.code === 'string') void claimPendingInvite(raw.code)
        break
      }
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
        /*
         * The tab names its room.
         *
         * A tab knows which stream it is showing; with several open the worker
         * has no single "current" channel that is right for a particular one.
         * An older client that sends no channel falls back to the primary,
         * which is what it always meant.
         */
        if (isReaction(raw.reaction)) {
          together.send(
            typeof raw.channel === 'string' ? raw.channel : sessionChannel(),
            raw.reaction,
          )
        }
        break

      case 'roomMessage': {
        /*
         * Trimmed and bounded here as well as in SQL.
         *
         * The database is the authority and checks the same 280, but a tab is
         * not a trusted caller and there is no reason to spend a round trip
         * discovering that. Recorded when the sender's own copy is DELIVERED,
         * not here - see the onMessage handler.
         */
        const typed = typeof raw.body === 'string' ? raw.body.trim() : ''
        /*
         * Bare emote names become stable provider+id tokens here, once - the
         * same call group chat makes, and the one the room was missing.
         *
         * The picker inserts an external emote as its bare NAME so the
         * composer reads the way Twitch chat does, and something has to turn
         * that into a token before it is stored. Without this the room kept
         * the word: it rendered as plain text, soleEmote() did not recognise
         * it, and it therefore contributed nothing to a combo - which is also
         * why the activity preview outside never lit up.
         */
        const body = emoteCatalog.resolveOutgoing(typed)
        if (body.length > 0 && body.length <= MAX_MESSAGE_LENGTH) {
          roomChat.send(typeof raw.channel === 'string' ? raw.channel : sessionChannel(), body)
        }
        break
      }

      case 'selectSession': {
        /*
         * The viewer's intent, remembered so a Twitch refresh lands back
         * where they were.
         *
         * Only ever the channel they are actually on: a client naming another
         * one would be storing a selection it could never have made, and the
         * restore path checks eligibility again anyway.
         */
        const here = sessionChannel()
        const wanted = typeof raw.channel === 'string' ? raw.channel.toLowerCase() : null
        if (wanted && wanted === here) {
          sessionTab.select(here)
          // Looking at the conversation is what makes it read.
          sessionTab.markRead(here)
        } else {
          sessionTab.select(null)
        }
        broadcast()
        break
      }

      case 'mute': {
        // Local, silent, and never sent anywhere. See core/mute.ts.
        if (typeof raw.userId === 'string' && raw.userId.length > 0) {
          sessionTab.setMuted(raw.userId, raw.muted === true)
        }
        break
      }
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

ext.alarms.create(REFRESH_ALARM, { periodInMinutes: REFRESH_PERIOD_MINUTES })

ext.alarms.onAlarm((name) => {
  if (name !== REFRESH_ALARM) return
  void auth.ensureFreshSession()
  // Safety net, not a polling strategy: if the socket died quietly, this puts
  // the friends list right within the half hour rather than never.
  if (authState.status === 'signed_in') {
    void friends.refresh()
    // Destinations age out on their own thirty-minute clock, so a client that
    // missed a realtime event would otherwise show a stale set until the next
    // social change. This is the same safety net, for the same reason.
    refreshFriendDestinations()
  }
})

/*
 * Rebuild the local caches this worker needs before it can answer anything.
 *
 * MODULE SCOPE, DELIBERATELY. Every one of these has to run on every fresh
 * evaluation of the background context, because that is what a revival IS: the
 * worker is torn down, the module is re-run, and whatever was in memory is
 * gone. Chromium evicts an MV3 worker; Firefox suspends the event page once no
 * Twitch port holds it open - measured at roughly a minute of idle in F4. Both
 * come back by re-evaluating this file.
 *
 * These used to sit inside `runtime.onStartup` by accident (WS-F4-01). That
 * event fires only when the browser itself starts, so a revived worker began
 * with a cold mute list, cold read watermarks and cold caches, and stayed that
 * way for its whole lifetime.
 *
 * Hydration is asynchronous and nothing waits for it. That race is not new -
 * it existed inside the callback too - and it is strictly smaller here: a
 * cold read is now corrected within one storage round-trip instead of never.
 * Each service re-broadcasts when it lands, so the panel converges rather than
 * staying wrong.
 */
void preferences.hydrate()
void attention.hydrate()
// A worker that has just woken should not start from a cold metadata cache;
// a day-old record is dropped on the way in rather than shown.
void metadata.hydrate()
// The remembered session tab, the read watermarks and the mute list. All
// local, all small, and all of them are what makes a Twitch refresh land
// back where the viewer was rather than on Friends.
void sessionTab.hydrate()

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

  /*
   * Why does Supabase show one destination when I have three streams open?
   *
   *     kickbackDestinations.now()
   *
   * The whole publisher, from ports to payload, in one object - written after
   * a browser investigation where every automated test passed and the hosted
   * table still held a single row. The gap was that nothing could show which
   * TABS the worker knew about, and a tab the worker has forgotten looks
   * exactly like a tab on no channel from anywhere else.
   *
   * `ports` is what the worker believes is open. `aggregated` is what it would
   * publish. `published` is what the server acknowledged. `writes` is what
   * actually went out, in order, with timestamps. If ports is short, the tabs
   * never reported; if aggregated is short, the registry dropped them; if the
   * payload is short, the reporter did; and if all three are three and the
   * table says one, the server did.
   *
   * Channel names are here. Development and beta only, on the same build-time
   * constant the metadata probe uses, and nothing here goes to analytics.
   */
  /*
   * Why the room on screen says what it says.
   *
   *     kickbackRoom.now()
   *
   * A roster on its own cannot distinguish "the server said nobody is here"
   * from "nobody has asked the server since before they arrived", and those
   * are opposite bugs. This puts the two answers side by side - the peers the
   * client can see from presence, and the members the server returned - along
   * with how old that answer is and how many times it has been invalidated.
   * WS-F5-01 was diagnosed with exactly this pair.
   */
  ;(globalThis as unknown as Record<string, unknown>).kickbackRoom = {
    now() {
      return {
        here: sessionChannel(),
        open: sessionChannels(),
        peers: sessionPeerMap(),
        coPresence,
        rooms: room.inspect(),
      }
    },
    /*
     * Ask the server the room question directly, bypassing the cache.
     *
     *     await kickbackRoom.check('lirik')
     *
     * The same reasoning as kickbackMetadata.check: the alternative is
     * inferring backend health from whether a roster looks right. It answers
     * whether the SERVER thinks anybody is there, which is the only way to
     * tell a stale cache from a genuinely empty room.
     */
    async check(channel: string) {
      try {
        return { members: await createSupabaseRoomBackend(supabase).members(channel) }
      } catch (error) {
        return { error: error instanceof Error ? error.message : String(error) }
      }
    },
  }

  ;(globalThis as unknown as Record<string, unknown>).kickbackDestinations = {
    now() {
      const tabs = tabActivity.snapshot()
      return {
        // Every content-script port the worker currently holds, and what it
        // last said it was showing.
        ports: tabs.map((tab) => ({
          port: portLabels.get(tab.key) ?? 'unknown',
          channel: tab.channel,
          visible: tab.visible,
          reportedAt: new Date(tab.updatedAt).toISOString(),
          onChannelSince: new Date(tab.channelAt).toISOString(),
        })),
        portCount: ports.size,
        // Ports the worker has, but which have never reported an activity.
        // A non-zero count here IS the bug this surface was written for.
        portsWithoutActivity: ports.size - tabs.length,
        aggregated: tabActivity.destinations(),
        published: [...presenceReporter.lastDestinations()],
        localPrimary: currentChannel(),
        signedIn: authState.status === 'signed_in',
        writes: [...presenceWrites],
      }
    },
    /** Just the writes, for watching a reconnect happen live. */
    writes: () => [...presenceWrites],
  }

  /*
   * The OBSERVER'S half: what this account can see of its friends' streams.
   *
   *     kickbackGravity.now()
   *
   * kickbackDestinations answers "am I publishing my streams". This answers
   * "am I receiving, and rendering, everyone else's" - and the two failed
   * independently, which is why they are separate commands.
   *
   * It runs the REAL selector on the REAL state, through the same
   * expandDestinations the panel uses, so it cannot report a map the UI does
   * not draw. That is not a nicety: the defect this was written for was a
   * correct expansion computed beside a rendered component that ignored it.
   *
   * Friend user ids and channel names appear here. Development and beta only,
   * on the same build-time constant as the metadata probe, and nothing here
   * reaches analytics or failure telemetry.
   */
  ;(globalThis as unknown as Record<string, unknown>).kickbackGravity = {
    now() {
      const friends = stampFriends(friendsState.friends, presenceIndex)
      const selfId = authState.identity?.userId ?? null

      const records = metadata.snapshot()
      const destinations = friendDestinationsSnapshot()
      // The same canonical call the panel makes, so this cannot report a map
      // the UI does not draw.
      const sections = gravityModel({
        friends: friends.map((friend) => ({
          member: friend,
          presence: friend.presence,
          userId: friend.user.id,
        })),
        destinations,
        localActivity: tabActivity.effective(),
        selfId,
        metadata: records,
        now: Date.now(),
      })

      /** Which friends the map put on each channel, from the model itself. */
      const byChannel: Record<string, string[]> = {}
      for (const section of sections) {
        if (!section.channel) continue
        byChannel[section.channel] = section.friends.map(
          (friend) => friend.user.username || friend.user.id,
        )
      }

      return {
        signedIn: authState.status === 'signed_in',
        // What list_friend_destinations last returned, per friend.
        received: Object.fromEntries(
          Object.keys(destinations).map((userId) => [
            friends.find((friend) => friend.user.id === userId)?.user.username || userId,
            [...destinations[userId]],
          ]),
        ),
        friendsWithDestinations: Object.keys(destinations).length,
        // One entry per friend per destination - the thing Gravity clusters.
        gravityInput: byChannel,
        gravityInputCount: sections.reduce((total, section) => total + section.count, 0),
        /*
         * Which channels Twitch has actually told us about.
         *
         * The second regression was entirely here: the map was right and the
         * cards were bare, because enrichment had been asked for one channel
         * out of three. `enriched: false` on a rendered destination is that
         * bug, and it is now visible in one line rather than by comparing a
         * screenshot to a database.
         */
        enrichment: Object.fromEntries(
          gravityChannels(
            friends.map((friend) => ({
              member: friend,
              presence: friend.presence,
              userId: friend.user.id,
            })),
            destinations,
          ).map((channel) => {
            const record = records[channel]
            return [
              channel,
              {
                /*
                 * The lifecycle, per channel, in one word.
                 *
                 *   cached    - we have it and it is fresh enough to show
                 *   stale     - we have it, and the next want() will refetch
                 *   requested - a fetch is open right now
                 *   missing   - nothing, and nothing asked. THIS IS THE BUG
                 *               STATE: a destination on the map that nobody
                 *               has asked Twitch about.
                 */
                state: record
                  ? needsRefresh(record, Date.now())
                    ? 'stale'
                    : 'cached'
                  : metadata.inFlight(channel)
                    ? 'requested'
                    : 'missing',
                enriched: Boolean(record),
                lastUpdated: record ? new Date(record.fetchedAt).toISOString() : null,
                displayName: record?.displayName ?? null,
                live: record?.live ?? 'unknown',
                game: record?.gameName ?? null,
                viewers: record?.viewerCount ?? null,
              },
            ]
          }),
        ),
        /*
         * The lifecycle counters, so "is anything even happening" is one
         * number rather than an inference from four fields.
         */
        metadataPending: metadata.pending(),
        destinationsPending: friendDestinationsStore.pending(),
        // And what came out, with why each one renders as it does.
        gravityOutput: sections.map((section) => ({
          channel: section.channel,
          kind: section.kind,
          count: section.count,
          rank: section.rank,
          rendered: section.kind === 'here' || section.kind === 'destination',
          gathering: isGravity(section),
          enriched: section.channel ? Boolean(records[section.channel]) : null,
          why:
            section.kind === 'here'
              ? 'rendered as HERE - the viewer is on this channel'
              : section.kind === 'destination'
                ? section.count >= GRAVITY_THRESHOLD
                  ? `rendered as a destination card, and marked a gathering (${section.count} friends)`
                  : 'rendered as a destination card, without the gathering flame (1 friend)'
                : `not a destination - ${section.kind}`,
        })),
      }
    },
  }

  /*
   * Why do I have "1 friend watching with you" and no session tab?
   *
   *     kickbackSession.why()
   *
   * Arrival survived two rounds of fixes that unit tests said were correct, so
   * the point of this is to make the next disagreement between what the panel
   * SAYS and what it OFFERS answerable in one line rather than by another
   * round of reasoning about code.
   *
   * Every field is either a count, an id we already hold locally, or a piece
   * of our own machine state. No tokens, no message bodies, no metadata beyond
   * the live word the card is already showing. Development and beta only, on
   * the same build-time constant the metadata probe uses.
   */
  ;(globalThis as unknown as Record<string, unknown>).kickbackSession = {
    why() {
      const here = sessionChannel()
      const peers = here ? peersOn(here) : []
      const members = room.snapshot(here)
      return {
        // Where we think we are, and whether our own row says so yet.
        destination: currentChannel(),
        sessionChannel: here,
        presenceReported:
          presenceReporter.lastReported()?.type === 'watching'
            ? (presenceReporter.lastReported() as { channel: string }).channel
            : null,
        // The two kinds of evidence, and what they add up to.
        peerIds: peers,
        memberIds: members.map((member) => member.userId),
        sessionAvailable: Boolean(here) && (peers.length > 0 || members.length > 0),
        // The membership request's own state, which is where arrival used to
        // get stuck: an answer computed before somebody arrived, cached.
        roomChannels: room.channels(),
        openDestinations: sessionChannels(),
        roomPending: room.pending(),
        // Live status is now ONLY a label and an analytics gate. If this says
        // offline and the session is missing, the two are unrelated.
        liveWatchChannel: liveWatchChannel(),
        live: watchTogetherState(here, metadata.snapshot()),
        messages: roomChat.snapshot().length,
        unread: roomUnreadMap(),
      }
    },
  }
}
void groups.hydrate()

/*
 * Browser startup, and nothing else.
 *
 * This is what the callback held when it was written, before later additions
 * were inserted above the closing brace and were swallowed by it. Restoring
 * the boundary puts the hydration above back at module scope, where its
 * indentation always said it belonged.
 *
 * `auth.initialize()` is also called at module scope below, so this handler is
 * belt-and-braces rather than load-bearing. It is left alone: it is idempotent,
 * it is what shipped, and removing it is a behaviour change this fix has no
 * business making.
 */
ext.runtime.onStartup(() => {
  void auth.initialize()
})

ext.runtime.onInstalled(() => {
  void auth.initialize()
})

// The worker is also revived by a tab connecting or an alarm firing, and each
// revival re-runs this module - so initialising here covers every wake-up.
void auth.initialize()
