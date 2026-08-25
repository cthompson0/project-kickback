-- ===========================================================================
-- 0017 — Twitch metadata
--
-- Two things, both additive, both safe to run repeatedly.
--
--   1. A server-side cache of public Twitch channel metadata, written and read
--      ONLY by the metadata Edge Function under the service role.
--   2. One more allowed property on gravity_cluster_impression, so we can ask
--      whether people are being shown destinations that have stopped
--      streaming.
--
-- Nothing here is reachable by a client. The extension never queries this
-- table; it asks the Edge Function, which is the only thing holding the Twitch
-- client secret.
-- ===========================================================================

-- One transaction, as every migration from 0009 onwards is meant to be: a
-- failure part-way through must leave nothing behind.
begin;

-- ------------------------------------------------------- the metadata cache
--
-- One row per channel, holding the record exactly as the function will hand it
-- back. Deliberately not normalised into columns: the shape is defined once in
-- src/core/twitchMetadata.ts and validated on the way out, and splitting it
-- across columns here would create a second definition that has to be migrated
-- every time a field is added.
--
-- The cache is SHARED. Edge Function isolates come and go, so an in-memory
-- cache alone would mean a cold start hits Helix for channels another isolate
-- fetched seconds ago. This is what makes Twitch pressure scale with distinct
-- destinations rather than with users.

create table if not exists public.twitch_metadata_cache (
  login      text        primary key,
  payload    jsonb       not null,
  fetched_at timestamptz not null default now()
);

-- Sweeping old rows is a range scan over this, not a full table scan.
create index if not exists twitch_metadata_cache_fetched_at_idx
  on public.twitch_metadata_cache (fetched_at);

/*
 * No client may touch this table, at all.
 *
 * RLS with no policy denies everything, and the revokes remove the privileges
 * Supabase grants by default. Both, because either alone has been enough to
 * surprise somebody: RLS does not apply to the service role, and privileges do
 * not apply to a policy that was never written.
 *
 * There is nothing private in here - it is public Twitch data - but an
 * unrestricted table is a place for a client to learn which channels other
 * people's friends watch, one login at a time.
 */
alter table public.twitch_metadata_cache enable row level security;

revoke all on table public.twitch_metadata_cache from public, anon, authenticated;

/*
 * Discard records nobody has asked about for a day.
 *
 * The cache is keyed by login and grows with the number of distinct channels
 * Kickback's users have ever watched, which is unbounded over time and tiny at
 * any moment. Called by the Edge Function opportunistically rather than on a
 * schedule, so it needs no pg_cron and no extension.
 */
create or replace function public.sweep_twitch_metadata_cache(p_older_than interval default interval '1 day')
returns integer
language plpgsql
volatile
security definer
set search_path = public, pg_temp
as $fn$
declare
  v_deleted integer;
begin
  delete from public.twitch_metadata_cache
   where fetched_at < now() - p_older_than;
  get diagnostics v_deleted = row_count;
  return v_deleted;
end;
$fn$;

revoke all on function public.sweep_twitch_metadata_cache(interval)
  from public, anon, authenticated;

-- --------------------------------------------------- the analytics contract
--
-- `destination_live` on gravity_cluster_impression.
--
-- Purely additive: the row is upserted with one more entry in
-- allowed_properties, so events already recorded keep their meaning and events
-- sent by a client that does not know about the field are unaffected. The
-- property is dropped server-side for any event that does not list it, so an
-- old client cannot start sending it by accident and a new one cannot send it
-- on an event where it means nothing.
--
-- The question it answers: are we showing people destinations that have
-- stopped streaming, and do JOINs go to live ones? Both are about whether the
-- map is worth acting on.
--
-- Deliberately NOT recorded: stream titles, viewer counts, categories and
-- profile image URLs. None of them answers a question we have, and a title is
-- free text somebody else wrote.

insert into public.analytics_event_names (name, description, allowed_properties) values
  ('gravity_cluster_impression',
   'A Social Gravity destination was visible in the open panel.',
   array['friend_count', 'rank', 'visible_clusters', 'opportunity_key', 'destination_live'])
on conflict (name) do update
  set description        = excluded.description,
      allowed_properties = excluded.allowed_properties;

commit;
