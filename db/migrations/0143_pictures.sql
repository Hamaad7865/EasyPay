-- 0143_pictures.sql — pictures of a shop's products and of their variants
-- (docs/superpowers/specs/2026-10-28-add-variant-and-pictures-design.md, part 2).
--
-- Until now a picture was the tablet's own (till 0.9.5, item_pictures in the till's database): another
-- till of the business, and the back office, had none of it. A picture is now kept here, as the small
-- JPEG the back office makes in the browser (640 pixels on its long side at most), and named by
-- items.picture_id and item_variants.picture_id. The tills pull those names with the rows (both tables
-- are pulled whole) and fetch each picture once, by its id, from the till API. A picture is never
-- changed: a new one gets a new id, so a picture fetched is kept for good. pictures itself is never
-- pulled.
--
-- Refused: 'bad-picture' (not a JPEG, over 400 KB, or larger than 2000 pixels a side); 'unknown-item';
-- 'unknown-variant'; 'unknown-picture' (none of this business's); 'unknown-value' (no line of the
-- product has that value of that option); 'bad-options' (an option the product does not have).

create table if not exists pictures (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants (id) on delete cascade,
  jpeg bytea not null,
  width integer not null,
  height integer not null,
  created_at timestamptz not null default now(),
  unique (tenant_id, id)
);
alter table pictures enable row level security;
alter table pictures force row level security;
drop policy if exists tenant_isolation on pictures;
create policy tenant_isolation on pictures
  using (tenant_id = current_tenant_id())
  with check (tenant_id = current_tenant_id());

alter table items add column if not exists picture_id uuid;
alter table item_variants add column if not exists picture_id uuid;

create or replace function picture_put(p_tenant uuid, p_jpeg bytea, p_width integer, p_height integer)
returns uuid
language plpgsql set search_path = public as $fn$
declare
  v_id uuid;
begin
  if p_jpeg is null or length(p_jpeg) < 4 or length(p_jpeg) > 400000 or substring(p_jpeg from 1 for 3) <> '\xffd8ff'::bytea
     or p_width is null or p_height is null or p_width not between 1 and 2000 or p_height not between 1 and 2000 then
    raise exception 'bad-picture';
  end if;
  insert into pictures (tenant_id, jpeg, width, height) values (p_tenant, p_jpeg, p_width, p_height) returning id into v_id;
  return v_id;
end $fn$;

-- null, or one of this business's pictures
create or replace function picture_check(p_tenant uuid, p_picture uuid)
returns void
language plpgsql set search_path = public as $fn$
begin
  if p_picture is not null and not exists (select 1 from pictures where tenant_id = p_tenant and id = p_picture) then
    raise exception 'unknown-picture';
  end if;
end $fn$;

-- a product's own picture; null takes it off
create or replace function item_picture_set(p_tenant uuid, p_item uuid, p_picture uuid)
returns void
language plpgsql set search_path = public as $fn$
begin
  if not exists (select 1 from items where tenant_id = p_tenant and id = p_item and deleted_at is null) then raise exception 'unknown-item'; end if;
  perform picture_check(p_tenant, p_picture);
  update items set picture_id = p_picture where tenant_id = p_tenant and id = p_item and picture_id is distinct from p_picture;
end $fn$;

-- one line's own picture; null takes it off
create or replace function variant_picture_set(p_tenant uuid, p_variant uuid, p_picture uuid)
returns void
language plpgsql set search_path = public as $fn$
begin
  if not exists (select 1 from item_variants where tenant_id = p_tenant and id = p_variant and deleted_at is null) then raise exception 'unknown-variant'; end if;
  perform picture_check(p_tenant, p_picture);
  update item_variants set picture_id = p_picture where tenant_id = p_tenant and id = p_variant and picture_id is distinct from p_picture;
end $fn$;

-- the picture of every line of a product whose option p_option has the value p_value (a colour),
-- case aside; null takes it off. Returns the number of lines.
create or replace function variant_pictures_set(p_tenant uuid, p_item uuid, p_option integer, p_value text, p_picture uuid)
returns integer
language plpgsql set search_path = public as $fn$
declare
  v_names text[];
  v_n int;
begin
  select option_names into v_names from items where tenant_id = p_tenant and id = p_item and deleted_at is null;
  if not found then raise exception 'unknown-item'; end if;
  if p_option is null or p_option < 1 or p_option > coalesce(array_length(v_names, 1), 0) then raise exception 'bad-options'; end if;
  perform picture_check(p_tenant, p_picture);
  if not exists (select 1 from item_variants where tenant_id = p_tenant and item_id = p_item and deleted_at is null
                   and lower(option_values[p_option]) = lower(p_value)) then
    raise exception 'unknown-value';
  end if;
  update item_variants set picture_id = p_picture
   where tenant_id = p_tenant and item_id = p_item and deleted_at is null and lower(option_values[p_option]) = lower(p_value)
     and picture_id is distinct from p_picture;
  select count(*) into v_n from item_variants
   where tenant_id = p_tenant and item_id = p_item and deleted_at is null and lower(option_values[p_option]) = lower(p_value);
  return v_n;
end $fn$;
