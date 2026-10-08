-- 0080_barcode_settings.sql
-- A shop's own barcodes, as a setting it can see and change: the digits its
-- barcodes begin with, the number the next one takes, and whether a product
-- made with no barcode is given one by itself. Until now the prefix could
-- only be changed in the database (it is 200 unless someone did), and a
-- barcode was only made by hand, on the product's page or on Barcode labels.
--
--   barcode_counters.auto_assign    off unless the shop switches it on
--   barcode_settings(tenant)        what the settings page shows: the prefix,
--                                   the switch, the next barcode as it will
--                                   print, how many more there is room for,
--                                   and how many lines have no barcode yet
--   barcode_settings_save(...)      the prefix and the switch. Refuses a prefix
--                                   that is not 2 to 7 digits ('bad-prefix'),
--                                   and one so long that the numbers already
--                                   given out no longer fit behind it
--                                   ('prefix-too-long'). Barcodes already made
--                                   keep the digits they were made with.
--   barcodes_auto(tenant, item)     gives a product's lines their barcodes if
--                                   the switch is on (assign_barcodes, 0070),
--                                   and does nothing if it is off. The back
--                                   office calls it where a product or a
--                                   variant is made: a new product, variants
--                                   made from options, an imported file.

alter table barcode_counters add column if not exists auto_assign boolean not null default false;

create or replace function barcode_settings(p_tenant uuid) returns jsonb
language sql stable set search_path = public as $fn$
  select jsonb_build_object(
    'prefix', s.prefix,
    'auto', s.auto,
    'next_serial', s.next_serial,
    -- the next barcode as it will print; none when the numbers have outgrown the prefix
    'next', case when s.next_serial < s.room then ean13(s.prefix, s.next_serial) end,
    'left', greatest(s.room - s.next_serial, 0),
    'made', s.next_serial - 1,
    -- lines a till cannot scan: products with no variants and no barcode, and variants with none
    'without', (select count(*) from items i
                 where i.tenant_id = p_tenant and i.deleted_at is null and i.barcode is null
                   and not exists (select 1 from item_variants v where v.tenant_id = p_tenant and v.item_id = i.id and v.deleted_at is null))
             + (select count(*) from item_variants v join items i on i.tenant_id = v.tenant_id and i.id = v.item_id and i.deleted_at is null
                 where v.tenant_id = p_tenant and v.deleted_at is null and v.barcode is null))
    from (select coalesce(b.prefix, '200') as prefix, coalesce(b.auto_assign, false) as auto, coalesce(b.next_serial, 1) as next_serial,
                 power(10, 12 - length(coalesce(b.prefix, '200')))::bigint as room
            from (select 1) one left join barcode_counters b on b.tenant_id = p_tenant) s;
$fn$;

create or replace function barcode_settings_save(p_tenant uuid, p_prefix text, p_auto boolean) returns jsonb
language plpgsql set search_path = public as $fn$
declare
  v_prefix text := btrim(coalesce(p_prefix, ''));
  v_next bigint;
begin
  if v_prefix !~ '^[0-9]{2,7}$' then raise exception 'bad-prefix'; end if;
  insert into barcode_counters (tenant_id) values (p_tenant) on conflict (tenant_id) do nothing;
  -- held to the end: nobody is handed a number while the prefix changes
  select next_serial into v_next from barcode_counters where tenant_id = p_tenant for update;
  -- the numbers go on from where they are, so the next one has to fit behind the new prefix
  if v_next >= power(10, 12 - length(v_prefix))::bigint then raise exception 'prefix-too-long'; end if;
  update barcode_counters set prefix = v_prefix, auto_assign = coalesce(p_auto, false) where tenant_id = p_tenant;
  return barcode_settings(p_tenant);
end $fn$;

create or replace function barcodes_auto(p_tenant uuid, p_item uuid) returns integer
language plpgsql set search_path = public as $fn$
begin
  if not exists (select 1 from barcode_counters where tenant_id = p_tenant and auto_assign) then return 0; end if;
  return assign_barcodes(p_tenant, p_item);
end $fn$;
