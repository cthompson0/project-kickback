-- Invitations a group owner has sent.
--
-- `list_group_invites` answers "who invited ME". Nothing answered "who have I
-- invited", so the invite button had no state to show: it said INVITE before
-- the click and INVITE after it, and said INVITE for people who were already
-- members. The server always knew - `invite_to_group` returns 'already_member'
-- and 'already_invited' - but the UI could not ask until the moment it acted.
--
-- Read-only and additive. No table changes, no policy changes.
--
-- Idempotent: safe to run against a database that already has it.

begin;

create or replace function public.list_group_sent_invites(p_group uuid)
returns table (
  invite_id  uuid,
  to_user    uuid,
  created_at timestamptz
)
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor uuid := public.require_actor();
begin
  -- Only the owner can invite, so only the owner has sent invitations to look
  -- at. A non-owner is told the group does not exist, exactly as they are for
  -- every other owner action - the same answer a stranger gets.
  if not exists (
    select 1 from public.groups g
    where g.id = p_group and g.owner_id = v_actor
  ) then
    raise exception 'kickback: group not found' using errcode = 'P0002';
  end if;

  -- Pending only. A declined or cancelled invitation is not outstanding, and
  -- the person becomes invitable again - which is the existing backend
  -- semantics, surfaced rather than changed.
  return query
    select i.id, i.to_user, i.created_at
    from public.group_invites i
    where i.group_id = p_group and i.status = 'pending'
    order by i.created_at;
end;
$$;

revoke all on function public.list_group_sent_invites(uuid) from public, anon, authenticated;
grant execute on function public.list_group_sent_invites(uuid) to authenticated;

commit;
