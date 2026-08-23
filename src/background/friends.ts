import type { BackendResult } from './auth'
import type {
  Friend,
  FriendRequest,
  SearchResult,
  SendRequestOutcome,
} from '../client/types'

/**
 * Friends and friend requests.
 *
 * Like the auth service, this holds no Supabase or Chrome API: it drives an
 * injected FriendsBackend, so every branch is testable without a network.
 *
 * Two rules it exists to keep:
 *   - every mutation is followed by a re-read, so the panel reflects what the
 *     database actually decided rather than what the client hoped for. The
 *     reciprocal-request case makes this necessary, not merely tidy: sending a
 *     request can return "you are now friends".
 *   - a failure leaves the previous list in place and reports the error. It
 *     never empties the list to look tidy and never invents entries.
 */

export interface FriendsBackend {
  listFriends(): Promise<BackendResult<Friend[]>>
  listFriendRequests(): Promise<BackendResult<FriendRequest[]>>
  searchUsers(query: string): Promise<BackendResult<SearchResult[]>>
  sendFriendRequest(userId: string): Promise<BackendResult<SendRequestOutcome>>
  respondToFriendRequest(
    requestId: string,
    accept: boolean,
  ): Promise<BackendResult<'accepted' | 'declined'>>
  cancelFriendRequest(requestId: string): Promise<BackendResult<'cancelled'>>
  removeFriend(userId: string): Promise<BackendResult<boolean>>
}

export interface FriendsState {
  friends: Friend[]
  incomingRequests: FriendRequest[]
  outgoingRequests: FriendRequest[]
  friendsLoading: boolean
  friendsError: string | null
}

export const EMPTY_FRIENDS_STATE: FriendsState = {
  friends: [],
  incomingRequests: [],
  outgoingRequests: [],
  friendsLoading: false,
  friendsError: null,
}

export interface FriendsDeps {
  backend: FriendsBackend
  onError?: (context: string, error: unknown) => void
}

export interface FriendsService {
  getState(): FriendsState
  subscribe(listener: (state: FriendsState) => void): () => void
  /** Re-read friends and requests. Safe to call repeatedly. */
  refresh(): Promise<void>
  /** Drop everything - used on sign-out and whenever auth is not healthy. */
  clear(): void
  search(query: string): Promise<SearchResult[]>
  sendRequest(userId: string): Promise<SendRequestOutcome>
  respond(requestId: string, accept: boolean): Promise<'accepted' | 'declined'>
  cancel(requestId: string): Promise<void>
  remove(userId: string): Promise<void>
}

/** Turns a backend failure into something a person can read. */
function friendlyError(context: string): string {
  switch (context) {
    case 'search':
      return 'Search failed. Check your connection and try again.'
    case 'sendRequest':
      return 'Could not send that friend request.'
    case 'respond':
      return 'Could not answer that friend request.'
    case 'cancel':
      return 'Could not cancel that request.'
    case 'remove':
      return 'Could not remove that friend.'
    default:
      return "Kickback can't reach its server right now."
  }
}

export function createFriendsService(deps: FriendsDeps): FriendsService {
  const listeners = new Set<(state: FriendsState) => void>()
  let state: FriendsState = { ...EMPTY_FRIENDS_STATE }

  const setState = (patch: Partial<FriendsState>) => {
    state = { ...state, ...patch }
    for (const listener of listeners) listener(state)
  }

  /** Runs a mutation, then re-reads so the UI shows the database's answer. */
  async function mutate<T>(
    context: string,
    run: () => Promise<BackendResult<T>>,
  ): Promise<T> {
    const result = await run()
    if (result.error || result.value === null) {
      deps.onError?.(context, result.error)
      // The previous list stays exactly as it was; only the message changes.
      setState({ friendsError: friendlyError(context) })
      throw new Error(friendlyError(context))
    }
    setState({ friendsError: null })
    await refresh()
    return result.value
  }

  async function refresh(): Promise<void> {
    setState({ friendsLoading: true })

    const [friends, requests] = await Promise.all([
      deps.backend.listFriends(),
      deps.backend.listFriendRequests(),
    ])

    if (friends.error || requests.error) {
      deps.onError?.('refresh', friends.error ?? requests.error)
      setState({ friendsLoading: false, friendsError: friendlyError('refresh') })
      return
    }

    const all = requests.value ?? []
    setState({
      friends: friends.value ?? [],
      incomingRequests: all.filter((request) => request.direction === 'incoming'),
      outgoingRequests: all.filter((request) => request.direction === 'outgoing'),
      friendsLoading: false,
      friendsError: null,
    })
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

    refresh,

    clear() {
      setState({ ...EMPTY_FRIENDS_STATE })
    },

    async search(query: string): Promise<SearchResult[]> {
      const trimmed = query.trim()
      if (trimmed.length < 2) return []

      const result = await deps.backend.searchUsers(trimmed)
      if (result.error) {
        deps.onError?.('search', result.error)
        throw new Error(friendlyError('search'))
      }
      return result.value ?? []
    },

    sendRequest: (userId) =>
      mutate('sendRequest', () => deps.backend.sendFriendRequest(userId)),

    respond: (requestId, accept) =>
      mutate('respond', () => deps.backend.respondToFriendRequest(requestId, accept)),

    async cancel(requestId) {
      await mutate('cancel', () => deps.backend.cancelFriendRequest(requestId))
    },

    async remove(userId) {
      await mutate('remove', () => deps.backend.removeFriend(userId))
    },
  }
}
