import { IDLE } from '../core/types'
import type { Presence } from '../core/types'
import type { BackendResult } from './auth'
import type {
  BlockedUser,
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
  /**
   * Block, unblock, and who is blocked.
   *
   * These live beside the friend operations because that is what blocking acts
   * on: the server takes the friendship apart and cancels any pending request
   * in the same transaction, so a block is a friendship mutation that happens
   * to leave a row behind.
   */
  blockUser(userId: string): Promise<BackendResult<true>>
  unblockUser(userId: string): Promise<BackendResult<true>>
  listBlocked(): Promise<BackendResult<BlockedUser[]>>
  /**
   * Send one piece of feedback.
   *
   * It lives on this backend rather than getting one of its own because this is
   * already the authenticated-RPC surface and feedback is one call. A second
   * backend interface for a single method would be ceremony, not structure.
   */
  submitFeedback(input: {
    category: string
    body: string
    context: Record<string, unknown>
  }): Promise<BackendResult<true>>
}

export interface FriendsState {
  friends: Friend[]
  incomingRequests: FriendRequest[]
  outgoingRequests: FriendRequest[]
  /**
   * People this viewer has blocked.
   *
   * Only ever their own blocks - the server will not answer "who has blocked
   * me", and the panel has no reason to ask.
   */
  blocked: BlockedUser[]
  friendsLoading: boolean
  friendsError: string | null
}

export const EMPTY_FRIENDS_STATE: FriendsState = {
  friends: [],
  incomingRequests: [],
  outgoingRequests: [],
  blocked: [],
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
  /**
   * Patch one friend's presence from a realtime event. Presence is
   * high-frequency, so this deliberately avoids the re-read that every
   * mutation does - one person hopping channels must not cost a query per
   * friend per hop.
   */
  applyPresence(presence: Presence): void
  /** A friend's presence row vanished; show them as offline, not stale. */
  clearPresence(userId: string): void
  search(query: string): Promise<SearchResult[]>
  sendRequest(userId: string): Promise<SendRequestOutcome>
  respond(requestId: string, accept: boolean): Promise<'accepted' | 'declined'>
  /**
   * Accept whoever asked, by person rather than by request id.
   *
   * The UI knows "this person wants to be my friend" - it should not have to
   * carry request ids around to act on that. Resolving the id here, against the
   * authoritative list, is also what makes accepting from search work at all.
   */
  acceptFrom(userId: string): Promise<'accepted'>
  cancel(requestId: string): Promise<void>
  remove(userId: string): Promise<void>
  /**
   * Block somebody, which also ends the friendship server-side.
   *
   * Goes through the same re-read every other mutation does, and that is not
   * tidiness: the server has just deleted a friendship, and without the re-read
   * the panel would keep drawing somebody the graph no longer contains.
   */
  block(userId: string): Promise<void>
  unblock(userId: string): Promise<void>
  /**
   * Send feedback, with the diagnostics its caller assembled.
   *
   * Deliberately NOT routed through mutate(): every other call here changes the
   * social graph and is followed by a re-read, and feedback changes nothing the
   * panel draws. Re-reading the friends list because somebody sent a note would
   * be a round trip for no reason, and a transient list error would turn a
   * successful submission into a visible failure.
   */
  sendFeedback(input: {
    category: string
    body: string
    context: Record<string, unknown>
  }): Promise<void>
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
    case 'block':
      return 'Could not block that user.'
    case 'unblock':
      return 'Could not unblock that user.'
    case 'feedback':
      return 'Could not send that. Your text is still here - try again.'
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

    const [friends, requests, blocked] = await Promise.all([
      deps.backend.listFriends(),
      deps.backend.listFriendRequests(),
      deps.backend.listBlocked(),
    ])

    if (friends.error || requests.error) {
      deps.onError?.('refresh', friends.error ?? requests.error)
      setState({ friendsLoading: false, friendsError: friendlyError('refresh') })
      return
    }

    /*
     * A failed block list is not a failed refresh.
     *
     * It only feeds a management list in the settings card; the friends list is
     * what the panel is for. Keeping the previous value rather than emptying it
     * follows the same rule every other read here does - never invent, never
     * blank out to look tidy.
     */
    const all = requests.value ?? []
    setState({
      blocked: blocked.error ? state.blocked : (blocked.value ?? []),
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

    applyPresence(presence: Presence): void {
      // Bail before touching state. The map below would already leave a
      // stranger out, but every setState broadcasts to every open Twitch tab -
      // a late event for an ex-friend should cost nothing at all.
      if (!state.friends.some((friend) => friend.user.id === presence.userId)) return

      setState({
        friends: state.friends.map((friend) =>
          friend.user.id === presence.userId ? { ...friend, presence } : friend,
        ),
      })
    },

    clearPresence(userId: string): void {
      setState({
        friends: state.friends.map((friend) =>
          friend.user.id === userId
            ? {
                ...friend,
                presence: {
                  userId,
                  status: 'offline',
                  activity: IDLE,
                  since: Date.now(),
                },
              }
            : friend,
        ),
      })
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

    async acceptFrom(userId: string): Promise<'accepted'> {
      const find = () =>
        state.incomingRequests.find((request) => request.user.id === userId)

      // Our view of the inbox can lag behind the database - the request may
      // have arrived seconds ago. Re-read once before giving up.
      let request = find()
      if (!request) {
        await refresh()
        request = find()
      }
      if (!request) {
        throw new Error('That friend request is no longer available.')
      }

      await mutate('respond', () =>
        deps.backend.respondToFriendRequest(request.requestId, true),
      )
      return 'accepted'
    },

    async cancel(requestId) {
      await mutate('cancel', () => deps.backend.cancelFriendRequest(requestId))
    },

    async remove(userId) {
      await mutate('remove', () => deps.backend.removeFriend(userId))
    },

    async block(userId) {
      await mutate('block', () => deps.backend.blockUser(userId))
    },

    async unblock(userId) {
      await mutate('unblock', () => deps.backend.unblockUser(userId))
    },

    async sendFeedback(input) {
      const result = await deps.backend.submitFeedback(input)
      if (result.error) {
        deps.onError?.('feedback', result.error)
        // Thrown rather than swallowed: the form keeps what they typed and
        // offers a retry, which it can only do if it learns this failed.
        throw new Error(friendlyError('feedback'))
      }
    },
  }
}
