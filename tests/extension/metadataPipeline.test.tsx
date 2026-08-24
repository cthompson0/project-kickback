import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { SocialGravity } from '../../src/ui/components/SocialGravity'
import { ChannelNameProvider } from '../../src/ui/ChannelNames'
import { socialGravity, gravityOpportunities } from '../../src/core/socialGravity'
import { opportunityKey } from '../../src/core/socialGravity'
import { createMetadataService } from '../../src/background/metadata'
import { parseDiagnostics } from '../../src/core/twitchMetadata'
import type { ChannelMetadata, MetadataDiagnostic } from '../../src/core/twitchMetadata'
import type { Friend, KickbackClient } from '../../src/client/types'
import type { Activity, Presence } from '../../src/core/types'

/**
 * The pipeline, end to end, and the failure that got through it.
 *
 * Metadata shipped, deployed, and produced nothing at all: the Edge Function
 * called `consume_rate_budget_n`, an internal helper that 0013 revokes from
 * `authenticated`, so every request died on a permission error before Twitch
 * was ever contacted. Nothing looked wrong, because the panel degrades
 * correctly by design.
 *
 * These tests exist so that neither the wiring nor the silence can come back.
 */

const NOW = 1_700_000_000_000
const FUNCTION = join(process.cwd(), 'supabase', 'functions', 'twitch-metadata')

const record = (login: string, over: Partial<ChannelMetadata> = {}): ChannelMetadata => ({
  login,
  userId: '1',
  displayName: login.toUpperCase(),
  profileImageUrl: null,
  live: 'live',
  gameName: null,
  title: null,
  viewerCount: null,
  startedAt: null,
  fetchedAt: NOW,
  ...over,
})

const settle = () => new Promise((resolve) => setTimeout(resolve, 0))

function service(fetchImpl: (logins: string[]) => Promise<unknown>) {
  const calls: string[][] = []
  const seen: Array<{ diagnostic: MetadataDiagnostic; codes?: string[] }> = []
  const handle = createMetadataService({
    fetcher: {
      fetch: (logins) => {
        calls.push(logins)
        return fetchImpl(logins)
      },
    },
    now: () => NOW,
    onDiagnostic: (diagnostic, detail) => seen.push({ diagnostic, codes: detail.codes }),
  })
  return { handle, calls, seen }
}

// ------------------------------------------------------------- the bug itself

describe('the endpoint calls an RPC a signed-in user may actually execute', () => {
  const index = readFileSync(join(FUNCTION, 'index.ts'), 'utf8')

  it('never calls the internal rate-limit helper directly', () => {
    /*
     * `consume_rate_budget_n` is revoked from `public`, `anon` and
     * `authenticated` in 0013 - deliberately, so a client cannot charge an
     * arbitrary bucket by an arbitrary amount. Calling it with the caller's
     * JWT is a guaranteed permission error, which is exactly what shipped.
     */
    expect(index).not.toContain(`rpc('consume_rate_budget_n'`)
    expect(index).toContain(`rpc('consume_metadata_budget'`)
  })

  it('has a wrapper that authenticated callers are granted', () => {
    const migration = readFileSync(
      join(process.cwd(), 'supabase', 'migrations', '0018_twitch_metadata_budget.sql'),
      'utf8',
    )
    expect(migration).toContain('create or replace function public.consume_metadata_budget(p_amount int)')
    expect(migration).toContain('security definer')
    expect(migration).toContain('grant execute on function public.consume_metadata_budget(int) to authenticated')
    // And the internal helper is still not handed out.
    expect(migration).not.toMatch(/grant execute on function public\.consume_rate_budget_n/)
  })

  it('fixes the bucket, the allowance and the window server-side', () => {
    // A caller who could choose them could give themselves a private bucket,
    // or a window of a century.
    const migration = readFileSync(
      join(process.cwd(), 'supabase', 'migrations', '0018_twitch_metadata_budget.sql'),
      'utf8',
    )
    expect(migration).toContain(`'twitch_metadata'`)
    expect(migration).toContain(`interval '5 minutes'`)
    expect(index).not.toContain('p_bucket')
    expect(index).not.toContain('p_window')
  })

  it('never turns a rate-limit failure into a 401 again', () => {
    /*
     * The specific thing that made this invisible: a migration that had not
     * been applied looked exactly like an unauthenticated caller. A broken
     * budget check now degrades to cache and SAYS SO.
     */
    expect(index).toContain(`diagnostics.push('budget_unavailable')`)

    /*
     * Asserted on CODE, not on text.
     *
     * The comment beside the fix necessarily explains what a 401 used to do
     * there, and a plain search would flag that explanation - which is a
     * mistake worth not making twice.
     */
    const code = index.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '')
    const budgetBlock = code.slice(
      code.indexOf("rpc('consume_metadata_budget'"),
      code.indexOf('const now = Date.now()'),
    )
    expect(budgetBlock).not.toContain('401')
    expect(budgetBlock).toContain('mayFetch = false')
  })
})

// --------------------------------------------------------------- the pipeline

describe('wanting a channel reaches the backend', () => {
  it('schedules a request for a channel nothing is known about', async () => {
    const { handle, calls, seen } = service(async (logins) => ({
      channels: logins.map((login) => record(login)),
    }))

    handle.want(['lvndmark'])
    expect(seen.map((entry) => entry.diagnostic)).toContain('requested')
    await settle()

    expect(calls).toEqual([['lvndmark']])
    expect(handle.snapshot().lvndmark.displayName).toBe('LVNDMARK')
    expect(seen.map((entry) => entry.diagnostic)).toContain('stored')
  })

  it('says so when everything asked for is already fresh', async () => {
    const { handle, seen } = service(async (logins) => ({
      channels: logins.map((login) => record(login)),
    }))
    handle.want(['lvndmark'])
    await settle()
    seen.length = 0

    handle.want(['lvndmark'])
    expect(seen.map((entry) => entry.diagnostic)).toEqual(['fresh'])
  })

  it('distinguishes a failed call from an answer with nothing in it', async () => {
    const failed = service(async () => {
      throw new Error('function not deployed')
    })
    failed.handle.want(['lvndmark'])
    await settle()
    expect(failed.seen.map((entry) => entry.diagnostic)).toContain('failed')
    expect(failed.handle.snapshot()).toEqual({})

    const rejected = service(async () => ({ channels: [{ login: 'not a login' }] }))
    rejected.handle.want(['lvndmark'])
    await settle()
    expect(rejected.seen.map((entry) => entry.diagnostic)).toContain('rejected')
    expect(rejected.handle.snapshot()).toEqual({})
  })

  it('surfaces what the backend said about itself', async () => {
    const { handle, seen } = service(async (logins) => ({
      channels: logins.map((login) => record(login)),
      diagnostics: ['cache_miss', 'twitch_credentials_missing'],
    }))

    handle.want(['lvndmark'])
    await settle()

    const backend = seen.find((entry) => entry.diagnostic === 'backend')
    expect(backend?.codes).toEqual(['cache_miss', 'twitch_credentials_missing'])
  })

  it('refuses to echo a code it does not recognise', () => {
    // A future backend must not be able to make an old client log arbitrary
    // text into a console.
    expect(parseDiagnostics({ diagnostics: ['cache_hit', 'rm -rf /', 42] })).toEqual(['cache_hit'])
    expect(parseDiagnostics(null)).toEqual([])
  })

  it('keeps the channels that worked when one in a batch does not', async () => {
    const { handle } = service(async () => ({
      // Helix resolved lirik, said nothing usable about the other two.
      channels: [record('lirik'), { login: 'nope nope' }, null],
    }))

    handle.want(['lirik', 'xqc', 'shroud'])
    await settle()

    expect(Object.keys(handle.snapshot())).toEqual(['lirik'])
  })
})

// ----------------------------------------------------------- state to render

const friend = (id: string, name: string, channel: string): Friend => ({
  user: { id, username: id, displayName: name, avatarUrl: null, accentColor: '#ff8452' },
  presence: {
    userId: id,
    status: 'online',
    activity: { type: 'watching', platform: 'twitch', channel },
    since: NOW - 60_000,
    lastSeenAt: Date.now(),
  } as Presence,
})

const IDLE: Activity = { type: 'idle' }

function render(friends: Friend[], metadata?: Record<string, ChannelMetadata>) {
  return renderToStaticMarkup(
    <ChannelNameProvider people={[]} seen={{}} metadata={metadata}>
      <SocialGravity
        friends={friends}
        localActivity={IDLE}
        client={{ reportExposure: () => {} } as unknown as KickbackClient}
        cardContext={{
          selfId: 'me',
          viewerActivity: IDLE,
          friendIds: new Set(friends.map((f) => f.user.id)),
          outgoingRequestIds: new Set(),
        }}
        metadata={metadata}
      />
    </ChannelNameProvider>,
  )
}

describe('presence lowercase, metadata authoritative, UI correct', () => {
  /*
   * The exact case observed in the browser:
   *
   *   presence   lvndmark
   *   metadata   LVNDMARK
   *   UI         LVNDMARK
   *   identity   lvndmark
   */
  const friends = [friend('anoteros', 'AnoterosTV', 'lvndmark')]
  const metadata = { lvndmark: record('lvndmark', { displayName: 'LVNDMARK' }) }

  it('renders the authoritative casing', async () => {
    // Through the worker cache, so the whole client half of the pipeline runs.
    const { handle } = service(async () => ({ channels: Object.values(metadata) }))
    handle.want(['lvndmark'])
    await settle()

    const html = render(friends, handle.snapshot())
    expect(html).toContain('LVNDMARK')
    expect(html).not.toContain('>lvndmark<')
  })

  it('keeps every identity use canonical', () => {
    const sections = socialGravity(
      [{ member: 'a', userId: 'anoteros', presence: friends[0].presence }],
      IDLE,
      Date.now(),
      'me',
      metadata,
    )

    // Clustering key.
    expect(sections[0].channel).toBe('lvndmark')
    // Analytics destination and opportunity.
    const [opportunity] = gravityOpportunities(sections)
    expect(opportunity.channel).toBe('lvndmark')
    expect(opportunityKey(opportunity.channel, NOW)).toBe(opportunityKey('LVNDMARK', NOW))
    // JOIN target: the card is given the section's channel, never the name.
    const source = readFileSync(join(process.cwd(), 'src/ui/components/SocialGravity.tsx'), 'utf8')
    const joinProps = source.slice(
      source.indexOf('<JoinButton'),
      source.indexOf('/>', source.indexOf('<JoinButton')),
    )
    expect(joinProps).toContain('channel={section.channel}')
  })

  it('falls back to the login when metadata never arrives', () => {
    // Acceptable, and the only honest answer - but it must be the ONLY thing
    // that changes.
    const html = render(friends)
    expect(html).toContain('lvndmark')
    expect(html).toContain('AnoterosTV')
    expect(html).toContain('kb-join')
    expect(html).toContain('kb-gravity-avatar')
  })
})
