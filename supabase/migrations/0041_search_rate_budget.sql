-- ===========================================================================
-- 0041 — A budget for search, before the directory becomes public
--
-- `search_users` matches an exact friend code OR a >=2-character PREFIX of a
-- Twitch login, and returns up to ten rows. Six write surfaces carry a rate
-- budget - friend_request, group_create, group_message, room_message,
-- together_reaction, feedback - and this one carries none.
--
-- WHAT THAT ALLOWS
--
-- Two things, and the second is worse than the first.
--
--   1. ENUMERATION. Ten rows per prefix, 676 two-letter prefixes, no ceiling.
--      That is a downloadable list of who uses Watchside.
--   2. MEMBERSHIP PROBING. "Is this specific person on Watchside?" is answered
--      by typing their Twitch login. One query, no cost, no trace. For a
--      product whose entire subject matter is where somebody is watching, that
--      is the question we least want to answer for free.
--
-- It has not mattered so far because the directory has been a private beta.
-- Public launch is exactly the event that makes it matter, which is why this
-- lands before launch rather than after.
--
-- WHY 60 IN 10 MINUTES
--
-- Measured against what the client actually does. `FindFriends` debounces at
-- 250ms with a 2-character minimum, so looking somebody up costs one to four
-- searches depending on typing speed and pauses. Sixty is therefore roughly
-- fifteen to sixty people looked up in ten minutes - far past any real session
-- of adding friends, and far below the thousands a useful enumeration needs.
--
-- The window is deliberately shorter than friend_request's hour: search is
-- read-only and recoverable, so a person who somehow hits the ceiling should
-- get it back quickly rather than lose the feature for an hour.
--
-- WHAT THE CALLER SEES
--
-- An empty result, not an error. Search already returns zero rows for a query
-- shorter than two characters and for a name nobody has, so the client has
-- always handled "nothing found" as an ordinary answer. Raising 53400 here
-- would mean an error dialog on a keystroke, and would also tell an enumerator
-- exactly where the ceiling is - the one thing worth not telling them.
--
-- VOLATILITY IS THE REAL CHANGE. The function was `stable`, which cannot write
-- the budget row. It becomes `volatile`. Same signature, same return type, same
-- grants, same results for every legitimate caller.
-- ===========================================================================

begin;

create or replace function public.search_users(p_query text)
returns table (
  user_id      uuid,
  display_name text,
  avatar_url   text,
  twitch_login text,
  relationship text,
  matched_by   text
)
language plpgsql
volatile
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor uuid := public.require_actor();
  v_raw   text := btrim(coalesce(p_query, ''));
  v_code  text := upper(v_raw);
  v_login text := lower(v_raw);
  v_prefix text;
begin
  if char_length(v_raw) < 2 then
    return;
  end if;

  /*
   * The budget, charged only for a query that will really be run.
   *
   * AFTER the length check on purpose: a one-character query does no lookup, so
   * charging for it would let a client burn a person's allowance on the way to
   * typing a real name. Same rule the friend-request budget follows - charge
   * for the thing that costs something, not for the keystroke.
   *
   * Returning empty rather than raising keeps this indistinguishable from "no
   * such user" at the surface, which is deliberate.
   */
  if not public.consume_rate_budget('user_search', 60, interval '10 minutes') then
    return;
  end if;

  v_prefix := replace(replace(v_login, '\', '\\'), '_', '\_') || '%';

  return query
  with matches as (
    select u.id, u.display_name, u.avatar_url, ca.platform_login,
           case when u.friend_code = v_code then 'friend_code' else 'twitch_login' end as how
    from public.users u
    left join public.connected_accounts ca
      on ca.user_id = u.id and ca.platform = 'twitch'
    where u.friend_code = v_code
       or (ca.platform_login is not null and ca.platform_login like v_prefix)
    order by (u.friend_code = v_code) desc, ca.platform_login
    limit 10
  )
  select m.id,
         m.display_name,
         m.avatar_url,
         m.platform_login,
         case
           when m.id = v_actor then 'self'
           /*
            * Unchanged from 0022. 'blocked' means "I blocked them", and only
            * the blocker ever sees it. Somebody the OTHER person blocked falls
            * through to 'none' - an ordinary-looking result whose Add button
            * the server refuses, indistinguishably from any other failure.
            */
           when exists (select 1 from public.blocks b
                        where b.blocker_id = v_actor and b.blocked_id = m.id) then 'blocked'
           when exists (select 1 from public.friendships f
                        where f.user_id = v_actor and f.friend_id = m.id) then 'friend'
           when exists (select 1 from public.friend_requests r
                        where r.from_user = v_actor and r.to_user = m.id
                          and r.status = 'pending') then 'request_sent'
           when exists (select 1 from public.friend_requests r
                        where r.to_user = v_actor and r.from_user = m.id
                          and r.status = 'pending') then 'request_received'
           else 'none'
         end,
         m.how
    from matches m;
end;
$$;

revoke all on function public.search_users(text) from public, anon;
grant execute on function public.search_users(text) to authenticated;

-- ===========================================================================
-- The contract version.
-- ===========================================================================

create or replace function public.analytics_schema_version()
returns int
language sql
immutable
set search_path = public, pg_temp
as $$ select 41; $$;

revoke all on function public.analytics_schema_version() from public, anon, authenticated;

commit;
