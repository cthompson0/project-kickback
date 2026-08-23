-- Kickback Phase 1 — 0005: realtime publication
--
-- Supabase Realtime delivers `postgres_changes` only for tables in the
-- supabase_realtime publication, and it re-checks RLS per subscriber, so each
-- client receives exactly the rows its policies already allow — friends' presence
-- and its own friend requests, nothing else.
--
-- Guarded so the migration is a no-op on a plain Postgres (the test harness),
-- where that publication does not exist.

do $$
begin
  if not exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    raise notice 'supabase_realtime publication not present; skipping (expected outside Supabase)';
    return;
  end if;

  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'presence'
  ) then
    alter publication supabase_realtime add table public.presence;
  end if;

  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'friend_requests'
  ) then
    alter publication supabase_realtime add table public.friend_requests;
  end if;

  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'friendships'
  ) then
    alter publication supabase_realtime add table public.friendships;
  end if;
end;
$$;
