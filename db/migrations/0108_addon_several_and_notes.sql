-- 0108: an add-on taken several times only where it is marked, and the
-- kitchen notes saved from a till.
--
-- The owner, the day after the add-on counts (0105) went out: "not all add
-- ons are quantifiable. For example Eggs can 1 2 3 4 5. But mayo cant be 1 2
-- 3 4 5. We need a checkbox to mark this add on is quantifiable and how many
-- we can add". And: "add somewhere where we can add presets of kitchen note".
--
-- modifiers.max_qty: how many of the choice one line may take. 1, which every
-- choice is until it is marked, is one or none; a choice marked Several
-- carries its number (Eggs: 5), from 2 to 99. Nothing is guessed: every
-- add-on already on a menu is one or none after this, and the ones that are
-- counted are marked by hand, on the tablet's add-on sheet or in the back
-- office. It is a rule for the pop-up the choices are picked in, as alone is
-- (0106): a line and a receipt go on taking any count from 1 to 99 (0105),
-- so what a till has rung up is not refused and an order already taken keeps
-- its count. The number reaches tills with the choice: sync_pull hands out
-- whole rows, and a till built before this reads past the column and goes on
-- counting every add-on.
--
-- push_addon_save takes "max_qty" on each choice. A till built before this
-- sends none, and the choice is left as it was. Not from 1 to 99: refused.
--
-- push_settings_save takes "kitchenNotes", the list whole, beside the
-- receipt's two notes and the service charge and under the same permission
-- (settings.device). It is the list the back office's Settings page keeps.
--
-- Both functions are rebuilt from their live definitions (pg_get_functiondef
-- on dev, 2026-10-14; last written by 0106 and by 0096).

alter table modifiers add column if not exists max_qty integer not null default 1;
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'modifiers_max_qty_range') then
    alter table modifiers add constraint modifiers_max_qty_range check (max_qty between 1 and 99);
  end if;
end $$;

CREATE OR REPLACE FUNCTION public.push_addon_save(p_tenant uuid, p_emp uuid, p jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
declare
  v_id uuid; v_name text; v_min int; v_max int; v_was record; v_made boolean := false;
  c jsonb; v_cid uuid; v_cname text; v_price bigint; v_alone boolean; v_most int; v_keep uuid[] := '{}';
begin
  begin
    v_id := (p->>'id')::uuid;
    v_min := coalesce((p->>'min')::int, 0);
    v_max := coalesce((p->>'max')::int, 0);
  exception when others then
    raise exception 'bad-payload';
  end;
  if v_id is null or jsonb_typeof(p->'choices') is distinct from 'array' then raise exception 'bad-payload'; end if;
  v_name := left(btrim(coalesce(p->>'name', '')), 40);
  if v_name = '' then raise exception 'name-required'; end if;
  -- min 0 is optional, min 1 means one must be picked; max 0 is as many as they like
  if v_min not between 0 and 20 or v_max not between 0 and 20 or (v_max <> 0 and v_max < v_min) then raise exception 'bad-limits'; end if;
  if jsonb_array_length(p->'choices') > 50 then raise exception 'too-many'; end if;
  if not may(p_emp, p, 'items.edit') then raise exception 'forbidden'; end if;
  perform pg_advisory_xact_lock(hashtextextended(v_id::text, 0));
  if exists (select 1 from modifier_groups where tenant_id = p_tenant and id <> v_id and lower(name) = lower(v_name)) then
    raise exception 'name-taken';
  end if;
  select deleted_at into v_was from modifier_groups where tenant_id = p_tenant and id = v_id for update;
  if found then
    if v_was.deleted_at is not null then raise exception 'bad-group'; end if;
    update modifier_groups set name = v_name, min_select = v_min, max_select = v_max where tenant_id = p_tenant and id = v_id;
  else
    insert into modifier_groups (id, tenant_id, name, min_select, max_select) values (v_id, p_tenant, v_name, v_min, v_max);
    v_made := true;
  end if;
  for c in select * from jsonb_array_elements(p->'choices') loop
    begin
      v_cid := (c->>'id')::uuid;
      v_price := coalesce((c->>'price')::bigint, 0);
      -- picked alone (0106). Null when the till says nothing of it.
      v_alone := (c->>'alone')::boolean;
      -- how many of it a line may take (0108). Null when the till says nothing of it.
      v_most := (c->>'max_qty')::int;
    exception when others then
      raise exception 'bad-payload';
    end;
    v_cname := left(btrim(coalesce(c->>'name', '')), 40);
    if v_cid is null or v_price < 0 or v_price > 100000000 then raise exception 'bad-payload'; end if;
    if v_cname = '' then raise exception 'name-required'; end if;
    if v_most is not null and v_most not between 1 and 99 then raise exception 'bad-payload'; end if;
    -- under the id the tablet made: a second send finds it there. One that is another group's is left alone.
    insert into modifiers (id, tenant_id, group_id, name, price, alone, max_qty) values (v_cid, p_tenant, v_id, v_cname, v_price, coalesce(v_alone, false), coalesce(v_most, 1))
      on conflict (id) do update set name = excluded.name, price = excluded.price, deleted_at = null,
          alone = coalesce(v_alone, modifiers.alone),
          max_qty = coalesce(v_most, modifiers.max_qty)
        where modifiers.tenant_id = p_tenant and modifiers.group_id = v_id;
    v_keep := v_keep || v_cid;
  end loop;
  update modifiers set deleted_at = now()
   where tenant_id = p_tenant and group_id = v_id and deleted_at is null and not (id = any (v_keep));
  return jsonb_build_object('group_id', v_id, 'created', v_made);
end $function$;

CREATE OR REPLACE FUNCTION public.push_settings_save(p_tenant uuid, p_emp uuid, p jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
declare v_patch jsonb := '{}'::jsonb; v_receipt jsonb; v_pct int; v_now jsonb; v_notes jsonb;
begin
  if not may(p_emp, p, 'settings.device') then raise exception 'forbidden'; end if;
  if p ? 'receipt' then
    if jsonb_typeof(p->'receipt') <> 'object' then raise exception 'bad-payload'; end if;
    -- the two notes only: the logo and whether it shows are left as they are
    select data->'receipt' into v_now from pos_settings where tenant_id = p_tenant;
    v_receipt := coalesce(case when jsonb_typeof(v_now) = 'object' then v_now end, '{}'::jsonb);
    if p->'receipt' ? 'header' then v_receipt := v_receipt || jsonb_build_object('header', left(replace(coalesce(p->'receipt'->>'header', ''), E'\r', ''), 300)); end if;
    if p->'receipt' ? 'footer' then v_receipt := v_receipt || jsonb_build_object('footer', left(replace(coalesce(p->'receipt'->>'footer', ''), E'\r', ''), 300)); end if;
    v_patch := v_patch || jsonb_build_object('receipt', v_receipt);
  end if;
  if p ? 'servicePct' then
    begin
      v_pct := (p->>'servicePct')::int;
    exception when others then
      raise exception 'bad-payload';
    end;
    if v_pct is null or v_pct not between 0 and 30 then raise exception 'bad-value'; end if;
    v_patch := v_patch || jsonb_build_object('servicePct', v_pct);
  end if;
  -- the notes offered when an item is added (0108): the list whole, as the
  -- back office's Settings saves it. Twelve of forty letters at most; what is
  -- empty or not words is left out; a list saved empty stays empty.
  if p ? 'kitchenNotes' then
    if jsonb_typeof(p->'kitchenNotes') <> 'array' then raise exception 'bad-payload'; end if;
    select coalesce(jsonb_agg(x.note order by x.n), '[]'::jsonb) into v_notes
      from (select left(btrim(e.v #>> '{}'), 40) as note, e.n
              from jsonb_array_elements(p->'kitchenNotes') with ordinality as e(v, n)
             where jsonb_typeof(e.v) = 'string' and btrim(e.v #>> '{}') <> ''
             order by e.n limit 12) x;
    v_patch := v_patch || jsonb_build_object('kitchenNotes', v_notes);
  end if;
  if v_patch <> '{}'::jsonb then
    insert into pos_settings (tenant_id, data) values (p_tenant, v_patch)
      on conflict (tenant_id) do update set data = pos_settings.data || excluded.data;
  end if;
  return jsonb_build_object('saved', (select count(*) from jsonb_object_keys(v_patch)));
end $function$;
