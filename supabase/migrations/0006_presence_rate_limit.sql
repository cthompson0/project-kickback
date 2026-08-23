-- Kickback Phase 1 — 0006: a guard against presence write storms
--
-- Normal use writes to `presence` roughly twice a minute: once per channel
-- change (debounced client-side) plus a heartbeat every 45s. A modified client
-- could call report_presence in a loop instead. This adds a fixed-window
-- counter so that costs the database almost nothing.
--
-- The counter deliberately lives in its OWN table rather than as columns on
-- `presence`. Friends can read `presence`; a counter sitting there would tick
-- upward while a user is invisible, which is exactly the activity side channel
-- 0003 was careful to close. Here no client can read it at all.

create table if not exists public.presence_rate (
  user_id           uuid primary key references public.users (id) on delete cascade,
  window_started_at timestamptz not null default now(),
  writes            int not null default 0
);

alter table public.presence_rate enable row level security;

-- No policies and no grants, for anyone. Only SECURITY DEFINER functions reach
-- this table - including for the owner, so it cannot become a self-read oracle.
revoke all on public.presence_rate from anon, authenticated;

comment on table public.presence_rate is
  'Private rate-limit counters. Unreadable by clients so it cannot leak activity.';

-- Returns true when the caller may write presence, false when over budget.
create or replace function public.consume_presence_budget()
returns boolean
language plpgsql
volatile
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor  uuid := public.require_actor();
  v_window constant interval := interval '1 minute';
  -- ~45x the expected rate: unreachable by navigating, trivially reached by a loop.
  v_limit  constant int := 90;
  v_writes int;
begin
  insert into public.presence_rate (user_id, window_started_at, writes)
  values (v_actor, now(), 1)
  on conflict (user_id) do update
    set window_started_at = case
          when public.presence_rate.window_started_at < now() - v_window then now()
          else public.presence_rate.window_started_at
        end,
        writes = case
          when public.presence_rate.window_started_at < now() - v_window then 1
          else public.presence_rate.writes + 1
        end
  returning writes into v_writes;

  return v_writes <= v_limit;
end;
$$;

-- ------------------------------------------------- rate-limited presence writes
--
-- Same behaviour as 0003 in every other respect. In particular the invisible
-- branch still refuses to move timestamps, and privacy is still applied at
-- write time so a hidden channel is never stored.

create or replace function public.report_presence(p_platform text, p_channel text)
returns void
language plpgsql
volatile
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor    uuid := public.require_actor();
  v_mode     text;
  v_platform text := nullif(btrim(coalesce(p_platform, '')), '');
  v_channel  text := nullif(lower(btrim(coalesce(p_channel, ''))), '');
begin
  if v_platform is not null and v_platform <> 'twitch' then
    raise exception 'kickback: unsupported platform %', v_platform using errcode = '22023';
  end if;

  if v_channel is not null then
    if v_channel !~ '^[a-z0-9_]{1,25}$' then
      raise exception 'kickback: invalid channel' using errcode = '22023';
    end if;
    if v_platform is null then
      raise exception 'kickback: channel requires a platform' using errcode = '22023';
    end if;
  end if;

  if not public.consume_presence_budget() then
    raise exception 'kickback: presence rate limit exceeded' using errcode = '53400';
  end if;

  select up.presence_visibility into v_mode
  from public.user_preferences up
  where up.user_id = v_actor;
  v_mode := coalesce(v_mode, 'visible');

  if v_mode = 'invisible' then
    -- Appear exactly as if offline. Crucially the timestamps are only touched
    -- when the row is not already blank: a friend watching last_seen_at tick
    -- upward could otherwise infer "online but hiding".
    update public.presence
       set status = 'offline', platform = null, channel = null,
           updated_at = now(), last_seen_at = now()
     where user_id = v_actor
       and (status <> 'offline' or platform is not null or channel is not null);
    return;
  end if;

  if v_mode = 'hide_activity' then
    v_platform := null;
    v_channel := null;
  end if;

  insert into public.presence (user_id, status, platform, channel, last_seen_at, updated_at)
  values (v_actor, 'online', v_platform, v_channel, now(), now())
  on conflict (user_id) do update
    set status = 'online',
        platform = excluded.platform,
        channel = excluded.channel,
        last_seen_at = now(),
        updated_at = now();
end;
$$;

create or replace function public.heartbeat()
returns void
language plpgsql
volatile
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor uuid := public.require_actor();
begin
  if not public.consume_presence_budget() then
    raise exception 'kickback: presence rate limit exceeded' using errcode = '53400';
  end if;

  update public.presence
     set last_seen_at = now()
   where user_id = v_actor
     and status = 'online';
end;
$$;

revoke all on function public.consume_presence_budget() from public, anon, authenticated;
grant execute on function public.report_presence(text, text) to authenticated;
grant execute on function public.heartbeat() to authenticated;
