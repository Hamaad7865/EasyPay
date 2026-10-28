-- 0148_assistant_calls.sql — every call the owner's Claude makes to EasyPay, kept for a while (the owner,
-- 2026-10-29: "safety first"): which tool, by whom, what it answered (done, a question back, a refusal,
-- an error) and how long it took. Confirmed changes are in assistant_log already; this shows what
-- confused Claude, where a tool's words need to change, and what a shop asks most. Its arguments are
-- kept short (the first 2000 characters), never a token or a Confirm code.

create table if not exists assistant_calls (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants (id) on delete cascade,
  employee_id uuid,
  grant_id uuid,
  tool text not null,
  args text,
  outcome text not null check (outcome in ('ok', 'asked', 'refused', 'error')),
  said text,
  ms integer,
  created_at timestamptz not null default now(),
  unique (tenant_id, id)
);
alter table assistant_calls enable row level security;
alter table assistant_calls force row level security;
drop policy if exists tenant_isolation on assistant_calls;
create policy tenant_isolation on assistant_calls
  using (tenant_id = current_tenant_id())
  with check (tenant_id = current_tenant_id());
create index if not exists assistant_calls_recent on assistant_calls (tenant_id, created_at desc);
