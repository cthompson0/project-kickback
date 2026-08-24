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
import { createNotifier } from './notifier'
import { findGatherings } from '../core/presence'
import type { Activity } from '../core/types'
import {
  createSupabaseGroupChannel,
  createSupabasePresenceChannel,
  createSupabaseSocialChannel,
} from './supabaseRealtime'
import {
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

function indexPresence(next: PresenceIndex): void {
  if (next === presenceIndex) return
  presenceIndex = next
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
const attention = createAttentionService({ storage: storageArea, onError: logError })

const notifier = createNotifier({
  create: (id, options) => chrome.notifications.create(id, options),
  clear: (id) => chrome.notifications.clear(id),
  onClicked: (handler) => chrome.notifications.onClicked.addListener(handler),
  onButtonClicked: (handler) => chrome.notifications.onButtonClicked.addListener(handler),
  openUrl: (url) => void chrome.tabs.create({ url }),
  iconUrl: chrome.runtime.getURL('icons/icon-128.png'),
})

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
function refreshAttention(): void {
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
  if (authState.status !== 'signed_in') return
  presenceReporter.setActivity(tabActivity.effective())
  // Moving channels changes what counts as "somewhere else".
  refreshAttention()
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
    }
    // start() is idempotent for the same user and swaps cleanly for a new one.
    socialSync.start(next.identity.userId)
  } else {
    socialSync.stop()
    presenceSync.stop()
    presenceReporter.stop()
    friends.clear()
    groups.clear()
    groupSync.stop()
    attention.clear()
    gatheringWatcher.reset()
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
  }
  broadcast()
})

friends.subscribe((next) => {
  friendsState = next
  presenceIndex = mergePresence(
    presenceIndex,
    next.friends.map((friend) => friend.presence),
  )
  if (authState.status === 'signed_in') refreshAttention()
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
  searchUsers: ([query]) => friends.search(String(query ?? '')),
  sendFriendRequest: ([userId]) => friends.sendRequest(String(userId)),
  respondToFriendRequest: ([requestId, accept]) =>
    friends.respond(String(requestId), accept === true),
  acceptFriendRequestFrom: ([userId]) => friends.acceptFrom(String(userId)),
  cancelFriendRequest: ([requestId]) => friends.cancel(String(requestId)),
  removeFriend: ([userId]) => friends.remove(String(userId)),
  refreshFriends: () => friends.refresh(),
  createGroup: ([name, icon]) =>
    groups.createGroup(String(name), typeof icon === 'string' ? icon : null),
  setGroupIcon: ([groupId, icon]) =>
    groups.setGroupIcon(String(groupId), typeof icon === 'string' ? icon : null),
  renameGroup: ([groupId, name]) => groups.renameGroup(String(groupId), String(name)),
  deleteGroup: ([groupId]) => groups.deleteGroup(String(groupId)),
  inviteToGroup: ([groupId, userId]) => groups.invite(String(groupId), String(userId)),
  cancelGroupInvite: ([groupId, userId]) =>
    groups.cancelInvite(String(groupId), String(userId)),
  respondToGroupInvite: ([inviteId, accept]) =>
    groups.respondToInvite(String(inviteId), accept === true),
  leaveGroup: ([groupId]) => groups.leaveGroup(String(groupId)),
  removeGroupMember: ([groupId, userId]) =>
    groups.removeMember(String(groupId), String(userId)),
  sendGroupMessage: ([groupId, body]) =>
    // Bare emote names become stable provider+id tokens here, once, so the
    // message records exactly which emote was meant.
    groups.sendMessage(String(groupId), emoteCatalog.resolveOutgoing(String(body))),
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
void groups.hydrate()
void auth.initialize()
})

chrome.runtime.onInstalled.addListener(() => {
  void auth.initialize()
})

// The worker is also revived by a tab connecting or an alarm firing, and each
// revival re-runs this module - so initialising here covers every wake-up.
void auth.initialize()
