-- Twitch display names, spelled the way their owner spells them.
--
-- THE BUG
--
-- Every display_name in this database is the lowercase login. Not because the
-- data was missing - Twitch sends both - but because Supabase's Twitch
-- provider maps the two claims the opposite way round from what 0004 assumed:
--
--   claim        Supabase sets it to      example
--   -----------  -----------------------  ------------
--   name         Twitch user.Login        anoterostv
--   full_name    Twitch user.Login        anoterostv
--   nickname     Twitch user.DisplayName  AnoterosTV
--   slug         Twitch user.DisplayName  AnoterosTV
--
-- (See supabase/auth internal/api/provider/twitch.go: `Name: user.Login`,
-- `NickName: user.DisplayName`.)
--
-- 0004 read `coalesce(name, full_name, nickname, login)` for the display name,
-- so it always found `name` first - the login - and never reached the claim
-- that actually carries the capitalisation. The login itself came out right
-- by luck: it was derived from `nickname` and lowercased, and lowercasing a
-- Twitch display name yields the login for ordinary accounts.
--
-- THE FIX
--
-- Read the claims in the order that matches what they actually contain, via a
-- helper so the trigger and the backfill below cannot drift apart. Then
-- correct every profile that already exists, from metadata this database is
-- already holding - no re-authentication, and nobody loses a friendship or a
-- group.
--
-- Additive and idempotent: safe to run against a database that already has it,
-- and safe to run twice.

begin;

-- ------------------------------------------------------------- the helper

/**
 * The display name to show for an identity, from its provider metadata.
 *
 * Presentation only. The canonical lowercase login is a separate value and is
 * what every lookup, comparison, URL and uniqueness constraint still uses.
 *
 * Ordering is by what the claims hold rather than by their names: for Twitch,
 * `nickname` and `slug` carry the display name, while `name` and `full_name`
 * carry the login. The login is the last resort, so the worst case is a name
 * that is merely plain rather than one nobody chose.
 */
create or replace function public.display_name_from_meta(p_meta jsonb, p_login text)
returns text
language sql
immutable
set search_path = public, pg_temp
as $$
  select nullif(
    btrim(
      coalesce(
        -- Twitch: the display name, with its capitalisation.
        nullif(btrim(coalesce(p_meta ->> 'nickname', '')), ''),
        nullif(btrim(coalesce(p_meta ->> 'slug', '')), ''),
        -- Other providers, where these usually hold a human name.
        nullif(btrim(coalesce(p_meta ->> 'name', '')), ''),
        nullif(btrim(coalesce(p_meta ->> 'full_name', '')), ''),
        coalesce(p_login, '')
      )
    ),
    ''
  );
$$;

/**
 * The canonical lowercase login for an identity.
 *
 * For Twitch this is genuinely the login: `name` and `full_name` hold it
 * directly, and `nickname` lowercases to it for ordinary accounts.
 */
create or replace function public.login_from_meta(p_meta jsonb)
returns text
language sql
immutable
set search_path = public, pg_temp
as $$
  select lower(
    nullif(
      btrim(
        coalesce(
          nullif(btrim(coalesce(p_meta ->> 'user_name', '')), ''),
          nullif(btrim(coalesce(p_meta ->> 'preferred_username', '')), ''),
          -- Twitch puts the login here.
          nullif(btrim(coalesce(p_meta ->> 'name', '')), ''),
          nullif(btrim(coalesce(p_meta ->> 'full_name', '')), ''),
          -- Last resort: the display name lowercases to the login.
          nullif(btrim(coalesce(p_meta ->> 'nickname', '')), ''),
          ''
        )
      ),
      ''
    )
  );
$$;

revoke all on function public.display_name_from_meta(jsonb, text) from public, anon, authenticated;
revoke all on function public.login_from_meta(jsonb) from public, anon, authenticated;

-- ------------------------------------------------------------ the trigger

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
  v_login := public.login_from_meta(v_meta);
  v_display := public.display_name_from_meta(v_meta, v_login);
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

revoke all on function public.sync_kickback_identity() from public, anon, authenticated;

-- ------------------------------------------------------------ the backfill

-- Correct the profiles that already exist, from metadata this database is
-- already holding. Nobody has to sign out, and no friendship, group or message
-- is touched.
--
-- Only rows where the recomputed name genuinely differs are written, so
-- re-running this changes nothing and the statement is idempotent.
update public.users u
set display_name = left(v.fixed, 60)
from (
  select
    a.id,
    public.display_name_from_meta(
      coalesce(a.raw_user_meta_data, '{}'::jsonb),
      public.login_from_meta(coalesce(a.raw_user_meta_data, '{}'::jsonb))
    ) as fixed
  from auth.users a
) v
where u.id = v.id
  and v.fixed is not null
  and btrim(v.fixed) <> ''
  and u.display_name is distinct from left(v.fixed, 60);

update public.connected_accounts ca
set platform_display_name = left(v.fixed, 60)
from (
  select
    a.id,
    public.display_name_from_meta(
      coalesce(a.raw_user_meta_data, '{}'::jsonb),
      public.login_from_meta(coalesce(a.raw_user_meta_data, '{}'::jsonb))
    ) as fixed
  from auth.users a
) v
where ca.user_id = v.id
  and v.fixed is not null
  and btrim(v.fixed) <> ''
  and ca.platform_display_name is distinct from left(v.fixed, 60);

commit;
