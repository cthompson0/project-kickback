/**
 * What the migrations actually build, as a comparable value.
 *
 *   node scripts/schema-fingerprint.mjs [migrationsDir]
 *
 * WHY THIS EXISTS
 *
 * `verify-authorization-tests.mjs` weakens one safeguard at a time and asserts
 * the suite notices. That is only meaningful if the weakening reaches the
 * schema the tests run against - and six of its eighteen levers had quietly
 * stopped doing so. Each edited a definition that a LATER migration replaces:
 * `send_friend_request` in 0003 is superseded by 0022 and again by 0039,
 * `report_presence` in 0006 by 0025, `group_messages_select` in 0007 by 0022.
 * The anchor text was still there, so nothing complained; the mutation simply
 * edited dead SQL and the suite stayed green, which the runner then reported as
 * "this regression would ship".
 *
 * Grepping for later definitions would catch today's six and miss the seventh.
 * This asks Postgres instead: build the schema twice, once clean and once
 * mutated, and compare what the database ended up with. A mutation that changes
 * nothing here changed nothing anywhere.
 *
 * WHAT IS FINGERPRINTED
 *
 * The authorization surface, and only that - not row data, not comments, not
 * ordering:
 *
 *   - every function in `public`, by its real post-`create or replace` body,
 *     with its volatility, its SECURITY DEFINER flag and its search_path;
 *   - every row-level policy, by table, command, roles and expressions;
 *   - which tables have RLS enabled and forced;
 *   - what `anon`, `authenticated` and `public` may do to each table and column;
 *   - which functions those roles may EXECUTE.
 *
 * Those are exactly the things the mutations claim to weaken, so a mutation
 * that leaves all of them identical has not weakened anything.
 */
import { readFileSync, readdirSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { PGlite } from '@electric-sql/pglite'
import { SUPABASE_SHIM } from '../tests/db/supabaseShim.mjs'

/**
 * The queries whose combined answer IS the fingerprint.
 *
 * Every one is ordered explicitly. Postgres makes no promise about row order
 * without it, and an unordered fingerprint would differ between runs of an
 * identical schema - which would turn this check into noise and get it ignored.
 */
const PROBES = {
  functions: `
    select p.proname,
           pg_get_function_identity_arguments(p.oid) as args,
           pg_get_functiondef(p.oid)                 as definition,
           p.prosecdef                               as security_definer,
           p.provolatile,
           coalesce(array_to_string(p.proconfig, ','), '') as config
      from pg_proc p
      join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public'
     order by p.proname, args
  `,
  policies: `
    select schemaname, tablename, policyname, permissive,
           coalesce(array_to_string(roles, ','), '') as roles,
           cmd,
           coalesce(qual, '')       as qual,
           coalesce(with_check, '') as with_check
      from pg_policies
     where schemaname = 'public'
     order by tablename, policyname, cmd
  `,
  rls: `
    select c.relname, c.relrowsecurity, c.relforcerowsecurity
      from pg_class c
      join pg_namespace n on n.oid = c.relnamespace
     where n.nspname = 'public' and c.relkind in ('r', 'p', 'v', 'm')
     order by c.relname
  `,
  tablePrivileges: `
    select table_name, grantee, privilege_type
      from information_schema.role_table_grants
     where table_schema = 'public'
       and grantee in ('anon', 'authenticated', 'PUBLIC')
     order by table_name, grantee, privilege_type
  `,
  columnPrivileges: `
    select table_name, column_name, grantee, privilege_type
      from information_schema.column_privileges
     where table_schema = 'public'
       and grantee in ('anon', 'authenticated', 'PUBLIC')
     order by table_name, column_name, grantee, privilege_type
  `,
  functionPrivileges: `
    select p.proname,
           pg_get_function_identity_arguments(p.oid) as args,
           r.rolname,
           has_function_privilege(r.rolname, p.oid, 'EXECUTE') as can_execute
      from pg_proc p
      join pg_namespace n on n.oid = p.pronamespace
      cross join (select unnest(array['anon', 'authenticated']) as rolname) r
     where n.nspname = 'public'
     order by p.proname, args, r.rolname
  `,
}

/**
 * Build the schema from a migrations directory and describe it.
 *
 * Deliberately the same sequence `tests/db/harness.ts` uses - the shim, then
 * every .sql file in sorted order - because a fingerprint of a schema the tests
 * never see would answer the wrong question.
 */
export async function fingerprint(migrationsDir) {
  const db = new PGlite()
  try {
    await db.exec(SUPABASE_SHIM)

    const files = readdirSync(migrationsDir)
      .filter((name) => name.endsWith('.sql'))
      .sort()

    for (const file of files) {
      const sql = readFileSync(join(migrationsDir, file), 'utf8')
      try {
        await db.exec(sql)
      } catch (error) {
        // A mutation that will not apply is a broken lever, not a finding. The
        // caller needs to tell those apart, so this is reported rather than
        // thrown as if the schema had an opinion about it.
        return { failed: `migration ${file} failed: ${error.message}` }
      }
    }

    const sections = {}
    for (const [name, sql] of Object.entries(PROBES)) {
      const result = await db.query(sql)
      sections[name] = result.rows
    }

    const digest = (value) =>
      createHash('sha256').update(JSON.stringify(value)).digest('hex')

    return {
      failed: null,
      sections,
      // Per-section digests, so a difference can be attributed rather than
      // merely noticed - "the mutation changed a policy" is a far more useful
      // thing to print than "something changed".
      digests: Object.fromEntries(
        Object.entries(sections).map(([name, rows]) => [name, digest(rows)]),
      ),
      digest: digest(sections),
    }
  } finally {
    await db.close()
  }
}

/** The section names whose digests differ between two fingerprints. */
export function changedSections(before, after) {
  return Object.keys(PROBES).filter((name) => before.digests[name] !== after.digests[name])
}

// pathToFileURL rather than string-building: on Windows argv[1] is a C:\ path,
// and a hand-made file:// URL never matches import.meta.url's file:///C:/ form.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const dir = process.argv[2] ?? join(process.cwd(), 'supabase', 'migrations')
  const result = await fingerprint(dir)
  if (result.failed) {
    console.error(result.failed)
    process.exit(1)
  }
  console.log(JSON.stringify({ digest: result.digest, digests: result.digests }, null, 2))
}
