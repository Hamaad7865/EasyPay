-- 0138_stock_transfers.sql — stock sent from one branch to another
-- (docs/superpowers/specs/2026-10-27-multi-branch-design.md, section 7).
--
-- One step: what leaves one branch arrives at the other at the same moment, at the sending branch's average cost,
-- and the receiving branch's average moves with it. No "in transit", no receiving step, no undo: a mistake is sent
-- back with another transfer. It is not a sale: no receipt, no tax, nothing for the MRA. The item's total
-- (items.stock_qty) does not change.
--
--   stock_transfers, stock_transfer_lines
--                       what was sent, from where to where, by whom; numbered T-0001 per account. Written once:
--                       nothing updates or deletes them (block_update and no right, as deliveries). Not pulled by a till: the
--                       tills of both branches get their new levels by sequence, as for any stock change.
--   stock_movements     two reasons more: transfer_out at the sending branch, transfer_in at the receiving one,
--                       both under the transfer's reference, each with a note naming the other branch.
--   doc_counters        a counter for transfers; next_doc_number() writes T- for them.
--   stock_transfer(tenant, employee, from, to, lines, note)
--                       needs Adjust stock (stock.adjust). Refuses the same branch twice (same-branch), a branch not
--                       the account's (unknown-store), no lines (no-lines), a quantity of 0 or less (bad-quantity),
--                       what stock_line_ok refuses (a product that does not count stock, a variant to pick), and
--                       more than the sending branch holds: not-enough-stock:<item id>:<what it holds>.
--                       The same product on two lines is one line of their sum.
--
-- Locks: the engine's rule (0067) is that nothing locks an item's row and then asks for a level, and stock_move
-- updates items.stock_qty. So every level this transfer touches, at both branches, is locked first, in one order
-- (product, variant, branch), and checked under those locks; only then do the moves run. A sale at either branch
-- waits for the transfer, or the transfer for it, and never each for the other.
--
-- Source: next_doc_number is its live definition on dev on 2026-10-27 (0074's), with T- added. The rest is new.
-- Never edit after merge.

alter table doc_counters drop constraint if exists doc_counters_kind_check;
alter table doc_counters add constraint doc_counters_kind_check check (kind in ('po', 'delivery', 'count', 'transfer'));

create or replace function next_doc_number(p_tenant uuid, p_kind text) returns text
language plpgsql set search_path = public as $fn$
declare v_n integer;
begin
  insert into doc_counters (tenant_id, kind, next_no) values (p_tenant, p_kind, 2)
    on conflict (tenant_id, kind) do update set next_no = doc_counters.next_no + 1
    returning next_no - 1 into v_n;
  return (case p_kind when 'po' then 'PO-' when 'delivery' then 'D-' when 'transfer' then 'T-' else 'C-' end)
    || lpad(v_n::text, greatest(4, length(v_n::text)), '0');
end $fn$;

alter table stock_movements drop constraint if exists stock_movements_reason_check;
alter table stock_movements add constraint stock_movements_reason_check
  check (reason in ('sale', 'refund', 'adjust', 'count', 'receive', 'supplier_return', 'opening', 'damaged', 'expired',
                    'lost', 'internal', 'found', 'deposit', 'deposit_release', 'transfer_out', 'transfer_in'));

create table if not exists stock_transfers (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants (id) on delete cascade,
  number text not null,
  from_store uuid not null,
  to_store uuid not null,
  note text,
  employee_id uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  server_seq bigint,
  unique (tenant_id, id),
  unique (tenant_id, number),
  check (from_store <> to_store),
  foreign key (tenant_id, from_store) references stores (tenant_id, id) on delete cascade,
  foreign key (tenant_id, to_store) references stores (tenant_id, id) on delete cascade
);
alter table stock_transfers enable row level security;
alter table stock_transfers force row level security;
drop policy if exists tenant_isolation on stock_transfers;
create policy tenant_isolation on stock_transfers
  using (tenant_id = current_tenant_id())
  with check (tenant_id = current_tenant_id());
drop trigger if exists trg_touch on stock_transfers;
create trigger trg_touch before insert or update on stock_transfers
  for each row execute function touch_row();
create index if not exists idx_stock_transfers_tenant_seq on stock_transfers (tenant_id, server_seq);

create table if not exists stock_transfer_lines (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants (id) on delete cascade,
  transfer_id uuid not null,
  item_id uuid not null,
  variant_id uuid,
  qty integer not null check (qty > 0),
  unit_cost numeric(18,4),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  server_seq bigint,
  unique (tenant_id, id),
  foreign key (tenant_id, transfer_id) references stock_transfers (tenant_id, id) on delete cascade
);
alter table stock_transfer_lines enable row level security;
alter table stock_transfer_lines force row level security;
drop policy if exists tenant_isolation on stock_transfer_lines;
create policy tenant_isolation on stock_transfer_lines
  using (tenant_id = current_tenant_id())
  with check (tenant_id = current_tenant_id());
drop trigger if exists trg_touch on stock_transfer_lines;
create trigger trg_touch before insert or update on stock_transfer_lines
  for each row execute function touch_row();
create index if not exists idx_stock_transfer_lines_tenant_seq on stock_transfer_lines (tenant_id, server_seq);
create index if not exists idx_stock_transfer_lines_transfer on stock_transfer_lines (tenant_id, transfer_id);

-- a transfer is a record: insert-only, by trigger and by right, as a delivery is (0074)
drop trigger if exists trg_no_update on stock_transfers;
create trigger trg_no_update before update or delete on stock_transfers
  for each row execute function block_update();
drop trigger if exists trg_no_update on stock_transfer_lines;
create trigger trg_no_update before update or delete on stock_transfer_lines
  for each row execute function block_update();
revoke update, delete on stock_transfers, stock_transfer_lines from app_user;

create or replace function stock_transfer(
  p_tenant uuid, p_emp uuid, p_from uuid, p_to uuid, p_lines jsonb, p_note text
) returns uuid
language plpgsql set search_path = public as $fn$
declare
  v_id uuid := gen_random_uuid();
  v_number text;
  v_note text := nullif(btrim(coalesce(p_note, '')), '');
  v_from_name text;
  v_to_name text;
  v_line record;
  v_store uuid;
  v_level stock_levels%rowtype;
  v_out uuid;
  v_cost numeric;
begin
  if not coalesce(has_perm(p_emp, 'stock.adjust'), false) then raise exception 'forbidden'; end if;
  if p_from is null or p_to is null then raise exception 'unknown-store'; end if;
  if p_from = p_to then raise exception 'same-branch'; end if;
  select name into v_from_name from stores where tenant_id = p_tenant and id = p_from and deleted_at is null;
  select name into v_to_name from stores where tenant_id = p_tenant and id = p_to and deleted_at is null;
  if v_from_name is null or v_to_name is null then raise exception 'unknown-store'; end if;
  if p_lines is null or jsonb_typeof(p_lines) <> 'array' or jsonb_array_length(p_lines) = 0 then raise exception 'no-lines'; end if;
  if exists (select 1 from jsonb_to_recordset(p_lines) as l(item uuid, variant uuid, qty int) where l.item is null or l.qty is null or l.qty <= 0) then
    raise exception 'bad-quantity';
  end if;

  -- 1. every level, both branches, in one order, then the checks under those locks
  for v_line in
    select l.item, l.variant, sum(l.qty)::int as qty
      from jsonb_to_recordset(p_lines) as l(item uuid, variant uuid, qty int)
     group by l.item, l.variant
     order by l.item, l.variant nulls first
  loop
    perform stock_line_ok(p_tenant, v_line.item, v_line.variant);
    for v_store in select s from unnest(array[p_from, p_to]) s order by s loop
      perform stock_level_for(p_tenant, v_store, v_line.item, v_line.variant);
    end loop;
    select * into v_level from stock_levels
     where tenant_id = p_tenant and store_id = p_from and item_id = v_line.item and variant_id is not distinct from v_line.variant;
    if v_level.qty < v_line.qty then raise exception 'not-enough-stock:%:%', v_line.item, v_level.qty; end if;
  end loop;

  v_number := next_doc_number(p_tenant, 'transfer');
  insert into stock_transfers (id, tenant_id, number, from_store, to_store, note, employee_id)
    values (v_id, p_tenant, v_number, p_from, p_to, v_note, p_emp);

  -- 2. the moves, under the locks taken above: out at the sending branch's average, in at that cost
  for v_line in
    select l.item, l.variant, sum(l.qty)::int as qty
      from jsonb_to_recordset(p_lines) as l(item uuid, variant uuid, qty int)
     group by l.item, l.variant
     order by l.item, l.variant nulls first
  loop
    v_out := stock_move(p_tenant, p_from, v_line.item, v_line.variant, -v_line.qty, 'transfer_out', null, 'transfer', v_id, p_emp,
      'Transfer ' || v_number || ' to ' || v_to_name);
    select unit_cost into v_cost from stock_movements where id = v_out;
    -- a cost nobody knows (0) does not drag the receiving branch's average down: it arrives at that branch's own
    perform stock_move(p_tenant, p_to, v_line.item, v_line.variant, v_line.qty, 'transfer_in', nullif(v_cost, 0), 'transfer', v_id, p_emp,
      'Transfer ' || v_number || ' from ' || v_from_name);
    insert into stock_transfer_lines (tenant_id, transfer_id, item_id, variant_id, qty, unit_cost)
      values (p_tenant, v_id, v_line.item, v_line.variant, v_line.qty, v_cost);
  end loop;
  return v_id;
end $fn$;
