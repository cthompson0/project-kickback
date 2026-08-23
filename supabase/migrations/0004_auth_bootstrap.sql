-- Kickback Phase 1 — 0004: turning a Supabase auth user into a Kickback user
--
-- Runs inside the database on insert/update of auth.users, so a Kickback
-- profile is guaranteed to exist before the client makes its first call, and
-- the client never gets to assert its own identity.
--
-- Note what is NOT copied: auth.users.email is never read here. Twitch email
-- may exist in Supabase's auth schema because the provider requests it, but it
-- is not Kickback profile data and no Kickback query can reach it.

create or replace function public.sync_kickback_identity()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_meta     jsonb := coalesce(new.raw_user_meta_data, '{}'::jsonb);
  v_provider text  := coalesce(new.raw_app_meta_data ->> 'provider', '');
  v_login    text;
  v_display  text;
  v_avatar   text;
  v_pid      text;
begin
  -- Twitch arrives via Supabase's OIDC mapping; the key names vary a little by
  -- provider version, so accept the usual aliases.
  v_login := lower(nullif(btrim(coalesce(
    v_meta ->> 'nickname', v_meta ->> 'preferred_username', v_meta ->> 'user_name', ''
  )), ''));
  v_display := nullif(btrim(coalesce(
    v_meta ->> 'name', v_meta ->> 'full_name', v_meta ->> 'nickname', v_login, ''
  )), '');
  v_avatar := nullif(btrim(coalesce(v_meta ->> 'picture', v_meta ->> 'avatar_url', '')), '');
  v_pid := nullif(btrim(coalesce(v_meta ->> 'provider_id', v_meta ->> 'sub', '')), '');

  if v_avatar is not null and v_avatar !~ '^https://' then
    v_avatar := null;
  end if;
  if v_login is not null and v_login !~ '^[a-z0-9_]{1,25}$' then
    v_login := null;
  end if;

  insert into public.users (id, display_name, avatar_url, friend_code)
  values (
    new.id,
    left(coalesce(v_display, 'Kickback user'), 60),
    v_avatar,
    public.generate_friend_code()
  )
  on conflict (id) do update
    set display_name = left(coalesce(v_display, public.users.display_name), 60),
        avatar_url = coalesce(v_avatar, public.users.avatar_url);

  insert into public.user_preferences (user_id) values (new.id)
  on conflict (user_id) do nothing;

  insert into public.presence (user_id, status) values (new.id, 'offline')
  on conflict (user_id) do nothing;

  if v_provider = 'twitch' and v_pid is not null and v_login is not null then
    insert into public.connected_accounts (
      user_id, platform, platform_user_id, platform_login, platform_display_name, avatar_url
    )
    values (new.id, 'twitch', v_pid, v_login, left(coalesce(v_display, v_login), 60), v_avatar)
    on conflict (platform, platform_user_id) do update
      set platform_login = excluded.platform_login,
          platform_display_name = excluded.platform_display_name,
          avatar_url = excluded.avatar_url
      -- Never let a Twitch account silently move to a different Kickback user.
      where public.connected_accounts.user_id = excluded.user_id;
  end if;

  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.sync_kickback_identity();

-- Twitch display names and avatars change; refresh them on each sign-in rather
-- than trusting the client to tell us what its own name is.
drop trigger if exists on_auth_user_updated on auth.users;
create trigger on_auth_user_updated
  after update of raw_user_meta_data on auth.users
  for each row execute function public.sync_kickback_identity();

revoke all on function public.sync_kickback_identity() from public, anon, authenticated;
revoke all on function public.generate_friend_code() from public, anon, authenticated;
revoke all on function public.require_actor() from public, anon, authenticated;
revoke all on function public.create_friendship(uuid, uuid) from public, anon, authenticated;
