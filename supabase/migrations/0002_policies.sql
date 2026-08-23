-- Kickback Phase 1 — 0002: privileges and row level security
--
-- Two independent layers, both of which must pass:
--
--   1. GRANTS  — authenticated clients hold SELECT and nothing else. Every
--                mutation is refused at the privilege layer before RLS is even
--                consulted, so a forbidden write raises an error instead of
--                silently affecting zero rows.
--   2. RLS     — SELECT policies decide which rows you may see.
--
-- Supabase's default privileges grant anon/authenticated full DML on new
-- objects in `public`, so the revokes below are load-bearing, not decorative.

-- ------------------------------------------------- RLS predicate helpers
--
-- These are SECURITY DEFINER so a policy can consult friendships without the
-- caller needing to read that table. Both are scoped to auth.uid() internally:
-- they can only ever answer questions about the caller's own relationships,
-- never about two arbitrary strangers.

create or replace function public.is_friend(p_other uuid)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select exists (
    select 1
    from public.friendships f
    where f.user_id = (select auth.uid())
      and f.friend_id = p_other
  );
$$;

create or replace function public.has_open_request_with(p_other uuid)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select exists (
    select 1
    from public.friend_requests r
    where r.status = 'pending'
      and (
        (r.from_user = (select auth.uid()) and r.to_user = p_other) or
        (r.to_user = (select auth.uid()) and r.from_user = p_other)
      )
  );
$$;

-- ------------------------------------------------------------ enable RLS

alter table public.users              enable row level security;
alter table public.connected_accounts enable row level security;
alter table public.friend_requests    enable row level security;
alter table public.friendships        enable row level security;
alter table public.user_preferences   enable row level security;
alter table public.presence           enable row level security;

-- NOTE: FORCE ROW LEVEL SECURITY is deliberately NOT used. The table owner's
-- RLS bypass is precisely what lets the SECURITY DEFINER RPCs in 0003 be the
-- single write path. Forcing RLS would break every mutation, since there are no
-- write policies by design. Clients are never the owner, so they always obey RLS.

-- ------------------------------------------------------------- privileges

revoke all on public.users              from anon, authenticated;
revoke all on public.connected_accounts from anon, authenticated;
revoke all on public.friend_requests    from anon, authenticated;
revoke all on public.friendships        from anon, authenticated;
revoke all on public.user_preferences   from anon, authenticated;
revoke all on public.presence           from anon, authenticated;

-- anon gets nothing at all: an unauthenticated client can read no Kickback data.
grant select on public.users              to authenticated;
grant select on public.connected_accounts to authenticated;
grant select on public.friend_requests    to authenticated;
grant select on public.friendships        to authenticated;
grant select on public.user_preferences   to authenticated;
grant select on public.presence           to authenticated;

-- ---------------------------------------------------------------- policies
--
-- SELECT policies only. The absence of INSERT/UPDATE/DELETE policies is
-- intentional: combined with the revokes above, direct writes are impossible.

drop policy if exists users_select on public.users;
create policy users_select on public.users
  for select to authenticated
  using (
    id = (select auth.uid())            -- yourself
    or public.is_friend(id)             -- your friends
    or public.has_open_request_with(id) -- whoever you have a live request with
  );

drop policy if exists connected_accounts_select on public.connected_accounts;
create policy connected_accounts_select on public.connected_accounts
  for select to authenticated
  using (
    user_id = (select auth.uid())
    or public.is_friend(user_id)
    or public.has_open_request_with(user_id)
  );

drop policy if exists friend_requests_select on public.friend_requests;
create policy friend_requests_select on public.friend_requests
  for select to authenticated
  using (
    from_user = (select auth.uid())
    or to_user = (select auth.uid())
  );

drop policy if exists friendships_select on public.friendships;
create policy friendships_select on public.friendships
  for select to authenticated
  using (user_id = (select auth.uid()));

-- Your privacy setting is itself private. If friends could read this table they
-- could tell "invisible" apart from "genuinely offline", which defeats the point.
drop policy if exists user_preferences_select on public.user_preferences;
create policy user_preferences_select on public.user_preferences
  for select to authenticated
  using (user_id = (select auth.uid()));

drop policy if exists presence_select on public.presence;
create policy presence_select on public.presence
  for select to authenticated
  using (
    user_id = (select auth.uid())
    or public.is_friend(user_id)
  );
