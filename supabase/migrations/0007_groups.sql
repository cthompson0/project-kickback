-- Kickback Phase 2B — 0007: groups, invites and chat
--
-- Groups are small private spaces, not servers. Deliberately absent:
-- channels, categories, roles beyond owner/member, discovery, public groups.
--
-- The load-bearing rule: group membership is NOT friendship. A may invite B
-- and C into a group without B and C being friends, and nothing here creates
-- a friendship between them. `friendships` is never written by this migration.

-- ------------------------------------------------------------------ groups

create table if not exists public.groups (
  id         uuid primary key default gen_random_uuid(),
  name       text not null check (char_length(btrim(name)) between 1 and 40),
  owner_id   uuid not null references public.users (id) on delete cascade,
  created_at timestamptz not null default now()
);

create index if not exists groups_owner_idx on public.groups (owner_id);

create table if not exists public.group_members (
  group_id  uuid not null references public.groups (id) on delete cascade,
  user_id   uuid not null references public.users (id) on delete cascade,
  role      text not null default 'member' check (role in ('owner', 'member')),
  joined_at timestamptz not null default now(),
  primary key (group_id, user_id)
);

create index if not exists group_members_user_idx on public.group_members (user_id);

create table if not exists public.group_invites (
  id           uuid primary key default gen_random_uuid(),
  group_id     uuid not null references public.groups (id) on delete cascade,
  from_user    uuid not null references public.users (id) on delete cascade,
  to_user      uuid not null references public.users (id) on delete cascade,
  status       text not null default 'pending'
                 check (status in ('pending', 'accepted', 'declined', 'cancelled')),
  created_at   timestamptz not null default now(),
  responded_at timestamptz,
  constraint group_invites_not_self check (from_user <> to_user),
  constraint group_invites_responded_when_resolved
    check ((status = 'pending') = (responded_at is null))
);

-- One live invite per person per group, enforced by the database.
create unique index if not exists group_invites_one_pending_idx
  on public.group_invites (group_id, to_user)
  where status = 'pending';

create index if not exists group_invites_inbox_idx
  on public.group_invites (to_user)
  where status = 'pending';

-- ---------------------------------------------------------------- messages

create table if not exists public.group_messages (
  id         uuid primary key default gen_random_uuid(),
  group_id   uuid not null references public.groups (id) on delete cascade,
  user_id    uuid not null references public.users (id) on delete cascade,
  -- Plain text plus Kickback emote tokens. Rendered as text by React, never
  -- as markup; the length cap is enforced here so a modified client cannot
  -- post a novel.
  body       text not null check (char_length(btrim(body)) between 1 and 500),
  created_at timestamptz not null default now()
);

-- The read path is always "recent messages in this group, newest last".
create index if not exists group_messages_recent_idx
  on public.group_messages (group_id, created_at desc);

-- ------------------------------------------------------- membership helpers
--
-- SECURITY DEFINER so policies can consult membership without the caller
-- needing to read the table, and so there is no RLS recursion. Both are
-- scoped to auth.uid() internally: they answer questions about the caller's
-- own memberships only, never about two arbitrary strangers.

create or replace function public.is_group_member(p_group uuid)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select exists (
    select 1 from public.group_members m
    where m.group_id = p_group and m.user_id = (select auth.uid())
  );
$$;

create or replace function public.is_group_owner(p_group uuid)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select exists (
    select 1 from public.groups g
    where g.id = p_group and g.owner_id = (select auth.uid())
  );
$$;

/**
 * True when the caller and p_other are in at least one group together.
 *
 * This is what grants group-scoped presence visibility. It is safe because
 * presence is redacted at WRITE time: an invisible member's row already says
 * offline and a hide_activity member's row already has no channel, so a new
 * reader cannot see anything its owner chose to hide. Losing membership
 * revokes it immediately, since the policy is evaluated per query.
 */
create or replace function public.shares_group_with(p_other uuid)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select exists (
    select 1
    from public.group_members mine
    join public.group_members theirs on theirs.group_id = mine.group_id
    where mine.user_id = (select auth.uid())
      and theirs.user_id = p_other
  );
$$;

-- --------------------------------------------------------- rate limiting
--
-- Generic fixed-window counter, in its own table that no client can read -
-- same reasoning as presence_rate in 0006: a counter a peer could read is an
-- activity side channel.

create table if not exists public.rate_limits (
  user_id           uuid not null references public.users (id) on delete cascade,
  bucket            text not null,
  window_started_at timestamptz not null default now(),
  writes            int not null default 0,
  primary key (user_id, bucket)
);

alter table public.rate_limits enable row level security;
revoke all on public.rate_limits from anon, authenticated;

create or replace function public.consume_rate_budget(
  p_bucket text,
  p_limit int,
  p_window interval
)
returns boolean
language plpgsql
volatile
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor  uuid := public.require_actor();
  v_writes int;
begin
  insert into public.rate_limits (user_id, bucket, window_started_at, writes)
  values (v_actor, p_bucket, now(), 1)
  on conflict (user_id, bucket) do update
    set window_started_at = case
          when public.rate_limits.window_started_at < now() - p_window then now()
          else public.rate_limits.window_started_at
        end,
        writes = case
          when public.rate_limits.window_started_at < now() - p_window then 1
          else public.rate_limits.writes + 1
        end
  returning writes into v_writes;

  return v_writes <= p_limit;
end;
$$;

-- ------------------------------------------------------------------- RLS

alter table public.groups         enable row level security;
alter table public.group_members  enable row level security;
alter table public.group_invites  enable row level security;
alter table public.group_messages enable row level security;

revoke all on public.groups         from anon, authenticated;
revoke all on public.group_members  from anon, authenticated;
revoke all on public.group_invites  from anon, authenticated;
revoke all on public.group_messages from anon, authenticated;

grant select on public.groups         to authenticated;
grant select on public.group_members  to authenticated;
grant select on public.group_invites  to authenticated;
grant select on public.group_messages to authenticated;

-- SELECT policies only. As everywhere in Kickback, every mutation goes through
-- a SECURITY DEFINER RPC, so there are deliberately no write policies.

drop policy if exists groups_select on public.groups;
create policy groups_select on public.groups
  for select to authenticated
  using (
    public.is_group_member(id)
    -- An invitee must be able to read the group's name to decide.
    or exists (
      select 1 from public.group_invites i
      where i.group_id = groups.id
        and i.to_user = (select auth.uid())
        and i.status = 'pending'
    )
  );

drop policy if exists group_members_select on public.group_members;
create policy group_members_select on public.group_members
  for select to authenticated
  using (public.is_group_member(group_id));

drop policy if exists group_invites_select on public.group_invites;
create policy group_invites_select on public.group_invites
  for select to authenticated
  using (
    to_user = (select auth.uid())
    or from_user = (select auth.uid())
    or public.is_group_owner(group_id)
  );

-- Chat is members-only, full stop. An invite grants nothing until accepted,
-- and removal revokes on the very next query.
drop policy if exists group_messages_select on public.group_messages;
create policy group_messages_select on public.group_messages
  for select to authenticated
  using (public.is_group_member(group_id));

-- ------------------------------------------- group-scoped identity/presence
--
-- Extends, never loosens: the existing self/friend rules are kept verbatim
-- and group membership is added as another way to qualify.

drop policy if exists users_select on public.users;
create policy users_select on public.users
  for select to authenticated
  using (
    id = (select auth.uid())
    or public.is_friend(id)
    or public.has_open_request_with(id)
    or public.shares_group_with(id)
  );

drop policy if exists connected_accounts_select on public.connected_accounts;
create policy connected_accounts_select on public.connected_accounts
  for select to authenticated
  using (
    user_id = (select auth.uid())
    or public.is_friend(user_id)
    or public.has_open_request_with(user_id)
    or public.shares_group_with(user_id)
  );

drop policy if exists presence_select on public.presence;
create policy presence_select on public.presence
  for select to authenticated
  using (
    user_id = (select auth.uid())
    or public.is_friend(user_id)
    or public.shares_group_with(user_id)
  );

-- user_preferences stays self-only. Sharing a group must not reveal that
-- somebody has chosen to be invisible.

revoke all on function public.is_group_member(uuid) from public, anon, authenticated;
revoke all on function public.is_group_owner(uuid) from public, anon, authenticated;
revoke all on function public.shares_group_with(uuid) from public, anon, authenticated;
revoke all on function public.consume_rate_budget(text, int, interval)
  from public, anon, authenticated;

-- Policies are evaluated as the caller, so these must be executable by them.
grant execute on function public.is_group_member(uuid) to authenticated;
grant execute on function public.is_group_owner(uuid) to authenticated;
grant execute on function public.shares_group_with(uuid) to authenticated;
