-- 0032_merge_paidline.sql — check paid lines before open status in merge,
-- so merging a paid ticket reports paid-line (not bad-ticket). Replaces the
-- 0028 definition; 0028 untouched. Never edit after merge.

create or replace function push_ticket_merge(p_tenant uuid, p_emp uuid, p jsonb)
returns jsonb language plpgsql set search_path = public as $fn$
declare v_into uuid; v_store uuid; fid jsonb; v_from uuid;
begin
  v_into := (p->>'into_ticket_id')::uuid;
  if v_into is null then raise exception 'bad-payload'; end if;
  select store_id into v_store from tickets where id = v_into and status = 'open';
  if not found then raise exception 'bad-ticket'; end if;
  for fid in select value from jsonb_array_elements(coalesce(p->'from_ticket_ids', '[]'::jsonb)) as value loop
    v_from := (fid->>0)::uuid;
    if v_from = v_into then raise exception 'bad-payload'; end if;
    if not exists (select 1 from tickets
        where id = v_from and tenant_id = p_tenant and store_id = v_store) then
      raise exception 'bad-ticket';
    end if;
    if exists (select 1 from ticket_lines
        where ticket_id = v_from and tenant_id = p_tenant and voided_at is null and paid) then
      raise exception 'paid-line';
    end if;
    if not exists (select 1 from tickets where id = v_from and status = 'open') then
      raise exception 'bad-ticket';
    end if;
    update ticket_lines set ticket_id = v_into
      where ticket_id = v_from and tenant_id = p_tenant and voided_at is null;
    update tickets set status = 'cancelled' where id = v_from;
  end loop;
  return jsonb_build_object('into_ticket_id', v_into);
end $fn$;
