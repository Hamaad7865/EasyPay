-- 0107: a takeaway nobody came for (no-show).
--
-- The owner: "Sometimes customers place orders and they dont show up - so we
-- should add a no show if paid thats fine. If not paid include it in Z report".
--
-- A booking could be marked no-show; a takeaway or delivery could not. One
-- never collected stayed on the board, and unpaid it held up closing the day
-- until every item on it was voided, which left nothing to say what was lost.
--
-- tickets gets four columns, all empty on every order until one is marked:
--   no_show_at      when it was marked, by the till's clock (the day closings
--                   are cut by that clock too);
--   no_show_total   what was still to pay, in cents: what the day closing
--                   shows as lost. 0 on an order that was paid;
--   no_show_by      who marked it;
--   no_show_device  the till it was marked on: a day closing is one till's.
--
-- ticket.cancel {ticket_id, no_show: {total, at, device_id}, approved_by?}
--   - an open order is closed ('cancelled'), off its table and off the board,
--     WITH its items left on it: they were cooked, and they say what it was.
--     Without no_show, an order with items on it is still refused
--     ('conflict'), as 0057 has it;
--   - a paid order stays paid: it leaves the board, is marked, and owes
--     nothing whatever the till sent as total;
--   - one already marked, or cancelled some other way, is answered as it
--     stands, so a till that sends it twice is not refused and changes nothing;
--   - a till that is not this restaurant's is not kept.
-- The permission is the till's to ask for (the one to void an item the
-- kitchen already has), as for a void: what the till has done is not refused
-- here; who approved it is kept by sync_push with the op, as for every op.
--
-- It is not a sale: no receipt, no payment, no tax. The back office's Day
-- closing page reads these columns for the line it shows.
--
-- push_ticket_cancel is rebuilt from its live definition (0057, read on dev
-- with pg_get_functiondef on 2026-10-13).

alter table tickets add column if not exists no_show_at timestamptz;
alter table tickets add column if not exists no_show_total bigint;
alter table tickets add column if not exists no_show_by uuid;
alter table tickets add column if not exists no_show_device uuid;

-- the Day closing page asks for one till's no-shows between two moments
create index if not exists tickets_no_show on tickets (tenant_id, no_show_device, no_show_at) where no_show_at is not null;

create or replace function push_ticket_cancel(p_tenant uuid, p_emp uuid, p jsonb)
returns jsonb language plpgsql set search_path = public as $fn$
declare v_ticket uuid; v_status text; v_ns jsonb; v_was timestamptz; v_total bigint; v_at timestamptz; v_dev uuid;
begin
  v_ticket := (p->>'ticket_id')::uuid;
  if v_ticket is null then raise exception 'bad-payload'; end if;
  v_ns := p->'no_show';
  if v_ns is not null and jsonb_typeof(v_ns) <> 'object' then raise exception 'bad-payload'; end if;
  select status, no_show_at into v_status, v_was from tickets where id = v_ticket and tenant_id = p_tenant for update;
  if not found then raise exception 'bad-ticket'; end if;

  if v_ns is not null then
    if v_was is not null or v_status = 'cancelled' then
      return jsonb_build_object('ticket_id', v_ticket, 'status', v_status, 'no_show', v_was is not null);
    end if;
    v_total := coalesce((v_ns->>'total')::bigint, 0);
    if v_total < 0 then raise exception 'bad-payload'; end if;
    v_at := coalesce((v_ns->>'at')::timestamptz, now());
    select id into v_dev from pos_devices where tenant_id = p_tenant and id = nullif(v_ns->>'device_id', '')::uuid;
    update tickets set
        status = case when v_status = 'open' then 'cancelled' else status end,
        table_id = case when v_status = 'open' then null else table_id end,
        stage = case when stage is null then null else 'done' end,
        no_show_at = v_at,
        no_show_total = case when v_status = 'open' then v_total else 0 end,
        no_show_by = p_emp,
        no_show_device = v_dev
      where id = v_ticket and tenant_id = p_tenant;
    return jsonb_build_object('ticket_id', v_ticket,
      'status', case when v_status = 'open' then 'cancelled' else v_status end, 'no_show', true);
  end if;

  if v_status <> 'open' then
    return jsonb_build_object('ticket_id', v_ticket, 'status', v_status);
  end if;
  if exists (select 1 from ticket_lines l
              where l.tenant_id = p_tenant and l.ticket_id = v_ticket and l.voided_at is null and l.deleted_at is null) then
    raise exception 'conflict';
  end if;
  update tickets set status = 'cancelled', table_id = null,
      stage = case when stage is null then null else 'done' end
    where id = v_ticket and tenant_id = p_tenant;
  return jsonb_build_object('ticket_id', v_ticket, 'status', 'cancelled');
end $fn$;
