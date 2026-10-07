-- 0076_count_scan_puts_back.sql
-- A line left out of a count and then scanned, or given a quantity, stayed
-- left out: completing the count ignored what had just been counted, without
-- a word. Whoever leaves a line out could not find the goods; whoever scans
-- it has them in hand. Counting a line puts it back in the count.
--
-- count_add as in 0075, with that one change (left_out = false on a line
-- that is already there).

create or replace function count_add(
  p_tenant uuid, p_count uuid, p_item uuid, p_variant uuid, p_units integer, p_mode text, p_emp uuid
) returns integer
language plpgsql set search_path = public as $fn$
declare
  v_status text;
  v_now integer;
begin
  select status into v_status from stock_counts where tenant_id = p_tenant and id = p_count and deleted_at is null for share;
  if not found then raise exception 'unknown-count'; end if;
  if v_status <> 'open' then raise exception 'count-closed'; end if;
  if p_units is null or p_mode is null or p_mode not in ('add', 'set')
     or (p_mode = 'add' and p_units <= 0) or (p_mode = 'set' and p_units < 0) then
    raise exception 'bad-quantity';
  end if;
  perform stock_line_ok(p_tenant, p_item, p_variant);
  insert into stock_count_lines (tenant_id, count_id, item_id, variant_id, counted, counted_at, counted_by)
    values (p_tenant, p_count, p_item, p_variant, p_units, clock_timestamp(), p_emp)
    on conflict (count_id, item_id, (coalesce(variant_id, '00000000-0000-0000-0000-000000000000'::uuid)))
    do update set counted = case when p_mode = 'add' then coalesce(stock_count_lines.counted, 0) + p_units else p_units end,
                  counted_at = clock_timestamp(), counted_by = p_emp, left_out = false
    returning counted into v_now;
  return v_now;
end $fn$;
