-- ===========================================================================
-- 0032 — Phase 1: the destruction paths, built before there is anything to destroy
--
-- Watchside is going to hold a Twitch refresh credential. This migration does
-- NOT store one, and after it there is still no production path that can. What
-- it creates is the machinery for getting rid of one, proven while the tables
-- are empty.
--
-- The order is deliberate and it inverts the obvious one. A credential with no
-- proven deletion path is a liability from the first row; an empty deletion
-- path is merely untested until you point fixtures at it. Twitch's
-- confidential-client refresh tokens have no expiration time, so nothing we do
-- and no amount of elapsed time retires one. Deletion is the only end we
-- control. That is the whole argument for building the fire exits first.
--
-- WHAT THIS CREATES
--
--   twitch_credentials                    empty, server-only, no writer exists
--   creator_relationship_observations     empty, server-only, no writer exists
--   eventsub_messages                     replay guard for the webhook receiver
--   purge_twitch_derived(uuid)            THE shared G6 deletion primitive
--   sweep_eventsub_messages(interval)     housekeeping
--
-- THE THREE LIFECYCLE EVENTS, WHICH ARE NOT THE SAME
--
--   sign-out            deletes nothing at all, server-side
--   Twitch deauth       deletes the credential and Twitch-derived observations,
--                       and PRESERVES Watchside's own analytics
--   account deletion    deletes everything the user owns, analytics included
--
-- Collapsing any two of those would be a bug, and the middle one is the easiest
-- to get wrong: revoking a Twitch grant says nothing about wanting Watchside's
-- own observations of its own product destroyed.
--
-- CLIENT POSTURE
--
-- All three tables follow the twitch_metadata_cache precedent from 0017: RLS
-- enabled with ZERO policies, explicitly revoked from every client role, and
-- granted only to service_role. RLS-with-no-policies is deny-all, so a future
-- accidental GRANT still cannot be reached.
-- ===========================================================================

begin;

-- ---------------------------------------------------------------------------
-- The credential table. Nothing writes to it yet.
-- ---------------------------------------------------------------------------

create table if not exists public.twitch_credentials (
  -- Ownership, the deletion key, and the cascade that makes account deletion
  -- correct. Primary key, so one credential per actor and capture is naturally
  -- idempotent.
  actor_id          uuid primary key references public.users (id) on delete cascade,

  /*
   * The encrypted blob: nonce || ciphertext || tag, AES-256-GCM, holding the
   * Twitch refresh token, the access token and its expiry.
   *
   * One column rather than three because a nonce and a tag are meaningless
   * apart from the ciphertext they belong to. The key lives in the Edge
   * Function's environment and never in Postgres, so this column is
   * unreadable to anyone holding only the database - including an
   * administrator. That is the property Supabase Vault could not give us:
   * Vault is for system secrets and its decrypted view is reachable by SQL
   * privilege.
   */
  secret            bytea       not null,

  -- Which key encrypted it. Rotation is additive: new writes use the new
  -- version, old rows re-encrypt lazily on their next refresh.
  key_version       smallint    not null,

  -- Twitch returns a scope array on every refresh, so this is maintained for
  -- free and lets a future follow check decide WITHOUT performing a refresh.
  scopes            text[]      not null default '{}',

  -- The only way to say "we hold a credential we no longer believe in" without
  -- destroying the evidence that the user once authorised.
  status            text        not null default 'active'
                      check (status in ('active', 'needs_reauthorization')),

  -- Compare-and-swap guard so a stale writer cannot overwrite a newer
  -- credential after a concurrent rotation.
  version           bigint      not null default 1,

  -- Read from Twitch's expires_in. No fixed access-token lifetime is
  -- guaranteed, so this is stored rather than assumed - and it is checked
  -- before anything is decrypted, which keeps the common path cheap.
  access_expires_at timestamptz,

  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);

comment on table public.twitch_credentials is
  'Encrypted Twitch refresh credentials. Server-only; no client may read it and '
  'no production writer exists until the custody phase. Decryption happens in '
  'the Edge Function runtime; the key is never in Postgres.';

alter table public.twitch_credentials enable row level security;
revoke all on table public.twitch_credentials from public, anon, authenticated;
grant select, insert, update, delete on table public.twitch_credentials to service_role;

-- ---------------------------------------------------------------------------
-- Twitch-derived relationship observations. Nothing writes to these yet either.
-- ---------------------------------------------------------------------------

create table if not exists public.creator_relationship_observations (
  id                   uuid primary key default gen_random_uuid(),

  actor_id             uuid not null references public.users (id) on delete cascade,

  broadcaster_login    text not null
                         check (broadcaster_login ~ '^[a-z0-9_]{1,25}$'),

  -- Ties the observation to the JOIN that occasioned it, so the denominator is
  -- socially attributed JOINs rather than all of them.
  attribution_id       uuid,

  observed_at          timestamptz not null default now(),

  relationship_type    text not null default 'follow'
                         check (relationship_type in ('follow')),

  /*
   * NULLABLE, and that is the whole point.
   *
   * A failed Twitch call must leave the answer ABSENT, never false. A false
   * would silently claim "this person did not follow the creator" on the
   * strength of an API timeout, and would then be indistinguishable from a real
   * discovery in every downstream number.
   */
  relationship_present boolean
);

comment on table public.creator_relationship_observations is
  'Twitch-derived follow baselines, kept apart from analytics_events so a Twitch '
  'deauthorization can delete them without touching Watchside''s own observations.';

create index if not exists creator_relationship_observations_actor_idx
  on public.creator_relationship_observations (actor_id);

alter table public.creator_relationship_observations enable row level security;
revoke all on table public.creator_relationship_observations from public, anon, authenticated;
grant select, insert, update, delete on table public.creator_relationship_observations to service_role;

-- ---------------------------------------------------------------------------
-- EventSub replay guard.
-- ---------------------------------------------------------------------------

create table if not exists public.eventsub_messages (
  -- Twitch-Eventsub-Message-Id. Stable across retries, which is exactly what
  -- makes it the dedupe key.
  message_id  text primary key check (char_length(message_id) between 1 and 200),
  received_at timestamptz not null default now()
);

alter table public.eventsub_messages enable row level security;
revoke all on table public.eventsub_messages from public, anon, authenticated;
grant select, insert, update, delete on table public.eventsub_messages to service_role;

create or replace function public.sweep_eventsub_messages(p_older_than interval)
returns integer
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_deleted integer;
begin
  delete from public.eventsub_messages
   where received_at < now() - p_older_than;
  get diagnostics v_deleted = row_count;
  return v_deleted;
end;
$$;

revoke all on function public.sweep_eventsub_messages(interval) from public, anon, authenticated;
grant execute on function public.sweep_eventsub_messages(interval) to service_role;

-- ---------------------------------------------------------------------------
-- THE shared G6 deletion primitive.
--
-- Every path that must destroy Twitch-derived state calls this one function:
-- the EventSub revocation receiver today, account deletion today, and the
-- use-time scope-loss detector when custody exists. One implementation, so the
-- three can never drift into deleting different things.
--
-- What it deliberately does NOT touch: analytics_events, analytics_actors, the
-- social graph, or anything else Watchside observed about its own product. A
-- Twitch deauthorization withdraws Twitch's grant. It is not a request to erase
-- Watchside's own record of Watchside.
--
-- Returns counts rather than nothing, so the caller can log that work happened
-- without logging what was in the rows.
-- ---------------------------------------------------------------------------

create or replace function public.purge_twitch_derived(p_actor uuid)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_credentials  integer := 0;
  v_observations integer := 0;
begin
  if p_actor is null then
    return jsonb_build_object('credentials', 0, 'observations', 0, 'actor', false);
  end if;

  delete from public.twitch_credentials where actor_id = p_actor;
  get diagnostics v_credentials = row_count;

  delete from public.creator_relationship_observations where actor_id = p_actor;
  get diagnostics v_observations = row_count;

  -- Idempotent: a second call for the same actor deletes nothing further and
  -- still succeeds, which is what makes a duplicate Twitch delivery harmless.
  return jsonb_build_object(
    'credentials',  v_credentials,
    'observations', v_observations,
    'actor',        true
  );
end;
$$;

revoke all on function public.purge_twitch_derived(uuid) from public, anon, authenticated;
grant execute on function public.purge_twitch_derived(uuid) to service_role;

-- ---------------------------------------------------------------------------
-- Resolving a Twitch identity to a Watchside actor.
--
-- event.user_id ONLY. The revoke payload also carries user_login and user_name,
-- and both are null when the Twitch account no longer exists - which is
-- precisely one of the situations that produces a revocation. Keying on a login
-- would fail exactly when it mattered, and would fail silently: a lookup that
-- finds nothing and a credential that is never deleted.
-- ---------------------------------------------------------------------------

create or replace function public.actor_for_twitch_user(p_twitch_user_id text)
returns uuid
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select user_id
    from public.connected_accounts
   where platform = 'twitch'
     and platform_user_id = p_twitch_user_id;
$$;

revoke all on function public.actor_for_twitch_user(text) from public, anon, authenticated;
grant execute on function public.actor_for_twitch_user(text) to service_role;

-- ---------------------------------------------------------------------------
-- Schema marker.
-- ---------------------------------------------------------------------------

create or replace function public.analytics_schema_version()
returns int
language sql
immutable
set search_path = public, pg_temp
as $$ select 32; $$;

revoke all on function public.analytics_schema_version() from public, anon, authenticated;

commit;
