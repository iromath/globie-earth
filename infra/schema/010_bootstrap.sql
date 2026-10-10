-- Globie Earth :: 010 :: extensions, schemas, roles, app config
-- Runs once, on first init of an empty db_data volume.

set search_path = public;

create extension if not exists "uuid-ossp";
create extension if not exists pgcrypto;
create extension if not exists pg_trgm;
create extension if not exists vector;

create schema if not exists api;
create schema if not exists private;

comment on schema api is 'PostgREST-exposed surface for the Globie Earth app.';
comment on schema private is 'Internal helpers. Not exposed through PostgREST.';

-- GoTrue (the `auth` service) migrates into a schema it does not create:
-- its first migration is named 00_init_auth_schema.up.sql but only issues
-- `create table ... auth.users` and friends - never `create schema auth`. On
-- Supabase that schema is made by Supabase's own bootstrap, which is absent
-- here, so without this the auth container dies on its very first migration
-- with `ERROR: schema "auth" does not exist` and crash-loops. Owned by the
-- migration role, which is also what DATABASE_URL connects as, so GoTrue can
-- create its tables inside it.
create schema if not exists auth;

comment on schema auth is 'GoTrue auth tables. Must pre-exist - GoTrue does not create it.';

-- One later GoTrue migration (20240612123726_enable_rls_update_grants) ends with
-- `grant select on auth.<each table> to postgres with grant option`. There is no
-- `postgres` role in this stack - the superuser is POSTGRES_USER - so that grant
-- aborts the migration and the container crash-loops again. Create it as a bare
-- NOLOGIN role: it is only ever the target of those grants, never a login.
do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'postgres') then
    create role postgres noinherit nologin;
  end if;
end
$$;

-- Anonymous device identity.
-- 'anon' is the role PostgREST switches to for unauthenticated requests. The
-- device UUID travels in the X-Device-Id header and acts as the bearer
-- credential; row-level security scopes every row to it. See 030_rls.sql.
do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'anon') then
    create role anon noinherit nologin;
  end if;
end
$$;

grant usage on schema api to anon;
grant usage on schema private to anon;

-- Applies to objects created by this migration role from here on.
alter default privileges in schema api
  grant select, insert, update, delete on tables to anon;
alter default privileges in schema api
  grant usage, select on sequences to anon;
alter default privileges in schema api
  grant execute on functions to anon;

-- Embedding provenance. The client reads this to confirm its vectors match the
-- stored dimension before sending them. Change both rows together, then
-- re-embed: the vector() dimension below is the only other place it appears.
create table if not exists api.app_config (
  key        text primary key,
  value      text not null,
  updated_at timestamptz not null default now()
);

insert into api.app_config (key, value) values
  ('embedding_model', 'amazon.titan-embed-text-v1'),
  ('embedding_dims',  '1536'),
  ('schema_version',  '1')
on conflict (key) do update
  set value = excluded.value,
      updated_at = now();

alter table api.app_config enable row level security;

drop policy if exists app_config_read on api.app_config;
create policy app_config_read on api.app_config
  for select to anon using (true);
