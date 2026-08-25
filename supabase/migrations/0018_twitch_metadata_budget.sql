-- ===========================================================================
-- 0018 — the metadata endpoint's rate budget
--
-- FIXES A REAL FAILURE, NOT A THEORETICAL ONE.
--
-- 0017 shipped a metadata Edge Function that called
-- `public.consume_rate_budget_n` directly, with the caller's JWT. That
-- function is an INTERNAL helper: 0013 revokes it from `public`, `anon` and
-- `authenticated` precisely so that a client cannot spend or inspect another
-- caller's budget, and it is only ever meant to be invoked from inside another
-- SECURITY DEFINER function.
--
-- So every metadata request failed with a permission error, the handler turned
-- that into a 401, and Twitch was never contacted at all. No metadata ever
-- reached the panel.
--
-- The fix is NOT to grant the internal helper to clients - that would hand
-- every signed-in user the ability to charge any bucket by any amount. It is a
-- narrow wrapper that hard-codes the bucket, the limit and the window, so the
-- caller chooses nothing except how many logins they asked about.
-- ===========================================================================

-- One transaction, as every migration from 0009 onwards is meant to be: a
-- failure part-way through must leave nothing behind.
begin;

/*
 * Charge this caller for a metadata request.
 *
 * SECURITY DEFINER so it may call the internal helper, and `require_actor()`
 * inside that helper resolves `auth.uid()` - which means the actor is the JWT's
 * subject and there is no parameter for anyone to put someone else's id into.
 *
 * The bucket name, the allowance and the window are FIXED HERE rather than
 * passed in. A caller who could choose them could give themselves a private
 * bucket, or a window of a century.
 *
 * 600 logins per 5 minutes is generous for the real access pattern - a panel
 * showing ten destinations refreshes them every two minutes, so about 25 - and
 * still bounds a client that decides to ask for a hundred channels in a loop.
 */
create or replace function public.consume_metadata_budget(p_amount int)
returns boolean
language plpgsql
volatile
security definer
set search_path = public, pg_temp
as $fn$
begin
  -- Clamped, so a negative or absurd amount cannot be used to reset or
  -- exhaust the window in one call.
  return public.consume_rate_budget_n(
    'twitch_metadata',
    least(greatest(coalesce(p_amount, 0), 0), 100),
    600,
    interval '5 minutes'
  );
end;
$fn$;

revoke all on function public.consume_metadata_budget(int) from public, anon;
grant execute on function public.consume_metadata_budget(int) to authenticated;

/*
 * The service role's access to the metadata cache, stated rather than assumed.
 *
 * 0017 revoked the table from `public`, which on some configurations takes the
 * service role's inherited privileges with it. The Edge Function is the only
 * thing that reads or writes this table, and a silent permission failure there
 * would look exactly like a cache that never hits - every request going to
 * Twitch, forever, with nothing in the logs.
 */
grant select, insert, update, delete on table public.twitch_metadata_cache to service_role;
grant execute on function public.sweep_twitch_metadata_cache(interval) to service_role;

commit;
