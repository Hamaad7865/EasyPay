-- 0078_split_keeps_price.sql
-- A line divided for a split check (ticket.split_line) made its second part
-- with the columns it knew by name, so the part taken off lost what migration
-- 0077 added: the price the line was listed at, and why and by whom it is
-- charged another. The receipt for that part then took the charged price for
-- the listed one, flagged it as price drift, and printed no "was". The till
-- copies the whole line; the server now does too.
--
-- push_ticket_split_line as it is, with that insert changed.

CREATE OR REPLACE FUNCTION public.push_ticket_split_line(p_tenant uuid, p_emp uuid, p jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
declare v_line uuid; v_new uuid; v_qty int; l record;
begin
  v_line := (p->>'line_id')::uuid;
  v_new := (p->>'new_id')::uuid;
  v_qty := coalesce((p->>'qty')::int, 0);
  if v_line is null or v_new is null then raise exception 'bad-payload'; end if;
  select tl.* into l from ticket_lines tl
    join tickets t on t.tenant_id = tl.tenant_id and t.id = tl.ticket_id
   where tl.id = v_line and tl.tenant_id = p_tenant and t.status = 'open'
     and tl.voided_at is null and tl.deleted_at is null
   for update of tl;
  if not found then raise exception 'bad-line'; end if;
  if l.paid then raise exception 'paid-line'; end if;
  -- whole units, and something has to stay on the line
  if v_qty <= 0 or v_qty % 1000 <> 0 or l.qty % 1000 <> 0 or v_qty >= l.qty then raise exception 'bad-qty'; end if;
  if exists (select 1 from ticket_line_modifiers m
      where m.tenant_id = p_tenant and m.line_id = v_line and m.deleted_at is null and m.price <> 0) then
    raise exception 'bad-modifier';
  end if;
  update ticket_lines set qty = qty - v_qty where id = v_line and tenant_id = p_tenant;
  -- the part taken off is the same line in everything but its quantity: what
  -- it was listed at and who allowed its price go with it (0078)
  insert into ticket_lines (id, tenant_id, ticket_id, item_id, variant_id, name_snapshot, unit_price, qty,
      note, course, seat, paid, sent_to_kitchen_at, kitchen_status, list_price, price_kind, price_label, price_by)
    values (v_new, p_tenant, l.ticket_id, l.item_id, l.variant_id, l.name_snapshot, l.unit_price, v_qty,
      l.note, l.course, l.seat, false, l.sent_to_kitchen_at, l.kitchen_status, l.list_price, l.price_kind, l.price_label, l.price_by);
  insert into ticket_line_taxes (tenant_id, line_id, tax_id, name_snapshot, rate_bp, type)
    select p_tenant, v_new, tax_id, name_snapshot, rate_bp, type from ticket_line_taxes
     where tenant_id = p_tenant and line_id = v_line and deleted_at is null;
  insert into ticket_line_modifiers (tenant_id, line_id, modifier_id, name_snapshot, price)
    select p_tenant, v_new, modifier_id, name_snapshot, price from ticket_line_modifiers
     where tenant_id = p_tenant and line_id = v_line and deleted_at is null;
  return jsonb_build_object('line_id', v_line, 'new_id', v_new, 'qty', v_qty);
end $function$;
