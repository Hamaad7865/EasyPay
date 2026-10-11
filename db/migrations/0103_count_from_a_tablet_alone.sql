-- 0103: a count completed on a tablet that worked on its own is right the day it is sent.
--
-- A count sets a line of stock to what was counted, plus what moved since the
-- line was counted. For a sale the moment is the tablet's own (the receipt's
-- device_time). For everything else (a delivery, a correction, another count)
-- stock_moved_since_at reads when the movement's row was WRITTEN, which is
-- right while a till is linked: it is written when it happens.
--
-- A business on the offline plan keeps its changes on its tablet, and they are
-- sent in order the day it is made Premium. A delivery received a month ago is
-- then written NOW, and a count completed after it, a month ago too, took that
-- delivery for something that arrived after the shelf was counted and added it
-- again: ten received and ten counted came to twenty (proved on dev before
-- this was written, in one transaction that was rolled back).
--
-- The tablet knows what moved on it between counting a line and completing the
-- count: it is the difference between what it holds when the count is completed
-- and what it held when the line was counted, and it is the only writer of its
-- own stock while it works on its own. So it says so, in each counted line of
-- count.complete, as `moved`. It is kept beside the line (till_moved) and used
-- in place of the server's own sum. A line that does not carry it (every linked
-- till's) is worked out exactly as before: nothing changes for them.
--
-- Both functions are the LIVE definitions on dev (pg_get_functiondef, the
-- evening of 2026-10-11: count_from_till as 0092 left it, count_complete as
-- 0092 left it), with only the lines named above changed.

alter table stock_count_lines add column if not exists till_moved integer;
comment on column stock_count_lines.till_moved is
  'What moved on the tablet between this line being counted and the count being completed, in thousandths, as a tablet that worked on its own said it (0103). Null: not said, and count_complete adds it up itself.';

CREATE OR REPLACE FUNCTION public.count_from_till(p_tenant uuid, p_emp uuid, p jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
declare
  v_zero constant uuid := '00000000-0000-0000-0000-000000000000';
  v_id uuid; v_store uuid; v_scope uuid; v_ahead integer;
  v_kind text; v_text text; v_uncounted text; v_title text; v_number text;
  v_item uuid; v_variant uuid; v_out boolean; v_counted integer; v_at timestamptz; v_moved integer;
  v_n integer := 0;
  v_done jsonb;
  k record;
  l jsonb;
begin
  begin
    v_id := (p->>'id')::uuid;
    v_store := (p->>'store_id')::uuid;
    v_scope := nullif(p->>'scope_id', '')::uuid;
    v_ahead := coalesce((p->>'clock_ahead_ms')::integer, 0);
  exception when others then
    raise exception 'bad-payload';
  end;
  -- a clock more than a day out is not a clock to set anything right by
  if v_id is null or v_store is null or abs(v_ahead) > 86400000 then raise exception 'bad-payload'; end if;
  -- two sends of one count wait their turn here, so the second sees the first
  perform pg_advisory_xact_lock(hashtextextended(v_id::text, 0));
  select number, status into k from stock_counts where tenant_id = p_tenant and id = v_id;
  if found then
    return jsonb_build_object('id', v_id, 'number', k.number, 'status', k.status, 'already', true);
  end if;

  v_kind := p->>'scope_kind';
  if v_kind is null or v_kind not in ('all', 'category', 'supplier', 'brand') then raise exception 'bad-scope'; end if;
  if not exists (select 1 from stores where tenant_id = p_tenant and id = v_store and deleted_at is null) then
    raise exception 'unknown-store';
  end if;
  v_uncounted := p->>'uncounted';
  if v_uncounted is null or v_uncounted not in ('leave', 'zero') then raise exception 'bad-uncounted'; end if;
  v_text := nullif(left(btrim(coalesce(p->>'scope_text', '')), 120), '');
  v_title := case v_kind
    when 'all' then 'The whole shop'
    when 'category' then (select name from categories where tenant_id = p_tenant and id = v_scope)
    when 'supplier' then (select name from suppliers where tenant_id = p_tenant and id = v_scope)
    else v_text
  end;
  if v_title is null then raise exception 'bad-scope'; end if;
  if jsonb_typeof(p->'lines') is distinct from 'array' or jsonb_array_length(p->'lines') = 0 then
    raise exception 'nothing-to-count';
  end if;

  v_number := next_doc_number(p_tenant, 'count');
  -- an id that is another client's count stops here on the primary key, and is answered 'conflict'
  insert into stock_counts (id, tenant_id, store_id, number, scope_kind, scope_id, scope_text, title, started_by, clock_ahead_ms)
    values (v_id, p_tenant, v_store, v_number, v_kind, case when v_kind in ('category', 'supplier') then v_scope end,
      case when v_kind = 'brand' then v_title end, v_title, p_emp, v_ahead);
  -- exactly the lines given: the scope is not worked out again here
  for l in select x from jsonb_array_elements(p->'lines') x loop
    begin
      v_item := (l->>'item_id')::uuid;
      v_variant := nullif(l->>'variant_id', '')::uuid;
      v_out := coalesce((l->>'left_out')::boolean, false);
      v_counted := (l->>'counted')::integer;
      v_at := (l->>'counted_at')::timestamptz;
      -- what moved on the tablet between the line being counted and the count being completed (0103)
      v_moved := (l->>'moved')::integer;
    exception when others then
      raise exception 'bad-payload';
    end;
    if v_item is null then raise exception 'bad-payload'; end if;
    if v_counted is not null and (v_counted < 0 or v_at is null) then raise exception 'bad-quantity'; end if;
    if v_out then
      -- left out: not checked, and a product or a variant that is gone is not written at all
      if not exists (select 1 from items where tenant_id = p_tenant and id = v_item and deleted_at is null)
         or (v_variant is not null and not exists (select 1 from item_variants
               where tenant_id = p_tenant and item_id = v_item and id = v_variant and deleted_at is null)) then
        continue;
      end if;
    else
      perform stock_line_ok(p_tenant, v_item, v_variant);
    end if;
    insert into stock_count_lines (tenant_id, count_id, item_id, variant_id, counted, counted_at, counted_by, left_out, till_moved)
      values (p_tenant, v_id, v_item, v_variant, v_counted, case when v_counted is null then null else v_at end,
        case when v_counted is null then null else p_emp end, v_out,
        case when v_counted is null or v_out then null else v_moved end)
      on conflict (count_id, item_id, (coalesce(variant_id, '00000000-0000-0000-0000-000000000000'::uuid)))
      do update set counted = excluded.counted, counted_at = excluded.counted_at, counted_by = excluded.counted_by, left_out = excluded.left_out,
                    till_moved = excluded.till_moved;
    v_n := v_n + 1;
  end loop;
  if v_n = 0 then raise exception 'nothing-to-count'; end if;
  v_done := count_complete(p_tenant, p_emp, v_id, v_uncounted);
  return v_done || jsonb_build_object('id', v_id, 'number', v_number, 'already', false);
end $function$;

CREATE OR REPLACE FUNCTION public.count_complete(p_tenant uuid, p_emp uuid, p_count uuid, p_uncounted text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
declare
  v_status text; v_store uuid; v_ahead integer;
  v_level stock_levels%rowtype;
  v_counted integer; v_moved integer; v_delta integer;
  v_lines integer := 0; v_units integer := 0; v_value numeric := 0;
  r record;
begin
  if p_uncounted is null or p_uncounted not in ('leave', 'zero') then raise exception 'bad-uncounted'; end if;
  select status, store_id, clock_ahead_ms into v_status, v_store, v_ahead from stock_counts
   where tenant_id = p_tenant and id = p_count and deleted_at is null for update;
  if not found then raise exception 'unknown-count'; end if;
  if v_status <> 'open' then raise exception 'count-closed'; end if;
  -- always in the same order (by product), so two counts of the same goods wait on each other the same way round
  for r in
    select id, item_id, variant_id, counted, counted_at, till_moved from stock_count_lines
     where tenant_id = p_tenant and count_id = p_count and not left_out
     order by item_id, variant_id nulls first
  loop
    -- the line of stock is locked from here: what it holds cannot change under the sum
    v_level := stock_level_for(p_tenant, v_store, r.item_id, r.variant_id);
    if r.counted is null and p_uncounted = 'leave' then
      update stock_count_lines set expected = v_level.qty, unit_cost = v_level.avg_cost where id = r.id;
      continue;
    end if;
    if r.counted is null then
      v_counted := 0; v_moved := 0;
    else
      v_counted := r.counted;
      -- a tablet's moment for its sales, the same moment by the server's clock for the rest (0092)
      -- A tablet that worked on its own says itself what moved on it since the line was counted (0103):
      -- its changes reach here long after they were made, so when they were written says nothing of when
      -- they happened. A linked till says nothing, and the sum is the server's own, as before.
      v_moved := coalesce(r.till_moved, stock_moved_since_at(p_tenant, v_store, r.item_id, r.variant_id, r.counted_at,
        r.counted_at - make_interval(secs => v_ahead / 1000.0)));
    end if;
    v_delta := v_counted + v_moved - v_level.qty;
    update stock_count_lines
       set counted = v_counted, counted_at = coalesce(counted_at, clock_timestamp()),
           expected = v_level.qty - v_moved, diff = v_delta, unit_cost = v_level.avg_cost
     where id = r.id;
    if v_delta <> 0 then
      perform stock_move(p_tenant, v_store, r.item_id, r.variant_id, v_delta, 'count', null, 'count', p_count, p_emp, null);
      v_lines := v_lines + 1;
      v_units := v_units + v_delta;
      v_value := v_value + v_delta * v_level.avg_cost / 1000;
    end if;
  end loop;
  update stock_counts set status = 'completed', uncounted = p_uncounted, completed_by = p_emp, completed_at = now()
   where tenant_id = p_tenant and id = p_count;
  return jsonb_build_object('lines', v_lines, 'units', v_units, 'value', round(v_value, 2));
end $function$;
