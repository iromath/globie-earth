-- Globie Earth :: 070 :: web accounts (Google sign-in)
--
-- The shipped native app authenticates with the anonymous device UUID only:
-- 030_rls.sql pins every device-scoped row to the X-Device-Id header. The web
-- app adds a real account on top. Google sign-in is completed by the auth
-- service in infra/docker-compose.yml, which keeps its users in the auth
-- schema of this same database and mints a JWT signed with PGRST_JWT_SECRET.
-- PostgREST already verifies that signature, so RLS can trust the sub claim
-- without any application code having to.
--
-- Every statement below is additive and idempotent: it is safe to apply to the
-- live database, and a request carrying only X-Device-Id (the shipped Android
-- build) keeps matching exactly the rows it matches today.

-- The account id, taken from the verified JWT. PostgREST exposes the claims as
-- the request.jwt.claims GUC; a request without a token has no 'sub'.
create or replace function private.user_id() returns uuid
language sql
stable
as $$
  select nullif(
           current_setting('request.jwt.claims', true)::json ->> 'sub',
           ''
         )::uuid
$$;

comment on function private.user_id() is
  'Account UUID from the verified JWT sub claim, or NULL for device-only callers.';

grant execute on function private.user_id() to anon;

-- ------------------------------------------------------------- accounts ----

-- Profile row for an account. id is the auth service's user id, so this table
-- holds what the app needs and not identity state: credentials and OAuth tokens
-- stay with the auth service. Deliberately no foreign key into the auth schema,
-- so this schema loads whether or not the auth service has migrated yet.
create table if not exists api.users (
  id           uuid primary key,
  email        text,
  display_name text,
  avatar_url   text,
  locale       text,
  created_at   timestamptz not null default now(),
  last_seen_at timestamptz not null default now()
);

-- Case-insensitive, and partial because a Google account may withhold an email.
create unique index if not exists users_email_uidx
  on api.users (lower(email))
  where email is not null;

comment on table api.users is
  'Web account profile. id is the auth service user id and the RevenueCat appUserID.';

alter table api.users enable row level security;

drop policy if exists users_select on api.users;
create policy users_select on api.users
  for select to anon using (id = private.user_id());

drop policy if exists users_insert on api.users;
create policy users_insert on api.users
  for insert to anon with check (id = private.user_id());

drop policy if exists users_update on api.users;
create policy users_update on api.users
  for update to anon
  using (id = private.user_id())
  with check (id = private.user_id());

-- -------------------------------------------------- rows owned by account ----

-- A row may belong to a device (native, today) or to an account (web). The
-- device policies in 030_rls.sql stay in force; these are added alongside them,
-- and policies are permissive, so access is the union of the two. A device-only
-- caller therefore sees no change at all.
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
    execute format(
      'alter table api.%I add column if not exists user_id uuid references api.users(id) on delete set null',
      t
    );
    execute format(
      'create index if not exists %I on api.%I (user_id) where user_id is not null',
      t || '_user_idx', t
    );
    execute format('drop policy if exists %I on api.%I', t || '_account', t);
    execute format(
      'create policy %I on api.%I for all to anon
         using (user_id = private.user_id())
         with check (user_id = private.user_id())',
      t || '_account', t
    );
  end loop;
end
$$;

-- The ledger is append-only, so it gets select + insert and nothing else. The
-- revoke in 030_rls.sql already denies update and delete at the privilege level;
-- this keeps the intent explicit rather than relying on that.
alter table api.eco_token_ledger
  add column if not exists user_id uuid references api.users(id) on delete set null;

create index if not exists eco_token_ledger_user_idx
  on api.eco_token_ledger (user_id) where user_id is not null;

drop policy if exists eco_token_ledger_account_select on api.eco_token_ledger;
create policy eco_token_ledger_account_select on api.eco_token_ledger
  for select to anon using (user_id = private.user_id());

drop policy if exists eco_token_ledger_account_insert on api.eco_token_ledger;
create policy eco_token_ledger_account_insert on api.eco_token_ledger
  for insert to anon with check (user_id = private.user_id());
