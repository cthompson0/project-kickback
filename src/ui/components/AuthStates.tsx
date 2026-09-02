import { useState } from 'react'
import { humanMessage } from '../../core/errors'
import type {
  KickbackClient,
  FeedbackCategory,
  KickbackIdentity,
  KickbackPreferences,
  PresenceVisibility,
  MeasurementReadiness,
} from '../../client/types'
import { BadgeShelf } from './BadgeShelf'
import { BackIcon, WatchsideMark } from './Icons'

/**
 * The states the panel can be in before it has any friends to show. Each one is
 * deliberately a single clear message and at most one action - signing in
 * should not feel like onboarding.
 */

/**
 * The first screen anybody sees, and the one that has to earn a Twitch
 * authorisation from somebody who has never heard of us.
 *
 * IT USED TO SAY "See who's around."
 *
 * Four words that mention neither Twitch, nor friends, nor watching - to a
 * person who arrived from a listing promising "see where your Twitch friends
 * are watching and jump into the stream with them", and who is about to be
 * asked to approve an authorisation. The zero-friend state one screen later was
 * rewritten carefully in M5A; this one, which comes FIRST, was never given the
 * same treatment.
 *
 * Still one message and one action - "signing in should not feel like
 * onboarding" is the right rule and this does not break it. What changed is
 * that the message is now about the product, and a quiet line answers the
 * question the next screen is about to raise: Twitch's consent page asks to
 * view the channels you follow, and a stranger who meets that with no
 * preparation is a stranger who cancels.
 */
export function SignInCard({ onSignIn, busy }: { onSignIn: () => void; busy: boolean }) {
  return (
    <div className="kb-signin">
      <WatchsideMark size={36} />
      <div className="kb-signin-title">Watchside</div>
      <div className="kb-signin-sub">
        See where your friends are watching on Twitch, and jump in.
      </div>
      <button type="button" className="kb-signin-btn" onClick={onSignIn} disabled={busy}>
        {busy ? 'Waiting for Twitch…' : 'Continue with Twitch'}
      </button>
      <div className="kb-signin-note">
        Sign in with Twitch so Watchside knows who you are. It never sees your
        password.
      </div>
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
      <div className="kb-quiet-title">Watchside is offline</div>
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

  /*
   * The first thing a brand-new account ever sees, and for a while the only
   * thing. It used to say the panel was quiet and that friends would show up -
   * true, and it never explained what would show up, or why anybody would want
   * it. Somebody who has just installed an extension they do not yet understand
   * needs the promise before the instruction.
   *
   * So: what Watchside does, then what it needs, then the way to give it that.
   * Three short lines rather than a walkthrough - the product is one panel and
   * it can afford to explain itself in place.
   */
  return (
    <div className="kb-quiet">
      <div className="kb-quiet-title">See where your friends are watching.</div>
      <div className="kb-quiet-sub">
        When a friend is watching someone on Twitch, they show up here and you
        can jump in and watch together.
      </div>
      <div className="kb-quiet-sub">Add a friend or two and it starts working.</div>
      <button type="button" className="kb-signin-btn kb-find-btn" onClick={onFindFriends}>
        Find friends
      </button>
    </div>
  )
}

/** Identity card behind the header avatar: who Watchside thinks you are. */
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
      <div className="kb-manage-scroll">
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
    </div>
  )
}

/**
 * Everyone this viewer has blocked, and the way back.
 *
 * Deliberately a SEPARATE list from Muted rather than one combined roster.
 * They are different promises - mute is a local preference about noise, block
 * is a server-enforced fact about the social graph - and a single list would
 * invite treating them as one thing. Hidden entirely when nobody is blocked.
 */
function BlockedPeople({
  blocked,
  onUnblock,
}: {
  blocked: readonly { user: { id: string; displayName: string } }[]
  onUnblock: (userId: string) => void
}) {
  if (blocked.length === 0) return null

  return (
    <div className="kb-muted-list">
      <div className="kb-section-label">Blocked · {blocked.length}</div>
      {/*
        * Bounded, so a long list scrolls instead of pushing Sign out off the
        * bottom of the panel. See .kb-manage-scroll - below the cap it looks
        * and behaves exactly as it did.
        */}
      <div className="kb-manage-scroll">
      {blocked.map((entry) => (
        <div className="kb-muted-row" key={entry.user.id}>
          <span className="kb-cluster-name">{entry.user.displayName}</span>
          {/*
            * No confirmation on the way back.
            *
            * Unblocking is not destructive: it removes the block and nothing
            * else - no friendship returns, no request is revived. If they want
            * to be friends again, somebody sends a request.
            */}
          <button
            type="button"
            className="kb-ghost-btn kb-ghost-btn-inline"
            onClick={() => onUnblock(entry.user.id)}
          >
            Unblock
          </button>
        </div>
      ))}
      </div>
    </div>
  )
}

/** How much somebody may write. Long enough for a paragraph and a repro. */
export const FEEDBACK_MAX_LENGTH = 2000

const CATEGORIES: Array<{ value: FeedbackCategory; label: string }> = [
  { value: 'bug', label: 'Bug' },
  { value: 'confusing', label: 'Confusing' },
  { value: 'idea', label: 'Idea' },
  { value: 'other', label: 'Other' },
]

/**
 * Tell us something, without leaving Twitch.
 *
 * Analytics say what people did; this is the only way they can say why. So it
 * is deliberately the smallest thing that works: pick one of four, type, send.
 *
 * Nothing is asked for that we can find out ourselves. No title, no severity,
 * no browser, no URL, no repro steps, no email - the service worker attaches
 * the version, the environment, the browser, the friend count, the channel and
 * whether realtime was healthy, which is most of what a first look needs and
 * none of what a person should have to type.
 */
export function FeedbackForm({
  onSubmit,
  onBack,
}: {
  onSubmit: (category: FeedbackCategory, body: string) => Promise<void>
  onBack: () => void
}) {
  const [category, setCategory] = useState<FeedbackCategory>('bug')
  const [body, setBody] = useState('')
  const [state, setState] = useState<'idle' | 'sending' | 'sent'>('idle')
  const [error, setError] = useState<string | null>(null)

  const trimmed = body.trim()

  const send = async () => {
    // One at a time. Without this, a slow network plus an impatient second
    // press is two identical reports.
    if (state === 'sending' || trimmed.length === 0) return
    setState('sending')
    setError(null)
    try {
      await onSubmit(category, trimmed)
      /*
       * The text is cleared only once it is definitely gone.
       *
       * On failure it stays exactly as typed - somebody who has just written
       * three paragraphs about a bug must not lose them to a dropped
       * connection, which is the moment they are most likely to be writing.
       */
      setBody('')
      setState('sent')
    } catch (cause: unknown) {
      setState('idle')
      setError(humanMessage(cause, 'Could not send that. Try again.'))
    }
  }

  if (state === 'sent') {
    return (
      <div className="kb-feedback">
        <div className="kb-detail-head">
          <button type="button" className="kb-back" onClick={onBack} title="Back to account">
            <BackIcon />
          </button>
          <div className="kb-group-name">Feedback</div>
        </div>
        {/* Small and done. A celebration would be a second thing to dismiss. */}
        <div className="kb-quiet-sub kb-feedback-sent">Thanks — feedback sent.</div>
        <button type="button" className="kb-ghost-btn" onClick={() => setState('idle')}>
          Send something else
        </button>
      </div>
    )
  }

  return (
    <div className="kb-feedback">
      <div className="kb-detail-head">
        <button type="button" className="kb-back" onClick={onBack} title="Back to account">
          <BackIcon />
        </button>
        <div className="kb-group-name">Feedback</div>
      </div>

      <div className="kb-feedback-cats" role="group" aria-label="What kind of feedback">
        {CATEGORIES.map((option) => (
          <button
            key={option.value}
            type="button"
            className={`kb-presence-option${
              category === option.value ? ' kb-presence-option-active' : ''
            }`}
            aria-pressed={category === option.value}
            onClick={() => setCategory(option.value)}
          >
            {option.label}
          </button>
        ))}
      </div>

      <textarea
        className="kb-feedback-text"
        value={body}
        maxLength={FEEDBACK_MAX_LENGTH}
        rows={5}
        placeholder="What happened?"
        aria-label="Your feedback"
        onChange={(event) => setBody(event.target.value)}
      />

      {error && <div className="kb-inline-note">{error}</div>}

      <div className="kb-usercard-actions">
        <button
          type="button"
          className="kb-signin-btn kb-feedback-send"
          disabled={state === 'sending' || trimmed.length === 0}
          onClick={() => void send()}
        >
          {state === 'sending' ? 'Sending…' : 'Send'}
        </button>
        <button type="button" className="kb-ghost-btn kb-ghost-btn-inline" onClick={onBack}>
          Cancel
        </button>
      </div>
    </div>
  )
}

/**
 * The account-panel control that adds `user:read:follows` to a credential which
 * predates it.
 *
 * WHY IT IS SMALL
 *
 * Because it is not the product. New authorizations request the scope on the
 * ordinary Twitch consent screen, so for anybody who joins Watchside from here
 * on there is nothing to grant and this renders nothing at all.
 *
 * It exists for the pre-M3D beta accounts - a cohort of roughly three, which
 * only shrinks - and for the rare person whose authorization returned without
 * the scope and who later wants it. A one-time migration for three people does
 * not earn prompts, dismissal state, or a place on the main surface; it earns
 * one honest control somewhere stable. This is that control.
 *
 * An earlier version put an automatic invitation on the panel body and tracked
 * whether it had been waved away. That machinery existed solely to migrate this
 * cohort, and it was removed rather than debugged.
 *
 * WHAT IT DOES NOT SAY
 *
 * That Watchside needs it. It does not: everything works without it, and the
 * copy never implies otherwise.
 */
function MeasurementPermission({
  client,
  readiness,
}: {
  client: KickbackClient
  readiness: MeasurementReadiness | null
}) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  /*
   * One state is offered the control, and the exclusions are the point:
   *
   *   ready                    nothing to grant
   *   needs_reauthorization    genuinely broken; an optional-permission story
   *                            would send them down entirely the wrong path
   *   temporarily_unavailable  Watchside's problem, not theirs
   *   null                     we could not ask the server, which is not the
   *                            same as "not permitted"
   */
  if (readiness !== 'needs_follow_permission') return null

  const grant = (): void => {
    setBusy(true)
    setError(null)
    client
      .grantFollowPermission()
      .then((result) => {
        setBusy(false)
        // A declined or cancelled request reports no error, because nothing
        // went wrong - somebody simply said no.
        if (!result.ok && result.error) setError(result.error)
      })
      .catch(() => {
        setBusy(false)
        setError('Watchside could not reach Twitch just then.')
      })
  }

  return (
    <div className="kb-permission">
      <p>
        Watchside can check whether you already follow a creator when you join
        them through a friend. It is how we find out whether friends actually
        help people discover creators they did not already watch.
      </p>
      <p className="kb-permission-note">
        Optional. Everything in Watchside works without it, and it never changes
        who you follow.
      </p>
      {error && <p className="kb-danger-error">{error}</p>}
      <div className="kb-danger-actions">
        <button type="button" className="kb-signin-btn" disabled={busy} onClick={grant}>
          {busy ? 'Opening Twitch…' : 'Allow on Twitch'}
        </button>
      </div>
    </div>
  )
}

/**
 * The one control in this panel that cannot be undone.
 *
 * Deliberately not a single button. Deleting an account destroys the social
 * graph somebody built - their friends, groups, invites and history - and none
 * of it can be restored, so the flow asks them to type their Twitch login
 * rather than accept a click that could have been a mis-tap.
 *
 * The confirmation is a real check rather than theatre: the button stays
 * disabled until the typed text matches, which makes it impossible to complete
 * without reading what is being asked.
 *
 * Sign-out is next to this and does something completely different - it ends a
 * session and deletes nothing. Keeping them visually distinct is the point.
 */
function DeleteAccountSection({
  client,
  login,
  onDeleted,
}: {
  client: KickbackClient
  /** Nullable: an account can exist without a Twitch login on it. */
  login: string | null
  onDeleted: () => void
}) {
  const [open, setOpen] = useState(false)
  const [typed, setTyped] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // Something specific to type, even for an account with no login recorded.
  const phrase = login ?? 'DELETE'
  const matches = typed.trim().toLowerCase() === phrase.toLowerCase()

  if (!open) {
    return (
      <button
        type="button"
        className="kb-danger-btn"
        onClick={() => {
          setOpen(true)
          setTyped('')
          setError(null)
        }}
      >
        Delete account
      </button>
    )
  }

  return (
    <div className="kb-danger-confirm">
      <p>
        This permanently deletes your Watchside account: your friends, groups,
        invites, messages and history. It cannot be undone, and it does not
        affect your Twitch account.
      </p>
      <p>
        Type <strong>{phrase}</strong> to confirm.
      </p>
      <input
        type="text"
        value={typed}
        disabled={busy}
        aria-label="Type your Twitch login to confirm"
        onChange={(event) => setTyped(event.target.value)}
      />
      {error && <p className="kb-danger-error">{error}</p>}
      <div className="kb-danger-actions">
        <button
          type="button"
          className="kb-danger-btn"
          disabled={!matches || busy}
          onClick={() => {
            setBusy(true)
            setError(null)
            client
              .deleteAccount()
              .then((result) => {
                if (result.ok) {
                  onDeleted()
                  return
                }
                // Never report a failure as success: the account still exists
                // and they need to be able to try again.
                setBusy(false)
                setError(result.error ?? 'Watchside could not delete your account.')
              })
              .catch((cause: unknown) => {
                setBusy(false)
                setError(humanMessage(cause, 'Something went wrong.'))
              })
          }}
        >
          {busy ? 'Deleting…' : 'Delete permanently'}
        </button>
        <button
          type="button"
          className="kb-ghost-btn kb-ghost-btn-inline"
          disabled={busy}
          onClick={() => setOpen(false)}
        >
          Cancel
        </button>
      </div>
    </div>
  )
}

export function AccountCard({
  identity,
  onSignOut,
  onDeleted,
  measurementReadiness,
  onVisibilityChange,
  preferences,
  onPreferencesChange,
  onResetLayout,
  mutedUserIds,
  knownPeople,
  onUnmute,
  blocked,
  onUnblock,
  onClose,
  onFeedback,
  client,
}: {
  identity: KickbackIdentity
  onSignOut: () => void
  onDeleted: () => void
  measurementReadiness: MeasurementReadiness | null
  onVisibilityChange: (mode: PresenceVisibility) => void
  preferences: KickbackPreferences
  onPreferencesChange: (patch: Partial<KickbackPreferences>) => void
  /** Back to the default position and size, without clearing storage by hand. */
  onResetLayout: () => void
  /** Local mutes, and the one place they can be reversed. */
  mutedUserIds: readonly string[]
  knownPeople: readonly { id: string; displayName: string }[]
  onUnmute: (userId: string) => void
  /** Server-enforced blocks, listed separately from the local mutes. */
  blocked: readonly { user: { id: string; displayName: string } }[]
  onUnblock: (userId: string) => void
  /**
   * Dismisses the panel, and does nothing else.
   *
   * Not sign out, not reset layout, not any account change - closing a settings
   * view should be the one action in it that cannot cost you anything.
   */
  onClose: () => void
  /** For the badge shelf, which reads and equips through the worker. */
  client: KickbackClient
  /** Opens the feedback form. Secondary action, so it lives here. */
  onFeedback: () => void
}) {
  const [copied, setCopied] = useState(false)
  const [busy, setBusy] = useState(false)

  return (
    <div className="kb-account">
      {/*
        * The way out, where people already look for it.
        *
        * The panel opens from the avatar in the header and used to close only by
        * pressing that avatar again - which nobody finds, because nothing on
        * screen says the avatar is a toggle. Escape closes it too; this is the
        * discoverable half of the same door.
        */}
      <div className="kb-account-head">
        <span className="kb-account-title">Account</span>
        <button
          type="button"
          className="kb-account-close"
          aria-label="Close account panel"
          onClick={onClose}
        >
          <span aria-hidden="true">&times;</span>
        </button>
      </div>
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
        {/*
          * Two different things, and only one of them is ours.
          *
          * This switch is Watchside's preference. Whether a notification ever
          * reaches the screen is the browser's and the operating system's
          * decision, and Watchside cannot see or change it - so the honest
          * thing is to say where the other half lives rather than let the
          * switch imply a guarantee it cannot make.
          */}
        {preferences.gatheringNotifications && (
          <div className="kb-presence-hint kb-hint-quiet">
            Your browser has to allow them too.{' '}
            <a
              className="kb-inline-link"
              href="https://anoteros-labs.github.io/watchside/support/"
              target="_blank"
              rel="noreferrer noopener"
            >
              If none arrive
            </a>
          </div>
        )}
      </div>

      <MutedPeople mutedUserIds={mutedUserIds} people={knownPeople} onUnmute={onUnmute} />

      <BlockedPeople blocked={blocked} onUnblock={onUnblock} />

      <button type="button" className="kb-ghost-btn" onClick={onResetLayout}>
        Reset layout
      </button>

      {/*
        * Feedback lives here rather than on Gravity or in the nav.
        *
        * It is a secondary action people reach for occasionally, and a
        * permanent button on the main surface would take space from the thing
        * the product is actually for. The account panel is where the other
        * "about Watchside rather than about your friends" controls already are.
        */}
      <button type="button" className="kb-ghost-btn" onClick={onFeedback}>
        Feedback
      </button>

      {/*
        * Support, beside Feedback rather than anywhere louder.
        *
        * Feedback is the better route while Watchside is working - it attaches
        * the version and a little context automatically. Support is the page
        * that still exists when the panel does not, which is why it is a link
        * to somewhere outside rather than another panel view.
        */}
      <a
        className="kb-ghost-btn kb-ghost-link"
        href="https://anoteros-labs.github.io/watchside/support/"
        target="_blank"
        rel="noreferrer noopener"
      >
        Support
      </a>

      <MeasurementPermission client={client} readiness={measurementReadiness} />

      <button type="button" className="kb-ghost-btn" onClick={onSignOut}>
        Sign out
      </button>

      <DeleteAccountSection
        client={client}
        login={identity.twitchLogin}
        onDeleted={onDeleted}
      />

      {/*
        * Which build is this?
        *
        * The panel footer already carries the version, but the footer is easy
        * to miss and is replaced by the layout hint on a first run - so the
        * one question we actually ask testers, "what version are you running",
        * had no reliable answer. This is that answer, in the place somebody
        * looks when they are being asked about their own setup.
        *
        * __KICKBACK_VERSION__ is the build-time constant every config defines
        * from public/manifest.json, so there is exactly one version in the
        * repository and this cannot drift from what Chrome reports.
        *
        * Deliberately nothing else: no ids, no channel, no session, no
        * diagnostics. Those belong in Feedback, which assembles them in the
        * service worker and sends them deliberately.
        */}
      {/*
        * Earned badges, above the version line.
        *
        * The account panel is where a person already goes to see who they are
        * in Watchside, so it is where a badge they earned should be waiting -
        * rather than a new screen nobody opens twice.
        */}
      <BadgeShelf client={client} />

      <div className="kb-account-version">Watchside v{__KICKBACK_VERSION__}</div>
    </div>
  )
}
