import { useEffect, useState } from 'react'
import { formatChannelName } from '../platforms/twitch/channels'
import type { KickbackClient } from '../client/types'
import { useKickbackState } from './useKickbackState'
import { Avatar } from './components/Avatar'
import { FriendsTab } from './components/FriendsTab'
import { KickbackMark, MinimizeIcon } from './components/Icons'
import {
  AccountCard,
  EmptyFriends,
  ErrorState,
  GroupsComingSoon,
  LoadingState,
  SignInCard,
} from './components/AuthStates'

type Tab = 'friends' | 'groups'

const COLLAPSED_KEY = 'kickback:collapsed'

/**
 * Panel open/closed survives navigation. Reading it synchronously (rather than
 * from chrome.storage) means the panel renders in the right state on the very
 * first frame after a page load, so navigating feels continuous.
 */
function readCollapsed(): boolean {
  try {
    return window.localStorage.getItem(COLLAPSED_KEY) === '1'
  } catch {
    return false
  }
}

function writeCollapsed(collapsed: boolean): void {
  try {
    window.localStorage.setItem(COLLAPSED_KEY, collapsed ? '1' : '0')
  } catch {
    // Storage can be unavailable; the panel just forgets its state.
  }
}

export function KickbackPanel({ client }: { client: KickbackClient }) {
  const view = useKickbackState(client)
  const [collapsed, setCollapsed] = useState(readCollapsed)
  const [tab, setTab] = useState<Tab>('friends')
  const [accountOpen, setAccountOpen] = useState(false)

  useEffect(() => writeCollapsed(collapsed), [collapsed])

  const { status, identity, friends, friendsHere, onlineCount, channel } = view
  const signedIn = status === 'signed_in'

  if (collapsed) {
    return (
      <button
        type="button"
        className="kb-launcher"
        title="Open Kickback"
        onClick={() => setCollapsed(false)}
      >
        <KickbackMark size={22} />
        {friendsHere.length > 0 && <span className="kb-launcher-badge">{friendsHere.length}</span>}
      </button>
    )
  }

  return (
    <div className="kb-panel">
      <div className="kb-header">
        <KickbackMark />
        <span className="kb-wordmark">kickback</span>
        {view.demo && <span className="kb-demo-badge">DEMO</span>}
        <span className="kb-header-spacer" />

        {signedIn && identity && (
          <button
            type="button"
            className="kb-avatar-btn"
            title={`Signed in as ${identity.displayName}`}
            onClick={() => setAccountOpen((open) => !open)}
          >
            <Avatar
              user={{
                id: identity.userId,
                username: identity.twitchLogin ?? identity.displayName,
                displayName: identity.displayName,
                accentColor: '#ff8452',
              }}
              avatarUrl={identity.avatarUrl}
              size={22}
              state="online"
              showDot={false}
            />
          </button>
        )}

        <button
          type="button"
          className="kb-icon-btn"
          title="Minimize Kickback"
          onClick={() => setCollapsed(true)}
        >
          <MinimizeIcon />
        </button>
      </div>

      {/* Local Twitch activity is read from the page, so it works signed out. */}
      <div className="kb-now">
        <span className="kb-now-label">{channel ? "You're watching" : 'Right now'}</span>
        {channel ? (
          <span className="kb-now-value">
            <span className="kb-live-dot" />
            {formatChannelName(channel)}
          </span>
        ) : (
          <span className="kb-now-idle">Browsing Twitch</span>
        )}
      </div>

      {signedIn && identity && accountOpen && (
        <AccountCard identity={identity} onSignOut={() => {
          setAccountOpen(false)
          client.signOut()
        }} />
      )}

      {status === 'loading' && <LoadingState />}

      {status === 'error' && (
        <ErrorState message={view.error ?? 'Something went wrong.'} onRetry={() => client.retry()} />
      )}

      {status === 'signed_out' && (
        <>
          {view.error && <div className="kb-inline-note">{view.error}</div>}
          <SignInCard onSignIn={() => client.signIn()} busy={view.signingIn} />
        </>
      )}

      {signedIn && (
        <>
          {friendsHere.length > 0 && (
            <div className="kb-here-banner">
              <div className="kb-avatar-stack">
                {friendsHere.slice(0, 4).map((friend) => (
                  <Avatar
                    key={friend.user.id}
                    user={friend.user}
                    size={20}
                    state="here"
                    showDot={false}
                  />
                ))}
              </div>
              <span className="kb-here-banner-text">
                {friendsHere.length === 1
                  ? `${friendsHere[0].user.displayName} is here`
                  : `${friendsHere.length} friends are here`}
              </span>
            </div>
          )}

          <div className="kb-tabs">
            <button
              type="button"
              className={`kb-tab${tab === 'friends' ? ' kb-tab-active' : ''}`}
              onClick={() => setTab('friends')}
            >
              Friends
              {friends.length > 0 && (
                <span className="kb-tab-count">
                  {onlineCount}/{friends.length}
                </span>
              )}
            </button>
            <button
              type="button"
              className={`kb-tab${tab === 'groups' ? ' kb-tab-active' : ''}`}
              onClick={() => setTab('groups')}
            >
              Groups
            </button>
          </div>

          <div className="kb-body">
            {tab === 'groups' ? (
              <GroupsComingSoon />
            ) : friends.length === 0 ? (
              <EmptyFriends />
            ) : (
              <FriendsTab friends={friends} localActivity={view.localActivity} />
            )}
          </div>
        </>
      )}

      <div className="kb-footer">
        <span>Kickback</span>
        <span className="kb-footer-dot" />
        <span>{view.demo ? 'demo mode — mock data' : 'Phase 1'}</span>
      </div>
    </div>
  )
}
