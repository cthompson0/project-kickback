-- ===========================================================================
-- 0028 — The strings a person reads say Watchside
--
-- Kickback is now Watchside. Almost all of that rename is client-side, but the
-- database holds two pieces of copy that a human actually reads, and neither
-- can be fixed from the extension:
--
--   1. the fallback display name given to an account whose Twitch metadata
--      arrived empty. It is the name their FRIENDS see in the panel;
--   2. the five referral badge descriptions seeded by 0026, which BadgeShelf
--      puts straight into the tooltip on a badge somebody earned.
--
-- WHAT THIS DELIBERATELY DOES NOT TOUCH
--
--   * Object names. public.sync_kickback_identity() keeps its name, as do the
--     tables, policies and every other function. They are stable identifiers
--     referenced by triggers, grants and older migrations; renaming them buys
--     nothing a user could ever perceive and risks everything.
--
--   * Badge KEYS (referrer_1 ...). They are referenced by award_badge(),
--     award_referral_badges(), every user_badges row already granted, and
--     user_preferences.displayed_badge_key. Renaming them would orphan every
--     badge anyone has earned, to change a string no user ever sees.
--
--   * badge_definitions.issuer, still 'kickback'. It is a data value that
--     keeps "a badge we granted" distinguishable from a Twitch badge. It is
--     carried to the client and compared, never rendered - the shelf shows
--     name, icon and description; the chat chip shows the icon. There is no
--     user-facing branding here to fix.
--
--   * Comments in migrations 0001-0027. They are a record of what was built
--     and when, under the name it had at the time. Rewriting them would be
--     falsifying history, not renaming a product.
--
-- COMPATIBILITY. No table, column, policy, grant or function signature
-- changes. A v0.4.1 client and a v0.6.0 client both see exactly the same
-- shapes; only the text inside two of them differs, and nothing branches on
-- that text on either side.
-- ===========================================================================

begin;

-- --------------------------------------------------- the fallback display name

/*
 * Byte-for-byte the function 0011 installed, with one string changed.
 *
 * It is restated in full rather than patched because there is no way to patch
 * a pl/pgsql body in place, and a create-or-replace that silently drifted from
 * 0011 would be far worse than the verbosity. If 0011 is ever revisited, this
 * is the copy that wins - it is the later migration.
 *
 * The trigger on auth.users binds by name, so replacing the body is enough;
 * no trigger is dropped or recreated, and no sign-in is interrupted.
 */
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
    left(coalesce(v_display, 'Watchside user'), 60),
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
      -- Never let a Twitch account silently move to a different user.
      where public.connected_accounts.user_id = excluded.user_id;
  end if;

  return new;
end;
$$;

revoke all on function public.sync_kickback_identity() from public, anon, authenticated;

/*
 * Anyone already carrying the old fallback.
 *
 * Only the exact fallback string is touched. A display name is otherwise the
 * person's own, and this migration has no business rewriting one somebody
 * chose or that Twitch supplied - so the predicate is equality, not a
 * pattern match.
 */
update public.users
   set display_name = 'Watchside user'
 where display_name = 'Kickback user';

update public.connected_accounts
   set platform_display_name = 'Watchside user'
 where platform_display_name = 'Kickback user';

-- ---------------------------------------------------------- badge descriptions

/*
 * 0026 seeded these with `on conflict (key) do update set ... description`, so
 * an update by key is the same write it already performs. Idempotent: running
 * it twice sets the same five strings.
 */
update public.badge_definitions
   set description = case key
         when 'referrer_1'  then 'Brought a friend to Watchside.'
         when 'referrer_5'  then 'Brought five friends to Watchside.'
         when 'referrer_10' then 'Brought ten friends to Watchside.'
         when 'referrer_15' then 'Brought fifteen friends to Watchside.'
         when 'referrer_25' then 'Brought twenty-five friends to Watchside.'
       end
 where key in ('referrer_1', 'referrer_5', 'referrer_10', 'referrer_15', 'referrer_25');

/*
 * The applied marker.
 *
 * The newest migration owns it, so the owner can tell a hosted database that
 * has 0028 from one that stopped at 0027. Nothing else reads it.
 */
create or replace function public.analytics_schema_version()
returns int
language sql
immutable
set search_path = public, pg_temp
as $$ select 28; $$;

revoke all on function public.analytics_schema_version() from public, anon, authenticated;

commit;
