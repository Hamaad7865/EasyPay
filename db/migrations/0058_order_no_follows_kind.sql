-- 0058: an order's number can follow its kind.
--
-- An order with no table is known by a short number whose letter says what it
-- is: C- a counter sale, A- a takeaway, D- a delivery. The number was fixed
-- when the order was made, so one rung up as a quick sale and then turned
-- into a takeaway stood on the takeaway board as "C-7". ticket.update_meta
-- now takes order_no, and the till sends a number of the new kind when the
-- kind changes before anything has gone to the kitchen.

CREATE OR REPLACE FUNCTION public.push_ticket_update_meta(p_tenant uuid, p_emp uuid, p jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
declare v_ticket uuid; v_dining uuid;
begin
  v_ticket := (p->>'ticket_id')::uuid;
  if v_ticket is null then raise exception 'bad-payload'; end if;
  if p->>'opened_by' is not null and not may(p_emp, p, 'ticket.reassign') then raise exception 'forbidden'; end if;
  if p->>'dining_option_id' is not null then
    v_dining := (p->>'dining_option_id')::uuid;
    if not exists (select 1 from dining_options where id = v_dining) then raise exception 'bad-dining'; end if;
  end if;
  update tickets set
    table_id = case when p ? 'table_id' and p->>'table_id' is null then null
      when p->>'table_id' is null then table_id
      -- moving to a table this restaurant does not have takes the order off its table
      else (select tb.id from tables tb where tb.id = (p->>'table_id')::uuid and tb.tenant_id = p_tenant) end,
    dining_option_id = case when p ? 'dining_option_id' and p->>'dining_option_id' is null then null
      when v_dining is null and not (p ? 'dining_option_id') then dining_option_id else v_dining end,
    -- the customer the order is for; one this restaurant does not have leaves it with none
    customer_id = case when p ? 'customer_id' and p->>'customer_id' is null then null
      when p->>'customer_id' is null then customer_id
      else (select cu.id from customers cu where cu.id = (p->>'customer_id')::uuid and cu.tenant_id = p_tenant and cu.deleted_at is null) end,
    note = case when p ? 'note' then nullif(p->>'note','') else note end,
    -- the order's number: a counter sale that becomes a takeaway before the
    -- kitchen has had it takes a takeaway's number (C-7 becomes A-3)
    order_no = case when p ? 'order_no' then nullif(left(p->>'order_no', 24), '') else order_no end,
    -- who to ring and where to bring it (takeaway, delivery)
    phone = case when p ? 'phone' then nullif(left(p->>'phone', 40), '') else phone end,
    address = case when p ? 'address' then nullif(left(p->>'address', 240), '') else address end,
    due_at = case when p ? 'due_at' then (p->>'due_at')::timestamptz else due_at end,
    -- when the bill was printed for the table; null when it was added to since
    bill_at = case when p ? 'bill_at' then (p->>'bill_at')::timestamptz else bill_at end,
    covers = case when p ? 'covers' and p->>'covers' is null then null
      when p->>'covers' is null then covers else (p->>'covers')::int end,
    name = case when p ? 'name' then nullif(p->>'name','') else name end,
    -- change waiter: someone of this restaurant, else the order keeps its waiter
    opened_by = coalesce((select e.id from employees e
      where p->>'opened_by' is not null and e.id = (p->>'opened_by')::uuid and e.tenant_id = p_tenant), opened_by)
    where id = v_ticket and tenant_id = p_tenant and status = 'open';
  if not found then raise exception 'bad-ticket'; end if;
  return jsonb_build_object('ticket_id', v_ticket);
end $function$;
