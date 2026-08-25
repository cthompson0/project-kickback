import { useState } from 'react'
import type {
  KickbackIdentity,
  KickbackPreferences,
  PresenceVisibility,
} from '../../client/types'
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

export function EmptyFriends({
  loading,
  onFindFriends,
}: {
  loading: boolean
  onFindFriends: () => void
}) {
  if (loading) {
    return (
      <div className="kb-quiet">
        <div className="kb-quiet-sub">Loading your friends&hellip;</div>
      </div>
    )
  }

  return (
    <div className="kb-quiet">
      <div className="kb-quiet-title">Your Kickback is quiet.</div>
      <div className="kb-quiet-sub">Your friends will show up here once you add them.</div>
      <button type="button" className="kb-signin-btn kb-find-btn" onClick={onFindFriends}>
        Find friends
      </button>
    </div>
  )
}

/** Identity card behind the header avatar: who Kickback thinks you are. */
const VISIBILITY_OPTIONS: Array<{
  value: PresenceVisibility
  label: string
  hint: string
}> = [
  { value: 'visible', label: 'Visible', hint: 'Friends see what you are watching' },
  { value: 'hide_activity', label: 'Hide activity', hint: 'Friends see you are around' },
  { value: 'invisible', label: 'Invisible', hint: 'Friends see you as offline' },
]

/**
 * Everyone this viewer has muted, and the way back.
 *
 * A mute you cannot find is a mute you cannot undo, so this exists for exactly
 * one reason: to be the discoverable place that reverses it. Hidden entirely
 * when nobody is muted - an empty list is a setting nobody needs to read.
 */
function MutedPeople({
  mutedUserIds,
  people,
  onUnmute,
}: {
  mutedUserIds: readonly string[]
  /** Everyone the panel can name, so a muted person is not just an id. */
  people: readonly { id: string; displayName: string }[]
  onUnmute: (userId: string) => void
}) {
  if (mutedUserIds.length === 0) return null

  const nameOf = (userId: string) =>
    people.find((person) => person.id === userId)?.displayName ?? 'Someone'

  return (
    <div className="kb-muted-list">
      <div className="kb-section-label">Muted · {mutedUserIds.length}</div>
      {mutedUserIds.map((userId) => (
        <div className="kb-muted-row" key={userId}>
          <span className="kb-cluster-name">{nameOf(userId)}</span>
          <button
            type="button"
            className="kb-ghost-btn kb-ghost-btn-inline"
            onClick={() => onUnmute(userId)}
          >
            Unmute
          </button>
        </div>
      ))}
    </div>
  )
}

export function AccountCard({
  identity,
  onSignOut,
  onVisibilityChange,
  preferences,
  onPreferencesChange,
  onResetLayout,
  mutedUserIds,
  knownPeople,
  onUnmute,
}: {
  identity: KickbackIdentity
  onSignOut: () => void
  onVisibilityChange: (mode: PresenceVisibility) => void
  preferences: KickbackPreferences
  onPreferencesChange: (patch: Partial<KickbackPreferences>) => void
  /** Back to the default position and size, without clearing storage by hand. */
  onResetLayout: () => void
  /** Local mutes, and the one place they can be reversed. */
  mutedUserIds: readonly string[]
  knownPeople: readonly { id: string; displayName: string }[]
  onUnmute: (userId: string) => void
}) {
  const [copied, setCopied] = useState(false)
  const [busy, setBusy] = useState(false)

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
        <button
          type="button"
          className="kb-account-value kb-mono kb-copy"
          title="Copy your friend code"
          onClick={() => {
            navigator.clipboard
              ?.writeText(identity.friendCode)
              .then(() => {
                setCopied(true)
                window.setTimeout(() => setCopied(false), 1500)
              })
              .catch(() => setCopied(false))
          }}
        >
          {copied ? 'Copied!' : identity.friendCode}
        </button>
      </div>
      <div className="kb-presence-picker">
        <div className="kb-account-label">Presence</div>
        <div className="kb-presence-options">
          {VISIBILITY_OPTIONS.map((option) => (
            <button
              key={option.value}
              type="button"
              className={`kb-presence-option${
                identity.presenceVisibility === option.value ? ' kb-presence-option-active' : ''
              }`}
              title={option.hint}
              disabled={busy}
              onClick={() => {
                if (identity.presenceVisibility === option.value) return
                setBusy(true)
                onVisibilityChange(option.value)
                window.setTimeout(() => setBusy(false), 600)
              }}
            >
              {option.label}
            </button>
          ))}
        </div>
        <div className="kb-presence-hint">
          {VISIBILITY_OPTIONS.find((option) => option.value === identity.presenceVisibility)?.hint}
        </div>
      </div>

      <div className="kb-presence-picker">
        <button
          type="button"
          className="kb-toggle-row"
          onClick={() =>
            onPreferencesChange({ gatheringNotifications: !preferences.gatheringNotifications })
          }
        >
          <span className="kb-account-label">Gathering alerts</span>
          <span
            className={`kb-toggle${preferences.gatheringNotifications ? ' kb-toggle-on' : ''}`}
            aria-hidden="true"
          >
            <span className="kb-toggle-knob" />
          </span>
        </button>
        <div className="kb-presence-hint">
          {preferences.gatheringNotifications
            ? 'Desktop alert when friends gather on a channel'
            : 'No desktop alerts'}
        </div>
      </div>

      <MutedPeople mutedUserIds={mutedUserIds} people={knownPeople} onUnmute={onUnmute} />

      <button type="button" className="kb-ghost-btn" onClick={onResetLayout}>
        Reset layout
      </button>

      <button type="button" className="kb-ghost-btn" onClick={onSignOut}>
        Sign out
      </button>
    </div>
  )
}
