-- 0150_skus_made.sql — SKUs made from a product's name and its line's values (the owner, 2026-10-29: "auto
-- generate SKU for all product … all SKUs are unique and derived from product name and its variant … it gets
-- an SKU while it's getting imported … for the current ones a button").
--
-- The code is the product's stem, then each of the line's values made short, joined by dashes: Long Sleeve
-- Plain in 10 Year is LSP-10Y, a Tee in S and Blue is TEE-S-BLU. A product without lines has the stem alone.
--   sku_stem(name): its words without accents, letters and digits only, upper case. One word: its first four
--     letters (CHEM). Two: two letters of each (Chemise classique, CHCL). More: the first letter of each, up to
--     eight (LSPCM). A word that starts with a digit is kept whole (Coca Cola 1.5L, CC15L). No word: ITEM.
--   sku_part(value): a number, or a word of three letters or fewer, as it is (10, XL, RED). Another word: its
--     first letter and the consonants after it, three (GRN for Green, GRY for Grey), or its first three
--     letters when that leaves fewer (BLU). Two words or more: the first letter of each, a number whole
--     (10 Year, 10Y; Navy Blue, NB).
--
-- assign_skus(tenant, item): the product's lines that have no SKU are given one, or the product itself when it
-- has no lines, as assign_barcodes does (0070). A SKU already there, typed by hand or made before, is kept.
-- Returns how many were made. The stem is the product's own: the one its lines already start with (LSP2 stays
-- LSP2), else the first of LSP, LSP2, LSP3 … that no other product's SKU is or starts with (with a dash), so
-- two products with the same initials never share one. A line whose code another already has (Grey and Gray,
-- both GRY) gets a number: SCAR-GRY-2. Never a SKU another live line or product has: the rule
-- catalog_code_guard (0070) refuses 'sku-taken' by, under the same lock, so two at once take theirs in turn.
-- Refused: 'unknown-item'.
--
-- assign_skus_for(tenant, items): the same for those products, or every product when items is null, in the
-- order they were made (then by name). Returns {made, like}: how many, and the first made, to show the owner.
-- Never edit after merge.

create or replace function sku_words(p text) returns text[]
language sql immutable as $fn$
  select coalesce(array_agg(x.w order by x.n), '{}')
    from regexp_split_to_table(
           upper(translate(coalesce(p, ''),
             'àáâãäåçèéêëìíîïñòóôõöùúûüýÿÀÁÂÃÄÅÇÈÉÊËÌÍÎÏÑÒÓÔÕÖÙÚÛÜÝ',
             'aaaaaaceeeeiiiinooooouuuuyyAAAAAACEEEEIIIINOOOOOUUUUY')),
           '[^A-Z0-9]+') with ordinality as x(w, n)
   where x.w <> ''
$fn$;

create or replace function sku_stem(p_name text) returns text
language plpgsql immutable set search_path = public as $fn$
declare
  w text[] := sku_words(p_name);
  v text;
  v_out text := '';
begin
  if cardinality(w) = 0 then return 'ITEM'; end if;
  if cardinality(w) = 1 then return left(w[1], 4); end if;
  foreach v in array w loop
    v_out := v_out || case when v ~ '^[0-9]' then left(v, 4) when cardinality(w) = 2 then left(v, 2) else left(v, 1) end;
  end loop;
  return left(v_out, 8);
end $fn$;

create or replace function sku_part(p_value text) returns text
language plpgsql immutable set search_path = public as $fn$
declare
  w text[] := sku_words(p_value);
  v text;
  v_out text := '';
begin
  if cardinality(w) = 0 then return 'X'; end if;
  if cardinality(w) = 1 then
    v := w[1];
    if v ~ '^[0-9]' or length(v) <= 3 then return left(v, 6); end if;
    v_out := left(v, 1) || regexp_replace(substr(v, 2), '[AEIOU0-9]', '', 'g');
    return case when length(v_out) >= 3 then left(v_out, 3) else left(v, 3) end;
  end if;
  foreach v in array w loop
    v_out := v_out || case when v ~ '^[0-9]' then v else left(v, 1) end;
  end loop;
  return left(v_out, 6);
end $fn$;

-- a SKU another live product or line has, as catalog_code_guard (0070) reads it: case aside, a line of a removed
-- product not counted
create or replace function sku_taken(p_tenant uuid, p_sku text) returns boolean
language sql stable set search_path = public as $fn$
  select exists (select 1 from items i where i.tenant_id = p_tenant and i.deleted_at is null and lower(i.sku) = lower(p_sku))
      or exists (select 1 from item_variants v join items i on i.tenant_id = v.tenant_id and i.id = v.item_id
                  where v.tenant_id = p_tenant and v.deleted_at is null and i.deleted_at is null and lower(v.sku) = lower(p_sku))
$fn$;

-- a stem another product's SKUs use: one of them is it, or starts with it and a dash. Read as a range in byte
-- order (from "lsp-" to just before "lsp.", the character after the dash), on an index of its own: an import of
-- 500 products otherwise reads every SKU of the shop for each of them (5 seconds where the import took 1)
create index if not exists idx_items_sku_bytes on items (tenant_id, (lower(sku) collate "C")) where sku is not null and deleted_at is null;
create index if not exists idx_item_variants_sku_bytes on item_variants (tenant_id, (lower(sku) collate "C")) where sku is not null and deleted_at is null;
-- a product's lines: there was no index for them, and each product's turn read every line of the shop
create index if not exists idx_item_variants_item on item_variants (tenant_id, item_id);

create or replace function sku_stem_taken(p_tenant uuid, p_item uuid, p_stem text) returns boolean
language sql stable set search_path = public as $fn$
  select exists (select 1 from items i
                  where i.tenant_id = p_tenant and i.sku is not null and i.deleted_at is null and i.id <> p_item
                    and (lower(i.sku) collate "C") = lower(p_stem))
      or exists (select 1 from items i
                  where i.tenant_id = p_tenant and i.sku is not null and i.deleted_at is null and i.id <> p_item
                    and (lower(i.sku) collate "C") >= lower(p_stem) || '-' and (lower(i.sku) collate "C") < lower(p_stem) || '.')
      or exists (select 1 from item_variants v join items i on i.tenant_id = v.tenant_id and i.id = v.item_id
                  where v.tenant_id = p_tenant and v.sku is not null and v.deleted_at is null and i.deleted_at is null and v.item_id <> p_item
                    and (lower(v.sku) collate "C") = lower(p_stem))
      or exists (select 1 from item_variants v join items i on i.tenant_id = v.tenant_id and i.id = v.item_id
                  where v.tenant_id = p_tenant and v.sku is not null and v.deleted_at is null and i.deleted_at is null and v.item_id <> p_item
                    and (lower(v.sku) collate "C") >= lower(p_stem) || '-' and (lower(v.sku) collate "C") < lower(p_stem) || '.')
$fn$;

-- the work of assign_skus, with the first SKU it made (for assign_skus_for to show)
create or replace function sku_fill(p_tenant uuid, p_item uuid, out made integer, out first text)
language plpgsql set search_path = public as $fn$
declare
  v_name text;
  v_lines boolean;
  v_stem text; v_try text; v_k int := 1;
  v_base text; v_sku text; v_m int;
  r record;
begin
  made := 0;
  select name into v_name from items where tenant_id = p_tenant and id = p_item and deleted_at is null;
  if not found then raise exception 'unknown-item'; end if;
  v_lines := exists (select 1 from item_variants where tenant_id = p_tenant and item_id = p_item and deleted_at is null);
  if (v_lines and not exists (select 1 from item_variants where tenant_id = p_tenant and item_id = p_item and deleted_at is null and nullif(btrim(sku), '') is null))
     or (not v_lines and exists (select 1 from items where tenant_id = p_tenant and id = p_item and nullif(btrim(sku), '') is not null)) then
    return;
  end if;
  -- the tenant's own lock, the one catalog_code_guard takes: two at once make theirs in turn
  perform pg_advisory_xact_lock(hashtextextended(p_tenant::text, 0));

  v_stem := sku_stem(v_name);
  -- the stem its lines already start with (letters and digits only, so safe in a pattern), while it is still its own
  select substring(upper(v.sku) from '^(' || v_stem || '[0-9]*)-') into v_try
    from item_variants v
   where v.tenant_id = p_tenant and v.item_id = p_item and v.deleted_at is null and upper(v.sku) ~ ('^' || v_stem || '[0-9]*-')
   order by v.created_at, v.name, v.id limit 1;
  if v_try is null or sku_stem_taken(p_tenant, p_item, v_try) then
    v_try := v_stem;
    while sku_stem_taken(p_tenant, p_item, v_try) loop
      v_k := v_k + 1;
      v_try := v_stem || v_k;
    end loop;
  end if;

  if v_lines then
    for r in
      select v.id, v.name, v.option_values from item_variants v
       where v.tenant_id = p_tenant and v.item_id = p_item and v.deleted_at is null and nullif(btrim(v.sku), '') is null
       order by v.created_at, v.name, v.id
    loop
      v_base := v_try || '-' || coalesce((select string_agg(sku_part(u.x), '-' order by u.o) from unnest(r.option_values) with ordinality as u(x, o)),
                                         sku_part(r.name));
      v_sku := v_base;
      v_m := 1;
      while sku_taken(p_tenant, v_sku) loop
        v_m := v_m + 1;
        v_sku := v_base || '-' || v_m;
      end loop;
      update item_variants set sku = v_sku where tenant_id = p_tenant and id = r.id;
      made := made + 1;
      first := coalesce(first, v_sku);
    end loop;
  else
    v_sku := v_try;
    v_m := 1;
    while sku_taken(p_tenant, v_sku) loop
      v_m := v_m + 1;
      v_sku := v_try || '-' || v_m;
    end loop;
    update items set sku = v_sku where tenant_id = p_tenant and id = p_item;
    made := 1;
    first := v_sku;
  end if;
end $fn$;

create or replace function assign_skus(p_tenant uuid, p_item uuid) returns integer
language sql set search_path = public as $fn$
  select made from sku_fill(p_tenant, p_item)
$fn$;

create or replace function assign_skus_for(p_tenant uuid, p_items uuid[]) returns jsonb
language plpgsql set search_path = public as $fn$
declare
  v_made int := 0;
  v_like text;
  f record;
  r record;
begin
  for r in
    select i.id from items i
     where i.tenant_id = p_tenant and i.deleted_at is null and (p_items is null or i.id = any (p_items))
     order by i.created_at, lower(i.name), i.id
  loop
    select * into f from sku_fill(p_tenant, r.id);
    v_made := v_made + f.made;
    v_like := coalesce(v_like, f.first);
  end loop;
  return jsonb_build_object('made', v_made, 'like', v_like);
end $fn$;
