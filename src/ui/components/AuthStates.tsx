import type { KickbackIdentity } from '../../client/types'
import { KickbackMark } from './Icons'

/**
 * The states the panel can be in before it has any friends to show. Each one is
 * deliberately a single clear message and at most one action - signing in
 * should not feel like onboarding.
 */

export function SignInCard({ onSignIn, busy }: { onSignIn: () => void; busy: boolean }) {
  return (
    <div className="kb-signin">
      <KickbackMark size={34} />
      <div className="kb-signin-title">Kickback</div>
      <div className="kb-signin-sub">See who&rsquo;s around.</div>
      <button type="button" className="kb-signin-btn" onClick={onSignIn} disabled={busy}>
        {busy ? 'Waiting for Twitch…' : 'Continue with Twitch'}
      </button>
    </div>
  )
}

export function LoadingState() {
  return (
    <div className="kb-quiet">
      <div className="kb-quiet-title">Connecting&hellip;</div>
    </div>
  )
}

export function ErrorState({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <div className="kb-quiet">
      <div className="kb-quiet-title">Kickback is offline</div>
      <div className="kb-quiet-sub">{message}</div>
      <button type="button" className="kb-ghost-btn" onClick={onRetry}>
        Try again
      </button>
    </div>
  )
}

export function EmptyFriends() {
  return (
    <div className="kb-quiet">
      <div className="kb-quiet-title">Your Kickback is quiet.</div>
      <div className="kb-quiet-sub">Your friends will show up here once you add them.</div>
    </div>
  )
}

export function GroupsComingSoon() {
  return (
    <div className="kb-quiet">
      <div className="kb-quiet-title">Groups are coming.</div>
      <div className="kb-quiet-sub">
        Somewhere for your people to gather. Not built yet.
      </div>
    </div>
  )
}

/** Identity card behind the header avatar: who Kickback thinks you are. */
export function AccountCard({
  identity,
  onSignOut,
}: {
  identity: KickbackIdentity
  onSignOut: () => void
}) {
  return (
    <div className="kb-account">
      <div className="kb-account-row">
        <span className="kb-account-label">Signed in as</span>
        <span className="kb-account-value">{identity.displayName}</span>
      </div>
      {identity.twitchLogin && (
        <div className="kb-account-row">
          <span className="kb-account-label">Twitch</span>
          <span className="kb-account-value">@{identity.twitchLogin}</span>
        </div>
      )}
      <div className="kb-account-row">
        <span className="kb-account-label">Friend code</span>
        <span className="kb-account-value kb-mono">{identity.friendCode}</span>
      </div>
      <button type="button" className="kb-ghost-btn" onClick={onSignOut}>
        Sign out
      </button>
    </div>
  )
}
