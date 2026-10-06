-- 0062: two tables on one bill.
--
-- ticket.merge moved the lines of one order onto another and closed the
-- first, and that was all: the order merged away kept its table, its guests
-- dropped out of the count, its seats ran into the seats of the order it
-- joined, and anyone at all could do it. The till had no way to send it, so
-- none of that showed. Now that a table's order can be put onto another
-- table's:
--   - it asks for 'ticket.split_merge' ("Transfer an order to another table"
--     on the roles page), from the person at the till or from whoever
--     approved it (approved_by): 'forbidden' otherwise. What is wrong with
--     the orders themselves is said first, so a paid order still answers
--     'paid-line' whoever asks;
--   - the order merged away lets go of its table and of the takeaway board,
--     as a cancelled one does (0057);
--   - its guests are added to the order it joins (99 at most);
--   - its lines keep their seats, numbered on after the seats the order they
--     join already has (the greater of its guests and its highest seat), so a
--     split by seat still tells the two parties apart. A seat that would pass
--     99 goes back to the table;
--   - the bill printed for the order it joins is no longer its bill: bill_at
--     is cleared.
-- Voided lines stay on the order merged away, as before. Built from the live
-- definition (0032_merge_paidline.sql); 0032 untouched. Never edit after merge.

create or replace function push_ticket_merge(p_tenant uuid, p_emp uuid, p jsonb)
returns jsonb language plpgsql set search_path = public as $fn$
declare v_into uuid; v_store uuid; fid jsonb; v_from uuid;
  v_covers int; v_theirs int; v_after int;
begin
  v_into := (p->>'into_ticket_id')::uuid;
  if v_into is null then raise exception 'bad-payload'; end if;
  select store_id, covers into v_store, v_covers from tickets
    where id = v_into and tenant_id = p_tenant and status = 'open' for update;
  if not found then raise exception 'bad-ticket'; end if;

  for fid in select value from jsonb_array_elements(coalesce(p->'from_ticket_ids', '[]'::jsonb)) as value loop
    v_from := (fid->>0)::uuid;
    if v_from = v_into then raise exception 'bad-payload'; end if;
    if not exists (select 1 from tickets
        where id = v_from and tenant_id = p_tenant and store_id = v_store) then
      raise exception 'bad-ticket';
    end if;
    if exists (select 1 from ticket_lines
        where ticket_id = v_from and tenant_id = p_tenant and voided_at is null and paid) then
      raise exception 'paid-line';
    end if;
    if not exists (select 1 from tickets where id = v_from and tenant_id = p_tenant and status = 'open') then
      raise exception 'bad-ticket';
    end if;
  end loop;

  if not may(p_emp, p, 'ticket.split_merge') then raise exception 'forbidden'; end if;

  for fid in select value from jsonb_array_elements(coalesce(p->'from_ticket_ids', '[]'::jsonb)) as value loop
    v_from := (fid->>0)::uuid;
    select covers into v_theirs from tickets where id = v_from and tenant_id = p_tenant for update;
    select greatest(coalesce(v_covers, 0), coalesce(max(seat), 0)) into v_after from ticket_lines
      where ticket_id = v_into and tenant_id = p_tenant and voided_at is null;
    update ticket_lines set ticket_id = v_into,
        seat = case when seat is null or seat + v_after > 99 then null else seat + v_after end
      where ticket_id = v_from and tenant_id = p_tenant and voided_at is null;
    update tickets set status = 'cancelled', table_id = null,
        stage = case when stage is null then null else 'done' end
      where id = v_from and tenant_id = p_tenant;
    if v_covers is not null or v_theirs is not null then
      v_covers := least(coalesce(v_covers, 0) + coalesce(v_theirs, 0), 99);
    end if;
  end loop;

  update tickets set covers = v_covers, bill_at = null where id = v_into and tenant_id = p_tenant;
  return jsonb_build_object('into_ticket_id', v_into, 'covers', v_covers);
end $fn$;
