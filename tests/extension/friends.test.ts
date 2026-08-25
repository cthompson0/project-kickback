import { beforeEach, describe, expect, it } from 'vitest'
import { createFriendsService } from '../../src/background/friends'
import type { FriendsBackend } from '../../src/background/friends'
import { createSupabaseFriendsBackend } from '../../src/background/supabaseBackend'
import type { BackendResult } from '../../src/background/auth'
import type {
  BlockedUser,
  Friend,
  FriendRequest,
  SearchResult,
  SendRequestOutcome,
} from '../../src/client/types'

/**
 * The friends state machine, without a browser or a network.
 *
 * Two properties these tests protect:
 *   - a mutation is always followed by a re-read, so the panel shows what the
 *     database decided (this is what makes reciprocal auto-accept work);
 *   - a failure never empties the friends list and never invents entries.
 */

const NINA = { id: 'u-nina', displayName: 'Nina', twitchLogin: 'ninastreams' }
const OMAR = { id: 'u-omar', displayName: 'Omar', twitchLogin: 'omar_plays' }

function friend(person: typeof NINA): Friend {
  return {
    user: {
      id: person.id,
      username: person.twitchLogin,
      displayName: person.displayName,
      avatarUrl: null,
    },
    // Checkpoint 4 has no presence at all - not "offline".
    presence: null,
  }
}

function request(
  person: typeof NINA,
  direction: 'incoming' | 'outgoing',
  requestId = `req-${person.id}`,
): FriendRequest {
  return {
    requestId,
    direction,
    user: {
      id: person.id,
      username: person.twitchLogin,
      displayName: person.displayName,
      avatarUrl: null,
    },
    twitchLogin: person.twitchLogin,
    createdAt: '2026-08-23T00:00:00Z',
  }
}

function searchRow(person: typeof NINA, relationship: SearchResult['relationship']): SearchResult {
  return {
    userId: person.id,
    displayName: person.displayName,
    avatarUrl: null,
    twitchLogin: person.twitchLogin,
    relationship,
    matchedBy: 'twitch_login',
  }
}

class FakeBackend implements FriendsBackend {
  friends: Friend[] = []
  requests: FriendRequest[] = []
  searchResults: SearchResult[] = []
  sendOutcome: SendRequestOutcome = 'requested'

  blocked: BlockedUser[] = []
  feedback: Array<{ category: string; body: string; context: Record<string, unknown> }> = []

  failListWith: string | null = null
  failBlockedListWith: string | null = null
  failSearchWith: string | null = null
  failMutationWith: string | null = null

  calls: string[] = []

  async listFriends(): Promise<BackendResult<Friend[]>> {
    this.calls.push('listFriends')
    if (this.failListWith) return { value: null, error: this.failListWith }
    return { value: [...this.friends] }
  }

  async listFriendRequests(): Promise<BackendResult<FriendRequest[]>> {
    this.calls.push('listFriendRequests')
    if (this.failListWith) return { value: null, error: this.failListWith }
    return { value: [...this.requests] }
  }

  async searchUsers(query: string): Promise<BackendResult<SearchResult[]>> {
    this.calls.push(`searchUsers:${query}`)
    if (this.failSearchWith) return { value: null, error: this.failSearchWith }
    return { value: [...this.searchResults] }
  }

  async sendFriendRequest(userId: string): Promise<BackendResult<SendRequestOutcome>> {
    this.calls.push(`sendFriendRequest:${userId}`)
    if (this.failMutationWith) return { value: null, error: this.failMutationWith }
    return { value: this.sendOutcome }
  }

  async respondToFriendRequest(
    requestId: string,
    accept: boolean,
  ): Promise<BackendResult<'accepted' | 'declined'>> {
    this.calls.push(`respond:${requestId}:${accept}`)
    if (this.failMutationWith) return { value: null, error: this.failMutationWith }
    return { value: accept ? 'accepted' : 'declined' }
  }

  async cancelFriendRequest(requestId: string): Promise<BackendResult<'cancelled'>> {
    this.calls.push(`cancel:${requestId}`)
    if (this.failMutationWith) return { value: null, error: this.failMutationWith }
    return { value: 'cancelled' }
  }

  async removeFriend(userId: string): Promise<BackendResult<boolean>> {
    this.calls.push(`remove:${userId}`)
    if (this.failMutationWith) return { value: null, error: this.failMutationWith }
    return { value: true }
  }

  async blockUser(userId: string): Promise<BackendResult<true>> {
    this.calls.push(`block:${userId}`)
    if (this.failMutationWith) return { value: null, error: this.failMutationWith }
    // What the real server does in the same transaction, so the service sees
    // the friendship disappear the way it actually would.
    this.friends = this.friends.filter((friend) => friend.user.id !== userId)
    this.requests = this.requests.filter(
      (request) => request.user.id !== userId,
    )
    this.blocked.push({
      user: {
        id: userId,
        username: userId,
        displayName: userId,
        avatarUrl: null,
        accentColor: '#ff8452',
      },
      blockedAt: '2026-01-01T00:00:00.000Z',
    })
    return { value: true }
  }

  async unblockUser(userId: string): Promise<BackendResult<true>> {
    this.calls.push(`unblock:${userId}`)
    if (this.failMutationWith) return { value: null, error: this.failMutationWith }
    this.blocked = this.blocked.filter((entry) => entry.user.id !== userId)
    return { value: true }
  }

  async submitFeedback(input: {
    category: string
    body: string
    context: Record<string, unknown>
  }): Promise<BackendResult<true>> {
    this.calls.push(`feedback:${input.category}`)
    if (this.failMutationWith) return { value: null, error: this.failMutationWith }
    this.feedback.push(input)
    return { value: true }
  }

  async listBlocked(): Promise<BackendResult<BlockedUser[]>> {
    this.calls.push('listBlocked')
    if (this.failBlockedListWith) return { value: null, error: this.failBlockedListWith }
    return { value: [...this.blocked] }
  }
}

let backend: FakeBackend

beforeEach(() => {
  backend = new FakeBackend()
})

const service = () => createFriendsService({ backend })

describe('loading friends and requests', () => {
  it('starts empty and loads nothing it was not given', async () => {
    const friends = service()
    expect(friends.getState().friends).toEqual([])

    await friends.refresh()
    expect(friends.getState()).toMatchObject({
      friends: [],
      incomingRequests: [],
      outgoingRequests: [],
      friendsLoading: false,
      friendsError: null,
    })
  })

  it('loads real friends with no presence attached', async () => {
    backend.friends = [friend(NINA)]
    const friends = service()
    await friends.refresh()

    const [loaded] = friends.getState().friends
    expect(loaded.user.displayName).toBe('Nina')
    expect(loaded.user.username).toBe('ninastreams')
    // The important assertion of this checkpoint: no invented presence.
    expect(loaded.presence).toBeNull()
  })

  it('splits requests by direction', async () => {
    backend.requests = [request(NINA, 'incoming'), request(OMAR, 'outgoing')]
    const friends = service()
    await friends.refresh()

    expect(friends.getState().incomingRequests.map((r) => r.user.displayName)).toEqual(['Nina'])
    expect(friends.getState().outgoingRequests.map((r) => r.user.displayName)).toEqual(['Omar'])
  })

  it('reports a loading flag while fetching', async () => {
    const friends = service()
    const seen: boolean[] = []
    friends.subscribe((state) => seen.push(state.friendsLoading))

    await friends.refresh()

    expect(seen).toContain(true)
    expect(seen.at(-1)).toBe(false)
  })

  it('keeps the existing list when a refresh fails', async () => {
    backend.friends = [friend(NINA)]
    const friends = service()
    await friends.refresh()

    backend.failListWith = 'network down'
    await friends.refresh()

    expect(friends.getState().friends).toHaveLength(1)
    expect(friends.getState().friendsError).toMatch(/can't reach/i)
  })

  it('clears everything on sign-out', async () => {
    backend.friends = [friend(NINA)]
    backend.requests = [request(OMAR, 'incoming')]
    const friends = service()
    await friends.refresh()

    friends.clear()

    expect(friends.getState()).toMatchObject({
      friends: [],
      incomingRequests: [],
      outgoingRequests: [],
      friendsError: null,
    })
  })
})

describe('search', () => {
  it('finds a Kickback user by Twitch username', async () => {
    backend.searchResults = [searchRow(NINA, 'none')]
    const found = await service().search('nina')

    expect(backend.calls).toContain('searchUsers:nina')
    expect(found).toHaveLength(1)
    expect(found[0]).toMatchObject({ twitchLogin: 'ninastreams', relationship: 'none' })
  })

  it('finds a user by exact friend code', async () => {
    backend.searchResults = [{ ...searchRow(NINA, 'none'), matchedBy: 'friend_code' }]
    const found = await service().search('KB-7QX4-M2P9')

    expect(backend.calls).toContain('searchUsers:KB-7QX4-M2P9')
    expect(found[0].matchedBy).toBe('friend_code')
  })

  it('returns nothing for someone who has not joined Kickback', async () => {
    backend.searchResults = []
    expect(await service().search('shroud')).toEqual([])
  })

  it('reports the searcher themselves distinctly', async () => {
    backend.searchResults = [searchRow(NINA, 'self')]
    expect((await service().search('nina'))[0].relationship).toBe('self')
  })

  it('reports an existing friendship', async () => {
    backend.searchResults = [searchRow(NINA, 'friend')]
    expect((await service().search('nina'))[0].relationship).toBe('friend')
  })

  it('does not call the backend for a query that is too short', async () => {
    expect(await service().search('n')).toEqual([])
    expect(backend.calls.filter((call) => call.startsWith('searchUsers'))).toHaveLength(0)
  })

  it('trims whitespace before searching', async () => {
    await service().search('  nina  ')
    expect(backend.calls).toContain('searchUsers:nina')
  })

  it('surfaces a search failure without clearing the friends list', async () => {
    backend.friends = [friend(OMAR)]
    const friends = service()
    await friends.refresh()

    backend.failSearchWith = 'timeout'
    await expect(friends.search('nina')).rejects.toThrow(/Search failed/i)
    expect(friends.getState().friends).toHaveLength(1)
  })
})

describe('sending a friend request', () => {
  it('sends and then re-reads so the panel reflects the database', async () => {
    const friends = service()
    backend.requests = [request(NINA, 'outgoing')]

    const outcome = await friends.sendRequest(NINA.id)

    expect(outcome).toBe('requested')
    expect(backend.calls).toContain(`sendFriendRequest:${NINA.id}`)
    expect(backend.calls.indexOf('listFriends')).toBeGreaterThan(
      backend.calls.indexOf(`sendFriendRequest:${NINA.id}`),
    )
    expect(friends.getState().outgoingRequests).toHaveLength(1)
  })

  it('reports a duplicate request as already requested, creating no second entry', async () => {
    backend.sendOutcome = 'already_requested'
    backend.requests = [request(NINA, 'outgoing')]
    const friends = service()

    expect(await friends.sendRequest(NINA.id)).toBe('already_requested')
    expect(friends.getState().outgoingRequests).toHaveLength(1)
  })

  it('reports an existing friendship rather than sending again', async () => {
    backend.sendOutcome = 'already_friends'
    backend.friends = [friend(NINA)]
    const friends = service()

    expect(await friends.sendRequest(NINA.id)).toBe('already_friends')
    expect(friends.getState().friends).toHaveLength(1)
  })

  it('surfaces the reciprocal auto-accept and leaves no stale pending state', async () => {
    // Nina already asked us; adding her back becomes a friendship immediately.
    backend.sendOutcome = 'friends'
    backend.friends = [friend(NINA)]
    backend.requests = []
    const friends = service()

    const outcome = await friends.sendRequest(NINA.id)

    expect(outcome).toBe('friends')
    expect(friends.getState().friends).toHaveLength(1)
    expect(friends.getState().incomingRequests).toEqual([])
    expect(friends.getState().outgoingRequests).toEqual([])
  })

  it('reports failure and leaves state untouched', async () => {
    backend.friends = [friend(OMAR)]
    const friends = service()
    await friends.refresh()
    const before = friends.getState().friends

    backend.failMutationWith = 'denied'
    await expect(friends.sendRequest(NINA.id)).rejects.toThrow(/Could not send/i)

    expect(friends.getState().friends).toEqual(before)
    expect(friends.getState().friendsError).toMatch(/Could not send/i)
  })
})

describe('answering a friend request', () => {
  it('accepts and moves the person into the friends list', async () => {
    const friends = service()
    backend.requests = [request(NINA, 'incoming', 'req-1')]
    await friends.refresh()
    expect(friends.getState().incomingRequests).toHaveLength(1)

    // Accepting is what the database does; reflect its new answer.
    backend.requests = []
    backend.friends = [friend(NINA)]
    const result = await friends.respond('req-1', true)

    expect(result).toBe('accepted')
    expect(backend.calls).toContain('respond:req-1:true')
    expect(friends.getState().friends).toHaveLength(1)
    expect(friends.getState().incomingRequests).toEqual([])
  })

  it('declines and drops the request without creating a friendship', async () => {
    const friends = service()
    backend.requests = [request(NINA, 'incoming', 'req-1')]
    await friends.refresh()

    backend.requests = []
    const result = await friends.respond('req-1', false)

    expect(result).toBe('declined')
    expect(backend.calls).toContain('respond:req-1:false')
    expect(friends.getState().friends).toEqual([])
    expect(friends.getState().incomingRequests).toEqual([])
  })

  it('reports a failure to answer and keeps the request visible', async () => {
    const friends = service()
    backend.requests = [request(NINA, 'incoming', 'req-1')]
    await friends.refresh()

    backend.failMutationWith = 'gone'
    await expect(friends.respond('req-1', true)).rejects.toThrow(/Could not answer/i)
    expect(friends.getState().incomingRequests).toHaveLength(1)
  })
})

describe('accepting by person (the Find Friends ACCEPT path)', () => {
  // Regression: the manual two-user test found ACCEPT in search results did
  // nothing but tell the user to go to the Friends tab. The UI had been
  // searching the OUTGOING list for an INCOMING request, so the lookup could
  // never succeed. Accepting is now expressed by person, and resolved here.

  it('accepts the pending request from that person', async () => {
    const friends = service()
    backend.requests = [request(NINA, 'incoming', 'req-77')]
    await friends.refresh()

    backend.requests = []
    backend.friends = [friend(NINA)]
    const result = await friends.acceptFrom(NINA.id)

    expect(result).toBe('accepted')
    expect(backend.calls).toContain('respond:req-77:true')
    expect(friends.getState().friends.map((f) => f.user.displayName)).toEqual(['Nina'])
    expect(friends.getState().incomingRequests).toEqual([])
  })

  it('finds a request that arrived after our last read', async () => {
    // Exactly the reported scenario: B has Kickback open, A sends a request,
    // B searches A. Search (fresh from the database) says request_received,
    // but B's cached inbox is empty.
    const friends = service()
    await friends.refresh()
    expect(friends.getState().incomingRequests).toEqual([])

    backend.requests = [request(NINA, 'incoming', 'req-late')]
    const result = await friends.acceptFrom(NINA.id)

    expect(result).toBe('accepted')
    expect(backend.calls).toContain('respond:req-late:true')
  })

  it('never picks up an outgoing request by mistake', async () => {
    // The original bug in reverse: an outgoing request to Nina must not be
    // mistaken for one from her.
    const friends = service()
    backend.requests = [request(NINA, 'outgoing', 'req-mine')]
    await friends.refresh()

    await expect(friends.acceptFrom(NINA.id)).rejects.toThrow(/no longer available/i)
    expect(backend.calls.some((call) => call.startsWith('respond:'))).toBe(false)
  })

  it('reports clearly when the request has already gone', async () => {
    const friends = service()
    await expect(friends.acceptFrom(NINA.id)).rejects.toThrow(/no longer available/i)
  })

  it('does not tell the user to go somewhere else', async () => {
    const friends = service()
    try {
      await friends.acceptFrom(NINA.id)
      throw new Error('expected a rejection')
    } catch (cause) {
      expect((cause as Error).message).not.toMatch(/friends tab/i)
    }
  })

  it('surfaces a backend refusal', async () => {
    const friends = service()
    backend.requests = [request(NINA, 'incoming', 'req-77')]
    await friends.refresh()

    backend.failMutationWith = 'gone'
    await expect(friends.acceptFrom(NINA.id)).rejects.toThrow(/Could not answer/i)
  })
})

describe('cancelling an outgoing request', () => {
  it('cancels and re-reads', async () => {
    const friends = service()
    backend.requests = [request(NINA, 'outgoing', 'req-9')]
    await friends.refresh()

    backend.requests = []
    await friends.cancel('req-9')

    expect(backend.calls).toContain('cancel:req-9')
    expect(friends.getState().outgoingRequests).toEqual([])
  })

  it('reports a cancel failure', async () => {
    const friends = service()
    backend.failMutationWith = 'nope'
    await expect(friends.cancel('req-9')).rejects.toThrow(/Could not cancel/i)
  })
})

describe('removing a friend', () => {
  it('removes and re-reads', async () => {
    const friends = service()
    backend.friends = [friend(NINA), friend(OMAR)]
    await friends.refresh()

    backend.friends = [friend(OMAR)]
    await friends.remove(NINA.id)

    expect(backend.calls).toContain(`remove:${NINA.id}`)
    expect(friends.getState().friends.map((f) => f.user.displayName)).toEqual(['Omar'])
  })

  it('keeps the friend visible when removal fails', async () => {
    const friends = service()
    backend.friends = [friend(NINA)]
    await friends.refresh()

    backend.failMutationWith = 'network'
    await expect(friends.remove(NINA.id)).rejects.toThrow(/Could not remove/i)
    expect(friends.getState().friends).toHaveLength(1)
  })
})

describe('never invents people', () => {
  it('produces no friend without a backend row, in any reachable state', async () => {
    const friends = service()
    const seen: Friend[][] = []
    friends.subscribe((state) => seen.push(state.friends))

    await friends.refresh()
    backend.failListWith = 'down'
    await friends.refresh()
    backend.failListWith = null
    backend.failMutationWith = 'down'
    await friends.sendRequest(NINA.id).catch(() => {})
    friends.clear()

    for (const snapshot of seen) {
      expect(snapshot).toEqual([])
    }
  })

  it('passes presence through untouched rather than inventing any', async () => {
    // The service must never manufacture presence: whatever the backend
    // supplies - including nothing at all - is what the panel sees.
    backend.friends = [friend(NINA), friend(OMAR)]
    const friends = service()
    await friends.refresh()

    for (const loaded of friends.getState().friends) {
      expect(loaded.presence).toBeNull()
    }
  })
})

// ---------------------------------------------------------------------------

describe('Supabase row mapping', () => {
  /** Minimal stand-in for the supabase client: only .rpc() is used here. */
  function fakeSupabase(responses: Record<string, unknown>) {
    const calls: Array<{ fn: string; args: unknown }> = []
    const client = {
      rpc: async (fn: string, args: unknown) => {
        calls.push({ fn, args })
        if (!(fn in responses)) return { data: null, error: { message: `no stub for ${fn}` } }
        return { data: responses[fn], error: null }
      },
    }
    return { client, calls }
  }

  it('maps the presence columns list_friends returns', async () => {
    // Checkpoint 4 deliberately discarded these; Checkpoint 5 is where they
    // start meaning something.
    const now = new Date().toISOString()
    const { client } = fakeSupabase({
      list_friends: [
        {
          user_id: 'u-nina',
          display_name: 'Nina',
          avatar_url: 'https://cdn.twitch.test/nina.png',
          twitch_login: 'ninastreams',
          status: 'online',
          platform: 'twitch',
          channel: 'lirik',
          updated_at: now,
          last_seen_at: now,
        },
      ],
    })

    const backend = createSupabaseFriendsBackend(client as never)
    const result = await backend.listFriends()

    expect(result.error).toBeUndefined()
    expect(result.value?.[0].user.avatarUrl).toBe('https://cdn.twitch.test/nina.png')
    expect(result.value?.[0].presence).toMatchObject({
      userId: 'u-nina',
      status: 'online',
      activity: { type: 'watching', platform: 'twitch', channel: 'lirik' },
    })
  })

  it('reports a friend with no channel as browsing, not watching nothing', async () => {
    const now = new Date().toISOString()
    const { client } = fakeSupabase({
      list_friends: [
        {
          user_id: 'u-nina',
          display_name: 'Nina',
          avatar_url: null,
          twitch_login: 'ninastreams',
          status: 'online',
          platform: null,
          channel: null,
          updated_at: now,
          last_seen_at: now,
        },
      ],
    })

    const result = await createSupabaseFriendsBackend(client as never).listFriends()
    expect(result.value?.[0].presence?.activity).toEqual({ type: 'browsing', platform: 'twitch' })
  })

  it('carries no activity for an offline friend', async () => {
    const { client } = fakeSupabase({
      list_friends: [
        {
          user_id: 'u-nina',
          display_name: 'Nina',
          avatar_url: null,
          twitch_login: 'ninastreams',
          status: 'offline',
          platform: null,
          channel: null,
          updated_at: null,
          last_seen_at: null,
        },
      ],
    })

    const result = await createSupabaseFriendsBackend(client as never).listFriends()
    expect(result.value?.[0].presence).toMatchObject({
      status: 'offline',
      activity: { type: 'idle' },
    })
  })

  it('passes the query through to search_users without an actor id', async () => {
    const { client, calls } = fakeSupabase({
      search_users: [
        {
          user_id: 'u-nina',
          display_name: 'Nina',
          avatar_url: null,
          twitch_login: 'ninastreams',
          relationship: 'none',
          matched_by: 'twitch_login',
        },
      ],
    })

    await createSupabaseFriendsBackend(client as never).searchUsers('nina')

    expect(calls[0].fn).toBe('search_users')
    // Only the query. The database derives the actor from auth.uid().
    expect(calls[0].args).toEqual({ p_query: 'nina' })
  })

  it('sends only the target id when creating a friend request', async () => {
    const { client, calls } = fakeSupabase({ send_friend_request: 'requested' })

    const result = await createSupabaseFriendsBackend(client as never).sendFriendRequest('u-nina')

    expect(calls[0]).toEqual({ fn: 'send_friend_request', args: { p_target: 'u-nina' } })
    expect(result.value).toBe('requested')
  })

  it('never passes an actor, user id or session to any friend RPC', async () => {
    const { client, calls } = fakeSupabase({
      list_friends: [],
      list_friend_requests: [],
      search_users: [],
      send_friend_request: 'requested',
      respond_to_friend_request: 'accepted',
      cancel_friend_request: 'cancelled',
      remove_friend: true,
    })
    const backend = createSupabaseFriendsBackend(client as never)

    await backend.listFriends()
    await backend.listFriendRequests()
    await backend.searchUsers('nina')
    await backend.sendFriendRequest('u-nina')
    await backend.respondToFriendRequest('req-1', true)
    await backend.cancelFriendRequest('req-1')
    await backend.removeFriend('u-nina')

    const forbidden = /actor|auth|jwt|token|session|p_user_id|p_self/i
    for (const call of calls) {
      for (const key of Object.keys(call.args ?? {})) {
        expect(key).not.toMatch(forbidden)
      }
    }
    expect(calls.map((call) => call.fn)).toEqual([
      'list_friends',
      'list_friend_requests',
      'search_users',
      'send_friend_request',
      'respond_to_friend_request',
      'cancel_friend_request',
      'remove_friend',
    ])
  })

  it('turns an RPC error into a result rather than throwing', async () => {
    const { client } = fakeSupabase({})
    const result = await createSupabaseFriendsBackend(client as never).listFriends()

    expect(result.value).toBeNull()
    expect(result.error).toBeTruthy()
  })
})
