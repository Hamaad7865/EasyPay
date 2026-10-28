-- 0141_variant_value_rename.sql — a value of a product's option renamed on the lines that have it
-- (the back office's product page, 2026-10-28).
--
-- An import that said Plain where the shop meant another word left lines a second import cannot put
-- right: it finds a line by its values, so it adds a line beside the wrong one. A rename keeps each
-- line, with its barcode, SKU, price, stock and movements; only its values and its name change, so
-- the tills are sent the new name with their next pull. Receipts that sold it keep the name they
-- printed. Its SKU is left as it is, even one made from the old value: a code may be on labels.
--
-- p_everywhere: every product of the business whose option of the same name (wherever it stands
-- among its options) has the value, not only this one. Values and option names are compared without
-- regard to case, as an import compares them.
--
-- Refused: 'unknown-item'; 'bad-options' for an option the product does not have, or an empty new
-- value, or one over 30 characters (the product page's limit); 'unknown-value' when no line of this
-- product has the value; 'value-taken', with the product's name as its detail, when a renamed line
-- would have the values of another line of its product. Nothing is renamed when one is refused.

create or replace function variant_value_rename(p_tenant uuid, p_item uuid, p_option integer, p_from text, p_to text, p_everywhere boolean)
returns jsonb
language plpgsql set search_path = public as $fn$
declare
  v_option text;
  v_to text := btrim(coalesce(p_to, ''));
  v_clash text;
  v_lines int;
  v_products int;
begin
  select option_names[p_option] into v_option from items where tenant_id = p_tenant and id = p_item and deleted_at is null;
  if not found then raise exception 'unknown-item'; end if;
  if v_option is null or v_to = '' or length(v_to) > 30 or btrim(coalesce(p_from, '')) = '' then raise exception 'bad-options'; end if;

  -- the lines to rename, each with its values as they will be
  drop table if exists _ren;
  create temp table _ren on commit drop as
    select v.id, v.item_id,
           array_cat(array_append(v.option_values[1:o.pos - 1], v_to), v.option_values[o.pos + 1:]) as vals
      from items i
      cross join lateral (select t.ord::int as pos from unnest(i.option_names) with ordinality as t(n, ord)
                           where lower(t.n) = lower(v_option) limit 1) o
      join item_variants v on v.tenant_id = i.tenant_id and v.item_id = i.id and v.deleted_at is null
     where i.tenant_id = p_tenant and i.deleted_at is null and (i.id = p_item or p_everywhere)
       and lower(v.option_values[o.pos]) = lower(p_from);
  if not exists (select 1 from _ren where item_id = p_item) then raise exception 'unknown-value'; end if;

  -- two lines of one product with the same values would be one line twice
  select i.name into v_clash
    from _ren r join items i on i.id = r.item_id
   where exists (select 1 from item_variants o
                  where o.tenant_id = p_tenant and o.item_id = r.item_id and o.deleted_at is null
                    and o.id not in (select id from _ren) and lower(o.option_values::text) = lower(r.vals::text))
      or exists (select 1 from _ren x where x.item_id = r.item_id and x.id <> r.id and lower(x.vals::text) = lower(r.vals::text))
   order by i.name limit 1;
  if v_clash is not null then raise exception 'value-taken' using detail = v_clash; end if;

  update item_variants v set option_values = r.vals, name = array_to_string(r.vals, ' / ')
    from _ren r where v.tenant_id = p_tenant and v.id = r.id;
  get diagnostics v_lines = row_count;
  select count(distinct item_id) into v_products from _ren;
  return jsonb_build_object('lines', v_lines, 'products', v_products);
end $fn$;
