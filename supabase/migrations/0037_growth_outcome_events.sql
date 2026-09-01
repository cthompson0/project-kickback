-- ===========================================================================
-- 0037 — the growth loop's outcomes, emitted from where they are decided
--
-- `referral_succeeded` and `badge_awarded` have been in the analytics contract
-- on both sides since 0026 and emitted by nothing. In a product whose thesis is
-- that the social graph drives discovery, the graph's own outcomes were the
-- least measured thing in it: we could not tell whether a single referral had
-- ever worked.
--
-- WHY SERVER-SIDE
--
-- Both facts are decided here, authoritatively, and neither is knowable to a
-- client without being told. `settle_referral` already stamps `succeeded_at`
-- exactly once under the three-condition rule from 0026, and `award_badge` is
-- already the only way a badge is ever granted. Emitting from anywhere else
-- would mean a client asserting something the server had decided - weaker, and
-- racier.
--
-- IDEMPOTENCY COMES FOR FREE
--
-- Both emissions sit inside guards that already exist and already fire once:
-- `succeeded_at is null` for the referral, `on conflict do nothing` for the
-- badge. There is no new idempotency to get wrong, which is the point of
-- putting the events here rather than beside them.
--
-- WHOSE EVENT IS IT
--
-- The referral belongs to the INVITER - they are the one who did the inviting,
-- and their count is what moves. The badge belongs to whoever earned it.
-- ===========================================================================

begin;

-- ---------------------------------------------------------------------------
-- A server-authoritative emitter.
-- ---------------------------------------------------------------------------

/*
 * Records one analytics event for a fact the SERVER established.
 *
 * `analytics_track` is the client's door: it takes `auth.uid()` as the actor
 * and is rightly the only thing a client may call. This is the other case -
 * an event nobody's browser is in a position to report, about a decision made
 * inside a function.
 *
 * WHY THE ENVIRONMENT IS LOOKED UP RATHER THAN PASSED
 *
 * A server-side fact has no build behind it, but every number is read per
 * environment and an event in the wrong bucket is worse than a missing one. The
 * actor's own most recent event is the honest answer to "which Watchside is
 * this person using", and 'production' is the conservative fallback.
 *
 * `session_id` is null on purpose. This genuinely happens outside a session -
 * the inviter may not even have a browser open - and inventing one would make a
 * server decision look like something somebody did.
 *
 * SECURITY DEFINER, granted to nobody. Only other server-side functions reach
 * it, exactly like `award_badge`.
 */
create or replace function public.analytics_emit_server(
  p_actor      uuid,
  p_event_name text,
  p_properties jsonb default '{}'::jsonb
)
returns void
language plpgsql
volatile
security definer
set search_path = public, pg_temp
as $$
declare
  v_environment text;
begin
  if p_actor is null then
    return;
  end if;

  -- The event must be one the contract knows, exactly as for a client event.
  if not exists (select 1 from public.analytics_event_names where name = p_event_name) then
    return;
  end if;

  -- Reportability needs an actor row; the client path upserts one too.
  insert into public.analytics_actors (user_id)
  values (p_actor)
  on conflict (user_id) do nothing;

  select e.environment into v_environment
    from public.analytics_events e
   where e.actor_id = p_actor
   order by e.occurred_at desc
   limit 1;

  insert into public.analytics_events
    (actor_id, environment, event_name, occurred_at, session_id, properties)
  values
    (p_actor, coalesce(v_environment, 'production'), p_event_name, now(), null,
     coalesce(p_properties, '{}'::jsonb));
end;
$$;

revoke all on function public.analytics_emit_server(uuid, text, jsonb)
  from public, anon, authenticated;

comment on function public.analytics_emit_server(uuid, text, jsonb) is
  'Records an analytics event for a fact the server established. Never callable '
  'by a client; the environment is the actor''s own most recent one.';

-- ---------------------------------------------------------------------------
-- The referral outcome.
-- ---------------------------------------------------------------------------

/*
 * Unchanged except for one line.
 *
 * The three-condition rule, the single-stamp guarantee and the badge award are
 * all exactly as 0026 wrote them. `referral_succeeded` is emitted inside the
 * `if found` block - the same guard that already proves this transition
 * happened once - so it cannot fire on a link visit, on authentication, on a
 * self-referral, on an unknown code, or twice on a retry.
 */
create or replace function public.settle_referral(p_invitee uuid)
returns void
language plpgsql
volatile
security definer
set search_path = public, pg_temp
as $$
declare
  v_row public.referrals%rowtype;
begin
  select * into v_row from public.referrals where invitee_id = p_invitee;
  if not found or v_row.succeeded_at is not null then
    return;
  end if;

  -- Condition 3: the intended connection.
  if v_row.friended_at is null and exists (
    select 1 from public.friendships f
     where f.user_id = v_row.inviter_id and f.friend_id = p_invitee
  ) then
    update public.referrals set friended_at = now() where invitee_id = p_invitee;
    v_row.friended_at := now();
  end if;

  if v_row.friended_at is null or v_row.activated_at is null then
    return;
  end if;

  update public.referrals
     set succeeded_at = now()
   where invitee_id = p_invitee and succeeded_at is null;

  if found then
    -- The inviter's event: they are the one who did the inviting, and theirs is
    -- the count that moves.
    perform public.analytics_emit_server(v_row.inviter_id, 'referral_succeeded');
    perform public.award_referral_badges(v_row.inviter_id);
  end if;
end;
$$;

revoke all on function public.settle_referral(uuid) from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- The badge outcome.
-- ---------------------------------------------------------------------------

/*
 * Was `language sql`; now plpgsql, only so the insert's outcome can be seen.
 *
 * The award itself is unchanged, including `on conflict do nothing` - which is
 * also what makes the event fire exactly once. A repeat award is a no-op and
 * emits nothing, so a badge cannot be counted twice however many times the
 * awarding path runs.
 */
create or replace function public.award_badge(p_user uuid, p_key text, p_reason text)
returns void
language plpgsql
volatile
security definer
set search_path = public, pg_temp
as $$
declare
  v_awarded boolean := false;
begin
  insert into public.user_badges (user_id, badge_key, reason)
  values (p_user, p_key, p_reason)
  on conflict (user_id, badge_key) do nothing;

  get diagnostics v_awarded = row_count;

  if v_awarded then
    perform public.analytics_emit_server(
      p_user, 'badge_awarded', jsonb_build_object('badge_key', p_key)
    );
  end if;
end;
$$;

revoke all on function public.award_badge(uuid, text, text) from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- Brand: the last human-facing "Kickback" in the product.
-- ---------------------------------------------------------------------------

/*
 * Badge descriptions still said Kickback, and they are shown to people.
 *
 * The M4.5 audit concluded no human-facing Kickback branding remained. That was
 * wrong, and wrong in the one place a code search would not look: these strings
 * live in the DATABASE, and reach the user through `my_badges()` and the badge
 * tooltip. Every other survivor is a type name, a CSS prefix or a storage key
 * that nobody sees.
 *
 * `issuer = 'kickback'` is deliberately NOT changed. It is an internal
 * discriminator - Watchside-issued versus Twitch-issued - that no user ever
 * sees, and released clients compare against that exact string. Renaming it
 * would be a compatibility break for cosmetic reasons.
 */
update public.badge_definitions
   set description = replace(description, 'Kickback', 'Watchside')
 where description like '%Kickback%';

-- ---------------------------------------------------------------------------
-- Schema marker.
-- ---------------------------------------------------------------------------

create or replace function public.analytics_schema_version()
returns int
language sql
immutable
set search_path = public, pg_temp
as $$ select 37; $$;

revoke all on function public.analytics_schema_version() from public, anon, authenticated;

commit;
