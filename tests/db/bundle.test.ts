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

  it('applies on top of a database that predates analytics', async () => {
    /*
     * The state the hosted project is in right now: everything through 0012,
     * nothing after. This is the exact upgrade path 0013 and 0014 will be run
     * along, so it is worth its own case rather than being covered by
     * implication.
     */
    const db = await freshDb()
    await applyThrough(db, '0012')
    await expect(applyBundle(db)).resolves.not.toThrow()

    const [{ count }] = (
      await db.query<{ count: string }>('select count(*)::text as count from public.analytics_event_names')
    ).rows
    expect(Number(count)).toBeGreaterThan(15)
    await db.close()
  })

  it('applies on top of the current hosted state, which stopped at 0014', async () => {
    /*
     * The exact upgrade path 0015 and 0016 will be run along.
     *
     * Worth its own case rather than being covered by implication: 0015
     * replaces a function 0013 created and 0016 replaces views 0014 created,
     * and both of those are the shapes that produce 42P13 when they are done
     * carelessly.
     */
    const db = await freshDb()
    await applyThrough(db, '0014')
    await expect(applyBundle(db)).resolves.not.toThrow()

    const [{ version }] = (
      await db.query<{ version: number }>('select public.analytics_schema_version() as version')
    ).rows
    /*
     * The marker moves with the newest analytics-touching migration.
     *
     * It exists so verify:analytics can tell a half-applied schema from a
     * complete one, and everything else those migrations change is revoked from
     * clients and therefore invisible to it. 0023 owns it now.
     */
    expect(version).toBe(23)

    // The revised contract survived the upgrade, rather than 0013's copy
    // winning because it runs later in the file.
    const [{ properties }] = (
      await db.query<{ properties: string[] }>(
        "select allowed_properties as properties from public.analytics_event_names where name = 'watching_together_ended'",
      )
    ).rows
    expect(properties).toContain('detection_delay_ms')
    await db.close()
  })

  it('applies on top of a database that stopped at the Together prototype', async () => {
    /*
     * The 42P13 this file was written for, a second time.
     *
     * 0019 created send_together_reaction(text, text) returning a uuid - the id
     * of the single row it inserted. 0020 fans the reaction out to a whole room
     * and returns a COUNT, and Postgres refuses to let CREATE OR REPLACE change
     * a function's return type. Exactly the shape of the list_groups() failure
     * above, and it reached the hosted database because this suite was not run.
     *
     * 0019 is a real deployed state - it shipped, and reactions worked in one
     * direction - so a bundle that cannot be applied on top of it is a bundle
     * that cannot be deployed.
     */
    const db = await freshDb()
    await applyThrough(db, '0019')
    await expect(applyBundle(db)).resolves.not.toThrow()
    await db.close()
  })

  it('applies on top of a database where 0020 stopped half-way', async () => {
    /*
     * The state the failed deploy actually left behind.
     *
     * 0017-0020 had no begin/commit of their own, so the SQL editor committed
     * 0020 statement by statement: the table was dropped and recreated in its
     * new shape, and then the function failed - leaving a database whose
     * together_reactions has recipient_id while send_together_reaction still
     * writes user_id.
     *
     * Reproduced by hand rather than trusted: apply through 0019, then replay
     * only the part of 0020 that committed, then require the fixed bundle to
     * repair it with no manual intervention.
     */
    const db = await freshDb()
    await applyThrough(db, '0019')

    const partial = readFileSync(join(MIGRATIONS, '0020_stream_rooms.sql'), 'utf8')
    const upToTheFailure = partial.slice(0, partial.indexOf('drop function if exists public.send_together_reaction'))
    // Without the transaction wrapper, the way the hosted editor ran it.
    await db.exec(upToTheFailure.replace(/^begin;$/m, ''))

    // The half-converged state, confirmed before asserting the repair.
    const columns = await db.query<{ column_name: string }>(
      `select column_name from information_schema.columns
        where table_schema = 'public' and table_name = 'together_reactions'`,
    )
    const names = columns.rows.map((row) => row.column_name)
    expect(names).toContain('recipient_id')
    expect(names).not.toContain('user_id')

    await expect(applyBundle(db)).resolves.not.toThrow()
    await db.close()
  })

  it('applies on top of the deployed 0020, which is where hosted is now', async () => {
    /*
     * The upgrade that actually has to happen.
     *
     * 0020 is deployed and untouched; 0021 adds room_messages beside it, so
     * this is the exact transition the hosted database is about to make. It
     * is asserted rather than assumed - the last two migrations both reached
     * production through a state this suite had not tried.
     */
    const db = await freshDb()
    await applyThrough(db, '0020')
    await expect(applyBundle(db)).resolves.not.toThrow()

    const columns = await db.query<{ column_name: string }>(
      `select column_name from information_schema.columns
        where table_schema = 'public' and table_name = 'room_messages'`,
    )
    const names = columns.rows.map((row) => row.column_name)
    expect(names).toContain('recipient_id')
    expect(names).toContain('sender_id')
    expect(names).toContain('body')
    await db.close()
  })

  it('applies on top of 0021, which is the transition Block makes', async () => {
    /*
     * The upgrade that has to happen next.
     *
     * 0022 does not only add a table: it redefines is_friend, shares_group_with,
     * stream_room_members, send_room_message, send_together_reaction,
     * send_friend_request, respond_to_friend_request, invite_to_group and
     * search_users on top of whatever 0003-0021 left behind. Every one of those
     * is a replacement of an existing function, and stream_room_members is the
     * kind that needs a DROP first. This is asserted rather than assumed.
     */
    const db = await freshDb()
    await applyThrough(db, '0021')
    await expect(applyBundle(db)).resolves.not.toThrow()

    const table = await db.query<{ column_name: string }>(
      `select column_name from information_schema.columns
        where table_schema = 'public' and table_name = 'blocks'`,
    )
    expect(table.rows.map((row) => row.column_name).sort()).toEqual([
      'blocked_id',
      'blocker_id',
      'created_at',
    ])
    await db.close()
  })

  it('leaves one block_user however the database got there', async () => {
    // Forwards and on top of 0021 must agree. An overload pair here would mean
    // some clients calling a version that does not sever the friendship.
    const fresh = await freshDb()
    await applyBundle(fresh)

    const upgraded = await freshDb()
    await applyThrough(upgraded, '0021')
    await applyBundle(upgraded)

    for (const db of [fresh, upgraded]) {
      const result = await db.query<{ proname: string }>(`
        select p.proname
        from pg_proc p
        join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'public'
          and p.proname in ('block_user', 'unblock_user', 'list_blocked_users')
        order by p.proname
      `)
      expect(result.rows.map((row) => row.proname)).toEqual([
        'block_user',
        'list_blocked_users',
        'unblock_user',
      ])
      await db.close()
    }
  })

  it('never hands blocked_pair to a client, however many times it runs', async () => {
    /*
     * The one function that must stay unreachable.
     *
     * blocked_pair answers "are these two blocked", and a client that could
     * call it could ask whether somebody had blocked THEM - the single fact
     * this feature exists not to disclose. A re-run that quietly granted it
     * back would undo that, silently.
     */
    const db = await freshDb()
    await applyBundle(db)
    await applyBundle(db)

    const result = await db.query<{ has: boolean }>(`
      select has_function_privilege('authenticated', p.oid, 'execute') as has
      from pg_proc p
      join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'public' and p.proname = 'blocked_pair'
    `)
    expect(result.rows).toHaveLength(1)
    expect(result.rows[0].has).toBe(false)

    // And no client may write the table directly, which would be the other way
    // to manufacture or erase a block.
    for (const privilege of ['insert', 'update', 'delete']) {
      const table = await db.query<{ has: boolean }>(
        `select has_table_privilege('authenticated', 'public.blocks', '${privilege}') as has`,
      )
      expect(table.rows[0].has).toBe(false)
    }
    await db.close()
  })

  it('applies on top of 0022, which is the transition Feedback makes', async () => {
    /*
     * 0023 adds a table and a view of its own, and replaces
     * analytics_schema_version - a function every earlier analytics migration
     * also defines. Asserted rather than assumed, like every upgrade before it.
     */
    const db = await freshDb()
    await applyThrough(db, '0022')
    await expect(applyBundle(db)).resolves.not.toThrow()

    const columns = await db.query<{ column_name: string }>(
      `select column_name from information_schema.columns
        where table_schema = 'public' and table_name = 'feedback'`,
    )
    expect(columns.rows.map((row) => row.column_name).sort()).toEqual([
      'body',
      'category',
      'context',
      'created_at',
      'id',
      'user_id',
    ])
    await db.close()
  })

  it('never lets a client read or edit feedback, however many times it runs', async () => {
    /*
     * Feedback is the one table holding text somebody typed. A client that
     * could read it could read everybody else's; one that could update or
     * delete could rewrite what they said after the fact.
     *
     * RLS is enabled with NO permissive policy, which denies everything - so
     * this checks the grants directly rather than trusting that a missing
     * policy stays missing.
     */
    const db = await freshDb()
    await applyBundle(db)
    await applyBundle(db)

    for (const privilege of ['select', 'insert', 'update', 'delete']) {
      const table = await db.query<{ has: boolean }>(
        `select has_table_privilege('authenticated', 'public.feedback', '${privilege}') as has`,
      )
      expect(table.rows[0].has).toBe(false)

      const view = await db.query<{ has: boolean }>(
        `select has_table_privilege('authenticated', 'public.feedback_v', '${privilege}') as has`,
      )
      expect(view.rows[0].has).toBe(false)
    }

    // The one door in stays open.
    const rpc = await db.query<{ has: boolean }>(`
      select has_function_privilege('authenticated', p.oid, 'execute') as has
      from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'public' and p.proname = 'submit_feedback'
    `)
    expect(rpc.rows).toHaveLength(1)
    expect(rpc.rows[0].has).toBe(true)
    await db.close()
  })

  it('leaves send_room_message callable however the database got there', async () => {
    // Forwards and on top of 0020 must agree, or the extension gets whichever
    // shape the database happened to end up with.
    const fresh = await freshDb()
    await applyBundle(fresh)

    const upgraded = await freshDb()
    await applyThrough(upgraded, '0020')
    await applyBundle(upgraded)

    for (const db of [fresh, upgraded]) {
      const result = await db.query<{ returns: string }>(`
        select pg_catalog.format_type(p.prorettype, null) as returns
        from pg_proc p
        join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'public' and p.proname = 'send_room_message'
      `)
      expect(result.rows.map((row) => row.returns)).toEqual(['integer'])
      await db.close()
    }
  })

  it('keeps room_messages locked down after repeated runs', async () => {
    /*
     * Re-running the bundle must not hand a client a way to write its own
     * rows. The whole authorization model is that only the RPC decides who a
     * message is addressed to, and an INSERT grant would be the one way to
     * step around it entirely.
     */
    const db = await freshDb()
    await applyBundle(db)
    await applyBundle(db)

    const grants = await db.query<{ privilege_type: string; grantee: string }>(
      `select privilege_type, grantee from information_schema.role_table_grants
        where table_schema = 'public' and table_name = 'room_messages'
          and grantee in ('anon', 'authenticated')`,
    )
    expect(grants.rows.map((row) => row.grantee + ':' + row.privilege_type)).toEqual([
      'authenticated:SELECT',
    ])

    const rls = await db.query<{ relrowsecurity: boolean }>(
      `select relrowsecurity from pg_class where relname = 'room_messages'`,
    )
    expect(rls.rows[0].relrowsecurity).toBe(true)
    await db.close()
  })
  it('leaves send_together_reaction returning a count, however it got there', async () => {
    // Forwards and on top of 0019 must agree, or the extension gets whichever
    // shape the database happened to end up with.
    const fresh = await freshDb()
    await applyBundle(fresh)

    const stopped = await freshDb()
    await applyThrough(stopped, '0019')
    await applyBundle(stopped)

    for (const db of [fresh, stopped]) {
      const result = await db.query<{ returns: string }>(`
        select pg_catalog.format_type(p.prorettype, null) as returns
        from pg_proc p
        join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'public' and p.proname = 'send_together_reaction'
      `)
      expect(result.rows.map((row) => row.returns)).toEqual(['integer'])
      await db.close()
    }
  })

  it('gives every migration its own transaction, which is what the header promises', () => {
    /*
     * The bundle's header says a failure "rolls back only the one that failed".
     * That is only true if each file wraps itself, and 0017-0020 did not - which
     * is why a failure inside 0020 committed everything before it instead of
     * leaving the database untouched.
     *
     * Checked from 0009, which is where the convention starts.
     */
    for (const file of migrationFiles()) {
      const ordinal = Number(file.slice(0, 4))
      if (ordinal < 9) continue
      const sql = readFileSync(join(MIGRATIONS, file), 'utf8')
      expect(/^begin;$/m.test(sql), `${file} has no begin`).toBe(true)
      expect(/^commit;$/m.test(sql), `${file} has no commit`).toBe(true)
    }
  })

  it('keeps the lifecycle views usable after repeated runs', async () => {
    // 0014 creates the together and funnel views and 0016 replaces them. Run
    // the whole thing three times and the newest shape must still be what is
    // there - a column from 0016, not one from 0014.
    const db = await freshDb()
    await applyBundle(db)
    await applyBundle(db)
    await applyBundle(db)

    const columns = (
      await db.query<{ column_name: string }>(
        "select column_name from information_schema.columns where table_name = 'analytics_join_funnel_v'",
      )
    ).rows.map((row) => row.column_name)

    expect(columns).toContain('post_social_retained')
    expect(columns).toContain('together_effective_ended_at')
    expect(columns).toContain('opportunity_key')
    await db.close()
  })

  it('re-running updates an event contract rather than leaving it stale', async () => {
    // 0013 seeds analytics_event_names with ON CONFLICT DO UPDATE, so an event
    // that gains a property on a later pass is brought up to date. Without it,
    // the database would go on silently stripping the new key.
    const db = await freshDb()
    await applyBundle(db)
    await db.exec(
      "update public.analytics_event_names set allowed_properties = '{}' where name = 'join_clicked'",
    )
    await applyBundle(db)

    const [{ properties }] = (
      await db.query<{ properties: string[] }>(
        "select allowed_properties as properties from public.analytics_event_names where name = 'join_clicked'",
      )
    ).rows
    expect(properties).toContain('social_count')
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
