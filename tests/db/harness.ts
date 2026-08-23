import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { PGlite } from '@electric-sql/pglite'

/**
 * Runs the real migrations against a real PostgreSQL (PGlite, in-process) so
 * authorization can be tested the way Postgres actually enforces it: as a
 * non-owner role with a JWT claim, exactly like PostgREST does.
 *
 * The pre-migration setup below imitates the parts of a Supabase project the
 * migrations depend on - including Supabase's *permissive* default privileges,
 * so that the revokes in 0002/0003 are genuinely exercised rather than being
 * true by accident.
 */

// Overridable so scripts/verify-authorization-tests.mjs can point the suite at a
// deliberately weakened copy of the migrations and confirm the tests notice.
const MIGRATIONS_DIR =
  process.env.KICKBACK_MIGRATIONS_DIR ?? join(process.cwd(), 'supabase', 'migrations')

const SUPABASE_SHIM = `
  create role anon nologin;
  create role authenticated nologin;
  create role service_role nologin;

  create schema if not exists auth;

  -- Enough of auth.users for the FK and the identity trigger.
  create table auth.users (
    id                 uuid primary key,
    email              text,
    raw_user_meta_data jsonb default '{}'::jsonb,
    raw_app_meta_data  jsonb default '{}'::jsonb,
    created_at         timestamptz not null default now()
  );

  -- Mirrors Supabase's auth.uid(): the subject claim of the request's JWT.
  create or replace function auth.uid() returns uuid
  language sql stable as $fn$
    select coalesce(
      nullif(current_setting('request.jwt.claim.sub', true), ''),
      nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub'
    )::uuid
  $fn$;

  grant usage on schema public, auth to anon, authenticated, service_role;
  grant execute on function auth.uid() to anon, authenticated, service_role;

  -- Supabase hands anon/authenticated full DML on anything new in public.
  -- Reproducing that is the whole point: our migrations must claw it back.
  alter default privileges in schema public
    grant all on tables to anon, authenticated, service_role;
  alter default privileges in schema public
    grant all on functions to anon, authenticated, service_role;
`

export interface TestUserInput {
  login: string
  displayName?: string
  avatarUrl?: string
  provider?: string
  /** Simulate a provider that returned no usable metadata. */
  rawMeta?: Record<string, unknown>
}

export interface TestUser {
  id: string
  login: string
  displayName: string
}

export interface TestDb {
  /** Run SQL as the database owner, bypassing RLS. Setup and assertions only. */
  root<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T[]>
  /** Run SQL as `authenticated` with this user's JWT subject claim. */
  as<T = Record<string, unknown>>(
    user: TestUser | string,
    sql: string,
    params?: unknown[],
  ): Promise<T[]>
  /** Run SQL as an unauthenticated `anon` client. */
  anon<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T[]>
  createUser(input: TestUserInput): Promise<TestUser>
  reset(): Promise<void>
  close(): Promise<void>
}

export async function createTestDb(): Promise<TestDb> {
  const db = new PGlite()
  await db.exec(SUPABASE_SHIM)

  const files = readdirSync(MIGRATIONS_DIR)
    .filter((name) => name.endsWith('.sql'))
    .sort()

  for (const file of files) {
    const sql = readFileSync(join(MIGRATIONS_DIR, file), 'utf8')
    try {
      await db.exec(sql)
    } catch (error) {
      throw new Error(`migration ${file} failed: ${(error as Error).message}`, { cause: error })
    }
  }

  const asRoot = async <T>(sql: string, params: unknown[] = []): Promise<T[]> => {
    await db.exec('reset role; select set_config(\'request.jwt.claim.sub\', \'\', false);')
    const result = await db.query<T>(sql, params)
    return result.rows
  }

  const asRole = async <T>(
    role: string,
    subject: string | null,
    sql: string,
    params: unknown[],
  ): Promise<T[]> => {
    await db.exec('reset role;')
    await db.query('select set_config($1, $2, false)', [
      'request.jwt.claim.sub',
      subject ?? '',
    ])
    await db.exec(`set role ${role};`)
    try {
      const result = await db.query<T>(sql, params)
      return result.rows
    } finally {
      await db.exec('reset role;')
    }
  }

  let userCounter = 0

  return {
    root: asRoot,

    as: (user, sql, params = []) =>
      asRole('authenticated', typeof user === 'string' ? user : user.id, sql, params),

    anon: (sql, params = []) => asRole('anon', null, sql, params),

    async createUser(input: TestUserInput): Promise<TestUser> {
      userCounter += 1
      const id = `00000000-0000-4000-8000-${String(userCounter).padStart(12, '0')}`
      const displayName = input.displayName ?? input.login
      const meta = input.rawMeta ?? {
        sub: `twitch-${input.login}`,
        nickname: input.login,
        name: displayName,
        picture: input.avatarUrl ?? `https://cdn.example.test/${input.login}.png`,
      }

      await asRoot(
        `insert into auth.users (id, email, raw_user_meta_data, raw_app_meta_data)
         values ($1, $2, $3::jsonb, $4::jsonb)`,
        [
          id,
          `${input.login}@example.test`,
          JSON.stringify(meta),
          JSON.stringify({ provider: input.provider ?? 'twitch' }),
        ],
      )

      return { id, login: input.login, displayName }
    },

    async reset() {
      // exec(), not query(): multi-statement scripts cannot be prepared.
      await db.exec(`
        reset role;
        truncate auth.users cascade;
        truncate public.users, public.connected_accounts, public.friend_requests,
                 public.friendships, public.user_preferences, public.presence cascade;
      `)
      userCounter = 0
    },

    async close() {
      await db.close()
    },
  }
}
