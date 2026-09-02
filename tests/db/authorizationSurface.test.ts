import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createTestDb } from './harness'
import type { TestDb } from './harness'

/**
 * The authorization surface, introspected rather than reasoned about.
 *
 * WHY INTROSPECTION AND NOT A SOURCE SCAN
 *
 * Functions are redefined across migrations - `search_users` is defined in
 * 0003, again in 0022, again in 0041 - and only the last definition runs.
 * Grepping the SQL finds every version and cannot tell you which one is live,
 * so a source scan can report a fixed `search_path` that the shipped function
 * does not have. These tests ask the database what it actually built.
 *
 * WHAT IS BEING PROTECTED
 *
 * A SECURITY DEFINER function runs with the OWNER's privileges, so RLS does not
 * protect it - it is the thing RLS was bypassed for. Two properties keep that
 * safe, and both are invisible until something goes wrong:
 *
 *   1. A PINNED search_path. Without it, a caller who can create objects in a
 *      schema earlier on the path can shadow a table or an operator and have
 *      the definer's privileges execute their code.
 *   2. ACTOR IDENTITY FROM THE TOKEN. `auth.uid()`, via `require_actor()` -
 *      never a user id accepted as an argument, which is IDOR by construction.
 *
 * These are launch-blocking properties, so they are asserted for every function
 * rather than for the ones somebody remembered.
 */

let db: TestDb

interface FunctionRow {
  name: string
  security_definer: boolean
  config: string[] | null
  source: string
}

beforeAll(async () => {
  db = await createTestDb()
}, 90_000)

afterAll(async () => {
  await db.close()
})

const functions = () =>
  db.root<FunctionRow>(
    `select p.proname                as name,
            p.prosecdef             as security_definer,
            p.proconfig             as config,
            pg_get_functiondef(p.oid) as source
       from pg_proc p
       join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'public'
      order by p.proname`,
  )

describe('every SECURITY DEFINER function is safe by construction', () => {
  it('finds them at all, so nothing below passes vacuously', async () => {
    const definers = (await functions()).filter((f) => f.security_definer)
    expect(definers.length).toBeGreaterThan(20)
  })

  it('pins search_path on all of them', async () => {
    /*
     * The classic SECURITY DEFINER escalation. Without a pinned path, a caller
     * who can create objects in an earlier schema shadows a table or an
     * operator, and the definer's privileges execute it.
     */
    const unpinned = (await functions())
      .filter((f) => f.security_definer)
      .filter((f) => !(f.config ?? []).some((c) => c.startsWith('search_path=')))
      .map((f) => f.name)

    expect(unpinned, `SECURITY DEFINER without a pinned search_path: ${unpinned.join(', ')}`).toEqual(
      [],
    )
  })

  it('never lets a CLIENT-CALLABLE function take an actor id', async () => {
    /*
     * IDOR by construction. A function that accepts `p_actor uuid` and trusts
     * it lets any authenticated caller act as anybody.
     *
     * THE RULE IS ABOUT THE GRANT, NOT THE SIGNATURE. Several internal helpers
     * legitimately take an actor - `apply_destinations`,
     * `join_context_for_attribution`, `purge_creator_relationships` - because
     * they are called by another definer or by the service role after it has
     * verified a JWT itself. What makes that safe is that no client can call
     * them, so that is what this asserts. An earlier version of this test
     * matched on the parameter name and reported three false positives.
     */
    const callable = (await functions())
      .filter((f) => f.security_definer)
      .filter((f) => /p_actor|p_user_id|p_caller/.test(f.source))

    const reachable: string[] = []
    for (const f of callable) {
      const [row] = await db.root<{ granted: boolean }>(
        `select coalesce(bool_or(
                  has_function_privilege('authenticated', p.oid, 'EXECUTE')
                  or has_function_privilege('anon', p.oid, 'EXECUTE')), false) as granted
           from pg_proc p join pg_namespace n on n.oid = p.pronamespace
          where n.nspname = 'public' and p.proname = $1`,
        [f.name],
      )
      if (row.granted) reachable.push(f.name)
    }

    expect(
      reachable,
      `client-callable and takes an actor id: ${reachable.join(', ')}`,
    ).toEqual([])
  })

  it('keeps the server-only definers away from clients', async () => {
    for (const name of ['purge_twitch_derived', 'analytics_emit_server']) {
      const [row] = await db.root<{ granted: boolean }>(
        `select coalesce(bool_or(
                  has_function_privilege('authenticated', p.oid, 'EXECUTE')
                  or has_function_privilege('anon', p.oid, 'EXECUTE')), false) as granted
           from pg_proc p join pg_namespace n on n.oid = p.pronamespace
          where n.nspname = 'public' and p.proname = $1`,
        [name],
      )
      expect(row.granted, `${name} is callable by a client`).toBe(false)
    }
  })
})

describe('anonymous callers can reach nothing', () => {
  it('cannot execute any public function', async () => {
    const reachable = await db.root<{ name: string }>(
      `select distinct p.proname as name
         from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'public'
          and has_function_privilege('anon', p.oid, 'EXECUTE')`,
    )
    expect(
      reachable.map((r) => r.name),
      `anon can execute: ${reachable.map((r) => r.name).join(', ')}`,
    ).toEqual([])
  })

  it('cannot read any table directly', async () => {
    const readable = await db.root<{ name: string }>(
      `select c.relname as name
         from pg_class c join pg_namespace n on n.oid = c.relnamespace
        where n.nspname = 'public' and c.relkind = 'r'
          and has_table_privilege('anon', c.oid, 'SELECT')`,
    )
    expect(readable.map((r) => r.name)).toEqual([])
  })
})

describe('the credential table is unreachable from a client', () => {
  it('grants nothing to authenticated or anon', async () => {
    for (const role of ['authenticated', 'anon']) {
      for (const privilege of ['SELECT', 'INSERT', 'UPDATE', 'DELETE']) {
        const [row] = await db.root<{ allowed: boolean }>(
          `select has_table_privilege($1, 'public.twitch_credentials', $2) as allowed`,
          [role, privilege],
        )
        expect(row.allowed, `${role} has ${privilege} on twitch_credentials`).toBe(false)
      }
    }
  })

  it('has row level security enabled', async () => {
    const [row] = await db.root<{ enabled: boolean }>(
      `select c.relrowsecurity as enabled from pg_class c
         join pg_namespace n on n.oid = c.relnamespace
        where n.nspname = 'public' and c.relname = 'twitch_credentials'`,
    )
    expect(row.enabled).toBe(true)
  })
})

describe('every table carrying user data has RLS on', () => {
  it('leaves none of them open', async () => {
    /*
     * RLS is not what protects the RPC surface - the definers bypass it - but
     * it is the backstop for direct table access with an anon or authenticated
     * key, which a client holds. A table with RLS off and any grant is readable
     * by every signed-in user.
     */
    const open = await db.root<{ name: string }>(
      `select c.relname as name
         from pg_class c join pg_namespace n on n.oid = c.relnamespace
        where n.nspname = 'public'
          and c.relkind = 'r'
          and not c.relrowsecurity
          and (has_table_privilege('authenticated', c.oid, 'SELECT')
            or has_table_privilege('anon', c.oid, 'SELECT'))`,
    )
    expect(
      open.map((r) => r.name),
      `readable with RLS off: ${open.map((r) => r.name).join(', ')}`,
    ).toEqual([])
  })
})

describe('reporting views are not client-readable', () => {
  it('keeps measurement surfaces off the client', async () => {
    /*
     * `activation_funnel_v`, `acquisition_coverage_v`, `m3d_relationship_v` and
     * friends aggregate across every user. They are for the owner reading the
     * database, never for a signed-in client - one of them would hand a caller
     * the whole cohort's behaviour.
     */
    const exposed = await db.root<{ name: string }>(
      `select c.relname as name
         from pg_class c join pg_namespace n on n.oid = c.relnamespace
        where n.nspname = 'public'
          and c.relkind = 'v'
          and c.relname like '%\\_v'
          and (has_table_privilege('authenticated', c.oid, 'SELECT')
            or has_table_privilege('anon', c.oid, 'SELECT'))`,
    )
    expect(
      exposed.map((r) => r.name),
      `client-readable reporting view: ${exposed.map((r) => r.name).join(', ')}`,
    ).toEqual([])
  })
})
