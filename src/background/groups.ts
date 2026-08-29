import type { BackendResult } from './auth'
import type { AsyncStorageArea } from './storage'
import type {
  ChatMessage,
  GroupInvite,
  GroupMember,
  GroupSummary,
} from '../client/types'

/**
 * Groups, their members, and their chat.
 *
 * Two decisions shape everything here:
 *
 *   - Unread is DERIVED, never counted. Each group remembers the timestamp of
 *     the last message the user saw; unread is however many messages are newer
 *     than that and not their own. A reconnect that replays messages therefore
 *     cannot inflate a badge, because replaying the same messages produces the
 *     same answer.
 *   - Realtime messages are applied directly to the buffer rather than
 *     triggering a re-read. Chat is the highest-frequency thing in Watchside;
 *     re-reading a group's history on every message would be pathological.
 */

export interface GroupsBackend {
  listGroups(): Promise<BackendResult<GroupSummary[]>>
  listInvites(): Promise<BackendResult<GroupInvite[]>>
  listMembers(groupId: string): Promise<BackendResult<GroupMember[]>>
  /** User ids with an outstanding invitation. Owner-only; others get []. */
  listSentInvites(groupId: string): Promise<BackendResult<string[]>>
  listMessages(groupId: string, limit: number): Promise<BackendResult<ChatMessage[]>>
  createGroup(name: string, icon: string | null): Promise<BackendResult<string>>
  setGroupIcon(groupId: string, icon: string | null): Promise<BackendResult<string>>
  renameGroup(groupId: string, name: string): Promise<BackendResult<string>>
  deleteGroup(groupId: string): Promise<BackendResult<boolean>>
  inviteToGroup(groupId: string, userId: string): Promise<BackendResult<string>>
  cancelGroupInvite(groupId: string, userId: string): Promise<BackendResult<string>>
  respondToInvite(inviteId: string, accept: boolean): Promise<BackendResult<string>>
  leaveGroup(groupId: string): Promise<BackendResult<boolean>>
  removeMember(groupId: string, userId: string): Promise<BackendResult<boolean>>
  sendMessage(groupId: string, body: string): Promise<BackendResult<string>>
}

export interface GroupsState {
  groups: GroupSummary[]
  invites: GroupInvite[]
  members: Record<string, GroupMember[]>
  /** groupId -> user ids we have invited and who have not answered. */
  sentInvites: Record<string, string[]>
  messages: Record<string, ChatMessage[]>
  /** Per group, messages newer than the last one seen, excluding our own. */
  groupUnread: Record<string, number>
  mutedGroupIds: string[]
  groupsLoading: boolean
  groupsError: string | null
}

export const EMPTY_GROUPS_STATE: GroupsState = {
  groups: [],
  invites: [],
  members: {},
  sentInvites: {},
  messages: {},
  groupUnread: {},
  mutedGroupIds: [],
  groupsLoading: false,
  groupsError: null,
}

const SEEN_KEY = 'kickback:groups:seen'
const MUTED_KEY = 'kickback:groups:muted'
/** Enough to read the room; not an archive. */
export const MESSAGE_WINDOW = 60

export interface GroupsDeps {
  backend: GroupsBackend
  storage?: AsyncStorageArea
  /** Who we are, so our own messages never count as unread. */
  selfId: () => string | null
  onError?: (context: string, error: unknown) => void
}

export interface GroupsService {
  getState(): GroupsState
  subscribe(listener: (state: GroupsState) => void): () => void
  hydrate(): Promise<void>
  refresh(): Promise<void>
  clear(): void
  /** Apply one realtime message without re-reading anything. */
  applyMessage(message: ChatMessage): void
  /** Mark a group read up to its newest message. */
  markGroupRead(groupId: string): void
  setMuted(groupId: string, muted: boolean): Promise<void>

  createGroup(name: string, icon?: string | null): Promise<string>
  setGroupIcon(groupId: string, icon: string | null): Promise<void>
  renameGroup(groupId: string, name: string): Promise<void>
  deleteGroup(groupId: string): Promise<void>
  invite(groupId: string, userId: string): Promise<string>
  cancelInvite(groupId: string, userId: string): Promise<void>
  respondToInvite(inviteId: string, accept: boolean): Promise<string>
  leaveGroup(groupId: string): Promise<void>
  removeMember(groupId: string, userId: string): Promise<void>
  sendMessage(groupId: string, body: string): Promise<void>
}

function friendlyError(context: string): string {
  switch (context) {
    case 'createGroup':
      return 'Could not create that group.'
    case 'sendMessage':
      return 'Message not sent.'
    case 'invite':
      return 'Could not send that invitation.'
    case 'respond':
      return 'Could not answer that invitation.'
    default:
      return "Watchside can't reach its server right now."
  }
}

export function createGroupsService(deps: GroupsDeps): GroupsService {
  const listeners = new Set<(state: GroupsState) => void>()
  let state: GroupsState = { ...EMPTY_GROUPS_STATE }
  /** groupId -> ISO timestamp of the newest message the user has seen. */
  let seen: Record<string, string> = {}

  const emit = () => {
    for (const listener of listeners) listener(state)
  }

  const setState = (patch: Partial<GroupsState>) => {
    state = { ...state, ...patch }
    emit()
  }

  /** Unread is recomputed from the buffer; it is never incremented. */
  function recomputeUnread(): void {
    const selfId = deps.selfId()
    const unread: Record<string, number> = {}

    for (const [groupId, messages] of Object.entries(state.messages)) {
      const since = seen[groupId]
      unread[groupId] = messages.filter(
        (message) =>
          message.userId !== selfId && (!since || message.createdAt > since),
      ).length
    }

    state = { ...state, groupUnread: unread }
  }

  function persistSeen(): void {
    void deps.storage?.set({ [SEEN_KEY]: seen }).catch((error: unknown) => {
      deps.onError?.('groups.persistSeen', error)
    })
  }

  async function mutate<T>(context: string, run: () => Promise<BackendResult<T>>): Promise<T> {
    const result = await run()
    if (result.error || result.value === null) {
      deps.onError?.(context, result.error)
      setState({ groupsError: result.error ?? friendlyError(context) })
      // Surface the database's own message when it is a validation complaint;
      // those are written for people ("message is too long").
      throw new Error(
        result.error?.startsWith('kickback: ')
          ? result.error.slice('kickback: '.length)
          : friendlyError(context),
      )
    }
    setState({ groupsError: null })
    return result.value
  }

  async function refresh(): Promise<void> {
    setState({ groupsLoading: true })

    const [groups, invites] = await Promise.all([
      deps.backend.listGroups(),
      deps.backend.listInvites(),
    ])

    if (groups.error || invites.error) {
      deps.onError?.('groups.refresh', groups.error ?? invites.error)
      setState({ groupsLoading: false, groupsError: friendlyError('refresh') })
      return
    }

    const list = groups.value ?? []
    const members: Record<string, GroupMember[]> = {}
    const sentInvites: Record<string, string[]> = {}
    const messages: Record<string, ChatMessage[]> = { ...state.messages }

    // Beta scale: a handful of groups, so loading each is fine. If groups ever
    // grow past that, this becomes one batched call rather than a loop.
    for (const group of list) {
      const [memberResult, messageResult, inviteResult] = await Promise.all([
        deps.backend.listMembers(group.groupId),
        deps.backend.listMessages(group.groupId, MESSAGE_WINDOW),
        // Only owners can invite, so only owners have anything to read here.
        group.isOwner
          ? deps.backend.listSentInvites(group.groupId)
          : Promise.resolve({ value: [] as string[], error: null }),
      ])
      if (memberResult.value) members[group.groupId] = memberResult.value
      if (messageResult.value) messages[group.groupId] = messageResult.value
      sentInvites[group.groupId] = inviteResult.value ?? []
    }

    // Drop anything for groups we are no longer in - leaving must not leave
    // a stale copy of a conversation behind.
    const liveIds = new Set(list.map((group) => group.groupId))
    for (const groupId of Object.keys(messages)) {
      if (!liveIds.has(groupId)) delete messages[groupId]
    }

    state = {
      ...state,
      groups: list,
      invites: invites.value ?? [],
      members,
      sentInvites,
      messages,
      groupsLoading: false,
      groupsError: null,
    }
    recomputeUnread()
    emit()
  }

  return {
    getState: () => state,

    subscribe(listener) {
      listeners.add(listener)
      listener(state)
      return () => {
        listeners.delete(listener)
      }
    },

    async hydrate() {
      if (!deps.storage) return
      try {
        const stored = await deps.storage.get([SEEN_KEY, MUTED_KEY])
        const storedSeen = stored[SEEN_KEY]
        if (storedSeen && typeof storedSeen === 'object') {
          seen = storedSeen as Record<string, string>
        }
        const storedMuted = stored[MUTED_KEY]
        if (Array.isArray(storedMuted)) {
          state = {
            ...state,
            mutedGroupIds: storedMuted.filter((id): id is string => typeof id === 'string'),
          }
        }
        recomputeUnread()
        emit()
      } catch (error) {
        deps.onError?.('groups.hydrate', error)
      }
    },

    refresh,

    clear() {
      state = { ...EMPTY_GROUPS_STATE, mutedGroupIds: state.mutedGroupIds }
      emit()
    },

    applyMessage(message: ChatMessage): void {
      // Only for groups we know we are in; a stray event for anything else is
      // ignored rather than conjuring a conversation.
      if (!state.groups.some((group) => group.groupId === message.groupId)) return

      const existing = state.messages[message.groupId] ?? []
      // Realtime can deliver the same row twice around a reconnect.
      if (existing.some((entry) => entry.id === message.id)) return

      const merged = [...existing, message]
        .sort((a, b) => (a.createdAt === b.createdAt ? a.id.localeCompare(b.id) : a.createdAt < b.createdAt ? -1 : 1))
        .slice(-MESSAGE_WINDOW)

      state = { ...state, messages: { ...state.messages, [message.groupId]: merged } }
      recomputeUnread()
      emit()
    },

    markGroupRead(groupId: string): void {
      const messages = state.messages[groupId] ?? []
      const newest = messages[messages.length - 1]
      if (!newest) return
      if (seen[groupId] === newest.createdAt) return

      seen = { ...seen, [groupId]: newest.createdAt }
      persistSeen()
      recomputeUnread()
      emit()
    },

    async setMuted(groupId: string, muted: boolean): Promise<void> {
      const next = muted
        ? [...new Set([...state.mutedGroupIds, groupId])]
        : state.mutedGroupIds.filter((id) => id !== groupId)
      setState({ mutedGroupIds: next })
      await deps.storage?.set({ [MUTED_KEY]: next }).catch((error: unknown) => {
        deps.onError?.('groups.setMuted', error)
      })
    },

    async createGroup(name: string, icon: string | null = null): Promise<string> {
      const id = await mutate('createGroup', () => deps.backend.createGroup(name, icon))
      await refresh()
      return id
    },

    async setGroupIcon(groupId: string, icon: string | null): Promise<void> {
      await mutate('renameGroup', () => deps.backend.setGroupIcon(groupId, icon))
      await refresh()
    },

    async renameGroup(groupId: string, name: string): Promise<void> {
      await mutate('renameGroup', () => deps.backend.renameGroup(groupId, name))
      await refresh()
    },

    async deleteGroup(groupId: string): Promise<void> {
      await mutate('deleteGroup', () => deps.backend.deleteGroup(groupId))
      await refresh()
    },

    async invite(groupId: string, userId: string): Promise<string> {
      const outcome = await mutate('invite', () => deps.backend.inviteToGroup(groupId, userId))
      await refresh()
      return outcome
    },

    async cancelInvite(groupId: string, userId: string): Promise<void> {
      await mutate('invite', () => deps.backend.cancelGroupInvite(groupId, userId))
      // Re-read rather than assume: the invitation may have been accepted a
      // moment ago, in which case they are a member and nothing was cancelled.
      await refresh()
    },

    async respondToInvite(inviteId: string, accept: boolean): Promise<string> {
      const outcome = await mutate('respond', () =>
        deps.backend.respondToInvite(inviteId, accept),
      )
      await refresh()
      return outcome
    },

    async leaveGroup(groupId: string): Promise<void> {
      await mutate('leaveGroup', () => deps.backend.leaveGroup(groupId))
      await refresh()
    },

    async removeMember(groupId: string, userId: string): Promise<void> {
      await mutate('removeMember', () => deps.backend.removeMember(groupId, userId))
      await refresh()
    },

    async sendMessage(groupId: string, body: string): Promise<void> {
      await mutate('sendMessage', () => deps.backend.sendMessage(groupId, body))
      // The realtime event delivers the message itself; no re-read needed.
    },
  }
}
