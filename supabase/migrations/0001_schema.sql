-- Kickback Phase 1 — 0001: core schema
--
-- Six tables, no speculative structures. `auth.users` is Supabase's; everything
-- else is ours. A Kickback user is NOT a Twitch user: identity lives in
-- public.users and the Twitch account hangs off it via connected_accounts, so a
-- second platform later is an extra row rather than a migration.
--
-- Deliberately avoided: citext (lives in a different schema on Supabase and
-- complicates portability). Logins are stored pre-lowercased with a CHECK, so
-- plain indexes and equality work.

-- ---------------------------------------------------------------- users

create table if not exists public.users (
  id            uuid primary key references auth.users (id) on delete cascade,
  display_name  text not null check (char_length(display_name) between 1 and 60),
  avatar_url    text check (avatar_url is null or avatar_url ~ '^https://'),
  friend_code   text not null unique
                  check (friend_code ~ '^KB-[0-9ABCDEFGHJKMNPQRSTVWXYZ]{4}-[0-9ABCDEFGHJKMNPQRSTVWXYZ]{4}$'),
  created_at    timestamptz not null default now()
);

comment on table public.users is
  'Kickback identity. Deliberately holds no email and no platform tokens.';

-- ------------------------------------------------------ connected_accounts

create table if not exists public.connected_accounts (
  id                    uuid primary key default gen_random_uuid(),
  user_id               uuid not null references public.users (id) on delete cascade,
  platform              text not null check (platform in ('twitch')),
  platform_user_id      text not null check (char_length(platform_user_id) between 1 and 64),
  platform_login        text not null
                          check (platform_login = lower(platform_login)
                                 and platform_login ~ '^[a-z0-9_]{1,25}$'),
  platform_display_name text check (char_length(platform_display_name) <= 60),
  avatar_url            text check (avatar_url is null or avatar_url ~ '^https://'),
  connected_at          timestamptz not null default now(),
  unique (platform, platform_user_id),
  unique (user_id, platform)
);

-- User search is a prefix match on the login.
create index if not exists connected_accounts_login_idx
  on public.connected_accounts (platform, platform_login text_pattern_ops);

comment on table public.connected_accounts is
  'Link between a Kickback user and a platform identity. No access tokens are stored.';

-- --------------------------------------------------------- friend_requests

create table if not exists public.friend_requests (
  id           uuid primary key default gen_random_uuid(),
  from_user    uuid not null references public.users (id) on delete cascade,
  to_user      uuid not null references public.users (id) on delete cascade,
  status       text not null default 'pending'
                 check (status in ('pending', 'accepted', 'declined', 'cancelled')),
  created_at   timestamptz not null default now(),
  responded_at timestamptz,
  constraint friend_requests_not_self check (from_user <> to_user),
  constraint friend_requests_responded_when_resolved
    check ((status = 'pending') = (responded_at is null))
);

-- At most one live request in a given direction. Enforced by the database, not
-- by application code.
create unique index if not exists friend_requests_one_pending_idx
  on public.friend_requests (from_user, to_user)
  where status = 'pending';

create index if not exists friend_requests_inbox_idx
  on public.friend_requests (to_user)
  where status = 'pending';

-- ------------------------------------------------------------- friendships

-- Mirrored representation: an accepted friendship is exactly two rows,
-- (a -> b) and (b -> a). See supabase/README.md for the tradeoff analysis.
-- The two-row invariant is maintained only by public.create_friendship() and
-- public.remove_friend(); clients have no write access to this table.
create table if not exists public.friendships (
  user_id    uuid not null references public.users (id) on delete cascade,
  friend_id  uuid not null references public.users (id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (user_id, friend_id),
  constraint friendships_not_self check (user_id <> friend_id)
);

create index if not exists friendships_friend_idx on public.friendships (friend_id);

-- -------------------------------------------------------- user_preferences

create table if not exists public.user_preferences (
  user_id             uuid primary key references public.users (id) on delete cascade,
  presence_visibility text not null default 'visible'
                        check (presence_visibility in ('visible', 'hide_activity', 'invisible')),
  updated_at          timestamptz not null default now()
);

comment on column public.user_preferences.presence_visibility is
  'visible = status + channel; hide_activity = status only; invisible = appear offline.';

-- ---------------------------------------------------------------- presence

-- This table holds ALREADY-REDACTED presence. The raw activity a user reports
-- is never persisted; report_presence() applies that user's own privacy
-- setting before writing. A friend therefore cannot read a hidden channel by
-- any means, because the value was never stored.
create table if not exists public.presence (
  user_id      uuid primary key references public.users (id) on delete cascade,
  status       text not null default 'offline' check (status in ('online', 'offline')),
  platform     text check (platform in ('twitch')),
  channel      text check (channel is null or channel ~ '^[a-z0-9_]{1,25}$'),
  last_seen_at timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  constraint presence_channel_requires_platform
    check (channel is null or platform is not null),
  -- An offline row can never carry activity. This makes "invisible" structurally
  -- indistinguishable from genuinely offline.
  constraint presence_offline_has_no_activity
    check (status = 'online' or (platform is null and channel is null))
);

-- ------------------------------------------------------- friend code minting

create or replace function public.generate_friend_code()
returns text
language plpgsql
volatile
set search_path = public, pg_temp
as $$
declare
  -- Crockford-style base32: no I, L, O or U, so codes survive being read aloud.
  alphabet constant text := '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
  code text;
  i int;
begin
  loop
    code := 'KB-';
    for i in 1..4 loop
      code := code || substr(alphabet, 1 + floor(random() * 32)::int, 1);
    end loop;
    code := code || '-';
    for i in 1..4 loop
      code := code || substr(alphabet, 1 + floor(random() * 32)::int, 1);
    end loop;
    exit when not exists (select 1 from public.users u where u.friend_code = code);
  end loop;
  return code;
end;
$$;
