-- 0118: a client's tills' EBS MRA IDs saved in one go, all or nothing.
--
-- /admin's MRA part saves every till's ID at once. It called
-- platform.set_till_mra_id (0116) once per till, each call its own
-- transaction, clearing a changed till first so two tills could swap their
-- IDs. When a later one was refused (an ID another till keeps, or one with a
-- space), the clearing had already been saved: the till lost the ID the MRA
-- gave it, and the history said only "cleared".
--
-- platform.set_till_mra_ids takes the whole form, {till id: ID}, as one
-- statement: the changed tills are cleared, then given their new IDs, and one
-- refusal undoes all of it. Each changed till gets one history line, from its
-- old ID to its new one. Tills of another client and unchanged ones are left
-- alone. set_till_mra_id stays, for one till.

create or replace function platform.set_till_mra_ids(p_admin uuid, p_tenant uuid, p_ids jsonb) returns integer
language plpgsql set search_path = public as $fn$
declare
  r record;
  v_changes jsonb;
  v_n integer := 0;
begin
  perform platform.require_admin(p_admin);
  if p_ids is null or jsonb_typeof(p_ids) <> 'object' then raise exception 'bad-mra-id'; end if;
  perform set_config('app.tenant_id', p_tenant::text, true);
  perform 1 from pos_devices d
    where d.tenant_id = p_tenant and d.id::text in (select jsonb_object_keys(p_ids))
    order by d.id for update;
  select coalesce(jsonb_agg(jsonb_build_object('id', d.id, 'was', d.mra_ebs_id, 'want', w.want) order by d.id), '[]'::jsonb)
    into v_changes
    from (select e.key as id, nullif(btrim(e.value #>> '{}'), '') as want from jsonb_each(p_ids) e) w
    join pos_devices d on d.tenant_id = p_tenant and d.id::text = w.id
   where d.mra_ebs_id is distinct from w.want;
  for r in select x->>'id' as id, x->>'was' as was, x->>'want' as want from jsonb_array_elements(v_changes) x loop
    if r.want is not null and r.want !~ '^[A-Za-z0-9_-]{1,64}$' then raise exception 'bad-mra-id'; end if;
    update pos_devices set mra_ebs_id = null where tenant_id = p_tenant and id = r.id::uuid;
  end loop;
  for r in select x->>'id' as id, x->>'was' as was, x->>'want' as want from jsonb_array_elements(v_changes) x loop
    if r.want is not null then
      begin
        update pos_devices set mra_ebs_id = r.want where tenant_id = p_tenant and id = r.id::uuid;
      exception when unique_violation then
        raise exception 'mra-id-taken';
      end;
    end if;
    insert into platform.audit (admin_auth_user_id, action, tenant_id, detail)
      values (p_admin, 'till.mra_id', p_tenant, jsonb_build_object('till', r.id::uuid, 'from', r.was, 'to', r.want));
    v_n := v_n + 1;
  end loop;
  return v_n;
end $fn$;
