-- 0069_booking_table_store.sql — a booking sent by a till takes a table of
-- its own store only.
-- Source: push_booking_upsert is the live definition (0056, pg_get_functiondef)
-- with the two table look-ups changed. Earlier migrations untouched.
--
-- What changes:
--   - A table was looked up by restaurant alone, so a booking of one store
--     could be given a table of another store of the same restaurant. It is
--     now looked up within the booking's store. A table that is not the
--     store's is left off, the way a table the restaurant does not have
--     already was: the booking itself is kept (it was taken, on a till).
--   - When the op changes a booking that exists, the store that counts is the
--     booking's own, not the one the op names: an op naming another store
--     could otherwise put the booking on that store's table.
-- The back office's forms follow the same rule since web/lib/saves.ts.
-- Never edit after merge.

CREATE OR REPLACE FUNCTION public.push_booking_upsert(p_tenant uuid, p_emp uuid, p jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
declare v_id uuid; v_store uuid; v_at timestamptz; v_name text; v_size int; v_status text;
begin
  v_id := (p->>'id')::uuid;
  v_store := (p->>'store_id')::uuid;
  v_at := (p->>'booked_for')::timestamptz;
  v_name := btrim(coalesce(p->>'name', ''));
  v_size := (p->>'size')::int;
  v_status := coalesce(p->>'status', 'confirmed');
  if v_id is null or v_store is null or v_at is null or v_name = '' or length(v_name) > 120
     or v_size is null or v_size not between 1 and 99
     or v_status not in ('pending','confirmed','seated','noshow','cancelled') then
    raise exception 'bad-payload'; end if;
  if not exists (select 1 from stores where id = v_store and tenant_id = p_tenant) then raise exception 'bad-store'; end if;
  insert into bookings (id, tenant_id, store_id, booked_for, name, size, phone, area, table_id, tags, status, ticket_id, created_by)
    values (v_id, p_tenant, v_store, v_at, v_name, v_size,
      nullif(btrim(left(coalesce(p->>'phone', ''), 40)), ''), nullif(btrim(left(coalesce(p->>'area', ''), 80)), ''),
      (select tb.id from tables tb where tb.id = (p->>'table_id')::uuid and tb.tenant_id = p_tenant and tb.store_id = v_store),
      nullif(btrim(left(coalesce(p->>'tags', ''), 240)), ''), v_status,
      (select t.id from tickets t where t.id = (p->>'ticket_id')::uuid and t.tenant_id = p_tenant), p_emp)
    on conflict (id) do update set booked_for = excluded.booked_for, name = excluded.name, size = excluded.size,
      phone = excluded.phone, area = excluded.area,
      -- the table is one of the booking's own store, whatever store this op named
      table_id = (select tb.id from tables tb
                   where tb.id = (p->>'table_id')::uuid and tb.tenant_id = bookings.tenant_id and tb.store_id = bookings.store_id),
      tags = excluded.tags,
      status = excluded.status, ticket_id = coalesce(excluded.ticket_id, bookings.ticket_id), deleted_at = null
    where bookings.tenant_id = p_tenant;
  return jsonb_build_object('id', v_id);
end $function$;
