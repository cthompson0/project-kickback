import { useEffect, useRef, useState } from 'react'
import type {
  FriendRequest,
  KickbackClient,
  Relationship,
  SearchResult,
} from '../../client/types'
import { Avatar } from './Avatar'
import { BackIcon } from './Icons'

/**
 * Find Friends: one input, results you can act on immediately.
 *
 * Search only ever returns people who already have a Kickback account - it does
 * not and cannot look up arbitrary Twitch accounts, so an empty result says
 * "not on Kickback", never "no such Twitch user".
 */

const SEARCH_DEBOUNCE_MS = 250
const MIN_QUERY_LENGTH = 2

interface FindFriendsProps {
  client: KickbackClient
  outgoingRequests: FriendRequest[]
  onBack: () => void
}

/** What the button for a given relationship should say and whether it acts. */
function actionFor(relationship: Relationship): { label: string; actionable: boolean } {
  switch (relationship) {
    case 'self':
      return { label: 'You', actionable: false }
    case 'friend':
      return { label: 'Friends', actionable: false }
    case 'request_sent':
      return { label: 'Requested', actionable: false }
    case 'request_received':
      return { label: 'Accept', actionable: true }
    default:
      return { label: 'Add', actionable: true }
  }
}

export function FindFriends({ client, outgoingRequests, onBack }: FindFriendsProps) {
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<SearchResult[] | null>(null)
  const [searching, setSearching] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [busyUserId, setBusyUserId] = useState<string | null>(null)
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    inputRef.current?.focus()
  }, [])

  const trimmed = query.trim()

  // Nothing is set synchronously here: the query is debounced, and the loading
  // flag flips inside the timer once a request is genuinely in flight.
  useEffect(() => {
    if (trimmed.length < MIN_QUERY_LENGTH) return

    let cancelled = false

    const timer = window.setTimeout(() => {
      if (cancelled) return
      setSearching(true)
      client
        .searchUsers(trimmed)
        .then((found) => {
          if (cancelled) return
          setResults(found)
          setError(null)
        })
        .catch((cause: unknown) => {
          if (cancelled) return
          setResults(null)
          setError(cause instanceof Error ? cause.message : 'Search failed.')
        })
        .finally(() => {
          if (!cancelled) setSearching(false)
        })
    }, SEARCH_DEBOUNCE_MS)

    return () => {
      cancelled = true
      window.clearTimeout(timer)
    }
  }, [client, trimmed])

  /** Optimistically flip the row, then let the backend's answer overwrite it. */
  function applyRelationship(userId: string, relationship: Relationship) {
    setResults((current) =>
      current
        ? current.map((result) =>
            result.userId === userId ? { ...result, relationship } : result,
          )
        : current,
    )
  }

  async function add(result: SearchResult) {
    setBusyUserId(result.userId)
    setError(null)
    const previous = result.relationship

    try {
      const outcome = await client.sendFriendRequest(result.userId)
      // The backend auto-accepts a reciprocal request, so "sent" is not always
      // the answer - trust what it returned rather than what we assumed.
      applyRelationship(
        result.userId,
        outcome === 'friends' || outcome === 'already_friends' ? 'friend' : 'request_sent',
      )
    } catch (cause) {
      applyRelationship(result.userId, previous)
      setError(cause instanceof Error ? cause.message : 'Could not send that request.')
    } finally {
      setBusyUserId(null)
    }
  }

  /**
   * A control labelled ACCEPT accepts. It does not send the user somewhere
   * else to do it. The worker owns the request id and looks it up - the
   * earlier version searched the *outgoing* list for an *incoming* request,
   * so it could never find one.
   */
  async function accept(result: SearchResult) {
    setBusyUserId(result.userId)
    setError(null)
    try {
      await client.acceptFriendRequestFrom(result.userId)
      applyRelationship(result.userId, 'friend')
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not accept that request.')
    } finally {
      setBusyUserId(null)
    }
  }

  async function cancel(request: FriendRequest) {
    setBusyUserId(request.user.id)
    try {
      await client.cancelFriendRequest(request.requestId)
      applyRelationship(request.user.id, 'none')
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not cancel that request.')
    } finally {
      setBusyUserId(null)
    }
  }

  return (
    <>
      <div className="kb-detail-head">
        <button type="button" className="kb-back" onClick={onBack} title="Back to friends">
          <BackIcon />
        </button>
        <div className="kb-group-name">Find friends</div>
      </div>

      <input
        ref={inputRef}
        className="kb-search"
        type="text"
        value={query}
        placeholder="Twitch username or friend code"
        spellCheck={false}
        autoComplete="off"
        onChange={(event) => {
          const value = event.target.value
          setQuery(value)
          // Clearing the box clears the results with it, rather than leaving
          // stale matches under an empty query.
          if (value.trim().length < MIN_QUERY_LENGTH) {
            setResults(null)
            setSearching(false)
            setError(null)
          }
        }}
      />

      {error && <div className="kb-inline-note">{error}</div>}

      {trimmed.length >= MIN_QUERY_LENGTH && searching && (
        <div className="kb-quiet-sub kb-search-status">Searching…</div>
      )}

      {results && results.length === 0 && !searching && (
        <div className="kb-quiet">
          <div className="kb-quiet-title">No Kickback user found</div>
          <div className="kb-quiet-sub">
            They may not have joined Kickback yet. Try their exact Twitch username, or swap friend
            codes.
          </div>
        </div>
      )}

      {results?.map((result) => {
        const { label, actionable } = actionFor(result.relationship)
        const busy = busyUserId === result.userId

        return (
          <div className="kb-row" key={result.userId}>
            <Avatar
              user={{
                id: result.userId,
                username: result.twitchLogin ?? result.displayName,
                displayName: result.displayName,
                avatarUrl: result.avatarUrl,
              }}
              showDot={false}
            />
            <div className="kb-row-main">
              <div className="kb-row-name">{result.displayName}</div>
              <div className="kb-row-status">
                {result.twitchLogin ? (
                  <span className="kb-handle">@{result.twitchLogin}</span>
                ) : (
                  <span className="kb-handle">Kickback user</span>
                )}
                {result.matchedBy === 'friend_code' && (
                  <span className="kb-time">friend code</span>
                )}
              </div>
            </div>

            {actionable ? (
              <button
                type="button"
                className={`kb-join${busy ? ' kb-join-busy' : ''}`}
                disabled={busy}
                onClick={() =>
                  result.relationship === 'request_received' ? accept(result) : add(result)
                }
              >
                {busy ? '…' : label.toUpperCase()}
              </button>
            ) : (
              <span className="kb-relationship">{label}</span>
            )}
          </div>
        )
      })}

      {!results && outgoingRequests.length > 0 && (
        <>
          <div className="kb-section-label">Sent · {outgoingRequests.length}</div>
          {outgoingRequests.map((request) => (
            <div className="kb-row" key={request.requestId}>
              <Avatar user={request.user} showDot={false} />
              <div className="kb-row-main">
                <div className="kb-row-name">{request.user.displayName}</div>
                <div className="kb-row-status">
                  <span className="kb-handle">@{request.user.username}</span>
                </div>
              </div>
              <button
                type="button"
                className="kb-ghost-btn kb-ghost-btn-inline"
                disabled={busyUserId === request.user.id}
                onClick={() => cancel(request)}
              >
                Cancel
              </button>
            </div>
          ))}
        </>
      )}
    </>
  )
}
