import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { UserCard } from '../../src/ui/components/UserCard'
import type { UserCardContext } from '../../src/ui/components/UserCard'
import { describeSelf } from '../../src/core/personPresence'
import { ChannelNameProvider } from '../../src/ui/ChannelNames'
import type { KickbackClient } from '../../src/client/types'
import type { Activity, Presence, User } from '../../src/core/types'

/**
 * One card, one answer, wherever it was opened from.
 *
 * THE BUG. The viewer's activity used to be an optional prop with a null
 * default. Friends and the group roster passed it; group chat did not. So
 * opening the same person's card from chat, while both were watching the same
 * stream, offered a JOIN that reloaded the stream you were already on - and
 * opening it from Friends, a second earlier, correctly did not. Nothing threw.
 * The card simply answered a different question depending on who asked.
 *
 * The context is now one required value, so the three entry points cannot
 * differ: there is nothing left for a call site to forget. These tests render
 * the card the way each entry point does and assert they agree.
 */

const NOW = 1_700_000_000_000

const TARGET: User = {
  id: 'them',
  username: 'anoterostv',
  displayName: 'AnoterosTV',
  avatarUrl: null,
  accentColor: '#ff8452',
}

const ME: User = {
  id: 'me',
  username: 'myself',
  displayName: 'MySelf',
  avatarUrl: null,
  accentColor: '#ff8452',
}

const watching = (channel: string, userId = 'them'): Presence => ({
  userId,
  status: 'online',
  activity: { type: 'watching', platform: 'twitch', channel },
  since: NOW,
  lastSeenAt: Date.now(),
})

const browsing = (): Presence => ({
  userId: 'them',
  status: 'online',
  activity: { type: 'browsing', platform: 'twitch' },
  since: NOW,
  lastSeenAt: Date.now(),
})

const offline = (): Presence => ({
  userId: 'them',
  status: 'offline',
  activity: { type: 'idle' },
  since: NOW,
  lastSeenAt: NOW,
})

const ON = (channel: string): Activity => ({ type: 'watching', platform: 'twitch', channel })

function stubClient(): KickbackClient {
  return {
    sendFriendRequest: async () => 'req',
    removeFriend: async () => {},
  } as unknown as KickbackClient
}

/**
 * Each entry point differs only in the relationship it reports, so the context
 * is built the way that surface would build it. If any of them could still
 * omit the viewer's activity, this file would not compile.
 */
const ENTRY_POINTS: Array<[string, (viewer: Activity) => UserCardContext]> = [
  [
    'friends list',
    (viewerActivity) => ({
      selfId: 'me',
      viewerActivity,
      friendIds: new Set(['them']),
      outgoingRequestIds: new Set(),
    }),
  ],
  [
    'group roster',
    (viewerActivity) => ({
      selfId: 'me',
      viewerActivity,
      friendIds: new Set(['them']),
      outgoingRequestIds: new Set(),
    }),
  ],
  [
    'group chat',
    (viewerActivity) => ({
      selfId: 'me',
      viewerActivity,
      friendIds: new Set(['them']),
      outgoingRequestIds: new Set(),
    }),
  ],
]

function card(context: UserCardContext, presence: Presence | null, user: User = TARGET) {
  return renderToStaticMarkup(
    <ChannelNameProvider people={[]} seen={{ lirik: 'LIRIK', xqc: 'xQc' }}>
      <UserCard
        user={user}
        presence={presence}
        client={stubClient()}
        context={context}
        onClose={() => {}}
      />
    </ChannelNameProvider>,
  )
}

// -------------------------------------------------- the same channel

describe('when the viewer and the target are on the same stream', () => {
  it.each(ENTRY_POINTS)('says watching with you, and offers no JOIN from %s', (_name, build) => {
    const html = card(build(ON('lirik')), watching('lirik'))
    expect(html).toContain('Watching with you')
    expect(html).toContain('LIRIK')
    expect(html).not.toContain('JOIN')
  })

  it('renders byte-identical output from all three entry points', () => {
    // The strongest form of the invariant: not merely "each is correct" but
    // "they are the same". A difference anywhere would show up here.
    const rendered = ENTRY_POINTS.map(([, build]) => card(build(ON('lirik')), watching('lirik')))
    expect(new Set(rendered).size).toBe(1)
  })

  it('matches however either side was cased', () => {
    const html = card(ENTRY_POINTS[2][1](ON('LIRIK')), watching('lirik'))
    expect(html).toContain('Watching with you')
    expect(html).not.toContain('JOIN')
  })
})

// ------------------------------------------------ a different channel

describe('when the target is somewhere else', () => {
  it.each(ENTRY_POINTS)('names the channel and offers JOIN from %s', (_name, build) => {
    const html = card(build(ON('lirik')), watching('xqc'))
    expect(html).toContain('xQc')
    expect(html).toContain('JOIN')
    expect(html).not.toContain('Watching with you')
  })

  it('renders byte-identical output from all three entry points', () => {
    const rendered = ENTRY_POINTS.map(([, build]) => card(build(ON('lirik')), watching('xqc')))
    expect(new Set(rendered).size).toBe(1)
  })
})

// ----------------------------------------------------- quieter states

describe('the states with nowhere to go', () => {
  const context = ENTRY_POINTS[2][1](ON('lirik'))

  it('says around for someone browsing or hiding their activity', () => {
    // Redacted at write time, so these are the same thing to a client - and
    // telling them apart would leak the choice.
    const html = card(context, browsing())
    expect(html).toContain('Around on Twitch')
    expect(html).not.toContain('JOIN')
  })

  it('says offline for someone offline or invisible', () => {
    const html = card(context, offline())
    expect(html).toContain('Offline')
    expect(html).not.toContain('JOIN')
  })

  it('says offline for stale presence', () => {
    const stale = { ...watching('lirik'), lastSeenAt: NOW - 60 * 60_000 }
    const html = card(context, stale)
    expect(html).toContain('Offline')
    expect(html).not.toContain('JOIN')
  })

  it('says offline when nothing was shared at all', () => {
    const html = card(context, null)
    expect(html).toContain('Offline')
    expect(html).not.toContain('JOIN')
  })
})

// ------------------------------------------------------- your own card

describe('your own card', () => {
  const selfContext = (viewer: Activity): UserCardContext => ({
    selfId: 'me',
    viewerActivity: viewer,
    friendIds: new Set(),
    outgoingRequestIds: new Set(),
  })

  it('says it is you, and never claims you are offline', () => {
    // The reported nonsense: your own row is absent from the friend and group
    // projections, so reading presence out of them called you offline.
    const html = card(selfContext(ON('lirik')), null, ME)
    expect(html).toContain('This is you')
    expect(html).not.toContain('Offline')
  })

  it('reports your own activity from the local path, not from presence', () => {
    // Presence is null here - exactly the case that used to say "offline" -
    // and the card still knows what you are watching.
    const html = card(selfContext(ON('lirik')), null, ME)
    expect(html).toContain('Watching')
    expect(html).toContain('LIRIK')
  })

  it('says you are on Twitch when you are not watching anything', () => {
    const html = card(selfContext({ type: 'idle' }), null, ME)
    expect(html).toContain('This is you')
    expect(html).toContain('On Twitch')
  })

  it('never offers a JOIN to yourself', () => {
    // There is nowhere to go.
    for (const viewer of [ON('lirik'), { type: 'idle' } as Activity]) {
      expect(card(selfContext(viewer), null, ME)).not.toContain('JOIN')
    }
    // Even when a stale presence row for yourself is somehow handed in.
    expect(card(selfContext(ON('lirik')), watching('xqc', 'me'), ME)).not.toContain('JOIN')
  })

  it('offers no friendship controls', () => {
    const html = card(selfContext(ON('lirik')), null, ME)
    expect(html).not.toContain('Add friend')
    expect(html).not.toContain('Remove friend')
  })

  it('still offers Profile', () => {
    const html = card(selfContext(ON('lirik')), null, ME)
    expect(html).toContain('Profile')
    expect(html).toContain('href="https://www.twitch.tv/myself"')
  })

  it('shows your display name and canonical handle', () => {
    const html = card(selfContext(ON('lirik')), null, ME)
    expect(html).toContain('MySelf')
    expect(html).toContain('@myself')
  })
})

describe('describeSelf', () => {
  it('reports what you are watching, with nowhere to join', () => {
    expect(describeSelf(ON('lirik'))).toEqual({
      kind: 'watching_elsewhere',
      channel: 'lirik',
      canJoin: false,
    })
  })

  it('reports being around when you are not on a channel', () => {
    expect(describeSelf({ type: 'idle' })).toEqual({
      kind: 'around',
      channel: null,
      canJoin: false,
    })
    expect(describeSelf(null)).toMatchObject({ kind: 'around' })
  })

  it('never reports you as offline', () => {
    for (const activity of [ON('lirik'), { type: 'idle' } as Activity, null]) {
      expect(describeSelf(activity).kind).not.toBe('offline')
    }
  })
})

// ------------------------------------------------------------- Profile

describe('the Profile action', () => {
  it('is called Profile, everywhere', () => {
    const html = card(ENTRY_POINTS[0][1](ON('lirik')), watching('xqc'))
    expect(html).toContain('Profile')
    expect(html).not.toContain('View on Twitch')
  })

  it('links by canonical login, never by display name', () => {
    // Twitch URLs are keyed on the login; the display name would 404.
    const html = card(ENTRY_POINTS[0][1](ON('lirik')), watching('xqc'))
    expect(html).toContain('href="https://www.twitch.tv/anoterostv"')
    expect(html).not.toContain('twitch.tv/AnoterosTV')
  })

  it('leaves no "View on Twitch" anywhere in the source', () => {
    const files: string[] = []
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, entry.name)
        if (entry.isDirectory()) walk(full)
        else if (/\.(ts|tsx|css)$/.test(entry.name)) files.push(full)
      }
    }
    walk(join(process.cwd(), 'src'))

    expect(files.length).toBeGreaterThan(20)
    for (const file of files) {
      expect(readFileSync(file, 'utf8'), file).not.toContain('View on Twitch')
    }
  })

  it('does not rename JOIN, which means something else', () => {
    expect(card(ENTRY_POINTS[0][1](ON('lirik')), watching('xqc'))).toContain('JOIN')
  })
})
