-- 0011_push_tickets.sql — ticket.* op handlers for sync_push.
-- Append-only lines: two devices adding lines both succeed (spec 5.6).
-- Voids are flags with a mandatory reason. Metadata is last-write-wins.
-- Never edit after merge.

create or replace function push_ticket_create(p_tenant uuid, p_emp uuid, p jsonb)
returns jsonb language plpgsql set search_path = public as $fn$
declare v_id uuid; v_store uuid; v_dining uuid;
begin
  v_id := (p->>'id')::uuid;
  v_store := (p->>'store_id')::uuid;
  if v_id is null or v_store is null then raise exception 'bad-payload'; end if;
  if not exists (select 1 from stores where id = v_store) then raise exception 'bad-store'; end if;
  if p->>'dining_option_id' is not null then
    v_dining := (p->>'dining_option_id')::uuid;
    if not exists (select 1 from dining_options where id = v_dining) then raise exception 'bad-dining'; end if;
  end if;
  insert into tickets (id, tenant_id, store_id, table_id, dining_option_id, name, note, covers, opened_by)
    values (v_id, p_tenant,
      v_store,
      case when p->>'table_id' is null then null else (p->>'table_id')::uuid end,
      v_dining, nullif(p->>'name',''), nullif(p->>'note',''),
      case when p->>'covers' is null then null else (p->>'covers')::int end,
      p_emp);
  return jsonb_build_object('ticket_id', v_id);
end $fn$;

create or replace function push_ticket_add_line(p_tenant uuid, p_emp uuid, p jsonb)
returns jsonb language plpgsql set search_path = public as $fn$
declare
  v_id uuid; v_ticket uuid; v_item uuid; v_variant uuid; v_qty int;
  v_price bigint; v_name text; m jsonb; v_mod uuid; v_grp uuid;
begin
  v_id := (p->>'id')::uuid;
  v_ticket := (p->>'ticket_id')::uuid;
  v_item := (p->>'item_id')::uuid;
  v_qty := coalesce((p->>'qty')::int, 0);
  if v_id is null or v_ticket is null or v_item is null or v_qty <= 0 then raise exception 'bad-payload'; end if;
  if not exists (select 1 from tickets where id = v_ticket and status = 'open') then raise exception 'ticket-closed'; end if;
  select price, name into v_price, v_name from items
    where id = v_item and deleted_at is null and is_available;
  if not found then raise exception 'unknown-item'; end if;
  if p->>'variant_id' is not null then
    v_variant := (p->>'variant_id')::uuid;
    select price, name into v_price, v_name from item_variants
      where id = v_variant and item_id = v_item and deleted_at is null;
    if not found then raise exception 'unknown-variant'; end if;
  end if;
  insert into ticket_lines (id, tenant_id, ticket_id, item_id, variant_id, name_snapshot, unit_price, qty, note, course)
    values (v_id, p_tenant, v_ticket, v_item, v_variant, v_name, v_price, v_qty,
      nullif(p->>'note',''),
      case when p->>'course' is null then null else (p->>'course')::int end);
  insert into ticket_line_taxes (tenant_id, line_id, tax_id, name_snapshot, rate_bp, type)
    select p_tenant, v_id, t.id, t.name, t.rate_bp, t.type
    from item_taxes it join taxes t on t.tenant_id = p_tenant and t.id = it.tax_id
    where it.tenant_id = p_tenant and it.item_id = v_item and it.deleted_at is null;
  for m in select value from jsonb_array_elements(coalesce(p->'modifier_ids', '[]'::jsonb)) as value loop
    v_mod := (m->>0)::uuid;
    select group_id into v_grp from modifiers where id = v_mod and deleted_at is null;
    if not found then raise exception 'bad-modifier'; end if;
    if not exists (select 1 from item_modifier_groups
        where tenant_id = p_tenant and item_id = v_item and group_id = v_grp and deleted_at is null) then
      raise exception 'bad-modifier';
    end if;
    insert into ticket_line_modifiers (tenant_id, line_id, modifier_id, name_snapshot, price)
      select p_tenant, v_id, mo.id, mo.name, mo.price from modifiers mo where mo.id = v_mod;
  end loop;
  return jsonb_build_object('line_id', v_id);
end $fn$;

create or replace function push_ticket_void_line(p_tenant uuid, p_emp uuid, p jsonb)
returns jsonb language plpgsql set search_path = public as $fn$
declare v_line uuid; v_reason text;
begin
  v_line := (p->>'line_id')::uuid;
  v_reason := nullif(p->>'reason','');
  if v_line is null or v_reason is null then raise exception 'bad-payload'; end if;
  update ticket_lines l set voided_at = now(), voided_by = p_emp, void_reason = v_reason
    from tickets t
    where l.id = v_line and l.tenant_id = p_tenant
      and t.tenant_id = p_tenant and t.id = l.ticket_id and t.status = 'open'
      and l.voided_at is null;
  if not found then raise exception 'bad-line'; end if;
  return jsonb_build_object('line_id', v_line);
end $fn$;

create or replace function push_ticket_update_meta(p_tenant uuid, p_emp uuid, p jsonb)
returns jsonb language plpgsql set search_path = public as $fn$
declare v_ticket uuid; v_dining uuid;
begin
  v_ticket := (p->>'ticket_id')::uuid;
  if v_ticket is null then raise exception 'bad-payload'; end if;
  if p->>'dining_option_id' is not null then
    v_dining := (p->>'dining_option_id')::uuid;
    if not exists (select 1 from dining_options where id = v_dining) then raise exception 'bad-dining'; end if;
  end if;
  update tickets set
    table_id = case when p ? 'table_id' and p->>'table_id' is null then null
      when p->>'table_id' is null then table_id else (p->>'table_id')::uuid end,
    dining_option_id = case when p ? 'dining_option_id' and p->>'dining_option_id' is null then null
      when v_dining is null and not (p ? 'dining_option_id') then dining_option_id else v_dining end,
    note = case when p ? 'note' then nullif(p->>'note','') else note end,
    covers = case when p ? 'covers' and p->>'covers' is null then null
      when p->>'covers' is null then covers else (p->>'covers')::int end,
    name = case when p ? 'name' then nullif(p->>'name','') else name end
    where id = v_ticket and tenant_id = p_tenant and status = 'open';
  if not found then raise exception 'bad-ticket'; end if;
  return jsonb_build_object('ticket_id', v_ticket);
end $fn$;

create or replace function push_ticket_move_lines(p_tenant uuid, p_emp uuid, p jsonb)
returns jsonb language plpgsql set search_path = public as $fn$
declare v_to uuid; v_store uuid; lid jsonb; v_id uuid;
begin
  v_to := (p->>'to_ticket_id')::uuid;
  if v_to is null then raise exception 'bad-payload'; end if;
  select store_id into v_store from tickets where id = v_to and status = 'open';
  if not found then raise exception 'bad-ticket'; end if;
  for lid in select value from jsonb_array_elements(coalesce(p->'line_ids', '[]'::jsonb)) as value loop
    v_id := (lid->>0)::uuid;
    update ticket_lines l set ticket_id = v_to
      from tickets t
      where l.id = v_id and l.tenant_id = p_tenant and l.voided_at is null
        and t.tenant_id = p_tenant and t.id = l.ticket_id and t.status = 'open'
        and t.store_id = v_store;
    if not found then raise exception 'bad-line'; end if;
  end loop;
  return jsonb_build_object('to_ticket_id', v_to);
end $fn$;

create or replace function push_ticket_merge(p_tenant uuid, p_emp uuid, p jsonb)
returns jsonb language plpgsql set search_path = public as $fn$
declare v_into uuid; v_store uuid; fid jsonb; v_from uuid;
begin
  v_into := (p->>'into_ticket_id')::uuid;
  if v_into is null then raise exception 'bad-payload'; end if;
  select store_id into v_store from tickets where id = v_into and status = 'open';
  if not found then raise exception 'bad-ticket'; end if;
  for fid in select value from jsonb_array_elements(coalesce(p->'from_ticket_ids', '[]'::jsonb)) as value loop
    v_from := (fid->>0)::uuid;
    if v_from = v_into then raise exception 'bad-payload'; end if;
    if not exists (select 1 from tickets where id = v_from and tenant_id = p_tenant and status = 'open' and store_id = v_store) then
      raise exception 'bad-ticket';
    end if;
    update ticket_lines set ticket_id = v_into
      where ticket_id = v_from and tenant_id = p_tenant and voided_at is null;
    update tickets set status = 'cancelled' where id = v_from;
  end loop;
  return jsonb_build_object('into_ticket_id', v_into);
end $fn$;
