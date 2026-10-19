-- 0126: a booking changed on a tablet changes only what the tablet changed.
--
-- A tablet sent every field of its own copy of a booking on each tap (Seat,
-- Assign, Confirm, No-show), and booking.upsert wrote them all. Tablets fetch
-- every 15 minutes, and a change can wait out a Wi-Fi cut: the office changed
-- a booking to 8 guests and gave it table 7, a waiter on a tablet that had not
-- fetched tapped Seat, and the booking went back to 4 guests with no table
-- (the restaurant review of 2026-10-20).
--
-- The till now sends `partial: true` with the booking's id and store and only
-- the keys it changed; a key not sent changes nothing, as item.save already
-- works. Each key sent is checked as a whole booking's would be. A partial
-- change of a booking the server does not have is refused (bad-payload): it
-- cannot make one. A booking sent whole (a new one, or from a till built
-- before this) is written as before. Rebuilt from 0085_premium_gate.sql, the
-- last to write it; only the partial branch is new.

CREATE OR REPLACE FUNCTION public.push_booking_upsert(p_tenant uuid, p_emp uuid, p jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
declare v_id uuid; v_store uuid; v_at timestamptz; v_name text; v_size int; v_status text;
begin
  -- bookings are part of the premium tier
  if not has_premium(p_tenant) then raise exception 'not-premium'; end if;
  v_id := (p->>'id')::uuid;

  if coalesce((p->>'partial')::boolean, false) then
    if v_id is null then raise exception 'bad-payload'; end if;
    perform 1 from bookings where id = v_id and tenant_id = p_tenant for update;
    if not found then raise exception 'bad-payload'; end if;
    if p ? 'booked_for' then
      v_at := (p->>'booked_for')::timestamptz;
      if v_at is null then raise exception 'bad-payload'; end if;
    end if;
    if p ? 'name' then
      v_name := btrim(coalesce(p->>'name', ''));
      if v_name = '' or length(v_name) > 120 then raise exception 'bad-payload'; end if;
    end if;
    if p ? 'size' then
      v_size := (p->>'size')::int;
      if v_size is null or v_size not between 1 and 99 then raise exception 'bad-payload'; end if;
    end if;
    if p ? 'status' then
      v_status := p->>'status';
      if v_status is null or v_status not in ('pending','confirmed','seated','noshow','cancelled') then raise exception 'bad-payload'; end if;
    end if;
    update bookings set
        booked_for = case when p ? 'booked_for' then v_at else booked_for end,
        name = case when p ? 'name' then v_name else name end,
        size = case when p ? 'size' then v_size else size end,
        status = case when p ? 'status' then v_status else status end,
        phone = case when p ? 'phone' then nullif(btrim(left(coalesce(p->>'phone', ''), 40)), '') else phone end,
        area = case when p ? 'area' then nullif(btrim(left(coalesce(p->>'area', ''), 80)), '') else area end,
        tags = case when p ? 'tags' then nullif(btrim(left(coalesce(p->>'tags', ''), 240)), '') else tags end,
        -- the table is one of the booking's own store, whatever store this op named
        table_id = case when p ? 'table_id' then (select tb.id from tables tb
                     where tb.id = (p->>'table_id')::uuid and tb.tenant_id = bookings.tenant_id and tb.store_id = bookings.store_id)
                   else table_id end,
        ticket_id = case when p ? 'ticket_id' then coalesce((select t.id from tickets t where t.id = (p->>'ticket_id')::uuid and t.tenant_id = p_tenant), ticket_id)
                    else ticket_id end,
        deleted_at = null
      where id = v_id and tenant_id = p_tenant;
    return jsonb_build_object('id', v_id);
  end if;

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
