-- Globie Earth :: 030 :: row-level security
--
-- Every request arrives as the PostgREST 'anon' role. There is no login, so the
-- device UUID in the X-Device-Id header is the credential: it is a v4 UUID
-- (122 bits of entropy) that never leaves the device, and RLS pins every
-- device-scoped row to it. A caller without the header matches nothing.

-- Reads the header PostgREST exposes as the request.headers GUC.
create or replace function private.device_id() returns uuid
language sql
stable
as $$
  select nullif(
           current_setting('request.headers', true)::json ->> 'x-device-id',
           ''
         )::uuid
$$;

comment on function private.device_id() is
  'UUID from the X-Device-Id request header, or NULL. An unparseable value raises.';

-- RLS policies are evaluated as the requesting role, so anon needs EXECUTE.
grant execute on function private.device_id() to anon;

-- ------------------------------------------------------------- identity ----

alter table api.devices enable row level security;

drop policy if exists devices_select on api.devices;
create policy devices_select on api.devices
  for select to anon using (id = private.device_id());

drop policy if exists devices_insert on api.devices;
create policy devices_insert on api.devices
  for insert to anon with check (id = private.device_id());

drop policy if exists devices_update on api.devices;
create policy devices_update on api.devices
  for update to anon
  using (id = private.device_id())
  with check (id = private.device_id());

-- ------------------------------------------- catalog: world-readable -----

alter table api.species enable row level security;
drop policy if exists species_read on api.species;
create policy species_read on api.species
  for select to anon using (true);

alter table api.guardians enable row level security;
drop policy if exists guardians_read on api.guardians;
create policy guardians_read on api.guardians
  for select to anon using (true);

alter table api.sites enable row level security;
drop policy if exists sites_read on api.sites;
create policy sites_read on api.sites
  for select to anon using (true);

-- Embeddings are reached only through the similarity functions in
-- 040_functions.sql. Those are SECURITY DEFINER, so they bypass this; direct
-- access is closed off entirely.
alter table api.embeddings enable row level security;
revoke all on api.embeddings from anon;
revoke all on sequence api.embeddings_id_seq from anon;

-- ------------------------------------- device-scoped: owner-only rows -----

do $$
declare
  t text;
begin
  foreach t in array array[
    'adoptions',
    'living_deeds',
    'guardian_pledges',
    'sponsors',
    'sponsorships',
    'eco_token_balance'
  ]
  loop
    execute format('alter table api.%I enable row level security', t);
    execute format('drop policy if exists %I on api.%I', t || '_owner', t);
    execute format(
      'create policy %I on api.%I for all to anon
         using (device_id = private.device_id())
         with check (device_id = private.device_id())',
      t || '_owner', t
    );
  end loop;
end
$$;

-- The ledger is append-only: allow insert + select, never update or delete.
alter table api.eco_token_ledger enable row level security;
revoke update, delete on api.eco_token_ledger from anon;

drop policy if exists eco_token_ledger_select on api.eco_token_ledger;
create policy eco_token_ledger_select on api.eco_token_ledger
  for select to anon using (device_id = private.device_id());

drop policy if exists eco_token_ledger_insert on api.eco_token_ledger;
create policy eco_token_ledger_insert on api.eco_token_ledger
  for insert to anon with check (device_id = private.device_id());
