-- 0125: an order with nothing left to pay is closed by ticket.cancel, as paid.
--
-- Only a payment closed an order. Check 1 of a split bill paid, then check
-- 2's items taken off (the guest left, a wrong item): the order then had only
-- paid lines and nothing to pay, nothing closed it, and its table stayed
-- taken for good, on the server as on the till (the restaurant review of
-- 2026-10-20). The till now sends ticket.cancel for such an order, after the
-- last unpaid item is taken off or from the floor for one left open that way
-- by an older build; it is closed here as 'paid', as the last payment would
-- have closed it (push_receipt_create). Its lines stay as they are.
--
-- Otherwise as 0107 has it: an order with something still to pay is refused
-- ('conflict'), an empty one is cancelled, a closed one is answered as it
-- stands, a no-show is as before. Rebuilt from 0107_no_show.sql, the last to
-- write it; only the branch for a settled order is new.

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
  -- something on it was paid and nothing on it is still to pay: done, as paid
  if exists (select 1 from ticket_lines l
              where l.tenant_id = p_tenant and l.ticket_id = v_ticket and l.voided_at is null and l.deleted_at is null)
     and not exists (select 1 from ticket_lines l
              where l.tenant_id = p_tenant and l.ticket_id = v_ticket and l.voided_at is null and l.deleted_at is null and not l.paid) then
    update tickets set status = 'paid' where id = v_ticket and tenant_id = p_tenant;
    return jsonb_build_object('ticket_id', v_ticket, 'status', 'paid');
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
