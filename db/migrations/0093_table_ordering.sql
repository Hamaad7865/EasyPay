-- 0093: ordering from the table by QR code, the server's part.
--
-- The owner asked for it on 2026-10-06 and again on 2026-10-10, and chose how:
-- a guest's phone reaches the restaurant's till through a small relay
-- (cloudflare/relay, order.easypaypos.com), Premium only. The design is
-- docs/superpowers/specs/2026-10-10-table-ordering-design.md. Menus and
-- orders never come here: the relay holds them. This database is asked one
-- question, once each time a till connects to the relay: whose till is this,
-- and may its tables order?
--
--   stores.guest_id     the store's public id, the address on its table
--                       cards: order.easypaypos.com/<guest_id>/<table id>.
--                       Sixteen letters and digits (a-z, 2-7), random, made
--                       when the store is. It is not a secret, a card on a
--                       table shows it, and it is for good: cards are printed
--                       with it, so it cannot be changed.
--   new_guest_id()      makes one.
--   guest_pass(store)   the answer the till service gives the relay
--                       (GET /guest/pass, hello.ts): the store's public id,
--                       and whether table ordering is on for it. On means
--                       Premium or a trial (has_premium, as for the kitchen
--                       screen and Bookings), a restaurant and not a shop, an
--                       account that is not suspended, and the switch in the
--                       back office's POS settings
--                       (pos_settings.data.tableOrdering, saved there like
--                       every other setting). Asked as the till's tenant, so a
--                       store of another business has no answer.
--
-- Nothing here touches sync_pull or sync_push. The switch reaches tills in
-- pos_settings as every setting does, and a pull hands stores over whole, so
-- the new column goes with them; a till that does not know it reads past it.

create extension if not exists pgcrypto;

-- Five bits of each of sixteen random bytes, as a letter or a digit: 80 bits.
create or replace function new_guest_id() returns text
language sql volatile set search_path = public as $fn$
  select string_agg(substr('abcdefghijklmnopqrstuvwxyz234567', 1 + (get_byte(b, i) & 31), 1), '' order by i)
    from (select gen_random_bytes(16) as b) r, generate_series(0, 15) as i
$fn$;

alter table stores add column if not exists guest_id text;
update stores set guest_id = new_guest_id() where guest_id is null;
alter table stores alter column guest_id set default new_guest_id();
alter table stores alter column guest_id set not null;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'stores_guest_id_shape') then
    alter table stores add constraint stores_guest_id_shape check (guest_id ~ '^[a-z2-7]{16}$');
  end if;
end $$;
create unique index if not exists stores_guest_id_key on stores (guest_id);

-- For good: table cards are printed with it.
create or replace function stores_guest_id_fixed() returns trigger
language plpgsql as $fn$
begin
  if new.guest_id is distinct from old.guest_id then
    raise exception 'A store''s public id is for good: its table cards are printed with it.';
  end if;
  return new;
end $fn$;

drop trigger if exists trg_guest_id_fixed on stores;
create trigger trg_guest_id_fixed before update of guest_id on stores
  for each row execute function stores_guest_id_fixed();

-- Whose till is it, and may its tables order? Null for a store that is not
-- this business's or was removed.
create or replace function guest_pass(p_store uuid) returns jsonb
language sql stable set search_path = public as $fn$
  select jsonb_build_object(
    'store', s.guest_id,
    'ordering',
      has_premium(s.tenant_id)
      and exists (select 1 from tenants t where t.id = s.tenant_id and t.status = 'active' and t.deleted_at is null)
      and coalesce((
        select p.data -> 'tableOrdering' = 'true'::jsonb and coalesce(p.data ->> 'businessType', '') <> 'retail'
          from pos_settings p where p.tenant_id = s.tenant_id and p.deleted_at is null
      ), false))
    from stores s
   where s.id = p_store and s.tenant_id = current_tenant_id() and s.deleted_at is null
$fn$;
