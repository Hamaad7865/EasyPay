-- 0146_assistant.sql — EasyPay in Claude, release 1a (spec docs/superpowers/specs/
-- 2026-10-29-easypay-in-claude-design.md): what the owner's Claude needs to sign in to a business, to
-- show a change before it is made, to make it on Confirm, and to keep a log of it.
--
--   - assistant_clients: each Claude that registered itself (OAuth dynamic client registration). Not a
--     business's: read and written only by the sign-in endpoints, as the owner role.
--   - assistant_codes: a sign-in's one-time code, with its PKCE challenge, for the few minutes between
--     Allow and Claude fetching its tokens. Used once.
--   - assistant_grants: a connection. One person of one business, through one Claude. Its tokens are
--     kept as SHA-256 hashes, never themselves. Ended by Disconnect, or by the person losing Use the
--     assistant, leaving, or the plan no longer having it. The sign-in endpoints look a token up as the
--     owner role (it says which business it is); the back office's Connected apps reads them as the
--     business.
--   - assistant_proposals: a change worked out and shown, not made. What Confirm runs is what is stored
--     here, never anything sent with the confirm; its one-time code is kept hashed; it lasts 15 minutes.
--   - assistant_log: every change confirmed, with what was asked, and what Restore needs to undo a delete
--     for 30 days.
--   - catalog_start_over: while the business is being set up, one change hides its every product, line
--     and category. Nothing else: its sales, tills, staff, settings, customers and suppliers stay.
--     Restore brings them back.

create table if not exists assistant_clients (
  client_id text primary key,
  name text,
  redirect_uris text[] not null,
  created_at timestamptz not null default now()
);
alter table assistant_clients enable row level security;

create table if not exists assistant_codes (
  code_hash text primary key,
  client_id text not null references assistant_clients (client_id) on delete cascade,
  tenant_id uuid not null references tenants (id) on delete cascade,
  employee_id uuid not null,
  redirect_uri text not null,
  challenge text not null,
  resource text,
  expires_at timestamptz not null,
  used_at timestamptz
);
alter table assistant_codes enable row level security;

create table if not exists assistant_grants (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants (id) on delete cascade,
  employee_id uuid not null,
  client_id text not null references assistant_clients (client_id) on delete cascade,
  access_hash text unique,
  access_expires timestamptz,
  refresh_hash text unique,
  created_at timestamptz not null default now(),
  last_used_at timestamptz,
  ended_at timestamptz,
  ended_why text,
  unique (tenant_id, id)
);
-- not forced: the owner role looks a token up before it knows the business
alter table assistant_grants enable row level security;
drop policy if exists tenant_isolation on assistant_grants;
create policy tenant_isolation on assistant_grants
  using (tenant_id = current_tenant_id())
  with check (tenant_id = current_tenant_id());

create table if not exists assistant_proposals (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants (id) on delete cascade,
  grant_id uuid,
  employee_id uuid not null,
  kind text not null,
  asked text,
  params jsonb not null,
  card jsonb not null,
  touched jsonb not null default '{}'::jsonb,
  code_hash text not null,
  expires_at timestamptz not null,
  used_at timestamptz,
  created_at timestamptz not null default now(),
  unique (tenant_id, id)
);
alter table assistant_proposals enable row level security;
alter table assistant_proposals force row level security;
drop policy if exists tenant_isolation on assistant_proposals;
create policy tenant_isolation on assistant_proposals
  using (tenant_id = current_tenant_id())
  with check (tenant_id = current_tenant_id());

create table if not exists assistant_log (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants (id) on delete cascade,
  employee_id uuid not null,
  grant_id uuid,
  proposal_id uuid,
  kind text not null,
  asked text,
  summary text not null,
  before jsonb,
  after jsonb,
  -- what Restore puts back, for a delete or a start over: the rows it hid and the stock it wrote off
  undo jsonb,
  restorable_until timestamptz,
  restored_at timestamptz,
  created_at timestamptz not null default now(),
  unique (tenant_id, id)
);
alter table assistant_log enable row level security;
alter table assistant_log force row level security;
drop policy if exists tenant_isolation on assistant_log;
create policy tenant_isolation on assistant_log
  using (tenant_id = current_tenant_id())
  with check (tenant_id = current_tenant_id());
create index if not exists assistant_log_recent on assistant_log (tenant_id, created_at desc);

-- Start over. It runs as its owner because whether a business is being set up is the platform's to say;
-- so it is refused for any business but the one the caller's transaction is for. Subs go before their
-- categories (a category with live subs is not removed, 0145). It returns what it hid, for Restore.
create or replace function catalog_start_over(p_tenant uuid) returns jsonb
language plpgsql security definer set search_path = public as $fn$
declare
  v_items uuid[]; v_lines uuid[]; v_subs uuid[]; v_tops uuid[];
begin
  if p_tenant is distinct from current_tenant_id() then raise exception 'forbidden'; end if;
  if not exists (select 1 from platform.setting_up where tenant_id = p_tenant) then raise exception 'live'; end if;
  select coalesce(array_agg(id), '{}') into v_lines from item_variants where tenant_id = p_tenant and deleted_at is null;
  select coalesce(array_agg(id), '{}') into v_items from items where tenant_id = p_tenant and deleted_at is null;
  select coalesce(array_agg(id), '{}') into v_subs from categories where tenant_id = p_tenant and deleted_at is null and parent_id is not null;
  select coalesce(array_agg(id), '{}') into v_tops from categories where tenant_id = p_tenant and deleted_at is null and parent_id is null;
  update item_variants set deleted_at = now() where tenant_id = p_tenant and id = any(v_lines);
  update items set deleted_at = now() where tenant_id = p_tenant and id = any(v_items);
  update categories set deleted_at = now() where tenant_id = p_tenant and id = any(v_subs);
  update categories set deleted_at = now() where tenant_id = p_tenant and id = any(v_tops);
  return jsonb_build_object('items', to_jsonb(v_items), 'lines', to_jsonb(v_lines), 'categories', to_jsonb(v_tops || v_subs));
end $fn$;

-- Whether the business is still being set up: Start over is offered only then.
create or replace function catalog_setting_up(p_tenant uuid) returns boolean
language sql stable security definer set search_path = public as $fn$
  select p_tenant = current_tenant_id() and exists (select 1 from platform.setting_up where tenant_id = p_tenant);
$fn$;
