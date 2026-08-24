import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { PGlite } from '@electric-sql/pglite'
import { describe, expect, it } from 'vitest'

/**
 * The generated schema bundle, applied the way a human applies it.
 *
 * `supabase/.generated/apply_all.sql` is what actually reaches the hosted
 * database - pasted into the SQL editor by hand - so it is the artefact that
 * has to work, not the individual migration files. Its own header promises it
 * is safe to re-run, and that promise turned out to be false: applying it to a
 * database that already had migration 0009 failed with
 *
 *   42P13: cannot change return type of existing function
 *   HINT:  Use DROP FUNCTION list_groups() first.
 *
 * because 0008 uses CREATE OR REPLACE on `list_groups()` and 0009 changes the
 * columns that function returns. Forwards it is fine; run it twice and 0008
 * meets the seven-column function 0009 left behind and cannot replace it with
 * a six-column one.
 *
 * These tests apply the bundle the awkward ways: twice over, and on top of a
 * database that stopped part-way. Both are states a real database gets into.
 */

const MIGRATIONS = join(process.cwd(), 'supabase', 'migrations')
const BUNDLE = join(process.cwd(), 'supabase', '.generated', 'apply_all.sql')

/** Enough of Supabase for the migrations to run. Mirrors tests/db/harness.ts. */
const SUPABASE_SHIM = `
  create role anon nologin;
  create role authenticated nologin;
  create role service_role nologin;

  create schema if not exists auth;

  create table auth.users (
    id                 uuid primary key,
    email              text,
    raw_user_meta_data jsonb default '{}'::jsonb,
    raw_app_meta_data  jsonb default '{}'::jsonb,
    created_at         timestamptz not null default now()
  );

  create or replace function auth.uid() returns uuid
  language sql stable as $fn$
    select coalesce(
      nullif(current_setting('request.jwt.claim.sub', true), ''),
      nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub'
    )::uuid
  $fn$;

  grant usage on schema public, auth to anon, authenticated, service_role;
  grant execute on function auth.uid() to anon, authenticated, service_role;

  alter default privileges in schema public
    grant all on tables to anon, authenticated, service_role;
  alter default privileges in schema public
    grant all on functions to anon, authenticated, service_role;
`

function migrationFiles(): string[] {
  return readdirSync(MIGRATIONS)
    .filter((name) => name.endsWith('.sql'))
    .sort()
}

async function freshDb(): Promise<PGlite> {
  const db = new PGlite()
  await db.exec(SUPABASE_SHIM)
  return db
}

/** Applies migrations up to and including `through`, as a partial history. */
async function applyThrough(db: PGlite, through: string): Promise<void> {
  for (const file of migrationFiles()) {
    await db.exec(readFileSync(join(MIGRATIONS, file), 'utf8'))
    if (file.startsWith(through)) return
  }
}

async function applyBundle(db: PGlite): Promise<void> {
  await db.exec(readFileSync(BUNDLE, 'utf8'))
}

/** The columns `list_groups()` currently declares, in order. */
async function listGroupsColumns(db: PGlite): Promise<string[]> {
  const result = await db.query<{ arg: string }>(`
    select unnest(p.proargnames) as arg
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'list_groups'
  `)
  return result.rows.map((row) => row.arg)
}

describe('the generated bundle', () => {
  it('applies to an empty database', async () => {
    const db = await freshDb()
    await expect(applyBundle(db)).resolves.not.toThrow()
    await db.close()
  })

  it('applies twice, which is what "safe to re-run" means', async () => {
    // The failure the hosted database actually hit. Re-running a bundle is
    // completely ordinary - you re-paste it after adding a migration - so this
    // has to work or the bundle is a one-shot script pretending otherwise.
    const db = await freshDb()
    await applyBundle(db)
    await expect(applyBundle(db)).resolves.not.toThrow()
    await db.close()
  })

  it('applies three times, in case twice was luck', async () => {
    const db = await freshDb()
    await applyBundle(db)
    await applyBundle(db)
    await expect(applyBundle(db)).resolves.not.toThrow()
    await db.close()
  })

  it('applies on top of a database that stopped before the group icons', async () => {
    // The state the hosted project was in: everything through 0008, nothing
    // after it.
    const db = await freshDb()
    await applyThrough(db, '0008')
    await expect(applyBundle(db)).resolves.not.toThrow()
    await db.close()
  })

  it('applies on top of a database where the group icons already landed', async () => {
    // The state a partly-successful run leaves behind. Each migration commits
    // separately, so a failure part-way through does NOT roll back the ones
    // that already succeeded.
    const db = await freshDb()
    await applyThrough(db, '0009')
    await expect(applyBundle(db)).resolves.not.toThrow()
    await db.close()
  })

  it('leaves list_groups with the icon column however it got there', async () => {
    const expected = ['group_id', 'name', 'icon', 'owner_id', 'is_owner', 'member_count', 'created_at']

    const fresh = await freshDb()
    await applyBundle(fresh)
    expect(await listGroupsColumns(fresh)).toEqual(expected)
    await fresh.close()

    const rerun = await freshDb()
    await applyBundle(rerun)
    await applyBundle(rerun)
    expect(await listGroupsColumns(rerun)).toEqual(expected)
    await rerun.close()

    const partial = await freshDb()
    await applyThrough(partial, '0009')
    await applyBundle(partial)
    expect(await listGroupsColumns(partial)).toEqual(expected)
    await partial.close()
  })

  it('keeps the groups that already existed', async () => {
    // A migration that loses data is worse than one that fails.
    const db = await freshDb()
    await applyThrough(db, '0008')

    await db.exec(`
      insert into auth.users (id, raw_user_meta_data, raw_app_meta_data)
      values (
        '11111111-1111-1111-1111-111111111111',
        '{"nickname":"alice_tv","name":"Alice"}'::jsonb,
        '{"provider":"twitch"}'::jsonb
      );
      insert into public.groups (id, name, owner_id)
      values (
        '22222222-2222-2222-2222-222222222222',
        'The Boys',
        '11111111-1111-1111-1111-111111111111'
      );
    `)

    await applyBundle(db)

    const rows = await db.query<{ name: string; icon: string | null }>(
      'select name, icon from public.groups where id = $1',
      ['22222222-2222-2222-2222-222222222222'],
    )
    expect(rows.rows).toEqual([{ name: 'The Boys', icon: null }])
    await db.close()
  })

  it('ends with the group icon and sent-invite functions callable', async () => {
    const db = await freshDb()
    await applyBundle(db)
    await applyBundle(db)

    const present = await db.query<{ proname: string; args: string }>(`
      select p.proname, pg_get_function_identity_arguments(p.oid) as args
      from pg_proc p
      join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'public'
        and p.proname in ('set_group_icon', 'list_group_sent_invites', 'create_group')
      order by p.proname, args
    `)

    expect(present.rows).toEqual([
      { proname: 'create_group', args: 'p_name text, p_icon text' },
      { proname: 'list_group_sent_invites', args: 'p_group uuid' },
      { proname: 'set_group_icon', args: 'p_group uuid, p_icon text' },
    ])
    await db.close()
  })

  it('leaves exactly one list_groups, not an overload pair', async () => {
    // Two functions of the same name would make PostgREST's resolution
    // ambiguous, which fails at runtime rather than at migration time.
    const db = await freshDb()
    await applyBundle(db)
    await applyBundle(db)

    const count = await db.query<{ n: number }>(`
      select count(*)::int as n
      from pg_proc p
      join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'public' and p.proname = 'list_groups'
    `)
    expect(count.rows[0].n).toBe(1)
    await db.close()
  })

  it('corrects a lowercase display name, and leaves a correct one alone', async () => {
    /*
     * Migration 0011 is the only one that rewrites existing rows, so it is the
     * only one where "idempotent" means more than "does not error". Applying
     * the bundle twice must leave the same name, not a name that drifts.
     */
    const db = await freshDb()
    await applyThrough(db, '0008')

    await db.exec(`
      insert into auth.users (id, raw_user_meta_data, raw_app_meta_data)
      values (
        '33333333-3333-3333-3333-333333333333',
        '{"sub":"twitch-1","name":"anoterostv","full_name":"anoterostv","nickname":"AnoterosTV","slug":"AnoterosTV"}'::jsonb,
        '{"provider":"twitch"}'::jsonb
      );
    `)

    // The state every existing profile is in: display name equals the login,
    // because 0004 read the claim that holds the login.
    const before = await db.query<{ display_name: string }>(
      'select display_name from public.users where id = $1',
      ['33333333-3333-3333-3333-333333333333'],
    )
    expect(before.rows[0].display_name).toBe('anoterostv')

    await applyBundle(db)
    const once = await db.query<{ display_name: string }>(
      'select display_name from public.users where id = $1',
      ['33333333-3333-3333-3333-333333333333'],
    )
    expect(once.rows[0].display_name).toBe('AnoterosTV')

    await applyBundle(db)
    const twice = await db.query<{ display_name: string }>(
      'select display_name from public.users where id = $1',
      ['33333333-3333-3333-3333-333333333333'],
    )
    expect(twice.rows[0].display_name).toBe('AnoterosTV')

    // The canonical login is untouched by any of it.
    const account = await db.query<{ platform_login: string; platform_display_name: string }>(
      'select platform_login, platform_display_name from public.connected_accounts where user_id = $1',
      ['33333333-3333-3333-3333-333333333333'],
    )
    expect(account.rows[0]).toEqual({
      platform_login: 'anoterostv',
      platform_display_name: 'AnoterosTV',
    })

    await db.close()
  })

  it('keeps the bundle in step with the migrations it is generated from', async () => {
    // A stale bundle is how the wrong SQL reaches a real database.
    const bundle = readFileSync(BUNDLE, 'utf8')
    for (const file of migrationFiles()) {
      expect(bundle).toContain(file)
    }
  })
})
