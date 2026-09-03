/**
 * The parts of a Supabase project the migrations depend on.
 *
 * WHY THIS IS ITS OWN FILE, AND WHY IT IS .mjs
 *
 * Two things need to build the schema exactly the way production does, and they
 * cannot both be TypeScript: `tests/db/harness.ts`, which vitest compiles, and
 * `scripts/schema-fingerprint.mjs`, which plain node runs so the authorization
 * mutation harness can boot a schema without a test runner.
 *
 * A second copy of this shim would be worse than the duplication it saves. The
 * whole value of the db suite is that it reproduces Supabase's *permissive*
 * defaults - `alter default privileges ... grant all` below - so the revokes in
 * 0002/0003 are genuinely exercised rather than true by accident. Two copies
 * that drift means one of them silently stops reproducing that, and the tests
 * that depend on it start passing for the wrong reason.
 *
 * So: one definition, imported by both.
 */
export const SUPABASE_SHIM = `
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
