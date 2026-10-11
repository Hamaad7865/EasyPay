-- 0098: which printers a category's orders print on, from a till.
--
-- A restaurant on the offline plan with a printer in the kitchen beside the
-- one at the counter adds the second printer from its tablet (printer.save,
-- 0089, takes any number), and says here which categories print on it:
-- category.save also reads printer_ids. Of the printers named, the client's
-- own that are still there are kept, as the back office's Categories page
-- keeps them; a save that names none leaves them as they are, so a till built
-- before this saves a category exactly as it did.
--
-- Source: push_category_save is its live definition on the dev branch with
-- the lines this migration adds. Nothing else changes: no new change, no new
-- refusal.

CREATE OR REPLACE FUNCTION public.push_category_save(p_tenant uuid, p_emp uuid, p jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
declare
  v_id uuid; v_name text; v_color text; v_was record;
  v_printers uuid[] := '{}';
begin
  begin
    v_id := (p->>'id')::uuid;
  exception when others then
    raise exception 'bad-payload';
  end;
  v_name := left(btrim(coalesce(p->>'name', '')), 60);
  v_color := nullif(lower(btrim(coalesce(p->>'color', ''))), '');
  -- the colour the back office's picker gives, or none
  if v_id is null or (v_color is not null and v_color !~ '^#[0-9a-f]{6}$') then raise exception 'bad-payload'; end if;
  if v_name = '' then raise exception 'name-required'; end if;
  -- Which printers its orders print on (0098), when the sheet says: of those
  -- named, the client's own that are still there, as the back office's page
  -- keeps them. Not sent, they are left as they are.
  if p ? 'printer_ids' then
    if jsonb_typeof(p->'printer_ids') <> 'array' then raise exception 'bad-payload'; end if;
    begin
      select coalesce(array_agg(pr.id order by pr.sort_order, pr.id), '{}') into v_printers
        from printers pr
       where pr.tenant_id = p_tenant and pr.deleted_at is null
         and pr.id in (select x::uuid from jsonb_array_elements_text(p->'printer_ids') x);
    exception when others then
      raise exception 'bad-payload';
    end;
  end if;
  if not may(p_emp, p, 'items.edit') then raise exception 'forbidden'; end if;

  select id, deleted_at into v_was from categories where id = v_id and tenant_id = p_tenant for update;
  if found then
    if v_was.deleted_at is not null then raise exception 'bad-category'; end if;
    -- the name and the colour only: its printers, its place and is_stock are the back office's
    update categories set name = v_name, color = v_color,
        printer_ids = case when p ? 'printer_ids' then v_printers else printer_ids end
      where id = v_id and tenant_id = p_tenant;
    return jsonb_build_object('category_id', v_id, 'created', false);
  end if;
  -- an id that is another client's category stops here on the primary key, and is answered 'conflict'
  insert into categories (id, tenant_id, name, color, sort_order, printer_ids)
    values (v_id, p_tenant, v_name, v_color,
      (select coalesce(max(sort_order), -1) + 1 from categories where tenant_id = p_tenant and deleted_at is null), v_printers);
  return jsonb_build_object('category_id', v_id, 'created', true);
end $function$
;
