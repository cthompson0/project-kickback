-- ===========================================================================
-- 0027 — The social badge projection
--
-- 0026 gave people badges and a way to choose which one to show. It could not
-- finish the loop, because the CHOICE lives in public.user_preferences and that
-- table is self-only by policy - correctly so. A friend could see which badges
-- somebody owns and never which one they picked.
--
-- WHY NOT SIMPLY WIDEN user_preferences
--
-- Because that table also holds presence visibility and notification settings.
-- A policy broad enough to expose displayed_badge_key to friends would expose
-- all of it, and "hide my activity" becoming friend-readable is exactly the
-- kind of quiet privacy regression that is impossible to notice from the
-- outside. The column is not the unit of authorization here; the FACT is.
--
-- So this migration adds one function that returns one fact - who is showing
-- which badge - to exactly the people already entitled to see that person's
-- social identity. Nothing else about a preference row can be reached through
-- it, because nothing else is selected.
--
-- ADDITIVE ONLY. No table, no column, no policy changed. A v0.4.1 Store client
-- never calls it. A v0.6.0 client calls it and renders a badge; without this
-- migration that same client simply shows none, which is the pre-0027
-- behaviour rather than an error.
-- ===========================================================================

begin;

/*
 * Who is showing which badge, among the people the caller may already see.
 *
 * THE AUTHORIZATION IS THE SAME ONE PRESENCE USES
 *
 * Self, an accepted friend, or somebody in a shared group - the identical
 * predicate list that gates presence, destinations and badge ownership. A
 * badge is social identity, so it travels with the social boundary rather than
 * getting a boundary of its own that could drift from it.
 *
 * `is_friend` already carries the block check in BOTH directions (0022), and
 * `shares_group_with` does the same. A blocked pair therefore fails every
 * branch, and blocking somebody removes their badge from your panel for the
 * same reason it removes their presence.
 *
 * THIS IS NOT A DIRECTORY
 *
 * There is no user parameter. The caller cannot ask about an arbitrary account
 * and cannot enumerate anybody: the function is seeded at auth.uid() and
 * returns only rows the caller could already have found through their own
 * friends and groups. It is the same shape list_friend_destinations() uses,
 * for the same reason.
 *
 * WHAT IS DELIBERATELY NOT RETURNED
 *
 * Every other preference column. Badges the person owns but did not choose to
 * show. Referral counts, invite codes, award timestamps, award reasons. The
 * consuming UI needs a key, a name and a symbol to draw a chip beside a name,
 * and that is all this hands over.
 */
create or replace function public.list_displayed_badges()
returns table (
  user_id     uuid,
  badge_key   text,
  name        text,
  icon        text,
  /** 'kickback' or 'twitch'. Kickback must never look like it issued a Twitch badge. */
  issuer      text
)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  with actor as (select public.require_actor() as id)
  select up.user_id, b.key, b.name, b.icon, b.issuer
    from public.user_preferences up
    cross join actor a
    /*
     * The join to user_badges IS the ownership check.
     *
     * A displayed_badge_key naming a badge the person does not hold produces no
     * row at all. set_displayed_badge already refuses one, and a badge could in
     * principle be revoked after being selected - so the projection re-proves
     * ownership rather than trusting the preference.
     */
    join public.user_badges ub
      on ub.user_id = up.user_id and ub.badge_key = up.displayed_badge_key
    join public.badge_definitions b
      on b.key = ub.badge_key
   where up.displayed_badge_key is not null
     and (
       up.user_id = a.id
       or public.is_friend(up.user_id)
       or public.shares_group_with(up.user_id)
     );
$$;

revoke all on function public.list_displayed_badges() from public, anon;
grant execute on function public.list_displayed_badges() to authenticated;

/*
 * The applied marker.
 *
 * The newest migration owns it, so the owner can tell a hosted database that
 * has 0027 from one that stopped at 0026. Nothing else reads it.
 */
create or replace function public.analytics_schema_version()
returns int
language sql
immutable
set search_path = public, pg_temp
as $$ select 27; $$;

revoke all on function public.analytics_schema_version() from public, anon, authenticated;

commit;
