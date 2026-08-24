import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * The secret stays on the server, and the server stays narrow.
 *
 * Two separate promises, and each can be broken without the other noticing.
 *
 *   1. The Twitch client secret, and the app token minted from it, never reach
 *      the extension - not in the bundle, not in state, not in a log.
 *   2. The metadata endpoint is not a Twitch proxy. It takes LOGINS and calls
 *      two fixed URLs. The useful version of that function and the dangerous
 *      version differ only by how much of the request is allowed to become the
 *      request.
 */

const SRC = join(process.cwd(), 'src')
const DIST = join(process.cwd(), 'dist')
const FUNCTION = join(process.cwd(), 'supabase', 'functions', 'twitch-metadata')

function sourcesUnder(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const path = join(dir, entry)
    if (statSync(path).isDirectory()) return sourcesUnder(path)
    return /\.tsx?$/.test(entry) ? [path] : []
  })
}

const extensionSources = sourcesUnder(SRC).map((path) => ({
  path,
  text: readFileSync(path, 'utf8'),
}))

describe('the extension holds no Twitch credential', () => {
  it('never mentions the client secret or the token grant', () => {
    for (const { path, text } of extensionSources) {
      expect(text, path).not.toContain('client_secret')
      expect(text, path).not.toContain('TWITCH_CLIENT_SECRET')
      expect(text, path).not.toContain('client_credentials')
      expect(text, path).not.toContain('id.twitch.tv/oauth2/token')
    }
  })

  it('never calls Helix itself', () => {
    /*
     * The content script and the worker ask Kickback's own endpoint. If either
     * ever called api.twitch.tv directly it would need a credential to do it
     * with, and the only credential a browser can hold is one an attacker can
     * read.
     */
    for (const { path, text } of extensionSources) {
      expect(text, path).not.toContain('api.twitch.tv')
    }
  })

  it('has nowhere in its state to put a token', () => {
    // The panel receives channel metadata and nothing else from this feature.
    const state = readFileSync(join(SRC, 'client', 'types.ts'), 'utf8')
    expect(state).not.toMatch(/appToken|accessToken|access_token/)
  })

  it('models only public fields', () => {
    /*
     * Everything here comes from Helix called with an APP token, which carries
     * no user identity and no scopes - so there is no viewer-specific field to
     * model, and `email` (which Get Users returns only for a user token) must
     * never appear.
     */
    const model = readFileSync(join(SRC, 'core', 'twitchMetadata.ts'), 'utf8')
    // Field declarations, not prose - the file discusses scopes in order to
    // explain that it has none, and a word search would flag its own comment.
    const fields = [...model.matchAll(/^\s{2}(\w+)[?]?:/gm)].map((match) => match[1])
    for (const forbidden of ['email', 'scope', 'scopes', 'token', 'accessToken']) {
      expect(fields).not.toContain(forbidden)
    }
    expect(fields).toContain('login')
    expect(fields).toContain('live')
  })

  it('keeps nothing Twitch-shaped in the built bundles', () => {
    if (!existsSync(DIST)) throw new Error('dist/ is missing - run `npm run build` first')

    for (const name of readdirSync(DIST).filter((file) => file.endsWith('.js'))) {
      const bundle = readFileSync(join(DIST, name), 'utf8')
      expect(bundle, name).not.toContain('client_secret')
      expect(bundle, name).not.toContain('client_credentials')
      expect(bundle, name).not.toContain('api.twitch.tv')
      expect(bundle, name).not.toContain('id.twitch.tv')
    }
  })

  it('needs no new host permission, because it adds no new host', () => {
    // Everything goes to the Supabase project, which is already permitted.
    // A manifest that had grown api.twitch.tv would mean something was
    // calling Twitch from the browser.
    const manifest = JSON.parse(readFileSync(join(process.cwd(), 'public', 'manifest.json'), 'utf8'))
    expect(manifest.host_permissions).not.toContain('https://api.twitch.tv/*')
    expect(manifest.host_permissions.some((host: string) => host.includes('supabase.co'))).toBe(true)
  })

  it('does not ask the developer to put the secret in a client env file', () => {
    const example = readFileSync(join(process.cwd(), '.env.example'), 'utf8')
    // VITE_ variables are compiled into the bundle by definition.
    expect(example).not.toMatch(/VITE_TWITCH/)
    expect(example).not.toContain('TWITCH_CLIENT_SECRET=')
  })
})

describe('the metadata endpoint is not a Twitch proxy', () => {
  const index = readFileSync(join(FUNCTION, 'index.ts'), 'utf8')
  const twitch = readFileSync(join(FUNCTION, 'twitch.ts'), 'utf8')

  it('reads the secret from the environment and nowhere else', () => {
    expect(index).toContain(`Deno.env.get('TWITCH_CLIENT_SECRET')`)
    // Not from the request, not from the database, not from a literal.
    expect(index).not.toMatch(/TWITCH_CLIENT_SECRET\s*=\s*['"][^'"]/)
  })

  it('accepts only a list of logins', () => {
    /*
     * There is no parameter that is a URL and no parameter that is a path. The
     * only thing a caller controls is which logins are asked about, and those
     * go through the login grammar first.
     */
    expect(index).toContain('normalizeLogins(')
    expect(index).not.toMatch(/body\s*\)?\.\s*url/)
    expect(index).not.toMatch(/\bendpoint\b\s*[:=]\s*(body|raw|request)/)
  })

  it('calls exactly three fixed URLs', () => {
    // The token endpoint and the two Helix endpoints, all module constants.
    const urls = [...twitch.matchAll(/'(https:\/\/[^']+)'/g)].map((match) => match[1])
    expect(urls.sort()).toEqual([
      'https://api.twitch.tv/helix/streams',
      'https://api.twitch.tv/helix/users',
      'https://id.twitch.tv/oauth2/token',
    ])
    // Nothing else in the handler builds a URL from anything but those.
    expect(index).not.toMatch(/fetch\(\s*(body|raw|request|input)/)
  })

  it('never returns the token it used', () => {
    // The response is `{ channels }`. Nothing else leaves the function.
    expect(index).not.toMatch(/json\(\s*\{[^}]*token/i)
    expect(index).not.toMatch(/console\.(log|error|warn)/)
  })

  it('requires a caller and does not read the actor from the body', () => {
    // Supabase verifies the JWT before the handler runs; the handler refuses
    // anything without one, and there is no user id in the request to forge.
    expect(index).toContain(`request.headers.get('authorization')`)
    expect(index).toMatch(/return json\(\{ error: 'unauthorized' \}, 401\)/)
    expect(index).not.toMatch(/body[^\n]*user_id|p_actor|actorId/)
  })

  it('rate limits as the caller, charging what the batch costs', () => {
    expect(index).toContain('consume_rate_budget_n')
    expect(index).toContain('p_amount: logins.length')
  })

  it('bounds the work one request can cause', () => {
    expect(index).toContain('MAX_LOGINS_PER_REQUEST')
    expect(twitch).toContain('export const MAX_LOGINS_PER_REQUEST = 100')
    // And every outbound call has a deadline, so a hung Twitch cannot hold a
    // caller's request open indefinitely.
    expect(index).toContain('AbortController')
  })

  it('retries a dead token exactly once, and nothing else', () => {
    /*
     * A 401 means the token died early. One forced refresh follows. 429 and
     * 5xx are not retried at all - the cache already covers them, and the
     * honest answer to being rate limited is to ask for less.
     */
    expect(index).toContain('for (const force of [false, true])')
    expect(index).not.toMatch(/while\s*\(true\)/)
  })

  it('holds the token in memory rather than in the database', () => {
    // A bearer token in Postgres is a credential at rest, bought to save one
    // request per cold start. The cache table holds public data only.
    const migration = readFileSync(
      join(process.cwd(), 'supabase', 'migrations', '0017_twitch_metadata.sql'),
      'utf8',
    )
    expect(migration).not.toMatch(/token/i)
    expect(index).toContain('let appToken: AppToken | null = null')
  })
})

describe('the metadata cache is unreachable from a client', () => {
  const migration = readFileSync(
    join(process.cwd(), 'supabase', 'migrations', '0017_twitch_metadata.sql'),
    'utf8',
  )

  it('denies every client privilege on the table', () => {
    expect(migration).toContain('alter table public.twitch_metadata_cache enable row level security')
    expect(migration).toContain(
      'revoke all on table public.twitch_metadata_cache from public, anon, authenticated',
    )
  })

  it('writes no policy, so RLS denies rather than allows', () => {
    // RLS with no policy denies everything. A policy here would be the bug.
    const policies = migration.match(/create policy/g) ?? []
    expect(policies).toHaveLength(0)
  })

  it('keeps its sweep function out of client hands too', () => {
    expect(migration).toContain(
      'revoke all on function public.sweep_twitch_metadata_cache(interval)',
    )
  })

  it('adds the analytics property additively', () => {
    // On conflict do update, so applying the bundle again is safe and events
    // already recorded keep their meaning.
    expect(migration).toContain('on conflict (name) do update')
    expect(migration).toContain('destination_live')
  })
})

describe('analytics carries the one field that answers a question', () => {
  it('records whether the destination was live, and nothing else about it', () => {
    const contract = readFileSync(join(SRC, 'core', 'analytics.ts'), 'utf8')
    const gravity = contract.slice(
      contract.indexOf('gravity_cluster_impression: ['),
      contract.indexOf(']', contract.indexOf('gravity_cluster_impression: [')),
    )
    expect(gravity).toContain('destination_live')
    for (const forbidden of ['title', 'viewer_count', 'game_name', 'profile_image', 'avatar']) {
      expect(gravity).not.toContain(forbidden)
    }
  })

  it('omits the field entirely when nothing told us', () => {
    /*
     * A property that is absent reads as absent in every query. A literal
     * "unknown" would have to be excluded by hand in each one, and eventually
     * would not be.
     */
    const hub = readFileSync(join(SRC, 'background', 'analyticsHub.ts'), 'utf8')
    expect(hub).toContain(`cluster.live && cluster.live !== 'unknown'`)
  })
})
