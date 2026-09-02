import { useState } from 'react'
import { humanMessage } from '../../core/errors'
import type { FriendRequest, KickbackClient } from '../../client/types'
import { Avatar } from './Avatar'

/**
 * Incoming friend requests, shown at the top of the Friends tab.
 *
 * Accepting re-reads the friends list in the service worker, so the new friend
 * appears below without a page reload and every other open Twitch tab sees it
 * on the next broadcast.
 */
export function IncomingRequests({
  requests,
  client,
  onError,
}: {
  requests: FriendRequest[]
  client: KickbackClient
  onError: (message: string) => void
}) {
  const [busyId, setBusyId] = useState<string | null>(null)

  if (requests.length === 0) return null

  async function respond(request: FriendRequest, accept: boolean) {
    setBusyId(request.requestId)
    try {
      await client.respondToFriendRequest(request.requestId, accept)
    } catch (cause) {
      onError(humanMessage(cause, 'Could not answer that request.'))
    } finally {
      setBusyId(null)
    }
  }

  return (
    <>
      <div className="kb-section-label">
        Wants to be friends · {requests.length}
      </div>
      {requests.map((request) => {
        const busy = busyId === request.requestId
        return (
          <div className="kb-row kb-row-request" key={request.requestId}>
            <Avatar user={request.user} showDot={false} />
            <div className="kb-row-main">
              <div className="kb-row-name">{request.user.displayName}</div>
              <div className="kb-row-status">
                <span className="kb-handle">@{request.user.username}</span>
              </div>
            </div>
            <button
              type="button"
              className={`kb-join${busy ? ' kb-join-busy' : ''}`}
              disabled={busy}
              onClick={() => respond(request, true)}
            >
              {busy ? '…' : 'ACCEPT'}
            </button>
            <button
              type="button"
              className="kb-ghost-btn kb-ghost-btn-inline"
              disabled={busy}
              onClick={() => respond(request, false)}
            >
              Decline
            </button>
          </div>
        )
      })}
    </>
  )
}
