-- Cancelling an invitation you sent.
--
-- The button can already say INVITE / PENDING / MEMBER, but PENDING was a
-- dead end: having invited the wrong person, the owner had no way to take it
-- back. The invite table already models this - status 'cancelled' is one of
-- its allowed values - so nothing new is stored; there was simply no way to
-- reach it.
--
-- Additive and idempotent: one new function, no table or policy changes.

begin;

create or replace function public.cancel_group_invite(p_group uuid, p_target uuid)
returns text
language plpgsql
volatile
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor uuid := public.require_actor();
  v_id    uuid;
begin
  -- Only the owner invites, so only the owner can un-invite. A non-owner gets
  -- the same answer as a stranger: no such group.
  if not exists (
    select 1 from public.groups g
    where g.id = p_group and g.owner_id = v_actor
  ) then
    raise exception 'kickback: group not found' using errcode = 'P0002';
  end if;

  -- Pending only. An invitation that was already accepted is a membership now,
  -- and cancelling must never be a way to remove a member through the back
  -- door - that is what remove_group_member is for, with its own rules.
  select i.id into v_id
  from public.group_invites i
  where i.group_id = p_group
    and i.to_user = p_target
    and i.status = 'pending'
  limit 1;

  if v_id is null then
    -- Nothing outstanding. Not an error: the invitation may have been answered
    -- a moment ago, and the caller's next refresh will show the truth.
    return 'not_pending';
  end if;

  update public.group_invites
  set status = 'cancelled', responded_at = now()
  where id = v_id;

  return 'cancelled';
end;
$$;

revoke all on function public.cancel_group_invite(uuid, uuid) from public, anon, authenticated;
grant execute on function public.cancel_group_invite(uuid, uuid) to authenticated;

commit;
