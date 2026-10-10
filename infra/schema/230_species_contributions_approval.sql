-- Globie Earth :: 230 :: approving contributed photographs
--
-- 220_species_contributions.sql made a visitor's photograph a real queue entry:
-- scanned, stored, and recorded as `pending`. It ended by saying that accepting
-- one - flipping the row to `approved` so the species page could show it - was
-- "a later step". This is that step, and it is the second half of the feature.
--
-- Two things are added, and together they answer "who may approve":
--
--   1. A way to BE a moderator. api.moderators holds one row per device allowed
--      to review the queue. It is keyed by device id and references api.devices,
--      so a moderator is an ordinary device first and gaining the role is one
--      row, not a second auth surface. There is no `authenticated` and no
--      `service_role` in this stack (010_bootstrap.sql) and GoTrue stamps every
--      caller `anon`, so a JWT role claim could not carry this even if we wanted
--      it to; a device-id table is the credential the schema already speaks.
--
--   2. The transition itself. private.is_moderator() reads that table, and the
--      policies below let a moderator read any row and move it pending ->
--      approved | rejected. An `approved` row then becomes world-readable, which
--      is the whole point: it is what puts a contributed photograph on the page.
--
-- Everything 220 decided still holds. A contribution is still never rewritten
-- from the browser: a contributor has no UPDATE grant and no policy to update
-- through. The only UPDATE the database permits is a moderator's, and the grant
-- is column-scoped so even that can touch nothing but the three review columns.
--
-- The demo device the MCP server authenticates as is seeded as a moderator, so
-- the approve path works end to end the moment this runs. It is marked for
-- removal in the seed itself.

-- ------------------------------------------------------- the moderator role --

create table if not exists api.moderators (
  -- The reviewing device, already a row in api.devices. It is the primary key,
  -- so a device cannot hold the role twice.
  device_id  uuid primary key references api.devices(id) on delete cascade,
  -- Who this is and why, for the human reading the table later.
  note       text,
  created_at timestamptz not null default now()
);

comment on table api.moderators is
  'Devices allowed to review api.species_contributions. Membership is the whole credential: private.is_moderator() reads it and the queue policies test it. Appoint a moderator with one insert; revoke by deleting the row.';

alter table api.moderators enable row level security;

-- A device may read its own row - which is both how the app answers "may I
-- review?" and all private.is_moderator() needs to see. Reading anyone else's
-- row is not permitted, so the roster itself is not exposed.
drop policy if exists moderators_self_select on api.moderators;
create policy moderators_self_select on api.moderators
  for select to anon using (device_id = private.device_id());

-- Membership is not a browser write. 010_bootstrap.sql granted anon select,
-- insert, update and delete on every new api table by default; the select is
-- wanted (narrowed above to the caller's own row), so it is granted explicitly
-- rather than assumed, and the three writes are taken back. Only an operator -
-- a migration or a SQL session - can appoint a moderator.
grant select on api.moderators to anon;
revoke insert, update, delete on api.moderators from anon;

/**
 * Is the caller a moderator? The one predicate the queue policies depend on.
 *
 * SECURITY INVOKER on purpose: anon already has SELECT on api.moderators,
 * narrowed by moderators_self_select to its own row, so this reads exactly one
 * thing - the caller's own membership - with no privilege of its own to leak.
 */
create or replace function private.is_moderator() returns boolean
language sql
stable
as $$
  select exists (
    select 1 from api.moderators where device_id = private.device_id()
  )
$$;

comment on function private.is_moderator() is
  'True when the X-Device-Id caller is listed in api.moderators. Reached from the review policies; also the honest answer to "may this device review?".';

grant execute on function private.is_moderator() to anon;

-- -------------------------------------------------------- reviewer metadata --

-- A decision needs a who and a when, or the queue cannot be audited. Both are
-- null until a moderator acts: `pending` is the absence of a review, not a
-- review with an empty verdict.
alter table api.species_contributions
  add column if not exists reviewed_by uuid
    references api.devices(id) on delete set null,
  add column if not exists reviewed_at timestamptz;

comment on column api.species_contributions.reviewed_by is
  'The moderator device that approved or rejected the row, or NULL while pending.';
comment on column api.species_contributions.reviewed_at is
  'When the moderator decided, or NULL while pending.';

-- ---------------------------------------------- the queue becomes public ----

-- An approved photograph has to load on the species page of a device that never
-- contributed anything, so `approved` rows are readable by anyone. This policy
-- is permissive: it ORs with 220's owner-only select, which stays in place, so a
-- contributor still sees their own pending rows and nobody else's.
drop policy if exists species_contributions_select_approved on api.species_contributions;
create policy species_contributions_select_approved on api.species_contributions
  for select to anon using (status = 'approved');

-- A moderator reads the whole queue - pending, approved and rejected - which is
-- what a queue is. Permissive again, so it adds to the two selects above.
drop policy if exists species_contributions_select_moderator on api.species_contributions;
create policy species_contributions_select_moderator on api.species_contributions
  for select to anon using (private.is_moderator());

-- The update 220 withheld. `revoke update ... from anon` stays in force at table
-- scope; this grants UPDATE on three columns only, so even a moderator cannot
-- rewrite a contribution's photo, its scanner verdict or who submitted it - only
-- the verdict and the reviewer. That keeps 220's rule (a submission is a record
-- of what was handed in) while still permitting the review.
grant update (status, reviewed_by, reviewed_at) on api.species_contributions to anon;

drop policy if exists species_contributions_moderate on api.species_contributions;
create policy species_contributions_moderate on api.species_contributions
  for update to anon
  using (private.is_moderator())
  with check (private.is_moderator());

-- 220's updated_at would otherwise never move, because 220 shipped no update
-- path at all. The review is the first UPDATE this table ever sees - and so the
-- first time updated_at has anything to say - so keep it honest.
create or replace function private.touch_updated_at() returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end
$$;

drop trigger if exists species_contributions_touch on api.species_contributions;
create trigger species_contributions_touch
  before update on api.species_contributions
  for each row execute function private.touch_updated_at();

-- ------------------------------------------------------------------ seed -----
--
-- The MCP server's demo device: the identity a static MCP_BEARER_TOKEN is
-- exchanged for (infra/mcp/src/identity.ts, decision D4). Making it a moderator
-- is what lets the approve path be exercised end to end immediately, with no
-- second client.
--
-- REMOVE THIS once a real moderator is appointed:
--   delete from api.moderators
--    where device_id = '00000000-0000-4000-8000-000000000001';
--
-- The device row comes first: api.moderators references api.devices, and on a
-- fresh stack the demo device has never called the API and so does not exist.
insert into api.devices (id, platform, locale)
values ('00000000-0000-4000-8000-000000000001', 'server', 'en')
on conflict (id) do nothing;

insert into api.moderators (device_id, note)
values (
  '00000000-0000-4000-8000-000000000001',
  'Seeded demo moderator (MCP_DEMO_DEVICE_ID). Remove once a real moderator exists.'
)
on conflict (device_id) do nothing;

-- A table created by an operator rather than by 010's init run is invisible to
-- PostgREST until it is told; the notification is what makes api.moderators
-- reachable without a restart.
notify pgrst, 'reload schema';
