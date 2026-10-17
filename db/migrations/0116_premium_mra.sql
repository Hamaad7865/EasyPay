-- 0116: Premium MRA, piece 1 (docs/superpowers/specs/2026-10-17-premium-mra-design.md).
--
-- Since 1 September 2026 a business turning over more than Rs 40 million a
-- year sends every sale to the MRA as it is made (its e-invoicing). Not every
-- client needs that. The owner: "we need to have a dedicated place for clients
-- with 40 million turnover because not all clients would need this", and "a
-- third plan, the premium MRA e invoicing which adheres to all MRA rules".
--
-- Premium MRA is the premium plan with the MRA switched on. A new plan name
-- would read as "not premium" on every till that has not updated, which would
-- hide the kitchen screen, bookings, deposits and accounts. So:
--   tenants.mra   off          not on MRA (every client before this)
--                 setting_up   moving to MRA: the details below are filled in
--                 training     the tills send training invoices (piece 3)
--                 live         every sale goes to the MRA (piece 3)
-- and on MRA only on the premium plan, both ways round.
--
-- What the MRA asks for, beside the BRN and VAT number tenants already has:
--   tenants.legal_name, tenants.tan   the seller's legal name and tax account number
--   tenants.mra_nature                goods or services: what the business sells
--   categories.mra_nature             the same for a category, when it differs
--   taxes.mra_code                    TC01 15%, TC02 0%, TC03 exempt, TC04 not
--                                     fiscal, TC05 15% to an exempt body, TC06 outside VAT
--   pos_devices.mra_ebs_id            the ID the MRA gave the till (one EBS per till)
--   tenants.mra_live_since            when it first went live (piece 3); never cleared
-- A branch's address is stores.address, there already.
--
-- Nothing here sends anything to the MRA. Its API guide is read in piece 2.

alter table tenants add column if not exists legal_name text;
alter table tenants add column if not exists tan text;
alter table tenants add column if not exists mra text not null default 'off';
alter table tenants add column if not exists mra_nature text;
alter table tenants add column if not exists mra_live_since timestamptz;
alter table tenants drop constraint if exists tenants_mra_check;
alter table tenants add constraint tenants_mra_check check (mra in ('off', 'setting_up', 'training', 'live'));
alter table tenants drop constraint if exists tenants_mra_nature_check;
alter table tenants add constraint tenants_mra_nature_check check (mra_nature in ('goods', 'services'));

alter table taxes add column if not exists mra_code text;
alter table taxes drop constraint if exists taxes_mra_code_check;
alter table taxes add constraint taxes_mra_code_check check (mra_code in ('TC01', 'TC02', 'TC03', 'TC04', 'TC05', 'TC06'));

alter table categories add column if not exists mra_nature text;
alter table categories drop constraint if exists categories_mra_nature_check;
alter table categories add constraint categories_mra_nature_check check (mra_nature in ('goods', 'services'));

alter table pos_devices add column if not exists mra_ebs_id text;
-- one till in use per ID: a till taken out of use keeps its ID in its record,
-- and its replacement can be given the same one
create unique index if not exists pos_devices_mra_ebs_id on pos_devices (tenant_id, mra_ebs_id)
  where mra_ebs_id is not null and deleted_at is null;

-- On MRA only on the premium plan: a client is not put on MRA on another plan,
-- and a client on MRA is not moved to another one (its MRA is turned off first).
create or replace function tenants_mra_needs_premium() returns trigger
language plpgsql as $fn$
begin
  if new.mra <> 'off' and lower(btrim(coalesce(new.plan, ''))) <> 'premium' then
    raise exception 'mra-needs-premium';
  end if;
  return new;
end $fn$;
drop trigger if exists trg_mra_needs_premium on tenants;
create trigger trg_mra_needs_premium before insert or update of plan, mra on tenants
  for each row execute function tenants_mra_needs_premium();

-- The payment type is part of what the MRA holds of a sale, so it is not
-- corrected afterwards on a live MRA client: the sale is refunded and made
-- again. Every correction comes through here (push_payment_correct), whoever
-- sends it.
create or replace function payment_corrections_mra() returns trigger
language plpgsql set search_path = public as $fn$
begin
  if exists (select 1 from tenants where id = new.tenant_id and mra = 'live') then
    raise exception 'mra-no-correction';
  end if;
  return new;
end $fn$;
drop trigger if exists trg_payment_corrections_mra on payment_corrections;
create trigger trg_payment_corrections_mra before insert on payment_corrections
  for each row execute function payment_corrections_mra();

-- What the move to MRA still lacks, line by line: [{key, ok, missing | count}].
-- Read under the caller's own rules (RLS): the back office asks it for its own
-- client; /admin through platform.mra_checklist.
create or replace function mra_checklist(p_tenant uuid) returns jsonb
language plpgsql stable set search_path = public as $fn$
declare
  t record;
  v_missing text[];
  v_n int;
  v_out jsonb := '[]'::jsonb;
begin
  select legal_name, tan, brn, mra_nature into t from tenants where id = p_tenant and deleted_at is null;
  if not found then raise exception 'unknown-tenant'; end if;
  v_missing := array_remove(array[
    case when nullif(btrim(coalesce(t.legal_name, '')), '') is null then 'legal name' end,
    case when nullif(btrim(coalesce(t.tan, '')), '') is null then 'TAN' end,
    case when nullif(btrim(coalesce(t.brn, '')), '') is null then 'BRN' end], null);
  v_out := v_out || jsonb_build_object('key', 'company', 'ok', cardinality(v_missing) = 0, 'missing', to_jsonb(v_missing));
  v_out := v_out || jsonb_build_object('key', 'nature', 'ok', t.mra_nature is not null);
  select coalesce(array_agg(name order by created_at), '{}') into v_missing
    from stores where tenant_id = p_tenant and deleted_at is null and nullif(btrim(coalesce(address, '')), '') is null;
  v_out := v_out || jsonb_build_object('key', 'addresses', 'ok', cardinality(v_missing) = 0, 'missing', to_jsonb(v_missing));
  select coalesce(array_agg(name order by name), '{}') into v_missing
    from taxes where tenant_id = p_tenant and deleted_at is null and mra_code is null;
  v_out := v_out || jsonb_build_object('key', 'taxes', 'ok', cardinality(v_missing) = 0, 'missing', to_jsonb(v_missing));
  -- a line goes to the MRA with its tax's code, so every item needs a tax
  select count(*) into v_n from items i
   where i.tenant_id = p_tenant and i.deleted_at is null
     and not exists (select 1 from item_taxes it where it.tenant_id = i.tenant_id and it.item_id = i.id and it.deleted_at is null);
  v_out := v_out || jsonb_build_object('key', 'items', 'ok', v_n = 0, 'count', v_n);
  select coalesce(array_agg(name order by created_at), '{}') into v_missing
    from pos_devices where tenant_id = p_tenant and deleted_at is null and mra_ebs_id is null;
  v_out := v_out || jsonb_build_object('key', 'tills', 'ok', cardinality(v_missing) = 0, 'missing', to_jsonb(v_missing));
  return v_out;
end $fn$;

create or replace function platform.mra_checklist(p_admin uuid, p_tenant uuid) returns jsonb
language plpgsql set search_path = public as $fn$
begin
  perform platform.require_admin(p_admin);
  perform set_config('app.tenant_id', p_tenant::text, true);
  return mra_checklist(p_tenant);
end $fn$;

-- /admin moves a client between off and setting_up. Training and live come
-- with the till (piece 3), which is what makes them mean anything.
create or replace function platform.set_tenant_mra(p_admin uuid, p_tenant uuid, p_state text) returns void
language plpgsql set search_path = public as $fn$
declare v_old text;
begin
  perform platform.require_admin(p_admin);
  if p_state is null or p_state not in ('off', 'setting_up') then raise exception 'bad-mra-state'; end if;
  select mra into v_old from tenants where id = p_tenant and deleted_at is null;
  if not found then raise exception 'unknown-tenant'; end if;
  if v_old = p_state then return; end if;
  perform set_config('app.tenant_id', p_tenant::text, true);
  update tenants set mra = p_state where id = p_tenant;
  -- the tills learn it through the settings they already pull, as the plan
  insert into pos_settings (tenant_id, data) values (p_tenant, jsonb_build_object('mra', p_state))
    on conflict (tenant_id) do update set data = pos_settings.data || excluded.data;
  insert into platform.audit (admin_auth_user_id, action, tenant_id, detail)
    values (p_admin, 'tenant.mra', p_tenant, jsonb_build_object('from', v_old, 'to', p_state));
end $fn$;

-- The ID the MRA gave a till when the client registered it with them. Empty
-- clears it.
create or replace function platform.set_till_mra_id(p_admin uuid, p_device uuid, p_id text) returns void
language plpgsql set search_path = public as $fn$
declare d record; v_id text := nullif(btrim(coalesce(p_id, '')), '');
begin
  perform platform.require_admin(p_admin);
  if v_id is not null and v_id !~ '^[A-Za-z0-9_-]{1,64}$' then raise exception 'bad-mra-id'; end if;
  select tenant_id, mra_ebs_id into d from pos_devices where id = p_device for update;
  if not found then raise exception 'unknown-till'; end if;
  if d.mra_ebs_id is not distinct from v_id then return; end if;
  perform set_config('app.tenant_id', d.tenant_id::text, true);
  begin
    update pos_devices set mra_ebs_id = v_id where id = p_device;
  exception when unique_violation then
    raise exception 'mra-id-taken';
  end;
  insert into platform.audit (admin_auth_user_id, action, tenant_id, detail)
    values (p_admin, 'till.mra_id', d.tenant_id, jsonb_build_object('till', p_device, 'from', d.mra_ebs_id, 'to', v_id));
end $fn$;
