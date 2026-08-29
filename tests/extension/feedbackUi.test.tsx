import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { KickbackClient } from '../../src/client/types'
import { renderToStaticMarkup } from 'react-dom/server'
import { AccountCard, FeedbackForm, FEEDBACK_MAX_LENGTH } from '../../src/ui/components/AuthStates'
import { EVENT_PROPERTIES } from '../../src/core/analytics'

/**
 * The feedback form, and the promises around it.
 *
 * What the server does with a submission is asserted against real Postgres in
 * tests/db/feedback.test.ts - the whitelist, the refusals, the fact that nobody
 * can read anybody's feedback including their own. None of that is repeated
 * here.
 *
 * What is pinned here is the part the server cannot see: that the form asks for
 * almost nothing, that it is reachable from the one place it should be and from
 * nowhere else, and that the pipeline which must never carry free text still
 * cannot.
 */

const IDENTITY = {
  userId: 'me',
  displayName: 'MySelf',
  twitchLogin: 'myself',
  friendCode: 'ABC123',
  avatarUrl: null,
  presenceVisibility: 'visible' as const,
}

function installWindow() {
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: {
      innerWidth: 1600,
      innerHeight: 900,
      location: { pathname: '/lirik', href: 'https://www.twitch.tv/lirik' },
      addEventListener: () => {},
      removeEventListener: () => {},
      matchMedia: () => ({
        matches: false,
        addEventListener: () => {},
        removeEventListener: () => {},
      }),
    },
  })
  Object.defineProperty(globalThis, 'document', {
    configurable: true,
    value: {
      querySelector: () => null,
      addEventListener: () => {},
      removeEventListener: () => {},
    },
  })
}

const form = () =>
  renderToStaticMarkup(<FeedbackForm onSubmit={async () => {}} onBack={() => {}} />)

function account(calls: string[] = []) {
  installWindow()
  return renderToStaticMarkup(
    <AccountCard
      // The badge shelf reads through the client; an empty one renders nothing.
      client={{ badges: async () => [] } as unknown as KickbackClient}
      identity={IDENTITY}
      onSignOut={() => calls.push('signOut')}
      onVisibilityChange={() => calls.push('visibility')}
      preferences={{ gatheringNotifications: true }}
      onPreferencesChange={() => calls.push('preferences')}
      mutedUserIds={[]}
      knownPeople={[]}
      onUnmute={() => calls.push('unmute')}
      blocked={[]}
      onUnblock={() => calls.push('unblock')}
      onFeedback={() => calls.push('feedback')}
      onClose={() => calls.push('close')}
      onResetLayout={() => calls.push('reset')}
    />,
  )
}

// ---------------------------------------------------------------- the form

describe('the feedback form', () => {
  it('offers four categories and nothing to think about beyond them', () => {
    const html = form()
    for (const label of ['Bug', 'Confusing', 'Idea', 'Other']) {
      expect(html).toContain(`>${label}<`)
    }
  })

  it('asks for nothing it could find out itself', () => {
    /*
     * The point of a feedback form somebody actually uses. Title, severity,
     * browser, URL, repro steps and email are all either derivable by the
     * service worker or not worth the friction of asking for.
     */
    const html = form()
    for (const field of ['Title', 'Severity', 'Browser', 'URL', 'Steps', 'Email', 'Username']) {
      expect(html).not.toContain(field)
    }
    // One text area, and that is the whole input surface.
    expect((html.match(/<textarea/g) ?? []).length).toBe(1)
    expect(html).not.toContain('<input')
  })

  it('bounds what can be typed, and agrees with the server about the number', () => {
    expect(FEEDBACK_MAX_LENGTH).toBe(2000)
    expect(form()).toContain(`maxLength="${FEEDBACK_MAX_LENGTH}"`)

    // The database is the authority, and a disagreement would mean a silent
    // truncation on one side or a rejection the user cannot see coming.
    const sql = readFileSync(
      join(process.cwd(), 'supabase', 'migrations', '0023_feedback.sql'),
      'utf8',
    )
    expect(sql).toContain('char_length(body) between 1 and 2000')
  })

  it('cannot be submitted empty', () => {
    // Nothing typed yet, so Send is not a thing you can press.
    expect(form()).toMatch(/<button[^>]*disabled[^>]*>Send<\/button>/)
  })

  it('offers a way out that is not sending', () => {
    const html = form()
    expect(html).toContain('Cancel')
    expect(html).toContain('kb-back')
  })

  it('keeps what was typed when sending fails', () => {
    /*
     * The moment somebody is most likely to be writing three paragraphs is the
     * moment something is broken - which is also the moment the network is most
     * likely to drop the submission. Losing their text there would lose the
     * report.
     */
    const source = readFileSync(
      join(process.cwd(), 'src', 'ui', 'components', 'AuthStates.tsx'),
      'utf8',
    )
    const send = source.slice(source.indexOf('const send = async ()'))
    // The body is cleared only after the await resolves, never in the catch.
    expect(send.indexOf("setBody('')")).toBeLessThan(send.indexOf('catch'))
    expect(send.slice(send.indexOf('catch'), send.indexOf('catch') + 400)).not.toContain('setBody')
  })

  it('will not send the same thing twice while one is in flight', () => {
    const source = readFileSync(
      join(process.cwd(), 'src', 'ui', 'components', 'AuthStates.tsx'),
      'utf8',
    )
    expect(source).toContain("if (state === 'sending'")
  })
})

// ------------------------------------------------------------ where it lives

describe('where feedback is reached from', () => {
  it('is in the account panel', () => {
    expect(account()).toContain('>Feedback<')
  })

  it('changes nothing by being there', () => {
    const calls: string[] = []
    account(calls)
    expect(calls).toEqual([])
  })

  it('is not on Gravity, the tabs, or anywhere else permanent', () => {
    /*
     * A permanent feedback button on the main surface would take space from the
     * thing the product is for. The account panel is where the other "about
     * Kickback rather than about your friends" controls already are.
     */
    for (const file of ['SocialGravity.tsx', 'FriendsTab.tsx', 'PersonRow.tsx', 'UserCard.tsx']) {
      const source = readFileSync(
        join(process.cwd(), 'src', 'ui', 'components', file),
        'utf8',
      )
      expect(source).not.toContain('Feedback')
    }
    const panel = readFileSync(join(process.cwd(), 'src', 'ui', 'KickbackPanel.tsx'), 'utf8')
    // The panel only routes it; the tab row never draws it.
    expect(panel).not.toMatch(/kb-tab[^\n]*Feedback/)
  })
})

// ---------------------------------------------------------------- privacy

describe('what feedback puts into analytics', () => {
  it('records the category and nothing else', () => {
    expect(EVENT_PROPERTIES.feedback_submitted).toEqual(['category'])
  })

  it('agrees with the contract the database enforces', () => {
    // The server strips anything not listed, so a disagreement here is a
    // property that silently never arrives.
    const sql = readFileSync(
      join(process.cwd(), 'supabase', 'migrations', '0023_feedback.sql'),
      'utf8',
    )
    expect(sql).toContain("('feedback_submitted'")
    expect(sql).toContain("array['category']")
  })

  it('never routes the body through analytics', () => {
    /*
     * analytics_events is built on the promise that it cannot contain free
     * text - 64-character values, unknown keys dropped on both sides. Feedback
     * is the one thing in Kickback that IS free text, so it goes to its own
     * table and analytics learns only that it happened.
     */
    const worker = readFileSync(join(process.cwd(), 'src', 'background', 'index.ts'), 'utf8')
    const call = worker.slice(
      worker.indexOf("analytics.track('feedback_submitted'"),
      worker.indexOf("analytics.track('feedback_submitted'") + 200,
    )
    expect(call).not.toContain('body')
  })
})

// ------------------------------------------------- the diagnostic context

describe('the context attached to a submission', () => {
  const worker = readFileSync(join(process.cwd(), 'src', 'background', 'index.ts'), 'utf8')
  const block = worker.slice(
    worker.indexOf('submitFeedback: async'),
    worker.indexOf("analytics.track('feedback_submitted'"),
  )

  it('is assembled by the worker, not accepted from the panel', () => {
    /*
     * The panel knows which tab was open and whether it was collapsed. It does
     * not know whether realtime was healthy, and a client that reported its own
     * connection state could report a healthy one while sitting on a broken
     * one - which is the opposite of what a diagnostic is for.
     */
    expect(block).toContain('socialSync.getStatus()')
    expect(block).toContain('presenceSync.getStatus()')
    expect(block).toContain('friendsState.friends.length')
    expect(block).toContain('currentChannel()')
    // Only two things are taken from the client, and both are bounded.
    expect(block).toContain('input.surface')
    expect(block).toContain('input.collapsed')
  })

  it('attaches nothing it must not', () => {
    for (const forbidden of [
      'access_token',
      'provider_token',
      'session.',
      'cookie',
      'roomMessages',
      'groupMessages',
      'mutedUserIds',
      'blockedUsers',
      'localStorage',
      'chrome.storage',
    ]) {
      expect(block).not.toContain(forbidden)
    }
  })

  it('sends identities as counts, never as rosters', () => {
    // "Four friends" is a diagnostic. "These four friends" is a social graph
    // dump attached to a support message.
    expect(block).toContain('friend_count')
    expect(block).not.toMatch(/friends\.map|friends\.filter/)
  })
})
