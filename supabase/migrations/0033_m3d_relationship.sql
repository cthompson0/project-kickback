-- ===========================================================================
-- 0033 — M3D: making a follow baseline checkable and recordable once
--
-- 0032 created `creator_relationship_observations` so its DELETION could be
-- proven before anything could write to it. This adds the two things a writer
-- needs and nothing else:
--
--   * one baseline per attributed JOIN, enforced by the database
--   * a way for the server to check that an attribution really belongs to the
--     actor claiming it
--
-- WHY IDEMPOTENCY IS A CONSTRAINT AND NOT A CONVENTION
--
-- The eventual caller fires at a JOIN, which is exactly the moment a tab is
-- being torn down. Retries, duplicate messages and a worker that restarts
-- mid-flight are all ordinary there. If two of them land, the honest failure is
-- not "two rows" - it is two rows that could disagree, because they were two
-- separate questions asked at two separate moments. A unique index makes the
-- second one impossible rather than merely unlikely.
--
-- The index is PARTIAL. `attribution_id` is nullable because an observation may
-- one day exist without one, and NULLs are not equal to each other, so a plain
-- unique index would not constrain them anyway. Saying `where attribution_id is
-- not null` states that intent rather than relying on the reader knowing it.
--
-- WHY THE ATTRIBUTION LOOKUP LIVES HERE
--
-- `analytics_events` is written through `analytics_track`, whose actor is
-- `auth.uid()`. A client therefore cannot fabricate a JOIN belonging to someone
-- else, which is what makes an attribution id worth checking at all. This
-- function is the check: given an actor and an attribution, it returns that
-- JOIN's destination, timing and social count - or nothing.
--
-- It is scoped to the actor in the WHERE clause rather than returning a row and
-- trusting the caller to compare. A lookup that can only ever answer about the
-- actor asked about cannot be misused by a caller that forgets to check.
-- ===========================================================================

begin;

-- ---------------------------------------------------------------------------
-- One baseline per attributed JOIN.
-- ---------------------------------------------------------------------------

create unique index if not exists creator_relationship_observations_attribution_uq
  on public.creator_relationship_observations (actor_id, attribution_id)
  where attribution_id is not null;

comment on index public.creator_relationship_observations_attribution_uq is
  'One follow baseline per attributed JOIN. A retry cannot create a second, '
  'possibly contradictory, answer to the same question.';

-- ---------------------------------------------------------------------------
-- The attribution binding.
-- ---------------------------------------------------------------------------

create or replace function public.join_context_for_attribution(
  p_actor uuid,
  p_attribution uuid
)
returns table (
  destination_channel text,
  occurred_at timestamptz,
  social_count integer
)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select
    e.destination_channel,
    e.occurred_at,
    /*
     * The number of friends present at the click.
     *
     * Stored inside `properties` rather than promoted to a column, so it is
     * read back the same way the writer put it there. Anything unparseable
     * becomes 0, which fails the socially-initiated check rather than passing
     * it - missing context must never read as "there were friends there".
     */
    coalesce((e.properties ->> 'social_count')::integer, 0) as social_count
  from public.analytics_events e
  where e.actor_id = p_actor
    and e.attribution_id = p_attribution
    and e.event_name = 'join_clicked'
  order by e.occurred_at desc
  limit 1;
$$;

revoke all on function public.join_context_for_attribution(uuid, uuid)
  from public, anon, authenticated;
grant execute on function public.join_context_for_attribution(uuid, uuid) to service_role;

-- ---------------------------------------------------------------------------
-- Schema marker.
-- ---------------------------------------------------------------------------

create or replace function public.analytics_schema_version()
returns int
language sql
immutable
set search_path = public, pg_temp
as $$ select 33; $$;

revoke all on function public.analytics_schema_version() from public, anon, authenticated;

commit;
