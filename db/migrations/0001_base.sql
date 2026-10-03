-- 0001_base.sql — extensions, sequence, tenant context, triggers
-- Never edit after merge. New changes go in new files.

create extension if not exists "pgcrypto";

create table if not exists schema_migrations (
  filename text primary key,
  applied_at timestamptz not null default now()
);

create sequence if not exists sync_seq as bigint increment by 1 start with 1;

-- Tenant context comes from a GUC set per-transaction by Neon Functions
-- after verifying the Neon Auth JWT and looking up employees.auth_user_id.
-- (Neon Auth JWTs carry no custom claims, so no auth.jwt() -> app_metadata.)
create or replace function current_tenant_id() returns uuid
language sql stable as $$
  select nullif(current_setting('app.tenant_id', true), '')::uuid
$$;

-- Stamps server_seq + updated_at, serialised per tenant so that
-- sequence order equals commit order within a tenant (spec 5.3).
create or replace function touch_row() returns trigger
language plpgsql as $$
begin
  if new.tenant_id is null then
    raise exception 'tenant_id must be set';
  end if;
  perform pg_advisory_xact_lock(hashtextextended(new.tenant_id::text, 0));
  new.server_seq := nextval('sync_seq');
  new.updated_at := now();
  return new;
end $$;

-- Blocks UPDATE/DELETE on insert-only tables (receipts, payments, audit...).
create or replace function block_update() returns trigger
language plpgsql as $$
begin
  raise exception 'table % is insert-only', TG_TABLE_NAME;
end $$;

-- Keeps tenants.tenant_id in sync with tenants.id so the
-- "every table has tenant_id" rule holds without caller friction.
create or replace function sync_tenant_pk() returns trigger
language plpgsql as $$
begin
  if new.tenant_id is null then
    new.tenant_id := new.id;
  end if;
  if new.tenant_id <> new.id then
    raise exception 'tenants.tenant_id must equal id';
  end if;
  return new;
end $$;
