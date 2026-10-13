-- 0106: a choice that is picked alone.
--
-- The owner, of a group of sauces with a choice called All: "when selecting
-- 'All' in sauces add ons, all other selected should be un selected ... if we
-- select mayo and select all it puts mayo and all we need a way when
-- selecting all the rest should be deselected and when selecting mayo all
-- should be deselected".
--
-- A group that takes several things has no way to say that one of its
-- choices stands for the lot (All) or for nothing (None). modifiers.alone
-- says it: picking that choice takes the group's other choices off, and
-- picking another takes it off. It changes nothing in a group where only one
-- thing is chosen, and nothing in what a line or a receipt keeps: it is a
-- rule for the pop-up the choices are picked in.
--
-- The mark reaches tills with the choice itself: sync_pull hands out whole
-- rows, and a till built before this reads past a column it does not know
-- (it goes on putting Mayo beside All, as it did).
--
-- Choices already called All or None, in whatever case, are marked here, so
-- a menu set up before this does as its owner expected without being opened
-- again. Any other is marked by hand: on the tablet's add-on sheet or in the
-- back office, beside the choice. A choice with another name that means the
-- same ("Tout", "No sauce") is not guessed at.
--
-- push_addon_save, the tablet's sheet saving a group whole, takes "alone" on
-- each choice. A till built before this sends none, and what a choice was
-- then stays as it is: saving a group from an old till does not unmark it.
-- Rebuilt from its live definition (pg_get_functiondef on dev, last written
-- by 0096).

alter table modifiers add column if not exists alone boolean not null default false;

update modifiers set alone = true
 where deleted_at is null and not alone and lower(btrim(name)) in ('all', 'none');

CREATE OR REPLACE FUNCTION public.push_addon_save(p_tenant uuid, p_emp uuid, p jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
declare
  v_id uuid; v_name text; v_min int; v_max int; v_was record; v_made boolean := false;
  c jsonb; v_cid uuid; v_cname text; v_price bigint; v_alone boolean; v_keep uuid[] := '{}';
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
    exception when others then
      raise exception 'bad-payload';
    end;
    v_cname := left(btrim(coalesce(c->>'name', '')), 40);
    if v_cid is null or v_price < 0 or v_price > 100000000 then raise exception 'bad-payload'; end if;
    if v_cname = '' then raise exception 'name-required'; end if;
    -- under the id the tablet made: a second send finds it there. One that is another group's is left alone.
    insert into modifiers (id, tenant_id, group_id, name, price, alone) values (v_cid, p_tenant, v_id, v_cname, v_price, coalesce(v_alone, false))
      on conflict (id) do update set name = excluded.name, price = excluded.price, deleted_at = null,
          alone = coalesce(v_alone, modifiers.alone)
        where modifiers.tenant_id = p_tenant and modifiers.group_id = v_id;
    v_keep := v_keep || v_cid;
  end loop;
  update modifiers set deleted_at = now()
   where tenant_id = p_tenant and group_id = v_id and deleted_at is null and not (id = any (v_keep));
  return jsonb_build_object('group_id', v_id, 'created', v_made);
end $function$;
