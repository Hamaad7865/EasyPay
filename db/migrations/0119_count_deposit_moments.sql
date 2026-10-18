-- 0119: a stock count sets a deposit against the tablet's own moment.
--
-- A count sets a line of stock to what was counted, plus what moved on it
-- after the line was counted (0075, 0092). A sale or a refund is dated by its
-- receipt's moment on the tablet; everything else by when its row was
-- written. A deposit (0113) moves stock too, 'deposit' when it is taken and
-- 'deposit_release' when what was not collected goes back, and those were
-- dated by when they were written. A deposit taken at 10:00, on the shelf no
-- more when the shelf was counted at 10:30 and sent at 11:00 (the tablet's
-- queue, a slow line) was read as gone after the count: it came off twice,
-- the shelf showing one less than was counted. A cancel sent late was the
-- other way round: what came back after the count was lost.
--
-- Now a deposit is dated by its own moment, as a sale is: when it was taken
-- (deposits.device_time) and when it was cancelled (deposits.cancelled_at).
-- Both are the tablet's clock, unless the server stamped them itself (the
-- server's own expiry past the date, a payload with no moment): then they are
-- the movement's own created_at, written in the same transaction, and the
-- movement is set against the server's clock, as before.
--
-- Source: both functions are their live definitions on dev on 2026-10-18
-- (db/scripts/dump-function.cjs; as 0075 and 0092 left them), with only the
-- deposit lines added. Never edit after merge.

-- the one clock (count_review, while a count is open)
CREATE OR REPLACE FUNCTION public.stock_moved_since(p_tenant uuid, p_store uuid, p_item uuid, p_variant uuid, p_since timestamp with time zone)
 RETURNS integer
 LANGUAGE sql
 STABLE
 SET search_path TO 'public'
AS $function$
  select coalesce(sum(m.qty), 0)::integer
    from stock_movements m
    left join receipts r on r.tenant_id = m.tenant_id and r.id = m.receipt_id
    left join deposits d on m.reason in ('deposit', 'deposit_release') and d.tenant_id = m.tenant_id and d.id = m.ref_id
   where m.tenant_id = p_tenant and m.store_id = p_store and m.item_id = p_item
     and m.variant_id is not distinct from p_variant and m.deleted_at is null
     and (case when m.reason in ('sale', 'refund') then coalesce(r.device_time, m.created_at)
               when m.reason = 'deposit' then coalesce(d.device_time, m.created_at)
               when m.reason = 'deposit_release' then coalesce(d.cancelled_at, m.created_at)
               else m.created_at end) > p_since
$function$;

-- the tablet's moment and the same moment by the server's clock (count_complete)
CREATE OR REPLACE FUNCTION public.stock_moved_since_at(p_tenant uuid, p_store uuid, p_item uuid, p_variant uuid, p_since timestamp with time zone, p_since_server timestamp with time zone)
 RETURNS integer
 LANGUAGE sql
 STABLE
 SET search_path TO 'public'
AS $function$
  select coalesce(sum(m.qty), 0)::integer
    from stock_movements m
    left join receipts r on r.tenant_id = m.tenant_id and r.id = m.receipt_id
    left join deposits d on m.reason in ('deposit', 'deposit_release') and d.tenant_id = m.tenant_id and d.id = m.ref_id
   where m.tenant_id = p_tenant and m.store_id = p_store and m.item_id = p_item
     and m.variant_id is not distinct from p_variant and m.deleted_at is null
     and (case when m.reason in ('sale', 'refund') and r.device_time is not null then r.device_time > p_since
               -- a deposit's moment is the tablet's unless the server stamped it with the movement (0119)
               when m.reason = 'deposit' and d.device_time <> m.created_at then d.device_time > p_since
               when m.reason = 'deposit_release' and d.cancelled_at <> m.created_at then d.cancelled_at > p_since
               else m.created_at > p_since_server end)
$function$;
